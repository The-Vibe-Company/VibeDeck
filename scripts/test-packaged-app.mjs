import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const STARTUP_TIMEOUT_MS = 30_000;
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const productName = packageJson.build?.productName;
assert.equal(typeof productName, "string", "Nom de produit Electron introuvable.");
assert.match(productName, /^[^/\\]+$/, "Nom de produit Electron invalide.");

async function exists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function discoverExecutable() {
  const requested = process.argv[2] ? path.resolve(process.argv[2]) : null;
  if (requested) {
    if (requested.endsWith(".app")) {
      return path.join(requested, "Contents", "MacOS", productName);
    }
    return requested;
  }
  const releaseDirectory = path.join(root, "release");
  const entries = await readdir(releaseDirectory, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (process.platform === "darwin" && entry.name.startsWith("mac")) {
      candidates.push(
        path.join(
          releaseDirectory,
          entry.name,
          `${productName}.app`,
          "Contents",
          "MacOS",
          productName,
        ),
      );
    }
    if (
      process.platform === "win32" &&
      entry.name.startsWith("win") &&
      entry.name.endsWith("-unpacked")
    ) {
      candidates.push(path.join(releaseDirectory, entry.name, `${productName}.exe`));
    }
  }
  const available = [];
  for (const candidate of candidates) {
    if (await exists(candidate)) available.push(candidate);
  }
  assert.equal(
    available.length,
    1,
    `Un seul binaire empaqueté est attendu, trouvé : ${available.join(", ") || "aucun"}`,
  );
  return available[0];
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object", "Port local de test indisponible.");
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

function captureProcessOutput(child) {
  let output = "";
  const append = (chunk) => {
    output = `${output}${String(chunk)}`.slice(-4_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return () => output.trim();
}

async function waitForCdp(child, port, output) {
  let childFailure = null;
  child.once("error", (error) => {
    childFailure = error;
  });
  child.once("exit", (code, signal) => {
    childFailure = new Error(
      `Le binaire s’est arrêté avant le smoke test (code ${code ?? "?"}, signal ${signal ?? "?"}).`,
    );
  });

  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (childFailure) throw childFailure;
    try {
      const response = await fetch(`${endpoint}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const metadata = await response.json();
        if (typeof metadata.webSocketDebuggerUrl === "string") return endpoint;
      }
    } catch {
      // Le port n'est ouvert qu'une fois Chromium et le processus principal prêts.
    }
    await delay(200);
  }
  throw new Error(
    `Le canal local de contrôle n’est pas devenu disponible en ${STARTUP_TIMEOUT_MS / 1_000} s.${output() ? `\n${output()}` : ""}`,
  );
}

async function waitForApplicationPage(browser) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      const page = context.pages().find((candidate) => candidate.url().startsWith("mediagen-app:"));
      if (page) return page;
    }
    await delay(100);
  }
  throw new Error("La fenêtre principale empaquetée ne s’est pas ouverte.");
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function terminateProcessTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    await execFileAsync("taskkill", ["/pid", String(child.pid), "/T", "/F"]).catch(() => undefined);
    await waitForExit(child, 3_000);
    return;
  }
  child.kill("SIGTERM");
  if (!(await waitForExit(child, 3_000))) {
    child.kill("SIGKILL");
    await waitForExit(child, 2_000);
  }
}

const executablePath = await discoverExecutable();
assert.ok(await exists(executablePath), `Binaire empaqueté introuvable : ${executablePath}`);
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "mediagen-packaged-smoke-"));
const profileDirectory = path.join(temporaryDirectory, "profile");
const debugPort = await reserveLoopbackPort();
let child;
let browser;
try {
  const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" };
  for (const key of [
    "ELECTRON_RUN_AS_NODE",
    "MEDIAGEN_ALLOW_PRIVATE_NETWORK",
    "MEDIAGEN_DB_PATH",
    "NODE_OPTIONS",
    "VITE_DEV_SERVER_URL",
  ]) {
    delete env[key];
  }
  child = spawn(
    executablePath,
    [
      `--user-data-dir=${profileDirectory}`,
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${debugPort}`,
      "--remote-allow-origins=http://127.0.0.1",
    ],
    {
      cwd: path.dirname(executablePath),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const output = captureProcessOutput(child);
  const endpoint = await waitForCdp(child, debugPort, output);
  browser = await chromium.connectOverCDP(endpoint, { timeout: STARTUP_TIMEOUT_MS });
  const page = await waitForApplicationPage(browser);
  page.setDefaultTimeout(20_000);
  await page.waitForFunction(() => Boolean(window.mediagen?.getState));
  const proof = await page.evaluate(async () => ({
    protocol: window.location.protocol,
    title: document.title,
    hasRoot: Boolean(document.getElementById("root")),
    panelCount: (await window.mediagen.getState()).panels.length,
  }));
  assert.equal(proof.protocol, "mediagen-app:");
  assert.equal(proof.hasRoot, true);
  assert.ok(proof.title.trim().length > 0, "Le document empaqueté doit avoir un titre.");
  assert.equal(Number.isInteger(proof.panelCount), true);
  assert.ok(
    await exists(path.join(profileDirectory, "veille.sqlite3")),
    "La base SQLite de test n’a pas été créée dans le profil temporaire.",
  );
  console.log(
    `✓ Smoke empaqueté : ${proof.protocol}// · preload, interface et SQLite disponibles`,
  );
} finally {
  if (browser) await browser.close().catch(() => undefined);
  await terminateProcessTree(child);
  await rm(temporaryDirectory, {
    recursive: true,
    force: true,
    maxRetries: process.platform === "win32" ? 5 : 0,
    retryDelay: 200,
  });
}
