import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import {
  adoptLegacySemanticModel,
  removeSemanticModelPaths,
  replaceSemanticModel,
  semanticModelBytes,
  validSemanticModelFile,
} from "./semantic-model-storage.mjs";

export const SEMANTIC_MODEL_ID = "Xenova/multilingual-e5-small";
export const SEMANTIC_MODEL_REVISION = "761b726dd34fb83930e26aab4e9ac3899aa1fa78";
export const SEMANTIC_VECTOR_DIMENSIONS = 384;
export const MAX_SEARCH_QUERY_LENGTH = 240;
export const MAX_SEARCH_RESULTS = 200;

const MODEL_FILES = Object.freeze([
  ["config.json", 658, "cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1"],
  ["quant_config.json", 674, "59d175f15264115f18c698d76e443b5d49fc6c8c599911c421405ef4f236e87d"],
  ["special_tokens_map.json", 167, "d05497f1da52c5e09554c0cd874037a083e1dc1b9cfd48034d1c717f1afc07a7"],
  ["tokenizer_config.json", 443, "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b"],
  ["sentencepiece.bpe.model", 5_069_051, "cfc8146abe2a0488e9e2a0c56de7952f7c11ab059eca145a0a727afce0db2865"],
  ["tokenizer.json", 17_082_730, "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39"],
  ["onnx/model_quantized.onnx", 118_308_185, "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193"],
].map(([file, size, sha256]) => Object.freeze({ file, size, sha256 })));

const SEARCH_SCHEMA_VERSION = 1;
const LEXICAL_BM25_WEIGHTS = Object.freeze([0, 3, 1]);
const HYBRID_RRF_WEIGHTS = Object.freeze([0.6, 0.4]);
const ALLOWED_MODEL_HOSTS = new Set([
  "huggingface.co",
  "us.aws.cdn.hf.co",
  "cas-bridge.xethub.hf.co",
]);
const SEARCH_MODES = new Set(["lexical", "hybrid"]);

export class SearchSupersededError extends Error {
  constructor() {
    super("Recherche remplacée par une requête plus récente.");
    this.name = "SearchSupersededError";
  }
}

export function normalizeSearchMode(value) {
  if (!SEARCH_MODES.has(value)) throw new TypeError("Mode de recherche invalide.");
  return value;
}

export class LatestTaskQueue {
  constructor(run) {
    if (typeof run !== "function") throw new TypeError("Exécuteur de file invalide.");
    this.run = run;
    this.running = false;
    this.pending = null;
    this.closedError = null;
  }

  enqueue(payload) {
    if (this.closedError) return Promise.reject(this.closedError);
    return new Promise((resolve, reject) => {
      if (this.pending) this.pending.reject(new SearchSupersededError());
      this.pending = { payload, resolve, reject };
      void this.#drain();
    });
  }

  close(error = new Error("File de recherche fermée.")) {
    this.closedError = error;
    this.pending?.reject(error);
    this.pending = null;
  }

  async #drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending) {
        const task = this.pending;
        this.pending = null;
        try {
          task.resolve(await this.run(task.payload));
        } catch (error) {
          task.reject(error);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

export function normalizeSearchQuery(value) {
  if (typeof value !== "string") throw new TypeError("Requête de recherche invalide.");
  const query = value.normalize("NFC").replace(/\s+/g, " ").trim();
  if (query.length < 2 || query.length > MAX_SEARCH_QUERY_LENGTH) {
    throw new RangeError(`La recherche doit contenir entre 2 et ${MAX_SEARCH_QUERY_LENGTH} caractères.`);
  }
  return query;
}

export function documentHash({ title, summary }) {
  return createHash("sha256")
    .update(`${title ?? ""}\u0000${summary ?? ""}`, "utf8")
    .digest("hex");
}

export function quantizeVector(vector) {
  if (!vector || vector.length !== SEMANTIC_VECTOR_DIMENSIONS) {
    throw new RangeError("Vecteur de recherche invalide.");
  }
  let squared = 0;
  for (const value of vector) squared += value * value;
  const norm = Math.sqrt(squared) || 1;
  const values = Int8Array.from(vector, (value) => Math.max(-127, Math.min(127, Math.round((value / norm) * 127))));
  return { vector: Buffer.from(values.buffer), norm };
}

export function reciprocalRankFusion(rankings, { weights = rankings.map(() => 1), k = 60 } = {}) {
  if (weights.length !== rankings.length) {
    throw new RangeError("Chaque classement doit avoir un poids de fusion.");
  }
  const scores = new Map();
  rankings.forEach((ranking, rankingIndex) => {
    const weight = weights[rankingIndex];
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new RangeError("Poids de fusion invalide.");
    }
    ranking.forEach((itemId, index) => {
      scores.set(itemId, (scores.get(itemId) ?? 0) + weight / (k + index + 1));
    });
  });
  return [...scores.entries()]
    .sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0]))
    .map(([itemId]) => itemId);
}

