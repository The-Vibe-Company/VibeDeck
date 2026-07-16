#![allow(
    dead_code,
    reason = "the event loop is activated with the fetch worker in the network orchestration slice"
)]

use crate::{
    database::{DatabaseActor, DueSource, IngestFeedRequest},
    error::ApiError,
    model::MutationResult,
    network::ParsedFeed,
};
use chrono::Utc;
use futures_util::future::{select, Either};
use std::{future::Future, pin::Pin, sync::Arc, time::Duration};
use tauri::async_runtime::JoinHandle;
use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const CONTROL_QUEUE_CAPACITY: usize = 8;
const REFRESH_QUEUE_CAPACITY: usize = 6;
const DUE_BATCH_SIZE: u16 = 6;
const RETRY_BASE_DELAY_MS: i64 = 100;
const RETRY_MAX_DELAY_MS: i64 = 5_000;

type SleepFuture = Pin<Box<dyn Future<Output = ()> + Send + 'static>>;
type PublishCallback = Arc<dyn Fn(MutationResult) + Send + Sync>;

#[derive(Clone)]
pub(crate) struct MutationPublisher {
    gate: Arc<Mutex<()>>,
    callback: PublishCallback,
}

impl MutationPublisher {
    pub(crate) fn new(callback: PublishCallback) -> Self {
        Self::with_gate(callback, Arc::new(Mutex::new(())))
    }

    pub(crate) fn with_gate(callback: PublishCallback, gate: Arc<Mutex<()>>) -> Self {
        Self { gate, callback }
    }

    pub(crate) async fn transition<F, T>(&self, transition: F) -> Result<T, ApiError>
    where
        F: Future<Output = Result<T, ApiError>>,
        T: PublishedTransition,
    {
        let _guard = self.gate.lock().await;
        let result = transition.await?;
        if let Some(mutation) = result.mutation() {
            (self.callback)(mutation.clone());
        }
        Ok(result)
    }
}

pub(crate) trait PublishedTransition {
    fn mutation(&self) -> Option<&MutationResult>;
}

impl PublishedTransition for MutationResult {
    fn mutation(&self) -> Option<&MutationResult> {
        Some(self)
    }
}

impl PublishedTransition for Option<MutationResult> {
    fn mutation(&self) -> Option<&MutationResult> {
        self.as_ref()
    }
}

pub(crate) trait SchedulerClock: Send + Sync + 'static {
    fn now_ms(&self) -> i64;
    fn sleep_until(&self, deadline_ms: i64) -> SleepFuture;
}

#[derive(Clone, Default)]
pub(crate) struct SystemSchedulerClock;

impl SchedulerClock for SystemSchedulerClock {
    fn now_ms(&self) -> i64 {
        Utc::now().timestamp_millis()
    }

    fn sleep_until(&self, deadline_ms: i64) -> SleepFuture {
        let delay_ms = deadline_ms.saturating_sub(self.now_ms()).max(0) as u64;
        Box::pin(tokio::time::sleep(Duration::from_millis(delay_ms)))
    }
}

#[derive(Clone)]
struct ScheduleNotifier {
    sender: mpsc::Sender<()>,
}

impl ScheduleNotifier {
    fn notify(&self) {
        // Notifications are level-triggered: one queued token is enough to
        // force a fresh MIN(due_at_ms) read. A full queue therefore means the
        // requested rearm is already guaranteed.
        let _ = self.sender.try_send(());
    }
}

pub(crate) struct RefreshJob {
    source: DueSource,
    begin_result: MutationResult,
    database: DatabaseActor,
    session_id: Uuid,
    notifier: ScheduleNotifier,
}

impl RefreshJob {
    pub(crate) fn source(&self) -> &DueSource {
        &self.source
    }

    pub(crate) fn begin_result(&self) -> &MutationResult {
        &self.begin_result
    }

