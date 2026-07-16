use crate::{
    database::DatabaseActor,
    error::ApiError,
    http_cache::HttpCacheActor,
    model::{
        BootstrapResponse, MutationResult, SearchStatus, SourceStatus, StateChange,
        StateStreamMessage,
    },
    network::FeedTransport,
    refresh_worker::{spawn_refresh_worker, RefreshWorkerHandle},
    search::SearchIndexActor,
    search_sync::SearchSynchronizer,
    snapshot::StartupSnapshotStore,
    web_panels::WebPanelController,
};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::ipc::Channel;
use tokio::sync::{mpsc, Mutex as AsyncMutex};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const MAX_ACTIVE_FEED_PROBES: usize = 32;
const STATE_STREAM_QUEUE_CAPACITY: usize = 32;

type StateStreamSink = Arc<dyn Fn(StateStreamMessage) -> Result<(), ()> + Send + Sync>;

#[derive(Clone)]
pub(crate) struct StateStream {
    session_id: Uuid,
    inner: Arc<Mutex<StateStreamState>>,
    delivery: mpsc::Sender<QueuedStateMessage>,
    cancellation: CancellationToken,
}

struct StateStreamState {
    generation: u64,
    subscriber: Option<StateStreamSubscriber>,
    pending_resync: Option<PendingResync>,
}

#[derive(Clone)]
struct StateStreamSubscriber {
    generation: u64,
    expected_revision: u64,
    sink: StateStreamSink,
}

struct PendingResync {
    generation: u64,
    sink: StateStreamSink,
    message: StateStreamMessage,
}

struct QueuedStateMessage {
    generation: u64,
    sink: StateStreamSink,
    message: StateStreamMessage,
}

impl StateStream {
    pub(crate) fn new(session_id: Uuid) -> Self {
        Self::with_capacity(session_id, STATE_STREAM_QUEUE_CAPACITY)
    }

    fn with_capacity(session_id: Uuid, capacity: usize) -> Self {
        let (delivery, receiver) = mpsc::channel(capacity.max(1));
        let inner = Arc::new(Mutex::new(StateStreamState {
            generation: 0,
            subscriber: None,
            pending_resync: None,
        }));
        let cancellation = CancellationToken::new();
        tauri::async_runtime::spawn(run_state_stream(
            Arc::clone(&inner),
            receiver,
            cancellation.clone(),
        ));
        Self {
            session_id,
            inner,
            delivery,
            cancellation,
        }
    }

    pub(crate) fn replace_subscriber(&self, channel: Channel<StateStreamMessage>, revision: u64) {
        self.replace_sink(
            Arc::new(move |message| channel.send(message).map_err(|_| ())),
            revision,
        );
    }

    fn replace_sink(&self, sink: StateStreamSink, revision: u64) {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        inner.generation = inner.generation.wrapping_add(1).max(1);
        let generation = inner.generation;
        inner.pending_resync = None;
        inner.subscriber = Some(StateStreamSubscriber {
            generation,
            expected_revision: revision,
            sink,
        });
    }

