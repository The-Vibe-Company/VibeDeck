use crate::{
    database::DatabaseActor,
    error::ApiError,
    http_cache::{HttpCacheActor, HttpCacheEntry},
    model::MutationResult,
    network::{FeedRefreshOutcome, FeedTransport, FeedValidators, ParsedFeed},
    scheduler::{
        spawn_scheduler_with_publisher, MutationPublisher, RefreshJob, SchedulerClock,
        SchedulerHandle, SystemSchedulerClock,
    },
};
use chrono::{SecondsFormat, Utc};
use futures_util::future::BoxFuture;
use std::{sync::Arc, time::Duration};
use tauri::async_runtime::JoinHandle;
use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const ACTIVE_REFRESH_WORKERS: usize = 6;
const MAX_REFRESH_ERROR_BYTES: usize = 512;
const FINALIZATION_RETRY_BASE_DELAY_MS: u64 = 100;
const FINALIZATION_RETRY_MAX_DELAY_MS: u64 = 5_000;
const CANCELLED_REFRESH_MESSAGE: &str = "Actualisation interrompue.";

type PublishCallback = Arc<dyn Fn(MutationResult) + Send + Sync>;

trait RefreshTransport: Send + Sync + 'static {
    fn refresh(
        &self,
        url: String,
        validators: FeedValidators,
        cancellation: CancellationToken,
    ) -> BoxFuture<'static, Result<FeedRefreshOutcome, ApiError>>;

    fn parse_cached(
        &self,
        body: Vec<u8>,
        final_url: String,
        cancellation: CancellationToken,
    ) -> BoxFuture<'static, Result<ParsedFeed, ApiError>>;
}

impl RefreshTransport for FeedTransport {
    fn refresh(
        &self,
        url: String,
        validators: FeedValidators,
        cancellation: CancellationToken,
    ) -> BoxFuture<'static, Result<FeedRefreshOutcome, ApiError>> {
        let transport = self.clone();
        Box::pin(
            async move { FeedTransport::refresh(&transport, &url, validators, cancellation).await },
        )
    }

    fn parse_cached(
        &self,
        body: Vec<u8>,
        final_url: String,
        cancellation: CancellationToken,
    ) -> BoxFuture<'static, Result<ParsedFeed, ApiError>> {
        let transport = self.clone();
        Box::pin(async move {
            FeedTransport::parse_cached(&transport, body, &final_url, cancellation).await
        })
    }
}

/// Owns the event-driven source scheduler and exactly six refresh consumers.
/// The explicit async shutdown drains every queued job whose `Refreshing`
/// transition was committed. If SQLite stays unavailable, cancellation bounds
/// shutdown and `open_database` recovers that persisted state on next launch.
#[must_use = "call shutdown().await before releasing the native runtime"]
pub(crate) struct RefreshWorkerHandle {
    scheduler: Option<SchedulerHandle>,
    cancellation: CancellationToken,
    workers: Vec<JoinHandle<()>>,
    jobs: Arc<Mutex<mpsc::Receiver<RefreshJob>>>,
    publisher: MutationPublisher,
    clock: Arc<dyn SchedulerClock>,
}

impl RefreshWorkerHandle {
    pub(crate) fn notify_schedule_changed(&self) {
        if let Some(scheduler) = &self.scheduler {
            scheduler.notify_schedule_changed();
        }
    }

    pub(crate) async fn shutdown(mut self) {
        // Stop the producer before cancelling consumers, otherwise a newly
        // committed `Refreshing` job could appear after the final drain.
        if let Some(scheduler) = self.scheduler.take() {
            scheduler.shutdown().await;
        }

        self.cancellation.cancel();
        for worker in std::mem::take(&mut self.workers) {
            let _ = worker.await;
        }

        let queued_jobs = {
            let mut jobs = self.jobs.lock().await;
            let mut queued_jobs = Vec::new();
            while let Ok(job) = jobs.try_recv() {
                queued_jobs.push(job);
            }
            queued_jobs
        };
        let failed_at_ms = self.clock.now_ms();
        for job in queued_jobs {
            finish_failure(
                job,
                &self.publisher,
                failed_at_ms,
                CANCELLED_REFRESH_MESSAGE,
                &self.cancellation,
            )
            .await;
        }
    }
}

impl Drop for RefreshWorkerHandle {
    fn drop(&mut self) {
        // Process teardown cannot await SQLite. Normal application shutdown
        // must call `shutdown`; cancellation still prevents detached network
        // work from continuing if a caller violates that contract.
        self.cancellation.cancel();
    }
}

pub(crate) fn spawn_refresh_worker(
    database: DatabaseActor,
    transport: FeedTransport,
    cache: HttpCacheActor,
    session_id: Uuid,
    publish: PublishCallback,
    transition_order: Arc<Mutex<()>>,
) -> RefreshWorkerHandle {
    spawn_refresh_worker_with_clock_and_transport(
        database,
        Arc::new(transport),
        cache,
        session_id,
        publish,
        Arc::new(SystemSchedulerClock),
        transition_order,
    )
}

