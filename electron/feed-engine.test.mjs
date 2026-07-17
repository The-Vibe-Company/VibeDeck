import assert from "node:assert/strict";
import test from "node:test";

import {
  SOURCE_CATALOG,
  assertSafeFeedUrl,
  canonicalizeUrl,
  createFeedEngine,
  discoverFeedsInHtml,
  enrichItemsFromNewsSitemap,
  feedUrlsShareSite,
  isNonPublicIpAddress,
  matchKnownPublication,
  normalizeInputUrl,
  parseFeedDocument,
  readResponseTextWithLimit,
  settleWithConcurrencyLimits,
} from "./feed-engine.mjs";
import { CURATED_PROXY_ROOTS, CURATED_SOURCES, PUBLICATIONS } from "./publication-registry.mjs";

const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Le fil de test</title>
    <item>
      <title><![CDATA[Premier <b>sujet</b>]]></title>
      <link>https://example.test/articles/1?utm_source=newsletter&amp;b=2&amp;a=1</link>
      <description><![CDATA[<p>Une courte description.</p>]]></description>
      <enclosure url="https://example.test/image.jpg" type="image/jpeg" />
      <pubDate>Thu, 09 Jul 2026 10:30:00 GMT</pubDate>
    </item>
    <item>
      <title>Version dupliquée</title>
      <link>https://example.test/articles/1?a=1&amp;b=2&amp;utm_medium=rss</link>
    </item>
  </channel>
</rss>`;

const ATOM_FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Fil Atom</title>
  <entry>
    <title>Un article Atom</title>
    <link rel="alternate" href="/atom/42#comments" />
    <link rel="enclosure" type="image/webp" href="/atom/42.webp" />
    <id>tag:example.test,2026:42</id>
    <updated>2026-07-09T11:12:13+02:00</updated>
    <summary type="html">Du contenu &amp; des détails</summary>
  </entry>
</feed>`;

const SITEMAP_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url>
    <loc>https://journal.test/politique/une-annonce.html?utm_campaign=x</loc>
    <lastmod>2026-07-09T11:00:00+02:00</lastmod>
    <news:news>
      <news:publication><news:name>Le Journal</news:name><news:language>fr</news:language></news:publication>
      <news:publication_date>2026-07-09T10:58:00+02:00</news:publication_date>
      <news:title>Une annonce importante</news:title>
    </news:news>
    <image:image><image:loc>https://journal.test/photo.jpg</image:loc></image:image>
  </url>
</urlset>`;

const LE_PARISIEN_RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Le Parisien</title>
    <item>
      <title>Titre RSS A</title>
      <link>https://www.leparisien.fr/politique/article-a-09-07-2026-X.php?utm_source=rss</link>
    </item>
    <item>
      <title>Titre RSS B</title>
      <link>https://www.leparisien.fr/sports/article-b-09-07-2026-Y.php</link>
    </item>
  </channel>
</rss>`;

const LE_PARISIEN_SITEMAP_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url>
    <loc>https://www.leparisien.fr/sports/article-b-09-07-2026-Y.php</loc>
    <lastmod>2026-07-09T11:50:30+02:00</lastmod>
    <news:news>
      <news:publication><news:name>Le Parisien</news:name></news:publication>
      <news:publication_date>2026-07-09T11:49:00+02:00</news:publication_date>
      <news:title>Titre sitemap à ne pas utiliser B</news:title>
    </news:news>
  </url>
  <url>
    <loc>https://www.leparisien.fr/politique/article-a-09-07-2026-X.php</loc>
    <lastmod>2026-07-09T11:35:00+02:00</lastmod>
    <news:news>
      <news:publication><news:name>Le Parisien</news:name></news:publication>
      <news:publication_date>2026-07-09T11:30:00+02:00</news:publication_date>
      <news:title>Titre sitemap à ne pas utiliser A</news:title>
    </news:news>
    <image:image><image:loc>https://www.leparisien.fr/photo-a.jpg</image:loc></image:image>
  </url>