    pub(crate) fn publish(&self, message: StateStreamMessage) {
        let queued = {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let Some(subscriber) = inner.subscriber.as_mut() else {
                return;
            };

            if let StateStreamMessage::Patch { patch } = &message {
                if patch.session_id != self.session_id {
                    let revision = subscriber.expected_revision.max(patch.revision);
                    self.invalidate_locked(&mut inner, revision, "sessionChanged");
                    drop(inner);
                    self.wake_delivery();
                    return;
                }
                if patch.revision <= subscriber.expected_revision {
                    // A retry of an already enqueued operation is idempotent.
                    return;
                }
                if patch.base_revision != subscriber.expected_revision
                    || patch.revision != patch.base_revision.saturating_add(1)
                {
                    let revision = subscriber.expected_revision.max(patch.revision);
                    self.invalidate_locked(&mut inner, revision, "revisionGap");
                    drop(inner);
                    self.wake_delivery();
                    return;
                }
                subscriber.expected_revision = patch.revision;
            }

            QueuedStateMessage {
                generation: subscriber.generation,
                sink: Arc::clone(&subscriber.sink),
                message,
            }
        };

        match self.delivery.try_send(queued) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(queued)) => {
                let mut inner = self
                    .inner
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if inner
                    .subscriber
                    .as_ref()
                    .is_some_and(|subscriber| subscriber.generation == queued.generation)
                {
                    let revision = inner
                        .subscriber
                        .as_ref()
                        .map_or(0, |subscriber| subscriber.expected_revision);
                    self.invalidate_locked(&mut inner, revision, "clientSlow");
                }
                drop(inner);
                self.wake_delivery();
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                self.cancellation.cancel();
                self.inner
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .subscriber = None;
            }
        }
    }

    fn invalidate_locked(
        &self,
        inner: &mut StateStreamState,
        current_revision: u64,
        reason: &'static str,
    ) {
        let Some(subscriber) = inner.subscriber.take() else {
            return;
        };
        inner.pending_resync = Some(PendingResync {
            generation: subscriber.generation,
            sink: subscriber.sink,
            message: StateStreamMessage::ResyncRequired {
                session_id: self.session_id,
                current_revision,
                reason: reason.to_owned(),
            },
        });
    }

    fn wake_delivery(&self) {
        // A full queue already guarantees that the worker will wake. A closed
        // queue means runtime shutdown; neither case may block a mutation.
        let inert_sink: StateStreamSink = Arc::new(|_| Ok(()));
        let _ = self.delivery.try_send(QueuedStateMessage {
            generation: 0,
            sink: inert_sink,
            message: StateStreamMessage::SearchStatus {
                status: SearchStatus {
                    lexical_ready: false,
                    semantic_ready: false,
                },
            },
        });
    }

    pub(crate) fn shutdown(&self) {
        self.cancellation.cancel();
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        inner.subscriber = None;
        inner.pending_resync = None;
    }
}

async fn run_state_stream(
    inner: Arc<Mutex<StateStreamState>>,
    mut receiver: mpsc::Receiver<QueuedStateMessage>,
    cancellation: CancellationToken,
) {
    loop {
        let pending_resync = {
            inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .pending_resync
                .take()
        };
        if let Some(pending) = pending_resync {
            let still_current = inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .generation
                == pending.generation;
            if still_current {
                let sink = pending.sink;
                let message = pending.message;
                let _ = cancellation
                    .run_until_cancelled(tauri::async_runtime::spawn_blocking(move || {
                        sink(message)
                    }))
                    .await;
            }
            continue;
        }

        let queued = match cancellation.run_until_cancelled(receiver.recv()).await {
            Some(Some(queued)) => queued,
            Some(None) | None => return,
        };
        let is_current = inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .subscriber
            .as_ref()
            .is_some_and(|subscriber| subscriber.generation == queued.generation);
        if !is_current {
            continue;
        }
        let generation = queued.generation;
        let sink = queued.sink;
        let message = queued.message;
        let delivered = cancellation
            .run_until_cancelled(tauri::async_runtime::spawn_blocking(move || sink(message)))
            .await;
        if !matches!(delivered, Some(Ok(Ok(())))) {
            let mut inner = inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if inner
                .subscriber
                .as_ref()
                .is_some_and(|subscriber| subscriber.generation == generation)
            {
                inner.subscriber = None;
            }
        }
    }
}

/// Main-process-only registry for cancellable feed probes. Probe identifiers
/// cross IPC as UUIDs, so their accepted representation is fixed-size and
/// cannot grow this map with attacker-controlled strings.
#[derive(Clone)]
pub(crate) struct FeedProbeRegistry {
    inner: Arc<Mutex<HashMap<Uuid, CancellationToken>>>,
    max_active: usize,
}

impl Default for FeedProbeRegistry {
    fn default() -> Self {
        Self::with_limit(MAX_ACTIVE_FEED_PROBES)
    }
}

