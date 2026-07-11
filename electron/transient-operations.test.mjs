import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanSourceProbeId,
  cleanWebPreviewId,
  createLatestAbortOperationRegistry,
  createWebPreviewAuthorizationStore,
} from "./transient-operations.mjs";

const UUID_A = "123e4567-e89b-42d3-a456-426614174000";
const UUID_B = "223e4567-e89b-42d3-a456-426614174000";

test("accepts only strict transient UUIDs at the main-process boundary", () => {
  assert.equal(cleanSourceProbeId(` ${UUID_A} `), UUID_A);
  assert.equal(cleanWebPreviewId(` draft:${UUID_A} `), `draft:${UUID_A}`);
  for (const invalid of [null, "", "draft:not-a-uuid", UUID_A]) {
    assert.throws(() => cleanWebPreviewId(invalid), /Identifiant d’aperçu web invalide/);
  }
  for (const invalid of [null, "", `draft:${UUID_A}`, "not-a-uuid"]) {
    assert.throws(() => cleanSourceProbeId(invalid), /Identifiant de test de source invalide/);
  }
});

test("supersedes one probe per owner without letting a stale cancel stop the new probe", () => {
  const owner = {};
  const registry = createLatestAbortOperationRegistry();
  const first = registry.start(owner, UUID_A);
  const second = registry.start(owner, UUID_B);

  assert.equal(first.controller.signal.aborted, true);
  assert.equal(second.controller.signal.aborted, false);
  assert.equal(registry.cancel(owner, UUID_A), false);
  assert.equal(second.controller.signal.aborted, false);
  assert.equal(registry.cancel(owner, UUID_B), true);
  assert.equal(second.controller.signal.aborted, true);
  assert.equal(registry.current(owner), null);
});

test("finishes only the current probe operation", () => {
  const owner = {};
  const registry = createLatestAbortOperationRegistry();
  const first = registry.start(owner, UUID_A);
  const second = registry.start(owner, UUID_B);

  assert.equal(registry.finish(owner, first), false);
  assert.equal(registry.current(owner), second);
  assert.equal(registry.finish(owner, second), true);
  assert.equal(registry.current(owner), null);
});

test("keeps the previous web authorization when native preview startup fails", () => {
  const owner = {};
  const store = createWebPreviewAuthorizationStore();
  const previous = store.start(
    owner,
    { previewId: `draft:${UUID_A}`, url: "https://one.test/" },
    () => undefined,
  );

  assert.throws(
    () => store.start(
      owner,
      { previewId: `draft:${UUID_A}`, url: "https://two.test/" },
      () => {
        throw new Error("allocation impossible");
      },
    ),
    /allocation impossible/,
  );
  assert.equal(store.current(owner), previous);
  assert.throws(
    () => store.start(
      owner,
      { previewId: `draft:${UUID_B}`, url: "https://two.test/" },
      () => undefined,
    ),
    /autre aperçu web est déjà ouvert/,
  );
});

test("commits only the main-owned URL and preserves authorization after failure", async () => {
  const owner = {};
  const store = createWebPreviewAuthorizationStore();
  const previewId = `draft:${UUID_A}`;
  store.start(
    owner,
    { previewId, url: "https://authorized.test/" },
    () => undefined,
  );

  await assert.rejects(
    store.commit(owner, previewId, async ({ url }) => {
      assert.equal(url, "https://authorized.test/");
      throw new Error("écriture impossible");
    }),
    /écriture impossible/,
  );
  assert.equal(store.require(owner, previewId).url, "https://authorized.test/");

  const result = await store.commit(owner, previewId, async ({ url }) => ({ url }));
  assert.deepEqual(result, { url: "https://authorized.test/" });
  assert.equal(store.current(owner), null);
  assert.throws(() => store.require(owner, previewId), /plus disponible/);
});

test("allows only one concurrent commit for a web preview authorization", async () => {
  const owner = {};
  const store = createWebPreviewAuthorizationStore();
  const previewId = `draft:${UUID_A}`;
  let resolveCommit;
  const commitGate = new Promise((resolve) => {
    resolveCommit = resolve;
  });
  let commitCount = 0;
  store.start(
    owner,
    { previewId, url: "https://authorized.test/" },
    () => undefined,
  );

  const first = store.commit(owner, previewId, async () => {
    commitCount += 1;
    await commitGate;
    return "created";
  });
  await assert.rejects(
    store.commit(owner, previewId, async () => {
      commitCount += 1;
    }),
    /déjà en cours/,
  );
  assert.equal(store.cancel(owner, previewId), null);
  assert.equal(commitCount, 1);
  resolveCommit();
  assert.equal(await first, "created");
  assert.equal(store.current(owner), null);
});

test("revokes web authorization only for the matching id or explicit owner clear", () => {
  const owner = {};
  const store = createWebPreviewAuthorizationStore();
  const previewId = `draft:${UUID_A}`;
  store.start(
    owner,
    { previewId, url: "https://authorized.test/" },
    () => undefined,
  );

  assert.equal(store.cancel(owner, `draft:${UUID_B}`), null);
  assert.equal(store.current(owner)?.previewId, previewId);
  assert.equal(store.clear(owner)?.previewId, previewId);
  assert.equal(store.current(owner), null);
});
