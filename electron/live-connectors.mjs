import { mkdtempSync, rmSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createFeedEngine } from "./feed-engine.mjs";
import { createArticleReaderService } from "./article-reader.mjs";
import { PUBLICATIONS } from "./publication-registry.mjs";

const directory = mkdtempSync(path.join(tmpdir(), "vibedeck-live-"));
const engine = createFeedEngine({ dbPath: path.join(directory, "smoke.sqlite3") });
const readerSessions = new Map();
const readerService = createArticleReaderService({
  sessionForConnector(connectorId) {
    if (readerSessions.has(connectorId)) return readerSessions.get(connectorId);
    const networkSession = {
      webRequest: { onHeadersReceived() {} },
      fetch(url, options) {
        const { bypassCustomProtocolHandlers: _bypass, ...fetchOptions } = options;
        return fetch(url, fetchOptions);
      },
      async resolveHost(hostname) {
        const addresses = await lookup(hostname, { all: true });
        return { endpoints: addresses.map(({ address }) => ({ address })) };
      },
      async resolveProxy() {
        return "DIRECT";
      },
      async clearStorageData() {},
    };
    readerSessions.set(connectorId, networkSession);
    return networkSession;
  },
});

try {
  let state = engine.getState();
  if (state.panels.length === 0) {
    state = await engine.createPanel({ kind: "feed", name: "Test des connecteurs" });
  }
  const panel = state.panels.find(({ kind }) => kind === "feed");
  if (!panel) throw new Error("Aucun panel de test n’a pu être créé.");
  for (const publication of PUBLICATIONS) {
    const startedAt = performance.now();
    const result = await engine.addCatalogSource(panel.id, publication.id);
    const source = result.state.sources.find(({ id }) => id === result.sourceId);
    if (
      !source ||
      source.status !== "healthy" ||
      source.itemCount === 0 ||
      !source.lastSuccessAt ||
      !source.baselineCompletedAt
    ) {
      throw new Error(`${publication.name} n’a renvoyé aucune actualité exploitable.`);
    }
    const sourceItems = result.state.items.filter(({ sourceId }) => sourceId === source.id);
    if (sourceItems.some((item) => !item.isBaseline || item.seenAt === null || item.isNew)) {
      throw new Error(`${publication.name} a produit une fausse nouveauté pendant la baseline.`);
    }
    console.log(
      `✓ ${source.name}: ${source.itemCount} actualités · baseline saine · ${Math.round(performance.now() - startedAt)} ms`,
    );
  }

  state = engine.getState();
  let fallbackOnlySources = 0;
  for (const source of state.sources.filter(({ connectorId }) => connectorId)) {
    const candidates = state.items
      .filter(({ sourceId }) => sourceId === source.id)
      .slice(0, 5);
    let successes = 0;
    let fallbacks = 0;
    let longestDecisionMs = 0;
    for (const item of candidates) {
      const startedAt = performance.now();
      const result = await readerService.extract({
        connectorId: source.connectorId,
        url: item.canonicalUrl,
      });
      longestDecisionMs = Math.max(longestDecisionMs, performance.now() - startedAt);
      if (result.ok) successes += 1;
      else fallbacks += 1;
    }
    if (longestDecisionMs >= 1_000) {
      throw new Error(`${source.name} a dépassé le budget de décision du lecteur.`);
    }
    if (candidates.length > 0 && successes === 0) {
      fallbackOnlySources += 1;
    }
    console.log(
      `✓ Lecteur ${source.name}: ${successes} succès · ${fallbacks} replis · ${Math.round(longestDecisionMs)} ms max`,
    );
  }

  const healthySources = state.sources.filter(({ status }) => status === "healthy").length;
  console.log(
    `✓ Fil agrégé: ${state.items.length} actualités, ${healthySources}/${state.sources.length} sources à jour`,
  );
  console.log(
    `✓ Lecture simplifiée prioritaire: ${state.sources.length - fallbackOnlySources}/${state.sources.length} publications extraites, ${fallbackOnlySources} repli(s) intégral(aux) normal(aux) vers la page originale`,
  );
} finally {
  await readerService.shutdown();
  engine.close();
  rmSync(directory, { recursive: true, force: true });
}
