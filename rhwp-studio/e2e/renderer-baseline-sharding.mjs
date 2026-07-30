import { createHash } from 'node:crypto';

export const RENDERER_BASELINE_SHARD_ALGORITHM = 'sha256-first64-be';

export function normalizeRendererBaselineShard(shardIndex = 0, shardCount = 1) {
  const index = Number(shardIndex);
  const count = Number(shardCount);
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new Error(
      `renderer baseline shard count must be a positive integer: ${shardCount}`,
    );
  }
  if (!Number.isSafeInteger(index) || index < 0 || index >= count) {
    throw new Error(
      `renderer baseline shard index must be an integer in [0, ${count}): ${shardIndex}`,
    );
  }
  return {
    index,
    count,
    algorithm: RENDERER_BASELINE_SHARD_ALGORITHM,
  };
}

export function rendererBaselineSampleShard(sample, shardCount) {
  const { count } = normalizeRendererBaselineShard(0, shardCount);
  const identity = `${String(sample.id)}\0${String(sample.file)}\0${String(sample.page ?? 0)}`;
  const digest = createHash('sha256').update(identity, 'utf8').digest();
  return Number(digest.readBigUInt64BE(0) % BigInt(count));
}

export function selectRendererBaselineShard(samples, shardIndex = 0, shardCount = 1) {
  const shard = normalizeRendererBaselineShard(shardIndex, shardCount);
  return samples.filter(
    (sample) => rendererBaselineSampleShard(sample, shard.count) === shard.index,
  );
}
