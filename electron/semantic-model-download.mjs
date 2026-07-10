import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";

import { isNonPublicIpAddress } from "./network-safety.mjs";
import { assertModelDownloadUrl } from "./semantic-search.mjs";

export const MAX_MODEL_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HOST_RESOLUTION_OPTIONS = Object.freeze({
  cacheUsage: "allowed",
  source: "any",
  secureDnsPolicy: "allow",
});

function cancellationError() {
  return new Error("Téléchargement de la recherche locale annulé.");
}

function cancellationRequested(signal, cancelled) {
  return signal?.aborted === true || (typeof cancelled === "function" && cancelled());
}

function throwIfCancelled(signal, cancelled) {
  if (cancellationRequested(signal, cancelled)) throw cancellationError();
}

function assertDownloadDependencies({ fetchImpl, resolveHost, resolveProxy, maxRedirects }) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("Aucune fonction de téléchargement du modèle disponible.");
  }
  if (typeof resolveHost !== "function") {
    throw new TypeError("Le résolveur DNS du modèle est invalide.");
  }
  if (typeof resolveProxy !== "function") {
    throw new TypeError("Le résolveur proxy du modèle est invalide.");
  }
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0) {
    throw new TypeError("Nombre de redirections du modèle invalide.");
  }
}

function assertDownloadInput(destination, { expectedBytes, expectedSha256 } = {}) {
  if (typeof destination !== "string" || !destination) {
    throw new TypeError("Destination du modèle invalide.");
  }
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
    throw new TypeError("Taille attendue du modèle invalide.");
  }
  if (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(expectedSha256)) {
    throw new TypeError("Empreinte attendue du modèle invalide.");
  }
}

function contentLengthOf(response) {
  const value = response.headers?.get?.("content-length");
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function removePartialFile(destination) {
  await rm(destination, { force: true });
}

async function discardResponseBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // A streamed response can already be locked or closed when cleanup runs.
  }
}

/**
 * Creates the main-process-only model downloader. Network primitives are
 * injected so the caller can bind the exact isolated Electron session.
 */
export function createSemanticModelDownloader({
  fetchImpl,
  resolveHost,
  resolveProxy,
  maxRedirects = MAX_MODEL_REDIRECTS,
} = {}) {
  assertDownloadDependencies({ fetchImpl, resolveHost, resolveProxy, maxRedirects });

  async function assertSafeTarget(candidate, signal, cancelled) {
    throwIfCancelled(signal, cancelled);
    const resolution = await resolveHost(candidate.hostname, HOST_RESOLUTION_OPTIONS);
    throwIfCancelled(signal, cancelled);
    if (
      !resolution?.endpoints?.length ||
      !resolution.endpoints.every(
        ({ address }) => typeof address === "string" && !isNonPublicIpAddress(address),
      )
    ) {
      throw new Error("L’hôte du modèle ne peut pas être résolu de manière sûre.");
    }
    const route = await resolveProxy(candidate.href);
    throwIfCancelled(signal, cancelled);
    if (typeof route !== "string" || !/^direct\s*$/i.test(route.trim())) {
      throw new Error("Le téléchargement du modèle exige une connexion directe vérifiable.");
    }
  }

  async function fetchModel(url, { signal, cancelled } = {}) {
    let candidate = assertModelDownloadUrl(url);
    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      await assertSafeTarget(candidate, signal, cancelled);
      const response = await fetchImpl(candidate.href, { redirect: "manual", signal });
      throwIfCancelled(signal, cancelled);
      const observedUrl = response.url || candidate.href;
      if (response.redirected === true || observedUrl !== candidate.href) {
        await discardResponseBody(response);
        assertModelDownloadUrl(observedUrl);
        throw new Error("Le téléchargeur du modèle a suivi une redirection sans contrôle préalable.");
      }
      if (!REDIRECT_STATUSES.has(response.status)) return response;
      await discardResponseBody(response);
      if (redirectCount === maxRedirects) {
        throw new Error("Le téléchargement du modèle effectue trop de redirections.");
      }
      const location = response.headers?.get?.("location");
      if (!location) throw new Error("La redirection du modèle est incomplète.");
      candidate = assertModelDownloadUrl(new URL(location, candidate).href);
    }
    throw new Error("Le téléchargement du modèle effectue trop de redirections.");
  }

  async function writeResponse(response, destination, { expectedBytes, signal, cancelled }) {
    const output = createWriteStream(destination, { flags: "w", mode: 0o600 });
    let outputFailure = null;
    const outputDone = finished(output).catch((error) => {
      outputFailure = error;
    });
    const digest = createHash("sha256");
    let written = 0;
    try {
      for await (const chunk of Readable.fromWeb(response.body)) {
        throwIfCancelled(signal, cancelled);
        if (outputFailure) throw outputFailure;
        written += chunk.length;
        if (written > expectedBytes) throw new Error("Taille du modèle inattendue.");
        digest.update(chunk);
        if (!output.write(chunk)) {
          await Promise.race([
            new Promise((resolve) => output.once("drain", resolve)),
            outputDone,
          ]);
          if (outputFailure) throw outputFailure;
        }
      }
      throwIfCancelled(signal, cancelled);
      output.end();
      await outputDone;
      if (outputFailure) throw outputFailure;
    } catch (error) {
      output.destroy();
      await outputDone;
      throw error;
    }
    return { written, digest: digest.digest("hex") };
  }

  return async function downloadSemanticModelFile(
    url,
    destination,
    { expectedBytes, expectedSha256, cancelled, signal } = {},
  ) {
    assertDownloadInput(destination, { expectedBytes, expectedSha256 });
    let response = null;
    try {
      throwIfCancelled(signal, cancelled);
      response = await fetchModel(url, { signal, cancelled });
      if (!response.ok || !response.body) {
        await discardResponseBody(response);
        throw new Error("Le téléchargement du modèle a échoué.");
      }
      const contentLength = contentLengthOf(response);
      if (contentLength !== null && contentLength !== expectedBytes) {
        await discardResponseBody(response);
        throw new Error("Taille du modèle inattendue.");
      }
      const { written, digest } = await writeResponse(response, destination, {
        expectedBytes,
        signal,
        cancelled,
      });
      if (written !== expectedBytes || digest !== expectedSha256) {
        throw new Error("La vérification du modèle a échoué.");
      }
    } catch (error) {
      await discardResponseBody(response);
      await removePartialFile(destination);
      if (cancellationRequested(signal, cancelled)) throw cancellationError();
      throw error;
    }
  };
}
