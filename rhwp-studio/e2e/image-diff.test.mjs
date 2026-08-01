import assert from 'node:assert/strict';

import { PNG } from 'pngjs';

import { comparePngBuffers } from './helpers.mjs';

function makeWhitePng(width, height) {
  const image = new PNG({ width, height });
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = 255;
    image.data[i + 1] = 255;
    image.data[i + 2] = 255;
    image.data[i + 3] = 255;
  }
  return image;
}

function drawVerticalLine(image, x, y1, y2) {
  for (let y = y1; y <= y2; y++) {
    const base = (y * image.width + x) * 4;
    image.data[base] = 0;
    image.data[base + 1] = 0;
    image.data[base + 2] = 0;
    image.data[base + 3] = 255;
  }
}

async function main() {
  const base = makeWhitePng(8, 8);
  drawVerticalLine(base, 3, 1, 6);

  const shiftedByOne = PNG.sync.read(PNG.sync.write(base));
  shiftedByOne.data.fill(255);
  for (let i = 3; i < shiftedByOne.data.length; i += 4) {
    shiftedByOne.data[i] = 255;
  }
  drawVerticalLine(shiftedByOne, 4, 1, 6);

  const shiftedByTwo = PNG.sync.read(PNG.sync.write(base));
  shiftedByTwo.data.fill(255);
  for (let i = 3; i < shiftedByTwo.data.length; i += 4) {
    shiftedByTwo.data[i] = 255;
  }
  drawVerticalLine(shiftedByTwo, 5, 1, 6);

  const shiftedByOneDiff = await comparePngBuffers(PNG.sync.write(base), PNG.sync.write(shiftedByOne), {
    ignoreChannelDelta: 8,
    inkMaskWhiteDelta: 25,
    inkMaskAlphaThreshold: 8,
    inkMaskNeighborhoodRadius: 1,
    inkMaskMaxDiffPixels: 0,
  });
  assert.equal(shiftedByOneDiff.passed, true);
  assert.ok(shiftedByOneDiff.rawTolerantDiffPixels > 0);
  assert.equal(shiftedByOneDiff.rawInkMaskDiffPixels, 0);
  console.log('PASS: 1px neighborhood shift is tolerated by ink-mask diff');

  const shiftedByOneCombinedBudget = await comparePngBuffers(PNG.sync.write(base), PNG.sync.write(shiftedByOne), {
    ignoreChannelDelta: 8,
    maxDiffPixels: 0,
    inkMaskWhiteDelta: 25,
    inkMaskAlphaThreshold: 8,
    inkMaskNeighborhoodRadius: 1,
    inkMaskMaxDiffPixels: 0,
  });
  assert.equal(shiftedByOneCombinedBudget.passed, false);
  assert.equal(shiftedByOneCombinedBudget.tolerantBudgetPassed, false);
  assert.equal(shiftedByOneCombinedBudget.inkMaskBudgetPassed, true);
  assert.equal(shiftedByOneCombinedBudget.passMetric, 'combined');
  console.log('PASS: combined diff budget rejects shifts that only ink-mask would ignore');

  const shiftedByTwoDiff = await comparePngBuffers(PNG.sync.write(base), PNG.sync.write(shiftedByTwo), {
    ignoreChannelDelta: 8,
    maxDiffPixels: 0,
    inkMaskWhiteDelta: 25,
    inkMaskAlphaThreshold: 8,
    inkMaskNeighborhoodRadius: 1,
    inkMaskMaxDiffPixels: 0,
  });
  assert.equal(shiftedByTwoDiff.passed, false);
  assert.equal(shiftedByTwoDiff.tolerantBudgetPassed, false);
  assert.equal(shiftedByTwoDiff.inkMaskBudgetPassed, false);
  assert.ok(shiftedByTwoDiff.rawInkMaskDiffPixels > 0);
  console.log('PASS: 2px shift still fails ink-mask diff');

  const wrongFillExpected = makeWhitePng(9, 9);
  const wrongFillActual = makeWhitePng(9, 9);
  for (let i = 0; i < wrongFillExpected.data.length; i += 4) {
    wrongFillExpected.data[i] = 48;
    wrongFillExpected.data[i + 1] = 112;
    wrongFillExpected.data[i + 2] = 176;
    wrongFillActual.data[i] = 80;
    wrongFillActual.data[i + 1] = 144;
    wrongFillActual.data[i + 2] = 208;
  }
  const wrongFillDiff = await comparePngBuffers(
    PNG.sync.write(wrongFillExpected),
    PNG.sync.write(wrongFillActual),
    {
      ignoreChannelDelta: 8,
      inkMaskWhiteDelta: 25,
      inkMaskAlphaThreshold: 8,
      inkMaskNeighborhoodRadius: 1,
      solidInkMaxDiffPixels: 0,
    },
  );
  assert.equal(wrongFillDiff.passed, false);
  assert.equal(wrongFillDiff.rawSolidInkDiffPixels, 81);
  console.log('PASS: flat fill color mismatch still fails solid-ink diff');

  const rasterExpected = makeWhitePng(9, 9);
  const rasterActual = makeWhitePng(9, 9);
  for (let i = 0; i < rasterExpected.data.length; i += 4) {
    rasterExpected.data[i] = rasterActual.data[i] = 96;
    rasterExpected.data[i + 1] = rasterActual.data[i + 1] = 176;
    rasterExpected.data[i + 2] = rasterActual.data[i + 2] = 216;
  }
  for (let y = 1; y <= 7; y++) {
    for (const [x, expectedRgb, actualRgb] of [
      [3, [72, 136, 168], [80, 146, 180]],
      [4, [24, 40, 56], [36, 54, 72]],
      [5, [72, 136, 168], [80, 146, 180]],
    ]) {
      const base = (y * rasterExpected.width + x) * 4;
      rasterExpected.data.set(expectedRgb, base);
      rasterActual.data.set(actualRgb, base);
    }
  }
  const rasterDiff = await comparePngBuffers(
    PNG.sync.write(rasterExpected),
    PNG.sync.write(rasterActual),
    {
      ignoreChannelDelta: 8,
      inkMaskWhiteDelta: 25,
      inkMaskAlphaThreshold: 8,
      inkMaskNeighborhoodRadius: 1,
      solidInkMaxDiffPixels: 0,
    },
  );
  assert.equal(rasterDiff.passed, true);
  assert.ok(rasterDiff.rawTolerantDiffPixels > 0);
  assert.equal(rasterDiff.rawSolidInkDiffPixels, 0);
  console.log('PASS: antialiased raster variation over a colored fill is not solid ink');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