function searchText(document) {
  return `passage: ${document.title}\n${document.summary ?? ""}`.slice(0, 12_000);
}

function ftsQuery(query) {
  return query
    .match(/[\p{L}\p{N}_-]+/gu)
    ?.slice(0, 32)
    .map((term) => `"${term.replaceAll('"', "")}"`)
    .join(" OR ") ?? "";
}

export function lexicalCandidateIds(database, query, sourceIds) {
  const expression = ftsQuery(query);
  if (!expression || sourceIds.length === 0) return [];
  return database
    .prepare(`
      SELECT item_id
      FROM documents_fts
      WHERE documents_fts MATCH ?
        AND item_id IN (
          SELECT item_id FROM documents
          WHERE source_id IN (${sourceIds.map(() => "?").join(",")})
        )
      ORDER BY bm25(documents_fts, ${LEXICAL_BM25_WEIGHTS.join(", ")}), item_id ASC
      LIMIT 201
    `)
    .all(expression, ...sourceIds)
    .map(({ item_id }) => item_id);
}

export function hybridCandidateIds(lexical, semantic) {
  return reciprocalRankFusion([lexical, semantic], { weights: HYBRID_RRF_WEIGHTS });
}

function workerRequest(worker, action, payload, transferList = []) {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message?.id !== id) return;
      cleanup();
      if (message.error) reject(new Error(message.error));
      else resolve(message.result);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = () => {
      cleanup();
      reject(new Error("Le worker de recherche locale s’est arrêté."));
    };
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };
    worker.on("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
    try {
      worker.postMessage({ id, action, payload }, transferList);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

export class SemanticSearchService {
  constructor({
    rootPath,
    modelPath = path.join(rootPath, "model"),
    legacyModelPaths = [],
    getDocuments,
    getItems,
    download,
    testMode = false,
    modelFiles = MODEL_FILES,
    workerFactory = () => new Worker(new URL("./semantic-search-worker.mjs", import.meta.url)),
    removeRootPath = (candidate) => rm(candidate, { force: true, recursive: true }),
    removeModelPaths = removeSemanticModelPaths,
  }) {
    this.rootPath = rootPath;
    this.modelPath = modelPath;
    this.legacyModelPaths = legacyModelPaths;
    this.indexPath = path.join(rootPath, "index.sqlite3");
    this.getDocuments = getDocuments;
    this.getItems = getItems;
    this.download = download;
    this.testMode = testMode;
    this.modelFiles = modelFiles;
    this.workerFactory = workerFactory;
    this.removeRootPath = removeRootPath;
    this.removeModelPaths = removeModelPaths;
    this.status = { phase: "not-installed", progress: 0, message: null, bytes: 0 };
    this.listeners = new Set();
    this.worker = null;
    this.initialization = null;
    this.preparation = null;
    this.removal = null;
    this.syncTask = null;
    this.syncPending = false;
    this.cancelled = false;
    this.downloadController = null;
    this.activeOperations = new Set();
    this.stopping = false;
    this.database = null;
    this.hybridSearchQueue = new LatestTaskQueue((payload) => this.#runHybridSearch(payload));
  }

  getStatus() { return { ...this.status }; }
  onStatusChanged(callback) { this.listeners.add(callback); return () => this.listeners.delete(callback); }
  #setStatus(next) { this.status = { ...this.status, ...next }; for (const callback of this.listeners) callback(this.getStatus()); }
  #track(task) {
    this.activeOperations.add(task);
    task.finally(() => this.activeOperations.delete(task)).catch(() => {});
    return task;
  }

  initialize() {
    if (this.stopping) {
      return Promise.reject(new Error("La recherche locale est en cours de fermeture ou de suppression."));
    }
    if (this.initialization) return this.initialization;
    this.initialization = this.#track(this.#initialize()).finally(() => {
      this.initialization = null;
    });
    return this.initialization;
  }

  async #initialize() {
    if (this.testMode) {
      this.#setStatus({ phase: "ready", progress: 1, message: null, bytes: 0 });
      return this.getStatus();
    }
    await mkdir(this.rootPath, { recursive: true });
    const installed = await this.#adoptLegacyModel();
    if (!installed || this.stopping) return this.getStatus();
    try {
      this.#openIndex();
      await this.#startWorker();
      this.#setStatus({ phase: "ready", progress: 1, message: null, bytes: await this.#usedBytes() });
    } catch {
      await this.#resetIndex();
      this.#setStatus({ phase: "error", progress: 0, message: "L’index local doit être reconstruit.", bytes: await this.#usedBytes() });
    }
    return this.getStatus();
  }

  async prepare() {
    if (this.stopping) {
      throw new Error("La recherche locale est en cours de fermeture ou de suppression.");
    }
    if (this.initialization) await this.initialization;
    if (this.stopping) {
      throw new Error("La recherche locale est en cours de fermeture ou de suppression.");
    }
    if (this.testMode) {
      this.#setStatus({ phase: "ready", progress: 1, message: null, bytes: 0 });
      return this.getStatus();
    }
    if (this.preparation) return this.preparation;
    this.cancelled = false;
    this.preparation = this.#track(this.#prepare()).finally(() => {
      this.preparation = null;
      if (this.syncPending && !this.stopping && this.status.phase === "ready") {
        void this.sync().catch(() => {});
      }
    });
    return this.preparation;
  }

  cancelPreparation() {
    this.cancelled = true;
    this.downloadController?.abort();
  }

  async #prepare() {
    try {
      await mkdir(this.rootPath, { recursive: true });
      if (!(await this.#adoptLegacyModel())) await this.#downloadModel();
      if (this.cancelled) throw new Error("Téléchargement de la recherche locale annulé.");
      this.#openIndex();
      await this.#startWorker();
      await this.#sync({ initial: true });
      if (this.cancelled || this.stopping) throw new Error("Indexation annulée.");
      this.#setStatus({ phase: "ready", progress: 1, message: null, bytes: await this.#usedBytes() });
      return this.getStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : "La recherche locale n’a pas pu être préparée.";
      if (!this.stopping) {
        this.#setStatus({ phase: "error", progress: 0, message, bytes: await this.#usedBytes() });
      }
      throw error;
    } finally {
      this.downloadController = null;
    }
  }

  async #downloadModel() {
    this.downloadController = new AbortController();
    const preparedModelPath = `${this.modelPath}.downloading`;
    await rm(preparedModelPath, { force: true, recursive: true });
    let completed = 0;
    const total = this.modelFiles.reduce((sum, entry) => sum + entry.size, 0);
    this.#setStatus({ phase: "downloading", progress: 0, message: null });
    try {
      for (const entry of this.modelFiles) {
        if (this.cancelled) throw new Error("Téléchargement de la recherche locale annulé.");
        const destination = path.join(preparedModelPath, entry.file);
        await mkdir(path.dirname(destination), { recursive: true });
        const part = `${destination}.part-${process.pid}-${randomUUID()}`;
        await rm(part, { force: true });
        const url = `https://huggingface.co/${SEMANTIC_MODEL_ID}/resolve/${SEMANTIC_MODEL_REVISION}/${entry.file}`;
        await this.download(url, part, {
          expectedBytes: entry.size,
          expectedSha256: entry.sha256,
          cancelled: () => this.cancelled,
          signal: this.downloadController.signal,
        });
        if (!(await this.#validFile(part, entry))) {
          throw new Error("La vérification du modèle a échoué.");
        }
        await rename(part, destination);
        await rm(part, { force: true });
        completed += entry.size;
        this.#setStatus({ phase: "downloading", progress: completed / total, bytes: completed });
      }
      await replaceSemanticModel({
        modelPath: this.modelPath,
        preparedModelPath,
        modelFiles: this.modelFiles,
      });
    } finally {
      await rm(preparedModelPath, { force: true, recursive: true });
    }
    this.downloadController = null;
  }

  async #validFile(file, entry) { return validSemanticModelFile(file, entry); }

  #openIndex() {
    if (this.database) return;
    this.database = new DatabaseSync(this.indexPath);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    const version = this.database.prepare("PRAGMA user_version").get().user_version;
    if (version > SEARCH_SCHEMA_VERSION) throw new Error("Index de recherche créé par une version plus récente.");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        item_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, content_hash TEXT NOT NULL,
        vector BLOB NOT NULL, norm REAL NOT NULL, indexed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS documents_source_id ON documents(source_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
        item_id UNINDEXED, title, summary, tokenize = 'unicode61 remove_diacritics 2'
      );
      PRAGMA user_version = ${SEARCH_SCHEMA_VERSION};
    `);
  }

  async #startWorker() {
    if (this.worker) return;
    const worker = this.workerFactory();
    this.worker = worker;
    worker.once("exit", (code) => {
      if (code !== 0 && !this.stopping) {
        this.#setStatus({ phase: "error", message: "Le worker de recherche locale s’est arrêté." });
      }
      if (this.worker === worker) this.worker = null;
    });
    await workerRequest(worker, "load", { modelPath: this.modelPath });
    const documents = this.database.prepare("SELECT source_id, item_id, vector, norm FROM documents").all().map((row) => ({
      id: `${row.source_id}\u0000${row.item_id}`, vector: row.vector.buffer.slice(row.vector.byteOffset, row.vector.byteOffset + row.vector.byteLength), norm: row.norm,
    }));
    await workerRequest(
      worker,
      "set-corpus",
      { documents },
      documents.map(({ vector }) => vector),
    );
  }

  sync() {
    if (this.testMode || this.stopping) return Promise.resolve();
    this.syncPending = true;
    if (this.preparation) {
      return this.preparation.then(() => undefined, () => undefined);
    }
    if (this.syncTask) return this.syncTask;
    const task = this.#track(this.#drainSyncs()).finally(() => {
      this.syncTask = null;
      if (this.syncPending && !this.stopping && !this.preparation) {
        void this.sync().catch(() => {});
      }
    });
    this.syncTask = task;
    return task;
  }

  async #drainSyncs() {
    while (this.syncPending && !this.stopping && !this.preparation) {
      this.syncPending = false;
      await this.#sync();
    }
  }

  async #sync({ initial = false } = {}) {
    if (this.testMode || this.stopping) return;
    if (
      !this.database ||
      !this.worker ||
      (!initial && !["ready", "updating"].includes(this.status.phase))
    ) return;
    const documents = this.getDocuments();
    const current = new Map(this.database.prepare("SELECT item_id, source_id, content_hash FROM documents").all().map((row) => [`${row.source_id}\u0000${row.item_id}`, row]));
    const next = new Map(documents.map((document) => [`${document.sourceId}\u0000${document.id}`, { ...document, hash: documentHash(document) }]));
    const changed = [...next.values()].filter((document) => current.get(`${document.sourceId}\u0000${document.id}`)?.content_hash !== document.hash);
    const removed = [...current.keys()].filter((key) => !next.has(key));
    if (changed.length === 0 && removed.length === 0) return;
    this.#setStatus({ phase: initial ? "indexing" : "updating", progress: 0, message: null });
    const changedCorpus = [];
    for (let offset = 0; offset < changed.length; offset += 16) {
      if (this.cancelled) throw new Error("Indexation annulée.");
      const chunk = changed.slice(offset, offset + 16);
      const result = await workerRequest(this.worker, "embed", { texts: chunk.map(searchText) });
      result.forEach((buffer, index) => {
        const document = chunk[index];
        const quantized = quantizeVector(new Float32Array(buffer));
        changedCorpus.push({
          document,
          id: `${document.sourceId}\u0000${document.id}`,
          vector: quantized.vector,
          norm: quantized.norm,
        });
      });
      this.#setStatus({ phase: initial ? "indexing" : "updating", progress: (offset + chunk.length) / changed.length });
    }
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const remove = this.database.prepare("DELETE FROM documents WHERE item_id = ?");
      const removeFts = this.database.prepare("DELETE FROM documents_fts WHERE item_id = ?");
      for (const key of removed) { const itemId = key.slice(key.indexOf("\u0000") + 1); remove.run(itemId); removeFts.run(itemId); }
      const upsert = this.database.prepare(`INSERT INTO documents (item_id, source_id, content_hash, vector, norm, indexed_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET source_id = excluded.source_id, content_hash = excluded.content_hash, vector = excluded.vector, norm = excluded.norm, indexed_at = excluded.indexed_at`);
      const insertFts = this.database.prepare("INSERT INTO documents_fts (item_id, title, summary) VALUES (?, ?, ?)");
      changedCorpus.forEach(({ document, vector, norm }) => {
        removeFts.run(document.id);
        upsert.run(document.id, document.sourceId, document.hash, vector, norm, new Date().toISOString());
        insertFts.run(document.id, document.title, document.summary ?? "");
      });
      this.database.exec("COMMIT;");
    } catch (error) { this.database.exec("ROLLBACK;"); throw error; }
    const workerDocuments = changedCorpus.map(({ id, vector, norm }) => ({
      id,
      vector: vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength),
      norm,
    }));
    await workerRequest(
      this.worker,
      "patch-corpus",
      { documents: workerDocuments, removedIds: removed },
      workerDocuments.map(({ vector }) => vector),
    );
    if (!initial) {
      this.#setStatus({ phase: "ready", progress: 1, message: null, bytes: await this.#usedBytes() });
    }
  }

  #lexicalCandidateIds(query, sourceIds) {
    return lexicalCandidateIds(this.database, query, sourceIds);
  }

  #hydrateResult(itemIds, mode) {
    const resultIds = itemIds.slice(0, MAX_SEARCH_RESULTS);
    const byId = new Map(this.getItems(resultIds).map((item) => [item.id, item]));
    return {
      items: resultIds.map((id) => byId.get(id)).filter(Boolean),
      truncated: itemIds.length > MAX_SEARCH_RESULTS,
      mode,
    };
  }

  async #runHybridSearch({ normalized, sourceIds, lexical }) {
    const semantic = await workerRequest(this.worker, "search", {
      query: `query: ${normalized}`,
      sourceIds,
    });
    const resultIds = hybridCandidateIds(lexical, semantic.map(([itemId]) => itemId));
    return this.#hydrateResult(resultIds, "hybrid");
  }

  async search({ query, sourceIds, mode }) {
    const normalized = normalizeSearchQuery(query);
    const normalizedMode = normalizeSearchMode(mode);
    if (this.testMode) {
      const foldedQuery = normalized.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
      const terms = foldedQuery.match(/[\p{L}\p{N}]+/gu) ?? [];
      const allowedSources = new Set(sourceIds);
      const matched = this.getDocuments()
        .filter(({ sourceId }) => allowedSources.has(sourceId))
        .map((document) => ({
          ...document,
          folded: `${document.title}\n${document.summary ?? ""}`
            .normalize("NFD")
            .replace(/\p{M}/gu, "")
            .toLowerCase(),
        }))
        .filter(({ folded }) => terms.every((term) => folded.includes(term)))
        .sort((first, second) => {
          const firstExact = first.folded.includes(foldedQuery) ? 1 : 0;
          const secondExact = second.folded.includes(foldedQuery) ? 1 : 0;
          return secondExact - firstExact || first.id.localeCompare(second.id);
        });
      const ids = matched.map(({ id }) => id);
      const byId = new Map(this.getItems(ids.slice(0, MAX_SEARCH_RESULTS)).map((item) => [item.id, item]));
      return {
        items: ids.slice(0, MAX_SEARCH_RESULTS).map((id) => byId.get(id)).filter(Boolean),
        truncated: ids.length > MAX_SEARCH_RESULTS,
        mode: normalizedMode,
      };
    }
    if (!["ready", "updating"].includes(this.status.phase) || !this.database || !this.worker) {
      throw new Error("La recherche locale n’est pas encore prête.");
    }
    if (!Array.isArray(sourceIds) || sourceIds.length === 0) {
      return { items: [], truncated: false, mode: normalizedMode };
    }
    const lexical = this.#lexicalCandidateIds(normalized, sourceIds);
    if (normalizedMode === "lexical") return this.#hydrateResult(lexical, "lexical");
    return this.#track(this.hybridSearchQueue.enqueue({ normalized, sourceIds, lexical }));
  }

  removeData() {
    if (this.removal) return this.removal;
    this.cancelled = true;
    if (this.testMode) {
      this.#setStatus({ phase: "not-installed", progress: 0, message: null, bytes: 0 });
      return Promise.resolve();
    }
    this.stopping = true;
    this.syncPending = false;
    this.downloadController?.abort();
    this.hybridSearchQueue.close(new Error("La recherche locale a été supprimée."));
    this.removal = this.#removeData().finally(() => {
      this.removal = null;
    });
    return this.removal;
  }

  async #removeData() {
    try {
      const worker = this.worker;
      this.worker = null;
      await worker?.terminate();
      await Promise.allSettled([...this.activeOperations]);
      const lateWorker = this.worker;
      this.worker = null;
      await lateWorker?.terminate();
      this.database?.close();
      this.database = null;
      this.hybridSearchQueue = new LatestTaskQueue((payload) => this.#runHybridSearch(payload));
      const removalErrors = [];
      try {
        await this.removeRootPath(this.rootPath);
      } catch (error) {
        removalErrors.push(error);
      }
      try {
        await this.removeModelPaths([this.modelPath, ...this.legacyModelPaths]);
      } catch (error) {
        removalErrors.push(error);
      }
      if (removalErrors.length > 0) {
        throw new AggregateError(removalErrors, "Les données de recherche locale n’ont pas pu être entièrement supprimées.");
      }
      this.#setStatus({ phase: "not-installed", progress: 0, message: null, bytes: 0 });
    } catch (error) {
      this.#setStatus({
        phase: "error",
        progress: 0,
        message: "Les données de recherche locale n’ont pas pu être entièrement supprimées.",
        bytes: await this.#usedBytes(),
      });
      throw error;
    } finally {
      this.downloadController = null;
      this.cancelled = false;
      this.stopping = false;
    }
  }

  async #resetIndex() { this.database?.close(); this.database = null; await rm(this.indexPath, { force: true }); await rm(`${this.indexPath}-wal`, { force: true }); await rm(`${this.indexPath}-shm`, { force: true }); }
  async #adoptLegacyModel() {
    return adoptLegacySemanticModel({
      modelPath: this.modelPath,
      legacyModelPaths: this.legacyModelPaths,
      modelFiles: this.modelFiles,
    });
  }
  async #usedBytes() {
    let bytes = await semanticModelBytes(this.modelPath, this.modelFiles);
    for (const file of [this.indexPath, `${this.indexPath}-wal`, `${this.indexPath}-shm`]) {
      try { bytes += (await stat(file)).size; } catch {}
    }
    return bytes;
  }
  async close() {
    this.cancelled = true;
    if (this.testMode) return;
    this.stopping = true;
    this.syncPending = false;
    this.downloadController?.abort();
    this.hybridSearchQueue.close(new Error("La recherche locale est fermée."));
    const worker = this.worker;
    this.worker = null;
    await worker?.terminate();
    await Promise.allSettled([...this.activeOperations]);
    this.database?.close();
    this.database = null;
    this.downloadController = null;
  }
}

export function assertModelDownloadUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !ALLOWED_MODEL_HOSTS.has(url.hostname) || url.username || url.password) throw new Error("Origine du modèle local refusée.");
  return url;
}
