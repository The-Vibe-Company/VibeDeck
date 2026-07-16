#[allow(
    dead_code,
    reason = "the bounded reader core is held behind the native reader/webview cutover gate"
)]
mod article_reader;
mod commands;
mod database;
mod error;
mod external_open;
pub mod http_cache;
mod model;
mod network;
mod refresh_worker;
mod runtime;
mod scheduler;
pub mod search;
mod search_sync;
mod snapshot;
pub mod web_panels;

use database::DatabaseActor;
use http_cache::HttpCacheActor;
use model::StateStreamMessage;
use network::FeedTransport;
use runtime::{FeedProbeRegistry, RuntimeState, StateStream};
use search::SearchIndexActor;
use search_sync::SearchSynchronizer;
use snapshot::StartupSnapshotStore;
use tauri::{Manager, RunEvent};
use uuid::Uuid;
use web_panels::WebPanelController;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let data_directory = app.path().app_data_dir()?;
            let snapshot_store =
                StartupSnapshotStore::new(data_directory.join("startup-snapshot-v1.json"));
            // Invalid or unreadable derived state never prevents access to the
            // authoritative database and is never repaired by deleting user data.
            let startup_snapshot = snapshot_store.load().ok().flatten();
            let database = DatabaseActor::spawn(data_directory.join("vibedeck-v1.sqlite3"));
            let http_cache = HttpCacheActor::spawn(data_directory.join("http-cache-v1.sqlite3"));
            // The actor is lazy and the synchronizer starts idle. Neither opens
            // the derived index nor reads articles during native setup.
            let search = SearchIndexActor::spawn(data_directory.join("search-v1.sqlite3"));
            let session_id = Uuid::new_v4();
            let state_stream = StateStream::new(session_id);
            let status_stream = state_stream.clone();
            let search_sync = SearchSynchronizer::spawn_with_publisher(
                database.clone(),
                search.clone(),
                std::sync::Arc::new(move |status| {
                    status_stream.publish(StateStreamMessage::SearchStatus { status });
                }),
            );
            app.manage(RuntimeState {
                session_id,
                database,
                snapshot_store,
                snapshot: std::sync::Arc::new(std::sync::Mutex::new(startup_snapshot)),
                snapshot_write: std::sync::Arc::new(tokio::sync::Mutex::new(())),
                state_stream,
                transition_order: std::sync::Arc::new(tokio::sync::Mutex::new(())),
                network: FeedTransport::new()?,
                http_cache,
                feed_probes: FeedProbeRegistry::default(),
                search,
                search_sync,
                web_panels: WebPanelController::new(data_directory.join("publication-web-data")),
                refresh_worker: std::sync::Mutex::new(None),
                shutdown_started: std::sync::atomic::AtomicBool::new(false),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::startup_snapshot,
            commands::bootstrap,
            commands::get_feed_page,
            commands::get_item,
            commands::get_search_status,
            commands::search,
            commands::mutate,
            commands::save_feed_panel_configuration,
            commands::probe_feed,
            commands::cancel_feed_probe,
            commands::open_external_url,
            commands::open_external_web_panel,
            commands::subscribe_web_panel_states,
            commands::sync_web_panels,
            commands::set_web_panel_visibility,
            commands::set_web_panel_bounds,
            commands::focus_web_panel,
            commands::navigate_web_panel,
            commands::reload_web_panel,
            commands::stop_web_panel,
            commands::go_back_web_panel,
            commands::go_forward_web_panel,
            commands::home_web_panel,
            commands::set_web_panel_media_suspended,
            commands::clear_web_panel_data,
            commands::set_web_panel_overlay_active,
            commands::destroy_web_panel,
            commands::clear_web_panels,
            commands::get_web_panel_states,
            commands::get_web_panel_security_coverage,
        ])
        .build(tauri::generate_context!())
        .expect("VibeDeck failed to start");
    app.run(|app_handle, event| {
        if matches!(event, RunEvent::ExitRequested { .. }) {
            let state = app_handle.state::<RuntimeState>();
            tauri::async_runtime::block_on(state.shutdown());
        }
    });
}
