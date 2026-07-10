import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const PRELOAD_SOURCE = readFileSync(
  new URL("./article-reader-preload.cjs", import.meta.url),
  "utf8",
);

function createHarness({ reducedMotion = false, matchMedia = true } = {}) {
  const listeners = new Map();

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

  // Virtual clock driving rAF callbacks and timers in 16 ms steps.
  let now = 0;
  let rafId = 0;
  const rafQueue = new Map();
  let timerId = 0;
  const timers = new Map();

  const window = {
    innerHeight: 700,
    innerWidth: 1_000,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    getComputedStyle: (element) => ({ overflowY: element.overflowY }),
    requestAnimationFrame(callback) {
      rafQueue.set(++rafId, callback);
      return rafId;
    },
    cancelAnimationFrame(id) {
      rafQueue.delete(id);
    },
    setTimeout(fn, delay) {
      timers.set(++timerId, { fn, at: now + delay });
      return timerId;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  if (matchMedia) {
    window.matchMedia = () => ({ matches: reducedMotion });
  }

  vm.runInNewContext(PRELOAD_SOURCE, {
    document,
    HTMLElement: FakeHTMLElement,
    window,
  });

  function tick(ms) {
    const end = now + ms;
    while (now < end) {
      now = Math.min(now + 16, end);
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
      const frames = [...rafQueue.values()];
      rafQueue.clear();
      for (const callback of frames) callback(now);
    }
  }

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
    for (const listener of listeners.get("keydown") ?? []) listener(event);
    return { event, prevented, stopped };
  }

  function release(key) {
    const event = { key };
    for (const listener of listeners.get("keyup") ?? []) listener(event);
  }

  function dispatch(type) {
    for (const listener of listeners.get(type) ?? []) listener({ type });
  }

  function pendingFrames() {
    return rafQueue.size;
  }

  return { FakeHTMLElement, body, document, leaf, press, release, dispatch, tick, pendingFrames, root };
}

test("an arrow tap glides by most of one viewport", () => {
  const { press, release, tick, root } = createHarness();

  const down = press("ArrowDown");
  assert.equal(down.prevented, true);
  assert.equal(down.stopped, true);
  assert.equal(root.scrollTop, 0);

  tick(16);
  assert.ok(root.scrollTop > 0 && root.scrollTop < 504, "moves progressively, not in one jump");

  tick(80);
  release("ArrowDown");
  tick(2_000);
  assert.equal(root.scrollTop, 504);

  press("ArrowUp");
  tick(80);
  release("ArrowUp");
  tick(2_000);
  assert.equal(root.scrollTop, 0);
});

test("quick repeated taps accumulate their destinations", () => {
  const { press, release, tick, root } = createHarness();

  press("ArrowDown");
  tick(32);
  release("ArrowDown");
  press("ArrowDown");
  release("ArrowDown");
  tick(2_000);
  assert.equal(root.scrollTop, 1_008);
});

test("holding an arrow switches to a continuous constant-speed scroll", () => {
  const { press, release, tick, root } = createHarness();

  press("ArrowDown");
  tick(256);
  const atHoldStart = root.scrollTop;

  tick(320);
  const travelled = root.scrollTop - atHoldStart;
  // 1.5 viewports/s on a 700 px viewport = 1.05 px/ms → 336 px over 320 ms.
  assert.ok(Math.abs(travelled - 336) < 2, `expected ≈336 px, got ${travelled}`);

  release("ArrowDown");
  const atRelease = root.scrollTop;
  tick(500);
  assert.equal(root.scrollTop, atRelease, "stops dead on keyup");
});

test("pressing the opposite arrow during a hold reverses direction", () => {
  const { press, release, tick, root } = createHarness();

  press("ArrowDown");
  tick(500);
  const beforeReverse = root.scrollTop;
  assert.ok(beforeReverse > 0);

  press("ArrowUp");
  tick(200);
  assert.ok(root.scrollTop < beforeReverse, "scrolls back up while ArrowUp drives");

  release("ArrowUp");
  release("ArrowDown");
  const atRelease = root.scrollTop;
  tick(500);
  assert.equal(root.scrollTop, atRelease);
});

test("losing focus stops any scroll in flight", () => {
  const { press, dispatch, tick, root } = createHarness();

  press("ArrowDown");
  tick(400);
  dispatch("blur");
  const atBlur = root.scrollTop;
  tick(1_000);
  assert.equal(root.scrollTop, atBlur);
});

test("the wheel cancels a running animation", () => {
  const { press, dispatch, tick, root } = createHarness();

  press("ArrowDown");
  tick(48);
  dispatch("wheel");
  const atWheel = root.scrollTop;
  tick(1_000);
  assert.equal(root.scrollTop, atWheel);
});

test("reduced motion keeps the original instant paged jumps", () => {
  const { press, tick, root } = createHarness({ reducedMotion: true });

  const down = press("ArrowDown");
  assert.equal(down.prevented, true);
  assert.equal(down.stopped, true);
  assert.deepEqual(root.scrollCalls, [{ top: 504, left: 0, behavior: "auto" }]);
  assert.equal(root.scrollTop, 504);

  assert.equal(press("ArrowDown", { repeat: true }).prevented, true);
  assert.equal(root.scrollCalls.at(-1).top, 196);

  press("ArrowUp");
  assert.equal(root.scrollCalls.at(-1).top, -504);
  tick(1_000);
  assert.equal(root.scrollTop, 196);
});

test("a page without matchMedia still gets the animated scroll", () => {
  const { press, release, tick, root } = createHarness({ matchMedia: false });

  press("ArrowDown");
  tick(80);
  release("ArrowDown");
  tick(2_000);
  assert.equal(root.scrollTop, 504);
});

test("a nested scroller at its boundary hands scrolling back to the article", () => {
  const { FakeHTMLElement, document, leaf, press, release, tick, root } = createHarness();
  const nested = new FakeHTMLElement({
    parent: document.body,
    overflowY: "auto",
    scrollHeight: 900,
    clientHeight: 400,
    scrollTop: 500,
  });
  leaf.parentElement = nested;

  assert.equal(press("ArrowDown").prevented, true);
  tick(80);
  release("ArrowDown");
  tick(2_000);
  assert.equal(nested.scrollTop, 500, "nested scroller at its limit stays put");
  assert.equal(root.scrollTop, 504);
});

test("editable controls, including controls in a shadow root, keep native arrows", () => {
  const { FakeHTMLElement, document, press, pendingFrames, root } = createHarness();
  const host = new FakeHTMLElement();
  const input = new FakeHTMLElement({ editable: true });
  host.shadowRoot = { activeElement: input };
  document.activeElement = host;

  const down = press("ArrowDown");
  assert.equal(down.prevented, false);
  assert.equal(down.stopped, false);
  assert.equal(root.scrollTop, 0);
  assert.equal(pendingFrames(), 0);
});
