import type { CanvasKitRenderMode } from '@/view/render-backend';
import type {
  LayerCacheHint,
  LayerClipNode,
  LayerRectangleOp,
  LayerRenderProfile,
  LayerTextRunOp,
} from '@/core/types';

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
  _op: LayerTextRunOp,
  context: CanvasKitOverlayPolicyContext,
): boolean {
  if (context.renderMode !== 'compat') {
    return false;
  }
  return false;
}

export function shouldOverlayRectangle(
  _op: LayerRectangleOp,
  _context: CanvasKitOverlayPolicyContext,
): boolean {
  return false;
}

export function shouldOverlayRasterImage(_context: CanvasKitOverlayPolicyContext): boolean {
  return false;
}

export function shouldOverlayVectorEquation(_context: CanvasKitOverlayPolicyContext): boolean {
  return false;
}
