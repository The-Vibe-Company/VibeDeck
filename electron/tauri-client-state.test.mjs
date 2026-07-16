import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  advanceFeedPageChain,
  applyPatchToState,
  compareWebPanelStateOrder,
  createRetryableBootstrapGate,
  hasTauriErrorCode,
  isFeedPageRevisionCurrent,
  MAX_DETACHED_SEARCH_ITEMS,
  normalizeTauriWebPanelDescriptors,
  rebuildFeedPageChainFromHead,
  retainDetachedSearchItems,
  shouldApplyAuthoritativeBootstrap,
} from "../src/tauri-client.ts";
import {
  getAppStateItemDelta,
  inheritAppStateItemDelta,
} from "../src/app-state-delta.ts";
import { NormalizedAppStore } from "../src/app-store.ts";
import {
  annotateScheduledRefresh,
  getScheduledRefreshHint,
} from "../src/app-state-refresh.ts";
import { WebPreviewAuthorizations } from "../src/web-preview-authorizations.ts";

const SOURCE_ID = "00000000-0000-4000-8000-000000000001";

function feedItem(index, overrides = {}) {
  return {
    id: `item-${String(index).padStart(6, "0")}`,
    sourceId: SOURCE_ID,
    canonicalUrl: `https://example.test/articles/${index}`,
    title: `Article ${index}`,
    summary: null,
    imageUrl: null,
    publishedAt: "2026-07-16T08:00:00.000Z",
    updatedAt: null,
    firstSeenAt: "2026-07-16T08:00:00.000Z",
    observedAt: "2026-07-16T08:00:00.000Z",
    arrivalBatchAt: "2026-07-16T08:00:00.000Z",
    lastSeenAt: "2026-07-16T08:00:00.000Z",
    isBaseline: true,
    isNew: false,
    seenAt: null,
    openedAt: null,
    ...overrides,
  };
}

function appState(items, revision = 7) {
  return {
    dashboard: { layout: null, revision },
    panels: [],
    sources: [],
    sourceCatalog: [],
    items,
    refreshedAt: "2026-07-16T08:00:00.000Z",
  };
}

function itemPatch(revision, changes) {
  return {
    sessionId: "session-a",
    baseRevision: revision - 1,
    revision,
    operationId: `operation-${revision}`,
    changes,
  };
}

test("an invalidated feed rebuilds every keyset page from the fresh head", () => {
  const previous = {
    cursor: "old-after-400",
    revision: 7,
    exhausted: false,
    generation: 2,
  };
  const invalidated = rebuildFeedPageChainFromHead(previous, 8);
  assert.deepEqual(invalidated, {
    cursor: null,
    revision: 8,
    exhausted: false,
    generation: 3,
  });

  const freshHead = advanceFeedPageChain(invalidated, {
    revision: 8,
    nextCursor: "fresh-after-200",
  });
  assert.equal(freshHead.cursor, "fresh-after-200");
  assert.notEqual(freshHead.cursor, previous.cursor);

  const freshSecondPage = advanceFeedPageChain(freshHead, {
    revision: 8,
    nextCursor: "fresh-after-400",
  });
  assert.equal(freshSecondPage.cursor, "fresh-after-400");
  assert.equal(freshSecondPage.generation, invalidated.generation);
});

test("authoritative bootstraps are monotone by request order and revision", () => {
  const current = { sessionId: "session-a", revision: 12 };
  assert.equal(
    shouldApplyAuthoritativeBootstrap(
      current,
      { sessionId: "session-a", revision: 11 },
      3,
      2,
    ),
    false,
  );
  assert.equal(
    shouldApplyAuthoritativeBootstrap(
      current,
      { sessionId: "session-a", revision: 13 },
      1,
      2,
    ),
    false,
  );
  assert.equal(
    shouldApplyAuthoritativeBootstrap(
      current,
      { sessionId: "session-a", revision: 13 },
      3,
      2,
    ),
    true,
  );
  assert.equal(
    shouldApplyAuthoritativeBootstrap(
      current,
      { sessionId: "session-b", revision: 0 },
      3,
      2,
    ),
    true,
  );
});

