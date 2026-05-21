import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const studioRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const canvas2dPath = path.join(studioRoot, 'src/view/canvas2d-layer-renderer.ts');
const canvaskitPath = path.join(studioRoot, 'src/view/canvaskit-renderer.ts');

const canvas2dSource = fs.readFileSync(canvas2dPath, 'utf8');
const canvaskitSource = fs.readFileSync(canvaskitPath, 'utf8');

function extractMethodBody(source, methodName) {
  const signatureIndex = source.indexOf(`private ${methodName}(`);
  assert.notEqual(signatureIndex, -1, `missing method ${methodName}`);

  const bodyStart = source.indexOf('{', signatureIndex);
  assert.notEqual(bodyStart, -1, `missing method body for ${methodName}`);

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

  throw new Error(`unterminated method body for ${methodName}`);
}

function caseLabels(methodBody) {
  return [...methodBody.matchAll(/case\s+'([^']+)'/g)].map((match) => match[1]);
}

function compareCaseContract(methodName, contractName) {
  const canvas2dCases = new Set(caseLabels(extractMethodBody(canvas2dSource, methodName)));
  const canvaskitCases = new Set(caseLabels(extractMethodBody(canvaskitSource, methodName)));
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

console.log('renderer backend contract parity passed');
