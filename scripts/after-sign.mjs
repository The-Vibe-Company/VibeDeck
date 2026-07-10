import { execFile } from "node:child_process";
import { cp, mkdtemp, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CROSS_DEVICE_COPY_OPTIONS = Object.freeze({
  recursive: true,
  force: false,
  errorOnExist: true,
  preserveTimestamps: true,
  // Electron frameworks contain relative symlinks. Resolving them while
  // copying would leave links pointing back to the bundle that is removed.
  verbatimSymlinks: true,
});

export class PreservedBundleMoveError extends Error {
  constructor(sourcePath, preservedDestinationPath, cause) {
    super(
      `La copie inter-volume est complète à ${preservedDestinationPath}, mais la suppression de la source a échoué à ${sourcePath}. Les deux chemins doivent être vérifiés.`,
      { cause },
    );
    this.name = "PreservedBundleMoveError";
    this.code = "ERR_BUNDLE_MOVE_SOURCE_REMOVAL";
    this.sourcePath = sourcePath;
    this.preservedDestinationPath = preservedDestinationPath;
  }
}

export function shouldPreserveSigningDirectory({
  appIsStaged,
  operationError,
  stagedAppPath,
}) {
  return (
    appIsStaged === true || operationError?.preservedDestinationPath === stagedAppPath
  );
}

/**
 * Move an application bundle without assuming that both paths share a volume.
 * The injected operations keep the EXDEV and rollback paths deterministic in
 * unit tests while production continues to use node:fs/promises.
 */
export async function moveBundle(
  sourcePath,
  destinationPath,
  {
    renamePath = rename,
    copyPath = cp,
    removePath = rm,
  } = {},
) {
  try {
    await renamePath(sourcePath, destinationPath);
    return;
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
  }

  try {
    await copyPath(sourcePath, destinationPath, CROSS_DEVICE_COPY_OPTIONS);
  } catch (copyError) {
    try {
      await removePath(destinationPath, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [copyError, cleanupError],
        `Impossible de nettoyer la copie incomplète : ${destinationPath}`,
      );
    }
    throw copyError;
  }

  try {
    await removePath(sourcePath, { recursive: true, force: false });
  } catch (removalError) {
    // `cp` completed successfully, so this destination is now the recovery
    // copy. Never delete it: recursive source removal can fail after doing only
    // part of its work.
    throw new PreservedBundleMoveError(sourcePath, destinationPath, removalError);
  }
}

/**
 * Flipping Electron fuses invalidates the linker signature embedded in the
 * stock macOS framework. Signed releases are re-signed with Developer ID by
 * electron-builder. Local/CI unsigned builds still need a final ad-hoc seal so
 * macOS can launch the exact hardened binary that was packaged.
 */
export default async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY !== "false") return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  const signingDirectory = await mkdtemp(path.join(os.tmpdir(), "vibedeck-adhoc-sign-"));
  const stagedAppPath = path.join(signingDirectory, appName);
  let appIsStaged = false;
  let operationError = null;

  try {
    // File Provider workspaces can re-attach provenance metadata immediately
    // after xattr removes it. Stage the disposable unsigned bundle outside the
    // synced workspace while it is sealed, then move the exact bundle back.
    await moveBundle(appPath, stagedAppPath);
    appIsStaged = true;
    await execFileAsync("/usr/bin/xattr", ["-cr", stagedAppPath]);
    await execFileAsync("/usr/bin/codesign", [
      "--force",
      "--deep",
      "--sign",
      "-",
      "--timestamp=none",
      stagedAppPath,
    ]);
  } catch (error) {
    operationError = error;
  }

  let restorationError = null;
  if (appIsStaged) {
    try {
      await moveBundle(stagedAppPath, appPath);
      appIsStaged = false;
    } catch (error) {
      restorationError = error;
    }
  }

  if (
    !shouldPreserveSigningDirectory({ appIsStaged, operationError, stagedAppPath })
  ) {
    await rm(signingDirectory, { recursive: true, force: true });
  }
  if (restorationError) {
    throw new AggregateError(
      [operationError, restorationError].filter(Boolean),
      `Impossible de restaurer le bundle après scellement. Chemins à vérifier — sortie : ${appPath} ; staging : ${stagedAppPath}.`,
    );
  }
  if (operationError) throw operationError;

  console.log(`✓ Signature ad-hoc appliquée au build pilote : ${appPath}`);
}
