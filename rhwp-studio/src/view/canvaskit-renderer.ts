import CanvasKitInit from 'canvaskit-wasm';
import type { CanvasKit, ColorFilter, Font, Image, Paint, Shader, Surface, TextBlob, Typeface, TypefaceFontProvider } from 'canvaskit-wasm';
import canvaskitWasmUrl from 'canvaskit-wasm/bin/canvaskit.wasm?url';

import type { CanvasKitRenderMode } from '@/view/render-backend';
import type {
  LayerBounds,
  LayerCacheHint,
  LayerClipNode,
  LayerEllipseOp,
  LayerEquationLayoutBox,
  LayerEquationOp,
  LayerFootnoteMarkerOp,
  LayerFormObjectOp,
  LayerGradient,
  LayerImageOp,
  LayerLeafNode,
  LayerLineOp,
  LayerLineStyle,
  LayerNode,
  LayerPageBackgroundOp,
  LayerPaintOp,
  LayerPathCommand,
  LayerPathOp,
  LayerPatternFill,
  LayerRectangleOp,
  LayerRenderProfile,
  LayerShapeShadow,
  LayerTabLeader,
  LayerTextRunOp,
  PageLayerTree,
} from '@/core/types';
import {
  angleToCanvasCoords,
  buildCanvasTextFont,
  calculateArrowDimensions,
  computePathPaintBounds,
  isHalfwidthScaledCluster,
  renderEquationLayoutBox,
  splitIntoClusters,
  startsWithInvalidControl,
} from './layer-canvas-utils';
import { CanvasKitFontRegistry, HAMCHOROM_BATANG_FAMILY } from './canvaskit/fonts';
import {
  canvaskitClipRightPad,
  shouldOverlayRasterImage,
  shouldOverlayRectangle as shouldOverlayRectanglePolicy,
  shouldOverlayTextRun as shouldOverlayTextRunPolicy,
  shouldOverlayVectorEquation,
} from './canvaskit/policy';
import { CanvasKitResourceCache } from './canvaskit/resource-cache';
import { CanvasKitStaticPictureCache } from './canvaskit/static-picture-cache';
import { CanvasKitSurfaceCache } from './canvaskit/surface-cache';

const EQUATION_SCRIPT_SCALE = 0.7;
const EQUATION_BIG_OP_SCALE = 1.5;
const MAX_TEXT_BLOB_CACHE_ENTRIES = 4096;

type OverlayClip = {
  bounds: LayerBounds;
  kind: LayerClipNode['clipKind'];
  rightOverflowSlop: number;
  allowHorizontalOverflowControls: boolean;
};

export class CanvasKitLayerRenderer {
  private readonly resourceCache: CanvasKitResourceCache;
  private readonly surfaceCache: CanvasKitSurfaceCache;
  private readonly fontRegistry: CanvasKitFontRegistry;
  private readonly imageCache: Map<string, Image>;
  private readonly mipmappedImageCache: Map<string, Image>;
  private readonly domImageCache: Map<string, HTMLImageElement>;
  private readonly equationSvgDomImageCache: Map<string, HTMLImageElement>;
  private readonly equationSvgImageCache: Map<string, Image>;
  private readonly patternImageCache: Map<string, Image | null>;
  private readonly fontAliases: Set<string>;
  private readonly staticPictureCache = new CanvasKitStaticPictureCache();
  private readonly textBlobCache = new Map<string, TextBlob>();
  private textBlobCacheHits = 0;
  private textBlobCacheMisses = 0;
  private readonly currentClipStack: OverlayClip[] = [];
  private readonly currentCacheHintStack: LayerCacheHint[] = [];
  private currentClipEnabled = true;
  private lastRenderedTree: PageLayerTree | null = null;
  private lastTargetCanvas: HTMLCanvasElement | null = null;
  private lastScale = 1;
  private currentProfile: LayerRenderProfile = 'screen';
  private currentLayerTreeCacheKey = 'none';
  private rerenderScheduled = false;
  private disposed = false;
  private asyncResourceReadyCallback: (() => void) | null = null;

  private constructor(
    private readonly canvasKit: CanvasKit,
    private readonly fontProvider: TypefaceFontProvider,
    private readonly renderMode: CanvasKitRenderMode,
  ) {
    this.resourceCache = new CanvasKitResourceCache(canvasKit, () => this.scheduleRerender());
    this.surfaceCache = new CanvasKitSurfaceCache(canvasKit);
    this.fontRegistry = new CanvasKitFontRegistry(fontProvider);
    this.imageCache = this.resourceCache.imageCache;
    this.mipmappedImageCache = this.resourceCache.mipmappedImageCache;
    this.domImageCache = this.resourceCache.domImageCache;
    this.equationSvgDomImageCache = this.resourceCache.equationSvgDomImageCache;
    this.equationSvgImageCache = this.resourceCache.equationSvgImageCache;
    this.patternImageCache = this.resourceCache.patternImageCache;
    this.fontAliases = this.fontRegistry.aliases;
  }

  static async create(renderMode: CanvasKitRenderMode = 'compat'): Promise<CanvasKitLayerRenderer> {
    const canvasKit = await CanvasKitInit({
      locateFile: (file) => file === 'canvaskit.wasm' ? canvaskitWasmUrl : file,
    });
    const fontProvider = canvasKit.TypefaceFontProvider.Make();
    const renderer = new CanvasKitLayerRenderer(canvasKit, fontProvider, renderMode);
    await renderer.fontRegistry.registerFonts();
    return renderer;
  }