</urlset>`;

function feedWithRawEntryCount(kind, count) {
  if (kind === "rss") {
    return `<rss version="2.0"><channel>${"<item/>".repeat(count)}</channel></rss>`;
  }
  if (kind === "atom") {
    return `<feed xmlns="http://www.w3.org/2005/Atom">${"<entry/>".repeat(count)}</feed>`;
  }
  return `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${"<url/>".repeat(count)}</urlset>`;
}

function response(body, { status = 200, headers = {}, url } = {}) {
  const result = new Response(status === 304 ? null : body, { status, headers });
  if (url) Object.defineProperty(result, "url", { value: url });
  return result;
}

test("settles bounded work in input order with global and per-key limits", async () => {
  const values = Array.from({ length: 18 }, (_, index) => ({
    index,
    host: index < 9 ? "one.test" : index < 15 ? "two.test" : "three.test",
  }));
  let active = 0;
  let maximumActive = 0;
  const activeByHost = new Map();
  const maximumByHost = new Map();
  const releases = [];

  const settled = settleWithConcurrencyLimits(
    values,
    async (value) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const hostActive = (activeByHost.get(value.host) ?? 0) + 1;
      activeByHost.set(value.host, hostActive);
      maximumByHost.set(value.host, Math.max(maximumByHost.get(value.host) ?? 0, hostActive));
      await new Promise((resolve) => releases.push(resolve));
      active -= 1;
      activeByHost.set(value.host, (activeByHost.get(value.host) ?? 1) - 1);
      if (value.index === 7) throw new Error("échec attendu");
      return value.index;
    },
    { keyForValue: ({ host }) => host },
  );

  while (releases.length < 6) await new Promise((resolve) => setImmediate(resolve));
  while (releases.length > 0) {
    releases.shift()();
    await new Promise((resolve) => setImmediate(resolve));
  }
  const results = await settled;
  assert.equal(maximumActive, 6);
  assert.deepEqual([...maximumByHost.values()], [2, 2, 2]);
  assert.equal(results.length, values.length);
  assert.equal(results[7].status, "rejected");
  assert.deepEqual(
    results.filter(({ status }) => status === "fulfilled").map(({ value }) => value),
    values.map(({ index }) => index).filter((index) => index !== 7),
  );
});

async function createFeedPanel(engine, name = "À la une") {
  const state = await engine.createPanel({ kind: "feed", name });
  return state.panels.find((panel) => panel.kind === "feed" && panel.name === name);
}

async function importRefreshSources(engine, feedUrls) {
  const panelId = "refresh-queue-panel";
  const sources = feedUrls.map((feedUrl, index) => ({
    id: `refresh-source-${index}`,
    name: `Source ${index + 1}`,
    inputUrl: feedUrl,
    feedUrl,
    connectorId: null,
    connectorKind: "rss",
    refreshIntervalSeconds: 60,
  }));
  await engine.importDashboardConfig({
    format: "vibedeck-dashboard",
    version: 1,
    layout: { type: "panel", panelId },
    panels: [
      {
        id: panelId,
        kind: "feed",
        name: "File de test",
        defaultRefreshIntervalSeconds: 60,
        sourceIds: sources.map(({ id }) => id),
      },
    ],
    sources,
  });
  return sources.map(({ id }) => id);
}

async function waitForCondition(predicate, label) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`Délai dépassé : ${label}`);
}

test("exposes an immutable catalogue with only verified capabilities", () => {
  const allowedCapabilities = new Set(["optimized-feed", "simplified-reading"]);

  assert.equal(Object.isFrozen(SOURCE_CATALOG), true);
  assert.deepEqual(
    SOURCE_CATALOG.map(({ id, capabilities }) => ({ id, capabilities })),
    CURATED_SOURCES.map(({ id, sourceType }) => ({
      id,
      capabilities: sourceType === "media"
        ? ["optimized-feed", "simplified-reading"]
        : ["optimized-feed"],
    })),
  );
  for (const source of SOURCE_CATALOG) {
    assert.equal(Object.isFrozen(source), true);
    assert.equal(Object.isFrozen(source.capabilities), true);
    assert.ok(source.description.length > 0 && source.description.length <= 120);
    assert.equal(Object.hasOwn(source, "feedUrl"), false);
    assert.equal(source.capabilities.every((capability) => allowedCapabilities.has(capability)), true);
  }

  const engine = createFeedEngine();
  try {
    const firstProjection = engine.getSourceCatalog();
    firstProjection[0].capabilities.push("unknown-capability");
    assert.deepEqual(engine.getSourceCatalog()[0].capabilities, [
      "optimized-feed",
      "simplified-reading",
    ]);
  } finally {
    engine.close();
  }
});

test("allocates strictly increasing refresh cycles when the clock stalls or moves backward", () => {
  let now = new Date("2026-07-10T12:00:00.010Z");
  const engine = createFeedEngine({ now: () => now });
  try {
    assert.equal(engine.createArrivalBatchAt(), "2026-07-10T12:00:00.010Z");
    assert.equal(engine.createArrivalBatchAt(), "2026-07-10T12:00:00.011Z");
    now = new Date("2026-07-10T11:59:59.000Z");
    assert.equal(engine.createArrivalBatchAt(), "2026-07-10T12:00:00.012Z");
  } finally {
    engine.close();
  }
});

test("probes a direct feed through a bounded projection without changing visible state", async () => {
  const engine = createFeedEngine({
    fetchImpl: async () =>
      response(RSS_FIXTURE, {
        headers: { "content-type": "application/rss+xml", "cache-control": "max-age=300" },
      }),
    now: () => new Date("2026-07-09T12:00:00.000Z"),
  });
  try {
    const before = engine.getState();
    const result = await engine.probeSource(" example.test/feed.xml#articles ");

    assert.deepEqual(result, {
      normalizedInputUrl: "https://example.test/feed.xml",
      name: "Le fil de test",
      connectorKind: "rss",
      connectorId: null,
      itemCount: 1,
      samples: [
        {
          title: "Premier sujet",
          publishedAt: "2026-07-09T10:30:00.000Z",
        },
      ],
      freshness: "fresh",
      warning: null,
    });
    assert.equal(Object.hasOwn(result, "feedUrl"), false);
    assert.equal(Object.hasOwn(result.samples[0], "url"), false);
    assert.equal(Object.hasOwn(result.samples[0], "html"), false);
    assert.deepEqual(engine.getState(), before);
  } finally {
    engine.close();
  }
});

test("projects the dedicated connector id without exposing its private feed URL", async () => {
  const privateFeedUrl = "https://www.lemonde.fr/rss/en_continu.xml";
  const engine = createFeedEngine({
    fetchImpl: async (url) => {
      assert.equal(url, privateFeedUrl);
      return response(RSS_FIXTURE, {
        headers: { "content-type": "application/rss+xml" },
      });
    },
  });
  try {
    const result = await engine.probeSource("https://www.lemonde.fr/politique/");

    assert.equal(result.normalizedInputUrl, "https://www.lemonde.fr/politique/");
    assert.equal(result.name, "Le Monde");
    assert.equal(result.connectorId, "le-monde");
    assert.equal(JSON.stringify(result).includes(privateFeedUrl), false);
  } finally {
    engine.close();
  }
});

test("probes an advertised feed while honoring the requested connector kind", async () => {
  const homepageUrl = "https://discovery.test/";
  const feedUrl = "https://discovery.test/feed.atom";
  const calls = [];
  const engine = createFeedEngine({
    fetchImpl: async (url) => {
      calls.push(url);
      if (url === homepageUrl) {
        return response(
          '<html><head><link rel="alternate" type="application/atom+xml" href="/feed.atom"></head></html>',
          { headers: { "content-type": "text/html" } },
        );
      }
      if (url === feedUrl) {
        return response(ATOM_FIXTURE, {
          headers: { "content-type": "application/atom+xml" },
        });
      }
      throw new Error("Requête inattendue pendant le test.");
    },
  });
  try {
    const result = await engine.probeSource({
      url: homepageUrl,
      connectorKind: "atom",
    });

    assert.equal(result.normalizedInputUrl, homepageUrl);
    assert.equal(result.name, "Fil Atom");
    assert.equal(result.connectorKind, "atom");
    assert.equal(result.connectorId, null);
    assert.equal(result.itemCount, 1);
    assert.deepEqual(calls, [homepageUrl, feedUrl]);
    assert.equal(engine.getState().sources.length, 0);
    assert.equal(engine.getState().items.length, 0);
  } finally {
    engine.close();
  }
});

test("bounds probe samples and their text independently from the feed size", async () => {
  const longName = "N".repeat(500);
  const longTitle = "T".repeat(500);
  const items = Array.from(
    { length: 5 },
    (_value, index) => `<item>
      <title>${longTitle}${index}</title>
      <link>https://bounds.test/articles/${index}</link>
      <pubDate>Thu, 09 Jul 2026 10:3${index}:00 GMT</pubDate>
    </item>`,
  ).join("");
  const engine = createFeedEngine({
    fetchImpl: async () =>
      response(`<rss><channel><title>${longName}</title>${items}</channel></rss>`, {
        headers: { "content-type": "application/rss+xml" },
      }),
  });
  try {
    const result = await engine.probeSource("https://bounds.test/feed.xml");

    assert.equal(result.itemCount, 5);
    assert.equal(result.samples.length, 3);
    assert.ok(result.name.length <= 120);
    assert.equal(result.samples.every(({ title }) => title.length <= 350), true);
    assert.deepEqual(Object.keys(result.samples[0]).sort(), ["publishedAt", "title"]);
  } finally {
    engine.close();
  }
});

test("reports an empty feed as a successful probe with a warning", async () => {
  const engine = createFeedEngine({
    fetchImpl: async () =>
      response("<rss><channel><title>Flux vide</title></channel></rss>", {
        headers: { "content-type": "application/rss+xml" },
      }),
  });
  try {
    const result = await engine.probeSource("https://empty.test/feed.xml");

    assert.equal(result.freshness, "fresh");
    assert.equal(result.itemCount, 0);
    assert.deepEqual(result.samples, []);
    assert.match(result.warning, /aucun article/);
  } finally {
    engine.close();
  }
});

test("uses stale endpoint cache for a probe without leaking the network error", async () => {
  let online = true;
  let fetchCount = 0;
  const engine = createFeedEngine({
    fetchImpl: async () => {
      fetchCount += 1;
      if (!online) {
        throw new Error("offline https://stale.test/feed.xml");
      }
      return response(RSS_FIXTURE, {
        headers: { "content-type": "application/rss+xml", "cache-control": "max-age=0" },
      });
    },
    now: () => new Date("2026-07-09T12:00:00.000Z"),
  });
  try {
    const fresh = await engine.probeSource("https://stale.test/feed.xml");
    online = false;
    const stale = await engine.probeSource("https://stale.test/feed.xml");

    assert.equal(fresh.freshness, "fresh");
    assert.equal(stale.freshness, "stale");
    assert.equal(stale.itemCount, fresh.itemCount);
    assert.match(stale.warning, /dernier cache disponible/);
    assert.doesNotMatch(stale.warning, /offline|https?:/);
    assert.equal(fetchCount, 2);
    assert.equal(engine.getState().sources.length, 0);
    assert.equal(engine.getState().items.length, 0);
  } finally {
    engine.close();
  }
});

test("aborts a source probe at the active network request", async () => {
  let resolveStarted;
  const started = new Promise((resolve) => {
    resolveStarted = resolve;
  });
  let networkAborted = false;
  const engine = createFeedEngine({
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      resolveStarted();
      options.signal.addEventListener("abort", () => {
        networkAborted = true;
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
    }),
  });
  const controller = new AbortController();
  try {
    const probe = engine.probeSource("https://cancelled-probe.test/feed.xml", {
      signal: controller.signal,
    });
    await started;
    controller.abort();

    await assert.rejects(probe, /Téléchargement interrompu/);
    assert.equal(networkAborted, true);
    assert.equal(engine.getState().sources.length, 0);
  } finally {
    engine.close();
  }
});

test("rejects an already cancelled probe without starting a request", async () => {
  let fetchCount = 0;
  const engine = createFeedEngine({
    fetchImpl: async () => {
      fetchCount += 1;
      return response(RSS_FIXTURE);
    },
  });
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(
      engine.probeSource("https://already-cancelled.test/feed.xml", {
        signal: controller.signal,
      }),
      /Téléchargement interrompu/,
    );
    assert.equal(fetchCount, 0);
  } finally {
    engine.close();
  }
});

test("propagates cancellation through advertised feed discovery", async () => {
  const homepageUrl = "https://cancel-discovery.test/";
  let candidateAbortCount = 0;
  let resolveCandidateStarted;
  const candidateStarted = new Promise((resolve) => {
    resolveCandidateStarted = resolve;
  });
  const engine = createFeedEngine({
    fetchImpl: async (url, options) => {
      if (url === homepageUrl) {
        return response(
          '<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head></html>',
          { headers: { "content-type": "text/html" } },
        );
      }
      resolveCandidateStarted();
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          candidateAbortCount += 1;
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
    },
  });
  const controller = new AbortController();
  try {
    const probe = engine.probeSource(homepageUrl, { signal: controller.signal });
    await candidateStarted;
    controller.abort();

    await assert.rejects(probe, (error) => {
      assert.match(error.message, /Téléchargement interrompu/);
      assert.doesNotMatch(error.message, /flux annoncé.+illisible/i);
      return true;
    });
    assert.equal(candidateAbortCount, 1);
  } finally {
    engine.close();
  }
});

test("propagates probe cancellation through specialized enrichment", async () => {
  const feedUrl = "https://feeds.leparisien.fr/leparisien/rss";
  const sitemapUrl =
    "https://www.leparisien.fr/arc/outboundfeeds/sitemapnews/?outputType=xml&from=0";
  let resolveEnrichmentStarted;
  const enrichmentStarted = new Promise((resolve) => {
    resolveEnrichmentStarted = resolve;
  });
  let sitemapAborted = false;
  const engine = createFeedEngine({
    fetchImpl: async (url, options) => {
      if (url === feedUrl) {
        return response(RSS_FIXTURE, {
          headers: { "content-type": "application/rss+xml" },
        });
      }
      assert.equal(url, sitemapUrl);
      resolveEnrichmentStarted();
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          sitemapAborted = true;
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
    },
  });
  const controller = new AbortController();
  try {
    const probe = engine.probeSource("https://www.leparisien.fr/", {
      signal: controller.signal,
    });
    await enrichmentStarted;
    controller.abort();

    await assert.rejects(probe, /Téléchargement interrompu/);
    assert.equal(sitemapAborted, true);
  } finally {
    engine.close();
  }
});

function controlledRefreshFetch() {
  let active = 0;
  let started = 0;
  let completed = 0;
  let maxGlobal = 0;
  const activeByHost = new Map();
  const maxByHost = new Map();
  const requests = [];

  const fetchImpl = (url, options) =>
    new Promise((resolve, reject) => {
      const hostname = new URL(url).hostname;
      let settled = false;
      started += 1;
      active += 1;
      maxGlobal = Math.max(maxGlobal, active);
      const hostActive = (activeByHost.get(hostname) ?? 0) + 1;
      activeByHost.set(hostname, hostActive);
      maxByHost.set(hostname, Math.max(maxByHost.get(hostname) ?? 0, hostActive));

      const settle = (operation) => {
        if (settled) return;
        settled = true;
        completed += 1;
        active -= 1;
        const remaining = (activeByHost.get(hostname) ?? 1) - 1;
        if (remaining <= 0) activeByHost.delete(hostname);
        else activeByHost.set(hostname, remaining);
        operation();
      };
      const request = {
        url,
        get settled() {
          return settled;
        },
        release: () =>
          settle(() =>
            resolve(
              response(RSS_FIXTURE, {
                headers: {
                  "content-type": "application/rss+xml",
                  "cache-control": "no-store",
                },
              }),
            )),
      };
      requests.push(request);
      options.signal.addEventListener(
        "abort",
        () => settle(() => reject(new DOMException("aborted", "AbortError"))),
        { once: true },
      );
    });

  return {
    fetchImpl,
    requests,
    releasePending() {
      const pending = requests.filter(({ settled }) => !settled);
      for (const request of pending) request.release();
      return pending.length;
    },
    stats() {
      return { active, started, completed, maxGlobal, maxByHost: new Map(maxByHost) };
    },
  };
}

test("normalise pasted URLs and maps curated sources", () => {
  assert.equal(normalizeInputUrl("example.test/path"), "https://example.test/path");
  for (const source of CURATED_SOURCES) {
    assert.equal(matchKnownPublication(source.homepageUrl)?.id, source.id);
    assert.equal(matchKnownPublication(source.feedUrl)?.id, source.id);
    for (const hostname of source.hostnames) {
      assert.equal(
        matchKnownPublication(`https://actualites.${hostname}/article-public`)?.id,
        source.id,
      );
      assert.equal(matchKnownPublication(`https://${hostname}.evil.test/article`), null);
      assert.equal(matchKnownPublication(`https://${hostname}/rss/section.xml`), null);
    }
  }
  assert.equal(matchKnownPublication("https://example.test"), null);
  assert.equal(matchKnownPublication("https://www.lemonde.fr/rss/economie.xml"), null);
  assert.equal(matchKnownPublication("https://www.lefigaro.fr/sitemap_news.xml"), null);
  assert.equal(matchKnownPublication("https://feeds.leparisien.fr/sports/rss"), null);
  assert.throws(() => normalizeInputUrl("file:///tmp/feed.xml"), /HTTP/);
});

