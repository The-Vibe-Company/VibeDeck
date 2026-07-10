import assert from "node:assert/strict";
import test from "node:test";

import { SOURCE_CATALOG } from "./feed-engine.mjs";
import {
  ARTICLE_READER_ADAPTERS,
  ARTICLE_READER_LIMITS,
  adapterForConnector,
  createArticleReaderService,
  createStaticReaderDocument,
  extractArticleHtml,
  isProfileArticleUrl,
  normalizeExtractedArticle,
  resolveReaderArticle,
  secureArticleReaderSession,
} from "./article-reader.mjs";

const paragraph = "Contenu public structuré et vérifiable pour la lecture dédiée. ".repeat(6);
const validArticle = {
  elementCount: 120,
  title: "Un article public",
  byline: "Une autrice",
  date: "2026-07-10",
  imageUrl: "https://images.example.test/photo.jpg",
  blocks: [
    { kind: "paragraph", text: paragraph },
    { kind: "heading", text: "Le contexte" },
    { kind: "paragraph", text: paragraph },
  ],
};

function publicHtml(connectorId, { premium = false, invalidMetadata = false } = {}) {
  const structuredData = invalidMetadata
    ? "{invalid"
    : JSON.stringify({
        "@context": "https://schema.org",
        "@type": "NewsArticle",
        isAccessibleForFree: !premium,
      });
  const metadata = `<head><meta property="og:title" content="Titre ${connectorId}"><meta name="author" content="Rédaction"><meta property="article:published_time" content="2026-07-10"><meta property="og:image" content="https://images.example.test/${connectorId}.jpg"><script type="application/ld+json">${structuredData}</script></head>`;
  const body = `<p>${paragraph}</p><h2>Intertitre</h2><p>${paragraph}</p>`;
  if (connectorId === "le-monde") {
    return `<!doctype html><html>${metadata}<body><main><article><h1>Titre Monde</h1>${body}</article></main></body></html>`;
  }
  if (connectorId === "le-figaro") {
    return `<!doctype html><html>${metadata}<body><main><article><h1>Titre Figaro</h1><div class="fig-sharebar"><p>${"Partager ".repeat(100)}</p></div>${body}<div data-component="advert-slot"><p>${paragraph}</p></div></article></main></body></html>`;
  }
  return `<!doctype html><html>${metadata}<body><main><h1>Titre Parisien</h1><article><section class="article-section margin_bottom_article paywall-article-section">${body}</section></article></main></body></html>`;
}

function htmlResponse(html, { status = 200, headers = {} } = {}) {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

class FakeReaderSession {
  constructor(fetchImpl) {
    this.fetchImpl = fetchImpl;
    this.fetchCalls = [];
    this.clearStorageDataCalls = [];
    this.webRequest = {
      onHeadersReceived: (filter, handler) => {
        this.headersFilter = filter;
        this.headersHandler = handler;
      },
    };
  }

  fetch(url, options) {
    this.fetchCalls.push([url, options]);
    return this.fetchImpl(url, options, this.fetchCalls.length);
  }

  async clearStorageData(options) {
    this.clearStorageDataCalls.push(options);
  }
}

test("every proposed catalog connector has an enabled dedicated adapter", () => {
  assert.deepEqual(
    SOURCE_CATALOG.map(({ id }) => id).sort(),
    ARTICLE_READER_ADAPTERS.filter(({ enabled }) => enabled).map(({ connectorId }) => connectorId).sort(),
  );
});

test("adapters only authorize their declared HTTPS publication domains", () => {
  const monde = adapterForConnector("le-monde");
  assert.ok(monde);
  assert.equal(isProfileArticleUrl(monde, "https://www.lemonde.fr/politique/article"), true);
  assert.equal(isProfileArticleUrl(monde, "http://www.lemonde.fr/article"), false);
  assert.equal(isProfileArticleUrl(monde, "https://lemonde.fr.attacker.test/article"), false);
  assert.equal(adapterForConnector("custom-rss"), null);
});

test("extracts each publication through its dedicated server-HTML root", () => {
  for (const connectorId of ["le-monde", "le-figaro", "le-parisien"]) {
    const result = extractArticleHtml({
      connectorId,
      html: publicHtml(connectorId),
      url: `https://www.${adapterForConnector(connectorId).domains[0]}/article-test`,
    });
    assert.equal(result.ok, true, connectorId);
    assert.equal(result.article.blocks.length, 3, connectorId);
  }
});

test("Parisien paywall classes remain public while isAccessibleForFree false wins", () => {
  const url = "https://www.leparisien.fr/faits-divers/article-test";
  const publicResult = extractArticleHtml({
    connectorId: "le-parisien",
    html: publicHtml("le-parisien"),
    url,
  });
  assert.equal(publicResult.ok, true);

  const premiumHtml = publicHtml("le-parisien").replace(
    '"isAccessibleForFree":true',
    '"@graph":[{"isAccessibleForFree":false}]',
  );
  assert.deepEqual(extractArticleHtml({ connectorId: "le-parisien", html: premiumHtml, url }), {
    ok: false,
    reason: "paywalled",
  });
});

test("removes Figaro sharing, recommendations and advertising before block extraction", () => {
  const result = extractArticleHtml({
    connectorId: "le-figaro",
    html: publicHtml("le-figaro"),
    url: "https://www.lefigaro.fr/actualite/article-test",
  });
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result.article.blocks).includes("Partager"), false);
});

