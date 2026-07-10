import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  createLocalFeedDatabase,
  splitActiveUsageByLocalDay,
} from "./database.mjs";
import { createFeedEngine } from "./feed-engine.mjs";

const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Source test</title><item>
  <title>Une actualité</title>
  <link>https://source.test/article</link>
  <pubDate>Thu, 09 Jul 2026 10:30:00 GMT</pubDate>
</item></channel></rss>`;

const UPDATED_RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Source test</title>
<item>
  <title>Une actualité</title>
  <link>https://source.test/article</link>
  <pubDate>Thu, 09 Jul 2026 10:30:00 GMT</pubDate>
</item>
<item>
  <title>Une arrivée</title>
  <link>https://source.test/nouvelle</link>
  <pubDate>Thu, 09 Jul 2020 12:04:00 GMT</pubDate>
</item>
</channel></rss>`;

function response(body, { status = 200, headers = {} } = {}) {
  return new Response(body, { status, headers });
}

function layoutPanelIds(layout) {
  if (!layout) return [];
  if (layout.type === "panel") return [layout.panelId];
  return [...layoutPanelIds(layout.children[0]), ...layoutPanelIds(layout.children[1])];
}

function layoutForPanelIds(panelIds) {
  return panelIds.reduce((layout, panelId, index) => {
    const panel = { type: "panel", panelId };
    if (!layout) return panel;
    return {
      type: "split",
      id: `import-split-${index}`,
      direction: index % 2 === 0 ? "row" : "column",
      ratio: 0.5,
      children: [layout, panel],
    };
  }, null);
}

function temporaryDatabase() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "vibedeck-dashboard-"));
  return {
    databasePath: path.join(directory, "vibedeck.sqlite3"),
    cleanup: () => rmSync(directory, { force: true, recursive: true }),
  };
}

