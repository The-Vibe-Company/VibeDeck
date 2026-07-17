const MAX_X_PANEL_URL_LENGTH = 4_096;
const X_HOSTNAMES = new Set([
  "x.com",
  "www.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
]);

/**
 * Normalizes the deliberately narrow URL accepted by the dedicated X panel flow.
 * Generic web panels retain their broader HTTP(S) contract.
 */
export function cleanXPanelUrl(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > MAX_X_PANEL_URL_LENGTH
  ) {
    throw new TypeError("Adresse X invalide.");
  }

  const trimmed = value.trim();
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new TypeError("Cette adresse X n’est pas valide.");
  }

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    !X_HOSTNAMES.has(url.hostname)
  ) {
    throw new TypeError("Utilisez une adresse x.com ou twitter.com valide.");
  }

  url.protocol = "https:";
  url.hostname = "x.com";
  url.hash = "";
  if (url.href.length > MAX_X_PANEL_URL_LENGTH) {
    throw new TypeError("Adresse X invalide.");
  }
  return url.href;
}
