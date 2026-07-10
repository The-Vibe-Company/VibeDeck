import assert from "node:assert/strict";
import test from "node:test";

import { runWithFinalStateBroadcast } from "./final-state-operation.mjs";

test("broadcasts the completed state exactly once after success", async () => {
  const completed = { revision: 2 };
  const broadcasts = [];
  let readCount = 0;

  const result = await runWithFinalStateBroadcast(
    async () => completed,
    {
      getState() {
        readCount += 1;
        return { revision: 999 };
      },
      broadcast: (state) => broadcasts.push(state),
    },
  );

  assert.equal(result, completed);
  assert.equal(readCount, 0);
  assert.deepEqual(broadcasts, [completed]);
});

test("broadcasts restored database truth exactly once without masking save rejection", async () => {
  const originalError = new Error("Aucune modification conservée");
  const restored = { revision: 1 };
  const broadcasts = [];
  let readCount = 0;

  await assert.rejects(
    runWithFinalStateBroadcast(
      async () => {
        throw originalError;
      },
      {
        getState() {
          readCount += 1;
          return restored;
        },
        broadcast: (state) => broadcasts.push(state),
      },
    ),
    (error) => error === originalError,
  );

  assert.equal(readCount, 1);
  assert.deepEqual(broadcasts, [restored]);
});

test("a final broadcast failure never replaces the save error", async () => {
  const originalError = new Error("échec du save");
  const broadcastError = new Error("fenêtre détruite");
  const warnings = [];

  await assert.rejects(
    runWithFinalStateBroadcast(
      async () => {
        throw originalError;
      },
      {
        getState: () => ({ revision: 1 }),
        broadcast() {
          throw broadcastError;
        },
        onBroadcastError: (error) => warnings.push(error),
      },
    ),
    (error) => error === originalError,
  );

  assert.deepEqual(warnings, [broadcastError]);
});