test("a rejected authoritative bootstrap is requested again instead of poisoning the facade", async () => {
  let authoritativeState = null;
  let requestCount = 0;
  const expected = { revision: 9 };
  const ensureBootstrap = createRetryableBootstrapGate(
    () => authoritativeState,
    async () => {
      requestCount += 1;
      if (requestCount === 1) throw new Error("native process still starting");
      authoritativeState = expected;
      return expected;
    },
  );

  await assert.rejects(ensureBootstrap(), /still starting/);
  assert.equal(await ensureBootstrap(), expected);
  assert.equal(await ensureBootstrap(), expected);
  assert.equal(requestCount, 2, "the ready state must not trigger a third invoke");

  const source = readFileSync(new URL("../src/tauri-client.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /await authoritativeBootstrap/);
  assert.match(source, /await ensureAuthoritativeBootstrap\(\)/);
});

test("feed pages older than either the cursor chain or dashboard are stale", () => {
  assert.equal(isFeedPageRevisionCurrent(12, 12, 12), true);
  assert.equal(isFeedPageRevisionCurrent(13, 12, 12), true);
  assert.equal(isFeedPageRevisionCurrent(11, 12, 10), false);
  assert.equal(isFeedPageRevisionCurrent(12, 10, 13), false);

  const source = readFileSync(new URL("../src/tauri-client.ts", import.meta.url), "utf8");
  const settlement = source
    .split('const request = invoke<unknown>("get_feed_page"')[1]
    ?.split("paging.inFlight = request;")[0];
  assert.ok(settlement, "feed page settlement missing");
  assert.match(
    settlement,
    /isFeedPageRevisionCurrent\([\s\S]*state\.dashboard\.revision[\s\S]*invalidatePanelPage\(panelId\)/,
  );
});

test("bounded item patches never clone or iterate the 25k compatibility array", () => {
  const items = Array.from({ length: 25_000 }, (_, index) => feedItem(index));
  const itemIndex = new Map(items.map((item, index) => [item.id, index]));
  let iteratorReads = 0;
  let numericReads = 0;
  const guardedItems = new Proxy(items, {
    get(target, property, receiver) {
      if (property === Symbol.iterator) {
        iteratorReads += 1;
        throw new Error("bounded native patches must not iterate all items");
      }
      if (typeof property === "string" && /^\d+$/.test(property)) numericReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const previous = appState(guardedItems);
  const targetId = items[12_345].id;
  const readApplied = applyPatchToState(
    previous,
    itemPatch(8, [{
      kind: "itemsReadState",
      items: [{
        itemId: targetId,
        seenAt: "2026-07-16T09:00:00.000Z",
        openedAt: null,
      }],
    }]),
    itemIndex,
  );

  assert.equal(readApplied.state.items, guardedItems);
  assert.equal(readApplied.state.items.length, 25_000);
  assert.equal(items[12_345].seenAt, "2026-07-16T09:00:00.000Z");
  assert.equal(iteratorReads, 0);
  assert.equal(numericReads, 1, "only the changed slot may be read");
  assert.deepEqual(
    getAppStateItemDelta(readApplied.state)?.itemUpserts.map(({ id }) => id),
    [targetId],
  );

  const editorialApplied = applyPatchToState(
    readApplied.state,
    itemPatch(9, [{
      kind: "itemsUpsert",
      items: [{ ...feedItem(12_345), title: "Titre corrigé" }],
    }]),
    itemIndex,
  );
  assert.equal(editorialApplied.state.items, guardedItems);
  assert.equal(items[12_345].title, "Titre corrigé");
  assert.equal(items[12_345].seenAt, "2026-07-16T09:00:00.000Z");
  assert.equal(iteratorReads, 0);
  assert.ok(numericReads <= 3, `bounded patch read ${numericReads} slots`);
});

test("an invalid later change cannot partially mutate the compatibility array", () => {
  const original = feedItem(42);
  const items = [original];
  const itemIndex = new Map([[original.id, 0]]);
  assert.throws(
    () => applyPatchToState(
      appState(items),
      itemPatch(8, [
        { kind: "itemsUpsert", items: [{ ...original, title: "Must not leak" }] },
        { kind: "unknownChange" },
      ]),
      itemIndex,
    ),
    /Type de changement inconnu/,
  );
  assert.equal(items[0], original);
  assert.equal(items[0].title, "Article 42");
});

test("detached search hits stay bounded and receive Vu/Ouvert through a delta hint", () => {
  const loaded = [feedItem(0)];
  const loadedIndex = new Map([[loaded[0].id, 0]]);
  const cache = new Map();
  const hits = Array.from(
    { length: MAX_DETACHED_SEARCH_ITEMS + 50 },
    (_, index) => feedItem(index + 1_000),
  );
  retainDetachedSearchItems(cache, [loaded[0], ...hits], loadedIndex);

  assert.equal(cache.size, MAX_DETACHED_SEARCH_ITEMS);
  assert.equal(cache.has(loaded[0].id), false);
  assert.equal(cache.has(hits[0].id), false, "the oldest inactive hit is evicted");
  const target = hits.at(-1);
  assert.equal(cache.has(target.id), true);

  const previous = appState(loaded);
  const applied = applyPatchToState(
    previous,
    itemPatch(8, [{
      kind: "itemsReadState",
      items: [{
        itemId: target.id,
        seenAt: "2026-07-16T09:30:00.000Z",
        openedAt: "2026-07-16T09:31:00.000Z",
      }],
    }]),
    loadedIndex,
    cache,
  );

  assert.equal(applied.state.items, loaded);
  assert.equal(applied.state.items.length, 1, "search-only rows never inflate paged items");
  assert.equal(cache.get(target.id)?.seenAt, "2026-07-16T09:30:00.000Z");
  assert.equal(cache.get(target.id)?.openedAt, "2026-07-16T09:31:00.000Z");
  assert.deepEqual(getAppStateItemDelta(applied.state)?.itemUpserts, [cache.get(target.id)]);
});

test("an applied search hit keeps receiving Vu/Ouvert after draft searches evict its payload", () => {
  const loaded = [feedItem(0)];
  const loadedIndex = new Map([[loaded[0].id, 0]]);
  const activeHits = Array.from({ length: 200 }, (_, index) => feedItem(index + 1_000));
  const cache = new Map();
  retainDetachedSearchItems(cache, activeHits, loadedIndex);
  for (let draft = 0; draft < 3; draft += 1) {
    retainDetachedSearchItems(
      cache,
      Array.from(
        { length: 200 },
        (_, index) => feedItem(2_000 + draft * 200 + index),
      ),
      loadedIndex,
    );
  }
  const target = activeHits[73];
  assert.equal(cache.size, MAX_DETACHED_SEARCH_ITEMS);
  assert.equal(cache.has(target.id), false, "draft lexical/hybrid queries evicted the active hit");

  const facadeState = appState(loaded);
  const renderedBefore = { ...facadeState, items: [...loaded, ...activeHits] };
  const store = new NormalizedAppStore();
  store.replace(renderedBefore);
  let itemSignals = 0;
  store.subscribeItem(target.id, () => itemSignals += 1);

  const applied = applyPatchToState(
    facadeState,
    itemPatch(8, [{
      kind: "itemsReadState",
      items: [{
        itemId: target.id,
        seenAt: "2026-07-16T10:00:00.000Z",
        openedAt: "2026-07-16T10:01:00.000Z",
      }],
    }]),
    loadedIndex,
    cache,
  );
  const delta = getAppStateItemDelta(applied.state);
  assert.deepEqual(delta?.itemUpserts, []);
  assert.deepEqual(delta?.itemReadStates, [{
    itemId: target.id,
    seenAt: "2026-07-16T10:00:00.000Z",
    openedAt: "2026-07-16T10:01:00.000Z",
  }]);
  assert.equal(applied.state.items.length, 1);

  const renderedAfter = inheritAppStateItemDelta(applied.state, {
    ...applied.state,
    items: [...applied.state.items, ...activeHits],
  });
  const change = store.replace(renderedAfter);
  assert.equal(change.onlyItemReadState, true);
  assert.equal(change.requiresRootProjection, false);
  assert.equal(store.getItem(target.id)?.seenAt, "2026-07-16T10:00:00.000Z");
  assert.equal(store.getItem(target.id)?.openedAt, "2026-07-16T10:01:00.000Z");
  assert.equal(itemSignals, 1);
  assert.equal(cache.size, MAX_DETACHED_SEARCH_ITEMS);
});

test("Tauri keeps one authorized preview and ignores readers and revoked previews", () => {
  const previewId = "draft:00000000-0000-4000-8000-000000000001";
  const bounds = { x: 1, y: 2, width: 320, height: 240 };
  const descriptors = normalizeTauriWebPanelDescriptors([
    {
      kind: "web",
      panelId: "00000000-0000-4000-8000-000000000002",
      url: "https://publication.example/home#live",
      bounds,
      visible: true,
    },
    { kind: "preview", panelId: previewId, bounds, visible: false },
    {
      kind: "reader",
      panelId: "reader:article",
      itemId: "00000000-0000-4000-8000-000000000003",
      bounds,
      visible: true,
    },
  ], new Map([[previewId, "https://preview.example/story#section"]]));

  assert.deepEqual(descriptors, [
    {
      panelId: "00000000-0000-4000-8000-000000000002",
      url: "https://publication.example/home#live",
      bounds,
      visible: true,
    },
    {
      panelId: previewId,
      url: "https://preview.example/story#section",
      bounds,
      visible: false,
    },
  ]);
  assert.deepEqual(
    normalizeTauriWebPanelDescriptors(
      [{ kind: "preview", panelId: previewId, bounds, visible: true }],
      new Map(),
    ),
    [],
  );
});

test("a scheduled-refresh hint stays renderer-local and non-serializable", () => {
  const state = { dashboard: { revision: 4 } };
  annotateScheduledRefresh(state, { sourceCount: 3 });
  assert.deepEqual(getScheduledRefreshHint(state), { sourceCount: 3 });
  assert.equal(JSON.stringify(state), '{"dashboard":{"revision":4}}');
  assert.equal(getScheduledRefreshHint({ ...state }), null);
});

test("Tauri preview authorization survives failure and serializes concurrent commit", async () => {
  const previews = new WebPreviewAuthorizations();
  const previewId = "draft:00000000-0000-4000-8000-000000000001";
  previews.start(previewId, "https://authorized.example/");

  await assert.rejects(
    previews.commit(previewId, async () => {
      throw new Error("writer failure");
    }),
    /writer failure/,
  );
  assert.deepEqual(previews.current(), {
    previewId,
    url: "https://authorized.example/",
  });

  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const first = previews.commit(previewId, async ({ url }) => {
    await gate;
    return url;
  });
  await assert.rejects(
    previews.commit(previewId, async () => "duplicate"),
    /déjà en cours/,
  );
  assert.equal(previews.cancel(previewId), null);
  release();
  assert.equal(await first, "https://authorized.example/");
  assert.equal(previews.current(), null);
  assert.equal(previews.urls().size, 0);
});

test("native web commands cannot overwrite the ordered Channel with invoke state", () => {
  const source = readFileSync(new URL("../src/tauri-client.ts", import.meta.url), "utf8");
  const body = source
    .split("async function runNativeWebPanelCommand(")[1]
    ?.split("\n  async function navigateWebPanel(")[0];
  assert.ok(body, "facade lifecycle command helper missing");
  assert.match(
    body,
    /await replaceWebPanelStateChannel\(\);\s+await invoke<void>\(command/,
  );
  assert.match(body, /await invoke<void>\(command/);
  assert.doesNotMatch(body, /parseWebPanelViewState|publishNativeWebState/);
  assert.match(body, /desiredWebPanelDescriptors/);
  assert.doesNotMatch(body, /queueWebPanelSync\(\[\.\.\.nativeWebDescriptors/);
  assert.match(source, /republishNativeWebState\(panelId\);/);
  assert.match(source, /webPanelRecoveryActive && !webPanelSyncRunning/);
});

test("web panel sync replaces a broken Channel without leaking its callback", () => {
  const source = readFileSync(new URL("../src/tauri-client.ts", import.meta.url), "utf8");
  const drain = source
    .split("async function drainWebPanelSync(")[1]
    ?.split("\n  function syncWebPanels(")[0];
  const replacement = source
    .split("function replaceWebPanelStateChannel(")[1]
    ?.split("\n\n  async function runNativeWebPanelCommand(")[0];
  assert.ok(drain, "native web reconciliation loop missing");
  assert.ok(replacement, "native web Channel replacement helper missing");
  assert.match(
    drain,
    /await replaceWebPanelStateChannel\(\);[\s\S]*invoke<unknown>\("sync_web_panels"/,
  );
  assert.match(replacement, /webPanelChannelInstallTail\.then/);
  assert.match(
    replacement,
    /await invoke<void>\("subscribe_web_panel_states", \{ channel \}\);[\s\S]*cleanupWebPanelChannel\(previousChannel\)/,
  );
  assert.match(replacement, /catch \(error\)[\s\S]*cleanupWebPanelChannel\(channel\)/);
  assert.doesNotMatch(replacement, /listen\(|emit\(/);
});

test("manual refresh retries only a nested Tauri revision conflict", () => {
  const conflict = new Error("Mutation Tauri", {
    cause: { code: "revision_conflict", message: "stale", retryable: true },
  });
  assert.equal(hasTauriErrorCode(conflict, "revision_conflict"), true);
  assert.equal(hasTauriErrorCode(conflict, "network_error"), false);
  assert.equal(hasTauriErrorCode(new Error("plain"), "revision_conflict"), false);
});

test("web panel order rejects stale transitions within one native generation", () => {
  const loading = { generation: 8, sequence: 12 };
  const ready = { generation: 8, sequence: 13 };
  const recreated = { generation: 9, sequence: 0 };
  assert.ok(compareWebPanelStateOrder(ready, loading) > 0);
  assert.ok(compareWebPanelStateOrder(loading, ready) < 0);
  assert.ok(compareWebPanelStateOrder(recreated, ready) > 0);
});
