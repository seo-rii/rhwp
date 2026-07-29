import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  baseFamilyWithoutWeightSuffix,
  buildCanvasTextFont,
  canvasFontFamilyFallbackCandidates,
  fontFamilyFallbackCandidates,
  fontFamilyWithFallback,
  resolveRenderFontWeight,
} from '../src/core/font-family-fallback.ts';
import { FONT_LIST } from '../src/core/font-loader.ts';

test('weight-suffixed faces insert their base family before generic fallbacks', () => {
  assert.equal(baseFamilyWithoutWeightSuffix('Noto Serif KR Black'), 'Noto Serif KR');
  assert.equal(baseFamilyWithoutWeightSuffix('Noto Sans KR Extra Bold'), 'Noto Sans KR');
  assert.equal(baseFamilyWithoutWeightSuffix('경기천년제목 Light'), '경기천년제목');
  assert.equal(baseFamilyWithoutWeightSuffix('맑은 고딕'), null);
  assert.equal(baseFamilyWithoutWeightSuffix('Light'), null);

  assert.deepEqual(
    fontFamilyFallbackCandidates('Noto Serif KR Black').slice(0, 3),
    ['Noto Serif KR Black', 'Noto Serif KR', 'Batang'],
  );
  assert.match(
    fontFamilyWithFallback('Noto Serif KR Black'),
    /^"Noto Serif KR Black", "Noto Serif KR", "Batang",/,
  );
});

test('KoPub Batang remains proportional serif after removing its weight suffix', () => {
  const candidates = canvasFontFamilyFallbackCandidates('KoPub바탕체 Light');
  assert.deepEqual(candidates.slice(0, 3), ['KoPub바탕체 Light', 'KoPub바탕체', 'Batang']);
  assert.equal(candidates.includes('GulimChe'), false);
  assert.deepEqual(candidates.slice(-2), ['Latin Modern Math', 'serif']);
  assert.equal(candidates.at(-1), 'serif');
});

test('Studio render weights follow the Rust renderer fallback hints', () => {
  assert.equal(resolveRenderFontWeight('KoPub돋움체 Light', false), 300);
  assert.equal(resolveRenderFontWeight('HY중고딕', false), 500);
  assert.equal(resolveRenderFontWeight('KoPub바탕체 Bold', false), 700);
  assert.equal(resolveRenderFontWeight('HY헤드라인M', false), 700);
  assert.equal(resolveRenderFontWeight('HY견명조', false), 700);
  assert.equal(resolveRenderFontWeight('한양견명조', false), 700);
  assert.equal(resolveRenderFontWeight('한양견고딕', false), 700);
  assert.equal(resolveRenderFontWeight('한양중고딕', false), 500);
  assert.equal(resolveRenderFontWeight('KoPub돋움체 Light', true), 700);
  assert.equal(resolveRenderFontWeight('맑은 고딕', false), 400);
});

test('Canvas2D shorthand combines inferred weight with the shared family chain', () => {
  assert.match(
    buildCanvasTextFont('KoPub돋움체 Light', 14, false, false),
    /^300 14\.000px "KoPub돋움체 Light", "KoPub돋움체",/,
  );
  assert.match(
    buildCanvasTextFont('Noto Serif KR Black', 12, true, true),
    /^italic 700 12\.000px "Noto Serif KR Black", "Noto Serif KR",/,
  );
  assert.equal(
    buildCanvasTextFont('sans-serif', 10, false, false),
    '10.000px sans-serif',
  );
  assert.match(
    buildCanvasTextFont('', 10, false, false),
    /"Malgun Gothic", "맑은 고딕", "Apple SD Gothic Neo", "Noto Sans KR ExtraLight"/,
  );
  assert.match(
    buildCanvasTextFont('없는 산세리프', 10, false, false),
    /"Latin Modern Math", sans-serif$/,
  );
});

