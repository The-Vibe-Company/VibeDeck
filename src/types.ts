export type ConnectorKind = "rss" | "atom" | "news-sitemap";
export type ConnectorPreference = "auto" | ConnectorKind;
export type SourceCatalogCapability = "optimized-feed" | "simplified-reading";

export type SourceStatus = "idle" | "refreshing" | "healthy" | "error";

export interface FeedItem {
  id: string;
  sourceId: string;
  canonicalUrl: string;
  title: string;
  summary: string | null;
  imageUrl: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  firstSeenAt: string;
  observedAt: string;
  /** Main-owned refresh cycle in which this article was first detected. */
  arrivalBatchAt: string;
  lastSeenAt: string;
  isBaseline: boolean;
  isNew: boolean;
  /** First deliberate acknowledgement in the monitoring UI. */
  seenAt: string | null;
  /** First time the original article was opened. */
  openedAt: string | null;
}

export interface Source {
  id: string;
  name: string;
  inputUrl: string;
  feedUrl: string;
  connectorId: string | null;
  connectorKind: ConnectorKind;
  refreshIntervalSeconds: number;
  status: SourceStatus;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  errorMessage: string | null;
  baselineCompletedAt: string | null;
  consecutiveFailures: number;
  nextRetryAt: string | null;
  arrivalRevision: number;
  itemCount: number;
}

export interface SourceCatalogEntry {
  id: string;
  name: string;
  description: string;
  sourceType: "media" | "primary";
  group: "france" | "english-world";
  category:
    | "general"
    | "local"
    | "business"
    | "sports"
    | "culture"
    | "public-decisions"
    | "data"
    | "alerts"
    | "research";
  rank: number;
  iconPath: string | null;
  homepageUrl: string;
  connectorKind: ConnectorKind;
  refreshIntervalSeconds: number;
  capabilities: SourceCatalogCapability[];
}

interface PanelBase {
  id: string;
  name: string;
}

export interface FeedPanel extends PanelBase {
  kind: "feed";
  sourceIds: string[];
  defaultRefreshIntervalSeconds: number;
}

export interface WebPanel extends PanelBase {
  kind: "web";
  url: string;
}

export type Panel = FeedPanel | WebPanel;

export type LayoutNode =
  | { type: "panel"; panelId: string }
  | {
      type: "split";
      id: string;
      direction: "row" | "column";
      ratio: number;
      children: [LayoutNode, LayoutNode];
    };

export interface DashboardState {
  layout: LayoutNode | null;
  revision: number;
}

export interface AppState {
  dashboard: DashboardState;
  panels: Panel[];
  sources: Source[];
  sourceCatalog: SourceCatalogEntry[];
  items: FeedItem[];
  contentRevision: number;
  arrivalRevision: number;
  refreshedAt: string;
}

export interface FeedPageRequest {
  panelId: string;
  sourceFilter: "all" | string;
  visibilityFilter: "all" | "unseen";
  offset: number;
  limit: number;
  anchorItemId?: string;
  focusedItemId?: string;
}

export interface FeedPage {
  revision: number;
  offset: number;
  queryTotalCount: number;
  panelTotalCount: number;
  panelUnseenCount: number;
  anchorIndex: number | null;
  previousItemDate: string | null;
  items: FeedItem[];
}

export type CreatePanelInput =
  | { kind: "feed"; name: string; defaultRefreshIntervalSeconds?: number }
  | { kind: "web"; name: string; url: string };

export interface PanelPlacement {
  targetPanelId: string;
  side: "left" | "right" | "top" | "bottom";
}

export interface AddSourceResult {
  sourceId: string;
  state: AppState;
}

export interface SourceRequest {
  url: string;
  connectorKind?: ConnectorPreference;
  refreshIntervalSeconds?: number;
}

export interface SourceProbeRequest {
  url: string;
  connectorKind?: ConnectorPreference;
}