test("blocks private feed destinations and recognizes same-site hosts", () => {
  assert.equal(assertSafeFeedUrl("https://news.example.test/rss"), "https://news.example.test/rss");
  for (const url of [
    "http://127.0.0.1/feed",
    "http://10.0.0.1/feed",
    "http://100.64.0.1/feed",
    "http://169.254.169.254/latest/meta-data",
    "http://192.0.2.1/feed",
    "http://[::1]/feed",
    "http://[fd00::1]/feed",
    "http://[2001:db8::1]/feed",
    "https://desk.internal/feed",
  ]) {
    assert.throws(() => assertSafeFeedUrl(url), /locales, privées ou réservées/);
  }
  assert.equal(
    assertSafeFeedUrl("http://127.0.0.1/feed", { allowPrivateNetwork: true }),
    "http://127.0.0.1/feed",
  );
  assert.equal(feedUrlsShareSite("https://example.test", "https://feeds.example.test/rss"), true);
  assert.equal(feedUrlsShareSite("https://example.test", "https://unrelated.test/rss"), false);
  assert.throws(
    () =>
      assertSafeFeedUrl("https://unrelated.test/rss", {
        expectedSiteUrl: "https://example.test",
      }),
    /autre domaine/,
  );
});

test("classifies reserved IPv6 forms for every protected network boundary", () => {
  for (const address of ["::", "::1", "::ffff:127.0.0.1", "ff02::1", "2001:db8::1"]) {
    assert.equal(isNonPublicIpAddress(address), true, address);
  }
  assert.equal(isNonPublicIpAddress("2606:4700:4700::1111"), false);
});

test("stops reading a streamed response as soon as its byte limit is exceeded", async () => {
  let cancelled = false;
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(encoder.encode("abcd"));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    readResponseTextWithLimit(new Response(body), { maxBytes: 6 }),
    /trop volumineux/,
  );
  assert.equal(cancelled, true);
});

test("canonical URLs remove fragments and marketing parameters", () => {
  assert.equal(
    canonicalizeUrl("/story?utm_source=x&z=2&a=1#comments", "https://example.test/news"),
    "https://example.test/story?a=1&z=2",
  );
});

test("parses RSS and deduplicates equivalent article links", () => {
  const parsed = parseFeedDocument(RSS_FIXTURE, "https://example.test/feed.xml");
  assert.equal(parsed.kind, "rss");
  assert.equal(parsed.title, "Le fil de test");
  assert.equal(parsed.items.length, 1);
  assert.deepEqual(parsed.items[0], {
    canonicalUrl: "https://example.test/articles/1?a=1&b=2",
    title: "Premier sujet",
    summary: "Une courte description.",
    imageUrl: "https://example.test/image.jpg",
    publishedAt: "2026-07-09T10:30:00.000Z",
    updatedAt: null,
  });
});

test("parses Atom links, summaries and dates", () => {
  const parsed = parseFeedDocument(ATOM_FIXTURE, "https://example.test/feed.atom");
  assert.equal(parsed.kind, "atom");
  assert.equal(parsed.title, "Fil Atom");
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].canonicalUrl, "https://example.test/atom/42");
  assert.equal(parsed.items[0].imageUrl, "https://example.test/atom/42.webp");
  assert.equal(parsed.items[0].summary, "Du contenu & des détails");
  assert.equal(parsed.items[0].publishedAt, "2026-07-09T09:12:13.000Z");
});

test("parses Google News sitemap namespaces", () => {
  const parsed = parseFeedDocument(SITEMAP_FIXTURE, "https://journal.test/news.xml");
  assert.equal(parsed.kind, "news-sitemap");
  assert.equal(parsed.title, "Le Journal");
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].title, "Une annonce importante");
  assert.equal(parsed.items[0].canonicalUrl, "https://journal.test/politique/une-annonce.html");
  assert.equal(parsed.items[0].imageUrl, "https://journal.test/photo.jpg");
  assert.equal(parsed.items[0].publishedAt, "2026-07-09T08:58:00.000Z");
});

test("caps raw RSS, Atom and sitemap cardinality before item normalization", () => {
  for (const kind of ["rss", "atom", "news-sitemap"]) {
    const atLimit = parseFeedDocument(
      feedWithRawEntryCount(kind, 2_000),
      "https://example.test/feed.xml",
    );
    assert.equal(atLimit.kind, kind);
    assert.throws(
      () =>
        parseFeedDocument(
          feedWithRawEntryCount(kind, 2_001),
          "https://example.test/feed.xml",
        ),
      /plus de .* entrées/,
    );
  }
});

test("accepts the exact XML node and attribute budgets and rejects the next value", () => {
  const item =
    "<item><title>Au seuil</title><link>https://example.test/threshold</link></item>";
  const atNodeLimit = `<rss><channel>${"<x/>".repeat(49_995)}${item}</channel></rss>`;
  assert.equal(
    parseFeedDocument(atNodeLimit, "https://example.test/feed.xml").items.length,
    1,
  );
  assert.throws(
    () =>
      parseFeedDocument(
        `<rss><channel>${"<x/>".repeat(49_996)}${item}</channel></rss>`,
        "https://example.test/feed.xml",
      ),
    /plus de .* nœuds XML/,
  );

  const attributesAtLimit = Array.from(
    { length: 30_000 },
    (_value, index) => ` a${index}=""`,
  ).join("");
  assert.equal(
    parseFeedDocument(
      `<rss${attributesAtLimit}><channel>${item}</channel></rss>`,
      "https://example.test/feed.xml",
    ).items.length,
    1,
  );
  assert.throws(
    () =>
      parseFeedDocument(
        `<rss${attributesAtLimit} extra=""><channel>${item}</channel></rss>`,
        "https://example.test/feed.xml",
      ),
    /plus de .* attributs XML/,
  );
});

test("charges comments and CDATA to the XML token budget", () => {
  const item =
    "<item><title>Jetons</title><link>https://example.test/tokens</link></item>";
  for (const token of ["<!--x-->", "<![CDATA[x]]>"]) {
    assert.equal(
      parseFeedDocument(
        `<rss><channel>${token.repeat(49_995)}${item}</channel></rss>`,
        "https://example.test/feed.xml",
      ).items.length,
      1,
    );
    assert.throws(
      () =>
        parseFeedDocument(
          `<rss><channel>${token.repeat(49_996)}${item}</channel></rss>`,
          "https://example.test/feed.xml",
        ),
      /plus de .* nœuds XML/,
    );
  }
});

