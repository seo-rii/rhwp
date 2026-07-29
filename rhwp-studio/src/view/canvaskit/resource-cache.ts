import type { CanvasKit, Image as CanvasKitImage, Paint as CanvasKitPaint } from 'canvaskit-wasm';

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
  directImageCreations: number;
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

export type CanvasKitImageRecoveryDiagnostic = {
  source: 'resource' | 'inline';
  resourceId: number | null;
  reason: 'encodedImageDecodeFailed';
  fallback: 'browserImageSource';
  format: Exclude<CanvasKitEncodedImageHeader['format'], 'svg'>;
};

export type CanvasKitImageDiagnostics = {
  cacheHits: number;
  cacheMisses: number;
  failureCacheHits: number;
  failureAttempts: number;
  pendingAccesses: number;
  pendingLoads: number;
  imagesDecoded: number;
  recoveries: CanvasKitImageRecoveryDiagnostic[];
  failures: CanvasKitImageFailureDiagnostic[];
};

export type CanvasKitAsyncImageDecodeEnvironment = {
  createImage: () => HTMLImageElement;
  createObjectUrl: (blob: Blob) => string;
  revokeObjectUrl: (url: string) => void;
};

type PendingBrowserImageLoad = {
  image: HTMLImageElement;
  objectUrl: string;
  resourceId: number | undefined;
  base64: string | undefined;
  expectedHeader: CanvasKitEncodedImageHeader;
  recovery: CanvasKitImageRecoveryDiagnostic | null;
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
  private readonly pendingBrowserImageLoads = new Map<string, PendingBrowserImageLoad>();
  private readonly browserDecodedRasterRecoveries =
    new Map<string, CanvasKitImageRecoveryDiagnostic>();
  private readonly imageRecoveryDiagnostics =
    new Map<string, CanvasKitImageRecoveryDiagnostic>();
  private readonly imageRecoveryEvents: CanvasKitImageRecoveryDiagnostic[] = [];
  private readonly imageFailureDiagnostics = new Map<string, CanvasKitImageFailureDiagnostic>();
  private readonly imageDiagnostics: Omit<
    CanvasKitImageDiagnostics,
    'failures' | 'pendingLoads' | 'recoveries'
  > = {
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
    directImageReadbackPreprocesses: 0,
  };
  private readonly patternDiagnostics: CanvasKitPatternDiagnostics = {
    cacheHits: 0,
    cacheMisses: 0,
    failureCacheHits: 0,
    surfaceCreations: 0,
    directImageCreations: 0,
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
        for (const [cacheKey, pending] of this.pendingBrowserImageLoads) {
          if (!this.resourceImageCacheKeyIsCurrent(cacheKey, nextResources)) {
            this.cancelPendingBrowserImageLoad(cacheKey, pending);
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
      if (cachedMipmap) {
        this.recordImageRecovery(cacheKey);
        return cachedMipmap;
      }

      const original = this.image(resourceId, base64);
      if (!original) return null;

      const mipmapped = original.makeCopyWithDefaultMipmaps();
      this.mipmappedImageCache.set(cacheKey, mipmapped);
      return mipmapped;
    }

    const cached = this.imageCache.get(cacheKey);
    if (cached) {
      this.imageDiagnostics.cacheHits += 1;
      this.recordImageRecovery(cacheKey);
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
    if (this.pendingBrowserImageLoads.has(cacheKey)) {
      this.imageDiagnostics.pendingAccesses += 1;
      return null;
    }

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
      this.startBrowserImageLoad(cacheKey, bytes, resourceId, base64, imageHeader, null);
      return null;
    }
    let image: CanvasKitImage | null;
    try {
      image = this.canvasKit.MakeImageFromEncoded(bytes);
    } catch {
      image = null;
    }
    if (!image) {
      if (imageHeader.format === 'gif' || imageHeader.format === 'webp') {
        this.recordImageFailure(cacheKey, resourceId, base64, 'imageDecodeFailed');
        return null;
      }
      const recovery: CanvasKitImageRecoveryDiagnostic = {
        source: typeof resourceId === 'number' ? 'resource' : 'inline',
        resourceId: typeof resourceId === 'number' ? resourceId : null,
        reason: 'encodedImageDecodeFailed',
        fallback: 'browserImageSource',
        format: imageHeader.format,
      };
      this.imageDiagnostics.pendingAccesses += 1;
      this.startBrowserImageLoad(
        cacheKey,
        bytes,
        resourceId,
        base64,
        imageHeader,
        recovery,
      );
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
      this.recordImageRecovery(cacheKey);
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
    const imageInfo = {
      width: outputWidth,
      height: outputHeight,
      colorType: this.canvasKit.ColorType.RGBA_8888,
      alphaType: this.canvasKit.AlphaType.Unpremul,
      colorSpace: this.canvasKit.ColorSpace.SRGB,
    };
    let pixels: Uint8Array | null = null;
    let usedDirectImageReadback = false;
    let surface: ReturnType<CanvasKit['MakeSurface']> = null;
    try {
      surface = this.canvasKit.MakeSurface(outputWidth, outputHeight);
    } catch {
      surface = null;
    }
    if (surface) {
      try {
        const paint = new this.canvasKit.Paint();
        try {
          const canvas = surface.getCanvas();
          canvas.drawImageRect(
            original,
            this.canvasKit.XYWHRect(sx, sy, sw, sh),
            this.canvasKit.XYWHRect(0, 0, outputWidth, outputHeight),
            paint,
            false,
          );
          surface.flush();
          const snapshot = surface.makeImageSnapshot();
          try {
            const surfacePixels = snapshot.readPixels(0, 0, imageInfo);
            pixels = surfacePixels instanceof Uint8Array ? surfacePixels : null;
          } finally {
            snapshot.delete();
          }
        } finally {
          paint.delete();
        }
      } catch {
        pixels = null;
      } finally {
        surface.delete();
      }
    }

    if (!pixels) {
      const directX = Math.round(sx);
      const directY = Math.round(sy);
      const directWidth = Math.round(sw);
      const directHeight = Math.round(sh);
      const directReadIsExact = Math.abs(sx - directX) <= 1e-6
        && Math.abs(sy - directY) <= 1e-6
        && Math.abs(sw - directWidth) <= 1e-6
        && Math.abs(sh - directHeight) <= 1e-6
        && directWidth === outputWidth
        && directHeight === outputHeight
        && directX >= 0
        && directY >= 0
        && directX + directWidth <= imageWidth
        && directY + directHeight <= imageHeight;
      if (directReadIsExact) {
        try {
          const directPixels = original.readPixels(directX, directY, imageInfo);
          pixels = directPixels instanceof Uint8Array ? directPixels : null;
          usedDirectImageReadback = pixels !== null;
        } catch {
          pixels = null;
        }
      }
    }

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
    let image: CanvasKitImage | null;
    try {
      image = this.canvasKit.MakeImage(imageInfo, pixels, outputWidth * 4);
    } catch {
      image = null;
    }
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
    if (usedDirectImageReadback) {
      this.imageEffectDiagnostics.directImageReadbackPreprocesses += 1;
    }
    this.imageEffectCache.set(effectCacheKey, image);
    return image;
  }

  getImageEffectDiagnostics(): Readonly<LayerImageEffectDiagnostics> {
    return { ...this.imageEffectDiagnostics };
  }

  getImageDiagnostics(): CanvasKitImageDiagnostics {
    return {
      ...this.imageDiagnostics,
      pendingLoads: this.pendingBrowserImageLoads.size,
      recoveries: [...this.imageRecoveryDiagnostics.values()]
        .map((recovery) => ({ ...recovery })),
      failures: [...this.imageFailureDiagnostics.values()].map((failure) => ({ ...failure })),
    };
  }

  getImageRecoveryEventCount(): number {
    return this.imageRecoveryEvents.length;
  }

  getImageRecoveriesSince(eventIndex: number): CanvasKitImageRecoveryDiagnostic[] {
    const recoveries = new Map<string, CanvasKitImageRecoveryDiagnostic>();
    for (const recovery of this.imageRecoveryEvents.slice(eventIndex)) {
      const key = `${recovery.source}:${recovery.resourceId ?? 'inline'}:${recovery.format}`;
      recoveries.set(key, recovery);
    }
    return [...recoveries.values()].map((recovery) => ({ ...recovery }));
  }

  restoreImageRecoveries(recoveries: readonly CanvasKitImageRecoveryDiagnostic[]): void {
    for (const recovery of recoveries) {
      const key = `cached:${recovery.source}:${recovery.resourceId ?? 'inline'}:${recovery.format}`;
      this.imageRecoveryDiagnostics.set(key, recovery);
      this.imageRecoveryEvents.push({ ...recovery });
    }
  }

  resetImageDiagnostics(): void {
    this.imageDiagnostics.cacheHits = 0;
    this.imageDiagnostics.cacheMisses = 0;
    this.imageDiagnostics.failureCacheHits = 0;
    this.imageDiagnostics.failureAttempts = 0;
    this.imageDiagnostics.pendingAccesses = 0;
    this.imageDiagnostics.imagesDecoded = 0;
    this.imageRecoveryDiagnostics.clear();
    this.imageRecoveryEvents.length = 0;
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
    this.patternDiagnostics.directImageCreations = 0;
    this.patternDiagnostics.surfaceFailures = 0;
    this.patternDiagnostics.imagesCreated = 0;
  }

  resetDocumentResources(): void {
    this.resourceGeneration += 1;
    this.asyncResourceNotificationQueued = false;
    this.resources = null;
    this.resourceTableId = null;
    for (const [cacheKey, pending] of this.pendingBrowserImageLoads) {
      this.cancelPendingBrowserImageLoad(cacheKey, pending);
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
    this.browserDecodedRasterRecoveries.clear();
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

  private startBrowserImageLoad(
    cacheKey: string,
    bytes: Uint8Array,
    resourceId: number | undefined,
    base64: string | undefined,
    expectedHeader: CanvasKitEncodedImageHeader,
    recovery: CanvasKitImageRecoveryDiagnostic | null,
  ): void {
    let objectUrl: string | null = null;
    let image: HTMLImageElement;
    try {
      let mimeType: string;
      switch (expectedHeader.format) {
        case 'png':
          mimeType = 'image/png';
          break;
        case 'jpeg':
          mimeType = 'image/jpeg';
          break;
        case 'gif':
          mimeType = 'image/gif';
          break;
        case 'webp':
          mimeType = 'image/webp';
          break;
        case 'bmp':
          mimeType = 'image/bmp';
          break;
        case 'svg':
          mimeType = 'image/svg+xml';
          break;
      }
      const imageBytes = bytes.slice().buffer;
      objectUrl = this.asyncImageDecodeEnvironment.createObjectUrl(
        new Blob([imageBytes], { type: mimeType }),
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

    const pending: PendingBrowserImageLoad = {
      image,
      objectUrl,
      resourceId,
      base64,
      expectedHeader,
      recovery,
    };
    this.pendingBrowserImageLoads.set(cacheKey, pending);
    image.onload = () => {
      if (this.pendingBrowserImageLoads.get(cacheKey) !== pending) {
        return;
      }
      let decodedImage: CanvasKitImage | null;
      try {
        decodedImage = this.canvasKit.MakeImageFromCanvasImageSource(image);
      } catch {
        decodedImage = null;
      }
      this.cancelPendingBrowserImageLoad(cacheKey, pending);
      if (decodedImage && this.decodedImageMatchesHeader(decodedImage, pending.expectedHeader)) {
        this.imageCache.set(cacheKey, decodedImage);
        this.imageDiagnostics.imagesDecoded += 1;
        if (pending.recovery) {
          this.browserDecodedRasterRecoveries.set(cacheKey, pending.recovery);
          this.recordImageRecovery(cacheKey);
        }
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
      if (this.pendingBrowserImageLoads.get(cacheKey) !== pending) {
        return;
      }
      this.cancelPendingBrowserImageLoad(cacheKey, pending);
      this.recordImageFailure(cacheKey, resourceId, base64, 'imageDecodeFailed');
      this.notifyAsyncResourceReady();
    };
    try {
      image.src = objectUrl;
    } catch {
      this.cancelPendingBrowserImageLoad(cacheKey, pending);
      this.recordImageFailure(cacheKey, resourceId, base64, 'imageDecodeFailed');
      this.notifyAsyncResourceReady();
    }
  }

  private cancelPendingBrowserImageLoad(
    cacheKey: string,
    pending: PendingBrowserImageLoad,
  ): void {
    if (this.pendingBrowserImageLoads.get(cacheKey) === pending) {
      this.pendingBrowserImageLoads.delete(cacheKey);
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

  private recordImageRecovery(cacheKey: string): void {
    const recovery = this.browserDecodedRasterRecoveries.get(cacheKey);
    if (!recovery) {
      return;
    }
    this.imageRecoveryDiagnostics.set(cacheKey, recovery);
    this.imageRecoveryEvents.push({ ...recovery });
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
    let surface: ReturnType<CanvasKit['MakeSurface']> = null;
    try {
      surface = this.canvasKit.MakeSurface(6, 6);
    } catch {
      surface = null;
    }
    if (surface) {
      this.patternDiagnostics.surfaceCreations += 1;
      let fillPaint: CanvasKitPaint | null = null;
      let strokePaint: CanvasKitPaint | null = null;
      try {
        const canvas = surface.getCanvas();
        fillPaint = new this.canvasKit.Paint();
        fillPaint.setStyle(this.canvasKit.PaintStyle.Fill);
        fillPaint.setColor(parseCanvasKitCssColor(this.canvasKit, pattern.backgroundColor));
        canvas.drawRect(this.canvasKit.XYWHRect(0, 0, 6, 6), fillPaint);

        strokePaint = new this.canvasKit.Paint();
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

        surface.flush();
        const image = surface.makeImageSnapshot();
        this.patternDiagnostics.imagesCreated += 1;
        return image;
      } catch {
        // Fall through to the deterministic raw-pixel tile.
      } finally {
        strokePaint?.delete();
        fillPaint?.delete();
        surface.delete();
      }
    }

    const background = parseCanvasKitCssColor(this.canvasKit, pattern.backgroundColor);
    const foreground = parseCanvasKitCssColor(this.canvasKit, pattern.patternColor);
    const pixels = new Uint8Array(6 * 6 * 4);
    for (let y = 0; y < 6; y += 1) {
      for (let x = 0; x < 6; x += 1) {
        let patternPasses = 0;
        switch (pattern.patternType) {
          case 0:
            patternPasses = Number(y === 3);
            break;
          case 1:
            patternPasses = Number(x === 3);
            break;
          case 2:
            patternPasses = Number(x === 5 - y);
            break;
          case 3:
            patternPasses = Number(x === y);
            break;
          case 4:
            patternPasses = Number(x === 3) + Number(y === 3);
            break;
          case 5:
            patternPasses = Number(x === y || x === 5 - y);
            break;
          default:
            break;
        }
        let outputAlpha = background[3];
        const premultiplied = [
          background[0] * outputAlpha,
          background[1] * outputAlpha,
          background[2] * outputAlpha,
        ];
        for (let pass = 0; pass < patternPasses; pass += 1) {
          const foregroundAlpha = foreground[3];
          for (let channel = 0; channel < 3; channel += 1) {
            premultiplied[channel] = foreground[channel] * foregroundAlpha
              + premultiplied[channel] * (1 - foregroundAlpha);
          }
          outputAlpha = foregroundAlpha + outputAlpha * (1 - foregroundAlpha);
        }
        const offset = (y * 6 + x) * 4;
        for (let channel = 0; channel < 3; channel += 1) {
          pixels[offset + channel] = Math.round(
            Math.max(
              0,
              Math.min(1, outputAlpha > 0 ? premultiplied[channel] / outputAlpha : 0),
            ) * 255,
          );
        }
        pixels[offset + 3] = Math.round(Math.max(0, Math.min(1, outputAlpha)) * 255);
      }
    }

    const imageInfo = {
      width: 6,
      height: 6,
      colorType: this.canvasKit.ColorType.RGBA_8888,
      alphaType: this.canvasKit.AlphaType.Unpremul,
      colorSpace: this.canvasKit.ColorSpace.SRGB,
    };
    let image: CanvasKitImage | null;
    try {
      image = this.canvasKit.MakeImage(imageInfo, pixels, 6 * 4);
    } catch {
      image = null;
    }
    if (!image) {
      this.patternDiagnostics.surfaceFailures += 1;
      return null;
    }
    this.patternDiagnostics.directImageCreations += 1;
    this.patternDiagnostics.imagesCreated += 1;
    return image;
  }

  private clearResourceImageCaches(): void {
    for (const [cacheKey, pending] of this.pendingBrowserImageLoads) {
      if (cacheKey.startsWith('res:')) {
        this.cancelPendingBrowserImageLoad(cacheKey, pending);
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
    for (const key of this.browserDecodedRasterRecoveries.keys()) {
      if (key.startsWith('res:')) {
        this.browserDecodedRasterRecoveries.delete(key);
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
    for (const cacheKey of this.browserDecodedRasterRecoveries.keys()) {
      if (!this.resourceImageCacheKeyIsCurrent(cacheKey, nextResources)) {
        this.browserDecodedRasterRecoveries.delete(cacheKey);
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
