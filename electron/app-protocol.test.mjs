import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  APP_ENTRY_URL,
  createAppProtocolHandler,
  resolveAppAssetPath,
} from "./app-protocol.mjs";

const assetRoot = path.resolve("/tmp/vibedeck-dist");

test("maps only the internal app origin inside the packaged dist directory", () => {
  assert.equal(APP_ENTRY_URL, "vibedeck-app://bundle/index.html");
  assert.equal(
    resolveAppAssetPath("vibedeck-app://bundle/", assetRoot),
    path.join(assetRoot, "index.html"),
  );
  assert.equal(
    resolveAppAssetPath("vibedeck-app://bundle/assets/app.js?v=1", assetRoot),
    path.join(assetRoot, "assets", "app.js"),
  );

  for (const url of [
    "https://bundle/index.html",
    "vibedeck-app://other/index.html",
    "vibedeck-app://user@bundle/index.html",
    "vibedeck-app://bundle/%2e%2e%2fsecret.txt",
    "vibedeck-app://bundle/%E0%A4%A",
  ]) {
    assert.throws(() => resolveAppAssetPath(url, assetRoot), /refus|invalide/);
  }
});

test("serves valid assets through Electron net.fetch and hides rejected paths", async () => {
  const calls = [];
  const handler = createAppProtocolHandler({
    assetRoot,
    async fetchFile(...args) {
      calls.push(args);
      return new Response("asset", { status: 200 });
    },
  });

  const response = await handler({ url: "vibedeck-app://bundle/assets/app.js" });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    [
      pathToFileURL(path.join(assetRoot, "assets", "app.js")).toString(),
      { bypassCustomProtocolHandlers: true },
    ],
  ]);

  const rejected = await handler({ url: "vibedeck-app://bundle/%2e%2e%2fprivate" });
  assert.equal(rejected.status, 404);
  assert.equal(await rejected.text(), "Ressource introuvable.");
  assert.equal(calls.length, 1);
});
