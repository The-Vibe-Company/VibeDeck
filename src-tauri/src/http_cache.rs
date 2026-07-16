use crate::{
    error::ApiError,
    network::{normalize_feed_url, MAX_HTTP_URL_LENGTH, MAX_RESPONSE_BYTES},
};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::mpsc::{self, SyncSender, TrySendError},
    thread,
};
use tokio::sync::oneshot;

const CACHE_SCHEMA_VERSION: i64 = 1;
const CACHE_APPLICATION_ID: i64 = 0x5644_4843; // ASCII `VDHC`.
const CACHE_QUEUE_CAPACITY: usize = 32;
const MAX_CACHE_ENTRIES: i64 = 512;
const MAX_VALIDATOR_BYTES: usize = 1_024;
const MAX_CONTENT_TYPE_BYTES: usize = 256;

type CacheReply<T> = oneshot::Sender<Result<T, ApiError>>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpCacheEntry {
    pub endpoint: String,
    pub final_url: String,
    pub content_type: Option<String>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub body: Vec<u8>,
    pub fetched_at_ms: i64,
    pub expires_at_ms: i64,
    /// True only after the authoritative writer committed items derived from
    /// this exact response. A 304 may skip parsing/upserts only in that state.
    pub materialized: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CacheValidators {
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub materialized: bool,
}

enum CacheCommand {
    Get {
        endpoint: String,
        reply: CacheReply<Option<HttpCacheEntry>>,
    },
    Put {
        entry: HttpCacheEntry,
        reply: CacheReply<()>,
    },
    MarkMaterialized {
        endpoint: String,
        reply: CacheReply<()>,
    },
    TouchNotModified {
        endpoint: String,
        fetched_at_ms: i64,
        expires_at_ms: i64,
        reply: CacheReply<Option<CacheValidators>>,
    },
    Remove {
        endpoint: String,
        reply: CacheReply<()>,
    },
    Shutdown {
        reply: oneshot::Sender<()>,
    },
}

impl CacheCommand {
    fn fail(self, error: ApiError) {
        match self {
            Self::Get { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Self::Put { reply, .. }
            | Self::MarkMaterialized { reply, .. }
            | Self::Remove { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Self::TouchNotModified { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Self::Shutdown { reply } => {
                let _ = reply.send(());
            }
        }
    }
}

/// A disposable SQLite actor. It deliberately has no reference to the
/// authoritative VibeDeck database, so deleting or rebuilding this cache can
/// never touch layout, source attachments, or Seen/Opened state.
#[derive(Clone)]
pub struct HttpCacheActor {
    sender: SyncSender<CacheCommand>,
}

impl HttpCacheActor {
    pub fn spawn(path: PathBuf) -> Self {
        let (sender, receiver) = mpsc::sync_channel(CACHE_QUEUE_CAPACITY);
        thread::Builder::new()
            .name("vibedeck-http-cache".to_owned())
            .spawn(move || {
                let mut connection = open_or_rebuild_cache(&path);
                let mut shutdown_reply = None;
                while let Ok(command) = receiver.recv() {
                    match command {
                        CacheCommand::Shutdown { reply } => {
                            shutdown_reply = Some(reply);
                            break;
                        }
                        command => match &mut connection {
                            Ok(connection) => handle_command(connection, command),
                            Err(error) => command.fail(error.clone()),
                        },
                    }
                }
                // A shutdown acknowledgement proves that SQLite has released
                // its WAL/VFS locks, not merely that the command was dequeued.
                drop(connection);
                if let Some(reply) = shutdown_reply {
                    let _ = reply.send(());
                }
            })
            .expect("the HTTP cache actor thread must be creatable");
        Self { sender }
    }

    pub async fn get(&self, endpoint: String) -> Result<Option<HttpCacheEntry>, ApiError> {
        let (reply, response) = oneshot::channel();
        self.send(CacheCommand::Get { endpoint, reply })?;
        receive(response).await
    }

    pub async fn put(&self, entry: HttpCacheEntry) -> Result<(), ApiError> {
        let (reply, response) = oneshot::channel();
        self.send(CacheCommand::Put { entry, reply })?;
        receive(response).await
    }

    pub async fn mark_materialized(&self, endpoint: String) -> Result<(), ApiError> {
        let (reply, response) = oneshot::channel();
        self.send(CacheCommand::MarkMaterialized { endpoint, reply })?;
        receive(response).await
    }

    pub async fn touch_not_modified(
        &self,
        endpoint: String,
        fetched_at_ms: i64,
        expires_at_ms: i64,
    ) -> Result<Option<CacheValidators>, ApiError> {
        let (reply, response) = oneshot::channel();
        self.send(CacheCommand::TouchNotModified {
            endpoint,
            fetched_at_ms,
            expires_at_ms,
            reply,
        })?;
        receive(response).await
    }

    pub async fn remove(&self, endpoint: String) -> Result<(), ApiError> {
        let (reply, response) = oneshot::channel();
        self.send(CacheCommand::Remove { endpoint, reply })?;
        receive(response).await
    }

    pub async fn shutdown(&self) {
        let (reply, response) = oneshot::channel();
        let sender = self.sender.clone();
        let sent = tauri::async_runtime::spawn_blocking(move || {
            sender.send(CacheCommand::Shutdown { reply }).is_ok()
        })
        .await
        .unwrap_or(false);
        if sent {
            let _ = response.await;
        }
    }

    fn send(&self, command: CacheCommand) -> Result<(), ApiError> {
        match self.sender.try_send(command) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err(ApiError::busy()),
            Err(TrySendError::Disconnected(_)) => {
                Err(ApiError::internal("Le cache HTTP local s'est arrêté."))
            }
        }
    }
}

async fn receive<T>(response: oneshot::Receiver<Result<T, ApiError>>) -> Result<T, ApiError> {
    response
        .await
        .unwrap_or_else(|_| Err(ApiError::internal("Le cache HTTP local n'a pas répondu.")))
}

fn handle_command(connection: &mut Connection, command: CacheCommand) {
    match command {
        CacheCommand::Get { endpoint, reply } => {
            let _ = reply.send(read_entry(connection, &endpoint));
        }
        CacheCommand::Put { entry, reply } => {
            let _ = reply.send(write_entry(connection, entry));
        }
        CacheCommand::MarkMaterialized { endpoint, reply } => {
            let _ = reply.send(mark_materialized(connection, &endpoint));
        }
        CacheCommand::TouchNotModified {
            endpoint,
            fetched_at_ms,
            expires_at_ms,
            reply,
        } => {
            let _ = reply.send(touch_not_modified(
                connection,
                &endpoint,
                fetched_at_ms,
                expires_at_ms,
            ));
        }
        CacheCommand::Remove { endpoint, reply } => {
            let _ = reply.send(remove_entry(connection, &endpoint));
        }
        CacheCommand::Shutdown { reply } => {
            let _ = reply.send(());
        }
    }
}

fn open_or_rebuild_cache(path: &Path) -> Result<Connection, ApiError> {
    if inspect_cache_ownership(path) == CacheOwnership::Foreign {
        return Err(ApiError::internal(
            "Le chemin du cache HTTP désigne une base locale étrangère.",
        ));
    }
    match open_cache(path) {
        Ok(connection) => Ok(connection),
        Err(_) => {
            remove_cache_files(path);
            open_cache(path)
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CacheOwnership {
    Empty,
    HttpCache,
    Foreign,
    Unreadable,
}

fn inspect_cache_ownership(path: &Path) -> CacheOwnership {
    if !path.exists() {
        return CacheOwnership::Empty;
    }
    let connection = match Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(connection) => connection,
        Err(_) => return CacheOwnership::Unreadable,
    };
    let application_id =
        match connection.query_row("PRAGMA application_id", [], |row| row.get::<_, i64>(0)) {
            Ok(application_id) => application_id,
            Err(_) => return CacheOwnership::Unreadable,
        };
    if application_id == CACHE_APPLICATION_ID {
        return CacheOwnership::HttpCache;
    }
    let version = connection
        .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
        .unwrap_or(-1);
    let objects = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(-1);
    if application_id == 0 && version == 0 && objects == 0 {
        CacheOwnership::Empty
    } else {
        CacheOwnership::Foreign
    }
}

fn open_cache(path: &Path) -> Result<Connection, ApiError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|_| ApiError::internal("Le dossier du cache HTTP est inaccessible."))?;
    }
    let connection = Connection::open(path)?;
    connection.execute_batch(
        "PRAGMA busy_timeout = 2000;
         PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA trusted_schema = OFF;",
    )?;
    let integrity: String = connection.query_row("PRAGMA quick_check(1)", [], |row| row.get(0))?;
    if integrity != "ok" {
        return Err(ApiError::internal("Le cache HTTP local est corrompu."));
    }
    let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let application_id: i64 =
        connection.query_row("PRAGMA application_id", [], |row| row.get(0))?;
    if version == 0 && application_id == 0 {
        connection.pragma_update(None, "application_id", CACHE_APPLICATION_ID)?;
    } else if application_id != CACHE_APPLICATION_ID || version != CACHE_SCHEMA_VERSION {
        return Err(ApiError::internal(
            "Le cache HTTP local utilise un schéma incompatible.",
        ));
    }
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS endpoint_cache (
           endpoint TEXT PRIMARY KEY NOT NULL CHECK(length(endpoint) BETWEEN 1 AND 4096),
           final_url TEXT NOT NULL CHECK(length(final_url) BETWEEN 1 AND 4096),
           content_type TEXT,
           etag TEXT,
           last_modified TEXT,
           body BLOB NOT NULL CHECK(length(body) BETWEEN 1 AND 12000000),
           body_sha256 BLOB NOT NULL CHECK(length(body_sha256) = 32),
           fetched_at_ms INTEGER NOT NULL,
           expires_at_ms INTEGER NOT NULL,
           materialized INTEGER NOT NULL CHECK(materialized IN (0, 1)),
           last_accessed_ms INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS endpoint_cache_lru
           ON endpoint_cache(last_accessed_ms, endpoint);
         PRAGMA user_version = 1;",
    )?;
    Ok(connection)
}

fn remove_cache_files(path: &Path) {
    let _ = fs::remove_file(path);
    for suffix in ["-wal", "-shm"] {
        let mut sidecar = path.as_os_str().to_owned();
        sidecar.push(suffix);
        let _ = fs::remove_file(PathBuf::from(sidecar));
    }
}

fn read_entry(
    connection: &mut Connection,
    endpoint: &str,
) -> Result<Option<HttpCacheEntry>, ApiError> {
    let endpoint = normalize_endpoint(endpoint)?;
    let row = connection
        .query_row(
            "SELECT final_url, content_type, etag, last_modified, body, body_sha256,
                    fetched_at_ms, expires_at_ms, materialized
             FROM endpoint_cache WHERE endpoint = ?1",
            [&endpoint],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Vec<u8>>(4)?,
                    row.get::<_, Vec<u8>>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, bool>(8)?,
                ))
            },
        )
        .optional()?;
    let Some((
        final_url,
        content_type,
        etag,
        last_modified,
        body,
        expected_hash,
        fetched_at_ms,
        expires_at_ms,
        materialized,
    )) = row
    else {
        return Ok(None);
    };

    let invalid = validate_optional_header(content_type.as_deref(), MAX_CONTENT_TYPE_BYTES)
        .is_err()
        || validate_optional_header(etag.as_deref(), MAX_VALIDATOR_BYTES).is_err()
        || validate_optional_header(last_modified.as_deref(), MAX_VALIDATOR_BYTES).is_err()
        || normalize_feed_url(&final_url).is_err()
        || body.is_empty()
        || body.len() > MAX_RESPONSE_BYTES
        || Sha256::digest(&body).as_slice() != expected_hash;
    if invalid {
        connection.execute(
            "DELETE FROM endpoint_cache WHERE endpoint = ?1",
            [&endpoint],
        )?;
        return Ok(None);
    }
    connection.execute(
        "UPDATE endpoint_cache SET last_accessed_ms = ?1 WHERE endpoint = ?2",
        params![unix_time_ms(), endpoint],
    )?;
    Ok(Some(HttpCacheEntry {
        endpoint,
        final_url,
        content_type,
        etag,
        last_modified,
        body,
        fetched_at_ms,
        expires_at_ms,
        materialized,
    }))
}