    /// Completes a cache-valid refresh such as HTTP 304. Parsed responses use
    /// the ingestion transaction instead, which also performs this success
    /// transition while committing items.
    pub(crate) async fn succeed(
        &self,
        operation_id: Uuid,
        completed_at_ms: i64,
    ) -> Result<MutationResult, ApiError> {
        let result = self
            .database
            .complete_source_refresh_success(
                self.session_id,
                operation_id,
                self.source.id,
                completed_at_ms,
            )
            .await?;
        self.notifier.notify();
        Ok(result)
    }

    pub(crate) async fn fail(
        &self,
        operation_id: Uuid,
        failed_at_ms: i64,
        error_message: impl Into<String>,
    ) -> Result<MutationResult, ApiError> {
        let result = self
            .database
            .complete_source_refresh_failure(
                self.session_id,
                operation_id,
                self.source.id,
                failed_at_ms,
                error_message.into(),
            )
            .await?;
        self.notifier.notify();
        Ok(result)
    }

    pub(crate) async fn ingest(
        &self,
        operation_id: Uuid,
        observed_at: String,
        feed: ParsedFeed,
    ) -> Result<MutationResult, ApiError> {
        let result = self
            .database
            .ingest_feed(
                self.session_id,
                IngestFeedRequest {
                    operation_id,
                    source_id: self.source.id,
                    observed_at,
                    feed,
                },
            )
            .await?;
        self.notifier.notify();
        Ok(result)
    }
}

pub(crate) struct SchedulerHandle {
    notifier: ScheduleNotifier,
    cancellation: CancellationToken,
    task: Option<JoinHandle<()>>,
}

impl SchedulerHandle {
    pub(crate) fn notify_schedule_changed(&self) {
        self.notifier.notify();
    }

