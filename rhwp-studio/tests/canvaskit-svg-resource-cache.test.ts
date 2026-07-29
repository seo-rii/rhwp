// CanvasKit and browser objects are intentionally lightweight runtime fakes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createServer } from 'vite';

const studioRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let vite;
let CanvasKitResourceCache;

test.before(async () => {
  vite = await createServer({
    root: studioRoot,
    logLevel: 'silent',
    server: { middlewareMode: true },
  });
  ({ CanvasKitResourceCache } = await vite.ssrLoadModule(
    '/src/view/canvaskit/resource-cache.ts',
  ));
});

test.after(async () => {
  await vite?.close();
});

test('keeps encoded raster decoding synchronous', () => {
  const harness = makeHarness();
  const rasterImage = fakeCanvasKitImage(16, 12);
  harness.canvasKit.encodedResult = rasterImage;

  const result = harness.cache.image(undefined, base64(png(16, 12)));

  assert.equal(result, rasterImage);
  assert.equal(harness.canvasKit.encodedSources.length, 1);
  assert.equal(harness.canvasKit.canvasSources.length, 0);
  assert.equal(harness.browser.images.length, 0);
  assert.equal(harness.cache.getImageDiagnostics().pendingLoads, 0);
});

test('preprocesses integer image effects by direct readback when surfaces are unavailable', () => {
  const harness = makeHarness();
  const original = fakeCanvasKitImage(3, 1);
  const processed = fakeCanvasKitImage(1, 1);
  const sourcePixels = Uint8Array.of(
    220, 10, 30, 255,
    20, 200, 40, 192,
    30, 40, 230, 128,
  );
  const readCalls = [];
  const makeImageCalls = [];
  original.readPixels = (x, y, imageInfo) => {
    readCalls.push({ x, y, imageInfo });
    return sourcePixels.slice(x * 4, (x + imageInfo.width) * 4);
  };
  harness.canvasKit.encodedResult = original;
  harness.canvasKit.MakeSurface = () => {
    throw new Error('surface unavailable');
  };
  harness.canvasKit.ColorType = { RGBA_8888: 'rgba8888' };
  harness.canvasKit.AlphaType = { Unpremul: 'unpremul' };
  harness.canvasKit.ColorSpace = { SRGB: 'srgb' };
  harness.canvasKit.MakeImage = (imageInfo, pixels, rowBytes) => {
    makeImageCalls.push({ imageInfo, pixels: pixels.slice(), rowBytes });
    return processed;
  };

  const result = harness.cache.imageWithEffect(
    undefined,
    base64(png(3, 1)),
    'grayScale',
    { x: 1, y: 0, width: 1, height: 1 },
  );

  assert.equal(result, processed);
  assert.deepEqual(readCalls.map(({ x, y, imageInfo }) => ({
    x,
    y,
    width: imageInfo.width,
    height: imageInfo.height,
  })), [{ x: 1, y: 0, width: 1, height: 1 }]);
  assert.deepEqual([...makeImageCalls[0].pixels], [128, 128, 128, 192]);
  assert.equal(makeImageCalls[0].rowBytes, 4);
  const diagnostics = harness.cache.getImageEffectDiagnostics();
  assert.equal(diagnostics.cacheHits, 0);
  assert.equal(diagnostics.cacheMisses, 1);
  assert.equal(diagnostics.preprocessFailures, 0);
  assert.equal(diagnostics.fallbackToOriginal, 0);
  assert.equal(diagnostics.preprocessedPixels, 1);
  assert.equal(diagnostics.preprocessedBytes, 4);
  assert.equal(diagnostics.directImageReadbackPreprocesses, 1);
});

