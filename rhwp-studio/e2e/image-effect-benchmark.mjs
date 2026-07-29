import fs from 'node:fs';
import path from 'node:path';

import {
  closeBrowser,
  createPage,
  launchBrowser,
  loadApp,
} from './helpers.mjs';

const DEFAULT_CASES = [
  { name: '4k-full-pattern8x8', width: 4096, height: 4096, effect: 'pattern8x8' },
  { name: '8k-crop-pattern8x8', width: 8192, height: 8192, effect: 'pattern8x8', crop: 2048 },
];

if (process.env.RHWP_IMAGE_EFFECT_BENCH_FULL_8K === '1') {
  DEFAULT_CASES.push({ name: '8k-full-pattern8x8', width: 8192, height: 8192, effect: 'pattern8x8' });
}

const iterations = Math.max(
  1,
  Number.parseInt(process.env.RHWP_IMAGE_EFFECT_BENCH_ITERATIONS ?? '1', 10) || 1,
);
const outputPath = process.env.RHWP_IMAGE_EFFECT_BENCH_OUTPUT
  ?? '../output/e2e/image-effect-benchmark.json';
const workerRecommendationThresholdMs = Math.max(
  0,
  Number.parseFloat(process.env.RHWP_IMAGE_EFFECT_WORKER_THRESHOLD_MS ?? '200') || 200,
);
const workerRecommendationThresholdBytes = Math.max(
  0,
  Number.parseInt(process.env.RHWP_IMAGE_EFFECT_WORKER_THRESHOLD_BYTES ?? String(16 * 1024 * 1024), 10)
    || 16 * 1024 * 1024,
);

function roundMetric(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value * 1000) / 1000
    : null;
}

function summarizeResult(result) {
  const workerRecommended = result.elapsedMs >= workerRecommendationThresholdMs
    || result.diagnostics.maxPreprocessedBytes >= workerRecommendationThresholdBytes;
  return {
    ...result,
    setupMs: roundMetric(result.setupMs),
    elapsedMs: roundMetric(result.elapsedMs),
    preprocessTimeMs: roundMetric(result.diagnostics.preprocessTimeMs),
    maxPreprocessTimeMs: roundMetric(result.diagnostics.maxPreprocessTimeMs),
    workerRecommended,
    workerRecommendationReasons: [
      result.elapsedMs >= workerRecommendationThresholdMs ? 'elapsed-ms' : null,
      result.diagnostics.maxPreprocessedBytes >= workerRecommendationThresholdBytes ? 'preprocessed-bytes' : null,
    ].filter(Boolean),
  };
}

console.log('=== Image Effect Preprocessing Benchmark ===');
console.log(`  iterations=${iterations}`);
console.log(`  cases=${DEFAULT_CASES.map((caseInfo) => caseInfo.name).join(', ')}`);
console.log(
  `  worker-thresholds=${workerRecommendationThresholdMs}ms, `
  + `${workerRecommendationThresholdBytes} bytes`,
);

const browser = await launchBrowser();
const page = await createPage(browser, 1280, 900);

try {
  await loadApp(page);
  const benchmark = await page.evaluate(async ({ cases, iterations: benchIterations }) => {
    const {
      applyLayerImageEffect,
      layerCanvasImageSourceSize,
    } = await import('/src/view/layer-canvas-utils.ts');

    const makeDiagnostics = () => ({
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
      directImageReadbackPreprocesses: 0,
    });

    const makeCanvas = (width, height) => {
      const canvas = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(width, height)
        : document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      return canvas;
    };

    const paintSyntheticSource = (canvas) => {
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('2D context unavailable');
      }
      const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
      gradient.addColorStop(0, 'rgba(255, 40, 40, 1)');
      gradient.addColorStop(0.35, 'rgba(40, 220, 90, 0.78)');
      gradient.addColorStop(0.7, 'rgba(40, 120, 255, 0.62)');
      gradient.addColorStop(1, 'rgba(255, 220, 40, 0.9)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const stripeWidth = Math.max(16, Math.floor(canvas.width / 128));
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
      for (let x = 0; x < canvas.width; x += stripeWidth * 4) {
        ctx.fillRect(x, 0, stripeWidth, canvas.height);
      }
      ctx.globalCompositeOperation = 'source-over';
    };

    const results = [];
    for (const caseInfo of cases) {
      const setupStart = performance.now();
      const source = makeCanvas(caseInfo.width, caseInfo.height);
      paintSyntheticSource(source);
      const setupMs = performance.now() - setupStart;
      const cropSize = caseInfo.crop ?? 0;
      const sourceRect = cropSize > 0
        ? {
          x: Math.floor((caseInfo.width - cropSize) / 2),
          y: Math.floor((caseInfo.height - cropSize) / 2),
          width: cropSize,
          height: cropSize,
        }
        : null;

      for (let iteration = 0; iteration < benchIterations; iteration += 1) {
        const diagnostics = makeDiagnostics();
        const cache = new WeakMap();
        const elapsedStart = performance.now();
        const output = applyLayerImageEffect(
          source,
          caseInfo.effect,
          cache,
          diagnostics,
          sourceRect,
        );
        const elapsedMs = performance.now() - elapsedStart;
        const { width: outputWidth, height: outputHeight } = layerCanvasImageSourceSize(output);
        results.push({
          name: caseInfo.name,
          iteration: iteration + 1,
          sourceWidth: caseInfo.width,
          sourceHeight: caseInfo.height,
          sourcePixels: caseInfo.width * caseInfo.height,
          effect: caseInfo.effect,
          cropWidth: sourceRect?.width ?? null,
          cropHeight: sourceRect?.height ?? null,
          outputWidth,
          outputHeight,
          setupMs,
          elapsedMs,
          diagnostics,
        });
      }
    }

    return {
      userAgent: navigator.userAgent,
      offscreenCanvasAvailable: typeof OffscreenCanvas !== 'undefined',
      performanceMemoryAvailable: typeof performance !== 'undefined'
        && !!performance.memory
        && Number.isFinite(performance.memory.usedJSHeapSize),
      results,
    };
  }, { cases: DEFAULT_CASES, iterations });

  const summary = {
    generatedAt: new Date().toISOString(),
    iterations,
    cases: DEFAULT_CASES,
    userAgent: benchmark.userAgent,
    offscreenCanvasAvailable: benchmark.offscreenCanvasAvailable,
    performanceMemoryAvailable: benchmark.performanceMemoryAvailable,
    workerRecommendationThresholdMs,
    workerRecommendationThresholdBytes,
    results: benchmark.results.map(summarizeResult),
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);

  for (const result of summary.results) {
    console.log(
      `  ${result.name} #${result.iteration}: `
      + `elapsed=${result.elapsedMs}ms, `
      + `preprocess=${result.preprocessTimeMs}ms, `
      + `pixels=${result.diagnostics.preprocessedPixels}, `
      + `bytes=${result.diagnostics.preprocessedBytes}, `
      + `offscreen=${result.diagnostics.offscreenCanvasPreprocesses}, `
      + `html=${result.diagnostics.htmlCanvasPreprocesses}, `
      + `workerRecommended=${result.workerRecommended}`,
    );
  }
  console.log(`  output=${outputPath}`);
} finally {
  await closeBrowser(browser);
}
