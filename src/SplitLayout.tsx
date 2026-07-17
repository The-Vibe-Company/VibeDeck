import {
  createContext,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type DragEventHandler,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { LayoutNode } from "./types";

const MIN_RATIO = 0.15;
const MAX_RATIO = 0.85;
const DEFAULT_RATIO = 0.5;
export const SPLIT_DIVIDER_SIZE = 8;
export const MIN_PANEL_WIDTH = 256;
export const MIN_PANEL_HEIGHT = 176;
const PANEL_DRAG_MIME = "application/x-vibedeck-panel";

export interface SplitLayoutProps {
  layout: LayoutNode | null;
  renderPanel: (panelId: string) => ReactNode;
  maximizedPanelId?: string | null;
  onRatioChange: (splitId: string, ratio: number) => void;
  onSwapPanels: (firstPanelId: string, secondPanelId: string) => void;
  onInteractionChange: (active: boolean) => void;
}

export interface SplitPanelDragHandleProps {
  draggable: boolean;
  "data-split-panel-drag-handle": string;
  onDragStart: DragEventHandler<HTMLElement>;
  onDragEnd: DragEventHandler<HTMLElement>;
}

type DragHandleFactory = (panelId: string) => SplitPanelDragHandleProps;

const DragHandleContext = createContext<DragHandleFactory | null>(null);

/**
 * Attach the returned props to a panel header. The leaf itself owns the drop
 * target, so only the header starts a move while the panel content stays fully
 * interactive.
 */
export function useSplitPanelDragHandle(panelId: string): SplitPanelDragHandleProps {
  const makeHandleProps = useContext(DragHandleContext);
  if (!makeHandleProps) {
    throw new Error("useSplitPanelDragHandle must be used inside SplitLayout.");
  }
  return useMemo(() => makeHandleProps(panelId), [makeHandleProps, panelId]);
}

function clampRatio(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_RATIO;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, value));
}

function minimumBranchSpan(node: LayoutNode, direction: "row" | "column"): number {
  if (node.type === "panel") {
    return direction === "row" ? MIN_PANEL_WIDTH : MIN_PANEL_HEIGHT;
  }
  const first = minimumBranchSpan(node.children[0], direction);
  const second = minimumBranchSpan(node.children[1], direction);
  return node.direction === direction
    ? first + SPLIT_DIVIDER_SIZE + second
    : Math.max(first, second);
}

function ratioLimits(span: number, firstMinimum: number, secondMinimum: number) {
  const available = span - SPLIT_DIVIDER_SIZE;
  if (!Number.isFinite(available) || available <= 0) {
    return { minimum: MIN_RATIO, maximum: MAX_RATIO };
  }
  const minimum = Math.max(MIN_RATIO, firstMinimum / available);
  const maximum = Math.min(MAX_RATIO, 1 - secondMinimum / available);
  if (minimum <= maximum) return { minimum, maximum };

  const balanced = Math.min(
    MAX_RATIO,
    Math.max(MIN_RATIO, firstMinimum / Math.max(1, firstMinimum + secondMinimum)),
  );
  return { minimum: balanced, maximum: balanced };
}

function clampedTrack(
  ratio: number,
  firstMinimum: number,
  secondMinimum: number,
) {
  const percent = Number((ratio * 100).toFixed(4));
  const dividerShare = Number((ratio * SPLIT_DIVIDER_SIZE).toFixed(4));
  return `clamp(${firstMinimum}px, calc(${percent}% - ${dividerShare}px), calc(100% - ${SPLIT_DIVIDER_SIZE + secondMinimum}px))`;
}

function findPanel(node: LayoutNode | null, panelId: string): LayoutNode | null {
  if (!node) return null;
  if (node.type === "panel") return node.panelId === panelId ? node : null;
  return findPanel(node.children[0], panelId) ?? findPanel(node.children[1], panelId);
}

function panelIdFromDrag(event: ReactDragEvent<HTMLElement>, fallback?: string | null) {
  if (!fallback) return null;
  if (!Array.from(event.dataTransfer.types).includes(PANEL_DRAG_MIME)) return null;
  const transferredPanelId = event.dataTransfer.getData(PANEL_DRAG_MIME);
  return transferredPanelId && transferredPanelId !== fallback ? null : fallback;
}

interface DragState {
  sourcePanelId: string;
  targetPanelId: string | null;
}

