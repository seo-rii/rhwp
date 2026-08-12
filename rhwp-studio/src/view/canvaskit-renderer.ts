import CanvasKitInit from 'canvaskit-wasm';
import type {
  CanvasKit,
  Font,
  Image,
  Paint,
  Paragraph,
  Path,
  PathBuilder,
  Shader,
  Surface,
  StrokeCap,
  StrokeJoin,
  TextBlob,
  Typeface,
  TypefaceFontProvider,
  WebGPUDeviceContext,
} from 'canvaskit-wasm';
import canvaskitWasmUrl from 'canvaskit-wasm/bin/canvaskit.wasm?url';

import {
  resolveRenderFontWeight,
  type RenderFontWeight,
} from '@/core/font-substitution';
import { OLD_HANGUL_FONT_FAMILY } from '@/core/font-loader';
import {
  hasStaticSanitizedSvgGlyphContract,
  hasStrictBitmapGlyphContract,
  isFillOnlyGlyphOutlineStyle,
  layerTextVariantOpsForLeaf,
  selectLayerTextVariantSets,
  selectLayerTextVariantSetsWithReport,
  shouldRenderLayerTextVariant,
  validateLayerTextV2Tree,
  type LayerTextVariantGroupReport,
  type LayerTextVariantReplayStatus,
  type LayerTextV2ValidationIssue,
} from '@/core/text-variants';
import { resolveLayerResourceIndex } from '@/core/layer-resource-store';
import { assertNeverLayerPaintOp } from '@/core/types';
import { DEFAULT_CANVASKIT_SURFACE_REQUEST } from '@/view/render-backend';
import type { CanvasKitRenderMode, CanvasKitSurfacePreference, CanvasKitSurfaceRequest } from '@/view/render-backend';
import { glyphOutlinePayloadStatus } from './glyph-outline-payload-status';
import type {
  LayerBounds,
  LayerCharOverlapOp,
  LayerCacheHint,
  LayerClipNode,
  LayerEllipseOp,
  LayerEquationLayoutBox,
  LayerEquationOp,
  LayerFormObjectOp,
  LayerGlyphOutlineOp,
  LayerGlyphRunOp,
  LayerGradient,
  LayerImageOp,
  LayerLeafNode,
  LayerLineOp,
  LayerNode,
  LayerPageBackgroundOp,
  LayerPaintOp,
  LayerPathCommand,
  LayerPathOp,
  LayerPatternFill,
  PageInfo,
  LayerRectangleOp,
  LayerRenderProfile,
  LayerShapeShadow,
  LayerTabLeader,
  LayerTabLeaderOp,
  LayerTextDecorationOp,
  LayerTextRunOp,
  LayerTextControlMarkOp,
  PageLayerTree,
} from '@/core/types';
import { isStaticSvgPathDataValid } from './static-svg-path-data';
import {
  parseStaticSvgPathLayers,
  parseStaticSvgTextLayers,
  staticSvgLayersHaveDrawableContent,
  type StaticSvgPathLayer,
  type StaticSvgTextLayer,
} from './static-svg-path-layers';
import { replayColorPaintGraph, resolvedColorUnitRgba } from './glyph-outline-color-graph-utils';
import { formObjectPalette } from './form-replay-utils';
import {
  canPreprocessCroppedLayerImageEffect,
  resolveLayerImageCropSource,
  type LayerImageEffectDiagnostics,
} from './image-effect-pixels';
import {
  angleToCanvasCoords,
  arrowHeadShape,
  calculateArrowDimensions,
  computePathPaintBounds,
  effectiveLayerImageBounds,
  gradientColorStops,
  resolveImagePlacement,
  strokeDashPattern,
} from './layer-geometry-utils';
import {
  TEXT_CONTROL_MARK_FONT_FAMILY,
  allowsTextControlMark,
  charOverlapInnerSizeRatio,
  containsOldHangulJamo,
  decodePuaOverlapNumber,
  estimateDisplayTextPositions,
  isHalfwidthScaledCluster,
  isStructureControlMark,
  mapPuaDisplayText,
  puaToDisplayText,
  splitIntoClusters,
  startsWithInvalidControl,
  tabLeaderLineSegments,
  textDecorationEmphasisGeometry,
  textDecorationEmphasisSize,
  textDecorationEmphasisPosition,
  textDecorationLineGeometry,
  textDecorationLineY,
  textScriptMetrics,
  verticalPresentationBaseText,
} from './text-replay-utils';
import {
  CanvasKitFontRegistry,
  HAMCHOROM_BATANG_FAMILY,
  type CanvasKitFontResolutionSource,
} from './canvaskit/fonts';
import { canvaskitClipRightPad } from './canvaskit/policy';
import { parseCanvasKitCssColor } from './canvaskit/css-color';
import {
  CANVASKIT_REPLAY_PLANES,
  type CanvasKitReplayPlane,
  layerPaintOpReplayPlane,
} from './canvaskit/replay-plane';
import {
  CanvasKitResourceCache,
  type CanvasKitImageDiagnostics,
  type CanvasKitImageRecoveryDiagnostic,
  type CanvasKitPatternDiagnostics,
} from './canvaskit/resource-cache';
import { CanvasKitStaticPictureCache } from './canvaskit/static-picture-cache';
import { CanvasKitSurfaceCache, type CanvasKitSurfaceDiagnostics } from './canvaskit/surface-cache';

const EQUATION_SCRIPT_SCALE = 0.7;
const EQUATION_BIG_OP_SCALE = 1.5;
const MAX_TEXT_BLOB_CACHE_ENTRIES = 4096;
const MAX_TEXT_FALLBACK_FAMILY_CACHE_ENTRIES = 4096;
const MAX_TEXT_FONT_SUBSTITUTION_DIAGNOSTICS = 4096;

type CanvasKitClipState = {
  bounds: LayerBounds;
  kind: LayerClipNode['clipKind'];
  rightOverflowSlop: number;
  allowHorizontalOverflowControls: boolean;
};

type CanvasKitTextReplayDiagnosticBase = {
  opId: string | null;
  fontFamily: string;
  clusterStartUtf16: number;
  clusterLengthUtf16: number;
};

export type CanvasKitTextReplayRecoveryDiagnostic = CanvasKitTextReplayDiagnosticBase & {
  reason: 'textBlobConstructionFailed';
  fallback: 'drawText';
};

export type CanvasKitTextReplayFailureDiagnostic = CanvasKitTextReplayDiagnosticBase & {
  reason: 'simpleTextFallbackFailed';
};

export type CanvasKitTextFontSubstitutionDiagnostic = {
  opId: string | null;
  requestedFamily: string;
  resolvedFamily: string;
  source: Exclude<CanvasKitFontResolutionSource, 'requestedAlias'>;
  kind: 'mappedAlias' | 'unregisteredFallback';
};

export type CanvasKitTextReplayDiagnostics = {
  constructionFailures: number;
  failureCacheHits: number;
  fallbackDraws: number;
  unregisteredFontFallbacks: number;
  fontSubstitutions: CanvasKitTextFontSubstitutionDiagnostic[];
  recoveries: CanvasKitTextReplayRecoveryDiagnostic[];
  failures: CanvasKitTextReplayFailureDiagnostic[];
};

export type CanvasKitEquationReplayReason =
  | 'svgReplayed'
  | 'layoutRequested'
  | 'svgResourceMissing'
  | 'svgPayloadUnsupported'
  | 'invalidEquationBounds'
  | 'svgPathDecodeFailed';

type CanvasKitEquationReplayIdentity = {
  svgResourceId: number | null;
  hasInlineSvg: boolean;
  bbox: LayerBounds;
};

type CanvasKitEquationReplayRouteResult =
  | { route: 'svg'; reason: 'svgReplayed' }
  | {
    route: 'layout';
    reason: Exclude<CanvasKitEquationReplayReason, 'svgReplayed'>;
  };

export type CanvasKitEquationReplayDiagnostic =
  CanvasKitEquationReplayIdentity & CanvasKitEquationReplayRouteResult;

export type CanvasKitEquationReplayDiagnostics = {
  svgReplays: number;
  layoutReplays: number;
  fallbackReplays: number;
  routes: CanvasKitEquationReplayDiagnostic[];
};

type CanvasKitEquationSvgReplayResult =
  | { replayed: true; reason: 'svgReplayed' }
  | {
    replayed: false;
    reason: Exclude<CanvasKitEquationReplayReason, 'svgReplayed'>;
  };

type CanvasKitStaticPictureMetadata = {
  equationReplayDiagnostics: CanvasKitEquationReplayDiagnostic[];
  imageRecoveryDiagnostics: CanvasKitImageRecoveryDiagnostic[];
  textFontSubstitutionDiagnostics: CanvasKitTextFontSubstitutionDiagnostic[];
};

type CanvasKitPreparedSvgGlyphPathLayer = {
  layer: StaticSvgPathLayer;
  path: Path;
};

type CanvasKitShapedSingleLine = {
  paragraph: Paragraph;
  width: number;
  height: number;
  alphabeticBaseline: number;
};

export class CanvasKitLayerRenderer {
  // Prevent pathological tiled fills from monopolizing the render loop.
  private static readonly MAX_IMAGE_TILE_DRAWS = 4096;
  // A text run is laid out as one unwrapped line at its producer-provided position.
  private static readonly MAX_SHAPED_TEXT_WIDTH = 1_000_000;

  private readonly resourceCache: CanvasKitResourceCache;
  private readonly surfaceCache: CanvasKitSurfaceCache;
  private readonly fontRegistry: CanvasKitFontRegistry;
  private readonly imageCache: Map<string, Image>;
  private readonly mipmappedImageCache: Map<string, Image>;
  private readonly patternImageCache: Map<string, Image | null>;
  private readonly fontAliases: Set<string>;
  private readonly staticPictureCache =
    new CanvasKitStaticPictureCache<CanvasKitStaticPictureMetadata>();
  private readonly textBlobCache = new Map<string, TextBlob>();
  private textBlobCacheHits = 0;
  private textBlobCacheMisses = 0;
  private readonly failedTextBlobCacheKeys = new Set<string>();
  private readonly textReplayRecoveryDiagnostics =
    new Map<string, CanvasKitTextReplayRecoveryDiagnostic>();
  private readonly textReplayFailureDiagnostics = new Map<string, CanvasKitTextReplayFailureDiagnostic>();
  private readonly textFontSubstitutionDiagnostics =
    new Map<string, CanvasKitTextFontSubstitutionDiagnostic>();
  private readonly equationReplayDiagnostics: CanvasKitEquationReplayDiagnostic[] = [];
  private textBlobConstructionFailures = 0;
  private textBlobFailureCacheHits = 0;
  private textBlobFallbackDraws = 0;
  private readonly textFallbackFamilyCache = new Map<string, string>();
  private textFallbackFamilyCacheHits = 0;
  private textFallbackFamilyCacheMisses = 0;
  private readonly currentClipStack: CanvasKitClipState[] = [];
  private readonly currentCacheHintStack: LayerCacheHint[] = [];
  private currentClipEnabled = true;
  private currentShowParagraphMarks = false;
  private currentShowControlCodes = false;
  private lastRenderedTree: PageLayerTree | null = null;
  private lastTargetCanvas: HTMLCanvasElement | null = null;
  private lastScale = 1;
  private currentProfile: LayerRenderProfile = 'screen';
  private currentLayerTreeCacheKey = 'none';
  private readonly textVariantSelectionDiagnostics: LayerTextVariantGroupReport[] = [];
  private readonly textV2ValidationDiagnostics: LayerTextV2ValidationIssue[] = [];
  private readonly preparedSvgGlyphPaths =
    new Map<LayerGlyphOutlineOp, readonly CanvasKitPreparedSvgGlyphPathLayer[] | null>();
  private disposed = false;

  private constructor(
    private readonly canvasKit: CanvasKit,
    private readonly fontProvider: TypefaceFontProvider,
    private readonly renderMode: CanvasKitRenderMode,
    surfaceRequest: CanvasKitSurfaceRequest,
    webgpuDeviceContext: WebGPUDeviceContext | null,
    webgpuInitFailure: string | null,
  ) {
    this.resourceCache = new CanvasKitResourceCache(canvasKit);
    this.surfaceCache = new CanvasKitSurfaceCache(
      canvasKit,
      surfaceRequest,
      webgpuDeviceContext,
      webgpuInitFailure,
    );
    this.fontRegistry = new CanvasKitFontRegistry(canvasKit, fontProvider);
    this.imageCache = this.resourceCache.imageCache;
    this.mipmappedImageCache = this.resourceCache.mipmappedImageCache;
    this.patternImageCache = this.resourceCache.patternImageCache;
    this.fontAliases = this.fontRegistry.aliases;
  }

  static async create(
    renderMode: CanvasKitRenderMode = 'default',
    surfaceRequest: CanvasKitSurfaceRequest | CanvasKitSurfacePreference = DEFAULT_CANVASKIT_SURFACE_REQUEST,
  ): Promise<CanvasKitLayerRenderer> {
    const canvasKit = await CanvasKitInit({
      locateFile: (file) => file === 'canvaskit.wasm' ? canvaskitWasmUrl : file,
    });
    const fontProvider = canvasKit.TypefaceFontProvider.Make();
    const resolvedSurfaceRequest = typeof surfaceRequest === 'string'
      ? {
          ...DEFAULT_CANVASKIT_SURFACE_REQUEST,
          preference: surfaceRequest,
          requested: surfaceRequest,
        }
      : surfaceRequest;
    let webgpuDeviceContext: WebGPUDeviceContext | null = null;
    let webgpuInitFailure: string | null = null;
    if (resolvedSurfaceRequest.preference === 'webgpu') {
      const canvasKitWebGpuFlag = (canvasKit as CanvasKit & { webgpu?: boolean }).webgpu;
      const gpu = typeof navigator === 'undefined' ? undefined : navigator.gpu;
      if (!canvasKitWebGpuFlag) {
        webgpuInitFailure = 'CanvasKit WebGPU build support unavailable';
      } else if (!gpu) {
        webgpuInitFailure = 'navigator.gpu unavailable';
      } else {
        try {
          const adapter = await gpu.requestAdapter();
          if (!adapter) {
            webgpuInitFailure = 'navigator.gpu.requestAdapter returned null';
          } else {
            const device = await adapter.requestDevice();
            webgpuDeviceContext = canvasKit.MakeGPUDeviceContext(device);
            if (!webgpuDeviceContext) {
              webgpuInitFailure = 'CanvasKit MakeGPUDeviceContext returned null';
            }
          }
        } catch (error) {
          webgpuInitFailure = error instanceof Error ? error.message : String(error);
        }
      }
    }
    const renderer = new CanvasKitLayerRenderer(
      canvasKit,
      fontProvider,
      renderMode,
      resolvedSurfaceRequest,
      webgpuDeviceContext,
      webgpuInitFailure,
    );
    await renderer.fontRegistry.registerFonts();
    return renderer;
  }

  async prepareLocalFonts(fontNames: readonly string[]): Promise<number> {
    if (this.disposed) return 0;
    const registered = await this.fontRegistry.prepareLocalFonts(fontNames);
    if (registered > 0) this.invalidateTextFontCaches();
    return registered;
  }

  renderPage(
    tree: PageLayerTree,
    targetCanvas: HTMLCanvasElement,
    scale: number,
  ): void {
    this.renderPageInternal(tree, targetCanvas, scale);
  }

  renderPageWithMarginGuides(
    tree: PageLayerTree,
    targetCanvas: HTMLCanvasElement,
    scale: number,
    pageInfo: PageInfo,
  ): void {
    this.renderPageInternal(tree, targetCanvas, scale, pageInfo);
  }

  private renderPageInternal(
    tree: PageLayerTree,
    targetCanvas: HTMLCanvasElement,
    scale: number,
    pageInfo?: PageInfo,
  ): void {
    if (this.disposed) {
      throw new Error('CanvasKit renderer가 이미 dispose되었습니다');
    }

    this.clearPreparedSvgGlyphPaths();
    try {
      this.lastRenderedTree = tree;
      this.lastTargetCanvas = targetCanvas;
      this.lastScale = scale;
      this.currentProfile = tree.profile;
      this.currentLayerTreeCacheKey = this.staticPictureCache.cacheKeyForLayerTree(tree);
      this.resourceCache.resetImageDiagnostics();
      this.resourceCache.beginPatternReplay();
      this.resetTextReplayDiagnostics();
      this.resetEquationReplayDiagnostics();
      this.resourceCache.setResources(tree.resources);
      this.fontRegistry.registerFontBlobsFromResources(tree.fontResources, tree.resources);
      this.currentClipEnabled = tree.outputOptions?.clipEnabled ?? true;
      this.currentShowParagraphMarks = tree.outputOptions?.showParagraphMarks ?? false;
      this.currentShowControlCodes = tree.outputOptions?.showControlCodes ?? false;
      this.currentClipStack.length = 0;
      this.currentCacheHintStack.length = 0;
      this.textVariantSelectionDiagnostics.length = 0;
      this.textV2ValidationDiagnostics.length = 0;
      this.textV2ValidationDiagnostics.push(...validateLayerTextV2Tree(tree));
      const pendingTextVariantNodes: LayerNode[] = [tree.root];
      while (pendingTextVariantNodes.length > 0) {
        const node = pendingTextVariantNodes.pop();
        if (!node) {
          continue;
        }
        switch (node.kind) {
          case 'group':
            pendingTextVariantNodes.push(...node.children);
            break;
          case 'clipRect':
            pendingTextVariantNodes.push(node.child);
            break;
          case 'leaf': {
            const ops = layerTextVariantOpsForLeaf(node.ops, tree.variantOps);
            const selection = selectLayerTextVariantSetsWithReport(
              ops,
              (op) => this.glyphRunVariantReplayStatus(op),
              (op) => this.glyphOutlineVariantReplayStatus(op),
              {
                backend: 'canvaskit',
                renderProfile: this.currentProfile,
              },
            );
            this.textVariantSelectionDiagnostics.push(...selection.reports);
            break;
          }
        }
      }

      const { surface, usedGpuSurface } = this.surfaceCache.get(targetCanvas);

      let renderError: unknown = null;
      try {
        this.renderSurface(surface, tree, scale, pageInfo);
      } catch (error) {
        renderError = error;
      }

      if (!renderError) {
        return;
      }

      if (!usedGpuSurface) {
        throw renderError;
      }

      const fallbackSurface = this.surfaceCache.replaceWithSoftware(targetCanvas);
      if (!fallbackSurface) {
        throw renderError;
      }

      this.resetEquationReplayDiagnostics();
      this.renderSurface(fallbackSurface, tree, scale, pageInfo);
    } finally {
      this.clearPreparedSvgGlyphPaths();
    }
  }

  drawMarginGuides(pageInfo: PageInfo, targetCanvas: HTMLCanvasElement, scale: number): void {
    if (this.disposed) {
      throw new Error('CanvasKit renderer가 이미 dispose되었습니다');
    }

    const { surface, usedGpuSurface } = this.surfaceCache.get(targetCanvas);
    let renderError: unknown = null;
    try {
      this.drawMarginGuidesOnSurface(surface, pageInfo, scale);
    } catch (error) {
      renderError = error;
    }

    if (!renderError) {
      return;
    }

    if (!usedGpuSurface) {
      throw renderError;
    }

    const fallbackSurface = this.surfaceCache.replaceWithSoftware(targetCanvas);
    if (!fallbackSurface) {
      throw renderError;
    }
    this.clearPreparedSvgGlyphPaths();
    try {
      if (this.lastRenderedTree) {
        this.renderSurface(fallbackSurface, this.lastRenderedTree, scale);
      }
      this.drawMarginGuidesOnSurface(fallbackSurface, pageInfo, scale);
    } finally {
      this.clearPreparedSvgGlyphPaths();
    }
  }

  setAsyncResourceReadyCallback(callback: (() => void) | null): void {
    this.resourceCache.setAsyncResourceReadyCallback(callback);
  }

