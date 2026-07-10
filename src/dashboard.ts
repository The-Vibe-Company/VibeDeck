import type { LayoutNode } from "./types";

export function layoutPanelIds(node: LayoutNode | null): string[] {
  if (!node) return [];
  if (node.type === "panel") return [node.panelId];
  return [...layoutPanelIds(node.children[0]), ...layoutPanelIds(node.children[1])];
}

export function makeSplitId() {
  return `split-${crypto.randomUUID()}`;
}

export function splitPanel(
  node: LayoutNode | null,
  targetPanelId: string | null,
  newPanelId: string,
  direction: "row" | "column" = "row",
): LayoutNode {
  const nextLeaf: LayoutNode = { type: "panel", panelId: newPanelId };
  if (!node) return nextLeaf;
  if (!targetPanelId) {
    return {
      type: "split",
      id: makeSplitId(),
      direction,
      ratio: 0.64,
      children: [node, nextLeaf],
    };
  }
  if (node.type === "panel") {
    if (node.panelId !== targetPanelId) return node;
    return {
      type: "split",
      id: makeSplitId(),
      direction,
      ratio: 0.5,
      children: [node, nextLeaf],
    };
  }
  return {
    ...node,
    children: [
      splitPanel(node.children[0], targetPanelId, newPanelId, direction),
      containsPanel(node.children[0], targetPanelId)
        ? node.children[1]
        : splitPanel(node.children[1], targetPanelId, newPanelId, direction),
    ],
  };
}

export function containsPanel(node: LayoutNode | null, panelId: string) {
  return layoutPanelIds(node).includes(panelId);
}

export function removePanel(node: LayoutNode | null, panelId: string): LayoutNode | null {
  if (!node) return null;
  if (node.type === "panel") return node.panelId === panelId ? null : node;
  const first = removePanel(node.children[0], panelId);
  const second = removePanel(node.children[1], panelId);
  if (!first) return second;
  if (!second) return first;
  return { ...node, children: [first, second] };
}

export function updateSplitRatio(
  node: LayoutNode | null,
  splitId: string,
  ratio: number,
): LayoutNode | null {
  if (!node || node.type === "panel") return node;
  if (node.id === splitId) {
    return { ...node, ratio: Math.min(0.85, Math.max(0.15, ratio)) };
  }
  return {
    ...node,
    children: [
      updateSplitRatio(node.children[0], splitId, ratio)!,
      updateSplitRatio(node.children[1], splitId, ratio)!,
    ],
  };
}

export function swapPanels(
  node: LayoutNode | null,
  firstPanelId: string,
  secondPanelId: string,
): LayoutNode | null {
  if (!node || firstPanelId === secondPanelId) return node;
  if (node.type === "panel") {
    if (node.panelId === firstPanelId) return { ...node, panelId: secondPanelId };
    if (node.panelId === secondPanelId) return { ...node, panelId: firstPanelId };
    return node;
  }
  return {
    ...node,
    children: [
      swapPanels(node.children[0], firstPanelId, secondPanelId)!,
      swapPanels(node.children[1], firstPanelId, secondPanelId)!,
    ],
  };
}

export function replacePanelId(
  node: LayoutNode | null,
  currentPanelId: string,
  nextPanelId: string,
): LayoutNode | null {
  if (!node) return null;
  if (node.type === "panel") {
    return node.panelId === currentPanelId ? { ...node, panelId: nextPanelId } : node;
  }
  return {
    ...node,
    children: [
      replacePanelId(node.children[0], currentPanelId, nextPanelId)!,
      replacePanelId(node.children[1], currentPanelId, nextPanelId)!,
    ],
  };
}
