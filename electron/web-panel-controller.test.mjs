import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  clearWebPanelSessionData,
  collectEnterpriseNetworkDiagnostics,
  createElectronSessionFetch,
  createResolvedProxyDiagnostic,
  createWebPanelController,
  normalizeProxyRouteTypes,
  stopWebPanelSessionActivity,
  WEB_PANEL_SESSION_STRATEGY,
} from "./web-panel-controller.mjs";
import { normalizeExtractedArticle } from "./article-reader.mjs";

class FakeSession extends EventEmitter {
  constructor() {
    super();
    this.clearDataCalls = [];
    this.clearStorageDataCalls = [];
    this.clearCacheCalls = 0;
    this.clearAuthCacheCalls = 0;
    this.clearHostResolverCacheCalls = 0;
    this.serviceWorkers = {
      getAllRunning: () => ({ 17: { scope: "https://example.com/" } }),
    };
  }

  setPermissionCheckHandler(handler) {
    this.permissionCheckHandler = handler;
  }

  setPermissionRequestHandler(handler) {
    this.permissionRequestHandler = handler;
  }

  setDisplayMediaRequestHandler(handler) {
    this.displayMediaRequestHandler = handler;
  }

  async clearData(options) {
    this.clearDataCalls.push(options);
  }

  async clearStorageData(options) {
    this.clearStorageDataCalls.push(options);
  }

  async clearCache() {
    this.clearCacheCalls += 1;
  }

  async clearAuthCache() {
    this.clearAuthCacheCalls += 1;
  }

  async clearHostResolverCache() {
    this.clearHostResolverCacheCalls += 1;
  }
}

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.session = new FakeSession();
    this.audioMuted = false;
    this.destroyed = false;
    this.currentUrl = "";
    this.loadCalls = [];
    this.reloadCalls = 0;
    this.stopCalls = 0;
    this.closeCalls = [];
    this.focusCalls = 0;
    this.zoomLevel = 0;
    this.zoomCalls = [];
    this.history = {
      back: false,
      forward: false,
      goBackCalls: 0,
      goForwardCalls: 0,
    };
    this.navigationHistory = {
      canGoBack: () => this.history.back,
      canGoForward: () => this.history.forward,
      goBack: () => {
        this.history.goBackCalls += 1;
      },
      goForward: () => {
        this.history.goForwardCalls += 1;
      },
    };
  }

  isDestroyed() {
    return this.destroyed;
  }

  loadURL(url) {
    this.currentUrl = url;
    this.loadCalls.push(url);
    return Promise.resolve();
  }

  setWindowOpenHandler(handler) {
    this.windowOpenHandler = handler;
  }

  setAudioMuted(muted) {
    this.audioMuted = muted;
  }

  isAudioMuted() {
    return this.audioMuted;
  }

  reload() {
    this.reloadCalls += 1;
  }

  stop() {
    this.stopCalls += 1;
  }

  getURL() {
    return this.currentUrl;
  }

  focus() {
    this.focusCalls += 1;
  }

  getZoomLevel() {
    return this.zoomLevel;
  }

  setZoomLevel(level) {
    this.zoomLevel = level;
    this.zoomCalls.push(level);
  }

  close(options) {
    this.closeCalls.push(options);
    this.destroyed = true;
  }
}

function createHarness({
  contentSize = [800, 600],
  sharedWebSession = null,
  readerExtractionResult = null,
  viewCreationError = null,
} = {}) {
  const views = [];
  const addedViews = [];
  const removedViews = [];
  const states = [];
  const externalCalls = [];
  const escapeCalls = [];
  const readerExtractionCalls = [];
  const searchCalls = [];
  const creationEvents = [];
  const windowEvents = new Map();

  class FakeWebContentsView {
    constructor(options) {
      creationEvents.push("view");
      if (viewCreationError) throw viewCreationError;
      this.options = options;
      this.webContents = new FakeWebContents();
      if (sharedWebSession) this.webContents.session = sharedWebSession;
      this.boundsCalls = [];
      this.visibleCalls = [];
      views.push(this);
    }

    setBounds(bounds) {
      this.bounds = { ...bounds };
      this.boundsCalls.push({ ...bounds });
    }

    setVisible(visible) {
      this.visible = visible;
      this.visibleCalls.push(visible);
    }
  }

  const window = {
    contentView: {
      addChildView(view) {
        addedViews.push(view);
      },
      removeChildView(view) {
        removedViews.push(view);
      },
    },
    getContentSize: () => contentSize,
    isDestroyed: () => false,
    webContents: {
      focusCalls: 0,
      focus() {
        this.focusCalls += 1;
      },
      isDestroyed: () => false,
    },
    once(event, listener) {
      windowEvents.set(event, listener);
    },
  };
  const shell = {
    async openExternal(...args) {
      externalCalls.push(args);
    },
  };
  const controller = createWebPanelController({
    window,
    shell,
    extractArticle: async (input) => {
      readerExtractionCalls.push(input);
      const result = await (typeof readerExtractionResult === "function"
        ? readerExtractionResult(input)
        : readerExtractionResult);
      return typeof result?.ok === "boolean" ? result : normalizeExtractedArticle(result);
    },
    onState: (state) => {
      states.push(state);
      creationEvents.push(`state:${state.readerMode ?? "web"}`);
    },
    onEscape: (panelId) => escapeCalls.push(panelId),
    onOpenSearch: (panelId) => searchCalls.push(panelId),
    WebContentsViewClass: FakeWebContentsView,
  });

  return {
    addedViews,
    controller,
    creationEvents,
    externalCalls,
    escapeCalls,
    removedViews,
    readerExtractionCalls,
    searchCalls,
    states,
    views,
    window,
    windowEvents,
  };
}

