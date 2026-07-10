import assert from "node:assert/strict";
import test from "node:test";

import { closePersistenceAfterPending } from "./shutdown.mjs";

test("waits for persistence operations before closing during an ordinary shutdown", async () => {
  const events = [];
  let settleOperation;
  const operation = new Promise((resolve) => {
    settleOperation = () => {
      events.push("settled");
      resolve();
    };
  });

  const closing = closePersistenceAfterPending({
    pending: [operation],
    closePersistence: () => events.push("closed"),
  });
  await Promise.resolve();
  assert.deepEqual(events, []);
  settleOperation();

  assert.deepEqual(await closing, { pendingSettled: true });
  assert.deepEqual(events, ["settled", "closed"]);
});

test("bounds pending work before closing for Conductor shutdown", async () => {
  let closed = false;
  const neverSettles = new Promise(() => {});

  const result = await closePersistenceAfterPending({
    pending: [neverSettles],
    deadlineMs: 10,
    closePersistence: () => {
      closed = true;
    },
  });

  assert.deepEqual(result, { pendingSettled: false });
  assert.equal(closed, true);
});

test("validates shutdown inputs before touching persistence", async () => {
  await assert.rejects(
    closePersistenceAfterPending({ pending: null, closePersistence() {} }),
    /fermeture invalide/i,
  );
  await assert.rejects(
    closePersistenceAfterPending({ pending: [], deadlineMs: 0, closePersistence() {} }),
    /délai de fermeture invalide/i,
  );
});
