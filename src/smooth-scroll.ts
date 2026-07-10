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
  lastTime: number | null;
  frame: number;
  detach: () => void;
};

const animations = new WeakMap<HTMLElement, ScrollAnimation>();

const TAU_MS = 80;
// Frames can be frozen when the window is hidden; cap dt so a thawed frame
// does not produce a giant jump.
const MAX_FRAME_MS = 64;

export function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

// Destination matching scrollIntoView({ block: "nearest" }), computed from
// live geometry so it stays correct when items are prepended mid-animation.
// `from` is the position the animation is converging on, not the current
// scrollTop — otherwise a held key under-scrolls.
function nearestDestination(
  container: HTMLElement,
  target: HTMLElement,
  from: number,
): number {
  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const elementTop = container.scrollTop + (targetRect.top - containerRect.top);
  const elementBottom = elementTop + targetRect.height;
  let destination = from;
  if (elementTop < destination) {
    destination = elementTop;
  } else if (elementBottom > destination + container.clientHeight) {
    destination = elementBottom - container.clientHeight;
  }
  return Math.max(0, Math.min(destination, container.scrollHeight - container.clientHeight));
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
    container.scrollTop = nearestDestination(container, target, container.scrollTop);
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
    lastTime: null,
    frame: 0,
    detach: () => {
      container.removeEventListener("wheel", cancel);
      container.removeEventListener("touchstart", cancel);
      container.removeEventListener("pointerdown", cancel);
    },
  };
  // The user regains control instantly: any pointer interaction cancels.
  container.addEventListener("wheel", cancel, { passive: true });
  container.addEventListener("touchstart", cancel, { passive: true });
  container.addEventListener("pointerdown", cancel, { passive: true });
  animations.set(container, animation);

  const step = (now: number) => {
    if (animations.get(container) !== animation) return;
    if (!container.isConnected || !animation.target.isConnected) {
      cancelSmoothScroll(container);
      return;
    }
    // Someone else moved the list (e.g. the scroll-preservation effect when
    // new articles are prepended): adopt the new position and keep going.
    if (Math.abs(container.scrollTop - animation.lastWritten) > 1) {
      animation.pos = container.scrollTop;
    }
    const destination = nearestDestination(container, animation.target, animation.pos);
    const dt = Math.min(
      animation.lastTime === null ? 16 : now - animation.lastTime,
      MAX_FRAME_MS,
    );
    animation.lastTime = now;
    const alpha = 1 - Math.exp(-dt / TAU_MS);
    animation.pos += (destination - animation.pos) * alpha;
    if (Math.abs(destination - animation.pos) < 0.5) {
      container.scrollTop = destination;
      cancelSmoothScroll(container);
      return;
    }
    container.scrollTop = animation.pos;
    animation.lastWritten = container.scrollTop;
    animation.frame = window.requestAnimationFrame(step);
  };
  animation.frame = window.requestAnimationFrame(step);
}
