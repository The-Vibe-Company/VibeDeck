import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  VIBEDECK_STORAGE_ID,
  adoptLegacySemanticModel,
  removeSemanticModelPaths,
  replaceSemanticModel,
  resolvePackagedSemanticModelPaths,
  semanticModelIsInstalled,
} from "./semantic-model-storage.mjs";

const CONTENTS = new Map([
  ["config.json", Buffer.from("configuration locale")],
  ["onnx/model.onnx", Buffer.from("modele quantifie local")],
]);
const MODEL_FILES = [...CONTENTS].map(([file, content]) => ({
  file,
  size: content.length,
  sha256: createHash("sha256").update(content).digest("hex"),
}));

async function pathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function writeModel(modelPath, { corrupt = false } = {}) {
  for (const [file, content] of CONTENTS) {
    const destination = path.join(modelPath, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, corrupt ? Buffer.from("invalide") : content);
  }
}

test("uses the packaged app-id cache and enumerates every legacy location", async () => {
  const appDataPath = path.resolve("/application-data");
  const userDataPath = path.resolve("/current-profile");
  const result = resolvePackagedSemanticModelPaths({ appDataPath, userDataPath });
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.equal(VIBEDECK_STORAGE_ID, packageJson.build.appId);
  assert.equal(
    result.modelPath,
    path.join(appDataPath, VIBEDECK_STORAGE_ID, "semantic-search", "model"),
  );
  for (const expected of [
    path.join(userDataPath, "semantic-search", "model"),
    path.join(appDataPath, "VibeDeck", "semantic-search", "model"),
    path.join(appDataPath, "vibedeck", "semantic-search", "model"),
    path.join(appDataPath, "MediaGen Veille", "semantic-search", "model"),
    path.join(appDataPath, "mediagen-veille", "semantic-search", "model"),
  ]) {
    assert.ok(result.legacyModelPaths.includes(expected), `Emplacement historique absent : ${expected}`);
  }
  assert.throws(
    () => resolvePackagedSemanticModelPaths({ appDataPath: "relative", userDataPath }),
    /absolus/,
  );
});

test("atomically adopts each valid legacy model and reuses the canonical copy", async (t) => {
  for (const legacyName of [
    "current",
    "VibeDeck",
    "vibedeck",
    "MediaGen Veille",
    "mediagen-veille",
  ]) {
    await t.test(legacyName, async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "vibedeck-model-adoption-"));
      try {
        const modelPath = path.join(directory, "canonical", "model");
        const legacyPath = path.join(directory, legacyName, "model");
        await writeModel(legacyPath);

        assert.equal(await adoptLegacySemanticModel({
          modelPath,
          legacyModelPaths: [legacyPath],
          modelFiles: MODEL_FILES,
        }), true);
        assert.equal(await semanticModelIsInstalled(modelPath, MODEL_FILES), true);
        assert.equal(await pathExists(legacyPath), false);

        let copies = 0;
        assert.equal(await adoptLegacySemanticModel({
          modelPath,
          legacyModelPaths: [legacyPath],
          modelFiles: MODEL_FILES,
          copyFileImpl: async () => { copies += 1; },
        }), true);
        assert.equal(copies, 0, "Un modèle canonique valide ne doit jamais être recopié.");
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    });
  }
});

