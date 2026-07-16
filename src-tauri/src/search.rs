use crate::{
    error::ApiError,
    model::{SearchMode, SearchRequest, MAX_SEARCH_RESULTS},
};
use rusqlite::{params, types::Type, Connection, OpenFlags, OptionalExtension, Row};
use sha2::{Digest, Sha256};
use std::{
    cmp::Ordering,
    collections::HashMap,
    fs::{self, File},
    hash::Hash,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering as AtomicOrdering},
        mpsc::{self, SyncSender, TrySendError},
        Arc,
    },
    thread,
};
use tokio::sync::oneshot;
use url::Url;
use uuid::Uuid;

pub const SEMANTIC_MODEL_ID: &str = "Xenova/multilingual-e5-small";
pub const SEMANTIC_MODEL_REVISION: &str = "761b726dd34fb83930e26aab4e9ac3899aa1fa78";
pub const SEMANTIC_VECTOR_DIMENSIONS: usize = 384;
pub const MAX_SEARCH_QUERY_CHARS: usize = 240;

const SEARCH_SCHEMA_VERSION: i64 = 1;
const SEARCH_APPLICATION_ID: i64 = 1_447_318_360; // ASCII `VDSX`.
const SEARCH_QUEUE_CAPACITY: usize = 32;
const MAX_INDEX_BATCH_SIZE: usize = 2_000;
const MAX_DOCUMENT_PANELS: usize = 64;
const MAX_DOCUMENT_TITLE_CHARS: usize = 512;
const MAX_DOCUMENT_SUMMARY_BYTES: usize = 16 * 1_024;
const MAX_SOURCE_NAME_CHARS: usize = 120;

type SearchReply<T> = oneshot::Sender<Result<T, ApiError>>;

/// The disposable search projection deliberately contains only identifiers and
/// searchable text. Layout, source configuration and read/open state remain in
/// the authoritative database and can never be damaged by rebuilding this DB.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchDocument {
    pub item_id: Uuid,
    pub title: String,
    pub summary: Option<String>,
    pub source_name: String,
    pub panel_ids: Vec<Uuid>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchHit {
    pub item_id: Uuid,
    pub score_micros: u32,
}

enum SearchCommand {
    Upsert {
        documents: Vec<SearchDocument>,
        reply: SearchReply<()>,
    },
    Remove {
        item_ids: Vec<Uuid>,
        reply: SearchReply<()>,
    },
    SetPanelScopes {
        scopes: Vec<(Uuid, Vec<Uuid>)>,
        reply: SearchReply<()>,
    },
    RemovePanelScope {
        panel_id: Uuid,
        reply: SearchReply<()>,
    },
    Search {
        ticket: u64,
        query: String,
        panel_id: Option<Uuid>,
        limit: u16,
        reply: SearchReply<Vec<SearchHit>>,
    },
    Clear {
        reply: SearchReply<()>,
    },
    Shutdown {
        reply: oneshot::Sender<()>,
    },
}

impl SearchCommand {
    fn fail(self, error: ApiError) {
        match self {
            Self::Upsert { reply, .. }
            | Self::Remove { reply, .. }
            | Self::SetPanelScopes { reply, .. }
            | Self::RemovePanelScope { reply, .. }
            | Self::Clear { reply } => {
                let _ = reply.send(Err(error));
            }
            Self::Search { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Self::Shutdown { reply } => {
                let _ = reply.send(());
            }
        }
    }
}

/// Bounded single-owner actor for the disposable FTS projection.
///
/// Searches are latest-wins: an older queued request, or one overtaken while
/// SQLite is evaluating it, completes with `cancelled`. FTS pages are capped at
/// 200 rows, so no unbounded scan can occupy this worker indefinitely.
#[derive(Clone)]
pub struct SearchIndexActor {
    sender: SyncSender<SearchCommand>,
    latest_search_ticket: Arc<AtomicU64>,
}

impl SearchIndexActor {
    pub fn spawn(path: PathBuf) -> Self {
        let (sender, receiver) = mpsc::sync_channel(SEARCH_QUEUE_CAPACITY);
        let latest_search_ticket = Arc::new(AtomicU64::new(0));
        let worker_ticket = Arc::clone(&latest_search_ticket);
        thread::Builder::new()
            .name("vibedeck-search-index".to_owned())
            .spawn(move || {
                // Opening or rebuilding the derived index is lazy. `spawn`
                // itself performs no filesystem or SQLite work, so native
                // setup can return and paint the cached shell first.
                let mut connection = None;
                let mut shutdown_reply = None;
                while let Ok(command) = receiver.recv() {
                    if let SearchCommand::Shutdown { reply } = command {
                        shutdown_reply = Some(reply);
                        break;
                    }
                    let connection =
                        connection.get_or_insert_with(|| open_or_rebuild_search_index(&path));
                    match connection {
                        Ok(connection) => {
                            handle_search_command(connection, command, worker_ticket.as_ref())
                        }
                        Err(error) => command.fail(error.clone()),
                    }
                }
                // Signal only after dropping SQLite so tests and application
                // shutdown may safely remove or reopen the disposable index.
                drop(connection);
                if let Some(reply) = shutdown_reply {
                    let _ = reply.send(());
                }
            })
            .expect("the search index actor thread must be creatable");
        Self {
            sender,
            latest_search_ticket,
        }
    }

    pub async fn upsert(&self, document: SearchDocument) -> Result<(), ApiError> {
        self.upsert_many(vec![document]).await
    }

