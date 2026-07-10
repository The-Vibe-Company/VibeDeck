import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_MAX_IMPORT_BYTES = 2_000_000;
export const DEFAULT_MAX_DASHBOARD_BACKUPS = 10;

export async function writeJson(filePath, value) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(filePath, serialized, { encoding: "utf8", mode: 0o600 });
}

export async function readImportedJson(
  filePath,
  { maxBytes = DEFAULT_MAX_IMPORT_BYTES } = {},
) {
  const metadata = await stat(filePath);
  if (!metadata.isFile() || metadata.size > maxBytes) {
    throw new RangeError("Le fichier de dashboard est invalide ou trop volumineux.");
  }
  const source = await readFile(filePath, "utf8");
  try {
    return JSON.parse(source);
  } catch {
    throw new TypeError("Le fichier de dashboard ne contient pas un JSON valide.");
  }
}

export async function saveDashboardBackup(
  configuration,
  {
    preferredDirectory = null,
    fallbackDirectory,
    now = () => new Date(),
    maxBackups = DEFAULT_MAX_DASHBOARD_BACKUPS,
  },
) {
  if (!fallbackDirectory) throw new TypeError("Dossier de sauvegarde local manquant.");
  const timestamp = now().toISOString().replace(/[:.]/g, "-");
  const directories = [preferredDirectory, fallbackDirectory].filter(
    (directory, index, all) => directory && all.indexOf(directory) === index,
  );
  let lastError = null;
  for (const directory of directories) {
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const filePath = path.join(directory, `dashboard-avant-import-${timestamp}.json`);
      await writeJson(filePath, configuration);
      const backups = (await readdir(directory, { withFileTypes: true }))
        .filter(
          (entry) =>
            entry.isFile() &&
            entry.name.startsWith("dashboard-avant-import-") &&
            entry.name.endsWith(".json"),
        )
        .map(({ name }) => name)
        .sort()
        .reverse();
      await Promise.allSettled(
        backups.slice(maxBackups).map((name) => unlink(path.join(directory, name))),
      );
      return filePath;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("Sauvegarde du dashboard impossible.");
}

export async function backupAndImportDashboard({
  engine,
  configuration,
  preferredDirectory,
  fallbackDirectory,
  now,
}) {
  const backupFilePath = await saveDashboardBackup(engine.exportDashboardConfig(), {
    preferredDirectory,
    fallbackDirectory,
    now,
  });
  const state = await engine.importDashboardConfig(configuration);
  return { state, backupFilePath };
}