function createLegacyDatabase(databasePath) {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE panels (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE sources (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, input_url TEXT NOT NULL,
      feed_url TEXT NOT NULL UNIQUE,
      connector_kind TEXT NOT NULL CHECK (connector_kind IN ('rss', 'atom', 'news-sitemap')),
      refresh_interval_seconds INTEGER NOT NULL DEFAULT 300,
      status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'refreshing', 'healthy', 'error')),
      last_checked_at TEXT, last_success_at TEXT, error_message TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE panel_sources (
      panel_id TEXT NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      position INTEGER NOT NULL, PRIMARY KEY (panel_id, source_id)
    );
    CREATE TABLE items (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      canonical_url TEXT NOT NULL, title TEXT NOT NULL, summary TEXT, image_url TEXT,
      published_at TEXT, updated_at TEXT, first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL, UNIQUE (source_id, canonical_url)
    );
    CREATE INDEX items_source_date
      ON items(source_id, published_at DESC, first_seen_at DESC);
    CREATE TABLE endpoint_cache (
      endpoint TEXT PRIMARY KEY, body TEXT NOT NULL, content_type TEXT, etag TEXT,
      last_modified TEXT, fetched_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      status_code INTEGER NOT NULL DEFAULT 200
    );
  `);

  const now = "2026-07-09T12:00:00.000Z";
  const insertPanel = database.prepare(
    "INSERT INTO panels (id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  );
  insertPanel.run("panel-a", "Politique", 0, now, now);
  insertPanel.run("panel-b", "Économie", 1, now, now);
  insertPanel.run("panel-c", "International", 2, now, now);
  database
    .prepare(`
      INSERT INTO sources (
        id, name, input_url, feed_url, connector_kind, refresh_interval_seconds,
        status, last_checked_at, last_success_at, error_message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      "source-monde",
      "Le Monde",
      "https://www.lemonde.fr/",
      "https://www.lemonde.fr/rss/en_continu.xml",
      "rss",
      300,
      "healthy",
      now,
      now,
      null,
      now,
      now,
    );
  database
    .prepare("INSERT INTO panel_sources (panel_id, source_id, position) VALUES (?, ?, 0)")
    .run("panel-a", "source-monde");
  database
    .prepare(`
      INSERT INTO items (
        id, source_id, canonical_url, title, summary, image_url,
        published_at, updated_at, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      "item-1",
      "source-monde",
      "https://www.lemonde.fr/article",
      "Titre conservé",
      null,
      null,
      now,
      null,
      now,
      now,
    );
  database
    .prepare(`
      INSERT INTO endpoint_cache (
        endpoint, body, content_type, etag, last_modified, fetched_at, expires_at, status_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run("https://cache.test/feed", "cached", "application/xml", null, null, now, now, 200);
  database.close();
}

test("migrates every legacy panel into a feed layout without losing sources or articles", () => {
  const legacyNow = "2026-07-09T12:00:00.000Z";
  const { databasePath, cleanup } = temporaryDatabase();
  createLegacyDatabase(databasePath);
  const database = createLocalFeedDatabase(databasePath);
  try {
    const state = database.getState("2026-07-09T13:00:00.000Z");
    assert.deepEqual(
      state.panels.map(({ id, kind }) => [id, kind]),
      [
        ["panel-a", "feed"],
        ["panel-b", "feed"],
        ["panel-c", "feed"],
      ],
    );
    assert.deepEqual(layoutPanelIds(state.dashboard.layout).sort(), [
      "panel-a",
      "panel-b",
      "panel-c",
    ]);
    assert.equal(state.dashboard.revision, 0);
    assert.equal(state.sources[0].id, "source-monde");
    assert.equal(state.sources[0].connectorId, "le-monde");
    assert.equal(state.items[0].title, "Titre conservé");
    assert.equal(
      database.getEndpointCache("https://cache.test/feed").finalUrl,
      "https://cache.test/feed",
    );
    assert.equal(database.database.prepare("PRAGMA user_version").get().user_version, 6);
    assert.deepEqual(
      database.database.prepare("PRAGMA table_info(panels)").all().map(({ name }) => name),
      [
        "id",
        "name",
        "position",
        "created_at",
        "updated_at",
        "kind",
        "web_url",
        "default_refresh_interval_seconds",
      ],
    );
    assert.equal(state.panels[0].defaultRefreshIntervalSeconds, 60);
    assert.equal(state.items[0].isBaseline, true);
    assert.equal(state.items[0].isNew, false);
    assert.equal(state.items[0].seenAt, legacyNow);
    assert.equal(state.items[0].openedAt, null);
    assert.equal(state.items[0].observedAt, legacyNow);
    assert.equal(state.sources[0].baselineCompletedAt, legacyNow);
    assert.equal(state.sources[0].consecutiveFailures, 0);
    assert.equal(state.sources[0].nextRetryAt, null);
    const sourceColumns = database.database
      .prepare("PRAGMA table_info(sources)")
      .all()
      .map(({ name }) => name);
    assert.equal(sourceColumns.includes("baseline_completed_at"), true);
    assert.equal(sourceColumns.includes("consecutive_failures"), true);
    assert.equal(sourceColumns.includes("next_retry_at"), true);
    const itemColumns = database.database
      .prepare("PRAGMA table_info(items)")
      .all()
      .map(({ name }) => name);
    assert.equal(itemColumns.includes("is_baseline"), true);
    assert.equal(itemColumns.includes("seen_at"), true);
    assert.equal(itemColumns.includes("opened_at"), true);
    assert.deepEqual(
      database.database
        .prepare("PRAGMA table_info(pilot_sessions)")
        .all()
        .map(({ name }) => name),
      [
        "id",
        "started_at",
        "last_heartbeat_at",
        "ended_at",
        "active_duration_ms",
        "last_heartbeat_active",
        "status",
      ],
    );
  } finally {
    database.close();
    cleanup();
  }
});

test("upgrades a version 4 database through daily pilot usage without changing its dashboard", () => {
  const { databasePath, cleanup } = temporaryDatabase();
  const initial = createLocalFeedDatabase(databasePath);
  const panel = initial.createPanel(
    { kind: "feed", name: "Dashboard v4" },
    null,
    "2026-07-09T10:00:00.000Z",
  );
  initial.close();

  const versionFour = new DatabaseSync(databasePath);
  versionFour.exec(`
    DROP TABLE pilot_sessions;
    PRAGMA user_version = 4;
  `);
  versionFour.close();

  const migrated = createLocalFeedDatabase(databasePath);
  try {
    assert.equal(migrated.database.prepare("PRAGMA user_version").get().user_version, 6);
    assert.equal(migrated.getState().panels[0].id, panel.id);
    assert.equal(
      migrated.database
        .prepare("SELECT COUNT(*) AS count FROM pilot_sessions")
        .get().count,
      0,
    );
  } finally {
    migrated.close();
    cleanup();
  }
});

test("migrates version 5 session totals to their local start day without losing counters", () => {
  const { databasePath, cleanup } = temporaryDatabase();
  const initial = createLocalFeedDatabase(databasePath, { usageTimeZone: "Europe/Paris" });
  initial.close();

  const versionFive = new DatabaseSync(databasePath);
  versionFive.exec(`
    DROP TABLE pilot_usage_days;
    DROP TABLE pilot_usage_rollup;
    DELETE FROM pilot_sessions;
    INSERT INTO pilot_sessions (
      id, started_at, last_heartbeat_at, ended_at,
      active_duration_ms, last_heartbeat_active, status
    ) VALUES
      ('legacy-closed', '2026-07-09T22:30:00.000Z', '2026-07-09T23:00:00.000Z',
        '2026-07-09T23:00:00.000Z', 900000, 0, 'closed'),
      ('legacy-interrupted', '2026-07-10T21:30:00.000Z', '2026-07-10T22:30:00.000Z',
        '2026-07-10T22:30:00.000Z', 120000, 0, 'interrupted'),
      ('legacy-active', '2026-07-11T22:30:00.000Z', '2026-07-11T22:31:00.000Z',
        NULL, 30000, 1, 'active');
    PRAGMA user_version = 5;
  `);
  versionFive.close();

  const migrated = createLocalFeedDatabase(databasePath, {
    usageTimeZone: "Europe/Paris",
  });
  try {
    assert.equal(migrated.database.prepare("PRAGMA user_version").get().user_version, 6);
    const diagnostics = migrated.getPilotDiagnostics("2026-07-12T08:00:00.000Z");
    assert.deepEqual(diagnostics.usage, {
      totalActiveDurationMs: 1_050_000,
      sessionCount: 3,
      closedSessions: 1,
      interruptedSessions: 1,
      activeSessions: 1,
      recentDays: [
        {
          date: "2026-07-12",
          activeDurationMs: 30_000,
          sessionCount: 1,
          closedSessions: 0,
          interruptedSessions: 0,
        },
        {
          date: "2026-07-11",
          activeDurationMs: 0,
          sessionCount: 0,
          closedSessions: 0,
          interruptedSessions: 1,
        },
        {
          date: "2026-07-10",
          activeDurationMs: 1_020_000,
          sessionCount: 2,
          closedSessions: 1,
          interruptedSessions: 0,
        },
      ],
    });
    assert.equal(
      migrated.database
        .prepare("SELECT SUM(active_duration_ms) AS total FROM pilot_usage_days")
        .get().total,
      1_050_000,
    );
  } finally {
    migrated.close();
    cleanup();
  }
});

test("creates, splits, resizes and removes feed and web panels with revisions", async () => {
  const engine = createFeedEngine();
  try {
    assert.deepEqual(engine.getState().dashboard, { layout: null, revision: 0 });
    assert.deepEqual(engine.getState().panels, []);

    let state = await engine.createPanel({ kind: "feed", name: "Actualités" });
    const feedPanel = state.panels[0];
    assert.equal(feedPanel.kind, "feed");
    assert.equal(feedPanel.defaultRefreshIntervalSeconds, 60);
    assert.deepEqual(state.dashboard.layout, { type: "panel", panelId: feedPanel.id });

    state = await engine.createPanel(
      { kind: "web", name: "BFM TV", url: "https://www.bfmtv.com/" },
      { targetPanelId: feedPanel.id, side: "right" },
    );
    const webPanel = state.panels.find(({ kind }) => kind === "web");
    assert.equal(webPanel.url, "https://www.bfmtv.com/");
    assert.equal(state.dashboard.layout.type, "split");
    assert.equal(state.dashboard.layout.direction, "row");
    assert.deepEqual(layoutPanelIds(state.dashboard.layout), [feedPanel.id, webPanel.id]);

    const resized = { ...state.dashboard.layout, ratio: 0.63 };
    const saved = await engine.saveDashboardLayout(resized, state.dashboard.revision);
    assert.equal(saved.dashboard.layout.ratio, 0.63);
    assert.equal(saved.dashboard.revision, state.dashboard.revision + 1);
    await assert.rejects(
      engine.saveDashboardLayout(resized, state.dashboard.revision),
      (error) => error.code === "DASHBOARD_REVISION_CONFLICT",
    );

    state = await engine.setWebPanelUrl(webPanel.id, "https://www.bfmtv.com/en-direct/");
    assert.equal(state.panels.find(({ id }) => id === webPanel.id).url, "https://www.bfmtv.com/en-direct/");
    await assert.rejects(
      engine.addSource(webPanel.id, "https://source.test/feed.xml"),
      /Panel de flux/,
    );

    state = await engine.deletePanel(feedPanel.id);
    assert.deepEqual(state.dashboard.layout, { type: "panel", panelId: webPanel.id });
    state = await engine.deletePanel(webPanel.id);
    assert.deepEqual(state.dashboard.layout, null);
    assert.deepEqual(state.panels, []);
  } finally {
    engine.close();
  }
});

test("rejects incomplete, duplicated and malformed dashboard layouts", async () => {
  const engine = createFeedEngine();
  try {
    let state = await engine.createPanel("Un");
    const firstId = state.panels[0].id;
    state = await engine.createPanel("Deux");
    const secondId = state.panels[1].id;
    const revision = state.dashboard.revision;

    await assert.rejects(
      engine.saveDashboardLayout({ type: "panel", panelId: firstId }, revision),
      /chaque panel/,
    );
    await assert.rejects(
      engine.saveDashboardLayout(
        {
          type: "split",
          id: "duplicate",
          direction: "row",
          ratio: 0.5,
          children: [
            { type: "panel", panelId: firstId },
            { type: "panel", panelId: firstId },
          ],
        },
        revision,
      ),
      /qu’une fois/,
    );
    await assert.rejects(
      engine.saveDashboardLayout(
        {
          type: "split",
          id: "bad-ratio",
          direction: "column",
          ratio: 1,
          children: [
            { type: "panel", panelId: firstId },
            { type: "panel", panelId: secondId },
          ],
        },
        revision,
      ),
      /Ratio/,
    );
    assert.equal(engine.getState().dashboard.revision, revision);
  } finally {
    engine.close();
  }
});

test("keeps every dashboard within three practical rows and columns", async () => {
  const engine = createFeedEngine();
  try {
    let state = await engine.createPanel("Un");
    let targetPanelId = state.panels[0].id;
    for (const name of ["Deux", "Trois"]) {
      state = await engine.createPanel(
        { kind: "feed", name },
        { targetPanelId, side: "right" },
      );
      targetPanelId = state.panels.find((panel) => panel.name === name).id;
    }
    await assert.rejects(
      engine.createPanel(
        { kind: "feed", name: "Quatre" },
        { targetPanelId, side: "right" },
      ),
      /au maximum 3 panels/,
    );
    assert.equal(engine.getState().panels.length, 3);
  } finally {
    engine.close();
  }
});

test("atomically restores an exact feed configuration and shared source intervals", () => {
  const database = createLocalFeedDatabase();
  const now = "2026-07-10T12:00:00.000Z";
  try {
    const target = database.createPanel(
      {
        kind: "feed",
        name: "Configuration initiale",
        defaultRefreshIntervalSeconds: 300,
      },
      null,
      now,
    );
    const sibling = database.createPanel(
      { kind: "feed", name: "Panel voisin", defaultRefreshIntervalSeconds: 300 },
      { targetPanelId: target.id, side: "right" },
      now,
    );
    const putSource = (id, refreshIntervalSeconds) => database.putSource({
      id,
      name: id,
      inputUrl: `https://${id}.test/feed.xml`,
      feedUrl: `https://${id}.test/feed.xml`,
      connectorId: null,
      connectorKind: "rss",
      refreshIntervalSeconds,
      status: "healthy",
      lastCheckedAt: now,
      lastSuccessAt: now,
      errorMessage: null,
    }, now);
    const sourceA = putSource("source-a", 300);
    const sourceB = putSource("source-b", 600);
    const sharedSource = putSource("source-shared", 300);
    database.attachSource(target.id, sourceA);
    database.attachSource(target.id, sourceB);
    database.attachSource(sibling.id, sharedSource);

    const checkpoint = database.captureFeedPanelConfiguration(target.id);
    assert.deepEqual(checkpoint.sourceIds, [sourceA, sourceB]);
    assert.deepEqual(
      checkpoint.sourceConfigurations.map(({ sourceId }) => sourceId),
      [sourceA, sourceB, sharedSource],
    );

    database.renamePanel(target.id, "Configuration partielle", now);
    database.setFeedPanelDefaultRefresh(target.id, 30, now);
    database.detachSource(target.id, sourceA);
    database.attachSource(target.id, sharedSource);
    database.setSourceRefreshInterval(sharedSource, 30, now);
    database.setSourceConnectorId(sharedSource, "le-monde", now);
    const partialState = database.getState(now);

    database.database.exec(`
      CREATE TRIGGER fail_feed_configuration_restore
      BEFORE UPDATE OF refresh_interval_seconds ON sources
      WHEN NEW.id = '${sourceB}'
      BEGIN
        SELECT RAISE(ABORT, 'restauration injectée');
      END;
    `);
    assert.throws(
      () => database.restoreFeedPanelConfiguration(target.id, checkpoint, now),
      /restauration injectée/,
    );
    assert.deepEqual(database.getState(now), partialState);
    database.database.exec("DROP TRIGGER fail_feed_configuration_restore");

    database.restoreFeedPanelConfiguration(target.id, checkpoint, now);
    const restored = database.getState(now);
    const restoredPanel = restored.panels.find(({ id }) => id === target.id);
    assert.equal(restoredPanel.name, "Configuration initiale");
    assert.equal(restoredPanel.defaultRefreshIntervalSeconds, 300);
    assert.deepEqual(restoredPanel.sourceIds, [sourceA, sourceB]);
    assert.equal(
      restored.sources.find(({ id }) => id === sharedSource).refreshIntervalSeconds,
      300,
    );
    assert.equal(restored.sources.find(({ id }) => id === sharedSource).connectorId, null);
    assert.deepEqual(
      restored.panels.find(({ id }) => id === sibling.id).sourceIds,
      [sharedSource],
    );
  } finally {
    database.close();
  }
});

test("fails closed before editing when a feed checkpoint would exceed its bound", () => {
  const database = createLocalFeedDatabase();
  const now = "2026-07-10T12:00:00.000Z";
  try {
    const panel = database.createPanel({ kind: "feed", name: "Borne" }, null, now);
    const insert = database.database.prepare(`
      INSERT INTO sources (
        id, name, input_url, feed_url, connector_kind,
        refresh_interval_seconds, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'rss', 300, 'idle', ?, ?)
    `);
    database.database.exec("BEGIN IMMEDIATE;");
    try {
      for (let index = 0; index <= 4_096; index += 1) {
        const id = `checkpoint-overflow-${index}`;
        const url = `https://overflow-${index}.test/feed.xml`;
        insert.run(id, id, url, url, now, now);
      }
      database.database.exec("COMMIT;");
    } catch (error) {
      database.database.exec("ROLLBACK;");
      throw error;
    }
    assert.throws(
      () => database.captureFeedPanelConfiguration(panel.id),
      /trop de sources/,
    );
    assert.equal(database.getState(now).panels[0].name, "Borne");
  } finally {
    database.close();
  }
});

test("exposes the optimized source catalogue and reuses its connector", async () => {
  let fetchCount = 0;
  const engine = createFeedEngine({
    fetchImpl: async (url) => {
      assert.equal(url, "https://www.lemonde.fr/rss/en_continu.xml");
      fetchCount += 1;
      return response(RSS_FIXTURE, { headers: { "content-type": "application/rss+xml" } });
    },
  });
  try {
    let state = engine.getState();
    assert.deepEqual(state.sourceCatalog.map(({ id }) => id), [
      "le-monde",
      "le-figaro",
      "le-parisien",
    ]);
    assert.equal(Object.hasOwn(state.sourceCatalog[0], "feedUrl"), false);

    state = await engine.createPanel({ kind: "feed", name: "Une" });
    const firstPanel = state.panels[0];
    const first = await engine.addCatalogSource(firstPanel.id, "le-monde");
    assert.equal(first.state.sources[0].connectorId, "le-monde");
    assert.equal(fetchCount, 1);

    state = await engine.createPanel({ kind: "feed", name: "Politique" });
    const secondPanel = state.panels.find(({ name }) => name === "Politique");
    const second = await engine.addCatalogSource(secondPanel.id, "le-monde");
    assert.equal(second.sourceId, first.sourceId);
    assert.equal(fetchCount, 1);
    assert.deepEqual(second.state.panels.find(({ id }) => id === secondPanel.id).sourceIds, [
      first.sourceId,
    ]);
  } finally {
    engine.close();
  }
});

test("keeps orphaned sources and articles cached for an offline reattach", async () => {
  let fetchCount = 0;
  let online = true;
  const engine = createFeedEngine({
    fetchImpl: async () => {
      fetchCount += 1;
      if (!online) throw new Error("offline");
      return response(RSS_FIXTURE, { headers: { "content-type": "application/rss+xml" } });
    },
  });
  try {
    let state = await engine.createPanel({ kind: "feed", name: "Cache" });
    const panelId = state.panels[0].id;
    const added = await engine.addSource(panelId, "https://source.test/feed.xml");
    assert.equal(fetchCount, 1);

    state = await engine.removeSource(panelId, added.sourceId);
    assert.deepEqual(state.sources, []);
    assert.deepEqual(state.items, []);
    assert.equal(engine.database.getSource(added.sourceId).itemCount, 1);

    online = false;
    await engine.refreshAll();
    assert.equal(fetchCount, 1);
    const reattached = await engine.addSource(panelId, "https://source.test/feed.xml");
    assert.equal(reattached.sourceId, added.sourceId);
    assert.equal(reattached.state.items.length, 1);
    assert.equal(fetchCount, 1);

    await engine.deletePanel(panelId);
    assert.equal(engine.database.getSource(added.sourceId).itemCount, 1);
  } finally {
    engine.close();
  }
});

test("establishes a seen baseline then persists distinct seen and opened article states", async () => {
  const { databasePath, cleanup } = temporaryDatabase();
  let now = new Date("2026-07-09T12:00:00.000Z");
  let currentFeed = RSS_FIXTURE;
  const engine = createFeedEngine({
    dbPath: databasePath,
    now: () => now,
    fetchImpl: async () =>
      response(currentFeed, {
        headers: { "content-type": "application/rss+xml", "cache-control": "no-cache" },
      }),
  });
  let panelId;
  let sourceId;
  let initialItemId;
  let newItemId;
  try {
    let state = await engine.createPanel({ kind: "feed", name: "Pilote" });
    panelId = state.panels[0].id;
    const added = await engine.addSource(panelId, "https://source.test/feed.xml");
    sourceId = added.sourceId;
    const baseline = added.state.items[0];
    initialItemId = baseline.id;
    assert.equal(baseline.isBaseline, true);
    assert.equal(baseline.isNew, false);
    assert.equal(baseline.seenAt, "2026-07-09T12:00:00.000Z");
    assert.equal(baseline.openedAt, null);
    assert.equal(baseline.firstSeenAt, "2026-07-09T12:00:00.000Z");
    assert.equal(baseline.observedAt, "2026-07-09T12:00:00.000Z");
    assert.equal(baseline.publishedAt, "2026-07-09T10:30:00.000Z");

    currentFeed = UPDATED_RSS_FIXTURE;
    now = new Date("2026-07-09T12:05:00.000Z");
    state = await engine.refreshSource(sourceId);
    const original = state.items.find(({ id }) => id === initialItemId);
    const arrival = state.items.find(({ title }) => title === "Une arrivée");
    newItemId = arrival.id;
    assert.equal(state.items[0].id, arrival.id);
    assert.equal(original.firstSeenAt, "2026-07-09T12:00:00.000Z");
    assert.equal(original.observedAt, "2026-07-09T12:00:00.000Z");
    assert.equal(original.publishedAt, "2026-07-09T10:30:00.000Z");
    assert.equal(arrival.isBaseline, false);
    assert.equal(arrival.isNew, true);
    assert.equal(arrival.seenAt, null);
    assert.equal(arrival.openedAt, null);
    assert.equal(arrival.firstSeenAt, "2026-07-09T12:05:00.000Z");
    assert.equal(arrival.observedAt, "2026-07-09T12:05:00.000Z");
    assert.equal(arrival.publishedAt, "2020-07-09T12:04:00.000Z");

    now = new Date("2026-07-09T12:06:00.000Z");
    state = await engine.markItemsSeen([newItemId, newItemId, "article-inconnu"]);
    const seen = state.items.find(({ id }) => id === newItemId);
    assert.equal(seen.seenAt, "2026-07-09T12:06:00.000Z");
    assert.equal(seen.openedAt, null);
    assert.equal(seen.isNew, false);

    now = new Date("2026-07-09T12:07:00.000Z");
    state = await engine.markItemOpened(newItemId);
    const opened = state.items.find(({ id }) => id === newItemId);
    assert.equal(opened.seenAt, "2026-07-09T12:06:00.000Z");
    assert.equal(opened.openedAt, "2026-07-09T12:07:00.000Z");
    const openedDiagnostic = engine.getPilotDiagnostics();
    const openedEvent = openedDiagnostic.recentEvents.find(({ type }) => type === "item_opened");
    assert.ok(openedEvent);
    assert.equal(Object.hasOwn(openedEvent, "itemId"), false);
    assert.equal(Object.hasOwn(openedEvent, "sourceId"), false);
    assert.equal(JSON.stringify(openedDiagnostic).includes(newItemId), false);

    now = new Date("2026-07-09T12:10:00.000Z");
    state = await engine.refreshSource(sourceId);
    const observedAgain = state.items.find(({ id }) => id === newItemId);
    assert.equal(observedAgain.observedAt, "2026-07-09T12:05:00.000Z");
    assert.equal(observedAgain.lastSeenAt, "2026-07-09T12:10:00.000Z");
    assert.equal(
      engine.getPilotDiagnostics().sources[0].latestObservedAt,
      "2026-07-09T12:05:00.000Z",
    );
  } finally {
    engine.close();
  }

  const reopened = createFeedEngine({ dbPath: databasePath, fetchImpl: async () => response("") });
  try {
    const persisted = reopened.getState().items.find(({ id }) => id === newItemId);
    assert.equal(persisted.seenAt, "2026-07-09T12:06:00.000Z");
    assert.equal(persisted.openedAt, "2026-07-09T12:07:00.000Z");
    assert.equal(reopened.getState().sources[0].baselineCompletedAt, "2026-07-09T12:00:00.000Z");
  } finally {
    reopened.close();
    cleanup();
  }
});

test("preserves the last source error across a restart during refresh", async () => {
  const { databasePath, cleanup } = temporaryDatabase();
  const engine = createFeedEngine({
    dbPath: databasePath,
    fetchImpl: async () =>
      response(RSS_FIXTURE, { headers: { "content-type": "application/rss+xml" } }),
  });
  let sourceId;
  try {
    const panel = (await engine.createPanel("Source en erreur")).panels[0];
    sourceId = (await engine.addSource(panel.id, "https://source.test/feed.xml")).sourceId;
    engine.database.setSourceStatus(sourceId, "error", {
      errorMessage: "Dernière erreur connue",
      consecutiveFailures: 2,
      nextRetryAt: "2026-07-10T12:05:00.000Z",
    });
    engine.database.setSourceStatus(sourceId, "refreshing", {});
  } finally {
    engine.close();
  }

  const reopened = createFeedEngine({ dbPath: databasePath });
  try {
    const source = reopened.getState().sources.find(({ id }) => id === sourceId);
    assert.equal(source.status, "idle");
    assert.equal(source.errorMessage, "Dernière erreur connue");
    assert.equal(source.consecutiveFailures, 2);
    assert.equal(source.nextRetryAt, "2026-07-10T12:05:00.000Z");
  } finally {
    reopened.close();
    cleanup();
  }
});

test("interleaves source baselines by publication while keeping later arrivals first", async () => {
  let now = new Date("2026-07-10T12:00:00.000Z");
  let includeArrival = false;
  const rss = (title, items) => `<?xml version="1.0"?><rss version="2.0"><channel>
    <title>${title}</title>${items.map(({ name, path: itemPath, date }) => `<item>
      <title>${name}</title><link>https://${title.toLowerCase()}.test/${itemPath}</link>
      <pubDate>${new Date(date).toUTCString()}</pubDate></item>`).join("")}
  </channel></rss>`;
  const engine = createFeedEngine({
    now: () => now,
    fetchImpl: async (input) => {
      const url = String(input);
      const isA = new URL(url).hostname === "a.test";
      const items = isA
        ? [{ name: "Très récent A", path: "recent", date: "2026-07-10T11:59:00.000Z" }]
        : [
            ...(includeArrival
              ? [{ name: "Arrivée ancienne B", path: "arrival", date: "2020-01-01T00:00:00.000Z" }]
              : []),
            { name: "Très ancien B", path: "old", date: "2026-07-09T08:00:00.000Z" },
          ];
      return response(rss(isA ? "A" : "B", items), {
        headers: { "content-type": "application/rss+xml" },
      });
    },
  });
  try {
    let state = await engine.createPanel({ kind: "feed", name: "Chronologie" });
    const panelId = state.panels[0].id;
    await engine.addSource(panelId, "https://a.test/feed.xml");
    now = new Date("2026-07-10T12:01:00.000Z");
    const sourceB = await engine.addSource(panelId, "https://b.test/feed.xml");
    state = sourceB.state;
    assert.deepEqual(state.items.map(({ title }) => title), [
      "Très récent A",
      "Très ancien B",
    ]);

    includeArrival = true;
    now = new Date("2026-07-10T12:02:00.000Z");
    state = await engine.refreshSource(sourceB.sourceId, { force: true });
    assert.equal(state.items[0].title, "Arrivée ancienne B");
    assert.equal(state.items[0].isBaseline, false);
  } finally {
    engine.close();
  }
});

test("keeps an empty first parse pending until a non-empty baseline arrives", async () => {
  let now = new Date("2026-07-10T12:00:00.000Z");
  let hasArticles = false;
  const engine = createFeedEngine({
    now: () => now,
    fetchImpl: async () =>
      response(
        hasArticles
          ? RSS_FIXTURE
          : '<?xml version="1.0"?><rss version="2.0"><channel><title>Vide</title></channel></rss>',
        { headers: { "content-type": "application/rss+xml" } },
      ),
  });
  try {
    const panel = (await engine.createPanel("Baseline différée")).panels[0];
    const added = await engine.addSource(panel.id, "https://empty.test/feed.xml");
    assert.equal(added.state.items.length, 0);
    assert.equal(added.state.sources[0].baselineCompletedAt, null);

    hasArticles = true;
    now = new Date("2026-07-10T12:05:00.000Z");
    const refreshed = await engine.refreshSource(added.sourceId, { force: true });
    assert.equal(refreshed.items.length, 1);
    assert.equal(refreshed.items[0].isBaseline, true);
    assert.equal(refreshed.items[0].seenAt, "2026-07-10T12:05:00.000Z");
    assert.equal(
      refreshed.sources[0].baselineCompletedAt,
      "2026-07-10T12:05:00.000Z",
    );
  } finally {
    engine.close();
  }
});

test("exports and transactionally imports configuration without articles or browser data", async () => {
  const sourceEngine = createFeedEngine({
    now: () => new Date("2026-07-09T12:00:00.000Z"),
    fetchImpl: async () => response(RSS_FIXTURE, { headers: { "content-type": "application/rss+xml" } }),
  });
  const targetEngine = createFeedEngine({
    now: () => new Date("2026-07-09T12:00:00.000Z"),
  });
  try {
    let state = await sourceEngine.createPanel({ kind: "feed", name: "Concurrents" });
    const feedPanelId = state.panels[0].id;
    await sourceEngine.addSource(feedPanelId, "https://source.test/feed.xml");
    state = await sourceEngine.createPanel(
      { kind: "web", name: "Direct", url: "https://direct.test/" },
      { targetPanelId: feedPanelId, side: "right" },
    );
    const configuration = sourceEngine.exportDashboardConfig();
    assert.deepEqual(Object.keys(configuration).sort(), [
      "format",
      "layout",
      "panels",
      "sources",
      "version",
    ]);
    assert.equal(configuration.version, 1);
    assert.equal(configuration.sources.length, 1);
    assert.equal(Object.hasOwn(configuration, "items"), false);
    assert.equal(Object.hasOwn(configuration, "cookies"), false);
    assert.equal(Object.hasOwn(configuration, "cache"), false);
    assert.deepEqual(sourceEngine.previewDashboardConfig(configuration), {
      panels: 2,
      feedPanels: 1,
      webPanels: 1,
      sources: 1,
      hosts: ["direct.test", "source.test"],
    });
    const diagnosticsText = JSON.stringify(sourceEngine.getPilotDiagnostics());
    assert.equal(diagnosticsText.includes("Une actualité"), false);
    assert.equal(diagnosticsText.includes("Source test"), false);
    assert.equal(diagnosticsText.includes("source.test"), false);

    const imported = await targetEngine.importDashboardConfig(JSON.stringify(configuration));
    assert.deepEqual(imported.panels, state.panels);
    assert.deepEqual(imported.dashboard.layout, state.dashboard.layout);
    assert.equal(imported.items.length, 0);
    assert.equal(imported.sources.length, 1);
    assert.equal(imported.sources[0].status, "idle");
    assert.equal(imported.sources[0].baselineCompletedAt, null);
    assert.deepEqual(imported.sourceCatalog.map(({ id }) => id), [
      "le-monde",
      "le-figaro",
      "le-parisien",
    ]);

    const beforeRejectedImport = targetEngine.getState();
    await assert.rejects(
      targetEngine.importDashboardConfig({
        ...configuration,
        articles: [{ title: "Ne doit jamais entrer" }],
      }),
      /ne peut pas contenir/,
    );
    assert.deepEqual(targetEngine.getState(), beforeRejectedImport);

    const duplicateSourceId = "source-duplicate";
    const duplicateFeedConfiguration = {
      ...configuration,
      sources: [
        ...configuration.sources,
        { ...configuration.sources[0], id: duplicateSourceId },
      ],
      panels: configuration.panels.map((panel) =>
        panel.kind === "feed"
          ? { ...panel, sourceIds: [...panel.sourceIds, duplicateSourceId] }
          : panel,
      ),
    };
    await assert.rejects(
      targetEngine.importDashboardConfig(duplicateFeedConfiguration),
      /URL de flux dupliquée/,
    );
    assert.deepEqual(targetEngine.getState(), beforeRejectedImport);

    const webPanels = Array.from({ length: 7 }, (_, index) => ({
      id: `web-import-${index}`,
      kind: "web",
      name: `Page ${index + 1}`,
      url: `https://page-${index + 1}.test/`,
    }));
    await assert.rejects(
      targetEngine.importDashboardConfig({
        format: "vibedeck-dashboard",
        version: 1,
        layout: layoutForPanelIds(webPanels.map(({ id }) => id)),
        panels: webPanels,
        sources: [],
      }),
      /plus de 6 pages web/,
    );
    assert.deepEqual(targetEngine.getState(), beforeRejectedImport);
  } finally {
    sourceEngine.close();
    targetEngine.close();
  }
});

test("rolls back a validated dashboard import when SQLite fails during replacement", () => {
  const database = createLocalFeedDatabase();
  try {
    const original = database.createPanel(
      { kind: "feed", name: "Dashboard conservé" },
      null,
      "2026-07-09T12:00:00.000Z",
    );
    const before = database.getState("2026-07-09T12:00:00.000Z");
    database.database.exec(`
      CREATE TRIGGER reject_imported_panel
      BEFORE INSERT ON panels
      BEGIN
        SELECT RAISE(ABORT, 'panne SQLite injectée');
      END;
    `);

    assert.throws(
      () =>
        database.importDashboardConfig(
          {
            format: "vibedeck-dashboard",
            version: 1,
            layout: { type: "panel", panelId: "replacement-panel" },
            panels: [
              {
                id: "replacement-panel",
                kind: "web",
                name: "Remplacement",
                url: "https://replacement.test/",
              },
            ],
            sources: [],
          },
          "2026-07-09T12:05:00.000Z",
        ),
      /panne SQLite injectée/,
    );

    const after = database.getState("2026-07-09T12:00:00.000Z");
    assert.deepEqual(after, before);
    assert.equal(after.panels[0].id, original.id);
    assert.equal(
      database.listPilotEvents().some(({ type }) => type === "configuration_imported"),
      false,
    );
  } finally {
    database.close();
  }
});

test("splits capped active time at local midnight without inventing time across DST", () => {
  assert.deepEqual(
    splitActiveUsageByLocalDay(
      "2026-03-29T21:59:30.000Z",
      "2026-03-29T22:10:00.000Z",
      { timeZone: "Europe/Paris" },
    ),
    [
      { date: "2026-03-29", durationMs: 30_000 },
      { date: "2026-03-30", durationMs: 90_000 },
    ],
  );
  assert.deepEqual(
    splitActiveUsageByLocalDay(
      "2026-03-29T00:59:30.000Z",
      "2026-03-29T01:00:30.000Z",
      { timeZone: "Europe/Paris" },
    ),
    [{ date: "2026-03-29", durationMs: 60_000 }],
  );

  let now = new Date("2026-03-29T21:59:30.000Z");
  const engine = createFeedEngine({
    now: () => now,
    usageTimeZone: "Europe/Paris",
  });
  try {
    const started = engine.beginPilotSession();
    now = new Date("2026-03-29T22:00:30.000Z");
    engine.heartbeatPilotSession(started.sessionId, { active: true });
    now = new Date("2026-03-29T22:01:00.000Z");
    engine.endPilotSession(started.sessionId);

    assert.deepEqual(engine.getPilotDiagnostics().usage, {
      totalActiveDurationMs: 90_000,
      sessionCount: 1,
      closedSessions: 1,
      interruptedSessions: 0,
      activeSessions: 0,
      recentDays: [
        {
          date: "2026-03-30",
          activeDurationMs: 60_000,
          sessionCount: 0,
          closedSessions: 1,
          interruptedSessions: 0,
        },
        {
          date: "2026-03-29",
          activeDurationMs: 30_000,
          sessionCount: 1,
          closedSessions: 0,
          interruptedSessions: 0,
        },
      ],
    });
  } finally {
    engine.close();
  }
});

test("counts only active heartbeat time, caps long gaps and closes a pilot session", () => {
  let now = new Date("2026-07-09T12:00:00.000Z");
  const engine = createFeedEngine({ now: () => now, usageTimeZone: "UTC" });
  try {
    const started = engine.beginPilotSession();
    assert.equal(started.startedAt, "2026-07-09T12:00:00.000Z");
    assert.equal(started.interruptedSessions, 0);

    now = new Date("2026-07-09T12:00:30.000Z");
    assert.deepEqual(engine.heartbeatPilotSession(started.sessionId, { active: true }), {
      updated: true,
      addedDurationMs: 30_000,
      activeDurationMs: 30_000,
      heartbeatAt: "2026-07-09T12:00:30.000Z",
    });

    now = new Date("2026-07-09T12:01:00.000Z");
    const inactive = engine.heartbeatPilotSession(started.sessionId, { active: false });
    assert.equal(inactive.addedDurationMs, 30_000);
    assert.equal(inactive.activeDurationMs, 60_000);

    now = new Date("2026-07-09T12:01:30.000Z");
    const activeAgain = engine.heartbeatPilotSession(started.sessionId, { active: true });
    assert.equal(activeAgain.addedDurationMs, 0);
    assert.equal(activeAgain.activeDurationMs, 60_000);

    now = new Date("2026-07-09T12:11:30.000Z");
    const capped = engine.heartbeatPilotSession(started.sessionId, { active: true });
    assert.equal(capped.addedDurationMs, 120_000);
    assert.equal(capped.activeDurationMs, 180_000);

    now = new Date("2026-07-09T12:10:00.000Z");
    const backwardsClock = engine.heartbeatPilotSession(started.sessionId, { active: true });
    assert.equal(backwardsClock.addedDurationMs, 0);
    assert.equal(backwardsClock.heartbeatAt, "2026-07-09T12:11:30.000Z");

    now = new Date("2026-07-09T12:12:00.000Z");
    const ended = engine.endPilotSession(started.sessionId);
    assert.deepEqual(ended, {
      closed: true,
      endedAt: "2026-07-09T12:12:00.000Z",
      activeDurationMs: 210_000,
    });
    assert.deepEqual(engine.endPilotSession(started.sessionId), {
      closed: false,
      activeDurationMs: 210_000,
    });
    assert.deepEqual(engine.heartbeatPilotSession(started.sessionId), {
      updated: false,
      addedDurationMs: 0,
    });

    const diagnostics = engine.getPilotDiagnostics();
    assert.deepEqual(diagnostics.usage, {
      totalActiveDurationMs: 210_000,
      sessionCount: 1,
      closedSessions: 1,
      interruptedSessions: 0,
      activeSessions: 0,
      recentDays: [
        {
          date: "2026-07-09",
          activeDurationMs: 210_000,
          sessionCount: 1,
          closedSessions: 1,
          interruptedSessions: 0,
        },
      ],
    });
    assert.equal(JSON.stringify(diagnostics).includes(started.sessionId), false);
    const sessionEvents = diagnostics.recentEvents.filter(({ type }) =>
      type.startsWith("session_"),
    );
    assert.deepEqual(sessionEvents.map(({ type }) => type), [
      "session_ended",
      "session_started",
    ]);
    assert.equal(sessionEvents[0].durationMs, 210_000);
    assert.equal(JSON.stringify(sessionEvents).includes(started.sessionId), false);
  } finally {
    engine.close();
  }
});

test("recovers an interrupted session on restart and persists aggregated usage", () => {
  const { databasePath, cleanup } = temporaryDatabase();
  let now = new Date("2026-07-09T08:00:00.000Z");
  const firstEngine = createFeedEngine({
    dbPath: databasePath,
    now: () => now,
    usageTimeZone: "UTC",
  });
  const crashed = firstEngine.beginPilotSession();
  now = new Date("2026-07-09T08:00:30.000Z");
  firstEngine.heartbeatPilotSession(crashed.sessionId, { active: true });
  firstEngine.close();

  now = new Date("2026-07-09T08:05:00.000Z");
  const recoveredEngine = createFeedEngine({
    dbPath: databasePath,
    now: () => now,
    usageTimeZone: "UTC",
  });
  let replacement;
  try {
    replacement = recoveredEngine.beginPilotSession();
    assert.equal(replacement.interruptedSessions, 1);
    const interruptedRow = recoveredEngine.database.database
      .prepare("SELECT status, ended_at FROM pilot_sessions WHERE id = ?")
      .get(crashed.sessionId);
    assert.equal(interruptedRow.status, "interrupted");
    assert.equal(interruptedRow.ended_at, "2026-07-09T08:00:30.000Z");
    let diagnostics = recoveredEngine.getPilotDiagnostics();
    assert.equal(diagnostics.usage.totalActiveDurationMs, 30_000);
    assert.equal(diagnostics.usage.interruptedSessions, 1);
    assert.equal(diagnostics.usage.activeSessions, 1);

    now = new Date("2026-07-09T08:05:30.000Z");
    recoveredEngine.heartbeatPilotSession(replacement.sessionId, { active: true });
    now = new Date("2026-07-09T08:06:00.000Z");
    recoveredEngine.endPilotSession(replacement.sessionId);
    diagnostics = recoveredEngine.getPilotDiagnostics();
    assert.equal(diagnostics.usage.totalActiveDurationMs, 90_000);
    assert.equal(diagnostics.usage.closedSessions, 1);
    assert.equal(diagnostics.usage.interruptedSessions, 1);
    assert.equal(diagnostics.usage.activeSessions, 0);
    assert.deepEqual(diagnostics.usage.recentDays, [
      {
        date: "2026-07-09",
        activeDurationMs: 90_000,
        sessionCount: 2,
        closedSessions: 1,
        interruptedSessions: 1,
      },
    ]);
    assert.equal(diagnostics.eventsByType.session_interrupted, 1);
  } finally {
    recoveredEngine.close();
  }

  const persistedEngine = createFeedEngine({
    dbPath: databasePath,
    now: () => now,
    usageTimeZone: "UTC",
  });
  try {
    const persisted = persistedEngine.getPilotDiagnostics();
    assert.equal(persisted.usage.totalActiveDurationMs, 90_000);
    assert.equal(persisted.usage.sessionCount, 2);
    assert.equal(JSON.stringify(persisted).includes(crashed.sessionId), false);
    assert.equal(JSON.stringify(persisted).includes(replacement.sessionId), false);
  } finally {
    persistedEngine.close();
    cleanup();
  }
});

test("bounds retained pilot sessions while keeping the current one active", () => {
  const database = createLocalFeedDatabase();
  try {
    const insert = database.database.prepare(`
      INSERT INTO pilot_sessions (
        id, started_at, last_heartbeat_at, ended_at,
        active_duration_ms, last_heartbeat_active, status
      ) VALUES (?, ?, ?, ?, 1000, 0, 'closed')
    `);
    for (let index = 0; index < 1_005; index += 1) {
      const timestamp = new Date(Date.UTC(2025, 0, 1, 0, 0, index)).toISOString();
      insert.run(`retained-session-${index}`, timestamp, timestamp, timestamp);
    }
    const current = database.beginPilotSession("2026-07-09T12:00:00.000Z");
    const counts = database.database
      .prepare(`
        SELECT COUNT(*) AS total,
          SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active
        FROM pilot_sessions
      `)
      .get();
    assert.equal(counts.total, 1_000);
    assert.equal(counts.active, 1);
    assert.equal(
      database.database
        .prepare("SELECT status FROM pilot_sessions WHERE id = ?")
        .get(current.sessionId).status,
      "active",
    );
  } finally {
    database.close();
  }
});

test("bounds daily usage rows while preserving exact totals in the rollup", () => {
  const database = createLocalFeedDatabase(":memory:", { usageTimeZone: "UTC" });
  try {
    const insert = database.database.prepare(`
      INSERT INTO pilot_usage_days (
        usage_date, active_duration_ms, started_sessions,
        closed_sessions, interrupted_sessions
      ) VALUES (?, 1000, 1, 1, 0)
    `);
    for (let index = 0; index < 405; index += 1) {
      insert.run(new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10));
    }

    database.beginPilotSession("2026-02-15T12:00:00.000Z");
    assert.equal(
      database.database.prepare("SELECT COUNT(*) AS count FROM pilot_usage_days").get().count,
      400,
    );
    const rollup = database.database
      .prepare("SELECT * FROM pilot_usage_rollup WHERE id = 1")
      .get();
    assert.equal(rollup.active_duration_ms, 6_000);
    assert.equal(rollup.started_sessions, 6);
    assert.equal(rollup.closed_sessions, 6);
    assert.equal(rollup.interrupted_sessions, 0);

    const usage = database.getPilotDiagnostics("2026-02-15T12:00:00.000Z").usage;
    assert.equal(usage.totalActiveDurationMs, 405_000);
    assert.equal(usage.sessionCount, 406);
    assert.equal(usage.closedSessions, 405);
    assert.equal(usage.interruptedSessions, 0);
    assert.equal(usage.activeSessions, 1);
  } finally {
    database.close();
  }
});

test("keeps a bounded URL-free pilot journal and exposes sanitized diagnostics", async () => {
  const database = createLocalFeedDatabase();
  try {
    for (let index = 0; index < 5_005; index += 1) {
      database.recordPilotEvent(
        "keyboard_action",
        { count: 1, detailCode: "arrow_down" },
        new Date(Date.UTC(2026, 6, 9, 12, 0, index)).toISOString(),
      );
    }
    const events = database.listPilotEvents({ limit: 5_000 });
    assert.equal(events.length, 5_000);
    assert.equal(events.at(-1).id, 6);
    assert.throws(
      () => database.recordPilotEvent("navigation", { detailCode: "https://secret.test/" }),
      /Code de détail/,
    );
    const diagnostics = database.getPilotDiagnostics("2026-07-09T14:00:00.000Z");
    assert.equal(diagnostics.totals.pilotEvents, 5_000);
    assert.equal(diagnostics.eventsByType.keyboard_action, 5_000);
    assert.equal(diagnostics.recentEvents.length, 100);
    assert.equal(JSON.stringify(diagnostics).includes("https://"), false);
  } finally {
    database.close();
  }
});

test("backs off automatic source retries and resets failures after a manual success", async () => {
  let now = new Date("2026-07-09T12:00:00.000Z");
  let calls = 0;
  let fail = false;
  const engine = createFeedEngine({
    now: () => now,
    fetchImpl: async () => {
      calls += 1;
      if (fail) throw new Error("network unavailable");
      return response(RSS_FIXTURE, {
        headers: { "content-type": "application/rss+xml", "cache-control": "no-cache" },
      });
    },
  });
  try {
    const panel = (await engine.createPanel({ kind: "feed", name: "Backoff" })).panels[0];
    const added = await engine.addSource(panel.id, "https://source.test/feed.xml");
    assert.equal(calls, 1);

    fail = true;
    now = new Date("2026-07-09T12:01:00.000Z");
    let state = await engine.refreshAll();
    assert.equal(calls, 2);
    assert.equal(state.sources[0].status, "error");
    assert.equal(state.sources[0].consecutiveFailures, 1);
    assert.equal(state.sources[0].nextRetryAt, "2026-07-09T12:02:00.000Z");

    now = new Date("2026-07-09T12:01:30.000Z");
    state = await engine.refreshAll();
    assert.equal(calls, 2);
    assert.equal(state.sources[0].nextRetryAt, "2026-07-09T12:02:00.000Z");

    now = new Date("2026-07-09T12:02:00.000Z");
    state = await engine.refreshAll();
    assert.equal(calls, 3);
    assert.equal(state.sources[0].consecutiveFailures, 2);
    assert.equal(state.sources[0].nextRetryAt, "2026-07-09T12:04:00.000Z");

    fail = false;
    state = await engine.refreshSource(added.sourceId, { force: true });
    assert.equal(calls, 4);
    assert.equal(state.sources[0].status, "healthy");
    assert.equal(state.sources[0].consecutiveFailures, 0);
    assert.equal(state.sources[0].nextRetryAt, null);
  } finally {
    engine.close();
  }
});