  renderPage(
    tree: PageLayerTree,
    targetCanvas: HTMLCanvasElement,
    scale: number,
  ): void {
    if (this.disposed) {
      throw new Error('CanvasKit renderer가 이미 dispose되었습니다');
    }

    this.lastRenderedTree = tree;
    this.lastTargetCanvas = targetCanvas;
    this.lastScale = scale;
    this.currentProfile = tree.profile;
    this.currentLayerTreeCacheKey = this.staticPictureCache.cacheKeyForLayerTree(tree);
    this.resourceCache.setResources(tree.resources);
    this.currentClipEnabled = tree.outputOptions?.clipEnabled ?? true;
    this.currentClipStack.length = 0;
    this.currentCacheHintStack.length = 0;

    const { surface, usedGpuSurface } = this.surfaceCache.get(targetCanvas);

    let renderError: unknown = null;
    try {
      this.renderSurface(surface, tree, scale);
      this.renderFallbackOverlays(tree.root, targetCanvas, scale);
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

    this.renderSurface(fallbackSurface, tree, scale);
    this.renderFallbackOverlays(tree.root, targetCanvas, scale);
  }

  setAsyncResourceReadyCallback(callback: (() => void) | null): void {
    this.asyncResourceReadyCallback = callback;
  }

  private renderSurface(surface: Surface, tree: PageLayerTree, scale: number): void {
    const canvas = surface.getCanvas();
    canvas.clear(this.canvasKit.TRANSPARENT);
    canvas.save();
    canvas.scale(scale, scale);
    this.renderNode(canvas, tree.root);
    canvas.restore();
    surface.flush();
  }

  private renderNode(
    canvas: ReturnType<Surface['getCanvas']>,
    node: LayerNode,
  ): void {
    switch (node.kind) {
      case 'group':
        this.withCacheHint(node.cacheHint, () => {
          if (node.cacheHint === 'staticSubtree') {
            const cacheKey = this.staticPictureCache.keyForStaticSubtree(
              this.currentLayerTreeCacheKey,
              this.currentProfile,
              node,
            );
            const cachedPicture = this.staticPictureCache.get(cacheKey);
            if (cachedPicture) {
              canvas.drawPicture(cachedPicture);
              return;
            }

            const recorder = new this.canvasKit.PictureRecorder();
            try {
              const recordingCanvas = recorder.beginRecording(this.toRect(node.bounds), true);
              for (const child of node.children) {
                this.renderNode(recordingCanvas, child);
              }
              const picture = recorder.finishRecordingAsPicture();
              this.staticPictureCache.set(cacheKey, picture);
              canvas.drawPicture(picture);
            } finally {
              recorder.delete();
            }
            return;
          }
          for (const child of node.children) {
            this.renderNode(canvas, child);
          }
        });
        break;
      case 'clipRect':
        this.renderClipNode(canvas, node);
        break;
      case 'leaf':
        this.withCacheHint(node.cacheHint, () => {
          this.renderLeafNode(canvas, node);
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
  ): void {
    if (!this.currentClipEnabled) {
      this.renderNode(canvas, node.child);
      return;
    }
    const clip = this.overlayClipForNode(node);
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
    this.renderNode(canvas, node.child);
    canvas.restore();
    this.currentClipStack.pop();
  }

  private overlayClipForNode(node: LayerClipNode): OverlayClip {
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
  ): void {
    for (const op of node.ops) {
      this.renderOp(canvas, op);
    }
  }

  private renderOp(
    canvas: ReturnType<Surface['getCanvas']>,
    op: LayerPaintOp,
  ): void {
    switch (op.type) {
      case 'pageBackground':
        this.renderPageBackground(canvas, op);
        return;
      case 'textRun':
        if (this.shouldOverlayTextRun(op)) {
          return;
        }
        this.renderTextRun(canvas, op);
        return;
      case 'footnoteMarker':
        if (this.shouldOverlayFootnoteMarker(op)) {
          return;
        }
        this.renderFootnoteMarker(canvas, op);
        return;
      case 'line':
        if (this.shouldOverlayLine(op)) {
          return;
        }
        this.renderLine(canvas, op);
        return;
      case 'rectangle':
        if (this.shouldOverlayRectangle(op)) {
          return;
        }
        this.renderRectangle(canvas, op);
        return;
      case 'ellipse':
        this.renderEllipse(canvas, op);
        return;
      case 'path':
        this.renderPath(canvas, op);
        return;
      case 'image':
        if (this.shouldOverlayImage(op)) {
          return;
        }
        this.renderImage(canvas, op);
        return;
      case 'equation':
        if (this.shouldOverlayEquation(op)) {
          return;
        }
        this.renderEquation(canvas, op);
        return;
      case 'formObject':
        if (this.shouldOverlayFormObject(op)) {
          return;
        }
        this.renderFormObject(canvas, op);
        return;
    }
  }

  private shouldOverlayTextRun(op: LayerTextRunOp): boolean {
    const insideTableCell = this.currentClipStack.some((clip) => clip.kind === 'tableCell');
    return shouldOverlayTextRunPolicy(op, {
      renderMode: this.renderMode,
      profile: this.currentProfile,
      insideTableCell,
      hasCacheHint: (cacheHint) => this.hasActiveCacheHint(cacheHint),
    });
  }

  private shouldOverlayFootnoteMarker(_op: LayerFootnoteMarkerOp): boolean {
    return false;
  }

  private shouldOverlayLine(_op: LayerLineOp): boolean {
    return false;
  }

  private shouldOverlayRectangle(op: LayerRectangleOp): boolean {
    return shouldOverlayRectanglePolicy(op, {
      renderMode: this.renderMode,
      profile: this.currentProfile,
      insideTableCell: this.currentClipStack.some((clip) => clip.kind === 'tableCell'),
      hasCacheHint: (cacheHint) => this.hasActiveCacheHint(cacheHint),
    });
  }

  private shouldOverlayFormObject(_op: LayerFormObjectOp): boolean {
    return this.renderMode === 'compat';
  }

  private formPalette(op: LayerFormObjectOp): {
    backColor: string;
    foreColor: string;
    borderColor: string;
    buttonBackColor: string;
    buttonFaceColor: string;
  } {
    return {
      backColor: op.backColor || '#ffffff',
      foreColor: op.enabled ? op.foreColor : '#808080',
      borderColor: op.enabled ? '#808080' : '#bebebe',
      buttonBackColor: op.backColor || (op.enabled ? '#d0d0d0' : '#e0e0e0'),
      buttonFaceColor: op.enabled ? '#c0c0c0' : '#e0e0e0',
    };
  }

  private shouldOverlayImage(_op: LayerImageOp): boolean {
    return shouldOverlayRasterImage({
      renderMode: this.renderMode,
      profile: this.currentProfile,
      insideTableCell: this.currentClipStack.some((clip) => clip.kind === 'tableCell'),
      hasCacheHint: (cacheHint) => this.hasActiveCacheHint(cacheHint),
    });
  }

  private shouldOverlayEquation(_op: LayerEquationOp): boolean {
    return shouldOverlayVectorEquation({
      renderMode: this.renderMode,
      profile: this.currentProfile,
      insideTableCell: this.currentClipStack.some((clip) => clip.kind === 'tableCell'),
      hasCacheHint: (cacheHint) => this.hasActiveCacheHint(cacheHint),
    });
  }

  private renderPageBackground(canvas: ReturnType<Surface['getCanvas']>, op: LayerPageBackgroundOp): void {
    const fill = this.makeShapeFillPaint(op.bbox, op.backgroundColor ?? null, 1, op.gradient);
    if (fill) {
      canvas.drawRect(this.toRect(op.bbox), fill.paint);
      fill.shader?.delete();
      fill.paint.delete();
    }

    if (op.image && this.renderMode !== 'compat') {
      this.drawEncodedImage(canvas, op.image.resourceId, op.image.base64, op.bbox, op.image.fillMode);
    }

    if (op.borderColor && op.borderWidth > 0) {
      const paint = this.makePaint(op.borderColor, 'stroke');
      paint.setStrokeWidth(op.borderWidth);
      canvas.drawRect(this.toRect(op.bbox), paint);
      paint.delete();
    }
  }

  private renderTextRun(canvas: ReturnType<Surface['getCanvas']>, op: LayerTextRunOp): void {
    const ratio = typeof op.style.ratio === 'number' && op.style.ratio > 0 ? op.style.ratio : 1;
    const hasRatio = Math.abs(ratio - 1) > 0.01;
    const outlineType = op.style.outlineType ?? 0;
    const shadowType = op.style.shadowType ?? 0;
    const shadowColor = typeof op.style.shadowColor === 'string' ? op.style.shadowColor : op.style.color;
    const shadowOffsetX = typeof op.style.shadowOffsetX === 'number' ? op.style.shadowOffsetX : 0;
    const shadowOffsetY = typeof op.style.shadowOffsetY === 'number' ? op.style.shadowOffsetY : 0;
    const emboss = !!op.style.emboss;
    const engrave = !!op.style.engrave;
    const emphasisDot = op.style.emphasisDot ?? 0;
    const shadeColor = (typeof op.style.shadeColor === 'string' ? op.style.shadeColor : '#ffffff').toLowerCase();
    const primaryObjects = this.makeTextObjects(
      op.style.fontFamily,
      op.style.fontSize,
      op.style.bold,
      op.style.italic,
      op.style.color,
      1,
    );
    const clusters = splitIntoClusters(op.text);
    const textObjectsByFamily = new Map<string, { typeface: Typeface; font: Font; paint: Paint }>();
    textObjectsByFamily.set(op.style.fontFamily, primaryObjects);
    const fallbackFamilies = [
      op.style.fontFamily,
      'Noto Sans KR',
      'Noto Sans CJK KR',
      'NanumGothic',
      'D2Coding',
      'NanumGothicCoding',
      'Noto Serif KR',
      'Noto Serif CJK KR',
    ].filter((family, index, all) => all.indexOf(family) === index);
    const clusterFonts: Font[] = [];
    const clusterFontKeys: string[] = [];
    for (const cluster of clusters) {
      let selectedFont = primaryObjects.font;
      let selectedFontFamily = op.style.fontFamily;
      const primaryGlyphs = primaryObjects.font.getGlyphIDs(cluster.text);
      if (primaryGlyphs?.some((glyphId) => glyphId === 0)) {
        for (const family of fallbackFamilies) {
          let candidate = textObjectsByFamily.get(family);
          if (!candidate) {
            candidate = this.makeTextObjects(
              family,
              op.style.fontSize,
              op.style.bold,
              op.style.italic,
              op.style.color,
              1,
            );
            textObjectsByFamily.set(family, candidate);
          }
          const candidateGlyphs = candidate.font.getGlyphIDs(cluster.text);
          if (candidateGlyphs && candidateGlyphs.every((glyphId) => glyphId !== 0)) {
            selectedFont = candidate.font;
            selectedFontFamily = family;
            break;
          }
        }
      }
      clusterFonts.push(selectedFont);
      clusterFontKeys.push([
        this.fontRegistry.resolveFamily(selectedFontFamily),
        op.style.fontSize.toFixed(3),
        op.style.bold ? 'bold' : 'normal',
        op.style.italic ? 'italic' : 'upright',
      ].join('|'));
    }
    const drawClusters = (originX: number, originY: number) => {
      const textWidth = op.positions.at(-1) ?? 0;
      if (textWidth > 0 && shadeColor !== '#ffffff') {
        const shadePaint = this.makePaint(shadeColor, 'fill');
        canvas.drawRect(
          this.canvasKit.XYWHRect(originX, originY - op.style.fontSize, textWidth, op.style.fontSize * 1.2),
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
          const x = originX + op.positions[cluster.start] + dx;
          const y = originY + dy;
          const drawBlobAtOrigin = () => {
            const cacheKey = `${clusterFontKeys[index]}|${cluster.text}`;
            let blob = this.textBlobCache.get(cacheKey);
            if (blob) {
              this.textBlobCacheHits += 1;
              this.textBlobCache.delete(cacheKey);
              this.textBlobCache.set(cacheKey, blob);
            } else {
              blob = this.canvasKit.TextBlob.MakeFromText(cluster.text, clusterFonts[index]);
              if (!blob) {
                return;
              }
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
            if (!blob) {
              return;
            }
            canvas.drawTextBlob(blob, 0, 0, fillPaint);
            if (strokePaint) {
              canvas.drawTextBlob(blob, 0, 0, strokePaint);
            }
          };
          if (isHalfwidthScaledCluster(cluster.text) && !hasRatio) {
            canvas.save();
            canvas.translate(x, y);
            canvas.scale(0.5, 1);
            drawBlobAtOrigin();
            canvas.restore();
            continue;
          }
          if (hasRatio) {
            canvas.save();
            canvas.translate(x, y);
            canvas.scale(ratio, 1);
            drawBlobAtOrigin();
            canvas.restore();
            continue;
          }
          const cacheKey = `${clusterFontKeys[index]}|${cluster.text}`;
          let blob = this.textBlobCache.get(cacheKey);
          if (blob) {
            this.textBlobCacheHits += 1;
            this.textBlobCache.delete(cacheKey);
            this.textBlobCache.set(cacheKey, blob);
          } else {
            blob = this.canvasKit.TextBlob.MakeFromText(cluster.text, clusterFonts[index]);
            if (!blob) {
              continue;
            }
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
          if (!blob) {
            continue;
          }
          canvas.drawTextBlob(blob, x, y, fillPaint);
          if (strokePaint) {
            canvas.drawTextBlob(blob, x, y, strokePaint);
          }
        }
      };

      if (emboss || engrave) {
        const offset = Math.max(op.style.fontSize / 20, 1);
        const firstPaint = this.makePaint(emboss ? '#ffffff' : '#808080', 'fill');
        const secondPaint = this.makePaint(emboss ? '#808080' : '#ffffff', 'fill');
        drawPass(-offset, -offset, firstPaint);
        drawPass(offset, offset, secondPaint);
        drawPass(0, 0, primaryObjects.paint);
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
          strokePaint.setStrokeWidth(Math.max(op.style.fontSize / 25, 0.5));
          drawPass(0, 0, fillPaint, strokePaint);
          fillPaint.delete();
          strokePaint.delete();
        } else {
          drawPass(0, 0, primaryObjects.paint);
        }
      }

      if (emphasisDot > 0) {
        const dotChar =
          emphasisDot === 1 ? '●'
            : emphasisDot === 2 ? '○'
              : emphasisDot === 3 ? 'ˇ'
                : emphasisDot === 4 ? '˜'
                  : emphasisDot === 5 ? '･'
                    : emphasisDot === 6 ? '˸'
                      : '';
        if (dotChar) {
          const dotSize = op.style.fontSize * 0.3;
          const dotY = originY - op.style.fontSize * 1.05;
          const dotObjects = this.makeTextObjects('Noto Sans KR', dotSize, false, false, op.style.color);
          for (const position of op.positions.slice(0, -1)) {
            const dotX = originX + position + (op.style.fontSize * ratio * 0.5);
            canvas.drawText(dotChar, dotX, dotY, dotObjects.paint, dotObjects.font);
          }
          dotObjects.paint.delete();
          dotObjects.font.delete();
          dotObjects.typeface.delete();
        }
      }

      if (op.tabLeaders?.length) {
        this.drawTabLeaders(canvas, op.tabLeaders, originX, originY, op.style.color);
      }

      if (op.style.underline !== 'none') {
        const underlinePaint = this.makePaint(op.style.underlineColor || op.style.color, 'stroke');
        underlinePaint.setStrokeWidth(1);
        const y = op.style.underline === 'top' ? originY - op.style.fontSize + 1 : originY + 2;
        canvas.drawLine(originX, y, originX + textWidth, y, underlinePaint);
        underlinePaint.delete();
      }
      if (op.style.strikethrough) {
        const strikePaint = this.makePaint(op.style.strikeColor || op.style.color, 'stroke');
        strikePaint.setStrokeWidth(1);
        const y = originY - op.style.fontSize * 0.3;
        canvas.drawLine(originX, y, originX + textWidth, y, strikePaint);
        strikePaint.delete();
      }

      if (op.controlMarks?.length) {
        for (const mark of op.controlMarks) {
          const markObjects = this.makeTextObjects('Noto Sans KR', mark.fontSize, false, false, '#4A90D9');
          canvas.drawText(mark.text, originX + mark.x, originY + mark.y, markObjects.paint, markObjects.font);
          markObjects.paint.delete();
          markObjects.font.delete();
          markObjects.typeface.delete();
        }
      }
    };

    const textRotation = op.isVertical ? op.rotation + 90 : op.rotation;
    if (textRotation !== 0) {
      const cx = op.bbox.x + op.bbox.width / 2;
      const cy = op.bbox.y + op.bbox.height / 2;
      canvas.save();
      canvas.translate(cx, cy);
      canvas.rotate(textRotation, 0, 0);
      drawClusters(-op.bbox.width / 2, -op.bbox.height / 2 + op.baseline);
      canvas.restore();
    } else {
      drawClusters(op.bbox.x, op.bbox.y + op.baseline);
    }

    for (const { paint, font, typeface } of textObjectsByFamily.values()) {
      paint.delete();
      font.delete();
      typeface.delete();
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
        if (strokeWidth < 0.5) {
          paint.setStrokeWidth(strokeWidth);
        }
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
            (shadowPaint) => canvas.drawLine(lineX1 + offsetX, lineY1 + offsetY, lineX2 + offsetX, lineY2 + offsetY, shadowPaint),
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
      const strokePaint = op.style.strokeColor ? this.makeLinePaint(op.style.strokeColor, op.style.strokeWidth, op.style.strokeDash, op.style.opacity) : null;
      const rect = this.toRect(op.bbox);
      const drawRect = (paint: Paint) => {
        if (op.cornerRadius > 0) {
          canvas.drawRRect(this.canvasKit.RRectXY(rect, op.cornerRadius, op.cornerRadius), paint);
          return;
        }
        canvas.drawRect(rect, paint);
      };

      if (op.style.shadow) {
        this.drawShadow(
          canvas,
          op.style.shadow,
          fill ? 'fill' : 'stroke',
          op.style.shadow.color,
          op.style.strokeWidth,
          drawRect,
        );
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
      const strokePaint = op.style.strokeColor ? this.makeLinePaint(op.style.strokeColor, op.style.strokeWidth, op.style.strokeDash, op.style.opacity) : null;
      const oval = this.toRect(op.bbox);
      const drawOval = (paint: Paint) => canvas.drawOval(oval, paint);

      if (op.style.shadow) {
        this.drawShadow(
          canvas,
          op.style.shadow,
          fill ? 'fill' : 'stroke',
          op.style.shadow.color,
          op.style.strokeWidth,
          drawOval,
        );
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
      const strokePaint = op.style.strokeColor ? this.makeLinePaint(op.style.strokeColor, op.style.strokeWidth, op.style.strokeDash, op.style.opacity) : null;
      const drawPath = (paint: Paint) => canvas.drawPath(path, paint);

      if (op.style.shadow) {
        this.drawShadow(
          canvas,
          op.style.shadow,
          fill ? 'fill' : 'stroke',
          op.style.shadow.color,
          op.style.strokeWidth,
          drawPath,
        );
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
    if (this.renderMode === 'compat') {
      return;
    }
    this.withTransform(canvas, op.bbox, op.transform, () => {
      this.drawEncodedImage(canvas, op.resourceId, op.base64, op.bbox, op.fillMode, op.originalSize, op.crop, op.effect);
    });
  }

  private renderFormObject(
    canvas: ReturnType<Surface['getCanvas']>,
    op: LayerFormObjectOp,
  ): void {
    const { x, y, width: w, height: h } = op.bbox;
    const palette = this.formPalette(op);

    switch (op.formType) {
      case 'pushButton': {
        const fillPaint = this.makePaint(palette.buttonBackColor, 'fill');
        const strokePaint = this.makeLinePaint(palette.borderColor, 0.5, 'solid');
        canvas.drawRect(this.toRect(op.bbox), fillPaint);
        canvas.drawRect(this.toRect(op.bbox), strokePaint);
        fillPaint.delete();
        strokePaint.delete();

        if (op.caption) {
          const fontSize = Math.min(Math.max(h * 0.5, 8), 12);
          const family = this.fontRegistry.resolveFamily('sans-serif');
          const { font, paint, typeface } = this.makeTextObjects(family, fontSize, false, false, palette.foreColor);
          const metrics = font.getMetrics();
          const cssFont = buildCanvasTextFont(family, fontSize, false, false);
          const textWidth = (globalThis as any).measureTextWidth?.(cssFont, op.caption) ?? op.caption.length * fontSize * 0.55;
          const baselineY = y + h / 2 - ((metrics.ascent ?? -fontSize * 0.8) + (metrics.descent ?? fontSize * 0.2)) / 2;
          canvas.drawText(op.caption, x + w / 2 - textWidth / 2, baselineY, paint, font);
          paint.delete();
          font.delete();
          typeface.delete();
        }
        return;
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
          const fontSize = Math.min(Math.max(h * 0.7, 8), 12);
          const family = this.fontRegistry.resolveFamily('sans-serif');
          const { font, paint, typeface } = this.makeTextObjects(family, fontSize, false, false, palette.foreColor);
          const metrics = font.getMetrics();
          const baselineY = y + h / 2 - ((metrics.ascent ?? -fontSize * 0.8) + (metrics.descent ?? fontSize * 0.2)) / 2;
          canvas.drawText(op.caption, boxX + boxSize + 4, baselineY, paint, font);
          paint.delete();
          font.delete();
          typeface.delete();
        }
        return;
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
          const fontSize = Math.min(Math.max(h * 0.7, 8), 12);
          const family = this.fontRegistry.resolveFamily('sans-serif');
          const { font, paint, typeface } = this.makeTextObjects(family, fontSize, false, false, palette.foreColor);
          const metrics = font.getMetrics();
          const baselineY = y + h / 2 - ((metrics.ascent ?? -fontSize * 0.8) + (metrics.descent ?? fontSize * 0.2)) / 2;
          canvas.drawText(op.caption, x + r * 2 + 4, baselineY, paint, font);
          paint.delete();
          font.delete();
          typeface.delete();
        }
        return;
      }
      case 'comboBox': {
        const btnW = Math.min(h, 20);
        const fillPaint = this.makePaint(palette.backColor, 'fill');
        const strokePaint = this.makeLinePaint(palette.borderColor, 1, 'solid');
        canvas.drawRect(this.canvasKit.XYWHRect(x, y, w - btnW, h), fillPaint);
        canvas.drawRect(this.canvasKit.XYWHRect(x, y, w - btnW, h), strokePaint);
        fillPaint.delete();
        strokePaint.delete();

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

        if (op.text) {
          const fontSize = Math.min(Math.max(h * 0.6, 8), 12);
          const family = this.fontRegistry.resolveFamily('sans-serif');
          const { font, paint, typeface } = this.makeTextObjects(family, fontSize, false, false, palette.foreColor);
          const metrics = font.getMetrics();
          const baselineY = y + h / 2 - ((metrics.ascent ?? -fontSize * 0.8) + (metrics.descent ?? fontSize * 0.2)) / 2;
          canvas.drawText(op.text, x + 2, baselineY, paint, font);
          paint.delete();
          font.delete();
          typeface.delete();
        }
        return;
      }
      case 'edit': {
        const fillPaint = this.makePaint(palette.backColor, 'fill');
        const strokePaint = this.makeLinePaint(palette.borderColor, 1, 'solid');
        canvas.drawRect(this.toRect(op.bbox), fillPaint);
        canvas.drawRect(this.toRect(op.bbox), strokePaint);
        fillPaint.delete();
        strokePaint.delete();

        if (op.text) {
          const fontSize = Math.min(Math.max(h * 0.6, 8), 12);
          const family = this.fontRegistry.resolveFamily('sans-serif');
          const { font, paint, typeface } = this.makeTextObjects(family, fontSize, false, false, palette.foreColor);
          const metrics = font.getMetrics();
          const baselineY = y + h / 2 - ((metrics.ascent ?? -fontSize * 0.8) + (metrics.descent ?? fontSize * 0.2)) / 2;
          canvas.drawText(op.text, x + 2, baselineY, paint, font);
          paint.delete();
          font.delete();
          typeface.delete();
        }
      }
    }
  }

  private renderEquation(
    canvas: ReturnType<Surface['getCanvas']>,
    op: LayerEquationOp,
  ): void {
    const svgContent = this.resourceCache.svgFragment(op.svgResourceId, op.svgContent);
    if (svgContent && op.bbox.width > 0 && op.bbox.height > 0) {
      const svgWidth = Math.max(op.bbox.width, 1);
      const svgHeight = Math.max(op.bbox.height, 1);
      const svgCacheKey = this.resourceCache.svgResourceCacheKey(op.svgResourceId, op.svgContent);
      const cacheKey = `${svgWidth.toFixed(3)}x${svgHeight.toFixed(3)}:${svgCacheKey ?? 'inline-svg:missing'}`;
      const cachedImage = this.resourceCache.equationSvgImage(cacheKey);
      if (cachedImage) {
        this.drawCanvasKitImage(canvas, cachedImage, op.bbox);
        return;
      }

      let domImage = this.resourceCache.equationSvgDomImage(cacheKey);
      if (domImage?.complete && domImage.naturalWidth > 0 && domImage.naturalHeight > 0) {
        try {
          const image = this.canvasKit.MakeImageFromCanvasImageSource(domImage);
          this.resourceCache.setEquationSvgImage(cacheKey, image);
          this.drawCanvasKitImage(canvas, image, op.bbox);
          return;
        } catch {
          // Fall through to the layout-box renderer if the browser cannot decode the SVG image.
        }
      } else if (!domImage) {
        domImage = new Image();
        domImage.decoding = 'sync';
        domImage.onload = () => this.scheduleRerender();
        domImage.onerror = () => {
          this.resourceCache.deleteEquationSvgDomImage(cacheKey);
        };
        const svgDocument =
          `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth.toFixed(2)}" height="${svgHeight.toFixed(2)}" viewBox="0 0 ${svgWidth.toFixed(2)} ${svgHeight.toFixed(2)}">${svgContent}</svg>`;
        domImage.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgDocument)}`;
        this.resourceCache.setEquationSvgDomImage(cacheKey, domImage);
      }
    }

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
          layout.width,
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
          layout.width,
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
          layout.width,
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
          layout.width,
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
          layout.width,
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
        this.drawEquationLine(canvas, tickX, tickY, startX, startY, color, fontSize * 0.04);
        this.drawEquationLine(canvas, startX, startY, midX, midY, color, fontSize * 0.04);
        this.drawEquationLine(canvas, midX, midY, bodyLeft, y, color, fontSize * 0.04);
        this.drawEquationLine(canvas, bodyLeft, y, x + layout.width, y, color, fontSize * 0.04);
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
        this.drawEquationTextCentered(
          canvas,
          layout.kind.symbol,
          x + layout.width / 2,
          y + supHeight + opFontSize * 0.8,
          opFontSize,
          color,
          false,
          false,
          this.resolveEquationFontFamily('mathSymbol', layout.kind.symbol),
          layout.width,
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
          layout.width,
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
    targetWidth: number,
  ): void {
    const { font, paint, typeface } = this.makeTextObjects(fontFamily, size, bold, italic, color);
    const glyphIds = font.getGlyphIDs(text);
    const glyphWidths = font.getGlyphWidths(glyphIds) ?? [];
    const measuredWidth = glyphWidths.reduce((sum, width) => sum + width, 0);
    if (targetWidth > 0 && measuredWidth > 0) {
      font.setScaleX(targetWidth / measuredWidth);
    }
    canvas.drawText(text, x, y, paint, font);
    paint.delete();
    font.delete();
    typeface.delete();
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
    targetWidth: number,
  ): void {
    this.drawEquationText(
      canvas,
      text,
      centerX - targetWidth / 2,
      baselineY,
      size,
      color,
      italic,
      bold,
      fontFamily,
      targetWidth,
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
    const paint = this.makeLinePaint(color, Math.max(strokeWidth, 0.5), 'solid');
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
    if (bracket === '|') {
      this.drawEquationLine(canvas, x + width / 2, y, x + width / 2, y + height, color, fontSize * 0.04);
      return;
    }
    this.drawEquationTextCentered(
      canvas,
      bracket,
      x + width / 2,
      y + height * 0.7,
      Math.max(height, fontSize),
      color,
      false,
      false,
      this.resolveEquationFontFamily('symbol', bracket),
      width,
    );
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
    const strokeWidth = Math.max(fontSize * 0.03, 0.5);
    const halfWidth = width / 2;
    switch (decoration) {
      case 'hat':
        this.drawEquationLine(canvas, midX - halfWidth * 0.6, y + fontSize * 0.15, midX, y, color, strokeWidth);
        this.drawEquationLine(canvas, midX, y, midX + halfWidth * 0.6, y + fontSize * 0.15, color, strokeWidth);
        return;
      case 'bar':
      case 'overline':
        this.drawEquationLine(canvas, midX - halfWidth, y + fontSize * 0.05, midX + halfWidth, y + fontSize * 0.05, color, strokeWidth);
        return;
      case 'vec': {
        const arrowY = y + fontSize * 0.05;
        this.drawEquationLine(canvas, midX - halfWidth, arrowY, midX + halfWidth, arrowY, color, strokeWidth);
        this.drawEquationLine(canvas, midX + halfWidth - fontSize * 0.1, arrowY - fontSize * 0.06, midX + halfWidth, arrowY, color, strokeWidth);
        this.drawEquationLine(canvas, midX + halfWidth, arrowY, midX + halfWidth - fontSize * 0.1, arrowY + fontSize * 0.06, color, strokeWidth);
        return;
      }
      case 'tilde': {
        const leftX = midX - halfWidth * 0.6;
        const rightX = midX + halfWidth * 0.6;
        const midLeftX = midX - halfWidth * 0.2;
        const midRightX = midX + halfWidth * 0.2;
        const baseY = y + fontSize * 0.08;
        this.drawEquationLine(canvas, leftX, baseY, midLeftX, baseY - fontSize * 0.08, color, strokeWidth);
        this.drawEquationLine(canvas, midLeftX, baseY - fontSize * 0.08, midX, baseY, color, strokeWidth);
        this.drawEquationLine(canvas, midX, baseY, midRightX, baseY + fontSize * 0.08, color, strokeWidth);
        this.drawEquationLine(canvas, midRightX, baseY + fontSize * 0.08, rightX, baseY, color, strokeWidth);
        return;
      }
      case 'dot':
      case 'dDot': {
        const radius = Math.max(fontSize * 0.03, 1);
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

  private renderFallbackOverlays(node: LayerNode, targetCanvas: HTMLCanvasElement, scale: number): void {
    if (!this.hasFallbackOverlayNode(node)) {
      return;
    }

    const ctx = targetCanvas.getContext('2d');
    if (!ctx) {
      return;
    }
    ctx.save();
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    this.renderFallbackOverlayNode(ctx, node);
    ctx.restore();
  }

  private hasFallbackOverlayNode(node: LayerNode): boolean {
    if (node.kind === 'group') {
      this.currentCacheHintStack.push(node.cacheHint);
      try {
        return node.children.some((child) => this.hasFallbackOverlayNode(child));
      } finally {
        this.currentCacheHintStack.pop();
      }
    }
    if (node.kind === 'clipRect') {
      if (!this.currentClipEnabled) {
        return this.hasFallbackOverlayNode(node.child);
      }
      this.currentClipStack.push(this.overlayClipForNode(node));
      try {
        return this.hasFallbackOverlayNode(node.child);
      } finally {
        this.currentClipStack.pop();
      }
    }

    this.currentCacheHintStack.push(node.cacheHint);
    try {
      return node.ops.some((op) => {
        if (
          this.renderMode === 'compat'
          && op.type === 'pageBackground'
          && op.image
        ) {
          return true;
        }
        if (op.type === 'image') {
          return this.shouldOverlayImage(op);
        }
        if (op.type === 'line') {
          return this.shouldOverlayLine(op);
        }
        if (op.type === 'rectangle') {
          return this.shouldOverlayRectangle(op);
        }
        if (op.type === 'formObject') {
          return this.shouldOverlayFormObject(op);
        }
        if (op.type === 'equation') {
          return this.shouldOverlayEquation(op);
        }
        if (op.type === 'textRun') {
          return this.shouldOverlayTextRun(op);
        }
        if (op.type === 'footnoteMarker') {
          return this.shouldOverlayFootnoteMarker(op);
        }
        return false;
      });
    } finally {
      this.currentCacheHintStack.pop();
    }
  }

  private renderFallbackOverlayNode(ctx: CanvasRenderingContext2D, node: LayerNode): void {
    if (node.kind === 'group') {
      this.withCacheHint(node.cacheHint, () => {
        for (const child of node.children) {
          this.renderFallbackOverlayNode(ctx, child);
        }
      });
      return;
    }
    if (node.kind === 'clipRect') {
      if (!this.currentClipEnabled) {
        this.renderFallbackOverlayNode(ctx, node.child);
        return;
      }
      this.currentClipStack.push(this.overlayClipForNode(node));
      this.renderFallbackOverlayNode(ctx, node.child);
      this.currentClipStack.pop();
      return;
    }
    this.withCacheHint(node.cacheHint, () => {
      for (const op of node.ops) {
        if (
          this.renderMode === 'compat'
          && op.type === 'pageBackground'
          && op.image
        ) {
          this.withCurrentOverlayClip(ctx, 0, () => {
            this.renderPageBackgroundImageOverlay(ctx, op);
          }, op.bbox);
          continue;
        }
        if (op.type === 'image' && this.shouldOverlayImage(op)) {
          this.withCurrentOverlayClip(ctx, 0, () => {
            this.renderImageOverlay(ctx, op);
          }, op.bbox);
          continue;
        }
        if (op.type === 'line' && this.shouldOverlayLine(op)) {
          const clipBounds = {
            x: op.bbox.x,
            y: op.bbox.y,
            width: op.bbox.width,
            height: op.bbox.height,
          };
          this.withCurrentOverlayClip(ctx, 0, () => {
            this.renderLineOverlay(ctx, op);
          }, clipBounds);
          continue;
        }
        if (op.type === 'rectangle' && this.shouldOverlayRectangle(op)) {
          this.withCurrentOverlayClip(ctx, 0, () => {
            this.renderRectangleOverlay(ctx, op);
          }, op.bbox);
          continue;
        }
        if (op.type === 'formObject' && this.shouldOverlayFormObject(op)) {
          this.withCurrentOverlayClip(ctx, 0, () => {
            this.renderFormObjectOverlay(ctx, op);
          }, op.bbox);
          continue;
        }
        if (op.type === 'equation' && this.shouldOverlayEquation(op)) {
          this.withCurrentOverlayClip(ctx, 0, () => {
            renderEquationLayoutBox(ctx, op.layoutBox, op.bbox.x, op.bbox.y, op.color, op.fontSize, false, false);
          }, op.bbox);
          continue;
        }
        if (op.type === 'textRun' && this.shouldOverlayTextRun(op)) {
          this.withCurrentOverlayClip(ctx, 0, () => {
            this.renderTextRunOverlay(ctx, op);
          }, op.bbox);
          continue;
        }
        if (op.type === 'footnoteMarker' && this.shouldOverlayFootnoteMarker(op)) {
          this.withCurrentOverlayClip(ctx, 0, () => {
            this.renderFootnoteMarkerOverlay(ctx, op);
          }, op.bbox);
        }
      }
    });
  }

  private renderPageBackgroundImageOverlay(ctx: CanvasRenderingContext2D, op: LayerPageBackgroundOp): void {
    if (!op.image) {
      return;
    }
    const image = this.resourceCache.domImage(op.image.resourceId, op.image.base64);
    if (!image) {
      return;
    }
    this.drawDomImage(ctx, image, op.bbox, op.image.fillMode);
  }

  private renderImageOverlay(ctx: CanvasRenderingContext2D, op: LayerImageOp): void {
    const image = this.resourceCache.domImage(op.resourceId, op.base64);
    if (!image) {
      return;
    }

    this.withCanvasOverlayTransform(ctx, op.bbox, op.transform, () => {
      const previousFilter = ctx.filter;
      try {
        switch (op.effect) {
          case 'grayScale':
          case 'pattern8x8':
            ctx.filter = 'grayscale(1)';
            break;
          case 'blackWhite':
            ctx.filter = 'grayscale(1) contrast(3200%)';
            break;
          default:
            ctx.filter = 'none';
            break;
        }
        this.drawDomImage(ctx, image, op.bbox, op.fillMode, op.originalSize, op.crop);
      } finally {
        ctx.filter = previousFilter;
      }
    });
  }

  private renderLineOverlay(ctx: CanvasRenderingContext2D, op: LayerLineOp): void {
    this.withCanvasOverlayTransform(ctx, op.bbox, op.transform, () => {
      ctx.save();
      const strokeWidth = Math.max(op.style.width, 0.5);
      ctx.beginPath();
      ctx.moveTo(op.x1, op.y1);
      ctx.lineTo(op.x2, op.y2);
      ctx.strokeStyle = op.style.color;
      ctx.lineWidth = strokeWidth;
      ctx.setLineDash(this.strokeDashPattern(op.style.dash, strokeWidth));
      ctx.stroke();
      ctx.restore();
    });
  }

  private renderRectangleOverlay(ctx: CanvasRenderingContext2D, op: LayerRectangleOp): void {
    this.withCanvasOverlayTransform(ctx, op.bbox, op.transform, () => {
      ctx.save();
      if (op.style.opacity < 1) {
        ctx.globalAlpha = op.style.opacity;
      }
      if (op.style.fillColor) {
        ctx.fillStyle = op.style.fillColor;
        ctx.fillRect(op.bbox.x, op.bbox.y, op.bbox.width, op.bbox.height);
      }
      if (op.style.strokeColor) {
        ctx.strokeStyle = op.style.strokeColor;
        ctx.lineWidth = Math.max(op.style.strokeWidth, 0.5);
        ctx.setLineDash(this.strokeDashPattern(op.style.strokeDash, op.style.strokeWidth));
        ctx.strokeRect(op.bbox.x, op.bbox.y, op.bbox.width, op.bbox.height);
      }
      ctx.restore();
    });
  }

  private renderFormObjectOverlay(ctx: CanvasRenderingContext2D, op: LayerFormObjectOp): void {
    const { x, y, width: w, height: h } = op.bbox;
    const palette = this.formPalette(op);
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
        const r = Math.min(h, 14) / 2;
        const cx = x + r;
        const cy = y + h / 2;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = palette.backColor;
        ctx.fill();
        ctx.strokeStyle = palette.borderColor;
        ctx.lineWidth = 1;
        ctx.stroke();
        if (op.value !== 0) {
          ctx.beginPath();
          ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2);
          ctx.fillStyle = palette.foreColor;
          ctx.fill();
        }
        if (op.caption) {
          const fontSize = Math.min(Math.max(h * 0.7, 8), 12);
          ctx.font = `${fontSize}px sans-serif`;
          ctx.fillStyle = palette.foreColor;
          ctx.textBaseline = 'middle';
          ctx.fillText(op.caption, x + r * 2 + 4, y + h / 2);
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
    }

    ctx.restore();
  }

  private withCanvasOverlayTransform(
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

  private drawDomImage(
    ctx: CanvasRenderingContext2D,
    image: HTMLImageElement,
    bbox: LayerBounds,
    fillMode = 'fitToSize',
    originalSize?: { width: number; height: number },
    crop?: { left: number; top: number; right: number; bottom: number },
  ): void {
    const imageWidth = image.naturalWidth || image.width;
    const imageHeight = image.naturalHeight || image.height;
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
    const cropSource = crop
      ? (() => {
        const scaleX = crop.right / imageWidth;
        const scaleY = crop.bottom / imageHeight;
        if (scaleX <= 0 || scaleY <= 0) {
          return null;
        }
        const srcX = crop.left / scaleX;
        const srcY = crop.top / scaleY;
        const srcW = (crop.right - crop.left) / scaleX;
        const srcH = (crop.bottom - crop.top) / scaleY;
        const isCropped = srcX > 0.5 || srcY > 0.5 || Math.abs(srcW - imageWidth) > 1 || Math.abs(srcH - imageHeight) > 1;
        return isCropped && srcW > 0 && srcH > 0
          ? { x: srcX, y: srcY, width: srcW, height: srcH }
          : null;
      })()
      : null;
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

    if (fillMode === 'fitToSize' || fillMode === 'none') {
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
    const { x, y } = this.resolveImagePlacement(fillMode, bbox, placedWidth, placedHeight);

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
  }

  private scheduleRerender(): void {
    if (this.asyncResourceReadyCallback && this.lastTargetCanvas?.parentElement) {
      this.asyncResourceReadyCallback();
      return;
    }
    if (this.disposed || this.rerenderScheduled || !this.lastRenderedTree || !this.lastTargetCanvas) {
      return;
    }
    this.rerenderScheduled = true;
    requestAnimationFrame(() => {
      this.rerenderScheduled = false;
      if (this.disposed || !this.lastRenderedTree || !this.lastTargetCanvas) {
        return;
      }
      this.renderPage(this.lastRenderedTree, this.lastTargetCanvas, this.lastScale);
    });
  }

  private renderTextRunOverlay(ctx: CanvasRenderingContext2D, op: LayerTextRunOp): void {
    const ratio = typeof op.style.ratio === 'number' && op.style.ratio > 0 ? op.style.ratio : 1;
    const hasRatio = Math.abs(ratio - 1) > 0.01;
    const outlineType = op.style.outlineType ?? 0;
    const shadowType = op.style.shadowType ?? 0;
    const shadowColor = typeof op.style.shadowColor === 'string' ? op.style.shadowColor : op.style.color;
    const shadowOffsetX = typeof op.style.shadowOffsetX === 'number' ? op.style.shadowOffsetX : 0;
    const shadowOffsetY = typeof op.style.shadowOffsetY === 'number' ? op.style.shadowOffsetY : 0;
    const emboss = !!op.style.emboss;
    const engrave = !!op.style.engrave;
    const emphasisDot = op.style.emphasisDot ?? 0;
    const shadeColor = (typeof op.style.shadeColor === 'string' ? op.style.shadeColor : '#ffffff').toLowerCase();
    const fontSize = op.style.fontSize || 12;
    const clusters = splitIntoClusters(op.text);
    const baseFont = buildCanvasTextFont(op.style.fontFamily, fontSize, op.style.bold, op.style.italic);
    const currencyFallbackFont =
      `${op.style.italic ? 'italic ' : ''}${op.style.bold ? 'bold ' : ''}${fontSize.toFixed(3)}px 'Malgun Gothic','맑은 고딕',sans-serif`;
    const symbolFallbackFont =
      `${op.style.italic ? 'italic ' : ''}${op.style.bold ? 'bold ' : ''}${fontSize.toFixed(3)}px 'GulimChe','굴림체','D2Coding','NanumGothicCoding','나눔고딕코딩','Noto Sans Mono',monospace`;
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
      const textWidth = op.positions.at(-1) ?? 0;
      if (textWidth > 0 && shadeColor !== '#ffffff') {
        ctx.save();
        ctx.fillStyle = shadeColor;
        ctx.fillRect(originX, originY - fontSize, textWidth, fontSize * 1.2);
        ctx.restore();
      }

      const drawPass = (dx: number, dy: number, fillColor: string, strokeColor?: string, lineWidth = 0) => {
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
          const x = originX + op.positions[cluster.start] + dx;
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
        const dotChar =
          emphasisDot === 1 ? '●'
            : emphasisDot === 2 ? '○'
              : emphasisDot === 3 ? 'ˇ'
                : emphasisDot === 4 ? '˜'
                  : emphasisDot === 5 ? '･'
                    : emphasisDot === 6 ? '˸'
                      : '';
        if (dotChar) {
          ctx.save();
          this.setCanvasTextFont(ctx, 'Noto Sans KR', fontSize * 0.3, false, false);
          ctx.fillStyle = op.style.color;
          const dotY = originY - fontSize * 1.05;
          for (const position of op.positions.slice(0, -1)) {
            const dotX = originX + position + (fontSize * ratio * 0.5);
            ctx.fillText(dotChar, dotX, dotY);
          }
          ctx.restore();
        }
      }

      if (op.tabLeaders?.length) {
        this.drawTabLeadersOverlay(ctx, op.tabLeaders, originX, originY, op.style.color);
      }

      if (op.style.underline !== 'none') {
        ctx.save();
        ctx.strokeStyle = op.style.underlineColor || op.style.color;
        ctx.lineWidth = 1;
        const y = op.style.underline === 'top' ? originY - fontSize + 1 : originY + 2;
        ctx.beginPath();
        ctx.moveTo(originX, y);
        ctx.lineTo(originX + textWidth, y);
        ctx.stroke();
        ctx.restore();
      }

      if (op.style.strikethrough) {
        ctx.save();
        ctx.strokeStyle = op.style.strikeColor || op.style.color;
        ctx.lineWidth = 1;
        const y = originY - fontSize * 0.3;
        ctx.beginPath();
        ctx.moveTo(originX, y);
        ctx.lineTo(originX + textWidth, y);
        ctx.stroke();
        ctx.restore();
      }

      if (op.controlMarks?.length) {
        ctx.save();
        ctx.fillStyle = '#4A90D9';
        for (const mark of op.controlMarks) {
          this.setCanvasTextFont(ctx, 'Noto Sans KR', mark.fontSize, false, false);
          ctx.fillText(mark.text, originX + mark.x, originY + mark.y);
        }
        ctx.restore();
      }
    };

    ctx.save();
    ctx.font = baseFont;
    ctx.textBaseline = 'alphabetic';
    const textRotation = op.isVertical ? op.rotation + 90 : op.rotation;
    if (textRotation !== 0) {
      const cx = op.bbox.x + op.bbox.width / 2;
      const cy = op.bbox.y + op.bbox.height / 2;
      ctx.translate(cx, cy);
      ctx.rotate((textRotation * Math.PI) / 180);
      drawClusters(-op.bbox.width / 2, -op.bbox.height / 2 + op.baseline);
    } else {
      drawClusters(op.bbox.x, op.bbox.y + op.baseline);
    }
    ctx.restore();
  }

  private renderFootnoteMarkerOverlay(ctx: CanvasRenderingContext2D, op: LayerFootnoteMarkerOp): void {
    ctx.save();
    this.setCanvasTextFont(ctx, op.fontFamily, op.fontSize, false, false);
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = op.color;
    ctx.fillText(op.text, op.bbox.x, op.bbox.y + op.bbox.height * 0.4);
    ctx.restore();
  }

  private drawTabLeadersOverlay(ctx: CanvasRenderingContext2D, leaders: LayerTabLeader[], originX: number, baselineY: number, color: string): void {
    for (const leader of leaders) {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash(
        leader.fillType === 2 ? [4, 2]
          : leader.fillType === 3 ? [1.5, 2.5]
            : [],
      );
      const y = baselineY + 1;
      ctx.beginPath();
      ctx.moveTo(originX + leader.startX, y);
      ctx.lineTo(originX + leader.endX, y);
      ctx.stroke();
      ctx.restore();
    }
  }

  private strokeDashPattern(dash: string, width: number): number[] {
    const stroke = Math.max(width, 0.5);
    switch (dash) {
      case 'dash':
        return [stroke * 4, stroke * 2];
      case 'dot':
        return [stroke * 1.5, stroke * 2.5];
      case 'dashDot':
        return [stroke * 4, stroke * 2, stroke * 1.5, stroke * 2];
      case 'dashDotDot':
        return [stroke * 4, stroke * 2, stroke * 1.5, stroke * 2, stroke * 1.5, stroke * 2];
      default:
        return [];
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

  private drawEncodedImage(
    canvas: ReturnType<Surface['getCanvas']>,
    resourceId: number | undefined,
    base64: string | undefined,
    bbox: LayerBounds,
    fillMode = 'fitToSize',
    originalSize?: { width: number; height: number },
    crop?: { left: number; top: number; right: number; bottom: number },
    effect: LayerImageOp['effect'] = 'realPic',
  ): void {
    const image = this.resourceCache.image(resourceId, base64);
    if (!image) return;
    let colorFilter: ColorFilter | null = null;
    switch (effect) {
      case 'grayScale':
      case 'pattern8x8':
        colorFilter = this.canvasKit.ColorFilter.MakeMatrix([
          0.299, 0.587, 0.114, 0, 0,
          0.299, 0.587, 0.114, 0, 0,
          0.299, 0.587, 0.114, 0, 0,
          0, 0, 0, 1, 0,
        ]);
        break;
      case 'blackWhite':
        colorFilter = this.canvasKit.ColorFilter.MakeMatrix([
          9.568, 18.784, 3.648, 0, -4096,
          9.568, 18.784, 3.648, 0, -4096,
          9.568, 18.784, 3.648, 0, -4096,
          0, 0, 0, 1, 0,
        ]);
        break;
    }

    try {
      const sourceWidth = image.width();
      const sourceHeight = image.height();
      if (
        !Number.isFinite(sourceWidth)
        || !Number.isFinite(sourceHeight)
        || sourceWidth <= 0
        || sourceHeight <= 0
        || !Number.isFinite(bbox.x)
        || !Number.isFinite(bbox.y)
        || !Number.isFinite(bbox.width)
        || !Number.isFinite(bbox.height)
        || bbox.width <= 0
        || bbox.height <= 0
      ) {
        return;
      }
      const cropSource = crop
        ? (() => {
          const scaleX = crop.right / sourceWidth;
          const scaleY = crop.bottom / sourceHeight;
          if (scaleX <= 0 || scaleY <= 0) {
            return null;
          }
          const srcX = crop.left / scaleX;
          const srcY = crop.top / scaleY;
          const srcW = (crop.right - crop.left) / scaleX;
          const srcH = (crop.bottom - crop.top) / scaleY;
          const isCropped = srcX > 0.5 || srcY > 0.5 || Math.abs(srcW - sourceWidth) > 1 || Math.abs(srcH - sourceHeight) > 1;
          return isCropped && srcW > 0 && srcH > 0
            ? { x: srcX, y: srcY, width: srcW, height: srcH }
            : null;
        })()
        : null;
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
          this.currentProfile !== 'fast-preview'
          && !this.hasActiveCacheHint('preferRaster')
          && (
            this.renderMode === 'compat'
            || this.currentProfile === 'print'
            || this.currentProfile === 'high-quality'
          )
          && (srcW > dstW * 1.2 || srcH > dstH * 1.2);
        const sampledImage = useMipmaps ? this.resourceCache.image(resourceId, base64, true) ?? image : image;
        const paint = new this.canvasKit.Paint();
        if (colorFilter) {
          paint.setColorFilter(colorFilter);
        }
        canvas.drawImageRectOptions(
          sampledImage,
          this.canvasKit.XYWHRect(srcX, srcY, srcW, srcH),
          this.canvasKit.XYWHRect(dstX, dstY, dstW, dstH),
          this.canvasKit.FilterMode.Linear,
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

      if (fillMode === 'fitToSize' || fillMode === 'none') {
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
      const { x, y } = this.resolveImagePlacement(fillMode, bbox, imageWidth, imageHeight);

      canvas.save();
      canvas.clipRect(this.toRect(bbox), this.canvasKit.ClipOp.Intersect, true);

      if (fillMode === 'tileAll' || fillMode === 'tileHorzTop' || fillMode === 'tileHorzBottom' || fillMode === 'tileVertLeft' || fillMode === 'tileVertRight') {
        const maxTileDraws = 4096;
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

      canvas.restore();
    } finally {
      colorFilter?.delete();
    }
  }

  private resolveImagePlacement(fillMode: string, bbox: LayerBounds, imageWidth: number, imageHeight: number): { x: number; y: number } {
    switch (fillMode) {
      case 'leftTop':
        return { x: bbox.x, y: bbox.y };
      case 'centerTop':
        return { x: bbox.x + (bbox.width - imageWidth) / 2, y: bbox.y };
      case 'rightTop':
        return { x: bbox.x + bbox.width - imageWidth, y: bbox.y };
      case 'leftCenter':
        return { x: bbox.x, y: bbox.y + (bbox.height - imageHeight) / 2 };
      case 'center':
        return { x: bbox.x + (bbox.width - imageWidth) / 2, y: bbox.y + (bbox.height - imageHeight) / 2 };
      case 'rightCenter':
        return { x: bbox.x + bbox.width - imageWidth, y: bbox.y + (bbox.height - imageHeight) / 2 };
      case 'leftBottom':
        return { x: bbox.x, y: bbox.y + bbox.height - imageHeight };
      case 'centerBottom':
        return { x: bbox.x + (bbox.width - imageWidth) / 2, y: bbox.y + bbox.height - imageHeight };
      case 'rightBottom':
        return { x: bbox.x + bbox.width - imageWidth, y: bbox.y + bbox.height - imageHeight };
      default:
        return { x: bbox.x, y: bbox.y };
    }
  }

  private drawTabLeaders(canvas: ReturnType<Surface['getCanvas']>, leaders: LayerTabLeader[], originX: number, baselineY: number, color: string): void {
    for (const leader of leaders) {
      const dash = leader.fillType === 2 ? 'dash' : leader.fillType === 3 ? 'dot' : 'solid';
      const paint = this.makeLinePaint(color, 1, dash);
      const y = baselineY + 1;
      canvas.drawLine(originX + leader.startX, y, originX + leader.endX, y, paint);
      paint.delete();
    }
  }

  private makePath(commands: LayerPathCommand[]) {
    const builder = new this.canvasKit.PathBuilder();
    for (const command of commands) {
      switch (command.type) {
        case 'moveTo':
          builder.moveTo(command.x, command.y);
          break;
        case 'lineTo':
          builder.lineTo(command.x, command.y);
          break;
        case 'curveTo':
          builder.cubicTo(command.x1, command.y1, command.x2, command.y2, command.x3, command.y3);
          break;
        case 'arcTo':
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

  private makeTextObjects(fontFamily: string, fontSize: number, bold: boolean, italic: boolean, color: string, scaleX = 1): { typeface: Typeface; font: Font; paint: Paint } {
    const family = this.fontRegistry.resolveFamily(fontFamily);
    const typeface = this.fontProvider.matchFamilyStyle(family, {
      weight: bold ? this.canvasKit.FontWeight.Bold : this.canvasKit.FontWeight.Normal,
      slant: italic ? this.canvasKit.FontSlant.Italic : this.canvasKit.FontSlant.Upright,
    });
    const font = new this.canvasKit.Font(typeface, fontSize || 12);
    font.setEmbolden(bold && (family === 'D2Coding' || family === 'Latin Modern Math'));
    font.setScaleX(scaleX > 0 ? scaleX : 1);
    font.setSkewX(italic ? -0.25 : 0);
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

  private makePaint(color: string, style: 'fill' | 'stroke', opacity = 1): Paint {
    const paint = new this.canvasKit.Paint();
    paint.setAntiAlias(true);
    paint.setStyle(style === 'fill' ? this.canvasKit.PaintStyle.Fill : this.canvasKit.PaintStyle.Stroke);
    const rgba = [...this.canvasKit.parseColorString(color)] as number[];
    rgba[3] = (rgba[3] ?? 1) * opacity;
    paint.setColor(rgba as any);
    return paint;
  }

  private makeLinePaint(color: string, width: number, dash: string, opacity = 1): Paint {
    const paint = this.makePaint(color, 'stroke', opacity);
    const strokeWidth = Math.max(width, 0.5);
    paint.setStrokeWidth(strokeWidth);

    if (dash !== 'solid') {
      const stroke = Math.max(width, 0.5);
      const intervals =
        dash === 'dash' ? [stroke * 4, stroke * 2]
          : dash === 'dot' ? [stroke * 1.5, stroke * 2.5]
            : dash === 'dashDot' ? [stroke * 4, stroke * 2, stroke * 1.5, stroke * 2]
              : [stroke * 4, stroke * 2, stroke * 1.5, stroke * 2, stroke * 1.5, stroke * 2];
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
    const shader = gradient ? this.makeGradientShader(gradient, bounds) : pattern ? this.makePatternShader(pattern) : null;
    if (!shader && !fillColor) {
      return null;
    }

    const paint = this.makePaint(fillColor ?? '#ffffff', 'fill', opacity);
    if (shader) {
      paint.setShader(shader);
      paint.setAlphaf(opacity);
    }
    return { paint, shader };
  }

  private makeGradientShader(gradient: LayerGradient, bounds: LayerBounds): Shader | null {
    if (gradient.colors.length < 2) {
      return null;
    }

    const colors = gradient.colors.map((color) => this.canvasKit.parseColorString(color));
    const positions = gradient.positions.length > 0 ? gradient.positions : null;
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
    draw: (paint: Paint) => void,
  ): void {
    if (!shadow) {
      return;
    }

    const opacity = shadow.alpha > 0 ? 1 - (shadow.alpha / 255) : 1;
    const paint = this.makePaint(color, style, opacity);
    if (style === 'stroke') {
      paint.setStrokeWidth(Math.max(strokeWidth, 0.5));
    }
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

  private drawCanvasKitImage(
    canvas: ReturnType<Surface['getCanvas']>,
    image: Image,
    bbox: LayerBounds,
  ): void {
    const paint = new this.canvasKit.Paint();
    canvas.drawImageRectOptions(
      image,
      this.canvasKit.XYWHRect(0, 0, image.width(), image.height()),
      this.toRect(bbox),
      this.canvasKit.FilterMode.Linear,
      this.canvasKit.MipmapMode.None,
      paint,
    );
    paint.delete();
  }

  private clearStaticPictureCache(): void {
    this.staticPictureCache.clear();
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
    this.rerenderScheduled = false;
    this.asyncResourceReadyCallback = null;
    this.currentClipStack.length = 0;
    this.currentCacheHintStack.length = 0;
    this.currentClipEnabled = true;

    for (const blob of this.textBlobCache.values()) {
      blob.delete();
    }
    this.textBlobCache.clear();
    this.textBlobCacheHits = 0;
    this.textBlobCacheMisses = 0;

    this.clearStaticPictureCache();
    this.surfaceCache.clear();
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
  if (arrowStyle === 'none') {
    return;
  }

  const alongX = -directionX;
  const alongY = -directionY;
  const perpX = directionY;
  const perpY = -directionX;
  const halfHeight = arrowHeight / 2;
  const toWorld = (along: number, perp: number): [number, number] => [
    tipX + along * alongX + perp * perpX,
    tipY + along * alongY + perp * perpY,
  ];

  const builder = new canvasKit.PathBuilder();
  const fillPaint = new canvasKit.Paint();
  fillPaint.setAntiAlias(true);
  fillPaint.setStyle(canvasKit.PaintStyle.Fill);
  fillPaint.setColor(canvasKit.parseColorString(color));

  const strokePaint = new canvasKit.Paint();
  strokePaint.setAntiAlias(true);
  strokePaint.setStyle(canvasKit.PaintStyle.Stroke);
  strokePaint.setColor(canvasKit.parseColorString(color));
  strokePaint.setStrokeWidth(Math.max(strokeWidth * 0.3, 0.5));

  if (arrowStyle === 'arrow' || arrowStyle === 'concaveArrow') {
    const [baseX1, baseY1] = toWorld(arrowWidth, -halfHeight);
    const [baseX2, baseY2] = toWorld(arrowWidth, halfHeight);
    builder.moveTo(tipX, tipY);
    builder.lineTo(baseX1, baseY1);
    if (arrowStyle === 'concaveArrow') {
      const [centerX, centerY] = toWorld(arrowWidth - arrowWidth * 0.3, 0);
      builder.lineTo(centerX, centerY);
    }
    builder.lineTo(baseX2, baseY2);
    builder.close();
    const path = builder.detach();
    canvas.drawPath(path, fillPaint);
    path.delete();
    builder.delete();
    fillPaint.delete();
    strokePaint.delete();
    return;
  }

  if (arrowStyle === 'diamond' || arrowStyle === 'openDiamond') {
    const halfWidth = arrowWidth / 2;
    const [point1X, point1Y] = toWorld(0, 0);
    const [point2X, point2Y] = toWorld(halfWidth, -halfHeight);
    const [point3X, point3Y] = toWorld(arrowWidth, 0);
    const [point4X, point4Y] = toWorld(halfWidth, halfHeight);
    builder.moveTo(point1X, point1Y);
    builder.lineTo(point2X, point2Y);
    builder.lineTo(point3X, point3Y);
    builder.lineTo(point4X, point4Y);
    builder.close();
    const path = builder.detach();
    if (arrowStyle === 'diamond') {
      canvas.drawPath(path, fillPaint);
    } else {
      const whiteFill = new canvasKit.Paint();
      whiteFill.setAntiAlias(true);
      whiteFill.setStyle(canvasKit.PaintStyle.Fill);
      whiteFill.setColor(canvasKit.parseColorString('white'));
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

  if (arrowStyle === 'circle' || arrowStyle === 'openCircle') {
    const halfWidth = arrowWidth / 2;
    const [centerX, centerY] = toWorld(halfWidth, 0);
    const radiusX = halfWidth * 0.8;
    const radiusY = halfHeight * 0.8;
    if (arrowStyle === 'circle') {
      canvas.drawOval(canvasKit.LTRBRect(centerX - radiusX, centerY - radiusY, centerX + radiusX, centerY + radiusY), fillPaint);
    } else {
      const whiteFill = new canvasKit.Paint();
      whiteFill.setAntiAlias(true);
      whiteFill.setStyle(canvasKit.PaintStyle.Fill);
      whiteFill.setColor(canvasKit.parseColorString('white'));
      const oval = canvasKit.LTRBRect(centerX - radiusX, centerY - radiusY, centerX + radiusX, centerY + radiusY);
      canvas.drawOval(oval, whiteFill);
      canvas.drawOval(oval, strokePaint);
      whiteFill.delete();
    }
    builder.delete();
    fillPaint.delete();
    strokePaint.delete();
    return;
  }

  if (arrowStyle === 'square' || arrowStyle === 'openSquare') {
    const [point1X, point1Y] = toWorld(0, -halfHeight);
    const [point2X, point2Y] = toWorld(arrowWidth, -halfHeight);
    const [point3X, point3Y] = toWorld(arrowWidth, halfHeight);
    const [point4X, point4Y] = toWorld(0, halfHeight);
    builder.moveTo(point1X, point1Y);
    builder.lineTo(point2X, point2Y);
    builder.lineTo(point3X, point3Y);
    builder.lineTo(point4X, point4Y);
    builder.close();
    const path = builder.detach();
    if (arrowStyle === 'square') {
      canvas.drawPath(path, fillPaint);
    } else {
      const whiteFill = new canvasKit.Paint();
      whiteFill.setAntiAlias(true);
      whiteFill.setStyle(canvasKit.PaintStyle.Fill);
      whiteFill.setColor(canvasKit.parseColorString('white'));
      canvas.drawPath(path, whiteFill);
      canvas.drawPath(path, strokePaint);
      whiteFill.delete();
    }
    path.delete();
  }

  builder.delete();
  fillPaint.delete();
  strokePaint.delete();
}
