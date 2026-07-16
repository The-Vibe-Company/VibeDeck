import * as cheerio from "cheerio";
import { Worker } from "node:worker_threads";

import { isNonPublicIpAddress, proxyRouteKind } from "./network-safety.mjs";
import { PUBLICATIONS } from "./publication-registry.mjs";

export const ARTICLE_READER_LIMITS = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  maxRedirects: 3,
  timeoutMs: 900,
  maxElements: 30_000,
  maxCharacters: 200_000,
  maxBlocks: 1_000,
  minCharacters: 500,
  minBlocks: 3,
  maxTextPerBlock: 12_000,
  maxTitleLength: 512,
  maxMetadataLength: 1_024,
  maxImageUrlLength: 4_096,
  maxStructuredDataBytes: 200_000,
});
const MAX_EXTRACTION_RESERVE_MS = 250;

const COMMON_REMOVALS = Object.freeze([
  "script",
  "style",
  "template",
  "noscript",
  "iframe",
  "embed",
  "object",
  "form",
  "audio",
  "video",
  "header",
  "footer",
  "nav",
  "aside",
  "[role='complementary']",
]);

const DEFAULT_READER_PROFILE = Object.freeze({
  rootSelectors: Object.freeze(["main > article", "main article", "article", "main"]),
  titleSelectors: Object.freeze(["article h1", "main h1", "h1"]),
  bylineSelectors: Object.freeze([
    "[rel='author']",
    "[class*='author']",
    "[class*='byline']",
    "[class*='signature']",
  ]),
  imageSelectors: Object.freeze([
    "article figure img",
    "main figure img",
    "article img",
    "main img",
  ]),
  removeSelectors: Object.freeze([
    ...COMMON_REMOVALS,
    "[data-testid*='advert']",
    "[data-component*='advert']",
    "[class*='advert']",
    "[class*='related']",
    "[class*='recommendation']",
    "[class*='share']",
    "[class*='newsletter']",
  ]),
  premiumSelectors: Object.freeze([
    "[data-testid*='paywall']",
    "[class*='paywall']",
    "[class*='premium-content']",
  ]),
  premiumPhrases: Object.freeze([
    "réservé aux abonnés",
    "abonnez-vous pour lire",
    "subscribe to continue reading",
    "subscriber-only",
  ]),
  blockedPhrases: Object.freeze([
    "verify you are human",
    "access denied",
    "captcha",
    "enable javascript and cookies to continue",
  ]),
});

export const ARTICLE_READER_ADAPTERS = Object.freeze(PUBLICATIONS.map((publication) => {
  const profile = publication.reader;
  return Object.freeze({
    connectorId: publication.id,
    enabled: true,
    domains: profile.domains,
    rootSelectors: Object.freeze(profile.rootSelectors ?? DEFAULT_READER_PROFILE.rootSelectors),
    titleSelectors: Object.freeze(profile.titleSelectors ?? DEFAULT_READER_PROFILE.titleSelectors),
    bylineSelectors: Object.freeze(profile.bylineSelectors ?? DEFAULT_READER_PROFILE.bylineSelectors),
    imageSelectors: Object.freeze(profile.imageSelectors ?? DEFAULT_READER_PROFILE.imageSelectors),
    removeSelectors: Object.freeze([
      ...DEFAULT_READER_PROFILE.removeSelectors,
      ...profile.removeSelectors,
    ]),
    premiumSelectors: Object.freeze(profile.premiumSelectors ?? DEFAULT_READER_PROFILE.premiumSelectors),
    premiumPhrases: Object.freeze(profile.premiumPhrases ?? DEFAULT_READER_PROFILE.premiumPhrases),
    blockedPhrases: Object.freeze(profile.blockedPhrases ?? DEFAULT_READER_PROFILE.blockedPhrases),
    requireDeclaredFreeAccess: profile.requireDeclaredFreeAccess,
  });
}));