    pub async fn upsert_many(&self, documents: Vec<SearchDocument>) -> Result<(), ApiError> {
        if documents.is_empty() || documents.len() > MAX_INDEX_BATCH_SIZE {
            return Err(ApiError::invalid(format!(
                "Une indexation doit contenir entre 1 et {MAX_INDEX_BATCH_SIZE} articles."
            )));
        }
        let documents = documents
            .into_iter()
            .map(validate_document)
            .collect::<Result<Vec<_>, _>>()?;
        let (reply, response) = oneshot::channel();
        self.send(SearchCommand::Upsert { documents, reply })?;
        receive_search_reply(response).await
    }

    pub async fn remove(&self, item_id: Uuid) -> Result<(), ApiError> {
        self.remove_many(vec![item_id]).await
    }

    pub async fn remove_many(&self, mut item_ids: Vec<Uuid>) -> Result<(), ApiError> {
        item_ids.sort_unstable();
        item_ids.dedup();
        if item_ids.is_empty() || item_ids.len() > MAX_INDEX_BATCH_SIZE {
            return Err(ApiError::invalid(format!(
                "Une suppression d'index doit contenir entre 1 et {MAX_INDEX_BATCH_SIZE} articles."
            )));
        }
        let (reply, response) = oneshot::channel();
        self.send(SearchCommand::Remove { item_ids, reply })?;
        receive_search_reply(response).await
    }

    /// Replaces panel membership without rewriting the FTS document. This is
    /// the hook used when a global source is attached to, or detached from, a
    /// panel.
    pub async fn set_panel_scopes(
        &self,
        item_id: Uuid,
        panel_ids: Vec<Uuid>,
    ) -> Result<(), ApiError> {
        self.set_panel_scopes_many(vec![(item_id, panel_ids)]).await
    }