function descriptor(panelId, overrides = {}) {
  return {
    panelId,
    url: "https://example.com/",
    bounds: { x: 10, y: 20, width: 300, height: 200 },
    visible: true,
    ...overrides,
  };
}

test("rejects non-http URLs and URLs containing credentials", () => {
  const { controller, views } = createHarness();

  assert.throws(
    () => controller.sync([descriptor("unsafe", { url: "file:///etc/passwd" })]),
    /http et https/,
  );
  assert.throws(
    () => controller.sync([descriptor("credentials", { url: "https://user:pass@example.com/" })]),
    /http et https/,
  );
  assert.equal(views.length, 0);

  controller.sync([descriptor("safe")]);
  assert.throws(
    () => controller.navigate("safe", "javascript:alert(1)"),
    /http et https/,
  );
  assert.throws(
    () => controller.navigate("safe", "https://user@example.com/private"),
    /http et https/,
  );
});

test("creates and syncs native views with clipped bounds and effective visibility", async () => {
  const { addedViews, controller, states, views } = createHarness();

  const initial = controller.sync([
    descriptor("news", {
      bounds: { x: 790, y: 590, width: 30, height: 20 },
    }),
  ]);
  await Promise.resolve();

  assert.equal(views.length, 1);
  assert.deepEqual(addedViews, views);
  assert.deepEqual(views[0].bounds, { x: 790, y: 590, width: 10, height: 10 });
  assert.equal(views[0].visible, true);
  assert.equal(initial[0].requestedVisible, true);
  assert.equal(initial[0].visible, true);
  assert.deepEqual(initial[0].bounds, { x: 790, y: 590, width: 10, height: 10 });
  assert.deepEqual(views[0].webContents.loadCalls, ["https://example.com/"]);
  const stateCountBeforeGeometryOnlySync = states.length;

  const updated = controller.sync([
    descriptor("news", {
      bounds: { x: 25, y: 35, width: 0, height: 100 },
      visible: true,
    }),
  ]);

  assert.equal(views.length, 1, "sync must reuse a view with the same panel id");
  assert.deepEqual(
    views[0].bounds,
    { x: 790, y: 590, width: 10, height: 10 },
    "hiding a clipped view must preserve its page viewport",
  );
  assert.equal(views[0].visible, false);
  assert.equal(updated[0].requestedVisible, true);
  assert.equal(updated[0].visible, false);
  assert.deepEqual(updated[0].bounds, { x: 25, y: 35, width: 0, height: 100 });
  assert.equal(
    states.length,
    stateCountBeforeGeometryOnlySync,
    "geometry-only sync must not round-trip runtime state to the renderer",
  );
});

test("rejects duplicate descriptors and enforces the migration-safe view limit", () => {
  const duplicateHarness = createHarness();
  assert.throws(
    () => duplicateHarness.controller.sync([descriptor("same"), descriptor("same")]),
    /présent plusieurs fois/,
  );
  assert.equal(duplicateHarness.views.length, 0);

  const limitHarness = createHarness();
  assert.throws(
    () =>
      limitHarness.controller.sync(
        Array.from({ length: 17 }, (_, index) => descriptor(`panel-${index}`)),
      ),
    /maximum de 16 panels web/,
  );
  assert.equal(limitHarness.views.length, 0);
});

test("allows safe navigation while preventing unsafe page-initiated navigation", async () => {
  const { controller, views } = createHarness();
  controller.sync([descriptor("news")]);
  const contents = views[0].webContents;

  let prevented = 0;
  contents.emit("will-navigate", { preventDefault: () => (prevented += 1) }, "file:///tmp/a");
  contents.emit(
    "will-redirect",
    { preventDefault: () => (prevented += 1) },
    "https://user:password@example.com/",
  );
  contents.emit(
    "will-navigate",
    { preventDefault: () => (prevented += 1) },
    "https://example.org/latest",
  );
  assert.equal(prevented, 2);

  await controller.navigate("news", "https://example.org/latest");
  assert.equal(contents.loadCalls.at(-1), "https://example.org/latest");

  contents.history.back = true;
  contents.history.forward = true;
  controller.goBack("news");
  controller.goForward("news");
  assert.equal(contents.history.goBackCalls, 1);
  assert.equal(contents.history.goForwardCalls, 1);
});

test("starts muted and updates audio state explicitly", () => {
  const { controller, views } = createHarness();
  const [initial] = controller.sync([descriptor("news")]);

  assert.equal(initial.muted, true);
  assert.equal(views[0].webContents.audioMuted, true);
  const unmuted = controller.setMuted("news", false);
  assert.equal(unmuted.muted, false);
  assert.equal(views[0].webContents.audioMuted, false);
  assert.throws(() => controller.setMuted("news", "false"), /booléen/);
});

test("installs fast arrow scrolling and focuses only the dedicated article reader", () => {
  const { controller, views } = createHarness();
  controller.sync([
    {
      ...descriptor("reader:article"),
      url: "https://www.lemonde.fr/article",
      kind: "reader",
      itemId: "article-1",
      connectorId: "le-monde",
      readerMode: "extracting",
    },
    descriptor("ordinary-browser", { url: "https://example.org/" }),
  ]);

  assert.match(
    views[0].options.webPreferences.preload,
    /article-reader-preload\.cjs$/,
  );
  assert.equal(views[0].webContents.focusCalls, 0, "the public page remains hidden while extracting");
  assert.equal(views[1].options.webPreferences.preload, undefined);
  assert.equal(views[1].webContents.focusCalls, 0);
});

