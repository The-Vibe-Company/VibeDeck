use crate::{
    error::ApiError,
    model::{
        BootstrapResponse, FeedConfigurationCustomSource, FeedItem, FeedPage, FeedPageRequest,
        GenericSourceInput, MutateRequest, MutationAck, MutationCommand,
        SaveFeedPanelConfigurationRequest, SearchMode, SearchRequest, SearchResult, SearchStatus,
        StateStreamMessage, MAX_SEARCH_RESULTS,
    },
    network::{normalize_feed_url, FeedProbeRequest, FeedProbeResponse},
    runtime::{ensure_local_main, RuntimeState},
    search::normalize_search_query,
    web_panels::{
        parse_allowed_url, NativeWebPanelSecurityCoverage, WebPanelBounds, WebPanelDescriptor,
        WebPanelError, WebPanelSnapshot, WebPanelStateSink, WebPanelViewState,
        NATIVE_WEB_PANEL_SECURITY_COVERAGE,
    },
};
use futures_util::{stream, StreamExt, TryStreamExt};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};
use tauri::{ipc::Channel, State, Webview};
use tokio_util::sync::CancellationToken;

const MAX_FEED_CONFIGURATION_SOURCES: usize = 256;
const FEED_CONFIGURATION_PROBE_CONCURRENCY: usize = 6;

#[derive(Debug)]
struct ValidatedFeedPanelConfiguration {
    name: String,
    default_refresh_interval_seconds: u32,
    kept_source_ids: Vec<uuid::Uuid>,
    custom_sources: Vec<FeedConfigurationCustomSource>,
}

#[tauri::command]
pub fn startup_snapshot(
    webview: Webview,
    state: State<'_, RuntimeState>,
) -> Result<Option<BootstrapResponse>, ApiError> {
    ensure_local_main(&webview)?;
    Ok(state.startup_snapshot())
}

#[tauri::command]
pub async fn bootstrap(
    webview: Webview,
    channel: Channel<StateStreamMessage>,
    state: State<'_, RuntimeState>,
) -> Result<BootstrapResponse, ApiError> {
    ensure_local_main(&webview)?;
    let bootstrap = {
        // Installing the subscriber and establishing its base revision is
        // atomic with respect to every writer transition. No committed patch
        // can fall between the bootstrap read and the new stream generation.
        let _transition = state.transition_order.lock().await;
        // The revision query is constant-time. When it matches the checksummed
        // startup projection, no item query or global serialization occurs.
        let revision = state.database.revision().await?;
        let bootstrap = if let Some(cached) = state.cached_bootstrap(revision) {
            cached
        } else {
            let bootstrap = state.database.bootstrap(state.session_id).await?;
            state.cache_and_persist_bootstrap(bootstrap.clone());
            bootstrap
        };
        state.replace_subscriber(channel, bootstrap.revision);
        bootstrap
    };
    // Queue the first derived-index scan only after the renderer has requested
    // authoritative bootstrap. This call is constant-time and never delays the
    // response or the already available startup snapshot paint.
    state.search_sync.schedule_initial_sync();
    state.ensure_refresh_worker_started();
    Ok(bootstrap)
}

#[tauri::command]
pub async fn get_feed_page(
    webview: Webview,
    request: FeedPageRequest,
    state: State<'_, RuntimeState>,
) -> Result<FeedPage, ApiError> {
    ensure_local_main(&webview)?;
    state.database.feed_page(request).await
}

#[tauri::command]
pub async fn get_item(
    webview: Webview,
    item_id: uuid::Uuid,
    state: State<'_, RuntimeState>,
) -> Result<FeedItem, ApiError> {
    ensure_local_main(&webview)?;
    state.database.get_item(item_id).await
}

