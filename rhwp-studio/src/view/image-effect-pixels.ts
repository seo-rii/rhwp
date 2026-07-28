import type { LayerImageOp } from '@/core/types';

export type LayerImageEffectSourceRect = { x: number; y: number; width: number; height: number };

export type LayerImageEffectDiagnostics = {
  cacheHits: number;
  cacheMisses: number;
  preprocessFailures: number;
  fallbackToOriginal: number;
  preprocessedPixels: number;
  preprocessedBytes: number;
  maxPreprocessedBytes: number;
  preprocessTimeMs: number;
  maxPreprocessTimeMs: number;
  heapDeltaBytes: number;
  maxHeapDeltaBytes: number;
  offscreenCanvasPreprocesses: number;
  htmlCanvasPreprocesses: number;
};

const ORDERED_DITHER_8X8 = [
  0, 48, 12, 60, 3, 51, 15, 63,
  32, 16, 44, 28, 35, 19, 47, 31,
  8, 56, 4, 52, 11, 59, 7, 55,
  40, 24, 36, 20, 43, 27, 39, 23,
  2, 50, 14, 62, 1, 49, 13, 61,
  34, 18, 46, 30, 33, 17, 45, 29,
  10, 58, 6, 54, 9, 57, 5, 53,
  42, 26, 38, 22, 41, 25, 37, 21,
] as const;

export function resetLayerImageEffectDiagnostics(diagnostics: LayerImageEffectDiagnostics): void {
  diagnostics.cacheHits = 0;
  diagnostics.cacheMisses = 0;
  diagnostics.preprocessFailures = 0;
  diagnostics.fallbackToOriginal = 0;
  diagnostics.preprocessedPixels = 0;
  diagnostics.preprocessedBytes = 0;
  diagnostics.maxPreprocessedBytes = 0;
  diagnostics.preprocessTimeMs = 0;
  diagnostics.maxPreprocessTimeMs = 0;
  diagnostics.heapDeltaBytes = 0;
  diagnostics.maxHeapDeltaBytes = 0;
  diagnostics.offscreenCanvasPreprocesses = 0;
  diagnostics.htmlCanvasPreprocesses = 0;
}

export function resolveLayerImageCropSource(
  imageWidth: number,
  imageHeight: number,
  crop?: LayerImageOp['crop'],
  cropReferenceSize?: LayerImageOp['originalSizeHu'],
): LayerImageEffectSourceRect | null {
  if (!crop) {
    return null;
  }
  if (
    !Number.isFinite(imageWidth)
    || !Number.isFinite(imageHeight)
    || imageWidth <= 0
    || imageHeight <= 0
    || !Number.isFinite(crop.left)
    || !Number.isFinite(crop.top)
    || !Number.isFinite(crop.right)
    || !Number.isFinite(crop.bottom)
  ) {
    return null;
  }

  const referenceWidth = cropReferenceSize?.[0];
  const referenceHeight = cropReferenceSize?.[1];
  const hasValidReference = typeof referenceWidth === 'number'
    && typeof referenceHeight === 'number'
    && Number.isFinite(referenceWidth)
    && Number.isFinite(referenceHeight)
    && referenceWidth > 0
    && referenceHeight > 0;
  const hasAdaptiveRange = crop.right > 0 && crop.bottom > 0;
  const scaleX = hasValidReference
    ? referenceWidth / imageWidth
    : hasAdaptiveRange
      ? crop.right / imageWidth
      : 75;
  const scaleY = hasValidReference
    ? referenceHeight / imageHeight
    : hasAdaptiveRange
      ? crop.bottom / imageHeight
      : 75;

  const srcX = crop.left / scaleX;
  const srcY = crop.top / scaleY;
  const srcW = (crop.right - crop.left) / scaleX;
  const srcH = (crop.bottom - crop.top) / scaleY;
  const isCropped = srcX > 0.5
    || srcY > 0.5
    || Math.abs(srcW - imageWidth) > 1
    || Math.abs(srcH - imageHeight) > 1;

  return isCropped && srcW > 0 && srcH > 0
    ? { x: srcX, y: srcY, width: srcW, height: srcH }
    : null;
}

export function canPreprocessCroppedLayerImageEffect(fillMode = 'fitToSize'): boolean {
  return fillMode === 'fitToSize' || fillMode === 'total' || fillMode === 'none';
}

export function applyLayerImageEffectPixels(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  effect: LayerImageOp['effect'] | undefined,
  patternPhaseX = 0,
  patternPhaseY = 0,
  brightness = 0,
  contrast = 0,
): boolean {
  const hasEffect = !!effect && effect !== 'realPic';
  const hasTone = brightness !== 0 || contrast !== 0;
  if ((!hasEffect && !hasTone) || !Number.isFinite(width) || width <= 0) {
    return false;
  }

  const brightnessScale = (100 + brightness) / 100;
  const contrastScale = (100 + contrast) / 100;
  for (let index = 0; index < data.length; index += 4) {
    if (hasEffect) {
      const luma = Math.round(data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114);
      let value = luma;
      if (effect === 'blackWhite') {
        value = luma >= 128 ? 255 : 0;
      } else if (effect === 'pattern8x8') {
        const pixel = index / 4;
        const x = pixel % width;
        const y = Math.floor(pixel / width);
        const matrix = ORDERED_DITHER_8X8[((y + patternPhaseY) & 7) * 8 + ((x + patternPhaseX) & 7)];
        const threshold = Math.floor(((matrix * 2 + 1) * 255) / 128);
        value = luma > threshold ? 255 : 0;
      }
      data[index] = value;
      data[index + 1] = value;
      data[index + 2] = value;
    }
    if (hasTone) {
      for (let channel = 0; channel < 3; channel += 1) {
        const adjusted = (data[index + channel] * brightnessScale - 128) * contrastScale + 128;
        data[index + channel] = Math.max(0, Math.min(255, Math.round(adjusted)));
      }
    }
  }
  return true;
}