fn write_entry(connection: &mut Connection, entry: HttpCacheEntry) -> Result<(), ApiError> {
    let entry = validate_entry(entry)?;
    let checksum = Sha256::digest(&entry.body);
    let transaction = connection.transaction()?;
    transaction.execute(
        "INSERT INTO endpoint_cache (
           endpoint, final_url, content_type, etag, last_modified, body, body_sha256,
           fetched_at_ms, expires_at_ms, materialized, last_accessed_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?8)
         ON CONFLICT(endpoint) DO UPDATE SET
           final_url = excluded.final_url,
           content_type = excluded.content_type,
           etag = excluded.etag,
           last_modified = excluded.last_modified,
           body = excluded.body,
           body_sha256 = excluded.body_sha256,
           fetched_at_ms = excluded.fetched_at_ms,
           expires_at_ms = excluded.expires_at_ms,
           materialized = excluded.materialized,
           last_accessed_ms = excluded.last_accessed_ms",
        params![
            entry.endpoint,
            entry.final_url,
            entry.content_type,
            entry.etag,
            entry.last_modified,
            entry.body,
            checksum.as_slice(),
            entry.fetched_at_ms,
            entry.expires_at_ms,
            entry.materialized,
        ],
    )?;
    transaction.execute(
        "DELETE FROM endpoint_cache WHERE endpoint IN (
           SELECT endpoint FROM endpoint_cache
           ORDER BY last_accessed_ms DESC, endpoint DESC LIMIT -1 OFFSET ?1
         )",
        [MAX_CACHE_ENTRIES],
    )?;
    transaction.commit()?;
    Ok(())
}

