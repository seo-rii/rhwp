import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const studioRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(studioRoot, '..');
const canvas2dPath = path.join(studioRoot, 'src/view/canvas2d-layer-renderer.ts');
const canvaskitPath = path.join(studioRoot, 'src/view/canvaskit-renderer.ts');
const canvaskitDirectory = path.join(studioRoot, 'src/view/canvaskit');
const canvaskitFontsPath = path.join(canvaskitDirectory, 'fonts.ts');
const canvaskitResourceCachePath = path.join(canvaskitDirectory, 'resource-cache.ts');
const glyphOutlinePayloadStatusPath = path.join(studioRoot, 'src/view/glyph-outline-payload-status.ts');
const glyphOutlineColorGraphUtilsPath = path.join(studioRoot, 'src/view/glyph-outline-color-graph-utils.ts');
const imageEffectPixelsPath = path.join(studioRoot, 'src/view/image-effect-pixels.ts');
const layerGeometryUtilsPath = path.join(studioRoot, 'src/view/layer-geometry-utils.ts');
const formReplayUtilsPath = path.join(studioRoot, 'src/view/form-replay-utils.ts');
const staticSvgPathLayersPath = path.join(studioRoot, 'src/view/static-svg-path-layers.ts');
const textReplayUtilsPath = path.join(studioRoot, 'src/view/text-replay-utils.ts');
const textVariantsPath = path.join(studioRoot, 'src/core/text-variants.ts');
const layerTypesPath = path.join(studioRoot, 'src/core/types.ts');
const layerCanvasUtilsPath = path.join(studioRoot, 'src/view/layer-canvas-utils.ts');
const canvaskitParityPlanDocPath = path.join(repoRoot, 'docs/canvaskit-parity-implementation.md');
const textIrV2DocPath = path.join(repoRoot, 'docs/text-ir-v2.md');
const rendererBaselinePath = path.join(studioRoot, 'e2e/renderer-baseline.mjs');
const rendererBaselineNativeDiffPath = path.join(studioRoot, 'e2e/renderer-baseline-native-diff.mjs');
const rendererBaselineDriverPath = path.join(repoRoot, 'scripts/renderer_baseline.py');
const rendererBaselineManifestPath = path.join(repoRoot, 'scripts/renderer_baseline_manifest.json');

const canvas2dSource = fs.readFileSync(canvas2dPath, 'utf8');
const canvaskitSource = fs.readFileSync(canvaskitPath, 'utf8');
const canvaskitFontsSource = fs.readFileSync(canvaskitFontsPath, 'utf8');
const canvaskitResourceCacheSource = fs.readFileSync(canvaskitResourceCachePath, 'utf8');
const glyphOutlinePayloadStatusSource = fs.readFileSync(glyphOutlinePayloadStatusPath, 'utf8');
const glyphOutlineColorGraphUtilsSource = fs.readFileSync(glyphOutlineColorGraphUtilsPath, 'utf8');
const imageEffectPixelsSource = fs.readFileSync(imageEffectPixelsPath, 'utf8');
const layerGeometryUtilsSource = fs.readFileSync(layerGeometryUtilsPath, 'utf8');
const formReplayUtilsSource = fs.readFileSync(formReplayUtilsPath, 'utf8');
const staticSvgPathLayersSource = fs.readFileSync(staticSvgPathLayersPath, 'utf8');
const textReplayUtilsSource = fs.readFileSync(textReplayUtilsPath, 'utf8');
const textVariantsSource = fs.readFileSync(textVariantsPath, 'utf8');
const layerTypesSource = fs.readFileSync(layerTypesPath, 'utf8');
const layerCanvasUtilsSource = fs.readFileSync(layerCanvasUtilsPath, 'utf8');
const textIrV2DocSource = fs.readFileSync(textIrV2DocPath, 'utf8');
const normalizedTextIrV2DocSource = textIrV2DocSource.replace(/\s+/g, ' ');
const rendererBaselineSource = fs.readFileSync(rendererBaselinePath, 'utf8');
const rendererBaselineNativeDiffSource = fs.readFileSync(rendererBaselineNativeDiffPath, 'utf8');
const rendererBaselineDriverSource = fs.readFileSync(rendererBaselineDriverPath, 'utf8');
const rendererBaselineManifest = JSON.parse(fs.readFileSync(rendererBaselineManifestPath, 'utf8'));

function tsFilesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return tsFilesUnder(entryPath);
      }
      return entry.name.endsWith('.ts') ? [entryPath] : [];
    })
    .sort();
}

