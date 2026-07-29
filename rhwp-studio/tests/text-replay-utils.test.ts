import test from 'node:test';
import assert from 'node:assert/strict';

import { splitIntoClusters } from '../src/view/text-replay-utils.ts';

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
