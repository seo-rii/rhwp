import type { CanvasKit, Image as CanvasKitImage } from 'canvaskit-wasm';

import { decodeBase64 } from '@/core/base64';
import type { LayerImageOp, LayerPatternFill, PageLayerTree } from '@/core/types';
import {
  applyLayerImageEffectPixels,
  resetLayerImageEffectDiagnostics,
  type LayerImageEffectDiagnostics,
  type LayerImageEffectSourceRect,
} from '../image-effect-pixels';
import { parseCanvasKitCssColor } from './css-color';
import {
  canvasKitEncodedImageHeader,
  canvasKitEncodedImageIsReplayable,
  type CanvasKitEncodedImageHeader,
} from './encoded-image-admission';

export type CanvasKitPatternDiagnostics = {
  cacheHits: number;
  cacheMisses: number;
  failureCacheHits: number;
  surfaceCreations: number;
  surfaceFailures: number;
  imagesCreated: number;
};

export type CanvasKitImageFailureReason =
  | 'resourceUnavailable'
  | 'base64DecodeFailed'
  | 'encodedImageRejected'
  | 'imageDecodeFailed'
  | 'decodedDimensionsMismatch';

export type CanvasKitImageFailureDiagnostic = {
  source: 'resource' | 'inline' | 'missing';
  resourceId: number | null;
  reason: CanvasKitImageFailureReason;
};

export type CanvasKitImageDiagnostics = {
  cacheHits: number;
  cacheMisses: number;
  failureCacheHits: number;
  failureAttempts: number;
  pendingAccesses: number;
  pendingLoads: number;
  imagesDecoded: number;
  failures: CanvasKitImageFailureDiagnostic[];
};

export type CanvasKitAsyncImageDecodeEnvironment = {
  createImage: () => HTMLImageElement;
  createObjectUrl: (blob: Blob) => string;
  revokeObjectUrl: (url: string) => void;
};

type PendingSvgImageLoad = {
  image: HTMLImageElement;
  objectUrl: string;
  resourceId: number | undefined;
  base64: string | undefined;
  expectedHeader: CanvasKitEncodedImageHeader;
};

const browserAsyncImageDecodeEnvironment: CanvasKitAsyncImageDecodeEnvironment = {
  createImage: () => new Image(),
  createObjectUrl: (blob) => URL.createObjectURL(blob),
  revokeObjectUrl: (url) => URL.revokeObjectURL(url),
};