interface BranchProps {
  node: LayoutNode;
  renderPanel: (panelId: string) => ReactNode;
  dragState: DragState | null;
  onDropTargetChange: (panelId: string | null) => void;
  onDropPanel: (event: ReactDragEvent<HTMLDivElement>, panelId: string) => void;
  onRatioChange: (splitId: string, ratio: number) => void;
  beginInteraction: (token: string) => void;
  endInteraction: (token: string) => void;
}

function LayoutBranch({
  node,
  renderPanel,
  dragState,
  onDropTargetChange,
  onDropPanel,
  onRatioChange,
  beginInteraction,
  endInteraction,
}: BranchProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  if (node.type === "panel") {
    const isSource = dragState?.sourcePanelId === node.panelId;
    const isDropTarget = dragState?.targetPanelId === node.panelId;

    return (
      <div
        className={`split-layout__leaf${isSource ? " split-layout__leaf--dragging" : ""}${
          isDropTarget ? " split-layout__leaf--drop-target" : ""
        }`}
        data-panel-id={node.panelId}
        data-drag-source={isSource || undefined}
        data-drop-target={isDropTarget || undefined}
        style={FILL_STYLE}
        onDragOver={(event) => {
          const sourcePanelId = panelIdFromDrag(event, dragState?.sourcePanelId);
          if (!sourcePanelId || sourcePanelId === node.panelId) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          if (!isDropTarget) onDropTargetChange(node.panelId);
        }}
        onDragLeave={(event) => {
          const nextTarget = event.relatedTarget;
          if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
          onDropTargetChange(null);
        }}
        onDrop={(event) => onDropPanel(event, node.panelId)}
      >
        {renderPanel(node.panelId)}
      </div>
    );
  }

  const ratio = clampRatio(node.ratio);
  const isRow = node.direction === "row";
  const firstMinimum = minimumBranchSpan(node.children[0], node.direction);
  const secondMinimum = minimumBranchSpan(node.children[1], node.direction);
  const firstTrack = clampedTrack(ratio, firstMinimum, secondMinimum);
  const splitStyle: CSSProperties = {
    ...FILL_STYLE,
    display: "grid",
    gridTemplateColumns: isRow
      ? `${firstTrack} ${SPLIT_DIVIDER_SIZE}px minmax(${secondMinimum}px, 1fr)`
      : "minmax(0, 1fr)",
    gridTemplateRows: isRow
      ? "minmax(0, 1fr)"
      : `${firstTrack} ${SPLIT_DIVIDER_SIZE}px minmax(${secondMinimum}px, 1fr)`,
  };

  const childProps = {
    renderPanel,
    dragState,
    onDropTargetChange,
    onDropPanel,
    onRatioChange,
    beginInteraction,
    endInteraction,
  };

  return (
    <div
      ref={containerRef}
      className={`split-layout__split split-layout__split--${node.direction}`}
      data-split-id={node.id}
      data-direction={node.direction}
      style={splitStyle}
    >
      <div className="split-layout__pane" style={FILL_STYLE}>
        <LayoutBranch node={node.children[0]} {...childProps} />
      </div>
      <SplitDivider
        splitId={node.id}
        direction={node.direction}
        ratio={ratio}
        firstMinimum={firstMinimum}
        secondMinimum={secondMinimum}
        containerRef={containerRef}
        onRatioChange={onRatioChange}
        beginInteraction={beginInteraction}
        endInteraction={endInteraction}
      />
      <div className="split-layout__pane" style={FILL_STYLE}>
        <LayoutBranch node={node.children[1]} {...childProps} />
      </div>
    </div>
  );
}

interface SplitDividerProps {
  splitId: string;
  direction: "row" | "column";
  ratio: number;
  firstMinimum: number;
  secondMinimum: number;
  containerRef: RefObject<HTMLDivElement | null>;
  onRatioChange: (splitId: string, ratio: number) => void;
  beginInteraction: (token: string) => void;
  endInteraction: (token: string) => void;
}

