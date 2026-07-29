import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const textVariantsSource = readFileSync(
  new URL('../src/core/text-variants.ts', import.meta.url),
  'utf8',
);
const glyphOutlinePayloadStatusSource = readFileSync(
  new URL('../src/view/glyph-outline-payload-status.ts', import.meta.url),
  'utf8',
);

function extractFunctionBody(source: string, functionName: string): string {
  let signatureIndex = source.indexOf(`export function ${functionName}(`);
  if (signatureIndex === -1) {
    signatureIndex = source.indexOf(`function ${functionName}(`);
  }
  assert.notEqual(signatureIndex, -1, `missing function ${functionName}`);

  const bodyStart = source.indexOf('{', signatureIndex);
  assert.notEqual(bodyStart, -1, `missing body for ${functionName}`);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(bodyStart + 1, index);
      }
    }
  }

  throw new Error(`unterminated body for ${functionName}`);
}

test('monochrome fill and stroke gates keep payload families exclusive', () => {
  const fillBody = extractFunctionBody(textVariantsSource, 'hasGlyphOutlinePathsContract');
  assert.match(fillBody, /payloadKind === 'monochromeFill'/);
  assert.match(fillBody, /payloadKind === 'monochromeFillStroke'/);
  assert.match(fillBody, /payload\.colorLayers === undefined/);
  assert.match(fillBody, /payload\.bitmapGlyph === undefined/);
  assert.match(fillBody, /payload\.svgGlyph === undefined/);
  assert.match(fillBody, /isValidPathCommands\(path\.commands\)/);

  const strokeBody = extractFunctionBody(textVariantsSource, 'isSupportedGlyphOutlineStrokeStyle');
  for (const token of [
    'stroke.widthPx > 0',
    "(stroke.join ?? 'miter') === 'miter'",
    "(stroke.cap ?? 'butt') === 'butt'",
    "(stroke.paintOrder ?? 'fillThenStroke') === 'fillThenStroke'",
  ]) {
    assert.equal(strokeBody.includes(token), true, `missing stroke guard: ${token}`);
  }
});

test('COLRv0 gate requires resolved layers and source provenance', () => {
  const body = extractFunctionBody(textVariantsSource, 'hasColrv0ColorLayersContract');

  for (const token of [
    "payload.payloadKind === 'colorLayers'",
    '!payload.stroke',
    'payload.bitmapGlyph === undefined',
    'payload.svgGlyph === undefined',
    "colorLayers?.colorFormat === 'colrV0'",
    'colorLayers.sourceFontRef !== undefined',
    'colorLayers.paintGraph === undefined',
    'isValidPathCommands(layer.commands)',
    'isValidResolvedColor(layer.fill)',
    'isValidPayloadIndex(layer.paletteIndex)',
    'layer.sourceFontRef !== undefined',
  ]) {
    assert.equal(body.includes(token), true, `missing COLRv0 guard: ${token}`);
  }
});

test('COLRv1 gate keeps graph bounds, local transforms, composites, clips, and cycle checks', () => {
  const body = extractFunctionBody(textVariantsSource, 'hasColrv1ColorGraphContract');

  for (const token of [
    "colorLayers?.colorFormat !== 'colrV1'",
    'graph.nodes.length > MAX_COLRV1_GRAPH_NODES',
    "node.kind === 'solidPath'",
    "node.kind === 'linearGradientPath'",
    "node.kind === 'radialGradientPath'",
    "node.kind === 'sweepGradientPath'",
    "node.kind === 'transform'",
    "node.kind === 'composite'",
    "node.kind === 'clip'",
    'isFiniteAffineTransform(node.transform.transform)',
    "node.composite.mode === 'sourceOver'",
    'isValidPathCommands(node.clip.clipCommands)',
    'if (depth > MAX_COLRV1_GRAPH_DEPTH)',
    'if (visiting.has(nodeId))',
    'visited.size === graph.nodes.length',
  ]) {
    assert.equal(body.includes(token), true, `missing COLRv1 graph guard: ${token}`);
  }
});