test("falls back immediately for blocked, wrong-domain, short and oversized documents", () => {
  assert.deepEqual(extractArticleHtml({
    connectorId: "le-monde",
    html: "<html><body>Access denied</body></html>",
    url: "https://www.lemonde.fr/article",
  }), { ok: false, reason: "blocked" });
  assert.deepEqual(extractArticleHtml({
    connectorId: "le-monde",
    html: publicHtml("le-monde"),
    url: "https://attacker.test/article",
  }), { ok: false, reason: "blocked" });
  assert.deepEqual(extractArticleHtml({
    connectorId: "le-monde",
    html: "<main><article><h1>Titre</h1><p>Trop court.</p></article></main>",
    url: "https://www.lemonde.fr/article",
  }), { ok: false, reason: "not-article" });
  assert.deepEqual(extractArticleHtml({
    connectorId: "le-monde",
    html: "x".repeat(ARTICLE_READER_LIMITS.maxBytes + 1),
    url: "https://www.lemonde.fr/article",
  }), { ok: false, reason: "blocked" });
});

test("invalid structured metadata is ignored without weakening premium checks", () => {
  const result = extractArticleHtml({
    connectorId: "le-parisien",
    html: publicHtml("le-parisien", { invalidMetadata: true }),
    url: "https://www.leparisien.fr/article-test",
  });
  assert.equal(result.ok, true);
});

