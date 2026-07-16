import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { annotateAppStateItemDelta } from "./app-state-delta.ts";
import { annotateScheduledRefresh } from "./app-state-refresh.ts";
import { WebPreviewAuthorizations } from "./web-preview-authorizations.ts";
import type {
  AppState,
  CreatePanelInput,
  FeedPanelConfigurationDraft,
  FeedPage,
  FeedItem,
  LayoutNode,
  Panel,
  PanelPlacement,
  SemanticSearchMode,
  SemanticSearchResult,
  SemanticSearchScope,
  SemanticSearchStatus,
  Source,
  SourceProbeRequest,
  SourceProbeResult,
  SourceRequest,
  UpdateState,
  VibeDeckApi,
  WebPanelDescriptor,
  WebPanelRuntimeState,
} from "./types";

type TauriBootstrap = {
  sessionId: string;
  revision: number;
  dashboard: {
    layout: LayoutNode | null;
    revision: number;
  };
  panels: Panel[];
  sources: Source[];
  firstPageByPanel: Record<string, FeedPage>;
};

type TauriItemReadState = {
  itemId: string;
  seenAt: string | null;
  openedAt: string | null;
};

type TauriStateChange =
  | { kind: "dashboard"; dashboard: TauriBootstrap["dashboard"] }
  | { kind: "panelUpsert"; panel: Panel }
  | { kind: "panelRemove"; panelId: string }
  | { kind: "sourceUpsert"; source: Source }
  | { kind: "itemsUpsert"; items: FeedItem[] }
  | { kind: "itemsReadState"; items: TauriItemReadState[] }
  | { kind: "panelInvalidated"; panelId: string; reason: string }
  | {
      kind: "refreshScheduled";
      scope:
        | { kind: "source"; sourceId: string }
        | { kind: "panel"; panelId: string }
        | { kind: "all" };
      sourceCount: number;
    };

type TauriStatePatch = {
  sessionId: string;
  baseRevision: number;
  revision: number;
  operationId: string;
  changes: TauriStateChange[];
};

type TauriStateStreamMessage =
  | { type: "patch"; patch: TauriStatePatch }
  | { type: "searchStatus"; status: TauriSearchStatus }
  | {
      type: "resyncRequired";
      sessionId: string;
      currentRevision: number;
      reason: string;
    };

type TauriMutationCommand =
  | { command: "createPanel"; input: CreatePanelInput; placement?: PanelPlacement }
  | { command: "deletePanel"; panelId: string }
  | { command: "setWebPanelUrl"; panelId: string; url: string }
  | {
      command: "setFeedPanelDefaultRefresh";
      panelId: string;
      refreshIntervalSeconds: number;
    }
  | {
      command: "addGenericSource";
      panelId: string;
      source: {
        name: string;
        inputUrl: string;
        feedUrl: string;
        connectorKind: "rss" | "atom" | "news-sitemap";
        refreshIntervalSeconds: number;
      };
      position?: number;
    }
  | { command: "attachSource"; panelId: string; sourceId: string; position?: number }
  | { command: "detachSource"; panelId: string; sourceId: string }
  | { command: "setLayout"; layout: LayoutNode | null }
  | { command: "renamePanel"; panelId: string; name: string }
  | { command: "markItemsSeen"; itemIds: string[]; at: string }
  | { command: "markItemOpened"; itemId: string; at: string }
  | { command: "forceRefreshSource"; sourceId: string }
  | { command: "forceRefreshPanel"; panelId: string }
  | { command: "forceRefreshAll" };

type TauriMutationAck = {
  operationId: string;
  committedRevision: number;
};

type TauriSearchStatus = {
  lexicalReady: boolean;
  semanticReady: boolean;
};

type TauriSearchHit = {
  item: FeedItem;
  scoreMicros: number;
};

type TauriFeedProbeResponse = {
  finalUrl: string;
  connectorKind: "rss" | "atom" | "news-sitemap";
  title: string | null;
  itemCount: number;
  samples: Array<{ title: string; publishedAt: string | null }>;
};

type TauriWebPanelViewState = {
  panelId: string;
  generation: number;
  sequence: number;
  bounds: { x: number; y: number; width: number; height: number };
  phase: "queued" | "loading" | "ready" | "failed";
  requestedVisible: boolean;
  visible: boolean;
};

export function compareWebPanelStateOrder(
  first: Pick<TauriWebPanelViewState, "generation" | "sequence">,
  second: Pick<TauriWebPanelViewState, "generation" | "sequence">,
) {
  return first.generation === second.generation
    ? first.sequence - second.sequence
    : first.generation - second.generation;
}

type TauriWebPanelDescriptor = {
  panelId: string;
  url: string;
  bounds: TauriWebPanelViewState["bounds"];
  visible: boolean;
};

type OperationWaiter = {
  revision: number;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: number;
};

type PanelPagingState = {
  cursor: string | null;
  revision: number;
  exhausted: boolean;
  generation: number;
  inFlight: Promise<FeedPage> | null;
};

export type FeedPageChainPosition = Pick<
  PanelPagingState,
  "cursor" | "revision" | "exhausted" | "generation"
>;

export function rebuildFeedPageChainFromHead(
  previous: FeedPageChainPosition | undefined,
  revision: number,
): FeedPageChainPosition {
  return {
    cursor: null,
    revision: Math.max(revision, previous?.revision ?? 0),
    exhausted: false,
    generation: (previous?.generation ?? 0) + 1,
  };
}

export function advanceFeedPageChain(
  current: FeedPageChainPosition,
  page: Pick<FeedPage, "revision" | "nextCursor">,
): FeedPageChainPosition {
  return {
    cursor: page.nextCursor,
    revision: page.revision,
    exhausted: page.nextCursor === null,
    generation: current.generation,
  };
}

export function shouldApplyAuthoritativeBootstrap(
  current: { sessionId: string; revision: number } | null,
  incoming: { sessionId: string; revision: number },
  requestSequence: number,
  latestAppliedSequence: number,
) {
  if (requestSequence < latestAppliedSequence) return false;
  return !current || current.sessionId !== incoming.sessionId || incoming.revision >= current.revision;
}

export function createRetryableBootstrapGate<T>(
  getAuthoritativeState: () => T | null,
  requestBootstrap: () => Promise<T>,
) {
  return () => {
    const authoritativeState = getAuthoritativeState();
    return authoritativeState === null
      ? requestBootstrap()
      : Promise.resolve(authoritativeState);
  };
}

export function isFeedPageRevisionCurrent(
  pageRevision: number,
  pagingRevision: number,
  dashboardRevision: number,
) {
  return pageRevision >= pagingRevision && pageRevision >= dashboardRevision;
}

type AppliedPatch = {
  state: AppState;
  invalidatedPanelIds: string[];
  removedPanelIds: string[];
};

const STATIC_UPDATE_STATE: UpdateState = {
  status: "disabled",
  currentVersion: "",
  availableVersion: null,
  progressPercent: null,
  checkedAt: null,
  message: "Les mises à jour Tauri ne sont pas encore disponibles.",
};

const STATIC_SEMANTIC_STATUS: SemanticSearchStatus = {
  phase: "indexing",
  progress: 0,
  message: "Préparation de l’index lexical local…",
  bytes: 0,
  semanticReady: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function hasTauriErrorCode(error: unknown, expectedCode: string) {
  let current = error;
  for (let depth = 0; depth < 4 && current !== undefined; depth += 1) {
    if (isRecord(current) && current.code === expectedCode) return true;
    current = current instanceof Error
      ? current.cause
      : isRecord(current)
        ? current.cause
        : undefined;
  }
  return false;
}

function tauriError(operation: string, cause?: unknown) {
  const detail =
    cause instanceof Error
      ? cause.message
      : isRecord(cause) && typeof cause.message === "string"
        ? cause.message
        : typeof cause === "string"
          ? cause
          : null;
  return new Error(
    detail
      ? `${operation} : ${detail}`
      : `${operation} n’est pas disponible dans cette version Tauri.`,
    cause === undefined ? undefined : { cause },
  );
}

function unsupported(operation: string) {
  return (..._arguments: unknown[]) => Promise.reject(tauriError(operation));
}

function passiveSubscription<T>() {
  return (_callback: (value: T) => void) => () => undefined;
}

function parseBootstrap(value: unknown, origin: string): TauriBootstrap {
  if (!isRecord(value)) throw tauriError(origin, "Réponse vide ou invalide.");
  const { sessionId, revision, dashboard, panels, sources, firstPageByPanel } = value;
  if (
    typeof sessionId !== "string" ||
    !isRevision(revision) ||
    !isRecord(dashboard) ||
    !isRevision(dashboard.revision) ||
    dashboard.revision !== revision ||
    !Array.isArray(panels) ||
    !Array.isArray(sources) ||
    !isRecord(firstPageByPanel)
  ) {
    throw tauriError(origin, "Contrat de bootstrap invalide.");
  }

  for (const [panelId, page] of Object.entries(firstPageByPanel)) {
    if (
      !panelId ||
      !isRecord(page) ||
      !isRevision(page.revision) ||
      page.revision !== revision ||
      !Array.isArray(page.items) ||
      page.items.length > 200 ||
      !(page.nextCursor === null || typeof page.nextCursor === "string")
    ) {
      throw tauriError(origin, `Première page invalide pour le panel ${panelId || "inconnu"}.`);
    }
  }

  return value as TauriBootstrap;
}

function parseFeedItem(value: unknown, origin: string): FeedItem {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.sourceId !== "string" ||
    value.sourceId.length === 0
  ) {
    throw tauriError(origin, "Article invalide.");
  }
  return value as unknown as FeedItem;
}

function parseFeedPage(value: unknown, origin: string): FeedPage {
  if (
    !isRecord(value) ||
    !isRevision(value.revision) ||
    !Array.isArray(value.items) ||
    value.items.length > 200 ||
    !(value.nextCursor === null || typeof value.nextCursor === "string")
  ) {
    throw tauriError(origin, "Page invalide.");
  }
  return {
    revision: value.revision,
    items: value.items.map((item) => parseFeedItem(item, origin)),
    nextCursor: value.nextCursor,
  };
}

