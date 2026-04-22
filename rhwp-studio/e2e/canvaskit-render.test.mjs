import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assert,
  comparePngBuffers,
  cropPngBuffer,
  createNewDocument,
  getLayerOpBBoxes,
  loadApp,
  loadHwpFile,
  runTest,
  screenshot,
  screenshotCanvas,
  setTestCase,
} from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RHWP_ROOT = path.resolve(__dirname, '..', '..');
const SAMPLES_DIR = path.join(RHWP_ROOT, 'samples');
const SAMPLE_SCOPE = process.env.RHWP_RENDER_SAMPLE_SCOPE === 'full' ? 'full' : 'representative';
const SAMPLE_FILTER_PATTERN = process.env.RHWP_RENDER_SAMPLE_FILTER?.trim() ?? '';
const SAMPLE_FILTER = SAMPLE_FILTER_PATTERN ? new RegExp(SAMPLE_FILTER_PATTERN, 'i') : null;
const FULL_SWEEP_SKIP_FILES = new Set(['loading-fail-01.hwp']);
const REPRESENTATIVE_FULL_PAGE_CASES = [
  { name: 'blank-new-document', setup: (page) => createNewDocument(page) },
  { name: 'lseg-01-basic', setup: (page) => loadHwpFile(page, 'lseg-01-basic.hwp') },
  { name: 'lseg-05-tab', setup: (page) => loadHwpFile(page, 'lseg-05-tab.hwp') },
  { name: '2010-01-06', setup: (page) => loadHwpFile(page, '2010-01-06.hwp') },
  { name: '20250130-hongbo_saved', setup: (page) => loadHwpFile(page, '20250130-hongbo_saved.hwp') },
  { name: 'eq-01', setup: (page) => loadHwpFile(page, 'eq-01.hwp') },
  {
    name: 'hwp-table-test',
    setup: (page) => loadHwpFile(page, 'hwp_table_test.hwp'),
    maxDiffRatio: 0.0002,
  },
  {
    name: 'pic-crop-01',
    setup: (page) => loadHwpFile(page, 'pic-crop-01.hwp'),
    maxDiffRatio: 0.0065,
  },
  { name: 'field-01', setup: (page) => loadHwpFile(page, 'field-01.hwp') },
  { name: 'shape-group-02', setup: (page) => loadHwpFile(page, 'shape-group-02.hwp') },
  {
    name: 'group-drawing-02',
    setup: (page) => loadHwpFile(page, 'group-drawing-02.hwp'),
    maxDiffRatio: 0.0085,
  },
];
const FULL_SWEEP_CASE_OVERRIDES = new Map([
  ['hwp_table_test.hwp', { maxDiffRatio: 0.0002 }],
  ['pic-crop-01.hwp', { maxDiffRatio: 0.0065 }],
  ['group-drawing-02.hwp', { maxDiffRatio: 0.0085 }],
]);
const CANVASKIT_MODE = process.env.RHWP_CANVASKIT_MODE === 'default' ? 'default' : 'compat';
const RENDER_PROFILE = process.env.RHWP_RENDER_PROFILE?.trim() || 'screen';
const TOLERANT_DIFF = {
  ignoreChannelDelta: 8,
  maxDiffRatio: 0.0025,
  inkMaskWhiteDelta: 25,
  inkMaskAlphaThreshold: 8,
  inkMaskNeighborhoodRadius: 1,
  inkMaskMaxDiffRatio: 0.0001,
};
const FEATURE_CASES = [
  {
    name: 'eq-01',
    setup: (page) => loadHwpFile(page, 'eq-01.hwp'),
    opType: 'equation',
    margin: 4,
  },
];
const FULL_PAGE_CASES = SAMPLE_SCOPE === 'full'
  ? collectFullSweepCases()
  : REPRESENTATIVE_FULL_PAGE_CASES.filter((caseInfo) => matchesSampleFilter(caseInfo.name, caseInfo.fileName));
const FILTERED_FEATURE_CASES = FEATURE_CASES.filter((caseInfo) => matchesSampleFilter(caseInfo.name, caseInfo.fileName));

function matchesSampleFilter(name, fileName) {
  if (!SAMPLE_FILTER) {
    return true;
  }
  return SAMPLE_FILTER.test(name) || (fileName ? SAMPLE_FILTER.test(fileName) : false);
}

