import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { createLocalFeedDatabase } from "../electron/database.mjs";

const ITEMS_PER_SOURCE = 2_000;
const SHARED_SOURCE_COUNT = 20;
const PRIVATE_SOURCE_COUNT = 5;
const PANEL_COUNT = 4;
const EXPECTED_ITEMS_PER_PANEL = 50_000;

const directory = await mkdtemp(path.join(os.tmpdir(), "vibedeck-large-feed-"));
const databasePath = path.join(directory, "vibedeck.sqlite3");
const database = createLocalFeedDatabase(databasePath);
const seededAt = "2026-07-16T12:00:00.000Z";

function putSource(sourceId, sourceOrdinal) {
  database.putSource({
    id: sourceId,
    name: `Source ${sourceOrdinal}`,
    inputUrl: `https://${sourceId}.test/feed.xml`,
    feedUrl: `https://${sourceId}.test/feed.xml`,
    connectorId: null,
    connectorKind: "rss",
    refreshIntervalSeconds: 60,
    status: "healthy",
    lastCheckedAt: seededAt,
    lastSuccessAt: seededAt,
    errorMessage: null,
  }, seededAt);
  const items = Array.from({ length: ITEMS_PER_SOURCE }, (_, itemOrdinal) => {
    const publishedAt = new Date(
      Date.parse(seededAt) - (sourceOrdinal * ITEMS_PER_SOURCE + itemOrdinal) * 1_000,
    ).toISOString();
    return {
      id: `${sourceId}-item-${String(itemOrdinal).padStart(4, "0")}`,
      canonicalUrl: `https://${sourceId}.test/articles/${itemOrdinal}`,
      title: `Article ${sourceOrdinal}-${itemOrdinal}`,
      summary: itemOrdinal % 3 === 0 ? `Résumé multilingue contrôlé ${itemOrdinal}` : null,
      imageUrl: null,
      publishedAt: itemOrdinal % 19 === 0 ? null : publishedAt,
      updatedAt: itemOrdinal % 19 === 0 ? publishedAt : null,
    };
  });
  database.upsertItems(sourceId, items, seededAt);
}

try {
  const panels = [];
  panels.push(database.createPanel({ kind: "feed", name: "Charge 1" }, null, seededAt));
  panels.push(database.createPanel(
    { kind: "feed", name: "Charge 2" },
    { targetPanelId: panels[0].id, side: "right" },
    seededAt,
  ));
  panels.push(database.createPanel(
    { kind: "feed", name: "Charge 3" },
    { targetPanelId: panels[0].id, side: "bottom" },
    seededAt,
  ));
  panels.push(database.createPanel(
    { kind: "feed", name: "Charge 4" },
    { targetPanelId: panels[1].id, side: "bottom" },
    seededAt,
  ));
  assert.equal(panels.length, PANEL_COUNT);

  let sourceOrdinal = 0;
  const sharedSourceIds = Array.from({ length: SHARED_SOURCE_COUNT }, (_, index) =>
    `load-shared-${String(index).padStart(2, "0")}`);
  for (const sourceId of sharedSourceIds) {
    putSource(sourceId, sourceOrdinal++);
    for (const panel of panels) database.attachSource(panel.id, sourceId);
  }
  for (const [panelIndex, panel] of panels.entries()) {
    for (let index = 0; index < PRIVATE_SOURCE_COUNT; index += 1) {
      const sourceId = `load-private-${panelIndex}-${index}`;
      putSource(sourceId, sourceOrdinal++);
      database.attachSource(panel.id, sourceId);
    }
  }

  const deepPageDurations = [];
  for (const panel of panels) {
    const startedAt = performance.now();
    const page = database.getFeedPage({
      panelId: panel.id,
      sourceFilter: "all",
      visibilityFilter: "all",
      offset: 49_800,
      limit: 200,
    });
    deepPageDurations.push(performance.now() - startedAt);
    assert.equal(page.queryTotalCount, EXPECTED_ITEMS_PER_PANEL);
    assert.equal(page.panelTotalCount, EXPECTED_ITEMS_PER_PANEL);
    assert.equal(page.items.length, 200);
    assert.equal(new Set(page.items.map(({ id }) => id)).size, 200);
    assert.equal(page.offset, 49_800);
    assert.ok(page.previousItemDate);
  }

  const totalPhysicalItems = Number(
    database.database.prepare("SELECT COUNT(*) AS count FROM items").get().count,
  );
  assert.equal(totalPhysicalItems, 80_000);
  assert.ok(
    deepPageDurations.every((duration) => duration < 2_000),
    `Un saut profond a dépassé 2 s : ${deepPageDurations.map((value) => value.toFixed(1)).join(", ")} ms`,
  );
  console.log(
    `✓ charge SQLite: 4 panels × 50 000 lignes, 80 000 articles physiques, ` +
    `sauts profonds ${deepPageDurations.map((value) => value.toFixed(1)).join(" / ")} ms`,
  );
} finally {
  database.close();
  await rm(directory, { recursive: true, force: true });
}