    pub async fn set_panel_scopes_many(
        &self,
        scopes: Vec<(Uuid, Vec<Uuid>)>,
    ) -> Result<(), ApiError> {
        if scopes.is_empty() || scopes.len() > MAX_INDEX_BATCH_SIZE {
            return Err(ApiError::invalid(format!(
                "Une mise à jour de portée doit contenir entre 1 et {MAX_INDEX_BATCH_SIZE} articles."
            )));
        }
        let mut seen = std::collections::HashSet::with_capacity(scopes.len());
        let scopes = scopes
            .into_iter()
            .map(|(item_id, panel_ids)| {
                if item_id.is_nil() || !seen.insert(item_id) {
                    return Err(ApiError::invalid(
                        "Identifiant d'article dupliqué dans les portées de recherche.",
                    ));
                }
                Ok((item_id, normalize_panel_ids(panel_ids)?))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let (reply, response) = oneshot::channel();
        self.send(SearchCommand::SetPanelScopes { scopes, reply })?;
        receive_search_reply(response).await
    }

    pub async fn remove_panel_scope(&self, panel_id: Uuid) -> Result<(), ApiError> {
        let (reply, response) = oneshot::channel();
        self.send(SearchCommand::RemovePanelScope { panel_id, reply })?;
        receive_search_reply(response).await
    }

    pub async fn search(&self, request: SearchRequest) -> Result<Vec<SearchHit>, ApiError> {
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
        let query = build_fts_query(&normalize_search_query(&request.query)?)?;
        let ticket = self
            .latest_search_ticket
            .fetch_add(1, AtomicOrdering::SeqCst)
            .wrapping_add(1);
        let (reply, response) = oneshot::channel();
        self.send(SearchCommand::Search {
            ticket,
            query,
            panel_id: request.panel_id,
            limit: request.limit,
            reply,
        })?;
        receive_search_reply(response).await
    }

    /// Drops all derived rows without touching the authoritative database.
    /// The caller can then stream a fresh projection through `upsert_many`.
    pub async fn clear(&self) -> Result<(), ApiError> {
        let (reply, response) = oneshot::channel();
        self.send(SearchCommand::Clear { reply })?;
        receive_search_reply(response).await
    }

    pub async fn shutdown(&self) {
        let (reply, response) = oneshot::channel();
        let sender = self.sender.clone();
        let sent = tauri::async_runtime::spawn_blocking(move || {
            sender.send(SearchCommand::Shutdown { reply }).is_ok()
        })
        .await
        .unwrap_or(false);
        if sent {
            let _ = response.await;
        }
    }

    fn send(&self, command: SearchCommand) -> Result<(), ApiError> {
        match self.sender.try_send(command) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err(ApiError::busy()),
            Err(TrySendError::Disconnected(_)) => Err(ApiError::internal(
                "L'index de recherche local s'est arrêté.",
            )),
        }
    }
}

async fn receive_search_reply<T>(
    response: oneshot::Receiver<Result<T, ApiError>>,
) -> Result<T, ApiError> {
    response.await.unwrap_or_else(|_| {
        Err(ApiError::internal(
            "L'index de recherche local n'a pas répondu.",
        ))
    })
}

fn handle_search_command(
    connection: &mut Connection,
    command: SearchCommand,
    latest_search_ticket: &AtomicU64,
) {
    match command {
        SearchCommand::Upsert { documents, reply } => {
            let _ = reply.send(upsert_documents(connection, documents));
        }
        SearchCommand::Remove { item_ids, reply } => {
            let _ = reply.send(remove_documents(connection, &item_ids));
        }
        SearchCommand::SetPanelScopes { scopes, reply } => {
            let _ = reply.send(replace_panel_scopes(connection, scopes));
        }
        SearchCommand::RemovePanelScope { panel_id, reply } => {
            let _ = reply.send(remove_panel_scope(connection, panel_id));
        }
        SearchCommand::Search {
            ticket,
            query,
            panel_id,
            limit,
            reply,
        } => {
            let result = if ticket != latest_search_ticket.load(AtomicOrdering::SeqCst) {
                Err(ApiError::cancelled())
            } else {
                search_lexical(connection, &query, panel_id, limit).and_then(|results| {
                    if ticket == latest_search_ticket.load(AtomicOrdering::SeqCst) {
                        Ok(results)
                    } else {
                        Err(ApiError::cancelled())
                    }
                })
            };
            let _ = reply.send(result);
        }
        SearchCommand::Clear { reply } => {
            let _ = reply.send(clear_index(connection));
        }
        SearchCommand::Shutdown { reply } => {
            let _ = reply.send(());
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum IndexOwnership {
    Empty,
    SearchIndex,
    Foreign,
    Unreadable,
}

fn open_or_rebuild_search_index(path: &Path) -> Result<Connection, ApiError> {
    let ownership = inspect_index_ownership(path);
    if ownership == IndexOwnership::Foreign {
        return Err(ApiError::internal(
            "Le chemin de l'index de recherche désigne une base locale étrangère.",
        ));
    }
    match open_search_index(path) {
        Ok(connection) => Ok(connection),
        Err(_) => {
            remove_search_index_files(path);
            open_search_index(path)
        }
    }
}

fn inspect_index_ownership(path: &Path) -> IndexOwnership {
    if !path.exists() {
        return IndexOwnership::Empty;
    }
    let connection = match Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(connection) => connection,
        Err(_) => return IndexOwnership::Unreadable,
    };
    let application_id =
        match connection.query_row("PRAGMA application_id", [], |row| row.get::<_, i64>(0)) {
            Ok(application_id) => application_id,
            Err(_) => return IndexOwnership::Unreadable,
        };
    if application_id == SEARCH_APPLICATION_ID {
        return IndexOwnership::SearchIndex;
    }
    let version = connection
        .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
        .unwrap_or(-1);
    let user_objects = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_schema
             WHERE name NOT LIKE 'sqlite_%'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(-1);
    if application_id == 0 && version == 0 && user_objects == 0 {
        IndexOwnership::Empty
    } else {
        IndexOwnership::Foreign
    }
}

fn open_search_index(path: &Path) -> Result<Connection, ApiError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|_| ApiError::internal("Le dossier de recherche local est inaccessible."))?;
    }
    let connection = Connection::open(path)?;
    connection.execute_batch(
        "PRAGMA busy_timeout = 2000;
         PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;
         PRAGMA trusted_schema = OFF;
         PRAGMA temp_store = MEMORY;",
    )?;
    let integrity: String = connection.query_row("PRAGMA quick_check(1)", [], |row| row.get(0))?;
    if integrity != "ok" {
        return Err(ApiError::internal(
            "L'index de recherche local est corrompu.",
        ));
    }
    let application_id: i64 =
        connection.query_row("PRAGMA application_id", [], |row| row.get(0))?;
    let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version == 0 && application_id == 0 {
        create_search_schema(&connection)?;
    } else if application_id != SEARCH_APPLICATION_ID || version != SEARCH_SCHEMA_VERSION {
        return Err(ApiError::internal(
            "L'index de recherche local utilise un schéma incompatible.",
        ));
    } else {
        validate_search_schema(&connection)?;
    }
    Ok(connection)
}

fn create_search_schema(connection: &Connection) -> Result<(), ApiError> {
    let transaction = connection.unchecked_transaction()?;
    transaction.execute_batch(
        "CREATE TABLE search_documents (
           item_id BLOB UNIQUE NOT NULL CHECK(length(item_id) = 16)
         );
         CREATE TABLE document_panels (
           item_id BLOB NOT NULL CHECK(length(item_id) = 16),
           panel_id BLOB NOT NULL CHECK(length(panel_id) = 16),
           PRIMARY KEY (item_id, panel_id),
           FOREIGN KEY (item_id) REFERENCES search_documents(item_id) ON DELETE CASCADE
         ) WITHOUT ROWID;
         CREATE INDEX document_panels_by_panel
           ON document_panels(panel_id, item_id);
         CREATE VIRTUAL TABLE search_documents_fts USING fts5(
           title,
           summary,
           source_name,
           tokenize = 'unicode61 remove_diacritics 2'
         );",
    )?;
    transaction.pragma_update(None, "application_id", SEARCH_APPLICATION_ID)?;
    transaction.pragma_update(None, "user_version", SEARCH_SCHEMA_VERSION)?;
    transaction.commit()?;
    validate_search_schema(connection)
}

fn validate_search_schema(connection: &Connection) -> Result<(), ApiError> {
    connection
        .prepare(
            "SELECT d.item_id, f.title, f.summary, f.source_name, p.panel_id
             FROM search_documents AS d
             JOIN search_documents_fts AS f ON f.rowid = d.rowid
             LEFT JOIN document_panels AS p ON p.item_id = d.item_id
             LIMIT 0",
        )
        .map(|_| ())
        .map_err(|_| ApiError::internal("Le schéma de l'index de recherche est invalide."))
}

fn remove_search_index_files(path: &Path) {
    let _ = fs::remove_file(path);
    for suffix in ["-wal", "-shm"] {
        let mut sidecar = path.as_os_str().to_owned();
        sidecar.push(suffix);
        let _ = fs::remove_file(PathBuf::from(sidecar));
    }
}

fn validate_document(mut document: SearchDocument) -> Result<SearchDocument, ApiError> {
    document.title = document
        .title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    document.source_name = document
        .source_name
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if document.title.is_empty()
        || document.title.chars().count() > MAX_DOCUMENT_TITLE_CHARS
        || document.title.chars().any(|character| character == '\0')
    {
        return Err(ApiError::invalid(
            "Titre d'article invalide pour la recherche.",
        ));
    }
    if document.source_name.is_empty()
        || document.source_name.chars().count() > MAX_SOURCE_NAME_CHARS
        || document
            .source_name
            .chars()
            .any(|character| character == '\0')
    {
        return Err(ApiError::invalid(
            "Nom de source invalide pour la recherche.",
        ));
    }
    if document.summary.as_ref().is_some_and(|summary| {
        summary.len() > MAX_DOCUMENT_SUMMARY_BYTES
            || summary.chars().any(|character| character == '\0')
    }) {
        return Err(ApiError::invalid(
            "Résumé d'article invalide pour la recherche.",
        ));
    }
    document.panel_ids = normalize_panel_ids(document.panel_ids)?;
    Ok(document)
}