export const ARTICLE_READER_FALLBACK_REASONS = Object.freeze([
  "unsupported-source",
  "paywalled",
  "not-article",
  "blocked",
  "timeout",
  "extraction-failed",
]);

const BLOCK_KINDS = new Set(["paragraph", "heading", "list", "quote"]);
const FALLBACK_REASONS = new Set(ARTICLE_READER_FALLBACK_REASONS);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BLOCKED_STATUSES = new Set([401, 403, 407, 429]);
const configuredSessions = new WeakSet();

export function adapterForConnector(connectorId) {
  return ARTICLE_READER_ADAPTERS.find(
    (adapter) => adapter.enabled && adapter.connectorId === connectorId,
  ) ?? null;
}

function fallback(reason) {
  return { ok: false, reason: FALLBACK_REASONS.has(reason) ? reason : "extraction-failed" };
}

function cleanText(value, maximum) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, maximum);
}

function cleanArticleUrl(value) {
  if (typeof value !== "string" || value.length > ARTICLE_READER_LIMITS.maxImageUrlLength) {
    throw new TypeError("URL d’article invalide.");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("URL d’article invalide.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new TypeError("URL d’article invalide.");
  }
  return url.toString();
}

export function isProfileArticleUrl(adapter, value) {
  if (!adapter || typeof value !== "string" || value.length > ARTICLE_READER_LIMITS.maxImageUrlLength) {
    return false;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  return adapter.domains.some(
    (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`),
  );
}

/** Resolves a renderer-supplied item id exclusively against main-owned state. */
export function resolveReaderArticle(itemId, state, activeArticle = null) {
  if (typeof itemId !== "string" || !itemId.trim() || itemId.length > 128) {
    throw new TypeError("Identifiant d’article invalide.");
  }
  const normalizedItemId = itemId.trim();
  const item = state?.items?.find((candidate) => candidate.id === normalizedItemId);
  if (!item) {
    if (activeArticle?.itemId === normalizedItemId) return activeArticle;
    throw new Error("Article introuvable.");
  }
  const source = state.sources?.find((candidate) => candidate.id === item.sourceId);
  if (!source) throw new Error("Source de l’article introuvable.");
  const url = cleanArticleUrl(item.canonicalUrl);
  const adapter = adapterForConnector(source.connectorId);
  if (!adapter || !isProfileArticleUrl(adapter, url)) {
    return {
      itemId: item.id,
      url,
      connectorId: null,
      readerMode: "original",
      readerFallback: "unsupported-source",
    };
  }
  return {
    itemId: item.id,
    url,
    connectorId: adapter.connectorId,
    readerMode: "extracting",
    readerFallback: null,
  };
}

function cleanHttpsImage(value, baseUrl = undefined) {
  if (typeof value !== "string" || value.length > ARTICLE_READER_LIMITS.maxImageUrlLength) {
    return null;
  }
  try {
    const url = new URL(value, baseUrl);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeBlock(block) {
  if (!block || typeof block !== "object" || Array.isArray(block)) return null;
  if (!BLOCK_KINDS.has(block.kind)) return null;
  if (block.kind === "list") {
    if (!Array.isArray(block.items)) return null;
    const items = block.items
      .slice(0, 100)
      .map((item) => cleanText(item, ARTICLE_READER_LIMITS.maxTextPerBlock))
      .filter(Boolean);
    return items.length > 0 ? { kind: "list", items } : null;
  }
  const text = cleanText(block.text, ARTICLE_READER_LIMITS.maxTextPerBlock);
  return text ? { kind: block.kind, text } : null;
}

function blockCharacters(block) {
  return block.kind === "list"
    ? block.items.reduce((total, item) => total + item.length, 0)
    : block.text.length;
}

export function normalizeExtractedArticle(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback("extraction-failed");
  }
  if (value.reason === "paywalled" || value.accessibleForFree === false || value.paywallMatched) {
    return fallback("paywalled");
  }
  if (value.reason === "blocked") return fallback("blocked");
  if (value.reason === "not-article") return fallback("not-article");
  if (!Number.isInteger(value.elementCount) || value.elementCount < 1) {
    return fallback("extraction-failed");
  }
  if (value.elementCount > ARTICLE_READER_LIMITS.maxElements) return fallback("not-article");
  if (!Array.isArray(value.blocks) || value.blocks.length > ARTICLE_READER_LIMITS.maxBlocks) {
    return fallback("not-article");
  }

  const blocks = value.blocks.map(normalizeBlock).filter(Boolean);
  const characters = blocks.reduce((total, block) => total + blockCharacters(block), 0);
  if (
    blocks.length < ARTICLE_READER_LIMITS.minBlocks ||
    characters < ARTICLE_READER_LIMITS.minCharacters ||
    characters > ARTICLE_READER_LIMITS.maxCharacters
  ) {
    return fallback("not-article");
  }

  const title = cleanText(value.title, ARTICLE_READER_LIMITS.maxTitleLength);
  if (!title) return fallback("not-article");
  return {
    ok: true,
    article: {
      title,
      byline: cleanText(value.byline, ARTICLE_READER_LIMITS.maxMetadataLength) || null,
      date: cleanText(value.date, ARTICLE_READER_LIMITS.maxMetadataLength) || null,
      imageUrl: cleanHttpsImage(value.imageUrl),
      blocks,
    },
  };
}

function collectStructuredAccess(value, budget, access, depth = 0) {
  if (budget.remaining <= 0 || depth > 20 || value === null || typeof value !== "object") {
    return;
  }
  budget.remaining -= 1;
  const marker = value.isAccessibleForFree;
  if (marker === false || (typeof marker === "string" && marker.trim().toLowerCase() === "false")) {
    access.premium = true;
  } else if (
    marker === true ||
    (typeof marker === "string" && marker.trim().toLowerCase() === "true")
  ) {
    access.free = true;
  }
  for (const child of Object.values(value)) {
    if (access.premium) return;
    collectStructuredAccess(child, budget, access, depth + 1);
  }
}

function structuredAccess($) {
  let bytes = 0;
  const access = { free: false, premium: false };
  for (const element of $("script[type='application/ld+json']").toArray().slice(0, 32)) {
    const raw = $(element).text().trim();
    bytes += Buffer.byteLength(raw);
    if (!raw) continue;
    if (bytes > ARTICLE_READER_LIMITS.maxStructuredDataBytes) break;
    try {
      collectStructuredAccess(JSON.parse(raw), { remaining: 10_000 }, access);
      if (access.premium) return "premium";
    } catch {
      // Invalid metadata is ignored, never interpreted as an access signal.
    }
  }
  return access.free ? "free" : "unknown";
}

function firstText($, selectors, maximum) {
  for (const selector of selectors) {
    const value = cleanText($(selector).first().text(), maximum);
    if (value) return value;
  }
  return "";
}

function metaContent($, selectors, maximum) {
  for (const selector of selectors) {
    const value = cleanText($(selector).first().attr("content"), maximum);
    if (value) return value;
  }
  return "";
}

function mainImage($, adapter, baseUrl) {
  const candidates = [
    ...adapter.imageSelectors.map((selector) => $(selector).first()),
    $("meta[property='og:image']").first(),
    $("meta[name='twitter:image']").first(),
  ];
  for (const node of candidates) {
    if (!node?.length) continue;
    const srcset = node.attr("srcset")?.split(",", 1)[0]?.trim().split(/\s+/, 1)[0];
    const source =
      node.attr("src") ||
      node.attr("data-src") ||
      node.attr("content") ||
      srcset;
    const image = cleanHttpsImage(source, baseUrl);
    if (image) return image;
  }
  return null;
}

function extractBlocks($) {
  const blocks = [];
  let previous = "";
  const selector = "h2,h3,p,blockquote,ul,ol";
  for (const element of $(selector).toArray()) {
    if (blocks.length >= ARTICLE_READER_LIMITS.maxBlocks) break;
    const node = $(element);
    const tag = element.tagName?.toLowerCase();
    if (node.parents("li").length > 0) continue;
    if (tag !== "blockquote" && node.parents("blockquote").length > 0) continue;
    if (tag !== "ul" && tag !== "ol" && node.parents("ul,ol").length > 0) continue;
    if (tag === "ul" || tag === "ol") {
      const items = node.children("li").toArray()
        .map((item) => cleanText($(item).text(), ARTICLE_READER_LIMITS.maxTextPerBlock))
        .filter(Boolean);
      if (items.length > 0) blocks.push({ kind: "list", items });
      continue;
    }
    const text = cleanText(node.text(), ARTICLE_READER_LIMITS.maxTextPerBlock);
    if (!text || text === previous) continue;
    previous = text;
    blocks.push({
      kind: tag === "blockquote" ? "quote" : tag === "h2" || tag === "h3" ? "heading" : "paragraph",
      text,
    });
  }
  return blocks;
}

function selectRoot($, adapter) {
  for (const selector of adapter.rootSelectors) {
    const root = $(selector).first();
    if (root.length) return root;
  }
  return null;
}

/** Parses a bounded publisher document without executing publisher code. */
export function extractArticleHtml({ connectorId, html, url }) {
  const adapter = adapterForConnector(connectorId);
  if (!adapter) return fallback("unsupported-source");
  if (!isProfileArticleUrl(adapter, url)) return fallback("blocked");
  if (typeof html !== "string" || !html.trim()) return fallback("blocked");
  if (Buffer.byteLength(html) > ARTICLE_READER_LIMITS.maxBytes) return fallback("blocked");

  let $;
  try {
    $ = cheerio.load(html, { scriptingEnabled: false });
  } catch {
    return fallback("extraction-failed");
  }
  const declaredAccess = structuredAccess($);
  if (declaredAccess === "premium") return fallback("paywalled");
  if (adapter.requireDeclaredFreeAccess && declaredAccess !== "free") {
    return fallback("blocked");
  }

  const bodyText = cleanText($("body").text(), 20_000).toLowerCase();
  if (adapter.blockedPhrases.some((phrase) => bodyText.includes(phrase))) {
    return fallback("blocked");
  }
  const root = selectRoot($, adapter);
  if (!root) return fallback(bodyText.length < 500 ? "blocked" : "not-article");
  if (
    adapter.premiumSelectors.some((selector) => root.find(selector).addBack(selector).length > 0) ||
    adapter.premiumPhrases.some((phrase) => cleanText(root.text(), 200_000).toLowerCase().includes(phrase))
  ) {
    return fallback("paywalled");
  }

  const title =
    metaContent($, ["meta[property='og:title']", "meta[name='twitter:title']"], ARTICLE_READER_LIMITS.maxTitleLength) ||
    firstText($, adapter.titleSelectors, ARTICLE_READER_LIMITS.maxTitleLength);
  const byline =
    metaContent($, ["meta[name='author']", "meta[property='article:author']"], ARTICLE_READER_LIMITS.maxMetadataLength) ||
    firstText($, adapter.bylineSelectors, ARTICLE_READER_LIMITS.maxMetadataLength);
  const date =
    metaContent($, ["meta[property='article:published_time']", "meta[name='date']"], ARTICLE_READER_LIMITS.maxMetadataLength) ||
    cleanText($("time[datetime]").first().attr("datetime"), ARTICLE_READER_LIMITS.maxMetadataLength);
  const imageUrl = mainImage($, adapter, url);

  const fragment = cheerio.load(root.toString(), { scriptingEnabled: false });
  for (const selector of adapter.removeSelectors) fragment(selector).remove();
  const elementCount = fragment("*").length;
  if (elementCount > ARTICLE_READER_LIMITS.maxElements) return fallback("not-article");
  return normalizeExtractedArticle({
    elementCount,
    title,
    byline,
    date,
    imageUrl,
    blocks: extractBlocks(fragment),
  });
}

function stripCookieHeaders(headers) {
  const sanitized = { ...(headers ?? {}) };
  for (const name of Object.keys(sanitized)) {
    if (name.toLowerCase() === "set-cookie" || name.toLowerCase() === "set-cookie2") {
      delete sanitized[name];
    }
  }
  return sanitized;
}

export function secureArticleReaderSession(networkSession) {
  if (
    !networkSession ||
    typeof networkSession.fetch !== "function" ||
    typeof networkSession.resolveHost !== "function" ||
    typeof networkSession.resolveProxy !== "function"
  ) {
    throw new TypeError("Session réseau du lecteur invalide.");
  }
  if (configuredSessions.has(networkSession)) return networkSession;
  configuredSessions.add(networkSession);
  const onHeadersReceived = networkSession.webRequest?.onHeadersReceived;
  if (typeof onHeadersReceived === "function") {
    onHeadersReceived.call(
      networkSession.webRequest,
      { urls: ["https://*/*"] },
      (details, callback) => callback({
        cancel: false,
        responseHeaders: stripCookieHeaders(details?.responseHeaders),
      }),
    );
  }
  return networkSession;
}

async function isSafeArticleNetworkHop(session, url, signal) {
  try {
    const route = await session.resolveProxy(url);
    if (signal.aborted) throw createAbortError();
    // Dynamic article URLs are not curated proxy roots. Only a direct route
    // can be proven against the local DNS result before the request is sent.
    if (proxyRouteKind(route) !== "direct") return false;

    const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "");
    const resolved = await session.resolveHost(hostname, {
      cacheUsage: "allowed",
      source: "any",
      secureDnsPolicy: "allow",
    });
    if (signal.aborted) throw createAbortError();
    const endpoints = resolved?.endpoints;
    return (
      Array.isArray(endpoints) &&
      endpoints.length > 0 &&
      endpoints.every(
        (endpoint) =>
          typeof endpoint?.address === "string" &&
          !isNonPublicIpAddress(endpoint.address),
      )
    );
  } catch (error) {
    if (signal.aborted || error?.name === "AbortError") throw createAbortError();
    return false;
  }
}

function createAbortError() {
  const error = new Error("Extraction annulée.");
  error.name = "AbortError";
  return error;
}

async function discardResponseBody(response) {
  try {
    await response.body?.cancel?.();
  } catch {
    // The body may already be closed after an aborted or malformed response.
  }
}

async function readBoundedHtml(response, maximum, signal) {
  const declared = Number.parseInt(response.headers?.get?.("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > maximum) {
    await discardResponseBody(response);
    return fallback("blocked");
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximum) return fallback("blocked");
    return { ok: true, html: new TextDecoder().decode(bytes) };
  }
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw createAbortError();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        return fallback("blocked");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, html: new TextDecoder().decode(bytes) };
}

async function downloadArticleHtml({
  session,
  fetchImpl,
  adapter,
  url,
  signal,
  maxBytes,
  maxRedirects,
}) {
  let currentUrl = url;
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    if (signal.aborted) throw createAbortError();
    if (!(await isSafeArticleNetworkHop(session, currentUrl, signal))) {
      return fallback("blocked");
    }
    const response = await fetchImpl(currentUrl, {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml;q=0.9",
      },
      credentials: "omit",
      cache: "no-store",
      redirect: "manual",
      signal,
      bypassCustomProtocolHandlers: true,
    });
    const observedUrl = response.url || currentUrl;
    if (
      response.redirected === true ||
      observedUrl !== currentUrl ||
      !isProfileArticleUrl(adapter, observedUrl)
    ) {
      await discardResponseBody(response);
      return fallback("blocked");
    }
    if (REDIRECT_STATUSES.has(response.status)) {
      await discardResponseBody(response);
      if (redirectCount === maxRedirects) return fallback("blocked");
      const location = response.headers?.get?.("location");
      let nextUrl;
      try {
        nextUrl = new URL(location, currentUrl).toString();
      } catch {
        return fallback("blocked");
      }
      if (!isProfileArticleUrl(adapter, nextUrl)) return fallback("blocked");
      currentUrl = nextUrl;
      continue;
    }
    if (BLOCKED_STATUSES.has(response.status)) {
      await discardResponseBody(response);
      return fallback("blocked");
    }
    if (response.status < 200 || response.status >= 300) {
      await discardResponseBody(response);
      return fallback("extraction-failed");
    }
    const contentType = response.headers?.get?.("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      await discardResponseBody(response);
      return fallback("blocked");
    }
    const body = await readBoundedHtml(response, maxBytes, signal);
    return body.ok ? { ok: true, html: body.html, url: currentUrl } : body;
  }
  return fallback("blocked");
}

function extractArticleInWorker(input, { signal, deadlineAt }) {
  if (signal.aborted) return Promise.reject(createAbortError());
  const remainingMs = Math.floor(deadlineAt - performance.now());
  if (remainingMs < 1) return Promise.resolve(fallback("timeout"));

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./article-reader-worker.mjs", import.meta.url));
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      void worker.terminate();
      callback(value);
    };
    const onAbort = () => finish(reject, createAbortError());
    const timer = setTimeout(() => finish(resolve, fallback("timeout")), remainingMs);
    signal.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (result) => finish(resolve, result));
    worker.once("error", (error) => finish(reject, error));
    worker.postMessage(input);
  });
}

/** Owns bounded, cookie-free article downloads and never caches article HTML. */
export function createArticleReaderService({
  sessionForConnector,
  fetchForSession = (networkSession) => networkSession.fetch.bind(networkSession),
  timeoutMs = ARTICLE_READER_LIMITS.timeoutMs,
  maxBytes = ARTICLE_READER_LIMITS.maxBytes,
  maxRedirects = ARTICLE_READER_LIMITS.maxRedirects,
} = {}) {
  if (typeof sessionForConnector !== "function") {
    throw new TypeError("Fabrique de sessions du lecteur invalide.");
  }
  if (typeof fetchForSession !== "function") {
    throw new TypeError("Fabrique Fetch du lecteur invalide.");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
    throw new TypeError("Budget du lecteur invalide.");
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > ARTICLE_READER_LIMITS.maxBytes) {
    throw new TypeError("Taille maximale du lecteur invalide.");
  }
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 3) {
    throw new TypeError("Nombre de redirections du lecteur invalide.");
  }

  const sessions = new Map();
  const activeControllers = new Set();
  let stopped = false;

  function readerSession(connectorId) {
    if (sessions.has(connectorId)) return sessions.get(connectorId);
    const networkSession = secureArticleReaderSession(sessionForConnector(connectorId));
    const fetchImpl = fetchForSession(networkSession);
    if (typeof fetchImpl !== "function") {
      throw new TypeError("Téléchargeur du lecteur invalide.");
    }
    const readerSession = { networkSession, fetchImpl };
    sessions.set(connectorId, readerSession);
    return readerSession;
  }

  async function extract({ connectorId, url, signal } = {}) {
    if (stopped) return fallback("extraction-failed");
    const adapter = adapterForConnector(connectorId);
    if (!adapter) return fallback("unsupported-source");
    if (!isProfileArticleUrl(adapter, url)) return fallback("blocked");
    if (signal?.aborted) throw createAbortError();

    const timeoutController = new AbortController();
    const operationController = new AbortController();
    const deadlineAt = performance.now() + timeoutMs;
    const extractionReserveMs = Math.min(
      MAX_EXTRACTION_RESERVE_MS,
      Math.floor(timeoutMs * 0.3),
    );
    const downloadBudgetMs = Math.max(1, timeoutMs - extractionReserveMs);
    activeControllers.add(operationController);
    let resolveInterruption;
    const interruption = new Promise((resolve) => {
      resolveInterruption = resolve;
    });
    const onOperationAbort = () => {
      resolveInterruption(timeoutController.signal.aborted ? "timeout" : "aborted");
    };
    const onCallerAbort = () => operationController.abort();
    const onTimeout = () => {
      timeoutController.abort();
      operationController.abort();
    };
    operationController.signal.addEventListener("abort", onOperationAbort, { once: true });
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    let timer = setTimeout(onTimeout, downloadBudgetMs);
    try {
      const { networkSession, fetchImpl } = readerSession(connectorId);
      const outcome = await Promise.race([
        downloadArticleHtml({
          session: networkSession,
          fetchImpl,
          adapter,
          url,
          signal: operationController.signal,
          maxBytes,
          maxRedirects,
        }).then((response) => ({ type: "response", response })),
        interruption.then((type) => ({ type })),
      ]);
      if (outcome.type === "timeout") return fallback("timeout");
      if (outcome.type === "aborted") throw createAbortError();
      const { response } = outcome;
      if (!response.ok) return response;
      clearTimeout(timer);
      timer = null;
      if (performance.now() >= deadlineAt) return fallback("timeout");
      const result = await extractArticleInWorker(
        { connectorId, html: response.html, url: response.url },
        { signal: operationController.signal, deadlineAt },
      );
      return performance.now() >= deadlineAt ? fallback("timeout") : result;
    } catch (error) {
      if (signal?.aborted || (operationController.signal.aborted && !timeoutController.signal.aborted)) {
        throw createAbortError();
      }
      if (timeoutController.signal.aborted) return fallback("timeout");
      return fallback("extraction-failed");
    } finally {
      if (timer !== null) clearTimeout(timer);
      signal?.removeEventListener("abort", onCallerAbort);
      operationController.signal.removeEventListener("abort", onOperationAbort);
      activeControllers.delete(operationController);
    }
  }

  async function shutdown() {
    stopped = true;
    for (const controller of activeControllers) controller.abort();
    activeControllers.clear();
    await Promise.allSettled(
      [...sessions.values()].map(({ networkSession }) =>
        networkSession.clearStorageData?.({
          storages: ["cookies", "localstorage", "cachestorage", "serviceworkers"],
        })),
    );
    sessions.clear();
  }

  return Object.freeze({ extract, shutdown });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Produces a self-contained, inert article page for a native view. */
export function createStaticReaderDocument(article) {
  const normalized = normalizeExtractedArticle({
    ...article,
    elementCount: article?.elementCount ?? 1,
  });
  if (!normalized.ok) throw new TypeError("Article simplifié invalide.");
  const { title, byline, date, blocks } = normalized.article;
  const metadata = [byline, date].filter(Boolean).map(escapeHtml).join(" · ");
  const body = blocks
    .map((block) => {
      if (block.kind === "heading") return `<h2>${escapeHtml(block.text)}</h2>`;
      if (block.kind === "quote") return `<blockquote>${escapeHtml(block.text)}</blockquote>`;
      if (block.kind === "list") {
        return `<ul>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
      }
      return `<p>${escapeHtml(block.text)}</p>`;
    })
    .join("");
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'"><title>${escapeHtml(title)}</title><style>html{background:#11110f;color:#ece9df}body{max-width:760px;margin:0 auto;padding:40px 28px 80px;font:19px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}h1{font-size:34px;line-height:1.18;margin:0 0 12px}h2{font-size:23px;line-height:1.3;margin:34px 0 12px}.meta{color:#aaa59a;font-size:14px;margin:0 0 28px}p,li,blockquote{max-width:68ch}blockquote{border-left:3px solid #d69b42;margin:24px 0;padding-left:18px;color:#d7d1c5}ul{padding-left:26px}</style></head><body><article><h1>${escapeHtml(title)}</h1>${metadata ? `<p class="meta">${metadata}</p>` : ""}${body}</article></body></html>`;
}
