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
  recordMetric,
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
  {
    name: '20250130-hongbo_saved',
    setup: (page) => loadHwpFile(page, '20250130-hongbo_saved.hwp'),
    nonInkMaxDiffPixels: 128,
  },
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
  {
    name: 'field-01',
    setup: (page) => loadHwpFile(page, 'field-01.hwp'),
    nonInkMaxDiffPixels: 64,
  },
  { name: 'shape-group-02', setup: (page) => loadHwpFile(page, 'shape-group-02.hwp') },
  {
    name: 'group-drawing-02',
    setup: (page) => loadHwpFile(page, 'group-drawing-02.hwp'),
    maxDiffRatio: 0.0085,
    solidInkMaxDiffRatio: 0.0125,
  },
];
const FULL_SWEEP_CASE_OVERRIDES = new Map([
  ['20250130-hongbo_saved.hwp', { nonInkMaxDiffPixels: 128 }],
  ['field-01.hwp', { nonInkMaxDiffPixels: 64 }],
  ['hwp_table_test.hwp', { maxDiffRatio: 0.0002 }],
  ['pic-crop-01.hwp', { maxDiffRatio: 0.0065 }],
  ['group-drawing-02.hwp', { maxDiffRatio: 0.0085 }],
]);
const CANVASKIT_MODE = process.env.RHWP_CANVASKIT_MODE === 'default' ? 'default' : 'compat';
const RENDER_PROFILE = process.env.RHWP_RENDER_PROFILE?.trim() || 'screen';
const PERFORMANCE_ITERATIONS = Math.max(
  1,
  Number.parseInt(process.env.RHWP_E2E_PERF_ITERATIONS ?? '3', 10) || 3,
);
const PERFORMANCE_GUARD = {
  maxReplayRatio: Number.parseFloat(process.env.RHWP_CANVASKIT_MAX_REPLAY_RATIO ?? '25'),
  maxReplayAvgMs: Number.parseFloat(process.env.RHWP_CANVASKIT_MAX_REPLAY_AVG_MS ?? '250'),
  maxAverageReplayRatio: Number.parseFloat(process.env.RHWP_CANVASKIT_MAX_AVG_REPLAY_RATIO ?? '15'),
};
const TOLERANT_DIFF = {
  ignoreChannelDelta: 8,
  maxDiffRatio: 0.0025,
  inkMaskWhiteDelta: 25,
  inkMaskAlphaThreshold: 8,
  inkMaskNeighborhoodRadius: 1,
  inkMaskMaxDiffRatio: 0.0001,
  nonInkMaxDiffPixels: 0,
  solidInkMaxDiffRatio: 0.005,
};
const NATIVE_TEXT_RASTER_DIFF = {
  inkMaskNeighborhoodRadius: 3,
  inkMaskMaxDiffRatio: 0.002,
  nonInkMaxDiffPixels: 0,
  solidInkMaxDiffRatio: 0.005,
};
const FEATURE_CASES = [
  {
    name: 'eq-01',
    setup: (page) => loadHwpFile(page, 'eq-01.hwp'),
    opType: 'equation',
    margin: 4,
    inkMaskNeighborhoodRadius: 3,
    inkMaskMaxDiffRatio: 0.02,
  },
  {
    name: 'pic-crop-01',
    setup: (page) => loadHwpFile(page, 'pic-crop-01.hwp'),
    opType: 'image',
    margin: 4,
    maxDiffRatio: 0.07,
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

function roundMetric(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.round(value * 1000) / 1000;
}

function buildPerformanceComparison(scope, caseInfo, baseline, canvaskit) {
  const canvas2dAvg = baseline.performance.replay.avgMs;
  const canvaskitAvg = canvaskit.performance.replay.avgMs;
  const replayRatio = canvas2dAvg > 0 ? canvaskitAvg / canvas2dAvg : null;
  const captureRatio = baseline.performance.screenshotMs > 0
    ? canvaskit.performance.screenshotMs / baseline.performance.screenshotMs
    : null;
  return {
    scope,
    case: caseInfo.name,
    mode: CANVASKIT_MODE,
    profile: RENDER_PROFILE,
    iterations: PERFORMANCE_ITERATIONS,
    canvas2dReplayAvgMs: roundMetric(canvas2dAvg),
    canvaskitReplayAvgMs: roundMetric(canvaskitAvg),
    replayRatio: roundMetric(replayRatio),
    fasterReplayBackend: replayRatio === null ? 'n/a' : (replayRatio <= 1 ? 'canvaskit' : 'canvas2d'),
    canvas2dReplayMedianMs: roundMetric(baseline.performance.replay.medianMs),
    canvaskitReplayMedianMs: roundMetric(canvaskit.performance.replay.medianMs),
    canvas2dReplayMinMs: roundMetric(baseline.performance.replay.minMs),
    canvaskitReplayMinMs: roundMetric(canvaskit.performance.replay.minMs),
    canvas2dReplayMaxMs: roundMetric(baseline.performance.replay.maxMs),
    canvaskitReplayMaxMs: roundMetric(canvaskit.performance.replay.maxMs),
    canvas2dCaptureMs: roundMetric(baseline.performance.screenshotMs),
    canvaskitCaptureMs: roundMetric(canvaskit.performance.screenshotMs),
    captureRatio: roundMetric(captureRatio),
    canvas2dLoadMs: roundMetric(baseline.performance.loadMs),
    canvaskitLoadMs: roundMetric(canvaskit.performance.loadMs),
    canvas2dSetupMs: roundMetric(baseline.performance.setupMs),
    canvaskitSetupMs: roundMetric(canvaskit.performance.setupMs),
    canvasPixels: baseline.performance.replay.canvasPixels,
    canvas2dOps: baseline.layerSummary?.opCount ?? 0,
    canvaskitOps: canvaskit.layerSummary?.opCount ?? 0,
    canvaskitNativeTextRuns: canvaskit.layerSummary?.nativeTextRunCount ?? 0,
    canvaskitNativeImages: canvaskit.layerSummary?.nativeImageCount ?? 0,
    canvaskitNativeEquations: canvaskit.layerSummary?.nativeEquationCount ?? 0,
    canvaskitNativeFormObjects: canvaskit.layerSummary?.nativeFormObjectCount ?? 0,
  };
}

function assertPerformanceGuard(row) {
  assert(
    row.replayRatio === null || row.replayRatio <= PERFORMANCE_GUARD.maxReplayRatio,
    `${row.case} CanvasKit replay ratio=${row.replayRatio} <= ${PERFORMANCE_GUARD.maxReplayRatio}`,
  );
  assert(
    row.canvaskitReplayAvgMs <= PERFORMANCE_GUARD.maxReplayAvgMs,
    `${row.case} CanvasKit replay avg=${row.canvaskitReplayAvgMs}ms <= ${PERFORMANCE_GUARD.maxReplayAvgMs}ms`,
  );
}

async function renderScenario(page, backend, caseInfo) {
  const scenarioStart = performance.now();
  const search = backend === 'canvaskit'
    ? `?renderer=${backend}&canvaskitMode=${CANVASKIT_MODE}&renderProfile=${encodeURIComponent(RENDER_PROFILE)}`
    : `?renderer=${backend}&renderProfile=${encodeURIComponent(RENDER_PROFILE)}`;
  const loadStart = performance.now();
  await loadApp(page, search);
  const loadMs = performance.now() - loadStart;
  const setupStart = performance.now();
  await caseInfo.setup(page);
  const setupMs = performance.now() - setupStart;

  const activeBackend = await page.evaluate(() => window.__renderBackend ?? window.__canvasView?.getRenderBackend?.());
  assert(activeBackend === backend || (backend === 'canvas2d' && activeBackend === 'canvas'), `${caseInfo.name} backend=${backend}`);

  const layerSummary = await page.evaluate(() => {
    const profile = window.__renderProfile ?? 'screen';
    const tree = window.__wasm?.getPageLayerTree?.(0, profile);
    if (!tree) return null;
    const treeAgain = window.__wasm?.getPageLayerTree?.(0, profile);
    const renderer = window.__canvasView?.pageRenderer?.canvaskitRenderer;
    let opCount = 0;
    let nativeTextRunCount = 0;
    let nativeImageCount = 0;
    let nativeEquationCount = 0;
    let nativeFormObjectCount = 0;
    let resourceRefCount = 0;
    let svgResourceRefCount = 0;
    let maxImageResourceId = -1;
    let maxSvgResourceId = -1;
    let embeddedBase64PayloadCount = 0;
    let embeddedSvgPayloadCount = 0;
    const walk = (node) => {
      if (!node) return;
      if (node.kind === 'leaf') {
        opCount += node.ops.length;
        if (renderer) {
          for (const op of node.ops) {
            if (op.type === 'pageBackground' && op.image) {
              if (typeof op.image.resourceId === 'number') {
                resourceRefCount += 1;
                maxImageResourceId = Math.max(maxImageResourceId, op.image.resourceId);
              }
              if (op.image.base64) embeddedBase64PayloadCount += 1;
            }
            if (op.type === 'textRun' && !renderer.shouldOverlayTextRun(op)) {
              nativeTextRunCount += 1;
            }
            if (op.type === 'image' && !renderer.shouldOverlayImage(op)) {
              nativeImageCount += 1;
            }
            if (op.type === 'image') {
              if (typeof op.resourceId === 'number') {
                resourceRefCount += 1;
                maxImageResourceId = Math.max(maxImageResourceId, op.resourceId);
              }
              if (op.base64) embeddedBase64PayloadCount += 1;
            }
            if (op.type === 'equation' && !renderer.shouldOverlayEquation(op)) {
              nativeEquationCount += 1;
            }
            if (op.type === 'equation') {
              if (typeof op.svgResourceId === 'number') {
                svgResourceRefCount += 1;
                maxSvgResourceId = Math.max(maxSvgResourceId, op.svgResourceId);
              }
              if (op.svgContent) embeddedSvgPayloadCount += 1;
            }
            if (op.type === 'formObject' && !renderer.shouldOverlayFormObject(op)) {
              nativeFormObjectCount += 1;
            }
          }
        }
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
      sharedResourceTable: !!tree.resources && tree.resources === treeAgain?.resources,
      resourceImageCount: tree.resources?.images?.length ?? 0,
      resourceSvgCount: tree.resources?.svgFragments?.length ?? 0,
      resourceRefCount,
      svgResourceRefCount,
      maxImageResourceId,
      maxSvgResourceId,
      embeddedBase64PayloadCount,
      embeddedSvgPayloadCount,
      nativeTextRunCount,
      nativeImageCount,
      nativeEquationCount,
      nativeFormObjectCount,
    };
  });
  assert(!!layerSummary && layerSummary.opCount > 0, `${caseInfo.name} layer tree exported`);
  assert(layerSummary?.profile === RENDER_PROFILE, `${caseInfo.name} renderProfile=${RENDER_PROFILE}`);
  assert(layerSummary?.sharedResourceTable === true, `${caseInfo.name} layer resources use shared document table`);
  assert(layerSummary?.embeddedBase64PayloadCount === 0, `${caseInfo.name} object API embeds no base64 payloads`);
  assert(layerSummary?.embeddedSvgPayloadCount === 0, `${caseInfo.name} object API embeds no svg payloads`);
  assert(
    layerSummary?.maxImageResourceId === -1 || layerSummary.maxImageResourceId < layerSummary.resourceImageCount,
    `${caseInfo.name} max image resource id=${layerSummary?.maxImageResourceId}, resources=${layerSummary?.resourceImageCount}`,
  );
  assert(
    layerSummary?.maxSvgResourceId === -1 || layerSummary.maxSvgResourceId < layerSummary.resourceSvgCount,
    `${caseInfo.name} max svg resource id=${layerSummary?.maxSvgResourceId}, resources=${layerSummary?.resourceSvgCount}`,
  );
  assert(
    layerSummary?.resourceRefCount === 0 || layerSummary.resourceImageCount > 0,
    `${caseInfo.name} image resource refs=${layerSummary?.resourceRefCount}, resources=${layerSummary?.resourceImageCount}`,
  );
  assert(
    layerSummary?.svgResourceRefCount === 0 || layerSummary.resourceSvgCount > 0,
    `${caseInfo.name} svg resource refs=${layerSummary?.svgResourceRefCount}, resources=${layerSummary?.resourceSvgCount}`,
  );
  if (backend === 'canvaskit') {
    assert(layerSummary?.mode === CANVASKIT_MODE, `${caseInfo.name} canvaskitMode=${CANVASKIT_MODE}`);
  }

  const screenshotName = backend === 'canvaskit'
    ? `${caseInfo.name}-${backend}-${CANVASKIT_MODE}`
    : `${caseInfo.name}-${backend}`;
  const screenshotStart = performance.now();
  const shot = await screenshotCanvas(page, screenshotName);
  const screenshotMs = performance.now() - screenshotStart;

  const replay = await page.evaluate(async (iterations) => {
    const canvasView = window.__canvasView;
    const pageRenderer = canvasView?.pageRenderer;
    const wasm = window.__wasm;
    const canvas = document.querySelector('#scroll-container canvas') ?? document.querySelector('canvas');
    if (!pageRenderer || typeof pageRenderer.renderPage !== 'function') {
      return { error: 'page renderer is not exposed' };
    }
    if (!canvas) {
      return { error: 'page canvas is not mounted' };
    }
    let pageInfo = null;
    try {
      pageInfo = wasm?.getPageInfo?.(0) ?? null;
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    if (!pageInfo || !pageInfo.width || !pageInfo.height) {
      return { error: 'page info is unavailable' };
    }

    const renderScale = canvas.width / pageInfo.width;
    const samples = [];
    pageRenderer.cancelAll?.();
    for (let index = 0; index < iterations; index += 1) {
      const startedAt = performance.now();
      pageRenderer.renderPage(0, pageInfo, canvas, renderScale);
      samples.push(performance.now() - startedAt);
      pageRenderer.cancelAll?.();
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    }
    const sorted = [...samples].sort((left, right) => left - right);
    const total = samples.reduce((sum, value) => sum + value, 0);
    return {
      iterations: samples.length,
      samples,
      avgMs: total / samples.length,
      medianMs: sorted[Math.floor(sorted.length / 2)],
      minMs: sorted[0],
      maxMs: sorted[sorted.length - 1],
      renderScale,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      canvasPixels: canvas.width * canvas.height,
    };
  }, PERFORMANCE_ITERATIONS);
  if (replay.error) {
    throw new Error(`${caseInfo.name} performance replay failed: ${replay.error}`);
  }

  return {
    ...shot,
    layerSummary,
    performance: {
      backend,
      loadMs,
      setupMs,
      replay,
      screenshotMs,
      totalMs: performance.now() - scenarioStart,
    },
  };
}

runTest('CanvasKit 렌더 비교', async ({ page }) => {
  console.log(`[scope=${SAMPLE_SCOPE}] full-page cases=${FULL_PAGE_CASES.length}, feature cases=${FILTERED_FEATURE_CASES.length}, mode=${CANVASKIT_MODE}, profile=${RENDER_PROFILE}, filter=${SAMPLE_FILTER_PATTERN || 'none'}`);
  const performanceRows = [];

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
      const nativeTextActive = (canvaskit.layerSummary?.nativeTextRunCount ?? 0) > 0;

      const diff = await comparePngBuffers(baseline.buffer, canvaskit.buffer, {
        diffName: `${caseInfo.name}-${CANVASKIT_MODE}`,
        ignoreChannelDelta: TOLERANT_DIFF.ignoreChannelDelta,
        maxDiffRatio: nativeTextActive ? null : (caseInfo.maxDiffRatio ?? TOLERANT_DIFF.maxDiffRatio),
        inkMaskWhiteDelta: TOLERANT_DIFF.inkMaskWhiteDelta,
        inkMaskAlphaThreshold: TOLERANT_DIFF.inkMaskAlphaThreshold,
        inkMaskNeighborhoodRadius: nativeTextActive ? NATIVE_TEXT_RASTER_DIFF.inkMaskNeighborhoodRadius : TOLERANT_DIFF.inkMaskNeighborhoodRadius,
        inkMaskMaxDiffRatio: nativeTextActive ? NATIVE_TEXT_RASTER_DIFF.inkMaskMaxDiffRatio : null,
        nonInkMaxDiffPixels: nativeTextActive ? (caseInfo.nonInkMaxDiffPixels ?? NATIVE_TEXT_RASTER_DIFF.nonInkMaxDiffPixels) : null,
        solidInkMaxDiffRatio: nativeTextActive
          ? (caseInfo.solidInkMaxDiffRatio ?? NATIVE_TEXT_RASTER_DIFF.solidInkMaxDiffRatio)
          : null,
      });

      assert(
        diff.passed,
        `${caseInfo.name} screenshot exact=${diff.exactDiffPixels} (${diff.exactDiffRatio.toFixed(4)}), tolerant=${diff.rawTolerantDiffPixels} (${diff.rawTolerantDiffRatio.toFixed(4)}), ink_mask=${diff.rawInkMaskDiffPixels} (${diff.rawInkMaskDiffRatio.toFixed(4)}), non_ink=${diff.rawNonInkDiffPixels} (${diff.rawNonInkDiffRatio.toFixed(4)}), solid_ink=${diff.rawSolidInkDiffPixels} (${diff.rawSolidInkDiffRatio.toFixed(4)}), pass_metric=${diff.passMetric}, tolerant_budget=${diff.tolerantBudgetPassed}, ink_mask_budget=${diff.inkMaskBudgetPassed}, non_ink_budget=${diff.nonInkBudgetPassed}, solid_ink_budget=${diff.solidInkBudgetPassed}, raster_only_budget=${diff.rasterOnlyBudgetPassed}, ignored_channel_delta<=${diff.ignoreChannelDelta}, max_channel_delta=${diff.maxChannelDelta}`,
      );
      const performanceComparison = buildPerformanceComparison('full-page', caseInfo, baseline, canvaskit);
      performanceRows.push(performanceComparison);
      recordMetric(`${caseInfo.name} renderer performance`, performanceComparison);
      assertPerformanceGuard(performanceComparison);
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
      const nativeTextActive = (canvaskit.layerSummary?.nativeTextRunCount ?? 0) > 0;
      const performanceComparison = buildPerformanceComparison('feature', caseInfo, baseline, canvaskit);
      performanceRows.push(performanceComparison);
      recordMetric(`${caseInfo.name} feature renderer performance`, performanceComparison);
      assertPerformanceGuard(performanceComparison);

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
            maxDiffRatio: nativeTextActive ? null : (caseInfo.maxDiffRatio ?? TOLERANT_DIFF.maxDiffRatio),
            inkMaskWhiteDelta: TOLERANT_DIFF.inkMaskWhiteDelta,
            inkMaskAlphaThreshold: TOLERANT_DIFF.inkMaskAlphaThreshold,
            inkMaskNeighborhoodRadius: nativeTextActive ? (caseInfo.inkMaskNeighborhoodRadius ?? NATIVE_TEXT_RASTER_DIFF.inkMaskNeighborhoodRadius) : TOLERANT_DIFF.inkMaskNeighborhoodRadius,
            inkMaskMaxDiffRatio: nativeTextActive ? (caseInfo.inkMaskMaxDiffRatio ?? NATIVE_TEXT_RASTER_DIFF.inkMaskMaxDiffRatio) : null,
            nonInkMaxDiffPixels: nativeTextActive ? (caseInfo.nonInkMaxDiffPixels ?? NATIVE_TEXT_RASTER_DIFF.nonInkMaxDiffPixels) : null,
            solidInkMaxDiffRatio: nativeTextActive
              ? (caseInfo.solidInkMaxDiffRatio ?? NATIVE_TEXT_RASTER_DIFF.solidInkMaxDiffRatio)
              : null,
          },
        );
        assert(
          diff.passed,
          `${caseInfo.name} ${caseInfo.opType}[${index}] exact=${diff.exactDiffPixels} (${diff.exactDiffRatio.toFixed(4)}), tolerant=${diff.rawTolerantDiffPixels} (${diff.rawTolerantDiffRatio.toFixed(4)}), ink_mask=${diff.rawInkMaskDiffPixels} (${diff.rawInkMaskDiffRatio.toFixed(4)}), non_ink=${diff.rawNonInkDiffPixels} (${diff.rawNonInkDiffRatio.toFixed(4)}), solid_ink=${diff.rawSolidInkDiffPixels} (${diff.rawSolidInkDiffRatio.toFixed(4)}), pass_metric=${diff.passMetric}, tolerant_budget=${diff.tolerantBudgetPassed}, ink_mask_budget=${diff.inkMaskBudgetPassed}, non_ink_budget=${diff.nonInkBudgetPassed}, solid_ink_budget=${diff.solidInkBudgetPassed}, raster_only_budget=${diff.rasterOnlyBudgetPassed}, ignored_channel_delta<=${diff.ignoreChannelDelta}, max_channel_delta=${diff.maxChannelDelta}`,
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

  setTestCase('renderer-performance-summary');
  for (const scope of ['full-page', 'feature', 'all']) {
    const rows = scope === 'all'
      ? performanceRows
      : performanceRows.filter((row) => row.scope === scope);
    if (rows.length === 0) {
      continue;
    }
    const canvas2dReplayAvgMs = rows.reduce((sum, row) => sum + row.canvas2dReplayAvgMs, 0) / rows.length;
    const canvaskitReplayAvgMs = rows.reduce((sum, row) => sum + row.canvaskitReplayAvgMs, 0) / rows.length;
    const replayRatio = canvas2dReplayAvgMs > 0 ? canvaskitReplayAvgMs / canvas2dReplayAvgMs : null;
    const canvas2dCaptureMs = rows.reduce((sum, row) => sum + row.canvas2dCaptureMs, 0) / rows.length;
    const canvaskitCaptureMs = rows.reduce((sum, row) => sum + row.canvaskitCaptureMs, 0) / rows.length;
    const captureRatio = canvas2dCaptureMs > 0 ? canvaskitCaptureMs / canvas2dCaptureMs : null;
    const summary = {
      scope,
      samples: rows.length,
      mode: CANVASKIT_MODE,
      profile: RENDER_PROFILE,
      iterations: PERFORMANCE_ITERATIONS,
      canvas2dReplayAvgMs: roundMetric(canvas2dReplayAvgMs),
      canvaskitReplayAvgMs: roundMetric(canvaskitReplayAvgMs),
      replayRatio: roundMetric(replayRatio),
      fasterReplayBackend: replayRatio === null ? 'n/a' : (replayRatio <= 1 ? 'canvaskit' : 'canvas2d'),
      canvas2dCaptureMs: roundMetric(canvas2dCaptureMs),
      canvaskitCaptureMs: roundMetric(canvaskitCaptureMs),
      captureRatio: roundMetric(captureRatio),
    };
    recordMetric(`${scope} renderer performance average`, summary);
    assert(
      summary.replayRatio === null || summary.replayRatio <= PERFORMANCE_GUARD.maxAverageReplayRatio,
      `${scope} average CanvasKit replay ratio=${summary.replayRatio} <= ${PERFORMANCE_GUARD.maxAverageReplayRatio}`,
    );
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
  const nativeRouting = await page.evaluate(async () => {
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
        fontFamily: '바탕체',
        fontSize: 13.333333,
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

    const equationOp = {
      type: 'equation',
      bbox: { x: 0, y: 0, width: 40, height: 16 },
      color: '#111111',
      fontSize: 14,
      svgContent: '<text x="0" y="12">x</text>',
      layoutBox: {
        x: 0,
        y: 0,
        width: 10,
        height: 12,
        baseline: 9,
        kind: { type: 'text', text: 'x' },
      },
    };

    let equationSvgNativeProbe = null;
    if (window.__canvaskitRenderMode === 'default') {
      const probeCanvas = document.createElement('canvas');
      probeCanvas.width = 96;
      probeCanvas.height = 48;
      const probeTree = {
        pageWidth: 96,
        pageHeight: 48,
        profile: 'screen',
        root: {
          kind: 'leaf',
          bounds: { x: 0, y: 0, width: 96, height: 48 },
          cacheHint: 'none',
          ops: [equationOp],
        },
      };
      let layoutFallbackCalls = 0;
      const originalRenderEquationBox = renderer.renderEquationBox;
      renderer.renderEquationBox = function renderEquationBoxProbe(...args) {
        layoutFallbackCalls += 1;
        return originalRenderEquationBox.apply(this, args);
      };
      try {
        renderer.renderPage(probeTree, probeCanvas, 1);
        const deadline = Date.now() + 1000;
        while (
          Date.now() < deadline
          && (renderer.equationSvgImageCache?.size ?? 0) === 0
          && !Array.from(renderer.equationSvgDomImageCache?.values?.() ?? []).some((image) => image.complete && image.naturalWidth > 0)
        ) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }

        layoutFallbackCalls = 0;
        renderer.renderPage(probeTree, probeCanvas, 1);
        equationSvgNativeProbe = {
          cachedDomSvgImages: renderer.equationSvgDomImageCache?.size ?? 0,
          cachedCanvasKitSvgImages: renderer.equationSvgImageCache?.size ?? 0,
          layoutFallbackCalls,
        };
      } finally {
        renderer.renderEquationBox = originalRenderEquationBox;
      }
    }

    return {
      hasLayerTreeValueApi: typeof wasmDoc?.getPageLayerTreeValue === 'function',
      hasLayerTreeValueWithProfileApi: typeof wasmDoc?.getPageLayerTreeValueWithProfile === 'function',
      valueApiIgnoresPatchedJsonParse: (() => {
        if (typeof wasmDoc?.getPageLayerTreeValue !== 'function') {
          return false;
        }
        const originalJsonParse = JSON.parse;
        JSON.parse = () => {
          throw new Error('patched JSON.parse should stay unused by layer tree value API');
        };
        try {
          const tree = typeof wasmDoc.getPageLayerTreeValueWithProfile === 'function'
            ? wasmDoc.getPageLayerTreeValueWithProfile(0, 'screen')
            : wasmDoc.getPageLayerTreeValue(0);
          return tree?.profile === 'screen' && tree?.root?.kind === 'group';
        } catch (error) {
          return `error:${error?.message ?? error}`;
        } finally {
          JSON.parse = originalJsonParse;
        }
      })(),
      selectedRenderProfile: window.__renderProfile,
      selectedProfileOnTree: window.__wasm?.getPageLayerTree?.(0, window.__renderProfile ?? 'screen')?.profile,
      highQualityProfileOnTree: window.__wasm?.getPageLayerTree?.(0, 'high-quality')?.profile,
      fastPreviewHasPreferRasterHint: JSON.stringify(window.__wasm?.getPageLayerTree?.(0, 'fast-preview') ?? {}).includes('"cacheHint":"preferRaster"'),
      batangcheFamily: renderer.resolveCanvasKitFontFamily?.('바탕체'),
      simpleTextUsesOverlay: renderer.shouldOverlayTextRun(simpleTextRun),
      nonDefaultSimpleTextUsesOverlay: renderer.shouldOverlayTextRun({
        ...simpleTextRun,
        style: {
          ...simpleTextRun.style,
          fontFamily: '함초롬돋움',
          fontSize: 18,
        },
      }),
      shadowTextUsesOverlay: renderer.shouldOverlayTextRun({
        ...simpleTextRun,
        style: {
          ...simpleTextRun.style,
          shadowType: 1,
          shadowColor: '#333333',
          shadowOffsetX: 1,
          shadowOffsetY: 1,
        },
      }),
      ratioTextUsesOverlay: renderer.shouldOverlayTextRun({
        ...simpleTextRun,
        style: {
          ...simpleTextRun.style,
          ratio: 0.9,
        },
      }),
      rotatedTextUsesOverlay: renderer.shouldOverlayTextRun({
        ...simpleTextRun,
        rotation: 15,
      }),
      verticalTextUsesOverlay: renderer.shouldOverlayTextRun({
        ...simpleTextRun,
        isVertical: true,
      }),
      simpleLineUsesOverlay: renderer.shouldOverlayLine({
        type: 'line',
        bbox: { x: 0, y: 0, width: 64, height: 1 },
        x1: 0,
        y1: 0,
        x2: 64,
        y2: 0,
        transform: { rotation: 0, horzFlip: false, vertFlip: false },
        style: {
          color: '#111111',
          width: 1,
          dash: 'solid',
          lineType: 'single',
          startArrow: 'none',
          endArrow: 'none',
          startArrowSize: 0,
          endArrowSize: 0,
        },
      }),
      underlinedTextUsesOverlay: renderer.shouldOverlayTextRun({
        ...simpleTextRun,
        style: {
          ...simpleTextRun.style,
          underline: 'bottom',
        },
      }),
      tableCellFillUsesOverlay: (() => {
        renderer.currentClipStack.push({
          bounds: { x: 0, y: 0, width: 64, height: 32 },
          kind: 'tableCell',
        });
        try {
          return renderer.shouldOverlayRectangle({
            type: 'rectangle',
            bbox: { x: 0, y: 0, width: 64, height: 32 },
            cornerRadius: 0,
            gradient: null,
            transform: { rotation: 0, horzFlip: false, vertFlip: false },
            style: {
              fillColor: '#ccffcc',
              strokeColor: null,
              strokeWidth: 0,
              strokeDash: 'solid',
              opacity: 1,
              pattern: null,
              shadow: null,
            },
          });
        } finally {
          renderer.currentClipStack.pop();
        }
      })(),
      vectorHintTableCellFillUsesOverlay: (() => {
        renderer.currentClipStack.push({
          bounds: { x: 0, y: 0, width: 64, height: 32 },
          kind: 'tableCell',
        });
        renderer.currentCacheHintStack.push('preferVectorRecording');
        try {
          return renderer.shouldOverlayRectangle({
            type: 'rectangle',
            bbox: { x: 0, y: 0, width: 64, height: 32 },
            cornerRadius: 0,
            gradient: null,
            transform: { rotation: 0, horzFlip: false, vertFlip: false },
            style: {
              fillColor: '#ccffcc',
              strokeColor: null,
              strokeWidth: 0,
              strokeDash: 'solid',
              opacity: 1,
              pattern: null,
              shadow: null,
            },
          });
        } finally {
          renderer.currentCacheHintStack.pop();
          renderer.currentClipStack.pop();
        }
      })(),
      tableCellBoldTextUsesOverlay: (() => {
        renderer.currentClipStack.push({
          bounds: { x: 0, y: 0, width: 64, height: 32 },
          kind: 'tableCell',
        });
        try {
          return renderer.shouldOverlayTextRun({
            ...simpleTextRun,
            style: {
              ...simpleTextRun.style,
              bold: true,
            },
          });
        } finally {
          renderer.currentClipStack.pop();
        }
      })(),
      preferRasterImageUsesOverlay: (() => {
        renderer.currentCacheHintStack.push('preferRaster');
        try {
          return renderer.shouldOverlayImage({
            type: 'image',
            bbox: { x: 0, y: 0, width: 32, height: 32 },
            base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5W7s8AAAAASUVORK5CYII=',
            fillMode: 'fitToSize',
            transform: { rotation: 0, horzFlip: false, vertFlip: false },
          });
        } finally {
          renderer.currentCacheHintStack.pop();
        }
      })(),
      imageUsesOverlay: renderer.shouldOverlayImage({
        type: 'image',
        bbox: { x: 0, y: 0, width: 32, height: 32 },
        base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5W7s8AAAAASUVORK5CYII=',
        fillMode: 'fitToSize',
        transform: { rotation: 0, horzFlip: false, vertFlip: false },
      }),
      resourceImageUsesOverlay: renderer.shouldOverlayImage({
        type: 'image',
        bbox: { x: 0, y: 0, width: 32, height: 32 },
        resourceId: 0,
        fillMode: 'fitToSize',
        transform: { rotation: 0, horzFlip: false, vertFlip: false },
      }),
      formUsesOverlay: renderer.shouldOverlayFormObject({
        type: 'formObject',
        bbox: { x: 0, y: 0, width: 48, height: 16 },
        formType: 'checkBox',
        caption: '동의',
        text: '',
        foreColor: '#111111',
        backColor: '#ffffff',
        value: 1,
        enabled: true,
      }),
      equationUsesOverlay: renderer.shouldOverlayEquation({
        ...equationOp,
      }),
      equationSvgNativeProbe,
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
  assert(nativeRouting.valueApiIgnoresPatchedJsonParse === true, `value API without JSON.parse=${nativeRouting.valueApiIgnoresPatchedJsonParse}`);
  assert(nativeRouting.selectedRenderProfile === RENDER_PROFILE, `selected render profile=${nativeRouting.selectedRenderProfile}`);
  assert(nativeRouting.selectedProfileOnTree === RENDER_PROFILE, `selected tree profile=${nativeRouting.selectedProfileOnTree}`);
  assert(nativeRouting.highQualityProfileOnTree === 'high-quality', `high-quality tree profile=${nativeRouting.highQualityProfileOnTree}`);
  assert(nativeRouting.fastPreviewHasPreferRasterHint === true, `fast-preview preferRaster=${nativeRouting.fastPreviewHasPreferRasterHint}`);
  assert(
    nativeRouting.batangcheFamily === '바탕체' || nativeRouting.batangcheFamily === 'Noto Serif KR',
    `바탕체 family=${nativeRouting.batangcheFamily}`,
  );
  assert(nativeRouting.simpleTextUsesOverlay === false, `simple text overlay=${nativeRouting.simpleTextUsesOverlay}`);
  assert(nativeRouting.nonDefaultSimpleTextUsesOverlay === false, `non-default simple text overlay=${nativeRouting.nonDefaultSimpleTextUsesOverlay}`);
  assert(nativeRouting.shadowTextUsesOverlay === (CANVASKIT_MODE === 'compat'), `shadow text overlay=${nativeRouting.shadowTextUsesOverlay}`);
  assert(nativeRouting.ratioTextUsesOverlay === (CANVASKIT_MODE === 'compat'), `ratio text overlay=${nativeRouting.ratioTextUsesOverlay}`);
  assert(nativeRouting.rotatedTextUsesOverlay === (CANVASKIT_MODE === 'compat'), `rotated text overlay=${nativeRouting.rotatedTextUsesOverlay}`);
  assert(nativeRouting.verticalTextUsesOverlay === true, `vertical text overlay=${nativeRouting.verticalTextUsesOverlay}`);
  assert(nativeRouting.simpleLineUsesOverlay === false, `simple line overlay=${nativeRouting.simpleLineUsesOverlay}`);
  assert(nativeRouting.underlinedTextUsesOverlay === (CANVASKIT_MODE === 'compat'), `underlined text overlay=${nativeRouting.underlinedTextUsesOverlay}`);
  assert(nativeRouting.tableCellFillUsesOverlay === (CANVASKIT_MODE === 'compat'), `table-cell fill overlay=${nativeRouting.tableCellFillUsesOverlay}`);
  assert(nativeRouting.vectorHintTableCellFillUsesOverlay === false, `vector-hint table-cell fill overlay=${nativeRouting.vectorHintTableCellFillUsesOverlay}`);
  assert(nativeRouting.tableCellBoldTextUsesOverlay === true, `table-cell bold text overlay=${nativeRouting.tableCellBoldTextUsesOverlay}`);
  assert(nativeRouting.preferRasterImageUsesOverlay === false, `prefer-raster image overlay=${nativeRouting.preferRasterImageUsesOverlay}`);
  assert(nativeRouting.imageUsesOverlay === (CANVASKIT_MODE === 'compat'), `image overlay=${nativeRouting.imageUsesOverlay}`);
  assert(nativeRouting.resourceImageUsesOverlay === (CANVASKIT_MODE === 'compat'), `resource image overlay=${nativeRouting.resourceImageUsesOverlay}`);
  assert(nativeRouting.formUsesOverlay === (CANVASKIT_MODE === 'compat'), `form overlay=${nativeRouting.formUsesOverlay}`);
  assert(nativeRouting.equationUsesOverlay === (CANVASKIT_MODE === 'compat'), `equation overlay=${nativeRouting.equationUsesOverlay}`);
  if (CANVASKIT_MODE === 'default') {
    assert(
      nativeRouting.equationSvgNativeProbe?.cachedDomSvgImages > 0,
      `equation svg DOM cache=${JSON.stringify(nativeRouting.equationSvgNativeProbe)}`,
    );
    assert(
      nativeRouting.equationSvgNativeProbe?.cachedCanvasKitSvgImages > 0,
      `equation svg CanvasKit cache=${JSON.stringify(nativeRouting.equationSvgNativeProbe)}`,
    );
    assert(
      nativeRouting.equationSvgNativeProbe?.layoutFallbackCalls === 0,
      `equation svg native fallback calls=${JSON.stringify(nativeRouting.equationSvgNativeProbe)}`,
    );
  }
  assert(nativeRouting.footnoteUsesOverlay === false, `footnote overlay=${nativeRouting.footnoteUsesOverlay}`);
}, { skipLoadApp: true });
