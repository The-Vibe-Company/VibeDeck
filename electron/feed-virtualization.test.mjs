import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  boundVirtualFeedRange,
  FILTERED_FEED_PAGE_BATCH,
  MAX_MOUNTED_FEED_ROWS,
  reconcileBoundedFeedMembership,
  shouldContinueFilteredFeedPagination,
  shouldStartFilteredFeedPagination,
} from "../src/feed-virtualization.ts";

function changedItem(id, sourceId, isBaseline = false) {
  return {
    id,
    sourceId,
    canonicalUrl: `https://example.test/${id}`,
    title: id,
    summary: null,
    imageUrl: null,
    publishedAt: null,
    updatedAt: null,
    firstSeenAt: "2026-07-16T08:00:00.000Z",
    observedAt: "2026-07-16T08:00:00.000Z",
    arrivalBatchAt: "2026-07-16T08:00:00.000Z",
    lastSeenAt: "2026-07-16T08:00:00.000Z",
    isBaseline,
    isNew: !isBaseline,
    seenAt: null,
    openedAt: null,
  };
}

test("seeks sparse source/unseen filters but never drains pages for a closed search scope", () => {
  const sparseFilter = {
    pagingAvailable: true,
    searchActive: false,
    filteredItemCount: 0,
    sourceFilterActive: true,
    unseenFilterActive: false,
  };
  assert.equal(shouldStartFilteredFeedPagination(sparseFilter), true);
  assert.equal(
    shouldContinueFilteredFeedPagination(
      sparseFilter,
      "next-page",
      FILTERED_FEED_PAGE_BATCH - 1,
    ),
    true,
  );
  assert.equal(shouldContinueFilteredFeedPagination(sparseFilter, "next-page", 0), false);
  assert.equal(shouldContinueFilteredFeedPagination(sparseFilter, null, 3), false);
  assert.equal(
    shouldStartFilteredFeedPagination({ ...sparseFilter, filteredItemCount: 1 }),
    false,
  );
  assert.equal(
    shouldStartFilteredFeedPagination({ ...sparseFilter, searchActive: true }),
    false,
  );
});

test("bounds a tall virtual range while preserving keyboard and anchor pins", () => {
  const defaultIndexes = Array.from({ length: 120 }, (_, index) => index + 1_000);
  const indexes = boundVirtualFeedRange(
    defaultIndexes,
    [12, 24_999],
    { startIndex: 1_008, endIndex: 1_100, count: 25_000 },
  );

  assert.equal(indexes.length, MAX_MOUNTED_FEED_ROWS);
  assert.equal(indexes.includes(12), true);
  assert.equal(indexes.includes(24_999), true);
  assert.deepEqual(indexes, [...indexes].sort((first, second) => first - second));
  assert.equal(new Set(indexes).size, indexes.length);
});

test("keeps the complete default range when it already fits the DOM budget", () => {
  assert.deepEqual(
    boundVirtualFeedRange(
      [8, 9, 10, 11],
      [10, 100, -1, 1_000],
      { startIndex: 9, endIndex: 10, count: 101 },
    ),
    [8, 9, 10, 11, 100],
  );
});

test("reconciles a bounded arrival without iterating the 25k visible set", () => {
  const rawVisible = new Set(Array.from({ length: 25_000 }, (_, index) => `item-${index}`));
  let iterations = 0;
  const guardedVisible = new Proxy(rawVisible, {
    get(target, property) {
      if (property === Symbol.iterator || property === "values" || property === "entries") {
        iterations += 1;
        throw new Error("bounded reconciliation must not iterate the panel membership");
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const result = reconcileBoundedFeedMembership(
    guardedVisible,
    new Set(["item-10"]),
    new Set(["source-a"]),
    [
      changedItem("arrival", "source-a"),
      changedItem("item-10", "source-detached", true),
    ],
  );

  assert.equal(iterations, 0);
  assert.equal(result.visibleItemIds.size, 25_000);
  assert.equal(result.visibleItemIds.has("arrival"), true);
  assert.equal(result.visibleItemIds.has("item-10"), false);
  assert.deepEqual([...result.automaticInsertionIds], ["arrival"]);
  assert.equal(result.pendingArrivalIds.has("item-10"), false);
});

test("restores transformed feed rows from viewport geometry and pins the anchor", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

  assert.match(source, /currentViewportTop\s*-\s*anchor\.viewportTop/);
  assert.match(source, /ui\.pendingViewportAnchor\?\.itemId\s*\?\?\s*null/);
  assert.match(source, /stageFeedViewportAnchors\(Object\.keys\(feedUiRef\.current\)\)/);
  assert.match(source, /pendingViewportAnchor:\s*viewportAnchorForFilters/);
  assert.doesNotMatch(source, /anchorRow\.offsetTop/);
});

test("invalidates a delayed keyboard page focus after newer selection or DOM focus", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

  assert.match(source, /pendingFocus\.token\s*!==\s*keyboardPageFocusTokenRef\.current/);
  assert.match(source, /ui\.focusedItemId\s*!==\s*pendingFocus\.anchorItemId/);
  assert.match(source, /document\.activeElement\s*!==\s*pendingFocus\.activeElement/);
  assert.match(source, /Object\.hasOwn\(patch, "focusedItemId"\)/);
});

test("wires bounded filter seeking and disables ordinary paging inside search results", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

  assert.match(source, /filterPaginationStateRef\.current\.searchActive/);
  assert.match(source, /shouldStartFilteredFeedPagination\(filterPaginationStateRef\.current\)/);
  assert.match(source, /shouldContinueFilteredFeedPagination\(/);
  assert.match(source, /filterPageBudgetRef\.current/);
  assert.match(source, /keyboardPageBudgetRef\.current/);
  assert.match(source, /keyboardPageGesturePanelsRef\.current\.has\(panel\.id\)/);
  assert.match(source, /event\.key === "ArrowDown" && !event\.repeat/);
  assert.match(source, /event\.key === "ArrowDown"\) keyboardPageGesturePanelsRef\.current\.clear/);
  assert.match(source, /focusAfterPageRef\.current\?\.anchorItemId === focusAfterItemId/);
  assert.match(source, /page\.nextCursor === null/);
  assert.match(source, /filterPageStatus === "loading"/);
  assert.match(source, /filterPageStatus === "paused"/);
  assert.match(source, /filterPageLoadingFocusRef\.current\?\.focus/);
  assert.match(source, /filterPageActionRef\.current/);
  assert.match(source, /document\.addEventListener\("focusin", stopRestoringAfterExplicitFocusMove\)/);
  assert.match(source, /window\.addEventListener\("blur", stopRestoringAfterWindowBlur\)/);
});
