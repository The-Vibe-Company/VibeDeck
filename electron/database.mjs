import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const MAX_PANEL_NAME_LENGTH = 80;
const MAX_SOURCE_NAME_LENGTH = 120;
export const MAX_ITEMS_PER_SOURCE = 2_000;
export const MAX_FEED_PAGE_SIZE = 200;
export const MAX_HTTP_URL_LENGTH = 4_096;
const MAX_LAYOUT_DEPTH = 32;
const MAX_LAYOUT_NODES = 1_023;
const MAX_LAYOUT_BYTES = 128 * 1_024;
const MAX_LAYOUT_GRID_SPAN = 3;
const MAX_ENDPOINT_CACHE_ENTRIES = 512;
const MAX_ENDPOINT_CACHE_BYTES = 128 * 1_024 * 1_024;
const ENDPOINT_CACHE_TRIM_BYTES = 112 * 1_024 * 1_024;
const MAX_PILOT_EVENTS = 5_000;
const MAX_PILOT_SESSIONS = 1_000;
const MAX_PILOT_USAGE_DAYS = 400;
const MAX_HEARTBEAT_DELTA_MS = 2 * 60 * 1_000;
const MAX_MARKED_ITEMS = 500;
const MAX_CONFIGURATION_BYTES = 512 * 1_024;
const MAX_CONFIGURATION_PANELS = 64;
const MAX_CONFIGURATION_SOURCES = 256;
const MAX_CONFIGURATION_WEB_PANELS = 6;
export const MAX_DASHBOARD_TABS = 9;
const MAX_FEED_CONFIGURATION_CHECKPOINT_SOURCES = 4_096;
export const MAX_FEED_PAGE_OFFSET =
  MAX_FEED_CONFIGURATION_CHECKPOINT_SOURCES * MAX_ITEMS_PER_SOURCE;
const MIN_SPLIT_RATIO = 0.1;
const MAX_SPLIT_RATIO = 0.9;
const MIN_REFRESH_INTERVAL_SECONDS = 30;
const MAX_REFRESH_INTERVAL_SECONDS = 3_600;
const DEFAULT_REFRESH_INTERVAL_SECONDS = 60;
const SCHEMA_VERSION = 9;
const CONFIGURATION_FORMAT = "vibedeck-dashboard";
const CONFIGURATION_VERSION = 2;
const LEGACY_CONFIGURATION_VERSION = 1;

const LEGACY_CONNECTOR_BACKFILLS = Object.freeze([
  ["le-monde", "https://www.lemonde.fr/rss/en_continu.xml"],
  ["le-figaro", "https://www.lefigaro.fr/rss/figaro_flash-actu.xml"],
  ["le-parisien", "https://feeds.leparisien.fr/leparisien/rss"],
]);

function cleanPanelName(name) {
  if (typeof name !== "string" || !name.trim()) {
    throw new TypeError("Le nom du panel ne peut pas être vide.");
  }
  return name.trim().slice(0, MAX_PANEL_NAME_LENGTH);
}

function cleanTabName(name) {
  return cleanPanelName(name);
}

function cleanSourceName(name) {
  if (typeof name !== "string" || !name.trim()) {
    throw new TypeError("Le nom de la source ne peut pas être vide.");
  }
  const normalized = name.trim();
  if (normalized.length > MAX_SOURCE_NAME_LENGTH) {
    throw new RangeError("Le nom de la source est trop long.");
  }
  return normalized;
}

function cleanRefreshInterval(value, fallback = DEFAULT_REFRESH_INTERVAL_SECONDS) {
  const seconds = value ?? fallback;
  if (
    !Number.isInteger(seconds) ||
    seconds < MIN_REFRESH_INTERVAL_SECONDS ||
    seconds > MAX_REFRESH_INTERVAL_SECONDS
  ) {
    throw new RangeError("La fréquence doit être comprise entre 30 secondes et 60 minutes.");
  }
  return seconds;
}

function normalizeFeedPanelConfigurationCheckpoint(checkpoint) {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
    throw new TypeError("Point de restauration du fil invalide.");
  }
  if (
    !Array.isArray(checkpoint.sourceIds) ||
    checkpoint.sourceIds.length > MAX_FEED_CONFIGURATION_CHECKPOINT_SOURCES ||
    !Array.isArray(checkpoint.sourceConfigurations) ||
    checkpoint.sourceConfigurations.length > MAX_FEED_CONFIGURATION_CHECKPOINT_SOURCES
  ) {
    throw new RangeError("Point de restauration du fil trop volumineux.");
  }
  const sourceIds = checkpoint.sourceIds.map((sourceId) =>
    cleanIdentifier(sourceId, "Source"));
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new Error("Une source ne peut apparaître qu’une fois dans le fil restauré.");
  }
  const seenConfigurationSourceIds = new Set();
  const sourceConfigurations = checkpoint.sourceConfigurations.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError("Configuration de source sauvegardée invalide.");
    }
    const sourceId = cleanIdentifier(entry.sourceId, "Source");
    if (seenConfigurationSourceIds.has(sourceId)) {
      throw new Error("Configuration de source sauvegardée en double.");
    }
    seenConfigurationSourceIds.add(sourceId);
    return {
      sourceId,
      name: cleanSourceName(entry.name),
      inputUrl: cleanHttpUrl(entry.inputUrl),
      feedUrl: cleanHttpUrl(entry.feedUrl),
      connectorId: cleanOptionalConnectorId(entry.connectorId),
      connectorKind: cleanConnectorKind(entry.connectorKind),
      refreshIntervalSeconds: cleanRefreshInterval(entry.refreshIntervalSeconds),
      updatedAt: cleanTimestamp(entry.updatedAt, "Date de source sauvegardée"),
    };
  });
  return {
    name: cleanPanelName(checkpoint.name),
    defaultRefreshIntervalSeconds: cleanRefreshInterval(
      checkpoint.defaultRefreshIntervalSeconds,
    ),
    updatedAt: cleanTimestamp(checkpoint.updatedAt, "Date de panel sauvegardée"),
    sourceIds,
    sourceConfigurations,
  };
}

function cleanHttpUrl(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > MAX_HTTP_URL_LENGTH
  ) {
    throw new TypeError("URL invalide.");
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new TypeError("Cette URL n’est pas valide.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new TypeError("Seules les URLs web http et https sont acceptées.");
  }
  if (url.href.length > MAX_HTTP_URL_LENGTH) throw new TypeError("URL invalide.");
  return url.href;
}

function normalizePanelInput(input) {
  if (typeof input === "string") {
    return {
      kind: "feed",
      name: cleanPanelName(input),
      webUrl: null,
      defaultRefreshIntervalSeconds: DEFAULT_REFRESH_INTERVAL_SECONDS,
    };
  }
  if (!input || typeof input !== "object") {
    throw new TypeError("Configuration de panel invalide.");
  }
  if (input.kind === "feed") {
    return {
      kind: "feed",
      name: cleanPanelName(input.name),
      webUrl: null,
      defaultRefreshIntervalSeconds: cleanRefreshInterval(
        input.defaultRefreshIntervalSeconds,
      ),
    };
  }
  if (input.kind === "web") {
    return {
      kind: "web",
      name: cleanPanelName(input.name),
      webUrl: cleanHttpUrl(input.url),
      defaultRefreshIntervalSeconds: DEFAULT_REFRESH_INTERVAL_SECONDS,
    };
  }
  throw new TypeError("Type de panel invalide.");
}

function nullable(value) {
  return value ?? null;
}

function cleanIdentifier(value, label = "Identifiant") {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)
  ) {
    throw new TypeError(`${label} invalide.`);
  }
  return value.trim();
}

function cleanConnectorKind(value) {
  if (!["rss", "atom", "news-sitemap"].includes(value)) {
    throw new TypeError("Type de connecteur invalide.");
  }
  return value;
}

function cleanOptionalConnectorId(value) {
  return value == null ? null : cleanIdentifier(value, "Identifiant de connecteur");
}

function normalizeItemIds(itemIds) {
  if (!Array.isArray(itemIds)) throw new TypeError("Liste d’articles invalide.");
  const normalized = [...new Set(itemIds.map((id) => cleanIdentifier(id, "Article")))];
  if (normalized.length > MAX_MARKED_ITEMS) {
    throw new RangeError(`Au maximum ${MAX_MARKED_ITEMS} articles peuvent être marqués à la fois.`);
  }
  return normalized;
}

function cleanTimestamp(value, label = "Date") {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${label} invalide.`);
  }
  return new Date(value).toISOString();
}

function cleanOptionalEventIdentifier(value, label) {
  return value == null ? null : cleanIdentifier(value, label);
}

function cleanOptionalNonNegativeInteger(value, label) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} invalide.`);
  }
  return value;
}

function monotonicTimestamp(previousAt, candidateAt) {
  return Date.parse(candidateAt) >= Date.parse(previousAt) ? candidateAt : previousAt;
}

const usageDateFormatters = new Map();

function cleanUsageTimeZone(value) {
  const timeZone = value ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  if (typeof timeZone !== "string" || !timeZone.trim() || timeZone.length > 128) {
    throw new TypeError("Fuseau horaire des métriques invalide.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
  } catch {
    throw new TypeError("Fuseau horaire des métriques invalide.");
  }
  return timeZone;
}

function usageDateFormatter(timeZone) {
  let formatter = usageDateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    usageDateFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function localUsageDate(timestamp, timeZone) {
  const parts = Object.fromEntries(
    usageDateFormatter(timeZone)
      .formatToParts(new Date(timestamp))
      .filter(({ type }) => type === "year" || type === "month" || type === "day")
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * Split the capped active interval [previousAt, currentAt) into system-local
 * calendar days. Looking for the first millisecond whose formatted date changes
 * makes the boundary exact even when a time zone changes offset at midnight.
 */
export function splitActiveUsageByLocalDay(
  previousAt,
  currentAt,
  { active = true, timeZone = null } = {},
) {
  if (!active) return [];
  const normalizedTimeZone = cleanUsageTimeZone(timeZone);
  const start = Date.parse(previousAt);
  const candidateEnd = Date.parse(currentAt);
  if (!Number.isFinite(start) || !Number.isFinite(candidateEnd) || candidateEnd <= start) {
    return [];
  }
  const end = Math.min(candidateEnd, start + MAX_HEARTBEAT_DELTA_MS);
  const segments = [];
  let cursor = start;
  while (cursor < end) {
    const date = localUsageDate(cursor, normalizedTimeZone);
    if (localUsageDate(end - 1, normalizedTimeZone) === date) {
      segments.push({ date, durationMs: end - cursor });
      break;
    }

    let low = cursor + 1;
    let high = end;
    while (low < high) {
      const midpoint = low + Math.floor((high - low) / 2);
      if (localUsageDate(midpoint, normalizedTimeZone) === date) low = midpoint + 1;
      else high = midpoint;
    }
    segments.push({ date, durationMs: low - cursor });
    cursor = low;
  }
  return segments;
}

function normalizeConfiguration(input) {
  let configuration = input;
  if (typeof input === "string") {
    if (Buffer.byteLength(input, "utf8") > MAX_CONFIGURATION_BYTES) {
      throw new RangeError("La configuration est trop volumineuse.");
    }
    try {
      configuration = JSON.parse(input);
    } catch {
      throw new TypeError("Le fichier de configuration n’est pas un JSON valide.");
    }
  }
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    throw new TypeError("Configuration de dashboard invalide.");
  }
  if (Buffer.byteLength(JSON.stringify(configuration), "utf8") > MAX_CONFIGURATION_BYTES) {
    throw new RangeError("La configuration est trop volumineuse.");
  }
  if (
    configuration.format !== CONFIGURATION_FORMAT ||
    ![LEGACY_CONFIGURATION_VERSION, CONFIGURATION_VERSION].includes(configuration.version)
  ) {
    throw new TypeError("Format de configuration non pris en charge.");
  }
  for (const forbiddenKey of ["items", "articles", "cookies", "cache", "endpointCache"]) {
    if (Object.hasOwn(configuration, forbiddenKey)) {
      throw new TypeError(`La configuration ne peut pas contenir « ${forbiddenKey} ».`);
    }
  }
  if (!Array.isArray(configuration.panels) || !Array.isArray(configuration.sources)) {
    throw new TypeError("La configuration doit contenir des panels et des sources.");
  }
  if (configuration.panels.length > MAX_CONFIGURATION_PANELS) {
    throw new RangeError("La configuration contient trop de panels.");
  }
  if (configuration.sources.length > MAX_CONFIGURATION_SOURCES) {
    throw new RangeError("La configuration contient trop de sources.");
  }

  const sourceIds = new Set();
  const sourceFeedUrls = new Set();
  const sources = configuration.sources.map((source) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new TypeError("Source importée invalide.");
    }
    const id = cleanIdentifier(source.id, "Identifiant de source");
    if (sourceIds.has(id)) throw new Error("Identifiant de source dupliqué.");
    sourceIds.add(id);
    const normalizedSource = {
      id,
      name: cleanPanelName(source.name),
      inputUrl: cleanHttpUrl(source.inputUrl),
      feedUrl: cleanHttpUrl(source.feedUrl),
      connectorId: cleanOptionalConnectorId(source.connectorId),
      connectorKind: cleanConnectorKind(source.connectorKind),
      refreshIntervalSeconds: cleanRefreshInterval(source.refreshIntervalSeconds),
    };
    if (sourceFeedUrls.has(normalizedSource.feedUrl)) {
      throw new Error("URL de flux dupliquée dans la configuration.");
    }
    sourceFeedUrls.add(normalizedSource.feedUrl);
    return normalizedSource;
  });

  const panelIds = new Set();
  const referencedSourceIds = new Set();
  const panels = configuration.panels.map((panel) => {
    if (!panel || typeof panel !== "object" || Array.isArray(panel)) {
      throw new TypeError("Panel importé invalide.");
    }
    const id = cleanIdentifier(panel.id, "Identifiant de panel");
    if (panelIds.has(id)) throw new Error("Identifiant de panel dupliqué.");
    panelIds.add(id);
    const normalized = normalizePanelInput(panel);
    if (normalized.kind === "web") {
      return { id, ...normalized, sourceIds: [] };
    }
    if (!Array.isArray(panel.sourceIds)) {
      throw new TypeError("Liste de sources du panel invalide.");
    }
    const panelSourceIds = panel.sourceIds.map((sourceId) =>
      cleanIdentifier(sourceId, "Identifiant de source"),
    );
    if (new Set(panelSourceIds).size !== panelSourceIds.length) {
      throw new Error("Une source ne peut apparaître qu’une fois dans un panel.");
    }
    for (const sourceId of panelSourceIds) {
      if (!sourceIds.has(sourceId)) throw new Error("Le panel référence une source inconnue.");
      referencedSourceIds.add(sourceId);
    }
    return { id, ...normalized, sourceIds: panelSourceIds };
  });
  if (referencedSourceIds.size !== sourceIds.size) {
    throw new Error("Chaque source importée doit être rattachée à au moins un panel.");
  }

  const rawTabs = configuration.version === LEGACY_CONFIGURATION_VERSION
    ? [{ id: randomUUID(), name: "Onglet 1", layout: configuration.layout ?? null }]
    : configuration.tabs;
  if (configuration.version === CONFIGURATION_VERSION && !Array.isArray(rawTabs)) {
    throw new TypeError("La configuration doit contenir ses onglets.");
  }
  const dashboard = validateDashboardTabs(rawTabs, [...panelIds], {
    activeTabId: configuration.version === LEGACY_CONFIGURATION_VERSION
      ? rawTabs[0].id
      : configuration.activeTabId,
    webPanelIds: panels.filter(({ kind }) => kind === "web").map(({ id }) => id),
  });
  return { panels, sources, ...dashboard };
}

function clampRatio(value) {
  return Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, value));
}

