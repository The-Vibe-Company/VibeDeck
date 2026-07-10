import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MAX_MODEL_REDIRECTS,
  createSemanticModelDownloader,
} from "./semantic-model-download.mjs";

const MODEL_ROOT = "https://huggingface.co/Xenova/multilingual-e5-small/resolve/revision";
const INITIAL_URL = `${MODEL_ROOT}/config.json`;
const SECOND_HUGGING_FACE_URL = `${MODEL_ROOT}/config-final.json`;
const CDN_URL = "https://us.aws.cdn.hf.co/models/config-final.json";
const PUBLIC_ENDPOINTS = Object.freeze([{ address: "93.184.216.34", family: "ipv4" }]);

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibedeck-semantic-model-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function response(body, { status = 200, headers = {}, url = "", redirected = false } = {}) {
  const result = new Response(body, { status, headers });
  if (url) Object.defineProperty(result, "url", { value: url });
  if (redirected) Object.defineProperty(result, "redirected", { value: true });
  return result;
}

function createHarness({
  responses,
  endpoints = PUBLIC_ENDPOINTS,
  proxyRoute = "DIRECT",
  maxRedirects,
} = {}) {
  const fetchCalls = [];
  const hostCalls = [];
  const proxyCalls = [];
  const fetchImpl = async (url, init) => {
    fetchCalls.push([url, init]);
    const next = typeof responses === "function"
      ? await responses(url, init, fetchCalls.length)
      : responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  const download = createSemanticModelDownloader({
    fetchImpl,
    resolveHost: async (hostname, options) => {
      hostCalls.push([hostname, options]);
      return typeof endpoints === "function" ? endpoints(hostname) : { endpoints };
    },
    resolveProxy: async (url) => {
      proxyCalls.push(url);
      return typeof proxyRoute === "function" ? proxyRoute(url) : proxyRoute;
    },
    ...(maxRedirects === undefined ? {} : { maxRedirects }),
  });
  return { download, fetchCalls, hostCalls, proxyCalls };
}

async function assertMissing(filePath) {
  await assert.rejects(access(filePath), { code: "ENOENT" });
}

test("downloads an allowed Hugging Face redirect chain after every preflight", async (t) => {
  const directory = await temporaryDirectory(t);
  const destination = path.join(directory, "config.json.part");
  const body = Buffer.from("modele local de test");
  const harness = createHarness({
    responses: [
      response(null, { status: 302, headers: { location: SECOND_HUGGING_FACE_URL } }),
      response(null, { status: 307, headers: { location: CDN_URL } }),
      response(body, {
        headers: { "content-length": String(body.length) },
      }),
    ],
  });

  await harness.download(INITIAL_URL, destination, {
    expectedBytes: body.length,
    expectedSha256: digest(body),
    cancelled: () => false,
  });

  assert.deepEqual(
    harness.fetchCalls.map(([url]) => url),
    [INITIAL_URL, SECOND_HUGGING_FACE_URL, CDN_URL],
  );
  assert.ok(harness.fetchCalls.every(([, init]) => init.redirect === "manual"));
  assert.deepEqual(
    harness.hostCalls.map(([hostname]) => hostname),
    ["huggingface.co", "huggingface.co", "us.aws.cdn.hf.co"],
  );
  assert.deepEqual(harness.proxyCalls, [INITIAL_URL, SECOND_HUGGING_FACE_URL, CDN_URL]);
  assert.deepEqual(await readFile(destination), body);
  if (process.platform !== "win32") assert.equal((await stat(destination)).mode & 0o077, 0);
});

test("rejects unsafe redirect destinations before a second request and removes the part", async (t) => {
  const directory = await temporaryDirectory(t);
  const cases = [
    ["unapproved host", "https://attacker.test/model.onnx", /Origine du modèle local refusée/],
    ["HTTP downgrade", "http://huggingface.co/model.onnx", /Origine du modèle local refusée/],
    ["embedded credentials", "https://token@huggingface.co/model.onnx", /Origine du modèle local refusée/],
  ];

  for (const [name, location, expected] of cases) {
    const destination = path.join(directory, `${name}.part`);
    await writeFile(destination, "stale partial data");
    const harness = createHarness({
      responses: [response(null, { status: 302, headers: { location } })],
    });
    await assert.rejects(
      harness.download(INITIAL_URL, destination, {
        expectedBytes: 1,
        expectedSha256: digest("x"),
        cancelled: () => false,
      }),
      expected,
    );
    assert.equal(harness.fetchCalls.length, 1, `${name} must not be fetched`);
    await assertMissing(destination);
  }
});

test("fails closed for private DNS, proxied routes, auto-following adapters, and redirect limits", async (t) => {
  const directory = await temporaryDirectory(t);
  const cases = [
    {
      name: "private DNS",
      options: { endpoints: [{ address: "10.0.0.8", family: "ipv4" }] },
      expected: /ne peut pas être résolu/,
      expectedFetches: 0,
    },
    {
      name: "proxy",
      options: { proxyRoute: "PROXY proxy.example:8080" },
      expected: /connexion directe/,
      expectedFetches: 0,
    },
    {
      name: "private redirect DNS",
      options: {
        endpoints: (hostname) => ({
          endpoints: hostname === "us.aws.cdn.hf.co"
            ? [{ address: "192.168.1.8", family: "ipv4" }]
            : PUBLIC_ENDPOINTS,
        }),
        responses: [response(null, { status: 302, headers: { location: CDN_URL } })],
      },
      expected: /ne peut pas être résolu/,
      expectedFetches: 1,
    },
    {
      name: "proxied redirect",
      options: {
        proxyRoute: (url) => url === CDN_URL ? "PROXY proxy.example:8080" : "DIRECT",
        responses: [response(null, { status: 302, headers: { location: CDN_URL } })],
      },
      expected: /connexion directe/,
      expectedFetches: 1,
    },
    {
      name: "adapter auto-follow",
      options: {
        responses: [response("unexpected", { url: CDN_URL, redirected: true })],
      },
      expected: /suivi une redirection/,
      expectedFetches: 1,
    },
    {
      name: "redirect limit",
      options: {
        maxRedirects: 1,
        responses: [
          response(null, { status: 302, headers: { location: SECOND_HUGGING_FACE_URL } }),
          response(null, { status: 302, headers: { location: CDN_URL } }),
        ],
      },
      expected: /trop de redirections/,
      expectedFetches: 2,
    },
  ];

  for (const { name, options, expected, expectedFetches } of cases) {
    const destination = path.join(directory, `${name}.part`);
    await writeFile(destination, "stale partial data");
    const harness = createHarness({
      responses: [response("unreachable")],
      ...options,
    });
    await assert.rejects(
      harness.download(INITIAL_URL, destination, {
        expectedBytes: 1,
        expectedSha256: digest("x"),
        cancelled: () => false,
      }),
      expected,
    );
    assert.equal(harness.fetchCalls.length, expectedFetches, name);
    await assertMissing(destination);
  }
});

test("removes partial model files after network, size, and hash failures", async (t) => {
  const directory = await temporaryDirectory(t);
  const cases = [
    {
      name: "network",
      response: new Error("network unavailable"),
      expectedBytes: 3,
      expectedSha256: digest("abc"),
      expected: /network unavailable/,
    },
    {
      name: "declared-size",
      response: response("abc", { headers: { "content-length": "4" } }),
      expectedBytes: 3,
      expectedSha256: digest("abc"),
      expected: /Taille du modèle inattendue/,
    },
    {
      name: "stream-overflow",
      response: response("abcd"),
      expectedBytes: 3,
      expectedSha256: digest("abc"),
      expected: /Taille du modèle inattendue/,
    },
    {
      name: "short-stream",
      response: response("ab"),
      expectedBytes: 3,
      expectedSha256: digest("abc"),
      expected: /vérification du modèle a échoué/,
    },
    {
      name: "hash",
      response: response("abc"),
      expectedBytes: 3,
      expectedSha256: digest("different"),
      expected: /vérification du modèle a échoué/,
    },
  ];

  for (const entry of cases) {
    const destination = path.join(directory, `${entry.name}.part`);
    await writeFile(destination, "stale partial data");
    const harness = createHarness({ responses: [entry.response] });
    await assert.rejects(
      harness.download(INITIAL_URL, destination, {
        expectedBytes: entry.expectedBytes,
        expectedSha256: entry.expectedSha256,
        cancelled: () => false,
      }),
      entry.expected,
    );
    await assertMissing(destination);
  }
});

test("cancels before a request and while streaming, without retaining a part", async (t) => {
  const directory = await temporaryDirectory(t);
  const beforeRequest = path.join(directory, "before-request.part");
  const beforeRequestController = new AbortController();
  beforeRequestController.abort();
  const beforeRequestHarness = createHarness({ responses: [response("unreachable")] });
  await writeFile(beforeRequest, "stale partial data");
  await assert.rejects(
    beforeRequestHarness.download(INITIAL_URL, beforeRequest, {
      expectedBytes: 3,
      expectedSha256: digest("abc"),
      cancelled: () => false,
      signal: beforeRequestController.signal,
    }),
    /Téléchargement de la recherche locale annulé/,
  );
  assert.equal(beforeRequestHarness.fetchCalls.length, 0);
  assert.equal(beforeRequestHarness.hostCalls.length, 0);
  assert.equal(beforeRequestHarness.proxyCalls.length, 0);
  await assertMissing(beforeRequest);

  const duringStream = path.join(directory, "during-stream.part");
  const streamController = new AbortController();
  let releaseSecondRead;
  const secondRead = new Promise((resolve) => {
    releaseSecondRead = resolve;
  });
  const body = new ReadableStream({
    pull(controller) {
      if (!this.sentFirstChunk) {
        this.sentFirstChunk = true;
        controller.enqueue(new TextEncoder().encode("abc"));
        return;
      }
      releaseSecondRead();
      return new Promise(() => {});
    },
    start(controller) {
      streamController.signal.addEventListener(
        "abort",
        () => controller.error(new Error("request aborted")),
        { once: true },
      );
    },
  });
  const duringStreamHarness = createHarness({ responses: [response(body)] });
  const pending = duringStreamHarness.download(INITIAL_URL, duringStream, {
    expectedBytes: 6,
    expectedSha256: digest("abcdef"),
    cancelled: () => false,
    signal: streamController.signal,
  });
  await secondRead;
  streamController.abort();
  await assert.rejects(pending, /Téléchargement de la recherche locale annulé/);
  await assertMissing(duringStream);
});

test("keeps the production redirect budget", () => {
  assert.equal(MAX_MODEL_REDIRECTS, 5);
});