function collectFullSweepCases() {
  const sampleFiles = fs.readdirSync(SAMPLES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => path.extname(name).toLowerCase() === '.hwp')
    .filter((name) => !FULL_SWEEP_SKIP_FILES.has(name))
    .sort((left, right) => left.localeCompare(right, 'ko'));

  return sampleFiles.map((fileName) => {
    const baseName = path.basename(fileName, path.extname(fileName));
    const overrides = FULL_SWEEP_CASE_OVERRIDES.get(fileName) ?? {};
    return {
      name: baseName,
      fileName,
      setup: (page) => loadHwpFile(page, fileName),
      ...overrides,
    };
  }).filter((caseInfo) => matchesSampleFilter(caseInfo.name, caseInfo.fileName));
}

async function renderScenario(page, backend, caseInfo) {
  const search = backend === 'canvaskit'
    ? `?renderer=${backend}&canvaskitMode=${CANVASKIT_MODE}&renderProfile=${encodeURIComponent(RENDER_PROFILE)}`
    : `?renderer=${backend}&renderProfile=${encodeURIComponent(RENDER_PROFILE)}`;
  await loadApp(page, search);
  await caseInfo.setup(page);

  const activeBackend = await page.evaluate(() => window.__renderBackend ?? window.__canvasView?.getRenderBackend?.());
  assert(activeBackend === backend || (backend === 'canvas2d' && activeBackend === 'canvas'), `${caseInfo.name} backend=${backend}`);

  const layerSummary = await page.evaluate(() => {
    const profile = window.__renderProfile ?? 'screen';
    const tree = window.__wasm?.getPageLayerTree?.(0, profile);
    if (!tree) return null;
    let opCount = 0;
    const walk = (node) => {
      if (!node) return;
      if (node.kind === 'leaf') {
        opCount += node.ops.length;
        return;
      }
      if (node.kind === 'clipRect') {
        walk(node.child);
        return;
      }
      if (node.kind === 'group') {
        for (const child of node.children) walk(child);
      }
    };
    walk(tree.root);
    return {
      kind: tree.root.kind,
      opCount,
      mode: window.__canvaskitRenderMode,
      profile: tree.profile,
    };
  });
  assert(!!layerSummary && layerSummary.opCount > 0, `${caseInfo.name} layer tree exported`);
  assert(layerSummary?.profile === RENDER_PROFILE, `${caseInfo.name} renderProfile=${RENDER_PROFILE}`);
  if (backend === 'canvaskit') {
    assert(layerSummary?.mode === CANVASKIT_MODE, `${caseInfo.name} canvaskitMode=${CANVASKIT_MODE}`);
  }

  const screenshotName = backend === 'canvaskit'
    ? `${caseInfo.name}-${backend}-${CANVASKIT_MODE}`
    : `${caseInfo.name}-${backend}`;
  return screenshotCanvas(page, screenshotName);
}

