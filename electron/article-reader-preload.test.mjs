import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const PRELOAD_SOURCE = readFileSync(
  new URL("./article-reader-preload.cjs", import.meta.url),
  "utf8",
);

function createHarness() {
  const keydownListeners = [];

  class FakeHTMLElement {
    constructor({
      parent = null,
      overflowY = "visible",
      scrollHeight = 0,
      clientHeight = 0,
      scrollTop = 0,
      editable = false,
    } = {}) {
      this.parentElement = parent;
      this.overflowY = overflowY;
      this.scrollHeight = scrollHeight;
      this.clientHeight = clientHeight;
      this.scrollTop = scrollTop;
      this.editable = editable;
      this.isContentEditable = false;
      this.shadowRoot = null;
      this.scrollCalls = [];
    }

    matches() {
      return this.editable;
    }

    scrollBy(options) {
      this.scrollCalls.push({ ...options });
      const maximum = Math.max(0, this.scrollHeight - this.clientHeight);
      this.scrollTop = Math.max(0, Math.min(maximum, this.scrollTop + options.top));
    }
  }

  const root = new FakeHTMLElement({
    overflowY: "visible",
    scrollHeight: 3_000,
    clientHeight: 700,
  });
  const body = new FakeHTMLElement({ parent: root });
  const leaf = new FakeHTMLElement({ parent: body });
  const document = {
    activeElement: body,
    body,
    documentElement: root,
    scrollingElement: root,
    elementFromPoint: () => leaf,
  };
  const window = {
    innerHeight: 700,
    innerWidth: 1_000,
    addEventListener(type, listener) {
      if (type === "keydown") keydownListeners.push(listener);
    },
    getComputedStyle: (element) => ({ overflowY: element.overflowY }),
  };

  vm.runInNewContext(PRELOAD_SOURCE, {
    document,
    HTMLElement: FakeHTMLElement,
    window,
  });

  function press(key, overrides = {}) {
    let prevented = false;
    let stopped = false;
    const event = {
      key,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      defaultPrevented: false,
      repeat: false,
      preventDefault() {
        prevented = true;
        this.defaultPrevented = true;
      },
      stopImmediatePropagation() {
        stopped = true;
      },
      ...overrides,
    };
    for (const listener of keydownListeners) listener(event);
    return { event, prevented, stopped };
  }

  return { FakeHTMLElement, body, document, leaf, press, root };
}

test("arrow keys move the article by most of one viewport", () => {
  const { press, root } = createHarness();

  const down = press("ArrowDown");
  assert.equal(down.prevented, true);
  assert.equal(down.stopped, true);
  assert.deepEqual(root.scrollCalls, [{ top: 504, left: 0, behavior: "auto" }]);
  assert.equal(root.scrollTop, 504);

  assert.equal(press("ArrowUp").prevented, true);
  assert.equal(root.scrollCalls.at(-1).top, -504);
  assert.equal(root.scrollTop, 0);
});

test("holding an arrow stays fast with smaller controllable increments", () => {
  const { press, root } = createHarness();

  assert.equal(press("ArrowDown", { repeat: true }).prevented, true);
  assert.equal(root.scrollCalls[0].top, 196);
});

test("a nested scroller at its boundary hands scrolling back to the article", () => {
  const { FakeHTMLElement, document, leaf, press, root } = createHarness();
  const nested = new FakeHTMLElement({
    parent: document.body,
    overflowY: "auto",
    scrollHeight: 900,
    clientHeight: 400,
    scrollTop: 500,
  });
  leaf.parentElement = nested;

  assert.equal(press("ArrowDown").prevented, true);
  assert.equal(nested.scrollCalls.length, 0);
  assert.equal(root.scrollCalls[0].top, 504);
});

test("editable controls, including controls in a shadow root, keep native arrows", () => {
  const { FakeHTMLElement, document, press, root } = createHarness();
  const host = new FakeHTMLElement();
  const input = new FakeHTMLElement({ editable: true });
  host.shadowRoot = { activeElement: input };
  document.activeElement = host;

  const down = press("ArrowDown");
  assert.equal(down.prevented, false);
  assert.equal(down.stopped, false);
  assert.equal(root.scrollCalls.length, 0);
});