function parseTauriSearchStatus(value: unknown): TauriSearchStatus {
  if (
    !isRecord(value) ||
    typeof value.lexicalReady !== "boolean" ||
    typeof value.semanticReady !== "boolean"
  ) {
    throw tauriError("État de recherche Tauri", "État natif invalide.");
  }
  return {
    lexicalReady: value.lexicalReady,
    semanticReady: value.semanticReady,
  };
}

function publicSearchStatus(status: TauriSearchStatus): SemanticSearchStatus {
  return {
    phase: status.lexicalReady ? "ready" : "indexing",
    progress: status.lexicalReady ? 1 : 0,
    message: status.lexicalReady
      ? status.semanticReady
        ? null
        : "Recherche lexicale locale prête. Le modèle sémantique reste désactivé."
      : "Préparation de l’index lexical local…",
    bytes: 0,
    semanticReady: status.semanticReady,
  };
}

function parseSearchHits(value: unknown): TauriSearchHit[] {
  if (!Array.isArray(value) || value.length > 200) {
    throw tauriError("Recherche Tauri", "Résultats natifs invalides.");
  }
  return value.map((candidate) => {
    if (
      !isRecord(candidate) ||
      !Number.isSafeInteger(candidate.scoreMicros) ||
      Number(candidate.scoreMicros) < 0
    ) {
      throw tauriError("Recherche Tauri", "Résultat natif invalide.");
    }
    return {
      item: parseFeedItem(candidate.item, "Recherche Tauri"),
      scoreMicros: Number(candidate.scoreMicros),
    };
  });
}

function normalizeSourceUrl(value: string) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 4_096) {
    throw tauriError("Détection de flux", "URL de source invalide.");
  }
  const trimmed = value.trim();
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw tauriError("Détection de flux", "URL de source invalide.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.href.length > 4_096
  ) {
    throw tauriError("Détection de flux", "Seules les URLs HTTP(S) sans identifiants sont acceptées.");
  }
  url.hash = "";
  return url.href;
}

function normalizeWebUrl(value: string) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 4_096) {
    throw tauriError("Page web", "URL invalide.");
  }
  const trimmed = value.trim();
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw tauriError("Page web", "URL invalide.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.href.length > 4_096
  ) {
    throw tauriError("Page web", "Seules les URLs HTTP(S) sans identifiants sont acceptées.");
  }
  return url.href;
}

function normalizeWebPreviewId(value: string) {
  if (
    typeof value !== "string" ||
    !/^draft:[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(
      value.trim(),
    )
  ) {
    throw tauriError("Prévisualisation web", "Identifiant invalide.");
  }
  return value.trim();
}

function parseProbeResponse(value: unknown): TauriFeedProbeResponse {
  if (
    !isRecord(value) ||
    typeof value.finalUrl !== "string" ||
    !["rss", "atom", "news-sitemap"].includes(String(value.connectorKind)) ||
    !(value.title === null || typeof value.title === "string") ||
    !Number.isInteger(value.itemCount) ||
    Number(value.itemCount) < 0 ||
    Number(value.itemCount) > 2_000 ||
    !Array.isArray(value.samples) ||
    value.samples.length > 3 ||
    value.samples.some((sample) =>
      !isRecord(sample) ||
      typeof sample.title !== "string" ||
      !(sample.publishedAt === null || typeof sample.publishedAt === "string")
    )
  ) {
    throw tauriError("Détection de flux", "Réponse de détection invalide.");
  }
  const finalUrl = normalizeSourceUrl(value.finalUrl);
  return { ...(value as unknown as TauriFeedProbeResponse), finalUrl };
}

function normalizedSourceRequest(source: string | SourceRequest | SourceProbeRequest) {
  const request = typeof source === "string" ? { url: source } : source;
  const inputUrl = normalizeSourceUrl(request.url);
  const connectorKind = request.connectorKind ?? "auto";
  if (!["auto", "rss", "atom", "news-sitemap"].includes(connectorKind)) {
    throw tauriError("Détection de flux", "Type de connecteur invalide.");
  }
  return { inputUrl, connectorKind };
}

async function invokeFeedProbe(
  source: string | SourceRequest | SourceProbeRequest,
  probeId: string = crypto.randomUUID(),
) {
  const request = normalizedSourceRequest(source);
  const response = parseProbeResponse(await invoke<unknown>("probe_feed", {
    probeId,
    request: {
      url: request.inputUrl,
      ...(request.connectorKind === "auto" ? {} : { connectorKind: request.connectorKind }),
    },
  }));
  return { request, response };
}

function publicProbeResult(
  inputUrl: string,
  response: TauriFeedProbeResponse,
): SourceProbeResult {
  const fallbackName = new URL(response.finalUrl).hostname.replace(/^www\./, "");
  return {
    normalizedInputUrl: inputUrl,
    name: response.title?.trim() || fallbackName,
    connectorKind: response.connectorKind,
    connectorId: null,
    itemCount: response.itemCount,
    samples: response.samples,
    freshness: "fresh",
    warning: null,
  };
}

function parseWebPanelViewStates(value: unknown): TauriWebPanelViewState[] {
  if (!Array.isArray(value) || value.length > 6) {
    throw tauriError("Synchronisation des pages web", "État natif invalide.");
  }
  return value.map((candidate) => {
    if (!isRecord(candidate)) {
      throw tauriError("Synchronisation des pages web", "État natif invalide.");
    }
    const bounds = candidate.bounds;
    if (
      typeof candidate.panelId !== "string" ||
      !Number.isSafeInteger(candidate.generation) ||
      Number(candidate.generation) < 0 ||
      !Number.isSafeInteger(candidate.sequence) ||
      Number(candidate.sequence) < 0 ||
      !isRecord(bounds) ||
      !["x", "y", "width", "height"].every((key) =>
        typeof bounds[key] === "number" && Number.isFinite(bounds[key])) ||
      !["queued", "loading", "ready", "failed"].includes(String(candidate.phase)) ||
      typeof candidate.requestedVisible !== "boolean" ||
      typeof candidate.visible !== "boolean"
    ) {
      throw tauriError("Synchronisation des pages web", "État natif invalide.");
    }
    return candidate as unknown as TauriWebPanelViewState;
  });
}

function parseWebPanelViewState(value: unknown, operation: string): TauriWebPanelViewState {
  const [state, ...unexpected] = parseWebPanelViewStates([value]);
  if (!state || unexpected.length > 0) {
    throw tauriError(operation, "État natif invalide.");
  }
  return state;
}

function runtimeWebPanelState(
  native: TauriWebPanelViewState,
  descriptor: TauriWebPanelDescriptor,
  currentUrl = descriptor.url,
  mediaSuspended = false,
): WebPanelRuntimeState {
  const loading = native.phase === "queued" || native.phase === "loading";
  const failed = native.phase === "failed";
  const historyActionAvailable = !loading && !failed;
  return {
    panelId: native.panelId,
    status: failed ? "error" : loading ? "loading" : "ready",
    homeUrl: descriptor.url,
    url: currentUrl,
    title: "",
    loading,
    // Wry does not expose a portable history cursor. Keep both bounded native
    // history actions reachable when the view is ready: history.go(±1) is a
    // harmless no-op at either end and real page-load events drive the state.
    canGoBack: historyActionAvailable,
    canGoForward: historyActionAvailable,
    muted: mediaSuspended,
    visible: native.visible,
    requestedVisible: native.requestedVisible,
    bounds: native.bounds,
    error: failed ? "La page web native n’a pas pu être chargée." : null,
    errorCode: null,
    crashed: false,
    unresponsive: false,
    destroyed: false,
    readerMode: null,
    readerFallback: null,
  };
}

export function normalizeTauriWebPanelDescriptors(
  panels: readonly WebPanelDescriptor[],
  previewUrls: ReadonlyMap<string, string>,
): TauriWebPanelDescriptor[] {
  const descriptors = panels.flatMap((panel): TauriWebPanelDescriptor[] => {
    if (panel.kind === "reader") return [];
    if (panel.kind !== "web" && panel.kind !== "preview") {
      throw tauriError("Synchronisation des pages web", "Type de panel natif invalide.");
    }
    const url = panel.kind === "web"
      ? normalizeWebUrl(panel.url)
      : previewUrls.get(normalizeWebPreviewId(panel.panelId));
    // A cancellation revokes the main-window authorization before the async
    // native destroy completes. A stale one-way React descriptor must be
    // ignored fail-closed instead of throwing from the next animation frame.
    if (!url) return [];
    return [{
      panelId: panel.panelId,
      url,
      bounds: panel.bounds,
      visible: panel.visible,
    }];
  });
  if (
    descriptors.length > 6 ||
    new Set(descriptors.map(({ panelId }) => panelId)).size !== descriptors.length
  ) {
    throw tauriError("Synchronisation des pages web", "Liste de panels native invalide.");
  }
  return descriptors;
}

/**
 * Merge incrémental testable indépendamment du runtime Tauri. Une réponse de
 * page arrivée en même temps qu'un patch Vu/Ouvert ne peut jamais faire
 * régresser ces deux marqueurs persistants.
 */
export function mergeFeedItemsById(
  current: readonly FeedItem[],
  incoming: readonly FeedItem[],
  indexById = new Map(current.map((item, index) => [item.id, index])),
): FeedItem[] {
  if (incoming.length === 0) return current as FeedItem[];
  // `items` is a renderer-compatibility projection owned by this facade. The
  // normalized external store is the observable source of truth and consumes
  // the bounded delta hint emitted immediately after this synchronous update.
  // Mutating known slots here avoids copying 25k references for a <= 200 item
  // native page/patch while keeping every public AppState shape unchanged.
  const merged = current as FeedItem[];
  for (const nextItem of incoming) {
    const index = indexById.get(nextItem.id);
    if (index === undefined) {
      indexById.set(nextItem.id, merged.length);
      merged.push(nextItem);
      continue;
    }
    const previous = merged[index];
    merged[index] = {
      ...nextItem,
      seenAt: previous.seenAt ?? nextItem.seenAt,
      openedAt: previous.openedAt ?? nextItem.openedAt,
    };
  }
  return merged;
}

export const MAX_DETACHED_SEARCH_ITEMS = 400;

/**
 * Retain search-only entities without adding them to the paged compatibility
 * array. Map insertion order gives us a tiny deterministic LRU: two complete
 * 200-result searches fit, and older inactive queries are evicted.
 */
export function retainDetachedSearchItems(
  cache: Map<string, FeedItem>,
  incoming: readonly FeedItem[],
  loadedIndexById: ReadonlyMap<string, number>,
  maximum = MAX_DETACHED_SEARCH_ITEMS,
) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 2_000) {
    throw new Error("Limite du cache de recherche invalide.");
  }
  for (const item of incoming) {
    if (loadedIndexById.has(item.id)) {
      cache.delete(item.id);
      continue;
    }
    cache.delete(item.id);
    cache.set(item.id, item);
  }
  while (cache.size > maximum) {
    const oldestId = cache.keys().next().value;
    if (typeof oldestId !== "string") break;
    cache.delete(oldestId);
  }
  return cache;
}

