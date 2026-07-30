import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assert,
  closeBrowser,
  comparePngBuffers,
  cropPngBuffer,
  createPage,
  createNewDocument,
  getLayerOpBBoxes,
  launchBrowser,
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
  {
    name: '2010-01-06',
    setup: (page) => loadHwpFile(page, '2010-01-06.hwp'),
    solidInkMaxDiffRatio: 0.0065,
  },
  {
    name: '20250130-hongbo_saved',
    setup: (page) => loadHwpFile(page, '20250130-hongbo_saved.hwp'),
    nonInkMaxDiffPixels: 128,
    maxCanvaskitReplayAvgMs: 350,
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
    maxCanvaskitReplayAvgMs: 500,
    maxCanvaskitReplayRatio: 80,
  },
  { name: 'shape-group-02', setup: (page) => loadHwpFile(page, 'shape-group-02.hwp') },
  {
    name: 'group-drawing-02',
    setup: (page) => loadHwpFile(page, 'group-drawing-02.hwp'),
    maxDiffRatio: 0.0085,
    solidInkMaxDiffRatio: 0.0125,
  },
  {
    name: 'table-004',
    setup: (page) => loadHwpFile(page, 'table-004.hwp'),
    nonInkMaxDiffPixels: 512,
    solidInkMaxDiffRatio: 0.0065,
  },
];
// Keep these scoped to samples where ink-mask/non-ink checks show matching
// geometry and the remaining delta is renderer-specific rasterization.
const FULL_SWEEP_CASE_OVERRIDES = new Map([
  ['2010-01-06.hwp', { solidInkMaxDiffRatio: 0.0065 }],
  ['aift.hwp', { solidInkMaxDiffRatio: 0.032 }],
  ['endnote-01.hwp', { solidInkMaxDiffRatio: 0.0095 }],
  ['exam_eng.hwp', { maxCanvaskitReplayAvgMs: 750, maxCanvaskitReplayRatio: 80 }],
  ['exam_kor.hwp', { maxCanvaskitReplayAvgMs: 1250, maxCanvaskitReplayRatio: 80 }],
  ['footnote-01.hwp', { solidInkMaxDiffRatio: 0.0095 }],
  ['group-drawing-02.hwp', { maxDiffRatio: 0.0085, solidInkMaxDiffRatio: 0.0125 }],
  [
    'hwpspec.hwp',
    {
      nonInkMaxDiffPixels: 2048,
      solidInkMaxDiffRatio: 0.12,
      maxCanvaskitReplayAvgMs: 350,
      maxCanvaskitReplayRatio: 80,
    },
  ],
  ['inner-table-01.hwp', { solidInkMaxDiffRatio: 0.0065 }],
  ['pic-in-head-01.hwp', { solidInkMaxDiffRatio: 0.045 }],
  ['pic-in-table-01.hwp', { solidInkMaxDiffRatio: 0.045 }],
  ['table-004.hwp', { nonInkMaxDiffPixels: 512, solidInkMaxDiffRatio: 0.0065 }],
  ['20250130-hongbo_saved.hwp', { nonInkMaxDiffPixels: 128, maxCanvaskitReplayAvgMs: 350 }],
  ['field-01.hwp', { nonInkMaxDiffPixels: 64, maxCanvaskitReplayAvgMs: 500, maxCanvaskitReplayRatio: 80 }],
  ['hwp_table_test.hwp', { maxDiffRatio: 0.0002 }],
  ['pic-crop-01.hwp', { maxDiffRatio: 0.0065 }],
  ['복학원서.hwp', { solidInkMaxDiffRatio: 0.02 }],
  ['통합재정통계(2010.11월).hwp', { solidInkMaxDiffRatio: 0.0065 }],
  ['통합재정통계(2011.10월).hwp', { solidInkMaxDiffRatio: 0.0065 }],
  ['통합재정통계(2014.8월).hwp', { solidInkMaxDiffRatio: 0.0065 }],
]);

function isDetachedFrameError(error) {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  return /detached Frame/i.test(message);
}

function isBrowserConnectionClosedError(error) {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  return /ConnectionClosedError|Connection closed|Target closed|browser has disconnected|Protocol error/i.test(message);
}

const CANVASKIT_MODE = process.env.RHWP_CANVASKIT_MODE === 'compat' ? 'compat' : 'default';
const REQUESTED_CANVASKIT_SURFACE = (process.env.RHWP_CANVASKIT_SURFACE ?? '').trim().toLowerCase();
let CANVASKIT_SURFACE = 'auto';
if (REQUESTED_CANVASKIT_SURFACE === 'sw' || REQUESTED_CANVASKIT_SURFACE === 'cpu') {
  CANVASKIT_SURFACE = 'software';
} else if (REQUESTED_CANVASKIT_SURFACE === 'gpu') {
  CANVASKIT_SURFACE = 'webgpu';
} else if (['auto', 'webgpu', 'webgl', 'software'].includes(REQUESTED_CANVASKIT_SURFACE)) {
  CANVASKIT_SURFACE = REQUESTED_CANVASKIT_SURFACE;
}
const RENDER_PROFILE = process.env.RHWP_RENDER_PROFILE?.trim() || 'screen';
const PERFORMANCE_ITERATIONS = Math.max(
  1,
  Number.parseInt(process.env.RHWP_E2E_PERF_ITERATIONS ?? '3', 10) || 3,
);
const PERFORMANCE_GUARD = {
  maxReplayRatio: Number.parseFloat(process.env.RHWP_CANVASKIT_MAX_REPLAY_RATIO ?? '25'),
  maxReplayAvgMs: Number.parseFloat(process.env.RHWP_CANVASKIT_MAX_REPLAY_AVG_MS ?? '250'),
  maxAverageReplayRatio: Number.parseFloat(process.env.RHWP_CANVASKIT_MAX_AVG_REPLAY_RATIO ?? '15'),
  minReplayRatioBaselineMs: Number.parseFloat(process.env.RHWP_CANVASKIT_MIN_REPLAY_RATIO_BASELINE_MS ?? '5'),
  minAverageReplaySamples: Math.max(
    1,
    Number.parseInt(process.env.RHWP_CANVASKIT_MIN_AVG_REPLAY_SAMPLES ?? '2', 10) || 2,
  ),
};
const STRICT_PERFORMANCE_GUARD_ENABLED = PERFORMANCE_ITERATIONS >= 2;
const FULL_SWEEP_BROWSER_RECYCLE_INTERVAL_RAW = Number.parseInt(
  process.env.RHWP_CANVASKIT_SWEEP_BROWSER_RECYCLE_INTERVAL ?? '30',
  10,
);
const FULL_SWEEP_BROWSER_RECYCLE_INTERVAL = Number.isFinite(FULL_SWEEP_BROWSER_RECYCLE_INTERVAL_RAW)
  ? Math.max(0, FULL_SWEEP_BROWSER_RECYCLE_INTERVAL_RAW)
  : 30;
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
  const replayRatioGuard = !STRICT_PERFORMANCE_GUARD_ENABLED
    ? 'skipped-single-iteration'
    : replayRatio === null
      ? 'disabled'
      : canvas2dAvg < PERFORMANCE_GUARD.minReplayRatioBaselineMs
        ? 'skipped-small-baseline'
        : 'checked';
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
    maxCanvaskitReplayAvgMs: caseInfo.maxCanvaskitReplayAvgMs ?? null,
    maxCanvaskitReplayRatio: caseInfo.maxCanvaskitReplayRatio ?? null,
    replayRatio: roundMetric(replayRatio),
    replayRatioGuard,
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
    canvas2dLayerTreeTransport: baseline.layerSummary?.layerTreeExportStats?.transport ?? 'n/a',
    canvaskitLayerTreeTransport: canvaskit.layerSummary?.layerTreeExportStats?.transport ?? 'n/a',
    canvas2dLayerTreeExportMs: roundMetric(baseline.layerSummary?.layerTreeExportStats?.wasmExportMs ?? null),
    canvaskitLayerTreeExportMs: roundMetric(canvaskit.layerSummary?.layerTreeExportStats?.wasmExportMs ?? null),
    canvas2dLayerTreeNormalizeMs: roundMetric(baseline.layerSummary?.layerTreeExportStats?.resourceNormalizeMs ?? null),
    canvaskitLayerTreeNormalizeMs: roundMetric(canvaskit.layerSummary?.layerTreeExportStats?.resourceNormalizeMs ?? null),
    canvas2dLayerTreeMaterializeMs: roundMetric(baseline.layerSummary?.layerTreeExportStats?.totalMs ?? null),
    canvaskitLayerTreeMaterializeMs: roundMetric(canvaskit.layerSummary?.layerTreeExportStats?.totalMs ?? null),
    canvas2dLayerResourceBytesImported: (baseline.layerSummary?.layerResourceStats?.imagePayloadBytesImported ?? 0)
      + (baseline.layerSummary?.layerResourceStats?.svgPayloadBytesImported ?? 0),
    canvaskitLayerResourceBytesImported: (canvaskit.layerSummary?.layerResourceStats?.imagePayloadBytesImported ?? 0)
      + (canvaskit.layerSummary?.layerResourceStats?.svgPayloadBytesImported ?? 0),
    canvaskitRepeatedImagePayloadImports: canvaskit.layerSummary?.secondTreeImagePayloadsImported ?? null,
    canvaskitRepeatedSvgPayloadImports: canvaskit.layerSummary?.secondTreeSvgPayloadsImported ?? null,
    canvaskitRepeatedImagePayloadOmissions: canvaskit.layerSummary?.secondTreeImagePayloadsOmitted ?? null,
    canvaskitRepeatedSvgPayloadOmissions: canvaskit.layerSummary?.secondTreeSvgPayloadsOmitted ?? null,
    canvaskitNativeTextRuns: canvaskit.layerSummary?.nativeTextRunCount ?? 0,
    canvaskitNativeImages: canvaskit.layerSummary?.nativeImageCount ?? 0,
    canvaskitNativeEquations: canvaskit.layerSummary?.nativeEquationCount ?? 0,
    canvaskitNativeFormObjects: canvaskit.layerSummary?.nativeFormObjectCount ?? 0,
    canvaskitSurfaceRequested: canvaskit.layerSummary?.surfaceDiagnostics?.requested ?? null,
    canvaskitSurfacePreference: canvaskit.layerSummary?.surfaceDiagnostics?.preference ?? 'n/a',
    canvaskitSurfaceUnsupportedValue: canvaskit.layerSummary?.surfaceDiagnostics?.unsupportedValue ?? null,
    canvaskitSurfaceUnsupportedReason: canvaskit.layerSummary?.surfaceDiagnostics?.unsupportedReason ?? null,
    canvaskitSurfaceBackend: canvaskit.layerSummary?.surfaceDiagnostics?.backend ?? 'n/a',
    canvaskitSurfaceWebgpuAttempts: canvaskit.layerSummary?.surfaceDiagnostics?.webgpuAttempts ?? null,
    canvaskitSurfaceWebgpuFailures: canvaskit.layerSummary?.surfaceDiagnostics?.webgpuFailures ?? null,
    canvaskitSurfaceWebglAttempts: canvaskit.layerSummary?.surfaceDiagnostics?.webglAttempts ?? null,
    canvaskitSurfaceWebglFailures: canvaskit.layerSummary?.surfaceDiagnostics?.webglFailures ?? null,
    canvaskitSurfaceSoftwareAttempts: canvaskit.layerSummary?.surfaceDiagnostics?.softwareAttempts ?? null,
    canvaskitSurfaceSoftwareFailures: canvaskit.layerSummary?.surfaceDiagnostics?.softwareFailures ?? null,
    canvaskitSurfaceSoftwareFallbacks: canvaskit.layerSummary?.surfaceDiagnostics?.softwareFallbacks ?? null,
    canvaskitSurfaceWebgpuLastFailure: canvaskit.layerSummary?.surfaceDiagnostics?.webgpuLastFailure ?? null,
    canvaskitSurfaceWebglLastFailure: canvaskit.layerSummary?.surfaceDiagnostics?.webglLastFailure ?? null,
    canvaskitSurfaceSoftwareLastFailure: canvaskit.layerSummary?.surfaceDiagnostics?.softwareLastFailure ?? null,
    canvaskitSurfaceLastFailure: canvaskit.layerSummary?.surfaceDiagnostics?.lastFailure ?? null,
  };
}

