import type {
  LayerGlyphOutlineOp,
  LayerGlyphRunOp,
  LayerPaintOp,
  LayerTextVariantMeta,
} from './types';

export type LayerTextVariantSelection = ReadonlyMap<string, string>;

export interface LayerTextVariantReplayStatus {
  replayable: boolean;
  reason?: string;
}

export interface LayerTextVariantPartReport {
  equivalenceGroup: string;
  variantId: string;
  variantKind: LayerTextVariantMeta['variantKind'];
  partIndex: number;
  partCount: number;
  replayable: boolean;
  reason?: string;
}

export interface LayerTextVariantRejectedReport {
  variantId: string;
  variantKind: LayerTextVariantMeta['variantKind'];
  reasons: string[];
}

export interface LayerTextVariantGroupReport {
  equivalenceGroup: string;
  selectedVariantId: string;
  selectedReason: 'glyphRunEligible' | 'glyphOutlineEligible' | 'defaultFallback' | 'noSupportedVariant';
  rejectedVariants: LayerTextVariantRejectedReport[];
  parts: LayerTextVariantPartReport[];
}

export interface LayerTextVariantSelectionResult {
  selected: Map<string, string>;
  reports: LayerTextVariantGroupReport[];
}

type VariantPartState = {
  order: number;
  variantKind: LayerTextVariantMeta['variantKind'];
  expectedPartCount: number;
  parts: Set<number>;
  supported: boolean;
  isDefaultFallback: boolean;
  reasons: Set<string>;
};

export function selectLayerTextVariantSetsWithReport(
  ops: readonly LayerPaintOp[],
  glyphRunReplayStatus: (op: LayerGlyphRunOp) => LayerTextVariantReplayStatus | boolean,
  glyphOutlineReplayStatus: (op: LayerGlyphOutlineOp) => LayerTextVariantReplayStatus | boolean = () => ({
    replayable: false,
    reason: 'glyphOutlineUnsupported',
  }),
): LayerTextVariantSelectionResult {
  const selected = new Map<string, string>();
  const groupVariants = new Map<string, Map<string, VariantPartState>>();
  const defaultFallbacks = new Map<string, string>();
  const partReports: LayerTextVariantPartReport[] = [];

  let order = 0;
  for (const op of ops) {
    const variant = textVariantMetaForOp(op);
    if (!variant) {
      continue;
    }
    const group = variant.equivalenceGroup;
    const variantId = variant.variantId;
    const variantKind = variant.variantKind;
    const partIndex = variant.partIndex ?? 0;
    const partCount = variant.partCount ?? 1;
    if (variant.isDefaultFallback) {
      defaultFallbacks.set(group, variantId);
    }
    let variants = groupVariants.get(group);
    if (!variants) {
      variants = new Map();
      groupVariants.set(group, variants);
    }
    let state = variants.get(variantId);
    if (!state) {
      state = {
        order,
        variantKind,
        expectedPartCount: Math.max(partCount, 0),
        parts: new Set<number>(),
        supported: true,
        isDefaultFallback: !!variant.isDefaultFallback,
        reasons: new Set<string>(),
      };
      order += 1;
      variants.set(variantId, state);
    }
    if (state.expectedPartCount !== partCount || partCount <= 0) {
      state.supported = false;
      state.reasons.add('variantPartCountMismatch');
    }
    if (state.parts.has(partIndex)) {
      state.supported = false;
      state.reasons.add('variantDuplicatePart');
    }
    state.parts.add(partIndex);

    let replayStatus: LayerTextVariantReplayStatus;
    if (op.type === 'textRun') {
      replayStatus = { replayable: true, reason: 'defaultFallback' };
    } else if (op.type === 'glyphRun') {
      const status = glyphRunReplayStatus(op);
      replayStatus = typeof status === 'boolean' ? { replayable: status } : status;
    } else if (op.type === 'glyphOutline') {
      const status = glyphOutlineReplayStatus(op);
      replayStatus = typeof status === 'boolean' ? { replayable: status } : status;
    } else {
      replayStatus = { replayable: true };
    }
    if (!replayStatus.replayable) {
      state.supported = false;
      state.reasons.add(replayStatus.reason ?? 'variantUnsupported');
    }
    partReports.push({
      equivalenceGroup: group,
      variantId,
      variantKind,
      partIndex,
      partCount,
      replayable: replayStatus.replayable,
      reason: replayStatus.reason,
    });
  }

  const reports: LayerTextVariantGroupReport[] = [];
  for (const [group, variants] of groupVariants.entries()) {
    const candidates = [...variants.entries()]
      .sort(([, a], [, b]) => a.order - b.order);
    for (const [variantId, variant] of candidates) {
      if (variant.isDefaultFallback) {
        continue;
      }
      if (variant.supported && partsComplete(variant)) {
        selected.set(group, variantId);
        break;
      }
    }
    const selectedVariantId = selected.get(group);
    const selectedKind = selectedVariantId ? variants.get(selectedVariantId)?.variantKind : undefined;
    const fallbackVariantId = defaultFallbacks.get(group) ?? 'textRun';
    const groupParts = partReports.filter((part) => part.equivalenceGroup === group);
    reports.push({
      equivalenceGroup: group,
      selectedVariantId: selectedVariantId ?? fallbackVariantId,
      selectedReason: selectedKind === 'glyphOutline' ? 'glyphOutlineEligible'
        : selectedKind === 'glyphRun' ? 'glyphRunEligible'
          : defaultFallbacks.has(group)
        ? 'defaultFallback'
        : 'noSupportedVariant',
      rejectedVariants: candidates
        .filter(([variantId, variant]) => variantId !== selectedVariantId && !variant.isDefaultFallback)
        .map(([variantId, variant]) => {
          const reasons = new Set(variant.reasons);
          if (!partsComplete(variant)) {
            reasons.add('variantPartsIncomplete');
          }
          if (variant.variantKind === 'textRun') {
            reasons.add('defaultFallbackNotSelected');
          }
          return {
            variantId,
            variantKind: variant.variantKind,
            reasons: [...reasons],
          };
        }),
      parts: groupParts,
    });
  }
  return { selected, reports };
}

export function selectLayerTextVariantSets(
  ops: readonly LayerPaintOp[],
  canReplayGlyphRun: (op: LayerGlyphRunOp) => boolean,
  canReplayGlyphOutline?: (op: LayerGlyphOutlineOp) => boolean,
): Map<string, string> {
  return selectLayerTextVariantSetsWithReport(
    ops,
    (op) => ({ replayable: canReplayGlyphRun(op) }),
    canReplayGlyphOutline
      ? (op) => ({ replayable: canReplayGlyphOutline(op) })
      : undefined,
  ).selected;
}

export function shouldRenderLayerTextVariant(
  op: LayerPaintOp,
  selected: LayerTextVariantSelection,
): boolean {
  const variant = textVariantMetaForOp(op);
  if (!variant) {
    return true;
  }
  const selectedVariant = selected.get(variant.equivalenceGroup);
  if (!selectedVariant) {
    return op.type !== 'glyphRun' && op.type !== 'glyphOutline';
  }
  return selectedVariant === variant.variantId;
}

function textVariantMetaForOp(op: LayerPaintOp): LayerTextVariantMeta | undefined {
  if (op.type === 'textRun' || op.type === 'glyphRun' || op.type === 'glyphOutline') {
    return op.variant;
  }
  return undefined;
}

function partsComplete(variant: VariantPartState): boolean {
  return variant.parts.size === variant.expectedPartCount
    && Array.from({ length: variant.expectedPartCount }, (_, index) => index)
      .every((index) => variant.parts.has(index));
}
