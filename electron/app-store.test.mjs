import assert from "node:assert/strict";
import test from "node:test";

import { annotateAppStateItemDelta } from "../src/app-state-delta.ts";
import { NormalizedAppStore } from "../src/app-store.ts";
import { compareFeedItems } from "../src/feed-presentation.ts";

const PANEL_ID = "00000000-0000-4000-8000-000000000001";
const SOURCE_ID = "00000000-0000-4000-8000-000000000002";

function item(index) {
  const suffix = String(index).padStart(12, "0");
  return {
    id: `00000000-0000-4000-8001-${suffix}`,
    sourceId: SOURCE_ID,
    canonicalUrl: `https://example.test/articles/${index}`,
    title: `Article ${index}`,
    summary: null,
    imageUrl: null,
    publishedAt: `2026-07-15T10:${String(index % 60).padStart(2, "0")}:00.000Z`,
    updatedAt: null,
    firstSeenAt: "2026-07-15T10:00:00.000Z",
    observedAt: "2026-07-15T10:00:00.000Z",
    arrivalBatchAt: "2026-07-15T10:00:00.000Z",
    lastSeenAt: "2026-07-15T10:00:00.000Z",
    isBaseline: true,
    isNew: false,
    seenAt: null,
    openedAt: null,
  };
}

function state(items, revision = 0) {
  return {
    dashboard: {
      layout: { type: "panel", panelId: PANEL_ID },
      revision,
    },
    panels: [{
      kind: "feed",
      id: PANEL_ID,
      name: "Fil",
      sourceIds: [SOURCE_ID],
      defaultRefreshIntervalSeconds: 60,
    }],
    sources: [{
      id: SOURCE_ID,
      name: "Source",
      inputUrl: "https://example.test/feed.xml",
      feedUrl: "https://example.test/feed.xml",
      connectorId: null,
      connectorKind: "rss",
      refreshIntervalSeconds: 60,
      status: "healthy",
      lastCheckedAt: null,
      lastSuccessAt: null,
      errorMessage: null,
      baselineCompletedAt: null,
      consecutiveFailures: 0,
      nextRetryAt: null,
      dueAtMs: 0,
      itemCount: items.length,
    }],
    sourceCatalog: [],
    items,
    refreshedAt: "2026-07-15T10:00:00.000Z",
  };
}

test("a bounded read-state delta does not scan or invalidate a 25k panel", () => {
  const store = new NormalizedAppStore();
  const items = Array.from({ length: 25_000 }, (_, index) => item(index));
  const initial = state(items);
  store.replace(initial);
  const panelSnapshot = store.getFeedPanelSnapshot(PANEL_ID);
  assert.equal(store.getFeedPanelReadSnapshot(PANEL_ID).unseenCount, 25_000);

  let panelSignals = 0;
  let readSignals = 0;
  let itemSignals = 0;
  const target = { ...items[12_345], seenAt: "2026-07-15T11:00:00.000Z" };
  store.subscribePanel(PANEL_ID, () => panelSignals += 1);
  store.subscribePanelRead(PANEL_ID, () => readSignals += 1);
  store.subscribeItem(target.id, () => itemSignals += 1);

  const nextItems = [...items];
  nextItems[12_345] = target;
  let numericReads = 0;
  const guardedItems = new Proxy(nextItems, {
    get(targetArray, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) numericReads += 1;
      if (property === Symbol.iterator) {
        throw new Error("the bounded delta must not iterate the compatibility item array");
      }
      return Reflect.get(targetArray, property, receiver);
    },
  });
  const next = annotateAppStateItemDelta({
    ...initial,
    dashboard: { ...initial.dashboard, revision: 1 },
    items: guardedItems,
  }, { itemUpserts: [target] });

  const change = store.replace(next);
  assert.equal(numericReads, 0);
  assert.equal(change.onlyItemReadState, true);
  assert.equal(change.requiresRootProjection, false);
  assert.equal(panelSignals, 0);
  assert.equal(readSignals, 1);
  assert.equal(itemSignals, 1);
  assert.equal(store.getFeedPanelSnapshot(PANEL_ID), panelSnapshot);
  assert.equal(store.getItem(target.id)?.seenAt, target.seenAt);
  assert.equal(store.getFeedPanelReadSnapshot(PANEL_ID).unseenCount, 24_999);
});

