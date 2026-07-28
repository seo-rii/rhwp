import fs from 'node:fs';
import path from 'node:path';

import {
  closeBrowser,
  closePage,
  comparePngBuffers,
  createPage,
  launchBrowser,
  loadApp,
  loadHwpFile,
} from './helpers.mjs';

const DEFAULT_BROWSER_PARITY_THRESHOLDS = {
  ignoreChannelDelta: 8,
  maxDiffRatio: 0.005,
};
const BASELINE_CAPTURE_CANVAS_ID = 'renderer-baseline-page-canvas';
const BACKENDS = [
  {
    key: 'canvas2d',
    queryForProfile(profile) {
      return `?renderer=canvas2d&renderProfile=${encodeURIComponent(profile)}`;
    },
    filenameForProfile(profile) {
      return `canvas2d-${profile}.png`;
    },
  },
  {
    key: 'canvaskit-compat',
    queryForProfile(profile) {
      const surfaceQuery = options.canvaskitSurface === 'auto'
        ? ''
        : `&canvaskitSurface=${encodeURIComponent(options.canvaskitSurface)}`;
      return `?renderer=canvaskit&canvaskitMode=compat&renderProfile=${encodeURIComponent(profile)}${surfaceQuery}`;
    },
    filenameForProfile(profile) {
      const surfaceSuffix = options.canvaskitSurface === 'auto' ? '' : `-${options.canvaskitSurface}`;
      return `canvaskit-compat-${profile}${surfaceSuffix}.png`;
    },
  },
  {
    key: 'canvaskit-default',
    queryForProfile(profile) {
      const surfaceQuery = options.canvaskitSurface === 'auto'
        ? ''
        : `&canvaskitSurface=${encodeURIComponent(options.canvaskitSurface)}`;
      return `?renderer=canvaskit&canvaskitMode=default&renderProfile=${encodeURIComponent(profile)}${surfaceQuery}`;
    },
    filenameForProfile(profile) {
      const surfaceSuffix = options.canvaskitSurface === 'auto' ? '' : `-${options.canvaskitSurface}`;
      return `canvaskit-default-${profile}${surfaceSuffix}.png`;
    },
  },
];
const ALLOWED_PROFILES = new Set(['screen', 'print', 'high-quality', 'fast-preview']);

function browserParityThresholdsForSample(sample) {
  const sampleThresholds = sample?.browserParityThresholds;
  if (!sampleThresholds || typeof sampleThresholds !== 'object') {
    return { ...DEFAULT_BROWSER_PARITY_THRESHOLDS };
  }
  const thresholds = { ...DEFAULT_BROWSER_PARITY_THRESHOLDS };
  for (const [key, value] of Object.entries(sampleThresholds)) {
    if (value === null || (typeof value === 'number' && Number.isFinite(value))) {
      thresholds[key] = value;
    }
  }
  return thresholds;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    manifest: '',
    output: '',
    filter: '',
    profiles: 'screen,fast-preview',
    canvaskitSurface: process.env.RHWP_CANVASKIT_SURFACE ?? 'auto',
  };

  for (const arg of args) {
    if (arg.startsWith('--manifest=')) {
      options.manifest = arg.slice('--manifest='.length);
      continue;
    }
    if (arg.startsWith('--output=')) {
      options.output = arg.slice('--output='.length);
      continue;
    }
    if (arg.startsWith('--filter=')) {
      options.filter = arg.slice('--filter='.length);
      continue;
    }
    if (arg.startsWith('--profiles=')) {
      options.profiles = arg.slice('--profiles='.length);
      continue;
    }
    if (arg.startsWith('--canvaskit-surface=')) {
      options.canvaskitSurface = arg.slice('--canvaskit-surface='.length);
      continue;
    }
  }

  if (!options.manifest) {
    throw new Error('missing --manifest=/abs/path/to/manifest.json');
  }
  if (!options.output) {
    throw new Error('missing --output=/abs/path/to/output-dir');
  }
  return options;
}

function parseProfiles(rawProfiles) {
  const profiles = rawProfiles
    .split(',')
    .map((profile) => profile.trim().toLowerCase())
    .filter(Boolean);
  if (profiles.length === 0) {
    throw new Error('at least one layered render profile must be specified');
  }

  const deduped = [];
  const seen = new Set();
  for (const profile of profiles) {
    if (!ALLOWED_PROFILES.has(profile)) {
      throw new Error(`unsupported layered render profile: ${profile}`);
    }
    if (seen.has(profile)) {
      continue;
    }
    seen.add(profile);
    deduped.push(profile);
  }
  return deduped;
}

