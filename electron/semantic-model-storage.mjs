import { createHash } from "node:crypto";
import { copyFile, chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

export const VIBEDECK_STORAGE_ID = "com.thevibecompany.vibedeck";

function uniquePaths(paths) {
  return [...new Set(paths.map((candidate) => path.resolve(candidate)))];
}

export function resolvePackagedSemanticModelPaths({ appDataPath, userDataPath }) {
  if (!path.isAbsolute(appDataPath) || !path.isAbsolute(userDataPath)) {
    throw new TypeError("Les chemins du modèle local doivent être absolus.");
  }
  const modelPath = path.join(
    appDataPath,
    VIBEDECK_STORAGE_ID,
    "semantic-search",
    "model",
  );
  const legacyModelPaths = uniquePaths([
    path.join(userDataPath, "semantic-search", "model"),
    path.join(appDataPath, "VibeDeck", "semantic-search", "model"),
    path.join(appDataPath, "vibedeck", "semantic-search", "model"),
    path.join(appDataPath, "MediaGen Veille", "semantic-search", "model"),
    path.join(appDataPath, "mediagen-veille", "semantic-search", "model"),
  ]).filter((candidate) => candidate !== path.resolve(modelPath));
  return { modelPath, legacyModelPaths };
}

export async function validSemanticModelFile(file, entry) {
  try {
    if ((await stat(file)).size !== entry.size) return false;
    const digest = createHash("sha256");
    const { createReadStream } = await import("node:fs");
    await new Promise((resolve, reject) => createReadStream(file)
      .on("data", (chunk) => digest.update(chunk))
      .on("end", resolve)
      .on("error", reject));
    return digest.digest("hex") === entry.sha256;
  } catch {
    return false;
  }
}

export async function semanticModelIsInstalled(modelPath, modelFiles) {
  for (const entry of modelFiles) {
    if (!(await validSemanticModelFile(path.join(modelPath, entry.file), entry))) return false;
  }
  return true;
}

async function pathExists(candidate) {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

export async function replaceSemanticModel({
  modelPath,
  preparedModelPath,
  modelFiles,
  renameImpl = rename,
}) {
  if (!(await semanticModelIsInstalled(preparedModelPath, modelFiles))) {
    throw new Error("Le nouveau modèle local préparé est invalide.");
  }
  const backupPath = `${modelPath}.replacing`;
  await mkdir(path.dirname(modelPath), { recursive: true });
  let hasBackup = await pathExists(backupPath);
  if (!hasBackup && await pathExists(modelPath)) {
    await renameImpl(modelPath, backupPath);
    hasBackup = true;
  } else if (hasBackup) {
    await rm(modelPath, { force: true, recursive: true });
  }
  try {
    await renameImpl(preparedModelPath, modelPath);
  } catch (error) {
    if (hasBackup && !(await pathExists(modelPath))) {
      try {
        await renameImpl(backupPath, modelPath);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Le remplacement du modèle local et sa restauration ont échoué.",
        );
      }
    }
    throw error;
  }
  await rm(backupPath, { force: true, recursive: true });
}

async function copyModel(sourcePath, destinationPath, modelFiles, copyFileImpl) {
  await rm(destinationPath, { force: true, recursive: true });
  for (const entry of modelFiles) {
    const destination = path.join(destinationPath, entry.file);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFileImpl(path.join(sourcePath, entry.file), destination);
    await chmod(destination, 0o600);
  }
}

export async function adoptLegacySemanticModel({
  modelPath,
  legacyModelPaths,
  modelFiles,
  copyFileImpl = copyFile,
}) {
  const stagingPath = `${modelPath}.migrating`;
  const downloadPath = `${modelPath}.downloading`;
  if (await semanticModelIsInstalled(modelPath, modelFiles)) {
    await Promise.allSettled(
      [
        ...uniquePaths(legacyModelPaths)
          .filter((candidate) => candidate !== path.resolve(modelPath)),
        downloadPath,
        stagingPath,
        `${modelPath}.replacing`,
      ].map((candidate) => rm(candidate, { force: true, recursive: true })),
    );
    return true;
  }

  if (await semanticModelIsInstalled(downloadPath, modelFiles)) {
    await replaceSemanticModel({ modelPath, preparedModelPath: downloadPath, modelFiles });
    return true;
  }
  await rm(downloadPath, { force: true, recursive: true });

  if (await semanticModelIsInstalled(stagingPath, modelFiles)) {
    await replaceSemanticModel({ modelPath, preparedModelPath: stagingPath, modelFiles });
    return true;
  }
  await rm(stagingPath, { force: true, recursive: true });

  for (const legacyPath of uniquePaths(legacyModelPaths)) {
    if (legacyPath === path.resolve(modelPath)) continue;
    if (!(await semanticModelIsInstalled(legacyPath, modelFiles))) continue;
    try {
      await mkdir(path.dirname(modelPath), { recursive: true });
      await copyModel(legacyPath, stagingPath, modelFiles, copyFileImpl);
      if (!(await semanticModelIsInstalled(stagingPath, modelFiles))) {
        throw new Error("La copie du modèle local est invalide.");
      }
      await replaceSemanticModel({ modelPath, preparedModelPath: stagingPath, modelFiles });
      await rm(legacyPath, { force: true, recursive: true });
      return true;
    } catch (error) {
      await rm(stagingPath, { force: true, recursive: true });
      throw error;
    }
  }
  return false;
}

export async function semanticModelBytes(modelPath, modelFiles) {
  let bytes = 0;
  for (const entry of modelFiles) {
    try {
      bytes += (await stat(path.join(modelPath, entry.file))).size;
    } catch {}
  }
  return bytes;
}

export async function removeSemanticModelPaths(paths, { rmImpl = rm } = {}) {
  const results = await Promise.allSettled(uniquePaths(paths).flatMap((candidate) => [
    rmImpl(candidate, { force: true, recursive: true }),
    rmImpl(`${candidate}.downloading`, { force: true, recursive: true }),
    rmImpl(`${candidate}.migrating`, { force: true, recursive: true }),
    rmImpl(`${candidate}.replacing`, { force: true, recursive: true }),
  ]));
  const errors = results
    .filter(({ status }) => status === "rejected")
    .map(({ reason }) => reason);
  if (errors.length > 0) {
    throw new AggregateError(errors, "Certaines copies du modèle local n’ont pas pu être supprimées.");
  }
}
