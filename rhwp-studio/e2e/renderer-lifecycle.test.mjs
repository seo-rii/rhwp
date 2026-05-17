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
import { PNG } from 'pngjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RHWP_ROOT = path.resolve(__dirname, '..', '..');
const CANVASKIT_COLOR_GLYPH_SMOKE_GATE = process.env.RHWP_CANVASKIT_COLOR_GLYPH_SMOKE === '1';
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
        children: [{
          kind: 'leaf',
          sourceNodeId: 2000 + pageIdx,
          bounds: { x: 0, y: 0, width: 100, height: 100 },
          cacheHint: 'none',
          ops: [],
        }],
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

    try {
      pageRenderer.clearLayerTreeCache();
      renderer.clearStaticPictureCache?.();
      pageRenderer.renderPage(0, { ...pageInfo, pageIndex: 0 }, canvas, 1);
      pageRenderer.cancelReRender(0);
      const afterFirstPage = renderer.staticPictureCache?.size ?? -1;
      pageRenderer.renderPage(1, { ...pageInfo, pageIndex: 1 }, canvas, 1);
      pageRenderer.cancelReRender(1);
      const afterSecondPage = renderer.staticPictureCache?.size ?? -1;
      const cacheKeys = Array.from(renderer.staticPictureCache?.keys?.() ?? []);
      pageRenderer.clearLayerTreeCache();
      const afterClear = renderer.staticPictureCache?.size ?? -1;
      return { afterFirstPage, afterSecondPage, afterClear, cacheKeys };
    } finally {
      pageRenderer.cancelAll?.();
      pageRenderer.clearLayerTreeCache?.();
      pageRenderer.wasm.getPageLayerTree = originalGetPageLayerTree;
    }
  });

  assert(!staticPictureProbe.error, staticPictureProbe.error || 'canvaskit static picture cache probe available');
  assert(
    staticPictureProbe.afterFirstPage > 0,
    `static picture cache populated after first page=${staticPictureProbe.afterFirstPage}`,
  );
  assert(
    staticPictureProbe.afterSecondPage > staticPictureProbe.afterFirstPage,
    `static picture cache keeps multiple pages=${JSON.stringify(staticPictureProbe)}`,
  );
  assert(staticPictureProbe.afterClear === 0, `static picture cache released with layer tree cache=${staticPictureProbe.afterClear}`);

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
      && cpuSurfaceAliasProbe.request?.unsupportedReason === null
      && cpuSurfaceAliasProbe.diagnostics?.preference === 'software',
    `canvaskitSurface=cpu aliases to software=${JSON.stringify(cpuSurfaceAliasProbe)}`,
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
  const webgpuSurfaceParamProbe = await page.evaluate(() => ({
    preference: window.__canvaskitSurfacePreference,
    request: window.__canvaskitSurfaceRequest,
    backend: window.__canvasView?.pageRenderer?.canvaskitRenderer?.getSurfaceDiagnostics?.().backend ?? null,
    diagnostics: window.__canvasView?.pageRenderer?.canvaskitRenderer?.getSurfaceDiagnostics?.() ?? null,
  }));
  assert(
    webgpuSurfaceParamProbe.preference === 'auto',
    `unsupported WebGPU surface request resolves to auto=${JSON.stringify(webgpuSurfaceParamProbe)}`,
  );
  assert(
    webgpuSurfaceParamProbe.request?.unsupportedValue === 'webgpu'
      && webgpuSurfaceParamProbe.request?.unsupportedReason === 'unsupportedSurfaceBackend'
      && webgpuSurfaceParamProbe.diagnostics?.unsupportedValue === 'webgpu'
      && webgpuSurfaceParamProbe.diagnostics?.unsupportedReason === 'unsupportedSurfaceBackend',
    `unsupported WebGPU surface request remains diagnosable=${JSON.stringify(webgpuSurfaceParamProbe)}`,
  );

  setTestCase('layer-resource-cache-invalidation');
  await loadApp(page, '?renderer=canvaskit&canvaskitMode=default&canvaskitSurface=auto');
  await loadHwpFile(page, '20250130-hongbo_saved.hwp');
  const resourceInvalidationProbe = await page.evaluate(() => {
    const canvasView = window.__canvasView;
    const wasm = window.__wasm;
    if (!canvasView || !wasm?.getPageLayerTree) {
      return { error: 'canvas view or wasm bridge unavailable' };
    }

    const beforeTree = wasm.getPageLayerTree(0, 'screen');
    const beforeResources = beforeTree.resources;
    canvasView.refreshPages();
    const afterTree = wasm.getPageLayerTree(0, 'screen');
    const afterResources = afterTree.resources;

    return {
      beforeImageCount: beforeResources?.images?.length ?? -1,
      afterImageCount: afterResources?.images?.length ?? -1,
      beforeTableId: beforeResources?.tableId ?? null,
      afterTableId: afterResources?.tableId ?? null,
      sameResourceTable: beforeResources === afterResources,
      layerTreeCacheSize: canvasView.pageRenderer?.layerTreeCache?.size ?? -1,
    };
  });

  assert(!resourceInvalidationProbe.error, resourceInvalidationProbe.error || 'layer resource invalidation probe available');
  assert(
    resourceInvalidationProbe.beforeImageCount > 0,
    `resource table populated before refresh=${JSON.stringify(resourceInvalidationProbe)}`,
  );
  assert(
    resourceInvalidationProbe.afterImageCount > 0,
    `resource table repopulated after refresh=${JSON.stringify(resourceInvalidationProbe)}`,
  );
  assert(
    resourceInvalidationProbe.sameResourceTable === false,
    `resource table generation changes on refresh=${JSON.stringify(resourceInvalidationProbe)}`,
  );
  assert(
    resourceInvalidationProbe.beforeTableId !== resourceInvalidationProbe.afterTableId,
    `resource table id changes on refresh=${JSON.stringify(resourceInvalidationProbe)}`,
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
  const portableGlyphRunProbe = await page.evaluate(({ fontBytes, colorFontBytes, colorFontDigest }) => {
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
        fontBlobKeys: [`font:fixture:${fontBytes.length}:${digest}`],
      },
      fontResources: {
        blobs: [{
          id: 'fixture-font-blob',
          source: 'bundled',
          portability: 'portableBlob',
          digest: { algorithm: 'fixture', value: digest },
          dataRef: { kind: 'fontBlob', id: '0' },
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
      candidate.resources.fontBlobHashes = [digestValue];
      candidate.resources.fontBlobKeys = [`font:fixture:${fontBytes.length}:${digestValue}`];
      candidate.fontResources.blobs[0].id = blobId;
      candidate.fontResources.blobs[0].digest = { algorithm: 'fixture', value: digestValue };
      candidate.fontResources.blobs[0].dataRef = { kind: 'fontBlob', id: '0' };
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
                dataRef: { kind: 'fontBlob', id: '0' },
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
      ['emboss', (style) => ({ ...style, emboss: true })],
      ['engrave', (style) => ({ ...style, engrave: true })],
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
      unsupportedStatus,
      unsupportedEffectReasons,
      unsupportedPng,
      digestMismatchStatus,
      digestMismatchPng,
      nonPortableStatus,
      nonPortablePng,
      outOfRangeStatus,
      outOfRangePng,
      variationStatus,
      variationNegativeStatuses,
      variationSelectionDiagnostics,
      variationPng,
      faceIndexStatus,
      faceIndexSelectionDiagnostics,
      faceIndexPng,
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
  }, { fontBytes: glyphRunFontBytes, colorFontBytes: colorGlyphFontBytes, colorFontDigest: colorGlyphFontDigest });

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
  console.log(`[report-only] CanvasKit color glyph smoke ${JSON.stringify(colorGlyphSmokeSummary)}`);
  if (CANVASKIT_COLOR_GLYPH_SMOKE_GATE) {
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
  }
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
      emboss: 'glyphRunEmbossUnsupported',
      engrave: 'glyphRunEngraveUnsupported',
      shade: 'glyphRunShadeUnsupported',
    }),
    `CanvasKit GlyphRun reports precise unsupported effect reasons=${JSON.stringify(portableGlyphRunProbe.unsupportedEffectReasons)}`,
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
      && portableGlyphRunProbe.faceIndexStatus?.reason === 'faceIndexUnsupported',
    `CanvasKit GlyphRun rejects TTC/OTC-style non-zero face index=${JSON.stringify(portableGlyphRunProbe.faceIndexStatus)}`,
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
        colorPayloadSidecar,
        colorV1PayloadSidecar,
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
        reservedV2ColorPayload,
        invalidRangeReservedV2ColorPayload,
        invalidColorReservedV2ColorPayload,
        invalidCommandReservedV2ColorPayload,
        reservedV2ColorPayloadColrV1,
        invalidRangeReservedV2ColorPayloadColrV1,
        invalidReservedV2ColorPayloadColrV1,
        cyclicReservedV2ColorPayloadColrV1,
        invalidNodeIdReservedV2ColorPayloadColrV1,
        invalidTransformReservedV2ColorPayloadColrV1,
        invalidCommandReservedV2ColorPayloadColrV1,
        reservedV2BitmapPayload,
        invalidReservedV2BitmapPayload,
        invalidReservedV2BitmapTransformPayload,
        invalidReservedV2BitmapRangePayload,
        invalidReservedV2BitmapResourcePayload,
        invalidReservedV2BitmapPlacementPayload,
        invalidReservedV2BitmapAlphaPayload,
        invalidReservedV2BitmapScalingPayload,
        invalidReservedV2BitmapFilteringPayload,
        reservedV2SvgPayload,
        invalidReservedV2SvgPayload,
        invalidReservedV2SvgViewBoxPayload,
        invalidReservedV2SvgRangePayload,
        invalidReservedV2SvgResourcePayload,
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
  const invalidCommandReservedV2ColorPayloadIssueCodes = canvas2dGlyphOutlineProbe
    .invalidCommandReservedV2ColorPayload
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
  const invalidReservedV2ColorPayloadColrV1IssueCodes = canvas2dGlyphOutlineProbe
    .invalidReservedV2ColorPayloadColrV1
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const cyclicReservedV2ColorPayloadColrV1IssueCodes = canvas2dGlyphOutlineProbe
    .cyclicReservedV2ColorPayloadColrV1
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const invalidNodeIdReservedV2ColorPayloadColrV1IssueCodes = canvas2dGlyphOutlineProbe
    .invalidNodeIdReservedV2ColorPayloadColrV1
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
      && invalidCommandReservedV2ColorPayloadIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidCommandReservedV2ColorPayloadIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && invalidRangeReservedV2ColorPayloadColrV1IssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidRangeReservedV2ColorPayloadColrV1IssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && !invalidReservedV2ColorPayloadColrV1IssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && invalidReservedV2ColorPayloadColrV1IssueCodes.includes('glyphOutlinePayloadContractInvalid'),
    `Canvas2D strict profile rejects reserved color outline payload=${JSON.stringify({
      report: reservedColorPayloadSidecarReport,
      sidecarValidation: canvas2dGlyphOutlineProbe.reservedColorPayloadSidecar?.textV2Validation,
      v2Validation: canvas2dGlyphOutlineProbe.reservedV2ColorPayload?.textV2Validation,
      invalidRangeV2Validation: canvas2dGlyphOutlineProbe.invalidRangeReservedV2ColorPayload
        ?.textV2Validation,
      invalidColorV2Validation: canvas2dGlyphOutlineProbe.invalidColorReservedV2ColorPayload
        ?.textV2Validation,
      invalidCommandV2Validation: canvas2dGlyphOutlineProbe.invalidCommandReservedV2ColorPayload
        ?.textV2Validation,
      v2ColrV1Validation: canvas2dGlyphOutlineProbe.reservedV2ColorPayloadColrV1?.textV2Validation,
      invalidRangeV2ColrV1Validation: canvas2dGlyphOutlineProbe
        .invalidRangeReservedV2ColorPayloadColrV1
        ?.textV2Validation,
      invalidV2ColrV1Validation: canvas2dGlyphOutlineProbe
        .invalidReservedV2ColorPayloadColrV1
        ?.textV2Validation,
    })}`,
  );
  assert(
    cyclicReservedV2ColorPayloadColrV1IssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && invalidNodeIdReservedV2ColorPayloadColrV1IssueCodes.includes('glyphOutlinePayloadContractInvalid'),
    `Canvas2D strict profile rejects invalid COLRv1 color graph payload=${JSON.stringify({
      cyclicV2ColrV1Validation: canvas2dGlyphOutlineProbe
        .cyclicReservedV2ColorPayloadColrV1
        ?.textV2Validation,
      invalidNodeIdV2ColrV1Validation: canvas2dGlyphOutlineProbe
        .invalidNodeIdReservedV2ColorPayloadColrV1
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
  const invalidReservedV2BitmapRangeIssueCodes = canvas2dGlyphOutlineProbe
    .invalidReservedV2BitmapRangePayload
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
  const invalidReservedV2BitmapFilteringIssueCodes = canvas2dGlyphOutlineProbe
    .invalidReservedV2BitmapFilteringPayload
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  assert(
    invalidReservedV2BitmapTransformIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidReservedV2BitmapTransformIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && invalidReservedV2BitmapRangeIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidReservedV2BitmapRangeIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && invalidReservedV2BitmapResourceIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidReservedV2BitmapResourceIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && invalidReservedV2BitmapPlacementIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidReservedV2BitmapPlacementIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && invalidReservedV2BitmapAlphaIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidReservedV2BitmapAlphaIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && invalidReservedV2BitmapScalingIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidReservedV2BitmapScalingIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && invalidReservedV2BitmapFilteringIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidReservedV2BitmapFilteringIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing'),
    `Canvas2D strict profile rejects non-finite BitmapGlyph transform contract=${JSON.stringify({
      invalidV2BitmapTransformValidation: canvas2dGlyphOutlineProbe.invalidReservedV2BitmapTransformPayload
        ?.textV2Validation,
      invalidV2BitmapRangeValidation: canvas2dGlyphOutlineProbe.invalidReservedV2BitmapRangePayload
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
      invalidV2BitmapFilteringValidation: canvas2dGlyphOutlineProbe.invalidReservedV2BitmapFilteringPayload
        ?.textV2Validation,
    })}`,
  );
  const invalidReservedV2SvgViewBoxIssueCodes = canvas2dGlyphOutlineProbe
    .invalidReservedV2SvgViewBoxPayload
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const invalidReservedV2SvgRangeIssueCodes = canvas2dGlyphOutlineProbe
    .invalidReservedV2SvgRangePayload
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const invalidReservedV2SvgResourceIssueCodes = canvas2dGlyphOutlineProbe
    .invalidReservedV2SvgResourcePayload
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  assert(
    invalidReservedV2SvgViewBoxIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidReservedV2SvgViewBoxIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && invalidReservedV2SvgRangeIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidReservedV2SvgRangeIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && invalidReservedV2SvgResourceIssueCodes.includes('glyphOutlinePayloadContractInvalid')
      && !invalidReservedV2SvgResourceIssueCodes.includes('glyphOutlinePayloadKindFeatureMissing'),
    `Canvas2D strict profile rejects invalid SvgGlyph viewBox contract=${JSON.stringify({
      invalidV2SvgViewBoxValidation: canvas2dGlyphOutlineProbe.invalidReservedV2SvgViewBoxPayload
        ?.textV2Validation,
      invalidV2SvgRangeValidation: canvas2dGlyphOutlineProbe.invalidReservedV2SvgRangePayload
        ?.textV2Validation,
      invalidV2SvgResourceValidation: canvas2dGlyphOutlineProbe.invalidReservedV2SvgResourcePayload
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
  const unsupportedStrokePayloadBlackPixels = countPixels(
    canvas2dGlyphOutlineProbe.unsupportedStrokePayloadSidecar.png,
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
    unsupportedStrokePayloadBlackPixels < 20,
    `Canvas2D strict outline does not replay unsupported stroke payload black=${unsupportedStrokePayloadBlackPixels}`,
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
    const duplicateBitmapResourceTree = treeFor(bitmapOutline);
    duplicateBitmapResourceTree.resources.images.push(pixelBytes);
    duplicateBitmapResourceTree.resources.imageHashes.push('bitmap-glyph-pixel-duplicate');
    duplicateBitmapResourceTree.resources.imageKeys.push('bitmap-glyph-pixel');
    const duplicateSvgResourceTree = treeFor(svgOutline);
    duplicateSvgResourceTree.resources.svgFragments.push('<path d="M0 0 L18 0 L18 18 L0 18 Z" fill="#00ffff"/>');
    duplicateSvgResourceTree.resources.svgHashes.push('svg-glyph-magenta-square-duplicate');
    duplicateSvgResourceTree.resources.svgKeys.push('svg-glyph-magenta-square');
    const unsafeSvgResourceTree = treeFor(svgOutline);
    unsafeSvgResourceTree.resources.svgFragments[0] = '<script>1</script><path d="M0 0 L18 0 L18 18 L0 18 Z" fill="#ff00cc"/>';
    unsafeSvgResourceTree.resources.svgHashes[0] = 'svg-glyph-unsafe-script';
    const unsupportedSvgStrokeTree = treeFor(svgOutline);
    unsupportedSvgStrokeTree.resources.svgFragments[0] = '<path d="M0 0 L18 0 L18 18 L0 18 Z" fill="#ff00cc" stroke="#000000"/>';
    unsupportedSvgStrokeTree.resources.svgHashes[0] = 'svg-glyph-unsupported-stroke';

    return {
      monochrome: await render(treeFor(outlineFor('canvaskit-outline-mono'))),
      stroke: await render(treeFor(strokeOutline)),
      colorLayers: await render(treeFor(colorOutline)),
      colorLayersColrV1: await render(treeFor(colorV1Outline)),
      bitmapGlyph: await render(treeFor(bitmapOutline)),
      duplicateBitmapGlyphKey: await render(duplicateBitmapResourceTree),
      svgGlyph: await render(treeFor(svgOutline)),
      duplicateSvgGlyphKey: await render(duplicateSvgResourceTree),
      unsafeSvgGlyphResource: await render(unsafeSvgResourceTree),
      unsupportedSvgGlyphStrokeResource: await render(unsupportedSvgStrokeTree),
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
  const canvaskitBitmapReport = canvaskitGlyphOutlineProbe.bitmapGlyph?.diagnostics?.find(
    (report) => report.equivalenceGroup === 'canvaskit-outline-bitmap',
  );
  assert(
    canvaskitBitmapReport?.selectedVariantId === 'glyphOutline'
      && canvaskitBitmapReport?.selectedVariantKind === 'glyphOutline',
    `CanvasKit selects BitmapGlyph GlyphOutline=${JSON.stringify(canvaskitBitmapReport)}`,
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
  const canvaskitUnsupportedSvgStrokeResourceReport = canvaskitGlyphOutlineProbe
    .unsupportedSvgGlyphStrokeResource
    ?.diagnostics
    ?.find((report) => report.equivalenceGroup === 'canvaskit-outline-svg');
  assert(
    canvaskitUnsafeSvgResourceReport?.selectedVariantId === 'textRun'
      && canvaskitUnsafeSvgResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      )
      && canvaskitUnsupportedSvgStrokeResourceReport?.selectedVariantId === 'textRun'
      && canvaskitUnsupportedSvgStrokeResourceReport?.rejectedVariants?.some(
        (variant) => variant.variantId === 'glyphOutline'
          && variant.reasons.includes('unsupportedSvgGlyph'),
      ),
    `CanvasKit rejects non-path-only SvgGlyph resources=${JSON.stringify({
      unsafe: canvaskitUnsafeSvgResourceReport,
      unsupportedStroke: canvaskitUnsupportedSvgStrokeResourceReport,
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
  const canvaskitColorBluePixels = countPixels(
    canvaskitGlyphOutlineProbe.colorLayers.png,
    (pixel) => pixel.alpha > 32 && pixel.blue > 150 && pixel.red < 100 && pixel.green < 120,
  );
  const canvaskitColorV1GreenPixels = countPixels(
    canvaskitGlyphOutlineProbe.colorLayersColrV1.png,
    (pixel) => pixel.alpha > 32 && pixel.green > 120 && pixel.red < 100 && pixel.blue < 100,
  );
  const canvaskitBitmapBlackPixels = canvaskitGlyphOutlineProbe.bitmapGlyph.blackPixels;
  const canvaskitSvgMagentaPixels = canvaskitGlyphOutlineProbe.svgGlyph.magentaPixels;
  assert(
    canvaskitMonochromeBlackPixels > 100 && canvaskitMonochromeRedPixels < 5,
    `CanvasKit strict outline paints monochrome path and suppresses fallback black=${canvaskitMonochromeBlackPixels}, red=${canvaskitMonochromeRedPixels}`,
  );
  assert(
    canvaskitStrokeBluePixels > 20,
    `CanvasKit strict outline paints stroke path blue=${canvaskitStrokeBluePixels}`,
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
    canvaskitBitmapBlackPixels > 100,
    `CanvasKit strict outline paints BitmapGlyph image black=${canvaskitBitmapBlackPixels}`,
  );
  assert(
    canvaskitSvgMagentaPixels > 100,
    `CanvasKit strict outline paints SvgGlyph vector resource magenta=${canvaskitSvgMagentaPixels}`,
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
    const bitmapOutline = outlineBase('outline-parity-bitmap', 62, {
      payloadKind: 'bitmapGlyph',
      variant: variantFor('outline-parity-bitmap', ['text.outlineGlyph', 'text.glyphOutline.bitmapGlyph']),
      paths: [],
      bitmapGlyph: {
        imageResourceId: 'bitmap-glyph-pixel',
        sourceRangeUtf8: { start: 0, end: 1 },
        glyphRange: { start: 0, end: 1 },
        placement: {
          runToPage: { a: 1, b: 0, c: 0, d: 1, e: 62, f: 8 },
          baselineY: 0,
        },
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
        viewBox: { x: 0, y: 0, width: 14, height: 14 },
        securityMode: 'staticSanitized',
        scriptAllowed: false,
        animationAllowed: false,
        externalResourcesAllowed: false,
        interactivityAllowed: false,
      },
    });
    const outlines = [colorV0Outline, colorV1Outline, bitmapOutline, svgOutline];
    const tree = {
      pageWidth: 116,
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
        svgFragments: ['<path d="M0 0 L14 0 L14 14 L0 14 Z" fill="#ff00cc"/>'],
        svgHashes: ['glyph-outline-parity-svg-magenta'],
        svgKeys: ['glyph-outline-parity-svg-magenta'],
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
        bounds: { x: 0, y: 0, width: 116, height: 32 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 116, height: 32 }, backgroundColor: '#ffffff', borderWidth: 0 },
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
  assert(
    glyphOutlinePayloadDiff.passed,
    `glyph outline payload parity exact=${glyphOutlinePayloadDiff.exactDiffPixels}, tolerant=${glyphOutlinePayloadDiff.rawTolerantDiffPixels}, ink=${glyphOutlinePayloadDiff.rawInkMaskDiffPixels}, max_channel_delta=${glyphOutlinePayloadDiff.maxChannelDelta}, canvas2dMagenta=${glyphOutlinePayloadCanvas2dMagentaPixels}, canvaskitMagenta=${glyphOutlinePayloadCanvasKitMagentaPixels}`,
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
      opacity: 1,
      pattern: null,
      shadow: {
        color: '#009900',
        alpha: 0,
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
            style: style('#fdfdfd', '#003300', 'dash'),
            gradient: null,
            transform,
          },
          {
            type: 'ellipse',
            bbox: { x: 42, y: 8, width: 24, height: 16 },
            style: style('#fdfdfd', '#003300', 'dot'),
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
            style: style('#fdfdfd', '#003300', 'dashDot'),
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
    (pixel) => pixel.alpha > 32 && pixel.green > 80 && pixel.red < 120 && pixel.blue < 120,
  );
  const shapeShadowCanvaskitGreenPixels = countPixels(
    shapeShadowFillStrokeProbe.canvaskit,
    (pixel) => pixel.alpha > 32 && pixel.green > 80 && pixel.red < 120 && pixel.blue < 120,
  );
  assert(
    shapeShadowCanvas2dGreenPixels > 200 && shapeShadowCanvaskitGreenPixels > 200,
    `shape shadow replay draws fill/stroke shadow canvas2d=${shapeShadowCanvas2dGreenPixels}, canvaskit=${shapeShadowCanvaskitGreenPixels}`,
  );
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
      pageWidth: 96,
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
        bounds: { x: 0, y: 0, width: 96, height: 28 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 96, height: 28 }, backgroundColor: '#ffffff', borderWidth: 0 },
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
        bounds: { x: 0, y: 0, width: 104, height: 54 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 104, height: 54 }, backgroundColor: '#ffffff', borderWidth: 0 },
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
              colors: ['#f04b4b', '#ffe56a', '#4878ff'],
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
              colors: ['#ffffff', '#65cf70', '#175d20'],
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
            style: style('#f8f0d8', '#6b3d00', {
              patternType: 4,
              patternColor: '#1d4f8f',
              backgroundColor: '#f8f0d8',
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
              patternColor: '#222222',
              backgroundColor: '#f6f6f6',
            }),
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
  assert(!gradientPatternParityProbe.error, gradientPatternParityProbe.error || 'gradient/pattern parity probe available');
  const gradientPatternCanvas2dInkPixels = countPixels(
    gradientPatternParityProbe.canvas2d,
    (pixel) => pixel.alpha > 32 && (pixel.red < 245 || pixel.green < 245 || pixel.blue < 245),
  );
  const gradientPatternCanvaskitInkPixels = countPixels(
    gradientPatternParityProbe.canvaskit,
    (pixel) => pixel.alpha > 32 && (pixel.red < 245 || pixel.green < 245 || pixel.blue < 245),
  );
  assert(
    gradientPatternCanvas2dInkPixels > 1000 && gradientPatternCanvaskitInkPixels > 1000,
    `gradient/pattern replay draws geometry canvas2d=${gradientPatternCanvas2dInkPixels}, canvaskit=${gradientPatternCanvaskitInkPixels}`,
  );
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
    ];
    const tree = {
      pageWidth: 96,
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
        bounds: { x: 0, y: 0, width: 96, height: 48 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 96, height: 48 }, backgroundColor: '#ffffff', borderWidth: 0 },
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
  const imageFillModeVariantDiff = await comparePngBuffers(
    pngBufferFromDataUrl(imageFillModeVariantProbe.canvas2d),
    pngBufferFromDataUrl(imageFillModeVariantProbe.canvaskit),
    {
      diffName: 'canvas-layer-image-fill-mode-variant-parity',
      ignoreChannelDelta: 4,
      maxDiffRatio: 0.02,
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
                    left: '[',
                    right: ']',
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
  const equationAdvancedDiff = await comparePngBuffers(
    pngBufferFromDataUrl(equationAdvancedLayoutParityProbe.canvas2d),
    pngBufferFromDataUrl(equationAdvancedLayoutParityProbe.canvaskit),
    {
      diffName: 'canvas-layer-equation-advanced-layout-parity',
      ignoreChannelDelta: 24,
      maxDiffRatio: 0.1,
      inkMaskMaxDiffRatio: 0.08,
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
      pageWidth: 84,
      pageHeight: 36,
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
        bounds: { x: 0, y: 0, width: 84, height: 36 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 84, height: 36 }, backgroundColor: '#ffffff', borderWidth: 0 },
          {
            type: 'textControlMark',
            bbox: { x: 8, y: 5, width: 18, height: 20 },
            mark: { kind: 'paragraphEnd', text: '¶', x: 1, y: 15, fontSize: 16 },
          },
          {
            type: 'textControlMark',
            bbox: { x: 28, y: 5, width: 18, height: 20 },
            mark: { kind: 'lineBreakEnd', text: '↵', x: 1, y: 15, fontSize: 16 },
          },
          {
            type: 'textControlMark',
            bbox: { x: 48, y: 5, width: 12, height: 20 },
            mark: { kind: 'space', text: '·', x: 1, y: 15, fontSize: 16 },
          },
          {
            type: 'footnoteMarker',
            bbox: { x: 64, y: 5, width: 18, height: 20 },
            text: '12',
            fontFamily: 'Noto Sans KR',
            fontSize: 14,
            color: '#111111',
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
      pageWidth: 94,
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
        bounds: { x: 0, y: 0, width: 94, height: 34 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 94, height: 34 }, backgroundColor: '#ffffff', borderWidth: 0 },
          {
            type: 'textRun',
            bbox: { x: 8, y: 6, width: 80, height: 22 },
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
              { kind: 'paragraphEnd', text: '¶', x: 18, y: 17, fontSize: 16 },
              { kind: 'lineBreakEnd', text: '↵', x: 38, y: 17, fontSize: 16 },
              { kind: 'space', text: '·', x: 58, y: 17, fontSize: 16 },
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

  setTestCase('canvas-layer-text-fallback-font-parity');
  const textFallbackFontProbe = await page.evaluate(async () => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2dRenderer = pageRenderer?.canvas2dRenderer;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    if (!canvas2dRenderer || !canvaskitRenderer) {
      return { error: 'renderers unavailable' };
    }
    const text = 'A₩①◆☀€';
    const tree = {
      pageWidth: 128,
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
        bounds: { x: 0, y: 0, width: 128, height: 40 },
        cacheHint: 'none',
        ops: [
          { type: 'pageBackground', bbox: { x: 0, y: 0, width: 128, height: 40 }, backgroundColor: '#ffffff', borderWidth: 0 },
          {
            type: 'textRun',
            bbox: { x: 8, y: 6, width: 112, height: 26 },
            text,
            baseline: 22,
            rotation: 0,
            isVertical: false,
            orientation: 'horizontal',
            isParaEnd: false,
            isLineBreakEnd: false,
            style: {
              fontFamily: 'Noto Serif KR',
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
            positions: Array.from({ length: text.length + 1 }, (_, index) => index * 17),
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
    const makeTextFamilies = [];
    const originalMakeTextObjects = canvaskitRenderer.makeTextObjects;
    canvaskitRenderer.makeTextObjects = function makeTextObjectsProbe(fontFamily) {
      makeTextFamilies.push(fontFamily);
      return originalMakeTextObjects.apply(this, arguments);
    };
    try {
      return {
        canvas2d,
        canvaskit: await render(canvaskitRenderer),
        makeTextFamilies,
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
    textFallbackFontProbe.makeTextFamilies.includes('Malgun Gothic')
      && textFallbackFontProbe.makeTextFamilies.includes('GulimChe'),
    `CanvasKit text fallback routes currency and symbol clusters=${JSON.stringify(textFallbackFontProbe.makeTextFamilies)}`,
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
          crop: { left: 56, top: 56, right: 64, bottom: 64 },
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
    const tileTree = {
      ...tree,
      resources: {
        ...tree.resources,
        tableId: 992,
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
    canvas2dRenderer.resetImageEffectDiagnostics();
    canvaskitRenderer.resetImageEffectDiagnostics();
    return {
      canvas2d,
      canvaskit,
      tileCanvas2d,
      tileCanvaskit,
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
  assert(
    imageEffectCropProbe.tileCanvas2d.diagnostics.preprocessedPixels === 4096
      && imageEffectCropProbe.tileCanvaskit.diagnostics.preprocessedPixels === 4096,
    `image effect tile+crop preprocessing pixels=${JSON.stringify(imageEffectCropProbe)}`,
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
  assert(afterDispose.fontAliasCount === 0, `font aliases cleared=${afterDispose.fontAliasCount}`);
  assert(afterDispose.lastRenderedTree === 'null', `last rendered tree released=${afterDispose.lastRenderedTree}`);
  assert(afterDispose.lastTargetCanvas === 'null', `last target canvas released=${afterDispose.lastTargetCanvas}`);
  assert(afterDispose.layerTreeCacheSize === 0, `page layer cache cleared=${afterDispose.layerTreeCacheSize}`);
  assert(afterDispose.currentVisiblePages === 0, `visible pages reset=${afterDispose.currentVisiblePages}`);
}, { skipLoadApp: true });
