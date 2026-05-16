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
        ...reservedPayloadEnvelopes.colorLayers,
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
        ...colrV1PayloadEnvelope,
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
        ...(envelope ?? { payloadKind }),
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
      const reservedV2ColorPayloadColrV1 = render(makeReservedV2ColorPayloadColrV1Tree(), true);
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
      const unsupported = render(makeTree({ ...style, underline: 'bottom' }), true);
      const unsupportedPayload = render(makeTree(style, []), true);
      return {
        fallback,
        strict,
        strictSidecar,
        duplicateSidecar,
        invalidAnchorSidecar,
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
        reservedV2ColorPayloadColrV1,
        invalidReservedV2ColorPayloadColrV1,
        reservedV2BitmapPayload,
        invalidReservedV2BitmapPayload,
        reservedV2SvgPayload,
        invalidReservedV2SvgPayload,
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
  const reservedV2ColorPayloadColrV1IssueCodes = canvas2dGlyphOutlineProbe
    .reservedV2ColorPayloadColrV1
    ?.textV2Validation
    ?.map((issue) => issue.code) ?? [];
  const invalidReservedV2ColorPayloadColrV1IssueCodes = canvas2dGlyphOutlineProbe
    .invalidReservedV2ColorPayloadColrV1
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
      && !invalidReservedV2ColorPayloadColrV1IssueCodes.includes('glyphOutlinePayloadKindFeatureMissing')
      && invalidReservedV2ColorPayloadColrV1IssueCodes.includes('glyphOutlinePayloadContractInvalid'),
    `Canvas2D strict profile rejects reserved color outline payload=${JSON.stringify({
      report: reservedColorPayloadSidecarReport,
      sidecarValidation: canvas2dGlyphOutlineProbe.reservedColorPayloadSidecar?.textV2Validation,
      v2Validation: canvas2dGlyphOutlineProbe.reservedV2ColorPayload?.textV2Validation,
      v2ColrV1Validation: canvas2dGlyphOutlineProbe.reservedV2ColorPayloadColrV1?.textV2Validation,
      invalidV2ColrV1Validation: canvas2dGlyphOutlineProbe
        .invalidReservedV2ColorPayloadColrV1
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
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
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
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const imageData = canvas.getContext('2d')?.getImageData(0, 0, tree.pageWidth, tree.pageHeight).data;
      let blackPixels = 0;
      let bluePixels = 0;
      let redPixels = 0;
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
        }
      }
      const png = canvas.toDataURL('image/png');
      const diagnostics = renderer.getTextVariantSelectionDiagnostics();
      canvas.remove();
      return { png, diagnostics, blackPixels, bluePixels, redPixels };
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
        imageResourceId: 0,
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

    return {
      monochrome: await render(treeFor(outlineFor('canvaskit-outline-mono'))),
      stroke: await render(treeFor(strokeOutline)),
      colorLayers: await render(treeFor(colorOutline)),
      colorLayersColrV1: await render(treeFor(colorV1Outline)),
      bitmapGlyph: await render(treeFor(bitmapOutline)),
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
