import { parentPort } from "node:worker_threads";

if (!parentPort) throw new Error("Le worker de recherche doit avoir un port parent.");

let extractor = null;
let corpus = new Map();

function normalize(vector) {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum) || 1;
  return Float32Array.from(vector, (value) => value / norm);
}

async function loadModel(modelPath) {
  const { env, pipeline } = await import("@huggingface/transformers");
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.useBrowserCache = false;
  env.localModelPath = modelPath;
  extractor = await pipeline("feature-extraction", modelPath, {
    dtype: "q8",
    local_files_only: true,
  });
}

async function embed(texts) {
  if (!extractor) throw new Error("Le modèle de recherche locale n’est pas chargé.");
  const vectors = [];
  for (const text of texts) {
    const output = await extractor(text, { pooling: "mean", normalize: true });
    vectors.push(Float32Array.from(output.data));
  }
  return vectors;
}

function setCorpus(documents) {
  corpus = new Map(
    documents.map(({ id, vector }) => [id, new Int8Array(vector)]),
  );
}

function patchCorpus(documents, removedIds) {
  for (const id of removedIds) corpus.delete(id);
  for (const { id, vector } of documents) corpus.set(id, new Int8Array(vector));
}

function semanticCandidates(queryVector, sourceIds) {
  const sources = sourceIds ? new Set(sourceIds) : null;
  const scores = [];
  for (const [id, entry] of corpus) {
    if (sources && !sources.has(id.split("\u0000", 1)[0])) continue;
    let score = 0;
    for (let index = 0; index < queryVector.length; index += 1) {
      score += queryVector[index] * (entry[index] / 127);
    }
    scores.push([id.slice(id.indexOf("\u0000") + 1), score]);
  }
  scores.sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0]));
  const bestScore = scores[0]?.[1] ?? -1;
  const threshold = Math.max(0.72, bestScore - 0.1);
  return scores.filter(([, score]) => score >= threshold).slice(0, 201);
}

async function handleMessage({ id, action, payload }) {
  try {
    if (action === "load") {
      await loadModel(payload.modelPath);
      parentPort.postMessage({ id, result: true });
      return;
    }
    if (action === "embed") {
      const vectors = await embed(payload.texts);
      parentPort.postMessage({ id, result: vectors.map((vector) => vector.buffer) }, vectors.map((vector) => vector.buffer));
      return;
    }
    if (action === "set-corpus") {
      setCorpus(payload.documents);
      parentPort.postMessage({ id, result: true });
      return;
    }
    if (action === "patch-corpus") {
      patchCorpus(payload.documents, payload.removedIds);
      parentPort.postMessage({ id, result: true });
      return;
    }
    if (action === "search") {
      const [queryVector] = await embed([payload.query]);
      parentPort.postMessage({
        id,
        result: semanticCandidates(queryVector, payload.sourceIds),
      });
      return;
    }
    throw new Error("Action de recherche inconnue.");
  } catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : "Erreur de recherche locale." });
  }
}

let messageQueue = Promise.resolve();
parentPort.on("message", (message) => {
  messageQueue = messageQueue.then(() => handleMessage(message));
});