const canvaskitSourceFiles = [
  { label: path.relative(studioRoot, canvaskitPath), source: canvaskitSource },
  ...tsFilesUnder(canvaskitDirectory).map((filePath) => ({
    label: path.relative(studioRoot, filePath),
    source: fs.readFileSync(filePath, 'utf8'),
  })),
  { label: path.relative(studioRoot, glyphOutlinePayloadStatusPath), source: glyphOutlinePayloadStatusSource },
  { label: path.relative(studioRoot, glyphOutlineColorGraphUtilsPath), source: glyphOutlineColorGraphUtilsSource },
  { label: path.relative(studioRoot, imageEffectPixelsPath), source: imageEffectPixelsSource },
  { label: path.relative(studioRoot, layerGeometryUtilsPath), source: layerGeometryUtilsSource },
  { label: path.relative(studioRoot, formReplayUtilsPath), source: formReplayUtilsSource },
  { label: path.relative(studioRoot, staticSvgPathLayersPath), source: staticSvgPathLayersSource },
  { label: path.relative(studioRoot, textReplayUtilsPath), source: textReplayUtilsSource },
];
const forbiddenCanvas2dApiPatterns = [
  [/document\s*\.\s*createElement\b/, 'document.createElement'],
  [/\.getContext\s*\(/, 'HTMLCanvasElement.getContext'],
  [/\bCanvasRenderingContext2D\b/, 'CanvasRenderingContext2D'],
  [/\bPath2D\b/, 'Path2D'],
  [/\.measureText\s*\(/, 'CanvasRenderingContext2D.measureText'],
  [/\bOffscreenCanvas\b/, 'OffscreenCanvas'],
  [/\bImageData\b/, 'ImageData'],
  [/\bcreateImageBitmap\s*\(/, 'createImageBitmap'],
  [/\bImageBitmap\b/, 'ImageBitmap'],
  [/\bHTMLImageElement\b/, 'HTMLImageElement'],
  [/\bnew\s+Image\s*\(/, 'new Image'],
  [/\bDOMParser\b/, 'DOMParser'],
  [/\bXMLSerializer\b/, 'XMLSerializer'],
  [/\bURL\s*\.\s*createObjectURL\s*\(/, 'URL.createObjectURL'],
  [/\bFileReader\b/, 'FileReader'],
  [/\bCanvas2DLayerRenderer\b/, 'Canvas2DLayerRenderer'],
  [/canvas2d-layer-renderer/, 'canvas2d-layer-renderer import'],
];
const implementationPlanTouchpoints = [
  {
    docToken: 'src/paint/text_v2.rs',
    filePath: path.join(repoRoot, 'src/paint/text_v2.rs'),
    kind: 'file',
  },
  {
    docToken: 'rhwp-studio/src/core/text-variants.ts',
    filePath: textVariantsPath,
    kind: 'file',
  },
  {
    docToken: 'rhwp-studio/src/view/glyph-outline-payload-status.ts',
    filePath: path.join(studioRoot, 'src/view/glyph-outline-payload-status.ts'),
    kind: 'file',
  },
  {
    docToken: 'rhwp-studio/src/view/canvaskit-renderer.ts',
    filePath: canvaskitPath,
    kind: 'file',
  },
  {
    docToken: 'rhwp-studio/src/view/canvaskit/*',
    filePath: canvaskitDirectory,
    kind: 'directory',
  },
  {
    docToken: 'rhwp-studio/src/view/canvas2d-layer-renderer.ts',
    filePath: canvas2dPath,
    kind: 'file',
  },
  {
    docToken: 'rhwp-studio/e2e/renderer-contract.test.mjs',
    filePath: fileURLToPath(import.meta.url),
    kind: 'file',
  },
  {
    docToken: 'rhwp-studio/e2e/renderer-lifecycle.test.mjs',
    filePath: path.join(studioRoot, 'e2e/renderer-lifecycle.test.mjs'),
    kind: 'file',
  },
  {
    docToken: 'docs/canvaskit-parity-implementation.md',
    filePath: canvaskitParityPlanDocPath,
    kind: 'file',
  },
];
const directReplayPlanTokens = [
  'dispatches only to CanvasKit primitives',
  'must not call into the Canvas2D renderer at runtime',
  'no DOM clip or overlay layer',
  'no `HTMLImageElement`, object URL, or DOM decode dependency',
  'no raw SVG-in-font or DOM/SVG overlay replay',
  'Surface choice is orthogonal to feature semantics',
  'WebGPU, WebGL, or software surfaces',
  'compatibility fallback or strictVisual hard reject policy',
];
const requiredDirectReplayForbiddenApis = [
  'CanvasRenderingContext2D',
  'Path2D',
  'HTMLImageElement',
  'new Image',
  'DOMParser',
  'URL.createObjectURL',
  'Canvas2DLayerRenderer',
  'canvas2d-layer-renderer import',
];

function extractBlockBody(source, signatureIndex, blockName) {
  let bodyStart = -1;
  for (let index = signatureIndex; index < source.length; index += 1) {
    if (source[index] !== '{') {
      continue;
    }
    if (/^\s*\n/.test(source.slice(index + 1, index + 8))) {
      bodyStart = index;
      break;
    }
  }
  assert.notEqual(bodyStart, -1, `missing body for ${blockName}`);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(bodyStart + 1, index);
      }
    }
  }

  throw new Error(`unterminated body for ${blockName}`);
}

function extractMethodBody(source, methodName) {
  let signatureIndex = source.indexOf(`private ${methodName}(`);
  if (signatureIndex === -1) {
    signatureIndex = source.indexOf(`${methodName}(`);
  }
  assert.notEqual(signatureIndex, -1, `missing method ${methodName}`);

  return extractBlockBody(source, signatureIndex, methodName);
}

function extractFunctionBody(source, functionName) {
  let signatureIndex = source.indexOf(`export function ${functionName}(`);
  if (signatureIndex === -1) {
    signatureIndex = source.indexOf(`function ${functionName}(`);
  }
  assert.notEqual(signatureIndex, -1, `missing function ${functionName}`);

  return extractBlockBody(source, signatureIndex, functionName);
}

function importBlockFrom(source, specifier) {
  const blocks = source.match(/^import[\s\S]*?;$/gm) ?? [];
  return blocks.find((block) => block.includes(`from '${specifier}'`)) ?? '';
}

function extractSwitchCaseBlock(methodBody, caseLabel) {
  const casePattern = new RegExp(`^\\s*case '${caseLabel}':`, 'm');
  const caseMatch = methodBody.match(casePattern);
  assert.notEqual(caseMatch, null, `missing switch case ${caseLabel}`);

  const startIndex = caseMatch.index;
  const nextCasePattern = /^(\s*)(case\s+'[^']+':|default:)/gm;
  nextCasePattern.lastIndex = startIndex + caseMatch[0].length;
  for (let match = nextCasePattern.exec(methodBody); match !== null; match = nextCasePattern.exec(methodBody)) {
    return methodBody.slice(startIndex, match.index);
  }

  return methodBody.slice(startIndex);
}

function caseLabels(methodBody) {
  return [...methodBody.matchAll(/case\s+'([^']+)'/g)].map((match) => match[1]);
}

function stringEqualityLiterals(body, variablePattern) {
  const pattern = new RegExp(`\\b${variablePattern}\\s*===\\s*'([^']+)'`, 'g');
  return [...body.matchAll(pattern)].map((match) => match[1]);
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function compareCaseContract(methodName, contractName) {
  compareCaseLabels(
    caseLabels(extractMethodBody(canvas2dSource, methodName)),
    caseLabels(extractMethodBody(canvaskitSource, methodName)),
    contractName,
  );
}

function compareCaseLabels(canvas2dLabels, canvaskitLabels, contractName) {
  const canvas2dCases = new Set(canvas2dLabels);
  const canvaskitCases = new Set(canvaskitLabels);
  const missingInCanvasKit = [...canvas2dCases]
    .filter((label) => !canvaskitCases.has(label))
    .sort();
  const extraInCanvasKit = [...canvaskitCases]
    .filter((label) => !canvas2dCases.has(label))
    .sort();

  assert.deepEqual(
    { missingInCanvasKit, extraInCanvasKit },
    { missingInCanvasKit: [], extraInCanvasKit: [] },
    `${contractName} case labels must stay aligned between Canvas2D and CanvasKit`,
  );
}

function assertTokensInOrder(source, tokens, message) {
  let cursor = -1;
  for (const token of tokens) {
    const next = source.indexOf(token, cursor + 1);
    assert.notEqual(next, -1, `${message}: missing ${token}`);
    assert(
      next > cursor,
      `${message}: ${token} must appear after previous token`,
    );
    cursor = next;
  }
}

compareCaseContract('renderNode', 'LayerNode dispatch');
compareCaseContract('renderOp', 'LayerPaintOp dispatch');
compareCaseContract('renderFormObject', 'form object replay');
assert.equal(
  formReplayUtilsSource.includes('export function formObjectPalette('),
  true,
  'form object replay palette must live in a shared native-ready helper',
);
assert.equal(
  canvaskitSource.includes('private formPalette(')
    || canvas2dSource.includes('const backColor = op.backColor'),
  false,
  'Canvas2D and CanvasKit must not carry separate form object palette copies',
);
assert.equal(
  importBlockFrom(canvas2dSource, './form-replay-utils').includes('formObjectPalette')
    && importBlockFrom(canvaskitSource, './form-replay-utils').includes('formObjectPalette'),
  true,
  'Canvas2D and CanvasKit must import the shared form object palette helper',
);
compareCaseContract('renderLine', 'line style replay');
assert.equal(
  layerGeometryUtilsSource.includes('export function arrowHeadShape('),
  true,
  'arrowhead geometry must live in shared native-ready geometry helpers',
);
assert.equal(
  canvas2dSource.includes('const alongX = -directionX')
    || canvaskitSource.includes('const alongX = -directionX'),
  false,
  'Canvas2D and CanvasKit must not carry separate arrowhead geometry copies',
);
assert.equal(
  importBlockFrom(canvas2dSource, './layer-geometry-utils').includes('arrowHeadShape')
    && importBlockFrom(canvaskitSource, './layer-geometry-utils').includes('arrowHeadShape'),
  true,
  'Canvas2D and CanvasKit must import the shared arrowhead geometry helper',
);
assert(
  extractFunctionBody(canvas2dSource, 'drawCanvasArrowHead').includes('arrowHeadShape(')
    && extractFunctionBody(canvaskitSource, 'drawArrowHead').includes('arrowHeadShape('),
  'Canvas2D and CanvasKit arrowhead replay must share geometry calculation',
);
assert.equal(
  layerGeometryUtilsSource.includes('export function resolveImagePlacement('),
  true,
  'image fill placement must live in shared native-ready geometry helpers',
);
assert.equal(
  canvas2dSource.includes('private resolveImagePlacement(')
    || canvaskitSource.includes('private resolveImagePlacement('),
  false,
  'Canvas2D and CanvasKit must not carry separate image placement copies',
);
assert.equal(
  importBlockFrom(canvas2dSource, './layer-geometry-utils').includes('resolveImagePlacement')
    && importBlockFrom(canvaskitSource, './layer-geometry-utils').includes('resolveImagePlacement'),
  true,
  'Canvas2D and CanvasKit must import the shared image placement helper',
);
assert.deepEqual(
  uniqueSorted(stringEqualityLiterals(extractMethodBody(canvas2dSource, 'drawDomImage'), 'fillMode')),
  uniqueSorted(stringEqualityLiterals(extractMethodBody(canvaskitSource, 'drawEncodedImage'), 'fillMode')),
  'image fill-mode replay branches must stay aligned between Canvas2D and CanvasKit',
);
const imageCropBaselineSample = rendererBaselineManifest.samples.find((sample) => sample.id === 'image-crop');
const paragraphBaselineSample = rendererBaselineManifest.samples.find((sample) => sample.id === 'paragraph-basic');
const baselineSampleIds = new Set(rendererBaselineManifest.samples.map((sample) => sample.id));
const baselineCategories = new Set(rendererBaselineManifest.samples.map((sample) => sample.category));
for (const sample of rendererBaselineManifest.samples) {
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'samples', sample.file)),
    true,
    `renderer baseline manifest sample must exist: ${sample.file}`,
  );
}
assert.equal(
  imageCropBaselineSample?.browserParityThresholds?.maxDiffRatio,
  0.0065,
  'image-crop baseline budget must stay aligned with the renderer sweep pic-crop-01 budget',
);
assert.equal(
  paragraphBaselineSample?.browserParityThresholds?.maxDiffRatio,
  null,
  'text-heavy baseline samples must be able to use raster-only budgets instead of tolerant pixel budgets',
);
assert.equal(
  paragraphBaselineSample?.browserParityThresholds?.inkMaskNeighborhoodRadius,
  3,
  'text-heavy baseline samples must keep the native text raster neighborhood budget',
);
for (const sampleId of [
  'paragraph-line-basic',
  'paragraph-basic',
  'paragraph-mixed-style',
  'paragraph-spacing',
  'paragraph-multisize',
  'paragraph-indent',
  'text-align-left',
  'text-align-left-empty',
  'text-align-center',
  'text-align-right',
  'text-align-justify',
  'text-mixed-koen',
  'text-hangul-only',
  'text-hangul-only-empty',
  'text-space-count',
  'text-space-count-empty',
  'text-latin-only',
  'text-latin-only-empty',
  'text-punctuation',
  'text-digit-only',
  'text-mixed-malgun-times',
  'eng-words-batang-empty',
  'eng-nospace-dotum-times-empty',
  'mixed-0tr-empty',
  'multisize-10-20-empty',
  'shift-return',
  'font-batang-hancom',
  'font-batangche-hancom',
  'font-gulim-hancom',
  'font-gulimche-hancom',
  'font-malgun-hancom',
  'font-malgun-empty',
  'font-dotum-hancom',
  'font-dotumche-hancom',
  'table-core',
  'table-core-m',
  'table-core-saved',
  'table-simple',
  'table-complex',
  'complex-table-hwpers',
  'table-in-textbox',
  'table-vpos',
  'table-inner',
  'table-border-style',
  'multi-table-001',
  'multi-table-002',
  'table-ipc',
  'image-crop',
  'image-in-table',
  'image-object',
  'image-start',
  'tac-image',
  'equation-inline',
  'field-core',
  'field-memo',
  'footnote',
  'endnote',
  'hwpctl-api',
  'hwpctl-action-table',
  'hwpctl-parameterset-item',
  'tac-case-001',
  'tac-case-002',
  'tac-case-003',
  'tac-case-004',
  'tac-case-005',
  'header-image',
  'header-image-alt',
  'shape-object',
  'group-box',
  'shape-group',
  'draw-group',
  'form-controls',
  'blog-form-book-review',
  'hwpx-form-controls',
  'hwpx-basic-01',
  'hwpx-basic-02',
  'hwpx-ref-text',
  'hwpx-ref-table',
  'hwpx-table-vpos',
  'hwpx-tac-image',
  'exam-kor',
  'exam-eng',
  'exam-math',
  'exam-math-no',
  'exam-science',
  'exam-social',
  'h-pen-01',
  'legacy-doc-2010',
  'legacy-hwpml-30',
  'aift-doc',
  'loading-fail-01',
  'multi-section-doc',
  'multi-section-doc-2',
  'real-nikorean-plan-2022',
  'real-k-water-rfp',
  'real-kps-ai',
  'real-return-school-form',
  'real-finance-stat-2014',
  'finance-stat-2010',
  'finance-stat-2011',
  'promo-doc',
  'promo-doc-no',
  'promo-doc-honbo-save',
  'promo-doc-original',
  'pr-149-regression',
  'task-001',
  'business-doc',
]) {
  assert.equal(
    baselineSampleIds.has(sampleId),
    true,
    `renderer baseline manifest must keep existing representative sample '${sampleId}'`,
  );
}
for (const watchSample of ['hwpspec.hwp']) {
  assert.equal(
    rendererBaselineManifest.samples.some((sample) => sample.file === watchSample),
    false,
    `renderer baseline manifest must not include '${watchSample}' until its CanvasKit selected diff is understood`,
  );
}
for (const category of [
  'paragraph',
  'font',
  'table',
  'image',
  'equation',
  'field',
  'footnote',
  'endnote',
  'control',
  'header-footer',
  'shape',
  'group-drawing',
  'form',
  'hwpx',
  'exam',
  'mixed-document',
]) {
  assert.equal(
    baselineCategories.has(category),
    true,
    `renderer baseline manifest must keep existing representative category '${category}'`,
  );
}
assert(
  extractFunctionBody(rendererBaselineSource, 'normalizeSamples').includes('...sample'),
  'browser baseline sample normalization must preserve manifest extension fields such as browserParityThresholds',
);
assert(
  extractFunctionBody(rendererBaselineSource, 'browserParityThresholdsForSample').includes('browserParityThresholds')
    && extractFunctionBody(rendererBaselineSource, 'browserParityThresholdsForSample').includes('DEFAULT_BROWSER_PARITY_THRESHOLDS'),
  'browser baseline comparisons must merge sample-specific threshold overrides with the default browser parity budget',
);
assert(
  extractFunctionBody(rendererBaselineSource, 'browserParityThresholdsForSample').includes('value === null'),
  'browser baseline threshold overrides must preserve null to disable the tolerant pixel budget for raster-only samples',
);
assert(
  rendererBaselineSource.includes('browserBackendSummaryByCategory')
    && rendererBaselineSource.includes('summaryByCategory')
    && rendererBaselineSource.includes('category: sample.category'),
  'browser baseline report must summarize Canvas2D/CanvasKit parity by existing corpus category',
);
assert(
  rendererBaselineNativeDiffSource.includes("summarizeBy(comparisons, 'category')")
    && rendererBaselineNativeDiffSource.includes('summaryByCategory')
    && rendererBaselineNativeDiffSource.includes('browserCategoryBySample'),
  'native-vs-CanvasKit parity report must preserve browser corpus category summaries',
);
assert(
  rendererBaselineNativeDiffSource.includes('MAX_CAPTURE_SIZE_DRIFT_PX')
    && rendererBaselineNativeDiffSource.includes('sizeNormalization')
    && rendererBaselineNativeDiffSource.includes('cropToCommonTopLeft'),
  'native-vs-CanvasKit parity report must normalize small native/browser capture size drift explicitly',
);
assert(
  rendererBaselineDriverSource.includes('### Category Summary')
    && rendererBaselineDriverSource.includes('summaryByCategory')
    && rendererBaselineDriverSource.includes('| Sample | Category |'),
  'renderer baseline markdown report must expose category summaries and category columns',
);
assert(
  rendererBaselineDriverSource.includes('canvaskitSurfaceDiagnostics')
    && rendererBaselineDriverSource.includes('CanvasKit Surface Diagnostics Summary')
    && rendererBaselineDriverSource.includes('softwareFallbacksTotal')
    && rendererBaselineDriverSource.includes('webgpuFailuresTotal')
    && rendererBaselineDriverSource.includes('webglFailuresTotal'),
  'renderer baseline report must summarize CanvasKit surface selection and fallback diagnostics',
);
assert(
  rendererBaselineDriverSource.includes('webgpuFailureExamples')
    && rendererBaselineDriverSource.includes('webglFailureExamples')
    && rendererBaselineDriverSource.includes('softwareFailureExamples')
    && rendererBaselineDriverSource.includes('WebGPU Failures Seen')
    && rendererBaselineDriverSource.includes('WebGL Failures Seen'),
  'renderer baseline report must preserve per-surface CanvasKit failure reasons',
);
assert(
  extractMethodBody(canvas2dSource, 'renderImage').includes('effectiveLayerImageBounds(op.bbox, op.transform)')
    && extractMethodBody(canvaskitSource, 'renderImage').includes('effectiveLayerImageBounds(op.bbox, op.transform)'),
  'Canvas2D and CanvasKit image replay must share rotated image effective bbox correction',
);
compareCaseLabels(
  caseLabels(extractFunctionBody(canvas2dSource, 'appendPathCommands')),
  caseLabels(extractMethodBody(canvaskitSource, 'makePath')),
  'path command replay',
);
assert.equal(
  layerGeometryUtilsSource.includes('export function strokeDashPattern('),
  true,
  'line dash replay must live in shared native-ready geometry helpers',
);
assert.equal(
  canvas2dSource.includes('function strokeDashPattern(')
    || canvaskitSource.includes('strokeDashPattern(dash: string, width: number)'),
  false,
  'Canvas2D and CanvasKit must not carry separate line dash pattern copies',
);
assert.equal(
  importBlockFrom(canvas2dSource, './layer-geometry-utils').includes('strokeDashPattern')
    && importBlockFrom(canvaskitSource, './layer-geometry-utils').includes('strokeDashPattern'),
  true,
  'Canvas2D and CanvasKit must import the shared line dash pattern helper',
);
assert(
  extractMethodBody(canvas2dSource, 'makeGradientStyle').includes('gradientColorStops(')
    && extractMethodBody(canvaskitSource, 'makeGradientShader').includes('gradientColorStops('),
  'Canvas2D and CanvasKit gradient replay must share stop normalization',
);
assertTokensInOrder(
  extractMethodBody(canvas2dSource, 'makeShapeFillStyle'),
  ['if (gradient)', 'if (pattern)', 'if (!fillColor)'],
  'Canvas2D shape fill precedence must stay gradient, pattern, then solid color',
);
assertTokensInOrder(
  extractMethodBody(canvaskitSource, 'makeShapeFillPaint'),
  ['gradient ? this.makeGradientShader', 'pattern ? this.makePatternShader', 'if (!shader && !fillColor)'],
  'CanvasKit shape fill precedence must stay gradient, pattern, then solid color',
);
assert(
  extractMethodBody(canvas2dSource, 'makeGradientStyle').includes('gradient.gradientType === 2 || gradient.gradientType === 3 || gradient.gradientType === 4')
    && extractMethodBody(canvaskitSource, 'makeGradientShader').includes('gradient.gradientType === 2 || gradient.gradientType === 3 || gradient.gradientType === 4'),
  'Canvas2D and CanvasKit radial gradient type mapping must stay aligned',
);
assert(
  extractMethodBody(canvas2dSource, 'makeGradientStyle').includes('angleToCanvasCoords(')
    && extractMethodBody(canvaskitSource, 'makeGradientShader').includes('angleToCanvasCoords('),
  'Canvas2D and CanvasKit linear gradient coordinates must use the same helper',
);
compareCaseLabels(
  caseLabels(extractFunctionBody(layerCanvasUtilsSource, 'renderEquationLayoutBox')),
  caseLabels(extractMethodBody(canvaskitSource, 'renderEquationBox')),
  'equation layout replay',
);
assert(
  extractMethodBody(canvas2dSource, 'renderEquationSvgResource').includes('parseStaticSvgPathLayers(fragment)')
    && extractMethodBody(canvaskitSource, 'renderEquationSvgResource').includes('parseStaticSvgPathLayers(fragment)')
    && extractMethodBody(canvas2dSource, 'renderEquationSvgResource').includes('parseStaticSvgTextLayers(fragment)')
    && extractMethodBody(canvaskitSource, 'renderEquationSvgResource').includes('parseStaticSvgTextLayers(fragment)'),
  'Canvas2D and CanvasKit equation SVG resource replay must use the same static path/text parser',
);
assert(
  extractSwitchCaseBlock(extractMethodBody(canvas2dSource, 'renderOp'), 'equation')
    .includes('this.renderEquationSvgResource(ctx, op)')
    && extractMethodBody(canvaskitSource, 'renderEquation')
      .includes('this.renderEquationSvgResource(canvas, op)'),
  'Canvas2D and CanvasKit equation replay must prefer direct SVG resources before layout fallback',
);

