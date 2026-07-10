import { app, BrowserWindow, dialog, ipcMain, net, protocol, session, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFeedEngine } from "./feed-engine.mjs";
import { createRefreshScheduler } from "./refresh-scheduler.mjs";
import {
  backupAndImportDashboard,
  readImportedJson,
  writeJson,
} from "./local-files.mjs";
import {
  APP_ENTRY_URL,
  APP_PROTOCOL_SCHEME,
  createAppProtocolHandler,
} from "./app-protocol.mjs";
import { resolveRendererEntryUrl } from "./development-config.mjs";
import {
  clearWebPanelSessionData,
  collectEnterpriseNetworkDiagnostics,
  createElectronSessionFetch,
  createWebPanelController,
  WEB_PANEL_SESSION_STRATEGY,
} from "./web-panel-controller.mjs";
import { runWithFinalStateBroadcast } from "./final-state-operation.mjs";
import { closePersistenceAfterPending } from "./shutdown.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REFRESH_TICK_MS = 15_000;
const PILOT_HEARTBEAT_MS = 60_000;
const MAX_LAYOUT_DEPTH = 32;
const MAX_LAYOUT_NODES = 1_023;
const MAX_DASHBOARD_WEB_PANELS = 6;
const MIN_REFRESH_INTERVAL_SECONDS = 30;
const MAX_REFRESH_INTERVAL_SECONDS = 3_600;
const CONNECTOR_PREFERENCES = new Set(["auto", "rss", "atom", "news-sitemap"]);
const PANEL_SIDES = new Set(["left", "right", "top", "bottom"]);
const WEB_DATA_SCOPES = new Set(["cache", "site-data", "all"]);
// Feed downloads deliberately use an isolated, memory-only Chromium session.
// It inherits Electron/Chromium proxy and certificate handling without sharing
// page cookies or duplicating the SQLite feed cache on disk.
const FEED_NETWORK_PARTITION = "mediagen-feed-network";
const MAX_ITEM_IDS_PER_CALL = 500;
const MAX_FEED_CONFIGURATION_SOURCE_IDS = 4_096;
const MAX_FEED_CONFIGURATION_NEW_SOURCES = 256;
const DIAGNOSTICS_FORMAT = "mediagen-veille-diagnostics";
const DIAGNOSTICS_VERSION = 1;
const CONDUCTOR_SHUTDOWN_GRACE_MS = 120;

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_PROTOCOL_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      codeCache: true,
    },
  },
]);

let mainWindow = null;
let engine = null;
let feedNetworkSession = null;
let refreshTimer = null;
let refreshScheduler = null;
let pilotHeartbeatTimer = null;
let pilotSessionId = null;
let lastPilotHeartbeatActive = null;
let isQuitting = false;
let shutdownComplete = false;
let conductorShutdownRequested = false;
const activeOperations = new Set();
const webPanelControllers = new Map();
const resettingWebPanelControllers = new WeakSet();

if (!app.isPackaged) {
  process.on("SIGHUP", () => {
    conductorShutdownRequested = true;
    if (!isQuitting) app.quit();
  });
}

function cleanName(value) {
  if (typeof value !== "string") throw new TypeError("Le nom est invalide.");
  const name = value.trim();
  if (name.length < 1 || name.length > 80) {
    throw new RangeError("Le nom doit contenir entre 1 et 80 caractères.");
  }
  return name;
}

function cleanId(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 128) {
    throw new TypeError("Identifiant invalide.");
  }
  return value.trim();
}

function cleanItemIds(value) {
  if (!Array.isArray(value) || value.length > MAX_ITEM_IDS_PER_CALL) {
    throw new TypeError("Liste d’articles invalide.");
  }
  return [...new Set(value.map(cleanId))];
}

function cleanHttpUrl(value) {
  if (typeof value !== "string" || value.length > 4_096) {
    throw new TypeError("URL invalide.");
  }

  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new TypeError("Cette URL n’est pas valide.");
  }

  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new TypeError("Seules les URLs web http et https sont acceptées.");
  }
  return parsed.toString();
}

function cleanSourceUrl(value) {
  if (typeof value !== "string") throw new TypeError("URL invalide.");
  const trimmed = value.trim();
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return cleanHttpUrl(candidate);
}

