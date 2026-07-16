use crate::{
    database::{DatabaseActor, SearchDocumentPage, MAX_SEARCH_PROJECTION_PAGE_SIZE},
    error::ApiError,
    model::{MutationCommand, SearchStatus, StateChange, StatePatch},
    search::SearchIndexActor,
};
use futures_util::future::{select, Either};
use std::{
    collections::HashSet,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const SEARCH_SYNC_WAKE_CAPACITY: usize = 1;
const TARGETED_ITEM_BATCH_SIZE: usize = 200;
const SEARCH_SYNC_INITIAL_RETRY: Duration = Duration::from_millis(100);
const SEARCH_SYNC_MAX_RETRY: Duration = Duration::from_secs(5);

pub(crate) type SearchStatusPublisher = Arc<dyn Fn(SearchStatus) + Send + Sync>;

#[derive(Default)]
struct PendingSync {
    rebuild: bool,
    item_ids: HashSet<Uuid>,
    source_ids: HashSet<Uuid>,
    source_scope_ids: HashSet<Uuid>,
    panel_ids: HashSet<Uuid>,
    removed_panel_ids: HashSet<Uuid>,
}

impl PendingSync {
    fn take(&mut self) -> Self {
        std::mem::take(self)
    }
}

/// Coalesces derived-index work behind a single wake-up. During healthy
/// operation the worker sleeps until bootstrap, an authoritative mutation, or
/// feed ingestion explicitly invalidates a bounded part of the projection. A
/// bounded timer exists only while repairing a disposable-index failure.
#[derive(Clone)]
pub(crate) struct SearchSynchronizer {
    pending: Arc<Mutex<PendingSync>>,
    wake: mpsc::Sender<()>,
    initial_scheduled: Arc<AtomicBool>,
    ready: Arc<AtomicBool>,
    cancellation: CancellationToken,
}

impl SearchSynchronizer {
    pub(crate) fn spawn_with_publisher(
        database: DatabaseActor,
        index: SearchIndexActor,
        publish_status: SearchStatusPublisher,
    ) -> Self {
        let pending = Arc::new(Mutex::new(PendingSync::default()));
        let initial_scheduled = Arc::new(AtomicBool::new(false));
        let ready = Arc::new(AtomicBool::new(false));
        let cancellation = CancellationToken::new();
        let (wake, mut receiver) = mpsc::channel(SEARCH_SYNC_WAKE_CAPACITY);
        let worker_pending = Arc::clone(&pending);
        let worker_initial_scheduled = Arc::clone(&initial_scheduled);
        let worker_ready = Arc::clone(&ready);
        let worker_cancellation = cancellation.clone();
        tauri::async_runtime::spawn(async move {
            let worker = async move {
                while receiver.recv().await.is_some() {
                    let mut retry_delay = SEARCH_SYNC_INITIAL_RETRY;
                    loop {
                        let work = worker_pending
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .take();
                        let rebuilding = work.rebuild;
                        if process_sync(&database, &index, work).await.is_ok() {
                            if rebuilding {
                                publish_ready_transition(
                                    &worker_ready,
                                    true,
                                    publish_status.as_ref(),
                                );
                            }
                            break;
                        }

                        publish_ready_transition(&worker_ready, false, publish_status.as_ref());
                        // A disposable index failure must not require a later user
                        // mutation to recover. Keep one coalesced full rebuild and
                        // retry with a bounded backoff; the authoritative database
                        // is never modified by this path.
                        worker_pending
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .rebuild = true;
                        if !wait_for_retry(&mut receiver, retry_delay).await {
                            return;
                        }
                        retry_delay = retry_delay
                            .checked_mul(2)
                            .unwrap_or(SEARCH_SYNC_MAX_RETRY)
                            .min(SEARCH_SYNC_MAX_RETRY);
                    }
                }
            };
            let _ = worker_cancellation.run_until_cancelled(worker).await;
            // A future synchronizer created for a new runtime may schedule its
            // own initial projection. This flag is otherwise intentionally kept
            // true across retries so callers cannot create a hot retry loop.
            worker_initial_scheduled.store(false, Ordering::Release);
        });
        Self {
            pending,
            wake,
            initial_scheduled,
            ready,
            cancellation,
        }
    }

    /// Schedules the one global scan used to establish the disposable index.
    /// The call is constant-time and never waits for SQLite or filesystem I/O.
    pub(crate) fn schedule_initial_sync(&self) {
        if self.initial_scheduled.swap(true, Ordering::AcqRel) {
            return;
        }
        self.enqueue(|pending| pending.rebuild = true);
    }

    pub(crate) fn is_ready(&self) -> bool {
        self.ready.load(Ordering::Acquire)
    }

    pub(crate) fn shutdown(&self) {
        self.cancellation.cancel();
    }

    pub(crate) fn after_mutation(&self, command: &MutationCommand, patch: Option<&StatePatch>) {
        match command {
            MutationCommand::DeletePanel { panel_id } => self.remove_panel_scope(*panel_id),
            MutationCommand::AttachSource { source_id, .. }
            | MutationCommand::DetachSource { source_id, .. } => {
                self.refresh_source_scopes(*source_id);
            }
            _ => {}
        }
        if let Some(patch) = patch {
            self.reproject_items(patch_item_ids(patch));
        }
    }

    /// Main-process hook for the refresh worker after ingestion commits. A
    /// small patch reprojects only its item IDs; an invalidated or idempotently
    /// retried source is read by bounded source pages.
    #[allow(dead_code)] // Called by the refresh worker once it owns patch publication.
    pub(crate) fn after_ingestion(&self, source_id: Uuid, patch: Option<&StatePatch>) {
        let item_ids = patch.map(patch_item_ids).unwrap_or_default();
        if item_ids.is_empty() {
            self.reproject_source(source_id);
        } else {
            self.reproject_items(item_ids);
        }
    }

    #[allow(dead_code)] // Reserved for a panel-level invalidation from the refresh worker.
    pub(crate) fn reproject_panel(&self, panel_id: Uuid) {
        self.enqueue(|pending| {
            pending.panel_ids.insert(panel_id);
        });
    }

    pub(crate) fn remove_stale_items(&self, item_ids: impl IntoIterator<Item = Uuid>) {
        let item_ids = item_ids.into_iter().collect::<Vec<_>>();
        if item_ids.is_empty() {
            return;
        }
        self.reproject_items(item_ids);
    }

    fn reproject_items(&self, item_ids: impl IntoIterator<Item = Uuid>) {
        self.enqueue(|pending| {
            pending
                .item_ids
                .extend(item_ids.into_iter().filter(|item_id| !item_id.is_nil()));
        });
    }

    fn reproject_source(&self, source_id: Uuid) {
        if source_id.is_nil() {
            return;
        }
        self.enqueue(|pending| {
            pending.source_ids.insert(source_id);
            pending.source_scope_ids.remove(&source_id);
        });
    }

    fn refresh_source_scopes(&self, source_id: Uuid) {
        if source_id.is_nil() {
            return;
        }
        self.enqueue(|pending| {
            if !pending.source_ids.contains(&source_id) {
                pending.source_scope_ids.insert(source_id);
            }
        });
    }

    fn remove_panel_scope(&self, panel_id: Uuid) {
        if panel_id.is_nil() {
            return;
        }
        self.enqueue(|pending| {
            pending.removed_panel_ids.insert(panel_id);
            pending.panel_ids.remove(&panel_id);
        });
    }

    fn enqueue(&self, update: impl FnOnce(&mut PendingSync)) {
        if self.cancellation.is_cancelled() {
            return;
        }
        update(
            &mut self
                .pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        );
        // Full means a wake is already pending; the shared sets above contain
        // the newly coalesced work. Closed means application shutdown.
        let _ = self.wake.try_send(());
    }
}

async fn wait_for_retry(receiver: &mut mpsc::Receiver<()>, delay: Duration) -> bool {
    let mut sleeper: Pin<Box<tokio::time::Sleep>> = Box::pin(tokio::time::sleep(delay));
    loop {
        let signal = Box::pin(receiver.recv());
        match select(signal, sleeper).await {
            Either::Left((None, _)) => return false,
            Either::Left((Some(()), remaining_sleep)) => {
                // The shared PendingSync already owns the newly coalesced work.
                // Absorb the token but preserve the backoff after an I/O error.
                sleeper = remaining_sleep;
            }
            Either::Right(((), _)) => return true,
        }
    }
}

fn publish_ready_transition(
    ready: &AtomicBool,
    next: bool,
    publisher: &(dyn Fn(SearchStatus) + Send + Sync),
) {
    if ready.swap(next, Ordering::AcqRel) != next {
        publisher(SearchStatus {
            lexical_ready: next,
            semantic_ready: false,
        });
    }
}

fn patch_item_ids(patch: &StatePatch) -> Vec<Uuid> {
    let mut item_ids = Vec::new();
    for change in &patch.changes {
        if let StateChange::ItemsUpsert { items } = change {
            item_ids.extend(items.iter().map(|item| item.id));
        }
    }
    item_ids
}

async fn process_sync(
    database: &DatabaseActor,
    index: &SearchIndexActor,
    work: PendingSync,
) -> Result<(), ApiError> {
    if work.rebuild {
        index.clear().await?;
        reproject_all(database, index).await?;
        return Ok(());
    }

    let mut removed_panel_ids = work.removed_panel_ids.into_iter().collect::<Vec<_>>();
    removed_panel_ids.sort_unstable();
    for panel_id in removed_panel_ids {
        index.remove_panel_scope(panel_id).await?;
    }

    let mut source_ids = work.source_ids.into_iter().collect::<Vec<_>>();
    source_ids.sort_unstable();
    for source_id in source_ids {
        reproject_source(database, index, source_id).await?;
    }

    let mut source_scope_ids = work.source_scope_ids.into_iter().collect::<Vec<_>>();
    source_scope_ids.sort_unstable();
    for source_id in source_scope_ids {
        reproject_source_scopes(database, index, source_id).await?;
    }

    let mut panel_ids = work.panel_ids.into_iter().collect::<Vec<_>>();
    panel_ids.sort_unstable();
    for panel_id in panel_ids {
        reproject_panel(database, index, panel_id).await?;
    }

    let mut item_ids = work.item_ids.into_iter().collect::<Vec<_>>();
    item_ids.sort_unstable();
    for chunk in item_ids.chunks(TARGETED_ITEM_BATCH_SIZE) {
        let documents = database.search_documents_by_ids(chunk.to_vec()).await?;
        let projected_ids = documents
            .iter()
            .map(|document| document.item_id)
            .collect::<HashSet<_>>();
        if !documents.is_empty() {
            index.upsert_many(documents).await?;
        }
        let missing_ids = chunk
            .iter()
            .filter(|item_id| !projected_ids.contains(item_id))
            .copied()
            .collect::<Vec<_>>();
        if !missing_ids.is_empty() {
            index.remove_many(missing_ids).await?;
        }
    }
    Ok(())
}

async fn reproject_all(database: &DatabaseActor, index: &SearchIndexActor) -> Result<(), ApiError> {
    let mut cursor = None;
    loop {
        let page = database
            .search_documents_page(cursor, MAX_SEARCH_PROJECTION_PAGE_SIZE)
            .await?;
        let done = upsert_page(index, &page).await?;
        if done {
            return Ok(());
        }
        cursor = page.next_cursor;
    }
}

async fn reproject_source(
    database: &DatabaseActor,
    index: &SearchIndexActor,
    source_id: Uuid,
) -> Result<(), ApiError> {
    let mut cursor = None;
    loop {
        let page = database
            .search_documents_for_source(source_id, cursor, MAX_SEARCH_PROJECTION_PAGE_SIZE)
            .await?;
        let done = upsert_page(index, &page).await?;
        if done {
            return Ok(());
        }
        cursor = page.next_cursor;
    }
}

async fn reproject_panel(
    database: &DatabaseActor,
    index: &SearchIndexActor,
    panel_id: Uuid,
) -> Result<(), ApiError> {
    let mut cursor = None;
    loop {
        let page = database
            .search_documents_for_panel(panel_id, cursor, MAX_SEARCH_PROJECTION_PAGE_SIZE)
            .await?;
        let done = upsert_page(index, &page).await?;
        if done {
            return Ok(());
        }
        cursor = page.next_cursor;
    }
}

async fn reproject_source_scopes(
    database: &DatabaseActor,
    index: &SearchIndexActor,
    source_id: Uuid,
) -> Result<(), ApiError> {
    let mut cursor = None;
    loop {
        let page = database
            .search_documents_for_source(source_id, cursor, MAX_SEARCH_PROJECTION_PAGE_SIZE)
            .await?;
        if !page.documents.is_empty() {
            index
                .set_panel_scopes_many(
                    page.documents
                        .iter()
                        .map(|document| (document.item_id, document.panel_ids.clone()))
                        .collect(),
                )
                .await?;
        }
        let Some(next_cursor) = page.next_cursor else {
            return Ok(());
        };
        cursor = Some(next_cursor);
    }
}

async fn upsert_page(
    index: &SearchIndexActor,
    page: &SearchDocumentPage,
) -> Result<bool, ApiError> {
    if !page.documents.is_empty() {
        index.upsert_many(page.documents.clone()).await?;
    }
    Ok(page.next_cursor.is_none())
}

#[cfg(test)]
mod retry_tests {
    use super::{wait_for_retry, SEARCH_SYNC_INITIAL_RETRY, SEARCH_SYNC_MAX_RETRY};
    use std::time::Duration;
    use tokio::sync::mpsc;

    #[test]
    fn retry_wait_absorbs_wakes_without_skipping_the_backoff() {
        tauri::async_runtime::block_on(async {
            let (sender, mut receiver) = mpsc::channel(1);
            sender.try_send(()).unwrap();
            assert!(wait_for_retry(&mut receiver, Duration::from_millis(1)).await);
            drop(sender);
        });
    }

    #[test]
    fn retry_wait_stops_when_the_synchronizer_is_dropped() {
        tauri::async_runtime::block_on(async {
            let (sender, mut receiver) = mpsc::channel(1);
            drop(sender);
            assert!(!wait_for_retry(&mut receiver, SEARCH_SYNC_MAX_RETRY).await);
        });
    }

    #[test]
    fn retry_backoff_is_strictly_bounded() {
        let mut delay = SEARCH_SYNC_INITIAL_RETRY;
        for _ in 0..32 {
            delay = delay
                .checked_mul(2)
                .unwrap_or(SEARCH_SYNC_MAX_RETRY)
                .min(SEARCH_SYNC_MAX_RETRY);
        }
        assert_eq!(delay, SEARCH_SYNC_MAX_RETRY);
        assert!(delay <= Duration::from_secs(5));
    }
}