  resetDocumentResources(): void {
    this.clearPreparedSvgGlyphPaths();
    this.staticPictureCache.clear();
    this.resourceCache.resetDocumentResources();
    this.fontRegistry.clearDocumentResources();
    this.lastRenderedTree = null;
    this.lastTargetCanvas = null;
    this.currentLayerTreeCacheKey = 'none';
    this.textVariantSelectionDiagnostics.length = 0;
    this.textV2ValidationDiagnostics.length = 0;
    this.equationReplayDiagnostics.length = 0;
    this.resetTextReplayDiagnostics();
  }

  getImageEffectDiagnostics(): Readonly<LayerImageEffectDiagnostics> {
    return this.resourceCache.getImageEffectDiagnostics();
  }

  getImageDiagnostics(): Readonly<CanvasKitImageDiagnostics> {
    return this.resourceCache.getImageDiagnostics();
  }

  getTextReplayDiagnostics(): Readonly<CanvasKitTextReplayDiagnostics> {
    const fontSubstitutions = [...this.textFontSubstitutionDiagnostics.values()]
      .map((substitution) => ({ ...substitution }));
    return {
      constructionFailures: this.textBlobConstructionFailures,
      failureCacheHits: this.textBlobFailureCacheHits,
      fallbackDraws: this.textBlobFallbackDraws,
      unregisteredFontFallbacks: fontSubstitutions.filter(
        (substitution) => substitution.kind === 'unregisteredFallback',
      ).length,
      fontSubstitutions,
      recoveries: [...this.textReplayRecoveryDiagnostics.values()]
        .map((recovery) => ({ ...recovery })),
      failures: [...this.textReplayFailureDiagnostics.values()].map((failure) => ({ ...failure })),
    };
  }

  getEquationReplayDiagnostics(): Readonly<CanvasKitEquationReplayDiagnostics> {
    const routes = this.equationReplayDiagnostics.map((diagnostic) => ({
      ...diagnostic,
      bbox: { ...diagnostic.bbox },
    }));
    return {
      svgReplays: routes.filter((diagnostic) => diagnostic.route === 'svg').length,
      layoutReplays: routes.filter((diagnostic) => diagnostic.route === 'layout').length,
      fallbackReplays: routes.filter(
        (diagnostic) =>
          diagnostic.route === 'layout'
          && diagnostic.reason !== 'layoutRequested',
      ).length,
      routes,
    };
  }

  getPatternDiagnostics(): Readonly<CanvasKitPatternDiagnostics> {
    return this.resourceCache.getPatternDiagnostics();
  }

  getSurfaceDiagnostics(): Readonly<CanvasKitSurfaceDiagnostics> {
    return this.surfaceCache.getDiagnostics();
  }

  resetImageEffectDiagnostics(): void {
    this.resourceCache.resetImageEffectDiagnostics();
  }

  resetImageDiagnostics(): void {
    this.resourceCache.resetImageDiagnostics();
  }

  resetTextReplayDiagnostics(): void {
    this.failedTextBlobCacheKeys.clear();
    this.textReplayRecoveryDiagnostics.clear();
    this.textReplayFailureDiagnostics.clear();
    this.textFontSubstitutionDiagnostics.clear();
    this.textBlobConstructionFailures = 0;
    this.textBlobFailureCacheHits = 0;
    this.textBlobFallbackDraws = 0;
  }

  resetEquationReplayDiagnostics(): void {
    this.equationReplayDiagnostics.length = 0;
  }

