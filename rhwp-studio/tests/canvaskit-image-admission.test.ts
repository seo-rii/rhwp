import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CANVASKIT_MAX_ENCODED_IMAGE_BASE64_BYTES,
  CANVASKIT_MAX_SVG_BYTES,
  canvasKitEncodedImageHeader,
  canvasKitEncodedImageHasStableFrame,
  canvasKitEncodedImageIsReplayable,
} from '../src/view/canvaskit/encoded-image-admission.ts';

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(bytes.buffer).setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    height >> 8, height & 0xff,
    width >> 8, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
  ]);
  return bytes;
}

function gif(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(13);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
}

function webp(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46]);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 22, true);
  bytes.set([0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58], 8);
  view.setUint32(16, 10, true);
  const encodedWidth = width - 1;
  const encodedHeight = height - 1;
  bytes.set([
    encodedWidth & 0xff,
    (encodedWidth >> 8) & 0xff,
    (encodedWidth >> 16) & 0xff,
  ], 24);
  bytes.set([
    encodedHeight & 0xff,
    (encodedHeight >> 8) & 0xff,
    (encodedHeight >> 16) & 0xff,
  ], 27);
  return bytes;
}

function gifWithFrames(width: number, height: number, frameCount: number): Uint8Array {
  const bytes = new Uint8Array(19 + frameCount * 15 + 1);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  bytes[10] = 0x80;
  bytes.set([0, 0, 0, 0xff, 0xff, 0xff], 13);
  let offset = 19;
  for (let frame = 0; frame < frameCount; frame += 1) {
    bytes[offset] = 0x2c;
    view.setUint16(offset + 5, width, true);
    view.setUint16(offset + 7, height, true);
    bytes.set([0x02, 0x02, 0x44, 0x01, 0x00], offset + 10);
    offset += 15;
  }
  bytes[offset] = 0x3b;
  return bytes;
}

function extendedWebp(width: number, height: number, animated = false): Uint8Array {
  const bytes = new Uint8Array(48);
  bytes.set([0x52, 0x49, 0x46, 0x46]);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 40, true);
  bytes.set([0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58], 8);
  view.setUint32(16, 10, true);
  bytes[20] = animated ? 0x02 : 0;
  const encodedWidth = width - 1;
  const encodedHeight = height - 1;
  bytes.set([
    encodedWidth & 0xff,
    (encodedWidth >> 8) & 0xff,
    (encodedWidth >> 16) & 0xff,
  ], 24);
  bytes.set([
    encodedHeight & 0xff,
    (encodedHeight >> 8) & 0xff,
    (encodedHeight >> 16) & 0xff,
  ], 27);
  bytes.set([0x56, 0x50, 0x38, 0x20], 30);
  view.setUint32(34, 10, true);
  bytes.set([0x9d, 0x01, 0x2a], 41);
  view.setUint16(44, width, true);
  view.setUint16(46, height, true);
  return bytes;
}