test('does not approximate fractional image-effect sampling without a surface', () => {
  const harness = makeHarness();
  const original = fakeCanvasKitImage(3, 1);
  let readCalls = 0;
  original.readPixels = () => {
    readCalls += 1;
    return new Uint8Array(4);
  };
  harness.canvasKit.encodedResult = original;
  harness.canvasKit.MakeSurface = () => null;
  harness.canvasKit.ColorType = { RGBA_8888: 'rgba8888' };
  harness.canvasKit.AlphaType = { Unpremul: 'unpremul' };
  harness.canvasKit.ColorSpace = { SRGB: 'srgb' };

  assert.equal(
    harness.cache.imageWithEffect(
      undefined,
      base64(png(3, 1)),
      'grayScale',
      { x: 0.25, y: 0, width: 1.5, height: 1 },
    ),
    original,
  );
  assert.equal(readCalls, 0);
  assert.equal(harness.cache.getImageEffectDiagnostics().preprocessFailures, 1);
  assert.equal(harness.cache.getImageEffectDiagnostics().fallbackToOriginal, 1);
  assert.equal(harness.cache.getImageEffectDiagnostics().preprocessedPixels, 0);
  assert.equal(harness.cache.getImageEffectDiagnostics().directImageReadbackPreprocesses, 0);
});

test('creates deterministic pattern images without offscreen surfaces', () => {
  const harness = makeHarness();
  const directImage = fakeCanvasKitImage(6, 6);
  const makeImageCalls = [];
  harness.canvasKit.MakeSurface = () => {
    throw new Error('surface unavailable');
  };
  harness.canvasKit.ColorType = { RGBA_8888: 'rgba8888' };
  harness.canvasKit.AlphaType = { Unpremul: 'unpremul' };
  harness.canvasKit.ColorSpace = { SRGB: 'srgb' };
  harness.canvasKit.MakeImage = (imageInfo, pixels, rowBytes) => {
    makeImageCalls.push({ imageInfo, pixels: pixels.slice(), rowBytes });
    return directImage;
  };
  const pattern = {
    patternType: 5,
    patternColor: '#aabbcc',
    backgroundColor: '#112233',
  };

  assert.equal(harness.cache.patternImage(pattern), directImage);
  assert.equal(harness.cache.patternImage(pattern), directImage);
  assert.equal(makeImageCalls.length, 1);
  assert.equal(makeImageCalls[0].rowBytes, 24);
  assert.deepEqual(
    {
      width: makeImageCalls[0].imageInfo.width,
      height: makeImageCalls[0].imageInfo.height,
      colorType: makeImageCalls[0].imageInfo.colorType,
      alphaType: makeImageCalls[0].imageInfo.alphaType,
      colorSpace: makeImageCalls[0].imageInfo.colorSpace,
    },
    {
      width: 6,
      height: 6,
      colorType: 'rgba8888',
      alphaType: 'unpremul',
      colorSpace: 'srgb',
    },
  );
  const expectedPixels = [];
  for (let y = 0; y < 6; y += 1) {
    for (let x = 0; x < 6; x += 1) {
      expectedPixels.push(
        ...(x === y || x === 5 - y
          ? [0xaa, 0xbb, 0xcc, 0xff]
          : [0x11, 0x22, 0x33, 0xff]),
      );
    }
  }
  assert.deepEqual([...makeImageCalls[0].pixels], expectedPixels);
  assert.deepEqual(harness.cache.getPatternDiagnostics(), {
    cacheHits: 1,
    cacheMisses: 1,
    failureCacheHits: 0,
    surfaceCreations: 0,
    directImageCreations: 1,
    surfaceFailures: 0,
    imagesCreated: 1,
  });
});