test("recovers a verified interrupted migration before inspecting legacy copies", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibedeck-model-resume-"));
  try {
    const modelPath = path.join(directory, "canonical", "model");
    await writeModel(`${modelPath}.migrating`);
    assert.equal(await adoptLegacySemanticModel({
      modelPath,
      legacyModelPaths: [],
      modelFiles: MODEL_FILES,
    }), true);
    assert.equal(await semanticModelIsInstalled(modelPath, MODEL_FILES), true);
    assert.equal(await pathExists(`${modelPath}.migrating`), false);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("recovers a completed interrupted download without network work", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibedeck-model-download-resume-"));
  try {
    const modelPath = path.join(directory, "canonical", "model");
    await writeModel(`${modelPath}.downloading`);
    assert.equal(await adoptLegacySemanticModel({
      modelPath,
      legacyModelPaths: [],
      modelFiles: MODEL_FILES,
    }), true);
    assert.equal(await semanticModelIsInstalled(modelPath, MODEL_FILES), true);
    assert.equal(await pathExists(`${modelPath}.downloading`), false);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("keeps the legacy model intact after a copy failure and ignores invalid copies", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibedeck-model-failure-"));
  try {
    const modelPath = path.join(directory, "canonical", "model");
    const validLegacyPath = path.join(directory, "legacy-valid", "model");
    const invalidLegacyPath = path.join(directory, "legacy-invalid", "model");
    await writeModel(validLegacyPath);
    await writeModel(invalidLegacyPath, { corrupt: true });

    await assert.rejects(adoptLegacySemanticModel({
      modelPath,
      legacyModelPaths: [validLegacyPath],
      modelFiles: MODEL_FILES,
      copyFileImpl: async () => { throw new Error("copie refusée"); },
    }), /copie refusée/);
    assert.equal(await semanticModelIsInstalled(validLegacyPath, MODEL_FILES), true);
    assert.equal(await pathExists(`${modelPath}.migrating`), false);
    assert.equal(await pathExists(modelPath), false);

    assert.equal(await adoptLegacySemanticModel({
      modelPath,
      legacyModelPaths: [invalidLegacyPath],
      modelFiles: MODEL_FILES,
    }), false);
    assert.equal(await readFile(path.join(invalidLegacyPath, "config.json"), "utf8"), "invalide");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("replaces a model only after complete validation and restores it after a swap failure", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibedeck-model-replacement-"));
  try {
    const modelPath = path.join(directory, "canonical", "model");
    const preparedModelPath = path.join(directory, "prepared", "model");
    const oldContent = Buffer.from("ancien modèle encore valide");
    await mkdir(modelPath, { recursive: true });
    await writeFile(path.join(modelPath, "old.bin"), oldContent);
    await writeModel(preparedModelPath);

    await assert.rejects(replaceSemanticModel({
      modelPath,
      preparedModelPath,
      modelFiles: MODEL_FILES,
      renameImpl: async (source, destination) => {
        if (source === preparedModelPath) throw new Error("échange refusé");
        await rename(source, destination);
      },
    }), /échange refusé/);
    assert.deepEqual(await readFile(path.join(modelPath, "old.bin")), oldContent);
    assert.equal(await semanticModelIsInstalled(modelPath, MODEL_FILES), false);

    await writeModel(preparedModelPath);
    await replaceSemanticModel({ modelPath, preparedModelPath, modelFiles: MODEL_FILES });
    assert.equal(await semanticModelIsInstalled(modelPath, MODEL_FILES), true);
    assert.equal(await pathExists(`${modelPath}.replacing`), false);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("removes canonical, staging, and legacy model directories", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibedeck-model-removal-"));
  try {
    const paths = ["canonical", "legacy-a", "legacy-b"].map((name) => path.join(directory, name));
    await Promise.all(paths.map((candidate) => writeModel(candidate)));
    await writeModel(`${paths[0]}.downloading`);
    await writeModel(`${paths[0]}.migrating`);
    await writeModel(`${paths[0]}.replacing`);
    await removeSemanticModelPaths([...paths, paths[0]]);
    assert.deepEqual(
      await Promise.all([
        ...paths,
        `${paths[0]}.downloading`,
        `${paths[0]}.migrating`,
        `${paths[0]}.replacing`,
      ].map(pathExists)),
      [false, false, false, false, false, false],
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("waits for every model removal before reporting a deletion failure", async () => {
  let releaseSlowRemoval;
  const slowRemoval = new Promise((resolve) => { releaseSlowRemoval = resolve; });
  let calls = 0;
  let settled = false;
  const removal = removeSemanticModelPaths([path.resolve("/model-a")], {
    rmImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error("suppression refusée");
      await slowRemoval;
    },
  }).finally(() => { settled = true; });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 4);
  assert.equal(settled, false);
  releaseSlowRemoval();
  await assert.rejects(removal, AggregateError);
  assert.equal(settled, true);
});
