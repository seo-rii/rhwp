import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyCanvasKitPageRuntimeConditions,
  classifyCanvasKitVariantAlignment,
} from './runtime-condition-alignment.mjs';

const studioRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(studioRoot, '..');
const packageJsonPath = path.join(studioRoot, 'package.json');
const canvas2dPath = path.join(studioRoot, 'src/view/canvas2d-layer-renderer.ts');
const canvaskitPath = path.join(studioRoot, 'src/view/canvaskit-renderer.ts');
const pageRendererPath = path.join(studioRoot, 'src/view/page-renderer.ts');
const canvaskitDirectory = path.join(studioRoot, 'src/view/canvaskit');
const canvaskitFontsPath = path.join(canvaskitDirectory, 'fonts.ts');
const canvaskitSfntFacePath = path.join(canvaskitDirectory, 'sfnt-face.ts');
const fontLoaderPath = path.join(studioRoot, 'src/core/font-loader.ts');
const canvaskitReplayPlanePath = path.join(canvaskitDirectory, 'replay-plane.ts');
const canvaskitResourceCachePath = path.join(canvaskitDirectory, 'resource-cache.ts');
const canvaskitEncodedImageAdmissionPath = path.join(
  canvaskitDirectory,
  'encoded-image-admission.ts',
);
const canvaskitStaticPictureCachePath = path.join(canvaskitDirectory, 'static-picture-cache.ts');
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
const canvaskitRenderTestPath = path.join(studioRoot, 'e2e/canvaskit-render.test.mjs');
const rendererBaselinePath = path.join(studioRoot, 'e2e/renderer-baseline.mjs');
const rendererBaselineShardingPath = path.join(
  studioRoot,
  'e2e/renderer-baseline-sharding.mjs',
);
const rendererBaselineNativeDiffPath = path.join(studioRoot, 'e2e/renderer-baseline-native-diff.mjs');
const runCiPath = path.join(studioRoot, 'e2e/run-ci.mjs');
const rendererBaselineDriverPath = path.join(repoRoot, 'scripts/renderer_baseline.py');
const rendererBaselineManifestPath = path.join(repoRoot, 'scripts/renderer_baseline_manifest.json');
const rustPaintReplayOrderPath = path.join(repoRoot, 'src/paint/replay_order.rs');
const rustCanvaskitPolicyPath = path.join(repoRoot, 'src/renderer/canvaskit_policy.rs');
const rustSkiaRendererPath = path.join(repoRoot, 'src/renderer/skia/renderer.rs');
const rustSvgRendererPath = path.join(repoRoot, 'src/renderer/svg.rs');

const canvas2dSource = fs.readFileSync(canvas2dPath, 'utf8');
const canvaskitSource = fs.readFileSync(canvaskitPath, 'utf8');
const pageRendererSource = fs.readFileSync(pageRendererPath, 'utf8');
const canvaskitFontsSource = fs.readFileSync(canvaskitFontsPath, 'utf8');
const canvaskitSfntFaceSource = fs.readFileSync(canvaskitSfntFacePath, 'utf8');
const fontLoaderSource = fs.readFileSync(fontLoaderPath, 'utf8');
const canvaskitReplayPlaneSource = fs.readFileSync(canvaskitReplayPlanePath, 'utf8');
const canvaskitResourceCacheSource = fs.readFileSync(canvaskitResourceCachePath, 'utf8');
const canvaskitEncodedImageAdmissionSource = fs.readFileSync(
  canvaskitEncodedImageAdmissionPath,
  'utf8',
);
const staticPictureCacheSource = fs.readFileSync(canvaskitStaticPictureCachePath, 'utf8');
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
const canvaskitRenderTestSource = fs.readFileSync(canvaskitRenderTestPath, 'utf8');
const rendererBaselineSource = fs.readFileSync(rendererBaselinePath, 'utf8');
const rendererBaselineShardingSource = fs.readFileSync(rendererBaselineShardingPath, 'utf8');
const rendererBaselineNativeDiffSource = fs.readFileSync(rendererBaselineNativeDiffPath, 'utf8');
const runCiSource = fs.readFileSync(runCiPath, 'utf8');
const rendererBaselineDriverSource = fs.readFileSync(rendererBaselineDriverPath, 'utf8');
const rendererBaselineManifest = JSON.parse(fs.readFileSync(rendererBaselineManifestPath, 'utf8'));
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const rustPaintReplayOrderSource = fs.readFileSync(rustPaintReplayOrderPath, 'utf8');
const rustCanvaskitPolicySource = fs.readFileSync(rustCanvaskitPolicyPath, 'utf8');
const rustSkiaRendererSource = fs.readFileSync(rustSkiaRendererPath, 'utf8');
const rustSvgRendererSource = fs.readFileSync(rustSvgRendererPath, 'utf8');

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
const canvaskitBrowserDecodeBridgeApis = new Set([
  'HTMLImageElement',
  'new Image',
  'URL.createObjectURL',
]);
const canvaskitBrowserDecodeBridgeFile = 'src/view/canvaskit/resource-cache.ts';
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

function assertRustPlanAndCanvaskitRuntimeContract({
  opType,
  rustOp,
  feature,
  runtimeCall,
  methodName,
  methodTokens = [],
}) {
  assert.equal(
    rustCanvaskitPolicySource.includes(`PaintOp::${rustOp}`),
    true,
    `CanvasKit replay plan must classify PaintOp::${rustOp}`,
  );
  assert.equal(
    rustCanvaskitPolicySource.includes(`CanvasKitReplayFeature::${feature}`),
    true,
    `CanvasKit replay plan must expose ${feature} for ${opType}`,
  );
  const runtimeCase = extractSwitchCaseBlock(extractMethodBody(canvaskitSource, 'renderOp'), opType);
  assert.equal(
    runtimeCase.includes(runtimeCall),
    true,
    `CanvasKit runtime renderOp case '${opType}' must dispatch to ${runtimeCall}`,
  );
  if (methodName) {
    const methodBody = extractMethodBody(canvaskitSource, methodName);
    for (const token of methodTokens) {
      assert.equal(
        methodBody.includes(token),
        true,
        `CanvasKit runtime ${methodName} must keep plan-aligned token for ${opType}: ${token}`,
      );
    }
  }
}

for (const requiredToken of [
  'RHWP_E2E_CI_TIMEOUT_MS',
  "defaultSuiteTimeoutMs = process.env.RHWP_RENDER_SAMPLE_SCOPE === 'full'",
  '? 120 * 60 * 1000',
  ': 30 * 60 * 1000',
  'detached: process.platform !== \'win32\'',
  'process.kill(-child.pid, signal)',
  'SIGKILL',
  'e2e suite timed out after',
  'clearTimeout(timeoutId)',
  'registerShutdown(devServer)',
]) {
  assert.equal(
    runCiSource.includes(requiredToken),
    true,
    `studio e2e CI runner must keep timeout/process cleanup guard: ${requiredToken}`,
  );
}
assertTokensInOrder(
  runCiSource,
  [
    'timedOut = true',
    'stopProcess(child)',
    'e2e suite timed out after',
  ],
  'studio e2e CI runner must report suite timeout after stopping the child process tree',
);
for (const requiredToken of [
  'CanvasKit page-scoped diagnostic replay=',
  'renderer.resetImageEffectDiagnostics?.()',
  'pageRenderer.renderPage(0, pageInfo, canvas',
  'getCanvasKitReplayPlanWithProfile?.(',
  'replaySummary?.hiddenOverlayViolations',
  'replaySummary?.directRequiredItems',
  'replaySummary?.unsupportedItems',
  'classifyCanvasKitPageRuntimeConditions(replayPlan',
  'classifyCanvasKitVariantAlignment(',
  'runtimeDiagnostics.images?.failures',
  'runtimeDiagnostics.textReplay?.failures',
  'runtimeDiagnostics.textV2Validation',
]) {
  assert.equal(
    canvaskitRenderTestSource.includes(requiredToken),
    true,
    `CanvasKit corpus sweep must hard-gate replay plan/runtime alignment: ${requiredToken}`,
  );
}

