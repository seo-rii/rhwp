import fs from 'node:fs';
import path from 'node:path';

import {
  captureCanvasScreenshot,
  closeBrowser,
  closePage,
  createPage,
  launchBrowser,
  loadApp,
  loadHwpFile,
} from './helpers.mjs';

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
      return `?renderer=canvaskit&canvaskitMode=compat&renderProfile=${encodeURIComponent(profile)}`;
    },
    filenameForProfile(profile) {
      return `canvaskit-compat-${profile}.png`;
    },
  },
  {
    key: 'canvaskit-default',
    queryForProfile(profile) {
      return `?renderer=canvaskit&canvaskitMode=default&renderProfile=${encodeURIComponent(profile)}`;
    },
    filenameForProfile(profile) {
      return `canvaskit-default-${profile}.png`;
    },
  },
];
const ALLOWED_PROFILES = new Set(['screen', 'print', 'high-quality', 'fast-preview']);

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    manifest: '',
    output: '',
    filter: '',
    profiles: 'screen,fast-preview',
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
  return (manifest.samples ?? []).map((sample) => ({
    id: sample.id || path.basename(sample.file, path.extname(sample.file)),
    file: sample.file,
    category: sample.category || 'uncategorized',
    page: sample.page ?? 0,
  })).filter((sample) => {
    if (!filter) {
      return true;
    }
    return filter.test(sample.id) || filter.test(sample.file) || filter.test(sample.category);
  });
}

const options = parseArgs();
const manifest = JSON.parse(fs.readFileSync(options.manifest, 'utf8'));
const samples = normalizeSamples(manifest, options.filter);
const profiles = parseProfiles(options.profiles);

if (samples.length === 0) {
  throw new Error('manifest filter removed every sample');
}

fs.mkdirSync(options.output, { recursive: true });

const results = [];
const browser = await launchBrowser();
const page = await createPage(browser, 1280, 900);

try {
  for (const sample of samples) {
    if (sample.page !== 0) {
      throw new Error(
        `browser baseline currently supports only page=0 samples: ${sample.id} requested page=${sample.page}`,
      );
    }

    console.log(`\n[baseline] ${sample.id} (${sample.category})`);

    for (const profile of profiles) {
      for (const backend of BACKENDS) {
        await loadApp(page, backend.queryForProfile(profile));
        await loadHwpFile(page, sample.file);

        const sampleDir = path.join(options.output, sample.id);
        const outputPath = path.join(sampleDir, backend.filenameForProfile(profile));
        await captureCanvasScreenshot(page, outputPath, `Baseline ${backend.key} (${profile})`);
        results.push({
          sampleId: sample.id,
          file: sample.file,
          category: sample.category,
          backend: backend.key,
          profile,
          path: outputPath,
        });
      }
    }
  }
} finally {
  await closePage(page).catch(() => {});
  await closeBrowser(browser).catch(() => {});
}

const reportPath = path.join(options.output, 'browser-baseline-report.json');
fs.writeFileSync(
  reportPath,
  JSON.stringify(
    {
      manifest: options.manifest,
      sampleCount: samples.length,
      profiles,
      results,
    },
    null,
    2,
  ),
);
console.log(`\n[baseline] browser report: ${reportPath}`);