impl FeedProbeRegistry {
    fn with_limit(max_active: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
            max_active,
        }
    }

    pub(crate) fn register(&self, probe_id: Uuid) -> Result<RegisteredFeedProbe, ApiError> {
        if probe_id.is_nil() {
            return Err(ApiError::invalid("L'identifiant de probe est invalide."));
        }

        let mut active = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if active.contains_key(&probe_id) {
            return Err(ApiError::invalid(
                "Une probe portant cet identifiant est déjà active.",
            ));
        }
        if active.len() >= self.max_active {
            return Err(ApiError::busy());
        }

        let cancellation = CancellationToken::new();
        active.insert(probe_id, cancellation.clone());
        Ok(RegisteredFeedProbe {
            probe_id,
            cancellation,
            registry: self.clone(),
        })
    }

    /// Cancelling an unknown or already completed probe is deliberately a
    /// no-op, which makes renderer retries safe and avoids leaking registry
    /// contents across IPC.
    pub(crate) fn cancel(&self, probe_id: Uuid) -> Result<(), ApiError> {
        if probe_id.is_nil() {
            return Err(ApiError::invalid("L'identifiant de probe est invalide."));
        }
        let cancellation = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&probe_id)
            .cloned();
        if let Some(cancellation) = cancellation {
            cancellation.cancel();
        }
        Ok(())
    }

    fn cancel_all(&self) {
        let active = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for cancellation in active {
            cancellation.cancel();
        }
    }

    fn unregister(&self, probe_id: Uuid) {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&probe_id);
    }

    #[cfg(test)]
    fn active_count(&self) -> usize {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .len()
    }
}

pub(crate) struct RegisteredFeedProbe {
    probe_id: Uuid,
    cancellation: CancellationToken,
    registry: FeedProbeRegistry,
}

impl RegisteredFeedProbe {
    pub(crate) fn cancellation_token(&self) -> CancellationToken {
        self.cancellation.clone()
    }
}

impl Drop for RegisteredFeedProbe {
    fn drop(&mut self) {
        // A command future can be dropped before `FeedTransport::probe`
        // returns (window close, runtime shutdown). Signal any blocking parser
        // task before releasing the identifier from the registry.
        self.cancellation.cancel();
        self.registry.unregister(self.probe_id);
    }
}

pub struct RuntimeState {
    pub session_id: Uuid,
    pub database: DatabaseActor,
    pub snapshot_store: StartupSnapshotStore,
    pub snapshot: Arc<Mutex<Option<BootstrapResponse>>>,
    pub snapshot_write: Arc<AsyncMutex<()>>,
    pub state_stream: StateStream,
    pub transition_order: Arc<AsyncMutex<()>>,
    pub network: FeedTransport,
    pub http_cache: HttpCacheActor,
    pub feed_probes: FeedProbeRegistry,
    pub search: SearchIndexActor,
    pub search_sync: SearchSynchronizer,
    pub web_panels: WebPanelController,
    pub refresh_worker: Mutex<Option<RefreshWorkerHandle>>,
    pub shutdown_started: AtomicBool,
}

impl RuntimeState {
    pub fn search_status(&self) -> SearchStatus {
        SearchStatus {
            lexical_ready: self.search_sync.is_ready(),
            semantic_ready: false,
        }
    }

    /// Starts background I/O only after authoritative bootstrap has been
    /// requested. The scheduler itself is event-driven and sleeps on the next
    /// persisted deadline; calling this method repeatedly is idempotent.
    pub fn ensure_refresh_worker_started(&self) {
        if self.shutdown_started.load(Ordering::Acquire) {
            return;
        }
        let mut worker = self
            .refresh_worker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if worker.is_some() {
            return;
        }

        let state_stream = self.state_stream.clone();
        let database = self.database.clone();
        let snapshot_store = self.snapshot_store.clone();
        let snapshot_cache = Arc::clone(&self.snapshot);
        let snapshot_write = Arc::clone(&self.snapshot_write);
        let search_sync = self.search_sync.clone();
        let session_id = self.session_id;
        let publish = Arc::new(move |result: MutationResult| {
            let committed_revision = result.ack.committed_revision;
            let Some(patch) = result.patch else {
                return;
            };
            let ingestion_source_id = ingestion_source_id(&patch.changes);
            *snapshot_cache
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
            state_stream.publish(StateStreamMessage::Patch {
                patch: patch.clone(),
            });
            if let Some(source_id) = ingestion_source_id {
                search_sync.after_ingestion(source_id, Some(&patch));
            }
            schedule_snapshot_refresh(
                database.clone(),
                session_id,
                committed_revision,
                snapshot_store.clone(),
                Arc::clone(&snapshot_cache),
                Arc::clone(&snapshot_write),
            );
        });
        *worker = Some(spawn_refresh_worker(
            self.database.clone(),
            self.network.clone(),
            self.http_cache.clone(),
            self.session_id,
            publish,
            Arc::clone(&self.transition_order),
        ));
    }

