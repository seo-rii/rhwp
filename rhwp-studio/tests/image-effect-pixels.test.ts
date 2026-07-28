import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  applyLayerImageEffectPixels,
  canPreprocessCroppedLayerImageEffect,
  decodeBase64,
  resolveLayerImageCropSource,
} from '../src/view/image-effect-pixels.ts';

function pixelData(values: Array<[number, number, number, number]>): Uint8ClampedArray {
  return new Uint8ClampedArray(values.flatMap(([red, green, blue, alpha]) => [red, green, blue, alpha]));
}

test('decodeBase64 accepts whitespace and URL-safe payloads without DOM APIs', () => {
  const previousAtob = globalThis.atob;
  try {
    Object.defineProperty(globalThis, 'atob', {
      value: undefined,
      configurable: true,
      writable: true,
    });

    assert.deepEqual(Array.from(decodeBase64('SG Vs\n bG8=')), [72, 101, 108, 108, 111]);
    assert.deepEqual(Array.from(decodeBase64('__8=')), [255, 255]);
    assert.throws(() => decodeBase64('abcde'), /Invalid base64 payload length/);
    assert.throws(() => decodeBase64('a=b='), /Invalid base64 padding/);
    assert.throws(() => decodeBase64('@@@@'), /Invalid base64 character/);
  } finally {
    Object.defineProperty(globalThis, 'atob', {
      value: previousAtob,
      configurable: true,
      writable: true,
    });
  }
});

test('resolveLayerImageCropSource normalizes HWP crop bounds to source pixels', () => {
  assert.deepEqual(
    resolveLayerImageCropSource(100, 80, {
      left: 10,
      top: 20,
      right: 90,
      bottom: 100,
    }),
    {
      x: 11.11111111111111,
      y: 16,
      width: 88.88888888888889,
      height: 64,
    },
  );
  assert.equal(
    resolveLayerImageCropSource(100, 80, {
      left: 0,
      top: 0,
      right: 100,
      bottom: 80,
    }),
    null,
  );
  assert.equal(
    resolveLayerImageCropSource(100, 80, {
      left: 10,
      top: 0,
      right: 0,
      bottom: 80,
    }),
    null,
  );
});

test('resolveLayerImageCropSource uses imgDim instead of cropped bounds as the full coordinate range', () => {
  assert.deepEqual(
    resolveLayerImageCropSource(
      100,
      80,
      {
        left: 100,
        top: 100,
        right: 900,
        bottom: 700,
      },
      [1000, 800],
    ),
    {
      x: 10,
      y: 10,
      width: 80,
      height: 60,
    },
  );
  assert.equal(
    resolveLayerImageCropSource(
      100,
      80,
      {
        left: 0,
        top: 0,
        right: 1000,
        bottom: 800,
      },
      [1000, 800],
    ),
    null,
  );
});

test('resolveLayerImageCropSource retains the fixed HWPUNIT fallback without a full range', () => {
  assert.deepEqual(
    resolveLayerImageCropSource(100, 80, {
      left: -750,
      top: 0,
      right: 0,
      bottom: 750,
    }),
    {
      x: -10,
      y: 0,
      width: 10,
      height: 10,
    },
  );
});

test('canPreprocessCroppedLayerImageEffect matches deterministic image fill modes', () => {
  assert.equal(canPreprocessCroppedLayerImageEffect(), true);
  assert.equal(canPreprocessCroppedLayerImageEffect('fitToSize'), true);
  assert.equal(canPreprocessCroppedLayerImageEffect('total'), true);
  assert.equal(canPreprocessCroppedLayerImageEffect('none'), true);
  assert.equal(canPreprocessCroppedLayerImageEffect('tile'), false);
});

test('applyLayerImageEffectPixels applies gray scale without touching alpha', () => {
  const data = pixelData([
    [255, 0, 0, 17],
    [0, 255, 0, 34],
    [0, 0, 255, 51],
  ]);

  assert.equal(applyLayerImageEffectPixels(data, 3, 'grayScale'), true);

  assert.deepEqual(Array.from(data), [
    76, 76, 76, 17,
    150, 150, 150, 34,
    29, 29, 29, 51,
  ]);
});

test('applyLayerImageEffectPixels applies blackWhite before tone adjustment', () => {
  const data = pixelData([
    [10, 10, 10, 255],
    [200, 200, 200, 255],
  ]);

  assert.equal(applyLayerImageEffectPixels(data, 2, 'blackWhite', 0, 0, 10, 20), true);

  assert.deepEqual(Array.from(data), [
    0, 0, 0, 255,
    255, 255, 255, 255,
  ]);
});

test('applyLayerImageEffectPixels uses the shared 8x8 ordered dither fixture', () => {
  const fixture = readFileSync(new URL('../../tests/fixtures/image_effect_pattern8x8_luma126.txt', import.meta.url), 'utf8')
    .trim()
    .split(/\n/)
    .filter((line) => !line.startsWith('#'))
    .flatMap((line) => line.trim().split(/\s+/).map(Number));
  const data = pixelData(Array.from({ length: 64 }, () => [126, 126, 126, 255]));

  assert.equal(applyLayerImageEffectPixels(data, 8, 'pattern8x8'), true);

  const actual = Array.from({ length: 64 }, (_, index) => data[index * 4]);
  assert.deepEqual(actual, fixture);
  assert.equal(data[3], 255);
  assert.equal(data[63 * 4 + 3], 255);
});

test('applyLayerImageEffectPixels applies tone without requiring an image effect', () => {
  const data = pixelData([[100, 120, 140, 200]]);

  assert.equal(applyLayerImageEffectPixels(data, 1, undefined, 0, 0, 20, -25), true);

  assert.deepEqual(Array.from(data), [122, 140, 158, 200]);
});

test('applyLayerImageEffectPixels skips no-op and invalid-width inputs', () => {
  const data = pixelData([[100, 120, 140, 200]]);

  assert.equal(applyLayerImageEffectPixels(data, 1, 'realPic'), false);
  assert.deepEqual(Array.from(data), [100, 120, 140, 200]);
  assert.equal(applyLayerImageEffectPixels(data, 0, 'grayScale'), false);
  assert.deepEqual(Array.from(data), [100, 120, 140, 200]);
});
