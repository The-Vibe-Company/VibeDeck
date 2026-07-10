import assert from "node:assert/strict";
import test from "node:test";

import { layoutPanelIds, swapPanels } from "../src/dashboard.ts";

const layout = {
  type: "split",
  id: "root",
  direction: "row",
  ratio: 0.5,
  children: [
    { type: "panel", panelId: "panel-a" },
    { type: "panel", panelId: "panel-b" },
  ],
};

test("swaps two known panels and ignores an unknown drag identifier", () => {
  assert.deepEqual(layoutPanelIds(swapPanels(layout, "panel-a", "panel-b")), [
    "panel-b",
    "panel-a",
  ]);

  const untouched = swapPanels(layout, "https://external.test/article", "panel-b");
  assert.equal(untouched, layout);
  assert.deepEqual(layoutPanelIds(untouched), ["panel-a", "panel-b"]);
});
