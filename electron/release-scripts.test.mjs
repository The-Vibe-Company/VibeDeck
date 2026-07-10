import assert from "node:assert/strict";
import test from "node:test";

import {
  moveBundle,
  PreservedBundleMoveError,
  shouldPreserveSigningDirectory,
} from "../scripts/after-sign.mjs";
import { findUnsafeWorkflowUses } from "../scripts/workflow-uses.mjs";

function crossDeviceError() {
  const error = new Error("cross-device link not permitted");
  error.code = "EXDEV";
  return error;
}

test("moves a bundle with rename when both paths share a volume", async () => {
  const calls = [];
  await moveBundle("/source/App.app", "/target/App.app", {
    renamePath: async (...args) => calls.push(["rename", ...args]),
    copyPath: async (...args) => calls.push(["copy", ...args]),
    removePath: async (...args) => calls.push(["remove", ...args]),
  });

  assert.deepEqual(calls, [["rename", "/source/App.app", "/target/App.app"]]);
});

test("copies and removes a bundle in both directions after EXDEV", async () => {
  const calls = [];
  const operations = {
    renamePath: async (...args) => {
      calls.push(["rename", ...args]);
      throw crossDeviceError();
    },
    copyPath: async (...args) => calls.push(["copy", ...args]),
    removePath: async (...args) => calls.push(["remove", ...args]),
  };

  await moveBundle("/external/App.app", "/tmp/App.app", operations);
  await moveBundle("/tmp/App.app", "/external/App.app", operations);

  const copyOptions = {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  };
  assert.deepEqual(calls, [
    ["rename", "/external/App.app", "/tmp/App.app"],
    ["copy", "/external/App.app", "/tmp/App.app", copyOptions],
    ["remove", "/external/App.app", { recursive: true, force: false }],
    ["rename", "/tmp/App.app", "/external/App.app"],
    ["copy", "/tmp/App.app", "/external/App.app", copyOptions],
    ["remove", "/tmp/App.app", { recursive: true, force: false }],
  ]);
});

test("cleans an incomplete EXDEV copy and preserves non-EXDEV errors", async () => {
  const copyError = new Error("copy failed");
  const cleanupCalls = [];
  await assert.rejects(
    moveBundle("/source/App.app", "/target/App.app", {
      renamePath: async () => {
        throw crossDeviceError();
      },
      copyPath: async () => {
        throw copyError;
      },
      removePath: async (...args) => cleanupCalls.push(args),
    }),
    (error) => error === copyError,
  );
  assert.deepEqual(cleanupCalls, [
    ["/target/App.app", { recursive: true, force: true }],
  ]);

  const renameError = Object.assign(new Error("permission denied"), { code: "EACCES" });
  await assert.rejects(
    moveBundle("/source/App.app", "/target/App.app", {
      renamePath: async () => {
        throw renameError;
      },
      copyPath: async () => assert.fail("copy must not run"),
      removePath: async () => assert.fail("remove must not run"),
    }),
    (error) => error === renameError,
  );
});

test("preserves a completed EXDEV copy when the source cannot be removed", async () => {
  const removalError = new Error("source removal failed");
  const removalCalls = [];
  await assert.rejects(
    moveBundle("/source/App.app", "/target/App.app", {
      renamePath: async () => {
        throw crossDeviceError();
      },
      copyPath: async () => {},
      removePath: async (...args) => {
        removalCalls.push(args);
        if (args[0] === "/source/App.app") throw removalError;
      },
    }),
    (error) => {
      assert.ok(error instanceof PreservedBundleMoveError);
      assert.equal(error.code, "ERR_BUNDLE_MOVE_SOURCE_REMOVAL");
      assert.equal(error.cause, removalError);
      assert.equal(error.sourcePath, "/source/App.app");
      assert.equal(error.preservedDestinationPath, "/target/App.app");
      assert.match(error.message, /source\/App\.app/);
      assert.match(error.message, /target\/App\.app/);
      return true;
    },
  );
  assert.deepEqual(removalCalls, [
    ["/source/App.app", { recursive: true, force: false }],
  ]);
});

