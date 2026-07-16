import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createLocalFeedDatabase } from "../../electron/database.mjs";

export const PERF_SOURCE_COUNT = 50;
export const PERF_ITEMS_PER_SOURCE = 500;
export const PERF_ITEM_COUNT = PERF_SOURCE_COUNT * PERF_ITEMS_PER_SOURCE;
export const PERF_PANEL_ID = "perf-feed";

const FIXTURE_AT = "2099-01-01T00:00:00.000Z";
const PUBLICATION_EPOCH = Date.parse("2026-07-15T08:00:00.000Z");

function sourceId(index) {
  return `perf-source-${String(index).padStart(2, "0")}`;
}

function itemId(sourceIndex, itemIndex) {
  return `perf-item-${String(sourceIndex).padStart(2, "0")}-${String(itemIndex).padStart(3, "0")}`;
}

function performanceSources() {
  return Array.from({ length: PERF_SOURCE_COUNT }, (_, index) => {
    const id = sourceId(index);
    const feedUrl = `https://${id}.invalid/feed.xml`;
    return {
      id,
      name: `Source performance ${String(index + 1).padStart(2, "0")}`,
      inputUrl: feedUrl,
      feedUrl,
      connectorId: null,
      connectorKind: "rss",
      refreshIntervalSeconds: 3_600,
    };
  });
}

function performanceItems(sourceIndex) {
  return Array.from({ length: PERF_ITEMS_PER_SOURCE }, (_, itemIndex) => {
    const id = itemId(sourceIndex, itemIndex);
    const globalIndex = itemIndex * PERF_SOURCE_COUNT + sourceIndex;
    const timestamp = new Date(PUBLICATION_EPOCH - globalIndex * 1_000).toISOString();
    return {
      id,
      canonicalUrl: `https://${sourceId(sourceIndex)}.invalid/articles/${id}`,
      title: `Article performance ${String(globalIndex + 1).padStart(5, "0")} — titre de veille représentatif`,
      summary: `Résumé déterministe de l’article ${id}, assez long pour exercer le layout du fil.`,
      imageUrl: null,
      publishedAt: timestamp,
      updatedAt: timestamp,
      firstSeenAt: FIXTURE_AT,
    };
  });
}

/**
 * Creates a fresh, logically deterministic dashboard through the production
 * persistence API. The future last-check timestamp keeps the startup scheduler
 * offline while the harness is running; every URL uses the reserved .invalid
 * TLD as a second fail-closed guard.
 */
export function seedPerformanceDatabase(databasePath) {
  const sources = performanceSources();
  const database = createLocalFeedDatabase(databasePath, { usageTimeZone: "UTC" });
  try {
    database.importDashboardConfig({
      format: "vibedeck-dashboard",
      version: 1,
      layout: { type: "panel", panelId: PERF_PANEL_ID },
      panels: [{
        id: PERF_PANEL_ID,
        kind: "feed",
        name: "Charge performance — 25 000 articles",
        defaultRefreshIntervalSeconds: 3_600,
        sourceIds: sources.map(({ id }) => id),
      }],
      sources,
    }, FIXTURE_AT);

    for (let sourceIndex = 0; sourceIndex < PERF_SOURCE_COUNT; sourceIndex += 1) {
      const id = sourceId(sourceIndex);
      const result = database.upsertItems(
        id,
        performanceItems(sourceIndex),
        FIXTURE_AT,
        FIXTURE_AT,
      );
      assert.equal(result.insertedCount, PERF_ITEMS_PER_SOURCE);
      assert.equal(result.isInitialImport, true);
      database.setSourceStatus(id, "healthy", {
        lastCheckedAt: FIXTURE_AT,
        lastSuccessAt: FIXTURE_AT,
        errorMessage: null,
        consecutiveFailures: 0,
        nextRetryAt: null,
      }, FIXTURE_AT);
    }
  } finally {
    database.close();
  }

  const verification = new DatabaseSync(databasePath);
  try {
    const counts = verification.prepare(`
      SELECT
        (SELECT COUNT(*) FROM panels) AS panels,
        (SELECT COUNT(*) FROM sources) AS sources,
        (SELECT COUNT(*) FROM items) AS items,
        (SELECT COUNT(*) FROM panel_sources) AS attachments
    `).get();
    assert.deepEqual(
      {
        panels: Number(counts.panels),
        sources: Number(counts.sources),
        items: Number(counts.items),
        attachments: Number(counts.attachments),
      },
      {
        panels: 1,
        sources: PERF_SOURCE_COUNT,
        items: PERF_ITEM_COUNT,
        attachments: PERF_SOURCE_COUNT,
      },
      "La fixture de performance doit contenir exactement la charge annoncée.",
    );
    verification.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } finally {
    verification.close();
  }
}
