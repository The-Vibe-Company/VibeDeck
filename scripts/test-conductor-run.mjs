import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const timeoutMs = 30_000;
const workspaceEntries = [
  "electron",
  "index.html",
  "node_modules",
  "package.json",
  "scripts",
  "src",
  "vite.config.ts",
];

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object", "Port de test Conductor introuvable.");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function canListen(port) {
  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    return true;
  } catch {
    return false;
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
}

async function waitForPortsReleased(ports) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const released = await Promise.all(ports.map(canListen));
    if (released.every(Boolean)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("L’arrêt Conductor doit libérer les deux ports Vite.");
}

async function prepareWorkspace(workspacePath) {
  for (const entry of workspaceEntries) {
    await symlink(path.join(root, entry), path.join(workspacePath, entry));
  }
}

function startWorkspace(workspacePath, port, inheritedDatabasePath) {
  const child = spawn("npm", ["run", "dev:conductor"], {
    cwd: workspacePath,
    detached: true,
    env: {
      ...process.env,
      CONDUCTOR_PORT: String(port),
      CONDUCTOR_WORKSPACE_PATH: workspacePath,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      MEDIAGEN_DB_PATH: inheritedDatabasePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-20_000);
    });
  }
  return { child, output: () => output };
}

async function waitFor(predicate, label, processes) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const processRecord of processes) {
      if (processRecord.child.exitCode !== null) {
        throw new Error(`Le Run Conductor s’est arrêté avant ${label}.\n${processRecord.output()}`);
      }
    }
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Délai dépassé pendant ${label}.\n${processes.map((entry) => entry.output()).join("\n")}`);
}

async function pathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

function readPilotSessions(databasePath) {
  const database = new DatabaseSync(databasePath);
  try {
    const integrity = database.prepare("PRAGMA integrity_check").get()?.integrity_check;
    const counts = database.prepare(`
      SELECT
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed
      FROM pilot_sessions
    `).get();
    return {
      active: Number(counts?.active ?? 0),
      closed: Number(counts?.closed ?? 0),
      integrity,
    };
  } finally {
    database.close();
  }
}

async function hasActivePilotSession(databasePath) {
  if (!(await pathExists(databasePath))) return false;
  try {
    return readPilotSessions(databasePath).active === 1;
  } catch {
    return false;
  }
}

async function stopProcessGroup(processRecord) {
  try {
    process.kill(-processRecord.child.pid, "SIGHUP");
  } catch (error) {
    if (error?.code === "ESRCH") return;
    throw error;
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  try {
    process.kill(-processRecord.child.pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "mediagen-conductor-run-"));
const workspacePaths = [path.join(temporaryRoot, "workspace-a"), path.join(temporaryRoot, "workspace-b")];
const processes = [];

try {
  await Promise.all(workspacePaths.map(async (workspacePath) => {
    await mkdir(workspacePath);
    await prepareWorkspace(workspacePath);
  }));
  const ports = await Promise.all([reservePort(), reservePort()]);
  assert.notEqual(ports[0], ports[1], "Les deux workspaces doivent utiliser des ports distincts.");
  const inheritedDatabasePath = path.join(temporaryRoot, "inherited.sqlite3");

  processes.push(
    startWorkspace(workspacePaths[0], ports[0], inheritedDatabasePath),
    startWorkspace(workspacePaths[1], ports[1], inheritedDatabasePath),
  );
  const databasePaths = workspacePaths.map((workspacePath) =>
    path.join(workspacePath, ".context", "mediagen-dev", "user-data", "veille.sqlite3"));

  await waitFor(
    () => Promise.all(databasePaths.map(hasActivePilotSession)).then((results) => results.every(Boolean)),
    "le démarrage des deux sessions isolées",
    processes,
  );
  await Promise.all(ports.map(async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}`);
    assert.equal(response.status, 200, `Vite doit répondre sur le port ${port}.`);
    assert.match(
      response.headers.get("content-security-policy") ?? await response.text(),
      new RegExp(`(?:http|ws)://127\\.0\\.0\\.1:${port}`),
      `La CSP de développement doit utiliser le port ${port}.`,
    );
  }));
  assert.notEqual(databasePaths[0], databasePaths[1]);
  assert.equal(
    await pathExists(inheritedDatabasePath),
    false,
    "Un MEDIAGEN_DB_PATH hérité ne doit jamais contourner l’isolation Conductor.",
  );
  await Promise.all(processes.map(stopProcessGroup));
  await waitForPortsReleased(ports);
  for (const databasePath of databasePaths) {
    const sessions = readPilotSessions(databasePath);
    assert.equal(sessions.integrity, "ok", "SQLite doit rester intègre après l’arrêt Conductor.");
    assert.equal(sessions.active, 0, "L’arrêt Conductor doit fermer la session pilote active.");
    assert.equal(sessions.closed, 1, "L’arrêt Conductor doit suivre le chemin before-quit complet.");
  }
  console.log(`✓ Deux Runs Conductor isolés sur les ports ${ports.join(" et ")}`);
} finally {
  await Promise.allSettled(processes.map(stopProcessGroup));
  await rm(temporaryRoot, { recursive: true, force: true });
}
