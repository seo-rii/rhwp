import {
  assert,
  loadApp,
  loadHwpFile,
  runTest,
  setTestCase,
} from './helpers.mjs';

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
        resources: { images: [], svgFragments: [] },
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
      resources: { images: [], svgFragments: [] },
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
  assert(afterDispose.fontAliasCount === 0, `font aliases cleared=${afterDispose.fontAliasCount}`);
  assert(afterDispose.lastRenderedTree === 'null', `last rendered tree released=${afterDispose.lastRenderedTree}`);
  assert(afterDispose.lastTargetCanvas === 'null', `last target canvas released=${afterDispose.lastTargetCanvas}`);
  assert(afterDispose.layerTreeCacheSize === 0, `page layer cache cleared=${afterDispose.layerTreeCacheSize}`);
  assert(afterDispose.currentVisiblePages === 0, `visible pages reset=${afterDispose.currentVisiblePages}`);
}, { skipLoadApp: true });
