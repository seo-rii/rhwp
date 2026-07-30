import assert from 'node:assert/strict';
import test from 'node:test';

import {
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
