import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createFeedEngine } from "./feed-engine.mjs";

const launchSources = [
  ["Le Monde", "lemonde.fr"],
  ["Le Figaro", "lefigaro.fr/flash-actu"],
  ["Le Parisien", "leparisien.fr/actualites-en-continu"],
];

const directory = mkdtempSync(path.join(tmpdir(), "mediagen-live-"));
const engine = createFeedEngine({ dbPath: path.join(directory, "smoke.sqlite3") });

try {
  let state = engine.getState();
  if (state.panels.length === 0) {
    state = await engine.createPanel({ kind: "feed", name: "Test des connecteurs" });
  }
  const panel = state.panels.find(({ kind }) => kind === "feed");
  if (!panel) throw new Error("Aucun panel de test n’a pu être créé.");
  for (const [expectedName, url] of launchSources) {
    const startedAt = performance.now();
    const result = await engine.addSource(panel.id, url);
    const source = result.state.sources.find(({ id }) => id === result.sourceId);
    if (
      !source ||
      source.status !== "healthy" ||
      source.itemCount === 0 ||
      !source.lastSuccessAt ||
      !source.baselineCompletedAt
    ) {
      throw new Error(`${expectedName} n’a renvoyé aucune actualité exploitable.`);
    }
    const sourceItems = result.state.items.filter(({ sourceId }) => sourceId === source.id);
    if (sourceItems.some((item) => !item.isBaseline || item.seenAt === null || item.isNew)) {
      throw new Error(`${expectedName} a produit une fausse nouveauté pendant la baseline.`);
    }
    console.log(
      `✓ ${source.name}: ${source.itemCount} actualités · baseline saine · ${Math.round(performance.now() - startedAt)} ms`,
    );
  }

  state = engine.getState();
  const healthySources = state.sources.filter(({ status }) => status === "healthy").length;
  console.log(
    `✓ Fil agrégé: ${state.items.length} actualités, ${healthySources}/${state.sources.length} sources à jour`,
  );
} finally {
  engine.close();
  rmSync(directory, { recursive: true, force: true });
}
