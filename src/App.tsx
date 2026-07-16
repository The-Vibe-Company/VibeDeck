import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  Columns2,
  Download,
  ExternalLink,
  Globe2,
  Home,
  ListFilter,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Plus,
  RefreshCw,
  Rows2,
  Rss,
  Search,
  SlidersHorizontal,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type MouseEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import SplitLayout, {
  MIN_PANEL_HEIGHT,
  MIN_PANEL_WIDTH,
  SPLIT_DIVIDER_SIZE,
  useSplitPanelDragHandle,
} from "./SplitLayout";
import {
  layoutPanelIds,
  removePanel,
  replacePanelId,
  splitPanel,
  swapPanels,
  updateSplitRatio,
} from "./dashboard";
import {
  abbreviateSourceName,
  compareFeedItems,
  feedItemIdsBeforeAnchor,
  formatCheckedAt,
  formatItemTime,
  formatNextRefresh,
  sourceHue,
  withDaySeparators,
} from "./feed-presentation";
import { saveFeedPanelConfiguration } from "./feed-settings";
import { createLatestAsyncOperation } from "./latest-async-operation";
import ProviderMark from "./ProviderMark";
import { cancelSmoothScroll, smoothScrollIntoView } from "./smooth-scroll";
import type {
  AppState,
  ConnectorKind,
  ConnectorPreference,
  CreatePanelInput,
  FeedItem,
  FeedPanel,
  LayoutNode,
  Panel,
  PanelPlacement,
  Source,
  SourceCatalogEntry,
  SourceProbeResult,
  SourceRequest,
  UpdateState,
  SemanticSearchScope,
  SemanticSearchResult,
  SemanticSearchStatus,
  WebPanel,
  WebPanelDescriptor,
  WebPanelRuntimeState,
} from "./types";

const LINK_READER_ID = "reader:article";
// Temps de survol immobile sur une ligne avant de la marquer « vue ».
// Assez long pour qu'un simple passage de souris ne compte pas, assez court
// pour rester réactif quand on s'arrête vraiment pour lire.
const HOVER_SEEN_DELAY_MS = 1000;
const MAX_DASHBOARD_WEB_PANELS = 6;
const FEED_TEXT_SCALE_STORAGE_KEY = "vibedeck.feedTextScale";
const FEED_TEXT_SCALE_OVERRIDES_STORAGE_KEY = "vibedeck.feedTextScale.overrides";
const FEED_TEXT_SCALE_MIN = 0.8;
const FEED_TEXT_SCALE_MAX = 1.6;
const FEED_TEXT_SCALE_STEP = 0.1;
const FEED_DENSITY_STORAGE_KEY = "vibedeck.feedDensity";
const FEED_DENSITY_OVERRIDES_STORAGE_KEY = "vibedeck.feedDensity.overrides";

type FeedDensity = "comfort" | "dense";
const MIN_HORIZONTAL_SPLIT_WIDTH = MIN_PANEL_WIDTH * 2 + SPLIT_DIVIDER_SIZE;
const MIN_VERTICAL_SPLIT_HEIGHT = MIN_PANEL_HEIGHT * 2 + SPLIT_DIVIDER_SIZE;
const PANEL_FOCUSABLE_SELECTOR =
  'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [contenteditable="true"], [tabindex]:not([tabindex="-1"]):not(:disabled)';

interface PanelFocusIdentity {
  focusKey: string | null;
  id: string | null;
  ariaLabel: string | null;
  panelTitle: boolean;
  index: number;
}

const REFRESH_INTERVAL_OPTIONS = [
  { value: 30, label: "30 s" },
  { value: 60, label: "1 min" },
  { value: 120, label: "2 min" },
  { value: 300, label: "5 min" },
  { value: 600, label: "10 min" },
  { value: 900, label: "15 min" },
  { value: 1_800, label: "30 min" },
];

const CONNECTOR_KIND_OPTIONS: Array<{ value: ConnectorPreference; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "rss", label: "RSS" },
  { value: "atom", label: "Atom" },
  { value: "news-sitemap", label: "Sitemap" },
];

const WEB_PRESETS = [
  {
    name: "BFM TV — En direct",
    url: "https://www.bfmtv.com/en-direct/",
    live: true,
  },
  {
    name: "franceinfo — Canal 27",
    url: "https://www.francetvinfo.fr/en-direct/tv.html",
    live: true,
  },
  {
    name: "Le Monde — En continu",
    url: "https://www.lemonde.fr/actualite-en-continu/",
    live: false,
  },
  {
    name: "Google Actualités",
    url: "https://news.google.com/?hl=fr",
    live: false,
  },
];

type DraftPanel = {
  id: string;
  targetPanelId: string | null;
  side: PanelPlacement["side"] | null;
  pending: boolean;
};

type WebPreviewDraft = {
  previewId: string;
  normalizedUrl: string;
};

type AutomaticInsertionMetrics = {
  scrollTop: number;
  anchorItemId: string | null;
  anchorViewportTop: number | null;
};

type FeedPanelUi = {
  sourceFilter: string;
  visibilityFilter: "all" | "unseen";
  focusedItemId: string | null;
  visibleItemIds: Set<string>;
  automaticInsertionIds: Set<string>;
  automaticInsertionMetrics: AutomaticInsertionMetrics | null;
  // Arrivées promues au-dessus du viewport pendant que l'utilisateur était
  // descendu dans la liste : alimente la pastille « N nouveaux · Afficher ».
  pendingArrivalIds: Set<string>;
  searchItemIds: Set<string> | null;
};

type LinkPreview = {
  itemId: string;
  title: string;
};

type ReaderReturnFocus = {
  panelId: string;
  rowId: string;
};

type ActiveSemanticSearch = {
  query: string;
  scope: SemanticSearchScope;
  resultCount: number;
  result: SemanticSearchResult;
};

type SemanticSearchRestoreState = {
  focusedPanelId: string | null;
  focusedControl: {
    panelId: string;
    id: string | null;
    focusKey: string | null;
    ariaLabel: string | null;
  } | null;
  focusedItemIdsByPanelId: Map<string, string | null>;
  scrollAnchorByPanelId: Map<string, { itemId: string; viewportTop: number }>;
  scrollTopByPanelId: Map<string, number>;
};

type PendingCustomSource = Required<Pick<SourceRequest, "url" | "connectorKind">>;

type ModalState =
  | { kind: "configure-feed"; panelId: string }
  | { kind: "close-panel"; panelId: string }
  | { kind: "clear-dashboard" }
  | { kind: "pilot-tools" };

function cleanError(error: unknown) {
  if (error instanceof Error) {
    return error.message.replace(/^Error invoking remote method '[^']+':\s*/i, "");
  }
  return "Une erreur inattendue s’est produite.";
}

function sourceIsFresh(source: Source) {
  if (!source.lastSuccessAt || source.status === "error") return false;
  const lastSuccess = Date.parse(source.lastSuccessAt);
  if (!Number.isFinite(lastSuccess)) return false;
  const allowedAge = Math.max(120, source.refreshIntervalSeconds * 2 + 15) * 1_000;
  return Date.now() - lastSuccess <= allowedAge;
}

function clampFeedTextScale(value: number) {
  if (!Number.isFinite(value)) return 1;
  const bounded = Math.min(FEED_TEXT_SCALE_MAX, Math.max(FEED_TEXT_SCALE_MIN, value));
  return Math.round(bounded * 100) / 100;
}

function loadFeedTextScale() {
  try {
    const raw = window.localStorage.getItem(FEED_TEXT_SCALE_STORAGE_KEY);
    return raw === null ? 1 : clampFeedTextScale(Number.parseFloat(raw));
  } catch {
    return 1;
  }
}

function loadFeedTextScaleOverrides(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(FEED_TEXT_SCALE_OVERRIDES_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const overrides: Record<string, number> = {};
    for (const [panelId, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        overrides[panelId] = clampFeedTextScale(value);
      }
    }
    return overrides;
  } catch {
    return {};
  }
}

function normalizeFeedDensity(value: unknown): FeedDensity {
  return value === "comfort" ? "comfort" : "dense";
}

function loadFeedDensity(): FeedDensity {
  try {
    return normalizeFeedDensity(window.localStorage.getItem(FEED_DENSITY_STORAGE_KEY));
  } catch {
    return "dense";
  }
}

function loadFeedDensityOverrides(): Record<string, FeedDensity> {
  try {
    const raw = window.localStorage.getItem(FEED_DENSITY_OVERRIDES_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const overrides: Record<string, FeedDensity> = {};
    for (const [panelId, value] of Object.entries(parsed)) {
      if (value === "comfort" || value === "dense") overrides[panelId] = value;
    }
    return overrides;
  } catch {
    return {};
  }
}

function isTypingTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function isKeyboardShortcutBlockedTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest(".article-row")) return false;
  return Boolean(
    target.closest(
      'button, a, input, textarea, select, [contenteditable="true"], [role="separator"], [role="slider"], [role="menuitem"], [role="tab"]',
    ),
  );
}

function panelPlacementForDraft(draft: DraftPanel): PanelPlacement | undefined {
  if (!draft.targetPanelId || !draft.side) return undefined;
  return { targetPanelId: draft.targetPanelId, side: draft.side };
}

function panelItems(
  panel: FeedPanel,
  state: AppState,
  options: {
    sourceFilter?: string;
    visibleItemIds?: Set<string>;
    searchItemIds?: Set<string> | null;
    visibilityFilter?: "all" | "unseen";
    focusedItemId?: string | null;
  } = {},
) {
  const sourceIds = new Set(panel.sourceIds);
  const sourceFilter = options.sourceFilter ?? "all";
  const effectiveFilter =
    sourceFilter === "all" || sourceIds.has(sourceFilter) ? sourceFilter : "all";
  return state.items
    .filter(
      (item) =>
        sourceIds.has(item.sourceId) &&
        (effectiveFilter === "all" || item.sourceId === effectiveFilter) &&
        (options.searchItemIds
          ? options.searchItemIds.has(item.id)
          : !options.visibleItemIds || options.visibleItemIds.has(item.id)) &&
        (options.visibilityFilter !== "unseen" ||
          item.seenAt === null ||
          item.id === options.focusedItemId),
    )
    .sort(compareFeedItems);
}

function initialFeedUi(panel: FeedPanel, state: AppState): FeedPanelUi {
  return {
    sourceFilter: "all",
    visibilityFilter: "all",
    focusedItemId: null,
    visibleItemIds: new Set(panelItems(panel, state).map(({ id }) => id)),
    automaticInsertionIds: new Set(),
    automaticInsertionMetrics: null,
    pendingArrivalIds: new Set(),
    searchItemIds: null,
  };
}

function focusDashboardPanelRoot(panelId: string) {
  const panel = document.querySelector<HTMLElement>(
    `.split-layout__leaf[data-panel-id="${CSS.escape(panelId)}"] .dashboard-panel`,
  );
  if (!panel) return false;
  panel.focus({ preventScroll: true });
  return document.activeElement === panel;
}

function restoreArticleFocus(target: ReaderReturnFocus) {
  const article = document.getElementById(target.rowId);
  if (article instanceof HTMLElement) {
    article.focus({ preventScroll: true });
    return;
  }
  focusDashboardPanelRoot(target.panelId);
}

