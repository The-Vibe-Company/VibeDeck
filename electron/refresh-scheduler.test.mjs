import assert from "node:assert/strict";
import test from "node:test";

import { createRefreshScheduler, sourceIsDue } from "./refresh-scheduler.mjs";

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
      {
        id: "fresh",
        status: "healthy",
        refreshIntervalSeconds: 60,
        lastCheckedAt: "2026-07-10T11:59:45.000Z",
      },
    ],
    refreshSource: async (sourceId) => {
      calls.push(sourceId);
      await gate;
    },
    onStateChange: () => {
      broadcasts += 1;
    },
  });

  const first = scheduler.run();
  const second = scheduler.run();
  assert.equal(first, second);
  assert.deepEqual(calls, ["due"]);
  assert.equal(broadcasts, 1);
  release();
  await first;
  assert.equal(broadcasts, 2);
  assert.equal(scheduler.pending(), null);
  scheduler.stop();
  await scheduler.run();
  assert.deepEqual(calls, ["due"]);
});