fn spawn_refresh_worker_with_clock_and_transport(
    database: DatabaseActor,
    transport: Arc<dyn RefreshTransport>,
    cache: HttpCacheActor,
    session_id: Uuid,
    publish: PublishCallback,
    clock: Arc<dyn SchedulerClock>,
    transition_order: Arc<Mutex<()>>,
) -> RefreshWorkerHandle {
    let publisher = MutationPublisher::with_gate(publish, transition_order);
    let (scheduler, jobs) =
        spawn_scheduler_with_publisher(database, session_id, Arc::clone(&clock), publisher.clone());
    let jobs = Arc::new(Mutex::new(jobs));
    let cancellation = CancellationToken::new();
    let mut workers = Vec::with_capacity(ACTIVE_REFRESH_WORKERS);
    for _ in 0..ACTIVE_REFRESH_WORKERS {
        workers.push(tauri::async_runtime::spawn(run_refresh_consumer(
            Arc::clone(&jobs),
            Arc::clone(&transport),
            cache.clone(),
            publisher.clone(),
            Arc::clone(&clock),
            cancellation.clone(),
        )));
    }

    RefreshWorkerHandle {
        scheduler: Some(scheduler),
        cancellation,
        workers,
        jobs,
        publisher,
        clock,
    }
}

async fn run_refresh_consumer(
    jobs: Arc<Mutex<mpsc::Receiver<RefreshJob>>>,
    transport: Arc<dyn RefreshTransport>,
    cache: HttpCacheActor,
    publisher: MutationPublisher,
    clock: Arc<dyn SchedulerClock>,
    cancellation: CancellationToken,
) {
    loop {
        let next_job = cancellation
            .run_until_cancelled(async {
                let mut jobs = jobs.lock().await;
                jobs.recv().await
            })
            .await;
        let Some(Some(job)) = next_job else {
            return;
        };
        refresh_one(
            job,
            transport.as_ref(),
            &cache,
            &publisher,
            clock.as_ref(),
            &cancellation,
        )
        .await;
        if cancellation.is_cancelled() {
            return;
        }
    }
}

