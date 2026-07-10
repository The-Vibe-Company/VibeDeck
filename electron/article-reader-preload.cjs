// Runs in Electron's isolated preload world before third-party page scripts.
// It deliberately exposes no API to the article and never uses a synthetic
// user gesture.
(() => {
  const EDITABLE_SELECTOR =
    "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']";
  const SCROLLABLE_OVERFLOW = /^(?:auto|scroll|overlay)$/;

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
      const scroller = scrollTarget(direction);
      if (!scroller) return;

      const rootScroller = document.scrollingElement || document.documentElement;
      const viewport =
        scroller === rootScroller
          ? Math.max(window.innerHeight, document.documentElement.clientHeight)
          : scroller.clientHeight;
      const overlap = Math.max(120, Math.round(viewport * 0.28));
      const distance = event.repeat
        ? Math.max(140, Math.round(viewport * 0.28))
        : Math.max(1, viewport - overlap);

      event.preventDefault();
      event.stopImmediatePropagation();
      scroller.scrollBy({
        top: direction * distance,
        left: 0,
        behavior: "auto",
      });
    },
    { capture: true },
  );
})();
