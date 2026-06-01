import type { LayerFormObjectOp } from '@/core/types';

export type LayerFormObjectPalette = {
  backColor: string;
  foreColor: string;
  borderColor: string;
  buttonBackColor: string;
  buttonFaceColor: string;
};

export function formObjectPalette(op: LayerFormObjectOp): LayerFormObjectPalette {
  return {
    backColor: op.backColor || '#ffffff',
    foreColor: op.enabled ? op.foreColor : '#808080',
    borderColor: op.enabled ? '#808080' : '#bebebe',
    buttonBackColor: op.backColor || (op.enabled ? '#d0d0d0' : '#e0e0e0'),
    buttonFaceColor: op.enabled ? '#c0c0c0' : '#e0e0e0',
  };
}