    pub fn notify_refresh_schedule_changed(&self) {
        if let Some(worker) = self
            .refresh_worker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
        {
            worker.notify_schedule_changed();
        }
    }

    pub async fn shutdown(&self) {
        if self.shutdown_started.swap(true, Ordering::AcqRel) {
            return;
        }
        self.feed_probes.cancel_all();
        let worker = self
            .refresh_worker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(worker) = worker {
            worker.shutdown().await;
        }
        // Refresh shutdown itself needs this gate to publish final failures, so
        // acquire it only after the worker has drained. From here through the
        // SQLite join, no renderer mutation or snapshot scheduling can start.
        let _transition = self.transition_order.lock().await;
        self.http_cache.shutdown().await;
        self.search_sync.shutdown();
        self.search.shutdown().await;
        self.state_stream.shutdown();
        let _ = self.web_panels.destroy_all();
        // Wait for the last already-scheduled atomic startup projection write.
        {
            let _snapshot_write = self.snapshot_write.lock().await;
        }
        // Every producer and derived reader is stopped before SQLite channels
        // close. Joining runs on the blocking pool, never on the UI thread.
        self.database.shutdown().await;
    }

    pub fn replace_subscriber(&self, channel: Channel<StateStreamMessage>, revision: u64) {
        self.state_stream.replace_subscriber(channel, revision);
    }

    pub fn publish(&self, message: StateStreamMessage) {
        self.state_stream.publish(message);
    }

    pub fn cached_bootstrap(&self, revision: u64) -> Option<BootstrapResponse> {
        self.snapshot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .filter(|snapshot| snapshot.revision == revision)
            .cloned()
            .map(|mut snapshot| {
                snapshot.session_id = self.session_id;
                snapshot
            })
    }

    /// Returns only the already checksummed startup projection. It never sends
    /// a database command, so migrations cannot delay the renderer's first
    /// useful paint.
    pub fn startup_snapshot(&self) -> Option<BootstrapResponse> {
        self.snapshot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .cloned()
            .map(|mut snapshot| {
                snapshot.session_id = self.session_id;
                snapshot
            })
    }

    /// Updates the in-memory startup projection synchronously, then persists it
    /// off the command path. Snapshot writes are serialized and re-check their
    /// revision after acquiring the lock, so an older bootstrap can never
    /// overwrite a projection already refreshed by a newer commit.
    pub fn cache_and_persist_bootstrap(&self, bootstrap: BootstrapResponse) {
        let should_persist = {
            let mut cached = self
                .snapshot
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if cached
                .as_ref()
                .is_some_and(|current| current.revision > bootstrap.revision)
            {
                false
            } else {
                *cached = Some(bootstrap.clone());
                true
            }
        };
        if !should_persist {
            return;
        }

        let snapshot_store = self.snapshot_store.clone();
        let snapshot_cache = Arc::clone(&self.snapshot);
        let snapshot_write = Arc::clone(&self.snapshot_write);
        tauri::async_runtime::spawn(async move {
            let _guard = snapshot_write.lock().await;
            let is_current = snapshot_cache
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .as_ref()
                .is_some_and(|current| current.revision == bootstrap.revision);
            if !is_current {
                return;
            }
            let _ = tauri::async_runtime::spawn_blocking(move || {
                // The database remains authoritative. A derived snapshot write
                // failure is intentionally non-fatal.
                let _ = snapshot_store.save(&bootstrap);
            })
            .await;
        });
    }

