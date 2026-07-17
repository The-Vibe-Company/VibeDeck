import assert from "node:assert/strict";
import test from "node:test";

import { saveFeedPanelConfiguration } from "../src/feed-settings.ts";
import { createFeedEngine } from "./feed-engine.mjs";

const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Source test</title><item>
  <title>Une actualité</title>
  <link>https://article.test/actualite</link>
  <pubDate>Thu, 09 Jul 2026 10:30:00 GMT</pubDate>
</item></channel></rss>`;

function response() {
  return new Response(RSS_FIXTURE, {
    headers: { "content-type": "application/rss+xml" },
  });
}

function draft(panel, overrides = {}) {
  return {
    name: panel.name,
    defaultRefreshIntervalSeconds: panel.defaultRefreshIntervalSeconds,
    keptSourceIds: [...panel.sourceIds],
    selectedCatalogIds: [],
    customSources: [],
    ...overrides,
  };
}

test("renderer helper delegates the complete draft through one API call", async () => {
  const panel = {
    id: "panel-target",
    kind: "feed",
    name: "Initial",
    sourceIds: [],
    defaultRefreshIntervalSeconds: 300,
  };
  const state = {
    dashboard: { layout: { type: "panel", panelId: panel.id }, revision: 1 },
    panels: [panel],
    sources: [],
    sourceCatalog: [],
    items: [],
    refreshedAt: "2026-07-10T12:00:00.000Z",
  };
  const submitted = draft(panel, { name: "Après" });
  const calls = [];
  const api = {
    async saveFeedPanelConfiguration(...args) {
      calls.push(args);
      return { ...state, panels: [{ ...panel, name: "Après" }] };
    },
  };

  const saved = await saveFeedPanelConfiguration(api, panel, state, submitted);

  assert.deepEqual(calls, [[panel.id, submitted]]);
  assert.equal(saved.panels[0].name, "Après");
});

test("restores shared source intervals and attachments after a later URL fails", async () => {
  const engine = createFeedEngine({
    fetchImpl: async (url) => {
      if (String(url).includes("broken.test")) throw new Error("panne injectée");
      return response();
    },
    now: () => new Date("2026-07-10T12:00:00.000Z"),
  });
  try {
    let currentState = await engine.createPanel({
      kind: "feed",
      name: "Voisin",
      defaultRefreshIntervalSeconds: 300,
    });
    const siblingId = currentState.panels[0].id;
    const shared = await engine.addSource(siblingId, {
      url: "https://shared.test/feed.xml",
      connectorKind: "rss",
      refreshIntervalSeconds: 300,
    });
    currentState = await engine.createPanel(
      { kind: "feed", name: "Cible", defaultRefreshIntervalSeconds: 600 },
      { targetPanelId: siblingId, side: "right" },
    );
    const target = currentState.panels.find(({ id }) => id !== siblingId);
    const current = await engine.addSource(target.id, {
      url: "https://current.test/feed.xml",
      connectorKind: "rss",
      refreshIntervalSeconds: 600,
    });
    currentState = current.state;
    const initialPanel = currentState.panels.find(({ id }) => id === target.id);

    await assert.rejects(
      engine.saveFeedPanelConfiguration(
        target.id,
        draft(initialPanel, {
          name: "Cible modifiée",
          defaultRefreshIntervalSeconds: 30,
          customSources: [
            { url: "https://shared.test/feed.xml", connectorKind: "rss" },
            { url: "https://broken.test/feed.xml", connectorKind: "rss" },
          ],
        }),
      ),
      /Aucune modification conservée/,
    );

    const restored = engine.getState();
    assert.deepEqual(
      restored.panels.find(({ id }) => id === target.id).sourceIds,
      [current.sourceId],
    );
    assert.deepEqual(
      restored.panels.find(({ id }) => id === siblingId).sourceIds,
      [shared.sourceId],
    );
    assert.equal(
      restored.sources.find(({ id }) => id === shared.sourceId)
        .refreshIntervalSeconds,
      300,
    );
    assert.equal(restored.panels.find(({ id }) => id === target.id).name, "Cible");
  } finally {
    engine.close();
  }
});

test("restores a null connector ID changed by a catalog add", async () => {
  const engine = createFeedEngine({
    fetchImpl: async (url) => {
      if (String(url).includes("broken.test")) throw new Error("panne injectée");
      return response();
    },
    now: () => new Date("2026-07-10T12:00:00.000Z"),
  });
  try {
    let currentState = await engine.createPanel({ kind: "feed", name: "Voisin" });
    const siblingId = currentState.panels[0].id;
    const monde = await engine.addCatalogSource(siblingId, "le-monde", {
      refreshIntervalSeconds: 300,
    });
    engine.database.database
      .prepare("UPDATE sources SET connector_id = NULL WHERE id = ?")
      .run(monde.sourceId);
    currentState = await engine.createPanel(
      { kind: "feed", name: "Cible", defaultRefreshIntervalSeconds: 30 },
      { targetPanelId: siblingId, side: "right" },
    );
    const target = currentState.panels.find(({ id }) => id !== siblingId);

    await assert.rejects(
      engine.saveFeedPanelConfiguration(
        target.id,
        draft(target, {
          selectedCatalogIds: ["le-monde"],
          customSources: [
            { url: "https://broken.test/feed.xml", connectorKind: "rss" },
          ],
        }),
      ),
      /Aucune modification conservée/,
    );

    assert.equal(engine.database.getSource(monde.sourceId).connectorId, null);
    assert.deepEqual(
      engine.getState().panels.find(({ id }) => id === target.id).sourceIds,
      [],
    );
  } finally {
    engine.close();
  }
});

test("restores an orphan cache interval invisible to renderer state", async () => {
  const engine = createFeedEngine({
    fetchImpl: async (url) => {
      if (String(url).includes("broken.test")) throw new Error("panne injectée");
      return response();
    },
    now: () => new Date("2026-07-10T12:00:00.000Z"),
  });
  try {
    let currentState = await engine.createPanel({
      kind: "feed",
      name: "Cible",
      defaultRefreshIntervalSeconds: 30,
    });
    const target = currentState.panels[0];
    const orphan = await engine.addSource(target.id, {
      url: "https://orphan.test/feed.xml",
      connectorKind: "rss",
      refreshIntervalSeconds: 300,
    });
    currentState = await engine.removeSource(target.id, orphan.sourceId);
    assert.equal(currentState.sources.some(({ id }) => id === orphan.sourceId), false);

    await assert.rejects(
      engine.saveFeedPanelConfiguration(
        target.id,
        draft(currentState.panels[0], {
          customSources: [
            { url: "https://orphan.test/feed.xml", connectorKind: "rss" },
            { url: "https://broken.test/feed.xml", connectorKind: "rss" },
          ],
        }),
      ),
      /Aucune modification conservée/,
    );

    assert.equal(
      engine.database.getSource(orphan.sourceId).refreshIntervalSeconds,
      300,
    );
    assert.deepEqual(engine.getState().panels[0].sourceIds, []);
  } finally {
    engine.close();
  }
});

test("rejects a concurrent save while the first network addition is pending", async () => {
  let releaseSlowFetch;
  let markSlowFetchStarted;
  const slowFetchStarted = new Promise((resolve) => {
    markSlowFetchStarted = resolve;
  });
  const engine = createFeedEngine({
    fetchImpl: async (url) => {
      if (!String(url).includes("slow.test")) return response();
      markSlowFetchStarted();
      return new Promise((resolve) => {
        releaseSlowFetch = () => resolve(response());
      });
    },
  });
  try {
    let currentState = await engine.createPanel({ kind: "feed", name: "Un" });
    const firstPanel = currentState.panels[0];
    currentState = await engine.createPanel(
      { kind: "feed", name: "Deux" },
      { targetPanelId: firstPanel.id, side: "right" },
    );
    const secondPanel = currentState.panels.find(({ id }) => id !== firstPanel.id);
    const firstSave = engine.saveFeedPanelConfiguration(
      firstPanel.id,
      draft(firstPanel, {
        customSources: [
          { url: "https://slow.test/feed.xml", connectorKind: "rss" },
        ],
      }),
    );
    await slowFetchStarted;

    await assert.rejects(
      engine.saveFeedPanelConfiguration(secondPanel.id, draft(secondPanel)),
      /déjà en cours/,
    );
    await assert.rejects(
      engine.renamePanel(secondPanel.id, "Mutation concurrente"),
      /déjà en cours/,
    );
    await assert.rejects(engine.deletePanel(firstPanel.id), /déjà en cours/);
    await assert.rejects(
      engine.addSource(secondPanel.id, {
        url: "https://other.test/feed.xml",
        connectorKind: "rss",
      }),
      /déjà en cours/,
    );
    releaseSlowFetch();
    const saved = await firstSave;
    assert.equal(
      saved.panels.find(({ id }) => id === firstPanel.id).sourceIds.length,
      1,
    );

    const secondSaved = await engine.saveFeedPanelConfiguration(
      secondPanel.id,
      draft(secondPanel, { name: "Deux après" }),
    );
    assert.equal(
      secondSaved.panels.find(({ id }) => id === secondPanel.id).name,
      "Deux après",
    );
  } finally {
    engine.close();
  }
});

test("rejects save while an earlier standalone source addition is pending", async () => {
  let releaseSlowFetch;
  let markSlowFetchStarted;
  const slowFetchStarted = new Promise((resolve) => {
    markSlowFetchStarted = resolve;
  });
  const engine = createFeedEngine({
    fetchImpl: async (url) => {
      if (!String(url).includes("slow-before-save.test")) return response();
      markSlowFetchStarted();
      return new Promise((resolve) => {
        releaseSlowFetch = () => resolve(response());
      });
    },
  });
  try {
    const initialState = await engine.createPanel({ kind: "feed", name: "Cible" });
    const panel = initialState.panels[0];
    const exportedConfiguration = engine.exportDashboardConfig();
    const adding = engine.addSource(panel.id, {
      url: "https://slow-before-save.test/feed.xml",
      connectorKind: "rss",
    });
    await slowFetchStarted;
    assert.equal(engine.activeStandaloneFeedConfigurationMutations, 1);

    await assert.rejects(
      engine.saveFeedPanelConfiguration(
        panel.id,
        draft(panel, { name: "Ne doit pas passer" }),
      ),
      /déjà en cours/,
    );
    await assert.rejects(engine.deletePanel(panel.id), /déjà en cours/);
    await assert.rejects(
      engine.renamePanel(panel.id, "Mutation concurrente"),
      /déjà en cours/,
    );
    await assert.rejects(
      engine.importDashboardConfig(exportedConfiguration),
      /déjà en cours/,
    );

    releaseSlowFetch();
    const added = await adding;
    assert.equal(engine.activeStandaloneFeedConfigurationMutations, 0);
    const currentPanel = added.state.panels[0];
    const saved = await engine.saveFeedPanelConfiguration(
      panel.id,
      draft(currentPanel, { name: "Après ajout" }),
    );
    assert.equal(saved.panels[0].name, "Après ajout");
    assert.deepEqual(saved.panels[0].sourceIds, [added.sourceId]);
  } finally {
    engine.close();
  }
});

test("releases the standalone source counter when a pending addition is cancelled", async () => {
  let markSlowFetchStarted;
  const slowFetchStarted = new Promise((resolve) => {
    markSlowFetchStarted = resolve;
  });
  const engine = createFeedEngine({
    fetchImpl: async (_url, init) => {
      markSlowFetchStarted();
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    },
  });
  try {
    const initialState = await engine.createPanel({ kind: "feed", name: "Cible" });
    const panel = initialState.panels[0];
    const adding = engine.addSource(panel.id, {
      url: "https://cancelled-standalone.test/feed.xml",
      connectorKind: "rss",
    });
    await slowFetchStarted;
    assert.equal(engine.activeStandaloneFeedConfigurationMutations, 1);

    engine.cancelPending();
    await assert.rejects(adding);
    assert.equal(engine.activeStandaloneFeedConfigurationMutations, 0);

    const saved = await engine.saveFeedPanelConfiguration(
      panel.id,
      draft(panel, { name: "Après annulation" }),
    );
    assert.equal(saved.panels[0].name, "Après annulation");
  } finally {
    engine.close();
  }
});

test("cancellation of a pending save restores exact pre-existing state", async () => {
  let markSlowFetchStarted;
  const slowFetchStarted = new Promise((resolve) => {
    markSlowFetchStarted = resolve;
  });
  const engine = createFeedEngine({
    fetchImpl: async (url, init) => {
      if (!String(url).includes("slow.test")) return response();
      markSlowFetchStarted();
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    },
  });
  try {
    let currentState = await engine.createPanel({
      kind: "feed",
      name: "Cible",
      defaultRefreshIntervalSeconds: 30,
    });
    const panel = currentState.panels[0];
    const orphan = await engine.addSource(panel.id, {
      url: "https://orphan.test/feed.xml",
      connectorKind: "rss",
      refreshIntervalSeconds: 300,
    });
    currentState = await engine.removeSource(panel.id, orphan.sourceId);

    const saving = engine.saveFeedPanelConfiguration(
      panel.id,
      draft(currentState.panels[0], {
        customSources: [
          { url: "https://orphan.test/feed.xml", connectorKind: "rss" },
          { url: "https://slow.test/feed.xml", connectorKind: "rss" },
        ],
      }),
    );
    await slowFetchStarted;
    assert.equal(
      engine.database.getSource(orphan.sourceId).refreshIntervalSeconds,
      30,
    );

    engine.cancelPending();
    await assert.rejects(saving, /Aucune modification conservée/);
    assert.equal(
      engine.database.getSource(orphan.sourceId).refreshIntervalSeconds,
      300,
    );
    assert.deepEqual(engine.getState().panels[0].sourceIds, []);
    assert.equal(engine.feedConfigurationSaveActive, false);
  } finally {
    engine.close();
  }
});

test("restores exact ordered attachments after a partial local removal", async () => {
  const engine = createFeedEngine({ fetchImpl: async () => response() });
  try {
    let currentState = await engine.createPanel({
      kind: "feed",
      name: "Initial",
      defaultRefreshIntervalSeconds: 300,
    });
    const panelId = currentState.panels[0].id;
    const sourceIds = [];
    for (const name of ["a", "b", "c"]) {
      const added = await engine.addSource(panelId, {
        url: `https://${name}.test/feed.xml`,
        connectorKind: "rss",
        refreshIntervalSeconds: 300,
      });
      sourceIds.push(added.sourceId);
      currentState = added.state;
    }
    const panel = currentState.panels[0];
    const replacePanelSources = engine.database.replacePanelSources.bind(engine.database);
    engine.database.replacePanelSources = (...args) => {
      replacePanelSources(...args);
      throw new Error("remplacement interrompu");
    };

    await assert.rejects(
      engine.saveFeedPanelConfiguration(
        panelId,
        draft(panel, {
          name: "Modifié",
          defaultRefreshIntervalSeconds: 30,
          keptSourceIds: [sourceIds[2]],
        }),
      ),
      /Aucune modification conservée : remplacement interrompu/,
    );

    const restored = engine.getState().panels[0];
    assert.equal(restored.name, "Initial");
    assert.equal(restored.defaultRefreshIntervalSeconds, 300);
    assert.deepEqual(restored.sourceIds, sourceIds);
    assert.equal(engine.feedConfigurationSaveActive, false);
  } finally {
    engine.close();
  }
});