#[tauri::command]
pub async fn search(
    webview: Webview,
    request: SearchRequest,
    state: State<'_, RuntimeState>,
) -> Result<Vec<SearchResult>, ApiError> {
    ensure_local_main(&webview)?;
    normalize_search_query(&request.query)?;
    if request.mode != SearchMode::Lexical {
        return Err(ApiError::unavailable(
            "de recherche sémantique (modèle local non chargé)",
        ));
    }
    if request.limit == 0 || request.limit > MAX_SEARCH_RESULTS {
        return Err(ApiError::invalid(format!(
            "La recherche doit demander entre 1 et {MAX_SEARCH_RESULTS} résultats."
        )));
    }
    if !state.search_sync.is_ready() {
        state.search_sync.schedule_initial_sync();
        return Err(ApiError::unavailable(
            "de recherche (indexation initiale en cours)",
        ));
    }
    let hits = state.search.search(request).await?;
    let hydration = state.database.hydrate_search_hits(hits).await?;
    if !hydration.missing_item_ids.is_empty() {
        state
            .search_sync
            .remove_stale_items(hydration.missing_item_ids);
    }
    Ok(hydration.results)
}

#[tauri::command]
pub fn get_search_status(
    webview: Webview,
    state: State<'_, RuntimeState>,
) -> Result<SearchStatus, ApiError> {
    ensure_local_main(&webview)?;
    state.search_sync.schedule_initial_sync();
    Ok(state.search_status())
}

#[tauri::command]
pub async fn mutate(
    webview: Webview,
    request: MutateRequest,
    state: State<'_, RuntimeState>,
) -> Result<MutationAck, ApiError> {
    ensure_local_main(&webview)?;
    let _transition = state.transition_order.lock().await;
    let search_command = request.command.clone();
    let result = state.database.mutate(state.session_id, request).await?;
    state
        .search_sync
        .after_mutation(&search_command, result.patch.as_ref());
    if let Some(patch) = result.patch {
        state.invalidate_bootstrap();
        state.publish(StateStreamMessage::Patch { patch });
        state.refresh_snapshot_after_commit(result.ack.committed_revision);
    }
    state.notify_refresh_schedule_changed();
    Ok(result.ack)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn save_feed_panel_configuration(
    webview: Webview,
    request: SaveFeedPanelConfigurationRequest,
    state: State<'_, RuntimeState>,
) -> Result<MutationAck, ApiError> {
    ensure_local_main(&webview)?;
    let SaveFeedPanelConfigurationRequest {
        operation_id,
        expected_revision,
        panel_id,
        draft,
    } = request;
    if operation_id.is_nil() || panel_id.is_nil() {
        return Err(ApiError::invalid(
            "Les identifiants de configuration sont invalides.",
        ));
    }
    let validated = validate_feed_panel_configuration(draft)?;
    if let Some(duplicate) = state
        .database
        .preflight_feed_panel_configuration(
            operation_id,
            expected_revision,
            panel_id,
            validated.kept_source_ids.clone(),
        )
        .await?
    {
        return Ok(duplicate);
    }

    // All network-dependent work completes before the authoritative writer is
    // entered. A failed probe therefore cannot expose a partial local edit.
    let registered = state.feed_probes.register(operation_id)?;
    let new_sources = prepare_configuration_sources(
        state.network.clone(),
        validated.custom_sources,
        validated.default_refresh_interval_seconds,
        registered.cancellation_token(),
    )
    .await?;
    drop(registered);
    let _transition = state.transition_order.lock().await;
    let result = state
        .database
        .mutate(
            state.session_id,
            MutateRequest {
                operation_id,
                expected_revision,
                command: MutationCommand::SaveFeedPanelConfiguration {
                    panel_id,
                    name: validated.name,
                    default_refresh_interval_seconds: validated.default_refresh_interval_seconds,
                    kept_source_ids: validated.kept_source_ids,
                    new_sources,
                },
            },
        )
        .await?;
    if let Some(patch) = result.patch {
        state.search_sync.reproject_panel(panel_id);
        state.invalidate_bootstrap();
        state.publish(StateStreamMessage::Patch { patch });
        state.refresh_snapshot_after_commit(result.ack.committed_revision);
    }
    state.notify_refresh_schedule_changed();
    Ok(result.ack)
}

fn validate_feed_panel_configuration(
    draft: crate::model::FeedPanelConfigurationDraft,
) -> Result<ValidatedFeedPanelConfiguration, ApiError> {
    let name = draft.name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(ApiError::invalid(
            "Le nom du panel doit contenir entre 1 et 80 caractères.",
        ));
    }
    if !(30..=3_600).contains(&draft.default_refresh_interval_seconds) {
        return Err(ApiError::invalid(
            "La fréquence doit être comprise entre 30 et 3 600 secondes.",
        ));
    }
    if draft.kept_source_ids.len() > MAX_FEED_CONFIGURATION_SOURCES
        || draft.selected_catalog_ids.len() > MAX_FEED_CONFIGURATION_SOURCES
        || draft.custom_sources.len() > MAX_FEED_CONFIGURATION_SOURCES
    {
        return Err(ApiError::invalid(format!(
            "Une configuration accepte au maximum {MAX_FEED_CONFIGURATION_SOURCES} sources par liste."
        )));
    }
    let mut kept_source_ids = HashSet::with_capacity(draft.kept_source_ids.len());
    if draft
        .kept_source_ids
        .iter()
        .any(|source_id| source_id.is_nil() || !kept_source_ids.insert(*source_id))
    {
        return Err(ApiError::invalid(
            "La liste ordonnée des sources conservées est invalide ou dupliquée.",
        ));
    }
    if !draft.selected_catalog_ids.is_empty() {
        return Err(ApiError::invalid(
            "Les sources du catalogue ne sont pas encore disponibles dans le runtime Tauri.",
        ));
    }

    let mut seen_custom_sources = HashSet::with_capacity(draft.custom_sources.len());
    let mut custom_sources = Vec::with_capacity(draft.custom_sources.len());
    for custom in draft.custom_sources {
        let url = normalize_feed_url(&custom.url)?.to_string();
        if seen_custom_sources.insert((url.clone(), custom.connector_kind)) {
            custom_sources.push(FeedConfigurationCustomSource {
                url,
                connector_kind: custom.connector_kind,
            });
        }
    }
    Ok(ValidatedFeedPanelConfiguration {
        name: name.to_owned(),
        default_refresh_interval_seconds: draft.default_refresh_interval_seconds,
        kept_source_ids: draft.kept_source_ids,
        custom_sources,
    })
}

