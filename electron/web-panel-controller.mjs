import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  ARTICLE_READER_FALLBACK_REASONS,
  createStaticReaderDocument,
} from "./article-reader.mjs";

const require = createRequire(import.meta.url);
const electronRuntime = require("electron");

// New dashboards are capped at six persistent views. Extra headroom keeps
// databases created by earlier versions usable alongside the article reader.
export const MAX_WEB_PANEL_DESCRIPTORS = 16;
const MAX_URL_LENGTH = 4_096;
const MAX_TEXT_LENGTH = 512;
const MAX_COORDINATE = 10_000_000;
export const WEB_PANEL_SESSION_STRATEGY = Object.freeze({
  partition: "persist:mediagen-web-panels",
  persistent: true,
  sharedAcrossPanels: true,
  retainedWhenClosed: Object.freeze(["cookies", "local-storage", "http-cache"]),
  clearedWhenClosed: Object.freeze(["service-workers"]),
});
const WEB_PARTITION = WEB_PANEL_SESSION_STRATEGY.partition;
const ARTICLE_READER_PANEL_ID = "reader:article";
const ARTICLE_READER_PRELOAD = fileURLToPath(
  new URL("./article-reader-preload.cjs", import.meta.url),
);
const ARTICLE_READER_STATIC_PARTITION = "mediagen-reader-static";
const READER_FALLBACK_REASONS = new Set(ARTICLE_READER_FALLBACK_REASONS);
const securedSessions = new WeakSet();
const WEB_DATA_SCOPES = new Set(["cache", "site-data", "all"]);
const sessionRedirectTrackers = new WeakMap();
const PROXY_RESOLUTION_TIMEOUT_MS = 5_000;
const PROXY_ROUTE_TYPES = new Set([
  "direct",
  "proxy",
  "https-proxy",
  "socks",
  "quic",
  "unknown",
]);

const WEB_PREFERENCES = Object.freeze({
  allowRunningInsecureContent: false,
  autoplayPolicy: "document-user-activation-required",
  backgroundThrottling: true,
  contextIsolation: true,
  devTools: false,
  javascript: true,
  navigateOnDragDrop: false,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  nodeIntegrationInWorker: false,
  partition: WEB_PARTITION,
  plugins: false,
  safeDialogs: true,
  safeDialogsMessage: "Cette page a affiché trop de fenêtres de dialogue.",
  sandbox: true,
  spellcheck: false,
  webSecurity: true,
  webviewTag: false,
});

function requireSessionMethod(session, method) {
  if (!session || typeof session[method] !== "function") {
    throw new TypeError(`La session Electron ne fournit pas ${method}().`);
  }
}

/**
 * Adapts Electron's Chromium-backed Session.fetch to the Fetch interface used
 * by the feed engine. Unlike Node fetch, this follows Electron's proxy and
 * certificate configuration. Custom application protocols remain bypassed.
 */
