import type { CanvasKit, Image as CanvasKitImage } from 'canvaskit-wasm';

import type { LayerImageOp, LayerPatternFill, PageLayerTree } from '@/core/types';
import {
  applyLayerImageEffectPixels,
  decodeBase64,
  encodeBase64,
  inferImageMime,
  resetLayerImageEffectDiagnostics,
  type LayerImageEffectDiagnostics,
  type LayerImageEffectSourceRect,
} from '../layer-canvas-utils';

export class CanvasKitResourceCache {
  readonly imageCache = new Map<string, CanvasKitImage>();
  readonly mipmappedImageCache = new Map<string, CanvasKitImage>();
  readonly imageEffectCache = new Map<string, CanvasKitImage>();
  readonly domImageCache = new Map<string, HTMLImageElement>();
  readonly equationSvgDomImageCache = new Map<string, HTMLImageElement>();
  readonly equationSvgImageCache = new Map<string, CanvasKitImage>();
  readonly patternImageCache = new Map<string, CanvasKitImage | null>();
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
  };

  private resources: PageLayerTree['resources'] | null = null;
  private resourceTableId: number | null = null;

  constructor(
    private readonly canvasKit: CanvasKit,
    private readonly scheduleRerender: () => void,
  ) {}

  setResources(resources: PageLayerTree['resources'] | null | undefined): void {
    const nextResources = resources ?? null;
    const nextTableId = nextResources?.tableId ?? null;
    if (this.resourceTableId === nextTableId) {
      this.resources = nextResources;
      return;
    }
    this.clearResourceImageCaches();
    this.clearResourceSvgCaches();
    this.resources = nextResources;
    this.resourceTableId = nextTableId;
  }

  svgFragment(resourceId?: number, fallback?: string): string {
    return (
      typeof resourceId === 'number'
        ? this.resources?.svgFragments?.[resourceId] ?? fallback ?? ''
        : fallback ?? ''
    ).trim();
  }

  svgResourceCacheKey(resourceId?: number, fallback?: string): string | null {
    if (typeof resourceId === 'number' && this.resources?.svgFragments?.[resourceId] !== undefined) {
      const resourceKey = this.resources.svgKeys?.[resourceId] ?? this.resources.svgHashes?.[resourceId] ?? 'unknown';
      return `res-svg:${this.resources.tableId}:${resourceId}:${resourceKey}`;
    }
    const svgContent = fallback?.trim();
    return svgContent ? `inline-svg:${svgContent.length}:${this.hashString(svgContent)}` : null;
  }

  image(resourceId?: number, base64?: string, withMipmaps = false): CanvasKitImage | null {
    const cacheKey = this.imageResourceCacheKey(resourceId, base64);
    if (!cacheKey) {
      return null;
    }

    if (withMipmaps) {
      const cachedMipmap = this.mipmappedImageCache.get(cacheKey);
      if (cachedMipmap) return cachedMipmap;

      const original = this.image(resourceId, base64);
      if (!original) return null;

      const mipmapped = original.makeCopyWithDefaultMipmaps();
      this.mipmappedImageCache.set(cacheKey, mipmapped);
      return mipmapped;
    }

    const cached = this.imageCache.get(cacheKey);
    if (cached) return cached;

    const bytes = this.imageBytes(resourceId, base64);
    if (!bytes) return null;
    const image = this.canvasKit.MakeImageFromEncoded(bytes);
    if (!image) return null;
    this.imageCache.set(cacheKey, image);
    return image;
  }

  imageWithEffect(
    resourceId?: number,
    base64?: string,
    effect: LayerImageOp['effect'] = 'realPic',
    sourceRect?: LayerImageEffectSourceRect | null,
  ): CanvasKitImage | null {
    if (!effect || effect === 'realPic') {
      return this.image(resourceId, base64);
    }

    const cacheKey = this.imageResourceCacheKey(resourceId, base64);
    if (!cacheKey) {
      return null;
    }

    const sourceRectKey = sourceRect
      ? `:src:${sourceRect.x.toFixed(3)}:${sourceRect.y.toFixed(3)}:${sourceRect.width.toFixed(3)}:${sourceRect.height.toFixed(3)}`
      : '';
    const effectCacheKey = `${cacheKey}:effect:${effect}${sourceRectKey}`;
    const cached = this.imageEffectCache.get(effectCacheKey);
    if (cached) {
      this.imageEffectDiagnostics.cacheHits += 1;
      return cached;
    }
    this.imageEffectDiagnostics.cacheMisses += 1;
    const preprocessStartMs = typeof performance !== 'undefined' ? performance.now() : 0;

    const original = this.image(resourceId, base64);
    if (!original) {
      return null;
    }

    const imageWidth = original.width();
    const imageHeight = original.height();
    const sx = sourceRect?.x ?? 0;
    const sy = sourceRect?.y ?? 0;
    const sw = sourceRect?.width ?? imageWidth;
    const sh = sourceRect?.height ?? imageHeight;
    if (
      !Number.isFinite(sx)
      || !Number.isFinite(sy)
      || !Number.isFinite(sw)
      || !Number.isFinite(sh)
      || sw <= 0
      || sh <= 0
    ) {
      this.imageEffectDiagnostics.preprocessFailures += 1;
      this.imageEffectDiagnostics.fallbackToOriginal += 1;
      return original;
    }

    const outputWidth = Math.max(1, Math.round(sw));
    const outputHeight = Math.max(1, Math.round(sh));
    const surface = this.canvasKit.MakeSurface(outputWidth, outputHeight);
    if (!surface) {
      this.imageEffectDiagnostics.preprocessFailures += 1;
      this.imageEffectDiagnostics.fallbackToOriginal += 1;
      return original;
    }

    const paint = new this.canvasKit.Paint();
    const canvas = surface.getCanvas();
    canvas.drawImageRect(
      original,
      this.canvasKit.XYWHRect(sx, sy, sw, sh),
      this.canvasKit.XYWHRect(0, 0, outputWidth, outputHeight),
      paint,
      false,
    );
    paint.delete();
    surface.flush();

    const imageInfo = {
      width: outputWidth,
      height: outputHeight,
      colorType: this.canvasKit.ColorType.RGBA_8888,
      alphaType: this.canvasKit.AlphaType.Unpremul,
      colorSpace: this.canvasKit.ColorSpace.SRGB,
    };
    const snapshot = surface.makeImageSnapshot();
    const pixels = snapshot.readPixels(0, 0, imageInfo);
    snapshot.delete();
    surface.delete();
    if (!(pixels instanceof Uint8Array)) {
      this.imageEffectDiagnostics.preprocessFailures += 1;
      this.imageEffectDiagnostics.fallbackToOriginal += 1;
      return original;
    }

    applyLayerImageEffectPixels(pixels, outputWidth, effect, Math.floor(sx), Math.floor(sy));
    const image = this.canvasKit.MakeImage(imageInfo, pixels, outputWidth * 4);
    if (!image) {
      this.imageEffectDiagnostics.preprocessFailures += 1;
      this.imageEffectDiagnostics.fallbackToOriginal += 1;
      return original;
    }
    const elapsedMs = typeof performance !== 'undefined'
      ? Math.max(0, performance.now() - preprocessStartMs)
      : 0;
    const processedBytes = outputWidth * outputHeight * 4;
    this.imageEffectDiagnostics.preprocessedPixels += outputWidth * outputHeight;
    this.imageEffectDiagnostics.preprocessedBytes += processedBytes;
    this.imageEffectDiagnostics.maxPreprocessedBytes = Math.max(
      this.imageEffectDiagnostics.maxPreprocessedBytes,
      processedBytes,
    );
    this.imageEffectDiagnostics.preprocessTimeMs += elapsedMs;
    this.imageEffectDiagnostics.maxPreprocessTimeMs = Math.max(
      this.imageEffectDiagnostics.maxPreprocessTimeMs,
      elapsedMs,
    );
    this.imageEffectCache.set(effectCacheKey, image);
    return image;
  }

  getImageEffectDiagnostics(): Readonly<LayerImageEffectDiagnostics> {
    return { ...this.imageEffectDiagnostics };
  }

  resetImageEffectDiagnostics(): void {
    resetLayerImageEffectDiagnostics(this.imageEffectDiagnostics);
  }

  domImage(resourceId?: number, base64?: string): HTMLImageElement | null {
    const cacheKey = this.imageResourceCacheKey(resourceId, base64);
    if (!cacheKey) {
      return null;
    }

    const cached = this.domImageCache.get(cacheKey);
    if (cached) {
      return cached.complete && cached.naturalWidth > 0 ? cached : null;
    }

    const bytes = this.imageBytes(resourceId, base64);
    if (!bytes) {
      return null;
    }
    const image = new Image();
    const mimeType = inferImageMime(bytes);
    image.decoding = 'sync';
    image.onload = () => this.scheduleRerender();
    image.src = `data:${mimeType};base64,${typeof resourceId === 'number' ? encodeBase64(bytes) : base64}`;
    this.domImageCache.set(cacheKey, image);
    return image.complete && image.naturalWidth > 0 ? image : null;
  }

  equationSvgImage(cacheKey: string): CanvasKitImage | null {
    return this.equationSvgImageCache.get(cacheKey) ?? null;
  }

  setEquationSvgImage(cacheKey: string, image: CanvasKitImage): void {
    this.equationSvgImageCache.set(cacheKey, image);
  }

  equationSvgDomImage(cacheKey: string): HTMLImageElement | null {
    return this.equationSvgDomImageCache.get(cacheKey) ?? null;
  }

  setEquationSvgDomImage(cacheKey: string, image: HTMLImageElement): void {
    this.equationSvgDomImageCache.set(cacheKey, image);
  }

  deleteEquationSvgDomImage(cacheKey: string): void {
    this.equationSvgDomImageCache.delete(cacheKey);
  }

  patternImage(pattern: LayerPatternFill): CanvasKitImage | null {
    const cacheKey = `${pattern.patternType}:${pattern.patternColor}:${pattern.backgroundColor}`;
    if (this.patternImageCache.has(cacheKey)) {
      return this.patternImageCache.get(cacheKey) ?? null;
    }

    const image = this.makePatternImage(pattern);
    this.patternImageCache.set(cacheKey, image);
    return image;
  }

  dispose(): void {
    this.resources = null;
    this.resourceTableId = null;

    for (const image of this.patternImageCache.values()) {
      image?.delete();
    }
    this.patternImageCache.clear();

    for (const image of this.mipmappedImageCache.values()) {
      image.delete();
    }
    this.mipmappedImageCache.clear();

    for (const image of this.imageEffectCache.values()) {
      image.delete();
    }
    this.imageEffectCache.clear();

    for (const image of this.imageCache.values()) {
      image.delete();
    }
    this.imageCache.clear();

    for (const image of this.equationSvgImageCache.values()) {
      image.delete();
    }
    this.equationSvgImageCache.clear();

    for (const image of this.domImageCache.values()) {
      image.onload = null;
      image.onerror = null;
      image.src = '';
    }
    this.domImageCache.clear();

    for (const image of this.equationSvgDomImageCache.values()) {
      image.onload = null;
      image.onerror = null;
      image.src = '';
    }
    this.equationSvgDomImageCache.clear();
  }

  private imageResourceCacheKey(resourceId?: number, base64?: string): string | null {
    if (typeof resourceId === 'number' && this.resources?.images?.[resourceId]) {
      return `res:${this.resources.tableId}:${resourceId}:${this.resources.imageHashes?.[resourceId] ?? 'unknown'}`;
    }
    return base64 ? `b64:${base64}` : null;
  }

  private imageBytes(resourceId?: number, base64?: string): Uint8Array | undefined {
    return typeof resourceId === 'number'
      ? this.resources?.images?.[resourceId]
      : base64
        ? decodeBase64(base64)
        : undefined;
  }

  private makePatternImage(pattern: LayerPatternFill): CanvasKitImage | null {
    const surface = this.canvasKit.MakeSurface(6, 6);
    if (!surface) {
      return null;
    }

    const canvas = surface.getCanvas();
    const fillPaint = new this.canvasKit.Paint();
    fillPaint.setStyle(this.canvasKit.PaintStyle.Fill);
    fillPaint.setColor(this.canvasKit.parseColorString(pattern.backgroundColor));
    canvas.drawRect(this.canvasKit.XYWHRect(0, 0, 6, 6), fillPaint);
    fillPaint.delete();

    const strokePaint = new this.canvasKit.Paint();
    strokePaint.setStyle(this.canvasKit.PaintStyle.Stroke);
    strokePaint.setStrokeWidth(1);
    strokePaint.setColor(this.canvasKit.parseColorString(pattern.patternColor));

    switch (pattern.patternType) {
      case 0:
        canvas.drawLine(0, 3, 6, 3, strokePaint);
        break;
      case 1:
        canvas.drawLine(3, 0, 3, 6, strokePaint);
        break;
      case 2:
        canvas.drawLine(6, 0, 0, 6, strokePaint);
        break;
      case 3:
        canvas.drawLine(0, 0, 6, 6, strokePaint);
        break;
      case 4:
        canvas.drawLine(3, 0, 3, 6, strokePaint);
        canvas.drawLine(0, 3, 6, 3, strokePaint);
        break;
      case 5:
        canvas.drawLine(0, 0, 6, 6, strokePaint);
        canvas.drawLine(6, 0, 0, 6, strokePaint);
        break;
      default:
        break;
    }

    strokePaint.delete();
    surface.flush();
    const image = surface.makeImageSnapshot();
    surface.delete();
    return image;
  }

  private hashString(value: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16);
  }

  private clearResourceImageCaches(): void {
    for (const [key, image] of this.mipmappedImageCache) {
      if (!key.startsWith('res:')) {
        continue;
      }
      image.delete();
      this.mipmappedImageCache.delete(key);
    }
    for (const [key, image] of this.imageEffectCache) {
      if (!key.startsWith('res:')) {
        continue;
      }
      image.delete();
      this.imageEffectCache.delete(key);
    }
    for (const [key, image] of this.imageCache) {
      if (!key.startsWith('res:')) {
        continue;
      }
      image.delete();
      this.imageCache.delete(key);
    }
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

  private clearResourceSvgCaches(): void {
    for (const [key, image] of this.equationSvgImageCache) {
      if (!key.includes(':res-svg:')) {
        continue;
      }
      image.delete();
      this.equationSvgImageCache.delete(key);
    }
    for (const [key, image] of this.equationSvgDomImageCache) {
      if (!key.includes(':res-svg:')) {
        continue;
      }
      image.onload = null;
      image.onerror = null;
      image.src = '';
      this.equationSvgDomImageCache.delete(key);
    }
  }
}
