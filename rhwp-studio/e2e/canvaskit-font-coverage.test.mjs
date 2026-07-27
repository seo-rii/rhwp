import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import CanvasKitInit from 'canvaskit-wasm/bin/full/canvaskit.js';

const studioRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const regularFontPath = path.resolve(studioRoot, '../web/fonts/NotoSansKR-Regular.woff2');
const extraLightFontPath = path.resolve(studioRoot, '../web/fonts/NotoSansKR-ExtraLight.woff2');
const canvasKitBundle = path.resolve(studioRoot, 'node_modules/canvaskit-wasm/bin/full');
const CanvasKit = await CanvasKitInit({
  locateFile: (file) => path.join(canvasKitBundle, file),
});
const regularBytes = fs.readFileSync(regularFontPath);
const extraLightBytes = fs.readFileSync(extraLightFontPath);
const regularTypeface = CanvasKit.Typeface.MakeFreeTypeFaceFromData(regularBytes);
const extraLightTypeface = CanvasKit.Typeface.MakeFreeTypeFaceFromData(extraLightBytes);
assert.ok(regularTypeface, 'Noto Sans KR Regular typeface를 만들 수 있어야 한다');
assert.ok(extraLightTypeface, 'Noto Sans KR ExtraLight typeface를 만들 수 있어야 한다');

const regularFontManager = CanvasKit.FontMgr.FromData(regularBytes);
assert.equal(regularFontManager?.getFamilyName(0), 'Noto Sans KR', 'Regular 번들은 올바른 family name을 노출해야 한다');
regularFontManager?.delete();

const extraLightFontManager = CanvasKit.FontMgr.FromData(extraLightBytes);
assert.equal(
  extraLightFontManager?.getFamilyName(0),
  'Noto Sans KR ExtraLight',
  'ExtraLight 번들은 독립 family name을 노출해야 한다',
);
extraLightFontManager?.delete();

const regularFont = new CanvasKit.Font(regularTypeface, 16);
const extraLightFont = new CanvasKit.Font(extraLightTypeface, 16);
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
} finally {
  regularFont.delete();
  extraLightFont.delete();
  regularTypeface.delete();
  extraLightTypeface.delete();
}

console.log('CanvasKit Noto Sans KR Regular/ExtraLight coverage passed');
