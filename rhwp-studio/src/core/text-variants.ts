import type {
  LayerGlyphOutlineOp,
  LayerGlyphRunOp,
  LayerPaintOp,
  LayerPaintOpLike,
  LayerTextVariantMeta,
} from './types';
import { isKnownLayerPaintOp } from './types';

export type LayerTextVariantSelection = ReadonlyMap<string, string>;

export type LayerTextVariantBackendKind =
  | 'nativeSkia'
  | 'canvaskit'
  | 'canvas2d'
  | 'svg';

export type LayerTextVariantSelectedReason =
  | 'glyphRunStrictEligible'
  | 'glyphOutlineStrictProfile'
  | 'defaultTextRunFallback'
  | 'noSupportedVariant';

export type LayerTextVariantRejectReason =
  | 'fontDigestMismatch'
  | 'fontNotPortable'
  | 'externalFontNotVerified'
  | 'exactFaceUnavailable'
  | 'faceIndexUnsupported'
  | 'variationUnsupported'
  | 'glyphIdOutOfRange'
  | 'missingGlyph'
  | 'clusterMismatch'
  | 'incompleteVariantSet'
  | 'unsupportedPaintEffect'
  | 'unsupportedOutlinePayload'
  | 'unsupportedColorGlyph'
  | 'unsupportedBitmapGlyph'
  | 'unsupportedSvgGlyph'
  | 'positionAdjustedResidualTooLarge'
  | 'backendDoesNotSupportVariant'
  | 'variantUnsupported'
  | 'variantPartCountMismatch'
  | 'variantDuplicatePart'
  | 'variantPartsIncomplete'
  | 'defaultFallbackNotSelected'
  | 'glyphOutlineUnsupported'
  | (string & {});

export interface LayerTextVariantFontVerificationReport {
  faceKey?: string;
  blobKey?: string;
  portability?: string;
  expectedDigest?: string;
  blobResolved?: boolean;
  digestMatched?: boolean;
  exactFaceInstantiated?: boolean;
  faceIndexSupported?: boolean;
  variationSupported?: boolean;
  effectSupported?: boolean;
  replayEligible: boolean;
  reason?: LayerTextVariantRejectReason;
}

export interface LayerTextVariantOutlineEligibilityReport {
  strictVisualEligible: boolean;
  payloadSupported: boolean;
  paintStyleSupported: boolean;
  replayEligible: boolean;
  reason?: LayerTextVariantRejectReason;
}

export interface LayerTextVariantReplayStatus {
  replayable: boolean;
  reason?: LayerTextVariantRejectReason;
  details?: string;
  fontVerification?: LayerTextVariantFontVerificationReport;
  outlineEligibility?: LayerTextVariantOutlineEligibilityReport;
}

export interface LayerTextVariantPartReport {
  equivalenceGroup: string;
  variantId: string;
  variantKind: LayerTextVariantMeta['variantKind'];
  partIndex: number;
  partCount: number;
  replayable: boolean;
  reason?: LayerTextVariantRejectReason;
  details?: string;
  fontVerification?: LayerTextVariantFontVerificationReport;
  outlineEligibility?: LayerTextVariantOutlineEligibilityReport;
}

export interface LayerTextVariantRejectedReport {
  variantId: string;
  variantKind: LayerTextVariantMeta['variantKind'];
  reasons: LayerTextVariantRejectReason[];
  details?: string[];
}

export interface LayerTextVariantGroupReport {
  backend?: LayerTextVariantBackendKind;
  renderProfile?: string;
  equivalenceGroup: string;
  selectedVariantId: string;
  selectedVariantKind: LayerTextVariantMeta['variantKind'];
  selectedReason: LayerTextVariantSelectedReason;
  anchorOpId?: string;
  partsExpected: number;
  partsReplayed: number;
  rejectedVariants: LayerTextVariantRejectedReport[];
  parts: LayerTextVariantPartReport[];
  fontVerification?: LayerTextVariantFontVerificationReport;
  outlineEligibility?: LayerTextVariantOutlineEligibilityReport;
}

export interface LayerTextVariantSelectionResult {
  selected: Map<string, string>;
  reports: LayerTextVariantGroupReport[];
}

export interface LayerTextVariantSelectionContext {
  backend?: LayerTextVariantBackendKind;
  renderProfile?: string;
}

type VariantPartState = {
  order: number;
  variantKind: LayerTextVariantMeta['variantKind'];
  expectedPartCount: number;
  parts: Set<number>;
  supported: boolean;
  isDefaultFallback: boolean;
  reasons: Set<LayerTextVariantRejectReason>;
  details: Set<string>;
  anchorOpId?: string;
  fontVerification?: LayerTextVariantFontVerificationReport;
  outlineEligibility?: LayerTextVariantOutlineEligibilityReport;
};

