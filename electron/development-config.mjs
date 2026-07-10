const MIN_PORT = 1;
const MAX_PORT = 65_535;

export function parseDevelopmentPort(value, { fallback } = {}) {
  if (value == null || value === "") {
    if (fallback !== undefined) return parseDevelopmentPort(fallback);
    throw new TypeError("Le port de développement est requis.");
  }

  const serialized = typeof value === "number" ? String(value) : value;
  if (typeof serialized !== "string" || !/^\d+$/.test(serialized)) {
    throw new TypeError("Le port de développement doit être un entier décimal.");
  }

  const port = Number(serialized);
  if (!Number.isSafeInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new RangeError(`Le port de développement doit être compris entre ${MIN_PORT} et ${MAX_PORT}.`);
  }
  return port;
}

export function createDevelopmentServerUrl(port) {
  return `http://127.0.0.1:${parseDevelopmentPort(port)}`;
}

export function normalizeDevelopmentServerUrl(value) {
  if (typeof value !== "string" || value.length > 128) return null;
  const candidate = value.trim();

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }

  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    return null;
  }

  const match = /^http:\/\/127\.0\.0\.1:(\d+)\/?$/.exec(candidate);
  if (!match) return null;

  try {
    return createDevelopmentServerUrl(match[1]);
  } catch {
    return null;
  }
}

export function resolveRendererEntryUrl({ isPackaged, developmentUrl, packagedUrl }) {
  if (typeof packagedUrl !== "string" || !packagedUrl) {
    throw new TypeError("L’URL interne de l’application est requise.");
  }
  if (isPackaged) return packagedUrl;
  return normalizeDevelopmentServerUrl(developmentUrl) ?? packagedUrl;
}
