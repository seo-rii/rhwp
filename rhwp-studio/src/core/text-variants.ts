import type {
  LayerGlyphOutlineOp,
  LayerGlyphRunOp,
  LayerNode,
  LayerPaintOp,
  LayerPaintOpLike,
  LayerTextOp,
  LayerTextRunOp,
  LayerTextVariantMeta,
  LayerTextVariantPayload,
  PageLayerTree,
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

export type LayerTextV2ValidationIssueCode =
  | 'missingPaintOrderSlotId'
  | 'duplicatePaintOrderSlotId'
  | 'textOpHasNoVariants'
  | 'duplicateVariantId'
  | 'defaultVariantMissing'
  | 'fallbackRequiredTextRunMissing'
  | 'fallbackFreeFeatureMissing'
  | 'variantHasNoParts'
  | 'variantPartCountInvalid'
  | 'variantPartCountMismatch'
  | 'variantDuplicatePart'
  | 'variantPayloadKindMismatch'
  | 'crossScopeVariantUnsupported'
  | 'glyphOutlineStrokeFeatureMissing';

export interface LayerTextV2ValidationIssue {
  code: LayerTextV2ValidationIssueCode;
  message: string;
  opId?: string;
  paintOrderSlotId?: string;
  variantId?: string;
  partIndex?: number;
}

export interface LayerTextV2ValidationOptions {
  fallbackPolicy?: LayerTextOp['fallbackPolicy'];
  requirePaintOrderSlot?: boolean;
  allowCrossScopeVariants?: boolean;
  allowFallbackFree?: boolean;
  requiredFeatures?: readonly string[];
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
  const ops = rootOps
    .filter(isKnownLayerPaintOp)
    .flatMap(expandLayerTextOpVariants);
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

export function expandLayerTextOpVariants(op: LayerPaintOp): LayerPaintOp[] {
  if (op.type !== 'text') {
    return [op];
  }

  const paintSlotId = op.id ?? op.paintOrderSlotId;
  const equivalenceGroup = paintSlotId;
  const expanded: LayerPaintOp[] = [];
  for (const variantSet of op.variants) {
    const declaredPartCount = variantSet.parts.length;
    for (const [index, part] of variantSet.parts.entries()) {
      const payload = part.payload;
      if (!isTextVariantPayload(payload)) {
        continue;
      }
      const partIndex = part.partIndex ?? index;
      const partCount = part.partCount ?? declaredPartCount;
      const isDefaultFallback = op.fallbackPolicy !== 'none'
        && variantSet.variantId === op.defaultVariantId
        && variantSet.kind === 'textRun';
      const payloadId =
        layerPaintOpId(payload)
        ?? (isDefaultFallback ? paintSlotId : `${paintSlotId}:${variantSet.variantId}:${partIndex}`);
      expanded.push(withTextVariantMeta(payload, payloadId, {
        equivalenceGroup,
        variantId: variantSet.variantId,
        variantKind: variantSet.kind,
        partIndex,
        partCount,
        isDefaultFallback,
        requires: variantSet.requiredFeatures,
        quality: variantSet.quality,
        anchorOpId: paintSlotId,
        localPaintOrder: part.localPaintOrder ?? partIndex,
      }));
    }
  }
  return expanded;
}

export function validateLayerTextV2Tree(tree: PageLayerTree): LayerTextV2ValidationIssue[] {
  const issues: LayerTextV2ValidationIssue[] = [];
  const seenPaintSlots = new Map<string, string | undefined>();
  const requiredFeatures = new Set(tree.requiredFeatures ?? []);
  const allowCrossScopeVariants = requiredFeatures.has('text.crossScopeVariants');
  const allowFallbackFree = requiredFeatures.has('text.strictVisualFallbackFree')
    || tree.textV2?.strictVisualFallbackFree === true;
  const stack: LayerNode[] = [tree.root];

  while (stack.length) {
    const node = stack.pop();
    if (!node) {
      continue;
    }
    if (node.kind === 'group') {
      stack.push(...node.children);
      continue;
    }
    if (node.kind === 'clipRect') {
      stack.push(node.child);
      continue;
    }
    for (const op of node.ops) {
      if (!isKnownLayerPaintOp(op) || op.type !== 'text') {
        continue;
      }
      issues.push(...validateLayerTextV2Op(op, {
        fallbackPolicy: tree.textV2?.fallbackPolicy,
        requirePaintOrderSlot: tree.schemaVersion === 2 || tree.textV2?.paintOrderSlots === 'required',
        allowCrossScopeVariants,
        allowFallbackFree,
        requiredFeatures: tree.requiredFeatures,
      }));
      if (!op.paintOrderSlotId) {
        continue;
      }
      if (seenPaintSlots.has(op.paintOrderSlotId)) {
        issues.push({
          code: 'duplicatePaintOrderSlotId',
          message: `Duplicate schema v2 text paint-order slot '${op.paintOrderSlotId}'.`,
          opId: op.id,
          paintOrderSlotId: op.paintOrderSlotId,
        });
        continue;
      }
      seenPaintSlots.set(op.paintOrderSlotId, op.id);
    }
  }

  return issues;
}

export function validateLayerTextV2Op(
  op: LayerTextOp,
  options: LayerTextV2ValidationOptions = {},
): LayerTextV2ValidationIssue[] {
  const issues: LayerTextV2ValidationIssue[] = [];
  const fallbackPolicy = op.fallbackPolicy ?? options.fallbackPolicy ?? 'required';
  const requiredFeatures = new Set(options.requiredFeatures ?? []);

  if (options.requirePaintOrderSlot !== false && !op.paintOrderSlotId) {
    issues.push({
      code: 'missingPaintOrderSlotId',
      message: 'Schema v2 text op must have a paintOrderSlotId.',
      opId: op.id,
    });
  }
  if (!op.variants.length) {
    issues.push({
      code: 'textOpHasNoVariants',
      message: 'Schema v2 text op must contain at least one variant set.',
      opId: op.id,
      paintOrderSlotId: op.paintOrderSlotId,
    });
    return issues;
  }

  const variantsById = new Map<string, LayerTextOp['variants'][number]>();
  for (const variant of op.variants) {
    if (variantsById.has(variant.variantId)) {
      issues.push({
        code: 'duplicateVariantId',
        message: `Duplicate text variant id '${variant.variantId}'.`,
        opId: op.id,
        paintOrderSlotId: op.paintOrderSlotId,
        variantId: variant.variantId,
      });
    } else {
      variantsById.set(variant.variantId, variant);
    }
    if (!variant.parts.length) {
      issues.push({
        code: 'variantHasNoParts',
        message: `Text variant '${variant.variantId}' must contain at least one part.`,
        opId: op.id,
        paintOrderSlotId: op.paintOrderSlotId,
        variantId: variant.variantId,
      });
      continue;
    }
    const seenPartIndexes = new Set<number>();
    const declaredPartCount = variant.parts.length;
    for (const [index, part] of variant.parts.entries()) {
      const partIndex = part.partIndex ?? index;
      const partCount = part.partCount ?? declaredPartCount;
      if (partCount <= 0 || partIndex < 0 || partIndex >= partCount) {
        issues.push({
          code: 'variantPartCountInvalid',
          message: `Text variant '${variant.variantId}' has invalid part index/count.`,
          opId: op.id,
          paintOrderSlotId: op.paintOrderSlotId,
          variantId: variant.variantId,
          partIndex,
        });
      }
      if (partCount !== declaredPartCount) {
        issues.push({
          code: 'variantPartCountMismatch',
          message: `Text variant '${variant.variantId}' declares partCount ${partCount}, but has ${declaredPartCount} parts.`,
          opId: op.id,
          paintOrderSlotId: op.paintOrderSlotId,
          variantId: variant.variantId,
          partIndex,
        });
      }
      if (seenPartIndexes.has(partIndex)) {
        issues.push({
          code: 'variantDuplicatePart',
          message: `Text variant '${variant.variantId}' has duplicate partIndex ${partIndex}.`,
          opId: op.id,
          paintOrderSlotId: op.paintOrderSlotId,
          variantId: variant.variantId,
          partIndex,
        });
      }
      seenPartIndexes.add(partIndex);
      if (part.payload.type !== variant.kind) {
        issues.push({
          code: 'variantPayloadKindMismatch',
          message: `Text variant '${variant.variantId}' has payload kind '${part.payload.type}' but declares '${variant.kind}'.`,
          opId: op.id,
          paintOrderSlotId: op.paintOrderSlotId,
          variantId: variant.variantId,
          partIndex,
        });
      }
      if (part.scopeRef && options.allowCrossScopeVariants !== true) {
        issues.push({
          code: 'crossScopeVariantUnsupported',
          message: `Text variant '${variant.variantId}' uses scopeRef without text.crossScopeVariants.`,
          opId: op.id,
          paintOrderSlotId: op.paintOrderSlotId,
          variantId: variant.variantId,
          partIndex,
        });
      }
      if (
        part.payload.type === 'glyphOutline'
        && part.payload.payloadKind === 'monochromeFillStroke'
        && !requiredFeatures.has('text.glyphOutline.monochromeFillStroke')
        && !variant.requiredFeatures?.includes('text.glyphOutline.monochromeFillStroke')
      ) {
        issues.push({
          code: 'glyphOutlineStrokeFeatureMissing',
          message: `Text variant '${variant.variantId}' uses monochromeFillStroke without the matching required feature.`,
          opId: op.id,
          paintOrderSlotId: op.paintOrderSlotId,
          variantId: variant.variantId,
          partIndex,
        });
      }
    }
  }

  if (!variantsById.has(op.defaultVariantId)) {
    issues.push({
      code: 'defaultVariantMissing',
      message: `Default text variant '${op.defaultVariantId}' is not present.`,
      opId: op.id,
      paintOrderSlotId: op.paintOrderSlotId,
      variantId: op.defaultVariantId,
    });
  }
  if (fallbackPolicy === 'required' && !op.variants.some((variant) => variant.kind === 'textRun')) {
    issues.push({
      code: 'fallbackRequiredTextRunMissing',
      message: 'Schema v2 compatibility text op requires a TextRun fallback variant.',
      opId: op.id,
      paintOrderSlotId: op.paintOrderSlotId,
    });
  }
  if (fallbackPolicy === 'none' && options.allowFallbackFree !== true) {
    issues.push({
      code: 'fallbackFreeFeatureMissing',
      message: 'fallbackPolicy=none requires text.strictVisualFallbackFree.',
      opId: op.id,
      paintOrderSlotId: op.paintOrderSlotId,
    });
  }

  return issues;
}

function isTextVariantPayload(payload: LayerTextVariantPayload): payload is LayerTextRunOp | LayerGlyphRunOp | LayerGlyphOutlineOp {
  return payload.type === 'textRun'
    || payload.type === 'glyphRun'
    || payload.type === 'glyphOutline';
}

function withTextVariantMeta(
  payload: LayerTextRunOp | LayerGlyphRunOp | LayerGlyphOutlineOp,
  id: string,
  variant: LayerTextVariantMeta,
): LayerPaintOp {
  if (payload.type === 'textRun') {
    return { ...payload, id, variant };
  }
  if (payload.type === 'glyphRun') {
    return { ...payload, id, variant };
  }
  return {
    ...payload,
    id,
    anchorOpId: payload.anchorOpId ?? variant.anchorOpId,
    variant,
  };
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
