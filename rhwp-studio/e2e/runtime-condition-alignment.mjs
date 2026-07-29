const RUNTIME_CONDITION_FAILURE_DETAILS = new Map([
  ['canvasKitEncodedImageDecode', 'imageDecodeFailed'],
]);

function stringArray(value) {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === 'string')
    : [];
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
    };
  }
  if (planVariantId === runtimeVariantId) {
    return {
      aligned: true,
      resolution: 'exact',
      planVariantId,
      runtimeVariantId,
      resolvedRuntimeConditions: [],
      unresolvedRuntimeConditions: [],
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
  };
}