test("keeps staging when it owns an active or explicitly preserved bundle", () => {
  const stagedAppPath = "/tmp/signing/App.app";
  assert.equal(
    shouldPreserveSigningDirectory({
      appIsStaged: true,
      operationError: null,
      stagedAppPath,
    }),
    true,
  );
  assert.equal(
    shouldPreserveSigningDirectory({
      appIsStaged: false,
      operationError: { preservedDestinationPath: stagedAppPath },
      stagedAppPath,
    }),
    true,
  );
  assert.equal(
    shouldPreserveSigningDirectory({
      appIsStaged: false,
      operationError: { preservedDestinationPath: "/other/App.app" },
      stagedAppPath,
    }),
    false,
  );
});

test("parses quoted, flow, aliased and multiline uses pinned to a full commit SHA", () => {
  const firstSha = "a".repeat(40);
  const secondSha = "B".repeat(40);
  const workflow = `
shared-action: &shared-action another-owner/action/subpath@${secondSha}
steps:
  - uses: actions/checkout@${firstSha} # v4
  - { "uses": *shared-action }
  - 'uses': >-
      third-owner/action@${firstSha}
reusable-job:
  { "uses": "organization/repository/.github/workflows/reusable.yml@${firstSha}" }
`;

  assert.deepEqual(findUnsafeWorkflowUses(workflow, "fixture.yml"), []);
});

test("reports mutable, suffixed, local, Docker and expression uses in every YAML form", () => {
  const pinnedSha = "c".repeat(40);
  const workflow = `
mutable-action: &mutable-action another-owner/action@main
steps:
  - { "uses": actions/checkout@main }
  - 'uses': another-owner/action@v3
  - "\\u0075ses": another-owner/action@deadbeef
  - uses: another-owner/action
  - uses: docker://alpine@sha256:1234
  - uses: "another-owner/action@\${{ github.ref }}"
  - uses: ./local/action
  - uses: *mutable-action
  - uses: another-owner/action@${pinnedSha}#moving
  - uses: "another-owner/action@${pinnedSha}#also-moving"
  - uses: [another-owner/action@${pinnedSha}]
`;

  const violations = findUnsafeWorkflowUses(workflow, "unsafe.yml");
  assert.deepEqual(
    violations.map(({ workflow: name, reference }) => [name, reference]),
    [
      ["unsafe.yml", "actions/checkout@main"],
      ["unsafe.yml", "another-owner/action@v3"],
      ["unsafe.yml", "another-owner/action@deadbeef"],
      ["unsafe.yml", "another-owner/action"],
      ["unsafe.yml", "docker://alpine@sha256:1234"],
      ["unsafe.yml", "another-owner/action@${{ github.ref }}"],
      ["unsafe.yml", "./local/action"],
      ["unsafe.yml", "another-owner/action@main"],
      ["unsafe.yml", `another-owner/action@${pinnedSha}#moving`],
      ["unsafe.yml", `another-owner/action@${pinnedSha}#also-moving`],
      ["unsafe.yml", "<array>"],
    ],
  );
  assert.deepEqual(violations.map(({ path: yamlPath }) => yamlPath), [
    "$.steps[0].uses",
    "$.steps[1].uses",
    "$.steps[2].uses",
    "$.steps[3].uses",
    "$.steps[4].uses",
    "$.steps[5].uses",
    "$.steps[6].uses",
    "$.steps[7].uses",
    "$.steps[8].uses",
    "$.steps[9].uses",
    "$.steps[10].uses",
  ]);
});

test("keeps whitespace-delimited YAML comments outside an otherwise pinned reference", () => {
  const pinnedSha = "d".repeat(40);
  const workflow = `
steps:
  - uses: owner/action@${pinnedSha} # moving label, immutable value
  - { uses: "second-owner/action@${pinnedSha}" } # another comment
`;

  assert.deepEqual(findUnsafeWorkflowUses(workflow, "comments.yml"), []);
});

test("fails closed for malformed workflow YAML", () => {
  assert.throws(
    () => findUnsafeWorkflowUses("steps: [\n  - uses: owner/action@main", "broken.yml"),
    /broken\.yml.*YAML valide/,
  );
});
