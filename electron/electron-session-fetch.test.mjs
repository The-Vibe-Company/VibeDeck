import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createElectronSessionFetch } from "./electron-session-fetch.mjs";

class FakeClientRequest extends EventEmitter {
  constructor() {
    super();
    this.endCalls = 0;
    this.abortCalls = 0;
  }

  end() {
    this.endCalls += 1;
  }

  abort() {
    this.abortCalls += 1;
    this.emit("abort");
  }
}

class FakeIncomingMessage extends EventEmitter {
  constructor({ statusCode = 200, headers = {} } = {}) {
    super();
    this.statusCode = statusCode;
    this.headers = headers;
    this.resumeCalls = 0;
  }

  resume() {
    this.resumeCalls += 1;
  }
}

class PausableIncomingMessage extends FakeIncomingMessage {
  constructor(options) {
    super(options);
    this.pauseCalls = 0;
    this.paused = false;
    this.pendingChunks = [];
  }

  pause() {
    this.pauseCalls += 1;
    this.paused = true;
  }

  resume() {
    super.resume();
    this.paused = false;
    this.#flush();
  }

  send(chunk) {
    this.pendingChunks.push(chunk);
    this.#flush();
  }

  #flush() {
    while (!this.paused && this.pendingChunks.length > 0) {
      this.emit("data", this.pendingChunks.shift());
    }
  }
}

function createHarness() {
  const requests = [];
  const networkSession = {
    async fetch() {
      throw new Error("Session.fetch ne doit pas être utilisée pour redirect: manual.");
    },
  };
  const fetchImpl = createElectronSessionFetch(networkSession, {
    clientRequestFactory(options) {
      const request = new FakeClientRequest();
      requests.push({ request, options });
      return request;
    },
  });
  return { fetchImpl, requests };
}

for (const status of [302, 307]) {
  test(`exposes a manual ${status} redirect before Electron cancels the request`, async () => {
    const { fetchImpl, requests } = createHarness();
    const pending = fetchImpl("https://news.example/start", {
      method: "GET",
      headers: { Accept: "application/rss+xml" },
      credentials: "omit",
      cache: "no-store",
      redirect: "manual",
    });
    const [{ request, options }] = requests;
    assert.deepEqual(options, {
      url: "https://news.example/start",
      method: "GET",
      headers: { accept: "application/rss+xml" },
      credentials: "omit",
      cache: "no-store",
      redirect: "manual",
      bypassCustomProtocolHandlers: true,
    });
    assert.equal(request.endCalls, 1);

    request.emit(
      "redirect",
      status,
      "GET",
      "https://cdn.example/final.xml",
      { location: ["https://cdn.example/final.xml"], "x-hop": ["one"] },
    );
    request.emit("error", new Error("Redirect was cancelled"));

    const response = await pending;
    assert.equal(response.status, status);
    assert.equal(response.headers.get("location"), "https://cdn.example/final.xml");
    assert.equal(response.headers.get("x-hop"), "one");
    assert.equal(response.url, "https://news.example/start");
    assert.equal(response.redirected, false);
  });
}

test("adapts final ClientRequest responses into a Fetch body with status and headers", async () => {
  const { fetchImpl, requests } = createHarness();
  const pending = fetchImpl("https://news.example/feed.xml", { redirect: "manual" });
  const [{ request }] = requests;
  const incoming = new FakeIncomingMessage({
    statusCode: 200,
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      etag: '"version-1"',
      "x-cache": ["one", "two"],
    },
  });
  request.emit("response", incoming);

  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(response.ok, true);
  assert.equal(response.url, "https://news.example/feed.xml");
  assert.equal(response.redirected, false);
  assert.equal(response.headers.get("content-type"), "application/rss+xml; charset=utf-8");
  assert.equal(response.headers.get("etag"), '"version-1"');
  assert.equal(response.headers.get("x-cache"), "one, two");

  incoming.emit("data", Buffer.from("<rss>"));
  incoming.emit("data", Buffer.from("ok</rss>"));
  incoming.emit("end");
  assert.equal(await response.text(), "<rss>ok</rss>");
});

