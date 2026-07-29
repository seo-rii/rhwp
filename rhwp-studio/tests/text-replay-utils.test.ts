import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mapPuaDisplayText,
  puaToDisplayText,
  splitIntoClusters,
} from '../src/view/text-replay-utils.ts';

test('text replay clusters preserve grapheme boundaries and scalar positions', () => {
  assert.deepEqual(
    splitIntoClusters(
      `e\u0301\u1112\u1161\u11ab\u1112\u119e\u11ab${String.fromCodePoint(0x1f468)}\u200d${String.fromCodePoint(0x1f4bb)}`,
    ),
    [
      { start: 0, startUtf16: 0, text: 'e\u0301' },
      { start: 2, startUtf16: 2, text: '\u1112\u1161\u11ab' },
      { start: 5, startUtf16: 5, text: '\u1112\u119e\u11ab' },
      {
        start: 8,
        startUtf16: 8,
        text: `${String.fromCodePoint(0x1f468)}\u200d${String.fromCodePoint(0x1f4bb)}`,
      },
    ],
  );
});

test('Hancom PUA fallback uses only the verified display table', () => {
  const cases = [
    [0xF012B, '(\uC778)'],
    [0xF02FC, '\u25BA'],
    [0xF031C, '\u25A0'],
    [0xF03A0, '\u21B5'],
    [0xF03C5, '\u25A1'],
    [0xF03EF, '\uD55C'],
    [0xF03F0, '\uAE00'],
    [0xF03F1, '\uACFC'],
    [0xF03F2, '\uCEF4'],
    [0xF03F3, '\uD4E8'],
    [0xF03F4, '\uD130'],
  ] as const;

  for (const [codePoint, display] of cases) {
    assert.equal(puaToDisplayText(String.fromCodePoint(codePoint)), display);
  }
  assert.equal(
    mapPuaDisplayText(cases.map(([codePoint]) => String.fromCodePoint(codePoint)).join('')),
    '(\uC778)\u25BA\u25A0\u21B5\u25A1\uD55C\uAE00\uACFC\uCEF4\uD4E8\uD130',
  );
  assert.equal(puaToDisplayText(String.fromCodePoint(0xF03E0)), null);
  assert.equal(
    mapPuaDisplayText(String.fromCodePoint(0xF03E0)),
    String.fromCodePoint(0xF03E0),
  );
});
