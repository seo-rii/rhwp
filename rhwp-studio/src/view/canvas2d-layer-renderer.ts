import {
  hasGlyphOutlinePathsContract,
  isFillOnlyGlyphOutlineStyle,
  hasStaticSanitizedSvgGlyphContract,
  hasStrictBitmapGlyphContract,
  layerTextVariantOpsForLeaf,
  selectLayerTextVariantSetsWithReport,
  shouldRenderLayerTextVariant,
  validateLayerTextV2Tree,
  type LayerTextVariantGroupReport,
  type LayerTextVariantReplayStatus,
  type LayerTextV2ValidationIssue,
} from '@/core/text-variants';
import {
  buildCanvasTextFont,
  resolveRenderFontWeight,
} from '@/core/font-substitution';
import { resolveLayerResourceIndex } from '@/core/layer-resource-store';
import { assertNeverLayerPaintOp } from '@/core/types';
import type { CanvasKitRenderMode } from './render-backend';
import { glyphOutlinePayloadStatus } from './glyph-outline-payload-status';
import type {
  LayerBounds,
  LayerCharOverlapOp,
  LayerClipNode,
  LayerEllipseOp,
  LayerEquationOp,
  LayerFootnoteMarkerOp,
  LayerFormObjectOp,
  LayerGradient,
  LayerGlyphOutlineOp,
  LayerImageOp,
  LayerLeafNode,
  LayerLineOp,
  LayerNode,
  LayerPageBackgroundOp,
  LayerPaintOp,
  LayerPathCommand,
  LayerPathOp,
  LayerPatternFill,
  LayerRectangleOp,
  LayerShapeShadow,
  LayerTabLeader,
  LayerTabLeaderOp,
  LayerTextDecorationOp,
  LayerTextRunOp,
  LayerTextControlMarkOp,
  PageLayerTree,
} from '@/core/types';
import {
  allowsTextControlMark,
  angleToCanvasCoords,
  applyLayerImageEffect,
  calculateArrowDimensions,
  canPreprocessCroppedLayerImageEffect,
  computePathPaintBounds,
  createPatternTileCanvas,
  decodeBase64,
  drawCanvas2DCharOverlap,
  encodeBase64,
  estimateDisplayTextPositions,
  effectiveLayerImageBounds,
  inferImageMime,
  isHalfwidthScaledCluster,
  layerCanvasImageSourceSize,
  mapPuaDisplayText,
  resetLayerImageEffectDiagnostics,
  resolveLayerImageCropSource,
  type LayerCanvasImageSource,
  type LayerImageEffectDiagnostics,
  type LayerImageEffectCache,
  renderEquationLayoutBox,
  splitIntoClusters,
  startsWithInvalidControl,
} from './layer-canvas-utils';
import { arrowHeadShape, gradientColorStops, resolveImagePlacement, strokeDashPattern } from './layer-geometry-utils';
import { isStaticSvgPathDataValid } from './static-svg-path-data';
import {
  parseStaticSvgPathLayers,
  parseStaticSvgTextLayers,
  staticSvgLayersHaveDrawableContent,
  type StaticSvgTextLayer,
} from './static-svg-path-layers';
import { replayColorPaintGraph, resolvedColorToCss } from './glyph-outline-color-graph-utils';
import { formObjectPalette } from './form-replay-utils';
import {
  LAYER_REPLAY_PLANES,
  layerPaintOpReplayPlane,
  type LayerReplayPlane,
} from './canvaskit/replay-plane';
import {
  TEXT_CONTROL_MARK_FONT_FAMILY,
  tabLeaderLineSegments,
  textDecorationEmphasisGeometry,
  textDecorationEmphasisSize,
  textDecorationEmphasisPosition,
  textDecorationLineGeometry,
  textDecorationLineY,
  textScriptMetrics,
} from './text-replay-utils';

type OverlayClip = {
  bounds: LayerBounds;
  kind: LayerClipNode['clipKind'];
  rightOverflowSlop: number;
  allowHorizontalOverflowControls: boolean;
};

export class Canvas2DLayerRenderer {
  private readonly currentClipStack: OverlayClip[] = [];
  private readonly domImageCache = new Map<string, HTMLImageElement>();
  private readonly imageEffectCache: LayerImageEffectCache = new WeakMap();
  private readonly imageEffectDiagnostics: LayerImageEffectDiagnostics = {
    cacheHits: 0,
    cacheMisses: 0,
    preprocessFailures: 0,
    fallbackToOriginal: 0,
    preprocessedPixels: 0,
    preprocessedBytes: 0,
    maxPreprocessedBytes: 0,
    preprocessTimeMs: 0,
    maxPreprocessTimeMs: 0,
    heapDeltaBytes: 0,
    maxHeapDeltaBytes: 0,
    offscreenCanvasPreprocesses: 0,
    htmlCanvasPreprocesses: 0,
    directImageReadbackPreprocesses: 0,
  };
  private readonly patternCache = new Map<string, CanvasPattern | null>();
  private lastRenderedTree: PageLayerTree | null = null;
  private lastTargetCanvas: HTMLCanvasElement | null = null;
  private lastScale = 1;
  private currentResources: PageLayerTree['resources'] | null = null;
  private currentResourceTableId: number | null = null;
  private currentClipEnabled = true;
  private currentShowParagraphMarks = false;
  private currentShowControlCodes = false;
  private strictGlyphOutlineReplay = false;
  private readonly textVariantSelectionDiagnostics: LayerTextVariantGroupReport[] = [];
  private readonly textV2ValidationDiagnostics: LayerTextV2ValidationIssue[] = [];
  private rerenderScheduled = false;
  private asyncResourceReadyCallback: (() => void) | null = null;

  constructor(private readonly renderMode: CanvasKitRenderMode = 'compat') {}

  renderPage(
    tree: PageLayerTree,
    targetCanvas: HTMLCanvasElement,
    scale: number,
  ): void {
    const ctx = targetCanvas.getContext('2d');
    if (!ctx) {
      throw new Error('Canvas2D context 생성 실패');
    }

    this.lastRenderedTree = tree;
    this.lastTargetCanvas = targetCanvas;
    this.lastScale = scale;
    this.currentClipEnabled = tree.outputOptions?.clipEnabled ?? true;
    this.currentShowParagraphMarks = tree.outputOptions?.showParagraphMarks ?? false;
    this.currentShowControlCodes = tree.outputOptions?.showControlCodes ?? false;
    this.textVariantSelectionDiagnostics.length = 0;
    this.textV2ValidationDiagnostics.length = 0;
    this.textV2ValidationDiagnostics.push(...validateLayerTextV2Tree(tree));
    if (this.currentResourceTableId !== (tree.resources?.tableId ?? null)) {
      this.clearResourceImageCaches();
    }
    this.currentResources = tree.resources ?? null;
    this.currentResourceTableId = tree.resources?.tableId ?? null;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
    ctx.restore();

    ctx.save();
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.textBaseline = 'alphabetic';
    for (const replayPlane of LAYER_REPLAY_PLANES) {
      this.renderNode(ctx, tree.root, replayPlane);
    }
    ctx.restore();
  }

  setAsyncResourceReadyCallback(callback: (() => void) | null): void {
    this.asyncResourceReadyCallback = callback;
  }

  resetDocumentResources(): void {
    this.clearResourceImageCaches();
    this.currentResources = null;
    this.currentResourceTableId = null;
    this.lastRenderedTree = null;
    this.lastTargetCanvas = null;
    this.rerenderScheduled = false;
  }

  setStrictGlyphOutlineReplay(enabled: boolean): void {
    this.strictGlyphOutlineReplay = enabled;
  }

  getImageEffectDiagnostics(): Readonly<LayerImageEffectDiagnostics> {
    return { ...this.imageEffectDiagnostics };
  }

  getTextVariantSelectionDiagnostics(): readonly LayerTextVariantGroupReport[] {
    return this.textVariantSelectionDiagnostics.map((report) => ({
      backend: report.backend,
      renderProfile: report.renderProfile,
      equivalenceGroup: report.equivalenceGroup,
      selectedVariantId: report.selectedVariantId,
      selectedVariantKind: report.selectedVariantKind,
      selectedReason: report.selectedReason,
      anchorOpId: report.anchorOpId,
      partsExpected: report.partsExpected,
      partsReplayed: report.partsReplayed,
      rejectedVariants: report.rejectedVariants.map((variant) => ({
        variantId: variant.variantId,
        variantKind: variant.variantKind,
        reasons: [...variant.reasons],
        details: variant.details ? [...variant.details] : undefined,
      })),
      parts: report.parts.map((part) => ({
        ...part,
        fontVerification: part.fontVerification ? { ...part.fontVerification } : undefined,
        outlineEligibility: part.outlineEligibility ? { ...part.outlineEligibility } : undefined,
      })),
      fontVerification: report.fontVerification ? { ...report.fontVerification } : undefined,
      outlineEligibility: report.outlineEligibility ? { ...report.outlineEligibility } : undefined,
    }));
  }

  getTextV2ValidationDiagnostics(): readonly LayerTextV2ValidationIssue[] {
    return this.textV2ValidationDiagnostics.map((issue) => ({ ...issue }));
  }

  private glyphOutlineReplayStatus(op: LayerGlyphOutlineOp): LayerTextVariantReplayStatus {
    const payloadStatus = glyphOutlinePayloadStatus(op, this.currentResources);
    const hasReplayPayload = (op.payloadKind ?? 'monochromeFill') === 'colorLayers'
      ? payloadStatus.supported
      : (op.payloadKind ?? 'monochromeFill') === 'bitmapGlyph'
        ? payloadStatus.supported
        : (op.payloadKind ?? 'monochromeFill') === 'svgGlyph'
          ? payloadStatus.supported
          : hasGlyphOutlinePathsContract(op);
    const payloadSupported = op.diagnostics.strictVisualEligible
      && payloadStatus.supported
      && hasReplayPayload;
    const paintStyleSupported = isFillOnlyGlyphOutlineStyle(op);
    const replayable = this.strictGlyphOutlineReplay
      && payloadSupported
      && paintStyleSupported;
    let reason: LayerTextVariantReplayStatus['reason'];
    if (!this.strictGlyphOutlineReplay) {
      reason = 'backendDoesNotSupportVariant';
    } else if (!payloadSupported) {
      reason = payloadStatus.reason;
    } else if (!paintStyleSupported) {
      reason = 'unsupportedPaintEffect';
    }
    return {
      replayable,
      reason,
      details: payloadStatus.details,
      outlineEligibility: {
        strictVisualEligible: op.diagnostics.strictVisualEligible,
        payloadSupported,
        paintStyleSupported,
        replayEligible: replayable,
        reason,
      },
    };
  }

  resetImageEffectDiagnostics(): void {
    resetLayerImageEffectDiagnostics(this.imageEffectDiagnostics);
  }

