// Runs in Electron's isolated preload world before third-party page scripts.
// It deliberately exposes no API to the article and never uses a synthetic
// user gesture.
(() => {
  const EDITABLE_SELECTOR =
    "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']";
  const SCROLLABLE_OVERFLOW = /^(?:auto|scroll|overlay)$/;
  // A tap glides one page; holding the key past this delay switches to a
  // constant-velocity scroll until keyup.
  const HOLD_DELAY_MS = 250;
  const HOLD_VIEWPORTS_PER_SECOND = 1.5;
  // Faster than the feed's follower (80 ms in src/smooth-scroll.ts): a tap
  // travels most of a viewport, so it needs a snappier glide.
  const TAP_TAU_MS = 60;
  // Visual overlap kept between two paged jumps.
  const OVERLAP_RATIO = 0.28;
  const OVERLAP_MIN_PX = 120;
  const REPEAT_STEP_MIN_PX = 140;
  // Frames can be frozen by backgroundThrottling; cap dt so a thawed frame
  // does not produce a giant jump.
  const MAX_FRAME_MS = 64;

  function deepestActiveElement() {
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    return active;
  }

  function isEditable(element) {
    return (
      element instanceof HTMLElement &&
      (element.isContentEditable || element.matches(EDITABLE_SELECTOR))
    );
  }

  function canScroll(element, direction, rootScroller) {
    if (!(element instanceof HTMLElement)) return false;
    const maximum = element.scrollHeight - element.clientHeight;
    if (maximum <= 8) return false;

    const overflowY = window.getComputedStyle(element).overflowY;
    if (element === rootScroller) {
      if (overflowY === "hidden" || overflowY === "clip") return false;
    } else if (!SCROLLABLE_OVERFLOW.test(overflowY)) {
      return false;
    }

    return direction > 0
      ? element.scrollTop < maximum - 8
      : element.scrollTop > 8;
  }

  function scrollTarget(direction) {
    const rootScroller = document.scrollingElement || document.documentElement;
    let candidate = document.elementFromPoint(
      window.innerWidth / 2,
      window.innerHeight / 2,
    );

    while (candidate) {
      if (canScroll(candidate, direction, rootScroller)) return candidate;
      if (candidate === document.body || candidate === document.documentElement) break;
      candidate = candidate.parentElement;
    }

    return canScroll(rootScroller, direction, rootScroller) ? rootScroller : null;
  }

  function prefersReducedMotion() {
    return (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  function viewportOf(scroller) {
    const rootScroller = document.scrollingElement || document.documentElement;
    return scroller === rootScroller
      ? Math.max(window.innerHeight, document.documentElement.clientHeight)
      : scroller.clientHeight;
  }

  function maxScrollTop(scroller) {
    return Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  }

  function pageDistance(scroller) {
    const viewport = viewportOf(scroller);
    const overlap = Math.max(OVERLAP_MIN_PX, Math.round(viewport * OVERLAP_RATIO));
    return Math.max(1, viewport - overlap);
  }

  const pressed = { ArrowDown: false, ArrowUp: false };
  let drivingKey = null;
  let mode = "idle"; // "idle" | "tap" | "hold"
  let scroller = null;
  // Float accumulator: per-frame increments below one pixel would stall if we
  // round-tripped through scrollTop.
  let pos = 0;
  let lastWritten = 0;
  let tapDest = 0;
  let lastTime = null;
  let frame = 0;
  let holdTimer = 0;

  function syncPos() {
    pos = scroller.scrollTop;
    lastWritten = pos;
  }

  function writePos(value) {
    scroller.scrollTop = value;
    lastWritten = scroller.scrollTop;
  }

  function currentDirection() {
    if (drivingKey && pressed[drivingKey]) return drivingKey === "ArrowDown" ? 1 : -1;
    return 0;
  }

  function stopAnimation() {
    if (frame) {
      window.cancelAnimationFrame(frame);
      frame = 0;
    }
    lastTime = null;
  }

  function clearHoldTimer() {
    if (holdTimer) {
      window.clearTimeout(holdTimer);
      holdTimer = 0;
    }
  }

  // Full reset: keyup events are lost when the view loses focus, and a frozen
  // rAF loop would otherwise resume a phantom scroll when the view comes back.
  function resetAll() {
    pressed.ArrowDown = false;
    pressed.ArrowUp = false;
    drivingKey = null;
    mode = "idle";
    scroller = null;
    clearHoldTimer();
    stopAnimation();
  }

  function step(now) {
    frame = 0;
    if (!scroller || mode === "idle") {
      stopAnimation();
      return;
    }
    // Someone else moved the page (scroll anchoring on late-loading content,
    // page scripts): adopt the new position instead of overwriting it.
    if (Math.abs(scroller.scrollTop - lastWritten) > 1) {
      pos = scroller.scrollTop;
      lastWritten = pos;
    }
    const dt = Math.min(lastTime === null ? 16 : now - lastTime, MAX_FRAME_MS);
    lastTime = now;

    if (mode === "hold") {
      const direction = currentDirection();
      if (!direction) {
        mode = "idle";
        stopAnimation();
        return;
      }
      const speed = (HOLD_VIEWPORTS_PER_SECOND * viewportOf(scroller)) / 1000;
      const maximum = maxScrollTop(scroller);
      pos = Math.max(0, Math.min(maximum, pos + direction * speed * dt));
      writePos(pos);
      const atBoundary = direction > 0 ? pos >= maximum : pos <= 0;
      if (atBoundary) {
        // A nested scroller at its limit hands scrolling back to the article.
        const replacement = scrollTarget(direction);
        if (replacement && replacement !== scroller) {
          scroller = replacement;
          syncPos();
        }
      }
      frame = window.requestAnimationFrame(step);
      return;
    }

    // mode === "tap"
    const destination = Math.max(0, Math.min(maxScrollTop(scroller), tapDest));
    const alpha = 1 - Math.exp(-dt / TAP_TAU_MS);
    pos += (destination - pos) * alpha;
    if (Math.abs(destination - pos) < 0.5) {
      writePos(destination);
      pos = destination;
      mode = "idle";
      stopAnimation();
      return;
    }
    writePos(pos);
    frame = window.requestAnimationFrame(step);
  }

  function startAnimation() {
    if (!frame) {
      lastTime = null;
      frame = window.requestAnimationFrame(step);
    }
  }

  function enterHold() {
    if (!scroller) return;
    clearHoldTimer();
    mode = "hold";
    syncPos();
    startAnimation();
  }

  function armHoldTimer(key) {
    clearHoldTimer();
    holdTimer = window.setTimeout(() => {
      holdTimer = 0;
      if (pressed[key]) enterHold();
    }, HOLD_DELAY_MS);
  }

  window.addEventListener(
    "keydown",
    (event) => {
      if (
        (event.key !== "ArrowDown" && event.key !== "ArrowUp") ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.defaultPrevented ||
        isEditable(deepestActiveElement())
      ) {
        return;
      }

      const direction = event.key === "ArrowDown" ? 1 : -1;

      if (prefersReducedMotion()) {
        const target = scrollTarget(direction);
        if (!target) return;
        const viewport = viewportOf(target);
        const distance = event.repeat
          ? Math.max(REPEAT_STEP_MIN_PX, Math.round(viewport * OVERLAP_RATIO))
          : pageDistance(target);
        event.preventDefault();
        event.stopImmediatePropagation();
        target.scrollBy({ top: direction * distance, left: 0, behavior: "auto" });
        return;
      }

      // OS auto-repeat while we already track the key: it only accelerates
      // the switch to hold (the 250 ms timer usually gets there first).
      if (event.repeat && pressed[event.key]) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (mode !== "hold") enterHold();
        return;
      }

      const target = scrollTarget(direction);
      const active = target ?? (mode !== "idle" ? scroller : null);
      if (!active) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      pressed[event.key] = true;
      drivingKey = event.key;

      if (active !== scroller) {
        scroller = active;
        syncPos();
        tapDest = pos;
      }

      if (mode !== "hold") {
        if (mode === "idle") {
          syncPos();
          tapDest = pos;
        }
        tapDest = Math.max(
          0,
          Math.min(maxScrollTop(scroller), tapDest + direction * pageDistance(scroller)),
        );
        mode = "tap";
        startAnimation();
      }

      armHoldTimer(event.key);
    },
    { capture: true },
  );

  window.addEventListener(
    "keyup",
    (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      if (!pressed[event.key]) return;
      pressed[event.key] = false;
      if (drivingKey === event.key) {
        drivingKey = pressed.ArrowDown ? "ArrowDown" : pressed.ArrowUp ? "ArrowUp" : null;
      }
      if (!pressed.ArrowDown && !pressed.ArrowUp) {
        clearHoldTimer();
        // A tap glide is left to finish; only the constant-velocity hold
        // stops dead on release.
        if (mode === "hold") {
          mode = "idle";
          stopAnimation();
        }
      } else if (mode !== "hold" && drivingKey) {
        // The surviving key's hold timer was stolen by the released key's
        // keydown (single timer slot); re-arm it or the still-held arrow
        // would never reach hold.
        armHoldTimer(drivingKey);
      }
    },
    { capture: true },
  );

  window.addEventListener("blur", resetAll);
  // Any direct user interaction wins over a running animation. mousedown
  // covers scrollbar drags, which dispatch no wheel/touch/pointer events.
  window.addEventListener("wheel", resetAll, { passive: true });
  window.addEventListener("touchstart", resetAll, { passive: true });
  window.addEventListener("mousedown", resetAll, { passive: true });
})();
