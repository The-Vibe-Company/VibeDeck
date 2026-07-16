//! Native publication webviews owned by the Tauri main process.
//!
//! Security coverage with Tauri 2.11.5 / Wry 0.55.1:
//! - top-level navigation is fail-closed to credential-free HTTP(S);
//! - popups and downloads are denied by native public hooks;
//! - child labels never match the `main` capability;
//! - publication storage is separated from the local renderer (a dedicated
//!   WKWebsiteDataStore identifier on macOS 14+, a dedicated WebView2 data
//!   directory on Windows).
//!
//! The public builders do **not** expose generic permission or HTTP-auth
//! challenge handlers. Wry's macOS delegate also currently grants media
//! capture requests internally. Service-worker registrations cannot be
//! selectively stopped or cleared through Tauri's public child-webview API.
//! Those are explicit cutover gates, not guarantees made by this controller.

use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fmt,
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};
use tauri::{
    webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder},
    LogicalPosition, LogicalSize, Rect, Webview, WebviewUrl, Window, Wry,
};
use tokio_util::sync::CancellationToken;
use url::Url;

pub const MAX_WEB_PANELS: usize = 6;
pub const MAX_CONCURRENT_WEB_PANEL_LOADS: usize = 2;

const MAX_URL_LENGTH: usize = 4_096;
const MAX_PANEL_ID_LENGTH: usize = 128;
const MAX_COORDINATE: f64 = 10_000_000.0;
const CHILD_LABEL_PREFIX: &str = "web-panel-native-";
const WEB_PANEL_LOAD_TIMEOUT: Duration = Duration::from_secs(30);
const STOP_NAVIGATION_SCRIPT: &str = "window.stop()";
const GO_BACK_SCRIPT: &str = "window.history.back()";
const GO_FORWARD_SCRIPT: &str = "window.history.forward()";
#[cfg(target_os = "macos")]
const MACOS_PUBLICATION_DATA_STORE: [u8; 16] = [
    0x56, 0x69, 0x62, 0x65, 0x44, 0x65, 0x63, 0x6b, 0x57, 0x65, 0x62, 0x50, 0x61, 0x6e, 0x65, 0x6c,
];

/// Documents which protections are enforced by the public Tauri/Wry surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeWebPanelSecurityCoverage {
    pub navigation_fail_closed: bool,
    pub popups_blocked: bool,
    pub downloads_blocked: bool,
    pub publication_data_store_separated: bool,
    pub generic_permissions_blocked: bool,
    pub http_auth_challenges_blocked: bool,
    pub service_workers_stopped_on_destroy: bool,
}

pub const NATIVE_WEB_PANEL_SECURITY_COVERAGE: NativeWebPanelSecurityCoverage =
    NativeWebPanelSecurityCoverage {
        navigation_fail_closed: true,
        popups_blocked: true,
        downloads_blocked: true,
        publication_data_store_separated: true,
        generic_permissions_blocked: false,
        http_auth_challenges_blocked: false,
        service_workers_stopped_on_destroy: false,
    };

#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct WebPanelBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct WebPanelDescriptor {
    pub panel_id: String,
    pub url: String,
    pub bounds: WebPanelBounds,
    pub visible: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WebPanelPhase {
    Queued,
    Loading,
    Ready,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebPanelSnapshot {
    pub panel_id: String,
    pub generation: u64,
    pub sequence: u64,
    pub url: String,
    pub bounds: WebPanelBounds,
    pub phase: WebPanelPhase,
    pub requested_visible: bool,
    pub visible: bool,
}

/// Renderer-safe state for a native publication view. The navigated URL and
/// every Tauri/Wry handle deliberately stay owned by the main process.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebPanelViewState {
    pub panel_id: String,
    pub generation: u64,
    pub sequence: u64,
    pub bounds: WebPanelBounds,
    pub phase: WebPanelPhase,
    pub requested_visible: bool,
    pub visible: bool,
}

impl From<WebPanelSnapshot> for WebPanelViewState {
    fn from(snapshot: WebPanelSnapshot) -> Self {
        Self {
            panel_id: snapshot.panel_id,
            generation: snapshot.generation,
            sequence: snapshot.sequence,
            bounds: snapshot.bounds,
            phase: snapshot.phase,
            requested_visible: snapshot.requested_visible,
            visible: snapshot.visible,
        }
    }
}

pub(crate) type WebPanelStateSink = Arc<dyn Fn(WebPanelViewState) -> Result<(), ()> + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WebPanelError {
    InvalidParent,
    InvalidPanelId,
    InvalidUrl,
    InvalidBounds,
    TooManyPanels,
    DuplicatePanel,
    PanelAlreadyExists,
    PanelNotFound,
    StateChannelUnavailable,
    NativeOperation,
}

impl fmt::Display for WebPanelError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidParent => "la fenêtre parente du panel web doit être main",
            Self::InvalidPanelId => "identifiant de panel web invalide",
            Self::InvalidUrl => "URL de panel web invalide",
            Self::InvalidBounds => "dimensions de panel web invalides",
            Self::TooManyPanels => "six panels web au maximum sont autorisés",
            Self::DuplicatePanel => "un panel web est présent plusieurs fois",
            Self::PanelAlreadyExists => "ce panel web existe déjà",
            Self::PanelNotFound => "panel web introuvable",
            Self::StateChannelUnavailable => "le canal d’état des panels web est indisponible",
            Self::NativeOperation => "l'opération sur la vue web native a échoué",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for WebPanelError {}

#[derive(Debug, Clone)]
struct ValidatedDescriptor {
    panel_id: String,
    url: Url,
    bounds: WebPanelBounds,
    visible: bool,
}

#[derive(Debug, Clone)]
struct PanelRecord {
    descriptor: ValidatedDescriptor,
    current_url: Url,
    native_generation: u64,
    state_sequence: u64,
    phase: WebPanelPhase,
    native_label: Option<String>,
    load_deadline: Option<Instant>,
    awaiting_native_start: bool,
    pending_navigation_url: Option<Url>,
    native_navigation_id: Option<u64>,
}

impl PanelRecord {
    fn advance_state_sequence(&mut self) {
        self.state_sequence = self.state_sequence.saturating_add(1);
    }
}

#[derive(Debug, Clone)]
struct LoadRequest {
    panel_id: String,
    native_label: String,
    url: Url,
    deadline: Instant,
}

#[derive(Debug, Clone)]
struct NavigationTransition {
    panel_id: String,
    native_label: String,
    generation: u64,
    sequence: u64,
    previous_phase: WebPanelPhase,
    previous_deadline: Option<Instant>,
    previous_awaiting_native_start: bool,
    previous_pending_navigation_url: Option<Url>,
    previous_native_navigation_id: Option<u64>,
    deadline: Instant,
    snapshot: WebPanelSnapshot,
}

#[derive(Debug, Clone)]
struct RestoredNavigation {
    panel_id: String,
    native_label: String,
    deadline: Option<Instant>,
    snapshot: WebPanelSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PageLoadFinish {
    Applied(String),
    IgnoredAwaitingNativeStart,
    IgnoredUnexpectedNativeNavigation,
    IgnoredUnexpectedUrl,
    Stale,
}

#[derive(Debug, Clone)]
enum NativeNavigationRequest {
    AlreadyPending,
    Started(Box<NavigationTransition>),
    Stale,
}

#[derive(Debug, Clone)]
struct NativeState {
    bounds: WebPanelBounds,
    visible: bool,
}

#[derive(Debug, Default)]
struct LifecycleModel {
    records: HashMap<String, PanelRecord>,
    order: Vec<String>,
    queue: VecDeque<String>,
    active_labels: HashSet<String>,
    active_deadlines: HashMap<String, Instant>,
    overlay_active: bool,
    next_native_id: u64,
}

impl LifecycleModel {
    fn queued_record(&mut self, descriptor: ValidatedDescriptor) -> PanelRecord {
        self.next_native_id = self.next_native_id.wrapping_add(1).max(1);
        PanelRecord {
            current_url: descriptor.url.clone(),
            native_generation: self.next_native_id,
            state_sequence: 0,
            descriptor,
            phase: WebPanelPhase::Queued,
            native_label: None,
            load_deadline: None,
            awaiting_native_start: false,
            pending_navigation_url: None,
            native_navigation_id: None,
        }
    }

    fn reconcile(
        &mut self,
        descriptors: Vec<WebPanelDescriptor>,
        focused_panel_id: Option<&str>,
        viewport: Option<(f64, f64)>,
    ) -> Result<Vec<String>, WebPanelError> {
        let normalized = validate_descriptor_list(descriptors, viewport)?;
        let focused_panel_id = validate_optional_panel_id(focused_panel_id)?;
        let requested_order = normalized
            .iter()
            .map(|descriptor| descriptor.panel_id.clone())
            .collect::<Vec<_>>();
        let next_ids = normalized
            .iter()
            .map(|descriptor| descriptor.panel_id.clone())
            .collect::<HashSet<_>>();
        let mut labels_to_destroy = Vec::new();

        for panel_id in self.order.clone() {
            if next_ids.contains(&panel_id) {
                continue;
            }
            if let Some(record) = self.records.remove(&panel_id) {
                if let Some(label) = record.native_label {
                    labels_to_destroy.push(label);
                }
            }
        }
        self.queue.retain(|panel_id| next_ids.contains(panel_id));

        for descriptor in normalized {
            let panel_id = descriptor.panel_id.clone();
            match self.records.remove(&panel_id) {
                Some(mut record) if record.descriptor.url == descriptor.url => {
                    if record.descriptor.bounds != descriptor.bounds
                        || record.descriptor.visible != descriptor.visible
                    {
                        record.advance_state_sequence();
                    }
                    record.descriptor = descriptor;
                    self.records.insert(panel_id, record);
                }
                Some(record) => {
                    if let Some(label) = record.native_label {
                        labels_to_destroy.push(label);
                    }
                    self.queue.retain(|queued| queued != &panel_id);
                    let record = self.queued_record(descriptor);
                    self.records.insert(panel_id.clone(), record);
                    self.queue.push_back(panel_id);
                }
                None => {
                    let record = self.queued_record(descriptor);
                    self.records.insert(panel_id.clone(), record);
                    self.queue.push_back(panel_id);
                }
            }
        }

        self.order = requested_order;
        self.prioritize(focused_panel_id.as_deref());
        Ok(labels_to_destroy)
    }

    fn insert(
        &mut self,
        descriptor: WebPanelDescriptor,
        focused: bool,
        viewport: Option<(f64, f64)>,
    ) -> Result<(), WebPanelError> {
        if self.records.len() >= MAX_WEB_PANELS {
            return Err(WebPanelError::TooManyPanels);
        }
        let descriptor = validate_descriptor(descriptor, viewport)?;
        if self.records.contains_key(&descriptor.panel_id) {
            return Err(WebPanelError::PanelAlreadyExists);
        }
        let panel_id = descriptor.panel_id.clone();
        let record = self.queued_record(descriptor);
        self.records.insert(panel_id.clone(), record);
        self.order.push(panel_id.clone());
        if focused {
            self.queue.push_front(panel_id);
        } else {
            self.queue.push_back(panel_id);
        }
        Ok(())
    }

    fn prioritize(&mut self, panel_id: Option<&str>) {
        let Some(panel_id) = panel_id else {
            return;
        };
        let Some(index) = self.queue.iter().position(|queued| queued == panel_id) else {
            return;
        };
        if let Some(panel_id) = self.queue.remove(index) {
            self.queue.push_front(panel_id);
        }
    }

    #[cfg(test)]
    fn take_loads(&mut self) -> Vec<LoadRequest> {
        self.take_loads_up_to_at(MAX_WEB_PANELS, Instant::now())
    }

    fn take_loads_up_to(&mut self, maximum_new_loads: usize) -> Vec<LoadRequest> {
        self.take_loads_up_to_at(maximum_new_loads, Instant::now())
    }

    fn take_loads_up_to_at(&mut self, maximum_new_loads: usize, now: Instant) -> Vec<LoadRequest> {
        let mut requests = Vec::new();
        while requests.len() < maximum_new_loads
            && self.active_labels.len() < MAX_CONCURRENT_WEB_PANEL_LOADS
        {
            let Some(panel_id) = self.queue.pop_front() else {
                break;
            };
            let Some(record) = self.records.get_mut(&panel_id) else {
                continue;
            };
            if record.phase != WebPanelPhase::Queued {
                continue;
            }

            let native_label = format!("{CHILD_LABEL_PREFIX}{}", record.native_generation);
            let deadline = now + WEB_PANEL_LOAD_TIMEOUT;
            record.phase = WebPanelPhase::Loading;
            record.advance_state_sequence();
            record.native_label = Some(native_label.clone());
            record.load_deadline = Some(deadline);
            // A native Finished event is not authoritative until the matching
            // navigation emitted Started. This also keeps failed initial
            // loads from being promoted to Ready by WebView2's unconditional
            // NavigationCompleted bridge.
            record.awaiting_native_start = true;
            record.pending_navigation_url = Some(record.descriptor.url.clone());
            record.native_navigation_id = None;
            self.active_labels.insert(native_label.clone());
            self.active_deadlines.insert(native_label.clone(), deadline);
            requests.push(LoadRequest {
                panel_id,
                native_label,
                url: record.descriptor.url.clone(),
                deadline,
            });
        }
        requests
    }

    fn finish(&mut self, native_label: &str, success: bool) -> bool {
        self.active_labels.remove(native_label);
        self.active_deadlines.remove(native_label);
        let Some(record) = self
            .records
            .values_mut()
            .find(|record| record.native_label.as_deref() == Some(native_label))
        else {
            return false;
        };
        record.phase = if success {
            WebPanelPhase::Ready
        } else {
            record.native_label = None;
            WebPanelPhase::Failed
        };
        record.advance_state_sequence();
        record.load_deadline = None;
        record.awaiting_native_start = false;
        record.pending_navigation_url = None;
        record.native_navigation_id = None;
        true
    }