  private renderNode(
    ctx: CanvasRenderingContext2D,
    node: LayerNode,
    replayPlane: LayerReplayPlane,
  ): void {
    switch (node.kind) {
      case 'group':
        for (const child of node.children) {
          this.renderNode(ctx, child, replayPlane);
        }
        return;
      case 'clipRect':
        this.renderClipNode(ctx, node, replayPlane);
        return;
      case 'leaf':
        this.renderLeafNode(ctx, node, replayPlane);
        return;
    }
  }

  private renderClipNode(
    ctx: CanvasRenderingContext2D,
    node: LayerClipNode,
    replayPlane: LayerReplayPlane,
  ): void {
    if (!this.currentClipEnabled) {
      this.renderNode(ctx, node.child, replayPlane);
      return;
    }
    const clip = {
      bounds: node.clip,
      kind: node.clipKind,
      rightOverflowSlop: node.clipPolicy?.rightOverflowSlop ?? (node.clipKind === 'body' || node.clipKind === 'tableCell' ? 4 : 0),
      allowHorizontalOverflowControls: node.clipPolicy?.allowHorizontalOverflowControls ?? (node.clipKind === 'body'),
    };
    this.currentClipStack.push(clip);
    ctx.save();
    ctx.beginPath();
    ctx.rect(
      node.clip.x,
      node.clip.y,
      node.clip.width + clip.rightOverflowSlop,
      node.clip.height,
    );
    ctx.clip();
    try {
      this.renderNode(ctx, node.child, replayPlane);
    } finally {
      ctx.restore();
      this.currentClipStack.pop();
    }
  }

  private renderLeafNode(
    ctx: CanvasRenderingContext2D,
    node: LayerLeafNode,
    replayPlane: LayerReplayPlane,
  ): void {
    const ops = layerTextVariantOpsForLeaf(node.ops, this.lastRenderedTree?.variantOps);
    let selectedTextVariants: ReadonlyMap<string, string> = new Map();
    if (replayPlane === 'flow') {
      const selectedResult = selectLayerTextVariantSetsWithReport(
        ops,
        () => ({ replayable: false, reason: 'backendDoesNotSupportVariant' }),
        (op) => this.glyphOutlineReplayStatus(op),
        {
          backend: 'canvas2d',
          renderProfile: this.lastRenderedTree?.profile,
        },
      );
      this.textVariantSelectionDiagnostics.push(...selectedResult.reports);
      selectedTextVariants = selectedResult.selected;
    }
    for (const op of ops) {
      if (layerPaintOpReplayPlane(op) !== replayPlane) {
        continue;
      }
      if (!shouldRenderLayerTextVariant(op, selectedTextVariants)) {
        continue;
      }
      this.renderOp(ctx, op);
    }
  }

  private renderOp(ctx: CanvasRenderingContext2D, op: LayerPaintOp): void {
    switch (op.type) {
      case 'pageBackground':
        this.withCurrentOverlayClip(ctx, 0, () => {
          this.renderPageBackground(ctx, op);
        }, op.bbox);
        return;
      case 'text':
        // Schema v2 Text ops are expanded into concrete variant payloads before
        // leaf replay. If one reaches this switch, keep it non-painting.
        return;
      case 'textRun':
        this.withCurrentOverlayClip(ctx, 0, () => {
          this.renderTextRun(ctx, op);
        }, op.bbox);
        return;
      case 'glyphRun':
        // GlyphRun is an optional schema-v1 alternative. Browser Canvas2D
        // keeps the TextRun fallback as its canonical replay path.
        return;
      case 'glyphOutline':
        if (
          !glyphOutlinePayloadStatus(op, this.currentResources).supported
          || !isFillOnlyGlyphOutlineStyle(op)
        ) {
          return;
        }
        this.withCurrentOverlayClip(ctx, 0, () => {
          const payloadKind = op.payloadKind ?? 'monochromeFill';
          if (payloadKind === 'bitmapGlyph') {
            const payload = op.bitmapGlyph;
            const imageIndex = resolveLayerResourceIndex(
              payload?.imageResourceId,
              this.currentResources?.imageKeys,
              this.currentResources?.images.length ?? 0,
            );
            if (!payload || !hasStrictBitmapGlyphContract(op) || imageIndex === undefined) {
              return;
            }
            const image = this.getDomImage(imageIndex);
            if (!image) {
              return;
            }
            const previousImageSmoothingEnabled = ctx.imageSmoothingEnabled;
            const { width, height } = op.bbox;
            if (
              !Number.isFinite(width)
              || !Number.isFinite(height)
              || width <= 0
              || height <= 0
            ) {
              return;
            }
            const transform = payload.placement?.runToPage;
            if (!transform) {
              return;
            }
            const payloadTransform = payload.transformToRun;
            ctx.save();
            try {
              ctx.transform(
                transform.a,
                transform.b,
                transform.c,
                transform.d,
                transform.e,
                transform.f,
              );
              if (payloadTransform) {
                ctx.transform(
                  payloadTransform.a,
                  payloadTransform.b,
                  payloadTransform.c,
                  payloadTransform.d,
                  payloadTransform.e,
                  payloadTransform.f,
                );
              }
              ctx.imageSmoothingEnabled = payload.filtering !== 'nearest';
              this.drawDomImage(ctx, image, { x: 0, y: 0, width, height });
            } finally {
              ctx.imageSmoothingEnabled = previousImageSmoothingEnabled;
              ctx.restore();
            }
            return;
          }
          if (payloadKind === 'svgGlyph') {
            const payload = op.svgGlyph;
            const vectorIndex = resolveLayerResourceIndex(
              payload?.vectorResourceId,
              this.currentResources?.svgKeys,
              this.currentResources?.svgFragments.length ?? 0,
            );
            if (!payload || !hasStaticSanitizedSvgGlyphContract(op) || vectorIndex === undefined) {
              return;
            }
            const viewBox = payload.viewBox;
            const { x, y, width, height } = op.bbox;
            if (
              !viewBox
              || !Number.isFinite(viewBox.x)
              || !Number.isFinite(viewBox.y)
              || !Number.isFinite(viewBox.width)
              || !Number.isFinite(viewBox.height)
              || viewBox.width <= 0
              || viewBox.height <= 0
              || !Number.isFinite(x)
              || !Number.isFinite(y)
              || !Number.isFinite(width)
              || !Number.isFinite(height)
              || width <= 0
              || height <= 0
            ) {
              return;
            }
            const fragment = this.currentResources?.svgFragments?.[vectorIndex];
            if (typeof fragment !== 'string') {
              return;
            }
            const pathLayers = parseStaticSvgPathLayers(fragment);
            if (pathLayers.length === 0) {
              return;
            }
            const transform = payload.placement?.runToPage;
            if (!transform) {
              return;
            }
            const payloadTransform = payload.transformToRun;
            ctx.save();
            try {
              ctx.transform(
                transform.a,
                transform.b,
                transform.c,
                transform.d,
                transform.e,
                transform.f,
              );
              if (payloadTransform) {
                ctx.transform(
                  payloadTransform.a,
                  payloadTransform.b,
                  payloadTransform.c,
                  payloadTransform.d,
                  payloadTransform.e,
                  payloadTransform.f,
                );
              }
              ctx.scale(width / viewBox.width, height / viewBox.height);
              ctx.translate(-viewBox.x, -viewBox.y);
              for (const layer of pathLayers) {
                ctx.save();
                try {
                  if (layer.transform) {
                    ctx.transform(
                      layer.transform.a,
                      layer.transform.b,
                      layer.transform.c,
                      layer.transform.d,
                      layer.transform.e,
                      layer.transform.f,
                    );
                  }
                  const path = new Path2D(layer.pathData);
                  const previousAlpha = ctx.globalAlpha;
                  if (layer.fill !== null) {
                    ctx.fillStyle = layer.fill;
                    ctx.globalAlpha = previousAlpha * layer.opacity;
                    ctx.fill(path, layer.fillRule ?? 'nonzero');
                  }
                  if (layer.stroke) {
                    ctx.strokeStyle = layer.stroke.color;
                    ctx.lineWidth = layer.stroke.width;
                    ctx.lineJoin = layer.stroke.lineJoin;
                    ctx.lineCap = layer.stroke.lineCap;
                    ctx.miterLimit = layer.stroke.miterLimit;
                    ctx.setLineDash(layer.stroke.dashArray ?? []);
                    ctx.lineDashOffset = layer.stroke.dashOffset;
                    ctx.globalAlpha = previousAlpha * layer.stroke.opacity;
                    ctx.stroke(path);
                  }
                  ctx.globalAlpha = previousAlpha;
                } finally {
                  ctx.restore();
                }
              }
            } finally {
              ctx.restore();
            }
            return;
          }
          ctx.save();
          const transform = op.placement.runToPage;
          ctx.transform(
            transform.a,
            transform.b,
            transform.c,
            transform.d,
            transform.e,
            transform.f,
          );
          ctx.fillStyle = op.paintStyle.color;
          if (payloadKind === 'colorLayers') {
            if (op.colorLayers?.colorFormat === 'colrV1' && op.colorLayers.paintGraph) {
              const graph = op.colorLayers.paintGraph;
              replayColorPaintGraph(graph, {
                renderSolidPath: (solidPath) => {
                  ctx.beginPath();
                  appendPathCommands(ctx, solidPath.commands);
                  ctx.fillStyle = resolvedColorToCss(solidPath.fill);
                  ctx.fill(solidPath.fillRule);
                },
                renderLinearGradientPath: (gradientPath) => {
                  const gradient = gradientPath.gradient;
                  const fill = ctx.createLinearGradient(
                    gradient.x0,
                    gradient.y0,
                    gradient.x1,
                    gradient.y1,
                  );
                  for (const stop of gradient.stops) {
                    fill.addColorStop(stop.offset, resolvedColorToCss(stop.color));
                  }
                  ctx.beginPath();
                  appendPathCommands(ctx, gradientPath.commands);
                  ctx.fillStyle = fill;
                  ctx.fill(gradientPath.fillRule);
                },
                renderRadialGradientPath: (gradientPath) => {
                  const gradient = gradientPath.gradient;
                  const fill = ctx.createRadialGradient(
                    gradient.cx,
                    gradient.cy,
                    0,
                    gradient.cx,
                    gradient.cy,
                    gradient.radius,
                  );
                  for (const stop of gradient.stops) {
                    fill.addColorStop(stop.offset, resolvedColorToCss(stop.color));
                  }
                  ctx.beginPath();
                  appendPathCommands(ctx, gradientPath.commands);
                  ctx.fillStyle = fill;
                  ctx.fill(gradientPath.fillRule);
                },
                renderSweepGradientPath: (gradientPath) => {
                  const gradient = gradientPath.gradient;
                  const fill = ctx.createConicGradient(
                    gradient.startAngleDegrees * Math.PI / 180,
                    gradient.cx,
                    gradient.cy,
                  );
                  for (const stop of gradient.stops) {
                    fill.addColorStop(stop.offset, resolvedColorToCss(stop.color));
                  }
                  ctx.beginPath();
                  appendPathCommands(ctx, gradientPath.commands);
                  ctx.fillStyle = fill;
                  ctx.fill(gradientPath.fillRule);
                },
                withTransform: (transform, draw) => {
                  ctx.save();
                  ctx.transform(
                    transform.a,
                    transform.b,
                    transform.c,
                    transform.d,
                    transform.e,
                    transform.f,
                  );
                  try {
                    draw();
                  } finally {
                    ctx.restore();
                  }
                },
                renderComposite: (mode, drawBackdrop, drawSource) => {
                  if (mode !== 'sourceOver') {
                    return;
                  }
                  drawBackdrop();
                  const previousOperation = ctx.globalCompositeOperation;
                  try {
                    ctx.globalCompositeOperation = 'source-over';
                    drawSource();
                  } finally {
                    ctx.globalCompositeOperation = previousOperation;
                  }
                },
                withClip: (clip, draw) => {
                  ctx.save();
                  ctx.beginPath();
                  appendPathCommands(ctx, clip.clipCommands);
                  ctx.clip(clip.fillRule);
                  try {
                    draw();
                  } finally {
                    ctx.restore();
                  }
                },
              });
              ctx.restore();
              return;
            }
            for (const layer of op.colorLayers?.layers ?? []) {
              if (!layer.commands || !layer.fill) {
                continue;
              }
              const layerTransform = layer.transformToRun;
              if (layerTransform) {
                ctx.save();
                ctx.transform(
                  layerTransform.a,
                  layerTransform.b,
                  layerTransform.c,
                  layerTransform.d,
                  layerTransform.e,
                  layerTransform.f,
                );
              }
              ctx.beginPath();
              appendPathCommands(ctx, layer.commands);
              ctx.fillStyle = resolvedColorToCss(layer.fill);
              ctx.fill(layer.fillRule ?? 'nonzero');
              if (layerTransform) {
                ctx.restore();
              }
            }
            ctx.restore();
            return;
          }
          const stroke = payloadKind === 'monochromeFillStroke'
            ? op.stroke
            : undefined;
          if (stroke) {
            ctx.strokeStyle = applyCssAlpha(stroke.color ?? op.paintStyle.color, stroke.opacity ?? 1);
            ctx.lineWidth = stroke.widthPx;
            ctx.lineJoin = stroke.join ?? 'miter';
            ctx.lineCap = stroke.cap ?? 'butt';
            if (typeof stroke.miterLimit === 'number') {
              ctx.miterLimit = stroke.miterLimit;
            }
          }
          for (const path of op.paths) {
            ctx.beginPath();
            appendPathCommands(ctx, path.commands);
            ctx.fill(path.fillRule ?? 'nonzero');
            if (stroke) {
              ctx.stroke();
            }
          }
          ctx.restore();
        }, op.bbox);
        return;
      case 'charOverlap':
        this.withCurrentOverlayClip(ctx, 0, () => {
          this.renderCharOverlap(ctx, op);
        }, op.bbox);
        return;
      case 'textControlMark':
        this.withCurrentOverlayClip(ctx, 0, () => {
          this.renderTextControlMark(ctx, op);
        }, op.bbox);
        return;
      case 'tabLeader':
        this.withCurrentOverlayClip(ctx, 0, () => {
          this.renderTabLeader(ctx, op);
        }, op.bbox);
        return;
      case 'textDecoration':
        this.withCurrentOverlayClip(ctx, 0, () => {
          this.renderTextDecoration(ctx, op);
        }, op.bbox);
        return;
      case 'footnoteMarker':
        this.withCurrentOverlayClip(ctx, 0, () => {
          this.renderFootnoteMarker(ctx, op);
        }, op.bbox);
        return;
      case 'line':
        this.withCurrentOverlayClip(ctx, 0, () => {
          this.renderLine(ctx, op);
        }, op.bbox);
        return;
      case 'rectangle':
        this.withCurrentOverlayClip(ctx, 0, () => {
          this.renderRectangle(ctx, op);
        }, op.bbox);
        return;
      case 'ellipse':
        this.withCurrentOverlayClip(ctx, 0, () => {
          this.renderEllipse(ctx, op);
        }, op.bbox);
        return;
      case 'path':
        this.withCurrentOverlayClip(ctx, 0, () => {
          this.renderPath(ctx, op);
        }, computePathPaintBounds(op.commands, op.bbox));
        return;
      case 'image':
        this.withCurrentOverlayClip(ctx, 0, () => {
          this.renderImage(ctx, op);
        }, op.bbox);
        return;
      case 'equation':
        this.withCurrentOverlayClip(ctx, 0, () => {
          if (this.renderEquationSvgResource(ctx, op)) {
            return;
          }
          renderEquationLayoutBox(
            ctx,
            op.layoutBox,
            op.bbox.x,
            op.bbox.y,
            op.color,
            op.fontSize,
            false,
            false,
          );
        }, op.bbox);
        return;
      case 'formObject':
        this.withCurrentOverlayClip(ctx, 0, () => {
          this.renderFormObject(ctx, op);
        }, op.bbox);
        return;
      default:
        assertNeverLayerPaintOp(op);
    }
  }