  resetPatternDiagnostics(): void {
    this.resourceCache.resetPatternDiagnostics();
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

  private renderSurface(
    surface: Surface,
    tree: PageLayerTree,
    scale: number,
    pageInfo?: PageInfo,
  ): void {
    const canvas = surface.getCanvas();
    canvas.clear(this.canvasKit.TRANSPARENT);
    canvas.save();
    canvas.scale(scale, scale);
    for (const replayPlane of CANVASKIT_REPLAY_PLANES) {
      this.renderNode(canvas, tree.root, replayPlane);
    }
    canvas.restore();
    if (pageInfo) {
      this.drawMarginGuidesOnCanvas(canvas, pageInfo, scale);
    }
    surface.flush();
  }

  private drawMarginGuidesOnSurface(surface: Surface, pageInfo: PageInfo, scale: number): void {
    const canvas = surface.getCanvas();
    this.drawMarginGuidesOnCanvas(canvas, pageInfo, scale);
    surface.flush();
  }

  private drawMarginGuidesOnCanvas(
    canvas: ReturnType<Surface['getCanvas']>,
    pageInfo: PageInfo,
    scale: number,
  ): void {
    const { width, height, marginLeft, marginRight, marginTop, marginBottom, marginHeader, marginFooter } = pageInfo;
    const left = marginLeft;
    const top = marginHeader + marginTop;
    const right = width - marginRight;
    const bottom = height - marginFooter - marginBottom;
    const markerLength = 15;
    const paint = this.makePaint('#C0C0C0', 'stroke');
    paint.setStrokeWidth(0.3);

    canvas.save();
    canvas.scale(scale, scale);
    try {
      canvas.drawLine(left, top - markerLength, left, top, paint);
      canvas.drawLine(left, top, left - markerLength, top, paint);

      canvas.drawLine(right + markerLength, top, right, top, paint);
      canvas.drawLine(right, top, right, top - markerLength, paint);

      canvas.drawLine(left - markerLength, bottom, left, bottom, paint);
      canvas.drawLine(left, bottom, left, bottom + markerLength, paint);

      canvas.drawLine(right, bottom + markerLength, right, bottom, paint);
      canvas.drawLine(right, bottom, right + markerLength, bottom, paint);
    } finally {
      canvas.restore();
      paint.delete();
    }
  }

  private renderNode(
    canvas: ReturnType<Surface['getCanvas']>,
    node: LayerNode,
    replayPlane: CanvasKitReplayPlane,
  ): void {
    switch (node.kind) {
      case 'group':
        this.withCacheHint(node.cacheHint, () => {
          if (node.cacheHint === 'staticSubtree') {
            let hasReplayPlane = false;
            const pendingNodes: LayerNode[] = [...node.children];
            while (pendingNodes.length > 0 && !hasReplayPlane) {
              const candidate = pendingNodes.pop();
              if (!candidate) {
                continue;
              }
              switch (candidate.kind) {
                case 'group':
                  pendingNodes.push(...candidate.children);
                  break;
                case 'clipRect':
                  pendingNodes.push(candidate.child);
                  break;
                case 'leaf':
                  for (const op of layerTextVariantOpsForLeaf(
                    candidate.ops,
                    this.lastRenderedTree?.variantOps,
                  )) {
                    if (layerPaintOpReplayPlane(op) === replayPlane) {
                      hasReplayPlane = true;
                      break;
                    }
                  }
                  break;
              }
            }
            if (!hasReplayPlane) {
              return;
            }
            const activeTree = this.lastRenderedTree;
            if (!activeTree) {
              throw new Error('CanvasKit static subtree replay requires an active layer tree');
            }

            const cacheKey = this.staticPictureCache.keyForStaticSubtree(
              this.currentLayerTreeCacheKey,
              this.currentProfile,
              replayPlane,
              node,
              activeTree,
            );
            const cachedPicture = this.staticPictureCache.get(cacheKey);
            if (cachedPicture) {
              const metadata = this.staticPictureCache.getMetadata(cacheKey);
              if (metadata) {
                this.resourceCache.restoreImageRecoveries(metadata.imageRecoveryDiagnostics);
                for (const diagnostic of metadata.textFontSubstitutionDiagnostics) {
                  this.recordTextFontSubstitutionDiagnostic({ ...diagnostic });
                }
                this.equationReplayDiagnostics.push(
                  ...metadata.equationReplayDiagnostics.map((diagnostic) => ({
                    ...diagnostic,
                    bbox: { ...diagnostic.bbox },
                  })),
                );
              }
              canvas.drawPicture(cachedPicture);
              return;
            }

            const equationDiagnosticsStart = this.equationReplayDiagnostics.length;
            const imageRecoveryEventsStart =
              this.resourceCache.getImageRecoveryEventCount();
            const imageFailureAttemptsBefore =
              this.resourceCache.getImageDiagnostics().failureAttempts;
            const pendingImageAccessesBefore =
              this.resourceCache.getImageDiagnostics().pendingAccesses;
            const imageEffectDiagnosticsBefore =
              this.resourceCache.getImageEffectDiagnostics();
            const patternFailuresBefore =
              this.resourceCache.getPatternDiagnostics().surfaceFailures;
            const textFailureAttemptsBefore =
              this.textBlobConstructionFailures + this.textBlobFailureCacheHits;
            const textFontSubstitutionKeysBefore =
              new Set(this.textFontSubstitutionDiagnostics.keys());
            const recorder = new this.canvasKit.PictureRecorder();
            try {
              const recordingCanvas = recorder.beginRecording(this.toRect(node.bounds), true);
              for (const child of node.children) {
                this.renderNode(recordingCanvas, child, replayPlane);
              }
              const picture = recorder.finishRecordingAsPicture();
              const imageDiagnostics = this.resourceCache.getImageDiagnostics();
              const imageEffectDiagnostics =
                this.resourceCache.getImageEffectDiagnostics();
              const patternDiagnostics = this.resourceCache.getPatternDiagnostics();
              const textFailureAttempts =
                this.textBlobConstructionFailures + this.textBlobFailureCacheHits;
              const hasRuntimeReplayFailure =
                imageDiagnostics.failureAttempts > imageFailureAttemptsBefore
                || imageEffectDiagnostics.preprocessFailures
                  > imageEffectDiagnosticsBefore.preprocessFailures
                || imageEffectDiagnostics.fallbackToOriginal
                  > imageEffectDiagnosticsBefore.fallbackToOriginal
                || patternDiagnostics.surfaceFailures > patternFailuresBefore
                || textFailureAttempts > textFailureAttemptsBefore;
              const hasPendingImageReplay =
                imageDiagnostics.pendingAccesses > pendingImageAccessesBefore;
              if (!hasRuntimeReplayFailure) {
                if (!hasPendingImageReplay) {
                  this.staticPictureCache.set(cacheKey, picture, {
                    imageRecoveryDiagnostics:
                      this.resourceCache.getImageRecoveriesSince(imageRecoveryEventsStart),
                    equationReplayDiagnostics: this.equationReplayDiagnostics
                      .slice(equationDiagnosticsStart)
                      .map((diagnostic) => ({
                        ...diagnostic,
                        bbox: { ...diagnostic.bbox },
                      })),
                    textFontSubstitutionDiagnostics:
                      [...this.textFontSubstitutionDiagnostics.entries()]
                        .filter(([key]) => !textFontSubstitutionKeysBefore.has(key))
                        .map(([, diagnostic]) => ({ ...diagnostic })),
                  });
                }
              }
              canvas.drawPicture(picture);
              if (hasRuntimeReplayFailure) {
                picture.delete();
              } else if (hasPendingImageReplay) {
                picture.delete();
              }
            } finally {
              recorder.delete();
            }
            return;
          }
          for (const child of node.children) {
            this.renderNode(canvas, child, replayPlane);
          }
        });
        break;
      case 'clipRect':
        this.renderClipNode(canvas, node, replayPlane);
        break;
      case 'leaf':
        this.withCacheHint(node.cacheHint, () => {
          this.renderLeafNode(canvas, node, replayPlane);
        });
        break;
    }
  }

  private withCacheHint(cacheHint: LayerCacheHint, render: () => void): void {
    this.currentCacheHintStack.push(cacheHint);
    try {
      render();
    } finally {
      this.currentCacheHintStack.pop();
    }
  }

  private hasActiveCacheHint(cacheHint: LayerCacheHint): boolean {
    return this.currentCacheHintStack.includes(cacheHint);
  }

  releaseLayerTree(tree: PageLayerTree): void {
    const released = this.staticPictureCache.releaseLayerTree(tree);
    if (!released) {
      return;
    }

    if (this.lastRenderedTree === tree) {
      this.lastRenderedTree = null;
      this.lastTargetCanvas = null;
      this.lastScale = 1;
      this.currentLayerTreeCacheKey = 'none';
    }
  }

  private renderClipNode(
    canvas: ReturnType<Surface['getCanvas']>,
    node: LayerClipNode,
    replayPlane: CanvasKitReplayPlane,
  ): void {
    if (!this.currentClipEnabled) {
      this.renderNode(canvas, node.child, replayPlane);
      return;
    }
    const clip = this.clipStateForNode(node);
    this.currentClipStack.push(clip);
    canvas.save();
    canvas.clipRect(
      this.canvasKit.XYWHRect(
        node.clip.x,
        node.clip.y,
        node.clip.width + clip.rightOverflowSlop,
        node.clip.height,
      ),
      this.canvasKit.ClipOp.Intersect,
      true,
    );
    this.renderNode(canvas, node.child, replayPlane);
    canvas.restore();
    this.currentClipStack.pop();
  }

  private clipStateForNode(node: LayerClipNode): CanvasKitClipState {
    return {
      bounds: node.clip,
      kind: node.clipKind,
      rightOverflowSlop: canvaskitClipRightPad(
        this.renderMode,
        this.currentProfile,
        node.clipKind,
        node.clipPolicy?.rightOverflowSlop,
      ),
      allowHorizontalOverflowControls: node.clipPolicy?.allowHorizontalOverflowControls ?? (node.clipKind === 'body'),
    };
  }

  private renderLeafNode(
    canvas: ReturnType<Surface['getCanvas']>,
    node: LayerLeafNode,
    replayPlane: CanvasKitReplayPlane,
  ): void {
    const ops = layerTextVariantOpsForLeaf(node.ops, this.lastRenderedTree?.variantOps);
    const selectedTextVariants = this.selectLayerTextVariantSets(ops);
    for (const op of ops) {
      if (layerPaintOpReplayPlane(op) !== replayPlane) {
        continue;
      }
      if (!shouldRenderLayerTextVariant(op, selectedTextVariants)) {
        continue;
      }
      this.renderOp(canvas, op);
    }
  }

  private canReplayGlyphRun(op: LayerGlyphRunOp): boolean {
    return this.fontRegistry.glyphRunReplayStatus(
      op,
      this.lastRenderedTree?.fontResources,
    ).replayable;
  }

  private selectLayerTextVariantSets(ops: readonly LayerPaintOp[]): ReturnType<typeof selectLayerTextVariantSets> {
    return selectLayerTextVariantSets(
      ops,
      (op) => this.canReplayGlyphRun(op),
      (op) => this.glyphOutlineVariantReplayStatus(op).replayable,
    );
  }

  private glyphRunVariantReplayStatus(op: LayerGlyphRunOp): LayerTextVariantReplayStatus {
    const status = this.fontRegistry.glyphRunReplayStatus(op, this.lastRenderedTree?.fontResources);
    return {
      replayable: status.replayable,
      reason: status.replayable ? undefined : status.reason,
      fontVerification: {
        faceKey: status.replayable ? status.face.id : op.shapeKey.fontInstance.faceKey,
        blobKey: status.replayable ? status.blob.id : undefined,
        portability: status.report.replayEligibility,
        expectedDigest: status.replayable ? status.blob.digest?.value : undefined,
        blobResolved: status.replayable ? true : undefined,
        digestMatched: status.report.digestMatched,
        exactFaceInstantiated: status.report.exactFaceInstantiated,
        faceIndexSupported: status.report.faceIndexSupported,
        variationSupported: status.report.variationSupported,
        effectSupported: status.report.effectSupported,
        replayEligible: status.replayable,
        reason: status.replayable ? undefined : status.reason,
      },
    };
  }

  private prepareSvgGlyphPaths(
    op: LayerGlyphOutlineOp,
  ): readonly CanvasKitPreparedSvgGlyphPathLayer[] | null {
    if (this.preparedSvgGlyphPaths.has(op)) {
      return this.preparedSvgGlyphPaths.get(op) ?? null;
    }

    const vectorIndex = resolveLayerResourceIndex(
      op.svgGlyph?.vectorResourceId,
      this.lastRenderedTree?.resources?.svgKeys,
      this.lastRenderedTree?.resources?.svgFragments.length ?? 0,
    );
    const fragment = vectorIndex === undefined
      ? undefined
      : this.lastRenderedTree?.resources?.svgFragments?.[vectorIndex];
    const layers = typeof fragment === 'string'
      ? parseStaticSvgPathLayers(fragment)
      : [];
    if (layers.length === 0) {
      this.preparedSvgGlyphPaths.set(op, null);
      return null;
    }

    const prepared: CanvasKitPreparedSvgGlyphPathLayer[] = [];
    for (const layer of layers) {
      let path: Path | null = null;
      try {
        path = this.canvasKit.Path.MakeFromSVGString(layer.pathData);
      } catch {
        path = null;
      }
      if (!path) {
        for (const decoded of prepared) {
          decoded.path.delete();
        }
        this.preparedSvgGlyphPaths.set(op, null);
        return null;
      }
      prepared.push({ layer, path });
    }

    this.preparedSvgGlyphPaths.set(op, prepared);
    return prepared;
  }

  private clearPreparedSvgGlyphPaths(): void {
    for (const prepared of this.preparedSvgGlyphPaths.values()) {
      for (const decoded of prepared ?? []) {
        decoded.path.delete();
      }
    }
    this.preparedSvgGlyphPaths.clear();
  }

  private glyphOutlineVariantReplayStatus(op: LayerGlyphOutlineOp): LayerTextVariantReplayStatus {
    const payloadStatus = glyphOutlinePayloadStatus(
      op,
      this.lastRenderedTree?.resources,
    );
    let payloadSupported = op.diagnostics.strictVisualEligible && payloadStatus.supported;
    let payloadDetails = payloadStatus.details;
    if (payloadSupported && op.payloadKind === 'bitmapGlyph') {
      const imageIndex = resolveLayerResourceIndex(
        op.bitmapGlyph?.imageResourceId,
        this.lastRenderedTree?.resources?.imageKeys,
        this.lastRenderedTree?.resources?.images.length ?? 0,
      );
      let imageDecodable = false;
      if (imageIndex !== undefined) {
        try {
          imageDecodable = this.resourceCache.image(imageIndex) !== null;
        } catch {
          imageDecodable = false;
        }
      }
      if (!imageDecodable) {
        payloadSupported = false;
        payloadDetails = 'imageDecodeFailed';
      }
    }
    if (payloadSupported && op.payloadKind === 'svgGlyph') {
      if (!this.prepareSvgGlyphPaths(op)) {
        payloadSupported = false;
        payloadDetails = 'pathDecodeFailed';
      }
    }
    const paintStyleSupported = isFillOnlyGlyphOutlineStyle(op);
    const replayable = payloadSupported && paintStyleSupported;
    let reason: LayerTextVariantReplayStatus['reason'];
    if (!payloadSupported) {
      reason = payloadStatus.reason;
    } else if (!paintStyleSupported) {
      reason = 'unsupportedPaintEffect';
    }
    return {
      replayable,
      reason,
      details: payloadDetails,
      outlineEligibility: {
        strictVisualEligible: op.diagnostics.strictVisualEligible,
        payloadSupported,
        paintStyleSupported,
        replayEligible: replayable,
        reason,
      },
    };
  }

  private renderOp(
    canvas: ReturnType<Surface['getCanvas']>,
    op: LayerPaintOp,
  ): void {
    switch (op.type) {
      case 'pageBackground':
        this.renderPageBackground(canvas, op);
        return;
      case 'text':
        // Schema v2 Text ops are expanded into concrete variant payloads before
        // CanvasKit replay. A raw container is metadata only here.
        return;
      case 'textRun':
        this.renderTextRun(canvas, op);
        return;
      case 'glyphRun':
        this.renderGlyphRun(canvas, op);
        return;
      case 'glyphOutline':
        this.renderGlyphOutline(canvas, op);
        return;
      case 'charOverlap':
        this.renderTextRun(canvas, op);
        return;
      case 'textControlMark':
        this.renderTextControlMark(canvas, op);
        return;
      case 'tabLeader':
        this.renderTabLeader(canvas, op);
        return;
      case 'textDecoration':
        this.renderTextDecoration(canvas, op);
        return;
      case 'footnoteMarker':
        this.renderFootnoteMarker(canvas, op);
        return;
      case 'line':
        this.renderLine(canvas, op);
        return;
      case 'rectangle':
        this.renderRectangle(canvas, op);
        return;
      case 'ellipse':
        this.renderEllipse(canvas, op);
        return;
      case 'path':
        this.renderPath(canvas, op);
        return;
      case 'image':
        this.renderImage(canvas, op);
        return;
      case 'equation':
        this.renderEquation(canvas, op);
        return;
      case 'formObject':
        this.renderFormObject(canvas, op);
        return;
      default:
        assertNeverLayerPaintOp(op);
    }
  }

  private renderPageBackground(canvas: ReturnType<Surface['getCanvas']>, op: LayerPageBackgroundOp): void {
    const fill = this.makeShapeFillPaint(op.bbox, op.backgroundColor ?? null, 1, op.gradient);
    if (fill) {
      canvas.drawRect(this.toRect(op.bbox), fill.paint);
      fill.shader?.delete();
      fill.paint.delete();
    }

    if (op.image) {
      this.drawEncodedImage(
        canvas,
        op.image.resourceId,
        op.image.base64,
        op.bbox,
        op.image.fillMode,
        undefined,
        undefined,
        op.image.effect,
        op.image.brightness ?? 0,
        op.image.contrast ?? 0,
        undefined,
        op.image.opacity ?? 1,
      );
    }

    if (op.borderColor && op.borderWidth > 0) {
      const paint = this.makePaint(op.borderColor, 'stroke');
      paint.setStrokeWidth(Math.max(op.borderWidth, 0.5));
      canvas.drawRect(this.toRect(op.bbox), paint);
      paint.delete();
    }
  }

  private renderTextRun(
    canvas: ReturnType<Surface['getCanvas']>,
    op: LayerTextRunOp | LayerCharOverlapOp,
  ): void {
    const opId = 'id' in op && typeof op.id === 'string' ? op.id : null;
    const primaryFontResolution = this.fontRegistry.resolveFamilyWithStatus(op.style.fontFamily);
    if (primaryFontResolution.source !== 'requestedAlias') {
      const kind = primaryFontResolution.source === 'fallbackCandidate'
        || primaryFontResolution.source === 'defaultFallback'
        ? 'unregisteredFallback'
        : 'mappedAlias';
      const diagnostic: CanvasKitTextFontSubstitutionDiagnostic = {
        opId,
        requestedFamily: primaryFontResolution.requestedFamily,
        resolvedFamily: primaryFontResolution.resolvedFamily,
        source: primaryFontResolution.source,
        kind,
      };
      this.recordTextFontSubstitutionDiagnostic(diagnostic);
    }
    const baseFontSize = op.style.fontSize || 12;
    const { fontSize, baselineShift } = textScriptMetrics(
      baseFontSize,
      op.style.superscript,
      op.style.subscript,
    );
    const ratio = typeof op.style.ratio === 'number' && op.style.ratio > 0 ? op.style.ratio : 1;
    const hasRatio = Math.abs(ratio - 1) > 0.01;
    const outlineType = op.style.outlineType ?? 0;
    const shadowType = op.style.shadowType ?? 0;
    const shadowColor = typeof op.style.shadowColor === 'string' ? op.style.shadowColor : op.style.color;
    const shadowOffsetX = typeof op.style.shadowOffsetX === 'number' ? op.style.shadowOffsetX : 0;
    const shadowOffsetY = typeof op.style.shadowOffsetY === 'number' ? op.style.shadowOffsetY : 0;
    const emboss = !!op.style.emboss;
    const engrave = !!op.style.engrave;
    const decorationsAreMirrors = 'legacyVisuals' in op && op.legacyVisuals?.decorations === 'mirror';
    const emphasisDot = decorationsAreMirrors ? 0 : (op.style.emphasisDot ?? 0);
    const shadeColor = (typeof op.style.shadeColor === 'string' ? op.style.shadeColor : '#ffffff').toLowerCase();
    const primaryPaint = this.makePaint(op.style.color, 'fill');
    const text = 'displayText' in op && typeof op.displayText === 'string'
      ? op.displayText
      : mapPuaDisplayText(op.text);
    const positions = 'displayPositions' in op && Array.isArray(op.displayPositions)
      ? op.displayPositions
      : text === op.text ? op.positions : estimateDisplayTextPositions(text, op.style);
    const clusters = splitIntoClusters(text);
    const clusterReplayTexts = clusters.map((cluster) => (
      op.orientation === 'vertical-upright'
        ? verticalPresentationBaseText(cluster.text) ?? cluster.text
        : cluster.text
    ));
    const clusterUsesVerticalPresentationFallback = clusterReplayTexts.map(
      (replayText, index) => replayText !== clusters[index].text,
    );
    const textObjectsByFamily = new Map<string, { typeface: Typeface; font: Font; paint: Paint }>();
    const fallbackFamilies = [
      op.style.fontFamily,
      OLD_HANGUL_FONT_FAMILY,
      'Noto Sans KR ExtraLight',
      'Noto Sans KR',
      'Noto Sans CJK KR',
      'NanumGothic',
      'D2Coding',
      'NanumGothicCoding',
      'Noto Serif KR',
      'Noto Serif CJK KR',
    ].filter((family, index, all) => all.indexOf(family) === index);
    const clusterFonts: Array<Font | null> = [];
    const clusterFontFamilies: string[] = [];
    const clusterFontKeys: string[] = [];
    const resolvedPrimaryFamily = primaryFontResolution.resolvedFamily;
    const renderFontWeight = resolveRenderFontWeight(op.style.fontFamily, op.style.bold);
    for (const [clusterIndex, cluster] of clusters.entries()) {
      const replayText = clusterReplayTexts[clusterIndex];
      let selectedFont: Font | null = null;
      let selectedFontFamily = op.style.fontFamily;
      const codePoint = cluster.text.codePointAt(0) ?? 0;
      const needsCurrencyFallback =
        codePoint === 0x20A9 || codePoint === 0x20AC || codePoint === 0x00A3 || codePoint === 0x00A5;
      const needsSymbolFallback =
        (codePoint >= 0x2460 && codePoint <= 0x24FF)
        || (codePoint >= 0x25A0 && codePoint <= 0x25FF)
        || (codePoint >= 0x2600 && codePoint <= 0x27BF);
      const needsSupplementaryFallback = codePoint > 0xffff;
      const needsOldHangulFallback = containsOldHangulJamo(cluster.text);
      const preferredFallbackFamilies = needsOldHangulFallback
        ? [OLD_HANGUL_FONT_FAMILY]
        : needsCurrencyFallback
          ? ['Malgun Gothic', '맑은 고딕', 'Noto Sans KR']
          : needsSymbolFallback
            ? ['GulimChe', '굴림체', 'D2Coding', 'NanumGothicCoding', 'Noto Sans Mono']
            : needsSupplementaryFallback
              ? ['Latin Modern Math']
              : [];
      const fallbackClass = needsOldHangulFallback
        ? 'oldHangul'
        : needsCurrencyFallback
          ? 'currency'
          : needsSymbolFallback
            ? 'symbol'
            : needsSupplementaryFallback
              ? 'supplementary'
              : 'general';
      const cacheFallbackClass = clusterUsesVerticalPresentationFallback[clusterIndex]
        ? 'verticalPresentation'
        : fallbackClass;
      const familyCacheKey = JSON.stringify([
        resolvedPrimaryFamily,
        renderFontWeight,
        op.style.italic ? 'italic' : 'upright',
        cacheFallbackClass,
        cluster.text,
      ]);
      const cachedFamily = this.textFallbackFamilyCache.get(familyCacheKey);
      if (cachedFamily !== undefined) {
        this.textFallbackFamilyCacheHits += 1;
        this.textFallbackFamilyCache.delete(familyCacheKey);
        this.textFallbackFamilyCache.set(familyCacheKey, cachedFamily);
        selectedFontFamily = cachedFamily;
      } else {
        this.textFallbackFamilyCacheMisses += 1;
        let primaryObjects = textObjectsByFamily.get(op.style.fontFamily);
        if (!primaryObjects) {
          primaryObjects = this.makeTextObjects(
            op.style.fontFamily,
            fontSize,
            op.style.bold,
            op.style.italic,
            op.style.color,
            1,
            renderFontWeight,
          );
          textObjectsByFamily.set(op.style.fontFamily, primaryObjects);
        }
        selectedFont = primaryObjects.font;
        const primaryGlyphs = primaryObjects.font.getGlyphIDs(replayText);
        const primaryGlyphMissing = primaryGlyphs?.some((glyphId) => glyphId === 0) ?? true;
        if (needsOldHangulFallback || needsCurrencyFallback || needsSymbolFallback || primaryGlyphMissing) {
          const candidateFamilies = [...preferredFallbackFamilies, ...fallbackFamilies]
            .filter((family, index, all) => all.indexOf(family) === index);
          for (const family of candidateFamilies) {
            let candidate = textObjectsByFamily.get(family);
            if (!candidate) {
              candidate = this.makeTextObjects(
                family,
                fontSize,
                op.style.bold,
                op.style.italic,
                op.style.color,
                1,
                renderFontWeight,
              );
              textObjectsByFamily.set(family, candidate);
            }
            const candidateGlyphs = candidate.font.getGlyphIDs(replayText);
            if (candidateGlyphs && candidateGlyphs.every((glyphId) => glyphId !== 0)) {
              selectedFont = candidate.font;
              selectedFontFamily = family;
              break;
            }
          }
        }
        this.textFallbackFamilyCache.set(familyCacheKey, selectedFontFamily);
        if (this.textFallbackFamilyCache.size > MAX_TEXT_FALLBACK_FAMILY_CACHE_ENTRIES) {
          const oldestKey = this.textFallbackFamilyCache.keys().next().value;
          if (oldestKey !== undefined) {
            this.textFallbackFamilyCache.delete(oldestKey);
          }
        }
      }
      const clusterFontKey = [
        this.fontRegistry.resolveProviderFamily(
          selectedFontFamily,
          renderFontWeight,
          op.style.italic,
        ),
        fontSize.toFixed(3),
        renderFontWeight,
        op.style.italic ? 'italic' : 'upright',
      ].join('|');
      const skipsTextBlob = cluster.text === ' '
        || cluster.text === '\t'
        || cluster.text === '\u2007'
        || startsWithInvalidControl(cluster.text);
      if (
        !selectedFont
        && (
          clusterUsesVerticalPresentationFallback[clusterIndex]
          || (!skipsTextBlob && !this.textBlobCache.has(`${clusterFontKey}|${replayText}`))
        )
      ) {
        let selectedObjects = textObjectsByFamily.get(selectedFontFamily);
        if (!selectedObjects) {
          selectedObjects = this.makeTextObjects(
            selectedFontFamily,
            fontSize,
            op.style.bold,
            op.style.italic,
            op.style.color,
            1,
            renderFontWeight,
          );
          textObjectsByFamily.set(selectedFontFamily, selectedObjects);
        }
        selectedFont = selectedObjects.font;
      }
      clusterFonts.push(selectedFont);
      clusterFontFamilies.push(selectedFontFamily);
      clusterFontKeys.push(clusterFontKey);
    }
    const drawClusters = (originX: number, originY: number) => {
      const textWidth = positions.at(-1) ?? 0;
      const drawControlMarks = () => {
        if ('legacyVisuals' in op && op.legacyVisuals?.controlMarks === 'mirror') {
          return;
        }
        if (!('controlMarks' in op) || !op.controlMarks?.length) {
          return;
        }
        for (const mark of op.controlMarks) {
          if (!allowsTextControlMark(
            this.currentShowParagraphMarks,
            this.currentShowControlCodes,
            mark.kind,
          )) {
            continue;
          }
          const markObjects = this.makeTextObjects(
            TEXT_CONTROL_MARK_FONT_FAMILY,
            mark.fontSize,
            false,
            false,
            isStructureControlMark(mark.kind) ? '#CC3333' : '#4A90D9',
          );
          canvas.drawText(mark.text, originX + mark.x, originY + mark.y, markObjects.paint, markObjects.font);
          markObjects.paint.delete();
          markObjects.font.delete();
          markObjects.typeface.delete();
        }
      };

      if (op.charOverlap && (!('legacyVisuals' in op) || op.legacyVisuals?.charOverlap !== 'mirror')) {
        const chars = Array.from(op.text);
        if (chars.length) {
          const decodedNumber = decodePuaOverlapNumber(chars);
          const fontSize = op.style.fontSize || 12;
          const sizeRatio = charOverlapInnerSizeRatio(op.charOverlap.innerCharSize);
          const innerFontSize = fontSize * sizeRatio;
          const boxSize = fontSize;
          const bboxY = originY - op.baseline;
          const cy = bboxY + op.bbox.height - boxSize / 2;
          const drawOverlapCell = (
            display: string,
            cx: number,
            targetTextWidth?: number,
            drawShape = true,
          ) => {
            const borderType = targetTextWidth !== undefined && op.charOverlap?.borderType === 0
              ? 1
              : op.charOverlap?.borderType ?? 0;
            const isReversed = borderType === 2 || borderType === 4;
            const isCircle = borderType === 1 || borderType === 2;
            const isRect = borderType === 3 || borderType === 4;

            if (drawShape && (isCircle || isRect)) {
              const fillPaint = isReversed ? this.makePaint('#000000', 'fill') : null;
              const strokePaint = this.makePaint(isReversed ? '#000000' : op.style.color, 'stroke');
              strokePaint.setStrokeWidth(0.8);
              if (isCircle) {
                const ry = boxSize / 2;
                const rx = ry * 0.85;
                const oval = this.canvasKit.XYWHRect(cx - rx, cy - ry, rx * 2, ry * 2);
                if (fillPaint) {
                  canvas.drawOval(oval, fillPaint);
                }
                canvas.drawOval(oval, strokePaint);
              } else {
                const rect = this.canvasKit.XYWHRect(
                  cx - boxSize / 2,
                  cy - boxSize / 2,
                  boxSize,
                  boxSize,
                );
                if (fillPaint) {
                  canvas.drawRect(rect, fillPaint);
                }
                canvas.drawRect(rect, strokePaint);
              }
              fillPaint?.delete();
              strokePaint.delete();
            }

            const textObjects = this.makeTextObjects(
              op.style.fontFamily,
              innerFontSize,
              op.style.bold,
              op.style.italic,
              isReversed ? '#FFFFFF' : op.style.color,
            );
            const glyphIds = textObjects.font.getGlyphIDs(display);
            const glyphWidths = textObjects.font.getGlyphWidths(glyphIds) ?? [];
            const measuredWidth = glyphWidths.reduce((sum, width) => sum + width, 0);
            let drawWidth = measuredWidth;
            if (targetTextWidth !== undefined && targetTextWidth > 0 && measuredWidth > 0) {
              const scaleX = Math.min(1, targetTextWidth / measuredWidth);
              textObjects.font.setScaleX(scaleX);
              drawWidth = measuredWidth * scaleX;
            }
            const glyphBounds = textObjects.font.getGlyphBounds(glyphIds);
            let glyphTop = Number.POSITIVE_INFINITY;
            let glyphBottom = Number.NEGATIVE_INFINITY;
            for (let index = 1; index < glyphBounds.length; index += 4) {
              glyphTop = Math.min(glyphTop, glyphBounds[index]);
              glyphBottom = Math.max(glyphBottom, glyphBounds[index + 2]);
            }
            const metrics = textObjects.font.getMetrics();
            const middleBaselineOffset = Number.isFinite(glyphTop) && Number.isFinite(glyphBottom)
              ? -(glyphTop + glyphBottom) / 2
              : -(
                (metrics.ascent ?? -innerFontSize * 0.8)
                + (metrics.descent ?? innerFontSize * 0.2)
              ) / 2;
            const textY = (targetTextWidth !== undefined ? cy - fontSize * 0.08 : cy)
              + middleBaselineOffset;
            canvas.drawText(
              display,
              cx - Math.max(drawWidth, 1) / 2,
              textY,
              textObjects.paint,
              textObjects.font,
            );
            textObjects.paint.delete();
            textObjects.font.delete();
            textObjects.typeface.delete();
          };

          if (decodedNumber !== null) {
            drawOverlapCell(decodedNumber, originX + boxSize / 2, boxSize * 0.9);
          } else {
            const cx = chars.length > 1 ? originX + op.bbox.width / 2 : originX + boxSize / 2;
            chars.forEach((ch, index) => {
              const cp = ch.codePointAt(0) ?? 0;
              const display = cp >= 0x2460 && cp <= 0x2473
                ? String(cp - 0x2460 + 1)
                : puaToDisplayText(ch) ?? ch;
              drawOverlapCell(display, cx, undefined, index === 0);
            });
          }
        }
        drawControlMarks();
        return;
      }

      const requiresScriptMetricShaping = (op.style.superscript || op.style.subscript)
        && Array.from(text).some((character) => {
          const codePoint = character.codePointAt(0) ?? 0;
          return codePoint < 0x20 || codePoint > 0x7e;
        });
      const requiresHangulClusterShaping = clusters.some((cluster) => (
        /[\u1100-\u115f\ua960-\ua97f][\u1160-\u11a7\ud7b0-\ud7c6]/u.test(cluster.text)
      ));
      const requiresComplexClusterShaping = clusters.some((cluster) => (
        Array.from(cluster.text).some((character) => {
          const codePoint = character.codePointAt(0) ?? 0;
          return (codePoint >= 0x0590 && codePoint <= 0x08ff)
            || (codePoint >= 0x0900 && codePoint <= 0x0dff)
            || (codePoint >= 0x0e00 && codePoint <= 0x0e7f)
            || (codePoint >= 0x1780 && codePoint <= 0x17ff)
            || (codePoint >= 0xfb1d && codePoint <= 0xfdff)
            || (codePoint >= 0xfe70 && codePoint <= 0xfeff)
            || (codePoint >= 0x10800 && codePoint <= 0x10fff)
            || (codePoint >= 0x1e800 && codePoint <= 0x1efff)
            || (codePoint >= 0x0300 && codePoint <= 0x036f)
            || (codePoint >= 0x1ab0 && codePoint <= 0x1aff)
            || (codePoint >= 0x1dc0 && codePoint <= 0x1dff)
            || (codePoint >= 0x200c && codePoint <= 0x200d)
            || (codePoint >= 0x20d0 && codePoint <= 0x20ff)
            || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
            || (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
            || (codePoint >= 0x1f1e6 && codePoint <= 0x1faff)
            || (codePoint >= 0xe0100 && codePoint <= 0xe01ef);
        })
      ));
      const canUseClusterParagraph = (
        requiresScriptMetricShaping
        || requiresHangulClusterShaping
        || requiresComplexClusterShaping
      )
        && !hasRatio
        && outlineType === 0
        && shadowType === 0
        && !emboss
        && !engrave
        && shadeColor === '#ffffff'
        && emphasisDot === 0
        && op.style.underline === 'none'
        && !op.style.strikethrough
        && (!('tabLeaders' in op) || !op.tabLeaders?.length)
        && (!('controlMarks' in op) || !op.controlMarks?.length);
      if (canUseClusterParagraph) {
        let paragraphsReady = false;
        const paragraphs: Array<{
          paragraph: Paragraph;
          x: number;
          baseline: number;
        }> = [];
        try {
          const renderFontWeight = resolveRenderFontWeight(op.style.fontFamily, op.style.bold);
          const fontFamilies = [...clusterFontFamilies, ...fallbackFamilies]
            .map((family) => this.fontRegistry.resolveProviderFamily(
              family,
              renderFontWeight,
              op.style.italic,
            ))
            .filter((family, index, all) => all.indexOf(family) === index);
          const textStyle = new this.canvasKit.TextStyle({
            color: parseCanvasKitCssColor(this.canvasKit, op.style.color),
            fontSize,
            fontFamilies,
            fontStyle: {
              weight: renderFontWeight === 700
                ? this.canvasKit.FontWeight.Bold
                : renderFontWeight === 300
                  ? this.canvasKit.FontWeight.Light
                  : renderFontWeight === 500
                    ? this.canvasKit.FontWeight.Medium
                    : this.canvasKit.FontWeight.Normal,
              slant: op.style.italic
                ? this.canvasKit.FontSlant.Italic
                : this.canvasKit.FontSlant.Upright,
            },
          });
          const paragraphStyle = new this.canvasKit.ParagraphStyle({
            maxLines: 1,
            textStyle,
          });
          for (const cluster of clusters) {
            if (
              cluster.text === ' '
              || cluster.text === '\t'
              || cluster.text === '\u2007'
              || startsWithInvalidControl(cluster.text)
            ) {
              continue;
            }
            const x = positions[cluster.start];
            if (!Number.isFinite(x)) {
              throw new Error('invalid script text position');
            }
            const builder = this.canvasKit.ParagraphBuilder.MakeFromFontProvider(
              paragraphStyle,
              this.fontProvider,
            );
            try {
              builder.addText(cluster.text);
              const paragraph = builder.build();
              try {
                paragraph.layout(CanvasKitLayerRenderer.MAX_SHAPED_TEXT_WIDTH);
                const baseline = paragraph.getAlphabeticBaseline();
                if (!Number.isFinite(baseline)) {
                  throw new Error('invalid script text baseline');
                }
                paragraphs.push({ paragraph, x, baseline });
              } catch (error) {
                paragraph.delete();
                throw error;
              }
            } finally {
              builder.delete();
            }
          }
          paragraphsReady = true;
        } catch {
          paragraphsReady = false;
        }
        if (paragraphsReady) {
          try {
            for (const entry of paragraphs) {
              canvas.drawParagraph(
                entry.paragraph,
                originX + entry.x,
                originY - entry.baseline,
              );
            }
          } finally {
            for (const entry of paragraphs) {
              entry.paragraph.delete();
            }
          }
          return;
        }
        for (const entry of paragraphs) {
          entry.paragraph.delete();
        }
      }

      if (textWidth > 0 && shadeColor !== '#ffffff') {
        const shadePaint = this.makePaint(shadeColor, 'fill');
        canvas.drawRect(
          this.canvasKit.XYWHRect(originX, originY - fontSize, textWidth, fontSize * 1.2),
          shadePaint,
        );
        shadePaint.delete();
      }

      const drawPass = (dx: number, dy: number, fillPaint: Paint, strokePaint?: Paint) => {
        for (const [index, cluster] of clusters.entries()) {
          if (cluster.text === ' ' || cluster.text === '\t' || cluster.text === '\u2007') {
            continue;
          }
          if (startsWithInvalidControl(cluster.text)) {
            continue;
          }
          const x = originX + positions[cluster.start] + dx;
          const y = originY + dy;
          const replayText = clusterReplayTexts[index];
          const cacheKey = `${clusterFontKeys[index]}|${replayText}`;
          const failureKey = `${opId ?? 'anonymous'}:${cluster.start}:${cacheKey}`;
          const diagnosticBase = {
            opId,
            fontFamily: clusterFontFamilies[index],
            clusterStartUtf16: cluster.startUtf16,
            clusterLengthUtf16: cluster.text.length,
          };
          const recovery: CanvasKitTextReplayRecoveryDiagnostic = {
            reason: 'textBlobConstructionFailed' as const,
            fallback: 'drawText',
            ...diagnosticBase,
          };
          const failure: CanvasKitTextReplayFailureDiagnostic = {
            reason: 'simpleTextFallbackFailed',
            ...diagnosticBase,
          };
          let font = clusterFonts[index];
          let blob = this.textBlobCache.get(cacheKey);
          if (blob) {
            this.textBlobCacheHits += 1;
            this.textBlobCache.delete(cacheKey);
            this.textBlobCache.set(cacheKey, blob);
          } else if (this.failedTextBlobCacheKeys.has(cacheKey)) {
            this.textBlobFailureCacheHits += 1;
          } else {
            if (!font) {
              const family = clusterFontFamilies[index];
              let objects = textObjectsByFamily.get(family);
              if (!objects) {
                objects = this.makeTextObjects(
                  family,
                  fontSize,
                  op.style.bold,
                  op.style.italic,
                  op.style.color,
                  1,
                );
                textObjectsByFamily.set(family, objects);
              }
              font = objects.font;
              clusterFonts[index] = font;
            }
            blob = this.canvasKit.TextBlob.MakeFromText(replayText, font);
            if (!blob) {
              this.failedTextBlobCacheKeys.add(cacheKey);
              this.textBlobConstructionFailures += 1;
            } else {
              this.textBlobCacheMisses += 1;
              this.textBlobCache.set(cacheKey, blob);
              if (this.textBlobCache.size > MAX_TEXT_BLOB_CACHE_ENTRIES) {
                const oldestKey = this.textBlobCache.keys().next().value;
                if (oldestKey !== undefined) {
                  const oldestBlob = this.textBlobCache.get(oldestKey);
                  oldestBlob?.delete();
                  this.textBlobCache.delete(oldestKey);
                }
              }
            }
          }

          if (!blob && !font) {
            const family = clusterFontFamilies[index];
            let objects = textObjectsByFamily.get(family);
            if (!objects) {
              objects = this.makeTextObjects(
                family,
                fontSize,
                op.style.bold,
                op.style.italic,
                op.style.color,
                1,
              );
              textObjectsByFamily.set(family, objects);
            }
            font = objects.font;
            clusterFonts[index] = font;
          }

          const drawText = (drawX: number, drawY: number) => {
            if (blob) {
              canvas.drawTextBlob(blob, drawX, drawY, fillPaint);
              if (strokePaint) {
                canvas.drawTextBlob(blob, drawX, drawY, strokePaint);
              }
              return;
            }

            const fallbackFont = font;
            if (!fallbackFont) {
              this.textReplayRecoveryDiagnostics.delete(failureKey);
              this.textReplayFailureDiagnostics.set(failureKey, failure);
              return;
            }
            try {
              canvas.drawText(replayText, drawX, drawY, fillPaint, fallbackFont);
              if (strokePaint) {
                canvas.drawText(replayText, drawX, drawY, strokePaint, fallbackFont);
              }
              this.textBlobFallbackDraws += 1;
              this.textReplayFailureDiagnostics.delete(failureKey);
              this.textReplayRecoveryDiagnostics.set(failureKey, recovery);
            } catch {
              this.textReplayRecoveryDiagnostics.delete(failureKey);
              this.textReplayFailureDiagnostics.set(failureKey, failure);
            }
          };

          if (clusterUsesVerticalPresentationFallback[index] && font) {
            const glyphIds = font.getGlyphIDs(replayText);
            const glyphBounds = font.getGlyphBounds(glyphIds);
            let left = Number.POSITIVE_INFINITY;
            let top = Number.POSITIVE_INFINITY;
            let right = Number.NEGATIVE_INFINITY;
            let bottom = Number.NEGATIVE_INFINITY;
            for (let boundIndex = 0; boundIndex + 3 < glyphBounds.length; boundIndex += 4) {
              left = Math.min(left, glyphBounds[boundIndex]);
              top = Math.min(top, glyphBounds[boundIndex + 1]);
              right = Math.max(right, glyphBounds[boundIndex + 2]);
              bottom = Math.max(bottom, glyphBounds[boundIndex + 3]);
            }
            const nextPositionIndex = clusters[index + 1]?.start ?? positions.length - 1;
            const advance = positions[nextPositionIndex] - positions[cluster.start];
            const targetCenterX = x + (Number.isFinite(advance) ? advance / 2 : op.bbox.width / 2);
            const targetCenterY = y - op.baseline - baselineShift + op.bbox.height / 2;
            const sourceCenterX = Number.isFinite(left) && Number.isFinite(right) ? (left + right) / 2 : 0;
            const sourceCenterY = Number.isFinite(top) && Number.isFinite(bottom) ? (top + bottom) / 2 : 0;
            canvas.save();
            try {
              canvas.translate(targetCenterX, targetCenterY);
              canvas.rotate(90, 0, 0);
              drawText(-sourceCenterX, -sourceCenterY);
            } finally {
              canvas.restore();
            }
            continue;
          }

          const horizontalScale = isHalfwidthScaledCluster(cluster.text) && !hasRatio
            ? 0.5
            : hasRatio ? ratio : 1;
          if (horizontalScale !== 1) {
            canvas.save();
            try {
              canvas.translate(x, y);
              canvas.scale(horizontalScale, 1);
              drawText(0, 0);
            } finally {
              canvas.restore();
            }
          } else {
            drawText(x, y);
          }
        }
      };

      if (emboss || engrave) {
        const offset = Math.max(fontSize / 20, 1);
        const firstPaint = this.makePaint(emboss ? '#ffffff' : '#808080', 'fill');
        const secondPaint = this.makePaint(emboss ? '#808080' : '#ffffff', 'fill');
        drawPass(-offset, -offset, firstPaint);
        drawPass(offset, offset, secondPaint);
        drawPass(0, 0, primaryPaint);
        firstPaint.delete();
        secondPaint.delete();
      } else {
        if (shadowType > 0) {
          const shadowPaint = this.makePaint(shadowColor, 'fill');
          drawPass(shadowOffsetX, shadowOffsetY, shadowPaint);
          shadowPaint.delete();
        }

        if (outlineType > 0) {
          const fillPaint = this.makePaint('#ffffff', 'fill');
          const strokePaint = this.makePaint(op.style.color, 'stroke');
          strokePaint.setStrokeWidth(Math.max(fontSize / 25, 0.5));
          strokePaint.setStrokeJoin(this.canvasKit.StrokeJoin.Round);
          drawPass(0, 0, fillPaint, strokePaint);
          fillPaint.delete();
          strokePaint.delete();
        } else {
          drawPass(0, 0, primaryPaint);
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
            canvas,
            emphasisDot,
            markPosition.x,
            markPosition.y,
            dotSize,
            op.style.color,
          );
        }
      }

      if ('tabLeaders' in op && op.legacyVisuals?.tabLeaders !== 'mirror' && op.tabLeaders?.length) {
        this.drawTabLeaders(canvas, op.tabLeaders, originX, originY, op.style.color);
      }

      if (!decorationsAreMirrors && op.style.underline !== 'none') {
        const y = textDecorationLineY('underline', op.style.underline, originY, fontSize);
        this.drawTextDecorationLine(
          canvas,
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
          canvas,
          originX,
          originX + textWidth,
          y,
          op.style.strikeColor || op.style.color,
          op.style.strikeShape,
        );
      }

      drawControlMarks();
    };

    const textRotation = op.rotation;
    if (textRotation !== 0) {
      const cx = op.bbox.x + op.bbox.width / 2;
      const cy = op.bbox.y + op.bbox.height / 2;
      canvas.save();
      canvas.translate(cx, cy);
      canvas.rotate(textRotation, 0, 0);
      drawClusters(-op.bbox.width / 2, -op.bbox.height / 2 + op.baseline + baselineShift);
      canvas.restore();
    } else {
      drawClusters(op.bbox.x, op.bbox.y + op.baseline + baselineShift);
    }

    for (const { paint, font, typeface } of textObjectsByFamily.values()) {
      paint.delete();
      font.delete();
      typeface.delete();
    }
    primaryPaint.delete();
  }

  private renderGlyphRun(
    canvas: ReturnType<Surface['getCanvas']>,
    op: LayerGlyphRunOp,
  ): void {
    const font = this.fontRegistry.glyphRunFont(op, this.lastRenderedTree?.fontResources);
    if (!font) {
      return;
    }
    const glyphs = new Uint16Array(op.glyphIds.length);
    const positions = new Float32Array(op.positions.length * 2);
    for (const [index, glyphId] of op.glyphIds.entries()) {
      glyphs[index] = glyphId;
      const point = op.positions[index];
      positions[index * 2] = point.x;
      positions[index * 2 + 1] = point.y;
    }
    const transform = op.placement.runToPage;
    canvas.save();
    canvas.concat([
      transform.a,
      transform.c,
      transform.e,
      transform.b,
      transform.d,
      transform.f,
      0,
      0,
      1,
    ]);
    const drawGlyphs = (
      xOffset: number,
      yOffset: number,
      paint: Paint,
    ): void => {
      canvas.drawGlyphs(glyphs, positions, xOffset, yOffset, font, paint);
    };
    if (op.paintStyle.emboss || op.paintStyle.engrave) {
      const offset = Math.max(op.paintStyle.fontSize / 20, 1);
      const firstPaint = this.makePaint(op.paintStyle.emboss ? '#ffffff' : '#808080', 'fill');
      const secondPaint = this.makePaint(op.paintStyle.emboss ? '#808080' : '#ffffff', 'fill');
      const fillPaint = this.makePaint(op.paintStyle.color, 'fill');
      drawGlyphs(-offset, -offset, firstPaint);
      drawGlyphs(offset, offset, secondPaint);
      drawGlyphs(0, 0, fillPaint);
      firstPaint.delete();
      secondPaint.delete();
      fillPaint.delete();
    } else {
      if ((op.paintStyle.shadowType ?? 0) > 0) {
        const shadowPaint = this.makePaint(op.paintStyle.shadowColor || '#000000', 'fill');
        drawGlyphs(op.paintStyle.shadowOffsetX ?? 0, op.paintStyle.shadowOffsetY ?? 0, shadowPaint);
        shadowPaint.delete();
      }
      if ((op.paintStyle.outlineType ?? 0) > 0) {
        const fillPaint = this.makePaint('#ffffff', 'fill');
        const strokePaint = this.makePaint(op.paintStyle.color, 'stroke');
        strokePaint.setStrokeWidth(Math.max(op.paintStyle.fontSize / 25, 0.5));
        strokePaint.setStrokeJoin(this.canvasKit.StrokeJoin.Round);
        drawGlyphs(0, 0, fillPaint);
        drawGlyphs(0, 0, strokePaint);
        fillPaint.delete();
        strokePaint.delete();
      } else {
        const fillPaint = this.makePaint(op.paintStyle.color, 'fill');
        drawGlyphs(0, 0, fillPaint);
        fillPaint.delete();
      }
    }
    canvas.restore();
  }

  private renderGlyphOutline(
    canvas: ReturnType<Surface['getCanvas']>,
    op: LayerGlyphOutlineOp,
  ): void {
    if (!this.glyphOutlineVariantReplayStatus(op).replayable) {
      return;
    }
    const payloadKind = op.payloadKind ?? 'monochromeFill';
    if (payloadKind === 'bitmapGlyph') {
      this.renderBitmapGlyphOutline(canvas, op);
      return;
    }
    if (payloadKind === 'svgGlyph') {
      this.renderSvgGlyphOutline(canvas, op);
      return;
    }
    const transform = op.placement.runToPage;
    canvas.save();
    canvas.concat([
      transform.a,
      transform.c,
      transform.e,
      transform.b,
      transform.d,
      transform.f,
      0,
      0,
      1,
    ]);
    try {
      if (payloadKind === 'colorLayers') {
        if (op.colorLayers?.colorFormat === 'colrV1' && op.colorLayers.paintGraph) {
          const graph = op.colorLayers.paintGraph;
          replayColorPaintGraph(graph, {
            renderSolidPath: (solidPath) => {
              const path = this.makePath(solidPath.commands);
              this.applyPathFillRule(path, solidPath.fillRule);
              const paint = this.makeResolvedColorPaint(solidPath.fill);
              canvas.drawPath(path, paint);
              paint.delete();
              path.delete();
            },
            renderLinearGradientPath: (gradientPath) => {
              const path = this.makePath(gradientPath.commands);
              this.applyPathFillRule(path, gradientPath.fillRule);
              const paint = new this.canvasKit.Paint();
              paint.setAntiAlias(true);
              paint.setStyle(this.canvasKit.PaintStyle.Fill);
              const shader = this.canvasKit.Shader.MakeLinearGradient(
                [gradientPath.gradient.x0, gradientPath.gradient.y0],
                [gradientPath.gradient.x1, gradientPath.gradient.y1],
                gradientPath.gradient.stops.map((stop) => {
                  return resolvedColorUnitRgba(stop.color) as any;
                }),
                gradientPath.gradient.stops.map((stop) => stop.offset),
                this.canvasKit.TileMode.Clamp,
              );
              paint.setShader(shader);
              canvas.drawPath(path, paint);
              shader.delete();
              paint.delete();
              path.delete();
            },
            renderRadialGradientPath: (gradientPath) => {
              const path = this.makePath(gradientPath.commands);
              this.applyPathFillRule(path, gradientPath.fillRule);
              const paint = new this.canvasKit.Paint();
              paint.setAntiAlias(true);
              paint.setStyle(this.canvasKit.PaintStyle.Fill);
              const shader = this.canvasKit.Shader.MakeRadialGradient(
                [gradientPath.gradient.cx, gradientPath.gradient.cy],
                gradientPath.gradient.radius,
                gradientPath.gradient.stops.map((stop) => {
                  return resolvedColorUnitRgba(stop.color) as any;
                }),
                gradientPath.gradient.stops.map((stop) => stop.offset),
                this.canvasKit.TileMode.Clamp,
              );
              paint.setShader(shader);
              canvas.drawPath(path, paint);
              shader.delete();
              paint.delete();
              path.delete();
            },
            renderSweepGradientPath: (gradientPath) => {
              const path = this.makePath(gradientPath.commands);
              this.applyPathFillRule(path, gradientPath.fillRule);
              const paint = new this.canvasKit.Paint();
              paint.setAntiAlias(true);
              paint.setStyle(this.canvasKit.PaintStyle.Fill);
              const shader = this.canvasKit.Shader.MakeSweepGradient(
                gradientPath.gradient.cx,
                gradientPath.gradient.cy,
                gradientPath.gradient.stops.map((stop) => {
                  return resolvedColorUnitRgba(stop.color) as any;
                }),
                gradientPath.gradient.stops.map((stop) => stop.offset),
                this.canvasKit.TileMode.Clamp,
                null,
                0,
                gradientPath.gradient.startAngleDegrees,
                gradientPath.gradient.endAngleDegrees,
              );
              paint.setShader(shader);
              canvas.drawPath(path, paint);
              shader.delete();
              paint.delete();
              path.delete();
            },
            withTransform: (transform, draw) => {
              canvas.save();
              canvas.concat([
                transform.a,
                transform.c,
                transform.e,
                transform.b,
                transform.d,
                transform.f,
                0,
                0,
                1,
              ]);
              try {
                draw();
              } finally {
                canvas.restore();
              }
            },
            renderComposite: (mode, drawBackdrop, drawSource) => {
              if (mode !== 'sourceOver') {
                return;
              }
              drawBackdrop();
              drawSource();
            },
            withClip: (clip, draw) => {
              const path = this.makePath(clip.clipCommands);
              this.applyPathFillRule(path, clip.fillRule);
              canvas.save();
              canvas.clipPath(path, this.canvasKit.ClipOp.Intersect, true);
              try {
                draw();
              } finally {
                canvas.restore();
                path.delete();
              }
            },
          });
          return;
        }
        for (const layer of op.colorLayers?.layers ?? []) {
          if (!layer.commands || !layer.fill) {
            continue;
          }
          const layerTransform = layer.transformToRun;
          if (layerTransform) {
            canvas.save();
            canvas.concat([
              layerTransform.a,
              layerTransform.c,
              layerTransform.e,
              layerTransform.b,
              layerTransform.d,
              layerTransform.f,
              0,
              0,
              1,
            ]);
          }
          const path = this.makePath(layer.commands);
          this.applyPathFillRule(path, layer.fillRule);
          const paint = this.makeResolvedColorPaint(layer.fill);
          canvas.drawPath(path, paint);
          paint.delete();
          path.delete();
          if (layerTransform) {
            canvas.restore();
          }
        }
        return;
      }

      const fillPaint = this.makePaint(op.paintStyle.color, 'fill');
      const stroke = payloadKind === 'monochromeFillStroke' ? op.stroke : undefined;
      const strokePaint = stroke ? this.makePaint(stroke.color ?? op.paintStyle.color, 'stroke', stroke.opacity ?? 1) : null;
      if (strokePaint && stroke) {
        strokePaint.setStrokeWidth(stroke.widthPx);
        strokePaint.setStrokeJoin(this.canvasKitStrokeJoin(stroke.join));
        strokePaint.setStrokeCap(this.canvasKitStrokeCap(stroke.cap));
        if (typeof stroke.miterLimit === 'number') {
          strokePaint.setStrokeMiter(stroke.miterLimit);
        }
      }
      for (const outlinePath of op.paths) {
        const path = this.makePath(outlinePath.commands);
        this.applyPathFillRule(path, outlinePath.fillRule);
        canvas.drawPath(path, fillPaint);
        if (strokePaint) {
          canvas.drawPath(path, strokePaint);
        }
        path.delete();
      }
      strokePaint?.delete();
      fillPaint.delete();
    } finally {
      canvas.restore();
    }
  }

  private renderBitmapGlyphOutline(
    canvas: ReturnType<Surface['getCanvas']>,
    op: LayerGlyphOutlineOp,
  ): void {
    const payload = op.bitmapGlyph;
    const imageIndex = resolveLayerResourceIndex(
      payload?.imageResourceId,
      this.lastRenderedTree?.resources?.imageKeys,
      this.lastRenderedTree?.resources?.images.length ?? 0,
    );
    if (!payload || !hasStrictBitmapGlyphContract(op) || imageIndex === undefined) {
      return;
    }
    const image = this.resourceCache.image(imageIndex);
    if (!image) {
      return;
    }
    const imageWidth = image.width();
    const imageHeight = image.height();
    const { x, y, width, height } = op.bbox;
    if (
      !Number.isFinite(imageWidth)
      || !Number.isFinite(imageHeight)
      || imageWidth <= 0
      || imageHeight <= 0
      || !Number.isFinite(x)
      || !Number.isFinite(y)
      || !Number.isFinite(width)
      || !Number.isFinite(height)
      || width <= 0
      || height <= 0
    ) {
      return;
    }
    const paint = new this.canvasKit.Paint();
    const transform = payload.placement?.runToPage;
    if (!transform) {
      paint.delete();
      return;
    }
    const payloadTransform = payload.transformToRun;
    canvas.save();
    try {
      canvas.concat([
        transform.a,
        transform.c,
        transform.e,
        transform.b,
        transform.d,
        transform.f,
        0,
        0,
        1,
      ]);
      if (payloadTransform) {
        canvas.concat([
          payloadTransform.a,
          payloadTransform.c,
          payloadTransform.e,
          payloadTransform.b,
          payloadTransform.d,
          payloadTransform.f,
          0,
          0,
          1,
        ]);
      }
      canvas.drawImageRectOptions(
        image,
        this.canvasKit.XYWHRect(0, 0, imageWidth, imageHeight),
        this.canvasKit.XYWHRect(0, 0, width, height),
        payload.filtering === 'nearest' ? this.canvasKit.FilterMode.Nearest : this.canvasKit.FilterMode.Linear,
        this.canvasKit.MipmapMode.None,
        paint,
      );
    } finally {
      canvas.restore();
      paint.delete();
    }
  }

  private renderSvgGlyphOutline(
    canvas: ReturnType<Surface['getCanvas']>,
    op: LayerGlyphOutlineOp,
  ): void {
    const payload = op.svgGlyph;
    if (!payload || !hasStaticSanitizedSvgGlyphContract(op)) {
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
    const pathLayers = this.prepareSvgGlyphPaths(op);
    if (!pathLayers) {
      return;
    }
    const transform = payload.placement?.runToPage;
    if (!transform) {
      return;
    }
    const payloadTransform = payload.transformToRun;
    canvas.save();
    try {
      canvas.concat([
        transform.a,
        transform.c,
        transform.e,
        transform.b,
        transform.d,
        transform.f,
        0,
        0,
        1,
      ]);
      if (payloadTransform) {
        canvas.concat([
          payloadTransform.a,
          payloadTransform.c,
          payloadTransform.e,
          payloadTransform.b,
          payloadTransform.d,
          payloadTransform.f,
          0,
          0,
          1,
        ]);
      }
      canvas.scale(width / viewBox.width, height / viewBox.height);
      canvas.translate(-viewBox.x, -viewBox.y);
      for (const { layer, path } of pathLayers) {
        canvas.save();
        try {
          if (layer.transform) {
            canvas.concat([
              layer.transform.a,
              layer.transform.c,
              layer.transform.e,
              layer.transform.b,
              layer.transform.d,
              layer.transform.f,
              0,
              0,
              1,
            ]);
          }
          this.applyPathFillRule(path, layer.fillRule);
          if (layer.fill !== null) {
            const paint = this.makePaint(layer.fill, 'fill', layer.opacity);
            canvas.drawPath(path, paint);
            paint.delete();
          }
          if (layer.stroke) {
            const strokePaint = this.makePaint(layer.stroke.color, 'stroke', layer.stroke.opacity);
            strokePaint.setStrokeWidth(layer.stroke.width);
            strokePaint.setStrokeJoin(this.canvasKitStrokeJoin(layer.stroke.lineJoin));
            strokePaint.setStrokeCap(this.canvasKitStrokeCap(layer.stroke.lineCap));
            strokePaint.setStrokeMiter(layer.stroke.miterLimit);
            if (layer.stroke.dashArray) {
              const effect = this.canvasKit.PathEffect.MakeDash(layer.stroke.dashArray, layer.stroke.dashOffset);
              strokePaint.setPathEffect(effect);
              effect.delete();
            }
            canvas.drawPath(path, strokePaint);
            strokePaint.delete();
          }
        } finally {
          canvas.restore();
        }
      }
    } finally {
      canvas.restore();
    }
  }

  private renderTextControlMark(
    canvas: ReturnType<Surface['getCanvas']>,
    op: LayerTextControlMarkOp,
  ): void {
    if (!allowsTextControlMark(
      this.currentShowParagraphMarks,
      this.currentShowControlCodes,
      op.mark.kind,
    )) {
      return;
    }
    const markObjects = this.makeTextObjects(
      TEXT_CONTROL_MARK_FONT_FAMILY,
      op.mark.fontSize,
      false,
      false,
      isStructureControlMark(op.mark.kind) ? '#CC3333' : '#4A90D9',
    );
    const rotation = op.rotation ?? 0;
    if (rotation !== 0) {
      const cx = op.bbox.x + op.bbox.width / 2;
      const cy = op.bbox.y + op.bbox.height / 2;
      canvas.save();
      canvas.rotate(rotation, cx, cy);
    }
    try {
      canvas.drawText(
        op.mark.text,
        op.bbox.x + op.mark.x,
        op.bbox.y + op.mark.y,
        markObjects.paint,
        markObjects.font,
      );
    } finally {
      if (rotation !== 0) {
        canvas.restore();
      }
    }
    markObjects.paint.delete();
    markObjects.font.delete();
    markObjects.typeface.delete();
  }

  private renderTabLeader(
    canvas: ReturnType<Surface['getCanvas']>,
    op: LayerTabLeaderOp,
  ): void {
    const rotation = op.rotation ?? 0;
    if (rotation !== 0) {
      const cx = op.bbox.x + op.bbox.width / 2;
      const cy = op.bbox.y + op.bbox.height / 2;
      canvas.save();
      canvas.rotate(rotation, cx, cy);
    }
    try {
      this.drawTabLeaders(canvas, [op.leader], op.bbox.x, op.bbox.y + op.baseline, op.color);
    } finally {
      if (rotation !== 0) {
        canvas.restore();
      }
    }
  }

  private renderTextDecoration(
    canvas: ReturnType<Surface['getCanvas']>,
    op: LayerTextDecorationOp,
  ): void {
    const drawDecoration = (originX: number, baselineY: number) => {
      const textWidth = op.decoration.positions.at(-1) ?? 0;
      if (op.decoration.kind === 'underline') {
        const y = textDecorationLineY('underline', op.decoration.underline, baselineY, op.decoration.fontSize);
        this.drawTextDecorationLine(
          canvas,
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
          canvas,
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
          canvas,
          op.decoration.emphasisDot,
          markPosition.x,
          markPosition.y,
          dotSize,
          op.decoration.color,
        );
      }
    };

    if (op.decoration.rotation !== 0) {
      const cx = op.bbox.x + op.bbox.width / 2;
      const cy = op.bbox.y + op.bbox.height / 2;
      canvas.save();
      canvas.translate(cx, cy);
      canvas.rotate(op.decoration.rotation, 0, 0);
      canvas.translate(-cx, -cy);
      drawDecoration(op.bbox.x, op.bbox.y + op.decoration.baseline);
      canvas.restore();
      return;
    }
    drawDecoration(op.bbox.x, op.bbox.y + op.decoration.baseline);
  }

  private drawEmphasisMark(
    canvas: ReturnType<Surface['getCanvas']>,
    emphasisDot: number,
    x: number,
    baselineY: number,
    size: number,
    color: string,
  ): void {
    for (const primitive of textDecorationEmphasisGeometry(emphasisDot, size)) {
      if (primitive.kind === 'circle') {
        const paint = this.makePaint(color, primitive.paint);
        if (primitive.paint === 'stroke') {
          paint.setStrokeWidth(primitive.strokeWidth ?? 1);
        }
        canvas.drawCircle(
          x + primitive.x,
          baselineY + primitive.y,
          primitive.radius,
          paint,
        );
        paint.delete();
        continue;
      }
      const builder = new this.canvasKit.PathBuilder();
      for (const command of primitive.commands) {
        if (command.kind === 'moveTo') {
          builder.moveTo(x + command.x, baselineY + command.y);
        } else if (command.kind === 'lineTo') {
          builder.lineTo(x + command.x, baselineY + command.y);
        } else {
          builder.quadTo(
            x + command.controlX,
            baselineY + command.controlY,
            x + command.x,
            baselineY + command.y,
          );
        }
      }
      const path = builder.detach();
      builder.delete();
      const paint = this.makePaint(color, 'stroke');
      paint.setStrokeWidth(primitive.strokeWidth);
      paint.setStrokeCap(this.canvasKit.StrokeCap.Round);
      paint.setStrokeJoin(this.canvasKit.StrokeJoin.Round);
      canvas.drawPath(path, paint);
      paint.delete();
      path.delete();
    }
  }

  private renderFootnoteMarker(canvas: ReturnType<Surface['getCanvas']>, op: Extract<LayerPaintOp, { type: 'footnoteMarker' }>): void {
    const { font, paint, typeface } = this.makeTextObjects(op.fontFamily, op.fontSize, false, false, op.color);
    canvas.drawText(op.text, op.bbox.x, op.bbox.y + op.bbox.height * 0.4, paint, font);
    paint.delete();
    font.delete();
    typeface.delete();
  }

  private renderLine(canvas: ReturnType<Surface['getCanvas']>, op: LayerLineOp): void {
    this.withTransform(canvas, op.bbox, op.transform, () => {
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
          drawArrowHead(
            this.canvasKit,
            canvas,
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
          drawArrowHead(
            this.canvasKit,
            canvas,
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
        const paint = this.makeLinePaint(op.style.color, strokeWidth, op.style.dash);
        let offsetX = 0;
        let offsetY = 0;
        if (lineLength > 0 && offsetRatio !== 0) {
          const normalX = -dy / lineLength;
          const normalY = dx / lineLength;
          offsetX = normalX * width * offsetRatio;
          offsetY = normalY * width * offsetRatio;
        }
        if (op.style.shadow) {
          this.drawShadow(
            canvas,
            op.style.shadow,
            'stroke',
            op.style.shadow.color,
            strokeWidth,
            1,
            (shadowPaint) => canvas.drawLine(lineX1 + offsetX, lineY1 + offsetY, lineX2 + offsetX, lineY2 + offsetY, shadowPaint),
            op.style.dash,
          );
        }
        canvas.drawLine(lineX1 + offsetX, lineY1 + offsetY, lineX2 + offsetX, lineY2 + offsetY, paint);
        paint.delete();
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

  private renderRectangle(canvas: ReturnType<Surface['getCanvas']>, op: LayerRectangleOp): void {
    this.withTransform(canvas, op.bbox, op.transform, () => {
      const fill = this.makeShapeFillPaint(op.bbox, op.style.fillColor, op.style.opacity, op.gradient, op.style.pattern);
      const strokePaint = op.style.strokeColor
        ? this.makeLinePaint(op.style.strokeColor, op.style.strokeWidth, op.style.strokeDash, op.style.opacity)
        : null;
      const rect = this.toRect(op.bbox);
      const drawRect = (paint: Paint) => {
        if (op.cornerRadius > 0) {
          const radius = Math.min(
            op.cornerRadius,
            op.bbox.width / 2,
            op.bbox.height / 2,
          );
          canvas.drawRRect(this.canvasKit.RRectXY(rect, radius, radius), paint);
          return;
        }
        canvas.drawRect(rect, paint);
      };

      if (op.style.shadow) {
        if (fill) {
          this.drawShadow(
            canvas,
            op.style.shadow,
            'fill',
            op.style.shadow.color,
            op.style.strokeWidth,
            op.style.opacity,
            drawRect,
          );
        }
        if (strokePaint) {
          this.drawShadow(
            canvas,
            op.style.shadow,
            'stroke',
            op.style.shadow.color,
            op.style.strokeWidth,
            op.style.opacity,
            drawRect,
            op.style.strokeDash,
          );
        }
      }

      if (fill) {
        drawRect(fill.paint);
        fill.shader?.delete();
        fill.paint.delete();
      }
      if (strokePaint) {
        drawRect(strokePaint);
        strokePaint.delete();
      }
    });
  }

  private renderEllipse(canvas: ReturnType<Surface['getCanvas']>, op: LayerEllipseOp): void {
    this.withTransform(canvas, op.bbox, op.transform, () => {
      const fill = this.makeShapeFillPaint(op.bbox, op.style.fillColor, op.style.opacity, op.gradient, op.style.pattern);
      const strokePaint = op.style.strokeColor
        ? this.makeLinePaint(op.style.strokeColor, op.style.strokeWidth, op.style.strokeDash, op.style.opacity)
        : null;
      const oval = this.toRect(op.bbox);
      const drawOval = (paint: Paint) => canvas.drawOval(oval, paint);

      if (op.style.shadow) {
        if (fill) {
          this.drawShadow(
            canvas,
            op.style.shadow,
            'fill',
            op.style.shadow.color,
            op.style.strokeWidth,
            op.style.opacity,
            drawOval,
          );
        }
        if (strokePaint) {
          this.drawShadow(
            canvas,
            op.style.shadow,
            'stroke',
            op.style.shadow.color,
            op.style.strokeWidth,
            op.style.opacity,
            drawOval,
            op.style.strokeDash,
          );
        }
      }

      if (fill) {
        drawOval(fill.paint);
        fill.shader?.delete();
        fill.paint.delete();
      }
      if (strokePaint) {
        drawOval(strokePaint);
        strokePaint.delete();
      }
    });
  }

  private renderPath(canvas: ReturnType<Surface['getCanvas']>, op: LayerPathOp): void {
    this.withTransform(canvas, op.bbox, op.transform, () => {
      const path = this.makePath(op.commands);
      const pathBounds = computePathPaintBounds(op.commands, op.bbox);
      const fill = this.makeShapeFillPaint(pathBounds, op.style.fillColor, op.style.opacity, op.gradient, op.style.pattern);
      const strokePaint = op.style.strokeColor
        ? this.makeLinePaint(op.style.strokeColor, op.style.strokeWidth, op.style.strokeDash, op.style.opacity)
        : null;
      const drawPath = (paint: Paint) => canvas.drawPath(path, paint);

      if (op.style.shadow) {
        if (fill) {
          this.drawShadow(
            canvas,
            op.style.shadow,
            'fill',
            op.style.shadow.color,
            op.style.strokeWidth,
            op.style.opacity,
            drawPath,
          );
        }
        if (strokePaint) {
          this.drawShadow(
            canvas,
            op.style.shadow,
            'stroke',
            op.style.shadow.color,
            op.style.strokeWidth,
            op.style.opacity,
            drawPath,
            op.style.strokeDash,
          );
        }
      }

      if (fill) {
        drawPath(fill.paint);
        fill.shader?.delete();
        fill.paint.delete();
      }
      if (strokePaint) {
        drawPath(strokePaint);
        strokePaint.delete();
      }
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
          drawArrowHead(
            this.canvasKit,
            canvas,
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
          drawArrowHead(
            this.canvasKit,
            canvas,
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
      path.delete();
    });
  }

  private renderImage(canvas: ReturnType<Surface['getCanvas']>, op: LayerImageOp): void {
    const bbox = effectiveLayerImageBounds(op.bbox, op.transform);
    this.withTransform(canvas, bbox, op.transform, () => {
      this.drawEncodedImage(
        canvas,
        op.resourceId,
        op.base64,
        bbox,
        op.fillMode,
        op.originalSize,
        op.crop,
        op.effect,
        op.brightness ?? 0,
        op.contrast ?? 0,
        op.originalSizeHu,
      );
    });
  }

  private renderFormObject(
    canvas: ReturnType<Surface['getCanvas']>,
    op: LayerFormObjectOp,
  ): void {
    const { x, y, width: w, height: h } = op.bbox;
    const palette = formObjectPalette(op);
    let formText: {
      text: string;
      fontSize: number;
      anchorX: number;
      centered: boolean;
    } | null = null;

    switch (op.formType) {
      case 'pushButton': {
        const fillPaint = this.makePaint(palette.buttonBackColor, 'fill');
        const strokePaint = this.makeLinePaint(palette.borderColor, 0.5, 'solid');
        canvas.drawRect(this.toRect(op.bbox), fillPaint);
        canvas.drawRect(this.toRect(op.bbox), strokePaint);
        fillPaint.delete();
        strokePaint.delete();

        if (op.caption) {
          formText = {
            text: op.caption,
            fontSize: Math.min(Math.max(h * 0.5, 8), 12),
            anchorX: x + w / 2,
            centered: true,
          };
        }
        break;
      }
      case 'checkBox': {
        const boxSize = Math.min(h, 14);
        const boxY = y + (h - boxSize) / 2;
        const boxX = x;
        const fillPaint = this.makePaint(palette.backColor, 'fill');
        const strokePaint = this.makeLinePaint(palette.borderColor, 1, 'solid');
        canvas.drawRect(this.canvasKit.XYWHRect(boxX, boxY, boxSize, boxSize), fillPaint);
        canvas.drawRect(this.canvasKit.XYWHRect(boxX, boxY, boxSize, boxSize), strokePaint);
        fillPaint.delete();
        strokePaint.delete();

        if (op.value !== 0) {
          const path = new this.canvasKit.PathBuilder();
          path.moveTo(boxX + 2, boxY + boxSize / 2);
          path.lineTo(boxX + boxSize / 3, boxY + boxSize - 3);
          path.lineTo(boxX + boxSize - 2, boxY + 2);
          const markPaint = this.makeLinePaint(palette.foreColor, 2, 'solid');
          const checkPath = path.detach();
          canvas.drawPath(checkPath, markPaint);
          markPaint.delete();
          checkPath.delete();
          path.delete();
        }

        if (op.caption) {
          formText = {
            text: op.caption,
            fontSize: Math.min(Math.max(h * 0.7, 8), 12),
            anchorX: boxX + boxSize + 4,
            centered: false,
          };
        }
        break;
      }
      case 'radioButton': {
        const r = Math.min(h, 14) / 2;
        const cx = x + r;
        const cy = y + h / 2;
        const fillPaint = this.makePaint(palette.backColor, 'fill');
        const strokePaint = this.makeLinePaint(palette.borderColor, 1, 'solid');
        canvas.drawCircle(cx, cy, r, fillPaint);
        canvas.drawCircle(cx, cy, r, strokePaint);
        fillPaint.delete();
        strokePaint.delete();

        if (op.value !== 0) {
          const dotPaint = this.makePaint(palette.foreColor, 'fill');
          canvas.drawCircle(cx, cy, r * 0.5, dotPaint);
          dotPaint.delete();
        }

        if (op.caption) {
          formText = {
            text: op.caption,
            fontSize: Math.min(Math.max(h * 0.7, 8), 12),
            anchorX: x + r * 2 + 4,
            centered: false,
          };
        }
        break;
      }
      case 'comboBox': {
        const btnW = Math.min(h, 20);
        const fillPaint = this.makePaint(palette.backColor, 'fill');
        const strokePaint = this.makeLinePaint(palette.borderColor, 1, 'solid');
        canvas.drawRect(this.canvasKit.XYWHRect(x, y, w - btnW, h), fillPaint);
        canvas.drawRect(this.canvasKit.XYWHRect(x, y, w - btnW, h), strokePaint);
        fillPaint.delete();
        strokePaint.delete();

        if (op.text) {
          formText = {
            text: op.text,
            fontSize: Math.min(Math.max(h * 0.6, 8), 12),
            anchorX: x + 2,
            centered: false,
          };
        }
        break;
      }
      case 'edit': {
        const fillPaint = this.makePaint(palette.backColor, 'fill');
        const strokePaint = this.makeLinePaint(palette.borderColor, 1, 'solid');
        canvas.drawRect(this.toRect(op.bbox), fillPaint);
        canvas.drawRect(this.toRect(op.bbox), strokePaint);
        fillPaint.delete();
        strokePaint.delete();

        if (op.text) {
          formText = {
            text: op.text,
            fontSize: Math.min(Math.max(h * 0.6, 8), 12),
            anchorX: x + 2,
            centered: false,
          };
        }
        break;
      }
    }

    if (formText) {
      const family = this.fontRegistry.resolveFamily('sans-serif');
      const { font, paint, typeface } = this.makeTextObjects(
        family,
        formText.fontSize,
        false,
        false,
        palette.foreColor,
      );
      try {
        const metrics = font.getMetrics();
        const baselineY = y + h / 2 - (
          (metrics.ascent ?? -formText.fontSize * 0.8)
          + (metrics.descent ?? formText.fontSize * 0.2)
        ) / 2;
        const shaped = this.buildShapedSingleLineParagraph(
          formText.text,
          [family, 'Noto Sans KR', 'Noto Sans CJK KR'],
          formText.fontSize,
          400,
          false,
          palette.foreColor,
          1,
        );
        let shapedDrawn = false;
        if (shaped) {
          try {
            const drawX = formText.centered
              ? formText.anchorX - shaped.width / 2
              : formText.anchorX;
            canvas.drawParagraph(
              shaped.paragraph,
              drawX,
              baselineY - shaped.alphabeticBaseline,
            );
            shapedDrawn = true;
          } catch {
            shapedDrawn = false;
          } finally {
            shaped.paragraph.delete();
          }
        }
        if (!shapedDrawn) {
          const glyphIds = font.getGlyphIDs(formText.text);
          const glyphWidths = font.getGlyphWidths(glyphIds) ?? [];
          const measuredWidth = glyphWidths.length > 0
            ? glyphWidths.reduce((sum, width) => sum + width, 0)
            : formText.text.length * formText.fontSize * 0.55;
          const drawX = formText.centered
            ? formText.anchorX - measuredWidth / 2
            : formText.anchorX;
          canvas.drawText(formText.text, drawX, baselineY, paint, font);
        }
      } finally {
        paint.delete();
        font.delete();
        typeface.delete();
      }
    }

    if (op.formType === 'comboBox') {
      const btnW = Math.min(h, 20);
      const buttonRect = this.canvasKit.XYWHRect(x + w - btnW, y, btnW, h);
      const buttonFill = this.makePaint(palette.buttonFaceColor, 'fill');
      const buttonStroke = this.makeLinePaint(palette.borderColor, 1, 'solid');
      canvas.drawRect(buttonRect, buttonFill);
      canvas.drawRect(buttonRect, buttonStroke);
      buttonFill.delete();
      buttonStroke.delete();

      const arrowCx = x + w - btnW / 2;
      const arrowCy = y + h / 2;
      const arrowSize = btnW * 0.3;
      const arrowPath = new this.canvasKit.PathBuilder();
      arrowPath.moveTo(arrowCx - arrowSize, arrowCy - arrowSize / 2);
      arrowPath.lineTo(arrowCx + arrowSize, arrowCy - arrowSize / 2);
      arrowPath.lineTo(arrowCx, arrowCy + arrowSize / 2);
      arrowPath.close();
      const arrowPaint = this.makePaint(palette.foreColor, 'fill');
      const arrowShape = arrowPath.detach();
      canvas.drawPath(arrowShape, arrowPaint);
      arrowPaint.delete();
      arrowShape.delete();
      arrowPath.delete();
    }
  }

  private renderEquation(
    canvas: ReturnType<Surface['getCanvas']>,
    op: LayerEquationOp,
  ): void {
    const svgReplay = this.renderEquationSvgResource(canvas, op);
    if (svgReplay.replayed) {
      this.recordEquationReplayDiagnostic(op, {
        route: 'svg',
        reason: svgReplay.reason,
      });
      return;
    }
    this.recordEquationReplayDiagnostic(op, {
      route: 'layout',
      reason: svgReplay.reason,
    });
    this.renderEquationBox(
      canvas,
      op.layoutBox,
      op.bbox.x,
      op.bbox.y,
      op.color,
      op.fontSize,
      false,
      false,
    );
  }

  private renderEquationSvgResource(
    canvas: ReturnType<Surface['getCanvas']>,
    op: LayerEquationOp,
  ): CanvasKitEquationSvgReplayResult {
    const svgResourceId = op.svgResourceId;
    const hasInlineSvg = typeof op.svgContent === 'string';
    if (typeof svgResourceId !== 'number' && !hasInlineSvg) {
      return { replayed: false, reason: 'layoutRequested' };
    }
    const fragment = typeof svgResourceId === 'number'
      ? this.lastRenderedTree?.resources?.svgFragments?.[svgResourceId]
      : op.svgContent;
    if (typeof fragment !== 'string') {
      return { replayed: false, reason: 'svgResourceMissing' };
    }
    const pathLayers = parseStaticSvgPathLayers(fragment);
    const textLayers = parseStaticSvgTextLayers(fragment);
    if (!staticSvgLayersHaveDrawableContent(pathLayers, textLayers)) {
      return { replayed: false, reason: 'svgPayloadUnsupported' };
    }
    if (pathLayers.some((layer) => !isStaticSvgPathDataValid(layer.pathData))) {
      return { replayed: false, reason: 'svgPathDecodeFailed' };
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
      return { replayed: false, reason: 'invalidEquationBounds' };
    }

    const decodedPathLayers: Array<{ layer: StaticSvgPathLayer; path: Path }> = [];
    for (const layer of pathLayers) {
      let path: Path | null = null;
      try {
        path = this.canvasKit.Path.MakeFromSVGString(layer.pathData);
      } catch {
        path = null;
      }
      if (!path) {
        for (const decoded of decodedPathLayers) {
          decoded.path.delete();
        }
        return { replayed: false, reason: 'svgPathDecodeFailed' };
      }
      decodedPathLayers.push({ layer, path });
    }

    let replayed = false;
    canvas.save();
    try {
      canvas.translate(x, y);
      for (const { layer, path } of decodedPathLayers) {
        canvas.save();
        try {
          if (layer.transform) {
            canvas.concat([
              layer.transform.a,
              layer.transform.c,
              layer.transform.e,
              layer.transform.b,
              layer.transform.d,
              layer.transform.f,
              0,
              0,
              1,
            ]);
          }
          this.applyPathFillRule(path, layer.fillRule);
          if (layer.fill !== null) {
            const paint = this.makePaint(layer.fill, 'fill', layer.opacity);
            canvas.drawPath(path, paint);
            replayed = true;
            paint.delete();
          }
          if (layer.stroke) {
            const strokePaint = this.makePaint(layer.stroke.color, 'stroke', layer.stroke.opacity);
            strokePaint.setStrokeWidth(layer.stroke.width);
            strokePaint.setStrokeJoin(this.canvasKitStrokeJoin(layer.stroke.lineJoin));
            strokePaint.setStrokeCap(this.canvasKitStrokeCap(layer.stroke.lineCap));
            strokePaint.setStrokeMiter(layer.stroke.miterLimit);
            if (layer.stroke.dashArray) {
              const effect = this.canvasKit.PathEffect.MakeDash(layer.stroke.dashArray, layer.stroke.dashOffset);
              strokePaint.setPathEffect(effect);
              effect.delete();
            }
            canvas.drawPath(path, strokePaint);
            replayed = true;
            strokePaint.delete();
          }
        } finally {
          canvas.restore();
        }
      }
      for (const layer of textLayers) {
        this.renderStaticSvgTextLayer(canvas, layer);
        replayed = true;
      }
    } finally {
      canvas.restore();
      for (const decoded of decodedPathLayers) {
        decoded.path.delete();
      }
    }
    return replayed
      ? { replayed: true, reason: 'svgReplayed' }
      : { replayed: false, reason: 'svgPayloadUnsupported' };
  }

  private recordEquationReplayDiagnostic(
    op: LayerEquationOp,
    result: CanvasKitEquationReplayRouteResult,
  ): void {
    this.equationReplayDiagnostics.push({
      ...result,
      svgResourceId: typeof op.svgResourceId === 'number' ? op.svgResourceId : null,
      hasInlineSvg: typeof op.svgContent === 'string',
      bbox: { ...op.bbox },
    });
  }

  private buildShapedSingleLineParagraph(
    text: string,
    fallbackFamilies: readonly string[],
    fontSize: number,
    fontWeight: RenderFontWeight,
    italic: boolean,
    color: string,
    opacity: number,
  ): CanvasKitShapedSingleLine | null {
    let paragraph: Paragraph | null = null;
    try {
      const fontFamilies = fallbackFamilies
        .map((family) => this.fontRegistry.resolveProviderFamily(family, fontWeight, italic))
        .filter((family, index, all) => all.indexOf(family) === index);
      const textStyle = new this.canvasKit.TextStyle({
        color: parseCanvasKitCssColor(this.canvasKit, color, opacity),
        fontFamilies,
        fontSize,
        fontStyle: {
          weight: fontWeight === 700
            ? this.canvasKit.FontWeight.Bold
            : this.canvasKit.FontWeight.Normal,
          slant: italic
            ? this.canvasKit.FontSlant.Italic
            : this.canvasKit.FontSlant.Upright,
        },
      });
      const paragraphStyle = new this.canvasKit.ParagraphStyle({
        maxLines: 1,
        textStyle,
      });
      const builder = this.canvasKit.ParagraphBuilder.MakeFromFontProvider(
        paragraphStyle,
        this.fontProvider,
      );
      try {
        builder.addText(text);
        paragraph = builder.build();
      } finally {
        builder.delete();
      }
      if (!paragraph) {
        throw new Error('single-line paragraph construction failed');
      }
      paragraph.layout(CanvasKitLayerRenderer.MAX_SHAPED_TEXT_WIDTH);
      const width = paragraph.getLongestLine();
      const height = paragraph.getHeight();
      const alphabeticBaseline = paragraph.getAlphabeticBaseline();
      if (
        !Number.isFinite(width)
        || !Number.isFinite(height)
        || height < 0
        || !Number.isFinite(alphabeticBaseline)
      ) {
        throw new Error('invalid single-line paragraph metrics');
      }
      return {
        paragraph,
        width,
        height,
        alphabeticBaseline,
      };
    } catch {
      paragraph?.delete();
      return null;
    }
  }

  private renderStaticSvgTextLayer(
    canvas: ReturnType<Surface['getCanvas']>,
    layer: StaticSvgTextLayer,
  ): void {
    canvas.save();
    try {
      if (layer.transform) {
        canvas.concat([
          layer.transform.a,
          layer.transform.c,
          layer.transform.e,
          layer.transform.b,
          layer.transform.d,
          layer.transform.f,
          0,
          0,
          1,
        ]);
      }
      const textObjectsByFamily = new Map<string, { typeface: Typeface; font: Font; paint: Paint }>();
      const makeSvgTextObjects = (fontFamily: string) => {
        const objects = this.makeTextObjects(
          fontFamily,
          layer.fontSize,
          layer.fontWeight === 'bold',
          layer.fontStyle === 'italic',
          layer.fill,
        );
        if (layer.opacity < 1) {
          objects.paint.setColor(parseCanvasKitCssColor(this.canvasKit, layer.fill, layer.opacity));
        }
        return objects;
      };
      const fallbackFamilies = [
        layer.fontFamily,
        'Noto Sans KR',
        'Noto Sans CJK KR',
        'NanumGothic',
        'D2Coding',
        'NanumGothicCoding',
        'Noto Serif KR',
        'Noto Serif CJK KR',
      ].filter((family, index, all) => all.indexOf(family) === index);
      try {
        const shaped = this.buildShapedSingleLineParagraph(
          layer.text,
          fallbackFamilies,
          layer.fontSize,
          layer.fontWeight === 'bold' ? 700 : 400,
          layer.fontStyle === 'italic',
          layer.fill,
          layer.opacity,
        );
        if (shaped) {
          let paragraphDrawn = false;
          try {
            const drawX = layer.textAnchor === 'middle'
              ? layer.x - shaped.width / 2
              : layer.textAnchor === 'end'
                ? layer.x - shaped.width
                : layer.x;
            const drawY = layer.dominantBaseline === 'middle'
              ? layer.y - shaped.height / 2
              : layer.y - shaped.alphabeticBaseline;
            canvas.drawParagraph(
              shaped.paragraph,
              drawX,
              drawY,
            );
            paragraphDrawn = true;
          } catch {
            paragraphDrawn = false;
          } finally {
            shaped.paragraph.delete();
          }
          if (paragraphDrawn) {
            return;
          }
        }

        const primaryObjects = makeSvgTextObjects(layer.fontFamily);
        textObjectsByFamily.set(layer.fontFamily, primaryObjects);
        const primaryMetrics = primaryObjects.font.getMetrics();
        const clusters = splitIntoClusters(layer.text);
        const clusterObjects: Array<{ typeface: Typeface; font: Font; paint: Paint }> = [];
        const clusterWidths: number[] = [];
        for (const cluster of clusters) {
          let selectedObjects = primaryObjects;
          const primaryGlyphs = primaryObjects.font.getGlyphIDs(cluster.text);
          if (!primaryGlyphs || primaryGlyphs.some((glyphId) => glyphId === 0)) {
            for (const family of fallbackFamilies) {
              let candidate = textObjectsByFamily.get(family);
              if (!candidate) {
                candidate = makeSvgTextObjects(family);
                textObjectsByFamily.set(family, candidate);
              }
              const candidateGlyphs = candidate.font.getGlyphIDs(cluster.text);
              if (candidateGlyphs && candidateGlyphs.every((glyphId) => glyphId !== 0)) {
                selectedObjects = candidate;
                break;
              }
            }
          }
          const glyphIds = selectedObjects.font.getGlyphIDs(cluster.text);
          const glyphWidths = selectedObjects.font.getGlyphWidths(glyphIds) ?? [];
          clusterObjects.push(selectedObjects);
          clusterWidths.push(glyphWidths.reduce((sum, width) => sum + width, 0));
        }
        const textWidth = clusterWidths.reduce((sum, width) => sum + width, 0);
        const drawX = layer.textAnchor === 'middle'
          ? layer.x - textWidth / 2
          : layer.textAnchor === 'end'
            ? layer.x - textWidth
            : layer.x;
        const middleBaselineOffset = Number.isFinite(primaryMetrics.ascent)
          && Number.isFinite(primaryMetrics.descent)
          ? -(primaryMetrics.ascent + primaryMetrics.descent) / 2
          : layer.fontSize * 0.35;
        const baselineY = layer.dominantBaseline === 'middle'
          ? layer.y + middleBaselineOffset
          : layer.y;
        let clusterX = drawX;
        for (const [index, cluster] of clusters.entries()) {
          canvas.drawText(cluster.text, clusterX, baselineY, clusterObjects[index].paint, clusterObjects[index].font);
          clusterX += clusterWidths[index];
        }
      } finally {
        for (const { paint, font, typeface } of textObjectsByFamily.values()) {
          paint.delete();
          font.delete();
          typeface.delete();
        }
      }
    } finally {
      canvas.restore();
    }
  }

  private renderEquationBox(
    canvas: ReturnType<Surface['getCanvas']>,
    layout: LayerEquationLayoutBox,
    parentX: number,
    parentY: number,
    color: string,
    fontSize: number,
    italic: boolean,
    bold: boolean,
  ): void {
    const x = parentX + layout.x;
    const y = parentY + layout.y;

    switch (layout.kind.type) {
      case 'row':
        for (const child of layout.kind.children) {
          this.renderEquationBox(canvas, child, x, y, color, fontSize, italic, bold);
        }
        return;
      case 'text':
        this.drawEquationText(
          canvas,
          layout.kind.text,
          x,
          y + layout.baseline,
          this.equationFontSizeFromBox(layout, fontSize),
          color,
          true,
          bold,
          this.resolveEquationFontFamily('text', layout.kind.text),
        );
        return;
      case 'number':
        this.drawEquationText(
          canvas,
          layout.kind.text,
          x,
          y + layout.baseline,
          this.equationFontSizeFromBox(layout, fontSize),
          color,
          false,
          bold,
          this.resolveEquationFontFamily('number', layout.kind.text),
        );
        return;
      case 'symbol':
        this.drawEquationTextCentered(
          canvas,
          layout.kind.text,
          x + layout.width / 2,
          y + layout.baseline,
          this.equationFontSizeFromBox(layout, fontSize),
          color,
          false,
          false,
          this.resolveEquationFontFamily('symbol', layout.kind.text),
        );
        return;
      case 'mathSymbol':
        this.drawEquationText(
          canvas,
          layout.kind.text,
          x,
          y + layout.baseline,
          this.equationFontSizeFromBox(layout, fontSize),
          color,
          false,
          false,
          this.resolveEquationFontFamily('mathSymbol', layout.kind.text),
        );
        return;
      case 'function':
        this.drawEquationText(
          canvas,
          layout.kind.name,
          x,
          y + layout.baseline,
          this.equationFontSizeFromBox(layout, fontSize),
          color,
          false,
          false,
          this.resolveEquationFontFamily('function', layout.kind.name),
        );
        return;
      case 'fraction':
        this.renderEquationBox(canvas, layout.kind.numer, x, y, color, fontSize, italic, bold);
        this.drawEquationLine(
          canvas,
          x + fontSize * 0.05,
          y + layout.baseline,
          x + layout.width - fontSize * 0.05,
          y + layout.baseline,
          color,
          fontSize * 0.04,
        );
        this.renderEquationBox(canvas, layout.kind.denom, x, y, color, fontSize, italic, bold);
        return;
      case 'sqrt': {
        const bodyLeft = x + layout.kind.body.x - fontSize * 0.1;
        const signHeight = layout.height;
        const midX = bodyLeft - fontSize * 0.15;
        const midY = y + signHeight;
        const startX = midX - fontSize * 0.3;
        const startY = y + signHeight * 0.6;
        const tickX = startX - fontSize * 0.1;
        const tickY = startY - fontSize * 0.05;
        const radical = new this.canvasKit.PathBuilder();
        radical.moveTo(tickX, tickY);
        radical.lineTo(startX, startY);
        radical.lineTo(midX, midY);
        radical.lineTo(bodyLeft, y);
        radical.lineTo(x + layout.width, y);
        this.drawEquationStrokePath(canvas, radical, color, fontSize * 0.04);
        if (layout.kind.index) {
          this.renderEquationBox(
            canvas,
            layout.kind.index,
            x,
            y,
            color,
            fontSize * EQUATION_SCRIPT_SCALE,
            false,
            false,
          );
        }
        this.renderEquationBox(canvas, layout.kind.body, x, y, color, fontSize, italic, bold);
        return;
      }
      case 'superscript':
        this.renderEquationBox(canvas, layout.kind.base, x, y, color, fontSize, italic, bold);
        this.renderEquationBox(canvas, layout.kind.sup, x, y, color, fontSize * EQUATION_SCRIPT_SCALE, italic, bold);
        return;
      case 'subscript':
        this.renderEquationBox(canvas, layout.kind.base, x, y, color, fontSize, italic, bold);
        this.renderEquationBox(canvas, layout.kind.sub, x, y, color, fontSize * EQUATION_SCRIPT_SCALE, italic, bold);
        return;
      case 'subSup':
        this.renderEquationBox(canvas, layout.kind.base, x, y, color, fontSize, italic, bold);
        this.renderEquationBox(canvas, layout.kind.sub, x, y, color, fontSize * EQUATION_SCRIPT_SCALE, italic, bold);
        this.renderEquationBox(canvas, layout.kind.sup, x, y, color, fontSize * EQUATION_SCRIPT_SCALE, italic, bold);
        return;
      case 'bigOp': {
        const opFontSize = fontSize * EQUATION_BIG_OP_SCALE;
        const supHeight = layout.kind.sup ? layout.kind.sup.height + fontSize * 0.05 : 0;
        const estimatedWidth = Array.from(layout.kind.symbol).length * opFontSize * 0.6;
        this.drawEquationText(
          canvas,
          layout.kind.symbol,
          x + (layout.width - estimatedWidth) / 2,
          y + supHeight + opFontSize * 0.8,
          opFontSize,
          color,
          false,
          false,
          this.resolveEquationFontFamily('mathSymbol', layout.kind.symbol),
        );
        if (layout.kind.sup) {
          this.renderEquationBox(canvas, layout.kind.sup, x, y, color, fontSize * EQUATION_SCRIPT_SCALE, false, false);
        }
        if (layout.kind.sub) {
          this.renderEquationBox(canvas, layout.kind.sub, x, y, color, fontSize * EQUATION_SCRIPT_SCALE, false, false);
        }
        return;
      }
      case 'limit':
        this.drawEquationText(
          canvas,
          layout.kind.isUpper ? 'Lim' : 'lim',
          x,
          y + this.equationFontSizeFromBox(layout, fontSize) * 0.8,
          this.equationFontSizeFromBox(layout, fontSize),
          color,
          false,
          false,
          this.resolveEquationFontFamily('function', layout.kind.isUpper ? 'Lim' : 'lim'),
        );
        if (layout.kind.sub) {
          this.renderEquationBox(canvas, layout.kind.sub, x, y, color, fontSize * EQUATION_SCRIPT_SCALE, false, false);
        }
        return;
      case 'matrix': {
        const brackets = layout.kind.style === 'paren' ? ['(', ')']
          : layout.kind.style === 'bracket' ? ['[', ']']
            : layout.kind.style === 'vert' ? ['|', '|']
              : ['', ''];
        if (brackets[0]) {
          this.drawEquationBracket(canvas, brackets[0], x, y, fontSize * 0.3, layout.height, color, fontSize);
          this.drawEquationBracket(canvas, brackets[1], x + layout.width - fontSize * 0.3, y, fontSize * 0.3, layout.height, color, fontSize);
        }
        for (const row of layout.kind.cells) {
          for (const cell of row) {
            this.renderEquationBox(canvas, cell, x, y, color, fontSize, italic, bold);
          }
        }
        return;
      }
      case 'rel':
        this.renderEquationBox(canvas, layout.kind.over, x, y, color, fontSize, italic, bold);
        this.renderEquationBox(canvas, layout.kind.arrow, x, y, color, fontSize, italic, bold);
        if (layout.kind.under) {
          this.renderEquationBox(canvas, layout.kind.under, x, y, color, fontSize, italic, bold);
        }
        return;
      case 'eqAlign':
        for (const row of layout.kind.rows) {
          this.renderEquationBox(canvas, row.left, x, y, color, fontSize, italic, bold);
          this.renderEquationBox(canvas, row.right, x, y, color, fontSize, italic, bold);
        }
        return;
      case 'paren':
        if (layout.kind.left) {
          this.drawEquationBracket(canvas, layout.kind.left, x, y, fontSize * 0.3, layout.height, color, fontSize);
        }
        this.renderEquationBox(canvas, layout.kind.body, x, y, color, fontSize, italic, bold);
        if (layout.kind.right) {
          this.drawEquationBracket(canvas, layout.kind.right, x + layout.width - fontSize * 0.3, y, fontSize * 0.3, layout.height, color, fontSize);
        }
        return;
      case 'decoration':
        this.renderEquationBox(canvas, layout.kind.body, x, y, color, fontSize, italic, bold);
        this.drawEquationDecoration(
          canvas,
          layout.kind.decoration,
          x + layout.kind.body.x + layout.kind.body.width / 2,
          y + fontSize * 0.05,
          layout.kind.body.width,
          color,
          fontSize,
        );
        return;
      case 'fontStyle': {
        const nextItalic = layout.kind.fontStyle === 'roman' ? false : layout.kind.fontStyle === 'italic' ? true : italic;
        const nextBold = layout.kind.fontStyle === 'roman' ? false : layout.kind.fontStyle === 'bold' ? true : bold;
        this.renderEquationBox(canvas, layout.kind.body, x, y, color, fontSize, nextItalic, nextBold);
        return;
      }
      case 'space':
      case 'newline':
      case 'empty':
        return;
    }
  }

  private drawEquationText(
    canvas: ReturnType<Surface['getCanvas']>,
    text: string,
    x: number,
    y: number,
    size: number,
    color: string,
    italic: boolean,
    bold: boolean,
    fontFamily: string,
  ): void {
    this.drawEquationTextAligned(
      canvas,
      text,
      x,
      y,
      size,
      color,
      italic,
      bold,
      fontFamily,
      false,
    );
  }

  private drawEquationTextAligned(
    canvas: ReturnType<Surface['getCanvas']>,
    text: string,
    anchorX: number,
    y: number,
    size: number,
    color: string,
    italic: boolean,
    bold: boolean,
    fontFamily: string,
    centered: boolean,
  ): void {
    const shaped = this.buildShapedSingleLineParagraph(
      text,
      [
        fontFamily,
        'Latin Modern Math',
        HAMCHOROM_BATANG_FAMILY,
        'Noto Serif KR',
        'Noto Serif CJK KR',
        'Noto Sans KR',
        'Noto Sans CJK KR',
      ],
      size,
      bold ? 700 : 400,
      italic,
      color,
      1,
    );
    if (shaped) {
      let shapedDrawn = false;
      try {
        const x = centered ? anchorX - shaped.width / 2 : anchorX;
        canvas.drawParagraph(shaped.paragraph, x, y - shaped.alphabeticBaseline);
        shapedDrawn = true;
      } catch {
        shapedDrawn = false;
      } finally {
        shaped.paragraph.delete();
      }
      if (shapedDrawn) {
        return;
      }
    }

    const { font, paint, typeface } = this.makeTextObjects(fontFamily, size, bold, italic, color);
    try {
      const glyphIds = font.getGlyphIDs(text);
      const glyphWidths = font.getGlyphWidths(glyphIds) ?? [];
      const measuredWidth = glyphWidths.reduce((sum, width) => sum + width, 0);
      const x = centered ? anchorX - measuredWidth / 2 : anchorX;
      canvas.drawText(text, x, y, paint, font);
    } finally {
      paint.delete();
      font.delete();
      typeface.delete();
    }
  }

  private drawEquationTextCentered(
    canvas: ReturnType<Surface['getCanvas']>,
    text: string,
    centerX: number,
    baselineY: number,
    size: number,
    color: string,
    italic: boolean,
    bold: boolean,
    fontFamily: string,
  ): void {
    this.drawEquationTextAligned(
      canvas,
      text,
      centerX,
      baselineY,
      size,
      color,
      italic,
      bold,
      fontFamily,
      true,
    );
  }

  private resolveEquationFontFamily(
    kind: 'text' | 'number' | 'symbol' | 'mathSymbol' | 'function',
    text: string,
  ): string {
    if (/[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(text)) {
      return HAMCHOROM_BATANG_FAMILY;
    }
    if (kind === 'text' || kind === 'number' || kind === 'function') {
      return HAMCHOROM_BATANG_FAMILY;
    }
    return 'Latin Modern Math';
  }

  private drawEquationLine(
    canvas: ReturnType<Surface['getCanvas']>,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: string,
    strokeWidth: number,
  ): void {
    const paint = this.makeEquationStrokePaint(color, strokeWidth);
    canvas.drawLine(x1, y1, x2, y2, paint);
    paint.delete();
  }

  private drawEquationBracket(
    canvas: ReturnType<Surface['getCanvas']>,
    bracket: string,
    x: number,
    y: number,
    width: number,
    height: number,
    color: string,
    fontSize: number,
  ): void {
    const midX = x + width / 2;
    if (bracket === '|') {
      this.drawEquationLine(canvas, midX, y, midX, y + height, color, fontSize * 0.04);
      return;
    }

    const builder = new this.canvasKit.PathBuilder();
    switch (bracket) {
      case '(':
        builder.moveTo(midX + width * 0.2, y);
        builder.quadTo(x, y + height / 2, midX + width * 0.2, y + height);
        break;
      case ')':
        builder.moveTo(midX - width * 0.2, y);
        builder.quadTo(x + width, y + height / 2, midX - width * 0.2, y + height);
        break;
      case '[':
        builder.moveTo(midX + width * 0.2, y);
        builder.lineTo(midX - width * 0.2, y);
        builder.lineTo(midX - width * 0.2, y + height);
        builder.lineTo(midX + width * 0.2, y + height);
        break;
      case ']':
        builder.moveTo(midX - width * 0.2, y);
        builder.lineTo(midX + width * 0.2, y);
        builder.lineTo(midX + width * 0.2, y + height);
        builder.lineTo(midX - width * 0.2, y + height);
        break;
      case '{': {
        const quarterHeight = height / 4;
        builder.moveTo(midX + width * 0.2, y);
        builder.quadTo(midX - width * 0.1, y, midX - width * 0.1, y + quarterHeight);
        builder.quadTo(
          midX - width * 0.1,
          y + quarterHeight * 2,
          midX - width * 0.3,
          y + quarterHeight * 2,
        );
        builder.quadTo(
          midX - width * 0.1,
          y + quarterHeight * 2,
          midX - width * 0.1,
          y + quarterHeight * 3,
        );
        builder.quadTo(midX - width * 0.1, y + height, midX + width * 0.2, y + height);
        break;
      }
      case '}': {
        const quarterHeight = height / 4;
        builder.moveTo(midX - width * 0.2, y);
        builder.quadTo(midX + width * 0.1, y, midX + width * 0.1, y + quarterHeight);
        builder.quadTo(
          midX + width * 0.1,
          y + quarterHeight * 2,
          midX + width * 0.3,
          y + quarterHeight * 2,
        );
        builder.quadTo(
          midX + width * 0.1,
          y + quarterHeight * 2,
          midX + width * 0.1,
          y + quarterHeight * 3,
        );
        builder.quadTo(midX + width * 0.1, y + height, midX - width * 0.2, y + height);
        break;
      }
      default:
        builder.delete();
        this.drawEquationTextCentered(
          canvas,
          bracket,
          midX,
          y + height * 0.7,
          height,
          color,
          false,
          false,
          this.resolveEquationFontFamily('symbol', bracket),
        );
        return;
    }
    this.drawEquationStrokePath(canvas, builder, color, fontSize * 0.04);
  }

  private makeEquationStrokePaint(color: string, strokeWidth: number): Paint {
    const paint = this.makePaint(color, 'stroke');
    paint.setStrokeWidth(strokeWidth);
    return paint;
  }

  private drawEquationStrokePath(
    canvas: ReturnType<Surface['getCanvas']>,
    builder: PathBuilder,
    color: string,
    strokeWidth: number,
  ): void {
    const path = builder.detach();
    builder.delete();
    const paint = this.makeEquationStrokePaint(color, strokeWidth);
    try {
      canvas.drawPath(path, paint);
    } finally {
      paint.delete();
      path.delete();
    }
  }

  private drawEquationDecoration(
    canvas: ReturnType<Surface['getCanvas']>,
    decoration: string,
    midX: number,
    y: number,
    width: number,
    color: string,
    fontSize: number,
  ): void {
    const strokeWidth = fontSize * 0.03;
    const halfWidth = width / 2;
    switch (decoration) {
      case 'hat': {
        const hat = new this.canvasKit.PathBuilder();
        hat.moveTo(midX - halfWidth * 0.6, y + fontSize * 0.15);
        hat.lineTo(midX, y);
        hat.lineTo(midX + halfWidth * 0.6, y + fontSize * 0.15);
        this.drawEquationStrokePath(canvas, hat, color, strokeWidth);
        return;
      }
      case 'bar':
      case 'overline':
        this.drawEquationLine(canvas, midX - halfWidth, y + fontSize * 0.05, midX + halfWidth, y + fontSize * 0.05, color, strokeWidth);
        return;
      case 'vec': {
        const arrowY = y + fontSize * 0.05;
        this.drawEquationLine(canvas, midX - halfWidth, arrowY, midX + halfWidth, arrowY, color, strokeWidth);
        const arrowHead = new this.canvasKit.PathBuilder();
        arrowHead.moveTo(
          midX + halfWidth - fontSize * 0.1,
          arrowY - fontSize * 0.06,
        );
        arrowHead.lineTo(midX + halfWidth, arrowY);
        arrowHead.lineTo(
          midX + halfWidth - fontSize * 0.1,
          arrowY + fontSize * 0.06,
        );
        this.drawEquationStrokePath(canvas, arrowHead, color, strokeWidth);
        return;
      }
      case 'tilde': {
        const tildeY = y + fontSize * 0.08;
        const tilde = new this.canvasKit.PathBuilder();
        tilde.moveTo(midX - halfWidth * 0.6, tildeY);
        tilde.quadTo(
          midX - halfWidth * 0.2,
          tildeY - fontSize * 0.08,
          midX,
          tildeY,
        );
        tilde.quadTo(
          midX + halfWidth * 0.2,
          tildeY + fontSize * 0.08,
          midX + halfWidth * 0.6,
          tildeY,
        );
        this.drawEquationStrokePath(canvas, tilde, color, strokeWidth);
        return;
      }
      case 'dot':
      case 'dDot': {
        const radius = fontSize * 0.03;
        const paint = this.makePaint(color, 'fill');
        if (decoration === 'dot') {
          canvas.drawCircle(midX, y + fontSize * 0.06, radius, paint);
        } else {
          const gap = fontSize * 0.1;
          canvas.drawCircle(midX - gap, y + fontSize * 0.06, radius, paint);
          canvas.drawCircle(midX + gap, y + fontSize * 0.06, radius, paint);
        }
        paint.delete();
        return;
      }
      case 'underline':
      case 'under':
        this.drawEquationLine(canvas, midX - halfWidth, y + fontSize * 1.1, midX + halfWidth, y + fontSize * 1.1, color, strokeWidth);
        return;
      default:
        this.drawEquationLine(canvas, midX - halfWidth * 0.5, y + fontSize * 0.1, midX + halfWidth * 0.5, y + fontSize * 0.1, color, strokeWidth);
    }
  }

  private equationFontSizeFromBox(
    layout: LayerEquationLayoutBox,
    baseFontSize: number,
  ): number {
    return layout.height > 0 ? layout.height : baseFontSize;
  }

  private drawEncodedImage(
    canvas: ReturnType<Surface['getCanvas']>,
    resourceId: number | undefined,
    base64: string | undefined,
    bbox: LayerBounds,
    fillMode = 'fitToSize',
    originalSize?: { width: number; height: number },
    crop?: { left: number; top: number; right: number; bottom: number },
    effect: LayerImageOp['effect'] = 'realPic',
    brightness = 0,
    contrast = 0,
    originalSizeHu?: [number, number],
    opacity = 1,
  ): void {
    const imageDimension = (source: Image, dimension: 'width' | 'height'): number | null => {
      const value = (source as Image & { width?: unknown; height?: unknown })[dimension];
      if (typeof value === 'function') {
        return (value as () => number).call(source);
      }
      return typeof value === 'number' ? value : null;
    };
    const usesImageEffect = !!effect && effect !== 'realPic';
    const usesImageTone = brightness !== 0 || contrast !== 0;
    const imageOpacity = Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1;
    const baseImage = this.resourceCache.image(resourceId, base64);
    if (!baseImage) return;
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

    const baseWidth = imageDimension(baseImage, 'width');
    const baseHeight = imageDimension(baseImage, 'height');
    if (
      baseWidth === null
      || baseHeight === null
      || !Number.isFinite(baseWidth)
      || !Number.isFinite(baseHeight)
      || baseWidth <= 0
      || baseHeight <= 0
    ) {
      const paint = new this.canvasKit.Paint();
      paint.setAntiAlias?.(true);
      paint.setAlphaf(imageOpacity);
      canvas.drawImage(baseImage, bbox.x, bbox.y, paint);
      paint.delete();
      return;
    }
    const effectCropSource = (usesImageEffect || usesImageTone) && canPreprocessCroppedLayerImageEffect(fillMode)
      ? resolveLayerImageCropSource(baseWidth, baseHeight, crop, originalSizeHu)
      : null;
    const effectImage = usesImageEffect || usesImageTone
      ? this.resourceCache.imageWithEffect(resourceId, base64, effect, effectCropSource, brightness, contrast)
      : baseImage;
    const image = effectImage ?? baseImage;
    const effectWasApplied = image !== baseImage;
    const sourceWidth = imageDimension(image, 'width');
    const sourceHeight = imageDimension(image, 'height');
    if (
      sourceWidth === null
      || sourceHeight === null
      || !Number.isFinite(sourceWidth)
      || !Number.isFinite(sourceHeight)
      || sourceWidth <= 0
      || sourceHeight <= 0
    ) {
      return;
    }
    const cropWasPreprocessed = effectWasApplied
      && !!effectCropSource
      && Math.abs(sourceWidth - Math.max(1, Math.round(effectCropSource.width))) <= 1
      && Math.abs(sourceHeight - Math.max(1, Math.round(effectCropSource.height))) <= 1;
    const cropSource = cropWasPreprocessed
      ? null
      : resolveLayerImageCropSource(sourceWidth, sourceHeight, crop, originalSizeHu);
    const drawImageRect = (
      srcX: number,
      srcY: number,
      srcW: number,
      srcH: number,
      dstX: number,
      dstY: number,
      dstW: number,
      dstH: number,
    ) => {
      if (
        !Number.isFinite(srcX)
        || !Number.isFinite(srcY)
        || !Number.isFinite(srcW)
        || !Number.isFinite(srcH)
        || !Number.isFinite(dstX)
        || !Number.isFinite(dstY)
        || !Number.isFinite(dstW)
        || !Number.isFinite(dstH)
        || srcW <= 0
        || srcH <= 0
        || dstW <= 0
        || dstH <= 0
      ) {
        return;
      }
      const useMipmaps =
        !effectWasApplied
        && this.currentProfile !== 'fast-preview'
        && !this.hasActiveCacheHint('preferRaster')
        && (
          this.renderMode === 'compat'
          || this.currentProfile === 'print'
          || this.currentProfile === 'high-quality'
        )
        && (srcW > dstW * 1.2 || srcH > dstH * 1.2);
      const sampledImage = useMipmaps ? this.resourceCache.image(resourceId, base64, true) ?? image : image;
      const paint = new this.canvasKit.Paint();
      paint.setAlphaf(imageOpacity);
      canvas.drawImageRectOptions(
        sampledImage,
        this.canvasKit.XYWHRect(srcX, srcY, srcW, srcH),
        this.canvasKit.XYWHRect(dstX, dstY, dstW, dstH),
        effectWasApplied ? this.canvasKit.FilterMode.Nearest : this.canvasKit.FilterMode.Linear,
        useMipmaps ? this.canvasKit.MipmapMode.Linear : this.canvasKit.MipmapMode.None,
        paint,
      );
      paint.delete();
    };
    const drawImage = (dstX: number, dstY: number, dstW: number, dstH: number) => {
      if (cropSource) {
        drawImageRect(cropSource.x, cropSource.y, cropSource.width, cropSource.height, dstX, dstY, dstW, dstH);
        return;
      }
      drawImageRect(0, 0, sourceWidth, sourceHeight, dstX, dstY, dstW, dstH);
    };

    if (fillMode === 'fitToSize' || fillMode === 'total' || fillMode === 'none') {
      drawImage(bbox.x, bbox.y, bbox.width, bbox.height);
      return;
    }

    let imageWidth = originalSize?.width ?? sourceWidth;
    let imageHeight = originalSize?.height ?? sourceHeight;
    if (
      !Number.isFinite(imageWidth)
      || !Number.isFinite(imageHeight)
      || imageWidth <= 0
      || imageHeight <= 0
    ) {
      imageWidth = sourceWidth;
      imageHeight = sourceHeight;
    }
    const { x, y } = resolveImagePlacement(fillMode, bbox, imageWidth, imageHeight);

    canvas.save();
    try {
      canvas.clipRect(this.toRect(bbox), this.canvasKit.ClipOp.Intersect, true);

      if (fillMode === 'tileAll' || fillMode === 'tileHorzTop' || fillMode === 'tileHorzBottom' || fillMode === 'tileVertLeft' || fillMode === 'tileVertRight') {
        const maxTileDraws = CanvasKitLayerRenderer.MAX_IMAGE_TILE_DRAWS;
        let tileDraws = 0;
        if (fillMode === 'tileAll') {
          for (let ty = bbox.y; ty < bbox.y + bbox.height && tileDraws < maxTileDraws; ty += imageHeight) {
            for (let tx = bbox.x; tx < bbox.x + bbox.width && tileDraws < maxTileDraws; tx += imageWidth) {
              drawImage(tx, ty, imageWidth, imageHeight);
              tileDraws += 1;
            }
          }
        } else if (fillMode === 'tileHorzTop' || fillMode === 'tileHorzBottom') {
          const ty = fillMode === 'tileHorzTop' ? bbox.y : bbox.y + bbox.height - imageHeight;
          for (let tx = bbox.x; tx < bbox.x + bbox.width && tileDraws < maxTileDraws; tx += imageWidth) {
            drawImage(tx, ty, imageWidth, imageHeight);
            tileDraws += 1;
          }
        } else {
          const tx = fillMode === 'tileVertLeft' ? bbox.x : bbox.x + bbox.width - imageWidth;
          for (let ty = bbox.y; ty < bbox.y + bbox.height && tileDraws < maxTileDraws; ty += imageHeight) {
            drawImage(tx, ty, imageWidth, imageHeight);
            tileDraws += 1;
          }
        }
      } else {
        drawImage(x, y, imageWidth, imageHeight);
      }
    } finally {
      canvas.restore();
    }
  }

  private drawTabLeaders(canvas: ReturnType<Surface['getCanvas']>, leaders: LayerTabLeader[], originX: number, baselineY: number, color: string): void {
    for (const leader of leaders) {
      for (const segment of tabLeaderLineSegments(leader.fillType)) {
        const paint = this.makePaint(color, 'stroke');
        paint.setStrokeWidth(segment.width);
        paint.setStrokeCap(
          segment.cap === 'round'
            ? this.canvasKit.StrokeCap.Round
            : this.canvasKit.StrokeCap.Butt,
        );
        if (segment.dash.length) {
          const effect = this.canvasKit.PathEffect.MakeDash(segment.dash, 0);
          paint.setPathEffect(effect);
          effect.delete();
        }
        const y = baselineY + 1 + segment.offsetY;
        canvas.drawLine(originX + leader.startX, y, originX + leader.endX, y, paint);
        paint.delete();
      }
    }
  }

  private drawTextDecorationLine(
    canvas: ReturnType<Surface['getCanvas']>,
    x1: number,
    x2: number,
    y: number,
    color: string,
    shape: number | undefined,
  ): void {
    for (const primitive of textDecorationLineGeometry(shape ?? 0)) {
      const paint = this.makePaint(color, 'stroke');
      paint.setStrokeWidth(primitive.width);
      if (primitive.kind === 'line') {
        if (
          primitive.cap === 'round'
          && primitive.dash.length === 2
          && primitive.dash[0] <= 0.1
        ) {
          paint.delete();
          const dotPaint = this.makePaint(color, 'fill');
          const period = primitive.dash[0] + primitive.dash[1];
          const centerOffset = primitive.dash[0] / 2;
          for (let x = x1 + centerOffset; x <= x2; x += period) {
            canvas.drawCircle(x, y + primitive.offsetY, primitive.width / 2, dotPaint);
          }
          dotPaint.delete();
          continue;
        }
        paint.setStrokeCap(
          primitive.cap === 'round'
            ? this.canvasKit.StrokeCap.Round
            : this.canvasKit.StrokeCap.Butt,
        );
        if (primitive.dash.length) {
          const effect = this.canvasKit.PathEffect.MakeDash(primitive.dash, 0);
          paint.setPathEffect(effect);
          effect.delete();
        }
        canvas.drawLine(
          x1,
          y + primitive.offsetY,
          x2,
          y + primitive.offsetY,
          paint,
        );
        paint.delete();
        continue;
      }
      const lineY = y + primitive.offsetY;
      const builder = new this.canvasKit.PathBuilder();
      builder.moveTo(x1, lineY);
      let currentX = x1;
      let upward = true;
      while (currentX < x2) {
        const nextX = Math.min(currentX + primitive.wavelength, x2);
        builder.quadTo(
          (currentX + nextX) / 2,
          lineY + (upward ? -primitive.amplitude : primitive.amplitude),
          nextX,
          lineY,
        );
        currentX = nextX;
        upward = !upward;
      }
      const path = builder.detach();
      builder.delete();
      canvas.drawPath(path, paint);
      path.delete();
      paint.delete();
    }
  }

  private makePath(commands: LayerPathCommand[]) {
    const builder = new this.canvasKit.PathBuilder();
    let hasCurrentPoint = false;
    for (const command of commands) {
      switch (command.type) {
        case 'moveTo':
          builder.moveTo(command.x, command.y);
          hasCurrentPoint = true;
          break;
        case 'lineTo':
          if (hasCurrentPoint) {
            builder.lineTo(command.x, command.y);
          } else {
            builder.moveTo(command.x, command.y);
          }
          hasCurrentPoint = true;
          break;
        case 'curveTo':
          if (!hasCurrentPoint) {
            builder.moveTo(command.x1, command.y1);
          }
          builder.cubicTo(command.x1, command.y1, command.x2, command.y2, command.x3, command.y3);
          hasCurrentPoint = true;
          break;
        case 'arcTo':
          if (!hasCurrentPoint) {
            builder.moveTo(command.x, command.y);
            hasCurrentPoint = true;
            break;
          }
          builder.arcToRotated(command.rx, command.ry, command.rotation, !command.largeArc, !command.sweep, command.x, command.y);
          break;
        case 'closePath':
          builder.close();
          break;
      }
    }
    const path = builder.detach();
    builder.delete();
    return path;
  }

  private applyPathFillRule(path: Path, fillRule: CanvasFillRule | undefined): void {
    path.setFillType(fillRule === 'evenodd' ? this.canvasKit.FillType.EvenOdd : this.canvasKit.FillType.Winding);
  }

  private makeTextObjects(
    fontFamily: string,
    fontSize: number,
    bold: boolean,
    italic: boolean,
    color: string,
    scaleX = 1,
    weightOverride?: RenderFontWeight,
  ): { typeface: Typeface; font: Font; paint: Paint } {
    const weight = weightOverride ?? resolveRenderFontWeight(fontFamily, bold);
    const providerFace = this.fontRegistry.resolveProviderFace(fontFamily, weight, italic);
    const typeface = this.fontProvider.matchFamilyStyle(providerFace.providerFamily, {
      weight: providerFace.physicalWeight === 300
        ? this.canvasKit.FontWeight.Light
        : providerFace.physicalWeight === 500
          ? this.canvasKit.FontWeight.Medium
          : providerFace.physicalWeight === 700
            ? this.canvasKit.FontWeight.Bold
            : this.canvasKit.FontWeight.Normal,
      slant: providerFace.physicalItalic
        ? this.canvasKit.FontSlant.Italic
        : this.canvasKit.FontSlant.Upright,
    });
    const font = new this.canvasKit.Font(typeface, fontSize || 12);
    font.setEmbolden(providerFace.synthesizeBold);
    font.setScaleX(scaleX > 0 ? scaleX : 1);
    font.setSkewX(providerFace.synthesizeItalic ? -0.25 : 0);
    font.setSubpixel(true);
    if (fontSize >= 48 && bold && !italic) {
      font.setEdging(this.canvasKit.FontEdging.SubpixelAntiAlias);
      font.setHinting(this.canvasKit.FontHinting.Slight);
    }
    const paint = this.makePaint(color, 'fill');
    return { typeface, font, paint };
  }

  private resolveCanvasKitFontFamily(fontFamily: string): string {
    return this.fontRegistry.resolveFamily(fontFamily);
  }

  private recordTextFontSubstitutionDiagnostic(
    diagnostic: CanvasKitTextFontSubstitutionDiagnostic,
  ): void {
    const diagnosticKey = JSON.stringify([
      diagnostic.opId,
      diagnostic.requestedFamily,
      diagnostic.resolvedFamily,
      diagnostic.source,
    ]);
    if (
      this.textFontSubstitutionDiagnostics.has(diagnosticKey)
      || this.textFontSubstitutionDiagnostics.size < MAX_TEXT_FONT_SUBSTITUTION_DIAGNOSTICS
    ) {
      this.textFontSubstitutionDiagnostics.set(diagnosticKey, diagnostic);
    }
  }

  private makePaint(color: string, style: 'fill' | 'stroke', opacity = 1): Paint {
    const paint = new this.canvasKit.Paint();
    paint.setAntiAlias(true);
    paint.setStyle(style === 'fill' ? this.canvasKit.PaintStyle.Fill : this.canvasKit.PaintStyle.Stroke);
    paint.setColor(parseCanvasKitCssColor(this.canvasKit, color, opacity));
    return paint;
  }

  private canvasKitStrokeJoin(join: CanvasLineJoin | undefined): StrokeJoin {
    switch (join) {
      case 'round':
        return this.canvasKit.StrokeJoin.Round;
      case 'bevel':
        return this.canvasKit.StrokeJoin.Bevel;
      case 'miter':
      default:
        return this.canvasKit.StrokeJoin.Miter;
    }
  }

  private canvasKitStrokeCap(cap: CanvasLineCap | undefined): StrokeCap {
    switch (cap) {
      case 'round':
        return this.canvasKit.StrokeCap.Round;
      case 'square':
        return this.canvasKit.StrokeCap.Square;
      case 'butt':
      default:
        return this.canvasKit.StrokeCap.Butt;
    }
  }

  private makeResolvedColorPaint(fill: { rgba: [number, number, number, number] }): Paint {
    const paint = new this.canvasKit.Paint();
    paint.setAntiAlias(true);
    paint.setStyle(this.canvasKit.PaintStyle.Fill);
    paint.setColor(resolvedColorUnitRgba(fill) as any);
    return paint;
  }

  private makeLinePaint(color: string, width: number, dash: string, opacity = 1): Paint {
    const paint = this.makePaint(color, 'stroke', opacity);
    const strokeWidth = Math.max(width, 0.5);
    paint.setStrokeWidth(strokeWidth);

    const intervals = strokeDashPattern(dash, strokeWidth);
    if (intervals.length > 0) {
      const effect = this.canvasKit.PathEffect.MakeDash(intervals, 0);
      paint.setPathEffect(effect);
      effect.delete();
    }

    return paint;
  }

  private makeShapeFillPaint(
    bounds: LayerBounds,
    fillColor: string | null | undefined,
    opacity: number,
    gradient?: LayerGradient,
    pattern?: LayerPatternFill,
  ): { paint: Paint; shader: Shader | null } | null {
    let shader = gradient ? this.makeGradientShader(gradient, bounds) : null;
    if (!shader && pattern) {
      shader = this.makePatternShader(pattern);
    }
    if (!shader && !fillColor) {
      return null;
    }

    const paint = this.makePaint(fillColor ?? '#ffffff', 'fill', opacity);
    if (shader) {
      paint.setShader(shader);
    }
    return { paint, shader };
  }

  private makeGradientShader(gradient: LayerGradient, bounds: LayerBounds): Shader | null {
    if (gradient.colors.length < 2) {
      return null;
    }

    const stops = gradientColorStops(gradient.colors, gradient.positions);
    const colors = stops.map((stop) => parseCanvasKitCssColor(this.canvasKit, stop.color));
    const positions = stops.map((stop) => stop.position);
    if (gradient.gradientType === 2 || gradient.gradientType === 3 || gradient.gradientType === 4) {
      const cx = bounds.x + bounds.width * (gradient.centerX / 100);
      const cy = bounds.y + bounds.height * (gradient.centerY / 100);
      const radius = Math.max(bounds.width, bounds.height) / 2;
      return this.canvasKit.Shader.MakeRadialGradient(
        [cx, cy],
        radius,
        colors,
        positions,
        this.canvasKit.TileMode.Clamp,
      );
    }

    const [x0, y0, x1, y1] = angleToCanvasCoords(gradient.angle, bounds.x, bounds.y, bounds.width, bounds.height);
    return this.canvasKit.Shader.MakeLinearGradient(
      [x0, y0],
      [x1, y1],
      colors,
      positions,
      this.canvasKit.TileMode.Clamp,
    );
  }

  private makePatternShader(pattern: LayerPatternFill): Shader | null {
    const image = this.resourceCache.patternImage(pattern);
    return image
      ? image.makeShaderOptions(
        this.canvasKit.TileMode.Repeat,
        this.canvasKit.TileMode.Repeat,
        this.canvasKit.FilterMode.Nearest,
        this.canvasKit.MipmapMode.None,
      )
      : null;
  }

  private drawShadow(
    canvas: ReturnType<Surface['getCanvas']>,
    shadow: LayerShapeShadow | undefined,
    style: 'fill' | 'stroke',
    color: string,
    strokeWidth: number,
    sourceOpacity: number,
    draw: (paint: Paint) => void,
    dash = 'solid',
  ): void {
    if (!shadow) {
      return;
    }

    const opacity = (shadow.alpha > 0 ? 1 - (shadow.alpha / 255) : 1) * sourceOpacity;
    const paint = style === 'stroke'
      ? this.makeLinePaint(color, strokeWidth, dash, opacity)
      : this.makePaint(color, style, opacity);
    const blur = this.canvasKit.MaskFilter.MakeBlur(this.canvasKit.BlurStyle.Normal, 1, false);
    paint.setMaskFilter(blur);
    blur.delete();

    canvas.save();
    canvas.translate(shadow.offsetX, shadow.offsetY);
    draw(paint);
    canvas.restore();
    paint.delete();
  }

  private withTransform(
    canvas: ReturnType<Surface['getCanvas']>,
    bbox: LayerBounds,
    transform: { rotation: number; horzFlip: boolean; vertFlip: boolean },
    draw: () => void,
  ): void {
    if (!transform.rotation && !transform.horzFlip && !transform.vertFlip) {
      draw();
      return;
    }

    const cx = bbox.x + bbox.width / 2;
    const cy = bbox.y + bbox.height / 2;

    canvas.save();
    if (transform.horzFlip) {
      canvas.translate(cx * 2, 0);
      canvas.scale(-1, 1);
    }
    if (transform.vertFlip) {
      canvas.translate(0, cy * 2);
      canvas.scale(1, -1);
    }
    if (transform.rotation) {
      canvas.rotate(transform.rotation, cx, cy);
    }
    draw();
    canvas.restore();
  }

  private clearStaticPictureCache(): void {
    this.staticPictureCache.clear();
  }

  private invalidateTextFontCaches(): void {
    for (const blob of this.textBlobCache.values()) blob.delete();
    this.textBlobCache.clear();
    this.textBlobCacheHits = 0;
    this.textBlobCacheMisses = 0;
    this.textFallbackFamilyCache.clear();
    this.textFallbackFamilyCacheHits = 0;
    this.textFallbackFamilyCacheMisses = 0;
    this.resetTextReplayDiagnostics();
    this.clearStaticPictureCache();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.lastRenderedTree = null;
    this.lastTargetCanvas = null;
    this.lastScale = 1;
    this.currentProfile = 'screen';
    this.currentLayerTreeCacheKey = 'none';
    this.currentClipStack.length = 0;
    this.currentCacheHintStack.length = 0;
    this.currentClipEnabled = true;
    this.clearPreparedSvgGlyphPaths();

    this.invalidateTextFontCaches();
    this.resetEquationReplayDiagnostics();

    this.surfaceCache.dispose();
    this.resourceCache.dispose();
    this.fontRegistry.clear();
    this.fontProvider.delete();
  }

  private toRect(bounds: LayerBounds) {
    return this.canvasKit.XYWHRect(bounds.x, bounds.y, bounds.width, bounds.height);
  }
}

function drawArrowHead(
  canvasKit: CanvasKit,
  canvas: ReturnType<Surface['getCanvas']>,
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

  const fillPaint = new canvasKit.Paint();
  fillPaint.setAntiAlias(true);
  fillPaint.setStyle(canvasKit.PaintStyle.Fill);
  fillPaint.setColor(parseCanvasKitCssColor(canvasKit, color));

  const strokePaint = new canvasKit.Paint();
  strokePaint.setAntiAlias(true);
  strokePaint.setStyle(canvasKit.PaintStyle.Stroke);
  strokePaint.setColor(parseCanvasKitCssColor(canvasKit, color));
  strokePaint.setStrokeWidth(Math.max(strokeWidth * 0.3, 0.5));

  if (shape.kind === 'polygon') {
    const builder = new canvasKit.PathBuilder();
    const [firstPoint, ...remainingPoints] = shape.points;
    builder.moveTo(firstPoint[0], firstPoint[1]);
    for (const [x, y] of remainingPoints) {
      builder.lineTo(x, y);
    }
    builder.close();
    const path = builder.detach();
    if (shape.fill === 'solid') {
      canvas.drawPath(path, fillPaint);
    } else {
      const whiteFill = new canvasKit.Paint();
      whiteFill.setAntiAlias(true);
      whiteFill.setStyle(canvasKit.PaintStyle.Fill);
      whiteFill.setColor(parseCanvasKitCssColor(canvasKit, 'white'));
      canvas.drawPath(path, whiteFill);
      canvas.drawPath(path, strokePaint);
      whiteFill.delete();
    }
    path.delete();
    builder.delete();
    fillPaint.delete();
    strokePaint.delete();
    return;
  }

  if (shape.kind === 'ellipse') {
    if (shape.fill === 'solid') {
      canvas.drawOval(canvasKit.LTRBRect(
        shape.centerX - shape.radiusX,
        shape.centerY - shape.radiusY,
        shape.centerX + shape.radiusX,
        shape.centerY + shape.radiusY,
      ), fillPaint);
    } else {
      const whiteFill = new canvasKit.Paint();
      whiteFill.setAntiAlias(true);
      whiteFill.setStyle(canvasKit.PaintStyle.Fill);
      whiteFill.setColor(parseCanvasKitCssColor(canvasKit, 'white'));
      const oval = canvasKit.LTRBRect(
        shape.centerX - shape.radiusX,
        shape.centerY - shape.radiusY,
        shape.centerX + shape.radiusX,
        shape.centerY + shape.radiusY,
      );
      canvas.drawOval(oval, whiteFill);
      canvas.drawOval(oval, strokePaint);
      whiteFill.delete();
    }
    fillPaint.delete();
    strokePaint.delete();
    return;
  }
}