function buildInitialLayout(panelIds, depth = 0) {
  if (panelIds.length === 0) return null;
  if (panelIds.length === 1) return { type: "panel", panelId: panelIds[0] };

  const midpoint = Math.ceil(panelIds.length / 2);
  return {
    type: "split",
    id: randomUUID(),
    direction: depth % 2 === 0 ? "row" : "column",
    ratio: clampRatio(midpoint / panelIds.length),
    children: [
      buildInitialLayout(panelIds.slice(0, midpoint), depth + 1),
      buildInitialLayout(panelIds.slice(midpoint), depth + 1),
    ],
  };
}

function insertPanelIntoLayout(layout, targetPanelId, newPanelId, side) {
  if (layout.type === "panel") {
    if (layout.panelId !== targetPanelId) return { layout, found: false };
    const newLeaf = { type: "panel", panelId: newPanelId };
    const newFirst = side === "left" || side === "top";
    return {
      found: true,
      layout: {
        type: "split",
        id: randomUUID(),
        direction: side === "left" || side === "right" ? "row" : "column",
        ratio: 0.5,
        children: newFirst ? [newLeaf, layout] : [layout, newLeaf],
      },
    };
  }

  const first = insertPanelIntoLayout(layout.children[0], targetPanelId, newPanelId, side);
  if (first.found) {
    return { found: true, layout: { ...layout, children: [first.layout, layout.children[1]] } };
  }
  const second = insertPanelIntoLayout(layout.children[1], targetPanelId, newPanelId, side);
  if (second.found) {
    return { found: true, layout: { ...layout, children: [layout.children[0], second.layout] } };
  }
  return { layout, found: false };
}

function removePanelFromLayout(layout, panelId) {
  if (!layout) return null;
  if (layout.type === "panel") return layout.panelId === panelId ? null : layout;

  const first = removePanelFromLayout(layout.children[0], panelId);
  const second = removePanelFromLayout(layout.children[1], panelId);
  if (!first) return second;
  if (!second) return first;
  return { ...layout, children: [first, second] };
}

/**
 * Treat renderer-provided layout data as untrusted. The returned tree is a
 * normalized clone and every persisted panel must occur exactly once.
 */
export function validateDashboardLayout(layout, panelIds, { requireAll = true } = {}) {
  const knownPanelIds = new Set(panelIds);
  if (knownPanelIds.size !== panelIds.length) throw new Error("Liste de panels invalide.");
  if (knownPanelIds.size === 0) {
    if (layout !== null) throw new Error("Un dashboard vide ne peut pas contenir de layout.");
    return null;
  }
  if (layout === null && !requireAll) return null;
  if (!layout || typeof layout !== "object") {
    throw new Error("Le layout doit contenir tous les panels.");
  }

  const seenPanelIds = new Set();
  const seenSplitIds = new Set();
  let nodeCount = 0;

  const visit = (node, depth) => {
    nodeCount += 1;
    if (depth > MAX_LAYOUT_DEPTH || nodeCount > MAX_LAYOUT_NODES) {
      throw new Error("Le layout est trop complexe.");
    }
    if (!node || typeof node !== "object") throw new Error("Nœud de layout invalide.");

    if (node.type === "panel") {
      if (typeof node.panelId !== "string" || !knownPanelIds.has(node.panelId)) {
        throw new Error("Le layout référence un panel inconnu.");
      }
      if (seenPanelIds.has(node.panelId)) {
        throw new Error("Un panel ne peut apparaître qu’une fois dans le layout.");
      }
      seenPanelIds.add(node.panelId);
      return { type: "panel", panelId: node.panelId };
    }

    if (node.type !== "split") throw new Error("Type de nœud de layout invalide.");
    if (typeof node.id !== "string" || !node.id.trim() || node.id.length > 128) {
      throw new Error("Identifiant de séparation invalide.");
    }
    if (seenSplitIds.has(node.id)) throw new Error("Identifiant de séparation dupliqué.");
    seenSplitIds.add(node.id);
    if (node.direction !== "row" && node.direction !== "column") {
      throw new Error("Direction de séparation invalide.");
    }
    if (
      typeof node.ratio !== "number" ||
      !Number.isFinite(node.ratio) ||
      node.ratio < MIN_SPLIT_RATIO ||
      node.ratio > MAX_SPLIT_RATIO
    ) {
      throw new Error("Ratio de séparation invalide.");
    }
    if (!Array.isArray(node.children) || node.children.length !== 2) {
      throw new Error("Une séparation doit contenir exactement deux zones.");
    }
    return {
      type: "split",
      id: node.id.trim(),
      direction: node.direction,
      ratio: node.ratio,
      children: [visit(node.children[0], depth + 1), visit(node.children[1], depth + 1)],
    };
  };

  const normalized = visit(layout, 0);
  if (requireAll && seenPanelIds.size !== knownPanelIds.size) {
    throw new Error("Le layout doit contenir chaque panel exactement une fois.");
  }
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_LAYOUT_BYTES) {
    throw new Error("Le layout est trop volumineux.");
  }
  return normalized;
}

function panelIdsInLayout(layout) {
  if (!layout) return [];
  if (layout.type === "panel") return [layout.panelId];
  return [
    ...panelIdsInLayout(layout.children[0]),
    ...panelIdsInLayout(layout.children[1]),
  ];
}

export function validateDashboardTabs(
  tabs,
  panelIds,
  { activeTabId = null, webPanelIds = [] } = {},
) {
  if (!Array.isArray(tabs) || tabs.length < 1 || tabs.length > MAX_DASHBOARD_TABS) {
    throw new RangeError(`Le dashboard doit contenir entre 1 et ${MAX_DASHBOARD_TABS} onglets.`);
  }
  const knownPanelIds = new Set(panelIds);
  if (knownPanelIds.size !== panelIds.length) throw new Error("Liste de panels invalide.");
  const knownWebPanelIds = new Set(webPanelIds);
  const seenTabIds = new Set();
  const seenPanelIds = new Set();
  const normalized = tabs.map((tab) => {
    if (!tab || typeof tab !== "object" || Array.isArray(tab)) {
      throw new TypeError("Onglet de dashboard invalide.");
    }
    const id = cleanIdentifier(tab.id, "Identifiant d’onglet");
    if (seenTabIds.has(id)) throw new Error("Identifiant d’onglet dupliqué.");
    seenTabIds.add(id);
    const layout = assertPracticalDashboardLayout(
      validateDashboardLayout(tab.layout ?? null, panelIds, { requireAll: false }),
    );
    const tabPanelIds = panelIdsInLayout(layout);
    let webPanelCount = 0;
    for (const panelId of tabPanelIds) {
      if (seenPanelIds.has(panelId)) {
        throw new Error("Un panel ne peut apparaître que dans un seul onglet.");
      }
      seenPanelIds.add(panelId);
      if (knownWebPanelIds.has(panelId)) webPanelCount += 1;
    }
    if (webPanelCount > MAX_CONFIGURATION_WEB_PANELS) {
      throw new RangeError(
        `Un onglet ne peut pas contenir plus de ${MAX_CONFIGURATION_WEB_PANELS} pages web.`,
      );
    }
    return { id, name: cleanTabName(tab.name), layout };
  });
  if (seenPanelIds.size !== knownPanelIds.size) {
    throw new Error("Chaque panel doit apparaître exactement une fois dans les onglets.");
  }
  const selectedId = activeTabId ?? normalized[0].id;
  if (typeof selectedId !== "string" || !seenTabIds.has(selectedId)) {
    throw new Error("L’onglet actif est introuvable.");
  }
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_LAYOUT_BYTES) {
    throw new Error("Les onglets sont trop volumineux.");
  }
  return { tabs: normalized, activeTabId: selectedId };
}

export function dashboardGridSpan(layout) {
  if (!layout) return { columns: 0, rows: 0 };
  if (layout.type === "panel") return { columns: 1, rows: 1 };
  const first = dashboardGridSpan(layout.children[0]);
  const second = dashboardGridSpan(layout.children[1]);
  return layout.direction === "row"
    ? {
        columns: first.columns + second.columns,
        rows: Math.max(first.rows, second.rows),
      }
    : {
        columns: Math.max(first.columns, second.columns),
        rows: first.rows + second.rows,
      };
}

export function assertPracticalDashboardLayout(layout) {
  const { columns, rows } = dashboardGridSpan(layout);
  if (columns > MAX_LAYOUT_GRID_SPAN || rows > MAX_LAYOUT_GRID_SPAN) {
    throw new RangeError(
      `Le dashboard accepte au maximum ${MAX_LAYOUT_GRID_SPAN} panels par ligne ou colonne.`,
    );
  }
  return layout;
}

function toSource(row) {
  return {
    id: row.id,
    name: row.name,
    inputUrl: row.input_url,
    feedUrl: row.feed_url,
    connectorId: row.connector_id ?? null,
    connectorKind: row.connector_kind,
    refreshIntervalSeconds: row.refresh_interval_seconds,
    status: row.status,
    lastCheckedAt: row.last_checked_at,
    lastSuccessAt: row.last_success_at,
    errorMessage: row.error_message,
    baselineCompletedAt: row.baseline_completed_at ?? null,
    consecutiveFailures: row.consecutive_failures ?? 0,
    nextRetryAt: row.next_retry_at ?? null,
    arrivalRevision: Number(row.arrival_revision ?? 0),
    itemCount: row.item_count ?? 0,
  };
}

function toItem(row) {
  const isBaseline = Boolean(row.is_baseline);
  const seenAt = row.seen_at ?? null;
  return {
    id: row.id,
    sourceId: row.source_id,
    canonicalUrl: row.canonical_url,
    title: row.title,
    summary: row.summary,
    imageUrl: row.image_url,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
    firstSeenAt: row.first_seen_at,
    // Immutable detection time. `lastSeenAt` separately tracks the latest
    // connector observation of the same canonical item.
    observedAt: row.first_seen_at,
    arrivalBatchAt: row.arrival_batch_at ?? row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    isBaseline,
    seenAt,
    openedAt: row.opened_at ?? null,
    isNew: !isBaseline && !seenAt,
  };
}

function toPilotEvent(row) {
  return {
    id: row.id,
    type: row.event_type,
    occurredAt: row.occurred_at,
    panelId: row.panel_id,
    sourceId: row.source_id,
    itemId: row.item_id,
    count: row.event_count,
    durationMs: row.duration_ms,
    detailCode: row.detail_code,
  };
}

/**
 * Thin synchronous persistence layer. Network work stays in feed-engine.mjs;
 * layout and panel mutations are kept atomic with their dashboard revision.
 */
export class LocalFeedDatabase {
  constructor(databasePath = ":memory:", { usageTimeZone = null } = {}) {
    if (databasePath !== ":memory:") {
      mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    }

    this.usageTimeZone = cleanUsageTimeZone(usageTimeZone);
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA foreign_keys = ON;");
    this.database.exec("PRAGMA busy_timeout = 3000;");
    if (databasePath !== ":memory:") this.database.exec("PRAGMA journal_mode = WAL;");
    this.#migrate();
    this.database.exec("UPDATE sources SET status = 'idle' WHERE status = 'refreshing';");
    this.#reconcileDashboardLayout();
  }