test('uses the CanvasKit integer mask for every direct pattern type', () => {
  const harness = makeHarness();
  const makeImagePixels = [];
  harness.canvasKit.MakeSurface = () => null;
  harness.canvasKit.ColorType = { RGBA_8888: 'rgba8888' };
  harness.canvasKit.AlphaType = { Unpremul: 'unpremul' };
  harness.canvasKit.ColorSpace = { SRGB: 'srgb' };
  harness.canvasKit.MakeImage = (_imageInfo, pixels) => {
    makeImagePixels.push(pixels.slice());
    return fakeCanvasKitImage(6, 6);
  };

  for (let patternType = 0; patternType < 6; patternType += 1) {
    assert.notEqual(harness.cache.patternImage({
      patternType,
      patternColor: '#ffffff',
      backgroundColor: '#000000',
    }), null);
  }

  assert.equal(makeImagePixels.length, 6);
  for (let patternType = 0; patternType < 6; patternType += 1) {
    const pixels = makeImagePixels[patternType];
    for (let y = 0; y < 6; y += 1) {
      for (let x = 0; x < 6; x += 1) {
        const expectedForeground = patternType === 0
          ? y === 3
          : patternType === 1
            ? x === 3
            : patternType === 2
              ? x === 5 - y
              : patternType === 3
                ? x === y
                : patternType === 4
                  ? x === 3 || y === 3
                  : x === y || x === 5 - y;
        const offset = (y * 6 + x) * 4;
        assert.deepEqual(
          [...pixels.slice(offset, offset + 4)],
          expectedForeground ? [255, 255, 255, 255] : [0, 0, 0, 255],
          `pattern=${patternType}, x=${x}, y=${y}`,
        );
      }
    }
  }
  assert.equal(harness.cache.getPatternDiagnostics().directImageCreations, 6);
  assert.equal(harness.cache.getPatternDiagnostics().surfaceFailures, 0);
});

test('negative-caches pattern images only when surface and direct creation both fail', () => {
  const harness = makeHarness();
  harness.canvasKit.MakeSurface = () => null;
  harness.canvasKit.ColorType = { RGBA_8888: 'rgba8888' };
  harness.canvasKit.AlphaType = { Unpremul: 'unpremul' };
  harness.canvasKit.ColorSpace = { SRGB: 'srgb' };
  harness.canvasKit.MakeImage = () => null;
  const pattern = {
    patternType: 0,
    patternColor: '#aabbcc',
    backgroundColor: '#112233',
  };

  assert.equal(harness.cache.patternImage(pattern), null);
  assert.equal(harness.cache.patternImage(pattern), null);
  assert.deepEqual(harness.cache.getPatternDiagnostics(), {
    cacheHits: 1,
    cacheMisses: 1,
    failureCacheHits: 1,
    surfaceCreations: 0,
    directImageCreations: 0,
    surfaceFailures: 2,
    imagesCreated: 0,
  });
});

test('recovers encoded raster decoder failures through a direct CanvasKit browser image', async () => {
  const harness = makeHarness();
  const decodedImage = fakeCanvasKitImage(16, 12);
  harness.canvasKit.encodedResult = null;
  harness.canvasKit.canvasResult = decodedImage;
  let readyCallbacks = 0;
  harness.cache.setAsyncResourceReadyCallback(() => {
    readyCallbacks += 1;
  });
  const encodedPng = base64(png(16, 12));

  assert.equal(harness.cache.image(undefined, encodedPng), null);
  assert.equal(harness.cache.image(undefined, encodedPng), null);
  assert.equal(harness.canvasKit.encodedSources.length, 1);
  assert.equal(harness.browser.images.length, 1);
  assert.equal(harness.browser.blobs[0].type, 'image/png');
  assert.equal(harness.cache.getImageDiagnostics().pendingAccesses, 2);
  assert.equal(harness.cache.getImageDiagnostics().pendingLoads, 1);

  harness.browser.images[0].onload();
  await Promise.resolve();

  assert.equal(readyCallbacks, 1);
  assert.equal(harness.cache.image(undefined, encodedPng), decodedImage);
  assert.deepEqual(harness.canvasKit.canvasSources, [harness.browser.images[0]]);
  assert.deepEqual(harness.cache.getImageDiagnostics().recoveries, [{
    source: 'inline',
    resourceId: null,
    reason: 'encodedImageDecodeFailed',
    fallback: 'browserImageSource',
    format: 'png',
  }]);
  assert.deepEqual(harness.cache.getImageDiagnostics().failures, []);

  harness.cache.resetImageDiagnostics();
  assert.equal(harness.cache.image(undefined, encodedPng), decodedImage);
  assert.equal(harness.cache.getImageDiagnostics().recoveries.length, 1);

  const firstMipmap = harness.cache.image(undefined, encodedPng, true);
  assert.notEqual(firstMipmap, null);
  harness.cache.resetImageDiagnostics();
  assert.equal(harness.cache.image(undefined, encodedPng, true), firstMipmap);
  assert.equal(harness.cache.getImageDiagnostics().recoveries.length, 1);

  const cachedEffect = fakeCanvasKitImage(16, 12);
  harness.cache.imageEffectCache.set(`b64:${encodedPng}:effect:grayScale`, cachedEffect);
  harness.cache.resetImageDiagnostics();
  assert.equal(
    harness.cache.imageWithEffect(undefined, encodedPng, 'grayScale'),
    cachedEffect,
  );
  assert.equal(harness.cache.getImageDiagnostics().recoveries.length, 1);

  harness.cache.resetImageDiagnostics();
  const recoveryEventStart = harness.cache.getImageRecoveryEventCount();
  assert.equal(harness.cache.image(undefined, encodedPng), decodedImage);
  const cachedPictureRecoveries = harness.cache.getImageRecoveriesSince(recoveryEventStart);
  harness.cache.resetImageDiagnostics();
  harness.cache.restoreImageRecoveries(cachedPictureRecoveries);
  assert.deepEqual(harness.cache.getImageDiagnostics().recoveries, [{
    source: 'inline',
    resourceId: null,
    reason: 'encodedImageDecodeFailed',
    fallback: 'browserImageSource',
    format: 'png',
  }]);
});