test('BitmapGlyph gate requires deterministic producer-selected image strikes', () => {
  const body = extractFunctionBody(textVariantsSource, 'hasStrictBitmapGlyphContract');

  for (const token of [
    "payload.payloadKind === 'bitmapGlyph'",
    '!payload.stroke',
    'payload.colorLayers === undefined',
    'payload.svgGlyph === undefined',
    'isValidResourceId(bitmapGlyph.imageResourceId)',
    'isValidTextRunPlacement(bitmapGlyph.placement)',
    "bitmapGlyph.strikeSelection === 'producerResolved'",
    'bitmapGlyph.colorSpace === undefined',
    'isSupportedBitmapAlphaMode(bitmapGlyph.alphaMode)',
    'isSupportedBitmapScalingPolicy(bitmapGlyph.scalingPolicy)',
    'isSupportedBitmapFiltering(bitmapGlyph.filtering)',
  ]) {
    assert.equal(body.includes(token), true, `missing BitmapGlyph guard: ${token}`);
  }

  const scalingBody = extractFunctionBody(textVariantsSource, 'isSupportedBitmapScalingPolicy');
  assert.match(scalingBody, /value === 'noScale'/);
  assert.match(scalingBody, /value === 'scaleToEm'/);
  assert.match(scalingBody, /value === 'explicitTransform'/);
  assert.equal(scalingBody.includes('backendDefault'), false);

  const filteringBody = extractFunctionBody(textVariantsSource, 'isSupportedBitmapFiltering');
  assert.match(filteringBody, /value === 'nearest'/);
  assert.match(filteringBody, /value === 'linear'/);
  assert.equal(filteringBody.includes('backendDefault'), false);
});

test('SvgGlyph gate requires sanitized static vector resources without raw inline replay fields', () => {
  const body = extractFunctionBody(textVariantsSource, 'hasStaticSanitizedSvgGlyphContract');

  for (const token of [
    "payload.payloadKind === 'svgGlyph'",
    '!payload.stroke',
    'payload.colorLayers === undefined',
    'payload.bitmapGlyph === undefined',
    '!hasRawInlineSvgGlyphReplayField(svgGlyph)',
    'isValidResourceId(svgGlyph.vectorResourceId)',
    'isValidTextRunPlacement(svgGlyph.placement)',
    'viewBox.width > 0',
    'viewBox.height > 0',
    "svgGlyph.securityMode === 'staticSanitized'",
    'svgGlyph.scriptAllowed === false',
    'svgGlyph.animationAllowed === false',
    'svgGlyph.externalResourcesAllowed === false',
    'svgGlyph.interactivityAllowed === false',
  ]) {
    assert.equal(body.includes(token), true, `missing SvgGlyph guard: ${token}`);
  }

  const rawFieldBody = extractFunctionBody(textVariantsSource, 'hasRawInlineSvgGlyphReplayField');
  for (const token of [
    "'rawSvg'",
    "'inlineSvg'",
    "'svgText'",
    "'svgFragment'",
    "'svg'",
    "'fragment'",
    "'markup'",
  ]) {
    assert.equal(textVariantsSource.includes(token), true, `missing raw SVG field guard: ${token}`);
  }
  assert.match(rawFieldBody, /RAW_INLINE_SVG_GLYPH_FIELDS\.some/);
});

test('SvgGlyph admission keeps strict payloads path-only', () => {
  const body = extractFunctionBody(
    glyphOutlinePayloadStatusSource,
    'glyphOutlinePayloadStatus',
  );

  assert.match(body, /parseStaticSvgPathLayers\(fragment\)/);
  assert.match(body, /parseStaticSvgTextLayers\(fragment\)/);
  assert.match(body, /pathLayers\.length > 0/);
  assert.match(body, /pathLayers\.every\(\(layer\) => isStaticSvgPathDataValid\(layer\.pathData\)\)/);
  assert.match(body, /textLayers\.length === 0/);
});
