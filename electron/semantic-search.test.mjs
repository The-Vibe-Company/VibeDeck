import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  SEMANTIC_VECTOR_DIMENSIONS,
  LatestTaskQueue,
  SearchSupersededError,
  assertModelDownloadUrl,
  documentHash,
  hybridCandidateIds,
  lexicalCandidateIds,
  normalizeSearchQuery,
  normalizeSearchMode,
  quantizeVector,
  reciprocalRankFusion,
} from "./semantic-search.mjs";

test("normalizes and bounds local search queries", () => {
  assert.equal(normalizeSearchQuery("  hausse\n des   prix "), "hausse des prix");
  assert.throws(() => normalizeSearchQuery("x"), /entre 2/);
  assert.throws(() => normalizeSearchQuery("x".repeat(241)), /240/);
});

test("accepts only explicit lexical and hybrid search modes", () => {
  assert.equal(normalizeSearchMode("lexical"), "lexical");
  assert.equal(normalizeSearchMode("hybrid"), "hybrid");
  assert.throws(() => normalizeSearchMode("live"), /Mode de recherche invalide/);
});

test("keeps one running task and replaces an obsolete pending inference", async () => {
  const resolvers = [];
  const started = [];
  const queue = new LatestTaskQueue((value) => new Promise((resolve) => {
    started.push(value);
    resolvers.push(resolve);
  }));

  const first = queue.enqueue("first");
  const obsolete = queue.enqueue("obsolete");
  const latest = queue.enqueue("latest");
  await assert.rejects(obsolete, SearchSupersededError);
  assert.deepEqual(started, ["first"]);

  resolvers.shift()("first-result");
  assert.equal(await first, "first-result");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["first", "latest"]);
  resolvers.shift()("latest-result");
  assert.equal(await latest, "latest-result");
});

test("hashes content deterministically and stores compact int8 vectors", () => {
  const document = { title: "Inflation", summary: "Les prix progressent." };
  assert.equal(documentHash(document), documentHash({ ...document }));
  assert.notEqual(documentHash(document), documentHash({ ...document, summary: "Autre résumé." }));
  const vector = Float32Array.from({ length: SEMANTIC_VECTOR_DIMENSIONS }, (_, index) => index % 2 ? -0.5 : 0.5);
  const encoded = quantizeVector(vector);
  assert.equal(encoded.vector.byteLength, SEMANTIC_VECTOR_DIMENSIONS);
  assert.ok(encoded.norm > 0);
});

test("merges lexical and semantic candidates with stable reciprocal ranks", () => {
  assert.deepEqual(
    reciprocalRankFusion([["exact", "semantic"], ["semantic", "other"]]),
    ["semantic", "exact", "other"],
  );
});

test("weights lexical relevance at 60 percent and semantic relevance at 40 percent", () => {
  assert.deepEqual(
    hybridCandidateIds(["keyword", "shared"], ["semantic", "shared"]),
    ["shared", "keyword", "semantic"],
  );
  assert.deepEqual(
    hybridCandidateIds(["keyword"], ["semantic"]),
    ["keyword", "semantic"],
  );
});

test("ranks lexical candidates with title weight before summary and stable id ties", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE documents (item_id TEXT PRIMARY KEY, source_id TEXT NOT NULL);
    CREATE VIRTUAL TABLE documents_fts USING fts5(
      item_id UNINDEXED, title, summary, tokenize = 'unicode61 remove_diacritics 2'
    );
  `);
  const insertDocument = database.prepare("INSERT INTO documents VALUES (?, ?)");
  const insertFts = database.prepare("INSERT INTO documents_fts VALUES (?, ?, ?)");
  for (const document of [
    { id: "title-a", source: "source-a", title: "priorité", summary: "" },
    { id: "title-z", source: "source-a", title: "priorité", summary: "" },
    { id: "summary", source: "source-a", title: "veille", summary: "priorité" },
    { id: "other-source", source: "source-b", title: "priorité", summary: "" },
  ]) {
    insertDocument.run(document.id, document.source);
    insertFts.run(document.id, document.title, document.summary);
  }

  assert.deepEqual(
    lexicalCandidateIds(database, "priorite", ["source-a"]),
    ["title-a", "title-z", "summary"],
  );
  assert.deepEqual(lexicalCandidateIds(database, "priorite", []), []);
  database.close();
});

test("breaks equal relevance without recency and validates fusion weights", () => {
  assert.deepEqual(
    reciprocalRankFusion([["z-result"], ["a-result"]], { weights: [1, 1] }),
    ["a-result", "z-result"],
  );
  assert.throws(
    () => reciprocalRankFusion([["article"]], { weights: [] }),
    /Chaque classement/,
  );
  assert.throws(
    () => reciprocalRankFusion([["article"]], { weights: [0] }),
    /Poids de fusion invalide/,
  );
});

test("allows only the explicit HTTPS model origins", () => {
  assert.equal(assertModelDownloadUrl("https://huggingface.co/Xenova/model").hostname, "huggingface.co");
  assert.equal(assertModelDownloadUrl("https://us.aws.cdn.hf.co/model").hostname, "us.aws.cdn.hf.co");
  assert.equal(
    assertModelDownloadUrl("https://cas-bridge.xethub.hf.co/model").hostname,
    "cas-bridge.xethub.hf.co",
  );
  for (const unsafeUrl of [
    "https://example.test/model",
    "http://huggingface.co/model",
    "https://token@cas-bridge.xethub.hf.co/model",
    "https://other.xethub.hf.co/model",
    "https://cas-bridge.xethub.hf.co.attacker.test/model",
  ]) {
    assert.throws(() => assertModelDownloadUrl(unsafeUrl), /refusée/);
  }
});
