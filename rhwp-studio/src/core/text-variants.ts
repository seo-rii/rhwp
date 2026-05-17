import type {
  LayerAffineTransform,
  LayerGlyphOutlineOp,
  LayerGlyphRunOp,
  LayerNode,
  LayerPathCommand,
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
  | 'glyphOutlineStrokeStyleUnsupported'
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
  | 'crossScopeVariantFeatureMissing'
  | 'missingSidecarAnchorOpId'
  | 'missingSidecarAnchor'
  | 'invalidSidecarAnchor'
  | 'strictVisualVariantMissing'
  | 'glyphOutlinePayloadKindFeatureMissing'
  | 'glyphOutlinePayloadContractInvalid'
  | 'glyphOutlineStrokeStyleUnsupported'
  | 'mixedPerGlyphFeatureMissing';

export interface LayerTextV2ValidationIssue {
  code: LayerTextV2ValidationIssueCode;
  message: string;
  opId?: string;
  paintOrderSlotId?: string;
  anchorOpId?: string;
  variantId?: string;
  partIndex?: number;
}

export interface LayerTextV2ValidationOptions {
  fallbackPolicy?: LayerTextOp['fallbackPolicy'];
  requirePaintOrderSlot?: boolean;
  allowCrossScopeVariants?: boolean;
  allowFallbackFree?: boolean;
  allowRicherGlyphOutlinePayloads?: boolean;
  allowColrv0ColorLayersPayloads?: boolean;
  allowColrv1Stage1ColorGraphPayloads?: boolean;
  allowBitmapGlyphPayloads?: boolean;
  allowSvgGlyphPayloads?: boolean;
  allowMixedPerGlyphOrientation?: boolean;
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
  const rootAnchors = new Map<string, LayerTextVariantMeta>();
  const rootVariantParts = new Set<string>();
  const requiredFeatures = new Set(tree.requiredFeatures ?? []);
  const allowCrossScopeVariants = requiredFeatures.has('text.crossScopeVariants');
  const allowFallbackFree =
    tree.textV2?.profile === 'strictVisual'
    && tree.textV2?.strictVisualFallbackFree === true
    && requiredFeatures.has('text.strictVisualFallbackFree');
  const allowRicherGlyphOutlinePayloads =
    requiredFeatures.has('text.glyphOutline.monochromeFillStroke');
  const allowColrv0ColorLayersPayloads =
    requiredFeatures.has('text.glyphOutline.colorLayers')
    && requiredFeatures.has('text.glyphOutline.colorLayers.colrV0');
  const allowColrv1Stage1ColorGraphPayloads =
    requiredFeatures.has('text.glyphOutline.colorLayers')
    && requiredFeatures.has('text.glyphOutline.colorLayers.colrV1');
  const allowBitmapGlyphPayloads = requiredFeatures.has('text.glyphOutline.bitmapGlyph');
  const allowSvgGlyphPayloads = requiredFeatures.has('text.glyphOutline.svgGlyph');
  const allowMixedPerGlyphOrientation = requiredFeatures.has('text.vertical.mixedPerGlyph');
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
    const expandedRootOps = node.ops
      .filter(isKnownLayerPaintOp)
      .flatMap(expandLayerTextOpVariants);
    for (const expandedOp of expandedRootOps) {
      const variant = textVariantMetaForOp(expandedOp);
      if (!variant) {
        continue;
      }
      const partKey = variantPartKey(variant);
      if (partKey) {
        rootVariantParts.add(partKey);
      }
      const opId = layerPaintOpId(expandedOp);
      if (opId) {
        rootAnchors.set(opId, variant);
      }
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
        allowRicherGlyphOutlinePayloads,
        allowColrv0ColorLayersPayloads,
        allowColrv1Stage1ColorGraphPayloads,
        allowBitmapGlyphPayloads,
        allowSvgGlyphPayloads,
        allowMixedPerGlyphOrientation,
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

  const sidecarVariantParts = new Set<string>();
  for (const sidecar of tree.variantOps ?? []) {
    if (!isKnownLayerPaintOp(sidecar)) {
      continue;
    }
    const variant = textVariantMetaForOp(sidecar);
    if (!variant) {
      continue;
    }
    const anchorOpId = sidecarAnchorOpId(sidecar);
    if (!anchorOpId) {
      issues.push({
        code: 'missingSidecarAnchorOpId',
        message: `Sidecar text variant '${variant.variantId}' must reference an anchorOpId.`,
        opId: layerPaintOpId(sidecar),
        variantId: variant.variantId,
        partIndex: variant.partIndex,
      });
      continue;
    }
    const anchorVariant = rootAnchors.get(anchorOpId);
    if (!anchorVariant) {
      issues.push({
        code: 'missingSidecarAnchor',
        message: `Sidecar text variant '${variant.variantId}' references missing anchor '${anchorOpId}'.`,
        opId: layerPaintOpId(sidecar),
        anchorOpId,
        variantId: variant.variantId,
        partIndex: variant.partIndex,
      });
    } else if (
      anchorVariant.variantKind !== 'textRun'
      || !anchorVariant.isDefaultFallback
      || anchorVariant.equivalenceGroup !== variant.equivalenceGroup
    ) {
      issues.push({
        code: 'invalidSidecarAnchor',
        message: `Sidecar text variant '${variant.variantId}' must anchor to a root TextRun fallback in the same equivalence group.`,
        opId: layerPaintOpId(sidecar),
        anchorOpId,
        variantId: variant.variantId,
        partIndex: variant.partIndex,
      });
    }
    const sidecarPartKey = variantPartKey(variant);
    if (!sidecarPartKey) {
      continue;
    }
    if (rootVariantParts.has(sidecarPartKey) || sidecarVariantParts.has(sidecarPartKey)) {
      issues.push({
        code: 'variantDuplicatePart',
        message: `Sidecar text variant '${variant.variantId}' duplicates an already emitted variant part.`,
        opId: layerPaintOpId(sidecar),
        anchorOpId,
        variantId: variant.variantId,
        partIndex: variant.partIndex,
      });
    }
    sidecarVariantParts.add(sidecarPartKey);
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
          code: 'crossScopeVariantFeatureMissing',
          message: `Text variant '${variant.variantId}' uses scopeRef without text.crossScopeVariants.`,
          opId: op.id,
          paintOrderSlotId: op.paintOrderSlotId,
          variantId: variant.variantId,
          partIndex,
        });
      }
      if (part.payload.type === 'glyphOutline') {
        const payloadKind = part.payload.payloadKind ?? 'monochromeFill';
        switch (payloadKind) {
          case 'monochromeFill':
            if (!hasGlyphOutlinePathsContract(part.payload)) {
              issues.push({
                code: 'glyphOutlinePayloadContractInvalid',
                message: `Text variant '${variant.variantId}' carries a monochromeFill payload without strict glyph path metadata.`,
                opId: op.id,
                paintOrderSlotId: op.paintOrderSlotId,
                variantId: variant.variantId,
                partIndex,
              });
            }
            if (part.payload.stroke) {
              issues.push({
                code: 'glyphOutlineStrokeStyleUnsupported',
                message: `Text variant '${variant.variantId}' carries a stroke style outside monochromeFillStroke.`,
                opId: op.id,
                paintOrderSlotId: op.paintOrderSlotId,
                variantId: variant.variantId,
                partIndex,
              });
            }
            break;
          case 'monochromeFillStroke': {
            const richerPayloadFeature =
              requiredFeatures.has('text.glyphOutline.monochromeFillStroke')
              || variant.requiredFeatures?.includes('text.glyphOutline.monochromeFillStroke')
              || options.allowRicherGlyphOutlinePayloads === true;
            if (!richerPayloadFeature) {
              issues.push({
                code: 'glyphOutlinePayloadKindFeatureMissing',
                message: `Text variant '${variant.variantId}' uses ${payloadKind} without the matching required feature.`,
                opId: op.id,
                paintOrderSlotId: op.paintOrderSlotId,
                variantId: variant.variantId,
                partIndex,
              });
            }
            if (!hasGlyphOutlinePathsContract(part.payload)) {
              issues.push({
                code: 'glyphOutlinePayloadContractInvalid',
                message: `Text variant '${variant.variantId}' carries a monochromeFillStroke payload without strict glyph path metadata.`,
                opId: op.id,
                paintOrderSlotId: op.paintOrderSlotId,
                variantId: variant.variantId,
                partIndex,
              });
            }
            if (!isSupportedGlyphOutlineStrokeStyle(part.payload.stroke)) {
              issues.push({
                code: 'glyphOutlineStrokeStyleUnsupported',
                message: `Text variant '${variant.variantId}' uses an unsupported monochromeFillStroke style.`,
                opId: op.id,
                paintOrderSlotId: op.paintOrderSlotId,
                variantId: variant.variantId,
                partIndex,
              });
            }
            break;
          }
          case 'colorLayers': {
            const colrv0Feature =
              requiredFeatures.has('text.glyphOutline.colorLayers')
              && requiredFeatures.has('text.glyphOutline.colorLayers.colrV0')
              && variant.requiredFeatures?.includes('text.glyphOutline.colorLayers')
              && variant.requiredFeatures?.includes('text.glyphOutline.colorLayers.colrV0');
            const colrv1Feature =
              requiredFeatures.has('text.glyphOutline.colorLayers')
              && requiredFeatures.has('text.glyphOutline.colorLayers.colrV1')
              && variant.requiredFeatures?.includes('text.glyphOutline.colorLayers')
              && variant.requiredFeatures?.includes('text.glyphOutline.colorLayers.colrV1');
            if (colrv1Feature) {
              if (!hasColrv1Stage1ColorGraphContract(part.payload)) {
                issues.push({
                  code: 'glyphOutlinePayloadContractInvalid',
                  message: `Text variant '${variant.variantId}' carries a COLRv1 colorLayers payload without the stage-1 normalized graph contract.`,
                  opId: op.id,
                  paintOrderSlotId: op.paintOrderSlotId,
                  variantId: variant.variantId,
                  partIndex,
                });
              }
              if (options.allowColrv1Stage1ColorGraphPayloads !== true) {
                issues.push({
                  code: 'glyphOutlinePayloadKindFeatureMissing',
                  message: `Text variant '${variant.variantId}' uses colorLayers without the COLRv1 normalized graph writer gate.`,
                  opId: op.id,
                  paintOrderSlotId: op.paintOrderSlotId,
                  variantId: variant.variantId,
                  partIndex,
                });
              }
            } else {
              if (options.allowColrv0ColorLayersPayloads !== true || !colrv0Feature) {
                issues.push({
                  code: 'glyphOutlinePayloadKindFeatureMissing',
                  message: `Text variant '${variant.variantId}' uses colorLayers without the COLRv0 resolved-layer writer gate.`,
                  opId: op.id,
                  paintOrderSlotId: op.paintOrderSlotId,
                  variantId: variant.variantId,
                  partIndex,
                });
              } else if (!hasColrv0ColorLayersContract(part.payload)) {
                issues.push({
                  code: 'glyphOutlinePayloadContractInvalid',
                  message: `Text variant '${variant.variantId}' carries a COLRv0 colorLayers payload without the resolved-layer contract.`,
                  opId: op.id,
                  paintOrderSlotId: op.paintOrderSlotId,
                  variantId: variant.variantId,
                  partIndex,
                });
              }
            }
            if (part.payload.stroke) {
              issues.push({
                code: 'glyphOutlineStrokeStyleUnsupported',
                message: `Text variant '${variant.variantId}' carries a stroke style outside monochromeFillStroke.`,
                opId: op.id,
                paintOrderSlotId: op.paintOrderSlotId,
                variantId: variant.variantId,
                partIndex,
              });
            }
            break;
          }
          case 'bitmapGlyph':
            if (!hasStrictBitmapGlyphContract(part.payload)) {
              issues.push({
                code: 'glyphOutlinePayloadContractInvalid',
                message: `Text variant '${variant.variantId}' carries a bitmapGlyph payload without the strict deterministic image-strike contract.`,
                opId: op.id,
                paintOrderSlotId: op.paintOrderSlotId,
                variantId: variant.variantId,
                partIndex,
              });
            }
            if (
              options.allowBitmapGlyphPayloads !== true
              || variant.requiredFeatures?.includes('text.glyphOutline.bitmapGlyph') !== true
            ) {
              issues.push({
                code: 'glyphOutlinePayloadKindFeatureMissing',
                message: `Text variant '${variant.variantId}' uses bitmapGlyph without the deterministic image-strike writer gate.`,
                opId: op.id,
                paintOrderSlotId: op.paintOrderSlotId,
                variantId: variant.variantId,
                partIndex,
              });
            }
            if (part.payload.stroke) {
              issues.push({
                code: 'glyphOutlineStrokeStyleUnsupported',
                message: `Text variant '${variant.variantId}' carries a stroke style outside monochromeFillStroke.`,
                opId: op.id,
                paintOrderSlotId: op.paintOrderSlotId,
                variantId: variant.variantId,
                partIndex,
              });
            }
            break;
          case 'svgGlyph':
            if (!hasStaticSanitizedSvgGlyphContract(part.payload)) {
              issues.push({
                code: 'glyphOutlinePayloadContractInvalid',
                message: `Text variant '${variant.variantId}' carries an svgGlyph payload without the static sanitized vector contract.`,
                opId: op.id,
                paintOrderSlotId: op.paintOrderSlotId,
                variantId: variant.variantId,
                partIndex,
              });
            }
            if (
              options.allowSvgGlyphPayloads !== true
              || variant.requiredFeatures?.includes('text.glyphOutline.svgGlyph') !== true
            ) {
              issues.push({
                code: 'glyphOutlinePayloadKindFeatureMissing',
                message: `Text variant '${variant.variantId}' uses svgGlyph without the static sanitized vector writer gate.`,
                opId: op.id,
                paintOrderSlotId: op.paintOrderSlotId,
                variantId: variant.variantId,
                partIndex,
              });
            }
            if (part.payload.stroke) {
              issues.push({
                code: 'glyphOutlineStrokeStyleUnsupported',
                message: `Text variant '${variant.variantId}' carries a stroke style outside monochromeFillStroke.`,
                opId: op.id,
                paintOrderSlotId: op.paintOrderSlotId,
                variantId: variant.variantId,
                partIndex,
              });
            }
            break;
        }
      }
      if (
        part.payload.type === 'glyphRun'
        && part.payload.orientation === 'mixedPerGlyph'
        && options.allowMixedPerGlyphOrientation !== true
      ) {
        issues.push({
          code: 'mixedPerGlyphFeatureMissing',
          message: `Text variant '${variant.variantId}' uses mixedPerGlyph without text.vertical.mixedPerGlyph.`,
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
      message:
        'fallbackPolicy=none requires strictVisual profile, strictVisualFallbackFree metadata, and text.strictVisualFallbackFree.',
      opId: op.id,
      paintOrderSlotId: op.paintOrderSlotId,
    });
  }
  if (
    fallbackPolicy === 'none'
    && !op.variants.some((variant) => variant.kind === 'glyphRun' || variant.kind === 'glyphOutline')
  ) {
    issues.push({
      code: 'strictVisualVariantMissing',
      message: 'fallbackPolicy=none requires at least one strict visual text variant.',
      opId: op.id,
      paintOrderSlotId: op.paintOrderSlotId,
    });
  }

  return issues;
}

