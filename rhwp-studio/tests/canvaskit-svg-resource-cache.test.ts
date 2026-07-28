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
  const rasterImage = fakeCanvasKitImage();
  harness.canvasKit.encodedResult = rasterImage;

  const result = harness.cache.image(undefined, base64(png(16, 12)));

  assert.equal(result, rasterImage);
  assert.equal(harness.canvasKit.encodedSources.length, 1);
  assert.equal(harness.canvasKit.canvasSources.length, 0);
  assert.equal(harness.browser.images.length, 0);
  assert.equal(harness.cache.getImageDiagnostics().pendingLoads, 0);
});

test('loads SVG asynchronously into a direct CanvasKit image and notifies once', async () => {
  const harness = makeHarness();
  const decodedImage = fakeCanvasKitImage();
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

  const decodedImage = fakeCanvasKitImage();
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
  const decodedRaster = fakeCanvasKitImage();
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

  const nextRaster = fakeCanvasKitImage();
  harness.canvasKit.encodedResult = nextRaster;
  assert.equal(harness.cache.image(undefined, base64(png(12, 9))), nextRaster);
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

function fakeCanvasKitImage() {
  return {
    deleteCalls: 0,
    delete() {
      this.deleteCalls += 1;
    },
    makeCopyWithDefaultMipmaps() {
      return fakeCanvasKitImage();
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

function base64(bytes) {
  return Buffer.from(bytes).toString('base64');
}
