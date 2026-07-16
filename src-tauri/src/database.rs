use crate::{
    error::ApiError,
    model::{
        BootstrapResponse, ConnectorKind, CreatePanelInput, DashboardState, FeedItem, FeedPage,
        FeedPageRequest, GenericSourceInput, ItemReadState, LayoutNode, MutationAck,
        MutationCommand, MutationResult, Panel, PanelPlacement, PlacementSide, RefreshScope,
        SearchResult, Source, SourceStatus, SplitDirection, StateChange, StatePatch,
        FIRST_PAGE_SIZE, MAX_PAGE_SIZE, MAX_PATCH_BYTES, MAX_SEARCH_RESULTS,
    },
    network::{ParsedFeed, ParsedFeedItem},
    search::{SearchDocument, SearchHit},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{
    params,
    types::{Type, ValueRef},
    Connection, OpenFlags, OptionalExtension, Row, Transaction, TransactionBehavior,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::{self, SyncSender, TrySendError},
        Arc, Mutex, RwLock,
    },
    thread,
};
use tokio::sync::{oneshot, Mutex as AsyncMutex};
use uuid::Uuid;

const DATABASE_SCHEMA_VERSION: i64 = 1;
const DATABASE_QUEUE_CAPACITY: usize = 64;
const DATABASE_READER_COUNT: usize = 2;
const DATABASE_READER_QUEUE_CAPACITY: usize = DATABASE_QUEUE_CAPACITY / DATABASE_READER_COUNT;
const MAX_LAYOUT_DEPTH: usize = 32;
const MAX_LAYOUT_NODES: usize = 1_023;
const MAX_LAYOUT_BYTES: usize = 128 * 1024;
const MAX_PANEL_NAME_CHARS: usize = 80;
const MAX_SOURCE_NAME_CHARS: usize = 120;
const MAX_PANELS: i64 = 6;
const MAX_SOURCES_PER_PANEL: usize = 256;
const MAX_ATTACHED_SOURCES: usize = 6 * MAX_SOURCES_PER_PANEL;
const MAX_ITEMS_PER_INGESTION: usize = 2_000;
const MAX_VISIBLE_INGEST_ITEMS: usize = 200;
const MAX_HTTP_URL_LENGTH: usize = 4_096;
const MAX_ITEM_TITLE_CHARS: usize = 512;
const MAX_ITEM_TEXT_BYTES: usize = 16 * 1_024;
const MIN_REFRESH_INTERVAL_SECONDS: u32 = 30;
const MAX_REFRESH_INTERVAL_SECONDS: u32 = 3_600;
const DEFAULT_REFRESH_INTERVAL_SECONDS: u32 = 60;
const MAX_MARKED_ITEMS: usize = 500;
const MAX_CURSOR_BYTES: usize = 512;
const MAX_DUE_SOURCES: u16 = 32;
const MAX_SOURCE_ERROR_BYTES: usize = 1_024;
const MAX_CONSECUTIVE_FAILURES: u32 = 1_000_000;
const MAX_FAILURE_BACKOFF_SECONDS: u64 = 1_800;
pub(crate) const MAX_SEARCH_PROJECTION_PAGE_SIZE: u16 = 2_000;

type DbResponse<T> = oneshot::Sender<Result<T, ApiError>>;