runTest('CanvasKit 렌더 비교', async ({ page }) => {
  console.log(`[scope=${SAMPLE_SCOPE}] full-page cases=${FULL_PAGE_CASES.length}, feature cases=${FILTERED_FEATURE_CASES.length}, mode=${CANVASKIT_MODE}, profile=${RENDER_PROFILE}, filter=${SAMPLE_FILTER_PATTERN || 'none'}`);

  setTestCase('canvas2d-layer-path');
  await loadApp(page, `?renderer=canvas2d&renderProfile=${encodeURIComponent(RENDER_PROFILE)}`);
  const pathProbeInstall = await page.evaluate(() => {
    const wasm = window.__wasm;
    if (!wasm?.getPageLayerTree) {
      return { error: 'layer tree bridge unavailable' };
    }
    const probe = { legacyCalls: 0, layerCalls: 0 };
    const originalLayer = wasm.getPageLayerTree.bind(wasm);
    const originalLegacy = wasm.renderPageToCanvas?.bind(wasm);
    wasm.getPageLayerTree = (...args) => {
      probe.layerCalls += 1;
      return originalLayer(...args);
    };
    wasm.renderPageToCanvas = (..._args) => {
      probe.legacyCalls += 1;
      if (originalLegacy) {
        throw new Error('legacy canvas render path should stay unused');
      }
    };
    window.__layerPathProbe = probe;
    return { ok: true };
  });
  assert(!pathProbeInstall.error, pathProbeInstall.error || 'canvas2d layer probe installed');
  await loadHwpFile(page, 'lseg-01-basic.hwp');
  const layerPathProbe = await page.evaluate(() => {
    const probe = window.__layerPathProbe;
    const canvas = document.querySelector('#scroll-container canvas');
    return {
      legacyCalls: probe?.legacyCalls ?? -1,
      layerCalls: probe?.layerCalls ?? -1,
      canvasWidth: canvas?.width ?? 0,
      canvasHeight: canvas?.height ?? 0,
    };
  });
  assert(layerPathProbe.legacyCalls === 0, `canvas2d legacy canvas path calls=${layerPathProbe.legacyCalls}`);
  assert(layerPathProbe.layerCalls > 0, `canvas2d layer tree calls=${layerPathProbe.layerCalls}`);
  assert(
    layerPathProbe.canvasWidth > 0 && layerPathProbe.canvasHeight > 0,
    `canvas2d layered render canvas=${layerPathProbe.canvasWidth}x${layerPathProbe.canvasHeight}`,
  );

  for (const caseInfo of FULL_PAGE_CASES) {
    setTestCase(caseInfo.name);
    try {
      console.log(`\n[${caseInfo.name}] Canvas2D baseline 렌더...`);
      const baseline = await renderScenario(page, 'canvas2d', caseInfo);

      console.log(`[${caseInfo.name}] CanvasKit 렌더...`);
      const canvaskit = await renderScenario(page, 'canvaskit', caseInfo);

      const diff = await comparePngBuffers(baseline.buffer, canvaskit.buffer, {
        diffName: `${caseInfo.name}-${CANVASKIT_MODE}`,
        ignoreChannelDelta: TOLERANT_DIFF.ignoreChannelDelta,
        maxDiffRatio: caseInfo.maxDiffRatio ?? TOLERANT_DIFF.maxDiffRatio,
        inkMaskWhiteDelta: TOLERANT_DIFF.inkMaskWhiteDelta,
        inkMaskAlphaThreshold: TOLERANT_DIFF.inkMaskAlphaThreshold,
        inkMaskNeighborhoodRadius: TOLERANT_DIFF.inkMaskNeighborhoodRadius,
        inkMaskMaxDiffRatio: TOLERANT_DIFF.inkMaskMaxDiffRatio,
      });

      assert(
        diff.passed,
        `${caseInfo.name} screenshot exact=${diff.exactDiffPixels} (${diff.exactDiffRatio.toFixed(4)}), tolerant=${diff.rawTolerantDiffPixels} (${diff.rawTolerantDiffRatio.toFixed(4)}), ink_mask=${diff.rawInkMaskDiffPixels} (${diff.rawInkMaskDiffRatio.toFixed(4)}), pass_metric=${diff.passMetric}, tolerant_budget=${diff.tolerantBudgetPassed}, ink_mask_budget=${diff.inkMaskBudgetPassed}, ignored_channel_delta<=${diff.ignoreChannelDelta}, max_channel_delta=${diff.maxChannelDelta}`,
      );
    } catch (error) {
      await screenshot(page, `${caseInfo.name}-${CANVASKIT_MODE}-error`).catch(() => {});
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      assert(false, `${caseInfo.name} error: ${message}`);
    }
  }

  for (const caseInfo of FILTERED_FEATURE_CASES) {
    setTestCase(`${caseInfo.name}-feature`);
    try {
      console.log(`\n[${caseInfo.name}] Canvas2D baseline 기능 렌더...`);
      const baseline = await renderScenario(page, 'canvas2d', caseInfo);

      console.log(`[${caseInfo.name}] CanvasKit 기능 렌더...`);
      const canvaskit = await renderScenario(page, 'canvaskit', caseInfo);

      const boxes = await getLayerOpBBoxes(page, caseInfo.opType);
      assert(boxes.length > 0, `${caseInfo.name} ${caseInfo.opType} bbox exported`);

      for (const [index, box] of boxes.entries()) {
        const bbox = {
          x: box.x - caseInfo.margin,
          y: box.y - caseInfo.margin,
          width: box.width + caseInfo.margin * 2,
          height: box.height + caseInfo.margin * 2,
        };
        const diff = await comparePngBuffers(
          cropPngBuffer(baseline.buffer, bbox),
          cropPngBuffer(canvaskit.buffer, bbox),
          {
            diffName: `${caseInfo.name}-${caseInfo.opType}-${index}-${CANVASKIT_MODE}`,
            ignoreChannelDelta: TOLERANT_DIFF.ignoreChannelDelta,
            maxDiffRatio: TOLERANT_DIFF.maxDiffRatio,
            inkMaskWhiteDelta: TOLERANT_DIFF.inkMaskWhiteDelta,
            inkMaskAlphaThreshold: TOLERANT_DIFF.inkMaskAlphaThreshold,
            inkMaskNeighborhoodRadius: TOLERANT_DIFF.inkMaskNeighborhoodRadius,
            inkMaskMaxDiffRatio: TOLERANT_DIFF.inkMaskMaxDiffRatio,
          },
        );
        assert(
          diff.passed,
          `${caseInfo.name} ${caseInfo.opType}[${index}] exact=${diff.exactDiffPixels} (${diff.exactDiffRatio.toFixed(4)}), tolerant=${diff.rawTolerantDiffPixels} (${diff.rawTolerantDiffRatio.toFixed(4)}), ink_mask=${diff.rawInkMaskDiffPixels} (${diff.rawInkMaskDiffRatio.toFixed(4)}), pass_metric=${diff.passMetric}, tolerant_budget=${diff.tolerantBudgetPassed}, ink_mask_budget=${diff.inkMaskBudgetPassed}, ignored_channel_delta<=${diff.ignoreChannelDelta}, max_channel_delta=${diff.maxChannelDelta}`,
        );
      }
    } catch (error) {
      await screenshot(page, `${caseInfo.name}-feature-${CANVASKIT_MODE}-error`).catch(() => {});
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      assert(
        false,
        `${caseInfo.name} feature error: ${message}`,
      );
    }
  }

  setTestCase('canvaskit-font-preload');
  await loadApp(page, `?renderer=canvaskit&canvaskitMode=${CANVASKIT_MODE}`);
  const preloadedFonts = await page.evaluate(async () => {
    const { loadWebFonts } = await import('/src/core/font-loader.ts');
    await loadWebFonts(
      ['한컴 윤고딕 230', '함초롬돋움', '함초롬바탕'],
      undefined,
      { includeOverlayFallbacks: true },
    );
    const loadedFamilies = Array.from(document.fonts)
      .filter((face) => face.status === 'loaded')
      .map((face) => face.family.replaceAll('"', ''));
    return {
      symbolFonts: {
        gulimText: loadedFamilies.includes('굴림체'),
        gulimChe: loadedFamilies.includes('GulimChe'),
        d2Coding: loadedFamilies.includes('D2Coding'),
      },
      currencyFonts: {
        malgun: loadedFamilies.includes('Malgun Gothic'),
        malgunKr: loadedFamilies.includes('맑은 고딕'),
      },
    };
}, { skipLoadApp: true });
  assert(
    preloadedFonts.symbolFonts.gulimText,
    `canvaskit symbol fallback font preload=${JSON.stringify(preloadedFonts.symbolFonts)}`,
  );
  assert(
    preloadedFonts.symbolFonts.gulimChe,
    `canvaskit symbol fallback font preload=${JSON.stringify(preloadedFonts.symbolFonts)}`,
  );
  assert(
    preloadedFonts.symbolFonts.d2Coding,
    `canvaskit symbol fallback font preload=${JSON.stringify(preloadedFonts.symbolFonts)}`,
  );
  assert(
    preloadedFonts.currencyFonts.malgun,
    `canvaskit currency fallback font preload=${JSON.stringify(preloadedFonts.currencyFonts)}`,
  );
  assert(
    preloadedFonts.currencyFonts.malgunKr,
    `canvaskit currency fallback font preload=${JSON.stringify(preloadedFonts.currencyFonts)}`,
  );

  setTestCase('canvaskit-overlay-effect-fallback');
  await loadApp(page, `?renderer=canvaskit&canvaskitMode=${CANVASKIT_MODE}`);
  const overlayTrace = await page.evaluate(() => {
    const renderer = window.__canvasView?.pageRenderer?.canvaskitRenderer;
    if (!renderer || typeof renderer.renderTextRunOverlay !== 'function') {
      return { error: 'canvaskit renderer access failed' };
    }

    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 160;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return { error: '2d context unavailable' };
    }

    const calls = [];
    const originalFillText = ctx.fillText.bind(ctx);
    const originalStrokeText = ctx.strokeText.bind(ctx);
    let scenario = 'shadow';

    ctx.fillText = function fillText(text, x, y, maxWidth) {
      calls.push({ scenario, kind: 'fill', text: String(text), font: this.font });
      if (maxWidth === undefined) {
        return originalFillText(text, x, y);
      }
      return originalFillText(text, x, y, maxWidth);
    };

    ctx.strokeText = function strokeText(text, x, y, maxWidth) {
      calls.push({ scenario, kind: 'stroke', text: String(text), font: this.font });
      if (maxWidth === undefined) {
        return originalStrokeText(text, x, y);
      }
      return originalStrokeText(text, x, y, maxWidth);
    };

    const baseStyle = {
      fontFamily: '함초롬돋움',
      fontSize: 24,
      bold: false,
      italic: false,
      color: '#111111',
      ratio: 1,
      underline: 'none',
      strikethrough: false,
      shadowColor: '#666666',
      shadowOffsetX: 1,
      shadowOffsetY: 1,
    };

    renderer.renderTextRunOverlay(ctx, {
      type: 'textRun',
      text: '□₩',
      positions: [0, 24, 48],
      bbox: { x: 8, y: 8, width: 64, height: 32 },
      baseline: 24,
      rotation: 0,
      style: { ...baseStyle, shadowType: 1, outlineType: 0 },
    });

    scenario = 'outline';
    renderer.renderTextRunOverlay(ctx, {
      type: 'textRun',
      text: '□₩',
      positions: [0, 24, 48],
      bbox: { x: 8, y: 56, width: 64, height: 32 },
      baseline: 24,
      rotation: 0,
      style: { ...baseStyle, shadowType: 0, outlineType: 1 },
    });

    return { calls };
  });

  assert(!overlayTrace.error, overlayTrace.error || 'canvaskit overlay trace captured');

  const shadowSymbolCalls = overlayTrace.calls.filter((call) => call.scenario === 'shadow' && call.text === '□');
  const shadowCurrencyCalls = overlayTrace.calls.filter((call) => call.scenario === 'shadow' && call.text === '₩');
  const outlineSymbolCalls = overlayTrace.calls.filter((call) => call.scenario === 'outline' && call.text === '□');
  const outlineCurrencyCalls = overlayTrace.calls.filter((call) => call.scenario === 'outline' && call.text === '₩');

  assert(shadowSymbolCalls.length >= 2, `shadow symbol calls=${shadowSymbolCalls.length}`);
  assert(shadowCurrencyCalls.length >= 2, `shadow currency calls=${shadowCurrencyCalls.length}`);
  assert(outlineSymbolCalls.some((call) => call.kind === 'stroke'), 'outline symbol stroke recorded');
  assert(outlineCurrencyCalls.some((call) => call.kind === 'stroke'), 'outline currency stroke recorded');
  assert(
    shadowSymbolCalls.every((call) => /굴림체|GulimChe|D2Coding/.test(call.font)),
    `shadow symbol fonts=${shadowSymbolCalls.map((call) => call.font).join(' | ')}`,
  );
  assert(
    shadowCurrencyCalls.every((call) => /Malgun Gothic|맑은 고딕/.test(call.font)),
    `shadow currency fonts=${shadowCurrencyCalls.map((call) => call.font).join(' | ')}`,
  );
  assert(
    outlineSymbolCalls.every((call) => /굴림체|GulimChe|D2Coding/.test(call.font)),
    `outline symbol fonts=${outlineSymbolCalls.map((call) => call.font).join(' | ')}`,
  );
  assert(
    outlineCurrencyCalls.every((call) => /Malgun Gothic|맑은 고딕/.test(call.font)),
    `outline currency fonts=${outlineCurrencyCalls.map((call) => call.font).join(' | ')}`,
  );

  setTestCase('canvaskit-layer-tree-value-and-footnote-routing');
  await loadApp(page, `?renderer=canvaskit&canvaskitMode=${CANVASKIT_MODE}&renderProfile=${encodeURIComponent(RENDER_PROFILE)}`);
  await createNewDocument(page);
  const nativeRouting = await page.evaluate(() => {
    const renderer = window.__canvasView?.pageRenderer?.canvaskitRenderer;
    const wasmDoc = window.__wasm?.doc;
    if (!renderer) {
      return { error: 'canvaskit renderer access failed' };
    }

    const simpleTextRun = {
      type: 'textRun',
      text: '단순 텍스트',
      positions: [0, 20, 40, 60, 80, 100],
      bbox: { x: 8, y: 8, width: 120, height: 24 },
      baseline: 18,
      rotation: 0,
      isVertical: false,
      style: {
        fontFamily: '함초롬돋움',
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
        shadowColor: '#111111',
        shadowOffsetX: 0,
        shadowOffsetY: 0,
        emboss: false,
        engrave: false,
        emphasisDot: 0,
        underlineColor: '#111111',
        strikeColor: '#111111',
        shadeColor: '#ffffff',
      },
    };

    return {
      hasLayerTreeValueApi: typeof wasmDoc?.getPageLayerTreeValue === 'function',
      hasLayerTreeValueWithProfileApi: typeof wasmDoc?.getPageLayerTreeValueWithProfile === 'function',
      selectedRenderProfile: window.__renderProfile,
      selectedProfileOnTree: window.__wasm?.getPageLayerTree?.(0, window.__renderProfile ?? 'screen')?.profile,
      highQualityProfileOnTree: window.__wasm?.getPageLayerTree?.(0, 'high-quality')?.profile,
      fastPreviewHasPreferRasterHint: JSON.stringify(window.__wasm?.getPageLayerTree?.(0, 'fast-preview') ?? {}).includes('"cacheHint":"preferRaster"'),
      simpleTextUsesOverlay: renderer.shouldOverlayTextRun(simpleTextRun),
      underlinedTextUsesOverlay: renderer.shouldOverlayTextRun({
        ...simpleTextRun,
        style: {
          ...simpleTextRun.style,
          underline: 'bottom',
        },
      }),
      footnoteUsesOverlay: renderer.shouldOverlayFootnoteMarker({
        type: 'footnoteMarker',
        text: '1)',
        fontFamily: '함초롬돋움',
        fontSize: 10,
        color: '#111111',
        bbox: { x: 4, y: 4, width: 12, height: 12 },
      }),
    };
  });

  assert(!nativeRouting.error, nativeRouting.error || 'canvaskit native routing probe captured');
  assert(nativeRouting.hasLayerTreeValueApi, 'wasm layer tree JS-value export enabled');
  assert(nativeRouting.hasLayerTreeValueWithProfileApi, 'wasm layer tree JS-value export with profile enabled');
  assert(nativeRouting.selectedRenderProfile === RENDER_PROFILE, `selected render profile=${nativeRouting.selectedRenderProfile}`);
  assert(nativeRouting.selectedProfileOnTree === RENDER_PROFILE, `selected tree profile=${nativeRouting.selectedProfileOnTree}`);
  assert(nativeRouting.highQualityProfileOnTree === 'high-quality', `high-quality tree profile=${nativeRouting.highQualityProfileOnTree}`);
  assert(nativeRouting.fastPreviewHasPreferRasterHint === true, `fast-preview preferRaster=${nativeRouting.fastPreviewHasPreferRasterHint}`);
  assert(nativeRouting.simpleTextUsesOverlay === true, `simple text overlay=${nativeRouting.simpleTextUsesOverlay}`);
  assert(nativeRouting.underlinedTextUsesOverlay === true, `underlined text overlay=${nativeRouting.underlinedTextUsesOverlay}`);
  assert(nativeRouting.footnoteUsesOverlay === false, `footnote overlay=${nativeRouting.footnoteUsesOverlay}`);
}, { skipLoadApp: true });