fn mark_materialized(connection: &Connection, endpoint: &str) -> Result<(), ApiError> {
    let endpoint = normalize_endpoint(endpoint)?;
    connection.execute(
        "UPDATE endpoint_cache SET materialized = 1, last_accessed_ms = ?1 WHERE endpoint = ?2",
        params![unix_time_ms(), endpoint],
    )?;
    Ok(())
}

fn touch_not_modified(
    connection: &Connection,
    endpoint: &str,
    fetched_at_ms: i64,
    expires_at_ms: i64,
) -> Result<Option<CacheValidators>, ApiError> {
    let endpoint = normalize_endpoint(endpoint)?;
    if expires_at_ms < fetched_at_ms {
        return Err(ApiError::invalid("Expiration du cache HTTP invalide."));
    }
    let validators = connection
        .query_row(
            "SELECT etag, last_modified, materialized FROM endpoint_cache WHERE endpoint = ?1",
            [&endpoint],
            |row| {
                Ok(CacheValidators {
                    etag: row.get(0)?,
                    last_modified: row.get(1)?,
                    materialized: row.get(2)?,
                })
            },
        )
        .optional()?;
    if validators.is_some() {
        connection.execute(
            "UPDATE endpoint_cache SET fetched_at_ms = ?1, expires_at_ms = ?2,
             last_accessed_ms = ?1 WHERE endpoint = ?3",
            params![fetched_at_ms, expires_at_ms, endpoint],
        )?;
    }
    Ok(validators)
}

