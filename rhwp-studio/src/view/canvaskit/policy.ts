import type { CanvasKitRenderMode } from '@/view/render-backend';
import type {
  LayerCacheHint,
  LayerClipNode,
  LayerRectangleOp,
  LayerRenderProfile,
  LayerTextRunOp,
} from '@/core/types';
import {
  isHalfwidthScaledCluster,
  splitIntoClusters,
  startsWithInvalidControl,
} from '../layer-canvas-utils';

const CLIP_RASTER_EDGE_PAD_PX = 4;

export type CanvasKitOverlayPolicyContext = {
  renderMode: CanvasKitRenderMode;
  profile: LayerRenderProfile;
  insideTableCell: boolean;
  hasCacheHint: (cacheHint: LayerCacheHint) => boolean;
};

export function canvaskitClipRightPad(
  renderMode: CanvasKitRenderMode,
  profile: LayerRenderProfile,
  clipKind: LayerClipNode['clipKind'],
  rightOverflowSlop?: number,
): number {
  if (typeof rightOverflowSlop === 'number') {
    return Math.max(0, rightOverflowSlop);
  }
  return renderMode === 'compat'
    && profile === 'fast-preview'
    && (clipKind === 'body' || clipKind === 'tableCell')
    ? CLIP_RASTER_EDGE_PAD_PX
    : 0;
}

export function shouldOverlayTextRun(
  op: LayerTextRunOp,
  context: CanvasKitOverlayPolicyContext,
): boolean {
  if (context.renderMode === 'compat') {
    const ratio = typeof op.style.ratio === 'number' && op.style.ratio > 0 ? op.style.ratio : 1;
    const clusters = splitIntoClusters(op.text);
    const decorationsAreMirrors = op.legacyVisuals?.decorations === 'mirror';
    if (
      op.isVertical
      || op.rotation !== 0
      || !op.text.trim()
      || op.style.bold
      || op.style.italic
      || Math.abs(ratio - 1) > 0.01
      || (!decorationsAreMirrors && op.style.underline !== 'none')
      || (!decorationsAreMirrors && op.style.strikethrough)
      || (op.style.outlineType ?? 0) > 0
      || (op.style.shadowType ?? 0) > 0
      || op.style.emboss
      || op.style.engrave
      || (!decorationsAreMirrors && (op.style.emphasisDot ?? 0) > 0)
      || ((typeof op.style.shadeColor === 'string' ? op.style.shadeColor : '#ffffff').toLowerCase() !== '#ffffff')
      || (op.tabLeaders?.length ?? 0) > 0
      || (
        clusters.length > 8
        && clusters.some((cluster) => cluster.text === ' ')
      )
    ) {
      return true;
    }
    return clusters.some((cluster) =>
      cluster.text === '\t'
      || cluster.text === '\u2007'
      || startsWithInvalidControl(cluster.text)
      || isHalfwidthScaledCluster(cluster.text),
    );
  }

  return false;
}

export function shouldOverlayRectangle(
  op: LayerRectangleOp,
  context: CanvasKitOverlayPolicyContext,
): boolean {
  if (context.hasCacheHint('preferVectorRecording')) {
    return false;
  }
  if (context.renderMode === 'default') {
    return false;
  }

  const isSimpleTableCellFill =
    context.insideTableCell
    && !!op.style.fillColor
    && !op.style.strokeColor;

  return op.cornerRadius === 0
    && !op.gradient
    && !op.style.pattern
    && !op.style.shadow
    && !op.transform.rotation
    && !op.transform.horzFlip
    && !op.transform.vertFlip
    && op.style.opacity === 1
    && (
      isSimpleTableCellFill
      || (
        !op.style.fillColor
        && !!op.style.strokeColor
        && op.style.strokeDash === 'solid'
        && op.style.strokeWidth <= 1
      )
    );
}

export function shouldOverlayRasterImage(_context: CanvasKitOverlayPolicyContext): boolean {
  return false;
}

export function shouldOverlayVectorEquation(_context: CanvasKitOverlayPolicyContext): boolean {
  return false;
}