fn normalize_panel_ids(mut panel_ids: Vec<Uuid>) -> Result<Vec<Uuid>, ApiError> {
    panel_ids.sort_unstable();
    panel_ids.dedup();
    if panel_ids.len() > MAX_DOCUMENT_PANELS {
        return Err(ApiError::invalid(
            "Un article est rattaché à trop de panels de recherche.",
        ));
    }
    Ok(panel_ids)
}

fn upsert_documents(
    connection: &mut Connection,
    documents: Vec<SearchDocument>,
) -> Result<(), ApiError> {
    let transaction = connection.transaction()?;
    {
        let mut insert_document = transaction.prepare_cached(
            "INSERT INTO search_documents (item_id) VALUES (?1)
             ON CONFLICT(item_id) DO NOTHING",
        )?;
        let mut select_row_id =
            transaction.prepare_cached("SELECT rowid FROM search_documents WHERE item_id = ?1")?;
        let mut delete_fts =
            transaction.prepare_cached("DELETE FROM search_documents_fts WHERE rowid = ?1")?;
        let mut insert_fts = transaction.prepare_cached(
            "INSERT INTO search_documents_fts (rowid, title, summary, source_name)
             VALUES (?1, ?2, ?3, ?4)",
        )?;
        let mut delete_scopes =
            transaction.prepare_cached("DELETE FROM document_panels WHERE item_id = ?1")?;
        let mut insert_scope = transaction
            .prepare_cached("INSERT INTO document_panels (item_id, panel_id) VALUES (?1, ?2)")?;
        for document in documents {
            let SearchDocument {
                item_id,
                title,
                summary,
                source_name,
                panel_ids,
            } = document;
            let item_id_bytes = item_id.as_bytes().as_slice();
            insert_document.execute([item_id_bytes])?;
            let row_id: i64 = select_row_id.query_row([item_id_bytes], |row| row.get(0))?;
            delete_fts.execute([row_id])?;
            insert_fts.execute(params![row_id, title, summary, source_name])?;
            delete_scopes.execute([item_id_bytes])?;
            for panel_id in panel_ids {
                insert_scope.execute(params![item_id_bytes, panel_id.as_bytes().as_slice()])?;
            }
        }
    }
    transaction.commit()?;
    Ok(())
}

