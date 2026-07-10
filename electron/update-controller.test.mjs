import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  createUpdateController,
  UPDATE_CHECK_DELAY_MS,
  UPDATE_CHECK_INTERVAL_MS,
} from "./update-controller.mjs";

class FakeUpdater extends EventEmitter {
  checks = 0;
  installs = 0;
  pendingCheck = null;
  failInstall = false;

  checkForUpdates() {
    this.checks += 1;
    return this.pendingCheck ?? Promise.resolve(null);
  }

  quitAndInstall(silent, forceRunAfter) {
    assert.equal(silent, false);
    assert.equal(forceRunAfter, true);
    this.installs += 1;
    if (this.failInstall) this.emit("error", new Error("installer path is private"));
  }
}

function controller(overrides = {}) {
  return createUpdateController({
    updater: new FakeUpdater(),
    isPackaged: true,
    currentVersion: "0.3.0",
    now: () => new Date("2026-07-10T12:00:00.000Z"),
    ...overrides,
  });
}

test("stays disabled and never checks from an unpackaged application", async () => {
  const updater = new FakeUpdater();
  const updates = createUpdateController({
    updater,
    isPackaged: false,
    currentVersion: "0.3.0",
  });

  assert.equal(updates.getState().status, "disabled");
  assert.equal((await updates.checkNow()).status, "disabled");
  assert.equal(updater.checks, 0);
});

test("configures stable automatic downloads and publishes sanitized transitions", () => {
  const updater = new FakeUpdater();
  const states = [];
  const updates = controller({ updater, onStateChange: (state) => states.push(state) });

  assert.equal(updater.autoDownload, true);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.logger, null);

  updater.emit("checking-for-update");
  updater.emit("update-available", {
    version: "0.4.0",
    files: [{ url: "https://secret.invalid/update.zip" }],
    releaseNotes: "confidentiel",
  });
  updater.emit("download-progress", { percent: 46.7, transferred: 123 });
  updater.emit("update-downloaded", { version: "0.4.0" });

  assert.deepEqual(states.map(({ status }) => status), [
    "checking",
    "downloading",
    "downloading",
    "ready",
  ]);
  assert.equal(updates.getState().progressPercent, 100);
  assert.equal(updates.getState().availableVersion, "0.4.0");
  assert.doesNotMatch(JSON.stringify(updates.getState()), /secret|confidentiel/);
});

test("deduplicates checks and exposes only a generic failure", async () => {
  const updater = new FakeUpdater();
  let rejectCheck;
  updater.pendingCheck = new Promise((_resolve, reject) => {
    rejectCheck = reject;
  });
  const updates = controller({ updater });

  const first = updates.checkNow();
  const second = updates.checkNow();
  await Promise.resolve();
  assert.equal(updater.checks, 1);
  rejectCheck(new Error("https://updates.invalid/private-token"));
  assert.equal((await first).status, "error");
  assert.equal((await second).message, "La recherche de mise à jour a échoué. Réessayez plus tard.");
  assert.doesNotMatch(JSON.stringify(updates.getState()), /private-token|updates\.invalid/);
});

test("waits for orderly persistence shutdown before installing", async () => {
  const updater = new FakeUpdater();
  const events = [];
  let releasePersistence;
  const updates = controller({
    updater,
    prepareForInstall: () => new Promise((resolve) => {
      releasePersistence = () => {
        events.push("persistence-closed");
        resolve();
      };
    }),
  });

  await assert.rejects(updates.restartForUpdate(), /aucune mise à jour/i);
  updater.emit("update-downloaded", { version: "0.4.0" });
  const restarting = updates.restartForUpdate().then(() => events.push("installer-started"));
  await Promise.resolve();
  assert.equal(updater.installs, 0);
  releasePersistence();
  await restarting;
  assert.equal(updater.installs, 1);
  assert.deepEqual(events, ["persistence-closed", "installer-started"]);
});

test("exits cleanly when the installer fails after persistence shutdown", async () => {
  const updater = new FakeUpdater();
  const events = [];
  updater.failInstall = true;
  const updates = controller({
    updater,
    prepareForInstall: async () => events.push("persistence-closed"),
    onInstallFailure: () => events.push("forced-exit"),
  });

  updater.emit("update-downloaded", { version: "0.4.0" });
  await updates.restartForUpdate();

  assert.equal(updater.installs, 1);
  assert.deepEqual(events, ["persistence-closed", "forced-exit"]);
  assert.doesNotMatch(JSON.stringify(updates.getState()), /installer path|private/);
});

test("schedules the initial and six-hour checks once", () => {
  const scheduled = [];
  const updates = controller({
    setTimeoutImpl(callback, delay) {
      scheduled.push(["timeout", delay, callback]);
      return { unref() {} };
    },
    clearTimeoutImpl() {},
    setIntervalImpl(callback, delay) {
      scheduled.push(["interval", delay, callback]);
      return { unref() {} };
    },
    clearIntervalImpl() {},
  });

  updates.start();
  updates.start();
  assert.deepEqual(scheduled.map(([kind, delay]) => [kind, delay]), [
    ["timeout", UPDATE_CHECK_DELAY_MS],
    ["interval", UPDATE_CHECK_INTERVAL_MS],
  ]);
});
