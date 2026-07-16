import { compareFeedItems } from "./feed-presentation.ts";
import { getAppStateItemDelta, type AppStateItemDeltaHint } from "./app-state-delta.ts";
import type {
  AppState,
  FeedItem,
  FeedPanel,
  LayoutNode,
  Panel,
  Source,
  SourceCatalogEntry,
} from "./types";

export type AppStoreDomain =
  | "dashboard"
  | "revision"
  | "panels"
  | "sources"
  | "sourceCatalog"
  | "items";

export interface FeedPanelStoreSnapshot {
  version: number;
  panel: FeedPanel | null;
  sources: Source[];
  items: FeedItem[];
}

export interface FeedPanelReadSnapshot {
  version: number;
  unseenCount: number;
}

export interface AppStoreChangeSummary {
  changed: boolean;
  onlyItemReadState: boolean;
  requiresRootProjection: boolean;
  itemMembershipChanged: boolean;
  changedDomains: ReadonlySet<AppStoreDomain>;
  changedPanelIds: ReadonlySet<string>;
  changedItemIds: ReadonlySet<string>;
  readStateItemIds: ReadonlySet<string>;
}

export interface AppStoreInstrumentation {
  applies: number;
  rootProjectionCommits: number;
  rootProjectionSkips: number;
  fullItemNormalizationPasses: number;
  fullItemEntitiesScanned: number;
  panelSnapshotFullBuilds: number;
  panelSnapshotBatchMerges: number;
  panelSnapshotItemsScanned: number;
  panelSnapshotItemsWritten: number;
  domainSignals: Record<AppStoreDomain, number>;
  panelSignals: Record<string, number>;
  itemSignals: Record<string, number>;
  lastChangedDomains: AppStoreDomain[];
  lastNotifiedPanelIds: string[];
  lastNotifiedItemIds: string[];
  lastOnlyItemReadState: boolean;
}

type EntityResult<T extends { id: string }> = {
  map: Map<string, T>;
  array: T[];
  changedIds: Set<string>;
  addedIds: Set<string>;
  removedIds: Set<string>;
  changed: boolean;
};

const DOMAINS: AppStoreDomain[] = [
  "dashboard",
  "revision",
  "panels",
  "sources",
  "sourceCatalog",
  "items",
];

const EMPTY_PANEL_SNAPSHOT: FeedPanelStoreSnapshot = Object.freeze({
  version: 0,
  panel: null,
  sources: [],
  items: [],
});

const EMPTY_PANEL_READ_SNAPSHOT: FeedPanelReadSnapshot = Object.freeze({
  version: 0,
  unseenCount: 0,
});

