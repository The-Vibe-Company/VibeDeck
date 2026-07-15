import assert from "node:assert/strict";
import test from "node:test";

import {
  abbreviateSourceName,
  compareFeedItems,
  formatCheckedAt,
  formatDayLabel,
  formatItemTime,
  formatNextRefresh,
  sourceHue,
  withDaySeparators,
} from "../src/feed-presentation.ts";

function item(overrides = {}) {
  const id = overrides.id ?? "item";
  return {
    id,
    sourceId: overrides.sourceId ?? "source",
    canonicalUrl: `https://example.test/${id}`,
    title: overrides.title ?? id,
    summary: null,
    imageUrl: null,
    publishedAt: null,
    updatedAt: null,
    firstSeenAt: "2026-07-10T12:00:00.000Z",
    observedAt: "2026-07-10T12:00:00.000Z",
    arrivalBatchAt: "2026-07-10T12:00:00.000Z",
    lastSeenAt: "2026-07-10T12:00:00.000Z",
    isBaseline: true,
    isNew: false,
    seenAt: "2026-07-10T12:00:00.000Z",
    openedAt: null,
    ...overrides,
  };
}

function source(overrides = {}) {
  return {
    id: "source",
    name: "Source",
    inputUrl: "https://example.test",
    feedUrl: "https://example.test/feed.xml",
    connectorId: null,
    connectorKind: "rss",
    refreshIntervalSeconds: 60,
    status: "healthy",
    lastCheckedAt: "2026-07-10T12:00:00.000Z",
    lastSuccessAt: "2026-07-10T12:00:00.000Z",
    errorMessage: null,
    baselineCompletedAt: "2026-07-10T12:00:00.000Z",
    consecutiveFailures: 0,
    nextRetryAt: null,
    itemCount: 0,
    ...overrides,
  };
}

test("interleaves baseline items by publication chronology across sources", () => {
  const items = [
    item({
      id: "baseline-b",
      sourceId: "source-b",
      publishedAt: "2026-07-10T11:30:00.000Z",
      observedAt: "2026-07-10T12:06:00.000Z",
    }),
    item({
      id: "baseline-a",
      sourceId: "source-a",
      publishedAt: "2026-07-10T12:00:00.000Z",
      observedAt: "2026-07-10T12:00:00.000Z",
    }),
    item({
      id: "baseline-c",
      sourceId: "source-c",
      updatedAt: "2026-07-10T11:45:00.000Z",
      observedAt: "2026-07-10T12:08:00.000Z",
    }),
  ];

  assert.deepEqual(items.sort(compareFeedItems).map(({ id }) => id), [
    "baseline-a",
    "baseline-c",
    "baseline-b",
  ]);
});

test("keeps later arrival batches ahead even when their publication is older", () => {
  const items = [
    item({ id: "baseline", publishedAt: "2026-07-10T12:30:00.000Z" }),
    item({
      id: "arrival-later",
      isBaseline: false,
      isNew: true,
      seenAt: null,
      publishedAt: "2020-01-01T00:00:00.000Z",
      firstSeenAt: "2026-07-10T12:10:00.000Z",
      observedAt: "2026-07-10T12:10:00.000Z",
      arrivalBatchAt: "2026-07-10T12:10:00.000Z",
    }),
    item({
      id: "arrival-earlier",
      isBaseline: false,
      isNew: true,
      seenAt: null,
      publishedAt: "2026-07-10T12:29:00.000Z",
      firstSeenAt: "2026-07-10T12:09:00.000Z",
      observedAt: "2026-07-10T12:09:00.000Z",
      arrivalBatchAt: "2026-07-10T12:09:00.000Z",
    }),
  ];

  assert.deepEqual(items.sort(compareFeedItems).map(({ id }) => id), [
    "arrival-later",
    "arrival-earlier",
    "baseline",
  ]);
});

test("interleaves sources within one arrival batch by publication chronology", () => {
  const items = [
    item({
      id: "source-a",
      sourceId: "source-a",
      isBaseline: false,
      publishedAt: "2026-07-10T11:30:00.000Z",
      observedAt: "2026-07-10T12:00:01.000Z",
      arrivalBatchAt: "2026-07-10T12:00:00.000Z",
    }),
    item({
      id: "source-b",
      sourceId: "source-b",
      isBaseline: false,
      publishedAt: "2026-07-10T11:45:00.000Z",
      observedAt: "2026-07-10T12:00:02.000Z",
      arrivalBatchAt: "2026-07-10T12:00:00.000Z",
    }),
  ];

  assert.deepEqual(items.sort(compareFeedItems).map(({ id }) => id), [
    "source-b",
    "source-a",
  ]);
});

test("falls through to the stable ID order when every timestamp is malformed", () => {
  const items = [
    item({
      id: "without-date-b",
      publishedAt: "not-a-date",
      updatedAt: null,
      observedAt: "not-a-date",
      arrivalBatchAt: "not-a-date",
      firstSeenAt: "not-a-date",
    }),
    item({
      id: "without-date-a",
      publishedAt: null,
      updatedAt: "not-a-date",
      observedAt: "not-a-date",
      arrivalBatchAt: "not-a-date",
      firstSeenAt: "not-a-date",
    }),
  ];

  assert.equal(Number.isNaN(compareFeedItems(items[0], items[1])), false);
  assert.deepEqual(items.sort(compareFeedItems).map(({ id }) => id), [
    "without-date-a",
    "without-date-b",
  ]);
});

