import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import electronExecutable from "electron";
import { _electron as electron } from "playwright-core";
import {
  assertPerformanceBudgets,
  PERFORMANCE_BUDGETS,
  summarizeDurations,
} from "./perf/budgets.mjs";
import {
  PERF_ITEM_COUNT,
  PERF_ITEMS_PER_SOURCE,
  PERF_PANEL_ID,
  PERF_SOURCE_COUNT,
  seedPerformanceDatabase,
} from "./perf/fixture.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const showWindow = process.env.VIBEDECK_PERF_UI_SHOW === "1";
const enforceBudgets = process.env.VIBEDECK_PERF_ENFORCE !== "0";
const arrowWarmupCount = 5;
const arrowSampleCount = 30;
const rafSampleCount = 120;
const tallWindowHeight = 3_000;

function roundMetric(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value * 100) / 100
    : value;
}

function roundMetrics(value) {
  if (Array.isArray(value)) return value.map(roundMetrics);
  if (!value || typeof value !== "object") return roundMetric(value);
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, roundMetrics(child)]),
  );
}

async function settleRenderer(page) {
  await page.evaluate(async () => {
    await document.fonts?.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function collectAnimationFrameGaps(page, sampleCount) {
  const gaps = await page.evaluate((count) => new Promise((resolve) => {
    const samples = [];
    let previous = null;
    const frame = (timestamp) => {
      if (previous !== null) samples.push(timestamp - previous);
      previous = timestamp;
      if (samples.length >= count) resolve(samples);
      else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }), sampleCount);
  return summarizeDurations(gaps);
}

async function armArrowMeasurement(page) {
  await page.evaluate(() => {
    const initialId = document.activeElement?.id ?? null;
    globalThis.__vibedeckPerfArrowMeasurement = new Promise((resolve) => {
      let startedAt = null;
      let timeout = null;
      const cleanup = () => {
        window.removeEventListener("keydown", onKeyDown, true);
        document.removeEventListener("focusin", onFocus, true);
        if (timeout !== null) clearTimeout(timeout);
      };
      const finishWithError = (message) => {
        cleanup();
        resolve({ error: message, initialId, activeId: document.activeElement?.id ?? null });
      };
      const onFocus = (event) => {
        if (
          startedAt === null ||
          !(event.target instanceof HTMLElement) ||
          !event.target.matches(".article-row") ||
          event.target.id === initialId
        ) return;
        const focusAt = performance.now();
        requestAnimationFrame(() => {
          const activeId = document.activeElement?.id ?? null;
          const nextFrameAt = performance.now();
          cleanup();
          resolve({
            error: null,
            initialId,
            activeId,
            inputToFocusMs: focusAt - startedAt,
            inputToNextFrameMs: nextFrameAt - startedAt,
          });
        });
      };
      const onKeyDown = (event) => {
        if (event.key !== "ArrowDown") return;
        startedAt = performance.now();
        timeout = setTimeout(
          () => finishWithError("ArrowDown n’a pas transféré le focus en 2 s."),
          2_000,
        );
      };
      document.addEventListener("focusin", onFocus, true);
      window.addEventListener("keydown", onKeyDown, true);
    });
  });
}

async function measureArrow(page) {
  await armArrowMeasurement(page);
  await page.keyboard.press("ArrowDown");
  const result = await page.evaluate(() => globalThis.__vibedeckPerfArrowMeasurement);
  assert.equal(result.error, null, result.error ?? "Mesure ArrowDown invalide.");
  assert.notEqual(result.activeId, result.initialId, "ArrowDown doit changer l’article actif.");
  assert.match(result.activeId ?? "", /^article-/, "Le vrai focus doit rester sur une ligne.");
  return result;
}

async function collectArrowMetrics(page) {
  const firstRow = page.locator(".article-row").first();
  await firstRow.focus();
  assert.equal(
    await firstRow.evaluate((row) => document.activeElement === row),
    true,
    "La première ligne doit recevoir le vrai focus avant la mesure.",
  );

  for (let index = 0; index < arrowWarmupCount; index += 1) await measureArrow(page);
  const samples = [];
  for (let index = 0; index < arrowSampleCount; index += 1) {
    samples.push(await measureArrow(page));
  }
  return {
    samples: arrowSampleCount,
    inputToFocus: summarizeDurations(samples.map(({ inputToFocusMs }) => inputToFocusMs)),
    inputToNextFrame: summarizeDurations(
      samples.map(({ inputToNextFrameMs }) => inputToNextFrameMs),
    ),
    finalActiveId: samples.at(-1)?.activeId ?? null,
  };
}

async function collectDomMetrics(page) {
  return page.evaluate(() => {
    const list = document.querySelector(".article-list");
    if (!(list instanceof HTMLElement)) throw new Error("Le fil de performance est introuvable.");
    const mountedArticleRows = list.querySelectorAll(".article-row").length;
    const declared = Number(list.dataset.feedTotalCount);
    return {
      virtualized: list.dataset.virtualized === "true",
      declaredArticleCount: Number.isSafeInteger(declared) ? declared : mountedArticleRows,
      mountedArticleRows,
      elements: document.getElementsByTagName("*").length,
      listClientHeight: list.clientHeight,
      listScrollHeight: list.scrollHeight,
      firstRowIndex:
        list.querySelector(".article-row")?.getAttribute("data-feed-row-index") ?? null,
      lastRowIndex:
        [...list.querySelectorAll(".article-row")].at(-1)
          ?.getAttribute("data-feed-row-index") ?? null,
    };
  });
}

async function collectCdpMetrics(session) {
  if (!session) return null;
  try {
    let garbageCollected = false;
    try {
      await session.send("HeapProfiler.collectGarbage");
      garbageCollected = true;
    } catch {
      // This command is unavailable on a few Chromium/Electron combinations;
      // the raw heap counters remain useful and the report says which mode ran.
    }
    const [dom, performanceResult, heap] = await Promise.all([
      session.send("Memory.getDOMCounters"),
      session.send("Performance.getMetrics"),
      session.send("Runtime.getHeapUsage"),
    ]);
    return {
      garbageCollected,
      dom,
      performance: Object.fromEntries(
        performanceResult.metrics.map(({ name, value }) => [name, value]),
      ),
      heap,
    };
  } catch (error) {
    return { unavailable: error instanceof Error ? error.message : String(error) };
  }
}

async function installIpcProbe(electronApp) {
  return electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) return false;
    const probe = { total: 0, channels: Object.create(null), listener: null };
    probe.listener = (_event, channel) => {
      probe.total += 1;
      probe.channels[channel] = (probe.channels[channel] ?? 0) + 1;
    };
    window.webContents.__vibedeckPerfIpcProbe = probe;
    window.webContents.on("ipc-message", probe.listener);
    return true;
  });
}

async function readAndRemoveIpcProbe(electronApp) {
  return electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const contents = window?.webContents;
    const probe = contents?.__vibedeckPerfIpcProbe;
    if (!contents || !probe) return null;
    contents.off("ipc-message", probe.listener);
    delete contents.__vibedeckPerfIpcProbe;
    return { total: probe.total, channels: { ...probe.channels } };
  });
}

