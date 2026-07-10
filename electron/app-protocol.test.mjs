import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  APP_ENTRY_URL,
  createAppProtocolHandler,
  resolveAppAssetPath,
} from "./app-protocol.mjs";

const assetRoot = path.resolve("/tmp/mediagen-dist");

test("maps only the internal app origin inside the packaged dist directory", () => {
  assert.equal(APP_ENTRY_URL, "mediagen-app://bundle/index.html");
  assert.equal(
    resolveAppAssetPath("mediagen-app://bundle/", assetRoot),
    path.join(assetRoot, "index.html"),
  );
  assert.equal(
    resolveAppAssetPath("mediagen-app://bundle/assets/app.js?v=1", assetRoot),
    path.join(assetRoot, "assets", "app.js"),
  );

  for (const url of [
    "https://bundle/index.html",
    "mediagen-app://other/index.html",
    "mediagen-app://user@bundle/index.html",
    "mediagen-app://bundle/%2e%2e%2fsecret.txt",
    "mediagen-app://bundle/%E0%A4%A",
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

  const response = await handler({ url: "mediagen-app://bundle/assets/app.js" });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    [
      pathToFileURL(path.join(assetRoot, "assets", "app.js")).toString(),
      { bypassCustomProtocolHandlers: true },
    ],
  ]);

  const rejected = await handler({ url: "mediagen-app://bundle/%2e%2e%2fprivate" });
  assert.equal(rejected.status, 404);
  assert.equal(await rejected.text(), "Ressource introuvable.");
  assert.equal(calls.length, 1);
});
