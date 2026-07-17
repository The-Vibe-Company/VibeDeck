import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SEMANTIC_VECTOR_DIMENSIONS,
  SemanticSearchService,
} from "./semantic-search.mjs";

const MODEL_CONTENT = Buffer.from("modele semantique de test");
const MODEL_FILES = [{
  file: "model.bin",
  size: MODEL_CONTENT.length,
  sha256: createHash("sha256").update(MODEL_CONTENT).digest("hex"),
}];

async function pathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function writeTestModel(modelPath) {
  await mkdir(modelPath, { recursive: true });
  await writeFile(path.join(modelPath, MODEL_FILES[0].file), MODEL_CONTENT);
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Délai dépassé : ${label}`);
}

class FakeSemanticWorker extends EventEmitter {
  constructor({ blockFirstEmbed = false, blockTerminate = false } = {}) {
    super();
    this.blockFirstEmbed = blockFirstEmbed;
    this.blockTerminate = blockTerminate;
    this.embedCalls = 0;
    this.activeEmbeds = 0;
    this.maxActiveEmbeds = 0;
    this.firstEmbedStarted = new Promise((resolve) => { this.resolveFirstEmbedStarted = resolve; });
    this.firstEmbedGate = new Promise((resolve) => { this.releaseFirstEmbed = resolve; });
    this.terminateStarted = new Promise((resolve) => { this.resolveTerminateStarted = resolve; });
    this.terminateGate = new Promise((resolve) => { this.releaseTerminate = resolve; });
  }

  postMessage({ id, action, payload }) {
    void this.#respond(id, action, payload);
  }

  async #respond(id, action, payload) {
    try {
      let result = null;
      if (action === "embed") {
        this.embedCalls += 1;
        this.activeEmbeds += 1;
        this.maxActiveEmbeds = Math.max(this.maxActiveEmbeds, this.activeEmbeds);
        if (this.embedCalls === 1) {
          this.resolveFirstEmbedStarted();
          if (this.blockFirstEmbed) await this.firstEmbedGate;
        }
        result = payload.texts.map(() =>
          Float32Array.from(
            { length: SEMANTIC_VECTOR_DIMENSIONS },
            (_, index) => index % 2 ? -0.25 : 0.25,
          ).buffer);
        this.activeEmbeds -= 1;
      } else if (action === "search") {
        result = [];
      }
      this.emit("message", { id, result });
    } catch (error) {
      this.emit("message", { id, error: error.message });
    }
  }

  async terminate() {
    this.resolveTerminateStarted();
    if (this.blockTerminate) await this.terminateGate;
    this.emit("exit", 0);
    return 0;
  }
}

function createDocument(id, title) {
  return {
    id,
    sourceId: "source-test",
    title,
    summary: `Résumé de ${title}`,
  };
}

test("reuses one packaged model across application versions without downloading", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibedeck-service-model-"));
  const canonicalModelPath = path.join(directory, "app-id", "semantic-search", "model");
  const legacyModelPath = path.join(directory, "VibeDeck", "semantic-search", "model");
  const roots = [path.join(directory, "version-a"), path.join(directory, "version-b")];
  const downloads = [];
  try {
    await writeTestModel(legacyModelPath);
    for (const rootPath of roots) {
      const worker = new FakeSemanticWorker();
      const service = new SemanticSearchService({
        rootPath,
        modelPath: canonicalModelPath,
        legacyModelPaths: [legacyModelPath],
        modelFiles: MODEL_FILES,
        workerFactory: () => worker,
        getDocuments: () => [],
        getItems: () => [],
        download: async (...args) => { downloads.push(args); },
      });
      assert.equal((await service.initialize()).phase, "ready");
      await service.close();
    }
    assert.equal(downloads.length, 0);
    assert.equal(await pathExists(canonicalModelPath), true);
    assert.equal(await pathExists(legacyModelPath), false);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("keeps initial indexing exclusive and coalesces refreshes without UI flicker", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibedeck-service-sync-"));
  const rootPath = path.join(directory, "profile", "semantic-search");
  const modelPath = path.join(directory, "app-id", "semantic-search", "model");
  const worker = new FakeSemanticWorker({ blockFirstEmbed: true });
  const statuses = [];
  const downloads = [];
  let documents = [createDocument("article-1", "Premier article")];
  try {
    const service = new SemanticSearchService({
      rootPath,
      modelPath,
      modelFiles: MODEL_FILES,
      workerFactory: () => worker,
      getDocuments: () => documents,
      getItems: (ids) => documents.filter(({ id }) => ids.includes(id)),
      download: async (_url, destination) => {
        downloads.push(destination);
        await writeFile(destination, MODEL_CONTENT);
      },
    });
    service.onStatusChanged((status) => statuses.push(status.phase));

    const preparation = service.prepare();
    await worker.firstEmbedStarted;
    assert.equal(service.getStatus().phase, "indexing");

    documents = [...documents, createDocument("article-2", "Deuxième article")];
    const refreshes = [service.sync(), service.sync(), service.sync()];
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(statuses.includes("updating"), false);
    assert.equal(worker.maxActiveEmbeds, 1);

    worker.releaseFirstEmbed();
    await preparation;
    await Promise.all(refreshes);
    await waitFor(
      () => worker.embedCalls === 2 && service.getStatus().phase === "ready",
      "la synchronisation différée",
    );

    const firstReady = statuses.indexOf("ready");
    const firstUpdating = statuses.indexOf("updating");
    assert.ok(firstReady >= 0 && firstUpdating > firstReady, statuses.join(" → "));
    assert.equal(statuses.slice(firstReady + 1).includes("indexing"), false, statuses.join(" → "));
    assert.equal(worker.maxActiveEmbeds, 1, "Les embeddings doivent rester strictement séquentiels.");
    assert.equal(downloads.length, 1);

    const result = await service.search({
      query: "Deuxième",
      sourceIds: ["source-test"],
      mode: "lexical",
    });
    assert.deepEqual(result.items.map(({ id }) => id), ["article-2"]);
    await service.close();
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("removes the index, canonical model, and every known legacy model", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibedeck-service-remove-"));
  const rootPath = path.join(directory, "profile", "semantic-search");
  const modelPath = path.join(directory, "app-id", "semantic-search", "model");
  const legacyModelPath = path.join(directory, "MediaGen Veille", "semantic-search", "model");
  try {
    await writeTestModel(modelPath);
    const service = new SemanticSearchService({
      rootPath,
      modelPath,
      legacyModelPaths: [legacyModelPath],
      modelFiles: MODEL_FILES,
      workerFactory: () => new FakeSemanticWorker(),
      getDocuments: () => [],
      getItems: () => [],
      download: async () => { throw new Error("Téléchargement inattendu"); },
    });
    await service.initialize();
    await writeTestModel(legacyModelPath);
    await service.removeData();

    assert.equal(service.getStatus().phase, "not-installed");
    assert.deepEqual(
      await Promise.all([rootPath, modelPath, legacyModelPath].map(pathExists)),
      [false, false, false],
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("rejects preparation while model and index removal is in progress", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibedeck-service-remove-barrier-"));
  const rootPath = path.join(directory, "profile", "semantic-search");
  const modelPath = path.join(directory, "app-id", "semantic-search", "model");
  const worker = new FakeSemanticWorker({ blockTerminate: true });
  try {
    await writeTestModel(modelPath);
    const service = new SemanticSearchService({
      rootPath,
      modelPath,
      modelFiles: MODEL_FILES,
      workerFactory: () => worker,
      getDocuments: () => [],
      getItems: () => [],
      download: async () => { throw new Error("Téléchargement inattendu"); },
    });
    await service.initialize();

    const removal = service.removeData();
    await worker.terminateStarted;
    await assert.rejects(service.prepare(), /fermeture ou de suppression/);
    worker.releaseTerminate();
    await removal;

    assert.equal(service.getStatus().phase, "not-installed");
    assert.deepEqual(await Promise.all([rootPath, modelPath].map(pathExists)), [false, false]);
  } finally {
    worker.releaseTerminate();
    await rm(directory, { force: true, recursive: true });
  }
});

test("finishes removal after an in-flight initial preparation settles", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibedeck-service-remove-preparing-"));
  const rootPath = path.join(directory, "profile", "semantic-search");
  const modelPath = path.join(directory, "app-id", "semantic-search", "model");
  const worker = new FakeSemanticWorker({ blockFirstEmbed: true });
  try {
    const service = new SemanticSearchService({
      rootPath,
      modelPath,
      modelFiles: MODEL_FILES,
      workerFactory: () => worker,
      getDocuments: () => [createDocument("article-1", "Premier article")],
      getItems: () => [],
      download: async (_url, destination) => writeFile(destination, MODEL_CONTENT),
    });
    const preparation = service.prepare();
    const preparationResult = preparation.then(
      () => null,
      (error) => error,
    );
    await worker.firstEmbedStarted;

    await service.removeData();
    const preparationError = await preparationResult;
    worker.releaseFirstEmbed();

    assert.match(preparationError?.message ?? "", /worker de recherche locale s’est arrêté/);
    assert.equal(service.getStatus().phase, "not-installed");
    assert.deepEqual(await Promise.all([rootPath, modelPath].map(pathExists)), [false, false]);
  } finally {
    worker.releaseFirstEmbed();
    await rm(directory, { force: true, recursive: true });
  }
});

test("keeps the removal barrier and publishes an error until all failed cleanup settles", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibedeck-service-remove-failure-"));
  const rootPath = path.join(directory, "profile", "semantic-search");
  const modelPath = path.join(directory, "app-id", "semantic-search", "model");
  let releaseModelRemoval;
  const modelRemovalGate = new Promise((resolve) => { releaseModelRemoval = resolve; });
  let modelRemovalStarted;
  const modelRemovalDidStart = new Promise((resolve) => { modelRemovalStarted = resolve; });
  try {
    await writeTestModel(modelPath);
    const service = new SemanticSearchService({
      rootPath,
      modelPath,
      modelFiles: MODEL_FILES,
      workerFactory: () => new FakeSemanticWorker(),
      getDocuments: () => [],
      getItems: () => [],
      download: async () => { throw new Error("Téléchargement inattendu"); },
      removeRootPath: async () => { throw new Error("profil verrouillé"); },
      removeModelPaths: async () => {
        modelRemovalStarted();
        await modelRemovalGate;
      },
    });
    await service.initialize();
    const removal = service.removeData();
    const removalResult = removal.then(
      () => null,
      (error) => error,
    );
    await modelRemovalDidStart;

    await assert.rejects(service.prepare(), /fermeture ou de suppression/);
    releaseModelRemoval();
    assert.ok(await removalResult instanceof AggregateError);
    assert.equal(service.getStatus().phase, "error");
    assert.match(service.getStatus().message ?? "", /entièrement supprimées/);
  } finally {
    releaseModelRemoval?.();
    await rm(directory, { force: true, recursive: true });
  }
});

test("removes a rejected model part before surfacing the preparation error", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibedeck-service-invalid-model-"));
  const rootPath = path.join(directory, "profile", "semantic-search");
  const modelPath = path.join(directory, "app-id", "semantic-search", "model");
  try {
    const service = new SemanticSearchService({
      rootPath,
      modelPath,
      modelFiles: MODEL_FILES,
      workerFactory: () => new FakeSemanticWorker(),
      getDocuments: () => [],
      getItems: () => [],
      download: async (_url, destination) => writeFile(destination, "modèle invalide"),
    });
    await assert.rejects(service.prepare(), /vérification du modèle/);
    assert.deepEqual(
      await Promise.all([modelPath, `${modelPath}.downloading`].map(pathExists)),
      [false, false],
    );
    await service.close();
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("keeps the previous cache and removes download staging after cancellation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibedeck-service-cancel-model-"));
  const rootPath = path.join(directory, "profile", "semantic-search");
  const modelPath = path.join(directory, "app-id", "semantic-search", "model");
  const previousContent = Buffer.from("révision précédente du modèle");
  let signalDownloadStarted;
  const downloadStarted = new Promise((resolve) => { signalDownloadStarted = resolve; });
  try {
    await mkdir(modelPath, { recursive: true });
    await writeFile(path.join(modelPath, "previous.bin"), previousContent);
    const service = new SemanticSearchService({
      rootPath,
      modelPath,
      modelFiles: MODEL_FILES,
      workerFactory: () => new FakeSemanticWorker(),
      getDocuments: () => [],
      getItems: () => [],
      download: async (_url, destination, { signal }) => {
        await writeFile(destination, "partiel");
        signalDownloadStarted();
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(
            new Error("Téléchargement de la recherche locale annulé."),
          ), { once: true });
        });
      },
    });
    const preparation = service.prepare();
    const preparationResult = preparation.then(
      () => null,
      (error) => error,
    );
    await downloadStarted;
    service.cancelPreparation();

    assert.match((await preparationResult)?.message ?? "", /annulé/);
    assert.deepEqual(await readFile(path.join(modelPath, "previous.bin")), previousContent);
    assert.equal(await pathExists(`${modelPath}.downloading`), false);
    await service.close();
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
