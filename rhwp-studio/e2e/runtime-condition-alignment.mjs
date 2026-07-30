const RUNTIME_CONDITION_FAILURE_DETAILS = new Map([
  ['canvasKitEncodedImageDecode', 'imageDecodeFailed'],
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
  const resolvedRuntimeConditions = [];
  const unresolvedRuntimeConditions = [];
  for (const runtimeCondition of runtimeConditions) {
    const expectedFailureDetail = RUNTIME_CONDITION_FAILURE_DETAILS.get(runtimeCondition);
    if (expectedFailureDetail && rejectedDetails.has(expectedFailureDetail)) {
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