test("renders an explicit calendar context after sixty minutes", () => {
  const now = new Date(2026, 6, 10, 14, 0, 0);
  const withPublishedAt = (publishedAt) => item({ publishedAt });

  assert.equal(
    formatItemTime(withPublishedAt(new Date(2026, 6, 10, 13, 30).toISOString()), now),
    "30 min",
  );
  assert.equal(
    formatItemTime(withPublishedAt(new Date(2026, 6, 10, 12, 30).toISOString()), now),
    "auj. 12:30",
  );
  assert.equal(
    formatItemTime(withPublishedAt(new Date(2026, 6, 9, 23, 10).toISOString()), now),
    "hier 23:10",
  );
  assert.equal(
    formatItemTime(withPublishedAt(new Date(2026, 6, 8, 9, 5).toISOString()), now),
    "08/07 09:05",
  );
  assert.equal(
    formatCheckedAt(new Date(2026, 6, 9, 23, 10).toISOString(), now),
    "hier 23:10",
  );
});

test("derives a stable identity hue per source", () => {
  assert.equal(sourceHue("source-a"), sourceHue("source-a"));
  for (const seed of ["source-a", "source-b", "", "https://example.test/feed.xml"]) {
    const hue = sourceHue(seed);
    assert.equal(Number.isInteger(hue), true);
    assert.equal(hue >= 0 && hue < 360, true);
  }
  assert.notEqual(sourceHue("source-a"), sourceHue("source-b"));
});

test("abbreviates source names to two letters", () => {
  assert.equal(abbreviateSourceName("Le Monde"), "LM");
  assert.equal(abbreviateSourceName("L’Équipe"), "LÉ");
  assert.equal(abbreviateSourceName("L'Équipe"), "LÉ");
  assert.equal(abbreviateSourceName("Libération"), "LI");
  assert.equal(abbreviateSourceName("franceinfo"), "FR");
  assert.equal(abbreviateSourceName("France 24"), "F2");
  assert.equal(abbreviateSourceName(""), "—");
  assert.equal(abbreviateSourceName("  ·  "), "—");
});

test("labels feed days relative to today", () => {
  const now = new Date(2026, 6, 13, 14, 0, 0);

  assert.equal(formatDayLabel(new Date(2026, 6, 13, 9, 0), now), "AUJOURD’HUI");
  assert.equal(formatDayLabel(new Date(2026, 6, 12, 23, 30), now), "HIER · DIM 12 JUIL");
  assert.equal(formatDayLabel(new Date(2026, 6, 8, 9, 5), now), "MER 8 JUIL");
  assert.equal(formatDayLabel(new Date(2024, 11, 24, 9, 5), now), "MAR 24 DÉC 2024");
});

test("inserts a day separator at every day change, tolerating non-monotonic dates", () => {
  const now = new Date(2026, 6, 13, 14, 0, 0);
  const items = [
    // Arrivée remontée en tête malgré une date d'hier.
    item({ id: "arrival", isBaseline: false, publishedAt: new Date(2026, 6, 12, 22, 0).toISOString() }),
    item({ id: "today-1", publishedAt: new Date(2026, 6, 13, 10, 0).toISOString() }),
    item({ id: "today-2", publishedAt: new Date(2026, 6, 13, 9, 0).toISOString() }),
    // Sans date : hérite du jour courant, aucun séparateur.
    item({ id: "undated", publishedAt: null, updatedAt: null }),
    item({ id: "yesterday", publishedAt: new Date(2026, 6, 12, 23, 0).toISOString() }),
  ];

  const rows = withDaySeparators(items, now);
  assert.deepEqual(
    rows.map((row) => (row.kind === "separator" ? `[${row.label}]` : row.item.id)),
    [
      "[HIER · DIM 12 JUIL]",
      "arrival",
      "[AUJOURD’HUI]",
      "today-1",
      "today-2",
      "undated",
      "[HIER · DIM 12 JUIL]",
      "yesterday",
    ],
  );

  const keys = rows.filter((row) => row.kind === "separator").map((row) => row.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(withDaySeparators([], now), []);
});

test("formats the nearest scheduler refresh with retry and active states", () => {
  const now = new Date("2026-07-10T12:00:00.000Z");

  assert.deepEqual(
    formatNextRefresh([source({ lastCheckedAt: "2026-07-10T11:59:30.000Z" })], now),
    { full: "mise à jour dans 30 s", compact: "màj 00:30" },
  );
  assert.deepEqual(
    formatNextRefresh([
      source({ lastCheckedAt: "2026-07-10T11:55:00.000Z" }),
      source({ id: "retry", nextRetryAt: "2026-07-10T12:02:05.000Z" }),
    ], now),
    { full: "imminente", compact: "immin." },
  );
  assert.deepEqual(
    formatNextRefresh([source({ nextRetryAt: "2026-07-10T12:12:34.000Z" })], now),
    { full: "réessai dans 12 min 34 s", compact: "réessai 12:34" },
  );
  assert.deepEqual(
    formatNextRefresh([source({ status: "refreshing" })], now),
    { full: "actualisation…", compact: "actualisation…" },
  );
  assert.deepEqual(
    formatNextRefresh([source({ lastCheckedAt: "date invalide", nextRetryAt: "date invalide" })], now),
    { full: "imminente", compact: "immin." },
  );
});