test('negative-caches browser raster recovery failures', async () => {
  const harness = makeHarness();
  harness.canvasKit.encodedResult = null;
  const encodedPng = base64(png(20, 14));

  assert.equal(harness.cache.image(undefined, encodedPng), null);
  harness.browser.images[0].onerror();
  await Promise.resolve();

  assert.equal(harness.cache.image(undefined, encodedPng), null);
  assert.equal(harness.canvasKit.encodedSources.length, 1);
  assert.equal(harness.browser.images.length, 1);
  assert.equal(harness.cache.getImageDiagnostics().failureCacheHits, 1);
  assert.deepEqual(harness.cache.getImageDiagnostics().recoveries, []);
  assert.deepEqual(harness.cache.getImageDiagnostics().failures, [{
    source: 'inline',
    resourceId: null,
    reason: 'imageDecodeFailed',
  }]);
});

test('does not browser-normalize GIF when CanvasKit cannot establish a stable frame', () => {
  const harness = makeHarness();
  harness.canvasKit.encodedResult = null;
  const encodedGif = base64(gif(2, 1));

  assert.equal(harness.cache.image(undefined, encodedGif), null);
  assert.equal(harness.canvasKit.encodedSources.length, 1);
  assert.equal(harness.browser.images.length, 0);
  assert.equal(harness.cache.getImageDiagnostics().pendingLoads, 0);
  assert.deepEqual(harness.cache.getImageDiagnostics().failures, [{
    source: 'inline',
    resourceId: null,
    reason: 'imageDecodeFailed',
  }]);
});

test('rejects and negative-caches decoded raster dimension mismatches', () => {
  const harness = makeHarness();
  const mismatchedImage = fakeCanvasKitImage(8, 8);
  harness.canvasKit.encodedResult = mismatchedImage;
  const encodedPng = base64(png(16, 12));

  assert.equal(harness.cache.image(undefined, encodedPng), null);
  assert.equal(harness.cache.image(undefined, encodedPng), null);
  assert.equal(mismatchedImage.deleteCalls, 1);
  assert.equal(harness.canvasKit.encodedSources.length, 1);
  assert.equal(harness.cache.getImageDiagnostics().failureCacheHits, 1);
  assert.deepEqual(harness.cache.getImageDiagnostics().failures, [{
    source: 'inline',
    resourceId: null,
    reason: 'decodedDimensionsMismatch',
  }]);
});