    fn finish_page_load(&mut self, native_label: &str, completed_url: &Url) -> PageLoadFinish {
        self.finish_page_load_for_native_navigation(native_label, completed_url, None)
    }

    fn finish_page_load_for_native_navigation(
        &mut self,
        native_label: &str,
        completed_url: &Url,
        native_navigation_id: Option<u64>,
    ) -> PageLoadFinish {
        let Some((panel_id, awaiting_native_start, expected_url)) =
            self.records.iter().find_map(|(panel_id, record)| {
                (record.native_label.as_deref() == Some(native_label)).then(|| {
                    (
                        panel_id.clone(),
                        record.awaiting_native_start,
                        record.pending_navigation_url.clone(),
                    )
                })
            })
        else {
            self.release_active_label(native_label);
            return PageLoadFinish::Stale;
        };
        if awaiting_native_start {
            return PageLoadFinish::IgnoredAwaitingNativeStart;
        }
        if native_navigation_id.is_some()
            && self
                .records
                .get(&panel_id)
                .and_then(|record| record.native_navigation_id)
                != native_navigation_id
        {
            return PageLoadFinish::IgnoredUnexpectedNativeNavigation;
        }
        if expected_url.as_ref() != Some(completed_url) {
            return PageLoadFinish::IgnoredUnexpectedUrl;
        }
        if self.finish(native_label, true) {
            PageLoadFinish::Applied(panel_id)
        } else {
            PageLoadFinish::Stale
        }
    }

    fn retry_failed(&mut self, panel_id: &str) -> Result<bool, WebPanelError> {
        let failed = self
            .records
            .get(panel_id)
            .ok_or(WebPanelError::PanelNotFound)?
            .phase
            == WebPanelPhase::Failed;
        if !failed {
            return Ok(false);
        }
        self.next_native_id = self.next_native_id.wrapping_add(1).max(1);
        let record = self
            .records
            .get_mut(panel_id)
            .ok_or(WebPanelError::PanelNotFound)?;
        record.native_generation = self.next_native_id;
        record.state_sequence = 0;
        record.phase = WebPanelPhase::Queued;
        record.native_label = None;
        record.load_deadline = None;
        record.awaiting_native_start = false;
        record.pending_navigation_url = None;
        record.native_navigation_id = None;
        self.queue.retain(|queued| queued != panel_id);
        self.queue.push_front(panel_id.to_string());
        Ok(true)
    }

    fn begin_navigation(&mut self, panel_id: &str) -> Option<NavigationTransition> {
        self.begin_navigation_at(panel_id, Instant::now())
    }

    fn begin_navigation_at(
        &mut self,
        panel_id: &str,
        now: Instant,
    ) -> Option<NavigationTransition> {
        self.begin_navigation_transition_at(panel_id, now, true)
    }

    fn begin_navigation_transition_at(
        &mut self,
        panel_id: &str,
        now: Instant,
        awaiting_native_start: bool,
    ) -> Option<NavigationTransition> {
        let deadline = now + WEB_PANEL_LOAD_TIMEOUT;
        let (
            native_label,
            generation,
            sequence,
            previous_phase,
            previous_deadline,
            previous_awaiting_native_start,
            previous_pending_navigation_url,
            previous_native_navigation_id,
        ) = {
            let record = self.records.get_mut(panel_id)?;
            let native_label = record.native_label.clone()?;
            let previous_phase = record.phase;
            let previous_deadline = record.load_deadline;
            let previous_awaiting_native_start = record.awaiting_native_start;
            let previous_pending_navigation_url = record.pending_navigation_url.clone();
            let previous_native_navigation_id = record.native_navigation_id;
            record.phase = WebPanelPhase::Loading;
            record.advance_state_sequence();
            record.load_deadline = Some(deadline);
            record.awaiting_native_start = awaiting_native_start;
            record.pending_navigation_url = None;
            record.native_navigation_id = None;
            (
                native_label,
                record.native_generation,
                record.state_sequence,
                previous_phase,
                previous_deadline,
                previous_awaiting_native_start,
                previous_pending_navigation_url,
                previous_native_navigation_id,
            )
        };
        if self.active_labels.contains(&native_label) {
            self.active_deadlines.insert(native_label.clone(), deadline);
        }
        Some(NavigationTransition {
            panel_id: panel_id.to_string(),
            native_label,
            generation,
            sequence,
            previous_phase,
            previous_deadline,
            previous_awaiting_native_start,
            previous_pending_navigation_url,
            previous_native_navigation_id,
            deadline,
            snapshot: self.snapshot(panel_id)?,
        })
    }

    fn restore_navigation(
        &mut self,
        transition: &NavigationTransition,
    ) -> Option<RestoredNavigation> {
        let native_label = {
            let record = self.records.get_mut(&transition.panel_id)?;
            if record.native_generation != transition.generation
                || record.state_sequence != transition.sequence
                || record.phase != WebPanelPhase::Loading
                || record.load_deadline != Some(transition.deadline)
            {
                return None;
            }
            let native_label = record.native_label.clone()?;
            record.phase = transition.previous_phase;
            record.load_deadline = transition.previous_deadline;
            record.awaiting_native_start = transition.previous_awaiting_native_start;
            record.pending_navigation_url = transition.previous_pending_navigation_url.clone();
            record.native_navigation_id = transition.previous_native_navigation_id;
            record.advance_state_sequence();
            native_label
        };
        if self.active_labels.contains(&native_label) {
            if let Some(deadline) = transition.previous_deadline {
                self.active_deadlines.insert(native_label.clone(), deadline);
            } else {
                self.active_deadlines.remove(&native_label);
            }
        } else {
            self.active_deadlines.remove(&native_label);
        }
        Some(RestoredNavigation {
            panel_id: transition.panel_id.clone(),
            native_label,
            deadline: transition.previous_deadline,
            snapshot: self.snapshot(&transition.panel_id)?,
        })
    }

    fn mark_navigation_ready(&mut self, panel_id: &str) -> Option<(String, WebPanelSnapshot)> {
        let native_label = self.records.get(panel_id)?.native_label.clone()?;
        if !self.finish(&native_label, true) {
            return None;
        }
        Some((native_label, self.snapshot(panel_id)?))
    }

    fn mark_navigation_loading_for_label(
        &mut self,
        native_label: &str,
        url: &Url,
    ) -> Option<NavigationTransition> {
        let (panel_id, native_navigation_id) =
            self.records.iter().find_map(|(panel_id, record)| {
                (record.native_label.as_deref() == Some(native_label)
                    && record.awaiting_native_start)
                    .then(|| {
                        (
                            panel_id.clone(),
                            (record.pending_navigation_url.as_ref() == Some(url))
                                .then_some(record.native_navigation_id)
                                .flatten(),
                        )
                    })
            })?;
        let transition = self.begin_navigation_transition_at(&panel_id, Instant::now(), false)?;
        let record = self.records.get_mut(&panel_id)?;
        record.pending_navigation_url = Some(url.clone());
        record.native_navigation_id = native_navigation_id;
        Some(transition)
    }

    #[cfg(any(target_os = "windows", test))]
    fn record_native_navigation_id(
        &mut self,
        native_label: &str,
        url: &Url,
        navigation_id: u64,
    ) -> bool {
        let Some(record) = self.records.values_mut().find(|record| {
            record.phase == WebPanelPhase::Loading
                && record.native_label.as_deref() == Some(native_label)
                && record.pending_navigation_url.as_ref() == Some(url)
        }) else {
            return false;
        };
        record.native_navigation_id = Some(navigation_id);
        true
    }

    #[cfg(test)]
    fn owns_native_navigation_id(&self, native_label: &str, navigation_id: u64) -> bool {
        self.records.values().any(|record| {
            record.phase == WebPanelPhase::Loading
                && record.native_label.as_deref() == Some(native_label)
                && record.native_navigation_id == Some(navigation_id)
        })
    }

    fn request_navigation_for_label(
        &mut self,
        native_label: &str,
        url: &Url,
    ) -> NativeNavigationRequest {
        let Some(panel_id) = self.records.iter().find_map(|(panel_id, record)| {
            (record.native_label.as_deref() == Some(native_label)).then(|| panel_id.clone())
        }) else {
            return NativeNavigationRequest::Stale;
        };
        if self.records.get(&panel_id).is_some_and(|record| {
            record.phase == WebPanelPhase::Loading && record.awaiting_native_start
        }) {
            if let Some(record) = self.records.get_mut(&panel_id) {
                record.pending_navigation_url = Some(url.clone());
                record.native_navigation_id = None;
            }
            return NativeNavigationRequest::AlreadyPending;
        }
        let Some(transition) = self.begin_navigation_transition_at(&panel_id, Instant::now(), true)
        else {
            return NativeNavigationRequest::Stale;
        };
        if let Some(record) = self.records.get_mut(&panel_id) {
            record.pending_navigation_url = Some(url.clone());
        }
        NativeNavigationRequest::Started(Box::new(transition))
    }

    fn set_current_url(&mut self, panel_id: &str, url: Url) -> bool {
        let Some(record) = self.records.get_mut(panel_id) else {
            return false;
        };
        record.current_url = url;
        true
    }

    fn set_current_url_for_label(&mut self, native_label: &str, url: Url) -> bool {
        let Some(record) = self
            .records
            .values_mut()
            .find(|record| record.native_label.as_deref() == Some(native_label))
        else {
            return false;
        };
        record.current_url = url;
        true
    }

    fn expire_load(&mut self, native_label: &str, now: Instant) -> bool {
        let active_due = self
            .active_deadlines
            .get(native_label)
            .is_some_and(|deadline| *deadline <= now);
        let record_due = self.records.values().any(|record| {
            record.phase == WebPanelPhase::Loading
                && record.native_label.as_deref() == Some(native_label)
                && record.load_deadline.is_some_and(|deadline| deadline <= now)
        });
        let due = active_due || record_due;
        if !due {
            return false;
        }
        self.active_labels.remove(native_label);
        self.active_deadlines.remove(native_label);

        let Some(record) = self.records.values_mut().find(|record| {
            record.phase == WebPanelPhase::Loading
                && record.native_label.as_deref() == Some(native_label)
        }) else {
            // Reconcile/destroy may have removed the record while its native
            // build was still in flight. The deadline still releases that
            // reserved slot so unrelated panels cannot remain blocked.
            return true;
        };

        record.phase = WebPanelPhase::Failed;
        record.advance_state_sequence();
        record.native_label = None;
        record.load_deadline = None;
        record.awaiting_native_start = false;
        record.pending_navigation_url = None;
        record.native_navigation_id = None;
        true
    }

    fn release_active_label(&mut self, native_label: &str) {
        self.active_labels.remove(native_label);
        self.active_deadlines.remove(native_label);
    }

    fn set_visible(&mut self, panel_id: &str, visible: bool) -> Result<(), WebPanelError> {
        let record = self
            .records
            .get_mut(panel_id)
            .ok_or(WebPanelError::PanelNotFound)?;
        if record.descriptor.visible != visible {
            record.descriptor.visible = visible;
            record.advance_state_sequence();
        }
        Ok(())
    }

    fn set_bounds(
        &mut self,
        panel_id: &str,
        bounds: WebPanelBounds,
        viewport: Option<(f64, f64)>,
    ) -> Result<(), WebPanelError> {
        let bounds = validate_bounds(bounds, viewport)?;
        let record = self
            .records
            .get_mut(panel_id)
            .ok_or(WebPanelError::PanelNotFound)?;
        if record.descriptor.bounds != bounds {
            record.descriptor.bounds = bounds;
            record.advance_state_sequence();
        }
        Ok(())
    }

    fn destroy(&mut self, panel_id: &str) -> Result<Option<String>, WebPanelError> {
        validate_panel_id(panel_id)?;
        let record = self
            .records
            .remove(panel_id)
            .ok_or(WebPanelError::PanelNotFound)?;
        self.order.retain(|existing| existing != panel_id);
        self.queue.retain(|queued| queued != panel_id);
        Ok(record.native_label)
    }

    fn clear(&mut self) -> Vec<String> {
        let labels = self
            .records
            .values()
            .filter_map(|record| record.native_label.clone())
            .collect();
        self.records.clear();
        self.order.clear();
        self.queue.clear();
        self.active_labels.clear();
        self.active_deadlines.clear();
        labels
    }

    fn set_overlay_active(&mut self, active: bool) {
        if self.overlay_active == active {
            return;
        }
        self.overlay_active = active;
        for record in self.records.values_mut() {
            record.advance_state_sequence();
        }
    }

    fn native_state_for_label(&self, native_label: &str) -> Option<NativeState> {
        self.records.values().find_map(|record| {
            (record.native_label.as_deref() == Some(native_label)).then(|| NativeState {
                bounds: record.descriptor.bounds,
                visible: self.effective_visibility(record),
            })
        })
    }

    fn native_state_for_panel(&self, panel_id: &str) -> Option<(String, NativeState)> {
        let record = self.records.get(panel_id)?;
        Some((
            record.native_label.clone()?,
            NativeState {
                bounds: record.descriptor.bounds,
                visible: self.effective_visibility(record),
            },
        ))
    }

    fn owns_native_label(&self, panel_id: &str, native_label: &str) -> bool {
        self.records.get(panel_id).is_some_and(|record| {
            record.native_label.as_deref() == Some(native_label)
                && record.phase == WebPanelPhase::Loading
        })
    }