test("accepts one bounded XML declaration and charges it to the token budget", () => {
  const item =
    "<item><title>Déclaration</title><link>https://example.test/declaration</link></item>";
  const declarationBase = '<?xml version="1.0"';
  const declarationSuffix = "?>";
  const declarationAtLimit = `${declarationBase}${" ".repeat(256 - declarationBase.length - declarationSuffix.length)}${declarationSuffix}`;
  assert.equal(declarationAtLimit.length, 256);
  assert.equal(
    parseFeedDocument(
      `${declarationAtLimit}<rss><channel>${"<x/>".repeat(49_994)}${item}</channel></rss>`,
      "https://example.test/feed.xml",
    ).items.length,
    1,
  );
  assert.throws(
    () =>
      parseFeedDocument(
        `${declarationAtLimit}<rss><channel>${"<x/>".repeat(49_995)}${item}</channel></rss>`,
        "https://example.test/feed.xml",
      ),
    /plus de .* nœuds XML/,
  );
  const declarationOverLimit = `${declarationBase}${" ".repeat(257 - declarationBase.length - declarationSuffix.length)}${declarationSuffix}`;
  assert.equal(declarationOverLimit.length, 257);
  assert.throws(
    () =>
      parseFeedDocument(
        `${declarationOverLimit}<rss><channel>${item}</channel></rss>`,
        "https://example.test/feed.xml",
      ),
    /déclaration XML dépasse 256/,
  );
});

test("rejects nonessential and attribute-heavy processing instructions before parsing", () => {
  const ordinaryFeed =
    "<rss><channel><item><title>PI</title><link>https://example.test/pi</link></item></channel></rss>";
  const duplicateAttributes = `<?x ${"a='' ".repeat(25_000)}?>`;
  const uniqueAttributes = `<?x ${Array.from(
    { length: 25_000 },
    (_value, index) => `a${index}=''`,
  ).join(" ")}?>`;
  for (const instruction of [
    "<?xml-stylesheet href='feed.xsl'?>",
    duplicateAttributes,
    uniqueAttributes,
    '<?xml version="1.0" version="1.0"?>',
  ]) {
    assert.throws(
      () =>
        parseFeedDocument(
          `${instruction}${ordinaryFeed}`,
          "https://example.test/feed.xml",
        ),
      /déclaration XML courte|attributs invalides/,
    );
  }
});

test("bounds XML depth while handling the declaration, comments and CDATA", () => {
  const item =
    "<item><title>Profondeur</title><link>https://example.test/depth</link></item>";
  const nested = (count) => `${"<x>".repeat(count)}${"</x>".repeat(count)}`;
  assert.equal(
    parseFeedDocument(
      `<rss><channel>${nested(62)}${item}</channel></rss>`,
      "https://example.test/feed.xml",
    ).items.length,
    1,
  );
  assert.throws(
    () =>
      parseFeedDocument(
        `<rss><channel>${nested(63)}${item}</channel></rss>`,
        "https://example.test/feed.xml",
      ),
    /profondeur XML dépasse 64/,
  );

  const decoys = "<item/><x a='1'/>".repeat(2_100);
  const ignored = `<?xml version="1.0"?>
    <rss><channel>
      <!-- ${decoys} -->
      <description><![CDATA[${decoys}]]></description>
      ${item}
    </channel></rss>`;
  assert.equal(
    parseFeedDocument(ignored, "https://example.test/feed.xml").items.length,
    1,
  );
});

test("rejects DOCTYPE and other XML declarations before parsing", () => {
  const ordinaryFeed =
    "<rss><channel><item><title>Sûr</title><link>https://example.test/safe</link></item></channel></rss>";
  for (const declaration of [
    '<!DOCTYPE rss [<!ENTITY secret SYSTEM "file:///etc/passwd">]>',
    '<!ENTITY secret "value">',
  ]) {
    assert.throws(
      () =>
        parseFeedDocument(
          `${declaration}${ordinaryFeed}`,
          "https://example.test/feed.xml",
        ),
      /déclarations XML DOCTYPE, ENTITY/,
    );
  }
});

test("drops oversized article and image URLs and rejects an oversized source URL", async () => {
  const urlPrefix = "https://example.test/";
  const urlAtLimit = `${urlPrefix}${"x".repeat(4_096 - urlPrefix.length)}`;
  const oversizedUrl = `${urlAtLimit}x`;
  assert.equal(urlAtLimit.length, 4_096);
  assert.equal(normalizeInputUrl(urlAtLimit), urlAtLimit);
  assert.equal(canonicalizeUrl(urlAtLimit), urlAtLimit);
  assert.equal(canonicalizeUrl(oversizedUrl), null);
  assert.throws(() => normalizeInputUrl(oversizedUrl), /dépasse .* caractères/);

  const parsed = parseFeedDocument(
    `<rss><channel>
      <item>
        <title>Article conservé</title>
        <link>https://example.test/kept</link>
        <enclosure type="image/jpeg" url="${oversizedUrl}" />
      </item>
      <item><title>Article ignoré</title><link>${oversizedUrl}</link></item>
    </channel></rss>`,
    "https://example.test/feed.xml",
  );
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].canonicalUrl, "https://example.test/kept");
  assert.equal(parsed.items[0].imageUrl, null);

  let fetchCount = 0;
  const engine = createFeedEngine({
    fetchImpl: async () => {
      fetchCount += 1;
      return response(RSS_FIXTURE);
    },
  });
  try {
    const panelId = (await createFeedPanel(engine)).id;
    await assert.rejects(engine.addSource(panelId, oversizedUrl), /dépasse .* caractères/);
    assert.equal(fetchCount, 0);
  } finally {
    engine.close();
  }
});

test("bounds rich CDATA before Cheerio while preserving normal summaries", () => {
  const domBomb = `Début ${"<i>x</i>".repeat(100_000)}`;
  const parsed = parseFeedDocument(
    `<rss><channel><item>
      <title>Article borné</title>
      <link>https://example.test/bounded-summary</link>
      <description><![CDATA[${domBomb}]]></description>
    </item></channel></rss>`,
    "https://example.test/feed.xml",
  );
  assert.equal(parsed.items.length, 1);
  assert.match(parsed.items[0].summary, /^Début x/);
  assert.ok(parsed.items[0].summary.length <= 700);

  const normal = parseFeedDocument(RSS_FIXTURE, "https://example.test/feed.xml");
  assert.equal(normal.items[0].summary, "Une courte description.");
});

test("surfaces the feed cardinality error when adding an oversized direct feed", async () => {
  const engine = createFeedEngine({
    fetchImpl: async () =>
      response(feedWithRawEntryCount("rss", 2_001), {
        headers: { "content-type": "application/rss+xml" },
      }),
  });
  try {
    const panelId = (await createFeedPanel(engine)).id;
    await assert.rejects(
      engine.addSource(panelId, "https://example.test/oversized.xml"),
      /plus de .* entrées/,
    );
  } finally {
    engine.close();
  }
});

test("enriches missing metadata by canonical URL without changing RSS title or order", () => {
  const rss = parseFeedDocument(
    LE_PARISIEN_RSS_FIXTURE,
    "https://feeds.leparisien.fr/leparisien/rss",
  );
  const sitemap = parseFeedDocument(
    LE_PARISIEN_SITEMAP_FIXTURE,
    "https://www.leparisien.fr/sitemapnews.xml",
  );
  const enriched = enrichItemsFromNewsSitemap(rss.items, sitemap.items);

  assert.deepEqual(enriched.map(({ title }) => title), ["Titre RSS A", "Titre RSS B"]);
  assert.equal(enriched[0].publishedAt, "2026-07-09T09:30:00.000Z");
  assert.equal(enriched[0].updatedAt, "2026-07-09T09:35:00.000Z");
  assert.equal(enriched[0].imageUrl, "https://www.leparisien.fr/photo-a.jpg");
  assert.equal(enriched[1].publishedAt, "2026-07-09T09:49:00.000Z");
});

test("discovers absolute and relative RSS/Atom declarations in HTML", () => {
  const candidates = discoverFeedsInHtml(
    `<html><head>
      <link rel="alternate stylesheet" type="application/rss+xml" href="/rss.xml" title="RSS principal">
      <link rel="alternate" type="application/atom+xml" href="https://feeds.test/atom">
      <link rel="stylesheet" href="/not-a-feed.xml">
    </head></html>`,
    "https://example.test/news/",
  );
  assert.deepEqual(candidates, [
    { url: "https://example.test/rss.xml", expectedKind: "rss", title: "RSS principal" },
    { url: "https://feeds.test/atom", expectedKind: "atom", title: null },
  ]);
});

test("bounds HTML discovery before Cheerio and ignores raw-content decoys", () => {
  const decoys = "<x fake='1'>".repeat(4_100);
  const safePage = `<html><head>
    <script></scripture>${decoys}</script>
    <style></stylesheet>${decoys}</style>
    <!-- ${decoys} -->
    <link rel="alternate" type="application/rss+xml" href="/rss.xml">
  </head><body>${"<article/>".repeat(10_000)}</body></html>`;
  assert.deepEqual(discoverFeedsInHtml(safePage, "https://example.test/"), [
    {
      url: "https://example.test/rss.xml",
      expectedKind: "rss",
      title: null,
    },
  ]);

  assert.throws(
    () =>
      discoverFeedsInHtml(
        `<html><head>${"<meta>".repeat(4_000)}<link rel="alternate" type="application/rss+xml" href="/rss.xml"></head></html>`,
        "https://example.test/",
      ),
    /plus de .* éléments HTML/,
  );

  const excessiveAttributes = Array.from(
    { length: 12_001 },
    (_value, index) => ` a${index}`,
  ).join("");
  assert.throws(
    () =>
      discoverFeedsInHtml(
        `<html><head><meta${excessiveAttributes}></head></html>`,
        "https://example.test/",
      ),
    /plus de .* attributs HTML/,
  );
  assert.throws(
    () =>
      discoverFeedsInHtml(
        `<html><head>${"x".repeat(256 * 1_024)}</head></html>`,
        "https://example.test/",
      ),
    /portion utile.*262.*144 caractères/,
  );
});

