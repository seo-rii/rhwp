import type {
  LayerAffineTransform,
  LayerGlyphOutlineColorClipNode,
  LayerGlyphOutlineColorCompositeMode,
  LayerGlyphOutlineColorLinearGradientPathNode,
  LayerGlyphOutlineColorPaintGraphPayload,
  LayerGlyphOutlineColorRadialGradientPathNode,
  LayerGlyphOutlineResolvedColor,
  LayerGlyphOutlineColorSolidPathNode,
  LayerGlyphOutlineColorSweepGradientPathNode,
} from '@/core/types';

export interface ColorPaintGraphReplayCallbacks {
  renderSolidPath(node: LayerGlyphOutlineColorSolidPathNode): void;
  renderLinearGradientPath(node: LayerGlyphOutlineColorLinearGradientPathNode): void;
  renderRadialGradientPath(node: LayerGlyphOutlineColorRadialGradientPathNode): void;
  renderSweepGradientPath(node: LayerGlyphOutlineColorSweepGradientPathNode): void;
  withTransform(transform: LayerAffineTransform, draw: () => void): void;
  withClip(node: LayerGlyphOutlineColorClipNode, draw: () => void): void;
  renderComposite(mode: LayerGlyphOutlineColorCompositeMode, drawBackdrop: () => void, drawSource: () => void): void;
}

export function replayColorPaintGraph(
  graph: LayerGlyphOutlineColorPaintGraphPayload,
  callbacks: ColorPaintGraphReplayCallbacks,
): void {
  const nodesById = new Map(graph.nodes.map((node) => [node.nodeId, node]));
  const renderNode = (nodeId: number, stack: Set<number>): void => {
    if (stack.has(nodeId)) {
      return;
    }
    const node = nodesById.get(nodeId);
    if (!node) {
      return;
    }
    if (node.kind === 'solidPath') {
      if (node.solidPath) {
        callbacks.renderSolidPath(node.solidPath);
      }
      return;
    }
    if (node.kind === 'linearGradientPath') {
      if (node.linearGradientPath) {
        callbacks.renderLinearGradientPath(node.linearGradientPath);
      }
      return;
    }
    if (node.kind === 'radialGradientPath') {
      if (node.radialGradientPath) {
        callbacks.renderRadialGradientPath(node.radialGradientPath);
      }
      return;
    }
    if (node.kind === 'sweepGradientPath') {
      if (node.sweepGradientPath) {
        callbacks.renderSweepGradientPath(node.sweepGradientPath);
      }
      return;
    }
    if (node.kind === 'transform') {
      if (!node.transform) {
        return;
      }
      stack.add(nodeId);
      try {
        callbacks.withTransform(node.transform.transform, () => renderNode(node.transform!.childNodeId, stack));
      } finally {
        stack.delete(nodeId);
      }
      return;
    }
    if (node.kind === 'composite') {
      if (!node.composite || node.composite.mode !== 'sourceOver') {
        return;
      }
      stack.add(nodeId);
      try {
        callbacks.renderComposite(
          node.composite.mode,
          () => renderNode(node.composite!.backdropNodeId, stack),
          () => renderNode(node.composite!.sourceNodeId, stack),
        );
      } finally {
        stack.delete(nodeId);
      }
      return;
    }
    if (node.kind === 'clip') {
      if (!node.clip) {
        return;
      }
      stack.add(nodeId);
      try {
        callbacks.withClip(node.clip, () => renderNode(node.clip!.childNodeId, stack));
      } finally {
        stack.delete(nodeId);
      }
    }
  };
  renderNode(graph.rootNodeId, new Set());
}

export function resolvedColorUnitRgba(fill: LayerGlyphOutlineResolvedColor): [number, number, number, number] {
  const [r, g, b, a] = fill.rgba;
  return [
    clampColorUnit(r),
    clampColorUnit(g),
    clampColorUnit(b),
    clampColorUnit(a),
  ];
}

export function resolvedColorToCss(fill: LayerGlyphOutlineResolvedColor): string {
  const [r, g, b, a] = resolvedColorUnitRgba(fill);
  return `rgba(${unitToCssChannel(r)}, ${unitToCssChannel(g)}, ${unitToCssChannel(b)}, ${a})`;
}

function clampColorUnit(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function unitToCssChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value * 255)));
}