fn remove_documents(connection: &mut Connection, item_ids: &[Uuid]) -> Result<(), ApiError> {
    let transaction = connection.transaction()?;
    for item_id in item_ids {
        let item_id = item_id.as_bytes().as_slice();
        let row_id = transaction
            .query_row(
                "SELECT rowid FROM search_documents WHERE item_id = ?1",
                [item_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        if let Some(row_id) = row_id {
            transaction.execute(
                "DELETE FROM search_documents_fts WHERE rowid = ?1",
                [row_id],
            )?;
            transaction.execute("DELETE FROM search_documents WHERE item_id = ?1", [item_id])?;
        }
    }
    transaction.commit()?;
    Ok(())
}

fn replace_panel_scopes(
    connection: &mut Connection,
    scopes: Vec<(Uuid, Vec<Uuid>)>,
) -> Result<(), ApiError> {
    let transaction = connection.transaction()?;
    {
        let mut exists = transaction
            .prepare_cached("SELECT EXISTS(SELECT 1 FROM search_documents WHERE item_id = ?1)")?;
        let mut delete_scopes =
            transaction.prepare_cached("DELETE FROM document_panels WHERE item_id = ?1")?;
        let mut insert_scope = transaction
            .prepare_cached("INSERT INTO document_panels (item_id, panel_id) VALUES (?1, ?2)")?;
        for (item_id, panel_ids) in scopes {
            let item_id_bytes = item_id.as_bytes().as_slice();
            if !exists.query_row([item_id_bytes], |row| row.get::<_, bool>(0))? {
                return Err(ApiError::not_found(
                    "Article absent de l'index de recherche.",
                ));
            }
            delete_scopes.execute([item_id_bytes])?;
            for panel_id in panel_ids {
                insert_scope.execute(params![item_id_bytes, panel_id.as_bytes().as_slice()])?;
            }
        }
    }
    transaction.commit()?;
    Ok(())
}

fn remove_panel_scope(connection: &Connection, panel_id: Uuid) -> Result<(), ApiError> {
    connection.execute(
        "DELETE FROM document_panels WHERE panel_id = ?1",
        [panel_id.as_bytes().as_slice()],
    )?;
    Ok(())
}

fn build_fts_query(query: &str) -> Result<String, ApiError> {
    let mut terms = Vec::new();
    let mut current = String::new();
    for character in query.chars() {
        if character.is_alphanumeric() || character == '_' {
            current.push(character);
        } else if !current.is_empty() {
            terms.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        terms.push(current);
    }
    if terms.is_empty() {
        return Err(ApiError::invalid(
            "La recherche doit contenir au moins un mot.",
        ));
    }
    Ok(terms
        .into_iter()
        .map(|term| format!("\"{term}\""))
        .collect::<Vec<_>>()
        .join(" AND "))
}

fn search_lexical(
    connection: &Connection,
    query: &str,
    panel_id: Option<Uuid>,
    limit: u16,
) -> Result<Vec<SearchHit>, ApiError> {
    let sql = if panel_id.is_some() {
        "SELECT d.item_id, bm25(search_documents_fts, 6.0, 2.0, 1.0) AS score
         FROM search_documents_fts
         JOIN search_documents AS d ON d.rowid = search_documents_fts.rowid
         WHERE search_documents_fts MATCH ?1
           AND EXISTS (
             SELECT 1 FROM document_panels AS p
             WHERE p.item_id = d.item_id AND p.panel_id = ?2
           )
         ORDER BY score ASC, hex(d.item_id) ASC
         LIMIT ?3"
    } else {
        "SELECT d.item_id, bm25(search_documents_fts, 6.0, 2.0, 1.0) AS score
         FROM search_documents_fts
         JOIN search_documents AS d ON d.rowid = search_documents_fts.rowid
         WHERE search_documents_fts MATCH ?1
         ORDER BY score ASC, hex(d.item_id) ASC
         LIMIT ?2"
    };
    let mut statement = connection.prepare(sql)?;
    let map_row = |row: &Row<'_>| -> rusqlite::Result<SearchHit> {
        let item_id = uuid_at(row, 0)?;
        let raw_score: f64 = row.get(1)?;
        if !raw_score.is_finite() {
            return Err(rusqlite::Error::FromSqlConversionFailure(
                1,
                Type::Real,
                "non-finite FTS score".into(),
            ));
        }
        let score_micros = ((-raw_score).max(0.0) * 1_000_000.0)
            .round()
            .clamp(0.0, f64::from(u32::MAX)) as u32;
        Ok(SearchHit {
            item_id,
            score_micros,
        })
    };
    let rows = if let Some(panel_id) = panel_id {
        statement.query_map(
            params![query, panel_id.as_bytes().as_slice(), i64::from(limit)],
            map_row,
        )?
    } else {
        statement.query_map(params![query, i64::from(limit)], map_row)?
    };
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

fn clear_index(connection: &mut Connection) -> Result<(), ApiError> {
    let transaction = connection.transaction()?;
    transaction.execute("DELETE FROM search_documents_fts", [])?;
    transaction.execute("DELETE FROM search_documents", [])?;
    transaction.commit()?;
    Ok(())
}

fn uuid_at(row: &Row<'_>, index: usize) -> rusqlite::Result<Uuid> {
    let bytes = row.get_ref(index)?.as_blob()?;
    Uuid::from_slice(bytes).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(index, Type::Blob, Box::new(error))
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ModelFile {
    pub path: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

pub const MODEL_FILES: [ModelFile; 7] = [
    ModelFile {
        path: "config.json",
        size: 658,
        sha256: "cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1",
    },
    ModelFile {
        path: "quant_config.json",
        size: 674,
        sha256: "59d175f15264115f18c698d76e443b5d49fc6c8c599911c421405ef4f236e87d",
    },
    ModelFile {
        path: "special_tokens_map.json",
        size: 167,
        sha256: "d05497f1da52c5e09554c0cd874037a083e1dc1b9cfd48034d1c717f1afc07a7",
    },
    ModelFile {
        path: "tokenizer_config.json",
        size: 443,
        sha256: "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b",
    },
    ModelFile {
        path: "sentencepiece.bpe.model",
        size: 5_069_051,
        sha256: "cfc8146abe2a0488e9e2a0c56de7952f7c11ab059eca145a0a727afce0db2865",
    },
    ModelFile {
        path: "tokenizer.json",
        size: 17_082_730,
        sha256: "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
    },
    ModelFile {
        path: "onnx/model_quantized.onnx",
        size: 118_308_185,
        sha256: "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193",
    },
];

#[derive(Clone, Debug, PartialEq)]
pub struct QuantizedVector {
    pub values: [i8; SEMANTIC_VECTOR_DIMENSIONS],
    pub norm: f32,
}

pub fn normalize_search_query(value: &str) -> Result<String, ApiError> {
    let query = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let length = query.chars().count();
    if !(2..=MAX_SEARCH_QUERY_CHARS).contains(&length) {
        return Err(ApiError::invalid(format!(
            "La recherche doit contenir entre 2 et {MAX_SEARCH_QUERY_CHARS} caractères."
        )));
    }
    Ok(query)
}

pub fn document_hash(title: &str, summary: Option<&str>) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(title.as_bytes());
    hasher.update([0]);
    hasher.update(summary.unwrap_or_default().as_bytes());
    hasher.finalize().into()
}

pub fn quantize_vector(values: &[f32]) -> Result<QuantizedVector, ApiError> {
    let values: &[f32; SEMANTIC_VECTOR_DIMENSIONS] = values
        .try_into()
        .map_err(|_| ApiError::invalid("Vecteur de recherche invalide."))?;
    if values.iter().any(|value| !value.is_finite()) {
        return Err(ApiError::invalid("Vecteur de recherche invalide."));
    }
    let norm = values
        .iter()
        .map(|value| value * value)
        .sum::<f32>()
        .sqrt()
        .max(f32::MIN_POSITIVE);
    let quantized = std::array::from_fn(|index| {
        ((values[index] / norm) * 127.0)
            .round()
            .clamp(-127.0, 127.0) as i8
    });
    Ok(QuantizedVector {
        values: quantized,
        norm,
    })
}

pub fn reciprocal_rank_fusion<T>(rankings: &[Vec<T>], k: usize) -> Vec<T>
where
    T: Clone + Eq + Hash + Ord,
{
    let mut scores = HashMap::<T, f64>::new();
    for ranking in rankings {
        for (index, item) in ranking.iter().enumerate() {
            *scores.entry(item.clone()).or_default() += 1.0 / (k + index + 1) as f64;
        }
    }
    let mut scored = scores.into_iter().collect::<Vec<_>>();
    scored.sort_by(|(first_item, first_score), (second_item, second_score)| {
        second_score
            .total_cmp(first_score)
            .then_with(|| first_item.cmp(second_item))
    });
    scored.into_iter().map(|(item, _)| item).collect()
}

pub fn validate_model_download_url(value: &str) -> Result<Url, ApiError> {
    let url = Url::parse(value)
        .map_err(|_| ApiError::invalid("L'adresse du modèle local est invalide."))?;
    let host = url.host_str().unwrap_or_default();
    let allowed_host = matches!(
        host,
        "huggingface.co" | "us.aws.cdn.hf.co" | "cas-bridge.xethub.hf.co"
    );
    if url.scheme() != "https"
        || !allowed_host
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return Err(ApiError::unsafe_network(
            "Cette adresse de modèle local est refusée.",
        ));
    }
    Ok(url)
}

pub fn verify_installed_model(root: &Path) -> Result<(), ApiError> {
    for expected in MODEL_FILES {
        let path = root.join(expected.path);
        let metadata =
            std::fs::symlink_metadata(&path).map_err(|_| ApiError::unavailable("de recherche"))?;
        if metadata.file_type().is_symlink()
            || !metadata.file_type().is_file()
            || metadata.len() != expected.size
        {
            return Err(ApiError::internal(
                "Le modèle de recherche local ne correspond pas au manifeste signé.",
            ));
        }
        let mut file = File::open(path).map_err(|_| ApiError::unavailable("de recherche"))?;
        let mut hasher = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let count = file
                .read(&mut buffer)
                .map_err(|_| ApiError::internal("Lecture du modèle de recherche impossible."))?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer[..count]);
        }
        if digest_hex(&hasher.finalize()) != expected.sha256 {
            return Err(ApiError::internal(
                "Le modèle de recherche local ne correspond pas au manifeste signé.",
            ));
        }
    }
    Ok(())
}

fn digest_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(char::from(HEX[usize::from(byte >> 4)]));
        output.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    output
}