function sameArray<T>(first: readonly T[], second: readonly T[]) {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function sameLayout(first: LayoutNode | null, second: LayoutNode | null): boolean {
  if (first === second) return true;
  if (!first || !second || first.type !== second.type) return false;
  if (first.type === "panel" && second.type === "panel") return first.panelId === second.panelId;
  if (first.type !== "split" || second.type !== "split") return false;
  return (
    first.id === second.id &&
    first.direction === second.direction &&
    first.ratio === second.ratio &&
    sameLayout(first.children[0], second.children[0]) &&
    sameLayout(first.children[1], second.children[1])
  );
}

function sameFlatRecord(first: object, second: object) {
  const firstRecord = first as Record<string, unknown>;
  const secondRecord = second as Record<string, unknown>;
  const keys = Object.keys(firstRecord);
  return keys.length === Object.keys(secondRecord).length && keys.every(
    (key) => firstRecord[key] === secondRecord[key],
  );
}

function samePanel(first: Panel, second: Panel) {
  if (first.kind !== second.kind || first.id !== second.id || first.name !== second.name) return false;
  if (first.kind === "web" && second.kind === "web") return first.url === second.url;
  if (first.kind !== "feed" || second.kind !== "feed") return false;
  return (
    first.defaultRefreshIntervalSeconds === second.defaultRefreshIntervalSeconds &&
    sameArray(first.sourceIds, second.sourceIds)
  );
}

function sameCatalogEntry(first: SourceCatalogEntry, second: SourceCatalogEntry) {
  return (
    first.id === second.id &&
    first.name === second.name &&
    first.description === second.description &&
    first.homepageUrl === second.homepageUrl &&
    first.connectorKind === second.connectorKind &&
    first.refreshIntervalSeconds === second.refreshIntervalSeconds &&
    sameArray(first.capabilities, second.capabilities)
  );
}

function sameItemExceptReadState(first: FeedItem, second: FeedItem) {
  return (
    first.id === second.id &&
    first.sourceId === second.sourceId &&
    first.canonicalUrl === second.canonicalUrl &&
    first.title === second.title &&
    first.summary === second.summary &&
    first.imageUrl === second.imageUrl &&
    first.publishedAt === second.publishedAt &&
    first.updatedAt === second.updatedAt &&
    first.firstSeenAt === second.firstSeenAt &&
    first.observedAt === second.observedAt &&
    first.arrivalBatchAt === second.arrivalBatchAt &&
    first.lastSeenAt === second.lastSeenAt &&
    first.isBaseline === second.isBaseline &&
    first.isNew === second.isNew
  );
}

function normalizeEntities<T extends { id: string }>(
  incoming: readonly T[],
  previousMap: ReadonlyMap<string, T>,
  previousArray: readonly T[],
  equal: (first: T, second: T) => boolean,
): EntityResult<T> {
  const map = new Map<string, T>();
  const array: T[] = [];
  const changedIds = new Set<string>();
  const addedIds = new Set<string>();
  const removedIds = new Set(previousMap.keys());
  let changed = incoming.length !== previousArray.length;

  incoming.forEach((candidate, index) => {
    if (!candidate.id || map.has(candidate.id)) {
      throw new Error(`Projection normalisée invalide : identifiant dupliqué (${candidate.id || "vide"}).`);
    }
    const previous = previousMap.get(candidate.id);
    const entity = previous && equal(previous, candidate) ? previous : candidate;
    map.set(candidate.id, entity);
    array.push(entity);
    removedIds.delete(candidate.id);
    if (!previous) {
      addedIds.add(candidate.id);
      changedIds.add(candidate.id);
      changed = true;
    } else if (entity !== previous) {
      changedIds.add(candidate.id);
      changed = true;
    }
    if (previousArray[index]?.id !== candidate.id) changed = true;
  });

  for (const id of removedIds) changedIds.add(id);
  if (removedIds.size > 0) changed = true;
  return {
    map,
    array: changed ? array : previousArray as T[],
    changedIds,
    addedIds,
    removedIds,
    changed,
  };
}

function indexPanelsBySource(panels: readonly Panel[]) {
  const result = new Map<string, Set<string>>();
  for (const panel of panels) {
    if (panel.kind !== "feed") continue;
    for (const sourceId of panel.sourceIds) {
      const panelIds = result.get(sourceId);
      if (panelIds) panelIds.add(panel.id);
      else result.set(sourceId, new Set([panel.id]));
    }
  }
  return result;
}

function indexItemsBySource(items: readonly FeedItem[]) {
  const result = new Map<string, string[]>();
  for (const item of items) {
    const itemIds = result.get(item.sourceId);
    if (itemIds) itemIds.push(item.id);
    else result.set(item.sourceId, [item.id]);
  }
  return result;
}

function addPanelsForSource(
  target: Set<string>,
  index: ReadonlyMap<string, ReadonlySet<string>>,
  sourceId: string | undefined,
) {
  if (!sourceId) return;
  for (const panelId of index.get(sourceId) ?? []) target.add(panelId);
}

/**
 * A native patch carries at most 200 items. Remove its previous entities,
 * sort only the bounded additions, then merge them into the cached panel in
 * one pass: O(panel + patch log patch), with one output allocation per panel.
 */
function applyBoundedItemsToPanel(
  current: readonly FeedItem[],
  sourceIds: ReadonlySet<string>,
  changedItemIds: ReadonlySet<string>,
  previousItems: ReadonlyMap<string, FeedItem | undefined>,
  nextItems: ReadonlyMap<string, FeedItem>,
) {
  const removedItemIds = new Set<string>();
  const additions: FeedItem[] = [];
  for (const itemId of changedItemIds) {
    const before = previousItems.get(itemId);
    const after = nextItems.get(itemId);
    const wasIncluded = Boolean(before && sourceIds.has(before.sourceId));
    const isIncluded = Boolean(after && sourceIds.has(after.sourceId));
    if (!wasIncluded && !isIncluded) continue;
    if (wasIncluded) removedItemIds.add(itemId);
    if (isIncluded && after) additions.push(after);
  }
  if (removedItemIds.size === 0 && additions.length === 0) {
    return {
      items: current as FeedItem[],
      batchMerges: 0,
      itemsScanned: 0,
      itemsWritten: 0,
    };
  }

  additions.sort(compareFeedItems);
  const items: FeedItem[] = [];
  let currentIndex = 0;
  let additionIndex = 0;
  while (currentIndex < current.length || additionIndex < additions.length) {
    while (
      currentIndex < current.length &&
      removedItemIds.has(current[currentIndex].id)
    ) {
      currentIndex += 1;
    }
    if (currentIndex >= current.length) {
      while (additionIndex < additions.length) {
        items.push(additions[additionIndex]);
        additionIndex += 1;
      }
      break;
    }
    if (additionIndex >= additions.length) {
      while (currentIndex < current.length) {
        const item = current[currentIndex];
        currentIndex += 1;
        if (!removedItemIds.has(item.id)) items.push(item);
      }
      break;
    }
    if (compareFeedItems(current[currentIndex], additions[additionIndex]) <= 0) {
      items.push(current[currentIndex]);
      currentIndex += 1;
    } else {
      items.push(additions[additionIndex]);
      additionIndex += 1;
    }
  }
  return {
    items,
    batchMerges: 1,
    itemsScanned: current.length,
    itemsWritten: items.length,
  };
}

export class NormalizedAppStore {
  private projection: AppState | null = null;
  private lastInput: AppState | null = null;
  private panelsById = new Map<string, Panel>();
  private sourcesById = new Map<string, Source>();
  private catalogById = new Map<string, SourceCatalogEntry>();
  private itemsById = new Map<string, FeedItem>();
  private panelIdsBySource = new Map<string, Set<string>>();
  private itemIdsBySource = new Map<string, string[]>();
  private readonly domainVersions = new Map<AppStoreDomain, number>(
    DOMAINS.map((domain) => [domain, 0]),
  );
  private panelVersions = new Map<string, number>();
  private panelSnapshots = new Map<string, FeedPanelStoreSnapshot>();
  private panelReadVersions = new Map<string, number>();
  private panelReadSnapshots = new Map<string, FeedPanelReadSnapshot>();
  private readonly domainListeners = new Map<AppStoreDomain, Set<() => void>>();
  private readonly panelListeners = new Map<string, Set<() => void>>();
  private readonly panelReadListeners = new Map<string, Set<() => void>>();
  private readonly itemListeners = new Map<string, Set<() => void>>();
  private instrumentation: AppStoreInstrumentation = this.emptyInstrumentation();

  private emptyInstrumentation(): AppStoreInstrumentation {
    return {
      applies: 0,
      rootProjectionCommits: 0,
      rootProjectionSkips: 0,
      fullItemNormalizationPasses: 0,
      fullItemEntitiesScanned: 0,
      panelSnapshotFullBuilds: 0,
      panelSnapshotBatchMerges: 0,
      panelSnapshotItemsScanned: 0,
      panelSnapshotItemsWritten: 0,
      domainSignals: Object.fromEntries(DOMAINS.map((domain) => [domain, 0])) as Record<AppStoreDomain, number>,
      panelSignals: {},
      itemSignals: {},
      lastChangedDomains: [],
      lastNotifiedPanelIds: [],
      lastNotifiedItemIds: [],
      lastOnlyItemReadState: false,
    };
  }

  replace(next: AppState): AppStoreChangeSummary {
    const previous = this.projection;
    if (previous === next) return this.unchangedSummary();
    const itemDelta = getAppStateItemDelta(next);
    if (
      previous &&
      this.lastInput &&
      itemDelta &&
      this.lastInput.panels === next.panels &&
      this.lastInput.sourceCatalog === next.sourceCatalog &&
      sameLayout(this.lastInput.dashboard.layout, next.dashboard.layout)
    ) {
      const result = this.replaceBoundedItemDelta(next, itemDelta);
      this.lastInput = next;
      return result;
    }
    const previousPanelsById = this.panelsById;
    const previousSourcesById = this.sourcesById;
    const previousItemsById = this.itemsById;
    const previousPanelIdsBySource = this.panelIdsBySource;

    const panels = normalizeEntities(
      next.panels,
      this.panelsById,
      previous?.panels ?? next.panels,
      samePanel,
    );
    const sources = normalizeEntities(
      next.sources,
      this.sourcesById,
      previous?.sources ?? next.sources,
      sameFlatRecord,
    );
    const catalog = normalizeEntities(
      next.sourceCatalog,
      this.catalogById,
      previous?.sourceCatalog ?? next.sourceCatalog,
      sameCatalogEntry,
    );
    const itemInputIsUnchanged = Boolean(previous && this.lastInput?.items === next.items);
    const items: EntityResult<FeedItem> = itemInputIsUnchanged
      ? {
          map: this.itemsById,
          array: previous?.items ?? [],
          changedIds: new Set(),
          addedIds: new Set(),
          removedIds: new Set(),
          changed: false,
        }
      : normalizeEntities(
          next.items,
          this.itemsById,
          previous?.items ?? next.items,
          sameFlatRecord,
        );
    if (!itemInputIsUnchanged) {
      this.instrumentation.fullItemNormalizationPasses += 1;
      this.instrumentation.fullItemEntitiesScanned += next.items.length;
    }

    const dashboardChanged = !previous || !sameLayout(previous.dashboard.layout, next.dashboard.layout);
    const revisionChanged = !previous || previous.dashboard.revision !== next.dashboard.revision;
    const readStateItemIds = new Set<string>();
    const editorialItemIds = new Set<string>();
    for (const itemId of items.changedIds) {
      const before = previousItemsById.get(itemId);
      const after = items.map.get(itemId);
      if (before && after && sameItemExceptReadState(before, after)) readStateItemIds.add(itemId);
      else editorialItemIds.add(itemId);
    }
    const itemMembershipChanged = items.addedIds.size > 0 || items.removedIds.size > 0 ||
      [...editorialItemIds].some((itemId) => {
        const before = previousItemsById.get(itemId);
        const after = items.map.get(itemId);
        return before?.sourceId !== after?.sourceId;
      });

    const changedDomains = new Set<AppStoreDomain>();
    if (dashboardChanged) changedDomains.add("dashboard");
    if (revisionChanged) changedDomains.add("revision");
    if (panels.changed) changedDomains.add("panels");
    if (sources.changed) changedDomains.add("sources");
    if (catalog.changed) changedDomains.add("sourceCatalog");
    if (items.changed) changedDomains.add("items");

    const onlyItemReadState = Boolean(previous) && readStateItemIds.size > 0 &&
      editorialItemIds.size === 0 && !dashboardChanged && !panels.changed &&
      !sources.changed && !catalog.changed;
    const requiresRootProjection = !previous || dashboardChanged || panels.changed ||
      sources.changed || catalog.changed || editorialItemIds.size > 0 || itemMembershipChanged;
    const changed = changedDomains.size > 0;

    const nextPanelIdsBySource = panels.changed
      ? indexPanelsBySource(panels.array)
      : this.panelIdsBySource;
    const changedPanelIds = new Set<string>();
    const changedPanelReadIds = new Set<string>();
    for (const panelId of panels.changedIds) {
      changedPanelIds.add(panelId);
      const before = previousPanelsById.get(panelId);
      const after = panels.map.get(panelId);
      const sameFeedMembership = before?.kind === "feed" && after?.kind === "feed" &&
        sameArray(before.sourceIds, after.sourceIds);
      if (!sameFeedMembership) changedPanelReadIds.add(panelId);
    }
    for (const sourceId of sources.changedIds) {
      addPanelsForSource(changedPanelIds, previousPanelIdsBySource, sourceId);
      addPanelsForSource(changedPanelIds, nextPanelIdsBySource, sourceId);
    }
    for (const itemId of items.changedIds) {
      const before = previousItemsById.get(itemId);
      const after = items.map.get(itemId);
      addPanelsForSource(changedPanelIds, previousPanelIdsBySource, before?.sourceId);
      addPanelsForSource(changedPanelIds, nextPanelIdsBySource, after?.sourceId);
      if (!before || !after || before.sourceId !== after.sourceId || before.seenAt !== after.seenAt) {
        addPanelsForSource(changedPanelReadIds, previousPanelIdsBySource, before?.sourceId);
        addPanelsForSource(changedPanelReadIds, nextPanelIdsBySource, after?.sourceId);
      }
    }

    this.panelsById = panels.map;
    this.sourcesById = sources.map;
    this.catalogById = catalog.map;
    this.itemsById = items.map;
    this.panelIdsBySource = nextPanelIdsBySource;
    if (itemMembershipChanged || !previous) this.itemIdsBySource = indexItemsBySource(items.array);

    const layout = dashboardChanged ? next.dashboard.layout : previous?.dashboard.layout ?? null;
    this.projection = {
      dashboard: revisionChanged || dashboardChanged || !previous
        ? { layout, revision: next.dashboard.revision }
        : previous.dashboard,
      panels: panels.array,
      sources: sources.array,
      sourceCatalog: catalog.array,
      items: items.array,
      refreshedAt: next.refreshedAt,
    };

    for (const panelId of changedPanelIds) {
      if (changedPanelReadIds.has(panelId)) this.bumpPanelReadSnapshot(panelId);
      if (onlyItemReadState) continue;
      const version = (this.panelVersions.get(panelId) ?? 0) + 1;
      this.panelVersions.set(panelId, version);
      const cached = this.panelSnapshots.get(panelId);
      if (onlyItemReadState && cached?.panel) {
        const changedItems = readStateItemIds;
        this.panelSnapshots.set(panelId, {
          ...cached,
          version,
          items: cached.items.map((item) => changedItems.has(item.id)
            ? this.itemsById.get(item.id) ?? item
            : item),
        });
      } else if (cached?.panel && items.changedIds.size === 0) {
        const panel = this.panelsById.get(panelId);
        if (
          panel?.kind === "feed" &&
          sameArray(cached.panel.sourceIds, panel.sourceIds)
        ) {
          this.panelSnapshots.set(panelId, {
            version,
            panel,
            sources: panel.sourceIds
              .map((sourceId) => this.sourcesById.get(sourceId))
              .filter((source): source is Source => Boolean(source)),
            items: cached.items,
          });
        } else {
          this.panelSnapshots.delete(panelId);
        }
      } else {
        this.panelSnapshots.delete(panelId);
      }
    }

    this.instrumentation.applies += 1;
    this.instrumentation.lastChangedDomains = [...changedDomains];
    this.instrumentation.lastNotifiedPanelIds = [...changedPanelIds].sort();
    this.instrumentation.lastNotifiedItemIds = [...items.changedIds].sort();
    this.instrumentation.lastOnlyItemReadState = onlyItemReadState;
    if (changed) {
      for (const domain of changedDomains) this.notifyDomain(domain);
      if (!onlyItemReadState) {
        for (const panelId of changedPanelIds) this.notifyPanel(panelId);
      }
      for (const panelId of changedPanelReadIds) this.notifyPanelRead(panelId);
      for (const itemId of items.changedIds) this.notifyItem(itemId);
    }
    this.lastInput = next;
    return {
      changed,
      onlyItemReadState,
      requiresRootProjection,
      itemMembershipChanged,
      changedDomains,
      changedPanelIds,
      changedItemIds: items.changedIds,
      readStateItemIds,
    };
  }

  getAppState() {
    return this.projection;
  }

  getDomainVersion(domain: AppStoreDomain) {
    return this.domainVersions.get(domain) ?? 0;
  }

  getItem(itemId: string) {
    return this.itemsById.get(itemId) ?? null;
  }

  getFeedPanelSnapshot(panelId: string): FeedPanelStoreSnapshot {
    const cached = this.panelSnapshots.get(panelId);
    if (cached) return cached;
    const panel = this.panelsById.get(panelId);
    if (!panel || panel.kind !== "feed") return EMPTY_PANEL_SNAPSHOT;
    const sourceIds = new Set(panel.sourceIds);
    const sources = panel.sourceIds
      .map((sourceId) => this.sourcesById.get(sourceId))
      .filter((source): source is Source => Boolean(source));
    const items: FeedItem[] = [];
    for (const sourceId of sourceIds) {
      for (const itemId of this.itemIdsBySource.get(sourceId) ?? []) {
        const item = this.itemsById.get(itemId);
        if (item) items.push(item);
      }
    }
    this.instrumentation.panelSnapshotFullBuilds += 1;
    items.sort(compareFeedItems);
    const snapshot = {
      version: this.panelVersions.get(panelId) ?? 0,
      panel,
      sources,
      items,
    };
    this.panelSnapshots.set(panelId, snapshot);
    return snapshot;
  }

  getFeedPanelReadSnapshot(panelId: string): FeedPanelReadSnapshot {
    const cached = this.panelReadSnapshots.get(panelId);
    if (cached) return cached;
    const panel = this.panelsById.get(panelId);
    if (!panel || panel.kind !== "feed") return EMPTY_PANEL_READ_SNAPSHOT;
    let unseenCount = 0;
    for (const sourceId of new Set(panel.sourceIds)) {
      for (const itemId of this.itemIdsBySource.get(sourceId) ?? []) {
        if (this.itemsById.get(itemId)?.seenAt === null) unseenCount += 1;
      }
    }
    const snapshot = {
      version: this.panelReadVersions.get(panelId) ?? 0,
      unseenCount,
    };
    this.panelReadSnapshots.set(panelId, snapshot);
    return snapshot;
  }

  subscribeDomain(domain: AppStoreDomain, listener: () => void) {
    const listeners = this.domainListeners.get(domain) ?? new Set<() => void>();
    listeners.add(listener);
    this.domainListeners.set(domain, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.domainListeners.delete(domain);
    };
  }

  subscribePanel(panelId: string, listener: () => void) {
    const listeners = this.panelListeners.get(panelId) ?? new Set<() => void>();
    listeners.add(listener);
    this.panelListeners.set(panelId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.panelListeners.delete(panelId);
    };
  }

  subscribePanelRead(panelId: string, listener: () => void) {
    const listeners = this.panelReadListeners.get(panelId) ?? new Set<() => void>();
    listeners.add(listener);
    this.panelReadListeners.set(panelId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.panelReadListeners.delete(panelId);
    };
  }

  subscribeItem(itemId: string, listener: () => void) {
    const listeners = this.itemListeners.get(itemId) ?? new Set<() => void>();
    listeners.add(listener);
    this.itemListeners.set(itemId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.itemListeners.delete(itemId);
    };
  }

  recordRootProjection(rendered: boolean) {
    if (rendered) this.instrumentation.rootProjectionCommits += 1;
    else this.instrumentation.rootProjectionSkips += 1;
  }

  getInstrumentation(): AppStoreInstrumentation {
    return structuredClone(this.instrumentation);
  }

  resetInstrumentation() {
    this.instrumentation = this.emptyInstrumentation();
  }

  private notifyDomain(domain: AppStoreDomain) {
    this.domainVersions.set(domain, (this.domainVersions.get(domain) ?? 0) + 1);
    this.instrumentation.domainSignals[domain] += 1;
    for (const listener of this.domainListeners.get(domain) ?? []) listener();
  }

  private notifyPanel(panelId: string) {
    this.instrumentation.panelSignals[panelId] =
      (this.instrumentation.panelSignals[panelId] ?? 0) + 1;
    for (const listener of this.panelListeners.get(panelId) ?? []) listener();
  }

  private notifyPanelRead(panelId: string) {
    for (const listener of this.panelReadListeners.get(panelId) ?? []) listener();
  }

  private notifyItem(itemId: string) {
    this.instrumentation.itemSignals[itemId] =
      (this.instrumentation.itemSignals[itemId] ?? 0) + 1;
    for (const listener of this.itemListeners.get(itemId) ?? []) listener();
  }

  private bumpPanelReadSnapshot(panelId: string) {
    this.panelReadVersions.set(panelId, (this.panelReadVersions.get(panelId) ?? 0) + 1);
    this.panelReadSnapshots.delete(panelId);
  }

  private unchangedSummary(): AppStoreChangeSummary {
    return {
      changed: false,
      onlyItemReadState: false,
      requiresRootProjection: false,
      itemMembershipChanged: false,
      changedDomains: new Set(),
      changedPanelIds: new Set(),
      changedItemIds: new Set(),
      readStateItemIds: new Set(),
    };
  }

  private replaceBoundedItemDelta(
    next: AppState,
    hint: AppStateItemDeltaHint,
  ): AppStoreChangeSummary {
    const previous = this.projection;
    if (!previous) return this.unchangedSummary();
    const sources = normalizeEntities(
      next.sources,
      this.sourcesById,
      previous.sources,
      sameFlatRecord,
    );
    const upserts = new Map<string, FeedItem>();
    if (hint.itemUpserts.length + (hint.itemReadStates?.length ?? 0) > 200) {
      throw new Error("Delta normalisé invalide : lot supérieur à 200 articles.");
    }
    for (const item of hint.itemUpserts) {
      if (!item.id || upserts.has(item.id)) {
        throw new Error(`Delta normalisé invalide : identifiant dupliqué (${item.id || "vide"}).`);
      }
      upserts.set(item.id, item);
    }
    const seenReadStateIds = new Set<string>();
    for (const readState of hint.itemReadStates ?? []) {
      if (
        typeof readState.itemId !== "string" ||
        !readState.itemId ||
        seenReadStateIds.has(readState.itemId) ||
        !(readState.seenAt === null || typeof readState.seenAt === "string") ||
        !(readState.openedAt === null || typeof readState.openedAt === "string")
      ) {
        throw new Error(
          `Delta normalisé invalide : statut de lecture (${readState.itemId || "vide"}).`,
        );
      }
      seenReadStateIds.add(readState.itemId);
      // Search-only rows are deliberately absent from next.items, but an
      // applied search already hydrated them in this normalized entity map.
      const item = upserts.get(readState.itemId) ?? this.itemsById.get(readState.itemId);
      if (!item) continue;
      upserts.set(readState.itemId, {
        ...item,
        seenAt: readState.seenAt,
        openedAt: readState.openedAt,
      });
    }

    const changedItemIds = new Set<string>();
    const readStateItemIds = new Set<string>();
    const editorialItemIds = new Set<string>();
    const previousChangedItems = new Map<string, FeedItem | undefined>();
    const changedPanelIds = new Set<string>();
    const changedPanelReadIds = new Set<string>();
    const removedItemIdsBySource = new Map<string, Set<string>>();
    const addedItemIdsBySource = new Map<string, string[]>();
    let itemMembershipChanged = false;

    for (const sourceId of sources.changedIds) {
      addPanelsForSource(changedPanelIds, this.panelIdsBySource, sourceId);
    }

    for (const [itemId, item] of upserts) {
      const before = this.itemsById.get(itemId);
      if (before && sameFlatRecord(before, item)) continue;
      previousChangedItems.set(itemId, before);
      changedItemIds.add(itemId);
      this.itemsById.set(itemId, item);
      if (before && sameItemExceptReadState(before, item)) readStateItemIds.add(itemId);
      else editorialItemIds.add(itemId);
      if (!before || before.sourceId !== item.sourceId) {
        itemMembershipChanged = true;
        if (before) {
          const removedIds = removedItemIdsBySource.get(before.sourceId) ?? new Set<string>();
          removedIds.add(itemId);
          removedItemIdsBySource.set(before.sourceId, removedIds);
        }
        const addedIds = addedItemIdsBySource.get(item.sourceId) ?? [];
        addedIds.push(itemId);
        addedItemIdsBySource.set(item.sourceId, addedIds);
      }
      addPanelsForSource(changedPanelIds, this.panelIdsBySource, before?.sourceId);
      addPanelsForSource(changedPanelIds, this.panelIdsBySource, item.sourceId);
      if (!before || before.sourceId !== item.sourceId || before.seenAt !== item.seenAt) {
        addPanelsForSource(changedPanelReadIds, this.panelIdsBySource, before?.sourceId);
        addPanelsForSource(changedPanelReadIds, this.panelIdsBySource, item.sourceId);
      }
    }

    const membershipSourceIds = new Set([
      ...removedItemIdsBySource.keys(),
      ...addedItemIdsBySource.keys(),
    ]);
    for (const sourceId of membershipSourceIds) {
      const removedIds = removedItemIdsBySource.get(sourceId);
      const addedIds = addedItemIdsBySource.get(sourceId) ?? [];
      const currentIds = this.itemIdsBySource.get(sourceId) ?? [];
      const itemIds = removedIds
        ? currentIds.filter((itemId) => !removedIds.has(itemId))
        : [...currentIds];
      itemIds.push(...addedIds);
      this.itemIdsBySource.set(sourceId, itemIds);
    }

    const revisionChanged = previous.dashboard.revision !== next.dashboard.revision;
    if (changedItemIds.size === 0 && !revisionChanged && !sources.changed) {
      return this.unchangedSummary();
    }
    const onlyItemReadState = readStateItemIds.size > 0 && editorialItemIds.size === 0 &&
      !sources.changed;
    const changedDomains = new Set<AppStoreDomain>();
    if (revisionChanged) changedDomains.add("revision");
    if (sources.changed) changedDomains.add("sources");
    if (changedItemIds.size > 0) changedDomains.add("items");
    this.sourcesById = sources.map;
    this.projection = {
      ...previous,
      dashboard: revisionChanged
        ? { layout: previous.dashboard.layout, revision: next.dashboard.revision }
        : previous.dashboard,
      sources: sources.array,
      items: next.items,
      refreshedAt: next.refreshedAt,
    };

    for (const panelId of changedPanelIds) {
      if (changedPanelReadIds.has(panelId)) {
        const cachedRead = this.panelReadSnapshots.get(panelId);
        let unseenDelta = 0;
        for (const itemId of changedItemIds) {
          const after = this.itemsById.get(itemId);
          const before = previousChangedItems.get(itemId);
          const wasUnseen = Boolean(
            before &&
            before.seenAt === null &&
            this.panelIdsBySource.get(before.sourceId)?.has(panelId),
          );
          const isUnseen = Boolean(
            after &&
            after.seenAt === null &&
            this.panelIdsBySource.get(after.sourceId)?.has(panelId),
          );
          unseenDelta += Number(isUnseen) - Number(wasUnseen);
        }
        const version = (this.panelReadVersions.get(panelId) ?? 0) + 1;
        this.panelReadVersions.set(panelId, version);
        if (cachedRead) {
          this.panelReadSnapshots.set(panelId, {
            version,
            unseenCount: Math.max(0, cachedRead.unseenCount + unseenDelta),
          });
        } else {
          this.panelReadSnapshots.delete(panelId);
        }
      }
      if (!onlyItemReadState) {
        const panelVersion = (this.panelVersions.get(panelId) ?? 0) + 1;
        this.panelVersions.set(panelId, panelVersion);
        const cached = this.panelSnapshots.get(panelId);
        if (cached?.panel) {
          const patched = applyBoundedItemsToPanel(
            cached.items,
            new Set(cached.panel.sourceIds),
            changedItemIds,
            previousChangedItems,
            this.itemsById,
          );
          this.instrumentation.panelSnapshotBatchMerges += patched.batchMerges;
          this.instrumentation.panelSnapshotItemsScanned += patched.itemsScanned;
          this.instrumentation.panelSnapshotItemsWritten += patched.itemsWritten;
          this.panelSnapshots.set(panelId, {
            ...cached,
            version: panelVersion,
            sources: cached.panel.sourceIds
              .map((sourceId) => this.sourcesById.get(sourceId))
              .filter((source): source is Source => Boolean(source)),
            items: patched.items,
          });
        } else {
          this.panelSnapshots.delete(panelId);
        }
      }
    }

    this.instrumentation.applies += 1;
    this.instrumentation.lastChangedDomains = [...changedDomains];
    this.instrumentation.lastNotifiedPanelIds = [...changedPanelIds].sort();
    this.instrumentation.lastNotifiedItemIds = [...changedItemIds].sort();
    this.instrumentation.lastOnlyItemReadState = onlyItemReadState;
    for (const domain of changedDomains) this.notifyDomain(domain);
    if (!onlyItemReadState) {
      for (const panelId of changedPanelIds) this.notifyPanel(panelId);
    }
    for (const panelId of changedPanelReadIds) this.notifyPanelRead(panelId);
    for (const itemId of changedItemIds) this.notifyItem(itemId);
    return {
      changed: changedDomains.size > 0,
      onlyItemReadState,
      requiresRootProjection: sources.changed || editorialItemIds.size > 0 || itemMembershipChanged,
      itemMembershipChanged,
      changedDomains,
      changedPanelIds,
      changedItemIds,
      readStateItemIds,
    };
  }
}

export const normalizedAppStore = new NormalizedAppStore();

if (import.meta.env?.DEV && typeof window !== "undefined") {
  Object.defineProperty(window, "__VIBEDECK_STORE_DEBUG__", {
    value: () => normalizedAppStore.getInstrumentation(),
    configurable: true,
  });
}