function responseWithUrl(response, url, redirected) {
  return new Proxy(response, {
    get(target, property) {
      if (property === "url") return url;
      if (property === "redirected") return redirected;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function inputHttpUrl(input) {
  if (typeof input === "string") return cleanHttpUrl(input);
  if (input && typeof input === "object" && typeof input.url === "string") {
    return cleanHttpUrl(input.url);
  }
  throw new TypeError("URL de téléchargement Electron invalide.");
}

function redirectTrackerFor(networkSession) {
  if (sessionRedirectTrackers.has(networkSession)) {
    return sessionRedirectTrackers.get(networkSession);
  }

  const tracker = { pending: new Set() };
  const onBeforeRedirect = networkSession.webRequest?.onBeforeRedirect;
  if (typeof onBeforeRedirect === "function") {
    onBeforeRedirect.call(
      networkSession.webRequest,
      { urls: ["http://*/*", "https://*/*"] },
      (details) => {
        const currentUrl = safeHttpUrl(details?.url);
        const nextUrl = safeHttpUrl(details?.redirectURL);
        if (!currentUrl || !nextUrl) return;
        const context = [...tracker.pending].find(
          (candidate) =>
            candidate.requestId === details.id ||
            (candidate.requestId == null && candidate.currentUrl === currentUrl),
        );
        if (!context) return;
        context.requestId = details.id;
        context.currentUrl = nextUrl;
        context.redirected = true;
      },
    );
  }
  sessionRedirectTrackers.set(networkSession, tracker);
  return tracker;
}

export function createElectronSessionFetch(networkSession) {
  requireSessionMethod(networkSession, "fetch");
  return async (input, init = undefined) => {
    const tracker = redirectTrackerFor(networkSession);
    const context = {
      currentUrl: inputHttpUrl(input),
      redirected: false,
      requestId: null,
    };
    tracker.pending.add(context);
    try {
      const response = await networkSession.fetch(input, {
        ...(init ?? {}),
        bypassCustomProtocolHandlers: true,
      });
      const responseUrl = safeHttpUrl(response.url);
      return responseWithUrl(
        response,
        context.redirected ? context.currentUrl : (responseUrl ?? context.currentUrl),
        response.redirected === true || context.redirected,
      );
    } finally {
      tracker.pending.delete(context);
    }
  };
}

function cleanDiagnosticSourceId(value) {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)
  ) {
    throw new TypeError("Identifiant de source invalide pour le diagnostic réseau.");
  }
  return value;
}

function proxyRouteType(route) {
  const token = (route.trim().split(/\s+/, 1)[0] ?? "")
    .split("://", 1)[0]
    .replace(/:$/, "")
    .toUpperCase();
  if (token === "DIRECT") return "direct";
  if (token === "PROXY" || token === "HTTP") return "proxy";
  if (token === "HTTPS") return "https-proxy";
  if (token === "SOCKS" || token === "SOCKS4" || token === "SOCKS5") {
    return "socks";
  }
  if (token === "QUIC") return "quic";
  return "unknown";
}

/**
 * Reduces Chromium's proxy/PAC result to a finite vocabulary. Hostnames,
 * ports and the original PAC expression are intentionally discarded.
 */
export function normalizeProxyRouteTypes(proxyRules) {
  if (typeof proxyRules !== "string") {
    throw new TypeError("Résultat de résolution proxy invalide.");
  }
  const normalized = [];
  for (const route of proxyRules.split(";")) {
    if (!route.trim()) continue;
    const type = proxyRouteType(route);
    if (PROXY_ROUTE_TYPES.has(type) && !normalized.includes(type)) {
      normalized.push(type);
    }
  }
  if (normalized.length === 0) normalized.push("unknown");
  return Object.freeze(normalized);
}

/** Creates the only successful proxy-resolution shape allowed in exports. */
export function createResolvedProxyDiagnostic(sourceId, proxyRules) {
  return Object.freeze({
    sourceId: cleanDiagnosticSourceId(sourceId),
    resolutionStatus: "resolved",
    routeTypes: normalizeProxyRouteTypes(proxyRules),
  });
}

function unresolvedProxyDiagnostic(sourceId, resolutionStatus) {
  return Object.freeze({
    sourceId: cleanDiagnosticSourceId(sourceId),
    resolutionStatus,
    routeTypes: Object.freeze([]),
  });
}

async function resolveProxyWithTimeout(networkSession, url, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      networkSession.resolveProxy(url),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("proxy-resolution-timeout")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Resolves each feed through Chromium while returning only anonymized fields.
 * Resolution errors are collapsed to a fixed status and never serialized.
 */
export async function collectEnterpriseNetworkDiagnostics({
  networkSession,
  sources,
  timeoutMs = PROXY_RESOLUTION_TIMEOUT_MS,
} = {}) {
  if (!Array.isArray(sources)) {
    throw new TypeError("Liste de sources invalide pour le diagnostic réseau.");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new TypeError("Délai de résolution proxy invalide.");
  }

  const canResolve = typeof networkSession?.resolveProxy === "function";
  return Promise.all(
    sources.map(async (source) => {
      const sourceId = cleanDiagnosticSourceId(source?.sourceId);
      if (!canResolve) return unresolvedProxyDiagnostic(sourceId, "unavailable");
      try {
        const feedUrl = cleanHttpUrl(source?.feedUrl);
        const proxyRules = await resolveProxyWithTimeout(
          networkSession,
          feedUrl,
          timeoutMs,
        );
        return createResolvedProxyDiagnostic(sourceId, proxyRules);
      } catch {
        return unresolvedProxyDiagnostic(sourceId, "failed");
      }
    }),
  );
}

/**
 * Removes service-worker registrations globally or for selected top-level
 * origins. Cookies, local storage and the HTTP cache intentionally survive so
 * web logins and user preferences behave like a small persistent browser.
 */
export async function stopWebPanelSessionActivity(webSession, origins = null) {
  if (!webSession || typeof webSession !== "object") {
    throw new TypeError("Session web Electron invalide.");
  }
  if (
    origins !== null &&
    (!Array.isArray(origins) || origins.some((origin) => safeHttpOrigin(origin) !== origin))
  ) {
    throw new TypeError("Liste d’origines web invalide.");
  }
  const scopedOrigins = origins === null ? null : [...new Set(origins)];
  if (scopedOrigins?.length === 0) {
    return Object.freeze({
      cleared: Object.freeze([]),
      origins: Object.freeze([]),
      runningServiceWorkers: 0,
    });
  }

  let runningServiceWorkers = 0;
  try {
    const running = webSession.serviceWorkers?.getAllRunning?.();
    if (running && typeof running === "object") {
      runningServiceWorkers = Object.keys(running).length;
    }
  } catch {
    // Diagnostics are best-effort; clearing below is authoritative.
  }

  if (typeof webSession.clearData === "function") {
    await webSession.clearData({
      dataTypes: ["serviceWorkers"],
      ...(scopedOrigins ? { origins: scopedOrigins } : {}),
    });
  } else {
    requireSessionMethod(webSession, "clearStorageData");
    if (scopedOrigins) {
      await Promise.all(
        scopedOrigins.map((origin) =>
          webSession.clearStorageData({ origin, storages: ["serviceworkers"] })),
      );
    } else {
      await webSession.clearStorageData({ storages: ["serviceworkers"] });
    }
  }

  return Object.freeze({
    cleared: Object.freeze(["service-workers"]),
    origins: scopedOrigins ? Object.freeze(scopedOrigins) : null,
    runningServiceWorkers,
  });
}

/** Clears user-selected data from the persistent web-panel profile. */
export async function clearWebPanelSessionData(webSession, scope) {
  if (!WEB_DATA_SCOPES.has(scope)) {
    throw new TypeError("Type d’effacement des données web invalide.");
  }

  const cleared = [];
  if (scope === "cache" || scope === "all") {
    requireSessionMethod(webSession, "clearCache");
    await webSession.clearCache();
    cleared.push("http-cache");
  }

  if (scope === "site-data" || scope === "all") {
    requireSessionMethod(webSession, "clearStorageData");
    await webSession.clearStorageData();
    cleared.push("cookies", "local-storage", "indexed-db", "service-workers");
  }

  if (scope === "all") {
    if (typeof webSession.clearAuthCache === "function") {
      await webSession.clearAuthCache();
      cleared.push("authentication-cache");
    }
    if (typeof webSession.clearHostResolverCache === "function") {
      await webSession.clearHostResolverCache();
      cleared.push("dns-cache");
    }
  }

  return Object.freeze({ scope, cleared: Object.freeze(cleared) });
}

function cleanPanelId(value) {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)
  ) {
    throw new TypeError("Identifiant de panel web invalide.");
  }
  return value;
}

function cleanItemId(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 128) {
    throw new TypeError("Identifiant d’article invalide.");
  }
  return value.trim();
}

