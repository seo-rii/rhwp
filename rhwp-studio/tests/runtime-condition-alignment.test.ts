import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyCanvasKitPageRuntimeConditions,
  classifyCanvasKitVariantAlignment,
  textVariantReportKey,
} from '../e2e/runtime-condition-alignment.mjs';

const directPlan = {
  equivalenceGroup: 'text-0',
  anchorOpId: 'op-text-0',
  selectedVariantId: 'glyphOutline',
  selectedVariantKind: 'glyphOutline',
  selectedRuntimeConditions: [],
  partsExpected: 2,
  partsReplayed: 2,
};

test('page runtime alignment observes plural and legacy plan conditions', () => {
  const alignments = classifyCanvasKitPageRuntimeConditions({
    items: [
      {
        path: 'root/ops/0',
        runtimeCondition: 'canvasKitImageEffectPreprocess',
        runtimeConditions: [
          'canvasKitImageEffectPreprocess',
          'canvasKitPatternImageConstruction',
        ],
      },
      {
        path: 'root/ops/1',
        runtimeCondition: 'canvasKitImageEffectPreprocess',
      },
    ],
  }, {
    imageEffects: {
      canvaskit: {
        cacheHits: 1,
        cacheMisses: 2,
        preprocessFailures: 0,
        fallbackToOriginal: 0,
      },
    },
    patternDiagnostics: {
      cacheHits: 1,
      cacheMisses: 1,
      surfaceFailures: 0,
    },
  });

  assert.deepEqual(alignments, [
    {
      condition: 'canvasKitImageEffectPreprocess',
      plannedPaths: ['root/ops/0', 'root/ops/1'],
      plannedItemCount: 2,
      observedAttempts: 3,
      failureCount: 0,
      status: 'observed',
    },
    {
      condition: 'canvasKitPatternImageConstruction',
      plannedPaths: ['root/ops/0'],
      plannedItemCount: 1,
      observedAttempts: 2,
      failureCount: 0,
      status: 'observed',
    },
  ]);
});

test('page runtime alignment distinguishes unobserved, undeclared, and failed conditions', () => {
  const unobserved = classifyCanvasKitPageRuntimeConditions({
    items: [{
      path: 'root/ops/0',
      runtimeConditions: ['canvasKitImageEffectPreprocess'],
    }],
  }, {});
  assert.equal(unobserved[0].status, 'unobserved');

  const undeclared = classifyCanvasKitPageRuntimeConditions({ items: [] }, {
    patternDiagnostics: {
      cacheHits: 0,
      cacheMisses: 1,
      surfaceFailures: 0,
    },
  });
  assert.deepEqual(undeclared, [{
    condition: 'canvasKitPatternImageConstruction',
    plannedPaths: [],
    plannedItemCount: 0,
    observedAttempts: 1,
    failureCount: 0,
    status: 'undeclared',
  }]);

  const failed = classifyCanvasKitPageRuntimeConditions({
    items: [{
      path: 'root/ops/0',
      runtimeCondition: 'canvasKitImageEffectPreprocess',
    }],
  }, {
    imageEffects: {
      canvaskit: {
        cacheHits: 0,
        cacheMisses: 1,
        preprocessFailures: 1,
        fallbackToOriginal: 1,
      },
    },
  });
  assert.equal(failed[0].status, 'failed');
  assert.equal(failed[0].failureCount, 1);
});

test('page runtime alignment omits irrelevant and malformed counters', () => {
  assert.deepEqual(
    classifyCanvasKitPageRuntimeConditions({ items: [] }, {
      imageEffects: {
        canvaskit: {
          cacheHits: Number.NaN,
          cacheMisses: -1,
        },
      },
      patternDiagnostics: {
        cacheHits: null,
        cacheMisses: '1',
      },
    }),
    [],
  );
});

test('variant alignment requires the full selected variant identity', () => {
  const exact = classifyCanvasKitVariantAlignment(directPlan, {
    ...directPlan,
  });
  assert.equal(exact.aligned, true);
  assert.equal(exact.resolution, 'exact');

  const wrongKind = classifyCanvasKitVariantAlignment(directPlan, {
    ...directPlan,
    selectedVariantKind: 'glyphRun',
  });
  assert.equal(wrongKind.aligned, false);
  assert(wrongKind.mismatches.includes('selectedVariantKind'));

  const wrongAnchor = classifyCanvasKitVariantAlignment(directPlan, {
    ...directPlan,
    anchorOpId: 'op-text-1',
  });
  assert.equal(wrongAnchor.aligned, false);
  assert(wrongAnchor.mismatches.includes('anchorOpId'));
});

test('variant alignment rejects incomplete or differently sized selected parts', () => {
  const incomplete = classifyCanvasKitVariantAlignment(directPlan, {
    ...directPlan,
    partsReplayed: 1,
  });
  assert.equal(incomplete.aligned, false);
  assert(incomplete.mismatches.includes('runtimePartsIncomplete'));

  const differentlySized = classifyCanvasKitVariantAlignment(directPlan, {
    ...directPlan,
    partsExpected: 1,
    partsReplayed: 1,
  });
  assert.equal(differentlySized.aligned, false);
  assert(differentlySized.mismatches.includes('partsExpected'));
});

