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