    fn effective_visibility(&self, record: &PanelRecord) -> bool {
        !self.overlay_active
            && record.descriptor.visible
            && record.descriptor.bounds.width > 0.0
            && record.descriptor.bounds.height > 0.0
            && record.phase != WebPanelPhase::Failed
    }

    fn snapshot(&self, panel_id: &str) -> Option<WebPanelSnapshot> {
        let record = self.records.get(panel_id)?;
        Some(WebPanelSnapshot {
            panel_id: record.descriptor.panel_id.clone(),
            generation: record.native_generation,
            sequence: record.state_sequence,
            url: record.current_url.to_string(),
            bounds: record.descriptor.bounds,
            phase: record.phase,
            requested_visible: record.descriptor.visible,
            visible: self.effective_visibility(record),
        })
    }

    fn snapshots(&self) -> Vec<WebPanelSnapshot> {
        self.order
            .iter()
            .filter_map(|panel_id| self.snapshot(panel_id))
            .collect()
    }
}

#[derive(Default)]
struct ControllerInner {
    model: LifecycleModel,
    parent_window: Option<Window<Wry>>,
    views: HashMap<String, Webview<Wry>>,
    load_timeouts: HashMap<String, CancellationToken>,
}

impl ControllerInner {
    fn mark_navigation_ready_and_take_timeout(
        &mut self,
        panel_id: &str,
    ) -> Option<(WebPanelSnapshot, Option<CancellationToken>)> {
        let (native_label, snapshot) = self.model.mark_navigation_ready(panel_id)?;
        let timeout = self.load_timeouts.remove(&native_label);
        Some((snapshot, timeout))
    }

    fn restore_navigation_and_take_timeout(
        &mut self,
        transition: &NavigationTransition,
    ) -> Option<(RestoredNavigation, Option<CancellationToken>)> {
        let restored = self.model.restore_navigation(transition)?;
        let timeout = self.load_timeouts.remove(&restored.native_label);
        Some((restored, timeout))
    }
}

/// Main-process owner for native publication views.
#[derive(Clone)]
pub struct WebPanelController {
    inner: Arc<Mutex<ControllerInner>>,
    native_operations: Arc<Mutex<()>>,
    state_sink: Arc<Mutex<Option<WebPanelStateSink>>>,
    // Serializes sink replacement with every publication. This makes the
    // initial snapshot and subsequent async lifecycle transitions one ordered
    // stream without ever taking `state_sink` while `inner` is locked.
    state_publish_order: Arc<Mutex<()>>,
    #[cfg(not(target_os = "macos"))]
    publication_data_directory: PathBuf,
}

impl WebPanelController {
    pub fn new(publication_data_directory: PathBuf) -> Self {
        #[cfg(target_os = "macos")]
        let _ = publication_data_directory;
        Self {
            inner: Arc::new(Mutex::new(ControllerInner::default())),
            native_operations: Arc::new(Mutex::new(())),
            state_sink: Arc::new(Mutex::new(None)),
            state_publish_order: Arc::new(Mutex::new(())),
            #[cfg(not(target_os = "macos"))]
            publication_data_directory,
        }
    }

    pub fn sync(
        &self,
        parent_window: &Window<Wry>,
        descriptors: Vec<WebPanelDescriptor>,
        focused_panel_id: Option<&str>,
    ) -> Result<Vec<WebPanelSnapshot>, WebPanelError> {
        let _native_operation = self.lock_native_operations();
        ensure_main_parent(parent_window)?;
        let viewport = window_viewport(parent_window);
        let (labels_to_destroy, views_to_close) = {
            let mut inner = self.lock_inner();
            inner.parent_window = Some(parent_window.clone());
            let labels = inner
                .model
                .reconcile(descriptors, focused_panel_id, viewport)?;
            let views = labels
                .iter()
                .filter_map(|label| inner.views.remove(label).map(|view| (label.clone(), view)))
                .collect::<Vec<_>>();
            (labels, views)
        };

        let close_result = self.close_views_and_release(labels_to_destroy, views_to_close);
        let apply_result = self.apply_all_native_states();
        self.pump();
        close_result?;
        apply_result?;
        Ok(self.snapshots())
    }

    pub(crate) fn replace_state_sink(&self, sink: WebPanelStateSink) -> Result<(), WebPanelError> {
        let _publish_order = self
            .state_publish_order
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // Snapshot before touching the sink lock. Every other publisher takes
        // `state_publish_order` first, so no transition can slip between this
        // snapshot and its delivery and no inner -> sink / sink -> inner ABBA
        // lock order exists.
        let snapshots = self.snapshots();
        {
            let mut current = self
                .state_sink
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            *current = Some(Arc::clone(&sink));
        }
        for snapshot in snapshots {
            if sink(snapshot.into()).is_err() {
                let mut current = self
                    .state_sink
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if current
                    .as_ref()
                    .is_some_and(|candidate| Arc::ptr_eq(candidate, &sink))
                {
                    *current = None;
                }
                return Err(WebPanelError::StateChannelUnavailable);
            }
        }
        Ok(())
    }

    pub fn create(
        &self,
        parent_window: &Window<Wry>,
        descriptor: WebPanelDescriptor,
        focused: bool,
    ) -> Result<WebPanelSnapshot, WebPanelError> {
        let _native_operation = self.lock_native_operations();
        ensure_main_parent(parent_window)?;
        let panel_id = descriptor.panel_id.clone();
        let viewport = window_viewport(parent_window);
        {
            let mut inner = self.lock_inner();
            inner.parent_window = Some(parent_window.clone());
            inner.model.insert(descriptor, focused, viewport)?;
        }
        self.pump();
        self.snapshot(&panel_id).ok_or(WebPanelError::PanelNotFound)
    }

    pub fn show(&self, panel_id: &str) -> Result<WebPanelSnapshot, WebPanelError> {
        self.set_visible(panel_id, true)
    }

    pub fn hide(&self, panel_id: &str) -> Result<WebPanelSnapshot, WebPanelError> {
        self.set_visible(panel_id, false)
    }

    pub fn set_bounds(
        &self,
        panel_id: &str,
        bounds: WebPanelBounds,
    ) -> Result<WebPanelSnapshot, WebPanelError> {
        let _native_operation = self.lock_native_operations();
        validate_panel_id(panel_id)?;
        let native = {
            let mut inner = self.lock_inner();
            let viewport = inner.parent_window.as_ref().and_then(window_viewport);
            inner.model.set_bounds(panel_id, bounds, viewport)?;
            native_update_for_panel(&inner, panel_id)
        };
        if let Some((label, view, state)) = native {
            self.apply_or_retire_native_state(label, view, state)?;
        }
        let snapshot = self
            .snapshot(panel_id)
            .ok_or(WebPanelError::PanelNotFound)?;
        self.publish_state(snapshot.clone());
        Ok(snapshot)
    }