export interface SourceProbeResult {
  normalizedInputUrl: string;
  name: string;
  connectorKind: ConnectorKind;
  connectorId: string | null;
  itemCount: number;
  samples: Array<{
    title: string;
    publishedAt: string | null;
  }>;
  freshness: "fresh" | "stale";
  warning: string | null;
}

export interface FeedConfigurationCustomSource {
  url: string;
  connectorKind: ConnectorPreference;
}

export interface FeedPanelConfigurationDraft {
  name: string;
  defaultRefreshIntervalSeconds: number;
  catalogRefreshIntervalSeconds?: number;
  keptSourceIds: string[];
  selectedCatalogIds: string[];
  customSources: FeedConfigurationCustomSource[];
}

export interface SourceAddOptions {
  refreshIntervalSeconds?: number;
}

export interface WebPanelBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WebPanelDescriptorBase {
  panelId: string;
  bounds: WebPanelBounds;
  visible: boolean;
}

export interface DashboardWebPanelDescriptor extends WebPanelDescriptorBase {
  kind: "web";
  url: string;
}

export interface ArticleReaderPanelDescriptor extends WebPanelDescriptorBase {
  kind: "reader";
  panelId: "reader:article";
  itemId: string;
}

export interface WebPreviewPanelDescriptor extends WebPanelDescriptorBase {
  kind: "preview";
}

export type WebPanelDescriptor =
  | DashboardWebPanelDescriptor
  | ArticleReaderPanelDescriptor
  | WebPreviewPanelDescriptor;

export type ReaderMode = "extracting" | "simplified" | "original";
export type ReaderFallbackReason =
  | "unsupported-source"
  | "paywalled"
  | "not-article"
  | "blocked"
  | "timeout"
  | "extraction-failed";

export interface WebPanelRuntimeState {
  panelId: string;
  status: "loading" | "ready" | "error" | "crashed" | "unresponsive" | "destroyed";
  homeUrl: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  muted: boolean;
  visible: boolean;
  requestedVisible: boolean;
  bounds: WebPanelBounds;
  error: string | null;
  errorCode: number | null;
  crashed: boolean;
  unresponsive: boolean;
  destroyed: boolean;
  readerMode: ReaderMode | null;
  readerFallback: ReaderFallbackReason | null;
}

export interface LocalFileActionResult {
  canceled: boolean;
  filePath: string | null;
}

export interface LocalImportResult extends LocalFileActionResult {
  state: AppState | null;
  backupFilePath: string | null;
}

export type UpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "downloading"
  | "ready"
  | "up-to-date"
  | "error";

export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  availableVersion: string | null;
  progressPercent: number | null;
  checkedAt: string | null;
  message: string | null;
}

export type SemanticSearchPhase =
  | "not-installed"
  | "downloading"
  | "indexing"
  | "ready"
  | "updating"
  | "error";

export interface SemanticSearchStatus {
  phase: SemanticSearchPhase;
  progress: number;
  message: string | null;
  bytes: number;
}

export type SemanticSearchScope = { kind: "all" } | { kind: "panel"; panelId: string };
export type SemanticSearchMode = "lexical" | "hybrid";

export interface SemanticSearchResult {
  items: FeedItem[];
  truncated: boolean;
  mode: SemanticSearchMode;
}

