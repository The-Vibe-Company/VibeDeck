import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  Columns2,
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
  compareFeedItems,
  formatCheckedAt,
  formatItemTime,
  formatNextRefresh,
} from "./feed-presentation";
import { saveFeedPanelConfiguration } from "./feed-settings";
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
  SourceRequest,
  SemanticSearchScope,
  SemanticSearchResult,
  SemanticSearchStatus,
  WebPanel,
  WebPanelDescriptor,
  WebPanelRuntimeState,
} from "./types";

const LINK_READER_ID = "reader:article";
const MAX_DASHBOARD_WEB_PANELS = 6;
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

type FeedPanelUi = {
  sourceFilter: string;
  visibilityFilter: "all" | "unseen";
  focusedItemId: string | null;
  visibleItemIds: Set<string>;
  automaticInsertionIds: Set<string>;
  automaticInsertionMetrics: { scrollHeight: number; scrollTop: number } | null;
  searchItemIds: Set<string> | null;
};

type LinkPreview = {
  url: string;
  title: string;
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
  const [focusedPanelId, setFocusedPanelId] = useState<string | null>(null);
  const [maximizedPanelId, setMaximizedPanelId] = useState<string | null>(null);
  const [feedUi, setFeedUi] = useState<Record<string, FeedPanelUi>>({});
  const [webStates, setWebStates] = useState<Record<string, WebPanelRuntimeState>>({});
  const [linkPreview, setLinkPreview] = useState<LinkPreview | null>(null);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [interactionActive, setInteractionActive] = useState(false);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [semanticSearchStatus, setSemanticSearchStatus] = useState<SemanticSearchStatus>({
    phase: "not-installed", progress: 0, message: null, bytes: 0,
  });
  const [semanticSearchOpen, setSemanticSearchOpen] = useState(false);
  const [semanticSearchScope, setSemanticSearchScope] = useState<SemanticSearchScope>({ kind: "all" });
  const [activeSemanticSearch, setActiveSemanticSearch] = useState<ActiveSemanticSearch | null>(null);
  const [clock, setClock] = useState(() => new Date());
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

  const layoutRef = useRef<LayoutNode | null>(null);
  const feedUiRef = useRef<Record<string, FeedPanelUi>>({});
  const draftsRef = useRef<Record<string, DraftPanel>>({});
  const revisionRef = useRef(0);
  const hydratedRef = useRef(false);
  const serverLayoutMutationRef = useRef(false);
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
  const focusedPanelIdRef = useRef<string | null>(null);
  const semanticResultItemsRef = useRef<FeedItem[]>([]);
  const semanticBaseItemIdsRef = useRef(new Set<string>());
  const semanticSearchRestoreRef = useRef<SemanticSearchRestoreState | null>(null);
  const activeSemanticSearchRef = useRef<ActiveSemanticSearch | null>(null);
  const semanticSearchNativeOriginRef = useRef(false);

  layoutRef.current = layout;
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

  const applyServerState = useCallback((
    nextState: AppState,
    forceLayout = false,
    replaceFeedUi = false,
  ) => {
    const automaticInsertionMetrics = new Map<
      string,
      { scrollHeight: number; scrollTop: number }
    >();
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
        automaticInsertionMetrics.set(panel.id, {
          scrollHeight: list.scrollHeight,
          scrollTop: list.scrollTop,
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
        // The delivery buffer stays local to each panel, but every incoming row
        // is promoted in the same renderer update that receives it.
        for (const item of panelItems(panel, nextState)) {
          if (!visibleItemIds.has(item.id) && !item.isBaseline) {
            automaticInsertionIds.add(item.id);
          }
          visibleItemIds.add(item.id);
        }
        const hasAutomaticInsertions = automaticInsertionIds.size > 0;
        next[panel.id] = {
          ...existing,
          visibleItemIds,
          automaticInsertionIds: hasAutomaticInsertions
            ? automaticInsertionIds
            : existing.automaticInsertionIds,
          automaticInsertionMetrics: hasAutomaticInsertions
            ? automaticInsertionMetrics.get(panel.id) ?? null
            : existing.automaticInsertionMetrics,
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
    window.mediagen
      .getState()
      .then((nextState) => {
        if (live) applyServerState(nextState, true);
      })
      .catch((error) => {
        if (live) setFatalError(cleanError(error));
      });

    const unsubscribeState = window.mediagen.onStateChanged((nextState) => {
      if (live) applyServerState(nextState);
    });
    const unsubscribeWeb = window.mediagen.onWebPanelStateChanged((nextState) => {
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
    const unsubscribeWebEscape = window.mediagen.onWebPanelEscape(() => {
      setLinkPreview((current) => {
        if (current) return null;
        setMaximizedPanelId(null);
        return current;
      });
    });
    const unsubscribeSemanticStatus = window.mediagen.onSemanticSearchStatusChanged((nextStatus) => {
      if (live) setSemanticSearchStatus(nextStatus);
    });
    const unsubscribeGlobalSearch = window.mediagen.onOpenGlobalSearch((nativeOrigin) => {
      if (!live) return;
      openSemanticSearch({ kind: "all" }, nativeOrigin);
    });
    void window.mediagen.getSemanticSearchStatus().then((nextStatus) => {
      if (live) setSemanticSearchStatus(nextStatus);
    });

    return () => {
      live = false;
      unsubscribeState();
      unsubscribeWeb();
      unsubscribeWebEscape();
      unsubscribeSemanticStatus();
      unsubscribeGlobalSearch();
    };
  }, [applyServerState]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(
    () => () => {
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
      window.mediagen.syncWebPanels([]);
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
          !modal &&
          !semanticSearchOpen &&
          !interactionActive &&
          !linkPreview &&
          !failedPanelIds.has(panel.id);
        const rect = surface?.getBoundingClientRect();
        return {
          panelId: panel.id,
          url: panel.url,
          bounds: rect
            ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
            : { x: 0, y: 0, width: 0, height: 0 },
          visible: canDisplay,
        };
      });
    if (linkPreview) {
      const surface = document.querySelector<HTMLElement>(
        `[data-web-panel-surface="${LINK_READER_ID}"]`,
      );
      const rect = surface?.getBoundingClientRect();
      descriptors.push({
        panelId: LINK_READER_ID,
        url: linkPreview.url,
        bounds: rect
          ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          : { x: 0, y: 0, width: 0, height: 0 },
        visible:
          Boolean(surface) &&
          !modal &&
          !interactionActive &&
          !failedPanelIds.has(LINK_READER_ID),
      });
    }
    window.mediagen.syncWebPanels(descriptors);
  }, [failedWebPanelKey, interactionActive, linkPreview, modal, semanticSearchOpen, state]);

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
          const nextState = await window.mediagen.saveDashboardLayout(
            nextLayout,
            revisionRef.current,
          );
          applyServerState(nextState);
        } catch (error) {
          showToast(cleanError(error));
          const recovered = await window.mediagen.getState();
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
      let nextState = await window.mediagen.createPanel(
        input,
        panelPlacementForDraft(draft),
      );
      const createdPanel = nextState.panels.find(({ id }) => !previousIds.has(id));
      if (!createdPanel) throw new Error("Le nouveau panel n’a pas pu être retrouvé.");

      const sourceErrors: string[] = [];
      let sourceSuccesses = 0;
      if (createdPanel.kind === "feed") {
        const refreshIntervalSeconds =
          input.kind === "feed" ? input.defaultRefreshIntervalSeconds : undefined;
        for (const catalogId of catalogIds) {
          try {
            const result = await window.mediagen.addCatalogSource(
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
            const result = await window.mediagen.addSource(createdPanel.id, {
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
          await window.mediagen.deletePanel(createdPanel.id);
          throw new Error(sourceErrors[0] ?? "Aucune source n’a pu être ajoutée à ce fil.");
        }
      }

      const desiredLayout = replacePanelId(layoutRef.current, draftId, createdPanel.id);
      let layoutWarning = false;
      if (desiredLayout) {
        try {
          nextState = await window.mediagen.saveDashboardLayout(
            desiredLayout,
            nextState.dashboard.revision,
          );
        } catch {
          layoutWarning = true;
          nextState = await window.mediagen.getState();
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
      const nextState = await window.mediagen.deletePanel(panelId);
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
        nextState = await window.mediagen.deletePanel(panel.id);
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
      applyServerState(await window.mediagen.renamePanel(panelId, name));
    } catch (error) {
      showToast(cleanError(error));
    }
  }

  async function updateWebPanelUrl(panelId: string, url: string) {
    try {
      const nextState = await window.mediagen.setWebPanelUrl(panelId, url);
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
      await Promise.all(
        sources.map((source) => window.mediagen.refreshSource(source.id)),
      );
      const nextState = await window.mediagen.getState();
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

  function openItem(item: FeedItem) {
    setLinkPreview({ url: item.canonicalUrl, title: item.title });
    void window.mediagen
      .markItemOpened(item.id)
      .then((nextState) => applyServerState(nextState))
      .catch((error) => showToast(cleanError(error)));
  }

  function markItemsSeen(itemIds: string[]) {
    if (itemIds.length === 0) return;
    void window.mediagen
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
    window.mediagen.finishSemanticSearchFocus(restoreNative);
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
        ? { ...ui, searchItemIds: resultIds, focusedItemId: null }
        : { ...ui, searchItemIds: null },
    ])));
    const appliedSearch = { query, scope, resultCount: result.items.length, result };
    activeSemanticSearchRef.current = appliedSearch;
    setActiveSemanticSearch(appliedSearch);
    setSemanticSearchOpen(false);
    semanticSearchNativeOriginRef.current = false;
    window.mediagen.finishSemanticSearchFocus(false);
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

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (semanticSearchOpen) {
          closeSemanticSearchPalette();
        }
        else if (isTypingTarget(event.target)) return;
        else if (Object.values(feedUi).some(({ searchItemIds }) => searchItemIds !== null)) {
          clearSemanticSearchFilter();
        }
        else if (!modal && linkPreview) setLinkPreview(null);
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
        void refreshFeedPanel(panel);
        return;
      }
      if (
        event.key.toLowerCase() === "j" ||
        event.key.toLowerCase() === "k" ||
        event.key === "ArrowDown" ||
        event.key === "ArrowUp"
      ) {
        event.preventDefault();
        const activeArticleId =
          event.target instanceof HTMLElement
            ? event.target.closest<HTMLElement>(".article-row")?.id ?? null
            : null;
        const activeArticleIndex = activeArticleId
          ? items.findIndex(({ id }) => activeArticleId === `article-${panel.id}-${id}`)
          : -1;
        const currentIndex = activeArticleIndex >= 0
          ? activeArticleIndex
          : items.findIndex(({ id }) => id === ui.focusedItemId);
        const direction =
          event.key.toLowerCase() === "j" || event.key === "ArrowDown" ? 1 : -1;
        const nextIndex = Math.max(
          0,
          Math.min(items.length - 1, currentIndex < 0 ? 0 : currentIndex + direction),
        );
        const item = items[nextIndex];
        if (item) {
          patchFeedUi(panel.id, { focusedItemId: item.id });
          const article = document.getElementById(`article-${panel.id}-${item.id}`);
          article?.focus({ preventScroll: true });
          article?.scrollIntoView({ block: "nearest" });
        }
        return;
      }
      const focusedArticleId = ui.focusedItemId
        ? `article-${panel.id}-${ui.focusedItemId}`
        : null;
      if (
        event.key === "Enter" &&
        focusedArticleId &&
        event.target instanceof HTMLElement &&
        event.target.id === focusedArticleId
      ) {
        const item = items.find(({ id }) => id === ui.focusedItemId);
        if (item) {
          event.preventDefault();
          if (ui.visibilityFilter === "unseen") {
            patchFeedUi(panel.id, { focusedItemId: null });
          }
          void openItem(item);
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  if (fatalError) {
    return (
      <main className="fatal-state">
        <Brand />
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
        <Brand />
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
          focused={focusedPanelId === panelId}
          onFocus={() => setFocusedPanelId(panelId)}
          onClose={() => closeDraft(panelId)}
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
          onOpen={openItem}
          onSeen={markItemsSeen}
          onRefresh={() => refreshFeedPanel(panel)}
          onConfigure={() => setModal({ kind: "configure-feed", panelId: panel.id })}
          onSearch={() => {
            openSemanticSearch({ kind: "panel", panelId: panel.id });
          }}
          searchQuery={activeSemanticSearch?.query ?? null}
          onClearSearch={clearSemanticSearchFilter}
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
      <header
        className="global-bar"
        aria-hidden={modal || semanticSearchOpen ? true : undefined}
        inert={modal || semanticSearchOpen ? true : undefined}
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
        {linkPreview && (
          <button type="button" className="restore-pill" onClick={() => setLinkPreview(null)}>
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
        <button
          type="button"
          className="quiet-button global-tools"
          onClick={() => setModal({ kind: "pilot-tools" })}
        >
          <SlidersHorizontal size={13} /> Outils
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
        aria-hidden={modal || semanticSearchOpen ? true : undefined}
        inert={modal || semanticSearchOpen ? true : undefined}
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
            onClose={() => setLinkPreview(null)}
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

      {modal?.kind === "pilot-tools" && (
        <PilotToolsModal
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
            await window.mediagen.removeSemanticSearchData();
          }}
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
          onPrepare={() => void window.mediagen.prepareSemanticSearch().catch((error) => showToast(cleanError(error)))}
          onCancelPreparation={() => void window.mediagen.cancelSemanticSearchPreparation()}
          onClose={closeSemanticSearchPalette}
          onOpenItem={(item) => {
            closeSemanticSearchPalette();
            void openItem(item);
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
  const resultsRef = useRef<SemanticSearchResult | null>(initialResult);
  const resultsKeyRef = useRef(initialResult ? searchDraftKey(initialQuery, scope) : null);
  const skipInitialSearchRef = useRef(Boolean(initialResult && initialQuery.trim().length >= 2));
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<SemanticSearchResult | null>(initialResult);
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
    resultsKeyRef.current = key;
    resultsRef.current = result;
    setResults(result);
    setActiveItemId((current) =>
      current && result.items.some(({ id }) => id === current) ? current : null,
    );
  }

  function requestHybrid(key: string, candidateQuery: string, candidateScope: SemanticSearchScope) {
    if (hybridResultRef.current?.key === key) {
      return Promise.resolve(hybridResultRef.current.result);
    }
    if (hybridRequestRef.current?.key === key) return hybridRequestRef.current.promise;
    const promise = window.mediagen
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
    void window.mediagen
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

function Brand() {
  return (
    <div className="brand" aria-label="MediaGen Veille">
      <span className="brand__mark" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <strong>MEDIAGEN</strong>
      <span>VEILLE<span className="brand__cursor">_</span></span>
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
    window.mediagen.focusDashboard();
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
  active,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
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
  ...frame
}: {
  panel: FeedPanel;
  state: AppState;
  ui: FeedPanelUi;
  onUi: (patch: Partial<FeedPanelUi>) => void;
  onOpen: (item: FeedItem) => void | Promise<void>;
  onSeen: (itemIds: string[]) => void;
  onRefresh: () => void | Promise<void>;
  onConfigure: () => void;
  onSearch: () => void;
  searchQuery: string | null;
  onClearSearch: () => void;
} & StandardPanelActions) {
  const articleListRef = useRef<HTMLDivElement>(null);
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
        list.scrollTop = 0;
      } else {
        list.scrollTop = previous.scrollTop + Math.max(0, list.scrollHeight - previous.scrollHeight);
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
      primaryActions={
        <>
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
            onClick={() => onUi({ sourceFilter: "all", focusedItemId: null })}
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
              onClick={() => onUi({ sourceFilter: source.id, focusedItemId: null })}
            >
              <i className={`source-dot source-dot--${source.status}`} />
              {source.name}
            </button>
          ))}
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
            onAction={() => onUi({ visibilityFilter: "all", focusedItemId: null })}
          />
        ) : items.length === 0 ? (
          <PanelEmpty
            icon={refreshing ? <LoaderCircle className="is-spinning" size={20} /> : <Rss size={20} />}
            title={refreshing ? "Récupération des actualités…" : "Aucune publication"}
            body="Les nouvelles publications apparaîtront ici automatiquement."
            action="Actualiser"
            onAction={() => void onRefresh()}
          />
        ) : (
          <div className="article-list" ref={articleListRef}>
            {items.map((item) => {
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
                  title="Lire l’article dans l’application"
                  onFocus={() => onUi({ focusedItemId: item.id })}
                  onBlur={() => {
                    if (!seen && !opened) onSeen([item.id]);
                  }}
                  onClick={() => {
                    if (ui.visibilityFilter === "unseen") {
                      onUi({ focusedItemId: null });
                    }
                    void onOpen(item);
                  }}
                >
                  <time
                    dateTime={item.publishedAt ?? item.updatedAt ?? item.firstSeenAt}
                    title={item.publishedAt || item.updatedAt ? undefined : "Heure indisponible"}
                  >
                    {formatItemTime(item)}
                  </time>
                  <span className="article-copy">
                    <span className="article-meta">
                      <span className="article-source">{source?.name ?? "Source"}</span>
                      {!seen && !opened && <em>Nouveau</em>}
                      {seen && !opened && <em className="is-seen">✓ Vu</em>}
                      {opened && <em className="is-opened">✓ Ouvert</em>}
                    </span>
                    <strong>{item.title}</strong>
                    {item.summary && <span className="article-summary">{item.summary}</span>}
                  </span>
                  <ArrowUpRight className="article-open" size={13} />
                </button>
              );
            })}
          </div>
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
          onClick={() => void window.mediagen.goBackWebPanel(panel.id)}
        >
          <ArrowLeft size={12} />
        </IconButton>
        <IconButton
          label="Page suivante"
          disabled={!runtime?.canGoForward}
          onClick={() => void window.mediagen.goForwardWebPanel(panel.id)}
        >
          <ArrowRight size={12} />
        </IconButton>
        <IconButton label="Accueil" onClick={() => void window.mediagen.homeWebPanel(panel.id)}>
          <Home size={12} />
        </IconButton>
        <IconButton
          label={runtime?.loading ? "Arrêter" : "Recharger"}
          onClick={() =>
            void (runtime?.loading
              ? window.mediagen.stopWebPanel(panel.id)
              : window.mediagen.reloadWebPanel(panel.id))
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
            void window.mediagen.setWebPanelMuted(panel.id, runtime?.muted === false)
          }
        >
          {runtime?.muted === false ? <Volume2 size={12} /> : <VolumeX size={12} />}
        </IconButton>
        <IconButton
          label="Ouvrir dans le navigateur"
          onClick={() => void window.mediagen.openExternalWebPanel(panel.id)}
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
            onAction={() => void window.mediagen.reloadWebPanel(panel.id)}
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
  const failed = ["error", "crashed", "unresponsive"].includes(runtime?.status ?? "");
  const currentUrl = runtime?.url || preview.url;

  return (
    <section className="dashboard-panel link-reader" aria-label={`Lecture — ${preview.title}`}>
      <header className="panel-header">
        <span className="panel-kind">Lecture</span>
        <strong className="link-reader__title" title={preview.title}>
          {preview.title}
        </strong>
        <button
          type="button"
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
          <IconButton
            label="Page précédente"
            disabled={!runtime?.canGoBack}
            onClick={() => void window.mediagen.goBackWebPanel(LINK_READER_ID)}
          >
            <ArrowLeft size={12} />
          </IconButton>
          <IconButton
            label="Page suivante"
            disabled={!runtime?.canGoForward}
            onClick={() => void window.mediagen.goForwardWebPanel(LINK_READER_ID)}
          >
            <ArrowRight size={12} />
          </IconButton>
          <IconButton
            label={runtime?.loading ? "Arrêter" : "Recharger"}
            disabled={!runtime}
            onClick={() =>
              void (runtime?.loading
                ? window.mediagen.stopWebPanel(LINK_READER_ID)
                : window.mediagen.reloadWebPanel(LINK_READER_ID))
            }
          >
            {runtime?.loading ? <X size={12} /> : <RefreshCw size={12} />}
          </IconButton>
          <span className="web-address" title={currentUrl}>
            {currentUrl}
          </span>
          <IconButton
            label={runtime?.muted === false ? "Couper le son" : "Activer le son"}
            disabled={!runtime}
            active={runtime?.muted === false}
            onClick={() =>
              void window.mediagen.setWebPanelMuted(
                LINK_READER_ID,
                runtime?.muted === false,
              )
            }
          >
            {runtime?.muted === false ? <Volume2 size={12} /> : <VolumeX size={12} />}
          </IconButton>
          <button
            type="button"
            className="quiet-button link-reader__external"
            disabled={!runtime}
            onClick={() => void window.mediagen.openExternalWebPanel(LINK_READER_ID)}
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
              action="Réessayer"
              onAction={() => void window.mediagen.reloadWebPanel(LINK_READER_ID)}
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

function DraftPanelView({
  draft,
  catalog,
  focused,
  onFocus,
  onClose,
  onComplete,
}: {
  draft: DraftPanel;
  catalog: SourceCatalogEntry[];
  focused: boolean;
  onFocus: () => void;
  onClose: () => void;
  onComplete: (
    input: CreatePanelInput,
    catalogIds?: string[],
    customSources?: PendingCustomSource[],
  ) => Promise<void>;
}) {
  const [step, setStep] = useState<"type" | "web" | "feed">("type");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [webName, setWebName] = useState("");
  const [webUrl, setWebUrl] = useState("");
  const [feedName, setFeedName] = useState("");
  const [defaultRefreshInterval, setDefaultRefreshInterval] = useState(60);
  const [query, setQuery] = useState("");
  const [selectedCatalog, setSelectedCatalog] = useState<Set<string>>(new Set());
  const [customInput, setCustomInput] = useState("");
  const [customConnectorKind, setCustomConnectorKind] =
    useState<ConnectorPreference>("auto");
  const [customSources, setCustomSources] = useState<PendingCustomSource[]>([]);
  const busy = pending || draft.pending;

  function queueCustomSource() {
    const url = customInput.trim();
    if (!url) return;
    setCustomSources((current) => {
      if (current.some((source) => source.url === url && source.connectorKind === customConnectorKind)) {
        return current;
      }
      return [...current, { url, connectorKind: customConnectorKind }];
    });
    setCustomInput("");
  }

  async function createWeb(name: string, url: string) {
    if (!url.trim() || busy) return;
    setPending(true);
    setError(null);
    try {
      await onComplete({
        kind: "web",
        name: name.trim() || hostLabel(url),
        url: url.trim(),
      });
    } catch (caught) {
      setError(cleanError(caught));
      setPending(false);
    }
  }

  async function createFeed(event: FormEvent) {
    event.preventDefault();
    const submittedCustomSources = [
      ...customSources,
      ...(customInput.trim()
        ? [{ url: customInput.trim(), connectorKind: customConnectorKind }]
        : []),
    ];
    if (selectedCatalog.size + submittedCustomSources.length === 0 || busy) {
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
        submittedCustomSources.filter(
          (source, index, all) =>
            all.findIndex(
              (candidate) =>
                candidate.url === source.url &&
                candidate.connectorKind === source.connectorKind,
            ) === index,
        ),
      );
    } catch (caught) {
      setError(cleanError(caught));
      setPending(false);
    }
  }

  const filteredCatalog = catalog.filter((entry) =>
    `${entry.name} ${entry.homepageUrl}`.toLowerCase().includes(query.toLowerCase()),
  );

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
        className="draft-panel"
        aria-busy={busy}
        inert={busy ? true : undefined}
      >
        {draft.pending && !pending && (
          <div className="panel-empty" role="status">
            <LoaderCircle className="is-spinning" size={20} />
            <strong>Installation de la veille concurrents…</strong>
            <span>Le Monde, Le Figaro et Le Parisien sont ajoutés à ce fil.</span>
          </div>
        )}
        {!draft.pending && step === "type" && (
          <div className="draft-step draft-step--type">
            <span className="step-kicker">Nouveau panel</span>
            <h2>Que voulez-vous afficher ici ?</h2>
            <div className="panel-type-grid">
              <button type="button" onClick={() => setStep("web")}>
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

        {!draft.pending && step === "web" && (
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
                  onClick={() => void createWeb(preset.name.split(" — ")[0], preset.url)}
                >
                  <span>
                    <strong>{preset.name}</strong>
                    <small>{preset.url}</small>
                  </span>
                  {preset.live && <em>● Direct</em>}
                </button>
              ))}
            </div>
            <span className="form-section-label">Ou coller une URL</span>
            <form
              className="inline-url-form"
              onSubmit={(event) => {
                event.preventDefault();
                void createWeb(webName, webUrl);
              }}
            >
              <input
                aria-label="Nom du panel web"
                value={webName}
                placeholder="Nom du panel (facultatif)"
                onChange={(event) => setWebName(event.target.value)}
              />
              <div>
                <input
                  aria-label="URL de la page web"
                  value={webUrl}
                  placeholder="bfmtv.com/en-direct"
                  inputMode="url"
                  onChange={(event) => setWebUrl(event.target.value)}
                />
                <button type="submit" className="primary-button" disabled={!webUrl.trim() || busy}>
                  {pending && <LoaderCircle className="is-spinning" size={13} />} Afficher
                </button>
              </div>
            </form>
            {error && <p className="form-error" role="alert">{error}</p>}
          </div>
        )}

        {!draft.pending && step === "feed" && (
          <form className="draft-step feed-builder" onSubmit={createFeed}>
            <button type="button" className="back-button" onClick={() => setStep("type")}>
              ‹ Type de panel
            </button>
            <h2>Fil agrégé</h2>
            <input
              className="name-input"
              aria-label="Nom du fil"
              value={feedName}
              placeholder="Nom du fil — ex. Économie"
              onChange={(event) => setFeedName(event.target.value)}
            />
            <label className="compact-select-field">
              <span>Actualisation par défaut</span>
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
            <span className="form-section-label">Bibliothèque de sources</span>
            <label className="search-input">
              <Search size={13} />
              <input
                aria-label="Rechercher une source"
                value={query}
                placeholder="Rechercher une source…"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div className="source-library">
              {filteredCatalog.map((entry) => {
                const checked = selectedCatalog.has(entry.id);
                return (
                  <button
                    type="button"
                    key={entry.id}
                    className={checked ? "is-selected" : ""}
                    aria-pressed={checked}
                    onClick={() =>
                      setSelectedCatalog((current) => {
                        const next = new Set(current);
                        if (next.has(entry.id)) next.delete(entry.id);
                        else next.add(entry.id);
                        return next;
                      })
                    }
                  >
                    <span className="checkbox">{checked && <Check size={10} />}</span>
                    <span>
                      <strong>{entry.name}</strong>
                      <small>{new URL(entry.homepageUrl).hostname.replace("www.", "")}</small>
                    </span>
                    <em>{connectorKindLabel(entry.connectorKind)}</em>
                  </button>
                );
              })}
            </div>
            <span className="form-section-label">Source personnalisée</span>
            <div className="custom-source-field">
              <div className="custom-source-input">
                <input
                  aria-label="URL de la source personnalisée"
                  value={customInput}
                  inputMode="url"
                  placeholder="URL du site ou du flux…"
                  onChange={(event) => setCustomInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      queueCustomSource();
                    }
                  }}
                />
                <button type="button" onClick={queueCustomSource}>
                  Ajouter
                </button>
              </div>
              <details className="connector-options">
                <summary>
                  Options avancées · {connectorKindLabel(customConnectorKind)}
                </summary>
                <label>
                  <span>Format du connecteur</span>
                  <select
                    value={customConnectorKind}
                    onChange={(event) =>
                      setCustomConnectorKind(event.target.value as ConnectorPreference)
                    }
                  >
                    {CONNECTOR_KIND_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </details>
            </div>
            {customSources.length > 0 && (
              <div className="custom-source-chips">
                {customSources.map((source) => (
                  <span key={`${source.connectorKind}:${source.url}`}>
                    {hostLabel(source.url)} · {connectorKindLabel(source.connectorKind)}
                    <button
                      type="button"
                      aria-label={`Retirer ${source.url}`}
                      onClick={() =>
                        setCustomSources((current) =>
                          current.filter(
                            (candidate) =>
                              candidate.url !== source.url ||
                              candidate.connectorKind !== source.connectorKind,
                          ),
                        )
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            {error && <p className="form-error" role="alert">{error}</p>}
            <div className="feed-builder__footer">
              <span>
                {selectedCatalog.size + customSources.length + (customInput.trim() ? 1 : 0)} source(s)
              </span>
              <button
                type="submit"
                className="primary-button"
                disabled={
                  selectedCatalog.size + customSources.length + (customInput.trim() ? 1 : 0) === 0 ||
                  busy
                }
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
  action: string;
  onAction: () => void;
}) {
  return (
    <div className="panel-empty">
      {icon}
      <strong>{title}</strong>
      <span>{body}</span>
      <button type="button" onClick={onAction}>
        {action}
      </button>
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

function Modal({ children, onDismiss }: { children: React.ReactNode; onDismiss: () => void }) {
  const layerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const frame = window.requestAnimationFrame(() => {
      const firstField = layerRef.current?.querySelector<HTMLElement>(
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

function PilotToolsModal({
  onClose,
  onImported,
  onToast,
  semanticStatus,
  onRemoveSemanticData,
}: {
  onClose: () => void;
  onImported: (state: AppState, backupCreated: boolean) => void;
  onToast: (message: string) => void;
  semanticStatus: SemanticSearchStatus;
  onRemoveSemanticData: () => Promise<void>;
}) {
  const [pending, setPending] = useState<"import" | "export" | "diagnostics" | "web" | "search" | null>(null);
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
        <div className="pilot-tools-list">
          <button
            type="button"
            disabled={Boolean(pending)}
            onClick={() =>
              void run("import", async () => {
                const result = await window.mediagen.importDashboard();
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
                const result = await window.mediagen.exportDashboard();
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
                const result = await window.mediagen.exportDiagnostics();
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
                await window.mediagen.clearWebData();
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
  const [customInput, setCustomInput] = useState("");
  const [customConnectorKind, setCustomConnectorKind] =
    useState<ConnectorPreference>("auto");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function queueCustomSource() {
    const url = customInput.trim();
    if (!url) return;
    setCustomSources((current) => {
      if (current.some((source) => source.url === url && source.connectorKind === customConnectorKind)) {
        return current;
      }
      return [...current, { url, connectorKind: customConnectorKind }];
    });
    setCustomInput("");
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || pending) return;
    setPending(true);
    setError(null);
    try {
      const submittedCustomSources = [
        ...customSources,
        ...(customInput.trim()
          ? [{ url: customInput.trim(), connectorKind: customConnectorKind }]
          : []),
      ];
      const nextState = await saveFeedPanelConfiguration(window.mediagen, panel, state, {
        name: name.trim(),
        defaultRefreshIntervalSeconds: defaultRefreshInterval,
        keptSourceIds: [...keptSourceIds],
        selectedCatalogIds: [...selectedCatalogIds],
        customSources: submittedCustomSources,
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
        <div className="modal-scroll">
          <label className="field">
            <span>Nom du panel</span>
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="compact-select-field compact-select-field--modal">
            <span>Actualisation par défaut des nouvelles sources</span>
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
          <span className="form-section-label">Sources actuelles</span>
          <div className="source-library source-library--current">
            {currentSources.map((source) => {
              const checked = keptSourceIds.has(source.id);
              return (
                <button
                  type="button"
                  key={source.id}
                  className={checked ? "is-selected" : ""}
                  aria-pressed={checked}
                  onClick={() => {
                    setKeptSourceIds((current) => {
                      const next = new Set(current);
                      if (next.has(source.id)) next.delete(source.id);
                      else next.add(source.id);
                      return next;
                    });
                  }}
                >
                  <span className="checkbox">{checked && <Check size={10} />}</span>
                  <span>
                    <strong>{source.name}</strong>
                    <small>
                      {connectorKindLabel(source.connectorKind)} · toutes les {refreshIntervalLabel(source.refreshIntervalSeconds)}
                    </small>
                  </span>
                  <i className={`source-dot source-dot--${source.status}`} />
                </button>
              );
            })}
          </div>
          <span className="form-section-label">Connecteurs disponibles</span>
          <div className="source-library">
            {state.sourceCatalog.map((entry) => {
              const alreadyAdded = currentSources.some(
                (source) => source.connectorId === entry.id && keptSourceIds.has(source.id),
              );
              const selected = selectedCatalogIds.has(entry.id);
              return (
                <button
                  type="button"
                  key={entry.id}
                  className={selected ? "is-selected" : alreadyAdded ? "is-added" : ""}
                  disabled={alreadyAdded}
                  aria-pressed={selected || alreadyAdded}
                  onClick={() =>
                    setSelectedCatalogIds((current) => {
                      const next = new Set(current);
                      if (next.has(entry.id)) next.delete(entry.id);
                      else next.add(entry.id);
                      return next;
                    })
                  }
                >
                  <span className="checkbox">
                    {(selected || alreadyAdded) && <Check size={10} />}
                  </span>
                  <span>
                    <strong>{entry.name}</strong>
                    <small>{hostLabel(entry.homepageUrl)}</small>
                  </span>
                  <em>{alreadyAdded ? "Ajouté" : connectorKindLabel(entry.connectorKind)}</em>
                </button>
              );
            })}
          </div>
          <span className="form-section-label">Ajouter une URL personnalisée</span>
          <div className="custom-source-field">
            <div className="custom-source-input">
              <input
                aria-label="URL de la source personnalisée"
                value={customInput}
                placeholder="URL du site ou du flux…"
                onChange={(event) => setCustomInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  queueCustomSource();
                }}
              />
              <button type="button" onClick={queueCustomSource}>
                Ajouter
              </button>
            </div>
            <details className="connector-options">
              <summary>Options avancées · {connectorKindLabel(customConnectorKind)}</summary>
              <label>
                <span>Format du connecteur</span>
                <select
                  value={customConnectorKind}
                  onChange={(event) =>
                    setCustomConnectorKind(event.target.value as ConnectorPreference)
                  }
                >
                  {CONNECTOR_KIND_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </details>
          </div>
          {customSources.length > 0 && (
            <div className="custom-source-chips">
              {customSources.map((source) => (
                <span key={`${source.connectorKind}:${source.url}`}>
                  {hostLabel(source.url)} · {connectorKindLabel(source.connectorKind)}
                  <button
                    type="button"
                    aria-label={`Retirer ${source.url}`}
                    onClick={() =>
                      setCustomSources((current) =>
                        current.filter(
                          (candidate) =>
                            candidate.url !== source.url ||
                            candidate.connectorKind !== source.connectorKind,
                        ),
                      )
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <footer>
          <button type="button" className="quiet-button" onClick={onClose} disabled={pending}>
            Annuler
          </button>
          <button type="submit" className="primary-button" disabled={!name.trim() || pending}>
            {pending && <LoaderCircle className="is-spinning" size={13} />} Enregistrer
          </button>
        </footer>
      </form>
    </Modal>
  );
}