test('loads SVG asynchronously into a direct CanvasKit image and notifies once', async () => {
  const harness = makeHarness();
  const decodedImage = fakeCanvasKitImage(24, 18);
  harness.canvasKit.canvasResult = decodedImage;
  let readyCallbacks = 0;
  harness.cache.setAsyncResourceReadyCallback(() => {
    readyCallbacks += 1;
  });
  const encodedSvg = base64(svg(24, 18));

  assert.equal(harness.cache.image(undefined, encodedSvg), null);
  assert.equal(harness.cache.image(undefined, encodedSvg), null);
  assert.equal(harness.browser.images.length, 1);
  assert.equal(harness.browser.blobs[0].type, 'image/svg+xml');
  assert.deepEqual(harness.cache.getImageDiagnostics(), {
    cacheHits: 0,
    cacheMisses: 2,
    failureCacheHits: 0,
    failureAttempts: 0,
    pendingAccesses: 2,
    pendingLoads: 1,
    imagesDecoded: 0,
    recoveries: [],
    failures: [],
  });

  const browserImage = harness.browser.images[0];
  const complete = browserImage.onload;
  assert.equal(typeof complete, 'function');
  complete();
  await Promise.resolve();

  assert.equal(harness.canvasKit.encodedSources.length, 0);
  assert.deepEqual(harness.canvasKit.canvasSources, [browserImage]);
  assert.deepEqual(harness.browser.revokedUrls, ['blob:test-1']);
  assert.equal(browserImage.onload, null);
  assert.equal(browserImage.onerror, null);
  assert.equal(browserImage.src, '');
  assert.equal(readyCallbacks, 1);
  assert.equal(harness.cache.image(undefined, encodedSvg), decodedImage);
  assert.equal(harness.cache.getImageDiagnostics().pendingLoads, 0);
});

test('rejects browser-decoded SVG dimension mismatches', async () => {
  const harness = makeHarness();
  const mismatchedImage = fakeCanvasKitImage(12, 12);
  harness.canvasKit.canvasResult = mismatchedImage;
  const encodedSvg = base64(svg(24, 18));

  assert.equal(harness.cache.image(undefined, encodedSvg), null);
  harness.browser.images[0].onload();
  await Promise.resolve();

  assert.equal(mismatchedImage.deleteCalls, 1);
  assert.equal(harness.cache.image(undefined, encodedSvg), null);
  assert.equal(harness.browser.images.length, 1);
  assert.deepEqual(harness.cache.getImageDiagnostics().failures, [{
    source: 'inline',
    resourceId: null,
    reason: 'decodedDimensionsMismatch',
  }]);
});

test('negative-caches SVG decode failures and reports a deterministic reason', async () => {
  const harness = makeHarness();
  let readyCallbacks = 0;
  harness.cache.setAsyncResourceReadyCallback(() => {
    readyCallbacks += 1;
  });
  const encodedSvg = base64(svg(30, 20));

  assert.equal(harness.cache.image(undefined, encodedSvg), null);
  const fail = harness.browser.images[0].onerror;
  assert.equal(typeof fail, 'function');
  fail();
  await Promise.resolve();

  assert.equal(readyCallbacks, 1);
  assert.equal(harness.cache.image(undefined, encodedSvg), null);
  assert.equal(harness.browser.images.length, 1);
  assert.equal(harness.canvasKit.canvasSources.length, 0);
  assert.deepEqual(harness.cache.getImageDiagnostics().failures, [{
    source: 'inline',
    resourceId: null,
    reason: 'imageDecodeFailed',
  }]);
  assert.equal(harness.cache.getImageDiagnostics().failureCacheHits, 1);
  assert.equal(harness.cache.getImageDiagnostics().pendingLoads, 0);
});

test('negative-caches CanvasKit image creation failures after browser decode', async () => {
  const harness = makeHarness();
  harness.canvasKit.MakeImageFromCanvasImageSource = function failCanvasImageCreation(image) {
    this.canvasSources.push(image);
    throw new Error('CanvasKit image creation failed');
  };
  const encodedSvg = base64(svg(22, 14));

  assert.equal(harness.cache.image(undefined, encodedSvg), null);
  harness.browser.images[0].onload();
  await Promise.resolve();

  assert.equal(harness.canvasKit.canvasSources.length, 1);
  assert.equal(harness.cache.getImageDiagnostics().failureAttempts, 1);
  assert.equal(harness.cache.getImageDiagnostics().pendingLoads, 0);
  assert.deepEqual(harness.cache.getImageDiagnostics().failures, [{
    source: 'inline',
    resourceId: null,
    reason: 'imageDecodeFailed',
  }]);
  assert.equal(harness.cache.image(undefined, encodedSvg), null);
  assert.equal(harness.browser.images.length, 1);
});