test("keeps a newly fetched source only as a detached cache after rollback", async () => {
  const engine = createFeedEngine({
    fetchImpl: async (url) => {
      if (String(url).includes("broken.test")) throw new Error("panne injectée");
      return response();
    },
  });
  try {
    const currentState = await engine.createPanel({ kind: "feed", name: "Cible" });
    const panel = currentState.panels[0];
    await assert.rejects(
      engine.saveFeedPanelConfiguration(
        panel.id,
        draft(panel, {
          customSources: [
            { url: "https://new-cache.test/feed.xml", connectorKind: "rss" },
            { url: "https://broken.test/feed.xml", connectorKind: "rss" },
          ],
        }),
      ),
      /Aucune modification conservée/,
    );

    assert.deepEqual(engine.getState().panels[0].sourceIds, []);
    assert.equal(engine.getState().sources.length, 0);
    assert.ok(engine.database.findSourceByFeedUrl("https://new-cache.test/feed.xml"));
  } finally {
    engine.close();
  }
});

test("commits a successful save even when it lasts beyond five minutes", async () => {
  let nowMs = Date.parse("2026-07-10T12:00:00.000Z");
  const engine = createFeedEngine({ now: () => new Date(nowMs) });
  try {
    const initialState = await engine.createPanel({ kind: "feed", name: "Avant" });
    const panel = initialState.panels[0];
    const renamePanel = engine.database.renamePanel.bind(engine.database);
    engine.database.renamePanel = (...args) => {
      const result = renamePanel(...args);
      nowMs += 6 * 60 * 1_000;
      return result;
    };

    const saved = await engine.saveFeedPanelConfiguration(
      panel.id,
      draft(panel, { name: "Après" }),
    );

    assert.equal(saved.panels[0].name, "Après");
    assert.equal(engine.getState().panels[0].name, "Après");
    assert.equal(engine.feedConfigurationSaveActive, false);
  } finally {
    engine.close();
  }
});