  private renderPageBackground(ctx: CanvasRenderingContext2D, op: LayerPageBackgroundOp): void {
    const fill = this.makeShapeFillStyle(
      ctx,
      op.bbox,
      op.backgroundColor ?? null,
      op.gradient,
      undefined,
    );
    if (fill) {
      ctx.save();
      ctx.fillStyle = fill;
      ctx.fillRect(op.bbox.x, op.bbox.y, op.bbox.width, op.bbox.height);
      ctx.restore();
    }

    if (op.image) {
      const image = this.getDomImage(op.image.resourceId, op.image.base64);
      if (image) {
        const source = applyLayerImageEffect(
          image,
          op.image.effect ?? 'realPic',
          this.imageEffectCache,
          this.imageEffectDiagnostics,
          undefined,
          op.image.brightness ?? 0,
          op.image.contrast ?? 0,
        );
        const opacity = Number.isFinite(op.image.opacity)
          ? Math.min(1, Math.max(0, op.image.opacity ?? 1))
          : 1;
        ctx.save();
        try {
          ctx.globalAlpha *= opacity;
          this.drawDomImage(
            ctx,
            source,
            op.bbox,
            op.image.fillMode,
            undefined,
            undefined,
            source !== image,
          );
        } finally {
          ctx.restore();
        }
      }
    }

    if (op.borderColor && op.borderWidth > 0) {
      ctx.save();
      ctx.strokeStyle = op.borderColor;
      ctx.lineWidth = Math.max(op.borderWidth, 0.5);
      ctx.strokeRect(op.bbox.x, op.bbox.y, op.bbox.width, op.bbox.height);
      ctx.restore();
    }
  }

