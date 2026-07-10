import assert from "node:assert/strict";
import test from "node:test";

import {
  createDevelopmentServerUrl,
  normalizeDevelopmentServerUrl,
  parseDevelopmentPort,
  resolveRendererEntryUrl,
} from "./development-config.mjs";

const packagedUrl = "vibedeck-app://bundle/index.html";

test("accepts bounded decimal development ports and the local fallback", () => {
  assert.equal(parseDevelopmentPort("55050"), 55_050);
  assert.equal(parseDevelopmentPort(5173), 5_173);
  assert.equal(parseDevelopmentPort(undefined, { fallback: 5173 }), 5_173);
  assert.equal(createDevelopmentServerUrl("55050"), "http://127.0.0.1:55050");
});

test("rejects missing, malformed, and out-of-range development ports", () => {
  for (const value of [undefined, "", " 55050 ", "1e3", "abc", "-1", "0", "65536"]) {
    assert.throws(() => parseDevelopmentPort(value), /port de développement/i);
  }
});

test("normalizes only root HTTP URLs on the numeric loopback host", () => {
  assert.equal(
    normalizeDevelopmentServerUrl("http://127.0.0.1:55050/"),
    "http://127.0.0.1:55050",
  );

  for (const value of [
    "https://127.0.0.1:55050",
    "http://localhost:55050",
    "http://user@127.0.0.1:55050",
    "http://127.0.0.1:55050/app",
    "http://127.0.0.1:55050?mode=dev",
    "http://127.0.0.1:55050#dev",
    "http://127.0.0.1:0",
    "not-an-url",
  ]) {
    assert.equal(normalizeDevelopmentServerUrl(value), null, value);
  }
});

test("always uses the internal entry when packaged or when the dev URL is unsafe", () => {
  assert.equal(
    resolveRendererEntryUrl({
      isPackaged: true,
      developmentUrl: "http://127.0.0.1:55050",
      packagedUrl,
    }),
    packagedUrl,
  );
  assert.equal(
    resolveRendererEntryUrl({
      isPackaged: false,
      developmentUrl: "https://example.com",
      packagedUrl,
    }),
    packagedUrl,
  );
  assert.equal(
    resolveRendererEntryUrl({
      isPackaged: false,
      developmentUrl: "http://127.0.0.1:55050",
      packagedUrl,
    }),
    "http://127.0.0.1:55050",
  );
});