test("source-only and bounded arrival patches stay incremental across shared panels", () => {
  const secondPanelId = "00000000-0000-4000-8000-000000000003";
  const isolatedPanelId = "00000000-0000-4000-8000-000000000004";
  const isolatedSourceId = "00000000-0000-4000-8000-000000000005";
  const sharedItems = Array.from({ length: 25_000 }, (_, index) => item(index));
  const isolatedItem = {
    ...item(25_001),
    sourceId: isolatedSourceId,
  };
  const rawItems = [...sharedItems, isolatedItem];
  let numericReads = 0;
  let iteratorReads = 0;
  let forEachReads = 0;
  const instrumentedItems = new Proxy(rawItems, {
    get(targetArray, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) numericReads += 1;
      if (property === Symbol.iterator) iteratorReads += 1;
      if (property === "forEach") forEachReads += 1;
      return Reflect.get(targetArray, property, receiver);
    },
  });
  const seed = state(instrumentedItems);
  const sharedSource = { ...seed.sources[0], itemCount: sharedItems.length };
  const isolatedSource = {
    ...sharedSource,
    id: isolatedSourceId,
    name: "Source isolée",
    inputUrl: "https://isolated.example.test/feed.xml",
    feedUrl: "https://isolated.example.test/feed.xml",
    itemCount: 1,
  };
  const initial = {
    ...seed,
    dashboard: {
      layout: {
        type: "split",
        id: "split-root",
        direction: "row",
        ratio: 0.5,
        children: [
          { type: "panel", panelId: PANEL_ID },
          {
            type: "split",
            id: "split-side",
            direction: "column",
            ratio: 0.5,
            children: [
              { type: "panel", panelId: secondPanelId },
              { type: "panel", panelId: isolatedPanelId },
            ],
          },
        ],
      },
      revision: 0,
    },
    panels: [
      seed.panels[0],
      { ...seed.panels[0], id: secondPanelId, name: "Fil partagé" },
      {
        ...seed.panels[0],
        id: isolatedPanelId,
        name: "Fil isolé",
        sourceIds: [isolatedSourceId],
      },
    ],
    sources: [sharedSource, isolatedSource],
  };

  const store = new NormalizedAppStore();
  store.replace(initial);
  const firstSharedSnapshot = store.getFeedPanelSnapshot(PANEL_ID);
  const secondSharedSnapshot = store.getFeedPanelSnapshot(secondPanelId);
  const isolatedSnapshot = store.getFeedPanelSnapshot(isolatedPanelId);
  const firstReadSnapshot = store.getFeedPanelReadSnapshot(PANEL_ID);
  const secondReadSnapshot = store.getFeedPanelReadSnapshot(secondPanelId);
  assert.equal(firstReadSnapshot.unseenCount, 25_000);
  assert.equal(secondReadSnapshot.unseenCount, 25_000);

  const panelSignals = new Map([[PANEL_ID, 0], [secondPanelId, 0], [isolatedPanelId, 0]]);
  const readSignals = new Map([[PANEL_ID, 0], [secondPanelId, 0], [isolatedPanelId, 0]]);
  for (const panelId of panelSignals.keys()) {
    store.subscribePanel(panelId, () => panelSignals.set(panelId, panelSignals.get(panelId) + 1));
    store.subscribePanelRead(panelId, () => readSignals.set(panelId, readSignals.get(panelId) + 1));
  }

  numericReads = 0;
  iteratorReads = 0;
  forEachReads = 0;
  store.resetInstrumentation();
  const refreshingSource = { ...sharedSource, status: "refreshing" };
  const sourceOnly = {
    ...initial,
    dashboard: { ...initial.dashboard, revision: 1 },
    sources: [refreshingSource, isolatedSource],
  };
  const sourceChange = store.replace(sourceOnly);
  assert.equal(numericReads, 0);
  assert.equal(iteratorReads, 0);
  assert.equal(forEachReads, 0);
  assert.deepEqual([...sourceChange.changedPanelIds].sort(), [PANEL_ID, secondPanelId].sort());
  assert.deepEqual([...sourceChange.changedDomains].sort(), ["revision", "sources"]);
  const sourceInstrumentation = store.getInstrumentation();
  assert.equal(sourceInstrumentation.fullItemNormalizationPasses, 0);
  assert.equal(sourceInstrumentation.fullItemEntitiesScanned, 0);
  assert.equal(sourceInstrumentation.panelSnapshotFullBuilds, 0);
  assert.equal(panelSignals.get(PANEL_ID), 1);
  assert.equal(panelSignals.get(secondPanelId), 1);
  assert.equal(panelSignals.get(isolatedPanelId), 0);
  assert.equal(readSignals.get(PANEL_ID), 0);
  assert.equal(readSignals.get(secondPanelId), 0);
  assert.equal(store.getFeedPanelReadSnapshot(PANEL_ID), firstReadSnapshot);
  assert.equal(store.getFeedPanelReadSnapshot(secondPanelId), secondReadSnapshot);
  const sourceOnlyFirst = store.getFeedPanelSnapshot(PANEL_ID);
  const sourceOnlySecond = store.getFeedPanelSnapshot(secondPanelId);
  assert.equal(sourceOnlyFirst.items, firstSharedSnapshot.items);
  assert.equal(sourceOnlySecond.items, secondSharedSnapshot.items);
  assert.equal(sourceOnlyFirst.sources[0], refreshingSource);
  assert.equal(sourceOnlySecond.sources[0], refreshingSource);
  assert.equal(store.getFeedPanelSnapshot(isolatedPanelId), isolatedSnapshot);

  const arrival = {
    ...item(25_002),
    title: "Arrivée",
    publishedAt: "2026-07-15T12:00:00.000Z",
    firstSeenAt: "2026-07-15T12:00:00.000Z",
    observedAt: "2026-07-15T12:00:00.000Z",
    arrivalBatchAt: "2026-07-15T12:00:00.000Z",
    lastSeenAt: "2026-07-15T12:00:00.000Z",
    isBaseline: false,
    isNew: true,
  };
  let deltaNumericReads = 0;
  const guardedArrivalItems = new Proxy([...rawItems, arrival], {
    get(targetArray, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) deltaNumericReads += 1;
      if (property === Symbol.iterator) {
        throw new Error("a bounded arrival must not iterate the compatibility item array");
      }
      return Reflect.get(targetArray, property, receiver);
    },
  });
  const settledSource = { ...refreshingSource, status: "healthy", itemCount: 25_001 };
  const arrivalState = annotateAppStateItemDelta({
    ...sourceOnly,
    dashboard: { ...sourceOnly.dashboard, revision: 2 },
    sources: [settledSource, isolatedSource],
    items: guardedArrivalItems,
  }, { itemUpserts: [arrival] });
  for (const panelId of panelSignals.keys()) {
    panelSignals.set(panelId, 0);
    readSignals.set(panelId, 0);
  }
  store.resetInstrumentation();

  const arrivalChange = store.replace(arrivalState);
  assert.equal(deltaNumericReads, 0);
  assert.equal(arrivalChange.itemMembershipChanged, true);
  assert.deepEqual([...arrivalChange.changedPanelIds].sort(), [PANEL_ID, secondPanelId].sort());
  assert.deepEqual([...arrivalChange.changedDomains].sort(), ["items", "revision", "sources"]);
  const arrivalInstrumentation = store.getInstrumentation();
  assert.equal(arrivalInstrumentation.fullItemNormalizationPasses, 0);
  assert.equal(arrivalInstrumentation.fullItemEntitiesScanned, 0);
  assert.equal(arrivalInstrumentation.panelSnapshotFullBuilds, 0);
  assert.equal(arrivalInstrumentation.panelSnapshotBatchMerges, 2);
  assert.equal(arrivalInstrumentation.panelSnapshotItemsScanned, 50_000);
  assert.equal(arrivalInstrumentation.panelSnapshotItemsWritten, 50_002);
  const arrivedFirst = store.getFeedPanelSnapshot(PANEL_ID);
  const arrivedSecond = store.getFeedPanelSnapshot(secondPanelId);
  assert.equal(arrivedFirst.items.length, 25_001);
  assert.equal(arrivedSecond.items.length, 25_001);
  assert.equal(arrivedFirst.items[0], arrival);
  assert.equal(arrivedSecond.items[0], arrival);
  assert.equal(
    arrivedFirst.items.slice(1).every((candidate, index) => candidate === sourceOnlyFirst.items[index]),
    true,
  );
  assert.equal(
    arrivedSecond.items.slice(1).every((candidate, index) => candidate === sourceOnlySecond.items[index]),
    true,
  );
  assert.equal(arrivedFirst.sources[0], settledSource);
  assert.equal(arrivedSecond.sources[0], settledSource);
  assert.equal(store.getFeedPanelSnapshot(isolatedPanelId), isolatedSnapshot);
  assert.equal(store.getFeedPanelReadSnapshot(PANEL_ID).unseenCount, 25_001);
  assert.equal(store.getFeedPanelReadSnapshot(secondPanelId).unseenCount, 25_001);
  assert.equal(store.getInstrumentation().panelSnapshotFullBuilds, 0);
  assert.equal(panelSignals.get(PANEL_ID), 1);
  assert.equal(panelSignals.get(secondPanelId), 1);
  assert.equal(panelSignals.get(isolatedPanelId), 0);
  assert.equal(readSignals.get(PANEL_ID), 1);
  assert.equal(readSignals.get(secondPanelId), 1);
  assert.equal(readSignals.get(isolatedPanelId), 0);
});