function bmp(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(54);
  bytes.set([0x42, 0x4d]);
  const view = new DataView(bytes.buffer);
  view.setUint32(2, 54, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  return bytes;
}

function svg(attributes: string): Uint8Array {
  return new TextEncoder().encode(
    `<?xml version="1.0"?><!-- fixture --><svg xmlns="http://www.w3.org/2000/svg" ${attributes}><path d="M0 0h1v1z"/></svg>`,
  );
}

test('CanvasKit encoded-image admission accepts bounded browser formats', () => {
  const fixtures = [
    [png(320, 240), { format: 'png', width: 320, height: 240 }],
    [jpeg(300, 200), { format: 'jpeg', width: 300, height: 200 }],
    [gif(160, 120), { format: 'gif', width: 160, height: 120 }],
    [webp(640, 480), { format: 'webp', width: 640, height: 480 }],
    [bmp(800, -600), { format: 'bmp', width: 800, height: 600 }],
    [svg('width="320" height="240"'), { format: 'svg', width: 320, height: 240 }],
  ] as const;
  for (const [bytes, expected] of fixtures) {
    assert.deepEqual(canvasKitEncodedImageHeader(bytes), expected);
    assert.equal(canvasKitEncodedImageIsReplayable(bytes), true);
  }
  assert.equal(canvasKitEncodedImageIsReplayable(png(8192, 4096)), true);
});

test('CanvasKit encoded-image admission rejects malformed and oversized payloads', () => {
  assert.equal(canvasKitEncodedImageIsReplayable(new Uint8Array()), false);
  assert.equal(canvasKitEncodedImageIsReplayable(png(8193, 1)), false);
  assert.equal(canvasKitEncodedImageIsReplayable(jpeg(8192, 8192)), false);
  assert.equal(canvasKitEncodedImageIsReplayable(png(1, 1).subarray(0, 32)), false);

  const maxRawBytes = Math.floor(CANVASKIT_MAX_ENCODED_IMAGE_BASE64_BYTES / 4) * 3;
  const overEncodedLimit = new Uint8Array(maxRawBytes + 1);
  overEncodedLimit.set(png(1, 1));
  assert.equal(canvasKitEncodedImageIsReplayable(overEncodedLimit), false);
});

test('CanvasKit browser recovery admits only structurally stable GIF and WebP frames', () => {
  assert.equal(canvasKitEncodedImageHasStableFrame(gifWithFrames(2, 1, 1)), true);
  assert.equal(canvasKitEncodedImageHasStableFrame(gifWithFrames(2, 1, 2)), false);
  assert.equal(canvasKitEncodedImageHasStableFrame(gif(2, 1)), false);

  assert.equal(canvasKitEncodedImageHasStableFrame(extendedWebp(2, 1)), true);
  assert.equal(canvasKitEncodedImageHasStableFrame(extendedWebp(2, 1, true)), false);
  assert.equal(canvasKitEncodedImageHasStableFrame(webp(2, 1)), false);
  assert.equal(
    canvasKitEncodedImageHasStableFrame(extendedWebp(2, 1).subarray(0, 47)),
    false,
  );
});

test('CanvasKit SVG admission resolves bounded intrinsic dimensions', () => {
  assert.deepEqual(
    canvasKitEncodedImageHeader(svg('viewBox="0 0 640 360"')),
    { format: 'svg', width: 640, height: 360 },
  );
  assert.deepEqual(
    canvasKitEncodedImageHeader(svg('width="320px" viewBox="0 0 16 9"')),
    { format: 'svg', width: 320, height: 180 },
  );
  assert.deepEqual(
    canvasKitEncodedImageHeader(svg('width="100%" height="100%"')),
    { format: 'svg', width: 300, height: 150 },
  );
  assert.deepEqual(
    canvasKitEncodedImageHeader(svg('width="1in" height="72pt"')),
    { format: 'svg', width: 96, height: 96 },
  );
});

test('CanvasKit SVG admission rejects unsafe, invalid, and oversized resources', () => {
  const encode = (source: string): Uint8Array => new TextEncoder().encode(source);
  assert.equal(canvasKitEncodedImageHeader(encode('<!DOCTYPE svg><svg/>')), null);
  assert.equal(canvasKitEncodedImageHeader(encode('<html/>')), null);
  assert.equal(canvasKitEncodedImageHeader(encode('<svg width="0" height="1"/>')), null);
  assert.equal(canvasKitEncodedImageHeader(encode('<svg viewBox="0 0 -1 1"/>')), null);
  assert.equal(canvasKitEncodedImageHeader(encode('<svg width="1em" height="1"/>')), null);
  assert.equal(canvasKitEncodedImageIsReplayable(svg('width="8193" height="1"')), false);

  const oversized = new Uint8Array(CANVASKIT_MAX_SVG_BYTES + 1);
  oversized.fill(0x20);
  oversized.set(encode('<svg width="1" height="1">'));
  assert.equal(canvasKitEncodedImageIsReplayable(oversized), false);
});
