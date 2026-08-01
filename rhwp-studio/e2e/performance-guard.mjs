export function performanceGuardMessage(label, value, maxValue, guard, details) {
  if (guard !== 'checked') {
    return `${label} guard skipped (${guard}, value=${value}, budget=${maxValue}, ${details})`;
  }
  return `${label}=${value} <= ${maxValue} (${details})`;
}

export function evaluateReplayPerformanceGuard(row, guard) {
  const maxReplayRatio = row.maxCanvaskitReplayRatio ?? guard.maxReplayRatio;
  const maxReplayAvgMs = row.maxCanvaskitReplayAvgMs ?? guard.maxReplayAvgMs;
  const absoluteGuard = row.replayRatioGuard === 'skipped-single-iteration'
    ? 'skipped-single-iteration'
    : 'checked';
  const checks = [
    {
      kind: 'ratio',
      passed: row.replayRatio === null
        || row.replayRatioGuard === 'skipped-single-iteration'
        || row.replayRatioGuard === 'skipped-small-baseline'
        || row.replayRatio <= maxReplayRatio,
      message: performanceGuardMessage(
        `${row.case} CanvasKit replay ratio`,
        row.replayRatio,
        maxReplayRatio,
        row.replayRatioGuard,
        `canvas2dBaseline=${row.canvas2dReplayAvgMs}ms, minBaseline=${guard.minReplayRatioBaselineMs}ms`,
      ),
    },
    {
      kind: 'absolute',
      passed: absoluteGuard !== 'checked' || row.canvaskitReplayAvgMs <= maxReplayAvgMs,
      message: performanceGuardMessage(
        `${row.case} CanvasKit replay avg`,
        `${row.canvaskitReplayAvgMs}ms`,
        `${maxReplayAvgMs}ms`,
        absoluteGuard,
        'absolute replay guard',
      ),
    },
  ];

  return {
    passed: checks.every((check) => check.passed),
    checks,
  };
}