function normalizeSamples(manifest, filterPattern) {
  const filter = filterPattern ? new RegExp(filterPattern, 'i') : null;
  return (manifest.samples ?? []).map((sample) => {
    const id = sample.id || path.basename(sample.file, path.extname(sample.file));
    const normalizedSample = {
      ...sample,
      id,
      file: sample.file,
      category: sample.category || 'uncategorized',
      page: sample.page ?? 0,
      viewOptions: {
        showParagraphMarks: false,
        showControlCodes: false,
      },
    };
    if (sample.viewOptions !== undefined) {
      if (!sample.viewOptions
        || typeof sample.viewOptions !== 'object'
        || Array.isArray(sample.viewOptions)
        || Object.keys(sample.viewOptions).some(
          (key) => !['showParagraphMarks', 'showControlCodes'].includes(key),
        )
        || Object.values(sample.viewOptions).some((value) => typeof value !== 'boolean')) {
        throw new Error(`invalid viewOptions for baseline sample: ${id}`);
      }
      normalizedSample.viewOptions = {
        showParagraphMarks: sample.viewOptions.showParagraphMarks ?? false,
        showControlCodes: sample.viewOptions.showControlCodes ?? false,
      };
    }
    return normalizedSample;
  }).filter((sample) => {
    if (!filter) {
      return true;
    }
    return filter.test(sample.id) || filter.test(sample.file) || filter.test(sample.category);
  });
}

async function applySampleViewOptions(page, viewOptions) {
  const previous = await page.evaluate(() => ({
    showParagraphMarks: window.__wasm?.getShowParagraphMarks?.() ?? false,
    showControlCodes: window.__wasm?.getShowControlCodes?.() ?? false,
  }));
  if (previous.showParagraphMarks === viewOptions.showParagraphMarks
    && previous.showControlCodes === viewOptions.showControlCodes) {
    return;
  }

  await page.evaluate((nextViewOptions) => {
    const wasm = window.__wasm;
    if (!wasm) {
      throw new Error('baseline view options require a loaded document');
    }
    wasm.setShowControlCodes(nextViewOptions.showControlCodes);
    wasm.setShowParagraphMarks(nextViewOptions.showParagraphMarks);
    window.__eventBus?.emit('document-changed');
  }, viewOptions);
  await page.waitForFunction(
    (expected) => {
      const wasm = window.__wasm;
      return wasm?.getShowParagraphMarks?.() === expected.showParagraphMarks
        && wasm?.getShowControlCodes?.() === expected.showControlCodes;
    },
    { timeout: 15000, polling: 50 },
    viewOptions,
  );
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

async function resetRendererDiagnostics(page) {
  await page.evaluate(() => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    pageRenderer?.canvas2dRenderer?.resetImageEffectDiagnostics?.();
    pageRenderer?.canvaskitRenderer?.resetImageEffectDiagnostics?.();
    pageRenderer?.canvaskitRenderer?.resetImageDiagnostics?.();
    pageRenderer?.canvaskitRenderer?.resetPatternDiagnostics?.();
  });
}