function performanceGuardMessage(label, value, maxValue, guard, details) {
  if (guard !== 'checked') {
    return `${label} guard skipped (${guard}, value=${value}, budget=${maxValue}, ${details})`;
  }
  return `${label}=${value} <= ${maxValue} (${details})`;
}

function assertPerformanceGuard(row) {
  const maxReplayRatio = row.maxCanvaskitReplayRatio ?? PERFORMANCE_GUARD.maxReplayRatio;
  const maxReplayAvgMs = row.maxCanvaskitReplayAvgMs ?? PERFORMANCE_GUARD.maxReplayAvgMs;
  assert(
    row.replayRatio === null
      || row.replayRatioGuard === 'skipped-single-iteration'
      || row.replayRatioGuard === 'skipped-small-baseline'
      || row.replayRatio <= maxReplayRatio,
    performanceGuardMessage(
      `${row.case} CanvasKit replay ratio`,
      row.replayRatio,
      maxReplayRatio,
      row.replayRatioGuard,
      `canvas2dBaseline=${row.canvas2dReplayAvgMs}ms, minBaseline=${PERFORMANCE_GUARD.minReplayRatioBaselineMs}ms`,
    ),
  );
  assert(
    row.replayRatioGuard === 'skipped-single-iteration' || row.canvaskitReplayAvgMs <= maxReplayAvgMs,
    performanceGuardMessage(
      `${row.case} CanvasKit replay avg`,
      `${row.canvaskitReplayAvgMs}ms`,
      `${maxReplayAvgMs}ms`,
      row.replayRatioGuard,
      'absolute replay guard',
    ),
  );
}

async function renderScenario(page, backend, caseInfo) {
  const scenarioStart = performance.now();
  const search = backend === 'canvaskit'
    ? `?renderer=${backend}&canvaskitMode=${CANVASKIT_MODE}&canvaskitSurface=${CANVASKIT_SURFACE}&renderProfile=${encodeURIComponent(RENDER_PROFILE)}`
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
    const statsBefore = window.__wasm?.getLayerResourceStats?.() ?? null;
    const tree = window.__wasm?.getPageLayerTree?.(0, profile);
    if (!tree) return null;
    if (typeof tree !== 'object' || !tree.root) {
      return {
        error: 'layer tree root is unavailable',
        treeType: typeof tree,
        treeKeys: typeof tree === 'object' ? Object.keys(tree) : [],
      };
    }
    const root = tree.root;
    const statsAfterFirst = window.__wasm?.getLayerResourceStats?.() ?? null;
    const treeAgain = window.__wasm?.getPageLayerTree?.(0, profile);
    const statsAfterSecond = window.__wasm?.getLayerResourceStats?.() ?? null;
    const layerTreeExportStats = window.__wasm?.getLayerTreeExportStatsSnapshot?.() ?? null;
    const renderer = window.__canvasView?.pageRenderer?.canvaskitRenderer;
    const surfaceDiagnostics = renderer?.getSurfaceDiagnostics?.() ?? null;
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
            if (op.type === 'textRun') {
              nativeTextRunCount += 1;
            }
            if (op.type === 'image') {
              nativeImageCount += 1;
            }
            if (op.type === 'image') {
              if (typeof op.resourceId === 'number') {
                resourceRefCount += 1;
                maxImageResourceId = Math.max(maxImageResourceId, op.resourceId);
              }
              if (op.base64) embeddedBase64PayloadCount += 1;
            }
            if (op.type === 'equation') {
              nativeEquationCount += 1;
            }
            if (op.type === 'equation') {
              if (typeof op.svgResourceId === 'number') {
                svgResourceRefCount += 1;
                maxSvgResourceId = Math.max(maxSvgResourceId, op.svgResourceId);
              }
              if (op.svgContent) embeddedSvgPayloadCount += 1;
            }
            if (op.type === 'formObject') {
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
    walk(root);
    return {
      kind: root.kind,
      opCount,
      mode: window.__canvaskitRenderMode,
      profile: tree.profile,
      sharedResourceTable: !!tree.resources && tree.resources === treeAgain?.resources,
      resourceImageCount: tree.resources?.images?.length ?? 0,
      resourceImageHashCount: tree.resources?.imageHashes?.length ?? 0,
      resourceImageKeyCount: tree.resources?.imageKeys?.length ?? 0,
      resourceSvgCount: tree.resources?.svgFragments?.length ?? 0,
      resourceSvgHashCount: tree.resources?.svgHashes?.length ?? 0,
      resourceSvgKeyCount: tree.resources?.svgKeys?.length ?? 0,
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
      surfaceDiagnostics,
      layerTreeExportStats,
      layerResourceStats: statsAfterSecond,
      firstTreeImagePayloadsImported: statsBefore && statsAfterFirst
        ? statsAfterFirst.imagePayloadsImported - statsBefore.imagePayloadsImported
        : null,
      firstTreeSvgPayloadsImported: statsBefore && statsAfterFirst
        ? statsAfterFirst.svgPayloadsImported - statsBefore.svgPayloadsImported
        : null,
      secondTreeImagePayloadsImported: statsAfterFirst && statsAfterSecond
        ? statsAfterSecond.imagePayloadsImported - statsAfterFirst.imagePayloadsImported
        : null,
      secondTreeSvgPayloadsImported: statsAfterFirst && statsAfterSecond
        ? statsAfterSecond.svgPayloadsImported - statsAfterFirst.svgPayloadsImported
        : null,
      secondTreeImagePayloadsOmitted: statsAfterFirst && statsAfterSecond
        ? statsAfterSecond.imagePayloadsOmitted - statsAfterFirst.imagePayloadsOmitted
        : null,
      secondTreeSvgPayloadsOmitted: statsAfterFirst && statsAfterSecond
        ? statsAfterSecond.svgPayloadsOmitted - statsAfterFirst.svgPayloadsOmitted
        : null,
    };
  });
  const layerTreeExported = !!layerSummary && !layerSummary.error && layerSummary.opCount > 0;
  assert(
    layerTreeExported,
    layerTreeExported
      ? `${caseInfo.name} layer tree exported`
      : `${caseInfo.name} layer tree export failed: ${JSON.stringify(layerSummary)}`,
  );
  assert(layerSummary?.profile === RENDER_PROFILE, `${caseInfo.name} renderProfile=${RENDER_PROFILE}`);
  assert(layerSummary?.sharedResourceTable === true, `${caseInfo.name} layer resources use shared document table`);
  assert(layerSummary?.embeddedBase64PayloadCount === 0, `${caseInfo.name} object API embeds no base64 payloads`);
  assert(layerSummary?.embeddedSvgPayloadCount === 0, `${caseInfo.name} object API embeds no svg payloads`);
  assert(
    layerSummary?.layerTreeExportStats?.transport !== 'json',
    `${caseInfo.name} layer tree transport=${layerSummary?.layerTreeExportStats?.transport}`,
  );
  assert(
    layerSummary?.resourceImageCount === 0 || layerSummary.resourceImageHashCount >= layerSummary.resourceImageCount,
    `${caseInfo.name} image hash count=${layerSummary?.resourceImageHashCount}, images=${layerSummary?.resourceImageCount}`,
  );
  assert(
    layerSummary?.resourceImageCount === 0 || layerSummary.resourceImageKeyCount >= layerSummary.resourceImageCount,
    `${caseInfo.name} image key count=${layerSummary?.resourceImageKeyCount}, images=${layerSummary?.resourceImageCount}`,
  );
  assert(
    layerSummary?.resourceSvgCount === 0 || layerSummary.resourceSvgHashCount >= layerSummary.resourceSvgCount,
    `${caseInfo.name} svg hash count=${layerSummary?.resourceSvgHashCount}, svgs=${layerSummary?.resourceSvgCount}`,
  );
  assert(
    layerSummary?.resourceSvgCount === 0 || layerSummary.resourceSvgKeyCount >= layerSummary.resourceSvgCount,
    `${caseInfo.name} svg key count=${layerSummary?.resourceSvgKeyCount}, svgs=${layerSummary?.resourceSvgCount}`,
  );
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
  assert(
    layerSummary?.secondTreeImagePayloadsImported === null || layerSummary.secondTreeImagePayloadsImported === 0,
    `${caseInfo.name} repeated layer export image payload imports=${layerSummary?.secondTreeImagePayloadsImported}, omitted=${layerSummary?.secondTreeImagePayloadsOmitted}`,
  );
  assert(
    layerSummary?.secondTreeSvgPayloadsImported === null || layerSummary.secondTreeSvgPayloadsImported === 0,
    `${caseInfo.name} repeated layer export svg payload imports=${layerSummary?.secondTreeSvgPayloadsImported}, omitted=${layerSummary?.secondTreeSvgPayloadsOmitted}`,
  );
  if (backend === 'canvaskit') {
    const surfaceDiagnostics = layerSummary?.surfaceDiagnostics;
    const expectedSurfaceBackends = CANVASKIT_SURFACE === 'webgpu'
      ? ['webgpu', 'webgl', 'software']
      : ['webgl', 'software'];
    assert(layerSummary?.mode === CANVASKIT_MODE, `${caseInfo.name} canvaskitMode=${CANVASKIT_MODE}`);
    assert(
      surfaceDiagnostics?.preference === CANVASKIT_SURFACE,
      `${caseInfo.name} CanvasKit surface preference=${JSON.stringify(surfaceDiagnostics)}`,
    );
    if (CANVASKIT_SURFACE === 'auto') {
      assert(
        surfaceDiagnostics?.requested === 'auto'
          && surfaceDiagnostics?.unsupportedValue === null
          && surfaceDiagnostics?.unsupportedReason === null,
        `${caseInfo.name} CanvasKit auto surface diagnostics=${JSON.stringify(surfaceDiagnostics)}`,
      );
    }
    assert(
      expectedSurfaceBackends.includes(surfaceDiagnostics?.backend),
      `${caseInfo.name} CanvasKit surface backend=${JSON.stringify(surfaceDiagnostics)}`,
    );
    if (CANVASKIT_SURFACE === 'software') {
      assert(
        surfaceDiagnostics?.backend === 'software'
          && surfaceDiagnostics?.webglAttempts === 0,
        `${caseInfo.name} CanvasKit forced software surface=${JSON.stringify(surfaceDiagnostics)}`,
      );
    }
    if (CANVASKIT_SURFACE === 'webgpu') {
      assert(
        (surfaceDiagnostics?.webgpuAttempts ?? 0) >= 1,
        `${caseInfo.name} CanvasKit WebGPU surface attempted=${JSON.stringify(surfaceDiagnostics)}`,
      );
      assert(
        surfaceDiagnostics?.backend === 'webgpu'
          || (
            (surfaceDiagnostics?.webgpuFailures ?? 0) >= 1
            && typeof surfaceDiagnostics?.webgpuLastFailure === 'string'
          ),
        `${caseInfo.name} CanvasKit WebGPU fallback records failure=${JSON.stringify(surfaceDiagnostics)}`,
      );
    }
  }

  const screenshotName = backend === 'canvaskit'
    ? `${caseInfo.name}-${backend}-${CANVASKIT_MODE}-${CANVASKIT_SURFACE}`
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