    /// Rebuilds the bounded startup projection after a successful commit. The
    /// mutation acknowledgement and ordered patch are not delayed by SQLite or
    /// filesystem work performed solely for this derived cache.
    pub fn refresh_snapshot_after_commit(&self, committed_revision: u64) {
        schedule_snapshot_refresh(
            self.database.clone(),
            self.session_id,
            committed_revision,
            self.snapshot_store.clone(),
            Arc::clone(&self.snapshot),
            Arc::clone(&self.snapshot_write),
        );
    }

    pub fn invalidate_bootstrap(&self) {
        *self
            .snapshot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }
}

fn ingestion_source_id(changes: &[StateChange]) -> Option<Uuid> {
    let materialized_items = changes.iter().any(|change| {
        matches!(
            change,
            StateChange::ItemsUpsert { .. } | StateChange::PanelInvalidated { .. }
        )
    });
    if !materialized_items {
        return None;
    }
    changes.iter().find_map(|change| match change {
        StateChange::SourceUpsert { source } if source.status == SourceStatus::Healthy => {
            Some(source.id)
        }
        _ => None,
    })
}

fn schedule_snapshot_refresh(
    database: DatabaseActor,
    session_id: Uuid,
    committed_revision: u64,
    snapshot_store: StartupSnapshotStore,
    snapshot_cache: Arc<Mutex<Option<BootstrapResponse>>>,
    snapshot_write: Arc<AsyncMutex<()>>,
) {
    tauri::async_runtime::spawn(async move {
        let _guard = snapshot_write.lock().await;
        let Ok(bootstrap) = database.bootstrap(session_id).await else {
            return;
        };
        if bootstrap.revision != committed_revision {
            // A later mutation won the race. Its own refresh is the only
            // projection allowed to persist the newer authoritative state.
            return;
        }
        {
            let mut cached = snapshot_cache
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if cached
                .as_ref()
                .is_some_and(|current| current.revision > bootstrap.revision)
            {
                return;
            }
            *cached = Some(bootstrap.clone());
        }
        let _ = tauri::async_runtime::spawn_blocking(move || {
            let _ = snapshot_store.save(&bootstrap);
        })
        .await;
    });
}

pub fn ensure_local_main(webview: &tauri::Webview) -> Result<(), ApiError> {
    if webview.label() == "main" && webview.window().label() == "main" {
        Ok(())
    } else {
        Err(ApiError::forbidden())
    }
}

#[cfg(test)]
mod feed_probe_registry_tests {
    use super::*;
    use crate::model::{ConnectorKind, Source, StatePatch};
    use std::{
        sync::{
            atomic::{AtomicBool, Ordering as AtomicOrdering},
            mpsc as std_mpsc,
        },
        time::Duration,
    };
    use tokio::sync::Notify;

    fn patch(session_id: Uuid, base_revision: u64) -> StateStreamMessage {
        StateStreamMessage::Patch {
            patch: StatePatch {
                session_id,
                base_revision,
                revision: base_revision + 1,
                operation_id: Uuid::new_v4(),
                changes: Vec::new(),
            },
        }
    }

    fn collecting_sink() -> (
        StateStreamSink,
        Arc<Mutex<Vec<StateStreamMessage>>>,
        Arc<Notify>,
    ) {
        let messages = Arc::new(Mutex::new(Vec::new()));
        let notify = Arc::new(Notify::new());
        let sink_messages = Arc::clone(&messages);
        let sink_notify = Arc::clone(&notify);
        let sink = Arc::new(move |message| {
            sink_messages
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(message);
            sink_notify.notify_waiters();
            Ok(())
        });
        (sink, messages, notify)
    }