function cleanRefreshInterval(value, { optional = false } = {}) {
  if (optional && value == null) return undefined;
  if (
    !Number.isInteger(value) ||
    value < MIN_REFRESH_INTERVAL_SECONDS ||
    value > MAX_REFRESH_INTERVAL_SECONDS
  ) {
    throw new RangeError("La fréquence doit être comprise entre 30 secondes et 60 minutes.");
  }
  return value;
}

function cleanSourceRequest(value) {
  if (typeof value === "string") return cleanSourceUrl(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Configuration de source invalide.");
  }
  const connectorKind = value.connectorKind ?? "auto";
  if (!CONNECTOR_PREFERENCES.has(connectorKind)) {
    throw new TypeError("Type de connecteur invalide.");
  }
  return {
    url: cleanSourceUrl(value.url),
    connectorKind,
    refreshIntervalSeconds: cleanRefreshInterval(value.refreshIntervalSeconds, {
      optional: true,
    }),
  };
}

function cleanSourceAddOptions(value) {
  if (value == null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Options de source invalides.");
  }
  return {
    refreshIntervalSeconds: cleanRefreshInterval(value.refreshIntervalSeconds, {
      optional: true,
    }),
  };
}

function cleanBoundedIds(value, label, maximum) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new RangeError(`${label} trop volumineuse.`);
  }
  return [...new Set(value.map(cleanId))];
}

function cleanFeedPanelConfigurationDraft(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Configuration du fil invalide.");
  }
  if (
    !Array.isArray(value.customSources) ||
    value.customSources.length > MAX_FEED_CONFIGURATION_NEW_SOURCES
  ) {
    throw new RangeError("Liste de sources personnalisées trop volumineuse.");
  }

  const seenCustomSources = new Set();
  const customSources = [];
  for (const candidate of value.customSources) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new TypeError("Source personnalisée invalide.");
    }
    const cleaned = cleanSourceRequest({
      url: candidate.url,
      connectorKind: candidate.connectorKind,
    });
    const key = `${cleaned.connectorKind}\u0000${cleaned.url}`;
    if (seenCustomSources.has(key)) continue;
    seenCustomSources.add(key);
    customSources.push({
      url: cleaned.url,
      connectorKind: cleaned.connectorKind,
    });
  }

  const selectedCatalogIds = cleanBoundedIds(
    value.selectedCatalogIds,
    "Liste de connecteurs",
    MAX_FEED_CONFIGURATION_NEW_SOURCES,
  );
  if (
    selectedCatalogIds.length + customSources.length >
    MAX_FEED_CONFIGURATION_NEW_SOURCES
  ) {
    throw new RangeError("La configuration ajoute trop de sources à la fois.");
  }

  return {
    name: cleanName(value.name),
    defaultRefreshIntervalSeconds: cleanRefreshInterval(
      value.defaultRefreshIntervalSeconds,
    ),
    keptSourceIds: cleanBoundedIds(
      value.keptSourceIds,
      "Liste de sources conservées",
      MAX_FEED_CONFIGURATION_SOURCE_IDS,
    ),
    selectedCatalogIds,
    customSources,
  };
}

function cleanPanelInput(value) {
  if (typeof value === "string") return cleanName(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Configuration de panel invalide.");
  }
  if (value.kind === "feed") {
    return {
      kind: "feed",
      name: cleanName(value.name),
      defaultRefreshIntervalSeconds: cleanRefreshInterval(
        value.defaultRefreshIntervalSeconds ?? 60,
      ),
    };
  }
  if (value.kind === "web") {
    return {
      kind: "web",
      name: cleanName(value.name),
      url: cleanSourceUrl(value.url),
    };
  }
  throw new TypeError("Type de panel invalide.");
}

function cleanPanelPlacement(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Emplacement de panel invalide.");
  }
  if (!PANEL_SIDES.has(value.side)) {
    throw new TypeError("Côté de panel invalide.");
  }
  return {
    targetPanelId: cleanId(value.targetPanelId),
    side: value.side,
  };
}

function cleanDashboardRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Révision de dashboard invalide.");
  }
  return value;
}

function cleanWebDataRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Demande d’effacement des données web invalide.");
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "scope" || !WEB_DATA_SCOPES.has(value.scope)) {
    throw new TypeError("Type d’effacement des données web invalide.");
  }
  return { scope: value.scope };
}

function assertNoArguments(args) {
  if (args.length !== 0) throw new TypeError("Cette commande n’accepte aucun paramètre.");
}

function datedJsonName(prefix) {
  return `${prefix}-${new Date().toISOString().slice(0, 10)}.json`;
}

function cleanDashboardLayout(value) {
  if (value === null) return null;

  let nodeCount = 0;
  const visit = (node, depth) => {
    nodeCount += 1;
    if (depth > MAX_LAYOUT_DEPTH || nodeCount > MAX_LAYOUT_NODES) {
      throw new RangeError("Le layout est trop complexe.");
    }
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      throw new TypeError("Nœud de layout invalide.");
    }
    if (node.type === "panel") {
      return { type: "panel", panelId: cleanId(node.panelId) };
    }
    if (node.type !== "split") {
      throw new TypeError("Type de nœud de layout invalide.");
    }
    if (node.direction !== "row" && node.direction !== "column") {
      throw new TypeError("Direction de séparation invalide.");
    }
    if (
      typeof node.ratio !== "number" ||
      !Number.isFinite(node.ratio) ||
      node.ratio < 0.1 ||
      node.ratio > 0.9
    ) {
      throw new TypeError("Ratio de séparation invalide.");
    }
    if (!Array.isArray(node.children) || node.children.length !== 2) {
      throw new TypeError("Une séparation doit contenir exactement deux zones.");
    }
    return {
      type: "split",
      id: cleanId(node.id),
      direction: node.direction,
      ratio: node.ratio,
      children: [visit(node.children[0], depth + 1), visit(node.children[1], depth + 1)],
    };
  };

  return visit(value, 0);
}

function requireMainSender(event) {
  for (const window of webPanelControllers.keys()) {
    if (window.isDestroyed() || event.sender !== window.webContents) continue;
    const mainFrame = window.webContents.mainFrame;
    if (event.senderFrame && mainFrame && event.senderFrame !== mainFrame) break;
    return window;
  }
  throw new Error("Appel IPC refusé depuis ce contenu.");
}

function controllerForEvent(event) {
  const window = requireMainSender(event);
  const controller = webPanelControllers.get(window);
  if (!controller) throw new Error("Contrôleur de panels web indisponible.");
  return controller;
}

function registerHandle(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    requireMainSender(event);
    return handler(event, ...args);
  });
}

function destroyWebPanelController(window) {
  const controller = webPanelControllers.get(window);
  if (!controller) return Promise.resolve();
  webPanelControllers.delete(window);
  const cleanup = Promise.resolve().then(() => controller.shutdown());
  trackActiveOperation(cleanup);
  return cleanup;
}

function destroyAllWebPanelControllers() {
  const cleanups = [];
  for (const window of [...webPanelControllers.keys()]) {
    cleanups.push(destroyWebPanelController(window));
  }
  return Promise.allSettled(cleanups);
}

function sendToWindow(window, channel, value) {
  if (window.isDestroyed() || window.webContents.isDestroyed?.()) return false;
  try {
    window.webContents.send(channel, value);
    return true;
  } catch {
    return false;
  }
}

function broadcastState(state = engine?.getState()) {
  if (!state) return;
  for (const window of webPanelControllers.keys()) {
    sendToWindow(window, "aggregator:state-changed", state);
  }
}

function windowIsActivelyUsed() {
  if (isQuitting) return false;
  return BrowserWindow.getAllWindows().some((window) => {
    try {
      return (
        !window.isDestroyed() &&
        window.isVisible() &&
        !window.isMinimized() &&
        window.isFocused()
      );
    } catch {
      return false;
    }
  });
}

function heartbeatPilotUsage({ force = false } = {}) {
  if (!engine || !pilotSessionId) return null;
  const active = windowIsActivelyUsed();
  if (!force && active === lastPilotHeartbeatActive) return null;
  try {
    const result = engine.heartbeatPilotSession(pilotSessionId, { active });
    if (result?.updated === false) {
      pilotSessionId = null;
      lastPilotHeartbeatActive = null;
    } else {
      lastPilotHeartbeatActive = active;
    }
    return result;
  } catch (error) {
    console.warn("Heartbeat de la session pilote impossible :", error);
    return null;
  }
}