  #columnNames(table) {
    return new Set(this.database.prepare(`PRAGMA table_info(${table})`).all().map(({ name }) => name));
  }

  #migrate() {
    const previousVersion = this.database.prepare("PRAGMA user_version").get().user_version;
    if (previousVersion > SCHEMA_VERSION) {
      throw new Error(
        `Cette base VibeDeck utilise un schéma plus récent (${previousVersion}).`,
      );
    }
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS panels (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          position INTEGER NOT NULL,
          kind TEXT NOT NULL DEFAULT 'feed' CHECK (kind IN ('feed', 'web')),
          web_url TEXT,
          default_refresh_interval_seconds INTEGER NOT NULL DEFAULT 60,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sources (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          input_url TEXT NOT NULL,
          feed_url TEXT NOT NULL UNIQUE,
          connector_id TEXT,
          connector_kind TEXT NOT NULL CHECK (connector_kind IN ('rss', 'atom', 'news-sitemap')),
          refresh_interval_seconds INTEGER NOT NULL DEFAULT 300,
          status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'refreshing', 'healthy', 'error')),
          last_checked_at TEXT,
          last_success_at TEXT,
          error_message TEXT,
          baseline_completed_at TEXT,
          consecutive_failures INTEGER NOT NULL DEFAULT 0,
          next_retry_at TEXT,
          arrival_revision INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS panel_sources (
          panel_id TEXT NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
          source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
          position INTEGER NOT NULL,
          PRIMARY KEY (panel_id, source_id)
        );

        CREATE TABLE IF NOT EXISTS items (
          id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
          canonical_url TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT,
          image_url TEXT,
          published_at TEXT,
          updated_at TEXT,
          chronology_at TEXT,
          first_seen_at TEXT NOT NULL,
          arrival_batch_at TEXT,
          last_seen_at TEXT NOT NULL,
          is_baseline INTEGER NOT NULL DEFAULT 0 CHECK (is_baseline IN (0, 1)),
          seen_at TEXT,
          opened_at TEXT,
          UNIQUE (source_id, canonical_url)
        );

        CREATE INDEX IF NOT EXISTS items_source_date
          ON items(source_id, published_at DESC, first_seen_at DESC);

        CREATE TABLE IF NOT EXISTS endpoint_cache (
          endpoint TEXT PRIMARY KEY,
          final_url TEXT,
          body TEXT NOT NULL,
          content_type TEXT,
          etag TEXT,
          last_modified TEXT,
          fetched_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          status_code INTEGER NOT NULL DEFAULT 200
        );

        CREATE TABLE IF NOT EXISTS dashboard_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          layout_json TEXT,
          tabs_json TEXT,
          active_tab_id TEXT,
          revision INTEGER NOT NULL DEFAULT 0,
          content_revision INTEGER NOT NULL DEFAULT 0,
          arrival_revision INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS pilot_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_type TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          panel_id TEXT,
          source_id TEXT,
          item_id TEXT,
          event_count INTEGER,
          duration_ms INTEGER,
          detail_code TEXT
        );

        CREATE INDEX IF NOT EXISTS pilot_events_occurred_at
          ON pilot_events(occurred_at DESC, id DESC);

        CREATE TABLE IF NOT EXISTS pilot_sessions (
          id TEXT PRIMARY KEY,
          started_at TEXT NOT NULL,
          last_heartbeat_at TEXT NOT NULL,
          ended_at TEXT,
          active_duration_ms INTEGER NOT NULL DEFAULT 0
            CHECK (active_duration_ms >= 0),
          last_heartbeat_active INTEGER NOT NULL DEFAULT 1
            CHECK (last_heartbeat_active IN (0, 1)),
          status TEXT NOT NULL DEFAULT 'active'
            CHECK (status IN ('active', 'closed', 'interrupted'))
        );

        CREATE INDEX IF NOT EXISTS pilot_sessions_started_at
          ON pilot_sessions(started_at DESC);

        CREATE TABLE IF NOT EXISTS pilot_usage_days (
          usage_date TEXT PRIMARY KEY
            CHECK (usage_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
          active_duration_ms INTEGER NOT NULL DEFAULT 0
            CHECK (active_duration_ms >= 0),
          started_sessions INTEGER NOT NULL DEFAULT 0
            CHECK (started_sessions >= 0),
          closed_sessions INTEGER NOT NULL DEFAULT 0
            CHECK (closed_sessions >= 0),
          interrupted_sessions INTEGER NOT NULL DEFAULT 0
            CHECK (interrupted_sessions >= 0)
        );

        CREATE TABLE IF NOT EXISTS pilot_usage_rollup (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          active_duration_ms INTEGER NOT NULL DEFAULT 0
            CHECK (active_duration_ms >= 0),
          started_sessions INTEGER NOT NULL DEFAULT 0
            CHECK (started_sessions >= 0),
          closed_sessions INTEGER NOT NULL DEFAULT 0
            CHECK (closed_sessions >= 0),
          interrupted_sessions INTEGER NOT NULL DEFAULT 0
            CHECK (interrupted_sessions >= 0),
          through_date TEXT
        );

        INSERT OR IGNORE INTO pilot_usage_rollup (
          id, active_duration_ms, started_sessions, closed_sessions,
          interrupted_sessions, through_date
        ) VALUES (1, 0, 0, 0, 0, NULL);
      `);

      const panelColumns = this.#columnNames("panels");
      if (!panelColumns.has("kind")) {
        this.database.exec("ALTER TABLE panels ADD COLUMN kind TEXT NOT NULL DEFAULT 'feed';");
      }
      if (!panelColumns.has("web_url")) {
        this.database.exec("ALTER TABLE panels ADD COLUMN web_url TEXT;");
      }
      if (!panelColumns.has("default_refresh_interval_seconds")) {
        this.database.exec(
          "ALTER TABLE panels ADD COLUMN default_refresh_interval_seconds INTEGER NOT NULL DEFAULT 60;",
        );
      }

      const sourceColumns = this.#columnNames("sources");
      if (!sourceColumns.has("connector_id")) {
        this.database.exec("ALTER TABLE sources ADD COLUMN connector_id TEXT;");
      }
      if (!sourceColumns.has("baseline_completed_at")) {
        this.database.exec("ALTER TABLE sources ADD COLUMN baseline_completed_at TEXT;");
      }
      if (!sourceColumns.has("consecutive_failures")) {
        this.database.exec(
          "ALTER TABLE sources ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;",
        );
      }
      if (!sourceColumns.has("next_retry_at")) {
        this.database.exec("ALTER TABLE sources ADD COLUMN next_retry_at TEXT;");
      }
      if (!sourceColumns.has("arrival_revision")) {
        this.database.exec(
          "ALTER TABLE sources ADD COLUMN arrival_revision INTEGER NOT NULL DEFAULT 0;",
        );
      }

      const itemColumns = this.#columnNames("items");
      if (!itemColumns.has("is_baseline")) {
        this.database.exec(
          "ALTER TABLE items ADD COLUMN is_baseline INTEGER NOT NULL DEFAULT 0 CHECK (is_baseline IN (0, 1));",
        );
      }
      if (!itemColumns.has("seen_at")) {
        this.database.exec("ALTER TABLE items ADD COLUMN seen_at TEXT;");
      }
      if (!itemColumns.has("opened_at")) {
        this.database.exec("ALTER TABLE items ADD COLUMN opened_at TEXT;");
      }
      if (!itemColumns.has("arrival_batch_at")) {
        this.database.exec("ALTER TABLE items ADD COLUMN arrival_batch_at TEXT;");
      }
      if (!itemColumns.has("chronology_at")) {
        this.database.exec("ALTER TABLE items ADD COLUMN chronology_at TEXT;");
      }
      this.database.exec(`
        UPDATE items
        SET chronology_at = COALESCE(published_at, updated_at, first_seen_at)
        WHERE chronology_at IS NULL
      `);
      this.database.exec(`
        CREATE INDEX IF NOT EXISTS items_feed_order
        ON items(is_baseline ASC, chronology_at DESC, first_seen_at DESC, id ASC, source_id)
      `);
      this.database.exec(`
        CREATE INDEX IF NOT EXISTS items_source_visibility
        ON items(source_id, seen_at, is_baseline, chronology_at DESC, first_seen_at DESC, id ASC)
      `);

      if (
        previousVersion < 4 ||
        !sourceColumns.has("baseline_completed_at") ||
        !itemColumns.has("is_baseline") ||
        !itemColumns.has("seen_at")
      ) {
        // Everything already present before this feature is the user's baseline,
        // never a newly arrived article. Empty/error sources remain uninitialized
        // and will establish their baseline on their first successful parse.
        this.database.exec("UPDATE items SET is_baseline = 1;");
        this.database.exec("UPDATE items SET seen_at = COALESCE(seen_at, first_seen_at);");
        this.database.exec(`
          UPDATE sources
          SET baseline_completed_at = COALESCE(last_success_at, created_at)
          WHERE baseline_completed_at IS NULL
            AND EXISTS (SELECT 1 FROM items WHERE items.source_id = sources.id)
        `);
      }

      const cacheColumns = this.#columnNames("endpoint_cache");
      if (!cacheColumns.has("final_url")) {
        this.database.exec("ALTER TABLE endpoint_cache ADD COLUMN final_url TEXT;");
      }

      const backfill = this.database.prepare(
        "UPDATE sources SET connector_id = ? WHERE feed_url = ? AND connector_id IS NULL",
      );
      for (const [connectorId, feedUrl] of LEGACY_CONNECTOR_BACKFILLS) {
        backfill.run(connectorId, feedUrl);
      }

      if (previousVersion < 6) {
        // Schema v5 only retained one aggregate per session. Preserve that total
        // exactly by assigning it to the session's local start day. From v6 on,
        // every new delta is split at the real local-day boundary.
        this.database.prepare("DELETE FROM pilot_usage_days").run();
        this.database
          .prepare(`
            UPDATE pilot_usage_rollup
            SET active_duration_ms = 0, started_sessions = 0,
                closed_sessions = 0, interrupted_sessions = 0,
                through_date = NULL
            WHERE id = 1
          `)
          .run();
        const legacySessions = this.database
          .prepare(`
            SELECT started_at, last_heartbeat_at, ended_at,
              active_duration_ms, status
            FROM pilot_sessions
            ORDER BY started_at ASC, id ASC
          `)
          .all();
        for (const legacy of legacySessions) {
          const startedDate = localUsageDate(
            Date.parse(legacy.started_at),
            this.usageTimeZone,
          );
          this.#incrementPilotUsageDay(startedDate, {
            activeDurationMs: Number(legacy.active_duration_ms),
            startedSessions: 1,
          });
          if (legacy.status === "closed" || legacy.status === "interrupted") {
            const terminalAt = legacy.ended_at ?? legacy.last_heartbeat_at ?? legacy.started_at;
            this.#incrementPilotUsageDay(
              localUsageDate(Date.parse(terminalAt), this.usageTimeZone),
              legacy.status === "closed"
                ? { closedSessions: 1 }
                : { interruptedSessions: 1 },
            );
          }
        }
        this.#trimPilotUsageDays();
      }

      if (previousVersion < 7 || !itemColumns.has("arrival_batch_at")) {
        // Pre-v7 rows have no exact refresh-cycle identifier. The one-time UTC
        // minute heuristic repairs historical catch-up blocks while leaving the
        // immutable detection timestamps and read/open state untouched.
        this.database.exec(`
          UPDATE items
          SET arrival_batch_at = CASE
            WHEN is_baseline = 0
              THEN substr(first_seen_at, 1, 16) || ':00.000Z'
            ELSE first_seen_at
          END
          WHERE arrival_batch_at IS NULL
        `);
      }

      const dashboard = this.database.prepare("SELECT 1 FROM dashboard_state WHERE id = 1").get();
      const dashboardColumns = this.#columnNames("dashboard_state");
      if (!dashboardColumns.has("content_revision")) {
        this.database.exec(
          "ALTER TABLE dashboard_state ADD COLUMN content_revision INTEGER NOT NULL DEFAULT 0;",
        );
      }
      if (!dashboardColumns.has("arrival_revision")) {
        this.database.exec(
          "ALTER TABLE dashboard_state ADD COLUMN arrival_revision INTEGER NOT NULL DEFAULT 0;",
        );
      }
      if (!dashboardColumns.has("tabs_json")) {
        this.database.exec("ALTER TABLE dashboard_state ADD COLUMN tabs_json TEXT;");
      }
      if (!dashboardColumns.has("active_tab_id")) {
        this.database.exec("ALTER TABLE dashboard_state ADD COLUMN active_tab_id TEXT;");
      }
      if (!dashboard) {
        const panelIds = this.#listPanelIds();
        const layout = buildInitialLayout(panelIds);
        this.database
          .prepare(
            "INSERT INTO dashboard_state (id, layout_json, revision, updated_at) VALUES (1, ?, 0, ?)",
          )
          .run(layout ? JSON.stringify(layout) : null, new Date().toISOString());
      }
      const tabState = this.database
        .prepare("SELECT layout_json, tabs_json, active_tab_id FROM dashboard_state WHERE id = 1")
        .get();
      if (!tabState.tabs_json || !tabState.active_tab_id) {
        const tabId = randomUUID();
        const tabs = [{
          id: tabId,
          name: "Onglet 1",
          layout: tabState.layout_json ? JSON.parse(tabState.layout_json) : null,
        }];
        this.database
          .prepare("UPDATE dashboard_state SET tabs_json = ?, active_tab_id = ? WHERE id = 1")
          .run(JSON.stringify(tabs), tabId);
      }

      this.database.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  #listPanelIds() {
    return this.database
      .prepare("SELECT id FROM panels ORDER BY position ASC, created_at ASC")
      .all()
      .map(({ id }) => id);
  }

  #listWebPanelIds() {
    return this.database
      .prepare("SELECT id FROM panels WHERE kind = 'web' ORDER BY position ASC, created_at ASC")
      .all()
      .map(({ id }) => id);
  }

  #readDashboardState() {
    const row = this.database
      .prepare("SELECT tabs_json, active_tab_id, revision FROM dashboard_state WHERE id = 1")
      .get();
    if (!row) throw new Error("État du dashboard introuvable.");
    return {
      tabs: row.tabs_json ? JSON.parse(row.tabs_json) : [],
      activeTabId: row.active_tab_id,
      revision: row.revision,
    };
  }

  #contentRevision() {
    const row = this.database
      .prepare("SELECT content_revision FROM dashboard_state WHERE id = 1")
      .get();
    if (!row) throw new Error("État du dashboard introuvable.");
    return Number(row.content_revision);
  }

  #incrementContentRevision() {
    this.database
      .prepare("UPDATE dashboard_state SET content_revision = content_revision + 1 WHERE id = 1")
      .run();
    return this.#contentRevision();
  }

  #arrivalRevision() {
    const row = this.database
      .prepare("SELECT arrival_revision FROM dashboard_state WHERE id = 1")
      .get();
    if (!row) throw new Error("État du dashboard introuvable.");
    return Number(row.arrival_revision);
  }

  #incrementArrivalRevision() {
    this.database
      .prepare("UPDATE dashboard_state SET arrival_revision = arrival_revision + 1 WHERE id = 1")
      .run();
  }

  #writeDashboardState(tabs, activeTabId, revision, now) {
    const activeLayout = tabs.find(({ id }) => id === activeTabId)?.layout ?? null;
    this.database
      .prepare(
        `UPDATE dashboard_state
         SET tabs_json = ?, active_tab_id = ?, layout_json = ?, revision = ?, updated_at = ?
         WHERE id = 1`,
      )
      .run(
        JSON.stringify(tabs),
        activeTabId,
        activeLayout ? JSON.stringify(activeLayout) : null,
        revision,
        now,
      );
  }

  #reconcileDashboardLayout(now = new Date().toISOString()) {
    const panelIds = this.#listPanelIds();
    let dashboard;
    try {
      dashboard = this.#readDashboardState();
      validateDashboardTabs(dashboard.tabs, panelIds, {
        activeTabId: dashboard.activeTabId,
        webPanelIds: this.#listWebPanelIds(),
      });
      return;
    } catch {
      // A previous interrupted or pre-layout build must not strand panels.
    }

    const revision = Number.isInteger(dashboard?.revision) ? dashboard.revision + 1 : 0;
    const layout = buildInitialLayout(panelIds);
    const tabId = randomUUID();
    const tabs = [{ id: tabId, name: "Onglet 1", layout }];
    this.database
      .prepare(`
        INSERT INTO dashboard_state (
          id, layout_json, tabs_json, active_tab_id, revision, updated_at
        )
        VALUES (1, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          layout_json = excluded.layout_json,
          tabs_json = excluded.tabs_json,
          active_tab_id = excluded.active_tab_id,
          revision = excluded.revision,
          updated_at = excluded.updated_at
      `)
      .run(
        layout ? JSON.stringify(layout) : null,
        JSON.stringify(tabs),
        tabId,
        revision,
        now,
      );
  }

  #incrementPilotUsageDay(
    usageDate,
    {
      activeDurationMs = 0,
      startedSessions = 0,
      closedSessions = 0,
      interruptedSessions = 0,
    } = {},
  ) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(usageDate)) {
      throw new TypeError("Journée de métriques invalide.");
    }
    for (const [label, value] of [
      ["Durée active", activeDurationMs],
      ["Sessions démarrées", startedSessions],
      ["Sessions fermées", closedSessions],
      ["Sessions interrompues", interruptedSessions],
    ]) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${label} invalide.`);
      }
    }
    if (
      activeDurationMs === 0 &&
      startedSessions === 0 &&
      closedSessions === 0 &&
      interruptedSessions === 0
    ) {
      return;
    }
    this.database
      .prepare(`
        INSERT INTO pilot_usage_days (
          usage_date, active_duration_ms, started_sessions,
          closed_sessions, interrupted_sessions
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(usage_date) DO UPDATE SET
          active_duration_ms = active_duration_ms + excluded.active_duration_ms,
          started_sessions = started_sessions + excluded.started_sessions,
          closed_sessions = closed_sessions + excluded.closed_sessions,
          interrupted_sessions = interrupted_sessions + excluded.interrupted_sessions
      `)
      .run(
        usageDate,
        activeDurationMs,
        startedSessions,
        closedSessions,
        interruptedSessions,
      );
  }

  #recordPilotUsageInterval(previousAt, currentAt, active) {
    const segments = splitActiveUsageByLocalDay(previousAt, currentAt, {
      active,
      timeZone: this.usageTimeZone,
    });
    for (const segment of segments) {
      this.#incrementPilotUsageDay(segment.date, {
        activeDurationMs: segment.durationMs,
      });
    }
    return segments.reduce((total, { durationMs }) => total + durationMs, 0);
  }

  #trimPilotUsageDays() {
    const count = Number(
      this.database.prepare("SELECT COUNT(*) AS count FROM pilot_usage_days").get().count,
    );
    const overflow = count - MAX_PILOT_USAGE_DAYS;
    if (overflow <= 0) return;
    const archived = this.database
      .prepare(`
        SELECT usage_date, active_duration_ms, started_sessions,
          closed_sessions, interrupted_sessions
        FROM pilot_usage_days
        ORDER BY usage_date ASC
        LIMIT ?
      `)
      .all(overflow);
    const totals = archived.reduce(
      (result, row) => ({
        activeDurationMs: result.activeDurationMs + Number(row.active_duration_ms),
        startedSessions: result.startedSessions + Number(row.started_sessions),
        closedSessions: result.closedSessions + Number(row.closed_sessions),
        interruptedSessions:
          result.interruptedSessions + Number(row.interrupted_sessions),
      }),
      {
        activeDurationMs: 0,
        startedSessions: 0,
        closedSessions: 0,
        interruptedSessions: 0,
      },
    );
    const throughDate = archived.at(-1)?.usage_date ?? null;
    if (!throughDate) return;
    this.database
      .prepare(`
        UPDATE pilot_usage_rollup
        SET active_duration_ms = active_duration_ms + ?,
            started_sessions = started_sessions + ?,
            closed_sessions = closed_sessions + ?,
            interrupted_sessions = interrupted_sessions + ?,
            through_date = CASE
              WHEN through_date IS NULL OR through_date < ? THEN ?
              ELSE through_date
            END
        WHERE id = 1
      `)
      .run(
        totals.activeDurationMs,
        totals.startedSessions,
        totals.closedSessions,
        totals.interruptedSessions,
        throughDate,
        throughDate,
      );
    const remove = this.database.prepare("DELETE FROM pilot_usage_days WHERE usage_date = ?");
    for (const { usage_date: usageDate } of archived) remove.run(usageDate);
  }

  #appendPilotEvent(eventType, values = {}, occurredAt = new Date().toISOString()) {
    if (typeof eventType !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(eventType)) {
      throw new TypeError("Type d’événement pilote invalide.");
    }
    const detailCode = values.detailCode ?? null;
    // No free-form text: notably no URL, title, query or error message can enter
    // the pilot journal. detailCode is deliberately limited to a machine label.
    if (
      detailCode !== null &&
      (typeof detailCode !== "string" || !/^[a-z0-9][a-z0-9_.-]{0,79}$/.test(detailCode))
    ) {
      throw new TypeError("Code de détail pilote invalide.");
    }
    this.database
      .prepare(`
        INSERT INTO pilot_events (
          event_type, occurred_at, panel_id, source_id, item_id,
          event_count, duration_ms, detail_code
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        eventType,
        cleanTimestamp(occurredAt, "Date de l’événement"),
        cleanOptionalEventIdentifier(values.panelId, "Panel"),
        cleanOptionalEventIdentifier(values.sourceId, "Source"),
        cleanOptionalEventIdentifier(values.itemId, "Article"),
        cleanOptionalNonNegativeInteger(values.count, "Compteur"),
        cleanOptionalNonNegativeInteger(values.durationMs, "Durée"),
        detailCode,
      );
    this.database
      .prepare(`
        DELETE FROM pilot_events
        WHERE id IN (
          SELECT id FROM pilot_events
          ORDER BY id DESC
          LIMIT -1 OFFSET ?
        )
      `)
      .run(MAX_PILOT_EVENTS);
  }

  recordPilotEvent(eventType, values = {}, occurredAt = new Date().toISOString()) {
    this.#appendPilotEvent(eventType, values, occurredAt);
  }

  listPilotEvents({ limit = 200, since = null } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PILOT_EVENTS) {
      throw new RangeError("Limite d’événements pilote invalide.");
    }
    const normalizedSince = since == null ? null : cleanTimestamp(since, "Date de début");
    return this.database
      .prepare(`
        SELECT * FROM pilot_events
        WHERE (? IS NULL OR occurred_at >= ?)
        ORDER BY occurred_at DESC, id DESC
        LIMIT ?
      `)
      .all(normalizedSince, normalizedSince, limit)
      .map(toPilotEvent);
  }

  beginPilotSession(startedAt = new Date().toISOString()) {
    const normalizedStartedAt = cleanTimestamp(startedAt, "Début de session");
    const sessionId = randomUUID();
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const interruptedSessions = this.database
        .prepare(`
          SELECT started_at, last_heartbeat_at
          FROM pilot_sessions
          WHERE status = 'active'
        `)
        .all();
      if (interruptedSessions.length > 0) {
        this.database
          .prepare(`
            UPDATE pilot_sessions
            SET status = 'interrupted',
                ended_at = CASE
                  WHEN ? < started_at THEN started_at
                  WHEN last_heartbeat_at <= ? THEN last_heartbeat_at
                  ELSE ?
                END,
                last_heartbeat_active = 0
            WHERE status = 'active'
          `)
          .run(normalizedStartedAt, normalizedStartedAt, normalizedStartedAt);
        for (const interrupted of interruptedSessions) {
          const endedAt =
            normalizedStartedAt < interrupted.started_at
              ? interrupted.started_at
              : interrupted.last_heartbeat_at <= normalizedStartedAt
                ? interrupted.last_heartbeat_at
                : normalizedStartedAt;
          this.#incrementPilotUsageDay(
            localUsageDate(Date.parse(endedAt), this.usageTimeZone),
            { interruptedSessions: 1 },
          );
        }
        this.#appendPilotEvent(
          "session_interrupted",
          { count: interruptedSessions.length },
          normalizedStartedAt,
        );
      }

      this.database
        .prepare(`
          INSERT INTO pilot_sessions (
            id, started_at, last_heartbeat_at, ended_at,
            active_duration_ms, last_heartbeat_active, status
          ) VALUES (?, ?, ?, NULL, 0, 1, 'active')
        `)
        .run(sessionId, normalizedStartedAt, normalizedStartedAt);
      this.#incrementPilotUsageDay(
        localUsageDate(Date.parse(normalizedStartedAt), this.usageTimeZone),
        { startedSessions: 1 },
      );
      this.database
        .prepare(`
          DELETE FROM pilot_sessions
          WHERE id IN (
            SELECT id FROM pilot_sessions
            WHERE status != 'active'
            ORDER BY started_at DESC, id DESC
            LIMIT -1 OFFSET ?
          )
        `)
        .run(MAX_PILOT_SESSIONS - 1);
      this.#trimPilotUsageDays();
      this.#appendPilotEvent("session_started", {}, normalizedStartedAt);
      this.database.exec("COMMIT;");
      return {
        sessionId,
        startedAt: normalizedStartedAt,
        interruptedSessions: interruptedSessions.length,
      };
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  heartbeatPilotSession(
    sessionId,
    { active = true } = {},
    heartbeatAt = new Date().toISOString(),
  ) {
    const normalizedSessionId = cleanIdentifier(sessionId, "Session pilote");
    if (typeof active !== "boolean") throw new TypeError("État d’activité invalide.");
    const normalizedHeartbeatAt = cleanTimestamp(heartbeatAt, "Heartbeat de session");
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const session = this.database
        .prepare(`
          SELECT last_heartbeat_at, active_duration_ms, last_heartbeat_active, status
          FROM pilot_sessions WHERE id = ?
        `)
        .get(normalizedSessionId);
      if (!session || session.status !== "active") {
        this.database.exec("COMMIT;");
        return { updated: false, addedDurationMs: 0 };
      }
      const effectiveHeartbeatAt = monotonicTimestamp(
        session.last_heartbeat_at,
        normalizedHeartbeatAt,
      );
      const addedDurationMs = this.#recordPilotUsageInterval(
        session.last_heartbeat_at,
        effectiveHeartbeatAt,
        Boolean(session.last_heartbeat_active),
      );
      this.database
        .prepare(`
          UPDATE pilot_sessions
          SET last_heartbeat_at = ?,
              active_duration_ms = active_duration_ms + ?,
              last_heartbeat_active = ?
          WHERE id = ? AND status = 'active'
        `)
        .run(
          effectiveHeartbeatAt,
          addedDurationMs,
          active ? 1 : 0,
          normalizedSessionId,
        );
      this.#trimPilotUsageDays();
      this.database.exec("COMMIT;");
      return {
        updated: true,
        addedDurationMs,
        activeDurationMs: Number(session.active_duration_ms) + addedDurationMs,
        heartbeatAt: effectiveHeartbeatAt,
      };
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  endPilotSession(sessionId, endedAt = new Date().toISOString()) {
    const normalizedSessionId = cleanIdentifier(sessionId, "Session pilote");
    const normalizedEndedAt = cleanTimestamp(endedAt, "Fin de session");
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const session = this.database
        .prepare(`
          SELECT last_heartbeat_at, active_duration_ms, last_heartbeat_active, status
          FROM pilot_sessions WHERE id = ?
        `)
        .get(normalizedSessionId);
      if (!session || session.status !== "active") {
        this.database.exec("COMMIT;");
        return { closed: false, activeDurationMs: session?.active_duration_ms ?? null };
      }
      const effectiveEndedAt = monotonicTimestamp(session.last_heartbeat_at, normalizedEndedAt);
      const finalDeltaMs = this.#recordPilotUsageInterval(
        session.last_heartbeat_at,
        effectiveEndedAt,
        Boolean(session.last_heartbeat_active),
      );
      const activeDurationMs = Number(session.active_duration_ms) + finalDeltaMs;
      this.database
        .prepare(`
          UPDATE pilot_sessions
          SET status = 'closed', ended_at = ?, last_heartbeat_at = ?,
              active_duration_ms = ?, last_heartbeat_active = 0
          WHERE id = ? AND status = 'active'
        `)
        .run(effectiveEndedAt, effectiveEndedAt, activeDurationMs, normalizedSessionId);
      this.#incrementPilotUsageDay(
        localUsageDate(Date.parse(effectiveEndedAt), this.usageTimeZone),
        { closedSessions: 1 },
      );
      this.#trimPilotUsageDays();
      this.#appendPilotEvent(
        "session_ended",
        { durationMs: activeDurationMs },
        effectiveEndedAt,
      );
      this.database.exec("COMMIT;");
      return { closed: true, endedAt: effectiveEndedAt, activeDurationMs };
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  close() {
    this.database.close();
  }

  hasPanel(panelId, kind = null) {
    const row = this.database.prepare("SELECT kind FROM panels WHERE id = ?").get(panelId);
    return Boolean(row && (!kind || row.kind === kind));
  }

  getFeedPanelDefaultRefresh(panelId) {
    const row = this.database
      .prepare(
        "SELECT default_refresh_interval_seconds FROM panels WHERE id = ? AND kind = 'feed'",
      )
      .get(panelId);
    if (!row) throw new Error("Panel de flux introuvable.");
    return cleanRefreshInterval(row.default_refresh_interval_seconds);
  }

  createPanel(input, placement = null, now = new Date().toISOString()) {
    const normalized = normalizePanelInput(input);
    if (placement !== null) {
      if (
        !placement ||
        typeof placement !== "object" ||
        (placement.tabId !== undefined && typeof placement.tabId !== "string") ||
        (placement.targetPanelId !== undefined && typeof placement.targetPanelId !== "string") ||
        (placement.side !== undefined && !["left", "right", "top", "bottom"].includes(placement.side))
      ) {
        throw new TypeError("Emplacement de panel invalide.");
      }
    }

    const id = randomUUID();
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const dashboard = this.#readDashboardState();
      const targetTabId = placement?.tabId ?? dashboard.activeTabId;
      const targetTabIndex = dashboard.tabs.findIndex(({ id }) => id === targetTabId);
      if (targetTabIndex < 0) throw new Error("Onglet cible introuvable.");
      const targetTab = dashboard.tabs[targetTabIndex];
      if (normalized.kind === "web") {
        const webPanelIds = new Set(this.#listWebPanelIds());
        const webPanelCount = panelIdsInLayout(targetTab.layout)
          .filter((panelId) => webPanelIds.has(panelId)).length;
        if (webPanelCount >= MAX_CONFIGURATION_WEB_PANELS) {
          throw new RangeError(
            `Un onglet ne peut pas contenir plus de ${MAX_CONFIGURATION_WEB_PANELS} pages web.`,
          );
        }
      }
      const position = this.database
        .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM panels")
        .get().next_position;
      this.database
        .prepare(`
          INSERT INTO panels (
            id, name, position, kind, web_url, default_refresh_interval_seconds,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          id,
          normalized.name,
          position,
          normalized.kind,
          normalized.webUrl,
          normalized.defaultRefreshIntervalSeconds,
          now,
          now,
        );

      const newLeaf = { type: "panel", panelId: id };
      let nextLayout;
      if (!targetTab.layout) {
        if (placement?.targetPanelId || placement?.side) {
          throw new Error("Le panel cible est introuvable.");
        }
        nextLayout = newLeaf;
      } else if (placement?.targetPanelId && placement?.side) {
        const inserted = insertPanelIntoLayout(
          targetTab.layout,
          placement.targetPanelId,
          id,
          placement.side,
        );
        if (!inserted.found) throw new Error("Le panel cible est introuvable.");
        nextLayout = inserted.layout;
      } else {
        nextLayout = {
          type: "split",
          id: randomUUID(),
          direction: "row",
          ratio: 0.5,
          children: [targetTab.layout, newLeaf],
        };
      }

      const panelIds = [...this.#listPanelIds()];
      nextLayout = assertPracticalDashboardLayout(
        validateDashboardLayout(nextLayout, panelIds, { requireAll: false }),
      );
      const nextTabs = dashboard.tabs.map((tab, index) =>
        index === targetTabIndex ? { ...tab, layout: nextLayout } : tab);
      const validated = validateDashboardTabs(nextTabs, panelIds, {
        activeTabId: targetTabId,
        webPanelIds: this.#listWebPanelIds(),
      });
      this.#writeDashboardState(
        validated.tabs,
        validated.activeTabId,
        dashboard.revision + 1,
        now,
      );
      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }

    return normalized.kind === "feed"
      ? { id, kind: "feed", name: normalized.name, sourceIds: [] }
      : { id, kind: "web", name: normalized.name, url: normalized.webUrl };
  }

  renamePanel(panelId, name, now = new Date().toISOString()) {
    const result = this.database
      .prepare("UPDATE panels SET name = ?, updated_at = ? WHERE id = ?")
      .run(cleanPanelName(name), now, panelId);
    if (result.changes === 0) throw new Error("Panel introuvable.");
  }

  setWebPanelUrl(panelId, url, now = new Date().toISOString()) {
    const result = this.database
      .prepare("UPDATE panels SET web_url = ?, updated_at = ? WHERE id = ? AND kind = 'web'")
      .run(cleanHttpUrl(url), now, panelId);
    if (result.changes === 0) throw new Error("Panel web introuvable.");
  }

  deletePanel(panelId, now = new Date().toISOString()) {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const dashboard = this.#readDashboardState();
      const result = this.database.prepare("DELETE FROM panels WHERE id = ?").run(panelId);
      if (result.changes === 0) throw new Error("Panel introuvable.");
      const nextTabs = dashboard.tabs.map((tab) => ({
        ...tab,
        layout: removePanelFromLayout(tab.layout, panelId),
      }));
      const validated = validateDashboardTabs(nextTabs, this.#listPanelIds(), {
        activeTabId: dashboard.activeTabId,
        webPanelIds: this.#listWebPanelIds(),
      });
      this.#writeDashboardState(
        validated.tabs,
        validated.activeTabId,
        dashboard.revision + 1,
        now,
      );
      this.#incrementContentRevision();
      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  getDashboardState() {
    const dashboard = this.#readDashboardState();
    const validated = validateDashboardTabs(dashboard.tabs, this.#listPanelIds(), {
      activeTabId: dashboard.activeTabId,
      webPanelIds: this.#listWebPanelIds(),
    });
    return { ...validated, revision: dashboard.revision };
  }

  saveDashboardLayout(tabId, layout, expectedRevision, now = new Date().toISOString()) {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError("Révision de dashboard invalide.");
    }
    const normalizedTabId = cleanIdentifier(tabId, "Onglet");
    const dashboard = this.#readDashboardState();
    if (dashboard.revision !== expectedRevision) throw this.#revisionConflict();
    const tabIndex = dashboard.tabs.findIndex(({ id }) => id === normalizedTabId);
    if (tabIndex < 0) throw new Error("Onglet introuvable.");
    const tabPanelIds = panelIdsInLayout(dashboard.tabs[tabIndex].layout);
    const normalized = assertPracticalDashboardLayout(
      validateDashboardLayout(layout, tabPanelIds),
    );
    const nextTabs = dashboard.tabs.map((tab, index) =>
      index === tabIndex ? { ...tab, layout: normalized } : tab);
    const validated = validateDashboardTabs(nextTabs, this.#listPanelIds(), {
      activeTabId: dashboard.activeTabId,
      webPanelIds: this.#listWebPanelIds(),
    });
    this.#writeDashboardState(validated.tabs, validated.activeTabId, expectedRevision + 1, now);
    return this.getDashboardState();
  }

  #revisionConflict() {
    const error = new Error("Le dashboard a changé. Rechargez sa disposition avant de réessayer.");
    error.code = "DASHBOARD_REVISION_CONFLICT";
    return error;
  }

  createDashboardTab(name, expectedRevision, now = new Date().toISOString()) {
    const dashboard = this.#readDashboardState();
    if (dashboard.revision !== expectedRevision) throw this.#revisionConflict();
    if (dashboard.tabs.length >= MAX_DASHBOARD_TABS) {
      throw new RangeError(`Le dashboard accepte au maximum ${MAX_DASHBOARD_TABS} onglets.`);
    }
    const tab = { id: randomUUID(), name: cleanTabName(name), layout: null };
    const tabs = [...dashboard.tabs, tab];
    this.#writeDashboardState(tabs, tab.id, expectedRevision + 1, now);
    return this.getDashboardState();
  }

  renameDashboardTab(tabId, name, expectedRevision, now = new Date().toISOString()) {
    const id = cleanIdentifier(tabId, "Onglet");
    const dashboard = this.#readDashboardState();
    if (dashboard.revision !== expectedRevision) throw this.#revisionConflict();
    if (!dashboard.tabs.some((tab) => tab.id === id)) throw new Error("Onglet introuvable.");
    const tabs = dashboard.tabs.map((tab) =>
      tab.id === id ? { ...tab, name: cleanTabName(name) } : tab);
    this.#writeDashboardState(tabs, dashboard.activeTabId, expectedRevision + 1, now);
    return this.getDashboardState();
  }

  reorderDashboardTabs(tabIds, expectedRevision, now = new Date().toISOString()) {
    if (!Array.isArray(tabIds)) throw new TypeError("Ordre des onglets invalide.");
    const dashboard = this.#readDashboardState();
    if (dashboard.revision !== expectedRevision) throw this.#revisionConflict();
    const ids = tabIds.map((id) => cleanIdentifier(id, "Onglet"));
    if (
      ids.length !== dashboard.tabs.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !dashboard.tabs.some((tab) => tab.id === id))
    ) {
      throw new Error("L’ordre doit contenir chaque onglet exactement une fois.");
    }
    const byId = new Map(dashboard.tabs.map((tab) => [tab.id, tab]));
    this.#writeDashboardState(
      ids.map((id) => byId.get(id)),
      dashboard.activeTabId,
      expectedRevision + 1,
      now,
    );
    return this.getDashboardState();
  }

  selectDashboardTab(tabId, now = new Date().toISOString()) {
    const id = cleanIdentifier(tabId, "Onglet");
    const dashboard = this.#readDashboardState();
    if (!dashboard.tabs.some((tab) => tab.id === id)) throw new Error("Onglet introuvable.");
    this.#writeDashboardState(dashboard.tabs, id, dashboard.revision, now);
    return this.getDashboardState();
  }

  deleteDashboardTab(tabId, expectedRevision, now = new Date().toISOString()) {
    const id = cleanIdentifier(tabId, "Onglet");
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const dashboard = this.#readDashboardState();
      if (dashboard.revision !== expectedRevision) throw this.#revisionConflict();
      if (dashboard.tabs.length <= 1) throw new Error("Le dernier onglet ne peut pas être supprimé.");
      const tabIndex = dashboard.tabs.findIndex((tab) => tab.id === id);
      if (tabIndex < 0) throw new Error("Onglet introuvable.");
      const panelIds = panelIdsInLayout(dashboard.tabs[tabIndex].layout);
      const removePanel = this.database.prepare("DELETE FROM panels WHERE id = ?");
      for (const panelId of panelIds) removePanel.run(panelId);
      const tabs = dashboard.tabs.filter((tab) => tab.id !== id);
      const activeTabId = dashboard.activeTabId === id
        ? tabs[Math.min(tabIndex, tabs.length - 1)].id
        : dashboard.activeTabId;
      const validated = validateDashboardTabs(tabs, this.#listPanelIds(), {
        activeTabId,
        webPanelIds: this.#listWebPanelIds(),
      });
      this.#writeDashboardState(validated.tabs, activeTabId, expectedRevision + 1, now);
      if (panelIds.length > 0) this.#incrementContentRevision();
      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
    return this.getState(now);
  }

  movePanelToTab(
    panelId,
    destinationTabId,
    placement,
    expectedRevision,
    now = new Date().toISOString(),
  ) {
    const id = cleanIdentifier(panelId, "Panel");
    const targetTabId = cleanIdentifier(destinationTabId, "Onglet cible");
    if (!placement || typeof placement !== "object" || Array.isArray(placement)) {
      throw new TypeError("Placement de panel invalide.");
    }
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const dashboard = this.#readDashboardState();
      if (dashboard.revision !== expectedRevision) throw this.#revisionConflict();
      const sourceIndex = dashboard.tabs.findIndex((tab) => panelIdsInLayout(tab.layout).includes(id));
      const targetIndex = dashboard.tabs.findIndex((tab) => tab.id === targetTabId);
      if (sourceIndex < 0 || targetIndex < 0) throw new Error("Panel ou onglet cible introuvable.");
      if (sourceIndex === targetIndex) throw new Error("Le panel appartient déjà à cet onglet.");
      const target = dashboard.tabs[targetIndex];
      let targetLayout;
      if (!target.layout) {
        if (placement.targetPanelId != null || placement.side != null) {
          throw new Error("Un onglet vide n’accepte pas de zone relative.");
        }
        targetLayout = { type: "panel", panelId: id };
      } else {
        const targetPanelId = cleanIdentifier(placement.targetPanelId, "Panel cible");
        if (!["left", "right", "top", "bottom"].includes(placement.side)) {
          throw new TypeError("Côté de placement invalide.");
        }
        const inserted = insertPanelIntoLayout(target.layout, targetPanelId, id, placement.side);
        if (!inserted.found) throw new Error("Zone de placement introuvable.");
        targetLayout = inserted.layout;
      }
      const tabs = dashboard.tabs.map((tab, index) => {
        if (index === sourceIndex) return { ...tab, layout: removePanelFromLayout(tab.layout, id) };
        if (index === targetIndex) return { ...tab, layout: targetLayout };
        return tab;
      });
      const validated = validateDashboardTabs(tabs, this.#listPanelIds(), {
        activeTabId: targetTabId,
        webPanelIds: this.#listWebPanelIds(),
      });
      this.#writeDashboardState(validated.tabs, targetTabId, expectedRevision + 1, now);
      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
    return this.getState(now);
  }

  resetDashboard(expectedRevision, now = new Date().toISOString()) {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const dashboard = this.#readDashboardState();
      if (dashboard.revision !== expectedRevision) throw this.#revisionConflict();
      this.database.prepare("DELETE FROM panels").run();
      const tab = { id: randomUUID(), name: "Onglet 1", layout: null };
      this.#writeDashboardState([tab], tab.id, expectedRevision + 1, now);
      this.#incrementContentRevision();
      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
    return this.getState(now);
  }

  previewDashboardConfig(input) {
    const normalized = normalizeConfiguration(input);
    const hosts = new Set();
    for (const source of normalized.sources) hosts.add(new URL(source.feedUrl).hostname);
    for (const panel of normalized.panels) {
      if (panel.kind === "web" && panel.webUrl) hosts.add(new URL(panel.webUrl).hostname);
    }
    return {
      tabs: normalized.tabs.length,
      panels: normalized.panels.length,
      feedPanels: normalized.panels.filter(({ kind }) => kind === "feed").length,
      webPanels: normalized.panels.filter(({ kind }) => kind === "web").length,
      sources: normalized.sources.length,
      hosts: [...hosts].sort(),
    };
  }

  exportDashboardConfig(now = new Date().toISOString()) {
    const state = this.getState(now);
    const attachedSourceIds = new Set(
      state.panels.flatMap((panel) => (panel.kind === "feed" ? panel.sourceIds : [])),
    );
    const configuration = {
      format: CONFIGURATION_FORMAT,
      version: CONFIGURATION_VERSION,
      activeTabId: state.dashboard.activeTabId,
      tabs: state.dashboard.tabs,
      panels: state.panels.map((panel) =>
        panel.kind === "web"
          ? { id: panel.id, kind: "web", name: panel.name, url: panel.url }
          : {
              id: panel.id,
              kind: "feed",
              name: panel.name,
              defaultRefreshIntervalSeconds: panel.defaultRefreshIntervalSeconds,
              sourceIds: [...panel.sourceIds],
            },
      ),
      sources: state.sources
        .filter((source) => attachedSourceIds.has(source.id))
        .map((source) => ({
          id: source.id,
          name: source.name,
          inputUrl: source.inputUrl,
          feedUrl: source.feedUrl,
          connectorId: source.connectorId,
          connectorKind: source.connectorKind,
          refreshIntervalSeconds: source.refreshIntervalSeconds,
        })),
    };
    this.#appendPilotEvent(
      "configuration_exported",
      { count: configuration.panels.length },
      now,
    );
    return configuration;
  }

  importDashboardConfig(input, now = new Date().toISOString()) {
    const normalized = normalizeConfiguration(input);
    const normalizedNow = cleanTimestamp(now, "Date d’import");
    const dashboard = this.#readDashboardState();
    const sourceIdMap = new Map();
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      this.database.prepare("DELETE FROM panels").run();

      const findByFeedUrl = this.database.prepare("SELECT id FROM sources WHERE feed_url = ?");
      const findById = this.database.prepare("SELECT 1 FROM sources WHERE id = ?");
      const updateSource = this.database.prepare(`
        UPDATE sources
        SET name = ?, input_url = ?, connector_id = COALESCE(?, connector_id),
            connector_kind = ?, refresh_interval_seconds = ?, updated_at = ?
        WHERE id = ?
      `);
      const insertSource = this.database.prepare(`
        INSERT INTO sources (
          id, name, input_url, feed_url, connector_id, connector_kind,
          refresh_interval_seconds, status, last_checked_at, last_success_at,
          error_message, baseline_completed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', NULL, NULL, NULL, NULL, ?, ?)
      `);
      for (const source of normalized.sources) {
        const existing = findByFeedUrl.get(source.feedUrl);
        if (existing) {
          sourceIdMap.set(source.id, existing.id);
          updateSource.run(
            source.name,
            source.inputUrl,
            source.connectorId,
            source.connectorKind,
            source.refreshIntervalSeconds,
            normalizedNow,
            existing.id,
          );
          continue;
        }
        const destinationId = findById.get(source.id) ? randomUUID() : source.id;
        insertSource.run(
          destinationId,
          source.name,
          source.inputUrl,
          source.feedUrl,
          source.connectorId,
          source.connectorKind,
          source.refreshIntervalSeconds,
          normalizedNow,
          normalizedNow,
        );
        sourceIdMap.set(source.id, destinationId);
      }

      const insertPanel = this.database.prepare(`
        INSERT INTO panels (
          id, name, position, kind, web_url, default_refresh_interval_seconds,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const attachSource = this.database.prepare(`
        INSERT INTO panel_sources (panel_id, source_id, position) VALUES (?, ?, ?)
      `);
      normalized.panels.forEach((panel, position) => {
        insertPanel.run(
          panel.id,
          panel.name,
          position,
          panel.kind,
          panel.webUrl,
          panel.defaultRefreshIntervalSeconds,
          normalizedNow,
          normalizedNow,
        );
        panel.sourceIds.forEach((sourceId, sourcePosition) => {
          attachSource.run(panel.id, sourceIdMap.get(sourceId), sourcePosition);
        });
      });

      this.#writeDashboardState(
        normalized.tabs,
        normalized.activeTabId,
        dashboard.revision + 1,
        normalizedNow,
      );
      this.#incrementContentRevision();
      this.#appendPilotEvent(
        "configuration_imported",
        { count: normalized.panels.length },
        normalizedNow,
      );
      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
    return this.getState(normalizedNow);
  }

  getPilotDiagnostics(now = new Date().toISOString()) {
    const generatedAt = cleanTimestamp(now, "Date de diagnostic");
    const totals = this.database
      .prepare(`
        SELECT
          (SELECT COUNT(*) FROM panels) AS panels,
          (SELECT COUNT(*) FROM sources
            WHERE EXISTS (SELECT 1 FROM panel_sources WHERE panel_sources.source_id = sources.id)
          ) AS sources,
          (SELECT COUNT(*) FROM items
            WHERE EXISTS (SELECT 1 FROM panel_sources WHERE panel_sources.source_id = items.source_id)
          ) AS items,
          (SELECT COUNT(*) FROM items
            WHERE is_baseline = 0 AND seen_at IS NULL
              AND EXISTS (SELECT 1 FROM panel_sources WHERE panel_sources.source_id = items.source_id)
          ) AS new_unseen,
          (SELECT COUNT(*) FROM items
            WHERE opened_at IS NOT NULL
              AND EXISTS (SELECT 1 FROM panel_sources WHERE panel_sources.source_id = items.source_id)
          ) AS opened,
          (SELECT COUNT(*) FROM pilot_events) AS pilot_events
      `)
      .get();
    const sources = this.database
      .prepare(`
        SELECT sources.id, sources.status, sources.last_checked_at, sources.last_success_at,
          sources.baseline_completed_at, sources.consecutive_failures, sources.next_retry_at,
          COUNT(items.id) AS item_count,
          COALESCE(SUM(CASE
            WHEN items.is_baseline = 0 AND items.seen_at IS NULL THEN 1 ELSE 0
          END), 0) AS new_unseen_count,
          MAX(items.first_seen_at) AS latest_observed_at
        FROM sources
        JOIN (SELECT DISTINCT source_id FROM panel_sources) AS attached_sources
          ON attached_sources.source_id = sources.id
        LEFT JOIN items ON items.source_id = sources.id
        GROUP BY sources.id
        ORDER BY sources.id ASC
      `)
      .all()
      .map((row) => ({
        id: row.id,
        status: row.status,
        lastCheckedAt: row.last_checked_at,
        lastSuccessAt: row.last_success_at,
        baselineCompletedAt: row.baseline_completed_at,
        consecutiveFailures: Number(row.consecutive_failures),
        nextRetryAt: row.next_retry_at,
        itemCount: Number(row.item_count),
        newUnseenCount: Number(row.new_unseen_count),
        latestObservedAt: row.latest_observed_at,
      }));
    const eventsByType = Object.fromEntries(
      this.database
        .prepare(`
          SELECT event_type, COUNT(*) AS count
          FROM pilot_events
          GROUP BY event_type
          ORDER BY event_type ASC
        `)
        .all()
        .map((row) => [row.event_type, Number(row.count)]),
    );
    const usage = this.database
      .prepare(`
        SELECT
          rollup.active_duration_ms + COALESCE((
            SELECT SUM(active_duration_ms) FROM pilot_usage_days
          ), 0) AS total_active_duration_ms,
          rollup.started_sessions + COALESCE((
            SELECT SUM(started_sessions) FROM pilot_usage_days
          ), 0) AS session_count,
          rollup.closed_sessions + COALESCE((
            SELECT SUM(closed_sessions) FROM pilot_usage_days
          ), 0) AS closed_sessions,
          rollup.interrupted_sessions + COALESCE((
            SELECT SUM(interrupted_sessions) FROM pilot_usage_days
          ), 0) AS interrupted_sessions,
          (SELECT COUNT(*) FROM pilot_sessions WHERE status = 'active') AS active_sessions
        FROM pilot_usage_rollup AS rollup
        WHERE rollup.id = 1
      `)
      .get();
    const recentUsageDays = this.database
      .prepare(`
        SELECT usage_date AS date, active_duration_ms,
          started_sessions AS session_count,
          closed_sessions, interrupted_sessions
        FROM pilot_usage_days
        ORDER BY usage_date DESC
        LIMIT 14
      `)
      .all()
      .map((row) => ({
        date: row.date,
        activeDurationMs: Number(row.active_duration_ms),
        sessionCount: Number(row.session_count),
        closedSessions: Number(row.closed_sessions),
        interruptedSessions: Number(row.interrupted_sessions),
      }));
    return {
      schemaVersion: SCHEMA_VERSION,
      generatedAt,
      totals: {
        panels: Number(totals.panels),
        sources: Number(totals.sources),
        items: Number(totals.items),
        newUnseen: Number(totals.new_unseen),
        opened: Number(totals.opened),
        pilotEvents: Number(totals.pilot_events),
      },
      sources,
      usage: {
        totalActiveDurationMs: Number(usage.total_active_duration_ms),
        sessionCount: Number(usage.session_count),
        closedSessions: Number(usage.closed_sessions),
        interruptedSessions: Number(usage.interrupted_sessions),
        activeSessions: Number(usage.active_sessions),
        recentDays: recentUsageDays,
      },
      eventsByType,
      // Export only aggregate event facts. Persistent panel/source/item IDs can
      // be correlated across diagnostics, and deterministic item IDs can reveal
      // which public URL a journalist opened.
      recentEvents: this.listPilotEvents({ limit: 100 }).map(
        ({ type, occurredAt, count, durationMs, detailCode }) => ({
          type,
          occurredAt,
          count,
          durationMs,
          detailCode,
        }),
      ),
    };
  }

  getSource(sourceId) {
    const row = this.database
      .prepare(`
        SELECT sources.*,
          (SELECT COUNT(*) FROM items WHERE items.source_id = sources.id) AS item_count
        FROM sources WHERE sources.id = ?
      `)
      .get(sourceId);
    return row ? toSource(row) : null;
  }

  getItem(itemId) {
    const normalizedItemId = cleanIdentifier(itemId, "Article");
    const row = this.database.prepare("SELECT * FROM items WHERE id = ?").get(normalizedItemId);
    return row ? toItem(row) : null;
  }

  findSourceByFeedUrl(feedUrl) {
    const row = this.database
      .prepare(`
        SELECT sources.*,
          (SELECT COUNT(*) FROM items WHERE items.source_id = sources.id) AS item_count
        FROM sources WHERE sources.feed_url = ?
      `)
      .get(feedUrl);
    return row ? toSource(row) : null;
  }

  findSourceByInputOrFeedUrl(url) {
    const row = this.database
      .prepare(`
        SELECT sources.*,
          (SELECT COUNT(*) FROM items WHERE items.source_id = sources.id) AS item_count
        FROM sources
        WHERE sources.input_url = ? OR sources.feed_url = ?
        ORDER BY CASE WHEN sources.feed_url = ? THEN 0 ELSE 1 END
        LIMIT 1
      `)
      .get(url, url, url);
    return row ? toSource(row) : null;
  }

  listSources({ attachedOnly = false } = {}) {
    const where = attachedOnly
      ? "WHERE EXISTS (SELECT 1 FROM panel_sources WHERE panel_sources.source_id = sources.id)"
      : "";
    return this.database
      .prepare(`
        SELECT sources.*,
          (SELECT COUNT(*) FROM items WHERE items.source_id = sources.id) AS item_count
        FROM sources
        ${where}
        ORDER BY sources.created_at ASC
      `)
      .all()
      .map(toSource);
  }

  putSource(source, now = new Date().toISOString()) {
    const existing = this.findSourceByFeedUrl(source.feedUrl);
    if (existing) {
      this.database
        .prepare(`
          UPDATE sources
          SET name = ?, input_url = ?, connector_id = COALESCE(?, connector_id),
              connector_kind = ?, refresh_interval_seconds = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(
          source.name,
          source.inputUrl,
          nullable(source.connectorId),
          source.connectorKind,
          source.refreshIntervalSeconds,
          now,
          existing.id,
        );
      return existing.id;
    }

    const id = source.id ?? randomUUID();
    this.database
      .prepare(`
        INSERT INTO sources (
          id, name, input_url, feed_url, connector_id, connector_kind,
          refresh_interval_seconds, status, last_checked_at, last_success_at,
          error_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        source.name,
        source.inputUrl,
        source.feedUrl,
        nullable(source.connectorId),
        source.connectorKind,
        source.refreshIntervalSeconds,
        source.status ?? "idle",
        nullable(source.lastCheckedAt),
        nullable(source.lastSuccessAt),
        nullable(source.errorMessage),
        now,
        now,
      );
    return id;
  }

  setSourceConnectorId(sourceId, connectorId, now = new Date().toISOString()) {
    const result = this.database
      .prepare("UPDATE sources SET connector_id = ?, updated_at = ? WHERE id = ?")
      .run(connectorId, now, sourceId);
    if (result.changes === 0) throw new Error("Source introuvable.");
  }

  setSourceRefreshInterval(sourceId, refreshIntervalSeconds, now = new Date().toISOString()) {
    const interval = cleanRefreshInterval(refreshIntervalSeconds);
    const result = this.database
      .prepare(
        "UPDATE sources SET refresh_interval_seconds = ?, updated_at = ? WHERE id = ?",
      )
      .run(interval, now, sourceId);
    if (result.changes === 0) throw new Error("Source introuvable.");
  }

  setFeedPanelDefaultRefresh(panelId, refreshIntervalSeconds, now = new Date().toISOString()) {
    const interval = cleanRefreshInterval(refreshIntervalSeconds);
    const result = this.database
      .prepare(`
        UPDATE panels
        SET default_refresh_interval_seconds = ?, updated_at = ?
        WHERE id = ? AND kind = 'feed'
      `)
      .run(interval, now, panelId);
    if (result.changes === 0) throw new Error("Panel de flux introuvable.");
  }

  captureFeedPanelConfiguration(panelId) {
    const panel = this.database
      .prepare(`
        SELECT name, default_refresh_interval_seconds, updated_at
        FROM panels
        WHERE id = ? AND kind = 'feed'
      `)
      .get(panelId);
    if (!panel) throw new Error("Panel de flux introuvable.");
    const sourceIds = this.database
      .prepare(`
        SELECT source_id
        FROM panel_sources
        WHERE panel_id = ?
        ORDER BY position ASC
      `)
      .all(panelId)
      .map(({ source_id: sourceId }) => sourceId);
    const sourceConfigurations = this.database
      .prepare(`
        SELECT id AS source_id, name, input_url, feed_url, connector_id,
          connector_kind, refresh_interval_seconds, updated_at
        FROM sources
        ORDER BY created_at ASC, id ASC
      `)
      .all()
      .map((row) => ({
        sourceId: row.source_id,
        name: row.name,
        inputUrl: row.input_url,
        feedUrl: row.feed_url,
        connectorId: row.connector_id ?? null,
        connectorKind: row.connector_kind,
        refreshIntervalSeconds: Number(row.refresh_interval_seconds),
        updatedAt: row.updated_at,
      }));
    if (
      sourceIds.length > MAX_FEED_CONFIGURATION_CHECKPOINT_SOURCES ||
      sourceConfigurations.length > MAX_FEED_CONFIGURATION_CHECKPOINT_SOURCES
    ) {
      throw new RangeError("Le dashboard contient trop de sources pour être modifié sûrement.");
    }
    return {
      name: panel.name,
      defaultRefreshIntervalSeconds: Number(panel.default_refresh_interval_seconds),
      updatedAt: panel.updated_at,
      sourceIds,
      sourceConfigurations,
    };
  }

  restoreFeedPanelConfiguration(panelId, checkpoint, now = new Date().toISOString()) {
    const normalized = normalizeFeedPanelConfigurationCheckpoint(checkpoint);
    cleanTimestamp(now, "Date de restauration");
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const panel = this.database
        .prepare("SELECT kind FROM panels WHERE id = ?")
        .get(panelId);
      if (panel?.kind !== "feed") throw new Error("Panel de flux introuvable.");

      const sourceExists = this.database.prepare("SELECT 1 FROM sources WHERE id = ?");
      for (const sourceId of normalized.sourceIds) {
        if (!sourceExists.get(sourceId)) throw new Error("Source restaurée introuvable.");
      }
      for (const { sourceId } of normalized.sourceConfigurations) {
        if (!sourceExists.get(sourceId)) throw new Error("Source sauvegardée introuvable.");
      }

      this.database
        .prepare(`
          UPDATE panels
          SET name = ?, default_refresh_interval_seconds = ?, updated_at = ?
          WHERE id = ? AND kind = 'feed'
        `)
        .run(
          normalized.name,
          normalized.defaultRefreshIntervalSeconds,
          normalized.updatedAt,
          panelId,
        );
      this.database.prepare("DELETE FROM panel_sources WHERE panel_id = ?").run(panelId);
      const attach = this.database.prepare(`
        INSERT INTO panel_sources (panel_id, source_id, position)
        VALUES (?, ?, ?)
      `);
      normalized.sourceIds.forEach((sourceId, position) => {
        attach.run(panelId, sourceId, position);
      });
      const restoreSourceConfiguration = this.database.prepare(`
        UPDATE sources
        SET name = ?, input_url = ?, feed_url = ?, connector_id = ?,
            connector_kind = ?, refresh_interval_seconds = ?, updated_at = ?
        WHERE id = ?
      `);
      for (const {
        sourceId,
        name,
        inputUrl,
        feedUrl,
        connectorId,
        connectorKind,
        refreshIntervalSeconds,
        updatedAt,
      } of normalized.sourceConfigurations) {
        restoreSourceConfiguration.run(
          name,
          inputUrl,
          feedUrl,
          connectorId,
          connectorKind,
          refreshIntervalSeconds,
          updatedAt,
          sourceId,
        );
      }
      this.#incrementContentRevision();
      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  attachSource(panelId, sourceId) {
    if (!this.hasPanel(panelId, "feed")) throw new Error("Panel de flux introuvable.");
    if (!this.getSource(sourceId)) throw new Error("Source introuvable.");
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const position = this.database
        .prepare(
          "SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM panel_sources WHERE panel_id = ?",
        )
        .get(panelId).next_position;
      const result = this.database
        .prepare(
          "INSERT OR IGNORE INTO panel_sources (panel_id, source_id, position) VALUES (?, ?, ?)",
        )
        .run(panelId, sourceId, position);
      if (result.changes > 0) this.#incrementContentRevision();
      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  detachSource(panelId, sourceId) {
    if (!this.hasPanel(panelId, "feed")) throw new Error("Panel de flux introuvable.");
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const result = this.database
        .prepare("DELETE FROM panel_sources WHERE panel_id = ? AND source_id = ?")
        .run(panelId, sourceId);
      if (result.changes > 0) this.#incrementContentRevision();
      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  listPanelSourceIds(panelId) {
    if (!this.hasPanel(panelId, "feed")) throw new Error("Panel de flux introuvable.");
    return this.database
      .prepare(`
        SELECT source_id
        FROM panel_sources
        WHERE panel_id = ?
        ORDER BY position ASC
      `)
      .all(panelId)
      .map(({ source_id: sourceId }) => sourceId);
  }

  getLatestArrivalBatchAt() {
    return this.database
      .prepare(`
        SELECT MAX(COALESCE(arrival_batch_at, first_seen_at)) AS arrival_batch_at
        FROM items
      `)
      .get()?.arrival_batch_at ?? null;
  }

  setSourceStatus(sourceId, status, values = {}, now = new Date().toISOString()) {
    const hasErrorMessage = Object.hasOwn(values, "errorMessage");
    const hasConsecutiveFailures = Object.hasOwn(values, "consecutiveFailures");
    const hasNextRetryAt = Object.hasOwn(values, "nextRetryAt");
    if (
      hasConsecutiveFailures &&
      (!Number.isInteger(values.consecutiveFailures) ||
        values.consecutiveFailures < 0 ||
        values.consecutiveFailures > 1_000_000)
    ) {
      throw new TypeError("Nombre d’échecs consécutifs invalide.");
    }
    const nextRetryAt =
      hasNextRetryAt && values.nextRetryAt !== null
        ? cleanTimestamp(values.nextRetryAt, "Date de nouvelle tentative")
        : null;
    const result = this.database
      .prepare(`
        UPDATE sources
        SET status = ?,
            last_checked_at = COALESCE(?, last_checked_at),
            last_success_at = COALESCE(?, last_success_at),
            error_message = CASE WHEN ? = 1 THEN ? ELSE error_message END,
            consecutive_failures = CASE WHEN ? = 1 THEN ? ELSE consecutive_failures END,
            next_retry_at = CASE WHEN ? = 1 THEN ? ELSE next_retry_at END,
            updated_at = ?
        WHERE id = ?
      `)
      .run(
        status,
        nullable(values.lastCheckedAt),
        nullable(values.lastSuccessAt),
        hasErrorMessage ? 1 : 0,
        nullable(values.errorMessage),
        hasConsecutiveFailures ? 1 : 0,
        hasConsecutiveFailures ? values.consecutiveFailures : 0,
        hasNextRetryAt ? 1 : 0,
        nextRetryAt,
        now,
        sourceId,
      );
    if (result.changes === 0) throw new Error("Source introuvable.");
  }

  upsertItems(
    sourceId,
    items,
    seenAt = new Date().toISOString(),
    arrivalBatchAt = seenAt,
  ) {
    const source = this.database
      .prepare("SELECT baseline_completed_at FROM sources WHERE id = ?")
      .get(sourceId);
    if (!source) throw new Error("Source introuvable.");
    const normalizedSeenAt = cleanTimestamp(seenAt, "Date d’observation");
    const normalizedArrivalBatchAt = cleanTimestamp(
      arrivalBatchAt,
      "Cycle de rafraîchissement",
    );
    const isInitialImport = source.baseline_completed_at === null;
    const statement = this.database.prepare(`
      INSERT INTO items (
        id, source_id, canonical_url, title, summary, image_url,
        published_at, updated_at, chronology_at, first_seen_at, arrival_batch_at,
        last_seen_at, is_baseline, seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, canonical_url) DO UPDATE SET
        title = excluded.title,
        summary = COALESCE(excluded.summary, items.summary),
        image_url = COALESCE(excluded.image_url, items.image_url),
        published_at = COALESCE(excluded.published_at, items.published_at),
        updated_at = COALESCE(excluded.updated_at, items.updated_at),
        chronology_at = COALESCE(
          excluded.published_at,
          items.published_at,
          excluded.updated_at,
          items.updated_at,
          items.first_seen_at
        ),
        last_seen_at = excluded.last_seen_at
    `);
    const findItem = this.database.prepare(`
      SELECT title, summary, image_url, published_at, updated_at
      FROM items WHERE source_id = ? AND canonical_url = ?
    `);

    this.database.exec("BEGIN IMMEDIATE;");
    try {
      let insertedCount = 0;
      let updatedCount = 0;
      const insertedItemIds = [];
      for (const item of items) {
        const canonicalUrl = cleanHttpUrl(item.canonicalUrl);
        const imageUrl = item.imageUrl == null ? null : cleanHttpUrl(item.imageUrl);
        const existingItem = findItem.get(sourceId, canonicalUrl);
        if (!existingItem) {
          insertedCount += 1;
          insertedItemIds.push(item.id);
        } else if (
          existingItem.title !== item.title ||
          (item.summary != null && existingItem.summary !== item.summary) ||
          (imageUrl != null && existingItem.image_url !== imageUrl) ||
          (item.publishedAt != null && existingItem.published_at !== item.publishedAt) ||
          (item.updatedAt != null && existingItem.updated_at !== item.updatedAt)
        ) {
          updatedCount += 1;
        }
        const firstSeenAt = item.firstSeenAt ?? normalizedSeenAt;
        const chronologyAt = item.publishedAt ?? item.updatedAt ?? firstSeenAt;
        statement.run(
          item.id,
          sourceId,
          canonicalUrl,
          item.title,
          nullable(item.summary),
          nullable(imageUrl),
          nullable(item.publishedAt),
          nullable(item.updatedAt),
          chronologyAt,
          firstSeenAt,
          normalizedArrivalBatchAt,
          normalizedSeenAt,
          isInitialImport ? 1 : 0,
          isInitialImport ? normalizedSeenAt : null,
        );
      }

      // An empty successful parse is not a baseline. Keep the source pending so
      // the first later non-empty response is classified as already seen.
      if (isInitialImport && insertedCount > 0) {
        this.database
          .prepare(
            "UPDATE sources SET baseline_completed_at = ?, updated_at = ? WHERE id = ?",
          )
          .run(normalizedSeenAt, normalizedSeenAt, sourceId);
        this.#appendPilotEvent(
          "source_baseline_completed",
          { sourceId, count: insertedCount },
          normalizedSeenAt,
        );
      } else if (insertedCount > 0) {
        this.#appendPilotEvent(
          "items_arrived",
          { sourceId, count: insertedCount },
          normalizedSeenAt,
        );
      }

      this.database
        .prepare(`
          DELETE FROM items
          WHERE source_id = ? AND id IN (
            SELECT id FROM items
            WHERE source_id = ?
            ORDER BY first_seen_at DESC, COALESCE(published_at, first_seen_at) DESC
            LIMIT -1 OFFSET ?
          )
        `)
        .run(sourceId, sourceId, MAX_ITEMS_PER_SOURCE);
      if (insertedCount > 0 || updatedCount > 0) this.#incrementContentRevision();
      if (insertedCount > 0 && !isInitialImport) {
        this.#incrementArrivalRevision();
        this.database.prepare(`
          UPDATE sources SET arrival_revision = arrival_revision + 1 WHERE id = ?
        `).run(sourceId);
      }
      this.database.exec("COMMIT;");
      return { insertedCount, updatedCount, insertedItemIds, isInitialImport };
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  markItemsSeen(itemIds, seenAt = new Date().toISOString()) {
    const ids = normalizeItemIds(itemIds);
    if (ids.length === 0) return 0;
    const normalizedSeenAt = cleanTimestamp(seenAt, "Date de lecture");
    const statement = this.database.prepare(`
      UPDATE items
      SET seen_at = COALESCE(seen_at, ?)
      WHERE id = ? AND seen_at IS NULL
    `);
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      let changed = 0;
      for (const itemId of ids) changed += Number(statement.run(normalizedSeenAt, itemId).changes);
      if (changed > 0) {
        this.#appendPilotEvent("items_seen", { count: changed }, normalizedSeenAt);
        this.#incrementContentRevision();
      }
      this.database.exec("COMMIT;");
      return changed;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  markItemOpened(itemId, openedAt = new Date().toISOString()) {
    const normalizedItemId = cleanIdentifier(itemId, "Article");
    const normalizedOpenedAt = cleanTimestamp(openedAt, "Date d’ouverture");
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const result = this.database
        .prepare(`
          UPDATE items
          SET opened_at = COALESCE(opened_at, ?),
              seen_at = COALESCE(seen_at, ?)
          WHERE id = ?
        `)
        .run(normalizedOpenedAt, normalizedOpenedAt, normalizedItemId);
      if (result.changes === 0) throw new Error("Article introuvable.");
      this.#incrementContentRevision();
      this.#appendPilotEvent(
        "item_opened",
        {},
        normalizedOpenedAt,
      );
      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  getEndpointCache(endpoint) {
    const row = this.database
      .prepare("SELECT * FROM endpoint_cache WHERE endpoint = ?")
      .get(endpoint);
    if (!row) return null;
    return {
      endpoint: row.endpoint,
      finalUrl: row.final_url ?? row.endpoint,
      body: row.body,
      contentType: row.content_type,
      etag: row.etag,
      lastModified: row.last_modified,
      fetchedAt: row.fetched_at,
      expiresAt: row.expires_at,
      statusCode: row.status_code,
    };
  }

  /**
   * Search is stored in a disposable sidecar. These bounded reads are the only
   * bridge from the authoritative cache into that derived store.
   */
  listSemanticSearchDocuments(sourceIds) {
    if (!Array.isArray(sourceIds) || sourceIds.length === 0) return [];
    const ids = [...new Set(sourceIds.map((sourceId) => cleanIdentifier(sourceId, "Source")))];
    const placeholders = ids.map(() => "?").join(", ");
    return this.database
      .prepare(`
        SELECT ranked.id, ranked.source_id, ranked.title, ranked.summary
        FROM (
          SELECT items.id, items.source_id, items.title, items.summary,
            ROW_NUMBER() OVER (
              PARTITION BY items.source_id
              ORDER BY items.first_seen_at DESC,
                COALESCE(items.published_at, items.updated_at, items.first_seen_at) DESC,
                items.id ASC
            ) AS source_rank
          FROM items
          WHERE items.source_id IN (${placeholders})
        ) AS ranked
        WHERE ranked.source_rank <= ?
      `)
      .all(...ids, MAX_ITEMS_PER_SOURCE)
      .map((row) => ({
        id: row.id,
        sourceId: row.source_id,
        title: row.title,
        summary: row.summary,
      }));
  }

  getSemanticSearchItems(itemIds) {
    if (!Array.isArray(itemIds) || itemIds.length === 0) return [];
    const ids = [...new Set(itemIds.map((itemId) => cleanIdentifier(itemId, "Article")))];
    if (ids.length > 200) throw new RangeError("Trop de résultats de recherche.");
    const placeholders = ids.map(() => "?").join(", ");
    return this.database
      .prepare(`
        SELECT items.*
        FROM items
        WHERE items.id IN (${placeholders})
          AND EXISTS (
            SELECT 1 FROM panel_sources WHERE panel_sources.source_id = items.source_id
          )
      `)
      .all(...ids)
      .map(toItem);
  }

  putEndpointCache(entry) {
    this.database
      .prepare(`
        INSERT INTO endpoint_cache (
          endpoint, final_url, body, content_type, etag, last_modified,
          fetched_at, expires_at, status_code
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET
          final_url = excluded.final_url,
          body = excluded.body,
          content_type = excluded.content_type,
          etag = excluded.etag,
          last_modified = excluded.last_modified,
          fetched_at = excluded.fetched_at,
          expires_at = excluded.expires_at,
          status_code = excluded.status_code
      `)
      .run(
        entry.endpoint,
        entry.finalUrl ?? entry.endpoint,
        entry.body,
        nullable(entry.contentType),
        nullable(entry.etag),
        nullable(entry.lastModified),
        entry.fetchedAt,
        entry.expiresAt,
        entry.statusCode ?? 200,
      );
    this.database
      .prepare(`
        DELETE FROM endpoint_cache
        WHERE endpoint IN (
          SELECT endpoint
          FROM endpoint_cache
          ORDER BY fetched_at DESC
          LIMIT -1 OFFSET ?
        )
      `)
      .run(MAX_ENDPOINT_CACHE_ENTRIES);

    const cacheBytes = Number(
      this.database
        .prepare("SELECT COALESCE(SUM(length(CAST(body AS BLOB))), 0) AS bytes FROM endpoint_cache")
        .get()?.bytes ?? 0,
    );
    if (cacheBytes > MAX_ENDPOINT_CACHE_BYTES) {
      let remainingBytes = cacheBytes;
      const oldestEntries = this.database
        .prepare(`
          SELECT endpoint, length(CAST(body AS BLOB)) AS bytes
          FROM endpoint_cache
          ORDER BY fetched_at ASC
        `)
        .all();
      const deleteEntry = this.database.prepare("DELETE FROM endpoint_cache WHERE endpoint = ?");
      for (const cached of oldestEntries) {
        deleteEntry.run(cached.endpoint);
        remainingBytes -= Number(cached.bytes ?? 0);
        if (remainingBytes <= ENDPOINT_CACHE_TRIM_BYTES) break;
      }
    }
  }

  deleteEndpointCache(endpoint) {
    this.database.prepare("DELETE FROM endpoint_cache WHERE endpoint = ?").run(endpoint);
  }

  touchEndpointCache(endpoint, { fetchedAt, expiresAt }) {
    this.database
      .prepare(
        "UPDATE endpoint_cache SET fetched_at = ?, expires_at = ? WHERE endpoint = ?",
      )
      .run(fetchedAt, expiresAt, endpoint);
  }

  getFeedPage(request) {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new TypeError("Page de fil invalide.");
    }
    const panelId = cleanIdentifier(request.panelId, "Panel");
    if (!this.hasPanel(panelId, "feed")) throw new Error("Panel de flux introuvable.");
    const sourceFilter = request.sourceFilter === "all"
      ? "all"
      : cleanIdentifier(request.sourceFilter, "Source");
    if (
      sourceFilter !== "all" &&
      !this.database
        .prepare("SELECT 1 FROM panel_sources WHERE panel_id = ? AND source_id = ?")
        .get(panelId, sourceFilter)
    ) {
      throw new Error("Cette source n’appartient pas au fil.");
    }
    const visibilityFilter = request.visibilityFilter ?? "all";
    if (visibilityFilter !== "all" && visibilityFilter !== "unseen") {
      throw new TypeError("Filtre de visibilité invalide.");
    }
    const offset = request.offset ?? 0;
    const limit = request.limit ?? MAX_FEED_PAGE_SIZE;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_FEED_PAGE_OFFSET) {
      throw new RangeError("Décalage de page invalide.");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_FEED_PAGE_SIZE) {
      throw new RangeError(`Une page contient au maximum ${MAX_FEED_PAGE_SIZE} articles.`);
    }
    const anchorItemId = request.anchorItemId == null
      ? null
      : cleanIdentifier(request.anchorItemId, "Article d’ancrage");
    const focusedItemId = request.focusedItemId == null
      ? null
      : cleanIdentifier(request.focusedItemId, "Article focalisé");
    const where = ["panel_sources.panel_id = ?"];
    const parameters = [panelId];
    if (sourceFilter !== "all") {
      where.push("items.source_id = ?");
      parameters.push(sourceFilter);
    }
    if (visibilityFilter === "unseen") {
      if (focusedItemId) {
        where.push("(items.seen_at IS NULL OR items.id = ?)");
        parameters.push(focusedItemId);
      } else {
        where.push("items.seen_at IS NULL");
      }
    }
    const filteredSql = `
      SELECT items.*
      FROM items
      JOIN panel_sources ON panel_sources.source_id = items.source_id
      WHERE ${where.join(" AND ")}
    `;
    const orderBySql = `
      items.is_baseline ASC,
      items.chronology_at DESC,
      items.first_seen_at DESC, items.id ASC
    `;
    const rankedSql = `
      SELECT filtered.*,
        ROW_NUMBER() OVER (
          ORDER BY filtered.is_baseline ASC,
            filtered.chronology_at DESC,
            filtered.first_seen_at DESC, filtered.id ASC
        ) - 1 AS feed_index
      FROM (${filteredSql}) AS filtered
    `;

    this.database.exec("BEGIN;");
    try {
      const revision = this.#contentRevision();
      const queryTotalCount = Number(
        this.database.prepare(`SELECT COUNT(*) AS count FROM (${filteredSql})`).get(...parameters).count,
      );
      const panelTotalCount = Number(this.database.prepare(`
        SELECT COUNT(*) AS count
        FROM items
        JOIN panel_sources ON panel_sources.source_id = items.source_id
        WHERE panel_sources.panel_id = ?
      `).get(panelId).count);
      const panelUnseenCount = Number(this.database.prepare(`
        SELECT COUNT(*) AS count
        FROM items
        JOIN panel_sources ON panel_sources.source_id = items.source_id
        WHERE panel_sources.panel_id = ? AND items.seen_at IS NULL
      `).get(panelId).count);
      const rowsWithBoundary = this.database.prepare(`
        SELECT items.*
        FROM items
        JOIN panel_sources ON panel_sources.source_id = items.source_id
        WHERE ${where.join(" AND ")}
        ORDER BY ${orderBySql}
        LIMIT ? OFFSET ?
      `).all(
        ...parameters,
        limit + (offset > 0 ? 1 : 0),
        Math.max(0, offset - 1),
      );
      const previousRow = offset > 0 ? rowsWithBoundary.shift() : null;
      const pageRows = rowsWithBoundary;
      const anchorRow = anchorItemId
        ? this.database.prepare(`
            SELECT feed_index FROM (${rankedSql})
            WHERE id = ?
          `).get(...parameters, anchorItemId)
        : null;
      this.database.exec("COMMIT;");
      return {
        revision,
        offset,
        queryTotalCount,
        panelTotalCount,
        panelUnseenCount,
        anchorIndex: anchorRow ? Number(anchorRow.feed_index) : null,
        previousItemDate: previousRow?.chronology_at ?? null,
        items: pageRows.map(toItem),
      };
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  getState(now = new Date().toISOString(), { includeItems = true } = {}) {
    const panels = this.database
      .prepare(`
        SELECT panels.id, panels.name, panels.kind, panels.web_url,
          panels.default_refresh_interval_seconds,
          COALESCE((
            SELECT GROUP_CONCAT(ordered_sources.source_id, char(31))
            FROM (
              SELECT panel_sources.source_id
              FROM panel_sources
              WHERE panel_sources.panel_id = panels.id
              ORDER BY panel_sources.position ASC
            ) AS ordered_sources
          ), '') AS source_ids
        FROM panels
        ORDER BY panels.position ASC
      `)
      .all()
      .map((row) =>
        row.kind === "web"
          ? { id: row.id, kind: "web", name: row.name, url: row.web_url ?? "" }
          : {
              id: row.id,
              kind: "feed",
              name: row.name,
              sourceIds: row.source_ids ? row.source_ids.split(String.fromCharCode(31)) : [],
              defaultRefreshIntervalSeconds:
                row.default_refresh_interval_seconds ?? DEFAULT_REFRESH_INTERVAL_SECONDS,
            },
      );

    const items = includeItems ? this.database
      .prepare(`
        SELECT ranked.* FROM (
          SELECT items.*,
            ROW_NUMBER() OVER (
              PARTITION BY items.source_id
              ORDER BY items.is_baseline ASC,
                CASE WHEN items.is_baseline = 0 THEN items.first_seen_at END DESC,
                COALESCE(items.published_at, items.updated_at, items.first_seen_at) DESC,
                items.first_seen_at DESC,
                items.id ASC
            ) AS source_rank
          FROM items
          WHERE EXISTS (
            SELECT 1 FROM panel_sources WHERE panel_sources.source_id = items.source_id
          )
        ) AS ranked
        WHERE ranked.source_rank <= 500
        ORDER BY ranked.is_baseline ASC,
          COALESCE(ranked.published_at, ranked.updated_at, ranked.first_seen_at) DESC,
          ranked.first_seen_at DESC,
          ranked.id ASC
      `)
      .all()
      .map(toItem) : [];

    return {
      dashboard: this.getDashboardState(),
      panels,
      sources: this.listSources({ attachedOnly: true }),
      items,
      contentRevision: this.#contentRevision(),
      arrivalRevision: this.#arrivalRevision(),
      refreshedAt: now,
    };
  }
}

export function createLocalFeedDatabase(databasePath, options) {
  return new LocalFeedDatabase(databasePath, options);
}