    async fn wait_for_messages(
        messages: &Arc<Mutex<Vec<StateStreamMessage>>>,
        notify: &Notify,
        expected: usize,
    ) {
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let notified = notify.notified();
                if messages
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .len()
                    >= expected
                {
                    return;
                }
                notified.await;
            }
        })
        .await
        .expect("state stream should deliver without blocking");
    }

    fn source_change(status: SourceStatus) -> StateChange {
        StateChange::SourceUpsert {
            source: Source {
                id: Uuid::new_v4(),
                name: "Source test".to_owned(),
                input_url: "https://example.test/".to_owned(),
                feed_url: "https://example.test/feed.xml".to_owned(),
                connector_id: None,
                connector_kind: ConnectorKind::Rss,
                refresh_interval_seconds: 60,
                status,
                last_checked_at: None,
                last_success_at: None,
                error_message: None,
                baseline_completed_at: None,
                consecutive_failures: 0,
                next_retry_at: None,
                due_at_ms: 0,
                item_count: 0,
            },
        }
    }

    #[test]
    fn only_materialized_successes_trigger_targeted_search_sync() {
        let healthy = source_change(SourceStatus::Healthy);
        let healthy_id = match &healthy {
            StateChange::SourceUpsert { source } => source.id,
            _ => unreachable!(),
        };
        assert_eq!(
            ingestion_source_id(&[
                healthy.clone(),
                StateChange::PanelInvalidated {
                    panel_id: Uuid::new_v4(),
                    reason: "arrivées".to_owned(),
                },
            ]),
            Some(healthy_id)
        );
        assert_eq!(ingestion_source_id(&[healthy]), None);
        assert_eq!(
            ingestion_source_id(&[
                source_change(SourceStatus::Error),
                StateChange::PanelInvalidated {
                    panel_id: Uuid::new_v4(),
                    reason: "échec".to_owned(),
                },
            ]),
            None
        );
    }

    #[test]
    fn registry_rejects_nil_duplicates_and_capacity_overflow() {
        let registry = FeedProbeRegistry::with_limit(2);
        assert_eq!(
            registry.register(Uuid::nil()).err().unwrap().code,
            "invalid_request"
        );

        let first_id = Uuid::new_v4();
        let second_id = Uuid::new_v4();
        let first = registry.register(first_id).unwrap();
        assert_eq!(
            registry.register(first_id).err().unwrap().code,
            "invalid_request"
        );
        let second = registry.register(second_id).unwrap();
        assert_eq!(
            registry.register(Uuid::new_v4()).err().unwrap().code,
            "service_busy"
        );
        assert_eq!(registry.active_count(), 2);

        drop((first, second));
        assert_eq!(registry.active_count(), 0);
    }

    #[test]
    fn cancel_is_idempotent_and_drop_releases_the_exact_slot() {
        let registry = FeedProbeRegistry::with_limit(1);
        let probe_id = Uuid::new_v4();
        let registered = registry.register(probe_id).unwrap();
        let cancellation = registered.cancellation_token();

        registry.cancel(probe_id).unwrap();
        registry.cancel(probe_id).unwrap();
        registry.cancel(Uuid::new_v4()).unwrap();
        assert_eq!(
            registry.cancel(Uuid::nil()).unwrap_err().code,
            "invalid_request"
        );
        assert!(cancellation.is_cancelled());
        assert_eq!(registry.active_count(), 1);

        drop(registered);
        assert_eq!(registry.active_count(), 0);

        let replacement = registry.register(probe_id).unwrap();
        let replacement_cancellation = replacement.cancellation_token();
        drop(replacement);
        assert!(replacement_cancellation.is_cancelled());
        assert_eq!(registry.active_count(), 0);
    }

    #[test]
    fn uuid_probe_ids_are_strict_and_fixed_size_at_the_ipc_boundary() {
        assert!(serde_json::from_str::<Uuid>("\"not-a-probe-id\"").is_err());
        assert!(serde_json::from_str::<Uuid>(&format!("\"{}\"", "a".repeat(4_096))).is_err());

        let probe_id = Uuid::new_v4();
        assert_eq!(
            serde_json::from_str::<Uuid>(&format!("\"{probe_id}\"")).unwrap(),
            probe_id
        );
    }

    #[test]
    fn state_stream_ignores_duplicate_patches_and_delivers_revision_order() {
        tauri::async_runtime::block_on(async {
            let session_id = Uuid::new_v4();
            let stream = StateStream::with_capacity(session_id, 4);
            let (sink, messages, notify) = collecting_sink();
            stream.replace_sink(sink, 10);

            let next = patch(session_id, 10);
            stream.publish(next.clone());
            stream.publish(next);
            stream.publish(patch(session_id, 11));

            wait_for_messages(&messages, &notify, 2).await;
            let delivered = messages
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let revisions = delivered
                .iter()
                .filter_map(|message| match message {
                    StateStreamMessage::Patch { patch } => Some(patch.revision),
                    _ => None,
                })
                .collect::<Vec<_>>();
            assert_eq!(revisions, vec![11, 12]);
            drop(delivered);
            stream.shutdown();
        });
    }

    #[test]
    fn state_stream_turns_a_lost_or_out_of_order_patch_into_resync() {
        tauri::async_runtime::block_on(async {
            let session_id = Uuid::new_v4();
            let stream = StateStream::with_capacity(session_id, 4);
            let (sink, messages, notify) = collecting_sink();
            stream.replace_sink(sink, 4);

            stream.publish(patch(session_id, 5));

            wait_for_messages(&messages, &notify, 1).await;
            let delivered = messages
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            assert!(matches!(
                delivered.as_slice(),
                [StateStreamMessage::ResyncRequired {
                    session_id: delivered_session,
                    current_revision: 6,
                    reason,
                }] if *delivered_session == session_id && reason == "revisionGap"
            ));
            drop(delivered);
            stream.shutdown();
        });
    }

    #[test]
    fn state_stream_rejects_a_patch_from_another_session() {
        tauri::async_runtime::block_on(async {
            let session_id = Uuid::new_v4();
            let stream = StateStream::with_capacity(session_id, 4);
            let (sink, messages, notify) = collecting_sink();
            stream.replace_sink(sink, 7);

            stream.publish(patch(Uuid::new_v4(), 7));

            wait_for_messages(&messages, &notify, 1).await;
            let delivered = messages
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            assert!(matches!(
                delivered.as_slice(),
                [StateStreamMessage::ResyncRequired {
                    session_id: delivered_session,
                    current_revision: 8,
                    reason,
                }] if *delivered_session == session_id && reason == "sessionChanged"
            ));
            drop(delivered);
            stream.shutdown();
        });
    }

    #[test]
    fn state_stream_bounds_a_slow_subscriber_and_never_blocks_publishers() {
        tauri::async_runtime::block_on(async {
            let session_id = Uuid::new_v4();
            let stream = StateStream::with_capacity(session_id, 2);
            let messages = Arc::new(Mutex::new(Vec::new()));
            let notify = Arc::new(Notify::new());
            let first_send = Arc::new(AtomicBool::new(true));
            let (entered_sender, entered_receiver) = std_mpsc::sync_channel(1);
            let (release_sender, release_receiver) = std_mpsc::sync_channel(1);
            let release_receiver = Arc::new(Mutex::new(release_receiver));
            let sink_messages = Arc::clone(&messages);
            let sink_notify = Arc::clone(&notify);
            let sink_first_send = Arc::clone(&first_send);
            let sink_release = Arc::clone(&release_receiver);
            stream.replace_sink(
                Arc::new(move |message| {
                    if sink_first_send.swap(false, AtomicOrdering::AcqRel) {
                        let _ = entered_sender.send(());
                        let _ = sink_release
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .recv();
                    }
                    sink_messages
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .push(message);
                    sink_notify.notify_waiters();
                    Ok(())
                }),
                0,
            );

            stream.publish(patch(session_id, 0));
            entered_receiver
                .recv_timeout(Duration::from_secs(1))
                .expect("first delivery should enter the slow sink");
            stream.publish(patch(session_id, 1));
            stream.publish(patch(session_id, 2));
            let started = std::time::Instant::now();
            stream.publish(patch(session_id, 3));
            assert!(started.elapsed() < Duration::from_millis(50));
            release_sender.send(()).unwrap();

            wait_for_messages(&messages, &notify, 2).await;
            let delivered = messages
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            assert!(matches!(
                delivered.last(),
                Some(StateStreamMessage::ResyncRequired {
                    session_id: delivered_session,
                    current_revision: 4,
                    reason,
                }) if *delivered_session == session_id && reason == "clientSlow"
            ));
            assert_eq!(
                delivered
                    .iter()
                    .filter(|message| matches!(message, StateStreamMessage::Patch { .. }))
                    .count(),
                1
            );
            drop(delivered);
            stream.shutdown();
        });
    }
}