export function isSupportedGlyphOutlineStrokeStyle(
  stroke: LayerGlyphOutlineOp['stroke'] | undefined,
): boolean {
  return !!stroke
    && Number.isFinite(stroke.widthPx)
    && stroke.widthPx > 0
    && (stroke.miterLimit === undefined
      || (Number.isFinite(stroke.miterLimit) && stroke.miterLimit >= 0))
    && (stroke.join ?? 'miter') === 'miter'
    && (stroke.cap ?? 'butt') === 'butt'
    && (stroke.paintOrder ?? 'fillThenStroke') === 'fillThenStroke';
}

export function hasGlyphOutlinePathsContract(payload: LayerGlyphOutlineOp): boolean {
  return payload.paths.length > 0
    && payload.paths.every((path) =>
      isValidPayloadGlyphId(path.glyphId)
      && isValidPayloadRange(path.sourceRangeUtf8)
      && isValidPayloadRange(path.glyphRange)
      && isValidPathCommands(path.commands)
      && isSupportedFillRule(path.fillRule ?? 'nonzero'),
    );
}

export function hasColrv0ColorLayersContract(payload: LayerGlyphOutlineOp): boolean {
  const colorLayers = payload.colorLayers;
  return payload.payloadKind === 'colorLayers'
    && !payload.stroke
    && colorLayers?.colorFormat === 'colrV0'
    && isValidPayloadRange(colorLayers.sourceRangeUtf8)
    && isValidPayloadRange(colorLayers.glyphRange)
    && Array.isArray(colorLayers.layers)
    && colorLayers.layers.length > 0
    && colorLayers.layers.every((layer) =>
      isValidPayloadIndex(layer.layerIndex)
      && isValidPayloadGlyphId(layer.glyphId)
      && isValidPayloadRange(layer.glyphRange)
      && isValidPayloadRange(layer.sourceRangeUtf8)
      && layer.sourceFontRef !== undefined
      && isValidPathCommands(layer.commands)
      && isValidResolvedColor(layer.fill)
      && isSupportedFillRule(layer.fillRule)
      && isValidPayloadIndex(layer.paletteIndex)
      && (layer.transformToRun === undefined || isFiniteAffineTransform(layer.transformToRun)),
    );
}