test("a 200-item delta merges a 25k panel exactly once in final sort order", () => {
  const store = new NormalizedAppStore();
  const items = Array.from({ length: 25_000 }, (_, index) => item(index));
  const initial = state(items);
  store.replace(initial);
  const before = store.getFeedPanelSnapshot(PANEL_ID);
  assert.equal(before.items.length, 25_000);

  const arrivals = Array.from({ length: 200 }, (_, index) => ({
    ...item(25_100 + index),
    title: `Arrivée ${index}`,
    publishedAt: `2026-${String((index % 12) + 1).padStart(2, "0")}-${String((index % 28) + 1).padStart(2, "0")}T12:00:00.000Z`,
    firstSeenAt: "2026-07-16T12:00:00.000Z",
    observedAt: "2026-07-16T12:00:00.000Z",
    arrivalBatchAt: "2026-07-16T12:00:00.000Z",
    lastSeenAt: "2026-07-16T12:00:00.000Z",
    isBaseline: false,
    isNew: true,
  }));
  let numericReads = 0;
  const guardedItems = new Proxy([...items, ...arrivals], {
    get(targetArray, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) numericReads += 1;
      if (property === Symbol.iterator) {
        throw new Error("a bounded batch must not iterate the compatibility item array");
      }
      return Reflect.get(targetArray, property, receiver);
    },
  });
  const next = annotateAppStateItemDelta({
    ...initial,
    dashboard: { ...initial.dashboard, revision: 1 },
    sources: [{ ...initial.sources[0], itemCount: 25_200 }],
    items: guardedItems,
  }, { itemUpserts: arrivals });

  store.resetInstrumentation();
  const change = store.replace(next);
  const instrumentation = store.getInstrumentation();
  const after = store.getFeedPanelSnapshot(PANEL_ID);

  assert.equal(numericReads, 0);
  assert.equal(change.changedItemIds.size, 200);
  assert.equal(change.itemMembershipChanged, true);
  assert.equal(instrumentation.fullItemNormalizationPasses, 0);
  assert.equal(instrumentation.fullItemEntitiesScanned, 0);
  assert.equal(instrumentation.panelSnapshotFullBuilds, 0);
  assert.equal(instrumentation.panelSnapshotBatchMerges, 1);
  assert.equal(instrumentation.panelSnapshotItemsScanned, 25_000);
  assert.equal(instrumentation.panelSnapshotItemsWritten, 25_200);
  assert.equal(after.items.length, 25_200);
  for (let index = 1; index < after.items.length; index += 1) {
    assert.equal(compareFeedItems(after.items[index - 1], after.items[index]) <= 0, true);
  }
  const itemsById = new Map(after.items.map((candidate) => [candidate.id, candidate]));
  for (const arrival of arrivals) assert.equal(itemsById.get(arrival.id), arrival);
  for (const existing of before.items) assert.equal(itemsById.get(existing.id), existing);
});