async function collectProcessMetrics(electronApp) {
  return electronApp.evaluate(async ({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const mainFrame = window?.webContents.mainFrame;
    const rendererProcessId = mainFrame?.osProcessId ?? null;
    return {
      versions: process.versions,
      rendererProcessId,
      rendererRoutingProcessId: mainFrame?.processId ?? null,
      main: typeof process.getProcessMemoryInfo === "function"
        ? await process.getProcessMemoryInfo()
        : null,
      processes: app.getAppMetrics().map((metric) => ({
        type: metric.type,
        pid: metric.pid,
        renderer: metric.pid === rendererProcessId,
        cpuPercent: metric.cpu.percentCPUUsage,
        memory: metric.memory,
      })),
    };
  });
}

const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "vibedeck-perf-ui-"));
const databasePath = path.join(temporaryDirectory, "vibedeck.sqlite3");
let electronApp;
let cdpSession;

try {
  const fixtureStartedAt = performance.now();
  seedPerformanceDatabase(databasePath);
  const fixtureDurationMs = performance.now() - fixtureStartedAt;

  const launchStartedAt = performance.now();
  electronApp = await electron.launch({
    executablePath: electronExecutable,
    args: [
      `--user-data-dir=${path.join(temporaryDirectory, "profile")}`,
      "--enable-precise-memory-info",
      projectRoot,
    ],
    cwd: projectRoot,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      VIBEDECK_DB_PATH: databasePath,
      VIBEDECK_FAKE_SEMANTIC_SEARCH: "true",
      VIBEDECK_TEST_HEADLESS: showWindow ? "" : "true",
      VITE_DEV_SERVER_URL: "",
    },
    timeout: 60_000,
  });

  const page = await electronApp.firstWindow({ timeout: 60_000 });
  const firstWindowMs = performance.now() - launchStartedAt;
  page.setDefaultTimeout(60_000);
  if (showWindow) await page.bringToFront();

  const browserWindow = await electronApp.browserWindow(page);
  await browserWindow.evaluate((window) => window.setSize(1280, 820));
  await browserWindow.dispose();

  await page.waitForFunction(() => Boolean(window.vibedeck?.getState));
  const apiReadyMs = performance.now() - launchStartedAt;
  await page.locator(".article-list").waitFor({ state: "visible" });
  await page.locator(".article-row").first().waitFor({ state: "visible" });
  const firstArticleMs = performance.now() - launchStartedAt;
  await settleRenderer(page);

  try {
    cdpSession = await page.context().newCDPSession(page);
    await cdpSession.send("Performance.enable");
  } catch {
    cdpSession = null;
  }

  const ipcProbeAvailable = await installIpcProbe(electronApp);
  const cdpBefore = await collectCdpMetrics(cdpSession);
  const domBefore = await collectDomMetrics(page);
  const animationFrames = await collectAnimationFrameGaps(page, rafSampleCount);
  const arrows = await collectArrowMetrics(page);
  await settleRenderer(page);
  const dom = await collectDomMetrics(page);
  const tallBrowserWindow = await electronApp.browserWindow(page);
  await tallBrowserWindow.evaluate(
    (window, height) => window.setSize(1280, height),
    tallWindowHeight,
  );
  await tallBrowserWindow.dispose();
  await settleRenderer(page);
  const domTall = await collectDomMetrics(page);
  const cdpAfter = await collectCdpMetrics(cdpSession);
  const ipc = await readAndRemoveIpcProbe(electronApp);
  const processes = await collectProcessMetrics(electronApp);

  assert.equal(dom.declaredArticleCount, PERF_ITEM_COUNT);
  assert.ok(dom.listScrollHeight > dom.listClientHeight, "Le fil chargé doit réellement défiler.");

  const report = roundMetrics({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    platform: { platform: process.platform, arch: process.arch },
    fixture: {
      panelId: PERF_PANEL_ID,
      sources: PERF_SOURCE_COUNT,
      itemsPerSource: PERF_ITEMS_PER_SOURCE,
      items: PERF_ITEM_COUNT,
      seedDurationMs: fixtureDurationMs,
    },
    startup: { firstWindowMs, apiReadyMs, firstArticleMs },
    budgets: PERFORMANCE_BUDGETS,
    metrics: {
      domBefore,
      dom,
      domTall,
      animationFrames,
      arrows,
      cdpBefore,
      cdpAfter,
      ipc: { available: ipcProbeAvailable, observedRendererSends: ipc },
      processes,
    },
  });

  const serializedReport = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(serializedReport);
  if (process.env.VIBEDECK_PERF_REPORT) {
    await writeFile(path.resolve(process.env.VIBEDECK_PERF_REPORT), serializedReport, "utf8");
  }
  if (enforceBudgets) assertPerformanceBudgets(report);
  process.stdout.write(
    `✓ 50 sources / 25 000 articles : ${report.metrics.dom.mountedArticleRows} lignes DOM, ` +
    `rAF p95 ${report.metrics.animationFrames.p95Ms} ms, ` +
    `Arrow→focus p95 ${report.metrics.arrows.inputToFocus.p95Ms} ms.\n`,
  );
} finally {
  await cdpSession?.detach().catch(() => undefined);
  await electronApp?.close().catch(() => undefined);
  await rm(temporaryDirectory, { recursive: true, force: true });
}