function cleanHttpUrl(value) {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) {
    throw new TypeError("URL de panel web invalide.");
  }

  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new TypeError("Cette URL de panel web n’est pas valide.");
  }

  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  ) {
    throw new TypeError("Seules les URLs web http et https sont acceptées.");
  }

  return parsed.toString();
}

function safeHttpUrl(value) {
  try {
    return cleanHttpUrl(value);
  } catch {
    return null;
  }
}

function safeHttpOrigin(value) {
  const url = safeHttpUrl(value);
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function boundedText(value, fallback = "") {
  const text = typeof value === "string" ? value.trim() : fallback;
  return text.slice(0, MAX_TEXT_LENGTH);
}

function errorText(error) {
  if (error instanceof Error) return boundedText(error.message, "Erreur inconnue.");
  return boundedText(String(error ?? "Erreur inconnue."), "Erreur inconnue.");
}

function cleanBounds(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Dimensions de panel web invalides.");
  }

  const bounds = {
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
  };

  for (const [key, number] of Object.entries(bounds)) {
    if (
      typeof number !== "number" ||
      !Number.isFinite(number) ||
      Math.abs(number) > MAX_COORDINATE
    ) {
      throw new TypeError(`Dimension « ${key} » invalide.`);
    }
  }

  if (bounds.width < 0 || bounds.height < 0) {
    throw new RangeError("La largeur et la hauteur ne peuvent pas être négatives.");
  }

  return bounds;
}

function contentSize(window) {
  try {
    const size = window.getContentSize?.();
    if (
      Array.isArray(size) &&
      size.length === 2 &&
      size.every((number) => Number.isFinite(number) && number >= 0)
    ) {
      return [Math.floor(size[0]), Math.floor(size[1])];
    }
  } catch {
    // The window may be closing. Bounds are still normalized below.
  }
  return null;
}

function clipBounds(window, rawBounds) {
  const left = Math.floor(rawBounds.x);
  const top = Math.floor(rawBounds.y);
  const right = Math.ceil(rawBounds.x + rawBounds.width);
  const bottom = Math.ceil(rawBounds.y + rawBounds.height);
  const size = contentSize(window);

  if (!size) {
    const clippedLeft = Math.max(0, left);
    const clippedTop = Math.max(0, top);
    return {
      x: clippedLeft,
      y: clippedTop,
      width: Math.max(0, right - clippedLeft),
      height: Math.max(0, bottom - clippedTop),
    };
  }

  const [contentWidth, contentHeight] = size;
  const clippedLeft = Math.min(contentWidth, Math.max(0, left));
  const clippedTop = Math.min(contentHeight, Math.max(0, top));
  const clippedRight = Math.min(contentWidth, Math.max(clippedLeft, right));
  const clippedBottom = Math.min(contentHeight, Math.max(clippedTop, bottom));

  return {
    x: clippedLeft,
    y: clippedTop,
    width: clippedRight - clippedLeft,
    height: clippedBottom - clippedTop,
  };
}

function normalizeDescriptor(window, descriptor) {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw new TypeError("Descripteur de panel web invalide.");
  }
  if (typeof descriptor.visible !== "boolean") {
    throw new TypeError("La visibilité du panel web doit être un booléen.");
  }

  const kind = descriptor.kind ?? "web";
  if (kind !== "web" && kind !== "reader") {
    throw new TypeError("Type de panel web invalide.");
  }
  const normalized = {
    kind,
    panelId: cleanPanelId(descriptor.panelId),
    url: cleanHttpUrl(descriptor.url),
    bounds: clipBounds(window, cleanBounds(descriptor.bounds)),
    visible: descriptor.visible,
  };
  if (kind === "web") return normalized;
  if (normalized.panelId !== ARTICLE_READER_PANEL_ID) {
    throw new TypeError("Identifiant du lecteur d’article invalide.");
  }
  const itemId = cleanItemId(descriptor.itemId);
  if (descriptor.readerMode !== "extracting" && descriptor.readerMode !== "original") {
    throw new TypeError("Mode du lecteur d’article invalide.");
  }
  if (
    descriptor.readerMode === "extracting" &&
    (typeof descriptor.connectorId !== "string" || !descriptor.connectorId.trim())
  ) {
    throw new TypeError("Connecteur du lecteur d’article invalide.");
  }
  return {
    ...normalized,
    itemId,
    connectorId: descriptor.connectorId ?? null,
    readerMode: descriptor.readerMode,
    readerFallback: normalizeReaderFallbackReason(descriptor.readerFallback),
  };
}

function secureSession(session) {
  if (!session || (typeof session !== "object" && typeof session !== "function")) return;
  if (securedSessions.has(session)) return;
  securedSessions.add(session);

  session.setPermissionCheckHandler?.(() => false);
  session.setPermissionRequestHandler?.((_contents, _permission, callback) => {
    callback(false);
  });
  session.setDisplayMediaRequestHandler?.((_request, callback) => {
    callback({});
  });
  session.on?.("will-download", (event, item) => {
    event.preventDefault?.();
    item?.cancel?.();
  });
}

function isDestroyed(contents) {
  try {
    return contents.isDestroyed?.() === true;
  } catch {
    return true;
  }
}

function requireMethod(object, method, label) {
  if (typeof object?.[method] !== "function") {
    throw new TypeError(`${label} ne fournit pas ${method}().`);
  }
}

function normalizeReaderFallbackReason(value) {
  if (value == null) return null;
  if (READER_FALLBACK_REASONS.has(value)) return value;
  throw new TypeError("Motif de repli du lecteur invalide.");
}