test("adds an ordinary website through RSS auto-discovery and reuses its source", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === "https://example.test/") {
      return response(
        '<!doctype html><html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head></html>',
        { headers: { "content-type": "text/html", "cache-control": "max-age=300" } },
      );
    }
    if (url === "https://example.test/feed.xml") {
      return response(RSS_FIXTURE, {
        headers: { "content-type": "application/rss+xml", "cache-control": "max-age=300" },
      });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const engine = createFeedEngine({
    fetchImpl,
    now: () => new Date("2026-07-09T12:00:00.000Z"),
  });
  try {
    const firstPanel = await createFeedPanel(engine);
    const added = await engine.addSource(firstPanel.id, "example.test");
    assert.equal(added.state.sources.length, 1);
    assert.equal(added.state.sources[0].feedUrl, "https://example.test/feed.xml");
    assert.equal(added.state.sources[0].status, "healthy");
    assert.equal(added.state.items.length, 1);
    assert.equal(added.state.items[0].firstSeenAt, "2026-07-09T12:00:00.000Z");

    const afterCreate = await engine.createPanel("Économie");
    const secondPanel = afterCreate.panels.find(({ name }) => name === "Économie");
    const secondAdd = await engine.addSource(secondPanel.id, "https://example.test/feed.xml");
    assert.equal(secondAdd.state.sources.length, 1);
    assert.deepEqual(secondAdd.state.panels[1].sourceIds, [added.sourceId]);
    assert.deepEqual(calls, ["https://example.test/", "https://example.test/feed.xml"]);
  } finally {
    engine.close();
  }
});