test("rejects reader fallback reasons outside the closed runtime vocabulary", () => {
  const { controller, views } = createHarness();
  assert.throws(() => controller.sync([{
    ...descriptor("reader:article"),
    url: "https://www.lemonde.fr/article",
    kind: "reader",
    itemId: "article-1",
    connectorId: null,
    readerMode: "original",
    readerFallback: "publisher-secret",
  }]), /Motif de repli/);
  assert.equal(views.length, 0);
});

test("publishes an original-reader decision before allocating its native view", () => {
  const { controller, creationEvents, searchCalls, states, views, window } = createHarness();
  const [pendingReader] = controller.sync([{
    ...descriptor("reader:article"),
    url: "https://example.org/article",
    kind: "reader",
    itemId: "article-1",
    connectorId: null,
    readerMode: "original",
    readerFallback: "unsupported-source",
  }]);

  assert.deepEqual(creationEvents.slice(0, 2), ["state:original", "view"]);
  assert.equal(states[0].status, "loading");
  assert.equal(states[0].readerFallback, "unsupported-source");
  const initialFocusCalls = views[0].webContents.focusCalls;
  views[0].webContents.emit("dom-ready");
  assert.equal(views[0].webContents.focusCalls, initialFocusCalls + 1);
  views[0].webContents.emit("before-input-event", { preventDefault() {} }, {
    type: "keyDown", key: "k", meta: true,
  });
  assert.equal(views[0].visible, false);
  assert.deepEqual(searchCalls, ["reader:article"]);
  const hiddenFocusCalls = views[0].webContents.focusCalls;
  views[0].webContents.emit("dom-ready");
  assert.equal(views[0].webContents.focusCalls, hiddenFocusCalls);
  views[0].webContents.emit("before-input-event", {}, {
    type: "keyDown", key: "Escape",
  });
  assert.equal(window.webContents.focusCalls, 1);
});

test("clears a provisional original-reader decision when native allocation fails", () => {
  const { controller, states } = createHarness({
    viewCreationError: new Error("native allocation failed"),
  });

  assert.throws(() => controller.sync([{
    ...descriptor("reader:article"),
    url: "https://example.org/article",
    kind: "reader",
    itemId: "article-1",
    connectorId: null,
    readerMode: "original",
    readerFallback: "unsupported-source",
  }]), /native allocation failed/);

  assert.equal(states[0].status, "loading");
  assert.equal(states.at(-1).status, "destroyed");
});

test("keeps the public reader invisible until a bounded extraction becomes static", async () => {
  const articleText = "Contenu public structuré. ".repeat(30);
  const { controller, states, views } = createHarness({
    readerExtractionResult: {
      elementCount: 120,
      title: "Article public",
      blocks: [
        { kind: "paragraph", text: articleText },
        { kind: "heading", text: "Le contexte" },
        { kind: "paragraph", text: articleText },
      ],
    },
  });
  controller.sync([
    {
      ...descriptor("reader:article"),
      url: "https://www.lemonde.fr/article",
      kind: "reader",
      itemId: "article-1",
      connectorId: "le-monde",
      readerMode: "extracting",
    },
  ]);

  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(views[0].options.webPreferences.partition, "vibedeck-reader-static");
  assert.equal(views[0].webContents.loadCalls.length, 1);
  assert.match(views[0].webContents.loadCalls[0], /^data:text\/html/);
  assert.equal(views[0].visible, true);
  assert.equal(states.at(-1).readerMode, "simplified");
  assert.equal(states.at(-1).readerFallback, null);
});

