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
const imageEffectPixelsPath = path.join(studioRoot, 'src/view/image-effect-pixels.ts');
const layerGeometryUtilsPath = path.join(studioRoot, 'src/view/layer-geometry-utils.ts');
const staticSvgPathLayersPath = path.join(studioRoot, 'src/view/static-svg-path-layers.ts');
const textReplayUtilsPath = path.join(studioRoot, 'src/view/text-replay-utils.ts');
const textVariantsPath = path.join(studioRoot, 'src/core/text-variants.ts');
const layerCanvasUtilsPath = path.join(studioRoot, 'src/view/layer-canvas-utils.ts');
const canvaskitParityPlanDocPath = path.join(repoRoot, 'docs/canvaskit-parity-implementation.md');
const textIrV2DocPath = path.join(repoRoot, 'docs/text-ir-v2.md');

const canvas2dSource = fs.readFileSync(canvas2dPath, 'utf8');
const canvaskitSource = fs.readFileSync(canvaskitPath, 'utf8');
const canvaskitFontsSource = fs.readFileSync(canvaskitFontsPath, 'utf8');
const canvaskitResourceCacheSource = fs.readFileSync(canvaskitResourceCachePath, 'utf8');
const glyphOutlinePayloadStatusSource = fs.readFileSync(glyphOutlinePayloadStatusPath, 'utf8');
const imageEffectPixelsSource = fs.readFileSync(imageEffectPixelsPath, 'utf8');
const layerGeometryUtilsSource = fs.readFileSync(layerGeometryUtilsPath, 'utf8');
const staticSvgPathLayersSource = fs.readFileSync(staticSvgPathLayersPath, 'utf8');
const textReplayUtilsSource = fs.readFileSync(textReplayUtilsPath, 'utf8');
const textVariantsSource = fs.readFileSync(textVariantsPath, 'utf8');
const layerCanvasUtilsSource = fs.readFileSync(layerCanvasUtilsPath, 'utf8');
const textIrV2DocSource = fs.readFileSync(textIrV2DocPath, 'utf8');
const normalizedTextIrV2DocSource = textIrV2DocSource.replace(/\s+/g, ' ');

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
  { label: path.relative(studioRoot, imageEffectPixelsPath), source: imageEffectPixelsSource },
  { label: path.relative(studioRoot, layerGeometryUtilsPath), source: layerGeometryUtilsSource },
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
  const bodyStart = source.indexOf('{', signatureIndex);
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
  const signatureIndex = source.indexOf(`private ${methodName}(`);
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

compareCaseContract('renderNode', 'LayerNode dispatch');
compareCaseContract('renderOp', 'LayerPaintOp dispatch');
compareCaseContract('renderFormObject', 'form object replay');
compareCaseContract('renderLine', 'line style replay');
compareCaseContract('resolveImagePlacement', 'image fill placement');
assert.deepEqual(
  stringEqualityLiterals(extractMethodBody(canvas2dSource, 'drawDomImage'), 'fillMode'),
  stringEqualityLiterals(extractMethodBody(canvaskitSource, 'drawEncodedImage'), 'fillMode'),
  'image fill-mode replay branches must stay aligned between Canvas2D and CanvasKit',
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
compareCaseLabels(
  caseLabels(extractFunctionBody(canvas2dSource, 'strokeDashPattern')),
  caseLabels(extractMethodBody(canvaskitSource, 'strokeDashPattern')),
  'line dash replay',
);
assert(
  extractMethodBody(canvas2dSource, 'makeGradientStyle').includes('gradientColorStops(')
    && extractMethodBody(canvaskitSource, 'makeGradientShader').includes('gradientColorStops('),
  'Canvas2D and CanvasKit gradient replay must share stop normalization',
);
compareCaseLabels(
  caseLabels(extractFunctionBody(layerCanvasUtilsSource, 'renderEquationLayoutBox')),
  caseLabels(extractMethodBody(canvaskitSource, 'renderEquationBox')),
  'equation layout replay',
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
  canvaskitFontsSource.includes("from '../layer-canvas-utils'"),
  false,
  'CanvasKit font registry must use native-ready image/font helpers instead of broad Canvas2D utilities',
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
assert.equal(
  canvaskitSource.includes("from './text-replay-utils'"),
  true,
  'CanvasKit renderer must import shared text replay helpers from the native-ready module',
);
for (const geometryHelperName of [
  'angleToCanvasCoords',
  'calculateArrowDimensions',
  'computePathPaintBounds',
  'effectiveLayerImageBounds',
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