export function layerTextVariantOpsForLeaf(
  rootOps: readonly LayerPaintOpLike[],
  variantOps: readonly LayerPaintOpLike[] | undefined,
): LayerPaintOp[] {
  const ops = rootOps.filter(isKnownLayerPaintOp);
  if (!variantOps?.length) {
    return ops;
  }

  const rootVariantKeys = new Set(
    ops
      .map((op) => variantPartKey(textVariantMetaForOp(op)))
      .filter((key): key is string => !!key),
  );
  const sidecarsByAnchor = new Map<string, LayerPaintOp[]>();
  for (const sidecar of variantOps) {
    if (!isKnownLayerPaintOp(sidecar)) {
      continue;
    }
    const anchorOpId = sidecarAnchorOpId(sidecar);
    if (!anchorOpId) {
      continue;
    }
    const sidecarKey = variantPartKey(textVariantMetaForOp(sidecar));
    if (sidecarKey && rootVariantKeys.has(sidecarKey)) {
      continue;
    }
    const anchored = sidecarsByAnchor.get(anchorOpId);
    if (anchored) {
      anchored.push(sidecar);
    } else {
      sidecarsByAnchor.set(anchorOpId, [sidecar]);
    }
  }

  if (!sidecarsByAnchor.size) {
    return ops;
  }

  const merged: LayerPaintOp[] = [];
  for (const op of ops) {
    merged.push(op);
    const opId = layerPaintOpId(op);
    const sidecars = opId ? sidecarsByAnchor.get(opId) : undefined;
    if (!sidecars?.length) {
      continue;
    }
    merged.push(...sidecars.sort(compareVariantPaintOrder));
  }
  return merged;
}

export function selectLayerTextVariantSetsWithReport(
  ops: readonly LayerPaintOp[],
  glyphRunReplayStatus: (op: LayerGlyphRunOp) => LayerTextVariantReplayStatus | boolean,
  glyphOutlineReplayStatus: (op: LayerGlyphOutlineOp) => LayerTextVariantReplayStatus | boolean = () => ({
    replayable: false,
    reason: 'glyphOutlineUnsupported',
  }),
  context: LayerTextVariantSelectionContext = {},
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
        reasons: new Set<LayerTextVariantRejectReason>(),
        details: new Set<string>(),
        anchorOpId: variant.anchorOpId,
      };
      order += 1;
      variants.set(variantId, state);
    }
    if (!state.anchorOpId && variant.anchorOpId) {
      state.anchorOpId = variant.anchorOpId;
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
      replayStatus = { replayable: true };
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
    if (replayStatus.details) {
      state.details.add(replayStatus.details);
    }
    if (replayStatus.fontVerification) {
      state.fontVerification = replayStatus.fontVerification;
    }
    if (replayStatus.outlineEligibility) {
      state.outlineEligibility = replayStatus.outlineEligibility;
    }
    partReports.push({
      equivalenceGroup: group,
      variantId,
      variantKind,
      partIndex,
      partCount,
      replayable: replayStatus.replayable,
      reason: replayStatus.reason,
      details: replayStatus.details,
      fontVerification: replayStatus.fontVerification,
      outlineEligibility: replayStatus.outlineEligibility,
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
    const selectedState = selectedVariantId ? variants.get(selectedVariantId) : undefined;
    const selectedKind = selectedState?.variantKind;
    const fallbackVariantId = defaultFallbacks.get(group) ?? 'textRun';
    const fallbackState = defaultFallbacks.has(group) ? variants.get(fallbackVariantId) : undefined;
    const reportedVariantId = selectedVariantId ?? fallbackVariantId;
    const reportedState = selectedState ?? fallbackState;
    const reportedKind = reportedState?.variantKind ?? 'textRun';
    const groupParts = partReports.filter((part) => part.equivalenceGroup === group);
    const selectedParts = groupParts.filter((part) => part.variantId === reportedVariantId);
    reports.push({
      backend: context.backend,
      renderProfile: context.renderProfile,
      equivalenceGroup: group,
      selectedVariantId: reportedVariantId,
      selectedVariantKind: reportedKind,
      selectedReason: selectedKind === 'glyphOutline' ? 'glyphOutlineStrictProfile'
        : selectedKind === 'glyphRun' ? 'glyphRunStrictEligible'
          : defaultFallbacks.has(group)
        ? 'defaultTextRunFallback'
        : 'noSupportedVariant',
      anchorOpId: reportedState?.anchorOpId,
      partsExpected: reportedState?.expectedPartCount ?? selectedParts.length,
      partsReplayed: selectedParts.filter((part) => part.replayable).length,
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
            details: variant.details.size ? [...variant.details] : undefined,
          };
        }),
      parts: groupParts,
      fontVerification: firstDefined(
        reportedState?.fontVerification,
        ...groupParts.map((part) => part.fontVerification),
      ),
      outlineEligibility: firstDefined(
        reportedState?.outlineEligibility,
        ...groupParts.map((part) => part.outlineEligibility),
      ),
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

function sidecarAnchorOpId(op: LayerPaintOp): string | undefined {
  if (op.type === 'glyphOutline') {
    return op.anchorOpId ?? op.variant.anchorOpId;
  }
  return textVariantMetaForOp(op)?.anchorOpId;
}

function layerPaintOpId(op: LayerPaintOp): string | undefined {
  const id = (op as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function variantPartKey(variant: LayerTextVariantMeta | undefined): string | undefined {
  if (!variant) {
    return undefined;
  }
  return [
    variant.equivalenceGroup,
    variant.variantId,
    variant.partIndex ?? 0,
  ].join('\u{1f}');
}

function compareVariantPaintOrder(a: LayerPaintOp, b: LayerPaintOp): number {
  const variantA = textVariantMetaForOp(a);
  const variantB = textVariantMetaForOp(b);
  return (variantA?.localPaintOrder ?? variantA?.partIndex ?? 0)
    - (variantB?.localPaintOrder ?? variantB?.partIndex ?? 0);
}

function partsComplete(variant: VariantPartState): boolean {
  return variant.parts.size === variant.expectedPartCount
    && Array.from({ length: variant.expectedPartCount }, (_, index) => index)
      .every((index) => variant.parts.has(index));
}

function firstDefined<T>(...values: (T | undefined)[]): T | undefined {
  return values.find((value) => value !== undefined);
}