test("applies pending reader bounds before revealing a completed extraction", async () => {
  let finishExtraction;
  const extraction = new Promise((resolve) => {
    finishExtraction = resolve;
  });
  const { controller, states, views } = createHarness({
    readerExtractionResult: () => extraction,
  });
  controller.sync([{
    ...descriptor("reader:article"),
    url: "https://www.lemonde.fr/article",
    kind: "reader",
    itemId: "article-1",
    connectorId: "le-monde",
    readerMode: "extracting",
  }]);
  const [pendingReader] = controller.sync([{
    ...descriptor("reader:article", {
      bounds: { x: 40, y: 50, width: 520, height: 360 },
    }),
    url: "https://www.lemonde.fr/article",
    kind: "reader",
    itemId: "article-1",
    connectorId: "le-monde",
    readerMode: "extracting",
  }]);

  assert.equal(views[0].visible, false);
  assert.deepEqual(pendingReader.bounds, { x: 40, y: 50, width: 520, height: 360 });
  assert.deepEqual(views[0].bounds, { x: 10, y: 20, width: 300, height: 200 });
  finishExtraction({
    elementCount: 120,
    title: "Article redimensionné",
    blocks: [
      { kind: "paragraph", text: "Contenu public structuré. ".repeat(30) },
      { kind: "heading", text: "Le contexte" },
      { kind: "paragraph", text: "Contenu public structuré. ".repeat(30) },
    ],
  });
  for (let attempt = 0; attempt < 10 && states.at(-1)?.readerMode !== "simplified"; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(states.at(-1)?.readerMode, "simplified");
  assert.deepEqual(views[0].bounds, { x: 40, y: 50, width: 520, height: 360 });
  assert.equal(views[0].visible, true);
});

test("recreates a persistent original reader after an extraction fallback", async () => {
  const stalledCleanupSession = new FakeSession();
  stalledCleanupSession.clearData = () => new Promise(() => {});
  const { controller, states, views } = createHarness({
    sharedWebSession: stalledCleanupSession,
    readerExtractionResult: { reason: "paywalled" },
  });
  controller.sync([
    {
      ...descriptor("reader:article"),
      url: "https://www.lemonde.fr/article",
      kind: "reader",
      itemId: "article-1",
      connectorId: "le-monde",
      readerMode: "extracting",
    },
  ]);

  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(views.length, 2);
  assert.equal(views[0].options.webPreferences.partition, "vibedeck-reader-static");
  assert.equal(views[1].options.webPreferences.partition, WEB_PANEL_SESSION_STRATEGY.partition);
  assert.deepEqual(views[1].webContents.loadCalls, ["https://www.lemonde.fr/article"]);
  assert.equal(states.at(-1).readerMode, "original");
  assert.equal(states.at(-1).readerFallback, "paywalled");
  assert.deepEqual(controller.getActiveReaderArticle("article-1"), {
    itemId: "article-1",
    url: "https://www.lemonde.fr/article",
    connectorId: null,
    readerMode: "original",
    readerFallback: "paywalled",
  });
  controller.retryOriginalArticle("article-1");
  assert.equal(views[1].webContents.reloadCalls, 1);
});

test("manual original mode replaces simplified content without accepting a renderer URL", async () => {
  const articleText = "Contenu public structuré. ".repeat(30);
  const { controller, views } = createHarness({
    readerExtractionResult: {
      elementCount: 120,
      title: "Article public",
      blocks: [
        { kind: "paragraph", text: articleText },
        { kind: "heading", text: "Le contexte" },
        { kind: "paragraph", text: articleText },
      ],
    },
  });
  controller.sync([
    {
      ...descriptor("reader:article"),
      url: "https://www.lemonde.fr/article",
      kind: "reader",
      itemId: "article-1",
      connectorId: "le-monde",
      readerMode: "extracting",
    },
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  controller.showOriginalArticle("article-1");
  assert.equal(views.length, 2);
  assert.equal(views[1].options.webPreferences.partition, WEB_PANEL_SESSION_STRATEGY.partition);
  assert.throws(
    () => controller.showOriginalArticle("article-forged"),
    /correspond pas/,
  );
});

test("keeps the extracting view inert and aborts a stale extraction after close", async () => {
  let finishExtraction;
  const extraction = new Promise((resolve) => {
    finishExtraction = resolve;
  });
  let extractionSignal;
  const { controller, views } = createHarness({
    readerExtractionResult: ({ signal }) => {
      extractionSignal = signal;
      return extraction;
    },
  });
  controller.sync([
    {
      ...descriptor("reader:article"),
      url: "https://www.lemonde.fr/article",
      kind: "reader",
      itemId: "article-1",
      connectorId: "le-monde",
      readerMode: "extracting",
    },
  ]);
  await new Promise((resolve) => setImmediate(resolve));

  let prevented = false;
  views[0].webContents.emit("will-redirect", {
    preventDefault: () => (prevented = true),
  }, "https://attacker.test/article");
  assert.equal(prevented, true);

  controller.sync([]);
  assert.equal(extractionSignal.aborted, true);
  finishExtraction({
    elementCount: 120,
    title: "Article public",
    blocks: [
      { kind: "paragraph", text: "Contenu public structuré. ".repeat(30) },
      { kind: "heading", text: "Le contexte" },
      { kind: "paragraph", text: "Contenu public structuré. ".repeat(30) },
    ],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(views[0].webContents.loadCalls.some((url) => url.startsWith("data:text/html")), false);
});

test("rejects generic web commands for the dedicated reader", () => {
  const { controller } = createHarness();
  controller.sync([{
    ...descriptor("reader:article"),
    url: "https://www.lemonde.fr/article",
    kind: "reader",
    itemId: "article-1",
    connectorId: "le-monde",
    readerMode: "extracting",
  }]);

  assert.throws(
    () => controller.navigate("reader:article", "https://example.org/"),
    /réservée aux panels web/,
  );
  for (const command of ["reload", "stop", "goBack", "goForward", "home"]) {
    assert.throws(() => controller[command]("reader:article"), /réservée aux panels web/);
  }
  assert.throws(
    () => controller.setMuted("reader:article", false),
    /réservée aux panels web/,
  );
});

test("destroys omitted views and destroyAll closes every remaining WebContents", () => {
  const { controller, removedViews, states, views } = createHarness();
  controller.sync([descriptor("left"), descriptor("right")]);

  controller.sync([descriptor("right")]);
  assert.deepEqual(removedViews, [views[0]]);
  assert.equal(views[0].visible, false);
  assert.deepEqual(views[0].webContents.closeCalls, [{ waitForBeforeUnload: false }]);
  assert.equal(states.findLast((state) => state.panelId === "left").destroyed, true);

  assert.equal(controller.destroyAll(), 1);
  assert.deepEqual(removedViews, [views[0], views[1]]);
  assert.deepEqual(views[1].webContents.closeCalls, [{ waitForBeforeUnload: false }]);
  assert.equal(controller.destroyAll(), 0);
});

test("denies permissions, downloads and popups while opening safe popup links in place", () => {
  const { controller, escapeCalls, searchCalls, views } = createHarness();
  controller.sync([descriptor("locked-down")]);
  const view = views[0];
  const contents = view.webContents;
  const session = contents.session;

  assert.equal(view.options.webPreferences.nodeIntegration, false);
  assert.equal(view.options.webPreferences.contextIsolation, true);
  assert.equal(view.options.webPreferences.sandbox, true);
  assert.equal(view.options.webPreferences.webviewTag, false);
  assert.equal(session.permissionCheckHandler(), false);

  let permissionGranted = true;
  session.permissionRequestHandler(contents, "geolocation", (granted) => {
    permissionGranted = granted;
  });
  assert.equal(permissionGranted, false);

  let displayMediaResult;
  session.displayMediaRequestHandler({}, (result) => {
    displayMediaResult = result;
  });
  assert.deepEqual(displayMediaResult, {});

  let downloadPrevented = false;
  let downloadCancelled = false;
  session.emit(
    "will-download",
    { preventDefault: () => (downloadPrevented = true) },
    { cancel: () => (downloadCancelled = true) },
  );
  assert.equal(downloadPrevented, true);
  assert.equal(downloadCancelled, true);
  assert.deepEqual(contents.windowOpenHandler({ url: "https://example.org/popup" }), {
    action: "deny",
  });
  assert.equal(contents.loadCalls.at(-1), "https://example.org/popup");
  contents.windowOpenHandler({ url: "javascript:alert(1)" });
  assert.equal(contents.loadCalls.at(-1), "https://example.org/popup");

  let webviewPrevented = false;
  contents.emit("will-attach-webview", {
    preventDefault: () => (webviewPrevented = true),
  });
  assert.equal(webviewPrevented, true);

  contents.emit("before-input-event", {}, { type: "keyDown", key: "Escape" });
  contents.emit("before-input-event", {}, { type: "keyDown", key: "Escape", isAutoRepeat: true });
  assert.deepEqual(escapeCalls, ["locked-down"]);
  let searchPrevented = false;
  contents.emit("before-input-event", { preventDefault: () => { searchPrevented = true; } }, {
    type: "keyDown", key: "k", meta: true,
  });
  contents.emit("before-input-event", {}, {
    type: "keyDown", key: "k", control: true, isAutoRepeat: true,
  });
  assert.equal(searchPrevented, true);
  assert.deepEqual(searchCalls, ["locked-down"]);
  assert.equal(view.visible, false);
  controller.sync([descriptor("locked-down")]);
  assert.equal(controller.focus("locked-down"), true);
  assert.equal(contents.focusCalls, 1);
});

// Doit rester aligné sur ZOOM_SHORTCUT_LEVEL_LIMIT dans web-panel-controller.mjs.
const ZOOM_LIMIT_PROBE = 5;

test("zooms the embedded page with Cmd/Ctrl +, -, 0 now that the menu roles are stripped", () => {
  const { controller, views } = createHarness();
  controller.sync([descriptor("news")]);
  const contents = views[0].webContents;

  let prevented = 0;
  const event = { preventDefault: () => (prevented += 1) };
  contents.emit("before-input-event", event, { type: "keyDown", key: "+", meta: true });
  assert.deepEqual(contents.zoomCalls, [0.5], "Cmd + doit zoomer d'un cran");
  contents.emit("before-input-event", event, { type: "keyDown", key: "=", control: true });
  assert.deepEqual(contents.zoomCalls, [0.5, 1], "Ctrl = doit compter comme zoom avant");
  contents.emit("before-input-event", event, { type: "keyDown", key: "-", meta: true });
  assert.deepEqual(contents.zoomCalls, [0.5, 1, 0.5]);
  // AZERTY : la touche 0 non shiftée produit key "à" mais code "Digit0".
  contents.emit("before-input-event", event, {
    type: "keyDown", key: "à", code: "Digit0", meta: true,
  });
  assert.deepEqual(contents.zoomCalls, [0.5, 1, 0.5, 0], "Cmd 0 doit réinitialiser");
  assert.equal(prevented, 4, "chaque raccourci géré doit être consommé");

  // Une frappe AltGr (ctrl+alt), un simple keyUp, ou Ctrl+Insert (Numpad0
  // sans NumLock = copie) ne doivent rien déclencher.
  contents.emit("before-input-event", event, {
    type: "keyDown", key: "+", control: true, alt: true,
  });
  contents.emit("before-input-event", event, { type: "keyUp", key: "+", meta: true });
  contents.emit("before-input-event", event, {
    type: "keyDown", key: "Insert", code: "Numpad0", control: true,
  });
  assert.equal(contents.zoomCalls.length, 4);

  // Le niveau reste borné.
  contents.zoomLevel = ZOOM_LIMIT_PROBE;
  contents.emit("before-input-event", event, { type: "keyDown", key: "+", meta: true });
  assert.equal(contents.zoomCalls.at(-1), ZOOM_LIMIT_PROBE, "le plafond de zoom doit tenir");
});

test("documents the persistent web session while clearing background workers on shutdown", async () => {
  const { controller, views } = createHarness();
  controller.sync([descriptor("news")]);
  const webSession = views[0].webContents.session;

  assert.equal(WEB_PANEL_SESSION_STRATEGY.partition, "persist:vibedeck-web-panels");
  assert.equal(WEB_PANEL_SESSION_STRATEGY.persistent, true);
  assert.deepEqual(WEB_PANEL_SESSION_STRATEGY.retainedWhenClosed, [
    "cookies",
    "local-storage",
    "http-cache",
  ]);
  assert.deepEqual(controller.getDescriptors(), [descriptor("news")]);

  await controller.shutdown();
  assert.deepEqual(webSession.clearDataCalls, [{ dataTypes: ["serviceWorkers"] }]);
  assert.equal(views[0].webContents.destroyed, true);
});

test("creates one secure preview in the shared persistent session without exposing it to sync", async () => {
  const sharedWebSession = new FakeSession();
  const { controller, removedViews, states, views } = createHarness({ sharedWebSession });
  controller.sync([descriptor("news")]);

  const initial = controller.startPreview(
    descriptor("preview:add-panel", {
      url: "https://accounts.example.org/login",
      bounds: { x: 50, y: 60, width: 420, height: 300 },
    }),
  );
  await Promise.resolve();

  assert.equal(initial.panelId, "preview:add-panel");
  assert.equal(views.length, 2);
  assert.deepEqual(views[1].options.webPreferences, views[0].options.webPreferences);
  assert.equal(
    views[1].options.webPreferences.partition,
    WEB_PANEL_SESSION_STRATEGY.partition,
  );
  assert.equal(views[1].webContents.session, sharedWebSession);
  assert.deepEqual(views[1].webContents.loadCalls, [
    "https://accounts.example.org/login",
  ]);

  controller.sync([descriptor("news", { bounds: { x: 0, y: 0, width: 200, height: 180 } })]);
  assert.equal(views[1].webContents.destroyed, false);
  assert.equal(views[1].visible, true);
  assert.deepEqual(controller.getDescriptors(), [
    descriptor("news", { bounds: { x: 0, y: 0, width: 200, height: 180 } }),
  ]);
  assert.equal(
    states.findLast((state) => state.panelId === "preview:add-panel").destroyed,
    false,
  );
  assert.deepEqual(removedViews, []);
});

test("updates and navigates an existing preview while enforcing a one-preview limit", async () => {
  const { controller, states, views } = createHarness();
  controller.startPreview(descriptor("preview:add-panel"));
  await Promise.resolve();

  const updated = controller.startPreview(
    descriptor("preview:add-panel", {
      url: "https://example.org/sign-in",
      bounds: { x: 30, y: 40, width: 500, height: 400 },
      visible: false,
    }),
  );
  assert.equal(views.length, 1, "updating a preview must reuse its native view");
  assert.equal(updated.homeUrl, "https://example.org/sign-in");
  assert.deepEqual(
    views[0].bounds,
    { x: 10, y: 20, width: 300, height: 200 },
    "a hidden preview must keep its previous page viewport",
  );
  assert.equal(views[0].visible, false);
  assert.equal(views[0].webContents.loadCalls.at(-1), "https://example.org/sign-in");

  controller.startPreview(
    descriptor("preview:add-panel", {
      url: "https://example.org/sign-in",
      bounds: { x: 30, y: 40, width: 500, height: 400 },
      visible: true,
    }),
  );
  assert.deepEqual(views[0].bounds, { x: 30, y: 40, width: 500, height: 400 });
  assert.equal(views[0].visible, true);
  await Promise.resolve();
  const stateCountBeforeGeometryOnlySync = states.length;
  controller.startPreview(
    descriptor("preview:add-panel", {
      url: "https://example.org/sign-in",
      bounds: { x: 35, y: 45, width: 490, height: 390 },
      visible: true,
    }),
  );
  assert.equal(
    states.length,
    stateCountBeforeGeometryOnlySync,
    "geometry-only preview sync must not round-trip runtime state",
  );

  await controller.navigate("preview:add-panel", "https://example.org/account");
  assert.equal(views[0].webContents.loadCalls.at(-1), "https://example.org/account");
  assert.throws(
    () => controller.startPreview(descriptor("preview:second")),
    /Un seul aperçu web/,
  );
  assert.equal(views.length, 1);

  assert.throws(
    () => controller.sync([descriptor("preview:add-panel")]),
    /déjà utilisé par l’aperçu/,
  );
  assert.equal(views[0].webContents.destroyed, false);

  assert.throws(
    () => controller.sync([{ ...descriptor("preview:forged"), kind: "preview" }]),
    /startPreview/,
  );
  assert.equal(views.length, 1);
});

test("cancels a preview while retaining login data and clearing only service workers", async () => {
  const sharedWebSession = new FakeSession();
  const { controller, removedViews, states, views } = createHarness({ sharedWebSession });
  controller.startPreview(
    descriptor("preview:add-panel", { url: "https://accounts.example.org/login" }),
  );
  await Promise.resolve();

  assert.equal(controller.cancelPreview("preview:other"), false);
  assert.equal(controller.cancelPreview("preview:add-panel"), true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(removedViews, [views[0]]);
  assert.deepEqual(views[0].webContents.closeCalls, [{ waitForBeforeUnload: false }]);
  assert.equal(states.at(-1).destroyed, true);
  assert.deepEqual(sharedWebSession.clearDataCalls, [
    { dataTypes: ["serviceWorkers"] },
  ]);
  assert.equal(sharedWebSession.clearStorageDataCalls.length, 0);
  assert.equal(sharedWebSession.clearCacheCalls, 0);
});

test("applies panel security controls to previews and refuses HTTP auth", async () => {
  const { controller, views } = createHarness();
  assert.throws(
    () => controller.startPreview(descriptor("preview:unsafe", { url: "file:///tmp/a" })),
    /http et https/,
  );
  assert.throws(
    () => controller.startPreview(
      descriptor("preview:credentials", { url: "https://user:pass@example.org/" }),
    ),
    /http et https/,
  );
  assert.equal(views.length, 0);

  controller.startPreview(descriptor("preview:add-panel"));
  await Promise.resolve();
  const { webContents: contents } = views[0];
  const { session } = contents;

  assert.equal(views[0].options.webPreferences.nodeIntegration, false);
  assert.equal(views[0].options.webPreferences.contextIsolation, true);
  assert.equal(views[0].options.webPreferences.sandbox, true);
  assert.equal(session.permissionCheckHandler(), false);

  let preventedNavigation = false;
  contents.emit("will-navigate", {
    preventDefault: () => {
      preventedNavigation = true;
    },
  }, "javascript:alert(1)");
  assert.equal(preventedNavigation, true);

  let authPrevented = false;
  let authCallbackCalls = 0;
  contents.emit(
    "login",
    { preventDefault: () => { authPrevented = true; } },
    {},
    { isProxy: false },
    () => { authCallbackCalls += 1; },
  );
  assert.equal(authPrevented, true);
  assert.equal(authCallbackCalls, 1);

  assert.deepEqual(contents.windowOpenHandler({ url: "https://example.org/popup" }), {
    action: "deny",
  });
  assert.equal(contents.loadCalls.at(-1), "https://example.org/popup");
});

test("clears workers from a closed panel without stopping origins still open elsewhere", async () => {
  const sharedWebSession = new FakeSession();
  const { controller } = createHarness({ sharedWebSession });
  controller.sync([
    descriptor("closed-news", { url: "https://closed.example/start" }),
    descriptor("live-news", { url: "https://live.example/direct" }),
  ]);
  await controller.navigate("closed-news", "https://live.example/article");

  assert.equal(controller.destroy("closed-news"), true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(sharedWebSession.clearDataCalls, [
    {
      dataTypes: ["serviceWorkers"],
      origins: ["https://closed.example"],
    },
  ]);

  assert.equal(controller.destroy("live-news"), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sharedWebSession.clearDataCalls.at(-1), {
    dataTypes: ["serviceWorkers"],
  });
});

test("hides a crashed renderer and restores it only on an explicit reload", () => {
  const { controller, states, views } = createHarness();
  controller.sync([descriptor("news")]);
  const view = views[0];

  view.webContents.emit("render-process-gone", {}, { reason: "crashed" });
  assert.equal(view.visible, false);
  assert.equal(states.at(-1).status, "crashed");
  assert.equal(states.at(-1).crashed, true);

  controller.sync([descriptor("news")]);
  assert.equal(view.visible, false, "a normal sync must not revive a crashed page");
  const reloading = controller.reload("news");
  assert.equal(reloading.status, "loading");
  assert.equal(reloading.loading, true);
  assert.equal(states.at(-1).status, "loading");
  assert.equal(view.visible, true);
  assert.equal(view.webContents.reloadCalls, 1);

  view.webContents.emit("did-stop-loading");
  assert.equal(states.at(-1).status, "ready");
  assert.equal(states.at(-1).loading, false);
});

test("emits one state update for duplicate main-frame in-page navigations", () => {
  const { controller, states, views } = createHarness();
  controller.sync([descriptor("news")]);
  const contents = views[0].webContents;
  const initialStateCount = states.length;

  contents.emit(
    "did-navigate-in-page",
    {},
    "https://example.com/#direct",
    true,
  );
  contents.emit(
    "did-navigate-in-page",
    {},
    "https://example.com/#direct",
    true,
  );
  contents.emit(
    "did-navigate-in-page",
    {},
    "https://example.com/#iframe",
    false,
  );

  assert.equal(states.length, initialStateCount + 1);
  assert.equal(states.at(-1).url, "https://example.com/#direct");
});

test("rejects a navigation result that completes after its view was closed", async () => {
  const { controller, views } = createHarness();
  controller.sync([descriptor("news")]);
  await Promise.resolve();

  let finishNavigation;
  views[0].webContents.loadURL = () =>
    new Promise((resolve) => {
      finishNavigation = resolve;
    });
  const navigation = controller.navigate("news", "https://example.org/latest");
  controller.destroy("news");
  finishNavigation();

  await assert.rejects(navigation, /remplacé ou fermé/);
});

test("uses Electron session fetch and bypasses custom protocol handlers", async () => {
  const calls = [];
  const response = {
    ok: true,
    status: 200,
    headers: { get: () => null },
  };
  const fetchImpl = createElectronSessionFetch({
    async fetch(...args) {
      calls.push(args);
      return response;
    },
  });

  const result = await fetchImpl("https://example.com/feed.xml", {
    method: "GET",
    headers: { Accept: "application/rss+xml" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.url, "https://example.com/feed.xml");
  assert.equal(result.redirected, false);
  assert.deepEqual(calls, [
    [
      "https://example.com/feed.xml",
      {
        method: "GET",
        headers: { Accept: "application/rss+xml" },
        bypassCustomProtocolHandlers: true,
      },
    ],
  ]);
  assert.throws(() => createElectronSessionFetch({}), /ne fournit pas fetch/);
});

test("tracks Electron redirects and reports the final URL", async () => {
  const calls = [];
  let redirectListener;
  const networkSession = {
    webRequest: {
      onBeforeRedirect(_filter, listener) {
        redirectListener = listener;
      },
    },
    async fetch(...args) {
      calls.push(args);
      redirectListener({
        id: 42,
        url: "https://news.example/start",
        redirectURL: "https://cdn.example/final.xml",
      });
      return {
        status: 200,
        ok: true,
        url: "",
        redirected: false,
        headers: { get: () => null },
        text: async () => "feed",
      };
    },
  };
  const fetchImpl = createElectronSessionFetch(networkSession);

  const result = await fetchImpl("https://news.example/start", {
    method: "GET",
    headers: {
      Accept: "application/rss+xml",
      Authorization: "secret",
    },
    redirect: "follow",
  });

  assert.equal(result.url, "https://cdn.example/final.xml");
  assert.equal(result.redirected, true);
  assert.equal(await result.text(), "feed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "https://news.example/start");
  assert.equal(calls[0][1].redirect, "follow");
  assert.equal(calls[0][1].bypassCustomProtocolHandlers, true);
});

test("clears only the selected web-profile data scope", async () => {
  const cacheSession = new FakeSession();
  const cacheResult = await clearWebPanelSessionData(cacheSession, "cache");
  assert.deepEqual(cacheResult.cleared, ["http-cache"]);
  assert.equal(cacheSession.clearCacheCalls, 1);
  assert.equal(cacheSession.clearStorageDataCalls.length, 0);

  const allSession = new FakeSession();
  const allResult = await clearWebPanelSessionData(allSession, "all");
  assert.equal(allSession.clearCacheCalls, 1);
  assert.deepEqual(allSession.clearStorageDataCalls, [undefined]);
  assert.equal(allSession.clearAuthCacheCalls, 1);
  assert.equal(allSession.clearHostResolverCacheCalls, 1);
  assert.ok(allResult.cleared.includes("service-workers"));
  await assert.rejects(
    () => clearWebPanelSessionData(allSession, "cookies-only"),
    /invalide/,
  );

  const activitySession = new FakeSession();
  const activity = await stopWebPanelSessionActivity(activitySession);
  assert.equal(activity.runningServiceWorkers, 1);
  assert.equal(activity.origins, null);
  assert.deepEqual(activitySession.clearDataCalls, [
    { dataTypes: ["serviceWorkers"] },
  ]);

  const scopedSession = new FakeSession();
  const scoped = await stopWebPanelSessionActivity(scopedSession, [
    "https://one.example",
    "https://one.example",
    "https://two.example:8443",
  ]);
  assert.deepEqual(scoped.origins, [
    "https://one.example",
    "https://two.example:8443",
  ]);
  assert.deepEqual(scopedSession.clearDataCalls, [
    {
      dataTypes: ["serviceWorkers"],
      origins: ["https://one.example", "https://two.example:8443"],
    },
  ]);
  await assert.rejects(
    () => stopWebPanelSessionActivity(scopedSession, ["https://one.example/path"]),
    /origines web invalide/,
  );
});

test("normalizes proxy routes without retaining hosts, ports or PAC text", () => {
  const raw = [
    "PROXY secret.proxy.afp:8080",
    "DIRECT",
    "HTTPS secure.proxy.afp:443",
    "SOCKS5://socks.proxy.afp:1080",
    "QUIC quic.proxy.afp:443",
    "MASQUE should-never-leak.afp:8443",
    "PROXY duplicate.proxy.afp:3128",
  ].join("; ");

  assert.deepEqual(normalizeProxyRouteTypes(raw), [
    "proxy",
    "direct",
    "https-proxy",
    "socks",
    "quic",
    "unknown",
  ]);
  const diagnostic = createResolvedProxyDiagnostic("source-1", raw);
  assert.deepEqual(diagnostic, {
    sourceId: "source-1",
    resolutionStatus: "resolved",
    routeTypes: ["proxy", "direct", "https-proxy", "socks", "quic", "unknown"],
  });
  const serialized = JSON.stringify(diagnostic);
  assert.doesNotMatch(serialized, /afp|8080|8443|MASQUE/i);
});

test("collects anonymized enterprise network diagnostics for success and failure", async () => {
  const requestedUrls = [];
  const result = await collectEnterpriseNetworkDiagnostics({
    networkSession: {
      async resolveProxy(url) {
        requestedUrls.push(url);
        if (url.includes("failure")) {
          throw new Error("PAC secret.proxy.afp:8080 refused this URL");
        }
        return "HTTPS hidden.proxy.afp:443; DIRECT";
      },
    },
    sources: [
      { sourceId: "healthy-source", feedUrl: "https://feeds.example/success.xml" },
      { sourceId: "failed-source", feedUrl: "https://feeds.example/failure.xml" },
    ],
  });

  assert.deepEqual(requestedUrls, [
    "https://feeds.example/success.xml",
    "https://feeds.example/failure.xml",
  ]);
  assert.deepEqual(result, [
    {
      sourceId: "healthy-source",
      resolutionStatus: "resolved",
      routeTypes: ["https-proxy", "direct"],
    },
    {
      sourceId: "failed-source",
      resolutionStatus: "failed",
      routeTypes: [],
    },
  ]);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /feeds\.example|proxy\.afp|8080|refused/i);
});

test("reports proxy resolution as unavailable without a Chromium session", async () => {
  const result = await collectEnterpriseNetworkDiagnostics({
    networkSession: null,
    sources: [
      { sourceId: "offline-source", feedUrl: "https://private.example/feed.xml" },
    ],
  });
  assert.deepEqual(result, [
    {
      sourceId: "offline-source",
      resolutionStatus: "unavailable",
      routeTypes: [],
    },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /private\.example/);
});
