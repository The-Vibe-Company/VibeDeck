import type { FeedItem } from "./types";

export const MAX_MOUNTED_FEED_ROWS = 80;
export const FILTERED_FEED_PAGE_BATCH = 4;

export interface VirtualFeedRange {
  startIndex: number;
  endIndex: number;
  count: number;
}

export interface FilteredFeedPaginationState {
  pagingAvailable: boolean;
  searchActive: boolean;
  filteredItemCount: number;
  sourceFilterActive: boolean;
  unseenFilterActive: boolean;
}

export interface BoundedFeedMembershipResult {
  visibleItemIds: Set<string>;
  pendingArrivalIds: Set<string>;
  automaticInsertionIds: Set<string>;
  changed: boolean;
}

/**
 * Reconciles only the entities carried by one bounded native delta. An item
 * whose current source no longer belongs to the panel is removed; a loaded
 * item is promoted immediately. No panel-wide membership set is rebuilt.
 */
export function reconcileBoundedFeedMembership(
  visibleItemIds: ReadonlySet<string>,
  pendingArrivalIds: ReadonlySet<string>,
  panelSourceIds: ReadonlySet<string>,
  changedItems: readonly (FeedItem | null)[],
): BoundedFeedMembershipResult {
  // These Sets are private renderer-compatibility projections, just like the
  // facade's items array. The caller publishes a fresh FeedPanelUi object
  // synchronously after this bounded mutation, so cloning 25k identifiers is
  // unnecessary and no observer can see a half-applied state.
  const nextVisible = visibleItemIds as Set<string>;
  const nextPending = pendingArrivalIds as Set<string>;
  const automaticInsertionIds = new Set<string>();
  let changed = false;

  for (const item of changedItems) {
    if (!item) continue;
    const belongsToPanel = panelSourceIds.has(item.sourceId);
    if (belongsToPanel && !nextVisible.has(item.id)) {
      nextVisible.add(item.id);
      changed = true;
      if (!item.isBaseline) automaticInsertionIds.add(item.id);
      continue;
    }
    if (belongsToPanel) continue;
    if (nextVisible.delete(item.id)) changed = true;
    if (nextPending.delete(item.id)) changed = true;
  }

  return {
    visibleItemIds: nextVisible,
    pendingArrivalIds: nextPending,
    automaticInsertionIds,
    changed,
  };
}

export function shouldStartFilteredFeedPagination(state: FilteredFeedPaginationState) {
  return (
    state.pagingAvailable &&
    !state.searchActive &&
    state.filteredItemCount === 0 &&
    (state.sourceFilterActive || state.unseenFilterActive)
  );
}

export function shouldContinueFilteredFeedPagination(
  state: FilteredFeedPaginationState,
  nextCursor: string | null,
  remainingPageBudget: number,
) {
  return (
    nextCursor !== null &&
    remainingPageBudget > 0 &&
    shouldStartFilteredFeedPagination(state)
  );
}

function validIndex(index: number, count: number) {
  return Number.isSafeInteger(index) && index >= 0 && index < count;
}

function distanceFromVisibleRange(index: number, range: VirtualFeedRange) {
  if (index < range.startIndex) return range.startIndex - index;
  if (index > range.endIndex) return index - range.endIndex;
  return 0;
}

/**
 * TanStack's default extractor deliberately grows with a tall viewport. The
 * product contract is stricter: no feed may mount more than 80 rows. Keyboard
 * and scroll-anchor pins win a slot even when they sit outside the viewport;
 * the remaining slots stay as close as possible to the visible range.
 */
export function boundVirtualFeedRange(
  defaultIndexes: readonly number[],
  pinnedIndexes: readonly number[],
  range: VirtualFeedRange,
  maximum = MAX_MOUNTED_FEED_ROWS,
) {
  const limit = Math.max(1, Math.trunc(maximum));
  const pinned: number[] = [];
  const selected = new Set<number>();
  for (const index of pinnedIndexes) {
    if (!validIndex(index, range.count) || selected.has(index)) continue;
    selected.add(index);
    pinned.push(index);
    if (pinned.length === limit) return pinned.sort((first, second) => first - second);
  }

  const candidates: number[] = [];
  for (const index of defaultIndexes) {
    if (!validIndex(index, range.count) || selected.has(index)) continue;
    selected.add(index);
    candidates.push(index);
  }
  if (pinned.length + candidates.length <= limit) {
    return [...pinned, ...candidates].sort((first, second) => first - second);
  }

  candidates.sort((first, second) => {
    const distance = distanceFromVisibleRange(first, range) -
      distanceFromVisibleRange(second, range);
    return distance || first - second;
  });
  return [...pinned, ...candidates.slice(0, limit - pinned.length)]
    .sort((first, second) => first - second);
}
