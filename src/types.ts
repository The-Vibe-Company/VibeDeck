export type ConnectorKind = "rss" | "atom" | "news-sitemap";
export type ConnectorPreference = "auto" | ConnectorKind;

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
  itemCount: number;
}

export interface SourceCatalogEntry {
  id: string;
  name: string;
  homepageUrl: string;
  connectorKind: ConnectorKind;
  refreshIntervalSeconds: number;
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
  refreshedAt: string;
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

export interface FeedConfigurationCustomSource {
  url: string;
  connectorKind: ConnectorPreference;
}

export interface FeedPanelConfigurationDraft {
  name: string;
  defaultRefreshIntervalSeconds: number;
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

export interface WebPanelDescriptor {
  panelId: string;
  url: string;
  bounds: WebPanelBounds;
  visible: boolean;
}

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
}

export interface LocalFileActionResult {
  canceled: boolean;
  filePath: string | null;
}

export interface LocalImportResult extends LocalFileActionResult {
  state: AppState | null;
  backupFilePath: string | null;
}

export interface MediaGenApi {
  getState: () => Promise<AppState>;
  createPanel: (
    input: string | CreatePanelInput,
    placement?: PanelPlacement,
  ) => Promise<AppState>;
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
  refreshAll: () => Promise<AppState>;
  markItemsSeen: (itemIds: string[]) => Promise<AppState>;
  markItemOpened: (itemId: string) => Promise<AppState>;
  exportDashboard: () => Promise<LocalFileActionResult>;
  importDashboard: () => Promise<LocalImportResult>;
  exportDiagnostics: () => Promise<LocalFileActionResult>;
  clearWebData: () => Promise<void>;
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
  setWebPanelMuted: (panelId: string, muted: boolean) => Promise<void>;
  onStateChanged: (callback: (state: AppState) => void) => () => void;
  onWebPanelStateChanged: (
    callback: (state: WebPanelRuntimeState) => void,
  ) => () => void;
  onWebPanelEscape: (callback: (panelId: string) => void) => () => void;
}
