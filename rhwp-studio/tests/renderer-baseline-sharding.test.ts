import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeRendererBaselineShard,
  rendererBaselineSampleShard,
  selectRendererBaselineShard,
} from '../e2e/renderer-baseline-sharding.mjs';

const samples = Array.from({ length: 31 }, (_, index) => ({
  id: `sample-${index}`,
  file: `fixture-${index}.hwp`,
  page: index % 3,
}));

test('renderer baseline shards form a deterministic disjoint partition', () => {
  const shardCount = 5;
  const shards = Array.from(
    { length: shardCount },
    (_, shardIndex) => selectRendererBaselineShard(samples, shardIndex, shardCount),
  );
  const allIds = shards.flatMap((shard) => shard.map((sample) => sample.id));

  assert.equal(allIds.length, samples.length);
  assert.equal(new Set(allIds).size, samples.length);
  assert.deepEqual(
    [...allIds].sort(),
    samples.map((sample) => sample.id).sort(),
  );

  const reversed = [...samples].reverse();
  for (let shardIndex = 0; shardIndex < shardCount; shardIndex += 1) {
    assert.deepEqual(
      selectRendererBaselineShard(reversed, shardIndex, shardCount)
        .map((sample) => sample.id)
        .sort(),
      shards[shardIndex].map((sample) => sample.id).sort(),
    );
  }
});

test('renderer baseline shard hash has a pinned cross-language result', () => {
  assert.equal(
    rendererBaselineSampleShard(
      { id: 'paragraph-basic', file: 'paragraph.hwp', page: 0 },
      17,
    ),
    3,
  );
});

test('renderer baseline shard arguments reject invalid ranges', () => {
  assert.deepEqual(normalizeRendererBaselineShard('2', '4'), {
    index: 2,
    count: 4,
    algorithm: 'sha256-first64-be',
  });
  assert.throws(() => normalizeRendererBaselineShard(0, 0), /positive integer/);
  assert.throws(() => normalizeRendererBaselineShard(-1, 4), /integer in \[0, 4\)/);
  assert.throws(() => normalizeRendererBaselineShard(4, 4), /integer in \[0, 4\)/);
  assert.throws(() => normalizeRendererBaselineShard(1.5, 4), /integer in \[0, 4\)/);
});
