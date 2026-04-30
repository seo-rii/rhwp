import {
  assert,
  comparePngBuffers,
  loadApp,
  loadHwpFile,
  runTest,
  setTestCase,
} from './helpers.mjs';

function pngBufferFromDataUrl(dataUrl) {
  return Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
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

  setTestCase('layer-resource-cache-invalidation');
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

    const pixelPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9pG99u0AAAAASUVORK5CYII=';
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

  setTestCase('image-effect-crop-preprocess-parity');
  await loadApp(page, '?renderer=canvaskit&canvaskitMode=default');
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
        sourceCtx.fillStyle = `rgb(${(x * 4) & 255}, ${(y * 4) & 255}, ${((x + y) * 2) & 255})`;
        sourceCtx.fillRect(x, y, 1, 1);
      }
    }
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
        bounds: { x: 0, y: 0, width: 8, height: 8 },
        cacheHint: 'none',
        ops: [{
          type: 'image',
          bbox: { x: 0, y: 0, width: 8, height: 8 },
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
    const renderWithDiagnostics = async (renderer) => {
      const canvas = document.createElement('canvas');
      canvas.width = 8;
      canvas.height = 8;
      document.body.appendChild(canvas);
      const before = renderer.getImageEffectDiagnostics();
      let after = before;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        renderer.renderPage(tree, canvas, 1);
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
        },
      };
    };

    const canvas2d = await renderWithDiagnostics(canvas2dRenderer);
    const canvaskit = await renderWithDiagnostics(canvaskitRenderer);
    return { canvas2d, canvaskit };
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
    imageEffectCropProbe.canvas2d.diagnostics.preprocessFailures === 0
      && imageEffectCropProbe.canvaskit.diagnostics.preprocessFailures === 0,
    `image effect preprocessing failures=${JSON.stringify(imageEffectCropProbe)}`,
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
  assert(afterDispose.domImageCacheSize === 0, `dom image cache cleared=${afterDispose.domImageCacheSize}`);
  assert(afterDispose.patternImageCacheSize === 0, `pattern cache cleared=${afterDispose.patternImageCacheSize}`);
  assert(afterDispose.staticPictureCacheSize === 0, `static picture cache cleared=${afterDispose.staticPictureCacheSize}`);
  assert(afterDispose.textBlobCacheSize === 0, `text blob cache cleared=${afterDispose.textBlobCacheSize}`);
  assert(afterDispose.fontAliasCount === 0, `font aliases cleared=${afterDispose.fontAliasCount}`);
  assert(afterDispose.lastRenderedTree === 'null', `last rendered tree released=${afterDispose.lastRenderedTree}`);
  assert(afterDispose.lastTargetCanvas === 'null', `last target canvas released=${afterDispose.lastTargetCanvas}`);
  assert(afterDispose.layerTreeCacheSize === 0, `page layer cache cleared=${afterDispose.layerTreeCacheSize}`);
  assert(afterDispose.currentVisiblePages === 0, `visible pages reset=${afterDispose.currentVisiblePages}`);
}, { skipLoadApp: true });