function restoreSemanticSearchControl(restore: SemanticSearchRestoreState | null) {
  const control = restore?.focusedControl;
  if (control) {
    const leaf = document.querySelector<HTMLElement>(
      `.split-layout__leaf[data-panel-id="${CSS.escape(control.panelId)}"]`,
    );
    const focusable = leaf
      ? [...leaf.querySelectorAll<HTMLElement>(PANEL_FOCUSABLE_SELECTOR)]
      : [];
    const target =
      (control.id ? leaf?.querySelector<HTMLElement>(`#${CSS.escape(control.id)}`) : null) ??
      (control.focusKey
        ? focusable.find(
            (candidate) => candidate.getAttribute("data-panel-focus-key") === control.focusKey,
          )
        : null) ??
      (control.ariaLabel
        ? focusable.find(
            (candidate) => candidate.getAttribute("aria-label") === control.ariaLabel,
          )
        : null);
    if (target) {
      target.focus({ preventScroll: true });
      if (document.activeElement === target) return true;
    }
  }
  return restore?.focusedPanelId ? focusDashboardPanelRoot(restore.focusedPanelId) : false;
}

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [layout, setLayout] = useState<LayoutNode | null>(null);
  const [drafts, setDrafts] = useState<Record<string, DraftPanel>>({});
  const [webPreviewDrafts, setWebPreviewDrafts] = useState<Record<string, WebPreviewDraft>>({});
  const [focusedPanelId, setFocusedPanelId] = useState<string | null>(null);
  const [maximizedPanelId, setMaximizedPanelId] = useState<string | null>(null);
  const [feedUi, setFeedUi] = useState<Record<string, FeedPanelUi>>({});
  const [webStates, setWebStates] = useState<Record<string, WebPanelRuntimeState>>({});
  const [linkPreview, setLinkPreview] = useState<LinkPreview | null>(null);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [interactionActive, setInteractionActive] = useState(false);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);
  const [dismissedUpdateVersion, setDismissedUpdateVersion] = useState<string | null>(null);
  const [updateInstallConfirmationOpen, setUpdateInstallConfirmationOpen] = useState(false);
  const [restorePilotToolsUpdateFocus, setRestorePilotToolsUpdateFocus] = useState(false);
  const [restoreGlobalToolsFocus, setRestoreGlobalToolsFocus] = useState(false);
  const [semanticSearchStatus, setSemanticSearchStatus] = useState<SemanticSearchStatus>({
    phase: "not-installed", progress: 0, message: null, bytes: 0,
  });
  const [semanticSearchOpen, setSemanticSearchOpen] = useState(false);
  const [semanticSearchScope, setSemanticSearchScope] = useState<SemanticSearchScope>({ kind: "all" });
  const [activeSemanticSearch, setActiveSemanticSearch] = useState<ActiveSemanticSearch | null>(null);
  const [clock, setClock] = useState(() => new Date());
  const [feedTextScale, setFeedTextScale] = useState(loadFeedTextScale);
  const [feedTextScaleOverrides, setFeedTextScaleOverrides] = useState(loadFeedTextScaleOverrides);
  const [feedDensity, setFeedDensity] = useState(loadFeedDensity);
  const [feedDensityOverrides, setFeedDensityOverrides] = useState(loadFeedDensityOverrides);
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const readyUpdateVersion = updateState?.status === "ready"
    ? updateState.availableVersion ?? "suivante"
    : null;
  const updateNoticeDeferred = readyUpdateVersion !== null && dismissedUpdateVersion === readyUpdateVersion;
  const updateNoticeVisible = readyUpdateVersion !== null && !updateNoticeDeferred;
  const nativeWebSurfacesBlocked =
    Boolean(modal) ||
    semanticSearchOpen ||
    updateInstallConfirmationOpen ||
    interactionActive;

  useEffect(() => {
    if (updateInstallConfirmationOpen && !readyUpdateVersion) {
      if (!restorePilotToolsUpdateFocus) setRestoreGlobalToolsFocus(true);
      setUpdateInstallConfirmationOpen(false);
    }
  }, [readyUpdateVersion, restorePilotToolsUpdateFocus, updateInstallConfirmationOpen]);

  const layoutRef = useRef<LayoutNode | null>(null);
  const pilotToolsUpdateActionRef = useRef<HTMLButtonElement>(null);
  const globalToolsButtonRef = useRef<HTMLButtonElement>(null);
  const linkPreviewRef = useRef<LinkPreview | null>(null);
  const feedUiRef = useRef<Record<string, FeedPanelUi>>({});
  const draftsRef = useRef<Record<string, DraftPanel>>({});
  const webPreviewDraftsRef = useRef<Record<string, WebPreviewDraft>>({});
  const revisionRef = useRef(0);
  const hydratedRef = useRef(false);
  const serverLayoutMutationRef = useRef(false);

  useEffect(() => {
    if (
      !restorePilotToolsUpdateFocus ||
      modal?.kind !== "pilot-tools" ||
      updateInstallConfirmationOpen
    ) return;
    const frame = window.requestAnimationFrame(() => {
      pilotToolsUpdateActionRef.current?.focus({ preventScroll: true });
      setRestorePilotToolsUpdateFocus(false);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [modal, restorePilotToolsUpdateFocus, updateInstallConfirmationOpen]);

  useEffect(() => {
    if (restoreGlobalToolsFocus && !updateInstallConfirmationOpen) {
      const frame = window.requestAnimationFrame(() => {
        globalToolsButtonRef.current?.focus({ preventScroll: true });
        setRestoreGlobalToolsFocus(false);
      });
      return () => window.cancelAnimationFrame(frame);
    }
  }, [restoreGlobalToolsFocus, updateInstallConfirmationOpen]);
  const pendingRatioLayoutRef = useRef<LayoutNode | null>(null);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const toastTimerRef = useRef<number | null>(null);
  const templatePendingRef = useRef(false);
  const draftCompletionRef = useRef(new Set<string>());
  const lastPanelArrowRef = useRef<{ key: "ArrowLeft" | "ArrowRight"; at: number } | null>(null);
  const pendingPanelFocusRef = useRef<{
    panelId: string;
    identity: PanelFocusIdentity;
  } | null>(null);
  const pendingKeyboardPanelFocusRef = useRef<string | null>(null);
  const readerReturnFocusRef = useRef<ReaderReturnFocus | null>(null);
  const focusedPanelIdRef = useRef<string | null>(null);
  const semanticResultItemsRef = useRef<FeedItem[]>([]);
  const semanticBaseItemIdsRef = useRef(new Set<string>());
  const semanticSearchRestoreRef = useRef<SemanticSearchRestoreState | null>(null);
  const activeSemanticSearchRef = useRef<ActiveSemanticSearch | null>(null);
  const semanticSearchNativeOriginRef = useRef(false);

  layoutRef.current = layout;
  linkPreviewRef.current = linkPreview;
  feedUiRef.current = feedUi;
  draftsRef.current = drafts;
  focusedPanelIdRef.current = focusedPanelId;
  activeSemanticSearchRef.current = activeSemanticSearch;

  useLayoutEffect(() => {
    const pending = pendingPanelFocusRef.current;
    if (!pending) return;
    pendingPanelFocusRef.current = null;
    const leaf = document.querySelector<HTMLElement>(
      `.split-layout__leaf[data-panel-id="${CSS.escape(pending.panelId)}"]`,
    );
    const panel = leaf?.querySelector<HTMLElement>(".dashboard-panel");
    if (!panel) return;
    const focusable = [...panel.querySelectorAll<HTMLElement>(PANEL_FOCUSABLE_SELECTOR)];
    const identity = pending.identity;
    let target = identity.focusKey
      ? focusable.find(
          (candidate) =>
            candidate.getAttribute("data-panel-focus-key") === identity.focusKey,
        ) ?? null
      : null;
    if (!target && identity.id) {
      target = panel.querySelector<HTMLElement>(`#${CSS.escape(identity.id)}`);
    }
    if (!target && identity.ariaLabel) {
      target = focusable.find(
        (candidate) => candidate.getAttribute("aria-label") === identity.ariaLabel,
      ) ?? null;
    }
    if (!target && identity.panelTitle) {
      target = panel.querySelector<HTMLElement>(".panel-title");
    }
    if (!target && identity.index >= 0) target = focusable[identity.index] ?? null;
    const isRendered = (candidate: HTMLElement | null): candidate is HTMLElement => {
      if (!candidate || candidate.getClientRects().length === 0) return false;
      const style = window.getComputedStyle(candidate);
      return style.display !== "none" && style.visibility !== "hidden";
    };
    if (!isRendered(target)) {
      const title = panel.querySelector<HTMLElement>(".panel-title");
      target = isRendered(title) ? title : panel;
    }
    target.focus({ preventScroll: true });
    if (document.activeElement !== target) panel.focus({ preventScroll: true });
  }, [layout]);

  useLayoutEffect(() => {
    const pendingPanelId = pendingKeyboardPanelFocusRef.current;
    if (!pendingPanelId) return;
    if (focusDashboardPanelRoot(pendingPanelId)) {
      pendingKeyboardPanelFocusRef.current = null;
    }
  }, [focusedPanelId, layout, maximizedPanelId]);

  const panelById = useMemo(
    () => new Map(state?.panels.map((panel) => [panel.id, panel]) ?? []),
    [state],
  );
  const sourceById = useMemo(
    () => new Map(state?.sources.map((source) => [source.id, source]) ?? []),
    [state],
  );
  const failedWebPanelKey = Object.values(webStates)
    .filter(({ status }) => ["error", "crashed", "unresponsive"].includes(status))
    .map(({ panelId }) => panelId)
    .sort()
    .join("\u0000");

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2_600);
  }, []);

  // useLayoutEffect : appliquer l'échelle avant le premier paint pour éviter
  // un flash à 100 % quand une valeur est restaurée du stockage.
  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--feed-text-scale", String(feedTextScale));
    try {
      window.localStorage.setItem(FEED_TEXT_SCALE_STORAGE_KEY, String(feedTextScale));
    } catch {
      // Stockage indisponible : le réglage ne vaut que pour la session en cours.
    }
  }, [feedTextScale]);

  useLayoutEffect(() => {
    try {
      window.localStorage.setItem(
        FEED_TEXT_SCALE_OVERRIDES_STORAGE_KEY,
        JSON.stringify(feedTextScaleOverrides),
      );
    } catch {
      // Stockage indisponible : le réglage ne vaut que pour la session en cours.
    }
  }, [feedTextScaleOverrides]);

  useEffect(() => {
    if (!state) return;
    setFeedTextScaleOverrides((previous) => {
      const kept = Object.fromEntries(
        Object.entries(previous).filter(([panelId]) => panelById.has(panelId)),
      );
      return Object.keys(kept).length === Object.keys(previous).length ? previous : kept;
    });
  }, [panelById, state]);

  useLayoutEffect(() => {
    try {
      window.localStorage.setItem(FEED_DENSITY_STORAGE_KEY, feedDensity);
    } catch {
      // Stockage indisponible : le réglage ne vaut que pour la session en cours.
    }
  }, [feedDensity]);

  useLayoutEffect(() => {
    try {
      window.localStorage.setItem(
        FEED_DENSITY_OVERRIDES_STORAGE_KEY,
        JSON.stringify(feedDensityOverrides),
      );
    } catch {
      // Stockage indisponible : le réglage ne vaut que pour la session en cours.
    }
  }, [feedDensityOverrides]);

  useEffect(() => {
    if (!state) return;
    setFeedDensityOverrides((previous) => {
      const kept = Object.fromEntries(
        Object.entries(previous).filter(([panelId]) => panelById.has(panelId)),
      );
      return Object.keys(kept).length === Object.keys(previous).length ? previous : kept;
    });
  }, [panelById, state]);

  const adjustFeedTextScale = useCallback(
    (direction: -1 | 0 | 1, panelId: string | null = null) => {
      if (panelId) {
        if (direction === 0) {
          setFeedTextScaleOverrides((previous) => {
            if (!(panelId in previous)) return previous;
            const { [panelId]: _cleared, ...rest } = previous;
            return rest;
          });
          showToast(`Texte du fil : taille par défaut (${Math.round(feedTextScale * 100)} %)`);
          return;
        }
        const current = feedTextScaleOverrides[panelId] ?? feedTextScale;
        const next = clampFeedTextScale(current + direction * FEED_TEXT_SCALE_STEP);
        if (next !== current) {
          setFeedTextScaleOverrides((previous) => ({ ...previous, [panelId]: next }));
        }
        showToast(`Texte du fil : ${Math.round(next * 100)} %`);
        return;
      }
      const next = direction === 0
        ? 1
        : clampFeedTextScale(feedTextScale + direction * FEED_TEXT_SCALE_STEP);
      setFeedTextScale(next);
      showToast(`Texte des fils (défaut) : ${Math.round(next * 100)} %`);
    },
    [feedTextScale, feedTextScaleOverrides, showToast],
  );

  const setFeedPanelDensity = useCallback(
    (panelId: string, mode: FeedDensity, asGlobalDefault = false) => {
      if (asGlobalDefault) {
        setFeedDensity(mode);
        setFeedDensityOverrides({});
        showToast(
          mode === "dense"
            ? "Affichage dense (tous les fils)"
            : "Affichage confort (tous les fils)",
        );
        return;
      }
      setFeedDensityOverrides((previous) => {
        if (mode === feedDensity) {
          if (!(panelId in previous)) return previous;
          const { [panelId]: _cleared, ...rest } = previous;
          return rest;
        }
        if (previous[panelId] === mode) return previous;
        return { ...previous, [panelId]: mode };
      });
      showToast(mode === "dense" ? "Affichage dense" : "Affichage confort");
    },
    [feedDensity, showToast],
  );

  const applyServerState = useCallback((
    nextState: AppState,
    forceLayout = false,
    replaceFeedUi = false,
  ) => {
    const automaticInsertionMetrics = new Map<string, AutomaticInsertionMetrics>();
    for (const panel of nextState.panels) {
      if (panel.kind !== "feed") continue;
      const existing = feedUiRef.current[panel.id];
      const hasIncomingItem = existing && panelItems(panel, nextState).some(
        (item) => !item.isBaseline && !existing.visibleItemIds.has(item.id),
      );
      if (!hasIncomingItem) continue;
      const list = document.querySelector<HTMLElement>(
        `.split-layout__leaf[data-panel-id="${CSS.escape(panel.id)}"] .article-list`,
      );
      if (list) {
        const listTop = list.getBoundingClientRect().top;
        const anchorRow = [...list.querySelectorAll<HTMLElement>(".article-row")]
          .find((row) => row.getBoundingClientRect().bottom > listTop);
        const anchorPrefix = `article-${panel.id}-`;
        const anchorItemId = anchorRow?.id.startsWith(anchorPrefix)
          ? anchorRow.id.slice(anchorPrefix.length)
          : null;
        automaticInsertionMetrics.set(panel.id, {
          scrollTop: list.scrollTop,
          anchorItemId,
          anchorViewportTop: anchorRow
            ? anchorRow.getBoundingClientRect().top - listTop
            : null,
        });
      }
    }
    const resultItems = semanticResultItemsRef.current;
    if (semanticBaseItemIdsRef.current.size > 0) {
      for (const item of nextState.items) semanticBaseItemIdsRef.current.add(item.id);
    }
    setState(resultItems.length === 0 ? nextState : {
      ...nextState,
      items: [...nextState.items, ...resultItems.filter((item) => !nextState.items.some(({ id }) => id === item.id))],
    });
    setFeedUi((current) => {
      const activeFeedIds = new Set(
        nextState.panels
          .filter((panel): panel is FeedPanel => panel.kind === "feed")
          .map(({ id }) => id),
      );
      const next = Object.fromEntries(
        Object.entries(current).filter(([panelId]) => activeFeedIds.has(panelId)),
      );
      for (const panel of nextState.panels) {
        if (panel.kind !== "feed") continue;
        const existing = current[panel.id];
        if (!existing || replaceFeedUi) {
          const initial = initialFeedUi(panel, nextState);
          const activeSearch = activeSemanticSearchRef.current;
          next[panel.id] = activeSearch && (
            activeSearch.scope.kind === "all" || activeSearch.scope.panelId === panel.id
          )
            ? {
                ...initial,
                searchItemIds: new Set(activeSearch.result.items.map(({ id }) => id)),
              }
            : initial;
          continue;
        }
        const visibleItemIds = new Set(existing.visibleItemIds);
        const automaticInsertionIds = new Set<string>();
        const panelItemIds = new Set<string>();
        // The delivery buffer stays local to each panel, but every incoming row
        // is promoted in the same renderer update that receives it.
        for (const item of panelItems(panel, nextState)) {
          panelItemIds.add(item.id);
          if (!visibleItemIds.has(item.id) && !item.isBaseline) {
            automaticInsertionIds.add(item.id);
          }
          visibleItemIds.add(item.id);
        }
        const hasAutomaticInsertions = automaticInsertionIds.size > 0;
        let pendingArrivalIds = existing.pendingArrivalIds;
        if (pendingArrivalIds.size > 0) {
          // Purge par appartenance au panel : une source détachée ne doit pas
          // laisser la pastille compter des articles qui ne sont plus au fil.
          const kept = [...pendingArrivalIds].filter((id) => panelItemIds.has(id));
          if (kept.length !== pendingArrivalIds.size) pendingArrivalIds = new Set(kept);
        }
        next[panel.id] = {
          ...existing,
          visibleItemIds,
          automaticInsertionIds: hasAutomaticInsertions
            ? automaticInsertionIds
            : existing.automaticInsertionIds,
          automaticInsertionMetrics: hasAutomaticInsertions
            ? automaticInsertionMetrics.get(panel.id) ?? null
            : existing.automaticInsertionMetrics,
          pendingArrivalIds,
        };
      }
      return next;
    });
    setFatalError(null);
    const previousRevision = revisionRef.current;
    revisionRef.current = nextState.dashboard.revision;

    if (!hydratedRef.current) {
      hydratedRef.current = true;
      setLayout(nextState.dashboard.layout);
      layoutRef.current = nextState.dashboard.layout;
      setFocusedPanelId(layoutPanelIds(nextState.dashboard.layout)[0] ?? null);
      return;
    }

    if (
      forceLayout ||
      (nextState.dashboard.revision > previousRevision &&
        !serverLayoutMutationRef.current &&
        Object.keys(draftsRef.current).length === 0)
    ) {
      setLayout(nextState.dashboard.layout);
      layoutRef.current = nextState.dashboard.layout;
    }
  }, []);

  useEffect(() => {
    let live = true;
    window.vibedeck
      .getState()
      .then((nextState) => {
        if (live) applyServerState(nextState, true);
      })
      .catch((error) => {
        if (live) setFatalError(cleanError(error));
      });
    window.vibedeck
      .getUpdateState()
      .then((nextState) => {
        if (live) setUpdateState(nextState);
      })
      .catch(() => undefined);

    const unsubscribeState = window.vibedeck.onStateChanged((nextState) => {
      if (live) applyServerState(nextState);
    });
    const unsubscribeUpdate = window.vibedeck.onUpdateStateChanged((nextState) => {
      if (live) setUpdateState(nextState);
    });
    const unsubscribeWeb = window.vibedeck.onWebPanelStateChanged((nextState) => {
      if (!live) return;
      setWebStates((current) => {
        if (nextState.status === "destroyed") {
          const copy = { ...current };
          delete copy[nextState.panelId];
          return copy;
        }
        return { ...current, [nextState.panelId]: nextState };
      });
    });
    const unsubscribeWebEscape = window.vibedeck.onWebPanelEscape((panelId) => {
      if (webPreviewDraftsRef.current[panelId]) {
        window.vibedeck.focusDashboard();
        window.requestAnimationFrame(() => {
          document
            .querySelector<HTMLElement>(
              `[data-web-preview-controls="${CSS.escape(panelId)}"] button`,
            )
            ?.focus({ preventScroll: true });
        });
        return;
      }
      setLinkPreview((current) => {
        if (current) return null;
        setMaximizedPanelId(null);
        return current;
      });
    });
    const unsubscribeSemanticStatus = window.vibedeck.onSemanticSearchStatusChanged((nextStatus) => {
      if (live) setSemanticSearchStatus(nextStatus);
    });
    const unsubscribeGlobalSearch = window.vibedeck.onOpenGlobalSearch((nativeOrigin) => {
      if (!live) return;
      openSemanticSearch({ kind: "all" }, nativeOrigin);
    });
    void window.vibedeck.getSemanticSearchStatus().then((nextStatus) => {
      if (live) setSemanticSearchStatus(nextStatus);
    });

    return () => {
      live = false;
      unsubscribeState();
      unsubscribeUpdate();
      unsubscribeWeb();
      unsubscribeWebEscape();
      unsubscribeSemanticStatus();
      unsubscribeGlobalSearch();
    };
  }, [applyServerState]);

  useLayoutEffect(() => {
    if (linkPreview || !readerReturnFocusRef.current) return;
    const target = readerReturnFocusRef.current;
    readerReturnFocusRef.current = null;
    const activeElement = document.activeElement;
    if (!document.hasFocus()) return;
    if (
      activeElement instanceof HTMLElement &&
      activeElement !== document.body &&
      activeElement.isConnected &&
      activeElement.id !== target.rowId
    ) {
      return;
    }
    restoreArticleFocus(target);
  }, [linkPreview]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(
    () => () => {
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
      window.vibedeck.syncWebPanels([]);
    },
    [],
  );

  const syncWebPanels = useCallback(() => {
    if (!state) return;
    const failedPanelIds = new Set(
      failedWebPanelKey ? failedWebPanelKey.split("\u0000") : [],
    );
    const descriptors: WebPanelDescriptor[] = state.panels
      .filter((panel): panel is WebPanel => panel.kind === "web")
      .map((panel) => {
        const surface = document.querySelector<HTMLElement>(
          `[data-web-panel-surface="${panel.id}"]`,
        );
        const canDisplay =
          Boolean(surface) &&
          !nativeWebSurfacesBlocked &&
          !linkPreview &&
          !failedPanelIds.has(panel.id);
        const rect = surface?.getBoundingClientRect();
        return {
          kind: "web",
          panelId: panel.id,
          url: panel.url,
          bounds: rect
            ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
            : { x: 0, y: 0, width: 0, height: 0 },
          visible: canDisplay,
        };
      });
    for (const preview of Object.values(webPreviewDrafts)) {
      const surface = document.querySelector<HTMLElement>(
        `[data-web-preview-surface="${CSS.escape(preview.previewId)}"]`,
      );
      const rect = surface?.getBoundingClientRect();
      descriptors.push({
        kind: "preview",
        panelId: preview.previewId,
        bounds: rect
          ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          : { x: 0, y: 0, width: 0, height: 0 },
        visible:
          Boolean(surface) &&
          !nativeWebSurfacesBlocked &&
          !linkPreview &&
          !failedPanelIds.has(preview.previewId),
      });
    }
    if (linkPreview) {
      const surface = document.querySelector<HTMLElement>(
        `[data-web-panel-surface="${LINK_READER_ID}"]`,
      );
      const rect = surface?.getBoundingClientRect();
      descriptors.push({
        kind: "reader",
        panelId: LINK_READER_ID,
        itemId: linkPreview.itemId,
        bounds: rect
          ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          : { x: 0, y: 0, width: 0, height: 0 },
        visible:
          Boolean(surface) &&
          !nativeWebSurfacesBlocked &&
          !failedPanelIds.has(LINK_READER_ID),
      });
    }
    window.vibedeck.syncWebPanels(descriptors);
  }, [
    failedWebPanelKey,
    linkPreview,
    nativeWebSurfacesBlocked,
    state,
    webPreviewDrafts,
  ]);

  useEffect(() => {
    let frame = requestAnimationFrame(syncWebPanels);
    const settleTimer = window.setTimeout(syncWebPanels, 120);
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(syncWebPanels);
    });
    const dashboard = document.querySelector(".dashboard-stage");
    if (dashboard) observer.observe(dashboard);
    window.addEventListener("resize", syncWebPanels);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settleTimer);
      observer.disconnect();
      window.removeEventListener("resize", syncWebPanels);
    };
  }, [layout, maximizedPanelId, syncWebPanels]);

  const persistLayout = useCallback(
    (nextLayout: LayoutNode | null) => {
      if (Object.keys(draftsRef.current).length > 0) return Promise.resolve();
      const job = saveChainRef.current.then(async () => {
        serverLayoutMutationRef.current = true;
        try {
          const nextState = await window.vibedeck.saveDashboardLayout(
            nextLayout,
            revisionRef.current,
          );
          applyServerState(nextState);
        } catch (error) {
          showToast(cleanError(error));
          const recovered = await window.vibedeck.getState();
          applyServerState(recovered, true);
        } finally {
          serverLayoutMutationRef.current = false;
        }
      });
      saveChainRef.current = job.catch(() => undefined);
      return job;
    },
    [applyServerState, showToast],
  );

  function beginDraft(
    targetPanelId: string | null = null,
    direction: "row" | "column" = "row",
  ) {
    setLinkPreview(null);
    const existingDraftId = Object.keys(draftsRef.current)[0];
    if (existingDraftId) {
      setFocusedPanelId(existingDraftId);
      setMaximizedPanelId(null);
      return existingDraftId;
    }
    const draftId = `draft:${crypto.randomUUID()}`;
    const target =
      targetPanelId ??
      (focusedPanelId && !drafts[focusedPanelId] ? focusedPanelId : null) ??
      layoutPanelIds(layout).find((id) => !drafts[id]) ??
      null;
    let effectiveDirection = direction;
    if (target) {
      const targetLeaf = document.querySelector<HTMLElement>(
        `.split-layout__leaf[data-panel-id="${CSS.escape(target)}"]`,
      );
      const bounds = targetLeaf?.getBoundingClientRect();
      if (bounds) {
        const canSplitRow = bounds.width >= MIN_HORIZONTAL_SPLIT_WIDTH;
        const canSplitColumn = bounds.height >= MIN_VERTICAL_SPLIT_HEIGHT;
        if (effectiveDirection === "row" && !canSplitRow && canSplitColumn) {
          effectiveDirection = "column";
        } else if (effectiveDirection === "column" && !canSplitColumn && canSplitRow) {
          effectiveDirection = "row";
        } else if (!canSplitRow && !canSplitColumn) {
          showToast("Ce panel est trop petit pour être divisé. Agrandissez-le d’abord.");
          return null;
        }
      }
    }
    const side: DraftPanel["side"] = target
      ? effectiveDirection === "row"
        ? "right"
        : "bottom"
      : null;
    const nextDraft: DraftPanel = {
      id: draftId,
      targetPanelId: target,
      side,
      pending: false,
    };
    const nextLayout = splitPanel(layout, target, draftId, effectiveDirection);
    const nextDrafts = { ...draftsRef.current, [draftId]: nextDraft };
    draftsRef.current = nextDrafts;
    setDrafts(nextDrafts);
    setLayout(nextLayout);
    layoutRef.current = nextLayout;
    setFocusedPanelId(draftId);
    setMaximizedPanelId(null);
    return draftId;
  }

  function setDraftPending(draftId: string, pending: boolean) {
    const draft = draftsRef.current[draftId];
    if (!draft || draft.pending === pending) return;
    const nextDrafts = {
      ...draftsRef.current,
      [draftId]: { ...draft, pending },
    };
    draftsRef.current = nextDrafts;
    setDrafts(nextDrafts);
  }

  async function startWebPreview(draftId: string, url: string) {
    if (!draftsRef.current[draftId]) {
      throw new Error("Ce nouveau panel n’est plus disponible.");
    }
    const preview = await window.vibedeck.startWebPreview(draftId, url);
    if (!draftsRef.current[draftId]) {
      await window.vibedeck.cancelWebPreview(preview.previewId);
      throw new Error("Ce nouveau panel a été fermé pendant le chargement.");
    }
    const next = {
      ...webPreviewDraftsRef.current,
      [draftId]: preview,
    };
    webPreviewDraftsRef.current = next;
    setWebPreviewDrafts(next);
  }

  async function cancelWebPreview(draftId: string) {
    const preview = webPreviewDraftsRef.current[draftId];
    if (!preview) return;
    try {
      await window.vibedeck.cancelWebPreview(preview.previewId);
    } finally {
      const next = { ...webPreviewDraftsRef.current };
      delete next[draftId];
      webPreviewDraftsRef.current = next;
      setWebPreviewDrafts(next);
      setWebStates((current) => {
        const copy = { ...current };
        delete copy[preview.previewId];
        return copy;
      });
    }
  }

  async function startCompetitorTemplate() {
    if (templatePendingRef.current) return;
    templatePendingRef.current = true;
    const catalogIds = state?.sourceCatalog
      .filter(({ name }) => ["Le Monde", "Le Figaro", "Le Parisien"].includes(name))
      .map(({ id }) => id) ?? [];
    if (catalogIds.length === 0) {
      showToast("Le pack de sources n’est pas disponible.");
      beginDraft();
      templatePendingRef.current = false;
      return;
    }
    const draftId = beginDraft();
    if (!draftId) {
      templatePendingRef.current = false;
      return;
    }
    try {
      await completeDraft(
        draftId,
        {
          kind: "feed",
          name: "Veille concurrents",
          defaultRefreshIntervalSeconds: 60,
        },
        catalogIds,
      );
    } catch (error) {
      showToast(cleanError(error));
    } finally {
      templatePendingRef.current = false;
    }
  }

  function closeDraft(draftId: string) {
    if (draftsRef.current[draftId]?.pending || draftCompletionRef.current.has(draftId)) {
      return;
    }
    void cancelWebPreview(draftId).catch((error) => showToast(cleanError(error)));
    const nextLayout = removePanel(layoutRef.current, draftId);
    const nextDrafts = { ...draftsRef.current };
    delete nextDrafts[draftId];
    draftsRef.current = nextDrafts;
    setDrafts(nextDrafts);
    setLayout(nextLayout);
    layoutRef.current = nextLayout;
    setFocusedPanelId(layoutPanelIds(nextLayout)[0] ?? null);
  }

  async function completeDraft(
    draftId: string,
    input: CreatePanelInput,
    catalogIds: string[] = [],
    customSources: PendingCustomSource[] = [],
  ) {
    const draft = draftsRef.current[draftId];
    if (!draft || !state) return;
    if (draftCompletionRef.current.has(draftId)) return;
    if (
      input.kind === "web" &&
      state.panels.filter((panel) => panel.kind === "web").length >=
        MAX_DASHBOARD_WEB_PANELS
    ) {
      throw new Error(
        `Le dashboard accepte jusqu’à ${MAX_DASHBOARD_WEB_PANELS} pages web simultanées.`,
      );
    }
    draftCompletionRef.current.add(draftId);
    setDraftPending(draftId, true);
    const previousIds = new Set(state.panels.map(({ id }) => id));
    serverLayoutMutationRef.current = true;
    try {
      const webPreview = webPreviewDraftsRef.current[draftId];
      let nextState = input.kind === "web" && webPreview
        ? await window.vibedeck.commitWebPreview(
            webPreview.previewId,
            input.name,
            panelPlacementForDraft(draft),
          )
        : await window.vibedeck.createPanel(
            input,
            panelPlacementForDraft(draft),
          );
      const createdPanel = nextState.panels.find(({ id }) => !previousIds.has(id));
      if (!createdPanel) throw new Error("Le nouveau panel n’a pas pu être retrouvé.");

      if (webPreview) {
        const nextPreviews = { ...webPreviewDraftsRef.current };
        delete nextPreviews[draftId];
        webPreviewDraftsRef.current = nextPreviews;
        setWebPreviewDrafts(nextPreviews);
      }

      const sourceErrors: string[] = [];
      let sourceSuccesses = 0;
      if (createdPanel.kind === "feed") {
        const refreshIntervalSeconds =
          input.kind === "feed" ? input.defaultRefreshIntervalSeconds : undefined;
        for (const catalogId of catalogIds) {
          try {
            const result = await window.vibedeck.addCatalogSource(
              createdPanel.id,
              catalogId,
              { refreshIntervalSeconds },
            );
            nextState = result.state;
            sourceSuccesses += 1;
          } catch (error) {
            sourceErrors.push(cleanError(error));
          }
        }
        for (const source of customSources) {
          try {
            const result = await window.vibedeck.addSource(createdPanel.id, {
              ...source,
              refreshIntervalSeconds,
            });
            nextState = result.state;
            sourceSuccesses += 1;
          } catch (error) {
            sourceErrors.push(cleanError(error));
          }
        }
        if (sourceSuccesses === 0 && catalogIds.length + customSources.length > 0) {
          await window.vibedeck.deletePanel(createdPanel.id);
          throw new Error(sourceErrors[0] ?? "Aucune source n’a pu être ajoutée à ce fil.");
        }
      }

      const desiredLayout = replacePanelId(layoutRef.current, draftId, createdPanel.id);
      let layoutWarning = false;
      if (desiredLayout) {
        try {
          nextState = await window.vibedeck.saveDashboardLayout(
            desiredLayout,
            nextState.dashboard.revision,
          );
        } catch {
          layoutWarning = true;
          nextState = await window.vibedeck.getState();
        }
      }

      const nextDrafts = { ...draftsRef.current };
      delete nextDrafts[draftId];
      draftsRef.current = nextDrafts;
      setDrafts(nextDrafts);
      applyServerState(nextState, true);
      setFocusedPanelId(createdPanel.id);

      if (sourceErrors.length > 0) {
        showToast(
          `${sourceErrors.length} source(s) ignorée(s) : ${sourceErrors[0]}`,
        );
      } else if (layoutWarning) {
        showToast("Panel créé, mais sa disposition a été réinitialisée.");
      } else {
        showToast(input.kind === "web" ? "Page web ajoutée" : "Fil créé");
      }
    } finally {
      draftCompletionRef.current.delete(draftId);
      setDraftPending(draftId, false);
      serverLayoutMutationRef.current = false;
    }
  }

  async function closePanel(panelId: string) {
    serverLayoutMutationRef.current = true;
    try {
      const nextState = await window.vibedeck.deletePanel(panelId);
      applyServerState(nextState, true);
      setModal(null);
      setMaximizedPanelId((current) => (current === panelId ? null : current));
      setFocusedPanelId(layoutPanelIds(nextState.dashboard.layout)[0] ?? null);
      showToast("Panel fermé");
    } catch (error) {
      showToast(cleanError(error));
    } finally {
      serverLayoutMutationRef.current = false;
    }
  }

  async function clearDashboard() {
    if (!state) return;
    serverLayoutMutationRef.current = true;
    try {
      let nextState = state;
      for (const panel of [...state.panels]) {
        nextState = await window.vibedeck.deletePanel(panel.id);
      }
      applyServerState(nextState, true);
      setDrafts({});
      setModal(null);
      setFocusedPanelId(null);
      setMaximizedPanelId(null);
      setLinkPreview(null);
      showToast("Dashboard vidé");
    } catch (error) {
      showToast(cleanError(error));
    } finally {
      serverLayoutMutationRef.current = false;
    }
  }

  async function renamePanel(panelId: string, name: string) {
    try {
      applyServerState(await window.vibedeck.renamePanel(panelId, name));
    } catch (error) {
      showToast(cleanError(error));
    }
  }

  async function updateWebPanelUrl(panelId: string, url: string) {
    try {
      const nextState = await window.vibedeck.setWebPanelUrl(panelId, url);
      applyServerState(nextState);
      showToast("Page mise à jour");
    } catch (error) {
      showToast(cleanError(error));
      throw error;
    }
  }

  async function refreshFeedPanel(panel: FeedPanel) {
    if (!state) return;
    const sources = panel.sourceIds
      .map((sourceId) => sourceById.get(sourceId))
      .filter((source): source is Source => Boolean(source));
    if (sources.length === 0) return;
    try {
      const nextState = await window.vibedeck.refreshPanel(panel.id);
      const failedCount = nextState.sources.filter(
        (source) => panel.sourceIds.includes(source.id) && source.status === "error",
      ).length;
      showToast(
        failedCount > 0
          ? `${failedCount} source${failedCount > 1 ? "s" : ""} indisponible${failedCount > 1 ? "s" : ""} · cache conservé`
          : "Panel actualisé",
      );
    } catch (error) {
      showToast(cleanError(error));
    }
  }

  function openItem(item: FeedItem, returnFocus: ReaderReturnFocus) {
    readerReturnFocusRef.current = returnFocus;
    setWebStates((current) => {
      if (!(LINK_READER_ID in current)) return current;
      const next = { ...current };
      delete next[LINK_READER_ID];
      return next;
    });
    setLinkPreview({ itemId: item.id, title: item.title });
    void window.vibedeck
      .markItemOpened(item.id)
      .then((nextState) => applyServerState(nextState))
      .catch((error) => showToast(cleanError(error)));
  }

  function markItemsSeen(itemIds: string[]) {
    if (itemIds.length === 0) return;
    void window.vibedeck
      .markItemsSeen(itemIds)
      .then((nextState) => applyServerState(nextState))
      .catch((error) => showToast(cleanError(error)));
  }

  function patchFeedUi(panelId: string, patch: Partial<FeedPanelUi>) {
    setFeedUi((current) => ({
      ...current,
      [panelId]: {
        sourceFilter: current[panelId]?.sourceFilter ?? "all",
        visibilityFilter: current[panelId]?.visibilityFilter ?? "all",
        focusedItemId: current[panelId]?.focusedItemId ?? null,
        visibleItemIds: current[panelId]?.visibleItemIds ?? new Set(),
        automaticInsertionIds: current[panelId]?.automaticInsertionIds ?? new Set(),
        automaticInsertionMetrics: current[panelId]?.automaticInsertionMetrics ?? null,
        pendingArrivalIds: current[panelId]?.pendingArrivalIds ?? new Set(),
        searchItemIds: current[panelId]?.searchItemIds ?? null,
        ...patch,
      },
    }));
  }

  function clearSemanticSearchFilter() {
    const resultIds = new Set(semanticResultItemsRef.current.map(({ id }) => id));
    const baseIds = semanticBaseItemIdsRef.current;
    const restore = semanticSearchRestoreRef.current;
    semanticResultItemsRef.current = [];
    semanticBaseItemIdsRef.current = new Set();
    activeSemanticSearchRef.current = null;
    setActiveSemanticSearch(null);
    setState((current) => current ? {
      ...current,
      items: current.items.filter((item) => !resultIds.has(item.id) || baseIds.has(item.id)),
    } : current);
    setFeedUi((current) => Object.fromEntries(Object.entries(current).map(([panelId, ui]) => [
      panelId, {
        ...ui,
        searchItemIds: null,
        focusedItemId: restore?.focusedItemIdsByPanelId.get(panelId) ?? null,
        automaticInsertionIds: new Set(),
        automaticInsertionMetrics: null,
        pendingArrivalIds: new Set(),
      },
    ])));
    semanticSearchRestoreRef.current = null;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (!restore) return;
        for (const [panelId, scrollTop] of restore.scrollTopByPanelId) {
          const list = document.querySelector<HTMLElement>(
            `.split-layout__leaf[data-panel-id="${CSS.escape(panelId)}"] .article-list`,
          );
          const anchor = restore.scrollAnchorByPanelId.get(panelId);
          const anchorRow = anchor
            ? document.getElementById(`article-${panelId}-${anchor.itemId}`)
            : null;
          if (list && anchorRow instanceof HTMLElement && anchor) {
            list.scrollTop = anchorRow.offsetTop - anchor.viewportTop;
          } else if (list) list.scrollTop = scrollTop;
        }
        restoreSemanticSearchControl(restore);
      });
    });
  }

  useEffect(() => {
    if (!activeSemanticSearch || !state) return;
    const feedPanels = state.panels.filter((panel): panel is FeedPanel => panel.kind === "feed");
    if (feedPanels.length === 0) {
      clearSemanticSearchFilter();
      return;
    }
    if (activeSemanticSearch.scope.kind !== "panel") return;
    const scopedPanelId = activeSemanticSearch.scope.panelId;
    const scopedPanel = state.panels.find(({ id }) => id === scopedPanelId);
    if (scopedPanel?.kind === "feed") return;
    clearSemanticSearchFilter();
    showToast("Le fil recherché n’existe plus");
  }, [activeSemanticSearch, showToast, state]);

  function captureSemanticSearchOrigin() {
    if (semanticSearchRestoreRef.current) return;
    const scrollTopByPanelId = new Map<string, number>();
    const scrollAnchorByPanelId = new Map<
      string,
      { itemId: string; viewportTop: number }
    >();
    document.querySelectorAll<HTMLElement>(".split-layout__leaf[data-panel-id]").forEach((leaf) => {
      const panelId = leaf.getAttribute("data-panel-id");
      const list = leaf.querySelector<HTMLElement>(".article-list");
      if (!panelId || !list) return;
      scrollTopByPanelId.set(panelId, list.scrollTop);
      const listTop = list.getBoundingClientRect().top;
      const anchorRow = [...list.querySelectorAll<HTMLElement>(".article-row")]
        .find((row) => row.getBoundingClientRect().bottom > listTop);
      const itemId = anchorRow?.id.startsWith(`article-${panelId}-`)
        ? anchorRow.id.slice(`article-${panelId}-`.length)
        : null;
      if (anchorRow && itemId) {
        scrollAnchorByPanelId.set(panelId, {
          itemId,
          viewportTop: anchorRow.getBoundingClientRect().top - listTop,
        });
      }
    });
    const focusedElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusedLeaf = focusedElement?.closest<HTMLElement>(
      ".split-layout__leaf[data-panel-id]",
    );
    const focusedControlPanelId = focusedLeaf?.getAttribute("data-panel-id") ?? null;
    semanticSearchRestoreRef.current = {
      focusedPanelId: focusedPanelIdRef.current,
      focusedControl: focusedElement && focusedControlPanelId
        ? {
            panelId: focusedControlPanelId,
            id: focusedElement.id || null,
            focusKey: focusedElement.getAttribute("data-panel-focus-key"),
            ariaLabel: focusedElement.getAttribute("aria-label"),
          }
        : null,
      focusedItemIdsByPanelId: new Map(
        Object.entries(feedUiRef.current).map(([panelId, ui]) => [panelId, ui.focusedItemId]),
      ),
      scrollAnchorByPanelId,
      scrollTopByPanelId,
    };
  }

  function openSemanticSearch(scope: SemanticSearchScope, nativeOrigin = false) {
    captureSemanticSearchOrigin();
    semanticSearchNativeOriginRef.current = nativeOrigin;
    setSemanticSearchScope(scope);
    setSemanticSearchOpen(true);
  }

  function closeSemanticSearchPalette() {
    setSemanticSearchOpen(false);
    const restoreNative = semanticSearchNativeOriginRef.current;
    semanticSearchNativeOriginRef.current = false;
    window.vibedeck.finishSemanticSearchFocus(restoreNative);
    if (restoreNative) {
      if (!activeSemanticSearch) semanticSearchRestoreRef.current = null;
      return;
    }
    if (activeSemanticSearch) return;
    const restore = semanticSearchRestoreRef.current;
    semanticSearchRestoreRef.current = null;
    window.requestAnimationFrame(() => {
      restoreSemanticSearchControl(restore);
    });
  }

  function applySemanticSearchFilter(
    query: string,
    scope: SemanticSearchScope,
    result: SemanticSearchResult,
  ) {
    if (!activeSemanticSearch) {
      semanticBaseItemIdsRef.current = new Set(state?.items.map(({ id }) => id) ?? []);
    }
    const baseIds = semanticBaseItemIdsRef.current;
    const previousResultIds = new Set(semanticResultItemsRef.current.map(({ id }) => id));
    semanticResultItemsRef.current = result.items;
    setState((current) => current ? {
      ...current,
      items: (() => {
        const retained = current.items.filter(
          (item) => !previousResultIds.has(item.id) || baseIds.has(item.id),
        );
        const retainedIds = new Set(retained.map(({ id }) => id));
        return [...retained, ...result.items.filter(({ id }) => !retainedIds.has(id))];
      })(),
    } : current);
    const resultIds = new Set(result.items.map(({ id }) => id));
    setFeedUi((current) => Object.fromEntries(Object.entries(current).map(([panelId, ui]) => [
      panelId,
      scope.kind === "all" || scope.panelId === panelId
        ? { ...ui, searchItemIds: resultIds, focusedItemId: null, pendingArrivalIds: new Set<string>() }
        : { ...ui, searchItemIds: null, pendingArrivalIds: new Set<string>() },
    ])));
    const appliedSearch = { query, scope, resultCount: result.items.length, result };
    activeSemanticSearchRef.current = appliedSearch;
    setActiveSemanticSearch(appliedSearch);
    setSemanticSearchOpen(false);
    semanticSearchNativeOriginRef.current = false;
    window.vibedeck.finishSemanticSearchFocus(false);
    const destinationPanelId = scope.kind === "panel"
      ? scope.panelId
      : semanticSearchRestoreRef.current?.focusedPanelId ??
        state?.panels.find((panel): panel is FeedPanel => panel.kind === "feed")?.id ?? null;
    if (destinationPanelId) setFocusedPanelId(destinationPanelId);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (destinationPanelId) focusDashboardPanelRoot(destinationPanelId);
      });
    });
    if (result.truncated) showToast("Résultats limités à 200 articles");
  }

  // Remplacer le listener clavier dans le même commit que le DOM évite qu’un
  // raccourci rapide observe la nouvelle interface avec un état React périmé.
  useLayoutEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (semanticSearchOpen) {
          closeSemanticSearchPalette();
        }
        else if (isTypingTarget(event.target)) return;
        else if (!modal && linkPreview) setLinkPreview(null);
        else if (Object.values(feedUi).some(({ searchItemIds }) => searchItemIds !== null)) {
          clearSemanticSearchFilter();
        }
        else if (!modal && maximizedPanelId) setMaximizedPanelId(null);
        return;
      }
      if (modal) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openSemanticSearch({ kind: "all" });
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        beginDraft();
        return;
      }
      // event.code pour le zéro : sur AZERTY la touche 0 non shiftée produit
      // event.key === "à" ; !altKey pour laisser passer AltGr (ctrl+alt) ;
      // "Insert" exclu car Numpad0 sans NumLock = Ctrl+Insert (copie).
      const feedTextScaleReset =
        event.key !== "Insert" &&
        (event.key === "0" || event.code === "Digit0" || event.code === "Numpad0");
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !semanticSearchOpen &&
        (feedTextScaleReset || ["+", "=", "-", "_"].includes(event.key))
      ) {
        event.preventDefault();
        // Le raccourci ajuste le fil survolé/focalisé ; sans fil ciblé, il
        // ajuste la taille par défaut de tous les fils sans réglage propre.
        const zoomEventPanelId =
          event.target instanceof HTMLElement
            ? event.target
                .closest<HTMLElement>(".split-layout__leaf[data-panel-id]")
                ?.getAttribute("data-panel-id") ?? null
            : null;
        const zoomCandidateId = zoomEventPanelId ?? focusedPanelId;
        const zoomPanelId =
          zoomCandidateId && panelById.get(zoomCandidateId)?.kind === "feed"
            ? zoomCandidateId
            : null;
        adjustFeedTextScale(
          feedTextScaleReset ? 0 : event.key === "-" || event.key === "_" ? -1 : 1,
          zoomPanelId,
        );
        return;
      }
      if (linkPreview) return;
      if (
        isTypingTarget(event.target) ||
        isKeyboardShortcutBlockedTarget(event.target) ||
        !state
      ) {
        return;
      }
      const eventPanelId =
        event.target instanceof HTMLElement
          ? event.target
              .closest<HTMLElement>(".split-layout__leaf[data-panel-id]")
              ?.getAttribute("data-panel-id") ?? null
          : null;
      const keyboardPanelId =
        eventPanelId && panelById.has(eventPanelId) ? eventPanelId : focusedPanelId;
      if (!keyboardPanelId) return;

      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        if (event.repeat) return;
        const now = performance.now();
        const previous = lastPanelArrowRef.current;
        if (previous?.key === event.key && now - previous.at <= 360) {
          lastPanelArrowRef.current = null;
          const panelIds = layoutPanelIds(layoutRef.current);
          const currentIndex = panelIds.indexOf(keyboardPanelId);
          if (panelIds.length > 1 && currentIndex >= 0) {
            const offset = event.key === "ArrowRight" ? 1 : -1;
            const nextIndex = (currentIndex + offset + panelIds.length) % panelIds.length;
            const nextPanelId = panelIds[nextIndex];
            pendingKeyboardPanelFocusRef.current = nextPanelId;
            setFocusedPanelId(nextPanelId);
            if (maximizedPanelId) setMaximizedPanelId(nextPanelId);
            if (focusDashboardPanelRoot(nextPanelId)) {
              pendingKeyboardPanelFocusRef.current = null;
            }
          }
        } else {
          lastPanelArrowRef.current = { key: event.key, at: now };
        }
        return;
      }

      const panel = panelById.get(keyboardPanelId);
      if (!panel || panel.kind !== "feed") return;
      const ui = feedUi[panel.id] ?? initialFeedUi(panel, state);
      const items = panelItems(panel, state, {
        sourceFilter: ui.sourceFilter,
        visibleItemIds: ui.visibleItemIds,
        visibilityFilter: ui.visibilityFilter,
        focusedItemId: ui.focusedItemId,
        searchItemIds: ui.searchItemIds,
      });

      if (event.key.toLowerCase() === "r") {
        event.preventDefault();
        if (
          panel.sourceIds.some(
            (sourceId) => sourceById.get(sourceId)?.status === "refreshing",
          )
        ) {
          return;
        }
        void refreshFeedPanel(panel);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const focusedIndex = items.findIndex(({ id }) => id === ui.focusedItemId);
        const activeArticleId =
          event.target instanceof HTMLElement
            ? event.target.closest<HTMLElement>(".article-row")?.id ?? null
            : null;
        const activeArticleIndex = activeArticleId
          ? items.findIndex(({ id }) => activeArticleId === `article-${panel.id}-${id}`)
          : -1;
        const currentIndex = focusedIndex >= 0
          ? focusedIndex
          : activeArticleIndex;
        const direction = event.key === "ArrowDown" ? 1 : -1;
        const nextIndex = Math.max(
          0,
          Math.min(items.length - 1, currentIndex < 0 ? 0 : currentIndex + direction),
        );
        const item = items[nextIndex];
        if (item) {
          patchFeedUi(panel.id, { focusedItemId: item.id });
          const article = document.getElementById(`article-${panel.id}-${item.id}`);
          if (article) {
            article.focus({ preventScroll: true });
            const list = article.closest<HTMLElement>(".article-list");
            if (list) smoothScrollIntoView(list, article);
            else article.scrollIntoView({ block: "nearest" });
          }
        }
        return;
      }
      if (event.key === "Enter" && ui.focusedItemId) {
        const item = items.find(({ id }) => id === ui.focusedItemId);
        if (item) {
          event.preventDefault();
          if (ui.visibilityFilter === "unseen") {
            patchFeedUi(panel.id, { focusedItemId: null });
          }
          void openItem(item, {
            panelId: panel.id,
            rowId: `article-${panel.id}-${item.id}`,
          });
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  if (fatalError) {
    return (
      <main className="fatal-state">
        <Brand vertical />
        <h1>Le dashboard n’a pas pu s’ouvrir.</h1>
        <p>{fatalError}</p>
        <button type="button" className="primary-button" onClick={() => window.location.reload()}>
          Réessayer
        </button>
      </main>
    );
  }

  if (!state) {
    return (
      <main className="boot-screen" aria-live="polite">
        <Brand vertical />
        <span>Ouverture de la veille…</span>
      </main>
    );
  }

  function movePanelByOffset(
    panelId: string,
    offset: -1 | 1,
    identity: PanelFocusIdentity,
  ) {
    const panelIds = layoutPanelIds(layoutRef.current).filter((id) => !draftsRef.current[id]);
    const currentIndex = panelIds.indexOf(panelId);
    if (currentIndex < 0 || panelIds.length < 2) return;
    const targetIndex = (currentIndex + offset + panelIds.length) % panelIds.length;
    const targetPanelId = panelIds[targetIndex];
    const nextLayout = swapPanels(layoutRef.current, panelId, targetPanelId);
    pendingPanelFocusRef.current = { panelId, identity };
    setLayout(nextLayout);
    layoutRef.current = nextLayout;
    setFocusedPanelId(panelId);
    if (nextLayout) void persistLayout(nextLayout);
    showToast(offset < 0 ? "Panel déplacé à la position précédente" : "Panel déplacé à la position suivante");
  }

  function renderPanel(panelId: string) {
    const draft = drafts[panelId];
    if (draft) {
      return (
        <DraftPanelView
          key={panelId}
          draft={draft}
          catalog={state!.sourceCatalog}
          webPreview={webPreviewDrafts[panelId] ?? null}
          webPreviewRuntime={webStates[panelId]}
          focused={focusedPanelId === panelId}
          onFocus={() => setFocusedPanelId(panelId)}
          onClose={() => closeDraft(panelId)}
          onStartWebPreview={(url) => startWebPreview(panelId, url)}
          onCancelWebPreview={() => cancelWebPreview(panelId)}
          onComplete={(input, catalogIds, customSources) =>
            completeDraft(panelId, input, catalogIds, customSources)
          }
        />
      );
    }
    const panel = panelById.get(panelId);
    if (!panel) return <MissingPanel panelId={panelId} />;
    const common = {
      focused: focusedPanelId === panel.id,
      maximized: maximizedPanelId === panel.id,
      actionsDisabled: Object.keys(drafts).length > 0,
      onFocus: () => setFocusedPanelId(panel.id),
      onSplit: (direction: "row" | "column") => beginDraft(panel.id, direction),
      onMaximize: () =>
        setMaximizedPanelId((current) => (current === panel.id ? null : panel.id)),
      onClose: () => setModal({ kind: "close-panel", panelId: panel.id }),
      onRename: (name: string) => renamePanel(panel.id, name),
      onMove: (offset: -1 | 1, identity: PanelFocusIdentity) =>
        movePanelByOffset(panel.id, offset, identity),
    };
    if (panel.kind === "feed") {
      const ui = feedUi[panel.id] ?? initialFeedUi(panel, state!);
      return (
        <FeedPanelView
          key={panel.id}
          panel={panel}
          state={state!}
          ui={ui}
          onUi={(patch) => patchFeedUi(panel.id, patch)}
          onOpen={(item, rowId) => openItem(item, { panelId: panel.id, rowId })}
          onSeen={markItemsSeen}
          onRefresh={() => refreshFeedPanel(panel)}
          onConfigure={() => setModal({ kind: "configure-feed", panelId: panel.id })}
          onSearch={() => {
            openSemanticSearch({ kind: "panel", panelId: panel.id });
          }}
          searchQuery={activeSemanticSearch?.query ?? null}
          onClearSearch={clearSemanticSearchFilter}
          textScale={feedTextScaleOverrides[panel.id] ?? feedTextScale}
          textScaleOverride={feedTextScaleOverrides[panel.id] ?? null}
          onTextScale={(direction) => adjustFeedTextScale(direction, panel.id)}
          density={feedDensityOverrides[panel.id] ?? feedDensity}
          onDensity={(mode, asGlobalDefault) => setFeedPanelDensity(panel.id, mode, asGlobalDefault)}
          {...common}
        />
      );
    }
    return (
      <WebPanelView
        key={panel.id}
        panel={panel}
        runtime={webStates[panel.id]}
        onSetUrl={(url) => updateWebPanelUrl(panel.id, url)}
        {...common}
      />
    );
  }

  return (
    <div className={`app-shell${isMac ? " app-shell--mac" : ""}`}>
      <div
        className="visually-hidden update-announcement"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {updateStateAnnouncement(updateState)}
      </div>
      <header
        className="global-bar"
        aria-hidden={modal || semanticSearchOpen || updateInstallConfirmationOpen ? true : undefined}
        inert={modal || semanticSearchOpen || updateInstallConfirmationOpen ? true : undefined}
      >
        <Brand />
        <time>{clock.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</time>
        <div className="global-bar__spacer" />
        {activeSemanticSearch && (
          <>
            <button
              type="button"
              className="search-filter-summary"
              onClick={() => {
                openSemanticSearch(activeSemanticSearch.scope);
              }}
              title="Modifier la recherche active"
            >
              <Search size={13} />
              <span>{activeSemanticSearch.query}</span>
              <small>
                {activeSemanticSearch.scope.kind === "all"
                  ? "Tous"
                  : panelById.get(activeSemanticSearch.scope.panelId)?.name ?? "Fil"}
              </small>
              <em>{activeSemanticSearch.resultCount}</em>
            </button>
            <IconButton label="Retirer le filtre de recherche" onClick={clearSemanticSearchFilter}>
              <X size={13} />
            </IconButton>
          </>
        )}
        <button
          type="button"
          className="quiet-button"
          disabled={!state.panels.some((panel) => panel.kind === "feed")}
          onClick={() => {
            openSemanticSearch({ kind: "all" });
          }}
        >
          <Search size={13} /> Rechercher
        </button>
        <div className="text-scale-group" role="group" aria-label="Taille du texte des fils">
          <button
            type="button"
            className="quiet-button text-scale-button"
            aria-disabled={feedTextScale <= FEED_TEXT_SCALE_MIN || undefined}
            onClick={() => adjustFeedTextScale(-1)}
            aria-label="Réduire le texte des fils"
            title={`Réduire la taille par défaut du texte des fils (${isMac ? "⌘" : "Ctrl"} −)`}
          >
            A−
          </button>
          <button
            type="button"
            className="quiet-button text-scale-reset"
            onClick={() => adjustFeedTextScale(0)}
            aria-label="Réinitialiser la taille du texte des fils"
            title={`Taille par défaut du texte des fils : ${Math.round(feedTextScale * 100)} % — cliquer pour revenir à 100 % (${isMac ? "⌘" : "Ctrl"} 0). Chaque fil peut la surcharger via A−/A+ dans son en-tête.`}
          >
            {Math.round(feedTextScale * 100)} %
          </button>
          <button
            type="button"
            className="quiet-button text-scale-button"
            aria-disabled={feedTextScale >= FEED_TEXT_SCALE_MAX || undefined}
            onClick={() => adjustFeedTextScale(1)}
            aria-label="Agrandir le texte des fils"
            title={`Agrandir la taille par défaut du texte des fils (${isMac ? "⌘" : "Ctrl"} +)`}
          >
            A+
          </button>
        </div>
        {linkPreview && (
          <button
            type="button"
            className="restore-pill"
            onClick={() => {
              setLinkPreview(null);
            }}
          >
            Retour au fil <kbd>Échap</kbd>
          </button>
        )}
        {!linkPreview && maximizedPanelId && (
          <button
            type="button"
            className="restore-pill"
            onClick={() => setMaximizedPanelId(null)}
          >
            Panel agrandi · restaurer <kbd>Échap</kbd>
          </button>
        )}
        {updateNoticeVisible && (
          <button
            type="button"
            className="update-ready-cta"
            aria-label={`Mise à jour ${readyUpdateVersion} prête`}
            onClick={() => setUpdateInstallConfirmationOpen(true)}
          >
            <Download size={13} />
            <span>Mise à jour</span>
            <span className="update-ready-cta__version">{readyUpdateVersion}</span>
            <span>prête</span>
          </button>
        )}
        <button
          ref={globalToolsButtonRef}
          type="button"
          className="quiet-button global-tools"
          aria-label={updateNoticeDeferred
            ? `Outils — mise à jour ${readyUpdateVersion} prête`
            : undefined}
          onClick={() => setModal({ kind: "pilot-tools" })}
        >
          <SlidersHorizontal size={13} /> Outils
          {updateNoticeDeferred && <span className="tools-update-signal" aria-hidden="true" />}
        </button>
        {state.panels.length > 0 && Object.keys(drafts).length === 0 && (
          <button
            type="button"
            className="quiet-button global-clear"
            onClick={() => setModal({ kind: "clear-dashboard" })}
          >
            Vider
          </button>
        )}
        <button type="button" className="primary-button global-add" onClick={() => beginDraft()}>
          <Plus size={14} /> Nouveau panel
        </button>
      </header>

      <main
        className="dashboard-stage"
        aria-label="Dashboard de veille"
        aria-hidden={modal || semanticSearchOpen || updateInstallConfirmationOpen ? true : undefined}
        inert={modal || semanticSearchOpen || updateInstallConfirmationOpen ? true : undefined}
      >
        <div
          className="dashboard-workspace"
          aria-hidden={linkPreview ? true : undefined}
          inert={linkPreview ? true : undefined}
        >
          {layout ? (
            <SplitLayout
              layout={layout}
              renderPanel={renderPanel}
              maximizedPanelId={maximizedPanelId}
              onRatioChange={(splitId, ratio) => {
                const next = updateSplitRatio(layoutRef.current, splitId, ratio);
                setLayout(next);
                layoutRef.current = next;
                pendingRatioLayoutRef.current = next;
              }}
              onSwapPanels={(first, second) => {
                const next = swapPanels(layoutRef.current, first, second);
                setLayout(next);
                layoutRef.current = next;
                if (next && Object.keys(draftsRef.current).length === 0) void persistLayout(next);
              }}
              onInteractionChange={(active) => {
                setInteractionActive(active);
                if (!active && pendingRatioLayoutRef.current) {
                  const pending = pendingRatioLayoutRef.current;
                  pendingRatioLayoutRef.current = null;
                  void persistLayout(pending);
                }
              }}
            />
          ) : (
            <EmptyDashboard
              onCreate={() => beginDraft()}
              onStartTemplate={() => void startCompetitorTemplate()}
            />
          )}
        </div>
        {linkPreview && (
          <LinkPreviewView
            preview={linkPreview}
            runtime={webStates[LINK_READER_ID]}
            onClose={() => {
              setLinkPreview(null);
            }}
          />
        )}
      </main>

      {modal?.kind === "configure-feed" && (() => {
        const panel = panelById.get(modal.panelId);
        return panel?.kind === "feed" ? (
          <FeedConfigModal
            panel={panel}
            state={state}
            onClose={() => setModal(null)}
            onSaved={(nextState, message) => {
              applyServerState(nextState);
              setModal(null);
              showToast(message);
            }}
          />
        ) : null;
      })()}

      {modal?.kind === "close-panel" && (() => {
        const panel = panelById.get(modal.panelId);
        return panel ? (
          <ConfirmModal
            title={`Fermer « ${panel.name} » ?`}
            body="Le panel sera retiré du dashboard. Les articles déjà mis en cache resteront disponibles si la source est réutilisée."
            confirmLabel="Fermer le panel"
            onCancel={() => setModal(null)}
            onConfirm={() => closePanel(panel.id)}
          />
        ) : null;
      })()}

      {modal?.kind === "clear-dashboard" && (
        <ConfirmModal
          title="Vider le dashboard ?"
          body="Tous les panels seront fermés. Les sources et leur cache local seront conservés pour une prochaine utilisation."
          confirmLabel="Vider le dashboard"
          onCancel={() => setModal(null)}
          onConfirm={clearDashboard}
        />
      )}

      {modal?.kind === "pilot-tools" && !updateInstallConfirmationOpen && (
        <PilotToolsModal
          updateState={updateState}
          onUpdateState={setUpdateState}
          onRequestRestart={() => {
            setRestorePilotToolsUpdateFocus(true);
            setUpdateInstallConfirmationOpen(true);
          }}
          updateActionRef={pilotToolsUpdateActionRef}
          onClose={() => setModal(null)}
          onImported={(nextState, backupCreated) => {
            applyServerState(nextState, true, true);
            setModal(null);
            showToast(
              backupCreated
                ? "Dashboard importé · sauvegarde précédente créée"
                : "Dashboard importé",
            );
          }}
          onToast={showToast}
          semanticStatus={semanticSearchStatus}
          onRemoveSemanticData={async () => {
            clearSemanticSearchFilter();
            await window.vibedeck.removeSemanticSearchData();
          }}
        />
      )}

      {updateInstallConfirmationOpen && readyUpdateVersion && (
        <UpdateInstallModal
          version={readyUpdateVersion}
          onLater={() => {
            setDismissedUpdateVersion(readyUpdateVersion);
            if (!restorePilotToolsUpdateFocus) setRestoreGlobalToolsFocus(true);
            setUpdateInstallConfirmationOpen(false);
          }}
          onClose={() => setUpdateInstallConfirmationOpen(false)}
        />
      )}

      {semanticSearchOpen && (
        <SearchPalette
          status={semanticSearchStatus}
          scope={semanticSearchScope}
          initialQuery={activeSemanticSearch?.query ?? ""}
          initialResult={
            activeSemanticSearch &&
            semanticSearchScopesEqual(activeSemanticSearch.scope, semanticSearchScope)
              ? activeSemanticSearch.result
              : null
          }
          panels={state.panels.filter((panel): panel is FeedPanel => panel.kind === "feed")}
          sources={state.sources}
          onScopeChange={setSemanticSearchScope}
          onPrepare={() => void window.vibedeck.prepareSemanticSearch().catch((error) => showToast(cleanError(error)))}
          onCancelPreparation={() => void window.vibedeck.cancelSemanticSearchPreparation()}
          onClose={closeSemanticSearchPalette}
          onOpenItem={(item) => {
            const preferredPanelId =
              semanticSearchRestoreRef.current?.focusedPanelId ?? focusedPanelId;
            const candidatePanels = state.panels.filter(
              (panel): panel is FeedPanel =>
                panel.kind === "feed" && panel.sourceIds.includes(item.sourceId),
            );
            const originPanel =
              candidatePanels.find(({ id }) => id === preferredPanelId) ?? candidatePanels[0];
            closeSemanticSearchPalette();
            void openItem(item, {
              panelId: originPanel?.id ?? preferredPanelId ?? "",
              rowId: originPanel ? `article-${originPanel.id}-${item.id}` : "",
            });
          }}
          onApply={applySemanticSearchFilter}
        />
      )}

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

function searchDraftKey(query: string, scope: SemanticSearchScope) {
  return `${scope.kind === "all" ? "all" : `panel:${scope.panelId}`}\u0000${query.trim()}`;
}

function semanticSearchScopesEqual(
  first: SemanticSearchScope,
  second: SemanticSearchScope,
) {
  return first.kind === second.kind &&
    (first.kind === "all" || (second.kind === "panel" && first.panelId === second.panelId));
}

function orderSemanticSearchResult(result: SemanticSearchResult | null) {
  if (!result) return null;
  return {
    ...result,
    items: [...result.items].sort(compareFeedItems),
  };
}

function SearchPalette({
  status,
  scope,
  initialQuery,
  initialResult,
  panels,
  sources,
  onScopeChange,
  onPrepare,
  onCancelPreparation,
  onOpenItem,
  onApply,
  onClose,
}: {
  status: SemanticSearchStatus;
  scope: SemanticSearchScope;
  initialQuery: string;
  initialResult: SemanticSearchResult | null;
  panels: FeedPanel[];
  sources: Source[];
  onScopeChange: (scope: SemanticSearchScope) => void;
  onPrepare: () => void;
  onCancelPreparation: () => void;
  onOpenItem: (item: FeedItem) => void;
  onApply: (query: string, scope: SemanticSearchScope, result: SemanticSearchResult) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRevisionRef = useRef(0);
  const hybridTimerRef = useRef<number | null>(null);
  const hybridRequestRef = useRef<{
    key: string;
    promise: Promise<SemanticSearchResult>;
  } | null>(null);
  const hybridResultRef = useRef<{
    key: string;
    result: SemanticSearchResult;
  } | null>(
    initialResult?.mode === "hybrid"
      ? { key: searchDraftKey(initialQuery, scope), result: initialResult }
      : null,
  );
  const resultsRef = useRef<SemanticSearchResult | null>(null);
  const resultsKeyRef = useRef(initialResult ? searchDraftKey(initialQuery, scope) : null);
  const skipInitialSearchRef = useRef(Boolean(initialResult && initialQuery.trim().length >= 2));
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<SemanticSearchResult | null>(() =>
    orderSemanticSearchResult(initialResult));
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [lexicalPending, setLexicalPending] = useState(false);
  const [hybridPending, setHybridPending] = useState(false);
  const [applying, setApplying] = useState(false);
  const [semanticError, setSemanticError] = useState<string | null>(null);
  const searchable = status.phase === "ready" || status.phase === "updating";
  const preparing = ["downloading", "indexing"].includes(status.phase);
  const sourceById = useMemo(() => new Map(sources.map((source) => [source.id, source])), [sources]);
  const draftKey = searchDraftKey(query, scope);
  const draftKeyRef = useRef(draftKey);
  draftKeyRef.current = draftKey;
  resultsRef.current = results;

  function acceptResult(key: string, result: SemanticSearchResult) {
    if (draftKeyRef.current !== key) return;
    const orderedResult = orderSemanticSearchResult(result);
    if (!orderedResult) return;
    resultsKeyRef.current = key;
    resultsRef.current = orderedResult;
    setResults(orderedResult);
    setActiveItemId((current) =>
      current && orderedResult.items.some(({ id }) => id === current) ? current : null,
    );
  }

  function requestHybrid(key: string, candidateQuery: string, candidateScope: SemanticSearchScope) {
    if (hybridResultRef.current?.key === key) {
      return Promise.resolve(hybridResultRef.current.result);
    }
    if (hybridRequestRef.current?.key === key) return hybridRequestRef.current.promise;
    const promise = window.vibedeck
      .searchFeedItems({ query: candidateQuery, scope: candidateScope, mode: "hybrid" })
      .then((result) => {
        hybridResultRef.current = { key, result };
        return result;
      })
      .finally(() => {
        if (hybridRequestRef.current?.key === key) hybridRequestRef.current = null;
      });
    hybridRequestRef.current = { key, promise };
    return promise;
  }

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    const frame = window.requestAnimationFrame(() => {
      if (inputRef.current) {
        inputRef.current.focus({ preventScroll: true });
        inputRef.current.select();
        return;
      }
      dialog
        .querySelector<HTMLElement>(".search-palette__setup .primary-button, .search-palette__setup .quiet-button")
        ?.focus({ preventScroll: true });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (dialog.open) dialog.close();
    };
  }, []);

  useLayoutEffect(() => {
    if (!searchable) return;
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true });
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [searchable]);

  useEffect(() => {
    if (!searchable) return;
    if (skipInitialSearchRef.current) {
      skipInitialSearchRef.current = false;
      return;
    }
    const normalizedQuery = query.trim();
    const revision = requestRevisionRef.current + 1;
    requestRevisionRef.current = revision;
    setActiveItemId(null);
    setSemanticError(null);
    resultsKeyRef.current = null;
    resultsRef.current = null;
    setResults(null);
    if (hybridTimerRef.current !== null) window.clearTimeout(hybridTimerRef.current);
    if (normalizedQuery.length < 2) {
      setLexicalPending(false);
      setHybridPending(false);
      return;
    }

    const key = searchDraftKey(normalizedQuery, scope);
    setLexicalPending(true);
    void window.vibedeck
      .searchFeedItems({ query: normalizedQuery, scope, mode: "lexical" })
      .then((result) => {
        if (requestRevisionRef.current !== revision) return;
        acceptResult(key, result);
      })
      .catch((error) => {
        if (requestRevisionRef.current === revision) setSemanticError(cleanError(error));
      })
      .finally(() => {
        if (requestRevisionRef.current === revision) setLexicalPending(false);
      });

    hybridTimerRef.current = window.setTimeout(() => {
      setHybridPending(true);
      void requestHybrid(key, normalizedQuery, scope)
        .then((result) => {
          if (requestRevisionRef.current !== revision) return;
          acceptResult(key, result);
          setSemanticError(null);
        })
        .catch((error) => {
          if (requestRevisionRef.current === revision) setSemanticError(cleanError(error));
        })
        .finally(() => {
          if (requestRevisionRef.current === revision) setHybridPending(false);
        });
    }, 140);

    return () => {
      if (hybridTimerRef.current !== null) window.clearTimeout(hybridTimerRef.current);
      hybridTimerRef.current = null;
    };
  }, [query, scope, searchable]);

  useEffect(() => {
    if (!activeItemId) return;
    document
      .getElementById(`semantic-search-result-${activeItemId}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeItemId]);

  async function applyDraft() {
    const normalizedQuery = query.trim();
    if (!searchable || applying || normalizedQuery.length < 2) return;
    const key = searchDraftKey(normalizedQuery, scope);
    const revision = requestRevisionRef.current;
    setApplying(true);
    if (hybridTimerRef.current !== null) {
      window.clearTimeout(hybridTimerRef.current);
      hybridTimerRef.current = null;
    }
    try {
      const result = hybridResultRef.current?.key === key
        ? hybridResultRef.current.result
        : await requestHybrid(key, normalizedQuery, scope);
      if (requestRevisionRef.current !== revision || draftKeyRef.current !== key) return;
      acceptResult(key, result);
      onApply(normalizedQuery, scope, result);
    } catch (error) {
      if (requestRevisionRef.current !== revision || draftKeyRef.current !== key) return;
      const fallback = resultsKeyRef.current === key ? resultsRef.current : null;
      if (fallback) onApply(normalizedQuery, scope, fallback);
      else setSemanticError(cleanError(error));
    } finally {
      if (requestRevisionRef.current === revision) setApplying(false);
    }
  }

  function moveActiveResult(direction: "next" | "previous" | "first" | "last") {
    const items = resultsRef.current?.items ?? [];
    if (items.length === 0) return;
    const currentIndex = items.findIndex(({ id }) => id === activeItemId);
    let nextIndex = 0;
    if (direction === "last") nextIndex = items.length - 1;
    else if (direction === "previous") {
      if (currentIndex <= 0) {
        setActiveItemId(null);
        return;
      }
      nextIndex = currentIndex - 1;
    }
    else if (direction === "next") nextIndex = currentIndex < 0 ? 0 : Math.min(items.length - 1, currentIndex + 1);
    setActiveItemId(items[nextIndex].id);
  }

  function onQueryKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveActiveResult(event.key === "ArrowDown" ? "next" : "previous");
      return;
    }
    if (activeItemId && (event.key === "Home" || event.key === "End")) {
      event.preventDefault();
      moveActiveResult(event.key === "Home" ? "first" : "last");
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const selected = resultsRef.current?.items.find(({ id }) => id === activeItemId);
      if (selected) onOpenItem(selected);
      else void applyDraft();
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await applyDraft();
  }

  return (
    <dialog
      ref={dialogRef}
      className="search-palette"
      aria-label="Recherche locale"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {panels.length === 0 ? (
        <div className="search-palette__setup">
          <header>
            <Search size={17} />
            <strong>Recherche locale</strong>
            <IconButton label="Fermer la recherche" onClick={onClose}><X size={15} /></IconButton>
          </header>
          <div className="search-palette__empty">Aucun fil à rechercher.</div>
        </div>
      ) : !searchable ? (
        <div className="search-palette__setup">
          <header>
            <Search size={17} />
            <strong>Recherche locale</strong>
            <IconButton label="Fermer la recherche" onClick={onClose}><X size={15} /></IconButton>
          </header>
          <div>
            <p>Les titres et résumés restent sur cet ordinateur.</p>
            {preparing ? (
              <>
                <progress value={status.progress} max={1} />
                <span>{status.phase === "downloading" ? "Téléchargement du modèle" : "Indexation des fils"} · {Math.round(status.progress * 100)} %</span>
                <button type="button" className="quiet-button" onClick={onCancelPreparation}>Annuler</button>
              </>
            ) : (
              <button type="button" className="primary-button" onClick={onPrepare}>
                {status.phase === "error" ? "Réessayer" : "Activer · environ 140 Mo"}
              </button>
            )}
            {status.message && <p className="form-error" role="alert">{status.message}</p>}
          </div>
        </div>
      ) : (
        <>
          <form className="search-palette__bar" onSubmit={(event) => void submit(event)}>
            <Search size={17} aria-hidden="true" />
            <label className="visually-hidden" htmlFor="semantic-search-query">Requête</label>
            <input
              ref={inputRef}
              id="semantic-search-query"
              value={query}
              maxLength={240}
              placeholder="Rechercher dans les fils…"
              autoComplete="off"
              spellCheck={false}
              role="combobox"
              aria-expanded={Boolean(results)}
              aria-controls="semantic-search-results"
              aria-activedescendant={activeItemId ? `semantic-search-result-${activeItemId}` : undefined}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onQueryKeyDown}
            />
            {(lexicalPending || hybridPending || applying || status.phase === "updating") && (
              <LoaderCircle className="is-spinning search-palette__activity" size={14} aria-label="Recherche en cours" />
            )}
            <label className="visually-hidden" htmlFor="semantic-search-scope">Portée</label>
            <select
              id="semantic-search-scope"
              value={scope.kind === "all" ? "all" : scope.panelId}
              onChange={(event) => onScopeChange(
                event.target.value === "all"
                  ? { kind: "all" }
                  : { kind: "panel", panelId: event.target.value },
              )}
            >
              <option value="all">Tous les fils</option>
              {panels.map((panel) => <option key={panel.id} value={panel.id}>{panel.name}</option>)}
            </select>
            <button
              type="submit"
              className="search-palette__apply"
              disabled={applying || query.trim().length < 2}
            >
              <ListFilter size={14} /> Filtrer
            </button>
            <IconButton label="Fermer la recherche" onClick={onClose}><X size={15} /></IconButton>
          </form>
          <div className="search-palette__status" aria-live="polite">
            <span>
              {results
                ? `${results.items.length} résultat${results.items.length > 1 ? "s" : ""}${results.truncated ? " · limité à 200" : ""}`
                : ""}
            </span>
            {results?.mode === "lexical" && hybridPending && <em>Enrichissement sémantique</em>}
          </div>
          {semanticError && (
            <p className="search-palette__error" role="status">
              Recherche sémantique indisponible. Les correspondances exactes restent utilisables.
            </p>
          )}
          <div
            id="semantic-search-results"
            className="search-palette__results"
            role="listbox"
            aria-label="Résultats de recherche"
            data-result-mode={results?.mode}
          >
            {results && results.items.length === 0 ? (
              <div className="search-palette__empty">Aucun article dans cette portée.</div>
            ) : (
              results?.items.map((item) => {
                const source = sourceById.get(item.sourceId);
                const panelNames = panels
                  .filter((panel) => panel.sourceIds.includes(item.sourceId))
                  .map((panel) => panel.name);
                const selected = activeItemId === item.id;
                return (
                  <button
                    type="button"
                    id={`semantic-search-result-${item.id}`}
                    className={`search-palette__result${selected ? " is-selected" : ""}`}
                    key={item.id}
                    role="option"
                    tabIndex={-1}
                    aria-selected={selected}
                    onMouseMove={() => setActiveItemId(item.id)}
                    onClick={() => onOpenItem(item)}
                  >
                    <time dateTime={item.publishedAt ?? item.updatedAt ?? item.firstSeenAt}>{formatItemTime(item)}</time>
                    <span className="search-palette__result-copy">
                      <span className="search-palette__result-meta">
                        <strong>{source?.name ?? "Source"}</strong>
                        {panelNames.length > 0 && <span>{panelNames.join(" · ")}</span>}
                      </span>
                      <b>{item.title}</b>
                      {item.summary && <span>{item.summary}</span>}
                    </span>
                    <ArrowUpRight size={14} aria-hidden="true" />
                  </button>
                );
              })
            )}
          </div>
        </>
      )}
    </dialog>
  );
}

function Brand({ vertical = false }: { vertical?: boolean }) {
  return (
    <div className={vertical ? "brand brand--vertical" : "brand"} aria-label="VibeDeck">
      <svg className="brand__mark" viewBox="0 0 56 56" aria-hidden="true">
        <rect x="2" y="2" width="20" height="52" rx="5" />
        <rect x="26" y="2" width="28" height="24" rx="5" />
        <rect className="brand__mark-accent" x="26" y="30" width="28" height="24" rx="5" />
      </svg>
      <span className="brand__word">
        <strong>Vibe</strong>Deck
      </span>
      {vertical && <span className="brand__tagline">VEILLE LOCALE</span>}
    </div>
  );
}

interface PanelFrameProps {
  panelId: string;
  kind: "FIL" | "PAGE WEB" | "NOUVEAU";
  name: string;
  count?: string;
  focused: boolean;
  maximized?: boolean;
  actionsDisabled?: boolean;
  canRename?: boolean;
  onFocus: () => void;
  onRename?: (name: string) => void | Promise<void>;
  onSplit?: (direction: "row" | "column") => void;
  onMove?: (offset: -1 | 1, identity: PanelFocusIdentity) => void;
  onMaximize?: () => void;
  onClose: () => void;
  closeDisabled?: boolean;
  primaryActions?: React.ReactNode;
  style?: React.CSSProperties;
  dataDensity?: FeedDensity;
  children: React.ReactNode;
}

function PanelFrame({
  panelId,
  kind,
  name,
  count,
  focused,
  maximized,
  actionsDisabled = false,
  canRename = true,
  onFocus,
  onRename,
  onSplit,
  onMove,
  onMaximize,
  onClose,
  closeDisabled = false,
  primaryActions,
  style,
  dataDensity,
  children,
}: PanelFrameProps) {
  const dragHandle = useSplitPanelDragHandle(panelId);
  const [renaming, setRenaming] = useState(false);
  const [nameValue, setNameValue] = useState(name);

  useEffect(() => setNameValue(name), [name]);

  function finishRename() {
    const nextName = nameValue.trim();
    setRenaming(false);
    if (nextName && nextName !== name && onRename) void onRename(nextName);
    else setNameValue(name);
  }

  const panelClassKind = kind === "PAGE WEB" ? "web" : kind.toLowerCase();

  function focusFromPointer(panelElement: HTMLElement) {
    window.vibedeck.focusDashboard();
    onFocus();
    panelElement.focus({ preventScroll: true });
  }

  function canMoveFocusOnHover(panelElement: HTMLElement) {
    if (!document.hasFocus()) return false;
    const active = document.activeElement;
    if (!active || active === document.body || active === panelElement) return true;
    return active instanceof HTMLElement && active.matches(".dashboard-panel");
  }

  return (
    <section
      className={`dashboard-panel dashboard-panel--${panelClassKind}${
        focused ? " dashboard-panel--focused" : ""
      }`}
      style={style}
      data-density={dataDensity}
      tabIndex={-1}
      onMouseDown={(event) => focusFromPointer(event.currentTarget)}
      onPointerEnter={(event) => {
        if (
          document.activeElement !== event.currentTarget &&
          canMoveFocusOnHover(event.currentTarget)
        ) {
          focusFromPointer(event.currentTarget);
        }
      }}
      onPointerMove={(event) => {
        if (
          document.activeElement !== event.currentTarget &&
          canMoveFocusOnHover(event.currentTarget)
        ) {
          focusFromPointer(event.currentTarget);
        }
      }}
      onFocusCapture={onFocus}
      onKeyDown={(event) => {
        if (
          actionsDisabled ||
          !onMove ||
          !event.altKey ||
          isTypingTarget(event.target) ||
          !["ArrowLeft", "ArrowRight"].includes(event.key)
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const focusTarget =
          event.target instanceof HTMLElement
            ? event.target.closest<HTMLElement>(PANEL_FOCUSABLE_SELECTOR)
            : null;
        const focusable = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(PANEL_FOCUSABLE_SELECTOR),
        ];
        onMove(
          event.key === "ArrowLeft" ? -1 : 1,
          {
            focusKey: focusTarget?.getAttribute("data-panel-focus-key") ?? null,
            id: focusTarget?.id || null,
            ariaLabel: focusTarget?.getAttribute("aria-label") ?? null,
            panelTitle: focusTarget?.classList.contains("panel-title") ?? false,
            index: focusTarget ? focusable.indexOf(focusTarget) : -1,
          },
        );
      }}
      aria-label={`${kind} — ${name}`}
    >
      <header className="panel-header" {...dragHandle}>
        <span className="panel-kind">{kind}</span>
        {renaming ? (
          <input
            className="panel-title-input"
            aria-label={`Renommer le panel ${name}`}
            value={nameValue}
            autoFocus
            onChange={(event) => setNameValue(event.target.value)}
            onBlur={finishRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") finishRename();
              if (event.key === "Escape") {
                setNameValue(name);
                setRenaming(false);
              }
            }}
          />
        ) : canRename ? (
          <button
            type="button"
            className="panel-title"
            data-panel-focus-key="panel-title"
            title={
              canRename
                ? "F2 pour renommer · Alt + ←/→ pour déplacer · glisser à la souris"
                : name
            }
            aria-keyshortcuts={onMove ? "Alt+ArrowLeft Alt+ArrowRight" : undefined}
            onDoubleClick={(event) => {
              event.stopPropagation();
              if (canRename) setRenaming(true);
            }}
            onKeyDown={(event) => {
              if (!canRename || !["Enter", " ", "F2"].includes(event.key)) return;
              event.preventDefault();
              event.stopPropagation();
              setRenaming(true);
            }}
          >
            {name}
          </button>
        ) : (
          <span className="panel-title" title={name}>
            {name}
          </span>
        )}
        {count && <span className="panel-count">{count}</span>}
        <div className="panel-actions" onMouseDown={(event) => event.stopPropagation()}>
          {primaryActions}
          {onSplit && (
            <>
              <IconButton
                label="Diviser côte à côte"
                disabled={actionsDisabled}
                onClick={() => onSplit("row")}
              >
                <Columns2 size={13} />
              </IconButton>
              <IconButton
                label="Diviser horizontalement"
                disabled={actionsDisabled}
                onClick={() => onSplit("column")}
              >
                <Rows2 size={13} />
              </IconButton>
            </>
          )}
          {onMaximize && (
            <IconButton
              label={maximized ? "Restaurer" : "Agrandir"}
              disabled={actionsDisabled}
              onClick={onMaximize}
            >
              {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </IconButton>
          )}
          <IconButton
            label="Fermer le panel"
            disabled={closeDisabled || actionsDisabled}
            danger
            onClick={onClose}
          >
            <X size={13} />
          </IconButton>
        </div>
      </header>
      <div className="panel-content">{children}</div>
    </section>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  ariaDisabled,
  active,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  ariaDisabled?: boolean;
  active?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`icon-button${active ? " icon-button--active" : ""}${
        danger ? " icon-button--danger" : ""
      }`}
      aria-label={label}
      title={label}
      disabled={disabled}
      aria-disabled={ariaDisabled || undefined}
      draggable={false}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}

interface StandardPanelActions {
  focused: boolean;
  maximized: boolean;
  actionsDisabled: boolean;
  onFocus: () => void;
  onSplit: (direction: "row" | "column") => void;
  onMove: (offset: -1 | 1, identity: PanelFocusIdentity) => void;
  onMaximize: () => void;
  onClose: () => void;
  onRename: (name: string) => void | Promise<void>;
}

function FeedPanelView({
  panel,
  state,
  ui,
  onUi,
  onOpen,
  onSeen,
  onRefresh,
  onConfigure,
  onSearch,
  searchQuery,
  onClearSearch,
  textScale,
  textScaleOverride,
  onTextScale,
  density,
  onDensity,
  ...frame
}: {
  panel: FeedPanel;
  state: AppState;
  ui: FeedPanelUi;
  onUi: (patch: Partial<FeedPanelUi>) => void;
  onOpen: (item: FeedItem, rowId: string) => void | Promise<void>;
  onSeen: (itemIds: string[]) => void;
  onRefresh: () => void | Promise<void>;
  onConfigure: () => void;
  onSearch: () => void;
  searchQuery: string | null;
  onClearSearch: () => void;
  textScale: number;
  textScaleOverride: number | null;
  onTextScale: (direction: -1 | 0 | 1) => void;
  density: FeedDensity;
  onDensity: (mode: FeedDensity, asGlobalDefault: boolean) => void;
} & StandardPanelActions) {
  const articleListRef = useRef<HTMLDivElement>(null);
  const hoverSeenTimerRef = useRef<{ id: string; handle: ReturnType<typeof setTimeout> } | null>(null);
  const clearHoverSeenTimer = () => {
    if (hoverSeenTimerRef.current) {
      clearTimeout(hoverSeenTimerRef.current.handle);
      hoverSeenTimerRef.current = null;
    }
  };
  useEffect(() => clearHoverSeenTimer, []);
  const sources = panel.sourceIds
    .map((sourceId) => state.sources.find(({ id }) => id === sourceId))
    .filter((source): source is Source => Boolean(source));
  const activeSourceFilter =
    ui.sourceFilter === "all" || sources.some(({ id }) => id === ui.sourceFilter)
      ? ui.sourceFilter
      : "all";
  const allItems = panelItems(panel, state);
  const visibleItems = panelItems(panel, state, {
    visibleItemIds: ui.visibleItemIds,
  });
  const items = panelItems(panel, state, {
    sourceFilter: activeSourceFilter,
    visibleItemIds: ui.visibleItemIds,
    visibilityFilter: ui.visibilityFilter,
    focusedItemId: ui.focusedItemId,
    searchItemIds: ui.searchItemIds,
  });
  const tabbableItemId = items.some(({ id }) => id === ui.focusedItemId)
    ? ui.focusedItemId
    : items[0]?.id ?? null;
  const allCount = allItems.length;
  const unseenCount = visibleItems.filter(({ seenAt }) => seenAt === null).length;
  const failedSources = sources.filter(({ status }) => status === "error");
  const refreshing = sources.some(({ status }) => status === "refreshing");
  const automaticInsertionKey = [...ui.automaticInsertionIds].sort().join("\u0000");

  useLayoutEffect(() => {
    const list = articleListRef.current;
    const previous = ui.automaticInsertionMetrics;
    if (ui.automaticInsertionIds.size === 0 || ui.searchItemIds) return;
    if (list && previous) {
      if (previous.scrollTop < 4) {
        // Keeping arrivals visible at the top outranks a keyboard glide in
        // flight — without the cancel, the animation would pull the list
        // back down toward the focused row.
        cancelSmoothScroll(list);
        list.scrollTop = 0;
      } else {
        const anchor = previous.anchorItemId
          ? document.getElementById(`article-${panel.id}-${previous.anchorItemId}`)
          : null;
        if (anchor && list.contains(anchor) && previous.anchorViewportTop !== null) {
          const currentAnchorTop = anchor.getBoundingClientRect().top - list.getBoundingClientRect().top;
          // Chromium peut déjà avoir appliqué son scroll anchoring natif. Ajuster
          // relativement à la position courante évite de compenser deux fois ou
          // d’annuler cette compensation automatique.
          list.scrollTop += currentAnchorTop - previous.anchorViewportTop;
        }
        // Ne compter que les arrivées réellement rendues avant l’ancre : une
        // date éditoriale ancienne peut désormais les placer dans ou sous le
        // viewport sans nécessiter de compensation ni de pastille.
        const arrivedAbove = feedItemIdsBeforeAnchor(
          items,
          ui.automaticInsertionIds,
          previous.anchorItemId,
        );
        if (arrivedAbove.length > 0) {
          onUi({
            automaticInsertionIds: new Set(),
            automaticInsertionMetrics: null,
            pendingArrivalIds: new Set([...ui.pendingArrivalIds, ...arrivedAbove]),
          });
          return;
        }
      }
    }
    onUi({ automaticInsertionIds: new Set(), automaticInsertionMetrics: null });
  }, [automaticInsertionKey, ui.automaticInsertionIds, ui.automaticInsertionMetrics, ui.searchItemIds]);

  return (
    <PanelFrame
      panelId={panel.id}
      kind="FIL"
      name={panel.name}
      count={`${allCount}`}
      {...frame}
      style={
        textScaleOverride !== null
          ? ({ "--feed-text-scale": String(textScaleOverride) } as React.CSSProperties)
          : undefined
      }
      dataDensity={density}
      primaryActions={
        <>
          <IconButton
            label="Réduire le texte de ce fil"
            ariaDisabled={textScale <= FEED_TEXT_SCALE_MIN}
            onClick={() => onTextScale(-1)}
          >
            <span className="text-scale-glyph" aria-hidden="true">A−</span>
          </IconButton>
          {textScaleOverride !== null && (
            <IconButton
              label={`Texte de ce fil : ${Math.round(textScaleOverride * 100)} % — revenir à la taille par défaut`}
              onClick={() => onTextScale(0)}
            >
              <span className="text-scale-glyph text-scale-glyph--value" aria-hidden="true">
                {Math.round(textScaleOverride * 100)}%
              </span>
            </IconButton>
          )}
          <IconButton
            label="Agrandir le texte de ce fil"
            ariaDisabled={textScale >= FEED_TEXT_SCALE_MAX}
            onClick={() => onTextScale(1)}
          >
            <span className="text-scale-glyph" aria-hidden="true">A+</span>
          </IconButton>
          <IconButton label="Actualiser ce panel" disabled={refreshing} onClick={() => void onRefresh()}>
            <RefreshCw className={refreshing ? "is-spinning" : ""} size={13} />
          </IconButton>
          <IconButton label="Rechercher dans ce fil" onClick={onSearch}>
            <Search size={13} />
          </IconButton>
          <IconButton label="Configurer les sources" onClick={onConfigure}>
            <SlidersHorizontal size={13} />
          </IconButton>
        </>
      }
    >
      <div className="feed-toolbar" aria-label="Filtrer les sources">
        <div className="feed-toolbar__filters">
          <button
            type="button"
            data-panel-focus-key="feed-filter:all"
            className={activeSourceFilter === "all" ? "is-active" : ""}
            aria-pressed={activeSourceFilter === "all"}
            onClick={() =>
              onUi({ sourceFilter: "all", focusedItemId: null, pendingArrivalIds: new Set() })
            }
          >
            Toutes <span>· {allCount}</span>
          </button>
          <button
            type="button"
            data-panel-focus-key="feed-filter:unseen"
            className={`feed-toolbar__unseen${
              ui.visibilityFilter === "unseen" ? " is-active" : ""
            }`}
            aria-pressed={ui.visibilityFilter === "unseen"}
            onClick={() =>
              onUi({
                visibilityFilter: ui.visibilityFilter === "unseen" ? "all" : "unseen",
                focusedItemId: null,
                pendingArrivalIds: new Set(),
              })
            }
          >
            Non vus <span>· {unseenCount}</span>
          </button>
          {sources.map((source, sourceIndex) => (
            <button
              type="button"
              key={source.id}
              data-panel-focus-key={`feed-filter:source:${source.id}`}
              className={activeSourceFilter === source.id ? "is-active" : ""}
              aria-pressed={activeSourceFilter === source.id}
              aria-label={`${source.name} — source ${sourceIndex + 1} sur ${sources.length} — ${
                source.status === "error"
                  ? "indisponible"
                  : source.status === "refreshing"
                    ? "actualisation en cours"
                    : sourceIsFresh(source)
                      ? "à jour"
                      : "en retard"
              }`}
              title={source.errorMessage ?? source.name}
              onClick={() =>
                onUi({ sourceFilter: source.id, focusedItemId: null, pendingArrivalIds: new Set() })
              }
            >
              <i className={`source-dot source-dot--${source.status}`} />
              {source.name}
            </button>
          ))}
        </div>
        <div className="feed-toolbar__density" role="group" aria-label="Densité d’affichage">
          <button
            type="button"
            data-panel-focus-key="feed-density:dense"
            className={density === "dense" ? "is-active" : ""}
            aria-pressed={density === "dense"}
            title="Affichage dense — Alt+clic : défaut pour tous les fils"
            onClick={(event) => onDensity("dense", event.altKey)}
          >
            Dense
          </button>
          <button
            type="button"
            data-panel-focus-key="feed-density:comfort"
            className={density === "comfort" ? "is-active" : ""}
            aria-pressed={density === "comfort"}
            title="Affichage confort — Alt+clic : défaut pour tous les fils"
            onClick={(event) => onDensity("comfort", event.altKey)}
          >
            Confort
          </button>
        </div>
        {sources.length > 0 && <FeedRefreshStatus sources={sources} />}
        {ui.searchItemIds && searchQuery && (
          <button
            type="button"
            className="feed-toolbar__search-state"
            onClick={onClearSearch}
            title="Retirer le filtre de recherche"
          >
            <Search size={12} />
            <span>{searchQuery}</span>
            <em>{items.length}</em>
            <X size={12} aria-hidden="true" />
          </button>
        )}
      </div>
      {failedSources.length > 0 && (
        <div className="panel-notice" role="status" aria-label="Sources indisponibles">
          <i />
          <span>
            {failedSources.map((source) => (
              <span key={source.id}>
                <strong>{source.name}</strong> · {source.errorMessage ?? "source indisponible"} · échec {formatCheckedAt(source.lastCheckedAt)} · dernière réussite {formatCheckedAt(source.lastSuccessAt)}
              </span>
            ))}
            <small>Le cache reste affiché.</small>
          </span>
        </div>
      )}
      <div className="feed-body">
        {sources.length === 0 ? (
          <PanelEmpty
            icon={<Rss size={20} />}
            title="Aucune source dans ce fil"
            body="Ajoutez un connecteur existant ou collez l’URL d’un autre média."
            action="Configurer les sources"
            onAction={onConfigure}
          />
        ) : items.length === 0 && ui.searchItemIds && searchQuery ? (
          <PanelEmpty
            icon={<Search size={20} />}
            title="Aucun résultat"
            body={`Aucun article ne correspond à « ${searchQuery} » dans ce fil.`}
            action="Modifier la recherche"
            onAction={onSearch}
          />
        ) : items.length === 0 && ui.visibilityFilter === "unseen" ? (
          <PanelEmpty
            icon={<Check size={20} />}
            title="Tout est vu"
            body="Aucune publication non vue dans ce filtre."
            action="Tout afficher"
            onAction={() =>
              onUi({ visibilityFilter: "all", focusedItemId: null, pendingArrivalIds: new Set() })
            }
          />
        ) : items.length === 0 ? (
          <PanelEmpty
            icon={refreshing ? <LoaderCircle className="is-spinning" size={20} /> : <Rss size={20} />}
            title={refreshing ? "Récupération des actualités…" : "Aucune publication"}
            body="Les nouvelles publications apparaîtront ici automatiquement."
            action={refreshing ? undefined : "Actualiser"}
            onAction={refreshing ? undefined : () => void onRefresh()}
          />
        ) : (
          <>
          <div
            className="article-list"
            ref={articleListRef}
            onPointerLeave={clearHoverSeenTimer}
            onScroll={(event) => {
              // Revenu en haut : les arrivées comptées sont visibles, la
              // pastille n'a plus rien à signaler.
              if (event.currentTarget.scrollTop <= 2 && ui.pendingArrivalIds.size > 0) {
                onUi({ pendingArrivalIds: new Set() });
              }
            }}
          >
            {(density === "dense"
              ? withDaySeparators(items)
              : items.map((item) => ({ kind: "item" as const, item }))
            ).map((row) => {
              if (row.kind === "separator") {
                return (
                  <div key={row.key} className="article-day-separator" aria-hidden="true">
                    {row.label}
                  </div>
                );
              }
              const { item } = row;
              const source = state.sources.find(({ id }) => id === item.sourceId);
              const seen = item.seenAt !== null;
              const opened = item.openedAt !== null;
              const focused = ui.focusedItemId === item.id;
              return (
                <button
                  type="button"
                  id={`article-${panel.id}-${item.id}`}
                  key={item.id}
                  tabIndex={item.id === tabbableItemId ? 0 : -1}
                  className={`article-row${seen ? " article-row--seen" : ""}${
                    opened ? " article-row--opened" : ""
                  }${
                    focused ? " article-row--focused" : ""
                  }`}
                  title="Cliquer pour lire l’article sélectionné"
                  onFocus={() => onUi({ focusedItemId: item.id })}
                  onBlur={() => {
                    if (!seen && !opened) onSeen([item.id]);
                  }}
                  onPointerMove={() => {
                    if (ui.focusedItemId !== item.id) onUi({ focusedItemId: item.id });
                    // Déjà « vu » : rien à programmer.
                    if (seen || opened) return;
                    // Un minuteur cible déjà cette ligne : laisser le survol immobile
                    // aboutir sans le réarmer à chaque pixel.
                    if (hoverSeenTimerRef.current?.id === item.id) return;
                    clearHoverSeenTimer();
                    const handle = setTimeout(() => {
                      hoverSeenTimerRef.current = null;
                      onSeen([item.id]);
                    }, HOVER_SEEN_DELAY_MS);
                    hoverSeenTimerRef.current = { id: item.id, handle };
                  }}
                  onClick={() => {
                    if (ui.focusedItemId !== item.id) {
                      onUi({ focusedItemId: item.id });
                      return;
                    }
                    if (ui.visibilityFilter === "unseen") {
                      onUi({ focusedItemId: null });
                    }
                    void onOpen(item, `article-${panel.id}-${item.id}`);
                  }}
                >
                  <time
                    dateTime={item.publishedAt ?? item.updatedAt ?? item.firstSeenAt}
                    title={item.publishedAt || item.updatedAt ? undefined : "Heure indisponible"}
                  >
                    {formatItemTime(item)}
                  </time>
                  <i
                    className="article-identity"
                    aria-hidden="true"
                    style={{ "--source-hue": String(sourceHue(item.sourceId)) } as React.CSSProperties}
                  />
                  <span className="article-copy">
                    <span className="article-meta">
                      <span className="article-source">
                        <span className="article-source__full">{source?.name ?? "Source"}</span>
                        <span className="article-source__abbr" aria-hidden="true">
                          {abbreviateSourceName(source?.name ?? "Source")}
                        </span>
                      </span>
                      {!seen && !opened && <em>Nouveau</em>}
                      {seen && !opened && (
                        <em className="is-seen">✓<span className="article-state-label"> Vu</span></em>
                      )}
                      {opened && (
                        <em className="is-opened">✓<span className="article-state-label"> Ouvert</span></em>
                      )}
                    </span>
                    <strong>{item.title}</strong>
                    {item.summary && <span className="article-summary">{item.summary}</span>}
                  </span>
                  <ArrowUpRight className="article-open" size={13} />
                </button>
              );
            })}
          </div>
          {ui.pendingArrivalIds.size > 0 && (
            <button
              type="button"
              className="arrivals-pill"
              data-panel-focus-key="feed-arrivals-pill"
              aria-label={`${ui.pendingArrivalIds.size} ${
                ui.pendingArrivalIds.size > 1 ? "nouveaux articles" : "nouvel article"
              } au-dessus — afficher`}
              onClick={() => {
                const list = articleListRef.current;
                if (!list) return;
                list.querySelector<HTMLElement>(".article-row")?.focus({ preventScroll: true });
                const firstChild = list.firstElementChild;
                if (firstChild instanceof HTMLElement) smoothScrollIntoView(list, firstChild);
                onUi({ pendingArrivalIds: new Set() });
              }}
            >
              ▲ {ui.pendingArrivalIds.size}{" "}
              {ui.pendingArrivalIds.size > 1 ? "nouveaux" : "nouveau"} · Afficher
            </button>
          )}
          </>
        )}
      </div>
    </PanelFrame>
  );
}

function FeedRefreshStatus({ sources }: { sources: Source[] }) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const freshSourceCount = sources.filter(sourceIsFresh).length;
  const leastRecentSuccess = sources.some(({ lastSuccessAt }) => !lastSuccessAt)
    ? null
    : sources
        .map(({ lastSuccessAt }) => lastSuccessAt)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(0) ?? null;
  const nextRefresh = formatNextRefresh(sources, now);
  const leastRecentLabel = formatCheckedAt(leastRecentSuccess, now);
  const countdown = nextRefresh?.full ?? `plus ancienne ${leastRecentLabel}`;

  return (
    <span
      className={`feed-toolbar__freshness${
        freshSourceCount < sources.length ? " is-stale" : ""
      }`}
      title={`Source la moins récente : ${leastRecentLabel}. ${nextRefresh?.full ?? ""}`}
      aria-label={`${freshSourceCount} sources à jour sur ${sources.length}. Source la moins récente : ${leastRecentLabel}. ${nextRefresh?.full ?? ""}`}
    >
      <span className="feed-toolbar__freshness-full">
        {freshSourceCount}/{sources.length} sources à jour · {countdown}
      </span>
      <span className="feed-toolbar__freshness-compact" aria-hidden="true">
        {freshSourceCount}/{sources.length} · {nextRefresh?.compact ?? leastRecentLabel}
      </span>
    </span>
  );
}

function WebPanelView({
  panel,
  runtime,
  onSetUrl,
  ...frame
}: {
  panel: WebPanel;
  runtime?: WebPanelRuntimeState;
  onSetUrl: (url: string) => Promise<void>;
} & StandardPanelActions) {
  const [editingUrl, setEditingUrl] = useState(false);
  const [urlValue, setUrlValue] = useState(panel.url);
  const [saving, setSaving] = useState(false);
  const currentUrl = runtime?.url || panel.url;
  const failed = ["error", "crashed", "unresponsive"].includes(runtime?.status ?? "");

  useEffect(() => setUrlValue(panel.url), [panel.url]);

  async function submitUrl(event?: FormEvent) {
    event?.preventDefault();
    if (!urlValue.trim() || saving) return;
    setSaving(true);
    try {
      await onSetUrl(urlValue.trim());
      setEditingUrl(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <PanelFrame panelId={panel.id} kind="PAGE WEB" name={panel.name} {...frame}>
      <div className="web-toolbar">
        <IconButton
          label="Page précédente"
          disabled={!runtime?.canGoBack}
          onClick={() => void window.vibedeck.goBackWebPanel(panel.id)}
        >
          <ArrowLeft size={12} />
        </IconButton>
        <IconButton
          label="Page suivante"
          disabled={!runtime?.canGoForward}
          onClick={() => void window.vibedeck.goForwardWebPanel(panel.id)}
        >
          <ArrowRight size={12} />
        </IconButton>
        <IconButton label="Accueil" onClick={() => void window.vibedeck.homeWebPanel(panel.id)}>
          <Home size={12} />
        </IconButton>
        <IconButton
          label={runtime?.loading ? "Arrêter" : "Recharger"}
          onClick={() =>
            void (runtime?.loading
              ? window.vibedeck.stopWebPanel(panel.id)
              : window.vibedeck.reloadWebPanel(panel.id))
          }
        >
          {runtime?.loading ? <X size={12} /> : <RefreshCw size={12} />}
        </IconButton>
        {editingUrl ? (
          <form className="web-address web-address--editing" onSubmit={submitUrl}>
            <input
              aria-label="URL d’accueil de la page web"
              value={urlValue}
              autoFocus
              onChange={(event) => setUrlValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setUrlValue(panel.url);
                  setEditingUrl(false);
                }
              }}
            />
            <button type="submit" disabled={saving}>
              OK
            </button>
          </form>
        ) : (
          <button
            type="button"
            className="web-address"
            title="Modifier l’URL d’accueil"
            onClick={() => {
              setUrlValue(panel.url);
              setEditingUrl(true);
            }}
          >
            {currentUrl}
          </button>
        )}
        <IconButton
          label={runtime?.muted === false ? "Couper le son" : "Activer le son"}
          active={runtime?.muted === false}
          onClick={() =>
            void window.vibedeck.setWebPanelMuted(panel.id, runtime?.muted === false)
          }
        >
          {runtime?.muted === false ? <Volume2 size={12} /> : <VolumeX size={12} />}
        </IconButton>
        <IconButton
          label="Ouvrir dans le navigateur"
          onClick={() => void window.vibedeck.openExternalWebPanel(panel.id)}
        >
          <ExternalLink size={12} />
        </IconButton>
      </div>
      <div className="web-surface-wrap">
        {failed && (
          <PanelEmpty
            icon={<Globe2 size={20} />}
            title="Impossible d’afficher cette page"
            body={runtime?.error ?? "La page ne répond pas dans le panel."}
            action="Réessayer"
            onAction={() => void window.vibedeck.reloadWebPanel(panel.id)}
          />
        )}
        {!runtime && (
          <div className="web-initializing">
            <LoaderCircle className="is-spinning" size={17} /> Préparation de la page…
          </div>
        )}
        <div
          className="web-native-surface"
          data-web-panel-surface={panel.id}
          aria-label={`Page web ${panel.name}`}
        />
      </div>
    </PanelFrame>
  );
}

function LinkPreviewView({
  preview,
  runtime,
  onClose,
}: {
  preview: LinkPreview;
  runtime?: WebPanelRuntimeState;
  onClose: () => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const failed = ["error", "crashed", "unresponsive"].includes(runtime?.status ?? "");
  const readerMode = runtime?.readerMode ?? "extracting";
  const readerStatus =
    readerMode === "extracting"
      ? "Préparation de la lecture…"
      : readerMode === "simplified"
        ? "Lecture simplifiée"
        : runtime?.readerFallback
          ? "Page originale · lecture simplifiée indisponible"
          : "Page originale";

  useLayoutEffect(() => {
    closeButtonRef.current?.focus({ preventScroll: true });
  }, [preview.itemId]);

  return (
    <section className="dashboard-panel link-reader" aria-label={`Lecture — ${preview.title}`}>
      <header className="panel-header">
        <span className="panel-kind">Lecture</span>
        <strong className="link-reader__title" title={preview.title}>
          {preview.title}
        </strong>
        <button
          type="button"
          ref={closeButtonRef}
          className="icon-button icon-button--danger"
          aria-label="Retour au fil"
          title="Retour au fil"
          onClick={onClose}
        >
          <X size={13} />
        </button>
      </header>
      <div className="panel-content">
        <div className="web-toolbar link-reader__toolbar">
          <span className="web-address" aria-live="polite">
            {readerStatus}
          </span>
          {readerMode === "simplified" && (
            <button
              type="button"
              className="quiet-button"
              onClick={() => void window.vibedeck.showOriginalArticle(preview.itemId)}
            >
              Page originale
            </button>
          )}
          <button
            type="button"
            className="quiet-button link-reader__external"
            disabled={!runtime}
            onClick={() => void window.vibedeck.openExternalWebPanel(LINK_READER_ID)}
          >
            <ExternalLink size={12} /> Ouvrir à l’extérieur
          </button>
        </div>
        <div className="web-surface-wrap">
          {failed && (
            <PanelEmpty
              icon={<Globe2 size={20} />}
              title="Impossible d’afficher cet article"
              body={runtime?.error ?? "La page ne répond pas dans l’application."}
              action={readerMode === "original" ? "Réessayer" : "Page originale"}
              onAction={() => void (readerMode === "original"
                ? window.vibedeck.retryOriginalArticle(preview.itemId)
                : window.vibedeck.showOriginalArticle(preview.itemId))}
            />
          )}
          {!runtime && (
            <div className="web-initializing">
              <LoaderCircle className="is-spinning" size={17} /> Ouverture de l’article…
            </div>
          )}
          <div
            className="web-native-surface"
            data-web-panel-surface={LINK_READER_ID}
            aria-label={`Article ${preview.title}`}
          />
        </div>
      </div>
    </section>
  );
}

function catalogCapabilityLabel(capability: SourceCatalogEntry["capabilities"][number]) {
  if (capability === "optimized-feed") return "Fil optimisé";
  return "Lecture facilitée";
}

function sourceHealthLabel(source: Source) {
  if (source.status === "refreshing") return "Actualisation en cours";
  if (source.status === "error") return "Dernière actualisation en échec";
  if (source.status === "healthy") return "Source disponible";
  return "En attente d’actualisation";
}

function SourceCatalogPicker({
  catalog,
  selectedIds,
  attachedConnectorIds,
  disabled = false,
  onToggle,
}: {
  catalog: SourceCatalogEntry[];
  selectedIds: Set<string>;
  attachedConnectorIds: Set<string>;
  disabled?: boolean;
  onToggle: (catalogId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase("fr");
  const filtered = catalog.filter((entry) =>
    `${entry.name} ${entry.description} ${entry.homepageUrl}`
      .toLocaleLowerCase("fr")
      .includes(normalizedQuery),
  );

  return (
    <div className="catalog-picker">
      <label className="search-input catalog-picker__search">
        <Search size={14} />
        <span className="visually-hidden">Rechercher un connecteur optimisé</span>
        <input
          value={query}
          placeholder="Rechercher un média…"
          onChange={(event) => setQuery(event.target.value)}
          disabled={disabled}
        />
      </label>
      <div className="provider-list" aria-label="Connecteurs optimisés">
        {filtered.map((entry) => {
          const attached = attachedConnectorIds.has(entry.id);
          const selected = selectedIds.has(entry.id);
          return (
            <button
              type="button"
              key={entry.id}
              className={`provider-row${selected ? " is-selected" : ""}${attached ? " is-added" : ""}`}
              aria-pressed={selected || attached}
              disabled={disabled || attached}
              onClick={() => onToggle(entry.id)}
            >
              <ProviderMark providerId={entry.id} size={42} />
              <span className="provider-row__copy">
                <span className="provider-row__title">
                  <strong>{entry.name}</strong>
                  {attached && <em>Déjà dans le fil</em>}
                </span>
                <small>{entry.description}</small>
                <span className="provider-row__capabilities">
                  {entry.capabilities.map((capability) => (
                    <span key={capability}>{catalogCapabilityLabel(capability)}</span>
                  ))}
                </span>
              </span>
              <span className="provider-row__selection" aria-hidden="true">
                {(selected || attached) ? <Check size={14} /> : <Plus size={14} />}
              </span>
            </button>
          );
        })}
        {filtered.length === 0 && (
          <div className="provider-list__empty">
            Aucun connecteur optimisé ne correspond à « {query.trim()} ».
          </div>
        )}
      </div>
    </div>
  );
}

function CurrentSourcePicker({
  sources,
  keptSourceIds,
  disabled = false,
  onToggle,
}: {
  sources: Source[];
  keptSourceIds: Set<string>;
  disabled?: boolean;
  onToggle: (sourceId: string) => void;
}) {
  if (sources.length === 0) return null;
  return (
    <section className="feed-source-section">
      <div className="feed-source-section__heading">
        <div>
          <h3>Dans ce fil</h3>
          <p>Décochez une source pour la retirer au prochain enregistrement.</p>
        </div>
      </div>
      <div className="current-source-list">
        {sources.map((source) => {
          const kept = keptSourceIds.has(source.id);
          return (
            <button
              type="button"
              key={source.id}
              className={kept ? "is-kept" : "is-removed"}
              aria-pressed={kept}
              disabled={disabled}
              onClick={() => onToggle(source.id)}
            >
              <ProviderMark providerId={source.connectorId ?? "custom"} size={34} />
              <span>
                <strong>{source.name}</strong>
                <small>
                  {sourceHealthLabel(source)} · {connectorKindLabel(source.connectorKind)} · toutes les{" "}
                  {refreshIntervalLabel(source.refreshIntervalSeconds)}
                </small>
              </span>
              <em>{kept ? "Conservée" : "Sera retirée"}</em>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function probeDateLabel(value: string | null) {
  if (!value) return "Date non fournie";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Date non fournie";
  return date.toLocaleString("fr-FR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function CustomSourceTester({
  inputId,
  sources,
  disabled = false,
  onSourcesChange,
}: {
  inputId: string;
  sources: PendingCustomSource[];
  disabled?: boolean;
  onSourcesChange: (sources: PendingCustomSource[]) => void;
}) {
  const [input, setInput] = useState("");
  const [connectorKind, setConnectorKind] = useState<ConnectorPreference>("auto");
  const [pending, setPending] = useState(false);
  const [probe, setProbe] = useState<SourceProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [latestProbe] = useState(createLatestAsyncOperation);
  const testedKeyRef = useRef<string | null>(null);
  const probeIdRef = useRef<string | null>(null);
  const currentKey = `${connectorKind}\u0000${input.trim()}`;

  useEffect(() => () => {
    const probeId = probeIdRef.current;
    if (probeId) void window.vibedeck.cancelSourceProbe(probeId).catch(() => undefined);
  }, []);

  function invalidate(nextInput?: string, nextKind?: ConnectorPreference) {
    latestProbe.invalidate();
    testedKeyRef.current = null;
    const probeId = probeIdRef.current;
    probeIdRef.current = null;
    if (probeId) void window.vibedeck.cancelSourceProbe(probeId).catch(() => undefined);
    setPending(false);
    setProbe(null);
    setError(null);
    if (nextInput !== undefined) setInput(nextInput);
    if (nextKind !== undefined) setConnectorKind(nextKind);
  }

  async function testSource() {
    const url = input.trim();
    if (!url || disabled || pending) return;
    const probeId = crypto.randomUUID();
    probeIdRef.current = probeId;
    const requestKey = `${connectorKind}\u0000${url}`;
    setPending(true);
    setProbe(null);
    setError(null);
    try {
      await latestProbe.run(
        () => window.vibedeck.probeSource(probeId, { url, connectorKind }),
        {
          onSuccess: (result) => {
            testedKeyRef.current = requestKey;
            setProbe(result);
          },
          onError: (caught) => {
            testedKeyRef.current = null;
            setError(cleanError(caught));
          },
          onSettled: () => setPending(false),
        },
      );
    } finally {
      if (probeIdRef.current === probeId) probeIdRef.current = null;
    }
  }

  function addTestedSource() {
    if (!probe || testedKeyRef.current !== currentKey) return;
    const candidate = {
      url: probe.normalizedInputUrl,
      connectorKind,
    } satisfies PendingCustomSource;
    if (
      sources.some(
        (source) =>
          source.url === candidate.url && source.connectorKind === candidate.connectorKind,
      )
    ) {
      setError("Cette source est déjà prête à être ajoutée.");
      return;
    }
    onSourcesChange([...sources, candidate]);
    invalidate("");
  }

  return (
    <div className="custom-source-tester">
      <label htmlFor={inputId}>Adresse du site ou du flux</label>
      <div className="custom-source-input">
        <input
          id={inputId}
          value={input}
          inputMode="url"
          placeholder="https://exemple.fr/rss.xml"
          disabled={disabled}
          onChange={(event) => invalidate(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            void testSource();
          }}
        />
        <button type="button" disabled={!input.trim() || disabled || pending} onClick={() => void testSource()}>
          {pending && <LoaderCircle className="is-spinning" size={13} />}
          Tester
        </button>
      </div>
      <details className="connector-options">
        <summary>Options avancées · {connectorKindLabel(connectorKind)}</summary>
        <label>
          <span>Détection du connecteur</span>
          <select
            value={connectorKind}
            disabled={disabled}
            onChange={(event) => invalidate(undefined, event.target.value as ConnectorPreference)}
          >
            {CONNECTOR_KIND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </details>
      {pending && (
        <div className="source-probe source-probe--loading" role="status">
          <span />
          <div>
            <strong>Vérification du flux…</strong>
            <small>Détection du format et lecture des derniers éléments.</small>
          </div>
        </div>
      )}
      {probe && testedKeyRef.current === currentKey && (
        <div
          className={`source-probe${probe.freshness === "stale" ? " is-stale" : ""}`}
          aria-live="polite"
        >
          <div className="source-probe__summary">
            <span className="source-probe__check"><Check size={14} /></span>
            <div>
              <strong>{probe.name}</strong>
              <small>
                {connectorKindLabel(probe.connectorKind)} · {probe.itemCount} élément(s)
                {probe.connectorId ? " · connecteur optimisé reconnu" : ""}
              </small>
            </div>
            <button type="button" className="primary-button" onClick={addTestedSource} disabled={disabled}>
              Ajouter au fil
            </button>
          </div>
          {probe.warning && <p>{probe.warning}</p>}
          {probe.samples.length > 0 && (
            <ul>
              {probe.samples.map((sample, index) => (
                <li key={`${sample.publishedAt ?? "sans-date"}:${index}`}>
                  <span>{sample.title}</span>
                  <time>{probeDateLabel(sample.publishedAt)}</time>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      {sources.length > 0 && (
        <div className="queued-source-list" aria-label="Sources personnalisées prêtes">
          {sources.map((source) => (
            <div key={`${source.connectorKind}:${source.url}`}>
              <Rss size={14} />
              <span>
                <strong>{hostLabel(source.url)}</strong>
                <small>{connectorKindLabel(source.connectorKind)} · test réussi</small>
              </span>
              <button
                type="button"
                aria-label={`Retirer ${source.url}`}
                disabled={disabled}
                onClick={() =>
                  onSourcesChange(
                    sources.filter(
                      (candidate) =>
                        candidate.url !== source.url ||
                        candidate.connectorKind !== source.connectorKind,
                    ),
                  )
                }
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FeedSourceSelector({
  idPrefix,
  catalog,
  currentSources = [],
  keptSourceIds,
  selectedCatalogIds,
  customSources,
  disabled = false,
  onKeptSourceIdsChange,
  onSelectedCatalogIdsChange,
  onCustomSourcesChange,
}: {
  idPrefix: string;
  catalog: SourceCatalogEntry[];
  currentSources?: Source[];
  keptSourceIds: Set<string>;
  selectedCatalogIds: Set<string>;
  customSources: PendingCustomSource[];
  disabled?: boolean;
  onKeptSourceIdsChange: (sourceIds: Set<string>) => void;
  onSelectedCatalogIdsChange: (catalogIds: Set<string>) => void;
  onCustomSourcesChange: (sources: PendingCustomSource[]) => void;
}) {
  const attachedConnectorIds = new Set(
    currentSources
      .filter((source) => keptSourceIds.has(source.id))
      .map(({ connectorId }) => connectorId)
      .filter((connectorId): connectorId is string => Boolean(connectorId)),
  );

  return (
    <div className="feed-source-selector">
      <CurrentSourcePicker
        sources={currentSources}
        keptSourceIds={keptSourceIds}
        disabled={disabled}
        onToggle={(sourceId) => {
          const next = new Set(keptSourceIds);
          if (next.has(sourceId)) next.delete(sourceId);
          else next.add(sourceId);
          onKeptSourceIdsChange(next);
        }}
      />
      <section className="feed-source-section">
        <div className="feed-source-section__heading">
          <div>
            <h3>Connecteurs optimisés</h3>
            <p>Configurés et vérifiés pour chaque publication.</p>
          </div>
          <span className="feed-source-section__global-feature">
            <Search size={12} /> Recherche locale incluse dans tous les fils
          </span>
        </div>
        <SourceCatalogPicker
          catalog={catalog}
          selectedIds={selectedCatalogIds}
          attachedConnectorIds={attachedConnectorIds}
          disabled={disabled}
          onToggle={(catalogId) => {
            const next = new Set(selectedCatalogIds);
            if (next.has(catalogId)) next.delete(catalogId);
            else next.add(catalogId);
            onSelectedCatalogIdsChange(next);
          }}
        />
      </section>
      <section className="feed-source-section feed-source-section--custom">
        <div className="feed-source-section__heading">
          <div>
            <h3>Autre source</h3>
            <p>Testez une URL avant de l’ajouter. Rien ne sera attaché au fil pendant le test.</p>
          </div>
        </div>
        <CustomSourceTester
          inputId={`${idPrefix}-custom-source-url`}
          sources={customSources}
          disabled={disabled}
          onSourcesChange={onCustomSourcesChange}
        />
      </section>
    </div>
  );
}

function DraftPanelView({
  draft,
  catalog,
  webPreview,
  webPreviewRuntime,
  focused,
  onFocus,
  onClose,
  onStartWebPreview,
  onCancelWebPreview,
  onComplete,
}: {
  draft: DraftPanel;
  catalog: SourceCatalogEntry[];
  webPreview: WebPreviewDraft | null;
  webPreviewRuntime?: WebPanelRuntimeState;
  focused: boolean;
  onFocus: () => void;
  onClose: () => void;
  onStartWebPreview: (url: string) => Promise<void>;
  onCancelWebPreview: () => Promise<void>;
  onComplete: (
    input: CreatePanelInput,
    catalogIds?: string[],
    customSources?: PendingCustomSource[],
  ) => Promise<void>;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState<"type" | "web" | "feed">("type");
  const [pending, setPending] = useState(false);
  const [previewPending, setPreviewPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [webName, setWebName] = useState("");
  const [webUrl, setWebUrl] = useState("");
  const [feedName, setFeedName] = useState("");
  const [defaultRefreshInterval, setDefaultRefreshInterval] = useState(60);
  const [selectedCatalog, setSelectedCatalog] = useState<Set<string>>(new Set());
  const [customSources, setCustomSources] = useState<PendingCustomSource[]>([]);
  const busy = pending || previewPending || draft.pending;

  useLayoutEffect(() => {
    if (draft.pending) return;
    const frame = window.requestAnimationFrame(() => {
      const target =
        contentRef.current?.querySelector<HTMLElement>("[data-autofocus]:not(:disabled)") ??
        contentRef.current?.querySelector<HTMLElement>(
          "input:not(:disabled), button:not(:disabled), summary, select:not(:disabled)",
        );
      target?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [draft.pending, step, webPreview?.previewId]);

  async function previewWeb(name: string, url: string) {
    if (!url.trim() || busy) return;
    setWebName(name.trim());
    setWebUrl(url.trim());
    setPreviewPending(true);
    setError(null);
    try {
      await onStartWebPreview(url.trim());
    } catch (caught) {
      setError(cleanError(caught));
    } finally {
      setPreviewPending(false);
    }
  }

  async function createWebFromPreview() {
    if (!webPreview || pending || draft.pending) return;
    setPending(true);
    setError(null);
    try {
      await onComplete({
        kind: "web",
        name: webName.trim() || webPreviewRuntime?.title.trim() || hostLabel(webPreview.normalizedUrl),
        url: webPreview.normalizedUrl,
      });
    } catch (caught) {
      setError(cleanError(caught));
      setPending(false);
    }
  }

  async function createFeed(event: FormEvent) {
    event.preventDefault();
    if (selectedCatalog.size + customSources.length === 0 || busy) {
      setError("Sélectionnez au moins une source.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onComplete(
        {
          kind: "feed",
          name: feedName.trim() || "Fil d’actualité",
          defaultRefreshIntervalSeconds: defaultRefreshInterval,
        },
        [...selectedCatalog],
        customSources,
      );
    } catch (caught) {
      setError(cleanError(caught));
      setPending(false);
    }
  }

  return (
    <PanelFrame
      panelId={draft.id}
      kind="NOUVEAU"
      name="Nouveau panel"
      focused={focused}
      canRename={false}
      onFocus={onFocus}
      onClose={onClose}
      closeDisabled={busy}
    >
      <div
        ref={contentRef}
        className="draft-panel"
        aria-busy={busy}
        inert={busy ? true : undefined}
      >
        {draft.pending && (
          <div className="panel-empty" role="status">
            <LoaderCircle className="is-spinning" size={20} />
            <strong>{step === "web" ? "Création de la page web…" : "Création du fil…"}</strong>
            <span>La configuration est vérifiée et enregistrée localement.</span>
          </div>
        )}
        {!draft.pending && step === "type" && (
          <div className="draft-step draft-step--type">
            <span className="step-kicker">Nouveau panel</span>
            <h2>Que voulez-vous afficher ici ?</h2>
            <div className="panel-type-grid">
              <button type="button" data-autofocus onClick={() => setStep("web")}>
                <Globe2 size={21} />
                <strong>Page web</strong>
                <span>Un site ou une chaîne d’information affiché directement dans l’app.</span>
              </button>
              <button type="button" onClick={() => setStep("feed")}>
                <Rss size={21} />
                <strong>Fil agrégé</strong>
                <span>Plusieurs sources fusionnées dans un même fil chronologique.</span>
              </button>
            </div>
          </div>
        )}

        {!draft.pending && step === "web" && !webPreview && (
          <div className="draft-step">
            <button type="button" className="back-button" onClick={() => setStep("type")}>
              ‹ Type de panel
            </button>
            <h2>Page web</h2>
            <span className="form-section-label">Sites proposés</span>
            <div className="preset-list">
              {WEB_PRESETS.map((preset) => (
                <button
                  type="button"
                  key={preset.url}
                  onClick={() => void previewWeb(preset.name.split(" — ")[0], preset.url)}
                >
                  <span>
                    <strong>{preset.name}</strong>
                    <small>{preset.url}</small>
                  </span>
                  {preset.live && <em>● Direct</em>}
                </button>
              ))}
            </div>
            <span className="form-section-label">Ou prévisualiser une URL</span>
            <form
              className="inline-url-form"
              onSubmit={(event) => {
                event.preventDefault();
                void previewWeb(webName, webUrl);
              }}
            >
              <label htmlFor={`${draft.id}-web-name`}>Nom du panel</label>
              <input
                id={`${draft.id}-web-name`}
                data-autofocus
                aria-label="Nom du panel web"
                value={webName}
                placeholder="Nom du panel (facultatif)"
                onChange={(event) => setWebName(event.target.value)}
              />
              <label htmlFor={`${draft.id}-web-url`}>Adresse du site</label>
              <div>
                <input
                  id={`${draft.id}-web-url`}
                  aria-label="URL de la page web"
                  value={webUrl}
                  placeholder="bfmtv.com/en-direct"
                  inputMode="url"
                  onChange={(event) => setWebUrl(event.target.value)}
                />
                <button type="submit" className="primary-button" disabled={!webUrl.trim() || busy}>
                  {previewPending && <LoaderCircle className="is-spinning" size={13} />} Prévisualiser
                </button>
              </div>
            </form>
            {error && <p className="form-error" role="alert">{error}</p>}
          </div>
        )}

        {!draft.pending && step === "web" && webPreview && (
          <div className="draft-step web-preview-step">
            <div className="web-preview-step__heading" data-web-preview-controls={draft.id}>
              <button
                type="button"
                className="back-button"
                onClick={() => {
                  void onCancelWebPreview().catch((caught) => setError(cleanError(caught)));
                }}
              >
                ‹ Modifier l’adresse
              </button>
              <h2>{webPreviewRuntime?.title || webName || hostLabel(webPreview.normalizedUrl)}</h2>
              <p>
                Vérifiez le site et connectez-vous si nécessaire. Cookies et préférences resteront
                disponibles pour les autres panels de ce domaine.
              </p>
            </div>
            <div className="web-preview-frame">
              <div className="web-preview-frame__status" aria-live="polite">
                <span>{webPreviewRuntime?.url ?? webPreview.normalizedUrl}</span>
                <em>
                  {webPreviewRuntime?.loading
                    ? "Chargement…"
                    : webPreviewRuntime?.status === "ready"
                      ? "Prêt"
                      : webPreviewRuntime?.status === "error"
                        ? "Indisponible"
                        : "Ouverture…"}
                </em>
              </div>
              {webPreviewRuntime?.status === "error" && (
                <div className="web-preview-frame__error" role="alert">
                  {webPreviewRuntime.error ?? "Impossible de charger cette page."}
                </div>
              )}
              <div
                className="web-native-surface web-preview-native-surface"
                data-web-preview-surface={draft.id}
                aria-label={`Aperçu de ${hostLabel(webPreview.normalizedUrl)}`}
              />
            </div>
            {error && <p className="form-error" role="alert">{error}</p>}
            <div className="web-preview-step__footer" data-web-preview-controls={draft.id}>
              <button
                type="button"
                className="quiet-button"
                onClick={() => void onCancelWebPreview().catch((caught) => setError(cleanError(caught)))}
                disabled={pending}
              >
                Changer d’adresse
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={pending || webPreviewRuntime?.status === "error"}
                onClick={() => void createWebFromPreview()}
              >
                {pending && <LoaderCircle className="is-spinning" size={13} />} Créer ce panel
              </button>
            </div>
          </div>
        )}

        {!draft.pending && step === "feed" && (
          <form className="draft-step feed-builder" onSubmit={createFeed}>
            <button type="button" className="back-button" onClick={() => setStep("type")}>
              ‹ Type de panel
            </button>
            <h2>Fil agrégé</h2>
            <div className="feed-builder__basics">
              <label htmlFor={`${draft.id}-feed-name`}>
                <span>Nom du fil</span>
                <input
                  id={`${draft.id}-feed-name`}
                  data-autofocus
                  className="name-input"
                  value={feedName}
                  placeholder="Économie, concurrents, local…"
                  onChange={(event) => setFeedName(event.target.value)}
                />
              </label>
              <label className="compact-select-field">
                <span>Actualisation des nouvelles sources</span>
                <select
                  value={defaultRefreshInterval}
                  onChange={(event) => setDefaultRefreshInterval(Number(event.target.value))}
                >
                  {REFRESH_INTERVAL_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <FeedSourceSelector
              idPrefix={draft.id}
              catalog={catalog}
              keptSourceIds={new Set()}
              selectedCatalogIds={selectedCatalog}
              customSources={customSources}
              disabled={busy}
              onKeptSourceIdsChange={() => undefined}
              onSelectedCatalogIdsChange={setSelectedCatalog}
              onCustomSourcesChange={setCustomSources}
            />
            {error && <p className="form-error" role="alert">{error}</p>}
            <div className="feed-builder__footer">
              <span>
                {selectedCatalog.size + customSources.length} source(s) sélectionnée(s)
              </span>
              <button
                type="submit"
                className="primary-button"
                disabled={selectedCatalog.size + customSources.length === 0 || busy}
              >
                {pending && <LoaderCircle className="is-spinning" size={13} />} Créer le fil
              </button>
            </div>
          </form>
        )}
      </div>
    </PanelFrame>
  );
}

function hostLabel(value: string) {
  try {
    const candidate = /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`;
    return new URL(candidate).hostname.replace(/^www\./, "");
  } catch {
    return value.slice(0, 40);
  }
}

function connectorKindLabel(kind: ConnectorKind | ConnectorPreference) {
  return CONNECTOR_KIND_OPTIONS.find(({ value }) => value === kind)?.label ?? kind;
}

function refreshIntervalLabel(seconds: number) {
  return (
    REFRESH_INTERVAL_OPTIONS.find(({ value }) => value === seconds)?.label ??
    `${Math.round(seconds / 60)} min`
  );
}

function PanelEmpty({
  icon,
  title,
  body,
  action,
  onAction,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="panel-empty">
      {icon}
      <strong>{title}</strong>
      <span>{body}</span>
      {action && onAction ? (
        <button type="button" onClick={onAction}>
          {action}
        </button>
      ) : null}
    </div>
  );
}

function EmptyDashboard({
  onCreate,
  onStartTemplate,
}: {
  onCreate: () => void;
  onStartTemplate: () => void;
}) {
  return (
    <section className="empty-dashboard">
      <svg width="90" height="62" viewBox="0 0 90 62" aria-hidden="true">
        <rect x="1" y="1" width="88" height="60" rx="7" />
        <line x1="46" y1="1" x2="46" y2="61" />
        <line x1="1" y1="31" x2="46" y2="31" />
        <line x1="46" y1="43" x2="89" y2="43" />
        <circle cx="68" cy="21" r="6" />
        <line x1="72.5" y1="25.5" x2="77" y2="30" />
      </svg>
      <span className="step-kicker">Prêt à surveiller</span>
      <h1>Retrouvez vos sources au même endroit</h1>
      <p>
        Commencez avec Le Monde, Le Figaro et Le Parisien. Le fil se met à jour sans
        déplacer ce que vous êtes en train de lire.
      </p>
      <div className="empty-dashboard__actions">
        <button type="button" className="primary-button" onClick={onStartTemplate}>
          <Rss size={15} /> Lancer Veille concurrents
        </button>
        <button type="button" className="quiet-button" onClick={onCreate}>
          <Plus size={15} /> Créer autrement
        </button>
      </div>
    </section>
  );
}

function MissingPanel({ panelId }: { panelId: string }) {
  return (
    <section className="missing-panel">
      <strong>Panel introuvable</strong>
      <span>{panelId}</span>
    </section>
  );
}

function Modal({
  children,
  onDismiss,
  initialFocusRef,
}: {
  children: React.ReactNode;
  onDismiss: () => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
}) {
  const layerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const frame = window.requestAnimationFrame(() => {
      const firstField =
        initialFocusRef?.current ??
        layerRef.current?.querySelector<HTMLElement>("[data-autofocus]:not(:disabled)") ??
        layerRef.current?.querySelector<HTMLElement>(
          "input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled)",
        );
      firstField?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.requestAnimationFrame(() => previousFocus?.focus());
    };
  }, []);

  function onBackdrop(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) onDismiss();
  }
  return (
    <div
      ref={layerRef}
      className="modal-layer"
      role="presentation"
      onMouseDown={onBackdrop}
      onKeyDown={(event) => {
        if (event.key === "Tab") {
          const focusable = [...(layerRef.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [href], [tabindex]:not([tabindex='-1'])",
          ) ?? [])].filter((element) => element.getClientRects().length > 0);
          const first = focusable[0];
          const last = focusable.at(-1);
          if (first && last && event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (first && last && !event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
          return;
        }
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onDismiss();
      }}
    >
      {children}
    </div>
  );
}

function UpdateInstallModal({
  version,
  onLater,
  onClose,
}: {
  version: string;
  onLater: () => void;
  onClose: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const laterButtonRef = useRef<HTMLButtonElement>(null);

  async function install() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await window.vibedeck.restartForUpdate();
    } catch (caught) {
      setError(cleanError(caught));
      setPending(false);
    }
  }

  return (
    <Modal onDismiss={() => !pending && onClose()} initialFocusRef={laterButtonRef}>
      <section
        className="modal-card update-install-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="update-install-title"
        aria-describedby="update-install-description"
        aria-busy={pending || undefined}
      >
        <header><span>Mise à jour prête</span></header>
        <div>
          <h2 id="update-install-title">Installer VibeDeck {version} ?</h2>
          <p id="update-install-description">
            L’application va se fermer puis se rouvrir. Vos données locales sont conservées.
          </p>
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <footer>
          <button
            ref={laterButtonRef}
            type="button"
            className="quiet-button"
            disabled={pending}
            onClick={onLater}
          >
            Plus tard
          </button>
          <button type="button" className="primary-button" disabled={pending} onClick={() => void install()}>
            {pending && <LoaderCircle className="is-spinning" size={13} />}
            Redémarrer et installer
          </button>
        </footer>
      </section>
    </Modal>
  );
}

function ConfirmModal({
  title,
  body,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  return (
    <Modal onDismiss={() => !pending && onCancel()}>
      <section
        className="modal-card confirm-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
      >
        <header>
          <span>Confirmation</span>
          <button type="button" aria-label="Fermer" onClick={onCancel} disabled={pending}>
            <X size={16} />
          </button>
        </header>
        <div>
          <h2 id="confirm-modal-title">{title}</h2>
          <p>{body}</p>
        </div>
        <footer>
          <button type="button" className="quiet-button" onClick={onCancel} disabled={pending}>
            Annuler
          </button>
          <button
            type="button"
            className="danger-button"
            disabled={pending}
            onClick={() => {
              setPending(true);
              void Promise.resolve(onConfirm()).finally(() => setPending(false));
            }}
          >
            {pending && <LoaderCircle className="is-spinning" size={13} />}
            {confirmLabel}
          </button>
        </footer>
      </section>
    </Modal>
  );
}

function updateStateText(state: UpdateState | null) {
  if (!state) return "État des mises à jour indisponible.";
  switch (state.status) {
    case "disabled":
      return state.message ?? "Disponible uniquement dans l’application installée.";
    case "checking":
      return "Recherche d’une nouvelle version…";
    case "downloading":
      return state.progressPercent === null
        ? "Téléchargement de la nouvelle version…"
        : `Téléchargement de la version ${state.availableVersion ?? "suivante"} · ${state.progressPercent} %`;
    case "ready":
      return `La version ${state.availableVersion ?? "suivante"} est prête.`;
    case "up-to-date":
      return "Cette version est à jour.";
    case "error":
      return state.message ?? "La recherche de mise à jour a échoué.";
    default:
      return "La recherche automatique est active.";
  }
}

function updateStateAnnouncement(state: UpdateState | null) {
  if (!state) return "";
  switch (state.status) {
    case "checking":
      return "Recherche d’une mise à jour en cours.";
    case "downloading":
      return `Téléchargement de la version ${state.availableVersion ?? "suivante"} en cours.`;
    case "ready":
      return `La version ${state.availableVersion ?? "suivante"} est prête à redémarrer.`;
    case "up-to-date":
      return "VibeDeck est à jour.";
    case "error":
      return state.message ?? "La recherche de mise à jour a échoué.";
    default:
      return "";
  }
}

function PilotToolsModal({
  updateState,
  onUpdateState,
  onRequestRestart,
  updateActionRef,
  onClose,
  onImported,
  onToast,
  semanticStatus,
  onRemoveSemanticData,
}: {
  updateState: UpdateState | null;
  onUpdateState: (state: UpdateState) => void;
  onRequestRestart: () => void;
  updateActionRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onImported: (state: AppState, backupCreated: boolean) => void;
  onToast: (message: string) => void;
  semanticStatus: SemanticSearchStatus;
  onRemoveSemanticData: () => Promise<void>;
}) {
  const [pending, setPending] = useState<
    "import" | "export" | "diagnostics" | "web" | "search" | "update" | "restart" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmWebReset, setConfirmWebReset] = useState(false);
  const [confirmSearchReset, setConfirmSearchReset] = useState(false);

  async function run(
    kind: NonNullable<typeof pending>,
    operation: () => Promise<void>,
  ) {
    if (pending) return;
    setPending(kind);
    setError(null);
    try {
      await operation();
    } catch (caught) {
      setError(cleanError(caught));
    } finally {
      setPending(null);
    }
  }

  return (
    <Modal onDismiss={() => !pending && onClose()}>
      <section
        className="modal-card pilot-tools-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pilot-tools-title"
      >
        <header>
          <span id="pilot-tools-title">Outils du poste</span>
          <button type="button" aria-label="Fermer" onClick={onClose} disabled={Boolean(pending)}>
            <X size={16} />
          </button>
        </header>
        <div className={`pilot-tools-update pilot-tools-update--${updateState?.status ?? "unknown"}`}>
          <span>
            <strong>VibeDeck {updateState?.currentVersion ?? ""}</strong>
            {updateStateText(updateState)}
            {updateState?.status === "downloading" && (
              <progress
                aria-label={`Téléchargement de la version ${updateState.availableVersion ?? "suivante"}`}
                value={updateState.progressPercent ?? undefined}
                max="100"
              >
                {updateState.progressPercent ?? ""}
              </progress>
            )}
          </span>
          {updateState?.status === "ready" ? (
            <button
              ref={updateActionRef}
              type="button"
              className="primary-button"
              disabled={Boolean(pending)}
              onClick={onRequestRestart}
            >
              Installer
            </button>
          ) : (
            <button
              type="button"
              className="quiet-button"
              disabled={
                Boolean(pending) ||
                !updateState ||
                updateState.status === "disabled" ||
                updateState.status === "checking" ||
                updateState.status === "downloading"
              }
              onClick={() =>
                void run("update", async () => {
                  onUpdateState(await window.vibedeck.checkForUpdates());
                })
              }
            >
              {(pending === "update" || updateState?.status === "checking") && (
                <LoaderCircle className="is-spinning" size={13} />
              )}
              Vérifier
            </button>
          )}
        </div>
        <div className="pilot-tools-list">
          <button
            type="button"
            disabled={Boolean(pending)}
            onClick={() =>
              void run("import", async () => {
                const result = await window.vibedeck.importDashboard();
                if (result.state) onImported(result.state, Boolean(result.backupFilePath));
              })
            }
          >
            <strong>Importer un dashboard</strong>
            <span>Prévisualiser puis remplacer ce poste, avec sauvegarde locale automatique.</span>
            {pending === "import" && <LoaderCircle className="is-spinning" size={14} />}
          </button>
          <button
            type="button"
            disabled={Boolean(pending)}
            onClick={() =>
              void run("export", async () => {
                const result = await window.vibedeck.exportDashboard();
                if (!result.canceled) onToast("Dashboard exporté");
              })
            }
          >
            <strong>Exporter ce dashboard</strong>
            <span>Partager les panels et les sources, sans les articles en cache.</span>
            {pending === "export" && <LoaderCircle className="is-spinning" size={14} />}
          </button>
          <button
            type="button"
            disabled={Boolean(pending)}
            onClick={() =>
              void run("diagnostics", async () => {
                const result = await window.vibedeck.exportDiagnostics();
                if (!result.canceled) onToast("Diagnostic exporté");
              })
            }
          >
            <strong>Exporter un diagnostic</strong>
            <span>Rapport technique sans URL ni contenu d’article, prêt à transmettre au support.</span>
            {pending === "diagnostics" && <LoaderCircle className="is-spinning" size={14} />}
          </button>
        </div>
        <div className="pilot-tools-danger">
          <span>
            <strong>Pages web</strong>
            {confirmWebReset
              ? "Cette action déconnecte les pages intégrées. Confirmez pour continuer."
              : "Efface cookies et cache si une page intégrée ne fonctionne plus."}
          </span>
          <button
            type="button"
            className="danger-button"
            disabled={Boolean(pending)}
            onClick={() => {
              if (!confirmWebReset) {
                setConfirmWebReset(true);
                return;
              }
              void run("web", async () => {
                await window.vibedeck.clearWebData();
                setConfirmWebReset(false);
                onToast("Données des pages web effacées");
              });
            }}
          >
            {pending === "web" && <LoaderCircle className="is-spinning" size={13} />}
            {confirmWebReset ? "Confirmer" : "Réinitialiser"}
          </button>
        </div>
        <div className="pilot-tools-danger">
          <span>
            <strong>Recherche locale</strong>
            {confirmSearchReset
              ? "Supprime le modèle et l’index dérivé, sans toucher aux articles. Confirmez pour continuer."
              : semanticStatus.phase === "not-installed"
                ? "Non installée."
                : `${semanticStatus.phase === "ready" ? "Prête" : semanticStatus.phase} · ${Math.round(semanticStatus.bytes / 1_000_000)} Mo utilisés.`}
          </span>
          <button
            type="button"
            className="danger-button"
            disabled={Boolean(pending) || semanticStatus.phase === "not-installed"}
            onClick={() => {
              if (!confirmSearchReset) {
                setConfirmSearchReset(true);
                return;
              }
              void run("search", async () => {
                await onRemoveSemanticData();
                setConfirmSearchReset(false);
                onToast("Recherche locale supprimée");
              });
            }}
          >
            {pending === "search" && <LoaderCircle className="is-spinning" size={13} />}
            {confirmSearchReset ? "Confirmer" : "Supprimer"}
          </button>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <footer>
          <button type="button" className="quiet-button" onClick={onClose} disabled={Boolean(pending)}>
            Fermer
          </button>
        </footer>
      </section>
    </Modal>
  );
}

function FeedConfigModal({
  panel,
  state,
  onClose,
  onSaved,
}: {
  panel: FeedPanel;
  state: AppState;
  onClose: () => void;
  onSaved: (state: AppState, message: string) => void;
}) {
  const currentSources = panel.sourceIds
    .map((id) => state.sources.find((source) => source.id === id))
    .filter((source): source is Source => Boolean(source));
  const [name, setName] = useState(panel.name);
  const [keptSourceIds, setKeptSourceIds] = useState(
    () => new Set(currentSources.map(({ id }) => id)),
  );
  const [selectedCatalogIds, setSelectedCatalogIds] = useState(() => new Set<string>());
  const [defaultRefreshInterval, setDefaultRefreshInterval] = useState(
    panel.defaultRefreshIntervalSeconds,
  );
  const [customSources, setCustomSources] = useState<PendingCustomSource[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || pending) return;
    setPending(true);
    setError(null);
    try {
      const nextState = await saveFeedPanelConfiguration(window.vibedeck, panel, state, {
        name: name.trim(),
        defaultRefreshIntervalSeconds: defaultRefreshInterval,
        keptSourceIds: [...keptSourceIds],
        selectedCatalogIds: [...selectedCatalogIds],
        customSources,
      });
      onSaved(nextState, "Sources mises à jour");
    } catch (caught) {
      setError(cleanError(caught));
      setPending(false);
    }
  }

  return (
    <Modal onDismiss={() => !pending && onClose()}>
      <form
        className="modal-card feed-config-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="feed-config-title"
        onSubmit={save}
      >
        <header>
          <span id="feed-config-title">Configuration du fil</span>
          <button type="button" aria-label="Fermer" onClick={onClose} disabled={pending}>
            <X size={16} />
          </button>
        </header>
        <div className="modal-scroll" aria-busy={pending} inert={pending ? true : undefined}>
          <div className="feed-config-basics">
            <label className="field" htmlFor={`${panel.id}-feed-name`}>
              <span>Nom du fil</span>
              <input
                id={`${panel.id}-feed-name`}
                data-autofocus
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="compact-select-field compact-select-field--modal">
              <span>Actualisation des nouvelles sources</span>
              <select
                value={defaultRefreshInterval}
                onChange={(event) => setDefaultRefreshInterval(Number(event.target.value))}
              >
                {REFRESH_INTERVAL_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <FeedSourceSelector
            idPrefix={panel.id}
            catalog={state.sourceCatalog}
            currentSources={currentSources}
            keptSourceIds={keptSourceIds}
            selectedCatalogIds={selectedCatalogIds}
            customSources={customSources}
            disabled={pending}
            onKeptSourceIdsChange={setKeptSourceIds}
            onSelectedCatalogIdsChange={setSelectedCatalogIds}
            onCustomSourcesChange={setCustomSources}
          />
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <footer>
          <button type="button" className="quiet-button" onClick={onClose} disabled={pending}>
            Annuler
          </button>
          <button type="submit" className="primary-button" disabled={!name.trim() || pending}>
            {pending && <LoaderCircle className="is-spinning" size={13} />} Enregistrer les sources
          </button>
        </footer>
      </form>
    </Modal>
  );
}
