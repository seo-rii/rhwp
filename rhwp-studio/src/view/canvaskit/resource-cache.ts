import type { CanvasKit, Image as CanvasKitImage } from 'canvaskit-wasm';

import type { LayerImageOp, LayerPatternFill, PageLayerTree } from '@/core/types';
import {
  applyLayerImageEffectPixels,
  decodeBase64,
  resetLayerImageEffectDiagnostics,
  type LayerImageEffectDiagnostics,
  type LayerImageEffectSourceRect,
} from '../image-effect-pixels';
import { parseCanvasKitCssColor } from './css-color';

export type CanvasKitPatternDiagnostics = {
  cacheHits: number;
  cacheMisses: number;
  surfaceCreations: number;
  surfaceFailures: number;
  imagesCreated: number;
};

export class CanvasKitResourceCache {
  readonly imageCache = new Map<string, CanvasKitImage>();
  readonly mipmappedImageCache = new Map<string, CanvasKitImage>();
  readonly imageEffectCache = new Map<string, CanvasKitImage>();
  readonly patternImageCache = new Map<string, CanvasKitImage | null>();
  readonly failedImageCacheKeys = new Set<string>();
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
  private readonly patternDiagnostics: CanvasKitPatternDiagnostics = {
    cacheHits: 0,
    cacheMisses: 0,
    surfaceCreations: 0,
    surfaceFailures: 0,
    imagesCreated: 0,
  };

  private resources: PageLayerTree['resources'] | null = null;
  private resourceTableId: number | null = null;

  constructor(private readonly canvasKit: CanvasKit) {}

  setResources(resources: PageLayerTree['resources'] | null | undefined): void {
    const nextResources = resources ?? null;
    const nextTableId = nextResources?.tableId ?? null;
    if (this.resourceTableId === nextTableId) {
      this.resources = nextResources;
      return;
    }
    this.clearResourceImageCaches();
    this.resources = nextResources;
    this.resourceTableId = nextTableId;
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
    if (this.failedImageCacheKeys.has(cacheKey)) return null;

    let bytes: Uint8Array | undefined;
    try {
      bytes = this.imageBytes(resourceId, base64);
    } catch {
      this.failedImageCacheKeys.add(cacheKey);
      return null;
    }
    if (!bytes) return null;
    let image: CanvasKitImage | null;
    try {
      image = this.canvasKit.MakeImageFromEncoded(bytes);
    } catch {
      image = null;
    }
    if (!image) {
      this.failedImageCacheKeys.add(cacheKey);
      return null;
    }
    this.imageCache.set(cacheKey, image);
    return image;
  }

  imageWithEffect(
    resourceId?: number,
    base64?: string,
    effect: LayerImageOp['effect'] = 'realPic',
    sourceRect?: LayerImageEffectSourceRect | null,
    brightness = 0,
    contrast = 0,
  ): CanvasKitImage | null {
    const hasEffect = !!effect && effect !== 'realPic';
    const hasTone = brightness !== 0 || contrast !== 0;
    if (!hasEffect && !hasTone) {
      return this.image(resourceId, base64);
    }

    const cacheKey = this.imageResourceCacheKey(resourceId, base64);
    if (!cacheKey) {
      return null;
    }

    const sourceRectKey = sourceRect
      ? `:src:${sourceRect.x.toFixed(3)}:${sourceRect.y.toFixed(3)}:${sourceRect.width.toFixed(3)}:${sourceRect.height.toFixed(3)}`
      : '';
    const toneKey = hasTone ? `:tone:${brightness}:${contrast}` : '';
    const effectCacheKey = `${cacheKey}:effect:${effect ?? 'realPic'}${toneKey}${sourceRectKey}`;
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

    applyLayerImageEffectPixels(
      pixels,
      outputWidth,
      effect,
      Math.floor(sx),
      Math.floor(sy),
      brightness,
      contrast,
    );
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

  patternImage(pattern: LayerPatternFill): CanvasKitImage | null {
    const cacheKey = `${pattern.patternType}:${pattern.patternColor}:${pattern.backgroundColor}`;
    if (this.patternImageCache.has(cacheKey)) {
      this.patternDiagnostics.cacheHits += 1;
      return this.patternImageCache.get(cacheKey) ?? null;
    }

    this.patternDiagnostics.cacheMisses += 1;
    const image = this.makePatternImage(pattern);
    this.patternImageCache.set(cacheKey, image);
    return image;
  }

  getPatternDiagnostics(): Readonly<CanvasKitPatternDiagnostics> {
    return { ...this.patternDiagnostics };
  }

  resetPatternDiagnostics(): void {
    this.patternDiagnostics.cacheHits = 0;
    this.patternDiagnostics.cacheMisses = 0;
    this.patternDiagnostics.surfaceCreations = 0;
    this.patternDiagnostics.surfaceFailures = 0;
    this.patternDiagnostics.imagesCreated = 0;
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
    this.failedImageCacheKeys.clear();

  }

  private imageResourceCacheKey(resourceId?: number, base64?: string): string | null {
    const resources = this.resources;
    const resourceBytes = typeof resourceId === 'number'
      ? resources?.images?.[resourceId]
      : undefined;
    if (typeof resourceId === 'number' && resources && resourceBytes) {
      const resourceHash = resources.imageHashes?.[resourceId];
      const payloadIdentity = resourceHash && resourceHash.length > 0
        ? resourceHash
        : `fp:${imageResourcePayloadFingerprint(resourceBytes)}`;
      return `res:${resources.tableId}:${resourceId}:${payloadIdentity}`;
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
      this.patternDiagnostics.surfaceFailures += 1;
      return null;
    }
    this.patternDiagnostics.surfaceCreations += 1;

    const canvas = surface.getCanvas();
    const fillPaint = new this.canvasKit.Paint();
    fillPaint.setStyle(this.canvasKit.PaintStyle.Fill);
    fillPaint.setColor(parseCanvasKitCssColor(this.canvasKit, pattern.backgroundColor));
    canvas.drawRect(this.canvasKit.XYWHRect(0, 0, 6, 6), fillPaint);
    fillPaint.delete();

    const strokePaint = new this.canvasKit.Paint();
    strokePaint.setStyle(this.canvasKit.PaintStyle.Stroke);
    strokePaint.setStrokeWidth(1);
    strokePaint.setColor(parseCanvasKitCssColor(this.canvasKit, pattern.patternColor));

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
    this.patternDiagnostics.imagesCreated += 1;
    return image;
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
    for (const key of this.failedImageCacheKeys) {
      if (key.startsWith('res:')) {
        this.failedImageCacheKeys.delete(key);
      }
    }
  }
}

function imageResourcePayloadFingerprint(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${bytes.length}:${hash.toString(16).padStart(8, '0')}`;
}