export interface VibeDeckApi {
  getState: () => Promise<AppState>;
  getFeedPage: (request: FeedPageRequest) => Promise<FeedPage>;
  getUpdateState: () => Promise<UpdateState>;
  checkForUpdates: () => Promise<UpdateState>;
  restartForUpdate: () => Promise<void>;
  createPanel: (
    input: string | CreatePanelInput,
    placement?: PanelPlacement,
  ) => Promise<AppState>;
  createFeedPanelWithSources: (
    operationId: string,
    input: Extract<CreatePanelInput, { kind: "feed" }>,
    placement: PanelPlacement | undefined,
    draft: FeedPanelConfigurationDraft,
  ) => Promise<AppState>;
  cancelFeedPanelCreation: (operationId: string) => Promise<void>;
  renamePanel: (panelId: string, name: string) => Promise<AppState>;
  setWebPanelUrl: (panelId: string, url: string) => Promise<AppState>;
  deletePanel: (panelId: string) => Promise<AppState>;
  saveDashboardLayout: (
    layout: LayoutNode | null,
    expectedRevision: number,
  ) => Promise<AppState>;
  addCatalogSource: (
    panelId: string,
    catalogId: string,
    options?: SourceAddOptions,
  ) => Promise<AddSourceResult>;
  probeSource: (
    probeId: string,
    source: string | SourceProbeRequest,
  ) => Promise<SourceProbeResult>;
  cancelSourceProbe: (probeId: string) => Promise<void>;
  addSource: (panelId: string, source: string | SourceRequest) => Promise<AddSourceResult>;
  setFeedPanelDefaultRefresh: (
    panelId: string,
    refreshIntervalSeconds: number,
  ) => Promise<AppState>;
  saveFeedPanelConfiguration: (
    panelId: string,
    draft: FeedPanelConfigurationDraft,
  ) => Promise<AppState>;
  removeSource: (panelId: string, sourceId: string) => Promise<AppState>;
  refreshSource: (sourceId: string) => Promise<AppState>;
  refreshPanel: (panelId: string) => Promise<AppState>;
  refreshAll: () => Promise<AppState>;
  markItemsSeen: (itemIds: string[]) => Promise<AppState>;
  markItemOpened: (itemId: string) => Promise<AppState>;
  getSemanticSearchStatus: () => Promise<SemanticSearchStatus>;
  prepareSemanticSearch: () => Promise<SemanticSearchStatus>;
  cancelSemanticSearchPreparation: () => Promise<void>;
  searchFeedItems: (request: {
    query: string;
    scope: SemanticSearchScope;
    mode: SemanticSearchMode;
  }) => Promise<SemanticSearchResult>;
  removeSemanticSearchData: () => Promise<void>;
  finishSemanticSearchFocus: (restoreNative: boolean) => void;
  exportDashboard: () => Promise<LocalFileActionResult>;
  importDashboard: () => Promise<LocalImportResult>;
  exportDiagnostics: () => Promise<LocalFileActionResult>;
  clearWebData: () => Promise<void>;
  startWebPreview: (
    previewId: string,
    url: string,
  ) => Promise<{ previewId: string; normalizedUrl: string }>;
  startXPreview: (
    previewId: string,
    url: string,
  ) => Promise<{ previewId: string; normalizedUrl: string }>;
  commitWebPreview: (
    previewId: string,
    name: string,
    placement?: PanelPlacement,
  ) => Promise<AppState>;
  cancelWebPreview: (previewId: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  focusDashboard: () => void;
  syncWebPanels: (panels: WebPanelDescriptor[]) => void;
  navigateWebPanel: (panelId: string, url: string) => Promise<void>;
  reloadWebPanel: (panelId: string) => Promise<void>;
  stopWebPanel: (panelId: string) => Promise<void>;
  goBackWebPanel: (panelId: string) => Promise<void>;
  goForwardWebPanel: (panelId: string) => Promise<void>;
  homeWebPanel: (panelId: string) => Promise<void>;
  openExternalWebPanel: (panelId: string) => Promise<void>;
  showOriginalArticle: (itemId: string) => Promise<void>;
  retryOriginalArticle: (itemId: string) => Promise<void>;
  setWebPanelMuted: (panelId: string, muted: boolean) => Promise<void>;
  onStateChanged: (callback: (state: AppState) => void) => () => void;
  onUpdateStateChanged: (callback: (state: UpdateState) => void) => () => void;
  onWebPanelStateChanged: (
    callback: (state: WebPanelRuntimeState) => void,
  ) => () => void;
  onWebPanelEscape: (callback: (panelId: string) => void) => () => void;
  onSemanticSearchStatusChanged: (
    callback: (status: SemanticSearchStatus) => void,
  ) => () => void;
  onOpenGlobalSearch: (callback: (nativeOrigin: boolean) => void) => () => void;
}
