// Retargetable smooth scrolling for keyboard navigation. One animation per
// container; calling smoothScrollIntoView again while it runs just swaps the
// target, so holding an arrow key produces one continuous glide instead of a
// series of jumps.

type ScrollAnimation = {
  target: HTMLElement;
  // Float accumulator: per-frame increments below one pixel would stall if we
  // round-tripped through scrollTop.
  pos: number;
  lastWritten: number;
  lastScrollHeight: number;
  lastTime: number | null;
  frame: number;
  detach: () => void;
};

const animations = new WeakMap<HTMLElement, ScrollAnimation>();

// Slower than the reader's tap glide (60 ms): the feed follows a selection
// that moves one row at a time, so the follower needs more damping.
const TAU_MS = 80;
// Frames can be frozen when the window is hidden; cap dt so a thawed frame
// does not produce a giant jump.
const MAX_FRAME_MS = 64;

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

// Destination matching scrollIntoView({ block: "nearest" }) plus one row of
// context (scroll-margin semantics), computed from live geometry so it stays
// correct when items are prepended mid-animation. The margin also absorbs the
// follower's steady-state lag: without it, a held key keeps the focused row
// clipped just past the viewport edge for the whole scroll. `from` is the
// position the animation is converging on, not the current scrollTop —
// otherwise a held key under-scrolls.
function nearestDestination(
  container: HTMLElement,
  target: HTMLElement,
  from: number,
): { destination: number; margin: number } {
  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const elementTop = container.scrollTop + (targetRect.top - containerRect.top);
  const elementBottom = elementTop + targetRect.height;
  const margin = Math.max(
    0,
    Math.min(targetRect.height, (container.clientHeight - targetRect.height) / 2),
  );
  let destination = from;
  if (elementTop - margin < destination) {
    destination = elementTop - margin;
  } else if (elementBottom + margin > destination + container.clientHeight) {
    destination = elementBottom + margin - container.clientHeight;
  }
  destination = Math.max(
    0,
    Math.min(destination, container.scrollHeight - container.clientHeight),
  );
  return { destination, margin };
}

// scrollTop assignment honours a CSS `scroll-behavior: smooth`, which would
// turn each frame write into a competing native animation; scrollTo can
// force instant behavior.
function writeScrollTop(container: HTMLElement, value: number): void {
  if (typeof container.scrollTo === "function") {
    container.scrollTo({ top: value, behavior: "instant" });
  } else {
    container.scrollTop = value;
  }
}

export function cancelSmoothScroll(container: HTMLElement): void {
  const animation = animations.get(container);
  if (!animation) return;
  window.cancelAnimationFrame(animation.frame);
  animation.detach();
  animations.delete(container);
}

export function smoothScrollIntoView(container: HTMLElement, target: HTMLElement): void {
  if (prefersReducedMotion()) {
    cancelSmoothScroll(container);
    writeScrollTop(
      container,
      nearestDestination(container, target, container.scrollTop).destination,
    );
    return;
  }

  const existing = animations.get(container);
  if (existing) {
    existing.target = target;
    return;
  }

  const cancel = () => cancelSmoothScroll(container);
  const animation: ScrollAnimation = {
    target,
    pos: container.scrollTop,
    lastWritten: container.scrollTop,
    lastScrollHeight: container.scrollHeight,
    lastTime: null,
    frame: 0,
    detach: () => {
      container.removeEventListener("wheel", cancel);
      container.removeEventListener("touchstart", cancel);
      container.removeEventListener("pointerdown", cancel);
      container.removeEventListener("mousedown", cancel);
    },
  };
  // The user regains control instantly: any pointer interaction cancels.
  // mousedown is needed on top of pointerdown because native scrollbars
  // dispatch mouse events but no pointer events.
  container.addEventListener("wheel", cancel, { passive: true });
  container.addEventListener("touchstart", cancel, { passive: true });
  container.addEventListener("pointerdown", cancel, { passive: true });
  container.addEventListener("mousedown", cancel, { passive: true });
  animations.set(container, animation);

  const step = (now: number) => {
    if (animations.get(container) !== animation) return;
    if (!container.isConnected || !animation.target.isConnected) {
      cancelSmoothScroll(container);
      return;
    }
    // Someone else moved the list. Two very different cases:
    // - content changed too (scroll-preservation effect compensating a
    //   prepend): adopt the shifted position and keep gliding;
    // - content unchanged (Home/End, a programmatic jump, a scrollbar path
    //   we could not observe): that scroll wins — cancel instead of
    //   dragging the list back toward the focused row.
    if (Math.abs(container.scrollTop - animation.lastWritten) > 1) {
      if (Math.abs(container.scrollHeight - animation.lastScrollHeight) > 1) {
        animation.pos = container.scrollTop;
      } else {
        cancelSmoothScroll(container);
        return;
      }
    }
    animation.lastScrollHeight = container.scrollHeight;
    const { destination, margin } = nearestDestination(container, animation.target, animation.pos);
    const dt = Math.min(
      animation.lastTime === null ? 16 : now - animation.lastTime,
      MAX_FRAME_MS,
    );
    animation.lastTime = now;
    const alpha = 1 - Math.exp(-dt / TAU_MS);
    animation.pos += (destination - animation.pos) * alpha;
    // A very fast key repeat outruns the exponential follower; cap the error
    // at the context margin so the focused row never leaves the viewport.
    if (destination - animation.pos > margin) {
      animation.pos = destination - margin;
    } else if (animation.pos - destination > margin) {
      animation.pos = destination + margin;
    }
    if (Math.abs(destination - animation.pos) < 0.5) {
      writeScrollTop(container, destination);
      cancelSmoothScroll(container);
      return;
    }
    writeScrollTop(container, animation.pos);
    animation.lastWritten = container.scrollTop;
    animation.frame = window.requestAnimationFrame(step);
  };
  animation.frame = window.requestAnimationFrame(step);
}
