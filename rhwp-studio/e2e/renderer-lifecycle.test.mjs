import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assert,
  comparePngBuffers,
  loadApp,
  loadHwpFile,
  runTest,
  setTestCase,
} from './helpers.mjs';
import { classifyCanvasKitPageRuntimeConditions } from './runtime-condition-alignment.mjs';
import { PNG } from 'pngjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RHWP_ROOT = path.resolve(__dirname, '..', '..');
const PATTERN_REFERENCE_FIXTURE = loadPatternReferenceFixture();
const ORDERED_DITHER_8X8 = [
  0, 48, 12, 60, 3, 51, 15, 63,
  32, 16, 44, 28, 35, 19, 47, 31,
  8, 56, 4, 52, 11, 59, 7, 55,
  40, 24, 36, 20, 43, 27, 39, 23,
  2, 50, 14, 62, 1, 49, 13, 61,
  34, 18, 46, 30, 33, 17, 45, 29,
  10, 58, 6, 54, 9, 57, 5, 53,
  42, 26, 38, 22, 41, 25, 37, 21,
];

function pngBufferFromDataUrl(dataUrl) {
  return Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
}

function loadPatternReferenceFixture() {
  const raw = fs.readFileSync(
    path.join(RHWP_ROOT, 'tests', 'fixtures', 'image_effect_pattern8x8_luma126.txt'),
    'utf8',
  );
  const rows = [];
  let luma = null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith('#')) {
      const match = trimmed.match(/luma=(\d+)/);
      if (match) {
        luma = Number.parseInt(match[1], 10);
      }
      continue;
    }
    rows.push(trimmed.split(/\s+/).map((value) => Number.parseInt(value, 10)));
  }
  if (!Number.isInteger(luma) || rows.length !== 8 || rows.some((row) => row.length !== 8)) {
    throw new Error('invalid Pattern8x8 reference fixture');
  }
  return { luma, rows };
}

function expectedPattern8x8Value(luma, x, y) {
  const matrix = ORDERED_DITHER_8X8[(y & 7) * 8 + (x & 7)];
  const threshold = Math.floor(((matrix * 2 + 1) * 255) / 128);
  return luma > threshold ? 255 : 0;
}

function countPatternReferenceMismatches(dataUrl, reference, phaseX = 0, phaseY = 0) {
  const png = PNG.sync.read(pngBufferFromDataUrl(dataUrl));
  let mismatches = 0;
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const expected = phaseX === 0 && phaseY === 0
        ? reference.rows[y]?.[x] ?? expectedPattern8x8Value(reference.luma, x, y)
        : expectedPattern8x8Value(reference.luma, x + phaseX, y + phaseY);
      const offset = (y * png.width + x) * 4;
      if (
        png.data[offset] !== expected
        || png.data[offset + 1] !== expected
        || png.data[offset + 2] !== expected
        || png.data[offset + 3] !== 255
      ) {
        mismatches += 1;
      }
    }
  }
  return mismatches;
}

function pixelAt(dataUrl, x, y) {
  const png = PNG.sync.read(pngBufferFromDataUrl(dataUrl));
  const offset = (y * png.width + x) * 4;
  return {
    red: png.data[offset],
    green: png.data[offset + 1],
    blue: png.data[offset + 2],
    alpha: png.data[offset + 3],
  };
}

function isOpaqueRed(pixel) {
  return pixel.red > 220 && pixel.green < 40 && pixel.blue < 40 && pixel.alpha > 220;
}

function countPixels(dataUrl, predicate) {
  const png = PNG.sync.read(pngBufferFromDataUrl(dataUrl));
  let count = 0;
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const offset = (y * png.width + x) * 4;
      if (predicate({
        x,
        y,
        red: png.data[offset],
        green: png.data[offset + 1],
        blue: png.data[offset + 2],
        alpha: png.data[offset + 3],
      })) {
        count += 1;
      }
    }
  }
  return count;
}

function isTransparent(pixel) {
  return pixel.alpha < 8;
}

runTest('Renderer lifecycle', async ({ page }) => {
  setTestCase('page-layer-cache-eviction');
  await loadApp(page, '?renderer=canvas2d');
  const layerCacheProbe = await page.evaluate(() => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    if (!pageRenderer?.wasm || typeof pageRenderer.renderPage !== 'function') {
      return { error: 'page renderer unavailable' };
    }

    const originalGetPageLayerTree = pageRenderer.wasm.getPageLayerTree.bind(pageRenderer.wasm);
    const limit = pageRenderer.layerTreeCacheLimit ?? 12;
    let loads = 0;
    pageRenderer.wasm.getPageLayerTree = (pageIdx, profile = 'screen') => {
      loads += 1;
      return {
        pageWidth: 100,
        pageHeight: 100,
        profile,
        resources: { tableId: 1, images: [], svgFragments: [] },
        root: {
          kind: 'leaf',
          sourceNodeId: pageIdx,
          bounds: { x: 0, y: 0, width: 100, height: 100 },
          cacheHint: 'none',
          ops: [],
        },
      };
    };

    const canvas = document.createElement('canvas');
    const pageInfo = {
      pageIndex: 0,
      width: 100,
      height: 100,
      sectionIndex: 0,
      marginLeft: 10,
      marginRight: 10,
      marginTop: 10,
      marginBottom: 10,
      marginHeader: 0,
      marginFooter: 0,
    };

    try {
      pageRenderer.clearLayerTreeCache();
      for (let pageIdx = 0; pageIdx < limit + 5; pageIdx += 1) {
        pageRenderer.renderPage(pageIdx, { ...pageInfo, pageIndex: pageIdx }, canvas, 1);
        pageRenderer.cancelReRender(pageIdx);
      }
      const keys = Array.from(pageRenderer.layerTreeCache?.keys?.() ?? []);
      return {
        limit,
        loads,
        cacheSize: pageRenderer.layerTreeCache?.size ?? -1,
        keys,
        oldestPageRetained: keys.includes(0),
        newestPageRetained: keys.includes(limit + 4),
      };
    } finally {
      pageRenderer.cancelAll?.();
      pageRenderer.clearLayerTreeCache?.();
      pageRenderer.wasm.getPageLayerTree = originalGetPageLayerTree;
    }
  });

  assert(!layerCacheProbe.error, layerCacheProbe.error || 'page layer cache probe available');
  assert(
    layerCacheProbe.cacheSize <= layerCacheProbe.limit,
    `page layer cache bounded size=${layerCacheProbe.cacheSize}, limit=${layerCacheProbe.limit}`,
  );
  assert(
    !layerCacheProbe.oldestPageRetained && layerCacheProbe.newestPageRetained,
    `page layer cache LRU keys=${JSON.stringify(layerCacheProbe.keys)}`,
  );
  assert(
    layerCacheProbe.loads === layerCacheProbe.limit + 5,
    `page layer cache load count=${layerCacheProbe.loads}`,
  );

  setTestCase('active-page-position-recalculation');
  const pagePositionProbe = await page.evaluate(() => {
    const canvasView = window.__canvasView;
    if (!canvasView?.canvasPool || !canvasView?.virtualScroll) {
      return { error: 'canvas view unavailable' };
    }

    const pageIdx = 0;
    canvasView.pages = [{
      pageIndex: pageIdx,
      width: 100,
      height: 120,
      sectionIndex: 0,
      marginLeft: 0,
      marginRight: 0,
      marginTop: 0,
      marginBottom: 0,
      marginHeader: 0,
      marginFooter: 0,
    }];
    const canvas = canvasView.canvasPool.acquire(pageIdx);
    try {
      canvas.style.top = '12345px';
      canvas.style.left = '12345px';
      canvas.style.transform = 'rotate(1deg)';
      canvasView.recalcLayout();

      const pageLeft = canvasView.virtualScroll.getPageLeft(pageIdx);
      return {
        pageIdx,
        actualTop: canvas.style.top,
        expectedTop: `${canvasView.virtualScroll.getPageOffset(pageIdx)}px`,
        actualLeft: canvas.style.left,
        expectedLeft: pageLeft >= 0 ? `${pageLeft}px` : '50%',
        actualTransform: canvas.style.transform,
        expectedTransform: pageLeft >= 0 ? 'none' : 'translateX(-50%)',
      };
    } finally {
      canvasView.canvasPool.release(pageIdx);
    }
  });
  assert(
    !pagePositionProbe.error,
    pagePositionProbe.error || 'active page canvas available',
  );
  assert(
    pagePositionProbe.actualTop === pagePositionProbe.expectedTop
      && pagePositionProbe.actualLeft === pagePositionProbe.expectedLeft
      && pagePositionProbe.actualTransform === pagePositionProbe.expectedTransform,
    `layout recalculation repositions active page=${JSON.stringify(pagePositionProbe)}`,
  );

  setTestCase('skia-renderer-alias');
  await loadApp(page, '?renderer=skia&canvaskitMode=default&canvaskitSurface=software');
  const skiaAliasProbe = await page.evaluate(() => ({
    backend: window.__renderBackend,
    hasCanvasKitRenderer: !!window.__canvasView?.pageRenderer?.canvaskitRenderer,
    surfacePreference: window.__canvaskitSurfacePreference,
  }));
  assert(
    skiaAliasProbe.backend === 'canvaskit' && skiaAliasProbe.hasCanvasKitRenderer,
    `renderer=skia resolves to CanvasKit backend=${JSON.stringify(skiaAliasProbe)}`,
  );
  assert(
    skiaAliasProbe.surfacePreference === 'software',
    `renderer=skia keeps CanvasKit surface options=${JSON.stringify(skiaAliasProbe)}`,
  );

  setTestCase('skia-storage-alias');
  await page.evaluate(() => window.localStorage.setItem('rhwp-render-backend', 'skia'));
  await loadApp(page, '?canvaskitMode=default&canvaskitSurface=software');
  const skiaStorageAliasProbe = await page.evaluate(() => ({
    backend: window.__renderBackend,
    storedBackend: window.localStorage.getItem('rhwp-render-backend'),
    hasCanvasKitRenderer: !!window.__canvasView?.pageRenderer?.canvaskitRenderer,
  }));
  assert(
    skiaStorageAliasProbe.backend === 'canvaskit'
      && skiaStorageAliasProbe.storedBackend === 'canvaskit'
      && skiaStorageAliasProbe.hasCanvasKitRenderer,
    `stored skia alias resolves and normalizes to CanvasKit=${JSON.stringify(skiaStorageAliasProbe)}`,
  );

  setTestCase('canvaskit-renderer-does-not-use-canvas2d-overlay');
  await loadApp(page, '?renderer=canvaskit&canvaskitMode=default&canvaskitSurface=software');
  const noCanvas2DOverlayProbe = await page.evaluate(() => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    if (!pageRenderer?.canvas2dRenderer || !pageRenderer?.canvaskitRenderer) {
      return { error: 'page renderer internals unavailable' };
    }

    const originalCanvas2DRenderPage = pageRenderer.canvas2dRenderer.renderPage.bind(
      pageRenderer.canvas2dRenderer,
    );
    const originalCanvasKitRenderPageWithMarginGuides = pageRenderer.canvaskitRenderer.renderPageWithMarginGuides.bind(
      pageRenderer.canvaskitRenderer,
    );
    const originalGetPageLayerTree = pageRenderer.wasm.getPageLayerTree.bind(pageRenderer.wasm);
    let canvas2DCalls = 0;
    let canvasKitCalls = 0;
    let canvasKitPageInfoForwarded = false;
    pageRenderer.canvas2dRenderer.renderPage = () => {
      canvas2DCalls += 1;
      throw new Error('Canvas2D overlay renderPage should not be called for CanvasKit backend');
    };
    pageRenderer.canvaskitRenderer.renderPageWithMarginGuides = (layerTree, canvas, scale, pageInfo) => {
      canvasKitCalls += 1;
      canvasKitPageInfoForwarded = pageInfo?.width === 96 && pageInfo?.height === 64;
      originalCanvasKitRenderPageWithMarginGuides(layerTree, canvas, scale, pageInfo);
    };
    pageRenderer.wasm.getPageLayerTree = (pageIdx, profile = 'screen') => ({
      pageWidth: 96,
      pageHeight: 64,
      profile,
      resources: { tableId: 2, images: [], svgFragments: [] },
      root: {
        kind: 'leaf',
        sourceNodeId: pageIdx,
        bounds: { x: 0, y: 0, width: 96, height: 64 },
        cacheHint: 'none',
        ops: [],
      },
    });

    const canvas = document.createElement('canvas');
    const pageInfo = {
      pageIndex: 0,
      width: 96,
      height: 64,
      sectionIndex: 0,
      marginLeft: 8,
      marginRight: 8,
      marginTop: 8,
      marginBottom: 8,
      marginHeader: 0,
      marginFooter: 0,
    };

    try {
      pageRenderer.clearLayerTreeCache?.();
      pageRenderer.renderPage(0, pageInfo, canvas, 1);
      return {
        backend: pageRenderer.getBackend?.(),
        canvas2DCalls,
        canvasKitCalls,
        canvasKitPageInfoForwarded,
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        backend: pageRenderer.getBackend?.(),
        canvas2DCalls,
        canvasKitCalls,
        canvasKitPageInfoForwarded,
      };
    } finally {
      pageRenderer.cancelAll?.();
      pageRenderer.clearLayerTreeCache?.();
      pageRenderer.canvas2dRenderer.renderPage = originalCanvas2DRenderPage;
      pageRenderer.canvaskitRenderer.renderPageWithMarginGuides = originalCanvasKitRenderPageWithMarginGuides;
      pageRenderer.wasm.getPageLayerTree = originalGetPageLayerTree;
    }
  });
  assert(
    !noCanvas2DOverlayProbe.error,
    noCanvas2DOverlayProbe.error || 'CanvasKit no Canvas2D overlay probe available',
  );
  assert(
    noCanvas2DOverlayProbe.backend === 'canvaskit'
      && noCanvas2DOverlayProbe.canvasKitCalls === 1
      && noCanvas2DOverlayProbe.canvasKitPageInfoForwarded === true
      && noCanvas2DOverlayProbe.canvas2DCalls === 0,
    `CanvasKit render dispatch avoids Canvas2D overlay=${JSON.stringify(noCanvas2DOverlayProbe)}`,
  );

  setTestCase('canvas-replay-plane-order-parity');
  const replayPlaneOrderProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }

    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = 4;
    sourceCanvas.height = 4;
    const sourceContext = sourceCanvas.getContext('2d');
    if (!sourceContext) {
      return { error: 'image fixture canvas unavailable' };
    }
    sourceContext.fillStyle = '#0000ff';
    sourceContext.fillRect(0, 0, 4, 4);
    const base64 = sourceCanvas.toDataURL('image/png').split(',')[1];
    const bounds = { x: 0, y: 0, width: 24, height: 24 };
    const imageOp = (wrap) => ({
      type: 'image',
      bbox: bounds,
      base64,
      wrap,
      fillMode: 'fitToSize',
      effect: 'realPic',
      originalSize: { width: 4, height: 4 },
      transform: { rotation: 0, horzFlip: false, vertFlip: false },
    });
    const rectangleOp = {
      type: 'rectangle',
      bbox: bounds,
      cornerRadius: 0,
      style: {
        fillColor: '#ff0000',
        strokeColor: null,
        strokeWidth: 0,
        strokeDash: 'solid',
        opacity: 1,
      },
      transform: { rotation: 0, horzFlip: false, vertFlip: false },
    };
    const makeTree = (ops, tableId) => ({
      pageWidth: 24,
      pageHeight: 24,
      profile: 'screen',
      resources: {
        tableId,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
      },
      root: {
        kind: 'leaf',
        sourceNodeId: tableId,
        bounds,
        cacheHint: 'none',
        ops,
      },
    });
    const nextFrame = () => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    const isColor = (pixel, expected) => expected === 'blue'
      ? pixel[2] > 220 && pixel[0] < 40 && pixel[1] < 40 && pixel[3] > 220
      : pixel[0] > 220 && pixel[1] < 40 && pixel[2] < 40 && pixel[3] > 220;
    const renderCenter = async (renderer, tree, expected) => {
      const canvas = document.createElement('canvas');
      canvas.width = 24;
      canvas.height = 24;
      document.body.appendChild(canvas);
      const context = canvas.getContext('2d');
      if (!context) {
        canvas.remove();
        return null;
      }
      let pixel = [0, 0, 0, 0];
      for (let attempt = 0; attempt < 10; attempt += 1) {
        renderer.renderPage(tree, canvas, 1);
        await nextFrame();
        pixel = Array.from(context.getImageData(12, 12, 1, 1).data);
        if (isColor(pixel, expected)) {
          break;
        }
      }
      canvas.remove();
      return pixel;
    };
    const cases = [
      {
        name: 'behind-image-first',
        expected: 'red',
        tree: makeTree([imageOp('behindText'), rectangleOp], 2101),
      },
      {
        name: 'behind-image-last',
        expected: 'red',
        tree: makeTree([rectangleOp, imageOp('behindText')], 2102),
      },
      {
        name: 'front-image-first',
        expected: 'blue',
        tree: makeTree([imageOp('inFrontOfText'), rectangleOp], 2103),
      },
      {
        name: 'front-image-last',
        expected: 'blue',
        tree: makeTree([rectangleOp, imageOp('inFrontOfText')], 2104),
      },
    ];
    const warmTree = makeTree([imageOp('topAndBottom')], 2100);
    const result = {
      warm: {
        canvas2d: await renderCenter(canvas2dRenderer, warmTree, 'blue'),
        canvaskit: await renderCenter(canvaskitRenderer, warmTree, 'blue'),
      },
      cases: [],
    };
    for (const testCase of cases) {
      result.cases.push({
        name: testCase.name,
        expected: testCase.expected,
        canvas2d: await renderCenter(canvas2dRenderer, testCase.tree, testCase.expected),
        canvaskit: await renderCenter(canvaskitRenderer, testCase.tree, testCase.expected),
      });
    }
    return result;
  });
  assert(
    !replayPlaneOrderProbe.error,
    replayPlaneOrderProbe.error || 'canvas replay-plane order probe available',
  );
  const replayPlaneColorMatches = (pixel, expected) => expected === 'blue'
    ? pixel?.[2] > 220 && pixel?.[0] < 40 && pixel?.[1] < 40 && pixel?.[3] > 220
    : pixel?.[0] > 220 && pixel?.[1] < 40 && pixel?.[2] < 40 && pixel?.[3] > 220;
  assert(
    replayPlaneColorMatches(replayPlaneOrderProbe.warm.canvas2d, 'blue')
      && replayPlaneColorMatches(replayPlaneOrderProbe.warm.canvaskit, 'blue'),
    `canvas replay-plane image fixture warmed=${JSON.stringify(replayPlaneOrderProbe.warm)}`,
  );
  for (const result of replayPlaneOrderProbe.cases) {
    assert(
      replayPlaneColorMatches(result.canvas2d, result.expected)
        && replayPlaneColorMatches(result.canvaskit, result.expected),
      `canvas replay-plane order ${result.name}=${JSON.stringify(result)}`,
    );
  }

  setTestCase('canvaskit-margin-guide-gpu-fallback-rerenders-content');
  await loadApp(page, '?renderer=canvaskit&canvaskitMode=default&canvaskitSurface=software');
  const marginGuideFallbackProbe = await page.evaluate(() => {
    const renderer = window.__canvasView?.pageRenderer?.canvaskitRenderer;
    if (!renderer?.surfaceCache) {
      return { error: 'CanvasKit renderer internals unavailable' };
    }

    const originalSurfaceGet = renderer.surfaceCache.get.bind(renderer.surfaceCache);
    const originalReplaceWithSoftware = renderer.surfaceCache.replaceWithSoftware.bind(renderer.surfaceCache);
    const originalRenderSurface = renderer.renderSurface.bind(renderer);
    const originalDrawMarginGuidesOnSurface = renderer.drawMarginGuidesOnSurface.bind(renderer);
    const originalLastRenderedTree = renderer.lastRenderedTree;
    const originalLastScale = renderer.lastScale;

    const fakeTree = {
      pageWidth: 96,
      pageHeight: 64,
      profile: 'screen',
      resources: { tableId: 3, images: [], svgFragments: [] },
      root: {
        kind: 'leaf',
        sourceNodeId: 0,
        bounds: { x: 0, y: 0, width: 96, height: 64 },
        cacheHint: 'none',
        ops: [{
          type: 'rectangle',
          bbox: { x: 4, y: 4, width: 16, height: 16 },
          fill: '#3366ff',
          stroke: null,
          shadow: null,
          transform: null,
        }],
      },
    };
    const gpuSurface = { label: 'gpu' };
    const softwareSurface = { label: 'software' };
    const renderCalls = [];
    const drawCalls = [];
    let replaceCalls = 0;
    renderer.lastRenderedTree = fakeTree;
    renderer.lastScale = 1.25;
    renderer.surfaceCache.get = () => ({
      surface: gpuSurface,
      usedGpuSurface: true,
      backend: 'webgl',
    });
    renderer.surfaceCache.replaceWithSoftware = () => {
      replaceCalls += 1;
      return softwareSurface;
    };
    renderer.renderSurface = (surface, tree, scale) => {
      renderCalls.push({
        surface: surface?.label ?? 'unknown',
        treeMatches: tree === fakeTree,
        scale,
      });
    };
    renderer.drawMarginGuidesOnSurface = (surface, _pageInfo, scale) => {
      drawCalls.push({
        surface: surface?.label ?? 'unknown',
        scale,
      });
      if (surface === gpuSurface) {
        throw new Error('forced GPU margin guide failure');
      }
    };

    const canvas = document.createElement('canvas');
    const pageInfo = {
      pageIndex: 0,
      width: 96,
      height: 64,
      sectionIndex: 0,
      marginLeft: 8,
      marginRight: 8,
      marginTop: 8,
      marginBottom: 8,
      marginHeader: 0,
      marginFooter: 0,
    };
    try {
      renderer.drawMarginGuides(pageInfo, canvas, 1.25);
      return { replaceCalls, renderCalls, drawCalls };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        replaceCalls,
        renderCalls,
        drawCalls,
      };
    } finally {
      renderer.surfaceCache.get = originalSurfaceGet;
      renderer.surfaceCache.replaceWithSoftware = originalReplaceWithSoftware;
      renderer.renderSurface = originalRenderSurface;
      renderer.drawMarginGuidesOnSurface = originalDrawMarginGuidesOnSurface;
      renderer.lastRenderedTree = originalLastRenderedTree;
      renderer.lastScale = originalLastScale;
    }
  });
  assert(
    !marginGuideFallbackProbe.error,
    marginGuideFallbackProbe.error || 'CanvasKit margin guide fallback probe available',
  );
  assert(
    marginGuideFallbackProbe.replaceCalls === 1
      && marginGuideFallbackProbe.renderCalls.length === 1
      && marginGuideFallbackProbe.renderCalls[0].surface === 'software'
      && marginGuideFallbackProbe.renderCalls[0].treeMatches === true
      && marginGuideFallbackProbe.renderCalls[0].scale === 1.25
      && marginGuideFallbackProbe.drawCalls.map((call) => call.surface).join(',') === 'gpu,software',
    `CanvasKit margin guide fallback rerenders content before drawing guides=${JSON.stringify(marginGuideFallbackProbe)}`,
  );

  setTestCase('async-resource-rerender');
  await loadApp(page, '?renderer=canvas2d');
  const asyncRerenderProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const renderer = pageRenderer?.canvas2dRenderer;
    if (!pageRenderer?.wasm || !renderer || typeof pageRenderer.renderPage !== 'function') {
      return { error: 'page renderer unavailable' };
    }

    const originalGetPageLayerTree = pageRenderer.wasm.getPageLayerTree.bind(pageRenderer.wasm);
    pageRenderer.wasm.getPageLayerTree = (pageIdx, profile = 'screen') => ({
      pageWidth: 100,
      pageHeight: 100,
      profile,
      resources: { tableId: 3, images: [], svgFragments: [] },
      root: {
        kind: 'leaf',
        sourceNodeId: pageIdx,
        bounds: { x: 0, y: 0, width: 100, height: 100 },
        cacheHint: 'none',
        ops: [],
      },
    });

    const originalRenderPage = renderer.renderPage.bind(renderer);
    let renderCalls = 0;
    renderer.renderPage = (...args) => {
      renderCalls += 1;
      return originalRenderPage(...args);
    };

    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const pageInfo = {
      pageIndex: 0,
      width: 100,
      height: 100,
      sectionIndex: 0,
      marginLeft: 10,
      marginRight: 10,
      marginTop: 10,
      marginBottom: 10,
      marginHeader: 0,
      marginFooter: 0,
    };

    try {
      pageRenderer.clearLayerTreeCache();
      pageRenderer.renderPage(0, pageInfo, canvas, 1);
      const callsAfterInitial = renderCalls;
      const hasTimerQueue = Object.prototype.hasOwnProperty.call(pageRenderer, 'reRenderTimers');
      renderer.asyncResourceReadyCallback?.();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {
        hasTimerQueue,
        activeRenderStates: pageRenderer.activeRenderStates?.size ?? -1,
        callsAfterInitial,
        callsAfterAsync: renderCalls,
        pendingAsyncResourceRerender: pageRenderer.pendingAsyncResourceRerender ?? null,
      };
    } finally {
      pageRenderer.cancelAll?.();
      pageRenderer.clearLayerTreeCache?.();
      pageRenderer.wasm.getPageLayerTree = originalGetPageLayerTree;
      renderer.renderPage = originalRenderPage;
      canvas.remove();
    }
  });

  assert(!asyncRerenderProbe.error, asyncRerenderProbe.error || 'async rerender probe available');
  assert(asyncRerenderProbe.hasTimerQueue === false, `page renderer no longer uses timer queue=${JSON.stringify(asyncRerenderProbe)}`);
  assert(asyncRerenderProbe.activeRenderStates === 1, `active page render state tracked=${JSON.stringify(asyncRerenderProbe)}`);
  assert(asyncRerenderProbe.callsAfterAsync > asyncRerenderProbe.callsAfterInitial, `async resource callback rerenders page=${JSON.stringify(asyncRerenderProbe)}`);
  assert(asyncRerenderProbe.pendingAsyncResourceRerender === null, `async rerender frame drains cleanly=${JSON.stringify(asyncRerenderProbe)}`);

  setTestCase('canvaskit-static-picture-cache-pages');
  await loadApp(page, '?renderer=canvaskit&canvaskitMode=default');
  const staticPictureProbe = await page.evaluate(() => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const renderer = pageRenderer?.canvaskitRenderer;
    if (!pageRenderer?.wasm || !renderer || typeof pageRenderer.renderPage !== 'function') {
      return { error: 'canvaskit renderer unavailable' };
    }

    const originalGetPageLayerTree = pageRenderer.wasm.getPageLayerTree.bind(pageRenderer.wasm);
    const staticPathOp = (x, y, fillColor) => ({
      type: 'path',
      bbox: { x, y, width: 18, height: 18 },
      transform: { rotation: 0, horzFlip: false, vertFlip: false },
      commands: [
        { type: 'moveTo', x, y },
        { type: 'lineTo', x: x + 18, y },
        { type: 'lineTo', x: x + 18, y: y + 18 },
        { type: 'lineTo', x, y: y + 18 },
        { type: 'closePath' },
      ],
      style: {
        fillColor,
        strokeColor: null,
        strokeWidth: 1,
        strokeDash: 'solid',
        opacity: 1,
      },
    });
    const staticTextOp = (pageIdx) => ({
      id: `cache-text-op-${pageIdx}`,
      type: 'textRun',
      bbox: { x: 4, y: 28, width: 34, height: 18 },
      variant: {
        equivalenceGroup: `cache-text-${pageIdx}`,
        variantId: 'textRun',
        variantKind: 'textRun',
        partIndex: 0,
        partCount: 1,
        isDefaultFallback: true,
      },
      text: 'A',
      baseline: 14,
      rotation: 0,
      isVertical: false,
      orientation: 'horizontal',
      isParaEnd: false,
      isLineBreakEnd: false,
      style: {
        fontFamily: 'RHWP Static Missing Font',
        fontSize: 12,
        color: '#000000',
        bold: false,
        italic: false,
        ratio: 1,
        underline: 'none',
        underlineShape: 0,
        strikethrough: false,
        strikeShape: 0,
        outlineType: 0,
        shadowType: 0,
        shadowColor: '#000000',
        shadowOffsetX: 0,
        shadowOffsetY: 0,
        emboss: false,
        engrave: false,
        emphasisDot: 0,
        shadeColor: '#ffffff',
      },
      positions: [0, 9],
      controlMarks: [],
      tabLeaders: [],
    });
    const staticEquationOp = (bbox, svg) => ({
      type: 'equation',
      bbox,
      color: '#111111',
      fontSize: 10,
      ...svg,
      layoutBox: {
        x: 0,
        y: 0,
        width: bbox.width,
        height: bbox.height,
        baseline: 0,
        kind: { type: 'empty' },
      },
    });
    pageRenderer.wasm.getPageLayerTree = (pageIdx, profile = 'screen') => ({
      pageWidth: 100,
      pageHeight: 100,
      profile,
      resources: { tableId: 2, images: [], svgFragments: [] },
      root: {
        kind: 'group',
        sourceNodeId: 1000 + pageIdx,
        semantic: { role: 'page' },
        bounds: { x: 0, y: 0, width: 100, height: 100 },
        cacheHint: 'staticSubtree',
        children: [
          {
            kind: 'group',
            sourceNodeId: 2000,
            semantic: { role: 'generic' },
            bounds: { x: 0, y: 0, width: 50, height: 50 },
            cacheHint: 'staticSubtree',
            children: [{
              kind: 'leaf',
              sourceNodeId: 3000 + pageIdx,
              bounds: { x: 0, y: 0, width: 50, height: 50 },
              cacheHint: 'none',
              ops: [
                staticPathOp(4, 4, '#000000'),
                staticTextOp(pageIdx),
                staticEquationOp(
                  { x: 4, y: 48, width: 18, height: 8 },
                  { svgContent: '<path d="M0 0H18V8H0Z" fill="#008000"/>' },
                ),
              ],
            }],
          },
          {
            kind: 'group',
            sourceNodeId: 2000,
            semantic: { role: 'generic' },
            bounds: { x: 0, y: 0, width: 50, height: 50 },
            cacheHint: 'staticSubtree',
            children: [{
              kind: 'leaf',
              sourceNodeId: 4000 + pageIdx,
              bounds: { x: 0, y: 0, width: 50, height: 50 },
              cacheHint: 'none',
              ops: [
                staticPathOp(24, 24, '#444444'),
                staticEquationOp(
                  { x: 26, y: 4, width: 18, height: 8 },
                  { svgResourceId: 0 },
                ),
              ],
            }],
          },
        ],
      },
    });

    const canvas = document.createElement('canvas');
    const pageInfo = {
      pageIndex: 0,
      width: 100,
      height: 100,
      sectionIndex: 0,
      marginLeft: 10,
      marginRight: 10,
      marginTop: 10,
      marginBottom: 10,
      marginHeader: 0,
      marginFooter: 0,
    };

    const originalRenderEquationSvgResource = renderer.renderEquationSvgResource;
    let equationSvgReplayCalls = 0;
    renderer.renderEquationSvgResource = function (...args) {
      equationSvgReplayCalls += 1;
      return originalRenderEquationSvgResource.apply(this, args);
    };

    try {
      pageRenderer.clearLayerTreeCache();
      renderer.clearStaticPictureCache?.();
      pageRenderer.renderPage(0, { ...pageInfo, pageIndex: 0 }, canvas, 1);
      pageRenderer.cancelReRender(0);
      const afterFirstPage = renderer.staticPictureCache?.size ?? -1;
      const firstVariantGroups = renderer.getTextVariantSelectionDiagnostics()
        .map((report) => report.equivalenceGroup);
      const firstTextDiagnostics = renderer.getTextReplayDiagnostics();
      const firstEquationDiagnostics = renderer.getEquationReplayDiagnostics();
      const equationSvgReplayCallsAfterFirst = equationSvgReplayCalls;
      pageRenderer.renderPage(0, { ...pageInfo, pageIndex: 0 }, canvas, 1);
      pageRenderer.cancelReRender(0);
      const cachedVariantGroups = renderer.getTextVariantSelectionDiagnostics()
        .map((report) => report.equivalenceGroup);
      const cachedTextDiagnostics = renderer.getTextReplayDiagnostics();
      const cachedEquationDiagnostics = renderer.getEquationReplayDiagnostics();
      const equationSvgReplayCallsAfterCacheHit = equationSvgReplayCalls;
      pageRenderer.renderPage(1, { ...pageInfo, pageIndex: 1 }, canvas, 1);
      pageRenderer.cancelReRender(1);
      const afterSecondPage = renderer.staticPictureCache?.size ?? -1;
      const secondVariantGroups = renderer.getTextVariantSelectionDiagnostics()
        .map((report) => report.equivalenceGroup);
      const secondTextDiagnostics = renderer.getTextReplayDiagnostics();
      const secondEquationDiagnostics = renderer.getEquationReplayDiagnostics();
      const equationSvgReplayCallsAfterSecondPage = equationSvgReplayCalls;
      const cacheKeys = Array.from(renderer.staticPictureCache?.keys?.() ?? []);
      pageRenderer.clearLayerTreeCache();
      const afterClear = renderer.staticPictureCache?.size ?? -1;
      const metadataAfterClear = cacheKeys.map(
        (cacheKey) => renderer.staticPictureCache?.getMetadata?.(cacheKey) ?? null,
      );
      return {
        afterFirstPage,
        afterSecondPage,
        afterClear,
        cacheKeys,
        firstVariantGroups,
        cachedVariantGroups,
        secondVariantGroups,
        firstTextDiagnostics,
        cachedTextDiagnostics,
        secondTextDiagnostics,
        firstEquationDiagnostics,
        cachedEquationDiagnostics,
        secondEquationDiagnostics,
        equationSvgReplayCallsAfterFirst,
        equationSvgReplayCallsAfterCacheHit,
        equationSvgReplayCallsAfterSecondPage,
        metadataAfterClear,
      };
    } finally {
      renderer.renderEquationSvgResource = originalRenderEquationSvgResource;
      pageRenderer.cancelAll?.();
      pageRenderer.clearLayerTreeCache?.();
      pageRenderer.wasm.getPageLayerTree = originalGetPageLayerTree;
    }
  });

  assert(!staticPictureProbe.error, staticPictureProbe.error || 'canvaskit static picture cache probe available');
  assert(
    staticPictureProbe.afterFirstPage >= 3,
    `static picture cache populated after first page=${staticPictureProbe.afterFirstPage}`,
  );
  assert(
    staticPictureProbe.afterSecondPage > staticPictureProbe.afterFirstPage,
    `static picture cache keeps multiple pages=${JSON.stringify(staticPictureProbe)}`,
  );
  assert(
    JSON.stringify(staticPictureProbe.firstVariantGroups) === JSON.stringify(['cache-text-0'])
      && JSON.stringify(staticPictureProbe.cachedVariantGroups) === JSON.stringify(['cache-text-0'])
      && JSON.stringify(staticPictureProbe.secondVariantGroups) === JSON.stringify(['cache-text-1']),
    `text variant diagnostics survive static picture cache hits=${JSON.stringify(staticPictureProbe)}`,
  );
  assert(
    staticPictureProbe.firstTextDiagnostics.unregisteredFontFallbacks === 1
      && staticPictureProbe.cachedTextDiagnostics.unregisteredFontFallbacks === 1
      && staticPictureProbe.secondTextDiagnostics.unregisteredFontFallbacks === 1
      && staticPictureProbe.firstTextDiagnostics.fontSubstitutions[0]?.opId === 'cache-text-op-0'
      && staticPictureProbe.cachedTextDiagnostics.fontSubstitutions[0]?.opId === 'cache-text-op-0'
      && staticPictureProbe.secondTextDiagnostics.fontSubstitutions[0]?.opId === 'cache-text-op-1',
    `text font substitution diagnostics survive static picture cache hits=${JSON.stringify(staticPictureProbe)}`,
  );
  const equationRouteSummary = (diagnostics) => ({
    svgReplays: diagnostics.svgReplays,
    layoutReplays: diagnostics.layoutReplays,
    fallbackReplays: diagnostics.fallbackReplays,
    routes: diagnostics.routes
      .map(({ route, reason }) => `${route}:${reason}`)
      .sort(),
  });
  const expectedEquationRouteSummary = {
    svgReplays: 1,
    layoutReplays: 1,
    fallbackReplays: 1,
    routes: ['layout:svgResourceMissing', 'svg:svgReplayed'],
  };
  assert(
    JSON.stringify(equationRouteSummary(staticPictureProbe.firstEquationDiagnostics))
      === JSON.stringify(expectedEquationRouteSummary)
      && JSON.stringify(equationRouteSummary(staticPictureProbe.cachedEquationDiagnostics))
        === JSON.stringify(expectedEquationRouteSummary)
      && JSON.stringify(equationRouteSummary(staticPictureProbe.secondEquationDiagnostics))
        === JSON.stringify(expectedEquationRouteSummary),
    `equation route diagnostics survive static picture cache hits=${JSON.stringify(staticPictureProbe)}`,
  );
  assert(
    staticPictureProbe.equationSvgReplayCallsAfterFirst === 2
      && staticPictureProbe.equationSvgReplayCallsAfterCacheHit
        === staticPictureProbe.equationSvgReplayCallsAfterFirst
      && staticPictureProbe.equationSvgReplayCallsAfterSecondPage === 4,
    `equation route diagnostics restore from cache without replaying SVG=${JSON.stringify(staticPictureProbe)}`,
  );
  assert(
    staticPictureProbe.metadataAfterClear.every((metadata) => metadata === null),
    `static picture cache releases equation route metadata=${JSON.stringify(staticPictureProbe.metadataAfterClear)}`,
  );
  assert(staticPictureProbe.afterClear === 0, `static picture cache released with layer tree cache=${staticPictureProbe.afterClear}`);

  setTestCase('canvaskit-static-picture-image-effect-readback-recovery');
  const staticPictureImageEffectReadbackProbe = await page.evaluate(() => {
    const renderer = window.__canvasView?.pageRenderer?.canvaskitRenderer;
    if (!renderer) {
      return { error: 'canvaskit renderer unavailable' };
    }

    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = 8;
    sourceCanvas.height = 8;
    const sourceContext = sourceCanvas.getContext('2d');
    if (!sourceContext) {
      return { error: 'image effect fixture canvas unavailable' };
    }
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        sourceContext.fillStyle = (x + y) % 2 === 0 ? '#cc2040' : '#20b060';
        sourceContext.fillRect(x, y, 1, 1);
      }
    }
    const base64 = sourceCanvas.toDataURL('image/png').split(',')[1];
    const tree = {
      pageWidth: 32,
      pageHeight: 32,
      profile: 'screen',
      resources: {
        tableId: 80,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
      },
      root: {
        kind: 'group',
        sourceNodeId: 8000,
        semantic: { role: 'page' },
        bounds: { x: 0, y: 0, width: 32, height: 32 },
        cacheHint: 'staticSubtree',
        children: [{
          kind: 'leaf',
          sourceNodeId: 8001,
          bounds: { x: 0, y: 0, width: 32, height: 32 },
          cacheHint: 'none',
          ops: [{
            type: 'image',
            bbox: { x: 4, y: 4, width: 24, height: 24 },
            base64,
            fillMode: 'stretch',
            effect: 'grayScale',
            transform: { rotation: 0, horzFlip: false, vertFlip: false },
          }],
        }],
      },
    };
    const targetCanvas = document.createElement('canvas');
    targetCanvas.width = 32;
    targetCanvas.height = 32;
    const referenceCanvas = document.createElement('canvas');
    referenceCanvas.width = 32;
    referenceCanvas.height = 32;
    const originalMakeSurface = renderer.canvasKit?.MakeSurface;
    if (!originalMakeSurface) {
      return { error: 'CanvasKit MakeSurface unavailable' };
    }

    try {
      renderer.clearStaticPictureCache?.();
      renderer.resetImageEffectDiagnostics?.();
      renderer.renderPage(tree, referenceCanvas, 1);
      const surfaceSamplingPng = referenceCanvas.toDataURL('image/png');
      const afterSurface = renderer.getImageEffectDiagnostics?.();

      renderer.renderPage({
        ...tree,
        root: {
          kind: 'leaf',
          sourceNodeId: 7999,
          bounds: { x: 0, y: 0, width: 32, height: 32 },
          cacheHint: 'none',
          ops: [],
        },
      }, targetCanvas, 1);
      renderer.clearStaticPictureCache?.();
      for (const image of renderer.resourceCache?.imageEffectCache?.values?.() ?? []) {
        image.delete?.();
      }
      renderer.resourceCache?.imageEffectCache?.clear?.();
      renderer.resetImageEffectDiagnostics?.();
      renderer.canvasKit.MakeSurface = () => null;
      try {
        renderer.renderPage(tree, targetCanvas, 1);
      } finally {
        renderer.canvasKit.MakeSurface = originalMakeSurface;
      }
      const readbackSamplingPng = targetCanvas.toDataURL('image/png');
      const afterReadback = renderer.getImageEffectDiagnostics?.();
      const cacheSizeAfterReadback = renderer.staticPictureCache?.size ?? -1;

      renderer.renderPage(tree, targetCanvas, 1);
      const afterCacheHit = renderer.getImageEffectDiagnostics?.();
      const cacheSizeAfterCacheHit = renderer.staticPictureCache?.size ?? -1;

      return {
        afterSurface,
        afterReadback,
        afterCacheHit,
        cacheSizeAfterReadback,
        cacheSizeAfterCacheHit,
        surfaceSamplingPng,
        readbackSamplingPng,
      };
    } finally {
      renderer.canvasKit.MakeSurface = originalMakeSurface;
      renderer.clearStaticPictureCache?.();
      targetCanvas.remove();
      referenceCanvas.remove();
    }
  });

  assert(
    !staticPictureImageEffectReadbackProbe.error,
    staticPictureImageEffectReadbackProbe.error
      || 'canvaskit image-effect static picture admission probe available',
  );
  assert(
    staticPictureImageEffectReadbackProbe.afterSurface.preprocessFailures === 0
      && staticPictureImageEffectReadbackProbe.afterSurface.fallbackToOriginal === 0
      && staticPictureImageEffectReadbackProbe.afterSurface.preprocessedPixels === 64
      && staticPictureImageEffectReadbackProbe.afterSurface.directImageReadbackPreprocesses === 0,
    `CanvasKit surface image effect establishes a reference=${JSON.stringify(
      staticPictureImageEffectReadbackProbe,
    )}`,
  );
  const imageEffectReadbackSamplingDiff = await comparePngBuffers(
    pngBufferFromDataUrl(staticPictureImageEffectReadbackProbe.surfaceSamplingPng),
    pngBufferFromDataUrl(staticPictureImageEffectReadbackProbe.readbackSamplingPng),
    {
      diffName: 'canvaskit-image-effect-readback-sampling',
      maxDiffPixels: 0,
    },
  );
  assert(
    imageEffectReadbackSamplingDiff.passed,
    `direct CanvasKit image-effect readback matches surface preprocessing exact=${imageEffectReadbackSamplingDiff.exactDiffPixels}, tolerant=${imageEffectReadbackSamplingDiff.rawTolerantDiffPixels}, max_channel_delta=${imageEffectReadbackSamplingDiff.maxChannelDelta}`,
  );
  assert(
    staticPictureImageEffectReadbackProbe.afterReadback.preprocessFailures === 0
      && staticPictureImageEffectReadbackProbe.afterReadback.fallbackToOriginal === 0
      && staticPictureImageEffectReadbackProbe.afterReadback.preprocessedPixels === 64
      && staticPictureImageEffectReadbackProbe.afterReadback.directImageReadbackPreprocesses === 1
      && staticPictureImageEffectReadbackProbe.cacheSizeAfterReadback === 1,
    `CanvasKit image readback preserves the effect and admits the picture=${JSON.stringify(
      staticPictureImageEffectReadbackProbe,
    )}`,
  );
  assert(
    staticPictureImageEffectReadbackProbe.afterCacheHit.preprocessedPixels
      === staticPictureImageEffectReadbackProbe.afterReadback.preprocessedPixels
      && staticPictureImageEffectReadbackProbe.afterCacheHit.directImageReadbackPreprocesses
        === staticPictureImageEffectReadbackProbe.afterReadback.directImageReadbackPreprocesses
      && staticPictureImageEffectReadbackProbe.cacheSizeAfterCacheHit
        === staticPictureImageEffectReadbackProbe.cacheSizeAfterReadback,
    `readback-recovered CanvasKit image-effect picture is reused=${JSON.stringify(
      staticPictureImageEffectReadbackProbe,
    )}`,
  );

  setTestCase('canvaskit-static-picture-cache-resource-payload-invalidation');
  await loadApp(page, '?renderer=canvaskit&canvaskitMode=default');
  const staticPictureResourceProbe = await page.evaluate(() => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const renderer = pageRenderer?.canvaskitRenderer;
    if (!pageRenderer?.wasm || !renderer || typeof pageRenderer.renderPage !== 'function') {
      return { error: 'canvaskit renderer unavailable' };
    }

    const makePixelBytes = (color) => {
      const pixelCanvas = document.createElement('canvas');
      pixelCanvas.width = 1;
      pixelCanvas.height = 1;
      const pixelContext = pixelCanvas.getContext('2d');
      if (!pixelContext) {
        return null;
      }
      pixelContext.fillStyle = color;
      pixelContext.fillRect(0, 0, 1, 1);
      const pixelPngBase64 = pixelCanvas.toDataURL('image/png').split(',')[1];
      return Uint8Array.from(atob(pixelPngBase64), (ch) => ch.charCodeAt(0));
    };
    const blackBytes = makePixelBytes('#000000');
    const whiteBytes = makePixelBytes('#ffffff');
    if (!blackBytes || !whiteBytes) {
      return { error: 'bitmap fixture canvas unavailable' };
    }

    const tree = {
      pageWidth: 64,
      pageHeight: 64,
      profile: 'screen',
      resources: {
        tableId: 81,
        images: [blackBytes, blackBytes],
        imageHashes: [],
        imageKeys: ['mutable-static-image', 'unreferenced-static-image'],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
      },
      root: {
        kind: 'group',
        sourceNodeId: 8100,
        semantic: { role: 'page' },
        bounds: { x: 0, y: 0, width: 64, height: 64 },
        cacheHint: 'staticSubtree',
        children: [{
          kind: 'leaf',
          sourceNodeId: 8101,
          bounds: { x: 0, y: 0, width: 64, height: 64 },
          cacheHint: 'none',
          ops: [{
            type: 'image',
            bbox: { x: 8, y: 8, width: 48, height: 48 },
            resourceId: 0,
            fillMode: 'stretch',
            transform: { rotation: 0, horzFlip: false, vertFlip: false },
          }],
        }],
      },
    };

    const originalGetPageLayerTree = pageRenderer.wasm.getPageLayerTree.bind(pageRenderer.wasm);
    pageRenderer.wasm.getPageLayerTree = () => tree;
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const pageInfo = {
      pageIndex: 0,
      width: 64,
      height: 64,
      sectionIndex: 0,
      marginLeft: 0,
      marginRight: 0,
      marginTop: 0,
      marginBottom: 0,
      marginHeader: 0,
      marginFooter: 0,
    };

    try {
      pageRenderer.clearLayerTreeCache();
      renderer.clearStaticPictureCache?.();
      pageRenderer.renderPage(0, pageInfo, canvas, 1);
      pageRenderer.cancelReRender?.(0);
      const firstPng = canvas.toDataURL('image/png');
      const afterFirstKeys = Array.from(renderer.staticPictureCache?.keys?.() ?? []);

      tree.resources.images[1] = whiteBytes;
      pageRenderer.renderPage(0, pageInfo, canvas, 1);
      pageRenderer.cancelReRender?.(0);
      const secondPng = canvas.toDataURL('image/png');
      const afterSecondKeys = Array.from(renderer.staticPictureCache?.keys?.() ?? []);

      tree.resources.images[0] = whiteBytes;
      pageRenderer.renderPage(0, pageInfo, canvas, 1);
      pageRenderer.cancelReRender?.(0);
      const thirdPng = canvas.toDataURL('image/png');
      const afterThirdKeys = Array.from(renderer.staticPictureCache?.keys?.() ?? []);

      return {
        firstPng,
        secondPng,
        thirdPng,
        afterFirstKeys,
        afterSecondKeys,
        afterThirdKeys,
        cacheSizeAfterThird: renderer.staticPictureCache?.size ?? -1,
      };
    } finally {
      pageRenderer.cancelAll?.();
      pageRenderer.clearLayerTreeCache?.();
      renderer.clearStaticPictureCache?.();
      pageRenderer.wasm.getPageLayerTree = originalGetPageLayerTree;
      canvas.remove();
    }
  });

  assert(
    !staticPictureResourceProbe.error,
    staticPictureResourceProbe.error || 'canvaskit static picture resource invalidation probe available',
  );
  assert(
    staticPictureResourceProbe.firstPng === staticPictureResourceProbe.secondPng
      && staticPictureResourceProbe.afterSecondKeys.length === staticPictureResourceProbe.afterFirstKeys.length,
    `static picture cache ignores unreferenced resource byte changes=${JSON.stringify(staticPictureResourceProbe)}`,
  );
  assert(
    staticPictureResourceProbe.secondPng !== staticPictureResourceProbe.thirdPng,
    `static picture cache key invalidates when resource bytes change=${JSON.stringify(staticPictureResourceProbe)}`,
  );
  assert(
    staticPictureResourceProbe.cacheSizeAfterThird >= 2
      && staticPictureResourceProbe.afterThirdKeys.length > staticPictureResourceProbe.afterSecondKeys.length,
    `static picture cache keeps distinct resource payload keys=${JSON.stringify(staticPictureResourceProbe)}`,
  );

  setTestCase('canvaskit-static-picture-cache-bitmap-glyph-resource-invalidation');
  await loadApp(page, '?renderer=canvaskit&canvaskitMode=default');
  const staticPictureBitmapGlyphResourceProbe = await page.evaluate(() => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const renderer = pageRenderer?.canvaskitRenderer;
    if (!pageRenderer?.wasm || !renderer || typeof pageRenderer.renderPage !== 'function') {
      return { error: 'canvaskit renderer unavailable' };
    }

    const makePixelBytes = (color) => {
      const pixelCanvas = document.createElement('canvas');
      pixelCanvas.width = 1;
      pixelCanvas.height = 1;
      const pixelContext = pixelCanvas.getContext('2d');
      if (!pixelContext) {
        return null;
      }
      pixelContext.fillStyle = color;
      pixelContext.fillRect(0, 0, 1, 1);
      const pixelPngBase64 = pixelCanvas.toDataURL('image/png').split(',')[1];
      return Uint8Array.from(atob(pixelPngBase64), (ch) => ch.charCodeAt(0));
    };
    const blackBytes = makePixelBytes('#000000');
    const whiteBytes = makePixelBytes('#ffffff');
    if (!blackBytes || !whiteBytes) {
      return { error: 'BitmapGlyph fixture canvas unavailable' };
    }

    const source = { id: 8401, utf8Range: { start: 0, end: 1 }, utf16Range: { start: 0, end: 1 } };
    const glyphOutline = {
      id: 'op-static-bitmap-outline',
      type: 'glyphOutline',
      bbox: { x: 8, y: 8, width: 32, height: 32 },
      payloadKind: 'bitmapGlyph',
      source,
      variant: {
        equivalenceGroup: 'static-bitmap-resource',
        variantId: 'glyphOutline',
        variantKind: 'glyphOutline',
        partIndex: 0,
        partCount: 1,
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.bitmapGlyph'],
        anchorOpId: 'op-static-bitmap-text',
        localPaintOrder: 0,
      },
      paintStyle: {
        fontFamily: 'Noto Sans KR',
        fontSize: 20,
        color: '#000000',
        bold: false,
        italic: false,
        ratio: 1,
        underline: 'none',
        underlineShape: 0,
        strikethrough: false,
        strikeShape: 0,
        outlineType: 0,
        shadowType: 0,
        shadowColor: '#000000',
        shadowOffsetX: 0,
        shadowOffsetY: 0,
        emboss: false,
        engrave: false,
        emphasisDot: 0,
        underlineColor: '#000000',
        strikeColor: '#000000',
        shadeColor: '#ffffff',
      },
      placement: {
        runToPage: { a: 1, b: 0, c: 0, d: 1, e: 8, f: 8 },
        baselineY: 0,
      },
      paths: [],
      bitmapGlyph: {
        imageResourceId: 'mutable-static-bitmap-glyph',
        sourceRangeUtf8: { start: 0, end: 1 },
        glyphRange: { start: 0, end: 1 },
        placement: {
          runToPage: { a: 1, b: 0, c: 0, d: 1, e: 8, f: 8 },
          baselineY: 0,
        },
        strikePpem: [16, 16],
        strikeSelection: 'producerResolved',
        alphaMode: 'premultiplied',
        scalingPolicy: 'scaleToEm',
        filtering: 'nearest',
      },
      diagnostics: {
        quality: 'exact',
        replayEligibility: 'portable',
        strictVisualEligible: true,
        maxOriginDeltaPx: 0,
        maxAdvanceDeltaPx: 0,
        maxResidualAfterAdjustmentPx: 0,
        clusterMismatchCount: 0,
        missingGlyphCount: 0,
        usedFallbackFontCount: 0,
      },
    };
    const tree = {
      pageWidth: 64,
      pageHeight: 64,
      profile: 'screen',
      resources: {
        tableId: 84,
        images: [blackBytes],
        imageHashes: [],
        imageKeys: ['mutable-static-bitmap-glyph'],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
      },
      root: {
        kind: 'group',
        sourceNodeId: 8400,
        semantic: { role: 'page' },
        bounds: { x: 0, y: 0, width: 64, height: 64 },
        cacheHint: 'staticSubtree',
        children: [{
          kind: 'leaf',
          sourceNodeId: 8401,
          bounds: { x: 0, y: 0, width: 64, height: 64 },
          cacheHint: 'none',
          ops: [{
            type: 'pageBackground',
            bbox: { x: 0, y: 0, width: 64, height: 64 },
            backgroundColor: '#ffffff',
            borderWidth: 0,
          }, glyphOutline],
        }],
      },
    };

    const originalGetPageLayerTree = pageRenderer.wasm.getPageLayerTree.bind(pageRenderer.wasm);
    pageRenderer.wasm.getPageLayerTree = () => tree;
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const pageInfo = {
      pageIndex: 0,
      width: 64,
      height: 64,
      sectionIndex: 0,
      marginLeft: 0,
      marginRight: 0,
      marginTop: 0,
      marginBottom: 0,
      marginHeader: 0,
      marginFooter: 0,
    };

    try {
      pageRenderer.clearLayerTreeCache();
      renderer.clearStaticPictureCache?.();
      pageRenderer.renderPage(0, pageInfo, canvas, 1);
      pageRenderer.cancelReRender?.(0);
      const firstPng = canvas.toDataURL('image/png');
      const afterFirstKeys = Array.from(renderer.staticPictureCache?.keys?.() ?? []);

      tree.resources.images[0] = whiteBytes;
      pageRenderer.renderPage(0, pageInfo, canvas, 1);
      pageRenderer.cancelReRender?.(0);
      const secondPng = canvas.toDataURL('image/png');
      const afterSecondKeys = Array.from(renderer.staticPictureCache?.keys?.() ?? []);

      return {
        firstPng,
        secondPng,
        afterFirstKeys,
        afterSecondKeys,
        cacheSize: renderer.staticPictureCache?.size ?? -1,
      };
    } finally {
      pageRenderer.cancelAll?.();
      pageRenderer.clearLayerTreeCache?.();
      renderer.clearStaticPictureCache?.();
      pageRenderer.wasm.getPageLayerTree = originalGetPageLayerTree;
      canvas.remove();
    }
  });

  assert(
    !staticPictureBitmapGlyphResourceProbe.error,
    staticPictureBitmapGlyphResourceProbe.error || 'canvaskit static picture BitmapGlyph resource invalidation probe available',
  );
  assert(
    staticPictureBitmapGlyphResourceProbe.firstPng !== staticPictureBitmapGlyphResourceProbe.secondPng,
    `static picture cache key invalidates when BitmapGlyph image resource changes=${JSON.stringify(staticPictureBitmapGlyphResourceProbe)}`,
  );
  assert(
    staticPictureBitmapGlyphResourceProbe.cacheSize >= 2
      && staticPictureBitmapGlyphResourceProbe.afterSecondKeys.length > staticPictureBitmapGlyphResourceProbe.afterFirstKeys.length,
    `static picture cache keeps distinct BitmapGlyph resource payload keys=${JSON.stringify(staticPictureBitmapGlyphResourceProbe)}`,
  );

  setTestCase('canvaskit-static-picture-cache-arraybuffer-resource-invalidation');
  await loadApp(page, '?renderer=canvaskit&canvaskitMode=default');
  const staticPictureArrayBufferProbe = await page.evaluate(() => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const renderer = pageRenderer?.canvaskitRenderer;
    const pictureCache = renderer?.staticPictureCache;
    if (!pageRenderer?.wasm || !renderer || !pictureCache) {
      return { error: 'canvaskit renderer unavailable' };
    }

    const tree = {
      pageWidth: 64,
      pageHeight: 64,
      profile: 'screen',
      resources: {
        tableId: 82,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [new Uint8Array([1, 2, 3, 4]).buffer],
        fontBlobHashes: ['same-producer-hash'],
        fontBlobKeys: ['mutable-font-blob'],
      },
      fontResources: {
        blobs: [{
          id: 'array-buffer-blob',
          source: 'embedded',
          portability: 'portableBlob',
          digest: { algorithm: 'sha256', value: 'same-producer-hash' },
          dataRef: { kind: 'fontBlob', id: '0' },
        }],
        faces: [{
          id: 'array-buffer-face',
          blobKey: 'array-buffer-blob',
          faceIndex: 0,
        }],
      },
      root: {
        kind: 'group',
        sourceNodeId: 8200,
        semantic: { role: 'page' },
        bounds: { x: 0, y: 0, width: 64, height: 64 },
        cacheHint: 'staticSubtree',
        children: [{
          kind: 'leaf',
          sourceNodeId: 8201,
          bounds: { x: 0, y: 0, width: 64, height: 64 },
          cacheHint: 'none',
          ops: [{
            type: 'glyphRun',
            bbox: { x: 10, y: 10, width: 24, height: 24 },
            shapeKey: {
              fontInstance: {
                faceKey: 'array-buffer-face',
                sizePx: 16,
              },
            },
          }],
        }],
      },
    };

    const layerTreeKey = pictureCache.cacheKeyForLayerTree(tree);
    const firstKey = pictureCache.keyForStaticSubtree(
      layerTreeKey,
      tree.profile,
      'flow',
      tree.root,
      tree,
    );
    tree.resources.fontBlobs[0] = new Uint8Array([9, 8, 7, 6]).buffer;
    const secondKey = pictureCache.keyForStaticSubtree(
      layerTreeKey,
      tree.profile,
      'flow',
      tree.root,
      tree,
    );

    return { firstKey, secondKey };
  });

  assert(
    !staticPictureArrayBufferProbe.error,
    staticPictureArrayBufferProbe.error || 'canvaskit static picture ArrayBuffer invalidation probe available',
  );
  assert(
    staticPictureArrayBufferProbe.firstKey !== staticPictureArrayBufferProbe.secondKey,
    `static picture cache key fingerprints ArrayBuffer resources=${JSON.stringify(staticPictureArrayBufferProbe)}`,
  );

  setTestCase('canvaskit-static-picture-cache-svg-resource-invalidation');
  await loadApp(page, '?renderer=canvaskit&canvaskitMode=default');
  const staticPictureSvgResourceProbe = await page.evaluate(() => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const renderer = pageRenderer?.canvaskitRenderer;
    if (!pageRenderer?.wasm || !renderer || typeof pageRenderer.renderPage !== 'function') {
      return { error: 'canvaskit renderer unavailable' };
    }

    const svgFragment = (fill) => `<path d="M0 0 L18 0 L18 18 L0 18 Z" fill="${fill}"/>`;
    const source = { id: 8301, utf8Range: { start: 0, end: 1 }, utf16Range: { start: 0, end: 1 } };
    const glyphOutline = {
      id: 'op-static-svg-outline',
      type: 'glyphOutline',
      bbox: { x: 8, y: 8, width: 32, height: 32 },
      payloadKind: 'svgGlyph',
      source,
      variant: {
        equivalenceGroup: 'static-svg-resource',
        variantId: 'glyphOutline',
        variantKind: 'glyphOutline',
        partIndex: 0,
        partCount: 1,
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.svgGlyph'],
        anchorOpId: 'op-static-svg-text',
        localPaintOrder: 0,
      },
      paintStyle: {
        fontFamily: 'Noto Sans KR',
        fontSize: 20,
        color: '#000000',
        bold: false,
        italic: false,
        ratio: 1,
        underline: 'none',
        underlineShape: 0,
        strikethrough: false,
        strikeShape: 0,
        outlineType: 0,
        shadowType: 0,
        shadowColor: '#000000',
        shadowOffsetX: 0,
        shadowOffsetY: 0,
        emboss: false,
        engrave: false,
        emphasisDot: 0,
        underlineColor: '#000000',
        strikeColor: '#000000',
        shadeColor: '#ffffff',
      },
      placement: {
        runToPage: { a: 1, b: 0, c: 0, d: 1, e: 8, f: 8 },
        baselineY: 0,
      },
      paths: [],
      svgGlyph: {
        vectorResourceId: 'mutable-static-svg',
        sourceRangeUtf8: { start: 0, end: 1 },
        glyphRange: { start: 0, end: 1 },
        placement: {
          runToPage: { a: 1, b: 0, c: 0, d: 1, e: 8, f: 8 },
          baselineY: 0,
        },
        viewBox: { x: 0, y: 0, width: 18, height: 18 },
        securityMode: 'staticSanitized',
        scriptAllowed: false,
        animationAllowed: false,
        externalResourcesAllowed: false,
        interactivityAllowed: false,
      },
      diagnostics: {
        quality: 'exact',
        replayEligibility: 'portable',
        strictVisualEligible: true,
        maxOriginDeltaPx: 0,
        maxAdvanceDeltaPx: 0,
        maxResidualAfterAdjustmentPx: 0,
        clusterMismatchCount: 0,
        missingGlyphCount: 0,
        usedFallbackFontCount: 0,
      },
    };
    const tree = {
      pageWidth: 64,
      pageHeight: 64,
      profile: 'screen',
      resources: {
        tableId: 83,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [svgFragment('#ff00cc')],
        svgHashes: [],
        svgKeys: ['mutable-static-svg'],
      },
      root: {
        kind: 'group',
        sourceNodeId: 8300,
        semantic: { role: 'page' },
        bounds: { x: 0, y: 0, width: 64, height: 64 },
        cacheHint: 'staticSubtree',
        children: [{
          kind: 'leaf',
          sourceNodeId: 8301,
          bounds: { x: 0, y: 0, width: 64, height: 64 },
          cacheHint: 'none',
          ops: [{
            type: 'pageBackground',
            bbox: { x: 0, y: 0, width: 64, height: 64 },
            backgroundColor: '#ffffff',
            borderWidth: 0,
          }, glyphOutline],
        }],
      },
    };

    const originalGetPageLayerTree = pageRenderer.wasm.getPageLayerTree.bind(pageRenderer.wasm);
    pageRenderer.wasm.getPageLayerTree = () => tree;
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const pageInfo = {
      pageIndex: 0,
      width: 64,
      height: 64,
      sectionIndex: 0,
      marginLeft: 0,
      marginRight: 0,
      marginTop: 0,
      marginBottom: 0,
      marginHeader: 0,
      marginFooter: 0,
    };

    try {
      pageRenderer.clearLayerTreeCache();
      renderer.clearStaticPictureCache?.();
      pageRenderer.renderPage(0, pageInfo, canvas, 1);
      pageRenderer.cancelReRender?.(0);
      const firstPng = canvas.toDataURL('image/png');
      const afterFirstKeys = Array.from(renderer.staticPictureCache?.keys?.() ?? []);

      tree.resources.svgFragments[0] = svgFragment('#00ffff');
      pageRenderer.renderPage(0, pageInfo, canvas, 1);
      pageRenderer.cancelReRender?.(0);
      const secondPng = canvas.toDataURL('image/png');
      const afterSecondKeys = Array.from(renderer.staticPictureCache?.keys?.() ?? []);

      return {
        firstPng,
        secondPng,
        afterFirstKeys,
        afterSecondKeys,
        cacheSize: renderer.staticPictureCache?.size ?? -1,
      };
    } finally {
      pageRenderer.cancelAll?.();
      pageRenderer.clearLayerTreeCache?.();
      renderer.clearStaticPictureCache?.();
      pageRenderer.wasm.getPageLayerTree = originalGetPageLayerTree;
      canvas.remove();
    }
  });

  assert(
    !staticPictureSvgResourceProbe.error,
    staticPictureSvgResourceProbe.error || 'canvaskit static picture SvgGlyph resource invalidation probe available',
  );
  assert(
    staticPictureSvgResourceProbe.firstPng !== staticPictureSvgResourceProbe.secondPng,
    `static picture cache key invalidates when SvgGlyph vector resource changes=${JSON.stringify(staticPictureSvgResourceProbe)}`,
  );
  assert(
    staticPictureSvgResourceProbe.cacheSize >= 2
      && staticPictureSvgResourceProbe.afterSecondKeys.length > staticPictureSvgResourceProbe.afterFirstKeys.length,
    `static picture cache keeps distinct SvgGlyph resource payload keys=${JSON.stringify(staticPictureSvgResourceProbe)}`,
  );

  setTestCase('canvaskit-software-surface-backend');
  await loadApp(page, '?renderer=canvaskit&canvaskitMode=default&canvaskitSurface=software');
  const softwareSurfaceProbe = await page.evaluate(() => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const renderer = pageRenderer?.canvaskitRenderer;
    if (!pageRenderer?.wasm || !renderer || typeof pageRenderer.renderPage !== 'function') {
      return { error: 'canvaskit renderer unavailable' };
    }

    const originalGetPageLayerTree = pageRenderer.wasm.getPageLayerTree.bind(pageRenderer.wasm);
    pageRenderer.wasm.getPageLayerTree = (_pageIdx, profile = 'screen') => ({
      pageWidth: 64,
      pageHeight: 64,
      profile,
      resources: { tableId: 3, images: [], svgFragments: [] },
      root: {
        kind: 'leaf',
        sourceNodeId: 3000,
        bounds: { x: 0, y: 0, width: 64, height: 64 },
        cacheHint: 'none',
        ops: [{
          type: 'rectangle',
          bbox: { x: 8, y: 8, width: 24, height: 24 },
          cornerRadius: 0,
          gradient: null,
          transform: { rotation: 0, horzFlip: false, vertFlip: false },
          style: {
            fillColor: '#336699',
            strokeColor: null,
            strokeWidth: 0,
            strokeDash: 'solid',
            opacity: 1,
            pattern: null,
            shadow: null,
          },
        }],
      },
    });

    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const pageInfo = {
      pageIndex: 0,
      width: 64,
      height: 64,
      sectionIndex: 0,
      marginLeft: 0,
      marginRight: 0,
      marginTop: 0,
      marginBottom: 0,
      marginHeader: 0,
      marginFooter: 0,
    };

    try {
      const before = renderer.getSurfaceDiagnostics();
      pageRenderer.renderPage(0, pageInfo, canvas, 1);
      const afterFirst = renderer.getSurfaceDiagnostics();
      pageRenderer.renderPage(0, pageInfo, canvas, 1);
      const afterSecond = renderer.getSurfaceDiagnostics();
      return {
        preference: window.__canvaskitSurfacePreference,
        before,
        afterFirst,
        afterSecond,
      };
    } finally {
      pageRenderer.cancelAll?.();
      pageRenderer.clearLayerTreeCache?.();
      pageRenderer.wasm.getPageLayerTree = originalGetPageLayerTree;
      canvas.remove();
    }
  });

  assert(!softwareSurfaceProbe.error, softwareSurfaceProbe.error || 'canvaskit software surface probe available');
  assert(softwareSurfaceProbe.preference === 'software', `surface preference exposed=${JSON.stringify(softwareSurfaceProbe)}`);
  assert(
    softwareSurfaceProbe.afterFirst.backend === 'software'
      && softwareSurfaceProbe.afterFirst.usedGpuSurface === false,
    `software surface selected=${JSON.stringify(softwareSurfaceProbe)}`,
  );
  assert(
    softwareSurfaceProbe.afterFirst.webglAttempts === 0
      && softwareSurfaceProbe.afterFirst.softwareAttempts === 1
      && softwareSurfaceProbe.afterFirst.createdSurfaces === 1,
    `software surface avoids WebGL path=${JSON.stringify(softwareSurfaceProbe)}`,
  );
  assert(
    softwareSurfaceProbe.afterSecond.reusedSurfaces > softwareSurfaceProbe.afterFirst.reusedSurfaces
      && softwareSurfaceProbe.afterSecond.createdSurfaces === softwareSurfaceProbe.afterFirst.createdSurfaces,
    `software surface cache reuses matching canvas=${JSON.stringify(softwareSurfaceProbe)}`,
  );

  setTestCase('canvaskit-cpu-surface-alias');
  await loadApp(page, '?renderer=canvaskit&canvaskitMode=default&canvaskitSurface=cpu');
  const cpuSurfaceAliasProbe = await page.evaluate(() => ({
    preference: window.__canvaskitSurfacePreference,
    request: window.__canvaskitSurfaceRequest,
    diagnostics: window.__canvasView?.pageRenderer?.canvaskitRenderer?.getSurfaceDiagnostics?.() ?? null,
  }));
  assert(
    cpuSurfaceAliasProbe.preference === 'software'
      && cpuSurfaceAliasProbe.request?.requested === 'cpu'
      && cpuSurfaceAliasProbe.request?.unsupportedValue === null
      && cpuSurfaceAliasProbe.request?.unsupportedReason === null
      && cpuSurfaceAliasProbe.diagnostics?.preference === 'software',
    `canvaskitSurface=cpu aliases to software=${JSON.stringify(cpuSurfaceAliasProbe)}`,
  );

  setTestCase('canvaskit-explicit-auto-surface-diagnostics');
  await loadApp(page, '?renderer=canvaskit&canvaskitMode=default&canvaskitSurface=auto');
  const autoSurfaceProbe = await page.evaluate(() => ({
    preference: window.__canvaskitSurfacePreference,
    request: window.__canvaskitSurfaceRequest,
    diagnostics: window.__canvasView?.pageRenderer?.canvaskitRenderer?.getSurfaceDiagnostics?.() ?? null,
  }));
  assert(
    autoSurfaceProbe.preference === 'auto'
      && autoSurfaceProbe.request?.requested === 'auto'
      && autoSurfaceProbe.request?.unsupportedValue === null
      && autoSurfaceProbe.request?.unsupportedReason === null
      && autoSurfaceProbe.diagnostics?.preference === 'auto'
      && autoSurfaceProbe.diagnostics?.unsupportedValue === null
      && autoSurfaceProbe.diagnostics?.unsupportedReason === null,
    `canvaskitSurface=auto is a supported auto preference=${JSON.stringify(autoSurfaceProbe)}`,
  );

  setTestCase('canvaskit-explicit-auto-surface-backend-diagnostics');
  await loadApp(page, '?renderer=canvaskit&canvaskitMode=default&canvaskitSurfaceBackend=auto');
  const autoSurfaceBackendProbe = await page.evaluate(() => ({
    preference: window.__canvaskitSurfacePreference,
    request: window.__canvaskitSurfaceRequest,
    diagnostics: window.__canvasView?.pageRenderer?.canvaskitRenderer?.getSurfaceDiagnostics?.() ?? null,
  }));
  assert(
    autoSurfaceBackendProbe.preference === 'auto'
      && autoSurfaceBackendProbe.request?.requested === 'auto'
      && autoSurfaceBackendProbe.request?.unsupportedValue === null
      && autoSurfaceBackendProbe.request?.unsupportedReason === null
      && autoSurfaceBackendProbe.diagnostics?.preference === 'auto'
      && autoSurfaceBackendProbe.diagnostics?.unsupportedValue === null
      && autoSurfaceBackendProbe.diagnostics?.unsupportedReason === null,
    `canvaskitSurfaceBackend=auto is a supported auto preference=${JSON.stringify(autoSurfaceBackendProbe)}`,
  );

  setTestCase('canvaskit-surface-backend-aliases');
  await loadApp(page, '?renderer=canvaskit&canvaskitMode=default&canvaskitSurfaceBackend=sw');
  const swSurfaceBackendAliasProbe = await page.evaluate(() => ({
    preference: window.__canvaskitSurfacePreference,
    request: window.__canvaskitSurfaceRequest,
    diagnostics: window.__canvasView?.pageRenderer?.canvaskitRenderer?.getSurfaceDiagnostics?.() ?? null,
  }));
  assert(
    swSurfaceBackendAliasProbe.preference === 'software'
      && swSurfaceBackendAliasProbe.request?.requested === 'sw'
      && swSurfaceBackendAliasProbe.request?.unsupportedValue === null
      && swSurfaceBackendAliasProbe.request?.unsupportedReason === null
      && swSurfaceBackendAliasProbe.diagnostics?.preference === 'software',
    `canvaskitSurfaceBackend=sw aliases to software=${JSON.stringify(swSurfaceBackendAliasProbe)}`,
  );
  await loadApp(page, '?renderer=canvaskit&canvaskitMode=default&canvaskitSurfaceBackend=gpu');
  const gpuSurfaceBackendAliasProbe = await page.evaluate(() => ({
    preference: window.__canvaskitSurfacePreference,
    request: window.__canvaskitSurfaceRequest,
    diagnostics: window.__canvasView?.pageRenderer?.canvaskitRenderer?.getSurfaceDiagnostics?.() ?? null,
  }));
  assert(
    gpuSurfaceBackendAliasProbe.preference === 'webgpu'
      && gpuSurfaceBackendAliasProbe.request?.requested === 'gpu'
      && gpuSurfaceBackendAliasProbe.request?.unsupportedValue === null
      && gpuSurfaceBackendAliasProbe.request?.unsupportedReason === null
      && gpuSurfaceBackendAliasProbe.diagnostics?.preference === 'webgpu',
    `canvaskitSurfaceBackend=gpu aliases to WebGPU=${JSON.stringify(gpuSurfaceBackendAliasProbe)}`,
  );

  setTestCase('canvaskit-webgl-surface-fallback');
  await loadApp(page, '?renderer=canvaskit&canvaskitMode=default&canvaskitSurface=webgl');
  const webglSurfaceProbe = await page.evaluate(() => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const renderer = pageRenderer?.canvaskitRenderer;
    if (!pageRenderer?.wasm || !renderer || typeof pageRenderer.renderPage !== 'function') {
      return { error: 'canvaskit renderer unavailable' };
    }

    const originalGetPageLayerTree = pageRenderer.wasm.getPageLayerTree.bind(pageRenderer.wasm);
    pageRenderer.wasm.getPageLayerTree = (_pageIdx, profile = 'screen') => ({
      pageWidth: 64,
      pageHeight: 64,
      profile,
      resources: { tableId: 4, images: [], svgFragments: [] },
      root: {
        kind: 'leaf',
        sourceNodeId: 4000,
        bounds: { x: 0, y: 0, width: 64, height: 64 },
        cacheHint: 'none',
        ops: [{
          type: 'rectangle',
          bbox: { x: 12, y: 12, width: 28, height: 20 },
          cornerRadius: 0,
          gradient: null,
          transform: { rotation: 0, horzFlip: false, vertFlip: false },
          style: {
            fillColor: '#0055cc',
            strokeColor: null,
            strokeWidth: 0,
            strokeDash: 'solid',
            opacity: 1,
            pattern: null,
            shadow: null,
          },
        }],
      },
    });

    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const pageInfo = {
      pageIndex: 0,
      width: 64,
      height: 64,
      sectionIndex: 0,
      marginLeft: 0,
      marginRight: 0,
      marginTop: 0,
      marginBottom: 0,
      marginHeader: 0,
      marginFooter: 0,
    };

    try {
      const before = renderer.getSurfaceDiagnostics();
      pageRenderer.renderPage(0, pageInfo, canvas, 1);
      const afterFirst = renderer.getSurfaceDiagnostics();
      pageRenderer.renderPage(0, pageInfo, canvas, 1);
      const afterSecond = renderer.getSurfaceDiagnostics();
      return {
        preference: window.__canvaskitSurfacePreference,
        before,
        afterFirst,
        afterSecond,
        png: canvas.toDataURL('image/png'),
      };
    } finally {
      pageRenderer.cancelAll?.();
      pageRenderer.clearLayerTreeCache?.();
      pageRenderer.wasm.getPageLayerTree = originalGetPageLayerTree;
      canvas.remove();
    }
  });

  assert(!webglSurfaceProbe.error, webglSurfaceProbe.error || 'canvaskit WebGL surface fallback probe available');
  assert(webglSurfaceProbe.preference === 'webgl', `WebGL surface preference exposed=${JSON.stringify(webglSurfaceProbe)}`);
  assert(
    webglSurfaceProbe.afterFirst.webglAttempts >= 1,
    `WebGL preference attempts WebGL surface first=${JSON.stringify(webglSurfaceProbe)}`,
  );
  assert(
    webglSurfaceProbe.afterFirst.backend === 'webgl'
      || (
        webglSurfaceProbe.afterFirst.backend === 'software'
        && webglSurfaceProbe.afterFirst.softwareFallbacks >= 1
        && webglSurfaceProbe.afterFirst.webglFailures >= 1
        && typeof webglSurfaceProbe.afterFirst.webglLastFailure === 'string'
      ),
    `WebGL preference uses WebGL or direct software surface fallback=${JSON.stringify(webglSurfaceProbe)}`,
  );
  assert(
    webglSurfaceProbe.afterSecond.reusedSurfaces > webglSurfaceProbe.afterFirst.reusedSurfaces
      && webglSurfaceProbe.afterSecond.createdSurfaces === webglSurfaceProbe.afterFirst.createdSurfaces,
    `WebGL-preferred surface cache reuses selected backend=${JSON.stringify(webglSurfaceProbe)}`,
  );
  const webglSurfaceBluePixels = countPixels(webglSurfaceProbe.png, (pixel) => (
    pixel.alpha > 200 && pixel.blue > 160 && pixel.red < 60 && pixel.green > 40 && pixel.green < 120
  ));
  assert(
    webglSurfaceBluePixels > 200,
    `WebGL-preferred surface path renders direct CanvasKit content bluePixels=${webglSurfaceBluePixels}`,
  );

  setTestCase('canvaskit-webgpu-surface-param-contract');
  await loadApp(page, '?renderer=canvaskit&canvaskitMode=default&canvaskitSurface=webgpu');
  const webgpuSurfaceParamProbe = await page.evaluate(() => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const renderer = pageRenderer?.canvaskitRenderer;
    if (!pageRenderer?.wasm || !renderer || typeof pageRenderer.renderPage !== 'function') {
      return { error: 'canvaskit renderer unavailable' };
    }

    const originalGetPageLayerTree = pageRenderer.wasm.getPageLayerTree.bind(pageRenderer.wasm);
    pageRenderer.wasm.getPageLayerTree = (_pageIdx, profile = 'screen') => ({
      pageWidth: 64,
      pageHeight: 64,
      profile,
      resources: { tableId: 5, images: [], svgFragments: [] },
      root: {
        kind: 'leaf',
        sourceNodeId: 5000,
        bounds: { x: 0, y: 0, width: 64, height: 64 },
        cacheHint: 'none',
        ops: [{
          type: 'rectangle',
          bbox: { x: 12, y: 12, width: 28, height: 20 },
          cornerRadius: 0,
          gradient: null,
          transform: { rotation: 0, horzFlip: false, vertFlip: false },
          style: {
            fillColor: '#0055cc',
            strokeColor: null,
            strokeWidth: 0,
            strokeDash: 'solid',
            opacity: 1,
            pattern: null,
            shadow: null,
          },
        }],
      },
    });

    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const pageInfo = {
      pageIndex: 0,
      width: 64,
      height: 64,
      sectionIndex: 0,
      marginLeft: 0,
      marginRight: 0,
      marginTop: 0,
      marginBottom: 0,
      marginHeader: 0,
      marginFooter: 0,
    };

    try {
      const before = renderer.getSurfaceDiagnostics();
      pageRenderer.renderPage(0, pageInfo, canvas, 1);
      const afterFirst = renderer.getSurfaceDiagnostics();
      pageRenderer.renderPage(0, pageInfo, canvas, 1);
      const afterSecond = renderer.getSurfaceDiagnostics();
      return {
        preference: window.__canvaskitSurfacePreference,
        request: window.__canvaskitSurfaceRequest,
        before,
        afterFirst,
        afterSecond,
        png: canvas.toDataURL('image/png'),
      };
    } finally {
      pageRenderer.cancelAll?.();
      pageRenderer.clearLayerTreeCache?.();
      pageRenderer.wasm.getPageLayerTree = originalGetPageLayerTree;
      canvas.remove();
    }
  });
  assert(
    !webgpuSurfaceParamProbe.error,
    webgpuSurfaceParamProbe.error || 'canvaskit WebGPU surface fallback probe available',
  );
  assert(
    webgpuSurfaceParamProbe.preference === 'webgpu',
    `WebGPU surface request resolves to explicit preference=${JSON.stringify(webgpuSurfaceParamProbe)}`,
  );
  assert(
    webgpuSurfaceParamProbe.request?.unsupportedValue === null
      && webgpuSurfaceParamProbe.request?.unsupportedReason === null
      && webgpuSurfaceParamProbe.afterFirst?.unsupportedValue === null
      && webgpuSurfaceParamProbe.afterFirst?.unsupportedReason === null,
    `WebGPU surface request is a supported explicit preference=${JSON.stringify(webgpuSurfaceParamProbe)}`,
  );
  assert(
    webgpuSurfaceParamProbe.afterFirst?.webgpuAttempts >= 1,
    `WebGPU surface path attempted=${JSON.stringify(webgpuSurfaceParamProbe)}`,
  );
  assert(
    ['webgpu', 'webgl', 'software'].includes(webgpuSurfaceParamProbe.afterFirst?.backend),
    `WebGPU surface request selects WebGPU or falls back to direct CanvasKit surfaces=${JSON.stringify(webgpuSurfaceParamProbe)}`,
  );
  assert(
    webgpuSurfaceParamProbe.afterFirst?.backend === 'webgpu'
      || (
        webgpuSurfaceParamProbe.afterFirst?.webgpuFailures >= 1
        && typeof webgpuSurfaceParamProbe.afterFirst?.webgpuLastFailure === 'string'
      ),
    `non-WebGPU fallback records WebGPU failure diagnostics=${JSON.stringify(webgpuSurfaceParamProbe)}`,
  );
  assert(
    webgpuSurfaceParamProbe.afterSecond.reusedSurfaces > webgpuSurfaceParamProbe.afterFirst.reusedSurfaces
      && webgpuSurfaceParamProbe.afterSecond.createdSurfaces === webgpuSurfaceParamProbe.afterFirst.createdSurfaces,
    `WebGPU-preferred fallback surface cache reuses selected backend=${JSON.stringify(webgpuSurfaceParamProbe)}`,
  );
  const webgpuSurfaceBluePixels = countPixels(webgpuSurfaceParamProbe.png, (pixel) => (
    pixel.alpha > 200 && pixel.blue > 160 && pixel.red < 60 && pixel.green > 40 && pixel.green < 120
  ));
  assert(
    webgpuSurfaceBluePixels > 200,
    `WebGPU-preferred surface path renders direct CanvasKit content bluePixels=${webgpuSurfaceBluePixels}`,
  );

  setTestCase('canvaskit-invalid-surface-request-diagnostics');
  await loadApp(page, '?renderer=canvaskit&canvaskitMode=default&canvaskitSurface=definitely-not-a-surface');
  await loadHwpFile(page, 'lseg-01-basic.hwp');
  const invalidSurfaceParamProbe = await page.evaluate(() => {
    const renderer = window.__canvasView?.pageRenderer?.canvaskitRenderer;
    const canvas = document.querySelector('#scroll-container canvas');
    if (!renderer) {
      return { error: 'CanvasKit renderer unavailable' };
    }
    return {
      preference: window.__canvaskitSurfacePreference,
      request: window.__canvaskitSurfaceRequest,
      diagnostics: renderer.getSurfaceDiagnostics(),
      canvasWidth: canvas?.width ?? 0,
      canvasHeight: canvas?.height ?? 0,
    };
  });
  assert(
    !invalidSurfaceParamProbe.error,
    invalidSurfaceParamProbe.error || 'invalid CanvasKit surface request probe available',
  );
  assert(
    invalidSurfaceParamProbe.preference === 'auto'
      && invalidSurfaceParamProbe.request?.requested === 'definitely-not-a-surface'
      && invalidSurfaceParamProbe.request?.unsupportedValue === 'definitely-not-a-surface'
      && invalidSurfaceParamProbe.request?.unsupportedReason === 'unsupportedSurfaceBackend',
    `invalid CanvasKit surface request resolves to auto with diagnostics=${JSON.stringify(invalidSurfaceParamProbe)}`,
  );
  assert(
    invalidSurfaceParamProbe.diagnostics?.unsupportedValue === 'definitely-not-a-surface'
      && invalidSurfaceParamProbe.diagnostics?.unsupportedReason === 'unsupportedSurfaceBackend'
      && invalidSurfaceParamProbe.diagnostics?.webgpuAttempts === 0
      && ['webgl', 'software'].includes(invalidSurfaceParamProbe.diagnostics?.backend),
    `invalid CanvasKit surface request renders through auto fallback without WebGPU attempt=${JSON.stringify(invalidSurfaceParamProbe)}`,
  );
  assert(
    invalidSurfaceParamProbe.canvasWidth > 0 && invalidSurfaceParamProbe.canvasHeight > 0,
    `invalid CanvasKit surface request still renders canvas=${JSON.stringify(invalidSurfaceParamProbe)}`,
  );

  setTestCase('layer-resource-cache-edit-preservation');
  await loadApp(page, '?renderer=canvaskit&canvaskitMode=default&canvaskitSurface=auto');
  setTestCase('layer-resource-font-blob-normalization');
  const fontBlobNormalizationProbe = await page.evaluate(() => {
    const wasm = window.__wasm;
    if (!wasm?.normalizeLayerResources || !wasm?.clearLayerResourceCache) {
      return { error: 'WasmBridge resource normalizer unavailable' };
    }

    const makeTree = (payload, digest) => ({
      pageWidth: 100,
      pageHeight: 100,
      profile: 'screen',
      resources: {
        tableId: 900,
        images: [],
        svgFragments: [],
        fontBlobs: [payload],
        fontBlobHashes: [digest],
        fontBlobKeys: ['font:fixture'],
      },
      fontResources: {
        blobs: [{
          id: `blob-${digest}`,
          source: 'embedded',
          portability: 'portableBlob',
          digest: { algorithm: 'blake3', value: digest },
          dataRef: { kind: 'fontBlob', id: 'font:fixture' },
        }],
        faces: [],
      },
      root: {
        kind: 'leaf',
        sourceNodeId: 0,
        bounds: { x: 0, y: 0, width: 100, height: 100 },
        cacheHint: 'none',
        ops: [],
      },
    });

    wasm.clearLayerResourceCache();
    const first = wasm.normalizeLayerResources(
      makeTree('data:font/ttf;base64,AQIDBA==', 'digest-a'),
    );
    const second = wasm.normalizeLayerResources(
      makeTree([1, 2, 3, 4], 'digest-a'),
    );
    const omitted = wasm.normalizeLayerResources(
      makeTree(undefined, 'digest-a'),
    );
    const replacement = wasm.normalizeLayerResources(
      makeTree([4, 3, 2, 1], 'digest-b'),
    );
    const stats = wasm.getLayerResourceStats();
    const beforeCompactionTableId = replacement.resources?.tableId ?? null;
    const compacted = wasm.compactLayerResourceCacheIfNeeded(
      1,
      Number.MAX_SAFE_INTEGER,
    );
    const afterCompactionStats = wasm.getLayerResourceStats();

    return {
      firstRef: first.fontResources?.blobs?.[0]?.dataRef?.id,
      secondRef: second.fontResources?.blobs?.[0]?.dataRef?.id,
      omittedRef: omitted.fontResources?.blobs?.[0]?.dataRef?.id,
      replacementRef: replacement.fontResources?.blobs?.[0]?.dataRef?.id,
      firstBytes: Array.from(first.resources?.fontBlobs?.[0] ?? []),
      replacementBytes: Array.from(replacement.resources?.fontBlobs?.[1] ?? []),
      sameResourceTable: first.resources === second.resources
        && second.resources === omitted.resources
        && omitted.resources === replacement.resources,
      fontBlobKeys: replacement.resources?.fontBlobKeys ?? [],
      stats,
      compaction: {
        compacted,
        beforeTableId: beforeCompactionTableId,
        afterTableId: afterCompactionStats.tableId,
        retainedPayloadCount: afterCompactionStats.retainedPayloadCount,
      },
    };
  });
  assert(
    !fontBlobNormalizationProbe.error,
    fontBlobNormalizationProbe.error || 'font blob normalization probe available',
  );
  assert(
    fontBlobNormalizationProbe.firstRef === '0'
      && fontBlobNormalizationProbe.secondRef === '0'
      && fontBlobNormalizationProbe.omittedRef === '0'
      && fontBlobNormalizationProbe.replacementRef === '1',
    `font blob refs normalize to document resource ids=${JSON.stringify(fontBlobNormalizationProbe)}`,
  );
  assert(
    JSON.stringify(fontBlobNormalizationProbe.firstBytes) === '[1,2,3,4]'
      && JSON.stringify(fontBlobNormalizationProbe.replacementBytes) === '[4,3,2,1]',
    `font blob payloads survive normalization=${JSON.stringify(fontBlobNormalizationProbe)}`,
  );
  assert(
    fontBlobNormalizationProbe.sameResourceTable
      && fontBlobNormalizationProbe.stats?.fontBlobCount === 2
      && fontBlobNormalizationProbe.stats?.fontBlobPayloadsOmitted === 1,
    `font blobs share the document table and omit known payloads=${JSON.stringify(fontBlobNormalizationProbe)}`,
  );
  assert(
    fontBlobNormalizationProbe.fontBlobKeys.length === 2
      && fontBlobNormalizationProbe.fontBlobKeys.every((key) => key === 'font:fixture'),
    `font blob key collisions keep distinct payload ids=${JSON.stringify(fontBlobNormalizationProbe)}`,
  );
  assert(
    fontBlobNormalizationProbe.compaction?.compacted === true
      && fontBlobNormalizationProbe.compaction.afterTableId
        === fontBlobNormalizationProbe.compaction.beforeTableId + 1
      && fontBlobNormalizationProbe.compaction.retainedPayloadCount === 0,
    `resource retention budget starts a clean document table generation=${JSON.stringify(fontBlobNormalizationProbe)}`,
  );

  await loadHwpFile(page, '20250130-hongbo_saved.hwp');
  const resourcePreservationProbe = await page.evaluate(() => {
    const canvasView = window.__canvasView;
    const wasm = window.__wasm;
    const renderer = canvasView?.pageRenderer?.canvaskitRenderer;
    if (!canvasView || !wasm?.getPageLayerTree || !renderer?.resourceCache) {
      return { error: 'canvas view, wasm bridge, or CanvasKit renderer unavailable' };
    }

    const beforeTree = wasm.getPageLayerTree(0, 'screen');
    const beforeResources = beforeTree.resources;
    renderer.resourceCache.setResources(beforeResources);
    const beforeCachedImage = renderer.resourceCache.image(0);
    const beforeImageCacheSize = renderer.imageCache?.size ?? -1;
    canvasView.refreshPages();
    const afterTree = wasm.getPageLayerTree(0, 'screen');
    const afterResources = afterTree.resources;
    renderer.resourceCache.setResources(afterResources);
    const afterCachedImage = renderer.resourceCache.image(0);
    const originalCompactLayerResources = wasm.compactLayerResourceCacheIfNeeded.bind(wasm);
    const originalResetDocumentResources = canvasView.pageRenderer.resetDocumentResources.bind(
      canvasView.pageRenderer,
    );
    let compactionResetCalls = 0;
    try {
      wasm.compactLayerResourceCacheIfNeeded = () => true;
      canvasView.pageRenderer.resetDocumentResources = () => {
        compactionResetCalls += 1;
      };
      canvasView.refreshPages();
    } finally {
      wasm.compactLayerResourceCacheIfNeeded = originalCompactLayerResources;
      canvasView.pageRenderer.resetDocumentResources = originalResetDocumentResources;
    }

    return {
      beforeImageCount: beforeResources?.images?.length ?? -1,
      afterImageCount: afterResources?.images?.length ?? -1,
      beforeTableId: beforeResources?.tableId ?? null,
      afterTableId: afterResources?.tableId ?? null,
      sameResourceTable: beforeResources === afterResources,
      beforeImageCacheSize,
      afterImageCacheSize: renderer.imageCache?.size ?? -1,
      reusedDecodedImage: beforeCachedImage !== null && beforeCachedImage === afterCachedImage,
      layerTreeCacheSize: canvasView.pageRenderer?.layerTreeCache?.size ?? -1,
      compactionResetCalls,
    };
  });

  assert(
    !resourcePreservationProbe.error,
    resourcePreservationProbe.error || 'layer resource edit-preservation probe available',
  );
  assert(
    resourcePreservationProbe.beforeImageCount > 0,
    `resource table populated before refresh=${JSON.stringify(resourcePreservationProbe)}`,
  );
  assert(
    resourcePreservationProbe.afterImageCount > 0,
    `resource table remains populated after refresh=${JSON.stringify(resourcePreservationProbe)}`,
  );
  assert(
    resourcePreservationProbe.sameResourceTable === true,
    `ordinary refresh preserves the document resource table=${JSON.stringify(resourcePreservationProbe)}`,
  );
  assert(
    resourcePreservationProbe.beforeTableId === resourcePreservationProbe.afterTableId,
    `ordinary refresh preserves the resource table id=${JSON.stringify(resourcePreservationProbe)}`,
  );
  assert(
    resourcePreservationProbe.beforeImageCacheSize > 0
      && resourcePreservationProbe.afterImageCacheSize >= resourcePreservationProbe.beforeImageCacheSize,
    `ordinary refresh preserves decoded CanvasKit image state=${JSON.stringify(resourcePreservationProbe)}`,
  );
  assert(
    resourcePreservationProbe.reusedDecodedImage,
    `ordinary refresh reuses the decoded CanvasKit image=${JSON.stringify(resourcePreservationProbe)}`,
  );
  assert(
    resourcePreservationProbe.compactionResetCalls === 1,
    `refresh resets renderer resources when the document table compacts=${JSON.stringify(resourcePreservationProbe)}`,
  );

  setTestCase('layer-resource-cache-immediate-document-reset');
  const immediateResourceResetProbe = await page.evaluate(() => {
    const canvasView = window.__canvasView;
    const renderer = canvasView?.pageRenderer?.canvaskitRenderer;
    if (!canvasView?.reset || !renderer?.fontRegistry) {
      return { error: 'canvas view reset or CanvasKit renderer unavailable' };
    }
    renderer.fontRegistry.registerVerifiedFontBlob(
      'document-reset-fixture',
      'document-reset-digest',
      new Uint8Array([1, 2, 3]),
    );
    const before = {
      imageCacheSize: renderer.imageCache?.size ?? -1,
      verifiedFontBlobCount: renderer.fontRegistry.verifiedFontBlobs?.size ?? -1,
    };
    canvasView.reset();
    return {
      before,
      imageCacheSize: renderer.imageCache?.size ?? -1,
      mipmappedImageCacheSize: renderer.mipmappedImageCache?.size ?? -1,
      imageEffectCacheSize: renderer.resourceCache?.imageEffectCache?.size ?? -1,
      verifiedFontBlobCount: renderer.fontRegistry.verifiedFontBlobs?.size ?? -1,
      resourceTableId: renderer.resourceCache
        ? renderer.resourceCache.resourceTableId
        : 'unavailable',
      lastRenderedTree: renderer.lastRenderedTree ?? null,
      lastTargetCanvas: renderer.lastTargetCanvas ?? null,
    };
  });
  assert(
    !immediateResourceResetProbe.error,
    immediateResourceResetProbe.error || 'immediate document resource reset probe available',
  );
  assert(
    immediateResourceResetProbe.before.imageCacheSize > 0
      && immediateResourceResetProbe.before.verifiedFontBlobCount > 0,
    `document-scoped renderer state is populated before reset=${JSON.stringify(immediateResourceResetProbe)}`,
  );
  assert(
    immediateResourceResetProbe.imageCacheSize === 0
      && immediateResourceResetProbe.mipmappedImageCacheSize === 0
      && immediateResourceResetProbe.imageEffectCacheSize === 0,
    `true document reset releases CanvasKit image state immediately=${JSON.stringify(immediateResourceResetProbe)}`,
  );
  assert(
    immediateResourceResetProbe.verifiedFontBlobCount === 0,
    `true document reset releases verified document fonts=${JSON.stringify(immediateResourceResetProbe)}`,
  );
  assert(
    immediateResourceResetProbe.resourceTableId === null
      && immediateResourceResetProbe.lastRenderedTree === null
      && immediateResourceResetProbe.lastTargetCanvas === null,
    `true document reset detaches the previous CanvasKit document=${JSON.stringify(immediateResourceResetProbe)}`,
  );

  setTestCase('canvaskit-local-font-cache-invalidation');
  const localFontCacheInvalidationProbe = await page.evaluate(async () => {
    const renderer = window.__canvasView?.pageRenderer?.canvaskitRenderer;
    const registry = renderer?.fontRegistry;
    if (!renderer?.prepareLocalFonts || !registry?.prepareLocalFonts) {
      return { error: 'CanvasKit local font preparation unavailable' };
    }

    let deletedBlobs = 0;
    const originalPrepareLocalFonts = registry.prepareLocalFonts.bind(registry);
    registry.prepareLocalFonts = async () => ({ registered: 0, removed: 1, changed: true });
    renderer.textBlobCache.set('bundled-alias|fixture', {
      delete() {
        deletedBlobs += 1;
      },
    });
    renderer.failedTextBlobCacheKeys.add('bundled-alias|failed');
    renderer.textFallbackFamilyCache.set('bundled-alias|fixture', 'Bundled Family');

    try {
      const result = await renderer.prepareLocalFonts(['Bundled Family'], { refresh: true });
      return {
        result,
        deletedBlobs,
        textBlobCacheSize: renderer.textBlobCache.size,
        failedTextBlobCacheSize: renderer.failedTextBlobCacheKeys.size,
        textFallbackFamilyCacheSize: renderer.textFallbackFamilyCache.size,
        staticPictureCacheSize: renderer.staticPictureCache.size,
      };
    } finally {
      registry.prepareLocalFonts = originalPrepareLocalFonts;
    }
  });
  assert(
    !localFontCacheInvalidationProbe.error,
    localFontCacheInvalidationProbe.error || 'CanvasKit local font cache invalidation probe available',
  );
  assert(
    localFontCacheInvalidationProbe.result?.registered === 0
      && localFontCacheInvalidationProbe.result?.removed === 1
      && localFontCacheInvalidationProbe.result?.changed === true
      && localFontCacheInvalidationProbe.deletedBlobs === 1
      && localFontCacheInvalidationProbe.textBlobCacheSize === 0
      && localFontCacheInvalidationProbe.failedTextBlobCacheSize === 0
      && localFontCacheInvalidationProbe.textFallbackFamilyCacheSize === 0
      && localFontCacheInvalidationProbe.staticPictureCacheSize === 0,
    `changed local face selection invalidates provider-dependent caches=${JSON.stringify(localFontCacheInvalidationProbe)}`,
  );

  setTestCase('canvaskit-local-font-face-matrix');
  const localFontFaceMatrixProbe = await page.evaluate(() => {
    const registry = window.__canvasView?.pageRenderer?.canvaskitRenderer?.fontRegistry;
    if (!registry?.resolveProviderFace) {
      return { error: 'CanvasKit provider face resolution unavailable' };
    }

    const family = 'RHWP Local Matrix Fixture';
    const familyKey = family.toLocaleLowerCase('en-US');
    const exactMediumKey = `${familyKey} medium exact`;
    const faces = [
      { providerFamily: 'fixture-light-upright', weight: 300, italic: false },
      { providerFamily: 'fixture-regular-upright', weight: 400, italic: false },
      { providerFamily: 'fixture-medium-upright', weight: 500, italic: false },
      { providerFamily: 'fixture-bold-upright', weight: 700, italic: false },
      { providerFamily: 'fixture-regular-italic', weight: 400, italic: true },
      { providerFamily: 'fixture-bold-italic', weight: 700, italic: true },
    ];
    registry.localProviderFamilies.set(family, faces);
    registry.localAliasFamilies.set(familyKey, family);
    registry.localAliasProviderFaces.set(familyKey, faces);
    registry.localAliasFamilies.set(exactMediumKey, family);
    registry.localAliasProviderFaces.set(exactMediumKey, [faces[2]]);

    try {
      const resolved = {
        light: registry.resolveProviderFace(family, 300, false),
        regular: registry.resolveProviderFace(family, 400, false),
        medium: registry.resolveProviderFace(family, 500, false),
        bold: registry.resolveProviderFace(family, 700, false),
        italic: registry.resolveProviderFace(family, 400, true),
        boldItalic: registry.resolveProviderFace(family, 700, true),
        exactMedium: registry.resolveProviderFace(`${family} Medium Exact`, 400, false),
      };
      registry.localProviderFamilies.set(family, faces.slice(0, 3));
      registry.localAliasProviderFaces.set(familyKey, faces.slice(0, 3));
      resolved.synthetic = registry.resolveProviderFace(family, 700, true);
      return resolved;
    } finally {
      registry.localProviderFamilies.delete(family);
      registry.localAliasFamilies.delete(familyKey);
      registry.localAliasProviderFaces.delete(familyKey);
      registry.localAliasFamilies.delete(exactMediumKey);
      registry.localAliasProviderFaces.delete(exactMediumKey);
    }
  });
  assert(
    !localFontFaceMatrixProbe.error,
    localFontFaceMatrixProbe.error || 'CanvasKit local font face matrix probe available',
  );
  assert(
    localFontFaceMatrixProbe.light.providerFamily === 'fixture-light-upright'
      && localFontFaceMatrixProbe.regular.providerFamily === 'fixture-regular-upright'
      && localFontFaceMatrixProbe.medium.providerFamily === 'fixture-medium-upright'
      && localFontFaceMatrixProbe.bold.providerFamily === 'fixture-bold-upright'
      && localFontFaceMatrixProbe.italic.providerFamily === 'fixture-regular-italic'
      && localFontFaceMatrixProbe.boldItalic.providerFamily === 'fixture-bold-italic',
    `local provider selects exact weight/slant faces=${JSON.stringify(localFontFaceMatrixProbe)}`,
  );
  assert(
    localFontFaceMatrixProbe.exactMedium.providerFamily === 'fixture-medium-upright'
      && localFontFaceMatrixProbe.exactMedium.physicalWeight === 500,
    `exact local face alias wins over requested weight approximation=${JSON.stringify(localFontFaceMatrixProbe)}`,
  );
  assert(
    localFontFaceMatrixProbe.synthetic.providerFamily === 'fixture-medium-upright'
      && localFontFaceMatrixProbe.synthetic.synthesizeBold === true
      && localFontFaceMatrixProbe.synthetic.synthesizeItalic === true,
    `missing local styles use nearest weight before synthetic bold/italic=${JSON.stringify(localFontFaceMatrixProbe)}`,
  );

  setTestCase('layer-resource-cache-document-reset');
  await loadHwpFile(page, 'pic-crop-01.hwp');
  const resourceResetProbe = await page.evaluate(() => {
    const canvasView = window.__canvasView;
    const wasm = window.__wasm;
    const renderer = canvasView?.pageRenderer?.canvaskitRenderer;
    if (!wasm?.getPageLayerTree || !renderer?.resourceCache) {
      return { error: 'wasm bridge or CanvasKit renderer unavailable' };
    }
    const tree = wasm.getPageLayerTree(0, 'screen');
    const tableId = tree.resources?.tableId ?? null;
    const resourceCacheKeys = Array.from(renderer.imageCache?.keys?.() ?? [])
      .filter((key) => key.startsWith('res:'));
    return {
      tableId,
      rendererTableId: renderer.resourceCache.resourceTableId ?? null,
      resourceCacheKeys,
    };
  });
  assert(!resourceResetProbe.error, resourceResetProbe.error || 'layer resource document-reset probe available');
  assert(
    resourceResetProbe.tableId !== resourcePreservationProbe.afterTableId,
    `new document load advances the resource table generation=${JSON.stringify(resourceResetProbe)}`,
  );
  assert(
    resourceResetProbe.rendererTableId === resourceResetProbe.tableId,
    `CanvasKit adopts the new document resource table=${JSON.stringify(resourceResetProbe)}`,
  );
  assert(
    resourceResetProbe.resourceCacheKeys.length > 0
      && resourceResetProbe.resourceCacheKeys.every(
        (key) => key.startsWith(`res:${resourceResetProbe.tableId}:`),
      ),
    `new document load releases stale resource-table images=${JSON.stringify(resourceResetProbe)}`,
  );

  setTestCase('document-resource-table-cache-reuse');
  await loadApp(page, '?renderer=canvaskit&canvaskitMode=default');
  const resourceReuseProbe = await page.evaluate(() => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const renderer = pageRenderer?.canvaskitRenderer;
    if (!pageRenderer?.wasm || !renderer || typeof pageRenderer.renderPage !== 'function') {
      return { error: 'canvaskit renderer unavailable' };
    }

    const pixelCanvas = document.createElement('canvas');
    pixelCanvas.width = 1;
    pixelCanvas.height = 1;
    const pixelContext = pixelCanvas.getContext('2d');
    if (!pixelContext) {
      return { error: 'bitmap fixture canvas unavailable' };
    }
    pixelContext.fillStyle = '#000000';
    pixelContext.fillRect(0, 0, 1, 1);
    const pixelPngBase64 = pixelCanvas.toDataURL('image/png').split(',')[1];
    const pixelBytes = Uint8Array.from(atob(pixelPngBase64), (ch) => ch.charCodeAt(0));
    const makeResources = () => ({
      tableId: 77,
      images: [pixelBytes],
      imageHashes: ['pixel-hash'],
      imageKeys: ['pixel-key'],
      svgFragments: [],
      svgHashes: [],
      svgKeys: [],
    });
    const makeTree = (pageIdx) => ({
      pageWidth: 64,
      pageHeight: 64,
      profile: 'screen',
      resources: makeResources(),
      root: {
        kind: 'leaf',
        sourceNodeId: 4000 + pageIdx,
        bounds: { x: 0, y: 0, width: 64, height: 64 },
        cacheHint: 'none',
        ops: [{
          type: 'image',
          bbox: { x: 8, y: 8, width: 48, height: 48 },
          resourceId: 0,
          fillMode: 'stretch',
          transform: { rotation: 0, horzFlip: false, vertFlip: false },
        }],
      },
    });

    const originalGetPageLayerTree = pageRenderer.wasm.getPageLayerTree.bind(pageRenderer.wasm);
    pageRenderer.wasm.getPageLayerTree = (pageIdx, profile = 'screen') => ({
      ...makeTree(pageIdx),
      profile,
    });

    const canvas = document.createElement('canvas');
    const pageInfo = {
      pageIndex: 0,
      width: 64,
      height: 64,
      sectionIndex: 0,
      marginLeft: 10,
      marginRight: 10,
      marginTop: 10,
      marginBottom: 10,
      marginHeader: 0,
      marginFooter: 0,
    };

    try {
      pageRenderer.clearLayerTreeCache();
      pageRenderer.renderPage(0, { ...pageInfo, pageIndex: 0 }, canvas, 1);
      const firstResources = pageRenderer.layerTreeCache?.get?.(0)?.resources ?? null;
      const firstCachedImage = Array.from(renderer.imageCache?.values?.() ?? [])[0] ?? null;
      pageRenderer.renderPage(1, { ...pageInfo, pageIndex: 1 }, canvas, 1);
      const secondResources = pageRenderer.layerTreeCache?.get?.(1)?.resources ?? null;
      const secondCachedImage = Array.from(renderer.imageCache?.values?.() ?? [])[0] ?? null;
      return {
        imageCacheSize: renderer.imageCache?.size ?? -1,
        firstTableId: firstResources?.tableId ?? null,
        secondTableId: secondResources?.tableId ?? null,
        distinctResourceObjects: firstResources !== secondResources,
        reusedImageObject: firstCachedImage === secondCachedImage,
      };
    } finally {
      pageRenderer.cancelAll?.();
      pageRenderer.clearLayerTreeCache?.();
      pageRenderer.wasm.getPageLayerTree = originalGetPageLayerTree;
    }
  });

  assert(!resourceReuseProbe.error, resourceReuseProbe.error || 'document resource table reuse probe available');
  assert(resourceReuseProbe.firstTableId === 77, `first resource table id=${JSON.stringify(resourceReuseProbe)}`);
  assert(resourceReuseProbe.secondTableId === 77, `second resource table id=${JSON.stringify(resourceReuseProbe)}`);
  assert(resourceReuseProbe.distinctResourceObjects, `resource tables differ by object=${JSON.stringify(resourceReuseProbe)}`);
  assert(resourceReuseProbe.imageCacheSize === 1, `resource cache keeps one decoded image=${JSON.stringify(resourceReuseProbe)}`);
  assert(resourceReuseProbe.reusedImageObject, `resource cache reuses image across pages=${JSON.stringify(resourceReuseProbe)}`);

  setTestCase('document-resource-table-hashless-payload-cache-invalidation');
  await loadApp(page, '?renderer=canvaskit&canvaskitMode=default');
  const hashlessResourceProbe = await page.evaluate(() => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const renderer = pageRenderer?.canvaskitRenderer;
    if (!pageRenderer?.wasm || !renderer || typeof pageRenderer.renderPage !== 'function') {
      return { error: 'canvaskit renderer unavailable' };
    }

    const makePixelBytes = (color) => {
      const pixelCanvas = document.createElement('canvas');
      pixelCanvas.width = 1;
      pixelCanvas.height = 1;
      const pixelContext = pixelCanvas.getContext('2d');
      if (!pixelContext) {
        return null;
      }
      pixelContext.fillStyle = color;
      pixelContext.fillRect(0, 0, 1, 1);
      const pixelPngBase64 = pixelCanvas.toDataURL('image/png').split(',')[1];
      return Uint8Array.from(atob(pixelPngBase64), (ch) => ch.charCodeAt(0));
    };
    const blackBytes = makePixelBytes('#000000');
    const whiteBytes = makePixelBytes('#ffffff');
    if (!blackBytes || !whiteBytes) {
      return { error: 'bitmap fixture canvas unavailable' };
    }
    const makeTree = (imageBytes, pageIdx) => ({
      pageWidth: 64,
      pageHeight: 64,
      profile: 'screen',
      resources: {
        tableId: 79,
        images: [imageBytes],
        imageHashes: [],
        imageKeys: ['hashless-pixel'],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
      },
      root: {
        kind: 'leaf',
        sourceNodeId: 4200 + pageIdx,
        bounds: { x: 0, y: 0, width: 64, height: 64 },
        cacheHint: 'none',
        ops: [{
          type: 'image',
          bbox: { x: 8, y: 8, width: 48, height: 48 },
          resourceId: 0,
          fillMode: 'stretch',
          transform: { rotation: 0, horzFlip: false, vertFlip: false },
        }],
      },
    });

    const originalGetPageLayerTree = pageRenderer.wasm.getPageLayerTree.bind(pageRenderer.wasm);
    pageRenderer.wasm.getPageLayerTree = (pageIdx, profile = 'screen') => ({
      ...makeTree(pageIdx === 0 ? blackBytes : whiteBytes, pageIdx),
      profile,
    });

    const canvas = document.createElement('canvas');
    const pageInfo = {
      pageIndex: 0,
      width: 64,
      height: 64,
      sectionIndex: 0,
      marginLeft: 10,
      marginRight: 10,
      marginTop: 10,
      marginBottom: 10,
      marginHeader: 0,
      marginFooter: 0,
    };

    try {
      pageRenderer.clearLayerTreeCache();
      pageRenderer.renderPage(0, { ...pageInfo, pageIndex: 0 }, canvas, 1);
      const afterFirstKeys = Array.from(renderer.imageCache?.keys?.() ?? []);
      const firstCachedImage = Array.from(renderer.imageCache?.values?.() ?? [])[0] ?? null;
      pageRenderer.renderPage(1, { ...pageInfo, pageIndex: 1 }, canvas, 1);
      const afterSecondKeys = Array.from(renderer.imageCache?.keys?.() ?? []);
      const secondCachedImages = Array.from(renderer.imageCache?.values?.() ?? []);
      return {
        imageCacheSize: renderer.imageCache?.size ?? -1,
        afterFirstKeys,
        afterSecondKeys,
        firstCachedImageReusedForSecondPayload: firstCachedImage === (secondCachedImages[0] ?? null),
        allKeysUsePayloadFingerprint: afterSecondKeys.every((key) => key.includes(':fp:')),
      };
    } finally {
      pageRenderer.cancelAll?.();
      pageRenderer.clearLayerTreeCache?.();
      pageRenderer.wasm.getPageLayerTree = originalGetPageLayerTree;
    }
  });

  assert(
    !hashlessResourceProbe.error,
    hashlessResourceProbe.error || 'hashless resource cache invalidation probe available',
  );
  assert(
    hashlessResourceProbe.imageCacheSize === 1,
    `hashless resource replacement releases the stale CanvasKit image=${JSON.stringify(hashlessResourceProbe)}`,
  );
  assert(
    hashlessResourceProbe.afterFirstKeys.length === 1
      && hashlessResourceProbe.afterSecondKeys.length === 1
      && hashlessResourceProbe.afterFirstKeys[0] !== hashlessResourceProbe.afterSecondKeys[0],
    `hashless resource replacement changes the payload-specific cache key=${JSON.stringify(hashlessResourceProbe)}`,
  );
  assert(
    hashlessResourceProbe.allKeysUsePayloadFingerprint,
    `hashless resource cache keys use payload fingerprints=${JSON.stringify(hashlessResourceProbe)}`,
  );
  assert(
    hashlessResourceProbe.firstCachedImageReusedForSecondPayload === false,
    `hashless resource payload changes do not reuse stale CanvasKit image=${JSON.stringify(hashlessResourceProbe)}`,
  );

  setTestCase('canvaskit-base64-image-without-atob');
  const base64WithoutAtobProbe = await page.evaluate(() => {
    const renderer = window.__canvasView?.pageRenderer?.canvaskitRenderer;
    if (!renderer) {
      return { error: 'canvaskit renderer unavailable' };
    }
    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = 2;
    sourceCanvas.height = 2;
    const sourceContext = sourceCanvas.getContext('2d');
    if (!sourceContext) {
      return { error: 'source canvas unavailable' };
    }
    sourceContext.fillStyle = '#00aa44';
    sourceContext.fillRect(0, 0, 2, 2);
    const base64 = sourceCanvas.toDataURL('image/png').split(',')[1];
    const tree = {
      pageWidth: 32,
      pageHeight: 32,
      profile: 'screen',
      resources: {
        tableId: 78,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
      },
      root: {
        kind: 'leaf',
        sourceNodeId: 4078,
        bounds: { x: 0, y: 0, width: 32, height: 32 },
        cacheHint: 'none',
        ops: [{
          type: 'image',
          bbox: { x: 4, y: 4, width: 24, height: 24 },
          base64,
          fillMode: 'fitToSize',
          transform: { rotation: 0, horzFlip: false, vertFlip: false },
        }],
      },
    };
    const canvas = document.createElement('canvas');
    canvas.width = tree.pageWidth;
    canvas.height = tree.pageHeight;
    const context = canvas.getContext('2d');
    if (!context) {
      return { error: 'target canvas unavailable' };
    }
    const atobDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'atob');
    try {
      Object.defineProperty(globalThis, 'atob', {
        configurable: true,
        writable: true,
        value: undefined,
      });
      renderer.renderPage(tree, canvas, 1);
    } finally {
      if (atobDescriptor) {
        Object.defineProperty(globalThis, 'atob', atobDescriptor);
      } else {
        delete globalThis.atob;
      }
    }
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let greenPixels = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset + 3] > 220 && pixels[offset] < 50 && pixels[offset + 1] > 120 && pixels[offset + 2] < 100) {
        greenPixels += 1;
      }
    }
    return {
      greenPixels,
      imageCacheSize: renderer.imageCache?.size ?? -1,
    };
  });
  assert(
    !base64WithoutAtobProbe.error,
    base64WithoutAtobProbe.error || 'CanvasKit base64 image without atob probe available',
  );
  assert(
    base64WithoutAtobProbe.greenPixels > 300,
    `CanvasKit decodes base64 images without atob green=${JSON.stringify(base64WithoutAtobProbe)}`,
  );

  setTestCase('field-marker-browser-parity');
  await loadApp(page, '?renderer=canvaskit&canvaskitMode=compat');
  const fieldMarkerProbe = await page.evaluate(() => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }

    const style = (color, underline = 'bottom') => ({
      fontFamily: 'Arial',
      fontSize: 14,
      color,
      bold: false,
      italic: false,
      ratio: 1,
      underline,
      underlineShape: 0,
      strikethrough: false,
      strikeShape: 0,
      outlineType: 0,
      shadowType: 0,
      shadowColor: '#000000',
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      emboss: false,
      engrave: false,
      emphasisDot: 0,
      underlineColor: color,
      strikeColor: color,
      shadeColor: '#ffffff',
    });
    const positions = (text, advance = 8) => Array.from(
      { length: text.length + 1 },
      (_, index) => index * advance,
    );
    const textRun = ({
      text,
      x,
      y,
      width,
      fieldMarker,
      shapeMarkerIndex,
      color,
      rotation = 0,
    }) => ({
      type: 'textRun',
      bbox: { x, y, width, height: 24 },
      text,
      baseline: 17,
      rotation,
      isVertical: false,
      orientation: 'horizontal',
      fieldMarker,
      shapeMarkerIndex,
      isParaEnd: false,
      isLineBreakEnd: false,
      style: style(color),
      positions: positions(text),
      controlMarks: [],
      tabLeaders: [],
    });
    const tree = {
      pageWidth: 220,
      pageHeight: 110,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: true,
        showControlCodes: true,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 992,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
      },
      root: {
        kind: 'leaf',
        sourceNodeId: 10,
        bounds: { x: 0, y: 0, width: 220, height: 110 },
        cacheHint: 'none',
        ops: [
          {
            type: 'pageBackground',
            bbox: { x: 0, y: 0, width: 220, height: 110 },
            backgroundColor: '#ffffff',
            borderWidth: 0,
          },
          textRun({
            text: 'FIELD BEGIN',
            x: 10,
            y: 14,
            width: 96,
            fieldMarker: 'fieldBegin',
            color: '#cc6600',
          }),
          textRun({
            text: 'FIELD END',
            x: 10,
            y: 46,
            width: 80,
            fieldMarker: 'fieldEnd',
            color: '#cc6600',
            rotation: 10,
          }),
          textRun({
            text: 'FIELD BOTH',
            x: 122,
            y: 14,
            width: 88,
            fieldMarker: 'fieldBeginEnd',
            color: '#cc6600',
          }),
          textRun({
            text: 'SHAPE 7',
            x: 122,
            y: 46,
            width: 70,
            fieldMarker: 'shapeMarker',
            shapeMarkerIndex: 7,
            color: '#ff0000',
            rotation: -8,
          }),
        ],
      },
    };

    const render = (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = 220;
      canvas.height = 110;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };

    return {
      canvas2d: render(canvas2dRenderer),
      canvaskit: render(canvaskitRenderer),
    };
  });

  assert(!fieldMarkerProbe.error, fieldMarkerProbe.error || 'field marker browser probe available');
  const fieldMarkerDiff = await comparePngBuffers(
    pngBufferFromDataUrl(fieldMarkerProbe.canvas2d),
    pngBufferFromDataUrl(fieldMarkerProbe.canvaskit),
    {
      diffName: 'field-marker-browser-parity',
      ignoreChannelDelta: 1,
      maxDiffRatio: 0.1,
    },
  );
  assert(
    fieldMarkerDiff.passed,
    `field marker browser parity exact=${fieldMarkerDiff.exactDiffPixels}, tolerant=${fieldMarkerDiff.rawTolerantDiffPixels} (${fieldMarkerDiff.rawTolerantDiffRatio.toFixed(4)}), max_channel_delta=${fieldMarkerDiff.maxChannelDelta}`,
  );

  setTestCase('canvaskit-portable-glyph-run');
  await loadApp(page, '?renderer=canvaskit&canvaskitMode=default');
  const glyphRunFontBytes = [...fs.readFileSync(path.join(RHWP_ROOT, 'web', 'fonts', 'NotoSansKR-Regular.woff2'))];
  const colorGlyphFontPath = path.join(RHWP_ROOT, 'tests', 'fixtures', 'fonts', 'RHWPColorSmokeCOLRv0.ttf');
  const colorGlyphFontBytes = [...fs.readFileSync(colorGlyphFontPath)];
  const exactFaceFontPath = path.join(RHWP_ROOT, 'tests', 'fixtures', 'fonts', 'RHWPExactFaceSmoke.ttc');
  const exactFaceFontBytes = [...fs.readFileSync(exactFaceFontPath)];
  const colorGlyphFontDigest = '07aba86fc0f09361a59a4df361362e895e7e77cc8f20dd24ee5493cd1c85aac0';
  const colorGlyphFontActualDigest = crypto
    .createHash('sha256')
    .update(Buffer.from(colorGlyphFontBytes))
    .digest('hex');
  assert(
    colorGlyphFontActualDigest === colorGlyphFontDigest,
    `CanvasKit color glyph fixture digest matches actual=${colorGlyphFontActualDigest}`,
  );
  assert(
    fs.existsSync(path.join(RHWP_ROOT, 'tests', 'fixtures', 'fonts', 'RHWPColorSmokeCOLRv0.LICENSE.md')),
    'CanvasKit color glyph fixture license file exists',
  );
  assert(
    fs.existsSync(path.join(RHWP_ROOT, 'tests', 'fixtures', 'fonts', 'RHWPExactFaceSmoke.LICENSE.md')),
    'CanvasKit exact-face TTC fixture license file exists',
  );
  const portableGlyphRunProbe = await page.evaluate(({
    fontBytes,
    colorFontBytes,
    colorFontDigest,
    exactFaceFontBytes: exactFaceFontSource,
  }) => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvaskitRenderer) {
      return { error: 'CanvasKit renderer unavailable' };
    }
    const canvasKit = canvaskitRenderer.canvasKit;
    const bytes = new Uint8Array(fontBytes);
    const typeface = canvasKit.Typeface.MakeTypefaceFromData(bytes.buffer.slice(0))
      ?? canvasKit.Typeface.MakeFreeTypeFaceFromData(bytes.buffer.slice(0));
    if (!typeface) {
      return { error: 'test typeface unavailable' };
    }
    const font = new canvasKit.Font(typeface, 42);
    const glyphIds = Array.from(font.getGlyphIDs('H') ?? []);
    font.delete();
    typeface.delete();
    if (glyphIds.length !== 1 || glyphIds[0] === 0) {
      return { error: `invalid glyph id ${JSON.stringify(glyphIds)}` };
    }
    const colorBytes = new Uint8Array(colorFontBytes);
    const colorTypeface = canvasKit.Typeface.MakeTypefaceFromData(colorBytes.buffer.slice(0))
      ?? canvasKit.Typeface.MakeFreeTypeFaceFromData(colorBytes.buffer.slice(0));
    let colorGlyphIds = [];
    if (colorTypeface) {
      const colorFont = new canvasKit.Font(colorTypeface, 72);
      colorGlyphIds = Array.from(colorFont.getGlyphIDs('\uE000') ?? []);
      colorFont.delete();
      colorTypeface.delete();
    }
    const exactFaceBytes = new Uint8Array(exactFaceFontSource);
    const exactFaceManager = canvasKit.FontMgr.FromData(exactFaceBytes.buffer.slice(0));
    const exactFaceFamily = exactFaceManager
      ? Array.from(
          { length: exactFaceManager.countFamilies() },
          (_, index) => exactFaceManager.getFamilyName(index),
        ).find((family) => family === 'RHWP Exact Face One')
      : null;
    const exactFaceTypeface = exactFaceManager && exactFaceFamily
      ? exactFaceManager.matchFamilyStyle(exactFaceFamily, { weight: 400, width: 5, slant: 0 })
      : null;
    const exactFaceFont = exactFaceTypeface ? new canvasKit.Font(exactFaceTypeface, 42) : null;
    const exactFaceGlyphIds = exactFaceFont
      ? Array.from(exactFaceFont.getGlyphIDs('\uE104') ?? [])
      : [];
    exactFaceFont?.delete();
    exactFaceTypeface?.delete();
    exactFaceManager?.delete();
    if (exactFaceGlyphIds.length !== 1 || exactFaceGlyphIds[0] === 0) {
      return { error: `invalid exact TTC face glyph id ${JSON.stringify(exactFaceGlyphIds)}` };
    }

    const style = (color) => ({
      fontFamily: 'Noto Sans KR',
      fontSize: 42,
      color,
      bold: false,
      italic: false,
      ratio: 1,
      underline: 'none',
      underlineShape: 0,
      strikethrough: false,
      strikeShape: 0,
      outlineType: 0,
      shadowType: 0,
      shadowColor: '#000000',
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      emboss: false,
      engrave: false,
      emphasisDot: 0,
      underlineColor: color,
      strikeColor: color,
      shadeColor: '#ffffff',
    });
    const source = {
      id: 0,
      utf8Range: { start: 0, end: 1 },
      utf16Range: { start: 0, end: 1 },
    };
    const textVariant = {
      equivalenceGroup: 'glyph-fixture-0',
      variantId: 'textRun',
      variantKind: 'textRun',
      partIndex: 0,
      partCount: 1,
      isDefaultFallback: true,
    };
    const glyphVariant = {
      equivalenceGroup: 'glyph-fixture-0',
      variantId: 'glyphRun',
      variantKind: 'glyphRun',
      partIndex: 0,
      partCount: 1,
      isDefaultFallback: false,
      requires: ['fontResources', 'text.glyphRun'],
      quality: 'exact',
    };
    const digest = 'fixture-font-digest';
    const fontResourceKey = `font:fixture:${fontBytes.length}:${digest}`;
    const tree = {
      pageWidth: 96,
      pageHeight: 64,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1801,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [fontBytes],
        fontBlobHashes: [digest],
        fontBlobKeys: [fontResourceKey],
      },
      fontResources: {
        blobs: [{
          id: 'fixture-font-blob',
          source: 'bundled',
          portability: 'portableBlob',
          digest: { algorithm: 'fixture', value: digest },
          dataRef: { kind: 'fontBlob', id: fontResourceKey },
        }],
        faces: [{
          id: 'fixture-face',
          blobKey: 'fixture-font-blob',
          faceIndex: 0,
          familyNames: [{ value: 'Noto Sans KR' }],
          styleNames: [],
        }],
      },
      textSources: [{
        id: 0,
        text: 'H',
        utf8Range: { start: 0, end: 1 },
        utf16Range: { start: 0, end: 1 },
        annotations: [],
      }],
      root: {
        kind: 'leaf',
        sourceNodeId: 1,
        bounds: { x: 0, y: 0, width: 96, height: 64 },
        cacheHint: 'none',
        ops: [
          {
            type: 'pageBackground',
            bbox: { x: 0, y: 0, width: 96, height: 64 },
            backgroundColor: '#ffffff',
            borderWidth: 0,
          },
          {
            type: 'textRun',
            bbox: { x: 12, y: 8, width: 56, height: 48 },
            source,
            variant: textVariant,
            text: 'H',
            baseline: 42,
            rotation: 0,
            isVertical: false,
            orientation: 'horizontal',
            projectionKind: 'verbatim',
            clusterBasis: 'legacyPosition',
            style: style('#ff0000'),
            paintStyle: style('#ff0000'),
            positions: [0, 34],
            controlMarks: [],
            tabLeaders: [],
          },
          {
            type: 'glyphRun',
            bbox: { x: 12, y: 8, width: 56, height: 48 },
            source,
            variant: glyphVariant,
            paintStyle: style('#000000'),
            shapeKey: {
              fontInstance: {
                faceKey: 'fixture-face',
                sizePx: 42,
                variations: [],
                syntheticBold: false,
                syntheticItalic: false,
              },
              direction: 'ltr',
              writingMode: 'horizontal-tb',
              shapingEngine: 'fixture',
              fallbackPolicy: 'none',
            },
            placement: {
              runToPage: { a: 1, b: 0, c: 0, d: 1, e: 12, f: 50 },
              baselineY: 0,
            },
            glyphIds,
            positions: [{ x: 0, y: 0 }],
            clusters: [{
              sourceRangeUtf8: { start: 0, end: 1 },
              sourceRangeUtf16: { start: 0, end: 1 },
              glyphRange: { start: 0, end: 1 },
              flags: [],
            }],
            direction: 'ltr',
            writingMode: 'horizontal-tb',
            orientation: 'horizontal',
            diagnostics: {
              quality: 'exact',
              replayEligibility: 'portable',
              strictVisualEligible: true,
              maxOriginDeltaPx: 0,
              maxAdvanceDeltaPx: 0,
              maxResidualAfterAdjustmentPx: 0,
              clusterMismatchCount: 0,
              missingGlyphCount: 0,
              usedFallbackFontCount: 0,
            },
          },
        ],
      },
    };

    const glyphOp = (candidate) => candidate.root.ops.find((op) => op.type === 'glyphRun');
    const renderTreeWithDiagnostics = (candidate) => {
      const canvas = document.createElement('canvas');
      canvas.width = candidate.pageWidth;
      canvas.height = candidate.pageHeight;
      document.body.appendChild(canvas);
      canvaskitRenderer.renderPage(candidate, canvas, 1);
      const png = canvas.toDataURL('image/png');
      const textVariantSelectionDiagnostics = canvaskitRenderer.getTextVariantSelectionDiagnostics();
      canvas.remove();
      return { png, textVariantSelectionDiagnostics };
    };
    const renderTree = (candidate) => renderTreeWithDiagnostics(candidate).png;
    const assignFontIdentity = (candidate, suffix, digestValue) => {
      const blobId = `fixture-font-blob-${suffix}`;
      const faceId = `fixture-face-${suffix}`;
      const resourceKey = `font:fixture:${fontBytes.length}:${digestValue}`;
      candidate.resources.fontBlobHashes = [digestValue];
      candidate.resources.fontBlobKeys = [resourceKey];
      candidate.fontResources.blobs[0].id = blobId;
      candidate.fontResources.blobs[0].digest = { algorithm: 'fixture', value: digestValue };
      candidate.fontResources.blobs[0].dataRef = { kind: 'fontBlob', id: resourceKey };
      candidate.fontResources.faces[0].id = faceId;
      candidate.fontResources.faces[0].blobKey = blobId;
      for (const op of candidate.root.ops) {
        if (op.type === 'glyphRun') {
          op.shapeKey.fontInstance.faceKey = faceId;
        }
      }
    };
    const colorGlyphReport = !colorGlyphIds.length || colorGlyphIds[0] === 0
      ? {
          available: false,
          reason: colorTypeface
            ? `invalid color glyph id ${JSON.stringify(colorGlyphIds)}`
            : 'color typeface unavailable',
        }
      : (() => {
          const colorStyle = (color) => ({
            ...style(color),
            fontFamily: 'RHWP Color Smoke',
            fontSize: 72,
          });
          const colorSource = {
            id: 1,
            utf8Range: { start: 0, end: 3 },
            utf16Range: { start: 0, end: 1 },
          };
          const colorTree = {
            pageWidth: 112,
            pageHeight: 100,
            profile: 'screen',
            outputOptions: {
              showParagraphMarks: false,
              showControlCodes: false,
              showTransparentBorders: false,
              clipEnabled: true,
              debugOverlay: false,
            },
            resources: {
              tableId: 1802,
              images: [],
              imageHashes: [],
              imageKeys: [],
              svgFragments: [],
              svgHashes: [],
              svgKeys: [],
              fontBlobs: [colorFontBytes],
              fontBlobHashes: [colorFontDigest],
              fontBlobKeys: [`font:fixture:${colorFontBytes.length}:${colorFontDigest}`],
            },
            fontResources: {
              blobs: [{
                id: 'color-smoke-font-blob',
                source: 'bundled',
                portability: 'portableBlob',
                digest: { algorithm: 'sha256', value: colorFontDigest },
                dataRef: {
                  kind: 'fontBlob',
                  id: `font:fixture:${colorFontBytes.length}:${colorFontDigest}`,
                },
              }],
              faces: [{
                id: 'color-smoke-face',
                blobKey: 'color-smoke-font-blob',
                faceIndex: 0,
                postscriptName: 'RHWPColorSmoke-Regular',
                familyNames: [{ value: 'RHWP Color Smoke' }],
                styleNames: [{ value: 'Regular' }],
              }],
            },
            textSources: [{
              id: 1,
              text: '\uE000',
              utf8Range: { start: 0, end: 3 },
              utf16Range: { start: 0, end: 1 },
              annotations: [],
            }],
            root: {
              kind: 'leaf',
              sourceNodeId: 2,
              bounds: { x: 0, y: 0, width: 112, height: 100 },
              cacheHint: 'none',
              ops: [
                {
                  type: 'pageBackground',
                  bbox: { x: 0, y: 0, width: 112, height: 100 },
                  backgroundColor: '#ffffff',
                  borderWidth: 0,
                },
                {
                  type: 'textRun',
                  bbox: { x: 12, y: 8, width: 88, height: 80 },
                  source: colorSource,
                  variant: {
                    equivalenceGroup: 'color-glyph-smoke-0',
                    variantId: 'textRun',
                    variantKind: 'textRun',
                    partIndex: 0,
                    partCount: 1,
                    isDefaultFallback: true,
                  },
                  text: '\uE000',
                  baseline: 76,
                  rotation: 0,
                  isVertical: false,
                  orientation: 'horizontal',
                  projectionKind: 'verbatim',
                  clusterBasis: 'legacyPosition',
                  style: colorStyle('#00cc00'),
                  paintStyle: colorStyle('#00cc00'),
                  positions: [0, 72],
                  controlMarks: [],
                  tabLeaders: [],
                },
                {
                  type: 'glyphRun',
                  bbox: { x: 12, y: 8, width: 88, height: 80 },
                  source: colorSource,
                  variant: {
                    equivalenceGroup: 'color-glyph-smoke-0',
                    variantId: 'glyphRun',
                    variantKind: 'glyphRun',
                    partIndex: 0,
                    partCount: 1,
                    isDefaultFallback: false,
                    requires: ['fontResources', 'text.glyphRun'],
                    quality: 'exact',
                  },
                  paintStyle: colorStyle('#000000'),
                  shapeKey: {
                    fontInstance: {
                      faceKey: 'color-smoke-face',
                      sizePx: 72,
                      variations: [],
                      syntheticBold: false,
                      syntheticItalic: false,
                    },
                    direction: 'ltr',
                    writingMode: 'horizontal-tb',
                    shapingEngine: 'fixture',
                    fallbackPolicy: 'none',
                  },
                  placement: {
                    runToPage: { a: 1, b: 0, c: 0, d: 1, e: 16, f: 82 },
                    baselineY: 0,
                  },
                  glyphIds: colorGlyphIds,
                  positions: [{ x: 0, y: 0 }],
                  clusters: [{
                    sourceRangeUtf8: { start: 0, end: 3 },
                    sourceRangeUtf16: { start: 0, end: 1 },
                    glyphRange: { start: 0, end: 1 },
                    flags: [],
                  }],
                  direction: 'ltr',
                  writingMode: 'horizontal-tb',
                  orientation: 'horizontal',
                  diagnostics: {
                    quality: 'exact',
                    replayEligibility: 'portable',
                    strictVisualEligible: true,
                    maxOriginDeltaPx: 0,
                    maxAdvanceDeltaPx: 0,
                    maxResidualAfterAdjustmentPx: 0,
                    clusterMismatchCount: 0,
                    missingGlyphCount: 0,
                    usedFallbackFontCount: 0,
                  },
                },
              ],
            },
          };
          const colorStatus = canvaskitRenderer.fontRegistry.glyphRunReplayStatus(
            colorTree.root.ops[2],
            colorTree.fontResources,
          );
          const colorRenderResult = renderTreeWithDiagnostics(colorTree);
          const renderedColorStatus = canvaskitRenderer.fontRegistry.glyphRunReplayStatus(
            colorTree.root.ops[2],
            colorTree.fontResources,
          );
          return {
            available: true,
            glyphIds: colorGlyphIds,
            status: colorStatus,
            renderedStatus: renderedColorStatus,
            png: colorRenderResult.png,
            selectionDiagnostics: colorRenderResult.textVariantSelectionDiagnostics,
          };
        })();

    const status = canvaskitRenderer.fontRegistry.glyphRunReplayStatus(tree.root.ops[2], tree.fontResources);
    const renderResult = renderTreeWithDiagnostics(tree);
    const png = renderResult.png;
    const selectionDiagnostics = renderResult.textVariantSelectionDiagnostics;
    const renderedStatus = canvaskitRenderer.fontRegistry.glyphRunReplayStatus(tree.root.ops[2], tree.fontResources);

    const syntheticStyleReports = {};
    for (const [name, field] of [
      ['bold', 'syntheticBold'],
      ['italic', 'syntheticItalic'],
    ]) {
      const syntheticTree = structuredClone(tree);
      const syntheticOp = glyphOp(syntheticTree);
      syntheticOp.variant.equivalenceGroup = `glyph-fixture-synthetic-${name}`;
      syntheticTree.root.ops[1].variant.equivalenceGroup = `glyph-fixture-synthetic-${name}`;
      syntheticOp.shapeKey.fontInstance[field] = true;
      const syntheticRenderResult = renderTreeWithDiagnostics(syntheticTree);
      syntheticStyleReports[name] = {
        status: canvaskitRenderer.fontRegistry.glyphRunReplayStatus(
          syntheticOp,
          syntheticTree.fontResources,
        ),
        png: syntheticRenderResult.png,
        selectionDiagnostics: syntheticRenderResult.textVariantSelectionDiagnostics,
      };
    }

    const unsupportedEffectTree = structuredClone(tree);
    unsupportedEffectTree.root.ops[2].paintStyle = {
      ...unsupportedEffectTree.root.ops[2].paintStyle,
      underline: 'bottom',
    };
    const unsupportedStatus = canvaskitRenderer.fontRegistry.glyphRunReplayStatus(
      unsupportedEffectTree.root.ops[2],
      unsupportedEffectTree.fontResources,
    );
    const unsupportedRenderResult = renderTreeWithDiagnostics(unsupportedEffectTree);
    const unsupportedPng = unsupportedRenderResult.png;
    const unsupportedSelectionDiagnostics = unsupportedRenderResult.textVariantSelectionDiagnostics;
    const unsupportedEffectReasons = {};
    const unsupportedEffectCases = [
      ['underline', (style) => ({ ...style, underline: 'bottom' })],
      ['strikethrough', (style) => ({ ...style, strikethrough: true })],
      ['emphasis', (style) => ({ ...style, emphasisDot: 1 })],
      ['ratio', (style) => ({ ...style, ratio: 0.8 })],
      ['tabLeaders', (style) => ({
        ...style,
        tabLeaders: [{ startX: 0, endX: 20, fillType: 1 }],
      })],
      ['superscript', (style) => ({ ...style, superscript: true })],
      ['subscript', (style) => ({ ...style, subscript: true })],
      ['shade', (style) => ({ ...style, shadeColor: '#ffff00' })],
    ];
    for (const [name, mutateStyle] of unsupportedEffectCases) {
      const candidate = structuredClone(tree);
      glyphOp(candidate).paintStyle = mutateStyle(glyphOp(candidate).paintStyle);
      unsupportedEffectReasons[name] = canvaskitRenderer.fontRegistry.glyphRunReplayStatus(
        glyphOp(candidate),
        candidate.fontResources,
      ).reason;
    }

    const defaultRatioTree = structuredClone(tree);
    glyphOp(defaultRatioTree).paintStyle.ratio = 0;
    const defaultRatioRenderResult = renderTreeWithDiagnostics(defaultRatioTree);
    const defaultRatioStatus = canvaskitRenderer.fontRegistry.glyphRunReplayStatus(
      glyphOp(defaultRatioTree),
      defaultRatioTree.fontResources,
    );

    const digestMismatchTree = structuredClone(tree);
    assignFontIdentity(
      digestMismatchTree,
      'digest-mismatch',
      'fixture-font-digest-mismatch',
    );
    digestMismatchTree.resources.fontBlobHashes = ['wrong-fixture-font-digest'];
    const digestMismatchStatus = canvaskitRenderer.fontRegistry.glyphRunReplayStatus(
      glyphOp(digestMismatchTree),
      digestMismatchTree.fontResources,
    );
    const digestMismatchPng = renderTree(digestMismatchTree);

    const nonPortableTree = structuredClone(tree);
    assignFontIdentity(nonPortableTree, 'non-portable', 'fixture-font-digest-non-portable');
    glyphOp(nonPortableTree).diagnostics.replayEligibility = 'localDiagnosticOnly';
    nonPortableTree.fontResources.blobs[0].portability = 'systemNameOnly';
    delete nonPortableTree.fontResources.blobs[0].dataRef;
    const nonPortableStatus = canvaskitRenderer.fontRegistry.glyphRunReplayStatus(
      glyphOp(nonPortableTree),
      nonPortableTree.fontResources,
    );
    const nonPortablePng = renderTree(nonPortableTree);

    const outOfRangeTree = structuredClone(tree);
    assignFontIdentity(outOfRangeTree, 'out-of-range', 'fixture-font-digest-out-of-range');
    glyphOp(outOfRangeTree).glyphIds = [0x10000];
    const outOfRangeStatus = canvaskitRenderer.fontRegistry.glyphRunReplayStatus(
      glyphOp(outOfRangeTree),
      outOfRangeTree.fontResources,
    );
    const outOfRangePng = renderTree(outOfRangeTree);

    const nonFiniteBaselineTree = structuredClone(tree);
    glyphOp(nonFiniteBaselineTree).placement.baselineY = Number.NaN;
    const nonFiniteBaselineStatus = canvaskitRenderer.fontRegistry.glyphRunReplayStatus(
      glyphOp(nonFiniteBaselineTree),
      nonFiniteBaselineTree.fontResources,
    );
    const boundedContractStatuses = {};
    for (const [name, mutate] of [
      ['emptyGlyphRun', (op) => { op.glyphIds = []; }],
      ['glyphPositionCountMismatch', (op) => { op.positions = []; }],
      ['glyphAdvanceCountMismatch', (op) => { op.advances = []; }],
      ['positionNotFinite', (op) => { op.positions[0].x = 1e308; }],
      ['advanceNotFinite', (op) => { op.advances = [{ dx: Number.NaN, dy: 0 }]; }],
      ['placementNotFinite', (op) => { op.placement.baselineY = Number.NaN; }],
      ['fontInstanceInvalid', (op) => { op.shapeKey.fontInstance.sizePx = 0; }],
      ['glyphRunMetadataMismatchDirection', (op) => { op.direction = 'rtl'; }],
      ['glyphRunMetadataMismatchWritingMode', (op) => { op.writingMode = 'vertical-rl'; }],
      ['glyphRunTooLarge', (op) => {
        op.glyphIds = Array.from({ length: 4097 }, () => 1);
        op.positions = Array.from({ length: 4097 }, () => ({ x: 0, y: 0 }));
      }],
    ]) {
      const candidate = structuredClone(tree);
      mutate(glyphOp(candidate));
      boundedContractStatuses[name] = canvaskitRenderer.fontRegistry.glyphRunReplayStatus(
        glyphOp(candidate),
        candidate.fontResources,
      );
    }

    const variationTree = structuredClone(tree);
    assignFontIdentity(variationTree, 'variation', 'fixture-font-digest-variation');
    glyphOp(variationTree).shapeKey.fontInstance.variations = [{ tag: 'wght', value: 700 }];
    const variationStatus = canvaskitRenderer.fontRegistry.glyphRunReplayStatus(
      glyphOp(variationTree),
      variationTree.fontResources,
    );
    const variationRenderResult = renderTreeWithDiagnostics(variationTree);
    const variationPng = variationRenderResult.png;
    const variationSelectionDiagnostics = variationRenderResult.textVariantSelectionDiagnostics;
    const variationNegativeStatuses = {};
    for (const [name, variations] of [
      ['unsupportedAxis', [{ tag: 'ZZZZ', value: 1 }]],
      ['outOfRangeAxis', [{ tag: 'wght', value: 9999 }]],
      ['explicitDefaultAxis', [{ tag: 'wght', value: 400 }]],
      ['differentAxisTuple', [{ tag: 'wdth', value: 75 }]],
    ]) {
      const candidate = structuredClone(tree);
      assignFontIdentity(candidate, `variation-${name}`, `fixture-font-digest-variation-${name}`);
      glyphOp(candidate).shapeKey.fontInstance.variations = variations;
      variationNegativeStatuses[name] = canvaskitRenderer.fontRegistry.glyphRunReplayStatus(
        glyphOp(candidate),
        candidate.fontResources,
      );
    }

    const faceIndexTree = structuredClone(tree);
    assignFontIdentity(faceIndexTree, 'face-index', 'fixture-font-digest-face-index');
    faceIndexTree.fontResources.faces[0].faceIndex = 1;
    const faceIndexStatus = canvaskitRenderer.fontRegistry.glyphRunReplayStatus(
      glyphOp(faceIndexTree),
      faceIndexTree.fontResources,
    );
    const faceIndexRenderResult = renderTreeWithDiagnostics(faceIndexTree);
    const faceIndexPng = faceIndexRenderResult.png;
    const faceIndexSelectionDiagnostics = faceIndexRenderResult.textVariantSelectionDiagnostics;

    const exactFaceTree = structuredClone(tree);
    const exactFaceDigest = 'fixture-font-digest-exact-face';
    const exactFaceResourceKey = `font:fixture:${exactFaceFontSource.length}:${exactFaceDigest}`;
    exactFaceTree.resources.tableId = 1803;
    exactFaceTree.resources.fontBlobs = [exactFaceFontSource];
    exactFaceTree.resources.fontBlobHashes = [exactFaceDigest];
    exactFaceTree.resources.fontBlobKeys = [exactFaceResourceKey];
    exactFaceTree.fontResources.blobs[0] = {
      id: 'fixture-font-blob-exact-face',
      source: 'embedded',
      portability: 'portableBlob',
      digest: { algorithm: 'fixture', value: exactFaceDigest },
      dataRef: { kind: 'fontBlob', id: exactFaceResourceKey },
    };
    exactFaceTree.fontResources.faces[0] = {
      id: 'fixture-face-exact-face',
      blobKey: 'fixture-font-blob-exact-face',
      faceIndex: 1,
      postscriptName: 'RHWPExactFaceOne-Regular',
      familyNames: [{ value: 'RHWP Exact Face One' }],
      styleNames: [{ value: 'Regular' }],
    };
    glyphOp(exactFaceTree).shapeKey.fontInstance.faceKey = 'fixture-face-exact-face';
    glyphOp(exactFaceTree).glyphIds = exactFaceGlyphIds;
    const exactFaceStatus = canvaskitRenderer.fontRegistry.glyphRunReplayStatus(
      glyphOp(exactFaceTree),
      exactFaceTree.fontResources,
    );
    const exactFaceRenderResult = renderTreeWithDiagnostics(exactFaceTree);
    const exactFaceRenderedStatus = canvaskitRenderer.fontRegistry.glyphRunReplayStatus(
      glyphOp(exactFaceTree),
      exactFaceTree.fontResources,
    );

    const positionAdjustedTree = structuredClone(tree);
    assignFontIdentity(
      positionAdjustedTree,
      'position-adjusted',
      'fixture-font-digest-position-adjusted',
    );
    glyphOp(positionAdjustedTree).diagnostics.quality = 'positionAdjusted';
    glyphOp(positionAdjustedTree).diagnostics.maxResidualAfterAdjustmentPx = 0.75;
    glyphOp(positionAdjustedTree).variant.quality = 'positionAdjusted';
    const positionAdjustedStatus = canvaskitRenderer.fontRegistry.glyphRunReplayStatus(
      glyphOp(positionAdjustedTree),
      positionAdjustedTree.fontResources,
    );
    const positionAdjustedPng = renderTree(positionAdjustedTree);

    const positionAdjustedStrictTree = structuredClone(tree);
    assignFontIdentity(
      positionAdjustedStrictTree,
      'position-adjusted-strict',
      'fixture-font-digest-position-adjusted-strict',
    );
    glyphOp(positionAdjustedStrictTree).diagnostics.quality = 'positionAdjusted';
    glyphOp(positionAdjustedStrictTree).diagnostics.maxOriginDeltaPx = 0.1;
    glyphOp(positionAdjustedStrictTree).diagnostics.maxAdvanceDeltaPx = 0.1;
    glyphOp(positionAdjustedStrictTree).diagnostics.maxResidualAfterAdjustmentPx = 0.1;
    glyphOp(positionAdjustedStrictTree).variant.quality = 'positionAdjusted';
    const positionAdjustedStrictPng = renderTree(positionAdjustedStrictTree);
    const positionAdjustedStrictStatus = canvaskitRenderer.fontRegistry.glyphRunReplayStatus(
      glyphOp(positionAdjustedStrictTree),
      positionAdjustedStrictTree.fontResources,
    );

    const shadowTree = structuredClone(tree);
    assignFontIdentity(shadowTree, 'shadow', 'fixture-font-digest-shadow');
    glyphOp(shadowTree).paintStyle = {
      ...glyphOp(shadowTree).paintStyle,
      shadowType: 1,
      shadowColor: '#00cc00',
      shadowOffsetX: 8,
      shadowOffsetY: 0,
    };
    const shadowRenderResult = renderTreeWithDiagnostics(shadowTree);
    const shadowPng = shadowRenderResult.png;
    const shadowStatus = canvaskitRenderer.fontRegistry.glyphRunReplayStatus(
      glyphOp(shadowTree),
      shadowTree.fontResources,
    );

    const outlineTree = structuredClone(tree);
    assignFontIdentity(outlineTree, 'outline', 'fixture-font-digest-outline');
    glyphOp(outlineTree).paintStyle = {
      ...glyphOp(outlineTree).paintStyle,
      color: '#0000cc',
      outlineType: 1,
    };
    const outlineRenderResult = renderTreeWithDiagnostics(outlineTree);
    const outlinePng = outlineRenderResult.png;
    const outlineStatus = canvaskitRenderer.fontRegistry.glyphRunReplayStatus(
      glyphOp(outlineTree),
      outlineTree.fontResources,
    );

    const reliefReports = {};
    for (const effect of ['emboss', 'engrave']) {
      const effectTree = structuredClone(tree);
      assignFontIdentity(
        effectTree,
        effect,
        `fixture-font-digest-${effect}`,
      );
      glyphOp(effectTree).paintStyle = {
        ...glyphOp(effectTree).paintStyle,
        [effect]: true,
      };
      const effectRenderResult = renderTreeWithDiagnostics(effectTree);
      reliefReports[effect] = {
        status: canvaskitRenderer.fontRegistry.glyphRunReplayStatus(
          glyphOp(effectTree),
          effectTree.fontResources,
        ),
        png: effectRenderResult.png,
        selectionDiagnostics: effectRenderResult.textVariantSelectionDiagnostics,
      };
    }

    const multiPartTree = structuredClone(tree);
    assignFontIdentity(multiPartTree, 'multipart', 'fixture-font-digest-multipart');
    multiPartTree.textSources[0].text = 'HH';
    multiPartTree.textSources[0].utf8Range = { start: 0, end: 2 };
    multiPartTree.textSources[0].utf16Range = { start: 0, end: 2 };
    multiPartTree.root.ops[1] = {
      ...multiPartTree.root.ops[1],
      text: 'HH',
      positions: [0, 34, 68],
      bbox: { x: 12, y: 8, width: 84, height: 48 },
      source: {
        ...multiPartTree.root.ops[1].source,
        utf8Range: { start: 0, end: 2 },
        utf16Range: { start: 0, end: 2 },
      },
    };
    const firstGlyphPart = {
      ...multiPartTree.root.ops[2],
      bbox: { x: 12, y: 8, width: 84, height: 48 },
      source: {
        ...multiPartTree.root.ops[2].source,
        utf8Range: { start: 0, end: 1 },
        utf16Range: { start: 0, end: 1 },
      },
      variant: {
        ...multiPartTree.root.ops[2].variant,
        partIndex: 0,
        partCount: 2,
      },
      placement: {
        ...multiPartTree.root.ops[2].placement,
        runToPage: { a: 1, b: 0, c: 0, d: 1, e: 12, f: 50 },
      },
    };
    const secondGlyphPart = structuredClone(firstGlyphPart);
    secondGlyphPart.source = {
      ...secondGlyphPart.source,
      utf8Range: { start: 1, end: 2 },
      utf16Range: { start: 1, end: 2 },
    };
    secondGlyphPart.variant = {
      ...secondGlyphPart.variant,
      partIndex: 1,
      partCount: 2,
    };
    secondGlyphPart.placement = {
      ...secondGlyphPart.placement,
      runToPage: { a: 1, b: 0, c: 0, d: 1, e: 44, f: 50 },
    };
    multiPartTree.root.ops = [
      multiPartTree.root.ops[0],
      multiPartTree.root.ops[1],
      firstGlyphPart,
      secondGlyphPart,
    ];
    const multiPartPng = renderTree(multiPartTree);
    const multiPartStatuses = multiPartTree.root.ops
      .filter((op) => op.type === 'glyphRun')
      .map((op) => canvaskitRenderer.fontRegistry.glyphRunReplayStatus(op, multiPartTree.fontResources));

    const duplicatePartTree = structuredClone(multiPartTree);
    for (const op of duplicatePartTree.root.ops) {
      if (op.type === 'glyphRun') {
        op.variant.partIndex = 0;
        op.variant.partCount = 1;
      }
    }
    const duplicatePartPng = renderTree(duplicatePartTree);

    const fallbackSplitTree = structuredClone(multiPartTree);
    fallbackSplitTree.fontResources.faces.push({
      ...fallbackSplitTree.fontResources.faces[0],
      id: 'fixture-face-multipart-alt',
      blobKey: fallbackSplitTree.fontResources.faces[0].blobKey,
      postscriptName: 'FixtureFaceMultipartAlt',
    });
    const fallbackSplitGlyphs = fallbackSplitTree.root.ops.filter((op) => op.type === 'glyphRun');
    fallbackSplitGlyphs[1].shapeKey.fontInstance.faceKey = 'fixture-face-multipart-alt';
    fallbackSplitGlyphs[1].clusters[0].flags = ['fallbackBoundary'];
    const fallbackSplitStatuses = fallbackSplitGlyphs
      .map((op) => canvaskitRenderer.fontRegistry.glyphRunReplayStatus(op, fallbackSplitTree.fontResources));
    const fallbackSplitPng = renderTree(fallbackSplitTree);

    const bidiSplitTree = structuredClone(multiPartTree);
    const bidiGlyphs = bidiSplitTree.root.ops.filter((op) => op.type === 'glyphRun');
    bidiGlyphs[0].source.utf8Range = { start: 1, end: 2 };
    bidiGlyphs[0].source.utf16Range = { start: 1, end: 2 };
    bidiGlyphs[0].clusters[0].sourceRangeUtf8 = { start: 1, end: 2 };
    bidiGlyphs[0].clusters[0].sourceRangeUtf16 = { start: 1, end: 2 };
    bidiGlyphs[0].direction = 'rtl';
    bidiGlyphs[0].bidiLevel = 1;
    bidiGlyphs[0].shapeKey.direction = 'rtl';
    bidiGlyphs[1].source.utf8Range = { start: 0, end: 1 };
    bidiGlyphs[1].source.utf16Range = { start: 0, end: 1 };
    bidiGlyphs[1].clusters[0].sourceRangeUtf8 = { start: 0, end: 1 };
    bidiGlyphs[1].clusters[0].sourceRangeUtf16 = { start: 0, end: 1 };
    bidiGlyphs[1].direction = 'ltr';
    bidiGlyphs[1].bidiLevel = 0;
    bidiGlyphs[1].shapeKey.direction = 'ltr';
    const bidiSplitStatuses = bidiGlyphs
      .map((op) => canvaskitRenderer.fontRegistry.glyphRunReplayStatus(op, bidiSplitTree.fontResources));
    const bidiSplitPng = renderTree(bidiSplitTree);

    const verticalUprightTree = structuredClone(multiPartTree);
    verticalUprightTree.pageHeight = 112;
    verticalUprightTree.root.bounds = { x: 0, y: 0, width: 96, height: 112 };
    verticalUprightTree.root.ops[1] = {
      ...verticalUprightTree.root.ops[1],
      bbox: { x: 10, y: 8, width: 52, height: 96 },
      isVertical: true,
      orientation: 'vertical-upright',
    };
    const verticalUprightGlyphs = verticalUprightTree.root.ops.filter((op) => op.type === 'glyphRun');
    for (const [index, op] of verticalUprightGlyphs.entries()) {
      op.bbox = { x: 10, y: 8, width: 52, height: 96 };
      op.shapeKey.writingMode = 'vertical-rl';
      op.writingMode = 'vertical-rl';
      op.orientation = 'vertical-upright';
      op.placement.runToPage = { a: 1, b: 0, c: 0, d: 1, e: 42, f: 38 + index * 34 };
    }
    const verticalUprightStatuses = verticalUprightGlyphs
      .map((op) => canvaskitRenderer.fontRegistry.glyphRunReplayStatus(op, verticalUprightTree.fontResources));
    const verticalUprightPng = renderTree(verticalUprightTree);

    const verticalSidewaysTree = structuredClone(tree);
    assignFontIdentity(verticalSidewaysTree, 'vertical-sideways', 'fixture-font-digest-vertical-sideways');
    glyphOp(verticalSidewaysTree).shapeKey.writingMode = 'vertical-rl';
    glyphOp(verticalSidewaysTree).writingMode = 'vertical-rl';
    glyphOp(verticalSidewaysTree).orientation = 'vertical-sideways';
    glyphOp(verticalSidewaysTree).placement.runToPage = { a: 0, b: 1, c: -1, d: 0, e: 62, f: 18 };
    verticalSidewaysTree.root.ops[1].isVertical = true;
    verticalSidewaysTree.root.ops[1].orientation = 'vertical-sideways';
    const verticalSidewaysPng = renderTree(verticalSidewaysTree);
    const verticalSidewaysStatus = canvaskitRenderer.fontRegistry.glyphRunReplayStatus(
      glyphOp(verticalSidewaysTree),
      verticalSidewaysTree.fontResources,
    );

    return {
      status,
      renderedStatus,
      png,
      syntheticStyleReports,
      unsupportedStatus,
      unsupportedEffectReasons,
      defaultRatioStatus,
      defaultRatioSelectionDiagnostics: defaultRatioRenderResult.textVariantSelectionDiagnostics,
      unsupportedPng,
      digestMismatchStatus,
      digestMismatchPng,
      nonPortableStatus,
      nonPortablePng,
      outOfRangeStatus,
      outOfRangePng,
      nonFiniteBaselineStatus,
      boundedContractStatuses,
      variationStatus,
      variationNegativeStatuses,
      variationSelectionDiagnostics,
      variationPng,
      faceIndexStatus,
      faceIndexSelectionDiagnostics,
      faceIndexPng,
      exactFaceStatus,
      exactFaceRenderedStatus,
      exactFaceSelectionDiagnostics: exactFaceRenderResult.textVariantSelectionDiagnostics,
      exactFacePng: exactFaceRenderResult.png,
      positionAdjustedStatus,
      positionAdjustedPng,
      positionAdjustedStrictStatus,
      positionAdjustedStrictPng,
      shadowStatus,
      shadowPng,
      shadowSelectionDiagnostics: shadowRenderResult.textVariantSelectionDiagnostics,
      outlineStatus,
      outlinePng,
      outlineSelectionDiagnostics: outlineRenderResult.textVariantSelectionDiagnostics,
      reliefReports,
      selectionDiagnostics,
      unsupportedSelectionDiagnostics,
      multiPartStatuses,
      multiPartPng,
      duplicatePartPng,
      fallbackSplitStatuses,
      fallbackSplitPng,
      bidiSplitStatuses,
      bidiSplitPng,
      verticalUprightStatuses,
      verticalUprightPng,
      verticalSidewaysStatus,
      verticalSidewaysPng,
      colorGlyphReport,
    };
  }, {
    fontBytes: glyphRunFontBytes,
    colorFontBytes: colorGlyphFontBytes,
    colorFontDigest: colorGlyphFontDigest,
    exactFaceFontBytes,
  });

  assert(
    !portableGlyphRunProbe.error,
    portableGlyphRunProbe.error || 'CanvasKit portable GlyphRun probe available',
  );
  assert(
    portableGlyphRunProbe.status?.replayable === false
      && portableGlyphRunProbe.status?.reason === 'fontBlobNotVerified',
    `CanvasKit GlyphRun status stays unverified before render=${JSON.stringify(portableGlyphRunProbe.status)}`,
  );
  const glyphBlackPixels = countPixels(
    portableGlyphRunProbe.png,
    (pixel) => pixel.alpha > 32 && pixel.red < 80 && pixel.green < 80 && pixel.blue < 80,
  );
  const glyphRedPixels = countPixels(
    portableGlyphRunProbe.png,
    (pixel) => pixel.alpha > 32 && pixel.red > 160 && pixel.green < 120 && pixel.blue < 120,
  );
  assert(
    glyphBlackPixels > 20,
    `CanvasKit GlyphRun drawGlyphs produced black pixels=${glyphBlackPixels}`,
  );
  assert(
    glyphRedPixels < 5,
    `CanvasKit GlyphRun variant suppressed TextRun fallback red pixels=${glyphRedPixels}`,
  );
  const selectedReport = portableGlyphRunProbe.selectionDiagnostics?.find(
    (report) => report.equivalenceGroup === 'glyph-fixture-0',
  );
  assert(
    selectedReport?.selectedVariantId === 'glyphRun'
      && selectedReport?.selectedVariantKind === 'glyphRun'
      && selectedReport?.selectedReason === 'glyphRunStrictEligible'
      && selectedReport?.backend === 'canvaskit'
      && selectedReport?.renderProfile === 'screen'
      && selectedReport?.partsExpected === 1
      && selectedReport?.partsReplayed === 1
      && selectedReport?.fontVerification?.digestMatched === true
      && selectedReport?.fontVerification?.exactFaceInstantiated === true
      && selectedReport?.fontVerification?.effectSupported === true,
    `CanvasKit records selected GlyphRun variant=${JSON.stringify(selectedReport)}`,
  );
  for (const name of ['bold', 'italic']) {
    const syntheticReport = portableGlyphRunProbe.syntheticStyleReports?.[name];
    const syntheticSelected = syntheticReport?.selectionDiagnostics?.find(
      (report) => report.equivalenceGroup === `glyph-fixture-synthetic-${name}`,
    );
    const fallbackPixels = syntheticReport?.png
      ? countPixels(
          syntheticReport.png,
          (pixel) => pixel.alpha > 32 && pixel.red > 160 && pixel.green < 120 && pixel.blue < 120,
        )
      : Number.POSITIVE_INFINITY;
    assert(
      syntheticReport?.status?.replayable === true
        && syntheticSelected?.selectedVariantId === 'glyphRun'
        && syntheticSelected?.selectedReason === 'glyphRunStrictEligible',
      `CanvasKit synthetic ${name} GlyphRun remains strict replayable=${JSON.stringify(syntheticReport)}`,
    );
    assert(
      syntheticReport?.png !== portableGlyphRunProbe.png && fallbackPixels < 5,
      `CanvasKit synthetic ${name} changes glyph ink and suppresses TextRun fallback pixels=${fallbackPixels}`,
    );
  }
  const colorGlyphReport = portableGlyphRunProbe.colorGlyphReport;
  const colorGlyphRedPixels = colorGlyphReport?.png
    ? countPixels(
        colorGlyphReport.png,
        (pixel) => pixel.alpha > 32 && pixel.red > 150 && pixel.green < 120 && pixel.blue < 120,
      )
    : 0;
  const colorGlyphBluePixels = colorGlyphReport?.png
    ? countPixels(
        colorGlyphReport.png,
        (pixel) => pixel.alpha > 32 && pixel.blue > 150 && pixel.red < 120 && pixel.green < 120,
      )
    : 0;
  const colorGlyphFallbackPixels = colorGlyphReport?.png
    ? countPixels(
        colorGlyphReport.png,
        (pixel) => pixel.alpha > 32 && pixel.green > 150 && pixel.red < 120 && pixel.blue < 120,
      )
    : 0;
  const colorGlyphSelectedReport = colorGlyphReport?.selectionDiagnostics?.find(
    (report) => report.equivalenceGroup === 'color-glyph-smoke-0',
  );
  const colorGlyphSmokeSummary = {
    available: colorGlyphReport?.available === true,
    reason: colorGlyphReport?.reason,
    statusReason: colorGlyphReport?.status?.reason,
    renderedReplayable: colorGlyphReport?.renderedStatus?.replayable,
    renderedReason: colorGlyphReport?.renderedStatus?.reason,
    renderedDigestMatched: colorGlyphReport?.renderedStatus?.report?.digestMatched,
    renderedExactFaceInstantiated: colorGlyphReport?.renderedStatus?.report?.exactFaceInstantiated,
    renderedEffectSupported: colorGlyphReport?.renderedStatus?.report?.effectSupported,
    glyphIds: colorGlyphReport?.glyphIds,
    selectedVariantId: colorGlyphSelectedReport?.selectedVariantId,
    selectedReason: colorGlyphSelectedReport?.selectedReason,
    partsExpected: colorGlyphSelectedReport?.partsExpected,
    partsReplayed: colorGlyphSelectedReport?.partsReplayed,
    rejectedVariantCount: colorGlyphSelectedReport?.rejectedVariants?.length,
    digestMatched: colorGlyphSelectedReport?.fontVerification?.digestMatched,
    exactFaceInstantiated: colorGlyphSelectedReport?.fontVerification?.exactFaceInstantiated,
    replayEligible: colorGlyphSelectedReport?.fontVerification?.replayEligible,
    effectSupported: colorGlyphSelectedReport?.fontVerification?.effectSupported,
    redPixels: colorGlyphRedPixels,
    bluePixels: colorGlyphBluePixels,
    fallbackPixels: colorGlyphFallbackPixels,
  };
  console.log(`[gate] CanvasKit color glyph smoke ${JSON.stringify(colorGlyphSmokeSummary)}`);
  assert(
    colorGlyphReport?.available === true,
    `CanvasKit color glyph smoke fixture available=${JSON.stringify(colorGlyphSmokeSummary)}`,
  );
  assert(
    colorGlyphReport?.status?.replayable === false
      && colorGlyphReport?.status?.reason === 'fontBlobNotVerified',
    `CanvasKit color glyph status stays unverified before render=${JSON.stringify(colorGlyphReport?.status)}`,
  );
  assert(
    colorGlyphReport?.renderedStatus?.replayable === true
      && colorGlyphReport?.renderedStatus?.report?.digestMatched === true
      && colorGlyphReport?.renderedStatus?.report?.exactFaceInstantiated === true
      && colorGlyphReport?.renderedStatus?.report?.effectSupported === true,
    `CanvasKit color glyph verified status=${JSON.stringify(colorGlyphReport?.renderedStatus)}`,
  );
  assert(
    colorGlyphSelectedReport?.selectedVariantId === 'glyphRun'
      && colorGlyphSelectedReport?.selectedReason === 'glyphRunStrictEligible'
      && colorGlyphSelectedReport?.partsExpected === 1
      && colorGlyphSelectedReport?.partsReplayed === 1
      && (colorGlyphSelectedReport?.rejectedVariants?.length ?? 0) === 0
      && colorGlyphSelectedReport?.fontVerification?.digestMatched === true
      && colorGlyphSelectedReport?.fontVerification?.exactFaceInstantiated === true
      && colorGlyphSelectedReport?.fontVerification?.replayEligible === true
      && colorGlyphSelectedReport?.fontVerification?.effectSupported === true,
    `CanvasKit color glyph selection report=${JSON.stringify(colorGlyphSelectedReport)}`,
  );
  const colorGlyphRunPart = colorGlyphSelectedReport?.parts?.find(
    (part) => part.variantId === 'glyphRun' && part.variantKind === 'glyphRun',
  );
  assert(
    colorGlyphRunPart?.replayable === true
      && colorGlyphRunPart?.fontVerification?.replayEligible === true
      && colorGlyphRunPart?.fontVerification?.effectSupported === true,
    `CanvasKit color glyph part replay report=${JSON.stringify(colorGlyphRunPart)}`,
  );
  assert(
    colorGlyphRedPixels > 20 && colorGlyphBluePixels > 20,
    `CanvasKit COLRv0 smoke expected colored pixels=${JSON.stringify(colorGlyphSmokeSummary)}`,
  );
  assert(
    colorGlyphFallbackPixels < 5,
    `CanvasKit COLRv0 smoke suppressed fallback=${JSON.stringify(colorGlyphSmokeSummary)}`,
  );
  assert(
    portableGlyphRunProbe.renderedStatus?.report?.digestMatched === true
      && portableGlyphRunProbe.renderedStatus?.report?.exactFaceInstantiated === true
      && portableGlyphRunProbe.renderedStatus?.report?.effectSupported === true,
    `CanvasKit replay report records verified face/effect gates=${JSON.stringify(portableGlyphRunProbe.renderedStatus?.report)}`,
  );
  assert(
    portableGlyphRunProbe.unsupportedStatus?.replayable === false
      && portableGlyphRunProbe.unsupportedStatus?.reason === 'glyphRunUnderlineUnsupported',
    `CanvasKit GlyphRun rejects unsupported text effects=${JSON.stringify(portableGlyphRunProbe.unsupportedStatus)}`,
  );
  const unsupportedSelectionReport = portableGlyphRunProbe.unsupportedSelectionDiagnostics?.find(
    (report) => report.equivalenceGroup === 'glyph-fixture-0',
  );
  assert(
    unsupportedSelectionReport?.selectedVariantId === 'textRun'
      && unsupportedSelectionReport?.selectedVariantKind === 'textRun'
      && unsupportedSelectionReport?.selectedReason === 'defaultTextRunFallback'
      && unsupportedSelectionReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphRun'
          && variant.reasons.includes('glyphRunUnderlineUnsupported'),
      ),
    `CanvasKit records GlyphRun fallback reason=${JSON.stringify(unsupportedSelectionReport)}`,
  );
  assert(
    portableGlyphRunProbe.unsupportedStatus?.report?.effectSupported === false,
    `CanvasKit replay report records unsupported effect gate=${JSON.stringify(portableGlyphRunProbe.unsupportedStatus?.report)}`,
  );
  assert(
    JSON.stringify(portableGlyphRunProbe.unsupportedEffectReasons) === JSON.stringify({
      underline: 'glyphRunUnderlineUnsupported',
      strikethrough: 'glyphRunStrikethroughUnsupported',
      emphasis: 'glyphRunEmphasisUnsupported',
      ratio: 'glyphRunRatioUnsupported',
      tabLeaders: 'glyphRunTabLeadersUnsupported',
      superscript: 'glyphRunSuperscriptUnsupported',
      subscript: 'glyphRunSubscriptUnsupported',
      shade: 'glyphRunShadeUnsupported',
    }),
    `CanvasKit GlyphRun reports precise unsupported effect reasons=${JSON.stringify(portableGlyphRunProbe.unsupportedEffectReasons)}`,
  );
  assert(
    portableGlyphRunProbe.nonFiniteBaselineStatus?.replayable === false
      && portableGlyphRunProbe.nonFiniteBaselineStatus?.reason === 'placementNotFinite',
    `CanvasKit GlyphRun rejects non-finite baseline placement=${JSON.stringify(
      portableGlyphRunProbe.nonFiniteBaselineStatus,
    )}`,
  );
  const boundedContractReasons = {
    emptyGlyphRun: 'emptyGlyphRun',
    glyphPositionCountMismatch: 'glyphPositionCountMismatch',
    glyphAdvanceCountMismatch: 'glyphAdvanceCountMismatch',
    positionNotFinite: 'positionNotFinite',
    advanceNotFinite: 'advanceNotFinite',
    placementNotFinite: 'placementNotFinite',
    fontInstanceInvalid: 'fontInstanceInvalid',
    glyphRunMetadataMismatchDirection: 'glyphRunMetadataMismatch',
    glyphRunMetadataMismatchWritingMode: 'glyphRunMetadataMismatch',
    glyphRunTooLarge: 'glyphRunTooLarge',
  };
  assert(
    Object.entries(boundedContractReasons).every(([name, reason]) => {
      const status = portableGlyphRunProbe.boundedContractStatuses?.[name];
      return status?.replayable === false && status?.reason === reason;
    }),
    `CanvasKit GlyphRun applies the bounded strict payload contract=${JSON.stringify(
      portableGlyphRunProbe.boundedContractStatuses,
    )}`,
  );
  const defaultRatioSelectionReport = portableGlyphRunProbe.defaultRatioSelectionDiagnostics?.find(
    (report) => report.equivalenceGroup === 'glyph-fixture-0',
  );
  assert(
    portableGlyphRunProbe.defaultRatioStatus?.replayable === true
      && defaultRatioSelectionReport?.selectedVariantId === 'glyphRun'
      && defaultRatioSelectionReport?.selectedReason === 'glyphRunStrictEligible',
    `CanvasKit GlyphRun normalizes non-positive default ratio=${JSON.stringify({
      status: portableGlyphRunProbe.defaultRatioStatus,
      selection: defaultRatioSelectionReport,
    })}`,
  );
  const fallbackRedPixels = countPixels(
    portableGlyphRunProbe.unsupportedPng,
    (pixel) => pixel.alpha > 32 && pixel.red > 160 && pixel.green < 120 && pixel.blue < 120,
  );
  const fallbackBlackPixels = countPixels(
    portableGlyphRunProbe.unsupportedPng,
    (pixel) => pixel.alpha > 32 && pixel.red < 80 && pixel.green < 80 && pixel.blue < 80,
  );
  assert(
    fallbackRedPixels > 20,
    `CanvasKit unsupported GlyphRun effect keeps TextRun fallback red pixels=${fallbackRedPixels}`,
  );
  assert(
    fallbackBlackPixels < 5,
    `CanvasKit unsupported GlyphRun effect suppresses black glyph path pixels=${fallbackBlackPixels}`,
  );
  assert(
    portableGlyphRunProbe.digestMismatchStatus?.replayable === false
      && portableGlyphRunProbe.digestMismatchStatus?.reason === 'fontBlobNotVerified',
    `CanvasKit GlyphRun rejects digest-mismatched font blobs=${JSON.stringify(portableGlyphRunProbe.digestMismatchStatus)}`,
  );
  const digestMismatchRedPixels = countPixels(
    portableGlyphRunProbe.digestMismatchPng,
    (pixel) => pixel.alpha > 32 && pixel.red > 160 && pixel.green < 120 && pixel.blue < 120,
  );
  const digestMismatchBlackPixels = countPixels(
    portableGlyphRunProbe.digestMismatchPng,
    (pixel) => pixel.alpha > 32 && pixel.red < 80 && pixel.green < 80 && pixel.blue < 80,
  );
  assert(
    digestMismatchRedPixels > 20 && digestMismatchBlackPixels < 5,
    `CanvasKit digest mismatch keeps TextRun fallback red=${digestMismatchRedPixels}, black=${digestMismatchBlackPixels}`,
  );
  assert(
    portableGlyphRunProbe.nonPortableStatus?.replayable === false
      && portableGlyphRunProbe.nonPortableStatus?.reason === 'nonPortableGlyphRun',
    `CanvasKit GlyphRun rejects non-portable font resources=${JSON.stringify(portableGlyphRunProbe.nonPortableStatus)}`,
  );
  const nonPortableRedPixels = countPixels(
    portableGlyphRunProbe.nonPortablePng,
    (pixel) => pixel.alpha > 32 && pixel.red > 160 && pixel.green < 120 && pixel.blue < 120,
  );
  const nonPortableBlackPixels = countPixels(
    portableGlyphRunProbe.nonPortablePng,
    (pixel) => pixel.alpha > 32 && pixel.red < 80 && pixel.green < 80 && pixel.blue < 80,
  );
  assert(
    nonPortableRedPixels > 20 && nonPortableBlackPixels < 5,
    `CanvasKit non-portable font keeps TextRun fallback red=${nonPortableRedPixels}, black=${nonPortableBlackPixels}`,
  );
  assert(
    portableGlyphRunProbe.outOfRangeStatus?.replayable === false
      && portableGlyphRunProbe.outOfRangeStatus?.reason === 'glyphIdOutOfRange',
    `CanvasKit GlyphRun rejects backend-incompatible glyph ids=${JSON.stringify(portableGlyphRunProbe.outOfRangeStatus)}`,
  );
  const outOfRangeRedPixels = countPixels(
    portableGlyphRunProbe.outOfRangePng,
    (pixel) => pixel.alpha > 32 && pixel.red > 160 && pixel.green < 120 && pixel.blue < 120,
  );
  const outOfRangeBlackPixels = countPixels(
    portableGlyphRunProbe.outOfRangePng,
    (pixel) => pixel.alpha > 32 && pixel.red < 80 && pixel.green < 80 && pixel.blue < 80,
  );
  assert(
    outOfRangeRedPixels > 20 && outOfRangeBlackPixels < 5,
    `CanvasKit out-of-range glyph id keeps TextRun fallback red=${outOfRangeRedPixels}, black=${outOfRangeBlackPixels}`,
  );
  assert(
    portableGlyphRunProbe.variationStatus?.replayable === false
      && portableGlyphRunProbe.variationStatus?.reason === 'variationUnsupported',
    `CanvasKit GlyphRun rejects unsupported variation instances=${JSON.stringify(portableGlyphRunProbe.variationStatus)}`,
  );
  assert(
    Object.entries(portableGlyphRunProbe.variationNegativeStatuses ?? {}).every(
      ([, status]) => status?.replayable === false && status?.reason === 'variationUnsupported',
    ),
    `CanvasKit rejects every explicit variation tuple until exact construction is proven=${JSON.stringify(portableGlyphRunProbe.variationNegativeStatuses)}`,
  );
  const variationSelectionReport = portableGlyphRunProbe.variationSelectionDiagnostics?.find(
    (report) => report.equivalenceGroup === 'glyph-fixture-0',
  );
  const variationTextPart = variationSelectionReport?.parts?.find(
    (part) => part.variantId === 'textRun' && part.variantKind === 'textRun',
  );
  const variationGlyphPart = variationSelectionReport?.parts?.find(
    (part) => part.variantId === 'glyphRun' && part.variantKind === 'glyphRun',
  );
  assert(
    variationSelectionReport?.selectedVariantId === 'textRun'
      && variationSelectionReport?.selectedReason === 'defaultTextRunFallback'
      && variationSelectionReport?.partsExpected === 1
      && variationSelectionReport?.partsReplayed === 1
      && variationSelectionReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphRun'
          && variant.reasons.includes('variationUnsupported'),
      )
      && variationSelectionReport?.fontVerification?.variationSupported === false
      && variationSelectionReport?.fontVerification?.reason === 'variationUnsupported',
    `CanvasKit variation fallback records VariantSelectionReport=${JSON.stringify(variationSelectionReport)}`,
  );
  assert(
    variationTextPart?.replayable === true
      && variationGlyphPart?.replayable === false
      && variationGlyphPart?.reason === 'variationUnsupported',
    `CanvasKit variation fallback records per-part replay status=${JSON.stringify(variationSelectionReport?.parts)}`,
  );
  const variationRedPixels = countPixels(
    portableGlyphRunProbe.variationPng,
    (pixel) => pixel.alpha > 32 && pixel.red > 160 && pixel.green < 120 && pixel.blue < 120,
  );
  const variationBlackPixels = countPixels(
    portableGlyphRunProbe.variationPng,
    (pixel) => pixel.alpha > 32 && pixel.red < 80 && pixel.green < 80 && pixel.blue < 80,
  );
  assert(
    variationRedPixels > 20 && variationBlackPixels < 5,
    `CanvasKit unsupported font variation keeps TextRun fallback red=${variationRedPixels}, black=${variationBlackPixels}`,
  );
  assert(
    portableGlyphRunProbe.faceIndexStatus?.replayable === false
      && portableGlyphRunProbe.faceIndexStatus?.reason === 'fontBlobNotVerified',
    `CanvasKit invalid non-zero face index remains resource-gated before render=${JSON.stringify(portableGlyphRunProbe.faceIndexStatus)}`,
  );
  const faceIndexSelectionReport = portableGlyphRunProbe.faceIndexSelectionDiagnostics?.find(
    (report) => report.equivalenceGroup === 'glyph-fixture-0',
  );
  const faceIndexTextPart = faceIndexSelectionReport?.parts?.find(
    (part) => part.variantId === 'textRun' && part.variantKind === 'textRun',
  );
  const faceIndexGlyphPart = faceIndexSelectionReport?.parts?.find(
    (part) => part.variantId === 'glyphRun' && part.variantKind === 'glyphRun',
  );
  assert(
    faceIndexSelectionReport?.selectedVariantId === 'textRun'
      && faceIndexSelectionReport?.selectedReason === 'defaultTextRunFallback'
      && faceIndexSelectionReport?.partsExpected === 1
      && faceIndexSelectionReport?.partsReplayed === 1
      && faceIndexSelectionReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphRun'
          && variant.reasons.includes('faceIndexUnsupported'),
      )
      && faceIndexSelectionReport?.fontVerification?.faceIndexSupported === false
      && faceIndexSelectionReport?.fontVerification?.exactFaceInstantiated === false
      && faceIndexSelectionReport?.fontVerification?.reason === 'faceIndexUnsupported',
    `CanvasKit faceIndex fallback records VariantSelectionReport=${JSON.stringify(faceIndexSelectionReport)}`,
  );
  assert(
    faceIndexTextPart?.replayable === true
      && faceIndexGlyphPart?.replayable === false
      && faceIndexGlyphPart?.reason === 'faceIndexUnsupported',
    `CanvasKit faceIndex fallback records per-part replay status=${JSON.stringify(faceIndexSelectionReport?.parts)}`,
  );
  const faceIndexRedPixels = countPixels(
    portableGlyphRunProbe.faceIndexPng,
    (pixel) => pixel.alpha > 32 && pixel.red > 160 && pixel.green < 120 && pixel.blue < 120,
  );
  const faceIndexBlackPixels = countPixels(
    portableGlyphRunProbe.faceIndexPng,
    (pixel) => pixel.alpha > 32 && pixel.red < 80 && pixel.green < 80 && pixel.blue < 80,
  );
  assert(
    faceIndexRedPixels > 20 && faceIndexBlackPixels < 5,
    `CanvasKit unsupported font face index keeps TextRun fallback red=${faceIndexRedPixels}, black=${faceIndexBlackPixels}`,
  );
  assert(
    portableGlyphRunProbe.exactFaceStatus?.replayable === false
      && portableGlyphRunProbe.exactFaceStatus?.reason === 'fontBlobNotVerified',
    `CanvasKit exact TTC face remains gated before resource registration=${JSON.stringify(portableGlyphRunProbe.exactFaceStatus)}`,
  );
  assert(
    portableGlyphRunProbe.exactFaceRenderedStatus?.replayable === true
      && portableGlyphRunProbe.exactFaceRenderedStatus?.report?.exactFaceInstantiated === true
      && portableGlyphRunProbe.exactFaceRenderedStatus?.report?.faceIndexSupported === true,
    `CanvasKit exact TTC face is selected after bounded normalization=${JSON.stringify(portableGlyphRunProbe.exactFaceRenderedStatus)}`,
  );
  const exactFaceSelectionReport = portableGlyphRunProbe.exactFaceSelectionDiagnostics?.find(
    (report) => report.equivalenceGroup === 'glyph-fixture-0',
  );
  assert(
    exactFaceSelectionReport?.selectedVariantId === 'glyphRun'
      && exactFaceSelectionReport?.selectedReason === 'glyphRunStrictEligible',
    `CanvasKit exact TTC face suppresses TextRun fallback=${JSON.stringify(exactFaceSelectionReport)}`,
  );
  const exactFaceRedPixels = countPixels(
    portableGlyphRunProbe.exactFacePng,
    (pixel) => pixel.alpha > 32 && pixel.red > 160 && pixel.green < 120 && pixel.blue < 120,
  );
  const exactFaceBlackPixels = countPixels(
    portableGlyphRunProbe.exactFacePng,
    (pixel) => pixel.alpha > 32 && pixel.red < 80 && pixel.green < 80 && pixel.blue < 80,
  );
  assert(
    exactFaceBlackPixels > 20 && exactFaceRedPixels < 5,
    `CanvasKit exact TTC face draws strict glyph ink black=${exactFaceBlackPixels}, red=${exactFaceRedPixels}`,
  );
  assert(
    portableGlyphRunProbe.positionAdjustedStatus?.replayable === false
      && portableGlyphRunProbe.positionAdjustedStatus?.reason === 'positionAdjustedResidualTooHigh',
    `CanvasKit GlyphRun rejects PositionAdjusted residuals over strict tolerance=${JSON.stringify(portableGlyphRunProbe.positionAdjustedStatus)}`,
  );
  const positionAdjustedRedPixels = countPixels(
    portableGlyphRunProbe.positionAdjustedPng,
    (pixel) => pixel.alpha > 32 && pixel.red > 160 && pixel.green < 120 && pixel.blue < 120,
  );
  const positionAdjustedBlackPixels = countPixels(
    portableGlyphRunProbe.positionAdjustedPng,
    (pixel) => pixel.alpha > 32 && pixel.red < 80 && pixel.green < 80 && pixel.blue < 80,
  );
  assert(
    positionAdjustedRedPixels > 20 && positionAdjustedBlackPixels < 5,
    `CanvasKit over-tolerance PositionAdjusted run keeps TextRun fallback red=${positionAdjustedRedPixels}, black=${positionAdjustedBlackPixels}`,
  );
  assert(
    portableGlyphRunProbe.positionAdjustedStrictStatus?.replayable === true,
    `CanvasKit GlyphRun accepts PositionAdjusted residuals within strict tolerance=${JSON.stringify(portableGlyphRunProbe.positionAdjustedStrictStatus)}`,
  );
  const positionAdjustedStrictRedPixels = countPixels(
    portableGlyphRunProbe.positionAdjustedStrictPng,
    (pixel) => pixel.alpha > 32 && pixel.red > 160 && pixel.green < 120 && pixel.blue < 120,
  );
  const positionAdjustedStrictBlackPixels = countPixels(
    portableGlyphRunProbe.positionAdjustedStrictPng,
    (pixel) => pixel.alpha > 32 && pixel.red < 80 && pixel.green < 80 && pixel.blue < 80,
  );
  assert(
    positionAdjustedStrictBlackPixels > 20 && positionAdjustedStrictRedPixels < 5,
    `CanvasKit in-tolerance PositionAdjusted run selects GlyphRun black=${positionAdjustedStrictBlackPixels}, red=${positionAdjustedStrictRedPixels}`,
  );
  assert(
    portableGlyphRunProbe.shadowStatus?.replayable === true,
    `CanvasKit GlyphRun accepts supported offset shadow replay=${JSON.stringify(portableGlyphRunProbe.shadowStatus)}`,
  );
  const shadowSelectionReport = portableGlyphRunProbe.shadowSelectionDiagnostics?.find(
    (report) => report.equivalenceGroup === 'glyph-fixture-0',
  );
  assert(
    shadowSelectionReport?.selectedVariantId === 'glyphRun'
      && shadowSelectionReport?.selectedReason === 'glyphRunStrictEligible'
      && shadowSelectionReport?.fontVerification?.effectSupported === true,
    `CanvasKit GlyphRun shadow records effect-supported selection=${JSON.stringify(shadowSelectionReport)}`,
  );
  const shadowRedPixels = countPixels(
    portableGlyphRunProbe.shadowPng,
    (pixel) => pixel.alpha > 32 && pixel.red > 160 && pixel.green < 120 && pixel.blue < 120,
  );
  const shadowBlackPixels = countPixels(
    portableGlyphRunProbe.shadowPng,
    (pixel) => pixel.alpha > 32 && pixel.red < 80 && pixel.green < 80 && pixel.blue < 80,
  );
  const shadowGreenPixels = countPixels(
    portableGlyphRunProbe.shadowPng,
    (pixel) => pixel.alpha > 32 && pixel.red < 120 && pixel.green > 120 && pixel.blue < 120,
  );
  assert(
    shadowBlackPixels > 20 && shadowGreenPixels > 10 && shadowRedPixels < 5,
    `CanvasKit GlyphRun shadow paints fill+shadow and suppresses fallback black=${shadowBlackPixels}, green=${shadowGreenPixels}, red=${shadowRedPixels}`,
  );
  assert(
    portableGlyphRunProbe.outlineStatus?.replayable === true,
    `CanvasKit GlyphRun accepts supported outline replay=${JSON.stringify(portableGlyphRunProbe.outlineStatus)}`,
  );
  const outlineSelectionReport = portableGlyphRunProbe.outlineSelectionDiagnostics?.find(
    (report) => report.equivalenceGroup === 'glyph-fixture-0',
  );
  assert(
    outlineSelectionReport?.selectedVariantId === 'glyphRun'
      && outlineSelectionReport?.selectedReason === 'glyphRunStrictEligible'
      && outlineSelectionReport?.fontVerification?.effectSupported === true,
    `CanvasKit GlyphRun outline records effect-supported selection=${JSON.stringify(outlineSelectionReport)}`,
  );
  const outlineRedPixels = countPixels(
    portableGlyphRunProbe.outlinePng,
    (pixel) => pixel.alpha > 32 && pixel.red > 160 && pixel.green < 120 && pixel.blue < 120,
  );
  const outlineBluePixels = countPixels(
    portableGlyphRunProbe.outlinePng,
    (pixel) => pixel.alpha > 32 && pixel.red < 120 && pixel.green < 120 && pixel.blue > 120,
  );
  assert(
    outlineBluePixels > 20 && outlineRedPixels < 5,
    `CanvasKit GlyphRun outline paints selected variant and suppresses fallback blue=${outlineBluePixels}, red=${outlineRedPixels}`,
  );
  for (const effect of ['emboss', 'engrave']) {
    const report = portableGlyphRunProbe.reliefReports?.[effect];
    const selectionReport = report?.selectionDiagnostics?.find(
      (candidate) => candidate.equivalenceGroup === 'glyph-fixture-0',
    );
    const reliefGrayPixels = report?.png
      ? countPixels(
          report.png,
          (pixel) => pixel.alpha > 32
            && Math.abs(pixel.red - pixel.green) < 8
            && Math.abs(pixel.green - pixel.blue) < 8
            && pixel.red >= 80
            && pixel.red <= 190,
        )
      : 0;
    const reliefRedPixels = report?.png
      ? countPixels(
          report.png,
          (pixel) => pixel.alpha > 32 && pixel.red > 160 && pixel.green < 120 && pixel.blue < 120,
        )
      : 0;
    assert(
      report?.status?.replayable === true
        && report?.status?.report?.effectSupported === true
        && selectionReport?.selectedVariantId === 'glyphRun'
        && selectionReport?.selectedReason === 'glyphRunStrictEligible'
        && selectionReport?.fontVerification?.effectSupported === true,
      `CanvasKit GlyphRun ${effect} selects the effect-supported glyph variant=${JSON.stringify({
        status: report?.status,
        selection: selectionReport,
      })}`,
    );
    assert(
      reliefGrayPixels > 5 && reliefRedPixels < 5,
      `CanvasKit GlyphRun ${effect} paints relief passes and suppresses fallback gray=${reliefGrayPixels}, red=${reliefRedPixels}`,
    );
  }
  assert(
    portableGlyphRunProbe.reliefReports?.emboss?.png
      !== portableGlyphRunProbe.reliefReports?.engrave?.png,
    'CanvasKit GlyphRun emboss and engrave preserve opposite relief directions',
  );
  assert(
    portableGlyphRunProbe.multiPartStatuses?.length === 2
      && portableGlyphRunProbe.multiPartStatuses.every((status) => status.replayable === true),
    `CanvasKit multi-part GlyphRun variant set becomes replayable=${JSON.stringify(portableGlyphRunProbe.multiPartStatuses)}`,
  );
  const multiPartBlackPixels = countPixels(
    portableGlyphRunProbe.multiPartPng,
    (pixel) => pixel.alpha > 32 && pixel.red < 80 && pixel.green < 80 && pixel.blue < 80,
  );
  const multiPartRedPixels = countPixels(
    portableGlyphRunProbe.multiPartPng,
    (pixel) => pixel.alpha > 32 && pixel.red > 160 && pixel.green < 120 && pixel.blue < 120,
  );
  assert(
    multiPartBlackPixels > glyphBlackPixels * 1.5 && multiPartRedPixels < 5,
    `CanvasKit multi-part GlyphRun paints all selected parts and suppresses fallback black=${multiPartBlackPixels}, red=${multiPartRedPixels}`,
  );
  const duplicatePartRedPixels = countPixels(
    portableGlyphRunProbe.duplicatePartPng,
    (pixel) => pixel.alpha > 32 && pixel.red > 160 && pixel.green < 120 && pixel.blue < 120,
  );
  const duplicatePartBlackPixels = countPixels(
    portableGlyphRunProbe.duplicatePartPng,
    (pixel) => pixel.alpha > 32 && pixel.red < 80 && pixel.green < 80 && pixel.blue < 80,
  );
  assert(
    duplicatePartRedPixels > 20 && duplicatePartBlackPixels < 5,
    `CanvasKit duplicate GlyphRun variant part keeps TextRun fallback red=${duplicatePartRedPixels}, black=${duplicatePartBlackPixels}`,
  );
  assert(
    portableGlyphRunProbe.fallbackSplitStatuses?.length === 2
      && portableGlyphRunProbe.fallbackSplitStatuses.every((status) => status.replayable === true),
    `CanvasKit synthetic fallback-font GlyphRun variant set becomes replayable=${JSON.stringify(portableGlyphRunProbe.fallbackSplitStatuses)}`,
  );
  const fallbackSplitBlackPixels = countPixels(
    portableGlyphRunProbe.fallbackSplitPng,
    (pixel) => pixel.alpha > 32 && pixel.red < 80 && pixel.green < 80 && pixel.blue < 80,
  );
  const fallbackSplitRedPixels = countPixels(
    portableGlyphRunProbe.fallbackSplitPng,
    (pixel) => pixel.alpha > 32 && pixel.red > 160 && pixel.green < 120 && pixel.blue < 120,
  );
  assert(
    fallbackSplitBlackPixels > glyphBlackPixels * 1.5 && fallbackSplitRedPixels < 5,
    `CanvasKit synthetic fallback-font GlyphRun paints all selected parts black=${fallbackSplitBlackPixels}, red=${fallbackSplitRedPixels}`,
  );
  assert(
    portableGlyphRunProbe.bidiSplitStatuses?.length === 2
      && portableGlyphRunProbe.bidiSplitStatuses.every((status) => status.replayable === true),
    `CanvasKit bidi-split GlyphRun variant parts are replayable=${JSON.stringify(portableGlyphRunProbe.bidiSplitStatuses)}`,
  );
  const bidiSplitBlackPixels = countPixels(
    portableGlyphRunProbe.bidiSplitPng,
    (pixel) => pixel.alpha > 32 && pixel.red < 80 && pixel.green < 80 && pixel.blue < 80,
  );
  const bidiSplitRedPixels = countPixels(
    portableGlyphRunProbe.bidiSplitPng,
    (pixel) => pixel.alpha > 32 && pixel.red > 160 && pixel.green < 120 && pixel.blue < 120,
  );
  assert(
    bidiSplitBlackPixels > glyphBlackPixels * 1.5 && bidiSplitRedPixels < 5,
    `CanvasKit bidi-split GlyphRun paints all visual-order parts and suppresses fallback black=${bidiSplitBlackPixels}, red=${bidiSplitRedPixels}`,
  );
  assert(
    portableGlyphRunProbe.verticalUprightStatuses?.length === 2
      && portableGlyphRunProbe.verticalUprightStatuses.every((status) => status.replayable === true),
    `CanvasKit vertical-upright GlyphRun parts are replayable=${JSON.stringify(portableGlyphRunProbe.verticalUprightStatuses)}`,
  );
  const verticalUprightBlackPixels = countPixels(
    portableGlyphRunProbe.verticalUprightPng,
    (pixel) => pixel.alpha > 32 && pixel.red < 80 && pixel.green < 80 && pixel.blue < 80,
  );
  const verticalUprightRedPixels = countPixels(
    portableGlyphRunProbe.verticalUprightPng,
    (pixel) => pixel.alpha > 32 && pixel.red > 160 && pixel.green < 120 && pixel.blue < 120,
  );
  assert(
    verticalUprightBlackPixels > glyphBlackPixels * 1.5 && verticalUprightRedPixels < 5,
    `CanvasKit vertical-upright GlyphRun paints stacked parts and suppresses fallback black=${verticalUprightBlackPixels}, red=${verticalUprightRedPixels}`,
  );
  assert(
    portableGlyphRunProbe.verticalSidewaysStatus?.replayable === true,
    `CanvasKit vertical-sideways GlyphRun is replayable=${JSON.stringify(portableGlyphRunProbe.verticalSidewaysStatus)}`,
  );
  const verticalSidewaysBlackPixels = countPixels(
    portableGlyphRunProbe.verticalSidewaysPng,
    (pixel) => pixel.alpha > 32 && pixel.red < 80 && pixel.green < 80 && pixel.blue < 80,
  );
  const verticalSidewaysRedPixels = countPixels(
    portableGlyphRunProbe.verticalSidewaysPng,
    (pixel) => pixel.alpha > 32 && pixel.red > 160 && pixel.green < 120 && pixel.blue < 120,
  );
  assert(
    verticalSidewaysBlackPixels > 20 && verticalSidewaysRedPixels < 5,
    `CanvasKit vertical-sideways GlyphRun uses explicit transform and suppresses fallback black=${verticalSidewaysBlackPixels}, red=${verticalSidewaysRedPixels}`,
  );

  setTestCase('canvas2d-glyph-outline-strict-profile');
  const canvas2dGlyphOutlineProbe = await page.evaluate(() => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const renderer = pageRenderer?.canvas2dRenderer;
    if (!renderer) {
      return { error: 'Canvas2D renderer unavailable' };
    }

    const style = {
      fontFamily: 'Arial',
      fontSize: 20,
      color: '#dd0000',
      bold: false,
      italic: false,
      ratio: 1,
      underline: 'none',
      underlineShape: 0,
      strikethrough: false,
      strikeShape: 0,
      outlineType: 0,
      shadowType: 0,
      shadowColor: '#000000',
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      emboss: false,
      engrave: false,
      emphasisDot: 0,
      underlineColor: '#dd0000',
      strikeColor: '#dd0000',
      shadeColor: '#ffffff',
    };
    const textVariant = {
      equivalenceGroup: 'outline-fixture-0',
      variantId: 'textRun',
      variantKind: 'textRun',
      partIndex: 0,
      partCount: 1,
      isDefaultFallback: true,
      quality: 'exact',
    };
    const outlineVariant = {
      equivalenceGroup: 'outline-fixture-0',
      variantId: 'glyphOutline',
      variantKind: 'glyphOutline',
      partIndex: 0,
      partCount: 1,
      isDefaultFallback: false,
      requires: ['text.outlineGlyph'],
      quality: 'exact',
      anchorOpId: 'op-text-outline',
      localPaintOrder: 0,
    };
    const outlinePath = {
      glyphId: 42,
      sourceRangeUtf8: { start: 0, end: 1 },
      glyphRange: { start: 0, end: 1 },
      fillRule: 'evenodd',
      commands: [
        { type: 'moveTo', x: 0, y: 0 },
        { type: 'lineTo', x: 18, y: 0 },
        { type: 'lineTo', x: 18, y: 18 },
        { type: 'lineTo', x: 0, y: 18 },
        { type: 'closePath' },
      ],
    };
    const makeOutlineOp = (outlineStyle = style, paths = [outlinePath], overrides = {}) => ({
      id: 'op-outline-root',
      type: 'glyphOutline',
      bbox: { x: 8, y: 8, width: 24, height: 24 },
      source: { id: 17, utf8Range: { start: 0, end: 1 }, utf16Range: { start: 0, end: 1 } },
      variant: outlineVariant,
      paintStyle: { ...outlineStyle, color: '#000000' },
      placement: {
        runToPage: { a: 1, b: 0, c: 0, d: 1, e: 8, f: 8 },
        baselineY: 0,
      },
      paths,
      diagnostics: {
        quality: 'exact',
        replayEligibility: 'portable',
        strictVisualEligible: true,
        maxOriginDeltaPx: 0,
        maxAdvanceDeltaPx: 0,
        maxResidualAfterAdjustmentPx: 0,
        clusterMismatchCount: 0,
        missingGlyphCount: 0,
        usedFallbackFontCount: 0,
      },
      ...overrides,
    });
    const makeTextRunOp = (id = 'op-text-outline') => ({
      id,
      type: 'textRun',
      bbox: { x: 8, y: 26, width: 40, height: 28 },
      source: { id: 17, utf8Range: { start: 0, end: 1 }, utf16Range: { start: 0, end: 1 } },
      variant: textVariant,
      text: 'A',
      style,
      paintStyle: style,
      positions: [0, 22],
      baseline: 48,
      rotation: 0,
      isVertical: false,
      orientation: 'horizontal',
    });
    const makeTree = (
      outlineStyle = style,
      paths = [outlinePath],
      sidecar = false,
      outlineOverrides = {},
      variantOps,
    ) => {
      const outlineOp = makeOutlineOp(outlineStyle, paths, outlineOverrides);
      return ({
      pageWidth: 80,
      pageHeight: 70,
      profile: 'screen',
      resources: { tableId: 501, images: [], svgFragments: [] },
      textSources: [{
        id: 17,
        text: 'A',
        utf8Range: { start: 0, end: 1 },
        utf16Range: { start: 0, end: 1 },
        annotations: [],
      }],
      root: {
        kind: 'leaf',
        sourceNodeId: 1700,
        bounds: { x: 0, y: 0, width: 80, height: 70 },
        cacheHint: 'none',
        ops: [
          makeTextRunOp(),
          ...(sidecar ? [] : [outlineOp]),
        ],
      },
      ...(sidecar || variantOps
        ? { variantOps: variantOps ?? [{ ...outlineOp, id: 'op-outline-sidecar' }] }
        : {}),
      });
    };
    const makeV2TextTree = () => ({
      schemaVersion: 2,
      schemaMinorVersion: 0,
      pageWidth: 80,
      pageHeight: 70,
      profile: 'screen',
      textV2: {
        profile: 'compatibility',
        canonicalOp: 'text',
        fallbackPolicy: 'required',
        strictVisualFallbackFree: false,
        paintOrderSlots: 'required',
      },
      resources: { tableId: 502, images: [], svgFragments: [] },
      textSources: [{
        id: 17,
        text: 'A',
        utf8Range: { start: 0, end: 1 },
        utf16Range: { start: 0, end: 1 },
        annotations: [],
      }],
      root: {
        kind: 'leaf',
        sourceNodeId: 1701,
        bounds: { x: 0, y: 0, width: 80, height: 70 },
        cacheHint: 'none',
        ops: [{
          id: 'op-text-v2-outline',
          type: 'text',
          bbox: { x: 8, y: 8, width: 44, height: 46 },
          paintOrderSlotId: 'slot-v2-outline',
          source: { id: 17, utf8Range: { start: 0, end: 1 }, utf16Range: { start: 0, end: 1 } },
          selectionPolicy: 'exclusiveVariantSet',
          defaultVariantId: 'textRun',
          fallbackPolicy: 'required',
          variants: [
            {
              variantId: 'textRun',
              kind: 'textRun',
              quality: 'exact',
              parts: [{ payload: makeTextRunOp() }],
            },
            {
              variantId: 'glyphOutline',
              kind: 'glyphOutline',
              requiredFeatures: ['text.outlineGlyph', 'text.glyphOutline.monochromeFill'],
              quality: 'exact',
              parts: [{ payload: makeOutlineOp(style, [outlinePath], { id: 'op-outline-v2-payload' }) }],
            },
          ],
        }],
      },
    });
    const makeV2GlyphRunOp = (orientation = 'horizontal') => ({
      id: 'op-glyph-run-v2-payload',
      type: 'glyphRun',
      bbox: { x: 8, y: 8, width: 24, height: 24 },
      source: { id: 17, utf8Range: { start: 0, end: 1 }, utf16Range: { start: 0, end: 1 } },
      variant: {
        equivalenceGroup: 'op-text-v2-outline',
        variantId: 'glyphRun',
        variantKind: 'glyphRun',
        partIndex: 0,
        partCount: 1,
        isDefaultFallback: false,
        quality: 'exact',
      },
      paintStyle: { ...style, color: '#000000' },
      shapeKey: {
        fontInstance: {
          faceKey: 'fixture-face',
          sizePx: 20,
          variations: [],
          syntheticBold: false,
          syntheticItalic: false,
        },
        direction: 'ltr',
        writingMode: 'horizontal-tb',
        shapingEngine: 'fixture',
        fallbackPolicy: 'none',
      },
      placement: {
        runToPage: { a: 1, b: 0, c: 0, d: 1, e: 8, f: 26 },
        baselineY: 0,
      },
      glyphIds: [42],
      positions: [{ x: 0, y: 0 }],
      advances: [{ dx: 18, dy: 0 }],
      clusters: [{
        sourceRangeUtf8: { start: 0, end: 1 },
        sourceRangeUtf16: { start: 0, end: 1 },
        glyphRange: { start: 0, end: 1 },
        flags: [],
      }],
      direction: 'ltr',
      writingMode: 'horizontal-tb',
      orientation,
      diagnostics: {
        quality: 'exact',
        replayEligibility: 'portable',
        strictVisualEligible: true,
        maxOriginDeltaPx: 0,
        maxAdvanceDeltaPx: 0,
        maxResidualAfterAdjustmentPx: 0,
        clusterMismatchCount: 0,
        missingGlyphCount: 0,
        usedFallbackFontCount: 0,
      },
    });
    const makeInvalidV2TextTree = () => {
      const tree = makeV2TextTree();
      const textOp = tree.root.ops[0];
      textOp.variants = textOp.variants.filter((variant) => variant.variantId !== 'textRun');
      return tree;
    };
    const clonePayloadEnvelope = (envelope) => JSON.parse(JSON.stringify(envelope));
    const makeReservedV2ColorPayloadTree = () => {
      const tree = makeV2TextTree();
      tree.requiredFeatures = [
        'text.glyphOutline.colorLayers',
        'text.glyphOutline.colorLayers.colrV0',
      ];
      const outlineVariant = tree.root.ops[0].variants.find(
        (variant) => variant.variantId === 'glyphOutline',
      );
      outlineVariant.requiredFeatures = [
        'text.outlineGlyph',
        'text.glyphOutline.colorLayers',
        'text.glyphOutline.colorLayers.colrV0',
      ];
      outlineVariant.parts[0].payload = {
        ...outlineVariant.parts[0].payload,
        ...clonePayloadEnvelope(reservedPayloadEnvelopes.colorLayers),
      };
      return tree;
    };
    const makeReservedV2ColorPayloadColrV1Tree = () => {
      const tree = makeV2TextTree();
      tree.requiredFeatures = [
        'text.glyphOutline.colorLayers',
        'text.glyphOutline.colorLayers.colrV1',
      ];
      const outlineVariant = tree.root.ops[0].variants.find(
        (variant) => variant.variantId === 'glyphOutline',
      );
      outlineVariant.requiredFeatures = [
        'text.outlineGlyph',
        'text.glyphOutline.colorLayers',
        'text.glyphOutline.colorLayers.colrV1',
      ];
      outlineVariant.parts[0].payload = {
        ...outlineVariant.parts[0].payload,
        ...clonePayloadEnvelope(colrV1PayloadEnvelope),
      };
      return tree;
    };
    const makeReservedV2OutlinePayloadTree = (payloadKind, feature, envelope, featureEnabled = false) => {
      const tree = makeV2TextTree();
      if (featureEnabled) {
        tree.requiredFeatures = [feature];
      }
      const outlineVariant = tree.root.ops[0].variants.find(
        (variant) => variant.variantId === 'glyphOutline',
      );
      outlineVariant.requiredFeatures = ['text.outlineGlyph', feature];
      outlineVariant.parts[0].payload = {
        ...outlineVariant.parts[0].payload,
        ...(envelope === undefined ? { payloadKind } : clonePayloadEnvelope(envelope)),
      };
      return tree;
    };
    const makeV2CrossScopeTree = (featureEnabled = false) => {
      const tree = makeV2TextTree();
      if (featureEnabled) {
        tree.requiredFeatures = ['text.crossScopeVariants'];
      }
      const outlineVariant = tree.root.ops[0].variants.find(
        (variant) => variant.variantId === 'glyphOutline',
      );
      outlineVariant.parts[0].scopeRef = 'alternate-text-scope';
      return tree;
    };
    const makeV2MixedPerGlyphTree = (featureEnabled = false) => {
      const tree = makeV2TextTree();
      if (featureEnabled) {
        tree.requiredFeatures = ['text.vertical.mixedPerGlyph'];
      }
      tree.root.ops[0].variants.push({
        variantId: 'glyphRunMixed',
        kind: 'glyphRun',
        requiredFeatures: ['fontResources', 'text.glyphRun'],
        quality: 'exact',
        parts: [{ payload: makeV2GlyphRunOp('mixedPerGlyph') }],
      });
      return tree;
    };
    const makeV2FallbackFreeTree = (featureEnabled = false) => {
      const tree = makeV2TextTree();
      if (featureEnabled) {
        tree.requiredFeatures = ['text.strictVisualFallbackFree'];
      }
      tree.textV2 = {
        ...tree.textV2,
        profile: 'strictVisual',
        fallbackPolicy: 'none',
        strictVisualFallbackFree: true,
      };
      const textOp = tree.root.ops[0];
      textOp.defaultVariantId = 'glyphOutline';
      textOp.fallbackPolicy = 'none';
      return tree;
    };
    const makeV2FallbackFreeCompatibilityProfileTree = () => {
      const tree = makeV2FallbackFreeTree(true);
      tree.textV2.profile = 'compatibility';
      return tree;
    };
    const makeV2FallbackFreeDisabledFlagTree = () => {
      const tree = makeV2FallbackFreeTree(true);
      tree.textV2.strictVisualFallbackFree = false;
      return tree;
    };
    const makeV2FallbackFreeTextOnlyTree = () => {
      const tree = makeV2FallbackFreeTree(true);
      const textOp = tree.root.ops[0];
      textOp.defaultVariantId = 'textRun';
      textOp.variants = textOp.variants.filter((variant) => variant.variantId === 'textRun');
      return tree;
    };
    const strokePayload = {
      payloadKind: 'monochromeFillStroke',
      stroke: {
        widthPx: 1,
        color: '#000000',
        join: 'miter',
        cap: 'butt',
        miterLimit: 4,
        paintOrder: 'fillThenStroke',
      },
    };
    const unsupportedStrokePayload = {
      payloadKind: 'monochromeFillStroke',
      stroke: {
        ...strokePayload.stroke,
        widthPx: 0,
      },
    };
    const unsupportedStrokeJoinCapPayload = {
      payloadKind: 'monochromeFillStroke',
      stroke: {
        ...strokePayload.stroke,
        join: 'round',
        cap: 'square',
      },
    };
    const missingStrokePayload = {
      payloadKind: 'monochromeFillStroke',
    };
    const reservedPayloadEnvelopes = {
      colorLayers: {
        payloadKind: 'colorLayers',
        colorLayers: {
          colorFormat: 'colrV0',
          sourceFontRef: {
            faceKey: 'fixture-face',
            glyphId: 42,
            paletteIndex: 0,
            colorFormat: 'colrV0',
          },
          paletteRef: { id: 'fixture-palette', index: 0, cpalDigest: 'sha256:fixture-cpal' },
          sourceRangeUtf8: { start: 0, end: 1 },
          glyphRange: { start: 0, end: 1 },
          layers: [{
            layerIndex: 0,
            glyphId: 42,
            glyphRange: { start: 0, end: 1 },
            sourceRangeUtf8: { start: 0, end: 1 },
            sourceFontRef: {
              faceKey: 'fixture-face',
              glyphId: 42,
              paletteIndex: 0,
              colorFormat: 'colrV0',
            },
            pathIndex: 0,
            commands: [
              { type: 'moveTo', x: 0, y: 0 },
              { type: 'lineTo', x: 10, y: 0 },
              { type: 'lineTo', x: 10, y: 10 },
              { type: 'closePath' },
            ],
            fill: { colorSpace: 'srgb', rgba: [0, 0, 1, 1] },
            fillRule: 'nonzero',
            paletteIndex: 0,
            color: '#0000ff',
            opacity: 1,
            transformToRun: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
          }],
        },
      },
      bitmapGlyph: {
        payloadKind: 'bitmapGlyph',
        bitmapGlyph: {
          imageResourceId: 'bitmap-glyph-fixture',
          sourceRangeUtf8: { start: 0, end: 1 },
          glyphRange: { start: 0, end: 1 },
          placement: {
            origin: { x: 0, y: 0 },
            advance: { dx: 10, dy: 0 },
            runToPage: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
            baselineY: 0,
          },
          transformToRun: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
          strikePpem: [16, 16],
          strikeSelection: 'producerResolved',
          colorSpace: 'srgb',
          alphaMode: 'premultiplied',
          scalingPolicy: 'explicitTransform',
          filtering: 'linear',
        },
      },
      svgGlyph: {
        payloadKind: 'svgGlyph',
        svgGlyph: {
          vectorResourceId: 'svg-glyph-fixture',
          sourceRangeUtf8: { start: 0, end: 1 },
          glyphRange: { start: 0, end: 1 },
          placement: {
            origin: { x: 0, y: 0 },
            advance: { dx: 10, dy: 0 },
            runToPage: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
            baselineY: 0,
          },
          transformToRun: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
          viewBox: { x: 0, y: 0, width: 10, height: 10 },
          intrinsicSize: { width: 10, height: 10 },
          securityMode: 'staticSanitized',
          scriptAllowed: false,
          animationAllowed: false,
          externalResourcesAllowed: false,
          interactivityAllowed: false,
        },
      },
    };
    const colrV1PayloadEnvelope = {
      ...reservedPayloadEnvelopes.colorLayers,
      colorLayers: {
        ...reservedPayloadEnvelopes.colorLayers.colorLayers,
        colorFormat: 'colrV1',
        sourceFontRef: {
          ...reservedPayloadEnvelopes.colorLayers.colorLayers.sourceFontRef,
          colorFormat: 'colrV1',
        },
        layers: [],
        paintGraph: {
          rootNodeId: 1,
          nodes: [
            {
              nodeId: 0,
              kind: 'solidPath',
              solidPath: {
                commands: [
                  { type: 'moveTo', x: 0, y: 0 },
                  { type: 'lineTo', x: 10, y: 0 },
                  { type: 'lineTo', x: 10, y: 10 },
                  { type: 'closePath' },
                ],
                fill: { colorSpace: 'srgb', rgba: [0, 1, 0, 1] },
                fillRule: 'nonzero',
                sourceGlyphId: 42,
                paletteIndex: 0,
              },
              sourceRangeUtf8: { start: 0, end: 1 },
              glyphRange: { start: 0, end: 1 },
              sourceFontRef: {
                faceKey: 'fixture-face',
                glyphId: 42,
                paletteIndex: 0,
                colorFormat: 'colrV1',
              },
            },
            {
              nodeId: 1,
              kind: 'transform',
              transform: {
                childNodeId: 0,
                transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
              },
            },
          ],
        },
      },
    };
    const colrV1GradientPayloadEnvelope = {
      ...colrV1PayloadEnvelope,
      colorLayers: {
        ...colrV1PayloadEnvelope.colorLayers,
        paintGraph: {
          rootNodeId: 1,
          nodes: [
            {
              nodeId: 1,
              kind: 'transform',
              transform: {
                childNodeId: 2,
                transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
              },
            },
            {
              nodeId: 2,
              kind: 'linearGradientPath',
              linearGradientPath: {
                commands: [
                  { type: 'moveTo', x: 0, y: 0 },
                  { type: 'lineTo', x: 10, y: 0 },
                  { type: 'lineTo', x: 10, y: 10 },
                  { type: 'lineTo', x: 0, y: 10 },
                  { type: 'closePath' },
                ],
                gradient: {
                  x0: 0,
                  y0: 0,
                  x1: 10,
                  y1: 0,
                  stops: [
                    { offset: 0, color: { colorSpace: 'srgb', rgba: [1, 0, 0, 1] } },
                    { offset: 1, color: { colorSpace: 'srgb', rgba: [0, 0, 1, 1] } },
                  ],
                },
                fillRule: 'nonzero',
                sourceGlyphId: 42,
                paletteIndex: 0,
              },
              sourceRangeUtf8: { start: 0, end: 1 },
              glyphRange: { start: 0, end: 1 },
              sourceFontRef: {
                faceKey: 'fixture-face',
                glyphId: 42,
                paletteIndex: 0,
                colorFormat: 'colrV1',
              },
            },
          ],
        },
      },
    };
    const render = (tree, strict) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.setStrictGlyphOutlineReplay(strict);
      renderer.renderPage(tree, canvas, 1);
      const png = canvas.toDataURL('image/png');
      const diagnostics = renderer.getTextVariantSelectionDiagnostics();
      const textV2Validation = renderer.getTextV2ValidationDiagnostics();
      canvas.remove();
      return { png, diagnostics, textV2Validation };
    };
    try {
      const fallback = render(makeTree(), false);
      const strict = render(makeTree(), true);
      const strictSidecar = render(makeTree(style, [outlinePath], true), true);
      const duplicateSidecar = render(makeTree(
        style,
        [outlinePath],
        false,
        {},
        [{ ...makeOutlineOp(style, [outlinePath]), id: 'op-outline-duplicate-sidecar' }],
      ), true);
      const invalidAnchorSidecar = render(makeTree(
        style,
        [outlinePath],
        true,
        {},
        [{
          ...makeOutlineOp(style, [outlinePath]),
          id: 'op-outline-invalid-anchor',
          anchorOpId: 'missing-text-anchor',
          variant: { ...outlineVariant, anchorOpId: 'missing-text-anchor' },
        }],
      ), true);
      const invalidPathMetadataSidecar = render(
        makeTree(style, [{ ...outlinePath, glyphRange: { start: 2, end: 1 } }], true),
        true,
      );
      const invalidPathCommandSidecar = render(
        makeTree(
          style,
          [{
            ...outlinePath,
            commands: outlinePath.commands.map((command, index) => (
              index === 1 ? { ...command, x: Number.POSITIVE_INFINITY } : command
            )),
          }],
          true,
        ),
        true,
      );
      const strokePayloadSidecar = render(makeTree(style, [outlinePath], true, strokePayload), true);
      const unsupportedStrokePayloadSidecar = render(
        makeTree(style, [outlinePath], true, unsupportedStrokePayload),
        true,
      );
      const unsupportedStrokeJoinCapSidecar = render(
        makeTree(style, [outlinePath], true, unsupportedStrokeJoinCapPayload),
        true,
      );
      const missingStrokePayloadSidecar = render(
        makeTree(style, [outlinePath], true, missingStrokePayload),
        true,
      );
      const colorPayloadSidecar = render(
        makeTree(style, [], true, {
          ...reservedPayloadEnvelopes.colorLayers,
          variant: {
            ...outlineVariant,
            requires: [
              'text.outlineGlyph',
              'text.glyphOutline.colorLayers',
              'text.glyphOutline.colorLayers.colrV0',
            ],
          },
        }),
        true,
      );
      const colorV1PayloadSidecar = render(
        makeTree(style, [], true, {
          ...colrV1PayloadEnvelope,
          variant: {
            ...outlineVariant,
            requires: [
              'text.outlineGlyph',
              'text.glyphOutline.colorLayers',
              'text.glyphOutline.colorLayers.colrV1',
            ],
          },
        }),
        true,
      );
      const colorV1GradientPayloadSidecar = render(
        makeTree(style, [], true, {
          ...colrV1GradientPayloadEnvelope,
          variant: {
            ...outlineVariant,
            requires: [
              'text.outlineGlyph',
              'text.glyphOutline.colorLayers',
              'text.glyphOutline.colorLayers.colrV1',
            ],
          },
        }),
        true,
      );
      const reservedColorPayloadSidecar = render(
        makeTree(style, [outlinePath], true, reservedPayloadEnvelopes.colorLayers),
        true,
      );
      const reservedBitmapPayloadSidecar = render(
        makeTree(style, [outlinePath], true, reservedPayloadEnvelopes.bitmapGlyph),
        true,
      );
      const reservedSvgPayloadSidecar = render(
        makeTree(style, [outlinePath], true, reservedPayloadEnvelopes.svgGlyph),
        true,
      );
      const v2Fallback = render(makeV2TextTree(), false);
      const v2Strict = render(makeV2TextTree(), true);
      const invalidV2MissingFallback = render(makeInvalidV2TextTree(), false);
      const invalidV2PathMetadataTree = makeV2TextTree();
      const invalidV2OutlinePayload = invalidV2PathMetadataTree.root.ops[0].variants
        .find((variant) => variant.variantId === 'glyphOutline')
        .parts[0]
        .payload;
      invalidV2OutlinePayload.paths = invalidV2OutlinePayload.paths.map((path, index) => (
        index === 0
          ? { ...path, sourceRangeUtf8: { start: 2, end: 1 } }
          : path
      ));
      const invalidV2PathMetadata = render(invalidV2PathMetadataTree, false);
      const invalidV2PathCommandTree = makeV2TextTree();
      const invalidV2PathCommandPayload = invalidV2PathCommandTree.root.ops[0].variants
        .find((variant) => variant.variantId === 'glyphOutline')
        .parts[0]
        .payload;
      invalidV2PathCommandPayload.paths = invalidV2PathCommandPayload.paths.map((path, index) => (
        index === 0
          ? {
              ...path,
              commands: path.commands.map((command, commandIndex) => (
                commandIndex === 1 ? { ...command, x: Number.POSITIVE_INFINITY } : command
              )),
            }
          : path
      ));
      const invalidV2PathCommand = render(invalidV2PathCommandTree, false);
      const invalidV2CrossScope = render(makeV2CrossScopeTree(), false);
      const allowedV2CrossScope = render(makeV2CrossScopeTree(true), false);
      const invalidV2MixedPerGlyph = render(makeV2MixedPerGlyphTree(), false);
      const allowedV2MixedPerGlyph = render(makeV2MixedPerGlyphTree(true), false);
      const invalidV2FallbackFree = render(makeV2FallbackFreeTree(), false);
      const allowedV2FallbackFree = render(makeV2FallbackFreeTree(true), false);
      const invalidV2FallbackFreeCompatibilityProfile = render(
        makeV2FallbackFreeCompatibilityProfileTree(),
        false,
      );
      const invalidV2FallbackFreeDisabledFlag = render(
        makeV2FallbackFreeDisabledFlagTree(),
        false,
      );
      const invalidV2FallbackFreeTextOnly = render(makeV2FallbackFreeTextOnlyTree(), false);
      const missingStrokeV2Payload = render(
        makeReservedV2OutlinePayloadTree(
          'monochromeFillStroke',
          'text.glyphOutline.monochromeFillStroke',
          missingStrokePayload,
          true,
        ),
        true,
      );
      const reservedV2ColorPayload = render(makeReservedV2ColorPayloadTree(), true);
      const invalidRangeReservedV2ColorPayloadTree = makeReservedV2ColorPayloadTree();
      invalidRangeReservedV2ColorPayloadTree.root.ops[0].variants
        .find((variant) => variant.variantId === 'glyphOutline')
        .parts[0]
        .payload
        .colorLayers
        .layers[0]
        .sourceRangeUtf8 = { start: 2, end: 1 };
      const invalidRangeReservedV2ColorPayload = render(
        invalidRangeReservedV2ColorPayloadTree,
        true,
      );
      const invalidColorReservedV2ColorPayloadTree = makeReservedV2ColorPayloadTree();
      invalidColorReservedV2ColorPayloadTree.root.ops[0].variants
        .find((variant) => variant.variantId === 'glyphOutline')
        .parts[0]
        .payload
        .colorLayers
        .layers[0]
        .fill = { colorSpace: 'srgb', rgba: [0, 0, 2, 1] };
      const invalidColorReservedV2ColorPayload = render(
        invalidColorReservedV2ColorPayloadTree,
        true,
      );
      const invalidColorShapeReservedV2ColorPayloadTree = makeReservedV2ColorPayloadTree();
      invalidColorShapeReservedV2ColorPayloadTree.root.ops[0].variants
        .find((variant) => variant.variantId === 'glyphOutline')
        .parts[0]
        .payload
        .colorLayers
        .layers[0]
        .fill = { colorSpace: 'srgb', rgba: 'rgba' };
      const invalidColorShapeReservedV2ColorPayload = render(
        invalidColorShapeReservedV2ColorPayloadTree,
        true,
      );
      const invalidCommandReservedV2ColorPayloadTree = makeReservedV2ColorPayloadTree();
      invalidCommandReservedV2ColorPayloadTree.root.ops[0].variants
        .find((variant) => variant.variantId === 'glyphOutline')
        .parts[0]
        .payload
        .colorLayers
        .layers[0]
        .commands = invalidCommandReservedV2ColorPayloadTree.root.ops[0].variants
          .find((variant) => variant.variantId === 'glyphOutline')
          .parts[0]
          .payload
          .colorLayers
          .layers[0]
          .commands
          .map((command, commandIndex) => (
            commandIndex === 1 ? { ...command, x: Number.POSITIVE_INFINITY } : command
          ));
      const invalidCommandReservedV2ColorPayload = render(
        invalidCommandReservedV2ColorPayloadTree,
        true,
      );
      const invalidProvenanceReservedV2ColorPayloadTree = makeReservedV2ColorPayloadTree();
      invalidProvenanceReservedV2ColorPayloadTree.root.ops[0].variants
        .find((variant) => variant.variantId === 'glyphOutline')
        .parts[0]
        .payload
        .colorLayers
        .layers[0]
        .paletteIndex = -1;
      const invalidProvenanceReservedV2ColorPayload = render(
        invalidProvenanceReservedV2ColorPayloadTree,
        true,
      );
      const reservedV2ColorPayloadColrV1 = render(makeReservedV2ColorPayloadColrV1Tree(), true);
      const invalidRangeReservedV2ColorPayloadColrV1Tree = makeReservedV2ColorPayloadColrV1Tree();
      invalidRangeReservedV2ColorPayloadColrV1Tree.root.ops[0].variants
        .find((variant) => variant.variantId === 'glyphOutline')
        .parts[0]
        .payload
        .colorLayers
        .glyphRange = { start: 2, end: 1 };
      const invalidRangeReservedV2ColorPayloadColrV1 = render(
        invalidRangeReservedV2ColorPayloadColrV1Tree,
        true,
      );
      const mixedLayerReservedV2ColorPayloadColrV1Tree = makeReservedV2ColorPayloadColrV1Tree();
      mixedLayerReservedV2ColorPayloadColrV1Tree.root.ops[0].variants
        .find((variant) => variant.variantId === 'glyphOutline')
        .parts[0]
        .payload
        .colorLayers
        .layers
        .push(clonePayloadEnvelope(reservedPayloadEnvelopes.colorLayers.colorLayers.layers[0]));
      const mixedLayerReservedV2ColorPayloadColrV1 = render(
        mixedLayerReservedV2ColorPayloadColrV1Tree,
        true,
      );
      const invalidReservedV2ColorPayloadColrV1Tree = makeReservedV2ColorPayloadColrV1Tree();
      delete invalidReservedV2ColorPayloadColrV1Tree.root.ops[0].variants
        .find((variant) => variant.variantId === 'glyphOutline')
        .parts[0]
        .payload
        .colorLayers
        .paintGraph
        .nodes[0]
        .sourceRangeUtf8;
      const invalidReservedV2ColorPayloadColrV1 = render(
        invalidReservedV2ColorPayloadColrV1Tree,
        true,
      );
      const cyclicReservedV2ColorPayloadColrV1Tree = makeReservedV2ColorPayloadColrV1Tree();
      cyclicReservedV2ColorPayloadColrV1Tree.root.ops[0].variants
        .find((variant) => variant.variantId === 'glyphOutline')
        .parts[0]
        .payload
        .colorLayers
        .paintGraph = {
          rootNodeId: 0,
          nodes: [
            {
              nodeId: 0,
              kind: 'transform',
              transform: {
                childNodeId: 1,
                transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
              },
            },
            {
              nodeId: 1,
              kind: 'transform',
              transform: {
                childNodeId: 0,
                transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
              },
            },
          ],
        };
      const cyclicReservedV2ColorPayloadColrV1 = render(
        cyclicReservedV2ColorPayloadColrV1Tree,
        true,
      );
      const oversizedReservedV2ColorPayloadColrV1Tree = makeReservedV2ColorPayloadColrV1Tree();
      const oversizedColrV1Graph = oversizedReservedV2ColorPayloadColrV1Tree.root.ops[0].variants
        .find((variant) => variant.variantId === 'glyphOutline')
        .parts[0]
        .payload
        .colorLayers
        .paintGraph;
      const oversizedSolidNode = oversizedColrV1Graph.nodes.find((node) => node.kind === 'solidPath');
      oversizedColrV1Graph.rootNodeId = 64;
      oversizedColrV1Graph.nodes = [
        oversizedSolidNode,
        ...Array.from({ length: 64 }, (_, index) => ({
          nodeId: index + 1,
          kind: 'transform',
          transform: {
            childNodeId: index,
            transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
          },
        })),
      ];
      const oversizedReservedV2ColorPayloadColrV1 = render(
        oversizedReservedV2ColorPayloadColrV1Tree,
        true,
      );
      const invalidNodeIdReservedV2ColorPayloadColrV1Tree = makeReservedV2ColorPayloadColrV1Tree();
      invalidNodeIdReservedV2ColorPayloadColrV1Tree.root.ops[0].variants
        .find((variant) => variant.variantId === 'glyphOutline')
        .parts[0]
        .payload
        .colorLayers
        .paintGraph
        .nodes[0]
        .nodeId = 0.5;
      const invalidNodeIdReservedV2ColorPayloadColrV1 = render(
        invalidNodeIdReservedV2ColorPayloadColrV1Tree,
        true,
      );
      const duplicateNodeIdReservedV2ColorPayloadColrV1Tree =
        makeReservedV2ColorPayloadColrV1Tree();
      const duplicateNodeIdV2ColorGraph = duplicateNodeIdReservedV2ColorPayloadColrV1Tree
        .root
        .ops[0]
        .variants
        .find((variant) => variant.variantId === 'glyphOutline')
        .parts[0]
        .payload
        .colorLayers
        .paintGraph;
      duplicateNodeIdV2ColorGraph.nodes.push({
        nodeId: duplicateNodeIdV2ColorGraph.nodes[0].nodeId,
        kind: 'solidPath',
        solidPath: {
          commands: [
            { type: 'moveTo', x: 0, y: 0 },
            { type: 'lineTo', x: 5, y: 0 },
            { type: 'lineTo', x: 5, y: 5 },
            { type: 'closePath' },
          ],
          fill: { rgba: [1, 0, 0, 1] },
          fillRule: 'nonzero',
          sourceGlyphId: 46,
          paletteIndex: 2,
        },
        sourceRangeUtf8: { start: 0, end: 1 },
        glyphRange: { start: 0, end: 1 },
        sourceFontRef: { faceKey: 'fixture-face', glyphId: 46, colorFormat: 'colrV1' },
      });
      const duplicateNodeIdReservedV2ColorPayloadColrV1 = render(
        duplicateNodeIdReservedV2ColorPayloadColrV1Tree,
        true,
      );
      const missingRootReservedV2ColorPayloadColrV1Tree =
        makeReservedV2ColorPayloadColrV1Tree();
      missingRootReservedV2ColorPayloadColrV1Tree.root.ops[0].variants
        .find((variant) => variant.variantId === 'glyphOutline')
        .parts[0]
        .payload
        .colorLayers
        .paintGraph
        .rootNodeId = 99;
      const missingRootReservedV2ColorPayloadColrV1 = render(
        missingRootReservedV2ColorPayloadColrV1Tree,
        true,
      );
      const unsupportedNodeReservedV2ColorPayloadColrV1Tree = makeReservedV2ColorPayloadColrV1Tree();
      const unsupportedNodeV2ColorGraphNode = unsupportedNodeReservedV2ColorPayloadColrV1Tree
        .root
        .ops[0]
        .variants
        .find((variant) => variant.variantId === 'glyphOutline')
        .parts[0]
        .payload
        .colorLayers
        .paintGraph
        .nodes
        .find((node) => node.kind === 'transform');
      unsupportedNodeV2ColorGraphNode.kind = 'linearGradient';
      delete unsupportedNodeV2ColorGraphNode.transform;
      unsupportedNodeV2ColorGraphNode.linearGradient = {
        start: { x: 0, y: 0 },
        end: { x: 16, y: 16 },
        stops: [
          { offset: 0, color: { rgba: [1, 0, 1, 1] } },
          { offset: 1, color: { rgba: [0, 1, 1, 1] } },
        ],
      };
      const unsupportedNodeReservedV2ColorPayloadColrV1 = render(
        unsupportedNodeReservedV2ColorPayloadColrV1Tree,
        true,
      );
      const unsupportedSweepNodeReservedV2ColorPayloadColrV1Tree = makeReservedV2ColorPayloadColrV1Tree();
      const unsupportedSweepNodeV2ColorGraphNode = unsupportedSweepNodeReservedV2ColorPayloadColrV1Tree
        .root
        .ops[0]
        .variants
        .find((variant) => variant.variantId === 'glyphOutline')
        .parts[0]
        .payload
        .colorLayers
        .paintGraph
        .nodes
        .find((node) => node.kind === 'solidPath');
      unsupportedSweepNodeV2ColorGraphNode.kind = 'sweepGradientPath';
      delete unsupportedSweepNodeV2ColorGraphNode.solidPath;
      unsupportedSweepNodeV2ColorGraphNode.sweepGradientPath = {
        commands: [
          { type: 'moveTo', x: 0, y: 0 },
          { type: 'lineTo', x: 10, y: 0 },
          { type: 'lineTo', x: 10, y: 10 },
          { type: 'closePath' },
        ],
        gradient: {
          cx: 5,
          cy: 5,
          startAngleRad: 0,
          stops: [
            { offset: 0, color: { rgba: [1, 0, 0, 1] } },
            { offset: 1, color: { rgba: [0, 0, 1, 1] } },
          ],
        },
        fillRule: 'nonzero',
        sourceGlyphId: 42,
        paletteIndex: 0,
      };
      const unsupportedSweepNodeReservedV2ColorPayloadColrV1 = render(
        unsupportedSweepNodeReservedV2ColorPayloadColrV1Tree,
        true,
      );
      const unsupportedCompositeNodeReservedV2ColorPayloadColrV1Tree =
        makeReservedV2ColorPayloadColrV1Tree();
      const unsupportedCompositeNodeV2ColorGraph = unsupportedCompositeNodeReservedV2ColorPayloadColrV1Tree
        .root
        .ops[0]
        .variants
        .find((variant) => variant.variantId === 'glyphOutline')
        .parts[0]
        .payload
        .colorLayers
        .paintGraph;
      unsupportedCompositeNodeV2ColorGraph.rootNodeId = 2;
      unsupportedCompositeNodeV2ColorGraph.nodes = [
        {
          nodeId: 0,
          kind: 'solidPath',
          solidPath: {
            commands: [
              { type: 'moveTo', x: 0, y: 0 },
              { type: 'lineTo', x: 10, y: 0 },
              { type: 'lineTo', x: 10, y: 10 },
              { type: 'closePath' },
            ],
            fill: { rgba: [1, 0, 0, 1] },
            fillRule: 'nonzero',
            sourceGlyphId: 42,
            paletteIndex: 0,
          },
          sourceRangeUtf8: { start: 0, end: 1 },
          glyphRange: { start: 0, end: 1 },
          sourceFontRef: { faceKey: 'fixture-face', glyphId: 42 },
        },
        {
          nodeId: 1,
          kind: 'solidPath',
          solidPath: {
            commands: [
              { type: 'moveTo', x: 4, y: 4 },
              { type: 'lineTo', x: 14, y: 4 },
              { type: 'lineTo', x: 14, y: 14 },
              { type: 'closePath' },
            ],
            fill: { rgba: [0, 0, 1, 1] },
            fillRule: 'nonzero',
            sourceGlyphId: 43,
            paletteIndex: 1,
          },
          sourceRangeUtf8: { start: 0, end: 1 },
          glyphRange: { start: 0, end: 1 },
          sourceFontRef: { faceKey: 'fixture-face', glyphId: 43 },
        },
        {
          nodeId: 2,
          kind: 'composite',
          composite: {
            sourceNodeId: 0,
            backdropNodeId: 1,
            mode: 'sourceOver',
          },
          sourceRangeUtf8: { start: 0, end: 1 },
          glyphRange: { start: 0, end: 1 },
          sourceFontRef: { faceKey: 'fixture-face', glyphId: 42 },
        },
      ];
      const unsupportedCompositeNodeReservedV2ColorPayloadColrV1 = render(
        unsupportedCompositeNodeReservedV2ColorPayloadColrV1Tree,
        true,
      );
      const unsupportedClipNodeReservedV2ColorPayloadColrV1Tree =
        makeReservedV2ColorPayloadColrV1Tree();
      const unsupportedClipNodeV2ColorGraph = unsupportedClipNodeReservedV2ColorPayloadColrV1Tree
        .root
        .ops[0]
        .variants
        .find((variant) => variant.variantId === 'glyphOutline')
        .parts[0]
        .payload
        .colorLayers
        .paintGraph;
      unsupportedClipNodeV2ColorGraph.rootNodeId = 1;
      unsupportedClipNodeV2ColorGraph.nodes = [
        unsupportedClipNodeV2ColorGraph.nodes.find((node) => node.kind === 'solidPath'),
        {
          nodeId: 1,
          kind: 'clipPath',
          clipPath: {
            childNodeId: 0,
            commands: [
              { type: 'moveTo', x: 0, y: 0 },
              { type: 'lineTo', x: 8, y: 0 },
              { type: 'lineTo', x: 8, y: 8 },
              { type: 'closePath' },
            ],
            fillRule: 'nonzero',
          },
          sourceRangeUtf8: { start: 0, end: 1 },
          glyphRange: { start: 0, end: 1 },
          sourceFontRef: { faceKey: 'fixture-face', glyphId: 42 },
        },
      ];
      const unsupportedClipNodeReservedV2ColorPayloadColrV1 = render(
        unsupportedClipNodeReservedV2ColorPayloadColrV1Tree,
        true,
      );
      const sharedChildReservedV2ColorPayloadColrV1Tree = makeReservedV2ColorPayloadColrV1Tree();
      const sharedChildV2ColorGraph = sharedChildReservedV2ColorPayloadColrV1Tree
        .root
        .ops[0]
        .variants
        .find((variant) => variant.variantId === 'glyphOutline')
        .parts[0]
        .payload
        .colorLayers
        .paintGraph;
      sharedChildV2ColorGraph.rootNodeId = 2;
      sharedChildV2ColorGraph.nodes = [
        sharedChildV2ColorGraph.nodes.find((node) => node.kind === 'solidPath'),
        {
          nodeId: 1,
          kind: 'transform',
          transform: {
            childNodeId: 0,
            transform: { a: 1, b: 0, c: 0, d: 1, e: 2, f: 0 },
          },
        },
        {
          nodeId: 2,
          kind: 'transform',
          transform: {
            childNodeId: 0,
            transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 2 },
          },
        },
      ];
      const sharedChildReservedV2ColorPayloadColrV1 = render(
        sharedChildReservedV2ColorPayloadColrV1Tree,
        true,
      );
      const unreachableNodeReservedV2ColorPayloadColrV1Tree =
        makeReservedV2ColorPayloadColrV1Tree();
      const unreachableNodeV2ColorGraph = unreachableNodeReservedV2ColorPayloadColrV1Tree
        .root
        .ops[0]
        .variants
        .find((variant) => variant.variantId === 'glyphOutline')
        .parts[0]
        .payload
        .colorLayers
        .paintGraph;
      unreachableNodeV2ColorGraph.nodes.push({
        nodeId: 3,
        kind: 'solidPath',
        solidPath: {
          commands: [
            { type: 'moveTo', x: 0, y: 0 },
            { type: 'lineTo', x: 5, y: 0 },
            { type: 'lineTo', x: 5, y: 5 },
            { type: 'closePath' },
          ],
          fill: { rgba: [1, 0, 0, 1] },
          fillRule: 'nonzero',
          sourceGlyphId: 45,
          paletteIndex: 2,
        },
        sourceRangeUtf8: { start: 0, end: 1 },
        glyphRange: { start: 0, end: 1 },
        sourceFontRef: { faceKey: 'fixture-face', glyphId: 45, colorFormat: 'colrV1' },
      });
      const unreachableNodeReservedV2ColorPayloadColrV1 = render(
        unreachableNodeReservedV2ColorPayloadColrV1Tree,
        true,
      );
      const invalidTransformReservedV2ColorPayloadColrV1Tree = makeReservedV2ColorPayloadColrV1Tree();
      invalidTransformReservedV2ColorPayloadColrV1Tree.root.ops[0].variants
        .find((variant) => variant.variantId === 'glyphOutline')
        .parts[0]
        .payload
        .colorLayers
        .paintGraph
        .nodes
        .find((node) => node.kind === 'transform')
        .transform
        .transform
        .a = Number.POSITIVE_INFINITY;
      const invalidTransformReservedV2ColorPayloadColrV1 = render(
        invalidTransformReservedV2ColorPayloadColrV1Tree,
        true,
      );
      const invalidCommandReservedV2ColorPayloadColrV1Tree = makeReservedV2ColorPayloadColrV1Tree();
      const invalidCommandV2ColorGraphSolidNode = invalidCommandReservedV2ColorPayloadColrV1Tree
        .root
        .ops[0]
        .variants
        .find((variant) => variant.variantId === 'glyphOutline')
        .parts[0]
        .payload
        .colorLayers
        .paintGraph
        .nodes
        .find((node) => node.kind === 'solidPath');
      invalidCommandV2ColorGraphSolidNode.solidPath.commands = invalidCommandV2ColorGraphSolidNode
        .solidPath
        .commands
        .map((command, commandIndex) => (
          commandIndex === 1 ? { ...command, x: Number.POSITIVE_INFINITY } : command
        ));
      const invalidCommandReservedV2ColorPayloadColrV1 = render(
        invalidCommandReservedV2ColorPayloadColrV1Tree,
        true,
      );
      const invalidProvenanceReservedV2ColorPayloadColrV1Tree = makeReservedV2ColorPayloadColrV1Tree();
      invalidProvenanceReservedV2ColorPayloadColrV1Tree
        .root
        .ops[0]
        .variants
        .find((variant) => variant.variantId === 'glyphOutline')
        .parts[0]
        .payload
        .colorLayers
        .paintGraph
        .nodes
        .find((node) => node.kind === 'solidPath')
        .solidPath
        .sourceGlyphId = -1;
      const invalidProvenanceReservedV2ColorPayloadColrV1 = render(
        invalidProvenanceReservedV2ColorPayloadColrV1Tree,
        true,
      );
      const invalidGradientReservedV2ColorPayloadColrV1Tree = makeReservedV2ColorPayloadColrV1Tree();
      const invalidGradientReservedV2ColorPayloadColrV1Payload =
        invalidGradientReservedV2ColorPayloadColrV1Tree.root.ops[0].variants
          .find((variant) => variant.variantId === 'glyphOutline')
          .parts[0]
          .payload;
      Object.assign(
        invalidGradientReservedV2ColorPayloadColrV1Payload,
        clonePayloadEnvelope(colrV1GradientPayloadEnvelope),
      );
      invalidGradientReservedV2ColorPayloadColrV1Payload.colorLayers
        .paintGraph
        .nodes
        .find((node) => node.kind === 'linearGradientPath')
        .linearGradientPath
        .gradient
        .stops[1]
        .offset = 1.5;
      const invalidGradientReservedV2ColorPayloadColrV1 = render(
        invalidGradientReservedV2ColorPayloadColrV1Tree,
        true,
      );
      const unorderedGradientReservedV2ColorPayloadColrV1Tree = makeReservedV2ColorPayloadColrV1Tree();
      const unorderedGradientReservedV2ColorPayloadColrV1Payload =
        unorderedGradientReservedV2ColorPayloadColrV1Tree.root.ops[0].variants
          .find((variant) => variant.variantId === 'glyphOutline')
          .parts[0]
          .payload;
      Object.assign(
        unorderedGradientReservedV2ColorPayloadColrV1Payload,
        clonePayloadEnvelope(colrV1GradientPayloadEnvelope),
      );
      unorderedGradientReservedV2ColorPayloadColrV1Payload.colorLayers
        .paintGraph
        .nodes
        .find((node) => node.kind === 'linearGradientPath')
        .linearGradientPath
        .gradient
        .stops = [
          { offset: 0.75, color: { rgba: [1, 0, 0, 1] } },
          { offset: 0.25, color: { rgba: [0, 0, 1, 1] } },
        ];
      const unorderedGradientReservedV2ColorPayloadColrV1 = render(
        unorderedGradientReservedV2ColorPayloadColrV1Tree,
        true,
      );
      const reservedV2BitmapPayload = render(
        makeReservedV2OutlinePayloadTree(
          'bitmapGlyph',
          'text.glyphOutline.bitmapGlyph',
          reservedPayloadEnvelopes.bitmapGlyph,
          true,
        ),
        true,
      );
      const invalidReservedV2BitmapPayload = render(
        makeReservedV2OutlinePayloadTree(
          'bitmapGlyph',
          'text.glyphOutline.bitmapGlyph',
          {
            ...reservedPayloadEnvelopes.bitmapGlyph,
            bitmapGlyph: {
              ...reservedPayloadEnvelopes.bitmapGlyph.bitmapGlyph,
              filtering: 'backendDefault',
            },
          },
          true,
        ),
        true,
      );
      const invalidReservedV2BitmapBackendDefaultScalingPayload = render(
        makeReservedV2OutlinePayloadTree(
          'bitmapGlyph',
          'text.glyphOutline.bitmapGlyph',
          {
            ...reservedPayloadEnvelopes.bitmapGlyph,
            bitmapGlyph: {
              ...reservedPayloadEnvelopes.bitmapGlyph.bitmapGlyph,
              scalingPolicy: 'backendDefault',
            },
          },
          true,
        ),
        true,
      );
      const invalidReservedV2BitmapTransformPayload = render(
        makeReservedV2OutlinePayloadTree(
          'bitmapGlyph',
          'text.glyphOutline.bitmapGlyph',
          {
            ...reservedPayloadEnvelopes.bitmapGlyph,
            bitmapGlyph: {
              ...reservedPayloadEnvelopes.bitmapGlyph.bitmapGlyph,
              transformToRun: { a: 1, b: 0, c: 0, d: Number.POSITIVE_INFINITY, e: 0, f: 0 },
            },
          },
          true,
        ),
        true,
      );
      const validReservedV2BitmapOffsetTransformPayload = render(
        makeReservedV2OutlinePayloadTree(
          'bitmapGlyph',
          'text.glyphOutline.bitmapGlyph',
          {
            ...reservedPayloadEnvelopes.bitmapGlyph,
            bitmapGlyph: {
              ...reservedPayloadEnvelopes.bitmapGlyph.bitmapGlyph,
              transformToRun: { a: 1, b: 0, c: 0, d: 1, e: 3, f: 0 },
            },
          },
          true,
        ),
        true,
      );
      const invalidReservedV2BitmapRangePayload = render(
        makeReservedV2OutlinePayloadTree(
          'bitmapGlyph',
          'text.glyphOutline.bitmapGlyph',
          {
            ...reservedPayloadEnvelopes.bitmapGlyph,
            bitmapGlyph: {
              ...reservedPayloadEnvelopes.bitmapGlyph.bitmapGlyph,
              glyphRange: { start: 3, end: 1 },
            },
          },
          true,
        ),
        true,
      );
      const invalidReservedV2BitmapEmptyGlyphRangePayload = render(
        makeReservedV2OutlinePayloadTree(
          'bitmapGlyph',
          'text.glyphOutline.bitmapGlyph',
          {
            ...reservedPayloadEnvelopes.bitmapGlyph,
            bitmapGlyph: {
              ...reservedPayloadEnvelopes.bitmapGlyph.bitmapGlyph,
              glyphRange: { start: 1, end: 1 },
            },
          },
          true,
        ),
        true,
      );
      const invalidReservedV2BitmapResourcePayload = render(
        makeReservedV2OutlinePayloadTree(
          'bitmapGlyph',
          'text.glyphOutline.bitmapGlyph',
          {
            ...reservedPayloadEnvelopes.bitmapGlyph,
            bitmapGlyph: {
              ...reservedPayloadEnvelopes.bitmapGlyph.bitmapGlyph,
              imageResourceId: '',
            },
          },
          true,
        ),
        true,
      );
      const invalidReservedV2BitmapPlacementPayload = render(
        makeReservedV2OutlinePayloadTree(
          'bitmapGlyph',
          'text.glyphOutline.bitmapGlyph',
          {
            ...reservedPayloadEnvelopes.bitmapGlyph,
            bitmapGlyph: {
              ...reservedPayloadEnvelopes.bitmapGlyph.bitmapGlyph,
              placement: {
                ...reservedPayloadEnvelopes.bitmapGlyph.bitmapGlyph.placement,
                runToPage: { a: 1, b: 0, c: 0, d: 1, e: Number.POSITIVE_INFINITY, f: 0 },
              },
            },
          },
          true,
        ),
        true,
      );
      const invalidReservedV2BitmapAlphaPayload = render(
        makeReservedV2OutlinePayloadTree(
          'bitmapGlyph',
          'text.glyphOutline.bitmapGlyph',
          {
            ...reservedPayloadEnvelopes.bitmapGlyph,
            bitmapGlyph: {
              ...reservedPayloadEnvelopes.bitmapGlyph.bitmapGlyph,
              alphaMode: 'unknown',
            },
          },
          true,
        ),
        true,
      );
      const invalidReservedV2BitmapScalingPayload = render(
        makeReservedV2OutlinePayloadTree(
          'bitmapGlyph',
          'text.glyphOutline.bitmapGlyph',
          {
            ...reservedPayloadEnvelopes.bitmapGlyph,
            bitmapGlyph: {
              ...reservedPayloadEnvelopes.bitmapGlyph.bitmapGlyph,
              scalingPolicy: 'unknown',
            },
          },
          true,
        ),
        true,
      );
      const invalidReservedV2BitmapScalingFilterValuePayload = render(
        makeReservedV2OutlinePayloadTree(
          'bitmapGlyph',
          'text.glyphOutline.bitmapGlyph',
          {
            ...reservedPayloadEnvelopes.bitmapGlyph,
            bitmapGlyph: {
              ...reservedPayloadEnvelopes.bitmapGlyph.bitmapGlyph,
              scalingPolicy: 'nearest',
            },
          },
          true,
        ),
        true,
      );
      const invalidReservedV2BitmapFilteringPayload = render(
        makeReservedV2OutlinePayloadTree(
          'bitmapGlyph',
          'text.glyphOutline.bitmapGlyph',
          {
            ...reservedPayloadEnvelopes.bitmapGlyph,
            bitmapGlyph: {
              ...reservedPayloadEnvelopes.bitmapGlyph.bitmapGlyph,
              filtering: 'unknown',
            },
          },
          true,
        ),
        true,
      );
      const invalidReservedV2BitmapMissingFilteringPayload = render(
        makeReservedV2OutlinePayloadTree(
          'bitmapGlyph',
          'text.glyphOutline.bitmapGlyph',
          {
            ...reservedPayloadEnvelopes.bitmapGlyph,
            bitmapGlyph: {
              ...reservedPayloadEnvelopes.bitmapGlyph.bitmapGlyph,
              filtering: undefined,
            },
          },
          true,
        ),
        true,
      );
      const invalidReservedV2BitmapStrikePpemPayload = render(
        makeReservedV2OutlinePayloadTree(
          'bitmapGlyph',
          'text.glyphOutline.bitmapGlyph',
          {
            ...reservedPayloadEnvelopes.bitmapGlyph,
            bitmapGlyph: {
              ...reservedPayloadEnvelopes.bitmapGlyph.bitmapGlyph,
              strikePpem: [0, 16],
            },
          },
          true,
        ),
        true,
      );
      const invalidReservedV2BitmapDiagnosticStrikePayload = render(
        makeReservedV2OutlinePayloadTree(
          'bitmapGlyph',
          'text.glyphOutline.bitmapGlyph',
          {
            ...reservedPayloadEnvelopes.bitmapGlyph,
            bitmapGlyph: {
              ...reservedPayloadEnvelopes.bitmapGlyph.bitmapGlyph,
              strikeSelection: 'diagnosticOnly',
            },
          },
          true,
        ),
        true,
      );
      const invalidReservedV2BitmapStrikeReselectionPayload = render(
        makeReservedV2OutlinePayloadTree(
          'bitmapGlyph',
          'text.glyphOutline.bitmapGlyph',
          {
            ...reservedPayloadEnvelopes.bitmapGlyph,
            bitmapGlyph: {
              ...reservedPayloadEnvelopes.bitmapGlyph.bitmapGlyph,
              strikeSelection: 'backendResolved',
            },
          },
          true,
        ),
        true,
      );
      const mixedReservedV2BitmapPayload = render(
        makeReservedV2OutlinePayloadTree(
          'bitmapGlyph',
          'text.glyphOutline.bitmapGlyph',
          {
            ...reservedPayloadEnvelopes.bitmapGlyph,
            colorLayers: clonePayloadEnvelope(reservedPayloadEnvelopes.colorLayers).colorLayers,
          },
          true,
        ),
        true,
      );
      const reservedV2SvgPayload = render(
        makeReservedV2OutlinePayloadTree(
          'svgGlyph',
          'text.glyphOutline.svgGlyph',
          reservedPayloadEnvelopes.svgGlyph,
          true,
        ),
        true,
      );
      const invalidReservedV2SvgPayload = render(
        makeReservedV2OutlinePayloadTree(
          'svgGlyph',
          'text.glyphOutline.svgGlyph',
          {
            ...reservedPayloadEnvelopes.svgGlyph,
            svgGlyph: {
              ...reservedPayloadEnvelopes.svgGlyph.svgGlyph,
              animationAllowed: true,
            },
          },
          true,
        ),
        true,
      );
      const invalidReservedV2SvgUnsafeFlagsPayload = render(
        makeReservedV2OutlinePayloadTree(
          'svgGlyph',
          'text.glyphOutline.svgGlyph',
          {
            ...reservedPayloadEnvelopes.svgGlyph,
            svgGlyph: {
              ...reservedPayloadEnvelopes.svgGlyph.svgGlyph,
              scriptAllowed: true,
              externalResourcesAllowed: true,
              interactivityAllowed: true,
            },
          },
          true,
        ),
        true,
      );
      const invalidReservedV2SvgViewBoxPayload = render(
        makeReservedV2OutlinePayloadTree(
          'svgGlyph',
          'text.glyphOutline.svgGlyph',
          {
            ...reservedPayloadEnvelopes.svgGlyph,
            svgGlyph: {
              ...reservedPayloadEnvelopes.svgGlyph.svgGlyph,
              viewBox: { x: 0, y: 0, width: 0, height: 10 },
            },
          },
          true,
        ),
        true,
      );
      const invalidReservedV2SvgIntrinsicSizePayload = render(
        makeReservedV2OutlinePayloadTree(
          'svgGlyph',
          'text.glyphOutline.svgGlyph',
          {
            ...reservedPayloadEnvelopes.svgGlyph,
            svgGlyph: {
              ...reservedPayloadEnvelopes.svgGlyph.svgGlyph,
              intrinsicSize: { width: 10, height: Number.POSITIVE_INFINITY },
            },
          },
          true,
        ),
        true,
      );
      const invalidReservedV2SvgRangePayload = render(
        makeReservedV2OutlinePayloadTree(
          'svgGlyph',
          'text.glyphOutline.svgGlyph',
          {
            ...reservedPayloadEnvelopes.svgGlyph,
            svgGlyph: {
              ...reservedPayloadEnvelopes.svgGlyph.svgGlyph,
              sourceRangeUtf8: { start: -1, end: 1 },
            },
          },
          true,
        ),
        true,
      );
      const invalidReservedV2SvgEmptyGlyphRangePayload = render(
        makeReservedV2OutlinePayloadTree(
          'svgGlyph',
          'text.glyphOutline.svgGlyph',
          {
            ...reservedPayloadEnvelopes.svgGlyph,
            svgGlyph: {
              ...reservedPayloadEnvelopes.svgGlyph.svgGlyph,
              glyphRange: { start: 1, end: 1 },
            },
          },
          true,
        ),
        true,
      );
      const invalidReservedV2SvgResourcePayload = render(
        makeReservedV2OutlinePayloadTree(
          'svgGlyph',
          'text.glyphOutline.svgGlyph',
          {
            ...reservedPayloadEnvelopes.svgGlyph,
            svgGlyph: {
              ...reservedPayloadEnvelopes.svgGlyph.svgGlyph,
              vectorResourceId: '',
            },
          },
          true,
        ),
        true,
      );
      const invalidReservedV2SvgRawInlinePayload = render(
        makeReservedV2OutlinePayloadTree(
          'svgGlyph',
          'text.glyphOutline.svgGlyph',
          {
            ...reservedPayloadEnvelopes.svgGlyph,
            svgGlyph: {
              ...reservedPayloadEnvelopes.svgGlyph.svgGlyph,
              rawSvg: '<svg><path d="M0 0 L10 0 L10 10 Z"/></svg>',
            },
          },
          true,
        ),
        true,
      );
      const invalidReservedV2SvgTransformPayload = render(
        makeReservedV2OutlinePayloadTree(
          'svgGlyph',
          'text.glyphOutline.svgGlyph',
          {
            ...reservedPayloadEnvelopes.svgGlyph,
            svgGlyph: {
              ...reservedPayloadEnvelopes.svgGlyph.svgGlyph,
              transformToRun: { a: 1, b: 0, c: 0, d: Number.NEGATIVE_INFINITY, e: 0, f: 0 },
            },
          },
          true,
        ),
        true,
      );
      const invalidReservedV2SvgSecurityModePayload = render(
        makeReservedV2OutlinePayloadTree(
          'svgGlyph',
          'text.glyphOutline.svgGlyph',
          {
            ...reservedPayloadEnvelopes.svgGlyph,
            svgGlyph: {
              ...reservedPayloadEnvelopes.svgGlyph.svgGlyph,
              securityMode: 'raw',
            },
          },
          true,
        ),
        true,
      );
      const validReservedV2SvgTransformPayload = render(
        makeReservedV2OutlinePayloadTree(
          'svgGlyph',
          'text.glyphOutline.svgGlyph',
          {
            ...reservedPayloadEnvelopes.svgGlyph,
            svgGlyph: {
              ...reservedPayloadEnvelopes.svgGlyph.svgGlyph,
              transformToRun: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 3 },
            },
          },
          true,
        ),
        true,
      );
      const mixedReservedV2SvgPayload = render(
        makeReservedV2OutlinePayloadTree(
          'svgGlyph',
          'text.glyphOutline.svgGlyph',
          {
            ...reservedPayloadEnvelopes.svgGlyph,
            bitmapGlyph: clonePayloadEnvelope(reservedPayloadEnvelopes.bitmapGlyph).bitmapGlyph,
          },
          true,
        ),
        true,
      );
      const unsupported = render(makeTree({ ...style, underline: 'bottom' }), true);
      const unsupportedPayload = render(makeTree(style, []), true);
      return {
        fallback,
        strict,
        strictSidecar,
        duplicateSidecar,
        invalidAnchorSidecar,
        invalidPathMetadataSidecar,
        invalidPathCommandSidecar,
        strokePayloadSidecar,
        unsupportedStrokePayloadSidecar,
        unsupportedStrokeJoinCapSidecar,
        missingStrokePayloadSidecar,
        colorPayloadSidecar,
        colorV1PayloadSidecar,
        colorV1GradientPayloadSidecar,
        reservedColorPayloadSidecar,
        reservedBitmapPayloadSidecar,
        reservedSvgPayloadSidecar,
        v2Fallback,
        v2Strict,
        invalidV2MissingFallback,
        invalidV2PathMetadata,
        invalidV2PathCommand,
        invalidV2CrossScope,
        allowedV2CrossScope,
        invalidV2MixedPerGlyph,
        allowedV2MixedPerGlyph,
        invalidV2FallbackFree,
        allowedV2FallbackFree,
        invalidV2FallbackFreeCompatibilityProfile,
        invalidV2FallbackFreeDisabledFlag,
        invalidV2FallbackFreeTextOnly,
        missingStrokeV2Payload,
        reservedV2ColorPayload,
        invalidRangeReservedV2ColorPayload,
        invalidColorReservedV2ColorPayload,
        invalidColorShapeReservedV2ColorPayload,
        invalidCommandReservedV2ColorPayload,
        invalidProvenanceReservedV2ColorPayload,
        reservedV2ColorPayloadColrV1,
        invalidRangeReservedV2ColorPayloadColrV1,
        mixedLayerReservedV2ColorPayloadColrV1,
        invalidReservedV2ColorPayloadColrV1,
        cyclicReservedV2ColorPayloadColrV1,
        oversizedReservedV2ColorPayloadColrV1,
        invalidNodeIdReservedV2ColorPayloadColrV1,
        duplicateNodeIdReservedV2ColorPayloadColrV1,
        missingRootReservedV2ColorPayloadColrV1,
        unsupportedNodeReservedV2ColorPayloadColrV1,
        unsupportedSweepNodeReservedV2ColorPayloadColrV1,
        unsupportedCompositeNodeReservedV2ColorPayloadColrV1,
        unsupportedClipNodeReservedV2ColorPayloadColrV1,
        sharedChildReservedV2ColorPayloadColrV1,
        unreachableNodeReservedV2ColorPayloadColrV1,
        invalidTransformReservedV2ColorPayloadColrV1,
        invalidCommandReservedV2ColorPayloadColrV1,
        invalidProvenanceReservedV2ColorPayloadColrV1,
        invalidGradientReservedV2ColorPayloadColrV1,
        unorderedGradientReservedV2ColorPayloadColrV1,
        reservedV2BitmapPayload,
        invalidReservedV2BitmapPayload,
        invalidReservedV2BitmapBackendDefaultScalingPayload,
        invalidReservedV2BitmapTransformPayload,
        validReservedV2BitmapOffsetTransformPayload,
        invalidReservedV2BitmapRangePayload,
        invalidReservedV2BitmapEmptyGlyphRangePayload,
        invalidReservedV2BitmapResourcePayload,
        invalidReservedV2BitmapPlacementPayload,
        invalidReservedV2BitmapAlphaPayload,
        invalidReservedV2BitmapScalingPayload,
        invalidReservedV2BitmapScalingFilterValuePayload,
        invalidReservedV2BitmapFilteringPayload,
        invalidReservedV2BitmapMissingFilteringPayload,
        invalidReservedV2BitmapStrikePpemPayload,
        invalidReservedV2BitmapDiagnosticStrikePayload,
        invalidReservedV2BitmapStrikeReselectionPayload,
        mixedReservedV2BitmapPayload,
        reservedV2SvgPayload,
        invalidReservedV2SvgPayload,
        invalidReservedV2SvgUnsafeFlagsPayload,
        invalidReservedV2SvgViewBoxPayload,
        invalidReservedV2SvgIntrinsicSizePayload,
        invalidReservedV2SvgRangePayload,
        invalidReservedV2SvgEmptyGlyphRangePayload,
        invalidReservedV2SvgResourcePayload,
        invalidReservedV2SvgRawInlinePayload,
        invalidReservedV2SvgTransformPayload,
        invalidReservedV2SvgSecurityModePayload,
        validReservedV2SvgTransformPayload,
        mixedReservedV2SvgPayload,
        unsupported,
        unsupportedPayload,
      };
    } finally {
      renderer.setStrictGlyphOutlineReplay(false);
    }
  });

  assert(!canvas2dGlyphOutlineProbe.error, canvas2dGlyphOutlineProbe.error || 'Canvas2D glyph outline probe available');
  const fallbackOutlineReport = canvas2dGlyphOutlineProbe.fallback?.diagnostics?.find(
    (report) => report.equivalenceGroup === 'outline-fixture-0',
  );
  assert(
    fallbackOutlineReport?.selectedVariantId === 'textRun'
      && fallbackOutlineReport?.selectedVariantKind === 'textRun'
      && fallbackOutlineReport?.selectedReason === 'defaultTextRunFallback'
      && fallbackOutlineReport?.partsExpected === 1
      && fallbackOutlineReport?.partsReplayed === 1
      && fallbackOutlineReport?.parts?.some(
        (part) => part.variantId === 'textRun' && part.replayable === true && !part.reason,
      )
      && fallbackOutlineReport?.parts?.some(
        (part) => part.variantId === 'glyphOutline'
          && part.replayable === false
          && part.reason === 'backendDoesNotSupportVariant'
          && part.outlineEligibility?.payloadSupported === true
          && part.outlineEligibility?.paintStyleSupported === true
          && part.outlineEligibility?.replayEligible === false,
      )
      && fallbackOutlineReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('backendDoesNotSupportVariant'),
      ),
    `Canvas2D default profile keeps TextRun fallback=${JSON.stringify(fallbackOutlineReport)}`,
  );
  const strictOutlineReport = canvas2dGlyphOutlineProbe.strict?.diagnostics?.find(
    (report) => report.equivalenceGroup === 'outline-fixture-0',
  );
  assert(
    strictOutlineReport?.selectedVariantId === 'glyphOutline'
      && strictOutlineReport?.selectedVariantKind === 'glyphOutline'
      && strictOutlineReport?.selectedReason === 'glyphOutlineStrictProfile'
      && strictOutlineReport?.anchorOpId === 'op-text-outline'
      && strictOutlineReport?.partsExpected === 1
      && strictOutlineReport?.partsReplayed === 1
      && strictOutlineReport?.outlineEligibility?.replayEligible === true,
    `Canvas2D strict profile selects GlyphOutline=${JSON.stringify(strictOutlineReport)}`,
  );
  assert(
    strictOutlineReport?.parts?.some(
      (part) => part.variantId === 'glyphOutline'
        && part.variantKind === 'glyphOutline'
        && part.partIndex === 0
        && part.partCount === 1
        && part.replayable === true
        && !part.reason
        && part.outlineEligibility?.replayEligible === true,
    ),
    `Canvas2D strict profile records replayed GlyphOutline part=${JSON.stringify(strictOutlineReport)}`,
  );
  const strictSidecarOutlineReport = canvas2dGlyphOutlineProbe.strictSidecar?.diagnostics?.find(
    (report) => report.equivalenceGroup === 'outline-fixture-0',
  );
  assert(
    strictSidecarOutlineReport?.selectedVariantId === 'glyphOutline'
      && strictSidecarOutlineReport?.selectedVariantKind === 'glyphOutline'
      && strictSidecarOutlineReport?.selectedReason === 'glyphOutlineStrictProfile'
      && strictSidecarOutlineReport?.anchorOpId === 'op-text-outline'
      && strictSidecarOutlineReport?.partsExpected === 1
      && strictSidecarOutlineReport?.partsReplayed === 1
      && strictSidecarOutlineReport?.parts?.some(
        (part) => part.variantId === 'glyphOutline'
          && part.variantKind === 'glyphOutline'
          && part.partIndex === 0
          && part.replayable === true,
    ),
    `Canvas2D strict profile selects sidecar GlyphOutline=${JSON.stringify(strictSidecarOutlineReport)}`,
  );
  const duplicateSidecarOutlineReport = canvas2dGlyphOutlineProbe.duplicateSidecar?.diagnostics?.find(
    (report) => report.equivalenceGroup === 'outline-fixture-0',
  );
  const duplicateSidecarOutlineParts = duplicateSidecarOutlineReport?.parts?.filter(
    (part) => part.variantId === 'glyphOutline',
  ) ?? [];
  assert(
    duplicateSidecarOutlineReport?.selectedVariantId === 'glyphOutline'
      && duplicateSidecarOutlineReport?.partsExpected === 1
      && duplicateSidecarOutlineReport?.partsReplayed === 1
      && duplicateSidecarOutlineParts.length === 1,
    `Canvas2D strict profile ignores duplicate root+sidecar GlyphOutline part=${JSON.stringify(duplicateSidecarOutlineReport)}`,
  );
  const invalidAnchorSidecarReport = canvas2dGlyphOutlineProbe.invalidAnchorSidecar?.diagnostics?.find(
    (report) => report.equivalenceGroup === 'outline-fixture-0',
  );
  assert(
    invalidAnchorSidecarReport?.selectedVariantId === 'textRun'
      && !invalidAnchorSidecarReport?.parts?.some((part) => part.variantId === 'glyphOutline'),
    `Canvas2D strict profile ignores sidecar with missing anchor=${JSON.stringify(invalidAnchorSidecarReport)}`,
  );
  const invalidPathMetadataSidecarReport = canvas2dGlyphOutlineProbe.invalidPathMetadataSidecar?.diagnostics?.find(
    (report) => report.equivalenceGroup === 'outline-fixture-0',
  );
  assert(
    invalidPathMetadataSidecarReport?.selectedVariantId === 'textRun'
      && invalidPathMetadataSidecarReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedOutlinePayload'),
      )
      && invalidPathMetadataSidecarReport?.outlineEligibility?.payloadSupported === false,
    `Canvas2D strict profile rejects GlyphOutline path metadata contract=${JSON.stringify(
      invalidPathMetadataSidecarReport,
    )}`,
  );
  const invalidPathCommandSidecarReport = canvas2dGlyphOutlineProbe.invalidPathCommandSidecar?.diagnostics?.find(
    (report) => report.equivalenceGroup === 'outline-fixture-0',
  );
  assert(
    invalidPathCommandSidecarReport?.selectedVariantId === 'textRun'
      && invalidPathCommandSidecarReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedOutlinePayload'),
      )
      && invalidPathCommandSidecarReport?.outlineEligibility?.payloadSupported === false,
    `Canvas2D strict profile rejects non-finite GlyphOutline path commands=${JSON.stringify(
      invalidPathCommandSidecarReport,
    )}`,
  );
  const strokePayloadSidecarReport = canvas2dGlyphOutlineProbe.strokePayloadSidecar?.diagnostics?.find(
    (report) => report.equivalenceGroup === 'outline-fixture-0',
  );
  assert(
    strokePayloadSidecarReport?.selectedVariantId === 'glyphOutline'
      && strokePayloadSidecarReport?.selectedVariantKind === 'glyphOutline'
      && strokePayloadSidecarReport?.selectedReason === 'glyphOutlineStrictProfile'
      && strokePayloadSidecarReport?.outlineEligibility?.payloadSupported === true
      && strokePayloadSidecarReport?.outlineEligibility?.paintStyleSupported === true
      && strokePayloadSidecarReport?.outlineEligibility?.replayEligible === true
      && strokePayloadSidecarReport?.parts?.some(
        (part) => part.variantId === 'glyphOutline'
          && part.variantKind === 'glyphOutline'
          && part.replayable === true
          && part.outlineEligibility?.replayEligible === true,
      ),
    `Canvas2D strict profile replays supported stroke outline payload=${JSON.stringify(strokePayloadSidecarReport)}`,
  );
  const unsupportedStrokePayloadSidecarReport = canvas2dGlyphOutlineProbe.unsupportedStrokePayloadSidecar?.diagnostics?.find(
    (report) => report.equivalenceGroup === 'outline-fixture-0',
  );
  assert(
    unsupportedStrokePayloadSidecarReport?.selectedVariantId === 'textRun'
      && unsupportedStrokePayloadSidecarReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('glyphOutlineStrokeStyleUnsupported'),
      )
      && unsupportedStrokePayloadSidecarReport?.outlineEligibility?.payloadSupported === false
      && unsupportedStrokePayloadSidecarReport?.outlineEligibility?.paintStyleSupported === true
      && unsupportedStrokePayloadSidecarReport?.outlineEligibility?.replayEligible === false,
    `Canvas2D strict profile rejects unsupported stroke outline payload=${JSON.stringify(
      unsupportedStrokePayloadSidecarReport,
    )}`,
  );
  const unsupportedStrokeJoinCapSidecarReport = canvas2dGlyphOutlineProbe
    .unsupportedStrokeJoinCapSidecar
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'outline-fixture-0');
  assert(
    unsupportedStrokeJoinCapSidecarReport?.selectedVariantId === 'textRun'
      && unsupportedStrokeJoinCapSidecarReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('glyphOutlineStrokeStyleUnsupported'),
      )
      && unsupportedStrokeJoinCapSidecarReport?.outlineEligibility?.payloadSupported === false
      && unsupportedStrokeJoinCapSidecarReport?.outlineEligibility?.paintStyleSupported === true
      && unsupportedStrokeJoinCapSidecarReport?.outlineEligibility?.replayEligible === false,
    `Canvas2D strict profile rejects unsupported stroke join/cap outline payload=${JSON.stringify(
      unsupportedStrokeJoinCapSidecarReport,
    )}`,
  );
  const missingStrokePayloadSidecarReport = canvas2dGlyphOutlineProbe
    .missingStrokePayloadSidecar
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'outline-fixture-0');
  assert(
    missingStrokePayloadSidecarReport?.selectedVariantId === 'textRun'
      && missingStrokePayloadSidecarReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedOutlinePayload'),
      )
      && missingStrokePayloadSidecarReport?.outlineEligibility?.payloadSupported === false
      && missingStrokePayloadSidecarReport?.outlineEligibility?.paintStyleSupported === true
      && missingStrokePayloadSidecarReport?.outlineEligibility?.replayEligible === false,
    `Canvas2D strict profile rejects missing stroke outline payload=${JSON.stringify(
      missingStrokePayloadSidecarReport,
    )}`,
  );
  const missingStrokeV2PayloadIssueCodes = canvas2dGlyphOutlineProbe
    .missingStrokeV2Payload
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  assert(
    missingStrokeV2PayloadIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !missingStrokeV2PayloadIssueCodes.includes('glyphOutlineStrokeStyleUnsupported'),
    `Canvas2D schema v2 treats missing MonochromeFillStroke style as payload contract invalid=${JSON.stringify(
      canvas2dGlyphOutlineProbe.missingStrokeV2Payload?.textV2Validation,
    )}`,
  );
  const colorPayloadSidecarReport = canvas2dGlyphOutlineProbe.colorPayloadSidecar?.diagnostics?.find(
    (report) => report.equivalenceGroup === 'outline-fixture-0',
  );
  assert(
    colorPayloadSidecarReport?.selectedVariantId === 'glyphOutline'
      && colorPayloadSidecarReport?.rejectedVariants?.length === 0
      && colorPayloadSidecarReport?.outlineEligibility?.payloadSupported === true
      && colorPayloadSidecarReport?.outlineEligibility?.replayEligible === true,
    `Canvas2D strict profile replays COLRv0 color layer outline payload=${JSON.stringify(
      colorPayloadSidecarReport,
    )}`,
  );
  const colorV1PayloadSidecarReport = canvas2dGlyphOutlineProbe.colorV1PayloadSidecar?.diagnostics?.find(
    (report) => report.equivalenceGroup === 'outline-fixture-0',
  );
  assert(
    colorV1PayloadSidecarReport?.selectedVariantId === 'glyphOutline'
      && colorV1PayloadSidecarReport?.rejectedVariants?.length === 0
      && colorV1PayloadSidecarReport?.outlineEligibility?.payloadSupported === true
      && colorV1PayloadSidecarReport?.outlineEligibility?.replayEligible === true,
    `Canvas2D strict profile replays COLRv1 stage-1 color graph outline payload=${JSON.stringify(
      colorV1PayloadSidecarReport,
    )}`,
  );
  const colorV1GradientPayloadSidecarReport = canvas2dGlyphOutlineProbe
    .colorV1GradientPayloadSidecar
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'outline-fixture-0');
  assert(
    colorV1GradientPayloadSidecarReport?.selectedVariantId === 'glyphOutline'
      && colorV1GradientPayloadSidecarReport?.rejectedVariants?.length === 0
      && colorV1GradientPayloadSidecarReport?.outlineEligibility?.payloadSupported === true
      && colorV1GradientPayloadSidecarReport?.outlineEligibility?.replayEligible === true,
    `Canvas2D strict profile replays COLRv1 gradient color graph outline payload=${JSON.stringify(
      colorV1GradientPayloadSidecarReport,
    )}`,
  );
  const reservedColorPayloadSidecarReport = canvas2dGlyphOutlineProbe.reservedColorPayloadSidecar?.diagnostics?.find(
    (report) => report.equivalenceGroup === 'outline-fixture-0',
  );
  const reservedV2ColorPayloadIssueCodes = canvas2dGlyphOutlineProbe.reservedV2ColorPayload
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const invalidRangeReservedV2ColorPayloadIssueCodes = canvas2dGlyphOutlineProbe
    .invalidRangeReservedV2ColorPayload
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const invalidColorReservedV2ColorPayloadIssueCodes = canvas2dGlyphOutlineProbe
    .invalidColorReservedV2ColorPayload
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const invalidColorShapeReservedV2ColorPayloadIssueCodes = canvas2dGlyphOutlineProbe
    .invalidColorShapeReservedV2ColorPayload
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const invalidCommandReservedV2ColorPayloadIssueCodes = canvas2dGlyphOutlineProbe
    .invalidCommandReservedV2ColorPayload
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const invalidProvenanceReservedV2ColorPayloadIssueCodes = canvas2dGlyphOutlineProbe
    .invalidProvenanceReservedV2ColorPayload
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const reservedV2ColorPayloadColrV1IssueCodes = canvas2dGlyphOutlineProbe
    .reservedV2ColorPayloadColrV1
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const invalidRangeReservedV2ColorPayloadColrV1IssueCodes = canvas2dGlyphOutlineProbe
    .invalidRangeReservedV2ColorPayloadColrV1
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const mixedLayerReservedV2ColorPayloadColrV1IssueCodes = canvas2dGlyphOutlineProbe
    .mixedLayerReservedV2ColorPayloadColrV1
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const invalidReservedV2ColorPayloadColrV1IssueCodes = canvas2dGlyphOutlineProbe
    .invalidReservedV2ColorPayloadColrV1
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const cyclicReservedV2ColorPayloadColrV1IssueCodes = canvas2dGlyphOutlineProbe
    .cyclicReservedV2ColorPayloadColrV1
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const oversizedReservedV2ColorPayloadColrV1IssueCodes = canvas2dGlyphOutlineProbe
    .oversizedReservedV2ColorPayloadColrV1
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const invalidNodeIdReservedV2ColorPayloadColrV1IssueCodes = canvas2dGlyphOutlineProbe
    .invalidNodeIdReservedV2ColorPayloadColrV1
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const duplicateNodeIdReservedV2ColorPayloadColrV1IssueCodes = canvas2dGlyphOutlineProbe
    .duplicateNodeIdReservedV2ColorPayloadColrV1
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const missingRootReservedV2ColorPayloadColrV1IssueCodes = canvas2dGlyphOutlineProbe
    .missingRootReservedV2ColorPayloadColrV1
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const unsupportedNodeReservedV2ColorPayloadColrV1IssueCodes = canvas2dGlyphOutlineProbe
    .unsupportedNodeReservedV2ColorPayloadColrV1
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const unsupportedSweepNodeReservedV2ColorPayloadColrV1IssueCodes = canvas2dGlyphOutlineProbe
    .unsupportedSweepNodeReservedV2ColorPayloadColrV1
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const unsupportedCompositeNodeReservedV2ColorPayloadColrV1IssueCodes = canvas2dGlyphOutlineProbe
    .unsupportedCompositeNodeReservedV2ColorPayloadColrV1
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const unsupportedClipNodeReservedV2ColorPayloadColrV1IssueCodes = canvas2dGlyphOutlineProbe
    .unsupportedClipNodeReservedV2ColorPayloadColrV1
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const sharedChildReservedV2ColorPayloadColrV1IssueCodes = canvas2dGlyphOutlineProbe
    .sharedChildReservedV2ColorPayloadColrV1
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const unreachableNodeReservedV2ColorPayloadColrV1IssueCodes = canvas2dGlyphOutlineProbe
    .unreachableNodeReservedV2ColorPayloadColrV1
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const invalidTransformReservedV2ColorPayloadColrV1IssueCodes = canvas2dGlyphOutlineProbe
    .invalidTransformReservedV2ColorPayloadColrV1
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const invalidCommandReservedV2ColorPayloadColrV1IssueCodes = canvas2dGlyphOutlineProbe
    .invalidCommandReservedV2ColorPayloadColrV1
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const invalidProvenanceReservedV2ColorPayloadColrV1IssueCodes = canvas2dGlyphOutlineProbe
    .invalidProvenanceReservedV2ColorPayloadColrV1
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const invalidGradientReservedV2ColorPayloadColrV1IssueCodes = canvas2dGlyphOutlineProbe
    .invalidGradientReservedV2ColorPayloadColrV1
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const unorderedGradientReservedV2ColorPayloadColrV1IssueCodes = canvas2dGlyphOutlineProbe
    .unorderedGradientReservedV2ColorPayloadColrV1
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  assert(
    reservedColorPayloadSidecarReport?.selectedVariantId === 'textRun'
      && reservedColorPayloadSidecarReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedColorGlyph'),
      )
      && reservedColorPayloadSidecarReport?.outlineEligibility?.payloadSupported === false
      && reservedColorPayloadSidecarReport?.outlineEligibility?.reason === 'unsupportedColorGlyph'
      && !reservedV2ColorPayloadIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && !reservedV2ColorPayloadColrV1IssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && !reservedV2ColorPayloadColrV1IssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && invalidRangeReservedV2ColorPayloadIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidRangeReservedV2ColorPayloadIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && invalidColorReservedV2ColorPayloadIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidColorReservedV2ColorPayloadIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && invalidColorShapeReservedV2ColorPayloadIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidColorShapeReservedV2ColorPayloadIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && invalidCommandReservedV2ColorPayloadIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidCommandReservedV2ColorPayloadIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && invalidProvenanceReservedV2ColorPayloadIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidProvenanceReservedV2ColorPayloadIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && invalidRangeReservedV2ColorPayloadColrV1IssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidRangeReservedV2ColorPayloadColrV1IssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && mixedLayerReservedV2ColorPayloadColrV1IssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !mixedLayerReservedV2ColorPayloadColrV1IssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && !invalidReservedV2ColorPayloadColrV1IssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && invalidReservedV2ColorPayloadColrV1IssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && invalidProvenanceReservedV2ColorPayloadColrV1IssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidProvenanceReservedV2ColorPayloadColrV1IssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && invalidGradientReservedV2ColorPayloadColrV1IssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidGradientReservedV2ColorPayloadColrV1IssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && unorderedGradientReservedV2ColorPayloadColrV1IssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !unorderedGradientReservedV2ColorPayloadColrV1IssueCodes.includes('glyphOutlinePayloadKindFeatureMissing'),
    `Canvas2D strict profile rejects reserved color outline payload=${JSON.stringify({
      report: reservedColorPayloadSidecarReport,
      sidecarValidation: canvas2dGlyphOutlineProbe.reservedColorPayloadSidecar?.textV2Validation,
      v2Validation: canvas2dGlyphOutlineProbe.reservedV2ColorPayload?.textV2Validation,
      invalidRangeV2Validation: canvas2dGlyphOutlineProbe.invalidRangeReservedV2ColorPayload
        ?.textV2Validation,
      invalidColorV2Validation: canvas2dGlyphOutlineProbe.invalidColorReservedV2ColorPayload
        ?.textV2Validation,
      invalidColorShapeV2Validation: canvas2dGlyphOutlineProbe.invalidColorShapeReservedV2ColorPayload
        ?.textV2Validation,
      invalidCommandV2Validation: canvas2dGlyphOutlineProbe.invalidCommandReservedV2ColorPayload
        ?.textV2Validation,
      invalidProvenanceV2Validation: canvas2dGlyphOutlineProbe.invalidProvenanceReservedV2ColorPayload
        ?.textV2Validation,
      v2ColrV1Validation: canvas2dGlyphOutlineProbe.reservedV2ColorPayloadColrV1?.textV2Validation,
      invalidRangeV2ColrV1Validation: canvas2dGlyphOutlineProbe
        .invalidRangeReservedV2ColorPayloadColrV1
        ?.textV2Validation,
      mixedLayerV2ColrV1Validation: canvas2dGlyphOutlineProbe
        .mixedLayerReservedV2ColorPayloadColrV1
        ?.textV2Validation,
      invalidV2ColrV1Validation: canvas2dGlyphOutlineProbe
        .invalidReservedV2ColorPayloadColrV1
        ?.textV2Validation,
      invalidProvenanceV2ColrV1Validation: canvas2dGlyphOutlineProbe
        .invalidProvenanceReservedV2ColorPayloadColrV1
        ?.textV2Validation,
      invalidGradientV2ColrV1Validation: canvas2dGlyphOutlineProbe
        .invalidGradientReservedV2ColorPayloadColrV1
        ?.textV2Validation,
      unorderedGradientV2ColrV1Validation: canvas2dGlyphOutlineProbe
        .unorderedGradientReservedV2ColorPayloadColrV1
        ?.textV2Validation,
    })}`,
  );
  assert(
    cyclicReservedV2ColorPayloadColrV1IssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && oversizedReservedV2ColorPayloadColrV1IssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && invalidNodeIdReservedV2ColorPayloadColrV1IssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && duplicateNodeIdReservedV2ColorPayloadColrV1IssueCodes.includes(
        'glyphOutlinePayloadContractInvalid',
      )
      && missingRootReservedV2ColorPayloadColrV1IssueCodes.includes(
        'glyphOutlinePayloadContractInvalid',
      )
      && unsupportedNodeReservedV2ColorPayloadColrV1IssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && unsupportedSweepNodeReservedV2ColorPayloadColrV1IssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !unsupportedCompositeNodeReservedV2ColorPayloadColrV1IssueCodes.includes(
        'glyphOutlinePayloadContractInvalid',
      )
      && unsupportedClipNodeReservedV2ColorPayloadColrV1IssueCodes.includes(
        'glyphOutlinePayloadContractInvalid',
      )
      && sharedChildReservedV2ColorPayloadColrV1IssueCodes.includes(
        'glyphOutlinePayloadContractInvalid',
      )
      && unreachableNodeReservedV2ColorPayloadColrV1IssueCodes.includes(
        'glyphOutlinePayloadContractInvalid',
      ),
    `Canvas2D strict profile rejects invalid COLRv1 color graph payload=${JSON.stringify({
      cyclicV2ColrV1Validation: canvas2dGlyphOutlineProbe
        .cyclicReservedV2ColorPayloadColrV1
        ?.textV2Validation,
      oversizedV2ColrV1Validation: canvas2dGlyphOutlineProbe
        .oversizedReservedV2ColorPayloadColrV1
        ?.textV2Validation,
      invalidNodeIdV2ColrV1Validation: canvas2dGlyphOutlineProbe
        .invalidNodeIdReservedV2ColorPayloadColrV1
        ?.textV2Validation,
      duplicateNodeIdV2ColrV1Validation: canvas2dGlyphOutlineProbe
        .duplicateNodeIdReservedV2ColorPayloadColrV1
        ?.textV2Validation,
      missingRootV2ColrV1Validation: canvas2dGlyphOutlineProbe
        .missingRootReservedV2ColorPayloadColrV1
        ?.textV2Validation,
      unsupportedNodeV2ColrV1Validation: canvas2dGlyphOutlineProbe
        .unsupportedNodeReservedV2ColorPayloadColrV1
        ?.textV2Validation,
      unsupportedSweepNodeV2ColrV1Validation: canvas2dGlyphOutlineProbe
        .unsupportedSweepNodeReservedV2ColorPayloadColrV1
        ?.textV2Validation,
      unsupportedCompositeNodeV2ColrV1Validation: canvas2dGlyphOutlineProbe
        .unsupportedCompositeNodeReservedV2ColorPayloadColrV1
        ?.textV2Validation,
      unsupportedClipNodeV2ColrV1Validation: canvas2dGlyphOutlineProbe
        .unsupportedClipNodeReservedV2ColorPayloadColrV1
        ?.textV2Validation,
      sharedChildV2ColrV1Validation: canvas2dGlyphOutlineProbe
        .sharedChildReservedV2ColorPayloadColrV1
        ?.textV2Validation,
      unreachableNodeV2ColrV1Validation: canvas2dGlyphOutlineProbe
        .unreachableNodeReservedV2ColorPayloadColrV1
        ?.textV2Validation,
    })}`,
  );
  assert(
    invalidTransformReservedV2ColorPayloadColrV1IssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && invalidCommandReservedV2ColorPayloadColrV1IssueCodes.includes('glyphOutlinePayloadContractInvalid'),
    `Canvas2D strict profile rejects non-finite COLRv1 graph payload=${JSON.stringify({
      invalidTransformV2ColrV1Validation: canvas2dGlyphOutlineProbe
        .invalidTransformReservedV2ColorPayloadColrV1
        ?.textV2Validation,
      invalidCommandV2ColrV1Validation: canvas2dGlyphOutlineProbe
        .invalidCommandReservedV2ColorPayloadColrV1
        ?.textV2Validation,
    })}`,
  );
  const reservedOutlinePayloadFamilies = [
    {
      name: 'bitmap',
      sidecar: canvas2dGlyphOutlineProbe.reservedBitmapPayloadSidecar,
      v2: canvas2dGlyphOutlineProbe.reservedV2BitmapPayload,
      invalidV2: canvas2dGlyphOutlineProbe.invalidReservedV2BitmapPayload,
      reason: 'unsupportedBitmapGlyph',
      featureMissingExpected: false,
    },
    {
      name: 'svg',
      sidecar: canvas2dGlyphOutlineProbe.reservedSvgPayloadSidecar,
      v2: canvas2dGlyphOutlineProbe.reservedV2SvgPayload,
      invalidV2: canvas2dGlyphOutlineProbe.invalidReservedV2SvgPayload,
      reason: 'unsupportedSvgGlyph',
      featureMissingExpected: false,
    },
  ];
  for (const family of reservedOutlinePayloadFamilies) {
    const report = family.sidecar?.diagnostics?.find(
      (diagnostic) => diagnostic.equivalenceGroup === 'outline-fixture-0',
    );
    const issueCodes = family.v2?.textV2Validation?.map((issue) => issue.code) ?? [];
    const invalidIssueCodes = family.invalidV2?.textV2Validation?.map((issue) => issue.code) ?? [];
    assert(
      report?.selectedVariantId === 'textRun'
        && report?.rejectedVariants?.some(
          (variant) => variant.variantId === 'glyphOutline'
            && variant.reasons.includes(family.reason),
        )
        && report?.outlineEligibility?.payloadSupported === false
        && report?.outlineEligibility?.reason === family.reason
        && issueCodes.includes('glyphOutlinePayloadKindFeatureMissing') === family.featureMissingExpected
        && !issueCodes.includes('glyphOutlinePayloadContractInvalid')
        && invalidIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing') === family.featureMissingExpected
        && invalidIssueCodes.includes('glyphOutlinePayloadContractInvalid'),
      `Canvas2D strict profile rejects reserved ${family.name} outline payload=${JSON.stringify({
        report,
        sidecarValidation: family.sidecar?.textV2Validation,
        v2Validation: family.v2?.textV2Validation,
        invalidV2Validation: family.invalidV2?.textV2Validation,
      })}`,
    );
  }
  const invalidReservedV2BitmapTransformIssueCodes = canvas2dGlyphOutlineProbe
    .invalidReservedV2BitmapTransformPayload
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const invalidReservedV2BitmapBackendDefaultScalingIssueCodes = canvas2dGlyphOutlineProbe
    .invalidReservedV2BitmapBackendDefaultScalingPayload
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const validReservedV2BitmapOffsetTransformIssueCodes = canvas2dGlyphOutlineProbe
    .validReservedV2BitmapOffsetTransformPayload
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const invalidReservedV2BitmapRangeIssueCodes = canvas2dGlyphOutlineProbe
    .invalidReservedV2BitmapRangePayload
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const invalidReservedV2BitmapEmptyGlyphRangeIssueCodes = canvas2dGlyphOutlineProbe
    .invalidReservedV2BitmapEmptyGlyphRangePayload
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const invalidReservedV2BitmapResourceIssueCodes = canvas2dGlyphOutlineProbe
    .invalidReservedV2BitmapResourcePayload
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const invalidReservedV2BitmapPlacementIssueCodes = canvas2dGlyphOutlineProbe
    .invalidReservedV2BitmapPlacementPayload
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const invalidReservedV2BitmapAlphaIssueCodes = canvas2dGlyphOutlineProbe
    .invalidReservedV2BitmapAlphaPayload
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const invalidReservedV2BitmapScalingIssueCodes = canvas2dGlyphOutlineProbe
    .invalidReservedV2BitmapScalingPayload
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const invalidReservedV2BitmapScalingFilterValueIssueCodes = canvas2dGlyphOutlineProbe
    .invalidReservedV2BitmapScalingFilterValuePayload
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const invalidReservedV2BitmapFilteringIssueCodes = canvas2dGlyphOutlineProbe
    .invalidReservedV2BitmapFilteringPayload
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const invalidReservedV2BitmapMissingFilteringIssueCodes = canvas2dGlyphOutlineProbe
    .invalidReservedV2BitmapMissingFilteringPayload
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const invalidReservedV2BitmapStrikePpemIssueCodes = canvas2dGlyphOutlineProbe
    .invalidReservedV2BitmapStrikePpemPayload
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const invalidReservedV2BitmapDiagnosticStrikeIssueCodes = canvas2dGlyphOutlineProbe
    .invalidReservedV2BitmapDiagnosticStrikePayload
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const invalidReservedV2BitmapStrikeReselectionIssueCodes = canvas2dGlyphOutlineProbe
    .invalidReservedV2BitmapStrikeReselectionPayload
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const mixedReservedV2BitmapIssueCodes = canvas2dGlyphOutlineProbe
    .mixedReservedV2BitmapPayload
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  assert(
    invalidReservedV2BitmapTransformIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidReservedV2BitmapTransformIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && invalidReservedV2BitmapBackendDefaultScalingIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidReservedV2BitmapBackendDefaultScalingIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && !validReservedV2BitmapOffsetTransformIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !validReservedV2BitmapOffsetTransformIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && invalidReservedV2BitmapRangeIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidReservedV2BitmapRangeIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && invalidReservedV2BitmapEmptyGlyphRangeIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidReservedV2BitmapEmptyGlyphRangeIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && invalidReservedV2BitmapResourceIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidReservedV2BitmapResourceIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && invalidReservedV2BitmapPlacementIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidReservedV2BitmapPlacementIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && invalidReservedV2BitmapAlphaIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidReservedV2BitmapAlphaIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && invalidReservedV2BitmapScalingIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidReservedV2BitmapScalingIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && invalidReservedV2BitmapScalingFilterValueIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidReservedV2BitmapScalingFilterValueIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && invalidReservedV2BitmapFilteringIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidReservedV2BitmapFilteringIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && invalidReservedV2BitmapMissingFilteringIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidReservedV2BitmapMissingFilteringIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && invalidReservedV2BitmapStrikePpemIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidReservedV2BitmapStrikePpemIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && invalidReservedV2BitmapDiagnosticStrikeIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidReservedV2BitmapDiagnosticStrikeIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && invalidReservedV2BitmapStrikeReselectionIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidReservedV2BitmapStrikeReselectionIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && mixedReservedV2BitmapIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !mixedReservedV2BitmapIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing'),
    `Canvas2D strict profile validates BitmapGlyph transform contract=${JSON.stringify({
      invalidV2BitmapTransformValidation: canvas2dGlyphOutlineProbe.invalidReservedV2BitmapTransformPayload
        ?.textV2Validation,
      invalidV2BitmapBackendDefaultScalingValidation: canvas2dGlyphOutlineProbe
        .invalidReservedV2BitmapBackendDefaultScalingPayload
        ?.textV2Validation,
      validV2BitmapOffsetTransformValidation: canvas2dGlyphOutlineProbe
        .validReservedV2BitmapOffsetTransformPayload
        ?.textV2Validation,
      invalidV2BitmapRangeValidation: canvas2dGlyphOutlineProbe.invalidReservedV2BitmapRangePayload
        ?.textV2Validation,
      invalidV2BitmapEmptyGlyphRangeValidation: canvas2dGlyphOutlineProbe
        .invalidReservedV2BitmapEmptyGlyphRangePayload
        ?.textV2Validation,
      invalidV2BitmapResourceValidation: canvas2dGlyphOutlineProbe.invalidReservedV2BitmapResourcePayload
        ?.textV2Validation,
      invalidV2BitmapPlacementValidation: canvas2dGlyphOutlineProbe
        .invalidReservedV2BitmapPlacementPayload
        ?.textV2Validation,
      invalidV2BitmapAlphaValidation: canvas2dGlyphOutlineProbe.invalidReservedV2BitmapAlphaPayload
        ?.textV2Validation,
      invalidV2BitmapScalingValidation: canvas2dGlyphOutlineProbe.invalidReservedV2BitmapScalingPayload
        ?.textV2Validation,
      invalidV2BitmapScalingFilterValueValidation: canvas2dGlyphOutlineProbe
        .invalidReservedV2BitmapScalingFilterValuePayload
        ?.textV2Validation,
      invalidV2BitmapFilteringValidation: canvas2dGlyphOutlineProbe.invalidReservedV2BitmapFilteringPayload
        ?.textV2Validation,
      invalidV2BitmapMissingFilteringValidation: canvas2dGlyphOutlineProbe
        .invalidReservedV2BitmapMissingFilteringPayload
        ?.textV2Validation,
      invalidV2BitmapStrikePpemValidation: canvas2dGlyphOutlineProbe
        .invalidReservedV2BitmapStrikePpemPayload
        ?.textV2Validation,
      invalidV2BitmapDiagnosticStrikeValidation: canvas2dGlyphOutlineProbe
        .invalidReservedV2BitmapDiagnosticStrikePayload
        ?.textV2Validation,
      invalidV2BitmapStrikeReselectionValidation: canvas2dGlyphOutlineProbe
        .invalidReservedV2BitmapStrikeReselectionPayload
        ?.textV2Validation,
      mixedV2BitmapValidation: canvas2dGlyphOutlineProbe.mixedReservedV2BitmapPayload
        ?.textV2Validation,
    })}`,
  );
  const invalidReservedV2SvgViewBoxIssueCodes = canvas2dGlyphOutlineProbe
    .invalidReservedV2SvgViewBoxPayload
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const invalidReservedV2SvgUnsafeFlagsIssueCodes = canvas2dGlyphOutlineProbe
    .invalidReservedV2SvgUnsafeFlagsPayload
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const invalidReservedV2SvgIntrinsicSizeIssueCodes = canvas2dGlyphOutlineProbe
    .invalidReservedV2SvgIntrinsicSizePayload
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const invalidReservedV2SvgRangeIssueCodes = canvas2dGlyphOutlineProbe
    .invalidReservedV2SvgRangePayload
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const invalidReservedV2SvgEmptyGlyphRangeIssueCodes = canvas2dGlyphOutlineProbe
    .invalidReservedV2SvgEmptyGlyphRangePayload
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const invalidReservedV2SvgResourceIssueCodes = canvas2dGlyphOutlineProbe
    .invalidReservedV2SvgResourcePayload
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const invalidReservedV2SvgRawInlineIssueCodes = canvas2dGlyphOutlineProbe
    .invalidReservedV2SvgRawInlinePayload
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const invalidReservedV2SvgTransformIssueCodes = canvas2dGlyphOutlineProbe
    .invalidReservedV2SvgTransformPayload
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const invalidReservedV2SvgSecurityModeIssueCodes = canvas2dGlyphOutlineProbe
    .invalidReservedV2SvgSecurityModePayload
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const validReservedV2SvgTransformIssueCodes = canvas2dGlyphOutlineProbe
    .validReservedV2SvgTransformPayload
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const mixedReservedV2SvgIssueCodes = canvas2dGlyphOutlineProbe
    .mixedReservedV2SvgPayload
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  assert(
    invalidReservedV2SvgViewBoxIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidReservedV2SvgViewBoxIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && invalidReservedV2SvgUnsafeFlagsIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidReservedV2SvgUnsafeFlagsIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && invalidReservedV2SvgIntrinsicSizeIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidReservedV2SvgIntrinsicSizeIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && invalidReservedV2SvgRangeIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidReservedV2SvgRangeIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && invalidReservedV2SvgEmptyGlyphRangeIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidReservedV2SvgEmptyGlyphRangeIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && invalidReservedV2SvgResourceIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidReservedV2SvgResourceIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && invalidReservedV2SvgRawInlineIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidReservedV2SvgRawInlineIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && invalidReservedV2SvgTransformIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidReservedV2SvgTransformIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && invalidReservedV2SvgSecurityModeIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidReservedV2SvgSecurityModeIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && !validReservedV2SvgTransformIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !validReservedV2SvgTransformIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && mixedReservedV2SvgIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !mixedReservedV2SvgIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing'),
    `Canvas2D strict profile validates SvgGlyph transform contract=${JSON.stringify({
      invalidV2SvgViewBoxValidation: canvas2dGlyphOutlineProbe.invalidReservedV2SvgViewBoxPayload
        ?.textV2Validation,
      invalidV2SvgUnsafeFlagsValidation: canvas2dGlyphOutlineProbe.invalidReservedV2SvgUnsafeFlagsPayload
        ?.textV2Validation,
      invalidV2SvgIntrinsicSizeValidation: canvas2dGlyphOutlineProbe
        .invalidReservedV2SvgIntrinsicSizePayload
        ?.textV2Validation,
      invalidV2SvgRangeValidation: canvas2dGlyphOutlineProbe.invalidReservedV2SvgRangePayload
        ?.textV2Validation,
      invalidV2SvgEmptyGlyphRangeValidation: canvas2dGlyphOutlineProbe
        .invalidReservedV2SvgEmptyGlyphRangePayload
        ?.textV2Validation,
      invalidV2SvgResourceValidation: canvas2dGlyphOutlineProbe.invalidReservedV2SvgResourcePayload
        ?.textV2Validation,
      invalidV2SvgRawInlineValidation: canvas2dGlyphOutlineProbe.invalidReservedV2SvgRawInlinePayload
        ?.textV2Validation,
      invalidV2SvgTransformValidation: canvas2dGlyphOutlineProbe.invalidReservedV2SvgTransformPayload
        ?.textV2Validation,
      invalidV2SvgSecurityModeValidation: canvas2dGlyphOutlineProbe
        .invalidReservedV2SvgSecurityModePayload
        ?.textV2Validation,
      validV2SvgTransformValidation: canvas2dGlyphOutlineProbe.validReservedV2SvgTransformPayload
        ?.textV2Validation,
      mixedV2SvgValidation: canvas2dGlyphOutlineProbe.mixedReservedV2SvgPayload
        ?.textV2Validation,
    })}`,
  );
  const v2FallbackReport = canvas2dGlyphOutlineProbe.v2Fallback?.diagnostics?.find(
    (report) => report.equivalenceGroup === 'op-text-v2-outline',
  );
  assert(
    v2FallbackReport?.selectedVariantId === 'textRun'
      && v2FallbackReport?.selectedVariantKind === 'textRun'
      && v2FallbackReport?.selectedReason === 'defaultTextRunFallback'
      && v2FallbackReport?.partsExpected === 1
      && v2FallbackReport?.partsReplayed === 1
      && v2FallbackReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('backendDoesNotSupportVariant'),
      ),
    `Canvas2D default profile reads schema v2 Text envelope as fallback=${JSON.stringify(v2FallbackReport)}`,
  );
  const v2StrictReport = canvas2dGlyphOutlineProbe.v2Strict?.diagnostics?.find(
    (report) => report.equivalenceGroup === 'op-text-v2-outline',
  );
  assert(
    v2StrictReport?.selectedVariantId === 'glyphOutline'
      && v2StrictReport?.selectedVariantKind === 'glyphOutline'
      && v2StrictReport?.selectedReason === 'glyphOutlineStrictProfile'
      && v2StrictReport?.anchorOpId === 'op-text-v2-outline'
      && v2StrictReport?.partsExpected === 1
      && v2StrictReport?.partsReplayed === 1
      && v2StrictReport?.parts?.some(
        (part) => part.variantId === 'glyphOutline'
          && part.variantKind === 'glyphOutline'
          && part.replayable === true
          && part.outlineEligibility?.replayEligible === true,
      ),
    `Canvas2D strict profile selects schema v2 Text GlyphOutline variant=${JSON.stringify(v2StrictReport)}`,
  );
  assert(
    canvas2dGlyphOutlineProbe.v2Fallback?.textV2Validation?.length === 0
      && canvas2dGlyphOutlineProbe.v2Strict?.textV2Validation?.length === 0,
    `Canvas2D accepts valid schema v2 Text envelope validation=${JSON.stringify({
      fallback: canvas2dGlyphOutlineProbe.v2Fallback?.textV2Validation,
      strict: canvas2dGlyphOutlineProbe.v2Strict?.textV2Validation,
    })}`,
  );
  const invalidV2IssueCodes = canvas2dGlyphOutlineProbe.invalidV2MissingFallback?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  assert(
    invalidV2IssueCodes.includes('defaultVariantMissing')
      && invalidV2IssueCodes.includes('fallbackRequiredTextRunMissing'),
    `Canvas2D reports invalid schema v2 Text fallback contract=${JSON.stringify(
      canvas2dGlyphOutlineProbe.invalidV2MissingFallback?.textV2Validation,
    )}`,
  );
  const invalidV2PathMetadataIssueCodes = canvas2dGlyphOutlineProbe.invalidV2PathMetadata
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  assert(
    invalidV2PathMetadataIssueCodes.includes('glyphOutlinePayloadContractInvalid'),
    `Canvas2D reports invalid schema v2 GlyphOutline path metadata=${JSON.stringify(
      canvas2dGlyphOutlineProbe.invalidV2PathMetadata?.textV2Validation,
    )}`,
  );
  const invalidV2PathCommandIssueCodes = canvas2dGlyphOutlineProbe.invalidV2PathCommand
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  assert(
    invalidV2PathCommandIssueCodes.includes('glyphOutlinePayloadContractInvalid'),
    `Canvas2D reports invalid schema v2 GlyphOutline path commands=${JSON.stringify(
      canvas2dGlyphOutlineProbe.invalidV2PathCommand?.textV2Validation,
    )}`,
  );
  const invalidCrossScopeIssueCodes = canvas2dGlyphOutlineProbe.invalidV2CrossScope
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  assert(
    invalidCrossScopeIssueCodes.includes('crossScopeVariantFeatureMissing')
      && canvas2dGlyphOutlineProbe.allowedV2CrossScope?.textV2Validation?.length === 0,
    `Canvas2D schema v2 cross-scope variants require feature gate=${JSON.stringify({
      invalid: canvas2dGlyphOutlineProbe.invalidV2CrossScope?.textV2Validation,
      allowed: canvas2dGlyphOutlineProbe.allowedV2CrossScope?.textV2Validation,
    })}`,
  );
  const invalidMixedPerGlyphIssueCodes = canvas2dGlyphOutlineProbe.invalidV2MixedPerGlyph
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  assert(
    invalidMixedPerGlyphIssueCodes.includes('mixedPerGlyphFeatureMissing')
      && canvas2dGlyphOutlineProbe.allowedV2MixedPerGlyph?.textV2Validation?.length === 0,
    `Canvas2D schema v2 mixed-per-glyph orientation requires feature gate=${JSON.stringify({
      invalid: canvas2dGlyphOutlineProbe.invalidV2MixedPerGlyph?.textV2Validation,
      allowed: canvas2dGlyphOutlineProbe.allowedV2MixedPerGlyph?.textV2Validation,
    })}`,
  );
  const invalidFallbackFreeIssueCodes = canvas2dGlyphOutlineProbe.invalidV2FallbackFree
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  assert(
    invalidFallbackFreeIssueCodes.includes('fallbackFreeFeatureMissing')
      && canvas2dGlyphOutlineProbe.allowedV2FallbackFree?.textV2Validation?.length === 0,
    `Canvas2D schema v2 fallback-free text requires strictVisual feature gate=${JSON.stringify({
      invalid: canvas2dGlyphOutlineProbe.invalidV2FallbackFree?.textV2Validation,
      allowed: canvas2dGlyphOutlineProbe.allowedV2FallbackFree?.textV2Validation,
    })}`,
  );
  const invalidFallbackFreeCompatibilityIssueCodes = canvas2dGlyphOutlineProbe
    .invalidV2FallbackFreeCompatibilityProfile
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  assert(
    invalidFallbackFreeCompatibilityIssueCodes.includes('fallbackFreeFeatureMissing'),
    `Canvas2D schema v2 fallback-free text requires strictVisual profile=${JSON.stringify(
      canvas2dGlyphOutlineProbe.invalidV2FallbackFreeCompatibilityProfile?.textV2Validation,
    )}`,
  );
  const invalidFallbackFreeDisabledFlagIssueCodes = canvas2dGlyphOutlineProbe
    .invalidV2FallbackFreeDisabledFlag
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  assert(
    invalidFallbackFreeDisabledFlagIssueCodes.includes('fallbackFreeFeatureMissing'),
    `Canvas2D schema v2 fallback-free text requires strictVisualFallbackFree metadata=${JSON.stringify(
      canvas2dGlyphOutlineProbe.invalidV2FallbackFreeDisabledFlag?.textV2Validation,
    )}`,
  );
  const invalidFallbackFreeTextOnlyIssueCodes = canvas2dGlyphOutlineProbe.invalidV2FallbackFreeTextOnly
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  assert(
    invalidFallbackFreeTextOnlyIssueCodes.includes('strictVisualVariantMissing')
      && !invalidFallbackFreeTextOnlyIssueCodes.includes('fallbackFreeFeatureMissing'),
    `Canvas2D schema v2 fallback-free text fails closed without strict visual variant=${JSON.stringify(
      canvas2dGlyphOutlineProbe.invalidV2FallbackFreeTextOnly?.textV2Validation,
    )}`,
  );
  const unsupportedOutlineReport = canvas2dGlyphOutlineProbe.unsupported?.diagnostics?.find(
    (report) => report.equivalenceGroup === 'outline-fixture-0',
  );
  assert(
    unsupportedOutlineReport?.selectedVariantId === 'textRun'
      && unsupportedOutlineReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedPaintEffect'),
      )
      && unsupportedOutlineReport?.outlineEligibility?.payloadSupported === true
      && unsupportedOutlineReport?.outlineEligibility?.paintStyleSupported === false
      && unsupportedOutlineReport?.outlineEligibility?.replayEligible === false,
    `Canvas2D unsupported outline style falls back=${JSON.stringify(unsupportedOutlineReport)}`,
  );
  const unsupportedPayloadOutlineReport = canvas2dGlyphOutlineProbe.unsupportedPayload?.diagnostics?.find(
    (report) => report.equivalenceGroup === 'outline-fixture-0',
  );
  assert(
    unsupportedPayloadOutlineReport?.selectedVariantId === 'textRun'
      && unsupportedPayloadOutlineReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedOutlinePayload'),
      )
      && unsupportedPayloadOutlineReport?.outlineEligibility?.payloadSupported === false
      && unsupportedPayloadOutlineReport?.outlineEligibility?.paintStyleSupported === true
      && unsupportedPayloadOutlineReport?.outlineEligibility?.replayEligible === false,
    `Canvas2D unsupported outline payload falls back=${JSON.stringify(unsupportedPayloadOutlineReport)}`,
  );
  const strictOutlineBlackPixels = countPixels(
    canvas2dGlyphOutlineProbe.strict.png,
    (pixel) => pixel.alpha > 32 && pixel.red < 80 && pixel.green < 80 && pixel.blue < 80,
  );
  const unsupportedOutlineBlackPixels = countPixels(
    canvas2dGlyphOutlineProbe.unsupported.png,
    (pixel) => pixel.alpha > 32 && pixel.red < 80 && pixel.green < 80 && pixel.blue < 80,
  );
  const strictSidecarOutlineBlackPixels = countPixels(
    canvas2dGlyphOutlineProbe.strictSidecar.png,
    (pixel) => pixel.alpha > 32 && pixel.red < 80 && pixel.green < 80 && pixel.blue < 80,
  );
  const strokePayloadBlackPixels = countPixels(
    canvas2dGlyphOutlineProbe.strokePayloadSidecar.png,
    (pixel) => pixel.alpha > 32 && pixel.red < 80 && pixel.green < 80 && pixel.blue < 80,
  );
  const colorPayloadBluePixels = countPixels(
    canvas2dGlyphOutlineProbe.colorPayloadSidecar.png,
    (pixel) => pixel.alpha > 32 && pixel.blue > 150 && pixel.red < 100 && pixel.green < 120,
  );
  const colorV1PayloadGreenPixels = countPixels(
    canvas2dGlyphOutlineProbe.colorV1PayloadSidecar.png,
    (pixel) => pixel.alpha > 32 && pixel.green > 120 && pixel.red < 100 && pixel.blue < 100,
  );
  const colorV1GradientRedPixels = countPixels(
    canvas2dGlyphOutlineProbe.colorV1GradientPayloadSidecar.png,
    (pixel) => pixel.alpha > 32 && pixel.red > 150 && pixel.green < 100 && pixel.blue < 120,
  );
  const colorV1GradientBluePixels = countPixels(
    canvas2dGlyphOutlineProbe.colorV1GradientPayloadSidecar.png,
    (pixel) => pixel.alpha > 32 && pixel.blue > 150 && pixel.green < 100 && pixel.red < 120,
  );
  const unsupportedStrokePayloadBlackPixels = countPixels(
    canvas2dGlyphOutlineProbe.unsupportedStrokePayloadSidecar.png,
    (pixel) => pixel.alpha > 32 && pixel.red < 80 && pixel.green < 80 && pixel.blue < 80,
  );
  const unsupportedStrokeJoinCapBlackPixels = countPixels(
    canvas2dGlyphOutlineProbe.unsupportedStrokeJoinCapSidecar.png,
    (pixel) => pixel.alpha > 32 && pixel.red < 80 && pixel.green < 80 && pixel.blue < 80,
  );
  const missingStrokePayloadBlackPixels = countPixels(
    canvas2dGlyphOutlineProbe.missingStrokePayloadSidecar.png,
    (pixel) => pixel.alpha > 32 && pixel.red < 80 && pixel.green < 80 && pixel.blue < 80,
  );
  const v2StrictBlackPixels = countPixels(
    canvas2dGlyphOutlineProbe.v2Strict.png,
    (pixel) => pixel.alpha > 32 && pixel.red < 80 && pixel.green < 80 && pixel.blue < 80,
  );
  assert(
    strictOutlineBlackPixels > 100 && unsupportedOutlineBlackPixels < 20,
    `Canvas2D strict outline paints only eligible paths black=${strictOutlineBlackPixels}, unsupportedBlack=${unsupportedOutlineBlackPixels}`,
  );
  assert(
    strictSidecarOutlineBlackPixels > 100,
    `Canvas2D strict outline paints variantOps sidecar paths black=${strictSidecarOutlineBlackPixels}`,
  );
  assert(
    strokePayloadBlackPixels > 100,
    `Canvas2D strict outline paints supported stroke payload black=${strokePayloadBlackPixels}`,
  );
  assert(
    colorPayloadBluePixels > 20,
    `Canvas2D strict outline paints COLRv0 color payload blue=${colorPayloadBluePixels}`,
  );
  assert(
    colorV1PayloadGreenPixels > 20,
    `Canvas2D strict outline paints COLRv1 stage-1 color graph green=${colorV1PayloadGreenPixels}`,
  );
  assert(
    colorV1GradientRedPixels > 5 && colorV1GradientBluePixels > 5,
    `Canvas2D strict outline paints COLRv1 gradient graph red=${colorV1GradientRedPixels}, blue=${colorV1GradientBluePixels}`,
  );
  assert(
    unsupportedStrokePayloadBlackPixels < 20,
    `Canvas2D strict outline does not replay unsupported stroke payload black=${unsupportedStrokePayloadBlackPixels}`,
  );
  assert(
    unsupportedStrokeJoinCapBlackPixels < 20,
    `Canvas2D strict outline does not replay unsupported stroke join/cap payload black=${unsupportedStrokeJoinCapBlackPixels}`,
  );
  assert(
    missingStrokePayloadBlackPixels < 20,
    `Canvas2D strict outline does not replay missing stroke payload black=${missingStrokePayloadBlackPixels}`,
  );
  assert(
    v2StrictBlackPixels > 100,
    `Canvas2D strict outline paints schema v2 Text variant path black=${v2StrictBlackPixels}`,
  );

  setTestCase('canvaskit-glyph-outline-strict-profile');
  await loadApp(page, '?renderer=canvaskit&canvaskitMode=default&canvaskitSurface=software');
  const canvaskitGlyphOutlineProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const renderer = pageRenderer?.canvaskitRenderer;
    if (!renderer) {
      return { error: 'CanvasKit renderer unavailable' };
    }

    const style = (color) => ({
      fontFamily: 'Noto Sans KR',
      fontSize: 20,
      color,
      bold: false,
      italic: false,
      ratio: 1,
      underline: 'none',
      underlineShape: 0,
      strikethrough: false,
      strikeShape: 0,
      outlineType: 0,
      shadowType: 0,
      shadowColor: '#000000',
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      emboss: false,
      engrave: false,
      emphasisDot: 0,
      underlineColor: color,
      strikeColor: color,
      shadeColor: '#ffffff',
    });
    const source = { id: 1901, utf8Range: { start: 0, end: 1 }, utf16Range: { start: 0, end: 1 } };
    const outlinePath = {
      glyphId: 42,
      sourceRangeUtf8: { start: 0, end: 1 },
      glyphRange: { start: 0, end: 1 },
      fillRule: 'nonzero',
      commands: [
        { type: 'moveTo', x: 0, y: 0 },
        { type: 'lineTo', x: 18, y: 0 },
        { type: 'lineTo', x: 18, y: 18 },
        { type: 'lineTo', x: 0, y: 18 },
        { type: 'closePath' },
      ],
    };
    const pixelCanvas = document.createElement('canvas');
    pixelCanvas.width = 1;
    pixelCanvas.height = 1;
    const pixelContext = pixelCanvas.getContext('2d');
    if (!pixelContext) {
      return { error: 'bitmap fixture canvas unavailable' };
    }
    pixelContext.fillStyle = '#000000';
    pixelContext.fillRect(0, 0, 1, 1);
    const pixelPngBase64 = pixelCanvas.toDataURL('image/png').split(',')[1];
    const pixelBytes = Uint8Array.from(atob(pixelPngBase64), (ch) => ch.charCodeAt(0));
    const variantFor = (group, kind, extra = {}) => ({
      equivalenceGroup: group,
      variantId: kind,
      variantKind: kind,
      partIndex: 0,
      partCount: 1,
      isDefaultFallback: kind === 'textRun',
      quality: 'exact',
      ...extra,
    });
    const textRunFor = (group) => ({
      id: `op-text-${group}`,
      type: 'textRun',
      bbox: { x: 8, y: 22, width: 40, height: 28 },
      source,
      variant: variantFor(group, 'textRun'),
      text: 'A',
      baseline: 44,
      rotation: 0,
      isVertical: false,
      orientation: 'horizontal',
      projectionKind: 'verbatim',
      clusterBasis: 'legacyPosition',
      style: style('#dd0000'),
      paintStyle: style('#dd0000'),
      positions: [0, 22],
      controlMarks: [],
      tabLeaders: [],
    });
    const outlineFor = (group, overrides = {}) => ({
      id: `op-outline-${group}`,
      type: 'glyphOutline',
      bbox: { x: 8, y: 8, width: 24, height: 24 },
      source,
      variant: variantFor(group, 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.monochromeFill'],
        anchorOpId: `op-text-${group}`,
        localPaintOrder: 0,
      }),
      paintStyle: style('#000000'),
      placement: {
        runToPage: { a: 1, b: 0, c: 0, d: 1, e: 8, f: 8 },
        baselineY: 0,
      },
      paths: [outlinePath],
      diagnostics: {
        quality: 'exact',
        replayEligibility: 'portable',
        strictVisualEligible: true,
        maxOriginDeltaPx: 0,
        maxAdvanceDeltaPx: 0,
        maxResidualAfterAdjustmentPx: 0,
        clusterMismatchCount: 0,
        missingGlyphCount: 0,
        usedFallbackFontCount: 0,
      },
      ...overrides,
    });
    const treeFor = (outline) => ({
      pageWidth: 64,
      pageHeight: 64,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1901,
        images: [pixelBytes],
        imageHashes: ['bitmap-glyph-pixel'],
        imageKeys: ['bitmap-glyph-pixel'],
        svgFragments: ['<path d="M0 0 L18 0 L18 18 L0 18 Z" fill="#ff00cc"/>'],
        svgHashes: ['svg-glyph-magenta-square'],
        svgKeys: ['svg-glyph-magenta-square'],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [{
        id: 1901,
        text: 'A',
        utf8Range: { start: 0, end: 1 },
        utf16Range: { start: 0, end: 1 },
        annotations: [],
      }],
      root: {
        kind: 'leaf',
        sourceNodeId: 1901,
        bounds: { x: 0, y: 0, width: 64, height: 64 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 64, height: 64 }, backgroundColor: '#ffffff', borderWidth: 0 },
          textRunFor(outline.variant.equivalenceGroup),
          outline,
        ],
      },
    });
    const render = async (tree) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await new Promise((resolve) => setTimeout(resolve, 50));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const imageData = canvas.getContext('2d')?.getImageData(0, 0, tree.pageWidth, tree.pageHeight).data;
      let blackPixels = 0;
      let bluePixels = 0;
      let redPixels = 0;
      let magentaPixels = 0;
      if (imageData) {
        for (let offset = 0; offset < imageData.length; offset += 4) {
          const red = imageData[offset];
          const green = imageData[offset + 1];
          const blue = imageData[offset + 2];
          const alpha = imageData[offset + 3];
          if (alpha > 32 && red < 80 && green < 80 && blue < 80) {
            blackPixels += 1;
          }
          if (alpha > 32 && blue > 150 && red < 100 && green < 120) {
            bluePixels += 1;
          }
          if (alpha > 32 && red > 150 && green < 80 && blue < 80) {
            redPixels += 1;
          }
          if (alpha > 32 && red > 150 && green < 80 && blue > 120) {
            magentaPixels += 1;
          }
        }
      }
      const png = canvas.toDataURL('image/png');
      const diagnostics = renderer.getTextVariantSelectionDiagnostics();
      canvas.remove();
      return { png, diagnostics, blackPixels, bluePixels, redPixels, magentaPixels };
    };

    const strokeOutline = outlineFor('canvaskit-outline-stroke', {
      payloadKind: 'monochromeFillStroke',
      variant: variantFor('canvaskit-outline-stroke', 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.monochromeFillStroke'],
        anchorOpId: 'op-text-canvaskit-outline-stroke',
        localPaintOrder: 0,
      }),
      stroke: {
        widthPx: 3,
        color: '#0000ff',
        opacity: 1,
        join: 'miter',
        cap: 'butt',
        miterLimit: 4,
        paintOrder: 'fillThenStroke',
      },
    });
    const unsupportedStrokeJoinCapOutline = outlineFor('canvaskit-outline-stroke-unsupported-join-cap', {
      payloadKind: 'monochromeFillStroke',
      variant: variantFor('canvaskit-outline-stroke-unsupported-join-cap', 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.monochromeFillStroke'],
        anchorOpId: 'op-text-canvaskit-outline-stroke-unsupported-join-cap',
        localPaintOrder: 0,
      }),
      stroke: {
        widthPx: 3,
        color: '#0000ff',
        opacity: 1,
        join: 'round',
        cap: 'square',
        miterLimit: 4,
        paintOrder: 'fillThenStroke',
      },
    });
    const missingStrokeOutline = outlineFor('canvaskit-outline-stroke-missing-style', {
      payloadKind: 'monochromeFillStroke',
      variant: variantFor('canvaskit-outline-stroke-missing-style', 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.monochromeFillStroke'],
        anchorOpId: 'op-text-canvaskit-outline-stroke-missing-style',
        localPaintOrder: 0,
      }),
    });
    const colorOutline = outlineFor('canvaskit-outline-color', {
      payloadKind: 'colorLayers',
      variant: variantFor('canvaskit-outline-color', 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.colorLayers', 'text.glyphOutline.colorLayers.colrV0'],
        anchorOpId: 'op-text-canvaskit-outline-color',
        localPaintOrder: 0,
      }),
      paths: [],
      colorLayers: {
        colorFormat: 'colrV0',
        sourceFontRef: { faceKey: 'fixture-face', glyphId: 42, colorFormat: 'colrV0' },
        paletteRef: { index: 0, cpalDigest: 'fixture-cpal' },
        sourceRangeUtf8: { start: 0, end: 1 },
        glyphRange: { start: 0, end: 1 },
        layers: [{
          layerIndex: 0,
          glyphId: 77,
          glyphRange: { start: 0, end: 1 },
          sourceRangeUtf8: { start: 0, end: 1 },
          sourceFontRef: { faceKey: 'fixture-face', glyphId: 77, paletteIndex: 3, colorFormat: 'colrV0' },
          commands: outlinePath.commands,
          fill: { rgba: [0, 0, 1, 1] },
          fillRule: 'nonzero',
          paletteIndex: 3,
        }],
      },
    });
    const colorV1Outline = outlineFor('canvaskit-outline-color-v1', {
      payloadKind: 'colorLayers',
      variant: variantFor('canvaskit-outline-color-v1', 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.colorLayers', 'text.glyphOutline.colorLayers.colrV1'],
        anchorOpId: 'op-text-canvaskit-outline-color-v1',
        localPaintOrder: 0,
      }),
      paths: [],
      colorLayers: {
        colorFormat: 'colrV1',
        sourceFontRef: { faceKey: 'fixture-face', glyphId: 42, colorFormat: 'colrV1' },
        paletteRef: { index: 0, cpalDigest: 'fixture-cpal' },
        sourceRangeUtf8: { start: 0, end: 1 },
        glyphRange: { start: 0, end: 1 },
        layers: [],
        paintGraph: {
          rootNodeId: 1,
          nodes: [
            {
              nodeId: 1,
              kind: 'transform',
              transform: {
                childNodeId: 2,
                transform: { a: 1, b: 0, c: 0, d: 1, e: 4, f: 4 },
              },
              sourceRangeUtf8: { start: 0, end: 1 },
              glyphRange: { start: 0, end: 1 },
              sourceFontRef: { faceKey: 'fixture-face', glyphId: 42, colorFormat: 'colrV1' },
            },
            {
              nodeId: 2,
              kind: 'solidPath',
              solidPath: {
                commands: outlinePath.commands,
                fill: { rgba: [0, 0.75, 0, 1] },
                fillRule: 'nonzero',
                sourceGlyphId: 77,
                paletteIndex: 5,
              },
              sourceRangeUtf8: { start: 0, end: 1 },
              glyphRange: { start: 0, end: 1 },
              sourceFontRef: { faceKey: 'fixture-face', glyphId: 77, paletteIndex: 5, colorFormat: 'colrV1' },
            },
          ],
        },
      },
    });
    const colorV1GradientOutline = outlineFor('canvaskit-outline-color-v1-gradient', {
      payloadKind: 'colorLayers',
      variant: variantFor('canvaskit-outline-color-v1-gradient', 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.colorLayers', 'text.glyphOutline.colorLayers.colrV1'],
        anchorOpId: 'op-text-canvaskit-outline-color-v1-gradient',
        localPaintOrder: 0,
      }),
      paths: [],
      colorLayers: {
        colorFormat: 'colrV1',
        sourceFontRef: { faceKey: 'fixture-face', glyphId: 42, colorFormat: 'colrV1' },
        paletteRef: { index: 0, cpalDigest: 'fixture-cpal' },
        sourceRangeUtf8: { start: 0, end: 1 },
        glyphRange: { start: 0, end: 1 },
        layers: [],
        paintGraph: {
          rootNodeId: 1,
          nodes: [
            {
              nodeId: 1,
              kind: 'transform',
              transform: {
                childNodeId: 2,
                transform: { a: 1, b: 0, c: 0, d: 1, e: 4, f: 4 },
              },
            },
            {
              nodeId: 2,
              kind: 'linearGradientPath',
              linearGradientPath: {
                commands: outlinePath.commands,
                gradient: {
                  x0: 0,
                  y0: 0,
                  x1: 18,
                  y1: 0,
                  stops: [
                    { offset: 0, color: { rgba: [1, 0, 0, 1] } },
                    { offset: 1, color: { rgba: [0, 0, 1, 1] } },
                  ],
                },
                fillRule: 'nonzero',
                sourceGlyphId: 77,
                paletteIndex: 5,
              },
              sourceRangeUtf8: { start: 0, end: 1 },
              glyphRange: { start: 0, end: 1 },
              sourceFontRef: { faceKey: 'fixture-face', glyphId: 77, paletteIndex: 5, colorFormat: 'colrV1' },
            },
          ],
        },
      },
    });
    const bitmapOutline = outlineFor('canvaskit-outline-bitmap', {
      payloadKind: 'bitmapGlyph',
      variant: variantFor('canvaskit-outline-bitmap', 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.bitmapGlyph'],
        anchorOpId: 'op-text-canvaskit-outline-bitmap',
        localPaintOrder: 0,
      }),
      bitmapGlyph: {
        imageResourceId: 'bitmap-glyph-pixel',
        sourceRangeUtf8: { start: 0, end: 1 },
        glyphRange: { start: 0, end: 1 },
        placement: {
          runToPage: { a: 1, b: 0, c: 0, d: 1, e: 8, f: 8 },
          baselineY: 0,
        },
        strikePpem: [16, 16],
        strikeSelection: 'producerResolved',
        alphaMode: 'premultiplied',
        scalingPolicy: 'scaleToEm',
        filtering: 'nearest',
      },
    });
    const nonpositiveBitmapBBoxOutline = outlineFor('canvaskit-outline-bitmap-empty-bbox', {
      payloadKind: 'bitmapGlyph',
      bbox: { x: 8, y: 8, width: 0, height: 24 },
      variant: variantFor('canvaskit-outline-bitmap-empty-bbox', 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.bitmapGlyph'],
        anchorOpId: 'op-text-canvaskit-outline-bitmap-empty-bbox',
        localPaintOrder: 0,
      }),
      bitmapGlyph: {
        ...bitmapOutline.bitmapGlyph,
      },
    });
    const missingFilteringBitmapOutline = outlineFor('canvaskit-outline-bitmap-missing-filtering', {
      payloadKind: 'bitmapGlyph',
      variant: variantFor('canvaskit-outline-bitmap-missing-filtering', 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.bitmapGlyph'],
        anchorOpId: 'op-text-canvaskit-outline-bitmap-missing-filtering',
        localPaintOrder: 0,
      }),
      bitmapGlyph: {
        ...bitmapOutline.bitmapGlyph,
        filtering: undefined,
      },
    });
    const missingScalingBitmapOutline = outlineFor('canvaskit-outline-bitmap-missing-scaling', {
      payloadKind: 'bitmapGlyph',
      variant: variantFor('canvaskit-outline-bitmap-missing-scaling', 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.bitmapGlyph'],
        anchorOpId: 'op-text-canvaskit-outline-bitmap-missing-scaling',
        localPaintOrder: 0,
      }),
      bitmapGlyph: {
        ...bitmapOutline.bitmapGlyph,
        scalingPolicy: undefined,
      },
    });
    const invalidTransformBitmapOutline = outlineFor('canvaskit-outline-bitmap-invalid-transform', {
      payloadKind: 'bitmapGlyph',
      variant: variantFor('canvaskit-outline-bitmap-invalid-transform', 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.bitmapGlyph'],
        anchorOpId: 'op-text-canvaskit-outline-bitmap-invalid-transform',
        localPaintOrder: 0,
      }),
      bitmapGlyph: {
        ...bitmapOutline.bitmapGlyph,
        transformToRun: { a: 1, b: 0, c: 0, d: Number.POSITIVE_INFINITY, e: 0, f: 0 },
      },
    });
    const invalidSourceRangeBitmapOutline = outlineFor('canvaskit-outline-bitmap-invalid-source-range', {
      payloadKind: 'bitmapGlyph',
      variant: variantFor('canvaskit-outline-bitmap-invalid-source-range', 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.bitmapGlyph'],
        anchorOpId: 'op-text-canvaskit-outline-bitmap-invalid-source-range',
        localPaintOrder: 0,
      }),
      bitmapGlyph: {
        ...bitmapOutline.bitmapGlyph,
        sourceRangeUtf8: { start: 2, end: 1 },
      },
    });
    const emptyGlyphRangeBitmapOutline = outlineFor('canvaskit-outline-bitmap-empty-glyph-range', {
      payloadKind: 'bitmapGlyph',
      variant: variantFor('canvaskit-outline-bitmap-empty-glyph-range', 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.bitmapGlyph'],
        anchorOpId: 'op-text-canvaskit-outline-bitmap-empty-glyph-range',
        localPaintOrder: 0,
      }),
      bitmapGlyph: {
        ...bitmapOutline.bitmapGlyph,
        glyphRange: { start: 1, end: 1 },
      },
    });
    const missingBaselineBitmapOutline = outlineFor('canvaskit-outline-bitmap-missing-baseline', {
      payloadKind: 'bitmapGlyph',
      variant: variantFor('canvaskit-outline-bitmap-missing-baseline', 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.bitmapGlyph'],
        anchorOpId: 'op-text-canvaskit-outline-bitmap-missing-baseline',
        localPaintOrder: 0,
      }),
      bitmapGlyph: {
        ...bitmapOutline.bitmapGlyph,
        placement: {
          runToPage: { ...bitmapOutline.bitmapGlyph.placement.runToPage },
        },
      },
    });
    const missingAlphaBitmapOutline = outlineFor('canvaskit-outline-bitmap-missing-alpha', {
      payloadKind: 'bitmapGlyph',
      variant: variantFor('canvaskit-outline-bitmap-missing-alpha', 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.bitmapGlyph'],
        anchorOpId: 'op-text-canvaskit-outline-bitmap-missing-alpha',
        localPaintOrder: 0,
      }),
      bitmapGlyph: {
        ...bitmapOutline.bitmapGlyph,
        alphaMode: undefined,
      },
    });
    const emptyColorSpaceBitmapOutline = outlineFor('canvaskit-outline-bitmap-empty-color-space', {
      payloadKind: 'bitmapGlyph',
      variant: variantFor('canvaskit-outline-bitmap-empty-color-space', 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.bitmapGlyph'],
        anchorOpId: 'op-text-canvaskit-outline-bitmap-empty-color-space',
        localPaintOrder: 0,
      }),
      bitmapGlyph: {
        ...bitmapOutline.bitmapGlyph,
        colorSpace: '',
      },
    });
    const backendDefaultScalingBitmapOutline = outlineFor('canvaskit-outline-bitmap-backend-default-scaling', {
      payloadKind: 'bitmapGlyph',
      variant: variantFor('canvaskit-outline-bitmap-backend-default-scaling', 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.bitmapGlyph'],
        anchorOpId: 'op-text-canvaskit-outline-bitmap-backend-default-scaling',
        localPaintOrder: 0,
      }),
      bitmapGlyph: {
        ...bitmapOutline.bitmapGlyph,
        scalingPolicy: 'backendDefault',
      },
    });
    const backendDefaultFilteringBitmapOutline = outlineFor('canvaskit-outline-bitmap-backend-default-filtering', {
      payloadKind: 'bitmapGlyph',
      variant: variantFor('canvaskit-outline-bitmap-backend-default-filtering', 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.bitmapGlyph'],
        anchorOpId: 'op-text-canvaskit-outline-bitmap-backend-default-filtering',
        localPaintOrder: 0,
      }),
      bitmapGlyph: {
        ...bitmapOutline.bitmapGlyph,
        filtering: 'backendDefault',
      },
    });
    const invalidStrikePpemBitmapOutline = outlineFor('canvaskit-outline-bitmap-invalid-strike-ppem', {
      payloadKind: 'bitmapGlyph',
      variant: variantFor('canvaskit-outline-bitmap-invalid-strike-ppem', 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.bitmapGlyph'],
        anchorOpId: 'op-text-canvaskit-outline-bitmap-invalid-strike-ppem',
        localPaintOrder: 0,
      }),
      bitmapGlyph: {
        ...bitmapOutline.bitmapGlyph,
        strikePpem: [0, 16],
      },
    });
    const missingStrikeSelectionBitmapOutline = outlineFor('canvaskit-outline-bitmap-missing-strike-selection', {
      payloadKind: 'bitmapGlyph',
      variant: variantFor('canvaskit-outline-bitmap-missing-strike-selection', 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.bitmapGlyph'],
        anchorOpId: 'op-text-canvaskit-outline-bitmap-missing-strike-selection',
        localPaintOrder: 0,
      }),
      bitmapGlyph: {
        ...bitmapOutline.bitmapGlyph,
        strikeSelection: undefined,
      },
    });
    const diagnosticStrikeBitmapOutline = outlineFor('canvaskit-outline-bitmap-diagnostic-strike', {
      payloadKind: 'bitmapGlyph',
      variant: variantFor('canvaskit-outline-bitmap-diagnostic-strike', 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.bitmapGlyph'],
        anchorOpId: 'op-text-canvaskit-outline-bitmap-diagnostic-strike',
        localPaintOrder: 0,
      }),
      bitmapGlyph: {
        ...bitmapOutline.bitmapGlyph,
        strikeSelection: 'diagnosticOnly',
      },
    });
    const strikeReselectionBitmapOutline = outlineFor('canvaskit-outline-bitmap-strike-reselection', {
      payloadKind: 'bitmapGlyph',
      variant: variantFor('canvaskit-outline-bitmap-strike-reselection', 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.bitmapGlyph'],
        anchorOpId: 'op-text-canvaskit-outline-bitmap-strike-reselection',
        localPaintOrder: 0,
      }),
      bitmapGlyph: {
        ...bitmapOutline.bitmapGlyph,
        strikeSelection: 'backendResolved',
      },
    });
    const missingResourceBitmapOutline = outlineFor('canvaskit-outline-bitmap-missing-resource', {
      payloadKind: 'bitmapGlyph',
      variant: variantFor('canvaskit-outline-bitmap-missing-resource', 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.bitmapGlyph'],
        anchorOpId: 'op-text-canvaskit-outline-bitmap-missing-resource',
        localPaintOrder: 0,
      }),
      bitmapGlyph: {
        ...bitmapOutline.bitmapGlyph,
        imageResourceId: 'bitmap-glyph-missing',
      },
    });
    const svgOutline = outlineFor('canvaskit-outline-svg', {
      payloadKind: 'svgGlyph',
      variant: variantFor('canvaskit-outline-svg', 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.svgGlyph'],
        anchorOpId: 'op-text-canvaskit-outline-svg',
        localPaintOrder: 0,
      }),
      paths: [],
      svgGlyph: {
        vectorResourceId: 'svg-glyph-magenta-square',
        sourceRangeUtf8: { start: 0, end: 1 },
        glyphRange: { start: 0, end: 1 },
        placement: {
          runToPage: { a: 1, b: 0, c: 0, d: 1, e: 8, f: 8 },
          baselineY: 0,
        },
        viewBox: { x: 0, y: 0, width: 18, height: 18 },
        securityMode: 'staticSanitized',
        scriptAllowed: false,
        animationAllowed: false,
        externalResourcesAllowed: false,
        interactivityAllowed: false,
      },
    });
    const missingResourceSvgOutline = outlineFor('canvaskit-outline-svg-missing-resource', {
      payloadKind: 'svgGlyph',
      variant: variantFor('canvaskit-outline-svg-missing-resource', 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.svgGlyph'],
        anchorOpId: 'op-text-canvaskit-outline-svg-missing-resource',
        localPaintOrder: 0,
      }),
      paths: [],
      svgGlyph: {
        ...svgOutline.svgGlyph,
        vectorResourceId: 'svg-glyph-missing',
      },
    });
    const nonpositiveSvgBBoxOutline = outlineFor('canvaskit-outline-svg-empty-bbox', {
      payloadKind: 'svgGlyph',
      bbox: { x: 8, y: 8, width: 24, height: 0 },
      variant: variantFor('canvaskit-outline-svg-empty-bbox', 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.svgGlyph'],
        anchorOpId: 'op-text-canvaskit-outline-svg-empty-bbox',
        localPaintOrder: 0,
      }),
      paths: [],
      svgGlyph: {
        ...svgOutline.svgGlyph,
      },
    });
    const missingViewBoxSvgOutline = outlineFor('canvaskit-outline-svg-missing-viewbox', {
      payloadKind: 'svgGlyph',
      variant: variantFor('canvaskit-outline-svg-missing-viewbox', 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.svgGlyph'],
        anchorOpId: 'op-text-canvaskit-outline-svg-missing-viewbox',
        localPaintOrder: 0,
      }),
      paths: [],
      svgGlyph: {
        ...svgOutline.svgGlyph,
        viewBox: undefined,
      },
    });
    const invalidTransformSvgOutline = outlineFor('canvaskit-outline-svg-invalid-transform', {
      payloadKind: 'svgGlyph',
      variant: variantFor('canvaskit-outline-svg-invalid-transform', 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.svgGlyph'],
        anchorOpId: 'op-text-canvaskit-outline-svg-invalid-transform',
        localPaintOrder: 0,
      }),
      paths: [],
      svgGlyph: {
        ...svgOutline.svgGlyph,
        transformToRun: { a: Number.NaN, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
      },
    });
    const invalidSourceRangeSvgOutline = outlineFor('canvaskit-outline-svg-invalid-source-range', {
      payloadKind: 'svgGlyph',
      variant: variantFor('canvaskit-outline-svg-invalid-source-range', 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.svgGlyph'],
        anchorOpId: 'op-text-canvaskit-outline-svg-invalid-source-range',
        localPaintOrder: 0,
      }),
      paths: [],
      svgGlyph: {
        ...svgOutline.svgGlyph,
        sourceRangeUtf8: { start: -1, end: 1 },
      },
    });
    const emptyGlyphRangeSvgOutline = outlineFor('canvaskit-outline-svg-empty-glyph-range', {
      payloadKind: 'svgGlyph',
      variant: variantFor('canvaskit-outline-svg-empty-glyph-range', 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.svgGlyph'],
        anchorOpId: 'op-text-canvaskit-outline-svg-empty-glyph-range',
        localPaintOrder: 0,
      }),
      paths: [],
      svgGlyph: {
        ...svgOutline.svgGlyph,
        glyphRange: { start: 1, end: 1 },
      },
    });
    const invalidSecurityModeSvgOutline = outlineFor('canvaskit-outline-svg-invalid-security-mode', {
      payloadKind: 'svgGlyph',
      variant: variantFor('canvaskit-outline-svg-invalid-security-mode', 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.svgGlyph'],
        anchorOpId: 'op-text-canvaskit-outline-svg-invalid-security-mode',
        localPaintOrder: 0,
      }),
      paths: [],
      svgGlyph: {
        ...svgOutline.svgGlyph,
        securityMode: 'raw',
      },
    });
    const missingSecurityModeSvgOutline = outlineFor('canvaskit-outline-svg-missing-security-mode', {
      payloadKind: 'svgGlyph',
      variant: variantFor('canvaskit-outline-svg-missing-security-mode', 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.svgGlyph'],
        anchorOpId: 'op-text-canvaskit-outline-svg-missing-security-mode',
        localPaintOrder: 0,
      }),
      paths: [],
      svgGlyph: {
        ...svgOutline.svgGlyph,
        securityMode: undefined,
      },
    });
    const missingScriptAllowedSvgOutline = outlineFor('canvaskit-outline-svg-missing-script-allowed', {
      payloadKind: 'svgGlyph',
      variant: variantFor('canvaskit-outline-svg-missing-script-allowed', 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.svgGlyph'],
        anchorOpId: 'op-text-canvaskit-outline-svg-missing-script-allowed',
        localPaintOrder: 0,
      }),
      paths: [],
      svgGlyph: {
        ...svgOutline.svgGlyph,
        scriptAllowed: undefined,
      },
    });
    const missingAnimationAllowedSvgOutline = outlineFor('canvaskit-outline-svg-missing-animation-allowed', {
      payloadKind: 'svgGlyph',
      variant: variantFor('canvaskit-outline-svg-missing-animation-allowed', 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.svgGlyph'],
        anchorOpId: 'op-text-canvaskit-outline-svg-missing-animation-allowed',
        localPaintOrder: 0,
      }),
      paths: [],
      svgGlyph: {
        ...svgOutline.svgGlyph,
        animationAllowed: undefined,
      },
    });
    const missingExternalResourcesAllowedSvgOutline = outlineFor(
      'canvaskit-outline-svg-missing-external-resources-allowed',
      {
        payloadKind: 'svgGlyph',
        variant: variantFor('canvaskit-outline-svg-missing-external-resources-allowed', 'glyphOutline', {
          isDefaultFallback: false,
          requires: ['text.outlineGlyph', 'text.glyphOutline.svgGlyph'],
          anchorOpId: 'op-text-canvaskit-outline-svg-missing-external-resources-allowed',
          localPaintOrder: 0,
        }),
        paths: [],
        svgGlyph: {
          ...svgOutline.svgGlyph,
          externalResourcesAllowed: undefined,
        },
      },
    );
    const missingInteractivityAllowedSvgOutline = outlineFor('canvaskit-outline-svg-missing-interactivity-allowed', {
      payloadKind: 'svgGlyph',
      variant: variantFor('canvaskit-outline-svg-missing-interactivity-allowed', 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.svgGlyph'],
        anchorOpId: 'op-text-canvaskit-outline-svg-missing-interactivity-allowed',
        localPaintOrder: 0,
      }),
      paths: [],
      svgGlyph: {
        ...svgOutline.svgGlyph,
        interactivityAllowed: undefined,
      },
    });
    const invalidIntrinsicSizeSvgOutline = outlineFor('canvaskit-outline-svg-invalid-intrinsic-size', {
      payloadKind: 'svgGlyph',
      variant: variantFor('canvaskit-outline-svg-invalid-intrinsic-size', 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.svgGlyph'],
        anchorOpId: 'op-text-canvaskit-outline-svg-invalid-intrinsic-size',
        localPaintOrder: 0,
      }),
      paths: [],
      svgGlyph: {
        ...svgOutline.svgGlyph,
        intrinsicSize: { width: 18, height: 0 },
      },
    });
    const invalidPlacementSvgOutline = outlineFor('canvaskit-outline-svg-invalid-placement', {
      payloadKind: 'svgGlyph',
      variant: variantFor('canvaskit-outline-svg-invalid-placement', 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.svgGlyph'],
        anchorOpId: 'op-text-canvaskit-outline-svg-invalid-placement',
        localPaintOrder: 0,
      }),
      paths: [],
      svgGlyph: {
        ...svgOutline.svgGlyph,
        placement: {
          ...svgOutline.svgGlyph.placement,
          baselineY: Number.POSITIVE_INFINITY,
        },
      },
    });
    const missingBaselineSvgOutline = outlineFor('canvaskit-outline-svg-missing-baseline', {
      payloadKind: 'svgGlyph',
      variant: variantFor('canvaskit-outline-svg-missing-baseline', 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.svgGlyph'],
        anchorOpId: 'op-text-canvaskit-outline-svg-missing-baseline',
        localPaintOrder: 0,
      }),
      paths: [],
      svgGlyph: {
        ...svgOutline.svgGlyph,
        placement: {
          runToPage: { ...svgOutline.svgGlyph.placement.runToPage },
        },
      },
    });
    const unsafeFlagsSvgOutline = outlineFor('canvaskit-outline-svg-unsafe-flags', {
      payloadKind: 'svgGlyph',
      variant: variantFor('canvaskit-outline-svg-unsafe-flags', 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.svgGlyph'],
        anchorOpId: 'op-text-canvaskit-outline-svg-unsafe-flags',
        localPaintOrder: 0,
      }),
      paths: [],
      svgGlyph: {
        ...svgOutline.svgGlyph,
        scriptAllowed: true,
        externalResourcesAllowed: true,
      },
    });
    const rawInlineSvgOutline = outlineFor('canvaskit-outline-svg-raw-inline', {
      payloadKind: 'svgGlyph',
      variant: variantFor('canvaskit-outline-svg-raw-inline', 'glyphOutline', {
        isDefaultFallback: false,
        requires: ['text.outlineGlyph', 'text.glyphOutline.svgGlyph'],
        anchorOpId: 'op-text-canvaskit-outline-svg-raw-inline',
        localPaintOrder: 0,
      }),
      paths: [],
      svgGlyph: {
        ...svgOutline.svgGlyph,
        rawSvg: '<svg><path d="M0 0 L18 0 L18 18 L0 18 Z"/></svg>',
      },
    });
    const duplicateBitmapResourceTree = treeFor(bitmapOutline);
    duplicateBitmapResourceTree.resources.images.push(pixelBytes);
    duplicateBitmapResourceTree.resources.imageHashes.push('bitmap-glyph-pixel-duplicate');
    duplicateBitmapResourceTree.resources.imageKeys.push('bitmap-glyph-pixel');
    const truncatedBitmapResourceTree = treeFor(bitmapOutline);
    truncatedBitmapResourceTree.resources.images[0] = pixelBytes.slice(0, 33);
    truncatedBitmapResourceTree.resources.imageHashes[0] = 'bitmap-glyph-truncated-png';
    const duplicateSvgResourceTree = treeFor(svgOutline);
    duplicateSvgResourceTree.resources.svgFragments.push('<path d="M0 0 L18 0 L18 18 L0 18 Z" fill="#00ffff"/>');
    duplicateSvgResourceTree.resources.svgHashes.push('svg-glyph-magenta-square-duplicate');
    duplicateSvgResourceTree.resources.svgKeys.push('svg-glyph-magenta-square');
    const unsafeSvgResourceTree = treeFor(svgOutline);
    unsafeSvgResourceTree.resources.svgFragments[0] = '<script>1</script><path d="M0 0 L18 0 L18 18 L0 18 Z" fill="#ff00cc"/>';
    unsafeSvgResourceTree.resources.svgHashes[0] = 'svg-glyph-unsafe-script';
    const textLayerSvgResourceTree = treeFor(svgOutline);
    textLayerSvgResourceTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<path d="M0 0 L18 0 L18 18 L0 18 Z" fill="#ff00cc"/>',
      '<text x="1" y="12" fill="#0000ff">X</text>',
      '</svg>',
    ].join('');
    textLayerSvgResourceTree.resources.svgHashes[0] = 'svg-glyph-text-layer';
    const malformedPathSvgResourceTree = treeFor(svgOutline);
    malformedPathSvgResourceTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<path d="M0 0 L18 0 L18 18 L0 18 Z" fill="#ff00cc"/>',
      '<path d="not-a-path" fill="#0000ff"/>',
      '</svg>',
    ].join('');
    malformedPathSvgResourceTree.resources.svgHashes[0] = 'svg-glyph-malformed-path';
    const overflowTransformSvgResourceTree = treeFor(svgOutline);
    overflowTransformSvgResourceTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<path d="M0 0 L18 0 L18 18 L0 18 Z" transform="scale(1e308) scale(1e308)" fill="#ff00cc"/>',
      '</svg>',
    ].join('');
    overflowTransformSvgResourceTree.resources.svgHashes[0] = 'svg-glyph-overflow-transform';
    const strokedSvgResourceTree = treeFor(svgOutline);
    strokedSvgResourceTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<path d="M3 3 L15 3 L15 15 L3 15 Z" fill="none" stroke="#0000ff" stroke-width="4" stroke-linejoin="round" stroke-linecap="square" stroke-miterlimit="4"/>',
      '</svg>',
    ].join('');
    strokedSvgResourceTree.resources.svgHashes[0] = 'svg-glyph-stroked-resource';
    const lineSvgResourceTree = treeFor(svgOutline);
    lineSvgResourceTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<line x1="3" y1="9" x2="15" y2="9" fill="#ff00cc" stroke="#0000ff" stroke-width="4" stroke-linejoin="miter" stroke-linecap="round" stroke-miterlimit="4"/>',
      '</svg>',
    ].join('');
    lineSvgResourceTree.resources.svgHashes[0] = 'svg-glyph-line-resource';
    const shapeStrokeSvgResourceTree = treeFor(svgOutline);
    shapeStrokeSvgResourceTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<rect x="1" y="1" width="5" height="5" fill="none" stroke="#0000ff" stroke-width="2" stroke-linejoin="miter" stroke-linecap="butt" stroke-miterlimit="4"/>',
      '<circle cx="13" cy="4" r="3" fill="none" stroke="#0000ff" stroke-width="2" stroke-linejoin="miter" stroke-linecap="butt" stroke-miterlimit="4"/>',
      '<ellipse cx="5" cy="14" rx="3" ry="2" fill="none" stroke="#0000ff" stroke-width="2" stroke-linejoin="miter" stroke-linecap="butt" stroke-miterlimit="4"/>',
      '<polygon points="10,11 16,11 13,16" fill="none" stroke="#0000ff" stroke-width="2" stroke-linejoin="bevel" stroke-linecap="square" stroke-miterlimit="4"/>',
      '</svg>',
    ].join('');
    shapeStrokeSvgResourceTree.resources.svgHashes[0] = 'svg-glyph-shape-stroke-resource';
    const dashedSvgResourceTree = treeFor(svgOutline);
    dashedSvgResourceTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<path d="M2 4 H16 M2 9 H16 M2 14 H16" fill="none" stroke="#0000ff" stroke-width="2" stroke-linecap="butt" stroke-dasharray="2 2" stroke-dashoffset="1"/>',
      '</svg>',
    ].join('');
    dashedSvgResourceTree.resources.svgHashes[0] = 'svg-glyph-dashed-stroke-resource';
    const styledDashSvgResourceTree = treeFor(svgOutline);
    styledDashSvgResourceTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<g style="stroke: #0000ff; stroke-width: 2; stroke-linecap: butt; stroke-dasharray: 2 2; stroke-dashoffset: 1">',
      '<path d="M2 4 H16 M2 9 H16 M2 14 H16" fill="none"/>',
      '</g>',
      '</svg>',
    ].join('');
    styledDashSvgResourceTree.resources.svgHashes[0] = 'svg-glyph-styled-dashed-stroke-resource';
    const pxLengthSvgResourceTree = treeFor(svgOutline);
    pxLengthSvgResourceTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<line x1="2px" y1="4px" x2="16px" y2="4px" fill="none" stroke="#0000ff" stroke-width="2px" stroke-linecap="butt" stroke-dasharray="2px 2px" stroke-dashoffset="1px"/>',
      '<rect x="2px" y="8px" width="14px" height="7px" fill="none" stroke="#0000ff" stroke-width="2px"/>',
      '</svg>',
    ].join('');
    pxLengthSvgResourceTree.resources.svgHashes[0] = 'svg-glyph-px-length-resource';
    const zeroWidthStrokeSvgResourceTree = treeFor(svgOutline);
    zeroWidthStrokeSvgResourceTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<rect x="0" y="0" width="18" height="18" fill="#ff00cc" stroke="#0000ff" stroke-width="0"/>',
      '</svg>',
    ].join('');
    zeroWidthStrokeSvgResourceTree.resources.svgHashes[0] = 'svg-glyph-zero-width-stroke-resource';
    const styledZeroWidthStrokeSvgResourceTree = treeFor(svgOutline);
    styledZeroWidthStrokeSvgResourceTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<g style="stroke: #0000ff; stroke-width: 0">',
      '<rect x="0" y="0" width="18" height="18" fill="#ff00cc"/>',
      '</g>',
      '</svg>',
    ].join('');
    styledZeroWidthStrokeSvgResourceTree.resources.svgHashes[0] = 'svg-glyph-styled-zero-width-stroke-resource';
    const transparentStrokeSvgResourceTree = treeFor(svgOutline);
    transparentStrokeSvgResourceTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<rect x="0" y="0" width="18" height="18" fill="#ff00cc" stroke="#0000ff" stroke-width="4" stroke-opacity="0"/>',
      '</svg>',
    ].join('');
    transparentStrokeSvgResourceTree.resources.svgHashes[0] = 'svg-glyph-transparent-stroke-resource';
    const styledTransparentStrokeSvgResourceTree = treeFor(svgOutline);
    styledTransparentStrokeSvgResourceTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<g style="stroke: #0000ff; stroke-width: 4; stroke-opacity: 0">',
      '<rect x="0" y="0" width="18" height="18" fill="#ff00cc"/>',
      '</g>',
      '</svg>',
    ].join('');
    styledTransparentStrokeSvgResourceTree.resources.svgHashes[0] = 'svg-glyph-styled-transparent-stroke-resource';
    const invisibleStrokeOnlySvgResourceTree = treeFor(svgOutline);
    invisibleStrokeOnlySvgResourceTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<line x1="2" y1="9" x2="16" y2="9" fill="none" stroke="#0000ff" stroke-width="4" stroke-opacity="0"/>',
      '</svg>',
    ].join('');
    invisibleStrokeOnlySvgResourceTree.resources.svgHashes[0] = 'svg-glyph-invisible-stroke-only-resource';
    const unsupportedSvgStrokeTree = treeFor(svgOutline);
    unsupportedSvgStrokeTree.resources.svgFragments[0] = '<path d="M0 0 L18 0 L18 18 L0 18 Z" fill="#ff00cc" stroke="#000000" stroke-dasharray="2 -1"/>';
    unsupportedSvgStrokeTree.resources.svgHashes[0] = 'svg-glyph-unsupported-stroke';
    const unsupportedSvgOpacityTree = treeFor(svgOutline);
    unsupportedSvgOpacityTree.resources.svgFragments[0] = '<path d="M0 0 L18 0 L18 18 L0 18 Z" fill="#ff00cc" opacity="not-a-number"/>';
    unsupportedSvgOpacityTree.resources.svgHashes[0] = 'svg-glyph-unsupported-opacity';
    const unsupportedSvgGroupOpacityTree = treeFor(svgOutline);
    unsupportedSvgGroupOpacityTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<g opacity="0.5">',
      '<rect x="0" y="0" width="18" height="18" fill="#ff00cc"/>',
      '</g>',
      '</svg>',
    ].join('');
    unsupportedSvgGroupOpacityTree.resources.svgHashes[0] = 'svg-glyph-unsupported-group-opacity';
    const unsupportedSvgFillRuleTree = treeFor(svgOutline);
    unsupportedSvgFillRuleTree.resources.svgFragments[0] = '<path d="M0 0 L18 0 L18 18 L0 18 Z" fill="#ff00cc" fill-rule="inherit"/>';
    unsupportedSvgFillRuleTree.resources.svgHashes[0] = 'svg-glyph-unsupported-fill-rule';
    const unsupportedSvgIndirectPaintTree = treeFor(svgOutline);
    unsupportedSvgIndirectPaintTree.resources.svgFragments[0] = '<path d="M0 0 L18 0 L18 18 L0 18 Z" fill="url (#glyph-paint)"/>';
    unsupportedSvgIndirectPaintTree.resources.svgHashes[0] = 'svg-glyph-unsupported-indirect-paint';
    const unsupportedSvgImageHrefTree = treeFor(svgOutline);
    unsupportedSvgImageHrefTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<image href="https://example.invalid/glyph.png" x="0" y="0" width="18" height="18"/>',
      '</svg>',
    ].join('');
    unsupportedSvgImageHrefTree.resources.svgHashes[0] = 'svg-glyph-unsupported-image-href';
    const unsupportedSvgUseHrefTree = treeFor(svgOutline);
    unsupportedSvgUseHrefTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<defs><path id="glyph-path" d="M0 0 L18 0 L18 18 L0 18 Z"/></defs>',
      '<use href="#glyph-path" fill="#ff00cc"/>',
      '</svg>',
    ].join('');
    unsupportedSvgUseHrefTree.resources.svgHashes[0] = 'svg-glyph-unsupported-use-href';
    const unsupportedSvgForeignObjectTree = treeFor(svgOutline);
    unsupportedSvgForeignObjectTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<foreignObject x="0" y="0" width="18" height="18">',
      '<div xmlns="http://www.w3.org/1999/xhtml">glyph</div>',
      '</foreignObject>',
      '</svg>',
    ].join('');
    unsupportedSvgForeignObjectTree.resources.svgHashes[0] = 'svg-glyph-unsupported-foreign-object';
    const unsupportedSvgFilterTree = treeFor(svgOutline);
    unsupportedSvgFilterTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<defs><filter id="glyph-filter"><feGaussianBlur stdDeviation="2"/></filter></defs>',
      '<rect x="0" y="0" width="18" height="18" fill="#ff00cc" filter="url(#glyph-filter)"/>',
      '</svg>',
    ].join('');
    unsupportedSvgFilterTree.resources.svgHashes[0] = 'svg-glyph-unsupported-filter';
    const unsupportedSvgMaskTree = treeFor(svgOutline);
    unsupportedSvgMaskTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<defs><mask id="glyph-mask"><rect x="0" y="0" width="18" height="18" fill="#ffffff"/></mask></defs>',
      '<rect x="0" y="0" width="18" height="18" fill="#ff00cc" mask="url(#glyph-mask)"/>',
      '</svg>',
    ].join('');
    unsupportedSvgMaskTree.resources.svgHashes[0] = 'svg-glyph-unsupported-mask';
    const unsupportedSvgClipPathTree = treeFor(svgOutline);
    unsupportedSvgClipPathTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<defs><clipPath id="glyph-clip"><rect x="0" y="0" width="9" height="18"/></clipPath></defs>',
      '<rect x="0" y="0" width="18" height="18" fill="#ff00cc" clip-path="url(#glyph-clip)"/>',
      '</svg>',
    ].join('');
    unsupportedSvgClipPathTree.resources.svgHashes[0] = 'svg-glyph-unsupported-clip-path';
    const unsupportedSvgInvalidColorTree = treeFor(svgOutline);
    unsupportedSvgInvalidColorTree.resources.svgFragments[0] = '<path d="M0 0 L18 0 L18 18 L0 18 Z" fill="definitely-not-a-color"/>';
    unsupportedSvgInvalidColorTree.resources.svgHashes[0] = 'svg-glyph-unsupported-invalid-color';
    const unsupportedSvgUnknownEntityTree = treeFor(svgOutline);
    unsupportedSvgUnknownEntityTree.resources.svgFragments[0] =
      '<path d="M0 0 L18 0 L18 18 L0 18 Z" fill="&unknown;"/>';
    unsupportedSvgUnknownEntityTree.resources.svgHashes[0] = 'svg-glyph-unsupported-unknown-entity';
    const unsupportedSvgDuplicateAttributeTree = treeFor(svgOutline);
    unsupportedSvgDuplicateAttributeTree.resources.svgFragments[0] =
      '<path d="M0 0 L18 0 L18 18 L0 18 Z" fill="#0000ff" fill="#ff00cc"/>';
    unsupportedSvgDuplicateAttributeTree.resources.svgHashes[0] = 'svg-glyph-unsupported-duplicate-attribute';
    const unsupportedSvgStrayLessThanTree = treeFor(svgOutline);
    unsupportedSvgStrayLessThanTree.resources.svgFragments[0] =
      '<<path d="M0 0 L18 0 L18 18 L0 18 Z" fill="#ff00cc"/>';
    unsupportedSvgStrayLessThanTree.resources.svgHashes[0] = 'svg-glyph-unsupported-stray-less-than';
    const unsupportedSvgCdataEndTree = treeFor(svgOutline);
    unsupportedSvgCdataEndTree.resources.svgFragments[0] =
      ']]><path d="M0 0 L18 0 L18 18 L0 18 Z" fill="#ff00cc"/>';
    unsupportedSvgCdataEndTree.resources.svgHashes[0] = 'svg-glyph-unsupported-cdata-end';
    const unsupportedSvgTextEntityTree = treeFor(svgOutline);
    unsupportedSvgTextEntityTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<title>&unknown;</title>',
      '<path d="M0 0 L18 0 L18 18 L0 18 Z" fill="#ff00cc"/>',
      '</svg>',
    ].join('');
    unsupportedSvgTextEntityTree.resources.svgHashes[0] = 'svg-glyph-unsupported-text-entity';
    const unsupportedSvgDoctypeTree = treeFor(svgOutline);
    unsupportedSvgDoctypeTree.resources.svgFragments[0] = '<!DOCTYPE svg><path d="M0 0 L18 0 L18 18 L0 18 Z" fill="#ff00cc"/>';
    unsupportedSvgDoctypeTree.resources.svgHashes[0] = 'svg-glyph-unsupported-doctype';
    const unsupportedSvgClosingTagTree = treeFor(svgOutline);
    unsupportedSvgClosingTagTree.resources.svgFragments[0] = '</script><path d="M0 0 L18 0 L18 18 L0 18 Z" fill="#ff00cc"/>';
    unsupportedSvgClosingTagTree.resources.svgHashes[0] = 'svg-glyph-unsupported-closing-tag';
    const unsupportedSvgCrossedClosingTagTree = treeFor(svgOutline);
    unsupportedSvgCrossedClosingTagTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<g><path d="M0 0 L18 0 L18 18 L0 18 Z" fill="#ff00cc"/></svg></g>',
    ].join('');
    unsupportedSvgCrossedClosingTagTree.resources.svgHashes[0] = 'svg-glyph-crossed-closing-tag';
    const unsupportedSvgDanglingShapeClosingTagTree = treeFor(svgOutline);
    unsupportedSvgDanglingShapeClosingTagTree.resources.svgFragments[0] = '</path><path d="M0 0 L18 0 L18 18 L0 18 Z" fill="#ff00cc"/>';
    unsupportedSvgDanglingShapeClosingTagTree.resources.svgHashes[0] = 'svg-glyph-unsupported-dangling-shape-closing-tag';
    const unsupportedSvgMalformedCommentTree = treeFor(svgOutline);
    unsupportedSvgMalformedCommentTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<!-- invalid -- comment -->',
      '<path d="M0 0 L18 0 L18 18 L0 18 Z" fill="#ff00cc"/>',
      '</svg>',
    ].join('');
    unsupportedSvgMalformedCommentTree.resources.svgHashes[0] = 'svg-glyph-unsupported-malformed-comment';
    const unsupportedSvgMalformedStyleCommentTree = treeFor(svgOutline);
    unsupportedSvgMalformedStyleCommentTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<path d="M0 0 L18 0 L18 18 L0 18 Z" style="/* invalid comment fill: #ff00cc"/>',
      '</svg>',
    ].join('');
    unsupportedSvgMalformedStyleCommentTree.resources.svgHashes[0] =
      'svg-glyph-unsupported-malformed-style-comment';
    const wrappedSvgResourceTree = treeFor(svgOutline);
    wrappedSvgResourceTree.resources.svgFragments[0] = [
      '<svg id="glyph-root" class="glyph-shell" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xml:space="preserve" viewBox="0 0 18 18">',
      '<title id="glyph-title">Fixture glyph</title>',
      '<desc id="glyph-desc">Static sanitized vector resource</desc>',
      '<g id="glyph-group" class="glyph-layer" xml:space="default">',
      '<path id="glyph-path" class="glyph-shape" d="M0 0 L18 0 L18 18 L0 18 Z" fill="#ff00cc"/>',
      '</g>',
      '</svg>',
    ].join('');
    wrappedSvgResourceTree.resources.svgHashes[0] = 'svg-glyph-wrapped-resource';
    const nonVisualAttributesSvgResourceTree = treeFor(svgOutline);
    nonVisualAttributesSvgResourceTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" role="img" aria-label="Fixture glyph" data-source="fixture" focusable="false">',
      '<title aria-hidden="true" data-title="fixture">Fixture glyph</title>',
      '<desc data-purpose="strict-replay">Static sanitized vector resource</desc>',
      '<g role="presentation" aria-hidden="true" data-layer="fill" focusable="false">',
      '<path data-shape="square" aria-label="magenta square" d="M0 0 L18 0 L18 18 L0 18 Z" fill="#ff00cc"/>',
      '</g>',
      '</svg>',
    ].join('');
    nonVisualAttributesSvgResourceTree.resources.svgHashes[0] = 'svg-glyph-nonvisual-attributes-resource';
    const balancedShapeSvgResourceTree = treeFor(svgOutline);
    balancedShapeSvgResourceTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<path d="M0 0 L18 0 L18 18 L0 18 Z" fill="#ff00cc"></path>',
      '</svg>',
    ].join('');
    balancedShapeSvgResourceTree.resources.svgHashes[0] = 'svg-glyph-balanced-shape-resource';
    const defsSvgResourceTree = treeFor(svgOutline);
    defsSvgResourceTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<defs id="glyph-defs">',
      '<path id="ignored-def-path" d="M9 0 L18 0 L18 18 L9 18 Z" fill="#0000ff"/>',
      '</defs>',
      '<rect x="0" y="0" width="9" height="18" fill="#ff00cc"/>',
      '</svg>',
    ].join('');
    defsSvgResourceTree.resources.svgHashes[0] = 'svg-glyph-defs-resource';
    const nonRenderingMetadataSvgResourceTree = treeFor(svgOutline);
    nonRenderingMetadataSvgResourceTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<metadata id="glyph-metadata"><path d="M9 0 L18 0 L18 18 L9 18 Z" fill="#0000ff"/></metadata>',
      '<title><path d="M9 0 L18 0 L18 18 L9 18 Z" fill="#0000ff"/></title>',
      '<desc><path d="M9 0 L18 0 L18 18 L9 18 Z" fill="#0000ff"/></desc>',
      '<rect x="0" y="0" width="9" height="18" fill="#ff00cc"/>',
      '</svg>',
    ].join('');
    nonRenderingMetadataSvgResourceTree.resources.svgHashes[0] = 'svg-glyph-nonrendering-metadata-resource';
    const commentSvgResourceTree = treeFor(svgOutline);
    commentSvgResourceTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<!-- <path d="M9 0 L18 0 L18 18 L9 18 Z" fill="#0000ff"/> -->',
      '<rect x="0" y="0" width="9" height="18" fill="#ff00cc"/>',
      '</svg>',
    ].join('');
    commentSvgResourceTree.resources.svgHashes[0] = 'svg-glyph-comment-resource';
    const namedCssColorSvgResourceTree = treeFor(svgOutline);
    namedCssColorSvgResourceTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<path d="M0 0 L18 0 L18 18 L0 18 Z" fill="magenta"/>',
      '</svg>',
    ].join('');
    namedCssColorSvgResourceTree.resources.svgHashes[0] = 'svg-glyph-named-css-color-resource';
    const noCssNamedCssColorSvgResourceTree = treeFor(svgOutline);
    noCssNamedCssColorSvgResourceTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<path d="M0 0 L18 0 L18 18 L0 18 Z" fill="fuchsia"/>',
      '</svg>',
    ].join('');
    noCssNamedCssColorSvgResourceTree.resources.svgHashes[0] = 'svg-glyph-no-css-named-css-color-resource';
    const functionalCssColorSvgResourceTree = treeFor(svgOutline);
    functionalCssColorSvgResourceTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<path d="M0 0 L18 0 L18 18 L0 18 Z" style="fill: color(xyz-d50 0.579155 0.283121 0.728105)"/>',
      '</svg>',
    ].join('');
    functionalCssColorSvgResourceTree.resources.svgHashes[0] = 'svg-glyph-functional-css-color-resource';
    const wideGamutCssColorSvgResourceTree = treeFor(svgOutline);
    wideGamutCssColorSvgResourceTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<rect x="0" y="0" width="6" height="18" fill="color(a98-rgb 1 0 1)"/>',
      '<rect x="6" y="0" width="6" height="18" fill="color(prophoto-rgb 1 0 1)"/>',
      '<rect x="12" y="0" width="6" height="18" fill="color(rec2020 1 0 1)"/>',
      '</svg>',
    ].join('');
    wideGamutCssColorSvgResourceTree.resources.svgHashes[0] = 'svg-glyph-wide-gamut-css-color-resource';
    const stylePrecedenceSvgResourceTree = treeFor(svgOutline);
    stylePrecedenceSvgResourceTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<path d="M0 0 L18 0 L18 18 L0 18 Z" fill="#ff0000" style="fill: #ff00cc; opacity: 1; fill-rule: nonzero"/>',
      '</svg>',
    ].join('');
    stylePrecedenceSvgResourceTree.resources.svgHashes[0] = 'svg-glyph-style-precedence-resource';
    const styleCascadeSvgResourceTree = treeFor(svgOutline);
    styleCascadeSvgResourceTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<path d="M0 0 L18 0 L18 18 L0 18 Z" style="fill: #ff0000; fill: color(xyz 0.592894 0.284848 0.969638)"/>',
      '</svg>',
    ].join('');
    styleCascadeSvgResourceTree.resources.svgHashes[0] = 'svg-glyph-style-cascade-resource';
    const styleCommentSvgResourceTree = treeFor(svgOutline);
    styleCommentSvgResourceTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<path d="M0 0 L18 0 L18 18 L0 18 Z" fill="#ff0000" style="/* ignored: fill: #0000ff; */ fill: #ff00cc"/>',
      '</svg>',
    ].join('');
    styleCommentSvgResourceTree.resources.svgHashes[0] = 'svg-glyph-style-comment-resource';
    const attributeEntitySvgResourceTree = treeFor(svgOutline);
    attributeEntitySvgResourceTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<path d="M0 0 L18 0 L18 18 L0 18 Z" fill="&#35;ff00cc"/>',
      '</svg>',
    ].join('');
    attributeEntitySvgResourceTree.resources.svgHashes[0] = 'svg-glyph-attribute-entity-resource';
    const styleEntitySvgResourceTree = treeFor(svgOutline);
    styleEntitySvgResourceTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<path d="M0 0 L18 0 L18 18 L0 18 Z" fill="#ff0000" style="fill: &#x23;ff00cc"/>',
      '</svg>',
    ].join('');
    styleEntitySvgResourceTree.resources.svgHashes[0] = 'svg-glyph-style-entity-resource';
    const polylineSvgResourceTree = treeFor(svgOutline);
    polylineSvgResourceTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<polyline points="0,0 18,0 18,18 0,18" fill="#ff00cc"/>',
      '</svg>',
    ].join('');
    polylineSvgResourceTree.resources.svgHashes[0] = 'svg-glyph-polyline-resource';
    const roundedRectSvgResourceTree = treeFor(svgOutline);
    roundedRectSvgResourceTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<rect x="0" y="0" width="18" height="18" rx="4" ry="4" fill="#ff00cc"/>',
      '</svg>',
    ].join('');
    roundedRectSvgResourceTree.resources.svgHashes[0] = 'svg-glyph-rounded-rect-resource';
    const transformedSvgResourceTree = treeFor(svgOutline);
    transformedSvgResourceTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<rect x="0" y="0" width="9" height="18" transform="translate(9 0)" fill="#ff00cc"/>',
      '</svg>',
    ].join('');
    transformedSvgResourceTree.resources.svgHashes[0] = 'svg-glyph-transformed-resource';
    const matrixTransformSvgResourceTree = treeFor(svgOutline);
    matrixTransformSvgResourceTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<rect x="0" y="0" width="9" height="18" transform="matrix(1 0 0 1 9 0)" fill="#ff00cc"/>',
      '</svg>',
    ].join('');
    matrixTransformSvgResourceTree.resources.svgHashes[0] = 'svg-glyph-matrix-transform-resource';
    const rootTransformSvgResourceTree = treeFor(svgOutline);
    rootTransformSvgResourceTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" transform="translate(9 0)">',
      '<rect x="0" y="0" width="9" height="18" fill="#ff00cc"/>',
      '</svg>',
    ].join('');
    rootTransformSvgResourceTree.resources.svgHashes[0] = 'svg-glyph-root-transform-resource';
    const transformListSvgResourceTree = treeFor(svgOutline);
    transformListSvgResourceTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<rect x="0" y="0" width="18" height="18" transform="translate(9 0) scale(0.5 1)" fill="#ff00cc"/>',
      '</svg>',
    ].join('');
    transformListSvgResourceTree.resources.svgHashes[0] = 'svg-glyph-transform-list-resource';
    const groupTransformSvgResourceTree = treeFor(svgOutline);
    groupTransformSvgResourceTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">',
      '<g transform="translate(9 0)">',
      '<rect x="0" y="0" width="9" height="18" fill="#ff00cc"/>',
      '</g>',
      '</svg>',
    ].join('');
    groupTransformSvgResourceTree.resources.svgHashes[0] = 'svg-glyph-group-transform-resource';
    const inheritedPaintSvgResourceTree = treeFor(svgOutline);
    inheritedPaintSvgResourceTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" fill="#ff00cc">',
      '<g style="fill-rule: nonzero; fill-opacity: 1">',
      '<rect x="0" y="0" width="18" height="18"/>',
      '</g>',
      '</svg>',
    ].join('');
    inheritedPaintSvgResourceTree.resources.svgHashes[0] = 'svg-glyph-inherited-paint-resource';
    const currentColorSvgResourceTree = treeFor(svgOutline);
    currentColorSvgResourceTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" color="#ff00cc">',
      '<g fill="currentColor">',
      '<rect x="0" y="0" width="9" height="18"/>',
      '</g>',
      '<g style="color: #0000ff; stroke: currentColor; stroke-width: 2; fill: none">',
      '<line x1="10" y1="9" x2="17" y2="9"/>',
      '</g>',
      '</svg>',
    ].join('');
    currentColorSvgResourceTree.resources.svgHashes[0] = 'svg-glyph-current-color-resource';
    const identityOpacitySvgResourceTree = treeFor(svgOutline);
    identityOpacitySvgResourceTree.resources.svgFragments[0] = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" style="fill: #ff00cc; opacity: 100%">',
      '<g opacity="1" style="fill-rule: nonzero; fill-opacity: 1; opacity: 1">',
      '<rect x="0" y="0" width="18" height="18"/>',
      '</g>',
      '</svg>',
    ].join('');
    identityOpacitySvgResourceTree.resources.svgHashes[0] = 'svg-glyph-identity-opacity-resource';
    const originalDOMParser = globalThis.DOMParser;
    const hadDOMParser = 'DOMParser' in globalThis;
    let noDomParserSvgGlyph;
    let noDomParserWrappedSvgGlyph;
    let noDomParserNonVisualAttributesSvgGlyph;
    let noDomParserBalancedShapeSvgGlyph;
    let noDomParserDefsSvgGlyph;
    let noDomParserNonRenderingMetadataSvgGlyph;
    let noDomParserCommentSvgGlyph;
    let noDomParserStrokedSvgGlyph;
    let noDomParserLineSvgGlyph;
    let noDomParserShapeStrokeSvgGlyph;
    let noDomParserDashedSvgGlyph;
    let noDomParserStyledDashSvgGlyph;
    let noDomParserPxLengthSvgGlyph;
    let noDomParserZeroWidthStrokeSvgGlyph;
    let noDomParserStyledZeroWidthStrokeSvgGlyph;
    let noDomParserTransparentStrokeSvgGlyph;
    let noDomParserStyledTransparentStrokeSvgGlyph;
    let noDomParserInvisibleStrokeOnlySvgGlyph;
    let noDomParserNamedCssColorSvgGlyph;
    let noCssNamedCssColorSvgGlyph;
    let noDomParserFunctionalCssColorSvgGlyph;
    let noCssFunctionalCssColorSvgGlyph;
    let noDomParserWideGamutCssColorSvgGlyph;
    let noCssWideGamutCssColorSvgGlyph;
    let noDomParserStylePrecedenceSvgGlyph;
    let noDomParserStyleCascadeSvgGlyph;
    let noDomParserStyleCommentSvgGlyph;
    let noDomParserAttributeEntitySvgGlyph;
    let noDomParserStyleEntitySvgGlyph;
    let noDomParserPolylineSvgGlyph;
    let noDomParserRoundedRectSvgGlyph;
    let noDomParserTransformedSvgGlyph;
    let noDomParserMatrixTransformSvgGlyph;
    let noDomParserRootTransformSvgGlyph;
    let noDomParserTransformListSvgGlyph;
    let noDomParserGroupTransformSvgGlyph;
    let noDomParserInheritedPaintSvgGlyph;
    let noDomParserCurrentColorSvgGlyph;
    let noDomParserIdentityOpacitySvgGlyph;
    let noDomParserUnsupportedSvgDoctypeResource;
    let noDomParserUnsupportedSvgClosingTagResource;
    let noDomParserUnsupportedSvgDanglingShapeClosingTagResource;
    let noDomParserUnsupportedSvgMalformedCommentResource;
    let noDomParserUnsupportedSvgMalformedStyleCommentResource;
    let noDomParserUnsupportedSvgInvalidColorResource;
    let noDomParserUnsupportedSvgUnknownEntityResource;
    let noDomParserUnsupportedSvgDuplicateAttributeResource;
    let noDomParserUnsupportedSvgStrayLessThanResource;
    let noDomParserUnsupportedSvgCdataEndResource;
    let noDomParserUnsupportedSvgTextEntityResource;
    let noDomParserUnsupportedSvgGroupOpacityResource;
    let noDomParserUnsupportedSvgImageHrefResource;
    let noDomParserUnsupportedSvgUseHrefResource;
    let noDomParserUnsupportedSvgForeignObjectResource;
    let noDomParserUnsupportedSvgFilterResource;
    let noDomParserUnsupportedSvgMaskResource;
    let noDomParserUnsupportedSvgClipPathResource;
    try {
      globalThis.DOMParser = undefined;
      noDomParserSvgGlyph = await render(treeFor(svgOutline));
      noDomParserWrappedSvgGlyph = await render(wrappedSvgResourceTree);
      noDomParserNonVisualAttributesSvgGlyph = await render(nonVisualAttributesSvgResourceTree);
      noDomParserBalancedShapeSvgGlyph = await render(balancedShapeSvgResourceTree);
      noDomParserDefsSvgGlyph = await render(defsSvgResourceTree);
      noDomParserNonRenderingMetadataSvgGlyph = await render(nonRenderingMetadataSvgResourceTree);
      noDomParserCommentSvgGlyph = await render(commentSvgResourceTree);
      noDomParserStrokedSvgGlyph = await render(strokedSvgResourceTree);
      noDomParserLineSvgGlyph = await render(lineSvgResourceTree);
      noDomParserShapeStrokeSvgGlyph = await render(shapeStrokeSvgResourceTree);
      noDomParserDashedSvgGlyph = await render(dashedSvgResourceTree);
      noDomParserStyledDashSvgGlyph = await render(styledDashSvgResourceTree);
      noDomParserPxLengthSvgGlyph = await render(pxLengthSvgResourceTree);
      noDomParserZeroWidthStrokeSvgGlyph = await render(zeroWidthStrokeSvgResourceTree);
      noDomParserStyledZeroWidthStrokeSvgGlyph = await render(styledZeroWidthStrokeSvgResourceTree);
      noDomParserTransparentStrokeSvgGlyph = await render(transparentStrokeSvgResourceTree);
      noDomParserStyledTransparentStrokeSvgGlyph = await render(styledTransparentStrokeSvgResourceTree);
      noDomParserInvisibleStrokeOnlySvgGlyph = await render(invisibleStrokeOnlySvgResourceTree);
      noDomParserNamedCssColorSvgGlyph = await render(namedCssColorSvgResourceTree);
      const originalCSS = globalThis.CSS;
      const hadCSS = 'CSS' in globalThis;
      try {
        globalThis.CSS = undefined;
        noCssNamedCssColorSvgGlyph = await render(noCssNamedCssColorSvgResourceTree);
        noCssFunctionalCssColorSvgGlyph = await render(functionalCssColorSvgResourceTree);
        noCssWideGamutCssColorSvgGlyph = await render(wideGamutCssColorSvgResourceTree);
      } finally {
        if (hadCSS) {
          globalThis.CSS = originalCSS;
        } else {
          delete globalThis.CSS;
        }
      }
      noDomParserFunctionalCssColorSvgGlyph = await render(functionalCssColorSvgResourceTree);
      noDomParserWideGamutCssColorSvgGlyph = await render(wideGamutCssColorSvgResourceTree);
      noDomParserStylePrecedenceSvgGlyph = await render(stylePrecedenceSvgResourceTree);
      noDomParserStyleCascadeSvgGlyph = await render(styleCascadeSvgResourceTree);
      noDomParserStyleCommentSvgGlyph = await render(styleCommentSvgResourceTree);
      noDomParserAttributeEntitySvgGlyph = await render(attributeEntitySvgResourceTree);
      noDomParserStyleEntitySvgGlyph = await render(styleEntitySvgResourceTree);
      noDomParserPolylineSvgGlyph = await render(polylineSvgResourceTree);
      noDomParserRoundedRectSvgGlyph = await render(roundedRectSvgResourceTree);
      noDomParserTransformedSvgGlyph = await render(transformedSvgResourceTree);
      noDomParserMatrixTransformSvgGlyph = await render(matrixTransformSvgResourceTree);
      noDomParserRootTransformSvgGlyph = await render(rootTransformSvgResourceTree);
      noDomParserTransformListSvgGlyph = await render(transformListSvgResourceTree);
      noDomParserGroupTransformSvgGlyph = await render(groupTransformSvgResourceTree);
      noDomParserInheritedPaintSvgGlyph = await render(inheritedPaintSvgResourceTree);
      noDomParserCurrentColorSvgGlyph = await render(currentColorSvgResourceTree);
      noDomParserIdentityOpacitySvgGlyph = await render(identityOpacitySvgResourceTree);
      noDomParserUnsupportedSvgDoctypeResource = await render(unsupportedSvgDoctypeTree);
      noDomParserUnsupportedSvgClosingTagResource = await render(unsupportedSvgClosingTagTree);
      noDomParserUnsupportedSvgDanglingShapeClosingTagResource = await render(unsupportedSvgDanglingShapeClosingTagTree);
      noDomParserUnsupportedSvgMalformedCommentResource = await render(unsupportedSvgMalformedCommentTree);
      noDomParserUnsupportedSvgMalformedStyleCommentResource = await render(unsupportedSvgMalformedStyleCommentTree);
      noDomParserUnsupportedSvgInvalidColorResource = await render(unsupportedSvgInvalidColorTree);
      noDomParserUnsupportedSvgUnknownEntityResource = await render(unsupportedSvgUnknownEntityTree);
      noDomParserUnsupportedSvgDuplicateAttributeResource = await render(unsupportedSvgDuplicateAttributeTree);
      noDomParserUnsupportedSvgStrayLessThanResource = await render(unsupportedSvgStrayLessThanTree);
      noDomParserUnsupportedSvgCdataEndResource = await render(unsupportedSvgCdataEndTree);
      noDomParserUnsupportedSvgTextEntityResource = await render(unsupportedSvgTextEntityTree);
      noDomParserUnsupportedSvgGroupOpacityResource = await render(unsupportedSvgGroupOpacityTree);
      noDomParserUnsupportedSvgImageHrefResource = await render(unsupportedSvgImageHrefTree);
      noDomParserUnsupportedSvgUseHrefResource = await render(unsupportedSvgUseHrefTree);
      noDomParserUnsupportedSvgForeignObjectResource = await render(unsupportedSvgForeignObjectTree);
      noDomParserUnsupportedSvgFilterResource = await render(unsupportedSvgFilterTree);
      noDomParserUnsupportedSvgMaskResource = await render(unsupportedSvgMaskTree);
      noDomParserUnsupportedSvgClipPathResource = await render(unsupportedSvgClipPathTree);
    } finally {
      if (hadDOMParser) {
        globalThis.DOMParser = originalDOMParser;
      } else {
        delete globalThis.DOMParser;
      }
    }

    const originalMakeFromSvgString = renderer.canvasKit.Path.MakeFromSVGString;
    let svgGlyphPathDecodeCalls = 0;
    let svgGlyph;
    renderer.canvasKit.Path.MakeFromSVGString = function (pathData) {
      svgGlyphPathDecodeCalls += 1;
      return originalMakeFromSvgString.call(this, pathData);
    };
    try {
      svgGlyph = await render(treeFor(svgOutline));
    } finally {
      renderer.canvasKit.Path.MakeFromSVGString = originalMakeFromSvgString;
    }

    return {
      monochrome: await render(treeFor(outlineFor('canvaskit-outline-mono'))),
      stroke: await render(treeFor(strokeOutline)),
      unsupportedStrokeJoinCap: await render(treeFor(unsupportedStrokeJoinCapOutline)),
      missingStroke: await render(treeFor(missingStrokeOutline)),
      colorLayers: await render(treeFor(colorOutline)),
      colorLayersColrV1: await render(treeFor(colorV1Outline)),
      colorLayersColrV1Gradient: await render(treeFor(colorV1GradientOutline)),
      bitmapGlyph: await render(treeFor(bitmapOutline)),
      nonpositiveBitmapBBoxGlyph: await render(treeFor(nonpositiveBitmapBBoxOutline)),
      missingFilteringBitmapGlyph: await render(treeFor(missingFilteringBitmapOutline)),
      missingScalingBitmapGlyph: await render(treeFor(missingScalingBitmapOutline)),
      invalidTransformBitmapGlyph: await render(treeFor(invalidTransformBitmapOutline)),
      invalidSourceRangeBitmapGlyph: await render(treeFor(invalidSourceRangeBitmapOutline)),
      emptyGlyphRangeBitmapGlyph: await render(treeFor(emptyGlyphRangeBitmapOutline)),
      missingBaselineBitmapGlyph: await render(treeFor(missingBaselineBitmapOutline)),
      missingAlphaBitmapGlyph: await render(treeFor(missingAlphaBitmapOutline)),
      emptyColorSpaceBitmapGlyph: await render(treeFor(emptyColorSpaceBitmapOutline)),
      backendDefaultScalingBitmapGlyph: await render(treeFor(backendDefaultScalingBitmapOutline)),
      backendDefaultFilteringBitmapGlyph: await render(treeFor(backendDefaultFilteringBitmapOutline)),
      invalidStrikePpemBitmapGlyph: await render(treeFor(invalidStrikePpemBitmapOutline)),
      missingStrikeSelectionBitmapGlyph: await render(treeFor(missingStrikeSelectionBitmapOutline)),
      diagnosticStrikeBitmapGlyph: await render(treeFor(diagnosticStrikeBitmapOutline)),
      strikeReselectionBitmapGlyph: await render(treeFor(strikeReselectionBitmapOutline)),
      missingResourceBitmapGlyph: await render(treeFor(missingResourceBitmapOutline)),
      duplicateBitmapGlyphKey: await render(duplicateBitmapResourceTree),
      truncatedBitmapGlyph: await render(truncatedBitmapResourceTree),
      svgGlyph,
      svgGlyphPathDecodeCalls,
      missingResourceSvgGlyph: await render(treeFor(missingResourceSvgOutline)),
      nonpositiveSvgBBoxGlyph: await render(treeFor(nonpositiveSvgBBoxOutline)),
      missingViewBoxSvgGlyph: await render(treeFor(missingViewBoxSvgOutline)),
      invalidTransformSvgGlyph: await render(treeFor(invalidTransformSvgOutline)),
      invalidSourceRangeSvgGlyph: await render(treeFor(invalidSourceRangeSvgOutline)),
      emptyGlyphRangeSvgGlyph: await render(treeFor(emptyGlyphRangeSvgOutline)),
      invalidSecurityModeSvgGlyph: await render(treeFor(invalidSecurityModeSvgOutline)),
      missingSecurityModeSvgGlyph: await render(treeFor(missingSecurityModeSvgOutline)),
      missingScriptAllowedSvgGlyph: await render(treeFor(missingScriptAllowedSvgOutline)),
      missingAnimationAllowedSvgGlyph: await render(treeFor(missingAnimationAllowedSvgOutline)),
      missingExternalResourcesAllowedSvgGlyph: await render(treeFor(missingExternalResourcesAllowedSvgOutline)),
      missingInteractivityAllowedSvgGlyph: await render(treeFor(missingInteractivityAllowedSvgOutline)),
      invalidIntrinsicSizeSvgGlyph: await render(treeFor(invalidIntrinsicSizeSvgOutline)),
      invalidPlacementSvgGlyph: await render(treeFor(invalidPlacementSvgOutline)),
      missingBaselineSvgGlyph: await render(treeFor(missingBaselineSvgOutline)),
      unsafeFlagsSvgGlyph: await render(treeFor(unsafeFlagsSvgOutline)),
      rawInlineSvgGlyph: await render(treeFor(rawInlineSvgOutline)),
      noDomParserSvgGlyph,
      wrappedSvgGlyph: await render(wrappedSvgResourceTree),
      noDomParserWrappedSvgGlyph,
      nonVisualAttributesSvgGlyph: await render(nonVisualAttributesSvgResourceTree),
      noDomParserNonVisualAttributesSvgGlyph,
      balancedShapeSvgGlyph: await render(balancedShapeSvgResourceTree),
      noDomParserBalancedShapeSvgGlyph,
      defsSvgGlyph: await render(defsSvgResourceTree),
      noDomParserDefsSvgGlyph,
      nonRenderingMetadataSvgGlyph: await render(nonRenderingMetadataSvgResourceTree),
      noDomParserNonRenderingMetadataSvgGlyph,
      commentSvgGlyph: await render(commentSvgResourceTree),
      noDomParserCommentSvgGlyph,
      strokedSvgGlyph: await render(strokedSvgResourceTree),
      noDomParserStrokedSvgGlyph,
      lineSvgGlyph: await render(lineSvgResourceTree),
      noDomParserLineSvgGlyph,
      shapeStrokeSvgGlyph: await render(shapeStrokeSvgResourceTree),
      noDomParserShapeStrokeSvgGlyph,
      dashedSvgGlyph: await render(dashedSvgResourceTree),
      noDomParserDashedSvgGlyph,
      styledDashSvgGlyph: await render(styledDashSvgResourceTree),
      noDomParserStyledDashSvgGlyph,
      pxLengthSvgGlyph: await render(pxLengthSvgResourceTree),
      noDomParserPxLengthSvgGlyph,
      zeroWidthStrokeSvgGlyph: await render(zeroWidthStrokeSvgResourceTree),
      noDomParserZeroWidthStrokeSvgGlyph,
      styledZeroWidthStrokeSvgGlyph: await render(styledZeroWidthStrokeSvgResourceTree),
      noDomParserStyledZeroWidthStrokeSvgGlyph,
      transparentStrokeSvgGlyph: await render(transparentStrokeSvgResourceTree),
      noDomParserTransparentStrokeSvgGlyph,
      styledTransparentStrokeSvgGlyph: await render(styledTransparentStrokeSvgResourceTree),
      noDomParserStyledTransparentStrokeSvgGlyph,
      invisibleStrokeOnlySvgGlyph: await render(invisibleStrokeOnlySvgResourceTree),
      noDomParserInvisibleStrokeOnlySvgGlyph,
      namedCssColorSvgGlyph: await render(namedCssColorSvgResourceTree),
      noDomParserNamedCssColorSvgGlyph,
      noCssNamedCssColorSvgGlyph,
      functionalCssColorSvgGlyph: await render(functionalCssColorSvgResourceTree),
      noDomParserFunctionalCssColorSvgGlyph,
      noCssFunctionalCssColorSvgGlyph,
      wideGamutCssColorSvgGlyph: await render(wideGamutCssColorSvgResourceTree),
      noDomParserWideGamutCssColorSvgGlyph,
      noCssWideGamutCssColorSvgGlyph,
      stylePrecedenceSvgGlyph: await render(stylePrecedenceSvgResourceTree),
      noDomParserStylePrecedenceSvgGlyph,
      styleCascadeSvgGlyph: await render(styleCascadeSvgResourceTree),
      noDomParserStyleCascadeSvgGlyph,
      styleCommentSvgGlyph: await render(styleCommentSvgResourceTree),
      noDomParserStyleCommentSvgGlyph,
      attributeEntitySvgGlyph: await render(attributeEntitySvgResourceTree),
      noDomParserAttributeEntitySvgGlyph,
      styleEntitySvgGlyph: await render(styleEntitySvgResourceTree),
      noDomParserStyleEntitySvgGlyph,
      polylineSvgGlyph: await render(polylineSvgResourceTree),
      noDomParserPolylineSvgGlyph,
      roundedRectSvgGlyph: await render(roundedRectSvgResourceTree),
      noDomParserRoundedRectSvgGlyph,
      transformedSvgGlyph: await render(transformedSvgResourceTree),
      noDomParserTransformedSvgGlyph,
      matrixTransformSvgGlyph: await render(matrixTransformSvgResourceTree),
      noDomParserMatrixTransformSvgGlyph,
      rootTransformSvgGlyph: await render(rootTransformSvgResourceTree),
      noDomParserRootTransformSvgGlyph,
      transformListSvgGlyph: await render(transformListSvgResourceTree),
      noDomParserTransformListSvgGlyph,
      groupTransformSvgGlyph: await render(groupTransformSvgResourceTree),
      noDomParserGroupTransformSvgGlyph,
      inheritedPaintSvgGlyph: await render(inheritedPaintSvgResourceTree),
      noDomParserInheritedPaintSvgGlyph,
      currentColorSvgGlyph: await render(currentColorSvgResourceTree),
      noDomParserCurrentColorSvgGlyph,
      identityOpacitySvgGlyph: await render(identityOpacitySvgResourceTree),
      noDomParserIdentityOpacitySvgGlyph,
      duplicateSvgGlyphKey: await render(duplicateSvgResourceTree),
      unsafeSvgGlyphResource: await render(unsafeSvgResourceTree),
      unsupportedSvgGlyphTextLayerResource: await render(textLayerSvgResourceTree),
      unsupportedSvgGlyphMalformedPathResource: await render(malformedPathSvgResourceTree),
      unsupportedSvgGlyphOverflowTransformResource: await render(overflowTransformSvgResourceTree),
      unsupportedSvgGlyphStrokeResource: await render(unsupportedSvgStrokeTree),
      unsupportedSvgGlyphOpacityResource: await render(unsupportedSvgOpacityTree),
      unsupportedSvgGlyphGroupOpacityResource: await render(unsupportedSvgGroupOpacityTree),
      unsupportedSvgGlyphFillRuleResource: await render(unsupportedSvgFillRuleTree),
      unsupportedSvgGlyphIndirectPaintResource: await render(unsupportedSvgIndirectPaintTree),
      unsupportedSvgGlyphImageHrefResource: await render(unsupportedSvgImageHrefTree),
      noDomParserUnsupportedSvgImageHrefResource,
      unsupportedSvgGlyphUseHrefResource: await render(unsupportedSvgUseHrefTree),
      noDomParserUnsupportedSvgUseHrefResource,
      unsupportedSvgGlyphForeignObjectResource: await render(unsupportedSvgForeignObjectTree),
      noDomParserUnsupportedSvgForeignObjectResource,
      unsupportedSvgGlyphFilterResource: await render(unsupportedSvgFilterTree),
      noDomParserUnsupportedSvgFilterResource,
      unsupportedSvgGlyphMaskResource: await render(unsupportedSvgMaskTree),
      noDomParserUnsupportedSvgMaskResource,
      unsupportedSvgGlyphClipPathResource: await render(unsupportedSvgClipPathTree),
      noDomParserUnsupportedSvgClipPathResource,
      unsupportedSvgGlyphInvalidColorResource: await render(unsupportedSvgInvalidColorTree),
      unsupportedSvgGlyphCrossedClosingTagResource: await render(unsupportedSvgCrossedClosingTagTree),
      noDomParserUnsupportedSvgDoctypeResource,
      noDomParserUnsupportedSvgClosingTagResource,
      unsupportedSvgGlyphDanglingShapeClosingTagResource: await render(unsupportedSvgDanglingShapeClosingTagTree),
      noDomParserUnsupportedSvgDanglingShapeClosingTagResource,
      unsupportedSvgGlyphMalformedCommentResource: await render(unsupportedSvgMalformedCommentTree),
      noDomParserUnsupportedSvgMalformedCommentResource,
      unsupportedSvgGlyphMalformedStyleCommentResource: await render(unsupportedSvgMalformedStyleCommentTree),
      noDomParserUnsupportedSvgMalformedStyleCommentResource,
      noDomParserUnsupportedSvgInvalidColorResource,
      unsupportedSvgGlyphUnknownEntityResource: await render(unsupportedSvgUnknownEntityTree),
      noDomParserUnsupportedSvgUnknownEntityResource,
      unsupportedSvgGlyphDuplicateAttributeResource: await render(unsupportedSvgDuplicateAttributeTree),
      noDomParserUnsupportedSvgDuplicateAttributeResource,
      unsupportedSvgGlyphStrayLessThanResource: await render(unsupportedSvgStrayLessThanTree),
      noDomParserUnsupportedSvgStrayLessThanResource,
      unsupportedSvgGlyphCdataEndResource: await render(unsupportedSvgCdataEndTree),
      noDomParserUnsupportedSvgCdataEndResource,
      unsupportedSvgGlyphTextEntityResource: await render(unsupportedSvgTextEntityTree),
      noDomParserUnsupportedSvgTextEntityResource,
      noDomParserUnsupportedSvgGroupOpacityResource,
    };
  });
  assert(!canvaskitGlyphOutlineProbe.error, canvaskitGlyphOutlineProbe.error || 'CanvasKit glyph outline probe available');
  const canvaskitMonochromeReport = canvaskitGlyphOutlineProbe.monochrome?.diagnostics?.find(
    (report) => report.equivalenceGroup === 'canvaskit-outline-mono',
  );
  assert(
    canvaskitMonochromeReport?.selectedVariantId === 'glyphOutline'
      && canvaskitMonochromeReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects monochrome GlyphOutline=${JSON.stringify(canvaskitMonochromeReport)}`,
  );
  const canvaskitStrokeReport = canvaskitGlyphOutlineProbe.stroke?.diagnostics?.find(
    (report) => report.equivalenceGroup === 'canvaskit-outline-stroke',
  );
  assert(
    canvaskitStrokeReport?.selectedVariantId === 'glyphOutline'
      && canvaskitStrokeReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects stroke GlyphOutline=${JSON.stringify(canvaskitStrokeReport)}`,
  );
  const canvaskitUnsupportedStrokeJoinCapReport = canvaskitGlyphOutlineProbe
    .unsupportedStrokeJoinCap
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-stroke-unsupported-join-cap');
  assert(
    canvaskitUnsupportedStrokeJoinCapReport?.selectedVariantId === 'textRun'
      && canvaskitUnsupportedStrokeJoinCapReport?.outlineEligibility?.payloadSupported === false
      && canvaskitUnsupportedStrokeJoinCapReport?.outlineEligibility?.replayEligible === false
      && canvaskitUnsupportedStrokeJoinCapReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('glyphOutlineStrokeStyleUnsupported'),
      ),
    `CanvasKit rejects unsupported stroke join/cap payload=${JSON.stringify(canvaskitUnsupportedStrokeJoinCapReport)}`,
  );
  const canvaskitMissingStrokeReport = canvaskitGlyphOutlineProbe
    .missingStroke
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-stroke-missing-style');
  assert(
    canvaskitMissingStrokeReport?.selectedVariantId === 'textRun'
      && canvaskitMissingStrokeReport?.outlineEligibility?.payloadSupported === false
      && canvaskitMissingStrokeReport?.outlineEligibility?.replayEligible === false
      && canvaskitMissingStrokeReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedOutlinePayload'),
      ),
    `CanvasKit rejects missing stroke payload=${JSON.stringify(canvaskitMissingStrokeReport)}`,
  );
  const canvaskitColorReport = canvaskitGlyphOutlineProbe.colorLayers?.diagnostics?.find(
    (report) => report.equivalenceGroup === 'canvaskit-outline-color',
  );
  assert(
    canvaskitColorReport?.selectedVariantId === 'glyphOutline'
      && canvaskitColorReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects COLRv0 ColorLayers GlyphOutline=${JSON.stringify(canvaskitColorReport)}`,
  );
  const canvaskitColorV1Report = canvaskitGlyphOutlineProbe.colorLayersColrV1?.diagnostics?.find(
    (report) => report.equivalenceGroup === 'canvaskit-outline-color-v1',
  );
  assert(
    canvaskitColorV1Report?.selectedVariantId === 'glyphOutline'
      && canvaskitColorV1Report?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects COLRv1 stage-1 ColorLayers GlyphOutline=${JSON.stringify(canvaskitColorV1Report)}`,
  );
  const canvaskitColorV1GradientReport = canvaskitGlyphOutlineProbe
    .colorLayersColrV1Gradient
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-color-v1-gradient');
  assert(
    canvaskitColorV1GradientReport?.selectedVariantId === 'glyphOutline'
      && canvaskitColorV1GradientReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects COLRv1 gradient ColorLayers GlyphOutline=${JSON.stringify(canvaskitColorV1GradientReport)}`,
  );
  const canvaskitBitmapReport = canvaskitGlyphOutlineProbe.bitmapGlyph?.diagnostics?.find(
    (report) => report.equivalenceGroup === 'canvaskit-outline-bitmap',
  );
  assert(
    canvaskitBitmapReport?.selectedVariantId === 'glyphOutline'
      && canvaskitBitmapReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects BitmapGlyph GlyphOutline=${JSON.stringify(canvaskitBitmapReport)}`,
  );
  const canvaskitTruncatedBitmapReport = canvaskitGlyphOutlineProbe
    .truncatedBitmapGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-bitmap');
  assert(
    canvaskitTruncatedBitmapReport?.selectedVariantId === 'textRun'
      && canvaskitTruncatedBitmapReport?.selectedVariantKind === 'textRun'
      && canvaskitTruncatedBitmapReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.details?.includes('imageDecodeFailed'),
      )
      && canvaskitGlyphOutlineProbe.truncatedBitmapGlyph.redPixels > 0,
    `CanvasKit BitmapGlyph runtime decode failure preserves TextRun fallback=${JSON.stringify({
      report: canvaskitTruncatedBitmapReport,
      redPixels: canvaskitGlyphOutlineProbe.truncatedBitmapGlyph?.redPixels,
    })}`,
  );
  const canvaskitNonpositiveBitmapBBoxReport = canvaskitGlyphOutlineProbe
    .nonpositiveBitmapBBoxGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-bitmap-empty-bbox');
  assert(
    canvaskitNonpositiveBitmapBBoxReport?.selectedVariantId === 'textRun'
      && canvaskitNonpositiveBitmapBBoxReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedBitmapGlyph'),
      ),
    `CanvasKit rejects non-positive BitmapGlyph bbox before replay=${JSON.stringify(canvaskitNonpositiveBitmapBBoxReport)}`,
  );
  const canvaskitMissingFilteringBitmapReport = canvaskitGlyphOutlineProbe
    .missingFilteringBitmapGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-bitmap-missing-filtering');
  assert(
    canvaskitMissingFilteringBitmapReport?.selectedVariantId === 'textRun'
      && canvaskitMissingFilteringBitmapReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedBitmapGlyph'),
    ),
    `CanvasKit rejects BitmapGlyph with missing strict filtering=${JSON.stringify(canvaskitMissingFilteringBitmapReport)}`,
  );
  const canvaskitMissingScalingBitmapReport = canvaskitGlyphOutlineProbe
    .missingScalingBitmapGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-bitmap-missing-scaling');
  assert(
    canvaskitMissingScalingBitmapReport?.selectedVariantId === 'textRun'
      && canvaskitMissingScalingBitmapReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedBitmapGlyph'),
      ),
    `CanvasKit rejects BitmapGlyph with missing strict scaling policy=${JSON.stringify(canvaskitMissingScalingBitmapReport)}`,
  );
  const canvaskitInvalidTransformBitmapReport = canvaskitGlyphOutlineProbe
    .invalidTransformBitmapGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-bitmap-invalid-transform');
  assert(
    canvaskitInvalidTransformBitmapReport?.selectedVariantId === 'textRun'
      && canvaskitInvalidTransformBitmapReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedBitmapGlyph'),
      ),
    `CanvasKit rejects BitmapGlyph with non-finite transform=${JSON.stringify(canvaskitInvalidTransformBitmapReport)}`,
  );
  const canvaskitInvalidSourceRangeBitmapReport = canvaskitGlyphOutlineProbe
    .invalidSourceRangeBitmapGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-bitmap-invalid-source-range');
  assert(
    canvaskitInvalidSourceRangeBitmapReport?.selectedVariantId === 'textRun'
      && canvaskitInvalidSourceRangeBitmapReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedBitmapGlyph'),
      ),
    `CanvasKit rejects BitmapGlyph with invalid source range=${JSON.stringify(canvaskitInvalidSourceRangeBitmapReport)}`,
  );
  const canvaskitEmptyGlyphRangeBitmapReport = canvaskitGlyphOutlineProbe
    .emptyGlyphRangeBitmapGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-bitmap-empty-glyph-range');
  assert(
    canvaskitEmptyGlyphRangeBitmapReport?.selectedVariantId === 'textRun'
      && canvaskitEmptyGlyphRangeBitmapReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedBitmapGlyph'),
      ),
    `CanvasKit rejects BitmapGlyph with empty glyph range=${JSON.stringify(canvaskitEmptyGlyphRangeBitmapReport)}`,
  );
  const canvaskitMissingBaselineBitmapReport = canvaskitGlyphOutlineProbe
    .missingBaselineBitmapGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-bitmap-missing-baseline');
  assert(
    canvaskitMissingBaselineBitmapReport?.selectedVariantId === 'textRun'
      && canvaskitMissingBaselineBitmapReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedBitmapGlyph'),
      ),
    `CanvasKit rejects BitmapGlyph with missing placement baseline=${JSON.stringify(canvaskitMissingBaselineBitmapReport)}`,
  );
  const canvaskitMissingAlphaBitmapReport = canvaskitGlyphOutlineProbe
    .missingAlphaBitmapGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-bitmap-missing-alpha');
  assert(
    canvaskitMissingAlphaBitmapReport?.selectedVariantId === 'textRun'
      && canvaskitMissingAlphaBitmapReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedBitmapGlyph'),
      ),
    `CanvasKit rejects BitmapGlyph with missing alpha mode=${JSON.stringify(canvaskitMissingAlphaBitmapReport)}`,
  );
  const canvaskitEmptyColorSpaceBitmapReport = canvaskitGlyphOutlineProbe
    .emptyColorSpaceBitmapGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-bitmap-empty-color-space');
  assert(
    canvaskitEmptyColorSpaceBitmapReport?.selectedVariantId === 'textRun'
      && canvaskitEmptyColorSpaceBitmapReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedBitmapGlyph'),
      ),
    `CanvasKit rejects BitmapGlyph with empty colorSpace=${JSON.stringify(canvaskitEmptyColorSpaceBitmapReport)}`,
  );
  const canvaskitBackendDefaultScalingBitmapReport = canvaskitGlyphOutlineProbe
    .backendDefaultScalingBitmapGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-bitmap-backend-default-scaling');
  assert(
    canvaskitBackendDefaultScalingBitmapReport?.selectedVariantId === 'textRun'
      && canvaskitBackendDefaultScalingBitmapReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedBitmapGlyph'),
      ),
    `CanvasKit rejects BitmapGlyph backend-default scaling=${JSON.stringify(canvaskitBackendDefaultScalingBitmapReport)}`,
  );
  const canvaskitBackendDefaultFilteringBitmapReport = canvaskitGlyphOutlineProbe
    .backendDefaultFilteringBitmapGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-bitmap-backend-default-filtering');
  assert(
    canvaskitBackendDefaultFilteringBitmapReport?.selectedVariantId === 'textRun'
      && canvaskitBackendDefaultFilteringBitmapReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedBitmapGlyph'),
      ),
    `CanvasKit rejects BitmapGlyph backend-default filtering=${JSON.stringify(canvaskitBackendDefaultFilteringBitmapReport)}`,
  );
  const canvaskitInvalidStrikePpemBitmapReport = canvaskitGlyphOutlineProbe
    .invalidStrikePpemBitmapGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-bitmap-invalid-strike-ppem');
  assert(
    canvaskitInvalidStrikePpemBitmapReport?.selectedVariantId === 'textRun'
      && canvaskitInvalidStrikePpemBitmapReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedBitmapGlyph'),
      ),
    `CanvasKit rejects BitmapGlyph non-positive strike ppem=${JSON.stringify(canvaskitInvalidStrikePpemBitmapReport)}`,
  );
  const canvaskitMissingStrikeSelectionBitmapReport = canvaskitGlyphOutlineProbe
    .missingStrikeSelectionBitmapGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-bitmap-missing-strike-selection');
  assert(
    canvaskitMissingStrikeSelectionBitmapReport?.selectedVariantId === 'textRun'
      && canvaskitMissingStrikeSelectionBitmapReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedBitmapGlyph'),
      ),
    `CanvasKit rejects BitmapGlyph missing producer-resolved strike selection=${JSON.stringify(canvaskitMissingStrikeSelectionBitmapReport)}`,
  );
  const canvaskitDiagnosticStrikeBitmapReport = canvaskitGlyphOutlineProbe
    .diagnosticStrikeBitmapGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-bitmap-diagnostic-strike');
  assert(
    canvaskitDiagnosticStrikeBitmapReport?.selectedVariantId === 'textRun'
      && canvaskitDiagnosticStrikeBitmapReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedBitmapGlyph'),
      ),
    `CanvasKit rejects diagnostic-only BitmapGlyph strike=${JSON.stringify(canvaskitDiagnosticStrikeBitmapReport)}`,
  );
  const canvaskitStrikeReselectionBitmapReport = canvaskitGlyphOutlineProbe
    .strikeReselectionBitmapGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-bitmap-strike-reselection');
  assert(
    canvaskitStrikeReselectionBitmapReport?.selectedVariantId === 'textRun'
      && canvaskitStrikeReselectionBitmapReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedBitmapGlyph'),
      ),
    `CanvasKit rejects BitmapGlyph backend strike reselection=${JSON.stringify(canvaskitStrikeReselectionBitmapReport)}`,
  );
  const canvaskitMissingResourceBitmapReport = canvaskitGlyphOutlineProbe
    .missingResourceBitmapGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-bitmap-missing-resource');
  assert(
    canvaskitMissingResourceBitmapReport?.selectedVariantId === 'textRun'
      && canvaskitMissingResourceBitmapReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedBitmapGlyph'),
      ),
    `CanvasKit rejects BitmapGlyph missing image resource=${JSON.stringify(canvaskitMissingResourceBitmapReport)}`,
  );
  const canvaskitDuplicateBitmapKeyReport = canvaskitGlyphOutlineProbe
    .duplicateBitmapGlyphKey
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-bitmap');
  assert(
    canvaskitDuplicateBitmapKeyReport?.selectedVariantId === 'textRun'
      && canvaskitDuplicateBitmapKeyReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedBitmapGlyph'),
      ),
    `CanvasKit rejects ambiguous BitmapGlyph resource keys=${JSON.stringify(canvaskitDuplicateBitmapKeyReport)}`,
  );
  const canvaskitSvgReport = canvaskitGlyphOutlineProbe.svgGlyph?.diagnostics?.find(
    (report) => report.equivalenceGroup === 'canvaskit-outline-svg',
  );
  assert(
    canvaskitSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects SvgGlyph GlyphOutline=${JSON.stringify(canvaskitSvgReport)}`,
  );
  assert(
    canvaskitGlyphOutlineProbe.svgGlyphPathDecodeCalls === 1,
    `CanvasKit reuses one prepared SvgGlyph path for selection and drawing decodeCalls=${canvaskitGlyphOutlineProbe.svgGlyphPathDecodeCalls}`,
  );
  const canvaskitMissingResourceSvgReport = canvaskitGlyphOutlineProbe
    .missingResourceSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg-missing-resource');
  assert(
    canvaskitMissingResourceSvgReport?.selectedVariantId === 'textRun'
      && canvaskitMissingResourceSvgReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      ),
    `CanvasKit rejects SvgGlyph missing vector resource=${JSON.stringify(canvaskitMissingResourceSvgReport)}`,
  );
  const canvaskitNonpositiveSvgBBoxReport = canvaskitGlyphOutlineProbe
    .nonpositiveSvgBBoxGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg-empty-bbox');
  assert(
    canvaskitNonpositiveSvgBBoxReport?.selectedVariantId === 'textRun'
      && canvaskitNonpositiveSvgBBoxReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      ),
    `CanvasKit rejects non-positive SvgGlyph bbox before replay=${JSON.stringify(canvaskitNonpositiveSvgBBoxReport)}`,
  );
  const canvaskitMissingViewBoxSvgReport = canvaskitGlyphOutlineProbe
    .missingViewBoxSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg-missing-viewbox');
  assert(
    canvaskitMissingViewBoxSvgReport?.selectedVariantId === 'textRun'
      && canvaskitMissingViewBoxSvgReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
    ),
    `CanvasKit rejects SvgGlyph with missing viewBox=${JSON.stringify(canvaskitMissingViewBoxSvgReport)}`,
  );
  const canvaskitInvalidTransformSvgReport = canvaskitGlyphOutlineProbe
    .invalidTransformSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg-invalid-transform');
  assert(
    canvaskitInvalidTransformSvgReport?.selectedVariantId === 'textRun'
      && canvaskitInvalidTransformSvgReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      ),
    `CanvasKit rejects SvgGlyph with non-finite transform=${JSON.stringify(canvaskitInvalidTransformSvgReport)}`,
  );
  const canvaskitInvalidSourceRangeSvgReport = canvaskitGlyphOutlineProbe
    .invalidSourceRangeSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg-invalid-source-range');
  assert(
    canvaskitInvalidSourceRangeSvgReport?.selectedVariantId === 'textRun'
      && canvaskitInvalidSourceRangeSvgReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      ),
    `CanvasKit rejects SvgGlyph with invalid source range=${JSON.stringify(canvaskitInvalidSourceRangeSvgReport)}`,
  );
  const canvaskitEmptyGlyphRangeSvgReport = canvaskitGlyphOutlineProbe
    .emptyGlyphRangeSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg-empty-glyph-range');
  assert(
    canvaskitEmptyGlyphRangeSvgReport?.selectedVariantId === 'textRun'
      && canvaskitEmptyGlyphRangeSvgReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      ),
    `CanvasKit rejects SvgGlyph with empty glyph range=${JSON.stringify(canvaskitEmptyGlyphRangeSvgReport)}`,
  );
  const canvaskitInvalidSecurityModeSvgReport = canvaskitGlyphOutlineProbe
    .invalidSecurityModeSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg-invalid-security-mode');
  assert(
    canvaskitInvalidSecurityModeSvgReport?.selectedVariantId === 'textRun'
      && canvaskitInvalidSecurityModeSvgReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
    ),
    `CanvasKit rejects SvgGlyph with invalid security mode=${JSON.stringify(canvaskitInvalidSecurityModeSvgReport)}`,
  );
  const canvaskitMissingSecurityModeSvgReport = canvaskitGlyphOutlineProbe
    .missingSecurityModeSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg-missing-security-mode');
  assert(
    canvaskitMissingSecurityModeSvgReport?.selectedVariantId === 'textRun'
      && canvaskitMissingSecurityModeSvgReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
    ),
    `CanvasKit rejects SvgGlyph with missing security mode=${JSON.stringify(canvaskitMissingSecurityModeSvgReport)}`,
  );
  const canvaskitMissingScriptAllowedSvgReport = canvaskitGlyphOutlineProbe
    .missingScriptAllowedSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg-missing-script-allowed');
  assert(
    canvaskitMissingScriptAllowedSvgReport?.selectedVariantId === 'textRun'
      && canvaskitMissingScriptAllowedSvgReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
    ),
    `CanvasKit rejects SvgGlyph with missing hard-false script flag=${JSON.stringify(canvaskitMissingScriptAllowedSvgReport)}`,
  );
  const canvaskitMissingAnimationAllowedSvgReport = canvaskitGlyphOutlineProbe
    .missingAnimationAllowedSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg-missing-animation-allowed');
  assert(
    canvaskitMissingAnimationAllowedSvgReport?.selectedVariantId === 'textRun'
      && canvaskitMissingAnimationAllowedSvgReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
    ),
    `CanvasKit rejects SvgGlyph with missing hard-false animation flag=${JSON.stringify(canvaskitMissingAnimationAllowedSvgReport)}`,
  );
  const canvaskitMissingExternalResourcesAllowedSvgReport = canvaskitGlyphOutlineProbe
    .missingExternalResourcesAllowedSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg-missing-external-resources-allowed');
  assert(
    canvaskitMissingExternalResourcesAllowedSvgReport?.selectedVariantId === 'textRun'
      && canvaskitMissingExternalResourcesAllowedSvgReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
    ),
    `CanvasKit rejects SvgGlyph with missing hard-false external resource flag=${JSON.stringify(canvaskitMissingExternalResourcesAllowedSvgReport)}`,
  );
  const canvaskitMissingInteractivityAllowedSvgReport = canvaskitGlyphOutlineProbe
    .missingInteractivityAllowedSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg-missing-interactivity-allowed');
  assert(
    canvaskitMissingInteractivityAllowedSvgReport?.selectedVariantId === 'textRun'
      && canvaskitMissingInteractivityAllowedSvgReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
    ),
    `CanvasKit rejects SvgGlyph with missing hard-false interactivity flag=${JSON.stringify(canvaskitMissingInteractivityAllowedSvgReport)}`,
  );
  const canvaskitInvalidIntrinsicSizeSvgReport = canvaskitGlyphOutlineProbe
    .invalidIntrinsicSizeSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg-invalid-intrinsic-size');
  assert(
    canvaskitInvalidIntrinsicSizeSvgReport?.selectedVariantId === 'textRun'
      && canvaskitInvalidIntrinsicSizeSvgReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      ),
    `CanvasKit rejects SvgGlyph with non-positive intrinsic size=${JSON.stringify(canvaskitInvalidIntrinsicSizeSvgReport)}`,
  );
  const canvaskitInvalidPlacementSvgReport = canvaskitGlyphOutlineProbe
    .invalidPlacementSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg-invalid-placement');
  assert(
    canvaskitInvalidPlacementSvgReport?.selectedVariantId === 'textRun'
      && canvaskitInvalidPlacementSvgReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      ),
    `CanvasKit rejects SvgGlyph with non-finite placement=${JSON.stringify(canvaskitInvalidPlacementSvgReport)}`,
  );
  const canvaskitMissingBaselineSvgReport = canvaskitGlyphOutlineProbe
    .missingBaselineSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg-missing-baseline');
  assert(
    canvaskitMissingBaselineSvgReport?.selectedVariantId === 'textRun'
      && canvaskitMissingBaselineSvgReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      ),
    `CanvasKit rejects SvgGlyph with missing placement baseline=${JSON.stringify(canvaskitMissingBaselineSvgReport)}`,
  );
  const canvaskitUnsafeFlagsSvgReport = canvaskitGlyphOutlineProbe
    .unsafeFlagsSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg-unsafe-flags');
  assert(
    canvaskitUnsafeFlagsSvgReport?.selectedVariantId === 'textRun'
      && canvaskitUnsafeFlagsSvgReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      ),
    `CanvasKit rejects SvgGlyph with unsafe static-vector flags=${JSON.stringify(canvaskitUnsafeFlagsSvgReport)}`,
  );
  const canvaskitRawInlineSvgReport = canvaskitGlyphOutlineProbe
    .rawInlineSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg-raw-inline');
  assert(
    canvaskitRawInlineSvgReport?.selectedVariantId === 'textRun'
      && canvaskitRawInlineSvgReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      ),
    `CanvasKit rejects SvgGlyph raw inline replay fields=${JSON.stringify(canvaskitRawInlineSvgReport)}`,
  );
  const canvaskitNoDomParserSvgReport = canvaskitGlyphOutlineProbe
    .noDomParserSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNoDomParserSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNoDomParserSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects SvgGlyph without DOMParser=${JSON.stringify(canvaskitNoDomParserSvgReport)}`,
  );
  const canvaskitWrappedSvgReport = canvaskitGlyphOutlineProbe
    .wrappedSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitWrappedSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitWrappedSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects wrapped SvgGlyph resource=${JSON.stringify(canvaskitWrappedSvgReport)}`,
  );
  const canvaskitNoDomParserWrappedSvgReport = canvaskitGlyphOutlineProbe
    .noDomParserWrappedSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNoDomParserWrappedSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNoDomParserWrappedSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects wrapped SvgGlyph without DOMParser=${JSON.stringify(canvaskitNoDomParserWrappedSvgReport)}`,
  );
  const canvaskitNonVisualAttributesSvgReport = canvaskitGlyphOutlineProbe
    .nonVisualAttributesSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNonVisualAttributesSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNonVisualAttributesSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects nonvisual-attribute SvgGlyph resource=${JSON.stringify(canvaskitNonVisualAttributesSvgReport)}`,
  );
  const canvaskitNoDomParserNonVisualAttributesSvgReport = canvaskitGlyphOutlineProbe
    .noDomParserNonVisualAttributesSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNoDomParserNonVisualAttributesSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNoDomParserNonVisualAttributesSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects nonvisual-attribute SvgGlyph without DOMParser=${JSON.stringify(canvaskitNoDomParserNonVisualAttributesSvgReport)}`,
  );
  const canvaskitBalancedShapeSvgReport = canvaskitGlyphOutlineProbe
    .balancedShapeSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitBalancedShapeSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitBalancedShapeSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects balanced shape SvgGlyph resource=${JSON.stringify(canvaskitBalancedShapeSvgReport)}`,
  );
  const canvaskitNoDomParserBalancedShapeSvgReport = canvaskitGlyphOutlineProbe
    .noDomParserBalancedShapeSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNoDomParserBalancedShapeSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNoDomParserBalancedShapeSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects balanced shape SvgGlyph without DOMParser=${JSON.stringify(canvaskitNoDomParserBalancedShapeSvgReport)}`,
  );
  const canvaskitDefsSvgReport = canvaskitGlyphOutlineProbe
    .defsSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitDefsSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitDefsSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects defs SvgGlyph resource=${JSON.stringify(canvaskitDefsSvgReport)}`,
  );
  const canvaskitNoDomParserDefsSvgReport = canvaskitGlyphOutlineProbe
    .noDomParserDefsSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNoDomParserDefsSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNoDomParserDefsSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects defs SvgGlyph without DOMParser=${JSON.stringify(canvaskitNoDomParserDefsSvgReport)}`,
  );
  const canvaskitNonRenderingMetadataSvgReport = canvaskitGlyphOutlineProbe
    .nonRenderingMetadataSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNonRenderingMetadataSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNonRenderingMetadataSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects non-rendering metadata SvgGlyph resource=${JSON.stringify(canvaskitNonRenderingMetadataSvgReport)}`,
  );
  const canvaskitNoDomParserNonRenderingMetadataSvgReport = canvaskitGlyphOutlineProbe
    .noDomParserNonRenderingMetadataSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNoDomParserNonRenderingMetadataSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNoDomParserNonRenderingMetadataSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects non-rendering metadata SvgGlyph without DOMParser=${JSON.stringify(canvaskitNoDomParserNonRenderingMetadataSvgReport)}`,
  );
  const canvaskitCommentSvgReport = canvaskitGlyphOutlineProbe
    .commentSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitCommentSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitCommentSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects comment SvgGlyph resource=${JSON.stringify(canvaskitCommentSvgReport)}`,
  );
  const canvaskitNoDomParserCommentSvgReport = canvaskitGlyphOutlineProbe
    .noDomParserCommentSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNoDomParserCommentSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNoDomParserCommentSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects comment SvgGlyph without DOMParser=${JSON.stringify(canvaskitNoDomParserCommentSvgReport)}`,
  );
  const canvaskitStrokedSvgReport = canvaskitGlyphOutlineProbe
    .strokedSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitStrokedSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitStrokedSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects stroked SvgGlyph resource=${JSON.stringify(canvaskitStrokedSvgReport)}`,
  );
  const canvaskitNoDomParserStrokedSvgReport = canvaskitGlyphOutlineProbe
    .noDomParserStrokedSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNoDomParserStrokedSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNoDomParserStrokedSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects stroked SvgGlyph without DOMParser=${JSON.stringify(canvaskitNoDomParserStrokedSvgReport)}`,
  );
  const canvaskitLineSvgReport = canvaskitGlyphOutlineProbe
    .lineSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitLineSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitLineSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects line SvgGlyph resource=${JSON.stringify(canvaskitLineSvgReport)}`,
  );
  const canvaskitNoDomParserLineSvgReport = canvaskitGlyphOutlineProbe
    .noDomParserLineSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNoDomParserLineSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNoDomParserLineSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects line SvgGlyph without DOMParser=${JSON.stringify(canvaskitNoDomParserLineSvgReport)}`,
  );
  const canvaskitShapeStrokeSvgReport = canvaskitGlyphOutlineProbe
    .shapeStrokeSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitShapeStrokeSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitShapeStrokeSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects stroked-shape SvgGlyph resource=${JSON.stringify(canvaskitShapeStrokeSvgReport)}`,
  );
  const canvaskitNoDomParserShapeStrokeSvgReport = canvaskitGlyphOutlineProbe
    .noDomParserShapeStrokeSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNoDomParserShapeStrokeSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNoDomParserShapeStrokeSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects stroked-shape SvgGlyph without DOMParser=${JSON.stringify(canvaskitNoDomParserShapeStrokeSvgReport)}`,
  );
  const canvaskitDashedSvgReport = canvaskitGlyphOutlineProbe
    .dashedSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitDashedSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitDashedSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects dashed SvgGlyph resource=${JSON.stringify(canvaskitDashedSvgReport)}`,
  );
  const canvaskitNoDomParserDashedSvgReport = canvaskitGlyphOutlineProbe
    .noDomParserDashedSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNoDomParserDashedSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNoDomParserDashedSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects dashed SvgGlyph without DOMParser=${JSON.stringify(canvaskitNoDomParserDashedSvgReport)}`,
  );
  const canvaskitStyledDashSvgReport = canvaskitGlyphOutlineProbe
    .styledDashSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitStyledDashSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitStyledDashSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects styled dashed SvgGlyph resource=${JSON.stringify(canvaskitStyledDashSvgReport)}`,
  );
  const canvaskitNoDomParserStyledDashSvgReport = canvaskitGlyphOutlineProbe
    .noDomParserStyledDashSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNoDomParserStyledDashSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNoDomParserStyledDashSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects styled dashed SvgGlyph without DOMParser=${JSON.stringify(canvaskitNoDomParserStyledDashSvgReport)}`,
  );
  const canvaskitPxLengthSvgReport = canvaskitGlyphOutlineProbe
    .pxLengthSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitPxLengthSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitPxLengthSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects px-length SvgGlyph resource=${JSON.stringify(canvaskitPxLengthSvgReport)}`,
  );
  const canvaskitNoDomParserPxLengthSvgReport = canvaskitGlyphOutlineProbe
    .noDomParserPxLengthSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNoDomParserPxLengthSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNoDomParserPxLengthSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects px-length SvgGlyph without DOMParser=${JSON.stringify(canvaskitNoDomParserPxLengthSvgReport)}`,
  );
  const canvaskitZeroWidthStrokeSvgReport = canvaskitGlyphOutlineProbe
    .zeroWidthStrokeSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitZeroWidthStrokeSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitZeroWidthStrokeSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects zero-width stroke SvgGlyph resource=${JSON.stringify(canvaskitZeroWidthStrokeSvgReport)}`,
  );
  const canvaskitNoDomParserZeroWidthStrokeSvgReport = canvaskitGlyphOutlineProbe
    .noDomParserZeroWidthStrokeSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNoDomParserZeroWidthStrokeSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNoDomParserZeroWidthStrokeSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects zero-width stroke SvgGlyph without DOMParser=${JSON.stringify(canvaskitNoDomParserZeroWidthStrokeSvgReport)}`,
  );
  const canvaskitStyledZeroWidthStrokeSvgReport = canvaskitGlyphOutlineProbe
    .styledZeroWidthStrokeSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitStyledZeroWidthStrokeSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitStyledZeroWidthStrokeSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects styled zero-width stroke SvgGlyph resource=${JSON.stringify(canvaskitStyledZeroWidthStrokeSvgReport)}`,
  );
  const canvaskitNoDomParserStyledZeroWidthStrokeSvgReport = canvaskitGlyphOutlineProbe
    .noDomParserStyledZeroWidthStrokeSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNoDomParserStyledZeroWidthStrokeSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNoDomParserStyledZeroWidthStrokeSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects styled zero-width stroke SvgGlyph without DOMParser=${JSON.stringify(canvaskitNoDomParserStyledZeroWidthStrokeSvgReport)}`,
  );
  const canvaskitTransparentStrokeSvgReport = canvaskitGlyphOutlineProbe
    .transparentStrokeSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitTransparentStrokeSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitTransparentStrokeSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects transparent stroke SvgGlyph resource=${JSON.stringify(canvaskitTransparentStrokeSvgReport)}`,
  );
  const canvaskitNoDomParserTransparentStrokeSvgReport = canvaskitGlyphOutlineProbe
    .noDomParserTransparentStrokeSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNoDomParserTransparentStrokeSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNoDomParserTransparentStrokeSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects transparent stroke SvgGlyph without DOMParser=${JSON.stringify(canvaskitNoDomParserTransparentStrokeSvgReport)}`,
  );
  const canvaskitStyledTransparentStrokeSvgReport = canvaskitGlyphOutlineProbe
    .styledTransparentStrokeSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitStyledTransparentStrokeSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitStyledTransparentStrokeSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects styled transparent stroke SvgGlyph resource=${JSON.stringify(canvaskitStyledTransparentStrokeSvgReport)}`,
  );
  const canvaskitNoDomParserStyledTransparentStrokeSvgReport = canvaskitGlyphOutlineProbe
    .noDomParserStyledTransparentStrokeSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNoDomParserStyledTransparentStrokeSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNoDomParserStyledTransparentStrokeSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects styled transparent stroke SvgGlyph without DOMParser=${JSON.stringify(canvaskitNoDomParserStyledTransparentStrokeSvgReport)}`,
  );
  const canvaskitInvisibleStrokeOnlySvgReport = canvaskitGlyphOutlineProbe
    .invisibleStrokeOnlySvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitInvisibleStrokeOnlySvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitInvisibleStrokeOnlySvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects invisible stroke-only SvgGlyph resource=${JSON.stringify(canvaskitInvisibleStrokeOnlySvgReport)}`,
  );
  const canvaskitNoDomParserInvisibleStrokeOnlySvgReport = canvaskitGlyphOutlineProbe
    .noDomParserInvisibleStrokeOnlySvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNoDomParserInvisibleStrokeOnlySvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNoDomParserInvisibleStrokeOnlySvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects invisible stroke-only SvgGlyph without DOMParser=${JSON.stringify(canvaskitNoDomParserInvisibleStrokeOnlySvgReport)}`,
  );
  const canvaskitNamedCssColorSvgReport = canvaskitGlyphOutlineProbe
    .namedCssColorSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNamedCssColorSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNamedCssColorSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects named CSS color SvgGlyph resource=${JSON.stringify(canvaskitNamedCssColorSvgReport)}`,
  );
  const canvaskitNoDomParserNamedCssColorSvgReport = canvaskitGlyphOutlineProbe
    .noDomParserNamedCssColorSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNoDomParserNamedCssColorSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNoDomParserNamedCssColorSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects named CSS color SvgGlyph without DOMParser=${JSON.stringify(canvaskitNoDomParserNamedCssColorSvgReport)}`,
  );
  const canvaskitNoCssNamedCssColorSvgReport = canvaskitGlyphOutlineProbe
    .noCssNamedCssColorSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNoCssNamedCssColorSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNoCssNamedCssColorSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects full named CSS color SvgGlyph without DOMParser/CSS=${JSON.stringify(canvaskitNoCssNamedCssColorSvgReport)}`,
  );
  const canvaskitFunctionalCssColorSvgReport = canvaskitGlyphOutlineProbe
    .functionalCssColorSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitFunctionalCssColorSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitFunctionalCssColorSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects functional CSS color SvgGlyph resource=${JSON.stringify(canvaskitFunctionalCssColorSvgReport)}`,
  );
  const canvaskitNoDomParserFunctionalCssColorSvgReport = canvaskitGlyphOutlineProbe
    .noDomParserFunctionalCssColorSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNoDomParserFunctionalCssColorSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNoDomParserFunctionalCssColorSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects functional CSS color SvgGlyph without DOMParser=${JSON.stringify(canvaskitNoDomParserFunctionalCssColorSvgReport)}`,
  );
  const canvaskitNoCssFunctionalCssColorSvgReport = canvaskitGlyphOutlineProbe
    .noCssFunctionalCssColorSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNoCssFunctionalCssColorSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNoCssFunctionalCssColorSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects functional CSS color SvgGlyph without DOMParser/CSS=${JSON.stringify(canvaskitNoCssFunctionalCssColorSvgReport)}`,
  );
  const canvaskitWideGamutCssColorSvgReport = canvaskitGlyphOutlineProbe
    .wideGamutCssColorSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitWideGamutCssColorSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitWideGamutCssColorSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects wide-gamut CSS color SvgGlyph resource=${JSON.stringify(canvaskitWideGamutCssColorSvgReport)}`,
  );
  const canvaskitNoDomParserWideGamutCssColorSvgReport = canvaskitGlyphOutlineProbe
    .noDomParserWideGamutCssColorSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNoDomParserWideGamutCssColorSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNoDomParserWideGamutCssColorSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects wide-gamut CSS color SvgGlyph without DOMParser=${JSON.stringify(canvaskitNoDomParserWideGamutCssColorSvgReport)}`,
  );
  const canvaskitNoCssWideGamutCssColorSvgReport = canvaskitGlyphOutlineProbe
    .noCssWideGamutCssColorSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNoCssWideGamutCssColorSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNoCssWideGamutCssColorSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects wide-gamut CSS color SvgGlyph without DOMParser/CSS=${JSON.stringify(canvaskitNoCssWideGamutCssColorSvgReport)}`,
  );
  const canvaskitStylePrecedenceSvgReport = canvaskitGlyphOutlineProbe
    .stylePrecedenceSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitStylePrecedenceSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitStylePrecedenceSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects style-precedence SvgGlyph resource=${JSON.stringify(canvaskitStylePrecedenceSvgReport)}`,
  );
  const canvaskitNoDomParserStylePrecedenceSvgReport = canvaskitGlyphOutlineProbe
    .noDomParserStylePrecedenceSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNoDomParserStylePrecedenceSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNoDomParserStylePrecedenceSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects style-precedence SvgGlyph without DOMParser=${JSON.stringify(canvaskitNoDomParserStylePrecedenceSvgReport)}`,
  );
  const canvaskitStyleCascadeSvgReport = canvaskitGlyphOutlineProbe
    .styleCascadeSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitStyleCascadeSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitStyleCascadeSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects style-cascade SvgGlyph resource=${JSON.stringify(canvaskitStyleCascadeSvgReport)}`,
  );
  const canvaskitNoDomParserStyleCascadeSvgReport = canvaskitGlyphOutlineProbe
    .noDomParserStyleCascadeSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNoDomParserStyleCascadeSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNoDomParserStyleCascadeSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects style-cascade SvgGlyph without DOMParser=${JSON.stringify(canvaskitNoDomParserStyleCascadeSvgReport)}`,
  );
  const canvaskitStyleCommentSvgReport = canvaskitGlyphOutlineProbe
    .styleCommentSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitStyleCommentSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitStyleCommentSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects style-comment SvgGlyph resource=${JSON.stringify(canvaskitStyleCommentSvgReport)}`,
  );
  const canvaskitNoDomParserStyleCommentSvgReport = canvaskitGlyphOutlineProbe
    .noDomParserStyleCommentSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNoDomParserStyleCommentSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNoDomParserStyleCommentSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects style-comment SvgGlyph without DOMParser=${JSON.stringify(canvaskitNoDomParserStyleCommentSvgReport)}`,
  );
  const canvaskitAttributeEntitySvgReport = canvaskitGlyphOutlineProbe
    .attributeEntitySvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitAttributeEntitySvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitAttributeEntitySvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects entity-encoded SvgGlyph resource=${JSON.stringify(canvaskitAttributeEntitySvgReport)}`,
  );
  const canvaskitNoDomParserAttributeEntitySvgReport = canvaskitGlyphOutlineProbe
    .noDomParserAttributeEntitySvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNoDomParserAttributeEntitySvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNoDomParserAttributeEntitySvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects entity-encoded SvgGlyph without DOMParser=${JSON.stringify(canvaskitNoDomParserAttributeEntitySvgReport)}`,
  );
  const canvaskitStyleEntitySvgReport = canvaskitGlyphOutlineProbe
    .styleEntitySvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitStyleEntitySvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitStyleEntitySvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects style entity-encoded SvgGlyph resource=${JSON.stringify(canvaskitStyleEntitySvgReport)}`,
  );
  const canvaskitNoDomParserStyleEntitySvgReport = canvaskitGlyphOutlineProbe
    .noDomParserStyleEntitySvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNoDomParserStyleEntitySvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNoDomParserStyleEntitySvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects style entity-encoded SvgGlyph without DOMParser=${JSON.stringify(canvaskitNoDomParserStyleEntitySvgReport)}`,
  );
  const canvaskitPolylineSvgReport = canvaskitGlyphOutlineProbe
    .polylineSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitPolylineSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitPolylineSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects polyline SvgGlyph resource=${JSON.stringify(canvaskitPolylineSvgReport)}`,
  );
  const canvaskitNoDomParserPolylineSvgReport = canvaskitGlyphOutlineProbe
    .noDomParserPolylineSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNoDomParserPolylineSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNoDomParserPolylineSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects polyline SvgGlyph without DOMParser=${JSON.stringify(canvaskitNoDomParserPolylineSvgReport)}`,
  );
  const canvaskitRoundedRectSvgReport = canvaskitGlyphOutlineProbe
    .roundedRectSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitRoundedRectSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitRoundedRectSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects rounded rect SvgGlyph resource=${JSON.stringify(canvaskitRoundedRectSvgReport)}`,
  );
  const canvaskitNoDomParserRoundedRectSvgReport = canvaskitGlyphOutlineProbe
    .noDomParserRoundedRectSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNoDomParserRoundedRectSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNoDomParserRoundedRectSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects rounded rect SvgGlyph without DOMParser=${JSON.stringify(canvaskitNoDomParserRoundedRectSvgReport)}`,
  );
  const canvaskitTransformedSvgReport = canvaskitGlyphOutlineProbe
    .transformedSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitTransformedSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitTransformedSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects transformed SvgGlyph resource=${JSON.stringify(canvaskitTransformedSvgReport)}`,
  );
  const canvaskitNoDomParserTransformedSvgReport = canvaskitGlyphOutlineProbe
    .noDomParserTransformedSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNoDomParserTransformedSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNoDomParserTransformedSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects transformed SvgGlyph without DOMParser=${JSON.stringify(canvaskitNoDomParserTransformedSvgReport)}`,
  );
  const canvaskitMatrixTransformSvgReport = canvaskitGlyphOutlineProbe
    .matrixTransformSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitMatrixTransformSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitMatrixTransformSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects matrix-transform SvgGlyph resource=${JSON.stringify(canvaskitMatrixTransformSvgReport)}`,
  );
  const canvaskitNoDomParserMatrixTransformSvgReport = canvaskitGlyphOutlineProbe
    .noDomParserMatrixTransformSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNoDomParserMatrixTransformSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNoDomParserMatrixTransformSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects matrix-transform SvgGlyph without DOMParser=${JSON.stringify(canvaskitNoDomParserMatrixTransformSvgReport)}`,
  );
  const canvaskitRootTransformSvgReport = canvaskitGlyphOutlineProbe
    .rootTransformSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitRootTransformSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitRootTransformSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects root-transform SvgGlyph resource=${JSON.stringify(canvaskitRootTransformSvgReport)}`,
  );
  const canvaskitNoDomParserRootTransformSvgReport = canvaskitGlyphOutlineProbe
    .noDomParserRootTransformSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNoDomParserRootTransformSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNoDomParserRootTransformSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects root-transform SvgGlyph without DOMParser=${JSON.stringify(canvaskitNoDomParserRootTransformSvgReport)}`,
  );
  const canvaskitTransformListSvgReport = canvaskitGlyphOutlineProbe
    .transformListSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitTransformListSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitTransformListSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects transform-list SvgGlyph resource=${JSON.stringify(canvaskitTransformListSvgReport)}`,
  );
  const canvaskitNoDomParserTransformListSvgReport = canvaskitGlyphOutlineProbe
    .noDomParserTransformListSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNoDomParserTransformListSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNoDomParserTransformListSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects transform-list SvgGlyph without DOMParser=${JSON.stringify(canvaskitNoDomParserTransformListSvgReport)}`,
  );
  const canvaskitGroupTransformSvgReport = canvaskitGlyphOutlineProbe
    .groupTransformSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitGroupTransformSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitGroupTransformSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects group-transform SvgGlyph resource=${JSON.stringify(canvaskitGroupTransformSvgReport)}`,
  );
  const canvaskitNoDomParserGroupTransformSvgReport = canvaskitGlyphOutlineProbe
    .noDomParserGroupTransformSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNoDomParserGroupTransformSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNoDomParserGroupTransformSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects group-transform SvgGlyph without DOMParser=${JSON.stringify(canvaskitNoDomParserGroupTransformSvgReport)}`,
  );
  const canvaskitInheritedPaintSvgReport = canvaskitGlyphOutlineProbe
    .inheritedPaintSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitInheritedPaintSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitInheritedPaintSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects inherited-paint SvgGlyph resource=${JSON.stringify(canvaskitInheritedPaintSvgReport)}`,
  );
  const canvaskitNoDomParserInheritedPaintSvgReport = canvaskitGlyphOutlineProbe
    .noDomParserInheritedPaintSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNoDomParserInheritedPaintSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNoDomParserInheritedPaintSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects inherited-paint SvgGlyph without DOMParser=${JSON.stringify(canvaskitNoDomParserInheritedPaintSvgReport)}`,
  );
  const canvaskitCurrentColorSvgReport = canvaskitGlyphOutlineProbe
    .currentColorSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitCurrentColorSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitCurrentColorSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects currentColor SvgGlyph resource=${JSON.stringify(canvaskitCurrentColorSvgReport)}`,
  );
  const canvaskitNoDomParserCurrentColorSvgReport = canvaskitGlyphOutlineProbe
    .noDomParserCurrentColorSvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNoDomParserCurrentColorSvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNoDomParserCurrentColorSvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects currentColor SvgGlyph without DOMParser=${JSON.stringify(canvaskitNoDomParserCurrentColorSvgReport)}`,
  );
  const canvaskitIdentityOpacitySvgReport = canvaskitGlyphOutlineProbe
    .identityOpacitySvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitIdentityOpacitySvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitIdentityOpacitySvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects identity-opacity SvgGlyph resource=${JSON.stringify(canvaskitIdentityOpacitySvgReport)}`,
  );
  const canvaskitNoDomParserIdentityOpacitySvgReport = canvaskitGlyphOutlineProbe
    .noDomParserIdentityOpacitySvgGlyph
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitNoDomParserIdentityOpacitySvgReport?.selectedVariantId === 'glyphOutline'
      && canvaskitNoDomParserIdentityOpacitySvgReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects identity-opacity SvgGlyph without DOMParser=${JSON.stringify(canvaskitNoDomParserIdentityOpacitySvgReport)}`,
  );
  const canvaskitDuplicateSvgKeyReport = canvaskitGlyphOutlineProbe
    .duplicateSvgGlyphKey
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitDuplicateSvgKeyReport?.selectedVariantId === 'textRun'
      && canvaskitDuplicateSvgKeyReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      ),
    `CanvasKit rejects ambiguous SvgGlyph resource keys=${JSON.stringify(canvaskitDuplicateSvgKeyReport)}`,
  );
  const canvaskitUnsafeSvgResourceReport = canvaskitGlyphOutlineProbe
    .unsafeSvgGlyphResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitUnsupportedSvgTextLayerResourceReport = canvaskitGlyphOutlineProbe
    .unsupportedSvgGlyphTextLayerResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitUnsupportedSvgMalformedPathResourceReport = canvaskitGlyphOutlineProbe
    .unsupportedSvgGlyphMalformedPathResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitUnsupportedSvgOverflowTransformResourceReport = canvaskitGlyphOutlineProbe
    .unsupportedSvgGlyphOverflowTransformResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitUnsupportedSvgStrokeResourceReport = canvaskitGlyphOutlineProbe
    .unsupportedSvgGlyphStrokeResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitUnsupportedSvgOpacityResourceReport = canvaskitGlyphOutlineProbe
    .unsupportedSvgGlyphOpacityResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitUnsupportedSvgGroupOpacityResourceReport = canvaskitGlyphOutlineProbe
    .unsupportedSvgGlyphGroupOpacityResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitUnsupportedSvgFillRuleResourceReport = canvaskitGlyphOutlineProbe
    .unsupportedSvgGlyphFillRuleResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitUnsupportedSvgIndirectPaintResourceReport = canvaskitGlyphOutlineProbe
    .unsupportedSvgGlyphIndirectPaintResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitUnsupportedSvgImageHrefResourceReport = canvaskitGlyphOutlineProbe
    .unsupportedSvgGlyphImageHrefResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitNoDomParserUnsupportedSvgImageHrefResourceReport = canvaskitGlyphOutlineProbe
    .noDomParserUnsupportedSvgImageHrefResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitUnsupportedSvgUseHrefResourceReport = canvaskitGlyphOutlineProbe
    .unsupportedSvgGlyphUseHrefResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitNoDomParserUnsupportedSvgUseHrefResourceReport = canvaskitGlyphOutlineProbe
    .noDomParserUnsupportedSvgUseHrefResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitUnsupportedSvgForeignObjectResourceReport = canvaskitGlyphOutlineProbe
    .unsupportedSvgGlyphForeignObjectResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitNoDomParserUnsupportedSvgForeignObjectResourceReport = canvaskitGlyphOutlineProbe
    .noDomParserUnsupportedSvgForeignObjectResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitUnsupportedSvgFilterResourceReport = canvaskitGlyphOutlineProbe
    .unsupportedSvgGlyphFilterResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitNoDomParserUnsupportedSvgFilterResourceReport = canvaskitGlyphOutlineProbe
    .noDomParserUnsupportedSvgFilterResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitUnsupportedSvgMaskResourceReport = canvaskitGlyphOutlineProbe
    .unsupportedSvgGlyphMaskResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitNoDomParserUnsupportedSvgMaskResourceReport = canvaskitGlyphOutlineProbe
    .noDomParserUnsupportedSvgMaskResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitUnsupportedSvgClipPathResourceReport = canvaskitGlyphOutlineProbe
    .unsupportedSvgGlyphClipPathResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitNoDomParserUnsupportedSvgClipPathResourceReport = canvaskitGlyphOutlineProbe
    .noDomParserUnsupportedSvgClipPathResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitUnsupportedSvgInvalidColorResourceReport = canvaskitGlyphOutlineProbe
    .unsupportedSvgGlyphInvalidColorResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitNoDomParserUnsupportedSvgDoctypeResourceReport = canvaskitGlyphOutlineProbe
    .noDomParserUnsupportedSvgDoctypeResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitNoDomParserUnsupportedSvgClosingTagResourceReport = canvaskitGlyphOutlineProbe
    .noDomParserUnsupportedSvgClosingTagResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitUnsupportedSvgCrossedClosingTagResourceReport = canvaskitGlyphOutlineProbe
    .unsupportedSvgGlyphCrossedClosingTagResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitUnsupportedSvgDanglingShapeClosingTagResourceReport = canvaskitGlyphOutlineProbe
    .unsupportedSvgGlyphDanglingShapeClosingTagResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitNoDomParserUnsupportedSvgDanglingShapeClosingTagResourceReport = canvaskitGlyphOutlineProbe
    .noDomParserUnsupportedSvgDanglingShapeClosingTagResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitUnsupportedSvgMalformedCommentResourceReport = canvaskitGlyphOutlineProbe
    .unsupportedSvgGlyphMalformedCommentResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitNoDomParserUnsupportedSvgMalformedCommentResourceReport = canvaskitGlyphOutlineProbe
    .noDomParserUnsupportedSvgMalformedCommentResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitUnsupportedSvgMalformedStyleCommentResourceReport = canvaskitGlyphOutlineProbe
    .unsupportedSvgGlyphMalformedStyleCommentResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitNoDomParserUnsupportedSvgMalformedStyleCommentResourceReport = canvaskitGlyphOutlineProbe
    .noDomParserUnsupportedSvgMalformedStyleCommentResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitNoDomParserUnsupportedSvgInvalidColorResourceReport = canvaskitGlyphOutlineProbe
    .noDomParserUnsupportedSvgInvalidColorResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitUnsupportedSvgUnknownEntityResourceReport = canvaskitGlyphOutlineProbe
    .unsupportedSvgGlyphUnknownEntityResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitNoDomParserUnsupportedSvgUnknownEntityResourceReport = canvaskitGlyphOutlineProbe
    .noDomParserUnsupportedSvgUnknownEntityResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitUnsupportedSvgDuplicateAttributeResourceReport = canvaskitGlyphOutlineProbe
    .unsupportedSvgGlyphDuplicateAttributeResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitNoDomParserUnsupportedSvgDuplicateAttributeResourceReport = canvaskitGlyphOutlineProbe
    .noDomParserUnsupportedSvgDuplicateAttributeResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitUnsupportedSvgStrayLessThanResourceReport = canvaskitGlyphOutlineProbe
    .unsupportedSvgGlyphStrayLessThanResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitNoDomParserUnsupportedSvgStrayLessThanResourceReport = canvaskitGlyphOutlineProbe
    .noDomParserUnsupportedSvgStrayLessThanResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitUnsupportedSvgCdataEndResourceReport = canvaskitGlyphOutlineProbe
    .unsupportedSvgGlyphCdataEndResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitNoDomParserUnsupportedSvgCdataEndResourceReport = canvaskitGlyphOutlineProbe
    .noDomParserUnsupportedSvgCdataEndResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitUnsupportedSvgTextEntityResourceReport = canvaskitGlyphOutlineProbe
    .unsupportedSvgGlyphTextEntityResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitNoDomParserUnsupportedSvgTextEntityResourceReport = canvaskitGlyphOutlineProbe
    .noDomParserUnsupportedSvgTextEntityResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  const canvaskitNoDomParserUnsupportedSvgGroupOpacityResourceReport = canvaskitGlyphOutlineProbe
    .noDomParserUnsupportedSvgGroupOpacityResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitUnsafeSvgResourceReport?.selectedVariantId === 'textRun'
      && canvaskitUnsafeSvgResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitUnsupportedSvgTextLayerResourceReport?.selectedVariantId === 'textRun'
      && canvaskitUnsupportedSvgTextLayerResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitGlyphOutlineProbe.unsupportedSvgGlyphTextLayerResource.redPixels > 0
      && canvaskitUnsupportedSvgMalformedPathResourceReport?.selectedVariantId === 'textRun'
      && canvaskitUnsupportedSvgMalformedPathResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitGlyphOutlineProbe.unsupportedSvgGlyphMalformedPathResource.redPixels > 0
      && canvaskitUnsupportedSvgOverflowTransformResourceReport?.selectedVariantId === 'textRun'
      && canvaskitUnsupportedSvgOverflowTransformResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitGlyphOutlineProbe.unsupportedSvgGlyphOverflowTransformResource.redPixels > 0
      && canvaskitUnsupportedSvgStrokeResourceReport?.selectedVariantId === 'textRun'
      && canvaskitUnsupportedSvgStrokeResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitUnsupportedSvgOpacityResourceReport?.selectedVariantId === 'textRun'
      && canvaskitUnsupportedSvgOpacityResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitUnsupportedSvgGroupOpacityResourceReport?.selectedVariantId === 'textRun'
      && canvaskitUnsupportedSvgGroupOpacityResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitUnsupportedSvgFillRuleResourceReport?.selectedVariantId === 'textRun'
      && canvaskitUnsupportedSvgFillRuleResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitUnsupportedSvgIndirectPaintResourceReport?.selectedVariantId === 'textRun'
      && canvaskitUnsupportedSvgIndirectPaintResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitUnsupportedSvgImageHrefResourceReport?.selectedVariantId === 'textRun'
      && canvaskitUnsupportedSvgImageHrefResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitNoDomParserUnsupportedSvgImageHrefResourceReport?.selectedVariantId === 'textRun'
      && canvaskitNoDomParserUnsupportedSvgImageHrefResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitUnsupportedSvgUseHrefResourceReport?.selectedVariantId === 'textRun'
      && canvaskitUnsupportedSvgUseHrefResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitNoDomParserUnsupportedSvgUseHrefResourceReport?.selectedVariantId === 'textRun'
      && canvaskitNoDomParserUnsupportedSvgUseHrefResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitUnsupportedSvgForeignObjectResourceReport?.selectedVariantId === 'textRun'
      && canvaskitUnsupportedSvgForeignObjectResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitNoDomParserUnsupportedSvgForeignObjectResourceReport?.selectedVariantId === 'textRun'
      && canvaskitNoDomParserUnsupportedSvgForeignObjectResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitUnsupportedSvgFilterResourceReport?.selectedVariantId === 'textRun'
      && canvaskitUnsupportedSvgFilterResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitNoDomParserUnsupportedSvgFilterResourceReport?.selectedVariantId === 'textRun'
      && canvaskitNoDomParserUnsupportedSvgFilterResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitUnsupportedSvgMaskResourceReport?.selectedVariantId === 'textRun'
      && canvaskitUnsupportedSvgMaskResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitNoDomParserUnsupportedSvgMaskResourceReport?.selectedVariantId === 'textRun'
      && canvaskitNoDomParserUnsupportedSvgMaskResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitUnsupportedSvgClipPathResourceReport?.selectedVariantId === 'textRun'
      && canvaskitUnsupportedSvgClipPathResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitNoDomParserUnsupportedSvgClipPathResourceReport?.selectedVariantId === 'textRun'
      && canvaskitNoDomParserUnsupportedSvgClipPathResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitUnsupportedSvgInvalidColorResourceReport?.selectedVariantId === 'textRun'
      && canvaskitUnsupportedSvgInvalidColorResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitNoDomParserUnsupportedSvgDoctypeResourceReport?.selectedVariantId === 'textRun'
      && canvaskitNoDomParserUnsupportedSvgDoctypeResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitNoDomParserUnsupportedSvgClosingTagResourceReport?.selectedVariantId === 'textRun'
      && canvaskitNoDomParserUnsupportedSvgClosingTagResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitUnsupportedSvgCrossedClosingTagResourceReport?.selectedVariantId === 'textRun'
      && canvaskitUnsupportedSvgCrossedClosingTagResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitUnsupportedSvgDanglingShapeClosingTagResourceReport?.selectedVariantId === 'textRun'
      && canvaskitUnsupportedSvgDanglingShapeClosingTagResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitNoDomParserUnsupportedSvgDanglingShapeClosingTagResourceReport?.selectedVariantId === 'textRun'
      && canvaskitNoDomParserUnsupportedSvgDanglingShapeClosingTagResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitUnsupportedSvgMalformedCommentResourceReport?.selectedVariantId === 'textRun'
      && canvaskitUnsupportedSvgMalformedCommentResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitNoDomParserUnsupportedSvgMalformedCommentResourceReport?.selectedVariantId === 'textRun'
      && canvaskitNoDomParserUnsupportedSvgMalformedCommentResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitUnsupportedSvgMalformedStyleCommentResourceReport?.selectedVariantId === 'textRun'
      && canvaskitUnsupportedSvgMalformedStyleCommentResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitNoDomParserUnsupportedSvgMalformedStyleCommentResourceReport?.selectedVariantId === 'textRun'
      && canvaskitNoDomParserUnsupportedSvgMalformedStyleCommentResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitNoDomParserUnsupportedSvgInvalidColorResourceReport?.selectedVariantId === 'textRun'
      && canvaskitNoDomParserUnsupportedSvgInvalidColorResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitUnsupportedSvgUnknownEntityResourceReport?.selectedVariantId === 'textRun'
      && canvaskitUnsupportedSvgUnknownEntityResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitNoDomParserUnsupportedSvgUnknownEntityResourceReport?.selectedVariantId === 'textRun'
      && canvaskitNoDomParserUnsupportedSvgUnknownEntityResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitUnsupportedSvgDuplicateAttributeResourceReport?.selectedVariantId === 'textRun'
      && canvaskitUnsupportedSvgDuplicateAttributeResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitNoDomParserUnsupportedSvgDuplicateAttributeResourceReport?.selectedVariantId === 'textRun'
      && canvaskitNoDomParserUnsupportedSvgDuplicateAttributeResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitUnsupportedSvgStrayLessThanResourceReport?.selectedVariantId === 'textRun'
      && canvaskitUnsupportedSvgStrayLessThanResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitNoDomParserUnsupportedSvgStrayLessThanResourceReport?.selectedVariantId === 'textRun'
      && canvaskitNoDomParserUnsupportedSvgStrayLessThanResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitUnsupportedSvgCdataEndResourceReport?.selectedVariantId === 'textRun'
      && canvaskitUnsupportedSvgCdataEndResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitNoDomParserUnsupportedSvgCdataEndResourceReport?.selectedVariantId === 'textRun'
      && canvaskitNoDomParserUnsupportedSvgCdataEndResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitUnsupportedSvgTextEntityResourceReport?.selectedVariantId === 'textRun'
      && canvaskitUnsupportedSvgTextEntityResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitNoDomParserUnsupportedSvgTextEntityResourceReport?.selectedVariantId === 'textRun'
      && canvaskitNoDomParserUnsupportedSvgTextEntityResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitNoDomParserUnsupportedSvgGroupOpacityResourceReport?.selectedVariantId === 'textRun'
      && canvaskitNoDomParserUnsupportedSvgGroupOpacityResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      ),
    `CanvasKit rejects non-path-only SvgGlyph resources=${JSON.stringify({
      unsafe: canvaskitUnsafeSvgResourceReport,
      unsupportedStroke: canvaskitUnsupportedSvgStrokeResourceReport,
      unsupportedOpacity: canvaskitUnsupportedSvgOpacityResourceReport,
      unsupportedGroupOpacity: canvaskitUnsupportedSvgGroupOpacityResourceReport,
      unsupportedFillRule: canvaskitUnsupportedSvgFillRuleResourceReport,
      unsupportedIndirectPaint: canvaskitUnsupportedSvgIndirectPaintResourceReport,
      unsupportedImageHref: canvaskitUnsupportedSvgImageHrefResourceReport,
      noDomParserUnsupportedImageHref: canvaskitNoDomParserUnsupportedSvgImageHrefResourceReport,
      unsupportedUseHref: canvaskitUnsupportedSvgUseHrefResourceReport,
      noDomParserUnsupportedUseHref: canvaskitNoDomParserUnsupportedSvgUseHrefResourceReport,
      unsupportedForeignObject: canvaskitUnsupportedSvgForeignObjectResourceReport,
      noDomParserUnsupportedForeignObject: canvaskitNoDomParserUnsupportedSvgForeignObjectResourceReport,
      unsupportedFilter: canvaskitUnsupportedSvgFilterResourceReport,
      noDomParserUnsupportedFilter: canvaskitNoDomParserUnsupportedSvgFilterResourceReport,
      unsupportedMask: canvaskitUnsupportedSvgMaskResourceReport,
      noDomParserUnsupportedMask: canvaskitNoDomParserUnsupportedSvgMaskResourceReport,
      unsupportedClipPath: canvaskitUnsupportedSvgClipPathResourceReport,
      noDomParserUnsupportedClipPath: canvaskitNoDomParserUnsupportedSvgClipPathResourceReport,
      unsupportedInvalidColor: canvaskitUnsupportedSvgInvalidColorResourceReport,
      noDomParserUnsupportedDoctype: canvaskitNoDomParserUnsupportedSvgDoctypeResourceReport,
      noDomParserUnsupportedClosingTag: canvaskitNoDomParserUnsupportedSvgClosingTagResourceReport,
      unsupportedDanglingShapeClosingTag: canvaskitUnsupportedSvgDanglingShapeClosingTagResourceReport,
      noDomParserUnsupportedDanglingShapeClosingTag:
        canvaskitNoDomParserUnsupportedSvgDanglingShapeClosingTagResourceReport,
      unsupportedMalformedComment: canvaskitUnsupportedSvgMalformedCommentResourceReport,
      noDomParserUnsupportedMalformedComment: canvaskitNoDomParserUnsupportedSvgMalformedCommentResourceReport,
      unsupportedMalformedStyleComment: canvaskitUnsupportedSvgMalformedStyleCommentResourceReport,
      noDomParserUnsupportedMalformedStyleComment:
        canvaskitNoDomParserUnsupportedSvgMalformedStyleCommentResourceReport,
      noDomParserUnsupportedInvalidColor: canvaskitNoDomParserUnsupportedSvgInvalidColorResourceReport,
      unsupportedUnknownEntity: canvaskitUnsupportedSvgUnknownEntityResourceReport,
      noDomParserUnsupportedUnknownEntity: canvaskitNoDomParserUnsupportedSvgUnknownEntityResourceReport,
      unsupportedDuplicateAttribute: canvaskitUnsupportedSvgDuplicateAttributeResourceReport,
      noDomParserUnsupportedDuplicateAttribute: canvaskitNoDomParserUnsupportedSvgDuplicateAttributeResourceReport,
      unsupportedStrayLessThan: canvaskitUnsupportedSvgStrayLessThanResourceReport,
      noDomParserUnsupportedStrayLessThan: canvaskitNoDomParserUnsupportedSvgStrayLessThanResourceReport,
      unsupportedCdataEnd: canvaskitUnsupportedSvgCdataEndResourceReport,
      noDomParserUnsupportedCdataEnd: canvaskitNoDomParserUnsupportedSvgCdataEndResourceReport,
      unsupportedTextEntity: canvaskitUnsupportedSvgTextEntityResourceReport,
      noDomParserUnsupportedTextEntity: canvaskitNoDomParserUnsupportedSvgTextEntityResourceReport,
      noDomParserUnsupportedGroupOpacity: canvaskitNoDomParserUnsupportedSvgGroupOpacityResourceReport,
    })}`,
  );
  const canvaskitMonochromeBlackPixels = countPixels(
    canvaskitGlyphOutlineProbe.monochrome.png,
    (pixel) => pixel.alpha > 32 && pixel.red < 80 && pixel.green < 80 && pixel.blue < 80,
  );
  const canvaskitMonochromeRedPixels = countPixels(
    canvaskitGlyphOutlineProbe.monochrome.png,
    (pixel) => pixel.alpha > 32 && pixel.red > 160 && pixel.green < 120 && pixel.blue < 120,
  );
  const canvaskitStrokeBluePixels = countPixels(
    canvaskitGlyphOutlineProbe.stroke.png,
    (pixel) => pixel.alpha > 32 && pixel.blue > 150 && pixel.red < 100 && pixel.green < 120,
  );
  const canvaskitUnsupportedStrokeJoinCapBlackPixels = canvaskitGlyphOutlineProbe
    .unsupportedStrokeJoinCap
    .blackPixels;
  const canvaskitMissingStrokeBlackPixels = canvaskitGlyphOutlineProbe.missingStroke.blackPixels;
  const canvaskitColorBluePixels = countPixels(
    canvaskitGlyphOutlineProbe.colorLayers.png,
    (pixel) => pixel.alpha > 32 && pixel.blue > 150 && pixel.red < 100 && pixel.green < 120,
  );
  const canvaskitColorV1GreenPixels = countPixels(
    canvaskitGlyphOutlineProbe.colorLayersColrV1.png,
    (pixel) => pixel.alpha > 32 && pixel.green > 120 && pixel.red < 100 && pixel.blue < 100,
  );
  const canvaskitColorV1GradientRedPixels = countPixels(
    canvaskitGlyphOutlineProbe.colorLayersColrV1Gradient.png,
    (pixel) => pixel.alpha > 32 && pixel.red > 150 && pixel.green < 100 && pixel.blue < 120,
  );
  const canvaskitColorV1GradientBluePixels = countPixels(
    canvaskitGlyphOutlineProbe.colorLayersColrV1Gradient.png,
    (pixel) => pixel.alpha > 32 && pixel.blue > 150 && pixel.green < 100 && pixel.red < 120,
  );
  const canvaskitBitmapBlackPixels = canvaskitGlyphOutlineProbe.bitmapGlyph.blackPixels;
  const canvaskitSvgMagentaPixels = canvaskitGlyphOutlineProbe.svgGlyph.magentaPixels;
  const canvaskitNoDomParserSvgMagentaPixels = canvaskitGlyphOutlineProbe.noDomParserSvgGlyph.magentaPixels;
  const canvaskitWrappedSvgMagentaPixels = canvaskitGlyphOutlineProbe.wrappedSvgGlyph.magentaPixels;
  const canvaskitNoDomParserWrappedSvgMagentaPixels = canvaskitGlyphOutlineProbe.noDomParserWrappedSvgGlyph.magentaPixels;
  const canvaskitNonVisualAttributesSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .nonVisualAttributesSvgGlyph
    .magentaPixels;
  const canvaskitNoDomParserNonVisualAttributesSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .noDomParserNonVisualAttributesSvgGlyph
    .magentaPixels;
  const canvaskitBalancedShapeSvgMagentaPixels = canvaskitGlyphOutlineProbe.balancedShapeSvgGlyph.magentaPixels;
  const canvaskitNoDomParserBalancedShapeSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .noDomParserBalancedShapeSvgGlyph
    .magentaPixels;
  const canvaskitDefsSvgMagentaPixels = canvaskitGlyphOutlineProbe.defsSvgGlyph.magentaPixels;
  const canvaskitDefsSvgBluePixels = canvaskitGlyphOutlineProbe.defsSvgGlyph.bluePixels;
  const canvaskitNoDomParserDefsSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .noDomParserDefsSvgGlyph
    .magentaPixels;
  const canvaskitNoDomParserDefsSvgBluePixels = canvaskitGlyphOutlineProbe
    .noDomParserDefsSvgGlyph
    .bluePixels;
  const canvaskitNonRenderingMetadataSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .nonRenderingMetadataSvgGlyph
    .magentaPixels;
  const canvaskitNonRenderingMetadataSvgBluePixels = canvaskitGlyphOutlineProbe
    .nonRenderingMetadataSvgGlyph
    .bluePixels;
  const canvaskitNoDomParserNonRenderingMetadataSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .noDomParserNonRenderingMetadataSvgGlyph
    .magentaPixels;
  const canvaskitNoDomParserNonRenderingMetadataSvgBluePixels = canvaskitGlyphOutlineProbe
    .noDomParserNonRenderingMetadataSvgGlyph
    .bluePixels;
  const canvaskitCommentSvgMagentaPixels = canvaskitGlyphOutlineProbe.commentSvgGlyph.magentaPixels;
  const canvaskitCommentSvgBluePixels = canvaskitGlyphOutlineProbe.commentSvgGlyph.bluePixels;
  const canvaskitNoDomParserCommentSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .noDomParserCommentSvgGlyph
    .magentaPixels;
  const canvaskitNoDomParserCommentSvgBluePixels = canvaskitGlyphOutlineProbe
    .noDomParserCommentSvgGlyph
    .bluePixels;
  const canvaskitStrokedSvgBluePixels = canvaskitGlyphOutlineProbe.strokedSvgGlyph.bluePixels;
  const canvaskitStrokedSvgMagentaPixels = canvaskitGlyphOutlineProbe.strokedSvgGlyph.magentaPixels;
  const canvaskitNoDomParserStrokedSvgBluePixels = canvaskitGlyphOutlineProbe
    .noDomParserStrokedSvgGlyph
    .bluePixels;
  const canvaskitNoDomParserStrokedSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .noDomParserStrokedSvgGlyph
    .magentaPixels;
  const canvaskitLineSvgBluePixels = canvaskitGlyphOutlineProbe.lineSvgGlyph.bluePixels;
  const canvaskitLineSvgMagentaPixels = canvaskitGlyphOutlineProbe.lineSvgGlyph.magentaPixels;
  const canvaskitNoDomParserLineSvgBluePixels = canvaskitGlyphOutlineProbe
    .noDomParserLineSvgGlyph
    .bluePixels;
  const canvaskitNoDomParserLineSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .noDomParserLineSvgGlyph
    .magentaPixels;
  const canvaskitShapeStrokeSvgBluePixels = canvaskitGlyphOutlineProbe.shapeStrokeSvgGlyph.bluePixels;
  const canvaskitShapeStrokeSvgMagentaPixels = canvaskitGlyphOutlineProbe.shapeStrokeSvgGlyph.magentaPixels;
  const canvaskitNoDomParserShapeStrokeSvgBluePixels = canvaskitGlyphOutlineProbe
    .noDomParserShapeStrokeSvgGlyph
    .bluePixels;
  const canvaskitNoDomParserShapeStrokeSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .noDomParserShapeStrokeSvgGlyph
    .magentaPixels;
  const canvaskitDashedSvgBluePixels = canvaskitGlyphOutlineProbe.dashedSvgGlyph.bluePixels;
  const canvaskitDashedSvgMagentaPixels = canvaskitGlyphOutlineProbe.dashedSvgGlyph.magentaPixels;
  const canvaskitNoDomParserDashedSvgBluePixels = canvaskitGlyphOutlineProbe
    .noDomParserDashedSvgGlyph
    .bluePixels;
  const canvaskitNoDomParserDashedSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .noDomParserDashedSvgGlyph
    .magentaPixels;
  const canvaskitStyledDashSvgBluePixels = canvaskitGlyphOutlineProbe.styledDashSvgGlyph.bluePixels;
  const canvaskitStyledDashSvgMagentaPixels = canvaskitGlyphOutlineProbe.styledDashSvgGlyph.magentaPixels;
  const canvaskitNoDomParserStyledDashSvgBluePixels = canvaskitGlyphOutlineProbe
    .noDomParserStyledDashSvgGlyph
    .bluePixels;
  const canvaskitNoDomParserStyledDashSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .noDomParserStyledDashSvgGlyph
    .magentaPixels;
  const canvaskitPxLengthSvgBluePixels = canvaskitGlyphOutlineProbe.pxLengthSvgGlyph.bluePixels;
  const canvaskitPxLengthSvgMagentaPixels = canvaskitGlyphOutlineProbe.pxLengthSvgGlyph.magentaPixels;
  const canvaskitNoDomParserPxLengthSvgBluePixels = canvaskitGlyphOutlineProbe
    .noDomParserPxLengthSvgGlyph
    .bluePixels;
  const canvaskitNoDomParserPxLengthSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .noDomParserPxLengthSvgGlyph
    .magentaPixels;
  const canvaskitZeroWidthStrokeSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .zeroWidthStrokeSvgGlyph
    .magentaPixels;
  const canvaskitZeroWidthStrokeSvgBluePixels = canvaskitGlyphOutlineProbe
    .zeroWidthStrokeSvgGlyph
    .bluePixels;
  const canvaskitNoDomParserZeroWidthStrokeSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .noDomParserZeroWidthStrokeSvgGlyph
    .magentaPixels;
  const canvaskitNoDomParserZeroWidthStrokeSvgBluePixels = canvaskitGlyphOutlineProbe
    .noDomParserZeroWidthStrokeSvgGlyph
    .bluePixels;
  const canvaskitStyledZeroWidthStrokeSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .styledZeroWidthStrokeSvgGlyph
    .magentaPixels;
  const canvaskitStyledZeroWidthStrokeSvgBluePixels = canvaskitGlyphOutlineProbe
    .styledZeroWidthStrokeSvgGlyph
    .bluePixels;
  const canvaskitNoDomParserStyledZeroWidthStrokeSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .noDomParserStyledZeroWidthStrokeSvgGlyph
    .magentaPixels;
  const canvaskitNoDomParserStyledZeroWidthStrokeSvgBluePixels = canvaskitGlyphOutlineProbe
    .noDomParserStyledZeroWidthStrokeSvgGlyph
    .bluePixels;
  const canvaskitTransparentStrokeSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .transparentStrokeSvgGlyph
    .magentaPixels;
  const canvaskitTransparentStrokeSvgBluePixels = canvaskitGlyphOutlineProbe
    .transparentStrokeSvgGlyph
    .bluePixels;
  const canvaskitNoDomParserTransparentStrokeSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .noDomParserTransparentStrokeSvgGlyph
    .magentaPixels;
  const canvaskitNoDomParserTransparentStrokeSvgBluePixels = canvaskitGlyphOutlineProbe
    .noDomParserTransparentStrokeSvgGlyph
    .bluePixels;
  const canvaskitStyledTransparentStrokeSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .styledTransparentStrokeSvgGlyph
    .magentaPixels;
  const canvaskitStyledTransparentStrokeSvgBluePixels = canvaskitGlyphOutlineProbe
    .styledTransparentStrokeSvgGlyph
    .bluePixels;
  const canvaskitNoDomParserStyledTransparentStrokeSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .noDomParserStyledTransparentStrokeSvgGlyph
    .magentaPixels;
  const canvaskitNoDomParserStyledTransparentStrokeSvgBluePixels = canvaskitGlyphOutlineProbe
    .noDomParserStyledTransparentStrokeSvgGlyph
    .bluePixels;
  const canvaskitInvisibleStrokeOnlySvgBluePixels = canvaskitGlyphOutlineProbe
    .invisibleStrokeOnlySvgGlyph
    .bluePixels;
  const canvaskitInvisibleStrokeOnlySvgRedPixels = canvaskitGlyphOutlineProbe
    .invisibleStrokeOnlySvgGlyph
    .redPixels;
  const canvaskitInvisibleStrokeOnlySvgMagentaPixels = canvaskitGlyphOutlineProbe
    .invisibleStrokeOnlySvgGlyph
    .magentaPixels;
  const canvaskitNoDomParserInvisibleStrokeOnlySvgBluePixels = canvaskitGlyphOutlineProbe
    .noDomParserInvisibleStrokeOnlySvgGlyph
    .bluePixels;
  const canvaskitNoDomParserInvisibleStrokeOnlySvgRedPixels = canvaskitGlyphOutlineProbe
    .noDomParserInvisibleStrokeOnlySvgGlyph
    .redPixels;
  const canvaskitNoDomParserInvisibleStrokeOnlySvgMagentaPixels = canvaskitGlyphOutlineProbe
    .noDomParserInvisibleStrokeOnlySvgGlyph
    .magentaPixels;
  const canvaskitNamedCssColorSvgMagentaPixels = canvaskitGlyphOutlineProbe.namedCssColorSvgGlyph.magentaPixels;
  const canvaskitNoDomParserNamedCssColorSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .noDomParserNamedCssColorSvgGlyph
    .magentaPixels;
  const canvaskitNoCssNamedCssColorSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .noCssNamedCssColorSvgGlyph
    .magentaPixels;
  const canvaskitFunctionalCssColorSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .functionalCssColorSvgGlyph
    .magentaPixels;
  const canvaskitNoDomParserFunctionalCssColorSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .noDomParserFunctionalCssColorSvgGlyph
    .magentaPixels;
  const canvaskitNoCssFunctionalCssColorSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .noCssFunctionalCssColorSvgGlyph
    .magentaPixels;
  const canvaskitWideGamutCssColorSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .wideGamutCssColorSvgGlyph
    .magentaPixels;
  const canvaskitNoDomParserWideGamutCssColorSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .noDomParserWideGamutCssColorSvgGlyph
    .magentaPixels;
  const canvaskitNoCssWideGamutCssColorSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .noCssWideGamutCssColorSvgGlyph
    .magentaPixels;
  const canvaskitStylePrecedenceSvgMagentaPixels = canvaskitGlyphOutlineProbe.stylePrecedenceSvgGlyph.magentaPixels;
  const canvaskitStylePrecedenceSvgRedPixels = canvaskitGlyphOutlineProbe.stylePrecedenceSvgGlyph.redPixels;
  const canvaskitNoDomParserStylePrecedenceSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .noDomParserStylePrecedenceSvgGlyph
    .magentaPixels;
  const canvaskitNoDomParserStylePrecedenceSvgRedPixels = canvaskitGlyphOutlineProbe
    .noDomParserStylePrecedenceSvgGlyph
    .redPixels;
  const canvaskitStyleCascadeSvgMagentaPixels = canvaskitGlyphOutlineProbe.styleCascadeSvgGlyph.magentaPixels;
  const canvaskitStyleCascadeSvgRedPixels = canvaskitGlyphOutlineProbe.styleCascadeSvgGlyph.redPixels;
  const canvaskitNoDomParserStyleCascadeSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .noDomParserStyleCascadeSvgGlyph
    .magentaPixels;
  const canvaskitNoDomParserStyleCascadeSvgRedPixels = canvaskitGlyphOutlineProbe
    .noDomParserStyleCascadeSvgGlyph
    .redPixels;
  const canvaskitStyleCommentSvgMagentaPixels = canvaskitGlyphOutlineProbe.styleCommentSvgGlyph.magentaPixels;
  const canvaskitStyleCommentSvgBluePixels = canvaskitGlyphOutlineProbe.styleCommentSvgGlyph.bluePixels;
  const canvaskitStyleCommentSvgRedPixels = canvaskitGlyphOutlineProbe.styleCommentSvgGlyph.redPixels;
  const canvaskitNoDomParserStyleCommentSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .noDomParserStyleCommentSvgGlyph
    .magentaPixels;
  const canvaskitNoDomParserStyleCommentSvgBluePixels = canvaskitGlyphOutlineProbe
    .noDomParserStyleCommentSvgGlyph
    .bluePixels;
  const canvaskitNoDomParserStyleCommentSvgRedPixels = canvaskitGlyphOutlineProbe
    .noDomParserStyleCommentSvgGlyph
    .redPixels;
  const canvaskitAttributeEntitySvgMagentaPixels = canvaskitGlyphOutlineProbe
    .attributeEntitySvgGlyph
    .magentaPixels;
  const canvaskitNoDomParserAttributeEntitySvgMagentaPixels = canvaskitGlyphOutlineProbe
    .noDomParserAttributeEntitySvgGlyph
    .magentaPixels;
  const canvaskitStyleEntitySvgMagentaPixels = canvaskitGlyphOutlineProbe.styleEntitySvgGlyph.magentaPixels;
  const canvaskitStyleEntitySvgRedPixels = canvaskitGlyphOutlineProbe.styleEntitySvgGlyph.redPixels;
  const canvaskitNoDomParserStyleEntitySvgMagentaPixels = canvaskitGlyphOutlineProbe
    .noDomParserStyleEntitySvgGlyph
    .magentaPixels;
  const canvaskitNoDomParserStyleEntitySvgRedPixels = canvaskitGlyphOutlineProbe
    .noDomParserStyleEntitySvgGlyph
    .redPixels;
  const canvaskitPolylineSvgMagentaPixels = canvaskitGlyphOutlineProbe.polylineSvgGlyph.magentaPixels;
  const canvaskitNoDomParserPolylineSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .noDomParserPolylineSvgGlyph
    .magentaPixels;
  const canvaskitRoundedRectSvgMagentaPixels = canvaskitGlyphOutlineProbe.roundedRectSvgGlyph.magentaPixels;
  const canvaskitNoDomParserRoundedRectSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .noDomParserRoundedRectSvgGlyph
    .magentaPixels;
  const canvaskitTransformedSvgMagentaPixels = canvaskitGlyphOutlineProbe.transformedSvgGlyph.magentaPixels;
  const canvaskitNoDomParserTransformedSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .noDomParserTransformedSvgGlyph
    .magentaPixels;
  const canvaskitMatrixTransformSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .matrixTransformSvgGlyph
    .magentaPixels;
  const canvaskitNoDomParserMatrixTransformSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .noDomParserMatrixTransformSvgGlyph
    .magentaPixels;
  const canvaskitRootTransformSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .rootTransformSvgGlyph
    .magentaPixels;
  const canvaskitNoDomParserRootTransformSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .noDomParserRootTransformSvgGlyph
    .magentaPixels;
  const canvaskitTransformListSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .transformListSvgGlyph
    .magentaPixels;
  const canvaskitNoDomParserTransformListSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .noDomParserTransformListSvgGlyph
    .magentaPixels;
  const canvaskitGroupTransformSvgMagentaPixels = canvaskitGlyphOutlineProbe.groupTransformSvgGlyph.magentaPixels;
  const canvaskitNoDomParserGroupTransformSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .noDomParserGroupTransformSvgGlyph
    .magentaPixels;
  const canvaskitInheritedPaintSvgMagentaPixels = canvaskitGlyphOutlineProbe.inheritedPaintSvgGlyph.magentaPixels;
  const canvaskitNoDomParserInheritedPaintSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .noDomParserInheritedPaintSvgGlyph
    .magentaPixels;
  const canvaskitCurrentColorSvgMagentaPixels = canvaskitGlyphOutlineProbe.currentColorSvgGlyph.magentaPixels;
  const canvaskitCurrentColorSvgBluePixels = canvaskitGlyphOutlineProbe.currentColorSvgGlyph.bluePixels;
  const canvaskitNoDomParserCurrentColorSvgMagentaPixels = canvaskitGlyphOutlineProbe
    .noDomParserCurrentColorSvgGlyph
    .magentaPixels;
  const canvaskitNoDomParserCurrentColorSvgBluePixels = canvaskitGlyphOutlineProbe
    .noDomParserCurrentColorSvgGlyph
    .bluePixels;
  const canvaskitIdentityOpacitySvgMagentaPixels = canvaskitGlyphOutlineProbe
    .identityOpacitySvgGlyph
    .magentaPixels;
  const canvaskitNoDomParserIdentityOpacitySvgMagentaPixels = canvaskitGlyphOutlineProbe
    .noDomParserIdentityOpacitySvgGlyph
    .magentaPixels;
  assert(
    canvaskitMonochromeBlackPixels > 100 && canvaskitMonochromeRedPixels < 5,
    `CanvasKit strict outline paints monochrome path and suppresses fallback black=${canvaskitMonochromeBlackPixels}, red=${canvaskitMonochromeRedPixels}`,
  );
  assert(
    canvaskitStrokeBluePixels > 20,
    `CanvasKit strict outline paints stroke path blue=${canvaskitStrokeBluePixels}`,
  );
  assert(
    canvaskitUnsupportedStrokeJoinCapBlackPixels < 20,
    `CanvasKit strict outline does not replay unsupported stroke join/cap payload black=${canvaskitUnsupportedStrokeJoinCapBlackPixels}`,
  );
  assert(
    canvaskitMissingStrokeBlackPixels < 20,
    `CanvasKit strict outline does not replay missing stroke payload black=${canvaskitMissingStrokeBlackPixels}`,
  );
  assert(
    canvaskitColorBluePixels > 100,
    `CanvasKit strict outline paints COLRv0 color layer blue=${canvaskitColorBluePixels}`,
  );
  assert(
    canvaskitColorV1GreenPixels > 100,
    `CanvasKit strict outline paints COLRv1 stage-1 color graph green=${canvaskitColorV1GreenPixels}`,
  );
  assert(
    canvaskitColorV1GradientRedPixels > 20 && canvaskitColorV1GradientBluePixels > 20,
    `CanvasKit strict outline paints COLRv1 gradient graph red=${canvaskitColorV1GradientRedPixels}, blue=${canvaskitColorV1GradientBluePixels}`,
  );
  assert(
    canvaskitBitmapBlackPixels > 100,
    `CanvasKit strict outline paints BitmapGlyph image black=${canvaskitBitmapBlackPixels}`,
  );
  assert(
    canvaskitSvgMagentaPixels > 100,
    `CanvasKit strict outline paints SvgGlyph vector resource magenta=${canvaskitSvgMagentaPixels}`,
  );
  assert(
    canvaskitNoDomParserSvgMagentaPixels > 100,
    `CanvasKit strict outline paints SvgGlyph without DOMParser magenta=${canvaskitNoDomParserSvgMagentaPixels}`,
  );
  assert(
    canvaskitWrappedSvgMagentaPixels > 100,
    `CanvasKit strict outline paints wrapped SvgGlyph resource magenta=${canvaskitWrappedSvgMagentaPixels}`,
  );
  assert(
    canvaskitNoDomParserWrappedSvgMagentaPixels > 100,
    `CanvasKit strict outline paints wrapped SvgGlyph without DOMParser magenta=${canvaskitNoDomParserWrappedSvgMagentaPixels}`,
  );
  assert(
    canvaskitNonVisualAttributesSvgMagentaPixels > 100,
    `CanvasKit strict outline paints nonvisual-attribute SvgGlyph resource magenta=${canvaskitNonVisualAttributesSvgMagentaPixels}`,
  );
  assert(
    canvaskitNoDomParserNonVisualAttributesSvgMagentaPixels > 100,
    `CanvasKit strict outline paints nonvisual-attribute SvgGlyph without DOMParser magenta=${canvaskitNoDomParserNonVisualAttributesSvgMagentaPixels}`,
  );
  assert(
    canvaskitBalancedShapeSvgMagentaPixels > 100,
    `CanvasKit strict outline paints balanced shape SvgGlyph resource magenta=${canvaskitBalancedShapeSvgMagentaPixels}`,
  );
  assert(
    canvaskitNoDomParserBalancedShapeSvgMagentaPixels > 100,
    `CanvasKit strict outline paints balanced shape SvgGlyph without DOMParser magenta=${canvaskitNoDomParserBalancedShapeSvgMagentaPixels}`,
  );
  assert(
    canvaskitDefsSvgMagentaPixels > 50 && canvaskitDefsSvgBluePixels < 5,
    `CanvasKit strict outline skips non-rendering defs content magenta=${canvaskitDefsSvgMagentaPixels}, blue=${canvaskitDefsSvgBluePixels}`,
  );
  assert(
    canvaskitNoDomParserDefsSvgMagentaPixels > 50 && canvaskitNoDomParserDefsSvgBluePixels < 5,
    `CanvasKit strict outline skips non-rendering defs content without DOMParser magenta=${canvaskitNoDomParserDefsSvgMagentaPixels}, blue=${canvaskitNoDomParserDefsSvgBluePixels}`,
  );
  assert(
    canvaskitNonRenderingMetadataSvgMagentaPixels > 50 && canvaskitNonRenderingMetadataSvgBluePixels < 5,
    `CanvasKit strict outline skips non-rendering metadata/title/desc content magenta=${canvaskitNonRenderingMetadataSvgMagentaPixels}, blue=${canvaskitNonRenderingMetadataSvgBluePixels}`,
  );
  assert(
    canvaskitNoDomParserNonRenderingMetadataSvgMagentaPixels > 50
      && canvaskitNoDomParserNonRenderingMetadataSvgBluePixels < 5,
    `CanvasKit strict outline skips non-rendering metadata/title/desc content without DOMParser magenta=${canvaskitNoDomParserNonRenderingMetadataSvgMagentaPixels}, blue=${canvaskitNoDomParserNonRenderingMetadataSvgBluePixels}`,
  );
  assert(
    canvaskitCommentSvgMagentaPixels > 50 && canvaskitCommentSvgBluePixels < 5,
    `CanvasKit strict outline skips SVG comments magenta=${canvaskitCommentSvgMagentaPixels}, blue=${canvaskitCommentSvgBluePixels}`,
  );
  assert(
    canvaskitNoDomParserCommentSvgMagentaPixels > 50 && canvaskitNoDomParserCommentSvgBluePixels < 5,
    `CanvasKit strict outline skips SVG comments without DOMParser magenta=${canvaskitNoDomParserCommentSvgMagentaPixels}, blue=${canvaskitNoDomParserCommentSvgBluePixels}`,
  );
  assert(
    canvaskitStrokedSvgBluePixels > 80 && canvaskitStrokedSvgMagentaPixels < 5,
    `CanvasKit strict outline paints static SvgGlyph solid stroke blue=${canvaskitStrokedSvgBluePixels}, magenta=${canvaskitStrokedSvgMagentaPixels}`,
  );
  assert(
    canvaskitNoDomParserStrokedSvgBluePixels > 80 && canvaskitNoDomParserStrokedSvgMagentaPixels < 5,
    `CanvasKit strict outline paints static SvgGlyph solid stroke without DOMParser blue=${canvaskitNoDomParserStrokedSvgBluePixels}, magenta=${canvaskitNoDomParserStrokedSvgMagentaPixels}`,
  );
  assert(
    canvaskitLineSvgBluePixels > 40 && canvaskitLineSvgMagentaPixels < 5,
    `CanvasKit strict outline paints line SvgGlyph stroke blue=${canvaskitLineSvgBluePixels}, magenta=${canvaskitLineSvgMagentaPixels}`,
  );
  assert(
    canvaskitNoDomParserLineSvgBluePixels > 40 && canvaskitNoDomParserLineSvgMagentaPixels < 5,
    `CanvasKit strict outline paints line SvgGlyph stroke without DOMParser blue=${canvaskitNoDomParserLineSvgBluePixels}, magenta=${canvaskitNoDomParserLineSvgMagentaPixels}`,
  );
  assert(
    canvaskitShapeStrokeSvgBluePixels > 80 && canvaskitShapeStrokeSvgMagentaPixels < 5,
    `CanvasKit strict outline paints stroked shape SvgGlyph resource blue=${canvaskitShapeStrokeSvgBluePixels}, magenta=${canvaskitShapeStrokeSvgMagentaPixels}`,
  );
  assert(
    canvaskitNoDomParserShapeStrokeSvgBluePixels > 80 && canvaskitNoDomParserShapeStrokeSvgMagentaPixels < 5,
    `CanvasKit strict outline paints stroked shape SvgGlyph without DOMParser blue=${canvaskitNoDomParserShapeStrokeSvgBluePixels}, magenta=${canvaskitNoDomParserShapeStrokeSvgMagentaPixels}`,
  );
  assert(
    canvaskitDashedSvgBluePixels > 20 && canvaskitDashedSvgMagentaPixels < 5,
    `CanvasKit strict outline paints dashed SvgGlyph stroke blue=${canvaskitDashedSvgBluePixels}, magenta=${canvaskitDashedSvgMagentaPixels}`,
  );
  assert(
    canvaskitNoDomParserDashedSvgBluePixels > 20 && canvaskitNoDomParserDashedSvgMagentaPixels < 5,
    `CanvasKit strict outline paints dashed SvgGlyph stroke without DOMParser blue=${canvaskitNoDomParserDashedSvgBluePixels}, magenta=${canvaskitNoDomParserDashedSvgMagentaPixels}`,
  );
  assert(
    canvaskitStyledDashSvgBluePixels > 20 && canvaskitStyledDashSvgMagentaPixels < 5,
    `CanvasKit strict outline paints styled dashed SvgGlyph stroke blue=${canvaskitStyledDashSvgBluePixels}, magenta=${canvaskitStyledDashSvgMagentaPixels}`,
  );
  assert(
    canvaskitNoDomParserStyledDashSvgBluePixels > 20 && canvaskitNoDomParserStyledDashSvgMagentaPixels < 5,
    `CanvasKit strict outline paints styled dashed SvgGlyph stroke without DOMParser blue=${canvaskitNoDomParserStyledDashSvgBluePixels}, magenta=${canvaskitNoDomParserStyledDashSvgMagentaPixels}`,
  );
  assert(
    canvaskitPxLengthSvgBluePixels > 40 && canvaskitPxLengthSvgMagentaPixels < 5,
    `CanvasKit strict outline paints px-length SvgGlyph stroke blue=${canvaskitPxLengthSvgBluePixels}, magenta=${canvaskitPxLengthSvgMagentaPixels}`,
  );
  assert(
    canvaskitNoDomParserPxLengthSvgBluePixels > 40 && canvaskitNoDomParserPxLengthSvgMagentaPixels < 5,
    `CanvasKit strict outline paints px-length SvgGlyph stroke without DOMParser blue=${canvaskitNoDomParserPxLengthSvgBluePixels}, magenta=${canvaskitNoDomParserPxLengthSvgMagentaPixels}`,
  );
  assert(
    canvaskitZeroWidthStrokeSvgMagentaPixels > 100 && canvaskitZeroWidthStrokeSvgBluePixels < 5,
    `CanvasKit strict outline treats zero-width SvgGlyph stroke as no stroke magenta=${canvaskitZeroWidthStrokeSvgMagentaPixels}, blue=${canvaskitZeroWidthStrokeSvgBluePixels}`,
  );
  assert(
    canvaskitNoDomParserZeroWidthStrokeSvgMagentaPixels > 100
      && canvaskitNoDomParserZeroWidthStrokeSvgBluePixels < 5,
    `CanvasKit strict outline treats zero-width SvgGlyph stroke as no stroke without DOMParser magenta=${canvaskitNoDomParserZeroWidthStrokeSvgMagentaPixels}, blue=${canvaskitNoDomParserZeroWidthStrokeSvgBluePixels}`,
  );
  assert(
    canvaskitStyledZeroWidthStrokeSvgMagentaPixels > 100 && canvaskitStyledZeroWidthStrokeSvgBluePixels < 5,
    `CanvasKit strict outline inherits zero-width SvgGlyph stroke as no stroke magenta=${canvaskitStyledZeroWidthStrokeSvgMagentaPixels}, blue=${canvaskitStyledZeroWidthStrokeSvgBluePixels}`,
  );
  assert(
    canvaskitNoDomParserStyledZeroWidthStrokeSvgMagentaPixels > 100
      && canvaskitNoDomParserStyledZeroWidthStrokeSvgBluePixels < 5,
    `CanvasKit strict outline inherits zero-width SvgGlyph stroke as no stroke without DOMParser magenta=${canvaskitNoDomParserStyledZeroWidthStrokeSvgMagentaPixels}, blue=${canvaskitNoDomParserStyledZeroWidthStrokeSvgBluePixels}`,
  );
  assert(
    canvaskitTransparentStrokeSvgMagentaPixels > 100 && canvaskitTransparentStrokeSvgBluePixels < 5,
    `CanvasKit strict outline treats transparent SvgGlyph stroke as no stroke magenta=${canvaskitTransparentStrokeSvgMagentaPixels}, blue=${canvaskitTransparentStrokeSvgBluePixels}`,
  );
  assert(
    canvaskitNoDomParserTransparentStrokeSvgMagentaPixels > 100
      && canvaskitNoDomParserTransparentStrokeSvgBluePixels < 5,
    `CanvasKit strict outline treats transparent SvgGlyph stroke as no stroke without DOMParser magenta=${canvaskitNoDomParserTransparentStrokeSvgMagentaPixels}, blue=${canvaskitNoDomParserTransparentStrokeSvgBluePixels}`,
  );
  assert(
    canvaskitStyledTransparentStrokeSvgMagentaPixels > 100 && canvaskitStyledTransparentStrokeSvgBluePixels < 5,
    `CanvasKit strict outline inherits transparent SvgGlyph stroke as no stroke magenta=${canvaskitStyledTransparentStrokeSvgMagentaPixels}, blue=${canvaskitStyledTransparentStrokeSvgBluePixels}`,
  );
  assert(
    canvaskitNoDomParserStyledTransparentStrokeSvgMagentaPixels > 100
      && canvaskitNoDomParserStyledTransparentStrokeSvgBluePixels < 5,
    `CanvasKit strict outline inherits transparent SvgGlyph stroke as no stroke without DOMParser magenta=${canvaskitNoDomParserStyledTransparentStrokeSvgMagentaPixels}, blue=${canvaskitNoDomParserStyledTransparentStrokeSvgBluePixels}`,
  );
  assert(
    canvaskitInvisibleStrokeOnlySvgBluePixels < 5
      && canvaskitInvisibleStrokeOnlySvgRedPixels < 5
      && canvaskitInvisibleStrokeOnlySvgMagentaPixels < 5,
    `CanvasKit strict outline keeps invisible stroke-only SvgGlyph replayable without fallback blue=${canvaskitInvisibleStrokeOnlySvgBluePixels}, red=${canvaskitInvisibleStrokeOnlySvgRedPixels}, magenta=${canvaskitInvisibleStrokeOnlySvgMagentaPixels}`,
  );
  assert(
    canvaskitNoDomParserInvisibleStrokeOnlySvgBluePixels < 5
      && canvaskitNoDomParserInvisibleStrokeOnlySvgRedPixels < 5
      && canvaskitNoDomParserInvisibleStrokeOnlySvgMagentaPixels < 5,
    `CanvasKit strict outline keeps invisible stroke-only SvgGlyph replayable without fallback without DOMParser blue=${canvaskitNoDomParserInvisibleStrokeOnlySvgBluePixels}, red=${canvaskitNoDomParserInvisibleStrokeOnlySvgRedPixels}, magenta=${canvaskitNoDomParserInvisibleStrokeOnlySvgMagentaPixels}`,
  );
  assert(
    canvaskitNamedCssColorSvgMagentaPixels > 100,
    `CanvasKit strict outline paints named CSS color SvgGlyph resource magenta=${canvaskitNamedCssColorSvgMagentaPixels}`,
  );
  assert(
    canvaskitNoDomParserNamedCssColorSvgMagentaPixels > 100,
    `CanvasKit strict outline paints named CSS color SvgGlyph without DOMParser magenta=${canvaskitNoDomParserNamedCssColorSvgMagentaPixels}`,
  );
  assert(
    canvaskitNoCssNamedCssColorSvgMagentaPixels > 100,
    `CanvasKit strict outline paints full named CSS color SvgGlyph without DOMParser/CSS magenta=${canvaskitNoCssNamedCssColorSvgMagentaPixels}`,
  );
  assert(
    canvaskitFunctionalCssColorSvgMagentaPixels > 100,
    `CanvasKit strict outline paints functional CSS color SvgGlyph resource magenta=${canvaskitFunctionalCssColorSvgMagentaPixels}`,
  );
  assert(
    canvaskitNoDomParserFunctionalCssColorSvgMagentaPixels > 100,
    `CanvasKit strict outline paints functional CSS color SvgGlyph without DOMParser magenta=${canvaskitNoDomParserFunctionalCssColorSvgMagentaPixels}`,
  );
  assert(
    canvaskitNoCssFunctionalCssColorSvgMagentaPixels > 100,
    `CanvasKit strict outline paints functional CSS color SvgGlyph without DOMParser/CSS magenta=${canvaskitNoCssFunctionalCssColorSvgMagentaPixels}`,
  );
  assert(
    canvaskitWideGamutCssColorSvgMagentaPixels > 500,
    `CanvasKit strict outline paints wide-gamut CSS color SvgGlyph resource magenta=${canvaskitWideGamutCssColorSvgMagentaPixels}`,
  );
  assert(
    canvaskitNoDomParserWideGamutCssColorSvgMagentaPixels > 500,
    `CanvasKit strict outline paints wide-gamut CSS color SvgGlyph without DOMParser magenta=${canvaskitNoDomParserWideGamutCssColorSvgMagentaPixels}`,
  );
  assert(
    canvaskitNoCssWideGamutCssColorSvgMagentaPixels > 500,
    `CanvasKit strict outline paints wide-gamut CSS color SvgGlyph without DOMParser/CSS magenta=${canvaskitNoCssWideGamutCssColorSvgMagentaPixels}`,
  );
  assert(
    canvaskitStylePrecedenceSvgMagentaPixels > 100 && canvaskitStylePrecedenceSvgRedPixels < 5,
    `CanvasKit strict outline honors SvgGlyph style precedence magenta=${canvaskitStylePrecedenceSvgMagentaPixels}, red=${canvaskitStylePrecedenceSvgRedPixels}`,
  );
  assert(
    canvaskitNoDomParserStylePrecedenceSvgMagentaPixels > 100
      && canvaskitNoDomParserStylePrecedenceSvgRedPixels < 5,
    `CanvasKit strict outline honors SvgGlyph style precedence without DOMParser magenta=${canvaskitNoDomParserStylePrecedenceSvgMagentaPixels}, red=${canvaskitNoDomParserStylePrecedenceSvgRedPixels}`,
  );
  assert(
    canvaskitStyleCascadeSvgMagentaPixels > 100 && canvaskitStyleCascadeSvgRedPixels < 5,
    `CanvasKit strict outline honors SvgGlyph style cascade magenta=${canvaskitStyleCascadeSvgMagentaPixels}, red=${canvaskitStyleCascadeSvgRedPixels}`,
  );
  assert(
    canvaskitNoDomParserStyleCascadeSvgMagentaPixels > 100
      && canvaskitNoDomParserStyleCascadeSvgRedPixels < 5,
    `CanvasKit strict outline honors SvgGlyph style cascade without DOMParser magenta=${canvaskitNoDomParserStyleCascadeSvgMagentaPixels}, red=${canvaskitNoDomParserStyleCascadeSvgRedPixels}`,
  );
  assert(
    canvaskitStyleCommentSvgMagentaPixels > 100
      && canvaskitStyleCommentSvgBluePixels < 5
      && canvaskitStyleCommentSvgRedPixels < 5,
    `CanvasKit strict outline skips SvgGlyph style comments magenta=${canvaskitStyleCommentSvgMagentaPixels}, blue=${canvaskitStyleCommentSvgBluePixels}, red=${canvaskitStyleCommentSvgRedPixels}`,
  );
  assert(
    canvaskitNoDomParserStyleCommentSvgMagentaPixels > 100
      && canvaskitNoDomParserStyleCommentSvgBluePixels < 5
      && canvaskitNoDomParserStyleCommentSvgRedPixels < 5,
    `CanvasKit strict outline skips SvgGlyph style comments without DOMParser magenta=${canvaskitNoDomParserStyleCommentSvgMagentaPixels}, blue=${canvaskitNoDomParserStyleCommentSvgBluePixels}, red=${canvaskitNoDomParserStyleCommentSvgRedPixels}`,
  );
  assert(
    canvaskitAttributeEntitySvgMagentaPixels > 100,
    `CanvasKit strict outline decodes entity-encoded SvgGlyph attributes magenta=${canvaskitAttributeEntitySvgMagentaPixels}`,
  );
  assert(
    canvaskitNoDomParserAttributeEntitySvgMagentaPixels > 100,
    `CanvasKit strict outline decodes entity-encoded SvgGlyph attributes without DOMParser magenta=${canvaskitNoDomParserAttributeEntitySvgMagentaPixels}`,
  );
  assert(
    canvaskitStyleEntitySvgMagentaPixels > 100
      && canvaskitStyleEntitySvgRedPixels < 5,
    `CanvasKit strict outline decodes entity-encoded SvgGlyph styles magenta=${canvaskitStyleEntitySvgMagentaPixels}, red=${canvaskitStyleEntitySvgRedPixels}`,
  );
  assert(
    canvaskitNoDomParserStyleEntitySvgMagentaPixels > 100
      && canvaskitNoDomParserStyleEntitySvgRedPixels < 5,
    `CanvasKit strict outline decodes entity-encoded SvgGlyph styles without DOMParser magenta=${canvaskitNoDomParserStyleEntitySvgMagentaPixels}, red=${canvaskitNoDomParserStyleEntitySvgRedPixels}`,
  );
  assert(
    canvaskitPolylineSvgMagentaPixels > 100,
    `CanvasKit strict outline paints polyline SvgGlyph resource magenta=${canvaskitPolylineSvgMagentaPixels}`,
  );
  assert(
    canvaskitNoDomParserPolylineSvgMagentaPixels > 100,
    `CanvasKit strict outline paints polyline SvgGlyph without DOMParser magenta=${canvaskitNoDomParserPolylineSvgMagentaPixels}`,
  );
  assert(
    canvaskitRoundedRectSvgMagentaPixels > 100,
    `CanvasKit strict outline paints rounded rect SvgGlyph resource magenta=${canvaskitRoundedRectSvgMagentaPixels}`,
  );
  assert(
    canvaskitNoDomParserRoundedRectSvgMagentaPixels > 100,
    `CanvasKit strict outline paints rounded rect SvgGlyph without DOMParser magenta=${canvaskitNoDomParserRoundedRectSvgMagentaPixels}`,
  );
  assert(
    canvaskitTransformedSvgMagentaPixels > 100,
    `CanvasKit strict outline paints transformed SvgGlyph resource magenta=${canvaskitTransformedSvgMagentaPixels}`,
  );
  assert(
    canvaskitNoDomParserTransformedSvgMagentaPixels > 100,
    `CanvasKit strict outline paints transformed SvgGlyph without DOMParser magenta=${canvaskitNoDomParserTransformedSvgMagentaPixels}`,
  );
  assert(
    canvaskitMatrixTransformSvgMagentaPixels > 100,
    `CanvasKit strict outline paints matrix-transform SvgGlyph resource magenta=${canvaskitMatrixTransformSvgMagentaPixels}`,
  );
  assert(
    canvaskitNoDomParserMatrixTransformSvgMagentaPixels > 100,
    `CanvasKit strict outline paints matrix-transform SvgGlyph without DOMParser magenta=${canvaskitNoDomParserMatrixTransformSvgMagentaPixels}`,
  );
  assert(
    canvaskitRootTransformSvgMagentaPixels > 100,
    `CanvasKit strict outline paints root-transform SvgGlyph resource magenta=${canvaskitRootTransformSvgMagentaPixels}`,
  );
  assert(
    canvaskitNoDomParserRootTransformSvgMagentaPixels > 100,
    `CanvasKit strict outline paints root-transform SvgGlyph without DOMParser magenta=${canvaskitNoDomParserRootTransformSvgMagentaPixels}`,
  );
  assert(
    canvaskitTransformListSvgMagentaPixels > 100,
    `CanvasKit strict outline paints transform-list SvgGlyph resource magenta=${canvaskitTransformListSvgMagentaPixels}`,
  );
  assert(
    canvaskitNoDomParserTransformListSvgMagentaPixels > 100,
    `CanvasKit strict outline paints transform-list SvgGlyph without DOMParser magenta=${canvaskitNoDomParserTransformListSvgMagentaPixels}`,
  );
  assert(
    canvaskitGroupTransformSvgMagentaPixels > 100,
    `CanvasKit strict outline paints group-transform SvgGlyph resource magenta=${canvaskitGroupTransformSvgMagentaPixels}`,
  );
  assert(
    canvaskitNoDomParserGroupTransformSvgMagentaPixels > 100,
    `CanvasKit strict outline paints group-transform SvgGlyph without DOMParser magenta=${canvaskitNoDomParserGroupTransformSvgMagentaPixels}`,
  );
  assert(
    canvaskitInheritedPaintSvgMagentaPixels > 100,
    `CanvasKit strict outline paints inherited-paint SvgGlyph resource magenta=${canvaskitInheritedPaintSvgMagentaPixels}`,
  );
  assert(
    canvaskitNoDomParserInheritedPaintSvgMagentaPixels > 100,
    `CanvasKit strict outline paints inherited-paint SvgGlyph without DOMParser magenta=${canvaskitNoDomParserInheritedPaintSvgMagentaPixels}`,
  );
  assert(
    canvaskitCurrentColorSvgMagentaPixels > 100 && canvaskitCurrentColorSvgBluePixels > 10,
    `CanvasKit strict outline resolves currentColor SvgGlyph resource magenta=${canvaskitCurrentColorSvgMagentaPixels}, blue=${canvaskitCurrentColorSvgBluePixels}`,
  );
  assert(
    canvaskitNoDomParserCurrentColorSvgMagentaPixels > 100
      && canvaskitNoDomParserCurrentColorSvgBluePixels > 10,
    `CanvasKit strict outline resolves currentColor SvgGlyph without DOMParser magenta=${canvaskitNoDomParserCurrentColorSvgMagentaPixels}, blue=${canvaskitNoDomParserCurrentColorSvgBluePixels}`,
  );
  assert(
    canvaskitIdentityOpacitySvgMagentaPixels > 100,
    `CanvasKit strict outline paints identity-opacity SvgGlyph resource magenta=${canvaskitIdentityOpacitySvgMagentaPixels}`,
  );
  assert(
    canvaskitNoDomParserIdentityOpacitySvgMagentaPixels > 100,
    `CanvasKit strict outline paints identity-opacity SvgGlyph without DOMParser magenta=${canvaskitNoDomParserIdentityOpacitySvgMagentaPixels}`,
  );

  setTestCase('canvas-layer-glyph-outline-payload-parity');
  const glyphOutlinePayloadParityProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }

    const style = (color) => ({
      fontFamily: 'Noto Sans KR',
      fontSize: 20,
      color,
      bold: false,
      italic: false,
      ratio: 1,
      underline: 'none',
      underlineShape: 0,
      strikethrough: false,
      strikeShape: 0,
      outlineType: 0,
      shadowType: 0,
      shadowColor: '#000000',
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      emboss: false,
      engrave: false,
      emphasisDot: 0,
      underlineColor: color,
      strikeColor: color,
      shadeColor: '#ffffff',
    });
    const source = { id: 1902, utf8Range: { start: 0, end: 1 }, utf16Range: { start: 0, end: 1 } };
    const squarePath = {
      glyphId: 42,
      sourceRangeUtf8: { start: 0, end: 1 },
      glyphRange: { start: 0, end: 1 },
      fillRule: 'nonzero',
      commands: [
        { type: 'moveTo', x: 0, y: 0 },
        { type: 'lineTo', x: 14, y: 0 },
        { type: 'lineTo', x: 14, y: 14 },
        { type: 'lineTo', x: 0, y: 14 },
        { type: 'closePath' },
      ],
    };
    const pixelCanvas = document.createElement('canvas');
    pixelCanvas.width = 1;
    pixelCanvas.height = 1;
    const pixelContext = pixelCanvas.getContext('2d');
    if (!pixelContext) {
      return { error: 'bitmap fixture canvas unavailable' };
    }
    pixelContext.fillStyle = '#000000';
    pixelContext.fillRect(0, 0, 1, 1);
    const pixelBytes = Uint8Array.from(
      atob(pixelCanvas.toDataURL('image/png').split(',')[1]),
      (ch) => ch.charCodeAt(0),
    );
    const variantFor = (group, requires) => ({
      equivalenceGroup: group,
      variantId: 'glyphOutline',
      variantKind: 'glyphOutline',
      partIndex: 0,
      partCount: 1,
      isDefaultFallback: false,
      quality: 'exact',
      requires,
      anchorOpId: `op-text-${group}`,
      localPaintOrder: 0,
    });
    const textRunFor = (group, x) => ({
      id: `op-text-${group}`,
      type: 'textRun',
      bbox: { x, y: 6, width: 24, height: 24 },
      source,
      variant: {
        equivalenceGroup: group,
        variantId: 'textRun',
        variantKind: 'textRun',
        partIndex: 0,
        partCount: 1,
        isDefaultFallback: true,
        quality: 'exact',
      },
      text: 'A',
      baseline: 28,
      rotation: 0,
      isVertical: false,
      orientation: 'horizontal',
      projectionKind: 'verbatim',
      clusterBasis: 'legacyPosition',
      style: style('#dd0000'),
      paintStyle: style('#dd0000'),
      positions: [0, 14],
      controlMarks: [],
      tabLeaders: [],
    });
    const outlineBase = (group, x, overrides) => ({
      id: `op-outline-${group}`,
      type: 'glyphOutline',
      bbox: { x, y: 8, width: 16, height: 16 },
      source,
      paintStyle: style('#000000'),
      placement: {
        runToPage: { a: 1, b: 0, c: 0, d: 1, e: x, f: 8 },
        baselineY: 0,
      },
      paths: [squarePath],
      diagnostics: {
        quality: 'exact',
        replayEligibility: 'portable',
        strictVisualEligible: true,
        maxOriginDeltaPx: 0,
        maxAdvanceDeltaPx: 0,
        maxResidualAfterAdjustmentPx: 0,
        clusterMismatchCount: 0,
        missingGlyphCount: 0,
        usedFallbackFontCount: 0,
      },
      ...overrides,
    });
    const colorV0Outline = outlineBase('outline-parity-colrv0', 8, {
      bbox: { x: 8, y: 8, width: 24, height: 22 },
      payloadKind: 'colorLayers',
      variant: variantFor('outline-parity-colrv0', [
        'text.outlineGlyph',
        'text.glyphOutline.colorLayers',
        'text.glyphOutline.colorLayers.colrV0',
      ]),
      paths: [],
      colorLayers: {
        colorFormat: 'colrV0',
        sourceFontRef: { faceKey: 'fixture-face', glyphId: 41, colorFormat: 'colrV0' },
        paletteRef: { index: 0, cpalDigest: 'fixture-cpal-digest' },
        sourceRangeUtf8: { start: 0, end: 1 },
        glyphRange: { start: 0, end: 1 },
        layers: [{
          layerIndex: 0,
          glyphId: 79,
          glyphRange: { start: 0, end: 1 },
          sourceRangeUtf8: { start: 0, end: 1 },
          sourceFontRef: { faceKey: 'fixture-face', glyphId: 79, paletteIndex: 2, colorFormat: 'colrV0' },
          commands: squarePath.commands,
          fill: { rgba: [0, 0, 0.9, 1] },
          fillRule: 'nonzero',
          paletteIndex: 2,
          transformToRun: { a: 1, b: 0, c: 0, d: 1, e: 5, f: 3 },
        }],
      },
    });
    const colorV1Outline = outlineBase('outline-parity-colrv1', 36, {
      payloadKind: 'colorLayers',
      variant: variantFor('outline-parity-colrv1', [
        'text.outlineGlyph',
        'text.glyphOutline.colorLayers',
        'text.glyphOutline.colorLayers.colrV1',
      ]),
      paths: [],
      colorLayers: {
        colorFormat: 'colrV1',
        sourceFontRef: { faceKey: 'fixture-face', glyphId: 42, colorFormat: 'colrV1' },
        sourceRangeUtf8: { start: 0, end: 1 },
        glyphRange: { start: 0, end: 1 },
        layers: [],
        paintGraph: {
          rootNodeId: 1,
          nodes: [
            {
              nodeId: 1,
              kind: 'transform',
              transform: {
                childNodeId: 2,
                transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
              },
              sourceRangeUtf8: { start: 0, end: 1 },
              glyphRange: { start: 0, end: 1 },
              sourceFontRef: { faceKey: 'fixture-face', glyphId: 42, colorFormat: 'colrV1' },
            },
            {
              nodeId: 2,
              kind: 'solidPath',
              solidPath: {
                commands: squarePath.commands,
                fill: { rgba: [0, 0.75, 0, 1] },
                fillRule: 'nonzero',
                sourceGlyphId: 77,
                paletteIndex: 5,
              },
              sourceRangeUtf8: { start: 0, end: 1 },
              glyphRange: { start: 0, end: 1 },
              sourceFontRef: { faceKey: 'fixture-face', glyphId: 77, paletteIndex: 5, colorFormat: 'colrV1' },
            },
          ],
        },
      },
    });
    const colorV1HardStopGradientOutline = outlineBase('outline-parity-colrv1-hard-stop', 172, {
      payloadKind: 'colorLayers',
      variant: variantFor('outline-parity-colrv1-hard-stop', [
        'text.outlineGlyph',
        'text.glyphOutline.colorLayers',
        'text.glyphOutline.colorLayers.colrV1',
      ]),
      paths: [],
      colorLayers: {
        colorFormat: 'colrV1',
        sourceFontRef: { faceKey: 'fixture-face', glyphId: 43, colorFormat: 'colrV1' },
        sourceRangeUtf8: { start: 0, end: 1 },
        glyphRange: { start: 0, end: 1 },
        layers: [],
        paintGraph: {
          rootNodeId: 1,
          nodes: [
            {
              nodeId: 1,
              kind: 'transform',
              transform: {
                childNodeId: 2,
                transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
              },
              sourceRangeUtf8: { start: 0, end: 1 },
              glyphRange: { start: 0, end: 1 },
              sourceFontRef: { faceKey: 'fixture-face', glyphId: 43, colorFormat: 'colrV1' },
            },
            {
              nodeId: 2,
              kind: 'linearGradientPath',
              linearGradientPath: {
                commands: squarePath.commands,
                gradient: {
                  x0: 0,
                  y0: 0,
                  x1: 14,
                  y1: 0,
                  stops: [
                    { offset: 0, color: { rgba: [1, 0, 0, 1] } },
                    { offset: 0.5, color: { rgba: [1, 0, 0, 1] } },
                    { offset: 0.5, color: { rgba: [0, 0, 1, 1] } },
                    { offset: 1, color: { rgba: [0, 0, 1, 1] } },
                  ],
                },
                fillRule: 'nonzero',
                sourceGlyphId: 43,
                paletteIndex: 1,
              },
              sourceRangeUtf8: { start: 0, end: 1 },
              glyphRange: { start: 0, end: 1 },
              sourceFontRef: { faceKey: 'fixture-face', glyphId: 43, paletteIndex: 1, colorFormat: 'colrV1' },
            },
          ],
        },
      },
    });
    const colorV1RadialGradientOutline = outlineBase('outline-parity-colrv1-radial', 198, {
      payloadKind: 'colorLayers',
      variant: variantFor('outline-parity-colrv1-radial', [
        'text.outlineGlyph',
        'text.glyphOutline.colorLayers',
        'text.glyphOutline.colorLayers.colrV1',
      ]),
      paths: [],
      colorLayers: {
        colorFormat: 'colrV1',
        sourceFontRef: { faceKey: 'fixture-face', glyphId: 44, colorFormat: 'colrV1' },
        sourceRangeUtf8: { start: 0, end: 1 },
        glyphRange: { start: 0, end: 1 },
        layers: [],
        paintGraph: {
          rootNodeId: 1,
          nodes: [
            {
              nodeId: 1,
              kind: 'transform',
              transform: {
                childNodeId: 2,
                transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
              },
              sourceRangeUtf8: { start: 0, end: 1 },
              glyphRange: { start: 0, end: 1 },
              sourceFontRef: { faceKey: 'fixture-face', glyphId: 44, colorFormat: 'colrV1' },
            },
            {
              nodeId: 2,
              kind: 'radialGradientPath',
              radialGradientPath: {
                commands: squarePath.commands,
                gradient: {
                  cx: 7,
                  cy: 7,
                  radius: 7,
                  stops: [
                    { offset: 0, color: { rgba: [1, 0, 0, 1] } },
                    { offset: 1, color: { rgba: [0, 0, 1, 1] } },
                  ],
                },
                fillRule: 'nonzero',
                sourceGlyphId: 44,
                paletteIndex: 2,
              },
              sourceRangeUtf8: { start: 0, end: 1 },
              glyphRange: { start: 0, end: 1 },
              sourceFontRef: { faceKey: 'fixture-face', glyphId: 44, paletteIndex: 2, colorFormat: 'colrV1' },
            },
          ],
        },
      },
    });
    const colorV1SweepGradientOutline = outlineBase('outline-parity-colrv1-sweep', 224, {
      payloadKind: 'colorLayers',
      variant: variantFor('outline-parity-colrv1-sweep', [
        'text.outlineGlyph',
        'text.glyphOutline.colorLayers',
        'text.glyphOutline.colorLayers.colrV1',
      ]),
      paths: [],
      colorLayers: {
        colorFormat: 'colrV1',
        sourceFontRef: { faceKey: 'fixture-face', glyphId: 45, colorFormat: 'colrV1' },
        sourceRangeUtf8: { start: 0, end: 1 },
        glyphRange: { start: 0, end: 1 },
        layers: [],
        paintGraph: {
          rootNodeId: 1,
          nodes: [
            {
              nodeId: 1,
              kind: 'transform',
              transform: {
                childNodeId: 2,
                transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
              },
              sourceRangeUtf8: { start: 0, end: 1 },
              glyphRange: { start: 0, end: 1 },
              sourceFontRef: { faceKey: 'fixture-face', glyphId: 45, colorFormat: 'colrV1' },
            },
            {
              nodeId: 2,
              kind: 'sweepGradientPath',
              sweepGradientPath: {
                commands: squarePath.commands,
                gradient: {
                  cx: 7,
                  cy: 7,
                  startAngleDegrees: 0,
                  endAngleDegrees: 360,
                  stops: [
                    { offset: 0, color: { rgba: [1, 0, 0, 1] } },
                    { offset: 0.5, color: { rgba: [0, 1, 0, 1] } },
                    { offset: 1, color: { rgba: [0, 0, 1, 1] } },
                  ],
                },
                fillRule: 'nonzero',
                sourceGlyphId: 45,
                paletteIndex: 3,
              },
              sourceRangeUtf8: { start: 0, end: 1 },
              glyphRange: { start: 0, end: 1 },
              sourceFontRef: { faceKey: 'fixture-face', glyphId: 45, paletteIndex: 3, colorFormat: 'colrV1' },
            },
          ],
        },
      },
    });
    const bitmapOutline = outlineBase('outline-parity-bitmap', 62, {
      payloadKind: 'bitmapGlyph',
      variant: variantFor('outline-parity-bitmap', ['text.outlineGlyph', 'text.glyphOutline.bitmapGlyph']),
      paths: [],
      bitmapGlyph: {
        imageResourceId: 'glyph-outline-parity-pixel',
        sourceRangeUtf8: { start: 0, end: 1 },
        glyphRange: { start: 0, end: 1 },
        placement: {
          runToPage: { a: 1, b: 0, c: 0, d: 1, e: 62, f: 8 },
          baselineY: 0,
        },
        transformToRun: { a: 1, b: 0, c: 0, d: 1, e: 2, f: 1 },
        strikeSelection: 'producerResolved',
        alphaMode: 'premultiplied',
        scalingPolicy: 'scaleToEm',
        filtering: 'nearest',
      },
    });
    const svgOutline = outlineBase('outline-parity-svg', 88, {
      payloadKind: 'svgGlyph',
      variant: variantFor('outline-parity-svg', ['text.outlineGlyph', 'text.glyphOutline.svgGlyph']),
      paths: [],
      svgGlyph: {
        vectorResourceId: 'svg-glyph-magenta-square',
        sourceRangeUtf8: { start: 0, end: 1 },
        glyphRange: { start: 0, end: 1 },
        placement: {
          runToPage: { a: 1, b: 0, c: 0, d: 1, e: 88, f: 8 },
          baselineY: 0,
        },
        transformToRun: { a: 1, b: 0, c: 0, d: 1, e: 2, f: 1 },
        viewBox: { x: 0, y: 0, width: 14, height: 14 },
        securityMode: 'staticSanitized',
        scriptAllowed: false,
        animationAllowed: false,
        externalResourcesAllowed: false,
        interactivityAllowed: false,
      },
    });
    const transformedBitmapOutline = outlineBase('outline-parity-bitmap-transform', 114, {
      bbox: { x: 114, y: 8, width: 18, height: 12 },
      payloadKind: 'bitmapGlyph',
      variant: variantFor('outline-parity-bitmap-transform', ['text.outlineGlyph', 'text.glyphOutline.bitmapGlyph']),
      paths: [],
      bitmapGlyph: {
        imageResourceId: 'glyph-outline-parity-pixel',
        sourceRangeUtf8: { start: 0, end: 1 },
        glyphRange: { start: 0, end: 1 },
        placement: {
          runToPage: { a: 1, b: 0, c: 0, d: 1, e: 114, f: 8 },
          baselineY: 0,
        },
        transformToRun: { a: 1.5, b: 0, c: 0, d: 1, e: 3, f: 2 },
        strikeSelection: 'producerResolved',
        alphaMode: 'premultiplied',
        scalingPolicy: 'scaleToEm',
        filtering: 'nearest',
      },
    });
    const transformedSvgOutline = outlineBase('outline-parity-svg-transform-viewbox', 146, {
      bbox: { x: 146, y: 8, width: 18, height: 12 },
      payloadKind: 'svgGlyph',
      variant: variantFor('outline-parity-svg-transform-viewbox', ['text.outlineGlyph', 'text.glyphOutline.svgGlyph']),
      paths: [],
      svgGlyph: {
        vectorResourceId: 'svg-glyph-offset-magenta-rect',
        sourceRangeUtf8: { start: 0, end: 1 },
        glyphRange: { start: 0, end: 1 },
        placement: {
          runToPage: { a: 1, b: 0, c: 0, d: 1, e: 146, f: 8 },
          baselineY: 0,
        },
        transformToRun: { a: 1, b: 0, c: 0, d: 1, e: 3, f: 2 },
        viewBox: { x: 4, y: 5, width: 9, height: 6 },
        securityMode: 'staticSanitized',
        scriptAllowed: false,
        animationAllowed: false,
        externalResourcesAllowed: false,
        interactivityAllowed: false,
      },
    });
    const outlines = [
      colorV0Outline,
      colorV1Outline,
      colorV1HardStopGradientOutline,
      colorV1RadialGradientOutline,
      colorV1SweepGradientOutline,
      bitmapOutline,
      svgOutline,
      transformedBitmapOutline,
      transformedSvgOutline,
    ];
    const tree = {
      pageWidth: 256,
      pageHeight: 32,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1902,
        images: [pixelBytes],
        imageHashes: ['glyph-outline-parity-pixel'],
        imageKeys: ['glyph-outline-parity-pixel'],
        svgFragments: [
          '<path d="M0 0 L14 0 L14 14 L0 14 Z" fill="#ff00cc"/>',
          '<path d="M4 5 L13 5 L13 11 L4 11 Z" fill="#ff00cc"/>',
        ],
        svgHashes: ['glyph-outline-parity-svg-magenta', 'glyph-outline-parity-svg-offset-magenta'],
        svgKeys: ['glyph-outline-parity-svg-magenta', 'svg-glyph-offset-magenta-rect'],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [{
        id: 1902,
        text: 'A',
        utf8Range: { start: 0, end: 1 },
        utf16Range: { start: 0, end: 1 },
        annotations: [],
      }],
      root: {
        kind: 'leaf',
        sourceNodeId: 1902,
        bounds: { x: 0, y: 0, width: 256, height: 32 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 256, height: 32 }, backgroundColor: '#ffffff', borderWidth: 0 },
          ...outlines.flatMap((outline) => [
            textRunFor(outline.variant.equivalenceGroup, outline.bbox.x),
            outline,
          ]),
        ],
      },
    };
    const render = async (renderer, strictGlyphOutlineReplay = false) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      if (strictGlyphOutlineReplay) {
        renderer.setStrictGlyphOutlineReplay(true);
      }
      let asyncResourceReady = false;
      const asyncResourceReadyPromise = new Promise((resolve) => {
        renderer.setAsyncResourceReadyCallback?.(() => {
          asyncResourceReady = true;
          resolve();
        });
      });
      renderer.renderPage(tree, canvas, 1);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await Promise.race([
        asyncResourceReadyPromise,
        new Promise((resolve) => setTimeout(resolve, 250)),
      ]);
      renderer.setAsyncResourceReadyCallback?.(null);
      if (asyncResourceReady) {
        renderer.renderPage(tree, canvas, 1);
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const png = canvas.toDataURL('image/png');
      const diagnostics = renderer.getTextVariantSelectionDiagnostics();
      if (strictGlyphOutlineReplay) {
        renderer.setStrictGlyphOutlineReplay(false);
      }
      canvas.remove();
      return { png, diagnostics };
    };

    return {
      canvas2d: await render(canvas2dRenderer, true),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(
    !glyphOutlinePayloadParityProbe.error,
    glyphOutlinePayloadParityProbe.error || 'glyph outline payload parity probe available',
  );
  const glyphOutlinePayloadDiff = await comparePngBuffers(
    pngBufferFromDataUrl(glyphOutlinePayloadParityProbe.canvas2d.png),
    pngBufferFromDataUrl(glyphOutlinePayloadParityProbe.canvaskit.png),
    {
      diffName: 'canvas-layer-glyph-outline-payload-parity',
      ignoreChannelDelta: 16,
      maxDiffRatio: 0.08,
      inkMaskMaxDiffRatio: 0.03,
      nonInkMaxDiffRatio: 0,
    },
  );
  const glyphOutlinePayloadCanvas2dMagentaPixels = countPixels(
    glyphOutlinePayloadParityProbe.canvas2d.png,
    (pixel) => pixel.alpha > 32 && pixel.red > 200 && pixel.blue > 180 && pixel.green < 80,
  );
  const glyphOutlinePayloadCanvasKitMagentaPixels = countPixels(
    glyphOutlinePayloadParityProbe.canvaskit.png,
    (pixel) => pixel.alpha > 32 && pixel.red > 200 && pixel.blue > 180 && pixel.green < 80,
  );
  const transformedBitmapCanvas2dBlackPixels = countPixels(
    glyphOutlinePayloadParityProbe.canvas2d.png,
    (pixel) => pixel.x >= 117 && pixel.x < 144 && pixel.y >= 10 && pixel.y < 22
      && pixel.alpha > 32 && pixel.red < 80 && pixel.green < 80 && pixel.blue < 80,
  );
  const transformedBitmapCanvasKitBlackPixels = countPixels(
    glyphOutlinePayloadParityProbe.canvaskit.png,
    (pixel) => pixel.x >= 117 && pixel.x < 144 && pixel.y >= 10 && pixel.y < 22
      && pixel.alpha > 32 && pixel.red < 80 && pixel.green < 80 && pixel.blue < 80,
  );
  const transformedSvgCanvas2dMagentaPixels = countPixels(
    glyphOutlinePayloadParityProbe.canvas2d.png,
    (pixel) => pixel.x >= 149 && pixel.x < 167 && pixel.y >= 10 && pixel.y < 22
      && pixel.alpha > 32 && pixel.red > 200 && pixel.blue > 180 && pixel.green < 80,
  );
  const transformedSvgCanvasKitMagentaPixels = countPixels(
    glyphOutlinePayloadParityProbe.canvaskit.png,
    (pixel) => pixel.x >= 149 && pixel.x < 167 && pixel.y >= 10 && pixel.y < 22
      && pixel.alpha > 32 && pixel.red > 200 && pixel.blue > 180 && pixel.green < 80,
  );
  const hardStopGradientCanvas2dRedPixels = countPixels(
    glyphOutlinePayloadParityProbe.canvas2d.png,
    (pixel) => pixel.x >= 172 && pixel.x < 179 && pixel.y >= 8 && pixel.y < 22
      && pixel.alpha > 32 && pixel.red > 150 && pixel.green < 100 && pixel.blue < 120,
  );
  const hardStopGradientCanvas2dBluePixels = countPixels(
    glyphOutlinePayloadParityProbe.canvas2d.png,
    (pixel) => pixel.x >= 179 && pixel.x < 188 && pixel.y >= 8 && pixel.y < 22
      && pixel.alpha > 32 && pixel.blue > 150 && pixel.green < 100 && pixel.red < 120,
  );
  const hardStopGradientCanvasKitRedPixels = countPixels(
    glyphOutlinePayloadParityProbe.canvaskit.png,
    (pixel) => pixel.x >= 172 && pixel.x < 179 && pixel.y >= 8 && pixel.y < 22
      && pixel.alpha > 32 && pixel.red > 150 && pixel.green < 100 && pixel.blue < 120,
  );
  const hardStopGradientCanvasKitBluePixels = countPixels(
    glyphOutlinePayloadParityProbe.canvaskit.png,
    (pixel) => pixel.x >= 179 && pixel.x < 188 && pixel.y >= 8 && pixel.y < 22
      && pixel.alpha > 32 && pixel.blue > 150 && pixel.green < 100 && pixel.red < 120,
  );
  const radialGradientCanvas2dRedPixels = countPixels(
    glyphOutlinePayloadParityProbe.canvas2d.png,
    (pixel) => pixel.x >= 198 && pixel.x < 212 && pixel.y >= 8 && pixel.y < 22
      && pixel.alpha > 32 && pixel.red > 150 && pixel.green < 100 && pixel.blue < 120,
  );
  const radialGradientCanvas2dBluePixels = countPixels(
    glyphOutlinePayloadParityProbe.canvas2d.png,
    (pixel) => pixel.x >= 198 && pixel.x < 212 && pixel.y >= 8 && pixel.y < 22
      && pixel.alpha > 32 && pixel.blue > 150 && pixel.green < 100 && pixel.red < 120,
  );
  const radialGradientCanvasKitRedPixels = countPixels(
    glyphOutlinePayloadParityProbe.canvaskit.png,
    (pixel) => pixel.x >= 198 && pixel.x < 212 && pixel.y >= 8 && pixel.y < 22
      && pixel.alpha > 32 && pixel.red > 150 && pixel.green < 100 && pixel.blue < 120,
  );
  const radialGradientCanvasKitBluePixels = countPixels(
    glyphOutlinePayloadParityProbe.canvaskit.png,
    (pixel) => pixel.x >= 198 && pixel.x < 212 && pixel.y >= 8 && pixel.y < 22
      && pixel.alpha > 32 && pixel.blue > 150 && pixel.green < 100 && pixel.red < 120,
  );
  const sweepGradientCanvas2dRedPixels = countPixels(
    glyphOutlinePayloadParityProbe.canvas2d.png,
    (pixel) => pixel.x >= 224 && pixel.x < 238 && pixel.y >= 8 && pixel.y < 22
      && pixel.alpha > 32 && pixel.red > 150 && pixel.green < 130 && pixel.blue < 130,
  );
  const sweepGradientCanvas2dBluePixels = countPixels(
    glyphOutlinePayloadParityProbe.canvas2d.png,
    (pixel) => pixel.x >= 224 && pixel.x < 238 && pixel.y >= 8 && pixel.y < 22
      && pixel.alpha > 32 && pixel.blue > 150 && pixel.green < 130 && pixel.red < 130,
  );
  const sweepGradientCanvasKitRedPixels = countPixels(
    glyphOutlinePayloadParityProbe.canvaskit.png,
    (pixel) => pixel.x >= 224 && pixel.x < 238 && pixel.y >= 8 && pixel.y < 22
      && pixel.alpha > 32 && pixel.red > 150 && pixel.green < 130 && pixel.blue < 130,
  );
  const sweepGradientCanvasKitBluePixels = countPixels(
    glyphOutlinePayloadParityProbe.canvaskit.png,
    (pixel) => pixel.x >= 224 && pixel.x < 238 && pixel.y >= 8 && pixel.y < 22
      && pixel.alpha > 32 && pixel.blue > 150 && pixel.green < 130 && pixel.red < 130,
  );
  assert(
    hardStopGradientCanvas2dRedPixels > 40
      && hardStopGradientCanvas2dBluePixels > 40
      && hardStopGradientCanvasKitRedPixels > 40
      && hardStopGradientCanvasKitBluePixels > 40,
    `COLRv1 duplicate-stop gradient paints hard red/blue edge canvas2dRed=${hardStopGradientCanvas2dRedPixels}, canvas2dBlue=${hardStopGradientCanvas2dBluePixels}, canvaskitRed=${hardStopGradientCanvasKitRedPixels}, canvaskitBlue=${hardStopGradientCanvasKitBluePixels}`,
  );
  assert(
    radialGradientCanvas2dRedPixels > 10
      && radialGradientCanvas2dBluePixels > 40
      && radialGradientCanvasKitRedPixels > 10
      && radialGradientCanvasKitBluePixels > 40,
    `COLRv1 radial gradient paints red center and blue rim canvas2dRed=${radialGradientCanvas2dRedPixels}, canvas2dBlue=${radialGradientCanvas2dBluePixels}, canvaskitRed=${radialGradientCanvasKitRedPixels}, canvaskitBlue=${radialGradientCanvasKitBluePixels}`,
  );
  assert(
    sweepGradientCanvas2dRedPixels > 10
      && sweepGradientCanvas2dBluePixels > 10
      && sweepGradientCanvasKitRedPixels > 10
      && sweepGradientCanvasKitBluePixels > 10,
    `COLRv1 sweep gradient paints red/blue angular sectors canvas2dRed=${sweepGradientCanvas2dRedPixels}, canvas2dBlue=${sweepGradientCanvas2dBluePixels}, canvaskitRed=${sweepGradientCanvasKitRedPixels}, canvaskitBlue=${sweepGradientCanvasKitBluePixels}`,
  );
  assert(
    transformedBitmapCanvas2dBlackPixels > 120 && transformedBitmapCanvasKitBlackPixels > 120,
    `transformed BitmapGlyph payload painted expected region canvas2d=${transformedBitmapCanvas2dBlackPixels}, canvaskit=${transformedBitmapCanvasKitBlackPixels}`,
  );
  assert(
    transformedSvgCanvas2dMagentaPixels > 120 && transformedSvgCanvasKitMagentaPixels > 120,
    `transformed SvgGlyph payload painted viewBox-normalized region canvas2d=${transformedSvgCanvas2dMagentaPixels}, canvaskit=${transformedSvgCanvasKitMagentaPixels}`,
  );
  for (const [backend, diagnostics] of [
    ['canvas2d', glyphOutlinePayloadParityProbe.canvas2d.diagnostics],
    ['canvaskit', glyphOutlinePayloadParityProbe.canvaskit.diagnostics],
  ]) {
    const bitmapReport = diagnostics.find((report) =>
      report.equivalenceGroup === 'outline-parity-bitmap',
    );
    const bitmapOutlinePart = bitmapReport?.parts?.find((part) =>
      part.variantId === 'glyphOutline',
    );
    assert(
      bitmapOutlinePart?.details === 'colorSpaceDefaulted=srgb',
      `${backend} BitmapGlyph missing colorSpace records sRGB default diagnostic=${JSON.stringify(bitmapOutlinePart)}`,
    );
  }
  assert(
    glyphOutlinePayloadDiff.passed,
    `glyph outline payload parity exact=${glyphOutlinePayloadDiff.exactDiffPixels}, tolerant=${glyphOutlinePayloadDiff.rawTolerantDiffPixels}, ink=${glyphOutlinePayloadDiff.rawInkMaskDiffPixels}, max_channel_delta=${glyphOutlinePayloadDiff.maxChannelDelta}, canvas2dMagenta=${glyphOutlinePayloadCanvas2dMagentaPixels}, canvaskitMagenta=${glyphOutlinePayloadCanvasKitMagentaPixels}, hardStopCanvas2dRed=${hardStopGradientCanvas2dRedPixels}, hardStopCanvas2dBlue=${hardStopGradientCanvas2dBluePixels}, hardStopCanvaskitRed=${hardStopGradientCanvasKitRedPixels}, hardStopCanvaskitBlue=${hardStopGradientCanvasKitBluePixels}, radialCanvas2dRed=${radialGradientCanvas2dRedPixels}, radialCanvas2dBlue=${radialGradientCanvas2dBluePixels}, radialCanvaskitRed=${radialGradientCanvasKitRedPixels}, radialCanvaskitBlue=${radialGradientCanvasKitBluePixels}, transformedBitmapCanvas2d=${transformedBitmapCanvas2dBlackPixels}, transformedBitmapCanvaskit=${transformedBitmapCanvasKitBlackPixels}, transformedSvgCanvas2d=${transformedSvgCanvas2dMagentaPixels}, transformedSvgCanvaskit=${transformedSvgCanvasKitMagentaPixels}`,
  );

  setTestCase('canvas-layer-form-object-parity');
  const formObjectParityProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const makeForm = (formType, bbox, overrides = {}) => ({
      type: 'formObject',
      bbox,
      formType,
      caption: '',
      text: '',
      foreColor: '#202020',
      backColor: '#f7f7f7',
      value: 0,
      enabled: true,
      ...overrides,
    });
    const tree = {
      pageWidth: 72,
      pageHeight: 36,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1903,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 1903,
        bounds: { x: 0, y: 0, width: 72, height: 36 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 72, height: 36 }, backgroundColor: '#ffffff', borderWidth: 0 },
          makeForm('pushButton', { x: 2, y: 2, width: 22, height: 10 }, { backColor: '#d6d6d6' }),
          makeForm('checkBox', { x: 28, y: 2, width: 14, height: 10 }, { value: 1 }),
          makeForm('radioButton', { x: 46, y: 2, width: 14, height: 10 }, { value: 1 }),
          makeForm('comboBox', { x: 2, y: 18, width: 30, height: 12 }),
          makeForm('edit', { x: 38, y: 18, width: 24, height: 12 }),
        ],
      },
    };
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(!formObjectParityProbe.error, formObjectParityProbe.error || 'form object parity probe available');
  const formObjectCanvas2dInkPixels = countPixels(
    formObjectParityProbe.canvas2d,
    (pixel) => pixel.alpha > 32 && (pixel.red < 240 || pixel.green < 240 || pixel.blue < 240),
  );
  const formObjectCanvaskitInkPixels = countPixels(
    formObjectParityProbe.canvaskit,
    (pixel) => pixel.alpha > 32 && (pixel.red < 240 || pixel.green < 240 || pixel.blue < 240),
  );
  assert(
    formObjectCanvas2dInkPixels > 200 && formObjectCanvaskitInkPixels > 200,
    `form object replay draws geometry canvas2d=${formObjectCanvas2dInkPixels}, canvaskit=${formObjectCanvaskitInkPixels}`,
  );
  const formObjectDiff = await comparePngBuffers(
    pngBufferFromDataUrl(formObjectParityProbe.canvas2d),
    pngBufferFromDataUrl(formObjectParityProbe.canvaskit),
    {
      diffName: 'canvas-layer-form-object-parity',
      ignoreChannelDelta: 24,
      maxDiffRatio: 0.12,
      inkMaskMaxDiffRatio: 0.08,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    formObjectDiff.passed,
    `form object parity exact=${formObjectDiff.exactDiffPixels}, tolerant=${formObjectDiff.rawTolerantDiffPixels}, ink=${formObjectDiff.rawInkMaskDiffPixels}, max_channel_delta=${formObjectDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-form-object-unchecked-parity');
  const formObjectUncheckedParityProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const form = (formType, bbox) => ({
      type: 'formObject',
      bbox,
      formType,
      caption: '',
      text: '',
      foreColor: '#e000e0',
      backColor: '#f4f4f4',
      value: 0,
      enabled: true,
    });
    const tree = {
      pageWidth: 60,
      pageHeight: 28,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1938,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 1938,
        bounds: { x: 0, y: 0, width: 60, height: 28 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 60, height: 28 }, backgroundColor: '#ffffff', borderWidth: 0 },
          form('checkBox', { x: 8, y: 7, width: 14, height: 14 }),
          form('radioButton', { x: 34, y: 7, width: 14, height: 14 }),
        ],
      },
    };
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(
    !formObjectUncheckedParityProbe.error,
    formObjectUncheckedParityProbe.error || 'unchecked form object parity probe available',
  );
  const uncheckedMagenta = (pixel) => pixel.alpha > 32 && pixel.red > 180 && pixel.blue > 180 && pixel.green < 80;
  const uncheckedCanvas2dMagentaPixels = countPixels(formObjectUncheckedParityProbe.canvas2d, uncheckedMagenta);
  const uncheckedCanvaskitMagentaPixels = countPixels(formObjectUncheckedParityProbe.canvaskit, uncheckedMagenta);
  assert(
    uncheckedCanvas2dMagentaPixels === 0 && uncheckedCanvaskitMagentaPixels === 0,
    `unchecked check/radio do not draw selected marks canvas2d=${uncheckedCanvas2dMagentaPixels}, canvaskit=${uncheckedCanvaskitMagentaPixels}`,
  );
  const uncheckedCanvas2dInkPixels = countPixels(
    formObjectUncheckedParityProbe.canvas2d,
    (pixel) => pixel.alpha > 32 && (pixel.red < 240 || pixel.green < 240 || pixel.blue < 240),
  );
  const uncheckedCanvaskitInkPixels = countPixels(
    formObjectUncheckedParityProbe.canvaskit,
    (pixel) => pixel.alpha > 32 && (pixel.red < 240 || pixel.green < 240 || pixel.blue < 240),
  );
  assert(
    uncheckedCanvas2dInkPixels > 90 && uncheckedCanvaskitInkPixels > 90,
    `unchecked check/radio draw empty controls canvas2d=${uncheckedCanvas2dInkPixels}, canvaskit=${uncheckedCanvaskitInkPixels}`,
  );
  const formObjectUncheckedDiff = await comparePngBuffers(
    pngBufferFromDataUrl(formObjectUncheckedParityProbe.canvas2d),
    pngBufferFromDataUrl(formObjectUncheckedParityProbe.canvaskit),
    {
      diffName: 'canvas-layer-form-object-unchecked-parity',
      ignoreChannelDelta: 24,
      maxDiffRatio: 0.12,
      inkMaskMaxDiffRatio: 0.08,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    formObjectUncheckedDiff.passed,
    `unchecked form object parity exact=${formObjectUncheckedDiff.exactDiffPixels}, tolerant=${formObjectUncheckedDiff.rawTolerantDiffPixels}, ink=${formObjectUncheckedDiff.rawInkMaskDiffPixels}, max_channel_delta=${formObjectUncheckedDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-form-object-text-parity');
  const formObjectTextParityProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const makeForm = (formType, bbox, overrides = {}) => ({
      type: 'formObject',
      bbox,
      formType,
      caption: '',
      text: '',
      foreColor: '#0040cc',
      backColor: '#f7f7f7',
      value: 0,
      enabled: true,
      ...overrides,
    });
    const tree = {
      pageWidth: 156,
      pageHeight: 54,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1913,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 1913,
        bounds: { x: 0, y: 0, width: 156, height: 54 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 156, height: 54 }, backgroundColor: '#ffffff', borderWidth: 0 },
          makeForm('pushButton', { x: 2, y: 4, width: 36, height: 16 }, { caption: 'OK' }),
          makeForm('checkBox', { x: 44, y: 4, width: 46, height: 16 }, { caption: 'Chk', value: 1 }),
          makeForm('radioButton', { x: 96, y: 4, width: 48, height: 16 }, { caption: 'Rad', value: 1 }),
          makeForm('comboBox', { x: 2, y: 28, width: 68, height: 16 }, { text: 'One' }),
          makeForm('edit', { x: 80, y: 28, width: 58, height: 16 }, { text: 'Edit' }),
        ],
      },
    };
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(
    !formObjectTextParityProbe.error,
    formObjectTextParityProbe.error || 'form object text parity probe available',
  );
  const formObjectTextCanvas2dBluePixels = countPixels(
    formObjectTextParityProbe.canvas2d,
    (pixel) => pixel.alpha > 32 && pixel.blue > 120 && pixel.red < 120 && pixel.green < 150,
  );
  const formObjectTextCanvaskitBluePixels = countPixels(
    formObjectTextParityProbe.canvaskit,
    (pixel) => pixel.alpha > 32 && pixel.blue > 120 && pixel.red < 120 && pixel.green < 150,
  );
  assert(
    formObjectTextCanvas2dBluePixels > 20 && formObjectTextCanvaskitBluePixels > 20,
    `form object replay draws caption/text pixels canvas2d=${formObjectTextCanvas2dBluePixels}, canvaskit=${formObjectTextCanvaskitBluePixels}`,
  );
  const formObjectTextDiff = await comparePngBuffers(
    pngBufferFromDataUrl(formObjectTextParityProbe.canvas2d),
    pngBufferFromDataUrl(formObjectTextParityProbe.canvaskit),
    {
      diffName: 'canvas-layer-form-object-text-parity',
      ignoreChannelDelta: 48,
      maxDiffRatio: 0.18,
      inkMaskMaxDiffRatio: 0.12,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    formObjectTextDiff.passed,
    `form object text parity exact=${formObjectTextDiff.exactDiffPixels}, tolerant=${formObjectTextDiff.rawTolerantDiffPixels}, ink=${formObjectTextDiff.rawInkMaskDiffPixels}, max_channel_delta=${formObjectTextDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-form-object-cjk-text-parity');
  const formObjectCjkTextParityProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const makeForm = (formType, bbox, overrides = {}) => ({
      type: 'formObject',
      bbox,
      formType,
      caption: '',
      text: '',
      foreColor: '#0040cc',
      backColor: '#f7f7f7',
      value: 0,
      enabled: true,
      ...overrides,
    });
    const tree = {
      pageWidth: 178,
      pageHeight: 54,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 19131,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 19131,
        bounds: { x: 0, y: 0, width: 178, height: 54 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 178, height: 54 }, backgroundColor: '#ffffff', borderWidth: 0 },
          makeForm('pushButton', { x: 2, y: 4, width: 44, height: 16 }, { caption: '확인' }),
          makeForm('checkBox', { x: 52, y: 4, width: 54, height: 16 }, { caption: '선택', value: 1 }),
          makeForm('radioButton', { x: 112, y: 4, width: 58, height: 16 }, { caption: '항목', value: 1 }),
          makeForm('comboBox', { x: 2, y: 28, width: 80, height: 16 }, { text: '가나다' }),
          makeForm('edit', { x: 92, y: 28, width: 78, height: 16 }, { text: '테스트' }),
        ],
      },
    };
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(
    !formObjectCjkTextParityProbe.error,
    formObjectCjkTextParityProbe.error || 'form object CJK text parity probe available',
  );
  const formObjectCjkTextCanvas2dBluePixels = countPixels(
    formObjectCjkTextParityProbe.canvas2d,
    (pixel) => pixel.alpha > 32 && pixel.blue > 120 && pixel.red < 120 && pixel.green < 150,
  );
  const formObjectCjkTextCanvaskitBluePixels = countPixels(
    formObjectCjkTextParityProbe.canvaskit,
    (pixel) => pixel.alpha > 32 && pixel.blue > 120 && pixel.red < 120 && pixel.green < 150,
  );
  assert(
    formObjectCjkTextCanvas2dBluePixels > 20 && formObjectCjkTextCanvaskitBluePixels > 20,
    `form object CJK replay draws caption/text pixels canvas2d=${formObjectCjkTextCanvas2dBluePixels}, canvaskit=${formObjectCjkTextCanvaskitBluePixels}`,
  );
  const formObjectCjkTextDiff = await comparePngBuffers(
    pngBufferFromDataUrl(formObjectCjkTextParityProbe.canvas2d),
    pngBufferFromDataUrl(formObjectCjkTextParityProbe.canvaskit),
    {
      diffName: 'canvas-layer-form-object-cjk-text-parity',
      ignoreChannelDelta: 48,
      maxDiffRatio: 0.2,
      inkMaskMaxDiffRatio: 0.14,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    formObjectCjkTextDiff.passed,
    `form object CJK text parity exact=${formObjectCjkTextDiff.exactDiffPixels}, tolerant=${formObjectCjkTextDiff.rawTolerantDiffPixels}, ink=${formObjectCjkTextDiff.rawInkMaskDiffPixels}, max_channel_delta=${formObjectCjkTextDiff.maxChannelDelta}`,
  );

  setTestCase('canvaskit-form-caption-paragraph-shaping');
  const formCaptionParagraphShapingProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvaskitRenderer) {
      return { error: 'CanvasKit renderer unavailable' };
    }
    const paragraphBuilder = canvaskitRenderer.canvasKit?.ParagraphBuilder;
    const originalMakeFromFontProvider = paragraphBuilder?.MakeFromFontProvider;
    if (!paragraphBuilder || typeof originalMakeFromFontProvider !== 'function') {
      return { error: 'CanvasKit ParagraphBuilder unavailable' };
    }
    const tree = {
      pageWidth: 116,
      pageHeight: 24,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1917,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 1917,
        bounds: { x: 0, y: 0, width: 116, height: 24 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 116, height: 24 }, backgroundColor: '#ffffff', borderWidth: 0 },
          {
            type: 'formObject',
            bbox: { x: 4, y: 4, width: 108, height: 16 },
            formType: 'pushButton',
            caption: 'AVATAR office',
            text: '',
            foreColor: '#0040cc',
            backColor: '#d6d6d6',
            value: 0,
            enabled: true,
          },
        ],
      },
    };
    const originalMeasureTextWidth = globalThis.measureTextWidth;
    let measureCalls = 0;
    let paragraphBuildCalls = 0;
    globalThis.measureTextWidth = () => {
      measureCalls += 1;
      return 999;
    };
    paragraphBuilder.MakeFromFontProvider = function (...args) {
      paragraphBuildCalls += 1;
      return originalMakeFromFontProvider.apply(this, args);
    };
    try {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      canvaskitRenderer.renderPage(tree, canvas, 1);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return { measureCalls, paragraphBuildCalls, png };
    } finally {
      paragraphBuilder.MakeFromFontProvider = originalMakeFromFontProvider;
      if (originalMeasureTextWidth) {
        globalThis.measureTextWidth = originalMeasureTextWidth;
      } else {
        delete globalThis.measureTextWidth;
      }
    }
  });
  assert(
    !formCaptionParagraphShapingProbe.error,
    formCaptionParagraphShapingProbe.error || 'CanvasKit form caption Paragraph shaping probe available',
  );
  const formCaptionBluePixels = countPixels(
    formCaptionParagraphShapingProbe.png,
    (pixel) => pixel.alpha > 32 && pixel.blue > 120 && pixel.red < 120 && pixel.green < 150,
  );
  assert(
    formCaptionParagraphShapingProbe.measureCalls === 0,
    `CanvasKit form caption does not call browser measureTextWidth calls=${formCaptionParagraphShapingProbe.measureCalls}`,
  );
  assert(
    formCaptionParagraphShapingProbe.paragraphBuildCalls > 0,
    `CanvasKit form caption shapes through Paragraph calls=${formCaptionParagraphShapingProbe.paragraphBuildCalls}`,
  );
  assert(
    formCaptionBluePixels > 10,
    `CanvasKit form caption draws shaped text pixels=${formCaptionBluePixels}`,
  );

  setTestCase('canvas-layer-form-object-disabled-parity');
  const formObjectDisabledParityProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const makeForm = (formType, bbox, overrides = {}) => ({
      type: 'formObject',
      bbox,
      formType,
      caption: '',
      text: '',
      foreColor: '#0040cc',
      backColor: '#f7f7f7',
      value: 0,
      enabled: false,
      ...overrides,
    });
    const tree = {
      pageWidth: 156,
      pageHeight: 54,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1919,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 1919,
        bounds: { x: 0, y: 0, width: 156, height: 54 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 156, height: 54 }, backgroundColor: '#ffffff', borderWidth: 0 },
          makeForm('pushButton', { x: 2, y: 4, width: 36, height: 16 }, { caption: 'OK', backColor: null }),
          makeForm('checkBox', { x: 44, y: 4, width: 46, height: 16 }, { caption: 'Chk', value: 1 }),
          makeForm('radioButton', { x: 96, y: 4, width: 48, height: 16 }, { caption: 'Rad', value: 1 }),
          makeForm('comboBox', { x: 2, y: 28, width: 68, height: 16 }, { text: 'One' }),
          makeForm('edit', { x: 80, y: 28, width: 58, height: 16 }, { text: 'Edit' }),
        ],
      },
    };
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(
    !formObjectDisabledParityProbe.error,
    formObjectDisabledParityProbe.error || 'disabled form object parity probe available',
  );
  const disabledBluePixelPredicate = (pixel) => (
    pixel.alpha > 32 && pixel.blue > 140 && pixel.red < 120 && pixel.green < 150
  );
  const disabledGrayPixelPredicate = (pixel) => {
    const maxChannel = Math.max(pixel.red, pixel.green, pixel.blue);
    const minChannel = Math.min(pixel.red, pixel.green, pixel.blue);
    return pixel.alpha > 32 && maxChannel < 230 && minChannel > 80 && maxChannel - minChannel <= 10;
  };
  const disabledFormCanvas2dBluePixels = countPixels(formObjectDisabledParityProbe.canvas2d, disabledBluePixelPredicate);
  const disabledFormCanvaskitBluePixels = countPixels(formObjectDisabledParityProbe.canvaskit, disabledBluePixelPredicate);
  const disabledFormCanvas2dGrayPixels = countPixels(formObjectDisabledParityProbe.canvas2d, disabledGrayPixelPredicate);
  const disabledFormCanvaskitGrayPixels = countPixels(formObjectDisabledParityProbe.canvaskit, disabledGrayPixelPredicate);
  assert(
    disabledFormCanvas2dBluePixels < 5 && disabledFormCanvaskitBluePixels < 5,
    `disabled form object ignores requested foreColor canvas2d=${disabledFormCanvas2dBluePixels}, canvaskit=${disabledFormCanvaskitBluePixels}`,
  );
  assert(
    disabledFormCanvas2dGrayPixels > 120 && disabledFormCanvaskitGrayPixels > 120,
    `disabled form object draws disabled gray palette canvas2d=${disabledFormCanvas2dGrayPixels}, canvaskit=${disabledFormCanvaskitGrayPixels}`,
  );
  const formObjectDisabledDiff = await comparePngBuffers(
    pngBufferFromDataUrl(formObjectDisabledParityProbe.canvas2d),
    pngBufferFromDataUrl(formObjectDisabledParityProbe.canvaskit),
    {
      diffName: 'canvas-layer-form-object-disabled-parity',
      ignoreChannelDelta: 48,
      maxDiffRatio: 0.18,
      inkMaskMaxDiffRatio: 0.12,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    formObjectDisabledDiff.passed,
    `disabled form object parity exact=${formObjectDisabledDiff.exactDiffPixels}, tolerant=${formObjectDisabledDiff.rawTolerantDiffPixels}, ink=${formObjectDisabledDiff.rawInkMaskDiffPixels}, max_channel_delta=${formObjectDisabledDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-combo-box-overflow-text-parity');
  const comboBoxOverflowTextProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const tree = {
      pageWidth: 86,
      pageHeight: 30,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 19131,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 19131,
        bounds: { x: 0, y: 0, width: 86, height: 30 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 86, height: 30 }, backgroundColor: '#ffffff', borderWidth: 0 },
          {
            type: 'formObject',
            bbox: { x: 4, y: 6, width: 72, height: 18 },
            formType: 'comboBox',
            caption: '',
            text: 'VeryLongComboValue',
            foreColor: '#0040cc',
            backColor: '#f7f7f7',
            value: 0,
            enabled: true,
          },
        ],
      },
    };
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(
    !comboBoxOverflowTextProbe.error,
    comboBoxOverflowTextProbe.error || 'combo box overflow text parity probe available',
  );
  const countBluePixelsInRect = (dataUrl, rect) => {
    const png = PNG.sync.read(pngBufferFromDataUrl(dataUrl));
    let count = 0;
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        const offset = (y * png.width + x) * 4;
        if (
          png.data[offset + 3] > 32
          && png.data[offset + 2] > 120
          && png.data[offset] < 120
          && png.data[offset + 1] < 150
        ) {
          count += 1;
        }
      }
    }
    return count;
  };
  const comboButtonRect = { x: 58, y: 6, width: 18, height: 18 };
  const comboBoxCanvas2dButtonBluePixels = countBluePixelsInRect(comboBoxOverflowTextProbe.canvas2d, comboButtonRect);
  const comboBoxCanvaskitButtonBluePixels = countBluePixelsInRect(comboBoxOverflowTextProbe.canvaskit, comboButtonRect);
  assert(
    comboBoxCanvaskitButtonBluePixels <= comboBoxCanvas2dButtonBluePixels + 2,
    `combo box button covers overflow text canvas2d=${comboBoxCanvas2dButtonBluePixels}, canvaskit=${comboBoxCanvaskitButtonBluePixels}`,
  );
  const comboBoxOverflowTextDiff = await comparePngBuffers(
    pngBufferFromDataUrl(comboBoxOverflowTextProbe.canvas2d),
    pngBufferFromDataUrl(comboBoxOverflowTextProbe.canvaskit),
    {
      diffName: 'canvas-layer-combo-box-overflow-text-parity',
      ignoreChannelDelta: 48,
      maxDiffRatio: 0.18,
      inkMaskMaxDiffRatio: 0.12,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    comboBoxOverflowTextDiff.passed,
    `combo box overflow text parity exact=${comboBoxOverflowTextDiff.exactDiffPixels}, tolerant=${comboBoxOverflowTextDiff.rawTolerantDiffPixels}, ink=${comboBoxOverflowTextDiff.rawInkMaskDiffPixels}, max_channel_delta=${comboBoxOverflowTextDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-vector-paint-parity');
  const vectorPaintParityProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const shapeStyle = (fillColor, strokeColor, strokeWidth = 1) => ({
      fillColor,
      strokeColor,
      strokeWidth,
      strokeDash: 'solid',
      opacity: 1,
      pattern: null,
      shadow: null,
    });
    const transform = { rotation: 0, horzFlip: false, vertFlip: false };
    const tree = {
      pageWidth: 96,
      pageHeight: 58,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1904,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 1904,
        bounds: { x: 0, y: 0, width: 96, height: 48 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 96, height: 48 }, backgroundColor: '#ffffff', borderWidth: 0 },
          {
            type: 'rectangle',
            bbox: { x: 4, y: 4, width: 24, height: 16 },
            cornerRadius: 0,
            style: shapeStyle('#b9e8ff', '#14455f', 1),
            gradient: null,
            transform,
          },
          {
            type: 'ellipse',
            bbox: { x: 36, y: 4, width: 22, height: 16 },
            style: shapeStyle('#d2f5bd', '#245714', 1),
            gradient: null,
            transform,
          },
          {
            type: 'path',
            bbox: { x: 66, y: 4, width: 24, height: 18 },
            commands: [
              { type: 'moveTo', x: 68, y: 20 },
              { type: 'lineTo', x: 78, y: 4 },
              { type: 'curveTo', x1: 84, y1: 5, x2: 88, y2: 12, x3: 90, y3: 20 },
              { type: 'closePath' },
            ],
            style: shapeStyle('#ffd9a8', '#6a3400', 1),
            gradient: null,
            transform,
          },
          {
            type: 'line',
            bbox: { x: 5, y: 30, width: 84, height: 10 },
            x1: 6,
            y1: 38,
            x2: 88,
            y2: 30,
            transform,
            style: {
              color: '#202020',
              width: 2,
              dash: 'solid',
              lineType: 'single',
              startArrow: 'none',
              endArrow: 'none',
              startArrowSize: 0,
              endArrowSize: 0,
              shadow: null,
            },
          },
        ],
      },
    };
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(!vectorPaintParityProbe.error, vectorPaintParityProbe.error || 'vector paint parity probe available');
  const vectorCanvas2dInkPixels = countPixels(
    vectorPaintParityProbe.canvas2d,
    (pixel) => pixel.alpha > 32 && (pixel.red < 245 || pixel.green < 245 || pixel.blue < 245),
  );
  const vectorCanvaskitInkPixels = countPixels(
    vectorPaintParityProbe.canvaskit,
    (pixel) => pixel.alpha > 32 && (pixel.red < 245 || pixel.green < 245 || pixel.blue < 245),
  );
  assert(
    vectorCanvas2dInkPixels > 700 && vectorCanvaskitInkPixels > 700,
    `vector paint replay draws geometry canvas2d=${vectorCanvas2dInkPixels}, canvaskit=${vectorCanvaskitInkPixels}`,
  );
  const vectorPaintDiff = await comparePngBuffers(
    pngBufferFromDataUrl(vectorPaintParityProbe.canvas2d),
    pngBufferFromDataUrl(vectorPaintParityProbe.canvaskit),
    {
      diffName: 'canvas-layer-vector-paint-parity',
      ignoreChannelDelta: 24,
      maxDiffRatio: 0.08,
      inkMaskMaxDiffRatio: 0.04,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    vectorPaintDiff.passed,
    `vector paint parity exact=${vectorPaintDiff.exactDiffPixels}, tolerant=${vectorPaintDiff.rawTolerantDiffPixels}, ink=${vectorPaintDiff.rawInkMaskDiffPixels}, max_channel_delta=${vectorPaintDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-shape-shadow-fill-stroke-parity');
  const shapeShadowFillStrokeProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const transform = { rotation: 0, horzFlip: false, vertFlip: false };
    const style = (fillColor, strokeColor, strokeDash = 'solid') => ({
      fillColor,
      strokeColor,
      strokeWidth: 4,
      strokeDash,
      opacity: 0.5,
      pattern: null,
      shadow: {
        color: '#009900',
        alpha: 64,
        offsetX: 8,
        offsetY: 2,
      },
    });
    const tree = {
      pageWidth: 104,
      pageHeight: 44,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 19041,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 19041,
        bounds: { x: 0, y: 0, width: 104, height: 44 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 104, height: 44 }, backgroundColor: '#ffffff', borderWidth: 0 },
          {
            type: 'rectangle',
            bbox: { x: 6, y: 8, width: 26, height: 16 },
            cornerRadius: 0,
            style: style('#ff0000', '#003300', 'dash'),
            gradient: null,
            transform,
          },
          {
            type: 'ellipse',
            bbox: { x: 42, y: 8, width: 24, height: 16 },
            style: style('#0000ff', '#003300', 'dot'),
            gradient: null,
            transform,
          },
          {
            type: 'path',
            bbox: { x: 76, y: 7, width: 22, height: 20 },
            commands: [
              { type: 'moveTo', x: 78, y: 25 },
              { type: 'lineTo', x: 87, y: 8 },
              { type: 'lineTo', x: 97, y: 25 },
              { type: 'closePath' },
            ],
            style: style('#ff00ff', '#003300', 'dashDot'),
            gradient: null,
            transform,
          },
        ],
      },
    };
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(
    !shapeShadowFillStrokeProbe.error,
    shapeShadowFillStrokeProbe.error || 'shape shadow fill/stroke parity probe available',
  );
  const shapeShadowCanvas2dGreenPixels = countPixels(
    shapeShadowFillStrokeProbe.canvas2d,
    (pixel) => pixel.alpha > 32 && pixel.green > pixel.red + 15 && pixel.green > pixel.blue + 15,
  );
  const shapeShadowCanvaskitGreenPixels = countPixels(
    shapeShadowFillStrokeProbe.canvaskit,
    (pixel) => pixel.alpha > 32 && pixel.green > pixel.red + 15 && pixel.green > pixel.blue + 15,
  );
  assert(
    shapeShadowCanvas2dGreenPixels > 200 && shapeShadowCanvaskitGreenPixels > 200,
    `shape shadow replay draws fill/stroke shadow canvas2d=${shapeShadowCanvas2dGreenPixels}, canvaskit=${shapeShadowCanvaskitGreenPixels}`,
  );
  const shapeShadowSourcePixels = [
    [
      'rectangle',
      pixelAt(shapeShadowFillStrokeProbe.canvas2d, 10, 16),
      pixelAt(shapeShadowFillStrokeProbe.canvaskit, 10, 16),
      { red: 255, green: 127, blue: 127, alpha: 255 },
    ],
    [
      'ellipse',
      pixelAt(shapeShadowFillStrokeProbe.canvas2d, 47, 16),
      pixelAt(shapeShadowFillStrokeProbe.canvaskit, 47, 16),
      { red: 127, green: 127, blue: 255, alpha: 255 },
    ],
    [
      'path',
      pixelAt(shapeShadowFillStrokeProbe.canvas2d, 82, 22),
      pixelAt(shapeShadowFillStrokeProbe.canvaskit, 82, 22),
      { red: 255, green: 127, blue: 255, alpha: 255 },
    ],
  ];
  for (const [shape, canvas2dPixel, canvaskitPixel, expected] of shapeShadowSourcePixels) {
    const delta = (actual, target) => Math.max(
      Math.abs(actual.red - target.red),
      Math.abs(actual.green - target.green),
      Math.abs(actual.blue - target.blue),
      Math.abs(actual.alpha - target.alpha),
    );
    assert(
      delta(canvas2dPixel, canvaskitPixel) <= 4
        && delta(canvas2dPixel, expected) <= 16
        && delta(canvaskitPixel, expected) <= 16,
      `${shape} shadow keeps single source opacity `
        + `canvas2d=${JSON.stringify(canvas2dPixel)}, canvaskit=${JSON.stringify(canvaskitPixel)}`,
    );
  }
  const shapeShadowFillStrokeDiff = await comparePngBuffers(
    pngBufferFromDataUrl(shapeShadowFillStrokeProbe.canvas2d),
    pngBufferFromDataUrl(shapeShadowFillStrokeProbe.canvaskit),
    {
      diffName: 'canvas-layer-shape-shadow-fill-stroke-parity',
      ignoreChannelDelta: 48,
      maxDiffRatio: 0.18,
      inkMaskMaxDiffRatio: 0.12,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    shapeShadowFillStrokeDiff.passed,
    `shape shadow fill/stroke parity exact=${shapeShadowFillStrokeDiff.exactDiffPixels}, tolerant=${shapeShadowFillStrokeDiff.rawTolerantDiffPixels}, ink=${shapeShadowFillStrokeDiff.rawInkMaskDiffPixels}, max_channel_delta=${shapeShadowFillStrokeDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-shape-stroke-dash-variant-parity');
  const shapeStrokeDashVariantProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const transform = { rotation: 0, horzFlip: false, vertFlip: false };
    const strokeStyle = (strokeDash) => ({
      fillColor: null,
      strokeColor: '#202020',
      strokeWidth: 3,
      strokeDash,
      opacity: 1,
      pattern: null,
      shadow: null,
    });
    const dashedPath = (y, strokeDash) => ({
      type: 'path',
      bbox: { x: 8, y: y - 5, width: 132, height: 10 },
      commands: [
        { type: 'moveTo', x: 10, y },
        { type: 'lineTo', x: 138, y },
      ],
      style: strokeStyle(strokeDash),
      gradient: null,
      transform,
    });
    const tree = {
      pageWidth: 148,
      pageHeight: 54,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 19042,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 19042,
        bounds: { x: 0, y: 0, width: 148, height: 54 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 148, height: 54 }, backgroundColor: '#ffffff', borderWidth: 0 },
          dashedPath(9, 'dash'),
          dashedPath(20, 'dot'),
          dashedPath(31, 'dashDot'),
          dashedPath(42, 'dashDotDot'),
        ],
      },
    };
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(
    !shapeStrokeDashVariantProbe.error,
    shapeStrokeDashVariantProbe.error || 'shape stroke dash variant parity probe available',
  );
  const shapeStrokeDashCanvas2dInkPixels = countPixels(
    shapeStrokeDashVariantProbe.canvas2d,
    (pixel) => pixel.alpha > 32 && pixel.red < 120 && pixel.green < 120 && pixel.blue < 120,
  );
  const shapeStrokeDashCanvaskitInkPixels = countPixels(
    shapeStrokeDashVariantProbe.canvaskit,
    (pixel) => pixel.alpha > 32 && pixel.red < 120 && pixel.green < 120 && pixel.blue < 120,
  );
  assert(
    shapeStrokeDashCanvas2dInkPixels > 500 && shapeStrokeDashCanvaskitInkPixels > 500,
    `shape stroke dash variants replay canvas2d=${shapeStrokeDashCanvas2dInkPixels}, canvaskit=${shapeStrokeDashCanvaskitInkPixels}`,
  );
  const shapeStrokeDashVariantDiff = await comparePngBuffers(
    pngBufferFromDataUrl(shapeStrokeDashVariantProbe.canvas2d),
    pngBufferFromDataUrl(shapeStrokeDashVariantProbe.canvaskit),
    {
      diffName: 'canvas-layer-shape-stroke-dash-variant-parity',
      ignoreChannelDelta: 48,
      maxDiffRatio: 0.12,
      inkMaskMaxDiffRatio: 0.06,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    shapeStrokeDashVariantDiff.passed,
    `shape stroke dash variant parity exact=${shapeStrokeDashVariantDiff.exactDiffPixels}, tolerant=${shapeStrokeDashVariantDiff.rawTolerantDiffPixels}, ink=${shapeStrokeDashVariantDiff.rawInkMaskDiffPixels}, max_channel_delta=${shapeStrokeDashVariantDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-shape-opacity-parity');
  const shapeOpacityParityProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const transform = { rotation: 0, horzFlip: false, vertFlip: false };
    const fillStyle = (fillColor) => ({
      fillColor,
      strokeColor: null,
      strokeWidth: 0,
      strokeDash: 'solid',
      opacity: 0.5,
      shadow: null,
    });
    const strokeStyle = {
      fillColor: null,
      strokeColor: '#ff0000',
      strokeWidth: 4,
      strokeDash: 'solid',
      opacity: 0.5,
      shadow: null,
    };
    const tree = {
      pageWidth: 160,
      pageHeight: 28,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1912,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 1912,
        bounds: { x: 0, y: 0, width: 160, height: 28 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 160, height: 28 }, backgroundColor: '#ffffff', borderWidth: 0 },
          {
            type: 'rectangle',
            bbox: { x: 4, y: 4, width: 24, height: 16 },
            cornerRadius: 0,
            style: fillStyle('#0000ff'),
            gradient: null,
            transform,
          },
          {
            type: 'rectangle',
            bbox: { x: 36, y: 4, width: 24, height: 16 },
            cornerRadius: 0,
            style: fillStyle(null),
            gradient: {
              gradientType: 0,
              angle: 0,
              centerX: 50,
              centerY: 50,
              colors: ['#000000', '#000000'],
              positions: [0, 1],
            },
            transform,
          },
          {
            type: 'rectangle',
            bbox: { x: 70, y: 6, width: 18, height: 12 },
            cornerRadius: 0,
            style: strokeStyle,
            gradient: null,
            transform,
          },
          {
            type: 'ellipse',
            bbox: { x: 100, y: 4, width: 24, height: 16 },
            style: fillStyle('#00ff00'),
            gradient: null,
            transform,
          },
          {
            type: 'path',
            bbox: { x: 132, y: 4, width: 24, height: 16 },
            commands: [
              { type: 'moveTo', x: 132, y: 4 },
              { type: 'lineTo', x: 156, y: 4 },
              { type: 'lineTo', x: 156, y: 20 },
              { type: 'lineTo', x: 132, y: 20 },
              { type: 'closePath' },
            ],
            style: fillStyle('#ff00ff'),
            gradient: null,
            transform,
          },
        ],
      },
    };
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(!shapeOpacityParityProbe.error, shapeOpacityParityProbe.error || 'shape opacity parity probe available');
  const channelDelta = (a, b) => Math.max(
    Math.abs(a.red - b.red),
    Math.abs(a.green - b.green),
    Math.abs(a.blue - b.blue),
    Math.abs(a.alpha - b.alpha),
  );
  const solidOpacityCanvas2d = pixelAt(shapeOpacityParityProbe.canvas2d, 12, 12);
  const solidOpacityCanvaskit = pixelAt(shapeOpacityParityProbe.canvaskit, 12, 12);
  const shaderOpacityCanvas2d = pixelAt(shapeOpacityParityProbe.canvas2d, 44, 12);
  const shaderOpacityCanvaskit = pixelAt(shapeOpacityParityProbe.canvaskit, 44, 12);
  const strokeOpacityCanvas2d = pixelAt(shapeOpacityParityProbe.canvas2d, 80, 6);
  const strokeOpacityCanvaskit = pixelAt(shapeOpacityParityProbe.canvaskit, 80, 6);
  const ellipseOpacityCanvas2d = pixelAt(shapeOpacityParityProbe.canvas2d, 112, 12);
  const ellipseOpacityCanvaskit = pixelAt(shapeOpacityParityProbe.canvaskit, 112, 12);
  const pathOpacityCanvas2d = pixelAt(shapeOpacityParityProbe.canvas2d, 144, 12);
  const pathOpacityCanvaskit = pixelAt(shapeOpacityParityProbe.canvaskit, 144, 12);
  const assertExpectedPixel = (actual, expected, label) => {
    assert(
      channelDelta(actual, expected) <= 4,
      `${label} expected=${JSON.stringify(expected)}, actual=${JSON.stringify(actual)}`,
    );
  };
  assert(
    channelDelta(solidOpacityCanvas2d, solidOpacityCanvaskit) <= 4,
    `solid shape opacity parity canvas2d=${JSON.stringify(solidOpacityCanvas2d)}, canvaskit=${JSON.stringify(solidOpacityCanvaskit)}`,
  );
  assert(
    channelDelta(shaderOpacityCanvas2d, shaderOpacityCanvaskit) <= 4,
    `shader shape opacity parity canvas2d=${JSON.stringify(shaderOpacityCanvas2d)}, canvaskit=${JSON.stringify(shaderOpacityCanvaskit)}`,
  );
  assert(
    channelDelta(strokeOpacityCanvas2d, strokeOpacityCanvaskit) <= 4,
    `stroke shape opacity parity canvas2d=${JSON.stringify(strokeOpacityCanvas2d)}, canvaskit=${JSON.stringify(strokeOpacityCanvaskit)}`,
  );
  assert(
    channelDelta(ellipseOpacityCanvas2d, ellipseOpacityCanvaskit) <= 4,
    `ellipse shape opacity parity canvas2d=${JSON.stringify(ellipseOpacityCanvas2d)}, canvaskit=${JSON.stringify(ellipseOpacityCanvaskit)}`,
  );
  assert(
    channelDelta(pathOpacityCanvas2d, pathOpacityCanvaskit) <= 4,
    `path shape opacity parity canvas2d=${JSON.stringify(pathOpacityCanvas2d)}, canvaskit=${JSON.stringify(pathOpacityCanvaskit)}`,
  );
  assertExpectedPixel(solidOpacityCanvas2d, { red: 127, green: 127, blue: 255, alpha: 255 }, 'solid shape single opacity');
  assertExpectedPixel(shaderOpacityCanvas2d, { red: 127, green: 127, blue: 127, alpha: 255 }, 'gradient shape single opacity');
  assertExpectedPixel(strokeOpacityCanvas2d, { red: 255, green: 127, blue: 127, alpha: 255 }, 'shape stroke single opacity');
  assertExpectedPixel(ellipseOpacityCanvas2d, { red: 127, green: 255, blue: 127, alpha: 255 }, 'ellipse single opacity');
  assertExpectedPixel(pathOpacityCanvas2d, { red: 255, green: 127, blue: 255, alpha: 255 }, 'path single opacity');

  setTestCase('canvas-layer-svg-arc-path-parity');
  const svgArcPathParityProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const transform = { rotation: 0, horzFlip: false, vertFlip: false };
    const tree = {
      pageWidth: 76,
      pageHeight: 42,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1916,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 1916,
        bounds: { x: 0, y: 0, width: 76, height: 42 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 76, height: 42 }, backgroundColor: '#ffffff', borderWidth: 0 },
          {
            type: 'path',
            bbox: { x: 6, y: 4, width: 64, height: 32 },
            commands: [
              { type: 'moveTo', x: 10, y: 28 },
              { type: 'arcTo', rx: 22, ry: 12, rotation: 18, largeArc: false, sweep: true, x: 54, y: 22 },
              { type: 'lineTo', x: 58, y: 34 },
              { type: 'lineTo', x: 10, y: 34 },
              { type: 'closePath' },
            ],
            style: {
              fillColor: '#d4efff',
              strokeColor: '#003366',
              strokeWidth: 1.2,
              strokeDash: 'solid',
              opacity: 1,
              pattern: null,
              shadow: null,
            },
            gradient: null,
            transform,
          },
        ],
      },
    };
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(!svgArcPathParityProbe.error, svgArcPathParityProbe.error || 'SVG arc path parity probe available');
  const svgArcPathCanvas2dInkPixels = countPixels(
    svgArcPathParityProbe.canvas2d,
    (pixel) => pixel.alpha > 32 && (pixel.red < 245 || pixel.green < 245 || pixel.blue < 245),
  );
  const svgArcPathCanvaskitInkPixels = countPixels(
    svgArcPathParityProbe.canvaskit,
    (pixel) => pixel.alpha > 32 && (pixel.red < 245 || pixel.green < 245 || pixel.blue < 245),
  );
  assert(
    svgArcPathCanvas2dInkPixels > 350 && svgArcPathCanvaskitInkPixels > 350,
    `SVG arc path replay draws geometry canvas2d=${svgArcPathCanvas2dInkPixels}, canvaskit=${svgArcPathCanvaskitInkPixels}`,
  );
  const svgArcPathDiff = await comparePngBuffers(
    pngBufferFromDataUrl(svgArcPathParityProbe.canvas2d),
    pngBufferFromDataUrl(svgArcPathParityProbe.canvaskit),
    {
      diffName: 'canvas-layer-svg-arc-path-parity',
      ignoreChannelDelta: 32,
      maxDiffRatio: 0.12,
      inkMaskMaxDiffRatio: 0.05,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    svgArcPathDiff.passed,
    `SVG arc path parity exact=${svgArcPathDiff.exactDiffPixels}, tolerant=${svgArcPathDiff.rawTolerantDiffPixels}, ink=${svgArcPathDiff.rawInkMaskDiffPixels}, max_channel_delta=${svgArcPathDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-initial-svg-arc-path-parity');
  const initialArcPathProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const tree = {
      pageWidth: 70,
      pageHeight: 40,
      profile: 'screen',
      resources: {
        tableId: 1917,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
      },
      root: {
        kind: 'leaf',
        sourceNodeId: 1917,
        bounds: { x: 0, y: 0, width: 70, height: 40 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 70, height: 40 }, backgroundColor: '#ffffff', borderWidth: 0 },
          {
            type: 'path',
            bbox: { x: 0, y: 0, width: 70, height: 40 },
            commands: [
              { type: 'arcTo', rx: 12, ry: 8, rotation: 0, largeArc: false, sweep: true, x: 20, y: 10 },
              { type: 'lineTo', x: 55, y: 30 },
            ],
            style: {
              fillColor: null,
              strokeColor: '#000000',
              strokeWidth: 2,
              strokeDash: 'solid',
              opacity: 1,
            },
            transform: { rotation: 0, horzFlip: false, vertFlip: false },
          },
        ],
      },
    };
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(
    !initialArcPathProbe.error,
    initialArcPathProbe.error || 'initial SVG arc path parity probe available',
  );
  const initialArcOriginInk = (dataUrl) => countPixels(
    dataUrl,
    (pixel) => pixel.x < 5
      && pixel.y < 5
      && pixel.alpha > 220
      && pixel.red < 180
      && pixel.green < 180
      && pixel.blue < 180,
  );
  assert(
    initialArcOriginInk(initialArcPathProbe.canvas2d) === 0
      && initialArcOriginInk(initialArcPathProbe.canvaskit) === 0,
    `initial SVG arc does not paint from an implicit origin canvas2d=${initialArcOriginInk(initialArcPathProbe.canvas2d)}, canvaskit=${initialArcOriginInk(initialArcPathProbe.canvaskit)}`,
  );
  const initialArcPathDiff = await comparePngBuffers(
    pngBufferFromDataUrl(initialArcPathProbe.canvas2d),
    pngBufferFromDataUrl(initialArcPathProbe.canvaskit),
    {
      diffName: 'canvas-layer-initial-svg-arc-path-parity',
      ignoreChannelDelta: 8,
      maxDiffRatio: 0.01,
      inkMaskMaxDiffRatio: 0.01,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    initialArcPathDiff.passed,
    `initial SVG arc path parity exact=${initialArcPathDiff.exactDiffPixels}, tolerant=${initialArcPathDiff.rawTolerantDiffPixels}, ink=${initialArcPathDiff.rawInkMaskDiffPixels}, max_channel_delta=${initialArcPathDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-initial-line-curve-path-parity');
  const initialLineCurvePathProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const pathStyle = (strokeColor) => ({
      fillColor: null,
      strokeColor,
      strokeWidth: 2,
      strokeDash: 'solid',
      opacity: 1,
    });
    const tree = {
      pageWidth: 70,
      pageHeight: 70,
      profile: 'screen',
      resources: {
        tableId: 1918,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
      },
      root: {
        kind: 'leaf',
        sourceNodeId: 1918,
        bounds: { x: 0, y: 0, width: 70, height: 70 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 70, height: 70 }, backgroundColor: '#ffffff', borderWidth: 0 },
          {
            type: 'path',
            bbox: { x: 0, y: 0, width: 70, height: 35 },
            commands: [
              { type: 'lineTo', x: 20, y: 10 },
              { type: 'lineTo', x: 55, y: 28 },
            ],
            style: pathStyle('#cc0000'),
            transform: { rotation: 0, horzFlip: false, vertFlip: false },
          },
          {
            type: 'path',
            bbox: { x: 0, y: 35, width: 70, height: 35 },
            commands: [
              { type: 'curveTo', x1: 18, y1: 48, x2: 42, y2: 34, x3: 55, y3: 60 },
            ],
            style: pathStyle('#0033cc'),
            transform: { rotation: 0, horzFlip: false, vertFlip: false },
          },
        ],
      },
    };
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(
    !initialLineCurvePathProbe.error,
    initialLineCurvePathProbe.error || 'initial line/curve path parity probe available',
  );
  const initialLineCurveOriginInk = (dataUrl) => countPixels(
    dataUrl,
    (pixel) => pixel.x < 8
      && pixel.y < 8
      && pixel.alpha > 220
      && (pixel.red < 180 || pixel.green < 180 || pixel.blue < 180),
  );
  assert(
    initialLineCurveOriginInk(initialLineCurvePathProbe.canvas2d) === 0
      && initialLineCurveOriginInk(initialLineCurvePathProbe.canvaskit) === 0,
    `initial line/curve paths do not paint from an implicit origin canvas2d=${initialLineCurveOriginInk(initialLineCurvePathProbe.canvas2d)}, canvaskit=${initialLineCurveOriginInk(initialLineCurvePathProbe.canvaskit)}`,
  );
  const initialLineCurvePathDiff = await comparePngBuffers(
    pngBufferFromDataUrl(initialLineCurvePathProbe.canvas2d),
    pngBufferFromDataUrl(initialLineCurvePathProbe.canvaskit),
    {
      diffName: 'canvas-layer-initial-line-curve-path-parity',
      ignoreChannelDelta: 24,
      maxDiffRatio: 0.02,
      inkMaskMaxDiffRatio: 0.02,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    initialLineCurvePathDiff.passed,
    `initial line/curve path parity exact=${initialLineCurvePathDiff.exactDiffPixels}, tolerant=${initialLineCurvePathDiff.rawTolerantDiffPixels}, ink=${initialLineCurvePathDiff.rawInkMaskDiffPixels}, max_channel_delta=${initialLineCurvePathDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-transformed-vector-parity');
  const transformedVectorParityProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const shapeStyle = (fillColor, strokeColor, strokeWidth = 2, strokeDash = 'dash') => ({
      fillColor,
      strokeColor,
      strokeWidth,
      strokeDash,
      opacity: 1,
      pattern: null,
      shadow: null,
    });
    const tree = {
      pageWidth: 104,
      pageHeight: 64,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1907,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 1907,
        bounds: { x: 0, y: 0, width: 104, height: 64 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 104, height: 64 }, backgroundColor: '#ffffff', borderWidth: 0 },
          {
            type: 'rectangle',
            bbox: { x: 7, y: 8, width: 24, height: 16 },
            cornerRadius: 0,
            style: shapeStyle('#f8c5d6', '#8a1740', 2, 'dash'),
            gradient: null,
            transform: { rotation: 18, horzFlip: true, vertFlip: false },
          },
          {
            type: 'ellipse',
            bbox: { x: 40, y: 8, width: 24, height: 16 },
            style: shapeStyle('#cdecc8', '#1f6a28', 2, 'dot'),
            gradient: null,
            transform: { rotation: -14, horzFlip: false, vertFlip: true },
          },
          {
            type: 'path',
            bbox: { x: 72, y: 7, width: 24, height: 18 },
            commands: [
              { type: 'moveTo', x: 74, y: 23 },
              { type: 'lineTo', x: 83, y: 8 },
              { type: 'curveTo', x1: 89, y1: 8, x2: 94, y2: 14, x3: 96, y3: 23 },
              { type: 'closePath' },
            ],
            style: shapeStyle('#ffe2aa', '#7a3b00', 2, 'dashDot'),
            gradient: null,
            transform: { rotation: 22, horzFlip: true, vertFlip: true },
          },
          {
            type: 'line',
            bbox: { x: 8, y: 36, width: 88, height: 18 },
            x1: 10,
            y1: 50,
            x2: 94,
            y2: 40,
            transform: { rotation: -4, horzFlip: false, vertFlip: false },
            style: {
              color: '#202020',
              width: 3,
              dash: 'dashDot',
              lineType: 'thinThickDouble',
              startArrow: 'diamond',
              endArrow: 'openCircle',
              startArrowSize: 1,
              endArrowSize: 1,
              shadow: null,
            },
          },
        ],
      },
    };
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(!transformedVectorParityProbe.error, transformedVectorParityProbe.error || 'transformed vector parity probe available');
  const transformedVectorCanvas2dInkPixels = countPixels(
    transformedVectorParityProbe.canvas2d,
    (pixel) => pixel.alpha > 32 && (pixel.red < 245 || pixel.green < 245 || pixel.blue < 245),
  );
  const transformedVectorCanvaskitInkPixels = countPixels(
    transformedVectorParityProbe.canvaskit,
    (pixel) => pixel.alpha > 32 && (pixel.red < 245 || pixel.green < 245 || pixel.blue < 245),
  );
  assert(
    transformedVectorCanvas2dInkPixels > 700 && transformedVectorCanvaskitInkPixels > 700,
    `transformed vector replay draws geometry canvas2d=${transformedVectorCanvas2dInkPixels}, canvaskit=${transformedVectorCanvaskitInkPixels}`,
  );
  const transformedVectorDiff = await comparePngBuffers(
    pngBufferFromDataUrl(transformedVectorParityProbe.canvas2d),
    pngBufferFromDataUrl(transformedVectorParityProbe.canvaskit),
    {
      diffName: 'canvas-layer-transformed-vector-parity',
      ignoreChannelDelta: 32,
      maxDiffRatio: 0.14,
      inkMaskMaxDiffRatio: 0.1,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    transformedVectorDiff.passed,
    `transformed vector parity exact=${transformedVectorDiff.exactDiffPixels}, tolerant=${transformedVectorDiff.rawTolerantDiffPixels}, ink=${transformedVectorDiff.rawInkMaskDiffPixels}, max_channel_delta=${transformedVectorDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-line-arrow-variant-parity');
  const lineArrowVariantParityProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const line = (x1, y1, x2, y2, startArrow, endArrow, dash = 'solid', lineType = 'single') => ({
      type: 'line',
      bbox: {
        x: Math.min(x1, x2) - 8,
        y: Math.min(y1, y2) - 8,
        width: Math.abs(x2 - x1) + 16,
        height: Math.abs(y2 - y1) + 16,
      },
      x1,
      y1,
      x2,
      y2,
      transform: { rotation: 0, horzFlip: false, vertFlip: false },
      style: {
        color: '#202020',
        width: 3,
        dash,
        lineType,
        startArrow,
        endArrow,
        startArrowSize: 2,
        endArrowSize: 2,
        shadow: null,
      },
    });
    const tree = {
      pageWidth: 160,
      pageHeight: 72,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1908,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 1908,
        bounds: { x: 0, y: 0, width: 160, height: 72 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 160, height: 72 }, backgroundColor: '#ffffff', borderWidth: 0 },
          line(16, 14, 68, 14, 'arrow', 'concaveArrow'),
          line(94, 14, 144, 14, 'openDiamond', 'circle', 'dash'),
          line(16, 38, 68, 56, 'square', 'openSquare', 'dot'),
          line(94, 56, 144, 38, 'arrow', 'openDiamond', 'dashDot', 'thinThickThinTriple'),
        ],
      },
    };
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(
    !lineArrowVariantParityProbe.error,
    lineArrowVariantParityProbe.error || 'line arrow variant parity probe available',
  );
  const lineArrowCanvas2dInkPixels = countPixels(
    lineArrowVariantParityProbe.canvas2d,
    (pixel) => pixel.alpha > 32 && (pixel.red < 245 || pixel.green < 245 || pixel.blue < 245),
  );
  const lineArrowCanvaskitInkPixels = countPixels(
    lineArrowVariantParityProbe.canvaskit,
    (pixel) => pixel.alpha > 32 && (pixel.red < 245 || pixel.green < 245 || pixel.blue < 245),
  );
  assert(
    lineArrowCanvas2dInkPixels > 450 && lineArrowCanvaskitInkPixels > 450,
    `line arrow variants replay geometry canvas2d=${lineArrowCanvas2dInkPixels}, canvaskit=${lineArrowCanvaskitInkPixels}`,
  );
  const lineArrowDiff = await comparePngBuffers(
    pngBufferFromDataUrl(lineArrowVariantParityProbe.canvas2d),
    pngBufferFromDataUrl(lineArrowVariantParityProbe.canvaskit),
    {
      diffName: 'canvas-layer-line-arrow-variant-parity',
      ignoreChannelDelta: 32,
      maxDiffRatio: 0.12,
      inkMaskMaxDiffRatio: 0.08,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    lineArrowDiff.passed,
    `line arrow variant parity exact=${lineArrowDiff.exactDiffPixels}, tolerant=${lineArrowDiff.rawTolerantDiffPixels}, ink=${lineArrowDiff.rawInkMaskDiffPixels}, max_channel_delta=${lineArrowDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-path-connector-arrow-parity');
  const pathConnectorArrowProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const connector = (offsetY, startArrow, endArrow) => ({
      type: 'path',
      bbox: { x: 6, y: offsetY, width: 100, height: 44 },
      commands: [
        { type: 'moveTo', x: 20, y: offsetY + 22 },
        {
          type: 'curveTo',
          x1: 20,
          y1: offsetY + 5,
          x2: 90,
          y2: offsetY + 39,
          x3: 90,
          y3: offsetY + 22,
        },
      ],
      style: {
        fillColor: null,
        strokeColor: '#7c2d12',
        strokeWidth: 3,
        strokeDash: 'solid',
        opacity: 1,
        pattern: null,
        shadow: null,
      },
      gradient: null,
      connectorEndpoints: {
        x1: 20,
        y1: offsetY + 22,
        x2: 90,
        y2: offsetY + 22,
      },
      lineStyle: {
        color: '#7c2d12',
        width: 3,
        dash: 'solid',
        lineType: 'single',
        startArrow,
        endArrow,
        startArrowSize: 8,
        endArrowSize: 8,
        shadow: null,
      },
      transform: { rotation: 0, horzFlip: false, vertFlip: false },
    });
    const tree = {
      pageWidth: 112,
      pageHeight: 100,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1974,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 1974,
        bounds: { x: 0, y: 0, width: 112, height: 100 },
        cacheHint: 'none',
        ops: [
          {
            type: 'pageBackground',
            bbox: { x: 0, y: 0, width: 112, height: 100 },
            backgroundColor: '#ffffff',
            borderWidth: 0,
          },
          connector(0, 'diamond', 'openCircle'),
          connector(50, 'none', 'none'),
        ],
      },
    };
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(
    !pathConnectorArrowProbe.error,
    pathConnectorArrowProbe.error || 'path connector arrow parity probe available',
  );
  for (const [backend, dataUrl] of [
    ['canvas2d', pathConnectorArrowProbe.canvas2d],
    ['canvaskit', pathConnectorArrowProbe.canvaskit],
  ]) {
    const regionInk = (left, top, right, bottom) => countPixels(
      dataUrl,
      (pixel) =>
        pixel.x >= left
        && pixel.x < right
        && pixel.y >= top
        && pixel.y < bottom
        && pixel.alpha > 32
        && (pixel.red < 220 || pixel.green < 220 || pixel.blue < 220),
    );
    const arrowStartInk = regionInk(10, 2, 31, 24);
    const controlStartInk = regionInk(10, 52, 31, 74);
    const arrowEndInk = regionInk(79, 20, 101, 43);
    const controlEndInk = regionInk(79, 70, 101, 93);
    assert(
      arrowStartInk > controlStartInk + 12,
      `${backend} path connector start arrow follows the first cubic tangent arrow=${arrowStartInk}, control=${controlStartInk}`,
    );
    assert(
      arrowEndInk > controlEndInk + 6,
      `${backend} path connector end arrow follows the last cubic tangent arrow=${arrowEndInk}, control=${controlEndInk}`,
    );
  }
  const pathConnectorArrowDiff = await comparePngBuffers(
    pngBufferFromDataUrl(pathConnectorArrowProbe.canvas2d),
    pngBufferFromDataUrl(pathConnectorArrowProbe.canvaskit),
    {
      diffName: 'canvas-layer-path-connector-arrow-parity',
      ignoreChannelDelta: 32,
      maxDiffRatio: 0.05,
      inkMaskMaxDiffRatio: 0.03,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    pathConnectorArrowDiff.passed,
    `path connector arrow parity exact=${pathConnectorArrowDiff.exactDiffPixels}, tolerant=${pathConnectorArrowDiff.rawTolerantDiffPixels}, ink=${pathConnectorArrowDiff.rawInkMaskDiffPixels}, max_channel_delta=${pathConnectorArrowDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-rounded-rectangle-parity');
  const roundedRectangleProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const rectangle = (bbox, cornerRadius, fillColor, strokeColor, shadow = null) => ({
      type: 'rectangle',
      bbox,
      cornerRadius,
      style: {
        fillColor,
        strokeColor,
        strokeWidth: 2,
        strokeDash: 'solid',
        opacity: 1,
        pattern: null,
        shadow,
      },
      gradient: null,
      transform: { rotation: 0, horzFlip: false, vertFlip: false },
    });
    const tree = {
      pageWidth: 128,
      pageHeight: 48,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1975,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 1975,
        bounds: { x: 0, y: 0, width: 128, height: 48 },
        cacheHint: 'none',
        ops: [
          {
            type: 'pageBackground',
            bbox: { x: 0, y: 0, width: 128, height: 48 },
            backgroundColor: '#ffffff',
            borderWidth: 0,
          },
          rectangle(
            { x: 6, y: 8, width: 32, height: 28 },
            7,
            '#ef4444',
            '#7f1d1d',
          ),
          rectangle(
            { x: 48, y: 8, width: 32, height: 28 },
            100,
            '#3b82f6',
            '#1e3a8a',
          ),
          rectangle(
            { x: 90, y: 8, width: 28, height: 26 },
            100,
            '#22c55e',
            '#14532d',
            {
              shadowType: 1,
              color: '#111111',
              offsetX: 3,
              offsetY: 3,
              alpha: 96,
            },
          ),
        ],
      },
    };
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(
    !roundedRectangleProbe.error,
    roundedRectangleProbe.error || 'rounded rectangle parity probe available',
  );
  for (const [backend, dataUrl] of [
    ['canvas2d', roundedRectangleProbe.canvas2d],
    ['canvaskit', roundedRectangleProbe.canvaskit],
  ]) {
    const normalCorner = pixelAt(dataUrl, 6, 8);
    const oversizedCorner = pixelAt(dataUrl, 48, 8);
    const normalFillPixels = countPixels(
      dataUrl,
      (pixel) =>
        pixel.x >= 6
        && pixel.x < 38
        && pixel.y >= 8
        && pixel.y < 36
        && pixel.red > 160
        && pixel.green < 120
        && pixel.blue < 120,
    );
    const oversizedFillPixels = countPixels(
      dataUrl,
      (pixel) =>
        pixel.x >= 48
        && pixel.x < 80
        && pixel.y >= 8
        && pixel.y < 36
        && pixel.blue > 140
        && pixel.red < 120
        && pixel.green > 70,
    );
    assert(
      normalCorner.red > 245 && normalCorner.green > 245 && normalCorner.blue > 245,
      `${backend} normal rounded rectangle leaves its square corner clear=${JSON.stringify(normalCorner)}`,
    );
    assert(
      oversizedCorner.red > 245 && oversizedCorner.green > 245 && oversizedCorner.blue > 245,
      `${backend} oversized rounded rectangle clamps to a clear pill corner=${JSON.stringify(oversizedCorner)}`,
    );
    assert(
      normalFillPixels > 500 && oversizedFillPixels > 450,
      `${backend} rounded rectangle fill remains visible normal=${normalFillPixels}, oversized=${oversizedFillPixels}`,
    );
  }
  const roundedRectangleDiff = await comparePngBuffers(
    pngBufferFromDataUrl(roundedRectangleProbe.canvas2d),
    pngBufferFromDataUrl(roundedRectangleProbe.canvaskit),
    {
      diffName: 'canvas-layer-rounded-rectangle-parity',
      ignoreChannelDelta: 32,
      maxDiffRatio: 0.08,
      inkMaskMaxDiffRatio: 0.05,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    roundedRectangleDiff.passed,
    `rounded rectangle parity exact=${roundedRectangleDiff.exactDiffPixels}, tolerant=${roundedRectangleDiff.rawTolerantDiffPixels}, ink=${roundedRectangleDiff.rawInkMaskDiffPixels}, max_channel_delta=${roundedRectangleDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-line-shadow-dash-parity');
  const lineShadowDashProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const line = (y, dash, lineType = 'single') => ({
      type: 'line',
      bbox: { x: 4, y: y - 4, width: 78, height: 10 },
      x1: 7,
      y1: y,
      x2: 78,
      y2: y,
      transform: { rotation: 0, horzFlip: false, vertFlip: false },
      style: {
        color: '#222222',
        width: 3,
        dash,
        lineType,
        startArrow: 'none',
        endArrow: 'none',
        startArrowSize: 1,
        endArrowSize: 1,
        shadow: {
          color: '#008800',
          alpha: 0,
          offsetX: 3,
          offsetY: 3,
        },
      },
    });
    const tree = {
      pageWidth: 88,
      pageHeight: 44,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 19101,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 19101,
        bounds: { x: 0, y: 0, width: 88, height: 44 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 88, height: 44 }, backgroundColor: '#ffffff', borderWidth: 0 },
          line(10, 'dash'),
          line(22, 'dot'),
          line(34, 'dashDot', 'double'),
        ],
      },
    };
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(
    !lineShadowDashProbe.error,
    lineShadowDashProbe.error || 'line shadow dash parity probe available',
  );
  const lineShadowCanvas2dGreenPixels = countPixels(
    lineShadowDashProbe.canvas2d,
    (pixel) => pixel.alpha > 32 && pixel.green > 70 && pixel.red < 120 && pixel.blue < 120,
  );
  const lineShadowCanvaskitGreenPixels = countPixels(
    lineShadowDashProbe.canvaskit,
    (pixel) => pixel.alpha > 32 && pixel.green > 70 && pixel.red < 120 && pixel.blue < 120,
  );
  assert(
    lineShadowCanvas2dGreenPixels > 80 && lineShadowCanvaskitGreenPixels > 80,
    `line shadow dash replay draws shadows canvas2d=${lineShadowCanvas2dGreenPixels}, canvaskit=${lineShadowCanvaskitGreenPixels}`,
  );
  const lineShadowDashDiff = await comparePngBuffers(
    pngBufferFromDataUrl(lineShadowDashProbe.canvas2d),
    pngBufferFromDataUrl(lineShadowDashProbe.canvaskit),
    {
      diffName: 'canvas-layer-line-shadow-dash-parity',
      ignoreChannelDelta: 48,
      maxDiffRatio: 0.18,
      inkMaskMaxDiffRatio: 0.12,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    lineShadowDashDiff.passed,
    `line shadow dash parity exact=${lineShadowDashDiff.exactDiffPixels}, tolerant=${lineShadowDashDiff.rawTolerantDiffPixels}, ink=${lineShadowDashDiff.rawInkMaskDiffPixels}, max_channel_delta=${lineShadowDashDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-unknown-dash-solid-fallback-parity');
  const unknownDashFallbackProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const tree = {
      pageWidth: 84,
      pageHeight: 40,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 19102,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 19102,
        bounds: { x: 0, y: 0, width: 84, height: 40 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 84, height: 40 }, backgroundColor: '#ffffff', borderWidth: 0 },
          {
            type: 'line',
            bbox: { x: 4, y: 5, width: 76, height: 10 },
            x1: 8,
            y1: 10,
            x2: 76,
            y2: 10,
            transform: { rotation: 0, horzFlip: false, vertFlip: false },
            style: {
              color: '#202020',
              width: 4,
              dash: 'legacyUnknown',
              lineType: 'single',
              startArrow: 'none',
              endArrow: 'none',
              startArrowSize: 1,
              endArrowSize: 1,
            },
          },
          {
            type: 'rectangle',
            bbox: { x: 10, y: 20, width: 64, height: 12 },
            cornerRadius: 0,
            transform: { rotation: 0, horzFlip: false, vertFlip: false },
            style: {
              fillColor: null,
              strokeColor: '#202020',
              strokeWidth: 3,
              strokeDash: 'legacyUnknown',
              opacity: 1,
            },
          },
        ],
      },
    };
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(
    !unknownDashFallbackProbe.error,
    unknownDashFallbackProbe.error || 'unknown dash solid fallback parity probe available',
  );
  const unknownDashCanvas2dDarkPixels = countPixels(
    unknownDashFallbackProbe.canvas2d,
    (pixel) => pixel.alpha > 32 && pixel.red < 100 && pixel.green < 100 && pixel.blue < 100,
  );
  const unknownDashCanvaskitDarkPixels = countPixels(
    unknownDashFallbackProbe.canvaskit,
    (pixel) => pixel.alpha > 32 && pixel.red < 100 && pixel.green < 100 && pixel.blue < 100,
  );
  assert(
    unknownDashCanvas2dDarkPixels > 300
      && unknownDashCanvaskitDarkPixels > 300
      && Math.abs(unknownDashCanvas2dDarkPixels - unknownDashCanvaskitDarkPixels) < 90,
    `unknown dash falls back to solid canvas2d=${unknownDashCanvas2dDarkPixels}, canvaskit=${unknownDashCanvaskitDarkPixels}`,
  );
  const unknownDashFallbackDiff = await comparePngBuffers(
    pngBufferFromDataUrl(unknownDashFallbackProbe.canvas2d),
    pngBufferFromDataUrl(unknownDashFallbackProbe.canvaskit),
    {
      diffName: 'canvas-layer-unknown-dash-solid-fallback-parity',
      ignoreChannelDelta: 48,
      maxDiffRatio: 0.12,
      inkMaskMaxDiffRatio: 0.05,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    unknownDashFallbackDiff.passed,
    `unknown dash solid fallback parity exact=${unknownDashFallbackDiff.exactDiffPixels}, tolerant=${unknownDashFallbackDiff.rawTolerantDiffPixels}, ink=${unknownDashFallbackDiff.rawInkMaskDiffPixels}, max_channel_delta=${unknownDashFallbackDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-compound-line-thin-stroke-parity');
  const compoundLineThinStrokeProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const tree = {
      pageWidth: 64,
      pageHeight: 32,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1911,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 1911,
        bounds: { x: 0, y: 0, width: 64, height: 32 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 64, height: 32 }, backgroundColor: '#ffffff', borderWidth: 0 },
          {
            type: 'line',
            bbox: { x: 4, y: 10, width: 56, height: 12 },
            x1: 8,
            y1: 16,
            x2: 56,
            y2: 16,
            transform: { rotation: 0, horzFlip: false, vertFlip: false },
            style: {
              color: '#000000',
              width: 0.6,
              dash: 'solid',
              lineType: 'thinThickThinTriple',
              startArrow: 'none',
              endArrow: 'none',
              startArrowSize: 1,
              endArrowSize: 1,
              shadow: null,
            },
          },
        ],
      },
    };
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(
    !compoundLineThinStrokeProbe.error,
    compoundLineThinStrokeProbe.error || 'compound line thin stroke parity probe available',
  );
  const measureCompoundLineDarkness = (dataUrl) => {
    const png = PNG.sync.read(pngBufferFromDataUrl(dataUrl));
    let totalDarkness = 0;
    let samples = 0;
    for (let y = 14; y <= 18; y += 1) {
      for (let x = 8; x <= 56; x += 1) {
        const offset = (y * png.width + x) * 4;
        const alpha = png.data[offset + 3] / 255;
        const luma = (png.data[offset] + png.data[offset + 1] + png.data[offset + 2]) / 3;
        totalDarkness += (255 - luma) * alpha;
        samples += 1;
      }
    }
    return totalDarkness / samples;
  };
  const compoundLineCanvas2dDarkness = measureCompoundLineDarkness(compoundLineThinStrokeProbe.canvas2d);
  const compoundLineCanvaskitDarkness = measureCompoundLineDarkness(compoundLineThinStrokeProbe.canvaskit);
  assert(
    compoundLineCanvas2dDarkness > 8 && compoundLineCanvaskitDarkness >= compoundLineCanvas2dDarkness * 0.6,
    `compound line thin stroke parity canvas2d=${compoundLineCanvas2dDarkness.toFixed(2)}, canvaskit=${compoundLineCanvaskitDarkness.toFixed(2)}`,
  );

  setTestCase('canvas-layer-compound-line-variant-parity');
  const compoundLineVariantProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const line = (y, lineType, color) => ({
      type: 'line',
      bbox: { x: 4, y: y - 8, width: 104, height: 16 },
      x1: 10,
      y1: y,
      x2: 102,
      y2: y,
      transform: { rotation: 0, horzFlip: false, vertFlip: false },
      style: {
        color,
        width: 5,
        dash: 'solid',
        lineType,
        startArrow: 'none',
        endArrow: 'none',
        startArrowSize: 1,
        endArrowSize: 1,
        shadow: null,
      },
    });
    const tree = {
      pageWidth: 112,
      pageHeight: 76,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 19111,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 19111,
        bounds: { x: 0, y: 0, width: 112, height: 76 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 112, height: 76 }, backgroundColor: '#ffffff', borderWidth: 0 },
          line(12, 'double', '#202020'),
          line(28, 'thickThinDouble', '#0040cc'),
          line(44, 'thinThickDouble', '#cc4400'),
          line(60, 'thinThickThinTriple', '#008000'),
        ],
      },
    };
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(
    !compoundLineVariantProbe.error,
    compoundLineVariantProbe.error || 'compound line variant parity probe available',
  );
  const measureCompoundVariantRows = (dataUrl) => {
    const png = PNG.sync.read(pngBufferFromDataUrl(dataUrl));
    const rows = [12, 28, 44, 60];
    return rows.map((centerY) => {
      let darkPixels = 0;
      for (let y = centerY - 5; y <= centerY + 5; y += 1) {
        for (let x = 8; x <= 104; x += 1) {
          const offset = (y * png.width + x) * 4;
          if (
            png.data[offset + 3] > 32
            && (png.data[offset] < 230 || png.data[offset + 1] < 230 || png.data[offset + 2] < 230)
          ) {
            darkPixels += 1;
          }
        }
      }
      return darkPixels;
    });
  };
  const compoundVariantCanvas2dRows = measureCompoundVariantRows(compoundLineVariantProbe.canvas2d);
  const compoundVariantCanvaskitRows = measureCompoundVariantRows(compoundLineVariantProbe.canvaskit);
  assert(
    compoundVariantCanvas2dRows.every((pixels) => pixels > 180)
      && compoundVariantCanvaskitRows.every((pixels) => pixels > 180),
    `compound line variants draw every row canvas2d=${compoundVariantCanvas2dRows.join(',')}, canvaskit=${compoundVariantCanvaskitRows.join(',')}`,
  );
  const compoundLineVariantDiff = await comparePngBuffers(
    pngBufferFromDataUrl(compoundLineVariantProbe.canvas2d),
    pngBufferFromDataUrl(compoundLineVariantProbe.canvaskit),
    {
      diffName: 'canvas-layer-compound-line-variant-parity',
      ignoreChannelDelta: 40,
      maxDiffRatio: 0.14,
      inkMaskMaxDiffRatio: 0.08,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    compoundLineVariantDiff.passed,
    `compound line variant parity exact=${compoundLineVariantDiff.exactDiffPixels}, tolerant=${compoundLineVariantDiff.rawTolerantDiffPixels}, ink=${compoundLineVariantDiff.rawInkMaskDiffPixels}, max_channel_delta=${compoundLineVariantDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-gradient-pattern-parity');
  const gradientPatternParityProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const transform = { rotation: 0, horzFlip: false, vertFlip: false };
    const style = (fillColor, strokeColor, pattern = null) => ({
      fillColor,
      strokeColor,
      strokeWidth: 1,
      strokeDash: 'solid',
      opacity: 1,
      pattern,
      shadow: null,
    });
    const tree = {
      pageWidth: 104,
      pageHeight: 82,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1908,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 1908,
        bounds: { x: 0, y: 0, width: 104, height: 82 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 104, height: 82 }, backgroundColor: '#ffffff', borderWidth: 0 },
          {
            type: 'rectangle',
            bbox: { x: 5, y: 6, width: 28, height: 18 },
            cornerRadius: 0,
            style: style(null, '#49235c'),
            gradient: {
              gradientType: 0,
              angle: 20,
              centerX: 50,
              centerY: 50,
              colors: ['red', 'hwb(52deg 42% 0%)', '#4878ff'],
              positions: [0, 0.55, 1],
            },
            transform,
          },
          {
            type: 'ellipse',
            bbox: { x: 40, y: 6, width: 28, height: 18 },
            style: style(null, '#245714'),
            gradient: {
              gradientType: 2,
              angle: 0,
              centerX: 45,
              centerY: 45,
              colors: ['white', 'oklch(0.75 0.12 145deg)', 'green'],
              positions: [0, 0.45, 1],
            },
            transform,
          },
          {
            type: 'path',
            bbox: { x: 74, y: 5, width: 24, height: 20 },
            commands: [
              { type: 'moveTo', x: 75, y: 23 },
              { type: 'lineTo', x: 84, y: 6 },
              { type: 'lineTo', x: 97, y: 22 },
              { type: 'closePath' },
            ],
            style: style('lab(94% 0 14)', 'lch(35% 47 62deg)', {
              patternType: 4,
              patternColor: 'rebeccapurple',
              backgroundColor: 'lch(92% 20 87deg)',
            }),
            gradient: null,
            transform,
          },
          {
            type: 'rectangle',
            bbox: { x: 18, y: 33, width: 68, height: 12 },
            cornerRadius: 0,
            style: style('#f6f6f6', '#333333', {
              patternType: 5,
              patternColor: 'oklab(0.25 0 0)',
              backgroundColor: 'color(srgb 0.9647058824 0.9647058824 0.9647058824)',
            }),
            gradient: null,
            transform,
          },
          {
            type: 'rectangle',
            bbox: { x: 5, y: 57, width: 26, height: 18 },
            cornerRadius: 0,
            style: style('#008577', null, {
              patternType: 5,
              patternColor: '#7b1fa2',
              backgroundColor: '#fff59d',
            }),
            gradient: {
              gradientType: 0,
              angle: 0,
              centerX: 50,
              centerY: 50,
              colors: [],
              positions: [],
            },
            transform,
          },
          {
            type: 'rectangle',
            bbox: { x: 39, y: 57, width: 26, height: 18 },
            cornerRadius: 0,
            style: style('#d84315', null, {
              patternType: 1,
              patternColor: '#1565c0',
              backgroundColor: '#ffccbc',
            }),
            gradient: {
              gradientType: 0,
              angle: 0,
              centerX: 50,
              centerY: 50,
              colors: ['#ff0000'],
              positions: [0],
            },
            transform,
          },
          {
            type: 'rectangle',
            bbox: { x: 73, y: 57, width: 26, height: 18 },
            cornerRadius: 0,
            style: style('#2e7d32', null),
            gradient: {
              gradientType: 0,
              angle: 0,
              centerX: 50,
              centerY: 50,
              colors: ['#ff0000'],
              positions: [0],
            },
            transform,
          },
        ],
      },
    };
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(!gradientPatternParityProbe.error, gradientPatternParityProbe.error || 'gradient/pattern parity probe available');
  const gradientPatternCanvas2dInkPixels = countPixels(
    gradientPatternParityProbe.canvas2d,
    (pixel) => pixel.alpha > 32 && (pixel.red < 245 || pixel.green < 245 || pixel.blue < 245),
  );
  const gradientPatternCanvaskitInkPixels = countPixels(
    gradientPatternParityProbe.canvaskit,
    (pixel) => pixel.alpha > 32 && (pixel.red < 245 || pixel.green < 245 || pixel.blue < 245),
  );
  const gradientPatternCanvas2dPurplePixels = countPixels(
    gradientPatternParityProbe.canvas2d,
    (pixel) => pixel.alpha > 32 && pixel.red > 70 && pixel.red < 140 && pixel.green < 80 && pixel.blue > 110 && pixel.blue < 190,
  );
  const gradientPatternCanvaskitPurplePixels = countPixels(
    gradientPatternParityProbe.canvaskit,
    (pixel) => pixel.alpha > 32 && pixel.red > 70 && pixel.red < 140 && pixel.green < 80 && pixel.blue > 110 && pixel.blue < 190,
  );
  assert(
    gradientPatternCanvas2dInkPixels > 1000 && gradientPatternCanvaskitInkPixels > 1000,
    `gradient/pattern replay draws geometry canvas2d=${gradientPatternCanvas2dInkPixels}, canvaskit=${gradientPatternCanvaskitInkPixels}`,
  );
  assert(
    gradientPatternCanvas2dPurplePixels > 10 && gradientPatternCanvaskitPurplePixels > 10,
    `gradient/pattern replay honors full CSS named pattern color canvas2d=${gradientPatternCanvas2dPurplePixels}, canvaskit=${gradientPatternCanvaskitPurplePixels}`,
  );
  for (const [name, predicate] of [
    ['empty-gradient pattern fallback', (pixel) =>
      pixel.y >= 57
      && pixel.x >= 5
      && pixel.x < 31
      && pixel.red > 80
      && pixel.red < 160
      && pixel.green < 80
      && pixel.blue > 120],
    ['single-stop pattern fallback', (pixel) =>
      pixel.y >= 57
      && pixel.x >= 39
      && pixel.x < 65
      && pixel.red > 180
      && pixel.green > 120
      && pixel.green < 230
      && pixel.blue > 100
      && pixel.blue < 230],
    ['single-stop solid fallback', (pixel) =>
      pixel.y >= 57
      && pixel.x >= 73
      && pixel.x < 99
      && pixel.green > 80
      && pixel.red < 100
      && pixel.blue < 100],
  ]) {
    const canvas2dPixels = countPixels(gradientPatternParityProbe.canvas2d, predicate);
    const canvaskitPixels = countPixels(gradientPatternParityProbe.canvaskit, predicate);
    assert(
      canvas2dPixels > 20 && canvaskitPixels > 20,
      `gradient/pattern replay preserves ${name} canvas2d=${canvas2dPixels}, canvaskit=${canvaskitPixels}`,
    );
  }
  const gradientPatternDiff = await comparePngBuffers(
    pngBufferFromDataUrl(gradientPatternParityProbe.canvas2d),
    pngBufferFromDataUrl(gradientPatternParityProbe.canvaskit),
    {
      diffName: 'canvas-layer-gradient-pattern-parity',
      ignoreChannelDelta: 24,
      maxDiffRatio: 0.12,
      inkMaskMaxDiffRatio: 0.08,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    gradientPatternDiff.passed,
    `gradient/pattern parity exact=${gradientPatternDiff.exactDiffPixels}, tolerant=${gradientPatternDiff.rawTolerantDiffPixels}, ink=${gradientPatternDiff.rawInkMaskDiffPixels}, max_channel_delta=${gradientPatternDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-sparse-gradient-stop-parity');
  const sparseGradientStopParityProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const tree = {
      pageWidth: 72,
      pageHeight: 40,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1911,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 1911,
        bounds: { x: 0, y: 0, width: 72, height: 40 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 72, height: 40 }, backgroundColor: '#ffffff', borderWidth: 0 },
          {
            type: 'rectangle',
            bbox: { x: 6, y: 6, width: 60, height: 12 },
            cornerRadius: 0,
            style: {
              fillColor: null,
              strokeColor: '#202020',
              strokeWidth: 1,
              strokeDash: 'solid',
              opacity: 1,
              pattern: null,
              shadow: null,
            },
            gradient: {
              gradientType: 0,
              angle: 90,
              centerX: 50,
              centerY: 50,
              colors: ['#ee3333', '#33aa55', '#3344ee'],
              positions: [0, 1],
            },
            transform: { rotation: 0, horzFlip: false, vertFlip: false },
          },
          {
            type: 'ellipse',
            bbox: { x: 20, y: 23, width: 32, height: 10 },
            style: {
              fillColor: null,
              strokeColor: '#202020',
              strokeWidth: 1,
              strokeDash: 'solid',
              opacity: 1,
              pattern: null,
              shadow: null,
            },
            gradient: {
              gradientType: 2,
              angle: 0,
              centerX: 50,
              centerY: 50,
              colors: ['#fff0f0', '#ffaa33', '#2255dd'],
              positions: [0, 1],
            },
            transform: { rotation: 0, horzFlip: false, vertFlip: false },
          },
        ],
      },
    };
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await nextFrame();
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(
    !sparseGradientStopParityProbe.error,
    sparseGradientStopParityProbe.error || 'sparse gradient stop parity probe available',
  );
  const sparseGradientStopCanvas2dBluePixels = countPixels(
    sparseGradientStopParityProbe.canvas2d,
    (pixel) => pixel.alpha > 32 && pixel.blue > 120 && pixel.red < 120,
  );
  const sparseGradientStopCanvaskitBluePixels = countPixels(
    sparseGradientStopParityProbe.canvaskit,
    (pixel) => pixel.alpha > 32 && pixel.blue > 120 && pixel.red < 120,
  );
  assert(
    sparseGradientStopCanvas2dBluePixels > 60 && sparseGradientStopCanvaskitBluePixels > 60,
    `sparse gradient stops materialize missing stop positions canvas2d=${sparseGradientStopCanvas2dBluePixels}, canvaskit=${sparseGradientStopCanvaskitBluePixels}`,
  );
  const sparseGradientStopDiff = await comparePngBuffers(
    pngBufferFromDataUrl(sparseGradientStopParityProbe.canvas2d),
    pngBufferFromDataUrl(sparseGradientStopParityProbe.canvaskit),
    {
      diffName: 'canvas-layer-sparse-gradient-stop-parity',
      ignoreChannelDelta: 24,
      maxDiffRatio: 0.12,
      inkMaskMaxDiffRatio: 0.08,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    sparseGradientStopDiff.passed,
    `sparse gradient stop parity exact=${sparseGradientStopDiff.exactDiffPixels}, tolerant=${sparseGradientStopDiff.rawTolerantDiffPixels}, ink=${sparseGradientStopDiff.rawInkMaskDiffPixels}, max_channel_delta=${sparseGradientStopDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-page-background-parity');
  const pageBackgroundParityProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = 8;
    sourceCanvas.height = 6;
    const sourceCtx = sourceCanvas.getContext('2d');
    if (!sourceCtx) {
      return { error: 'source canvas unavailable' };
    }
    sourceCtx.fillStyle = '#173f8f';
    sourceCtx.fillRect(0, 0, 8, 6);
    sourceCtx.fillStyle = '#f2d04f';
    sourceCtx.fillRect(1, 1, 6, 1);
    sourceCtx.fillRect(1, 4, 6, 1);
    sourceCtx.fillStyle = '#ffffff';
    sourceCtx.fillRect(3, 2, 2, 2);
    const base64 = sourceCanvas.toDataURL('image/png').split(',')[1];
    const tree = {
      pageWidth: 64,
      pageHeight: 40,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1909,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 1909,
        bounds: { x: 0, y: 0, width: 64, height: 40 },
        cacheHint: 'none',
        ops: [{
          type: 'pageBackground',
          bbox: { x: 0, y: 0, width: 64, height: 40 },
          backgroundColor: '#ffffff',
          borderColor: '#1b1b1b',
          borderWidth: 1,
          gradient: {
            gradientType: 0,
            angle: 90,
            centerX: 50,
            centerY: 50,
            colors: ['#fff6d0', '#cfe9ff'],
            positions: [0, 1],
          },
          image: {
            fillMode: 'tileHorzTop',
            base64,
          },
        }],
      },
    };
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return { error: 'target canvas unavailable' };
      }
      for (let attempt = 0; attempt < 8; attempt += 1) {
        renderer.renderPage(tree, canvas, 1);
        await nextFrame();
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let bluePixels = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index + 3] > 32 && pixels[index] < 80 && pixels[index + 1] < 120 && pixels[index + 2] > 120) {
            bluePixels += 1;
          }
        }
        if (bluePixels > 150) {
          break;
        }
      }
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(!pageBackgroundParityProbe.error, pageBackgroundParityProbe.error || 'page background parity probe available');
  const pageBackgroundCanvas2dBluePixels = countPixels(
    pageBackgroundParityProbe.canvas2d,
    (pixel) => pixel.alpha > 32 && pixel.red < 80 && pixel.green < 120 && pixel.blue > 120,
  );
  const pageBackgroundCanvaskitBluePixels = countPixels(
    pageBackgroundParityProbe.canvaskit,
    (pixel) => pixel.alpha > 32 && pixel.red < 80 && pixel.green < 120 && pixel.blue > 120,
  );
  assert(
    pageBackgroundCanvas2dBluePixels > 150 && pageBackgroundCanvaskitBluePixels > 150,
    `page background replay draws tiled image canvas2d=${pageBackgroundCanvas2dBluePixels}, canvaskit=${pageBackgroundCanvaskitBluePixels}`,
  );
  const pageBackgroundDiff = await comparePngBuffers(
    pngBufferFromDataUrl(pageBackgroundParityProbe.canvas2d),
    pngBufferFromDataUrl(pageBackgroundParityProbe.canvaskit),
    {
      diffName: 'canvas-layer-page-background-parity',
      ignoreChannelDelta: 24,
      maxDiffRatio: 0.08,
      inkMaskMaxDiffRatio: 0.04,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    pageBackgroundDiff.passed,
    `page background parity exact=${pageBackgroundDiff.exactDiffPixels}, tolerant=${pageBackgroundDiff.rawTolerantDiffPixels}, ink=${pageBackgroundDiff.rawInkMaskDiffPixels}, max_channel_delta=${pageBackgroundDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-page-background-gradient-parity');
  const pageBackgroundGradientProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const tree = {
      pageWidth: 72,
      pageHeight: 48,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1937,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 1937,
        bounds: { x: 0, y: 0, width: 72, height: 48 },
        cacheHint: 'none',
        ops: [{
          type: 'pageBackground',
          bbox: { x: 0, y: 0, width: 72, height: 48 },
          backgroundColor: '#fff9d8',
          borderColor: '#222222',
          borderWidth: 1,
          gradient: {
            gradientType: 0,
            angle: 35,
            centerX: 50,
            centerY: 50,
            colors: ['#f84444', '#ffe35a', '#3d8bff'],
            positions: [0, 0.55, 1],
          },
        }],
      },
    };
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await nextFrame();
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(
    !pageBackgroundGradientProbe.error,
    pageBackgroundGradientProbe.error || 'page background gradient parity probe available',
  );
  const pageBackgroundGradientCanvas2dColorPixels = countPixels(
    pageBackgroundGradientProbe.canvas2d,
    (pixel) => pixel.alpha > 32 && (pixel.red > 120 || pixel.blue > 120) && pixel.green < 245,
  );
  const pageBackgroundGradientCanvaskitColorPixels = countPixels(
    pageBackgroundGradientProbe.canvaskit,
    (pixel) => pixel.alpha > 32 && (pixel.red > 120 || pixel.blue > 120) && pixel.green < 245,
  );
  assert(
    pageBackgroundGradientCanvas2dColorPixels > 1800 && pageBackgroundGradientCanvaskitColorPixels > 1800,
    `page background gradient fills page canvas2d=${pageBackgroundGradientCanvas2dColorPixels}, canvaskit=${pageBackgroundGradientCanvaskitColorPixels}`,
  );
  const pageBackgroundGradientDiff = await comparePngBuffers(
    pngBufferFromDataUrl(pageBackgroundGradientProbe.canvas2d),
    pngBufferFromDataUrl(pageBackgroundGradientProbe.canvaskit),
    {
      diffName: 'canvas-layer-page-background-gradient-parity',
      ignoreChannelDelta: 24,
      maxDiffRatio: 0.08,
      inkMaskMaxDiffRatio: 0.04,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    pageBackgroundGradientDiff.passed,
    `page background gradient parity exact=${pageBackgroundGradientDiff.exactDiffPixels}, tolerant=${pageBackgroundGradientDiff.rawTolerantDiffPixels}, ink=${pageBackgroundGradientDiff.rawInkMaskDiffPixels}, max_channel_delta=${pageBackgroundGradientDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-page-background-thin-border-parity');
  const pageBackgroundThinBorderProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const tree = {
      pageWidth: 48,
      pageHeight: 32,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1910,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 1910,
        bounds: { x: 0, y: 0, width: 48, height: 32 },
        cacheHint: 'none',
        ops: [{
          type: 'pageBackground',
          bbox: { x: 4, y: 4, width: 40, height: 24 },
          backgroundColor: '#ffffff',
          borderColor: '#000000',
          borderWidth: 0.1,
        }],
      },
    };
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await nextFrame();
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(
    !pageBackgroundThinBorderProbe.error,
    pageBackgroundThinBorderProbe.error || 'page background thin border parity probe available',
  );
  const measureThinBorderDarkness = (dataUrl) => {
    const png = PNG.sync.read(pngBufferFromDataUrl(dataUrl));
    let totalDarkness = 0;
    let samples = 0;
    const addSample = (x, y) => {
      const offset = (y * png.width + x) * 4;
      const alpha = png.data[offset + 3] / 255;
      const luma = (png.data[offset] + png.data[offset + 1] + png.data[offset + 2]) / 3;
      totalDarkness += (255 - luma) * alpha;
      samples += 1;
    };
    for (let x = 4; x <= 44; x += 1) {
      addSample(x, 4);
      addSample(x, 28);
    }
    for (let y = 5; y < 28; y += 1) {
      addSample(4, y);
      addSample(44, y);
    }
    return totalDarkness / samples;
  };
  const pageBackgroundThinBorderCanvas2dDarkness = measureThinBorderDarkness(
    pageBackgroundThinBorderProbe.canvas2d,
  );
  const pageBackgroundThinBorderCanvaskitDarkness = measureThinBorderDarkness(
    pageBackgroundThinBorderProbe.canvaskit,
  );
  assert(
    pageBackgroundThinBorderCanvas2dDarkness > 8
      && pageBackgroundThinBorderCanvaskitDarkness >= pageBackgroundThinBorderCanvas2dDarkness * 0.6,
    `page background thin border parity canvas2d=${pageBackgroundThinBorderCanvas2dDarkness.toFixed(2)}, canvaskit=${pageBackgroundThinBorderCanvaskitDarkness.toFixed(2)}`,
  );

  setTestCase('canvas-layer-page-background-image-fill-mode-variant-parity');
  const pageBackgroundImageFillModeVariantProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = 6;
    sourceCanvas.height = 5;
    const sourceCtx = sourceCanvas.getContext('2d');
    if (!sourceCtx) {
      return { error: 'source canvas unavailable' };
    }
    sourceCtx.fillStyle = '#d82020';
    sourceCtx.fillRect(0, 0, 3, 5);
    sourceCtx.fillStyle = '#1d9f3a';
    sourceCtx.fillRect(3, 0, 3, 2);
    sourceCtx.fillStyle = '#2454d8';
    sourceCtx.fillRect(3, 2, 3, 3);
    sourceCtx.fillStyle = '#111111';
    sourceCtx.fillRect(1, 1, 4, 1);
    const base64 = sourceCanvas.toDataURL('image/png').split(',')[1];
    const modes = [
      ['centerTop', 4, 4],
      ['rightTop', 36, 4],
      ['leftCenter', 68, 4],
      ['rightCenter', 4, 24],
      ['leftBottom', 36, 24],
      ['centerBottom', 68, 24],
      ['tileHorzBottom', 4, 44],
      ['tileVertLeft', 36, 44],
      ['tileVertRight', 68, 44],
    ];
    const tree = {
      pageWidth: 100,
      pageHeight: 64,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1911,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 1911,
        bounds: { x: 0, y: 0, width: 100, height: 64 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 100, height: 64 }, backgroundColor: '#ffffff', borderWidth: 0 },
          ...modes.map(([fillMode, x, y]) => ({
            type: 'pageBackground',
            bbox: { x, y, width: 24, height: 16 },
            backgroundColor: '#ffffff',
            borderWidth: 0,
            image: {
              fillMode,
              base64,
            },
          })),
        ],
      },
    };
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return { error: 'target canvas unavailable' };
      }
      for (let attempt = 0; attempt < 8; attempt += 1) {
        renderer.renderPage(tree, canvas, 1);
        await nextFrame();
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let bluePixels = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index + 3] > 32 && pixels[index] < 80 && pixels[index + 1] < 120 && pixels[index + 2] > 150) {
            bluePixels += 1;
          }
        }
        if (bluePixels > 120) {
          break;
        }
      }
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(
    !pageBackgroundImageFillModeVariantProbe.error,
    pageBackgroundImageFillModeVariantProbe.error || 'page background image fill mode variant parity probe available',
  );
  const pageBackgroundFillModeCanvas2dBluePixels = countPixels(
    pageBackgroundImageFillModeVariantProbe.canvas2d,
    (pixel) => pixel.alpha > 32 && pixel.red < 80 && pixel.green < 120 && pixel.blue > 150,
  );
  const pageBackgroundFillModeCanvaskitBluePixels = countPixels(
    pageBackgroundImageFillModeVariantProbe.canvaskit,
    (pixel) => pixel.alpha > 32 && pixel.red < 80 && pixel.green < 120 && pixel.blue > 150,
  );
  assert(
    pageBackgroundFillModeCanvas2dBluePixels > 120 && pageBackgroundFillModeCanvaskitBluePixels > 120,
    `page background image fill mode variants replay canvas2d=${pageBackgroundFillModeCanvas2dBluePixels}, canvaskit=${pageBackgroundFillModeCanvaskitBluePixels}`,
  );
  const pageBackgroundImageFillModeVariantDiff = await comparePngBuffers(
    pngBufferFromDataUrl(pageBackgroundImageFillModeVariantProbe.canvas2d),
    pngBufferFromDataUrl(pageBackgroundImageFillModeVariantProbe.canvaskit),
    {
      diffName: 'canvas-layer-page-background-image-fill-mode-variant-parity',
      ignoreChannelDelta: 4,
      maxDiffRatio: 0.02,
      inkMaskMaxDiffRatio: 0.01,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    pageBackgroundImageFillModeVariantDiff.passed,
    `page background image fill mode variant parity exact=${pageBackgroundImageFillModeVariantDiff.exactDiffPixels}, tolerant=${pageBackgroundImageFillModeVariantDiff.rawTolerantDiffPixels}, ink=${pageBackgroundImageFillModeVariantDiff.rawInkMaskDiffPixels}, max_channel_delta=${pageBackgroundImageFillModeVariantDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-image-placement-parity');
  const imagePlacementParityProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = 8;
    sourceCanvas.height = 6;
    const sourceCtx = sourceCanvas.getContext('2d');
    if (!sourceCtx) {
      return { error: 'source canvas unavailable' };
    }
    sourceCtx.fillStyle = '#e61f1f';
    sourceCtx.fillRect(0, 0, 4, 6);
    sourceCtx.fillStyle = '#21a83a';
    sourceCtx.fillRect(4, 0, 4, 3);
    sourceCtx.fillStyle = '#2756d8';
    sourceCtx.fillRect(4, 3, 4, 3);
    sourceCtx.fillStyle = '#111111';
    sourceCtx.fillRect(1, 1, 6, 1);
    sourceCtx.fillRect(6, 1, 1, 4);
    const base64 = sourceCanvas.toDataURL('image/png').split(',')[1];
    const modes = [
      ['leftTop', 2, 2],
      ['center', 28, 2],
      ['rightBottom', 54, 2],
      ['tileAll', 2, 34],
      ['tileHorzBottom', 28, 34],
      ['tileVertRight', 54, 34],
    ];
    const tree = {
      pageWidth: 78,
      pageHeight: 58,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1906,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 1906,
        bounds: { x: 0, y: 0, width: 78, height: 58 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 78, height: 58 }, backgroundColor: '#ffffff', borderWidth: 0 },
          ...modes.map(([fillMode, x, y]) => ({
            type: 'image',
            bbox: { x, y, width: 20, height: 20 },
            base64,
            fillMode,
            effect: 'realPic',
            originalSize: { width: 8, height: 6 },
            transform: { rotation: 0, horzFlip: false, vertFlip: false },
          })),
        ],
      },
    };
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return { error: 'target canvas unavailable' };
      }
      for (let attempt = 0; attempt < 8; attempt += 1) {
        renderer.renderPage(tree, canvas, 1);
        await nextFrame();
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let inkPixels = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index + 3] > 32 && (pixels[index] < 245 || pixels[index + 1] < 245 || pixels[index + 2] < 245)) {
            inkPixels += 1;
          }
        }
        if (inkPixels > 800) {
          break;
        }
      }
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(!imagePlacementParityProbe.error, imagePlacementParityProbe.error || 'image placement parity probe available');
  const imagePlacementCanvas2dInkPixels = countPixels(
    imagePlacementParityProbe.canvas2d,
    (pixel) => pixel.alpha > 32 && (pixel.red < 245 || pixel.green < 245 || pixel.blue < 245),
  );
  const imagePlacementCanvaskitInkPixels = countPixels(
    imagePlacementParityProbe.canvaskit,
    (pixel) => pixel.alpha > 32 && (pixel.red < 245 || pixel.green < 245 || pixel.blue < 245),
  );
  assert(
    imagePlacementCanvas2dInkPixels > 800 && imagePlacementCanvaskitInkPixels > 800,
    `image placement replay draws direct images canvas2d=${imagePlacementCanvas2dInkPixels}, canvaskit=${imagePlacementCanvaskitInkPixels}`,
  );
  const imagePlacementDiff = await comparePngBuffers(
    pngBufferFromDataUrl(imagePlacementParityProbe.canvas2d),
    pngBufferFromDataUrl(imagePlacementParityProbe.canvaskit),
    {
      diffName: 'canvas-layer-image-placement-parity',
      ignoreChannelDelta: 4,
      maxDiffRatio: 0.02,
      inkMaskMaxDiffRatio: 0.01,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    imagePlacementDiff.passed,
    `image placement parity exact=${imagePlacementDiff.exactDiffPixels}, tolerant=${imagePlacementDiff.rawTolerantDiffPixels}, ink=${imagePlacementDiff.rawInkMaskDiffPixels}, max_channel_delta=${imagePlacementDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-image-fill-mode-variant-parity');
  const imageFillModeVariantProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = 6;
    sourceCanvas.height = 4;
    const sourceCtx = sourceCanvas.getContext('2d');
    if (!sourceCtx) {
      return { error: 'source canvas unavailable' };
    }
    sourceCtx.fillStyle = '#e83a32';
    sourceCtx.fillRect(0, 0, 3, 4);
    sourceCtx.fillStyle = '#2aa84a';
    sourceCtx.fillRect(3, 0, 3, 2);
    sourceCtx.fillStyle = '#2656db';
    sourceCtx.fillRect(3, 2, 3, 2);
    sourceCtx.fillStyle = '#111111';
    sourceCtx.fillRect(1, 1, 4, 1);
    const base64 = sourceCanvas.toDataURL('image/png').split(',')[1];
    const modes = [
      ['centerTop', 2, 2],
      ['rightTop', 26, 2],
      ['leftCenter', 50, 2],
      ['rightCenter', 74, 2],
      ['leftBottom', 2, 26],
      ['centerBottom', 26, 26],
      ['tileHorzTop', 50, 26],
      ['tileVertLeft', 74, 26],
      ['fitToSize', 2, 50],
      ['total', 26, 50],
    ];
    const tree = {
      pageWidth: 96,
      pageHeight: 70,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 19061,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 19061,
        bounds: { x: 0, y: 0, width: 96, height: 70 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 96, height: 70 }, backgroundColor: '#ffffff', borderWidth: 0 },
          ...modes.map(([fillMode, x, y]) => ({
            type: 'image',
            bbox: { x, y, width: 18, height: 18 },
            base64,
            fillMode,
            effect: 'realPic',
            originalSize: { width: 6, height: 4 },
            transform: { rotation: 0, horzFlip: false, vertFlip: false },
          })),
        ],
      },
    };
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return { error: 'target canvas unavailable' };
      }
      for (let attempt = 0; attempt < 8; attempt += 1) {
        renderer.renderPage(tree, canvas, 1);
        await nextFrame();
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let inkPixels = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index + 3] > 32 && (pixels[index] < 245 || pixels[index + 1] < 245 || pixels[index + 2] < 245)) {
            inkPixels += 1;
          }
        }
        if (inkPixels > 250) {
          break;
        }
      }
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(
    !imageFillModeVariantProbe.error,
    imageFillModeVariantProbe.error || 'image fill mode variant parity probe available',
  );
  const imageFillModeCanvas2dInkPixels = countPixels(
    imageFillModeVariantProbe.canvas2d,
    (pixel) => pixel.alpha > 32 && (pixel.red < 245 || pixel.green < 245 || pixel.blue < 245),
  );
  const imageFillModeCanvaskitInkPixels = countPixels(
    imageFillModeVariantProbe.canvaskit,
    (pixel) => pixel.alpha > 32 && (pixel.red < 245 || pixel.green < 245 || pixel.blue < 245),
  );
  assert(
    imageFillModeCanvas2dInkPixels > 250 && imageFillModeCanvaskitInkPixels > 250,
    `image fill mode variants replay canvas2d=${imageFillModeCanvas2dInkPixels}, canvaskit=${imageFillModeCanvaskitInkPixels}`,
  );
  const countStretchModeMismatches = (dataUrl) => {
    const png = PNG.sync.read(pngBufferFromDataUrl(dataUrl));
    let mismatches = 0;
    let maxChannelDelta = 0;
    for (let y = 0; y < 18; y += 1) {
      for (let x = 0; x < 18; x += 1) {
        const fitOffset = ((50 + y) * png.width + 2 + x) * 4;
        const totalOffset = ((50 + y) * png.width + 26 + x) * 4;
        let pixelDiffers = false;
        for (let channel = 0; channel < 4; channel += 1) {
          const delta = Math.abs(png.data[fitOffset + channel] - png.data[totalOffset + channel]);
          maxChannelDelta = Math.max(maxChannelDelta, delta);
          pixelDiffers ||= delta !== 0;
        }
        if (pixelDiffers) {
          mismatches += 1;
        }
      }
    }
    return { mismatches, maxChannelDelta };
  };
  const canvas2dStretchModeParity = countStretchModeMismatches(imageFillModeVariantProbe.canvas2d);
  const canvaskitStretchModeParity = countStretchModeMismatches(imageFillModeVariantProbe.canvaskit);
  assert(
    canvas2dStretchModeParity.mismatches === 0,
    `Canvas2D TOTAL matches fitToSize exactly=${JSON.stringify(canvas2dStretchModeParity)}`,
  );
  assert(
    canvaskitStretchModeParity.mismatches <= 2 && canvaskitStretchModeParity.maxChannelDelta <= 4,
    `CanvasKit TOTAL matches fitToSize within raster tolerance=${JSON.stringify(canvaskitStretchModeParity)}`,
  );
  const imageFillModeVariantDiff = await comparePngBuffers(
    pngBufferFromDataUrl(imageFillModeVariantProbe.canvas2d),
    pngBufferFromDataUrl(imageFillModeVariantProbe.canvaskit),
    {
      diffName: 'canvas-layer-image-fill-mode-variant-parity',
      ignoreChannelDelta: 4,
      maxDiffRatio: 0.025,
      inkMaskMaxDiffRatio: 0.01,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    imageFillModeVariantDiff.passed,
    `image fill mode variant parity exact=${imageFillModeVariantDiff.exactDiffPixels}, tolerant=${imageFillModeVariantDiff.rawTolerantDiffPixels}, ink=${imageFillModeVariantDiff.rawInkMaskDiffPixels}, max_channel_delta=${imageFillModeVariantDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-transformed-image-parity');
  const transformedImageParityProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = 10;
    sourceCanvas.height = 8;
    const sourceCtx = sourceCanvas.getContext('2d');
    if (!sourceCtx) {
      return { error: 'source canvas unavailable' };
    }
    sourceCtx.fillStyle = '#f04b2f';
    sourceCtx.fillRect(0, 0, 5, 8);
    sourceCtx.fillStyle = '#1c9e46';
    sourceCtx.fillRect(5, 0, 5, 4);
    sourceCtx.fillStyle = '#2557d9';
    sourceCtx.fillRect(5, 4, 5, 4);
    sourceCtx.fillStyle = '#101010';
    sourceCtx.fillRect(1, 1, 8, 1);
    sourceCtx.fillRect(8, 1, 1, 6);
    sourceCtx.fillStyle = '#ffffff';
    sourceCtx.fillRect(3, 3, 2, 2);
    const base64 = sourceCanvas.toDataURL('image/png').split(',')[1];
    const tree = {
      pageWidth: 82,
      pageHeight: 54,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1910,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 1910,
        bounds: { x: 0, y: 0, width: 82, height: 54 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 82, height: 54 }, backgroundColor: '#ffffff', borderWidth: 0 },
          {
            type: 'image',
            bbox: { x: 9, y: 7, width: 20, height: 16 },
            base64,
            fillMode: 'fitToSize',
            effect: 'realPic',
            originalSize: { width: 10, height: 8 },
            transform: { rotation: 25, horzFlip: false, vertFlip: false },
          },
          {
            type: 'image',
            bbox: { x: 46, y: 7, width: 20, height: 16 },
            base64,
            fillMode: 'fitToSize',
            effect: 'realPic',
            originalSize: { width: 10, height: 8 },
            transform: { rotation: -18, horzFlip: true, vertFlip: false },
          },
          {
            type: 'image',
            bbox: { x: 28, y: 30, width: 22, height: 18 },
            base64,
            fillMode: 'fitToSize',
            effect: 'realPic',
            originalSize: { width: 10, height: 8 },
            transform: { rotation: 12, horzFlip: false, vertFlip: true },
          },
        ],
      },
    };
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return { error: 'target canvas unavailable' };
      }
      for (let attempt = 0; attempt < 8; attempt += 1) {
        renderer.renderPage(tree, canvas, 1);
        await nextFrame();
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let inkPixels = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index + 3] > 32 && (pixels[index] < 245 || pixels[index + 1] < 245 || pixels[index + 2] < 245)) {
            inkPixels += 1;
          }
        }
        if (inkPixels > 850) {
          break;
        }
      }
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(!transformedImageParityProbe.error, transformedImageParityProbe.error || 'transformed image parity probe available');
  const transformedImageCanvas2dInkPixels = countPixels(
    transformedImageParityProbe.canvas2d,
    (pixel) => pixel.alpha > 32 && (pixel.red < 245 || pixel.green < 245 || pixel.blue < 245),
  );
  const transformedImageCanvaskitInkPixels = countPixels(
    transformedImageParityProbe.canvaskit,
    (pixel) => pixel.alpha > 32 && (pixel.red < 245 || pixel.green < 245 || pixel.blue < 245),
  );
  assert(
    transformedImageCanvas2dInkPixels > 850 && transformedImageCanvaskitInkPixels > 850,
    `transformed image replay draws direct images canvas2d=${transformedImageCanvas2dInkPixels}, canvaskit=${transformedImageCanvaskitInkPixels}`,
  );
  const transformedImageDiff = await comparePngBuffers(
    pngBufferFromDataUrl(transformedImageParityProbe.canvas2d),
    pngBufferFromDataUrl(transformedImageParityProbe.canvaskit),
    {
      diffName: 'canvas-layer-transformed-image-parity',
      ignoreChannelDelta: 18,
      maxDiffRatio: 0.08,
      inkMaskMaxDiffRatio: 0.04,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    transformedImageDiff.passed,
    `transformed image parity exact=${transformedImageDiff.exactDiffPixels}, tolerant=${transformedImageDiff.rawTolerantDiffPixels}, ink=${transformedImageDiff.rawInkMaskDiffPixels}, max_channel_delta=${transformedImageDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-equation-geometry-parity');
  const equationGeometryParityProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const emptyBox = (x, y, width, height, baseline = 0) => ({
      x,
      y,
      width,
      height,
      baseline,
      kind: { type: 'empty' },
    });
    const tree = {
      pageWidth: 116,
      pageHeight: 46,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1911,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 1911,
        bounds: { x: 0, y: 0, width: 116, height: 46 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 116, height: 46 }, backgroundColor: '#ffffff', borderWidth: 0 },
          {
            type: 'equation',
            bbox: { x: 4, y: 5, width: 108, height: 36 },
            color: '#111111',
            fontSize: 18,
            layoutBox: {
              x: 0,
              y: 0,
              width: 108,
              height: 36,
              baseline: 18,
              kind: {
                type: 'row',
                children: [
                  {
                    x: 2,
                    y: 8,
                    width: 24,
                    height: 18,
                    baseline: 9,
                    kind: {
                      type: 'fraction',
                      numer: emptyBox(4, 0, 16, 6, 4),
                      denom: emptyBox(4, 12, 16, 6, 4),
                    },
                  },
                  {
                    x: 32,
                    y: 7,
                    width: 26,
                    height: 22,
                    baseline: 14,
                    kind: {
                      type: 'sqrt',
                      body: emptyBox(12, 5, 12, 10, 8),
                    },
                  },
                  {
                    x: 66,
                    y: 8,
                    width: 22,
                    height: 14,
                    baseline: 10,
                    kind: {
                      type: 'decoration',
                      decoration: 'vec',
                      body: emptyBox(1, 8, 20, 4, 0),
                    },
                  },
                  {
                    x: 92,
                    y: 6,
                    width: 14,
                    height: 24,
                    baseline: 14,
                    kind: {
                      type: 'matrix',
                      style: 'vert',
                      cells: [[emptyBox(5, 8, 4, 4, 0)]],
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    };
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return { error: 'target canvas unavailable' };
      }
      renderer.renderPage(tree, canvas, 1);
      await nextFrame();
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(!equationGeometryParityProbe.error, equationGeometryParityProbe.error || 'equation geometry parity probe available');
  const equationGeometryCanvas2dInkPixels = countPixels(
    equationGeometryParityProbe.canvas2d,
    (pixel) => pixel.alpha > 32 && (pixel.red < 245 || pixel.green < 245 || pixel.blue < 245),
  );
  const equationGeometryCanvaskitInkPixels = countPixels(
    equationGeometryParityProbe.canvaskit,
    (pixel) => pixel.alpha > 32 && (pixel.red < 245 || pixel.green < 245 || pixel.blue < 245),
  );
  assert(
    equationGeometryCanvas2dInkPixels > 100 && equationGeometryCanvaskitInkPixels > 100,
    `equation geometry replay draws direct lines canvas2d=${equationGeometryCanvas2dInkPixels}, canvaskit=${equationGeometryCanvaskitInkPixels}`,
  );
  const equationGeometryDiff = await comparePngBuffers(
    pngBufferFromDataUrl(equationGeometryParityProbe.canvas2d),
    pngBufferFromDataUrl(equationGeometryParityProbe.canvaskit),
    {
      diffName: 'canvas-layer-equation-geometry-parity',
      ignoreChannelDelta: 18,
      maxDiffRatio: 0.08,
      inkMaskMaxDiffRatio: 0.04,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    equationGeometryDiff.passed,
    `equation geometry parity exact=${equationGeometryDiff.exactDiffPixels}, tolerant=${equationGeometryDiff.rawTolerantDiffPixels}, ink=${equationGeometryDiff.rawInkMaskDiffPixels}, max_channel_delta=${equationGeometryDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-equation-path-topology-parity');
  const equationPathTopologyProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const emptyBox = (x, y, width, height) => ({
      x,
      y,
      width,
      height,
      baseline: 0,
      kind: { type: 'empty' },
    });
    const decorationBox = (x, decoration) => ({
      x,
      y: 8,
      width: 20,
      height: 18,
      baseline: 12,
      kind: {
        type: 'decoration',
        decoration,
        body: emptyBox(0, 8, 20, 8),
      },
    });
    const parenBox = (x, left, right) => ({
      x,
      y: 3,
      width: 26,
      height: 28,
      baseline: 16,
      kind: {
        type: 'paren',
        left,
        right,
        body: emptyBox(8, 8, 10, 10),
      },
    });
    const tree = {
      pageWidth: 204,
      pageHeight: 68,
      profile: 'screen',
      resources: { tableId: 1913, images: [], svgFragments: [] },
      root: {
        kind: 'leaf',
        bounds: { x: 0, y: 0, width: 204, height: 68 },
        cacheHint: 'none',
        ops: [
          {
            type: 'pageBackground',
            bbox: { x: 0, y: 0, width: 204, height: 68 },
            backgroundColor: '#ffffff',
            borderWidth: 0,
          },
          {
            type: 'equation',
            bbox: { x: 2, y: 2, width: 200, height: 34 },
            color: '#111111',
            fontSize: 18,
            layoutBox: {
              x: 0,
              y: 0,
              width: 200,
              height: 34,
              baseline: 18,
              kind: {
                type: 'row',
                children: [
                  decorationBox(4, 'hat'),
                  decorationBox(30, 'vec'),
                  decorationBox(56, 'tilde'),
                  decorationBox(82, 'dot'),
                  decorationBox(108, 'dDot'),
                  parenBox(134, '[', ']'),
                  parenBox(166, '{', '}'),
                ],
              },
            },
          },
          {
            type: 'equation',
            bbox: { x: 4, y: 46, width: 58, height: 16 },
            color: '#111111',
            fontSize: 6,
            layoutBox: {
              x: 0,
              y: 0,
              width: 58,
              height: 16,
              baseline: 8,
              kind: {
                type: 'row',
                children: [
                  {
                    x: 0,
                    y: 1,
                    width: 28,
                    height: 12,
                    baseline: 7,
                    kind: {
                      type: 'sqrt',
                      body: emptyBox(8, 3, 18, 7),
                    },
                  },
                  {
                    x: 34,
                    y: 2,
                    width: 20,
                    height: 10,
                    baseline: 6,
                    kind: {
                      type: 'decoration',
                      decoration: 'tilde',
                      body: emptyBox(0, 4, 20, 6),
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    };
    const nextFrame = () => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await nextFrame();
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(
    !equationPathTopologyProbe.error,
    equationPathTopologyProbe.error || 'equation path topology parity probe available',
  );
  const equationTopologyRegions = [
    { name: 'hat', left: 4, top: 5, right: 28, bottom: 18, minimum: 2 },
    { name: 'vector', left: 30, top: 5, right: 54, bottom: 18, minimum: 4 },
    { name: 'tilde', left: 56, top: 5, right: 80, bottom: 18, minimum: 2 },
    { name: 'dots', left: 82, top: 5, right: 130, bottom: 18, minimum: 2 },
    { name: 'brackets', left: 134, top: 3, right: 202, bottom: 35, minimum: 20 },
    { name: 'subpixel', left: 4, top: 46, right: 64, bottom: 64, minimum: 4 },
  ];
  for (const region of equationTopologyRegions) {
    const countInk = (dataUrl) => countPixels(
      dataUrl,
      (pixel) =>
        pixel.x >= region.left
        && pixel.x < region.right
        && pixel.y >= region.top
        && pixel.y < region.bottom
        && pixel.alpha > 16
        && (pixel.red < 245 || pixel.green < 245 || pixel.blue < 245),
    );
    const canvas2dInk = countInk(equationPathTopologyProbe.canvas2d);
    const canvaskitInk = countInk(equationPathTopologyProbe.canvaskit);
    assert(
      canvas2dInk >= region.minimum && canvaskitInk >= region.minimum,
      `equation ${region.name} path topology paints its region canvas2d=${canvas2dInk}, canvaskit=${canvaskitInk}`,
    );
  }
  const equationPathTopologyDiff = await comparePngBuffers(
    pngBufferFromDataUrl(equationPathTopologyProbe.canvas2d),
    pngBufferFromDataUrl(equationPathTopologyProbe.canvaskit),
    {
      diffName: 'canvas-layer-equation-path-topology-parity',
      ignoreChannelDelta: 24,
      maxDiffRatio: 0.04,
      inkMaskMaxDiffRatio: 0.03,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    equationPathTopologyDiff.passed,
    `equation path topology parity exact=${equationPathTopologyDiff.exactDiffPixels}, tolerant=${equationPathTopologyDiff.rawTolerantDiffPixels}, ink=${equationPathTopologyDiff.rawInkMaskDiffPixels}, max_channel_delta=${equationPathTopologyDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-equation-svg-resource-parity');
  const equationSvgResourceParityProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const tree = {
      pageWidth: 96,
      pageHeight: 54,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1971,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [
          '<path d="M4 4H70V30H4Z" fill="#ff00ff"/><path d="M10 38H86" fill="none" stroke="#111111" stroke-width="4" stroke-linecap="round"/><text x="47" y="19" font-family="Noto Sans KR" font-size="14" font-weight="700" fill="#008000" text-anchor="middle" dominant-baseline="central">입찰</text>',
        ],
        svgHashes: ['fixture-equation-svg-resource'],
        svgKeys: ['svg:fixture-equation-svg-resource'],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 1971,
        bounds: { x: 0, y: 0, width: 80, height: 54 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 80, height: 54 }, backgroundColor: '#ffffff', borderWidth: 0 },
          {
            type: 'equation',
            bbox: { x: 8, y: 7, width: 80, height: 42 },
            color: '#111111',
            fontSize: 16,
            svgResourceId: 0,
            layoutBox: { x: 0, y: 0, width: 64, height: 42, baseline: 0, kind: { type: 'empty' } },
          },
        ],
      },
    };
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await nextFrame();
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(
    !equationSvgResourceParityProbe.error,
    equationSvgResourceParityProbe.error || 'equation SVG resource parity probe available',
  );
  const equationSvgCanvas2dMagenta = countPixels(
    equationSvgResourceParityProbe.canvas2d,
    (pixel) => pixel.alpha > 32 && pixel.red > 180 && pixel.blue > 180 && pixel.green < 80,
  );
  const equationSvgCanvaskitMagenta = countPixels(
    equationSvgResourceParityProbe.canvaskit,
    (pixel) => pixel.alpha > 32 && pixel.red > 180 && pixel.blue > 180 && pixel.green < 80,
  );
  assert(
    equationSvgCanvas2dMagenta > 900 && equationSvgCanvaskitMagenta > 900,
    `equation SVG resource replay draws direct paths canvas2d=${equationSvgCanvas2dMagenta}, canvaskit=${equationSvgCanvaskitMagenta}`,
  );
  const equationSvgCanvas2dGreen = countPixels(
    equationSvgResourceParityProbe.canvas2d,
    (pixel) => pixel.alpha > 32 && pixel.green > 70 && pixel.red < 80 && pixel.blue < 80,
  );
  const equationSvgCanvaskitGreen = countPixels(
    equationSvgResourceParityProbe.canvaskit,
    (pixel) => pixel.alpha > 32 && pixel.green > 70 && pixel.red < 80 && pixel.blue < 80,
  );
  assert(
    equationSvgCanvas2dGreen > 20 && equationSvgCanvaskitGreen > 20,
    `equation SVG resource replay draws direct text canvas2d=${equationSvgCanvas2dGreen}, canvaskit=${equationSvgCanvaskitGreen}`,
  );
  const equationSvgResourceDiff = await comparePngBuffers(
    pngBufferFromDataUrl(equationSvgResourceParityProbe.canvas2d),
    pngBufferFromDataUrl(equationSvgResourceParityProbe.canvaskit),
    {
      diffName: 'canvas-layer-equation-svg-resource-parity',
      ignoreChannelDelta: 18,
      maxDiffRatio: 0.06,
      inkMaskMaxDiffRatio: 0.06,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    equationSvgResourceDiff.passed,
    `equation SVG resource parity exact=${equationSvgResourceDiff.exactDiffPixels}, tolerant=${equationSvgResourceDiff.rawTolerantDiffPixels}, ink=${equationSvgResourceDiff.rawInkMaskDiffPixels}, max_channel_delta=${equationSvgResourceDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-equation-invalid-svg-fallback-parity');
  const equationInvalidSvgFallbackProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const emptyBox = (x, y, width, height, baseline) => ({
      x,
      y,
      width,
      height,
      baseline,
      kind: { type: 'empty' },
    });
    const tree = {
      pageWidth: 108,
      pageHeight: 32,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1974,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 1974,
        bounds: { x: 0, y: 0, width: 108, height: 32 },
        cacheHint: 'none',
        ops: [
          {
            type: 'pageBackground',
            bbox: { x: 0, y: 0, width: 108, height: 32 },
            backgroundColor: '#ffffff',
            borderWidth: 0,
          },
          {
            type: 'equation',
            bbox: { x: 4, y: 4, width: 44, height: 24 },
            color: '#111111',
            fontSize: 20,
            svgContent: [
              '<path d="M0 0H44V24H0Z" fill="none"/>',
              '<path d="M0 0H44" fill="none" stroke="transparent" stroke-width="2"/>',
            ].join(''),
            layoutBox: {
              x: 0,
              y: 0,
              width: 44,
              height: 24,
              baseline: 12,
              kind: {
                type: 'fraction',
                numer: emptyBox(2, 0, 40, 8, 6),
                denom: emptyBox(2, 16, 40, 8, 6),
              },
            },
          },
          {
            type: 'equation',
            bbox: { x: 60, y: 4, width: 44, height: 24 },
            color: '#111111',
            fontSize: 20,
            svgContent: '<path d="M0 0L" fill="#111111"/>',
            layoutBox: {
              x: 0,
              y: 0,
              width: 44,
              height: 24,
              baseline: 12,
              kind: {
                type: 'fraction',
                numer: emptyBox(2, 0, 40, 8, 6),
                denom: emptyBox(2, 16, 40, 8, 6),
              },
            },
          },
        ],
      },
    };
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await nextFrame();
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    const canvas2d = await render(canvas2dRenderer);
    const canvaskit = await render(canvaskitRenderer);
    return {
      canvas2d,
      canvaskit,
      diagnostics: canvaskitRenderer.getEquationReplayDiagnostics(),
    };
  });
  assert(
    !equationInvalidSvgFallbackProbe.error,
    equationInvalidSvgFallbackProbe.error || 'equation invalid SVG fallback parity probe available',
  );
  const equationInvalidFallbackInk = (dataUrl, minX, maxX) => countPixels(
    dataUrl,
    (pixel) => (
      pixel.x >= minX
      && pixel.x < maxX
      && pixel.alpha > 16
      && (pixel.red < 245 || pixel.green < 245 || pixel.blue < 245)
    ),
  );
  for (const [label, minX, maxX] of [
    ['paintless', 4, 48],
    ['malformed path', 60, 104],
  ]) {
    const canvas2dInk = equationInvalidFallbackInk(
      equationInvalidSvgFallbackProbe.canvas2d,
      minX,
      maxX,
    );
    const canvaskitInk = equationInvalidFallbackInk(
      equationInvalidSvgFallbackProbe.canvaskit,
      minX,
      maxX,
    );
    assert(
      canvas2dInk > 20 && canvaskitInk > 20,
      `${label} equation SVG uses visible layout fallback `
        + `canvas2d=${canvas2dInk}, canvaskit=${canvaskitInk}`,
    );
  }
  assert(
    equationInvalidSvgFallbackProbe.diagnostics?.layoutReplays === 2
      && JSON.stringify(
        equationInvalidSvgFallbackProbe.diagnostics?.routes?.map(
          ({ route, reason }) => `${route}:${reason}`,
        ),
      ) === JSON.stringify([
        'layout:svgPayloadUnsupported',
        'layout:svgPathDecodeFailed',
      ]),
    `invalid equation SVG reports deterministic layout fallback=${JSON.stringify(equationInvalidSvgFallbackProbe.diagnostics)}`,
  );
  const equationInvalidSvgFallbackDiff = await comparePngBuffers(
    pngBufferFromDataUrl(equationInvalidSvgFallbackProbe.canvas2d),
    pngBufferFromDataUrl(equationInvalidSvgFallbackProbe.canvaskit),
    {
      diffName: 'canvas-layer-equation-invalid-svg-fallback-parity',
      ignoreChannelDelta: 24,
      maxDiffRatio: 0.04,
      inkMaskMaxDiffRatio: 0.04,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    equationInvalidSvgFallbackDiff.passed,
    `equation invalid SVG fallback parity exact=${equationInvalidSvgFallbackDiff.exactDiffPixels}, tolerant=${equationInvalidSvgFallbackDiff.rawTolerantDiffPixels}, ink=${equationInvalidSvgFallbackDiff.rawInkMaskDiffPixels}, max_channel_delta=${equationInvalidSvgFallbackDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-equation-svg-text-shaping-parity');
  const equationSvgTextShapingProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const tree = {
      pageWidth: 236,
      pageHeight: 72,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1973,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [[
          '<text x="6" y="18" font-family="Noto Sans KR" font-size="16" fill="#111111" text-anchor="start">AV office</text>',
          '<text x="118" y="42" font-family="Noto Sans KR" font-size="16" font-weight="700" fill="#0057b8" text-anchor="middle" dominant-baseline="middle">AVATAR office</text>',
          '<text x="230" y="66" font-family="Noto Sans KR" font-size="16" fill="#b00020" text-anchor="end">office AV</text>',
        ].join('')],
        svgHashes: ['fixture-equation-svg-text-shaping'],
        svgKeys: ['svg:fixture-equation-svg-text-shaping'],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 1973,
        bounds: { x: 0, y: 0, width: 236, height: 72 },
        cacheHint: 'none',
        ops: [
          {
            type: 'pageBackground',
            bbox: { x: 0, y: 0, width: 236, height: 72 },
            backgroundColor: '#ffffff',
            borderWidth: 0,
          },
          {
            type: 'equation',
            bbox: { x: 0, y: 0, width: 236, height: 72 },
            color: '#111111',
            fontSize: 16,
            svgResourceId: 0,
            layoutBox: {
              x: 0,
              y: 0,
              width: 236,
              height: 72,
              baseline: 0,
              kind: { type: 'empty' },
            },
          },
        ],
      },
    };
    const nextFrame = () => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await nextFrame();
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(
    !equationSvgTextShapingProbe.error,
    equationSvgTextShapingProbe.error || 'equation SVG text shaping parity probe available',
  );
  for (const [name, predicate] of [
    ['start anchor', (pixel) =>
      pixel.alpha > 32 && pixel.red < 80 && pixel.green < 80 && pixel.blue < 80],
    ['middle anchor', (pixel) =>
      pixel.alpha > 32 && pixel.blue > 100 && pixel.red < 80 && pixel.green < 140],
    ['end anchor', (pixel) =>
      pixel.alpha > 32 && pixel.red > 100 && pixel.green < 80 && pixel.blue < 100],
  ]) {
    const canvas2dInk = countPixels(equationSvgTextShapingProbe.canvas2d, predicate);
    const canvaskitInk = countPixels(equationSvgTextShapingProbe.canvaskit, predicate);
    assert(
      canvas2dInk > 20 && canvaskitInk > 20,
      `equation SVG shaped text paints ${name} canvas2d=${canvas2dInk}, canvaskit=${canvaskitInk}`,
    );
  }
  const equationSvgTextShapingDiff = await comparePngBuffers(
    pngBufferFromDataUrl(equationSvgTextShapingProbe.canvas2d),
    pngBufferFromDataUrl(equationSvgTextShapingProbe.canvaskit),
    {
      diffName: 'canvas-layer-equation-svg-text-shaping-parity',
      ignoreChannelDelta: 24,
      inkMaskMaxDiffRatio: 0.01,
      nonInkMaxDiffRatio: 0,
      solidInkMaxDiffRatio: 0.005,
    },
  );
  assert(
    equationSvgTextShapingDiff.passed,
    `equation SVG text shaping parity exact=${equationSvgTextShapingDiff.exactDiffPixels}, tolerant=${equationSvgTextShapingDiff.rawTolerantDiffPixels}, ink=${equationSvgTextShapingDiff.rawInkMaskDiffPixels}, max_channel_delta=${equationSvgTextShapingDiff.maxChannelDelta}`,
  );

  setTestCase('canvaskit-equation-layout-paragraph-shaping');
  const equationLayoutParagraphShapingProbe = await page.evaluate(async () => {
    const renderer = window.__canvasView?.pageRenderer?.canvaskitRenderer;
    if (!renderer) {
      return { error: 'CanvasKit renderer unavailable' };
    }
    const paragraphBuilder = renderer.canvasKit?.ParagraphBuilder;
    const originalMakeFromFontProvider = paragraphBuilder?.MakeFromFontProvider;
    if (!paragraphBuilder || typeof originalMakeFromFontProvider !== 'function') {
      return { error: 'CanvasKit ParagraphBuilder unavailable' };
    }
    const tree = {
      pageWidth: 220,
      pageHeight: 40,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1975,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 1975,
        bounds: { x: 0, y: 0, width: 220, height: 40 },
        cacheHint: 'none',
        ops: [
          {
            type: 'pageBackground',
            bbox: { x: 0, y: 0, width: 220, height: 40 },
            backgroundColor: '#ffffff',
            borderWidth: 0,
          },
          {
            type: 'equation',
            bbox: { x: 4, y: 4, width: 212, height: 32 },
            color: '#111111',
            fontSize: 20,
            layoutBox: {
              x: 0,
              y: 0,
              width: 212,
              height: 32,
              baseline: 23,
              kind: { type: 'text', text: 'AV office 한글' },
            },
          },
        ],
      },
    };
    const originalMakeTextObjects = renderer.makeTextObjects;
    let paragraphBuildCalls = 0;
    let directFallbackCalls = 0;
    paragraphBuilder.MakeFromFontProvider = function (...args) {
      paragraphBuildCalls += 1;
      return originalMakeFromFontProvider.apply(this, args);
    };
    renderer.makeTextObjects = function (...args) {
      directFallbackCalls += 1;
      return originalMakeTextObjects.apply(this, args);
    };
    try {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return { paragraphBuildCalls, directFallbackCalls, png };
    } finally {
      paragraphBuilder.MakeFromFontProvider = originalMakeFromFontProvider;
      renderer.makeTextObjects = originalMakeTextObjects;
    }
  });
  assert(
    !equationLayoutParagraphShapingProbe.error,
    equationLayoutParagraphShapingProbe.error
      || 'CanvasKit equation layout Paragraph shaping probe available',
  );
  const equationLayoutParagraphInk = countPixels(
    equationLayoutParagraphShapingProbe.png,
    (pixel) => (
      pixel.alpha > 32
      && pixel.red < 100
      && pixel.green < 100
      && pixel.blue < 100
    ),
  );
  assert(
    equationLayoutParagraphShapingProbe.paragraphBuildCalls > 0,
    `CanvasKit equation layout shapes through Paragraph calls=${equationLayoutParagraphShapingProbe.paragraphBuildCalls}`,
  );
  assert(
    equationLayoutParagraphShapingProbe.directFallbackCalls === 0,
    `CanvasKit equation layout avoids direct text fallback calls=${equationLayoutParagraphShapingProbe.directFallbackCalls}`,
  );
  assert(
    equationLayoutParagraphInk > 20,
    `CanvasKit equation layout draws shaped text pixels=${equationLayoutParagraphInk}`,
  );

  setTestCase('canvaskit-equation-replay-route-diagnostics');
  const equationReplayRouteProbe = await page.evaluate(async () => {
    const renderer = window.__canvasView?.pageRenderer?.canvaskitRenderer;
    if (!renderer) {
      return { error: 'canvaskit renderer unavailable' };
    }
    const equation = (x, svg, width = 12) => ({
      type: 'equation',
      bbox: { x, y: 2, width, height: 10 },
      color: '#111111',
      fontSize: 8,
      ...svg,
      layoutBox: {
        x: 0,
        y: 0,
        width: Math.max(width, 0),
        height: 10,
        baseline: 0,
        kind: { type: 'empty' },
      },
    });
    const tree = {
      pageWidth: 84,
      pageHeight: 16,
      profile: 'screen',
      resources: {
        tableId: 1972,
        images: [],
        svgFragments: [],
      },
      root: {
        kind: 'leaf',
        bounds: { x: 0, y: 0, width: 84, height: 16 },
        cacheHint: 'none',
        ops: [
          equation(0, {}),
          equation(14, { svgResourceId: 3 }),
          equation(28, { svgContent: '<g></g>' }),
          equation(42, { svgContent: '<path d="M0 0H8V8H0Z" fill="#111111"/>' }, 0),
          equation(56, { svgContent: '<path d="M0 0L" fill="#111111"/>' }),
          equation(70, { svgContent: '<path d="M0 0H8V8H0Z" fill="#111111"/>' }),
        ],
      },
    };
    const canvas = document.createElement('canvas');
    canvas.width = tree.pageWidth;
    canvas.height = tree.pageHeight;
    renderer.renderPage(tree, canvas, 1);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return renderer.getEquationReplayDiagnostics();
  });
  assert(
    !equationReplayRouteProbe.error,
    equationReplayRouteProbe.error || 'CanvasKit equation route diagnostics probe available',
  );
  assert(
    equationReplayRouteProbe.svgReplays === 1
      && equationReplayRouteProbe.layoutReplays === 5
      && equationReplayRouteProbe.fallbackReplays === 4
      && JSON.stringify(equationReplayRouteProbe.routes.map(({ route, reason }) => `${route}:${reason}`))
        === JSON.stringify([
          'layout:layoutRequested',
          'layout:svgResourceMissing',
          'layout:svgPayloadUnsupported',
          'layout:invalidEquationBounds',
          'layout:svgPathDecodeFailed',
          'svg:svgReplayed',
        ]),
    `CanvasKit equation routes expose deterministic SVG/layout reasons=${JSON.stringify(equationReplayRouteProbe)}`,
  );

  setTestCase('canvas-layer-equation-advanced-layout-parity');
  const equationAdvancedLayoutParityProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const box = (x, y, width, height, baseline, kind) => ({
      x,
      y,
      width,
      height,
      baseline,
      kind,
    });
    const textBox = (x, y, text) => box(x, y, Math.max(8, text.length * 7), 12, 9, { type: 'text', text });
    const numberBox = (x, y, text) => box(x, y, Math.max(7, text.length * 6), 10, 7, { type: 'number', text });
    const mathBox = (x, y, text) => box(x, y, 12, 12, 9, { type: 'mathSymbol', text });
    const tree = {
      pageWidth: 176,
      pageHeight: 86,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1912,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 1912,
        bounds: { x: 0, y: 0, width: 176, height: 86 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 176, height: 86 }, backgroundColor: '#ffffff', borderWidth: 0 },
          {
            type: 'equation',
            bbox: { x: 4, y: 4, width: 168, height: 76 },
            color: '#111111',
            fontSize: 16,
            layoutBox: {
              x: 0,
              y: 0,
              width: 168,
              height: 76,
              baseline: 18,
              kind: {
                type: 'row',
                children: [
                  box(2, 6, 26, 24, 15, {
                    type: 'subSup',
                    base: textBox(0, 7, 'x'),
                    sub: numberBox(13, 16, '1'),
                    sup: numberBox(13, 0, '2'),
                  }),
                  box(32, 1, 28, 32, 19, {
                    type: 'bigOp',
                    symbol: '∑',
                    sub: numberBox(10, 23, 'i'),
                    sup: numberBox(10, 0, 'n'),
                  }),
                  box(66, 8, 28, 24, 15, {
                    type: 'limit',
                    isUpper: false,
                    sub: textBox(12, 15, 't'),
                  }),
                  box(100, 3, 30, 32, 18, {
                    type: 'paren',
                    left: '{',
                    right: '}',
                    body: textBox(9, 10, 'y'),
                  }),
                  box(136, 7, 26, 24, 15, {
                    type: 'superscript',
                    base: textBox(0, 8, 'a'),
                    sup: numberBox(13, 0, '3'),
                  }),
                  box(4, 42, 40, 28, 16, {
                    type: 'rel',
                    over: textBox(12, 0, 'A'),
                    arrow: mathBox(13, 9, '→'),
                    under: textBox(12, 19, 'B'),
                  }),
                  box(52, 42, 48, 28, 14, {
                    type: 'eqAlign',
                    rows: [
                      {
                        left: textBox(0, 0, 'a'),
                        right: numberBox(24, 0, '1'),
                      },
                      {
                        left: textBox(0, 15, 'b'),
                        right: numberBox(24, 15, '2'),
                      },
                    ],
                  }),
                  box(108, 42, 30, 22, 14, {
                    type: 'fontStyle',
                    fontStyle: 'bold',
                    body: textBox(2, 5, 'B'),
                  }),
                  box(144, 42, 20, 22, 14, {
                    type: 'subscript',
                    base: textBox(0, 5, 'c'),
                    sub: numberBox(12, 13, '4'),
                  }),
                ],
              },
            },
          },
        ],
      },
    };
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return { error: 'target canvas unavailable' };
      }
      renderer.renderPage(tree, canvas, 1);
      await nextFrame();
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(
    !equationAdvancedLayoutParityProbe.error,
    equationAdvancedLayoutParityProbe.error || 'equation advanced layout parity probe available',
  );
  const equationAdvancedCanvas2dInkPixels = countPixels(
    equationAdvancedLayoutParityProbe.canvas2d,
    (pixel) => pixel.alpha > 32 && (pixel.red < 245 || pixel.green < 245 || pixel.blue < 245),
  );
  const equationAdvancedCanvaskitInkPixels = countPixels(
    equationAdvancedLayoutParityProbe.canvaskit,
    (pixel) => pixel.alpha > 32 && (pixel.red < 245 || pixel.green < 245 || pixel.blue < 245),
  );
  assert(
    equationAdvancedCanvas2dInkPixels > 250 && equationAdvancedCanvaskitInkPixels > 250,
    `equation advanced layout replay draws glyphs/geometry canvas2d=${equationAdvancedCanvas2dInkPixels}, canvaskit=${equationAdvancedCanvaskitInkPixels}`,
  );
  assert(
    Math.abs(equationAdvancedCanvas2dInkPixels - equationAdvancedCanvaskitInkPixels) <= 120,
    `equation advanced layout preserves natural text/delimiter coverage canvas2d=${equationAdvancedCanvas2dInkPixels}, canvaskit=${equationAdvancedCanvaskitInkPixels}`,
  );
  const equationAdvancedDiff = await comparePngBuffers(
    pngBufferFromDataUrl(equationAdvancedLayoutParityProbe.canvas2d),
    pngBufferFromDataUrl(equationAdvancedLayoutParityProbe.canvaskit),
    {
      diffName: 'canvas-layer-equation-advanced-layout-parity',
      ignoreChannelDelta: 24,
      maxDiffRatio: 0.08,
      inkMaskMaxDiffRatio: 0.04,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    equationAdvancedDiff.passed,
    `equation advanced layout parity exact=${equationAdvancedDiff.exactDiffPixels}, tolerant=${equationAdvancedDiff.rawTolerantDiffPixels}, ink=${equationAdvancedDiff.rawInkMaskDiffPixels}, max_channel_delta=${equationAdvancedDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-text-marker-parity');
  const textMarkerParityProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const tree = {
      pageWidth: 132,
      pageHeight: 68,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: true,
        showControlCodes: true,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1912,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 1912,
        bounds: { x: 0, y: 0, width: 132, height: 68 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 132, height: 68 }, backgroundColor: '#ffffff', borderWidth: 0 },
          {
            type: 'textControlMark',
            bbox: { x: 8, y: 5, width: 18, height: 20 },
            mark: { kind: 'paragraphEnd', text: '¶', x: 1, y: 15, fontSize: 16 },
          },
          {
            type: 'textControlMark',
            bbox: { x: 28, y: 5, width: 18, height: 20 },
            rotation: 25,
            mark: { kind: 'lineBreakEnd', text: '↵', x: 1, y: 15, fontSize: 16 },
          },
          {
            type: 'textControlMark',
            bbox: { x: 48, y: 5, width: 12, height: 20 },
            mark: { kind: 'space', text: '·', x: 1, y: 15, fontSize: 16 },
          },
          {
            type: 'textControlMark',
            bbox: { x: 64, y: 5, width: 40, height: 20 },
            mark: { kind: 'table', text: '[표]', x: 1, y: 15, fontSize: 14 },
          },
          {
            type: 'footnoteMarker',
            bbox: { x: 110, y: 5, width: 18, height: 20 },
            text: '12',
            fontFamily: 'Noto Sans KR',
            fontSize: 14,
            color: '#111111',
          },
          {
            type: 'tabLeader',
            bbox: { x: 10, y: 40, width: 112, height: 22 },
            leader: { startX: 4, endX: 96, fillType: 4 },
            color: '#111111',
            fontSize: 14,
            baseline: 15,
            rotation: -12,
          },
        ],
      },
    };
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return { error: 'target canvas unavailable' };
      }
      for (let attempt = 0; attempt < 8; attempt += 1) {
        renderer.renderPage(tree, canvas, 1);
        await nextFrame();
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let inkPixels = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index + 3] > 32 && (pixels[index] < 245 || pixels[index + 1] < 245 || pixels[index + 2] < 245)) {
            inkPixels += 1;
          }
        }
        if (inkPixels > 80) {
          break;
        }
      }
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(!textMarkerParityProbe.error, textMarkerParityProbe.error || 'text marker parity probe available');
  const textMarkerCanvas2dInkPixels = countPixels(
    textMarkerParityProbe.canvas2d,
    (pixel) => pixel.alpha > 32 && (pixel.red < 245 || pixel.green < 245 || pixel.blue < 245),
  );
  const textMarkerCanvaskitInkPixels = countPixels(
    textMarkerParityProbe.canvaskit,
    (pixel) => pixel.alpha > 32 && (pixel.red < 245 || pixel.green < 245 || pixel.blue < 245),
  );
  assert(
    textMarkerCanvas2dInkPixels > 80 && textMarkerCanvaskitInkPixels > 80,
    `text marker replay draws direct markers canvas2d=${textMarkerCanvas2dInkPixels}, canvaskit=${textMarkerCanvaskitInkPixels}`,
  );
  const isStructureMarkRed = (pixel) => pixel.alpha > 32
    && pixel.red > 120
    && pixel.red > pixel.green * 2
    && pixel.red > pixel.blue * 2;
  const textMarkerCanvas2dStructurePixels = countPixels(
    textMarkerParityProbe.canvas2d,
    isStructureMarkRed,
  );
  const textMarkerCanvaskitStructurePixels = countPixels(
    textMarkerParityProbe.canvaskit,
    isStructureMarkRed,
  );
  assert(
    textMarkerCanvas2dStructurePixels > 5 && textMarkerCanvaskitStructurePixels > 5,
    `structure control mark uses direct red replay canvas2d=${textMarkerCanvas2dStructurePixels}, canvaskit=${textMarkerCanvaskitStructurePixels}`,
  );
  const textMarkerCanvas2dRotatedLeaderPixels = countPixels(
    textMarkerParityProbe.canvas2d,
    (pixel) => pixel.y > 36 && pixel.alpha > 32
      && (pixel.red < 245 || pixel.green < 245 || pixel.blue < 245),
  );
  const textMarkerCanvaskitRotatedLeaderPixels = countPixels(
    textMarkerParityProbe.canvaskit,
    (pixel) => pixel.y > 36 && pixel.alpha > 32
      && (pixel.red < 245 || pixel.green < 245 || pixel.blue < 245),
  );
  assert(
    textMarkerCanvas2dRotatedLeaderPixels > 10 && textMarkerCanvaskitRotatedLeaderPixels > 10,
    `rotated tab leader replays directly canvas2d=${textMarkerCanvas2dRotatedLeaderPixels}, canvaskit=${textMarkerCanvaskitRotatedLeaderPixels}`,
  );
  const textMarkerDiff = await comparePngBuffers(
    pngBufferFromDataUrl(textMarkerParityProbe.canvas2d),
    pngBufferFromDataUrl(textMarkerParityProbe.canvaskit),
    {
      diffName: 'canvas-layer-text-marker-parity',
      ignoreChannelDelta: 32,
      maxDiffRatio: 0.18,
      inkMaskMaxDiffRatio: 0.12,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    textMarkerDiff.passed,
    `text marker parity exact=${textMarkerDiff.exactDiffPixels}, tolerant=${textMarkerDiff.rawTolerantDiffPixels}, ink=${textMarkerDiff.rawInkMaskDiffPixels}, max_channel_delta=${textMarkerDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-inline-control-mark-parity');
  const inlineControlMarkParityProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const style = {
      fontFamily: 'Noto Sans KR',
      fontSize: 16,
      color: '#111111',
      bold: false,
      italic: false,
      ratio: 1,
      underline: 'none',
      underlineShape: 0,
      strikethrough: false,
      strikeShape: 0,
      outlineType: 0,
      shadowType: 0,
      shadowColor: '#000000',
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      emboss: false,
      engrave: false,
      emphasisDot: 0,
      shadeColor: '#ffffff',
    };
    const tree = (showParagraphMarks, showControlCodes) => ({
      pageWidth: 114,
      pageHeight: 34,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks,
        showControlCodes,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: showParagraphMarks || showControlCodes ? 1913 : 1914,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: showParagraphMarks || showControlCodes ? 1913 : 1914,
        bounds: { x: 0, y: 0, width: 114, height: 34 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 114, height: 34 }, backgroundColor: '#ffffff', borderWidth: 0 },
          {
            type: 'textRun',
            bbox: { x: 8, y: 6, width: 100, height: 22 },
            text: 'A',
            baseline: 17,
            rotation: 0,
            isVertical: false,
            orientation: 'horizontal',
            isParaEnd: false,
            isLineBreakEnd: false,
            style,
            positions: [0, 12],
            controlMarks: [
              { kind: 'paragraphEnd', text: '¶', x: 18, y: 0, fontSize: 16 },
              { kind: 'lineBreakEnd', text: '↵', x: 38, y: 0, fontSize: 16 },
              { kind: 'space', text: '·', x: 58, y: 0, fontSize: 16 },
              { kind: 'tab', text: '→', x: 78, y: 0, fontSize: 16 },
            ],
            tabLeaders: [],
          },
        ],
      },
    });
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const render = async (renderer, inputTree) => {
      const canvas = document.createElement('canvas');
      canvas.width = inputTree.pageWidth;
      canvas.height = inputTree.pageHeight;
      document.body.appendChild(canvas);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return { error: 'target canvas unavailable' };
      }
      renderer.renderPage(inputTree, canvas, 1);
      await nextFrame();
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    const visible = tree(true, true);
    const hidden = tree(false, false);
    return {
      visibleCanvas2d: await render(canvas2dRenderer, visible),
      visibleCanvaskit: await render(canvaskitRenderer, visible),
      hiddenCanvas2d: await render(canvas2dRenderer, hidden),
      hiddenCanvaskit: await render(canvaskitRenderer, hidden),
    };
  });
  assert(
    !inlineControlMarkParityProbe.error,
    inlineControlMarkParityProbe.error || 'inline control mark parity probe available',
  );
  const isControlMarkBlue = (pixel) => pixel.alpha > 32 && pixel.blue > 120 && pixel.red < 120 && pixel.green > 80;
  const visibleCanvas2dControlPixels = countPixels(inlineControlMarkParityProbe.visibleCanvas2d, isControlMarkBlue);
  const visibleCanvaskitControlPixels = countPixels(inlineControlMarkParityProbe.visibleCanvaskit, isControlMarkBlue);
  const hiddenCanvas2dControlPixels = countPixels(inlineControlMarkParityProbe.hiddenCanvas2d, isControlMarkBlue);
  const hiddenCanvaskitControlPixels = countPixels(inlineControlMarkParityProbe.hiddenCanvaskit, isControlMarkBlue);
  assert(
    visibleCanvas2dControlPixels > 20 && visibleCanvaskitControlPixels > 20,
    `inline control marks draw when enabled canvas2d=${visibleCanvas2dControlPixels}, canvaskit=${visibleCanvaskitControlPixels}`,
  );
  const visibleCanvas2dTabPixels = countPixels(
    inlineControlMarkParityProbe.visibleCanvas2d,
    (pixel) => pixel.x >= 84 && pixel.x < 109 && isControlMarkBlue(pixel),
  );
  const visibleCanvaskitTabPixels = countPixels(
    inlineControlMarkParityProbe.visibleCanvaskit,
    (pixel) => pixel.x >= 84 && pixel.x < 109 && isControlMarkBlue(pixel),
  );
  assert(
    visibleCanvas2dTabPixels > 3 && visibleCanvaskitTabPixels > 3,
    `inline tab control mark draws in its own region canvas2d=${visibleCanvas2dTabPixels}, canvaskit=${visibleCanvaskitTabPixels}`,
  );
  assert(
    hiddenCanvas2dControlPixels === 0 && hiddenCanvaskitControlPixels === 0,
    `inline control marks hide when disabled canvas2d=${hiddenCanvas2dControlPixels}, canvaskit=${hiddenCanvaskitControlPixels}`,
  );
  const inlineControlVisibleDiff = await comparePngBuffers(
    pngBufferFromDataUrl(inlineControlMarkParityProbe.visibleCanvas2d),
    pngBufferFromDataUrl(inlineControlMarkParityProbe.visibleCanvaskit),
    {
      diffName: 'canvas-layer-inline-control-mark-visible-parity',
      ignoreChannelDelta: 32,
      maxDiffRatio: 0.18,
      inkMaskMaxDiffRatio: 0.12,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    inlineControlVisibleDiff.passed,
    `inline control mark visible parity exact=${inlineControlVisibleDiff.exactDiffPixels}, tolerant=${inlineControlVisibleDiff.rawTolerantDiffPixels}, ink=${inlineControlVisibleDiff.rawInkMaskDiffPixels}, max_channel_delta=${inlineControlVisibleDiff.maxChannelDelta}`,
  );
  const inlineControlHiddenDiff = await comparePngBuffers(
    pngBufferFromDataUrl(inlineControlMarkParityProbe.hiddenCanvas2d),
    pngBufferFromDataUrl(inlineControlMarkParityProbe.hiddenCanvaskit),
    {
      diffName: 'canvas-layer-inline-control-mark-hidden-parity',
      ignoreChannelDelta: 32,
      maxDiffRatio: 0.08,
      inkMaskMaxDiffRatio: 0.04,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    inlineControlHiddenDiff.passed,
    `inline control mark hidden parity exact=${inlineControlHiddenDiff.exactDiffPixels}, tolerant=${inlineControlHiddenDiff.rawTolerantDiffPixels}, ink=${inlineControlHiddenDiff.rawInkMaskDiffPixels}, max_channel_delta=${inlineControlHiddenDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-char-overlap-parity');
  const charOverlapParityProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const style = {
      fontFamily: 'Noto Sans KR',
      fontSize: 16,
      color: '#101010',
      bold: false,
      italic: false,
      ratio: 1,
      underline: 'none',
      underlineShape: 0,
      strikethrough: false,
      strikeShape: 0,
      outlineType: 0,
      shadowType: 0,
      shadowColor: '#000000',
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      emboss: false,
      engrave: false,
      emphasisDot: 0,
      underlineColor: '#101010',
      strikeColor: '#101010',
      shadeColor: '#ffffff',
    };
    const overlap = (x, text, borderType, innerCharSize, width = 20) => ({
      type: 'charOverlap',
      bbox: { x, y: 7, width, height: 24 },
      text,
      baseline: 18,
      rotation: 0,
      isVertical: false,
      orientation: 'horizontal',
      style,
      positions: [0, width],
      charOverlap: { borderType, innerCharSize },
    });
    const tree = {
      pageWidth: 160,
      pageHeight: 40,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1913,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 1913,
        bounds: { x: 0, y: 0, width: 160, height: 40 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 160, height: 40 }, backgroundColor: '#ffffff', borderWidth: 0 },
          overlap(8, '8', 1, 85),
          overlap(36, '4', 4, 90),
          overlap(64, '12', 3, 70, 32),
          overlap(102, String.fromCodePoint(0xf0292), 0, 90),
          overlap(130, '7', 2, 85),
        ],
      },
    };
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(
    !charOverlapParityProbe.error,
    charOverlapParityProbe.error || 'char overlap parity probe available',
  );
  const charOverlapCanvas2dInkPixels = countPixels(
    charOverlapParityProbe.canvas2d,
    (pixel) => pixel.alpha > 32 && (pixel.red < 245 || pixel.green < 245 || pixel.blue < 245),
  );
  const charOverlapCanvaskitInkPixels = countPixels(
    charOverlapParityProbe.canvaskit,
    (pixel) => pixel.alpha > 32 && (pixel.red < 245 || pixel.green < 245 || pixel.blue < 245),
  );
  assert(
    charOverlapCanvas2dInkPixels > 180 && charOverlapCanvaskitInkPixels > 180,
    `char overlap replay draws direct ops canvas2d=${charOverlapCanvas2dInkPixels}, canvaskit=${charOverlapCanvaskitInkPixels}`,
  );
  const charOverlapDiff = await comparePngBuffers(
    pngBufferFromDataUrl(charOverlapParityProbe.canvas2d),
    pngBufferFromDataUrl(charOverlapParityProbe.canvaskit),
    {
      diffName: 'canvas-layer-char-overlap-parity',
      ignoreChannelDelta: 48,
      maxDiffRatio: 0.22,
      inkMaskMaxDiffRatio: 0.12,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    charOverlapDiff.passed,
    `char overlap parity exact=${charOverlapDiff.exactDiffPixels}, tolerant=${charOverlapDiff.rawTolerantDiffPixels}, ink=${charOverlapDiff.rawInkMaskDiffPixels}, max_channel_delta=${charOverlapDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-char-overlap-baseline-parity');
  const charOverlapBaselineProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const tree = {
      pageWidth: 48,
      pageHeight: 48,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1920,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 1920,
        bounds: { x: 0, y: 0, width: 48, height: 48 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 48, height: 48 }, backgroundColor: '#ffffff', borderWidth: 0 },
          {
            type: 'charOverlap',
            bbox: { x: 8, y: 8, width: 32, height: 32 },
            text: 'H',
            baseline: 24,
            rotation: 0,
            isVertical: false,
            orientation: 'horizontal',
            style: {
              fontFamily: 'Noto Sans KR',
              fontSize: 32,
              color: '#101010',
              bold: false,
              italic: false,
              ratio: 1,
              underline: 'none',
              underlineShape: 0,
              strikethrough: false,
              strikeShape: 0,
              outlineType: 0,
              shadowType: 0,
              shadowColor: '#000000',
              shadowOffsetX: 0,
              shadowOffsetY: 0,
              emboss: false,
              engrave: false,
              emphasisDot: 0,
              underlineColor: '#101010',
              strikeColor: '#101010',
              shadeColor: '#ffffff',
            },
            positions: [0, 32],
            charOverlap: { borderType: 0, innerCharSize: 100 },
          },
        ],
      },
    };
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(
    !charOverlapBaselineProbe.error,
    charOverlapBaselineProbe.error || 'char overlap baseline parity probe available',
  );
  const charOverlapInkBounds = (dataUrl) => {
    const png = PNG.sync.read(pngBufferFromDataUrl(dataUrl));
    let count = 0;
    let minY = png.height;
    let maxY = -1;
    let yTotal = 0;
    for (let y = 0; y < png.height; y += 1) {
      for (let x = 0; x < png.width; x += 1) {
        const offset = (y * png.width + x) * 4;
        if (
          png.data[offset + 3] > 32
          && (png.data[offset] < 220 || png.data[offset + 1] < 220 || png.data[offset + 2] < 220)
        ) {
          count += 1;
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
          yTotal += y;
        }
      }
    }
    return {
      count,
      minY,
      maxY,
      centroidY: count > 0 ? yTotal / count : Number.NaN,
    };
  };
  const charOverlapBaselineBounds = {
    canvas2d: charOverlapInkBounds(charOverlapBaselineProbe.canvas2d),
    canvaskit: charOverlapInkBounds(charOverlapBaselineProbe.canvaskit),
  };
  assert(
    charOverlapBaselineBounds.canvas2d.count > 100
      && charOverlapBaselineBounds.canvaskit.count > 100,
    `char overlap baseline fixture draws ink=${JSON.stringify(charOverlapBaselineBounds)}`,
  );
  assert(
    Math.abs(
      charOverlapBaselineBounds.canvas2d.centroidY
      - charOverlapBaselineBounds.canvaskit.centroidY,
    ) <= 0.6,
    `char overlap middle baseline centroid parity=${JSON.stringify(charOverlapBaselineBounds)}`,
  );
  const charOverlapBaselineDiff = await comparePngBuffers(
    pngBufferFromDataUrl(charOverlapBaselineProbe.canvas2d),
    pngBufferFromDataUrl(charOverlapBaselineProbe.canvaskit),
    {
      diffName: 'canvas-layer-char-overlap-baseline-parity',
      ignoreChannelDelta: 32,
      maxDiffRatio: 0.08,
      inkMaskMaxDiffRatio: 0.04,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    charOverlapBaselineDiff.passed,
    `char overlap baseline parity exact=${charOverlapBaselineDiff.exactDiffPixels}, tolerant=${charOverlapBaselineDiff.rawTolerantDiffPixels}, ink=${charOverlapBaselineDiff.rawInkMaskDiffPixels}, max_channel_delta=${charOverlapBaselineDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-text-style-parity');
  const textStyleParityProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const style = (overrides = {}) => ({
      fontFamily: 'Noto Sans KR',
      fontSize: 16,
      color: '#101010',
      bold: false,
      italic: false,
      ratio: 1,
      underline: 'none',
      underlineShape: 0,
      strikethrough: false,
      strikeShape: 0,
      outlineType: 0,
      shadowType: 0,
      shadowColor: '#000000',
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      emboss: false,
      engrave: false,
      emphasisDot: 0,
      underlineColor: '#101010',
      strikeColor: '#101010',
      shadeColor: '#ffffff',
      ...overrides,
    });
    const textRun = ({ text, x, y, width, styleOverrides }) => ({
      type: 'textRun',
      bbox: { x, y, width, height: 24 },
      text,
      baseline: 18,
      rotation: 0,
      isVertical: false,
      orientation: 'horizontal',
      style: style(styleOverrides),
      positions: Array.from({ length: text.length + 1 }, (_, index) => index * 11),
      controlMarks: [],
      tabLeaders: [],
    });
    const tree = {
      pageWidth: 166,
      pageHeight: 64,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1914,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 1914,
        bounds: { x: 0, y: 0, width: 166, height: 64 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 166, height: 64 }, backgroundColor: '#ffffff', borderWidth: 0 },
          textRun({
            text: 'AB12',
            x: 8,
            y: 8,
            width: 48,
            styleOverrides: {
              shadeColor: '#fff59d',
              underline: 'bottom',
              underlineColor: '#aa0000',
              strikethrough: true,
              strikeColor: '#0044aa',
            },
          }),
          textRun({
            text: 'SH',
            x: 68,
            y: 8,
            width: 34,
            styleOverrides: {
              color: '#008800',
              shadowType: 1,
              shadowColor: '#cc0000',
              shadowOffsetX: 3,
              shadowOffsetY: 2,
            },
          }),
          textRun({
            text: 'OL',
            x: 116,
            y: 30,
            width: 34,
            styleOverrides: {
              color: '#0055cc',
              outlineType: 1,
              emphasisDot: 1,
            },
          }),
        ],
      },
    };
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(
    !textStyleParityProbe.error,
    textStyleParityProbe.error || 'text style parity probe available',
  );
  const textStyleCanvas2dInkPixels = countPixels(
    textStyleParityProbe.canvas2d,
    (pixel) => pixel.alpha > 32 && (pixel.red < 245 || pixel.green < 245 || pixel.blue < 245),
  );
  const textStyleCanvaskitInkPixels = countPixels(
    textStyleParityProbe.canvaskit,
    (pixel) => pixel.alpha > 32 && (pixel.red < 245 || pixel.green < 245 || pixel.blue < 245),
  );
  assert(
    textStyleCanvas2dInkPixels > 450 && textStyleCanvaskitInkPixels > 450,
    `text style replay draws inline effects canvas2d=${textStyleCanvas2dInkPixels}, canvaskit=${textStyleCanvaskitInkPixels}`,
  );
  const textStyleDiff = await comparePngBuffers(
    pngBufferFromDataUrl(textStyleParityProbe.canvas2d),
    pngBufferFromDataUrl(textStyleParityProbe.canvaskit),
    {
      diffName: 'canvas-layer-text-style-parity',
      ignoreChannelDelta: 48,
      maxDiffRatio: 0.22,
      inkMaskMaxDiffRatio: 0.1,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    textStyleDiff.passed,
    `text style parity exact=${textStyleDiff.exactDiffPixels}, tolerant=${textStyleDiff.rawTolerantDiffPixels}, ink=${textStyleDiff.rawInkMaskDiffPixels}, max_channel_delta=${textStyleDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-physical-font-face-parity');
  const physicalFontFaceProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const textRun = (y, bold, italic) => ({
      type: 'textRun',
      bbox: { x: 8, y, width: 144, height: 32 },
      text: '한글AB',
      baseline: 27,
      rotation: 0,
      isVertical: false,
      orientation: 'horizontal',
      style: {
        fontFamily: 'Noto Sans KR',
        fontSize: 28,
        color: '#101010',
        bold,
        italic,
        ratio: 1,
        underline: 'none',
        underlineShape: 0,
        strikethrough: false,
        strikeShape: 0,
        outlineType: 0,
        shadowType: 0,
        shadowColor: '#000000',
        shadowOffsetX: 0,
        shadowOffsetY: 0,
        emboss: false,
        engrave: false,
        emphasisDot: 0,
        underlineColor: '#101010',
        strikeColor: '#101010',
        shadeColor: '#ffffff',
      },
      positions: [0, 30, 60, 82, 104],
      controlMarks: [],
      tabLeaders: [],
    });
    const tree = {
      pageWidth: 160,
      pageHeight: 140,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1919,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 1919,
        bounds: { x: 0, y: 0, width: 160, height: 140 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 160, height: 140 }, backgroundColor: '#ffffff', borderWidth: 0 },
          textRun(2, false, false),
          textRun(36, true, false),
          textRun(70, false, true),
          textRun(104, true, true),
        ],
      },
    };
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(
    !physicalFontFaceProbe.error,
    physicalFontFaceProbe.error || 'physical font face parity probe available',
  );
  const physicalFontFaceInk = (dataUrl) => {
    const png = PNG.sync.read(pngBufferFromDataUrl(dataUrl));
    const rows = [0, 0, 0, 0];
    for (let y = 0; y < png.height; y += 1) {
      for (let x = 0; x < png.width; x += 1) {
        const offset = (y * png.width + x) * 4;
        if (
          png.data[offset + 3] > 32
          && (png.data[offset] < 220 || png.data[offset + 1] < 220 || png.data[offset + 2] < 220)
        ) {
          rows[Math.min(3, Math.floor(y / 34))] += 1;
        }
      }
    }
    return rows;
  };
  const physicalFontFaceInkByBackend = {
    canvas2d: physicalFontFaceInk(physicalFontFaceProbe.canvas2d),
    canvaskit: physicalFontFaceInk(physicalFontFaceProbe.canvaskit),
  };
  for (const [backend, [regular, bold, italic, boldItalic]] of Object.entries(
    physicalFontFaceInkByBackend,
  )) {
    assert(
      regular > 180 && italic > 180,
      `${backend} regular and italic font faces draw ink=${regular},${italic}`,
    );
    assert(
      bold > regular * 1.1 && boldItalic > italic * 1.1,
      `${backend} physical bold faces are visibly heavier regular=${regular}, bold=${bold}, italic=${italic}, boldItalic=${boldItalic}`,
    );
  }
  const physicalFontFaceDiff = await comparePngBuffers(
    pngBufferFromDataUrl(physicalFontFaceProbe.canvas2d),
    pngBufferFromDataUrl(physicalFontFaceProbe.canvaskit),
    {
      diffName: 'canvas-layer-physical-font-face-parity',
      ignoreChannelDelta: 48,
      maxDiffRatio: 0.2,
      inkMaskMaxDiffRatio: 0.12,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    physicalFontFaceDiff.passed,
    `physical font face parity exact=${physicalFontFaceDiff.exactDiffPixels}, tolerant=${physicalFontFaceDiff.rawTolerantDiffPixels}, ink=${physicalFontFaceDiff.rawInkMaskDiffPixels}, max_channel_delta=${physicalFontFaceDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-text-script-parity');
  const textScriptParityProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const textRun = ({
      text,
      x,
      y,
      width,
      color,
      superscript = false,
      subscript = false,
      bold = false,
      italic = false,
      positions,
      displayText,
      displayPositions,
    }) => {
      const op = {
        type: 'textRun',
        bbox: { x, y, width, height: 38 },
        text,
        baseline: 26,
        rotation: 0,
        isVertical: false,
        orientation: 'horizontal',
        isParaEnd: false,
        isLineBreakEnd: false,
        style: {
          fontFamily: 'Noto Sans KR',
          fontSize: 22,
          color,
          bold,
          italic,
          superscript,
          subscript,
          ratio: 1,
          underline: 'none',
          underlineShape: 0,
          strikethrough: false,
          strikeShape: 0,
          outlineType: 0,
          shadowType: 0,
          shadowColor: '#000000',
          shadowOffsetX: 0,
          shadowOffsetY: 0,
          emboss: false,
          engrave: false,
          emphasisDot: 0,
          underlineColor: color,
          strikeColor: color,
          shadeColor: '#ffffff',
        },
        positions: positions
          ?? Array.from({ length: text.length + 1 }, (_, index) => index * 16),
        controlMarks: [],
        tabLeaders: [],
      };
      if (displayText !== undefined) {
        op.displayText = displayText;
      }
      if (displayPositions !== undefined) {
        op.displayPositions = displayPositions;
      }
      return op;
    };
    const tree = {
      pageWidth: 320,
      pageHeight: 148,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 2191,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 2191,
        bounds: { x: 0, y: 0, width: 320, height: 148 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 320, height: 148 }, backgroundColor: '#ffffff', borderWidth: 0 },
          textRun({
            text: 'ABC',
            x: 8,
            y: 6,
            width: 52,
            color: '#008000',
            positions: [0, 16, 32, 48],
          }),
          textRun({
            text: 'ABC',
            x: 88,
            y: 6,
            width: 52,
            color: '#d00000',
            superscript: true,
            positions: [0, 16, 32, 48],
          }),
          textRun({
            text: 'ABC',
            x: 168,
            y: 6,
            width: 52,
            color: '#0044d0',
            subscript: true,
            positions: [0, 16, 32, 48],
          }),
          textRun({
            text: '한글',
            x: 8,
            y: 54,
            width: 56,
            color: '#202020',
            superscript: true,
            positions: [0, 22, 44],
          }),
          textRun({
            text: 'e\u0301',
            x: 88,
            y: 54,
            width: 44,
            color: '#202020',
            subscript: true,
            positions: [0, 18, 18],
          }),
          textRun({
            text: String.fromCodePoint(0xf012b),
            displayText: '(인)',
            x: 160,
            y: 54,
            width: 70,
            color: '#202020',
            superscript: true,
            positions: [0, 35, 35],
            displayPositions: [0, 9, 27, 36],
          }),
          textRun({
            text: '한글',
            x: 8,
            y: 102,
            width: 132,
            color: '#006060',
            superscript: true,
            positions: [0, 62, 86],
          }),
          textRun({
            text: '한글',
            x: 168,
            y: 102,
            width: 132,
            color: '#600060',
            superscript: true,
            bold: true,
            italic: true,
            positions: [0, 62, 86],
          }),
        ],
      },
    };
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(
    !textScriptParityProbe.error,
    textScriptParityProbe.error || 'text script parity probe available',
  );
  const textScriptStats = {};
  for (const [backend, dataUrl] of Object.entries(textScriptParityProbe)) {
    const png = PNG.sync.read(pngBufferFromDataUrl(dataUrl));
    const stats = {
      superscript: { count: 0, yTotal: 0 },
      normal: { count: 0, yTotal: 0 },
      subscript: { count: 0, yTotal: 0 },
      complexInk: [0, 0, 0],
    };
    for (let y = 0; y < png.height; y += 1) {
      for (let x = 0; x < png.width; x += 1) {
        const offset = (y * png.width + x) * 4;
        const red = png.data[offset];
        const green = png.data[offset + 1];
        const blue = png.data[offset + 2];
        const alpha = png.data[offset + 3];
        if (alpha <= 32) {
          continue;
        }
        if (red > green + 35 && red > blue + 35) {
          stats.superscript.count += 1;
          stats.superscript.yTotal += y;
        } else if (green > red + 35 && green > blue + 20) {
          stats.normal.count += 1;
          stats.normal.yTotal += y;
        } else if (blue > red + 35 && blue > green + 20) {
          stats.subscript.count += 1;
          stats.subscript.yTotal += y;
        }
        if (y >= 48 && (red < 230 || green < 230 || blue < 230)) {
          if (x < 72) {
            stats.complexInk[0] += 1;
          } else if (x >= 80 && x < 144) {
            stats.complexInk[1] += 1;
          } else if (x >= 152) {
            stats.complexInk[2] += 1;
          }
        }
      }
    }
    textScriptStats[backend] = stats;
  }
  for (const [backend, stats] of Object.entries(textScriptStats)) {
    assert(
      stats.superscript.count > 30 && stats.normal.count > 60 && stats.subscript.count > 30,
      `${backend} script text draws colored runs superscript=${stats.superscript.count}, normal=${stats.normal.count}, subscript=${stats.subscript.count}`,
    );
    const superscriptMeanY = stats.superscript.yTotal / stats.superscript.count;
    const normalMeanY = stats.normal.yTotal / stats.normal.count;
    const subscriptMeanY = stats.subscript.yTotal / stats.subscript.count;
    assert(
      superscriptMeanY < normalMeanY - 1.5 && subscriptMeanY > normalMeanY + 1,
      `${backend} script baseline order superscript=${superscriptMeanY.toFixed(2)}, normal=${normalMeanY.toFixed(2)}, subscript=${subscriptMeanY.toFixed(2)}`,
    );
    assert(
      stats.complexInk.every((count) => count > 12),
      `${backend} script shaping draws Korean/combining/PUA runs ink=${stats.complexInk.join(',')}`,
    );
  }
  const positionedScriptInk = (dataUrl) => {
    const png = PNG.sync.read(pngBufferFromDataUrl(dataUrl));
    const windows = [
      { minX: 4, maxX: 42 },
      { minX: 64, maxX: 108 },
      { minX: 160, maxX: 208 },
      { minX: 224, maxX: 276 },
    ];
    const counts = windows.map(() => 0);
    for (let y = 96; y < png.height; y += 1) {
      for (let x = 0; x < png.width; x += 1) {
        const offset = (y * png.width + x) * 4;
        if (
          png.data[offset + 3] <= 32
          || (png.data[offset] >= 230 && png.data[offset + 1] >= 230 && png.data[offset + 2] >= 230)
        ) {
          continue;
        }
        windows.forEach((window, index) => {
          if (x >= window.minX && x < window.maxX) {
            counts[index] += 1;
          }
        });
      }
    }
    return counts;
  };
  const positionedScriptInkByBackend = {
    canvas2d: positionedScriptInk(textScriptParityProbe.canvas2d),
    canvaskit: positionedScriptInk(textScriptParityProbe.canvaskit),
  };
  for (const [backend, counts] of Object.entries(positionedScriptInkByBackend)) {
    assert(
      counts.every((count) => count > 12),
      `${backend} script graphemes preserve authored gaps ink=${counts.join(',')}`,
    );
    assert(
      counts[2] + counts[3] > (counts[0] + counts[1]) * 1.08,
      `${backend} script paragraph preserves bold+italic style regular=${counts[0] + counts[1]}, boldItalic=${counts[2] + counts[3]}`,
    );
  }
  const textScriptDiff = await comparePngBuffers(
    pngBufferFromDataUrl(textScriptParityProbe.canvas2d),
    pngBufferFromDataUrl(textScriptParityProbe.canvaskit),
    {
      diffName: 'canvas-layer-text-script-parity',
      ignoreChannelDelta: 48,
      maxDiffRatio: 0.24,
      inkMaskMaxDiffRatio: 0.16,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    textScriptDiff.passed,
    `text script parity exact=${textScriptDiff.exactDiffPixels}, tolerant=${textScriptDiff.rawTolerantDiffPixels}, ink=${textScriptDiff.rawInkMaskDiffPixels}, max_channel_delta=${textScriptDiff.maxChannelDelta}`,
  );

  setTestCase('canvaskit-text-complex-grapheme-paragraph-shaping');
  const complexGraphemeParagraphProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const paragraphBuilder = canvaskitRenderer.canvasKit?.ParagraphBuilder;
    const originalMakeFromFontProvider = paragraphBuilder?.MakeFromFontProvider;
    if (!paragraphBuilder || typeof originalMakeFromFontProvider !== 'function') {
      return { error: 'CanvasKit ParagraphBuilder unavailable' };
    }
    const textRun = (text, positions, x, width, color) => ({
      type: 'textRun',
      bbox: { x, y: 10, width, height: 44 },
      text,
      baseline: 36,
      rotation: 0,
      isVertical: false,
      orientation: 'horizontal',
      isParaEnd: false,
      isLineBreakEnd: false,
      style: {
        fontFamily: 'Noto Sans KR',
        fontSize: 30,
        color,
        bold: false,
        italic: false,
        superscript: false,
        subscript: false,
        ratio: 1,
        underline: 'none',
        underlineShape: 0,
        strikethrough: false,
        strikeShape: 0,
        outlineType: 0,
        shadowType: 0,
        shadowColor: '#000000',
        shadowOffsetX: 0,
        shadowOffsetY: 0,
        emboss: false,
        engrave: false,
        emphasisDot: 0,
        underlineColor: color,
        strikeColor: color,
        shadeColor: '#ffffff',
      },
      positions,
      controlMarks: [],
      tabLeaders: [],
    });
    const tree = {
      pageWidth: 360,
      pageHeight: 64,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 2193,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 2193,
        bounds: { x: 0, y: 0, width: 360, height: 64 },
        cacheHint: 'none',
        ops: [
          {
            type: 'pageBackground',
            bbox: { x: 0, y: 0, width: 360, height: 64 },
            backgroundColor: '#ffffff',
            borderWidth: 0,
          },
          textRun('\u0634\u064f', [0, 0, 52], 18, 70, '#c02020'),
          textRun('\u0915\u094d\u0937\u093f', [0, 0, 0, 0, 64], 140, 90, '#16803a'),
          textRun('e\u0301', [0, 0, 44], 286, 58, '#2050c0'),
        ],
      },
    };
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    let paragraphBuildCalls = 0;
    paragraphBuilder.MakeFromFontProvider = function (...args) {
      paragraphBuildCalls += 1;
      return originalMakeFromFontProvider.apply(this, args);
    };
    try {
      return {
        canvas2d: await render(canvas2dRenderer),
        canvaskit: await render(canvaskitRenderer),
        paragraphBuildCalls,
      };
    } finally {
      paragraphBuilder.MakeFromFontProvider = originalMakeFromFontProvider;
    }
  });
  assert(
    !complexGraphemeParagraphProbe.error,
    complexGraphemeParagraphProbe.error
      || 'CanvasKit complex grapheme Paragraph shaping probe available',
  );
  assert(
    complexGraphemeParagraphProbe.paragraphBuildCalls >= 3,
    `CanvasKit ordinary Arabic/Devanagari/combining TextRuns shape through Paragraph calls=${complexGraphemeParagraphProbe.paragraphBuildCalls}`,
  );
  const complexGraphemePlacement = {};
  const authoredComplexRuns = [
    { name: 'Arabic', x: 18, width: 70 },
    { name: 'Devanagari', x: 140, width: 90 },
    { name: 'combining', x: 286, width: 58 },
  ];
  for (const [backend, dataUrl] of Object.entries({
    canvas2d: complexGraphemeParagraphProbe.canvas2d,
    canvaskit: complexGraphemeParagraphProbe.canvaskit,
  })) {
    const png = PNG.sync.read(pngBufferFromDataUrl(dataUrl));
    const stats = authoredComplexRuns.map(() => ({
      count: 0,
      minX: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
    }));
    for (let y = 0; y < png.height; y += 1) {
      for (let x = 0; x < png.width; x += 1) {
        const offset = (y * png.width + x) * 4;
        const red = png.data[offset];
        const green = png.data[offset + 1];
        const blue = png.data[offset + 2];
        const alpha = png.data[offset + 3];
        let runIndex = -1;
        if (alpha > 32 && red > 100 && red > green + 50 && red > blue + 50) {
          runIndex = 0;
        } else if (alpha > 32 && green > 80 && green > red + 45 && green > blue + 35) {
          runIndex = 1;
        } else if (alpha > 32 && blue > 100 && blue > red + 50 && blue > green + 50) {
          runIndex = 2;
        }
        if (runIndex >= 0) {
          stats[runIndex].count += 1;
          stats[runIndex].minX = Math.min(stats[runIndex].minX, x);
          stats[runIndex].maxX = Math.max(stats[runIndex].maxX, x);
        }
      }
    }
    complexGraphemePlacement[backend] = stats;
  }
  for (const [backend, stats] of Object.entries(complexGraphemePlacement)) {
    const combiningIndex = 2;
    const combining = stats[combiningIndex];
    const authored = authoredComplexRuns[combiningIndex];
    assert(
      combining.count > 20,
      `${backend} supported combining grapheme draws visible ink=${combining.count}`,
    );
    assert(
      combining.minX >= authored.x - 2
        && combining.minX < authored.x + 24
        && combining.maxX > authored.x + 4
        && combining.maxX <= authored.x + authored.width,
      `${backend} supported combining grapheme preserves authored placement x=${authored.x}, ink=${combining.minX}-${combining.maxX}`,
    );
  }
  const complexGraphemeDiff = await comparePngBuffers(
    pngBufferFromDataUrl(complexGraphemeParagraphProbe.canvas2d),
    pngBufferFromDataUrl(complexGraphemeParagraphProbe.canvaskit),
    {
      diffName: 'canvas-layer-text-complex-grapheme-parity',
      ignoreChannelDelta: 48,
      maxDiffRatio: 0.18,
      inkMaskMaxDiffRatio: 0.1,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    complexGraphemeDiff.passed,
    `complex grapheme parity exact=${complexGraphemeDiff.exactDiffPixels}, tolerant=${complexGraphemeDiff.rawTolerantDiffPixels}, ink=${complexGraphemeDiff.rawInkMaskDiffPixels}, max_channel_delta=${complexGraphemeDiff.maxChannelDelta}`,
  );

  setTestCase('canvaskit-text-font-substitution-diagnostics');
  const fontSubstitutionProbe = await page.evaluate(async () => {
    const renderer = window.__canvasView?.pageRenderer?.canvaskitRenderer;
    if (!renderer) {
      return { error: 'CanvasKit renderer unavailable' };
    }
    const textRun = (id, text, fontFamily, y) => ({
      id,
      type: 'textRun',
      bbox: { x: 10, y, width: 240, height: 26 },
      text,
      baseline: 20,
      rotation: 0,
      isVertical: false,
      orientation: 'horizontal',
      isParaEnd: false,
      isLineBreakEnd: false,
      style: {
        fontFamily,
        fontSize: 18,
        color: '#202020',
        bold: false,
        italic: false,
        superscript: false,
        subscript: false,
        ratio: 1,
        underline: 'none',
        underlineShape: 0,
        strikethrough: false,
        strikeShape: 0,
        outlineType: 0,
        shadowType: 0,
        shadowColor: '#000000',
        shadowOffsetX: 0,
        shadowOffsetY: 0,
        emboss: false,
        engrave: false,
        emphasisDot: 0,
        underlineColor: '#202020',
        strikeColor: '#202020',
        shadeColor: '#ffffff',
      },
      positions: Array.from({ length: text.length + 1 }, (_, index) => index * 15),
      controlMarks: [],
      tabLeaders: [],
    });
    const tree = {
      pageWidth: 260,
      pageHeight: 92,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 2194,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 2194,
        bounds: { x: 0, y: 0, width: 260, height: 92 },
        cacheHint: 'none',
        ops: [
          {
            type: 'pageBackground',
            bbox: { x: 0, y: 0, width: 260, height: 92 },
            backgroundColor: '#ffffff',
            borderWidth: 0,
          },
          textRun('font-known', 'Known', 'Noto Sans KR', 4),
          textRun('font-weight-alias', 'Mapped', 'Noto Serif KR Extra Bold', 32),
          textRun('font-missing', 'Fallback', 'RHWP Definitely Missing Font', 60),
        ],
      },
    };
    const canvas = document.createElement('canvas');
    canvas.width = tree.pageWidth;
    canvas.height = tree.pageHeight;
    document.body.appendChild(canvas);
    renderer.renderPage(tree, canvas, 1);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const png = canvas.toDataURL('image/png');
    const diagnostics = renderer.getTextReplayDiagnostics();
    renderer.resetDocumentResources();
    const afterReset = renderer.getTextReplayDiagnostics();
    canvas.remove();
    return { png, diagnostics, afterReset };
  });
  assert(
    !fontSubstitutionProbe.error,
    fontSubstitutionProbe.error || 'CanvasKit font substitution diagnostics probe available',
  );
  const fontSubstitutionInk = countPixels(
    fontSubstitutionProbe.png,
    ({ red, green, blue, alpha }) => (
      alpha > 32 && (red < 230 || green < 230 || blue < 230)
    ),
  );
  assert(
    fontSubstitutionInk > 180,
    `CanvasKit renders registered and substituted TextRun families ink=${fontSubstitutionInk}`,
  );
  assert(
    fontSubstitutionProbe.diagnostics.fontSubstitutions.some(
      (diagnostic) => (
        diagnostic.opId === 'font-weight-alias'
        && diagnostic.requestedFamily === 'Noto Serif KR Extra Bold'
        && diagnostic.resolvedFamily === 'Noto Serif KR'
        && diagnostic.source === 'weightSuffixAlias'
        && diagnostic.kind === 'mappedAlias'
      ),
    ),
    `CanvasKit reports intentional weight-suffix mapping=${JSON.stringify(fontSubstitutionProbe.diagnostics)}`,
  );
  assert(
    !fontSubstitutionProbe.diagnostics.fontSubstitutions.some(
      (diagnostic) => diagnostic.opId === 'font-known',
    ),
    `CanvasKit does not report a directly registered family as substituted=${JSON.stringify(fontSubstitutionProbe.diagnostics)}`,
  );
  assert(
    fontSubstitutionProbe.diagnostics.unregisteredFontFallbacks === 1
      && fontSubstitutionProbe.diagnostics.fontSubstitutions.some(
        (diagnostic) => (
          diagnostic.opId === 'font-missing'
          && diagnostic.requestedFamily === 'RHWP Definitely Missing Font'
          && diagnostic.source === 'fallbackCandidate'
          && diagnostic.kind === 'unregisteredFallback'
        ),
      ),
    `CanvasKit exposes unregistered font fallback without suppressing replay=${JSON.stringify(fontSubstitutionProbe.diagnostics)}`,
  );
  assert(
    fontSubstitutionProbe.afterReset.unregisteredFontFallbacks === 0
      && fontSubstitutionProbe.afterReset.fontSubstitutions.length === 0,
    `CanvasKit document reset clears font substitution diagnostics=${JSON.stringify(fontSubstitutionProbe.afterReset)}`,
  );

  setTestCase('canvas-layer-hancom-pua-display-parity');
  const hancomPuaDisplayProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const rawText = [
      0xF0A0,
      0xF0E8,
      0xF003B,
      0xF02EF,
      0xF03EF,
      0xF03F0,
      0xF03F1,
      0xF03F2,
      0xF03F3,
      0xF03F4,
      0xF080F,
      0xF0811,
      0xF0817,
      0xF081A,
      0xF0854,
      0xF0855,
    ].map((codePoint) => String.fromCodePoint(codePoint)).join('');
    const textStyle = {
      fontFamily: 'Noto Sans KR',
      fontSize: 22,
      color: '#202020',
      bold: false,
      italic: false,
      ratio: 1,
      underline: 'none',
      underlineShape: 0,
      strikethrough: false,
      strikeShape: 0,
      outlineType: 0,
      shadowType: 0,
      shadowColor: '#000000',
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      emboss: false,
      engrave: false,
      emphasisDot: 0,
      underlineColor: '#202020',
      strikeColor: '#202020',
      shadeColor: '#ffffff',
    };
    const productFragment = ({ text, displayText, x, displayPositions }) => ({
      type: 'textRun',
      bbox: {
        x,
        y: 52,
        width: displayPositions?.at(-1) ?? 22,
        height: 38,
      },
      text,
      ...(displayText !== undefined ? { displayText, displayPositions } : {}),
      baseline: 30,
      rotation: 0,
      isVertical: false,
      orientation: 'horizontal',
      isParaEnd: false,
      isLineBreakEnd: false,
      style: textStyle,
      positions: displayText === '' ? [0, 0] : [0, 22],
      controlMarks: [],
      tabLeaders: [],
    });
    const tree = {
      pageWidth: 420,
      pageHeight: 96,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 2192,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 2192,
        bounds: { x: 0, y: 0, width: 420, height: 96 },
        cacheHint: 'none',
        ops: [
          {
            type: 'pageBackground',
            bbox: { x: 0, y: 0, width: 420, height: 96 },
            backgroundColor: '#ffffff',
            borderWidth: 0,
          },
          {
            type: 'textRun',
            bbox: { x: 8, y: 6, width: 404, height: 38 },
            text: rawText,
            baseline: 30,
            rotation: 0,
            isVertical: false,
            orientation: 'horizontal',
            isParaEnd: false,
            isLineBreakEnd: false,
            style: textStyle,
            positions: Array.from({ length: 17 }, (_, index) => index * 22),
            controlMarks: [],
            tabLeaders: [],
          },
          productFragment({
            text: 'ᄒ',
            displayText: '한',
            x: 8,
            displayPositions: [0, 22],
          }),
          productFragment({
            text: 'ᆞ',
            displayText: '',
            x: 100,
            displayPositions: [],
          }),
          productFragment({
            text: 'ᆫ',
            displayText: '',
            x: 140,
            displayPositions: [],
          }),
          productFragment({ text: '글', x: 32 }),
        ],
      },
    };
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(
    !hancomPuaDisplayProbe.error,
    hancomPuaDisplayProbe.error || 'Hancom PUA display parity probe available',
  );
  for (const [backend, dataUrl] of Object.entries(hancomPuaDisplayProbe)) {
    const inkPixels = countPixels(
      dataUrl,
      ({ red, green, blue, alpha }) => (
        alpha > 32 && (red < 220 || green < 220 || blue < 220)
      ),
    );
    assert(
      inkPixels > 150,
      `${backend} maps raw verified Hancom PUA through the shared display policy ink=${inkPixels}`,
    );
    const png = PNG.sync.read(pngBufferFromDataUrl(dataUrl));
    let productInk = 0;
    let collapsedSourceInk = 0;
    for (let y = 48; y < png.height; y += 1) {
      for (let x = 0; x < png.width; x += 1) {
        const offset = (y * png.width + x) * 4;
        const isInk = png.data[offset + 3] > 32
          && (png.data[offset] < 220 || png.data[offset + 1] < 220 || png.data[offset + 2] < 220);
        if (!isInk) {
          continue;
        }
        if (x < 72) {
          productInk += 1;
        } else if (x >= 80 && x < 180) {
          collapsedSourceInk += 1;
        }
      }
    }
    assert(
      productInk > 80 && collapsedSourceInk === 0,
      `${backend} paints the projected product name without collapsed source fragments product=${productInk}, collapsed=${collapsedSourceInk}`,
    );
  }
  const hancomPuaDisplayDiff = await comparePngBuffers(
    pngBufferFromDataUrl(hancomPuaDisplayProbe.canvas2d),
    pngBufferFromDataUrl(hancomPuaDisplayProbe.canvaskit),
    {
      diffName: 'canvas-layer-hancom-pua-display-parity',
      ignoreChannelDelta: 48,
      maxDiffRatio: 0.24,
      inkMaskMaxDiffRatio: 0.16,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    hancomPuaDisplayDiff.passed,
    `Hancom PUA display parity exact=${hancomPuaDisplayDiff.exactDiffPixels}, tolerant=${hancomPuaDisplayDiff.rawTolerantDiffPixels}, ink=${hancomPuaDisplayDiff.rawInkMaskDiffPixels}, max_channel_delta=${hancomPuaDisplayDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-text-fallback-font-parity');
  const textFallbackFontProbe = await page.evaluate(async () => {
    const { loadWebFonts } = await import('/src/core/font-loader.ts');
    await loadWebFonts([], undefined, { includeDirectRendererFallbacks: true });
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const supplementaryMathLetter = '\u{1D400}';
    const oldHangulText = 'ᄒᆞᆫ';
    const squareMetreText = '㎡';
    const text = `A₩①◆☀€${supplementaryMathLetter}${oldHangulText}`;
    const tree = {
      pageWidth: 184,
      pageHeight: 70,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1936,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 1936,
        bounds: { x: 0, y: 0, width: 184, height: 70 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 184, height: 70 }, backgroundColor: '#ffffff', borderWidth: 0 },
          {
            type: 'textRun',
            bbox: { x: 8, y: 6, width: 168, height: 26 },
            text,
            baseline: 22,
            rotation: 0,
            isVertical: false,
            orientation: 'horizontal',
            isParaEnd: false,
            isLineBreakEnd: false,
            style: {
              fontFamily: 'Noto Serif KR Extra Bold',
              fontSize: 18,
              color: '#111111',
              bold: false,
              italic: false,
              ratio: 1,
              underline: 'none',
              underlineShape: 0,
              strikethrough: false,
              strikeShape: 0,
              outlineType: 0,
              shadowType: 0,
              shadowColor: '#000000',
              shadowOffsetX: 0,
              shadowOffsetY: 0,
              emboss: false,
              engrave: false,
              emphasisDot: 0,
              shadeColor: '#ffffff',
            },
            positions: Array.from(
              { length: Array.from(text).length + 1 },
              (_, index) => index * 17,
            ),
            controlMarks: [],
            tabLeaders: [],
          },
          {
            type: 'textRun',
            bbox: { x: 8, y: 38, width: 32, height: 26 },
            text: squareMetreText,
            baseline: 20,
            rotation: 0,
            isVertical: false,
            orientation: 'horizontal',
            isParaEnd: false,
            isLineBreakEnd: false,
            style: {
              fontFamily: 'Noto Serif KR Extra Bold',
              fontSize: 18,
              color: '#111111',
              bold: false,
              italic: false,
              ratio: 1,
              underline: 'none',
              underlineShape: 0,
              strikethrough: false,
              strikeShape: 0,
              outlineType: 0,
              shadowType: 0,
              shadowColor: '#000000',
              shadowOffsetX: 0,
              shadowOffsetY: 0,
              emboss: false,
              engrave: false,
              emphasisDot: 0,
              shadeColor: '#ffffff',
            },
            positions: [0, 24],
            controlMarks: [],
            tabLeaders: [],
          },
        ],
      },
    };
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await nextFrame();
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    const canvas2d = await render(canvas2dRenderer);
    const makeTextRequests = [];
    const originalMakeTextObjects = canvaskitRenderer.makeTextObjects;
    canvaskitRenderer.makeTextObjects = function makeTextObjectsProbe(fontFamily) {
      const objects = originalMakeTextObjects.apply(this, arguments);
      makeTextRequests.push({
        fontFamily,
        weight: arguments[6],
        supplementaryGlyphIds: fontFamily === 'Latin Modern Math'
          ? Array.from(objects.font.getGlyphIDs(supplementaryMathLetter))
          : undefined,
        oldHangulGlyphIds: fontFamily === 'Source Han Serif K Old Hangul'
          ? Array.from(objects.font.getGlyphIDs(oldHangulText))
          : undefined,
        squareMetreGlyphIds: fontFamily === 'D2Coding'
          ? Array.from(objects.font.getGlyphIDs(squareMetreText))
          : undefined,
      });
      return objects;
    };
    try {
      return {
        canvas2d,
        canvaskit: await render(canvaskitRenderer),
        makeTextRequests,
        supplementaryFontLoaded: document.fonts.check(
          '400 16px "Latin Modern Math"',
          supplementaryMathLetter,
        ),
        oldHangulFontLoaded: document.fonts.check(
          '400 18px "Source Han Serif K Old Hangul"',
          oldHangulText,
        ),
        squareMetreFontLoaded: document.fonts.check(
          '400 18px "D2Coding"',
          squareMetreText,
        ),
      };
    } finally {
      canvaskitRenderer.makeTextObjects = originalMakeTextObjects;
    }
  });
  assert(
    !textFallbackFontProbe.error,
    textFallbackFontProbe.error || 'text fallback font parity probe available',
  );
  assert(
    textFallbackFontProbe.makeTextRequests.some(
      ({ fontFamily, weight }) => fontFamily === 'Noto Serif KR Extra Bold' && weight === 700,
    ),
    `CanvasKit resolves the family weight suffix=${JSON.stringify(textFallbackFontProbe.makeTextRequests)}`,
  );
  assert(
    textFallbackFontProbe.makeTextRequests.some(
      ({ fontFamily, weight }) => fontFamily === 'Malgun Gothic' && weight === 700,
    ) && textFallbackFontProbe.makeTextRequests.some(
      ({ fontFamily, weight }) => fontFamily === 'GulimChe' && weight === 700,
    ),
    `CanvasKit text fallback keeps the inferred weight for currency and symbol clusters=${JSON.stringify(textFallbackFontProbe.makeTextRequests)}`,
  );
  assert(
    textFallbackFontProbe.supplementaryFontLoaded === true
      && textFallbackFontProbe.makeTextRequests.some(
        ({ fontFamily, weight, supplementaryGlyphIds }) => (
          fontFamily === 'Latin Modern Math'
          && weight === 700
          && supplementaryGlyphIds?.every((glyphId) => glyphId !== 0)
        ),
      ),
    `both browser renderers load the checked-in supplementary fallback and CanvasKit resolves its glyph loaded=${textFallbackFontProbe.supplementaryFontLoaded}, requests=${JSON.stringify(textFallbackFontProbe.makeTextRequests)}`,
  );
  assert(
    textFallbackFontProbe.oldHangulFontLoaded === true
      && textFallbackFontProbe.makeTextRequests.some(
        ({ fontFamily, oldHangulGlyphIds }) => (
          fontFamily === 'Source Han Serif K Old Hangul'
          && oldHangulGlyphIds?.length === 3
          && oldHangulGlyphIds.every((glyphId) => glyphId !== 0)
        ),
      ),
    `both browser renderers load the old-Hangul fallback and CanvasKit resolves every jamo loaded=${textFallbackFontProbe.oldHangulFontLoaded}, requests=${JSON.stringify(textFallbackFontProbe.makeTextRequests)}`,
  );
  assert(
    textFallbackFontProbe.squareMetreFontLoaded === true
      && textFallbackFontProbe.makeTextRequests.some(
        ({ fontFamily, squareMetreGlyphIds }) => (
          fontFamily === 'D2Coding'
          && squareMetreGlyphIds?.length === 1
          && squareMetreGlyphIds[0] !== 0
        ),
      ),
    `both browser renderers load the square-metre fallback and CanvasKit resolves U+33A1 loaded=${textFallbackFontProbe.squareMetreFontLoaded}, requests=${JSON.stringify(textFallbackFontProbe.makeTextRequests)}`,
  );
  const textFallbackCanvas2dInkPixels = countPixels(
    textFallbackFontProbe.canvas2d,
    (pixel) => pixel.alpha > 32 && pixel.red < 245 && pixel.green < 245 && pixel.blue < 245,
  );
  const textFallbackCanvaskitInkPixels = countPixels(
    textFallbackFontProbe.canvaskit,
    (pixel) => pixel.alpha > 32 && pixel.red < 245 && pixel.green < 245 && pixel.blue < 245,
  );
  assert(
    textFallbackCanvas2dInkPixels > 160 && textFallbackCanvaskitInkPixels > 160,
    `text fallback font replay draws glyphs canvas2d=${textFallbackCanvas2dInkPixels}, canvaskit=${textFallbackCanvaskitInkPixels}`,
  );
  const supplementaryFallbackInkPixels = {};
  for (const backend of ['canvas2d', 'canvaskit']) {
    const png = PNG.sync.read(pngBufferFromDataUrl(textFallbackFontProbe[backend]));
    let inkPixels = 0;
    for (let y = 0; y < png.height; y += 1) {
      for (let x = 106; x < Math.min(126, png.width); x += 1) {
        const offset = (y * png.width + x) * 4;
        if (
          png.data[offset + 3] > 32
          && (png.data[offset] < 245 || png.data[offset + 1] < 245 || png.data[offset + 2] < 245)
        ) {
          inkPixels += 1;
        }
      }
    }
    supplementaryFallbackInkPixels[backend] = inkPixels;
  }
  assert(
    supplementaryFallbackInkPixels.canvas2d > 20
      && supplementaryFallbackInkPixels.canvaskit > 20,
    `supplementary-plane fallback draws the math letter=${JSON.stringify(supplementaryFallbackInkPixels)}`,
  );
  const oldHangulInk = {};
  for (const backend of ['canvas2d', 'canvaskit']) {
    const png = PNG.sync.read(pngBufferFromDataUrl(textFallbackFontProbe[backend]));
    let count = 0;
    let maxX = -1;
    for (let y = 0; y < png.height; y += 1) {
      for (let x = 126; x < png.width; x += 1) {
        const offset = (y * png.width + x) * 4;
        if (
          png.data[offset + 3] > 32
          && (png.data[offset] < 245 || png.data[offset + 1] < 245 || png.data[offset + 2] < 245)
        ) {
          count += 1;
          maxX = Math.max(maxX, x);
        }
      }
    }
    oldHangulInk[backend] = { count, maxX };
  }
  assert(
    oldHangulInk.canvas2d.count > 20
      && oldHangulInk.canvaskit.count > 20
      && oldHangulInk.canvas2d.maxX < 160
      && oldHangulInk.canvaskit.maxX < 160,
    `old-Hangul fallback shapes one compact cluster=${JSON.stringify(oldHangulInk)}`,
  );
  const squareMetreInkPixels = {};
  for (const backend of ['canvas2d', 'canvaskit']) {
    const png = PNG.sync.read(pngBufferFromDataUrl(textFallbackFontProbe[backend]));
    let inkPixels = 0;
    for (let y = 34; y < png.height; y += 1) {
      for (let x = 4; x < 42; x += 1) {
        const offset = (y * png.width + x) * 4;
        if (
          png.data[offset + 3] > 32
          && (png.data[offset] < 245 || png.data[offset + 1] < 245 || png.data[offset + 2] < 245)
        ) {
          inkPixels += 1;
        }
      }
    }
    squareMetreInkPixels[backend] = inkPixels;
  }
  assert(
    squareMetreInkPixels.canvas2d > 20 && squareMetreInkPixels.canvaskit > 20,
    `square-metre fallback draws U+33A1 in both renderers=${JSON.stringify(squareMetreInkPixels)}`,
  );
  const textFallbackFontDiff = await comparePngBuffers(
    pngBufferFromDataUrl(textFallbackFontProbe.canvas2d),
    pngBufferFromDataUrl(textFallbackFontProbe.canvaskit),
    {
      diffName: 'canvas-layer-text-fallback-font-parity',
      ignoreChannelDelta: 48,
      maxDiffRatio: 0.22,
      inkMaskMaxDiffRatio: 0.14,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    textFallbackFontDiff.passed,
    `text fallback font parity exact=${textFallbackFontDiff.exactDiffPixels}, tolerant=${textFallbackFontDiff.rawTolerantDiffPixels}, ink=${textFallbackFontDiff.rawInkMaskDiffPixels}, max_channel_delta=${textFallbackFontDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-text-shade-emboss-engrave-parity');
  const textEffectParityProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const style = (overrides = {}) => ({
      fontFamily: 'Noto Sans KR',
      fontSize: 17,
      color: '#111111',
      bold: false,
      italic: false,
      ratio: 1,
      underline: 'none',
      underlineShape: 0,
      strikethrough: false,
      strikeShape: 0,
      outlineType: 0,
      shadowType: 0,
      shadowColor: '#000000',
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      emboss: false,
      engrave: false,
      emphasisDot: 0,
      underlineColor: '#111111',
      strikeColor: '#111111',
      shadeColor: '#ffffff',
      ...overrides,
    });
    const textRun = ({ text, x, y, width, styleOverrides }) => ({
      type: 'textRun',
      bbox: { x, y, width, height: 30 },
      text,
      baseline: 23,
      rotation: 0,
      isVertical: false,
      orientation: 'horizontal',
      style: style(styleOverrides),
      positions: Array.from({ length: text.length + 1 }, (_, index) => index * 13),
      controlMarks: [],
      tabLeaders: [],
    });
    const tree = {
      pageWidth: 150,
      pageHeight: 62,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1920,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 1920,
        bounds: { x: 0, y: 0, width: 150, height: 62 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 150, height: 62 }, backgroundColor: '#ffffff', borderWidth: 0 },
          textRun({
            text: 'SHADE',
            x: 8,
            y: 6,
            width: 70,
            styleOverrides: { shadeColor: '#ffee66' },
          }),
          textRun({
            text: 'EMB',
            x: 84,
            y: 6,
            width: 44,
            styleOverrides: { emboss: true, color: '#444444' },
          }),
          textRun({
            text: 'ENG',
            x: 8,
            y: 34,
            width: 44,
            styleOverrides: { engrave: true, color: '#444444' },
          }),
        ],
      },
    };
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(
    !textEffectParityProbe.error,
    textEffectParityProbe.error || 'text shade/emboss/engrave parity probe available',
  );
  const shadePixelPredicate = (pixel) => (
    pixel.alpha > 32 && pixel.red > 220 && pixel.green > 190 && pixel.blue < 140
  );
  const effectInkPixelPredicate = (pixel) => (
    pixel.alpha > 32 && (pixel.red < 235 || pixel.green < 235 || pixel.blue < 235)
  );
  const textEffectCanvas2dShadePixels = countPixels(textEffectParityProbe.canvas2d, shadePixelPredicate);
  const textEffectCanvaskitShadePixels = countPixels(textEffectParityProbe.canvaskit, shadePixelPredicate);
  const textEffectCanvas2dInkPixels = countPixels(textEffectParityProbe.canvas2d, effectInkPixelPredicate);
  const textEffectCanvaskitInkPixels = countPixels(textEffectParityProbe.canvaskit, effectInkPixelPredicate);
  assert(
    textEffectCanvas2dShadePixels > 700 && textEffectCanvaskitShadePixels > 700,
    `text shade replay draws background canvas2d=${textEffectCanvas2dShadePixels}, canvaskit=${textEffectCanvaskitShadePixels}`,
  );
  assert(
    textEffectCanvas2dInkPixels > 1100 && textEffectCanvaskitInkPixels > 1100,
    `text emboss/engrave replay draws effect ink canvas2d=${textEffectCanvas2dInkPixels}, canvaskit=${textEffectCanvaskitInkPixels}`,
  );
  const textEffectDiff = await comparePngBuffers(
    pngBufferFromDataUrl(textEffectParityProbe.canvas2d),
    pngBufferFromDataUrl(textEffectParityProbe.canvaskit),
    {
      diffName: 'canvas-layer-text-shade-emboss-engrave-parity',
      ignoreChannelDelta: 48,
      maxDiffRatio: 0.22,
      inkMaskMaxDiffRatio: 0.12,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    textEffectDiff.passed,
    `text shade/emboss/engrave parity exact=${textEffectDiff.exactDiffPixels}, tolerant=${textEffectDiff.rawTolerantDiffPixels}, ink=${textEffectDiff.rawInkMaskDiffPixels}, max_channel_delta=${textEffectDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-text-projection-parity');
  const textProjectionParityProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const style = (overrides = {}) => ({
      fontFamily: 'Noto Sans KR',
      fontSize: 17,
      color: '#111111',
      bold: false,
      italic: false,
      ratio: 1,
      underline: 'none',
      underlineShape: 0,
      strikethrough: false,
      strikeShape: 0,
      outlineType: 0,
      shadowType: 0,
      shadowColor: '#000000',
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      emboss: false,
      engrave: false,
      emphasisDot: 0,
      underlineColor: '#111111',
      strikeColor: '#111111',
      shadeColor: '#ffffff',
      ...overrides,
    });
    const textRun = ({ text, x, y, width, rotation = 0, styleOverrides }) => ({
      type: 'textRun',
      bbox: { x, y, width, height: 28 },
      text,
      baseline: 21,
      rotation,
      isVertical: false,
      orientation: 'horizontal',
      style: style(styleOverrides),
      positions: Array.from({ length: text.length + 1 }, (_, index) => index * 12),
      controlMarks: [],
      tabLeaders: [],
    });
    const tree = {
      pageWidth: 158,
      pageHeight: 58,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1915,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 1915,
        bounds: { x: 0, y: 0, width: 158, height: 58 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 158, height: 58 }, backgroundColor: '#ffffff', borderWidth: 0 },
          textRun({
            text: 'ROT',
            x: 12,
            y: 10,
            width: 50,
            rotation: -14,
            styleOverrides: { color: '#222222' },
          }),
          textRun({
            text: 'RATIO',
            x: 78,
            y: 10,
            width: 66,
            styleOverrides: {
              color: '#0044aa',
              ratio: 0.62,
            },
          }),
        ],
      },
    };
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(
    !textProjectionParityProbe.error,
    textProjectionParityProbe.error || 'text projection parity probe available',
  );
  const textProjectionCanvas2dInkPixels = countPixels(
    textProjectionParityProbe.canvas2d,
    (pixel) => pixel.alpha > 32 && (pixel.red < 245 || pixel.green < 245 || pixel.blue < 245),
  );
  const textProjectionCanvaskitInkPixels = countPixels(
    textProjectionParityProbe.canvaskit,
    (pixel) => pixel.alpha > 32 && (pixel.red < 245 || pixel.green < 245 || pixel.blue < 245),
  );
  assert(
    textProjectionCanvas2dInkPixels > 250 && textProjectionCanvaskitInkPixels > 250,
    `text projection replay draws transformed runs canvas2d=${textProjectionCanvas2dInkPixels}, canvaskit=${textProjectionCanvaskitInkPixels}`,
  );
  const textProjectionDiff = await comparePngBuffers(
    pngBufferFromDataUrl(textProjectionParityProbe.canvas2d),
    pngBufferFromDataUrl(textProjectionParityProbe.canvaskit),
    {
      diffName: 'canvas-layer-text-projection-parity',
      ignoreChannelDelta: 48,
      maxDiffRatio: 0.18,
      inkMaskMaxDiffRatio: 0.08,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    textProjectionDiff.passed,
    `text projection parity exact=${textProjectionDiff.exactDiffPixels}, tolerant=${textProjectionDiff.rawTolerantDiffPixels}, ink=${textProjectionDiff.rawInkMaskDiffPixels}, max_channel_delta=${textProjectionDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-text-visual-line-parity');
  const textVisualLineParityProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const decoration = (kind, y, overrides = {}) => ({
      type: 'textDecoration',
      bbox: { x: 8, y, width: 56, height: 12 },
      decoration: {
        kind,
        baseline: 8,
        rotation: 0,
        fontSize: 10,
        ratio: 1,
        color: '#1f1f1f',
        shape: 0,
        underline: kind === 'underline' ? 'bottom' : 'none',
        emphasisDot: 0,
        positions: [0, 14, 28, 42, 56],
        ...overrides,
      },
    });
    const tree = {
      pageWidth: 80,
      pageHeight: 48,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1905,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 1905,
        bounds: { x: 0, y: 0, width: 80, height: 58 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 80, height: 58 }, backgroundColor: '#ffffff', borderWidth: 0 },
          {
            type: 'tabLeader',
            bbox: { x: 8, y: 4, width: 56, height: 8 },
            leader: { startX: 0, endX: 56, fillType: 0 },
            color: '#111111',
            fontSize: 10,
            baseline: 4,
          },
          {
            type: 'tabLeader',
            bbox: { x: 8, y: 13, width: 56, height: 8 },
            leader: { startX: 0, endX: 56, fillType: 2 },
            color: '#222222',
            fontSize: 10,
            baseline: 4,
          },
          {
            type: 'tabLeader',
            bbox: { x: 8, y: 22, width: 56, height: 8 },
            leader: { startX: 0, endX: 56, fillType: 3 },
            color: '#333333',
            fontSize: 10,
            baseline: 4,
          },
          decoration('underline', 31),
          decoration('strikethrough', 44),
        ],
      },
    };
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(
    !textVisualLineParityProbe.error,
    textVisualLineParityProbe.error || 'text visual line parity probe available',
  );
  const textVisualLineCanvas2dInkPixels = countPixels(
    textVisualLineParityProbe.canvas2d,
    (pixel) => pixel.alpha > 32 && (pixel.red < 252 || pixel.green < 252 || pixel.blue < 252),
  );
  const textVisualLineCanvaskitInkPixels = countPixels(
    textVisualLineParityProbe.canvaskit,
    (pixel) => pixel.alpha > 32 && (pixel.red < 252 || pixel.green < 252 || pixel.blue < 252),
  );
  assert(
    textVisualLineCanvas2dInkPixels > 150 && textVisualLineCanvaskitInkPixels > 150,
    `text visual line replay draws geometry canvas2d=${textVisualLineCanvas2dInkPixels}, canvaskit=${textVisualLineCanvaskitInkPixels}`,
  );
  const textVisualLineDiff = await comparePngBuffers(
    pngBufferFromDataUrl(textVisualLineParityProbe.canvas2d),
    pngBufferFromDataUrl(textVisualLineParityProbe.canvaskit),
    {
      diffName: 'canvas-layer-text-visual-line-parity',
      ignoreChannelDelta: 24,
      maxDiffRatio: 0.08,
      inkMaskMaxDiffRatio: 0.04,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    textVisualLineDiff.passed,
    `text visual line parity exact=${textVisualLineDiff.exactDiffPixels}, tolerant=${textVisualLineDiff.rawTolerantDiffPixels}, ink=${textVisualLineDiff.rawInkMaskDiffPixels}, max_channel_delta=${textVisualLineDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-tab-leader-variant-parity');
  const tabLeaderVariantParityProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const tree = {
      pageWidth: 96,
      pageHeight: 122,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1918,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 1918,
        bounds: { x: 0, y: 0, width: 96, height: 122 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 96, height: 122 }, backgroundColor: '#ffffff', borderWidth: 0 },
          ...Array.from({ length: 12 }, (_, fillType) => ({
            type: 'tabLeader',
            bbox: { x: 8, y: fillType * 10, width: 80, height: 10 },
            leader: { startX: 0, endX: 80, fillType },
            color: '#101010',
            fontSize: 10,
            baseline: 4,
          })),
        ],
      },
    };
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(
    !tabLeaderVariantParityProbe.error,
    tabLeaderVariantParityProbe.error || 'tab leader variant parity probe available',
  );
  const tabLeaderVariantPixels = (dataUrl) => Array.from(
    { length: 12 },
    (_, fillType) => countPixels(
      dataUrl,
      (pixel) => pixel.y >= fillType * 10
        && pixel.y < (fillType + 1) * 10
        && pixel.alpha > 16
        && (pixel.red < 240 || pixel.green < 240 || pixel.blue < 240),
    ),
  );
  const tabLeaderCanvas2dVariantPixels = tabLeaderVariantPixels(tabLeaderVariantParityProbe.canvas2d);
  const tabLeaderCanvaskitVariantPixels = tabLeaderVariantPixels(tabLeaderVariantParityProbe.canvaskit);
  assert(
    tabLeaderCanvas2dVariantPixels[0] === 0 && tabLeaderCanvaskitVariantPixels[0] === 0,
    `fillType=0 omits tab leader ink canvas2d=${tabLeaderCanvas2dVariantPixels[0]}, canvaskit=${tabLeaderCanvaskitVariantPixels[0]}`,
  );
  assert(
    tabLeaderCanvas2dVariantPixels.slice(1).every((count) => count > 3)
      && tabLeaderCanvaskitVariantPixels.slice(1).every((count) => count > 3),
    `all visible tab leader variants draw canvas2d=${JSON.stringify(tabLeaderCanvas2dVariantPixels)}, canvaskit=${JSON.stringify(tabLeaderCanvaskitVariantPixels)}`,
  );
  assert(
    new Set(tabLeaderCanvas2dVariantPixels.slice(1)).size >= 5
      && new Set(tabLeaderCanvaskitVariantPixels.slice(1)).size >= 5,
    `tab leader variants retain distinct geometry canvas2d=${JSON.stringify(tabLeaderCanvas2dVariantPixels)}, canvaskit=${JSON.stringify(tabLeaderCanvaskitVariantPixels)}`,
  );
  const tabLeaderVariantDiff = await comparePngBuffers(
    pngBufferFromDataUrl(tabLeaderVariantParityProbe.canvas2d),
    pngBufferFromDataUrl(tabLeaderVariantParityProbe.canvaskit),
    {
      diffName: 'canvas-layer-tab-leader-variant-parity',
      ignoreChannelDelta: 8,
      maxDiffRatio: 0.01,
      inkMaskMaxDiffRatio: 0.005,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    tabLeaderVariantDiff.passed,
    `tab leader variant parity exact=${tabLeaderVariantDiff.exactDiffPixels}, tolerant=${tabLeaderVariantDiff.rawTolerantDiffPixels}, ink=${tabLeaderVariantDiff.rawInkMaskDiffPixels}, max_channel_delta=${tabLeaderVariantDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-text-decoration-line-variant-parity');
  const textDecorationLineVariantParityProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const tree = {
      pageWidth: 96,
      pageHeight: 132,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1919,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 1919,
        bounds: { x: 0, y: 0, width: 96, height: 132 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 96, height: 132 }, backgroundColor: '#ffffff', borderWidth: 0 },
          ...Array.from({ length: 13 }, (_, shape) => ({
            type: 'textDecoration',
            bbox: { x: 8, y: shape * 10, width: 80, height: 10 },
            decoration: {
              kind: 'underline',
              baseline: 5,
              rotation: 0,
              fontSize: 10,
              ratio: 1,
              color: '#101010',
              shape,
              underline: 'bottom',
              emphasisDot: 0,
              positions: [0, 80],
            },
          })),
        ],
      },
    };
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(
    !textDecorationLineVariantParityProbe.error,
    textDecorationLineVariantParityProbe.error || 'text decoration line variant parity probe available',
  );
  const textDecorationLineVariantPixels = (dataUrl) => Array.from(
    { length: 13 },
    (_, shape) => countPixels(
      dataUrl,
      (pixel) => pixel.y >= shape * 10
        && pixel.y < (shape + 1) * 10
        && pixel.alpha > 16
        && (pixel.red < 240 || pixel.green < 240 || pixel.blue < 240),
    ),
  );
  const textDecorationLineCanvas2dPixels = textDecorationLineVariantPixels(
    textDecorationLineVariantParityProbe.canvas2d,
  );
  const textDecorationLineCanvaskitPixels = textDecorationLineVariantPixels(
    textDecorationLineVariantParityProbe.canvaskit,
  );
  assert(
    textDecorationLineCanvas2dPixels.every((count) => count > 3)
      && textDecorationLineCanvaskitPixels.every((count) => count > 3),
    `all text decoration line shapes draw canvas2d=${JSON.stringify(textDecorationLineCanvas2dPixels)}, canvaskit=${JSON.stringify(textDecorationLineCanvaskitPixels)}`,
  );
  assert(
    new Set(textDecorationLineCanvas2dPixels).size >= 6
      && new Set(textDecorationLineCanvaskitPixels).size >= 6,
    `text decoration line shapes retain distinct geometry canvas2d=${JSON.stringify(textDecorationLineCanvas2dPixels)}, canvaskit=${JSON.stringify(textDecorationLineCanvaskitPixels)}`,
  );
  const textDecorationLineVariantDiff = await comparePngBuffers(
    pngBufferFromDataUrl(textDecorationLineVariantParityProbe.canvas2d),
    pngBufferFromDataUrl(textDecorationLineVariantParityProbe.canvaskit),
    {
      diffName: 'canvas-layer-text-decoration-line-variant-parity',
      ignoreChannelDelta: 24,
      maxDiffRatio: 0.032,
      inkMaskMaxDiffRatio: 0.002,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    textDecorationLineVariantDiff.passed,
    `text decoration line variant parity exact=${textDecorationLineVariantDiff.exactDiffPixels}, tolerant=${textDecorationLineVariantDiff.rawTolerantDiffPixels}, ink=${textDecorationLineVariantDiff.rawInkMaskDiffPixels}, max_channel_delta=${textDecorationLineVariantDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-text-decoration-options-parity');
  const textDecorationOptionsParityProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const decoration = (kind, y, overrides = {}) => ({
      type: 'textDecoration',
      bbox: { x: 12, y, width: 66, height: 14 },
      decoration: {
        kind,
        baseline: 10,
        rotation: 0,
        fontSize: 12,
        ratio: 1,
        color: '#202020',
        shape: 0,
        underline: kind === 'underline' ? 'bottom' : 'none',
        emphasisDot: 0,
        positions: [0, 16, 32, 48, 64],
        ...overrides,
      },
    });
    const tree = {
      pageWidth: 92,
      pageHeight: 64,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1916,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 1916,
        bounds: { x: 0, y: 0, width: 92, height: 64 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 92, height: 64 }, backgroundColor: '#ffffff', borderWidth: 0 },
          decoration('underline', 8, { underline: 'top' }),
          decoration('strikethrough', 27, { rotation: -12 }),
          decoration('emphasisDot', 48, {
            bbox: { x: 12, y: 48, width: 66, height: 14 },
            baseline: 10,
            color: '#cc0066',
            emphasisDot: 1,
            fontSize: 16,
          }),
        ],
      },
    };
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(
    !textDecorationOptionsParityProbe.error,
    textDecorationOptionsParityProbe.error || 'text decoration options parity probe available',
  );
  const textDecorationCanvas2dMagentaPixels = countPixels(
    textDecorationOptionsParityProbe.canvas2d,
    (pixel) => pixel.alpha > 32 && pixel.red > 150 && pixel.blue > 80 && pixel.green < 120,
  );
  const textDecorationCanvaskitMagentaPixels = countPixels(
    textDecorationOptionsParityProbe.canvaskit,
    (pixel) => pixel.alpha > 32 && pixel.red > 150 && pixel.blue > 80 && pixel.green < 120,
  );
  assert(
    textDecorationCanvas2dMagentaPixels > 8 && textDecorationCanvaskitMagentaPixels > 8,
    `text decoration emphasis dots draw magenta pixels canvas2d=${textDecorationCanvas2dMagentaPixels}, canvaskit=${textDecorationCanvaskitMagentaPixels}`,
  );
  assert(
    textDecorationCanvaskitMagentaPixels >= textDecorationCanvas2dMagentaPixels * 0.65,
    `CanvasKit text decoration emphasis dot coverage stays close to Canvas2D canvas2d=${textDecorationCanvas2dMagentaPixels}, canvaskit=${textDecorationCanvaskitMagentaPixels}`,
  );
  const textDecorationOptionsDiff = await comparePngBuffers(
    pngBufferFromDataUrl(textDecorationOptionsParityProbe.canvas2d),
    pngBufferFromDataUrl(textDecorationOptionsParityProbe.canvaskit),
    {
      diffName: 'canvas-layer-text-decoration-options-parity',
      ignoreChannelDelta: 48,
      maxDiffRatio: 0.2,
      inkMaskMaxDiffRatio: 0.12,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    textDecorationOptionsDiff.passed,
    `text decoration options parity exact=${textDecorationOptionsDiff.exactDiffPixels}, tolerant=${textDecorationOptionsDiff.rawTolerantDiffPixels}, ink=${textDecorationOptionsDiff.rawInkMaskDiffPixels}, max_channel_delta=${textDecorationOptionsDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-emphasis-mark-variant-parity');
  const emphasisMarkVariantParityProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const tree = {
      pageWidth: 246,
      pageHeight: 34,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1917,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
        fontBlobs: [],
        fontBlobHashes: [],
        fontBlobKeys: [],
      },
      textSources: [],
      root: {
        kind: 'leaf',
        sourceNodeId: 1917,
        bounds: { x: 0, y: 0, width: 246, height: 34 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 246, height: 34 }, backgroundColor: '#ffffff', borderWidth: 0 },
          ...Array.from({ length: 6 }, (_, index) => ({
            type: 'textDecoration',
            bbox: { x: 5 + index * 40, y: 8, width: 32, height: 22 },
            decoration: {
              kind: 'emphasisDot',
              baseline: 18,
              rotation: 0,
              fontSize: 18,
              ratio: 1,
              color: '#101010',
              shape: 0,
              underline: 'none',
              emphasisDot: index + 1,
              positions: [0, 12, 24],
            },
          })),
        ],
      },
    };
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = tree.pageWidth;
      canvas.height = tree.pageHeight;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };
    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(
    !emphasisMarkVariantParityProbe.error,
    emphasisMarkVariantParityProbe.error || 'emphasis mark variant parity probe available',
  );
  const emphasisVariantPixels = (dataUrl) => Array.from(
    { length: 6 },
    (_, index) => countPixels(
      dataUrl,
      (pixel) => pixel.x >= index * 40
        && pixel.x < (index + 1) * 40
        && pixel.alpha > 32
        && (pixel.red < 230 || pixel.green < 230 || pixel.blue < 230),
    ),
  );
  const emphasisCanvas2dVariantPixels = emphasisVariantPixels(emphasisMarkVariantParityProbe.canvas2d);
  const emphasisCanvaskitVariantPixels = emphasisVariantPixels(emphasisMarkVariantParityProbe.canvaskit);
  assert(
    emphasisCanvas2dVariantPixels.every((count) => count > 3)
      && emphasisCanvaskitVariantPixels.every((count) => count > 3),
    `all emphasis mark variants draw canvas2d=${JSON.stringify(emphasisCanvas2dVariantPixels)}, canvaskit=${JSON.stringify(emphasisCanvaskitVariantPixels)}`,
  );
  const emphasisMarkVariantDiff = await comparePngBuffers(
    pngBufferFromDataUrl(emphasisMarkVariantParityProbe.canvas2d),
    pngBufferFromDataUrl(emphasisMarkVariantParityProbe.canvaskit),
    {
      diffName: 'canvas-layer-emphasis-mark-variant-parity',
      ignoreChannelDelta: 32,
      maxDiffRatio: 0.02,
      inkMaskMaxDiffRatio: 0.01,
      nonInkMaxDiffRatio: 0,
    },
  );
  assert(
    emphasisMarkVariantDiff.passed,
    `emphasis mark variant parity exact=${emphasisMarkVariantDiff.exactDiffPixels}, tolerant=${emphasisMarkVariantDiff.rawTolerantDiffPixels}, ink=${emphasisMarkVariantDiff.rawInkMaskDiffPixels}, max_channel_delta=${emphasisMarkVariantDiff.maxChannelDelta}`,
  );

  setTestCase('canvas-layer-clip-scope-parity');
  await loadApp(page, '?renderer=canvaskit&canvaskitMode=default');
  const clipScopeProbe = await page.evaluate(() => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }

    const makeTree = (clipEnabled) => ({
      pageWidth: 24,
      pageHeight: 12,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled,
        debugOverlay: false,
      },
      resources: {
        tableId: clipEnabled ? 996 : 997,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
      },
      root: {
        kind: 'clipRect',
        sourceNodeId: 1,
        bounds: { x: 0, y: 0, width: 24, height: 12 },
        clip: { x: 0, y: 0, width: 8, height: 8 },
        clipKind: 'generic',
        clipPolicy: {
          rightOverflowSlop: 0,
          allowHorizontalOverflowControls: false,
        },
        child: {
          kind: 'leaf',
          sourceNodeId: 2,
          bounds: { x: 0, y: 0, width: 24, height: 12 },
          cacheHint: 'none',
          ops: [{
            type: 'rectangle',
            bbox: { x: 0, y: 0, width: 24, height: 12 },
            cornerRadius: 0,
            style: {
              fillColor: '#ff0000',
              strokeColor: null,
              strokeWidth: 0,
              strokeDash: 'solid',
              opacity: 1,
            },
            transform: { rotation: 0, horzFlip: false, vertFlip: false },
          }],
        },
      },
    });

    const render = (renderer, tree) => {
      const canvas = document.createElement('canvas');
      canvas.width = 24;
      canvas.height = 12;
      document.body.appendChild(canvas);
      renderer.renderPage(tree, canvas, 1);
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };

    const enabledTree = makeTree(true);
    const disabledTree = makeTree(false);
    const bodySlopTree = {
      pageWidth: 18,
      pageHeight: 8,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 998,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
      },
      root: {
        kind: 'clipRect',
        sourceNodeId: 3,
        bounds: { x: 0, y: 0, width: 18, height: 8 },
        clip: { x: 0, y: 0, width: 8, height: 8 },
        clipKind: 'body',
        clipPolicy: {
          rightOverflowSlop: 4,
          allowHorizontalOverflowControls: true,
        },
        child: {
          kind: 'leaf',
          sourceNodeId: 4,
          bounds: { x: 0, y: 0, width: 18, height: 8 },
          cacheHint: 'none',
          ops: [{
            type: 'rectangle',
            bbox: { x: 0, y: 0, width: 18, height: 8 },
            cornerRadius: 0,
            style: {
              fillColor: '#ff0000',
              strokeColor: null,
              strokeWidth: 0,
              strokeDash: 'solid',
              opacity: 1,
            },
            transform: { rotation: 0, horzFlip: false, vertFlip: false },
          }],
        },
      },
    };
    const tableCellSlopTree = {
      ...bodySlopTree,
      resources: {
        ...bodySlopTree.resources,
        tableId: 1000,
      },
      root: {
        ...bodySlopTree.root,
        sourceNodeId: 8,
        clipKind: 'tableCell',
        child: {
          ...bodySlopTree.root.child,
          sourceNodeId: 9,
        },
      },
    };
    const bodyDefaultSlopTree = {
      ...bodySlopTree,
      resources: {
        ...bodySlopTree.resources,
        tableId: 1004,
      },
      root: {
        ...bodySlopTree.root,
        sourceNodeId: 15,
        clipPolicy: undefined,
        child: {
          ...bodySlopTree.root.child,
          sourceNodeId: 16,
        },
      },
    };
    const tableCellDefaultSlopTree = {
      ...tableCellSlopTree,
      resources: {
        ...tableCellSlopTree.resources,
        tableId: 1005,
      },
      root: {
        ...tableCellSlopTree.root,
        sourceNodeId: 17,
        clipPolicy: undefined,
        child: {
          ...tableCellSlopTree.root.child,
          sourceNodeId: 18,
        },
      },
    };
    const nestedClipTree = {
      pageWidth: 16,
      pageHeight: 10,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 999,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
      },
      root: {
        kind: 'clipRect',
        sourceNodeId: 5,
        bounds: { x: 0, y: 0, width: 16, height: 10 },
        clip: { x: 0, y: 0, width: 8, height: 8 },
        clipKind: 'body',
        clipPolicy: {
          rightOverflowSlop: 4,
          allowHorizontalOverflowControls: true,
        },
        child: {
          kind: 'clipRect',
          sourceNodeId: 6,
          bounds: { x: 0, y: 0, width: 16, height: 10 },
          clip: { x: 2, y: 2, width: 4, height: 4 },
          clipKind: 'generic',
          clipPolicy: {
            rightOverflowSlop: 0,
            allowHorizontalOverflowControls: false,
          },
          child: {
            kind: 'leaf',
            sourceNodeId: 7,
            bounds: { x: 0, y: 0, width: 16, height: 10 },
            cacheHint: 'none',
            ops: [{
              type: 'rectangle',
              bbox: { x: 0, y: 0, width: 16, height: 10 },
              cornerRadius: 0,
              style: {
                fillColor: '#ff0000',
                strokeColor: null,
                strokeWidth: 0,
                strokeDash: 'solid',
                opacity: 1,
              },
              transform: { rotation: 0, horzFlip: false, vertFlip: false },
            }],
          },
        },
      },
    };
    const nestedClipDisabledTree = {
      ...nestedClipTree,
      outputOptions: {
        ...nestedClipTree.outputOptions,
        clipEnabled: false,
      },
      resources: {
        ...nestedClipTree.resources,
        tableId: 1001,
      },
    };
    const rotatedClipTree = {
      pageWidth: 24,
      pageHeight: 16,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 1002,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
      },
      root: {
        kind: 'clipRect',
        sourceNodeId: 10,
        bounds: { x: 0, y: 0, width: 24, height: 16 },
        clip: { x: 4, y: 2, width: 12, height: 10 },
        clipKind: 'generic',
        clipPolicy: {
          rightOverflowSlop: 0,
          allowHorizontalOverflowControls: false,
        },
        child: {
          kind: 'leaf',
          sourceNodeId: 11,
          bounds: { x: 0, y: 0, width: 24, height: 16 },
          cacheHint: 'none',
          ops: [{
            type: 'rectangle',
            bbox: { x: 2, y: 2, width: 16, height: 6 },
            cornerRadius: 0,
            style: {
              fillColor: '#ff0000',
              strokeColor: null,
              strokeWidth: 0,
              strokeDash: 'solid',
              opacity: 1,
            },
            transform: { rotation: 90, horzFlip: false, vertFlip: false },
          }],
        },
      },
    };
    const cachedGroupClipTree = {
      ...rotatedClipTree,
      resources: {
        ...rotatedClipTree.resources,
        tableId: 1003,
      },
      root: {
        ...rotatedClipTree.root,
        sourceNodeId: 12,
        child: {
          kind: 'group',
          sourceNodeId: 13,
          semantic: { role: 'group' },
          bounds: { x: 0, y: 0, width: 24, height: 16 },
          cacheHint: 'staticSubtree',
          children: [{
            ...rotatedClipTree.root.child,
            sourceNodeId: 14,
          }],
        },
      },
    };
    return {
      enabled: {
        canvas2d: render(canvas2dRenderer, enabledTree),
        canvaskit: render(canvaskitRenderer, enabledTree),
      },
      disabled: {
        canvas2d: render(canvas2dRenderer, disabledTree),
        canvaskit: render(canvaskitRenderer, disabledTree),
      },
      bodySlop: {
        canvas2d: render(canvas2dRenderer, bodySlopTree),
        canvaskit: render(canvaskitRenderer, bodySlopTree),
      },
      tableCellSlop: {
        canvas2d: render(canvas2dRenderer, tableCellSlopTree),
        canvaskit: render(canvaskitRenderer, tableCellSlopTree),
      },
      bodyDefaultSlop: {
        canvas2d: render(canvas2dRenderer, bodyDefaultSlopTree),
        canvaskit: render(canvaskitRenderer, bodyDefaultSlopTree),
      },
      tableCellDefaultSlop: {
        canvas2d: render(canvas2dRenderer, tableCellDefaultSlopTree),
        canvaskit: render(canvaskitRenderer, tableCellDefaultSlopTree),
      },
      nestedClip: {
        canvas2d: render(canvas2dRenderer, nestedClipTree),
        canvaskit: render(canvaskitRenderer, nestedClipTree),
      },
      nestedClipDisabled: {
        canvas2d: render(canvas2dRenderer, nestedClipDisabledTree),
        canvaskit: render(canvaskitRenderer, nestedClipDisabledTree),
      },
      rotatedClip: {
        canvas2d: render(canvas2dRenderer, rotatedClipTree),
        canvaskit: render(canvaskitRenderer, rotatedClipTree),
      },
      cachedGroupClip: {
        canvas2d: render(canvas2dRenderer, cachedGroupClipTree),
        canvaskit: render(canvaskitRenderer, cachedGroupClipTree),
      },
    };
  });

  assert(!clipScopeProbe.error, clipScopeProbe.error || 'clip scope probe available');
  const clipEnabledDiff = await comparePngBuffers(
    pngBufferFromDataUrl(clipScopeProbe.enabled.canvas2d),
    pngBufferFromDataUrl(clipScopeProbe.enabled.canvaskit),
    {
      diffName: 'canvas-layer-clip-enabled-parity',
      ignoreChannelDelta: 1,
      maxDiffPixels: 0,
    },
  );
  assert(
    clipEnabledDiff.passed,
    `clip enabled parity exact=${clipEnabledDiff.exactDiffPixels}, tolerant=${clipEnabledDiff.rawTolerantDiffPixels}, max_channel_delta=${clipEnabledDiff.maxChannelDelta}`,
  );
  const clipDisabledDiff = await comparePngBuffers(
    pngBufferFromDataUrl(clipScopeProbe.disabled.canvas2d),
    pngBufferFromDataUrl(clipScopeProbe.disabled.canvaskit),
    {
      diffName: 'canvas-layer-clip-disabled-parity',
      ignoreChannelDelta: 1,
      maxDiffPixels: 0,
    },
  );
  assert(
    clipDisabledDiff.passed,
    `clip disabled parity exact=${clipDisabledDiff.exactDiffPixels}, tolerant=${clipDisabledDiff.rawTolerantDiffPixels}, max_channel_delta=${clipDisabledDiff.maxChannelDelta}`,
  );
  assert(
    isOpaqueRed(pixelAt(clipScopeProbe.enabled.canvas2d, 4, 4))
      && isTransparent(pixelAt(clipScopeProbe.enabled.canvas2d, 10, 4))
      && isTransparent(pixelAt(clipScopeProbe.enabled.canvas2d, 4, 10)),
    'Canvas2D clip enabled constrains child drawing to the ClipRect',
  );
  assert(
    isOpaqueRed(pixelAt(clipScopeProbe.disabled.canvas2d, 10, 4))
      && isOpaqueRed(pixelAt(clipScopeProbe.disabled.canvas2d, 4, 10)),
    'Canvas2D clip disabled replays the unclipped child',
  );
  const bodySlopDiff = await comparePngBuffers(
    pngBufferFromDataUrl(clipScopeProbe.bodySlop.canvas2d),
    pngBufferFromDataUrl(clipScopeProbe.bodySlop.canvaskit),
    {
      diffName: 'canvas-layer-body-slop-clip-parity',
      ignoreChannelDelta: 1,
      maxDiffPixels: 0,
    },
  );
  assert(
    bodySlopDiff.passed,
    `body slop clip parity exact=${bodySlopDiff.exactDiffPixels}, tolerant=${bodySlopDiff.rawTolerantDiffPixels}, max_channel_delta=${bodySlopDiff.maxChannelDelta}`,
  );
  assert(
    isOpaqueRed(pixelAt(clipScopeProbe.bodySlop.canvas2d, 11, 4))
      && isTransparent(pixelAt(clipScopeProbe.bodySlop.canvas2d, 13, 4)),
    'Canvas2D body clip applies rightOverflowSlop and still clips past the slop',
  );
  const tableCellSlopDiff = await comparePngBuffers(
    pngBufferFromDataUrl(clipScopeProbe.tableCellSlop.canvas2d),
    pngBufferFromDataUrl(clipScopeProbe.tableCellSlop.canvaskit),
    {
      diffName: 'canvas-layer-table-cell-slop-clip-parity',
      ignoreChannelDelta: 1,
      maxDiffPixels: 0,
    },
  );
  assert(
    tableCellSlopDiff.passed,
    `table cell slop clip parity exact=${tableCellSlopDiff.exactDiffPixels}, tolerant=${tableCellSlopDiff.rawTolerantDiffPixels}, max_channel_delta=${tableCellSlopDiff.maxChannelDelta}`,
  );
  assert(
    isOpaqueRed(pixelAt(clipScopeProbe.tableCellSlop.canvas2d, 11, 4))
      && isTransparent(pixelAt(clipScopeProbe.tableCellSlop.canvas2d, 13, 4)),
    'Canvas2D table cell clip applies rightOverflowSlop and still clips past the slop',
  );
  const bodyDefaultSlopDiff = await comparePngBuffers(
    pngBufferFromDataUrl(clipScopeProbe.bodyDefaultSlop.canvas2d),
    pngBufferFromDataUrl(clipScopeProbe.bodyDefaultSlop.canvaskit),
    {
      diffName: 'canvas-layer-body-default-slop-clip-parity',
      ignoreChannelDelta: 1,
      maxDiffPixels: 0,
    },
  );
  assert(
    bodyDefaultSlopDiff.passed,
    `body default slop clip parity exact=${bodyDefaultSlopDiff.exactDiffPixels}, tolerant=${bodyDefaultSlopDiff.rawTolerantDiffPixels}, max_channel_delta=${bodyDefaultSlopDiff.maxChannelDelta}`,
  );
  assert(
    isOpaqueRed(pixelAt(clipScopeProbe.bodyDefaultSlop.canvas2d, 11, 4))
      && isTransparent(pixelAt(clipScopeProbe.bodyDefaultSlop.canvas2d, 13, 4)),
    'Canvas2D body clip applies default rightOverflowSlop when clipPolicy is absent',
  );
  const tableCellDefaultSlopDiff = await comparePngBuffers(
    pngBufferFromDataUrl(clipScopeProbe.tableCellDefaultSlop.canvas2d),
    pngBufferFromDataUrl(clipScopeProbe.tableCellDefaultSlop.canvaskit),
    {
      diffName: 'canvas-layer-table-cell-default-slop-clip-parity',
      ignoreChannelDelta: 1,
      maxDiffPixels: 0,
    },
  );
  assert(
    tableCellDefaultSlopDiff.passed,
    `table cell default slop clip parity exact=${tableCellDefaultSlopDiff.exactDiffPixels}, tolerant=${tableCellDefaultSlopDiff.rawTolerantDiffPixels}, max_channel_delta=${tableCellDefaultSlopDiff.maxChannelDelta}`,
  );
  assert(
    isOpaqueRed(pixelAt(clipScopeProbe.tableCellDefaultSlop.canvas2d, 11, 4))
      && isTransparent(pixelAt(clipScopeProbe.tableCellDefaultSlop.canvas2d, 13, 4)),
    'Canvas2D table cell clip applies default rightOverflowSlop when clipPolicy is absent',
  );
  const nestedClipDiff = await comparePngBuffers(
    pngBufferFromDataUrl(clipScopeProbe.nestedClip.canvas2d),
    pngBufferFromDataUrl(clipScopeProbe.nestedClip.canvaskit),
    {
      diffName: 'canvas-layer-nested-clip-parity',
      ignoreChannelDelta: 1,
      maxDiffPixels: 0,
    },
  );
  assert(
    nestedClipDiff.passed,
    `nested clip parity exact=${nestedClipDiff.exactDiffPixels}, tolerant=${nestedClipDiff.rawTolerantDiffPixels}, max_channel_delta=${nestedClipDiff.maxChannelDelta}`,
  );
  assert(
    isOpaqueRed(pixelAt(clipScopeProbe.nestedClip.canvas2d, 3, 3))
      && isTransparent(pixelAt(clipScopeProbe.nestedClip.canvas2d, 9, 3))
      && isTransparent(pixelAt(clipScopeProbe.nestedClip.canvas2d, 3, 7)),
    'Canvas2D nested clip intersects inner generic clip with outer body clip',
  );
  const nestedClipDisabledDiff = await comparePngBuffers(
    pngBufferFromDataUrl(clipScopeProbe.nestedClipDisabled.canvas2d),
    pngBufferFromDataUrl(clipScopeProbe.nestedClipDisabled.canvaskit),
    {
      diffName: 'canvas-layer-nested-clip-disabled-parity',
      ignoreChannelDelta: 1,
      maxDiffPixels: 0,
    },
  );
  assert(
    nestedClipDisabledDiff.passed,
    `nested clip disabled parity exact=${nestedClipDisabledDiff.exactDiffPixels}, tolerant=${nestedClipDisabledDiff.rawTolerantDiffPixels}, max_channel_delta=${nestedClipDisabledDiff.maxChannelDelta}`,
  );
  assert(
    isOpaqueRed(pixelAt(clipScopeProbe.nestedClipDisabled.canvas2d, 9, 3))
      && isOpaqueRed(pixelAt(clipScopeProbe.nestedClipDisabled.canvas2d, 3, 7)),
    'Canvas2D clipEnabled=false disables nested clip scopes',
  );
  const rotatedClipDiff = await comparePngBuffers(
    pngBufferFromDataUrl(clipScopeProbe.rotatedClip.canvas2d),
    pngBufferFromDataUrl(clipScopeProbe.rotatedClip.canvaskit),
    {
      diffName: 'canvas-layer-rotated-clip-parity',
      ignoreChannelDelta: 1,
      maxDiffPixels: 0,
    },
  );
  assert(
    rotatedClipDiff.passed,
    `rotated clip parity exact=${rotatedClipDiff.exactDiffPixels}, tolerant=${rotatedClipDiff.rawTolerantDiffPixels}, max_channel_delta=${rotatedClipDiff.maxChannelDelta}`,
  );
  assert(
    isOpaqueRed(pixelAt(clipScopeProbe.rotatedClip.canvas2d, 10, 3))
      && isTransparent(pixelAt(clipScopeProbe.rotatedClip.canvas2d, 10, 1))
      && isTransparent(pixelAt(clipScopeProbe.rotatedClip.canvas2d, 3, 5)),
    'Canvas2D clip constrains a rotated child in device clip space',
  );
  const cachedGroupClipDiff = await comparePngBuffers(
    pngBufferFromDataUrl(clipScopeProbe.cachedGroupClip.canvas2d),
    pngBufferFromDataUrl(clipScopeProbe.cachedGroupClip.canvaskit),
    {
      diffName: 'canvas-layer-cached-group-clip-parity',
      ignoreChannelDelta: 1,
      maxDiffPixels: 0,
    },
  );
  assert(
    cachedGroupClipDiff.passed,
    `cached group clip parity exact=${cachedGroupClipDiff.exactDiffPixels}, tolerant=${cachedGroupClipDiff.rawTolerantDiffPixels}, max_channel_delta=${cachedGroupClipDiff.maxChannelDelta}`,
  );
  assert(
    isOpaqueRed(pixelAt(clipScopeProbe.cachedGroupClip.canvas2d, 10, 3))
      && isTransparent(pixelAt(clipScopeProbe.cachedGroupClip.canvas2d, 10, 1))
      && isTransparent(pixelAt(clipScopeProbe.cachedGroupClip.canvas2d, 3, 5)),
    'Canvas2D clip constrains a static group child with a transformed op',
  );

  setTestCase('page-background-image-opacity-parity');
  const pageBackgroundOpacityProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }

    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = 1;
    sourceCanvas.height = 1;
    const sourceContext = sourceCanvas.getContext('2d');
    if (!sourceContext) {
      return { error: 'source canvas unavailable' };
    }
    sourceContext.fillStyle = '#000000';
    sourceContext.fillRect(0, 0, 1, 1);
    const base64 = sourceCanvas.toDataURL('image/png').split(',')[1];
    const tree = {
      pageWidth: 16,
      pageHeight: 16,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 991,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
      },
      root: {
        kind: 'leaf',
        sourceNodeId: 1,
        bounds: { x: 0, y: 0, width: 16, height: 16 },
        cacheHint: 'none',
        ops: [{
          type: 'pageBackground',
          bbox: { x: 0, y: 0, width: 16, height: 16 },
          backgroundColor: '#ffffff',
          borderWidth: 0,
          image: {
            base64,
            fillMode: 'fitToSize',
            effect: 'realPic',
            opacity: 0.25,
          },
        }],
      },
    };

    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = 16;
      canvas.height = 16;
      document.body.appendChild(canvas);
      const context = canvas.getContext('2d');
      if (!context) {
        canvas.remove();
        return null;
      }
      for (let attempt = 0; attempt < 8; attempt += 1) {
        renderer.renderPage(tree, canvas, 1);
        await nextFrame();
        const pixel = context.getImageData(8, 8, 1, 1).data;
        if (pixel[0] < 230 && pixel[3] > 250) {
          break;
        }
      }
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };

    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  });
  assert(
    !pageBackgroundOpacityProbe.error
      && pageBackgroundOpacityProbe.canvas2d
      && pageBackgroundOpacityProbe.canvaskit,
    pageBackgroundOpacityProbe.error || 'page background opacity probe available',
  );
  const pageBackgroundOpacityDiff = await comparePngBuffers(
    pngBufferFromDataUrl(pageBackgroundOpacityProbe.canvas2d),
    pngBufferFromDataUrl(pageBackgroundOpacityProbe.canvaskit),
    {
      diffName: 'page-background-image-opacity-parity',
      ignoreChannelDelta: 2,
      maxDiffPixels: 0,
    },
  );
  assert(
    pageBackgroundOpacityDiff.passed,
    `page background opacity parity exact=${pageBackgroundOpacityDiff.exactDiffPixels}, tolerant=${pageBackgroundOpacityDiff.rawTolerantDiffPixels}, max_channel_delta=${pageBackgroundOpacityDiff.maxChannelDelta}`,
  );
  for (const backend of ['canvas2d', 'canvaskit']) {
    const pixel = pixelAt(pageBackgroundOpacityProbe[backend], 8, 8);
    assert(
      pixel.red >= 188
        && pixel.red <= 194
        && pixel.green >= 188
        && pixel.green <= 194
        && pixel.blue >= 188
        && pixel.blue <= 194
        && pixel.alpha === 255,
      `${backend} page background opacity composited rgba=${JSON.stringify(pixel)}`,
    );
  }

  setTestCase('image-effect-pattern-reference');
  await loadApp(page, '?renderer=canvaskit&canvaskitMode=default');
  const imageEffectReferenceProbe = await page.evaluate(async ({ luma }) => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }

    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = 8;
    sourceCanvas.height = 8;
    const sourceCtx = sourceCanvas.getContext('2d');
    if (!sourceCtx) {
      return { error: 'source canvas unavailable' };
    }
    sourceCtx.fillStyle = `rgb(${luma}, ${luma}, ${luma})`;
    sourceCtx.fillRect(0, 0, 8, 8);
    const base64 = sourceCanvas.toDataURL('image/png').split(',')[1];
    const tree = {
      pageWidth: 8,
      pageHeight: 8,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 992,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
      },
      root: {
        kind: 'leaf',
        sourceNodeId: 1,
        bounds: { x: 0, y: 0, width: 8, height: 8 },
        cacheHint: 'none',
        ops: [{
          type: 'image',
          bbox: { x: 0, y: 0, width: 8, height: 8 },
          base64,
          fillMode: 'fitToSize',
          effect: 'pattern8x8',
          originalSize: { width: 8, height: 8 },
          transform: { rotation: 0, horzFlip: false, vertFlip: false },
        }],
      },
    };

    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const render = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = 8;
      canvas.height = 8;
      document.body.appendChild(canvas);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return { error: 'target canvas unavailable' };
      }
      for (let attempt = 0; attempt < 8; attempt += 1) {
        renderer.renderPage(tree, canvas, 1);
        await nextFrame();
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let hasInk = false;
        for (let index = 3; index < pixels.length; index += 4) {
          if (pixels[index] > 0) {
            hasInk = true;
            break;
          }
        }
        if (hasInk) {
          break;
        }
      }
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return png;
    };

    return {
      canvas2d: await render(canvas2dRenderer),
      canvaskit: await render(canvaskitRenderer),
    };
  }, { luma: PATTERN_REFERENCE_FIXTURE.luma });

  assert(!imageEffectReferenceProbe.error, imageEffectReferenceProbe.error || 'image effect reference probe available');
  const imageEffectReferenceDiff = await comparePngBuffers(
    pngBufferFromDataUrl(imageEffectReferenceProbe.canvas2d),
    pngBufferFromDataUrl(imageEffectReferenceProbe.canvaskit),
    {
      diffName: 'image-effect-pattern-reference-parity',
      ignoreChannelDelta: 1,
      maxDiffPixels: 0,
    },
  );
  assert(
    imageEffectReferenceDiff.passed,
    `image effect reference parity exact=${imageEffectReferenceDiff.exactDiffPixels}, tolerant=${imageEffectReferenceDiff.rawTolerantDiffPixels}, max_channel_delta=${imageEffectReferenceDiff.maxChannelDelta}`,
  );
  assert(
    countPatternReferenceMismatches(imageEffectReferenceProbe.canvas2d, PATTERN_REFERENCE_FIXTURE) === 0
      && countPatternReferenceMismatches(imageEffectReferenceProbe.canvaskit, PATTERN_REFERENCE_FIXTURE) === 0,
    'image effect Pattern8x8 reference table matches browser renderers',
  );

  setTestCase('image-effect-pattern-crop-phase');
  const imageEffectCropPhaseProbe = await page.evaluate(async ({ luma }) => {
    const { applyLayerImageEffect } = await import('/src/view/layer-canvas-utils.ts');
    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = 16;
    sourceCanvas.height = 16;
    const sourceCtx = sourceCanvas.getContext('2d');
    if (!sourceCtx) {
      return { error: 'source canvas unavailable' };
    }
    sourceCtx.fillStyle = `rgb(${luma}, ${luma}, ${luma})`;
    sourceCtx.fillRect(0, 0, sourceCanvas.width, sourceCanvas.height);
    const sourceRects = [
      { x: 3, y: 5, width: 8, height: 8 },
      { x: 7, y: 7, width: 8, height: 8 },
      { x: 8, y: 8, width: 8, height: 8 },
    ];
    const results = [];
    for (const sourceRect of sourceRects) {
      const diagnostics = {
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
      const output = applyLayerImageEffect(
        sourceCanvas,
        'pattern8x8',
        new WeakMap(),
        diagnostics,
        sourceRect,
      );
      const canvas = document.createElement('canvas');
      canvas.width = 8;
      canvas.height = 8;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return { error: 'target canvas unavailable' };
      }
      ctx.drawImage(output, 0, 0);
      results.push({
        sourceRect,
        png: canvas.toDataURL('image/png'),
        diagnostics,
      });
    }
    return { results };
  }, { luma: PATTERN_REFERENCE_FIXTURE.luma });

  assert(!imageEffectCropPhaseProbe.error, imageEffectCropPhaseProbe.error || 'image effect crop phase probe available');
  for (const result of imageEffectCropPhaseProbe.results) {
    assert(
      result.diagnostics.preprocessedPixels === 64
        && result.diagnostics.preprocessFailures === 0,
      `image effect crop phase diagnostics=${JSON.stringify(result)}`,
    );
    assert(
      countPatternReferenceMismatches(
        result.png,
        PATTERN_REFERENCE_FIXTURE,
        result.sourceRect.x,
        result.sourceRect.y,
      ) === 0,
      `Pattern8x8 crop preprocessing preserves full-image Bayer phase for ${JSON.stringify(result.sourceRect)}`,
    );
  }

  setTestCase('image-effect-crop-preprocess-parity');
  const imageEffectCropProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }

    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = 64;
    sourceCanvas.height = 64;
    const sourceCtx = sourceCanvas.getContext('2d');
    if (!sourceCtx) {
      return { error: 'source canvas unavailable' };
    }
    for (let y = 0; y < sourceCanvas.height; y += 1) {
      for (let x = 0; x < sourceCanvas.width; x += 1) {
        const alpha = (((x + y) % 8) + 1) / 8;
        sourceCtx.fillStyle = `rgba(${(x * 4) & 255}, ${(y * 4) & 255}, ${((x + y) * 2) & 255}, ${alpha})`;
        sourceCtx.fillRect(x, y, 1, 1);
      }
    }
    const base64 = sourceCanvas.toDataURL('image/png').split(',')[1];
    const tree = {
      pageWidth: 16,
      pageHeight: 16,
      profile: 'screen',
      outputOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
        showTransparentBorders: false,
        clipEnabled: true,
        debugOverlay: false,
      },
      resources: {
        tableId: 991,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
      },
      root: {
        kind: 'leaf',
        sourceNodeId: 1,
        bounds: { x: 0, y: 0, width: 16, height: 16 },
        cacheHint: 'none',
        ops: [{
          type: 'image',
          bbox: { x: 0, y: 0, width: 16, height: 16 },
          base64,
          fillMode: 'fitToSize',
          effect: 'pattern8x8',
          originalSize: { width: 64, height: 64 },
          crop: { left: 4800, top: 4800, right: 5600, bottom: 5600 },
          originalSizeHu: [6400, 6400],
          transform: { rotation: 0, horzFlip: false, vertFlip: false },
        }],
      },
    };

    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const renderWithDiagnostics = async (renderer, renderTree = tree) => {
      const canvas = document.createElement('canvas');
      canvas.width = 16;
      canvas.height = 16;
      document.body.appendChild(canvas);
      renderer.resetImageEffectDiagnostics();
      const before = renderer.getImageEffectDiagnostics();
      let after = before;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        renderer.renderPage(renderTree, canvas, 1);
        await nextFrame();
        after = renderer.getImageEffectDiagnostics();
        if (after.preprocessedPixels > before.preprocessedPixels) {
          break;
        }
      }
      const png = canvas.toDataURL('image/png');
      canvas.remove();
      return {
        png,
        diagnostics: {
          cacheHits: after.cacheHits - before.cacheHits,
          cacheMisses: after.cacheMisses - before.cacheMisses,
          preprocessFailures: after.preprocessFailures - before.preprocessFailures,
          fallbackToOriginal: after.fallbackToOriginal - before.fallbackToOriginal,
          preprocessedPixels: after.preprocessedPixels - before.preprocessedPixels,
          preprocessedBytes: after.preprocessedBytes - before.preprocessedBytes,
          maxPreprocessedBytes: after.maxPreprocessedBytes,
          preprocessTimeMs: after.preprocessTimeMs - before.preprocessTimeMs,
          maxPreprocessTimeMs: after.maxPreprocessTimeMs,
          heapDeltaBytes: after.heapDeltaBytes - before.heapDeltaBytes,
          maxHeapDeltaBytes: after.maxHeapDeltaBytes,
          offscreenCanvasPreprocesses: after.offscreenCanvasPreprocesses - before.offscreenCanvasPreprocesses,
          htmlCanvasPreprocesses: after.htmlCanvasPreprocesses - before.htmlCanvasPreprocesses,
        },
      };
    };

    const canvas2d = await renderWithDiagnostics(canvas2dRenderer);
    const canvaskit = await renderWithDiagnostics(canvaskitRenderer);
    const directEffects = {};
    for (const effect of ['grayScale', 'blackWhite']) {
      const effectTree = {
        ...tree,
        resources: {
          ...tree.resources,
          tableId: effect === 'grayScale' ? 993 : 994,
        },
        root: {
          ...tree.root,
          ops: [{
            ...tree.root.ops[0],
            effect,
          }],
        },
      };
      directEffects[effect] = {
        canvas2d: await renderWithDiagnostics(canvas2dRenderer, effectTree),
        canvaskit: await renderWithDiagnostics(canvaskitRenderer, effectTree),
      };
    }
    const tileTree = {
      ...tree,
      resources: {
        ...tree.resources,
        tableId: 995,
      },
      root: {
        ...tree.root,
        ops: [{
          ...tree.root.ops[0],
          fillMode: 'tileAll',
          originalSize: { width: 8, height: 8 },
        }],
      },
    };
    const tileCanvas2d = await renderWithDiagnostics(canvas2dRenderer, tileTree);
    const tileCanvaskit = await renderWithDiagnostics(canvaskitRenderer, tileTree);
    const noneTree = {
      ...tree,
      resources: {
        ...tree.resources,
        tableId: 996,
      },
      root: {
        ...tree.root,
        ops: [{
          ...tree.root.ops[0],
          fillMode: 'none',
          crop: { left: 4000, top: 4000, right: 5600, bottom: 5600 },
        }],
      },
    };
    const noneCanvas2d = await renderWithDiagnostics(canvas2dRenderer, noneTree);
    const noneCanvaskit = await renderWithDiagnostics(canvaskitRenderer, noneTree);
    canvaskitRenderer.resetImageEffectDiagnostics();
    const invalidSourceImage = canvaskitRenderer.resourceCache?.imageWithEffect?.(
      undefined,
      base64,
      'grayScale',
      { x: 0, y: 0, width: 0, height: 8 },
    );
    const invalidSourceAfter = canvaskitRenderer.getImageEffectDiagnostics();
    const invalidSourceFallback = {
      imageAvailable: !!invalidSourceImage,
      width: invalidSourceImage?.width?.() ?? null,
      height: invalidSourceImage?.height?.() ?? null,
      diagnostics: {
        cacheHits: invalidSourceAfter.cacheHits,
        cacheMisses: invalidSourceAfter.cacheMisses,
        preprocessFailures: invalidSourceAfter.preprocessFailures,
        fallbackToOriginal: invalidSourceAfter.fallbackToOriginal,
        preprocessedPixels: invalidSourceAfter.preprocessedPixels,
        preprocessedBytes: invalidSourceAfter.preprocessedBytes,
        offscreenCanvasPreprocesses: invalidSourceAfter.offscreenCanvasPreprocesses,
        htmlCanvasPreprocesses: invalidSourceAfter.htmlCanvasPreprocesses,
      },
    };
    canvaskitRenderer.resetImageEffectDiagnostics();
    const cacheSourceRect = { x: 11, y: 13, width: 8, height: 8 };
    const cacheFirstImage = canvaskitRenderer.resourceCache?.imageWithEffect?.(
      undefined,
      base64,
      'grayScale',
      cacheSourceRect,
    );
    const cacheAfterFirst = canvaskitRenderer.getImageEffectDiagnostics();
    const cacheSecondImage = canvaskitRenderer.resourceCache?.imageWithEffect?.(
      undefined,
      base64,
      'grayScale',
      cacheSourceRect,
    );
    const cacheAfterSecond = canvaskitRenderer.getImageEffectDiagnostics();
    const directCacheReuse = {
      firstAvailable: !!cacheFirstImage,
      secondAvailable: !!cacheSecondImage,
      sameImage: cacheFirstImage === cacheSecondImage,
      afterFirst: {
        cacheHits: cacheAfterFirst.cacheHits,
        cacheMisses: cacheAfterFirst.cacheMisses,
        preprocessFailures: cacheAfterFirst.preprocessFailures,
        fallbackToOriginal: cacheAfterFirst.fallbackToOriginal,
        preprocessedPixels: cacheAfterFirst.preprocessedPixels,
        preprocessedBytes: cacheAfterFirst.preprocessedBytes,
        offscreenCanvasPreprocesses: cacheAfterFirst.offscreenCanvasPreprocesses,
        htmlCanvasPreprocesses: cacheAfterFirst.htmlCanvasPreprocesses,
      },
      afterSecond: {
        cacheHits: cacheAfterSecond.cacheHits,
        cacheMisses: cacheAfterSecond.cacheMisses,
        preprocessFailures: cacheAfterSecond.preprocessFailures,
        fallbackToOriginal: cacheAfterSecond.fallbackToOriginal,
        preprocessedPixels: cacheAfterSecond.preprocessedPixels,
        preprocessedBytes: cacheAfterSecond.preprocessedBytes,
        offscreenCanvasPreprocesses: cacheAfterSecond.offscreenCanvasPreprocesses,
        htmlCanvasPreprocesses: cacheAfterSecond.htmlCanvasPreprocesses,
      },
    };
    const pattern = {
      patternType: 4,
      patternColor: '#123456',
      backgroundColor: '#abcdef',
    };
    const otherPattern = {
      patternType: 5,
      patternColor: '#123456',
      backgroundColor: '#fedcba',
    };
    const patternCacheKey = `${pattern.patternType}:${pattern.patternColor}:${pattern.backgroundColor}`;
    const otherPatternCacheKey = `${otherPattern.patternType}:${otherPattern.patternColor}:${otherPattern.backgroundColor}`;
    canvaskitRenderer.patternImageCache?.delete?.(patternCacheKey);
    canvaskitRenderer.patternImageCache?.delete?.(otherPatternCacheKey);
    canvaskitRenderer.resetPatternDiagnostics?.();
    const patternFirstImage = canvaskitRenderer.resourceCache?.patternImage?.(pattern);
    const patternAfterFirst = canvaskitRenderer.getPatternDiagnostics?.();
    const patternSecondImage = canvaskitRenderer.resourceCache?.patternImage?.(pattern);
    const patternAfterSecond = canvaskitRenderer.getPatternDiagnostics?.();
    const patternOtherImage = canvaskitRenderer.resourceCache?.patternImage?.(otherPattern);
    const patternAfterOther = canvaskitRenderer.getPatternDiagnostics?.();
    canvaskitRenderer.resetPatternDiagnostics?.();
    const patternAfterReset = canvaskitRenderer.getPatternDiagnostics?.();
    const recoveredPattern = {
      patternType: 4,
      patternColor: '#c08040c0',
      backgroundColor: '#20406080',
    };
    const recoveredPatternCacheKey = `${recoveredPattern.patternType}:${recoveredPattern.patternColor}:${recoveredPattern.backgroundColor}`;
    const patternImageInfo = {
      width: 6,
      height: 6,
      colorType: canvaskitRenderer.canvasKit.ColorType.RGBA_8888,
      alphaType: canvaskitRenderer.canvasKit.AlphaType.Unpremul,
      colorSpace: canvaskitRenderer.canvasKit.ColorSpace.SRGB,
    };
    canvaskitRenderer.patternImageCache?.delete?.(recoveredPatternCacheKey);
    const recoveredPatternReferenceImage =
      canvaskitRenderer.resourceCache?.patternImage?.(recoveredPattern);
    const recoveredPatternReferencePixels =
      recoveredPatternReferenceImage?.readPixels?.(0, 0, patternImageInfo) ?? null;
    recoveredPatternReferenceImage?.delete?.();
    canvaskitRenderer.patternImageCache?.delete?.(recoveredPatternCacheKey);
    const failedPattern = {
      patternType: 0,
      patternColor: '#654321',
      backgroundColor: '#fedcba',
    };
    const failedPatternCacheKey =
      `${failedPattern.patternType}:${failedPattern.patternColor}:${failedPattern.backgroundColor}`;
    canvaskitRenderer.patternImageCache?.delete?.(failedPatternCacheKey);
    canvaskitRenderer.resetPatternDiagnostics?.();
    const originalMakeSurface = canvaskitRenderer.canvasKit?.MakeSurface;
    const originalMakeImage = canvaskitRenderer.canvasKit?.MakeImage;
    let recoveredPatternFirstImage = null;
    let recoveredPatternSecondImage = null;
    let recoveredPatternPixels = null;
    let recoveredPatternAfterFirst = null;
    let recoveredPatternAfterSecond = null;
    let failedPatternFirstImage = null;
    let failedPatternSecondImage = null;
    let failedPatternAfterFirst = null;
    let failedPatternAfterSecond = null;
    if (originalMakeSurface && originalMakeImage) {
      canvaskitRenderer.canvasKit.MakeSurface = () => null;
      try {
        recoveredPatternFirstImage =
          canvaskitRenderer.resourceCache?.patternImage?.(recoveredPattern);
        recoveredPatternPixels =
          recoveredPatternFirstImage?.readPixels?.(0, 0, patternImageInfo) ?? null;
        recoveredPatternAfterFirst = canvaskitRenderer.getPatternDiagnostics?.();
        recoveredPatternSecondImage =
          canvaskitRenderer.resourceCache?.patternImage?.(recoveredPattern);
        recoveredPatternAfterSecond = canvaskitRenderer.getPatternDiagnostics?.();

        canvaskitRenderer.resetPatternDiagnostics?.();
        canvaskitRenderer.canvasKit.MakeImage = () => null;
        failedPatternFirstImage = canvaskitRenderer.resourceCache?.patternImage?.(failedPattern);
        failedPatternAfterFirst = canvaskitRenderer.getPatternDiagnostics?.();
        failedPatternSecondImage = canvaskitRenderer.resourceCache?.patternImage?.(failedPattern);
        failedPatternAfterSecond = canvaskitRenderer.getPatternDiagnostics?.();
      } finally {
        canvaskitRenderer.canvasKit.MakeSurface = originalMakeSurface;
        canvaskitRenderer.canvasKit.MakeImage = originalMakeImage;
      }
    }
    canvaskitRenderer.resetPatternDiagnostics?.();
    const directPatternCacheReuse = {
      firstAvailable: !!patternFirstImage,
      secondAvailable: !!patternSecondImage,
      otherAvailable: !!patternOtherImage,
      sameImage: patternFirstImage === patternSecondImage,
      differentImage: patternFirstImage !== patternOtherImage,
      afterFirst: patternAfterFirst,
      afterSecond: patternAfterSecond,
      afterOther: patternAfterOther,
      afterReset: patternAfterReset,
      cacheSize: canvaskitRenderer.patternImageCache?.size ?? -1,
      recovery: {
        firstAvailable: !!recoveredPatternFirstImage,
        secondAvailable: !!recoveredPatternSecondImage,
        sameImage: recoveredPatternFirstImage === recoveredPatternSecondImage,
        exactPixels: recoveredPatternReferencePixels instanceof Uint8Array
          && recoveredPatternPixels instanceof Uint8Array
          && recoveredPatternReferencePixels.length === recoveredPatternPixels.length
          && recoveredPatternReferencePixels.every(
            (value, index) => value === recoveredPatternPixels[index],
          ),
        afterFirst: recoveredPatternAfterFirst,
        afterSecond: recoveredPatternAfterSecond,
      },
      failure: {
        firstAvailable: !!failedPatternFirstImage,
        secondAvailable: !!failedPatternSecondImage,
        afterFirst: failedPatternAfterFirst,
        afterSecond: failedPatternAfterSecond,
      },
    };
    canvas2dRenderer.resetImageEffectDiagnostics();
    canvaskitRenderer.resetImageEffectDiagnostics();
    return {
      canvas2d,
      canvaskit,
      directEffects,
      tileCanvas2d,
      tileCanvaskit,
      noneCanvas2d,
      noneCanvaskit,
      invalidSourceFallback,
      directCacheReuse,
      directPatternCacheReuse,
      afterReset: {
        canvas2d: canvas2dRenderer.getImageEffectDiagnostics(),
        canvaskit: canvaskitRenderer.getImageEffectDiagnostics(),
      },
    };
  });

  assert(!imageEffectCropProbe.error, imageEffectCropProbe.error || 'image effect crop probe available');
  assert(
    imageEffectCropProbe.canvas2d.diagnostics.preprocessedPixels === 64,
    `canvas2d crop-aware effect pixels=${JSON.stringify(imageEffectCropProbe.canvas2d.diagnostics)}`,
  );
  assert(
    imageEffectCropProbe.canvaskit.diagnostics.preprocessedPixels === 64,
    `canvaskit crop-aware effect pixels=${JSON.stringify(imageEffectCropProbe.canvaskit.diagnostics)}`,
  );
  assert(
    imageEffectCropProbe.canvas2d.diagnostics.preprocessedBytes === 256
      && imageEffectCropProbe.canvaskit.diagnostics.preprocessedBytes === 256
      && imageEffectCropProbe.canvas2d.diagnostics.maxPreprocessedBytes === 256
      && imageEffectCropProbe.canvaskit.diagnostics.maxPreprocessedBytes === 256,
    `image effect crop-aware effect bytes=${JSON.stringify(imageEffectCropProbe)}`,
  );
  assert(
    imageEffectCropProbe.canvas2d.diagnostics.preprocessFailures === 0
      && imageEffectCropProbe.canvaskit.diagnostics.preprocessFailures === 0,
    `image effect preprocessing failures=${JSON.stringify(imageEffectCropProbe)}`,
  );
  assert(
    imageEffectCropProbe.canvas2d.diagnostics.preprocessTimeMs >= 0
      && imageEffectCropProbe.canvaskit.diagnostics.preprocessTimeMs >= 0
      && imageEffectCropProbe.canvas2d.diagnostics.maxPreprocessTimeMs >= 0
      && imageEffectCropProbe.canvaskit.diagnostics.maxPreprocessTimeMs >= 0,
    `image effect preprocessing timing diagnostics=${JSON.stringify(imageEffectCropProbe)}`,
  );
  assert(
    imageEffectCropProbe.canvas2d.diagnostics.heapDeltaBytes >= 0
      && imageEffectCropProbe.canvaskit.diagnostics.heapDeltaBytes >= 0
      && imageEffectCropProbe.canvas2d.diagnostics.maxHeapDeltaBytes >= 0
      && imageEffectCropProbe.canvaskit.diagnostics.maxHeapDeltaBytes >= 0,
    `image effect heap diagnostics=${JSON.stringify(imageEffectCropProbe)}`,
  );
  assert(
    imageEffectCropProbe.canvas2d.diagnostics.offscreenCanvasPreprocesses
      + imageEffectCropProbe.canvas2d.diagnostics.htmlCanvasPreprocesses === 1,
    `image effect canvas2d preprocessing canvas diagnostics=${JSON.stringify(imageEffectCropProbe)}`,
  );
  assert(
    imageEffectCropProbe.canvaskit.diagnostics.offscreenCanvasPreprocesses
      + imageEffectCropProbe.canvaskit.diagnostics.htmlCanvasPreprocesses === 0,
    `image effect preprocessing canvas backend diagnostics=${JSON.stringify(imageEffectCropProbe)}`,
  );
  assert(
    imageEffectCropProbe.afterReset.canvas2d.preprocessedPixels === 0
      && imageEffectCropProbe.afterReset.canvas2d.preprocessTimeMs === 0
      && imageEffectCropProbe.afterReset.canvaskit.preprocessedPixels === 0
      && imageEffectCropProbe.afterReset.canvaskit.preprocessTimeMs === 0,
    `image effect diagnostics reset=${JSON.stringify(imageEffectCropProbe.afterReset)}`,
  );
  const imageEffectCropDiff = await comparePngBuffers(
    pngBufferFromDataUrl(imageEffectCropProbe.canvas2d.png),
    pngBufferFromDataUrl(imageEffectCropProbe.canvaskit.png),
    {
      diffName: 'image-effect-crop-preprocess-parity',
      ignoreChannelDelta: 1,
      maxDiffPixels: 0,
    },
  );
  assert(
    imageEffectCropDiff.passed,
    `image effect crop parity exact=${imageEffectCropDiff.exactDiffPixels}, tolerant=${imageEffectCropDiff.rawTolerantDiffPixels}, max_channel_delta=${imageEffectCropDiff.maxChannelDelta}`,
  );
  for (const effect of ['grayScale', 'blackWhite']) {
    const effectProbe = imageEffectCropProbe.directEffects?.[effect];
    assert(effectProbe, `image effect ${effect} direct probe available`);
    assert(
      effectProbe.canvas2d.diagnostics.preprocessedPixels === 64
        && effectProbe.canvaskit.diagnostics.preprocessedPixels === 64
        && effectProbe.canvas2d.diagnostics.preprocessFailures === 0
        && effectProbe.canvaskit.diagnostics.preprocessFailures === 0,
      `image effect ${effect} crop diagnostics=${JSON.stringify(effectProbe)}`,
    );
    assert(
      effectProbe.canvaskit.diagnostics.offscreenCanvasPreprocesses
        + effectProbe.canvaskit.diagnostics.htmlCanvasPreprocesses === 0,
      `image effect ${effect} CanvasKit preprocessing canvas diagnostics=${JSON.stringify(effectProbe)}`,
    );
    const effectDiff = await comparePngBuffers(
      pngBufferFromDataUrl(effectProbe.canvas2d.png),
      pngBufferFromDataUrl(effectProbe.canvaskit.png),
      {
        diffName: `image-effect-${effect}-crop-parity`,
        ignoreChannelDelta: 1,
        maxDiffPixels: 0,
      },
    );
    assert(
      effectDiff.passed,
      `image effect ${effect} parity exact=${effectDiff.exactDiffPixels}, tolerant=${effectDiff.rawTolerantDiffPixels}, max_channel_delta=${effectDiff.maxChannelDelta}`,
    );
  }
  assert(
    imageEffectCropProbe.tileCanvas2d.diagnostics.preprocessedPixels === 4096
      && imageEffectCropProbe.tileCanvaskit.diagnostics.preprocessedPixels === 4096,
    `image effect tile+crop preprocessing pixels=${JSON.stringify(imageEffectCropProbe)}`,
  );
  assert(
    imageEffectCropProbe.tileCanvaskit.diagnostics.offscreenCanvasPreprocesses
      + imageEffectCropProbe.tileCanvaskit.diagnostics.htmlCanvasPreprocesses === 0,
    `image effect tile+crop CanvasKit preprocessing canvas diagnostics=${JSON.stringify(imageEffectCropProbe)}`,
  );
  const imageEffectTileCropDiff = await comparePngBuffers(
    pngBufferFromDataUrl(imageEffectCropProbe.tileCanvas2d.png),
    pngBufferFromDataUrl(imageEffectCropProbe.tileCanvaskit.png),
    {
      diffName: 'image-effect-tile-crop-parity',
      ignoreChannelDelta: 1,
      maxDiffPixels: 0,
    },
  );
  assert(
    imageEffectTileCropDiff.passed,
    `image effect tile+crop parity exact=${imageEffectTileCropDiff.exactDiffPixels}, tolerant=${imageEffectTileCropDiff.rawTolerantDiffPixels}, max_channel_delta=${imageEffectTileCropDiff.maxChannelDelta}`,
  );
  assert(
    imageEffectCropProbe.noneCanvas2d.diagnostics.preprocessedPixels === 256
      && imageEffectCropProbe.noneCanvaskit.diagnostics.preprocessedPixels === 256
      && imageEffectCropProbe.noneCanvas2d.diagnostics.preprocessFailures === 0
      && imageEffectCropProbe.noneCanvaskit.diagnostics.preprocessFailures === 0,
    `image effect fillMode=none crop preprocessing pixels=${JSON.stringify(imageEffectCropProbe)}`,
  );
  assert(
    imageEffectCropProbe.noneCanvaskit.diagnostics.offscreenCanvasPreprocesses
      + imageEffectCropProbe.noneCanvaskit.diagnostics.htmlCanvasPreprocesses === 0,
    `image effect fillMode=none CanvasKit preprocessing canvas diagnostics=${JSON.stringify(imageEffectCropProbe)}`,
  );
  const imageEffectNoneCropDiff = await comparePngBuffers(
    pngBufferFromDataUrl(imageEffectCropProbe.noneCanvas2d.png),
    pngBufferFromDataUrl(imageEffectCropProbe.noneCanvaskit.png),
    {
      diffName: 'image-effect-none-crop-parity',
      ignoreChannelDelta: 1,
      maxDiffPixels: 0,
    },
  );
  assert(
    imageEffectNoneCropDiff.passed,
    `image effect fillMode=none crop parity exact=${imageEffectNoneCropDiff.exactDiffPixels}, tolerant=${imageEffectNoneCropDiff.rawTolerantDiffPixels}, max_channel_delta=${imageEffectNoneCropDiff.maxChannelDelta}`,
  );
  assert(
    imageEffectCropProbe.invalidSourceFallback.imageAvailable
      && imageEffectCropProbe.invalidSourceFallback.width === 64
      && imageEffectCropProbe.invalidSourceFallback.height === 64,
    `image effect invalid source rect falls back to original image=${JSON.stringify(imageEffectCropProbe.invalidSourceFallback)}`,
  );
  assert(
    imageEffectCropProbe.invalidSourceFallback.diagnostics.cacheMisses === 1
      && imageEffectCropProbe.invalidSourceFallback.diagnostics.preprocessFailures === 1
      && imageEffectCropProbe.invalidSourceFallback.diagnostics.fallbackToOriginal === 1
      && imageEffectCropProbe.invalidSourceFallback.diagnostics.preprocessedPixels === 0
      && imageEffectCropProbe.invalidSourceFallback.diagnostics.preprocessedBytes === 0,
    `image effect invalid source rect records direct fallback diagnostics=${JSON.stringify(imageEffectCropProbe.invalidSourceFallback)}`,
  );
  assert(
    imageEffectCropProbe.invalidSourceFallback.diagnostics.offscreenCanvasPreprocesses
      + imageEffectCropProbe.invalidSourceFallback.diagnostics.htmlCanvasPreprocesses === 0,
    `image effect invalid source rect avoids Canvas2D preprocessing=${JSON.stringify(imageEffectCropProbe.invalidSourceFallback)}`,
  );
  assert(
    imageEffectCropProbe.directCacheReuse.firstAvailable
      && imageEffectCropProbe.directCacheReuse.secondAvailable
      && imageEffectCropProbe.directCacheReuse.sameImage,
    `image effect cache reuses CanvasKit image=${JSON.stringify(imageEffectCropProbe.directCacheReuse)}`,
  );
  assert(
    imageEffectCropProbe.directCacheReuse.afterFirst.cacheHits === 0
      && imageEffectCropProbe.directCacheReuse.afterFirst.cacheMisses === 1
      && imageEffectCropProbe.directCacheReuse.afterFirst.preprocessFailures === 0
      && imageEffectCropProbe.directCacheReuse.afterFirst.fallbackToOriginal === 0
      && imageEffectCropProbe.directCacheReuse.afterFirst.preprocessedPixels === 64
      && imageEffectCropProbe.directCacheReuse.afterFirst.preprocessedBytes === 256,
    `image effect cache first pass preprocesses once=${JSON.stringify(imageEffectCropProbe.directCacheReuse)}`,
  );
  assert(
    imageEffectCropProbe.directCacheReuse.afterSecond.cacheHits === 1
      && imageEffectCropProbe.directCacheReuse.afterSecond.cacheMisses === 1
      && imageEffectCropProbe.directCacheReuse.afterSecond.preprocessFailures === 0
      && imageEffectCropProbe.directCacheReuse.afterSecond.fallbackToOriginal === 0
      && imageEffectCropProbe.directCacheReuse.afterSecond.preprocessedPixels === 64
      && imageEffectCropProbe.directCacheReuse.afterSecond.preprocessedBytes === 256
      && imageEffectCropProbe.directCacheReuse.afterSecond.offscreenCanvasPreprocesses
      + imageEffectCropProbe.directCacheReuse.afterSecond.htmlCanvasPreprocesses === 0,
    `image effect cache hit avoids extra preprocessing=${JSON.stringify(imageEffectCropProbe.directCacheReuse)}`,
  );
  assert(
    imageEffectCropProbe.directPatternCacheReuse.firstAvailable
      && imageEffectCropProbe.directPatternCacheReuse.secondAvailable
      && imageEffectCropProbe.directPatternCacheReuse.otherAvailable
      && imageEffectCropProbe.directPatternCacheReuse.sameImage
      && imageEffectCropProbe.directPatternCacheReuse.differentImage,
    `CanvasKit pattern cache returns reusable images=${JSON.stringify(imageEffectCropProbe.directPatternCacheReuse)}`,
  );
  assert(
    imageEffectCropProbe.directPatternCacheReuse.afterFirst.cacheHits === 0
      && imageEffectCropProbe.directPatternCacheReuse.afterFirst.cacheMisses === 1
      && imageEffectCropProbe.directPatternCacheReuse.afterFirst.surfaceCreations === 1
      && imageEffectCropProbe.directPatternCacheReuse.afterFirst.directImageCreations === 0
      && imageEffectCropProbe.directPatternCacheReuse.afterFirst.surfaceFailures === 0
      && imageEffectCropProbe.directPatternCacheReuse.afterFirst.imagesCreated === 1,
    `CanvasKit pattern cache first pass creates one surface image=${JSON.stringify(
      imageEffectCropProbe.directPatternCacheReuse,
    )}`,
  );
  assert(
    imageEffectCropProbe.directPatternCacheReuse.afterSecond.cacheHits === 1
      && imageEffectCropProbe.directPatternCacheReuse.afterSecond.cacheMisses === 1
      && imageEffectCropProbe.directPatternCacheReuse.afterSecond.surfaceCreations === 1
      && imageEffectCropProbe.directPatternCacheReuse.afterSecond.directImageCreations === 0
      && imageEffectCropProbe.directPatternCacheReuse.afterSecond.surfaceFailures === 0
      && imageEffectCropProbe.directPatternCacheReuse.afterSecond.imagesCreated === 1,
    `CanvasKit pattern cache hit avoids extra surface work=${JSON.stringify(imageEffectCropProbe.directPatternCacheReuse)}`,
  );
  assert(
    imageEffectCropProbe.directPatternCacheReuse.afterOther.cacheHits === 1
      && imageEffectCropProbe.directPatternCacheReuse.afterOther.cacheMisses === 2
      && imageEffectCropProbe.directPatternCacheReuse.afterOther.surfaceCreations === 2
      && imageEffectCropProbe.directPatternCacheReuse.afterOther.directImageCreations === 0
      && imageEffectCropProbe.directPatternCacheReuse.afterOther.surfaceFailures === 0
      && imageEffectCropProbe.directPatternCacheReuse.afterOther.imagesCreated === 2,
    `CanvasKit pattern cache keys distinct pattern payloads=${JSON.stringify(
      imageEffectCropProbe.directPatternCacheReuse,
    )}`,
  );
  assert(
    imageEffectCropProbe.directPatternCacheReuse.afterReset.cacheHits === 0
      && imageEffectCropProbe.directPatternCacheReuse.afterReset.cacheMisses === 0
      && imageEffectCropProbe.directPatternCacheReuse.afterReset.surfaceCreations === 0
      && imageEffectCropProbe.directPatternCacheReuse.afterReset.directImageCreations === 0
      && imageEffectCropProbe.directPatternCacheReuse.afterReset.surfaceFailures === 0
      && imageEffectCropProbe.directPatternCacheReuse.afterReset.imagesCreated === 0,
    `CanvasKit pattern diagnostics reset=${JSON.stringify(imageEffectCropProbe.directPatternCacheReuse)}`,
  );
  assert(
    imageEffectCropProbe.directPatternCacheReuse.recovery.firstAvailable
      && imageEffectCropProbe.directPatternCacheReuse.recovery.secondAvailable
      && imageEffectCropProbe.directPatternCacheReuse.recovery.sameImage
      && imageEffectCropProbe.directPatternCacheReuse.recovery.exactPixels
      && imageEffectCropProbe.directPatternCacheReuse.recovery.afterFirst.cacheHits === 0
      && imageEffectCropProbe.directPatternCacheReuse.recovery.afterFirst.cacheMisses === 1
      && imageEffectCropProbe.directPatternCacheReuse.recovery.afterFirst.surfaceCreations === 0
      && imageEffectCropProbe.directPatternCacheReuse.recovery.afterFirst.directImageCreations === 1
      && imageEffectCropProbe.directPatternCacheReuse.recovery.afterFirst.surfaceFailures === 0
      && imageEffectCropProbe.directPatternCacheReuse.recovery.afterFirst.imagesCreated === 1,
    `CanvasKit pattern direct image matches surface pixels=${JSON.stringify(
      imageEffectCropProbe.directPatternCacheReuse,
    )}`,
  );
  assert(
    imageEffectCropProbe.directPatternCacheReuse.recovery.afterSecond.cacheHits === 1
      && imageEffectCropProbe.directPatternCacheReuse.recovery.afterSecond.cacheMisses === 1
      && imageEffectCropProbe.directPatternCacheReuse.recovery.afterSecond.failureCacheHits === 0
      && imageEffectCropProbe.directPatternCacheReuse.recovery.afterSecond.surfaceCreations === 0
      && imageEffectCropProbe.directPatternCacheReuse.recovery.afterSecond.directImageCreations === 1
      && imageEffectCropProbe.directPatternCacheReuse.recovery.afterSecond.surfaceFailures === 0
      && imageEffectCropProbe.directPatternCacheReuse.recovery.afterSecond.imagesCreated === 1,
    `CanvasKit pattern direct image is cached=${JSON.stringify(
      imageEffectCropProbe.directPatternCacheReuse,
    )}`,
  );
  assert(
    !imageEffectCropProbe.directPatternCacheReuse.failure.firstAvailable
      && !imageEffectCropProbe.directPatternCacheReuse.failure.secondAvailable
      && imageEffectCropProbe.directPatternCacheReuse.failure.afterFirst.cacheHits === 0
      && imageEffectCropProbe.directPatternCacheReuse.failure.afterFirst.cacheMisses === 1
      && imageEffectCropProbe.directPatternCacheReuse.failure.afterFirst.surfaceCreations === 0
      && imageEffectCropProbe.directPatternCacheReuse.failure.afterFirst.directImageCreations === 0
      && imageEffectCropProbe.directPatternCacheReuse.failure.afterFirst.surfaceFailures === 1
      && imageEffectCropProbe.directPatternCacheReuse.failure.afterFirst.imagesCreated === 0,
    `CanvasKit pattern creation failure records first miss=${JSON.stringify(
      imageEffectCropProbe.directPatternCacheReuse,
    )}`,
  );
  assert(
    imageEffectCropProbe.directPatternCacheReuse.failure.afterSecond.cacheHits === 1
      && imageEffectCropProbe.directPatternCacheReuse.failure.afterSecond.cacheMisses === 1
      && imageEffectCropProbe.directPatternCacheReuse.failure.afterSecond.failureCacheHits === 1
      && imageEffectCropProbe.directPatternCacheReuse.failure.afterSecond.surfaceCreations === 0
      && imageEffectCropProbe.directPatternCacheReuse.failure.afterSecond.directImageCreations === 0
      && imageEffectCropProbe.directPatternCacheReuse.failure.afterSecond.surfaceFailures === 2
      && imageEffectCropProbe.directPatternCacheReuse.failure.afterSecond.imagesCreated === 0,
    `CanvasKit pattern failure cache avoids repeated creation work and reports each failed replay=${JSON.stringify(
      imageEffectCropProbe.directPatternCacheReuse,
    )}`,
  );
  const imageEffectRuntimeAlignment = classifyCanvasKitPageRuntimeConditions({
    items: [{
      path: 'synthetic/image-effect',
      runtimeConditions: ['canvasKitImageEffectPreprocess'],
    }],
  }, {
    imageEffects: {
      canvaskit: imageEffectCropProbe.canvaskit.diagnostics,
    },
  });
  assert(
    imageEffectRuntimeAlignment.length === 1
      && imageEffectRuntimeAlignment[0].status === 'observed',
    `CanvasKit image-effect runtime prerequisite observed=${JSON.stringify(
      imageEffectRuntimeAlignment,
    )}`,
  );
  const patternRuntimeAlignment = classifyCanvasKitPageRuntimeConditions({
    items: [{
      path: 'synthetic/pattern',
      runtimeConditions: ['canvasKitPatternImageConstruction'],
    }],
  }, {
    patternDiagnostics: imageEffectCropProbe.directPatternCacheReuse.afterOther,
  });
  assert(
    patternRuntimeAlignment.length === 1
      && patternRuntimeAlignment[0].status === 'observed',
    `CanvasKit pattern runtime prerequisite observed=${JSON.stringify(
      patternRuntimeAlignment,
    )}`,
  );
  const failedPatternRuntimeAlignment = classifyCanvasKitPageRuntimeConditions({
    items: [{
      path: 'synthetic/pattern-failure',
      runtimeConditions: ['canvasKitPatternImageConstruction'],
    }],
  }, {
    patternDiagnostics:
      imageEffectCropProbe.directPatternCacheReuse.failure.afterFirst,
  });
  assert(
    failedPatternRuntimeAlignment.length === 1
      && failedPatternRuntimeAlignment[0].status === 'failed',
    `CanvasKit pattern runtime prerequisite failure classified=${JSON.stringify(
      failedPatternRuntimeAlignment,
    )}`,
  );

  setTestCase('canvaskit-dispose');
  await loadApp(page, '?renderer=canvaskit&canvaskitMode=default');
  await loadHwpFile(page, 'pic-crop-01.hwp');

  const beforeDispose = await page.evaluate(() => {
    const canvasView = window.__canvasView;
    const renderer = canvasView?.pageRenderer?.canvaskitRenderer;
    return {
      hasRenderer: !!renderer,
      imageCacheSize: renderer?.imageCache?.size ?? -1,
      mipmappedImageCacheSize: renderer?.mipmappedImageCache?.size ?? -1,
      domImageCacheSize: renderer?.domImageCache?.size ?? -1,
      patternImageCacheSize: renderer?.patternImageCache?.size ?? -1,
      staticPictureCacheSize: renderer?.staticPictureCache?.size ?? -1,
      textBlobCacheSize: renderer?.textBlobCache?.size ?? -1,
      textFallbackFamilyCacheSize: renderer?.textFallbackFamilyCache?.size ?? -1,
      fontAliasCount: renderer?.fontAliases?.size ?? -1,
      layerTreeCacheSize: canvasView?.pageRenderer?.layerTreeCache?.size ?? -1,
    };
  });

  assert(beforeDispose.hasRenderer, 'canvaskit renderer available');
  assert(
    beforeDispose.fontAliasCount > 0
      || beforeDispose.layerTreeCacheSize > 0
      || beforeDispose.imageCacheSize > 0
      || beforeDispose.mipmappedImageCacheSize > 0
      || beforeDispose.domImageCacheSize > 0
      || beforeDispose.patternImageCacheSize > 0
      || beforeDispose.staticPictureCacheSize > 0,
    `canvaskit reusable state populated before dispose=${JSON.stringify(beforeDispose)}`,
  );
  assert(beforeDispose.fontAliasCount > 0, `font aliases registered before dispose=${beforeDispose.fontAliasCount}`);
  assert(beforeDispose.layerTreeCacheSize > 0, `page layer cache populated before dispose=${beforeDispose.layerTreeCacheSize}`);

  const afterDispose = await page.evaluate(() => {
    const canvasView = window.__canvasView;
    const renderer = canvasView?.pageRenderer?.canvaskitRenderer;
    if (!renderer || typeof renderer.dispose !== 'function') {
      return { error: 'canvaskit renderer dispose unavailable' };
    }

    let disposeCalls = 0;
    const originalDispose = renderer.dispose.bind(renderer);
    renderer.dispose = () => {
      disposeCalls += 1;
      return originalDispose();
    };

    canvasView.dispose();

    return {
      disposeCalls,
      imageCacheSize: renderer.imageCache?.size ?? -1,
      mipmappedImageCacheSize: renderer.mipmappedImageCache?.size ?? -1,
      domImageCacheSize: renderer.domImageCache?.size ?? -1,
      patternImageCacheSize: renderer.patternImageCache?.size ?? -1,
      staticPictureCacheSize: renderer.staticPictureCache?.size ?? -1,
      textBlobCacheSize: renderer.textBlobCache?.size ?? -1,
      textFallbackFamilyCacheSize: renderer.textFallbackFamilyCache?.size ?? -1,
      fontAliasCount: renderer.fontAliases?.size ?? -1,
      lastRenderedTree: renderer.lastRenderedTree ? 'present' : 'null',
      lastTargetCanvas: renderer.lastTargetCanvas ? 'present' : 'null',
      layerTreeCacheSize: canvasView.pageRenderer?.layerTreeCache?.size ?? -1,
      currentVisiblePages: canvasView.currentVisiblePages?.length ?? -1,
    };
  });

  assert(!afterDispose.error, afterDispose.error || 'canvaskit renderer dispose available');
  assert(afterDispose.disposeCalls === 1, `canvaskit dispose called once=${afterDispose.disposeCalls}`);
  assert(afterDispose.imageCacheSize === 0, `image cache cleared=${afterDispose.imageCacheSize}`);
  assert(afterDispose.mipmappedImageCacheSize === 0, `mipmap cache cleared=${afterDispose.mipmappedImageCacheSize}`);
  assert(afterDispose.domImageCacheSize === -1, `dom image cache removed=${afterDispose.domImageCacheSize}`);
  assert(afterDispose.patternImageCacheSize === 0, `pattern cache cleared=${afterDispose.patternImageCacheSize}`);
  assert(afterDispose.staticPictureCacheSize === 0, `static picture cache cleared=${afterDispose.staticPictureCacheSize}`);
  assert(afterDispose.textBlobCacheSize === 0, `text blob cache cleared=${afterDispose.textBlobCacheSize}`);
  assert(afterDispose.textFallbackFamilyCacheSize === 0, `text fallback family cache cleared=${afterDispose.textFallbackFamilyCacheSize}`);
  assert(afterDispose.fontAliasCount === 0, `font aliases cleared=${afterDispose.fontAliasCount}`);
  assert(afterDispose.lastRenderedTree === 'null', `last rendered tree released=${afterDispose.lastRenderedTree}`);
  assert(afterDispose.lastTargetCanvas === 'null', `last target canvas released=${afterDispose.lastTargetCanvas}`);
  assert(afterDispose.layerTreeCacheSize === 0, `page layer cache cleared=${afterDispose.layerTreeCacheSize}`);
  assert(afterDispose.currentVisiblePages === 0, `visible pages reset=${afterDispose.currentVisiblePages}`);
}, { skipLoadApp: true });
