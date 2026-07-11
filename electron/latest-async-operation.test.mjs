import assert from "node:assert/strict";
import test from "node:test";
import { createLatestAsyncOperation } from "../src/latest-async-operation.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

test("ignores a stale success that resolves after the current operation", async () => {
  const latest = createLatestAsyncOperation();
  const first = deferred();
  const second = deferred();
  const events = [];
  const firstRun = latest.run(() => first.promise, {
    onSuccess: (value) => events.push(`success:${value}`),
    onError: (error) => events.push(`error:${error.message}`),
    onSettled: () => events.push("settled:first"),
  });
  const secondRun = latest.run(() => second.promise, {
    onSuccess: (value) => events.push(`success:${value}`),
    onError: (error) => events.push(`error:${error.message}`),
    onSettled: () => events.push("settled:second"),
  });

  second.resolve("current");
  await secondRun;
  first.resolve("stale");
  await firstRun;
  assert.deepEqual(events, ["success:current", "settled:second"]);
});

test("ignores a stale rejection after explicit invalidation", async () => {
  const latest = createLatestAsyncOperation();
  const first = deferred();
  const events = [];
  const firstRun = latest.run(() => first.promise, {
    onSuccess: (value) => events.push(`success:${value}`),
    onError: (error) => events.push(`error:${error.message}`),
    onSettled: () => events.push("settled"),
  });

  latest.invalidate();
  first.reject(new Error("stale"));
  await firstRun;
  assert.deepEqual(events, []);
});
