import path from "node:path";
import { pathToFileURL } from "node:url";

export const APP_PROTOCOL_SCHEME = "vibedeck-app";
export const APP_PROTOCOL_HOST = "bundle";
export const APP_ENTRY_URL = `${APP_PROTOCOL_SCHEME}://${APP_PROTOCOL_HOST}/index.html`;

export function resolveAppAssetPath(requestUrl, assetRoot) {
  if (typeof assetRoot !== "string" || !path.isAbsolute(assetRoot)) {
    throw new TypeError("Racine des ressources applicatives invalide.");
  }
  let parsed;
  try {
    parsed = new URL(requestUrl);
  } catch {
    throw new TypeError("URL de ressource applicative invalide.");
  }
  if (
    parsed.protocol !== `${APP_PROTOCOL_SCHEME}:` ||
    parsed.hostname !== APP_PROTOCOL_HOST ||
    parsed.port ||
    parsed.username ||
    parsed.password
  ) {
    throw new TypeError("Origine de ressource applicative refusée.");
  }

  let pathname;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    throw new TypeError("Chemin de ressource applicative invalide.");
  }
  if (pathname.includes("\0")) {
    throw new TypeError("Chemin de ressource applicative invalide.");
  }
  const relativePath = pathname.replace(/^\/+/, "") || "index.html";
  const root = path.resolve(assetRoot);
  const candidate = path.resolve(root, relativePath);
  const relativeToRoot = path.relative(root, candidate);
  if (
    relativeToRoot === ".." ||
    relativeToRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToRoot)
  ) {
    throw new TypeError("Chemin de ressource applicative refusé.");
  }
  return candidate;
}

export function createAppProtocolHandler({ assetRoot, fetchFile }) {
  if (typeof fetchFile !== "function") {
    throw new TypeError("Chargeur de ressources applicatives indisponible.");
  }
  return async (request) => {
    try {
      const filePath = resolveAppAssetPath(request?.url, assetRoot);
      return await fetchFile(pathToFileURL(filePath).toString(), {
        bypassCustomProtocolHandlers: true,
      });
    } catch {
      return new Response("Ressource introuvable.", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
  };
}