export function bootstrapToAppState(bootstrap: TauriBootstrap): AppState {
  const itemsById = new Map<string, FeedItem>();
  for (const page of Object.values(bootstrap.firstPageByPanel)) {
    for (const item of page.items) {
      if (!item || typeof item.id !== "string") {
        throw tauriError("Bootstrap Tauri", "Article sans identifiant.");
      }
      const existing = itemsById.get(item.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(item)) {
        throw tauriError("Bootstrap Tauri", `Article partagé incohérent (${item.id}).`);
      }
      itemsById.set(item.id, item);
    }
  }
  return {
    dashboard: bootstrap.dashboard,
    panels: bootstrap.panels,
    sources: bootstrap.sources,
    sourceCatalog: [],
    items: [...itemsById.values()],
    refreshedAt: new Date().toISOString(),
  };
}

function mergeBootstrapWithLoadedState(bootstrap: TauriBootstrap, previous: AppState): AppState {
  const fresh = bootstrapToAppState(bootstrap);
  return {
    ...fresh,
    // Les premières pages autoritatives gagnent pour les champs éditoriaux,
    // tandis que l'historique déjà paginé reste disponible et dédupliqué.
    items: mergeFeedItemsById(previous.items, fresh.items),
  };
}

function parsePatch(value: unknown): TauriStatePatch {
  if (
    !isRecord(value) ||
    typeof value.sessionId !== "string" ||
    typeof value.operationId !== "string" ||
    !isRevision(value.baseRevision) ||
    !isRevision(value.revision) ||
    value.revision !== value.baseRevision + 1 ||
    !Array.isArray(value.changes)
  ) {
    throw tauriError("Patch Tauri", "Contrat de patch invalide.");
  }
  return value as TauriStatePatch;
}

export function applyPatchToState(
  state: AppState,
  patch: TauriStatePatch,
  itemIndexById = new Map(state.items.map((item, index) => [item.id, index])),
  detachedSearchItemsById = new Map<string, FeedItem>(),
): AppliedPatch {
  let dashboard = state.dashboard;
  let panels = state.panels;
  let sources = state.sources;
  let items = state.items;
  const invalidatedPanelIds: string[] = [];
  const removedPanelIds: string[] = [];
  const itemUpsertsById = new Map<string, FeedItem>();
  const itemReadStatesById = new Map<string, TauriItemReadState>();
  const pendingItemChanges: Array<
    | { kind: "upsert"; items: FeedItem[] }
    | { kind: "readState"; items: TauriItemReadState[] }
  > = [];
  let pendingItemCount = 0;

  for (const change of patch.changes) {
    switch (change.kind) {
      case "dashboard":
        if (change.dashboard.revision !== patch.revision) {
          throw tauriError("Patch Tauri", "Révision de dashboard incohérente.");
        }
        dashboard = change.dashboard;
        break;
      case "panelUpsert": {
        if (!change.panel || typeof change.panel.id !== "string") {
          throw tauriError("Patch Tauri", "Panel invalide.");
        }
        const index = panels.findIndex(({ id }) => id === change.panel.id);
        panels = index < 0
          ? [...panels, change.panel]
          : panels.map((panel, panelIndex) => panelIndex === index ? change.panel : panel);
        break;
      }
      case "panelRemove":
        if (typeof change.panelId !== "string" || !panels.some(({ id }) => id === change.panelId)) {
          throw tauriError("Patch Tauri", "Suppression d’un panel inconnu.");
        }
        panels = panels.filter(({ id }) => id !== change.panelId);
        removedPanelIds.push(change.panelId);
        break;
      case "sourceUpsert": {
        if (!change.source || typeof change.source.id !== "string") {
          throw tauriError("Patch Tauri", "Source invalide.");
        }
        const index = sources.findIndex(({ id }) => id === change.source.id);
        sources = index < 0
          ? [...sources, change.source]
          : sources.map((source, sourceIndex) => sourceIndex === index ? change.source : source);
        break;
      }
      case "itemsUpsert":
        if (!Array.isArray(change.items) || change.items.length > 200) {
          throw tauriError("Patch Tauri", "Lot d’articles invalide.");
        }
        pendingItemCount += change.items.length;
        if (pendingItemCount > 200) {
          throw tauriError("Patch Tauri", "Lot d’articles cumulé invalide.");
        }
        pendingItemChanges.push({
          kind: "upsert",
          items: change.items.map((item) => parseFeedItem(item, "Patch Tauri")),
        });
        break;
      case "itemsReadState": {
        if (!Array.isArray(change.items) || change.items.length > 200) {
          throw tauriError("Patch Tauri", "Lot de statuts de lecture invalide.");
        }
        pendingItemCount += change.items.length;
        if (pendingItemCount > 200) {
          throw tauriError("Patch Tauri", "Lot de statuts cumulé invalide.");
        }
        const seenItemIds = new Set<string>();
        const readStates: TauriItemReadState[] = [];
        for (const readState of change.items) {
          if (
            !readState ||
            typeof readState.itemId !== "string" ||
            !readState.itemId ||
            seenItemIds.has(readState.itemId) ||
            !(readState.seenAt === null || typeof readState.seenAt === "string") ||
            !(readState.openedAt === null || typeof readState.openedAt === "string")
          ) {
            throw tauriError("Patch Tauri", "Statut de lecture invalide.");
          }
          seenItemIds.add(readState.itemId);
          readStates.push(readState);
        }
        pendingItemChanges.push({ kind: "readState", items: readStates });
        break;
      }
      case "panelInvalidated":
        invalidatedPanelIds.push(change.panelId);
        break;
      case "refreshScheduled":
        if (
          !Number.isInteger(change.sourceCount) ||
          change.sourceCount < 1 ||
          change.sourceCount > 1_536 ||
          !change.scope ||
          !["source", "panel", "all"].includes(change.scope.kind) ||
          (change.scope.kind === "source" && typeof change.scope.sourceId !== "string") ||
          (change.scope.kind === "panel" && typeof change.scope.panelId !== "string")
        ) {
          throw tauriError("Patch Tauri", "Planification d’actualisation invalide.");
        }
        break;
      default:
        throw tauriError("Patch Tauri", "Type de changement inconnu.");
    }
  }

  // Validate the complete patch before touching the facade-owned compatibility
  // array. A malformed later change can therefore never leave a partial native
  // item delta visible while the Channel falls back to a resynchronization.
  for (const itemChange of pendingItemChanges) {
    if (itemChange.kind === "upsert") {
      items = mergeFeedItemsById(items, itemChange.items, itemIndexById);
      for (const item of itemChange.items) {
        const index = itemIndexById.get(item.id);
        if (index !== undefined) {
          detachedSearchItemsById.delete(item.id);
          itemReadStatesById.delete(item.id);
          itemUpsertsById.set(item.id, items[index]);
        }
      }
      continue;
    }
    for (const readState of itemChange.items) {
      const index = itemIndexById.get(readState.itemId);
      const item = index === undefined
        ? detachedSearchItemsById.get(readState.itemId)
        : items[index];
      if (!item) {
        // The normalized store may still own this row because it belongs to
        // the currently applied search. Preserve the bounded read delta even
        // after draft searches evicted the full entity from our LRU.
        itemReadStatesById.set(readState.itemId, readState);
        continue;
      }
      const nextItem = {
        ...item,
        seenAt: readState.seenAt,
        openedAt: readState.openedAt,
      };
      if (index === undefined) {
        // Refresh insertion order so a currently interacted-with result is
        // the last detached entity to be evicted by a subsequent search.
        detachedSearchItemsById.delete(nextItem.id);
        detachedSearchItemsById.set(nextItem.id, nextItem);
      } else {
        items[index] = nextItem;
      }
      itemReadStatesById.delete(nextItem.id);
      itemUpsertsById.set(nextItem.id, nextItem);
    }
  }

  const nextState = {
    ...state,
    dashboard: { ...dashboard, revision: patch.revision },
    panels,
    sources,
    items,
    refreshedAt: new Date().toISOString(),
  };
  if (itemUpsertsById.size > 0 || itemReadStatesById.size > 0) {
    annotateAppStateItemDelta(nextState, {
      itemUpserts: [...itemUpsertsById.values()],
      itemReadStates: [...itemReadStatesById.values()],
    });
  }
  return {
    state: nextState,
    invalidatedPanelIds,
    removedPanelIds,
  };
}

