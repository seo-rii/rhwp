import type {
  LayerGlyphRunOp,
  LayerPaintOp,
} from './types';

export type LayerTextVariantSelection = ReadonlyMap<string, string>;

export function selectLayerTextVariantSets(
  ops: readonly LayerPaintOp[],
  canReplayGlyphRun: (op: LayerGlyphRunOp) => boolean,
): Map<string, string> {
  const selected = new Map<string, string>();
  for (const op of ops) {
    if (op.type !== 'glyphRun' || !canReplayGlyphRun(op)) {
      continue;
    }
    if (!selected.has(op.variant.equivalenceGroup)) {
      selected.set(op.variant.equivalenceGroup, op.variant.variantId);
    }
  }
  return selected;
}

export function shouldRenderLayerTextVariant(
  op: LayerPaintOp,
  selected: LayerTextVariantSelection,
): boolean {
  const variant = op.type === 'textRun' || op.type === 'glyphRun'
    ? op.variant
    : undefined;
  if (!variant) {
    return true;
  }
  const selectedVariant = selected.get(variant.equivalenceGroup);
  if (!selectedVariant) {
    return op.type !== 'glyphRun';
  }
  return selectedVariant === variant.variantId;
}