export function hasColrv1Stage1ColorGraphContract(payload: LayerGlyphOutlineOp): boolean {
  const colorLayers = payload.colorLayers;
  const graph = colorLayers?.paintGraph;
  if (
    payload.payloadKind !== 'colorLayers'
    || payload.stroke
    || colorLayers?.colorFormat !== 'colrV1'
    || colorLayers.sourceFontRef === undefined
    || !isValidPayloadRange(colorLayers.sourceRangeUtf8)
    || !isValidPayloadRange(colorLayers.glyphRange)
    || graph === undefined
    || !isValidPayloadGraphNodeId(graph.rootNodeId)
    || !Array.isArray(graph.nodes)
    || graph.nodes.length === 0
  ) {
    return false;
  }

  const nodeIds = new Set<number>();
  const childRefCounts = new Map<number, number>();
  for (const node of graph.nodes) {
    if (!isValidPayloadGraphNodeId(node.nodeId)) {
      return false;
    }
    if (nodeIds.has(node.nodeId)) {
      return false;
    }
    nodeIds.add(node.nodeId);
  }
  if (!nodeIds.has(graph.rootNodeId)) {
    return false;
  }

  for (const node of graph.nodes) {
    if (node.kind === 'solidPath') {
      if (
        !(
          node.solidPath !== undefined
        && node.transform === undefined
        && isValidPathCommands(node.solidPath.commands)
        && isValidResolvedColor(node.solidPath.fill)
        && isSupportedFillRule(node.solidPath.fillRule)
        && (node.solidPath.sourceGlyphId === undefined || isValidPayloadGlyphId(node.solidPath.sourceGlyphId))
        && (node.solidPath.paletteIndex === undefined || isValidPayloadIndex(node.solidPath.paletteIndex))
        && isValidPayloadRange(node.sourceRangeUtf8)
        && isValidPayloadRange(node.glyphRange)
          && node.sourceFontRef !== undefined
        )
      ) {
        return false;
      }
      continue;
    }
    if (
      (node.sourceRangeUtf8 !== undefined && !isValidPayloadRange(node.sourceRangeUtf8))
      || (node.glyphRange !== undefined && !isValidPayloadRange(node.glyphRange))
    ) {
      return false;
    }
    if (node.kind === 'transform') {
      if (
        !(
          node.solidPath === undefined
        && node.transform !== undefined
        && isValidPayloadGraphNodeId(node.transform.childNodeId)
        && nodeIds.has(node.transform.childNodeId)
          && node.transform.childNodeId !== node.nodeId
        && isFiniteAffineTransform(node.transform.transform)
        )
      ) {
        return false;
      }
      childRefCounts.set(
        node.transform.childNodeId,
        (childRefCounts.get(node.transform.childNodeId) ?? 0) + 1,
      );
      continue;
    }
    return false;
  }

  if ([...childRefCounts.values()].some((count) => count > 1)) {
    return false;
  }

  const nodesById = new Map(graph.nodes.map((node) => [node.nodeId, node]));
  const visited = new Set<number>();
  const visiting = new Set<number>();
  const visit = (nodeId: number): boolean => {
    if (visiting.has(nodeId)) {
      return false;
    }
    if (visited.has(nodeId)) {
      return true;
    }
    const node = nodesById.get(nodeId);
    if (!node) {
      return false;
    }
    visiting.add(nodeId);
    if (node.kind === 'transform') {
      if (!node.transform || !visit(node.transform.childNodeId)) {
        return false;
      }
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    return true;
  };

  return visit(graph.rootNodeId) && visited.size === graph.nodes.length;
}

export function hasStrictBitmapGlyphContract(payload: LayerGlyphOutlineOp): boolean {
  const bitmapGlyph = payload.bitmapGlyph;
  return payload.payloadKind === 'bitmapGlyph'
    && bitmapGlyph !== undefined
    && isValidResourceId(bitmapGlyph.imageResourceId)
    && isValidPayloadRange(bitmapGlyph.sourceRangeUtf8)
    && isValidPayloadRange(bitmapGlyph.glyphRange)
    && isValidTextRunPlacement(bitmapGlyph.placement)
    && (bitmapGlyph.transformToRun === undefined || isFiniteAffineTransform(bitmapGlyph.transformToRun))
    && (bitmapGlyph.strikePpem === undefined || isValidBitmapStrikePpem(bitmapGlyph.strikePpem))
    && bitmapGlyph.strikeSelection === 'producerResolved'
    && isSupportedBitmapAlphaMode(bitmapGlyph.alphaMode)
    && isSupportedBitmapScalingPolicy(bitmapGlyph.scalingPolicy)
    && isSupportedBitmapFiltering(bitmapGlyph.filtering);
}

export function hasStaticSanitizedSvgGlyphContract(payload: LayerGlyphOutlineOp): boolean {
  const svgGlyph = payload.svgGlyph;
  const viewBox = svgGlyph?.viewBox;
  return payload.payloadKind === 'svgGlyph'
    && svgGlyph !== undefined
    && isValidResourceId(svgGlyph.vectorResourceId)
    && isValidPayloadRange(svgGlyph.sourceRangeUtf8)
    && isValidPayloadRange(svgGlyph.glyphRange)
    && isValidTextRunPlacement(svgGlyph.placement)
    && (svgGlyph.transformToRun === undefined || isFiniteAffineTransform(svgGlyph.transformToRun))
    && viewBox !== undefined
    && Number.isFinite(viewBox.x)
    && Number.isFinite(viewBox.y)
    && Number.isFinite(viewBox.width)
    && Number.isFinite(viewBox.height)
    && viewBox.width > 0
    && viewBox.height > 0
    && (svgGlyph.intrinsicSize === undefined
      || (Number.isFinite(svgGlyph.intrinsicSize.width)
        && Number.isFinite(svgGlyph.intrinsicSize.height)
        && svgGlyph.intrinsicSize.width > 0
        && svgGlyph.intrinsicSize.height > 0))
    && svgGlyph.securityMode === 'staticSanitized'
    && svgGlyph.scriptAllowed === false
    && svgGlyph.animationAllowed === false
    && svgGlyph.externalResourcesAllowed === false
    && svgGlyph.interactivityAllowed === false;
}

function isValidPayloadRange(range: { start: number; end: number } | undefined): boolean {
  return range !== undefined
    && Number.isInteger(range.start)
    && Number.isInteger(range.end)
    && range.start >= 0
    && range.end >= range.start;
}

function isValidPayloadGraphNodeId(nodeId: number | undefined): boolean {
  return typeof nodeId === 'number' && Number.isInteger(nodeId) && nodeId >= 0;
}

function isValidPayloadGlyphId(glyphId: number | undefined): boolean {
  return typeof glyphId === 'number' && Number.isInteger(glyphId) && glyphId >= 0;
}

function isValidPayloadIndex(index: number | undefined): boolean {
  return typeof index === 'number' && Number.isInteger(index) && index >= 0;
}

function isValidPathCommands(commands: LayerPathCommand[] | undefined): boolean {
  return Array.isArray(commands)
    && commands.length > 0
    && commands.every((command) => {
      switch (command.type) {
        case 'moveTo':
        case 'lineTo':
          return isFiniteNumber(command.x) && isFiniteNumber(command.y);
        case 'curveTo':
          return isFiniteNumber(command.x1)
            && isFiniteNumber(command.y1)
            && isFiniteNumber(command.x2)
            && isFiniteNumber(command.y2)
            && isFiniteNumber(command.x3)
            && isFiniteNumber(command.y3);
        case 'arcTo':
          return isFiniteNumber(command.rx)
            && isFiniteNumber(command.ry)
            && isFiniteNumber(command.rotation)
            && isFiniteNumber(command.x)
            && isFiniteNumber(command.y)
            && typeof command.largeArc === 'boolean'
            && typeof command.sweep === 'boolean';
        case 'closePath':
          return true;
        default:
          return false;
      }
    });
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isValidResourceId(resourceId: string | number | undefined): boolean {
  return (typeof resourceId === 'string' && resourceId.length > 0)
    || (typeof resourceId === 'number' && Number.isInteger(resourceId) && resourceId >= 0);
}

function isValidTextRunPlacement(
  placement: { runToPage?: LayerAffineTransform; baselineY?: number } | undefined,
): boolean {
  return placement !== undefined
    && placement.runToPage !== undefined
    && isFiniteAffineTransform(placement.runToPage)
    && (placement.baselineY === undefined || Number.isFinite(placement.baselineY));
}

function isValidBitmapStrikePpem(strikePpem: [number, number]): boolean {
  return Number.isInteger(strikePpem[0])
    && Number.isInteger(strikePpem[1])
    && strikePpem[0] > 0
    && strikePpem[1] > 0;
}

function isSupportedBitmapAlphaMode(value: string | undefined): boolean {
  return value === 'premultiplied' || value === 'straight';
}

function isSupportedBitmapScalingPolicy(value: string | undefined): boolean {
  return value === 'noScale'
    || value === 'scaleToEm'
    || value === 'explicitTransform'
    || value === 'nearest'
    || value === 'linear';
}

function isSupportedBitmapFiltering(value: string | undefined): boolean {
  return value === 'nearest' || value === 'linear';
}

function isValidResolvedColor(
  color: { colorSpace?: string; rgba: [number, number, number, number] } | undefined,
): boolean {
  return color !== undefined
    && (color.colorSpace === undefined || color.colorSpace.length > 0)
    && Array.isArray(color.rgba)
    && color.rgba.length === 4
    && color.rgba.every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 1);
}

function isSupportedFillRule(fillRule: CanvasFillRule | undefined): boolean {
  return fillRule === 'nonzero' || fillRule === 'evenodd';
}

function isFiniteAffineTransform(transform: LayerAffineTransform): boolean {
  return Number.isFinite(transform.a)
    && Number.isFinite(transform.b)
    && Number.isFinite(transform.c)
    && Number.isFinite(transform.d)
    && Number.isFinite(transform.e)
    && Number.isFinite(transform.f);
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