    pub(crate) async fn shutdown(mut self) {
        self.cancellation.cancel();
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

impl Drop for SchedulerHandle {
    fn drop(&mut self) {
        self.cancellation.cancel();
    }
}

#[allow(dead_code)] // Activated by the refresh worker in the network orchestration slice.
pub(crate) fn spawn_scheduler(
    database: DatabaseActor,
    session_id: Uuid,
    clock: Arc<dyn SchedulerClock>,
) -> (SchedulerHandle, mpsc::Receiver<RefreshJob>) {
    spawn_scheduler_with_publisher(
        database,
        session_id,
        clock,
        MutationPublisher::new(Arc::new(|_| {})),
    )
}

pub(crate) fn spawn_scheduler_with_publisher(
    database: DatabaseActor,
    session_id: Uuid,
    clock: Arc<dyn SchedulerClock>,
    publisher: MutationPublisher,
) -> (SchedulerHandle, mpsc::Receiver<RefreshJob>) {
    let (control_sender, control_receiver) = mpsc::channel(CONTROL_QUEUE_CAPACITY);
    let (refresh_sender, refresh_receiver) = mpsc::channel(REFRESH_QUEUE_CAPACITY);
    let notifier = ScheduleNotifier {
        sender: control_sender,
    };
    let cancellation = CancellationToken::new();
    let task = tauri::async_runtime::spawn(run_scheduler(
        database,
        session_id,
        Arc::clone(&clock),
        notifier.clone(),
        publisher,
        control_receiver,
        refresh_sender,
        cancellation.clone(),
    ));
    (
        SchedulerHandle {
            notifier,
            cancellation,
            task: Some(task),
        },
        refresh_receiver,
    )
}

#[allow(clippy::too_many_arguments)]
async fn run_scheduler(
    database: DatabaseActor,
    session_id: Uuid,
    clock: Arc<dyn SchedulerClock>,
    notifier: ScheduleNotifier,
    publisher: MutationPublisher,
    mut control_receiver: mpsc::Receiver<()>,
    refresh_sender: mpsc::Sender<RefreshJob>,
    cancellation: CancellationToken,
) {
    let mut consecutive_failures = 0_u32;
    loop {
        while control_receiver.try_recv().is_ok() {}
        if cancellation.is_cancelled() {
            return;
        }

        let next_due_at_ms = match database.next_due_at_ms().await {
            Ok(next_due_at_ms) => next_due_at_ms,
            Err(_) => {
                let delay_ms = retry_delay_ms(consecutive_failures);
                consecutive_failures = consecutive_failures.saturating_add(1);
                if !wait_for_retry(
                    &mut control_receiver,
                    &cancellation,
                    clock.as_ref(),
                    delay_ms,
                )
                .await
                {
                    return;
                }
                continue;
            }
        };
        let Some(next_due_at_ms) = next_due_at_ms else {
            consecutive_failures = 0;
            if !wait_for_signal(&mut control_receiver, &cancellation).await {
                return;
            }
            continue;
        };

        let now_ms = clock.now_ms();
        if next_due_at_ms > now_ms {
            consecutive_failures = 0;
            let signal = Box::pin(control_receiver.recv());
            let timer = clock.sleep_until(next_due_at_ms);
            let Some(outcome) = cancellation
                .run_until_cancelled(select(signal, timer))
                .await
            else {
                return;
            };
            if matches!(outcome, Either::Left((None, _))) {
                return;
            }
            continue;
        }

        let due_sources = match database.due_sources(now_ms, DUE_BATCH_SIZE).await {
            Ok(sources) if !sources.is_empty() => sources,
            Ok(_) | Err(_) => {
                let delay_ms = retry_delay_ms(consecutive_failures);
                consecutive_failures = consecutive_failures.saturating_add(1);
                if !wait_for_retry(
                    &mut control_receiver,
                    &cancellation,
                    clock.as_ref(),
                    delay_ms,
                )
                .await
                {
                    return;
                }
                continue;
            }
        };
        let mut transition_failed = false;
        for source in due_sources {
            let Some(permit) = cancellation
                .run_until_cancelled(refresh_sender.clone().reserve_owned())
                .await
            else {
                return;
            };
            let Ok(permit) = permit else {
                return;
            };
            match publisher
                .transition(database.begin_source_refresh(
                    session_id,
                    Uuid::new_v4(),
                    source.id,
                    now_ms,
                ))
                .await
            {
                Ok(Some(begin_result)) => {
                    permit.send(RefreshJob {
                        source,
                        begin_result,
                        database: database.clone(),
                        session_id,
                        notifier: notifier.clone(),
                    });
                }
                Ok(None) => {}
                Err(_) => {
                    transition_failed = true;
                    break;
                }
            }
        }
        if transition_failed {
            let delay_ms = retry_delay_ms(consecutive_failures);
            consecutive_failures = consecutive_failures.saturating_add(1);
            if !wait_for_retry(
                &mut control_receiver,
                &cancellation,
                clock.as_ref(),
                delay_ms,
            )
            .await
            {
                return;
            }
        } else {
            consecutive_failures = 0;
        }
    }
}

fn retry_delay_ms(consecutive_failures: u32) -> i64 {
    let shift = consecutive_failures.min(6);
    RETRY_BASE_DELAY_MS
        .saturating_mul(1_i64 << shift)
        .min(RETRY_MAX_DELAY_MS)
}

async fn wait_for_retry(
    control_receiver: &mut mpsc::Receiver<()>,
    cancellation: &CancellationToken,
    clock: &dyn SchedulerClock,
    delay_ms: i64,
) -> bool {
    let deadline_ms = clock.now_ms().saturating_add(delay_ms.max(1));
    let signal = Box::pin(control_receiver.recv());
    let timer = clock.sleep_until(deadline_ms);
    let Some(outcome) = cancellation
        .run_until_cancelled(select(signal, timer))
        .await
    else {
        return false;
    };
    !matches!(outcome, Either::Left((None, _)))
}

async fn wait_for_signal(
    control_receiver: &mut mpsc::Receiver<()>,
    cancellation: &CancellationToken,
) -> bool {
    matches!(
        cancellation
            .run_until_cancelled(control_receiver.recv())
            .await,
        Some(Some(()))
    )
}

#[cfg(test)]
mod tests {
    use super::{
        retry_delay_ms, spawn_scheduler, wait_for_retry, SchedulerClock, SleepFuture,
        RETRY_MAX_DELAY_MS,
    };
    use crate::{
        database::DatabaseActor,
        model::{
            ConnectorKind, CreatePanelInput, GenericSourceInput, MutateRequest, MutationCommand,
            Panel, SourceStatus, StateChange,
        },
    };
    use futures_util::future::join;
    use std::sync::{
        atomic::{AtomicI64, Ordering},
        Arc,
    };
    use tokio::sync::{mpsc, Notify};
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

        fn set(&self, now_ms: i64) {
            self.now_ms.store(now_ms, Ordering::SeqCst);
            self.changed.notify_waiters();
        }
    }

    impl SchedulerClock for ManualClock {
        fn now_ms(&self) -> i64 {
            self.now_ms.load(Ordering::SeqCst)
        }

        fn sleep_until(&self, deadline_ms: i64) -> SleepFuture {
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

    fn fixture_path() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("vibedeck-scheduler-{}.sqlite", Uuid::new_v4()))
    }

    fn panel_id_from(result: &crate::model::MutationResult) -> Uuid {
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

    fn source_id_from(result: &crate::model::MutationResult) -> Uuid {
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

    async fn create_panel(
        database: &DatabaseActor,
        session_id: Uuid,
        expected_revision: u64,
    ) -> Uuid {
        let result = database
            .mutate(
                session_id,
                MutateRequest {
                    operation_id: Uuid::new_v4(),
                    expected_revision,
                    command: MutationCommand::CreatePanel {
                        input: CreatePanelInput::Feed {
                            name: "Fil planifié".to_owned(),
                            default_refresh_interval_seconds: Some(60),
                        },
                        placement: None,
                    },
                },
            )
            .await
            .unwrap();
        panel_id_from(&result)
    }

    async fn add_source(
        database: &DatabaseActor,
        session_id: Uuid,
        panel_id: Uuid,
        expected_revision: u64,
        suffix: &str,
    ) -> Uuid {
        let result = database
            .mutate(
                session_id,
                MutateRequest {
                    operation_id: Uuid::new_v4(),
                    expected_revision,
                    command: MutationCommand::AddGenericSource {
                        panel_id,
                        source: GenericSourceInput {
                            name: format!("Source {suffix}"),
                            input_url: format!("https://{suffix}.example.test/"),
                            feed_url: format!("https://{suffix}.example.test/feed.xml"),
                            connector_kind: ConnectorKind::Rss,
                            refresh_interval_seconds: 60,
                        },
                        position: None,
                    },
                },
            )
            .await
            .unwrap();
        source_id_from(&result)
    }

    async fn setup_source(path: &std::path::Path) -> (DatabaseActor, Uuid, Uuid, Uuid, i64) {
        let database = DatabaseActor::spawn(path.to_owned());
        let session_id = Uuid::new_v4();
        let panel_id = create_panel(&database, session_id, 0).await;
        let source_id = add_source(&database, session_id, panel_id, 1, "initiale").await;
        let due_at_ms = database.next_due_at_ms().await.unwrap().unwrap();
        (database, session_id, panel_id, source_id, due_at_ms)
    }

    async fn next_job(
        jobs: &mut tokio::sync::mpsc::Receiver<super::RefreshJob>,
    ) -> super::RefreshJob {
        tokio::time::timeout(std::time::Duration::from_secs(1), jobs.recv())
            .await
            .expect("scheduler should respond")
            .expect("scheduler queue should stay open")
    }

    #[test]
    fn no_deadline_waits_without_emitting_work() {
        tauri::async_runtime::block_on(async {
            let path = fixture_path();
            let database = DatabaseActor::spawn(path.clone());
            assert_eq!(database.next_due_at_ms().await.unwrap(), None);
            let clock = Arc::new(ManualClock::new(0));
            let (handle, mut jobs) = spawn_scheduler(database.clone(), Uuid::new_v4(), clock);
            tokio::task::yield_now().await;
            assert!(matches!(
                jobs.try_recv(),
                Err(tokio::sync::mpsc::error::TryRecvError::Empty)
            ));
            handle.shutdown().await;
            assert!(jobs.recv().await.is_none());
            database.shutdown().await;
            drop(database);
            std::fs::remove_file(path).unwrap();
        });
    }

    #[test]
    fn immediate_deadline_emits_one_bounded_job_and_marks_refreshing() {
        tauri::async_runtime::block_on(async {
            let path = fixture_path();
            let (database, session_id, _, source_id, due_at_ms) = setup_source(&path).await;
            let clock = Arc::new(ManualClock::new(due_at_ms));
            let (handle, mut jobs) = spawn_scheduler(database.clone(), session_id, clock.clone());
            let job = next_job(&mut jobs).await;
            assert_eq!(job.source().id, source_id);
            assert_eq!(job.source().due_at_ms, due_at_ms);
            assert_eq!(job.source().refresh_interval_seconds, 60);
            assert_eq!(job.source().connector_kind, ConnectorKind::Rss);
            assert!(job.source().feed_url.ends_with("/feed.xml"));
            assert!(job.begin_result().patch.as_ref().unwrap().changes.iter().any(
                |change| matches!(change, StateChange::SourceUpsert { source } if source.status == SourceStatus::Refreshing)
            ));
            assert_eq!(database.next_due_at_ms().await.unwrap(), None);
            job.succeed(Uuid::new_v4(), due_at_ms + 1).await.unwrap();
            handle.shutdown().await;
            database.shutdown().await;
            drop(database);
            std::fs::remove_file(path).unwrap();
        });
    }

    #[test]
    fn notification_rearms_a_sleeping_timer_for_an_earlier_source() {
        tauri::async_runtime::block_on(async {
            let path = fixture_path();
            let (database, session_id, panel_id, first_source_id, first_due_at_ms) =
                setup_source(&path).await;
            let clock = Arc::new(ManualClock::new(first_due_at_ms));
            let (handle, mut jobs) = spawn_scheduler(database.clone(), session_id, clock.clone());
            let first_job = next_job(&mut jobs).await;
            assert_eq!(first_job.source().id, first_source_id);
            first_job
                .succeed(Uuid::new_v4(), first_due_at_ms)
                .await
                .unwrap();
            let later_due_at_ms = database.next_due_at_ms().await.unwrap().unwrap();
            assert_eq!(later_due_at_ms, first_due_at_ms + 60_000);

            let second_source_id = add_source(&database, session_id, panel_id, 4, "plus-tot").await;
            let earlier_due_at_ms = database.next_due_at_ms().await.unwrap().unwrap();
            assert!(earlier_due_at_ms < later_due_at_ms);
            handle.notify_schedule_changed();
            clock.set(earlier_due_at_ms);
            let second_job = next_job(&mut jobs).await;
            assert_eq!(second_job.source().id, second_source_id);
            second_job
                .succeed(Uuid::new_v4(), earlier_due_at_ms)
                .await
                .unwrap();
            handle.shutdown().await;
            database.shutdown().await;
            drop(database);
            std::fs::remove_file(path).unwrap();
        });
    }

    #[test]
    fn successful_refresh_rearms_regular_interval_without_touching_items() {
        tauri::async_runtime::block_on(async {
            let path = fixture_path();
            let (database, session_id, _, source_id, due_at_ms) = setup_source(&path).await;
            let clock = Arc::new(ManualClock::new(due_at_ms));
            let (handle, mut jobs) = spawn_scheduler(database.clone(), session_id, clock);
            let job = next_job(&mut jobs).await;
            let completed_at_ms = due_at_ms + 250;
            let result = job.succeed(Uuid::new_v4(), completed_at_ms).await.unwrap();
            assert_eq!(result.ack.committed_revision, 4);
            let state = database.bootstrap(session_id).await.unwrap();
            let source = state
                .sources
                .iter()
                .find(|source| source.id == source_id)
                .unwrap();
            assert_eq!(source.status, SourceStatus::Healthy);
            assert_eq!(source.consecutive_failures, 0);
            assert_eq!(source.next_retry_at, None);
            assert_eq!(source.due_at_ms, completed_at_ms + 60_000);
            assert!(source.last_success_at.is_some());
            assert_eq!(source.item_count, 0);
            handle.shutdown().await;
            database.shutdown().await;
            drop(database);
            std::fs::remove_file(path).unwrap();
        });
    }

    #[test]
    fn failures_persist_exponential_backoff_and_keep_last_content() {
        tauri::async_runtime::block_on(async {
            let path = fixture_path();
            let (database, session_id, panel_id, source_id, due_at_ms) = setup_source(&path).await;
            let clock = Arc::new(ManualClock::new(due_at_ms));
            let (handle, mut jobs) = spawn_scheduler(database.clone(), session_id, clock.clone());
            let first_job = next_job(&mut jobs).await;
            let first_failure_at_ms = due_at_ms + 100;
            first_job
                .fail(
                    Uuid::new_v4(),
                    first_failure_at_ms,
                    "Réseau momentanément indisponible",
                )
                .await
                .unwrap();
            let first_state = database.bootstrap(session_id).await.unwrap();
            let first_source = first_state
                .sources
                .iter()
                .find(|source| source.id == source_id)
                .unwrap();
            assert_eq!(first_source.status, SourceStatus::Error);
            assert_eq!(first_source.consecutive_failures, 1);
            assert_eq!(first_source.due_at_ms, first_failure_at_ms + 60_000);
            assert!(first_source.next_retry_at.is_some());
            assert_eq!(first_source.item_count, 0);
            assert!(matches!(
                &first_state.panels[0],
                Panel::Feed { id, .. } if *id == panel_id
            ));

            clock.set(first_source.due_at_ms);
            let second_job = next_job(&mut jobs).await;
            let second_failure_at_ms = first_source.due_at_ms + 10;
            second_job
                .fail(
                    Uuid::new_v4(),
                    second_failure_at_ms,
                    "Toujours indisponible",
                )
                .await
                .unwrap();
            let second_state = database.bootstrap(session_id).await.unwrap();
            let second_source = second_state
                .sources
                .iter()
                .find(|source| source.id == source_id)
                .unwrap();
            assert_eq!(second_source.consecutive_failures, 2);
            assert_eq!(second_source.due_at_ms, second_failure_at_ms + 120_000);
            assert_eq!(second_source.item_count, 0);
            handle.shutdown().await;
            database.shutdown().await;
            drop(database);
            std::fs::remove_file(path).unwrap();
        });
    }

    #[test]
    fn shutdown_cancels_a_future_timer_without_starting_refresh() {
        tauri::async_runtime::block_on(async {
            let path = fixture_path();
            let (database, session_id, _, source_id, due_at_ms) = setup_source(&path).await;
            let clock = Arc::new(ManualClock::new(due_at_ms - 1_000));
            let (handle, mut jobs) = spawn_scheduler(database.clone(), session_id, clock.clone());
            tokio::task::yield_now().await;
            handle.shutdown().await;
            clock.set(due_at_ms);
            assert!(jobs.recv().await.is_none());
            let state = database.bootstrap(session_id).await.unwrap();
            let source = state
                .sources
                .iter()
                .find(|source| source.id == source_id)
                .unwrap();
            assert_eq!(source.status, SourceStatus::Idle);
            assert_eq!(state.revision, 2);
            database.shutdown().await;
            drop(database);
            std::fs::remove_file(path).unwrap();
        });
    }

    #[test]
    fn reopen_recovers_a_refresh_interrupted_after_the_begin_commit() {
        tauri::async_runtime::block_on(async {
            let path = fixture_path();
            let (database, session_id, _, source_id, due_at_ms) = setup_source(&path).await;
            let clock = Arc::new(ManualClock::new(due_at_ms));
            let (handle, mut jobs) = spawn_scheduler(database.clone(), session_id, clock.clone());
            let interrupted_job = next_job(&mut jobs).await;
            let interrupted_state = database.bootstrap(session_id).await.unwrap();
            let interrupted_source = interrupted_state
                .sources
                .iter()
                .find(|source| source.id == source_id)
                .unwrap();
            assert_eq!(interrupted_source.status, SourceStatus::Refreshing);
            assert_eq!(interrupted_source.due_at_ms, due_at_ms);

            // Model a process loss after Refreshing was committed but before
            // the worker could persist a terminal transition.
            drop(interrupted_job);
            handle.shutdown().await;
            database.shutdown().await;
            drop(database);

            let reopened = DatabaseActor::spawn(path.clone());
            let reopened_session_id = Uuid::new_v4();
            let reopened_state = reopened.bootstrap(reopened_session_id).await.unwrap();
            let reopened_source = reopened_state
                .sources
                .iter()
                .find(|source| source.id == source_id)
                .unwrap();
            assert_eq!(reopened_source.status, SourceStatus::Idle);
            assert_eq!(reopened_source.due_at_ms, due_at_ms);

            let (reopened_handle, mut reopened_jobs) =
                spawn_scheduler(reopened.clone(), reopened_session_id, clock);
            let recovered_job = next_job(&mut reopened_jobs).await;
            assert_eq!(recovered_job.source().id, source_id);
            recovered_job
                .succeed(Uuid::new_v4(), due_at_ms + 1)
                .await
                .unwrap();
            let recovered_state = reopened.bootstrap(reopened_session_id).await.unwrap();
            assert_eq!(
                recovered_state
                    .sources
                    .iter()
                    .find(|source| source.id == source_id)
                    .unwrap()
                    .status,
                SourceStatus::Healthy
            );

            reopened_handle.shutdown().await;
            reopened.shutdown().await;
            drop(reopened);
            std::fs::remove_file(path).unwrap();
        });
    }

    #[test]
    fn retry_backoff_is_bounded_and_rearms_without_an_external_notification() {
        tauri::async_runtime::block_on(async {
            assert_eq!(retry_delay_ms(0), 100);
            assert_eq!(retry_delay_ms(1), 200);
            assert_eq!(retry_delay_ms(32), RETRY_MAX_DELAY_MS);

            let clock = ManualClock::new(1_000);
            let advance_clock = clock.clone();
            let (_control_sender, mut control_receiver) = mpsc::channel(1);
            let cancellation = CancellationToken::new();
            let wait = wait_for_retry(&mut control_receiver, &cancellation, &clock, 100);
            let advance = async move {
                tokio::task::yield_now().await;
                advance_clock.set(1_100);
            };
            let (rearmed, ()) = join(wait, advance).await;
            assert!(rearmed);
        });
    }

    #[test]
    fn retry_wait_is_cancellable_without_deadlock() {
        tauri::async_runtime::block_on(async {
            let clock = ManualClock::new(0);
            let (_control_sender, mut control_receiver) = mpsc::channel(1);
            let cancellation = CancellationToken::new();
            let cancel = cancellation.clone();
            let wait = wait_for_retry(&mut control_receiver, &cancellation, &clock, 5_000);
            let stop = async move {
                tokio::task::yield_now().await;
                cancel.cancel();
            };
            let (rearmed, ()) = join(wait, stop).await;
            assert!(!rearmed);
        });
    }
}