test("restores every mutable source field after delayed discovery fails", async () => {
  let nowMs = Date.parse("2026-07-10T12:00:00.000Z");
  const engine = createFeedEngine({
    now: () => new Date(nowMs),
    fetchImpl: async (url) => {
      const endpoint = String(url);
      if (endpoint === "https://collision.test/") {
        return new Response(
          '<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head></html>',
          { headers: { "content-type": "text/html" } },
        );
      }
      if (endpoint === "https://collision.test/feed.xml") return response();
      if (endpoint === "https://broken.test/feed.xml") {
        nowMs += 6 * 60 * 1_000;
        throw new Error("panne injectée après expiration");
      }
      throw new Error(`URL inattendue : ${endpoint}`);
    },
  });
  try {
    let currentState = await engine.createPanel({ kind: "feed", name: "Voisin" });
    const siblingId = currentState.panels[0].id;
    const direct = await engine.addSource(siblingId, {
      url: "https://collision.test/feed.xml",
      connectorKind: "rss",
      refreshIntervalSeconds: 300,
    });
    currentState = await engine.createPanel(
      { kind: "feed", name: "Cible", defaultRefreshIntervalSeconds: 30 },
      { targetPanelId: siblingId, side: "right" },
    );
    const target = currentState.panels.find(({ id }) => id !== siblingId);
    const sourceConfiguration = () =>
      engine.database.database
        .prepare(`
          SELECT name, input_url, feed_url, connector_id, connector_kind,
            refresh_interval_seconds, updated_at
          FROM sources
          WHERE id = ?
        `)
        .get(direct.sourceId);
    const before = sourceConfiguration();

    await assert.rejects(
      engine.saveFeedPanelConfiguration(
        target.id,
        draft(target, {
          customSources: [
            { url: "https://collision.test/", connectorKind: "rss" },
            { url: "https://broken.test/feed.xml", connectorKind: "rss" },
          ],
        }),
      ),
      /Aucune modification conservée/,
    );

    assert.deepEqual(sourceConfiguration(), before);
    assert.deepEqual(
      engine.getState().panels.find(({ id }) => id === target.id).sourceIds,
      [],
    );
    assert.deepEqual(
      engine.getState().panels.find(({ id }) => id === siblingId).sourceIds,
      [direct.sourceId],
    );
  } finally {
    engine.close();
  }
});