function createTauriFacade(): VibeDeckApi {
  let state: AppState | null = null;
  let sessionId: string | null = null;
  let authoritativeReady = false;
  let bootstrapInFlight: Promise<AppState> | null = null;
  let bootstrapRequestSequence = 0;
  let latestAppliedBootstrapSequence = 0;
  let mutationTail: Promise<unknown> = Promise.resolve();
  let streamTail: Promise<unknown> = Promise.resolve();
  let dataGeneration = 0;
  let itemIndexById = new Map<string, number>();
  const detachedSearchItemsById = new Map<string, FeedItem>();
  let semanticStatus = STATIC_SEMANTIC_STATUS;
  const stateListeners = new Set<(nextState: AppState) => void>();
  const webStateListeners = new Set<(nextState: WebPanelRuntimeState) => void>();
  const semanticStatusListeners = new Set<(nextStatus: SemanticSearchStatus) => void>();
  const pagingByPanelId = new Map<string, PanelPagingState>();
  const localOperationIds = new Set<string>();
  const appliedOperationIds = new Set<string>();
  const appliedOperationOrder: string[] = [];
  const activeProbeIds = new Set<string>();
  const cancelledProbeIds = new Set<string>();
  let pendingWebPanelSync: {
    descriptors: TauriWebPanelDescriptor[];
    focusedPanelId: string | null;
    requestId: number;
    attempt: number;
  } | null = null;
  let webPanelSyncRunning = false;
  let webPanelSyncRequestId = 0;
  let webPanelRetryTimer: number | null = null;
  let webPanelChannelInvalid = false;
  let webPanelRecoveryActive = false;
  let desiredWebPanelDescriptors: TauriWebPanelDescriptor[] = [];
  let desiredWebPanelFocus: string | null = null;
  let nativeWebDescriptors = new Map<string, TauriWebPanelDescriptor>();
  const pendingNativeWebStates = new Map<string, TauriWebPanelViewState>();
  const latestNativeWebStates = new Map<string, TauriWebPanelViewState>();
  const nativeWebGenerations = new Map<string, number>();
  const nativeWebCurrentUrls = new Map<string, string>();
  const webPreviews = new WebPreviewAuthorizations();
  const mediaSuspendedPanelIds = new Set<string>();
  const operationWaiters = new Map<string, OperationWaiter>();

  const rememberOperation = (operationId: string) => {
    if (appliedOperationIds.has(operationId)) return;
    appliedOperationIds.add(operationId);
    appliedOperationOrder.push(operationId);
    while (appliedOperationOrder.length > 4_096) {
      const oldest = appliedOperationOrder.shift();
      if (oldest) appliedOperationIds.delete(oldest);
    }
  };

  const notifyState = (nextState: AppState) => {
    for (const listener of stateListeners) listener(nextState);
  };

  const applySearchStatus = (raw: unknown) => {
    const nextStatus = publicSearchStatus(parseTauriSearchStatus(raw));
    if (
      semanticStatus.phase === nextStatus.phase &&
      semanticStatus.semanticReady === nextStatus.semanticReady &&
      semanticStatus.message === nextStatus.message
    ) {
      return semanticStatus;
    }
    semanticStatus = nextStatus;
    for (const listener of semanticStatusListeners) listener(nextStatus);
    return nextStatus;
  };

  const initializePaging = (
    bootstrap: TauriBootstrap,
    previousState: AppState | null,
    preserveLoadedCursor: boolean,
  ) => {
    dataGeneration += 1;
    const previousPaging = new Map(pagingByPanelId);
    const previousPanels = new Map(previousState?.panels.map((panel) => [panel.id, panel]) ?? []);
    pagingByPanelId.clear();
    for (const [panelId, page] of Object.entries(bootstrap.firstPageByPanel)) {
      const previousPage = previousPaging.get(panelId);
      const previousPanel = previousPanels.get(panelId);
      const nextPanel = bootstrap.panels.find((panel) => panel.id === panelId);
      const sameFeed =
        preserveLoadedCursor &&
        previousState?.dashboard.revision === bootstrap.revision &&
        previousPage &&
        previousPanel?.kind === "feed" &&
        nextPanel?.kind === "feed" &&
        previousPanel.sourceIds.length === nextPanel.sourceIds.length &&
        previousPanel.sourceIds.every((sourceId, index) => sourceId === nextPanel.sourceIds[index]);
      pagingByPanelId.set(panelId, {
        cursor: sameFeed ? previousPage.cursor : page.nextCursor,
        revision: Math.max(page.revision, sameFeed ? previousPage.revision : 0),
        exhausted: sameFeed ? previousPage.exhausted : page.nextCursor === null,
        generation: (previousPage?.generation ?? -1) + 1,
        inFlight: null,
      });
    }
  };

  const invalidatePanelPage = (panelId: string) => {
    const previous = pagingByPanelId.get(panelId);
    const rebuilt = rebuildFeedPageChainFromHead(
      previous,
      state?.dashboard.revision ?? previous?.revision ?? 0,
    );
    pagingByPanelId.set(panelId, {
      ...rebuilt,
      inFlight: null,
    });
  };

  const resolveCoveredWaiters = (revision: number) => {
    for (const [operationId, waiter] of operationWaiters) {
      if (waiter.revision > revision) continue;
      window.clearTimeout(waiter.timeout);
      operationWaiters.delete(operationId);
      waiter.resolve();
    }
  };

  const applyBootstrap = (
    raw: unknown,
    authoritative: boolean,
    requestSequence = 0,
  ) => {
    const bootstrap = parseBootstrap(
      raw,
      authoritative ? "Bootstrap Tauri" : "Snapshot de démarrage Tauri",
    );
    if (!authoritative && authoritativeReady) {
      if (!state) throw tauriError("Snapshot de démarrage Tauri", "État local absent.");
      return state;
    }
    if (authoritative) {
      const current = state && sessionId
        ? { sessionId, revision: state.dashboard.revision }
        : null;
      const shouldApply = shouldApplyAuthoritativeBootstrap(
        current,
        { sessionId: bootstrap.sessionId, revision: bootstrap.revision },
        requestSequence,
        latestAppliedBootstrapSequence,
      );
      latestAppliedBootstrapSequence = Math.max(
        latestAppliedBootstrapSequence,
        requestSequence,
      );
      authoritativeReady = true;
      if (!shouldApply) {
        if (!state) throw tauriError("Bootstrap Tauri", "État local monotone absent.");
        return state;
      }
    }
    const previous = state;
    const previousSessionId = sessionId;
    state = previous && previousSessionId === bootstrap.sessionId
      ? mergeBootstrapWithLoadedState(bootstrap, previous)
      : bootstrapToAppState(bootstrap);
    itemIndexById = new Map(state.items.map((item, index) => [item.id, index]));
    if (!previousSessionId || previousSessionId !== bootstrap.sessionId) {
      detachedSearchItemsById.clear();
    } else {
      for (const itemId of itemIndexById.keys()) detachedSearchItemsById.delete(itemId);
    }
    sessionId = bootstrap.sessionId;
    initializePaging(
      bootstrap,
      previous,
      Boolean(previousSessionId && previousSessionId === bootstrap.sessionId),
    );
    if (previousSessionId && previousSessionId !== sessionId) {
      appliedOperationIds.clear();
      appliedOperationOrder.length = 0;
    }
    if (previous) notifyState(state);
    resolveCoveredWaiters(state.dashboard.revision);
    return state;
  };

  const channel = new Channel<TauriStateStreamMessage>((message) => {
    streamTail = streamTail
      .then(async () => {
        if (message.type === "searchStatus") {
          applySearchStatus(message.status);
          return;
        }
        if (!authoritativeReady) await requestBootstrap();
        if (message.type === "resyncRequired") {
          await requestBootstrap(true);
          return;
        }
        if (message.type !== "patch") {
          throw tauriError("Canal Tauri", "Message inconnu.");
        }
        const patch = parsePatch(message.patch);
        if (!state || !sessionId) {
          await requestBootstrap(true);
          return;
        }
        if (appliedOperationIds.has(patch.operationId)) return;
        if (patch.sessionId !== sessionId || patch.baseRevision !== state.dashboard.revision) {
          await requestBootstrap(true);
          return;
        }
        const applied = applyPatchToState(
          state,
          patch,
          itemIndexById,
          detachedSearchItemsById,
        );
        state = applied.state;
        rememberOperation(patch.operationId);
        const waiter = operationWaiters.get(patch.operationId);
        if (waiter) {
          window.clearTimeout(waiter.timeout);
          operationWaiters.delete(patch.operationId);
          waiter.resolve();
        }
        if (!localOperationIds.has(patch.operationId)) notifyState(applied.state);
        for (const panelId of applied.removedPanelIds) pagingByPanelId.delete(panelId);
        for (const panelId of applied.invalidatedPanelIds) {
          invalidatePanelPage(panelId);
          // Conserver les lignes déjà chargées évite tout saut d'ancre. La
          // première page fraîche est fusionnée dès que le patch est visible.
          void getFeedPage(panelId, 200).catch(() => undefined);
        }
      })
      .catch(async (error) => {
        for (const waiter of operationWaiters.values()) {
          window.clearTimeout(waiter.timeout);
          waiter.reject(tauriError("Canal Tauri", error));
        }
        operationWaiters.clear();
        await requestBootstrap(true).catch(() => undefined);
      });
  });

  function requestBootstrap(force = false): Promise<AppState> {
    if (bootstrapInFlight && !force) return bootstrapInFlight;
    const requestSequence = ++bootstrapRequestSequence;
    const request = invoke<unknown>("bootstrap", { channel })
      .then((bootstrap) => applyBootstrap(bootstrap, true, requestSequence));
    bootstrapInFlight = request;
    void request.finally(() => {
      if (bootstrapInFlight === request) bootstrapInFlight = null;
    }).catch(() => undefined);
    return request;
  }

  const ensureAuthoritativeBootstrap = createRetryableBootstrapGate(
    () => authoritativeReady && state ? state : null,
    () => requestBootstrap(),
  );

  const snapshotPromise = invoke<unknown>("startup_snapshot")
    .then((snapshot) => snapshot === null ? null : applyBootstrap(snapshot, false))
    .catch(() => null);
  const initialAuthoritativeBootstrap = requestBootstrap();
  // A valid cached snapshot may resolve the first paint without awaiting this
  // request. Attach a rejection observer while leaving the retryable gate in
  // charge of the next authoritative action.
  void initialAuthoritativeBootstrap.catch(() => undefined);
  // The cached projection wins the first paint when available; the already
  // running authoritative request replaces it and publishes any difference.
  const initialState = snapshotPromise.then(
    (snapshot) => snapshot ?? initialAuthoritativeBootstrap,
  );

  const waitForOperation = (operationId: string, revision: number) => {
    if (appliedOperationIds.has(operationId) || (state?.dashboard.revision ?? -1) >= revision) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        operationWaiters.delete(operationId);
        void requestBootstrap(true).then(
          (nextState) => {
            if (nextState.dashboard.revision >= revision) resolve();
            else reject(tauriError("Mutation Tauri", "Patch de confirmation manquant."));
          },
          (error) => reject(tauriError("Mutation Tauri", error)),
        );
      }, 2_000);
      operationWaiters.set(operationId, { revision, resolve, reject, timeout });
    });
  };

  const enqueueMutation = (operation: () => Promise<AppState>) => {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(() => undefined, () => undefined);
    return result;
  };

  const mutate = (
    command: TauriMutationCommand,
    explicitRevision?: number,
  ): Promise<AppState> => enqueueMutation(async () => {
    await ensureAuthoritativeBootstrap();
    if (!state) throw tauriError("Mutation Tauri", "État autoritatif absent.");
    const expectedRevision = explicitRevision ?? state.dashboard.revision;
    if (expectedRevision !== state.dashboard.revision) {
      throw tauriError(
        "Mutation Tauri",
        `Révision périmée (${expectedRevision}, locale ${state.dashboard.revision}).`,
      );
    }
    const operationId = crypto.randomUUID();
    localOperationIds.add(operationId);
    try {
      const ack = await invoke<TauriMutationAck>("mutate", {
        request: { operationId, expectedRevision, command },
      });
      if (
        !ack ||
        ack.operationId !== operationId ||
        !isRevision(ack.committedRevision) ||
        ack.committedRevision < expectedRevision
      ) {
        throw tauriError("Mutation Tauri", "Accusé de réception invalide.");
      }
      if (ack.committedRevision > expectedRevision) {
        await waitForOperation(operationId, ack.committedRevision);
      }
      if (!state) throw tauriError("Mutation Tauri", "État final absent.");
      return state;
    } catch (error) {
      await requestBootstrap(true).catch(() => undefined);
      throw tauriError("Mutation Tauri", error);
    } finally {
      localOperationIds.delete(operationId);
    }
  });

  const saveFeedPanelConfiguration = (
    panelId: string,
    draft: FeedPanelConfigurationDraft,
  ): Promise<AppState> => enqueueMutation(async () => {
    await ensureAuthoritativeBootstrap();
    if (!state) throw tauriError("Configuration de fil", "État autoritatif absent.");
    const panel = state.panels.find(({ id }) => id === panelId);
    if (!panel || panel.kind !== "feed") {
      throw tauriError("Configuration de fil", "Panel de fil introuvable.");
    }
    if (draft.selectedCatalogIds.length > 0) {
      throw tauriError(
        "Configuration de fil",
        "Les sources du catalogue ne sont pas encore disponibles dans le runtime Tauri.",
      );
    }
    const expectedRevision = state.dashboard.revision;
    const operationId = crypto.randomUUID();
    localOperationIds.add(operationId);
    try {
      const ack = await invoke<TauriMutationAck>("save_feed_panel_configuration", {
        request: { operationId, expectedRevision, panelId, draft },
      });
      if (
        !ack ||
        ack.operationId !== operationId ||
        !isRevision(ack.committedRevision) ||
        ack.committedRevision < expectedRevision
      ) {
        throw tauriError("Configuration de fil", "Accusé de réception invalide.");
      }
      if (ack.committedRevision > expectedRevision) {
        await waitForOperation(operationId, ack.committedRevision);
      }
      if (!state) throw tauriError("Configuration de fil", "État final absent.");
      return state;
    } catch (error) {
      await requestBootstrap(true).catch(() => undefined);
      throw tauriError("Configuration de fil", error);
    } finally {
      localOperationIds.delete(operationId);
    }
  });

  async function getFeedPage(panelId: string, requestedLimit = 200): Promise<FeedPage> {
    await ensureAuthoritativeBootstrap();
    if (!state || !sessionId) throw tauriError("Pagination Tauri", "État absent.");
    const normalizedLimit = Number.isFinite(requestedLimit) ? Math.trunc(requestedLimit) : 200;
    const limit = Math.max(1, Math.min(200, normalizedLimit));
    let paging = pagingByPanelId.get(panelId);
    if (!paging) {
      paging = {
        cursor: null,
        revision: state.dashboard.revision,
        exhausted: false,
        generation: 0,
        inFlight: null,
      };
      pagingByPanelId.set(panelId, paging);
    }
    if (paging.exhausted) {
      return { revision: paging.revision, items: [], nextCursor: null };
    }
    if (paging.inFlight) return paging.inFlight;

    const requestedSessionId = sessionId;
    const requestedDataGeneration = dataGeneration;
    const requestedPanelGeneration = paging.generation;
    const requestedCursor = paging.cursor;
    const request = invoke<unknown>("get_feed_page", {
      request: { panelId, cursor: requestedCursor, limit },
    }).then((rawPage) => {
      const page = parseFeedPage(rawPage, "Pagination Tauri");
      const currentPaging = pagingByPanelId.get(panelId);
      if (
        requestedSessionId !== sessionId ||
        requestedDataGeneration !== dataGeneration ||
        !currentPaging ||
        requestedPanelGeneration !== currentPaging.generation ||
        requestedCursor !== currentPaging.cursor
      ) {
        throw tauriError("Pagination Tauri", "Réponse d’une ancienne session ignorée.");
      }
      if (
        !state ||
        !isFeedPageRevisionCurrent(
          page.revision,
          currentPaging.revision,
          state.dashboard.revision,
        )
      ) {
        invalidatePanelPage(panelId);
        throw tauriError("Pagination Tauri", "Page antérieure au dashboard ignorée.");
      }
      Object.assign(currentPaging, advanceFeedPageChain(currentPaging, page));
      if (page.items.length > 0 && state) {
        const mergedItems = mergeFeedItemsById(state.items, page.items, itemIndexById);
        for (const item of page.items) detachedSearchItemsById.delete(item.id);
        state = annotateAppStateItemDelta(
          { ...state, items: mergedItems, refreshedAt: new Date().toISOString() },
          { itemUpserts: page.items.map((item) => mergedItems[itemIndexById.get(item.id)!]) },
        );
        notifyState(state);
      }
      return page;
    });
    paging.inFlight = request;
    void request.finally(() => {
      const currentPaging = pagingByPanelId.get(panelId);
      if (currentPaging?.inFlight === request) currentPaging.inFlight = null;
    }).catch(() => undefined);
    return request;
  }

  async function getItem(itemId: string): Promise<FeedItem> {
    await ensureAuthoritativeBootstrap();
    if (!state || !sessionId) throw tauriError("Lecture d’article Tauri", "État absent.");
    const requestedSessionId = sessionId;
    const requestedDataGeneration = dataGeneration;
    const item = parseFeedItem(
      await invoke<unknown>("get_item", { itemId }),
      "Lecture d’article Tauri",
    );
    if (item.id !== itemId) {
      throw tauriError("Lecture d’article Tauri", "L’article retourné ne correspond pas à la cible.");
    }
    if (requestedSessionId !== sessionId || requestedDataGeneration !== dataGeneration) {
      throw tauriError("Lecture d’article Tauri", "Réponse d’une ancienne session ignorée.");
    }
    const mergedItems = mergeFeedItemsById(state.items, [item], itemIndexById);
    detachedSearchItemsById.delete(item.id);
    state = annotateAppStateItemDelta(
      { ...state, items: mergedItems, refreshedAt: new Date().toISOString() },
      { itemUpserts: [mergedItems[itemIndexById.get(item.id)!]] },
    );
    notifyState(state);
    return item;
  }

  async function getSemanticSearchStatus(): Promise<SemanticSearchStatus> {
    return applySearchStatus(await invoke<unknown>("get_search_status"));
  }

  async function searchFeedItems(request: {
    query: string;
    scope: SemanticSearchScope;
    mode: SemanticSearchMode;
  }): Promise<SemanticSearchResult> {
    const query = request.query.trim();
    if (!query || [...query].length > 240) {
      throw tauriError("Recherche Tauri", "La requête doit contenir entre 1 et 240 caractères.");
    }
    if (request.mode === "hybrid" && semanticStatus.semanticReady === false) {
      throw tauriError("Recherche Tauri", "Le modèle sémantique local n’est pas chargé.");
    }
    const panelId = request.scope.kind === "panel" ? request.scope.panelId : null;
    if (request.scope.kind === "panel" && !panelId) {
      throw tauriError("Recherche Tauri", "Le périmètre de recherche est invalide.");
    }
    await ensureAuthoritativeBootstrap();
    const hits = parseSearchHits(await invoke<unknown>("search", {
      request: {
        query,
        panelId,
        mode: request.mode,
        limit: 200,
      },
    }));
    retainDetachedSearchItems(
      detachedSearchItemsById,
      hits.map(({ item }) => item),
      itemIndexById,
    );
    return {
      items: hits.map(({ item }) => item),
      truncated: hits.length === 200,
      mode: request.mode,
    };
  }

  async function probeSource(
    probeId: string,
    source: string | SourceProbeRequest,
  ): Promise<SourceProbeResult> {
    if (!probeId || probeId.length > 128 || activeProbeIds.has(probeId)) {
      throw tauriError("Détection de flux", "Identifiant d’opération invalide.");
    }
    activeProbeIds.add(probeId);
    cancelledProbeIds.delete(probeId);
    try {
      const { request, response } = await invokeFeedProbe(source, probeId);
      if (cancelledProbeIds.has(probeId)) {
        throw tauriError("Détection de flux", "Détection annulée.");
      }
      return publicProbeResult(request.inputUrl, response);
    } finally {
      activeProbeIds.delete(probeId);
      cancelledProbeIds.delete(probeId);
    }
  }

  async function cancelSourceProbe(probeId: string) {
    if (!activeProbeIds.has(probeId)) return;
    cancelledProbeIds.add(probeId);
    await invoke("cancel_feed_probe", { probeId });
  }

  async function addSource(
    panelId: string,
    sourceRequest: string | SourceRequest,
  ) {
    await ensureAuthoritativeBootstrap();
    if (!state) throw tauriError("Ajout de source", "État absent.");
    const panel = state.panels.find(({ id }) => id === panelId);
    if (!panel || panel.kind !== "feed") {
      throw tauriError("Ajout de source", "Panel de fil introuvable.");
    }
    const requestedRefresh = typeof sourceRequest === "string"
      ? undefined
      : sourceRequest.refreshIntervalSeconds;
    if (
      requestedRefresh !== undefined &&
      (!Number.isInteger(requestedRefresh) || requestedRefresh < 30 || requestedRefresh > 3_600)
    ) {
      throw tauriError("Ajout de source", "La fréquence doit être comprise entre 30 et 3 600 secondes.");
    }
    const { request, response } = await invokeFeedProbe(sourceRequest);
    const existing = state.sources.find(({ feedUrl }) => feedUrl === response.finalUrl);
    if (existing) {
      if (panel.sourceIds.includes(existing.id)) return { sourceId: existing.id, state };
      const nextState = await mutate({
        command: "attachSource",
        panelId,
        sourceId: existing.id,
      });
      return { sourceId: existing.id, state: nextState };
    }

    const name = response.title?.trim() || new URL(response.finalUrl).hostname.replace(/^www\./, "");
    const nextState = await mutate({
      command: "addGenericSource",
      panelId,
      source: {
        name,
        inputUrl: request.inputUrl,
        feedUrl: response.finalUrl,
        connectorKind: response.connectorKind,
        refreshIntervalSeconds: requestedRefresh ?? panel.defaultRefreshIntervalSeconds,
      },
    });
    const added = nextState.sources.find(({ feedUrl }) => feedUrl === response.finalUrl);
    if (!added) throw tauriError("Ajout de source", "La source validée manque dans l’état final.");
    return { sourceId: added.id, state: nextState };
  }

  function publishWebState(nextState: WebPanelRuntimeState) {
    for (const listener of webStateListeners) listener(nextState);
  }

  function webDescriptor(panelId: string, operation: string) {
    const descriptor = nativeWebDescriptors.get(panelId);
    if (!descriptor) throw tauriError(operation, "Panel web natif introuvable.");
    return descriptor;
  }

  function publishNativeWebState(
    nativeState: TauriWebPanelViewState,
    descriptor: TauriWebPanelDescriptor,
  ) {
    const currentState = latestNativeWebStates.get(nativeState.panelId);
    if (currentState && compareWebPanelStateOrder(nativeState, currentState) < 0) return;
    nativeWebGenerations.set(nativeState.panelId, nativeState.generation);
    latestNativeWebStates.set(nativeState.panelId, nativeState);
    publishWebState(runtimeWebPanelState(
      nativeState,
      descriptor,
      nativeWebCurrentUrls.get(descriptor.panelId) ?? descriptor.url,
      mediaSuspendedPanelIds.has(descriptor.panelId),
    ));
  }

  function republishNativeWebState(panelId: string) {
    const nativeState = latestNativeWebStates.get(panelId);
    const descriptor = nativeWebDescriptors.get(panelId);
    if (nativeState && descriptor) publishNativeWebState(nativeState, descriptor);
  }

  let nextWebPanelChannelEpoch = 0;
  let activeWebPanelChannelEpoch = 0;
  let installingWebPanelChannelEpoch = 0;
  let activeWebPanelChannel: Channel<unknown> | null = null;
  let webPanelChannelInstallTail: Promise<void> = Promise.resolve();

  function cleanupWebPanelChannel(channel: Channel<unknown>) {
    // Channel.cleanupCallback exists in the pinned Tauri 2.11 runtime but is
    // intentionally private in its declarations. Keeping this cast local
    // makes the callback lifetime explicit without exposing Tauri internals to
    // the rest of the renderer.
    try {
      (channel as unknown as { cleanupCallback: () => void }).cleanupCallback();
    } catch {
      // A failed unregister can only retain an inert JS callback. The native
      // sink has already moved before the previous channel is cleaned up.
    }
  }

  function handleWebPanelChannelMessage(message: unknown) {
    let nativeState: TauriWebPanelViewState;
    try {
      nativeState = parseWebPanelViewState(message, "Canal des pages web");
    } catch {
      webPanelChannelInvalid = true;
      webPanelRecoveryActive = true;
      pendingNativeWebStates.clear();
      if (!webPanelSyncRunning) {
        const descriptors = [...desiredWebPanelDescriptors];
        pendingWebPanelSync = {
          descriptors,
          focusedPanelId: desiredWebPanelFocus,
          requestId: ++webPanelSyncRequestId,
          attempt: 0,
        };
        void drainWebPanelSync();
      }
      return;
    }
    const currentState = latestNativeWebStates.get(nativeState.panelId);
    if (currentState && compareWebPanelStateOrder(nativeState, currentState) < 0) return;
    // After clear_web_panels has acknowledged, every message from the former
    // controller epoch is stale. Drop it throughout the bounded backoff; the
    // first successful reconciliation installs a strictly newer generation.
    if (webPanelRecoveryActive && !webPanelSyncRunning) return;
    if (webPanelSyncRunning) {
      const pending = pendingNativeWebStates.get(nativeState.panelId);
      if (!pending || compareWebPanelStateOrder(nativeState, pending) >= 0) {
        pendingNativeWebStates.set(nativeState.panelId, nativeState);
      }
      return;
    }
    const descriptor = nativeWebDescriptors.get(nativeState.panelId);
    if (descriptor) {
      publishNativeWebState(nativeState, descriptor);
      return;
    }
  }

  function replaceWebPanelStateChannel() {
    // Tauri command invocations can overlap. Serialize sink replacement so a
    // delayed older subscription can never retake ownership after a newer
    // Channel. While replacement is in flight, both the installed and the
    // candidate epochs are accepted; Rust serializes its initial snapshot
    // with subsequent lifecycle publications.
    const installation = webPanelChannelInstallTail.then(async () => {
      const epoch = ++nextWebPanelChannelEpoch;
      installingWebPanelChannelEpoch = epoch;
      const channel = new Channel<unknown>((message) => {
        if (
          epoch !== activeWebPanelChannelEpoch &&
          epoch !== installingWebPanelChannelEpoch
        ) {
          return;
        }
        handleWebPanelChannelMessage(message);
      });
      try {
        await invoke<void>("subscribe_web_panel_states", { channel });
        const previousChannel = activeWebPanelChannel;
        activeWebPanelChannel = channel;
        activeWebPanelChannelEpoch = epoch;
        if (previousChannel) cleanupWebPanelChannel(previousChannel);
      } catch (error) {
        cleanupWebPanelChannel(channel);
        throw error;
      } finally {
        if (installingWebPanelChannelEpoch === epoch) {
          installingWebPanelChannelEpoch = 0;
        }
      }
    });
    webPanelChannelInstallTail = installation.catch(() => undefined);
    return installation;
  }

  async function runNativeWebPanelCommand(
    command: string,
    panelId: string,
    operation: string,
    arguments_: Record<string, unknown> = {},
  ) {
    webDescriptor(panelId, operation);
    // Lifecycle commands are acknowledgements only. Applying an invoke
    // snapshot here would let a delayed Loading response overwrite a Ready
    // transition already delivered by the ordered native Channel.
    try {
      await replaceWebPanelStateChannel();
      await invoke<void>(command, { panelId, ...arguments_ });
      if (webPanelRecoveryActive && !webPanelSyncRunning && !pendingWebPanelSync) {
        queueWebPanelSync([...desiredWebPanelDescriptors], desiredWebPanelFocus ?? panelId);
      }
    } catch (error) {
      // If a fail-closed recovery cleared the native controller, an explicit
      // user retry must be able to recreate the view even though React's
      // descriptor signature did not change.
      if (!webPanelSyncRunning && !pendingWebPanelSync) {
        queueWebPanelSync([...desiredWebPanelDescriptors], desiredWebPanelFocus ?? panelId);
      }
      throw error;
    }
  }

  async function navigateWebPanel(panelId: string, url: string) {
    const normalizedUrl = normalizeWebUrl(url);
    const previousUrl = nativeWebCurrentUrls.get(panelId);
    nativeWebCurrentUrls.set(panelId, normalizedUrl);
    try {
      await runNativeWebPanelCommand(
        "navigate_web_panel",
        panelId,
        "Navigation web",
        { url: normalizedUrl },
      );
    } catch (error) {
      if (previousUrl) nativeWebCurrentUrls.set(panelId, previousUrl);
      else nativeWebCurrentUrls.delete(panelId);
      republishNativeWebState(panelId);
      throw error;
    }
  }

  async function homeWebPanel(panelId: string) {
    const descriptor = webDescriptor(panelId, "Accueil du panel web");
    const previousUrl = nativeWebCurrentUrls.get(panelId);
    nativeWebCurrentUrls.set(panelId, descriptor.url);
    try {
      await runNativeWebPanelCommand("home_web_panel", panelId, "Accueil du panel web");
    } catch (error) {
      if (previousUrl) nativeWebCurrentUrls.set(panelId, previousUrl);
      else nativeWebCurrentUrls.delete(panelId);
      republishNativeWebState(panelId);
      throw error;
    }
  }

  async function setWebPanelMediaSuspended(panelId: string, suspended: boolean) {
    const wasSuspended = mediaSuspendedPanelIds.has(panelId);
    if (suspended) mediaSuspendedPanelIds.add(panelId);
    else mediaSuspendedPanelIds.delete(panelId);
    try {
      await runNativeWebPanelCommand(
        "set_web_panel_media_suspended",
        panelId,
        "Contrôle audio web",
        { suspended },
      );
    } catch (error) {
      if (wasSuspended) mediaSuspendedPanelIds.add(panelId);
      else mediaSuspendedPanelIds.delete(panelId);
      throw error;
    }
  }

  function normalizeWebPanelDescriptors(panels: WebPanelDescriptor[]) {
    return normalizeTauriWebPanelDescriptors(panels, webPreviews.urls());
  }

  function queueWebPanelSync(
    descriptors: TauriWebPanelDescriptor[],
    focusedPanelId: string | null,
  ) {
    if (webPanelRetryTimer !== null) {
      window.clearTimeout(webPanelRetryTimer);
      webPanelRetryTimer = null;
    }
    const requestId = ++webPanelSyncRequestId;
    pendingWebPanelSync = {
      descriptors,
      focusedPanelId,
      requestId,
      attempt: 0,
    };
    void drainWebPanelSync();
  }

  function scheduleWebPanelRetry(job: NonNullable<typeof pendingWebPanelSync>) {
    if (job.attempt >= 2 || job.requestId !== webPanelSyncRequestId) return;
    if (webPanelRetryTimer !== null) window.clearTimeout(webPanelRetryTimer);
    webPanelRetryTimer = window.setTimeout(() => {
      webPanelRetryTimer = null;
      if (job.requestId !== webPanelSyncRequestId) return;
      pendingWebPanelSync = { ...job, attempt: job.attempt + 1 };
      void drainWebPanelSync();
    }, 50 * (job.attempt + 1));
  }

  function publishFailedWebPanelSync(
    desired: Map<string, TauriWebPanelDescriptor>,
    previous: Map<string, TauriWebPanelDescriptor>,
  ) {
    nativeWebDescriptors = desired;
    pendingNativeWebStates.clear();
    for (const [panelId, descriptor] of desired) {
      nativeWebCurrentUrls.set(panelId, descriptor.url);
      mediaSuspendedPanelIds.delete(panelId);
      // This is a renderer recovery marker, not a native lifecycle revision.
      // Never insert it into `latestNativeWebStates`, otherwise a successful
      // same-generation native snapshot could be rejected as older.
      publishWebState(runtimeWebPanelState({
        panelId,
        generation: nativeWebGenerations.get(panelId) ?? 0,
        sequence: latestNativeWebStates.get(panelId)?.sequence ?? 0,
        bounds: descriptor.bounds,
        phase: "failed",
        requestedVisible: descriptor.visible,
        visible: false,
      }, descriptor));
    }
    for (const [panelId, descriptor] of previous) {
      if (desired.has(panelId)) continue;
      nativeWebCurrentUrls.delete(panelId);
      mediaSuspendedPanelIds.delete(panelId);
      latestNativeWebStates.delete(panelId);
      publishWebState({
        ...runtimeWebPanelState({
          panelId,
          generation: nativeWebGenerations.get(panelId) ?? 0,
          sequence: latestNativeWebStates.get(panelId)?.sequence ?? 0,
          bounds: descriptor.bounds,
          phase: "ready",
          requestedVisible: false,
          visible: false,
        }, descriptor),
        status: "destroyed",
        destroyed: true,
      });
    }
  }

  async function drainWebPanelSync() {
    if (webPanelSyncRunning) return;
    webPanelSyncRunning = true;
    try {
      while (pendingWebPanelSync) {
        const job = pendingWebPanelSync;
        pendingWebPanelSync = null;
        const descriptors = job.descriptors.filter(
          ({ panelId }) => !panelId.startsWith("draft:") || webPreviews.urls().has(panelId),
        );
        try {
          // Reinstall the ordered sink for every reconciliation. A closed or
          // slow previous Channel is therefore recovered by the same bounded
          // retry policy as native reconciliation.
          await replaceWebPanelStateChannel();
          if (webPanelRecoveryActive) {
            // Retrying teardown first also gives retained orphan handles a
            // bounded chance to close before any replacement is created.
            await invoke<void>("clear_web_panels");
          }
          const rawNativeStates = await invoke<unknown>("sync_web_panels", {
            descriptors,
            focusedPanelId: job.focusedPanelId,
          });
          if (webPanelChannelInvalid) {
            webPanelChannelInvalid = false;
            throw tauriError("Synchronisation des pages web", "Canal d’état natif invalide.");
          }
          const nativeStates = parseWebPanelViewStates(rawNativeStates);
          const stillAuthorized = descriptors.filter(
            ({ panelId }) => !panelId.startsWith("draft:") || webPreviews.urls().has(panelId),
          );
          if (stillAuthorized.length !== descriptors.length && !pendingWebPanelSync) {
            pendingWebPanelSync = {
              descriptors: stillAuthorized,
              focusedPanelId: job.focusedPanelId,
              requestId: job.requestId,
              attempt: job.attempt,
            };
          }
          const descriptorsById = new Map(descriptors.map((descriptor) => [descriptor.panelId, descriptor]));
          if (nativeStates.some(({ panelId }) => !descriptorsById.has(panelId))) {
            throw tauriError("Synchronisation des pages web", "Le moteur natif a retourné un panel inconnu.");
          }
          const previous = nativeWebDescriptors;
          nativeWebDescriptors = descriptorsById;
          for (const [panelId, descriptor] of descriptorsById) {
            const previousDescriptor = previous.get(panelId);
            if (!previousDescriptor || previousDescriptor.url !== descriptor.url) {
              nativeWebCurrentUrls.set(panelId, descriptor.url);
              mediaSuspendedPanelIds.delete(panelId);
            }
          }
          if (!pendingWebPanelSync) {
            webPanelRecoveryActive = false;
            for (const nativeState of nativeStates) {
              const descriptor = descriptorsById.get(nativeState.panelId);
              if (descriptor) publishNativeWebState(nativeState, descriptor);
            }
            for (const [panelId, nativeState] of pendingNativeWebStates) {
              const descriptor = descriptorsById.get(panelId);
              pendingNativeWebStates.delete(panelId);
              if (!descriptor) continue;
              publishNativeWebState(nativeState, descriptor);
            }
            for (const [panelId, descriptor] of previous) {
              if (descriptorsById.has(panelId)) continue;
              pendingNativeWebStates.delete(panelId);
              nativeWebCurrentUrls.delete(panelId);
              mediaSuspendedPanelIds.delete(panelId);
              latestNativeWebStates.delete(panelId);
              publishWebState({
                ...runtimeWebPanelState({
                  panelId,
                  generation: nativeWebGenerations.get(panelId) ?? 0,
                  sequence: latestNativeWebStates.get(panelId)?.sequence ?? 0,
                  bounds: descriptor.bounds,
                  phase: "ready",
                  requestedVisible: false,
                  visible: false,
                }, descriptor),
                status: "destroyed",
                destroyed: true,
              });
            }
          }
        } catch {
          webPanelChannelInvalid = false;
          webPanelRecoveryActive = true;
          // Native views sit above the DOM. If reconciliation fails, clearing
          // them is the only fail-closed response; no modal may remain covered.
          const clearSucceeded = await invoke<void>("clear_web_panels").then(
            () => true,
            () => false,
          );
          if (job.requestId !== webPanelSyncRequestId) {
            // A newer React reconciliation is already queued. The clear above
            // invalidated A safely; only B may now publish visible truth.
            continue;
          }
          const previous = nativeWebDescriptors;
          const currentDescriptors = desiredWebPanelDescriptors.filter(
            ({ panelId }) => !panelId.startsWith("draft:") || webPreviews.urls().has(panelId),
          );
          const desired = new Map(
            currentDescriptors.map((descriptor) => [descriptor.panelId, descriptor]),
          );
          publishFailedWebPanelSync(desired, previous);
          if (!pendingWebPanelSync && (clearSucceeded || job.attempt < 2)) {
            scheduleWebPanelRetry({
            ...job,
            descriptors: currentDescriptors,
            focusedPanelId: desiredWebPanelFocus,
            });
          }
        }
      }
    } finally {
      webPanelSyncRunning = false;
      if (pendingWebPanelSync) void drainWebPanelSync();
    }
  }

  function syncWebPanels(panels: WebPanelDescriptor[], focusedPanelId?: string | null) {
    const descriptors = normalizeWebPanelDescriptors(panels);
    const focused = focusedPanelId && descriptors.some(({ panelId }) => panelId === focusedPanelId)
      ? focusedPanelId
      : null;
    desiredWebPanelDescriptors = descriptors;
    desiredWebPanelFocus = focused;
    queueWebPanelSync(descriptors, focused);
  }

  async function startWebPreview(previewId: string, url: string) {
    await ensureAuthoritativeBootstrap();
    const normalizedPreviewId = normalizeWebPreviewId(previewId);
    const normalizedUrl = normalizeWebUrl(url);
    const existingPreviewId = webPreviews.current()?.previewId;
    const dashboardWebPanels = state?.panels.filter((panel) => panel.kind === "web").length ?? 0;
    if (dashboardWebPanels + Number(existingPreviewId !== normalizedPreviewId) > 6) {
      throw tauriError("Prévisualisation web", "Six pages web au maximum sont autorisées.");
    }
    try {
      webPreviews.start(normalizedPreviewId, normalizedUrl);
    } catch (error) {
      throw tauriError("Prévisualisation web", error);
    }
    return { previewId: normalizedPreviewId, normalizedUrl };
  }

  async function destroyNativeWebPreview(previewId: string) {
    // Prevent an already queued reconciliation from recreating the preview
    // while its native close is in flight. The durable desired descriptor is
    // removed only after native teardown really succeeds.
    pendingWebPanelSync = pendingWebPanelSync
      ? {
          ...pendingWebPanelSync,
          descriptors: pendingWebPanelSync.descriptors.filter(
            ({ panelId }) => panelId !== previewId,
          ),
        }
      : null;
    const descriptor = nativeWebDescriptors.get(previewId);
    let clearedAllPanels = false;
    try {
      await invoke("destroy_web_panel", { panelId: previewId });
    } catch (destroyError) {
      webPanelRecoveryActive = true;
      try {
        await invoke("clear_web_panels");
        clearedAllPanels = true;
      } catch (clearError) {
        const desired = new Map(
          desiredWebPanelDescriptors.map((candidate) => [candidate.panelId, candidate]),
        );
        publishFailedWebPanelSync(desired, nativeWebDescriptors);
        throw tauriError(
          "Fermeture de l’aperçu web",
          clearError ?? destroyError,
        );
      }
    }

    desiredWebPanelDescriptors = desiredWebPanelDescriptors.filter(
      ({ panelId }) => panelId !== previewId,
    );
    if (desiredWebPanelFocus === previewId) desiredWebPanelFocus = null;
    nativeWebDescriptors.delete(previewId);
    pendingNativeWebStates.delete(previewId);
    latestNativeWebStates.delete(previewId);
    nativeWebCurrentUrls.delete(previewId);
    mediaSuspendedPanelIds.delete(previewId);
    nativeWebGenerations.delete(previewId);
    if (descriptor) {
      publishWebState({
        ...runtimeWebPanelState({
          panelId: previewId,
          generation: nativeWebGenerations.get(previewId) ?? 0,
          sequence: latestNativeWebStates.get(previewId)?.sequence ?? 0,
          bounds: descriptor.bounds,
          phase: "ready",
          requestedVisible: false,
          visible: false,
        }, descriptor),
        status: "destroyed",
        destroyed: true,
      });
    }
    if (clearedAllPanels || webPanelRecoveryActive) {
      queueWebPanelSync([...desiredWebPanelDescriptors], desiredWebPanelFocus);
    }
  }

  async function cancelWebPreview(previewId: string) {
    const normalizedPreviewId = normalizeWebPreviewId(previewId);
    const authorization = webPreviews.cancel(normalizedPreviewId);
    if (!authorization) return;
    try {
      await destroyNativeWebPreview(normalizedPreviewId);
    } catch (error) {
      // Keep the draft actionable when native teardown could not be proven.
      // Its URL remains main-owned and can be retried without accepting any
      // renderer-supplied replacement.
      webPreviews.start(authorization.previewId, authorization.url);
      queueWebPanelSync([...desiredWebPanelDescriptors], desiredWebPanelFocus);
      throw error;
    }
  }

  async function commitWebPreview(
    previewId: string,
    name: string,
    placement?: PanelPlacement,
  ) {
    const normalizedPreviewId = normalizeWebPreviewId(previewId);
    let nextState: AppState;
    try {
      nextState = await webPreviews.commit(normalizedPreviewId, ({ url }) => mutate({
        command: "createPanel",
        input: { kind: "web", name, url },
        ...(placement ? { placement } : {}),
      }));
    } catch (error) {
      throw tauriError("Création du panel web", error);
    }
    try {
      await destroyNativeWebPreview(normalizedPreviewId);
    } catch {
      // The SQLite commit is already authoritative and must never be reported
      // as failed or retried. Retire the consumed preview from the desired
      // set and let fail-closed reconciliation repair native teardown while
      // the new panel remains the successful user result.
      desiredWebPanelDescriptors = desiredWebPanelDescriptors.filter(
        ({ panelId }) => panelId !== normalizedPreviewId,
      );
      if (desiredWebPanelFocus === normalizedPreviewId) desiredWebPanelFocus = null;
      queueWebPanelSync([...desiredWebPanelDescriptors], desiredWebPanelFocus);
    }
    return nextState;
  }

  async function scheduledRefresh(
    command: Extract<TauriMutationCommand, {
      command: "forceRefreshSource" | "forceRefreshPanel" | "forceRefreshAll";
    }>,
  ) {
    await ensureAuthoritativeBootstrap();
    if (!state) throw tauriError("Actualisation", "État autoritatif absent.");
    let sourceCount = 0;
    if (command.command === "forceRefreshSource") {
      sourceCount = Number(state.sources.some(({ id }) => id === command.sourceId));
    } else if (command.command === "forceRefreshPanel") {
      const panel = state.panels.find(({ id }) => id === command.panelId);
      sourceCount = panel?.kind === "feed" ? panel.sourceIds.length : 0;
    } else {
      const attached = new Set<string>();
      for (const panel of state.panels) {
        if (panel.kind === "feed") panel.sourceIds.forEach((sourceId) => attached.add(sourceId));
      }
      sourceCount = attached.size;
    }
    try {
      return annotateScheduledRefresh(await mutate(command), { sourceCount });
    } catch (error) {
      // A scheduler patch may win the writer between the renderer's revision
      // capture and this idempotent command. Retry exactly once against the
      // authoritative revision; other failures remain explicit.
      if (!hasTauriErrorCode(error, "revision_conflict")) throw error;
      await requestBootstrap(true);
      return annotateScheduledRefresh(await mutate(command), { sourceCount });
    }
  }

  const openExternal = (url: string) => invoke<void>("open_external_url", {
    url: normalizeWebUrl(url),
  });

  const unsupportedAsync = unsupported;
  const api: VibeDeckApi = {
    getState: async () => {
      try {
        await initialState;
      } catch {
        // No usable snapshot existed. A later getState call (or this immediate
        // fallback once the failed in-flight request clears) gets a fresh
        // bootstrap instead of re-awaiting a permanently rejected Promise.
        await ensureAuthoritativeBootstrap();
      }
      if (!state) throw tauriError("Lecture de l’état Tauri", "État absent.");
      return state;
    },
    getFeedPage,
    getItem,
    getUpdateState: async () => ({
      ...STATIC_UPDATE_STATE,
      currentVersion: await getVersion(),
    }),
    checkForUpdates: unsupportedAsync("Recherche de mise à jour"),
    restartForUpdate: unsupportedAsync("Installation de mise à jour"),
    createPanel: (input, placement) => mutate({
      command: "createPanel",
      input: typeof input === "string" ? { kind: "feed", name: input } : input,
      ...(placement ? { placement } : {}),
    }),
    renamePanel: (panelId, name) => mutate({ command: "renamePanel", panelId, name }),
    setWebPanelUrl: (panelId, url) => mutate({ command: "setWebPanelUrl", panelId, url }),
    deletePanel: (panelId) => mutate({ command: "deletePanel", panelId }),
    saveDashboardLayout: (layout, expectedRevision) =>
      mutate({ command: "setLayout", layout }, expectedRevision),
    addCatalogSource: unsupportedAsync("Ajout d’une source catalogue"),
    probeSource,
    cancelSourceProbe,
    addSource,
    setFeedPanelDefaultRefresh: (panelId, refreshIntervalSeconds) => mutate({
      command: "setFeedPanelDefaultRefresh",
      panelId,
      refreshIntervalSeconds,
    }),
    saveFeedPanelConfiguration,
    removeSource: (panelId, sourceId) => mutate({ command: "detachSource", panelId, sourceId }),
    refreshSource: (sourceId) => scheduledRefresh({ command: "forceRefreshSource", sourceId }),
    refreshPanel: (panelId) => scheduledRefresh({ command: "forceRefreshPanel", panelId }),
    refreshAll: () => scheduledRefresh({ command: "forceRefreshAll" }),
    markItemsSeen: (itemIds) =>
      mutate({ command: "markItemsSeen", itemIds, at: new Date().toISOString() }),
    markItemOpened: (itemId) =>
      mutate({ command: "markItemOpened", itemId, at: new Date().toISOString() }),
    getSemanticSearchStatus,
    prepareSemanticSearch: unsupportedAsync("Installation de la recherche locale"),
    cancelSemanticSearchPreparation: unsupportedAsync("Annulation de la recherche locale"),
    searchFeedItems,
    removeSemanticSearchData: unsupportedAsync("Suppression de la recherche locale"),
    finishSemanticSearchFocus: () => undefined,
    exportDashboard: unsupportedAsync("Export du dashboard"),
    importDashboard: unsupportedAsync("Import du dashboard"),
    exportDiagnostics: unsupportedAsync("Export du diagnostic"),
    clearWebData: () => invoke<void>("clear_web_panel_data"),
    startWebPreview,
    commitWebPreview,
    cancelWebPreview,
    openExternal,
    focusDashboard: () => window.focus(),
    syncWebPanels,
    navigateWebPanel,
    reloadWebPanel: (panelId) => runNativeWebPanelCommand(
      "reload_web_panel",
      panelId,
      "Rechargement web",
    ),
    stopWebPanel: (panelId) => runNativeWebPanelCommand(
      "stop_web_panel",
      panelId,
      "Arrêt du chargement web",
    ),
    goBackWebPanel: (panelId) => runNativeWebPanelCommand(
      "go_back_web_panel",
      panelId,
      "Navigation web précédente",
    ),
    goForwardWebPanel: (panelId) => runNativeWebPanelCommand(
      "go_forward_web_panel",
      panelId,
      "Navigation web suivante",
    ),
    homeWebPanel,
    openExternalWebPanel: (panelId) => invoke<void>("open_external_web_panel", { panelId }),
    showOriginalArticle: unsupportedAsync("Lecture originale"),
    retryOriginalArticle: unsupportedAsync("Nouvelle tentative de lecture"),
    setWebPanelMuted: setWebPanelMediaSuspended,
    onStateChanged: (callback) => {
      stateListeners.add(callback);
      return () => stateListeners.delete(callback);
    },
    onUpdateStateChanged: passiveSubscription<UpdateState>(),
    onWebPanelStateChanged: (callback) => {
      webStateListeners.add(callback);
      return () => webStateListeners.delete(callback);
    },
    onWebPanelEscape: passiveSubscription(),
    onSemanticSearchStatusChanged: (callback) => {
      semanticStatusListeners.add(callback);
      return () => semanticStatusListeners.delete(callback);
    },
    onOpenGlobalSearch: passiveSubscription(),
  };
  return Object.freeze(api);
}

export function installTauriVibeDeckApi() {
  if (!isTauri()) return false;
  if ("vibedeck" in window && window.vibedeck) {
    throw tauriError("Initialisation Tauri", "Une API VibeDeck existe déjà.");
  }
  Object.defineProperty(window, "vibedeck", {
    value: createTauriFacade(),
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return true;
}