for (const { docToken, filePath, kind } of implementationPlanTouchpoints) {
  assert.equal(
    textIrV2DocSource.includes(docToken),
    true,
    `CanvasKit implementation plan must mention ${docToken}`,
  );
  const stat = fs.statSync(filePath);
  assert.equal(
    kind === 'directory' ? stat.isDirectory() : stat.isFile(),
    true,
    `CanvasKit implementation plan touchpoint must resolve to ${kind}: ${docToken}`,
  );
}

for (const docToken of directReplayPlanTokens) {
  assert.equal(
    normalizedTextIrV2DocSource.includes(docToken.replace(/\s+/g, ' ')),
    true,
    `CanvasKit direct replay plan must keep explicit contract text: ${docToken}`,
  );
}

for (const apiName of requiredDirectReplayForbiddenApis) {
  assert.equal(
    forbiddenCanvas2dApiPatterns.some(([, forbiddenApiName]) => forbiddenApiName === apiName),
    true,
    `CanvasKit direct replay dependency guard must forbid ${apiName}`,
  );
}

assert.equal(
  canvaskitSource.includes('parseStaticSvgPathLayers(fragment)'),
  true,
  'CanvasKit SvgGlyph replay must use the DOM-free static parser contract',
);
assert.equal(
  canvaskitSource.includes("from './static-svg-path-layers'"),
  true,
  'CanvasKit SvgGlyph replay must import the native-ready static SVG parser',
);
const strictBitmapGlyphContractBlock = extractFunctionBody(textVariantsSource, 'hasStrictBitmapGlyphContract');
const bitmapGlyphScalingPolicyContractBlock = extractFunctionBody(textVariantsSource, 'isSupportedBitmapScalingPolicy');
const bitmapGlyphFilteringContractBlock = extractFunctionBody(textVariantsSource, 'isSupportedBitmapFiltering');
const textRunPlacementContractBlock = extractFunctionBody(textVariantsSource, 'isValidTextRunPlacement');
for (const requiredToken of [
  "payload.payloadKind === 'bitmapGlyph'",
  'payload.colorLayers === undefined',
  'payload.svgGlyph === undefined',
  'isValidResourceId(bitmapGlyph.imageResourceId)',
  'isValidPayloadRange(bitmapGlyph.sourceRangeUtf8)',
  'isNonEmptyPayloadRange(bitmapGlyph.glyphRange)',
  'isValidTextRunPlacement(bitmapGlyph.placement)',
  '(bitmapGlyph.transformToRun === undefined || isFiniteAffineTransform(bitmapGlyph.transformToRun))',
  'isValidBitmapStrikePpem(bitmapGlyph.strikePpem)',
  "bitmapGlyph.strikeSelection === 'producerResolved'",
  'bitmapGlyph.colorSpace === undefined',
  'isSupportedBitmapAlphaMode(bitmapGlyph.alphaMode)',
  'isSupportedBitmapScalingPolicy(bitmapGlyph.scalingPolicy)',
  'isSupportedBitmapFiltering(bitmapGlyph.filtering)',
]) {
  assert.equal(
    strictBitmapGlyphContractBlock.includes(requiredToken),
    true,
    `BitmapGlyph strict payload contract must keep guard: ${requiredToken}`,
  );
}
for (const [label, helperBlock] of [
  ['scalingPolicy', bitmapGlyphScalingPolicyContractBlock],
  ['filtering', bitmapGlyphFilteringContractBlock],
]) {
  assert.equal(
    helperBlock.includes("'backendDefault'"),
    false,
    `BitmapGlyph strict ${label} contract must reject backendDefault`,
  );
}
assert.equal(
  textRunPlacementContractBlock.includes('Number.isFinite(placement.baselineY)'),
  true,
  'strict glyph payload placement must require finite baselineY',
);
const staticSvgGlyphContractBlock = extractFunctionBody(textVariantsSource, 'hasStaticSanitizedSvgGlyphContract');
for (const requiredToken of [
  "payload.payloadKind === 'svgGlyph'",
  'payload.colorLayers === undefined',
  'payload.bitmapGlyph === undefined',
  '!hasRawInlineSvgGlyphReplayField(svgGlyph)',
  'isValidResourceId(svgGlyph.vectorResourceId)',
  'isValidPayloadRange(svgGlyph.sourceRangeUtf8)',
  'isNonEmptyPayloadRange(svgGlyph.glyphRange)',
  'isValidTextRunPlacement(svgGlyph.placement)',
  '(svgGlyph.transformToRun === undefined || isFiniteAffineTransform(svgGlyph.transformToRun))',
  'viewBox !== undefined',
  'viewBox.width > 0',
  'viewBox.height > 0',
  'svgGlyph.intrinsicSize === undefined',
  'Number.isFinite(svgGlyph.intrinsicSize.width)',
  'svgGlyph.intrinsicSize.width > 0',
  "svgGlyph.securityMode === 'staticSanitized'",
  'svgGlyph.scriptAllowed === false',
  'svgGlyph.animationAllowed === false',
  'svgGlyph.externalResourcesAllowed === false',
  'svgGlyph.interactivityAllowed === false',
]) {
  assert.equal(
    staticSvgGlyphContractBlock.includes(requiredToken),
    true,
    `SvgGlyph static sanitized payload contract must keep guard: ${requiredToken}`,
  );
}
for (const rawInlineField of ['rawSvg', 'inlineSvg', 'svgText', 'svgFragment', 'svg', 'fragment', 'markup']) {
  assert.equal(
    textVariantsSource.includes(`'${rawInlineField}'`),
    true,
    `SvgGlyph static sanitized payload contract must reject raw inline field: ${rawInlineField}`,
  );
}
assert.equal(
  extractMethodBody(canvaskitSource, 'renderBitmapGlyphOutline').includes('hasStrictBitmapGlyphContract(op)'),
  true,
  'CanvasKit BitmapGlyph replay must call the shared strict payload gate before drawing',
);
const canvaskitBitmapGlyphReplayBlock = extractMethodBody(canvaskitSource, 'renderBitmapGlyphOutline');
for (const requiredToken of [
  'canvas.drawImageRectOptions(',
  "payload.filtering === 'nearest' ? this.canvasKit.FilterMode.Nearest : this.canvasKit.FilterMode.Linear",
  'this.canvasKit.MipmapMode.None',
]) {
  assert.equal(
    canvaskitBitmapGlyphReplayBlock.includes(requiredToken),
    true,
    `CanvasKit BitmapGlyph replay must keep deterministic image-strike sampling guard: ${requiredToken}`,
  );
}
assert.equal(
  extractMethodBody(canvaskitSource, 'renderSvgGlyphOutline').includes('hasStaticSanitizedSvgGlyphContract(op)'),
  true,
  'CanvasKit SvgGlyph replay must call the shared static sanitized payload gate before drawing',
);
for (const [label, source] of [
  ['canvaskit renderer', canvaskitSource],
  ['glyph outline payload status', glyphOutlinePayloadStatusSource],
  ['static SVG parser', staticSvgPathLayersSource],
]) {
  assert.equal(
    source.includes('allowDomParser'),
    false,
    `CanvasKit static SVG parser path must not expose DOM parser toggles: ${label}`,
  );
}
assert.equal(
  canvaskitResourceCacheSource.includes("from '../layer-canvas-utils'"),
  false,
  'CanvasKit resource cache must use native-ready image/font helpers instead of broad Canvas2D utilities',
);
assert.equal(
  canvaskitResourceCacheSource.includes('imageResourcePayloadFingerprint'),
  true,
  'CanvasKit resource cache must fingerprint resource bytes when producer image hashes are unavailable',
);
assert.equal(
  canvaskitResourceCacheSource.includes("?? 'unknown'"),
  false,
  'CanvasKit resource cache must not collapse missing resource hashes into a shared unknown cache key',
);
assert.equal(
  fs.readFileSync(path.join(canvaskitDirectory, 'static-picture-cache.ts'), 'utf8')
    .includes('stableValueFingerprint(tree.resources ?? null)'),
  true,
  'CanvasKit static picture cache keys must include resource payload fingerprints for image and vector glyph resources',
);
assert.equal(
  fs.readFileSync(path.join(canvaskitDirectory, 'static-picture-cache.ts'), 'utf8')
    .includes('stableValueFingerprint(tree.fontResources ?? null)'),
  true,
  'CanvasKit static picture cache keys must include font resource fingerprints for strict text replay',
);
assert.equal(
  fs.readFileSync(path.join(canvaskitDirectory, 'static-picture-cache.ts'), 'utf8')
    .includes('stableValueFingerprint(tree.variantOps ?? null)'),
  true,
  'CanvasKit static picture cache keys must include schema-v1 variantOps sidecar payloads',
);
assert.equal(
  fs.readFileSync(path.join(canvaskitDirectory, 'static-picture-cache.ts'), 'utf8')
    .includes('stableValueFingerprint(tree.outputOptions ?? null)'),
  true,
  'CanvasKit static picture cache keys must include output options that affect direct replay',
);
const staticPictureCacheSource = fs.readFileSync(path.join(canvaskitDirectory, 'static-picture-cache.ts'), 'utf8');
for (const requiredToken of [
  'ArrayBuffer.isView(item)',
  'view.byteOffset',
  'view.byteLength',
  "appendString(`bytes:${bytes.length}:`)",
]) {
  assert.equal(
    staticPictureCacheSource.includes(requiredToken),
    true,
    `CanvasKit static picture cache fingerprint must include typed-array payload bytes: ${requiredToken}`,
  );
}
assert.equal(
  canvaskitFontsSource.includes("from '../layer-canvas-utils'"),
  false,
  'CanvasKit font registry must use native-ready image/font helpers instead of broad Canvas2D utilities',
);
const canvaskitGlyphRunReplayStatusBlock = extractMethodBody(canvaskitFontsSource, 'glyphRunReplayStatus');
assertTokensInOrder(
  canvaskitGlyphRunReplayStatusBlock,
  [
    'for (const glyphId of run.glyphIds)',
    'glyphId > 0xffff',
    "return this.glyphRunReplayFailure(run, 'glyphIdOutOfRange')",
    'if (run.shapeKey.fontInstance.variations?.length)',
    "return this.glyphRunReplayFailure(run, 'variationUnsupported'",
    'const faceKey = run.shapeKey.fontInstance.faceKey',
    'if (face.faceIndex !== 0)',
    "return this.glyphRunReplayFailure(run, 'faceIndexUnsupported'",
    "return this.glyphRunReplayFailure(run, 'fontBlobNotPortable'",
  ],
  'CanvasKit GlyphRun replay must keep range, variation, and face-index gates before portable replay',
);
for (const requiredToken of [
  'variationSupported: false',
  'faceIndexSupported: false',
  'exactFaceInstantiated: false',
]) {
  assert.equal(
    canvaskitGlyphRunReplayStatusBlock.includes(requiredToken),
    true,
    `CanvasKit GlyphRun fallback diagnostics must keep ${requiredToken}`,
  );
}
assert.equal(
  canvaskitSource.includes('this.surfaceCache.replaceWithSoftware(targetCanvas)'),
  true,
  'CanvasKit GPU render failures must fall back to a CanvasKit software surface, not a Canvas2D overlay',
);
assertTokensInOrder(
  extractMethodBody(canvaskitSource, 'renderPage'),
  [
    'const fallbackSurface = this.surfaceCache.replaceWithSoftware(targetCanvas)',
    'this.textVariantSelectionDiagnostics.length = 0',
    'this.renderSurface(fallbackSurface, tree, scale)',
  ],
  'CanvasKit software fallback rerender must replace failed-attempt text variant diagnostics',
);
assert.equal(
  canvaskitResourceCacheSource.includes('Canvas2DLayerRenderer')
    || fs.readFileSync(path.join(canvaskitDirectory, 'surface-cache.ts'), 'utf8').includes('Canvas2DLayerRenderer'),
  false,
  'CanvasKit caches and surface fallback must not instantiate the Canvas2D renderer',
);
assert.equal(
  fs.readFileSync(path.join(canvaskitDirectory, 'surface-cache.ts'), 'utf8')
    .includes('MakeSWCanvasSurface(targetCanvas)'),
  true,
  'CanvasKit software fallback must use CanvasKit MakeSWCanvasSurface',
);
const canvaskitLayerCanvasUtilsImportBody = importBlockFrom(
  canvaskitSource,
  './layer-canvas-utils',
).match(/\{([\s\S]*?)\}/)?.[1] ?? '';
assert.deepEqual(
  [...canvaskitLayerCanvasUtilsImportBody.matchAll(/\b([A-Za-z][A-Za-z0-9_]*)\b/g)]
    .map((match) => match[1])
    .filter((token) => token !== 'type'),
  [],
  'CanvasKit renderer must not import broad layer-canvas-utils helpers',
);
assert.equal(
  canvaskitLayerCanvasUtilsImportBody.includes('resolveLayerImageCropSource'),
  false,
  'CanvasKit renderer must import image crop helpers from native-ready image helpers',
);
assert.equal(
  canvaskitLayerCanvasUtilsImportBody.includes('canPreprocessCroppedLayerImageEffect'),
  false,
  'CanvasKit renderer must import image effect gating helpers from native-ready image helpers',
);
assert.equal(
  canvaskitSource.includes("from './image-effect-pixels'"),
  true,
  'CanvasKit renderer must import shared image helpers from the native-ready module',
);
for (const textHelperName of [
  'allowsTextControlMark',
  'charOverlapInnerSizeRatio',
  'decodePuaOverlapNumber',
  'estimateDisplayTextPositions',
  'isHalfwidthScaledCluster',
  'mapPuaDisplayText',
  'puaToDisplayText',
  'splitIntoClusters',
  'startsWithInvalidControl',
  'textDecorationEmphasisMark',
  'textDecorationEmphasisPosition',
  'textDecorationEmphasisSize',
  'textDecorationLineY',
]) {
  assert.equal(
    canvaskitLayerCanvasUtilsImportBody.includes(textHelperName),
    false,
    `CanvasKit renderer must import ${textHelperName} from native-ready text helpers`,
  );
}
assert(
  layerCanvasUtilsSource.includes('charOverlapInnerSizeRatio(op.charOverlap.innerCharSize)')
    && canvaskitSource.includes('charOverlapInnerSizeRatio(op.charOverlap.innerCharSize)'),
  'Canvas2D and CanvasKit char overlap replay must share inner size ratio interpretation',
);
assert(
  layerCanvasUtilsSource.includes('ctx.ellipse(cx, cy, rx, ry')
    && canvaskitSource.includes('canvas.drawOval(oval'),
  'Canvas2D and CanvasKit char overlap circle replay must use Hancom-compatible ellipse geometry',
);
assert(
  !layerCanvasUtilsSource.includes('op.bbox.width / chars.length')
    && !canvaskitSource.includes('op.bbox.width / chars.length'),
  'Canvas2D and CanvasKit must not spread multi-component CharOverlap payloads across the bbox',
);
assert(
  canvaskitSource.includes('op.image.effect')
    && canvas2dSource.includes("op.image.effect ?? 'realPic'"),
  'Canvas2D and CanvasKit page background image replay must consume layer image effect metadata',
);
assert(
  /export interface LayerImageOp[\s\S]*externalPath\?: string/.test(layerTypesSource),
  'Studio LayerImageOp schema must expose Rust-emitted externalPath diagnostics for linked images',
);
assert(
  /clipKind: 'body' \| 'tableCell' \| 'textBox' \| 'generic'/.test(layerTypesSource),
  'Studio LayerClipNode schema must expose textBox clips emitted by the layer builder',
);
assert.equal(
  canvaskitSource.includes("from './text-replay-utils'"),
  true,
  'CanvasKit renderer must import shared text replay helpers from the native-ready module',
);
assert.equal(
  textReplayUtilsSource.includes('export function tabLeaderDashStyle('),
  true,
  'tab leader fillType mapping must live in shared native-ready text helpers',
);
assert.equal(
  canvas2dSource.includes('leader.fillType === 2')
    || canvaskitSource.includes('leader.fillType === 2'),
  false,
  'Canvas2D and CanvasKit must not carry separate tab leader fillType mappings',
);
assert.equal(
  importBlockFrom(canvas2dSource, './text-replay-utils').includes('tabLeaderDashStyle')
    && importBlockFrom(canvaskitSource, './text-replay-utils').includes('tabLeaderDashStyle'),
  true,
  'Canvas2D and CanvasKit must import the shared tab leader dash helper',
);
assert(
  extractMethodBody(canvas2dSource, 'drawTabLeaders').includes('strokeDashPattern(tabLeaderDashStyle(leader.fillType), 1)')
    && extractMethodBody(canvaskitSource, 'drawTabLeaders').includes('tabLeaderDashStyle(leader.fillType)'),
  'Canvas2D and CanvasKit tab leader replay must share fillType-to-dash mapping',
);
assert.equal(
  textReplayUtilsSource.includes('export function textDecorationEmphasisMark(')
    && textReplayUtilsSource.includes('export function textDecorationEmphasisPosition(')
    && textReplayUtilsSource.includes('export function textDecorationEmphasisSize(')
    && textReplayUtilsSource.includes('export function textDecorationLineY('),
  true,
  'text decoration visual policy must live in shared native-ready text helpers',
);
assert.equal(
  canvas2dSource.includes("emphasisDot === 3 ? 'ˇ'")
    || canvaskitSource.includes("emphasisDot === 3 ? 'ˇ'"),
  false,
  'Canvas2D and CanvasKit must not carry separate emphasis mark character maps',
);
assert.equal(
  importBlockFrom(canvas2dSource, './text-replay-utils').includes('textDecorationEmphasisMark')
    && importBlockFrom(canvas2dSource, './text-replay-utils').includes('textDecorationEmphasisPosition')
    && importBlockFrom(canvas2dSource, './text-replay-utils').includes('textDecorationEmphasisSize')
    && importBlockFrom(canvas2dSource, './text-replay-utils').includes('textDecorationLineY')
    && importBlockFrom(canvaskitSource, './text-replay-utils').includes('textDecorationEmphasisMark')
    && importBlockFrom(canvaskitSource, './text-replay-utils').includes('textDecorationEmphasisPosition')
    && importBlockFrom(canvaskitSource, './text-replay-utils').includes('textDecorationEmphasisSize')
    && importBlockFrom(canvaskitSource, './text-replay-utils').includes('textDecorationLineY'),
  true,
  'Canvas2D and CanvasKit must import the shared text decoration helpers',
);
assert(
  extractMethodBody(canvas2dSource, 'renderTextDecoration').includes('textDecorationEmphasisPosition(')
    && extractMethodBody(canvaskitSource, 'renderTextDecoration').includes('textDecorationEmphasisPosition('),
  'Canvas2D and CanvasKit text decoration replay must share emphasis mark positioning',
);
assert(
  extractMethodBody(canvas2dSource, 'renderTextRun').includes('textDecorationLineY(')
    && extractMethodBody(canvaskitSource, 'renderTextRun').includes('textDecorationLineY(')
    && extractMethodBody(canvas2dSource, 'renderTextDecoration').includes('textDecorationLineY(')
    && extractMethodBody(canvaskitSource, 'renderTextDecoration').includes('textDecorationLineY('),
  'Canvas2D and CanvasKit text decoration replay must share underline/strike positioning',
);
for (const geometryHelperName of [
  'angleToCanvasCoords',
  'arrowHeadShape',
  'calculateArrowDimensions',
  'computePathPaintBounds',
  'effectiveLayerImageBounds',
  'resolveImagePlacement',
]) {
  assert.equal(
    canvaskitLayerCanvasUtilsImportBody.includes(geometryHelperName),
    false,
    `CanvasKit renderer must import ${geometryHelperName} from native-ready geometry helpers`,
  );
}
assert.equal(
  canvaskitSource.includes("from './layer-geometry-utils'"),
  true,
  'CanvasKit renderer must import shared geometry helpers from the native-ready module',
);

