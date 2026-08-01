import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateReplayPerformanceGuard } from '../e2e/performance-guard.mjs';

const guard = {
  maxReplayRatio: 25,
  maxReplayAvgMs: 250,
  minReplayRatioBaselineMs: 5,
};

function performanceRow(overrides = {}) {
  return {
    case: 'fixture',
    canvas2dReplayAvgMs: 10,
    canvaskitReplayAvgMs: 100,
    maxCanvaskitReplayAvgMs: null,
    maxCanvaskitReplayRatio: null,
    replayRatio: 10,
    replayRatioGuard: 'checked',
    ...overrides,
  };
}

test('replay performance guard accepts values within ratio and absolute budgets', () => {
  const evaluation = evaluateReplayPerformanceGuard(performanceRow(), guard);

  assert.equal(evaluation.passed, true);
  assert.deepEqual(evaluation.checks.map((check) => check.passed), [true, true]);
});

test('replay performance guard reports ratio and absolute failures independently', () => {
  const evaluation = evaluateReplayPerformanceGuard(performanceRow({
    canvaskitReplayAvgMs: 300,
    replayRatio: 30,
  }), guard);

  assert.equal(evaluation.passed, false);
  assert.deepEqual(
    evaluation.checks.filter((check) => !check.passed).map((check) => check.kind),
    ['ratio', 'absolute'],
  );
});

test('replay performance guard honors case budgets without weakening global defaults', () => {
  const evaluation = evaluateReplayPerformanceGuard(performanceRow({
    canvaskitReplayAvgMs: 300,
    maxCanvaskitReplayAvgMs: 350,
    maxCanvaskitReplayRatio: 40,
    replayRatio: 30,
  }), guard);

  assert.equal(evaluation.passed, true);
});

test('single-iteration and small-baseline policies keep their existing skip semantics', () => {
  const singleIteration = evaluateReplayPerformanceGuard(performanceRow({
    canvaskitReplayAvgMs: 500,
    replayRatio: 50,
    replayRatioGuard: 'skipped-single-iteration',
  }), guard);
  const smallBaseline = evaluateReplayPerformanceGuard(performanceRow({
    canvas2dReplayAvgMs: 4,
    canvaskitReplayAvgMs: 300,
    replayRatio: 75,
    replayRatioGuard: 'skipped-small-baseline',
  }), guard);

  assert.equal(singleIteration.passed, true);
  assert.equal(smallBaseline.passed, false);
  assert.equal(smallBaseline.checks[0].passed, true);
  assert.equal(smallBaseline.checks[1].passed, false);
  assert.match(smallBaseline.checks[1].message, /replay avg=300ms <= 250ms/);
});