    pub fn focus(&self, panel_id: &str) -> Result<bool, WebPanelError> {
        let _native_operation = self.lock_native_operations();
        validate_panel_id(panel_id)?;
        let view = {
            let mut inner = self.lock_inner();
            if !inner.model.records.contains_key(panel_id) {
                return Err(WebPanelError::PanelNotFound);
            }
            inner.model.prioritize(Some(panel_id));
            inner
                .model
                .native_state_for_panel(panel_id)
                .filter(|(_, state)| state.visible)
                .and_then(|(label, _)| inner.views.get(&label).cloned())
        };
        self.pump();
        if let Some(view) = view {
            view.set_focus()
                .map_err(|_| WebPanelError::NativeOperation)?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Navigates an already-created publication view. The renderer never
    /// receives the native handle and cannot bypass the same credential-free
    /// HTTP(S) validation used for initial child creation.
    pub fn navigate(&self, panel_id: &str, url: &str) -> Result<(), WebPanelError> {
        let _native_operation = self.lock_native_operations();
        validate_panel_id(panel_id)?;
        let url = parse_allowed_url(url)?;
        let view = self.view_for_panel(panel_id)?;
        let loading = self
            .lock_inner()
            .model
            .begin_navigation(panel_id)
            .ok_or(WebPanelError::NativeOperation)?;
        let previous_url = self
            .snapshot(panel_id)
            .and_then(|snapshot| Url::parse(&snapshot.url).ok())
            .ok_or(WebPanelError::NativeOperation)?;
        self.lock_inner()
            .model
            .set_current_url(panel_id, url.clone());
        if !self.arm_navigation_timeout(&loading) {
            self.lock_inner()
                .model
                .set_current_url(panel_id, previous_url.clone());
            if let Some(snapshot) = self.rollback_navigation(&loading) {
                self.publish_state(snapshot);
            }
            return Err(WebPanelError::NativeOperation);
        }
        self.publish_state(loading.snapshot.clone());
        if view.navigate(url).is_err() {
            self.lock_inner()
                .model
                .set_current_url(panel_id, previous_url.clone());
            let rollback = self.rollback_navigation(&loading);
            if let Some(snapshot) = rollback {
                self.publish_state(snapshot);
            }
            return Err(WebPanelError::NativeOperation);
        }
        Ok(())
    }

    pub fn reload(&self, panel_id: &str) -> Result<(), WebPanelError> {
        let retried = {
            let _native_operation = self.lock_native_operations();
            validate_panel_id(panel_id)?;
            let retried = self.lock_inner().model.retry_failed(panel_id)?;
            if !retried {
                let view = self.view_for_panel(panel_id)?;
                let loading = self
                    .lock_inner()
                    .model
                    .begin_navigation(panel_id)
                    .ok_or(WebPanelError::NativeOperation)?;
                if !self.arm_navigation_timeout(&loading) {
                    if let Some(snapshot) = self.rollback_navigation(&loading) {
                        self.publish_state(snapshot);
                    }
                    return Err(WebPanelError::NativeOperation);
                }
                self.publish_state(loading.snapshot.clone());
                if view.reload().is_err() {
                    let rollback = self.rollback_navigation(&loading);
                    if let Some(snapshot) = rollback {
                        self.publish_state(snapshot);
                    }
                    return Err(WebPanelError::NativeOperation);
                }
            }
            retried
        };
        if retried {
            if let Some(snapshot) = self.snapshot(panel_id) {
                self.publish_state(snapshot);
            }
            self.pump();
        }
        Ok(())
    }

    pub fn stop(&self, panel_id: &str) -> Result<(), WebPanelError> {
        let _native_operation = self.lock_native_operations();
        self.evaluate_fixed_script_locked(panel_id, STOP_NAVIGATION_SCRIPT)?;
        let ready = {
            let mut inner = self.lock_inner();
            inner.mark_navigation_ready_and_take_timeout(panel_id)
        };
        if let Some((snapshot, timeout)) = ready {
            if let Some(timeout) = timeout {
                timeout.cancel();
            }
            self.publish_state(snapshot);
        }
        Ok(())
    }

    pub fn go_back(&self, panel_id: &str) -> Result<(), WebPanelError> {
        self.evaluate_fixed_script(panel_id, GO_BACK_SCRIPT)
    }

    pub fn go_forward(&self, panel_id: &str) -> Result<(), WebPanelError> {
        self.evaluate_fixed_script(panel_id, GO_FORWARD_SCRIPT)
    }

    pub fn home(&self, panel_id: &str) -> Result<(), WebPanelError> {
        let _native_operation = self.lock_native_operations();
        validate_panel_id(panel_id)?;
        let (view, home_url) = {
            let inner = self.lock_inner();
            let record = inner
                .model
                .records
                .get(panel_id)
                .ok_or(WebPanelError::PanelNotFound)?;
            let label = record
                .native_label
                .as_ref()
                .ok_or(WebPanelError::NativeOperation)?;
            let view = inner
                .views
                .get(label)
                .cloned()
                .ok_or(WebPanelError::NativeOperation)?;
            (view, record.descriptor.url.clone())
        };
        let loading = self
            .lock_inner()
            .model
            .begin_navigation(panel_id)
            .ok_or(WebPanelError::NativeOperation)?;
        let previous_url = self
            .snapshot(panel_id)
            .and_then(|snapshot| Url::parse(&snapshot.url).ok())
            .ok_or(WebPanelError::NativeOperation)?;
        self.lock_inner()
            .model
            .set_current_url(panel_id, home_url.clone());
        if !self.arm_navigation_timeout(&loading) {
            self.lock_inner()
                .model
                .set_current_url(panel_id, previous_url.clone());
            if let Some(snapshot) = self.rollback_navigation(&loading) {
                self.publish_state(snapshot);
            }
            return Err(WebPanelError::NativeOperation);
        }
        self.publish_state(loading.snapshot.clone());
        if view.navigate(home_url).is_err() {
            self.lock_inner()
                .model
                .set_current_url(panel_id, previous_url);
            let rollback = self.rollback_navigation(&loading);
            if let Some(snapshot) = rollback {
                self.publish_state(snapshot);
            }
            return Err(WebPanelError::NativeOperation);
        }
        Ok(())
    }

    /// Clears only the dedicated publication profile. Configuration, article
    /// state and the authoritative database are not reachable from this path.
    pub fn clear_browsing_data(&self) -> Result<(), WebPanelError> {
        let _native_operation = self.lock_native_operations();
        // All publication views share the same dedicated profile, so one
        // controller-owned live view is sufficient. With no such view the
        // public cross-platform API cannot address that profile safely: fail
        // explicitly instead of reporting a successful no-op.
        let view = {
            let inner = self.lock_inner();
            let owned_view = inner.model.order.iter().find_map(|panel_id| {
                let label = inner.model.records.get(panel_id)?.native_label.as_ref()?;
                inner.views.get(label).cloned()
            });
            require_live_publication_view(owned_view)?
        };
        view.clear_all_browsing_data()
            .map_err(|_| WebPanelError::NativeOperation)
    }

    /// On macOS the accepted product contract is suspend/resume through
    /// WKWebView's public API. Windows keeps exact WebView2 muting. No script
    /// is injected into publication content for either platform.
    pub fn set_media_suspended(
        &self,
        panel_id: &str,
        suspended: bool,
    ) -> Result<(), WebPanelError> {
        let _native_operation = self.lock_native_operations();
        validate_panel_id(panel_id)?;
        apply_media_suspension(&self.view_for_panel(panel_id)?, suspended)?;
        let snapshot = self
            .snapshot(panel_id)
            .ok_or(WebPanelError::PanelNotFound)?;
        self.publish_state(snapshot);
        Ok(())
    }

    pub fn set_overlay_active(&self, active: bool) -> Result<(), WebPanelError> {
        let _native_operation = self.lock_native_operations();
        {
            let mut inner = self.lock_inner();
            inner.model.set_overlay_active(active);
        }
        self.apply_all_native_states()?;
        for snapshot in self.snapshots() {
            self.publish_state(snapshot);
        }
        Ok(())
    }

    pub fn destroy(&self, panel_id: &str) -> Result<bool, WebPanelError> {
        let _native_operation = self.lock_native_operations();
        let (label, view) = {
            let mut inner = self.lock_inner();
            let label = inner.model.destroy(panel_id)?;
            let view = label
                .as_ref()
                .and_then(|native_label| inner.views.remove(native_label));
            (label, view)
        };
        let close_result = label
            .map(|label| self.close_one_and_release(label, view))
            .unwrap_or(Ok(()));
        self.pump();
        close_result?;
        Ok(true)
    }

    pub fn destroy_all(&self) -> Result<(), WebPanelError> {
        let _native_operation = self.lock_native_operations();
        let (labels, views, timeouts) = {
            let mut inner = self.lock_inner();
            let mut labels = inner.model.clear().into_iter().collect::<HashSet<_>>();
            labels.extend(inner.views.keys().cloned());
            let views = inner.views.drain().collect::<Vec<_>>();
            let timeouts = inner
                .load_timeouts
                .drain()
                .map(|(_, token)| token)
                .collect::<Vec<_>>();
            (labels.into_iter().collect(), views, timeouts)
        };
        for timeout in timeouts {
            timeout.cancel();
        }
        self.close_views_and_release(labels, views)
    }

    pub fn snapshot(&self, panel_id: &str) -> Option<WebPanelSnapshot> {
        self.lock_inner().model.snapshot(panel_id)
    }

    /// Reads the live native URL at the moment of an explicit external-open
    /// action. This also covers SPA history/hash changes that do not emit a
    /// completed page-load callback. The URL never crosses into the renderer.
    pub fn current_url(&self, panel_id: &str) -> Result<Url, WebPanelError> {
        let _native_operation = self.lock_native_operations();
        validate_panel_id(panel_id)?;
        let (view, cached_url) = {
            let inner = self.lock_inner();
            let record = inner
                .model
                .records
                .get(panel_id)
                .ok_or(WebPanelError::PanelNotFound)?;
            let view = record
                .native_label
                .as_ref()
                .and_then(|label| inner.views.get(label))
                .cloned();
            (view, record.current_url.clone())
        };
        let url = match view {
            Some(view) => view.url().map_err(|_| WebPanelError::NativeOperation)?,
            None => cached_url,
        };
        if !is_allowed_navigation(&url) {
            return Err(WebPanelError::InvalidUrl);
        }
        self.lock_inner()
            .model
            .set_current_url(panel_id, url.clone());
        Ok(url)
    }

    pub fn snapshots(&self) -> Vec<WebPanelSnapshot> {
        self.lock_inner().model.snapshots()
    }

    fn set_visible(
        &self,
        panel_id: &str,
        visible: bool,
    ) -> Result<WebPanelSnapshot, WebPanelError> {
        let _native_operation = self.lock_native_operations();
        validate_panel_id(panel_id)?;
        let native = {
            let mut inner = self.lock_inner();
            inner.model.set_visible(panel_id, visible)?;
            native_update_for_panel(&inner, panel_id)
        };
        if let Some((label, view, state)) = native {
            self.apply_or_retire_native_state(label, view, state)?;
        }
        let snapshot = self
            .snapshot(panel_id)
            .ok_or(WebPanelError::PanelNotFound)?;
        self.publish_state(snapshot.clone());
        Ok(snapshot)
    }

    fn evaluate_fixed_script(
        &self,
        panel_id: &str,
        script: &'static str,
    ) -> Result<(), WebPanelError> {
        let _native_operation = self.lock_native_operations();
        self.evaluate_fixed_script_locked(panel_id, script)
    }

    fn evaluate_fixed_script_locked(
        &self,
        panel_id: &str,
        script: &'static str,
    ) -> Result<(), WebPanelError> {
        validate_panel_id(panel_id)?;
        self.view_for_panel(panel_id)?
            .eval(script)
            .map_err(|_| WebPanelError::NativeOperation)
    }

    fn view_for_panel(&self, panel_id: &str) -> Result<Webview<Wry>, WebPanelError> {
        let inner = self.lock_inner();
        let record = inner
            .model
            .records
            .get(panel_id)
            .ok_or(WebPanelError::PanelNotFound)?;
        let label = record
            .native_label
            .as_ref()
            .ok_or(WebPanelError::NativeOperation)?;
        inner
            .views
            .get(label)
            .cloned()
            .ok_or(WebPanelError::NativeOperation)
    }

    fn pump(&self) {
        let (parent_window, requests) = {
            let mut inner = self.lock_inner();
            let Some(parent_window) = inner.parent_window.clone() else {
                return;
            };
            let remaining_capacity =
                remaining_native_capacity(inner.model.active_labels.iter(), inner.views.keys());
            (
                parent_window,
                inner.model.take_loads_up_to(remaining_capacity),
            )
        };

        for request in requests {
            if !self.arm_load_timeout(&request) {
                continue;
            }
            let controller = self.clone();
            let request_label = request.native_label.clone();
            let request_window = parent_window.clone();
            if std::thread::Builder::new()
                .name("vibedeck-web-panel".to_string())
                .spawn(move || controller.build_native_view(request_window, request))
                .is_err()
            {
                self.finish_load(&request_label, false);
            }
        }
    }

    fn arm_load_timeout(&self, request: &LoadRequest) -> bool {
        self.arm_timeout(&request.panel_id, &request.native_label, request.deadline)
    }

    fn arm_navigation_timeout(&self, transition: &NavigationTransition) -> bool {
        self.arm_timeout(
            &transition.panel_id,
            &transition.native_label,
            transition.deadline,
        )
    }

    fn arm_timeout(&self, panel_id: &str, native_label: &str, deadline: Instant) -> bool {
        let cancellation = CancellationToken::new();
        let replaced = {
            let mut inner = self.lock_inner();
            let owns_deadline = inner.model.records.get(panel_id).is_some_and(|record| {
                record.native_label.as_deref() == Some(native_label)
                    && record.phase == WebPanelPhase::Loading
                    && record.load_deadline == Some(deadline)
            });
            if !owns_deadline {
                return false;
            }
            inner
                .load_timeouts
                .insert(native_label.to_string(), cancellation.clone())
        };
        if let Some(replaced) = replaced {
            replaced.cancel();
        }

        let controller = self.clone();
        let native_label = native_label.to_string();
        tauri::async_runtime::spawn(async move {
            let deadline_tokio = tokio::time::Instant::from_std(deadline);
            if tokio::time::timeout_at(deadline_tokio, cancellation.cancelled())
                .await
                .is_err()
            {
                controller.expire_load(&native_label, deadline);
            }
        });
        true
    }

    fn rollback_navigation(&self, transition: &NavigationTransition) -> Option<WebPanelSnapshot> {
        let (restored, timeout) = {
            let mut inner = self.lock_inner();
            inner.restore_navigation_and_take_timeout(transition)?
        };
        if let Some(timeout) = timeout {
            timeout.cancel();
        }
        if let Some(deadline) = restored.deadline {
            let _ = self.arm_timeout(&restored.panel_id, &restored.native_label, deadline);
        }
        Some(restored.snapshot)
    }

    fn build_native_view(&self, parent_window: Window<Wry>, request: LoadRequest) {
        // Child creation is serialized with sync/destroy. Checking ownership
        // after taking this lock prevents a destroyed in-flight request from
        // materializing a native view after its panel disappeared.
        let _native_operation = self.lock_native_operations();
        if !self
            .lock_inner()
            .model
            .owns_native_label(&request.panel_id, &request.native_label)
        {
            self.finish_load(&request.native_label, false);
            return;
        }

        let callback_controller = self.clone();
        let callback_label = request.native_label.clone();
        let navigation_controller = self.clone();
        let navigation_label = request.native_label.clone();
        let builder = WebviewBuilder::<Wry>::new(
            request.native_label.clone(),
            WebviewUrl::External(request.url),
        )
        .on_navigation(move |url| {
            navigation_controller.allow_native_navigation(&navigation_label, url)
        })
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_download(|_, event| !matches!(event, DownloadEvent::Requested { .. }))
        .on_page_load(move |webview, payload| {
            if payload.event() == PageLoadEvent::Started {
                let loading = {
                    callback_controller
                        .lock_inner()
                        .model
                        .mark_navigation_loading_for_label(&callback_label, payload.url())
                };
                if let Some(snapshot) = loading {
                    if callback_controller.arm_navigation_timeout(&snapshot) {
                        callback_controller.publish_state(snapshot.snapshot);
                    }
                }
                return;
            }
            // WKWebView calls Finished only from didFinishNavigation, so the
            // non-Windows bridge is already a success signal. WebView2's Wry
            // bridge discards NavigationCompleted.IsSuccess; its Finished
            // event must never decide lifecycle state. A native observer
            // installed below owns completion on Windows instead.
            #[cfg(target_os = "windows")]
            {
                let _ = webview;
            }
            #[cfg(not(target_os = "windows"))]
            {
                let allowed = is_allowed_navigation(payload.url());
                if !allowed {
                    let _ = webview.close();
                    callback_controller.finish_load(&callback_label, false);
                } else {
                    callback_controller
                        .finish_allowed_page_load(&callback_label, payload.url().clone());
                }
            }
        })
        .focused(false)
        .zoom_hotkeys_enabled(false)
        .browser_extensions_enabled(false)
        .general_autofill_enabled(false)
        .devtools(false)
        .incognito(false);

        #[cfg(target_os = "macos")]
        let builder = builder
            .data_store_identifier(MACOS_PUBLICATION_DATA_STORE)
            .allow_link_preview(false);
        #[cfg(not(target_os = "macos"))]
        let builder = builder.data_directory(self.publication_data_directory.clone());

        // Tauri exposes no initial child visibility. Creating at a tiny,
        // off-screen rectangle avoids painting over the dashboard before the
        // first explicit visibility/bounds operation. Absence of a one-frame native
        // flash remains a physical macOS/Windows gate.
        let built = parent_window.add_child(
            builder,
            LogicalPosition::new(-MAX_COORDINATE, -MAX_COORDINATE),
            LogicalSize::new(1.0, 1.0),
        );
        let Ok(webview) = built else {
            self.finish_load(&request.native_label, false);
            return;
        };
        if install_native_navigation_completion(
            &webview,
            self.clone(),
            request.native_label.clone(),
        )
        .is_err()
        {
            self.finish_load(&request.native_label, false);
            let _ = self.close_one_and_release(request.native_label, Some(webview));
            return;
        }

        let state = {
            let mut inner = self.lock_inner();
            let state = inner
                .model
                .native_state_for_panel(&request.panel_id)
                .filter(|(label, _)| label == &request.native_label)
                .map(|(_, state)| state);
            if state.is_some() {
                inner
                    .views
                    .insert(request.native_label.clone(), webview.clone());
            }
            state
        };
        let Some(state) = state else {
            self.finish_load(&request.native_label, false);
            let _ = self.close_one_and_release(request.native_label, Some(webview));
            return;
        };
        if apply_native_state(&webview, &state).is_err() {
            {
                let mut inner = self.lock_inner();
                inner.views.remove(&request.native_label);
            }
            self.finish_load(&request.native_label, false);
            let _ = self.close_one_and_release(request.native_label, Some(webview));
        }
    }

    fn finish_load(&self, native_label: &str, success: bool) {
        let (stale_view, timeout, snapshot) = {
            let mut inner = self.lock_inner();
            let panel_id = inner.model.records.iter().find_map(|(panel_id, record)| {
                (record.native_label.as_deref() == Some(native_label)).then(|| panel_id.clone())
            });
            let current = inner.model.finish(native_label, success);
            (
                (!current || !success)
                    .then(|| inner.views.remove(native_label))
                    .flatten(),
                inner.load_timeouts.remove(native_label),
                panel_id.and_then(|panel_id| inner.model.snapshot(&panel_id)),
            )
        };
        if let Some(timeout) = timeout {
            timeout.cancel();
        }
        if let Some(view) = stale_view {
            let _ = self.close_one_and_release(native_label.to_string(), Some(view));
        }
        if let Some(snapshot) = snapshot {
            self.publish_state(snapshot);
        }
        self.pump();
    }

    fn allow_native_navigation(&self, native_label: &str, url: &Url) -> bool {
        if !is_allowed_navigation(url) {
            return false;
        }
        let request = self
            .lock_inner()
            .model
            .request_navigation_for_label(native_label, url);
        match request {
            NativeNavigationRequest::AlreadyPending => true,
            NativeNavigationRequest::Stale => false,
            NativeNavigationRequest::Started(transition) => {
                if !self.arm_navigation_timeout(&transition) {
                    if let Some(snapshot) = self.rollback_navigation(&transition) {
                        self.publish_state(snapshot);
                    }
                    return false;
                }
                self.publish_state(transition.snapshot);
                true
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    fn finish_allowed_page_load(&self, native_label: &str, url: Url) {
        self.finish_allowed_page_load_for_native_navigation(native_label, url, None);
    }

    fn finish_allowed_page_load_for_native_navigation(
        &self,
        native_label: &str,
        url: Url,
        native_navigation_id: Option<u64>,
    ) {
        let (outcome, stale_view, timeout, snapshot) = {
            let mut inner = self.lock_inner();
            let outcome = if let Some(native_navigation_id) = native_navigation_id {
                inner.model.finish_page_load_for_native_navigation(
                    native_label,
                    &url,
                    Some(native_navigation_id),
                )
            } else {
                inner.model.finish_page_load(native_label, &url)
            };
            match &outcome {
                PageLoadFinish::Applied(panel_id) => {
                    inner.model.set_current_url_for_label(native_label, url);
                    let timeout = inner.load_timeouts.remove(native_label);
                    let snapshot = inner.model.snapshot(panel_id);
                    (outcome, None, timeout, snapshot)
                }
                PageLoadFinish::IgnoredAwaitingNativeStart
                | PageLoadFinish::IgnoredUnexpectedNativeNavigation
                | PageLoadFinish::IgnoredUnexpectedUrl => (outcome, None, None, None),
                PageLoadFinish::Stale => {
                    let stale_view = inner.views.remove(native_label);
                    let timeout = inner.load_timeouts.remove(native_label);
                    (outcome, stale_view, timeout, None)
                }
            }
        };
        if matches!(
            outcome,
            PageLoadFinish::IgnoredAwaitingNativeStart
                | PageLoadFinish::IgnoredUnexpectedNativeNavigation
                | PageLoadFinish::IgnoredUnexpectedUrl
        ) {
            return;
        }
        if let Some(timeout) = timeout {
            timeout.cancel();
        }
        if let Some(view) = stale_view {
            let _ = self.close_one_and_release(native_label.to_string(), Some(view));
        }
        if let Some(snapshot) = snapshot {
            self.publish_state(snapshot);
        }
        self.pump();
    }

    #[cfg(target_os = "windows")]
    fn record_native_navigation_id(&self, native_label: &str, url: &Url, navigation_id: u64) {
        self.lock_inner()
            .model
            .record_native_navigation_id(native_label, url, navigation_id);
    }

    #[cfg(any(target_os = "windows", test))]
    fn finish_native_page_load(
        &self,
        native_label: &str,
        navigation_id: u64,
        succeeded: bool,
        url: Option<Url>,
    ) {
        if let Some(url) = successful_navigation_url(succeeded, url) {
            self.finish_allowed_page_load_for_native_navigation(
                native_label,
                url,
                Some(navigation_id),
            );
            return;
        }

        let (applied, stale_view, timeout, snapshot) = {
            let mut inner = self.lock_inner();
            let panel_id = inner.model.records.iter().find_map(|(panel_id, record)| {
                (record.phase == WebPanelPhase::Loading
                    && record.native_label.as_deref() == Some(native_label)
                    && record.native_navigation_id == Some(navigation_id))
                .then(|| panel_id.clone())
            });
            let applied = panel_id.is_some() && inner.model.finish(native_label, false);
            let stale_view = applied.then(|| inner.views.remove(native_label)).flatten();
            let timeout = applied
                .then(|| inner.load_timeouts.remove(native_label))
                .flatten();
            let snapshot = panel_id.and_then(|panel_id| inner.model.snapshot(&panel_id));
            (applied, stale_view, timeout, snapshot)
        };
        if !applied {
            return;
        }
        if let Some(timeout) = timeout {
            timeout.cancel();
        }
        if let Some(view) = stale_view {
            let _ = self.close_one_and_release(native_label.to_string(), Some(view));
        }
        if let Some(snapshot) = snapshot {
            self.publish_state(snapshot);
        }
        self.pump();
    }

    fn expire_load(&self, native_label: &str, deadline: Instant) {
        let _native_operation = self.lock_native_operations();
        let (expired, stale_view, snapshot) = {
            let mut inner = self.lock_inner();
            inner.load_timeouts.remove(native_label);
            let panel_id = inner.model.records.iter().find_map(|(panel_id, record)| {
                (record.native_label.as_deref() == Some(native_label)).then(|| panel_id.clone())
            });
            let expired = inner.model.expire_load(native_label, deadline);
            let stale_view = expired.then(|| inner.views.remove(native_label)).flatten();
            let snapshot = panel_id.and_then(|panel_id| inner.model.snapshot(&panel_id));
            (expired, stale_view, snapshot)
        };
        if !expired {
            return;
        }
        if let Some(view) = stale_view {
            let _ = self.close_one_and_release(native_label.to_string(), Some(view));
        }
        if let Some(snapshot) = snapshot {
            self.publish_state(snapshot);
        }
        self.pump();
    }

    fn publish_state(&self, snapshot: WebPanelSnapshot) {
        let _publish_order = self
            .state_publish_order
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let sink = self
            .state_sink
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let Some(sink) = sink else {
            return;
        };
        if sink(snapshot.into()).is_ok() {
            return;
        }
        let mut current = self
            .state_sink
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if current
            .as_ref()
            .is_some_and(|candidate| Arc::ptr_eq(candidate, &sink))
        {
            *current = None;
        }
    }

    fn apply_all_native_states(&self) -> Result<(), WebPanelError> {
        let updates = {
            let inner = self.lock_inner();
            inner
                .views
                .iter()
                .filter_map(|(label, view)| {
                    inner
                        .model
                        .native_state_for_label(label)
                        .map(|state| (label.clone(), view.clone(), state))
                })
                .collect::<Vec<_>>()
        };
        let mut failed = false;
        for (label, view, state) in updates {
            if self
                .apply_or_retire_native_state(label, view, state)
                .is_err()
            {
                failed = true;
            }
        }
        if failed {
            Err(WebPanelError::NativeOperation)
        } else {
            Ok(())
        }
    }

    fn apply_or_retire_native_state(
        &self,
        label: String,
        view: Webview<Wry>,
        state: NativeState,
    ) -> Result<(), WebPanelError> {
        if apply_native_state(&view, &state).is_ok() {
            return Ok(());
        }

        // A view whose hide/bounds/show transition failed is no longer safe
        // to display. Detach it from the panel, mark the panel failed, and
        // close it. If native close itself fails, close_one_and_release keeps
        // the handle after a best-effort hide for a later destroy_all retry.
        {
            let mut inner = self.lock_inner();
            inner.views.remove(&label);
            inner.model.finish(&label, false);
        }
        let _ = view.hide();
        let _ = self.close_one_and_release(label, Some(view));
        Err(WebPanelError::NativeOperation)
    }

    fn close_views_and_release(
        &self,
        labels: Vec<String>,
        views: Vec<(String, Webview<Wry>)>,
    ) -> Result<(), WebPanelError> {
        let mut views_by_label = views.into_iter().collect::<HashMap<_, _>>();
        let mut failed = false;
        for label in labels {
            let view = views_by_label.remove(&label);
            if self.close_one_and_release(label, view).is_err() {
                failed = true;
            }
        }
        if failed {
            Err(WebPanelError::NativeOperation)
        } else {
            Ok(())
        }
    }

    fn close_one_and_release(
        &self,
        label: String,
        view: Option<Webview<Wry>>,
    ) -> Result<(), WebPanelError> {
        let Some(view) = view else {
            // The build thread still owns this request. It will observe that
            // the record disappeared, release the slot, and avoid/invalidate
            // the native child while holding native_operations.
            return Ok(());
        };

        let _ = view.hide();
        let close_result = view.close().map_err(|_| WebPanelError::NativeOperation);
        let mut inner = self.lock_inner();
        // Once the controller has detached a concrete native handle, a failed
        // close must not consume one of the two load slots forever.
        inner.model.release_active_label(&label);
        let timeout = inner.load_timeouts.remove(&label);
        if close_result.is_err() {
            // Retain ownership for a later callback/destroy_all retry rather
            // than dropping the only handle to a possibly-live native view.
            inner.views.entry(label).or_insert(view);
        }
        drop(inner);
        if let Some(timeout) = timeout {
            timeout.cancel();
        }
        close_result
    }

    fn lock_inner(&self) -> MutexGuard<'_, ControllerInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn lock_native_operations(&self) -> MutexGuard<'_, ()> {
        self.native_operations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn native_update_for_panel(
    inner: &ControllerInner,
    panel_id: &str,
) -> Option<(String, Webview<Wry>, NativeState)> {
    let (label, state) = inner.model.native_state_for_panel(panel_id)?;
    Some((label.clone(), inner.views.get(&label)?.clone(), state))
}

fn remaining_native_capacity<'a>(
    active_labels: impl IntoIterator<Item = &'a String>,
    view_labels: impl IntoIterator<Item = &'a String>,
) -> usize {
    let tracked_labels = active_labels
        .into_iter()
        .chain(view_labels)
        .collect::<HashSet<_>>();
    MAX_WEB_PANELS.saturating_sub(tracked_labels.len())
}

fn require_live_publication_view<T>(view: Option<T>) -> Result<T, WebPanelError> {
    view.ok_or(WebPanelError::NativeOperation)
}

fn apply_native_state(view: &Webview<Wry>, state: &NativeState) -> Result<(), WebPanelError> {
    let bounds = Rect {
        position: LogicalPosition::new(state.bounds.x, state.bounds.y).into(),
        size: LogicalSize::new(state.bounds.width.max(1.0), state.bounds.height.max(1.0)).into(),
    };
    // Hidden/overlay transitions always attempt hide first. Their caller
    // retires and closes the view if any native step fails, so the lifecycle
    // state remains fail-closed. A visible resize stays visible while its
    // native bounds move, avoiding a hide/show flash on every layout frame.
    if !state.visible {
        view.hide().map_err(|_| WebPanelError::NativeOperation)?;
    }
    view.set_bounds(bounds)
        .map_err(|_| WebPanelError::NativeOperation)?;
    if state.visible {
        view.show().map_err(|_| WebPanelError::NativeOperation)?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn install_native_navigation_completion(
    view: &Webview<Wry>,
    controller: WebPanelController,
    native_label: String,
) -> Result<(), WebPanelError> {
    use webview2_com::{
        take_pwstr, NavigationCompletedEventHandler, NavigationStartingEventHandler,
    };
    use windows_core::{BOOL, PWSTR};

    view.with_webview(move |platform_webview| {
        let setup_controller = controller.clone();
        let setup_label = native_label.clone();
        let setup = (|| {
            let webview =
                unsafe { platform_webview.controller().CoreWebView2() }.map_err(|_| ())?;

            // WebView2 is the only source that exposes a stable NavigationId.
            // Wry's URL-only callbacks still own validation and lifecycle
            // transitions; this observer only binds their active transition to
            // the native completion that belongs to it.
            let starting_controller = controller.clone();
            let starting_label = native_label.clone();
            let starting_handler =
                NavigationStartingEventHandler::create(Box::new(move |_sender, arguments| {
                    let Some(arguments) = arguments else {
                        return Ok(());
                    };
                    let mut navigation_id = 0;
                    let mut uri = PWSTR::null();
                    if unsafe { arguments.NavigationId(&mut navigation_id) }.is_err()
                        || unsafe { arguments.Uri(&mut uri) }.is_err()
                    {
                        return Ok(());
                    }
                    if let Ok(url) = Url::parse(&take_pwstr(uri)) {
                        starting_controller.record_native_navigation_id(
                            &starting_label,
                            &url,
                            navigation_id,
                        );
                    }
                    Ok(())
                }));
            let mut starting_token = 0;
            unsafe { webview.add_NavigationStarting(&starting_handler, &mut starting_token) }
                .map_err(|_| ())?;

            let completion_controller = controller.clone();
            let completion_label = native_label.clone();
            let handler =
                NavigationCompletedEventHandler::create(Box::new(move |sender, arguments| {
                    let mut succeeded = BOOL::default();
                    let mut navigation_id = 0;
                    let Some(arguments) = arguments else {
                        return Ok(());
                    };
                    if unsafe { arguments.NavigationId(&mut navigation_id) }.is_err()
                        || unsafe { arguments.IsSuccess(&mut succeeded) }.is_err()
                    {
                        return Ok(());
                    }
                    let completed_url = sender.and_then(|sender| {
                        let mut source = PWSTR::null();
                        unsafe { sender.Source(&mut source).ok()? };
                        Url::parse(&take_pwstr(source)).ok()
                    });
                    completion_controller.finish_native_page_load(
                        &completion_label,
                        navigation_id,
                        succeeded.as_bool(),
                        completed_url,
                    );
                    Ok(())
                }));
            let mut token = 0;
            unsafe { webview.add_NavigationCompleted(&handler, &mut token) }.map_err(|_| ())?;
            Ok::<(), ()>(())
        })();
        if setup.is_err() {
            setup_controller.finish_load(&setup_label, false);
        }
    })
    .map_err(|_| WebPanelError::NativeOperation)
}

#[cfg(not(target_os = "windows"))]
fn install_native_navigation_completion(
    _view: &Webview<Wry>,
    _controller: WebPanelController,
    _native_label: String,
) -> Result<(), WebPanelError> {
    Ok(())
}

#[cfg(any(target_os = "windows", test))]
fn successful_navigation_url(succeeded: bool, url: Option<Url>) -> Option<Url> {
    if succeeded && url.as_ref().is_some_and(is_allowed_navigation) {
        url
    } else {
        None
    }
}

#[cfg(target_os = "macos")]
fn apply_media_suspension(view: &Webview<Wry>, suspended: bool) -> Result<(), WebPanelError> {
    view.with_webview(move |platform_webview| {
        let webview = platform_webview.inner().cast::<objc2_web_kit::WKWebView>();
        // Tauri owns the WKWebView for at least the duration of this main-loop
        // callback. We borrow the pointer and never retain or expose it.
        if let Some(webview) = unsafe { webview.as_ref() } {
            unsafe {
                webview.setAllMediaPlaybackSuspended_completionHandler(suspended, None);
            }
        }
    })
    .map_err(|_| WebPanelError::NativeOperation)
}

#[cfg(target_os = "windows")]
fn apply_media_suspension(view: &Webview<Wry>, suspended: bool) -> Result<(), WebPanelError> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_8;
    use windows_core::Interface;

    view.with_webview(move |platform_webview| unsafe {
        let controller = platform_webview.controller();
        if let Ok(webview) = controller.CoreWebView2() {
            if let Ok(webview) = webview.cast::<ICoreWebView2_8>() {
                let _ = webview.SetIsMuted(suspended);
            }
        }
    })
    .map_err(|_| WebPanelError::NativeOperation)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn apply_media_suspension(_view: &Webview<Wry>, _suspended: bool) -> Result<(), WebPanelError> {
    Err(WebPanelError::NativeOperation)
}

fn ensure_main_parent(window: &Window<Wry>) -> Result<(), WebPanelError> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err(WebPanelError::InvalidParent)
    }
}

fn window_viewport(window: &Window<Wry>) -> Option<(f64, f64)> {
    let scale_factor = window.scale_factor().ok()?;
    let size = window.inner_size().ok()?.to_logical::<f64>(scale_factor);
    (size.width.is_finite() && size.height.is_finite() && size.width >= 0.0 && size.height >= 0.0)
        .then_some((size.width, size.height))
}

fn validate_descriptor_list(
    descriptors: Vec<WebPanelDescriptor>,
    viewport: Option<(f64, f64)>,
) -> Result<Vec<ValidatedDescriptor>, WebPanelError> {
    if descriptors.len() > MAX_WEB_PANELS {
        return Err(WebPanelError::TooManyPanels);
    }
    let mut ids = HashSet::with_capacity(descriptors.len());
    let mut normalized = Vec::with_capacity(descriptors.len());
    for descriptor in descriptors {
        let descriptor = validate_descriptor(descriptor, viewport)?;
        if !ids.insert(descriptor.panel_id.clone()) {
            return Err(WebPanelError::DuplicatePanel);
        }
        normalized.push(descriptor);
    }
    Ok(normalized)
}

fn validate_descriptor(
    descriptor: WebPanelDescriptor,
    viewport: Option<(f64, f64)>,
) -> Result<ValidatedDescriptor, WebPanelError> {
    validate_panel_id(&descriptor.panel_id)?;
    let url = parse_allowed_url(&descriptor.url)?;
    let bounds = validate_bounds(descriptor.bounds, viewport)?;
    Ok(ValidatedDescriptor {
        panel_id: descriptor.panel_id,
        url,
        bounds,
        visible: descriptor.visible,
    })
}

fn validate_optional_panel_id(panel_id: Option<&str>) -> Result<Option<String>, WebPanelError> {
    panel_id
        .map(|panel_id| {
            validate_panel_id(panel_id)?;
            Ok(panel_id.to_string())
        })
        .transpose()
}

fn validate_panel_id(panel_id: &str) -> Result<(), WebPanelError> {
    let mut bytes = panel_id.bytes();
    if panel_id.is_empty()
        || panel_id.len() > MAX_PANEL_ID_LENGTH
        || !bytes
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        || !bytes.all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    {
        return Err(WebPanelError::InvalidPanelId);
    }
    Ok(())
}

pub(crate) fn parse_allowed_url(raw_url: &str) -> Result<Url, WebPanelError> {
    if raw_url.len() > MAX_URL_LENGTH {
        return Err(WebPanelError::InvalidUrl);
    }
    let url = Url::parse(raw_url.trim()).map_err(|_| WebPanelError::InvalidUrl)?;
    is_allowed_navigation(&url)
        .then_some(url)
        .ok_or(WebPanelError::InvalidUrl)
}

pub fn is_allowed_navigation(url: &Url) -> bool {
    url.as_str().len() <= MAX_URL_LENGTH
        && matches!(url.scheme(), "http" | "https")
        && url.has_host()
        && url.username().is_empty()
        && url.password().is_none()
}

fn validate_bounds(
    bounds: WebPanelBounds,
    viewport: Option<(f64, f64)>,
) -> Result<WebPanelBounds, WebPanelError> {
    let values = [bounds.x, bounds.y, bounds.width, bounds.height];
    if values
        .iter()
        .any(|value| !value.is_finite() || value.abs() > MAX_COORDINATE)
        || bounds.width < 0.0
        || bounds.height < 0.0
    {
        return Err(WebPanelError::InvalidBounds);
    }

    let left = bounds.x.floor().max(0.0);
    let top = bounds.y.floor().max(0.0);
    let right = (bounds.x + bounds.width).ceil().max(left);
    let bottom = (bounds.y + bounds.height).ceil().max(top);
    let (right, bottom, left, top) = if let Some((viewport_width, viewport_height)) = viewport {
        let left = left.min(viewport_width);
        let top = top.min(viewport_height);
        (
            right.min(viewport_width).max(left),
            bottom.min(viewport_height).max(top),
            left,
            top,
        )
    } else {
        (right, bottom, left, top)
    };
    Ok(WebPanelBounds {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn descriptor(panel_id: &str, visible: bool) -> WebPanelDescriptor {
        WebPanelDescriptor {
            panel_id: panel_id.to_string(),
            url: format!("https://{panel_id}.example/news"),
            bounds: WebPanelBounds {
                x: 12.0,
                y: 24.0,
                width: 640.0,
                height: 480.0,
            },
            visible,
        }
    }

    fn complete_every_queued_load(model: &mut LifecycleModel) -> Vec<LoadRequest> {
        let mut completed = Vec::new();
        while !model.queue.is_empty() {
            let requests = model.take_loads();
            assert!(!requests.is_empty(), "la file ne doit pas perdre ses slots");
            assert!(requests.len() <= MAX_CONCURRENT_WEB_PANEL_LOADS);
            for request in &requests {
                assert!(model.finish(&request.native_label, true));
            }
            completed.extend(requests);
        }
        assert!(model.active_labels.is_empty());
        completed
    }

    fn assert_lifecycle_is_empty(model: &LifecycleModel) {
        assert!(model.records.is_empty());
        assert!(model.order.is_empty());
        assert!(model.queue.is_empty());
        assert!(model.active_labels.is_empty());
        assert!(model.active_deadlines.is_empty());
        assert!(model.snapshots().is_empty());
    }

    #[test]
    fn navigation_policy_only_allows_credential_free_http_urls() {
        for allowed in ["https://example.com/", "http://news.example.test/path?q=1"] {
            assert!(is_allowed_navigation(&Url::parse(allowed).unwrap()));
        }
        for denied in [
            "file:///etc/passwd",
            "data:text/html,unsafe",
            "javascript:alert(1)",
            "https://user@example.com/",
            "https://user:secret@example.com/",
        ] {
            assert!(!is_allowed_navigation(&Url::parse(denied).unwrap()));
        }
        let overlong = Url::parse(&format!(
            "https://example.com/{}",
            "x".repeat(MAX_URL_LENGTH)
        ))
        .unwrap();
        assert!(!is_allowed_navigation(&overlong));
        assert_eq!(
            parse_allowed_url(&format!(
                "https://example.com/{}",
                "x".repeat(MAX_URL_LENGTH)
            ))
            .unwrap_err(),
            WebPanelError::InvalidUrl
        );

        let allowed = Url::parse("https://example.com/").unwrap();
        assert_eq!(
            successful_navigation_url(true, Some(allowed.clone())),
            Some(allowed.clone()),
        );
        assert_eq!(successful_navigation_url(false, Some(allowed)), None);
        assert_eq!(
            successful_navigation_url(true, Some(Url::parse("file:///tmp/failure").unwrap())),
            None,
        );
    }

    #[test]
    fn snapshots_keep_the_main_owned_current_url_without_losing_the_home_url() {
        let mut model = LifecycleModel::default();
        let home = descriptor("panel-current", true);
        model.reconcile(vec![home.clone()], None, None).unwrap();
        let load = model.take_loads().pop().unwrap();
        assert!(model.finish(&load.native_label, true));

        let current = Url::parse("https://publication.example/article#section").unwrap();
        assert!(model.set_current_url_for_label(&load.native_label, current.clone()));
        assert_eq!(
            model.snapshot("panel-current").unwrap().url,
            current.as_str()
        );

        let mut resized = home.clone();
        resized.bounds.width = 800.0;
        model.reconcile(vec![resized], None, None).unwrap();
        assert_eq!(
            model.snapshot("panel-current").unwrap().url,
            current.as_str()
        );

        let mut new_home = home;
        new_home.url = "https://replacement.example/home".to_string();
        model.reconcile(vec![new_home.clone()], None, None).unwrap();
        assert_eq!(model.snapshot("panel-current").unwrap().url, new_home.url);
        assert_eq!(
            model.records["panel-current"].descriptor.url.as_str(),
            new_home.url
        );
    }

    #[test]
    fn ordered_state_sink_observes_initial_and_async_load_phases() {
        let controller = WebPanelController::new(PathBuf::from("unused-test-profile"));
        let load = {
            let mut inner = controller.lock_inner();
            inner
                .model
                .insert(descriptor("panel-stream", true), true, None)
                .unwrap();
            inner.model.take_loads().pop().unwrap()
        };
        let received = Arc::new(Mutex::new(Vec::<WebPanelViewState>::new()));
        let captured = Arc::clone(&received);
        controller
            .replace_state_sink(Arc::new(move |state| {
                captured.lock().unwrap().push(state);
                Ok(())
            }))
            .unwrap();

        controller.finish_load(&load.native_label, true);

        let phases = received
            .lock()
            .unwrap()
            .iter()
            .map(|state| state.phase)
            .collect::<Vec<_>>();
        assert_eq!(phases, [WebPanelPhase::Loading, WebPanelPhase::Ready]);
        let sequences = received
            .lock()
            .unwrap()
            .iter()
            .map(|state| state.sequence)
            .collect::<Vec<_>>();
        assert!(sequences.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn failed_state_sink_is_rejected_and_replacement_is_ready_before_ack() {
        let controller = WebPanelController::new(PathBuf::from("unused-test-profile"));
        let load = {
            let mut inner = controller.lock_inner();
            inner
                .model
                .insert(descriptor("panel-resubscribe", true), true, None)
                .unwrap();
            inner.model.take_loads().pop().unwrap()
        };
        let failed_deliveries = Arc::new(Mutex::new(0_u32));
        let captured_failures = Arc::clone(&failed_deliveries);
        assert_eq!(
            controller.replace_state_sink(Arc::new(move |_| {
                *captured_failures.lock().unwrap() += 1;
                Err(())
            })),
            Err(WebPanelError::StateChannelUnavailable),
        );
        assert_eq!(*failed_deliveries.lock().unwrap(), 1);

        // The failed sink was detached: this asynchronous transition cannot
        // disappear into it while the renderer prepares a replacement.
        controller.finish_load(&load.native_label, true);
        assert_eq!(*failed_deliveries.lock().unwrap(), 1);

        let received = Arc::new(Mutex::new(Vec::<WebPanelViewState>::new()));
        let captured = Arc::clone(&received);
        controller
            .replace_state_sink(Arc::new(move |state| {
                captured.lock().unwrap().push(state);
                Ok(())
            }))
            .unwrap();

        // replace_state_sink only acknowledges after the authoritative
        // initial snapshot has entered the ordered replacement stream.
        assert_eq!(
            received
                .lock()
                .unwrap()
                .iter()
                .map(|state| state.phase)
                .collect::<Vec<_>>(),
            [WebPanelPhase::Ready],
        );
        let loading = controller
            .lock_inner()
            .model
            .begin_navigation("panel-resubscribe")
            .unwrap()
            .snapshot;
        controller.publish_state(loading);
        assert_eq!(
            received
                .lock()
                .unwrap()
                .iter()
                .map(|state| state.phase)
                .collect::<Vec<_>>(),
            [WebPanelPhase::Ready, WebPanelPhase::Loading],
        );
    }

    #[test]
    fn same_generation_descriptor_changes_advance_the_state_sequence() {
        let mut model = LifecycleModel::default();
        let original = descriptor("sequence-panel", true);
        model.reconcile(vec![original.clone()], None, None).unwrap();
        let load = model.take_loads().pop().unwrap();
        assert!(model.finish(&load.native_label, true));
        let before = model.snapshot("sequence-panel").unwrap();

        let mut resized = original;
        resized.bounds.width += 80.0;
        resized.visible = false;
        model.reconcile(vec![resized], None, None).unwrap();
        let after = model.snapshot("sequence-panel").unwrap();

        assert_eq!(after.generation, before.generation);
        assert!(after.sequence > before.sequence);
        assert_ne!(after.bounds, before.bounds);
        assert_ne!(after.requested_visible, before.requested_visible);
    }

    #[test]
    fn queued_replacement_gets_a_new_generation_before_a_load_slot_opens() {
        let mut model = LifecycleModel::default();
        let first = descriptor("generation-first", true);
        let second = descriptor("generation-second", true);
        let third = descriptor("generation-third", true);
        model
            .reconcile(
                vec![first.clone(), second.clone(), third.clone()],
                None,
                None,
            )
            .unwrap();
        assert_eq!(model.take_loads().len(), MAX_CONCURRENT_WEB_PANEL_LOADS);
        let previous_generation = model.snapshot("generation-third").unwrap().generation;

        let mut replacement = third;
        replacement.url = "https://replacement.example/queued".to_string();
        model
            .reconcile(vec![first, second, replacement], None, None)
            .unwrap();
        let snapshot = model.snapshot("generation-third").unwrap();
        assert_eq!(snapshot.phase, WebPanelPhase::Queued);
        assert!(snapshot.generation > previous_generation);
        assert_eq!(model.active_labels.len(), MAX_CONCURRENT_WEB_PANEL_LOADS);
    }

    #[test]
    fn failed_panel_retry_creates_a_new_generation_and_can_become_ready() {
        let mut model = LifecycleModel::default();
        model
            .insert(descriptor("retry-panel", true), true, None)
            .unwrap();
        let failed_load = model.take_loads().pop().unwrap();
        let failed_generation = model.snapshot("retry-panel").unwrap().generation;
        assert!(model.finish(&failed_load.native_label, false));
        assert_eq!(
            model.snapshot("retry-panel").unwrap().phase,
            WebPanelPhase::Failed
        );

        assert!(model.retry_failed("retry-panel").unwrap());
        let queued = model.snapshot("retry-panel").unwrap();
        assert_eq!(queued.phase, WebPanelPhase::Queued);
        assert!(queued.generation > failed_generation);
        let retry_load = model.take_loads().pop().unwrap();
        assert!(model.finish(&retry_load.native_label, true));
        assert_eq!(
            model.snapshot("retry-panel").unwrap().phase,
            WebPanelPhase::Ready
        );
    }

    #[test]
    fn every_navigation_transition_has_an_expiring_one_shot_deadline() {
        let started_at = Instant::now();
        let mut model = LifecycleModel::default();
        model
            .insert(descriptor("navigation-timeout", true), true, None)
            .unwrap();
        let initial = model.take_loads_up_to_at(MAX_WEB_PANELS, started_at)[0].clone();
        assert!(model.finish(&initial.native_label, true));

        let navigation = model
            .begin_navigation_at("navigation-timeout", started_at)
            .unwrap();
        assert_eq!(navigation.deadline, started_at + WEB_PANEL_LOAD_TIMEOUT,);
        assert_eq!(
            model.records["navigation-timeout"].load_deadline,
            Some(navigation.deadline),
        );
        assert!(!model.expire_load(
            &navigation.native_label,
            navigation.deadline - Duration::from_nanos(1),
        ));
        assert!(model.expire_load(&navigation.native_label, navigation.deadline,));
        assert_eq!(
            model.snapshot("navigation-timeout").unwrap().phase,
            WebPanelPhase::Failed,
        );

        assert!(model.retry_failed("navigation-timeout").unwrap());
        let retry = model.take_loads_up_to_at(MAX_WEB_PANELS, navigation.deadline)[0].clone();
        assert!(model.finish(&retry.native_label, true));
        let reload = model
            .begin_navigation_at("navigation-timeout", navigation.deadline)
            .unwrap();
        let restored = model.restore_navigation(&reload).unwrap();
        assert_eq!(restored.snapshot.phase, WebPanelPhase::Ready);
        assert_eq!(model.records["navigation-timeout"].load_deadline, None);
        assert!(!model.expire_load(&reload.native_label, reload.deadline));
    }

    #[test]
    fn only_the_started_navigation_with_the_expected_url_can_become_ready() {
        let mut model = LifecycleModel::default();
        model
            .insert(descriptor("overlapping-navigation", true), true, None)
            .unwrap();
        let initial = model.take_loads().pop().unwrap();
        assert!(model.records["overlapping-navigation"].awaiting_native_start);
        assert_eq!(
            model.finish_page_load(&initial.native_label, &initial.url),
            PageLoadFinish::IgnoredAwaitingNativeStart,
        );
        model
            .mark_navigation_loading_for_label(&initial.native_label, &initial.url)
            .unwrap();
        assert_eq!(
            model.finish_page_load(&initial.native_label, &initial.url),
            PageLoadFinish::Applied("overlapping-navigation".to_string()),
        );

        let first_url = Url::parse("https://overlapping-navigation.example/first").unwrap();
        let first_requested =
            match model.request_navigation_for_label(&initial.native_label, &first_url) {
                NativeNavigationRequest::Started(transition) => transition,
                _ => panic!("la première navigation doit démarrer"),
            };
        let first_started = model
            .mark_navigation_loading_for_label(&initial.native_label, &first_url)
            .unwrap();
        assert!(first_started.sequence > first_requested.sequence);
        assert!(!model.records["overlapping-navigation"].awaiting_native_start);
        let second_url = Url::parse("https://overlapping-navigation.example/second").unwrap();
        let second_requested =
            match model.request_navigation_for_label(&initial.native_label, &second_url) {
                NativeNavigationRequest::Started(transition) => transition,
                _ => panic!("la seconde navigation doit démarrer"),
            };
        assert!(model.records["overlapping-navigation"].awaiting_native_start);

        assert_eq!(
            model.finish_page_load(&initial.native_label, &first_url),
            PageLoadFinish::IgnoredAwaitingNativeStart,
        );
        let still_loading = model.snapshot("overlapping-navigation").unwrap();
        assert_eq!(still_loading.phase, WebPanelPhase::Loading);
        assert_eq!(
            model.records["overlapping-navigation"].load_deadline,
            Some(second_requested.deadline),
        );

        let second_started = model
            .mark_navigation_loading_for_label(&initial.native_label, &second_url)
            .unwrap();
        assert!(second_started.sequence > first_started.sequence);
        assert!(!model.records["overlapping-navigation"].awaiting_native_start);
        assert_eq!(
            model.finish_page_load(&initial.native_label, &first_url),
            PageLoadFinish::IgnoredUnexpectedUrl,
        );
        assert_eq!(
            model.snapshot("overlapping-navigation").unwrap().phase,
            WebPanelPhase::Loading,
        );
        assert_eq!(
            model.finish_page_load(&initial.native_label, &second_url),
            PageLoadFinish::Applied("overlapping-navigation".to_string()),
        );
        assert_eq!(
            model.snapshot("overlapping-navigation").unwrap().phase,
            WebPanelPhase::Ready,
        );
    }

    #[test]
    fn a_failed_native_completion_never_becomes_ready() {
        let controller = WebPanelController::new(PathBuf::from("unused-test-profile"));
        let load = {
            let mut inner = controller.lock_inner();
            inner
                .model
                .insert(descriptor("failed-native-completion", true), true, None)
                .unwrap();
            let load = inner.model.take_loads().pop().unwrap();
            assert!(inner
                .model
                .record_native_navigation_id(&load.native_label, &load.url, 41));
            inner
                .model
                .mark_navigation_loading_for_label(&load.native_label, &load.url)
                .unwrap();
            load
        };

        controller.finish_native_page_load(&load.native_label, 41, false, Some(load.url));
        assert_eq!(
            controller
                .snapshot("failed-native-completion")
                .unwrap()
                .phase,
            WebPanelPhase::Failed,
        );
    }

    #[test]
    fn canceled_native_completion_cannot_fail_the_replacement_navigation() {
        let controller = WebPanelController::new(PathBuf::from("unused-test-profile"));
        let (native_label, first_url, second_url, second_deadline) = {
            let mut inner = controller.lock_inner();
            inner
                .model
                .insert(descriptor("native-completion-race", true), true, None)
                .unwrap();
            let initial = inner.model.take_loads().pop().unwrap();
            assert!(inner.model.finish(&initial.native_label, true));

            let first_url = Url::parse("https://native-completion-race.example/first").unwrap();
            assert!(matches!(
                inner
                    .model
                    .request_navigation_for_label(&initial.native_label, &first_url),
                NativeNavigationRequest::Started(_)
            ));
            assert!(inner.model.record_native_navigation_id(
                &initial.native_label,
                &first_url,
                1001,
            ));
            inner
                .model
                .mark_navigation_loading_for_label(&initial.native_label, &first_url)
                .unwrap();
            assert!(inner
                .model
                .owns_native_navigation_id(&initial.native_label, 1001));

            let second_url = Url::parse("https://native-completion-race.example/second").unwrap();
            let second = match inner
                .model
                .request_navigation_for_label(&initial.native_label, &second_url)
            {
                NativeNavigationRequest::Started(transition) => transition,
                _ => panic!("la navigation de remplacement doit démarrer"),
            };
            assert!(!inner
                .model
                .owns_native_navigation_id(&initial.native_label, 1001));
            (initial.native_label, first_url, second_url, second.deadline)
        };

        // WebView2 completes the canceled navigation A after NavigationStarting(B),
        // but before ContentLoading(B). A must not own B's lifecycle or timeout.
        controller.finish_native_page_load(&native_label, 1001, false, Some(first_url.clone()));
        {
            let inner = controller.lock_inner();
            let record = &inner.model.records["native-completion-race"];
            assert_eq!(record.phase, WebPanelPhase::Loading);
            assert_eq!(record.load_deadline, Some(second_deadline));
            assert!(record.awaiting_native_start);
        }

        {
            let mut inner = controller.lock_inner();
            assert!(inner
                .model
                .record_native_navigation_id(&native_label, &second_url, 1002));
            inner
                .model
                .mark_navigation_loading_for_label(&native_label, &second_url)
                .unwrap();
        }

        // The same stale A completion is still harmless after B's ContentLoading.
        controller.finish_native_page_load(&native_label, 1001, false, Some(first_url));
        assert_eq!(
            controller.snapshot("native-completion-race").unwrap().phase,
            WebPanelPhase::Loading,
        );

        // Only B's correlated failure is authoritative.
        controller.finish_native_page_load(&native_label, 1002, false, Some(second_url));
        assert_eq!(
            controller.snapshot("native-completion-race").unwrap().phase,
            WebPanelPhase::Failed,
        );
    }

    #[test]
    fn completed_or_rolled_back_navigation_only_cancels_the_timeout_it_owned() {
        let mut inner = ControllerInner::default();
        inner
            .model
            .insert(descriptor("navigation-timeout-race", true), true, None)
            .unwrap();
        let initial = inner.model.take_loads().pop().unwrap();
        assert!(inner.model.finish(&initial.native_label, true));

        let stopping = inner
            .model
            .begin_navigation("navigation-timeout-race")
            .unwrap();
        let stopped_timeout = CancellationToken::new();
        inner
            .load_timeouts
            .insert(stopping.native_label.clone(), stopped_timeout.clone());
        let (stopped, captured_stopped_timeout) = inner
            .mark_navigation_ready_and_take_timeout("navigation-timeout-race")
            .unwrap();
        assert_eq!(stopped.phase, WebPanelPhase::Ready);

        let after_stop_url =
            Url::parse("https://navigation-timeout-race.example/after-stop").unwrap();
        inner
            .model
            .begin_navigation("navigation-timeout-race")
            .unwrap();
        let started_after_stop = inner
            .model
            .mark_navigation_loading_for_label(&stopping.native_label, &after_stop_url)
            .unwrap();
        let post_stop_timeout = CancellationToken::new();
        inner.load_timeouts.insert(
            started_after_stop.native_label.clone(),
            post_stop_timeout.clone(),
        );
        captured_stopped_timeout.unwrap().cancel();
        assert!(stopped_timeout.is_cancelled());
        assert!(!post_stop_timeout.is_cancelled());

        assert!(inner.model.finish(&stopping.native_label, true));
        inner.load_timeouts.remove(&stopping.native_label);
        let rolling_back = inner
            .model
            .begin_navigation("navigation-timeout-race")
            .unwrap();
        let rolled_back_timeout = CancellationToken::new();
        inner.load_timeouts.insert(
            rolling_back.native_label.clone(),
            rolled_back_timeout.clone(),
        );
        let (restored, captured_rolled_back_timeout) = inner
            .restore_navigation_and_take_timeout(&rolling_back)
            .unwrap();
        assert_eq!(restored.snapshot.phase, WebPanelPhase::Ready);

        let after_rollback_url =
            Url::parse("https://navigation-timeout-race.example/after-rollback").unwrap();
        inner
            .model
            .begin_navigation("navigation-timeout-race")
            .unwrap();
        let started_after_rollback = inner
            .model
            .mark_navigation_loading_for_label(&rolling_back.native_label, &after_rollback_url)
            .unwrap();
        let post_rollback_timeout = CancellationToken::new();
        inner.load_timeouts.insert(
            started_after_rollback.native_label,
            post_rollback_timeout.clone(),
        );
        captured_rolled_back_timeout.unwrap().cancel();
        assert!(rolled_back_timeout.is_cancelled());
        assert!(!post_rollback_timeout.is_cancelled());
    }

    #[test]
    fn history_controls_use_fixed_scripts_without_renderer_input() {
        assert_eq!(STOP_NAVIGATION_SCRIPT, "window.stop()");
        assert_eq!(GO_BACK_SCRIPT, "window.history.back()");
        assert_eq!(GO_FORWARD_SCRIPT, "window.history.forward()");
        for script in [STOP_NAVIGATION_SCRIPT, GO_BACK_SCRIPT, GO_FORWARD_SCRIPT] {
            assert!(!script.contains('`'));
            assert!(!script.contains("eval"));
            assert!(!script.contains("location"));
        }
    }

    #[test]
    fn focused_panel_loads_first_and_concurrency_never_exceeds_two() {
        let mut model = LifecycleModel::default();
        model
            .reconcile(
                vec![
                    descriptor("alpha", true),
                    descriptor("beta", true),
                    descriptor("focus", true),
                ],
                Some("focus"),
                None,
            )
            .unwrap();

        let first = model.take_loads();
        assert_eq!(first.len(), MAX_CONCURRENT_WEB_PANEL_LOADS);
        assert_eq!(first[0].panel_id, "focus");
        assert_eq!(first[1].panel_id, "alpha");
        assert!(first
            .iter()
            .all(|request| request.native_label.starts_with(CHILD_LABEL_PREFIX)));
        assert!(first.iter().all(|request| request.native_label != "main"));
        assert!(model.take_loads().is_empty());

        assert!(model.finish(&first[0].native_label, true));
        let next = model.take_loads();
        assert_eq!(next.len(), 1);
        assert_eq!(next[0].panel_id, "beta");
        assert_eq!(model.active_labels.len(), MAX_CONCURRENT_WEB_PANEL_LOADS);
    }

    #[test]
    fn a_queued_panel_focused_during_two_active_loads_gets_the_next_slot() {
        let mut model = LifecycleModel::default();
        model
            .reconcile(
                (0..MAX_WEB_PANELS)
                    .map(|index| descriptor(&format!("panel-{index}"), true))
                    .collect(),
                None,
                None,
            )
            .unwrap();

        let active = model.take_loads();
        assert_eq!(active.len(), MAX_CONCURRENT_WEB_PANEL_LOADS);
        model.prioritize(Some("panel-5"));
        assert!(model.finish(&active[0].native_label, true));

        let next = model.take_loads();
        assert_eq!(next.len(), 1);
        assert_eq!(next[0].panel_id, "panel-5");
        assert_eq!(model.active_labels.len(), MAX_CONCURRENT_WEB_PANEL_LOADS);
    }

    #[test]
    fn an_inflight_destroy_keeps_its_slot_until_native_completion() {
        let mut model = LifecycleModel::default();
        model
            .reconcile(
                vec![
                    descriptor("one", true),
                    descriptor("two", true),
                    descriptor("three", true),
                ],
                None,
                None,
            )
            .unwrap();
        let first = model.take_loads();
        let removed_label = model.destroy("one").unwrap().unwrap();
        assert_eq!(removed_label, first[0].native_label);
        assert!(model.take_loads().is_empty());

        assert!(!model.finish(&removed_label, false));
        let next = model.take_loads();
        assert_eq!(next.len(), 1);
        assert_eq!(next[0].panel_id, "three");

        assert!(model.finish(&first[1].native_label, true));
        assert!(model.finish(&next[0].native_label, true));
        assert!(model.active_labels.is_empty());
        assert_eq!(model.clear().len(), 2);
        assert_lifecycle_is_empty(&model);
    }

    #[test]
    fn an_inflight_destroyed_record_still_releases_its_slot_at_deadline() {
        let started_at = Instant::now();
        let mut model = LifecycleModel::default();
        model
            .reconcile(
                vec![
                    descriptor("one", true),
                    descriptor("two", true),
                    descriptor("three", true),
                ],
                None,
                None,
            )
            .unwrap();
        let first = model.take_loads_up_to_at(MAX_WEB_PANELS, started_at);
        let removed_label = model.destroy("one").unwrap().unwrap();
        let removed = first
            .iter()
            .find(|request| request.native_label == removed_label)
            .unwrap();

        assert!(!model.expire_load(
            &removed.native_label,
            removed.deadline - Duration::from_nanos(1)
        ));
        assert!(model.expire_load(&removed.native_label, removed.deadline));
        let next = model.take_loads_up_to_at(MAX_WEB_PANELS, removed.deadline);
        assert_eq!(next.len(), 1);
        assert_eq!(next[0].panel_id, "three");

        assert!(model.finish(&first[1].native_label, true));
        assert!(model.finish(&next[0].native_label, true));
        assert_eq!(model.clear().len(), 2);
        assert_lifecycle_is_empty(&model);
    }

    #[test]
    fn two_expired_page_loads_release_the_next_four_without_polling() {
        let started_at = Instant::now();
        let mut model = LifecycleModel::default();
        model
            .reconcile(
                (0..MAX_WEB_PANELS)
                    .map(|index| descriptor(&format!("panel-{index}"), true))
                    .collect(),
                None,
                None,
            )
            .unwrap();

        let stalled = model.take_loads_up_to_at(MAX_WEB_PANELS, started_at);
        assert_eq!(stalled.len(), MAX_CONCURRENT_WEB_PANEL_LOADS);
        assert!(stalled
            .iter()
            .all(|request| request.deadline == started_at + WEB_PANEL_LOAD_TIMEOUT));

        for request in &stalled {
            assert!(!model.expire_load(
                &request.native_label,
                request.deadline - Duration::from_nanos(1)
            ));
        }
        assert_eq!(model.active_labels.len(), MAX_CONCURRENT_WEB_PANEL_LOADS);
        assert!(model
            .take_loads_up_to_at(MAX_WEB_PANELS, started_at)
            .is_empty());

        for request in &stalled {
            assert!(model.expire_load(&request.native_label, request.deadline));
            assert_eq!(
                model.snapshot(&request.panel_id).unwrap().phase,
                WebPanelPhase::Failed
            );
        }
        assert!(model.active_labels.is_empty());

        let following = complete_every_queued_load(&mut model);
        assert_eq!(following.len(), MAX_WEB_PANELS - stalled.len());
        assert_eq!(
            following
                .iter()
                .map(|request| request.panel_id.as_str())
                .collect::<Vec<_>>(),
            vec!["panel-2", "panel-3", "panel-4", "panel-5"]
        );
        assert_eq!(model.clear().len(), MAX_WEB_PANELS - stalled.len());
        assert_lifecycle_is_empty(&model);
    }

    #[test]
    fn clear_invalidates_inflight_deadlines_and_slots() {
        let now = Instant::now();
        let mut model = LifecycleModel::default();
        model
            .reconcile(
                vec![descriptor("one", true), descriptor("two", true)],
                None,
                None,
            )
            .unwrap();
        let inflight = model.take_loads_up_to_at(MAX_WEB_PANELS, now);
        assert_eq!(inflight.len(), 2);

        assert_eq!(model.clear().len(), 2);
        assert_lifecycle_is_empty(&model);
        for request in inflight {
            assert!(!model.expire_load(&request.native_label, request.deadline));
        }
    }

    #[test]
    fn overlay_hides_every_panel_and_restores_only_requested_visibility() {
        let mut model = LifecycleModel::default();
        model
            .reconcile(
                vec![descriptor("shown", true), descriptor("hidden", false)],
                None,
                None,
            )
            .unwrap();
        let loads = model.take_loads();
        for load in loads {
            assert!(model.finish(&load.native_label, true));
        }
        assert!(model.snapshot("shown").unwrap().visible);
        assert!(!model.snapshot("hidden").unwrap().visible);

        model.set_overlay_active(true);
        assert!(model.snapshots().iter().all(|snapshot| !snapshot.visible));
        model.set_visible("hidden", true).unwrap();
        assert!(!model.snapshot("hidden").unwrap().visible);

        model.set_overlay_active(false);
        assert!(model.snapshots().iter().all(|snapshot| snapshot.visible));
        model.set_visible("shown", false).unwrap();
        assert!(!model.snapshot("shown").unwrap().visible);
    }

    #[test]
    fn one_hundred_six_panel_create_destroy_rounds_leave_no_slot_or_label() {
        let mut model = LifecycleModel::default();
        let mut all_labels = HashSet::new();

        for round in 0..100 {
            let descriptors = (0..MAX_WEB_PANELS)
                .map(|index| descriptor(&format!("panel-{index}"), true))
                .collect::<Vec<_>>();
            model.reconcile(descriptors, Some("panel-5"), None).unwrap();

            let completed = complete_every_queued_load(&mut model);
            assert_eq!(completed.len(), MAX_WEB_PANELS);
            assert_eq!(completed[0].panel_id, "panel-5");
            assert_eq!(model.records.len(), MAX_WEB_PANELS);
            assert_eq!(model.snapshots().len(), MAX_WEB_PANELS);
            assert!(model
                .records
                .values()
                .all(|record| record.phase == WebPanelPhase::Ready));

            for request in completed {
                assert!(request.native_label.starts_with(CHILD_LABEL_PREFIX));
                assert_ne!(request.native_label, "main");
                assert!(all_labels.insert(request.native_label));
            }

            let destroyed = model.clear();
            assert_eq!(destroyed.len(), MAX_WEB_PANELS, "round {round}");
            assert_lifecycle_is_empty(&model);
        }

        assert_eq!(all_labels.len(), 100 * MAX_WEB_PANELS);
    }

    #[test]
    fn five_hundred_hide_show_cycles_keep_six_panels_consistent() {
        let mut model = LifecycleModel::default();
        let panel_ids = (0..MAX_WEB_PANELS)
            .map(|index| format!("panel-{index}"))
            .collect::<Vec<_>>();
        model
            .reconcile(
                panel_ids
                    .iter()
                    .map(|panel_id| descriptor(panel_id, true))
                    .collect(),
                Some("panel-0"),
                None,
            )
            .unwrap();
        complete_every_queued_load(&mut model);

        for _ in 0..500 {
            for panel_id in &panel_ids {
                model.set_visible(panel_id, false).unwrap();
            }
            assert!(model.snapshots().iter().all(|snapshot| !snapshot.visible));

            // Overlay is authoritative: even requests to show all six views
            // remain effectively hidden until the overlay is removed.
            model.set_overlay_active(true);
            for panel_id in &panel_ids {
                model.set_visible(panel_id, true).unwrap();
            }
            assert!(model.snapshots().iter().all(|snapshot| !snapshot.visible));
            model.set_overlay_active(false);
            assert!(model.snapshots().iter().all(|snapshot| snapshot.visible));
        }

        assert_eq!(model.clear().len(), MAX_WEB_PANELS);
        assert_lifecycle_is_empty(&model);
    }

    #[test]
    fn generated_native_labels_never_derive_capabilities_from_panel_ids_or_urls() {
        let mut model = LifecycleModel::default();
        let mut main_panel = descriptor("main", true);
        main_panel.url = "https://web-panel-native-1.example/news".to_string();
        model.insert(main_panel, true, None).unwrap();

        let request = model.take_loads().pop().unwrap();
        assert_eq!(request.panel_id, "main");
        assert_eq!(request.native_label, "web-panel-native-1");
        assert_ne!(request.native_label, request.panel_id);
        assert_ne!(request.native_label, "main");
        assert!(!request.native_label.contains("https"));
        assert!(model.finish(&request.native_label, true));
        assert_eq!(model.clear(), vec![request.native_label]);
        assert_lifecycle_is_empty(&model);
    }

    #[test]
    fn retained_orphan_views_consume_capacity_without_double_counting_active_views() {
        let active = ["loading-a".to_string(), "loading-b".to_string()]
            .into_iter()
            .collect::<HashSet<_>>();
        // loading-a is already materialized and therefore appears in both
        // collections. The union still represents exactly six native views.
        let views = [
            "loading-a",
            "ready-a",
            "ready-b",
            "ready-c",
            "orphan-after-close-error",
        ]
        .map(str::to_string)
        .to_vec();
        assert_eq!(remaining_native_capacity(active.iter(), views.iter()), 0);

        let without_orphan = &views[..4];
        assert_eq!(
            remaining_native_capacity(active.iter(), without_orphan.iter()),
            1
        );
    }

    #[test]
    fn browsing_data_clear_never_reports_success_without_a_live_publication_view() {
        let controller = WebPanelController::new(PathBuf::from("unused-test-publication-profile"));
        assert_eq!(
            controller.clear_browsing_data().unwrap_err(),
            WebPanelError::NativeOperation
        );
        // The small generic boundary is also exercised with a value so the
        // failure policy cannot accidentally reject a real owned view.
        assert_eq!(require_live_publication_view(Some(7_u8)).unwrap(), 7);
    }

    #[test]
    fn descriptor_batch_is_validated_before_mutating_lifecycle() {
        let mut model = LifecycleModel::default();
        model
            .reconcile(vec![descriptor("kept", true)], None, None)
            .unwrap();
        let before = model.snapshots();

        assert_eq!(
            model
                .reconcile(
                    vec![
                        descriptor("duplicate", true),
                        descriptor("duplicate", false)
                    ],
                    None,
                    None,
                )
                .unwrap_err(),
            WebPanelError::DuplicatePanel
        );
        assert_eq!(model.snapshots(), before);

        let too_many = (0..=MAX_WEB_PANELS)
            .map(|index| descriptor(&format!("panel-{index}"), true))
            .collect();
        assert_eq!(
            model.reconcile(too_many, None, None).unwrap_err(),
            WebPanelError::TooManyPanels
        );
        assert_eq!(model.snapshots(), before);
    }

    #[test]
    fn bounds_are_finite_non_negative_and_clipped_to_the_window() {
        let clipped = validate_bounds(
            WebPanelBounds {
                x: -10.4,
                y: 90.2,
                width: 200.0,
                height: 100.0,
            },
            Some((120.0, 100.0)),
        )
        .unwrap();
        assert_eq!(
            clipped,
            WebPanelBounds {
                x: 0.0,
                y: 90.0,
                width: 120.0,
                height: 10.0,
            }
        );
        assert_eq!(
            validate_bounds(
                WebPanelBounds {
                    x: f64::NAN,
                    y: 0.0,
                    width: 1.0,
                    height: 1.0,
                },
                None,
            )
            .unwrap_err(),
            WebPanelError::InvalidBounds
        );
    }

    #[test]
    fn public_security_coverage_keeps_unsupported_gates_explicit() {
        let serialized = serde_json::to_value(NATIVE_WEB_PANEL_SECURITY_COVERAGE).unwrap();
        assert_eq!(
            serialized,
            serde_json::json!({
                "navigationFailClosed": true,
                "popupsBlocked": true,
                "downloadsBlocked": true,
                "publicationDataStoreSeparated": true,
                "genericPermissionsBlocked": false,
                "httpAuthChallengesBlocked": false,
                "serviceWorkersStoppedOnDestroy": false,
            })
        );
    }
}