test("normalizes bounded blocks and creates an escaped inert static document", () => {
  const result = normalizeExtractedArticle({
    ...validArticle,
    imageUrl: "http://images.example.test/photo.jpg",
    blocks: [...validArticle.blocks, { kind: "paragraph", text: "<img src=x onerror=alert(1)>" }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.article.imageUrl, null);

  const document = createStaticReaderDocument({
    ...validArticle,
    title: "<script>alert(1)</script>",
    blocks: validArticle.blocks.map((block) => ({ ...block, text: `${block.text}<iframe>` })),
    elementCount: 1,
  });
  assert.match(document, /Content-Security-Policy/);
  assert.match(document, /default-src 'none'/);
  assert.doesNotMatch(document, /<script>alert/);
  assert.doesNotMatch(document, /<iframe>/);
  assert.doesNotMatch(document, /<a /);
  assert.doesNotMatch(document, /<img /);
});

test("reader service uses one cookie-free document request and reuses its connector session", async () => {
  const networkSession = new FakeReaderSession(async () => htmlResponse(publicHtml("le-figaro")));
  let sessionCreations = 0;
  const service = createArticleReaderService({
    sessionForConnector: () => {
      sessionCreations += 1;
      return networkSession;
    },
  });

  const first = await service.extract({
    connectorId: "le-figaro",
    url: "https://www.lefigaro.fr/article-un",
  });
  const second = await service.extract({
    connectorId: "le-figaro",
    url: "https://www.lefigaro.fr/article-deux",
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(sessionCreations, 1);
  assert.equal(networkSession.fetchCalls.length, 2, "no subresource may be requested");
  const options = networkSession.fetchCalls[0][1];
  assert.equal(options.credentials, "omit");
  assert.equal(options.cache, "no-store");
  assert.equal(options.redirect, "manual");
  assert.equal(options.bypassCustomProtocolHandlers, true);

  let sanitized;
  networkSession.headersHandler({
    responseHeaders: { "Set-Cookie": ["secret=1"], "Content-Type": ["text/html"] },
  }, (response) => {
    sanitized = response.responseHeaders;
  });
  assert.equal(sanitized["Set-Cookie"], undefined);
  assert.deepEqual(sanitized["Content-Type"], ["text/html"]);
  await service.shutdown();
  assert.equal(networkSession.clearStorageDataCalls.length, 1);
});

test("reader service follows at most same-adapter HTTPS redirects", async () => {
  const responses = [
    htmlResponse("", { status: 302, headers: { location: "/article-final" } }),
    htmlResponse(publicHtml("le-monde")),
  ];
  const session = new FakeReaderSession(async (_url, _options, call) => responses[call - 1]);
  const service = createArticleReaderService({ sessionForConnector: () => session });
  const result = await service.extract({
    connectorId: "le-monde",
    url: "https://www.lemonde.fr/article-initial",
  });
  assert.equal(result.ok, true);
  assert.equal(session.fetchCalls.length, 2);

  const hostile = new FakeReaderSession(async () =>
    htmlResponse("", { status: 302, headers: { location: "https://attacker.test/article" } }));
  const hostileService = createArticleReaderService({ sessionForConnector: () => hostile });
  assert.deepEqual(await hostileService.extract({
    connectorId: "le-monde",
    url: "https://www.lemonde.fr/article",
  }), { ok: false, reason: "blocked" });
  assert.equal(hostile.fetchCalls.length, 1);
});

test("reader service stops a streamed document at its byte limit", async () => {
  const networkSession = new FakeReaderSession(async () => htmlResponse(publicHtml("le-monde")));
  const service = createArticleReaderService({
    sessionForConnector: () => networkSession,
    maxBytes: 128,
  });
  assert.deepEqual(await service.extract({
    connectorId: "le-monde",
    url: "https://www.lemonde.fr/article",
  }), { ok: false, reason: "blocked" });
  assert.equal(networkSession.fetchCalls.length, 1);
});

test("reader service enforces its total budget and caller cancellation", async () => {
  const delayed = new FakeReaderSession(() => new Promise(() => {}));
  const timedService = createArticleReaderService({
    sessionForConnector: () => delayed,
    timeoutMs: 25,
  });
  assert.deepEqual(await timedService.extract({
    connectorId: "le-monde",
    url: "https://www.lemonde.fr/article",
  }), { ok: false, reason: "timeout" });

  const cancellationService = createArticleReaderService({
    sessionForConnector: () => new FakeReaderSession(() => new Promise(() => {})),
  });
  const controller = new AbortController();
  const pending = cancellationService.extract({
    connectorId: "le-monde",
    url: "https://www.lemonde.fr/article",
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("secure session setup is idempotent", () => {
  const networkSession = new FakeReaderSession(async () => htmlResponse(""));
  assert.equal(secureArticleReaderSession(networkSession), networkSession);
  const handler = networkSession.headersHandler;
  assert.equal(secureArticleReaderSession(networkSession), networkSession);
  assert.equal(networkSession.headersHandler, handler);
});

test("resolves items from main-owned state and sends custom sources directly to original", () => {
  const state = {
    items: [{ id: "item-1", sourceId: "source-1", canonicalUrl: "https://www.lemonde.fr/article" }],
    sources: [{ id: "source-1", connectorId: "le-monde" }],
  };
  const dedicated = resolveReaderArticle("item-1", state);
  assert.equal(dedicated.readerMode, "extracting");
  assert.equal(dedicated.connectorId, "le-monde");
  assert.equal(resolveReaderArticle("item-1", {
    ...state,
    sources: [{ id: "source-1", connectorId: null }],
  }).readerFallback, "unsupported-source");
  assert.throws(() => resolveReaderArticle("forged", state), /introuvable/);
});