test('contains synchronous browser source-assignment failures', async () => {
  const harness = makeHarness();
  let readyCallbacks = 0;
  harness.cache.setAsyncResourceReadyCallback(() => {
    readyCallbacks += 1;
  });
  harness.browser.createImage = function createFailingImage() {
    let source = '';
    const image = {
      width: 1,
      height: 1,
      onload: null,
      onerror: null,
      get src() {
        return source;
      },
      set src(value) {
        if (value) {
          throw new Error('source assignment failed');
        }
        source = value;
      },
    };
    this.images.push(image);
    return image;
  };
  const encodedSvg = base64(svg(12, 10));

  assert.equal(harness.cache.image(undefined, encodedSvg), null);
  await Promise.resolve();

  assert.equal(readyCallbacks, 1);
  assert.equal(harness.cache.getImageDiagnostics().failureAttempts, 1);
  assert.equal(harness.cache.getImageDiagnostics().pendingLoads, 0);
  assert.deepEqual(harness.browser.revokedUrls, ['blob:test-1']);
  assert.equal(harness.cache.image(undefined, encodedSvg), null);
  assert.equal(harness.browser.images.length, 1);
});

test('cancels pending SVG work and deletes decoded images across resource lifetimes', async () => {
  const harness = makeHarness();
  const firstSvg = svg(32, 20);
  harness.cache.setResources(resources(1, firstSvg, 'first'));
  assert.equal(harness.cache.image(0), null);
  const staleBrowserImage = harness.browser.images[0];
  const staleComplete = staleBrowserImage.onload;

  harness.cache.setResources(resources(1, firstSvg, 'first'));
  assert.equal(staleBrowserImage.onload, staleComplete);
  harness.cache.setResources(resources(1, firstSvg, 'second'));

  assert.equal(staleBrowserImage.onload, null);
  assert.equal(staleBrowserImage.onerror, null);
  assert.equal(staleBrowserImage.src, '');
  assert.deepEqual(harness.browser.revokedUrls, ['blob:test-1']);
  staleComplete();
  await Promise.resolve();
  assert.equal(harness.canvasKit.canvasSources.length, 0);

  const decodedImage = fakeCanvasKitImage(32, 20);
  harness.canvasKit.canvasResult = decodedImage;
  assert.equal(harness.cache.image(0), null);
  harness.browser.images[1].onload();
  await Promise.resolve();
  assert.equal(harness.cache.image(0), decodedImage);

  harness.cache.setResources(resources(1, firstSvg, 'third'));
  assert.equal(decodedImage.deleteCalls, 1);

  assert.equal(harness.cache.image(0), null);
  const disposePendingImage = harness.browser.images[2];
  harness.cache.dispose();
  assert.equal(disposePendingImage.onload, null);
  assert.equal(disposePendingImage.onerror, null);
  assert.equal(disposePendingImage.src, '');
  assert.deepEqual(harness.browser.revokedUrls, [
    'blob:test-1',
    'blob:test-2',
    'blob:test-3',
  ]);
});

test('resets document image state without disposing the reusable cache', async () => {
  const harness = makeHarness();
  const decodedRaster = fakeCanvasKitImage(10, 8);
  harness.canvasKit.encodedResult = decodedRaster;
  assert.equal(harness.cache.image(undefined, base64(png(10, 8))), decodedRaster);

  const encodedSvg = base64(svg(18, 12));
  assert.equal(harness.cache.image(undefined, encodedSvg), null);
  const pendingImage = harness.browser.images[0];
  const staleComplete = pendingImage.onload;

  harness.cache.resetDocumentResources();

  assert.equal(decodedRaster.deleteCalls, 1);
  assert.equal(harness.cache.imageCache.size, 0);
  assert.equal(harness.cache.mipmappedImageCache.size, 0);
  assert.equal(harness.cache.imageEffectCache.size, 0);
  assert.equal(harness.cache.failedImageCacheKeys.size, 0);
  assert.equal(pendingImage.onload, null);
  assert.equal(pendingImage.onerror, null);
  assert.equal(pendingImage.src, '');
  staleComplete();
  await Promise.resolve();
  assert.equal(harness.canvasKit.canvasSources.length, 0);

  const nextRaster = fakeCanvasKitImage(12, 9);
  harness.canvasKit.encodedResult = nextRaster;
  assert.equal(harness.cache.image(undefined, base64(png(12, 9))), nextRaster);
});

