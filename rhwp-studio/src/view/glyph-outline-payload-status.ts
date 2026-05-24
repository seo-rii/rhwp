import { resolveLayerResourceIndex } from '@/core/layer-resource-store';
import {
  hasColrv0ColorLayersContract,
  hasColrv1Stage1ColorGraphContract,
  hasGlyphOutlinePathsContract,
  hasStaticSanitizedSvgGlyphContract,
  hasStrictBitmapGlyphContract,
  isSupportedGlyphOutlineStrokeStyle,
  type LayerTextVariantReplayStatus,
} from '@/core/text-variants';
import type { LayerGlyphOutlineOp, LayerResources } from '@/core/types';
import { parseStaticSvgPathLayers } from './layer-canvas-utils';

export type GlyphOutlinePayloadReplayStatus = {
  supported: boolean;
  reason?: LayerTextVariantReplayStatus['reason'];
};

export function glyphOutlinePayloadStatus(
  op: LayerGlyphOutlineOp,
  resources?: LayerResources | null,
  options: { allowDomParserForSvg?: boolean } = {},
): GlyphOutlinePayloadReplayStatus {
  const payloadKind = op.payloadKind ?? 'monochromeFill';
  if (payloadKind === 'colorLayers') {
    const supportsColrv0 = op.variant.requires?.includes('text.glyphOutline.colorLayers') === true
      && op.variant.requires?.includes('text.glyphOutline.colorLayers.colrV0') === true
      && hasColrv0ColorLayersContract(op);
    const supportsColrv1 = op.variant.requires?.includes('text.glyphOutline.colorLayers') === true
      && op.variant.requires?.includes('text.glyphOutline.colorLayers.colrV1') === true
      && hasColrv1Stage1ColorGraphContract(op);
    return {
      supported: supportsColrv0 || supportsColrv1,
      reason: 'unsupportedColorGlyph',
    };
  }
  if (payloadKind === 'monochromeFill') {
    return {
      supported: hasGlyphOutlinePathsContract(op) && !op.stroke,
      reason: !hasGlyphOutlinePathsContract(op)
        ? 'unsupportedOutlinePayload'
        : op.stroke
          ? 'glyphOutlineStrokeStyleUnsupported'
          : undefined,
    };
  }
  if (payloadKind === 'monochromeFillStroke') {
    return {
      supported: hasGlyphOutlinePathsContract(op) && isSupportedGlyphOutlineStrokeStyle(op.stroke),
      reason: !hasGlyphOutlinePathsContract(op) ? 'unsupportedOutlinePayload' : 'glyphOutlineStrokeStyleUnsupported',
    };
  }
  if (payloadKind === 'bitmapGlyph') {
    const resourceId = op.bitmapGlyph?.imageResourceId;
    const resourceIndex = resolveLayerResourceIndex(
      resourceId,
      resources?.imageKeys,
      resources?.images.length ?? 0,
    );
    return {
      supported: hasStrictBitmapGlyphContract(op)
        && op.variant.requires?.includes('text.glyphOutline.bitmapGlyph') === true
        && hasReplayableGlyphPayloadBBox(op)
        && resourceIndex !== undefined
        && resources?.images?.[resourceIndex] !== undefined,
      reason: 'unsupportedBitmapGlyph',
    };
  }
  if (payloadKind === 'svgGlyph') {
    const resourceId = op.svgGlyph?.vectorResourceId;
    const resourceIndex = resolveLayerResourceIndex(
      resourceId,
      resources?.svgKeys,
      resources?.svgFragments.length ?? 0,
    );
    const fragment = resourceIndex === undefined ? undefined : resources?.svgFragments?.[resourceIndex];
    return {
      supported: hasStaticSanitizedSvgGlyphContract(op)
        && op.variant.requires?.includes('text.glyphOutline.svgGlyph') === true
        && hasReplayableGlyphPayloadBBox(op)
        && typeof fragment === 'string'
        && parseStaticSvgPathLayers(fragment, { allowDomParser: options.allowDomParserForSvg }).length > 0,
      reason: 'unsupportedSvgGlyph',
    };
  }
  return { supported: false, reason: 'unsupportedOutlinePayload' };
}

function hasReplayableGlyphPayloadBBox(op: LayerGlyphOutlineOp): boolean {
  const bbox = op.bbox;
  return Number.isFinite(bbox.x)
    && Number.isFinite(bbox.y)
    && Number.isFinite(bbox.width)
    && Number.isFinite(bbox.height)
    && bbox.width > 0
    && bbox.height > 0;
}
