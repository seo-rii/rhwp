import test from 'node:test';
import assert from 'node:assert/strict';

import {
  containsOldHangulJamo,
  mapPuaBulletChar,
  mapPuaDisplayText,
  puaToDisplayText,
  splitIntoClusters,
  verticalPresentationBaseText,
} from '../src/view/text-replay-utils.ts';

test('old-Hangul detection covers modern and extended jamo anywhere in a cluster', () => {
  assert.equal(containsOldHangulJamo('ᄒᆞᆫ'), true);
  assert.equal(containsOldHangulJamo(`x${String.fromCodePoint(0xa960)}`), true);
  assert.equal(containsOldHangulJamo(String.fromCodePoint(0xd7b0)), true);
  assert.equal(containsOldHangulJamo('한글'), false);
});

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
    [0xF0A0, '\u00B7'],
    [0xF0E8, '\u2794'],
    [0xF003B, '\u2193'],
    [0xF012B, '(\uC778)'],
    [0xF02EF, '\u00B7'],
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
    [0xF080F, '\u2501'],
    [0xF0811, '\u250C'],
    [0xF0817, '\u2514'],
    [0xF081A, '\u2500'],
    [0xF0854, '\u300A'],
    [0xF0855, '\u300B'],
  ] as const;

  for (const [codePoint, display] of cases) {
    assert.equal(puaToDisplayText(String.fromCodePoint(codePoint)), display);
  }
  assert.equal(
    mapPuaDisplayText(cases.map(([codePoint]) => String.fromCodePoint(codePoint)).join('')),
    '\u00B7\u2794\u2193(\uC778)\u00B7\u25BA\u25A0\u21B5\u25A1'
      + '\uD55C\uAE00\uACFC\uCEF4\uD4E8\uD130\u2501\u250C\u2514\u2500\u300A\u300B',
  );
  for (const codePoint of [0xF00DA, 0xF03E0, 0xF0827]) {
    assert.equal(puaToDisplayText(String.fromCodePoint(codePoint)), null);
    assert.equal(
      mapPuaDisplayText(String.fromCodePoint(codePoint)),
      String.fromCodePoint(codePoint),
    );
  }
  assert.equal(mapPuaBulletChar(String.fromCodePoint(0xF0A0)), '\u00B7');
  assert.equal(mapPuaBulletChar(String.fromCodePoint(0xF0A7)), '\u25AA');
  for (const codePoint of [0xF00DA, 0xF0827, 0xF02B1, 0xF02C4]) {
    assert.equal(
      mapPuaBulletChar(String.fromCodePoint(codePoint)),
      String.fromCodePoint(codePoint),
    );
  }
});

test('vertical presentation forms expose their rotatable base glyphs', () => {
  const cases = [
    ['\uFE19', '\u2026'],
    ['\uFE31', '\u2014'],
    ['\uFE32', '\u2013'],
    ['\uFE33', '_'],
    ['\uFE34', '~'],
    ['\uFE35', '('],
    ['\uFE36', ')'],
    ['\uFE37', '{'],
    ['\uFE38', '}'],
    ['\uFE39', '['],
    ['\uFE3A', ']'],
    ['\uFE3B', '\u3010'],
    ['\uFE3C', '\u3011'],
    ['\uFE3D', '\u300A'],
    ['\uFE3E', '\u300B'],
    ['\uFE3F', '\u3008'],
    ['\uFE40', '\u3009'],
    ['\uFE41', '\u300C'],
    ['\uFE42', '\u300D'],
    ['\uFE43', '\u300E'],
    ['\uFE44', '\u300F'],
  ] as const;

  for (const [presentation, base] of cases) {
    assert.equal(verticalPresentationBaseText(presentation), base);
  }
  assert.equal(verticalPresentationBaseText('('), null);
  assert.equal(verticalPresentationBaseText('\uFE35\uFE36'), null);
});