export function validateWebPanelDescriptorList(descriptors) {
  if (!Array.isArray(descriptors)) {
    throw new TypeError("La liste des panels web doit être un tableau.");
  }
  if (descriptors.length > MAX_WEB_PANEL_DESCRIPTORS) {
    throw new RangeError(
      `Un maximum de ${MAX_WEB_PANEL_DESCRIPTORS} panels web est autorisé.`,
    );
  }
  return descriptors;
}

/**
 * Owns the native WebContentsView instances displayed over the React dashboard.
 * `sync()` is authoritative: views omitted from its descriptor list are destroyed.
 */
export function createWebPanelController({
  window,
  shell,
  extractArticle,
  onState = () => {},
  onEscape = () => {},
  onOpenSearch = () => {},
  WebContentsViewClass = electronRuntime?.WebContentsView,
} = {}) {
  if (!window || typeof window !== "object") {
    throw new TypeError("Une fenêtre Electron est requise.");
  }
  requireMethod(window.contentView, "addChildView", "La contentView");
  requireMethod(window.contentView, "removeChildView", "La contentView");
  if (!shell || typeof shell.openExternal !== "function") {
    throw new TypeError("Le module shell Electron est requis.");
  }
  if (typeof extractArticle !== "function") {
    throw new TypeError("Le service d’extraction d’article est requis.");
  }
  if (typeof onState !== "function") {
    throw new TypeError("onState doit être une fonction.");
  }
  if (typeof onEscape !== "function") {
    throw new TypeError("onEscape doit être une fonction.");
  }
  if (typeof onOpenSearch !== "function") {
    throw new TypeError("onOpenSearch doit être une fonction.");
  }
  if (typeof WebContentsViewClass !== "function") {
    throw new TypeError("WebContentsView n’est pas disponible dans ce processus.");
  }

  const records = new Map();
  const observedSessions = new Set();
  let windowClosed = false;
  let cleanupTask = Promise.resolve();
  let fullCleanupScheduled = false;

  function assertWindowOpen() {
    if (windowClosed || window.isDestroyed?.()) {
      throw new Error("La fenêtre Electron est fermée.");
    }
  }

  function historyState(record) {
    const history = record.contents.navigationHistory;
    if (!history || isDestroyed(record.contents)) {
      return { canGoBack: false, canGoForward: false };
    }

    try {
      return {
        canGoBack: history.canGoBack() === true,
        canGoForward: history.canGoForward() === true,
      };
    } catch {
      return { canGoBack: false, canGoForward: false };
    }
  }

  function snapshot(record, overrides = {}) {
    const navigation = historyState(record);
    let muted = record.muted;
    try {
      if (!isDestroyed(record.contents) && typeof record.contents.isAudioMuted === "function") {
        muted = record.contents.isAudioMuted() === true;
      }
    } catch {
      // Retain the last requested value while the renderer is being torn down.
    }

    const destroyed = overrides.destroyed ?? record.destroyed;
    const state = {
      panelId: record.panelId,
      status: destroyed
        ? "destroyed"
        : record.crashed
          ? "crashed"
          : record.unresponsive
            ? "unresponsive"
            : record.error
              ? "error"
              : record.loading
                ? "loading"
                : "ready",
      homeUrl: record.homeUrl,
      url: record.url,
      title: record.title,
      loading: destroyed ? false : record.loading,
      canGoBack: destroyed ? false : navigation.canGoBack,
      canGoForward: destroyed ? false : navigation.canGoForward,
      muted,
      visible: destroyed ? false : record.visible,
      requestedVisible: destroyed ? false : record.requestedVisible,
      bounds: { ...record.bounds },
      error: record.error,
      errorCode: record.errorCode,
      crashed: destroyed ? false : record.crashed,
      unresponsive: destroyed ? false : record.unresponsive,
      destroyed,
      readerMode: record.kind === "reader" ? record.readerMode : null,
      readerFallback: record.kind === "reader" ? record.readerFallback : null,
      ...overrides,
    };

    return state;
  }

  function emit(record, overrides) {
    const state = snapshot(record, overrides);
    return publishState(state);
  }

  function publishState(state) {
    try {
      onState(state);
    } catch {
      // A consumer error must never compromise native view cleanup or navigation.
    }
    return state;
  }

  function publishOriginalReaderDecision(descriptor, overrides = {}) {
    publishState({
      panelId: descriptor.panelId,
      status: "loading",
      homeUrl: descriptor.url,
      url: descriptor.url,
      title: "",
      loading: true,
      canGoBack: false,
      canGoForward: false,
      muted: true,
      visible: false,
      requestedVisible: descriptor.visible,
      bounds: { ...descriptor.bounds },
      error: null,
      errorCode: null,
      crashed: false,
      unresponsive: false,
      destroyed: false,
      readerMode: "original",
      readerFallback: descriptor.readerFallback,
      ...overrides,
    });
  }

  function listen(record, event, listener) {
    const guardedListener = (...args) => {
      if (
        record.closing ||
        record.destroyed ||
        records.get(record.panelId) !== record
      ) {
        return;
      }
      return listener(...args);
    };
    record.contents.on(event, guardedListener);
    record.listeners.push([event, guardedListener]);
  }

  function detachListeners(record) {
    if (typeof record.contents.off !== "function") return;
    for (const [event, listener] of record.listeners.splice(0)) {
      try {
        record.contents.off(event, listener);
      } catch {
        // A crashed or destroyed renderer may reject listener operations.
      }
    }
  }

  function applyBounds(record, descriptor) {
    record.bounds = descriptor.bounds;
    record.requestedVisible = descriptor.visible;
    record.visible = shouldDisplay(record);

    record.view.setBounds(descriptor.bounds);
    record.view.setVisible(record.visible);
  }

  function shouldDisplay(record) {
    return (
      !record.crashed &&
      record.requestedVisible &&
      record.bounds.width > 0 &&
      record.bounds.height > 0 &&
      (record.kind !== "reader" || record.readerMode !== "extracting")
    );
  }

  function navigationTarget(event, legacyUrl) {
    if (typeof event?.url === "string") return event.url;
    return legacyUrl;
  }

  function preventUnsafeNavigation(record, event, legacyUrl) {
    const target = navigationTarget(event, legacyUrl);
    if (record.allowStaticNavigation && typeof target === "string" && target.startsWith("data:text/html")) {
      return;
    }
    if (record.kind === "reader" && record.readerMode === "extracting") {
      event.preventDefault?.();
      return;
    }
    if (!safeHttpUrl(target)) event.preventDefault?.();
  }

  function configureContents(record) {
    const { contents } = record;
    requireMethod(contents, "on", "Le WebContents");
    requireMethod(contents, "loadURL", "Le WebContents");
    requireMethod(contents, "setWindowOpenHandler", "Le WebContents");
    requireMethod(contents, "setAudioMuted", "Le WebContents");
    requireMethod(contents, "close", "Le WebContents");

    secureSession(contents.session);
    observedSessions.add(contents.session);
    fullCleanupScheduled = false;
    contents.setAudioMuted(true);
    contents.setWindowOpenHandler(({ url }) => {
      const targetUrl = safeHttpUrl(url);
      if (targetUrl) void load(record, targetUrl).catch(() => {});
      return { action: "deny" };
    });

    listen(record, "will-navigate", (event, legacyUrl) =>
      preventUnsafeNavigation(record, event, legacyUrl));
    listen(record, "will-redirect", (event, legacyUrl) =>
      preventUnsafeNavigation(record, event, legacyUrl));
    listen(record, "will-attach-webview", (event) => event.preventDefault?.());
    listen(record, "before-input-event", (event, input) => {
      if (input?.type === "keyDown" && input.key === "Escape" && !input.isAutoRepeat) {
        onEscape(record.panelId);
      }
      if (
        input?.type === "keyDown" &&
        input.key?.toLowerCase() === "k" &&
        (input.meta || input.control) &&
        !input.isAutoRepeat
      ) {
        event.preventDefault?.();
        onOpenSearch(record.panelId);
      }
    });
    listen(record, "content-bounds-updated", (event) => event.preventDefault?.());
    listen(record, "login", (event, _details, _authInfo, callback) => {
      event.preventDefault?.();
      callback?.();
    });
    listen(record, "select-bluetooth-device", (event, _devices, callback) => {
      event.preventDefault?.();
      callback?.("");
    });
    listen(record, "did-start-loading", () => {
      record.loading = true;
      record.error = null;
      record.errorCode = null;
      record.crashed = false;
      emit(record);
    });
    listen(record, "did-stop-loading", () => {
      record.loading = false;
      if (record.kind === "reader" && record.visible) record.contents.focus();
      emit(record);
    });
    listen(record, "did-navigate", (_event, url) => {
      const safeUrl = safeHttpUrl(url);
      if (safeUrl) {
        record.url = safeUrl;
        record.visitedOrigins.add(new URL(safeUrl).origin);
      }
      record.error = null;
      record.errorCode = null;
      record.crashed = false;
      emit(record);
    });
    listen(record, "did-navigate-in-page", (_event, url, isMainFrame) => {
      if (isMainFrame === false) return;
      const safeUrl = safeHttpUrl(url);
      if (!safeUrl || safeUrl === record.url) return;
      record.url = safeUrl;
      record.visitedOrigins.add(new URL(safeUrl).origin);
      emit(record);
    });
    listen(record, "page-title-updated", (_event, title) => {
      record.title = boundedText(title);
      emit(record);
    });
    listen(
      record,
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
        if (isMainFrame === false || errorCode === -3) return;
        const safeUrl = safeHttpUrl(validatedUrl);
        if (safeUrl) record.url = safeUrl;
        record.loading = false;
        record.errorCode = Number.isInteger(errorCode) ? errorCode : null;
        record.error = boundedText(errorDescription, "Impossible de charger cette page.");
        emit(record);
      },
    );
    listen(record, "unresponsive", () => {
      record.unresponsive = true;
      emit(record);
    });
    listen(record, "responsive", () => {
      record.unresponsive = false;
      emit(record);
    });
    listen(record, "render-process-gone", (_event, details) => {
      if (record.closing || record.destroyed || records.get(record.panelId) !== record) return;
      record.loading = false;
      record.crashed = true;
      record.unresponsive = false;
      const reason = boundedText(details?.reason, "interrompu");
      record.error = `La page s’est interrompue (${reason}).`;
      record.errorCode = null;
      record.visible = false;
      try {
        record.view.setVisible(false);
      } catch {
        // The renderer is already gone; the native shell still owns cleanup.
      }
      emit(record);
    });
    listen(record, "destroyed", () => {
      if (record.closing || record.destroyed) return;
      records.delete(record.panelId);
      record.destroyed = true;
      record.loading = false;
      record.visible = false;
      record.requestedVisible = false;
      try {
        window.contentView.removeChildView(record.view);
      } catch {
        // The owning window may already have been destroyed.
      }
      detachListeners(record);
      emit(record, { destroyed: true });
      scheduleWebSessionCleanup(record.visitedOrigins);
    });
  }

  function load(record, targetUrl, { visible = shouldDisplay(record) } = {}) {
    const url = cleanHttpUrl(targetUrl);
    fullCleanupScheduled = false;
    record.visitedOrigins.add(new URL(url).origin);
    const generation = ++record.loadGeneration;
    record.url = url;
    record.loading = true;
    record.error = null;
    record.errorCode = null;
    record.crashed = false;
    record.unresponsive = false;
    record.visible = visible && shouldDisplay(record);
    record.view.setVisible(record.visible);
    emit(record);

    let task;
    try {
      task = Promise.resolve(record.contents.loadURL(url));
    } catch (error) {
      task = Promise.reject(error);
    }

    return task.then(
      () => {
        if (
          record.destroyed ||
          record.closing ||
          generation !== record.loadGeneration ||
          records.get(record.panelId) !== record
        ) {
          throw new Error("Navigation annulée : le panel web a été remplacé ou fermé.");
        }
        return snapshot(record);
      },
      (error) => {
        if (!record.destroyed && generation === record.loadGeneration) {
          record.loading = false;
          record.error = errorText(error);
          record.errorCode = null;
          emit(record);
        }
        throw error;
      },
    );
  }

  function isCurrentRecord(record) {
    return (
      !record.destroyed &&
      !record.closing &&
      records.get(record.panelId) === record
    );
  }

  async function loadStaticReaderDocument(record, document) {
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(document)}`;
    const generation = ++record.loadGeneration;
    record.allowStaticNavigation = true;
    record.loading = true;
    record.error = null;
    record.errorCode = null;
    record.visible = false;
    record.view.setVisible(false);
    emit(record);
    try {
      await record.contents.loadURL(url);
      if (!isCurrentRecord(record) || generation !== record.loadGeneration) {
        throw new Error("Lecture simplifiée annulée.");
      }
    } finally {
      record.allowStaticNavigation = false;
    }
  }

  async function fallbackToOriginal(record, reason) {
    if (!isCurrentRecord(record) || record.kind !== "reader") return;
    const descriptor = {
      kind: "reader",
      panelId: record.panelId,
      itemId: record.itemId,
      url: record.originalUrl,
      bounds: { ...record.bounds },
      visible: record.requestedVisible,
      connectorId: null,
      readerMode: "original",
      readerFallback: reason,
    };
    destroyRecord(record, { focusHost: false });
    createRecord(descriptor);
  }

  function requireMatchingReaderItem(itemId) {
    const normalizedItemId = cleanItemId(itemId);
    const record = requireRecord(ARTICLE_READER_PANEL_ID);
    if (record.kind !== "reader" || record.itemId !== normalizedItemId) {
      throw new Error("Le lecteur ne correspond pas à cet article.");
    }
    return record;
  }

  function showOriginalArticle(itemId) {
    const record = requireMatchingReaderItem(itemId);
    if (record.readerMode === "original") return snapshot(record);
    const descriptor = {
      kind: "reader",
      panelId: record.panelId,
      itemId: record.itemId,
      url: record.originalUrl,
      bounds: { ...record.bounds },
      visible: record.requestedVisible,
      connectorId: null,
      readerMode: "original",
      readerFallback: null,
    };
    destroyRecord(record, { focusHost: false });
    return snapshot(createRecord(descriptor));
  }

  function retryOriginalArticle(itemId) {
    const record = requireMatchingReaderItem(itemId);
    if (record.readerMode !== "original") {
      throw new Error("La page originale n’est pas active.");
    }
    return reloadRecord(record);
  }

  async function beginReaderExtraction(record) {
    if (!isCurrentRecord(record) || record.kind !== "reader") return;
    const extractionGeneration = ++record.readerGeneration;
    const abortController = new AbortController();
    record.readerAbortController?.abort();
    record.readerAbortController = abortController;
    record.readerMode = "extracting";
    record.readerFallback = null;
    record.visible = false;
    record.view.setVisible(false);
    emit(record);
    try {
      const normalized = await extractArticle({
        connectorId: record.connectorId,
        url: record.originalUrl,
        signal: abortController.signal,
      });
      if (!isCurrentRecord(record) || extractionGeneration !== record.readerGeneration) return;
      if (!normalized.ok) {
        await fallbackToOriginal(
          record,
          READER_FALLBACK_REASONS.has(normalized.reason)
            ? normalized.reason
            : "extraction-failed",
        );
        return;
      }
      await loadStaticReaderDocument(record, createStaticReaderDocument(normalized.article));
      if (!isCurrentRecord(record) || extractionGeneration !== record.readerGeneration) return;
      record.readerMode = "simplified";
      record.readerFallback = null;
      record.title = normalized.article.title;
      record.loading = false;
      record.visible = shouldDisplay(record);
      record.view.setVisible(record.visible);
      if (record.visible && typeof record.contents.focus === "function") record.contents.focus();
      emit(record);
    } catch (error) {
      if (!isCurrentRecord(record) || extractionGeneration !== record.readerGeneration) return;
      if (abortController.signal.aborted) return;
      const reason = error?.name === "AbortError" ? "timeout" : "extraction-failed";
      await fallbackToOriginal(record, reason);
    } finally {
      if (record.readerAbortController === abortController) {
        record.readerAbortController = null;
      }
    }
  }

  function createRecord(descriptor) {
    assertWindowOpen();
    let view;
    let added = false;
    let publishedOriginalDecision = false;

    try {
      // The main process already knows when an article cannot use a dedicated
      // adapter. Surface that decision before a cold native view is allocated.
      if (descriptor.kind === "reader" && descriptor.readerMode === "original") {
        publishOriginalReaderDecision(descriptor);
        publishedOriginalDecision = true;
      }
      const webPreferences = { ...WEB_PREFERENCES };
      if (descriptor.kind === "reader") {
        webPreferences.preload = ARTICLE_READER_PRELOAD;
        if (descriptor.readerMode === "extracting") {
          webPreferences.partition = ARTICLE_READER_STATIC_PARTITION;
        }
      }
      view = new WebContentsViewClass({ webPreferences });
      requireMethod(view, "setBounds", "La WebContentsView");
      requireMethod(view, "setVisible", "La WebContentsView");
      if (!view.webContents) throw new TypeError("La WebContentsView ne fournit pas de WebContents.");

      const record = {
        kind: descriptor.kind,
        panelId: descriptor.panelId,
        itemId: descriptor.itemId ?? null,
        view,
        contents: view.webContents,
        homeUrl: descriptor.url,
        originalUrl: descriptor.url,
        url: descriptor.url,
        title: "",
        loading: false,
        muted: true,
        visible: false,
        requestedVisible: false,
        bounds: { ...descriptor.bounds },
        error: null,
        errorCode: null,
        crashed: false,
        unresponsive: false,
        destroyed: false,
        closing: false,
        loadGeneration: 0,
        readerGeneration: 0,
        readerMode: descriptor.kind === "reader" ? descriptor.readerMode : null,
        readerFallback: descriptor.kind === "reader" ? descriptor.readerFallback : null,
        connectorId: descriptor.kind === "reader" ? descriptor.connectorId : null,
        readerAbortController: null,
        allowStaticNavigation: false,
        listeners: [],
        visitedOrigins: descriptor.kind === "reader" && descriptor.readerMode === "extracting"
          ? new Set()
          : new Set([new URL(descriptor.url).origin]),
      };

      configureContents(record);
      view.setVisible(false);
      view.setBounds(descriptor.bounds);
      window.contentView.addChildView(view);
      added = true;
      records.set(record.panelId, record);
      applyBounds(record, descriptor);
      if (record.kind === "reader" && record.visible && typeof record.contents.focus === "function") {
        record.contents.focus();
      }
      emit(record);
      // A dashboard renderer can reload immediately after its previous views
      // were closed. Do not let the replacement page register workers while
      // cleanup of the previous generation is still running.
      const initialLoadGeneration = record.loadGeneration;
      const initialLoadBarrier =
        record.kind === "reader" && record.readerMode === "original"
          ? Promise.resolve()
          : cleanupTask;
      void initialLoadBarrier.then(() => {
        if (
          !record.destroyed &&
          !record.closing &&
          record.loadGeneration === initialLoadGeneration &&
          records.get(record.panelId) === record
        ) {
          if (record.kind === "reader" && record.readerMode === "extracting") {
            return beginReaderExtraction(record);
          }
          return load(record, descriptor.url);
        }
        return undefined;
      }).catch(() => {});
      return record;
    } catch (error) {
      records.delete(descriptor.panelId);
      if (added) {
        try {
          window.contentView.removeChildView(view);
        } catch {
          // Best-effort rollback.
        }
      }
      const contents = view?.webContents;
      if (contents && !isDestroyed(contents)) {
        try {
          contents.close({ waitForBeforeUnload: false });
        } catch {
          // Best-effort rollback.
        }
      }
      if (publishedOriginalDecision) {
        publishOriginalReaderDecision(descriptor, {
          status: "destroyed",
          loading: false,
          requestedVisible: false,
          destroyed: true,
        });
      }
      throw error;
    }
  }

  function requireRecord(panelId) {
    const id = cleanPanelId(panelId);
    const record = records.get(id);
    if (!record || record.destroyed || isDestroyed(record.contents)) {
      throw new Error("Panel web introuvable.");
    }
    return record;
  }

  function requireWebRecord(panelId) {
    const record = requireRecord(panelId);
    if (record.kind !== "web") {
      throw new Error("Cette commande est réservée aux panels web.");
    }
    return record;
  }

  function destroyRecord(record, { focusHost = true } = {}) {
    if (!record || record.destroyed || record.closing) return false;
    record.closing = true;
    record.loadGeneration += 1;
    record.readerGeneration += 1;
    record.readerAbortController?.abort();
    record.readerAbortController = null;
    records.delete(record.panelId);

    try {
      record.view.setVisible(false);
    } catch {
      // The native view may already be detached.
    }
    record.visible = false;
    record.requestedVisible = false;

    try {
      window.contentView.removeChildView(record.view);
    } catch {
      // The window may already have been destroyed.
    }

    detachListeners(record);
    record.destroyed = true;
    record.loading = false;
    emit(record, { destroyed: true });

    if (!isDestroyed(record.contents)) {
      try {
        record.contents.close({ waitForBeforeUnload: false });
      } catch {
        // Cleanup remains best-effort after renderer failure.
      }
    }
    if (focusHost && record.kind === "reader" && !isDestroyed(window.webContents)) {
      try {
        window.webContents.focus();
      } catch {
        // The owning renderer may already be closing with the window.
      }
    }
    scheduleWebSessionCleanup(record.visitedOrigins);
    return true;
  }

  function scheduleWebSessionCleanup(candidateOrigins = null) {
    if (observedSessions.size === 0) return cleanupTask;
    const clearAll = candidateOrigins === null || records.size === 0;
    if (clearAll && fullCleanupScheduled) return cleanupTask;
    if (clearAll) fullCleanupScheduled = true;
    const requestedOrigins = clearAll
      ? null
      : [...new Set(candidateOrigins)].filter((origin) => safeHttpOrigin(origin) === origin);
    if (requestedOrigins?.length === 0) return cleanupTask;
    const sessions = [...observedSessions];
    cleanupTask = cleanupTask
      .catch(() => {})
      .then(() => {
        const activeOrigins = new Set(
          [...records.values()].flatMap((record) => [...record.visitedOrigins]),
        );
        const origins = requestedOrigins?.filter((origin) => !activeOrigins.has(origin)) ?? null;
        if (origins?.length === 0) return [];
        return Promise.allSettled(
          sessions.map((webSession) => stopWebPanelSessionActivity(webSession, origins)),
        );
      })
      .then((results) => {
        if (clearAll && results.some((result) => result.status === "rejected")) {
          fullCleanupScheduled = false;
        }
        for (const result of results) {
          if (result.status === "rejected") {
            console.warn(
              "Nettoyage des tâches web en arrière-plan incomplet :",
              errorText(result.reason),
            );
          }
        }
      });
    return cleanupTask;
  }

  function sync(descriptors) {
    assertWindowOpen();
    validateWebPanelDescriptorList(descriptors);

    const normalized = descriptors.map((descriptor) => normalizeDescriptor(window, descriptor));
    const ids = new Set();
    for (const descriptor of normalized) {
      if (ids.has(descriptor.panelId)) {
        throw new Error(`Le panel web « ${descriptor.panelId} » est présent plusieurs fois.`);
      }
      ids.add(descriptor.panelId);
    }

    for (const [panelId, record] of records) {
      if (!ids.has(panelId)) destroyRecord(record);
    }

    for (const descriptor of normalized) {
      let record = records.get(descriptor.panelId);
      if (!record) {
        record = createRecord(descriptor);
        continue;
      }

      if (
        record.kind !== descriptor.kind ||
        (record.kind === "reader" &&
          (record.itemId !== descriptor.itemId || record.originalUrl !== descriptor.url))
      ) {
        destroyRecord(record, { focusHost: false });
        createRecord(descriptor);
        continue;
      }

      applyBounds(record, descriptor);
      if (record.homeUrl !== descriptor.url) {
        record.homeUrl = descriptor.url;
        record.originalUrl = descriptor.url;
        void load(record, descriptor.url).catch(() => {});
      } else {
        emit(record);
      }
    }

    if (records.size === 0) scheduleWebSessionCleanup();

    return normalized.map(({ panelId }) => snapshot(records.get(panelId)));
  }

  function navigate(panelId, url) {
    return load(requireWebRecord(panelId), cleanHttpUrl(url));
  }

  function reloadRecord(record) {
    record.loadGeneration += 1;
    record.error = null;
    record.errorCode = null;
    record.crashed = false;
    record.unresponsive = false;
    record.loading = true;
    record.visible = shouldDisplay(record);
    record.view.setVisible(record.visible);
    record.contents.reload();
    return emit(record);
  }

  function reload(panelId) {
    return reloadRecord(requireWebRecord(panelId));
  }

  function stop(panelId) {
    const record = requireWebRecord(panelId);
    record.contents.stop();
    record.loading = false;
    return emit(record);
  }

  function goBack(panelId) {
    const record = requireWebRecord(panelId);
    const history = record.contents.navigationHistory;
    if (history?.canGoBack()) history.goBack();
    return emit(record);
  }

  function goForward(panelId) {
    const record = requireWebRecord(panelId);
    const history = record.contents.navigationHistory;
    if (history?.canGoForward()) history.goForward();
    return emit(record);
  }

  function home(panelId) {
    const record = requireWebRecord(panelId);
    return load(record, record.homeUrl);
  }

  async function openExternal(panelId) {
    const record = requireRecord(panelId);
    let currentUrl = record.kind === "reader" ? record.originalUrl : record.url;
    try {
      const loadedUrl = record.contents.getURL?.();
      if (safeHttpUrl(loadedUrl)) currentUrl = loadedUrl;
    } catch {
      // Fall back to the last committed safe URL.
    }
    await shell.openExternal(cleanHttpUrl(currentUrl), { activate: true });
    return snapshot(record);
  }

  function setMuted(panelId, muted) {
    if (typeof muted !== "boolean") {
      throw new TypeError("L’état audio doit être un booléen.");
    }
    const record = requireWebRecord(panelId);
    record.contents.setAudioMuted(muted);
    record.muted = muted;
    return emit(record);
  }

  function focus(panelId) {
    const record = requireRecord(panelId);
    if (!record.visible || typeof record.contents.focus !== "function") return false;
    record.contents.focus();
    return true;
  }

  function destroy(panelId) {
    const id = cleanPanelId(panelId);
    const destroyed = destroyRecord(records.get(id));
    return destroyed;
  }

  function destroyAll() {
    let destroyedCount = 0;
    for (const record of [...records.values()]) {
      if (destroyRecord(record)) destroyedCount += 1;
    }
    scheduleWebSessionCleanup();
    return destroyedCount;
  }

  function getDescriptors() {
    return [...records.values()].map((record) => {
      const descriptor = {
        panelId: record.panelId,
        url: record.homeUrl,
        bounds: { ...record.bounds },
        visible: record.requestedVisible,
      };
      if (record.kind === "web") return descriptor;
      return {
        ...descriptor,
        kind: "reader",
        itemId: record.itemId,
        connectorId: record.connectorId,
        readerMode: record.readerMode === "original" ? "original" : "extracting",
        readerFallback: record.readerFallback,
      };
    });
  }

  function getActiveReaderArticle(itemId) {
    const normalizedItemId = cleanItemId(itemId);
    const record = records.get(ARTICLE_READER_PANEL_ID);
    if (
      !record ||
      record.kind !== "reader" ||
      record.destroyed ||
      record.closing ||
      record.itemId !== normalizedItemId
    ) {
      return null;
    }
    return Object.freeze({
      itemId: record.itemId,
      url: record.originalUrl,
      connectorId: record.connectorId,
      readerMode: record.readerMode === "original" ? "original" : "extracting",
      readerFallback: record.readerFallback,
    });
  }

  async function shutdown() {
    destroyAll();
    await scheduleWebSessionCleanup();
  }

  if (typeof window.once === "function") {
    window.once("closed", () => {
      windowClosed = true;
      destroyAll();
    });
  }

  return Object.freeze({
    sync,
    navigate,
    reload,
    stop,
    goBack,
    goForward,
    home,
    openExternal,
    showOriginalArticle,
    retryOriginalArticle,
    setMuted,
    focus,
    destroy,
    destroyAll,
    getDescriptors,
    getActiveReaderArticle,
    shutdown,
  });
}
