import test from 'node:test';
import assert from 'node:assert/strict';

import { isStaticSvgPathDataValid } from '../src/view/static-svg-path-data.ts';

test('static SVG path validation accepts the supported SVG command grammar', () => {
  for (const pathData of [
    'M0 0H10V10L0 10Z',
    'm1 2c3 4 5 6 7 8s9 10 11 12q1 2 3 4t5 6',
    'M0 0A10 20 45 0 1 30 40a5 5 0 105 5',
    'M10-10L.5.25',
    'M0,0 10,10 20,0',
  ]) {
    assert.equal(isStaticSvgPathDataValid(pathData), true, pathData);
  }
});

test('static SVG path validation rejects incomplete and malformed commands', () => {
  for (const pathData of [
    '',
    'L0 0',
    'M0 0L',
    'M0 0C',
    'M0 0R10 10',
    'M0 0A-1 2 0 0 1 4 5',
    'M0 0A1 2 0 2 0 4 5',
    'M0 0L10 10,',
    'M0 0L1e999 2',
  ]) {
    assert.equal(isStaticSvgPathDataValid(pathData), false, pathData);
  }
});
