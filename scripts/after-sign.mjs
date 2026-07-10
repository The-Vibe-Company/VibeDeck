import { execFile } from "node:child_process";
import { mkdtemp, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
  const signingDirectory = await mkdtemp(path.join(os.tmpdir(), "mediagen-adhoc-sign-"));
  const stagedAppPath = path.join(signingDirectory, appName);
  let appIsStaged = false;
  let operationError = null;

  try {
    // File Provider workspaces can re-attach provenance metadata immediately
    // after xattr removes it. Stage the disposable unsigned bundle outside the
    // synced workspace while it is sealed, then move the exact bundle back.
    await rename(appPath, stagedAppPath);
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
      await rename(stagedAppPath, appPath);
      appIsStaged = false;
    } catch (error) {
      restorationError = error;
    }
  }

  if (!appIsStaged) {
    await rm(signingDirectory, { recursive: true, force: true });
  }
  if (restorationError) {
    throw new AggregateError(
      [operationError, restorationError].filter(Boolean),
      `Impossible de restaurer le bundle après scellement. Copie préservée : ${stagedAppPath}`,
    );
  }
  if (operationError) throw operationError;

  console.log(`✓ Signature ad-hoc appliquée au build pilote : ${appPath}`);
}