test("enriches Le Parisien on add and refresh while reusing the sitemap cache", async () => {
  const feedUrl = "https://feeds.leparisien.fr/leparisien/rss";
  const sitemapUrl =
    "https://www.leparisien.fr/arc/outboundfeeds/sitemapnews/?outputType=xml&from=0";
  const calls = [];
  const engine = createFeedEngine({
    fetchImpl: async (url) => {
      calls.push(url);
      if (url === feedUrl) {
        return response(LE_PARISIEN_RSS_FIXTURE, {
          headers: { "content-type": "application/rss+xml", "cache-control": "no-cache" },
        });
      }
      if (url === sitemapUrl) {
        return response(LE_PARISIEN_SITEMAP_FIXTURE, {
          headers: { "content-type": "application/xml", "cache-control": "max-age=120" },
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    },
    now: () => new Date("2026-07-09T12:00:00.000Z"),
  });
  try {
    const panelId = (await createFeedPanel(engine)).id;
    const added = await engine.addSource(panelId, "https://www.leparisien.fr/");
    const byTitle = new Map(added.state.items.map((item) => [item.title, item]));
    assert.equal(added.state.sources[0].status, "healthy");
    assert.equal(byTitle.get("Titre RSS A").publishedAt, "2026-07-09T09:30:00.000Z");
    assert.equal(byTitle.get("Titre RSS A").imageUrl, "https://www.leparisien.fr/photo-a.jpg");
    assert.equal(byTitle.has("Titre sitemap à ne pas utiliser A"), false);

    const refreshed = await engine.refreshSource(added.sourceId);
    assert.equal(refreshed.sources[0].status, "healthy");
    assert.equal(calls.filter((url) => url === feedUrl).length, 2);
    assert.equal(calls.filter((url) => url === sitemapUrl).length, 1);
  } finally {
    engine.close();
  }
});

test("keeps Le Parisien healthy when optional sitemap enrichment fails", async () => {
  const feedUrl = "https://feeds.leparisien.fr/leparisien/rss";
  const sitemapUrl =
    "https://www.leparisien.fr/arc/outboundfeeds/sitemapnews/?outputType=xml&from=0";
  const engine = createFeedEngine({
    fetchImpl: async (url) => {
      if (url === feedUrl) return response(LE_PARISIEN_RSS_FIXTURE);
      if (url === sitemapUrl) return response("indisponible", { status: 503 });
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  try {
    const panelId = (await createFeedPanel(engine)).id;
    const result = await engine.addSource(panelId, "leparisien.fr");
    assert.equal(result.state.sources[0].status, "healthy");
    assert.equal(result.state.items.length, 2);
    assert.equal(result.state.items.every((item) => item.publishedAt === null), true);
  } finally {
    engine.close();
  }
});

test("uses ETag validators and cached body after HTTP 304", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, headers: options.headers });
    if (requests.length === 1) {
      return response(RSS_FIXTURE, {
        headers: {
          "content-type": "application/rss+xml",
          "cache-control": "no-cache",
          etag: '"feed-v1"',
        },
      });
    }
    assert.equal(options.headers["If-None-Match"], '"feed-v1"');
    return response(null, { status: 304, headers: { "cache-control": "max-age=120" } });
  };
  const engine = createFeedEngine({
    fetchImpl,
    now: () => new Date("2026-07-09T12:00:00.000Z"),
  });
  try {
    const panelId = (await createFeedPanel(engine)).id;
    const added = await engine.addSource(panelId, "https://source.test/feed.xml");
    const refreshed = await engine.refreshSource(added.sourceId);
    assert.equal(requests.length, 2);
    assert.equal(refreshed.sources[0].status, "healthy");
    assert.equal(refreshed.items.length, 1);
  } finally {
    engine.close();
  }
});

test("uses the final redirected URL to resolve relative feed declarations", async () => {
  const calls = [];
  const engine = createFeedEngine({
    fetchImpl: async (url) => {
      calls.push(url);
      if (url === "https://old.test/") {
        return response("", {
          status: 302,
          headers: { location: "https://news.old.test/news/index.html" },
        });
      }
      if (url === "https://news.old.test/news/index.html") {
        return response(
          '<html><head><link rel="alternate" type="application/rss+xml" href="../rss.xml"></head></html>',
          { headers: { "content-type": "text/html" } },
        );
      }
      if (url === "https://news.old.test/rss.xml") {
        return response("", {
          status: 302,
          headers: { location: "https://cdn.old.test/current/feed.xml" },
        });
      }
      if (url === "https://cdn.old.test/current/feed.xml") {
        return response(RSS_FIXTURE, {
          headers: { "content-type": "application/rss+xml" },
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  try {
    const panelId = (await createFeedPanel(engine)).id;
    const result = await engine.addSource(panelId, "https://old.test");
    assert.deepEqual(calls, [
      "https://old.test/",
      "https://news.old.test/news/index.html",
      "https://news.old.test/rss.xml",
      "https://cdn.old.test/current/feed.xml",
    ]);
    assert.equal(result.state.sources[0].feedUrl, "https://news.old.test/rss.xml");
  } finally {
    engine.close();
  }
});

test("refuses a redirect to a private destination before issuing the second request", async () => {
  const calls = [];
  const engine = createFeedEngine({
    fetchImpl: async (url) => {
      calls.push(url);
      return response("", {
        status: 302,
        headers: { location: "http://127.0.0.1/private-feed.xml" },
      });
    },
  });
  try {
    await assert.rejects(
      engine.fetchEndpoint("https://example.test/feed.xml"),
      /locales, privées ou réservées/,
    );
    assert.deepEqual(calls, ["https://example.test/feed.xml"]);
  } finally {
    engine.close();
  }
});

test("fails closed when production host resolution is unavailable", () => {
  assert.throws(
    () => createFeedEngine({ requireHostResolution: true }),
    /obligatoire en production/,
  );
  assert.throws(
    () =>
      createFeedEngine({
        resolveHost: async () => ({ endpoints: [{ address: "93.184.216.34" }] }),
        requireProxyResolution: true,
      }),
    /proxy.*obligatoire en production/i,
  );
});

test("allows a custom source only when every proxy candidate is DIRECT", async () => {
  const proxyCalls = [];
  const fetchCalls = [];
  const engine = createFeedEngine({
    requireHostResolution: true,
    requireProxyResolution: true,
    resolveProxy: async (url) => {
      proxyCalls.push(url);
      return "DIRECT; DIRECT";
    },
    resolveHost: async () => ({
      endpoints: [{ address: "93.184.216.34", family: "ipv4" }],
    }),
    fetchImpl: async (url) => {
      fetchCalls.push(url);
      return response(RSS_FIXTURE);
    },
  });
  try {
    await engine.fetchEndpoint("https://custom.example.test/feed.xml");
    assert.deepEqual(proxyCalls, ["https://custom.example.test/feed.xml"]);
    assert.deepEqual(fetchCalls, ["https://custom.example.test/feed.xml"]);
  } finally {
    engine.close();
  }
});

test("blocks custom PROXY and PROXY-then-DIRECT routes before DNS or fetch", async () => {
  for (const route of ["PROXY proxy.corp:8080", "PROXY proxy.corp:8080; DIRECT"]) {
    let hostResolutionCount = 0;
    let fetchCount = 0;
    const engine = createFeedEngine({
      requireHostResolution: true,
      requireProxyResolution: true,
      resolveProxy: async () => route,
      resolveHost: async () => {
        hostResolutionCount += 1;
        return { endpoints: [{ address: "93.184.216.34", family: "ipv4" }] };
      },
      fetchImpl: async () => {
        fetchCount += 1;
        return response(RSS_FIXTURE);
      },
    });
    try {
      await assert.rejects(
        engine.fetchEndpoint("https://custom.example.test/feed.xml"),
        /source personnalisée nécessite un proxy/,
      );
      assert.equal(hostResolutionCount, 0);
      assert.equal(fetchCount, 0);
    } finally {
      engine.close();
    }
  }
});

test("allows a curated catalog connector and its same-site redirect through a proxy", async () => {
  const proxyCalls = [];
  const fetchCalls = [];
  const engine = createFeedEngine({
    requireHostResolution: true,
    requireProxyResolution: true,
    resolveProxy: async (url) => {
      proxyCalls.push(url);
      return "PROXY proxy.corp:8080";
    },
    resolveHost: async () => ({
      endpoints: [{ address: "151.101.1.164", family: "ipv4" }],
    }),
    fetchImpl: async (url) => {
      fetchCalls.push(url);
      if (url === "https://www.lemonde.fr/rss/en_continu.xml") {
        return response("", {
          status: 302,
          headers: { location: "https://feeds.lemonde.fr/rss/en_continu.xml" },
        });
      }
      return response(RSS_FIXTURE);
    },
  });
  try {
    const panelId = (await createFeedPanel(engine)).id;
    const added = await engine.addCatalogSource(panelId, "le-monde");
    assert.equal(added.state.sources[0].connectorId, "le-monde");
    assert.deepEqual(proxyCalls, [
      "https://www.lemonde.fr/rss/en_continu.xml",
      "https://feeds.lemonde.fr/rss/en_continu.xml",
    ]);
    assert.deepEqual(fetchCalls, proxyCalls);
  } finally {
    engine.close();
  }
});

test("uses source-specific catalog refresh defaults while accepting an explicit override", async () => {
  const engine = createFeedEngine({
    fetchImpl: async () => response(RSS_FIXTURE),
  });
  try {
    const state = await engine.createPanel({
      kind: "feed",
      name: "Catalogue rapide",
      defaultRefreshIntervalSeconds: 300,
    });
    const panelId = state.panels.find(({ kind }) => kind === "feed").id;

    let result = await engine.addCatalogSource(panelId, "le-monde");
    assert.equal(
      result.state.sources.find(({ connectorId }) => connectorId === "le-monde")
        .refreshIntervalSeconds,
      60,
    );

    result = await engine.addCatalogSource(panelId, "bbc", {
      refreshIntervalSeconds: 120,
    });
    assert.equal(
      result.state.sources.find(({ connectorId }) => connectorId === "bbc")
        .refreshIntervalSeconds,
      120,
    );

    result = await engine.addCatalogSource(panelId, "cert-fr");
    assert.equal(
      result.state.sources.find(({ connectorId }) => connectorId === "cert-fr")
        .refreshIntervalSeconds,
      300,
    );
  } finally {
    engine.close();
  }
});

test("creates a sourced feed atomically while preserving catalog refresh defaults", async () => {
  const engine = createFeedEngine({ fetchImpl: async () => response(RSS_FIXTURE) });
  try {
    const state = await engine.createFeedPanelWithSources(
      { kind: "feed", name: "Desk" },
      null,
      {
        name: "Desk",
        defaultRefreshIntervalSeconds: 60,
        keptSourceIds: [],
        selectedCatalogIds: ["le-monde", "cert-fr"],
        customSources: [],
      },
    );
    const panel = state.panels.find(({ name }) => name === "Desk");
    assert.ok(panel);
    assert.equal(panel.sourceIds.length, 2);
    assert.equal(
      state.sources.find(({ connectorId }) => connectorId === "le-monde").refreshIntervalSeconds,
      60,
    );
    assert.equal(
      state.sources.find(({ connectorId }) => connectorId === "cert-fr").refreshIntervalSeconds,
      300,
    );
  } finally {
    engine.close();
  }
});

test("preserves catalog selection order when parallel feeds finish out of order", async () => {
  const pendingFetches = new Map();
  const bothFetchesStarted = Promise.withResolvers();
  const engine = createFeedEngine({
    fetchImpl: async (url) => new Promise((resolve) => {
      pendingFetches.set(String(url), resolve);
      if (pendingFetches.size === 2) bothFetchesStarted.resolve();
    }),
  });
  try {
    const initial = await engine.createPanel({ kind: "feed", name: "Ordonné" });
    const panel = initial.panels[0];
    const saving = engine.saveFeedPanelConfiguration(
      panel.id,
      {
        name: panel.name,
        defaultRefreshIntervalSeconds: panel.defaultRefreshIntervalSeconds,
        keptSourceIds: [],
        selectedCatalogIds: ["le-monde", "cert-fr"],
        customSources: [],
      },
    );

    await bothFetchesStarted.promise;
    pendingFetches.get("https://www.cert.ssi.gouv.fr/feed/")(
      response(RSS_FIXTURE),
    );
    await new Promise((resolve) => setImmediate(resolve));
    pendingFetches.get("https://www.lemonde.fr/rss/en_continu.xml")(
      response(RSS_FIXTURE),
    );
    const saved = await saving;
    const connectorBySourceId = new Map(
      saved.sources.map((source) => [source.id, source.connectorId]),
    );
    assert.deepEqual(
      saved.panels[0].sourceIds.map((sourceId) => connectorBySourceId.get(sourceId)),
      ["le-monde", "cert-fr"],
    );
  } finally {
    engine.close();
  }
});

test("removes a new feed and restores shared source fields when one source fails", async () => {
  const engine = createFeedEngine({
    fetchImpl: async (url) => {
      if (url === "https://feeds.bbci.co.uk/news/rss.xml") {
        throw new Error("BBC indisponible");
      }
      return response(RSS_FIXTURE);
    },
  });
  try {
    let state = await engine.createPanel({ kind: "feed", name: "Existant" });
    const existingPanel = state.panels[0];
    state = (await engine.addCatalogSource(existingPanel.id, "le-monde", {
      refreshIntervalSeconds: 300,
    })).state;
    const beforeLayout = state.dashboard.layout;

    await assert.rejects(
      engine.createFeedPanelWithSources(
        { kind: "feed", name: "Incomplet" },
        { targetPanelId: existingPanel.id, side: "right" },
        {
          name: "Incomplet",
          defaultRefreshIntervalSeconds: 60,
          keptSourceIds: [],
          selectedCatalogIds: ["le-monde", "bbc"],
          customSources: [],
        },
      ),
      /Aucune modification conservée.*BBC indisponible/,
    );

    state = engine.getRendererState();
    assert.deepEqual(state.panels.map(({ name }) => name), ["Existant"]);
    assert.deepEqual(state.dashboard.layout, beforeLayout);
    assert.equal(
      state.sources.find(({ connectorId }) => connectorId === "le-monde").refreshIntervalSeconds,
      300,
    );
  } finally {
    engine.close();
  }
});

test("cancels an in-flight sourced feed without retaining the panel", async () => {
  const started = Promise.withResolvers();
  const controller = new AbortController();
  const engine = createFeedEngine({
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      started.resolve();
      options.signal.addEventListener("abort", () => {
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    }),
  });
  try {
    const creating = engine.createFeedPanelWithSources(
      { kind: "feed", name: "Annulé" },
      null,
      {
        name: "Annulé",
        defaultRefreshIntervalSeconds: 60,
        keptSourceIds: [],
        selectedCatalogIds: ["le-monde"],
        customSources: [],
      },
      { signal: controller.signal },
    );
    await started.promise;
    controller.abort();
    await assert.rejects(creating, /Aucune modification conservée/);
    assert.equal(engine.getRendererState().panels.length, 0);
  } finally {
    engine.close();
  }
});

test("allows exactly the registry HTTPS roots through a proxy", async () => {
  const curatedEndpoints = [...CURATED_PROXY_ROOTS];
  const fetchCalls = [];
  const engine = createFeedEngine({
    requireHostResolution: true,
    requireProxyResolution: true,
    resolveProxy: async () => "PROXY proxy.corp:8080",
    resolveHost: async () => ({
      endpoints: [{ address: "151.101.1.164", family: "ipv4" }],
    }),
    fetchImpl: async (url) => {
      fetchCalls.push(url);
      return response(RSS_FIXTURE, { headers: { "cache-control": "no-store" } });
    },
  });
  try {
    for (const endpoint of curatedEndpoints) await engine.fetchEndpoint(endpoint);
    assert.deepEqual(fetchCalls, curatedEndpoints);
  } finally {
    engine.close();
  }
});

test("blocks publisher-domain lookalikes and HTTP roots through a proxy", async () => {
  const lookalikes = [
    "https://www.lemonde.fr/rss/custom.xml",
    "https://www.lemonde.fr/rss/en_continu.xml?custom=1",
    "http://www.lemonde.fr/rss/en_continu.xml",
    "https://feeds.lefigaro.fr/rss/figaro_flash-actu.xml",
  ];
  let hostResolutionCount = 0;
  let fetchCount = 0;
  const engine = createFeedEngine({
    requireHostResolution: true,
    requireProxyResolution: true,
    resolveProxy: async () => "PROXY proxy.corp:8080",
    resolveHost: async () => {
      hostResolutionCount += 1;
      return { endpoints: [{ address: "151.101.1.164", family: "ipv4" }] };
    },
    fetchImpl: async () => {
      fetchCount += 1;
      return response(RSS_FIXTURE);
    },
  });
  try {
    for (const url of lookalikes) {
      await assert.rejects(
        engine.fetchEndpoint(url),
        /source personnalisée nécessite un proxy/,
      );
    }
    assert.equal(hostResolutionCount, 0);
    assert.equal(fetchCount, 0);
  } finally {
    engine.close();
  }
});

test("blocks an HTTP downgrade before a curated proxy redirect is fetched", async () => {
  const root = "https://www.lemonde.fr/rss/en_continu.xml";
  const fetchCalls = [];
  const hostCalls = [];
  const engine = createFeedEngine({
    requireHostResolution: true,
    requireProxyResolution: true,
    resolveProxy: async () => "PROXY proxy.corp:8080",
    resolveHost: async (hostname) => {
      hostCalls.push(hostname);
      return { endpoints: [{ address: "151.101.1.164", family: "ipv4" }] };
    },
    fetchImpl: async (url) => {
      fetchCalls.push(url);
      return response("", {
        status: 302,
        headers: { location: "http://feeds.lemonde.fr/rss/en_continu.xml" },
      });
    },
  });
  try {
    await assert.rejects(engine.fetchEndpoint(root), /source personnalisée nécessite un proxy/);
    assert.deepEqual(fetchCalls, [root]);
    assert.deepEqual(hostCalls, ["www.lemonde.fr"]);
  } finally {
    engine.close();
  }
});

test("fails closed on proxy resolution errors and unknown routes, even for curated domains", async () => {
  const resolvers = [
    async () => {
      throw new Error("PAC indisponible");
    },
    async () => "UNKNOWN tunnel.corp:8080",
  ];
  for (const resolveProxy of resolvers) {
    let fetchCount = 0;
    const engine = createFeedEngine({
      requireHostResolution: true,
      requireProxyResolution: true,
      resolveProxy,
      resolveHost: async () => ({
        endpoints: [{ address: "151.101.1.164", family: "ipv4" }],
      }),
      fetchImpl: async () => {
        fetchCount += 1;
        return response(RSS_FIXTURE);
      },
    });
    try {
      await assert.rejects(
        engine.fetchEndpoint("https://www.lemonde.fr/rss/en_continu.xml"),
        /proxy.*(?:vérifiée|reconnue)/,
      );
      assert.equal(fetchCount, 0);
    } finally {
      engine.close();
    }
  }
});

test("rejects public hostnames resolving to private IPv4 or IPv6 before fetch", async () => {
  for (const address of ["10.20.30.40", "fd12:3456:789a::1"]) {
    let fetchCount = 0;
    const resolutionCalls = [];
    const engine = createFeedEngine({
      requireHostResolution: true,
      requireProxyResolution: true,
      resolveProxy: async () => "DIRECT",
      resolveHost: async (hostname, options) => {
        resolutionCalls.push({ hostname, options });
        return { endpoints: [{ address, family: address.includes(":") ? "ipv6" : "ipv4" }] };
      },
      fetchImpl: async () => {
        fetchCount += 1;
        return response(RSS_FIXTURE);
      },
    });
    try {
      await assert.rejects(
        engine.fetchEndpoint("https://public.example.test/feed.xml"),
        /résout vers une adresse locale, privée ou réservée/,
      );
      assert.equal(fetchCount, 0);
      assert.deepEqual(resolutionCalls, [
        {
          hostname: "public.example.test",
          options: {
            cacheUsage: "allowed",
            source: "any",
            secureDnsPolicy: "allow",
          },
        },
      ]);
    } finally {
      engine.close();
    }
  }
});

test("resolves a redirect destination and blocks it before the second fetch", async () => {
  const fetchCalls = [];
  const resolutionCalls = [];
  const engine = createFeedEngine({
    requireHostResolution: true,
    requireProxyResolution: true,
    resolveProxy: async () => "DIRECT",
    resolveHost: async (hostname) => {
      resolutionCalls.push(hostname);
      return {
        endpoints: [
          {
            address: hostname === "rss.example.test" ? "192.168.50.10" : "93.184.216.34",
            family: "ipv4",
          },
        ],
      };
    },
    fetchImpl: async (url) => {
      fetchCalls.push(url);
      return response("", {
        status: 302,
        headers: { location: "https://rss.example.test/private.xml" },
      });
    },
  });
  try {
    await assert.rejects(
      engine.fetchEndpoint("https://example.test/feed.xml"),
      /résout vers une adresse locale, privée ou réservée/,
    );
    assert.deepEqual(resolutionCalls, ["example.test", "rss.example.test"]);
    assert.deepEqual(fetchCalls, ["https://example.test/feed.xml"]);
  } finally {
    engine.close();
  }
});

test("honours Cache-Control no-store", async () => {
  let fetchCount = 0;
  const engine = createFeedEngine({
    fetchImpl: async () => {
      fetchCount += 1;
      return response(RSS_FIXTURE, { headers: { "cache-control": "no-store" } });
    },
  });
  try {
    await engine.fetchEndpoint("https://private.test/feed.xml");
    await engine.fetchEndpoint("https://private.test/feed.xml");
    assert.equal(fetchCount, 2);
  } finally {
    engine.close();
  }
});

test("coalesces concurrent reads of the same endpoint", async () => {
  let fetchCount = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const fetchImpl = async () => {
    fetchCount += 1;
    await gate;
    return response(RSS_FIXTURE, { headers: { "content-type": "application/rss+xml" } });
  };
  const engine = createFeedEngine({ fetchImpl });
  try {
    const first = engine.fetchEndpoint("https://example.test/feed.xml");
    const second = engine.fetchEndpoint("https://example.test/feed.xml");
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(fetchCount, 1);
    assert.equal(firstResult.body, secondResult.body);
  } finally {
    engine.close();
  }
});

test("cancelling one coalesced subscriber preserves the shared download", async () => {
  let fetchCount = 0;
  let networkAbortCount = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const engine = createFeedEngine({
    fetchImpl: async (_url, options) => {
      fetchCount += 1;
      options.signal.addEventListener("abort", () => {
        networkAbortCount += 1;
      }, { once: true });
      await gate;
      return response(RSS_FIXTURE, {
        headers: { "content-type": "application/rss+xml" },
      });
    },
  });
  const controller = new AbortController();
  try {
    const cancelled = engine.fetchEndpoint("https://shared-probe.test/feed.xml", {
      signal: controller.signal,
    });
    const retained = engine.fetchEndpoint("https://shared-probe.test/feed.xml");
    controller.abort();

    await assert.rejects(cancelled, /Téléchargement interrompu/);
    assert.equal(networkAbortCount, 0);
    release();
    const result = await retained;
    assert.equal(fetchCount, 1);
    assert.equal(networkAbortCount, 0);
    assert.match(result.body, /Le fil de test/);
  } finally {
    release?.();
    engine.close();
  }
});

test("starts a fresh download after the final subscriber cancels", async () => {
  let fetchCount = 0;
  let resolveFirstStarted;
  const firstStarted = new Promise((resolve) => {
    resolveFirstStarted = resolve;
  });
  const engine = createFeedEngine({
    fetchImpl: async (_url, options) => {
      fetchCount += 1;
      if (fetchCount > 1) {
        return response(RSS_FIXTURE, {
          headers: { "content-type": "application/rss+xml" },
        });
      }
      resolveFirstStarted();
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    },
  });
  const controller = new AbortController();
  try {
    const first = engine.fetchEndpoint("https://restart-probe.test/feed.xml", {
      signal: controller.signal,
    });
    await firstStarted;
    controller.abort();
    await assert.rejects(first, /Téléchargement interrompu/);

    const second = await engine.fetchEndpoint("https://restart-probe.test/feed.xml");
    assert.equal(fetchCount, 2);
    assert.match(second.body, /Le fil de test/);
  } finally {
    engine.close();
  }
});

test("limits an imported burst of 256 sources to six globally and two per hostname", async () => {
  const controlled = controlledRefreshFetch();
  const engine = createFeedEngine({ fetchImpl: controlled.fetchImpl });
  const feedUrls = Array.from(
    { length: 256 },
    (_, index) => `https://host-${Math.floor(index / 32)}.test/feed-${index}.xml`,
  );
  try {
    await importRefreshSources(engine, feedUrls);
    const refresh = engine.refreshAll();
    await waitForCondition(
      () => controlled.stats().started === 6,
      "six rafraîchissements initiaux",
    );
    assert.equal(controlled.stats().active, 6);
    assert.equal(controlled.stats().maxGlobal, 6);
    for (const maximum of controlled.stats().maxByHost.values()) {
      assert.ok(maximum <= 2, `Un hôte a reçu ${maximum} rafraîchissements simultanés.`);
    }

    while (controlled.stats().completed < feedUrls.length) {
      const startedBeforeRelease = controlled.stats().started;
      assert.ok(controlled.releasePending() > 0);
      if (controlled.stats().completed < feedUrls.length) {
        await waitForCondition(
          () => controlled.stats().started > startedBeforeRelease,
          "démarrage de la vague suivante",
        );
      }
    }
    const state = await refresh;
    assert.equal(controlled.stats().started, feedUrls.length);
    assert.equal(controlled.stats().maxGlobal, 6);
    assert.equal(state.sources.every(({ status }) => status === "healthy"), true);
  } finally {
    controlled.releasePending();
    engine.close();
  }
});

test("coalesces concurrent source refreshes including a manual force and refreshAll", async () => {
  const controlled = controlledRefreshFetch();
  const engine = createFeedEngine({ fetchImpl: controlled.fetchImpl });
  try {
    const [sourceId] = await importRefreshSources(engine, [
      "https://coalesce-a.test/feed.xml",
      "https://coalesce-b.test/feed.xml",
    ]);
    const first = engine.refreshSource(sourceId);
    const forced = engine.refreshSource(sourceId, { force: true });
    assert.strictEqual(forced, first);
    const all = engine.refreshAll();
    await waitForCondition(() => controlled.stats().started === 2, "requêtes mutualisées");
    controlled.releasePending();
    const [state] = await Promise.all([first, forced, all]);

    assert.equal(controlled.stats().started, 2);
    assert.equal(state.sources[0].status, "healthy");
    assert.equal(new Set(state.items.map(({ arrivalBatchAt }) => arrivalBatchAt)).size, 1);
    assert.equal(
      engine.database
        .listPilotEvents({ limit: 100 })
        .filter(({ type }) => type === "source_refresh_succeeded").length,
      2,
    );
  } finally {
    controlled.releasePending();
    engine.close();
  }
});

test("rejects an overlapping panel refresh before starting idle sibling sources", async () => {
  const controlled = controlledRefreshFetch();
  const engine = createFeedEngine({ fetchImpl: controlled.fetchImpl });
  try {
    const [activeSourceId] = await importRefreshSources(engine, [
      "https://overlap-a.test/feed.xml",
      "https://overlap-b.test/feed.xml",
    ]);
    const activeRefresh = engine.refreshSource(activeSourceId);
    await waitForCondition(() => controlled.stats().started === 1, "source active");

    await assert.rejects(
      engine.refreshPanel("refresh-queue-panel", { force: true }),
      /actualisation de ce panel est déjà en cours/,
    );
    assert.equal(controlled.stats().started, 1);

    controlled.releasePending();
    await activeRefresh;
  } finally {
    controlled.releasePending();
    engine.close();
  }
});

test("cancelPending rejects queued refreshes while active sources restore their state", async () => {
  const controlled = controlledRefreshFetch();
  const engine = createFeedEngine({ fetchImpl: controlled.fetchImpl });
  try {
    const sourceIds = await importRefreshSources(
      engine,
      Array.from({ length: 4 }, (_, index) => `https://cancel.test/feed-${index}.xml`),
    );
    const tasks = sourceIds.map((sourceId) => engine.refreshSource(sourceId));
    const settled = Promise.allSettled(tasks);
    await waitForCondition(() => controlled.stats().started === 2, "plafond par hôte");
    engine.cancelPending();
    const results = await settled;

    assert.deepEqual(results.map(({ status }) => status), [
      "fulfilled",
      "fulfilled",
      "rejected",
      "rejected",
    ]);
    for (const result of results.slice(2)) {
      assert.equal(result.reason?.name, "RefreshCancelledError");
    }
    assert.equal(engine.getState().sources.every(({ status }) => status === "idle"), true);
    assert.equal(controlled.stats().started, 2);
  } finally {
    controlled.releasePending();
    engine.close();
  }
});

test("close rejects active and queued refreshes without touching closed SQLite", async () => {
  const controlled = controlledRefreshFetch();
  const engine = createFeedEngine({ fetchImpl: controlled.fetchImpl });
  const sourceIds = await importRefreshSources(
    engine,
    Array.from({ length: 4 }, (_, index) => `https://close.test/feed-${index}.xml`),
  );
  const tasks = sourceIds.map((sourceId) => engine.refreshSource(sourceId));
  const settled = Promise.allSettled(tasks);
  await waitForCondition(() => controlled.stats().started === 2, "rafraîchissements actifs");
  engine.close();
  const results = await settled;

  assert.equal(results.every(({ status }) => status === "rejected"), true);
  for (const result of results) {
    assert.equal(result.reason?.name, "RefreshCancelledError");
    assert.doesNotMatch(String(result.reason?.message), /database|sqlite/i);
  }
  assert.equal(controlled.stats().started, 2);
  assert.equal(controlled.stats().completed, 2);
  engine.close();
});

test("keeps cached articles visible when a later request fails", async () => {
  let online = true;
  const fetchImpl = async () => {
    if (!online) throw new Error("offline");
    return response(RSS_FIXTURE, {
      headers: { "content-type": "application/rss+xml", "cache-control": "no-cache" },
    });
  };
  const engine = createFeedEngine({ fetchImpl });
  try {
    const panelId = (await createFeedPanel(engine)).id;
    const { sourceId } = await engine.addSource(panelId, "https://source.test/feed.xml");
    online = false;
    const state = await engine.refreshSource(sourceId);
    assert.equal(state.sources[0].status, "error");
    assert.match(state.sources[0].errorMessage, /offline/);
    assert.equal(state.items.length, 1);
  } finally {
    engine.close();
  }
});

test("returns a connector-friendly error for a webpage without a declared feed", async () => {
  const engine = createFeedEngine({
    fetchImpl: async () => response("<html><head><title>Sans RSS</title></head></html>"),
  });
  try {
    const panelId = (await createFeedPanel(engine)).id;
    await assert.rejects(
      engine.addSource(panelId, "https://no-feed.test"),
      /connecteur dédié/,
    );
    assert.equal(engine.getState().sources.length, 0);
  } finally {
    engine.close();
  }
});

test("limits HTML discovery early and deduplicates candidates in preference order", () => {
  const links = Array.from(
    { length: 20 },
    (_, index) =>
      `<link rel="alternate" type="application/rss+xml" href="/feed-${index}.xml">`,
  ).join("");
  const candidates = discoverFeedsInHtml(
    `<html><head>${links}${links}</head></html>`,
    "https://many.test/",
    4,
  );
  assert.deepEqual(
    candidates.map(({ url }) => url),
    [
      "https://many.test/feed-0.xml",
      "https://many.test/feed-1.xml",
      "https://many.test/feed-2.xml",
      "https://many.test/feed-3.xml",
    ],
  );
});

test("validates an explicit connector kind and applies the panel refresh default", async () => {
  const engine = createFeedEngine({
    fetchImpl: async () =>
      response(RSS_FIXTURE, { headers: { "content-type": "application/rss+xml" } }),
  });
  try {
    const state = await engine.createPanel({
      kind: "feed",
      name: "Rapide",
      defaultRefreshIntervalSeconds: 120,
    });
    const panel = state.panels[0];
    assert.equal(panel.defaultRefreshIntervalSeconds, 120);
    await assert.rejects(
      engine.addSource(panel.id, {
        url: "https://source.test/feed.xml",
        connectorKind: "atom",
      }),
      /RSS, pas Atom/,
    );
    const added = await engine.addSource(panel.id, {
      url: "https://source.test/feed.xml",
      connectorKind: "rss",
    });
    assert.equal(added.state.sources[0].connectorKind, "rss");
    assert.equal(added.state.sources[0].refreshIntervalSeconds, 120);
  } finally {
    engine.close();
  }
});

test("selects the requested feed kind when one webpage advertises RSS and Atom", async () => {
  const homepage = "https://mixed.test/";
  const rssUrl = "https://mixed.test/rss.xml";
  const atomUrl = "https://mixed.test/atom.xml";
  const homepageFixture = `<html><head>
    <link rel="alternate" type="application/atom+xml" href="/atom.xml">
    <link rel="alternate" type="application/xml" href="/rss.xml">
  </head></html>`;
  const calls = [];
  const engine = createFeedEngine({
    fetchImpl: async (url) => {
      calls.push(url);
      if (url === homepage) return response(homepageFixture);
      if (url === rssUrl) return response(RSS_FIXTURE);
      if (url === atomUrl) return response(ATOM_FIXTURE);
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  try {
    const firstPanel = await createFeedPanel(engine, "RSS");
    const rss = await engine.addSource(firstPanel.id, {
      url: homepage,
      connectorKind: "rss",
    });
    assert.equal(rss.state.sources[0].feedUrl, rssUrl);
    assert.equal(rss.state.sources[0].connectorKind, "rss");

    const nextState = await engine.createPanel({ kind: "feed", name: "Atom" });
    const atomPanel = nextState.panels.find(({ name }) => name === "Atom");
    const atom = await engine.addSource(atomPanel.id, {
      url: homepage,
      connectorKind: "atom",
    });
    assert.equal(atom.state.sources.length, 2);
    assert.equal(
      atom.state.sources.find(({ feedUrl }) => feedUrl === atomUrl)?.connectorKind,
      "atom",
    );
    assert.ok(calls.includes(rssUrl));
    assert.ok(calls.includes(atomUrl));
  } finally {
    engine.close();
  }
});

test("cancelling a refresh restores its previous health instead of persisting an error", async () => {
  let requestCount = 0;
  const engine = createFeedEngine({
    fetchImpl: async (_url, options) => {
      requestCount += 1;
      if (requestCount === 1) {
        return response(RSS_FIXTURE, { headers: { "content-type": "application/rss+xml" } });
      }
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    },
  });
  try {
    const panelId = (await createFeedPanel(engine)).id;
    const added = await engine.addSource(panelId, "https://source.test/feed.xml");
    const refresh = engine.refreshSource(added.sourceId);
    await Promise.resolve();
    engine.cancelPending();
    const state = await refresh;
    assert.equal(state.sources[0].status, "healthy");
    assert.equal(state.sources[0].errorMessage, null);
  } finally {
    engine.close();
  }
});

test("cancelling a refresh preserves the explanation of an existing source error", async () => {
  let requestCount = 0;
  const engine = createFeedEngine({
    fetchImpl: async (_url, options) => {
      requestCount += 1;
      if (requestCount === 1) return response(RSS_FIXTURE);
      if (requestCount === 2) throw new Error("source hors ligne");
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    },
  });
  try {
    const panelId = (await createFeedPanel(engine)).id;
    const added = await engine.addSource(panelId, "https://source.test/feed.xml");
    const failed = await engine.refreshSource(added.sourceId);
    assert.equal(failed.sources[0].status, "error");
    assert.match(failed.sources[0].errorMessage, /source hors ligne/);

    const refresh = engine.refreshSource(added.sourceId);
    await Promise.resolve();
    engine.cancelPending();
    const restored = await refresh;
    assert.equal(restored.sources[0].status, "error");
    assert.match(restored.sources[0].errorMessage, /source hors ligne/);
  } finally {
    engine.close();
  }
});
