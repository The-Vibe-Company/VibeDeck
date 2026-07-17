import assert from "node:assert/strict";
import test from "node:test";

import { cleanXPanelUrl } from "./x-panel-url.mjs";

test("normalizes supported X and legacy Twitter addresses", () => {
  assert.equal(cleanXPanelUrl("https://x.com/home"), "https://x.com/home");
  assert.equal(
    cleanXPanelUrl("x.com/i/lists/123456789"),
    "https://x.com/i/lists/123456789",
  );
  assert.equal(cleanXPanelUrl("www.x.com/AFP"), "https://x.com/AFP");
  assert.equal(
    cleanXPanelUrl("http://twitter.com/AFP/status/42#context"),
    "https://x.com/AFP/status/42",
  );
  assert.equal(
    cleanXPanelUrl("https://mobile.twitter.com/search?q=breaking&src=typed_query"),
    "https://x.com/search?q=breaking&src=typed_query",
  );
});

test("rejects addresses outside the exact X trust boundary", () => {
  for (const value of [
    "",
    "https://x.com.evil.test/i/lists/1",
    "https://notx.com/",
    "https://user:secret@x.com/home",
    "ftp://x.com/home",
    "https://x.com:8443/home",
    "@AFP",
    `https://x.com/${"a".repeat(4_096)}`,
  ]) {
    assert.throws(() => cleanXPanelUrl(value), TypeError, value);
  }
});
