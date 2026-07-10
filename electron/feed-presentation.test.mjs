import assert from "node:assert/strict";
import test from "node:test";

import {
  compareFeedItems,
  formatCheckedAt,
  formatItemTime,
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
    lastSeenAt: "2026-07-10T12:00:00.000Z",
    isBaseline: true,
    isNew: false,
    seenAt: "2026-07-10T12:00:00.000Z",
    openedAt: null,
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

test("keeps post-baseline arrivals ahead by immutable detection time", () => {
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
    }),
    item({
      id: "arrival-earlier",
      isBaseline: false,
      isNew: true,
      seenAt: null,
      publishedAt: "2026-07-10T12:29:00.000Z",
      firstSeenAt: "2026-07-10T12:09:00.000Z",
      observedAt: "2026-07-10T12:09:00.000Z",
    }),
  ];

  assert.deepEqual(items.sort(compareFeedItems).map(({ id }) => id), [
    "arrival-later",
    "arrival-earlier",
    "baseline",
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