  private renderTextRun(ctx: CanvasRenderingContext2D, op: LayerTextRunOp): void {
    const ratio = typeof op.style.ratio === 'number' && op.style.ratio > 0 ? op.style.ratio : 1;
    const hasRatio = Math.abs(ratio - 1) > 0.01;
    const outlineType = op.style.outlineType ?? 0;
    const shadowType = op.style.shadowType ?? 0;
    const shadowColor = typeof op.style.shadowColor === 'string' ? op.style.shadowColor : op.style.color;
    const shadowOffsetX = typeof op.style.shadowOffsetX === 'number' ? op.style.shadowOffsetX : 0;
    const shadowOffsetY = typeof op.style.shadowOffsetY === 'number' ? op.style.shadowOffsetY : 0;
    const emboss = !!op.style.emboss;
    const engrave = !!op.style.engrave;
    const decorationsAreMirrors = op.legacyVisuals?.decorations === 'mirror';
    const emphasisDot = decorationsAreMirrors ? 0 : (op.style.emphasisDot ?? 0);
    const shadeColor = (typeof op.style.shadeColor === 'string' ? op.style.shadeColor : '#ffffff').toLowerCase();
    const baseFontSize = op.style.fontSize || 12;
    const { fontSize, baselineShift } = textScriptMetrics(
      baseFontSize,
      op.style.superscript,
      op.style.subscript,
    );
    const text = op.displayText ?? mapPuaDisplayText(op.text);
    const positions = op.displayPositions
      ?? (text === op.text ? op.positions : estimateDisplayTextPositions(text, op.style));
    const clusters = splitIntoClusters(text);
    const renderFontWeight = resolveRenderFontWeight(op.style.fontFamily, op.style.bold);
    const baseFont = buildCanvasTextFont(
      op.style.fontFamily,
      fontSize,
      op.style.bold,
      op.style.italic,
      renderFontWeight,
    );
    const currencyFallbackFont = buildCanvasTextFont(
      'Malgun Gothic',
      fontSize,
      op.style.bold,
      op.style.italic,
      renderFontWeight,
    );
    const symbolFallbackFont = buildCanvasTextFont(
      'GulimChe',
      fontSize,
      op.style.bold,
      op.style.italic,
      renderFontWeight,
    );
    const clusterFonts = clusters.map((cluster) => {
      const ch = cluster.text.codePointAt(0) ?? 0;
      const needsCurrencyFallback =
        ch === 0x20A9 || ch === 0x20AC || ch === 0x00A3 || ch === 0x00A5;
      if (needsCurrencyFallback) {
        return currencyFallbackFont;
      }
      const needsSymbolFallback =
        (ch >= 0x2460 && ch <= 0x24FF)
        || (ch >= 0x25A0 && ch <= 0x25FF)
        || (ch >= 0x2600 && ch <= 0x27BF);
      return needsSymbolFallback ? symbolFallbackFont : baseFont;
    });

    const drawClusters = (originX: number, originY: number) => {
      const textWidth = positions.at(-1) ?? 0;
      const drawControlMarks = () => {
        if (op.legacyVisuals?.controlMarks === 'mirror') {
          return;
        }
        if (!op.controlMarks?.length) {
          return;
        }
        ctx.save();
        ctx.fillStyle = '#4A90D9';
        for (const mark of op.controlMarks) {
          if (!allowsTextControlMark(
            this.currentShowParagraphMarks,
            this.currentShowControlCodes,
            mark.kind,
          )) {
            continue;
          }
          this.setCanvasTextFont(ctx, TEXT_CONTROL_MARK_FONT_FAMILY, mark.fontSize, false, false);
          ctx.fillText(mark.text, originX + mark.x, originY + mark.y);
        }
        ctx.restore();
      };

      if (op.charOverlap && op.legacyVisuals?.charOverlap !== 'mirror') {
        drawCanvas2DCharOverlap(ctx, op, originX, originY);
        drawControlMarks();
        return;
      }

      if (textWidth > 0 && shadeColor !== '#ffffff') {
        ctx.save();
        ctx.fillStyle = shadeColor;
        ctx.fillRect(originX, originY - fontSize, textWidth, fontSize * 1.2);
        ctx.restore();
      }

      const drawPass = (
        dx: number,
        dy: number,
        fillColor: string,
        strokeColor?: string,
        lineWidth = 0,
      ) => {
        ctx.save();
        ctx.fillStyle = fillColor;
        if (strokeColor) {
          ctx.strokeStyle = strokeColor;
          ctx.lineWidth = lineWidth;
          ctx.lineJoin = 'round';
        }
        for (const [index, cluster] of clusters.entries()) {
          if (cluster.text === ' ' || cluster.text === '\t' || cluster.text === '\u2007') {
            continue;
          }
          if (startsWithInvalidControl(cluster.text)) {
            continue;
          }
          const clusterFont = clusterFonts[index];
          if (ctx.font !== clusterFont) {
            ctx.font = clusterFont;
          }
          const x = originX + positions[cluster.start] + dx;
          const y = originY + dy;
          if (isHalfwidthScaledCluster(cluster.text) && !hasRatio) {
            ctx.save();
            ctx.translate(x, y);
            ctx.scale(0.5, 1);
            ctx.fillText(cluster.text, 0, 0);
            if (strokeColor) {
              ctx.strokeText(cluster.text, 0, 0);
            }
            ctx.restore();
            continue;
          }
          if (hasRatio) {
            ctx.save();
            ctx.translate(x, y);
            ctx.scale(ratio, 1);
            ctx.fillText(cluster.text, 0, 0);
            if (strokeColor) {
              ctx.strokeText(cluster.text, 0, 0);
            }
            ctx.restore();
            continue;
          }
          ctx.fillText(cluster.text, x, y);
          if (strokeColor) {
            ctx.strokeText(cluster.text, x, y);
          }
        }
        ctx.restore();
      };

      if (emboss || engrave) {
        const offset = Math.max(fontSize / 20, 1);
        drawPass(-offset, -offset, emboss ? '#ffffff' : '#808080');
        drawPass(offset, offset, emboss ? '#808080' : '#ffffff');
        drawPass(0, 0, op.style.color);
      } else {
        if (shadowType > 0) {
          drawPass(shadowOffsetX, shadowOffsetY, shadowColor);
        }
        if (outlineType > 0) {
          drawPass(0, 0, '#ffffff', op.style.color, Math.max(fontSize / 25, 0.5));
        } else {
          drawPass(0, 0, op.style.color);
        }
      }

      if (emphasisDot > 0) {
        const dotSize = textDecorationEmphasisSize(fontSize);
        for (const position of positions.slice(0, -1)) {
          const markPosition = textDecorationEmphasisPosition(
            originX,
            originY,
            position,
            fontSize,
            ratio,
          );
          this.drawEmphasisMark(
            ctx,
            emphasisDot,
            markPosition.x,
            markPosition.y,
            dotSize,
            op.style.color,
          );
        }
      }

      if (op.legacyVisuals?.tabLeaders !== 'mirror' && op.tabLeaders?.length) {
        this.drawTabLeaders(ctx, op.tabLeaders, originX, originY, op.style.color);
      }

      if (!decorationsAreMirrors && op.style.underline !== 'none') {
        const y = textDecorationLineY('underline', op.style.underline, originY, fontSize);
        this.drawTextDecorationLine(
          ctx,
          originX,
          originX + textWidth,
          y,
          op.style.underlineColor || op.style.color,
          op.style.underlineShape,
        );
      }

      if (!decorationsAreMirrors && op.style.strikethrough) {
        const y = textDecorationLineY('strikethrough', undefined, originY, fontSize);
        this.drawTextDecorationLine(
          ctx,
          originX,
          originX + textWidth,
          y,
          op.style.strikeColor || op.style.color,
          op.style.strikeShape,
        );
      }

      drawControlMarks();
    };

    ctx.save();
    ctx.font = baseFont;
    ctx.textBaseline = 'alphabetic';
    const textRotation = op.rotation;
    if (textRotation !== 0) {
      const cx = op.bbox.x + op.bbox.width / 2;
      const cy = op.bbox.y + op.bbox.height / 2;
      ctx.translate(cx, cy);
      ctx.rotate((textRotation * Math.PI) / 180);
      drawClusters(-op.bbox.width / 2, -op.bbox.height / 2 + op.baseline + baselineShift);
    } else {
      drawClusters(op.bbox.x, op.bbox.y + op.baseline + baselineShift);
    }
    ctx.restore();
  }

  private renderCharOverlap(ctx: CanvasRenderingContext2D, op: LayerCharOverlapOp): void {
    const cx = op.bbox.x + op.bbox.width / 2;
    const cy = op.bbox.y + op.bbox.height / 2;
    ctx.save();
    if (op.rotation) {
      ctx.translate(cx, cy);
      ctx.rotate((op.rotation * Math.PI) / 180);
      ctx.translate(-cx, -cy);
    }
    drawCanvas2DCharOverlap(ctx, op, op.bbox.x, op.bbox.y + op.baseline);
    ctx.restore();
  }

  private renderTextControlMark(ctx: CanvasRenderingContext2D, op: LayerTextControlMarkOp): void {
    if (!allowsTextControlMark(
      this.currentShowParagraphMarks,
      this.currentShowControlCodes,
      op.mark.kind,
    )) {
      return;
    }
    ctx.save();
    ctx.fillStyle = '#4A90D9';
    this.setCanvasTextFont(ctx, TEXT_CONTROL_MARK_FONT_FAMILY, op.mark.fontSize, false, false);
    ctx.fillText(op.mark.text, op.bbox.x + op.mark.x, op.bbox.y + op.mark.y);
    ctx.restore();
  }

  private renderTabLeader(ctx: CanvasRenderingContext2D, op: LayerTabLeaderOp): void {
    this.drawTabLeaders(ctx, [op.leader], op.bbox.x, op.bbox.y + op.baseline, op.color);
  }

  private renderTextDecoration(ctx: CanvasRenderingContext2D, op: LayerTextDecorationOp): void {
    const drawDecoration = (originX: number, baselineY: number) => {
      const textWidth = op.decoration.positions.at(-1) ?? 0;
      if (op.decoration.kind === 'underline') {
        const y = textDecorationLineY('underline', op.decoration.underline, baselineY, op.decoration.fontSize);
        this.drawTextDecorationLine(
          ctx,
          originX,
          originX + textWidth,
          y,
          op.decoration.color,
          op.decoration.shape,
        );
        return;
      }
      if (op.decoration.kind === 'strikethrough') {
        const y = textDecorationLineY('strikethrough', undefined, baselineY, op.decoration.fontSize);
        this.drawTextDecorationLine(
          ctx,
          originX,
          originX + textWidth,
          y,
          op.decoration.color,
          op.decoration.shape,
        );
        return;
      }
      const dotSize = textDecorationEmphasisSize(op.decoration.fontSize);
      for (const position of op.decoration.positions.slice(0, -1)) {
        const markPosition = textDecorationEmphasisPosition(
          originX,
          baselineY,
          position,
          op.decoration.fontSize,
          op.decoration.ratio,
        );
        this.drawEmphasisMark(
          ctx,
          op.decoration.emphasisDot,
          markPosition.x,
          markPosition.y,
          dotSize,
          op.decoration.color,
        );
      }
    };

    ctx.save();
    if (op.decoration.rotation !== 0) {
      const cx = op.bbox.x + op.bbox.width / 2;
      const cy = op.bbox.y + op.bbox.height / 2;
      ctx.translate(cx, cy);
      ctx.rotate((op.decoration.rotation * Math.PI) / 180);
      ctx.translate(-cx, -cy);
    }
    drawDecoration(op.bbox.x, op.bbox.y + op.decoration.baseline);
    ctx.restore();
  }