async fn prepare_configuration_sources(
    network: crate::network::FeedTransport,
    custom_sources: Vec<FeedConfigurationCustomSource>,
    refresh_interval_seconds: u32,
    cancellation: CancellationToken,
) -> Result<Vec<GenericSourceInput>, ApiError> {
    let probes = stream::iter(custom_sources.into_iter().enumerate())
        .map(|(position, custom)| {
            let network = network.clone();
            let cancellation = cancellation.clone();
            async move {
                let response = network
                    .probe(
                        FeedProbeRequest {
                            url: custom.url.clone(),
                            connector_kind: custom.connector_kind.connector_kind(),
                        },
                        cancellation,
                    )
                    .await?;
                let final_url = normalize_feed_url(&response.final_url)?;
                let fallback_name = final_url
                    .host_str()
                    .unwrap_or("Source")
                    .trim_start_matches("www.");
                let raw_name = response
                    .title
                    .as_deref()
                    .map(str::trim)
                    .filter(|title| !title.is_empty())
                    .unwrap_or(fallback_name);
                let name = raw_name.chars().take(120).collect::<String>();
                Ok::<_, ApiError>((
                    position,
                    GenericSourceInput {
                        name,
                        input_url: custom.url,
                        feed_url: final_url.to_string(),
                        connector_kind: response.connector_kind,
                        refresh_interval_seconds,
                    },
                ))
            }
        })
        .buffer_unordered(FEED_CONFIGURATION_PROBE_CONCURRENCY)
        .try_collect::<Vec<_>>()
        .await;
    let mut probes = match probes {
        Ok(probes) => probes,
        Err(error) => {
            cancellation.cancel();
            return Err(error);
        }
    };
    probes.sort_by_key(|(position, _)| *position);

    let mut connector_by_feed_url = HashMap::with_capacity(probes.len());
    let mut prepared = Vec::with_capacity(probes.len());
    for (_, source) in probes {
        if let Some(existing_kind) = connector_by_feed_url.get(&source.feed_url) {
            if *existing_kind != source.connector_kind {
                return Err(ApiError::invalid(
                    "Deux sources détectées partagent une URL avec des types incompatibles.",
                ));
            }
            continue;
        }
        connector_by_feed_url.insert(source.feed_url.clone(), source.connector_kind);
        prepared.push(source);
    }
    Ok(prepared)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn probe_feed(
    webview: Webview,
    probe_id: uuid::Uuid,
    request: FeedProbeRequest,
    state: State<'_, RuntimeState>,
) -> Result<FeedProbeResponse, ApiError> {
    ensure_local_main(&webview)?;
    let registered = state.feed_probes.register(probe_id)?;
    state
        .network
        .probe(request, registered.cancellation_token())
        .await
}

#[tauri::command(rename_all = "camelCase")]
pub fn cancel_feed_probe(
    webview: Webview,
    probe_id: uuid::Uuid,
    state: State<'_, RuntimeState>,
) -> Result<(), ApiError> {
    ensure_local_main(&webview)?;
    state.feed_probes.cancel(probe_id)
}

fn validated_external_url(raw_url: &str) -> Result<url::Url, ApiError> {
    parse_allowed_url(raw_url).map_err(web_panel_api_error)
}

fn launch_external_url(url: &url::Url) -> Result<(), ApiError> {
    crate::external_open::open(url)
        .then_some(())
        .ok_or_else(|| ApiError::internal("Le navigateur système n'a pas pu ouvrir cette page."))
}

#[tauri::command(rename_all = "camelCase")]
pub fn open_external_url(webview: Webview, url: String) -> Result<(), ApiError> {
    ensure_local_main(&webview)?;
    launch_external_url(&validated_external_url(&url)?)
}

#[tauri::command(rename_all = "camelCase")]
pub fn open_external_web_panel(
    webview: Webview,
    panel_id: String,
    state: State<'_, RuntimeState>,
) -> Result<(), ApiError> {
    ensure_local_main(&webview)?;
    let url = state
        .web_panels
        .current_url(&panel_id)
        .map_err(web_panel_api_error)?;
    launch_external_url(&url)
}

#[tauri::command(rename_all = "camelCase")]
pub fn subscribe_web_panel_states(
    webview: Webview,
    channel: Channel<WebPanelViewState>,
    state: State<'_, RuntimeState>,
) -> Result<(), ApiError> {
    ensure_local_main(&webview)?;
    let sink: WebPanelStateSink = Arc::new(move |message| channel.send(message).map_err(|_| ()));
    state
        .web_panels
        .replace_state_sink(sink)
        .map_err(web_panel_api_error)
}

#[tauri::command(rename_all = "camelCase")]
pub fn sync_web_panels(
    webview: Webview,
    descriptors: Vec<WebPanelDescriptor>,
    focused_panel_id: Option<String>,
    state: State<'_, RuntimeState>,
) -> Result<Vec<WebPanelViewState>, ApiError> {
    ensure_local_main(&webview)?;
    state
        .web_panels
        .sync(&webview.window(), descriptors, focused_panel_id.as_deref())
        .map(sanitize_web_panel_states)
        .map_err(web_panel_api_error)
}

#[tauri::command(rename_all = "camelCase")]
pub fn set_web_panel_visibility(
    webview: Webview,
    panel_id: String,
    visible: bool,
    state: State<'_, RuntimeState>,
) -> Result<(), ApiError> {
    ensure_local_main(&webview)?;
    let snapshot = if visible {
        state.web_panels.show(&panel_id)
    } else {
        state.web_panels.hide(&panel_id)
    };
    snapshot.map(|_| ()).map_err(web_panel_api_error)
}

#[tauri::command(rename_all = "camelCase")]
pub fn set_web_panel_bounds(
    webview: Webview,
    panel_id: String,
    bounds: WebPanelBounds,
    state: State<'_, RuntimeState>,
) -> Result<(), ApiError> {
    ensure_local_main(&webview)?;
    state
        .web_panels
        .set_bounds(&panel_id, bounds)
        .map(|_| ())
        .map_err(web_panel_api_error)
}

#[tauri::command(rename_all = "camelCase")]
pub fn focus_web_panel(
    webview: Webview,
    panel_id: String,
    state: State<'_, RuntimeState>,
) -> Result<bool, ApiError> {
    ensure_local_main(&webview)?;
    state
        .web_panels
        .focus(&panel_id)
        .map_err(web_panel_api_error)
}

#[tauri::command(rename_all = "camelCase")]
pub fn navigate_web_panel(
    webview: Webview,
    panel_id: String,
    url: String,
    state: State<'_, RuntimeState>,
) -> Result<(), ApiError> {
    ensure_local_main(&webview)?;
    state
        .web_panels
        .navigate(&panel_id, &url)
        .map_err(web_panel_api_error)?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn reload_web_panel(
    webview: Webview,
    panel_id: String,
    state: State<'_, RuntimeState>,
) -> Result<(), ApiError> {
    ensure_local_main(&webview)?;
    state
        .web_panels
        .reload(&panel_id)
        .map_err(web_panel_api_error)?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn stop_web_panel(
    webview: Webview,
    panel_id: String,
    state: State<'_, RuntimeState>,
) -> Result<(), ApiError> {
    ensure_local_main(&webview)?;
    state
        .web_panels
        .stop(&panel_id)
        .map_err(web_panel_api_error)?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn go_back_web_panel(
    webview: Webview,
    panel_id: String,
    state: State<'_, RuntimeState>,
) -> Result<(), ApiError> {
    ensure_local_main(&webview)?;
    state
        .web_panels
        .go_back(&panel_id)
        .map_err(web_panel_api_error)?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn go_forward_web_panel(
    webview: Webview,
    panel_id: String,
    state: State<'_, RuntimeState>,
) -> Result<(), ApiError> {
    ensure_local_main(&webview)?;
    state
        .web_panels
        .go_forward(&panel_id)
        .map_err(web_panel_api_error)?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn home_web_panel(
    webview: Webview,
    panel_id: String,
    state: State<'_, RuntimeState>,
) -> Result<(), ApiError> {
    ensure_local_main(&webview)?;
    state
        .web_panels
        .home(&panel_id)
        .map_err(web_panel_api_error)?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn set_web_panel_media_suspended(
    webview: Webview,
    panel_id: String,
    suspended: bool,
    state: State<'_, RuntimeState>,
) -> Result<(), ApiError> {
    ensure_local_main(&webview)?;
    state
        .web_panels
        .set_media_suspended(&panel_id, suspended)
        .map_err(web_panel_api_error)?;
    Ok(())
}

#[tauri::command]
pub fn clear_web_panel_data(
    webview: Webview,
    state: State<'_, RuntimeState>,
) -> Result<(), ApiError> {
    ensure_local_main(&webview)?;
    state
        .web_panels
        .clear_browsing_data()
        .map_err(web_panel_api_error)
}

#[tauri::command(rename_all = "camelCase")]
pub fn set_web_panel_overlay_active(
    webview: Webview,
    active: bool,
    state: State<'_, RuntimeState>,
) -> Result<(), ApiError> {
    ensure_local_main(&webview)?;
    state
        .web_panels
        .set_overlay_active(active)
        .map_err(web_panel_api_error)?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn destroy_web_panel(
    webview: Webview,
    panel_id: String,
    state: State<'_, RuntimeState>,
) -> Result<bool, ApiError> {
    ensure_local_main(&webview)?;
    state
        .web_panels
        .destroy(&panel_id)
        .map_err(web_panel_api_error)
}

#[tauri::command]
pub fn clear_web_panels(webview: Webview, state: State<'_, RuntimeState>) -> Result<(), ApiError> {
    ensure_local_main(&webview)?;
    state.web_panels.destroy_all().map_err(web_panel_api_error)
}

#[tauri::command]
pub fn get_web_panel_states(
    webview: Webview,
    state: State<'_, RuntimeState>,
) -> Result<Vec<WebPanelViewState>, ApiError> {
    ensure_local_main(&webview)?;
    Ok(sanitize_web_panel_states(state.web_panels.snapshots()))
}

#[tauri::command]
pub fn get_web_panel_security_coverage(
    webview: Webview,
) -> Result<NativeWebPanelSecurityCoverage, ApiError> {
    ensure_local_main(&webview)?;
    Ok(NATIVE_WEB_PANEL_SECURITY_COVERAGE)
}

fn sanitize_web_panel_states(snapshots: Vec<WebPanelSnapshot>) -> Vec<WebPanelViewState> {
    snapshots.into_iter().map(WebPanelViewState::from).collect()
}

fn web_panel_api_error(error: WebPanelError) -> ApiError {
    match error {
        WebPanelError::InvalidParent => ApiError::forbidden(),
        WebPanelError::PanelNotFound => ApiError::not_found(error.to_string()),
        WebPanelError::StateChannelUnavailable => {
            ApiError::internal("Le canal d’état des pages web n’est plus disponible.")
        }
        WebPanelError::NativeOperation => {
            ApiError::internal("La vue web native n'a pas pu appliquer l'opération demandée.")
        }
        WebPanelError::InvalidPanelId
        | WebPanelError::InvalidUrl
        | WebPanelError::InvalidBounds
        | WebPanelError::TooManyPanels
        | WebPanelError::DuplicatePanel
        | WebPanelError::PanelAlreadyExists => ApiError::invalid(error.to_string()),
    }
}

#[cfg(test)]
mod web_panel_command_tests {
    use super::*;
    use crate::web_panels::WebPanelPhase;
    use serde_json::json;

    #[test]
    fn renderer_state_never_serializes_the_publication_url() {
        let state = WebPanelViewState::from(WebPanelSnapshot {
            panel_id: "panel-1".to_string(),
            generation: 7,
            sequence: 11,
            url: "https://publication.example/private-path".to_string(),
            bounds: WebPanelBounds {
                x: 1.0,
                y: 2.0,
                width: 320.0,
                height: 240.0,
            },
            phase: WebPanelPhase::Ready,
            requested_visible: true,
            visible: true,
        });

        assert_eq!(
            serde_json::to_value(state).unwrap(),
            json!({
                "panelId": "panel-1",
                "generation": 7,
                "sequence": 11,
                "bounds": { "x": 1.0, "y": 2.0, "width": 320.0, "height": 240.0 },
                "phase": "ready",
                "requestedVisible": true,
                "visible": true,
            })
        );
    }

    #[test]
    fn descriptor_and_bounds_reject_unknown_ipc_fields() {
        let valid = json!({
            "panelId": "panel-1",
            "url": "https://publication.example/",
            "bounds": { "x": 0.0, "y": 0.0, "width": 320.0, "height": 240.0 },
            "visible": true,
        });
        assert!(serde_json::from_value::<WebPanelDescriptor>(valid.clone()).is_ok());

        let mut unknown_descriptor = valid.clone();
        unknown_descriptor["unexpected"] = json!(true);
        assert!(serde_json::from_value::<WebPanelDescriptor>(unknown_descriptor).is_err());

        let mut unknown_bounds = valid;
        unknown_bounds["bounds"]["unexpected"] = json!(true);
        assert!(serde_json::from_value::<WebPanelDescriptor>(unknown_bounds).is_err());
    }

    #[test]
    fn web_panel_errors_map_to_bounded_existing_api_codes() {
        assert_eq!(
            web_panel_api_error(WebPanelError::InvalidUrl).code,
            "invalid_request"
        );
        assert_eq!(
            web_panel_api_error(WebPanelError::PanelNotFound).code,
            "not_found"
        );
        let native = web_panel_api_error(WebPanelError::NativeOperation);
        assert_eq!(native.code, "internal_error");
        assert!(!native.message.contains("http"));
    }

    #[test]
    fn every_web_panel_command_is_registered_in_the_main_handler() {
        let handler = include_str!("lib.rs");
        for command in [
            "open_external_url",
            "open_external_web_panel",
            "subscribe_web_panel_states",
            "sync_web_panels",
            "set_web_panel_visibility",
            "set_web_panel_bounds",
            "focus_web_panel",
            "navigate_web_panel",
            "reload_web_panel",
            "stop_web_panel",
            "go_back_web_panel",
            "go_forward_web_panel",
            "home_web_panel",
            "set_web_panel_media_suspended",
            "clear_web_panel_data",
            "set_web_panel_overlay_active",
            "destroy_web_panel",
            "clear_web_panels",
            "get_web_panel_states",
            "get_web_panel_security_coverage",
        ] {
            assert!(
                handler.contains(&format!("commands::{command},")),
                "commande Tauri non enregistrée: {command}"
            );
        }
    }

    #[test]
    fn every_web_panel_command_checks_the_local_main_boundary_first() {
        let source = include_str!("commands.rs");
        for command in [
            "open_external_url",
            "open_external_web_panel",
            "subscribe_web_panel_states",
            "sync_web_panels",
            "set_web_panel_visibility",
            "set_web_panel_bounds",
            "focus_web_panel",
            "navigate_web_panel",
            "reload_web_panel",
            "stop_web_panel",
            "go_back_web_panel",
            "go_forward_web_panel",
            "home_web_panel",
            "set_web_panel_media_suspended",
            "clear_web_panel_data",
            "set_web_panel_overlay_active",
            "destroy_web_panel",
            "clear_web_panels",
            "get_web_panel_states",
            "get_web_panel_security_coverage",
        ] {
            let signature = format!("pub fn {command}(");
            let function = source
                .split_once(&signature)
                .unwrap_or_else(|| panic!("commande Tauri absente: {command}"))
                .1
                .split_once("\n}\n")
                .map(|(body, _)| body)
                .unwrap_or_else(|| panic!("corps de commande Tauri introuvable: {command}"));
            let guard = function
                .find("ensure_local_main(&webview)?;")
                .unwrap_or_else(|| panic!("frontière main-only absente: {command}"));
            let before_guard = &function[..guard];
            assert!(
                !before_guard.contains("state.") && !before_guard.contains("webview.window()"),
                "accès natif avant la frontière main-only: {command}"
            );
        }
    }

    #[test]
    fn lifecycle_commands_acknowledge_without_returning_competing_state() {
        let source = include_str!("commands.rs");
        for command in [
            "set_web_panel_visibility",
            "set_web_panel_bounds",
            "navigate_web_panel",
            "reload_web_panel",
            "stop_web_panel",
            "go_back_web_panel",
            "go_forward_web_panel",
            "home_web_panel",
            "set_web_panel_media_suspended",
            "set_web_panel_overlay_active",
        ] {
            let signature = format!("pub fn {command}(");
            let function = source
                .split_once(&signature)
                .unwrap_or_else(|| panic!("commande Tauri absente: {command}"))
                .1
                .split_once("\n}\n")
                .map(|(body, _)| body)
                .unwrap_or_else(|| panic!("corps de commande Tauri introuvable: {command}"));
            assert!(
                function.contains(") -> Result<(), ApiError>"),
                "la commande doit seulement accuser réception: {command}"
            );
            assert!(
                !function.contains("current_web_panel_state"),
                "la vérité d'état doit rester exclusive au Channel: {command}"
            );
        }
    }

    #[test]
    fn external_opening_accepts_only_bounded_credential_free_http_urls() {
        let valid = validated_external_url(" https://publication.example/article#section ")
            .expect("valid external URL");
        assert_eq!(
            valid.as_str(),
            "https://publication.example/article#section"
        );
        for invalid in [
            "file:///etc/passwd".to_owned(),
            "javascript:alert(1)".to_owned(),
            "https://user:secret@publication.example/".to_owned(),
            format!("https://publication.example/{}", "x".repeat(4_096)),
        ] {
            assert_eq!(
                validated_external_url(&invalid).unwrap_err().code,
                "invalid_request"
            );
        }
    }
}

#[cfg(test)]
mod feed_probe_command_tests {
    use serde_json::json;

    #[test]
    fn probe_id_rejects_malformed_and_oversized_ipc_values() {
        assert!(serde_json::from_value::<uuid::Uuid>(json!("probe-1")).is_err());
        assert!(serde_json::from_value::<uuid::Uuid>(json!("x".repeat(4_096))).is_err());
        assert!(
            serde_json::from_value::<uuid::Uuid>(json!(uuid::Uuid::new_v4().to_string())).is_ok()
        );
    }

    #[test]
    fn feed_probe_commands_are_registered_and_main_only() {
        let handler = include_str!("lib.rs");
        let source = include_str!("commands.rs");
        for command in ["probe_feed", "cancel_feed_probe"] {
            assert!(
                handler.contains(&format!("commands::{command},")),
                "commande Tauri non enregistrée: {command}"
            );

            let signature = if command == "probe_feed" {
                format!("pub async fn {command}(")
            } else {
                format!("pub fn {command}(")
            };
            let function = source
                .split_once(&signature)
                .unwrap_or_else(|| panic!("commande Tauri absente: {command}"))
                .1
                .split_once("\n}\n")
                .map(|(body, _)| body)
                .unwrap_or_else(|| panic!("corps de commande Tauri introuvable: {command}"));
            let guard = function
                .find("ensure_local_main(&webview)?;")
                .unwrap_or_else(|| panic!("frontière main-only absente: {command}"));
            let before_guard = &function[..guard];
            assert!(
                !before_guard.contains("state.") && !before_guard.contains("webview.window()"),
                "accès natif avant la frontière main-only: {command}"
            );
        }
    }
}

#[cfg(test)]
mod feed_configuration_command_tests {
    use super::*;
    use crate::model::{
        ConnectorPreference, FeedConfigurationCustomSource, FeedPanelConfigurationDraft,
    };

    fn draft() -> FeedPanelConfigurationDraft {
        FeedPanelConfigurationDraft {
            name: " Fil ".to_owned(),
            default_refresh_interval_seconds: 60,
            kept_source_ids: vec![uuid::Uuid::new_v4()],
            selected_catalog_ids: Vec::new(),
            custom_sources: vec![FeedConfigurationCustomSource {
                url: "https://www.example.com/feed.xml#fragment".to_owned(),
                connector_kind: ConnectorPreference::Rss,
            }],
        }
    }

    #[test]
    fn draft_validation_is_strict_normalized_and_deduplicated() {
        let mut input = draft();
        input.custom_sources.push(input.custom_sources[0].clone());
        let validated = validate_feed_panel_configuration(input).unwrap();
        assert_eq!(validated.name, "Fil");
        assert_eq!(validated.custom_sources.len(), 1);
        assert_eq!(
            validated.custom_sources[0].url,
            "https://www.example.com/feed.xml"
        );

        let mut duplicate_kept = draft();
        duplicate_kept
            .kept_source_ids
            .push(duplicate_kept.kept_source_ids[0]);
        assert_eq!(
            validate_feed_panel_configuration(duplicate_kept)
                .unwrap_err()
                .code,
            "invalid_request"
        );

        let mut catalog = draft();
        catalog.selected_catalog_ids.push("le-monde".to_owned());
        let error = validate_feed_panel_configuration(catalog).unwrap_err();
        assert_eq!(error.code, "invalid_request");
        assert!(error.message.contains("catalogue"));
    }

    #[test]
    fn draft_validation_bounds_every_renderer_collection() {
        let mut oversized = draft();
        oversized.kept_source_ids = (0..=MAX_FEED_CONFIGURATION_SOURCES)
            .map(|_| uuid::Uuid::new_v4())
            .collect();
        assert_eq!(
            validate_feed_panel_configuration(oversized)
                .unwrap_err()
                .code,
            "invalid_request"
        );

        let mut unsafe_url = draft();
        unsafe_url.custom_sources[0].url = "http://127.0.0.1/feed".to_owned();
        assert_eq!(
            validate_feed_panel_configuration(unsafe_url)
                .unwrap_err()
                .code,
            "unsafe_network_target"
        );
    }

    #[test]
    fn composite_configuration_command_is_registered_and_main_only() {
        let handler = include_str!("lib.rs");
        assert!(handler.contains("commands::save_feed_panel_configuration,"));
        let source = include_str!("commands.rs");
        let function = source
            .split_once("pub async fn save_feed_panel_configuration(")
            .unwrap()
            .1
            .split_once("\n}\n")
            .unwrap()
            .0;
        let guard = function.find("ensure_local_main(&webview)?;").unwrap();
        assert!(!function[..guard].contains("state."));
    }
}
