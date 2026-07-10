import assert from "node:assert/strict";
import test from "node:test";
import { cancelSmoothScroll, smoothScrollIntoView } from "../src/smooth-scroll.ts";

// Virtual rAF clock: the module only touches window.requestAnimationFrame,
// window.cancelAnimationFrame and window.matchMedia.
function installWindow({ reducedMotion = false } = {}) {
  let now = 0;
  let rafId = 0;
  const rafQueue = new Map();

  globalThis.window = {
    matchMedia: () => ({ matches: reducedMotion }),
    requestAnimationFrame(callback) {
      rafQueue.set(++rafId, callback);
      return rafId;
    },
    cancelAnimationFrame(id) {
      rafQueue.delete(id);
    },
  };

  function tick(ms) {
    const end = now + ms;
    while (now < end) {
      now = Math.min(now + 16, end);
      const frames = [...rafQueue.values()];
      rafQueue.clear();
      for (const callback of frames) callback(now);
    }
  }

  return { tick, pendingFrames: () => rafQueue.size };
}

class FakeList {
  constructor({ scrollHeight, clientHeight }) {
    this.scrollHeight = scrollHeight;
    this.clientHeight = clientHeight;
    this.scrollTop = 0;
    this.isConnected = true;
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  removeEventListener(type, listener) {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }

  dispatch(type) {
    this.listeners.get(type)?.({ type });
  }

  getBoundingClientRect() {
    return { top: 0, height: this.clientHeight };
  }
}

class FakeRow {
  constructor(list, offsetTop, height = 60) {
    this.list = list;
    this.offsetTop = offsetTop;
    this.height = height;
    this.isConnected = true;
  }

  getBoundingClientRect() {
    return { top: this.offsetTop - this.list.scrollTop, height: this.height };
  }
}

test("glides to reveal a row below the viewport with one row of context", () => {
  const { tick } = installWindow();
  const list = new FakeList({ scrollHeight: 3_000, clientHeight: 700 });
  const row = new FakeRow(list, 1_000);

  smoothScrollIntoView(list, row);
  assert.equal(list.scrollTop, 0, "nothing moves before the first frame");
  tick(16);
  assert.ok(list.scrollTop > 0 && list.scrollTop < 420, "moves progressively");
  tick(2_000);
  // 1000 + 60 (row) + 60 (context margin) - 700 = 420
  assert.equal(list.scrollTop, 420);
  assert.equal(list.listeners.size, 0, "cancel listeners are detached on completion");
});

test("retargeting mid-flight glides on to the new row without restarting", () => {
  const { tick } = installWindow();
  const list = new FakeList({ scrollHeight: 3_000, clientHeight: 700 });
  const rowA = new FakeRow(list, 1_000);
  const rowB = new FakeRow(list, 1_400);

  smoothScrollIntoView(list, rowA);
  tick(64);
  const midFlight = list.scrollTop;
  assert.ok(midFlight > 0);
  smoothScrollIntoView(list, rowB);
  tick(3_000);
  assert.equal(list.scrollTop, 820);
});

test("adopts an external scroll shift (prepend compensation) and stays on target", () => {
  const { tick } = installWindow();
  const list = new FakeList({ scrollHeight: 3_000, clientHeight: 700 });
  const row = new FakeRow(list, 1_000);

  smoothScrollIntoView(list, row);
  tick(64);
  // The scroll-preservation effect prepends 80 px of new rows and shifts
  // everything synchronously.
  row.offsetTop += 80;
  list.scrollHeight += 80;
  list.scrollTop += 80;
  tick(3_000);
  assert.equal(list.scrollTop, 500);
});

test("wheel input cancels the animation immediately", () => {
  const { tick } = installWindow();
  const list = new FakeList({ scrollHeight: 3_000, clientHeight: 700 });
  const row = new FakeRow(list, 1_000);

  smoothScrollIntoView(list, row);
  tick(32);
  list.dispatch("wheel");
  const atCancel = list.scrollTop;
  tick(1_000);
  assert.equal(list.scrollTop, atCancel);
  assert.equal(list.listeners.size, 0);
});

test("a mouse press (scrollbar drag) cancels the animation", () => {
  const { tick } = installWindow();
  const list = new FakeList({ scrollHeight: 3_000, clientHeight: 700 });
  const row = new FakeRow(list, 1_000);

  smoothScrollIntoView(list, row);
  tick(32);
  list.dispatch("mousedown");
  const atCancel = list.scrollTop;
  tick(1_000);
  assert.equal(list.scrollTop, atCancel);
});

test("cancelSmoothScroll stops a glide in place", () => {
  const { tick } = installWindow();
  const list = new FakeList({ scrollHeight: 3_000, clientHeight: 700 });
  const row = new FakeRow(list, 1_000);

  smoothScrollIntoView(list, row);
  tick(32);
  cancelSmoothScroll(list);
  const atCancel = list.scrollTop;
  tick(1_000);
  assert.equal(list.scrollTop, atCancel);
});

test("a row removed mid-flight stops the animation cleanly", () => {
  const { tick } = installWindow();
  const list = new FakeList({ scrollHeight: 3_000, clientHeight: 700 });
  const row = new FakeRow(list, 1_000);

  smoothScrollIntoView(list, row);
  tick(32);
  row.isConnected = false;
  const atRemoval = list.scrollTop;
  tick(1_000);
  assert.equal(list.scrollTop, atRemoval);
  assert.equal(list.listeners.size, 0);
});

test("reduced motion jumps instantly without scheduling frames", () => {
  const { pendingFrames } = installWindow({ reducedMotion: true });
  const list = new FakeList({ scrollHeight: 3_000, clientHeight: 700 });
  const row = new FakeRow(list, 1_000);

  smoothScrollIntoView(list, row);
  assert.equal(list.scrollTop, 420);
  assert.equal(pendingFrames(), 0);
});
