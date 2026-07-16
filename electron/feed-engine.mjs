import { createHash } from "node:crypto";

import { load as loadHtml } from "cheerio";
import { XMLParser } from "fast-xml-parser";
import { getDomain } from "tldts";

import {
  createLocalFeedDatabase,
  MAX_HTTP_URL_LENGTH,
  MAX_ITEMS_PER_SOURCE,
} from "./database.mjs";
import {
  isNonPublicIpAddress,
  isPrivateNetworkHostname,
  proxyRouteKind,
} from "./network-safety.mjs";

export { isNonPublicIpAddress } from "./network-safety.mjs";

const DEFAULT_TTL_SECONDS = 60;
const MAX_CACHE_TTL_SECONDS = 3_600;
const MAX_RESPONSE_BYTES = 12_000_000;
const MAX_XML_NODES = 50_000;
const MAX_XML_ATTRIBUTES = 30_000;
const MAX_XML_DEPTH = 64;
const MAX_XML_DECLARATION_CHARS = 256;
const MAX_HTML_DISCOVERY_CHARS = 256 * 1_024;
const MAX_HTML_DISCOVERY_NODES = 4_000;
const MAX_HTML_DISCOVERY_ATTRIBUTES = 12_000;
const MAX_CLEAN_TEXT_MARKUP_CHARS = 16 * 1_024;
const MAX_REDIRECTS = 5;
const MAX_DISCOVERED_FEEDS = 4;
const MIN_REFRESH_INTERVAL_SECONDS = 30;
const MAX_REFRESH_INTERVAL_SECONDS = 3_600;
const MAX_FAILURE_BACKOFF_SECONDS = 1_800;
const MAX_CONCURRENT_REFRESHES = 6;
const MAX_CONCURRENT_REFRESHES_PER_HOST = 2;
const MAX_SOURCE_PROBE_SAMPLES = 3;
const CONNECTOR_PREFERENCES = new Set(["auto", "rss", "atom", "news-sitemap"]);
const OPTIMIZED_SOURCE_CAPABILITIES = Object.freeze([
  "optimized-feed",
  "simplified-reading",
]);
const LE_MONDE_FEED_URL = "https://www.lemonde.fr/rss/en_continu.xml";
const LE_FIGARO_FEED_URL = "https://www.lefigaro.fr/rss/figaro_flash-actu.xml";
const LE_PARISIEN_FEED_URL = "https://feeds.leparisien.fr/leparisien/rss";
const LE_PARISIEN_NEWS_SITEMAP_URL =
  "https://www.leparisien.fr/arc/outboundfeeds/sitemapnews/?outputType=xml&from=0";
const CURATED_PROXY_ENDPOINTS = new Set([
  LE_MONDE_FEED_URL,
  LE_FIGARO_FEED_URL,
  LE_PARISIEN_FEED_URL,
  LE_PARISIEN_NEWS_SITEMAP_URL,
]);
const TRACKING_PARAMETERS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "oly_anon_id",
  "oly_enc_id",
]);

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  ignorePiTags: true,
});

export const KNOWN_PUBLICATIONS = Object.freeze([
  {
    id: "le-monde",
    name: "Le Monde",
    description: "L’actualité en continu, avec une lecture facilitée des articles.",
    homepageUrl: "https://www.lemonde.fr/",
    hostnames: ["lemonde.fr"],
    feedUrl: LE_MONDE_FEED_URL,
    connectorKind: "rss",
    refreshIntervalSeconds: 300,
  },
  {
    id: "le-figaro",
    name: "Le Figaro",
    description: "Le fil Flash Actu, avec une lecture facilitée des articles.",
    homepageUrl: "https://www.lefigaro.fr/",
    hostnames: ["lefigaro.fr"],
    feedUrl: LE_FIGARO_FEED_URL,
    connectorKind: "rss",
    refreshIntervalSeconds: 600,
  },
  {
    id: "le-parisien",
    name: "Le Parisien",
    description: "L’actualité du Parisien, enrichie pour une lecture facilitée.",
    homepageUrl: "https://www.leparisien.fr/",
    hostnames: ["leparisien.fr"],
    feedUrl: LE_PARISIEN_FEED_URL,
    connectorKind: "rss",
    refreshIntervalSeconds: 180,
  },
]);

export const SOURCE_CATALOG = Object.freeze(
  KNOWN_PUBLICATIONS.map(
    ({ id, name, description, homepageUrl, connectorKind, refreshIntervalSeconds }) =>
      Object.freeze({
        id,
        name,
        description,
        homepageUrl,
        connectorKind,
        refreshIntervalSeconds,
        capabilities: OPTIMIZED_SOURCE_CAPABILITIES,
      }),
  ),
);

function publicSourceCatalog() {
  return SOURCE_CATALOG.map((source) => ({
    ...source,
    capabilities: [...source.capabilities],
  }));
}

