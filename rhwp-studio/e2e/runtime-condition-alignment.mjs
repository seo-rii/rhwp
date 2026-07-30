const RUNTIME_CONDITION_FAILURE_DETAILS = new Map([
  ['canvasKitEncodedImageDecode', { field: 'details', value: 'imageDecodeFailed' }],
  ['canvasKitSvgPathConstruction', { field: 'details', value: 'pathDecodeFailed' }],
  ['canvasKitTypefaceConstruction', {
    field: 'reasons',
    value: 'fontFaceInstantiationFailed',
  }],
]);

function stringArray(value) {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === 'string')
    : [];
}

function nullableString(value) {
  return typeof value === 'string' ? value : null;
}

function partCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function partsAreComplete(report) {
  const expected = partCount(report?.partsExpected);
  const replayed = partCount(report?.partsReplayed);
  return expected !== null && expected > 0 && replayed === expected;
}

function nonnegativeCounter(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function replayItemRuntimeConditions(item) {
  const conditions = stringArray(item?.runtimeConditions);
  if (conditions.length > 0) {
    return conditions;
  }
  const legacyCondition = nullableString(item?.runtimeCondition);
  return legacyCondition ? [legacyCondition] : [];
}

const PAGE_RUNTIME_CONDITION_OBSERVERS = [
  {
    condition: 'canvasKitImageEffectPreprocess',
    observe(diagnostics) {
      const effects = diagnostics?.imageEffects?.canvaskit;
      return {
        observedAttempts:
          nonnegativeCounter(effects?.cacheHits) + nonnegativeCounter(effects?.cacheMisses),
        failureCount: Math.max(
          nonnegativeCounter(effects?.preprocessFailures),
          nonnegativeCounter(effects?.fallbackToOriginal),
        ),
      };
    },
  },
  {
    condition: 'canvasKitPatternImageConstruction',
    observe(diagnostics) {
      const patterns = diagnostics?.patternDiagnostics;
      return {
        observedAttempts:
          nonnegativeCounter(patterns?.cacheHits) + nonnegativeCounter(patterns?.cacheMisses),
        failureCount: nonnegativeCounter(patterns?.surfaceFailures),
      };
    },
  },
];

export function classifyCanvasKitPageRuntimeConditions(replayPlan, diagnostics) {
  const declarations = new Map();
  const items = Array.isArray(replayPlan?.items) ? replayPlan.items : [];
  for (const item of items) {
    for (const condition of new Set(replayItemRuntimeConditions(item))) {
      const declaration = declarations.get(condition) ?? {
        plannedPaths: [],
        plannedItemCount: 0,
      };
      declaration.plannedItemCount += 1;
      declaration.plannedPaths.push(
        typeof item?.path === 'string' ? item.path : '',
      );
      declarations.set(condition, declaration);
    }
  }

  const alignments = [];
  for (const observer of PAGE_RUNTIME_CONDITION_OBSERVERS) {
    const declaration = declarations.get(observer.condition) ?? {
      plannedPaths: [],
      plannedItemCount: 0,
    };
    const observation = observer.observe(diagnostics);
    if (
      declaration.plannedItemCount === 0
      && observation.observedAttempts === 0
      && observation.failureCount === 0
    ) {
      continue;
    }
    let status = 'unobserved';
    if (observation.failureCount > 0) {
      status = 'failed';
    } else if (declaration.plannedItemCount === 0) {
      status = 'undeclared';
    } else if (observation.observedAttempts > 0) {
      status = 'observed';
    }
    alignments.push({
      condition: observer.condition,
      plannedPaths: [...new Set(declaration.plannedPaths)],
      plannedItemCount: declaration.plannedItemCount,
      observedAttempts: observation.observedAttempts,
      failureCount: observation.failureCount,
      status,
    });
  }
  return alignments;
}

export function textVariantReportKey(report) {
  return JSON.stringify([
    nullableString(report?.equivalenceGroup) ?? '',
    nullableString(report?.anchorOpId) ?? '',
  ]);
}

export function classifyCanvasKitVariantAlignment(planReport, runtimeReport) {
  const planVariantId = planReport?.selectedVariantId ?? null;
  const runtimeVariantId = runtimeReport?.selectedVariantId ?? null;
  if (!planReport || !runtimeReport) {
    return {
      aligned: false,
      resolution: 'missingReport',
      planVariantId,
      runtimeVariantId,
      resolvedRuntimeConditions: [],
      unresolvedRuntimeConditions: [],
      mismatches: ['missingReport'],
    };
  }

  const identityMismatches = [];
  if (nullableString(planReport.equivalenceGroup) !== nullableString(runtimeReport.equivalenceGroup)) {
    identityMismatches.push('equivalenceGroup');
  }
  if (nullableString(planReport.anchorOpId) !== nullableString(runtimeReport.anchorOpId)) {
    identityMismatches.push('anchorOpId');
  }
  const planPartsComplete = partsAreComplete(planReport);
  const runtimePartsComplete = partsAreComplete(runtimeReport);
  if (!planPartsComplete) {
    identityMismatches.push('planPartsIncomplete');
  }
  if (!runtimePartsComplete) {
    identityMismatches.push('runtimePartsIncomplete');
  }

  const exactMismatches = [...identityMismatches];
  if (planVariantId !== runtimeVariantId) {
    exactMismatches.push('selectedVariantId');
  }
  if (planReport.selectedVariantKind !== runtimeReport.selectedVariantKind) {
    exactMismatches.push('selectedVariantKind');
  }
  if (partCount(planReport.partsExpected) !== partCount(runtimeReport.partsExpected)) {
    exactMismatches.push('partsExpected');
  }
  if (exactMismatches.length === 0) {
    return {
      aligned: true,
      resolution: 'exact',
      planVariantId,
      runtimeVariantId,
      resolvedRuntimeConditions: [],
      unresolvedRuntimeConditions: [],
      mismatches: [],
    };
  }

  const runtimeConditions = stringArray(planReport.selectedRuntimeConditions);
  const rejectedPlanVariant = (runtimeReport.rejectedVariants ?? []).find((rejected) => (
    rejected?.variantId === planVariantId
      && rejected?.variantKind === planReport.selectedVariantKind
  ));
  const rejectedDetails = new Set(stringArray(rejectedPlanVariant?.details));
  const rejectedReasons = new Set(stringArray(rejectedPlanVariant?.reasons));
  const resolvedRuntimeConditions = [];
  const unresolvedRuntimeConditions = [];
  for (const runtimeCondition of runtimeConditions) {
    const expectedFailure = RUNTIME_CONDITION_FAILURE_DETAILS.get(runtimeCondition);
    const observedFailures = expectedFailure?.field === 'reasons'
      ? rejectedReasons
      : rejectedDetails;
    if (expectedFailure && observedFailures.has(expectedFailure.value)) {
      resolvedRuntimeConditions.push(runtimeCondition);
    } else {
      unresolvedRuntimeConditions.push(runtimeCondition);
    }
  }

  const runtimeFallbackResolved = runtimeConditions.length > 0
    && identityMismatches.length === 0
    && unresolvedRuntimeConditions.length === 0
    && runtimeReport.selectedVariantKind === 'textRun'
    && runtimeReport.selectedReason === 'defaultTextRunFallback';
  return {
    aligned: runtimeFallbackResolved,
    resolution: runtimeFallbackResolved ? 'runtimeFallback' : 'mismatch',
    planVariantId,
    runtimeVariantId,
    resolvedRuntimeConditions,
    unresolvedRuntimeConditions,
    mismatches: runtimeFallbackResolved ? [] : exactMismatches,
  };
}