compareCaseContract('renderNode', 'LayerNode dispatch');
compareCaseContract('renderOp', 'LayerPaintOp dispatch');
for (const contract of [
  {
    opType: 'pageBackground',
    rustOp: 'PageBackground',
    feature: 'PageBackground',
    runtimeCall: 'this.renderPageBackground(canvas, op);',
    methodName: 'renderPageBackground',
    methodTokens: [
      'this.makeShapeFillPaint(',
      'this.drawEncodedImage(',
      'op.image.effect',
      'op.image.brightness ?? 0',
      'op.image.contrast ?? 0',
    ],
  },
  {
    opType: 'image',
    rustOp: 'Image',
    feature: 'RasterImage',
    runtimeCall: 'this.renderImage(canvas, op);',
    methodName: 'renderImage',
    methodTokens: [
      'effectiveLayerImageBounds(op.bbox, op.transform)',
      'this.drawEncodedImage(',
      'op.effect',
      'op.brightness ?? 0',
      'op.contrast ?? 0',
    ],
  },
  {
    opType: 'equation',
    rustOp: 'Equation',
    feature: 'Equation',
    runtimeCall: 'this.renderEquation(canvas, op);',
    methodName: 'renderEquation',
    methodTokens: [
      'this.renderEquationSvgResource(canvas, op)',
      'this.renderEquationBox(',
    ],
  },
  {
    opType: 'formObject',
    rustOp: 'FormObject',
    feature: 'FormObject',
    runtimeCall: 'this.renderFormObject(canvas, op);',
    methodName: 'renderFormObject',
    methodTokens: [
      'formObjectPalette(op)',
      "case 'pushButton':",
      "case 'checkBox':",
      "case 'radioButton':",
      "case 'comboBox':",
      "case 'edit':",
    ],
  },
  {
    opType: 'glyphRun',
    rustOp: 'GlyphRun',
    feature: 'TextVariant',
    runtimeCall: 'this.renderGlyphRun(canvas, op);',
    methodName: 'glyphRunVariantReplayStatus',
    methodTokens: [
      'this.fontRegistry.glyphRunReplayStatus(op, this.lastRenderedTree?.fontResources)',
      'fontVerification',
    ],
  },
  {
    opType: 'glyphOutline',
    rustOp: 'GlyphOutline',
    feature: 'TextVariant',
    runtimeCall: 'this.renderGlyphOutline(canvas, op);',
    methodName: 'glyphOutlineVariantReplayStatus',
    methodTokens: [
      'glyphOutlinePayloadStatus(',
      'isFillOnlyGlyphOutlineStyle(op)',
      'outlineEligibility',
    ],
  },
]) {
  assertRustPlanAndCanvaskitRuntimeContract(contract);
}
for (const [opType, rustOp, runtimeCall] of [
  ['charOverlap', 'CharOverlap', 'this.renderTextRun(canvas, op);'],
  ['textControlMark', 'TextControlMark', 'this.renderTextControlMark(canvas, op);'],
  ['tabLeader', 'TabLeader', 'this.renderTabLeader(canvas, op);'],
  ['textDecoration', 'TextDecoration', 'this.renderTextDecoration(canvas, op);'],
  ['footnoteMarker', 'FootnoteMarker', 'this.renderFootnoteMarker(canvas, op);'],
]) {
  assertRustPlanAndCanvaskitRuntimeContract({
    opType,
    rustOp,
    feature: 'TextSpecialVisual',
    runtimeCall,
  });
}
assertTokensInOrder(
  extractFunctionBody(textReplayUtilsSource, 'allowsTextControlMark'),
  [
    "case 'space':",
    "case 'tab':",
    "case 'lineBreakEnd':",
    "case 'table':",
    "case 'picture':",
    "case 'textBox':",
    "case 'equation':",
    "case 'header':",
    "case 'footer':",
    "case 'footnoteArea':",
    'return showControlCodes',
  ],
  'inline and structure control marks must share the control-code visibility gate',
);
for (const kind of ['table', 'picture', 'textBox', 'equation', 'header', 'footer', 'footnoteArea']) {
  assert(
    extractFunctionBody(textReplayUtilsSource, 'isStructureControlMark').includes(`case '${kind}':`),
    `${kind} must be classified as a structure control mark`,
  );
}
assertTokensInOrder(
  canvaskitReplayPlaneSource,
  ["op.type === 'textControlMark'", "op.wrap === 'behindText'", "op.wrap === 'inFrontOfText'"],
  'CanvasKit structure marks must follow their owner wrap replay plane',
);
assert(
  textReplayUtilsSource.includes("export const TEXT_CONTROL_MARK_FONT_FAMILY = 'D2Coding';"),
  'control marks must use the checked-in symbol font with all emitted mark glyphs',
);
for (const [label, source] of [
  ['Canvas2D', canvas2dSource],
  ['CanvasKit', canvaskitSource],
]) {
  assert(
    extractMethodBody(source, 'renderTextControlMark').includes('allowsTextControlMark('),
    `${label} standalone control marks must use the shared visibility policy`,
  );
  assert(
    extractMethodBody(source, 'renderTextControlMark').includes('TEXT_CONTROL_MARK_FONT_FAMILY'),
    `${label} standalone control marks must use the shared symbol font`,
  );
  assert(
    extractMethodBody(source, 'renderTextControlMark').includes('isStructureControlMark('),
    `${label} standalone structure marks must use the shared structure color policy`,
  );
  assert(
    extractMethodBody(source, 'renderTextRun').includes('TEXT_CONTROL_MARK_FONT_FAMILY'),
    `${label} inline control marks must use the shared symbol font`,
  );
  for (const method of ['renderTextControlMark', 'renderTabLeader']) {
    const body = extractMethodBody(source, method);
    assert(
      body.includes('op.rotation') && body.includes('.rotate('),
      `${label} ${method} must preserve the owner TextRun rotation`,
    );
  }
}
for (const [opType, rustOp, runtimeCall] of [
  ['line', 'Line', 'this.renderLine(canvas, op);'],
  ['rectangle', 'Rectangle', 'this.renderRectangle(canvas, op);'],
  ['ellipse', 'Ellipse', 'this.renderEllipse(canvas, op);'],
  ['path', 'Path', 'this.renderPath(canvas, op);'],
]) {
  assertRustPlanAndCanvaskitRuntimeContract({
    opType,
    rustOp,
    feature: 'VectorShape',
    runtimeCall,
  });
}
for (const [label, source, drawArrowCall] of [
  ['Canvas2D', canvas2dSource, 'drawCanvasArrowHead('],
  ['CanvasKit', canvaskitSource, 'drawArrowHead('],
]) {
  const renderPath = extractMethodBody(source, 'renderPath');
  assertTokensInOrder(
    renderPath,
    [
      'if (op.lineStyle && op.connectorEndpoints)',
      'for (const command of op.commands.slice(1))',
      "command.type === 'lineTo'",
      "command.type === 'curveTo'",
      'command.x1',
      'calculateArrowDimensions(',
      drawArrowCall,
      'const points:',
      'command.x2',
      'command.x3',
      'for (let index = points.length - 1',
      'calculateArrowDimensions(',
      drawArrowCall,
    ],
    `${label} path connector arrows must derive both endpoint directions from path tangents`,
  );
}
assertTokensInOrder(
  rustCanvaskitPolicySource,
  [
    'PaintOp::PageBackground { background, .. } =>',
    'page_background_item(path, background, &self.tree.resources)',
    'fn page_background_item(',
    '.image_bytes(image.resource_id)',
    '.map_or(CanvasKitImageAdmission::Missing, image_admission)',
    'CanvasKitImageAdmission::HeaderAdmitted(runtime_condition)',
    'direct_item_with_detail(',
    'item.add_runtime_condition(runtime_condition)',
    'if image_effect_requires_preprocess(image.effect, image.brightness, image.contrast)',
    'CanvasKitReplayRuntimeCondition::CanvasKitImageEffectPreprocess',
    'CanvasKitImageAdmission::Missing | CanvasKitImageAdmission::StaticRejected',
    'direct_required_item_with_detail(',
  ],
  'CanvasKit replay plan must expose decode and effect prerequisites for admitted page background images',
);
assertTokensInOrder(
  rustCanvaskitPolicySource,
  [
    'PaintOp::Image { image, .. } => image_item(path, image, &self.tree.resources)',
    'fn image_item(',
    'resources.image_bytes(resource_id)',
    '.map_or(CanvasKitImageAdmission::Missing, image_admission)',
    'CanvasKitImageAdmission::HeaderAdmitted(runtime_condition)',
    'direct_item_with_detail(path, "image", CanvasKitReplayFeature::RasterImage, detail)',
    'item.add_runtime_condition(runtime_condition)',
    'if image_effect_requires_preprocess(image.effect, image.brightness, image.contrast)',
    'CanvasKitReplayRuntimeCondition::CanvasKitImageEffectPreprocess',
    'CanvasKitImageAdmission::Missing | CanvasKitImageAdmission::StaticRejected',
    'direct_required_item_with_detail(',
  ],
  'CanvasKit replay plan must expose decode and effect prerequisites for admitted images',
);
assertTokensInOrder(
  rustCanvaskitPolicySource,
  [
    'if let Some(runtime_condition) = self.runtime_conditions.first()',
    'out.push_str(",\\"runtimeCondition\\":")',
    'if !self.runtime_conditions.is_empty()',
    'out.push_str(",\\"runtimeConditions\\":[")',
  ],
  'CanvasKit replay items must preserve the legacy first condition while exposing every runtime prerequisite',
);
assertTokensInOrder(
  rustCanvaskitPolicySource,
  [
    'fn image_admission(bytes: &[u8])',
    'if !canvaskit_encoded_image_is_replayable(bytes)',
    'CanvasKitImageAdmission::StaticRejected',
    'CanvasKitReplayRuntimeCondition::BrowserSvgImageDecode',
    'CanvasKitReplayRuntimeCondition::CanvasKitEncodedImageDecode',
    'CanvasKitImageAdmission::HeaderAdmitted(runtime_condition)',
    'fn canvaskit_encoded_image_is_replayable(bytes: &[u8])',
    'CANVASKIT_MAX_ENCODED_IMAGE_BASE64_BYTES',
    'canvaskit_encoded_image_header(bytes)',
    'header.is_within_decode_limits()',
  ],
  'CanvasKit replay plan must bound static image admission and expose the remaining decoder condition',
);
assert(
  rustCanvaskitPolicySource.includes(
    'CanvasKitReplayRuntimeCondition::CanvasKitTypefaceConstruction',
  )
    && rustCanvaskitPolicySource.includes(
      'Some(CanvasKitReplayRuntimeCondition::CanvasKitTypefaceConstruction)',
    ),
  'CanvasKit replay plan must expose browser typeface construction as a GlyphRun runtime condition',
);
assertTokensInOrder(
  rustCanvaskitPolicySource,
  [
    'for (id, bytes) in resources.font_blob_resources()',
    'crate::paint::font_blob_resource_key(bytes.len(), &digest)',
    'VariantRejectReason::FontBlobNotVerified',
    'VariantRejectReason::FontDigestMismatch',
    'blob_resolved: Some(true)',
    'digest_matched: Some(true)',
    'exact_face_instantiated: None',
  ],
  'CanvasKit replay plan must verify portable font resource identity before runtime typeface construction',
);
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
const pageScaleBmpBaselineSample = rendererBaselineManifest.samples.find(
  (sample) => sample.id === 'image-page-scale-bmp',
);
const paragraphBaselineSample = rendererBaselineManifest.samples.find((sample) => sample.id === 'paragraph-basic');
const paragraphMarksBaselineSample = rendererBaselineManifest.samples.find(
  (sample) => sample.id === 'paragraph-text-marks',
);
const puaBaselineSample = rendererBaselineManifest.samples.find(
  (sample) => sample.id === 'pua-special-glyphs',
);
const hwpxTabLeadersBaselineSample = rendererBaselineManifest.samples.find(
  (sample) => sample.id === 'hwpx-tac-tab-leaders',
);
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
assert.deepEqual(
  pageScaleBmpBaselineSample?.browserParityThresholds,
  { ignoreChannelDelta: 9, maxDiffRatio: 0 },
  'whole-page BMP scaling must keep its narrow raster-only CanvasKit budget',
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
assert.deepEqual(
  paragraphMarksBaselineSample?.viewOptions,
  { showParagraphMarks: true, showControlCodes: false },
  'paragraph-mark parity must be captured through explicit document view options',
);
assert.equal(
  puaBaselineSample?.file,
  'pua-test.hwp',
  'PUA parity must keep the checked-in original-glyph regression document',
);
assert.equal(
  puaBaselineSample?.page,
  0,
  'PUA parity must capture the original and circled glyph page',
);
assert.equal(
  puaBaselineSample?.category,
  'font',
  'PUA parity must remain part of the representative font corpus',
);
assert.deepEqual(
  puaBaselineSample?.browserParityThresholds,
  {
    maxDiffRatio: null,
    inkMaskNeighborhoodRadius: 3,
    inkMaskMaxDiffRatio: 0.01,
    nonInkMaxDiffPixels: 0,
    solidInkMaxDiffRatio: 0.03,
  },
  'PUA parity must retain its text-raster-only browser budget',
);
assert.equal(
  hwpxTabLeadersBaselineSample?.file,
  'tac-img-02.hwpx',
  'HWPX tab-leader parity must keep the checked-in TAC document',
);
assert.equal(
  hwpxTabLeadersBaselineSample?.page,
  4,
  'HWPX tab-leader parity must capture the real table-of-contents page',
);
for (const sampleId of [
  'paragraph-line-basic',
  'paragraph-basic',
  'paragraph-text-marks',
  'pua-special-glyphs',
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
  'table-diagonal-cell-hwp',
  'table-diagonal-cell-hwpx',
  'multi-table-001',
  'multi-table-002',
  'table-ipc',
  'image-crop',
  'image-page-scale-bmp',
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
  'header-image-page-5',
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
  'hwpx-tac-tab-leaders',
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
  'multi-section-doc-page-4',
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
assert.equal(
  rendererBaselineManifest.samples.some((sample) => Number(sample.page) > 0),
  true,
  'renderer baseline manifest must keep non-zero page coverage',
);
assert.deepEqual(
  rendererBaselineManifest.samples
    .filter((sample) => sample.id.startsWith('table-diagonal-cell-'))
    .map((sample) => sample.file)
    .sort(),
  ['대각선샘플.hwp', '대각선샘플.hwpx'],
  'renderer baseline manifest must keep the paired HWP/HWPX diagonal-cell corpus',
);
assert(
  rendererBaselineSource.includes('pageRenderer.renderPage(capturePageIndex')
    && rendererBaselineSource.includes('pageRenderer?.cancelAll?.()')
    && rendererBaselineSource.includes("canvas.toDataURL('image/png')")
    && rendererBaselineSource.includes('pageRenderer.renderPage(capturePageIndex, pageInfo, canvas, 1.0)')
    && rendererBaselineSource.includes("if (captureBackend === 'canvas2d')")
    && rendererBaselineSource.includes('canvas2dRenderer?.domImageCache')
    && rendererBaselineSource.includes('selectedPageRenderMs')
    && rendererBaselineDriverSource.includes('averageSelectedPageRenderMs')
    && !rendererBaselineSource.includes('setTimeout(resolve, 250)')
    && !rendererBaselineSource.includes('browser baseline currently supports only page=0 samples'),
  'browser baseline must settle async resources and capture scale-1 intrinsic pixels for the requested manifest page',
);
for (const category of [
  'paragraph',
  'positioned-text',
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
  rendererBaselineSource.includes('selectRendererBaselineShard(filteredSamples')
    && rendererBaselineSource.includes('filteredSampleCount: filteredSamples.length')
    && rendererBaselineSource.includes('shard,')
    && rendererBaselineShardingSource.includes("createHash('sha256')")
    && rendererBaselineShardingSource.includes('readBigUInt64BE(0)')
    && rendererBaselineDriverSource.includes('"--shard-index"')
    && rendererBaselineDriverSource.includes('"--shard-count"')
    && rendererBaselineDriverSource.includes('digest[:8]')
    && rendererBaselineDriverSource.includes('byteorder="big"')
    && rendererBaselineDriverSource.includes(
      'native/browser baseline sample selection differs',
    ),
  'native and browser baselines must use and report the same stable no-overlap sample shard',
);
assert(
  extractFunctionBody(rendererBaselineSource, 'normalizeSamples').includes('viewOptions')
    && extractFunctionBody(rendererBaselineSource, 'normalizeSamples').includes('showParagraphMarks')
    && extractFunctionBody(rendererBaselineSource, 'normalizeSamples').includes('showControlCodes')
    && extractFunctionBody(rendererBaselineSource, 'applySampleViewOptions').includes('setShowParagraphMarks')
    && extractFunctionBody(rendererBaselineSource, 'applySampleViewOptions').includes('setShowControlCodes')
    && extractFunctionBody(rendererBaselineSource, 'applySampleViewOptions').includes("emit('document-changed')")
    && rendererBaselineSource.includes('await applySampleViewOptions(page, sample.viewOptions)'),
  'browser baseline must validate and apply document view options before capturing a selected page',
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
  rendererBaselineDriverSource.includes('--include-pdf')
    && rendererBaselineDriverSource.includes('"export-pdf"')
    && rendererBaselineDriverSource.includes('"backend": "pdf"')
    && rendererBaselineDriverSource.includes('PDF baseline export did not create a non-empty artifact'),
  'renderer baseline driver must be able to collect verified PDF artifacts in the native output matrix',
);
assert(
  rendererBaselineDriverSource.includes('def collect_files(')
    && rendererBaselineDriverSource.includes('except ValueError')
    && rendererBaselineDriverSource.includes('str(path)'),
  'renderer baseline driver must support output directories outside the repository root',
);
assert(
  rendererBaselineDriverSource.includes("repo_relative(manifest['_path'])"),
  'renderer baseline report must support manifest files outside the repository root',
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
  extractFunctionBody(rendererBaselineSource, 'readRendererDiagnostics')
    .includes('getCanvasKitReplayPlanWithProfile')
    && extractFunctionBody(rendererBaselineSource, 'readRendererDiagnostics')
      .includes('captureProfile')
    && extractFunctionBody(rendererBaselineSource, 'readRendererDiagnostics').includes('getImageDiagnostics')
    && extractFunctionBody(rendererBaselineSource, 'readRendererDiagnostics').includes('getTextReplayDiagnostics')
    && extractFunctionBody(rendererBaselineSource, 'readRendererDiagnostics').includes('getEquationReplayDiagnostics')
    && extractFunctionBody(rendererBaselineSource, 'readRendererDiagnostics').includes('getPatternDiagnostics')
    && extractFunctionBody(rendererBaselineSource, 'readRendererDiagnostics').includes('getTextVariantSelectionDiagnostics')
    && extractFunctionBody(rendererBaselineSource, 'readRendererDiagnostics').includes('getTextV2ValidationDiagnostics'),
  'browser baseline must capture replay-plan, image, equation, pattern, runtime variant, and v2 validation diagnostics',
);
assert(
  extractFunctionBody(rendererBaselineSource, 'resetRendererDiagnostics')
    .includes('resetEquationReplayDiagnostics')
    && rendererBaselineSource.includes('equationFallbackReplays')
    && rendererBaselineSource.includes('equationRouteReasonCounts'),
  'browser baseline must reset and summarize CanvasKit equation route diagnostics',
);
assert(
  rendererBaselineSource.includes("code: 'replayPlanUnavailable'")
    && rendererBaselineSource.includes("code: 'replayPlanEmpty'")
    && rendererBaselineSource.includes("code: 'replayPlanProfileMismatch'")
    && rendererBaselineSource.includes("code: 'replayPlanContractMismatch'")
    && rendererBaselineSource.includes("code: 'hiddenOverlayViolation'")
    && rendererBaselineSource.includes("code: 'compatOverlayItem'")
    && rendererBaselineSource.includes("code: 'directRequiredItem'")
    && rendererBaselineSource.includes("code: 'runtimeImageReplayFailure'")
    && rendererBaselineSource.includes("code: 'runtimeImageEffectReplayFailure'")
    && rendererBaselineSource.includes("code: 'runtimeTextReplayFailure'")
    && rendererBaselineSource.includes('runtimeFontSubstitutions')
    && rendererBaselineSource.includes('runtimeUnregisteredFontFallbacks')
    && rendererBaselineSource.includes('runtimeFontResolutionSourceCounts')
    && rendererBaselineDriverSource.includes('Font Substitutions')
    && rendererBaselineDriverSource.includes('Unregistered Font Fallbacks')
    && rendererBaselineDriverSource.includes('Font Resolution Sources')
    && rendererBaselineSource.includes("code: 'runtimePatternReplayFailure'")
    && rendererBaselineSource.includes("code: 'textV2ValidationIssue'")
    && rendererBaselineSource.includes("code: 'runtimeVariantSelectionConflict'")
    && rendererBaselineSource.includes("code: 'planRuntimeVariantMismatch'")
    && rendererBaselineSource.includes('...planSelections.keys()')
    && rendererBaselineSource.includes('...runtimeSelections.keys()')
    && rendererBaselineSource.includes('classifyCanvasKitPageRuntimeConditions')
    && rendererBaselineSource.includes('classifyCanvasKitVariantAlignment')
    && rendererBaselineSource.includes("code: 'runtimeConditionUndeclared'")
    && rendererBaselineSource.includes('pageRuntimeConditionAlignments')
    && rendererBaselineSource.includes('runtimeConditionStatusCounts')
    && rendererBaselineSource.includes('runtimeConditionResolutions')
    && rendererBaselineSource.includes('hardSafetyGateAndReportInventory'),
  'browser baseline must hard-gate invalid plans, runtime paint failures, hidden overlays, invalid v2, and bidirectional plan/runtime variant drift while inventorying fallbacks',
);
const pageRuntimeAlignments = classifyCanvasKitPageRuntimeConditions({
  items: [{
    path: 'root/ops/0',
    runtimeCondition: 'canvasKitImageEffectPreprocess',
    runtimeConditions: [
      'canvasKitImageEffectPreprocess',
      'canvasKitPatternImageConstruction',
    ],
  }],
}, {
  imageEffects: {
    canvaskit: {
      cacheHits: 0,
      cacheMisses: 1,
      preprocessFailures: 0,
      fallbackToOriginal: 0,
    },
  },
  patternDiagnostics: {
    cacheHits: 0,
    cacheMisses: 1,
    surfaceFailures: 0,
  },
});
assert.deepEqual(
  pageRuntimeAlignments.map((alignment) => alignment.status),
  ['observed', 'observed'],
  'page-level runtime prerequisites must join replay-plan declarations with CanvasKit attempts',
);
const conditionalBitmapPlan = {
  equivalenceGroup: 'text-0',
  anchorOpId: 'op-text-0',
  selectedVariantId: 'glyphOutline',
  selectedVariantKind: 'glyphOutline',
  selectedRuntimeConditions: ['canvasKitEncodedImageDecode'],
  partsExpected: 1,
  partsReplayed: 1,
};
const decodedBitmapFallback = {
  equivalenceGroup: 'text-0',
  anchorOpId: 'op-text-0',
  selectedVariantId: 'textRun',
  selectedVariantKind: 'textRun',
  selectedReason: 'defaultTextRunFallback',
  partsExpected: 1,
  partsReplayed: 1,
  rejectedVariants: [{
    variantId: 'glyphOutline',
    variantKind: 'glyphOutline',
    details: ['imageDecodeFailed'],
  }],
};
const conditionalBitmapAlignment = classifyCanvasKitVariantAlignment(
  conditionalBitmapPlan,
  decodedBitmapFallback,
);
assert.equal(conditionalBitmapAlignment.aligned, true);
assert.equal(conditionalBitmapAlignment.resolution, 'runtimeFallback');
assert.deepEqual(
  conditionalBitmapAlignment.resolvedRuntimeConditions,
  ['canvasKitEncodedImageDecode'],
);
assert.equal(
  classifyCanvasKitVariantAlignment(
    { ...conditionalBitmapPlan, selectedRuntimeConditions: [] },
    decodedBitmapFallback,
  ).aligned,
  false,
  'an undeclared plan/runtime variant mismatch must remain a hard failure',
);
assert.equal(
  classifyCanvasKitVariantAlignment(
    conditionalBitmapPlan,
    {
      ...decodedBitmapFallback,
      selectedVariantId: 'glyphOutline-v2',
      selectedVariantKind: 'glyphOutline',
      selectedReason: 'noSupportedVariant',
    },
  ).aligned,
  false,
  'a fallback-free or non-TextRun runtime mismatch must remain a hard failure',
);
assert.equal(
  classifyCanvasKitVariantAlignment(
    conditionalBitmapPlan,
    { ...decodedBitmapFallback, rejectedVariants: [] },
  ).aligned,
  false,
  'a runtime condition without its matching observed failure must remain a hard failure',
);
assert.equal(
  classifyCanvasKitVariantAlignment(
    { ...conditionalBitmapPlan, selectedRuntimeConditions: [] },
    {
      ...conditionalBitmapPlan,
      selectedVariantKind: 'glyphRun',
    },
  ).aligned,
  false,
  'matching variant ids with different kinds must remain a hard failure',
);
assert.equal(
  classifyCanvasKitVariantAlignment(
    { ...conditionalBitmapPlan, selectedRuntimeConditions: [] },
    {
      ...conditionalBitmapPlan,
      partsReplayed: 0,
    },
  ).aligned,
  false,
  'an incomplete runtime multipart replay must remain a hard failure',
);
assert(
  rendererBaselineSource.includes('imageDiagnostics.pendingLoads === 0')
    && rendererBaselineSource.includes('pageRenderer.renderPage(capturePageIndex, pageInfo, canvas, 1.0)')
    && rendererBaselineSource.includes('textVariantReportKey(report)'),
  'browser baseline must wait for CanvasKit async image recovery, rerender the capture, and correlate leaf-local variant slots',
);
const conditionalGlyphRunAlignment = classifyCanvasKitVariantAlignment(
  {
    ...conditionalBitmapPlan,
    selectedVariantId: 'glyphRun',
    selectedVariantKind: 'glyphRun',
    selectedRuntimeConditions: ['canvasKitTypefaceConstruction'],
  },
  {
    ...decodedBitmapFallback,
    rejectedVariants: [{
      variantId: 'glyphRun',
      variantKind: 'glyphRun',
      reasons: ['fontFaceInstantiationFailed'],
    }],
  },
);
assert.equal(conditionalGlyphRunAlignment.aligned, true);
assert.deepEqual(
  conditionalGlyphRunAlignment.resolvedRuntimeConditions,
  ['canvasKitTypefaceConstruction'],
);
const conditionalSvgGlyphAlignment = classifyCanvasKitVariantAlignment(
  {
    ...conditionalBitmapPlan,
    selectedRuntimeConditions: ['canvasKitSvgPathConstruction'],
  },
  {
    ...decodedBitmapFallback,
    rejectedVariants: [{
      variantId: 'glyphOutline',
      variantKind: 'glyphOutline',
      reasons: ['unsupportedSvgGlyph'],
      details: ['pathDecodeFailed'],
    }],
  },
);
assert.equal(conditionalSvgGlyphAlignment.aligned, true);
assert.deepEqual(
  conditionalSvgGlyphAlignment.resolvedRuntimeConditions,
  ['canvasKitSvgPathConstruction'],
);
assert(
  rendererBaselineDriverSource.includes('CanvasKit Replay Diagnostics')
    && rendererBaselineDriverSource.includes('Replay Reason Inventory')
    && rendererBaselineDriverSource.includes('planReasonCounts')
    && rendererBaselineDriverSource.includes('rejectedReasonCounts')
    && rendererBaselineDriverSource.includes('runtimeImageRecoveryReasonCounts')
    && rendererBaselineDriverSource.includes('runtimeImageFailureReasonCounts')
    && rendererBaselineDriverSource.includes('runtimeImageEffectReadbackPreprocesses')
    && rendererBaselineDriverSource.includes('runtimePatternDirectImageCreations')
    && rendererBaselineDriverSource.includes('runtimeTextRecoveryReasonCounts')
    && rendererBaselineDriverSource.includes('runtimeTextFailureReasonCounts'),
  'renderer baseline markdown report must expose CanvasKit fallback, runtime paint recovery/failure, and rejection reason inventories',
);
assert(
  packageJson.scripts['e2e:baseline:headless']?.includes('../scripts/renderer_baseline.py')
    && packageJson.scripts['e2e:baseline:headless']?.includes('--skip-native')
    && packageJson.scripts['e2e:baseline:headless']?.includes('--browser-mode headless'),
  'studio baseline npm script must use the driver that starts Vite and supplies manifest/output defaults',
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
  [
    'let shader = gradient ? this.makeGradientShader',
    'if (!shader && pattern)',
    'shader = this.makePatternShader(pattern)',
    'if (!shader && !fillColor)',
  ],
  'CanvasKit shape fill precedence must stay gradient, pattern, then solid color',
);
assert(
  !extractMethodBody(canvas2dSource, 'makeShapeFillStyle').includes('applyCssAlpha(fillColor')
    && !extractMethodBody(canvaskitSource, 'makeShapeFillPaint').includes('opacity * opacity'),
  'Canvas2D and CanvasKit shape fills must apply ShapeStyle opacity exactly once',
);
assert(
  extractMethodBody(canvaskitSource, 'drawShadow')
    .includes('* sourceOpacity')
    && extractMethodBody(canvaskitSource, 'renderRectangle').includes('op.style.opacity')
    && extractMethodBody(canvaskitSource, 'renderEllipse').includes('op.style.opacity')
    && extractMethodBody(canvaskitSource, 'renderPath').includes('op.style.opacity'),
  'CanvasKit shape shadows must compose shadow alpha with the source ShapeStyle opacity',
);
assertTokensInOrder(
  extractMethodBody(canvas2dSource, 'beginRectanglePath'),
  ['Math.min(cornerRadius, bounds.width / 2, bounds.height / 2)', 'ctx.quadraticCurveTo('],
  'Canvas2D rounded rectangles must clamp authored radii to their bounds',
);
assertTokensInOrder(
  extractMethodBody(canvaskitSource, 'renderRectangle'),
  [
    'const radius = Math.min(',
    'op.cornerRadius',
    'op.bbox.width / 2',
    'op.bbox.height / 2',
    'this.canvasKit.RRectXY(rect, radius, radius)',
  ],
  'CanvasKit rounded rectangles must use the same bounded radius as Canvas2D',
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
const canvaskitEquationTextBlock = extractMethodBody(canvaskitSource, 'drawEquationTextAligned');
assert(
  canvaskitEquationTextBlock.includes('const shaped = this.buildShapedSingleLineParagraph(')
    && canvaskitEquationTextBlock.includes('centered ? anchorX - shaped.width / 2 : anchorX')
    && canvaskitEquationTextBlock.includes('y - shaped.alphabeticBaseline')
    && canvaskitEquationTextBlock.includes('canvas.drawParagraph(shaped.paragraph')
    && canvaskitEquationTextBlock.includes('const measuredWidth = glyphWidths.reduce(')
    && canvaskitEquationTextBlock.includes('canvas.drawText(text, x, y, paint, font)')
    && !canvaskitEquationTextBlock.includes('font.setScaleX('),
  'CanvasKit equation text must shape with Paragraph before using the natural-advance direct fallback',
);
const canvaskitEquationBracketBlock = extractMethodBody(canvaskitSource, 'drawEquationBracket');
for (const token of [
  "case '(':",
  "case ')':",
  "case '[':",
  "case ']':",
  "case '{':",
  "case '}':",
  'builder.quadTo(',
  'this.drawEquationStrokePath(canvas, builder, color, fontSize * 0.04)',
]) {
  assert.equal(
    canvaskitEquationBracketBlock.includes(token),
    true,
    `CanvasKit equation stretch brackets must use direct CanvasKit paths: ${token}`,
  );
}
const canvaskitEquationStrokePathBlock =
  extractMethodBody(canvaskitSource, 'drawEquationStrokePath');
assertTokensInOrder(
  canvaskitEquationStrokePathBlock,
  [
    'const path = builder.detach()',
    'builder.delete()',
    'canvas.drawPath(path, paint)',
    'paint.delete()',
    'path.delete()',
  ],
  'CanvasKit equation paths must release builders, paths, and paints after direct replay',
);
const canvaskitEquationSqrtBlock =
  extractSwitchCaseBlock(extractMethodBody(canvaskitSource, 'renderEquationBox'), 'sqrt');
assert(
  canvaskitEquationSqrtBlock.includes('const radical = new this.canvasKit.PathBuilder()')
    && canvaskitEquationSqrtBlock.includes('radical.lineTo(startX, startY)')
    && canvaskitEquationSqrtBlock.includes('radical.lineTo(midX, midY)')
    && canvaskitEquationSqrtBlock.includes('radical.lineTo(bodyLeft, y)')
    && canvaskitEquationSqrtBlock.includes('this.drawEquationStrokePath('),
  'CanvasKit equation radicals must preserve the connected Canvas2D path topology',
);
const canvaskitEquationDecorationBlock =
  extractMethodBody(canvaskitSource, 'drawEquationDecoration');
assert(
  canvaskitEquationDecorationBlock.includes('const hat = new this.canvasKit.PathBuilder()')
    && canvaskitEquationDecorationBlock.includes('const arrowHead = new this.canvasKit.PathBuilder()')
    && canvaskitEquationDecorationBlock.includes('const tilde = new this.canvasKit.PathBuilder()')
    && canvaskitEquationDecorationBlock.includes('tilde.quadTo('),
  'CanvasKit equation hats, vector arrowheads, and tildes must preserve connected and curved Canvas2D topology',
);
assert(
  extractMethodBody(canvaskitSource, 'makeEquationStrokePaint')
    .includes('paint.setStrokeWidth(strokeWidth)')
    && !extractMethodBody(canvaskitSource, 'makeEquationStrokePaint').includes('Math.max('),
  'CanvasKit equation geometry must preserve the same authored stroke width as Canvas2D',
);
const canvaskitEquationReplayBlock = extractMethodBody(canvaskitSource, 'renderEquation');
assert(
  canvaskitEquationReplayBlock.includes("route: 'svg'")
    && canvaskitEquationReplayBlock.includes("route: 'layout'")
    && canvaskitEquationReplayBlock.includes('reason: svgReplay.reason')
    && extractMethodBody(canvaskitSource, 'getEquationReplayDiagnostics')
      .includes("diagnostic.reason !== 'layoutRequested'"),
  'CanvasKit equation replay must expose SVG, requested layout, and SVG-to-layout fallback routes',
);
const canvaskitEquationSvgBlock = extractMethodBody(canvaskitSource, 'renderEquationSvgResource');
for (const reason of [
  'layoutRequested',
  'svgResourceMissing',
  'svgPayloadUnsupported',
  'invalidEquationBounds',
  'svgPathDecodeFailed',
  'svgReplayed',
]) {
  assert.equal(
    canvaskitEquationSvgBlock.includes(`reason: '${reason}'`),
    true,
    `CanvasKit equation SVG replay must report ${reason}`,
  );
}
assert(
  extractMethodBody(canvas2dSource, 'renderEquationSvgResource').includes('parseStaticSvgPathLayers(fragment)')
    && extractMethodBody(canvaskitSource, 'renderEquationSvgResource').includes('parseStaticSvgPathLayers(fragment)')
    && extractMethodBody(canvas2dSource, 'renderEquationSvgResource').includes('parseStaticSvgTextLayers(fragment)')
    && extractMethodBody(canvaskitSource, 'renderEquationSvgResource').includes('parseStaticSvgTextLayers(fragment)'),
  'Canvas2D and CanvasKit equation SVG resource replay must use the same static path/text parser',
);
assert(
  extractMethodBody(canvas2dSource, 'renderEquationSvgResource')
    .includes('staticSvgLayersHaveDrawableContent(pathLayers, textLayers)')
    && extractMethodBody(canvaskitSource, 'renderEquationSvgResource')
      .includes('staticSvgLayersHaveDrawableContent(pathLayers, textLayers)'),
  'Canvas2D and CanvasKit equation SVG replay must share the drawable-content fallback gate',
);
assertTokensInOrder(
  extractFunctionBody(staticSvgPathLayersSource, 'staticSvgLayersHaveDrawableContent'),
  [
    'layer.fill !== null',
    'staticSvgPaintIsVisible(layer.fill, layer.opacity)',
    'layer.stroke !== undefined',
    'layer.stroke.width > 0',
    'staticSvgPaintIsVisible(layer.stroke.color, layer.stroke.opacity)',
    'staticSvgPaintIsVisible(layer.fill, layer.opacity)',
  ],
  'static SVG drawable-content detection must reject paintless and transparent path/text layers',
);
const canvaskitStaticSvgTextBlock =
  extractMethodBody(canvaskitSource, 'renderStaticSvgTextLayer');
const canvaskitShapedSingleLineBlock =
  extractMethodBody(canvaskitSource, 'buildShapedSingleLineParagraph');
assertTokensInOrder(
  canvaskitShapedSingleLineBlock,
  [
    'this.fontRegistry.resolveProviderFamily(family, fontWeight, italic)',
    'this.canvasKit.ParagraphBuilder.MakeFromFontProvider(',
    'this.fontProvider',
    'builder.addText(text)',
    'paragraph = builder.build()',
    'builder.delete()',
    'paragraph.layout(CanvasKitLayerRenderer.MAX_SHAPED_TEXT_WIDTH)',
    'const width = paragraph.getLongestLine()',
    'const height = paragraph.getHeight()',
    'const alphabeticBaseline = paragraph.getAlphabeticBaseline()',
    'paragraph?.delete()',
  ],
  'CanvasKit shared single-line shaping must use the registered provider and release failed paragraphs',
);
assertTokensInOrder(
  canvaskitStaticSvgTextBlock,
  [
    'this.buildShapedSingleLineParagraph(',
    'layer.text',
    'if (shaped)',
    'layer.y - shaped.height / 2',
    'canvas.drawParagraph(',
    'drawY',
    'paragraphDrawn = true',
    'shaped.paragraph.delete()',
    'if (paragraphDrawn)',
    'const primaryMetrics = primaryObjects.font.getMetrics()',
    'const clusters = splitIntoClusters(layer.text)',
    '-(primaryMetrics.ascent + primaryMetrics.descent) / 2',
  ],
  'CanvasKit static SVG text must shape the complete string and use real line/font metrics before its direct-text fallback',
);
const canvaskitFormObjectBlock =
  extractMethodBody(canvaskitSource, 'renderFormObject');
assertTokensInOrder(
  canvaskitFormObjectBlock,
  [
    'const shaped = this.buildShapedSingleLineParagraph(',
    'formText.text',
    'formText.centered',
    'formText.anchorX - shaped.width / 2',
    'canvas.drawParagraph(',
    'shapedDrawn = true',
    'shaped.paragraph.delete()',
    'if (!shapedDrawn)',
    'canvas.drawText(formText.text',
    "if (op.formType === 'comboBox')",
    'canvas.drawRect(buttonRect',
  ],
  'CanvasKit form text must shape one line before direct fallback and retain combo-button overdraw order',
);
assert(
  extractSwitchCaseBlock(extractMethodBody(canvas2dSource, 'renderOp'), 'equation')
    .includes('this.renderEquationSvgResource(ctx, op)')
    && extractMethodBody(canvaskitSource, 'renderEquation')
      .includes('this.renderEquationSvgResource(canvas, op)'),
  'Canvas2D and CanvasKit equation replay must prefer direct SVG resources before layout fallback',
);
assertTokensInOrder(
  extractMethodBody(canvaskitSource, 'renderEquationSvgResource'),
  [
    'const decodedPathLayers:',
    'for (const layer of pathLayers)',
    'path = this.canvasKit.Path.MakeFromSVGString(layer.pathData)',
    '} catch {',
    'for (const decoded of decodedPathLayers)',
    "return { replayed: false, reason: 'svgPathDecodeFailed' }",
    'for (const { layer, path } of decodedPathLayers)',
    'for (const decoded of decodedPathLayers)',
    'decoded.path.delete()',
  ],
  'CanvasKit equation SVG replay must decode every path before drawing or choosing layout fallback',
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

const textV2TreeValidatorBlock = extractFunctionBody(textVariantsSource, 'validateLayerTextV2Tree');
for (const requiredToken of [
  "const allowCrossScopeVariants = requiredFeatures.has('text.crossScopeVariants')",
  "tree.textV2?.profile === 'strictVisual'",
  "tree.textV2?.strictVisualFallbackFree === true",
  "requiredFeatures.has('text.strictVisualFallbackFree')",
  "const allowMixedPerGlyphOrientation = requiredFeatures.has('text.vertical.mixedPerGlyph')",
]) {
  assert.equal(
    textV2TreeValidatorBlock.includes(requiredToken),
    true,
    `schema v2 validator must keep authority gate: ${requiredToken}`,
  );
}
const textV2OpValidatorBlock = extractFunctionBody(textVariantsSource, 'validateLayerTextV2Op');
for (const requiredToken of [
  'crossScopeVariantFeatureMissing',
  'Text variant',
  'uses scopeRef without text.crossScopeVariants.',
  'fallbackFreeFeatureMissing',
  'fallbackPolicy=none requires strictVisual profile, strictVisualFallbackFree metadata, and text.strictVisualFallbackFree.',
  'strictVisualVariantMissing',
  'fallbackPolicy=none requires at least one strict visual text variant.',
  'mixedPerGlyphFeatureMissing',
  'uses mixedPerGlyph without text.vertical.mixedPerGlyph.',
]) {
  assert.equal(
    textV2OpValidatorBlock.includes(requiredToken),
    true,
    `schema v2 validator must keep deferred-authority rejection: ${requiredToken}`,
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
  '!payload.stroke',
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
  "typeof bitmapGlyph.colorSpace === 'string'",
  'bitmapGlyph.colorSpace.length > 0',
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
  '!payload.stroke',
  'payload.colorLayers === undefined',
  'payload.bitmapGlyph === undefined',
  '!hasRawInlineSvgGlyphReplayField(svgGlyph)',
  'isValidResourceId(svgGlyph.vectorResourceId)',
  'isValidPayloadRange(svgGlyph.sourceRangeUtf8)',
  'isNonEmptyPayloadRange(svgGlyph.glyphRange)',
  'isValidTextRunPlacement(svgGlyph.placement)',
  '(svgGlyph.transformToRun === undefined || isFiniteAffineTransform(svgGlyph.transformToRun))',
  'viewBox !== undefined',
  'Number.isFinite(viewBox.x)',
  'Number.isFinite(viewBox.y)',
  'Number.isFinite(viewBox.width)',
  'Number.isFinite(viewBox.height)',
  'viewBox.width > 0',
  'viewBox.height > 0',
  'svgGlyph.intrinsicSize === undefined',
  'Number.isFinite(svgGlyph.intrinsicSize.width)',
  'Number.isFinite(svgGlyph.intrinsicSize.height)',
  'svgGlyph.intrinsicSize.width > 0',
  'svgGlyph.intrinsicSize.height > 0',
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
assertTokensInOrder(
  glyphOutlinePayloadStatusSource,
  [
    'const supported = hasStrictBitmapGlyphContract(op)',
    'hasReplayableGlyphPayloadBBox(op)',
    'resources?.images?.[resourceIndex] !== undefined',
  ],
  'BitmapGlyph strict payload status must require replayable bbox and image resource',
);
assertTokensInOrder(
  glyphOutlinePayloadStatusSource,
  [
    'const fragment = resourceIndex === undefined ? undefined : resources?.svgFragments?.[resourceIndex]',
    "const pathLayers = typeof fragment === 'string' ? parseStaticSvgPathLayers(fragment) : []",
    "const textLayers = typeof fragment === 'string' ? parseStaticSvgTextLayers(fragment) : []",
    'supported: hasStaticSanitizedSvgGlyphContract(op)',
    'hasReplayableGlyphPayloadBBox(op)',
    'pathLayers.length > 0',
    'pathLayers.every((layer) => isStaticSvgPathDataValid(layer.pathData))',
    'textLayers.length === 0',
  ],
  'SvgGlyph strict payload status must require replayable bbox and path-only static vector resource',
);
const glyphPayloadBBoxGuardBlock = extractFunctionBody(glyphOutlinePayloadStatusSource, 'hasReplayableGlyphPayloadBBox');
for (const requiredToken of [
  'Number.isFinite(bbox.x)',
  'Number.isFinite(bbox.y)',
  'Number.isFinite(bbox.width)',
  'Number.isFinite(bbox.height)',
  'bbox.width > 0',
  'bbox.height > 0',
]) {
  assert.equal(
    glyphPayloadBBoxGuardBlock.includes(requiredToken),
    true,
    `strict glyph payload bbox guard must keep ${requiredToken}`,
  );
}
assertTokensInOrder(
  glyphOutlinePayloadStatusSource,
  [
    'details: supported && op.bitmapGlyph && op.bitmapGlyph.colorSpace === undefined',
    "'colorSpaceDefaulted=srgb'",
  ],
  'BitmapGlyph strict payload status must report explicit sRGB default diagnostics',
);
const canvaskitBitmapGlyphReplayBlock = extractMethodBody(canvaskitSource, 'renderBitmapGlyphOutline');
assertTokensInOrder(
  canvaskitBitmapGlyphReplayBlock,
  [
    'const imageIndex = resolveLayerResourceIndex(',
    'payload?.imageResourceId',
    'this.lastRenderedTree?.resources?.imageKeys',
    'this.resourceCache.image(imageIndex)',
  ],
  'CanvasKit BitmapGlyph replay must resolve images through resource ids before drawing',
);
for (const requiredToken of [
  'canvas.drawImageRectOptions(',
  'this.canvasKit.XYWHRect(0, 0, width, height)',
  "payload.filtering === 'nearest' ? this.canvasKit.FilterMode.Nearest : this.canvasKit.FilterMode.Linear",
  'this.canvasKit.MipmapMode.None',
]) {
  assert.equal(
    canvaskitBitmapGlyphReplayBlock.includes(requiredToken),
    true,
    `CanvasKit BitmapGlyph replay must keep deterministic image-strike sampling guard: ${requiredToken}`,
  );
}
assertTokensInOrder(
  canvaskitBitmapGlyphReplayBlock,
  [
    'const transform = payload.placement?.runToPage',
    'const payloadTransform = payload.transformToRun',
    'canvas.concat([',
    'transform.a',
    'if (payloadTransform)',
    'payloadTransform.a',
    'canvas.drawImageRectOptions(',
  ],
  'CanvasKit BitmapGlyph replay must apply run placement before payload-local transform and drawing',
);
assertTokensInOrder(
  canvaskitBitmapGlyphReplayBlock,
  [
    'const paint = new this.canvasKit.Paint()',
    'try {',
    'canvas.drawImageRectOptions(',
    '} finally {',
    'canvas.restore()',
    'paint.delete()',
  ],
  'CanvasKit BitmapGlyph replay must release transient Paint objects',
);
assert.equal(
  extractMethodBody(canvaskitSource, 'renderSvgGlyphOutline').includes('hasStaticSanitizedSvgGlyphContract(op)'),
  true,
  'CanvasKit SvgGlyph replay must call the shared static sanitized payload gate before drawing',
);
const canvaskitSvgGlyphReplayBlock = extractMethodBody(canvaskitSource, 'renderSvgGlyphOutline');
assertTokensInOrder(
  extractMethodBody(canvaskitSource, 'prepareSvgGlyphPaths'),
  [
    'const layers = typeof fragment',
    'parseStaticSvgPathLayers(fragment)',
    'if (layers.length === 0)',
    'const prepared: CanvasKitPreparedSvgGlyphPathLayer[] = []',
    'for (const layer of layers)',
    'path = this.canvasKit.Path.MakeFromSVGString(layer.pathData)',
    'if (!path)',
    'for (const decoded of prepared)',
    'decoded.path.delete()',
    'this.preparedSvgGlyphPaths.set(op, null)',
    'prepared.push({ layer, path })',
    'this.preparedSvgGlyphPaths.set(op, prepared)',
  ],
  'CanvasKit SvgGlyph preparation must decode every path atomically before selection',
);
assertTokensInOrder(
  extractMethodBody(canvaskitSource, 'glyphOutlineVariantReplayStatus'),
  [
    "if (payloadSupported && op.payloadKind === 'svgGlyph')",
    'if (!this.prepareSvgGlyphPaths(op))',
    'payloadSupported = false',
    "payloadDetails = 'pathDecodeFailed'",
  ],
  'CanvasKit SvgGlyph selection must reject an atomically failed prepared path set',
);
assertTokensInOrder(
  extractMethodBody(canvaskitSource, 'prepareSvgGlyphPaths'),
  [
    'const vectorIndex = resolveLayerResourceIndex(',
    'op.svgGlyph?.vectorResourceId',
    'this.lastRenderedTree?.resources?.svgKeys',
    'const fragment = vectorIndex === undefined',
    'this.lastRenderedTree?.resources?.svgFragments?.[vectorIndex]',
  ],
  'CanvasKit SvgGlyph preparation must resolve vectors through resource ids before parsing',
);
assertTokensInOrder(
  canvaskitSvgGlyphReplayBlock,
  [
    'const transform = payload.placement?.runToPage',
    'const payloadTransform = payload.transformToRun',
    'canvas.concat([',
    'transform.a',
    'if (payloadTransform)',
    'payloadTransform.a',
    'canvas.scale(width / viewBox.width, height / viewBox.height)',
    'canvas.translate(-viewBox.x, -viewBox.y)',
  ],
  'CanvasKit SvgGlyph replay must apply run placement before payload-local and viewBox transforms',
);
assertTokensInOrder(
  canvaskitSvgGlyphReplayBlock,
  [
    'canvas.scale(width / viewBox.width, height / viewBox.height)',
    'canvas.translate(-viewBox.x, -viewBox.y)',
    'for (const { layer, path } of pathLayers)',
    'if (layer.transform)',
    'layer.transform.a',
    'this.applyPathFillRule(path, layer.fillRule)',
  ],
  'CanvasKit SvgGlyph replay must apply path-layer transforms to prepared paths after viewBox normalization',
);
assertTokensInOrder(
  extractMethodBody(canvaskitSource, 'clearPreparedSvgGlyphPaths'),
  [
    'for (const prepared of this.preparedSvgGlyphPaths.values())',
    'for (const decoded of prepared ?? [])',
    'decoded.path.delete()',
    'this.preparedSvgGlyphPaths.clear()',
  ],
  'CanvasKit SvgGlyph prepared-path cache must release every decoded path',
);
assert.equal(
  canvaskitSvgGlyphReplayBlock.includes('MakeFromSVGString'),
  false,
  'CanvasKit SvgGlyph replay must reuse atomically prepared paths instead of decoding during drawing',
);
assertTokensInOrder(
  canvaskitSvgGlyphReplayBlock,
  [
    'this.applyPathFillRule(path, layer.fillRule)',
    'if (layer.fill !== null)',
    "const paint = this.makePaint(layer.fill, 'fill', layer.opacity)",
    'canvas.drawPath(path, paint)',
    'paint.delete()',
  ],
  'CanvasKit SvgGlyph replay must preserve fill opacity and fill-rule contracts',
);
assertTokensInOrder(
  canvaskitSvgGlyphReplayBlock,
  [
    'if (layer.stroke)',
    "const strokePaint = this.makePaint(layer.stroke.color, 'stroke', layer.stroke.opacity)",
    'strokePaint.setStrokeWidth(layer.stroke.width)',
    'strokePaint.setStrokeJoin(this.canvasKitStrokeJoin(layer.stroke.lineJoin))',
    'strokePaint.setStrokeCap(this.canvasKitStrokeCap(layer.stroke.lineCap))',
    'strokePaint.setStrokeMiter(layer.stroke.miterLimit)',
    'if (layer.stroke.dashArray)',
    'this.canvasKit.PathEffect.MakeDash(layer.stroke.dashArray, layer.stroke.dashOffset)',
    'strokePaint.setPathEffect(effect)',
    'effect.delete()',
    'canvas.drawPath(path, strokePaint)',
    'strokePaint.delete()',
  ],
  'CanvasKit SvgGlyph replay must preserve stroke style and dash contracts',
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
assert(
  canvaskitResourceCacheSource.includes('canvasKitEncodedImageIsReplayable(bytes)')
    && canvaskitEncodedImageAdmissionSource.includes(
      'CANVASKIT_MAX_ENCODED_IMAGE_BASE64_BYTES = 24 * 1024 * 1024',
    )
    && canvaskitEncodedImageAdmissionSource.includes(
      'CANVASKIT_MAX_IMAGE_DIMENSION = 8192',
    )
    && canvaskitEncodedImageAdmissionSource.includes(
      'CANVASKIT_MAX_IMAGE_PIXELS = 32 * 1024 * 1024',
    ),
  'CanvasKit runtime must reject malformed and oversized encoded images before decoder entry',
);
assertTokensInOrder(
  canvaskitResourceCacheSource,
  [
    'if (this.failedImageCacheKeys.has(cacheKey))',
    'this.imageDiagnostics.failureCacheHits += 1',
    'let bytes: Uint8Array | undefined',
    'bytes = this.imageBytes(resourceId, base64)',
    '} catch {',
    "this.recordImageFailure(cacheKey, resourceId, base64, 'base64DecodeFailed')",
    'return null',
    'if (!bytes)',
    "this.recordImageFailure(cacheKey, resourceId, base64, 'resourceUnavailable')",
    'if (!canvasKitEncodedImageIsReplayable(bytes))',
    "this.recordImageFailure(cacheKey, resourceId, base64, 'encodedImageRejected')",
    'return null',
    'try {',
    'image = this.canvasKit.MakeImageFromEncoded(bytes)',
    '} catch {',
    'image = null',
    "reason: 'encodedImageDecodeFailed'",
    "fallback: 'browserImageSource'",
    'this.startBrowserImageLoad(',
  ],
  'CanvasKit resource cache must recover bounded encoded-image decoder failures through its browser image bridge',
);
assert(
  canvaskitResourceCacheSource.includes(
    'canvasKitEncodedImageHasStableFrame(bytes, imageHeader)',
  )
    && canvaskitEncodedImageAdmissionSource.includes(
      'export function canvasKitEncodedImageHasStableFrame',
    )
    && canvaskitEncodedImageAdmissionSource.includes('function gifHasSingleFrame')
    && canvaskitEncodedImageAdmissionSource.includes('function webpHasSingleFrame')
    && canvaskitEncodedImageAdmissionSource.includes('frameCount > 1')
    && canvaskitEncodedImageAdmissionSource.includes("(bytes[payloadStart] & 0x02) !== 0")
    && canvaskitEncodedImageAdmissionSource.includes(
      "bytesEqual(bytes, offset, [0x41, 0x4e, 0x49, 0x4d])",
    )
    && canvaskitEncodedImageAdmissionSource.includes(
      "bytesEqual(bytes, offset, [0x41, 0x4e, 0x4d, 0x46])",
    ),
  'CanvasKit browser recovery must admit only structurally proven single-frame GIF and WebP payloads',
);
assert(
  canvaskitResourceCacheSource.includes('decodedImageMatchesHeader')
    && canvaskitResourceCacheSource.includes("'decodedDimensionsMismatch'"),
  'CanvasKit must reject decoded raster and SVG dimensions that disagree with admitted headers',
);
assert(
  canvaskitResourceCacheSource.includes('this.failedImageCacheKeys.clear()')
    && canvaskitResourceCacheSource.includes('this.failedImageReasons.clear()')
    && canvaskitResourceCacheSource.includes("if (key.startsWith('res:')) {")
    && canvaskitResourceCacheSource.includes('this.failedImageCacheKeys.delete(key)')
    && canvaskitResourceCacheSource.includes('this.failedImageReasons.delete(key)'),
  'CanvasKit image decode failure cache must clear on dispose and resource-table replacement',
);
assert(
  canvaskitResourceCacheSource.includes('getImageDiagnostics(): CanvasKitImageDiagnostics')
    && canvaskitResourceCacheSource.includes('resetImageDiagnostics(): void')
    && canvaskitResourceCacheSource.includes('failureAttempts: number')
    && canvaskitSource.includes('this.resourceCache.resetImageDiagnostics()')
    && canvaskitSource.includes('getImageDiagnostics(): Readonly<CanvasKitImageDiagnostics>'),
  'CanvasKit must expose per-render encoded-image failure diagnostics',
);
assert(
  canvaskitResourceCacheSource.includes('resetPatternDiagnostics(): void')
    && canvaskitResourceCacheSource.includes('beginPatternReplay(): void')
    && canvaskitSource.includes('this.resourceCache.beginPatternReplay()'),
  'CanvasKit must reset pattern diagnostics and retry unrecoverable pattern images at each render boundary',
);
assertTokensInOrder(
  extractMethodBody(canvaskitResourceCacheSource, 'makePatternImage'),
  [
    'this.canvasKit.MakeSurface(6, 6)',
    'const pixels = new Uint8Array(6 * 6 * 4)',
    'this.canvasKit.MakeImage(imageInfo, pixels, 6 * 4)',
    'this.patternDiagnostics.directImageCreations += 1',
    'this.patternDiagnostics.imagesCreated += 1',
  ],
  'CanvasKit patterns must recover through deterministic raw images when offscreen surfaces fail',
);
assert(
  canvaskitResourceCacheSource.includes('failureCacheHits: number')
    && extractMethodBody(canvaskitResourceCacheSource, 'patternImage')
      .includes('this.patternDiagnostics.failureCacheHits += 1')
    && extractMethodBody(canvaskitResourceCacheSource, 'patternImage')
      .includes('this.patternDiagnostics.surfaceFailures += 1'),
  'CanvasKit pattern negative-cache hits must re-report unrecoverable creation failures for the active render',
);
const canvaskitRenderNodeBlock = extractMethodBody(canvaskitSource, 'renderNode');
assertTokensInOrder(
  canvaskitRenderNodeBlock,
  [
    'const imageFailureAttemptsBefore =',
    'const patternFailuresBefore =',
    'const textFailureAttemptsBefore =',
    'const hasRuntimeReplayFailure =',
    'imageDiagnostics.failureAttempts > imageFailureAttemptsBefore',
    'patternDiagnostics.surfaceFailures > patternFailuresBefore',
    'textFailureAttempts > textFailureAttemptsBefore',
    'if (!hasRuntimeReplayFailure)',
    'this.staticPictureCache.set(',
    'if (hasRuntimeReplayFailure)',
    'picture.delete()',
  ],
  'CanvasKit must not cache static pictures that contain a silent runtime replay failure',
);
assert(
  canvaskitRenderNodeBlock.includes('this.staticPictureCache.getMetadata(cacheKey)')
    && canvaskitRenderNodeBlock.includes('metadata.equationReplayDiagnostics')
    && canvaskitRenderNodeBlock.includes(
      'this.resourceCache.restoreImageRecoveries(metadata.imageRecoveryDiagnostics)',
    )
    && canvaskitRenderNodeBlock.includes(
      'this.resourceCache.getImageRecoveriesSince(imageRecoveryEventsStart)',
    )
    && canvaskitRenderNodeBlock.includes('.slice(equationDiagnosticsStart)')
    && staticPictureCacheSource.includes('getMetadata(cacheKey: string): Metadata | null')
    && staticPictureCacheSource.includes('this.metadata.delete(key)')
    && staticPictureCacheSource.includes('this.metadata.clear()'),
  'CanvasKit static pictures must retain equation routes and browser image recoveries and release their metadata with the picture',
);
assert(
  staticPictureCacheSource.includes('staticSubtreeReplayDependencies(')
    && staticPictureCacheSource.includes('paintOpResourceReferences(')
    && staticPictureCacheSource.includes('imageResourceReference(')
    && staticPictureCacheSource.includes('svgResourceReference('),
  'CanvasKit static picture cache keys must include subtree-referenced image and SVG payload fingerprints',
);
assert(
  staticPictureCacheSource.includes('payloadFingerprints.get(payload) ?? stableValueFingerprint(payload)')
    && staticPictureCacheSource.includes('producerHash: hashes?.[index] ?? null'),
  'CanvasKit static picture cache keys must memoize payload bytes while preserving producer identities',
);
assert(
  staticPictureCacheSource.includes("case 'glyphRun':")
    && staticPictureCacheSource.includes('fontResourceReference(op, fontResources, resources, payloadFingerprints)')
    && staticPictureCacheSource.includes("fontResources?.faces.find((candidate) => candidate.id === faceKey)"),
  'CanvasKit static picture cache keys must include only the face/blob resource used by strict GlyphRun replay',
);
assert(
  staticPictureCacheSource.includes('layerTextVariantOpsForLeaf(candidate.ops, tree.variantOps)')
    && staticPictureCacheSource.includes('op: stableValueFingerprint(op)'),
  'CanvasKit static picture cache keys must include only schema-v1 sidecars anchored in the cached subtree',
);
assert.equal(
  fs.readFileSync(path.join(canvaskitDirectory, 'static-picture-cache.ts'), 'utf8')
    .includes('stableValueFingerprint(tree.outputOptions ?? null)'),
  true,
  'CanvasKit static picture cache keys must include output options that affect direct replay',
);
const canvasKitLayerTreeCacheKeyBlock = extractMethodBody(
  staticPictureCacheSource,
  'cacheKeyForLayerTree',
);
assert(
  !canvasKitLayerTreeCacheKeyBlock.includes('tree.resources')
    && !canvasKitLayerTreeCacheKeyBlock.includes('tree.fontResources')
    && !canvasKitLayerTreeCacheKeyBlock.includes('tree.variantOps'),
  'CanvasKit layer-tree cache identity must not invalidate every static subtree for an unrelated resource or sidecar',
);
for (const requiredToken of [
  'item instanceof ArrayBuffer',
  "appendString(`buffer:${bytes.length}:`)",
  'ArrayBuffer.isView(item)',
  'view.byteOffset',
  'view.byteLength',
  "appendString(`bytes:${bytes.length}:`)",
]) {
  assert.equal(
    staticPictureCacheSource.includes(requiredToken),
    true,
    `CanvasKit static picture cache fingerprint must include ArrayBuffer and typed-array payload bytes: ${requiredToken}`,
  );
}
assert.equal(
  canvaskitFontsSource.includes("from '../layer-canvas-utils'"),
  false,
  'CanvasKit font registry must use native-ready image/font helpers instead of broad Canvas2D utilities',
);
assert(
  fontLoaderSource.includes('export const FONT_LIST')
    && fontLoaderSource.includes("export const OLD_HANGUL_FONT_FAMILY = 'Source Han Serif K Old Hangul'")
    && fontLoaderSource.includes("unicodeRange: OLD_HANGUL_FONT_UNICODE_RANGE")
    && fontLoaderSource.includes("loadText: OLD_HANGUL_FONT_LOAD_TEXT")
    && canvaskitFontsSource.includes("import { FONT_LIST, OLD_HANGUL_FONT_FAMILY } from '@/core/font-loader'")
    && canvaskitFontsSource.includes('new URL(file, document.baseURI).href')
    && canvaskitFontsSource.includes("entry.weight === '700' || /(?:^|[-_])bold(?:[-_.]|$)/i.test(entry.file)")
    && canvaskitFontsSource.includes('await Promise.all([...catalogFontUrls].map((url) => loadFontFile(url)))')
    && canvaskitFontsSource.includes('BUNDLED_FONT_URLS.get(file)')
    && canvaskitFontsSource.includes('SourceHanSerifK-OldHangul-subset.woff2')
    && canvaskitFontsSource.includes('registerCatalogAliases(OLD_HANGUL_ALIASES)')
    && canvaskitFontsSource.includes("'Palatino Linotype'")
    && canvaskitSource.includes('font.setEmbolden(providerFace.synthesizeBold)')
    && canvaskitSource.includes('font.setSkewX(providerFace.synthesizeItalic ? -0.25 : 0)'),
  'CanvasKit TextRun fallback must mirror Canvas2D font faces and synthesize only missing physical styles',
);
const canvaskitTextRunBlock = extractMethodBody(canvaskitSource, 'renderTextRun');
const canvas2dTextRunBlock = extractMethodBody(canvas2dSource, 'renderTextRun');
assert(
  canvaskitSource.includes('getTextReplayDiagnostics(): Readonly<CanvasKitTextReplayDiagnostics>')
    && canvaskitSource.includes('resetTextReplayDiagnostics(): void')
    && canvaskitFontsSource.includes('resolveFamilyWithStatus(fontFamily: string): CanvasKitFontResolution')
    && canvaskitFontsSource.includes("source: 'weightSuffixAlias'")
    && canvaskitFontsSource.includes("source: 'fallbackCandidate'")
    && canvaskitFontsSource.includes("source: 'defaultFallback'")
    && canvaskitTextRunBlock.includes('this.fontRegistry.resolveFamilyWithStatus(op.style.fontFamily)')
    && canvaskitTextRunBlock.includes("? 'unregisteredFallback'")
    && canvaskitSource.includes('textFontSubstitutionDiagnostics:')
    && canvaskitSource.includes('this.recordTextFontSubstitutionDiagnostic({ ...diagnostic })')
    && canvaskitSource.includes('unregisteredFontFallbacks: fontSubstitutions.filter(')
    && canvaskitSource.includes('this.textFontSubstitutionDiagnostics.clear()')
    && canvaskitTextRunBlock.includes("reason: 'textBlobConstructionFailed' as const")
    && canvaskitTextRunBlock.includes("fallback: 'drawText'")
    && canvaskitTextRunBlock.includes("reason: 'simpleTextFallbackFailed'")
    && canvaskitTextRunBlock.includes('clusterStartUtf16: cluster.startUtf16')
    && canvaskitTextRunBlock.includes('const needsOldHangulFallback = containsOldHangulJamo(cluster.text)')
    && canvaskitTextRunBlock.includes('? [OLD_HANGUL_FONT_FAMILY]')
    && canvaskitTextRunBlock.includes("? 'oldHangul'")
    && canvaskitTextRunBlock.includes('this.failedTextBlobCacheKeys.has(cacheKey)')
    && canvaskitTextRunBlock.includes('canvas.drawText(replayText, drawX, drawY, fillPaint, fallbackFont)')
    && canvaskitTextRunBlock.includes('this.textReplayRecoveryDiagnostics.set(failureKey, recovery)')
    && canvaskitTextRunBlock.includes('this.textReplayFailureDiagnostics.set(failureKey, failure)'),
  'CanvasKit TextRun replay must diagnose font substitutions, recover negative-cached TextBlob failures through direct CanvasKit text, and expose unrecovered failures',
);
assert(
  importBlockFrom(canvas2dSource, './text-replay-utils').includes('containsOldHangulJamo')
    && importBlockFrom(canvaskitSource, './text-replay-utils').includes('containsOldHangulJamo')
    && canvas2dTextRunBlock.includes('if (containsOldHangulJamo(cluster.text))')
    && canvas2dTextRunBlock.includes('return oldHangulFallbackFont'),
  'Canvas2D and CanvasKit must share old-Hangul grapheme detection and select the dedicated face before generic fallback',
);
assert(
  canvaskitTextRunBlock.includes('const requiresComplexClusterShaping = clusters.some')
    && canvaskitTextRunBlock.includes('codePoint >= 0x0590 && codePoint <= 0x08ff')
    && canvaskitTextRunBlock.includes('codePoint >= 0x0900 && codePoint <= 0x0dff')
    && canvaskitTextRunBlock.includes('codePoint >= 0x200c && codePoint <= 0x200d')
    && canvaskitTextRunBlock.includes('codePoint >= 0x1f1e6 && codePoint <= 0x1faff')
    && canvaskitTextRunBlock.includes('|| requiresComplexClusterShaping')
    && canvaskitTextRunBlock.includes('builder.addText(cluster.text)')
    && canvaskitTextRunBlock.includes('originX + entry.x')
    && canvaskitTextRunBlock.includes('originY - entry.baseline'),
  'CanvasKit ordinary complex-script graphemes must shape through Paragraph at authored TextRun positions',
);
assert(
  canvaskitTextRunBlock.includes('strokePaint.setStrokeJoin(this.canvasKit.StrokeJoin.Round)')
    && extractMethodBody(canvaskitSource, 'renderGlyphRun')
      .includes('strokePaint.setStrokeJoin(this.canvasKit.StrokeJoin.Round)'),
  'CanvasKit TextRun and GlyphRun outline replay must match the Canvas2D round join',
);
assert(
  canvaskitSource.includes('const MAX_TEXT_FALLBACK_FAMILY_CACHE_ENTRIES = 4096')
    && canvaskitSource.includes('private readonly textFallbackFamilyCache = new Map<string, string>()')
    && canvaskitTextRunBlock.includes('this.textFallbackFamilyCache.get(familyCacheKey)')
    && canvaskitTextRunBlock.includes('!this.textBlobCache.has(`${clusterFontKey}|${replayText}`)')
    && canvaskitSource.includes('this.textFallbackFamilyCache.clear()'),
  'CanvasKit TextRun warm replay must use a bounded family-name cache and release it with the renderer',
);
assertTokensInOrder(
  canvaskitTextRunBlock,
  [
    'const cachedFamily = this.textFallbackFamilyCache.get(familyCacheKey)',
    'const clusterFontKey = [',
    '!this.textBlobCache.has(`${clusterFontKey}|${replayText}`)',
    'selectedObjects = this.makeTextObjects(',
  ],
  'CanvasKit TextRun must consult family and TextBlob caches before constructing CanvasKit font objects',
);
const pageRendererContentBlock = extractMethodBody(pageRendererSource, 'renderContent');
assert(
  pageRendererContentBlock.includes('this.canvaskitRenderer.renderPageWithMarginGuides(')
    && !pageRendererContentBlock.includes('this.canvaskitRenderer.renderPage(layerTree, canvas, appliedScale)'),
  'Studio CanvasKit page replay must render content and margin guides before a single surface flush',
);
const canvaskitGlyphRunReplayStatusBlock = extractMethodBody(canvaskitFontsSource, 'glyphRunReplayStatus');
const canvaskitFontBlobRegistrationBlock = extractMethodBody(
  canvaskitFontsSource,
  'registerFontBlobsFromResources',
);
const canvaskitUnsupportedGlyphRunPaintBlock = extractMethodBody(
  canvaskitFontsSource,
  'unsupportedGlyphRunPaintReason',
);
const glyphOutlineFillOnlyStyleBlock = extractFunctionBody(
  textVariantsSource,
  'isFillOnlyGlyphOutlineStyle',
);
const canvaskitGlyphRunTypefaceBlock = extractMethodBody(canvaskitFontsSource, 'typefaceForGlyphRun');
const canvaskitGlyphRunFaceDataBlock = extractMethodBody(
  canvaskitFontsSource,
  'fontFaceDataForGlyphRun',
);
const canvaskitSfntFaceDataBlock = extractFunctionBody(
  canvaskitSfntFaceSource,
  'canvasKitFontFaceData',
);
const canvaskitFontBlobBytesBlock = extractMethodBody(canvaskitFontsSource, 'fontBlobBytesForRef');
assertTokensInOrder(
  canvaskitFontBlobRegistrationBlock,
  [
    'let resolvedRefId = blob.dataRef.id',
    'resources.fontBlobKeys?.indexOf(resolvedRefId)',
    'resources.fontBlobHashes?.indexOf(blob.digest.value)',
    'resolvedRefId = String(resolvedIndex)',
    'this.fontBlobDigestForRef(resources.fontBlobHashes, resolvedRefId)',
    'this.fontBlobBytesForRef(resources.fontBlobs, resolvedRefId)',
  ],
  'CanvasKit portable font registration must resolve stable resource keys before array payload lookup',
);
assertTokensInOrder(
  canvaskitGlyphRunTypefaceBlock,
  [
    'const bytes = this.fontFaceDataForGlyphRun(face, blob)',
    'try {',
    'typeface = this.canvasKit.Typeface.MakeTypefaceFromData(bytes.slice(0))',
    '} catch {',
    'typeface = null',
    'if (!typeface)',
    'try {',
    'typeface = this.canvasKit.Typeface.MakeFreeTypeFaceFromData(bytes.slice(0))',
    '} catch {',
    'typeface = null',
  ],
  'CanvasKit GlyphRun font selection must contain both typeface parser failure paths',
);
assert(
  canvaskitFontsSource.includes("import { canvasKitFontFaceData } from './sfnt-face'")
    && canvaskitGlyphRunFaceDataBlock.includes('canvasKitFontFaceData(bytes, face.faceIndex)')
    && canvaskitSfntFaceDataBlock.includes('faceIndex >= faceCount')
    && canvaskitSfntFaceDataBlock.includes('tableOffset < collectionHeaderLength')
    && canvaskitSfntFaceDataBlock.includes('tableLength > bytes.byteLength - tableOffset')
    && canvaskitSfntFaceDataBlock.includes(
      'selectedView.setUint32(outputRecordOffset + 8, table.outputOffset, false)',
    ),
  'CanvasKit exact TTC replay must select one bounded SFNT face before typeface construction',
);
assertTokensInOrder(
  canvaskitFontBlobBytesBlock,
  [
    'try {',
    'bytes = decodeBase64(base64)',
    '} catch {',
    'return null',
  ],
  'CanvasKit GlyphRun font resources must reject malformed base64 without aborting page replay',
);
assertTokensInOrder(
  canvaskitGlyphRunReplayStatusBlock,
  [
    'run.diagnostics.missingGlyphCount !== 0',
    "this.glyphRunReplayFailure(run, 'missingGlyph')",
    'run.diagnostics.clusterMismatchCount !== 0',
    "this.glyphRunReplayFailure(run, 'clusterMismatch')",
    'run.diagnostics.usedFallbackFontCount !== 0',
    "this.glyphRunReplayFailure(run, 'diagnosticsNotClean')",
    'for (const glyphId of run.glyphIds)',
    'glyphId <= 0',
    'glyphId > 0xffff',
    "return this.glyphRunReplayFailure(run, 'glyphIdOutOfRange')",
    'if (run.shapeKey.fontInstance.variations?.length)',
    "return this.glyphRunReplayFailure(run, 'variationUnsupported'",
    'const faceKey = run.shapeKey.fontInstance.faceKey',
    "if (run.diagnostics.replayEligibility === 'portable')",
    "return this.glyphRunReplayFailure(run, 'fontBlobNotPortable'",
    'face.faceIndex !== 0',
    '!this.glyphRunTypefaces.has(this.typefaceCacheKey(face, blob))',
    '!this.fontFaceDataForGlyphRun(face, blob)',
    "return this.glyphRunReplayFailure(run, 'faceIndexUnsupported'",
  ],
  'CanvasKit GlyphRun replay must keep range and variation gates while admitting only extractable collection faces',
);
for (const requiredToken of [
  'run.glyphIds.length > MAX_STRICT_GLYPHS_PER_RUN',
  "this.glyphRunReplayFailure(run, 'glyphRunTooLarge')",
  "this.glyphRunReplayFailure(run, 'glyphPositionCountMismatch')",
  "this.glyphRunReplayFailure(run, 'glyphAdvanceCountMismatch')",
  'Math.abs(point.x) > MAX_FLOAT32',
  "this.glyphRunReplayFailure(run, 'positionNotFinite')",
  "this.glyphRunReplayFailure(run, 'advanceNotFinite')",
  'run.placement.baselineY',
  "this.glyphRunReplayFailure(run, 'placementNotFinite')",
  'instance.sizePx > MAX_STRICT_GLYPH_FONT_SIZE_PX',
  "this.glyphRunReplayFailure(run, 'fontInstanceInvalid')",
  'run.direction !== run.shapeKey.direction',
  'run.writingMode !== run.shapeKey.writingMode',
  "this.glyphRunReplayFailure(run, 'glyphRunMetadataMismatch')",
]) {
  assert(
    canvaskitGlyphRunReplayStatusBlock.includes(requiredToken),
    `CanvasKit GlyphRun eligibility must preserve the bounded Rust payload contract: ${requiredToken}`,
  );
}
assert(
  canvaskitUnsupportedGlyphRunPaintBlock.includes('style.tabLeaders?.length'),
  'CanvasKit GlyphRun eligibility must preserve the Rust tab-leader paint gate',
);
assertTokensInOrder(
  canvaskitUnsupportedGlyphRunPaintBlock,
  [
    'if (style.superscript)',
    "return 'glyphRunSuperscriptUnsupported'",
    'if (style.subscript)',
    "return 'glyphRunSubscriptUnsupported'",
  ],
  'CanvasKit GlyphRun replay must preserve TextRun script metrics through explicit fallback',
);
for (const requiredToken of [
  'style.tabLeaders?.length',
  '!style.superscript',
  '!style.subscript',
]) {
  assert(
    glyphOutlineFillOnlyStyleBlock.includes(requiredToken),
    `GlyphOutline fill-only eligibility must preserve Rust paint gate: ${requiredToken}`,
  );
}
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
const canvaskitRenderPageInternalBlock = extractMethodBody(canvaskitSource, 'renderPageInternal');
assertTokensInOrder(
  canvaskitRenderPageInternalBlock,
  [
    'this.textVariantSelectionDiagnostics.length = 0',
    'const pendingTextVariantNodes: LayerNode[] = [tree.root]',
    'selectLayerTextVariantSetsWithReport(',
    'this.textVariantSelectionDiagnostics.push(...selection.reports)',
    'this.renderSurface(surface, tree, scale, pageInfo)',
    'const fallbackSurface = this.surfaceCache.replaceWithSoftware(targetCanvas)',
    'this.renderSurface(fallbackSurface, tree, scale, pageInfo)',
  ],
  'CanvasKit variant diagnostics must be collected before cached/GPU replay and remain valid for software fallback',
);
assert.equal(
  canvaskitRenderPageInternalBlock.match(/this\.textVariantSelectionDiagnostics\.length = 0/g)?.length,
  1,
  'CanvasKit variant diagnostics must be reset once per page, not once per replay attempt',
);
const canvaskitSurfaceCacheSource = fs.readFileSync(path.join(canvaskitDirectory, 'surface-cache.ts'), 'utf8');
assert.equal(
  canvaskitResourceCacheSource.includes('Canvas2DLayerRenderer')
    || canvaskitSurfaceCacheSource.includes('Canvas2DLayerRenderer'),
  false,
  'CanvasKit caches and surface fallback must not instantiate the Canvas2D renderer',
);
assert.equal(
  canvaskitSurfaceCacheSource.includes('MakeSWCanvasSurface(targetCanvas)'),
  true,
  'CanvasKit software fallback must use CanvasKit MakeSWCanvasSurface',
);
assertTokensInOrder(
  canvaskitSurfaceCacheSource,
  [
    "if (this.surfaceRequest.preference === 'webgpu')",
    'this.webgpuAttempts += 1',
    'this.canvasKit.MakeGPUCanvasContext',
    'this.canvasKit.MakeGPUCanvasSurface',
  ],
  'CanvasKit WebGPU surface creation must stay behind an explicit WebGPU preference',
);
assert.equal(
  canvaskitSurfaceCacheSource.includes("if (!surface && this.surfaceRequest.preference !== 'software')"),
  true,
  'CanvasKit software surface preference must skip WebGL before CanvasKit software replay',
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
assertTokensInOrder(
  canvaskitResourceCacheSource,
  [
    "let surface: ReturnType<CanvasKit['MakeSurface']> = null",
    'this.canvasKit.MakeSurface(outputWidth, outputHeight)',
    'if (!pixels)',
    'const directReadIsExact',
    'original.readPixels(directX, directY, imageInfo)',
    'this.imageEffectDiagnostics.directImageReadbackPreprocesses += 1',
  ],
  'CanvasKit image effects must recover exact integer sampling through direct image readback when offscreen surfaces fail',
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
  textReplayUtilsSource.includes('export function tabLeaderLineSegments('),
  true,
  'tab leader fillType geometry must live in shared native-ready text helpers',
);
assertTokensInOrder(
  extractFunctionBody(textReplayUtilsSource, 'tabLeaderLineSegments'),
  [
    'case 0:',
    'case 1:',
    'case 2:',
    'case 3:',
    'case 4:',
    'case 5:',
    'case 6:',
    'case 7:',
    'case 8:',
    'case 9:',
    'case 10:',
    'case 11:',
  ],
  'shared tab leader geometry must cover none plus all eleven HWP fill variants',
);
assert.equal(
  importBlockFrom(canvas2dSource, './text-replay-utils').includes('tabLeaderLineSegments')
    && importBlockFrom(canvaskitSource, './text-replay-utils').includes('tabLeaderLineSegments'),
  true,
  'Canvas2D and CanvasKit must import the shared tab leader geometry helper',
);
assert(
  extractMethodBody(canvas2dSource, 'drawTabLeaders').includes('tabLeaderLineSegments(leader.fillType)')
    && extractMethodBody(canvaskitSource, 'drawTabLeaders').includes('tabLeaderLineSegments(leader.fillType)'),
  'Canvas2D and CanvasKit tab leader replay must share fillType geometry',
);
assert.equal(
  textReplayUtilsSource.includes('export function textDecorationEmphasisGeometry(')
    && textReplayUtilsSource.includes('export function textDecorationEmphasisPosition(')
    && textReplayUtilsSource.includes('export function textDecorationEmphasisSize(')
    && textReplayUtilsSource.includes('export function textDecorationLineGeometry(')
    && textReplayUtilsSource.includes('export function textDecorationLineY('),
  true,
  'text decoration visual policy must live in shared native-ready text helpers',
);
assertTokensInOrder(
  extractFunctionBody(textReplayUtilsSource, 'textDecorationLineGeometry'),
  [
    'case 1:',
    'case 2:',
    'case 3:',
    'case 4:',
    'case 5:',
    'case 6:',
    'case 7:',
    'case 8:',
    'case 9:',
    'case 10:',
    'case 11:',
    'case 12:',
  ],
  'shared text decoration geometry must cover all HWP line shape variants',
);
assertTokensInOrder(
  extractFunctionBody(textReplayUtilsSource, 'textDecorationEmphasisGeometry'),
  ['case 1:', 'case 2:', 'case 3:', 'case 4:', 'case 5:', 'case 6:'],
  'shared emphasis geometry must cover all six HWP emphasis mark variants',
);
assert.equal(
  importBlockFrom(canvas2dSource, './text-replay-utils').includes('textDecorationEmphasisGeometry')
    && importBlockFrom(canvas2dSource, './text-replay-utils').includes('textDecorationEmphasisPosition')
    && importBlockFrom(canvas2dSource, './text-replay-utils').includes('textDecorationEmphasisSize')
    && importBlockFrom(canvas2dSource, './text-replay-utils').includes('textDecorationLineGeometry')
    && importBlockFrom(canvas2dSource, './text-replay-utils').includes('textDecorationLineY')
    && importBlockFrom(canvaskitSource, './text-replay-utils').includes('textDecorationEmphasisGeometry')
    && importBlockFrom(canvaskitSource, './text-replay-utils').includes('textDecorationEmphasisPosition')
    && importBlockFrom(canvaskitSource, './text-replay-utils').includes('textDecorationEmphasisSize')
    && importBlockFrom(canvaskitSource, './text-replay-utils').includes('textDecorationLineGeometry')
    && importBlockFrom(canvaskitSource, './text-replay-utils').includes('textDecorationLineY'),
  true,
  'Canvas2D and CanvasKit must import the shared text decoration helpers',
);
for (const [label, source] of [
  ['Canvas2D', canvas2dSource],
  ['CanvasKit', canvaskitSource],
]) {
  const drawEmphasisBody = extractMethodBody(source, 'drawEmphasisMark');
  assert(
    drawEmphasisBody.includes('textDecorationEmphasisGeometry('),
    `${label} emphasis replay must consume shared deterministic geometry`,
  );
  assert(
    !drawEmphasisBody.includes('makeTextObjects(')
      && !drawEmphasisBody.includes('fillText(')
      && !drawEmphasisBody.includes('drawText('),
    `${label} emphasis replay must not depend on font glyph fallback`,
  );
  assert(
    extractMethodBody(source, 'renderTextRun').includes('this.drawEmphasisMark(')
      && extractMethodBody(source, 'renderTextDecoration').includes('this.drawEmphasisMark('),
    `${label} inline and standalone emphasis replay must share the geometry path`,
  );
  assert(
    extractMethodBody(source, 'drawTextDecorationLine').includes('textDecorationLineGeometry('),
    `${label} decoration lines must consume shared deterministic geometry`,
  );
  assert(
    extractMethodBody(source, 'renderTextRun').includes('this.drawTextDecorationLine(')
      && extractMethodBody(source, 'renderTextDecoration').includes('this.drawTextDecorationLine('),
    `${label} inline and standalone decoration lines must share the geometry path`,
  );
}
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
assert.equal(
  layerTypesSource.includes('superscript: boolean;')
    && layerTypesSource.includes('subscript: boolean;'),
  true,
  'browser layer text style must retain superscript and subscript paint semantics',
);
assert.equal(
  textReplayUtilsSource.includes('export function textScriptMetrics('),
  true,
  'script font scaling and baseline policy must live in shared native-ready text helpers',
);
assert.equal(
  textReplayUtilsSource.includes("new Intl.Segmenter(undefined, { granularity: 'grapheme' })"),
  true,
  'browser text replay must preserve grapheme clusters before applying authored positions',
);
for (const [label, source] of [
  ['Canvas2D', canvas2dSource],
  ['CanvasKit', canvaskitSource],
]) {
  const renderTextRun = extractMethodBody(source, 'renderTextRun');
  assertTokensInOrder(
    renderTextRun,
    [
      'const baseFontSize = op.style.fontSize || 12',
      'textScriptMetrics(',
      'op.style.superscript',
      'op.style.subscript',
      'baselineShift',
    ],
    `${label} text replay must preserve shared superscript/subscript metrics`,
  );
}
const canvaskitTextRun = extractMethodBody(canvaskitSource, 'renderTextRun');
assertTokensInOrder(
  canvaskitTextRun,
  [
    'const requiresScriptMetricShaping = (op.style.superscript || op.style.subscript)',
    'const requiresHangulClusterShaping = clusters.some',
    'const requiresComplexClusterShaping = clusters.some',
    'const canUseClusterParagraph = (',
    '|| requiresComplexClusterShaping',
    'if (canUseClusterParagraph)',
    'const fontFamilies = [...clusterFontFamilies, ...fallbackFamilies]',
    'this.fontRegistry.resolveProviderFamily(',
    'family,',
    'renderFontWeight,',
    'op.style.italic,',
    'for (const cluster of clusters)',
    'const x = positions[cluster.start]',
    'this.canvasKit.ParagraphBuilder.MakeFromFontProvider(',
    'this.fontProvider',
    'builder.addText(cluster.text)',
    'paragraph.layout(CanvasKitLayerRenderer.MAX_SHAPED_TEXT_WIDTH)',
    'const baseline = paragraph.getAlphabeticBaseline()',
    'paragraphs.push({ paragraph, x, baseline })',
    'builder.delete()',
    'if (paragraphsReady)',
    'canvas.drawParagraph(',
    'originX + entry.x',
    'originY - entry.baseline',
    'entry.paragraph.delete()',
  ],
  'CanvasKit must shape positioned script, old-Hangul, and ordinary complex-script graphemes through the registered font provider',
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
assert.equal(
  importBlockFrom(canvaskitSource, './canvaskit/replay-plane').includes('CANVASKIT_REPLAY_PLANES')
    && importBlockFrom(canvaskitSource, './canvaskit/replay-plane').includes('layerPaintOpReplayPlane'),
  true,
  'CanvasKit renderer must import shared replay plane ordering and op classification',
);
assert.equal(
  importBlockFrom(canvas2dSource, './canvaskit/replay-plane').includes('LAYER_REPLAY_PLANES')
    && importBlockFrom(canvas2dSource, './canvaskit/replay-plane').includes('layerPaintOpReplayPlane'),
  true,
  'Canvas2D renderer must import the same replay plane ordering and op classification',
);
assertTokensInOrder(
  canvaskitReplayPlaneSource,
  [
    "'background'",
    "'behindText'",
    "'flow'",
    "'inFrontOfText'",
    "op.type === 'pageBackground'",
    "op.wrap === 'behindText'",
    "op.wrap === 'inFrontOfText'",
  ],
  'CanvasKit replay plane helper must keep HWP z-order plane classification',
);
assertTokensInOrder(
  extractMethodBody(canvaskitSource, 'renderSurface'),
  [
    'for (const replayPlane of CANVASKIT_REPLAY_PLANES)',
    'this.renderNode(canvas, tree.root, replayPlane)',
  ],
  'CanvasKit renderSurface must replay the layer tree once per z-order plane',
);
assertTokensInOrder(
  extractMethodBody(canvas2dSource, 'renderPage'),
  [
    'for (const replayPlane of LAYER_REPLAY_PLANES)',
    'this.renderNode(ctx, tree.root, replayPlane)',
  ],
  'Canvas2D renderPage must replay the layer tree once per z-order plane',
);
assertTokensInOrder(
  extractMethodBody(canvas2dSource, 'renderLeafNode'),
  [
    "replayPlane === 'flow'",
    'this.textVariantSelectionDiagnostics.push(...selectedResult.reports)',
    'layerPaintOpReplayPlane(op) !== replayPlane',
    'continue',
    'shouldRenderLayerTextVariant(op, selectedTextVariants)',
    'this.renderOp(ctx, op)',
  ],
  'Canvas2D leaf replay must select text once and filter paint ops by replay plane',
);
assertTokensInOrder(
  extractMethodBody(canvaskitSource, 'renderLeafNode'),
  [
    'layerPaintOpReplayPlane(op) !== replayPlane',
    'continue',
    'shouldRenderLayerTextVariant(op, selectedTextVariants)',
    'this.renderOp(canvas, op)',
  ],
  'CanvasKit leaf replay must filter by replay plane before selected text variant rendering',
);
assertTokensInOrder(
  extractMethodBody(canvaskitSource, 'makePath'),
  [
    'let hasCurrentPoint = false',
    "case 'moveTo'",
    'hasCurrentPoint = true',
    "case 'arcTo'",
    'if (!hasCurrentPoint)',
    'builder.moveTo(command.x, command.y)',
    'builder.arcToRotated',
  ],
  'CanvasKit path replay must normalize an initial SVG arc to its endpoint current point',
);
assert.equal(
  staticPictureCacheSource.includes('replayPlane: CanvasKitReplayPlane')
    && staticPictureCacheSource.includes('profile,')
    && staticPictureCacheSource.includes('replayPlane,'),
  true,
  'CanvasKit static picture cache keys must separate cached pictures by replay plane',
);
assertTokensInOrder(
  extractMethodBody(canvaskitSource, 'renderNode'),
  [
    "node.cacheHint === 'staticSubtree'",
    'let hasReplayPlane = false',
    'const pendingNodes: LayerNode[] = [...node.children]',
    'layerTextVariantOpsForLeaf(',
    'candidate.ops',
    'this.lastRenderedTree?.variantOps',
    'layerPaintOpReplayPlane(op) === replayPlane',
    'if (!hasReplayPlane)',
    'return;',
    'this.staticPictureCache.keyForStaticSubtree',
  ],
  'CanvasKit static picture cache must skip replay planes with no root or sidecar paint ops',
);
assertTokensInOrder(
  rustPaintReplayOrderSource,
  [
    'Self::Background',
    'Self::BehindText',
    'Self::Flow',
    'Self::InFrontOfText',
    'PaintOp::PageBackground',
    'TextWrap::BehindText',
    'TextWrap::InFrontOfText',
  ],
  'Rust replay order helper must keep HWP z-order plane classification',
);
assert.equal(
  rustPaintReplayOrderSource.includes('pub fn layer_node_has_replay_plane')
    && rustPaintReplayOrderSource.includes('sidecars_for_leaf_ops(ops, sidecar_ops)')
    && rustPaintReplayOrderSource.includes('LayerNodeKind::ClipRect'),
  true,
  'Rust replay order helper must own PageLayerTree subtree plane detection including sidecar variants and clips',
);
assert.equal(
  rustCanvaskitPolicySource.includes('replayPlane')
    && rustCanvaskitPolicySource.includes('item.replay_plane = Some(paint_op_replay_plane(op))'),
  true,
  'CanvasKit replay plan diagnostics must expose each paint op replay plane',
);
assertTokensInOrder(
  rustSkiaRendererSource,
  [
    'for replay_plane in PaintReplayPlane::ORDERED',
    'self.render_node(',
    'replay_plane',
  ],
  'native Skia renderer must replay the layer tree once per z-order plane',
);
assert.equal(
  rustSkiaRendererSource.includes('layer_node_has_replay_plane(node, variant_ops, replay_plane)')
    && rustSvgRendererSource.includes('layer_node_has_replay_plane(node, variant_ops, replay_plane)'),
  true,
  'native Skia and layer SVG renderers must share PageLayerTree replay-plane subtree detection',
);
assertTokensInOrder(
  rustSkiaRendererSource,
  [
    'cache_key.mix_str(replay_plane.as_str())',
    'cache_key.mix_layer_node_with_sidecars(node, resources, variant_ops)',
  ],
  'native Skia static picture cache key must include replay plane before subtree payload fingerprint',
);
assertTokensInOrder(
  rustSkiaRendererSource,
  [
    'if paint_op_replay_plane(op) != replay_plane',
    'continue;',
    'should_render_selected_text_variant(op, &selection.selected)',
    'self.render_op(canvas, op, resources, replay)',
  ],
  'native Skia leaf replay must filter by replay plane before selected text variant rendering',
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
assertTokensInOrder(
  canvas2dGlyphOutlineReplayBlock,
  [
    'const imageIndex = resolveLayerResourceIndex(',
    'payload?.imageResourceId',
    'this.currentResources?.imageKeys',
    'this.getDomImage(imageIndex)',
  ],
  'Canvas2D BitmapGlyph replay must resolve images through resource ids before drawing',
);
assertTokensInOrder(
  canvas2dGlyphOutlineReplayBlock,
  [
    'const imageIndex = resolveLayerResourceIndex(',
    'const transform = payload.placement?.runToPage',
    'const payloadTransform = payload.transformToRun',
    'ctx.transform(',
    'transform.a',
    'if (payloadTransform)',
    'payloadTransform.a',
    'this.drawDomImage(',
  ],
  'Canvas2D BitmapGlyph replay must apply run placement before payload-local transform and drawing',
);
assertTokensInOrder(
  canvas2dGlyphOutlineReplayBlock,
  [
    'const previousImageSmoothingEnabled = ctx.imageSmoothingEnabled',
    "ctx.imageSmoothingEnabled = payload.filtering !== 'nearest'",
    'this.drawDomImage(',
    'ctx.imageSmoothingEnabled = previousImageSmoothingEnabled',
  ],
  'Canvas2D BitmapGlyph replay must apply deterministic sampling and restore image smoothing',
);
assertTokensInOrder(
  canvas2dGlyphOutlineReplayBlock,
  [
    'this.drawDomImage(',
    'x: 0',
    'y: 0',
    'width',
    'height',
  ],
  'Canvas2D BitmapGlyph replay must draw image strikes at the payload-local origin',
);
assertTokensInOrder(
  canvas2dGlyphOutlineReplayBlock,
  [
    'const vectorIndex = resolveLayerResourceIndex(',
    'payload?.vectorResourceId',
    'this.currentResources?.svgKeys',
    'const fragment = this.currentResources?.svgFragments?.[vectorIndex]',
  ],
  'Canvas2D SvgGlyph replay must resolve vectors through resource ids before parsing',
);
assertTokensInOrder(
  canvas2dGlyphOutlineReplayBlock,
  [
    'const vectorIndex = resolveLayerResourceIndex(',
    'const transform = payload.placement?.runToPage',
    'const payloadTransform = payload.transformToRun',
    'ctx.transform(',
    'transform.a',
    'if (payloadTransform)',
    'payloadTransform.a',
    'ctx.scale(width / viewBox.width, height / viewBox.height)',
    'ctx.translate(-viewBox.x, -viewBox.y)',
  ],
  'Canvas2D SvgGlyph replay must apply run placement before payload-local and viewBox transforms',
);
assertTokensInOrder(
  canvas2dGlyphOutlineReplayBlock,
  [
    'ctx.scale(width / viewBox.width, height / viewBox.height)',
    'ctx.translate(-viewBox.x, -viewBox.y)',
    'for (const layer of pathLayers)',
    'if (layer.transform)',
    'layer.transform.a',
    'const path = new Path2D(layer.pathData)',
  ],
  'Canvas2D SvgGlyph replay must apply path-layer transforms after viewBox normalization',
);
assertTokensInOrder(
  canvas2dGlyphOutlineReplayBlock,
  [
    'const previousAlpha = ctx.globalAlpha',
    'if (layer.fill !== null)',
    'ctx.fillStyle = layer.fill',
    'ctx.globalAlpha = previousAlpha * layer.opacity',
    "ctx.fill(path, layer.fillRule ?? 'nonzero')",
    'ctx.globalAlpha = previousAlpha',
  ],
  'Canvas2D SvgGlyph replay must preserve fill opacity and fill-rule contracts',
);
assertTokensInOrder(
  canvas2dGlyphOutlineReplayBlock,
  [
    'if (layer.stroke)',
    'ctx.strokeStyle = layer.stroke.color',
    'ctx.lineWidth = layer.stroke.width',
    'ctx.lineJoin = layer.stroke.lineJoin',
    'ctx.lineCap = layer.stroke.lineCap',
    'ctx.miterLimit = layer.stroke.miterLimit',
    'ctx.setLineDash(layer.stroke.dashArray ?? [])',
    'ctx.lineDashOffset = layer.stroke.dashOffset',
    'ctx.globalAlpha = previousAlpha * layer.stroke.opacity',
    'ctx.stroke(path)',
  ],
  'Canvas2D SvgGlyph replay must preserve stroke style and dash contracts',
);
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
  'node.composite!.backdropNodeId',
  'node.composite!.sourceNodeId',
  "node.kind === 'clip'",
  'callbacks.withClip(node.clip',
  'node.clip!.childNodeId',
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
  '!payload.stroke',
  'payload.bitmapGlyph === undefined',
  'payload.svgGlyph === undefined',
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
const colrv1ColorGraphContractBlock = extractFunctionBody(textVariantsSource, 'hasColrv1ColorGraphContract');
for (const requiredToken of [
  "payload.payloadKind !== 'colorLayers'",
  '|| payload.stroke',
  '|| payload.bitmapGlyph !== undefined',
  '|| payload.svgGlyph !== undefined',
  "colorLayers?.colorFormat !== 'colrV1'",
  'colorLayers.layers.length !== 0',
  'graph.nodes.length > MAX_COLRV1_GRAPH_NODES',
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
  'depth > MAX_COLRV1_GRAPH_DEPTH',
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
    if (
      label === canvaskitBrowserDecodeBridgeFile
      && canvaskitBrowserDecodeBridgeApis.has(apiName)
    ) {
      continue;
    }
    assert.equal(
      pattern.test(source),
      false,
      `CanvasKit renderer source must not depend on ${apiName}: ${label}`,
    );
  }
}
assert.equal(
  canvaskitResourceCacheSource.includes('MakeImageFromCanvasImageSource(image)')
    && canvaskitResourceCacheSource.includes('new Blob([imageBytes], { type: mimeType })')
    && canvaskitResourceCacheSource.includes("imageHeader.format === 'svg'"),
  true,
  'the bounded browser image decode bridge must terminate SVG and raster recovery in a direct CanvasKit image',
);
assert.equal(
  canvaskitResourceCacheSource.includes('browserDecodedRasterRecoveries')
    && canvaskitResourceCacheSource.includes("reason: 'encodedImageDecodeFailed'")
    && canvaskitResourceCacheSource.includes("fallback: 'browserImageSource'"),
  true,
  'CanvasKit must inventory successful raster browser-decoder recoveries without reporting a runtime image failure',
);
for (const forbiddenOverlayToken of [
  'document.createElement',
  '.getContext(',
  '.drawImage(',
  'Canvas2DLayerRenderer',
]) {
  assert.equal(
    canvaskitResourceCacheSource.includes(forbiddenOverlayToken),
    false,
    `the embedded-SVG decode bridge must not composite through Canvas2D: ${forbiddenOverlayToken}`,
  );
}

console.log('renderer backend contract parity passed');
