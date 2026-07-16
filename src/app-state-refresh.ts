import type { AppState } from "./types";

export interface ScheduledRefreshHint {
  sourceCount: number;
}

const scheduledRefreshHints = new WeakMap<AppState, ScheduledRefreshHint>();

/**
 * Renderer-local metadata for a Tauri command that only scheduled network
 * work. A WeakMap keeps the hint outside the authoritative/serializable state
 * contract and prevents a remote payload from forging it.
 */
export function annotateScheduledRefresh(
  state: AppState,
  hint: ScheduledRefreshHint,
) {
  scheduledRefreshHints.set(state, hint);
  return state;
}

export function getScheduledRefreshHint(state: AppState) {
  return scheduledRefreshHints.get(state) ?? null;
}
