import fs from 'node:fs';
import path from 'node:path';

import { comparePngBuffers } from './helpers.mjs';

const DEFAULT_IGNORE_CHANNEL_DELTA = 8;
const DEFAULT_MAX_DIFF_RATIO = 0.005;

function parseArgs() {
  const options = {
    native: '',
    browser: '',
    output: '',
    profiles: '',
  };

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--native=')) {
      options.native = arg.slice('--native='.length);
      continue;
    }
    if (arg.startsWith('--browser=')) {
      options.browser = arg.slice('--browser='.length);
      continue;
    }
    if (arg.startsWith('--output=')) {
      options.output = arg.slice('--output='.length);
      continue;
    }
    if (arg.startsWith('--profiles=')) {
      options.profiles = arg.slice('--profiles='.length);
      continue;
    }
  }

  if (!options.native) throw new Error('missing --native=/abs/path/native-results.json');
  if (!options.browser) throw new Error('missing --browser=/abs/path/browser-baseline-report.json');
  if (!options.output) throw new Error('missing --output=/abs/path/native-canvaskit-parity-report.json');
  return options;
}

function resolveRepoPath(value, rootDir) {
  if (!value) return '';
  return path.isAbsolute(value) ? value : path.resolve(rootDir, value);
}

function firstNativeSkiaPng(nativeResults, sampleId, profile, rootDir) {
  const sample = nativeResults.find((entry) => entry.sampleId === sampleId);
  const backend = sample?.backends?.find((entry) => (
    entry.backend === 'native-skia' && entry.profile === profile
  ));
  const pngPath = backend?.files?.find((file) => file.endsWith('.png'));
  return resolveRepoPath(pngPath, rootDir);
}

function canvaskitDefaultPng(browserResults, sampleId, profile, rootDir) {
  const item = browserResults.find((entry) => (
    entry.sampleId === sampleId
      && entry.backend === 'canvaskit-default'
      && entry.profile === profile
  ));
  return resolveRepoPath(item?.path, rootDir);
}

async function comparePair(nativePath, canvaskitPath) {
  const diff = await comparePngBuffers(
    fs.readFileSync(nativePath),
    fs.readFileSync(canvaskitPath),
    {
      ignoreChannelDelta: DEFAULT_IGNORE_CHANNEL_DELTA,
      maxDiffRatio: DEFAULT_MAX_DIFF_RATIO,
    },
  );
  return {
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
    ignoreChannelDelta: diff.ignoreChannelDelta,
    maxDiffRatio: DEFAULT_MAX_DIFF_RATIO,
  };
}

const options = parseArgs();
const rootDir = path.resolve(new URL('../..', import.meta.url).pathname);
const nativeResults = JSON.parse(fs.readFileSync(options.native, 'utf8'));
const browserReport = JSON.parse(fs.readFileSync(options.browser, 'utf8'));
const browserResults = browserReport.results ?? [];
const profiles = options.profiles
  ? options.profiles.split(',').map((profile) => profile.trim()).filter(Boolean)
  : browserReport.profiles ?? [];

const sampleIds = [...new Set([
  ...nativeResults.map((entry) => entry.sampleId),
  ...browserResults.map((entry) => entry.sampleId),
])].sort();

const comparisons = [];
for (const sampleId of sampleIds) {
  for (const profile of profiles) {
    const nativePath = firstNativeSkiaPng(nativeResults, sampleId, profile, rootDir);
    const canvaskitPath = canvaskitDefaultPng(browserResults, sampleId, profile, rootDir);
    if (!nativePath || !canvaskitPath) {
      comparisons.push({
        sampleId,
        profile,
        status: 'missing',
        nativePath: nativePath || null,
        canvaskitPath: canvaskitPath || null,
      });
      continue;
    }

    try {
      comparisons.push({
        sampleId,
        profile,
        status: 'compared',
        nativePath,
        canvaskitPath,
        diff: await comparePair(nativePath, canvaskitPath),
      });
    } catch (error) {
      comparisons.push({
        sampleId,
        profile,
        status: 'error',
        nativePath,
        canvaskitPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

const compared = comparisons.filter((item) => item.status === 'compared');
const passed = compared.filter((item) => item.diff?.passed).length;
const failed = compared.length - passed;
const missing = comparisons.filter((item) => item.status === 'missing').length;
const errors = comparisons.filter((item) => item.status === 'error').length;

fs.mkdirSync(path.dirname(options.output), { recursive: true });
fs.writeFileSync(
  options.output,
  JSON.stringify(
    {
      mode: 'reportOnly',
      backendPair: ['native-skia', 'canvaskit-default'],
      thresholds: {
        ignoreChannelDelta: DEFAULT_IGNORE_CHANNEL_DELTA,
        maxDiffRatio: DEFAULT_MAX_DIFF_RATIO,
      },
      summary: {
        total: comparisons.length,
        compared: compared.length,
        passed,
        failed,
        missing,
        errors,
      },
      comparisons,
    },
    null,
    2,
  ),
);

console.log(`[baseline] native/canvaskit parity report: ${options.output}`);
