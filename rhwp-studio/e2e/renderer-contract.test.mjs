import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const studioRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const canvas2dPath = path.join(studioRoot, 'src/view/canvas2d-layer-renderer.ts');
const canvaskitPath = path.join(studioRoot, 'src/view/canvaskit-renderer.ts');
const canvaskitDirectory = path.join(studioRoot, 'src/view/canvaskit');
const layerCanvasUtilsPath = path.join(studioRoot, 'src/view/layer-canvas-utils.ts');

const canvas2dSource = fs.readFileSync(canvas2dPath, 'utf8');
const canvaskitSource = fs.readFileSync(canvaskitPath, 'utf8');
const layerCanvasUtilsSource = fs.readFileSync(layerCanvasUtilsPath, 'utf8');
const canvaskitSourceFiles = [
  { label: path.relative(studioRoot, canvaskitPath), source: canvaskitSource },
  ...fs.readdirSync(canvaskitDirectory)
    .filter((fileName) => fileName.endsWith('.ts'))
    .sort()
    .map((fileName) => {
      const filePath = path.join(canvaskitDirectory, fileName);
      return {
        label: path.relative(studioRoot, filePath),
        source: fs.readFileSync(filePath, 'utf8'),
      };
    }),
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

function caseLabels(methodBody) {
  return [...methodBody.matchAll(/case\s+'([^']+)'/g)].map((match) => match[1]);
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

compareCaseContract('renderOp', 'LayerPaintOp dispatch');
compareCaseContract('renderFormObject', 'form object replay');
compareCaseContract('renderLine', 'line style replay');
compareCaseContract('resolveImagePlacement', 'image fill placement');
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
compareCaseLabels(
  caseLabels(extractFunctionBody(layerCanvasUtilsSource, 'renderEquationLayoutBox')),
  caseLabels(extractMethodBody(canvaskitSource, 'renderEquationBox')),
  'equation layout replay',
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