async function readRendererDiagnostics(page, pageIndex, backendKey) {
  return await page.evaluate(({ capturePageIndex, captureBackend }) => {
    const pageRenderer = window.__canvasView?.pageRenderer;
    const canvas2d = pageRenderer?.canvas2dRenderer?.getImageEffectDiagnostics?.() ?? null;
    const canvaskitRenderer = pageRenderer?.canvaskitRenderer;
    const canvaskit = canvaskitRenderer?.getImageEffectDiagnostics?.() ?? null;
    const imageDiagnostics = canvaskitRenderer?.getImageDiagnostics?.() ?? null;
    const patternDiagnostics = canvaskitRenderer?.getPatternDiagnostics?.() ?? null;
    const surfaceDiagnostics = canvaskitRenderer?.getSurfaceDiagnostics?.() ?? null;
    const runtimeRenderer = captureBackend.startsWith('canvaskit')
      ? canvaskitRenderer
      : pageRenderer?.canvas2dRenderer;
    const rawTextVariants = runtimeRenderer?.getTextVariantSelectionDiagnostics?.() ?? [];
    const textVariantsByGroup = new Map();
    const textVariantConflicts = [];
    for (const report of rawTextVariants) {
      const group = String(report.equivalenceGroup ?? '');
      const existing = textVariantsByGroup.get(group);
      if (!existing) {
        textVariantsByGroup.set(group, report);
        continue;
      }
      if (JSON.stringify(existing) !== JSON.stringify(report)) {
        textVariantConflicts.push({
          equivalenceGroup: group,
          first: existing,
          repeated: report,
        });
      }
    }
    const textVariants = [...textVariantsByGroup.values()];
    const textV2Validation = runtimeRenderer?.getTextV2ValidationDiagnostics?.() ?? [];
    let replayPlan = null;
    let replayPlanError = null;
    if (captureBackend.startsWith('canvaskit')) {
      try {
        const mode = captureBackend === 'canvaskit-compat' ? 'compat' : 'default';
        const rawPlan = window.__wasm?.getCanvasKitReplayPlan?.(capturePageIndex, mode);
        replayPlan = typeof rawPlan === 'string' ? JSON.parse(rawPlan) : rawPlan ?? null;
      } catch (error) {
        replayPlanError = error instanceof Error ? error.message : String(error);
      }
    }
    return {
      imageEffects: {
        canvas2d,
        canvaskit,
      },
      imageDiagnostics,
      patternDiagnostics,
      surfaceDiagnostics,
      replayPlan,
      replayPlanError,
      textVariants,
      textVariantDuplicateReports: rawTextVariants.length - textVariants.length,
      textVariantConflicts,
      textV2Validation,
    };
  }, { capturePageIndex: pageIndex, captureBackend: backendKey });
}

const options = parseArgs();
const requestedCanvasKitSurface = options.canvaskitSurface.trim().toLowerCase();
if (requestedCanvasKitSurface === 'sw' || requestedCanvasKitSurface === 'cpu') {
  options.canvaskitSurface = 'software';
} else if (requestedCanvasKitSurface === 'gpu') {
  options.canvaskitSurface = 'webgpu';
} else if (['auto', 'webgpu', 'webgl', 'software'].includes(requestedCanvasKitSurface)) {
  options.canvaskitSurface = requestedCanvasKitSurface;
} else {
  options.canvaskitSurface = 'auto';
}
const manifest = JSON.parse(fs.readFileSync(options.manifest, 'utf8'));
const samples = normalizeSamples(manifest, options.filter);
const profiles = parseProfiles(options.profiles);

if (samples.length === 0) {
  throw new Error('manifest filter removed every sample');
}
for (const sample of samples) {
  if (!Number.isInteger(sample.page) || sample.page < 0) {
    throw new Error(`baseline sample page must be a non-negative integer: ${sample.id} page=${sample.page}`);
  }
}

fs.mkdirSync(options.output, { recursive: true });

const results = [];
const hardGateViolations = [];
const browser = await launchBrowser();
const page = await createPage(browser, 1280, 900);