test('declared runtime fallback still requires complete reports in the same paint slot', () => {
  const conditionalPlan = {
    ...directPlan,
    selectedRuntimeConditions: ['canvasKitEncodedImageDecode'],
  };
  const runtimeFallback = {
    equivalenceGroup: 'text-0',
    anchorOpId: 'op-text-0',
    selectedVariantId: 'textRun',
    selectedVariantKind: 'textRun',
    selectedReason: 'defaultTextRunFallback',
    partsExpected: 1,
    partsReplayed: 1,
    rejectedVariants: [{
      variantId: 'glyphOutline',
      variantKind: 'glyphOutline',
      details: ['imageDecodeFailed'],
    }],
  };

  const resolved = classifyCanvasKitVariantAlignment(conditionalPlan, runtimeFallback);
  assert.equal(resolved.aligned, true);
  assert.equal(resolved.resolution, 'runtimeFallback');

  const incomplete = classifyCanvasKitVariantAlignment(conditionalPlan, {
    ...runtimeFallback,
    partsReplayed: 0,
  });
  assert.equal(incomplete.aligned, false);
  assert(incomplete.mismatches.includes('runtimePartsIncomplete'));
});

test('GlyphRun typeface construction failure resolves only its declared runtime condition', () => {
  const conditionalPlan = {
    ...directPlan,
    selectedVariantId: 'glyphRun',
    selectedVariantKind: 'glyphRun',
    selectedRuntimeConditions: ['canvasKitTypefaceConstruction'],
  };
  const runtimeFallback = {
    equivalenceGroup: 'text-0',
    anchorOpId: 'op-text-0',
    selectedVariantId: 'textRun',
    selectedVariantKind: 'textRun',
    selectedReason: 'defaultTextRunFallback',
    partsExpected: 1,
    partsReplayed: 1,
    rejectedVariants: [{
      variantId: 'glyphRun',
      variantKind: 'glyphRun',
      reasons: ['fontFaceInstantiationFailed'],
    }],
  };

  const resolved = classifyCanvasKitVariantAlignment(conditionalPlan, runtimeFallback);
  assert.equal(resolved.aligned, true);
  assert.deepEqual(resolved.resolvedRuntimeConditions, ['canvasKitTypefaceConstruction']);

  const unrelatedFailure = classifyCanvasKitVariantAlignment(conditionalPlan, {
    ...runtimeFallback,
    rejectedVariants: [{
      variantId: 'glyphRun',
      variantKind: 'glyphRun',
      reasons: ['fontBlobNotVerified'],
    }],
  });
  assert.equal(unrelatedFailure.aligned, false);
  assert.deepEqual(
    unrelatedFailure.unresolvedRuntimeConditions,
    ['canvasKitTypefaceConstruction'],
  );
});

test('SvgGlyph path construction failure resolves only its declared runtime condition', () => {
  const conditionalPlan = {
    ...directPlan,
    selectedRuntimeConditions: ['canvasKitSvgPathConstruction'],
  };
  const runtimeFallback = {
    equivalenceGroup: 'text-0',
    anchorOpId: 'op-text-0',
    selectedVariantId: 'textRun',
    selectedVariantKind: 'textRun',
    selectedReason: 'defaultTextRunFallback',
    partsExpected: 1,
    partsReplayed: 1,
    rejectedVariants: [{
      variantId: 'glyphOutline',
      variantKind: 'glyphOutline',
      reasons: ['unsupportedSvgGlyph'],
      details: ['pathDecodeFailed'],
    }],
  };

  const resolved = classifyCanvasKitVariantAlignment(conditionalPlan, runtimeFallback);
  assert.equal(resolved.aligned, true);
  assert.deepEqual(resolved.resolvedRuntimeConditions, ['canvasKitSvgPathConstruction']);

  const unrelatedFailure = classifyCanvasKitVariantAlignment(conditionalPlan, {
    ...runtimeFallback,
    rejectedVariants: [{
      variantId: 'glyphOutline',
      variantKind: 'glyphOutline',
      reasons: ['unsupportedSvgGlyph'],
      details: ['missingVectorResource'],
    }],
  });
  assert.equal(unrelatedFailure.aligned, false);
  assert.deepEqual(
    unrelatedFailure.unresolvedRuntimeConditions,
    ['canvasKitSvgPathConstruction'],
  );
});

test('variant report keys include the leaf-local anchor when available', () => {
  assert.notEqual(
    textVariantReportKey({
      equivalenceGroup: 'reused-group',
      anchorOpId: 'op-text-a',
    }),
    textVariantReportKey({
      equivalenceGroup: 'reused-group',
      anchorOpId: 'op-text-b',
    }),
  );
});