test("keeps a current catalog source when it is explicitly reselected", async () => {
  const engine = createFeedEngine({ fetchImpl: async () => response() });
  try {
    let currentState = await engine.createPanel({ kind: "feed", name: "Cible" });
    const panelId = currentState.panels[0].id;
    const monde = await engine.addCatalogSource(panelId, "le-monde", {
      refreshIntervalSeconds: 300,
    });
    currentState = monde.state;
    const panel = currentState.panels[0];

    const saved = await engine.saveFeedPanelConfiguration(
      panelId,
      draft(panel, {
        keptSourceIds: [],
        selectedCatalogIds: ["le-monde"],
      }),
    );

    assert.deepEqual(saved.panels[0].sourceIds, [monde.sourceId]);
  } finally {
    engine.close();
  }
});

test("keeps a primary catalog cadence unless the configuration explicitly overrides it", async () => {
  const engine = createFeedEngine({ fetchImpl: async () => response() });
  try {
    let state = await engine.createPanel({
      kind: "feed",
      name: "Signaux",
      defaultRefreshIntervalSeconds: 60,
    });
    const panel = state.panels[0];
    state = await engine.saveFeedPanelConfiguration(
      panel.id,
      draft(panel, { selectedCatalogIds: ["cert-fr"] }),
    );
    assert.equal(
      state.sources.find(({ connectorId }) => connectorId === "cert-fr")
        .refreshIntervalSeconds,
      300,
    );

    state = await engine.saveFeedPanelConfiguration(
      panel.id,
      draft(state.panels[0], {
        keptSourceIds: [],
        selectedCatalogIds: ["cert-fr"],
        catalogRefreshIntervalSeconds: 60,
      }),
    );
    assert.equal(
      state.sources.find(({ connectorId }) => connectorId === "cert-fr")
        .refreshIntervalSeconds,
      60,
    );
  } finally {
    engine.close();
  }
});
