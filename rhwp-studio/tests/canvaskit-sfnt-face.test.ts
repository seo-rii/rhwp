import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { canvasKitFontFaceData } from '../src/view/canvaskit/sfnt-face.ts';

function fixtureBuffer(name: string): ArrayBuffer {
  const bytes = readFileSync(new URL(`../../tests/fixtures/fonts/${name}`, import.meta.url));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

test('CanvasKit SFNT normalization selects exact TTC faces', () => {
  const collection = fixtureBuffer('RHWPExactFaceSmoke.ttc');
  const face0 = canvasKitFontFaceData(collection, 0);
  const face1 = canvasKitFontFaceData(collection, 1);

  assert.ok(face0);
  assert.ok(face1);
  assert.notEqual(new DataView(face0).getUint32(0, false), 0x7474_6366);
  assert.notEqual(new DataView(face1).getUint32(0, false), 0x7474_6366);
  assert.notDeepEqual(
    new Uint8Array(face0, 0, 64),
    new Uint8Array(face1, 0, 64),
    'each selected face must expose its own SFNT directory',
  );
  assert.equal(canvasKitFontFaceData(collection, 2), null);
});

test('CanvasKit SFNT normalization keeps standalone fonts on face zero', () => {
  const standalone = fixtureBuffer('RHWPColorSmokeCOLRv0.ttf');
  const selected = canvasKitFontFaceData(standalone, 0);

  assert.ok(selected);
  assert.deepEqual(new Uint8Array(selected), new Uint8Array(standalone));
  assert.equal(canvasKitFontFaceData(standalone, 1), null);
});

test('CanvasKit SFNT normalization rejects malformed collection directories', () => {
  const collection = fixtureBuffer('RHWPExactFaceSmoke.ttc');
  const malformed = collection.slice(0);
  const view = new DataView(malformed);
  const secondFaceOffset = view.getUint32(16, false);
  view.setUint32(secondFaceOffset + 20, 0, false);

  assert.equal(canvasKitFontFaceData(malformed, 1), null);
  assert.equal(canvasKitFontFaceData(new ArrayBuffer(8), 1), null);
  assert.equal(canvasKitFontFaceData(collection, -1), null);
  assert.equal(canvasKitFontFaceData(collection, 1.5), null);
});

test('CanvasKit SFNT normalization protects TTC v2 DSIG metadata', () => {
  const collection = fixtureBuffer('RHWPExactFaceSmoke.ttc');
  const malformed = collection.slice(0);
  const view = new DataView(malformed);
  const faceCount = view.getUint32(8, false);
  const secondFaceOffset = view.getUint32(16, false);
  const v2HeaderLength = 12 + faceCount * 4 + 12;

  view.setUint32(4, 0x0002_0000, false);
  view.setUint32(secondFaceOffset + 20, v2HeaderLength - 4, false);

  assert.equal(canvasKitFontFaceData(malformed, 1), null);
});
