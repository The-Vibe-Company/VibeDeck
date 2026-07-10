const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mediagen", {
  getState: () => ipcRenderer.invoke("aggregator:get-state"),
  createPanel: (input, placement) =>
    ipcRenderer.invoke("aggregator:create-panel", input, placement),
  renamePanel: (panelId, name) =>
    ipcRenderer.invoke("aggregator:rename-panel", panelId, name),
  setWebPanelUrl: (panelId, url) =>
    ipcRenderer.invoke("aggregator:set-web-panel-url", panelId, url),
  setFeedPanelDefaultRefresh: (panelId, refreshIntervalSeconds) =>
    ipcRenderer.invoke(
      "aggregator:set-feed-panel-default-refresh",
      panelId,
      refreshIntervalSeconds,
    ),
  saveFeedPanelConfiguration: (panelId, draft) =>
    ipcRenderer.invoke(
      "aggregator:save-feed-panel-configuration",
      panelId,
      draft,
    ),
  deletePanel: (panelId) => ipcRenderer.invoke("aggregator:delete-panel", panelId),
  saveDashboardLayout: (layout, expectedRevision) =>
    ipcRenderer.invoke(
      "aggregator:save-dashboard-layout",
      layout,
      expectedRevision,
    ),
  addCatalogSource: (panelId, catalogId, options) =>
    ipcRenderer.invoke("aggregator:add-catalog-source", panelId, catalogId, options),
  addSource: (panelId, source) =>
    ipcRenderer.invoke("aggregator:add-source", panelId, source),
  removeSource: (panelId, sourceId) =>
    ipcRenderer.invoke("aggregator:remove-source", panelId, sourceId),
  refreshSource: (sourceId) =>
    ipcRenderer.invoke("aggregator:refresh-source", sourceId),
  refreshAll: () => ipcRenderer.invoke("aggregator:refresh-all"),
  markItemsSeen: (itemIds) =>
    ipcRenderer.invoke("aggregator:mark-items-seen", itemIds),
  markItemOpened: (itemId) =>
    ipcRenderer.invoke("aggregator:mark-item-opened", itemId),
  getSemanticSearchStatus: () => ipcRenderer.invoke("semantic-search:get-status"),
  prepareSemanticSearch: () => ipcRenderer.invoke("semantic-search:prepare"),
  cancelSemanticSearchPreparation: () =>
    ipcRenderer.invoke("semantic-search:cancel-preparation"),
  searchFeedItems: (request) => ipcRenderer.invoke("semantic-search:search", request),
  removeSemanticSearchData: () => ipcRenderer.invoke("semantic-search:remove-data"),
  finishSemanticSearchFocus: (restoreNative) =>
    ipcRenderer.send("semantic-search:finish-focus", restoreNative),
  exportDashboard: () => ipcRenderer.invoke("aggregator:export-dashboard"),
  importDashboard: () => ipcRenderer.invoke("aggregator:import-dashboard"),
  exportDiagnostics: () => ipcRenderer.invoke("aggregator:export-diagnostics"),
  clearWebData: () =>
    ipcRenderer.invoke("web-session:clear-data", { scope: "all" }).then(() => undefined),
  openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
  focusDashboard: () => ipcRenderer.send("dashboard:focus"),
  syncWebPanels: (panels) => ipcRenderer.send("web-panels:sync", panels),
  navigateWebPanel: (panelId, url) =>
    ipcRenderer.invoke("web-panels:navigate", panelId, url).then(() => undefined),
  reloadWebPanel: (panelId) =>
    ipcRenderer.invoke("web-panels:reload", panelId).then(() => undefined),
  stopWebPanel: (panelId) =>
    ipcRenderer.invoke("web-panels:stop", panelId).then(() => undefined),
  goBackWebPanel: (panelId) =>
    ipcRenderer.invoke("web-panels:go-back", panelId).then(() => undefined),
  goForwardWebPanel: (panelId) =>
    ipcRenderer.invoke("web-panels:go-forward", panelId).then(() => undefined),
  homeWebPanel: (panelId) =>
    ipcRenderer.invoke("web-panels:home", panelId).then(() => undefined),
  openExternalWebPanel: (panelId) =>
    ipcRenderer.invoke("web-panels:open-external", panelId).then(() => undefined),
  showOriginalArticle: (itemId) =>
    ipcRenderer.invoke("reader:show-original", itemId).then(() => undefined),
  retryOriginalArticle: (itemId) =>
    ipcRenderer.invoke("reader:retry-original", itemId).then(() => undefined),
  setWebPanelMuted: (panelId, muted) =>
    ipcRenderer.invoke("web-panels:set-muted", panelId, muted).then(() => undefined),
  onStateChanged: (callback) => {
    if (typeof callback !== "function") throw new TypeError("Callback invalide.");
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("aggregator:state-changed", listener);
    return () => ipcRenderer.removeListener("aggregator:state-changed", listener);
  },
  onWebPanelStateChanged: (callback) => {
    if (typeof callback !== "function") throw new TypeError("Callback invalide.");
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("web-panels:state-changed", listener);
    return () => ipcRenderer.removeListener("web-panels:state-changed", listener);
  },
  onWebPanelEscape: (callback) => {
    if (typeof callback !== "function") throw new TypeError("Callback invalide.");
    const listener = (_event, panelId) => callback(panelId);
    ipcRenderer.on("web-panels:escape", listener);
    return () => ipcRenderer.removeListener("web-panels:escape", listener);
  },
  onSemanticSearchStatusChanged: (callback) => {
    if (typeof callback !== "function") throw new TypeError("Callback invalide.");
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("semantic-search:status-changed", listener);
    return () => ipcRenderer.removeListener("semantic-search:status-changed", listener);
  },
  onOpenGlobalSearch: (callback) => {
    if (typeof callback !== "function") throw new TypeError("Callback invalide.");
    const listener = (_event, nativeOrigin) => callback(nativeOrigin === true);
    ipcRenderer.on("semantic-search:open-global", listener);
    return () => ipcRenderer.removeListener("semantic-search:open-global", listener);
  },
});
