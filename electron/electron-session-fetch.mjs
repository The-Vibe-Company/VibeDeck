const MAX_HTTP_URL_LENGTH = 4_096;
const EMPTY_BODY_STATUSES = new Set([204, 205, 304]);

function requireSessionMethod(networkSession, method) {
  if (!networkSession || typeof networkSession[method] !== "function") {
    throw new TypeError(`La session Electron ne fournit pas ${method}().`);
  }
}

function normalizeHttpUrl(value) {
  if (typeof value !== "string" || value.length > MAX_HTTP_URL_LENGTH) {
    throw new TypeError("URL de téléchargement Electron invalide.");
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new TypeError("URL de téléchargement Electron invalide.");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password
  ) {
    throw new TypeError("URL de téléchargement Electron invalide.");
  }
  return parsed.toString();
}

function inputHttpUrl(input) {
  if (typeof input === "string") return normalizeHttpUrl(input);
  if (input && typeof input === "object" && typeof input.url === "string") {
    return normalizeHttpUrl(input.url);
  }
  throw new TypeError("URL de téléchargement Electron invalide.");
}

function safeHttpUrl(value) {
  try {
    return normalizeHttpUrl(value);
  } catch {
    return null;
  }
}

function responseWithUrl(response, url, redirected) {
  return new Proxy(response, {
    get(target, property) {
      if (property === "url") return url;
      if (property === "redirected") return redirected;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function redirectTrackerFor(networkSession) {
  if (sessionRedirectTrackers.has(networkSession)) {
    return sessionRedirectTrackers.get(networkSession);
  }

  const tracker = { pending: new Set() };
  const onBeforeRedirect = networkSession.webRequest?.onBeforeRedirect;
  if (typeof onBeforeRedirect === "function") {
    onBeforeRedirect.call(
      networkSession.webRequest,
      { urls: ["http://*/*", "https://*/*"] },
      (details) => {
        const currentUrl = safeHttpUrl(details?.url);
        const nextUrl = safeHttpUrl(details?.redirectURL);
        if (!currentUrl || !nextUrl) return;
        const context = [...tracker.pending].find(
          (candidate) =>
            candidate.requestId === details.id ||
            (candidate.requestId == null && candidate.currentUrl === currentUrl),
        );
        if (!context) return;
        context.requestId = details.id;
        context.currentUrl = nextUrl;
        context.redirected = true;
      },
    );
  }
  sessionRedirectTrackers.set(networkSession, tracker);
  return tracker;
}

function initValue(input, init, key) {
  if (init && Object.hasOwn(init, key) && init[key] !== undefined) return init[key];
  if (input && typeof input === "object" && input[key] !== undefined) return input[key];
  return undefined;
}

function requestHeaders(input, init) {
  const source = initValue(input, init, "headers");
  if (source == null) return undefined;
  const headers = new Headers(source);
  const normalized = {};
  for (const [name, value] of headers) normalized[name] = value;
  return normalized;
}

function requestOptions(input, init, url) {
  const body = initValue(input, init, "body");
  if (body != null) {
    throw new TypeError("Les requêtes Electron manuelles avec un corps ne sont pas prises en charge.");
  }
  const options = {
    url,
    method: initValue(input, init, "method") ?? "GET",
    redirect: "manual",
    bypassCustomProtocolHandlers: true,
  };
  const headers = requestHeaders(input, init);
  if (headers) options.headers = headers;
  for (const key of ["cache", "credentials", "origin", "priority", "referrerPolicy"]) {
    const value = initValue(input, init, key);
    if (value !== undefined) options[key] = value;
  }
  return options;
}

function requestSignal(input, init) {
  return initValue(input, init, "signal") ?? null;
}

function createAbortError() {
  if (typeof DOMException === "function") {
    return new DOMException("La requête réseau a été annulée.", "AbortError");
  }
  const error = new Error("La requête réseau a été annulée.");
  error.name = "AbortError";
  return error;
}

function isExpectedRedirectCancellation(error) {
  return /redirect was cancelled/i.test(error instanceof Error ? error.message : String(error ?? ""));
}

function readableNetworkError(error) {
  if (error?.name === "AbortError") return error;
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/net::ERR_|^ERR_[A-Z_]+$/i.test(message)) {
    return new Error("La requête réseau n’a pas pu aboutir.");
  }
  if (error instanceof Error) return error;
  return new Error("La requête réseau n’a pas pu aboutir.");
}

function responseHeaders(headers) {
  const result = new Headers();
  if (!headers || typeof headers !== "object") return result;
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, String(item));
    } else if (value != null) {
      result.append(name, String(value));
    }
  }
  return result;
}