test('Dotum aliases and generic sans fallbacks use the independent ExtraLight family', () => {
  assert.deepEqual(
    canvasFontFamilyFallbackCandidates('없는 산세리프').slice(0, 6),
    [
      '없는 산세리프',
      'Malgun Gothic',
      '맑은 고딕',
      'Apple SD Gothic Neo',
      'Noto Sans KR ExtraLight',
      'Noto Sans CJK KR',
    ],
  );
  for (const family of ['돋움', '돋움체', '굴림', '새굴림', 'Haansoft Dotum']) {
    assert.deepEqual(
      FONT_LIST
        .filter((entry) => entry.name === family)
        .map((entry) => ({ file: entry.file, weight: entry.weight })),
      [{ file: 'fonts/NotoSansKR-ExtraLight.woff2', weight: '400' }],
    );
  }
});

test('old-Hangul fallback is range-limited, preloaded, and shared across family classes', () => {
  assert.deepEqual(
    FONT_LIST.filter((entry) => entry.name === 'Source Han Serif K Old Hangul'),
    [{
      name: 'Source Han Serif K Old Hangul',
      file: 'fonts/SourceHanSerifK-OldHangul-subset.woff2',
      weight: '400',
      unicodeRange: 'U+1100-11FF, U+A960-A97F, U+D7B0-D7FF',
      loadText: 'ᄒᆞᆫ',
    }],
  );
  for (const family of ['없는 산세리프', '없는 명조', '없는 coding']) {
    assert.ok(
      canvasFontFamilyFallbackCandidates(family).includes('Source Han Serif K Old Hangul'),
      `${family} should retain the range-limited old-Hangul fallback`,
    );
    assert.ok(
      fontFamilyFallbackCandidates(family).includes('Source Han Serif K Old Hangul'),
      `${family} should retain the system old-Hangul fallback`,
    );
  }
});

test('measured HFT families retain their source identity and fallback class', () => {
  for (const family of ['한양신명조', '한양견명조', '휴먼명조']) {
    assert.deepEqual(
      canvasFontFamilyFallbackCandidates(family).slice(0, 3),
      [family, 'Batang', '바탕'],
    );
  }
  for (const family of ['한양중고딕', '한양견고딕']) {
    assert.deepEqual(
      canvasFontFamilyFallbackCandidates(family).slice(0, 3),
      [family, 'Malgun Gothic', '맑은 고딕'],
    );
  }
});

test('CanvasKit consumes the shared family and weight fallback semantics', () => {
  const registrySource = readFileSync(
    new URL('../src/view/canvaskit/fonts.ts', import.meta.url),
    'utf8',
  );
  const rendererSource = readFileSync(
    new URL('../src/view/canvaskit-renderer.ts', import.meta.url),
    'utf8',
  );

  assert.match(registrySource, /baseFamilyWithoutWeightSuffix\(candidate\)/);
  assert.match(registrySource, /canvasFontFamilyFallbackCandidates\(resolved\)/);
  assert.match(registrySource, /MEASURED_HFT_LAYER_FAMILIES\.has\(fontFamily\)/);
  for (const family of ['한양신명조', '한양중고딕', '한양견명조', '한양견고딕', '휴먼명조']) {
    assert.match(registrySource, new RegExp(`'${family}'`));
  }
  assert.match(registrySource, /NotoSansKR-ExtraLight\.woff2/);
  assert.match(registrySource, /'Noto Sans KR ExtraLight'/);
  assert.match(registrySource, /SourceHanSerifK-OldHangul-subset\.woff2/);
  assert.match(registrySource, /OLD_HANGUL_FONT_FAMILY/);
  assert.match(rendererSource, /fallbackClass = needsOldHangulFallback/);
  assert.match(rendererSource, /preferredFallbackFamilies = needsOldHangulFallback/);
  assert.match(rendererSource, /resolveRenderFontWeight\(op\.style\.fontFamily, op\.style\.bold\)/);
  assert.match(rendererSource, /this\.canvasKit\.FontWeight\.Light/);
  assert.match(rendererSource, /this\.canvasKit\.FontWeight\.Medium/);
  assert.match(rendererSource, /this\.canvasKit\.FontWeight\.Bold/);
});