/// Main-process-only handoff from the bounded parser to the authoritative
/// writer. It is intentionally not serializable and cannot be invoked by a
/// remote child webview or the renderer.
#[derive(Clone, Debug)]
pub struct IngestFeedRequest {
    pub operation_id: Uuid,
    pub source_id: Uuid,
    pub observed_at: String,
    pub feed: ParsedFeed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DueSource {
    pub id: Uuid,
    pub feed_url: String,
    pub connector_kind: ConnectorKind,
    pub refresh_interval_seconds: u32,
    pub due_at_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SearchDocumentPage {
    pub documents: Vec<SearchDocument>,
    pub next_cursor: Option<Uuid>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SearchHydration {
    pub results: Vec<SearchResult>,
    pub missing_item_ids: Vec<Uuid>,
}

#[derive(Clone, Copy, Debug)]
enum SearchProjectionScope {
    All,
    Source(Uuid),
    Panel(Uuid),
}

#[derive(Clone, Debug)]
struct SourceRefreshRequest {
    operation_id: Uuid,
    source_id: Uuid,
    at_ms: i64,
    transition: SourceRefreshTransition,
}

#[derive(Clone, Debug)]
enum SourceRefreshTransition {
    Begin,
    #[allow(dead_code)] // Called through RefreshJob once the fetch worker is activated.
    Success,
    #[allow(dead_code)] // Called through RefreshJob once the fetch worker is activated.
    Failure {
        error_message: String,
    },
}

enum ReadCommand {
    Revision {
        reply: DbResponse<u64>,
    },
    Bootstrap {
        session_id: Uuid,
        reply: DbResponse<BootstrapResponse>,
    },
    FeedPage {
        request: FeedPageRequest,
        reply: DbResponse<FeedPage>,
    },
    GetItem {
        item_id: Uuid,
        reply: DbResponse<FeedItem>,
    },
    SearchDocumentsPage {
        scope: SearchProjectionScope,
        cursor: Option<Uuid>,
        limit: u16,
        reply: DbResponse<SearchDocumentPage>,
    },
    SearchDocumentsByIds {
        item_ids: Vec<Uuid>,
        reply: DbResponse<Vec<SearchDocument>>,
    },
    HydrateSearchHits {
        hits: Vec<SearchHit>,
        reply: DbResponse<SearchHydration>,
    },
    NextDueAt {
        reply: DbResponse<Option<i64>>,
    },
    DueSources {
        now_ms: i64,
        limit: u16,
        reply: DbResponse<Vec<DueSource>>,
    },
    FeedConfigurationPreflight {
        operation_id: Uuid,
        expected_revision: u64,
        panel_id: Uuid,
        kept_source_ids: Vec<Uuid>,
        reply: DbResponse<Option<MutationAck>>,
    },
    #[cfg(test)]
    ReaderIdentity {
        reply: DbResponse<(usize, String)>,
    },
}

impl ReadCommand {
    fn fail(self, error: ApiError) {
        match self {
            Self::Revision { reply } => {
                let _ = reply.send(Err(error));
            }
            Self::Bootstrap { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Self::FeedPage { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Self::GetItem { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Self::SearchDocumentsPage { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Self::SearchDocumentsByIds { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Self::HydrateSearchHits { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Self::NextDueAt { reply } => {
                let _ = reply.send(Err(error));
            }
            Self::DueSources { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Self::FeedConfigurationPreflight { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            #[cfg(test)]
            Self::ReaderIdentity { reply } => {
                let _ = reply.send(Err(error));
            }
        }
    }
}

enum WriteCommand {
    Mutate {
        session_id: Uuid,
        request: crate::model::MutateRequest,
        reply: DbResponse<MutationResult>,
    },
    #[allow(dead_code)] // Wired by the refresh actor once scheduler orchestration lands.
    IngestFeed {
        session_id: Uuid,
        request: IngestFeedRequest,
        reply: DbResponse<MutationResult>,
    },
    SourceRefresh {
        session_id: Uuid,
        request: SourceRefreshRequest,
        reply: DbResponse<Option<MutationResult>>,
    },
}

impl WriteCommand {
    fn fail(self, error: ApiError) {
        match self {
            Self::Mutate { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Self::IngestFeed { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Self::SourceRefresh { reply, .. } => {
                let _ = reply.send(Err(error));
            }
        }
    }
}

struct DatabaseSenders {
    writer_sender: SyncSender<WriteCommand>,
    reader_senders: [SyncSender<ReadCommand>; DATABASE_READER_COUNT],
}

struct DatabaseThreads {
    writer: thread::JoinHandle<()>,
    readers: Vec<thread::JoinHandle<()>>,
}

impl DatabaseThreads {
    fn join(self) {
        // Close read-only WAL snapshots before the writer performs its final
        // WAL close/checkpoint. All channels are already disconnected here.
        for reader in self.readers {
            let _ = reader.join();
        }
        let _ = self.writer.join();
    }
}

struct DatabaseActorCore {
    senders: RwLock<Option<DatabaseSenders>>,
    threads: Mutex<Option<DatabaseThreads>>,
    shutdown_gate: AsyncMutex<()>,
    shutdown_complete: AtomicBool,
    next_reader: AtomicUsize,
    #[cfg(test)]
    source_refresh_write_failures: AtomicUsize,
}

impl Drop for DatabaseActorCore {
    fn drop(&mut self) {
        // Explicit shutdown joins the threads. A caller that forgets it still
        // cannot leave the actors waiting forever on live channel senders.
        self.senders
            .get_mut()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
    }
}

#[derive(Clone)]
pub struct DatabaseActor {
    core: Arc<DatabaseActorCore>,
}

impl DatabaseActor {
    /// Starts database initialization on a dedicated thread and returns without
    /// waiting for migrations. Commands queue behind initialization, keeping the
    /// native UI thread free to paint the shell.
    pub fn spawn(path: PathBuf) -> Self {
        let (writer_sender, writer_receiver) = mpsc::sync_channel(DATABASE_QUEUE_CAPACITY);
        let mut reader_senders = Vec::with_capacity(DATABASE_READER_COUNT);
        let mut reader_receivers = Vec::with_capacity(DATABASE_READER_COUNT);
        let mut initialization_senders = Vec::with_capacity(DATABASE_READER_COUNT);
        let mut initialization_receivers = Vec::with_capacity(DATABASE_READER_COUNT);
        for _ in 0..DATABASE_READER_COUNT {
            let (sender, receiver) = mpsc::sync_channel(DATABASE_READER_QUEUE_CAPACITY);
            reader_senders.push(sender);
            reader_receivers.push(receiver);
            // One result per reader is enough: migration is a one-shot gate and
            // a failed writer initialization permanently fails all reads closed.
            let (initialization_sender, initialization_receiver) = mpsc::sync_channel(1);
            initialization_senders.push(initialization_sender);
            initialization_receivers.push(initialization_receiver);
        }

        let writer_path = path.clone();
        let writer = thread::Builder::new()
            .name("vibedeck-sqlite-writer".to_owned())
            .spawn(move || {
                let mut connection = open_database(&writer_path);
                let initialization = connection.as_ref().map(|_| ()).map_err(Clone::clone);
                for sender in initialization_senders {
                    let _ = sender.send(initialization.clone());
                }
                while let Ok(command) = writer_receiver.recv() {
                    let result = match &mut connection {
                        Ok(connection) => handle_write_command(connection, command),
                        Err(error) => {
                            command.fail(error.clone());
                            Ok(())
                        }
                    };
                    if let Err(error) = result {
                        // A command-level failure is returned by its own reply.
                        // Reaching this branch means the actor itself is no longer
                        // trustworthy, so subsequent commands fail closed.
                        connection = Err(error);
                    }
                }
            })
            .expect("the SQLite actor thread must be creatable");

        let mut reader_threads = Vec::with_capacity(DATABASE_READER_COUNT);
        for (reader_index, (receiver, initialization_receiver)) in reader_receivers
            .into_iter()
            .zip(initialization_receivers)
            .enumerate()
        {
            let reader_path = path.clone();
            let reader = thread::Builder::new()
                .name(format!("vibedeck-sqlite-reader-{reader_index}"))
                .spawn(move || {
                    let initialized = initialization_receiver.recv().unwrap_or_else(|_| {
                        Err(ApiError::internal(
                            "Le writer SQLite s'est arrêté avant l'initialisation.",
                        ))
                    });
                    let mut connection =
                        initialized.and_then(|()| open_reader_database(&reader_path));
                    while let Ok(command) = receiver.recv() {
                        let result = match &mut connection {
                            Ok(connection) => {
                                handle_read_command(connection, reader_index, command)
                            }
                            Err(error) => {
                                command.fail(error.clone());
                                Ok(())
                            }
                        };
                        if let Err(error) = result {
                            connection = Err(error);
                        }
                    }
                })
                .expect("the SQLite reader actor thread must be creatable");
            reader_threads.push(reader);
        }

        let reader_senders: [SyncSender<ReadCommand>; DATABASE_READER_COUNT] = reader_senders
            .try_into()
            .unwrap_or_else(|_| unreachable!("the reader count is fixed"));
        Self {
            core: Arc::new(DatabaseActorCore {
                senders: RwLock::new(Some(DatabaseSenders {
                    writer_sender,
                    reader_senders,
                })),
                threads: Mutex::new(Some(DatabaseThreads {
                    writer,
                    readers: reader_threads,
                })),
                shutdown_gate: AsyncMutex::new(()),
                shutdown_complete: AtomicBool::new(false),
                next_reader: AtomicUsize::new(0),
                #[cfg(test)]
                source_refresh_write_failures: AtomicUsize::new(0),
            }),
        }
    }

    /// Stops accepting commands, drains every command already accepted, and
    /// joins the writer plus both query-only readers off the async executor.
    /// Clones share this lifecycle; concurrent calls are idempotent and wait for
    /// the same completed shutdown rather than closing the actor prematurely.
    pub async fn shutdown(&self) {
        let _shutdown = self.core.shutdown_gate.lock().await;
        if self.core.shutdown_complete.load(Ordering::Acquire) {
            return;
        }

        let senders = self
            .core
            .senders
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        drop(senders);
        let threads = self
            .core
            .threads
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(threads) = threads {
            let _ = tauri::async_runtime::spawn_blocking(move || threads.join()).await;
        }
        self.core.shutdown_complete.store(true, Ordering::Release);
    }

    pub async fn revision(&self) -> Result<u64, ApiError> {
        let (reply, response) = oneshot::channel();
        self.send_read(ReadCommand::Revision { reply })?;
        receive(response).await
    }

    pub async fn bootstrap(&self, session_id: Uuid) -> Result<BootstrapResponse, ApiError> {
        let (reply, response) = oneshot::channel();
        self.send_read(ReadCommand::Bootstrap { session_id, reply })?;
        receive(response).await
    }

    pub async fn feed_page(&self, request: FeedPageRequest) -> Result<FeedPage, ApiError> {
        let (reply, response) = oneshot::channel();
        self.send_read(ReadCommand::FeedPage { request, reply })?;
        receive(response).await
    }

    pub async fn get_item(&self, item_id: Uuid) -> Result<FeedItem, ApiError> {
        let (reply, response) = oneshot::channel();
        self.send_read(ReadCommand::GetItem { item_id, reply })?;
        receive(response).await
    }

    pub(crate) async fn search_documents_page(
        &self,
        cursor: Option<Uuid>,
        limit: u16,
    ) -> Result<SearchDocumentPage, ApiError> {
        self.search_documents_page_for_scope(SearchProjectionScope::All, cursor, limit)
            .await
    }

    pub(crate) async fn search_documents_for_source(
        &self,
        source_id: Uuid,
        cursor: Option<Uuid>,
        limit: u16,
    ) -> Result<SearchDocumentPage, ApiError> {
        self.search_documents_page_for_scope(
            SearchProjectionScope::Source(source_id),
            cursor,
            limit,
        )
        .await
    }

    pub(crate) async fn search_documents_for_panel(
        &self,
        panel_id: Uuid,
        cursor: Option<Uuid>,
        limit: u16,
    ) -> Result<SearchDocumentPage, ApiError> {
        self.search_documents_page_for_scope(SearchProjectionScope::Panel(panel_id), cursor, limit)
            .await
    }

    async fn search_documents_page_for_scope(
        &self,
        scope: SearchProjectionScope,
        cursor: Option<Uuid>,
        limit: u16,
    ) -> Result<SearchDocumentPage, ApiError> {
        validate_search_projection_limit(limit)?;
        let (reply, response) = oneshot::channel();
        self.send_read(ReadCommand::SearchDocumentsPage {
            scope,
            cursor,
            limit,
            reply,
        })?;
        receive(response).await
    }

    pub(crate) async fn search_documents_by_ids(
        &self,
        item_ids: Vec<Uuid>,
    ) -> Result<Vec<SearchDocument>, ApiError> {
        let item_ids = normalize_search_item_ids(item_ids, MAX_SEARCH_RESULTS)?;
        if item_ids.is_empty() {
            return Ok(Vec::new());
        }
        let (reply, response) = oneshot::channel();
        self.send_read(ReadCommand::SearchDocumentsByIds { item_ids, reply })?;
        receive(response).await
    }

    pub(crate) async fn hydrate_search_hits(
        &self,
        hits: Vec<SearchHit>,
    ) -> Result<SearchHydration, ApiError> {
        if hits.len() > usize::from(MAX_SEARCH_RESULTS) {
            return Err(ApiError::invalid(format!(
                "Une hydratation de recherche accepte au maximum {MAX_SEARCH_RESULTS} résultats."
            )));
        }
        if hits.is_empty() {
            return Ok(SearchHydration {
                results: Vec::new(),
                missing_item_ids: Vec::new(),
            });
        }
        let (reply, response) = oneshot::channel();
        self.send_read(ReadCommand::HydrateSearchHits { hits, reply })?;
        receive(response).await
    }

    pub async fn mutate(
        &self,
        session_id: Uuid,
        request: crate::model::MutateRequest,
    ) -> Result<MutationResult, ApiError> {
        let (reply, response) = oneshot::channel();
        self.send_write(WriteCommand::Mutate {
            session_id,
            request,
            reply,
        })?;
        receive(response).await
    }

    #[allow(dead_code)] // Main-only API reserved for the refresh actor, never Tauri IPC.
    pub async fn ingest_feed(
        &self,
        session_id: Uuid,
        request: IngestFeedRequest,
    ) -> Result<MutationResult, ApiError> {
        let (reply, response) = oneshot::channel();
        self.send_write(WriteCommand::IngestFeed {
            session_id,
            request,
            reply,
        })?;
        receive(response).await
    }

    pub(crate) async fn next_due_at_ms(&self) -> Result<Option<i64>, ApiError> {
        let (reply, response) = oneshot::channel();
        self.send_read(ReadCommand::NextDueAt { reply })?;
        receive(response).await
    }

    pub(crate) async fn due_sources(
        &self,
        now_ms: i64,
        limit: u16,
    ) -> Result<Vec<DueSource>, ApiError> {
        if limit == 0 || limit > MAX_DUE_SOURCES {
            return Err(ApiError::invalid(format!(
                "Une lecture d'échéances doit demander entre 1 et {MAX_DUE_SOURCES} sources."
            )));
        }
        let (reply, response) = oneshot::channel();
        self.send_read(ReadCommand::DueSources {
            now_ms,
            limit,
            reply,
        })?;
        receive(response).await
    }

    pub(crate) async fn preflight_feed_panel_configuration(
        &self,
        operation_id: Uuid,
        expected_revision: u64,
        panel_id: Uuid,
        kept_source_ids: Vec<Uuid>,
    ) -> Result<Option<MutationAck>, ApiError> {
        if operation_id.is_nil() {
            return Err(ApiError::invalid("Identifiant d'opération invalide."));
        }
        validate_configuration_source_ids(&kept_source_ids)?;
        let (reply, response) = oneshot::channel();
        self.send_read(ReadCommand::FeedConfigurationPreflight {
            operation_id,
            expected_revision,
            panel_id,
            kept_source_ids,
            reply,
        })?;
        receive(response).await
    }

    pub(crate) async fn begin_source_refresh(
        &self,
        session_id: Uuid,
        operation_id: Uuid,
        source_id: Uuid,
        at_ms: i64,
    ) -> Result<Option<MutationResult>, ApiError> {
        self.source_refresh(
            session_id,
            SourceRefreshRequest {
                operation_id,
                source_id,
                at_ms,
                transition: SourceRefreshTransition::Begin,
            },
        )
        .await
    }

    #[allow(dead_code)] // Called through RefreshJob once the fetch worker is activated.
    pub(crate) async fn complete_source_refresh_success(
        &self,
        session_id: Uuid,
        operation_id: Uuid,
        source_id: Uuid,
        at_ms: i64,
    ) -> Result<MutationResult, ApiError> {
        self.source_refresh(
            session_id,
            SourceRefreshRequest {
                operation_id,
                source_id,
                at_ms,
                transition: SourceRefreshTransition::Success,
            },
        )
        .await?
        .ok_or_else(|| ApiError::invalid("Cette source n'est pas en cours d'actualisation."))
    }

    #[allow(dead_code)] // Called through RefreshJob once the fetch worker is activated.
    pub(crate) async fn complete_source_refresh_failure(
        &self,
        session_id: Uuid,
        operation_id: Uuid,
        source_id: Uuid,
        at_ms: i64,
        error_message: String,
    ) -> Result<MutationResult, ApiError> {
        self.source_refresh(
            session_id,
            SourceRefreshRequest {
                operation_id,
                source_id,
                at_ms,
                transition: SourceRefreshTransition::Failure { error_message },
            },
        )
        .await?
        .ok_or_else(|| ApiError::invalid("Cette source n'est pas en cours d'actualisation."))
    }

    async fn source_refresh(
        &self,
        session_id: Uuid,
        request: SourceRefreshRequest,
    ) -> Result<Option<MutationResult>, ApiError> {
        #[cfg(test)]
        if self
            .core
            .source_refresh_write_failures
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |remaining| {
                remaining.checked_sub(1)
            })
            .is_ok()
        {
            return Err(ApiError::internal(
                "Échec d'écriture de finalisation injecté par le test.",
            ));
        }
        let (reply, response) = oneshot::channel();
        self.send_write(WriteCommand::SourceRefresh {
            session_id,
            request,
            reply,
        })?;
        receive(response).await
    }

    #[cfg(test)]
    pub(crate) fn fail_next_source_refresh_write(&self) {
        self.fail_source_refresh_writes(1);
    }

    #[cfg(test)]
    pub(crate) fn fail_source_refresh_writes(&self, count: usize) {
        assert!(count > 0, "at least one injected failure is required");
        self.core
            .source_refresh_write_failures
            .fetch_add(count, Ordering::Release);
    }

    #[cfg(test)]
    pub(crate) fn remaining_source_refresh_write_failures(&self) -> usize {
        self.core
            .source_refresh_write_failures
            .load(Ordering::Acquire)
    }

    #[cfg(test)]
    async fn reader_identity(&self) -> Result<(usize, String), ApiError> {
        let (reply, response) = oneshot::channel();
        self.send_read(ReadCommand::ReaderIdentity { reply })?;
        receive(response).await
    }

    fn send_read(&self, command: ReadCommand) -> Result<(), ApiError> {
        let senders = self
            .core
            .senders
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(senders) = senders.as_ref() else {
            return Err(ApiError::internal(
                "La persistance locale est déjà arrêtée.",
            ));
        };
        let reader_index =
            self.core.next_reader.fetch_add(1, Ordering::Relaxed) % DATABASE_READER_COUNT;
        match senders.reader_senders[reader_index].try_send(command) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err(ApiError::busy()),
            Err(TrySendError::Disconnected(_)) => Err(ApiError::internal(
                "Un lecteur de la persistance locale s'est arrêté.",
            )),
        }
    }

    fn send_write(&self, command: WriteCommand) -> Result<(), ApiError> {
        let senders = self
            .core
            .senders
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(senders) = senders.as_ref() else {
            return Err(ApiError::internal(
                "La persistance locale est déjà arrêtée.",
            ));
        };
        match senders.writer_sender.try_send(command) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err(ApiError::busy()),
            Err(TrySendError::Disconnected(_)) => Err(ApiError::internal(
                "Le writer de la persistance locale s'est arrêté.",
            )),
        }
    }
}

async fn receive<T>(response: oneshot::Receiver<Result<T, ApiError>>) -> Result<T, ApiError> {
    response.await.unwrap_or_else(|_| {
        Err(ApiError::internal(
            "Le moteur de persistance locale n'a pas répondu.",
        ))
    })
}

fn handle_read_command(
    connection: &Connection,
    _reader_index: usize,
    command: ReadCommand,
) -> Result<(), ApiError> {
    match command {
        ReadCommand::Revision { reply } => {
            let _ = reply.send(read_revision(connection));
        }
        ReadCommand::Bootstrap { session_id, reply } => {
            let _ = reply.send(read_consistent(connection, |connection| {
                read_bootstrap(connection, session_id)
            }));
        }
        ReadCommand::FeedPage { request, reply } => {
            let _ = reply.send(read_consistent(connection, |connection| {
                read_feed_page(connection, &request)
            }));
        }
        ReadCommand::GetItem { item_id, reply } => {
            let _ = reply.send(read_item(connection, item_id));
        }
        ReadCommand::SearchDocumentsPage {
            scope,
            cursor,
            limit,
            reply,
        } => {
            let _ = reply.send(read_consistent(connection, |connection| {
                read_search_documents_page(connection, scope, cursor, limit)
            }));
        }
        ReadCommand::SearchDocumentsByIds { item_ids, reply } => {
            let _ = reply.send(read_consistent(connection, |connection| {
                read_search_documents_by_ids(connection, &item_ids)
            }));
        }
        ReadCommand::HydrateSearchHits { hits, reply } => {
            let _ = reply.send(read_search_results(connection, hits));
        }
        ReadCommand::NextDueAt { reply } => {
            let _ = reply.send(read_next_due_at_ms(connection));
        }
        ReadCommand::DueSources {
            now_ms,
            limit,
            reply,
        } => {
            let _ = reply.send(read_due_sources(connection, now_ms, limit));
        }
        ReadCommand::FeedConfigurationPreflight {
            operation_id,
            expected_revision,
            panel_id,
            kept_source_ids,
            reply,
        } => {
            let _ = reply.send(read_consistent(connection, |connection| {
                read_feed_configuration_preflight(
                    connection,
                    operation_id,
                    expected_revision,
                    panel_id,
                    &kept_source_ids,
                )
            }));
        }
        #[cfg(test)]
        ReadCommand::ReaderIdentity { reply } => {
            let query_only: i64 =
                connection.query_row("PRAGMA query_only", [], |row| row.get(0))?;
            let result = if query_only == 1 {
                Ok((
                    _reader_index,
                    thread::current()
                        .name()
                        .unwrap_or("unnamed-sqlite-reader")
                        .to_owned(),
                ))
            } else {
                Err(ApiError::internal(
                    "Un lecteur SQLite n'est pas protégé par query_only.",
                ))
            };
            let _ = reply.send(result);
        }
    }
    Ok(())
}

fn read_consistent<T>(
    connection: &Connection,
    read: impl FnOnce(&Connection) -> Result<T, ApiError>,
) -> Result<T, ApiError> {
    let transaction = connection.unchecked_transaction()?;
    let value = read(&transaction)?;
    transaction.commit()?;
    Ok(value)
}

fn handle_write_command(
    connection: &mut Connection,
    command: WriteCommand,
) -> Result<(), ApiError> {
    match command {
        WriteCommand::Mutate {
            session_id,
            request,
            reply,
        } => {
            let _ = reply.send(apply_mutation(connection, session_id, request));
        }
        WriteCommand::IngestFeed {
            session_id,
            request,
            reply,
        } => {
            let _ = reply.send(apply_feed_ingestion(connection, session_id, request));
        }
        WriteCommand::SourceRefresh {
            session_id,
            request,
            reply,
        } => {
            let _ = reply.send(apply_source_refresh_transition(
                connection, session_id, request,
            ));
        }
    }
    Ok(())
}

fn open_database(path: &Path) -> Result<Connection, ApiError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            ApiError::internal(format!("Impossible de créer le profil local: {error}"))
        })?;
    }
    let mut connection = Connection::open(path)?;
    connection.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 3000;
         PRAGMA journal_mode = WAL;
         PRAGMA synchronous = FULL;
         PRAGMA trusted_schema = OFF;",
    )?;
    migrate(&connection)?;
    recover_interrupted_refreshes(&mut connection)?;
    Ok(connection)
}

fn recover_interrupted_refreshes(connection: &mut Connection) -> Result<(), ApiError> {
    let recovered_at = now();
    let transaction = connection.transaction()?;
    let recovered = transaction.execute(
        "UPDATE sources SET status = 'idle', updated_at = ?1 WHERE status = 'refreshing'",
        [&recovered_at],
    )?;
    if recovered > 0 {
        let revision: i64 = transaction.query_row(
            "SELECT revision FROM dashboard_state WHERE id = 1",
            [],
            |row| row.get(0),
        )?;
        let next_revision = revision.checked_add(1).ok_or_else(|| {
            ApiError::internal("La révision locale ne peut plus être incrémentée.")
        })?;
        transaction.execute(
            "UPDATE dashboard_state SET revision = ?1, updated_at = ?2 WHERE id = 1",
            params![next_revision, recovered_at],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

fn open_reader_database(path: &Path) -> Result<Connection, ApiError> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.execute_batch(
        "PRAGMA query_only = ON;
         PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 3000;
         PRAGMA trusted_schema = OFF;",
    )?;
    let current: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if current != DATABASE_SCHEMA_VERSION {
        return Err(ApiError::internal(format!(
            "Le lecteur SQLite attend le schéma {DATABASE_SCHEMA_VERSION}, trouvé {current}."
        )));
    }
    Ok(connection)
}

fn migrate(connection: &Connection) -> Result<(), ApiError> {
    let current: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if current > DATABASE_SCHEMA_VERSION {
        return Err(ApiError::internal(format!(
            "Cette base VibeDeck utilise un schéma plus récent ({current})."
        )));
    }
    let transaction = connection.unchecked_transaction()?;
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS dashboard_state (
           id INTEGER PRIMARY KEY CHECK (id = 1),
           layout_json TEXT,
           revision INTEGER NOT NULL CHECK (revision >= 0),
           updated_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS panels (
           id BLOB PRIMARY KEY NOT NULL CHECK (length(id) = 16),
           name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
           position INTEGER NOT NULL CHECK (position >= 0),
           kind TEXT NOT NULL CHECK (kind IN ('feed', 'web')),
           web_url TEXT,
           default_refresh_interval_seconds INTEGER NOT NULL
             CHECK (default_refresh_interval_seconds BETWEEN 30 AND 3600),
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL,
           CHECK ((kind = 'feed' AND web_url IS NULL) OR
                  (kind = 'web' AND web_url IS NOT NULL))
         );
         CREATE UNIQUE INDEX IF NOT EXISTS panels_position ON panels(position);
         CREATE TABLE IF NOT EXISTS sources (
           id BLOB PRIMARY KEY NOT NULL CHECK (length(id) = 16),
           name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
           input_url TEXT NOT NULL,
           feed_url TEXT NOT NULL UNIQUE,
           connector_id TEXT,
           connector_kind TEXT NOT NULL
             CHECK (connector_kind IN ('rss', 'atom', 'news-sitemap')),
           refresh_interval_seconds INTEGER NOT NULL
             CHECK (refresh_interval_seconds BETWEEN 30 AND 3600),
           status TEXT NOT NULL CHECK (status IN ('idle', 'refreshing', 'healthy', 'error')),
           last_checked_at TEXT,
           last_success_at TEXT,
           error_message TEXT,
           baseline_completed_at TEXT,
           consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
           next_retry_at TEXT,
           due_at_ms INTEGER NOT NULL,
           item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS sources_due ON sources(due_at_ms, id);
         CREATE TABLE IF NOT EXISTS panel_sources (
           panel_id BLOB NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
           source_id BLOB NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
           position INTEGER NOT NULL CHECK (position >= 0),
           PRIMARY KEY (panel_id, source_id),
           UNIQUE (panel_id, position)
         );
         CREATE TABLE IF NOT EXISTS items (
           id BLOB PRIMARY KEY NOT NULL CHECK (length(id) = 16),
           source_id BLOB NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
           canonical_url TEXT NOT NULL,
           title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 512),
           summary TEXT,
           image_url TEXT,
           published_at TEXT,
           updated_at TEXT,
           first_seen_at TEXT NOT NULL,
           arrival_batch_at TEXT NOT NULL,
           last_seen_at TEXT NOT NULL,
           is_baseline INTEGER NOT NULL CHECK (is_baseline IN (0, 1)),
           seen_at TEXT,
           opened_at TEXT,
           UNIQUE (source_id, canonical_url)
         );
         CREATE INDEX IF NOT EXISTS items_source_seen ON items(source_id, first_seen_at DESC, id);
         CREATE TABLE IF NOT EXISTS panel_items (
           panel_id BLOB NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
           item_id BLOB NOT NULL REFERENCES items(id) ON DELETE CASCADE,
           baseline_rank INTEGER NOT NULL CHECK (baseline_rank IN (0, 1)),
           sort_at_ms INTEGER NOT NULL,
           PRIMARY KEY (panel_id, item_id)
         );
         CREATE INDEX IF NOT EXISTS panel_items_page
           ON panel_items(panel_id, baseline_rank ASC, sort_at_ms DESC, item_id ASC);
         CREATE TRIGGER IF NOT EXISTS items_increment_source_count
           AFTER INSERT ON items BEGIN
             UPDATE sources SET item_count = item_count + 1 WHERE id = NEW.source_id;
           END;
         CREATE TRIGGER IF NOT EXISTS items_decrement_source_count
           AFTER DELETE ON items BEGIN
             UPDATE sources SET item_count = item_count - 1 WHERE id = OLD.source_id;
           END;
         CREATE TABLE IF NOT EXISTS operations (
           operation_id BLOB PRIMARY KEY NOT NULL CHECK (length(operation_id) = 16),
           committed_revision INTEGER NOT NULL CHECK (committed_revision >= 0),
           created_at TEXT NOT NULL
         );
         INSERT OR IGNORE INTO dashboard_state (id, layout_json, revision, updated_at)
           VALUES (1, NULL, 0, '1970-01-01T00:00:00.000Z');",
    )?;
    transaction.pragma_update(None, "user_version", DATABASE_SCHEMA_VERSION)?;
    transaction.commit()?;
    Ok(())
}

fn read_revision(connection: &Connection) -> Result<u64, ApiError> {
    let revision: i64 = connection.query_row(
        "SELECT revision FROM dashboard_state WHERE id = 1",
        [],
        |row| row.get(0),
    )?;
    u64::try_from(revision).map_err(|_| ApiError::internal("Révision locale invalide."))
}

fn read_next_due_at_ms(connection: &Connection) -> Result<Option<i64>, ApiError> {
    connection
        .query_row(
            "SELECT MIN(s.due_at_ms) FROM sources s
             WHERE s.status <> 'refreshing'
               AND EXISTS (
                 SELECT 1 FROM panel_sources ps WHERE ps.source_id = s.id
               )",
            [],
            |row| row.get(0),
        )
        .map_err(ApiError::from)
}

fn read_feed_configuration_preflight(
    connection: &Connection,
    operation_id: Uuid,
    expected_revision: u64,
    panel_id: Uuid,
    kept_source_ids: &[Uuid],
) -> Result<Option<MutationAck>, ApiError> {
    if let Some(revision) = connection
        .query_row(
            "SELECT committed_revision FROM operations WHERE operation_id = ?1",
            [operation_id.as_bytes().as_slice()],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
    {
        return Ok(Some(MutationAck {
            operation_id,
            committed_revision: u64::try_from(revision)
                .map_err(|_| ApiError::internal("Révision locale invalide."))?,
        }));
    }

    let current_revision = read_revision(connection)?;
    if current_revision != expected_revision {
        return Err(ApiError::conflict(format!(
            "La révision attendue {expected_revision} ne correspond pas à la révision locale {current_revision}."
        )));
    }
    validate_configuration_source_ids(kept_source_ids)?;
    assert_panel_kind(connection, panel_id, "feed")?;
    let attached = read_panel_source_ids(connection, panel_id)?
        .into_iter()
        .collect::<HashSet<_>>();
    if kept_source_ids
        .iter()
        .any(|source_id| !attached.contains(source_id))
    {
        return Err(ApiError::invalid(
            "Une source conservée n'est plus rattachée à ce fil.",
        ));
    }
    Ok(None)
}

fn read_due_sources(
    connection: &Connection,
    now_ms: i64,
    limit: u16,
) -> Result<Vec<DueSource>, ApiError> {
    let mut statement = connection.prepare(
        "SELECT s.id, s.feed_url, s.connector_kind,
                s.refresh_interval_seconds, s.due_at_ms
         FROM sources s
         WHERE s.due_at_ms <= ?1 AND s.status <> 'refreshing'
           AND EXISTS (
             SELECT 1 FROM panel_sources ps WHERE ps.source_id = s.id
           )
         ORDER BY s.due_at_ms ASC, s.id ASC LIMIT ?2",
    )?;
    let rows = statement.query_map(params![now_ms, i64::from(limit)], |row| {
        let kind = match row.get::<_, String>(2)?.as_str() {
            "rss" => ConnectorKind::Rss,
            "atom" => ConnectorKind::Atom,
            "news-sitemap" => ConnectorKind::NewsSitemap,
            value => return Err(invalid_column(2, value, "connector kind")),
        };
        Ok(DueSource {
            id: uuid_at(row, 0)?,
            feed_url: row.get(1)?,
            connector_kind: kind,
            refresh_interval_seconds: row.get(3)?,
            due_at_ms: row.get(4)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(ApiError::from)
}

fn read_dashboard(connection: &Connection) -> Result<DashboardState, ApiError> {
    let (layout_json, revision): (Option<String>, i64) = connection.query_row(
        "SELECT layout_json, revision FROM dashboard_state WHERE id = 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    Ok(DashboardState {
        layout: layout_json
            .map(|json| serde_json::from_str(&json))
            .transpose()?,
        revision: u64::try_from(revision)
            .map_err(|_| ApiError::internal("Révision locale invalide."))?,
    })
}

fn read_bootstrap(
    connection: &Connection,
    session_id: Uuid,
) -> Result<BootstrapResponse, ApiError> {
    let dashboard = read_dashboard(connection)?;
    let panels = read_panels(connection)?;
    let sources = read_sources(connection)?;
    let mut first_page_by_panel = BTreeMap::new();
    for panel in &panels {
        if matches!(panel, Panel::Feed { .. }) {
            first_page_by_panel.insert(
                panel.id(),
                read_feed_page(
                    connection,
                    &FeedPageRequest {
                        panel_id: panel.id(),
                        cursor: None,
                        limit: FIRST_PAGE_SIZE,
                    },
                )?,
            );
        }
    }
    Ok(BootstrapResponse {
        session_id,
        revision: dashboard.revision,
        dashboard,
        panels,
        sources,
        first_page_by_panel,
    })
}

fn read_panels(connection: &Connection) -> Result<Vec<Panel>, ApiError> {
    let mut statement = connection.prepare(
        "SELECT id, name, kind, web_url, default_refresh_interval_seconds
         FROM panels ORDER BY position ASC",
    )?;
    let rows = statement.query_map([], |row| {
        let id = uuid_at(row, 0)?;
        let name: String = row.get(1)?;
        let kind: String = row.get(2)?;
        let web_url: Option<String> = row.get(3)?;
        let refresh: u32 = row.get(4)?;
        Ok((id, name, kind, web_url, refresh))
    })?;
    let mut panels = Vec::new();
    for row in rows {
        let (id, name, kind, web_url, refresh) = row?;
        let panel = match kind.as_str() {
            "feed" => Panel::Feed {
                id,
                name,
                source_ids: read_panel_source_ids(connection, id)?,
                default_refresh_interval_seconds: refresh,
            },
            "web" => Panel::Web {
                id,
                name,
                url: web_url.ok_or_else(|| ApiError::internal("Panel web sans URL."))?,
            },
            _ => return Err(ApiError::internal("Type de panel inconnu.")),
        };
        panels.push(panel);
    }
    Ok(panels)
}

fn read_panel(connection: &Connection, panel_id: Uuid) -> Result<Panel, ApiError> {
    let row = connection
        .query_row(
            "SELECT id, name, kind, web_url, default_refresh_interval_seconds
             FROM panels WHERE id = ?1",
            [panel_id.as_bytes().as_slice()],
            |row| {
                Ok((
                    uuid_at(row, 0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, u32>(4)?,
                ))
            },
        )
        .optional()?;
    let (id, name, kind, web_url, refresh) =
        row.ok_or_else(|| ApiError::not_found("Panel introuvable."))?;
    match kind.as_str() {
        "feed" => Ok(Panel::Feed {
            id,
            name,
            source_ids: read_panel_source_ids(connection, id)?,
            default_refresh_interval_seconds: refresh,
        }),
        "web" => Ok(Panel::Web {
            id,
            name,
            url: web_url.ok_or_else(|| ApiError::internal("Panel web sans URL."))?,
        }),
        _ => Err(ApiError::internal("Type de panel inconnu.")),
    }
}

fn read_panel_source_ids(connection: &Connection, panel_id: Uuid) -> Result<Vec<Uuid>, ApiError> {
    let mut statement = connection
        .prepare("SELECT source_id FROM panel_sources WHERE panel_id = ?1 ORDER BY position ASC")?;
    let ids = statement.query_map([panel_id.as_bytes().as_slice()], |row| uuid_at(row, 0))?;
    ids.collect::<Result<Vec<_>, _>>().map_err(ApiError::from)
}

fn read_sources(connection: &Connection) -> Result<Vec<Source>, ApiError> {
    let mut statement = connection.prepare(
        "SELECT s.id, s.name, s.input_url, s.feed_url, s.connector_id,
                s.connector_kind, s.refresh_interval_seconds, s.status,
                s.last_checked_at, s.last_success_at, s.error_message,
                s.baseline_completed_at, s.consecutive_failures, s.next_retry_at,
                s.due_at_ms, s.item_count
         FROM sources s ORDER BY s.created_at ASC, s.id ASC",
    )?;
    let rows = statement.query_map([], row_to_source)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(ApiError::from)
}

fn read_source(connection: &Connection, source_id: Uuid) -> Result<Source, ApiError> {
    connection
        .query_row(
            "SELECT s.id, s.name, s.input_url, s.feed_url, s.connector_id,
                    s.connector_kind, s.refresh_interval_seconds, s.status,
                    s.last_checked_at, s.last_success_at, s.error_message,
                    s.baseline_completed_at, s.consecutive_failures, s.next_retry_at,
                    s.due_at_ms, s.item_count
             FROM sources s WHERE s.id = ?1",
            [source_id.as_bytes().as_slice()],
            row_to_source,
        )
        .optional()?
        .ok_or_else(|| ApiError::not_found("Source introuvable."))
}

fn row_to_source(row: &Row<'_>) -> rusqlite::Result<Source> {
    let connector_kind = match row.get::<_, String>(5)?.as_str() {
        "rss" => ConnectorKind::Rss,
        "atom" => ConnectorKind::Atom,
        "news-sitemap" => ConnectorKind::NewsSitemap,
        value => return Err(invalid_column(5, value, "connector kind")),
    };
    let status = match row.get::<_, String>(7)?.as_str() {
        "idle" => SourceStatus::Idle,
        "refreshing" => SourceStatus::Refreshing,
        "healthy" => SourceStatus::Healthy,
        "error" => SourceStatus::Error,
        value => return Err(invalid_column(7, value, "source status")),
    };
    Ok(Source {
        id: uuid_at(row, 0)?,
        name: row.get(1)?,
        input_url: row.get(2)?,
        feed_url: row.get(3)?,
        connector_id: row.get(4)?,
        connector_kind,
        refresh_interval_seconds: row.get(6)?,
        status,
        last_checked_at: row.get(8)?,
        last_success_at: row.get(9)?,
        error_message: row.get(10)?,
        baseline_completed_at: row.get(11)?,
        consecutive_failures: row.get(12)?,
        next_retry_at: row.get(13)?,
        due_at_ms: row.get(14)?,
        item_count: row.get(15)?,
    })
}

fn read_feed_page(
    connection: &Connection,
    request: &FeedPageRequest,
) -> Result<FeedPage, ApiError> {
    if request.limit == 0 || request.limit > MAX_PAGE_SIZE {
        return Err(ApiError::invalid(format!(
            "Une page doit contenir entre 1 et {MAX_PAGE_SIZE} articles."
        )));
    }
    let is_feed: Option<i64> = connection
        .query_row(
            "SELECT 1 FROM panels WHERE id = ?1 AND kind = 'feed'",
            [request.panel_id.as_bytes().as_slice()],
            |row| row.get(0),
        )
        .optional()?;
    if is_feed.is_none() {
        return Err(ApiError::not_found("Fil introuvable."));
    }

    let cursor = request.cursor.as_deref().map(decode_cursor).transpose()?;
    let requested = usize::from(request.limit);
    let fetch_limit = i64::from(request.limit) + 1;
    let mut statement = if cursor.is_some() {
        connection.prepare(&format!(
            "{} AND (pi.baseline_rank > ?2 OR
                       (pi.baseline_rank = ?2 AND
                         (pi.sort_at_ms < ?3 OR
                           (pi.sort_at_ms = ?3 AND pi.item_id > ?4))))
             ORDER BY pi.baseline_rank ASC, pi.sort_at_ms DESC, pi.item_id ASC LIMIT ?5",
            item_page_select()
        ))?
    } else {
        connection.prepare(&format!(
            "{} ORDER BY pi.baseline_rank ASC, pi.sort_at_ms DESC, pi.item_id ASC LIMIT ?2",
            item_page_select()
        ))?
    };
    let mapped = match cursor {
        Some(cursor) => statement.query_map(
            params![
                request.panel_id.as_bytes().as_slice(),
                cursor.baseline_rank,
                cursor.sort_at_ms,
                cursor.item_id.as_bytes().as_slice(),
                fetch_limit
            ],
            row_to_feed_item_with_sort,
        )?,
        None => statement.query_map(
            params![request.panel_id.as_bytes().as_slice(), fetch_limit],
            row_to_feed_item_with_sort,
        )?,
    };
    let mut rows = mapped.collect::<Result<Vec<_>, _>>()?;
    let has_more = rows.len() > requested;
    rows.truncate(requested);
    let next_cursor = if has_more {
        rows.last()
            .map(|(item, baseline_rank, sort_at_ms)| {
                encode_cursor(*baseline_rank, *sort_at_ms, item.id)
            })
            .transpose()?
    } else {
        None
    };
    Ok(FeedPage {
        revision: read_revision(connection)?,
        items: rows.into_iter().map(|(item, _, _)| item).collect(),
        next_cursor,
    })
}

fn item_page_select() -> &'static str {
    "SELECT i.id, i.source_id, i.canonical_url, i.title, i.summary, i.image_url,
            i.published_at, i.updated_at, i.first_seen_at, i.arrival_batch_at,
            i.last_seen_at, i.is_baseline, i.seen_at, i.opened_at,
            pi.baseline_rank, pi.sort_at_ms
     FROM panel_items pi JOIN items i ON i.id = pi.item_id
     WHERE pi.panel_id = ?1"
}

fn row_to_feed_item_with_sort(row: &Row<'_>) -> rusqlite::Result<(FeedItem, i64, i64)> {
    let is_baseline = row.get::<_, i64>(11)? != 0;
    let seen_at: Option<String> = row.get(12)?;
    let first_seen_at: String = row.get(8)?;
    Ok((
        FeedItem {
            id: uuid_at(row, 0)?,
            source_id: uuid_at(row, 1)?,
            canonical_url: row.get(2)?,
            title: row.get(3)?,
            summary: row.get(4)?,
            image_url: row.get(5)?,
            published_at: row.get(6)?,
            updated_at: row.get(7)?,
            first_seen_at: first_seen_at.clone(),
            observed_at: first_seen_at,
            arrival_batch_at: row.get(9)?,
            last_seen_at: row.get(10)?,
            is_baseline,
            is_new: !is_baseline && seen_at.is_none(),
            seen_at,
            opened_at: row.get(13)?,
        },
        row.get(14)?,
        row.get(15)?,
    ))
}

fn read_item(connection: &Connection, item_id: Uuid) -> Result<FeedItem, ApiError> {
    let row = connection
        .query_row(
            "SELECT i.id, i.source_id, i.canonical_url, i.title, i.summary, i.image_url,
                    i.published_at, i.updated_at, i.first_seen_at, i.arrival_batch_at,
                    i.last_seen_at, i.is_baseline, i.seen_at, i.opened_at, 0, 0
             FROM items i WHERE i.id = ?1",
            [item_id.as_bytes().as_slice()],
            |row| row_to_feed_item_with_sort(row).map(|(item, _, _)| item),
        )
        .optional()?;
    row.ok_or_else(|| ApiError::not_found("Article introuvable."))
}

fn validate_search_projection_limit(limit: u16) -> Result<(), ApiError> {
    if limit == 0 || limit > MAX_SEARCH_PROJECTION_PAGE_SIZE {
        return Err(ApiError::invalid(format!(
            "Une page d'indexation doit contenir entre 1 et {MAX_SEARCH_PROJECTION_PAGE_SIZE} articles."
        )));
    }
    Ok(())
}

fn normalize_search_item_ids(item_ids: Vec<Uuid>, maximum: u16) -> Result<Vec<Uuid>, ApiError> {
    if item_ids.len() > usize::from(maximum) || item_ids.iter().any(Uuid::is_nil) {
        return Err(ApiError::invalid(format!(
            "Une lecture ciblée accepte au maximum {maximum} identifiants valides."
        )));
    }
    let mut seen = HashSet::with_capacity(item_ids.len());
    Ok(item_ids
        .into_iter()
        .filter(|item_id| seen.insert(*item_id))
        .collect())
}

fn read_search_documents_page(
    connection: &Connection,
    scope: SearchProjectionScope,
    cursor: Option<Uuid>,
    limit: u16,
) -> Result<SearchDocumentPage, ApiError> {
    validate_search_projection_limit(limit)?;
    let cursor_bytes = cursor.map(|item_id| item_id.as_bytes().to_vec());
    let mut documents = match scope {
        SearchProjectionScope::All => {
            let mut statement = connection.prepare(
                "SELECT i.id, i.title, i.summary, s.name
                 FROM items i JOIN sources s ON s.id = i.source_id
                 WHERE (?1 IS NULL OR i.id > ?1)
                 ORDER BY i.id ASC LIMIT ?2",
            )?;
            let rows = statement
                .query_map(
                    params![cursor_bytes.as_deref(), i64::from(limit)],
                    row_to_search_document,
                )?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        }
        SearchProjectionScope::Source(source_id) => {
            let mut statement = connection.prepare(
                "SELECT i.id, i.title, i.summary, s.name
                 FROM items i JOIN sources s ON s.id = i.source_id
                 WHERE i.source_id = ?1 AND (?2 IS NULL OR i.id > ?2)
                 ORDER BY i.id ASC LIMIT ?3",
            )?;
            let rows = statement
                .query_map(
                    params![
                        source_id.as_bytes().as_slice(),
                        cursor_bytes.as_deref(),
                        i64::from(limit)
                    ],
                    row_to_search_document,
                )?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        }
        SearchProjectionScope::Panel(panel_id) => {
            let mut statement = connection.prepare(
                "SELECT i.id, i.title, i.summary, s.name
                 FROM panel_items pi
                 JOIN items i ON i.id = pi.item_id
                 JOIN sources s ON s.id = i.source_id
                 WHERE pi.panel_id = ?1 AND (?2 IS NULL OR i.id > ?2)
                 ORDER BY i.id ASC LIMIT ?3",
            )?;
            let rows = statement
                .query_map(
                    params![
                        panel_id.as_bytes().as_slice(),
                        cursor_bytes.as_deref(),
                        i64::from(limit)
                    ],
                    row_to_search_document,
                )?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        }
    };
    populate_search_panel_scopes(connection, &mut documents)?;
    let next_cursor = (documents.len() == usize::from(limit))
        .then(|| documents.last().map(|document| document.item_id))
        .flatten();
    Ok(SearchDocumentPage {
        documents,
        next_cursor,
    })
}

fn read_search_documents_by_ids(
    connection: &Connection,
    item_ids: &[Uuid],
) -> Result<Vec<SearchDocument>, ApiError> {
    if item_ids.is_empty() {
        return Ok(Vec::new());
    }
    if item_ids.len() > usize::from(MAX_SEARCH_RESULTS) {
        return Err(ApiError::invalid(format!(
            "Une lecture ciblée accepte au maximum {MAX_SEARCH_RESULTS} articles."
        )));
    }
    let placeholders = sql_placeholders(item_ids.len());
    let sql = format!(
        "SELECT i.id, i.title, i.summary, s.name
         FROM items i JOIN sources s ON s.id = i.source_id
         WHERE i.id IN ({placeholders}) ORDER BY i.id ASC"
    );
    let blobs = uuid_blobs(item_ids);
    let mut statement = connection.prepare(&sql)?;
    let mut documents = statement
        .query_map(
            rusqlite::params_from_iter(blobs.iter().map(Vec::as_slice)),
            row_to_search_document,
        )?
        .collect::<Result<Vec<_>, _>>()?;
    populate_search_panel_scopes(connection, &mut documents)?;
    let mut by_id = documents
        .into_iter()
        .map(|document| (document.item_id, document))
        .collect::<HashMap<_, _>>();
    Ok(item_ids
        .iter()
        .filter_map(|item_id| by_id.remove(item_id))
        .collect())
}

fn row_to_search_document(row: &Row<'_>) -> rusqlite::Result<SearchDocument> {
    Ok(SearchDocument {
        item_id: uuid_at(row, 0)?,
        title: row.get(1)?,
        summary: row.get(2)?,
        source_name: row.get(3)?,
        panel_ids: Vec::new(),
    })
}

fn populate_search_panel_scopes(
    connection: &Connection,
    documents: &mut [SearchDocument],
) -> Result<(), ApiError> {
    if documents.is_empty() {
        return Ok(());
    }
    let item_ids = documents
        .iter()
        .map(|document| document.item_id)
        .collect::<Vec<_>>();
    let placeholders = sql_placeholders(item_ids.len());
    let sql = format!(
        "SELECT item_id, panel_id FROM panel_items
         WHERE item_id IN ({placeholders}) ORDER BY item_id ASC, panel_id ASC"
    );
    let blobs = uuid_blobs(&item_ids);
    let mut statement = connection.prepare(&sql)?;
    let rows = statement.query_map(
        rusqlite::params_from_iter(blobs.iter().map(Vec::as_slice)),
        |row| Ok((uuid_at(row, 0)?, uuid_at(row, 1)?)),
    )?;
    let positions = documents
        .iter()
        .enumerate()
        .map(|(index, document)| (document.item_id, index))
        .collect::<HashMap<_, _>>();
    for row in rows {
        let (item_id, panel_id) = row?;
        if let Some(index) = positions.get(&item_id) {
            documents[*index].panel_ids.push(panel_id);
        }
    }
    Ok(())
}

fn read_search_results(
    connection: &Connection,
    hits: Vec<SearchHit>,
) -> Result<SearchHydration, ApiError> {
    if hits.len() > usize::from(MAX_SEARCH_RESULTS) {
        return Err(ApiError::invalid(format!(
            "Une hydratation de recherche accepte au maximum {MAX_SEARCH_RESULTS} résultats."
        )));
    }
    let item_ids = hits.iter().map(|hit| hit.item_id).collect::<Vec<_>>();
    let items = read_items_by_ids(connection, &item_ids)?;
    let by_id = items
        .into_iter()
        .map(|item| (item.id, item))
        .collect::<HashMap<_, _>>();
    let mut results = Vec::with_capacity(hits.len());
    let mut missing_item_ids = Vec::new();
    for hit in hits {
        if let Some(item) = by_id.get(&hit.item_id) {
            results.push(SearchResult {
                item: item.clone(),
                score_micros: hit.score_micros,
            });
        } else {
            missing_item_ids.push(hit.item_id);
        }
    }
    Ok(SearchHydration {
        results,
        missing_item_ids,
    })
}

fn read_items_by_ids(
    connection: &Connection,
    item_ids: &[Uuid],
) -> Result<Vec<FeedItem>, ApiError> {
    if item_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = sql_placeholders(item_ids.len());
    let sql = format!(
        "SELECT i.id, i.source_id, i.canonical_url, i.title, i.summary, i.image_url,
                i.published_at, i.updated_at, i.first_seen_at, i.arrival_batch_at,
                i.last_seen_at, i.is_baseline, i.seen_at, i.opened_at, 0, 0
         FROM items i WHERE i.id IN ({placeholders})"
    );
    let blobs = uuid_blobs(item_ids);
    let mut statement = connection.prepare(&sql)?;
    let items = statement
        .query_map(
            rusqlite::params_from_iter(blobs.iter().map(Vec::as_slice)),
            |row| row_to_feed_item_with_sort(row).map(|(item, _, _)| item),
        )?
        .collect::<Result<Vec<_>, _>>()
        .map_err(ApiError::from)?;
    Ok(items)
}

fn sql_placeholders(count: usize) -> String {
    std::iter::repeat_n("?", count)
        .collect::<Vec<_>>()
        .join(",")
}

fn uuid_blobs(item_ids: &[Uuid]) -> Vec<Vec<u8>> {
    item_ids
        .iter()
        .map(|item_id| item_id.as_bytes().to_vec())
        .collect()
}

fn apply_mutation(
    connection: &mut Connection,
    session_id: Uuid,
    request: crate::model::MutateRequest,
) -> Result<MutationResult, ApiError> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if let Some(revision) = transaction
        .query_row(
            "SELECT committed_revision FROM operations WHERE operation_id = ?1",
            [request.operation_id.as_bytes().as_slice()],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
    {
        transaction.commit()?;
        return Ok(MutationResult {
            ack: MutationAck {
                operation_id: request.operation_id,
                committed_revision: u64::try_from(revision)
                    .map_err(|_| ApiError::internal("Révision locale invalide."))?,
            },
            patch: None,
        });
    }

    let current_revision = read_revision(&transaction)?;
    if request.expected_revision != current_revision {
        return Err(ApiError::conflict(format!(
            "La révision attendue {} ne correspond pas à la révision locale {current_revision}.",
            request.expected_revision
        )));
    }
    let next_revision = current_revision
        .checked_add(1)
        .ok_or_else(|| ApiError::internal("Compteur de révision saturé."))?;

    let mut changes = Vec::new();
    match request.command {
        MutationCommand::CreatePanel { input, placement } => {
            let panel_count: i64 =
                transaction.query_row("SELECT COUNT(*) FROM panels", [], |row| row.get(0))?;
            if panel_count >= MAX_PANELS {
                return Err(ApiError::invalid(format!(
                    "VibeDeck accepte au maximum {MAX_PANELS} panels."
                )));
            }
            let dashboard = read_dashboard(&transaction)?;
            validate_layout(&transaction, &dashboard.layout)?;
            let panel_id = Uuid::new_v4();
            let timestamp = now();
            let position: i64 = transaction.query_row(
                "SELECT COALESCE(MAX(position), -1) + 1 FROM panels",
                [],
                |row| row.get(0),
            )?;
            match input {
                CreatePanelInput::Feed {
                    name,
                    default_refresh_interval_seconds,
                } => {
                    let name = clean_panel_name(&name)?;
                    let refresh = clean_refresh_interval(
                        default_refresh_interval_seconds
                            .unwrap_or(DEFAULT_REFRESH_INTERVAL_SECONDS),
                    )?;
                    transaction.execute(
                        "INSERT INTO panels (id, name, position, kind, web_url,
                          default_refresh_interval_seconds, created_at, updated_at)
                         VALUES (?1, ?2, ?3, 'feed', NULL, ?4, ?5, ?5)",
                        params![
                            panel_id.as_bytes().as_slice(),
                            name,
                            position,
                            refresh,
                            timestamp
                        ],
                    )?;
                }
                CreatePanelInput::Web { name, url } => {
                    let name = clean_panel_name(&name)?;
                    let url = clean_http_url(&url)?;
                    transaction.execute(
                        "INSERT INTO panels (id, name, position, kind, web_url,
                          default_refresh_interval_seconds, created_at, updated_at)
                         VALUES (?1, ?2, ?3, 'web', ?4, ?5, ?6, ?6)",
                        params![
                            panel_id.as_bytes().as_slice(),
                            name,
                            position,
                            url,
                            DEFAULT_REFRESH_INTERVAL_SECONDS,
                            timestamp
                        ],
                    )?;
                }
            }
            let layout = if panel_count == 0 {
                if placement.is_some() || dashboard.layout.is_some() {
                    return Err(ApiError::invalid(
                        "Le premier panel ne doit pas cibler un emplacement existant.",
                    ));
                }
                Some(LayoutNode::Panel { panel_id })
            } else {
                let placement = placement.ok_or_else(|| {
                    ApiError::invalid("Un emplacement est requis pour ajouter ce panel.")
                })?;
                let root = dashboard
                    .layout
                    .ok_or_else(|| ApiError::internal("Le layout du dashboard est introuvable."))?;
                let (layout, inserted) =
                    insert_panel_into_layout(root, &placement, panel_id, Uuid::new_v4());
                if !inserted {
                    return Err(ApiError::not_found("Panel cible introuvable."));
                }
                Some(layout)
            };
            validate_layout(&transaction, &layout)?;
            write_layout(&transaction, &layout)?;
            changes.push(StateChange::PanelUpsert {
                panel: read_panel(&transaction, panel_id)?,
            });
            changes.push(StateChange::Dashboard {
                dashboard: DashboardState {
                    layout,
                    revision: next_revision,
                },
            });
        }
        MutationCommand::DeletePanel { panel_id } => {
            let dashboard = read_dashboard(&transaction)?;
            validate_layout(&transaction, &dashboard.layout)?;
            let root = dashboard
                .layout
                .ok_or_else(|| ApiError::not_found("Panel introuvable."))?;
            let (layout, removed) = remove_panel_from_layout(root, panel_id);
            if !removed {
                return Err(ApiError::not_found("Panel introuvable."));
            }
            if transaction.execute(
                "DELETE FROM panels WHERE id = ?1",
                [panel_id.as_bytes().as_slice()],
            )? == 0
            {
                return Err(ApiError::not_found("Panel introuvable."));
            }
            validate_layout(&transaction, &layout)?;
            write_layout(&transaction, &layout)?;
            changes.push(StateChange::PanelRemove { panel_id });
            changes.push(StateChange::Dashboard {
                dashboard: DashboardState {
                    layout,
                    revision: next_revision,
                },
            });
        }
        MutationCommand::SetWebPanelUrl { panel_id, url } => {
            let url = clean_http_url(&url)?;
            let changed = transaction.execute(
                "UPDATE panels SET web_url = ?1, updated_at = ?2
                 WHERE id = ?3 AND kind = 'web' AND web_url <> ?1",
                params![url, now(), panel_id.as_bytes().as_slice()],
            )?;
            if changed == 0 {
                assert_panel_kind(&transaction, panel_id, "web")?;
            } else {
                changes.push(StateChange::PanelUpsert {
                    panel: read_panel(&transaction, panel_id)?,
                });
            }
        }
        MutationCommand::SetFeedPanelDefaultRefresh {
            panel_id,
            refresh_interval_seconds,
        } => {
            let refresh = clean_refresh_interval(refresh_interval_seconds)?;
            let changed = transaction.execute(
                "UPDATE panels SET default_refresh_interval_seconds = ?1, updated_at = ?2
                 WHERE id = ?3 AND kind = 'feed'
                   AND default_refresh_interval_seconds <> ?1",
                params![refresh, now(), panel_id.as_bytes().as_slice()],
            )?;
            if changed == 0 {
                assert_panel_kind(&transaction, panel_id, "feed")?;
            } else {
                changes.push(StateChange::PanelUpsert {
                    panel: read_panel(&transaction, panel_id)?,
                });
            }
        }
        MutationCommand::AddGenericSource {
            panel_id,
            source,
            position,
        } => {
            assert_panel_kind(&transaction, panel_id, "feed")?;
            let GenericSourceInput {
                name,
                input_url,
                feed_url,
                connector_kind,
                refresh_interval_seconds,
            } = source;
            let name = clean_source_name(&name)?;
            let input_url = clean_http_url(&input_url)?;
            let feed_url = clean_http_url(&feed_url)?;
            let refresh_interval_seconds = clean_refresh_interval(refresh_interval_seconds)?;
            let existing: Option<Uuid> = transaction
                .query_row(
                    "SELECT id FROM sources WHERE feed_url = ?1",
                    [&feed_url],
                    |row| uuid_at(row, 0),
                )
                .optional()?;
            if existing.is_some() {
                return Err(ApiError::invalid(
                    "Cette source existe déjà et doit être rattachée par son identifiant.",
                ));
            }

            let source_id = Uuid::new_v4();
            let timestamp = now();
            let due_at_ms = timestamp_millis(&timestamp)?;
            transaction.execute(
                "INSERT INTO sources (id, name, input_url, feed_url, connector_id,
                  connector_kind, refresh_interval_seconds, status, last_checked_at,
                  last_success_at, error_message, baseline_completed_at,
                  consecutive_failures, next_retry_at, due_at_ms, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, 'idle', NULL, NULL, NULL,
                  NULL, 0, NULL, ?7, ?8, ?8)",
                params![
                    source_id.as_bytes().as_slice(),
                    name,
                    input_url,
                    feed_url,
                    connector_kind_sql(connector_kind),
                    refresh_interval_seconds,
                    due_at_ms,
                    timestamp
                ],
            )?;
            attach_source_to_panel(&transaction, panel_id, source_id, position)?;
            changes.push(StateChange::SourceUpsert {
                source: read_source(&transaction, source_id)?,
            });
            changes.push(StateChange::PanelUpsert {
                panel: read_panel(&transaction, panel_id)?,
            });
        }
        MutationCommand::AttachSource {
            panel_id,
            source_id,
            position,
        } => {
            let materialized_items =
                attach_source_to_panel(&transaction, panel_id, source_id, position)?;
            changes.push(StateChange::PanelUpsert {
                panel: read_panel(&transaction, panel_id)?,
            });
            if materialized_items > 0 {
                changes.push(StateChange::PanelInvalidated {
                    panel_id,
                    reason: "sourceAttached".to_owned(),
                });
            }
        }
        MutationCommand::DetachSource {
            panel_id,
            source_id,
        } => {
            let removed_items = detach_source_from_panel(&transaction, panel_id, source_id)?;
            changes.push(StateChange::PanelUpsert {
                panel: read_panel(&transaction, panel_id)?,
            });
            if removed_items > 0 {
                changes.push(StateChange::PanelInvalidated {
                    panel_id,
                    reason: "sourceDetached".to_owned(),
                });
            }
        }
        MutationCommand::SaveFeedPanelConfiguration {
            panel_id,
            name,
            default_refresh_interval_seconds,
            kept_source_ids,
            new_sources,
        } => {
            apply_feed_panel_configuration(
                &transaction,
                panel_id,
                &name,
                default_refresh_interval_seconds,
                &kept_source_ids,
                new_sources,
                &mut changes,
            )?;
        }
        MutationCommand::SetLayout { layout } => {
            validate_layout(&transaction, &layout)?;
            let next = serde_json::to_string(&layout)?;
            let current: String = transaction.query_row(
                "SELECT COALESCE(layout_json, 'null') FROM dashboard_state WHERE id = 1",
                [],
                |row| row.get(0),
            )?;
            if next != current {
                transaction.execute(
                    "UPDATE dashboard_state SET layout_json = ?1 WHERE id = 1",
                    [next],
                )?;
                changes.push(StateChange::Dashboard {
                    dashboard: DashboardState {
                        layout,
                        revision: next_revision,
                    },
                });
            }
        }
        MutationCommand::RenamePanel { panel_id, name } => {
            let name = clean_panel_name(&name)?;
            let changed = transaction.execute(
                "UPDATE panels SET name = ?1, updated_at = ?2 WHERE id = ?3 AND name <> ?1",
                params![name, now(), panel_id.as_bytes().as_slice()],
            )?;
            if changed == 0 {
                let exists: Option<i64> = transaction
                    .query_row(
                        "SELECT 1 FROM panels WHERE id = ?1",
                        [panel_id.as_bytes().as_slice()],
                        |row| row.get(0),
                    )
                    .optional()?;
                if exists.is_none() {
                    return Err(ApiError::not_found("Panel introuvable."));
                }
            } else {
                changes.push(StateChange::PanelUpsert {
                    panel: read_panel(&transaction, panel_id)?,
                });
            }
        }
        MutationCommand::MarkItemsSeen { item_ids, at } => {
            if item_ids.len() > MAX_MARKED_ITEMS {
                return Err(ApiError::invalid(format!(
                    "Au maximum {MAX_MARKED_ITEMS} articles peuvent être marqués à la fois."
                )));
            }
            let timestamp = normalize_timestamp(&at)?;
            let mut unique = HashSet::new();
            let mut changed = Vec::new();
            for item_id in item_ids.into_iter().filter(|id| unique.insert(*id)) {
                if transaction.execute(
                    "UPDATE items SET seen_at = ?1 WHERE id = ?2 AND seen_at IS NULL",
                    params![timestamp, item_id.as_bytes().as_slice()],
                )? > 0
                {
                    changed.push(item_id);
                }
            }
            append_read_changes(&transaction, &mut changes, &changed)?;
        }
        MutationCommand::MarkItemOpened { item_id, at } => {
            let timestamp = normalize_timestamp(&at)?;
            if transaction.execute(
                "UPDATE items SET opened_at = COALESCE(opened_at, ?1),
                                  seen_at = COALESCE(seen_at, ?1)
                 WHERE id = ?2",
                params![timestamp, item_id.as_bytes().as_slice()],
            )? == 0
            {
                return Err(ApiError::not_found("Article introuvable."));
            }
            append_read_changes(&transaction, &mut changes, &[item_id])?;
        }
        MutationCommand::ForceRefreshSource { source_id } => {
            let timestamp = now();
            let due_at_ms = timestamp_millis(&timestamp)?;
            if transaction.execute(
                "UPDATE sources SET due_at_ms = ?1, updated_at = ?2 WHERE id = ?3",
                params![due_at_ms, timestamp, source_id.as_bytes().as_slice()],
            )? == 0
            {
                return Err(ApiError::not_found("Source introuvable."));
            }
            changes.push(manual_refresh_change(
                RefreshScope::Source { source_id },
                1,
            )?);
        }
        MutationCommand::ForceRefreshPanel { panel_id } => {
            assert_panel_kind(&transaction, panel_id, "feed")?;
            let source_count: i64 = transaction.query_row(
                "SELECT COUNT(*) FROM panel_sources WHERE panel_id = ?1",
                [panel_id.as_bytes().as_slice()],
                |row| row.get(0),
            )?;
            let source_count = checked_refresh_source_count(source_count, MAX_SOURCES_PER_PANEL)?;
            if source_count > 0 {
                let timestamp = now();
                let due_at_ms = timestamp_millis(&timestamp)?;
                let changed = transaction.execute(
                    "UPDATE sources SET due_at_ms = ?1, updated_at = ?2
                     WHERE id IN (
                       SELECT source_id FROM panel_sources WHERE panel_id = ?3
                     )",
                    params![due_at_ms, timestamp, panel_id.as_bytes().as_slice()],
                )?;
                if changed != source_count {
                    return Err(ApiError::internal(
                        "Les rattachements de sources du panel sont incohérents.",
                    ));
                }
                changes.push(manual_refresh_change(
                    RefreshScope::Panel { panel_id },
                    source_count,
                )?);
            }
        }
        MutationCommand::ForceRefreshAll => {
            let source_count: i64 = transaction.query_row(
                "SELECT COUNT(*) FROM sources s
                 WHERE EXISTS (
                   SELECT 1 FROM panel_sources ps WHERE ps.source_id = s.id
                 )",
                [],
                |row| row.get(0),
            )?;
            let source_count = checked_refresh_source_count(source_count, MAX_ATTACHED_SOURCES)?;
            if source_count > 0 {
                let timestamp = now();
                let due_at_ms = timestamp_millis(&timestamp)?;
                let changed = transaction.execute(
                    "UPDATE sources SET due_at_ms = ?1, updated_at = ?2
                     WHERE EXISTS (
                       SELECT 1 FROM panel_sources ps WHERE ps.source_id = sources.id
                     )",
                    params![due_at_ms, timestamp],
                )?;
                if changed != source_count {
                    return Err(ApiError::internal(
                        "Les rattachements globaux de sources sont incohérents.",
                    ));
                }
                changes.push(manual_refresh_change(RefreshScope::All, source_count)?);
            }
        }
    }

    let committed_revision = if changes.is_empty() {
        current_revision
    } else {
        next_revision
    };
    let patch = if changes.is_empty() {
        None
    } else {
        let patch = StatePatch {
            session_id,
            base_revision: current_revision,
            revision: committed_revision,
            operation_id: request.operation_id,
            changes,
        };
        if serde_json::to_vec(&patch)?.len() > MAX_PATCH_BYTES {
            return Err(ApiError::invalid("Le patch dépasse la limite de 256 Kio."));
        }
        let committed_revision_i64 = i64::try_from(committed_revision)
            .map_err(|_| ApiError::internal("Compteur de révision saturé."))?;
        transaction.execute(
            "UPDATE dashboard_state SET revision = ?1, updated_at = ?2 WHERE id = 1",
            params![committed_revision_i64, now()],
        )?;
        Some(patch)
    };
    let committed_revision_i64 = i64::try_from(committed_revision)
        .map_err(|_| ApiError::internal("Compteur de révision saturé."))?;
    transaction.execute(
        "INSERT INTO operations (operation_id, committed_revision, created_at)
         VALUES (?1, ?2, ?3)",
        params![
            request.operation_id.as_bytes().as_slice(),
            committed_revision_i64,
            now()
        ],
    )?;
    transaction.execute(
        "DELETE FROM operations WHERE operation_id IN (
           SELECT operation_id FROM operations ORDER BY created_at DESC LIMIT -1 OFFSET 4096
         )",
        [],
    )?;
    transaction.commit()?;
    Ok(MutationResult {
        ack: MutationAck {
            operation_id: request.operation_id,
            committed_revision,
        },
        patch,
    })
}

#[derive(Debug)]
struct NormalizedParsedItem {
    canonical_url: String,
    title: String,
    summary: Option<String>,
    image_url: Option<String>,
    published_at: Option<String>,
    updated_at: Option<String>,
}

#[derive(Debug)]
struct StoredItemProjection {
    id: Uuid,
    title: String,
    summary: Option<String>,
    image_url: Option<String>,
    published_at: Option<String>,
    updated_at: Option<String>,
    first_seen_at: String,
    is_baseline: bool,
}

fn apply_feed_ingestion(
    connection: &mut Connection,
    session_id: Uuid,
    request: IngestFeedRequest,
) -> Result<MutationResult, ApiError> {
    let IngestFeedRequest {
        operation_id,
        source_id,
        observed_at,
        feed,
    } = request;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if let Some(revision) = transaction
        .query_row(
            "SELECT committed_revision FROM operations WHERE operation_id = ?1",
            [operation_id.as_bytes().as_slice()],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
    {
        transaction.commit()?;
        return Ok(MutationResult {
            ack: MutationAck {
                operation_id,
                committed_revision: u64::try_from(revision)
                    .map_err(|_| ApiError::internal("Révision locale invalide."))?,
            },
            patch: None,
        });
    }

    let observed_at = normalize_timestamp(&observed_at)?;
    let observed_at_ms = timestamp_millis(&observed_at)?;
    let ParsedFeed {
        kind: feed_kind,
        title: _,
        items,
    } = feed;
    let items = normalize_parsed_items(items)?;

    let current_revision = read_revision(&transaction)?;
    let next_revision = current_revision
        .checked_add(1)
        .ok_or_else(|| ApiError::internal("Compteur de révision saturé."))?;
    let source_configuration = transaction
        .query_row(
            "SELECT connector_kind, refresh_interval_seconds, baseline_completed_at
             FROM sources WHERE id = ?1",
            [source_id.as_bytes().as_slice()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, u32>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| ApiError::not_found("Source introuvable."))?;
    if source_configuration.0 != connector_kind_sql(feed_kind) {
        return Err(ApiError::invalid(
            "Le flux parsé ne correspond pas au type de cette source.",
        ));
    }
    let is_initial_import = source_configuration.2.is_none();
    let due_at_ms = observed_at_ms
        .checked_add(i64::from(source_configuration.1) * 1_000)
        .ok_or_else(|| ApiError::invalid("Date de prochaine actualisation invalide."))?;
    let attached_panel_ids = read_attached_panel_ids(&transaction, source_id)?;
    let mut visible_item_ids = Vec::new();
    let mut inserted_count = 0usize;

    {
        let mut find_item = transaction.prepare(
            "SELECT id, title, summary, image_url, published_at, updated_at,
                    first_seen_at, is_baseline
             FROM items WHERE source_id = ?1 AND canonical_url = ?2",
        )?;
        for item in items {
            let stored = find_item
                .query_row(
                    params![source_id.as_bytes().as_slice(), item.canonical_url],
                    |row| {
                        Ok(StoredItemProjection {
                            id: uuid_at(row, 0)?,
                            title: row.get(1)?,
                            summary: row.get(2)?,
                            image_url: row.get(3)?,
                            published_at: row.get(4)?,
                            updated_at: row.get(5)?,
                            first_seen_at: row.get(6)?,
                            is_baseline: row.get::<_, i64>(7)? != 0,
                        })
                    },
                )
                .optional()?;

            let (item_id, baseline_rank, sort_at_ms, is_visibly_changed) =
                if let Some(stored) = stored {
                    let summary = item.summary.or(stored.summary.clone());
                    let image_url = item.image_url.or(stored.image_url.clone());
                    let published_at = item.published_at.or(stored.published_at.clone());
                    let updated_at = item.updated_at.or(stored.updated_at.clone());
                    let is_visibly_changed = stored.title != item.title
                        || stored.summary != summary
                        || stored.image_url != image_url
                        || stored.published_at != published_at
                        || stored.updated_at != updated_at;
                    transaction.execute(
                        "UPDATE items SET title = ?1, summary = ?2, image_url = ?3,
                      published_at = ?4, updated_at = ?5, last_seen_at = ?6
                     WHERE id = ?7",
                        params![
                            item.title,
                            summary,
                            image_url,
                            published_at,
                            updated_at,
                            observed_at,
                            stored.id.as_bytes().as_slice()
                        ],
                    )?;
                    let sort_at_ms = stored_item_sort_at_ms(
                        published_at.as_deref(),
                        updated_at.as_deref(),
                        &stored.first_seen_at,
                    )?;
                    (
                        stored.id,
                        i64::from(stored.is_baseline),
                        sort_at_ms,
                        is_visibly_changed,
                    )
                } else {
                    let item_id = Uuid::new_v4();
                    let is_baseline = is_initial_import;
                    let seen_at = is_baseline.then_some(observed_at.as_str());
                    let sort_at_ms = stored_item_sort_at_ms(
                        item.published_at.as_deref(),
                        item.updated_at.as_deref(),
                        &observed_at,
                    )?;
                    transaction.execute(
                        "INSERT INTO items (id, source_id, canonical_url, title, summary,
                      image_url, published_at, updated_at, first_seen_at, arrival_batch_at,
                      last_seen_at, is_baseline, seen_at, opened_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?9, ?10, ?11, NULL)",
                        params![
                            item_id.as_bytes().as_slice(),
                            source_id.as_bytes().as_slice(),
                            item.canonical_url,
                            item.title,
                            item.summary,
                            item.image_url,
                            item.published_at,
                            item.updated_at,
                            observed_at,
                            i64::from(is_baseline),
                            seen_at
                        ],
                    )?;
                    inserted_count += 1;
                    (item_id, i64::from(is_baseline), sort_at_ms, true)
                };

            for panel_id in &attached_panel_ids {
                transaction.execute(
                    "INSERT INTO panel_items (panel_id, item_id, baseline_rank, sort_at_ms)
                     VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(panel_id, item_id) DO UPDATE
                       SET baseline_rank = excluded.baseline_rank,
                           sort_at_ms = excluded.sort_at_ms",
                    params![
                        panel_id.as_bytes().as_slice(),
                        item_id.as_bytes().as_slice(),
                        baseline_rank,
                        sort_at_ms
                    ],
                )?;
            }
            if is_visibly_changed {
                visible_item_ids.push(item_id);
            }
        }
    }

    let baseline_completed_at =
        (is_initial_import && inserted_count > 0).then_some(observed_at.as_str());
    transaction.execute(
        "UPDATE sources SET status = 'healthy', last_checked_at = ?1,
          last_success_at = ?1, error_message = NULL,
          baseline_completed_at = COALESCE(baseline_completed_at, ?2),
          consecutive_failures = 0, next_retry_at = NULL, due_at_ms = ?3,
          updated_at = ?1 WHERE id = ?4",
        params![
            observed_at,
            baseline_completed_at,
            due_at_ms,
            source_id.as_bytes().as_slice()
        ],
    )?;
    let source = read_source(&transaction, source_id)?;
    let mut invalidate_panels =
        !attached_panel_ids.is_empty() && visible_item_ids.len() > MAX_VISIBLE_INGEST_ITEMS;
    let mut visible_items = Vec::new();
    if !attached_panel_ids.is_empty() && !invalidate_panels {
        visible_items.reserve(visible_item_ids.len());
        for item_id in visible_item_ids {
            match read_item(&transaction, item_id) {
                Ok(item) => visible_items.push(item),
                Err(error) if error.code == "not_found" => {}
                Err(error) => return Err(error),
            }
        }
    }
    let mut changes = vec![StateChange::SourceUpsert { source }];
    if !invalidate_panels && !visible_items.is_empty() {
        changes.push(StateChange::ItemsUpsert {
            items: visible_items,
        });
        let projected_patch = StatePatch {
            session_id,
            base_revision: current_revision,
            revision: next_revision,
            operation_id,
            changes: changes.clone(),
        };
        if serde_json::to_vec(&projected_patch)?.len() > MAX_PATCH_BYTES {
            changes.pop();
            invalidate_panels = true;
        }
    }
    if invalidate_panels {
        changes.extend(
            attached_panel_ids
                .iter()
                .map(|panel_id| StateChange::PanelInvalidated {
                    panel_id: *panel_id,
                    reason: "feedIngested".to_owned(),
                }),
        );
    }

    let patch = StatePatch {
        session_id,
        base_revision: current_revision,
        revision: next_revision,
        operation_id,
        changes,
    };
    if serde_json::to_vec(&patch)?.len() > MAX_PATCH_BYTES {
        return Err(ApiError::invalid("Le patch dépasse la limite de 256 Kio."));
    }
    let next_revision_i64 = i64::try_from(next_revision)
        .map_err(|_| ApiError::internal("Compteur de révision saturé."))?;
    transaction.execute(
        "UPDATE dashboard_state SET revision = ?1, updated_at = ?2 WHERE id = 1",
        params![next_revision_i64, now()],
    )?;
    transaction.execute(
        "INSERT INTO operations (operation_id, committed_revision, created_at)
         VALUES (?1, ?2, ?3)",
        params![operation_id.as_bytes().as_slice(), next_revision_i64, now()],
    )?;
    transaction.execute(
        "DELETE FROM operations WHERE operation_id IN (
           SELECT operation_id FROM operations ORDER BY created_at DESC LIMIT -1 OFFSET 4096
         )",
        [],
    )?;
    transaction.commit()?;
    Ok(MutationResult {
        ack: MutationAck {
            operation_id,
            committed_revision: next_revision,
        },
        patch: Some(patch),
    })
}

fn normalize_parsed_items(
    items: Vec<ParsedFeedItem>,
) -> Result<Vec<NormalizedParsedItem>, ApiError> {
    if items.len() > MAX_ITEMS_PER_INGESTION {
        return Err(ApiError::invalid(format!(
            "Un résultat de flux accepte au maximum {MAX_ITEMS_PER_INGESTION} articles."
        )));
    }
    let mut canonical_urls = HashSet::with_capacity(items.len());
    let mut normalized = Vec::with_capacity(items.len());
    for item in items {
        let canonical_url = clean_http_url(&item.canonical_url)?;
        if !canonical_urls.insert(canonical_url.clone()) {
            return Err(ApiError::invalid("Article dupliqué dans le flux parsé."));
        }
        let title = item.title.trim();
        if title.is_empty() || title.chars().count() > MAX_ITEM_TITLE_CHARS {
            return Err(ApiError::invalid("Titre d'article invalide."));
        }
        normalized.push(NormalizedParsedItem {
            canonical_url,
            title: title.to_owned(),
            summary: clean_optional_item_text(item.summary)?,
            image_url: item.image_url.as_deref().map(clean_http_url).transpose()?,
            published_at: item
                .published_at
                .as_deref()
                .map(normalize_timestamp)
                .transpose()?,
            updated_at: item
                .updated_at
                .as_deref()
                .map(normalize_timestamp)
                .transpose()?,
        });
    }
    Ok(normalized)
}

fn clean_optional_item_text(value: Option<String>) -> Result<Option<String>, ApiError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > MAX_ITEM_TEXT_BYTES {
        return Err(ApiError::invalid("Contenu d'article trop volumineux."));
    }
    Ok(Some(value.to_owned()))
}

fn read_attached_panel_ids(
    connection: &Connection,
    source_id: Uuid,
) -> Result<Vec<Uuid>, ApiError> {
    let mut statement = connection
        .prepare("SELECT panel_id FROM panel_sources WHERE source_id = ?1 ORDER BY panel_id ASC")?;
    let panel_ids = statement
        .query_map([source_id.as_bytes().as_slice()], |row| uuid_at(row, 0))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(ApiError::from)?;
    Ok(panel_ids)
}

fn apply_source_refresh_transition(
    connection: &mut Connection,
    session_id: Uuid,
    request: SourceRefreshRequest,
) -> Result<Option<MutationResult>, ApiError> {
    let SourceRefreshRequest {
        operation_id,
        source_id,
        at_ms,
        transition,
    } = request;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if let Some(revision) = transaction
        .query_row(
            "SELECT committed_revision FROM operations WHERE operation_id = ?1",
            [operation_id.as_bytes().as_slice()],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
    {
        transaction.commit()?;
        return Ok(Some(MutationResult {
            ack: MutationAck {
                operation_id,
                committed_revision: u64::try_from(revision)
                    .map_err(|_| ApiError::internal("Révision locale invalide."))?,
            },
            patch: None,
        }));
    }

    let at = timestamp_from_millis(at_ms)?;
    let current_revision = read_revision(&transaction)?;
    let next_revision = current_revision
        .checked_add(1)
        .ok_or_else(|| ApiError::internal("Compteur de révision saturé."))?;
    match transition {
        SourceRefreshTransition::Begin => {
            let changed = transaction.execute(
                "UPDATE sources SET status = 'refreshing', updated_at = ?1
                 WHERE id = ?2 AND due_at_ms <= ?3 AND status <> 'refreshing'
                   AND EXISTS (
                     SELECT 1 FROM panel_sources ps WHERE ps.source_id = sources.id
                   )",
                params![at, source_id.as_bytes().as_slice(), at_ms],
            )?;
            if changed == 0 {
                transaction.commit()?;
                return Ok(None);
            }
        }
        SourceRefreshTransition::Success => {
            let (status, refresh_interval_seconds) = read_refresh_state(&transaction, source_id)?;
            if status != "refreshing" {
                return Err(ApiError::invalid(
                    "Cette source n'est pas en cours d'actualisation.",
                ));
            }
            let due_at_ms = regular_due_at_ms(at_ms, refresh_interval_seconds)?;
            transaction.execute(
                "UPDATE sources SET status = 'healthy', last_checked_at = ?1,
                  last_success_at = ?1, error_message = NULL, consecutive_failures = 0,
                  next_retry_at = NULL, due_at_ms = ?2, updated_at = ?1
                 WHERE id = ?3",
                params![at, due_at_ms, source_id.as_bytes().as_slice()],
            )?;
        }
        SourceRefreshTransition::Failure { error_message } => {
            let error_message = clean_source_error(&error_message)?;
            let (status, refresh_interval_seconds, consecutive_failures): (String, u32, u32) =
                transaction
                    .query_row(
                        "SELECT status, refresh_interval_seconds, consecutive_failures
                         FROM sources WHERE id = ?1",
                        [source_id.as_bytes().as_slice()],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .optional()?
                    .ok_or_else(|| ApiError::not_found("Source introuvable."))?;
            if status != "refreshing" {
                return Err(ApiError::invalid(
                    "Cette source n'est pas en cours d'actualisation.",
                ));
            }
            let consecutive_failures = consecutive_failures
                .checked_add(1)
                .filter(|failures| *failures <= MAX_CONSECUTIVE_FAILURES)
                .ok_or_else(|| ApiError::internal("Compteur d'échecs de source saturé."))?;
            let next_retry_at_ms =
                failure_due_at_ms(at_ms, refresh_interval_seconds, consecutive_failures)?;
            let next_retry_at = timestamp_from_millis(next_retry_at_ms)?;
            transaction.execute(
                "UPDATE sources SET status = 'error', last_checked_at = ?1,
                  error_message = ?2, consecutive_failures = ?3,
                  next_retry_at = ?4, due_at_ms = ?5, updated_at = ?1
                 WHERE id = ?6",
                params![
                    at,
                    error_message,
                    consecutive_failures,
                    next_retry_at,
                    next_retry_at_ms,
                    source_id.as_bytes().as_slice()
                ],
            )?;
        }
    }

    let source = read_source(&transaction, source_id)?;
    let patch = StatePatch {
        session_id,
        base_revision: current_revision,
        revision: next_revision,
        operation_id,
        changes: vec![StateChange::SourceUpsert { source }],
    };
    if serde_json::to_vec(&patch)?.len() > MAX_PATCH_BYTES {
        return Err(ApiError::invalid("Le patch dépasse la limite de 256 Kio."));
    }
    let next_revision_i64 = i64::try_from(next_revision)
        .map_err(|_| ApiError::internal("Compteur de révision saturé."))?;
    transaction.execute(
        "UPDATE dashboard_state SET revision = ?1, updated_at = ?2 WHERE id = 1",
        params![next_revision_i64, at],
    )?;
    transaction.execute(
        "INSERT INTO operations (operation_id, committed_revision, created_at)
         VALUES (?1, ?2, ?3)",
        params![operation_id.as_bytes().as_slice(), next_revision_i64, at],
    )?;
    transaction.execute(
        "DELETE FROM operations WHERE operation_id IN (
           SELECT operation_id FROM operations ORDER BY created_at DESC LIMIT -1 OFFSET 4096
         )",
        [],
    )?;
    transaction.commit()?;
    Ok(Some(MutationResult {
        ack: MutationAck {
            operation_id,
            committed_revision: next_revision,
        },
        patch: Some(patch),
    }))
}

fn read_refresh_state(connection: &Connection, source_id: Uuid) -> Result<(String, u32), ApiError> {
    connection
        .query_row(
            "SELECT status, refresh_interval_seconds FROM sources WHERE id = ?1",
            [source_id.as_bytes().as_slice()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| ApiError::not_found("Source introuvable."))
}

fn regular_due_at_ms(at_ms: i64, refresh_interval_seconds: u32) -> Result<i64, ApiError> {
    at_ms
        .checked_add(i64::from(refresh_interval_seconds) * 1_000)
        .ok_or_else(|| ApiError::invalid("Date de prochaine actualisation invalide."))
}

fn failure_due_at_ms(
    at_ms: i64,
    refresh_interval_seconds: u32,
    consecutive_failures: u32,
) -> Result<i64, ApiError> {
    let exponent = consecutive_failures.saturating_sub(1).min(10);
    let base_seconds = u64::from(refresh_interval_seconds.max(MIN_REFRESH_INTERVAL_SECONDS));
    let delay_seconds = base_seconds
        .checked_mul(1_u64 << exponent)
        .unwrap_or(u64::MAX)
        .min(MAX_FAILURE_BACKOFF_SECONDS);
    let delay_ms = i64::try_from(delay_seconds.saturating_mul(1_000))
        .map_err(|_| ApiError::invalid("Délai de nouvelle tentative invalide."))?;
    at_ms
        .checked_add(delay_ms)
        .ok_or_else(|| ApiError::invalid("Date de nouvelle tentative invalide."))
}

fn clean_source_error(value: &str) -> Result<String, ApiError> {
    let value = value.trim();
    if value.is_empty() || value.len() > MAX_SOURCE_ERROR_BYTES {
        return Err(ApiError::invalid("Erreur de source invalide."));
    }
    Ok(value.to_owned())
}

fn append_read_changes(
    transaction: &Transaction<'_>,
    changes: &mut Vec<StateChange>,
    item_ids: &[Uuid],
) -> Result<(), ApiError> {
    if item_ids.is_empty() {
        return Ok(());
    }
    if item_ids.len() <= usize::from(MAX_PAGE_SIZE) {
        let mut states = Vec::with_capacity(item_ids.len());
        for item_id in item_ids {
            states.push(transaction.query_row(
                "SELECT seen_at, opened_at FROM items WHERE id = ?1",
                [item_id.as_bytes().as_slice()],
                |row| {
                    Ok(ItemReadState {
                        item_id: *item_id,
                        seen_at: row.get(0)?,
                        opened_at: row.get(1)?,
                    })
                },
            )?);
        }
        changes.push(StateChange::ItemsReadState { items: states });
        return Ok(());
    }

    let mut panel_ids = HashSet::new();
    for item_id in item_ids {
        let mut statement = transaction
            .prepare("SELECT panel_id FROM panel_items WHERE item_id = ?1 ORDER BY panel_id ASC")?;
        let rows = statement.query_map([item_id.as_bytes().as_slice()], |row| uuid_at(row, 0))?;
        for panel_id in rows {
            panel_ids.insert(panel_id?);
        }
    }
    let mut panel_ids = panel_ids.into_iter().collect::<Vec<_>>();
    panel_ids.sort();
    changes.extend(
        panel_ids
            .into_iter()
            .map(|panel_id| StateChange::PanelInvalidated {
                panel_id,
                reason: "readStateBatch".to_owned(),
            }),
    );
    Ok(())
}

fn apply_feed_panel_configuration(
    transaction: &Transaction<'_>,
    panel_id: Uuid,
    name: &str,
    default_refresh_interval_seconds: u32,
    kept_source_ids: &[Uuid],
    new_sources: Vec<GenericSourceInput>,
    changes: &mut Vec<StateChange>,
) -> Result<(), ApiError> {
    assert_panel_kind(transaction, panel_id, "feed")?;
    let name = clean_panel_name(name)?;
    let default_refresh_interval_seconds =
        clean_refresh_interval(default_refresh_interval_seconds)?;
    validate_configuration_source_ids(kept_source_ids)?;
    if new_sources.len() > MAX_SOURCES_PER_PANEL {
        return Err(ApiError::invalid(format!(
            "Une configuration peut ajouter au maximum {MAX_SOURCES_PER_PANEL} sources."
        )));
    }

    let Panel::Feed {
        name: current_name,
        source_ids: current_source_ids,
        default_refresh_interval_seconds: current_refresh_interval_seconds,
        ..
    } = read_panel(transaction, panel_id)?
    else {
        return Err(ApiError::internal("Type de panel incohérent."));
    };
    let current_source_set = current_source_ids.iter().copied().collect::<HashSet<_>>();
    if kept_source_ids
        .iter()
        .any(|source_id| !current_source_set.contains(source_id))
    {
        return Err(ApiError::invalid(
            "Une source conservée n'est plus rattachée à ce fil.",
        ));
    }

    let timestamp = now();
    let due_at_ms = timestamp_millis(&timestamp)?;
    let mut desired_source_ids = kept_source_ids.to_vec();
    let mut desired_source_set = desired_source_ids.iter().copied().collect::<HashSet<_>>();
    let mut seen_feed_urls = HashSet::with_capacity(new_sources.len());
    let mut inserted_source_ids = Vec::new();

    for source in new_sources {
        let GenericSourceInput {
            name,
            input_url,
            feed_url,
            connector_kind,
            refresh_interval_seconds,
        } = source;
        if refresh_interval_seconds != default_refresh_interval_seconds {
            return Err(ApiError::invalid(
                "La fréquence d'une nouvelle source doit correspondre à celle du panel.",
            ));
        }
        let name = clean_source_name(&name)?;
        let input_url = clean_http_url(&input_url)?;
        let feed_url = clean_http_url(&feed_url)?;
        if !seen_feed_urls.insert(feed_url.clone()) {
            continue;
        }

        let existing = transaction
            .query_row(
                "SELECT id, connector_kind FROM sources WHERE feed_url = ?1",
                [&feed_url],
                |row| Ok((uuid_at(row, 0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        let source_id = if let Some((source_id, stored_kind)) = existing {
            if stored_kind != connector_kind_sql(connector_kind) {
                return Err(ApiError::invalid(
                    "Le type détecté ne correspond pas à la source locale existante.",
                ));
            }
            source_id
        } else {
            let source_id = Uuid::new_v4();
            transaction.execute(
                "INSERT INTO sources (id, name, input_url, feed_url, connector_id,
                  connector_kind, refresh_interval_seconds, status, last_checked_at,
                  last_success_at, error_message, baseline_completed_at,
                  consecutive_failures, next_retry_at, due_at_ms, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, 'idle', NULL, NULL, NULL,
                  NULL, 0, NULL, ?7, ?8, ?8)",
                params![
                    source_id.as_bytes().as_slice(),
                    name,
                    input_url,
                    feed_url,
                    connector_kind_sql(connector_kind),
                    default_refresh_interval_seconds,
                    due_at_ms,
                    timestamp
                ],
            )?;
            inserted_source_ids.push(source_id);
            source_id
        };

        if desired_source_set.insert(source_id) {
            desired_source_ids.push(source_id);
        }
    }

    validate_configuration_source_ids(&desired_source_ids)?;
    let desired_source_set = desired_source_ids.iter().copied().collect::<HashSet<_>>();
    let attachments_changed = desired_source_ids != current_source_ids;
    let panel_fields_changed = name != current_name
        || default_refresh_interval_seconds != current_refresh_interval_seconds;
    let mut materialized_items_changed = 0usize;

    if attachments_changed {
        for source_id in current_source_ids
            .iter()
            .filter(|source_id| !desired_source_set.contains(source_id))
        {
            materialized_items_changed = materialized_items_changed
                .saturating_add(detach_source_from_panel(transaction, panel_id, *source_id)?);
        }
        for source_id in desired_source_ids
            .iter()
            .filter(|source_id| !current_source_set.contains(source_id))
        {
            materialized_items_changed = materialized_items_changed.saturating_add(
                attach_source_to_panel(transaction, panel_id, *source_id, None)?,
            );
        }
        replace_panel_sources(transaction, panel_id, &desired_source_ids)?;
    }

    if panel_fields_changed {
        transaction.execute(
            "UPDATE panels SET name = ?1, default_refresh_interval_seconds = ?2,
              updated_at = ?3 WHERE id = ?4 AND kind = 'feed'",
            params![
                name,
                default_refresh_interval_seconds,
                timestamp,
                panel_id.as_bytes().as_slice()
            ],
        )?;
    } else if attachments_changed {
        transaction.execute(
            "UPDATE panels SET updated_at = ?1 WHERE id = ?2 AND kind = 'feed'",
            params![timestamp, panel_id.as_bytes().as_slice()],
        )?;
    }

    if panel_fields_changed || attachments_changed {
        for source_id in inserted_source_ids {
            changes.push(StateChange::SourceUpsert {
                source: read_source(transaction, source_id)?,
            });
        }
        changes.push(StateChange::PanelUpsert {
            panel: read_panel(transaction, panel_id)?,
        });
        if materialized_items_changed > 0 {
            changes.push(StateChange::PanelInvalidated {
                panel_id,
                reason: "feedConfigurationSaved".to_owned(),
            });
        }
    }
    Ok(())
}

fn attach_source_to_panel(
    transaction: &Transaction<'_>,
    panel_id: Uuid,
    source_id: Uuid,
    position: Option<u16>,
) -> Result<usize, ApiError> {
    assert_panel_kind(transaction, panel_id, "feed")?;
    if transaction
        .query_row(
            "SELECT 1 FROM sources WHERE id = ?1",
            [source_id.as_bytes().as_slice()],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .is_none()
    {
        return Err(ApiError::not_found("Source introuvable."));
    }

    let mut source_ids = read_panel_source_ids(transaction, panel_id)?;
    if source_ids.contains(&source_id) {
        return Err(ApiError::invalid(
            "Cette source est déjà rattachée à ce panel.",
        ));
    }
    if source_ids.len() >= MAX_SOURCES_PER_PANEL {
        return Err(ApiError::invalid(format!(
            "Un panel accepte au maximum {MAX_SOURCES_PER_PANEL} sources."
        )));
    }
    let position = position.map_or(source_ids.len(), usize::from);
    if position > source_ids.len() {
        return Err(ApiError::invalid("Position de source invalide."));
    }
    source_ids.insert(position, source_id);
    replace_panel_sources(transaction, panel_id, &source_ids)?;

    let mut statement = transaction.prepare(
        "SELECT id, is_baseline, first_seen_at, published_at, updated_at
         FROM items WHERE source_id = ?1 ORDER BY id ASC",
    )?;
    let rows = statement.query_map([source_id.as_bytes().as_slice()], |row| {
        Ok((
            uuid_at(row, 0)?,
            row.get::<_, i64>(1)? != 0,
            row.get::<_, String>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
        ))
    })?;
    let mut materialized = 0usize;
    for row in rows {
        let (item_id, is_baseline, first_seen_at, published_at, updated_at) = row?;
        let sort_at_ms = stored_item_sort_at_ms(
            published_at.as_deref(),
            updated_at.as_deref(),
            &first_seen_at,
        )?;
        transaction.execute(
            "INSERT INTO panel_items (panel_id, item_id, baseline_rank, sort_at_ms)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                panel_id.as_bytes().as_slice(),
                item_id.as_bytes().as_slice(),
                i64::from(is_baseline),
                sort_at_ms
            ],
        )?;
        materialized += 1;
    }
    Ok(materialized)
}

fn detach_source_from_panel(
    transaction: &Transaction<'_>,
    panel_id: Uuid,
    source_id: Uuid,
) -> Result<usize, ApiError> {
    assert_panel_kind(transaction, panel_id, "feed")?;
    let mut source_ids = read_panel_source_ids(transaction, panel_id)?;
    let Some(position) = source_ids
        .iter()
        .position(|candidate| *candidate == source_id)
    else {
        return Err(ApiError::not_found(
            "Cette source n'est pas rattachée à ce panel.",
        ));
    };
    let removed_items = transaction.execute(
        "DELETE FROM panel_items
         WHERE panel_id = ?1 AND item_id IN (
           SELECT id FROM items WHERE source_id = ?2
         )",
        params![
            panel_id.as_bytes().as_slice(),
            source_id.as_bytes().as_slice()
        ],
    )?;
    source_ids.remove(position);
    replace_panel_sources(transaction, panel_id, &source_ids)?;
    Ok(removed_items)
}

fn replace_panel_sources(
    transaction: &Transaction<'_>,
    panel_id: Uuid,
    source_ids: &[Uuid],
) -> Result<(), ApiError> {
    transaction.execute(
        "DELETE FROM panel_sources WHERE panel_id = ?1",
        [panel_id.as_bytes().as_slice()],
    )?;
    for (position, source_id) in source_ids.iter().enumerate() {
        let position = i64::try_from(position)
            .map_err(|_| ApiError::internal("Position de source invalide."))?;
        transaction.execute(
            "INSERT INTO panel_sources (panel_id, source_id, position) VALUES (?1, ?2, ?3)",
            params![
                panel_id.as_bytes().as_slice(),
                source_id.as_bytes().as_slice(),
                position
            ],
        )?;
    }
    Ok(())
}

fn write_layout(
    transaction: &Transaction<'_>,
    layout: &Option<LayoutNode>,
) -> Result<(), ApiError> {
    let serialized = layout.as_ref().map(serde_json::to_string).transpose()?;
    transaction.execute(
        "UPDATE dashboard_state SET layout_json = ?1 WHERE id = 1",
        [serialized],
    )?;
    Ok(())
}

fn insert_panel_into_layout(
    node: LayoutNode,
    placement: &PanelPlacement,
    panel_id: Uuid,
    split_id: Uuid,
) -> (LayoutNode, bool) {
    match node {
        LayoutNode::Panel {
            panel_id: target_panel_id,
        } if target_panel_id == placement.target_panel_id => {
            let previous = LayoutNode::Panel {
                panel_id: target_panel_id,
            };
            let added = LayoutNode::Panel { panel_id };
            let (direction, added_first) = match placement.side {
                PlacementSide::Left => (SplitDirection::Row, true),
                PlacementSide::Right => (SplitDirection::Row, false),
                PlacementSide::Top => (SplitDirection::Column, true),
                PlacementSide::Bottom => (SplitDirection::Column, false),
            };
            let children = if added_first {
                [Box::new(added), Box::new(previous)]
            } else {
                [Box::new(previous), Box::new(added)]
            };
            (
                LayoutNode::Split {
                    id: split_id,
                    direction,
                    ratio: 0.5,
                    children,
                },
                true,
            )
        }
        LayoutNode::Panel { panel_id } => (LayoutNode::Panel { panel_id }, false),
        LayoutNode::Split {
            id,
            direction,
            ratio,
            children,
        } => {
            let [first, second] = children;
            let (first, inserted) = insert_panel_into_layout(*first, placement, panel_id, split_id);
            if inserted {
                return (
                    LayoutNode::Split {
                        id,
                        direction,
                        ratio,
                        children: [Box::new(first), second],
                    },
                    true,
                );
            }
            let (second, inserted) =
                insert_panel_into_layout(*second, placement, panel_id, split_id);
            (
                LayoutNode::Split {
                    id,
                    direction,
                    ratio,
                    children: [Box::new(first), Box::new(second)],
                },
                inserted,
            )
        }
    }
}

fn remove_panel_from_layout(node: LayoutNode, panel_id: Uuid) -> (Option<LayoutNode>, bool) {
    match node {
        LayoutNode::Panel {
            panel_id: candidate,
        } if candidate == panel_id => (None, true),
        LayoutNode::Panel { panel_id } => (Some(LayoutNode::Panel { panel_id }), false),
        LayoutNode::Split {
            id,
            direction,
            ratio,
            children,
        } => {
            let [first, second] = children;
            let (first, removed) = remove_panel_from_layout(*first, panel_id);
            if removed {
                return match first {
                    Some(first) => (
                        Some(LayoutNode::Split {
                            id,
                            direction,
                            ratio,
                            children: [Box::new(first), second],
                        }),
                        true,
                    ),
                    None => (Some(*second), true),
                };
            }
            let (second, removed) = remove_panel_from_layout(*second, panel_id);
            if removed {
                match second {
                    Some(second) => (
                        Some(LayoutNode::Split {
                            id,
                            direction,
                            ratio,
                            children: [
                                Box::new(first.expect("unchanged first layout child")),
                                Box::new(second),
                            ],
                        }),
                        true,
                    ),
                    None => (first, true),
                }
            } else {
                (
                    Some(LayoutNode::Split {
                        id,
                        direction,
                        ratio,
                        children: [
                            Box::new(first.expect("unchanged first layout child")),
                            Box::new(second.expect("unchanged second layout child")),
                        ],
                    }),
                    false,
                )
            }
        }
    }
}

fn assert_panel_kind(
    connection: &Connection,
    panel_id: Uuid,
    expected_kind: &str,
) -> Result<(), ApiError> {
    let kind = connection
        .query_row(
            "SELECT kind FROM panels WHERE id = ?1",
            [panel_id.as_bytes().as_slice()],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    match kind.as_deref() {
        None => Err(ApiError::not_found("Panel introuvable.")),
        Some(kind) if kind != expected_kind => Err(ApiError::invalid(
            "Cette modification ne correspond pas au type du panel.",
        )),
        Some(_) => Ok(()),
    }
}

fn validate_layout(connection: &Connection, layout: &Option<LayoutNode>) -> Result<(), ApiError> {
    let mut statement = connection.prepare("SELECT id FROM panels ORDER BY position ASC")?;
    let panel_ids = statement
        .query_map([], |row| uuid_at(row, 0))?
        .collect::<Result<HashSet<_>, _>>()?;
    if panel_ids.is_empty() {
        return if layout.is_none() {
            Ok(())
        } else {
            Err(ApiError::invalid(
                "Un dashboard vide ne peut pas contenir de layout.",
            ))
        };
    }
    let root = layout
        .as_ref()
        .ok_or_else(|| ApiError::invalid("Le layout doit contenir tous les panels."))?;
    if serde_json::to_vec(root)?.len() > MAX_LAYOUT_BYTES {
        return Err(ApiError::invalid("Le layout est trop volumineux."));
    }
    let mut seen_panels = HashSet::new();
    let mut seen_splits = HashSet::new();
    let mut nodes = 0usize;
    visit_layout(
        root,
        0,
        &panel_ids,
        &mut seen_panels,
        &mut seen_splits,
        &mut nodes,
    )?;
    if seen_panels != panel_ids {
        return Err(ApiError::invalid(
            "Le layout doit contenir chaque panel exactement une fois.",
        ));
    }
    let (columns, rows) = layout_grid_span(root);
    if columns > 3 || rows > 3 {
        return Err(ApiError::invalid(
            "Le layout ne peut pas garantir la taille minimale des panels.",
        ));
    }
    Ok(())
}

fn layout_grid_span(node: &LayoutNode) -> (usize, usize) {
    match node {
        LayoutNode::Panel { .. } => (1, 1),
        LayoutNode::Split {
            direction,
            children,
            ..
        } => {
            let first = layout_grid_span(&children[0]);
            let second = layout_grid_span(&children[1]);
            match direction {
                SplitDirection::Row => (first.0 + second.0, first.1.max(second.1)),
                SplitDirection::Column => (first.0.max(second.0), first.1 + second.1),
            }
        }
    }
}

fn visit_layout(
    node: &LayoutNode,
    depth: usize,
    panel_ids: &HashSet<Uuid>,
    seen_panels: &mut HashSet<Uuid>,
    seen_splits: &mut HashSet<Uuid>,
    nodes: &mut usize,
) -> Result<(), ApiError> {
    *nodes += 1;
    if depth > MAX_LAYOUT_DEPTH || *nodes > MAX_LAYOUT_NODES {
        return Err(ApiError::invalid("Le layout est trop complexe."));
    }
    match node {
        LayoutNode::Panel { panel_id } => {
            if !panel_ids.contains(panel_id) || !seen_panels.insert(*panel_id) {
                return Err(ApiError::invalid(
                    "Référence de panel invalide dans le layout.",
                ));
            }
        }
        LayoutNode::Split {
            id,
            ratio,
            children,
            ..
        } => {
            if !seen_splits.insert(*id) || !ratio.is_finite() || !(0.1..=0.9).contains(ratio) {
                return Err(ApiError::invalid("Division de layout invalide."));
            }
            visit_layout(
                &children[0],
                depth + 1,
                panel_ids,
                seen_panels,
                seen_splits,
                nodes,
            )?;
            visit_layout(
                &children[1],
                depth + 1,
                panel_ids,
                seen_panels,
                seen_splits,
                nodes,
            )?;
        }
    }
    Ok(())
}

fn clean_panel_name(value: &str) -> Result<String, ApiError> {
    let clean = value.trim();
    if clean.is_empty() || clean.chars().count() > MAX_PANEL_NAME_CHARS {
        return Err(ApiError::invalid("Nom de panel invalide."));
    }
    Ok(clean.to_owned())
}

fn clean_source_name(value: &str) -> Result<String, ApiError> {
    let clean = value.trim();
    if clean.is_empty() || clean.chars().count() > MAX_SOURCE_NAME_CHARS {
        return Err(ApiError::invalid("Nom de source invalide."));
    }
    Ok(clean.to_owned())
}

fn clean_refresh_interval(value: u32) -> Result<u32, ApiError> {
    if !(MIN_REFRESH_INTERVAL_SECONDS..=MAX_REFRESH_INTERVAL_SECONDS).contains(&value) {
        return Err(ApiError::invalid(
            "La fréquence doit être comprise entre 30 secondes et 60 minutes.",
        ));
    }
    Ok(value)
}

fn clean_http_url(value: &str) -> Result<String, ApiError> {
    let value = value.trim();
    if value.is_empty() || value.len() > MAX_HTTP_URL_LENGTH {
        return Err(ApiError::invalid("URL de panel invalide."));
    }
    let url = url::Url::parse(value).map_err(|_| ApiError::invalid("URL de panel invalide."))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(ApiError::invalid(
            "Seules les URLs HTTP et HTTPS sont acceptées.",
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ApiError::invalid(
            "Les URLs contenant des identifiants sont refusées.",
        ));
    }
    let normalized = url.to_string();
    if normalized.len() > MAX_HTTP_URL_LENGTH {
        return Err(ApiError::invalid("URL de panel trop longue."));
    }
    Ok(normalized)
}

fn checked_refresh_source_count(value: i64, maximum: usize) -> Result<usize, ApiError> {
    let count = usize::try_from(value)
        .map_err(|_| ApiError::internal("Nombre de sources à actualiser invalide."))?;
    if count > maximum {
        return Err(ApiError::internal(format!(
            "Le périmètre d'actualisation dépasse la limite de {maximum} sources."
        )));
    }
    Ok(count)
}

fn validate_configuration_source_ids(source_ids: &[Uuid]) -> Result<(), ApiError> {
    if source_ids.len() > MAX_SOURCES_PER_PANEL {
        return Err(ApiError::invalid(format!(
            "Un panel accepte au maximum {MAX_SOURCES_PER_PANEL} sources."
        )));
    }
    let mut unique = HashSet::with_capacity(source_ids.len());
    if source_ids
        .iter()
        .any(|source_id| source_id.is_nil() || !unique.insert(*source_id))
    {
        return Err(ApiError::invalid(
            "La liste ordonnée des sources contient un identifiant invalide ou dupliqué.",
        ));
    }
    Ok(())
}

fn manual_refresh_change(
    scope: RefreshScope,
    source_count: usize,
) -> Result<StateChange, ApiError> {
    let source_count = u32::try_from(source_count)
        .map_err(|_| ApiError::internal("Nombre de sources à actualiser invalide."))?;
    Ok(StateChange::RefreshScheduled {
        scope,
        source_count,
    })
}

fn connector_kind_sql(kind: ConnectorKind) -> &'static str {
    match kind {
        ConnectorKind::Rss => "rss",
        ConnectorKind::Atom => "atom",
        ConnectorKind::NewsSitemap => "news-sitemap",
    }
}

fn timestamp_millis(value: &str) -> Result<i64, ApiError> {
    DateTime::parse_from_rfc3339(value)
        .map_err(|_| ApiError::invalid("Date invalide."))
        .map(|date| date.timestamp_millis())
}

fn timestamp_from_millis(value: i64) -> Result<String, ApiError> {
    DateTime::<Utc>::from_timestamp_millis(value)
        .ok_or_else(|| ApiError::invalid("Date invalide."))
        .map(|date| date.to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn optional_timestamp_millis(value: Option<&str>) -> Result<Option<i64>, ApiError> {
    value.map(timestamp_millis).transpose()
}

fn stored_item_sort_at_ms(
    published_at: Option<&str>,
    updated_at: Option<&str>,
    first_seen_at: &str,
) -> Result<i64, ApiError> {
    if let Some(timestamp) = optional_timestamp_millis(published_at)? {
        return Ok(timestamp);
    }
    if let Some(timestamp) = optional_timestamp_millis(updated_at)? {
        return Ok(timestamp);
    }
    timestamp_millis(first_seen_at)
}

fn normalize_timestamp(value: &str) -> Result<String, ApiError> {
    DateTime::parse_from_rfc3339(value)
        .map_err(|_| ApiError::invalid("Date invalide."))
        .map(|date| {
            date.with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Millis, true)
        })
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cursor {
    baseline_rank: i64,
    sort_at_ms: i64,
    item_id: Uuid,
}

fn encode_cursor(baseline_rank: i64, sort_at_ms: i64, item_id: Uuid) -> Result<String, ApiError> {
    Ok(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&Cursor {
        baseline_rank,
        sort_at_ms,
        item_id,
    })?))
}

fn decode_cursor(value: &str) -> Result<Cursor, ApiError> {
    if value.len() > MAX_CURSOR_BYTES {
        return Err(ApiError::invalid("Curseur de pagination invalide."));
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| ApiError::invalid("Curseur de pagination invalide."))?;
    let cursor: Cursor = serde_json::from_slice(&bytes)
        .map_err(|_| ApiError::invalid("Curseur de pagination invalide."))?;
    if !(0..=1).contains(&cursor.baseline_rank) || cursor.item_id.is_nil() {
        return Err(ApiError::invalid("Curseur de pagination invalide."));
    }
    Ok(cursor)
}

fn uuid_at(row: &Row<'_>, index: usize) -> rusqlite::Result<Uuid> {
    match row.get_ref(index)? {
        ValueRef::Blob(bytes) => Uuid::from_slice(bytes).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(index, Type::Blob, Box::new(error))
        }),
        value => Err(rusqlite::Error::InvalidColumnType(
            index,
            index.to_string(),
            value.data_type(),
        )),
    }
}

fn invalid_column(index: usize, value: &str, label: &str) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        index,
        Type::Text,
        format!("invalid {label}: {value}").into(),
    )
}

#[cfg(test)]
mod tests {
    use super::{migrate, DatabaseActor, IngestFeedRequest};
    use crate::http_cache::HttpCacheActor;
    use crate::model::{
        ConnectorKind, CreatePanelInput, FeedPageRequest, GenericSourceInput, LayoutNode,
        MutateRequest, MutationCommand, MutationResult, Panel, PanelPlacement, PlacementSide,
        RefreshScope, SearchMode, SearchRequest, SourceStatus, SplitDirection, StateChange,
        MAX_PAGE_SIZE, MAX_PATCH_BYTES,
    };
    use crate::network::{ParsedFeed, ParsedFeedItem};
    use crate::search::{SearchHit, SearchIndexActor};
    use crate::search_sync::SearchSynchronizer;
    use futures_util::future::{join, join3, join_all};
    use rusqlite::{params, Connection};
    use std::{
        fs,
        path::Path,
        sync::{Arc, Mutex},
        time::Duration,
    };
    use uuid::Uuid;

    fn fixture_path() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("vibedeck-db-{}.sqlite", Uuid::new_v4()))
    }

    fn remove_sqlite_files(path: &Path) {
        let _ = fs::remove_file(path);
        for suffix in ["-wal", "-shm"] {
            let mut sidecar = path.as_os_str().to_owned();
            sidecar.push(suffix);
            let _ = fs::remove_file(std::path::PathBuf::from(sidecar));
        }
    }

    fn seed(path: &std::path::Path, count: usize) -> (Uuid, Uuid, Vec<Uuid>) {
        let mut connection = Connection::open(path).unwrap();
        connection
            .execute_batch("PRAGMA foreign_keys = ON;")
            .unwrap();
        migrate(&connection).unwrap();
        let transaction = connection.transaction().unwrap();
        let panel_id = Uuid::new_v4();
        let source_id = Uuid::new_v4();
        transaction
            .execute(
                "INSERT INTO panels (id, name, position, kind, web_url,
                  default_refresh_interval_seconds, created_at, updated_at)
                 VALUES (?1, 'Fil', 0, 'feed', NULL, 60, ?2, ?2)",
                params![panel_id.as_bytes().as_slice(), "2026-01-01T00:00:00.000Z"],
            )
            .unwrap();
        transaction
            .execute(
                "UPDATE dashboard_state SET layout_json = ?1 WHERE id = 1",
                [serde_json::json!({"type":"panel", "panelId":panel_id}).to_string()],
            )
            .unwrap();
        transaction
            .execute(
                "INSERT INTO sources (id, name, input_url, feed_url, connector_id,
                  connector_kind, refresh_interval_seconds, status, consecutive_failures,
                  due_at_ms, created_at, updated_at)
                 VALUES (?1, 'Source', 'https://example.test/', 'https://example.test/feed',
                  NULL, 'rss', 60, 'healthy', 0, 0, ?2, ?2)",
                params![source_id.as_bytes().as_slice(), "2026-01-01T00:00:00.000Z"],
            )
            .unwrap();
        transaction
            .execute(
                "INSERT INTO panel_sources (panel_id, source_id, position) VALUES (?1, ?2, 0)",
                params![
                    panel_id.as_bytes().as_slice(),
                    source_id.as_bytes().as_slice()
                ],
            )
            .unwrap();
        let mut item_ids = Vec::new();
        for index in 0..count {
            let item_id = Uuid::new_v4();
            let timestamp = format!("2026-01-01T00:{:02}:00.000Z", index % 60);
            transaction
                .execute(
                    "INSERT INTO items (id, source_id, canonical_url, title, summary,
                      image_url, published_at, updated_at, first_seen_at, arrival_batch_at,
                      last_seen_at, is_baseline, seen_at, opened_at)
                     VALUES (?1, ?2, ?3, ?4, NULL, NULL, ?5, NULL, ?5, ?5, ?5, 0, NULL, NULL)",
                    params![
                        item_id.as_bytes().as_slice(),
                        source_id.as_bytes().as_slice(),
                        format!("https://example.test/{index}"),
                        format!("Article {index}"),
                        timestamp
                    ],
                )
                .unwrap();
            transaction
                .execute(
                    "INSERT INTO panel_items (panel_id, item_id, baseline_rank, sort_at_ms)
                     VALUES (?1, ?2, 0, ?3)",
                    params![
                        panel_id.as_bytes().as_slice(),
                        item_id.as_bytes().as_slice(),
                        i64::try_from(index).unwrap()
                    ],
                )
                .unwrap();
            item_ids.push(item_id);
        }
        transaction.commit().unwrap();
        (panel_id, source_id, item_ids)
    }

    fn created_panel_id(result: &MutationResult) -> Uuid {
        result
            .patch
            .as_ref()
            .unwrap()
            .changes
            .iter()
            .find_map(|change| match change {
                StateChange::PanelUpsert { panel } => Some(panel.id()),
                _ => None,
            })
            .unwrap()
    }

    fn created_source_id(result: &MutationResult) -> Uuid {
        result
            .patch
            .as_ref()
            .unwrap()
            .changes
            .iter()
            .find_map(|change| match change {
                StateChange::SourceUpsert { source } => Some(source.id),
                _ => None,
            })
            .unwrap()
    }

    fn refresh_scheduled(result: &MutationResult) -> (&RefreshScope, u32) {
        result
            .patch
            .as_ref()
            .and_then(|patch| {
                patch.changes.iter().find_map(|change| match change {
                    StateChange::RefreshScheduled {
                        scope,
                        source_count,
                    } => Some((scope, *source_count)),
                    _ => None,
                })
            })
            .expect("missing refreshScheduled change")
    }

    fn generic_source(name: &str, index: usize) -> GenericSourceInput {
        GenericSourceInput {
            name: name.to_owned(),
            input_url: format!("https://source-{index}.example.test/"),
            feed_url: format!("https://source-{index}.example.test/feed.xml"),
            connector_kind: ConnectorKind::Rss,
            refresh_interval_seconds: 60,
        }
    }

    fn parsed_feed(count: usize, title_prefix: &str) -> ParsedFeed {
        ParsedFeed {
            kind: ConnectorKind::Rss,
            title: Some("Flux test".to_owned()),
            items: (0..count)
                .map(|index| ParsedFeedItem {
                    canonical_url: format!("https://articles.example.test/{index}"),
                    title: format!("{title_prefix} {index}"),
                    summary: Some(format!("Résumé {index}")),
                    image_url: None,
                    published_at: Some(format!("2026-01-{:02}T12:00:00.000Z", (index % 28) + 1)),
                    updated_at: None,
                })
                .collect(),
        }
    }

    async fn create_feed_panel(
        actor: &DatabaseActor,
        session_id: Uuid,
        expected_revision: u64,
        name: &str,
        placement: Option<PanelPlacement>,
    ) -> MutationResult {
        actor
            .mutate(
                session_id,
                MutateRequest {
                    operation_id: Uuid::new_v4(),
                    expected_revision,
                    command: MutationCommand::CreatePanel {
                        input: CreatePanelInput::Feed {
                            name: name.to_owned(),
                            default_refresh_interval_seconds: None,
                        },
                        placement,
                    },
                },
            )
            .await
            .unwrap()
    }

    async fn add_generic_source(
        actor: &DatabaseActor,
        session_id: Uuid,
        expected_revision: u64,
        panel_id: Uuid,
        source: GenericSourceInput,
        position: Option<u16>,
    ) -> MutationResult {
        actor
            .mutate(
                session_id,
                MutateRequest {
                    operation_id: Uuid::new_v4(),
                    expected_revision,
                    command: MutationCommand::AddGenericSource {
                        panel_id,
                        source,
                        position,
                    },
                },
            )
            .await
            .unwrap()
    }

    fn assert_leaf(node: &LayoutNode, expected: Uuid) {
        assert!(matches!(node, LayoutNode::Panel { panel_id } if *panel_id == expected));
    }

    #[test]
    fn bootstrap_is_bounded_and_pages_without_duplicates() {
        tauri::async_runtime::block_on(async {
            let path = fixture_path();
            let (panel_id, _, _) = seed(&path, 260);
            let actor = DatabaseActor::spawn(path.clone());
            let bootstrap = actor.bootstrap(Uuid::new_v4()).await.unwrap();
            assert_eq!(bootstrap.first_page_by_panel[&panel_id].items.len(), 48);

            let first = actor
                .feed_page(FeedPageRequest {
                    panel_id,
                    cursor: None,
                    limit: MAX_PAGE_SIZE,
                })
                .await
                .unwrap();
            let second = actor
                .feed_page(FeedPageRequest {
                    panel_id,
                    cursor: first.next_cursor.clone(),
                    limit: MAX_PAGE_SIZE,
                })
                .await
                .unwrap();
            assert_eq!(first.items.len(), 200);
            assert_eq!(second.items.len(), 60);
            let first_ids = first
                .items
                .iter()
                .map(|item| item.id)
                .collect::<std::collections::HashSet<_>>();
            assert!(second
                .items
                .iter()
                .all(|item| !first_ids.contains(&item.id)));
            actor.shutdown().await;
            drop(actor);
            fs::remove_file(path).unwrap();
        });
    }

    #[test]
    fn materialized_chronology_prefers_published_then_updated_then_first_seen() {
        let published = "2026-01-01T00:00:00Z";
        let updated = "2026-02-01T00:00:00Z";
        let first_seen = "2026-03-01T00:00:00Z";
        assert_eq!(
            super::stored_item_sort_at_ms(Some(published), Some(updated), first_seen).unwrap(),
            super::timestamp_millis(published).unwrap()
        );
        assert_eq!(
            super::stored_item_sort_at_ms(None, Some(updated), first_seen).unwrap(),
            super::timestamp_millis(updated).unwrap()
        );
        assert_eq!(
            super::stored_item_sort_at_ms(None, None, first_seen).unwrap(),
            super::timestamp_millis(first_seen).unwrap()
        );
    }

    #[test]
    fn feed_pages_keep_editorial_chronology_across_two_hundred_arrivals() {
        tauri::async_runtime::block_on(async {
            let path = fixture_path();
            let actor = DatabaseActor::spawn(path.clone());
            let session_id = Uuid::new_v4();
            let panel = create_feed_panel(&actor, session_id, 0, "Fil", None).await;
            let panel_id = created_panel_id(&panel);
            let source = add_generic_source(
                &actor,
                session_id,
                1,
                panel_id,
                generic_source("Chronologie", 90),
                None,
            )
            .await;
            let source_id = created_source_id(&source);

            let baseline = ParsedFeed {
                kind: ConnectorKind::Rss,
                title: None,
                items: (0..2)
                    .map(|index| ParsedFeedItem {
                        canonical_url: format!("https://articles.example.test/baseline-{index}"),
                        title: format!("Baseline {index}"),
                        summary: None,
                        image_url: None,
                        // Even a future-dated baseline must stay after real arrivals.
                        published_at: Some(format!("2027-01-{:02}T12:00:00.000Z", index + 1)),
                        updated_at: None,
                    })
                    .collect(),
            };
            actor
                .ingest_feed(
                    session_id,
                    IngestFeedRequest {
                        operation_id: Uuid::new_v4(),
                        source_id,
                        observed_at: "2026-04-01T12:00:00Z".to_owned(),
                        feed: baseline,
                    },
                )
                .await
                .unwrap();

            actor
                .ingest_feed(
                    session_id,
                    IngestFeedRequest {
                        operation_id: Uuid::new_v4(),
                        source_id,
                        observed_at: "2026-04-02T12:00:00Z".to_owned(),
                        feed: ParsedFeed {
                            kind: ConnectorKind::Rss,
                            title: None,
                            items: vec![ParsedFeedItem {
                                canonical_url: "https://articles.example.test/editorial-newest"
                                    .to_owned(),
                                title: "Éditorialement le plus récent".to_owned(),
                                summary: None,
                                image_url: None,
                                published_at: Some("2026-12-31T12:00:00Z".to_owned()),
                                updated_at: None,
                            }],
                        },
                    },
                )
                .await
                .unwrap();

            let later_observed_old_items = (0..205)
                .map(|index| ParsedFeedItem {
                    canonical_url: format!("https://articles.example.test/old-{index}"),
                    title: format!("Ancien {index}"),
                    summary: None,
                    image_url: None,
                    published_at: Some(format!("2026-01-{:02}T12:00:00.000Z", (index % 28) + 1)),
                    updated_at: None,
                })
                .collect();
            actor
                .ingest_feed(
                    session_id,
                    IngestFeedRequest {
                        operation_id: Uuid::new_v4(),
                        source_id,
                        observed_at: "2026-04-03T12:00:00Z".to_owned(),
                        feed: ParsedFeed {
                            kind: ConnectorKind::Rss,
                            title: None,
                            items: later_observed_old_items,
                        },
                    },
                )
                .await
                .unwrap();

            let first = actor
                .feed_page(FeedPageRequest {
                    panel_id,
                    cursor: None,
                    limit: MAX_PAGE_SIZE,
                })
                .await
                .unwrap();
            let second = actor
                .feed_page(FeedPageRequest {
                    panel_id,
                    cursor: first.next_cursor.clone(),
                    limit: MAX_PAGE_SIZE,
                })
                .await
                .unwrap();
            assert_eq!(first.items.len(), 200);
            assert_eq!(second.items.len(), 8);
            assert!(second.next_cursor.is_none());

            let items = first.items.iter().chain(&second.items).collect::<Vec<_>>();
            assert_eq!(items[0].title, "Éditorialement le plus récent");
            assert!(items[..206].iter().all(|item| !item.is_baseline));
            assert!(items[206..].iter().all(|item| item.is_baseline));
            assert_eq!(
                items
                    .iter()
                    .map(|item| item.id)
                    .collect::<std::collections::HashSet<_>>()
                    .len(),
                208
            );

            actor.shutdown().await;
            drop(actor);
            remove_sqlite_files(&path);
        });
    }

    #[test]
    fn interrupted_refresh_recovery_advances_revision_exactly_once() {
        tauri::async_runtime::block_on(async {
            let path = fixture_path();
            let (_, source_id, _) = seed(&path, 1);
            {
                let connection = Connection::open(&path).unwrap();
                connection
                    .execute(
                        "UPDATE sources SET status = 'refreshing' WHERE id = ?1",
                        [source_id.as_bytes().as_slice()],
                    )
                    .unwrap();
                connection
                    .execute("UPDATE dashboard_state SET revision = 41 WHERE id = 1", [])
                    .unwrap();
            }

            let actor = DatabaseActor::spawn(path.clone());
            assert_eq!(actor.revision().await.unwrap(), 42);
            let bootstrap = actor.bootstrap(Uuid::new_v4()).await.unwrap();
            assert_eq!(bootstrap.revision, 42);
            assert_eq!(
                bootstrap
                    .sources
                    .iter()
                    .find(|source| source.id == source_id)
                    .unwrap()
                    .status,
                SourceStatus::Idle,
            );
            actor.shutdown().await;
            drop(actor);

            let reopened = DatabaseActor::spawn(path.clone());
            assert_eq!(reopened.revision().await.unwrap(), 42);
            reopened.shutdown().await;
            drop(reopened);
            remove_sqlite_files(&path);
        });
    }

    #[test]
    fn mutation_is_revision_checked_idempotent_and_delta_only() {
        tauri::async_runtime::block_on(async {
            let path = fixture_path();
            let (_, _, item_ids) = seed(&path, 1);
            let actor = DatabaseActor::spawn(path.clone());
            let operation_id = Uuid::new_v4();
            let request = MutateRequest {
                operation_id,
                expected_revision: 0,
                command: MutationCommand::MarkItemOpened {
                    item_id: item_ids[0],
                    at: "2026-02-01T12:34:56Z".to_owned(),
                },
            };
            let result = actor.mutate(Uuid::new_v4(), request.clone()).await.unwrap();
            assert_eq!(result.ack.committed_revision, 1);
            assert!(matches!(
                &result.patch.unwrap().changes[0],
                StateChange::ItemsReadState { items } if items.len() == 1
            ));

            let duplicate = actor.mutate(Uuid::new_v4(), request).await.unwrap();
            assert_eq!(duplicate.ack.committed_revision, 1);
            assert!(duplicate.patch.is_none());
            assert_eq!(actor.revision().await.unwrap(), 1);
            actor.shutdown().await;
            drop(actor);
            fs::remove_file(path).unwrap();
        });
    }

    #[test]
    fn manual_source_refresh_is_revision_checked_idempotent_and_delta_only() {
        tauri::async_runtime::block_on(async {
            let path = fixture_path();
            let (_, source_id, _) = seed(&path, 0);
            let actor = DatabaseActor::spawn(path.clone());
            let session_id = Uuid::new_v4();
            let operation_id = Uuid::new_v4();
            let request = MutateRequest {
                operation_id,
                expected_revision: 0,
                command: MutationCommand::ForceRefreshSource { source_id },
            };

            let result = actor.mutate(session_id, request.clone()).await.unwrap();
            assert_eq!(result.ack.committed_revision, 1);
            assert_eq!(
                refresh_scheduled(&result),
                (&RefreshScope::Source { source_id }, 1)
            );
            assert!(
                serde_json::to_vec(result.patch.as_ref().unwrap())
                    .unwrap()
                    .len()
                    < 512
            );
            let due_after = actor
                .bootstrap(session_id)
                .await
                .unwrap()
                .sources
                .into_iter()
                .find(|source| source.id == source_id)
                .unwrap()
                .due_at_ms;
            assert!(due_after > 0);

            let duplicate = actor.mutate(session_id, request).await.unwrap();
            assert_eq!(duplicate.ack.committed_revision, 1);
            assert!(duplicate.patch.is_none());

            let stale = actor
                .mutate(
                    session_id,
                    MutateRequest {
                        operation_id: Uuid::new_v4(),
                        expected_revision: 0,
                        command: MutationCommand::ForceRefreshSource { source_id },
                    },
                )
                .await
                .unwrap_err();
            assert_eq!(stale.code, "revision_conflict");
            assert_eq!(actor.revision().await.unwrap(), 1);
            assert_eq!(
                actor
                    .bootstrap(session_id)
                    .await
                    .unwrap()
                    .sources
                    .into_iter()
                    .find(|source| source.id == source_id)
                    .unwrap()
                    .due_at_ms,
                due_after
            );

            actor.shutdown().await;
            drop(actor);
            remove_sqlite_files(&path);
        });
    }

    #[test]
    fn manual_refresh_rejects_unknown_sources_and_web_panels_without_committing() {
        tauri::async_runtime::block_on(async {
            let source_path = fixture_path();
            let (_, source_id, _) = seed(&source_path, 0);
            let source_actor = DatabaseActor::spawn(source_path.clone());
            let session_id = Uuid::new_v4();
            let due_before = source_actor
                .bootstrap(session_id)
                .await
                .unwrap()
                .sources
                .into_iter()
                .find(|source| source.id == source_id)
                .unwrap()
                .due_at_ms;
            let error = source_actor
                .mutate(
                    session_id,
                    MutateRequest {
                        operation_id: Uuid::new_v4(),
                        expected_revision: 0,
                        command: MutationCommand::ForceRefreshSource {
                            source_id: Uuid::new_v4(),
                        },
                    },
                )
                .await
                .unwrap_err();
            assert_eq!(error.code, "not_found");
            assert_eq!(source_actor.revision().await.unwrap(), 0);
            assert_eq!(
                source_actor
                    .bootstrap(session_id)
                    .await
                    .unwrap()
                    .sources
                    .into_iter()
                    .find(|source| source.id == source_id)
                    .unwrap()
                    .due_at_ms,
                due_before
            );
            source_actor.shutdown().await;
            drop(source_actor);
            remove_sqlite_files(&source_path);

            let web_path = fixture_path();
            let web_actor = DatabaseActor::spawn(web_path.clone());
            let created = web_actor
                .mutate(
                    session_id,
                    MutateRequest {
                        operation_id: Uuid::new_v4(),
                        expected_revision: 0,
                        command: MutationCommand::CreatePanel {
                            input: CreatePanelInput::Web {
                                name: "Publication".to_owned(),
                                url: "https://example.test/".to_owned(),
                            },
                            placement: None,
                        },
                    },
                )
                .await
                .unwrap();
            let panel_id = created_panel_id(&created);
            let error = web_actor
                .mutate(
                    session_id,
                    MutateRequest {
                        operation_id: Uuid::new_v4(),
                        expected_revision: 1,
                        command: MutationCommand::ForceRefreshPanel { panel_id },
                    },
                )
                .await
                .unwrap_err();
            assert_eq!(error.code, "invalid_request");
            assert_eq!(web_actor.revision().await.unwrap(), 1);
            web_actor.shutdown().await;
            drop(web_actor);
            remove_sqlite_files(&web_path);
        });
    }

    #[test]
    fn manual_panel_and_all_refresh_deduplicate_shared_sources() {
        tauri::async_runtime::block_on(async {
            let path = fixture_path();
            let (first_panel_id, source_id, _) = seed(&path, 0);
            let actor = DatabaseActor::spawn(path.clone());
            let session_id = Uuid::new_v4();
            let second = create_feed_panel(
                &actor,
                session_id,
                0,
                "Second",
                Some(PanelPlacement {
                    target_panel_id: first_panel_id,
                    side: PlacementSide::Right,
                }),
            )
            .await;
            let second_panel_id = created_panel_id(&second);
            actor
                .mutate(
                    session_id,
                    MutateRequest {
                        operation_id: Uuid::new_v4(),
                        expected_revision: 1,
                        command: MutationCommand::AttachSource {
                            panel_id: second_panel_id,
                            source_id,
                            position: None,
                        },
                    },
                )
                .await
                .unwrap();

            let panel_refresh = actor
                .mutate(
                    session_id,
                    MutateRequest {
                        operation_id: Uuid::new_v4(),
                        expected_revision: 2,
                        command: MutationCommand::ForceRefreshPanel {
                            panel_id: second_panel_id,
                        },
                    },
                )
                .await
                .unwrap();
            assert_eq!(
                refresh_scheduled(&panel_refresh),
                (
                    &RefreshScope::Panel {
                        panel_id: second_panel_id
                    },
                    1
                )
            );

            let all_refresh = actor
                .mutate(
                    session_id,
                    MutateRequest {
                        operation_id: Uuid::new_v4(),
                        expected_revision: 3,
                        command: MutationCommand::ForceRefreshAll,
                    },
                )
                .await
                .unwrap();
            assert_eq!(refresh_scheduled(&all_refresh), (&RefreshScope::All, 1));
            assert_eq!(all_refresh.ack.committed_revision, 4);

            actor.shutdown().await;
            drop(actor);
            remove_sqlite_files(&path);
        });
    }

    #[test]
    fn manual_refresh_all_is_bounded_at_the_full_attached_source_capacity() {
        tauri::async_runtime::block_on(async {
            let path = fixture_path();
            let mut connection = Connection::open(&path).unwrap();
            migrate(&connection).unwrap();
            let transaction = connection.transaction().unwrap();
            let timestamp = "2026-01-01T00:00:00.000Z";
            let mut panel_ids = Vec::new();
            for panel_index in 0..super::MAX_PANELS {
                let panel_id = Uuid::new_v4();
                panel_ids.push(panel_id);
                transaction
                    .execute(
                        "INSERT INTO panels (id, name, position, kind, web_url,
                          default_refresh_interval_seconds, created_at, updated_at)
                         VALUES (?1, ?2, ?3, 'feed', NULL, 60, ?4, ?4)",
                        params![
                            panel_id.as_bytes().as_slice(),
                            format!("Panel {panel_index}"),
                            panel_index,
                            timestamp
                        ],
                    )
                    .unwrap();
                for source_index in 0..super::MAX_SOURCES_PER_PANEL {
                    let source_id = Uuid::new_v4();
                    let unique_index = usize::try_from(panel_index).unwrap()
                        * super::MAX_SOURCES_PER_PANEL
                        + source_index;
                    transaction
                        .execute(
                            "INSERT INTO sources (id, name, input_url, feed_url, connector_id,
                              connector_kind, refresh_interval_seconds, status,
                              consecutive_failures, due_at_ms, created_at, updated_at)
                             VALUES (?1, ?2, ?3, ?4, NULL, 'rss', 60, 'idle', 0, ?5, ?6, ?6)",
                            params![
                                source_id.as_bytes().as_slice(),
                                format!("Source {unique_index}"),
                                format!("https://source-{unique_index}.example.test/"),
                                format!("https://source-{unique_index}.example.test/feed.xml"),
                                i64::MAX / 2,
                                timestamp
                            ],
                        )
                        .unwrap();
                    transaction
                        .execute(
                            "INSERT INTO panel_sources (panel_id, source_id, position)
                             VALUES (?1, ?2, ?3)",
                            params![
                                panel_id.as_bytes().as_slice(),
                                source_id.as_bytes().as_slice(),
                                i64::try_from(source_index).unwrap()
                            ],
                        )
                        .unwrap();
                }
            }
            let layout = panel_ids
                .into_iter()
                .map(|panel_id| LayoutNode::Panel { panel_id })
                .reduce(|left, right| LayoutNode::Split {
                    id: Uuid::new_v4(),
                    direction: SplitDirection::Row,
                    ratio: 0.5,
                    children: [Box::new(left), Box::new(right)],
                })
                .unwrap();
            transaction
                .execute(
                    "UPDATE dashboard_state SET layout_json = ?1 WHERE id = 1",
                    [serde_json::to_string(&Some(layout)).unwrap()],
                )
                .unwrap();
            transaction.commit().unwrap();
            drop(connection);

            let actor = DatabaseActor::spawn(path.clone());
            let result = actor
                .mutate(
                    Uuid::new_v4(),
                    MutateRequest {
                        operation_id: Uuid::new_v4(),
                        expected_revision: 0,
                        command: MutationCommand::ForceRefreshAll,
                    },
                )
                .await
                .unwrap();
            assert_eq!(
                refresh_scheduled(&result),
                (
                    &RefreshScope::All,
                    u32::try_from(super::MAX_ATTACHED_SOURCES).unwrap()
                )
            );
            assert!(
                serde_json::to_vec(result.patch.as_ref().unwrap())
                    .unwrap()
                    .len()
                    < MAX_PATCH_BYTES
            );
            assert!(actor.next_due_at_ms().await.unwrap().unwrap() < i64::MAX / 2);

            actor.shutdown().await;
            drop(actor);
            remove_sqlite_files(&path);
        });
    }

    #[test]
    fn manual_refresh_all_rolls_back_every_due_date_on_sqlite_failure() {
        tauri::async_runtime::block_on(async {
            let path = fixture_path();
            let (panel_id, first_source_id, _) = seed(&path, 0);
            let second_source_id = Uuid::new_v4();
            let due_before = i64::MAX / 3;
            let connection = Connection::open(&path).unwrap();
            connection
                .execute("UPDATE sources SET due_at_ms = ?1", [due_before])
                .unwrap();
            connection
                .execute(
                    "INSERT INTO sources (id, name, input_url, feed_url, connector_id,
                      connector_kind, refresh_interval_seconds, status, consecutive_failures,
                      due_at_ms, created_at, updated_at)
                     VALUES (?1, 'Échec', 'https://failure.example.test/',
                      'https://failure.example.test/feed.xml', NULL, 'rss', 60, 'idle', 0,
                      ?2, ?3, ?3)",
                    params![
                        second_source_id.as_bytes().as_slice(),
                        due_before,
                        "2026-01-01T00:00:00.000Z"
                    ],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO panel_sources (panel_id, source_id, position)
                     VALUES (?1, ?2, 1)",
                    params![
                        panel_id.as_bytes().as_slice(),
                        second_source_id.as_bytes().as_slice()
                    ],
                )
                .unwrap();
            connection
                .execute_batch(
                    "CREATE TRIGGER fail_manual_refresh
                     BEFORE UPDATE OF due_at_ms ON sources
                     WHEN OLD.name = 'Échec'
                     BEGIN
                       SELECT RAISE(ABORT, 'forced manual refresh failure');
                     END;",
                )
                .unwrap();
            drop(connection);

            let actor = DatabaseActor::spawn(path.clone());
            let error = actor
                .mutate(
                    Uuid::new_v4(),
                    MutateRequest {
                        operation_id: Uuid::new_v4(),
                        expected_revision: 0,
                        command: MutationCommand::ForceRefreshAll,
                    },
                )
                .await
                .unwrap_err();
            assert_eq!(error.code, "internal_error");
            assert_eq!(actor.revision().await.unwrap(), 0);
            let state = actor.bootstrap(Uuid::new_v4()).await.unwrap();
            assert_eq!(state.sources.len(), 2);
            assert!(state
                .sources
                .iter()
                .all(|source| source.due_at_ms == due_before));
            assert!(state
                .sources
                .iter()
                .any(|source| source.id == first_source_id));

            actor.shutdown().await;
            drop(actor);
            remove_sqlite_files(&path);
        });
    }

    #[test]
    fn feed_configuration_commits_exact_kept_then_deduplicated_addition_order() {
        tauri::async_runtime::block_on(async {
            let path = fixture_path();
            let (panel_id, first_source_id, _) = seed(&path, 0);
            let actor = DatabaseActor::spawn(path.clone());
            let session_id = Uuid::new_v4();
            let second = add_generic_source(
                &actor,
                session_id,
                0,
                panel_id,
                generic_source("Deuxième", 2),
                None,
            )
            .await;
            let second_source_id = created_source_id(&second);
            let third = add_generic_source(
                &actor,
                session_id,
                1,
                panel_id,
                generic_source("Troisième", 3),
                None,
            )
            .await;
            let third_source_id = created_source_id(&third);
            let mut existing_second = generic_source("Deuxième ignoré", 2);
            existing_second.refresh_interval_seconds = 300;
            let mut fourth = generic_source("Quatrième", 4);
            fourth.refresh_interval_seconds = 300;

            let result = actor
                .mutate(
                    session_id,
                    MutateRequest {
                        operation_id: Uuid::new_v4(),
                        expected_revision: 2,
                        command: MutationCommand::SaveFeedPanelConfiguration {
                            panel_id,
                            name: "  Fil réordonné  ".to_owned(),
                            default_refresh_interval_seconds: 300,
                            kept_source_ids: vec![third_source_id, first_source_id],
                            new_sources: vec![existing_second, fourth.clone(), fourth],
                        },
                    },
                )
                .await
                .unwrap();
            assert_eq!(result.ack.committed_revision, 3);
            assert!(
                serde_json::to_vec(result.patch.as_ref().unwrap())
                    .unwrap()
                    .len()
                    < MAX_PATCH_BYTES
            );
            let state = actor.bootstrap(session_id).await.unwrap();
            let Panel::Feed {
                name,
                source_ids,
                default_refresh_interval_seconds,
                ..
            } = state
                .panels
                .into_iter()
                .find(|panel| panel.id() == panel_id)
                .unwrap()
            else {
                panic!("expected feed panel")
            };
            assert_eq!(name, "Fil réordonné");
            assert_eq!(default_refresh_interval_seconds, 300);
            assert_eq!(state.sources.len(), 4);
            let fourth_source_id = state
                .sources
                .iter()
                .find(|source| source.feed_url.contains("source-4"))
                .unwrap()
                .id;
            assert_eq!(
                source_ids,
                vec![
                    third_source_id,
                    first_source_id,
                    second_source_id,
                    fourth_source_id
                ]
            );
            assert_eq!(
                result
                    .patch
                    .unwrap()
                    .changes
                    .iter()
                    .filter(|change| matches!(change, StateChange::SourceUpsert { .. }))
                    .count(),
                1
            );

            actor.shutdown().await;
            drop(actor);
            remove_sqlite_files(&path);
        });
    }

    #[test]
    fn feed_configuration_attaches_a_shared_source_without_mutating_the_sibling() {
        tauri::async_runtime::block_on(async {
            let path = fixture_path();
            let (first_panel_id, shared_source_id, _) = seed(&path, 0);
            let actor = DatabaseActor::spawn(path.clone());
            let session_id = Uuid::new_v4();
            let second = create_feed_panel(
                &actor,
                session_id,
                0,
                "Second",
                Some(PanelPlacement {
                    target_panel_id: first_panel_id,
                    side: PlacementSide::Right,
                }),
            )
            .await;
            let second_panel_id = created_panel_id(&second);
            let result = actor
                .mutate(
                    session_id,
                    MutateRequest {
                        operation_id: Uuid::new_v4(),
                        expected_revision: 1,
                        command: MutationCommand::SaveFeedPanelConfiguration {
                            panel_id: second_panel_id,
                            name: "Second configuré".to_owned(),
                            default_refresh_interval_seconds: 300,
                            kept_source_ids: Vec::new(),
                            new_sources: vec![GenericSourceInput {
                                name: "Ne doit pas remplacer le nom global".to_owned(),
                                input_url: "https://example.test/".to_owned(),
                                feed_url: "https://example.test/feed".to_owned(),
                                connector_kind: ConnectorKind::Rss,
                                refresh_interval_seconds: 300,
                            }],
                        },
                    },
                )
                .await
                .unwrap();
            assert_eq!(result.ack.committed_revision, 2);
            let state = actor.bootstrap(session_id).await.unwrap();
            let first_panel = state
                .panels
                .iter()
                .find(|panel| panel.id() == first_panel_id)
                .unwrap();
            let second_panel = state
                .panels
                .iter()
                .find(|panel| panel.id() == second_panel_id)
                .unwrap();
            assert!(matches!(
                first_panel,
                Panel::Feed { source_ids, .. } if source_ids == &vec![shared_source_id]
            ));
            assert!(matches!(
                second_panel,
                Panel::Feed { source_ids, .. } if source_ids == &vec![shared_source_id]
            ));
            let shared = state
                .sources
                .into_iter()
                .find(|source| source.id == shared_source_id)
                .unwrap();
            assert_eq!(shared.name, "Source");
            assert_eq!(shared.refresh_interval_seconds, 60);
            assert!(!result
                .patch
                .unwrap()
                .changes
                .iter()
                .any(|change| matches!(change, StateChange::SourceUpsert { .. })));

            actor.shutdown().await;
            drop(actor);
            remove_sqlite_files(&path);
        });
    }

    #[test]
    fn feed_configuration_rolls_back_exactly_and_publishes_nothing_on_writer_failure() {
        tauri::async_runtime::block_on(async {
            let path = fixture_path();
            let (panel_id, first_source_id, _) = seed(&path, 0);
            let actor = DatabaseActor::spawn(path.clone());
            let session_id = Uuid::new_v4();
            let second = add_generic_source(
                &actor,
                session_id,
                0,
                panel_id,
                generic_source("Deuxième", 2),
                None,
            )
            .await;
            let second_source_id = created_source_id(&second);
            let before = actor.bootstrap(session_id).await.unwrap();
            let connection = Connection::open(&path).unwrap();
            connection
                .execute_batch(
                    "CREATE TRIGGER fail_configuration_attachment
                     BEFORE INSERT ON panel_sources
                     WHEN NEW.position = 1
                     BEGIN
                       SELECT RAISE(ABORT, 'forced composite failure');
                     END;",
                )
                .unwrap();
            drop(connection);
            let operation_id = Uuid::new_v4();
            let mut new_source = generic_source("Nouvelle", 9);
            new_source.refresh_interval_seconds = 30;
            let request = MutateRequest {
                operation_id,
                expected_revision: 1,
                command: MutationCommand::SaveFeedPanelConfiguration {
                    panel_id,
                    name: "Après".to_owned(),
                    default_refresh_interval_seconds: 30,
                    kept_source_ids: vec![second_source_id, first_source_id],
                    new_sources: vec![new_source],
                },
            };

            let error = actor.mutate(session_id, request.clone()).await.unwrap_err();
            assert_eq!(error.code, "internal_error");
            assert_eq!(actor.revision().await.unwrap(), 1);
            assert_eq!(actor.bootstrap(session_id).await.unwrap(), before);

            let connection = Connection::open(&path).unwrap();
            connection
                .execute_batch("DROP TRIGGER fail_configuration_attachment;")
                .unwrap();
            drop(connection);
            let retried = actor.mutate(session_id, request).await.unwrap();
            assert_eq!(retried.ack.operation_id, operation_id);
            assert_eq!(retried.ack.committed_revision, 2);
            assert!(retried.patch.is_some());

            actor.shutdown().await;
            drop(actor);
            remove_sqlite_files(&path);
        });
    }

    #[test]
    fn feed_configuration_preflight_and_writer_reject_invalid_ids_and_limits() {
        tauri::async_runtime::block_on(async {
            let path = fixture_path();
            let (panel_id, source_id, _) = seed(&path, 0);
            let actor = DatabaseActor::spawn(path.clone());
            let session_id = Uuid::new_v4();

            let unknown = actor
                .preflight_feed_panel_configuration(
                    Uuid::new_v4(),
                    0,
                    panel_id,
                    vec![Uuid::new_v4()],
                )
                .await
                .unwrap_err();
            assert_eq!(unknown.code, "invalid_request");
            let duplicated = actor
                .preflight_feed_panel_configuration(
                    Uuid::new_v4(),
                    0,
                    panel_id,
                    vec![source_id, source_id],
                )
                .await
                .unwrap_err();
            assert_eq!(duplicated.code, "invalid_request");

            let oversized = actor
                .mutate(
                    session_id,
                    MutateRequest {
                        operation_id: Uuid::new_v4(),
                        expected_revision: 0,
                        command: MutationCommand::SaveFeedPanelConfiguration {
                            panel_id,
                            name: "Fil".to_owned(),
                            default_refresh_interval_seconds: 60,
                            kept_source_ids: vec![source_id],
                            new_sources: (0..=super::MAX_SOURCES_PER_PANEL)
                                .map(|index| generic_source("Trop", index + 100))
                                .collect(),
                        },
                    },
                )
                .await
                .unwrap_err();
            assert_eq!(oversized.code, "invalid_request");
            assert_eq!(actor.revision().await.unwrap(), 0);
            let state = actor.bootstrap(session_id).await.unwrap();
            assert_eq!(state.sources.len(), 1);
            assert!(matches!(
                &state.panels[0],
                Panel::Feed { source_ids, .. } if source_ids == &vec![source_id]
            ));

            actor.shutdown().await;
            drop(actor);
            remove_sqlite_files(&path);
        });
    }

    #[test]
    fn create_split_delete_and_collapse_are_atomic() {
        tauri::async_runtime::block_on(async {
            let path = fixture_path();
            let actor = DatabaseActor::spawn(path.clone());
            let session_id = Uuid::new_v4();

            let first = create_feed_panel(&actor, session_id, 0, "Premier", None).await;
            let first_id = created_panel_id(&first);
            assert_eq!(first.ack.committed_revision, 1);
            let first_state = actor.bootstrap(session_id).await.unwrap();
            assert_leaf(first_state.dashboard.layout.as_ref().unwrap(), first_id);

            let second = create_feed_panel(
                &actor,
                session_id,
                1,
                "Second",
                Some(PanelPlacement {
                    target_panel_id: first_id,
                    side: PlacementSide::Right,
                }),
            )
            .await;
            let second_id = created_panel_id(&second);
            let second_state = actor.bootstrap(session_id).await.unwrap();
            let LayoutNode::Split {
                direction,
                children,
                ..
            } = second_state.dashboard.layout.as_ref().unwrap()
            else {
                panic!("expected first split");
            };
            assert_eq!(*direction, SplitDirection::Row);
            assert_leaf(&children[0], first_id);
            assert_leaf(&children[1], second_id);

            let third = create_feed_panel(
                &actor,
                session_id,
                2,
                "Troisième",
                Some(PanelPlacement {
                    target_panel_id: second_id,
                    side: PlacementSide::Top,
                }),
            )
            .await;
            let third_id = created_panel_id(&third);
            let third_state = actor.bootstrap(session_id).await.unwrap();
            let LayoutNode::Split { children, .. } = third_state.dashboard.layout.as_ref().unwrap()
            else {
                panic!("expected root split");
            };
            let LayoutNode::Split {
                direction,
                children: nested,
                ..
            } = children[1].as_ref()
            else {
                panic!("expected nested split");
            };
            assert_eq!(*direction, SplitDirection::Column);
            assert_leaf(&nested[0], third_id);
            assert_leaf(&nested[1], second_id);

            let deleted = actor
                .mutate(
                    session_id,
                    MutateRequest {
                        operation_id: Uuid::new_v4(),
                        expected_revision: 3,
                        command: MutationCommand::DeletePanel {
                            panel_id: second_id,
                        },
                    },
                )
                .await
                .unwrap();
            assert!(matches!(
                deleted.patch.as_ref().unwrap().changes.as_slice(),
                [StateChange::PanelRemove { panel_id }, StateChange::Dashboard { .. }]
                    if *panel_id == second_id
            ));
            let collapsed = actor.bootstrap(session_id).await.unwrap();
            let LayoutNode::Split { children, .. } = collapsed.dashboard.layout.as_ref().unwrap()
            else {
                panic!("expected collapsed root split");
            };
            assert_leaf(&children[0], first_id);
            assert_leaf(&children[1], third_id);

            actor
                .mutate(
                    session_id,
                    MutateRequest {
                        operation_id: Uuid::new_v4(),
                        expected_revision: 4,
                        command: MutationCommand::DeletePanel { panel_id: first_id },
                    },
                )
                .await
                .unwrap();
            let single = actor.bootstrap(session_id).await.unwrap();
            assert_leaf(single.dashboard.layout.as_ref().unwrap(), third_id);
            actor
                .mutate(
                    session_id,
                    MutateRequest {
                        operation_id: Uuid::new_v4(),
                        expected_revision: 5,
                        command: MutationCommand::DeletePanel { panel_id: third_id },
                    },
                )
                .await
                .unwrap();
            let empty = actor.bootstrap(session_id).await.unwrap();
            assert!(empty.dashboard.layout.is_none());
            assert!(empty.panels.is_empty());
            assert_eq!(empty.revision, 6);
            actor.shutdown().await;
            drop(actor);
            fs::remove_file(path).unwrap();
        });
    }

    #[test]
    fn web_url_validation_and_stale_revision_leave_state_unchanged() {
        tauri::async_runtime::block_on(async {
            let path = fixture_path();
            let actor = DatabaseActor::spawn(path.clone());
            let session_id = Uuid::new_v4();
            let created = actor
                .mutate(
                    session_id,
                    MutateRequest {
                        operation_id: Uuid::new_v4(),
                        expected_revision: 0,
                        command: MutationCommand::CreatePanel {
                            input: CreatePanelInput::Web {
                                name: "Site".to_owned(),
                                url: "https://example.test/initial".to_owned(),
                            },
                            placement: None,
                        },
                    },
                )
                .await
                .unwrap();
            let panel_id = created_panel_id(&created);
            let before = actor.bootstrap(session_id).await.unwrap();

            let invalid = actor
                .mutate(
                    session_id,
                    MutateRequest {
                        operation_id: Uuid::new_v4(),
                        expected_revision: 1,
                        command: MutationCommand::SetWebPanelUrl {
                            panel_id,
                            url: "https://user:secret@example.test/private".to_owned(),
                        },
                    },
                )
                .await
                .unwrap_err();
            assert_eq!(invalid.code, "invalid_request");
            let stale = actor
                .mutate(
                    session_id,
                    MutateRequest {
                        operation_id: Uuid::new_v4(),
                        expected_revision: 0,
                        command: MutationCommand::SetWebPanelUrl {
                            panel_id,
                            url: "https://example.test/new".to_owned(),
                        },
                    },
                )
                .await
                .unwrap_err();
            assert_eq!(stale.code, "revision_conflict");
            assert_eq!(actor.bootstrap(session_id).await.unwrap(), before);
            actor.shutdown().await;
            drop(actor);
            fs::remove_file(path).unwrap();
        });
    }

    #[test]
    fn failed_structural_mutation_rolls_back_exact_state() {
        tauri::async_runtime::block_on(async {
            let path = fixture_path();
            let (_, _, _) = seed(&path, 2);
            let actor = DatabaseActor::spawn(path.clone());
            let session_id = Uuid::new_v4();
            let before = actor.bootstrap(session_id).await.unwrap();
            let error = actor
                .mutate(
                    session_id,
                    MutateRequest {
                        operation_id: Uuid::new_v4(),
                        expected_revision: 0,
                        command: MutationCommand::CreatePanel {
                            input: CreatePanelInput::Web {
                                name: "Temporaire".to_owned(),
                                url: "https://example.test/temporary".to_owned(),
                            },
                            placement: Some(PanelPlacement {
                                target_panel_id: Uuid::new_v4(),
                                side: PlacementSide::Left,
                            }),
                        },
                    },
                )
                .await
                .unwrap_err();
            assert_eq!(error.code, "not_found");
            assert_eq!(actor.bootstrap(session_id).await.unwrap(), before);
            assert_eq!(actor.revision().await.unwrap(), 0);
            actor.shutdown().await;
            drop(actor);
            fs::remove_file(path).unwrap();
        });
    }

    #[test]
    fn deleting_panel_preserves_shared_global_source_and_items() {
        tauri::async_runtime::block_on(async {
            let path = fixture_path();
            let (first_panel_id, source_id, item_ids) = seed(&path, 1);
            let second_panel_id = Uuid::new_v4();
            let connection = Connection::open(&path).unwrap();
            connection
                .execute_batch("PRAGMA foreign_keys = ON;")
                .unwrap();
            connection
                .execute(
                    "INSERT INTO panels (id, name, position, kind, web_url,
                      default_refresh_interval_seconds, created_at, updated_at)
                     VALUES (?1, 'Partagé', 1, 'feed', NULL, 60, ?2, ?2)",
                    params![
                        second_panel_id.as_bytes().as_slice(),
                        "2026-01-01T00:00:00.000Z"
                    ],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO panel_sources (panel_id, source_id, position)
                     VALUES (?1, ?2, 0)",
                    params![
                        second_panel_id.as_bytes().as_slice(),
                        source_id.as_bytes().as_slice()
                    ],
                )
                .unwrap();
            let layout = LayoutNode::Split {
                id: Uuid::new_v4(),
                direction: SplitDirection::Row,
                ratio: 0.5,
                children: [
                    Box::new(LayoutNode::Panel {
                        panel_id: first_panel_id,
                    }),
                    Box::new(LayoutNode::Panel {
                        panel_id: second_panel_id,
                    }),
                ],
            };
            connection
                .execute(
                    "UPDATE dashboard_state SET layout_json = ?1 WHERE id = 1",
                    [serde_json::to_string(&layout).unwrap()],
                )
                .unwrap();
            drop(connection);

            let actor = DatabaseActor::spawn(path.clone());
            let session_id = Uuid::new_v4();
            actor
                .mutate(
                    session_id,
                    MutateRequest {
                        operation_id: Uuid::new_v4(),
                        expected_revision: 0,
                        command: MutationCommand::DeletePanel {
                            panel_id: first_panel_id,
                        },
                    },
                )
                .await
                .unwrap();
            let after = actor.bootstrap(session_id).await.unwrap();
            assert_eq!(after.panels.len(), 1);
            assert!(matches!(
                &after.panels[0],
                Panel::Feed { id, source_ids, .. }
                    if *id == second_panel_id && source_ids == &vec![source_id]
            ));
            assert_eq!(after.sources.len(), 1);
            assert_eq!(after.sources[0].id, source_id);
            assert_eq!(after.sources[0].item_count, 1);
            assert_eq!(
                actor.get_item(item_ids[0]).await.unwrap().source_id,
                source_id
            );
            actor.shutdown().await;
            drop(actor);
            fs::remove_file(path).unwrap();
        });
    }

    #[test]
    fn source_attachment_order_is_exact_and_detach_keeps_global_sources() {
        tauri::async_runtime::block_on(async {
            let path = fixture_path();
            let actor = DatabaseActor::spawn(path.clone());
            let session_id = Uuid::new_v4();
            let panel = create_feed_panel(&actor, session_id, 0, "Fil", None).await;
            let panel_id = created_panel_id(&panel);

            let first = add_generic_source(
                &actor,
                session_id,
                1,
                panel_id,
                generic_source("Première", 1),
                None,
            )
            .await;
            let first_id = created_source_id(&first);
            let second = add_generic_source(
                &actor,
                session_id,
                2,
                panel_id,
                generic_source("Deuxième", 2),
                Some(0),
            )
            .await;
            let second_id = created_source_id(&second);
            let third = add_generic_source(
                &actor,
                session_id,
                3,
                panel_id,
                generic_source("Troisième", 3),
                Some(1),
            )
            .await;
            let third_id = created_source_id(&third);

            let ordered = actor.bootstrap(session_id).await.unwrap();
            assert!(matches!(
                &ordered.panels[0],
                Panel::Feed { source_ids, .. }
                    if source_ids == &vec![second_id, third_id, first_id]
            ));
            actor
                .mutate(
                    session_id,
                    MutateRequest {
                        operation_id: Uuid::new_v4(),
                        expected_revision: 4,
                        command: MutationCommand::DetachSource {
                            panel_id,
                            source_id: third_id,
                        },
                    },
                )
                .await
                .unwrap();
            let detached = actor.bootstrap(session_id).await.unwrap();
            assert!(matches!(
                &detached.panels[0],
                Panel::Feed { source_ids, .. } if source_ids == &vec![second_id, first_id]
            ));
            assert_eq!(detached.sources.len(), 3);
            assert!(detached.sources.iter().any(|source| source.id == third_id));
            assert_eq!(detached.revision, 5);
            actor.shutdown().await;
            drop(actor);
            fs::remove_file(path).unwrap();
        });
    }

    #[test]
    fn failed_source_add_rolls_back_source_and_attachment_exactly() {
        tauri::async_runtime::block_on(async {
            let path = fixture_path();
            let actor = DatabaseActor::spawn(path.clone());
            let session_id = Uuid::new_v4();
            let panel = create_feed_panel(&actor, session_id, 0, "Fil", None).await;
            let panel_id = created_panel_id(&panel);
            let before = actor.bootstrap(session_id).await.unwrap();

            let error = actor
                .mutate(
                    session_id,
                    MutateRequest {
                        operation_id: Uuid::new_v4(),
                        expected_revision: 1,
                        command: MutationCommand::AddGenericSource {
                            panel_id,
                            source: generic_source("Rollback", 10),
                            position: Some(1),
                        },
                    },
                )
                .await
                .unwrap_err();
            assert_eq!(error.code, "invalid_request");
            assert_eq!(actor.bootstrap(session_id).await.unwrap(), before);
            assert_eq!(actor.revision().await.unwrap(), 1);
            actor.shutdown().await;
            drop(actor);
            fs::remove_file(path).unwrap();
        });
    }

    #[test]
    fn source_mutation_is_idempotent_and_revision_checked() {
        tauri::async_runtime::block_on(async {
            let path = fixture_path();
            let actor = DatabaseActor::spawn(path.clone());
            let session_id = Uuid::new_v4();
            let panel = create_feed_panel(&actor, session_id, 0, "Fil", None).await;
            let panel_id = created_panel_id(&panel);
            let operation_id = Uuid::new_v4();
            let request = MutateRequest {
                operation_id,
                expected_revision: 1,
                command: MutationCommand::AddGenericSource {
                    panel_id,
                    source: generic_source("Unique", 20),
                    position: None,
                },
            };
            let created = actor.mutate(session_id, request.clone()).await.unwrap();
            let source_id = created_source_id(&created);
            assert_eq!(created.ack.committed_revision, 2);
            let duplicate = actor.mutate(session_id, request).await.unwrap();
            assert_eq!(duplicate.ack.committed_revision, 2);
            assert!(duplicate.patch.is_none());

            let stale = actor
                .mutate(
                    session_id,
                    MutateRequest {
                        operation_id: Uuid::new_v4(),
                        expected_revision: 1,
                        command: MutationCommand::DetachSource {
                            panel_id,
                            source_id,
                        },
                    },
                )
                .await
                .unwrap_err();
            assert_eq!(stale.code, "revision_conflict");
            let state = actor.bootstrap(session_id).await.unwrap();
            assert_eq!(state.sources.len(), 1);
            assert!(matches!(
                &state.panels[0],
                Panel::Feed { source_ids, .. } if source_ids == &vec![source_id]
            ));
            assert_eq!(state.revision, 2);
            actor.shutdown().await;
            drop(actor);
            fs::remove_file(path).unwrap();
        });
    }

    #[test]
    fn shared_source_materializes_items_for_every_attached_panel() {
        tauri::async_runtime::block_on(async {
            let path = fixture_path();
            let actor = DatabaseActor::spawn(path.clone());
            let session_id = Uuid::new_v4();
            let first = create_feed_panel(&actor, session_id, 0, "Premier", None).await;
            let first_panel_id = created_panel_id(&first);
            let second = create_feed_panel(
                &actor,
                session_id,
                1,
                "Second",
                Some(PanelPlacement {
                    target_panel_id: first_panel_id,
                    side: PlacementSide::Right,
                }),
            )
            .await;
            let second_panel_id = created_panel_id(&second);
            let source = add_generic_source(
                &actor,
                session_id,
                2,
                first_panel_id,
                generic_source("Partagée", 30),
                None,
            )
            .await;
            let source_id = created_source_id(&source);
            actor
                .ingest_feed(
                    session_id,
                    IngestFeedRequest {
                        operation_id: Uuid::new_v4(),
                        source_id,
                        observed_at: "2026-03-01T12:00:00Z".to_owned(),
                        feed: parsed_feed(1, "Partagé"),
                    },
                )
                .await
                .unwrap();
            actor
                .mutate(
                    session_id,
                    MutateRequest {
                        operation_id: Uuid::new_v4(),
                        expected_revision: 4,
                        command: MutationCommand::AttachSource {
                            panel_id: second_panel_id,
                            source_id,
                            position: None,
                        },
                    },
                )
                .await
                .unwrap();

            let first_page = actor
                .feed_page(FeedPageRequest {
                    panel_id: first_panel_id,
                    cursor: None,
                    limit: 10,
                })
                .await
                .unwrap();
            let second_page = actor
                .feed_page(FeedPageRequest {
                    panel_id: second_panel_id,
                    cursor: None,
                    limit: 10,
                })
                .await
                .unwrap();
            assert_eq!(first_page.items.len(), 1);
            assert_eq!(second_page.items.len(), 1);
            assert_eq!(first_page.items[0].id, second_page.items[0].id);

            actor
                .mutate(
                    session_id,
                    MutateRequest {
                        operation_id: Uuid::new_v4(),
                        expected_revision: 5,
                        command: MutationCommand::DetachSource {
                            panel_id: first_panel_id,
                            source_id,
                        },
                    },
                )
                .await
                .unwrap();
            assert!(actor
                .feed_page(FeedPageRequest {
                    panel_id: first_panel_id,
                    cursor: None,
                    limit: 10,
                })
                .await
                .unwrap()
                .items
                .is_empty());
            assert_eq!(
                actor
                    .feed_page(FeedPageRequest {
                        panel_id: second_panel_id,
                        cursor: None,
                        limit: 10,
                    })
                    .await
                    .unwrap()
                    .items
                    .len(),
                1
            );
            let state = actor.bootstrap(session_id).await.unwrap();
            assert_eq!(state.sources.len(), 1);
            assert_eq!(state.sources[0].id, source_id);
            actor.shutdown().await;
            drop(actor);
            fs::remove_file(path).unwrap();
        });
    }

    #[test]
    fn ingestion_over_two_hundred_invalidates_and_preserves_read_state() {
        tauri::async_runtime::block_on(async {
            let path = fixture_path();
            let actor = DatabaseActor::spawn(path.clone());
            let session_id = Uuid::new_v4();
            let panel = create_feed_panel(&actor, session_id, 0, "Fil", None).await;
            let panel_id = created_panel_id(&panel);
            let source = add_generic_source(
                &actor,
                session_id,
                1,
                panel_id,
                generic_source("Volume", 40),
                None,
            )
            .await;
            let source_id = created_source_id(&source);
            let first_operation_id = Uuid::new_v4();
            let ingested = actor
                .ingest_feed(
                    session_id,
                    IngestFeedRequest {
                        operation_id: first_operation_id,
                        source_id,
                        observed_at: "2026-04-01T12:00:00Z".to_owned(),
                        feed: parsed_feed(250, "Initial"),
                    },
                )
                .await
                .unwrap();
            assert_eq!(ingested.ack.committed_revision, 3);
            let changes = &ingested.patch.as_ref().unwrap().changes;
            assert!(changes.iter().any(
                |change| matches!(change, StateChange::SourceUpsert { source } if source.id == source_id)
            ));
            assert!(changes.iter().any(
                |change| matches!(change, StateChange::PanelInvalidated { panel_id: changed, .. } if *changed == panel_id)
            ));
            assert!(!changes
                .iter()
                .any(|change| matches!(change, StateChange::ItemsUpsert { .. })));

            let first_page = actor
                .feed_page(FeedPageRequest {
                    panel_id,
                    cursor: None,
                    limit: MAX_PAGE_SIZE,
                })
                .await
                .unwrap();
            let second_page = actor
                .feed_page(FeedPageRequest {
                    panel_id,
                    cursor: first_page.next_cursor.clone(),
                    limit: MAX_PAGE_SIZE,
                })
                .await
                .unwrap();
            assert_eq!(first_page.items.len(), 200);
            assert_eq!(second_page.items.len(), 50);
            assert!(first_page
                .items
                .iter()
                .chain(&second_page.items)
                .all(|item| item.is_baseline && item.seen_at.is_some()));
            let item_id = first_page.items[0].id;
            let baseline_seen_at = first_page.items[0].seen_at.clone();
            actor
                .mutate(
                    session_id,
                    MutateRequest {
                        operation_id: Uuid::new_v4(),
                        expected_revision: 3,
                        command: MutationCommand::MarkItemOpened {
                            item_id,
                            at: "2026-04-02T08:00:00Z".to_owned(),
                        },
                    },
                )
                .await
                .unwrap();

            let second_ingestion = IngestFeedRequest {
                operation_id: Uuid::new_v4(),
                source_id,
                observed_at: "2026-04-03T12:00:00Z".to_owned(),
                feed: parsed_feed(250, "Mis à jour"),
            };
            let updated = actor
                .ingest_feed(session_id, second_ingestion.clone())
                .await
                .unwrap();
            assert_eq!(updated.ack.committed_revision, 5);
            assert!(updated.patch.as_ref().unwrap().changes.iter().any(
                |change| matches!(change, StateChange::PanelInvalidated { panel_id: changed, .. } if *changed == panel_id)
            ));
            let item = actor.get_item(item_id).await.unwrap();
            assert!(item.title.starts_with("Mis à jour"));
            assert_eq!(item.seen_at, baseline_seen_at);
            assert_eq!(item.opened_at.as_deref(), Some("2026-04-02T08:00:00.000Z"));

            let duplicate = actor
                .ingest_feed(session_id, second_ingestion)
                .await
                .unwrap();
            assert_eq!(duplicate.ack.committed_revision, 5);
            assert!(duplicate.patch.is_none());
            assert_eq!(actor.revision().await.unwrap(), 5);

            actor.shutdown().await;
            drop(actor);
            let connection = Connection::open(&path).unwrap();
            let source_storage: (String, i64) = connection
                .query_row(
                    "SELECT typeof(id), length(id) FROM sources WHERE id = ?1",
                    [source_id.as_bytes().as_slice()],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            let item_storage: (String, i64) = connection
                .query_row(
                    "SELECT typeof(id), length(id) FROM items WHERE id = ?1",
                    [item_id.as_bytes().as_slice()],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(source_storage, ("blob".to_owned(), 16));
            assert_eq!(item_storage, ("blob".to_owned(), 16));
            drop(connection);
            fs::remove_file(path).unwrap();
        });
    }

    #[test]
    fn search_projection_pages_scopes_and_hydration_are_bounded_and_ordered() {
        tauri::async_runtime::block_on(async {
            let path = fixture_path();
            let (panel_id, source_id, item_ids) = seed(&path, 3);
            let actor = DatabaseActor::spawn(path.clone());

            let first = actor.search_documents_page(None, 2).await.unwrap();
            assert_eq!(first.documents.len(), 2);
            assert!(first.next_cursor.is_some());
            assert!(first
                .documents
                .iter()
                .all(|document| document.panel_ids == vec![panel_id]));
            let second = actor
                .search_documents_page(first.next_cursor, 2)
                .await
                .unwrap();
            assert_eq!(second.documents.len(), 1);
            assert!(second.next_cursor.is_none());

            let source = actor
                .search_documents_for_source(source_id, None, 10)
                .await
                .unwrap();
            let panel = actor
                .search_documents_for_panel(panel_id, None, 10)
                .await
                .unwrap();
            assert_eq!(source.documents.len(), 3);
            assert_eq!(panel.documents, source.documents);

            let targeted = actor
                .search_documents_by_ids(vec![item_ids[2], item_ids[0], item_ids[2]])
                .await
                .unwrap();
            assert_eq!(
                targeted
                    .iter()
                    .map(|document| document.item_id)
                    .collect::<Vec<_>>(),
                vec![item_ids[2], item_ids[0]]
            );

            let missing_id = Uuid::new_v4();
            let hydration = actor
                .hydrate_search_hits(vec![
                    SearchHit {
                        item_id: item_ids[2],
                        score_micros: 900,
                    },
                    SearchHit {
                        item_id: missing_id,
                        score_micros: 800,
                    },
                    SearchHit {
                        item_id: item_ids[0],
                        score_micros: 700,
                    },
                ])
                .await
                .unwrap();
            assert_eq!(
                hydration
                    .results
                    .iter()
                    .map(|result| (result.item.id, result.score_micros))
                    .collect::<Vec<_>>(),
                vec![(item_ids[2], 900), (item_ids[0], 700)]
            );
            assert_eq!(hydration.missing_item_ids, vec![missing_id]);

            assert_eq!(
                actor.search_documents_page(None, 0).await.unwrap_err().code,
                "invalid_request"
            );
            assert_eq!(
                actor
                    .search_documents_page(None, 2_001)
                    .await
                    .unwrap_err()
                    .code,
                "invalid_request"
            );
            assert_eq!(
                actor
                    .search_documents_by_ids(vec![Uuid::new_v4(); 201])
                    .await
                    .unwrap_err()
                    .code,
                "invalid_request"
            );

            actor.shutdown().await;
            drop(actor);
            remove_sqlite_files(&path);
        });
    }

    #[test]
    fn event_driven_search_sync_rebuilds_then_tracks_attach_detach_and_delete() {
        tauri::async_runtime::block_on(async {
            let path = fixture_path();
            let index_path = fixture_path();
            let (panel_id, source_id, _) = seed(&path, 3);
            let actor = DatabaseActor::spawn(path.clone());
            let index = SearchIndexActor::spawn(index_path.clone());
            let statuses = Arc::new(Mutex::new(Vec::new()));
            let published_statuses = Arc::clone(&statuses);
            let synchronizer = SearchSynchronizer::spawn_with_publisher(
                actor.clone(),
                index.clone(),
                Arc::new(move |status| published_statuses.lock().unwrap().push(status)),
            );

            assert!(!index_path.exists());
            assert!(!synchronizer.is_ready());
            assert!(statuses.lock().unwrap().is_empty());
            synchronizer.schedule_initial_sync();
            synchronizer.schedule_initial_sync();
            for _ in 0..200 {
                if synchronizer.is_ready() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            assert!(synchronizer.is_ready());
            assert!(index_path.exists());
            assert_eq!(statuses.lock().unwrap().len(), 1);
            assert!(statuses.lock().unwrap()[0].lexical_ready);
            assert!(!statuses.lock().unwrap()[0].semantic_ready);

            let search_request = |panel_id| SearchRequest {
                query: "article".to_owned(),
                panel_id,
                mode: SearchMode::Lexical,
                limit: 20,
            };
            let initial_hits = index.search(search_request(None)).await.unwrap();
            assert_eq!(initial_hits.len(), 3);
            let hydration = actor
                .hydrate_search_hits(initial_hits.clone())
                .await
                .unwrap();
            assert_eq!(hydration.results.len(), 3);
            assert_eq!(
                hydration
                    .results
                    .iter()
                    .map(|result| result.item.id)
                    .collect::<Vec<_>>(),
                initial_hits
                    .iter()
                    .map(|result| result.item_id)
                    .collect::<Vec<_>>()
            );
            assert_eq!(
                index
                    .search(search_request(Some(panel_id)))
                    .await
                    .unwrap()
                    .len(),
                3
            );

            let ingested = actor
                .ingest_feed(
                    Uuid::new_v4(),
                    IngestFeedRequest {
                        operation_id: Uuid::new_v4(),
                        source_id,
                        observed_at: "2026-06-01T12:00:00Z".to_owned(),
                        feed: parsed_feed(1, "Dernière minute"),
                    },
                )
                .await
                .unwrap();
            synchronizer.after_ingestion(source_id, ingested.patch.as_ref());
            let ingestion_request = SearchRequest {
                query: "dernière minute".to_owned(),
                panel_id: Some(panel_id),
                mode: SearchMode::Lexical,
                limit: 20,
            };
            for _ in 0..200 {
                if index.search(ingestion_request.clone()).await.unwrap().len() == 1 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            assert_eq!(index.search(ingestion_request).await.unwrap().len(), 1);

            let detach = MutationCommand::DetachSource {
                panel_id,
                source_id,
            };
            let detached = actor
                .mutate(
                    Uuid::new_v4(),
                    MutateRequest {
                        operation_id: Uuid::new_v4(),
                        expected_revision: actor.revision().await.unwrap(),
                        command: detach.clone(),
                    },
                )
                .await
                .unwrap();
            synchronizer.after_mutation(&detach, detached.patch.as_ref());
            for _ in 0..200 {
                if index
                    .search(search_request(Some(panel_id)))
                    .await
                    .unwrap()
                    .is_empty()
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            assert!(index
                .search(search_request(Some(panel_id)))
                .await
                .unwrap()
                .is_empty());
            assert_eq!(index.search(search_request(None)).await.unwrap().len(), 3);

            let attach = MutationCommand::AttachSource {
                panel_id,
                source_id,
                position: None,
            };
            let attached = actor
                .mutate(
                    Uuid::new_v4(),
                    MutateRequest {
                        operation_id: Uuid::new_v4(),
                        expected_revision: actor.revision().await.unwrap(),
                        command: attach.clone(),
                    },
                )
                .await
                .unwrap();
            synchronizer.after_mutation(&attach, attached.patch.as_ref());
            for _ in 0..200 {
                if index
                    .search(search_request(Some(panel_id)))
                    .await
                    .unwrap()
                    .len()
                    == 3
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            assert_eq!(
                index
                    .search(search_request(Some(panel_id)))
                    .await
                    .unwrap()
                    .len(),
                3
            );

            let delete = MutationCommand::DeletePanel { panel_id };
            let deleted = actor
                .mutate(
                    Uuid::new_v4(),
                    MutateRequest {
                        operation_id: Uuid::new_v4(),
                        expected_revision: actor.revision().await.unwrap(),
                        command: delete.clone(),
                    },
                )
                .await
                .unwrap();
            synchronizer.after_mutation(&delete, deleted.patch.as_ref());
            for _ in 0..200 {
                if index
                    .search(search_request(Some(panel_id)))
                    .await
                    .unwrap()
                    .is_empty()
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            assert!(index
                .search(search_request(Some(panel_id)))
                .await
                .unwrap()
                .is_empty());
            assert_eq!(index.search(search_request(None)).await.unwrap().len(), 3);

            synchronizer.shutdown();
            index.shutdown().await;
            actor.shutdown().await;
            drop((synchronizer, actor));
            remove_sqlite_files(&path);
            remove_sqlite_files(&index_path);
        });
    }

    #[test]
    fn exactly_two_query_only_readers_wait_for_writer_migration() {
        tauri::async_runtime::block_on(async {
            let path = fixture_path();
            let actor = DatabaseActor::spawn(path.clone());

            let mut identities = Vec::new();
            for _ in 0..4 {
                identities.push(actor.reader_identity().await.unwrap());
            }
            assert_eq!(
                identities,
                vec![
                    (0, "vibedeck-sqlite-reader-0".to_owned()),
                    (1, "vibedeck-sqlite-reader-1".to_owned()),
                    (0, "vibedeck-sqlite-reader-0".to_owned()),
                    (1, "vibedeck-sqlite-reader-1".to_owned()),
                ]
            );
            assert_eq!(actor.revision().await.unwrap(), 0);

            let connection = Connection::open(&path).unwrap();
            let schema_version: i64 = connection
                .query_row("PRAGMA user_version", [], |row| row.get(0))
                .unwrap();
            let dashboard_table: String = connection
                .query_row(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dashboard_state'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(schema_version, super::DATABASE_SCHEMA_VERSION);
            assert_eq!(dashboard_table, "dashboard_state");

            drop(connection);
            actor.shutdown().await;
            drop(actor);
            remove_sqlite_files(&path);
        });
    }

    #[test]
    fn bundled_sqlite_contains_the_concurrent_wal_lifecycle_fix() {
        // SQLite 3.51.1 introduced a reachable Unix VFS lock-order inversion
        // when one thread opened a WAL database while another closed one. The
        // upstream fix shipped in 3.51.2. Keep the bundled runtime above that
        // floor: VibeDeck intentionally owns several independent SQLite actors.
        assert!(
            rusqlite::version_number() >= 3_051_002,
            "bundled SQLite {} lacks the concurrent WAL lifecycle fix",
            rusqlite::version()
        );
    }

    #[test]
    fn parallel_sqlite_actor_lifecycles_join_without_deadlock() {
        tauri::async_runtime::block_on(async {
            let tasks = (0..12)
                .map(|index| {
                    tauri::async_runtime::spawn(async move {
                        let path = fixture_path();
                        let cache_path = path.with_extension("http-cache.sqlite");
                        let search_path = path.with_extension("search.sqlite");
                        let actor = DatabaseActor::spawn(path.clone());
                        let cache = HttpCacheActor::spawn(cache_path.clone());
                        let search = SearchIndexActor::spawn(search_path.clone());
                        let session_id = Uuid::new_v4();
                        create_feed_panel(&actor, session_id, 0, &format!("Fil {index}"), None)
                            .await;
                        assert!(cache
                            .get(format!("https://source-{index}.example.test/feed.xml"))
                            .await
                            .unwrap()
                            .is_none());
                        search.clear().await.unwrap();
                        let identities = vec![
                            actor.reader_identity().await.unwrap(),
                            actor.reader_identity().await.unwrap(),
                            actor.reader_identity().await.unwrap(),
                            actor.reader_identity().await.unwrap(),
                        ];
                        assert_eq!(
                            identities,
                            vec![
                                (0, "vibedeck-sqlite-reader-0".to_owned()),
                                (1, "vibedeck-sqlite-reader-1".to_owned()),
                                (0, "vibedeck-sqlite-reader-0".to_owned()),
                                (1, "vibedeck-sqlite-reader-1".to_owned()),
                            ]
                        );

                        let first = actor.clone();
                        let second = actor.clone();
                        let ((), (), ()) = join3(
                            async { join(first.shutdown(), second.shutdown()).await.0 },
                            cache.shutdown(),
                            search.shutdown(),
                        )
                        .await;
                        assert_eq!(actor.revision().await.unwrap_err().code, "internal_error");
                        drop((first, second, actor));
                        remove_sqlite_files(&path);
                        remove_sqlite_files(&cache_path);
                        remove_sqlite_files(&search_path);
                    })
                })
                .collect::<Vec<_>>();

            let completed = tokio::time::timeout(Duration::from_secs(10), join_all(tasks))
                .await
                .expect("parallel SQLite actor shutdown must not hang");
            for task in completed {
                task.expect("parallel SQLite actor task must finish");
            }
        });
    }

    #[test]
    fn both_readers_observe_a_committed_writer_mutation() {
        tauri::async_runtime::block_on(async {
            let path = fixture_path();
            let (_, _, item_ids) = seed(&path, 1);
            let actor = DatabaseActor::spawn(path.clone());
            let item_id = item_ids[0];

            assert_eq!(actor.revision().await.unwrap(), 0);
            assert!(actor.get_item(item_id).await.unwrap().seen_at.is_none());

            let seen_at = "2026-07-15T10:00:00.000Z".to_owned();
            let result = actor
                .mutate(
                    Uuid::new_v4(),
                    MutateRequest {
                        operation_id: Uuid::new_v4(),
                        expected_revision: 0,
                        command: MutationCommand::MarkItemsSeen {
                            item_ids: vec![item_id],
                            at: seen_at.clone(),
                        },
                    },
                )
                .await
                .unwrap();
            assert_eq!(result.ack.committed_revision, 1);

            // Round-robin sends these two post-commit reads to distinct,
            // persistent reader connections. Both must refresh their WAL view.
            assert_eq!(actor.revision().await.unwrap(), 1);
            assert_eq!(
                actor.get_item(item_id).await.unwrap().seen_at,
                Some(seen_at)
            );

            actor.shutdown().await;
            drop(actor);
            remove_sqlite_files(&path);
        });
    }

    #[test]
    fn future_schema_fails_closed_for_writer_and_both_readers() {
        tauri::async_runtime::block_on(async {
            let path = fixture_path();
            let connection = Connection::open(&path).unwrap();
            connection.pragma_update(None, "user_version", 99).unwrap();
            drop(connection);
            let actor = DatabaseActor::spawn(path.clone());

            for _ in 0..2 {
                let error = actor.revision().await.unwrap_err();
                assert_eq!(error.code, "internal_error");
            }
            let writer_error = actor
                .mutate(
                    Uuid::new_v4(),
                    MutateRequest {
                        operation_id: Uuid::new_v4(),
                        expected_revision: 0,
                        command: MutationCommand::CreatePanel {
                            input: CreatePanelInput::Feed {
                                name: "Refusé".to_owned(),
                                default_refresh_interval_seconds: None,
                            },
                            placement: None,
                        },
                    },
                )
                .await
                .unwrap_err();
            assert_eq!(writer_error.code, "internal_error");

            actor.shutdown().await;
            drop(actor);
            remove_sqlite_files(&path);
        });
    }
}
