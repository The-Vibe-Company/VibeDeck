import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadPreloadApi() {
  const calls = [];
  let exposedApi;
  const ipcRenderer = {
    invoke(channel, ...args) {
      calls.push([channel, ...args]);
      return Promise.resolve({ channel, args });
    },
    send(channel, ...args) {
      calls.push([channel, ...args]);
    },
    on() {},
    removeListener() {},
  };
  const contextBridge = {
    exposeInMainWorld(name, api) {
      assert.equal(name, "mediagen");
      exposedApi = api;
    },
  };
  const source = await readFile(new URL("./preload.cjs", import.meta.url), "utf8");
  vm.runInNewContext(source, {
    require(moduleName) {
      assert.equal(moduleName, "electron");
      return { contextBridge, ipcRenderer };
    },
  });
  return { api: exposedApi, calls };
}

test("exposes the pilot persistence and local-file IPC commands", async () => {
  const { api, calls } = await loadPreloadApi();

  await api.markItemsSeen(["item-1", "item-2"]);
  await api.markItemOpened("item-2");
  await api.exportDashboard();
  await api.importDashboard();
  await api.exportDiagnostics();
  assert.deepEqual(calls, [
    ["aggregator:mark-items-seen", ["item-1", "item-2"]],
    ["aggregator:mark-item-opened", "item-2"],
    ["aggregator:export-dashboard"],
    ["aggregator:import-dashboard"],
    ["aggregator:export-diagnostics"],
  ]);
});

test("forwards all catalog source arguments in the documented order", async () => {
  const { api, calls } = await loadPreloadApi();
  const options = { refreshIntervalSeconds: 180 };

  await api.addCatalogSource("panel-1", "le-monde", options);
  assert.deepEqual(calls, [
    ["aggregator:add-catalog-source", "panel-1", "le-monde", options],
  ]);
});

test("saves a feed configuration through one main-owned IPC operation", async () => {
  const { api, calls } = await loadPreloadApi();
  const draft = {
    name: "Économie",
    defaultRefreshIntervalSeconds: 60,
    keptSourceIds: ["source-1"],
    selectedCatalogIds: ["le-monde"],
    customSources: [{ url: "https://example.test/feed.xml", connectorKind: "rss" }],
  };

  await api.saveFeedPanelConfiguration("panel-1", draft);
  assert.deepEqual(calls, [
    ["aggregator:save-feed-panel-configuration", "panel-1", draft],
  ]);
  assert.equal(api.captureFeedPanelConfiguration, undefined);
  assert.equal(api.restoreFeedPanelConfiguration, undefined);
  assert.equal(api.releaseFeedPanelConfigurationCheckpoint, undefined);
});

test("clearWebData always requests a full profile clear without exposing a raw scope", async () => {
  const { api, calls } = await loadPreloadApi();

  assert.equal(await api.clearWebData("cache"), undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "web-session:clear-data");
  assert.equal(calls[0][1].scope, "all");
  assert.deepEqual(Object.keys(calls[0][1]), ["scope"]);
});

test("controls the original reader article through an item id only", async () => {
  const { api, calls } = await loadPreloadApi();

  await api.showOriginalArticle("item-42");
  await api.retryOriginalArticle("item-42");
  assert.deepEqual(calls, [
    ["reader:show-original", "item-42"],
    ["reader:retry-original", "item-42"],
  ]);
});

test("exposes only the narrow semantic-search IPC API", async () => {
  const { api, calls } = await loadPreloadApi();
  const request = { query: "inflation", scope: { kind: "all" }, mode: "hybrid" };

  await api.getSemanticSearchStatus();
  await api.prepareSemanticSearch();
  await api.cancelSemanticSearchPreparation();
  await api.searchFeedItems(request);
  await api.removeSemanticSearchData();
  api.finishSemanticSearchFocus(true);

  assert.deepEqual(calls, [
    ["semantic-search:get-status"],
    ["semantic-search:prepare"],
    ["semantic-search:cancel-preparation"],
    ["semantic-search:search", request],
    ["semantic-search:remove-data"],
    ["semantic-search:finish-focus", true],
  ]);
});