runTest('CanvasKit 렌더 비교', async ({ page: initialPage, browser }) => {
  let activeBrowser = browser;
  let page = initialPage;
  const ownedBrowsers = new Set();
  let fullSweepCasesSinceBrowserStart = 0;

  async function recreatePage(label, reason, { restartBrowser = false } = {}) {
    console.log(`  [${label}] ${reason}; ${restartBrowser ? 'restarting browser' : 'recreating page'}`);
    await page?.close().catch(() => {});
    if (restartBrowser) {
      const browserToClose = activeBrowser;
      await closeBrowser(browserToClose).catch(() => {});
      ownedBrowsers.delete(browserToClose);
      activeBrowser = await launchBrowser();
      ownedBrowsers.add(activeBrowser);
      fullSweepCasesSinceBrowserStart = 0;
    }
    page = await createPage(activeBrowser);
  }

  async function withPageRetry(label, fn) {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        const browserClosed = isBrowserConnectionClosedError(error);
        const frameDetached = isDetachedFrameError(error);
        if (attempt === 2 || (!browserClosed && !frameDetached)) {
          throw error;
        }
        try {
          await recreatePage(label, browserClosed ? 'browser connection closed' : 'detached frame', {
            restartBrowser: browserClosed,
          });
        } catch (recreateError) {
          if (attempt >= 1 || !isBrowserConnectionClosedError(recreateError)) {
            throw recreateError;
          }
          await recreatePage(label, 'browser connection closed while recreating page', {
            restartBrowser: true,
          });
        }
      }
    }
    throw lastError ?? new Error(`${label} retry exhausted`);
  }

  async function maybeRecycleFullSweepBrowser(label) {
    if (SAMPLE_SCOPE !== 'full' || FULL_SWEEP_BROWSER_RECYCLE_INTERVAL <= 0) {
      return;
    }
    fullSweepCasesSinceBrowserStart += 1;
    if (fullSweepCasesSinceBrowserStart >= FULL_SWEEP_BROWSER_RECYCLE_INTERVAL) {
      await recreatePage(label, `full sweep reached ${fullSweepCasesSinceBrowserStart} cases`, {
        restartBrowser: true,
      });
    }
  }

  try {
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
    const wrappedLayerTree = (...args) => {
      probe.layerCalls += 1;
      return originalLayer(...args);
    };
    wasm.getPageLayerTree = wrappedLayerTree;
    wasm.renderPageToCanvas = (..._args) => {
      probe.legacyCalls += 1;
      if (originalLegacy) {
        throw new Error('legacy canvas render path should stay unused');
      }
    };
    window.__canvasView?.pageRenderer?.clearLayerTreeCache?.();
    window.__layerPathProbe = probe;
    return { ok: true, wrapperInstalled: wasm.getPageLayerTree === wrappedLayerTree };
  });
  assert(!pathProbeInstall.error, pathProbeInstall.error || 'canvas2d layer probe installed');
  assert(pathProbeInstall.wrapperInstalled === true, 'canvas2d layer tree probe wrapper installed');
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
      await withPageRetry(caseInfo.name, async () => {
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
      });
      await maybeRecycleFullSweepBrowser(caseInfo.name);
    } catch (error) {
      await screenshot(page, `${caseInfo.name}-${CANVASKIT_MODE}-error`).catch(() => {});
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      assert(false, `${caseInfo.name} error: ${message}`);
    }
  }

  for (const caseInfo of FILTERED_FEATURE_CASES) {
    setTestCase(`${caseInfo.name}-feature`);
    try {
      await withPageRetry(`${caseInfo.name}-feature`, async () => {
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
      });
      await maybeRecycleFullSweepBrowser(`${caseInfo.name}-feature`);
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
    const replayRatioGuard = !STRICT_PERFORMANCE_GUARD_ENABLED
      ? 'skipped-single-iteration'
      : replayRatio === null
        ? 'disabled'
        : SAMPLE_FILTER
          ? 'skipped-filtered-sample-set'
          : rows.length < PERFORMANCE_GUARD.minAverageReplaySamples
            ? 'skipped-small-sample'
            : canvas2dReplayAvgMs < PERFORMANCE_GUARD.minReplayRatioBaselineMs
              ? 'skipped-small-baseline'
              : 'checked';
    const summary = {
      scope,
      samples: rows.length,
      mode: CANVASKIT_MODE,
      profile: RENDER_PROFILE,
      iterations: PERFORMANCE_ITERATIONS,
      canvas2dReplayAvgMs: roundMetric(canvas2dReplayAvgMs),
      canvaskitReplayAvgMs: roundMetric(canvaskitReplayAvgMs),
      replayRatio: roundMetric(replayRatio),
      replayRatioGuard,
      fasterReplayBackend: replayRatio === null ? 'n/a' : (replayRatio <= 1 ? 'canvaskit' : 'canvas2d'),
      canvas2dCaptureMs: roundMetric(canvas2dCaptureMs),
      canvaskitCaptureMs: roundMetric(canvaskitCaptureMs),
      captureRatio: roundMetric(captureRatio),
    };
    recordMetric(`${scope} renderer performance average`, summary);
    assert(
      summary.replayRatio === null
        || summary.replayRatioGuard !== 'checked'
        || summary.replayRatio <= PERFORMANCE_GUARD.maxAverageReplayRatio,
      performanceGuardMessage(
        `${scope} average CanvasKit replay ratio`,
        summary.replayRatio,
        PERFORMANCE_GUARD.maxAverageReplayRatio,
        summary.replayRatioGuard,
        `samples=${summary.samples}, minSamples=${PERFORMANCE_GUARD.minAverageReplaySamples}`,
      ),
    );
  }

  setTestCase('canvaskit-font-preload');
  await loadApp(page, `?renderer=canvaskit&canvaskitMode=${CANVASKIT_MODE}&canvaskitSurface=${CANVASKIT_SURFACE}`);
  const preloadedFonts = await page.evaluate(async () => {
    const { loadWebFonts } = await import('/src/core/font-loader.ts');
    await loadWebFonts(
      ['한컴 윤고딕 230', '함초롬돋움', '함초롬바탕'],
      undefined,
      { includeDirectRendererFallbacks: true },
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
      oldHangul: loadedFamilies.includes('Source Han Serif K Old Hangul'),
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
  assert(
    preloadedFonts.oldHangul,
    `canvaskit old-Hangul fallback font preload=${JSON.stringify(preloadedFonts)}`,
  );

  setTestCase('canvaskit-layer-tree-value-and-footnote-routing');
  await loadApp(page, `?renderer=canvaskit&canvaskitMode=${CANVASKIT_MODE}&canvaskitSurface=${CANVASKIT_SURFACE}&renderProfile=${encodeURIComponent(RENDER_PROFILE)}`);
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
      svgResourceId: 0,
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
      resources: {
        tableId: 900,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: ['<text x="0" y="12">x</text>'],
        svgHashes: ['probe-hash'],
        svgKeys: ['probe-key'],
      },
    };
    let layoutDirectCalls = 0;
    const originalRenderEquationBox = renderer.renderEquationBox;
    renderer.renderEquationBox = function renderEquationBoxProbe(...args) {
      layoutDirectCalls += 1;
      return originalRenderEquationBox.apply(this, args);
    };
    let validLayoutDirectCalls = 0;
    let malformedLayoutDirectCalls = 0;
    try {
      renderer.renderPage(probeTree, probeCanvas, 1);
      validLayoutDirectCalls = layoutDirectCalls;
      probeTree.resources = {
        ...probeTree.resources,
        tableId: 903,
        svgFragments: ['<path d="M0 0L20 0L20 20Z" fill="#000"/><path d="not-a-path"/>'],
        svgHashes: ['malformed-equation-probe'],
        svgKeys: ['malformed-equation-probe'],
      };
      renderer.renderPage(probeTree, probeCanvas, 1);
      malformedLayoutDirectCalls = layoutDirectCalls - validLayoutDirectCalls;
    } finally {
      renderer.renderEquationBox = originalRenderEquationBox;
    }
    const equationSvgNativeProbe = {
      hasEquationSvgDomImageCache: Object.prototype.hasOwnProperty.call(renderer, 'equationSvgDomImageCache'),
      hasEquationSvgImageCache: Object.prototype.hasOwnProperty.call(renderer, 'equationSvgImageCache'),
      validLayoutDirectCalls,
      malformedLayoutDirectCalls,
    };

    const corruptBitmapGroup = 'canvaskit-corrupt-bitmap-glyph';
    const corruptBitmapTextRun = {
      ...simpleTextRun,
      id: `op-text-${corruptBitmapGroup}`,
      text: 'A',
      positions: [0, 20],
      bbox: { x: 8, y: 8, width: 24, height: 24 },
      baseline: 20,
      style: { ...simpleTextRun.style, color: '#dd0000' },
      source: { id: 902, utf8Range: { start: 0, end: 1 }, utf16Range: { start: 0, end: 1 } },
      variant: {
        equivalenceGroup: corruptBitmapGroup,
        variantId: 'textRun',
        variantKind: 'textRun',
        partIndex: 0,
        partCount: 1,
        isDefaultFallback: true,
        quality: 'exact',
      },
    };
    const corruptBitmapOutline = {
      id: `op-outline-${corruptBitmapGroup}`,
      type: 'glyphOutline',
      payloadKind: 'bitmapGlyph',
      bbox: { x: 8, y: 8, width: 20, height: 20 },
      source: corruptBitmapTextRun.source,
      variant: {
        equivalenceGroup: corruptBitmapGroup,
        variantId: 'glyphOutline',
        variantKind: 'glyphOutline',
        partIndex: 0,
        partCount: 1,
        isDefaultFallback: false,
        quality: 'exact',
        requires: ['text.outlineGlyph', 'text.glyphOutline.bitmapGlyph'],
        anchorOpId: corruptBitmapTextRun.id,
        localPaintOrder: 0,
      },
      paintStyle: { ...simpleTextRun.style, color: '#000000' },
      placement: {
        runToPage: { a: 1, b: 0, c: 0, d: 1, e: 8, f: 8 },
        baselineY: 0,
      },
      paths: [],
      bitmapGlyph: {
        imageResourceId: 'corrupt-bitmap-glyph-image',
        sourceRangeUtf8: { start: 0, end: 1 },
        glyphRange: { start: 0, end: 1 },
        placement: {
          runToPage: { a: 1, b: 0, c: 0, d: 1, e: 8, f: 8 },
          baselineY: 0,
        },
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
    const corruptBitmapCanvas = document.createElement('canvas');
    corruptBitmapCanvas.width = 48;
    corruptBitmapCanvas.height = 40;
    renderer.renderPage({
      pageWidth: 48,
      pageHeight: 40,
      profile: 'screen',
      root: {
        kind: 'leaf',
        bounds: { x: 0, y: 0, width: 48, height: 40 },
        cacheHint: 'none',
        ops: [corruptBitmapTextRun, corruptBitmapOutline],
      },
      resources: {
        tableId: 902,
        images: [new Uint8Array([0x52, 0x48, 0x57, 0x50])],
        imageHashes: ['corrupt-bitmap-glyph-image'],
        imageKeys: ['corrupt-bitmap-glyph-image'],
        svgFragments: [],
        svgHashes: [],
        svgKeys: [],
      },
    }, corruptBitmapCanvas, 1);
    const corruptBitmapReport = renderer.getTextVariantSelectionDiagnostics().find(
      (report) => report.equivalenceGroup === corruptBitmapGroup,
    );
    const corruptBitmapNativeProbe = {
      selectedVariantId: corruptBitmapReport?.selectedVariantId,
      selectedVariantKind: corruptBitmapReport?.selectedVariantKind,
      rejectedReasons: corruptBitmapReport?.rejectedVariants.flatMap((variant) => variant.reasons) ?? [],
      rejectedDetails: corruptBitmapReport?.rejectedVariants.flatMap((variant) => variant.details ?? []) ?? [],
    };

    const corruptSvgGroup = 'canvaskit-corrupt-svg-glyph';
    const corruptSvgTextRun = {
      ...corruptBitmapTextRun,
      id: `op-text-${corruptSvgGroup}`,
      variant: {
        ...corruptBitmapTextRun.variant,
        equivalenceGroup: corruptSvgGroup,
      },
    };
    const corruptSvgOutline = {
      ...corruptBitmapOutline,
      id: `op-outline-${corruptSvgGroup}`,
      payloadKind: 'svgGlyph',
      source: corruptSvgTextRun.source,
      variant: {
        ...corruptBitmapOutline.variant,
        equivalenceGroup: corruptSvgGroup,
        requires: ['text.outlineGlyph', 'text.glyphOutline.svgGlyph'],
        anchorOpId: corruptSvgTextRun.id,
      },
      bitmapGlyph: undefined,
      svgGlyph: {
        vectorResourceId: 'corrupt-svg-glyph-resource',
        sourceRangeUtf8: { start: 0, end: 1 },
        glyphRange: { start: 0, end: 1 },
        placement: {
          runToPage: { a: 1, b: 0, c: 0, d: 1, e: 8, f: 8 },
          baselineY: 0,
        },
        viewBox: { x: 0, y: 0, width: 20, height: 20 },
        securityMode: 'staticSanitized',
        scriptAllowed: false,
        animationAllowed: false,
        externalResourcesAllowed: false,
        interactivityAllowed: false,
      },
    };
    const corruptSvgCanvas = document.createElement('canvas');
    corruptSvgCanvas.width = 48;
    corruptSvgCanvas.height = 40;
    renderer.renderPage({
      pageWidth: 48,
      pageHeight: 40,
      profile: 'screen',
      root: {
        kind: 'leaf',
        bounds: { x: 0, y: 0, width: 48, height: 40 },
        cacheHint: 'none',
        ops: [corruptSvgTextRun, corruptSvgOutline],
      },
      resources: {
        tableId: 904,
        images: [],
        imageHashes: [],
        imageKeys: [],
        svgFragments: ['<path d="M0 0L20 0L20 20Z" fill="#000"/><path d="not-a-path"/>'],
        svgHashes: ['corrupt-svg-glyph-resource'],
        svgKeys: ['corrupt-svg-glyph-resource'],
      },
    }, corruptSvgCanvas, 1);
    const corruptSvgReport = renderer.getTextVariantSelectionDiagnostics().find(
      (report) => report.equivalenceGroup === corruptSvgGroup,
    );
    const corruptSvgNativeProbe = {
      selectedVariantId: corruptSvgReport?.selectedVariantId,
      selectedVariantKind: corruptSvgReport?.selectedVariantKind,
      rejectedReasons: corruptSvgReport?.rejectedVariants.flatMap((variant) => variant.reasons) ?? [],
      rejectedDetails: corruptSvgReport?.rejectedVariants.flatMap((variant) => variant.details ?? []) ?? [],
    };

    let textBlobNativeProbe = null;
    if (window.__canvaskitRenderMode === 'default') {
      const probeCanvas = document.createElement('canvas');
      probeCanvas.width = 160;
      probeCanvas.height = 48;
      const probeTree = {
        pageWidth: 160,
        pageHeight: 48,
        profile: 'screen',
        root: {
          kind: 'leaf',
          bounds: { x: 0, y: 0, width: 160, height: 48 },
          cacheHint: 'none',
          ops: [simpleTextRun],
        },
        resources: {
          tableId: 901,
          images: [],
          imageHashes: [],
          imageKeys: [],
          svgFragments: [],
          svgHashes: [],
          svgKeys: [],
        },
      };
      const hitsBefore = renderer.textBlobCacheHits ?? 0;
      const missesBefore = renderer.textBlobCacheMisses ?? 0;
      renderer.textFallbackFamilyCache?.clear?.();
      const fallbackHitsBefore = renderer.textFallbackFamilyCacheHits ?? 0;
      const fallbackMissesBefore = renderer.textFallbackFamilyCacheMisses ?? 0;
      const originalMakeTextObjects = renderer.makeTextObjects;
      let makeTextObjectsCalls = 0;
      let getGlyphIdsCalls = 0;
      renderer.makeTextObjects = function makeTextObjectsCacheProbe() {
        makeTextObjectsCalls += 1;
        const objects = originalMakeTextObjects.apply(this, arguments);
        const originalGetGlyphIDs = objects.font.getGlyphIDs.bind(objects.font);
        objects.font.getGlyphIDs = function getGlyphIDsCacheProbe() {
          getGlyphIdsCalls += 1;
          return originalGetGlyphIDs(...arguments);
        };
        return objects;
      };
      try {
        renderer.renderPage(probeTree, probeCanvas, 1);
        const cacheSizeAfterFirst = renderer.textBlobCache?.size ?? 0;
        const fallbackCacheSizeAfterFirst = renderer.textFallbackFamilyCache?.size ?? 0;
        const makeTextObjectsCallsAfterFirst = makeTextObjectsCalls;
        const getGlyphIdsCallsAfterFirst = getGlyphIdsCalls;
        renderer.renderPage(probeTree, probeCanvas, 1);
        textBlobNativeProbe = {
          cacheSizeAfterFirst,
          cacheSizeAfterSecond: renderer.textBlobCache?.size ?? 0,
          hitsGained: (renderer.textBlobCacheHits ?? 0) - hitsBefore,
          missesGained: (renderer.textBlobCacheMisses ?? 0) - missesBefore,
          fallbackCacheSizeAfterFirst,
          fallbackCacheSizeAfterSecond: renderer.textFallbackFamilyCache?.size ?? 0,
          fallbackHitsGained: (renderer.textFallbackFamilyCacheHits ?? 0) - fallbackHitsBefore,
          fallbackMissesGained: (renderer.textFallbackFamilyCacheMisses ?? 0) - fallbackMissesBefore,
          firstMakeTextObjectsCalls: makeTextObjectsCallsAfterFirst,
          firstGetGlyphIdsCalls: getGlyphIdsCallsAfterFirst,
          secondMakeTextObjectsCalls: makeTextObjectsCalls - makeTextObjectsCallsAfterFirst,
          secondGetGlyphIdsCalls: getGlyphIdsCalls - getGlyphIdsCallsAfterFirst,
        };
      } finally {
        renderer.makeTextObjects = originalMakeTextObjects;
      }
    }

    let textBlobFailureProbe = null;
    if (window.__canvaskitRenderMode === 'default') {
      const probeCanvas = document.createElement('canvas');
      probeCanvas.width = 80;
      probeCanvas.height = 40;
      const failureTextRun = {
        ...simpleTextRun,
        id: 'text-blob-failure-probe',
        text: '😀B',
        positions: [0, 18, 36],
        bbox: { x: 4, y: 4, width: 42, height: 24 },
        baseline: 18,
        style: {
          ...simpleTextRun.style,
          fontSize: 17.125,
          shadowType: 1,
          shadowOffsetX: 1,
          shadowOffsetY: 1,
        },
      };
      const probeTree = {
        pageWidth: 80,
        pageHeight: 40,
        profile: 'screen',
        root: {
          kind: 'group',
          bounds: { x: 0, y: 0, width: 80, height: 40 },
          cacheHint: 'staticSubtree',
          children: [{
            kind: 'leaf',
            bounds: { x: 0, y: 0, width: 80, height: 40 },
            cacheHint: 'none',
            ops: [failureTextRun],
          }],
        },
        resources: {
          tableId: 902,
          images: [],
          imageHashes: [],
          imageKeys: [],
          svgFragments: [],
          svgHashes: [],
          svgKeys: [],
        },
      };
      const originalMakeFromText = renderer.canvasKit.TextBlob.MakeFromText;
      renderer.canvasKit.TextBlob.MakeFromText = function textBlobFailureProbeFactory(text) {
        if (text === 'B') {
          return null;
        }
        return originalMakeFromText.apply(this, arguments);
      };
      try {
        renderer.renderPage(probeTree, probeCanvas, 1);
        const first = renderer.getTextReplayDiagnostics();
        renderer.renderPage(probeTree, probeCanvas, 1);
        textBlobFailureProbe = {
          first,
          second: renderer.getTextReplayDiagnostics(),
        };
      } finally {
        renderer.canvasKit.TextBlob.MakeFromText = originalMakeFromText;
      }
    }

    let textEffectNativeProbe = null;
    if (typeof renderer.makePaint === 'function') {
      const probeCanvas = document.createElement('canvas');
      probeCanvas.width = 180;
      probeCanvas.height = 96;
      const effectBaseStyle = {
        ...simpleTextRun.style,
        fontSize: 24,
        color: '#111111',
        shadowColor: '#666666',
        shadowOffsetX: 1,
        shadowOffsetY: 1,
      };
      const probeTree = {
        pageWidth: 180,
        pageHeight: 96,
        profile: 'screen',
        root: {
          kind: 'leaf',
          bounds: { x: 0, y: 0, width: 180, height: 96 },
          cacheHint: 'none',
          ops: [
            {
              ...simpleTextRun,
              text: '□₩',
              positions: [0, 24, 48],
              bbox: { x: 8, y: 8, width: 72, height: 32 },
              baseline: 24,
              style: { ...effectBaseStyle, shadowType: 1, outlineType: 0 },
            },
            {
              ...simpleTextRun,
              text: '□₩',
              positions: [0, 24, 48],
              bbox: { x: 8, y: 48, width: 72, height: 32 },
              baseline: 24,
              style: { ...effectBaseStyle, shadowType: 0, outlineType: 1 },
            },
          ],
        },
        resources: {
          tableId: 906,
          images: [],
          imageHashes: [],
          imageKeys: [],
          svgFragments: [],
          svgHashes: [],
          svgKeys: [],
        },
      };
      const makePaintCalls = [];
      const originalMakePaint = renderer.makePaint;
      renderer.makePaint = function makePaintProbe(color, style, opacity) {
        makePaintCalls.push({ color, style, opacity });
        return originalMakePaint.apply(this, arguments);
      };
      try {
        renderer.renderPage(probeTree, probeCanvas, 1);
        textEffectNativeProbe = {
          makePaintCalls,
          hasRenderTextRunOverlay: typeof renderer.renderTextRunOverlay === 'function',
        };
      } finally {
        renderer.makePaint = originalMakePaint;
      }
    }

    let textProjectionNativeProbe = null;
    if (typeof renderer.renderTextRun === 'function') {
      const probeCanvas = document.createElement('canvas');
      probeCanvas.width = 160;
      probeCanvas.height = 72;
      const verticalTextRun = {
        ...simpleTextRun,
        text: '세로',
        positions: [0, 20, 40],
        bbox: { x: 8, y: 8, width: 64, height: 24 },
        isVertical: true,
        orientation: 'vertical-upright',
      };
      const invalidControlTextRun = {
        ...simpleTextRun,
        text: '\u0001',
        positions: [0, 8],
        bbox: { x: 8, y: 40, width: 32, height: 24 },
      };
      const verticalPresentationTextRun = {
        ...simpleTextRun,
        id: 'vertical-presentation-probe',
        text: '\uFE35\uFE36',
        positions: [0, 20, 40],
        bbox: { x: 80, y: 8, width: 48, height: 24 },
        isVertical: true,
        orientation: 'vertical-upright',
        style: {
          ...simpleTextRun.style,
          fontSize: 19.25,
        },
      };
      const probeTree = {
        pageWidth: 160,
        pageHeight: 72,
        profile: 'screen',
        root: {
          kind: 'leaf',
          bounds: { x: 0, y: 0, width: 160, height: 72 },
          cacheHint: 'none',
          ops: [verticalTextRun, verticalPresentationTextRun, invalidControlTextRun],
        },
        resources: {
          tableId: 902,
          images: [],
          imageHashes: [],
          imageKeys: [],
          svgFragments: [],
          svgHashes: [],
          svgKeys: [],
        },
      };
      let nativeTextRunCalls = 0;
      const originalRenderTextRun = renderer.renderTextRun;
      const originalMakeFromText = renderer.canvasKit.TextBlob.MakeFromText;
      const textBlobInputs = [];
      renderer.renderTextRun = function renderTextRunProbe(...args) {
        nativeTextRunCalls += 1;
        return originalRenderTextRun.apply(this, args);
      };
      renderer.canvasKit.TextBlob.MakeFromText = function verticalPresentationTextProbe(text) {
        textBlobInputs.push(text);
        return originalMakeFromText.apply(this, arguments);
      };
      try {
        renderer.renderPage(probeTree, probeCanvas, 1);
        textProjectionNativeProbe = {
          nativeTextRunCalls,
          hasRenderTextRunOverlay: typeof renderer.renderTextRunOverlay === 'function',
          verticalPresentationBaseTexts: textBlobInputs.filter((text) => text === '(' || text === ')'),
          verticalPresentationForms: textBlobInputs.filter((text) => text === '\uFE35' || text === '\uFE36'),
        };
      } finally {
        renderer.renderTextRun = originalRenderTextRun;
        renderer.canvasKit.TextBlob.MakeFromText = originalMakeFromText;
      }
    }

    let pageBackgroundImageNativeProbe = null;
    if (
      typeof renderer.renderPageBackground === 'function'
    ) {
      const sourceCanvas = document.createElement('canvas');
      sourceCanvas.width = 4;
      sourceCanvas.height = 4;
      const sourceCtx = sourceCanvas.getContext('2d');
      sourceCtx.fillStyle = '#4488ff';
      sourceCtx.fillRect(0, 0, 4, 4);
      const pageBackgroundBase64 = sourceCanvas.toDataURL('image/png').split(',')[1];
      const probeCanvas = document.createElement('canvas');
      probeCanvas.width = 32;
      probeCanvas.height = 32;
      const probeTree = {
        pageWidth: 32,
        pageHeight: 32,
        profile: 'screen',
        root: {
          kind: 'leaf',
          bounds: { x: 0, y: 0, width: 32, height: 32 },
          cacheHint: 'none',
          ops: [{
            type: 'pageBackground',
            bbox: { x: 0, y: 0, width: 32, height: 32 },
            backgroundColor: '#ffffff',
            borderWidth: 0,
            image: {
              fillMode: 'fitToSize',
              base64: pageBackgroundBase64,
            },
          }],
        },
        resources: {
          tableId: 903,
          images: [],
          imageHashes: [],
          imageKeys: [],
          svgFragments: [],
          svgHashes: [],
          svgKeys: [],
        },
      };
      let nativePageBackgroundCalls = 0;
      const originalRenderPageBackground = renderer.renderPageBackground;
      renderer.renderPageBackground = function renderPageBackgroundProbe(...args) {
        nativePageBackgroundCalls += 1;
        return originalRenderPageBackground.apply(this, args);
      };
      try {
        renderer.renderPage(probeTree, probeCanvas, 1);
        pageBackgroundImageNativeProbe = {
          nativePageBackgroundCalls,
          hasRenderPageBackgroundImageOverlay: typeof renderer.renderPageBackgroundImageOverlay === 'function',
        };
      } finally {
        renderer.renderPageBackground = originalRenderPageBackground;
      }
    }

    const fallbackOverlayPassProbe = {
      hasFallbackOverlayNode: typeof renderer.hasFallbackOverlayNode === 'function',
      hasRenderFallbackOverlays: typeof renderer.renderFallbackOverlays === 'function',
      hasRenderFallbackOverlayNode: typeof renderer.renderFallbackOverlayNode === 'function',
    };
    const nativeResourceCacheProbe = {
      hasDomImageCache: renderer.resourceCache
        ? Object.prototype.hasOwnProperty.call(renderer.resourceCache, 'domImageCache')
        : false,
      hasDomImageMethod: renderer.resourceCache
        ? typeof renderer.resourceCache.domImage === 'function'
        : false,
      hasRendererDomImageCache: Object.prototype.hasOwnProperty.call(renderer, 'domImageCache'),
    };
    const nativeResourceFailureProbe = await (async () => {
      let invalidInlineImageError = null;
      let invalidInlineImageFirst = null;
      let invalidInlineImageSecond = null;
      let afterFirst = null;
      let afterSecond = null;
      let rejectedEncodedImage = null;
      let rejectedEncodedImageDiagnostics = null;
      let browserRecoveredImage = null;
      let browserRecoveryDiagnostics = null;
      let staticPictureRecoveryFirst = null;
      let staticPictureRecoverySecond = null;
      let staticGifRecovery = null;
      let staticWebpRecovery = null;
      let staticWebpMime = null;
      let decoderFailedImage = null;
      let decoderFailedImageDiagnostics = null;
      let missingResourceImage = null;
      let missingResourceImageDiagnostics = null;
      let missingEffectResourceImage = null;
      let missingEffectResourceImageDiagnostics = null;
      let patternSurfaceError = null;
      let patternSurfaceFirst = null;
      let patternSurfaceFirstDiagnostics = null;
      let patternSurfaceSecond = null;
      let patternSurfaceSecondDiagnostics = null;
      let patternSurfaceRetry = null;
      let patternSurfaceRetryDiagnostics = null;
      renderer.resetImageDiagnostics();
      try {
        invalidInlineImageFirst = renderer.resourceCache.image(undefined, '%%%');
        afterFirst = renderer.getImageDiagnostics();
        invalidInlineImageSecond = renderer.resourceCache.image(undefined, '%%%');
        afterSecond = renderer.getImageDiagnostics();
        renderer.resetImageDiagnostics();
        rejectedEncodedImage = renderer.resourceCache.image(undefined, 'AQIDBA==');
        rejectedEncodedImageDiagnostics = renderer.getImageDiagnostics();
        const onePixelPng =
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5W7s8AAAAASUVORK5CYII=';
        const originalMakeImageFromEncoded = renderer.canvasKit.MakeImageFromEncoded;
        try {
          renderer.canvasKit.MakeImageFromEncoded = () => null;
          renderer.resetImageDiagnostics();
          browserRecoveredImage = renderer.resourceCache.image(undefined, onePixelPng);
        } finally {
          renderer.canvasKit.MakeImageFromEncoded = originalMakeImageFromEncoded;
        }
        const recoveryDeadline = Date.now() + 2_000;
        while (
          renderer.getImageDiagnostics().pendingLoads > 0
          && Date.now() < recoveryDeadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        browserRecoveredImage = renderer.resourceCache.image(undefined, onePixelPng);
        browserRecoveryDiagnostics = renderer.getImageDiagnostics();
        const recoveryProbeCanvas = document.createElement('canvas');
        recoveryProbeCanvas.width = 24;
        recoveryProbeCanvas.height = 24;
        const recoveryProbeTree = {
          pageWidth: 24,
          pageHeight: 24,
          profile: 'screen',
          root: {
            kind: 'group',
            bounds: { x: 0, y: 0, width: 24, height: 24 },
            cacheHint: 'staticSubtree',
            children: [{
              kind: 'leaf',
              bounds: { x: 0, y: 0, width: 24, height: 24 },
              cacheHint: 'none',
              ops: [{
                type: 'image',
                bbox: { x: 2, y: 2, width: 20, height: 20 },
                base64: onePixelPng,
                fillMode: 'fitToSize',
                transform: { rotation: 0, horzFlip: false, vertFlip: false },
              }],
            }],
          },
          resources: {
            tableId: 909,
            images: [],
            imageHashes: [],
            imageKeys: [],
            svgFragments: [],
            svgHashes: [],
            svgKeys: [],
          },
        };
        renderer.renderPage(recoveryProbeTree, recoveryProbeCanvas, 1);
        staticPictureRecoveryFirst = renderer.getImageDiagnostics();
        renderer.renderPage(recoveryProbeTree, recoveryProbeCanvas, 1);
        staticPictureRecoverySecond = renderer.getImageDiagnostics();
        const recoverStableBrowserRaster = async (encoded) => {
          const originalDecoder = renderer.canvasKit.MakeImageFromEncoded;
          let firstImage = null;
          try {
            renderer.canvasKit.MakeImageFromEncoded = () => null;
            renderer.resetImageDiagnostics();
            firstImage = renderer.resourceCache.image(undefined, encoded);
          } finally {
            renderer.canvasKit.MakeImageFromEncoded = originalDecoder;
          }
          const deadline = Date.now() + 2_000;
          while (
            renderer.getImageDiagnostics().pendingLoads > 0
            && Date.now() < deadline
          ) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          const recoveredImage = renderer.resourceCache.image(undefined, encoded);
          return {
            firstAvailable: firstImage !== null,
            recovered: recoveredImage !== null,
            diagnostics: renderer.getImageDiagnostics(),
          };
        };
        staticGifRecovery = await recoverStableBrowserRaster(
          'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
        );
        const webpCanvas = document.createElement('canvas');
        webpCanvas.width = 2;
        webpCanvas.height = 1;
        const webpContext = webpCanvas.getContext('2d');
        webpContext.fillStyle = '#123456';
        webpContext.fillRect(0, 0, 1, 1);
        webpContext.fillStyle = '#fedcba';
        webpContext.fillRect(1, 0, 1, 1);
        const webpDataUrl = webpCanvas.toDataURL('image/webp', 1);
        staticWebpMime = webpDataUrl.slice(0, webpDataUrl.indexOf(';'));
        staticWebpRecovery = await recoverStableBrowserRaster(webpDataUrl.split(',')[1]);
        const truncatedPng = new Uint8Array([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
          0x00, 0x00, 0x00, 0x0d,
          0x49, 0x48, 0x44, 0x52,
          0x00, 0x00, 0x00, 0x01,
          0x00, 0x00, 0x00, 0x01,
          0x08, 0x06, 0x00, 0x00, 0x00,
          0x00, 0x00, 0x00, 0x00,
        ]);
        const truncatedPngBase64 = btoa(String.fromCharCode(...truncatedPng));
        renderer.resetImageDiagnostics();
        decoderFailedImage = renderer.resourceCache.image(undefined, truncatedPngBase64);
        const failureDeadline = Date.now() + 2_000;
        while (
          renderer.getImageDiagnostics().pendingLoads > 0
          && Date.now() < failureDeadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        decoderFailedImage = renderer.resourceCache.image(undefined, truncatedPngBase64);
        decoderFailedImageDiagnostics = renderer.getImageDiagnostics();
        renderer.resetImageDiagnostics();
        missingResourceImage = renderer.resourceCache.image(0x7fffffff);
        missingResourceImageDiagnostics = renderer.getImageDiagnostics();
        renderer.resetImageDiagnostics();
        missingEffectResourceImage = renderer.resourceCache.imageWithEffect(
          0x7fffffff,
          undefined,
          'grayScale',
        );
        missingEffectResourceImageDiagnostics = renderer.getImageDiagnostics();
      } catch (error) {
        invalidInlineImageError = error?.message ?? String(error);
      }

      const originalMakeSurface = renderer.canvasKit.MakeSurface;
      try {
        renderer.canvasKit.MakeSurface = () => null;
        const pattern = {
          patternType: 97,
          patternColor: '#123456',
          backgroundColor: '#abcdef',
        };
        renderer.resetPatternDiagnostics();
        patternSurfaceFirst = renderer.resourceCache.patternImage(pattern);
        patternSurfaceFirstDiagnostics = renderer.getPatternDiagnostics();
        renderer.resetPatternDiagnostics();
        patternSurfaceSecond = renderer.resourceCache.patternImage(pattern);
        patternSurfaceSecondDiagnostics = renderer.getPatternDiagnostics();
        renderer.resourceCache.beginPatternReplay();
        patternSurfaceRetry = renderer.resourceCache.patternImage(pattern);
        patternSurfaceRetryDiagnostics = renderer.getPatternDiagnostics();
      } catch (error) {
        patternSurfaceError = error?.message ?? String(error);
      } finally {
        renderer.canvasKit.MakeSurface = originalMakeSurface;
      }

      let invalidFontBase64Error = null;
      try {
        renderer.fontRegistry.registerFontBlobsFromResources({
          blobs: [{
            id: 'invalid-base64-font',
            source: 'embedded',
            portability: 'portableBlob',
            digest: { algorithm: 'fixture', value: 'invalid-base64-font-digest' },
            dataRef: { kind: 'fontBlob', id: '0' },
          }],
          faces: [],
        }, {
          tableId: 907,
          images: [],
          imageHashes: [],
          imageKeys: [],
          svgFragments: [],
          svgHashes: [],
          svgKeys: [],
          fontBlobs: ['%%%'],
          fontBlobHashes: ['invalid-base64-font-digest'],
          fontBlobKeys: ['invalid-base64-font'],
        });
      } catch (error) {
        invalidFontBase64Error = error?.message ?? String(error);
      }

      renderer.fontRegistry.registerVerifiedFontBlob(
        'invalid-font-parser-blob',
        'invalid-font-parser-digest',
        new Uint8Array([0x52, 0x48, 0x57, 0x50]),
      );
      const invalidFontParserStatus = renderer.fontRegistry.glyphRunReplayStatus({
        type: 'glyphRun',
        bbox: { x: 0, y: 0, width: 20, height: 20 },
        source: { id: 908, utf8Range: { start: 0, end: 1 }, utf16Range: { start: 0, end: 1 } },
        variant: {
          equivalenceGroup: 'invalid-font-parser',
          variantId: 'glyphRun',
          variantKind: 'glyphRun',
          partIndex: 0,
          partCount: 1,
          isDefaultFallback: false,
          quality: 'exact',
          requires: ['fontResources', 'text.glyphRun'],
        },
        paintStyle: { ...simpleTextRun.style },
        shapeKey: {
          fontInstance: {
            faceKey: 'invalid-font-parser-face',
            sizePx: 12,
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
          runToPage: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
          baselineY: 0,
        },
        glyphIds: [1],
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
      }, {
        blobs: [{
          id: 'invalid-font-parser-blob',
          source: 'embedded',
          portability: 'portableBlob',
          digest: { algorithm: 'fixture', value: 'invalid-font-parser-digest' },
          dataRef: { kind: 'fontBlob', id: '0' },
        }],
        faces: [{
          id: 'invalid-font-parser-face',
          blobKey: 'invalid-font-parser-blob',
          faceIndex: 0,
          familyNames: [{ value: 'Invalid Parser Fixture' }],
          styleNames: [],
        }],
      });
      return {
        invalidInlineImageError,
        invalidInlineImageFirst,
        invalidInlineImageSecond,
        invalidInlineImageNegativeCached: renderer.resourceCache.failedImageCacheKeys.has('b64:%%%'),
        afterFirst,
        afterSecond,
        rejectedEncodedImage,
        rejectedEncodedImageDiagnostics,
        browserRecoveredImage: browserRecoveredImage !== null,
        browserRecoveryDiagnostics,
        staticPictureRecoveryFirst,
        staticPictureRecoverySecond,
        staticGifRecovery,
        staticWebpRecovery,
        staticWebpMime,
        decoderFailedImage,
        decoderFailedImageDiagnostics,
        missingResourceImage,
        missingResourceImageDiagnostics,
        missingEffectResourceImage,
        missingEffectResourceImageDiagnostics,
        patternSurfaceError,
        patternSurfaceFirstAvailable: patternSurfaceFirst !== null,
        patternSurfaceFirstDiagnostics,
        patternSurfaceSecondAvailable: patternSurfaceSecond !== null,
        patternSurfaceSecondDiagnostics,
        patternSurfaceRetryAvailable: patternSurfaceRetry !== null,
        patternSurfaceRetryDiagnostics,
        invalidFontBase64Error,
        invalidFontParserReplayable: invalidFontParserStatus.replayable,
        invalidFontParserReason: invalidFontParserStatus.reason,
      };
    })();

    const nativeDispatchProbe = (() => {
      const onePixelPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5W7s8AAAAASUVORK5CYII=';
      const shapeStyle = {
        fillColor: '#ccffcc',
        strokeColor: '#111111',
        strokeWidth: 1,
        strokeDash: 'solid',
        opacity: 1,
        pattern: null,
        shadow: null,
      };
      const dispatchOps = [
        simpleTextRun,
        {
          type: 'glyphOutline',
          bbox: { x: 8, y: 104, width: 18, height: 18 },
          variant: {
            equivalenceGroup: 'native-dispatch-outline',
            variantId: 'glyphOutline',
            variantKind: 'glyphOutline',
            partIndex: 0,
            partCount: 1,
            isDefaultFallback: false,
            requires: ['text.outlineGlyph'],
            quality: 'exact',
            anchorOpId: 'native-dispatch-text',
            localPaintOrder: 0,
          },
          paintStyle: { ...simpleTextRun.style, color: '#222222' },
          placement: {
            runToPage: { a: 1, b: 0, c: 0, d: 1, e: 8, f: 104 },
            baselineY: 0,
          },
          paths: [{
            glyphId: 1,
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
          }],
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
        {
          type: 'textControlMark',
          bbox: { x: 36, y: 104, width: 16, height: 16 },
          mark: { kind: 'paragraphEnd', text: '¶', x: 0, y: 13, fontSize: 12 },
        },
        {
          type: 'tabLeader',
          bbox: { x: 56, y: 104, width: 40, height: 10 },
          leader: { startX: 0, endX: 38, fillType: 2 },
          color: '#222222',
          fontSize: 10,
          baseline: 5,
        },
        {
          type: 'textDecoration',
          bbox: { x: 100, y: 104, width: 44, height: 12 },
          decoration: {
            kind: 'underline',
            baseline: 8,
            rotation: 0,
            fontSize: 10,
            ratio: 1,
            color: '#222222',
            shape: 0,
            underline: 'bottom',
            emphasisDot: 0,
            positions: [0, 11, 22, 33, 44],
          },
        },
        {
          type: 'line',
          bbox: { x: 0, y: 24, width: 64, height: 1 },
          x1: 0,
          y1: 24,
          x2: 64,
          y2: 24,
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
        },
        {
          type: 'rectangle',
          bbox: { x: 0, y: 32, width: 48, height: 24 },
          cornerRadius: 0,
          gradient: null,
          transform: { rotation: 0, horzFlip: false, vertFlip: false },
          style: shapeStyle,
        },
        {
          type: 'ellipse',
          bbox: { x: 52, y: 32, width: 28, height: 20 },
          gradient: null,
          transform: { rotation: 0, horzFlip: false, vertFlip: false },
          style: shapeStyle,
        },
        {
          type: 'path',
          bbox: { x: 84, y: 32, width: 32, height: 24 },
          commands: [
            { type: 'moveTo', x: 86, y: 54 },
            { type: 'lineTo', x: 98, y: 34 },
            { type: 'lineTo', x: 114, y: 54 },
            { type: 'closePath' },
          ],
          gradient: null,
          transform: { rotation: 0, horzFlip: false, vertFlip: false },
          style: {
            ...shapeStyle,
            fillColor: '#ffd9a8',
          },
        },
        {
          type: 'image',
          bbox: { x: 120, y: 32, width: 24, height: 24 },
          base64: onePixelPng,
          fillMode: 'fitToSize',
          transform: { rotation: 0, horzFlip: false, vertFlip: false },
        },
        {
          type: 'formObject',
          bbox: { x: 0, y: 64, width: 48, height: 16 },
          formType: 'checkBox',
          caption: '동의',
          text: '',
          foreColor: '#111111',
          backColor: '#ffffff',
          value: 1,
          enabled: true,
        },
        {
          ...equationOp,
          bbox: { x: 56, y: 60, width: 48, height: 24 },
        },
        {
          type: 'footnoteMarker',
          text: '1)',
          fontFamily: '함초롬돋움',
          fontSize: 10,
          color: '#111111',
          bbox: { x: 112, y: 64, width: 16, height: 16 },
        },
      ];
      const methodNames = [
        'renderTextRun',
        'renderGlyphOutline',
        'renderTextControlMark',
        'renderTabLeader',
        'renderTextDecoration',
        'renderLine',
        'renderRectangle',
        'renderEllipse',
        'renderPath',
        'renderImage',
        'renderFormObject',
        'renderEquation',
        'renderFootnoteMarker',
      ];
      const calls = Object.fromEntries(methodNames.map((name) => [name, 0]));
      const originals = new Map();
      for (const name of methodNames) {
        if (typeof renderer[name] !== 'function') {
          continue;
        }
        const original = renderer[name];
        originals.set(name, original);
        renderer[name] = function nativeDispatchMethodProbe(...args) {
          calls[name] += 1;
          return original.apply(this, args);
        };
      }
      const probeCanvas = document.createElement('canvas');
      probeCanvas.width = 180;
      probeCanvas.height = 128;
      const probeTree = {
        pageWidth: 180,
        pageHeight: 128,
        profile: 'screen',
        root: {
          kind: 'leaf',
          bounds: { x: 0, y: 0, width: 180, height: 128 },
          cacheHint: 'none',
          ops: dispatchOps,
        },
        resources: {
          tableId: 905,
          images: [],
          imageHashes: [],
          imageKeys: [],
          svgFragments: [],
          svgHashes: [],
          svgKeys: [],
        },
      };
      try {
        renderer.renderPage(probeTree, probeCanvas, 1);
      } finally {
        for (const [name, original] of originals) {
          renderer[name] = original;
        }
      }
      return {
        calls,
        overlayMethods: {
          shouldOverlayTextRun: typeof renderer.shouldOverlayTextRun === 'function',
          shouldOverlayGlyphOutline: typeof renderer.shouldOverlayGlyphOutline === 'function',
          shouldOverlayTextControlMark: typeof renderer.shouldOverlayTextControlMark === 'function',
          shouldOverlayTabLeader: typeof renderer.shouldOverlayTabLeader === 'function',
          shouldOverlayTextDecoration: typeof renderer.shouldOverlayTextDecoration === 'function',
          shouldOverlayLine: typeof renderer.shouldOverlayLine === 'function',
          shouldOverlayRectangle: typeof renderer.shouldOverlayRectangle === 'function',
          shouldOverlayEllipse: typeof renderer.shouldOverlayEllipse === 'function',
          shouldOverlayPath: typeof renderer.shouldOverlayPath === 'function',
          shouldOverlayImage: typeof renderer.shouldOverlayImage === 'function',
          shouldOverlayFormObject: typeof renderer.shouldOverlayFormObject === 'function',
          shouldOverlayEquation: typeof renderer.shouldOverlayEquation === 'function',
          shouldOverlayFootnoteMarker: typeof renderer.shouldOverlayFootnoteMarker === 'function',
          renderPageBackgroundImageOverlay: typeof renderer.renderPageBackgroundImageOverlay === 'function',
          renderGlyphOutlineOverlay: typeof renderer.renderGlyphOutlineOverlay === 'function',
          renderTextControlMarkOverlay: typeof renderer.renderTextControlMarkOverlay === 'function',
          renderTabLeaderOverlay: typeof renderer.renderTabLeaderOverlay === 'function',
          renderTextDecorationOverlay: typeof renderer.renderTextDecorationOverlay === 'function',
          renderImageOverlay: typeof renderer.renderImageOverlay === 'function',
          renderLineOverlay: typeof renderer.renderLineOverlay === 'function',
          renderRectangleOverlay: typeof renderer.renderRectangleOverlay === 'function',
          renderEllipseOverlay: typeof renderer.renderEllipseOverlay === 'function',
          renderPathOverlay: typeof renderer.renderPathOverlay === 'function',
          renderFormObjectOverlay: typeof renderer.renderFormObjectOverlay === 'function',
          renderTextRunOverlay: typeof renderer.renderTextRunOverlay === 'function',
          renderFootnoteMarkerOverlay: typeof renderer.renderFootnoteMarkerOverlay === 'function',
        },
      };
    })();

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
      measuredHftFamilies: Object.fromEntries(
        ['한양신명조', '한양중고딕', '한양견명조', '한양견고딕', '휴먼명조']
          .map((family) => [family, renderer.resolveCanvasKitFontFamily?.(family)]),
      ),
      equationSvgNativeProbe,
      corruptBitmapNativeProbe,
      corruptSvgNativeProbe,
      textBlobNativeProbe,
      textBlobFailureProbe,
      textEffectNativeProbe,
      textProjectionNativeProbe,
      pageBackgroundImageNativeProbe,
      fallbackOverlayPassProbe,
      nativeResourceCacheProbe,
      nativeResourceFailureProbe,
      nativeDispatchProbe,
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
  assert(
    Object.entries(nativeRouting.measuredHftFamilies ?? {})
      .every(([requested, selected]) => selected === requested),
    `measured HFT layer identities=${JSON.stringify(nativeRouting.measuredHftFamilies)}`,
  );
  assert(
    nativeRouting.textProjectionNativeProbe?.nativeTextRunCalls === 3,
    `vertical/invalid TextRun native calls=${JSON.stringify(nativeRouting.textProjectionNativeProbe)}`,
  );
  assert(
    nativeRouting.textProjectionNativeProbe?.verticalPresentationBaseTexts?.includes('(')
      && nativeRouting.textProjectionNativeProbe?.verticalPresentationBaseTexts?.includes(')')
      && nativeRouting.textProjectionNativeProbe?.verticalPresentationForms?.length === 0,
    `vertical presentation TextRun uses rotatable base glyphs=${JSON.stringify(nativeRouting.textProjectionNativeProbe)}`,
  );
  assert(
    nativeRouting.textProjectionNativeProbe?.hasRenderTextRunOverlay === false,
    `TextRun overlay method removed=${JSON.stringify(nativeRouting.textProjectionNativeProbe)}`,
  );
  assert(
    nativeRouting.textEffectNativeProbe?.hasRenderTextRunOverlay === false,
    `text effect overlay method removed=${JSON.stringify(nativeRouting.textEffectNativeProbe)}`,
  );
  assert(
    nativeRouting.textEffectNativeProbe?.makePaintCalls?.some((call) => call.color === '#666666' && call.style === 'fill'),
    `native text shadow paint=${JSON.stringify(nativeRouting.textEffectNativeProbe)}`,
  );
  assert(
    nativeRouting.textEffectNativeProbe?.makePaintCalls?.some((call) => call.color === '#111111' && call.style === 'stroke'),
    `native text outline stroke=${JSON.stringify(nativeRouting.textEffectNativeProbe)}`,
  );
  assert(
    nativeRouting.pageBackgroundImageNativeProbe?.nativePageBackgroundCalls === 1,
    `page background image native calls=${JSON.stringify(nativeRouting.pageBackgroundImageNativeProbe)}`,
  );
  assert(
    nativeRouting.pageBackgroundImageNativeProbe?.hasRenderPageBackgroundImageOverlay === false,
    `page background image overlay method removed=${JSON.stringify(nativeRouting.pageBackgroundImageNativeProbe)}`,
  );
  assert(
    nativeRouting.fallbackOverlayPassProbe?.hasFallbackOverlayNode === false
      && nativeRouting.fallbackOverlayPassProbe?.hasRenderFallbackOverlays === false
      && nativeRouting.fallbackOverlayPassProbe?.hasRenderFallbackOverlayNode === false,
    `fallback overlay pass methods removed=${JSON.stringify(nativeRouting.fallbackOverlayPassProbe)}`,
  );
  assert(
    nativeRouting.nativeResourceCacheProbe?.hasDomImageCache === false
      && nativeRouting.nativeResourceCacheProbe?.hasDomImageMethod === false
      && nativeRouting.nativeResourceCacheProbe?.hasRendererDomImageCache === false,
    `CanvasKit DOM image cache removed=${JSON.stringify(nativeRouting.nativeResourceCacheProbe)}`,
  );
  assert(
    nativeRouting.nativeResourceFailureProbe?.invalidInlineImageError === null
      && nativeRouting.nativeResourceFailureProbe?.invalidInlineImageFirst === null
      && nativeRouting.nativeResourceFailureProbe?.invalidInlineImageSecond === null
      && nativeRouting.nativeResourceFailureProbe?.invalidInlineImageNegativeCached === true
      && nativeRouting.nativeResourceFailureProbe?.afterFirst?.cacheMisses === 1
      && nativeRouting.nativeResourceFailureProbe?.afterFirst?.failureCacheHits === 0
      && nativeRouting.nativeResourceFailureProbe?.afterFirst?.failures?.[0]?.reason === 'base64DecodeFailed'
      && nativeRouting.nativeResourceFailureProbe?.afterSecond?.cacheMisses === 1
      && nativeRouting.nativeResourceFailureProbe?.afterSecond?.failureCacheHits === 1
      && nativeRouting.nativeResourceFailureProbe?.afterSecond?.failures?.length === 1,
    `invalid inline image base64 is contained and memoized=${JSON.stringify(nativeRouting.nativeResourceFailureProbe)}`,
  );
  assert(
    nativeRouting.nativeResourceFailureProbe?.rejectedEncodedImage === null
      && nativeRouting.nativeResourceFailureProbe?.rejectedEncodedImageDiagnostics?.cacheMisses === 1
      && nativeRouting.nativeResourceFailureProbe?.rejectedEncodedImageDiagnostics?.failures?.[0]?.reason
        === 'encodedImageRejected',
    `inadmissible encoded image reports a deterministic reason=${JSON.stringify(nativeRouting.nativeResourceFailureProbe)}`,
  );
  assert(
    nativeRouting.nativeResourceFailureProbe?.browserRecoveredImage === true
      && nativeRouting.nativeResourceFailureProbe?.browserRecoveryDiagnostics?.pendingLoads === 0
      && nativeRouting.nativeResourceFailureProbe?.browserRecoveryDiagnostics?.recoveries?.[0]?.reason
        === 'encodedImageDecodeFailed'
      && nativeRouting.nativeResourceFailureProbe?.browserRecoveryDiagnostics?.recoveries?.[0]?.fallback
        === 'browserImageSource'
      && nativeRouting.nativeResourceFailureProbe?.browserRecoveryDiagnostics?.recoveries?.[0]?.format
        === 'png'
      && nativeRouting.nativeResourceFailureProbe?.browserRecoveryDiagnostics?.failures?.length === 0
      && nativeRouting.nativeResourceFailureProbe?.staticPictureRecoveryFirst?.recoveries?.[0]?.reason
        === 'encodedImageDecodeFailed'
      && nativeRouting.nativeResourceFailureProbe?.staticPictureRecoverySecond?.recoveries?.[0]?.reason
        === 'encodedImageDecodeFailed'
      && nativeRouting.nativeResourceFailureProbe?.staticPictureRecoverySecond?.failures?.length === 0,
    `CanvasKit decoder failure recovers through a direct browser image source=${JSON.stringify(nativeRouting.nativeResourceFailureProbe)}`,
  );
  assert(
    nativeRouting.nativeResourceFailureProbe?.staticGifRecovery?.firstAvailable === false
      && nativeRouting.nativeResourceFailureProbe?.staticGifRecovery?.recovered === true
      && nativeRouting.nativeResourceFailureProbe?.staticGifRecovery?.diagnostics?.pendingLoads === 0
      && nativeRouting.nativeResourceFailureProbe?.staticGifRecovery?.diagnostics?.recoveries?.[0]?.format
        === 'gif'
      && nativeRouting.nativeResourceFailureProbe?.staticGifRecovery?.diagnostics?.failures?.length === 0,
    `single-frame GIF decoder failure recovers through a direct browser image=${JSON.stringify(
      nativeRouting.nativeResourceFailureProbe,
    )}`,
  );
  assert(
    nativeRouting.nativeResourceFailureProbe?.staticWebpMime === 'data:image/webp'
      && nativeRouting.nativeResourceFailureProbe?.staticWebpRecovery?.firstAvailable === false
      && nativeRouting.nativeResourceFailureProbe?.staticWebpRecovery?.recovered === true
      && nativeRouting.nativeResourceFailureProbe?.staticWebpRecovery?.diagnostics?.pendingLoads === 0
      && nativeRouting.nativeResourceFailureProbe?.staticWebpRecovery?.diagnostics?.recoveries?.[0]?.format
        === 'webp'
      && nativeRouting.nativeResourceFailureProbe?.staticWebpRecovery?.diagnostics?.failures?.length === 0,
    `single-frame WebP decoder failure recovers through a direct browser image=${JSON.stringify(
      nativeRouting.nativeResourceFailureProbe,
    )}`,
  );
  assert(
    nativeRouting.nativeResourceFailureProbe?.decoderFailedImage === null
      && nativeRouting.nativeResourceFailureProbe?.decoderFailedImageDiagnostics?.failureAttempts >= 1
      && nativeRouting.nativeResourceFailureProbe?.decoderFailedImageDiagnostics?.failureCacheHits >= 1
      && nativeRouting.nativeResourceFailureProbe?.decoderFailedImageDiagnostics?.failures?.[0]?.reason
        === 'imageDecodeFailed',
    `CanvasKit decoder failure reports a deterministic reason=${JSON.stringify(nativeRouting.nativeResourceFailureProbe)}`,
  );
  assert(
    nativeRouting.nativeResourceFailureProbe?.missingResourceImage === null
      && nativeRouting.nativeResourceFailureProbe?.missingResourceImageDiagnostics?.cacheMisses === 1
      && nativeRouting.nativeResourceFailureProbe?.missingResourceImageDiagnostics?.failures?.[0]?.reason
        === 'resourceUnavailable',
    `missing image resource reports a deterministic reason=${JSON.stringify(nativeRouting.nativeResourceFailureProbe)}`,
  );
  assert(
    nativeRouting.nativeResourceFailureProbe?.missingEffectResourceImage === null
      && nativeRouting.nativeResourceFailureProbe?.missingEffectResourceImageDiagnostics?.cacheMisses === 1
      && nativeRouting.nativeResourceFailureProbe?.missingEffectResourceImageDiagnostics?.failures?.[0]?.reason
        === 'resourceUnavailable',
    `missing image-effect resource reports a deterministic reason=${JSON.stringify(nativeRouting.nativeResourceFailureProbe)}`,
  );
  assert(
    nativeRouting.nativeResourceFailureProbe?.patternSurfaceError === null
      && nativeRouting.nativeResourceFailureProbe?.patternSurfaceFirstAvailable
      && nativeRouting.nativeResourceFailureProbe?.patternSurfaceFirstDiagnostics?.cacheMisses === 1
      && nativeRouting.nativeResourceFailureProbe?.patternSurfaceFirstDiagnostics?.failureCacheHits === 0
      && nativeRouting.nativeResourceFailureProbe?.patternSurfaceFirstDiagnostics?.surfaceCreations === 0
      && nativeRouting.nativeResourceFailureProbe?.patternSurfaceFirstDiagnostics?.directImageCreations === 1
      && nativeRouting.nativeResourceFailureProbe?.patternSurfaceFirstDiagnostics?.surfaceFailures === 0
      && nativeRouting.nativeResourceFailureProbe?.patternSurfaceSecondAvailable
      && nativeRouting.nativeResourceFailureProbe?.patternSurfaceSecondDiagnostics?.cacheHits === 1
      && nativeRouting.nativeResourceFailureProbe?.patternSurfaceSecondDiagnostics?.failureCacheHits === 0
      && nativeRouting.nativeResourceFailureProbe?.patternSurfaceSecondDiagnostics?.directImageCreations === 0
      && nativeRouting.nativeResourceFailureProbe?.patternSurfaceSecondDiagnostics?.surfaceFailures === 0,
    `pattern surface failures recover through a direct image=${JSON.stringify(nativeRouting.nativeResourceFailureProbe)}`,
  );
  assert(
    nativeRouting.nativeResourceFailureProbe?.patternSurfaceRetryAvailable
      && nativeRouting.nativeResourceFailureProbe?.patternSurfaceRetryDiagnostics?.cacheHits === 1
      && nativeRouting.nativeResourceFailureProbe?.patternSurfaceRetryDiagnostics?.cacheMisses === 0
      && nativeRouting.nativeResourceFailureProbe?.patternSurfaceRetryDiagnostics?.failureCacheHits === 0
      && nativeRouting.nativeResourceFailureProbe?.patternSurfaceRetryDiagnostics?.directImageCreations === 0
      && nativeRouting.nativeResourceFailureProbe?.patternSurfaceRetryDiagnostics?.surfaceFailures === 0,
    `direct pattern images remain cached across render boundaries=${JSON.stringify(nativeRouting.nativeResourceFailureProbe)}`,
  );
  assert(
    nativeRouting.nativeResourceFailureProbe?.invalidFontBase64Error === null
      && nativeRouting.nativeResourceFailureProbe?.invalidFontParserReplayable === false
      && nativeRouting.nativeResourceFailureProbe?.invalidFontParserReason === 'fontFaceInstantiationFailed',
    `invalid font payloads preserve GlyphRun fallback=${JSON.stringify(nativeRouting.nativeResourceFailureProbe)}`,
  );
  for (const [method, calls] of Object.entries(nativeRouting.nativeDispatchProbe?.calls ?? {})) {
    assert(calls > 0, `${method} native dispatch calls=${JSON.stringify(nativeRouting.nativeDispatchProbe)}`);
  }
  assert(
    Object.values(nativeRouting.nativeDispatchProbe?.overlayMethods ?? {}).every((exists) => exists === false),
    `CanvasKit overlay helper methods removed=${JSON.stringify(nativeRouting.nativeDispatchProbe?.overlayMethods)}`,
  );
  assert(
    nativeRouting.equationSvgNativeProbe?.hasEquationSvgDomImageCache === false,
    `equation svg DOM cache removed=${JSON.stringify(nativeRouting.equationSvgNativeProbe)}`,
  );
  assert(
    nativeRouting.equationSvgNativeProbe?.hasEquationSvgImageCache === false,
    `equation svg CanvasKit cache removed=${JSON.stringify(nativeRouting.equationSvgNativeProbe)}`,
  );
  assert(
    nativeRouting.equationSvgNativeProbe?.validLayoutDirectCalls === 0,
    `equation svg resource bypasses layout fallback=${JSON.stringify(nativeRouting.equationSvgNativeProbe)}`,
  );
  assert(
    nativeRouting.equationSvgNativeProbe?.malformedLayoutDirectCalls === 1,
    `malformed equation svg uses layout fallback=${JSON.stringify(nativeRouting.equationSvgNativeProbe)}`,
  );
  assert(
    nativeRouting.corruptBitmapNativeProbe?.selectedVariantKind === 'textRun'
      && nativeRouting.corruptBitmapNativeProbe?.rejectedReasons?.includes('unsupportedBitmapGlyph')
      && nativeRouting.corruptBitmapNativeProbe?.rejectedDetails?.includes('imageDecodeFailed'),
    `undecodable BitmapGlyph keeps TextRun fallback=${JSON.stringify(nativeRouting.corruptBitmapNativeProbe)}`,
  );
  assert(
    nativeRouting.corruptSvgNativeProbe?.selectedVariantKind === 'textRun'
      && nativeRouting.corruptSvgNativeProbe?.rejectedReasons?.includes('unsupportedSvgGlyph')
      && nativeRouting.corruptSvgNativeProbe?.rejectedDetails?.includes('pathDecodeFailed'),
    `unparseable SvgGlyph keeps TextRun fallback=${JSON.stringify(nativeRouting.corruptSvgNativeProbe)}`,
  );
  if (CANVASKIT_MODE === 'default') {
    assert(
      nativeRouting.textBlobFailureProbe?.first?.constructionFailures === 1
        && nativeRouting.textBlobFailureProbe?.first?.failureCacheHits >= 1
        && nativeRouting.textBlobFailureProbe?.first?.fallbackDraws >= 2
        && nativeRouting.textBlobFailureProbe?.first?.recoveries?.[0]?.reason === 'textBlobConstructionFailed'
        && nativeRouting.textBlobFailureProbe?.first?.recoveries?.[0]?.fallback === 'drawText'
        && nativeRouting.textBlobFailureProbe?.first?.recoveries?.[0]?.opId === 'text-blob-failure-probe'
        && nativeRouting.textBlobFailureProbe?.first?.recoveries?.[0]?.clusterStartUtf16 === 2
        && nativeRouting.textBlobFailureProbe?.first?.recoveries?.[0]?.clusterLengthUtf16 === 1
        && nativeRouting.textBlobFailureProbe?.first?.failures?.length === 0
        && nativeRouting.textBlobFailureProbe?.second?.constructionFailures === 1
        && nativeRouting.textBlobFailureProbe?.second?.failureCacheHits >= 1
        && nativeRouting.textBlobFailureProbe?.second?.fallbackDraws >= 2
        && nativeRouting.textBlobFailureProbe?.second?.recoveries?.[0]?.reason === 'textBlobConstructionFailed'
        && nativeRouting.textBlobFailureProbe?.second?.recoveries?.[0]?.fallback === 'drawText'
        && nativeRouting.textBlobFailureProbe?.second?.recoveries?.[0]?.opId === 'text-blob-failure-probe'
        && nativeRouting.textBlobFailureProbe?.second?.failures?.length === 0,
      `TextBlob failures use visible direct-text recovery across static-picture retries=${JSON.stringify(nativeRouting.textBlobFailureProbe)}`,
    );
    assert(
      nativeRouting.textBlobNativeProbe?.cacheSizeAfterSecond > 0,
      `text blob cache populated=${JSON.stringify(nativeRouting.textBlobNativeProbe)}`,
    );
    assert(
      nativeRouting.textBlobNativeProbe?.missesGained > 0,
      `text blob cache misses recorded=${JSON.stringify(nativeRouting.textBlobNativeProbe)}`,
    );
    assert(
      nativeRouting.textBlobNativeProbe?.hitsGained > 0,
      `text blob cache hits recorded=${JSON.stringify(nativeRouting.textBlobNativeProbe)}`,
    );
    assert(
      nativeRouting.textBlobNativeProbe?.fallbackCacheSizeAfterSecond > 0,
      `text fallback family cache populated=${JSON.stringify(nativeRouting.textBlobNativeProbe)}`,
    );
    assert(
      nativeRouting.textBlobNativeProbe?.fallbackMissesGained > 0,
      `text fallback family cache misses recorded=${JSON.stringify(nativeRouting.textBlobNativeProbe)}`,
    );
    assert(
      nativeRouting.textBlobNativeProbe?.fallbackHitsGained > 0,
      `text fallback family cache hits recorded=${JSON.stringify(nativeRouting.textBlobNativeProbe)}`,
    );
    assert(
      nativeRouting.textBlobNativeProbe?.firstMakeTextObjectsCalls > 0
        && nativeRouting.textBlobNativeProbe?.firstGetGlyphIdsCalls > 0,
      `cold text replay probes font coverage=${JSON.stringify(nativeRouting.textBlobNativeProbe)}`,
    );
    assert(
      nativeRouting.textBlobNativeProbe?.secondMakeTextObjectsCalls === 0
        && nativeRouting.textBlobNativeProbe?.secondGetGlyphIdsCalls === 0,
      `warm text replay skips font construction and coverage probes=${JSON.stringify(nativeRouting.textBlobNativeProbe)}`,
    );
  }
  } finally {
    for (const ownedBrowser of ownedBrowsers) {
      await closeBrowser(ownedBrowser).catch(() => {});
    }
    ownedBrowsers.clear();
  }
}, { skipLoadApp: true });
