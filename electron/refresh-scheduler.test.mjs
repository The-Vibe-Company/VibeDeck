import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createRefreshScheduler,
  millisecondsUntilSourceIsDue,
  sourceIsDue,
} from "./refresh-scheduler.mjs";

const NOW = Date.parse("2026-07-10T12:00:00.000Z");

test("selects fresh, due, backed-off and malformed source dates correctly", () => {
  const base = { status: "healthy", refreshIntervalSeconds: 60, nextRetryAt: null };
  assert.equal(sourceIsDue({ ...base, lastCheckedAt: null }, NOW), true);
  assert.equal(
    sourceIsDue({ ...base, lastCheckedAt: "2026-07-10T11:59:30.001Z" }, NOW),
    false,
  );
  assert.equal(
    sourceIsDue({ ...base, lastCheckedAt: "2026-07-10T11:58:59.999Z" }, NOW),
    true,
  );
  assert.equal(sourceIsDue({ ...base, lastCheckedAt: "date-invalide" }, NOW), true);
  assert.equal(
    sourceIsDue({ ...base, lastCheckedAt: null, nextRetryAt: "2026-07-10T12:01:00.000Z" }, NOW),
    false,
  );
  assert.equal(sourceIsDue({ ...base, status: "refreshing", lastCheckedAt: null }, NOW), false);
});

test("arms the next pass on the nearest persisted source deadline", () => {
  const sources = [
    {
      id: "later",
      status: "healthy",
      refreshIntervalSeconds: 300,
      lastCheckedAt: "2026-07-10T11:59:00.000Z",
      nextRetryAt: null,
    },
    {
      id: "nearest",
      status: "error",
      refreshIntervalSeconds: 300,
      lastCheckedAt: "2026-07-10T11:59:00.000Z",
      nextRetryAt: "2026-07-10T12:00:12.000Z",
    },
  ];
  assert.equal(millisecondsUntilSourceIsDue(sources[0], NOW), 240_000);
  assert.equal(millisecondsUntilSourceIsDue(sources[1], NOW), 12_000);

  const scheduler = createRefreshScheduler({
    now: () => NOW,
    getSources: () => sources,
    refreshSources: async () => undefined,
  });
  assert.equal(scheduler.nextDelay(), 12_000);
  assert.equal(scheduler.nextDelay({ maximumMs: 5_000 }), 5_000);
  sources[1].nextRetryAt = null;
  sources[1].lastCheckedAt = null;
  assert.equal(scheduler.nextDelay(), 250);
  scheduler.stop();
});

test("coalesces concurrent automatic passes and broadcasts start and completion", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  let broadcasts = 0;
  const scheduler = createRefreshScheduler({
    now: () => NOW,
    getSources: () => [
      { id: "due", status: "healthy", refreshIntervalSeconds: 60, lastCheckedAt: null },
      { id: "also-due", status: "healthy", refreshIntervalSeconds: 60, lastCheckedAt: null },
      {
        id: "fresh",
        status: "healthy",
        refreshIntervalSeconds: 60,
        lastCheckedAt: "2026-07-10T11:59:45.000Z",
      },
    ],
    refreshSources: async (sourceIds, options) => {
      calls.push({ sourceIds, options });
      await gate;
    },
    onStateChange: () => {
      broadcasts += 1;
    },
  });

  const first = scheduler.run();
  const second = scheduler.run();
  assert.equal(first, second);
  assert.deepEqual(calls, [
    {
      sourceIds: ["due", "also-due"],
      options: { arrivalBatchAt: "2026-07-10T12:00:00.000Z" },
    },
  ]);
  assert.equal(broadcasts, 1);
  release();
  await first;
  assert.equal(broadcasts, 2);
  assert.equal(scheduler.pending(), null);
  scheduler.stop();
  await scheduler.run();
  assert.deepEqual(calls, [
    {
      sourceIds: ["due", "also-due"],
      options: { arrivalBatchAt: "2026-07-10T12:00:00.000Z" },
    },
  ]);
});

test("creates a distinct arrival batch for each completed scheduler pass", async () => {
  const batches = [];
  let batchTimestamp = NOW;
  const scheduler = createRefreshScheduler({
    now: () => NOW,
    createArrivalBatchAt: () => new Date(batchTimestamp++).toISOString(),
    getSources: () => [
      { id: "due", status: "healthy", refreshIntervalSeconds: 60, lastCheckedAt: null },
    ],
    refreshSources: async (_sourceIds, { arrivalBatchAt }) => {
      batches.push(arrivalBatchAt);
    },
  });

  await scheduler.run();
  await scheduler.run();
  scheduler.stop();
  assert.deepEqual(batches, [
    "2026-07-10T12:00:00.000Z",
    "2026-07-10T12:00:00.001Z",
  ]);
});

test("re-arms the one-shot timer after every authoritative state broadcast", async () => {
  const source = await readFile(new URL("./main.mjs", import.meta.url), "utf8");
  const broadcastBody = source.match(
    /function broadcastState\([\s\S]*?\n}\n\nfunction broadcastSemanticSearchStatus/,
  )?.[0];

  assert.ok(broadcastBody, "broadcastState must remain inspectable by the scheduler regression test");
  assert.match(broadcastBody, /scheduleRefreshTimer\(\);/);
});