export class CanvasKitResourceCache {
  readonly imageCache = new Map<string, CanvasKitImage>();
  readonly mipmappedImageCache = new Map<string, CanvasKitImage>();
  readonly imageEffectCache = new Map<string, CanvasKitImage>();
  readonly patternImageCache = new Map<string, CanvasKitImage | null>();
  readonly failedImageCacheKeys = new Set<string>();
  private readonly failedImageReasons = new Map<string, CanvasKitImageFailureReason>();
  private readonly pendingSvgImageLoads = new Map<string, PendingSvgImageLoad>();
  private readonly imageFailureDiagnostics = new Map<string, CanvasKitImageFailureDiagnostic>();
  private readonly imageDiagnostics: Omit<CanvasKitImageDiagnostics, 'failures' | 'pendingLoads'> = {
    cacheHits: 0,
    cacheMisses: 0,
    failureCacheHits: 0,
    failureAttempts: 0,
    pendingAccesses: 0,
    imagesDecoded: 0,
  };
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
    failureCacheHits: 0,
    surfaceCreations: 0,
    surfaceFailures: 0,
    imagesCreated: 0,
  };

  private resources: PageLayerTree['resources'] | null = null;
  private resourceTableId: number | null = null;
  private asyncResourceReadyCallback: (() => void) | null = null;
  private asyncResourceNotificationQueued = false;
  private resourceGeneration = 0;
  private disposed = false;

  constructor(
    private readonly canvasKit: CanvasKit,
    private readonly asyncImageDecodeEnvironment = browserAsyncImageDecodeEnvironment,
  ) {}

  setResources(resources: PageLayerTree['resources'] | null | undefined): void {
    const nextResources = resources ?? null;
    const nextTableId = nextResources?.tableId ?? null;
    if (this.resourceTableId === nextTableId) {
      if (this.resources !== nextResources) {
        for (const [cacheKey, pending] of this.pendingSvgImageLoads) {
          if (!this.resourceImageCacheKeyIsCurrent(cacheKey, nextResources)) {
            this.cancelPendingSvgImageLoad(cacheKey, pending);
          }
        }
        this.clearReplacedResourceImageCaches(nextResources);
      }
      this.resources = nextResources;
      return;
    }
    this.resourceGeneration += 1;
    this.asyncResourceNotificationQueued = false;
    this.clearResourceImageCaches();
    this.resources = nextResources;
    this.resourceTableId = nextTableId;
  }

  setAsyncResourceReadyCallback(callback: (() => void) | null): void {
    this.asyncResourceReadyCallback = callback;
  }

  image(resourceId?: number, base64?: string, withMipmaps = false): CanvasKitImage | null {
    const cacheKey = this.imageResourceCacheKey(resourceId, base64);
    if (!cacheKey) {
      this.imageDiagnostics.cacheMisses += 1;
      this.recordImageFailure(null, resourceId, base64, 'resourceUnavailable');
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
    if (cached) {
      this.imageDiagnostics.cacheHits += 1;
      return cached;
    }
    if (this.failedImageCacheKeys.has(cacheKey)) {
      this.imageDiagnostics.failureCacheHits += 1;
      this.recordImageFailure(
        cacheKey,
        resourceId,
        base64,
        this.failedImageReasons.get(cacheKey) ?? 'imageDecodeFailed',
      );
      return null;
    }
    this.imageDiagnostics.cacheMisses += 1;

    let bytes: Uint8Array | undefined;
    try {
      bytes = this.imageBytes(resourceId, base64);
    } catch {
      this.recordImageFailure(cacheKey, resourceId, base64, 'base64DecodeFailed');
      return null;
    }
    if (!bytes) {
      this.recordImageFailure(cacheKey, resourceId, base64, 'resourceUnavailable');
      return null;
    }
    if (!canvasKitEncodedImageIsReplayable(bytes)) {
      this.recordImageFailure(cacheKey, resourceId, base64, 'encodedImageRejected');
      return null;
    }
    const imageHeader = canvasKitEncodedImageHeader(bytes);
    if (!imageHeader) {
      this.recordImageFailure(cacheKey, resourceId, base64, 'encodedImageRejected');
      return null;
    }
    if (imageHeader.format === 'svg') {
      this.imageDiagnostics.pendingAccesses += 1;
      if (!this.pendingSvgImageLoads.has(cacheKey)) {
        this.startSvgImageLoad(cacheKey, bytes, resourceId, base64, imageHeader);
      }
      return null;
    }
    let image: CanvasKitImage | null;
    try {
      image = this.canvasKit.MakeImageFromEncoded(bytes);
    } catch {
      image = null;
    }
    if (!image) {
      this.recordImageFailure(cacheKey, resourceId, base64, 'imageDecodeFailed');
      return null;
    }
    if (!this.decodedImageMatchesHeader(image, imageHeader)) {
      image.delete();
      this.recordImageFailure(cacheKey, resourceId, base64, 'decodedDimensionsMismatch');
      return null;
    }
    this.imageCache.set(cacheKey, image);
    this.imageDiagnostics.imagesDecoded += 1;
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
      return this.image(resourceId, base64);
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

  getImageDiagnostics(): CanvasKitImageDiagnostics {
    return {
      ...this.imageDiagnostics,
      pendingLoads: this.pendingSvgImageLoads.size,
      failures: [...this.imageFailureDiagnostics.values()].map((failure) => ({ ...failure })),
    };
  }

  resetImageDiagnostics(): void {
    this.imageDiagnostics.cacheHits = 0;
    this.imageDiagnostics.cacheMisses = 0;
    this.imageDiagnostics.failureCacheHits = 0;
    this.imageDiagnostics.failureAttempts = 0;
    this.imageDiagnostics.pendingAccesses = 0;
    this.imageDiagnostics.imagesDecoded = 0;
    this.imageFailureDiagnostics.clear();
  }

  resetImageEffectDiagnostics(): void {
    resetLayerImageEffectDiagnostics(this.imageEffectDiagnostics);
  }

  patternImage(pattern: LayerPatternFill): CanvasKitImage | null {
    const cacheKey = `${pattern.patternType}:${pattern.patternColor}:${pattern.backgroundColor}`;
    if (this.patternImageCache.has(cacheKey)) {
      this.patternDiagnostics.cacheHits += 1;
      const cached = this.patternImageCache.get(cacheKey) ?? null;
      if (!cached) {
        this.patternDiagnostics.failureCacheHits += 1;
        this.patternDiagnostics.surfaceFailures += 1;
      }
      return cached;
    }

    this.patternDiagnostics.cacheMisses += 1;
    const image = this.makePatternImage(pattern);
    this.patternImageCache.set(cacheKey, image);
    return image;
  }

  getPatternDiagnostics(): Readonly<CanvasKitPatternDiagnostics> {
    return { ...this.patternDiagnostics };
  }

  beginPatternReplay(): void {
    this.resetPatternDiagnostics();
    for (const [cacheKey, image] of this.patternImageCache) {
      if (!image) {
        this.patternImageCache.delete(cacheKey);
      }
    }
  }

  resetPatternDiagnostics(): void {
    this.patternDiagnostics.cacheHits = 0;
    this.patternDiagnostics.cacheMisses = 0;
    this.patternDiagnostics.failureCacheHits = 0;
    this.patternDiagnostics.surfaceCreations = 0;
    this.patternDiagnostics.surfaceFailures = 0;
    this.patternDiagnostics.imagesCreated = 0;
  }

  resetDocumentResources(): void {
    this.resourceGeneration += 1;
    this.asyncResourceNotificationQueued = false;
    this.resources = null;
    this.resourceTableId = null;
    for (const [cacheKey, pending] of this.pendingSvgImageLoads) {
      this.cancelPendingSvgImageLoad(cacheKey, pending);
    }

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
    this.failedImageReasons.clear();
    this.resetImageDiagnostics();
    this.resetImageEffectDiagnostics();
  }

  dispose(): void {
    this.disposed = true;
    this.asyncResourceReadyCallback = null;
    this.resetDocumentResources();

    for (const image of this.patternImageCache.values()) {
      image?.delete();
    }
    this.patternImageCache.clear();
  }

  private startSvgImageLoad(
    cacheKey: string,
    bytes: Uint8Array,
    resourceId: number | undefined,
    base64: string | undefined,
    expectedHeader: CanvasKitEncodedImageHeader,
  ): void {
    let objectUrl: string | null = null;
    let image: HTMLImageElement;
    try {
      const svgBytes = bytes.slice().buffer;
      objectUrl = this.asyncImageDecodeEnvironment.createObjectUrl(
        new Blob([svgBytes], { type: 'image/svg+xml' }),
      );
      image = this.asyncImageDecodeEnvironment.createImage();
    } catch {
      if (objectUrl) {
        this.revokeObjectUrl(objectUrl);
      }
      this.recordImageFailure(cacheKey, resourceId, base64, 'imageDecodeFailed');
      this.notifyAsyncResourceReady();
      return;
    }

    const pending: PendingSvgImageLoad = {
      image,
      objectUrl,
      resourceId,
      base64,
      expectedHeader,
    };
    this.pendingSvgImageLoads.set(cacheKey, pending);
    image.onload = () => {
      if (this.pendingSvgImageLoads.get(cacheKey) !== pending) {
        return;
      }
      let decodedImage: CanvasKitImage | null;
      try {
        decodedImage = this.canvasKit.MakeImageFromCanvasImageSource(image);
      } catch {
        decodedImage = null;
      }
      this.cancelPendingSvgImageLoad(cacheKey, pending);
      if (decodedImage && this.decodedImageMatchesHeader(decodedImage, pending.expectedHeader)) {
        this.imageCache.set(cacheKey, decodedImage);
        this.imageDiagnostics.imagesDecoded += 1;
      } else {
        decodedImage?.delete();
        this.recordImageFailure(
          cacheKey,
          resourceId,
          base64,
          decodedImage ? 'decodedDimensionsMismatch' : 'imageDecodeFailed',
        );
      }
      this.notifyAsyncResourceReady();
    };
    image.onerror = () => {
      if (this.pendingSvgImageLoads.get(cacheKey) !== pending) {
        return;
      }
      this.cancelPendingSvgImageLoad(cacheKey, pending);
      this.recordImageFailure(cacheKey, resourceId, base64, 'imageDecodeFailed');
      this.notifyAsyncResourceReady();
    };
    try {
      image.src = objectUrl;
    } catch {
      this.cancelPendingSvgImageLoad(cacheKey, pending);
      this.recordImageFailure(cacheKey, resourceId, base64, 'imageDecodeFailed');
      this.notifyAsyncResourceReady();
    }
  }

  private cancelPendingSvgImageLoad(cacheKey: string, pending: PendingSvgImageLoad): void {
    if (this.pendingSvgImageLoads.get(cacheKey) === pending) {
      this.pendingSvgImageLoads.delete(cacheKey);
    }
    pending.image.onload = null;
    pending.image.onerror = null;
    try {
      pending.image.src = '';
    } catch {
      // The handlers are already detached, so a source reset failure cannot revive the load.
    }
    this.revokeObjectUrl(pending.objectUrl);
  }

  private decodedImageMatchesHeader(
    image: CanvasKitImage,
    expectedHeader: CanvasKitEncodedImageHeader,
  ): boolean {
    try {
      const width = image.width();
      const height = image.height();
      return Number.isSafeInteger(width)
        && Number.isSafeInteger(height)
        && width === expectedHeader.width
        && height === expectedHeader.height;
    } catch {
      return false;
    }
  }

  private revokeObjectUrl(objectUrl: string): void {
    try {
      this.asyncImageDecodeEnvironment.revokeObjectUrl(objectUrl);
    } catch {
      // Revocation is best-effort after the pending entry and handlers have been cleared.
    }
  }

  private notifyAsyncResourceReady(): void {
    if (this.asyncResourceNotificationQueued || this.disposed) {
      return;
    }
    const generation = this.resourceGeneration;
    this.asyncResourceNotificationQueued = true;
    queueMicrotask(() => {
      this.asyncResourceNotificationQueued = false;
      if (!this.disposed && generation === this.resourceGeneration) {
        this.asyncResourceReadyCallback?.();
      }
    });
  }

  private recordImageFailure(
    cacheKey: string | null,
    resourceId: number | undefined,
    base64: string | undefined,
    reason: CanvasKitImageFailureReason,
  ): void {
    this.imageDiagnostics.failureAttempts += 1;
    if (cacheKey) {
      this.failedImageCacheKeys.add(cacheKey);
      this.failedImageReasons.set(cacheKey, reason);
    }
    const diagnosticKey = cacheKey ?? `missing:${resourceId ?? (base64 ? 'inline' : 'source')}`;
    if (this.imageFailureDiagnostics.has(diagnosticKey)) {
      return;
    }
    this.imageFailureDiagnostics.set(diagnosticKey, {
      source: typeof resourceId === 'number' ? 'resource' : base64 ? 'inline' : 'missing',
      resourceId: typeof resourceId === 'number' ? resourceId : null,
      reason,
    });
  }

  private imageResourceCacheKey(
    resourceId?: number,
    base64?: string,
    resources = this.resources,
  ): string | null {
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
    for (const [cacheKey, pending] of this.pendingSvgImageLoads) {
      if (cacheKey.startsWith('res:')) {
        this.cancelPendingSvgImageLoad(cacheKey, pending);
      }
    }
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
        this.failedImageReasons.delete(key);
      }
    }
  }

  private clearReplacedResourceImageCaches(
    nextResources: PageLayerTree['resources'] | null,
  ): void {
    for (const [cacheKey, image] of this.mipmappedImageCache) {
      if (!this.resourceImageCacheKeyIsCurrent(cacheKey, nextResources)) {
        image.delete();
        this.mipmappedImageCache.delete(cacheKey);
      }
    }
    for (const [cacheKey, image] of this.imageEffectCache) {
      if (!this.resourceImageCacheKeyIsCurrent(cacheKey, nextResources)) {
        image.delete();
        this.imageEffectCache.delete(cacheKey);
      }
    }
    for (const [cacheKey, image] of this.imageCache) {
      if (!this.resourceImageCacheKeyIsCurrent(cacheKey, nextResources)) {
        image.delete();
        this.imageCache.delete(cacheKey);
      }
    }
    for (const cacheKey of this.failedImageCacheKeys) {
      if (!this.resourceImageCacheKeyIsCurrent(cacheKey, nextResources)) {
        this.failedImageCacheKeys.delete(cacheKey);
        this.failedImageReasons.delete(cacheKey);
      }
    }
  }

  private resourceImageCacheKeyIsCurrent(
    cacheKey: string,
    nextResources: PageLayerTree['resources'] | null,
  ): boolean {
    if (!cacheKey.startsWith('res:')) {
      return true;
    }
    const resourceIdMatch = /^res:[^:]+:(\d+):/.exec(cacheKey);
    if (!resourceIdMatch) {
      return false;
    }
    const resourceId = Number(resourceIdMatch[1]);
    const expectedKey = this.imageResourceCacheKey(resourceId, undefined, nextResources);
    return expectedKey !== null
      && (cacheKey === expectedKey || cacheKey.startsWith(`${expectedKey}:`));
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