function SplitDivider({
  splitId,
  direction,
  ratio,
  firstMinimum,
  secondMinimum,
  containerRef,
  onRatioChange,
  beginInteraction,
  endInteraction,
}: SplitDividerProps) {
  const pointerIdRef = useRef<number | null>(null);
  const latestRatioRef = useRef(ratio);
  const resetFrameRef = useRef<number | null>(null);
  const [containerSpan, setContainerSpan] = useState(0);
  const resizeToken = `pointer-resize:${splitId}`;
  const keyboardToken = `keyboard-resize:${splitId}`;
  const limits = ratioLimits(containerSpan, firstMinimum, secondMinimum);
  const displayedRatio = Math.min(limits.maximum, Math.max(limits.minimum, ratio));

  latestRatioRef.current = displayedRatio;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const updateSpan = () => {
      const bounds = container.getBoundingClientRect();
      setContainerSpan(direction === "row" ? bounds.width : bounds.height);
    };
    updateSpan();
    const observer = new ResizeObserver(updateSpan);
    observer.observe(container);
    return () => observer.disconnect();
  }, [containerRef, direction]);

  const commitRatio = useCallback(
    (nextRatio: number) => {
      const clamped = Math.min(
        limits.maximum,
        Math.max(limits.minimum, clampRatio(nextRatio)),
      );
      latestRatioRef.current = clamped;
      onRatioChange(splitId, clamped);
    },
    [limits.maximum, limits.minimum, onRatioChange, splitId],
  );

  const endPointerResize = useCallback(
    (event?: ReactPointerEvent<HTMLDivElement>) => {
      const pointerId = pointerIdRef.current;
      if (pointerId === null || (event && event.pointerId !== pointerId)) return;
      pointerIdRef.current = null;
      if (event?.currentTarget.hasPointerCapture(pointerId)) {
        event.currentTarget.releasePointerCapture(pointerId);
      }
      endInteraction(resizeToken);
    },
    [endInteraction, resizeToken],
  );

  useEffect(
    () => () => {
      endInteraction(resizeToken);
      endInteraction(keyboardToken);
      if (resetFrameRef.current !== null) cancelAnimationFrame(resetFrameRef.current);
    },
    [endInteraction, keyboardToken, resizeToken],
  );

  function updateFromPointer(event: ReactPointerEvent<HTMLDivElement>) {
    if (pointerIdRef.current !== event.pointerId) return;
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const span = direction === "row" ? bounds.width : bounds.height;
    const available = span - SPLIT_DIVIDER_SIZE;
    if (available <= 0) return;
    const offset =
      direction === "row" ? event.clientX - bounds.left : event.clientY - bounds.top;
    commitRatio((offset - SPLIT_DIVIDER_SIZE / 2) / available);
  }

  function keyboardRatio(event: ReactKeyboardEvent<HTMLDivElement>) {
    const smallStep = event.altKey ? 0.01 : event.shiftKey ? 0.1 : 0.05;
    if (event.key === "Home") return limits.minimum;
    if (event.key === "End") return limits.maximum;
    if (
      (direction === "row" && event.key === "ArrowLeft") ||
      (direction === "column" && event.key === "ArrowUp")
    ) {
      return latestRatioRef.current - smallStep;
    }
    if (
      (direction === "row" && event.key === "ArrowRight") ||
      (direction === "column" && event.key === "ArrowDown")
    ) {
      return latestRatioRef.current + smallStep;
    }
    return null;
  }

  const orientation = direction === "row" ? "vertical" : "horizontal";

  return (
    <div
      className={`split-layout__divider split-layout__divider--${orientation}`}
      role="separator"
      tabIndex={0}
      aria-label="Redimensionner les panels"
      aria-orientation={orientation}
      aria-valuemin={Math.round(limits.minimum * 100)}
      aria-valuemax={Math.round(limits.maximum * 100)}
      aria-valuenow={Math.round(displayedRatio * 100)}
      aria-valuetext={`${Math.round(displayedRatio * 100)} %`}
      data-split-id={splitId}
      style={{
        cursor: direction === "row" ? "col-resize" : "row-resize",
        touchAction: "none",
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || pointerIdRef.current !== null) return;
        event.preventDefault();
        event.stopPropagation();
        pointerIdRef.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
        beginInteraction(resizeToken);
      }}
      onPointerMove={updateFromPointer}
      onPointerUp={endPointerResize}
      onPointerCancel={endPointerResize}
      onLostPointerCapture={(event) => {
        if (pointerIdRef.current !== event.pointerId) return;
        pointerIdRef.current = null;
        endInteraction(resizeToken);
      }}
      onDoubleClick={(event) => {
        event.preventDefault();
        beginInteraction(resizeToken);
        commitRatio(DEFAULT_RATIO);
        if (resetFrameRef.current !== null) cancelAnimationFrame(resetFrameRef.current);
        resetFrameRef.current = requestAnimationFrame(() => {
          resetFrameRef.current = null;
          endInteraction(resizeToken);
        });
      }}
      onKeyDown={(event) => {
        const nextRatio = keyboardRatio(event);
        if (nextRatio === null) return;
        event.preventDefault();
        event.stopPropagation();
        beginInteraction(keyboardToken);
        commitRatio(nextRatio);
      }}
      onKeyUp={(event) => {
        if (keyboardRatio(event) === null) return;
        endInteraction(keyboardToken);
      }}
      onBlur={() => endInteraction(keyboardToken)}
    />
  );
}

