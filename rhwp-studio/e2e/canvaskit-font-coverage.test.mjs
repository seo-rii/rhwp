import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import CanvasKitInit from 'canvaskit-wasm/bin/full/canvaskit.js';

const studioRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const regularFontPath = path.resolve(studioRoot, '../web/fonts/NotoSansKR-Regular.woff2');
const extraLightFontPath = path.resolve(studioRoot, '../web/fonts/NotoSansKR-ExtraLight.woff2');
const d2CodingFontPath = path.resolve(studioRoot, '../web/fonts/D2Coding-Regular.woff2');
const oldHangulFontPath = path.resolve(studioRoot, '../web/fonts/SourceHanSerifK-OldHangul-subset.woff2');
const canvasKitBundle = path.resolve(studioRoot, 'node_modules/canvaskit-wasm/bin/full');
const CanvasKit = await CanvasKitInit({
  locateFile: (file) => path.join(canvasKitBundle, file),
});
const regularBytes = fs.readFileSync(regularFontPath);
const extraLightBytes = fs.readFileSync(extraLightFontPath);
const d2CodingBytes = fs.readFileSync(d2CodingFontPath);
const oldHangulBytes = fs.readFileSync(oldHangulFontPath);
const regularTypeface = CanvasKit.Typeface.MakeFreeTypeFaceFromData(regularBytes);
const extraLightTypeface = CanvasKit.Typeface.MakeFreeTypeFaceFromData(extraLightBytes);
const d2CodingTypeface = CanvasKit.Typeface.MakeFreeTypeFaceFromData(d2CodingBytes);
const oldHangulTypeface = CanvasKit.Typeface.MakeFreeTypeFaceFromData(oldHangulBytes);
assert.ok(regularTypeface, 'Noto Sans KR Regular typeface를 만들 수 있어야 한다');
assert.ok(extraLightTypeface, 'Noto Sans KR ExtraLight typeface를 만들 수 있어야 한다');
assert.ok(d2CodingTypeface, 'D2Coding Regular typeface를 만들 수 있어야 한다');
assert.ok(oldHangulTypeface, 'Source Han Serif K 옛한글 subset typeface를 만들 수 있어야 한다');

const regularFontManager = CanvasKit.FontMgr.FromData(regularBytes);
assert.equal(regularFontManager?.getFamilyName(0), 'Noto Sans KR', 'Regular 번들은 올바른 family name을 노출해야 한다');
regularFontManager?.delete();

const extraLightFontManager = CanvasKit.FontMgr.FromData(extraLightBytes);
assert.equal(
  extraLightFontManager?.getFamilyName(0),
  'Noto Sans KR ExtraLight',
  'ExtraLight 번들은 독립 family name을 노출해야 한다',
);
const d2CodingFontManager = CanvasKit.FontMgr.FromData(d2CodingBytes);
assert.equal(
  d2CodingFontManager?.getFamilyName(0),
  'D2Coding',
  'D2Coding 번들은 올바른 fallback family name을 노출해야 한다',
);
const oldHangulFontManager = CanvasKit.FontMgr.FromData(oldHangulBytes);
assert.ok(oldHangulFontManager?.countFamilies(), '옛한글 subset은 CanvasKit font manager를 제공해야 한다');

const regularFont = new CanvasKit.Font(regularTypeface, 16);
const extraLightFont = new CanvasKit.Font(extraLightTypeface, 16);
const d2CodingFont = new CanvasKit.Font(d2CodingTypeface, 16);
const oldHangulFont = new CanvasKit.Font(oldHangulTypeface, 40);
try {
  for (const [character, codepoint] of [
    ['■', 'U+25A0'],
    ['▪', 'U+25AA'],
    ['□', 'U+25A1'],
    ['○', 'U+25CB'],
    ['─', 'U+2500'],
  ]) {
    const glyphId = regularFont.getGlyphIDs(character, 1)[0];
    assert.notEqual(glyphId, 0, `${codepoint} ${character}는 Noto Sans KR Regular에 있어야 한다`);
  }
  for (const [character, codepoint] of [
    ['가', 'U+AC00'],
    ['한', 'U+D55C'],
    ['A', 'U+0041'],
  ]) {
    const glyphId = extraLightFont.getGlyphIDs(character, 1)[0];
    assert.notEqual(glyphId, 0, `${codepoint} ${character}는 Noto Sans KR ExtraLight에 있어야 한다`);
  }
  assert.notEqual(
    d2CodingFont.getGlyphIDs('㎡', 1)[0],
    0,
    'U+33A1 ㎡는 공유 D2Coding fallback에 있어야 한다',
  );
  for (const [character, codepoint] of [
    ['ᄒ', 'U+1112'],
    ['ᆞ', 'U+119E'],
    ['ᆫ', 'U+11AB'],
  ]) {
    const glyphId = oldHangulFont.getGlyphIDs(character, 1)[0];
    assert.notEqual(glyphId, 0, `${codepoint} ${character}는 Source Han Serif K 옛한글 subset에 있어야 한다`);
  }

  const paragraphStyle = new CanvasKit.ParagraphStyle({
    textStyle: {
      color: CanvasKit.BLACK,
      fontSize: 40,
      fontFamilies: [oldHangulFontManager.getFamilyName(0)],
    },
  });
  const builder = CanvasKit.ParagraphBuilder.Make(paragraphStyle, oldHangulFontManager);
  try {
    builder.addText('ᄒᆞᆫ');
    const paragraph = builder.build();
    try {
      paragraph.layout(400);
      assert.ok(paragraph.getLongestLine() > 0, '옛한글 cluster가 폭을 가져야 한다');
      assert.ok(
        paragraph.getLongestLine() < 80,
        '옛한글 cluster는 분리된 자모 세 칸보다 좁게 shape되어야 한다',
      );
      assert.equal(
        paragraph.getRectsForRange(
          0,
          3,
          CanvasKit.RectHeightStyle.Tight,
          CanvasKit.RectWidthStyle.Tight,
        ).length,
        1,
        'ᄒᆞᆫ은 CanvasKit Paragraph에서 하나의 glyph cluster여야 한다',
      );
    } finally {
      paragraph.delete();
    }
  } finally {
    builder.delete();
  }
} finally {
  regularFont.delete();
  extraLightFont.delete();
  d2CodingFont.delete();
  oldHangulFont.delete();
  regularTypeface.delete();
  extraLightTypeface.delete();
  d2CodingTypeface.delete();
  oldHangulTypeface.delete();
  extraLightFontManager?.delete();
  d2CodingFontManager?.delete();
  oldHangulFontManager?.delete();
}

console.log('CanvasKit Noto Sans KR, D2Coding unit-symbol, and dedicated old-Hangul coverage passed');