test("pauses the Electron response while a Fetch consumer is stalled", async () => {
  const { fetchImpl, requests } = createHarness();
  const pending = fetchImpl("https://news.example/feed.xml", { redirect: "manual" });
  const [{ request }] = requests;
  const incoming = new PausableIncomingMessage();
  request.emit("response", incoming);
  const response = await pending;

  // The first chunk fills the Web-stream queue. Subsequent network chunks
  // stay in the paused Electron source until a consumer pulls again.
  incoming.send(Buffer.from("one"));
  incoming.send(Buffer.from("two"));
  incoming.send(Buffer.from("three"));
  assert.ok(incoming.pauseCalls >= 2, "la réponse doit être suspendue après le premier chunk");
  assert.deepEqual(incoming.pendingChunks.map(String), ["two", "three"]);

  const reader = response.body.getReader();
  assert.deepEqual(await reader.read(), { done: false, value: Buffer.from("one") });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(incoming.pendingChunks.map(String), ["three"]);
  await reader.cancel();
  assert.equal(request.abortCalls, 1);
});

test("aborts a ClientRequest before it receives a response", async () => {
  const { fetchImpl, requests } = createHarness();
  const controller = new AbortController();
  const pending = fetchImpl("https://news.example/feed.xml", {
    redirect: "manual",
    signal: controller.signal,
  });
  const [{ request }] = requests;
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(request.abortCalls, 1);
});

test("keeps AbortSignal attached until the final response body finishes", async () => {
  const { fetchImpl, requests } = createHarness();
  const controller = new AbortController();
  const pending = fetchImpl("https://news.example/feed.xml", {
    redirect: "manual",
    signal: controller.signal,
  });
  const [{ request }] = requests;
  const incoming = new FakeIncomingMessage({
    headers: { "content-type": "application/rss+xml" },
  });
  request.emit("response", incoming);
  const response = await pending;
  const reading = response.text();
  controller.abort();
  await assert.rejects(reading, { name: "AbortError" });
  assert.equal(request.abortCalls, 1);
});

test("cancelling the Fetch body aborts the underlying ClientRequest", async () => {
  const { fetchImpl, requests } = createHarness();
  const pending = fetchImpl("https://news.example/feed.xml", { redirect: "manual" });
  const [{ request }] = requests;
  request.emit("response", new FakeIncomingMessage());
  const response = await pending;
  await response.body.cancel();
  assert.equal(request.abortCalls, 1);
});

test("turns raw Electron network failures into a readable French error", async () => {
  const { fetchImpl, requests } = createHarness();
  const pending = fetchImpl("https://news.example/feed.xml", { redirect: "manual" });
  requests[0].request.emit("error", new Error("net::ERR_CONNECTION_REFUSED"));
  await assert.rejects(pending, /La requête réseau n’a pas pu aboutir/);
});

test("does not create a request when its AbortSignal is already aborted", async () => {
  const { fetchImpl, requests } = createHarness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    fetchImpl("https://news.example/feed.xml", {
      redirect: "manual",
      signal: controller.signal,
    }),
    { name: "AbortError" },
  );
  assert.equal(requests.length, 0);
});

test("keeps Session.fetch for redirect modes other than manual", async () => {
  const calls = [];
  const networkSession = {
    async fetch(...args) {
      calls.push(args);
      return new Response("ok");
    },
  };
  const fetchImpl = createElectronSessionFetch(networkSession, {
    clientRequestFactory() {
      throw new Error("ClientRequest ne doit pas être utilisé.");
    },
  });
  const response = await fetchImpl("https://news.example/feed.xml", { redirect: "follow" });
  assert.equal(await response.text(), "ok");
  assert.deepEqual(calls, [[
    "https://news.example/feed.xml",
    { redirect: "follow", bypassCustomProtocolHandlers: true },
  ]]);
});