function beginPilotUsageSession() {
  if (!engine || pilotSessionId) return;
  try {
    const started = engine.beginPilotSession();
    if (typeof started?.sessionId !== "string" || !started.sessionId) {
      throw new Error("Identifiant de session pilote manquant.");
    }
    pilotSessionId = started.sessionId;
    // The database contract starts a session active. An immediate heartbeat
    // after createWindow() records the real initial foreground state.
    lastPilotHeartbeatActive = true;
  } catch (error) {
    console.warn("Démarrage de la session pilote impossible :", error);
    pilotSessionId = null;
    lastPilotHeartbeatActive = null;
  }
}

function endPilotUsageSession() {
  const sessionId = pilotSessionId;
  pilotSessionId = null;
  lastPilotHeartbeatActive = null;
  if (!engine || !sessionId) return;
  try {
    engine.endPilotSession(sessionId);
  } catch (error) {
    // Closing SQLite remains mandatory even if optional pilot accounting fails.
    console.warn("Fermeture de la session pilote impossible :", error);
  }
}

function trackActiveOperation(task) {
  activeOperations.add(task);
  task.then(
    () => activeOperations.delete(task),
    () => activeOperations.delete(task),
  );
  return task;
}

function runEngineOperation(operation) {
  if (isQuitting) throw new Error("L’application est en cours de fermeture.");
  const task = Promise.resolve().then(operation);
  return trackActiveOperation(task);
}

