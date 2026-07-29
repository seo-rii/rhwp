import type { LayerPaintOp } from '@/core/types';

export type LayerReplayPlane = 'background' | 'behindText' | 'flow' | 'inFrontOfText';

export const LAYER_REPLAY_PLANES = [
  'background',
  'behindText',
  'flow',
  'inFrontOfText',
] as const satisfies readonly LayerReplayPlane[];

export type CanvasKitReplayPlane = LayerReplayPlane;
export const CANVASKIT_REPLAY_PLANES = LAYER_REPLAY_PLANES;

export function layerPaintOpReplayPlane(op: LayerPaintOp): LayerReplayPlane {
  if (op.type === 'pageBackground') {
    return 'background';
  }
  if (op.type === 'image') {
    if (op.wrap === 'behindText') {
      return 'behindText';
    }
    if (op.wrap === 'inFrontOfText') {
      return 'inFrontOfText';
    }
  }
  return 'flow';
}