try {
  for (const sample of samples) {
    console.log(`\n[baseline] ${sample.id} (${sample.category}, page=${sample.page})`);

    for (const profile of profiles) {
      for (const backend of BACKENDS) {
        const totalStartedAt = performance.now();
        const appLoadStartedAt = performance.now();
        await loadApp(page, backend.queryForProfile(profile));
        const appLoadMs = performance.now() - appLoadStartedAt;

        const documentLoadStartedAt = performance.now();
        const documentInfo = await loadHwpFile(page, sample.file);
        const documentLoadAndInitialRenderMs = performance.now() - documentLoadStartedAt;
        await applySampleViewOptions(page, sample.viewOptions);
        if (sample.page >= documentInfo.pageCount) {
          throw new Error(
            `baseline sample page is out of range: ${sample.id} page=${sample.page} pageCount=${documentInfo.pageCount}`,
          );
        }

        await page.evaluate(() => window.__canvasView?.pageRenderer?.cancelAll?.());
        await resetRendererDiagnostics(page);
        const selectedPageRenderStartedAt = performance.now();
        await page.evaluate(
          ({ captureCanvasId, capturePageIndex }) => {
            const canvasView = window.__canvasView;
            const pageRenderer = canvasView?.pageRenderer;
            const wasm = window.__wasm;
            if (!pageRenderer || !wasm) {
              throw new Error('baseline page renderer is unavailable');
            }
            document.getElementById(captureCanvasId)?.remove();
            const canvas = document.createElement('canvas');
            canvas.id = captureCanvasId;
            canvas.style.position = 'fixed';
            canvas.style.left = '-100000px';
            canvas.style.top = '0';
            canvas.style.background = '#fff';
            canvas.style.pointerEvents = 'none';
            document.body.appendChild(canvas);

            const pageInfo = wasm.getPageInfo(capturePageIndex);
            const renderScale = 1.0;
            pageRenderer.renderPage(capturePageIndex, pageInfo, canvas, renderScale);
            canvas.style.width = `${canvas.width}px`;
            canvas.style.height = `${canvas.height}px`;
          },
          {
            captureCanvasId: BASELINE_CAPTURE_CANVAS_ID,
            capturePageIndex: sample.page,
          },
        );
        await page.waitForFunction(
          ({ captureBackend }) => {
            if (captureBackend !== 'canvas2d') {
              return true;
            }
            const imageCache = window.__canvasView?.pageRenderer?.canvas2dRenderer?.domImageCache;
            return imageCache instanceof Map
              && [...imageCache.values()].every((image) => image.complete);
          },
          { timeout: 10000, polling: 50 },
          { captureBackend: backend.key },
        );
        await page.evaluate(() => new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        }));
        const selectedPageState = await page.evaluate(
          ({ captureCanvasId, capturePageIndex, captureBackend }) => {
            const canvasView = window.__canvasView;
            const pageRenderer = canvasView?.pageRenderer;
            const wasm = window.__wasm;
            const canvas = document.getElementById(captureCanvasId);
            if (!pageRenderer || !wasm || !(canvas instanceof HTMLCanvasElement)) {
              throw new Error('baseline capture canvas is unavailable');
            }
            const pageInfo = wasm.getPageInfo(capturePageIndex);
            if (captureBackend === 'canvas2d') {
              pageRenderer.renderPage(capturePageIndex, pageInfo, canvas, 1.0);
            }
            const imageCache = captureBackend === 'canvas2d'
              ? pageRenderer.canvas2dRenderer?.domImageCache
              : null;
            const imageReadiness = imageCache instanceof Map
              ? [...imageCache.values()].reduce(
                (summary, image) => {
                  if (!image.complete) {
                    summary.pending += 1;
                  } else if (image.naturalWidth > 0) {
                    summary.loaded += 1;
                  } else {
                    summary.failed += 1;
                  }
                  return summary;
                },
                { total: imageCache.size, loaded: 0, failed: 0, pending: 0 },
              )
              : null;
            return {
              width: canvas.width,
              height: canvas.height,
              imageReadiness,
            };
          },
          {
            captureCanvasId: BASELINE_CAPTURE_CANVAS_ID,
            capturePageIndex: sample.page,
            captureBackend: backend.key,
          },
        );
        if ((selectedPageState.imageReadiness?.pending ?? 0) > 0) {
          throw new Error(
            `baseline capture still has pending images: ${sample.id} backend=${backend.key} pending=${selectedPageState.imageReadiness.pending}`,
          );
        }
        const selectedPageRenderMs = performance.now() - selectedPageRenderStartedAt;

        const sampleDir = path.join(options.output, sample.id);
        const outputPath = path.join(sampleDir, backend.filenameForProfile(profile));
        const screenshotStartedAt = performance.now();
        try {
          const pngDataUrl = await page.evaluate(
            ({ captureCanvasId }) => {
              const canvas = document.getElementById(captureCanvasId);
              if (!(canvas instanceof HTMLCanvasElement)) {
                throw new Error('baseline capture canvas is unavailable');
              }
              return canvas.toDataURL('image/png');
            },
            {
              captureCanvasId: BASELINE_CAPTURE_CANVAS_ID,
            },
          );
          fs.mkdirSync(sampleDir, { recursive: true });
          const pngBase64 = pngDataUrl.slice(pngDataUrl.indexOf(',') + 1);
          fs.writeFileSync(outputPath, Buffer.from(pngBase64, 'base64'));
          console.log(`  Baseline ${backend.key} (${profile}): ${outputPath}`);
        } finally {
          await page.evaluate(
            ({ captureCanvasId, capturePageIndex }) => {
              window.__canvasView?.pageRenderer?.cancelReRender?.(capturePageIndex);
              document.getElementById(captureCanvasId)?.remove();
            },
            {
              captureCanvasId: BASELINE_CAPTURE_CANVAS_ID,
              capturePageIndex: sample.page,
            },
          );
        }
        const screenshotMs = performance.now() - screenshotStartedAt;
        const diagnostics = await readRendererDiagnostics(page, sample.page, backend.key);
        diagnostics.capture = {
          width: selectedPageState.width,
          height: selectedPageState.height,
          imageReadiness: selectedPageState.imageReadiness,
        };
        if (backend.key.startsWith('canvaskit')) {
          const replayPlan = diagnostics.replayPlan;
          const replaySummary = replayPlan?.summary;
          if (diagnostics.replayPlanError) {
            hardGateViolations.push({
              sampleId: sample.id,
              backend: backend.key,
              profile,
              code: 'replayPlanUnavailable',
              detail: diagnostics.replayPlanError,
            });
          } else if (!replayPlan || !replaySummary || replaySummary.totalItems <= 0) {
            hardGateViolations.push({
              sampleId: sample.id,
              backend: backend.key,
              profile,
              code: 'replayPlanEmpty',
              detail: JSON.stringify(replayPlan),
            });
          }
          if (
            replayPlan
            && (replayPlan.hiddenCanvas2dOverlayAllowed !== false || replayPlan.directReplayRequired !== true)
          ) {
            hardGateViolations.push({
              sampleId: sample.id,
              backend: backend.key,
              profile,
              code: 'replayPlanContractMismatch',
              detail: JSON.stringify({
                hiddenCanvas2dOverlayAllowed: replayPlan.hiddenCanvas2dOverlayAllowed,
                directReplayRequired: replayPlan.directReplayRequired,
              }),
            });
          }
          if ((replaySummary?.hiddenOverlayViolations ?? 0) > 0) {
            hardGateViolations.push({
              sampleId: sample.id,
              backend: backend.key,
              profile,
              code: 'hiddenOverlayViolation',
              detail: String(replaySummary.hiddenOverlayViolations),
            });
          }
          if ((replaySummary?.compatOverlayItems ?? 0) > 0) {
            hardGateViolations.push({
              sampleId: sample.id,
              backend: backend.key,
              profile,
              code: 'compatOverlayItem',
              detail: String(replaySummary.compatOverlayItems),
            });
          }
          if ((replaySummary?.directRequiredItems ?? 0) > 0) {
            hardGateViolations.push({
              sampleId: sample.id,
              backend: backend.key,
              profile,
              code: 'directRequiredItem',
              detail: String(replaySummary.directRequiredItems),
            });
          }
          if ((diagnostics.imageDiagnostics?.failures?.length ?? 0) > 0) {
            hardGateViolations.push({
              sampleId: sample.id,
              backend: backend.key,
              profile,
              code: 'runtimeImageReplayFailure',
              detail: JSON.stringify(diagnostics.imageDiagnostics.failures),
            });
          }
          if (diagnostics.textV2Validation.length > 0) {
            hardGateViolations.push({
              sampleId: sample.id,
              backend: backend.key,
              profile,
              code: 'textV2ValidationIssue',
              detail: JSON.stringify(diagnostics.textV2Validation),
            });
          }
          if (diagnostics.textVariantConflicts.length > 0) {
            hardGateViolations.push({
              sampleId: sample.id,
              backend: backend.key,
              profile,
              code: 'runtimeVariantSelectionConflict',
              detail: JSON.stringify(diagnostics.textVariantConflicts),
            });
          }
          const planSelections = new Map(
            (replayPlan?.textVariants ?? []).map((report) => [
              String(report.equivalenceGroup ?? ''),
              report.selectedVariantId ?? null,
            ]),
          );
          const runtimeSelections = new Map(
            diagnostics.textVariants.map((report) => [
              String(report.equivalenceGroup ?? ''),
              report.selectedVariantId ?? null,
            ]),
          );
          const selectionGroups = new Set([
            ...planSelections.keys(),
            ...runtimeSelections.keys(),
          ]);
          for (const equivalenceGroup of selectionGroups) {
            const planVariantId = planSelections.get(equivalenceGroup);
            const runtimeVariantId = runtimeSelections.get(equivalenceGroup);
            if (
              !planSelections.has(equivalenceGroup)
              || !runtimeSelections.has(equivalenceGroup)
              || runtimeVariantId !== planVariantId
            ) {
              hardGateViolations.push({
                sampleId: sample.id,
                backend: backend.key,
                profile,
                code: 'planRuntimeVariantMismatch',
                detail: JSON.stringify({
                  equivalenceGroup,
                  planVariantId: planVariantId ?? null,
                  runtimeVariantId: runtimeVariantId ?? null,
                }),
              });
            }
          }
        }
        results.push({
          sampleId: sample.id,
          file: sample.file,
          category: sample.category,
          page: sample.page,
          backend: backend.key,
          profile,
          canvaskitSurface: backend.key.startsWith('canvaskit') ? options.canvaskitSurface : null,
          path: outputPath,
          timings: {
            appLoadMs,
            documentLoadAndInitialRenderMs,
            selectedPageRenderMs,
            screenshotMs,
            totalMs: performance.now() - totalStartedAt,
          },
          diagnostics,
        });
      }
    }
  }
} finally {
  await closePage(page).catch(() => {});
  await closeBrowser(browser).catch(() => {});
}

