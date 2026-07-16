import type { AppState, FeedItem } from "./types";

export interface AppStateItemReadStateDelta {
  itemId: string;
  seenAt: string | null;
  openedAt: string | null;
}

export interface AppStateItemDeltaHint {
  /** Final, already validated entities carried by a bounded native patch/page. */
  itemUpserts: readonly FeedItem[];
  /**
   * Read markers for search-only entities already owned by the normalized
   * store. This stays useful after their full payload leaves the facade LRU.
   */
  itemReadStates?: readonly AppStateItemReadStateDelta[];
}

const appStateItemDeltaHints = new WeakMap<AppState, AppStateItemDeltaHint>();

/**
 * Marks an in-memory state assembled from a bounded Tauri delta. The hint is
 * deliberately kept in a WeakMap: it is neither serializable nor forgeable by
 * a remote webview, and disappears with the transient compatibility snapshot.
 */
export function annotateAppStateItemDelta(
  state: AppState,
  hint: AppStateItemDeltaHint,
) {
  appStateItemDeltaHints.set(state, hint);
  return state;
}

/** Preserve the native delta when App adds already-hydrated search results. */
export function inheritAppStateItemDelta(source: AppState, target: AppState) {
  const hint = appStateItemDeltaHints.get(source);
  if (hint) appStateItemDeltaHints.set(target, hint);
  return target;
}

export function getAppStateItemDelta(state: AppState) {
  return appStateItemDeltaHints.get(state);
}
