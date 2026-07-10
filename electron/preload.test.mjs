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
    send() {},
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

test("clearWebData always requests a full profile clear without exposing a raw scope", async () => {
  const { api, calls } = await loadPreloadApi();

  assert.equal(await api.clearWebData("cache"), undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "web-session:clear-data");
  assert.equal(calls[0][1].scope, "all");
  assert.deepEqual(Object.keys(calls[0][1]), ["scope"]);
});
