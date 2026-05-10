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
  const glyphVariants = new Map<
    string,
    Map<
      string,
      {
        order: number;
        expectedPartCount: number;
        parts: Set<number>;
        supported: boolean;
      }
    >
  >();

  let order = 0;
  for (const op of ops) {
    if (op.type !== 'glyphRun') {
      continue;
    }
    const group = op.variant.equivalenceGroup;
    const variantId = op.variant.variantId;
    const partIndex = op.variant.partIndex ?? 0;
    const partCount = op.variant.partCount ?? 1;
    let groupVariants = glyphVariants.get(group);
    if (!groupVariants) {
      groupVariants = new Map();
      glyphVariants.set(group, groupVariants);
    }
    let variant = groupVariants.get(variantId);
    if (!variant) {
      variant = {
        order,
        expectedPartCount: Math.max(partCount, 0),
        parts: new Set<number>(),
        supported: true,
      };
      order += 1;
      groupVariants.set(variantId, variant);
    }
    if (variant.expectedPartCount !== partCount || partCount <= 0) {
      variant.supported = false;
    }
    variant.parts.add(partIndex);
    variant.supported &&= canReplayGlyphRun(op);
  }

  for (const [group, groupVariants] of glyphVariants.entries()) {
    const candidates = [...groupVariants.entries()]
      .sort(([, a], [, b]) => a.order - b.order);
    for (const [variantId, variant] of candidates) {
      const partsComplete = variant.parts.size === variant.expectedPartCount
        && Array.from({ length: variant.expectedPartCount }, (_, index) => index)
          .every((index) => variant.parts.has(index));
      if (variant.supported && partsComplete) {
        selected.set(group, variantId);
        break;
      }
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
