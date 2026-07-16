import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FeedItem, FeedPage, FeedPageRequest } from "./types";

export const FEED_PAGE_SIZE = 200;
const MAX_CACHED_PAGES = 8;

type PageRecord = {
  page: FeedPage;
  usedAt: number;
};

export type FeedPageStore = {
  loading: boolean;
  error: string | null;
  totalCount: number;
  panelTotalCount: number;
  panelUnseenCount: number;
  anchorIndex: number | null;
  revision: number;
  itemAt: (index: number) => FeedItem | null;
  indexOf: (itemId: string) => number;
  revisionOf: (itemId: string) => number;
  loadedItems: FeedItem[];
  loadRange: (startIndex: number, endIndex: number) => void;
  invalidate: () => void;
};

function pageOffset(index: number) {
  return Math.max(0, Math.floor(index / FEED_PAGE_SIZE) * FEED_PAGE_SIZE);
}

export function useFeedPageStore(
  request: Omit<FeedPageRequest, "offset" | "limit">,
  contentRevision: number,
  enabled = true,
): FeedPageStore {
  const pagesRef = useRef(new Map<number, PageRecord>());
  const pendingRef = useRef(new Map<number, Promise<void>>());
  const generationRef = useRef(0);
  const usageRef = useRef(0);
  const requestRef = useRef(request);
  const revisionRef = useRef(contentRevision);
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [counts, setCounts] = useState({
    total: 0,
    panelTotal: 0,
    unseen: 0,
    anchorIndex: null as number | null,
    revision: 0,
  });
  requestRef.current = request;
  revisionRef.current = Math.max(revisionRef.current, contentRevision);
  const requestKey = `${request.panelId}\u0000${request.sourceFilter}\u0000${request.visibilityFilter}`;

  const evict = useCallback(() => {
    if (pagesRef.current.size <= MAX_CACHED_PAGES) return;
    const oldest = [...pagesRef.current.entries()]
      .sort(([, first], [, second]) => first.usedAt - second.usedAt)
      .slice(0, pagesRef.current.size - MAX_CACHED_PAGES);
    for (const [offset] of oldest) pagesRef.current.delete(offset);
  }, []);

  const loadPage = useCallback((
    offset: number,
    generation: number,
    minimumRevision = revisionRef.current,
  ): Promise<void> => {
    const normalizedOffset = pageOffset(offset);
    const existing = pagesRef.current.get(normalizedOffset);
    if (existing && existing.page.revision >= minimumRevision) {
      existing.usedAt = ++usageRef.current;
      return Promise.resolve();
    }
    const pending = pendingRef.current.get(normalizedOffset);
    if (pending) {
      return pending.then(() => loadPage(normalizedOffset, generation, minimumRevision));
    }
    const currentRequest = requestRef.current;
    const task = window.vibedeck.getFeedPage({
      ...currentRequest,
      offset: normalizedOffset,
      limit: FEED_PAGE_SIZE,
    }).then((page) => {
      if (generationRef.current !== generation || page.revision < minimumRevision) return;
      setError(null);
      pagesRef.current.set(normalizedOffset, { page, usedAt: ++usageRef.current });
      setCounts({
        total: page.queryTotalCount,
        panelTotal: page.panelTotalCount,
        unseen: page.panelUnseenCount,
        anchorIndex: page.anchorIndex,
        revision: page.revision,
      });
      evict();
      setVersion((current) => current + 1);
      if (page.anchorIndex !== null && pageOffset(page.anchorIndex) !== normalizedOffset) {
        void loadPage(page.anchorIndex, generation, minimumRevision);
      }
    }).catch((caught) => {
      if (generationRef.current !== generation) return;
      setError(caught instanceof Error ? caught.message : "Chargement du fil impossible.");
    }).finally(() => {
      if (pendingRef.current.get(normalizedOffset) === task) {
        pendingRef.current.delete(normalizedOffset);
      }
      if (generationRef.current === generation) setLoading(false);
    });
    pendingRef.current.set(normalizedOffset, task);
    return task;
  }, [evict]);

  const reset = useCallback(() => {
    const generation = ++generationRef.current;
    pagesRef.current.clear();
    pendingRef.current.clear();
    setCounts({ total: 0, panelTotal: 0, unseen: 0, anchorIndex: null, revision: 0 });
    setLoading(enabled);
    setError(null);
    setVersion((current) => current + 1);
    if (enabled) void loadPage(0, generation, revisionRef.current);
  }, [enabled, loadPage]);

  useEffect(() => {
    reset();
  }, [requestKey, enabled, reset]);

  const previousRevisionRef = useRef(contentRevision);
  useEffect(() => {
    if (!enabled || contentRevision <= previousRevisionRef.current) return;
    previousRevisionRef.current = contentRevision;
    // Les pages deviennent périmées sans être rechargées en éventail. La plage
    // visible les redemandera avec la nouvelle révision; une page froide sera
    // rafraîchie seulement lorsqu'elle redevient utile.
    setVersion((current) => current + 1);
    if (counts.total === 0) {
      void loadPage(0, generationRef.current, contentRevision);
    }
  }, [contentRevision, counts.total, enabled, loadPage]);

  const loadRange = useCallback((startIndex: number, endIndex: number) => {
    if (!enabled || endIndex < startIndex) return;
    const generation = generationRef.current;
    const first = Math.max(0, pageOffset(startIndex) - FEED_PAGE_SIZE);
    const last = pageOffset(endIndex) + FEED_PAGE_SIZE;
    for (let offset = first; offset <= last; offset += FEED_PAGE_SIZE) {
      if (counts.total > 0 && offset >= counts.total) break;
      void loadPage(offset, generation, revisionRef.current);
    }
  }, [counts.total, enabled, loadPage]);

  const itemAt = useCallback((index: number) => {
    if (index < 0) return null;
    const offset = pageOffset(index);
    const record = pagesRef.current.get(offset);
    if (!record) return null;
    record.usedAt = ++usageRef.current;
    return record.page.items[index - offset] ?? null;
  }, []);

  const indexOf = useCallback((itemId: string) => {
    for (const [offset, record] of pagesRef.current) {
      const localIndex = record.page.items.findIndex(({ id }) => id === itemId);
      if (localIndex >= 0) return offset + localIndex;
    }
    return -1;
  }, []);

  const revisionOf = useCallback((itemId: string) => {
    for (const record of pagesRef.current.values()) {
      if (record.page.items.some(({ id }) => id === itemId)) return record.page.revision;
    }
    return -1;
  }, []);

  const loadedItems = useMemo(() => [...pagesRef.current.entries()]
    .sort(([first], [second]) => first - second)
    .flatMap(([, record]) => record.page.items), [version]);

  return {
    loading,
    error,
    totalCount: counts.total,
    panelTotalCount: counts.panelTotal,
    panelUnseenCount: counts.unseen,
    anchorIndex: counts.anchorIndex,
    revision: counts.revision,
    itemAt,
    indexOf,
    revisionOf,
    loadedItems,
    loadRange,
    invalidate: reset,
  };
}