/// Stable descending score order with an identifier tie-breaker. Kept small
/// and explicit so the eventual ONNX actor cannot introduce nondeterministic
/// result order across macOS and Windows.
pub fn compare_scored_ids(first: (&str, f32), second: (&str, f32)) -> Ordering {
    second
        .1
        .total_cmp(&first.1)
        .then_with(|| first.0.cmp(second.0))
}

#[cfg(test)]
mod tests {
    use super::{
        compare_scored_ids, digest_hex, document_hash, normalize_search_query, quantize_vector,
        reciprocal_rank_fusion, remove_search_index_files, validate_model_download_url,
        SearchCommand, SearchDocument, SearchIndexActor, MODEL_FILES, SEARCH_APPLICATION_ID,
        SEARCH_SCHEMA_VERSION, SEMANTIC_MODEL_ID, SEMANTIC_MODEL_REVISION,
        SEMANTIC_VECTOR_DIMENSIONS,
    };
    use crate::model::{SearchMode, SearchRequest};
    use rusqlite::Connection;
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering as AtomicOrdering},
    };
    use uuid::Uuid;

    fn index_path() -> PathBuf {
        std::env::temp_dir().join(format!("vibedeck-search-{}.sqlite3", Uuid::new_v4()))
    }

    fn document(
        item_id: u128,
        title: &str,
        summary: Option<&str>,
        panel_ids: &[Uuid],
    ) -> SearchDocument {
        SearchDocument {
            item_id: Uuid::from_u128(item_id),
            title: title.to_owned(),
            summary: summary.map(str::to_owned),
            source_name: "Agence Test".to_owned(),
            panel_ids: panel_ids.to_vec(),
        }
    }

    fn request(query: &str, panel_id: Option<Uuid>, mode: SearchMode, limit: u16) -> SearchRequest {
        SearchRequest {
            query: query.to_owned(),
            panel_id,
            mode,
            limit,
        }
    }

    #[test]
    fn preserves_the_pinned_model_contract() {
        assert_eq!(SEMANTIC_MODEL_ID, "Xenova/multilingual-e5-small");
        assert_eq!(SEMANTIC_MODEL_REVISION.len(), 40);
        assert_eq!(MODEL_FILES.len(), 7);
        assert_eq!(MODEL_FILES[6].size, 118_308_185);
        assert!(MODEL_FILES
            .iter()
            .all(|file| file.sha256.len() == 64 && !file.path.starts_with('/')));
        assert_eq!(
            digest_hex(&document_hash("Inflation", None)),
            "9cdeeb924a950f5ce3a93feee1b5fb00783476b219be83a032789e763cb06fbc"
        );
    }

    #[test]
    fn normalizes_and_bounds_queries() {
        assert_eq!(
            normalize_search_query("  hausse\n des   prix ").unwrap(),
            "hausse des prix"
        );
        assert!(normalize_search_query("x").is_err());
        assert!(normalize_search_query(&"x".repeat(241)).is_err());
    }

    #[test]
    fn hashes_documents_and_quantizes_to_exactly_384_bytes() {
        let hash = document_hash("Inflation", Some("Les prix progressent."));
        assert_eq!(
            hash,
            document_hash("Inflation", Some("Les prix progressent."))
        );
        assert_ne!(hash, document_hash("Inflation", Some("Autre résumé.")));
        let vector = (0..SEMANTIC_VECTOR_DIMENSIONS)
            .map(|index| if index % 2 == 0 { 0.5 } else { -0.5 })
            .collect::<Vec<_>>();
        let quantized = quantize_vector(&vector).unwrap();
        assert_eq!(quantized.values.len(), SEMANTIC_VECTOR_DIMENSIONS);
        assert!(quantized.norm > 0.0);
        assert!(quantize_vector(&vector[..383]).is_err());
    }

    #[test]
    fn fuses_rankings_and_orders_score_ties_deterministically() {
        let rankings = vec![vec!["exact", "semantic"], vec!["semantic", "other"]];
        assert_eq!(
            reciprocal_rank_fusion(&rankings, 60),
            vec!["semantic", "exact", "other"]
        );
        assert_eq!(
            compare_scored_ids(("a", 0.5), ("b", 0.5)),
            std::cmp::Ordering::Less
        );
    }

    #[test]
    fn permits_only_exact_https_model_hosts_without_credentials() {
        for url in [
            "https://huggingface.co/Xenova/model",
            "https://us.aws.cdn.hf.co/model",
            "https://cas-bridge.xethub.hf.co/model",
        ] {
            assert!(validate_model_download_url(url).is_ok());
        }
        for url in [
            "https://example.test/model",
            "http://huggingface.co/model",
            "https://token@cas-bridge.xethub.hf.co/model",
            "https://other.xethub.hf.co/model",
            "https://cas-bridge.xethub.hf.co.attacker.test/model",
            "https://huggingface.co:444/model",
        ] {
            assert!(validate_model_download_url(url).is_err(), "{url}");
        }
    }

    #[test]
    fn lexical_index_supports_unicode_panel_scopes_and_scope_updates() {
        tauri::async_runtime::block_on(async {
            let path = index_path();
            let actor = SearchIndexActor::spawn(path.clone());
            let panel_a = Uuid::from_u128(101);
            let panel_b = Uuid::from_u128(102);
            actor
                .upsert_many(vec![
                    document(
                        1,
                        "Économie : hausse des prix",
                        Some("Le coût du panier progresse."),
                        &[panel_a],
                    ),
                    document(
                        2,
                        "Prix de l'énergie en baisse",
                        Some("Le marché recule."),
                        &[panel_b],
                    ),
                    document(3, "Actualité internationale", None, &[panel_a, panel_b]),
                ])
                .await
                .unwrap();

            let unicode = actor
                .search(request("economie", None, SearchMode::Lexical, 20))
                .await
                .unwrap();
            assert_eq!(
                unicode.iter().map(|hit| hit.item_id).collect::<Vec<_>>(),
                vec![Uuid::from_u128(1)]
            );
            assert!(unicode[0].score_micros > 0);

            let panel_results = actor
                .search(request("prix", Some(panel_a), SearchMode::Lexical, 20))
                .await
                .unwrap();
            assert_eq!(panel_results.len(), 1);
            assert_eq!(panel_results[0].item_id, Uuid::from_u128(1));

            actor
                .set_panel_scopes(Uuid::from_u128(1), vec![panel_b, panel_b])
                .await
                .unwrap();
            assert!(actor
                .search(request("prix", Some(panel_a), SearchMode::Lexical, 20))
                .await
                .unwrap()
                .is_empty());
            assert_eq!(
                actor
                    .search(request("prix", Some(panel_b), SearchMode::Lexical, 20))
                    .await
                    .unwrap()
                    .len(),
                2
            );
            assert_eq!(
                actor
                    .set_panel_scopes_many(vec![
                        (Uuid::from_u128(1), vec![panel_a]),
                        (Uuid::from_u128(999), vec![panel_a]),
                    ])
                    .await
                    .unwrap_err()
                    .code,
                "not_found"
            );
            assert_eq!(
                actor
                    .search(request("prix", Some(panel_b), SearchMode::Lexical, 20))
                    .await
                    .unwrap()
                    .len(),
                2,
                "a failed batched scope update must roll back every earlier row"
            );
            actor.remove_panel_scope(panel_b).await.unwrap();
            assert!(actor
                .search(request("prix", Some(panel_b), SearchMode::Lexical, 20))
                .await
                .unwrap()
                .is_empty());

            actor.shutdown().await;
            remove_search_index_files(&path);
        });
    }

    #[test]
    fn lexical_queries_and_batches_are_strictly_bounded_and_semantic_fails_closed() {
        tauri::async_runtime::block_on(async {
            let path = index_path();
            let actor = SearchIndexActor::spawn(path.clone());
            for invalid in [
                request("x", None, SearchMode::Lexical, 20),
                request("!!", None, SearchMode::Lexical, 20),
                request(&"x".repeat(241), None, SearchMode::Lexical, 20),
                request("journal", None, SearchMode::Lexical, 0),
                request("journal", None, SearchMode::Lexical, 201),
            ] {
                assert_eq!(
                    actor.search(invalid).await.unwrap_err().code,
                    "invalid_request"
                );
            }
            for mode in [SearchMode::Semantic, SearchMode::Hybrid] {
                assert_eq!(
                    actor
                        .search(request("journal", None, mode, 20))
                        .await
                        .unwrap_err()
                        .code,
                    "service_unavailable"
                );
            }
            assert_eq!(
                actor.upsert_many(Vec::new()).await.unwrap_err().code,
                "invalid_request"
            );
            assert_eq!(
                actor.remove_many(Vec::new()).await.unwrap_err().code,
                "invalid_request"
            );
            assert_eq!(
                actor
                    .upsert(document(1, " ", None, &[]))
                    .await
                    .unwrap_err()
                    .code,
                "invalid_request"
            );
            actor.shutdown().await;
            remove_search_index_files(&path);
        });
    }

    #[test]
    fn spawning_the_actor_does_not_open_the_index_before_first_use() {
        tauri::async_runtime::block_on(async {
            let path = index_path();
            let actor = SearchIndexActor::spawn(path.clone());
            assert!(!path.exists());
            actor.shutdown().await;
            assert!(!path.exists());
        });
    }

    #[test]
    fn result_order_is_stable_and_upsert_remove_and_clear_are_exact() {
        tauri::async_runtime::block_on(async {
            let path = index_path();
            let actor = SearchIndexActor::spawn(path.clone());
            actor
                .upsert_many(vec![
                    document(3, "Sujet identique", None, &[]),
                    document(1, "Sujet identique", None, &[]),
                    document(2, "Sujet identique", None, &[]),
                ])
                .await
                .unwrap();
            let first = actor
                .search(request("sujet", None, SearchMode::Lexical, 2))
                .await
                .unwrap();
            let second = actor
                .search(request("sujet", None, SearchMode::Lexical, 2))
                .await
                .unwrap();
            assert_eq!(first, second);
            assert_eq!(
                first.iter().map(|hit| hit.item_id).collect::<Vec<_>>(),
                vec![Uuid::from_u128(1), Uuid::from_u128(2)]
            );

            actor
                .upsert(document(1, "Autre contenu", None, &[]))
                .await
                .unwrap();
            actor.remove(Uuid::from_u128(2)).await.unwrap();
            actor.remove(Uuid::from_u128(2)).await.unwrap();
            assert_eq!(
                actor
                    .search(request("sujet", None, SearchMode::Lexical, 20))
                    .await
                    .unwrap()
                    .iter()
                    .map(|hit| hit.item_id)
                    .collect::<Vec<_>>(),
                vec![Uuid::from_u128(3)]
            );
            actor.clear().await.unwrap();
            assert!(actor
                .search(request("sujet", None, SearchMode::Lexical, 20))
                .await
                .unwrap()
                .is_empty());

            actor.shutdown().await;
            remove_search_index_files(&path);
        });
    }

    #[test]
    fn an_overtaken_queued_search_is_cancelled_before_sqlite_work() {
        let path = index_path();
        let mut connection = super::open_or_rebuild_search_index(&path).unwrap();
        let latest_ticket = AtomicU64::new(2);
        let (reply, response) = tokio::sync::oneshot::channel();
        super::handle_search_command(
            &mut connection,
            SearchCommand::Search {
                ticket: 1,
                query: "\"journal\"".to_owned(),
                panel_id: None,
                limit: 20,
                reply,
            },
            &latest_ticket,
        );
        assert_eq!(
            response.blocking_recv().unwrap().unwrap_err().code,
            "cancelled"
        );
        assert_eq!(latest_ticket.load(AtomicOrdering::SeqCst), 2);
        drop(connection);
        remove_search_index_files(&path);
    }

    #[test]
    fn corrupt_and_owned_future_indexes_are_rebuilt() {
        tauri::async_runtime::block_on(async {
            let corrupt_path = index_path();
            fs::write(&corrupt_path, b"not a sqlite database").unwrap();
            let corrupt_actor = SearchIndexActor::spawn(corrupt_path.clone());
            corrupt_actor
                .upsert(document(1, "Index reconstruit", None, &[]))
                .await
                .unwrap();
            assert_eq!(
                corrupt_actor
                    .search(request("reconstruit", None, SearchMode::Lexical, 20))
                    .await
                    .unwrap()
                    .len(),
                1
            );
            corrupt_actor.shutdown().await;
            let connection = Connection::open(&corrupt_path).unwrap();
            assert_eq!(
                connection
                    .query_row("PRAGMA application_id", [], |row| row.get::<_, i64>(0))
                    .unwrap(),
                SEARCH_APPLICATION_ID
            );
            drop(connection);
            remove_search_index_files(&corrupt_path);

            let future_path = index_path();
            let connection = Connection::open(&future_path).unwrap();
            connection
                .pragma_update(None, "application_id", SEARCH_APPLICATION_ID)
                .unwrap();
            connection.pragma_update(None, "user_version", 99).unwrap();
            connection
                .execute("CREATE TABLE stale(value TEXT)", [])
                .unwrap();
            drop(connection);
            let future_actor = SearchIndexActor::spawn(future_path.clone());
            future_actor
                .upsert(document(2, "Schéma neuf", None, &[]))
                .await
                .unwrap();
            future_actor.shutdown().await;
            let connection = Connection::open(&future_path).unwrap();
            assert_eq!(
                connection
                    .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                    .unwrap(),
                SEARCH_SCHEMA_VERSION
            );
            assert_eq!(
                connection
                    .query_row(
                        "SELECT COUNT(*) FROM sqlite_schema WHERE name = 'stale'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )
                    .unwrap(),
                0
            );
            drop(connection);
            remove_search_index_files(&future_path);
        });
    }

    #[test]
    fn a_foreign_sqlite_database_is_never_treated_as_disposable() {
        tauri::async_runtime::block_on(async {
            let path = index_path();
            let connection = Connection::open(&path).unwrap();
            connection
                .execute("CREATE TABLE dashboard_state(value TEXT NOT NULL)", [])
                .unwrap();
            connection
                .execute("INSERT INTO dashboard_state VALUES ('preserve me')", [])
                .unwrap();
            connection.pragma_update(None, "user_version", 1).unwrap();
            drop(connection);

            let actor = SearchIndexActor::spawn(path.clone());
            assert_eq!(
                actor
                    .upsert(document(1, "Ne jamais écrire ici", None, &[]))
                    .await
                    .unwrap_err()
                    .code,
                "internal_error"
            );
            actor.shutdown().await;

            let connection = Connection::open(&path).unwrap();
            assert_eq!(
                connection
                    .query_row("SELECT value FROM dashboard_state", [], |row| {
                        row.get::<_, String>(0)
                    })
                    .unwrap(),
                "preserve me"
            );
            drop(connection);
            remove_search_index_files(&path);
        });
    }
}
