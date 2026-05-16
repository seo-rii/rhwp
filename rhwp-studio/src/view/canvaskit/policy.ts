import type { CanvasKitRenderMode } from '@/view/render-backend';
import type {
  LayerClipNode,
  LayerRenderProfile,
} from '@/core/types';

const CLIP_RASTER_EDGE_PAD_PX = 4;

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