assert.equal(
  canvas2dSource.includes('layerTextVariantOpsForLeaf(node.ops, this.lastRenderedTree?.variantOps)'),
  true,
  'Canvas2D leaf replay must merge schema-v1 sidecar variantOps into text variant selection',
);
assert.equal(
  canvaskitSource.includes('layerTextVariantOpsForLeaf(node.ops, this.lastRenderedTree?.variantOps)'),
  true,
  'CanvasKit leaf replay must merge schema-v1 sidecar variantOps into text variant selection',
);
const sidecarTextVariantMergeBlock = extractFunctionBody(textVariantsSource, 'layerTextVariantOpsForLeaf');
for (const requiredToken of [
  'variantOps',
  'sidecarsByAnchor',
  'sidecarAnchorOpId(sidecar)',
  'rootVariantKeys.has(sidecarKey)',
  'merged.push(...sidecars.sort(compareVariantPaintOrder))',
]) {
  assert.equal(
    sidecarTextVariantMergeBlock.includes(requiredToken),
    true,
    `shared text variant helper must keep sidecar variantOps contract: ${requiredToken}`,
  );
}

const canvas2dGlyphOutlineReplayBlock = extractSwitchCaseBlock(
  extractMethodBody(canvas2dSource, 'renderOp'),
  'glyphOutline',
);
const canvaskitGlyphOutlineReplayBlock = extractMethodBody(canvaskitSource, 'renderGlyphOutline');
assert.deepEqual(
  stringEqualityLiterals(canvas2dGlyphOutlineReplayBlock, 'payloadKind'),
  stringEqualityLiterals(canvaskitGlyphOutlineReplayBlock, 'payloadKind'),
  'glyph outline payload kind replay branches must stay aligned between Canvas2D and CanvasKit',
);
assert.equal(
  textVariantsSource.includes('export function isFillOnlyGlyphOutlineStyle('),
  true,
  'GlyphOutline strict paint-style eligibility must live in shared text variant policy',
);
assert.equal(
  canvas2dSource.includes('function isFillOnlyGlyphOutlineStyle(')
    || canvaskitSource.includes('function isFillOnlyGlyphOutlineStyle('),
  false,
  'Canvas2D and CanvasKit must not carry separate GlyphOutline paint-style eligibility copies',
);
assert.equal(
  importBlockFrom(canvas2dSource, '@/core/text-variants').includes('isFillOnlyGlyphOutlineStyle')
    && importBlockFrom(canvaskitSource, '@/core/text-variants').includes('isFillOnlyGlyphOutlineStyle'),
  true,
  'Canvas2D and CanvasKit must import the shared GlyphOutline paint-style eligibility helper',
);
assert.deepEqual(
  stringEqualityLiterals(canvas2dGlyphOutlineReplayBlock, 'colorFormat'),
  stringEqualityLiterals(canvaskitGlyphOutlineReplayBlock, 'colorFormat'),
  'glyph outline color format replay branches must stay aligned between Canvas2D and CanvasKit',
);
assert.deepEqual(
  stringEqualityLiterals(canvas2dGlyphOutlineReplayBlock, 'node\\.kind'),
  stringEqualityLiterals(canvaskitGlyphOutlineReplayBlock, 'node\\.kind'),
  'glyph outline COLRv1 graph node replay branches must stay aligned between Canvas2D and CanvasKit',
);
assert.equal(
  glyphOutlineColorGraphUtilsSource.includes('export function replayColorPaintGraph('),
  true,
  'COLRv1 color paint graph traversal must live in a shared native-ready helper',
);
for (const requiredToken of [
  'const nodesById = new Map(graph.nodes.map((node) => [node.nodeId, node]));',
  'const renderNode = (nodeId: number, stack: Set<number>): void => {',
  'if (stack.has(nodeId))',
  "node.kind === 'solidPath'",
  'callbacks.renderSolidPath(node.solidPath)',
  "node.kind === 'linearGradientPath'",
  'callbacks.renderLinearGradientPath(node.linearGradientPath)',
  "node.kind === 'radialGradientPath'",
  'callbacks.renderRadialGradientPath(node.radialGradientPath)',
  "node.kind === 'sweepGradientPath'",
  'callbacks.renderSweepGradientPath(node.sweepGradientPath)',
  "node.kind === 'transform'",
  'callbacks.withTransform(node.transform.transform',
  "node.kind === 'composite'",
  'callbacks.renderComposite(',
  "node.kind === 'clip'",
  'callbacks.withClip(node.clip',
  'renderNode(graph.rootNodeId, new Set())',
]) {
  assert.equal(
    glyphOutlineColorGraphUtilsSource.includes(requiredToken),
    true,
    `COLRv1 shared graph replay helper must keep traversal guard: ${requiredToken}`,
  );
}
assert.equal(
  glyphOutlineColorGraphUtilsSource.includes('export function resolvedColorToCss(')
    && glyphOutlineColorGraphUtilsSource.includes('export function resolvedColorUnitRgba('),
  true,
  'GlyphOutline resolved color conversion must live in shared native-ready helpers',
);
assert.equal(
  canvas2dSource.includes('const nodesById = new Map(graph.nodes.map')
    || canvaskitSource.includes('const nodesById = new Map(graph.nodes.map'),
  false,
  'Canvas2D and CanvasKit must not carry separate COLRv1 graph traversal copies',
);
assert.equal(
  importBlockFrom(canvas2dSource, './glyph-outline-color-graph-utils').includes('replayColorPaintGraph')
    && importBlockFrom(canvaskitSource, './glyph-outline-color-graph-utils').includes('replayColorPaintGraph'),
  true,
  'Canvas2D and CanvasKit must import the shared COLRv1 graph traversal helper',
);
assert(
  canvas2dGlyphOutlineReplayBlock.includes('replayColorPaintGraph(graph')
    && canvaskitGlyphOutlineReplayBlock.includes('replayColorPaintGraph(graph'),
  'Canvas2D and CanvasKit COLRv1 replay must share graph traversal',
);
const colrv0ColorLayersContractBlock = extractFunctionBody(textVariantsSource, 'hasColrv0ColorLayersContract');
for (const requiredToken of [
  "payload.payloadKind === 'colorLayers'",
  "colorLayers?.colorFormat === 'colrV0'",
  'colorLayers.paintGraph === undefined',
  'isValidPayloadRange(colorLayers.sourceRangeUtf8)',
  'isNonEmptyPayloadRange(colorLayers.glyphRange)',
  'colorLayers.layers.length > 0',
  'isValidResolvedColor(layer.fill)',
  'isValidPayloadIndex(layer.paletteIndex)',
]) {
  assert.equal(
    colrv0ColorLayersContractBlock.includes(requiredToken),
    true,
    `COLRv0 resolved-layer payload contract must keep guard: ${requiredToken}`,
  );
}
const colrv1ColorGraphContractBlock = extractFunctionBody(textVariantsSource, 'hasColrv1Stage1ColorGraphContract');
for (const requiredToken of [
  "payload.payloadKind !== 'colorLayers'",
  "colorLayers?.colorFormat !== 'colrV1'",
  'colorLayers.layers.length !== 0',
  'graph.nodes.length > MAX_COLRV1_STAGE1_GRAPH_NODES',
  'nodeIds.has(node.nodeId)',
  '!nodeIds.has(graph.rootNodeId)',
  "node.kind === 'solidPath'",
  "node.kind === 'linearGradientPath'",
  "node.kind === 'radialGradientPath'",
  "node.kind === 'sweepGradientPath'",
  'isSupportedSweepGradientAngleRange(',
  'isValidColorGradientStops(',
  "node.kind === 'transform'",
  'node.transform.childNodeId !== node.nodeId',
  "node.kind === 'composite'",
  "node.composite.mode === 'sourceOver'",
  'node.composite.sourceNodeId !== node.composite.backdropNodeId',
  "node.kind === 'clip'",
  'isValidPathCommands(node.clip.clipCommands)',
  'depth > MAX_COLRV1_STAGE1_GRAPH_DEPTH',
  'visiting.has(nodeId)',
  'visited.size === graph.nodes.length',
]) {
  assert.equal(
    colrv1ColorGraphContractBlock.includes(requiredToken),
    true,
    `COLRv1 normalized graph payload contract must keep guard: ${requiredToken}`,
  );
}
assert.equal(
  canvas2dSource.includes('function resolvedColorToCss(')
    || canvaskitGlyphOutlineReplayBlock.includes('clampCanvasKitUnit('),
  false,
  'Canvas2D and CanvasKit must not carry separate GlyphOutline resolved color conversion copies',
);
assert.equal(
  importBlockFrom(canvas2dSource, './glyph-outline-color-graph-utils').includes('resolvedColorToCss')
    && importBlockFrom(canvaskitSource, './glyph-outline-color-graph-utils').includes('resolvedColorUnitRgba'),
  true,
  'Canvas2D and CanvasKit must import shared GlyphOutline resolved color helpers',
);

for (const { label, source } of canvaskitSourceFiles) {
  for (const [pattern, apiName] of forbiddenCanvas2dApiPatterns) {
    assert.equal(
      pattern.test(source),
      false,
      `CanvasKit renderer source must not depend on ${apiName}: ${label}`,
    );
  }
}

console.log('renderer backend contract parity passed');