const FILL_STYLE: CSSProperties = {
  width: "100%",
  height: "100%",
  minWidth: 0,
  minHeight: 0,
  overflow: "hidden",
};

export default function SplitLayout({
  layout,
  renderPanel,
  maximizedPanelId = null,
  onRatioChange,
  onSwapPanels,
  onInteractionChange,
}: SplitLayoutProps) {
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [isInteracting, setIsInteracting] = useState(false);
  const interactionsRef = useRef(new Set<string>());
  const interactionCallbackRef = useRef(onInteractionChange);

  interactionCallbackRef.current = onInteractionChange;

  const beginInteraction = useCallback((token: string) => {
    const interactions = interactionsRef.current;
    const wasActive = interactions.size > 0;
    interactions.add(token);
    if (!wasActive) {
      setIsInteracting(true);
      interactionCallbackRef.current(true);
    }
  }, []);

  const endInteraction = useCallback((token: string) => {
    const interactions = interactionsRef.current;
    if (!interactions.delete(token) || interactions.size > 0) return;
    setIsInteracting(false);
    interactionCallbackRef.current(false);
  }, []);

  useEffect(
    () => () => {
      if (interactionsRef.current.size === 0) return;
      interactionsRef.current.clear();
      interactionCallbackRef.current(false);
    },
    [],
  );

  const finishPanelDrag = useCallback(() => {
    setDragState(null);
    endInteraction("panel-drag");
  }, [endInteraction]);

  const makeHandleProps = useCallback<DragHandleFactory>(
    (panelId) => ({
      draggable: !maximizedPanelId,
      "data-split-panel-drag-handle": panelId,
      onDragStart: (event) => {
        if (maximizedPanelId) {
          event.preventDefault();
          return;
        }
        event.stopPropagation();
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(PANEL_DRAG_MIME, panelId);
        setDragState({ sourcePanelId: panelId, targetPanelId: null });
        beginInteraction("panel-drag");
      },
      onDragEnd: finishPanelDrag,
    }),
    [beginInteraction, finishPanelDrag, maximizedPanelId],
  );

  const visibleLayout =
    maximizedPanelId && findPanel(layout, maximizedPanelId)
      ? ({ type: "panel", panelId: maximizedPanelId } satisfies LayoutNode)
      : layout;
  const rootStyle: CSSProperties = visibleLayout
    ? {
        ...FILL_STYLE,
        minWidth: minimumBranchSpan(visibleLayout, "row"),
        minHeight: minimumBranchSpan(visibleLayout, "column"),
      }
    : FILL_STYLE;

  return (
    <DragHandleContext.Provider value={makeHandleProps}>
      <div
        className={`split-layout${visibleLayout ? "" : " split-layout--empty"}${
          isInteracting ? " split-layout--interacting" : ""
        }`}
        data-interacting={isInteracting || undefined}
        data-maximized-panel-id={maximizedPanelId ?? undefined}
        style={rootStyle}
      >
        {visibleLayout && (
          <LayoutBranch
            node={visibleLayout}
            renderPanel={renderPanel}
            dragState={dragState}
            onDropTargetChange={(targetPanelId) =>
              setDragState((current) =>
                current ? { ...current, targetPanelId } : current,
              )
            }
            onDropPanel={(event, targetPanelId) => {
              const sourcePanelId = panelIdFromDrag(event, dragState?.sourcePanelId);
              if (!sourcePanelId) return;
              event.preventDefault();
              event.stopPropagation();
              try {
                if (
                  sourcePanelId &&
                  sourcePanelId !== targetPanelId &&
                  findPanel(layout, sourcePanelId) &&
                  findPanel(layout, targetPanelId)
                ) {
                  onSwapPanels(sourcePanelId, targetPanelId);
                }
              } finally {
                finishPanelDrag();
              }
            }}
            onRatioChange={onRatioChange}
            beginInteraction={beginInteraction}
            endInteraction={endInteraction}
          />
        )}
      </div>
    </DragHandleContext.Provider>
  );
}