function registerIpcHandlers() {
  registerHandle("aggregator:get-state", () => engine.getState());
  registerHandle("aggregator:create-panel", (_event, input, placement) => runEngineOperation(async () => {
    const cleanedInput = cleanPanelInput(input);
    if (
      typeof cleanedInput === "object" &&
      cleanedInput.kind === "web" &&
      engine.getState().panels.filter((panel) => panel.kind === "web").length >=
        MAX_DASHBOARD_WEB_PANELS
    ) {
      throw new RangeError(
        `Le dashboard accepte jusqu’à ${MAX_DASHBOARD_WEB_PANELS} pages web simultanées.`,
      );
    }
    const state = await engine.createPanel(
      cleanedInput,
      cleanPanelPlacement(placement),
    );
    broadcastState(state);
    return state;
  }));
  registerHandle("aggregator:rename-panel", (_event, panelId, name) => runEngineOperation(async () => {
    const state = await engine.renamePanel(cleanId(panelId), cleanName(name));
    broadcastState(state);
    return state;
  }));
  registerHandle("aggregator:set-web-panel-url", (_event, panelId, url) => runEngineOperation(async () => {
    const state = await engine.setWebPanelUrl(cleanId(panelId), cleanSourceUrl(url));
    broadcastState(state);
    return state;
  }));
  registerHandle(
    "aggregator:set-feed-panel-default-refresh",
    (_event, panelId, refreshIntervalSeconds) => runEngineOperation(async () => {
      const state = await engine.setFeedPanelDefaultRefresh(
        cleanId(panelId),
        cleanRefreshInterval(refreshIntervalSeconds),
      );
      broadcastState(state);
      return state;
    }),
  );
  registerHandle(
    "aggregator:save-feed-panel-configuration",
    (_event, panelId, draft) => runEngineOperation(() =>
      // A scheduler pass may have broadcast an intermediate attachment while
      // this operation awaited the network. Always publish the committed or
      // restored database truth, including when save rejects after rollback.
      runWithFinalStateBroadcast(
        () => engine.saveFeedPanelConfiguration(
          cleanId(panelId),
          cleanFeedPanelConfigurationDraft(draft),
        ),
        {
          getState: () => engine.getState(),
          broadcast: (state) => broadcastState(state),
          onBroadcastError: (error) =>
            console.warn("Synchronisation finale du fil impossible :", error),
        },
      )),
  );
  registerHandle("aggregator:delete-panel", (_event, panelId) => runEngineOperation(async () => {
    const state = await engine.deletePanel(cleanId(panelId));
    broadcastState(state);
    return state;
  }));
  registerHandle(
    "aggregator:save-dashboard-layout",
    (_event, layout, expectedRevision) => runEngineOperation(async () => {
      const state = await engine.saveDashboardLayout(
        cleanDashboardLayout(layout),
        cleanDashboardRevision(expectedRevision),
      );
      broadcastState(state);
      return state;
    }),
  );
  registerHandle("aggregator:add-catalog-source", (_event, panelId, catalogId, options) => runEngineOperation(async () => {
    const result = await engine.addCatalogSource(
      cleanId(panelId),
      cleanId(catalogId),
      cleanSourceAddOptions(options),
    );
    broadcastState(result.state);
    return result;
  }));
  registerHandle("aggregator:add-source", (_event, panelId, source) => runEngineOperation(async () => {
    const result = await engine.addSource(cleanId(panelId), cleanSourceRequest(source));
    broadcastState(result.state);
    return result;
  }));
  registerHandle("aggregator:remove-source", (_event, panelId, sourceId) => runEngineOperation(async () => {
    const state = await engine.removeSource(cleanId(panelId), cleanId(sourceId));
    broadcastState(state);
    return state;
  }));
  registerHandle("aggregator:refresh-source", (_event, sourceId) => runEngineOperation(async () => {
    const refresh = engine.refreshSource(cleanId(sourceId), { force: true });
    broadcastState();
    const state = await refresh;
    broadcastState(state);
    return state;
  }));
  registerHandle("aggregator:refresh-all", () => runEngineOperation(async () => {
    const refresh = engine.refreshAll();
    broadcastState();
    const state = await refresh;
    broadcastState(state);
    return state;
  }));
  registerHandle("aggregator:mark-items-seen", (_event, itemIds) =>
    runEngineOperation(async () => {
      const state = await engine.markItemsSeen(cleanItemIds(itemIds));
      broadcastState(state);
      return state;
    }));
  registerHandle("aggregator:mark-item-opened", (_event, itemId) =>
    runEngineOperation(async () => {
      const state = await engine.markItemOpened(cleanId(itemId));
      broadcastState(state);
      return state;
    }));
  registerHandle("aggregator:export-dashboard", async (event, ...args) => {
    assertNoArguments(args);
    const window = requireMainSender(event);
    const selection = await dialog.showSaveDialog(window, {
      title: "Exporter le dashboard",
      defaultPath: datedJsonName("mediagen-dashboard"),
      filters: [{ name: "Dashboard MediaGen", extensions: ["json"] }],
      properties: ["createDirectory", "showOverwriteConfirmation"],
    });
    if (selection.canceled || !selection.filePath) {
      return { canceled: true, filePath: null };
    }
    return runEngineOperation(async () => {
      const configuration = engine.exportDashboardConfig();
      await writeJson(selection.filePath, configuration);
      return { canceled: false, filePath: selection.filePath };
    });
  });
  registerHandle("aggregator:import-dashboard", async (event, ...args) => {
    assertNoArguments(args);
    const window = requireMainSender(event);
    const selection = await dialog.showOpenDialog(window, {
      title: "Importer un dashboard",
      filters: [{ name: "Dashboard MediaGen", extensions: ["json"] }],
      properties: ["openFile"],
    });
    const filePath = selection.filePaths[0];
    if (selection.canceled || !filePath) {
      return { canceled: true, filePath: null, state: null, backupFilePath: null };
    }
    const configuration = await readImportedJson(filePath);
    const preview = engine.previewDashboardConfig(configuration);
    const currentPanelCount = engine.getState().panels.length;
    const shownHosts = preview.hosts.slice(0, 8);
    const hiddenHostCount = Math.max(0, preview.hosts.length - shownHosts.length);
    const hostSummary = shownHosts.length > 0
      ? `${shownHosts.join(", ")}${hiddenHostCount > 0 ? `, +${hiddenHostCount}` : ""}`
      : "aucun";
    const confirmation = await dialog.showMessageBox(window, {
      type: currentPanelCount > 0 ? "warning" : "question",
      title: "Confirmer l’import du dashboard",
      message: currentPanelCount > 0
        ? "Remplacer le dashboard actuel ?"
        : "Installer ce dashboard ?",
      detail: [
        `${preview.panels} panel(s), dont ${preview.feedPanels} fil(s) et ${preview.webPanels} page(s) web · ${preview.sources} source(s).`,
        `Hôtes réseau : ${hostSummary}.`,
        "Après l’installation, ces hôtes pourront être contactés automatiquement pour actualiser les panels.",
        currentPanelCount > 0
          ? "Une sauvegarde du dashboard actuel sera créée à côté du fichier importé si possible, avant le remplacement. Les articles en cache ne seront pas supprimés."
          : "Aucun dashboard actuel ne sera remplacé.",
      ].join("\n\n"),
      buttons: ["Annuler", currentPanelCount > 0 ? "Sauvegarder et remplacer" : "Installer"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (confirmation.response !== 1) {
      return { canceled: true, filePath, state: null, backupFilePath: null };
    }
    const imported = await runEngineOperation(async () => {
      if (currentPanelCount === 0) {
        return {
          state: await engine.importDashboardConfig(configuration),
          backupFilePath: null,
        };
      }
      return backupAndImportDashboard({
        engine,
        configuration,
        preferredDirectory: path.dirname(filePath),
        fallbackDirectory: path.join(app.getPath("userData"), "dashboard-backups"),
      });
    });
    const { state, backupFilePath } = imported;
    broadcastState(state);
    return { canceled: false, filePath, state, backupFilePath };
  });
  registerHandle("aggregator:export-diagnostics", async (event, ...args) => {
    assertNoArguments(args);
    if (typeof engine.getPilotDiagnostics !== "function") {
      throw new Error("Le diagnostic local n’est pas disponible dans cette version.");
    }
    const window = requireMainSender(event);
    const selection = await dialog.showSaveDialog(window, {
      title: "Exporter le diagnostic local",
      defaultPath: datedJsonName("mediagen-diagnostic"),
      filters: [{ name: "Diagnostic MediaGen", extensions: ["json"] }],
      properties: ["createDirectory", "showOverwriteConfirmation"],
    });
    if (selection.canceled || !selection.filePath) {
      return { canceled: true, filePath: null };
    }
    return runEngineOperation(async () => {
      const networkSources = engine.getState().sources.map((source) => ({
        sourceId: source.id,
        feedUrl: source.feedUrl,
      }));
      const enterpriseNetwork = await collectEnterpriseNetworkDiagnostics({
        networkSession: feedNetworkSession,
        sources: networkSources,
      });
      heartbeatPilotUsage({ force: true });
      const generatedAt = new Date().toISOString();
      const diagnostic = {
        format: DIAGNOSTICS_FORMAT,
        version: DIAGNOSTICS_VERSION,
        generatedAt,
        appVersion: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        runtimeVersions: {
          electron: process.versions.electron ?? null,
          chrome: process.versions.chrome ?? null,
          node: process.versions.node,
        },
        pilot: engine.getPilotDiagnostics(),
        enterpriseNetwork: {
          version: 1,
          sources: enterpriseNetwork,
        },
      };
      await writeJson(selection.filePath, diagnostic);
      engine.recordPilotEvent?.("diagnostics_exported", {});
      return { canceled: false, filePath: selection.filePath };
    });
  });
  registerHandle("shell:open-external", async (_event, url) => {
    await shell.openExternal(cleanHttpUrl(url), { activate: true });
  });
  registerHandle("web-session:clear-data", async (event, request) => {
    const { scope } = cleanWebDataRequest(request);
    const controller = controllerForEvent(event);
    if (resettingWebPanelControllers.has(controller)) {
      throw new Error("Un effacement des données web est déjà en cours.");
    }
    resettingWebPanelControllers.add(controller);
    try {
      return await runEngineOperation(async () => {
        // No page may keep handles to data while its profile is being erased.
        const descriptors = controller.getDescriptors();
        await controller.shutdown();
        const webSession = session.fromPartition(WEB_PANEL_SESSION_STRATEGY.partition);
        const result = await clearWebPanelSessionData(webSession, scope);
        if (!isQuitting) controller.sync(descriptors);
        return {
          ...result,
          clearedAt: new Date().toISOString(),
          panelsReloaded: descriptors.length,
        };
      });
    } finally {
      resettingWebPanelControllers.delete(controller);
    }
  });

  ipcMain.on("dashboard:focus", (event) => {
    try {
      requireMainSender(event).webContents.focus();
    } catch (error) {
      console.warn("Reprise du clavier par le dashboard refusée :", error);
    }
  });

  ipcMain.on("web-panels:sync", (event, descriptors) => {
    try {
      const controller = controllerForEvent(event);
      if (!resettingWebPanelControllers.has(controller)) controller.sync(descriptors);
    } catch (error) {
      // This one-way channel intentionally cannot mutate anything after a
      // validation failure. Navigation commands use invoke and reject instead.
      console.warn("Synchronisation des panels web refusée :", error);
    }
  });
  registerHandle("web-panels:navigate", (event, panelId, url) =>
    controllerForEvent(event).navigate(cleanId(panelId), cleanSourceUrl(url)));
  registerHandle("web-panels:reload", (event, panelId) =>
    controllerForEvent(event).reload(cleanId(panelId)));
  registerHandle("web-panels:stop", (event, panelId) =>
    controllerForEvent(event).stop(cleanId(panelId)));
  registerHandle("web-panels:go-back", (event, panelId) =>
    controllerForEvent(event).goBack(cleanId(panelId)));
  registerHandle("web-panels:go-forward", (event, panelId) =>
    controllerForEvent(event).goForward(cleanId(panelId)));
  registerHandle("web-panels:home", (event, panelId) =>
    controllerForEvent(event).home(cleanId(panelId)));
  registerHandle("web-panels:open-external", (event, panelId) =>
    controllerForEvent(event).openExternal(cleanId(panelId)));
  registerHandle("web-panels:set-muted", (event, panelId, muted) => {
    if (typeof muted !== "boolean") throw new TypeError("L’état audio doit être un booléen.");
    return controllerForEvent(event).setMuted(cleanId(panelId), muted);
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 860,
    minHeight: 600,
    title: "MediaGen Veille",
    autoHideMenuBar: true,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: process.platform === "darwin" ? { x: 18, y: 17 } : undefined,
    backgroundColor: "#11110F",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;

  const webPanelController = createWebPanelController({
    window,
    shell,
    onState: (state) => {
      sendToWindow(window, "web-panels:state-changed", state);
    },
    onEscape: (panelId) => {
      if (!window.isDestroyed()) {
        sendToWindow(window, "web-panels:escape", panelId);
        window.webContents.focus();
      }
    },
  });
  webPanelControllers.set(window, webPanelController);

  void window.loadURL(resolveRendererEntryUrl({
    isPackaged: app.isPackaged,
    developmentUrl: process.env.VITE_DEV_SERVER_URL,
    packagedUrl: APP_ENTRY_URL,
  }));

  window.once("ready-to-show", () => {
    if (!window.isDestroyed()) window.show();
  });
  for (const eventName of ["show", "hide", "focus", "blur", "minimize", "restore"]) {
    window.on(eventName, () => heartbeatPilotUsage());
  }
  window.on("close", () => destroyWebPanelController(window));
  window.on("closed", () => {
    destroyWebPanelController(window);
    if (mainWindow === window) mainWindow = null;
    heartbeatPilotUsage();
  });
  window.webContents.on(
    "did-start-navigation",
    (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame !== false && isInPlace !== true) {
        webPanelController.destroyAll();
      }
    },
  );
  window.webContents.on("render-process-gone", () => {
    webPanelController.destroyAll();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      void shell.openExternal(cleanHttpUrl(url));
    } catch {
      // Ignore non-web navigation requests.
    }
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
}

function refreshDueSources() {
  if (!refreshScheduler || isQuitting) return Promise.resolve();
  return refreshScheduler.run();
}

async function handleStartupFailure(error) {
  isQuitting = true;
  console.error("Démarrage de MediaGen Veille impossible :", error);
  if (refreshTimer) clearInterval(refreshTimer);
  if (pilotHeartbeatTimer) clearInterval(pilotHeartbeatTimer);
  refreshTimer = null;
  pilotHeartbeatTimer = null;
  refreshScheduler?.stop();
  engine?.cancelPending();
  await destroyAllWebPanelControllers();
  const pendingRefresh = refreshScheduler?.pending();
  if (pendingRefresh) await Promise.allSettled([pendingRefresh]);
  try {
    endPilotUsageSession();
    engine?.close();
  } catch (closeError) {
    console.error("Nettoyage après échec de démarrage incomplet :", closeError);
  }
  engine = null;
  feedNetworkSession = null;
  refreshScheduler = null;
  const detail = error instanceof Error ? error.message : "Erreur de démarrage inconnue.";
  dialog.showErrorBox(
    "MediaGen Veille ne peut pas démarrer",
    `${detail}\n\nLa base locale n’a pas été modifiée après cet échec. Contactez le support avec ce message.`,
  );
  shutdownComplete = true;
  app.exit(1);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    app.setName("MediaGen Veille");
    protocol.handle(
      APP_PROTOCOL_SCHEME,
      createAppProtocolHandler({
        assetRoot: path.join(__dirname, "..", "dist"),
        fetchFile: net.fetch,
      }),
    );
    const developmentDatabasePath = !app.isPackaged
      ? process.env.MEDIAGEN_DB_PATH
      : null;
    feedNetworkSession = session.fromPartition(FEED_NETWORK_PARTITION, {
      cache: false,
    });
    engine = createFeedEngine({
      dbPath: developmentDatabasePath
        ? path.resolve(developmentDatabasePath)
        : path.join(app.getPath("userData"), "veille.sqlite3"),
      fetchImpl: createElectronSessionFetch(feedNetworkSession),
      resolveHost: (hostname, options) =>
        feedNetworkSession.resolveHost(hostname, options),
      resolveProxy: (url) => feedNetworkSession.resolveProxy(url),
      requireHostResolution: app.isPackaged,
      requireProxyResolution: app.isPackaged,
      allowPrivateNetwork:
        !app.isPackaged && process.env.MEDIAGEN_ALLOW_PRIVATE_NETWORK === "true",
    });
    refreshScheduler = createRefreshScheduler({
      getSources: () => engine.getState().sources,
      refreshSource: (sourceId) => engine.refreshSource(sourceId),
      onStateChange: () => broadcastState(),
    });
    beginPilotUsageSession();
    registerIpcHandlers();
    createWindow();
    heartbeatPilotUsage({ force: true });

    refreshTimer = setInterval(() => void refreshDueSources(), REFRESH_TICK_MS);
    pilotHeartbeatTimer = setInterval(
      () => heartbeatPilotUsage({ force: true }),
      PILOT_HEARTBEAT_MS,
    );
    setTimeout(() => void refreshDueSources(), 750);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch((error) => void handleStartupFailure(error));
}

app.on("before-quit", (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (isQuitting) return;
  isQuitting = true;
  heartbeatPilotUsage({ force: true });
  if (pilotHeartbeatTimer) clearInterval(pilotHeartbeatTimer);
  pilotHeartbeatTimer = null;
  const pendingPersistence = [...activeOperations];
  const webCleanup = destroyAllWebPanelControllers();
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
  refreshScheduler?.stop();
  engine?.cancelPending();
  const pendingRefresh = refreshScheduler?.pending();
  if (pendingRefresh) pendingPersistence.push(pendingRefresh);
  if (!conductorShutdownRequested) pendingPersistence.push(webCleanup);

  void closePersistenceAfterPending({
    pending: pendingPersistence,
    deadlineMs: conductorShutdownRequested ? CONDUCTOR_SHUTDOWN_GRACE_MS : null,
    closePersistence: () => {
      try {
        endPilotUsageSession();
        engine?.close();
      } catch (error) {
        console.error("Fermeture de la base locale incomplète :", error);
      } finally {
        engine = null;
        feedNetworkSession = null;
        refreshScheduler = null;
      }
    },
  }).then(({ pendingSettled }) => {
    if (!pendingSettled) {
      console.warn("Fermeture Conductor forcée après annulation des opérations en cours.");
    }
    shutdownComplete = true;
    app.quit();
  }).catch((error) => {
    console.error("Arrêt de MediaGen Veille incomplet :", error);
    shutdownComplete = true;
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