  private drawEmphasisMark(
    ctx: CanvasRenderingContext2D,
    emphasisDot: number,
    x: number,
    baselineY: number,
    size: number,
    color: string,
  ): void {
    const geometry = textDecorationEmphasisGeometry(emphasisDot, size);
    if (!geometry.length) {
      return;
    }
    ctx.save();
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const primitive of geometry) {
      ctx.beginPath();
      if (primitive.kind === 'circle') {
        ctx.arc(x + primitive.x, baselineY + primitive.y, primitive.radius, 0, Math.PI * 2);
        if (primitive.paint === 'fill') {
          ctx.fill();
        } else {
          ctx.lineWidth = primitive.strokeWidth ?? 1;
          ctx.stroke();
        }
        continue;
      }
      ctx.lineWidth = primitive.strokeWidth;
      for (const command of primitive.commands) {
        if (command.kind === 'moveTo') {
          ctx.moveTo(x + command.x, baselineY + command.y);
        } else if (command.kind === 'lineTo') {
          ctx.lineTo(x + command.x, baselineY + command.y);
        } else {
          ctx.quadraticCurveTo(
            x + command.controlX,
            baselineY + command.controlY,
            x + command.x,
            baselineY + command.y,
          );
        }
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  private renderFootnoteMarker(ctx: CanvasRenderingContext2D, op: LayerFootnoteMarkerOp): void {
    ctx.save();
    this.setCanvasTextFont(ctx, op.fontFamily, op.fontSize, false, false);
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = op.color;
    ctx.fillText(op.text, op.bbox.x, op.bbox.y + op.bbox.height * 0.4);
    ctx.restore();
  }

  private renderLine(ctx: CanvasRenderingContext2D, op: LayerLineOp): void {
    this.withCanvasTransform(ctx, op.bbox, op.transform, () => {
      const width = Math.max(op.style.width, 0.5);
      const dx = op.x2 - op.x1;
      const dy = op.y2 - op.y1;
      const lineLength = Math.hypot(dx, dy);
      let lineX1 = op.x1;
      let lineY1 = op.y1;
      let lineX2 = op.x2;
      let lineY2 = op.y2;

      if (lineLength > 0) {
        const unitX = dx / lineLength;
        const unitY = dy / lineLength;
        if (op.style.startArrow !== 'none') {
          const [arrowWidth, arrowHeight] = calculateArrowDimensions(width, lineLength, op.style.startArrowSize);
          drawCanvasArrowHead(
            ctx,
            op.x1,
            op.y1,
            -unitX,
            -unitY,
            arrowWidth,
            arrowHeight,
            op.style.startArrow,
            op.style.color,
            width,
          );
          lineX1 += unitX * arrowWidth;
          lineY1 += unitY * arrowWidth;
        }
        if (op.style.endArrow !== 'none') {
          const [arrowWidth, arrowHeight] = calculateArrowDimensions(width, lineLength, op.style.endArrowSize);
          drawCanvasArrowHead(
            ctx,
            op.x2,
            op.y2,
            unitX,
            unitY,
            arrowWidth,
            arrowHeight,
            op.style.endArrow,
            op.style.color,
            width,
          );
          lineX2 -= unitX * arrowWidth;
          lineY2 -= unitY * arrowWidth;
        }
      }

      const drawSegment = (strokeWidth: number, offsetRatio: number) => {
        let offsetX = 0;
        let offsetY = 0;
        if (lineLength > 0 && offsetRatio !== 0) {
          const normalX = -dy / lineLength;
          const normalY = dx / lineLength;
          offsetX = normalX * width * offsetRatio;
          offsetY = normalY * width * offsetRatio;
        }
        ctx.save();
        this.applyCanvasShadow(ctx, op.style.shadow);
        ctx.strokeStyle = op.style.color;
        ctx.lineWidth = Math.max(strokeWidth, 0.5);
        ctx.setLineDash(strokeDashPattern(op.style.dash, strokeWidth));
        ctx.beginPath();
        ctx.moveTo(lineX1 + offsetX, lineY1 + offsetY);
        ctx.lineTo(lineX2 + offsetX, lineY2 + offsetY);
        ctx.stroke();
        ctx.restore();
      };

      switch (op.style.lineType) {
        case 'double':
          drawSegment(width * 0.3, -0.35);
          drawSegment(width * 0.3, 0.35);
          break;
        case 'thickThinDouble':
          drawSegment(width * 0.4, -0.30);
          drawSegment(width * 0.2, 0.40);
          break;
        case 'thinThickDouble':
          drawSegment(width * 0.2, -0.40);
          drawSegment(width * 0.4, 0.30);
          break;
        case 'thinThickThinTriple':
          drawSegment(width * 0.15, -0.425);
          drawSegment(width * 0.30, 0);
          drawSegment(width * 0.15, 0.425);
          break;
        default:
          drawSegment(width, 0);
      }
    });
  }

  private renderRectangle(ctx: CanvasRenderingContext2D, op: LayerRectangleOp): void {
    this.withCanvasTransform(ctx, op.bbox, op.transform, () => {
      const fill = this.makeShapeFillStyle(ctx, op.bbox, op.style.fillColor, op.gradient, op.style.pattern);
      const strokeWidth = Math.max(op.style.strokeWidth, 0.5);
      const beginPath = () => this.beginRectanglePath(ctx, op.bbox, op.cornerRadius);

      const draw = () => {
        beginPath();
        if (fill) {
          ctx.save();
          ctx.globalAlpha *= op.style.opacity;
          ctx.fillStyle = fill;
          ctx.fill();
          ctx.restore();
          beginPath();
        }
        if (op.style.strokeColor) {
          ctx.save();
          ctx.globalAlpha *= op.style.opacity;
          ctx.strokeStyle = op.style.strokeColor;
          ctx.lineWidth = strokeWidth;
          ctx.setLineDash(strokeDashPattern(op.style.strokeDash, strokeWidth));
          ctx.stroke();
          ctx.restore();
        }
      };

      if (op.style.shadow) {
        if (fill) {
          this.drawCanvasShapeShadow(
            ctx,
            op.style.shadow,
            op.style.opacity,
            'fill',
            strokeWidth,
            op.style.strokeDash,
            beginPath,
          );
        }
        if (op.style.strokeColor) {
          this.drawCanvasShapeShadow(
            ctx,
            op.style.shadow,
            op.style.opacity,
            'stroke',
            strokeWidth,
            op.style.strokeDash,
            beginPath,
          );
        }
      }
      draw();
    });
  }

  private renderEllipse(ctx: CanvasRenderingContext2D, op: LayerEllipseOp): void {
    this.withCanvasTransform(ctx, op.bbox, op.transform, () => {
      const fill = this.makeShapeFillStyle(ctx, op.bbox, op.style.fillColor, op.gradient, op.style.pattern);
      const strokeWidth = Math.max(op.style.strokeWidth, 0.5);
      const beginPath = () => {
        ctx.beginPath();
        ctx.ellipse(
          op.bbox.x + op.bbox.width / 2,
          op.bbox.y + op.bbox.height / 2,
          op.bbox.width / 2,
          op.bbox.height / 2,
          0,
          0,
          Math.PI * 2,
        );
      };

      const draw = () => {
        beginPath();
        if (fill) {
          ctx.save();
          ctx.globalAlpha *= op.style.opacity;
          ctx.fillStyle = fill;
          ctx.fill();
          ctx.restore();
          beginPath();
        }
        if (op.style.strokeColor) {
          ctx.save();
          ctx.globalAlpha *= op.style.opacity;
          ctx.strokeStyle = op.style.strokeColor;
          ctx.lineWidth = strokeWidth;
          ctx.setLineDash(strokeDashPattern(op.style.strokeDash, strokeWidth));
          ctx.stroke();
          ctx.restore();
        }
      };

      if (op.style.shadow) {
        if (fill) {
          this.drawCanvasShapeShadow(
            ctx,
            op.style.shadow,
            op.style.opacity,
            'fill',
            strokeWidth,
            op.style.strokeDash,
            beginPath,
          );
        }
        if (op.style.strokeColor) {
          this.drawCanvasShapeShadow(
            ctx,
            op.style.shadow,
            op.style.opacity,
            'stroke',
            strokeWidth,
            op.style.strokeDash,
            beginPath,
          );
        }
      }
      draw();
    });
  }

  private renderPath(ctx: CanvasRenderingContext2D, op: LayerPathOp): void {
    this.withCanvasTransform(ctx, op.bbox, op.transform, () => {
      const pathBounds = computePathPaintBounds(op.commands, op.bbox);
      const fill = this.makeShapeFillStyle(ctx, pathBounds, op.style.fillColor, op.gradient, op.style.pattern);
      const strokeWidth = Math.max(op.style.strokeWidth, 0.5);
      const beginPath = () => {
        ctx.beginPath();
        appendPathCommands(ctx, op.commands);
      };

      const draw = () => {
        beginPath();
        if (fill) {
          ctx.save();
          ctx.globalAlpha *= op.style.opacity;
          ctx.fillStyle = fill;
          ctx.fill();
          ctx.restore();
          beginPath();
        }
        if (op.style.strokeColor) {
          ctx.save();
          ctx.globalAlpha *= op.style.opacity;
          ctx.strokeStyle = op.style.strokeColor;
          ctx.lineWidth = strokeWidth;
          ctx.setLineDash(strokeDashPattern(op.style.strokeDash, strokeWidth));
          ctx.stroke();
          ctx.restore();
        }
      };

      if (op.style.shadow) {
        if (fill) {
          this.drawCanvasShapeShadow(
            ctx,
            op.style.shadow,
            op.style.opacity,
            'fill',
            strokeWidth,
            op.style.strokeDash,
            beginPath,
          );
        }
        if (op.style.strokeColor) {
          this.drawCanvasShapeShadow(
            ctx,
            op.style.shadow,
            op.style.opacity,
            'stroke',
            strokeWidth,
            op.style.strokeDash,
            beginPath,
          );
        }
      }
      draw();

      if (op.lineStyle && op.connectorEndpoints) {
        const { x1, y1, x2, y2 } = op.connectorEndpoints;
        const connectorLength = Math.max(Math.hypot(x2 - x1, y2 - y1), 1);

        if (op.lineStyle.startArrow !== 'none') {
          let directionX = x1 - x2;
          let directionY = y1 - y2;
          for (const command of op.commands.slice(1)) {
            if (command.type === 'lineTo') {
              if (Math.abs(x1 - command.x) > 0.5 || Math.abs(y1 - command.y) > 0.5) {
                directionX = x1 - command.x;
                directionY = y1 - command.y;
                break;
              }
              continue;
            }
            if (command.type === 'curveTo') {
              if (Math.abs(x1 - command.x1) > 0.5 || Math.abs(y1 - command.y1) > 0.5) {
                directionX = x1 - command.x1;
                directionY = y1 - command.y1;
                break;
              }
            }
          }
          const directionLength = Math.max(Math.hypot(directionX, directionY), 0.001);
          const [arrowWidth, arrowHeight] = calculateArrowDimensions(op.lineStyle.width, connectorLength, op.lineStyle.startArrowSize);
          drawCanvasArrowHead(
            ctx,
            x1,
            y1,
            directionX / directionLength,
            directionY / directionLength,
            arrowWidth,
            arrowHeight,
            op.lineStyle.startArrow,
            op.lineStyle.color,
            op.lineStyle.width,
          );
        }

        if (op.lineStyle.endArrow !== 'none') {
          const points: Array<[number, number]> = [];
          for (const command of op.commands) {
            if (command.type === 'moveTo' || command.type === 'lineTo') {
              points.push([command.x, command.y]);
              continue;
            }
            if (command.type === 'curveTo') {
              points.push([command.x2, command.y2]);
              points.push([command.x3, command.y3]);
            }
          }
          let directionX = x2 - x1;
          let directionY = y2 - y1;
          for (let index = points.length - 1; index >= 0; index -= 1) {
            const [pointX, pointY] = points[index];
            const candidateX = x2 - pointX;
            const candidateY = y2 - pointY;
            if (Math.abs(candidateX) > 0.5 || Math.abs(candidateY) > 0.5) {
              directionX = candidateX;
              directionY = candidateY;
              break;
            }
          }
          const directionLength = Math.max(Math.hypot(directionX, directionY), 0.001);
          const [arrowWidth, arrowHeight] = calculateArrowDimensions(op.lineStyle.width, connectorLength, op.lineStyle.endArrowSize);
          drawCanvasArrowHead(
            ctx,
            x2,
            y2,
            directionX / directionLength,
            directionY / directionLength,
            arrowWidth,
            arrowHeight,
            op.lineStyle.endArrow,
            op.lineStyle.color,
            op.lineStyle.width,
          );
        }
      }
    });
  }

  private renderImage(ctx: CanvasRenderingContext2D, op: LayerImageOp): void {
    const image = this.getDomImage(op.resourceId, op.base64);
    if (!image) {
      return;
    }

    const bbox = effectiveLayerImageBounds(op.bbox, op.transform);
    this.withCanvasTransform(ctx, bbox, op.transform, () => {
      const { width: imageWidth, height: imageHeight } = layerCanvasImageSourceSize(image);
      const effectCropSource = canPreprocessCroppedLayerImageEffect(op.fillMode)
        ? resolveLayerImageCropSource(imageWidth, imageHeight, op.crop, op.originalSizeHu)
        : null;
      const source = applyLayerImageEffect(
        image,
        op.effect,
        this.imageEffectCache,
        this.imageEffectDiagnostics,
        effectCropSource,
        op.brightness ?? 0,
        op.contrast ?? 0,
      );
      this.drawDomImage(
        ctx,
        source,
        bbox,
        op.fillMode,
        op.originalSize,
        source !== image && effectCropSource ? undefined : op.crop,
        source !== image,
        op.originalSizeHu,
      );
    });
  }

  private renderEquationSvgResource(ctx: CanvasRenderingContext2D, op: LayerEquationOp): boolean {
    const svgResourceId = op.svgResourceId;
    const fragment = typeof svgResourceId === 'number'
      ? this.currentResources?.svgFragments?.[svgResourceId]
      : op.svgContent;
    if (typeof fragment !== 'string') {
      return false;
    }
    const pathLayers = parseStaticSvgPathLayers(fragment);
    const textLayers = parseStaticSvgTextLayers(fragment);
    if (!staticSvgLayersHaveDrawableContent(pathLayers, textLayers)) {
      return false;
    }
    if (pathLayers.some((layer) => !isStaticSvgPathDataValid(layer.pathData))) {
      return false;
    }
    const { x, y, width, height } = op.bbox;
    if (
      !Number.isFinite(x)
      || !Number.isFinite(y)
      || !Number.isFinite(width)
      || !Number.isFinite(height)
      || width <= 0
      || height <= 0
    ) {
      return false;
    }

    ctx.save();
    try {
      ctx.translate(x, y);
      for (const layer of pathLayers) {
        ctx.save();
        try {
          if (layer.transform) {
            ctx.transform(
              layer.transform.a,
              layer.transform.b,
              layer.transform.c,
              layer.transform.d,
              layer.transform.e,
              layer.transform.f,
            );
          }
          const path = new Path2D(layer.pathData);
          const previousAlpha = ctx.globalAlpha;
          if (layer.fill !== null) {
            ctx.fillStyle = layer.fill;
            ctx.globalAlpha = previousAlpha * layer.opacity;
            ctx.fill(path, layer.fillRule ?? 'nonzero');
          }
          if (layer.stroke) {
            ctx.strokeStyle = layer.stroke.color;
            ctx.lineWidth = layer.stroke.width;
            ctx.lineJoin = layer.stroke.lineJoin;
            ctx.lineCap = layer.stroke.lineCap;
            ctx.miterLimit = layer.stroke.miterLimit;
            ctx.setLineDash(layer.stroke.dashArray ?? []);
            ctx.lineDashOffset = layer.stroke.dashOffset;
            ctx.globalAlpha = previousAlpha * layer.stroke.opacity;
            ctx.stroke(path);
          }
          ctx.globalAlpha = previousAlpha;
        } finally {
          ctx.restore();
        }
      }
      for (const layer of textLayers) {
        this.renderStaticSvgTextLayer(ctx, layer);
      }
    } finally {
      ctx.restore();
    }
    return true;
  }

  private renderStaticSvgTextLayer(ctx: CanvasRenderingContext2D, layer: StaticSvgTextLayer): void {
    ctx.save();
    try {
      if (layer.transform) {
        ctx.transform(
          layer.transform.a,
          layer.transform.b,
          layer.transform.c,
          layer.transform.d,
          layer.transform.e,
          layer.transform.f,
        );
      }
      const previousAlpha = ctx.globalAlpha;
      const family = /^(serif|sans-serif|monospace|cursive|fantasy)$/i.test(layer.fontFamily)
        ? layer.fontFamily
        : `"${layer.fontFamily.replace(/["\\]/g, '')}"`;
      ctx.font = `${layer.fontStyle === 'italic' ? 'italic ' : ''}${layer.fontWeight === 'bold' ? '700 ' : ''}${layer.fontSize}px ${family}`;
      ctx.textAlign = layer.textAnchor === 'middle' ? 'center' : layer.textAnchor === 'end' ? 'right' : 'left';
      ctx.textBaseline = layer.dominantBaseline === 'middle' ? 'middle' : 'alphabetic';
      ctx.fillStyle = layer.fill;
      ctx.globalAlpha = previousAlpha * layer.opacity;
      ctx.fillText(layer.text, layer.x, layer.y);
      ctx.globalAlpha = previousAlpha;
    } finally {
      ctx.restore();
    }
  }

  private renderFormObject(ctx: CanvasRenderingContext2D, op: LayerFormObjectOp): void {
    const { x, y, width: w, height: h } = op.bbox;
    const palette = formObjectPalette(op);
    ctx.save();

    switch (op.formType) {
      case 'pushButton': {
        ctx.fillStyle = palette.buttonBackColor;
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = palette.borderColor;
        ctx.lineWidth = 0.5;
        ctx.strokeRect(x, y, w, h);
        if (op.caption) {
          const fontSize = Math.min(Math.max(h * 0.5, 8), 12);
          ctx.font = `${fontSize}px sans-serif`;
          ctx.fillStyle = palette.foreColor;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(op.caption, x + w / 2, y + h / 2);
        }
        break;
      }
      case 'checkBox': {
        const boxSize = Math.min(h, 14);
        const boxY = y + (h - boxSize) / 2;
        ctx.fillStyle = palette.backColor;
        ctx.fillRect(x, boxY, boxSize, boxSize);
        ctx.strokeStyle = palette.borderColor;
        ctx.lineWidth = 1;
        ctx.strokeRect(x, boxY, boxSize, boxSize);
        if (op.value !== 0) {
          ctx.strokeStyle = palette.foreColor;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x + 2, boxY + boxSize / 2);
          ctx.lineTo(x + boxSize / 3, boxY + boxSize - 3);
          ctx.lineTo(x + boxSize - 2, boxY + 2);
          ctx.stroke();
        }
        if (op.caption) {
          const fontSize = Math.min(Math.max(h * 0.7, 8), 12);
          ctx.font = `${fontSize}px sans-serif`;
          ctx.fillStyle = palette.foreColor;
          ctx.textBaseline = 'middle';
          ctx.fillText(op.caption, x + boxSize + 4, y + h / 2);
        }
        break;
      }
      case 'radioButton': {
        const radius = Math.min(h, 14) / 2;
        const cx = x + radius;
        const cy = y + h / 2;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fillStyle = palette.backColor;
        ctx.fill();
        ctx.strokeStyle = palette.borderColor;
        ctx.lineWidth = 1;
        ctx.stroke();
        if (op.value !== 0) {
          ctx.beginPath();
          ctx.arc(cx, cy, radius * 0.5, 0, Math.PI * 2);
          ctx.fillStyle = palette.foreColor;
          ctx.fill();
        }
        if (op.caption) {
          const fontSize = Math.min(Math.max(h * 0.7, 8), 12);
          ctx.font = `${fontSize}px sans-serif`;
          ctx.fillStyle = palette.foreColor;
          ctx.textBaseline = 'middle';
          ctx.fillText(op.caption, x + radius * 2 + 4, y + h / 2);
        }
        break;
      }
      case 'comboBox': {
        const btnW = Math.min(h, 20);
        ctx.fillStyle = palette.backColor;
        ctx.fillRect(x, y, w - btnW, h);
        ctx.strokeStyle = palette.borderColor;
        ctx.lineWidth = 1;
        ctx.strokeRect(x, y, w - btnW, h);
        if (op.text) {
          const fontSize = Math.min(Math.max(h * 0.6, 8), 12);
          ctx.font = `${fontSize}px sans-serif`;
          ctx.fillStyle = palette.foreColor;
          ctx.textBaseline = 'middle';
          ctx.fillText(op.text, x + 2, y + h / 2);
        }
        const buttonX = x + w - btnW;
        ctx.fillStyle = palette.buttonFaceColor;
        ctx.fillRect(buttonX, y, btnW, h);
        ctx.strokeStyle = palette.borderColor;
        ctx.strokeRect(buttonX, y, btnW, h);
        ctx.beginPath();
        const triCx = buttonX + btnW / 2;
        const triCy = y + h / 2;
        const triSize = btnW * 0.3;
        ctx.moveTo(triCx - triSize, triCy - triSize / 2);
        ctx.lineTo(triCx + triSize, triCy - triSize / 2);
        ctx.lineTo(triCx, triCy + triSize / 2);
        ctx.closePath();
        ctx.fillStyle = palette.foreColor;
        ctx.fill();
        break;
      }
      case 'edit': {
        ctx.fillStyle = palette.backColor;
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = palette.borderColor;
        ctx.lineWidth = 1;
        ctx.strokeRect(x, y, w, h);
        if (op.text) {
          const fontSize = Math.min(Math.max(h * 0.6, 8), 12);
          ctx.font = `${fontSize}px sans-serif`;
          ctx.fillStyle = palette.foreColor;
          ctx.textBaseline = 'middle';
          ctx.fillText(op.text, x + 2, y + h / 2);
        }
        break;
      }
      default:
        break;
    }

    ctx.restore();
  }

  private drawTabLeaders(
    ctx: CanvasRenderingContext2D,
    leaders: LayerTabLeader[],
    originX: number,
    baselineY: number,
    color: string,
  ): void {
    for (const leader of leaders) {
      for (const segment of tabLeaderLineSegments(leader.fillType)) {
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = segment.width;
        ctx.lineCap = segment.cap;
        ctx.setLineDash(segment.dash);
        const y = baselineY + 1 + segment.offsetY;
        ctx.beginPath();
        ctx.moveTo(originX + leader.startX, y);
        ctx.lineTo(originX + leader.endX, y);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  private drawTextDecorationLine(
    ctx: CanvasRenderingContext2D,
    x1: number,
    x2: number,
    y: number,
    color: string,
    shape: number | undefined,
  ): void {
    for (const primitive of textDecorationLineGeometry(shape ?? 0)) {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = primitive.width;
      ctx.lineCap = primitive.kind === 'line' ? primitive.cap : 'butt';
      ctx.beginPath();
      if (primitive.kind === 'line') {
        ctx.setLineDash(primitive.dash);
        ctx.moveTo(x1, y + primitive.offsetY);
        ctx.lineTo(x2, y + primitive.offsetY);
      } else {
        const lineY = y + primitive.offsetY;
        ctx.moveTo(x1, lineY);
        let currentX = x1;
        let upward = true;
        while (currentX < x2) {
          const nextX = Math.min(currentX + primitive.wavelength, x2);
          ctx.quadraticCurveTo(
            (currentX + nextX) / 2,
            lineY + (upward ? -primitive.amplitude : primitive.amplitude),
            nextX,
            lineY,
          );
          currentX = nextX;
          upward = !upward;
        }
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  private setCanvasTextFont(
    ctx: CanvasRenderingContext2D,
    fontFamily: string,
    fontSize: number,
    bold: boolean,
    italic: boolean,
  ): void {
    ctx.font = buildCanvasTextFont(fontFamily, fontSize, bold, italic);
  }

  private drawDomImage(
    ctx: CanvasRenderingContext2D,
    image: LayerCanvasImageSource,
    bbox: LayerBounds,
    fillMode = 'fitToSize',
    originalSize?: { width: number; height: number },
    crop?: { left: number; top: number; right: number; bottom: number },
    forceNearestSampling = false,
    originalSizeHu?: [number, number],
  ): void {
    const { width: imageWidth, height: imageHeight } = layerCanvasImageSourceSize(image);
    if (!imageWidth || !imageHeight) {
      return;
    }
    if (
      !Number.isFinite(bbox.x)
      || !Number.isFinite(bbox.y)
      || !Number.isFinite(bbox.width)
      || !Number.isFinite(bbox.height)
      || bbox.width <= 0
      || bbox.height <= 0
    ) {
      return;
    }
    const cropSource = resolveLayerImageCropSource(
      imageWidth,
      imageHeight,
      crop,
      originalSizeHu,
    );
    const previousImageSmoothingEnabled = ctx.imageSmoothingEnabled;
    if (forceNearestSampling) {
      ctx.imageSmoothingEnabled = false;
    }
    const drawImage = (x: number, y: number, width: number, height: number) => {
      if (
        !Number.isFinite(x)
        || !Number.isFinite(y)
        || !Number.isFinite(width)
        || !Number.isFinite(height)
        || width <= 0
        || height <= 0
      ) {
        return;
      }
      if (cropSource) {
        ctx.drawImage(image, cropSource.x, cropSource.y, cropSource.width, cropSource.height, x, y, width, height);
        return;
      }
      ctx.drawImage(image, x, y, width, height);
    };

    try {
      if (fillMode === 'fitToSize' || fillMode === 'total' || fillMode === 'none') {
        drawImage(bbox.x, bbox.y, bbox.width, bbox.height);
        return;
      }

      let placedWidth = originalSize?.width ?? imageWidth;
      let placedHeight = originalSize?.height ?? imageHeight;
      if (
        !Number.isFinite(placedWidth)
        || !Number.isFinite(placedHeight)
        || placedWidth <= 0
        || placedHeight <= 0
      ) {
        placedWidth = imageWidth;
        placedHeight = imageHeight;
      }
      const { x, y } = resolveImagePlacement(fillMode, bbox, placedWidth, placedHeight);

      ctx.save();
      ctx.beginPath();
      ctx.rect(bbox.x, bbox.y, bbox.width, bbox.height);
      ctx.clip();

      if (fillMode === 'tileAll') {
        const maxTileDraws = 4096;
        let tileDraws = 0;
        for (let ty = bbox.y; ty < bbox.y + bbox.height && tileDraws < maxTileDraws; ty += placedHeight) {
          for (let tx = bbox.x; tx < bbox.x + bbox.width && tileDraws < maxTileDraws; tx += placedWidth) {
            drawImage(tx, ty, placedWidth, placedHeight);
            tileDraws += 1;
          }
        }
      } else if (fillMode === 'tileHorzTop' || fillMode === 'tileHorzBottom') {
        const maxTileDraws = 4096;
        let tileDraws = 0;
        const ty = fillMode === 'tileHorzTop' ? bbox.y : bbox.y + bbox.height - placedHeight;
        for (let tx = bbox.x; tx < bbox.x + bbox.width && tileDraws < maxTileDraws; tx += placedWidth) {
          drawImage(tx, ty, placedWidth, placedHeight);
          tileDraws += 1;
        }
      } else if (fillMode === 'tileVertLeft' || fillMode === 'tileVertRight') {
        const maxTileDraws = 4096;
        let tileDraws = 0;
        const tx = fillMode === 'tileVertLeft' ? bbox.x : bbox.x + bbox.width - placedWidth;
        for (let ty = bbox.y; ty < bbox.y + bbox.height && tileDraws < maxTileDraws; ty += placedHeight) {
          drawImage(tx, ty, placedWidth, placedHeight);
          tileDraws += 1;
        }
      } else {
        drawImage(x, y, placedWidth, placedHeight);
      }

      ctx.restore();
    } finally {
      ctx.imageSmoothingEnabled = previousImageSmoothingEnabled;
    }
  }

  private getDomImage(resourceId?: number, base64?: string): HTMLImageElement | null {
    const resourceBytes = typeof resourceId === 'number'
      ? this.currentResources?.images?.[resourceId]
      : undefined;
    const resourceHash = typeof resourceId === 'number'
      ? this.currentResources?.imageHashes?.[resourceId]
      : undefined;
    const cacheKey = resourceBytes
      ? `res:${this.currentResourceTableId ?? 'unknown'}:${resourceId}:${resourceHash ?? 'unknown'}`
      : base64
        ? `b64:${base64}`
        : null;
    if (!cacheKey) {
      return null;
    }

    const cached = this.domImageCache.get(cacheKey);
    if (cached) {
      return cached.complete && cached.naturalWidth > 0 ? cached : null;
    }

    const image = new Image();
    const bytes = resourceBytes ?? decodeBase64(base64 ?? '');
    const mimeType = inferImageMime(bytes);
    image.decoding = 'sync';
    image.onload = () => {
      if (this.asyncResourceReadyCallback && this.lastTargetCanvas?.parentElement) {
        this.asyncResourceReadyCallback();
        return;
      }
      if (this.rerenderScheduled || !this.lastRenderedTree || !this.lastTargetCanvas) {
        return;
      }
      this.rerenderScheduled = true;
      requestAnimationFrame(() => {
        this.rerenderScheduled = false;
        if (!this.lastRenderedTree || !this.lastTargetCanvas) {
          return;
        }
        this.renderPage(this.lastRenderedTree, this.lastTargetCanvas, this.lastScale);
      });
    };
    if (resourceBytes) {
      image.src = `data:${mimeType};base64,${encodeBase64(resourceBytes)}`;
    } else {
      image.src = `data:${mimeType};base64,${base64}`;
    }
    this.domImageCache.set(cacheKey, image);
    return image.complete && image.naturalWidth > 0 ? image : null;
  }

  dispose(): void {
    this.clearResourceImageCaches();
    this.domImageCache.clear();
    this.patternCache.clear();
    this.currentClipStack.length = 0;
    this.currentClipEnabled = true;
    this.lastRenderedTree = null;
    this.lastTargetCanvas = null;
    this.currentResources = null;
    this.currentResourceTableId = null;
    this.rerenderScheduled = false;
    this.asyncResourceReadyCallback = null;
  }

  private clearResourceImageCaches(): void {
    for (const [key, image] of this.domImageCache) {
      if (!key.startsWith('res:')) {
        continue;
      }
      image.onload = null;
      image.onerror = null;
      image.src = '';
      this.domImageCache.delete(key);
    }
  }

  private withCanvasTransform(
    ctx: CanvasRenderingContext2D,
    bbox: LayerBounds,
    transform: { rotation: number; horzFlip: boolean; vertFlip: boolean },
    draw: () => void,
  ): void {
    ctx.save();
    const { rotation, horzFlip, vertFlip } = transform;
    if (rotation || horzFlip || vertFlip) {
      const cx = bbox.x + bbox.width / 2;
      const cy = bbox.y + bbox.height / 2;
      if (horzFlip) {
        ctx.translate(cx * 2, 0);
        ctx.scale(-1, 1);
      }
      if (vertFlip) {
        ctx.translate(0, cy * 2);
        ctx.scale(1, -1);
      }
      if (rotation) {
        ctx.translate(cx, cy);
        ctx.rotate((rotation * Math.PI) / 180);
        ctx.translate(-cx, -cy);
      }
    }
    draw();
    ctx.restore();
  }

  private withCurrentOverlayClip(
    ctx: CanvasRenderingContext2D,
    padding: number,
    draw: () => void,
    bounds?: LayerBounds,
  ): void {
    if (this.currentClipStack.length === 0) {
      draw();
      return;
    }
    ctx.save();
    for (const clip of this.currentClipStack) {
      const clipBounds = clip.bounds;
      let leftPad = padding;
      let topPad = padding;
      let rightPad = padding;
      let bottomPad = padding;

      rightPad = Math.max(rightPad, clip.rightOverflowSlop);

      if (bounds) {
        if (bounds.x < clipBounds.x) {
          leftPad = Math.max(leftPad, 1);
        }
        if (bounds.y < clipBounds.y) {
          topPad = Math.max(topPad, 1);
        }
        if (bounds.x + bounds.width > clipBounds.x + clipBounds.width + rightPad) {
          rightPad = Math.max(
            rightPad,
            Math.ceil(bounds.x + bounds.width - (clipBounds.x + clipBounds.width)) + 1,
          );
        }
        if (bounds.y + bounds.height > clipBounds.y + clipBounds.height) {
          bottomPad = Math.max(bottomPad, 1);
        }
      }

      ctx.beginPath();
      ctx.rect(
        clipBounds.x - leftPad,
        clipBounds.y - topPad,
        clipBounds.width + leftPad + rightPad,
        clipBounds.height + topPad + bottomPad,
      );
      ctx.clip();
    }
    draw();
    ctx.restore();
  }

  private makeShapeFillStyle(
    ctx: CanvasRenderingContext2D,
    bounds: LayerBounds,
    fillColor: string | null | undefined,
    gradient?: LayerGradient,
    pattern?: LayerPatternFill,
  ): string | CanvasGradient | CanvasPattern | null {
    if (gradient) {
      const gradientStyle = this.makeGradientStyle(ctx, gradient, bounds);
      if (gradientStyle) {
        return gradientStyle;
      }
    }
    if (pattern) {
      const patternStyle = this.getPatternStyle(ctx, pattern);
      if (patternStyle) {
        return patternStyle;
      }
    }
    if (!fillColor) {
      return null;
    }
    return fillColor;
  }

  private makeGradientStyle(
    ctx: CanvasRenderingContext2D,
    gradient: LayerGradient,
    bounds: LayerBounds,
  ): CanvasGradient | null {
    if (gradient.colors.length < 2) {
      return null;
    }

    let canvasGradient: CanvasGradient;
    if (gradient.gradientType === 2 || gradient.gradientType === 3 || gradient.gradientType === 4) {
      const cx = bounds.x + bounds.width * (gradient.centerX / 100);
      const cy = bounds.y + bounds.height * (gradient.centerY / 100);
      const radius = Math.max(bounds.width, bounds.height) / 2;
      canvasGradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    } else {
      const [x0, y0, x1, y1] = angleToCanvasCoords(
        gradient.angle,
        bounds.x,
        bounds.y,
        bounds.width,
        bounds.height,
      );
      canvasGradient = ctx.createLinearGradient(x0, y0, x1, y1);
    }

    const stops = gradientColorStops(gradient.colors, gradient.positions);
    for (const stop of stops) {
      canvasGradient.addColorStop(stop.position, stop.color);
    }
    return canvasGradient;
  }

  private getPatternStyle(
    ctx: CanvasRenderingContext2D,
    pattern: LayerPatternFill,
  ): CanvasPattern | null {
    const cacheKey = `${pattern.patternType}:${pattern.patternColor}:${pattern.backgroundColor}`;
    if (this.patternCache.has(cacheKey)) {
      return this.patternCache.get(cacheKey) ?? null;
    }

    const tile = createPatternTileCanvas(pattern);
    const canvasPattern = ctx.createPattern(tile, 'repeat');
    this.patternCache.set(cacheKey, canvasPattern);
    return canvasPattern;
  }

  private applyCanvasShadow(
    ctx: CanvasRenderingContext2D,
    shadow: LayerShapeShadow | undefined,
  ): void {
    if (!shadow) {
      return;
    }
    ctx.shadowColor = applyCssAlpha(shadow.color, shadow.alpha > 0 ? 1 - (shadow.alpha / 255) : 1);
    ctx.shadowBlur = 1;
    ctx.shadowOffsetX = shadow.offsetX;
    ctx.shadowOffsetY = shadow.offsetY;
  }

  private drawCanvasShapeShadow(
    ctx: CanvasRenderingContext2D,
    shadow: LayerShapeShadow,
    sourceOpacity: number,
    style: 'fill' | 'stroke',
    strokeWidth: number,
    strokeDash: string,
    beginPath: () => void,
  ): void {
    ctx.save();
    ctx.translate(shadow.offsetX, shadow.offsetY);
    ctx.filter = 'blur(1px)';
    ctx.globalAlpha *= (shadow.alpha > 0 ? 1 - (shadow.alpha / 255) : 1) * sourceOpacity;
    beginPath();
    if (style === 'fill') {
      ctx.fillStyle = shadow.color;
      ctx.fill();
    } else {
      ctx.strokeStyle = shadow.color;
      ctx.lineWidth = strokeWidth;
      ctx.setLineDash(strokeDashPattern(strokeDash, strokeWidth));
      ctx.stroke();
    }
    ctx.restore();
  }

  private beginRectanglePath(
    ctx: CanvasRenderingContext2D,
    bounds: LayerBounds,
    cornerRadius: number,
  ): void {
    ctx.beginPath();
    if (cornerRadius <= 0) {
      ctx.rect(bounds.x, bounds.y, bounds.width, bounds.height);
      return;
    }
    const radius = Math.min(cornerRadius, bounds.width / 2, bounds.height / 2);
    ctx.moveTo(bounds.x + radius, bounds.y);
    ctx.lineTo(bounds.x + bounds.width - radius, bounds.y);
    ctx.quadraticCurveTo(bounds.x + bounds.width, bounds.y, bounds.x + bounds.width, bounds.y + radius);
    ctx.lineTo(bounds.x + bounds.width, bounds.y + bounds.height - radius);
    ctx.quadraticCurveTo(bounds.x + bounds.width, bounds.y + bounds.height, bounds.x + bounds.width - radius, bounds.y + bounds.height);
    ctx.lineTo(bounds.x + radius, bounds.y + bounds.height);
    ctx.quadraticCurveTo(bounds.x, bounds.y + bounds.height, bounds.x, bounds.y + bounds.height - radius);
    ctx.lineTo(bounds.x, bounds.y + radius);
    ctx.quadraticCurveTo(bounds.x, bounds.y, bounds.x + radius, bounds.y);
    ctx.closePath();
  }
}

function appendPathCommands(
  ctx: CanvasRenderingContext2D,
  commands: LayerPathCommand[],
): void {
  let currentX = 0;
  let currentY = 0;
  let subpathStartX = 0;
  let subpathStartY = 0;
  let hasCurrentPoint = false;
  for (const command of commands) {
    switch (command.type) {
      case 'moveTo':
        ctx.moveTo(command.x, command.y);
        currentX = command.x;
        currentY = command.y;
        subpathStartX = command.x;
        subpathStartY = command.y;
        hasCurrentPoint = true;
        break;
      case 'lineTo':
        ctx.lineTo(command.x, command.y);
        currentX = command.x;
        currentY = command.y;
        hasCurrentPoint = true;
        break;
      case 'curveTo':
        ctx.bezierCurveTo(
          command.x1,
          command.y1,
          command.x2,
          command.y2,
          command.x3,
          command.y3,
        );
        currentX = command.x3;
        currentY = command.y3;
        hasCurrentPoint = true;
        break;
      case 'arcTo': {
        if (!hasCurrentPoint) {
          ctx.moveTo(command.x, command.y);
          currentX = command.x;
          currentY = command.y;
          subpathStartX = command.x;
          subpathStartY = command.y;
          hasCurrentPoint = true;
          break;
        }
        const x1 = currentX;
        const y1 = currentY;
        const x2 = command.x;
        const y2 = command.y;
        if (Math.abs(x1 - x2) < 1e-6 && Math.abs(y1 - y2) < 1e-6) {
          currentX = x2;
          currentY = y2;
          break;
        }
        let rx = Math.abs(command.rx);
        let ry = Math.abs(command.ry);
        if (rx < 1e-6 || ry < 1e-6) {
          ctx.lineTo(x2, y2);
          currentX = x2;
          currentY = y2;
          break;
        }

        const phi = (command.rotation * Math.PI) / 180;
        const cosPhi = Math.cos(phi);
        const sinPhi = Math.sin(phi);
        const dx = (x1 - x2) / 2;
        const dy = (y1 - y2) / 2;
        const x1p = cosPhi * dx + sinPhi * dy;
        const y1p = -sinPhi * dx + cosPhi * dy;
        const x1p2 = x1p * x1p;
        const y1p2 = y1p * y1p;
        const lambda = x1p2 / (rx * rx) + y1p2 / (ry * ry);
        if (lambda > 1) {
          const scale = Math.sqrt(lambda);
          rx *= scale;
          ry *= scale;
        }
        const rx2 = rx * rx;
        const ry2 = ry * ry;
        const num = Math.max(0, rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2);
        const den = rx2 * y1p2 + ry2 * x1p2;
        const sq = den > 1e-10 ? Math.sqrt(num / den) : 0;
        const sign = command.largeArc === command.sweep ? -1 : 1;
        const cxp = sign * sq * rx * y1p / ry;
        const cyp = sign * sq * (-ry * x1p) / rx;
        const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
        const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;
        const theta1 = Math.atan2((y1p - cyp) / ry, (x1p - cxp) / rx);
        const theta2 = Math.atan2((-y1p - cyp) / ry, (-x1p - cxp) / rx);
        let dtheta = theta2 - theta1;
        if (!command.sweep && dtheta > 0) {
          dtheta -= Math.PI * 2;
        }
        if (command.sweep && dtheta < 0) {
          dtheta += Math.PI * 2;
        }
        const segmentCount = Math.max(1, Math.ceil(Math.abs(dtheta) / (Math.PI / 2 + 0.001)));
        const segmentAngle = dtheta / segmentCount;
        for (let index = 0; index < segmentCount; index += 1) {
          const t1 = theta1 + segmentAngle * index;
          const t2 = theta1 + segmentAngle * (index + 1);
          const alpha = (4 / 3) * Math.tan(segmentAngle / 4);
          const cosT1 = Math.cos(t1);
          const sinT1 = Math.sin(t1);
          const cosT2 = Math.cos(t2);
          const sinT2 = Math.sin(t2);
          const cp1x = rx * (cosT1 - alpha * sinT1);
          const cp1y = ry * (sinT1 + alpha * cosT1);
          const cp2x = rx * (cosT2 + alpha * sinT2);
          const cp2y = ry * (sinT2 - alpha * cosT2);
          const endX = rx * cosT2;
          const endY = ry * sinT2;
          ctx.bezierCurveTo(
            cosPhi * cp1x - sinPhi * cp1y + cx,
            sinPhi * cp1x + cosPhi * cp1y + cy,
            cosPhi * cp2x - sinPhi * cp2y + cx,
            sinPhi * cp2x + cosPhi * cp2y + cy,
            cosPhi * endX - sinPhi * endY + cx,
            sinPhi * endX + cosPhi * endY + cy,
          );
        }
        currentX = x2;
        currentY = y2;
        break;
      }
      case 'closePath':
        ctx.closePath();
        currentX = subpathStartX;
        currentY = subpathStartY;
        hasCurrentPoint = true;
        break;
    }
  }
}

function drawCanvasArrowHead(
  ctx: CanvasRenderingContext2D,
  tipX: number,
  tipY: number,
  directionX: number,
  directionY: number,
  arrowWidth: number,
  arrowHeight: number,
  arrowStyle: string,
  color: string,
  strokeWidth: number,
): void {
  const shape = arrowHeadShape(
    tipX,
    tipY,
    directionX,
    directionY,
    arrowWidth,
    arrowHeight,
    arrowStyle,
  );
  if (shape.kind === 'none') {
    return;
  }

  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(strokeWidth * 0.3, 0.5);

  if (shape.kind === 'polygon') {
    const [firstPoint, ...remainingPoints] = shape.points;
    ctx.beginPath();
    ctx.moveTo(firstPoint[0], firstPoint[1]);
    for (const [x, y] of remainingPoints) {
      ctx.lineTo(x, y);
    }
    ctx.closePath();
    if (shape.fill === 'solid') {
      ctx.fill();
    } else {
      ctx.save();
      ctx.fillStyle = 'white';
      ctx.fill();
      ctx.restore();
      ctx.stroke();
    }
    ctx.restore();
    return;
  }

  if (shape.kind === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse(shape.centerX, shape.centerY, shape.radiusX, shape.radiusY, 0, 0, Math.PI * 2);
    if (shape.fill === 'solid') {
      ctx.fill();
    } else {
      ctx.save();
      ctx.fillStyle = 'white';
      ctx.fill();
      ctx.restore();
      ctx.stroke();
    }
    ctx.restore();
    return;
  }
}

function applyCssAlpha(color: string, opacity: number): string {
  if (opacity >= 1) {
    return color;
  }
  const hex = color.trim();
  if (hex.startsWith('#')) {
    const normalized = hex.length === 4
      ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
      : hex;
    if (normalized.length === 7) {
      const r = Number.parseInt(normalized.slice(1, 3), 16);
      const g = Number.parseInt(normalized.slice(3, 5), 16);
      const b = Number.parseInt(normalized.slice(5, 7), 16);
      return `rgba(${r}, ${g}, ${b}, ${opacity})`;
    }
  }
  if (hex.startsWith('rgb(')) {
    return hex.replace(/^rgb\((.+)\)$/, `rgba($1, ${opacity})`);
  }
  if (hex.startsWith('rgba(')) {
    return hex.replace(/^rgba\((.+),\s*[^,]+\)$/, `rgba($1, ${opacity})`);
  }
  return color;
}