const reportPath = path.join(options.output, 'browser-baseline-report.json');
const browserBackendComparisons = [];
for (const sample of samples) {
  for (const profile of profiles) {
    const baseline = results.find((entry) => (
      entry.sampleId === sample.id
        && entry.backend === 'canvas2d'
        && entry.profile === profile
    ));
    for (const targetBackend of ['canvaskit-compat', 'canvaskit-default']) {
      const target = results.find((entry) => (
        entry.sampleId === sample.id
          && entry.backend === targetBackend
          && entry.profile === profile
      ));
      if (!baseline || !target) {
        browserBackendComparisons.push({
          sampleId: sample.id,
          category: sample.category,
          profile,
          baselineBackend: 'canvas2d',
          targetBackend,
          status: 'missing',
          baselinePath: baseline?.path ?? null,
          targetPath: target?.path ?? null,
        });
        continue;
      }

      try {
        const thresholds = browserParityThresholdsForSample(sample);
        const diff = await comparePngBuffers(
          fs.readFileSync(baseline.path),
          fs.readFileSync(target.path),
          thresholds,
        );
        browserBackendComparisons.push({
          sampleId: sample.id,
          category: sample.category,
          profile,
          baselineBackend: 'canvas2d',
          targetBackend,
          canvaskitSurface: target.canvaskitSurface ?? null,
          status: 'compared',
          baselinePath: baseline.path,
          targetPath: target.path,
          thresholds,
          diff: {
            passed: diff.passed,
            passMetric: diff.passMetric,
            width: diff.width,
            height: diff.height,
            exactDiffPixels: diff.exactDiffPixels,
            exactDiffRatio: diff.exactDiffRatio,
            tolerantDiffPixels: diff.rawTolerantDiffPixels,
            tolerantDiffRatio: diff.rawTolerantDiffRatio,
            selectedDiffPixels: diff.diffPixels,
            selectedDiffRatio: diff.diffRatio,
            maxChannelDelta: diff.maxChannelDelta,
            meanAbsChannelDelta: diff.meanAbsChannelDelta,
          },
        });
      } catch (error) {
        browserBackendComparisons.push({
          sampleId: sample.id,
          category: sample.category,
          profile,
          baselineBackend: 'canvas2d',
          targetBackend,
          canvaskitSurface: target.canvaskitSurface ?? null,
          status: 'error',
          baselinePath: baseline.path,
          targetPath: target.path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
const browserBackendCompared = browserBackendComparisons.filter((item) => item.status === 'compared');
const browserBackendSummaryByTarget = new Map();
const browserBackendSummaryByProfile = new Map();
const browserBackendSummaryByCategory = new Map();
for (const item of browserBackendComparisons) {
  for (const [summaryMap, keyField, keyValue] of [
    [browserBackendSummaryByTarget, 'targetBackend', item.targetBackend],
    [browserBackendSummaryByProfile, 'profile', item.profile],
    [browserBackendSummaryByCategory, 'category', item.category],
  ]) {
    if (!summaryMap.has(keyValue)) {
      summaryMap.set(keyValue, {
        [keyField]: keyValue,
        total: 0,
        compared: 0,
        passed: 0,
        failed: 0,
        missing: 0,
        errors: 0,
        worstSelectedDiffRatio: 0,
        worstTolerantDiffRatio: 0,
        worstMaxChannelDelta: 0,
      });
    }
    const summary = summaryMap.get(keyValue);
    summary.total += 1;
    if (item.status === 'missing') {
      summary.missing += 1;
      continue;
    }
    if (item.status === 'error') {
      summary.errors += 1;
      continue;
    }
    if (item.status !== 'compared') {
      continue;
    }
    summary.compared += 1;
    if (item.diff?.passed) {
      summary.passed += 1;
    } else {
      summary.failed += 1;
    }
    if (typeof item.diff?.selectedDiffRatio === 'number') {
      summary.worstSelectedDiffRatio = Math.max(
        summary.worstSelectedDiffRatio,
        item.diff.selectedDiffRatio,
      );
    }
    if (typeof item.diff?.tolerantDiffRatio === 'number') {
      summary.worstTolerantDiffRatio = Math.max(
        summary.worstTolerantDiffRatio,
        item.diff.tolerantDiffRatio,
      );
    }
    if (typeof item.diff?.maxChannelDelta === 'number') {
      summary.worstMaxChannelDelta = Math.max(
        summary.worstMaxChannelDelta,
        item.diff.maxChannelDelta,
      );
    }
  }
}
const browserBackendParity = {
  mode: 'reportOnly',
  backendPairs: [
    ['canvas2d', 'canvaskit-compat'],
    ['canvas2d', 'canvaskit-default'],
  ],
  thresholds: DEFAULT_BROWSER_PARITY_THRESHOLDS,
  summary: {
    total: browserBackendComparisons.length,
    compared: browserBackendCompared.length,
    passed: browserBackendCompared.filter((item) => item.diff?.passed).length,
    failed: browserBackendCompared.filter((item) => !item.diff?.passed).length,
    missing: browserBackendComparisons.filter((item) => item.status === 'missing').length,
    errors: browserBackendComparisons.filter((item) => item.status === 'error').length,
  },
  summaryByTargetBackend: [...browserBackendSummaryByTarget.values()]
    .sort((left, right) => left.targetBackend.localeCompare(right.targetBackend)),
  summaryByProfile: [...browserBackendSummaryByProfile.values()]
    .sort((left, right) => left.profile.localeCompare(right.profile)),
  summaryByCategory: [...browserBackendSummaryByCategory.values()]
    .sort((left, right) => String(left.category).localeCompare(String(right.category))),
  worstComparisons: browserBackendCompared
    .map((item) => ({
      sampleId: item.sampleId,
      category: item.category,
      profile: item.profile,
      targetBackend: item.targetBackend,
      canvaskitSurface: item.canvaskitSurface ?? null,
      passed: !!item.diff?.passed,
      selectedDiffPixels: item.diff?.selectedDiffPixels ?? 0,
      selectedDiffRatio: item.diff?.selectedDiffRatio ?? 0,
      tolerantDiffRatio: item.diff?.tolerantDiffRatio ?? 0,
      maxChannelDelta: item.diff?.maxChannelDelta ?? 0,
      meanAbsChannelDelta: item.diff?.meanAbsChannelDelta ?? 0,
    }))
    .sort((left, right) => (
      right.selectedDiffRatio - left.selectedDiffRatio
        || right.tolerantDiffRatio - left.tolerantDiffRatio
        || right.maxChannelDelta - left.maxChannelDelta
        || left.sampleId.localeCompare(right.sampleId)
        || left.targetBackend.localeCompare(right.targetBackend)
        || left.profile.localeCompare(right.profile)
    ))
    .slice(0, 10),
  comparisons: browserBackendComparisons,
};

const replaySummaryByBackendProfile = new Map();
for (const result of results) {
  if (!result.backend.startsWith('canvaskit')) {
    continue;
  }
  const key = `${result.backend}\u0000${result.profile}`;
  if (!replaySummaryByBackendProfile.has(key)) {
    replaySummaryByBackendProfile.set(key, {
      backend: result.backend,
      profile: result.profile,
      captureCount: 0,
      totalItems: 0,
      directItems: 0,
      directRequiredItems: 0,
      compatOverlayItems: 0,
      textFallbackItems: 0,
      unsupportedItems: 0,
      hiddenOverlayViolations: 0,
      hardGateViolationCount: 0,
      runtimeImageFailures: 0,
      patternSurfaceFailures: 0,
      textV2ValidationIssues: 0,
      runtimeDuplicateVariantReports: 0,
      runtimeVariantSelectionConflicts: 0,
      planStatusCounts: {},
      planReasonCounts: {},
      selectedReasonCounts: {},
      rejectedReasonCounts: {},
      runtimeImageFailureReasonCounts: {},
      textV2IssueCounts: {},
    });
  }
  const summary = replaySummaryByBackendProfile.get(key);
  const diagnostics = result.diagnostics ?? {};
  const replayPlan = diagnostics.replayPlan ?? {};
  const planSummary = replayPlan.summary ?? {};
  summary.captureCount += 1;
  for (const field of [
    'totalItems',
    'directItems',
    'directRequiredItems',
    'compatOverlayItems',
    'textFallbackItems',
    'unsupportedItems',
    'hiddenOverlayViolations',
  ]) {
    const value = planSummary[field];
    if (typeof value === 'number' && Number.isFinite(value)) {
      summary[field] += value;
    }
  }
  summary.patternSurfaceFailures += diagnostics.patternDiagnostics?.surfaceFailures ?? 0;
  summary.runtimeImageFailures += diagnostics.imageDiagnostics?.failures?.length ?? 0;
  summary.textV2ValidationIssues += diagnostics.textV2Validation?.length ?? 0;
  summary.runtimeDuplicateVariantReports += diagnostics.textVariantDuplicateReports ?? 0;
  summary.runtimeVariantSelectionConflicts += diagnostics.textVariantConflicts?.length ?? 0;

  for (const item of replayPlan.items ?? []) {
    const status = String(item.status ?? 'unknown');
    const reason = String(item.reason ?? 'unknown');
    summary.planStatusCounts[status] = (summary.planStatusCounts[status] ?? 0) + 1;
    summary.planReasonCounts[reason] = (summary.planReasonCounts[reason] ?? 0) + 1;
  }
  for (const report of diagnostics.textVariants ?? []) {
    const selectedReason = String(report.selectedReason ?? 'unknown');
    summary.selectedReasonCounts[selectedReason] = (
      summary.selectedReasonCounts[selectedReason] ?? 0
    ) + 1;
    for (const rejected of report.rejectedVariants ?? []) {
      for (const reason of rejected.reasons ?? []) {
        const rejectedReason = String(reason);
        summary.rejectedReasonCounts[rejectedReason] = (
          summary.rejectedReasonCounts[rejectedReason] ?? 0
        ) + 1;
      }
    }
  }
  for (const failure of diagnostics.imageDiagnostics?.failures ?? []) {
    const reason = String(failure.reason ?? 'unknown');
    summary.runtimeImageFailureReasonCounts[reason] = (
      summary.runtimeImageFailureReasonCounts[reason] ?? 0
    ) + 1;
  }
  for (const issue of diagnostics.textV2Validation ?? []) {
    const issueCode = String(issue.code ?? 'unknown');
    summary.textV2IssueCounts[issueCode] = (summary.textV2IssueCounts[issueCode] ?? 0) + 1;
  }
}

for (const violation of hardGateViolations) {
  const key = `${violation.backend}\u0000${violation.profile}`;
  const summary = replaySummaryByBackendProfile.get(key);
  if (summary) {
    summary.hardGateViolationCount += 1;
  }
}

const replaySummaryRows = [...replaySummaryByBackendProfile.values()]
  .sort((left, right) => (
    left.profile.localeCompare(right.profile) || left.backend.localeCompare(right.backend)
  ));
for (const summary of replaySummaryRows) {
  for (const field of [
    'planStatusCounts',
    'planReasonCounts',
    'selectedReasonCounts',
    'rejectedReasonCounts',
    'textV2IssueCounts',
  ]) {
    summary[field] = Object.fromEntries(
      Object.entries(summary[field]).sort(([left], [right]) => left.localeCompare(right)),
    );
  }
}
const canvaskitReplayDiagnostics = {
  mode: 'hardSafetyGateAndReportInventory',
  hardGateViolationCount: hardGateViolations.length,
  hardGateViolations,
  summaryByBackendProfile: replaySummaryRows,
};

fs.writeFileSync(
  reportPath,
  JSON.stringify(
    {
      manifest: options.manifest,
      sampleCount: samples.length,
      profiles,
      canvaskitSurface: options.canvaskitSurface,
      results,
      browserBackendParity,
      canvaskitReplayDiagnostics,
    },
    null,
    2,
  ),
);
console.log(`\n[baseline] browser report: ${reportPath}`);
if (hardGateViolations.length > 0) {
  throw new Error(
    `CanvasKit baseline safety gate failed with ${hardGateViolations.length} violation(s): ${JSON.stringify(hardGateViolations.slice(0, 5))}`,
  );
}