test('retries a replaced resource after a negative cache entry in the same table', () => {
  const harness = makeHarness();
  harness.cache.setResources(resources(7, Uint8Array.of(1, 2, 3), 'invalid'));

  assert.equal(harness.cache.image(0), null);
  assert.equal(harness.cache.failedImageCacheKeys.size, 1);

  const replacementImage = fakeCanvasKitImage(6, 4);
  harness.canvasKit.encodedResult = replacementImage;
  harness.cache.setResources(resources(7, png(6, 4), 'replacement'));

  assert.equal(harness.cache.failedImageCacheKeys.size, 0);
  assert.equal(harness.cache.image(0), replacementImage);
  assert.equal(harness.canvasKit.encodedSources.length, 1);
});

test('renderer forwards readiness and excludes pending SVGs from static pictures', () => {
  const rendererSource = fs.readFileSync(
    path.join(studioRoot, 'src/view/canvaskit-renderer.ts'),
    'utf8',
  );
  assert.match(
    rendererSource,
    /setAsyncResourceReadyCallback\(callback:[\s\S]*this\.resourceCache\.setAsyncResourceReadyCallback\(callback\)/,
  );
  assert.match(
    rendererSource,
    /pendingImageAccessesBefore[\s\S]*hasPendingImageReplay[\s\S]*!hasPendingImageReplay[\s\S]*staticPictureCache\.set/,
  );
  assert.match(
    rendererSource,
    /else if \(hasPendingImageReplay\)[\s\S]*picture\.delete\(\)/,
  );
});

function makeHarness() {
  const browser = {
    blobs: [],
    images: [],
    revokedUrls: [],
    createImage() {
      const image = {
        width: 1,
        height: 1,
        onload: null,
        onerror: null,
        src: '',
      };
      this.images.push(image);
      return image;
    },
    createObjectUrl(blob) {
      this.blobs.push(blob);
      return `blob:test-${this.blobs.length}`;
    },
    revokeObjectUrl(url) {
      this.revokedUrls.push(url);
    },
  };
  const canvasKit = {
    encodedResult: fakeCanvasKitImage(),
    canvasResult: fakeCanvasKitImage(),
    encodedSources: [],
    canvasSources: [],
    MakeImageFromEncoded(bytes) {
      this.encodedSources.push(bytes);
      return this.encodedResult;
    },
    MakeImageFromCanvasImageSource(image) {
      this.canvasSources.push(image);
      return this.canvasResult;
    },
  };
  return {
    browser,
    canvasKit,
    cache: new CanvasKitResourceCache(canvasKit, browser),
  };
}

function fakeCanvasKitImage(width = 1, height = 1) {
  return {
    deleteCalls: 0,
    width() {
      return width;
    },
    height() {
      return height;
    },
    delete() {
      this.deleteCalls += 1;
    },
    makeCopyWithDefaultMipmaps() {
      return fakeCanvasKitImage(width, height);
    },
  };
}

function resources(tableId, bytes, hash) {
  return {
    tableId,
    images: [bytes],
    imageHashes: [hash],
  };
}

function svg(width, height) {
  return new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
      + '<rect width="100%" height="100%" fill="#123456"/>'
      + '</svg>',
  );
}

function png(width, height) {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  return bytes;
}

function gif(width, height) {
  const bytes = new Uint8Array(13);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
}

function base64(bytes) {
  return Buffer.from(bytes).toString('base64');
}