fn remove_entry(connection: &Connection, endpoint: &str) -> Result<(), ApiError> {
    let endpoint = normalize_endpoint(endpoint)?;
    connection.execute(
        "DELETE FROM endpoint_cache WHERE endpoint = ?1",
        [&endpoint],
    )?;
    Ok(())
}

fn validate_entry(mut entry: HttpCacheEntry) -> Result<HttpCacheEntry, ApiError> {
    entry.endpoint = normalize_endpoint(&entry.endpoint)?;
    entry.final_url = normalize_endpoint(&entry.final_url)?;
    validate_optional_header(entry.content_type.as_deref(), MAX_CONTENT_TYPE_BYTES)?;
    validate_optional_header(entry.etag.as_deref(), MAX_VALIDATOR_BYTES)?;
    validate_optional_header(entry.last_modified.as_deref(), MAX_VALIDATOR_BYTES)?;
    if entry.body.is_empty() || entry.body.len() > MAX_RESPONSE_BYTES {
        return Err(ApiError::invalid("Réponse HTTP hors budget."));
    }
    if entry.expires_at_ms < entry.fetched_at_ms {
        return Err(ApiError::invalid("Expiration du cache HTTP invalide."));
    }
    Ok(entry)
}

fn normalize_endpoint(value: &str) -> Result<String, ApiError> {
    if value.len() > MAX_HTTP_URL_LENGTH {
        return Err(ApiError::invalid("URL de cache HTTP invalide."));
    }
    normalize_feed_url(value).map(|url| url.to_string())
}

