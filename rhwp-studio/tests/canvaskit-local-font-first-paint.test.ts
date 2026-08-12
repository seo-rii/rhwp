import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

test('CanvasKit prepares preflight local faces before the first document replay', () => {
  const main = source('../src/main.ts');
  const prepareStart = main.indexOf('async function prepareCanvasKitDocumentFonts');
  const initializeStart = main.indexOf('async function initializeDocument');
  assert.ok(prepareStart >= 0 && initializeStart > prepareStart);

  const prepareDocument = main.slice(prepareStart, initializeStart);
  const preflightIndex = prepareDocument.indexOf('wasm.getCanvasKitDocumentPreflight(');
  const storedIndex = prepareDocument.indexOf('await loadStoredLocalFonts();');
  const localIndex = prepareDocument.indexOf(
    'await renderer.prepareLocalFonts(requiredFontFamilies)',
  );
  assert.ok(preflightIndex >= 0, 'document preflight must bound the requested family set');
  assert.ok(storedIndex > preflightIndex, 'stored metadata must load without prompting');
  assert.ok(localIndex > storedIndex, 'exact local bytes must be registered after metadata load');
  assert.match(prepareDocument, /bundled fallback으로 계속합니다/);

  const initializeDocument = main.slice(initializeStart);
  const prepareIndex = initializeDocument.indexOf('await prepareCanvasKitDocumentFonts(docInfo);');
  const firstReplayIndex = initializeDocument.indexOf('canvasView?.loadDocument();');
  assert.ok(prepareIndex >= 0 && firstReplayIndex > prepareIndex);
});

test('CanvasKit font resolution gives prepared local faces precedence over bundled aliases', () => {
  const registry = source('../src/view/canvaskit/fonts.ts');
  const renderer = source('../src/view/canvaskit-renderer.ts');

  assert.match(registry, /this\.localAliasFamilies\.get\(localFontAliasKey\(fontFamily\)\)/);
  assert.match(
    registry,
    /this\.localProviderFamilies\.get\(family\)[\s\S]*?this\.providerFamilies\.get\(family\)/,
  );
  assert.match(registry, /loadLocalFontBytesFor\(/);
  assert.match(renderer, /async prepareLocalFonts\(fontNames: readonly string\[\]\)/);
});

test('newly approved local faces refresh only the still-active CanvasKit document', () => {
  const main = source('../src/main.ts');
  const options = source('../src/ui/options-dialog.ts');

  assert.match(options, /detectLocalFonts\(\{ force: isLocalFontAccessSupported\(\) \}\)/);
  assert.match(main, /subscribeLocalFontDetection\(\(\) => \{[\s\S]*?refreshCanvasKitLocalFonts\(\)/);
  assert.match(
    main,
    /const registered = await prepareCanvasKitDocumentFonts\(docInfo, false\);[\s\S]*?registered === 0 \|\| activeDocumentInfo !== docInfo/,
  );
  assert.match(main, /canvasView\?\.loadDocument\(\);/);
});

test('registering an exact local face invalidates every provider-dependent text cache', () => {
  const renderer = source('../src/view/canvaskit-renderer.ts');
  const prepareStart = renderer.indexOf('async prepareLocalFonts');
  const renderStart = renderer.indexOf('\n  renderPage(', prepareStart);
  const prepare = renderer.slice(prepareStart, renderStart);
  const invalidateStart = renderer.indexOf('private invalidateTextFontCaches');
  const disposeStart = renderer.indexOf('\n  dispose(): void', invalidateStart);
  const invalidate = renderer.slice(invalidateStart, disposeStart);

  assert.match(prepare, /if \(registered > 0\) this\.invalidateTextFontCaches\(\)/);
  assert.match(invalidate, /for \(const blob of this\.textBlobCache\.values\(\)\) blob\.delete\(\)/);
  assert.match(invalidate, /this\.textBlobCache\.clear\(\)/);
  assert.match(invalidate, /this\.textFallbackFamilyCache\.clear\(\)/);
  assert.match(invalidate, /this\.resetTextReplayDiagnostics\(\)/);
  assert.match(invalidate, /this\.clearStaticPictureCache\(\)/);
  assert.match(renderer.slice(disposeStart), /this\.invalidateTextFontCaches\(\)/);
});

test('CanvasKit local provider selection preserves physical weight and slant', () => {
  const registry = source('../src/view/canvaskit/fonts.ts');
  const renderer = source('../src/view/canvaskit-renderer.ts');

  assert.match(registry, /localProviderFamilies = new Map<string, CanvasKitLocalProviderFace\[\]>/);
  assert.match(registry, /localAliasProviderFaces = new Map<string, CanvasKitLocalProviderFace\[\]>/);
  assert.match(registry, /\? \[300, 400, 500, 700\]/);
  assert.match(registry, /\? \[400, 500, 300, 700\]/);
  assert.match(registry, /\? \[500, 400, 300, 700\]/);
  assert.match(registry, /: \[700, 500, 400, 300\]/);
  assert.match(registry, /synthesizeBold: weight === 700 && face\.weight !== 700/);
  assert.match(registry, /synthesizeItalic: italic && !face\.italic/);
  assert.match(renderer, /font\.setEmbolden\(providerFace\.synthesizeBold\)/);
  assert.match(renderer, /font\.setSkewX\(providerFace\.synthesizeItalic \? -0\.25 : 0\)/);
});