function createResponseBodyStream(message, request, signal) {
  let controller = null;
  let closed = false;
  let onData;
  let onEnd;
  let onError;
  let onAborted;
  let onSignalAbort;

  const removeListeners = () => {
    message.off?.("data", onData);
    message.off?.("end", onEnd);
    message.off?.("error", onError);
    message.off?.("aborted", onAborted);
    signal?.removeEventListener?.("abort", onSignalAbort);
  };
  const fail = (error, { abortRequest = false } = {}) => {
    if (closed) return;
    closed = true;
    removeListeners();
    if (abortRequest) {
      try {
        request.abort();
      } catch {
        // A finished request cannot be aborted and needs no further cleanup.
      }
    }
    controller?.error(error);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    removeListeners();
    controller?.close();
  };
  const stream = new ReadableStream({
    start(streamController) {
      controller = streamController;
      onData = (chunk) => {
        if (closed) return;
        const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        streamController.enqueue(bytes);
        if (streamController.desiredSize !== null && streamController.desiredSize <= 0) {
          message.pause?.();
        }
      };
      onEnd = close;
      onError = (error) => fail(readableNetworkError(error));
      onAborted = () => fail(createAbortError());
      onSignalAbort = () => fail(createAbortError(), { abortRequest: true });
      message.pause?.();
      message.on("data", onData);
      message.once("end", onEnd);
      message.once("error", onError);
      message.once("aborted", onAborted);
      if (signal?.aborted) {
        onSignalAbort();
        return;
      }
      signal?.addEventListener?.("abort", onSignalAbort, { once: true });
    },
    pull() {
      if (!closed) message.resume?.();
    },
    cancel() {
      fail(createAbortError(), { abortRequest: true });
    },
  });
  return { stream, fail };
}

function responseFromIncomingMessage(message, request, signal, url) {
  const status = Number(message?.statusCode);
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    throw new Error("La réponse réseau Electron est invalide.");
  }
  const headers = responseHeaders(message.headers);
  if (EMPTY_BODY_STATUSES.has(status)) {
    message.resume?.();
    return { response: responseWithUrl(new Response(null, { status, headers }), url, false), fail: null };
  }
  const body = createResponseBodyStream(message, request, signal);
  return {
    response: responseWithUrl(new Response(body.stream, { status, headers }), url, false),
    fail: body.fail,
  };
}

function manualClientRequestFetch(input, init, clientRequestFactory) {
  const url = inputHttpUrl(input);
  const signal = requestSignal(input, init);
  if (signal?.aborted) return Promise.reject(createAbortError());

  return new Promise((resolve, reject) => {
    let request = null;
    let settled = false;
    let redirectReceived = false;
    let bodyFail = null;
    let onSignalAbort;

    const removeInitialAbortListener = () => {
      signal?.removeEventListener?.("abort", onSignalAbort);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      removeInitialAbortListener();
      callback(value);
    };
    const onRequestError = (error) => {
      if (redirectReceived && isExpectedRedirectCancellation(error)) return;
      const normalized = readableNetworkError(error);
      if (!settled) {
        settle(reject, normalized);
      } else {
        bodyFail?.(normalized);
      }
    };
    const onRedirect = (status, _method, _redirectUrl, headers) => {
      redirectReceived = true;
      try {
        const response = new Response(null, {
          status: Number(status),
          headers: responseHeaders(headers),
        });
        settle(resolve, responseWithUrl(response, url, false));
      } catch (error) {
        settle(reject, error);
      }
    };
    const onResponse = (message) => {
      if (settled) {
        message.resume?.();
        return;
      }
      try {
        const result = responseFromIncomingMessage(message, request, signal, url);
        bodyFail = result.fail;
        settle(resolve, result.response);
      } catch (error) {
        settle(reject, error);
      }
    };
    onSignalAbort = () => {
      try {
        request?.abort();
      } catch {
        // The request may have closed immediately before the signal fired.
      }
      settle(reject, createAbortError());
    };

    try {
      request = clientRequestFactory(requestOptions(input, init, url));
      if (!request || typeof request.on !== "function" || typeof request.end !== "function") {
        throw new TypeError("La fabrique ClientRequest Electron a renvoyé une requête invalide.");
      }
      request.on("error", onRequestError);
      request.once("redirect", onRedirect);
      request.once("response", onResponse);
      if (signal) signal.addEventListener("abort", onSignalAbort, { once: true });
      if (signal?.aborted) {
        onSignalAbort();
        return;
      }
      request.end();
    } catch (error) {
      settle(reject, readableNetworkError(error));
    }
  });
}

const sessionRedirectTrackers = new WeakMap();

/**
 * Adapts an isolated Electron Session to Fetch. Manual redirects use
 * ClientRequest because Electron 43 cancels Session.fetch before exposing 3xx.
 */
export function createElectronSessionFetch(networkSession, { clientRequestFactory = null } = {}) {
  requireSessionMethod(networkSession, "fetch");
  if (clientRequestFactory !== null && typeof clientRequestFactory !== "function") {
    throw new TypeError("La fabrique ClientRequest Electron est invalide.");
  }

  return async (input, init = undefined) => {
    const redirect = initValue(input, init, "redirect") ?? "follow";
    if (redirect === "manual") {
      if (!clientRequestFactory) {
        throw new TypeError("Une fabrique ClientRequest est requise pour les redirections manuelles Electron.");
      }
      return manualClientRequestFetch(input, init, clientRequestFactory);
    }

    const tracker = redirectTrackerFor(networkSession);
    const context = {
      currentUrl: inputHttpUrl(input),
      redirected: false,
      requestId: null,
    };
    tracker.pending.add(context);
    try {
      const response = await networkSession.fetch(input, {
        ...(init ?? {}),
        bypassCustomProtocolHandlers: true,
      });
      const responseUrl = safeHttpUrl(response.url);
      return responseWithUrl(
        response,
        context.redirected ? context.currentUrl : (responseUrl ?? context.currentUrl),
        response.redirected === true || context.redirected,
      );
    } finally {
      tracker.pending.delete(context);
    }
  };
}