fn validate_optional_header(value: Option<&str>, limit: usize) -> Result<(), ApiError> {
    if value.is_some_and(|value| {
        value.is_empty()
            || value.len() > limit
            || value
                .bytes()
                .any(|byte| byte.is_ascii_control() && byte != b'\t')
    }) {
        return Err(ApiError::invalid("Métadonnée HTTP invalide."));
    }
    Ok(())
}

fn unix_time_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
        })
}

#[cfg(test)]
mod tests {
    use super::{HttpCacheActor, HttpCacheEntry};
    use rusqlite::Connection;
    use std::{fs, path::PathBuf};
    use uuid::Uuid;

    fn cache_path() -> PathBuf {
        std::env::temp_dir().join(format!("vibedeck-http-cache-{}.sqlite3", Uuid::new_v4()))
    }

    fn entry() -> HttpCacheEntry {
        HttpCacheEntry {
            endpoint: "https://news.example/feed.xml".to_owned(),
            final_url: "https://news.example/feed.xml".to_owned(),
            content_type: Some("application/rss+xml".to_owned()),
            etag: Some("\"revision-1\"".to_owned()),
            last_modified: Some("Wed, 15 Jul 2026 08:00:00 GMT".to_owned()),
            body: b"<rss version='2.0'><channel/></rss>".to_vec(),
            fetched_at_ms: 1_000,
            expires_at_ms: 2_000,
            materialized: false,
        }
    }

    #[test]
    fn stores_validators_and_allows_zero_work_only_after_materialization() {
        tauri::async_runtime::block_on(async {
            let path = cache_path();
            let cache = HttpCacheActor::spawn(path.clone());
            cache.put(entry()).await.unwrap();
            assert_eq!(cache.get(entry().endpoint).await.unwrap().unwrap(), entry());

            let validators = cache
                .touch_not_modified("https://news.example/feed.xml".to_owned(), 3_000, 4_000)
                .await
                .unwrap()
                .unwrap();
            assert!(!validators.materialized);
            cache
                .mark_materialized("https://news.example/feed.xml".to_owned())
                .await
                .unwrap();
            let validators = cache
                .touch_not_modified("https://news.example/feed.xml".to_owned(), 5_000, 6_000)
                .await
                .unwrap()
                .unwrap();
            assert!(validators.materialized);
            cache.shutdown().await;
            super::remove_cache_files(&path);
        });
    }

    #[test]
    fn drops_a_tampered_entry_without_touching_other_state() {
        tauri::async_runtime::block_on(async {
            let path = cache_path();
            let cache = HttpCacheActor::spawn(path.clone());
            cache.put(entry()).await.unwrap();
            Connection::open(&path)
                .unwrap()
                .execute("UPDATE endpoint_cache SET body_sha256 = zeroblob(32)", [])
                .unwrap();
            assert!(cache
                .get("https://news.example/feed.xml".to_owned())
                .await
                .unwrap()
                .is_none());
            cache.shutdown().await;
            super::remove_cache_files(&path);
        });
    }

    #[test]
    fn rebuilds_a_corrupt_disposable_database() {
        tauri::async_runtime::block_on(async {
            let path = cache_path();
            fs::write(&path, b"not a sqlite database").unwrap();
            let cache = HttpCacheActor::spawn(path.clone());
            cache.put(entry()).await.unwrap();
            assert!(cache.get(entry().endpoint).await.unwrap().is_some());
            cache.shutdown().await;
            super::remove_cache_files(&path);
        });
    }

    #[test]
    fn never_rebuilds_or_deletes_a_foreign_sqlite_database() {
        tauri::async_runtime::block_on(async {
            let path = cache_path();
            let foreign = Connection::open(&path).unwrap();
            foreign
                .execute_batch(
                    "CREATE TABLE precious_configuration(value TEXT NOT NULL);
                     INSERT INTO precious_configuration VALUES ('keep-me');
                     PRAGMA user_version = 7;",
                )
                .unwrap();
            drop(foreign);

            let cache = HttpCacheActor::spawn(path.clone());
            assert!(cache.put(entry()).await.is_err());
            cache.shutdown().await;
            let value: String = Connection::open(&path)
                .unwrap()
                .query_row("SELECT value FROM precious_configuration", [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(value, "keep-me");
            super::remove_cache_files(&path);
        });
    }
}
