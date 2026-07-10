import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  backupAndImportDashboard,
  readImportedJson,
  saveDashboardBackup,
  writeJson,
} from "./local-files.mjs";

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mediagen-local-files-"));
  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) =>
      rm(directory, { recursive: true, force: true }),
    );
  });
  return directory;
}

test("writes a private JSON file that can be read back", async (t) => {
  const directory = await temporaryDirectory(t);
  const filePath = path.join(directory, "dashboard.json");
  await writeJson(filePath, { format: "test", panels: [] });
  assert.deepEqual(await readImportedJson(filePath), { format: "test", panels: [] });
  assert.equal((await stat(filePath)).mode & 0o077, 0);
});

test("rejects invalid and oversized dashboard files before parsing", async (t) => {
  const directory = await temporaryDirectory(t);
  const invalidPath = path.join(directory, "invalid.json");
  await writeFile(invalidPath, "{not-json", "utf8");
  await assert.rejects(readImportedJson(invalidPath), /JSON valide/);
  const oversizedPath = path.join(directory, "oversized.json");
  await writeFile(oversizedPath, "123456789", "utf8");
  await assert.rejects(readImportedJson(oversizedPath, { maxBytes: 4 }), /trop volumineux/);
});

test("falls back locally, retains ten backups and writes one before importing", async (t) => {
  const directory = await temporaryDirectory(t);
  const blockedPreferredPath = path.join(directory, "not-a-directory");
  await writeFile(blockedPreferredPath, "blocked", "utf8");
  const fallbackDirectory = path.join(directory, "backups");
  for (let index = 0; index < 12; index += 1) {
    await saveDashboardBackup({ index }, {
      preferredDirectory: blockedPreferredPath,
      fallbackDirectory,
      now: () => new Date(Date.UTC(2026, 6, 10, 12, 0, index)),
    });
  }
  assert.equal((await readdir(fallbackDirectory)).length, 10);

  const calls = [];
  const engine = {
    exportDashboardConfig() {
      calls.push("export");
      return { previous: true };
    },
    async importDashboardConfig(configuration) {
      calls.push("import");
      const backups = await readdir(fallbackDirectory);
      assert.ok(backups.length > 0, "La sauvegarde doit exister avant la mutation.");
      return { imported: configuration.next };
    },
  };
  const result = await backupAndImportDashboard({
    engine,
    configuration: { next: true },
    preferredDirectory: blockedPreferredPath,
    fallbackDirectory,
    now: () => new Date("2026-07-10T13:00:00.000Z"),
  });
  assert.deepEqual(calls, ["export", "import"]);
  assert.deepEqual(result.state, { imported: true });
  assert.deepEqual(JSON.parse(await readFile(result.backupFilePath, "utf8")), {
    previous: true,
  });
});