function connectorIdForFeedUrl(feedUrl) {
  return KNOWN_PUBLICATIONS.find((publication) => publication.feedUrl === feedUrl)?.id ?? null;
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function valueAsText(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (Array.isArray(value)) return value.map(valueAsText).find(Boolean) ?? "";
  if (typeof value === "object") {
    return valueAsText(value["#text"] ?? value.__cdata ?? value.cdata);
  }
  return "";
}

function firstText(...values) {
  for (const value of values) {
    const text = valueAsText(value);
    if (text) return text;
  }
  return "";
}

function cleanText(value, limit = 500) {
  if (!value) return null;
  // Rich feed fields are untrusted. Only a small prefix ever reaches Cheerio;
  // the 12 MB response cap alone would still permit one giant CDATA field to
  // allocate a disproportionate DOM for a 350/700-character result.
  const markup = String(value).slice(0, MAX_CLEAN_TEXT_MARKUP_CHARS);
  const $ = loadHtml(`<body>${markup}</body>`);
  const text = $("body").text().replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

function normalizeDate(value) {
  const text = valueAsText(value);
  if (!text) return null;
  const timestamp = Date.parse(text);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function resolveHttpUrl(value, baseUrl) {
  const text = valueAsText(value);
  if (!text || text.length > MAX_HTTP_URL_LENGTH) return null;
  try {
    const url = new URL(text, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.href.length > MAX_HTTP_URL_LENGTH) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function normalizeInputUrl(input) {
  if (typeof input !== "string" || !input.trim()) {
    throw new TypeError("Collez l’adresse d’un site ou d’un flux.");
  }

  const trimmed = input.trim();
  if (trimmed.length > MAX_HTTP_URL_LENGTH) {
    throw new RangeError(
      `Cette adresse dépasse ${MAX_HTTP_URL_LENGTH.toLocaleString("fr-FR")} caractères.`,
    );
  }
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new TypeError("Cette adresse n’est pas valide.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("Seules les adresses web HTTP et HTTPS sont acceptées.");
  }
  if (url.username || url.password) {
    throw new TypeError("Les adresses contenant des identifiants ne sont pas acceptées.");
  }
  url.hash = "";
  if (url.href.length > MAX_HTTP_URL_LENGTH) {
    throw new RangeError(
      `Cette adresse dépasse ${MAX_HTTP_URL_LENGTH.toLocaleString("fr-FR")} caractères.`,
    );
  }
  return url.href;
}

function normalizeRefreshInterval(value) {
  if (value == null) return null;
  if (
    !Number.isInteger(value) ||
    value < MIN_REFRESH_INTERVAL_SECONDS ||
    value > MAX_REFRESH_INTERVAL_SECONDS
  ) {
    throw new RangeError("La fréquence doit être comprise entre 30 secondes et 60 minutes.");
  }
  return value;
}

function normalizeSourceRequest(input) {
  if (typeof input === "string") {
    return { url: input, connectorKind: "auto", refreshIntervalSeconds: null };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Configuration de source invalide.");
  }
  const connectorKind = input.connectorKind ?? "auto";
  if (!CONNECTOR_PREFERENCES.has(connectorKind)) {
    throw new TypeError("Le type de connecteur doit être RSS, Atom, Sitemap ou automatique.");
  }
  return {
    url: input.url,
    connectorKind,
    refreshIntervalSeconds: normalizeRefreshInterval(input.refreshIntervalSeconds),
  };
}

function connectorKindLabel(kind) {
  if (kind === "news-sitemap") return "Sitemap";
  if (kind === "atom") return "Atom";
  return "RSS";
}

class ConnectorKindMismatchError extends Error {
  constructor(expected, actual) {
    super(
      `Cette adresse expose un connecteur ${connectorKindLabel(actual)}, pas ${connectorKindLabel(expected)}.`,
    );
    this.name = "ConnectorKindMismatchError";
  }
}

class FeedCardinalityError extends RangeError {
  constructor() {
    super(
      `Ce flux contient plus de ${MAX_ITEMS_PER_SOURCE.toLocaleString("fr-FR")} entrées et ne peut pas être ajouté.`,
    );
    this.name = "FeedCardinalityError";
  }
}

class FeedStructureError extends Error {
  constructor(message) {
    super(message);
    this.name = "FeedStructureError";
  }
}

class FeedSafetyError extends FeedStructureError {
  constructor(message) {
    super(message);
    this.name = "FeedSafetyError";
  }
}

function assertConnectorKind(expected, actual) {
  if (expected === "auto" || expected === actual) return;
  throw new ConnectorKindMismatchError(expected, actual);
}

function baseHostname(hostname) {
  return hostname.toLowerCase().replace(/^(?:www\.|m\.)/, "");
}

export function feedUrlsShareSite(first, second) {
  const firstHost = baseHostname(new URL(normalizeInputUrl(first)).hostname);
  const secondHost = baseHostname(new URL(normalizeInputUrl(second)).hostname);
  const firstDomain = getDomain(firstHost);
  const secondDomain = getDomain(secondHost);
  return (
    firstHost === secondHost ||
    firstHost.endsWith(`.${secondHost}`) ||
    secondHost.endsWith(`.${firstHost}`) ||
    (Boolean(firstDomain) && firstDomain === secondDomain)
  );
}

export function assertSafeFeedUrl(
  input,
  { allowPrivateNetwork = false, expectedSiteUrl = null } = {},
) {
  const normalized = normalizeInputUrl(input);
  if (!allowPrivateNetwork && isPrivateNetworkHostname(new URL(normalized).hostname)) {
    throw new Error(
      "Les adresses locales, privées ou réservées ne sont pas contactées automatiquement.",
    );
  }
  if (expectedSiteUrl && !feedUrlsShareSite(expectedSiteUrl, normalized)) {
    throw new Error(
      "Cette source redirige vers un autre domaine. Ajoutez directement son URL pour l’autoriser.",
    );
  }
  return normalized;
}

export function matchKnownPublication(input) {
  const inputUrl = normalizeInputUrl(input);
  const url = new URL(inputUrl);
  const hostname = baseHostname(url.hostname);
  const publication = KNOWN_PUBLICATIONS.find(({ hostnames }) =>
    hostnames.some((knownHostname) =>
      hostname === knownHostname || hostname.endsWith(`.${knownHostname}`),
    ),
  );
  if (!publication) return null;

  // A publication homepage should get the polished default connector, but an
  // explicitly pasted section feed or news sitemap must remain user-selectable.
  const path = url.pathname.toLowerCase();
  const looksExplicit =
    inputUrl !== publication.feedUrl &&
    (url.hostname.toLowerCase().startsWith("feeds.") ||
      /(?:^|\/)(?:rss|feed|feeds|sitemap)(?:\/|[-_.]|$)/.test(path) ||
      /\.(?:xml|rss|atom)(?:\/)?$/.test(path));
  if (looksExplicit) return null;
  return { ...publication, inputUrl };
}

export function canonicalizeUrl(value, baseUrl) {
  const resolved = resolveHttpUrl(value, baseUrl);
  if (!resolved) return null;
  const url = new URL(resolved);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMETERS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  return url.href.length <= MAX_HTTP_URL_LENGTH ? url.href : null;
}

function rssLink(item, baseUrl) {
  for (const link of asArray(item.link)) {
    const candidate =
      typeof link === "object" ? link["@_href"] ?? link["#text"] : link;
    const resolved = resolveHttpUrl(candidate, baseUrl);
    if (resolved) return resolved;
  }
  return resolveHttpUrl(valueAsText(item.guid), baseUrl);
}

function atomLink(entry, baseUrl) {
  const links = asArray(entry.link);
  const alternate = links.find(
    (link) => typeof link === "object" && (!link["@_rel"] || link["@_rel"] === "alternate"),
  );
  const candidate = alternate ?? links[0];
  const value = typeof candidate === "object" ? candidate?.["@_href"] : candidate;
  return resolveHttpUrl(value, baseUrl) ?? resolveHttpUrl(valueAsText(entry.id), baseUrl);
}

function objectUrl(value, baseUrl) {
  for (const candidate of asArray(value)) {
    if (typeof candidate === "object") {
      const url = resolveHttpUrl(
        candidate["@_url"] ?? candidate["@_href"] ?? candidate.loc ?? candidate["#text"],
        baseUrl,
      );
      if (url) return url;
    } else {
      const url = resolveHttpUrl(candidate, baseUrl);
      if (url) return url;
    }
  }
  return null;
}

function rssImage(item, baseUrl) {
  const enclosure = asArray(item.enclosure).find((entry) => {
    const type = entry?.["@_type"] ?? "";
    return typeof entry === "object" && (!type || String(type).startsWith("image/"));
  });
  return (
    objectUrl(enclosure, baseUrl) ??
    objectUrl(item.thumbnail, baseUrl) ??
    (typeof item.content === "object" ? objectUrl(item.content, baseUrl) : null)
  );
}

function assertFeedCardinality(entries) {
  if (entries.length > MAX_ITEMS_PER_SOURCE) {
    throw new FeedCardinalityError();
  }
}

function findXmlTagEnd(xml, tagStart) {
  let quote = null;
  for (let cursor = tagStart + 1; cursor < xml.length; cursor += 1) {
    const character = xml[cursor];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") return cursor;
  }
  throw new FeedStructureError("Le XML contient une balise incomplète.");
}

function xmlNameEnd(xml, start, end) {
  let cursor = start;
  while (cursor < end && !/[\s=/>]/.test(xml[cursor])) cursor += 1;
  return cursor;
}

function assertSafeXmlName(name) {
  if (!name || /[<>'"]/.test(name)) {
    throw new FeedStructureError("Le XML contient un nom de balise ou d’attribut invalide.");
  }
}

function scanXmlAttributes(xml, nameEnd, tagEnd, budget) {
  let cursor = nameEnd;
  let selfClosing = false;
  while (cursor < tagEnd) {
    while (cursor < tagEnd && /\s/.test(xml[cursor])) cursor += 1;
    if (cursor >= tagEnd) break;
    if (xml[cursor] === "/") {
      cursor += 1;
      while (cursor < tagEnd && /\s/.test(xml[cursor])) cursor += 1;
      if (cursor !== tagEnd) throw new FeedStructureError("Le XML contient une balise invalide.");
      selfClosing = true;
      break;
    }

    const attributeStart = cursor;
    cursor = xmlNameEnd(xml, cursor, tagEnd);
    const attributeName = xml.slice(attributeStart, cursor);
    assertSafeXmlName(attributeName);
    while (cursor < tagEnd && /\s/.test(xml[cursor])) cursor += 1;
    if (xml[cursor] !== "=") {
      throw new FeedStructureError("Le XML contient un attribut sans valeur entre guillemets.");
    }
    cursor += 1;
    while (cursor < tagEnd && /\s/.test(xml[cursor])) cursor += 1;
    const quote = xml[cursor];
    if (quote !== '"' && quote !== "'") {
      throw new FeedStructureError("Le XML contient un attribut sans valeur entre guillemets.");
    }
    cursor += 1;
    const valueEnd = xml.indexOf(quote, cursor);
    if (valueEnd < 0 || valueEnd > tagEnd) {
      throw new FeedStructureError("Le XML contient un attribut incomplet.");
    }
    cursor = valueEnd + 1;
    budget.attributes += 1;
    if (budget.attributes > MAX_XML_ATTRIBUTES) {
      throw new FeedSafetyError(
        `Ce flux contient plus de ${MAX_XML_ATTRIBUTES.toLocaleString("fr-FR")} attributs XML et ne peut pas être ajouté.`,
      );
    }
  }
  return selfClosing;
}

function consumeXmlStructureToken(budget) {
  budget.nodes += 1;
  if (budget.nodes > MAX_XML_NODES) {
    throw new FeedSafetyError(
      `Ce flux contient plus de ${MAX_XML_NODES.toLocaleString("fr-FR")} nœuds XML et ne peut pas être ajouté.`,
    );
  }
}

function xmlDeclarationStart(xml) {
  let cursor = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (cursor < xml.length && /\s/.test(xml[cursor])) cursor += 1;
  return cursor;
}

function assertSafeXmlDeclaration(xml, tagStart, budget, declarationState) {
  if (
    declarationState.seen ||
    tagStart !== declarationState.allowedStart ||
    !xml.startsWith("<?xml", tagStart) ||
    !/\s/.test(xml[tagStart + 5] ?? "")
  ) {
    throw new FeedSafetyError(
      "Seule une déclaration XML courte au début du document est autorisée comme instruction de traitement.",
    );
  }
  const end = xml.indexOf("?>", tagStart + 5);
  if (end < 0 || end + 2 - tagStart > MAX_XML_DECLARATION_CHARS) {
    throw new FeedSafetyError(
      `La déclaration XML dépasse ${MAX_XML_DECLARATION_CHARS} caractères ou est incomplète.`,
    );
  }
  const declaration = xml.slice(tagStart, end + 2);
  const body = declaration.slice(5, -2).trim();
  if (
    !/^version\s*=\s*(["'])(1\.[01])\1(?:\s+encoding\s*=\s*(["'])([A-Za-z][A-Za-z0-9._-]*)\3)?(?:\s+standalone\s*=\s*(["'])(yes|no)\5)?$/.test(
      body,
    )
  ) {
    throw new FeedSafetyError("La déclaration XML contient des attributs invalides.");
  }
  declarationState.seen = true;
  consumeXmlStructureToken(budget);
  return end + 2;
}

function assertRawFeedStructure(xml) {
  let cursor = 0;
  let entryCount = 0;
  const budget = { attributes: 0, nodes: 0 };
  const openElements = [];
  const declarationState = {
    allowedStart: xmlDeclarationStart(xml),
    seen: false,
  };
  while (cursor < xml.length) {
    const tagStart = xml.indexOf("<", cursor);
    if (tagStart < 0) break;
    if (xml.startsWith("<!--", tagStart)) {
      consumeXmlStructureToken(budget);
      const end = xml.indexOf("-->", tagStart + 4);
      if (end < 0) throw new FeedStructureError("Le XML contient un commentaire incomplet.");
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", tagStart)) {
      consumeXmlStructureToken(budget);
      const end = xml.indexOf("]]>", tagStart + 9);
      if (end < 0) throw new FeedStructureError("Le XML contient une section CDATA incomplète.");
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<?", tagStart)) {
      cursor = assertSafeXmlDeclaration(
        xml,
        tagStart,
        budget,
        declarationState,
      );
      continue;
    }
    if (xml.startsWith("<!", tagStart)) {
      throw new FeedSafetyError(
        "Les déclarations XML DOCTYPE, ENTITY ou similaires ne sont pas autorisées.",
      );
    }

    if (xml.startsWith("</", tagStart)) {
      const tagEnd = xml.indexOf(">", tagStart + 2);
      if (tagEnd < 0) {
        throw new FeedStructureError("Le XML contient une balise fermante incomplète.");
      }
      const closingName = xml.slice(tagStart + 2, tagEnd).trim();
      assertSafeXmlName(closingName);
      const expectedName = openElements.pop();
      if (expectedName !== closingName) {
        throw new FeedStructureError("Le XML contient des balises mal imbriquées.");
      }
      cursor = tagEnd + 1;
      continue;
    }

    const tagEnd = findXmlTagEnd(xml, tagStart);
    const nameStart = tagStart + 1;
    const nameEnd = xmlNameEnd(xml, nameStart, tagEnd);
    const elementName = xml.slice(nameStart, nameEnd);
    assertSafeXmlName(elementName);
    consumeXmlStructureToken(budget);
    const selfClosing = scanXmlAttributes(xml, nameEnd, tagEnd, budget);
    const localName = elementName.split(":").at(-1)?.toLowerCase();
    if (["item", "entry", "url"].includes(localName)) {
      entryCount += 1;
      if (entryCount > MAX_ITEMS_PER_SOURCE) throw new FeedCardinalityError();
    }
    if (!selfClosing) {
      openElements.push(elementName);
      if (openElements.length > MAX_XML_DEPTH) {
        throw new FeedSafetyError(
          `La profondeur XML dépasse ${MAX_XML_DEPTH} niveaux et ne peut pas être ajoutée.`,
        );
      }
    }
    cursor = tagEnd + 1;
  }
  if (openElements.length > 0) {
    throw new FeedStructureError("Le XML contient une balise non refermée.");
  }
}

function parseRss(document, baseUrl) {
  const channel = document.rss?.channel ?? document.RDF ?? document.rdf;
  if (!channel) return null;
  const rawItems = channel.item ?? document.RDF?.item ?? document.rdf?.item;
  const entries = asArray(rawItems);
  assertFeedCardinality(entries);
  const items = entries.map((item) => ({
    canonicalUrl: canonicalizeUrl(rssLink(item, baseUrl), baseUrl),
    title: cleanText(firstText(item.title), 350),
    summary: cleanText(firstText(item.description, item.encoded), 700),
    imageUrl: rssImage(item, baseUrl),
    publishedAt: normalizeDate(item.pubDate ?? item.date ?? item.published),
    updatedAt: normalizeDate(item.updated),
  }));
  return {
    kind: "rss",
    title: cleanText(firstText(channel.title), 120),
    items,
  };
}

function parseAtom(document, baseUrl) {
  const feed = document.feed;
  if (!feed) return null;
  const entries = asArray(feed.entry);
  assertFeedCardinality(entries);
  const items = entries.map((entry) => ({
    canonicalUrl: canonicalizeUrl(atomLink(entry, baseUrl), baseUrl),
    title: cleanText(firstText(entry.title), 350),
    summary: cleanText(firstText(entry.summary, entry.content), 700),
    imageUrl:
      objectUrl(entry.thumbnail, baseUrl) ??
      objectUrl(
        asArray(entry.link).find((link) => String(link?.["@_type"] ?? "").startsWith("image/")),
        baseUrl,
      ),
    publishedAt: normalizeDate(entry.published ?? entry.updated),
    updatedAt: normalizeDate(entry.updated),
  }));
  return {
    kind: "atom",
    title: cleanText(firstText(feed.title), 120),
    items,
  };
}

function sitemapImage(entry, baseUrl) {
  for (const image of asArray(entry.image)) {
    const url = objectUrl(image?.loc ?? image, baseUrl);
    if (url) return url;
  }
  return null;
}

function parseNewsSitemap(document, baseUrl) {
  const urlset = document.urlset;
  if (!urlset) return null;
  const entries = asArray(urlset.url);
  assertFeedCardinality(entries);
  const items = entries.map((entry) => {
    const news = asArray(entry.news)[0] ?? {};
    const canonicalUrl = canonicalizeUrl(entry.loc, baseUrl);
    let fallbackTitle = null;
    if (canonicalUrl) {
      const pathname = new URL(canonicalUrl).pathname;
      fallbackTitle = decodeURIComponent(pathname.split("/").filter(Boolean).at(-1) ?? "")
        .replace(/[-_]+/g, " ")
        .trim();
    }
    return {
      canonicalUrl,
      title: cleanText(firstText(news.title, entry.title, fallbackTitle), 350),
      summary: null,
      imageUrl: sitemapImage(entry, baseUrl),
      publishedAt: normalizeDate(news.publication_date ?? entry.lastmod),
      updatedAt: normalizeDate(entry.lastmod),
    };
  });
  const publicationName = entries
    .map((entry) => firstText(asArray(entry.news)[0]?.publication?.name))
    .find(Boolean);
  return {
    kind: "news-sitemap",
    title: cleanText(publicationName, 120),
    items,
  };
}

/** Parse RSS 2, Atom, RDF feeds and Google News sitemaps to one shape. */
export function parseFeedDocument(xml, baseUrl) {
  if (typeof xml !== "string" || !xml.trim()) throw new Error("Le flux est vide.");
  // Reject high-cardinality documents before XML object allocation and before
  // per-entry Cheerio cleanup. The parsed-shape checks below remain as defense
  // in depth for unusual namespaces or parser representations.
  assertRawFeedStructure(xml);
  let document;
  try {
    document = xmlParser.parse(xml);
  } catch {
    throw new Error("Le contenu reçu n’est pas un XML valide.");
  }

  const parsed =
    parseRss(document, baseUrl) ??
    parseAtom(document, baseUrl) ??
    parseNewsSitemap(document, baseUrl);
  if (!parsed) {
    throw new Error("Aucun flux RSS, Atom ou sitemap d’actualité n’a été trouvé.");
  }

  const deduplicated = new Map();
  for (const item of parsed.items) {
    if (!item.canonicalUrl || !item.title) continue;
    const current = deduplicated.get(item.canonicalUrl);
    if (!current || (!current.summary && item.summary)) {
      deduplicated.set(item.canonicalUrl, item);
    }
  }
  return { ...parsed, items: [...deduplicated.values()] };
}

function responseLooksLikeHtml(response) {
  const prefix = response.body.slice(0, 4_096);
  return /<!doctype\s+html\b/i.test(prefix) || /<html(?:\s|>)/i.test(prefix);
}

/**
 * The public Le Parisien RSS deliberately contains only titles and links. Its
 * Google News sitemap carries dates and images for the same canonical URLs.
 * RSS remains authoritative: enrichment only fills blanks and never reorders.
 */
export function enrichItemsFromNewsSitemap(items, sitemapItems) {
  const metadataByUrl = new Map(
    sitemapItems
      .filter((item) => item?.canonicalUrl)
      .map((item) => [item.canonicalUrl, item]),
  );
  return items.map((item) => {
    const metadata = metadataByUrl.get(item.canonicalUrl);
    if (!metadata) return item;
    return {
      ...item,
      publishedAt: item.publishedAt ?? metadata.publishedAt ?? null,
      updatedAt: item.updatedAt ?? metadata.updatedAt ?? null,
      imageUrl: item.imageUrl ?? metadata.imageUrl ?? null,
    };
  });
}

function boundedHtmlDiscoveryFragment(html) {
  if (typeof html !== "string") throw new TypeError("Page HTML invalide.");
  const window = html.slice(0, MAX_HTML_DISCOVERY_CHARS + 1);
  const lowerWindow = window.toLowerCase();
  const headMatch = /<head(?:\s|>)/.exec(lowerWindow);
  const start = headMatch?.index ?? 0;
  const headClose = lowerWindow.indexOf("</head", start);
  if (headClose >= 0) {
    const closeEnd = lowerWindow.indexOf(">", headClose + 6);
    if (closeEnd >= 0 && closeEnd + 1 - start <= MAX_HTML_DISCOVERY_CHARS) {
      return html.slice(start, closeEnd + 1);
    }
  }

  const bodyMatch = /<body(?:\s|>)/.exec(lowerWindow.slice(start));
  if (bodyMatch && bodyMatch.index <= MAX_HTML_DISCOVERY_CHARS) {
    return html.slice(start, start + bodyMatch.index);
  }
  if (html.length - start > MAX_HTML_DISCOVERY_CHARS) {
    throw new RangeError(
      `La portion utile de cette page dépasse ${MAX_HTML_DISCOVERY_CHARS.toLocaleString("fr-FR")} caractères et ne peut pas être analysée.`,
    );
  }
  return html.slice(start);
}

function findHtmlTagEnd(html, tagStart) {
  let quote = null;
  for (let cursor = tagStart + 1; cursor < html.length; cursor += 1) {
    const character = html[cursor];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") return cursor;
  }
  return -1;
}

function scanHtmlAttributes(html, nameEnd, tagEnd, budget) {
  let cursor = nameEnd;
  while (cursor < tagEnd) {
    while (cursor < tagEnd && /\s/.test(html[cursor])) cursor += 1;
    if (cursor >= tagEnd || html[cursor] === "/") break;

    const attributeStart = cursor;
    while (cursor < tagEnd && !/[\s=/>]/.test(html[cursor])) cursor += 1;
    if (cursor === attributeStart) {
      cursor += 1;
      continue;
    }
    budget.attributes += 1;
    if (budget.attributes > MAX_HTML_DISCOVERY_ATTRIBUTES) {
      throw new RangeError(
        `Cette page contient plus de ${MAX_HTML_DISCOVERY_ATTRIBUTES.toLocaleString("fr-FR")} attributs HTML et ne peut pas être analysée.`,
      );
    }

    while (cursor < tagEnd && /\s/.test(html[cursor])) cursor += 1;
    if (html[cursor] !== "=") continue;
    cursor += 1;
    while (cursor < tagEnd && /\s/.test(html[cursor])) cursor += 1;
    const quote = html[cursor];
    if (quote === '"' || quote === "'") {
      cursor += 1;
      const valueEnd = html.indexOf(quote, cursor);
      cursor = valueEnd < 0 || valueEnd > tagEnd ? tagEnd : valueEnd + 1;
      continue;
    }
    while (cursor < tagEnd && !/[\s>]/.test(html[cursor])) cursor += 1;
  }
}

function findHtmlRawTextClose(lowerHtml, tagName, start) {
  const needle = `</${tagName}`;
  let match = lowerHtml.indexOf(needle, start);
  while (match >= 0) {
    const boundary = lowerHtml[match + needle.length];
    if (boundary === ">" || /\s/.test(boundary ?? "")) return match;
    match = lowerHtml.indexOf(needle, match + needle.length);
  }
  return -1;
}

function assertHtmlDiscoveryBudget(html) {
  const lowerHtml = html.toLowerCase();
  const budget = { attributes: 0, nodes: 0 };
  let cursor = 0;
  while (cursor < html.length) {
    const tagStart = html.indexOf("<", cursor);
    if (tagStart < 0) break;
    if (html.startsWith("<!--", tagStart)) {
      const commentEnd = html.indexOf("-->", tagStart + 4);
      cursor = commentEnd < 0 ? html.length : commentEnd + 3;
      continue;
    }
    if (
      html.startsWith("</", tagStart) ||
      html.startsWith("<!", tagStart) ||
      html.startsWith("<?", tagStart)
    ) {
      const tagEnd = findHtmlTagEnd(html, tagStart);
      cursor = tagEnd < 0 ? html.length : tagEnd + 1;
      continue;
    }

    const tagEnd = findHtmlTagEnd(html, tagStart);
    if (tagEnd < 0) break;
    const nameStart = tagStart + 1;
    let nameEnd = nameStart;
    while (nameEnd < tagEnd && !/[\s/>]/.test(html[nameEnd])) nameEnd += 1;
    const tagName = lowerHtml.slice(nameStart, nameEnd);
    if (!tagName) {
      cursor = tagEnd + 1;
      continue;
    }
    budget.nodes += 1;
    if (budget.nodes > MAX_HTML_DISCOVERY_NODES) {
      throw new RangeError(
        `Cette page contient plus de ${MAX_HTML_DISCOVERY_NODES.toLocaleString("fr-FR")} éléments HTML et ne peut pas être analysée.`,
      );
    }
    scanHtmlAttributes(html, nameEnd, tagEnd, budget);

    const selfClosing = /\/\s*$/.test(html.slice(nameEnd, tagEnd));
    if (!selfClosing && (tagName === "script" || tagName === "style")) {
      const rawClose = findHtmlRawTextClose(lowerHtml, tagName, tagEnd + 1);
      if (rawClose < 0) break;
      const rawCloseEnd = lowerHtml.indexOf(">", rawClose + tagName.length + 2);
      cursor = rawCloseEnd < 0 ? html.length : rawCloseEnd + 1;
      continue;
    }
    cursor = tagEnd + 1;
  }
}

/** Return feed candidates declared by an ordinary HTML page, in preference order. */
export function discoverFeedsInHtml(html, pageUrl, maxCandidates = Number.POSITIVE_INFINITY) {
  const fragment = boundedHtmlDiscoveryFragment(html);
  assertHtmlDiscoveryBudget(fragment);
  const $ = loadHtml(fragment);
  const candidates = [];
  const seenUrls = new Set();
  $("link[href]").each((_index, element) => {
    if (candidates.length >= maxCandidates) return false;
    const rel = String($(element).attr("rel") ?? "").toLowerCase().split(/\s+/);
    const type = String($(element).attr("type") ?? "").toLowerCase();
    if (!rel.includes("alternate") || !/(?:rss|atom)\+xml|application\/xml|text\/xml/.test(type)) {
      return;
    }
    const url = resolveHttpUrl($(element).attr("href"), pageUrl);
    if (!url || seenUrls.has(url)) return;
    seenUrls.add(url);
    candidates.push({
      url,
      expectedKind: type.includes("atom") ? "atom" : "rss",
      title: cleanText($(element).attr("title"), 120),
    });
  });

  return candidates;
}

function cachePolicy(headers, fallbackSeconds) {
  const cacheControl = headers?.get?.("cache-control") ?? "";
  const noStore = /\bno-store\b/i.test(cacheControl);
  if (/\bno-cache\b/i.test(cacheControl) || noStore) return { maxAge: 0, noStore };
  const match = cacheControl.match(/\b(?:s-maxage|max-age)\s*=\s*"?(\d+)/i);
  const seconds = match ? Number(match[1]) : fallbackSeconds;
  return {
    maxAge: Math.max(
      0,
      Math.min(Number.isFinite(seconds) ? seconds : fallbackSeconds, MAX_CACHE_TTL_SECONDS),
    ),
    noStore,
  };
}

async function discardResponseBody(response) {
  try {
    await response.body?.cancel?.();
  } catch {
    // The response may already be closed or consumed by another fetch adapter.
  }
}

export async function readResponseTextWithLimit(
  response,
  { maxBytes = MAX_RESPONSE_BYTES, signal = null } = {},
) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("Limite de téléchargement invalide.");
  }
  const declaredLength = Number(response.headers?.get?.("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await discardResponseBody(response);
    throw new Error("Ce flux est trop volumineux pour être ajouté.");
  }

  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error("Ce flux est trop volumineux pour être ajouté.");
    }
    return text;
  }

  const decoder = new TextDecoder();
  const chunks = [];
  let receivedBytes = 0;
  try {
    while (true) {
      if (signal?.aborted) throw new FetchCancelledError();
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        await reader.cancel("response_too_large").catch(() => undefined);
        throw new Error("Ce flux est trop volumineux pour être ajouté.");
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock?.();
  }
}

function friendlyFetchError(error) {
  if (error instanceof Error && error.message) return error.message;
  return "La source ne répond pas pour le moment.";
}

class FetchCancelledError extends Error {
  constructor() {
    super("Téléchargement interrompu.");
    this.name = "FetchCancelledError";
  }
}

function isFetchCancelled(error) {
  return error instanceof FetchCancelledError;
}

class RefreshCancelledError extends Error {
  constructor(message = "Rafraîchissement interrompu.") {
    super(message);
    this.name = "RefreshCancelledError";
  }
}

function stableItemId(sourceId, canonicalUrl) {
  if (
    typeof canonicalUrl !== "string" ||
    canonicalUrl.length === 0 ||
    canonicalUrl.length > MAX_HTTP_URL_LENGTH
  ) {
    throw new TypeError("URL d’article invalide avant identification.");
  }
  return createHash("sha256").update(`${sourceId}\u0000${canonicalUrl}`).digest("hex").slice(0, 32);
}

function sourceNameFromUrl(url) {
  const hostname = baseHostname(new URL(url).hostname);
  return hostname.split(".")[0]?.replace(/^./, (letter) => letter.toUpperCase()) || hostname;
}

function configurationErrorText(error) {
  return error instanceof Error && error.message
    ? error.message
    : "Une erreur inattendue s’est produite.";
}

function failureRetryState(source, failedAt) {
  const consecutiveFailures = Math.max(0, Number(source.consecutiveFailures) || 0) + 1;
  const baseSeconds = Math.max(
    MIN_REFRESH_INTERVAL_SECONDS,
    Number(source.refreshIntervalSeconds) || DEFAULT_TTL_SECONDS,
  );
  const delaySeconds = Math.min(
    baseSeconds * 2 ** Math.min(consecutiveFailures - 1, 10),
    MAX_FAILURE_BACKOFF_SECONDS,
  );
  return {
    consecutiveFailures,
    nextRetryAt: new Date(Date.parse(failedAt) + delaySeconds * 1_000).toISOString(),
  };
}

export class FeedEngine {
  constructor({
    dbPath = ":memory:",
    fetchImpl = globalThis.fetch,
    resolveHost = null,
    resolveProxy = null,
    requireHostResolution = false,
    requireProxyResolution = false,
    now = () => new Date(),
    usageTimeZone = null,
    allowPrivateNetwork = false,
  } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("Aucune fonction de téléchargement disponible.");
    if (resolveHost !== null && typeof resolveHost !== "function") {
      throw new TypeError("Le résolveur réseau est invalide.");
    }
    if (resolveProxy !== null && typeof resolveProxy !== "function") {
      throw new TypeError("Le résolveur de proxy est invalide.");
    }
    if (requireHostResolution === true && typeof resolveHost !== "function") {
      throw new Error("La résolution réseau sécurisée est obligatoire en production.");
    }
    if (requireProxyResolution === true && typeof resolveProxy !== "function") {
      throw new Error("La vérification du proxy est obligatoire en production.");
    }
    this.database = createLocalFeedDatabase(dbPath, { usageTimeZone });
    this.fetchImpl = fetchImpl;
    this.resolveHost = resolveHost;
    this.resolveProxy = resolveProxy;
    this.requireHostResolution = requireHostResolution === true;
    this.requireProxyResolution = requireProxyResolution === true;
    this.allowPrivateNetwork = allowPrivateNetwork === true;
    this.now = now;
    this.inflight = new Map();
    this.abortControllers = new Set();
    this.refreshQueue = [];
    this.refreshTasks = new Map();
    this.activeRefreshTasks = new Set();
    this.activeRefreshCount = 0;
    this.activeRefreshesByHost = new Map();
    const latestArrivalBatchTimestamp = Date.parse(
      this.database.getLatestArrivalBatchAt() ?? "",
    );
    this.lastArrivalBatchTimestamp = Number.isFinite(latestArrivalBatchTimestamp)
      ? latestArrivalBatchTimestamp
      : Number.NEGATIVE_INFINITY;
    this.feedConfigurationSaveActive = false;
    this.activeStandaloneFeedConfigurationMutations = 0;
    this.closed = false;
  }

  #nowDate() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.valueOf())) throw new Error("Horloge locale invalide.");
    return date;
  }

  #nowIso() {
    return this.#nowDate().toISOString();
  }

  createArrivalBatchAt() {
    const timestamp = Math.max(
      this.#nowDate().valueOf(),
      this.lastArrivalBatchTimestamp + 1,
    );
    this.lastArrivalBatchTimestamp = timestamp;
    return new Date(timestamp).toISOString();
  }

  #assertFeedConfigurationMutationIdle() {
    if (
      this.feedConfigurationSaveActive ||
      this.activeStandaloneFeedConfigurationMutations > 0
    ) {
      throw new Error("Une configuration de fil est déjà en cours.");
    }
  }

  async #runStandaloneFeedConfigurationMutation(operation) {
    this.#assertFeedConfigurationMutationIdle();
    this.activeStandaloneFeedConfigurationMutations += 1;
    try {
      return await operation();
    } finally {
      this.activeStandaloneFeedConfigurationMutations = Math.max(
        0,
        this.activeStandaloneFeedConfigurationMutations - 1,
      );
    }
  }

  getState() {
    return {
      ...this.database.getState(this.#nowIso()),
      sourceCatalog: publicSourceCatalog(),
    };
  }

  getSourceCatalog() {
    return publicSourceCatalog();
  }

  getRefreshScheduleSources() {
    return this.database.listSourceSchedules({ attachedOnly: true });
  }

  async probeSource(input, { signal = null } = {}) {
    if (signal?.aborted) throw new FetchCancelledError();
    const request = normalizeSourceRequest(input);
    const normalizedInputUrl = normalizeInputUrl(request.url);
    const resolved = await this.#resolveSource(normalizedInputUrl, request.connectorKind, {
      signal,
    });
    const itemCount = resolved.parsed.items.length;
    const freshness = resolved.response.stale ? "stale" : "fresh";
    const warning = resolved.response.stale
      ? "La source est momentanément indisponible ; l’aperçu provient du dernier cache disponible."
      : itemCount === 0
        ? "Ce flux est valide, mais il ne contient aucun article pour le moment."
        : null;

    return {
      normalizedInputUrl,
      name: resolved.name,
      connectorKind: resolved.connectorKind,
      connectorId: resolved.connectorId,
      itemCount,
      samples: resolved.parsed.items
        .slice(0, MAX_SOURCE_PROBE_SAMPLES)
        .map(({ title, publishedAt }) => ({ title, publishedAt })),
      freshness,
      warning,
    };
  }

  async createPanel(input, placement = null) {
    this.#assertFeedConfigurationMutationIdle();
    this.database.createPanel(input, placement, this.#nowIso());
    return this.getState();
  }

  async renamePanel(panelId, name) {
    this.#assertFeedConfigurationMutationIdle();
    this.database.renamePanel(panelId, name, this.#nowIso());
    return this.getState();
  }

  async setWebPanelUrl(panelId, url) {
    this.#assertFeedConfigurationMutationIdle();
    this.database.setWebPanelUrl(panelId, url, this.#nowIso());
    return this.getState();
  }

  async setFeedPanelDefaultRefresh(panelId, refreshIntervalSeconds) {
    this.#assertFeedConfigurationMutationIdle();
    this.database.setFeedPanelDefaultRefresh(
      panelId,
      normalizeRefreshInterval(refreshIntervalSeconds),
      this.#nowIso(),
    );
    return this.getState();
  }

  async saveFeedPanelConfiguration(panelId, draft) {
    // Source rows are shared across panels. Only one complete configuration
    // transaction may run at once, otherwise a rollback in one panel could
    // overwrite a successful edit in another panel.
    this.#assertFeedConfigurationMutationIdle();
    if (this.closed) throw new RefreshCancelledError("Le moteur de veille est fermé.");
    this.feedConfigurationSaveActive = true;

    try {
      // The checkpoint never crosses the main-process boundary. It includes
      // detached cache rows so connector and interval changes can be restored
      // exactly even when the renderer has never seen those sources.
      const checkpoint = this.database.captureFeedPanelConfiguration(panelId);
      const keptSourceIds = new Set(draft.keptSourceIds);
      const attachedSourceIds = new Set(checkpoint.sourceIds);
      if ([...keptSourceIds].some((sourceId) => !attachedSourceIds.has(sourceId))) {
        throw new Error("Une source conservée n’est plus associée à ce fil.");
      }
      const desiredSourceIds = new Set(draft.keptSourceIds);

      try {
        const existingConnectorIds = new Set(
          checkpoint.sourceConfigurations
            .filter(({ sourceId }) => keptSourceIds.has(sourceId))
            .map(({ connectorId }) => connectorId)
            .filter(Boolean),
        );
        for (const catalogId of new Set(draft.selectedCatalogIds)) {
          if (existingConnectorIds.has(catalogId)) continue;
          const result = await this.#addCatalogSource(panelId, catalogId, {
            refreshIntervalSeconds: draft.defaultRefreshIntervalSeconds,
          });
          desiredSourceIds.add(result.sourceId);
        }

        const seenCustomSources = new Set();
        for (const source of draft.customSources) {
          const key = `${source.connectorKind}\u0000${source.url}`;
          if (seenCustomSources.has(key)) continue;
          seenCustomSources.add(key);
          const result = await this.#addSource(panelId, {
            ...source,
            refreshIntervalSeconds: draft.defaultRefreshIntervalSeconds,
          });
          desiredSourceIds.add(result.sourceId);
        }

        // Do network-dependent work first. The remaining local mutations are
        // still covered by the same private checkpoint.
        if (draft.name !== checkpoint.name) {
          this.database.renamePanel(panelId, draft.name, this.#nowIso());
        }
        if (
          draft.defaultRefreshIntervalSeconds !==
          checkpoint.defaultRefreshIntervalSeconds
        ) {
          this.database.setFeedPanelDefaultRefresh(
            panelId,
            draft.defaultRefreshIntervalSeconds,
            this.#nowIso(),
          );
        }
        for (const sourceId of checkpoint.sourceIds) {
          if (!desiredSourceIds.has(sourceId)) {
            this.database.detachSource(panelId, sourceId);
          }
        }
        return this.getState();
      } catch (caught) {
        try {
          this.database.restoreFeedPanelConfiguration(
            panelId,
            checkpoint,
            this.#nowIso(),
          );
        } catch (rollbackError) {
          throw new Error(
            `Configuration interrompue et restauration incomplète : ${configurationErrorText(caught)} ` +
              `(restauration : ${configurationErrorText(rollbackError)})`,
            { cause: caught },
          );
        }
        throw new Error(
          `Aucune modification conservée : ${configurationErrorText(caught)}`,
          { cause: caught },
        );
      }
    } finally {
      this.feedConfigurationSaveActive = false;
    }
  }

  async deletePanel(panelId) {
    this.#assertFeedConfigurationMutationIdle();
    this.database.deletePanel(panelId, this.#nowIso());
    return this.getState();
  }

  async saveDashboardLayout(layout, expectedRevision) {
    this.#assertFeedConfigurationMutationIdle();
    this.database.saveDashboardLayout(layout, expectedRevision, this.#nowIso());
    return this.getState();
  }

  async markItemsSeen(itemIds) {
    this.database.markItemsSeen(itemIds, this.#nowIso());
    return this.getState();
  }

  async markItemOpened(itemId) {
    this.database.markItemOpened(itemId, this.#nowIso());
    return this.getState();
  }

  exportDashboardConfig() {
    return this.database.exportDashboardConfig(this.#nowIso());
  }

  previewDashboardConfig(configuration) {
    return this.database.previewDashboardConfig(configuration);
  }

  async importDashboardConfig(configuration) {
    this.#assertFeedConfigurationMutationIdle();
    this.database.importDashboardConfig(configuration, this.#nowIso());
    return this.getState();
  }

  recordPilotEvent(type, context = {}) {
    this.database.recordPilotEvent(type, context, this.#nowIso());
  }

  getPilotDiagnostics() {
    return this.database.getPilotDiagnostics(this.#nowIso());
  }

  getSemanticSearchDocuments(sourceIds) {
    return this.database.listSemanticSearchDocuments(sourceIds);
  }

  getSemanticSearchItems(itemIds) {
    return this.database.getSemanticSearchItems(itemIds);
  }

  beginPilotSession() {
    return this.database.beginPilotSession(this.#nowIso());
  }

  heartbeatPilotSession(sessionId, options = {}) {
    return this.database.heartbeatPilotSession(sessionId, options, this.#nowIso());
  }

  endPilotSession(sessionId) {
    return this.database.endPilotSession(sessionId, this.#nowIso());
  }

  async removeSource(panelId, sourceId) {
    this.#assertFeedConfigurationMutationIdle();
    this.database.detachSource(panelId, sourceId);
    return this.getState();
  }

  #rejectQueuedRefreshes(error) {
    const queued = this.refreshQueue.splice(0);
    for (const task of queued) {
      task.state = "cancelled";
      if (this.refreshTasks.get(task.sourceId) === task) {
        this.refreshTasks.delete(task.sourceId);
      }
      task.reject(error instanceof Error ? error : new RefreshCancelledError());
    }
  }

  #abortNetworkRequests() {
    for (const controller of this.abortControllers) controller.abort();
    this.abortControllers.clear();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const error = new RefreshCancelledError("Le moteur de veille est fermé.");
    this.#rejectQueuedRefreshes(error);
    for (const task of this.activeRefreshTasks) task.reject(error);
    this.#abortNetworkRequests();
    this.database.close();
  }

  cancelPending() {
    this.#rejectQueuedRefreshes(new RefreshCancelledError());
    this.#abortNetworkRequests();
  }

  #enqueueRefresh(
    sourceId,
    { force = false, arrivalBatchAt = null, projectState = true } = {},
  ) {
    if (this.closed) {
      return Promise.reject(new RefreshCancelledError("Le moteur de veille est fermé."));
    }
    const existing = this.refreshTasks.get(sourceId);
    if (existing) {
      if (force && existing.state === "pending") existing.force = true;
      if (!projectState) return existing.completion;
      existing.promise ??= existing.completion.then(() => this.getState());
      return existing.promise;
    }

    const source = this.database.getSource(sourceId);
    if (!source) return Promise.reject(new Error("Source introuvable."));
    const hostname = new URL(source.feedUrl).hostname.toLowerCase();
    let resolve;
    let reject;
    const completion = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const promise = projectState ? completion.then(() => this.getState()) : null;
    const task = {
      sourceId,
      hostname,
      force: Boolean(force),
      arrivalBatchAt: arrivalBatchAt ?? this.createArrivalBatchAt(),
      state: "pending",
      completion,
      promise,
      resolve,
      reject,
    };
    this.refreshTasks.set(sourceId, task);
    this.refreshQueue.push(task);
    this.#pumpRefreshQueue();
    return projectState ? promise : completion;
  }

  #pumpRefreshQueue() {
    if (this.closed) return;
    while (this.activeRefreshCount < MAX_CONCURRENT_REFRESHES) {
      const nextIndex = this.refreshQueue.findIndex(
        ({ hostname }) =>
          (this.activeRefreshesByHost.get(hostname) ?? 0) <
          MAX_CONCURRENT_REFRESHES_PER_HOST,
      );
      if (nextIndex < 0) return;
      const [task] = this.refreshQueue.splice(nextIndex, 1);
      task.state = "active";
      this.activeRefreshCount += 1;
      this.activeRefreshesByHost.set(
        task.hostname,
        (this.activeRefreshesByHost.get(task.hostname) ?? 0) + 1,
      );
      this.activeRefreshTasks.add(task);
      void this.#runRefreshTask(task);
    }
  }

  async #runRefreshTask(task) {
    try {
      await this.#refreshOne(task.sourceId, {
        respectBackoff: !task.force,
        arrivalBatchAt: task.arrivalBatchAt,
      });
      if (this.closed) throw new RefreshCancelledError("Le moteur de veille est fermé.");
      task.resolve();
    } catch (error) {
      task.reject(
        this.closed && !(error instanceof RefreshCancelledError)
          ? new RefreshCancelledError("Le moteur de veille est fermé.")
          : error,
      );
    } finally {
      this.activeRefreshTasks.delete(task);
      this.activeRefreshCount = Math.max(0, this.activeRefreshCount - 1);
      const remainingForHost = Math.max(
        0,
        (this.activeRefreshesByHost.get(task.hostname) ?? 1) - 1,
      );
      if (remainingForHost === 0) this.activeRefreshesByHost.delete(task.hostname);
      else this.activeRefreshesByHost.set(task.hostname, remainingForHost);
      task.state = "settled";
      if (this.refreshTasks.get(task.sourceId) === task) {
        this.refreshTasks.delete(task.sourceId);
      }
      this.#pumpRefreshQueue();
    }
  }

  /**
   * Cached, conditional and request-coalesced HTTP read. It is public mainly so
   * a future connector can reuse the exact same cache without knowing SQLite.
   */
  async #assertProxyRouteSafe(
    inputUrl,
    { curatedRootUrl = null, isRedirect = false } = {},
  ) {
    if (this.allowPrivateNetwork) return;
    if (!this.resolveProxy) {
      if (this.requireProxyResolution) {
        throw new Error("La vérification du proxy est indisponible.");
      }
      return;
    }

    let route;
    try {
      route = await this.resolveProxy(inputUrl);
    } catch {
      throw new Error("La configuration proxy de cette source ne peut pas être vérifiée.");
    }
    const kind = proxyRouteKind(route);
    if (kind === "unknown") {
      throw new Error("La route réseau retournée par le proxy n’est pas reconnue.");
    }
    if (kind === "direct") return;

    const isCuratedProxyHop =
      curatedRootUrl !== null &&
      new URL(inputUrl).protocol === "https:" &&
      (inputUrl === curatedRootUrl ||
        (isRedirect && feedUrlsShareSite(curatedRootUrl, inputUrl)));
    if (isCuratedProxyHop) return;

    // An HTTP/SOCKS proxy may perform target DNS remotely, so local
    // Session.resolveHost cannot prove the endpoint the proxy will contact.
    // V0 therefore permits non-DIRECT routes only when the request root is one
    // of four exact, hardcoded HTTPS connector endpoints, then for HTTPS
    // same-site redirects already validated by the redirect loop. A custom URL
    // under the same publisher domain never inherits that trust.
    throw new Error(
      "Cette source personnalisée nécessite un proxy. Dans cette version, utilisez une connexion directe ou l’un des trois connecteurs optimisés.",
    );
  }

  async #assertHostnameResolvesPublic(inputUrl) {
    if (this.allowPrivateNetwork) return;
    if (!this.resolveHost) {
      if (this.requireHostResolution) {
        throw new Error("La résolution réseau sécurisée est indisponible.");
      }
      return;
    }

    const hostname = new URL(inputUrl).hostname.replace(/^\[|\]$/g, "");
    let resolved;
    try {
      // DNS preflight cannot eliminate the DNS-rebinding TOCTOU completely.
      // Production injects Session.resolveHost from the exact Chromium session
      // used by fetch; allowing that same session's cache and fetching
      // immediately afterwards minimizes the resolver/connection gap.
      resolved = await this.resolveHost(hostname, {
        cacheUsage: "allowed",
        source: "any",
        secureDnsPolicy: "allow",
      });
    } catch {
      throw new Error("Cette source ne peut pas être résolue de manière sûre.");
    }

    const endpoints = resolved?.endpoints;
    if (!Array.isArray(endpoints) || endpoints.length === 0) {
      throw new Error("Cette source ne renvoie aucune adresse réseau vérifiable.");
    }
    if (
      endpoints.some(
        (endpoint) =>
          typeof endpoint?.address !== "string" ||
          isNonPublicIpAddress(endpoint.address),
      )
    ) {
      throw new Error(
        "Cette source résout vers une adresse locale, privée ou réservée et a été bloquée.",
      );
    }
  }

  async #fetchFollowingSafeRedirects(endpoint, init) {
    let currentUrl = assertSafeFeedUrl(endpoint, {
      allowPrivateNetwork: this.allowPrivateNetwork,
    });
    const curatedRootUrl = CURATED_PROXY_ENDPOINTS.has(currentUrl)
      ? currentUrl
      : null;
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      await this.#assertProxyRouteSafe(currentUrl, {
        curatedRootUrl,
        isRedirect: redirectCount > 0,
      });
      await this.#assertHostnameResolvesPublic(currentUrl);
      if (init.signal?.aborted) throw new FetchCancelledError();
      const response = await this.fetchImpl(currentUrl, {
        ...init,
        redirect: "manual",
      });
      const observedUrl =
        typeof response.url === "string" && /^https?:\/\//i.test(response.url)
          ? response.url
          : currentUrl;

      // Custom fetch adapters can ignore `redirect: manual`. Validate their
      // observed destination, then fail closed: it was already contacted and
      // therefore could not receive the required preflight resolution.
      if (response.redirected === true || observedUrl !== currentUrl) {
        await discardResponseBody(response);
        assertSafeFeedUrl(observedUrl, {
          allowPrivateNetwork: this.allowPrivateNetwork,
          expectedSiteUrl: endpoint,
        });
        throw new Error(
          "Le téléchargeur a suivi une redirection sans contrôle préalable.",
        );
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        return { response, finalUrl: currentUrl };
      }
      await discardResponseBody(response);
      if (redirectCount === MAX_REDIRECTS) {
        throw new Error("Cette source effectue trop de redirections.");
      }
      const location = response.headers?.get?.("location");
      if (!location) throw new Error("La redirection de cette source est incomplète.");
      currentUrl = assertSafeFeedUrl(new URL(location, currentUrl).href, {
        allowPrivateNetwork: this.allowPrivateNetwork,
        expectedSiteUrl: endpoint,
      });
    }
    throw new Error("Cette source effectue trop de redirections.");
  }

  #subscribeToInflightRequest(entry, signal) {
    entry.subscribers += 1;
    return new Promise((resolve, reject) => {
      let active = true;
      const onAbort = () => finish(reject, new FetchCancelledError());
      const finish = (callback, value) => {
        if (!active) return;
        active = false;
        signal?.removeEventListener?.("abort", onAbort);
        entry.subscribers = Math.max(0, entry.subscribers - 1);
        if (entry.subscribers === 0 && !entry.settled) entry.controller.abort();
        callback(value);
      };

      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener?.("abort", onAbort, { once: true });
      entry.promise.then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error),
      );
    });
  }

  async fetchEndpoint(
    inputUrl,
    { force = false, ttlSeconds = DEFAULT_TTL_SECONDS, accept, signal } = {},
  ) {
    if (this.closed) throw new Error("Le moteur de veille est fermé.");
    if (signal?.aborted) throw new FetchCancelledError();
    const endpoint = assertSafeFeedUrl(inputUrl, {
      allowPrivateNetwork: this.allowPrivateNetwork,
    });
    const existingRequest = this.inflight.get(endpoint);
    if (existingRequest && !existingRequest.controller.signal.aborted) {
      return this.#subscribeToInflightRequest(existingRequest, signal);
    }
    if (existingRequest && this.inflight.get(endpoint) === existingRequest) {
      this.inflight.delete(endpoint);
    }

    const controller = new AbortController();
    this.abortControllers.add(controller);
    const entry = {
      controller,
      promise: null,
      settled: false,
      subscribers: 0,
    };
    const request = this.#fetchEndpoint(endpoint, {
      force,
      ttlSeconds,
      accept,
      signal: controller.signal,
    }).finally(() => {
      entry.settled = true;
      this.abortControllers.delete(controller);
      if (this.inflight.get(endpoint) === entry) this.inflight.delete(endpoint);
    });
    entry.promise = request;
    this.inflight.set(endpoint, entry);
    return this.#subscribeToInflightRequest(entry, signal);
  }

  async #fetchEndpoint(endpoint, { force, ttlSeconds, accept, signal }) {
    const cache = this.database.getEndpointCache(endpoint);
    const now = this.#nowDate();
    if (!force && cache && Date.parse(cache.expiresAt) > now.valueOf()) {
      return { ...cache, fromCache: true, stale: false };
    }

    const headers = {
      Accept:
        accept ??
        "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.2",
      "User-Agent": "VibeDeck/0.1 (local feed reader)",
    };
    if (cache?.etag) headers["If-None-Match"] = cache.etag;
    if (cache?.lastModified) headers["If-Modified-Since"] = cache.lastModified;

    let response;
    let finalUrl = endpoint;
    try {
      const fetched = await this.#fetchFollowingSafeRedirects(endpoint, {
        method: "GET",
        headers,
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      response = fetched.response;
      finalUrl = fetched.finalUrl;
    } catch (error) {
      if (this.closed || signal.aborted) throw new FetchCancelledError();
      if (cache) {
        return { ...cache, fromCache: true, stale: true, error: friendlyFetchError(error) };
      }
      throw new Error(`Impossible de joindre cette source : ${friendlyFetchError(error)}`);
    }
    if (this.closed || signal.aborted) throw new FetchCancelledError();

    const fetchedAt = now.toISOString();
    const { maxAge, noStore } = cachePolicy(response.headers, ttlSeconds);
    const expiresAt = new Date(now.valueOf() + maxAge * 1_000).toISOString();
    if (response.status === 304 && cache) {
      await discardResponseBody(response);
      if (noStore) this.database.deleteEndpointCache(endpoint);
      else this.database.touchEndpointCache(endpoint, { fetchedAt, expiresAt });
      return { ...cache, fetchedAt, expiresAt, fromCache: true, stale: false };
    }
    if (!response.ok) {
      await discardResponseBody(response);
      if (cache) {
        return {
          ...cache,
          fromCache: true,
          stale: true,
          error: `La source répond avec le statut ${response.status}.`,
        };
      }
      throw new Error(`La source répond avec le statut ${response.status}.`);
    }

    let body;
    try {
      body = await readResponseTextWithLimit(response, { signal });
    } catch (error) {
      if (this.closed || signal.aborted) throw new FetchCancelledError();
      throw error;
    }
    if (this.closed || signal.aborted) throw new FetchCancelledError();

    const entry = {
      endpoint,
      finalUrl,
      body,
      contentType: response.headers?.get?.("content-type") ?? null,
      etag: response.headers?.get?.("etag") ?? null,
      lastModified: response.headers?.get?.("last-modified") ?? null,
      fetchedAt,
      expiresAt,
      statusCode: response.status,
    };
    if (noStore) this.database.deleteEndpointCache(endpoint);
    else this.database.putEndpointCache(entry);
    return { ...entry, fromCache: false, stale: false };
  }

  async #resolveSource(inputUrl, expectedKind = "auto", { signal = null } = {}) {
    if (signal?.aborted) throw new FetchCancelledError();
    const known = matchKnownPublication(inputUrl);
    if (known) {
      const response = await this.fetchEndpoint(known.feedUrl, {
        ttlSeconds: known.refreshIntervalSeconds,
        accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.1",
        signal,
      });
      const parsed = await this.#enrichSpecializedSource(
        known.feedUrl,
        parseFeedDocument(response.body, response.finalUrl ?? known.feedUrl),
        { signal },
      );
      assertConnectorKind(expectedKind, parsed.kind);
      return {
        inputUrl: known.inputUrl,
        feedUrl: known.feedUrl,
        connectorId: known.id,
        name: known.name,
        connectorKind: parsed.kind,
        refreshIntervalSeconds: known.refreshIntervalSeconds,
        parsed,
        response,
      };
    }

    const normalizedUrl = normalizeInputUrl(inputUrl);
    const firstResponse = await this.fetchEndpoint(normalizedUrl, {
      ttlSeconds: 300,
      signal,
    });
    let directFeed = null;
    if (!responseLooksLikeHtml(firstResponse)) {
      try {
        directFeed = parseFeedDocument(
          firstResponse.body,
          firstResponse.finalUrl ?? normalizedUrl,
        );
      } catch (error) {
        if (
          error instanceof FeedCardinalityError ||
          error instanceof FeedSafetyError
        ) {
          throw error;
        }
        // An ordinary webpage is expected here; feed discovery below gives the
        // user a clearer error than leaking the XML parser failure.
      }
    }
    if (directFeed) {
      assertConnectorKind(expectedKind, directFeed.kind);
      return {
        inputUrl: normalizedUrl,
        feedUrl: normalizedUrl,
        connectorId: connectorIdForFeedUrl(normalizedUrl),
        name: directFeed.title ?? sourceNameFromUrl(normalizedUrl),
        connectorKind: directFeed.kind,
        refreshIntervalSeconds: directFeed.kind === "news-sitemap" ? 90 : 300,
        parsed: directFeed,
        response: firstResponse,
      };
    }

    const candidates = discoverFeedsInHtml(
      firstResponse.body,
      firstResponse.finalUrl ?? normalizedUrl,
      MAX_DISCOVERED_FEEDS,
    );
    if (candidates.length === 0) {
      throw new Error("Ce site ne déclare aucun flux RSS ou Atom. Un connecteur dédié sera nécessaire.");
    }

    const attemptControllers = candidates.map(() => new AbortController());
    try {
      const resolved = await Promise.any(
        candidates.map(async (candidate, index) => {
          try {
            if (!feedUrlsShareSite(firstResponse.finalUrl ?? normalizedUrl, candidate.url)) {
              throw new Error(
                "Le flux annoncé utilise un autre domaine. Ajoutez directement son URL pour l’autoriser.",
              );
            }
            const response = await this.fetchEndpoint(candidate.url, {
              ttlSeconds: 300,
              signal: signal
                ? AbortSignal.any([signal, attemptControllers[index].signal])
                : attemptControllers[index].signal,
            });
            const parsed = parseFeedDocument(response.body, response.finalUrl ?? candidate.url);
            assertConnectorKind(expectedKind, parsed.kind);
            return { candidate, parsed, response };
          } catch (error) {
            if (
              !(error instanceof ConnectorKindMismatchError) &&
              !isFetchCancelled(error)
            ) {
              this.database.deleteEndpointCache(candidate.url);
            }
            throw error;
          }
        }),
      );
      const { candidate, parsed, response } = resolved;
      return {
        inputUrl: normalizedUrl,
        feedUrl: candidate.url,
        connectorId: connectorIdForFeedUrl(candidate.url),
        name: parsed.title ?? candidate.title ?? sourceNameFromUrl(normalizedUrl),
        connectorKind: parsed.kind,
        refreshIntervalSeconds: parsed.kind === "news-sitemap" ? 90 : 300,
        parsed,
        response,
      };
    } catch (error) {
      if (signal?.aborted) throw new FetchCancelledError();
      const failures = error instanceof AggregateError ? error.errors : [error];
      const lastError = failures.findLast(Boolean);
      throw new Error(`Le flux annoncé par ce site est illisible : ${friendlyFetchError(lastError)}`);
    } finally {
      for (const controller of attemptControllers) controller.abort();
    }
  }

  async #enrichSpecializedSource(feedUrl, parsed, { signal = null } = {}) {
    if (feedUrl !== LE_PARISIEN_FEED_URL) return parsed;
    try {
      const response = await this.fetchEndpoint(LE_PARISIEN_NEWS_SITEMAP_URL, {
        ttlSeconds: 120,
        accept: "application/xml, text/xml;q=0.9, */*;q=0.1",
        signal,
      });
      const sitemap = parseFeedDocument(
        response.body,
        response.finalUrl ?? LE_PARISIEN_NEWS_SITEMAP_URL,
      );
      if (sitemap.kind !== "news-sitemap") return parsed;
      return {
        ...parsed,
        items: enrichItemsFromNewsSitemap(parsed.items, sitemap.items),
      };
    } catch (error) {
      if (isFetchCancelled(error)) throw error;
      // Best-effort metadata only. A missing or protected sitemap must never
      // make the official RSS source appear broken to the journalist.
      return parsed;
    }
  }

  #materializeItems(sourceId, parsedItems, seenAt) {
    return parsedItems.map((item) => ({
      id: stableItemId(sourceId, item.canonicalUrl),
      sourceId,
      ...item,
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
    }));
  }

  async addSource(panelId, input) {
    return this.#runStandaloneFeedConfigurationMutation(() =>
      this.#addSource(panelId, input));
  }

  async #addSource(panelId, input) {
    if (!this.database.hasPanel(panelId, "feed")) throw new Error("Panel de flux introuvable.");
    const request = normalizeSourceRequest(input);
    const normalizedInput = normalizeInputUrl(request.url);
    const refreshIntervalSeconds =
      request.refreshIntervalSeconds ?? this.database.getFeedPanelDefaultRefresh(panelId);
    const known = matchKnownPublication(normalizedInput);
    let existing = known
      ? this.database.findSourceByFeedUrl(known.feedUrl)
      : this.database.findSourceByInputOrFeedUrl(normalizedInput);
    // A homepage can legitimately advertise both RSS and Atom. If an existing
    // source only matches that homepage (not the pasted feed URL) and the user
    // explicitly asks for the other kind, resolve the page again so the second
    // connector can coexist and share its own feed cache.
    if (
      existing &&
      !known &&
      request.connectorKind !== "auto" &&
      existing.connectorKind !== request.connectorKind &&
      existing.feedUrl !== normalizedInput
    ) {
      existing = null;
    }
    if (existing) {
      assertConnectorKind(request.connectorKind, existing.connectorKind);
      if (known && existing.connectorId !== known.id) {
        this.database.setSourceConnectorId(existing.id, known.id, this.#nowIso());
      }
      if (refreshIntervalSeconds < existing.refreshIntervalSeconds) {
        this.database.setSourceRefreshInterval(
          existing.id,
          refreshIntervalSeconds,
          this.#nowIso(),
        );
      }
      this.database.attachSource(panelId, existing.id);
      return { sourceId: existing.id, state: this.getState() };
    }

    const resolved = await this.#resolveSource(normalizedInput, request.connectorKind);
    assertConnectorKind(request.connectorKind, resolved.connectorKind);
    const seenAt = this.#nowIso();
    const sourceId = this.database.putSource(
      {
        name: resolved.name,
        inputUrl: resolved.inputUrl,
        feedUrl: resolved.feedUrl,
        connectorId: resolved.connectorId,
        connectorKind: resolved.connectorKind,
        refreshIntervalSeconds,
        status: resolved.response.stale ? "error" : "healthy",
        lastCheckedAt: seenAt,
        lastSuccessAt: resolved.response.stale ? null : seenAt,
        errorMessage: resolved.response.stale ? resolved.response.error : null,
      },
      seenAt,
    );
    this.database.attachSource(panelId, sourceId);
    this.database.upsertItems(
      sourceId,
      this.#materializeItems(sourceId, resolved.parsed.items, seenAt),
      seenAt,
    );
    this.database.setSourceStatus(
      sourceId,
      resolved.response.stale ? "error" : "healthy",
      {
        lastCheckedAt: seenAt,
        lastSuccessAt: resolved.response.stale ? null : seenAt,
        errorMessage: resolved.response.stale ? resolved.response.error : null,
        ...(resolved.response.stale
          ? failureRetryState({ refreshIntervalSeconds, consecutiveFailures: 0 }, seenAt)
          : { consecutiveFailures: 0, nextRetryAt: null }),
      },
      seenAt,
    );
    return { sourceId, state: this.getState() };
  }

  async addCatalogSource(panelId, catalogId, options = {}) {
    return this.#runStandaloneFeedConfigurationMutation(() =>
      this.#addCatalogSource(panelId, catalogId, options));
  }

  async #addCatalogSource(panelId, catalogId, options = {}) {
    if (typeof catalogId !== "string" || !catalogId.trim()) {
      throw new TypeError("Source du catalogue invalide.");
    }
    const publication = KNOWN_PUBLICATIONS.find(({ id }) => id === catalogId.trim());
    if (!publication) throw new Error("Cette source n’existe pas dans le catalogue.");
    return this.#addSource(panelId, {
      url: publication.homepageUrl,
      connectorKind: publication.connectorKind,
      refreshIntervalSeconds: options?.refreshIntervalSeconds,
    });
  }

  async #refreshOne(
    sourceId,
    { respectBackoff = true, arrivalBatchAt = null } = {},
  ) {
    if (this.closed) throw new RefreshCancelledError("Le moteur de veille est fermé.");
    const source = this.database.getSource(sourceId);
    if (!source) throw new Error("Source introuvable.");
    const startedAt = this.#nowIso();
    const batchAt = arrivalBatchAt ?? startedAt;
    if (
      respectBackoff &&
      source.nextRetryAt &&
      Date.parse(source.nextRetryAt) > Date.parse(startedAt)
    ) {
      return { skipped: true, nextRetryAt: source.nextRetryAt };
    }
    this.database.setSourceStatus(sourceId, "refreshing", {}, startedAt);
    try {
      const response = await this.fetchEndpoint(source.feedUrl, {
        force: true,
        ttlSeconds: source.refreshIntervalSeconds,
      });
      if (this.closed) throw new RefreshCancelledError("Le moteur de veille est fermé.");
      const parsed = await this.#enrichSpecializedSource(
        source.feedUrl,
        parseFeedDocument(response.body, response.finalUrl ?? source.feedUrl),
      );
      if (this.closed) throw new RefreshCancelledError("Le moteur de veille est fermé.");
      const seenAt = this.#nowIso();
      const persistence = this.database.upsertItems(
        sourceId,
        this.#materializeItems(sourceId, parsed.items, seenAt),
        seenAt,
        batchAt,
      );
      this.database.setSourceStatus(
        sourceId,
        response.stale ? "error" : "healthy",
        {
          lastCheckedAt: seenAt,
          lastSuccessAt: response.stale ? null : seenAt,
          errorMessage: response.stale ? response.error : null,
          ...(response.stale
            ? failureRetryState(source, seenAt)
            : { consecutiveFailures: 0, nextRetryAt: null }),
        },
        seenAt,
      );
      this.database.recordPilotEvent(
        response.stale ? "source_refresh_stale" : "source_refresh_succeeded",
        { sourceId, count: persistence.insertedCount },
        seenAt,
      );
    } catch (error) {
      if (this.closed) throw new RefreshCancelledError("Le moteur de veille est fermé.");
      if (isFetchCancelled(error)) {
        const restoredStatus = source.status === "refreshing" ? "idle" : source.status;
        this.database.setSourceStatus(
          sourceId,
          restoredStatus,
          { errorMessage: source.errorMessage },
          this.#nowIso(),
        );
        return;
      }
      const failedAt = this.#nowIso();
      const retryState = failureRetryState(source, failedAt);
      this.database.setSourceStatus(
        sourceId,
        "error",
        {
          lastCheckedAt: failedAt,
          errorMessage: friendlyFetchError(error),
          ...retryState,
        },
        failedAt,
      );
      this.database.recordPilotEvent(
        "source_refresh_failed",
        { sourceId, detailCode: "fetch_or_parse" },
        failedAt,
      );
    }
  }

  refreshSource(sourceId, { force = false, arrivalBatchAt = null } = {}) {
    return this.#enqueueRefresh(sourceId, { force, arrivalBatchAt });
  }

  async #refreshBatch(
    sourceIds,
    { force = false, arrivalBatchAt = null } = {},
  ) {
    if (this.closed) throw new RefreshCancelledError("Le moteur de veille est fermé.");
    const batchAt = arrivalBatchAt ?? this.createArrivalBatchAt();
    await Promise.all(
      sourceIds.map((sourceId) =>
        this.#enqueueRefresh(sourceId, {
          force,
          arrivalBatchAt: batchAt,
          projectState: false,
        })),
    );
    if (this.closed) throw new RefreshCancelledError("Le moteur de veille est fermé.");
    return this.getState();
  }

  refreshPanel(panelId, { force = false } = {}) {
    const sourceIds = this.database.listPanelSourceIds(panelId);
    if (sourceIds.some((sourceId) => this.refreshTasks.has(sourceId))) {
      return Promise.reject(new Error("Une actualisation de ce panel est déjà en cours."));
    }
    return this.#refreshBatch(sourceIds, { force });
  }

  refreshSources(sourceIds, { arrivalBatchAt = null } = {}) {
    const activeBatches = new Set(
      sourceIds
        .map((sourceId) => this.refreshTasks.get(sourceId)?.arrivalBatchAt)
        .filter(Boolean),
    );
    if (activeBatches.size > 1) {
      return Promise.reject(
        new Error("Plusieurs cycles d’actualisation sont déjà en cours."),
      );
    }
    return this.#refreshBatch(sourceIds, {
      arrivalBatchAt:
        activeBatches.values().next().value ?? arrivalBatchAt,
    });
  }

  refreshAll() {
    const sourceIds = this.database.listSources({ attachedOnly: true }).map(({ id }) => id);
    return this.refreshSources(sourceIds);
  }
}

export function createFeedEngine(options) {
  return new FeedEngine(options);
}