async fn refresh_one(
    job: RefreshJob,
    transport: &dyn RefreshTransport,
    cache: &HttpCacheActor,
    publisher: &MutationPublisher,
    clock: &dyn SchedulerClock,
    cancellation: &CancellationToken,
) {
    let endpoint = job.source().feed_url.clone();
    let refresh_interval_seconds = job.source().refresh_interval_seconds;
    // Cache failure never makes the disposable database authoritative. A
    // modified response can still repair it; a 304 without a body cannot.
    let cached = cache.get(endpoint.clone()).await.ok().flatten();
    let validators = cached
        .as_ref()
        .map(|entry| FeedValidators {
            etag: entry.etag.clone(),
            last_modified: entry.last_modified.clone(),
        })
        .unwrap_or_default();

    let outcome = transport
        .refresh(endpoint.clone(), validators, cancellation.clone())
        .await;
    if cancellation.is_cancelled() {
        finish_failure(
            job,
            publisher,
            clock.now_ms(),
            CANCELLED_REFRESH_MESSAGE,
            cancellation,
        )
        .await;
        return;
    }

    match outcome {
        Err(error) => {
            finish_failure(
                job,
                publisher,
                clock.now_ms(),
                &bounded_error(&error),
                cancellation,
            )
            .await;
        }
        Ok(FeedRefreshOutcome::NotModified { .. }) => {
            refresh_not_modified(
                job,
                cached,
                endpoint,
                refresh_interval_seconds,
                transport,
                cache,
                publisher,
                clock,
                cancellation,
            )
            .await;
        }
        Ok(FeedRefreshOutcome::Modified {
            final_url,
            content_type,
            validators,
            body,
            parsed,
        }) => {
            refresh_modified(
                job,
                endpoint,
                refresh_interval_seconds,
                final_url,
                content_type,
                validators,
                body,
                parsed,
                cache,
                publisher,
                clock,
                cancellation,
            )
            .await;
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn refresh_not_modified(
    job: RefreshJob,
    cached: Option<HttpCacheEntry>,
    endpoint: String,
    refresh_interval_seconds: u32,
    transport: &dyn RefreshTransport,
    cache: &HttpCacheActor,
    publisher: &MutationPublisher,
    clock: &dyn SchedulerClock,
    cancellation: &CancellationToken,
) {
    let Some(cached) = cached else {
        finish_failure(
            job,
            publisher,
            clock.now_ms(),
            "La source a répondu sans contenu exploitable.",
            cancellation,
        )
        .await;
        return;
    };
    let refreshed_at_ms = clock.now_ms();
    let expires_at_ms = expires_at_ms(refreshed_at_ms, refresh_interval_seconds);
    // This is a derived freshness hint only. Failure must not downgrade a
    // valid authoritative materialization or erase the stale body.
    let _ = cache
        .touch_not_modified(endpoint.clone(), refreshed_at_ms, expires_at_ms)
        .await;

    if cached.materialized {
        if cancellation.is_cancelled() {
            finish_failure(
                job,
                publisher,
                clock.now_ms(),
                CANCELLED_REFRESH_MESSAGE,
                cancellation,
            )
            .await;
        } else {
            finish_success(job, publisher, refreshed_at_ms, cancellation).await;
        }
        return;
    }

    let parsed = transport
        .parse_cached(cached.body, cached.final_url, cancellation.clone())
        .await;
    if cancellation.is_cancelled() {
        finish_failure(
            job,
            publisher,
            clock.now_ms(),
            CANCELLED_REFRESH_MESSAGE,
            cancellation,
        )
        .await;
        return;
    }
    let parsed = match parsed {
        Ok(parsed) => parsed,
        Err(error) => {
            finish_failure(
                job,
                publisher,
                clock.now_ms(),
                &bounded_error(&error),
                cancellation,
            )
            .await;
            return;
        }
    };

    // `commit_ingestion` marks the exact cache entry only after SQLite's
    // authoritative transaction and patch publication complete.
    let _ = commit_ingestion(
        job,
        publisher,
        cache,
        endpoint,
        parsed,
        true,
        clock,
        cancellation,
    )
    .await;
}

#[allow(clippy::too_many_arguments)]
async fn refresh_modified(
    job: RefreshJob,
    endpoint: String,
    refresh_interval_seconds: u32,
    final_url: String,
    content_type: Option<String>,
    validators: FeedValidators,
    body: Vec<u8>,
    parsed: ParsedFeed,
    cache: &HttpCacheActor,
    publisher: &MutationPublisher,
    clock: &dyn SchedulerClock,
    cancellation: &CancellationToken,
) {
    let fetched_at_ms = clock.now_ms();
    let entry = HttpCacheEntry {
        endpoint: endpoint.clone(),
        final_url,
        content_type,
        etag: validators.etag,
        last_modified: validators.last_modified,
        body,
        fetched_at_ms,
        expires_at_ms: expires_at_ms(fetched_at_ms, refresh_interval_seconds),
        materialized: false,
    };
    // Cache storage is deliberately disposable. A valid parsed response must
    // still commit when this actor is busy, corrupt, or unavailable.
    let cache_entry_persisted = cache.put(entry).await.is_ok();
    if cancellation.is_cancelled() {
        finish_failure(
            job,
            publisher,
            clock.now_ms(),
            CANCELLED_REFRESH_MESSAGE,
            cancellation,
        )
        .await;
        return;
    }
    let _ = commit_ingestion(
        job,
        publisher,
        cache,
        endpoint,
        parsed,
        cache_entry_persisted,
        clock,
        cancellation,
    )
    .await;
}

#[allow(clippy::too_many_arguments)]
async fn commit_ingestion(
    job: RefreshJob,
    publisher: &MutationPublisher,
    cache: &HttpCacheActor,
    endpoint: String,
    parsed: ParsedFeed,
    mark_cache_materialized: bool,
    clock: &dyn SchedulerClock,
    cancellation: &CancellationToken,
) -> bool {
    let observed_at = timestamp(clock.now_ms());
    match publisher
        .transition(job.ingest(Uuid::new_v4(), observed_at, parsed))
        .await
    {
        Ok(_) => {
            // A failure here deliberately leaves the entry non-materialized.
            // The next 304 will parse and ingest it again idempotently.
            if mark_cache_materialized {
                let _ = cache.mark_materialized(endpoint).await;
            }
            true
        }
        Err(error) => {
            finish_failure(
                job,
                publisher,
                clock.now_ms(),
                &bounded_error(&error),
                cancellation,
            )
            .await;
            false
        }
    }
}

async fn finish_failure(
    job: RefreshJob,
    publisher: &MutationPublisher,
    failed_at_ms: i64,
    message: &str,
    cancellation: &CancellationToken,
) {
    finish_refresh(
        job,
        publisher,
        FinalRefreshState::Failure {
            failed_at_ms,
            message: bounded_message(message),
        },
        cancellation,
    )
    .await;
}

async fn finish_success(
    job: RefreshJob,
    publisher: &MutationPublisher,
    completed_at_ms: i64,
    cancellation: &CancellationToken,
) {
    finish_refresh(
        job,
        publisher,
        FinalRefreshState::Success { completed_at_ms },
        cancellation,
    )
    .await;
}

enum FinalRefreshState {
    Success { completed_at_ms: i64 },
    Failure { failed_at_ms: i64, message: String },
}

async fn finish_refresh(
    job: RefreshJob,
    publisher: &MutationPublisher,
    final_state: FinalRefreshState,
    cancellation: &CancellationToken,
) {
    // Keep one idempotency key for every attempt. If an actor response is lost
    // after SQLite commits, the operations table makes the retry a no-op rather
    // than applying the terminal transition twice. Retry while the runtime is
    // alive; shutdown cancellation deliberately hands an unresolved write to
    // the startup recovery that resets persisted `refreshing` rows to `idle`.
    let operation_id = Uuid::new_v4();
    let mut consecutive_failures = 0_u32;
    loop {
        let result = match &final_state {
            FinalRefreshState::Success { completed_at_ms } => {
                publisher
                    .transition(job.succeed(operation_id, *completed_at_ms))
                    .await
            }
            FinalRefreshState::Failure {
                failed_at_ms,
                message,
            } => {
                publisher
                    .transition(job.fail(operation_id, *failed_at_ms, message.clone()))
                    .await
            }
        };
        if result.is_ok() {
            return;
        }
        if cancellation.is_cancelled() {
            return;
        }

        let delay_ms = finalization_retry_delay_ms(consecutive_failures);
        consecutive_failures = consecutive_failures.saturating_add(1);
        if cancellation
            .run_until_cancelled(tokio::time::sleep(Duration::from_millis(delay_ms)))
            .await
            .is_none()
        {
            return;
        }
    }
}

fn finalization_retry_delay_ms(consecutive_failures: u32) -> u64 {
    FINALIZATION_RETRY_BASE_DELAY_MS
        .saturating_mul(1_u64 << consecutive_failures.min(6))
        .min(FINALIZATION_RETRY_MAX_DELAY_MS)
}

fn expires_at_ms(fetched_at_ms: i64, refresh_interval_seconds: u32) -> i64 {
    fetched_at_ms.saturating_add(i64::from(refresh_interval_seconds).saturating_mul(1_000))
}

fn timestamp(at_ms: i64) -> String {
    chrono::DateTime::<Utc>::from_timestamp_millis(at_ms)
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn bounded_error(error: &ApiError) -> String {
    bounded_message(&error.message)
}

fn bounded_message(message: &str) -> String {
    let message = message.trim();
    let message = if message.is_empty() {
        "L'actualisation de la source a échoué."
    } else {
        message
    };
    if message.len() <= MAX_REFRESH_ERROR_BYTES {
        return message.to_owned();
    }
    let mut boundary = MAX_REFRESH_ERROR_BYTES;
    while !message.is_char_boundary(boundary) {
        boundary -= 1;
    }
    message[..boundary].to_owned()
}

#[cfg(test)]
mod tests {
    use super::{
        spawn_refresh_worker_with_clock_and_transport, FeedRefreshOutcome, FeedValidators,
        RefreshTransport,
    };
    use crate::{
        database::{DatabaseActor, IngestFeedRequest},
        error::ApiError,
        http_cache::{HttpCacheActor, HttpCacheEntry},
        model::{
            ConnectorKind, CreatePanelInput, GenericSourceInput, MutateRequest, MutationCommand,
            MutationResult, SourceStatus, StateChange,
        },
        network::{ParsedFeed, ParsedFeedItem},
        scheduler::SchedulerClock,
    };
    use futures_util::future::BoxFuture;
    use std::{
        collections::VecDeque,
        future::Future,
        path::{Path, PathBuf},
        pin::Pin,
        sync::{
            atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering},
            Arc, Mutex as StdMutex,
        },
        time::Duration,
    };
    use tokio::sync::{Mutex, Notify};
    use tokio_util::sync::CancellationToken;
    use uuid::Uuid;

    #[derive(Clone)]
    struct ManualClock {
        now_ms: Arc<AtomicI64>,
        changed: Arc<Notify>,
    }

    impl ManualClock {
        fn new(now_ms: i64) -> Self {
            Self {
                now_ms: Arc::new(AtomicI64::new(now_ms)),
                changed: Arc::new(Notify::new()),
            }
        }
    }

    impl SchedulerClock for ManualClock {
        fn now_ms(&self) -> i64 {
            self.now_ms.load(Ordering::SeqCst)
        }

        fn sleep_until(
            &self,
            deadline_ms: i64,
        ) -> Pin<Box<dyn Future<Output = ()> + Send + 'static>> {
            let now_ms = Arc::clone(&self.now_ms);
            let changed = Arc::clone(&self.changed);
            Box::pin(async move {
                loop {
                    let notified = changed.notified();
                    if now_ms.load(Ordering::SeqCst) >= deadline_ms {
                        return;
                    }
                    notified.await;
                }
            })
        }
    }

    #[derive(Clone)]
    struct FakeTransport {
        outcomes: Arc<StdMutex<VecDeque<Result<FeedRefreshOutcome, ApiError>>>>,
        cached_parse: Arc<StdMutex<Result<ParsedFeed, ApiError>>>,
        refresh_calls: Arc<AtomicUsize>,
        parse_calls: Arc<AtomicUsize>,
    }

    impl FakeTransport {
        fn new(
            outcome: Result<FeedRefreshOutcome, ApiError>,
            cached_parse: Result<ParsedFeed, ApiError>,
        ) -> Self {
            Self {
                outcomes: Arc::new(StdMutex::new(VecDeque::from([outcome]))),
                cached_parse: Arc::new(StdMutex::new(cached_parse)),
                refresh_calls: Arc::new(AtomicUsize::new(0)),
                parse_calls: Arc::new(AtomicUsize::new(0)),
            }
        }
    }

    impl RefreshTransport for FakeTransport {
        fn refresh(
            &self,
            _url: String,
            _validators: FeedValidators,
            _cancellation: CancellationToken,
        ) -> BoxFuture<'static, Result<FeedRefreshOutcome, ApiError>> {
            self.refresh_calls.fetch_add(1, Ordering::SeqCst);
            let outcome = self
                .outcomes
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Err(ApiError::internal("Réponse de test manquante.")));
            Box::pin(async move { outcome })
        }

        fn parse_cached(
            &self,
            _body: Vec<u8>,
            _final_url: String,
            _cancellation: CancellationToken,
        ) -> BoxFuture<'static, Result<ParsedFeed, ApiError>> {
            self.parse_calls.fetch_add(1, Ordering::SeqCst);
            let result = self.cached_parse.lock().unwrap().clone();
            Box::pin(async move { result })
        }
    }

    #[derive(Clone)]
    struct BlockingTransport {
        started: Arc<AtomicBool>,
        changed: Arc<Notify>,
    }

    impl BlockingTransport {
        fn new() -> Self {
            Self {
                started: Arc::new(AtomicBool::new(false)),
                changed: Arc::new(Notify::new()),
            }
        }

        async fn wait_until_started(&self) {
            tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    let notified = self.changed.notified();
                    if self.started.load(Ordering::SeqCst) {
                        return;
                    }
                    notified.await;
                }
            })
            .await
            .expect("the blocking refresh should start");
        }
    }

    impl RefreshTransport for BlockingTransport {
        fn refresh(
            &self,
            _url: String,
            _validators: FeedValidators,
            cancellation: CancellationToken,
        ) -> BoxFuture<'static, Result<FeedRefreshOutcome, ApiError>> {
            self.started.store(true, Ordering::SeqCst);
            self.changed.notify_waiters();
            Box::pin(async move {
                cancellation.cancelled().await;
                Err(ApiError::cancelled())
            })
        }

        fn parse_cached(
            &self,
            _body: Vec<u8>,
            _final_url: String,
            _cancellation: CancellationToken,
        ) -> BoxFuture<'static, Result<ParsedFeed, ApiError>> {
            Box::pin(async { Err(ApiError::internal("Parse inattendu.")) })
        }
    }

    #[derive(Clone)]
    struct GatedFailingTransport {
        started: Arc<AtomicBool>,
        released: Arc<AtomicBool>,
        changed: Arc<Notify>,
    }

    impl GatedFailingTransport {
        fn new() -> Self {
            Self {
                started: Arc::new(AtomicBool::new(false)),
                released: Arc::new(AtomicBool::new(false)),
                changed: Arc::new(Notify::new()),
            }
        }

        async fn wait_until_started(&self) {
            tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    let notified = self.changed.notified();
                    if self.started.load(Ordering::SeqCst) {
                        return;
                    }
                    notified.await;
                }
            })
            .await
            .expect("the gated refresh should start");
        }

        fn release(&self) {
            self.released.store(true, Ordering::SeqCst);
            self.changed.notify_waiters();
        }
    }

    impl RefreshTransport for GatedFailingTransport {
        fn refresh(
            &self,
            _url: String,
            _validators: FeedValidators,
            _cancellation: CancellationToken,
        ) -> BoxFuture<'static, Result<FeedRefreshOutcome, ApiError>> {
            self.started.store(true, Ordering::SeqCst);
            self.changed.notify_waiters();
            let released = Arc::clone(&self.released);
            let changed = Arc::clone(&self.changed);
            Box::pin(async move {
                loop {
                    let notified = changed.notified();
                    if released.load(Ordering::SeqCst) {
                        return Err(ApiError::network("Réseau indisponible."));
                    }
                    notified.await;
                }
            })
        }

        fn parse_cached(
            &self,
            _body: Vec<u8>,
            _final_url: String,
            _cancellation: CancellationToken,
        ) -> BoxFuture<'static, Result<ParsedFeed, ApiError>> {
            Box::pin(async { Err(ApiError::internal("Parse inattendu.")) })
        }
    }

    struct Fixture {
        database_path: PathBuf,
        cache_path: PathBuf,
        database: DatabaseActor,
        cache: HttpCacheActor,
        session_id: Uuid,
        panel_id: Uuid,
        source_id: Uuid,
        endpoint: String,
    }

    fn fixture_path(label: &str, extension: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "vibedeck-refresh-{label}-{}{extension}",
            Uuid::new_v4()
        ))
    }

    fn remove_sqlite(path: &Path) {
        let _ = std::fs::remove_file(path);
        for suffix in ["-wal", "-shm"] {
            let mut sidecar = path.as_os_str().to_owned();
            sidecar.push(suffix);
            let _ = std::fs::remove_file(PathBuf::from(sidecar));
        }
    }

    fn panel_id_from(result: &MutationResult) -> Uuid {
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

    fn source_id_from(result: &MutationResult) -> Uuid {
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

    async fn fixture(label: &str) -> Fixture {
        let database_path = fixture_path(label, ".sqlite3");
        let cache_path = fixture_path(label, "-cache.sqlite3");
        let database = DatabaseActor::spawn(database_path.clone());
        let cache = HttpCacheActor::spawn(cache_path.clone());
        let session_id = Uuid::new_v4();
        let panel = database
            .mutate(
                session_id,
                MutateRequest {
                    operation_id: Uuid::new_v4(),
                    expected_revision: 0,
                    command: MutationCommand::CreatePanel {
                        input: CreatePanelInput::Feed {
                            name: "Fil de test".to_owned(),
                            default_refresh_interval_seconds: Some(60),
                        },
                        placement: None,
                    },
                },
            )
            .await
            .unwrap();
        let panel_id = panel_id_from(&panel);
        let endpoint = format!("https://{label}.example.test/feed.xml");
        let source = database
            .mutate(
                session_id,
                MutateRequest {
                    operation_id: Uuid::new_v4(),
                    expected_revision: 1,
                    command: MutationCommand::AddGenericSource {
                        panel_id,
                        source: GenericSourceInput {
                            name: "Source de test".to_owned(),
                            input_url: format!("https://{label}.example.test/"),
                            feed_url: endpoint.clone(),
                            connector_kind: ConnectorKind::Rss,
                            refresh_interval_seconds: 60,
                        },
                        position: None,
                    },
                },
            )
            .await
            .unwrap();
        let source_id = source_id_from(&source);
        Fixture {
            database_path,
            cache_path,
            database,
            cache,
            session_id,
            panel_id,
            source_id,
            endpoint,
        }
    }

    fn parsed_feed(title: &str) -> ParsedFeed {
        ParsedFeed {
            kind: ConnectorKind::Rss,
            title: Some("Flux de test".to_owned()),
            items: vec![ParsedFeedItem {
                canonical_url: "https://articles.example.test/unique".to_owned(),
                title: title.to_owned(),
                summary: Some("Résumé".to_owned()),
                image_url: None,
                published_at: Some("2026-07-15T08:00:00.000Z".to_owned()),
                updated_at: None,
            }],
        }
    }

    fn cache_entry(fixture: &Fixture, body: &[u8], materialized: bool) -> HttpCacheEntry {
        HttpCacheEntry {
            endpoint: fixture.endpoint.clone(),
            final_url: fixture.endpoint.clone(),
            content_type: Some("application/rss+xml".to_owned()),
            etag: Some("\"fixture-v1\"".to_owned()),
            last_modified: None,
            body: body.to_vec(),
            fetched_at_ms: 1_700_000_000_000,
            expires_at_ms: 1_700_000_060_000,
            materialized,
        }
    }

    fn published_status(result: &MutationResult) -> Option<SourceStatus> {
        result
            .patch
            .as_ref()?
            .changes
            .iter()
            .find_map(|change| match change {
                StateChange::SourceUpsert { source } => Some(source.status),
                _ => None,
            })
    }

    async fn wait_for_publications(
        published: &Arc<StdMutex<Vec<MutationResult>>>,
        changed: &Arc<Notify>,
        count: usize,
    ) {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let notified = changed.notified();
                if published.lock().unwrap().len() >= count {
                    return;
                }
                notified.await;
            }
        })
        .await
        .expect("refresh publications should arrive");
    }

    async fn seed_authoritative_item(fixture: &Fixture, title: &str) {
        fixture
            .database
            .ingest_feed(
                fixture.session_id,
                IngestFeedRequest {
                    operation_id: Uuid::new_v4(),
                    source_id: fixture.source_id,
                    observed_at: "2026-07-15T10:00:00.000Z".to_owned(),
                    feed: parsed_feed(title),
                },
            )
            .await
            .unwrap();
    }

    async fn run_worker(
        fixture: &Fixture,
        transport: Arc<FakeTransport>,
    ) -> (
        super::RefreshWorkerHandle,
        Arc<StdMutex<Vec<MutationResult>>>,
        Arc<Notify>,
    ) {
        let due_at_ms = fixture.database.next_due_at_ms().await.unwrap().unwrap();
        let clock = Arc::new(ManualClock::new(due_at_ms));
        let published = Arc::new(StdMutex::new(Vec::new()));
        let changed = Arc::new(Notify::new());
        let published_for_callback = Arc::clone(&published);
        let changed_for_callback = Arc::clone(&changed);
        let publish = Arc::new(move |result| {
            published_for_callback.lock().unwrap().push(result);
            changed_for_callback.notify_waiters();
        });
        let handle = spawn_refresh_worker_with_clock_and_transport(
            fixture.database.clone(),
            transport,
            fixture.cache.clone(),
            fixture.session_id,
            publish,
            clock,
            Arc::new(Mutex::new(())),
        );
        (handle, published, changed)
    }

    async fn run_worker_with_transport(
        fixture: &Fixture,
        transport: Arc<dyn RefreshTransport>,
    ) -> (
        super::RefreshWorkerHandle,
        Arc<StdMutex<Vec<MutationResult>>>,
        Arc<Notify>,
    ) {
        let due_at_ms = fixture.database.next_due_at_ms().await.unwrap().unwrap();
        let clock = Arc::new(ManualClock::new(due_at_ms));
        let published = Arc::new(StdMutex::new(Vec::new()));
        let changed = Arc::new(Notify::new());
        let published_for_callback = Arc::clone(&published);
        let changed_for_callback = Arc::clone(&changed);
        let publish = Arc::new(move |result| {
            published_for_callback.lock().unwrap().push(result);
            changed_for_callback.notify_waiters();
        });
        let handle = spawn_refresh_worker_with_clock_and_transport(
            fixture.database.clone(),
            transport,
            fixture.cache.clone(),
            fixture.session_id,
            publish,
            clock,
            Arc::new(Mutex::new(())),
        );
        (handle, published, changed)
    }

    async fn cleanup(fixture: Fixture) {
        fixture.cache.shutdown().await;
        fixture.database.shutdown().await;
        let database_path = fixture.database_path.clone();
        let cache_path = fixture.cache_path.clone();
        drop(fixture);
        remove_sqlite(&database_path);
        remove_sqlite(&cache_path);
    }

    #[test]
    fn materialized_304_skips_parse_and_upsert_then_publishes_success() {
        tauri::async_runtime::block_on(async {
            let fixture = fixture("304-materialized").await;
            seed_authoritative_item(&fixture, "Titre autoritatif").await;
            fixture
                .cache
                .put(cache_entry(&fixture, b"cached-feed", true))
                .await
                .unwrap();
            let transport = Arc::new(FakeTransport::new(
                Ok(FeedRefreshOutcome::NotModified {
                    final_url: fixture.endpoint.clone(),
                    validators: FeedValidators::default(),
                }),
                Ok(parsed_feed("Ne doit pas etre parse")),
            ));
            let (handle, published, changed) = run_worker(&fixture, Arc::clone(&transport)).await;
            wait_for_publications(&published, &changed, 2).await;
            handle.shutdown().await;

            assert_eq!(transport.refresh_calls.load(Ordering::SeqCst), 1);
            assert_eq!(transport.parse_calls.load(Ordering::SeqCst), 0);
            let bootstrap = fixture
                .database
                .bootstrap(fixture.session_id)
                .await
                .unwrap();
            let source = bootstrap
                .sources
                .iter()
                .find(|source| source.id == fixture.source_id)
                .unwrap();
            assert_eq!(source.item_count, 1);
            assert_eq!(source.status, SourceStatus::Healthy);
            let statuses = published
                .lock()
                .unwrap()
                .iter()
                .filter_map(published_status)
                .collect::<Vec<_>>();
            assert_eq!(
                statuses,
                vec![SourceStatus::Refreshing, SourceStatus::Healthy]
            );
            cleanup(fixture).await;
        });
    }

    #[test]
    fn non_materialized_304_parses_once_ingests_then_marks_cache() {
        tauri::async_runtime::block_on(async {
            let fixture = fixture("304-pending").await;
            fixture
                .cache
                .put(cache_entry(&fixture, b"pending-feed", false))
                .await
                .unwrap();
            let transport = Arc::new(FakeTransport::new(
                Ok(FeedRefreshOutcome::NotModified {
                    final_url: fixture.endpoint.clone(),
                    validators: FeedValidators::default(),
                }),
                Ok(parsed_feed("Matérialisé après reprise")),
            ));
            let (handle, published, changed) = run_worker(&fixture, Arc::clone(&transport)).await;
            wait_for_publications(&published, &changed, 2).await;
            handle.shutdown().await;

            assert_eq!(transport.parse_calls.load(Ordering::SeqCst), 1);
            let bootstrap = fixture
                .database
                .bootstrap(fixture.session_id)
                .await
                .unwrap();
            let source = bootstrap
                .sources
                .iter()
                .find(|source| source.id == fixture.source_id)
                .unwrap();
            assert_eq!(source.item_count, 1);
            assert_eq!(source.status, SourceStatus::Healthy);
            assert!(
                fixture
                    .cache
                    .get(fixture.endpoint.clone())
                    .await
                    .unwrap()
                    .unwrap()
                    .materialized
            );
            let statuses = published
                .lock()
                .unwrap()
                .iter()
                .filter_map(published_status)
                .collect::<Vec<_>>();
            assert_eq!(
                statuses,
                vec![SourceStatus::Refreshing, SourceStatus::Healthy]
            );
            cleanup(fixture).await;
        });
    }

    #[test]
    fn network_failure_preserves_authoritative_items_and_stale_cache() {
        tauri::async_runtime::block_on(async {
            let fixture = fixture("network-failure").await;
            seed_authoritative_item(&fixture, "À conserver").await;
            let stale_body = b"stale-but-usable";
            fixture
                .cache
                .put(cache_entry(&fixture, stale_body, true))
                .await
                .unwrap();
            let transport = Arc::new(FakeTransport::new(
                Err(ApiError::network("Réseau indisponible.")),
                Ok(parsed_feed("Ne doit pas etre parse")),
            ));
            let (handle, published, changed) = run_worker(&fixture, Arc::clone(&transport)).await;
            wait_for_publications(&published, &changed, 2).await;
            handle.shutdown().await;

            assert_eq!(transport.parse_calls.load(Ordering::SeqCst), 0);
            let bootstrap = fixture
                .database
                .bootstrap(fixture.session_id)
                .await
                .unwrap();
            let source = bootstrap
                .sources
                .iter()
                .find(|source| source.id == fixture.source_id)
                .unwrap();
            assert_eq!(source.item_count, 1);
            assert_eq!(source.status, SourceStatus::Error);
            assert_eq!(
                source.error_message.as_deref(),
                Some("Réseau indisponible.")
            );
            let page = fixture
                .database
                .feed_page(crate::model::FeedPageRequest {
                    panel_id: fixture.panel_id,
                    cursor: None,
                    limit: 10,
                })
                .await
                .unwrap();
            assert_eq!(page.items.len(), 1);
            assert_eq!(page.items[0].title, "À conserver");
            let cache = fixture
                .cache
                .get(fixture.endpoint.clone())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(cache.body, stale_body);
            assert!(cache.materialized);
            let statuses = published
                .lock()
                .unwrap()
                .iter()
                .filter_map(published_status)
                .collect::<Vec<_>>();
            assert_eq!(
                statuses,
                vec![SourceStatus::Refreshing, SourceStatus::Error]
            );
            cleanup(fixture).await;
        });
    }

    #[test]
    fn transient_finalization_write_failure_is_retried_without_losing_cache() {
        tauri::async_runtime::block_on(async {
            let fixture = fixture("finalization-retry").await;
            seed_authoritative_item(&fixture, "À conserver").await;
            let stale_body = b"stale-but-usable";
            fixture
                .cache
                .put(cache_entry(&fixture, stale_body, true))
                .await
                .unwrap();
            let transport = Arc::new(GatedFailingTransport::new());
            let (handle, published, changed) =
                run_worker_with_transport(&fixture, transport.clone()).await;

            // `started` proves the scheduler already committed and published
            // Refreshing. The injected failure can therefore only hit the
            // terminal SourceRefresh write performed after the network result.
            transport.wait_until_started().await;
            fixture.database.fail_next_source_refresh_write();
            transport.release();
            wait_for_publications(&published, &changed, 2).await;
            handle.shutdown().await;

            let bootstrap = fixture
                .database
                .bootstrap(fixture.session_id)
                .await
                .unwrap();
            let source = bootstrap
                .sources
                .iter()
                .find(|source| source.id == fixture.source_id)
                .unwrap();
            assert_eq!(source.status, SourceStatus::Error);
            assert_eq!(source.consecutive_failures, 1);
            assert_eq!(
                source.error_message.as_deref(),
                Some("Réseau indisponible.")
            );
            let cache = fixture
                .cache
                .get(fixture.endpoint.clone())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(cache.body, stale_body);
            assert!(cache.materialized);
            let statuses = published
                .lock()
                .unwrap()
                .iter()
                .filter_map(published_status)
                .collect::<Vec<_>>();
            assert_eq!(
                statuses,
                vec![SourceStatus::Refreshing, SourceStatus::Error]
            );
            cleanup(fixture).await;
        });
    }

    #[test]
    fn persistent_finalization_failure_does_not_block_shutdown_and_reopen_recovers() {
        tauri::async_runtime::block_on(async {
            let fixture = fixture("finalization-shutdown").await;
            let stale_body = b"stale-across-reopen";
            fixture
                .cache
                .put(cache_entry(&fixture, stale_body, true))
                .await
                .unwrap();
            let due_at_ms = fixture.database.next_due_at_ms().await.unwrap().unwrap();
            let transport = Arc::new(GatedFailingTransport::new());
            let (handle, published, _changed) =
                run_worker_with_transport(&fixture, transport.clone()).await;

            transport.wait_until_started().await;
            const INJECTED_FAILURES: usize = 100;
            fixture
                .database
                .fail_source_refresh_writes(INJECTED_FAILURES);
            transport.release();
            tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    if fixture.database.remaining_source_refresh_write_failures()
                        < INJECTED_FAILURES
                    {
                        return;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("the first terminal write should be attempted");

            tokio::time::timeout(Duration::from_secs(1), handle.shutdown())
                .await
                .expect("persistent finalization failure must not block shutdown");
            let interrupted = fixture
                .database
                .bootstrap(fixture.session_id)
                .await
                .unwrap();
            let interrupted_source = interrupted
                .sources
                .iter()
                .find(|source| source.id == fixture.source_id)
                .unwrap();
            assert_eq!(interrupted_source.status, SourceStatus::Refreshing);
            assert_eq!(interrupted_source.due_at_ms, due_at_ms);
            assert_eq!(
                published
                    .lock()
                    .unwrap()
                    .iter()
                    .filter_map(published_status)
                    .collect::<Vec<_>>(),
                vec![SourceStatus::Refreshing]
            );
            let cache = fixture
                .cache
                .get(fixture.endpoint.clone())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(cache.body, stale_body);
            assert!(cache.materialized);

            let database_path = fixture.database_path.clone();
            let cache_path = fixture.cache_path.clone();
            fixture.cache.shutdown().await;
            fixture.database.shutdown().await;
            drop(fixture);

            let reopened = DatabaseActor::spawn(database_path.clone());
            let reopened_session_id = Uuid::new_v4();
            let recovered = reopened.bootstrap(reopened_session_id).await.unwrap();
            let recovered_source = recovered
                .sources
                .iter()
                .find(|source| source.id == interrupted_source.id)
                .unwrap();
            assert_eq!(recovered_source.status, SourceStatus::Idle);
            assert_eq!(recovered_source.due_at_ms, due_at_ms);
            reopened.shutdown().await;
            drop(reopened);
            remove_sqlite(&database_path);
            remove_sqlite(&cache_path);
        });
    }

    #[test]
    fn unavailable_disposable_cache_does_not_block_a_valid_ingestion() {
        tauri::async_runtime::block_on(async {
            let fixture = fixture("cache-unavailable").await;
            fixture.cache.shutdown().await;
            let transport = Arc::new(FakeTransport::new(
                Ok(FeedRefreshOutcome::Modified {
                    final_url: fixture.endpoint.clone(),
                    content_type: Some("application/rss+xml".to_owned()),
                    validators: FeedValidators {
                        etag: Some("\"fresh\"".to_owned()),
                        last_modified: None,
                    },
                    body: b"fresh-feed".to_vec(),
                    parsed: parsed_feed("Flux sans cache"),
                }),
                Err(ApiError::internal("Parse inattendu.")),
            ));
            let (handle, published, changed) = run_worker(&fixture, Arc::clone(&transport)).await;
            wait_for_publications(&published, &changed, 2).await;
            handle.shutdown().await;

            let bootstrap = fixture
                .database
                .bootstrap(fixture.session_id)
                .await
                .unwrap();
            let source = bootstrap
                .sources
                .iter()
                .find(|source| source.id == fixture.source_id)
                .unwrap();
            assert_eq!(source.item_count, 1);
            assert_eq!(source.status, SourceStatus::Healthy);
            let statuses = published
                .lock()
                .unwrap()
                .iter()
                .filter_map(published_status)
                .collect::<Vec<_>>();
            assert_eq!(
                statuses,
                vec![SourceStatus::Refreshing, SourceStatus::Healthy]
            );
            cleanup(fixture).await;
        });
    }

    #[test]
    fn shutdown_cancels_active_network_work_and_publishes_the_final_state() {
        tauri::async_runtime::block_on(async {
            let fixture = fixture("shutdown").await;
            let transport = Arc::new(BlockingTransport::new());
            let (handle, published, _changed) =
                run_worker_with_transport(&fixture, transport.clone()).await;
            transport.wait_until_started().await;
            handle.shutdown().await;

            let statuses = published
                .lock()
                .unwrap()
                .iter()
                .filter_map(published_status)
                .collect::<Vec<_>>();
            assert_eq!(
                statuses,
                vec![SourceStatus::Refreshing, SourceStatus::Error]
            );
            let bootstrap = fixture
                .database
                .bootstrap(fixture.session_id)
                .await
                .unwrap();
            let source = bootstrap
                .sources
                .iter()
                .find(|source| source.id == fixture.source_id)
                .unwrap();
            assert_eq!(source.status, SourceStatus::Error);
            assert_eq!(
                source.error_message.as_deref(),
                Some(super::CANCELLED_REFRESH_MESSAGE)
            );
            cleanup(fixture).await;
        });
    }
}
