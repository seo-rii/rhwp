import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createServer } from 'vite';

const studioRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let vite;
let CanvasKitStaticPictureCache;

test.before(async () => {
  vite = await createServer({
    root: studioRoot,
    logLevel: 'silent',
    server: { middlewareMode: true },
  });
  ({ CanvasKitStaticPictureCache } = await vite.ssrLoadModule(
    '/src/view/canvaskit/static-picture-cache.ts',
  ));
});

test.after(async () => {
  await vite?.close();
});

test('static picture key ignores unreferenced image and SVG payload changes', () => {
  const cache = new CanvasKitStaticPictureCache();
  const tree = pageTree([{
    type: 'image',
    bbox: bounds(),
    resourceId: 0,
    transform: identityTransform(),
  }]);
  tree.resources = {
    tableId: 7,
    images: [Uint8Array.of(1, 2, 3), Uint8Array.of(4, 5, 6)],
    imageHashes: ['image-a', 'image-b'],
    imageKeys: ['image:a', 'image:b'],
    svgFragments: ['<svg id="a"/>', '<svg id="b"/>'],
    svgHashes: ['svg-a', 'svg-b'],
    svgKeys: ['svg:a', 'svg:b'],
  };

  const initialKey = staticSubtreeKey(cache, tree);
  tree.resources.images[1] = Uint8Array.of(40, 50, 60);
  tree.resources.svgFragments[0] = '<svg id="changed-but-unused"/>';

  assert.equal(staticSubtreeKey(cache, tree), initialKey);

  tree.resources.images[0] = Uint8Array.of(10, 20, 30);
  assert.notEqual(staticSubtreeKey(cache, tree), initialKey);
});

test('static picture key includes only sidecars anchored inside the subtree', () => {
  const cache = new CanvasKitStaticPictureCache();
  const fallback = textRun('text-anchor', 'fallback');
  const relevantSidecar = bitmapGlyphOutline('text-anchor', 0, '#224466');
  const tree = pageTree([fallback]);
  tree.resources = {
    tableId: 3,
    images: [Uint8Array.of(1, 2, 3)],
    imageHashes: ['bitmap-a'],
    imageKeys: ['bitmap:a'],
    svgFragments: [],
  };
  tree.variantOps = [relevantSidecar];

  const initialKey = staticSubtreeKey(cache, tree);
  tree.variantOps.push(bitmapGlyphOutline('other-anchor', 0, '#ff0000'));
  assert.equal(staticSubtreeKey(cache, tree), initialKey);

  relevantSidecar.paintStyle.color = '#335577';
  assert.notEqual(staticSubtreeKey(cache, tree), initialKey);
});

test('static picture key fingerprints only the font face and blob used by a GlyphRun', () => {
  const cache = new CanvasKitStaticPictureCache();
  const tree = pageTree([glyphRun('face-a')]);
  tree.resources = {
    tableId: 11,
    images: [],
    svgFragments: [],
    fontBlobs: [Uint8Array.of(1, 2, 3), Uint8Array.of(4, 5, 6)],
    fontBlobHashes: ['digest-a', 'digest-b'],
    fontBlobKeys: ['font:a', 'font:b'],
  };
  tree.fontResources = {
    blobs: [
      {
        id: 'blob-a',
        source: 'embedded',
        portability: 'portableBlob',
        digest: { algorithm: 'sha256', value: 'digest-a' },
        dataRef: { kind: 'fontBlob', id: '0' },
      },
      {
        id: 'blob-b',
        source: 'embedded',
        portability: 'portableBlob',
        digest: { algorithm: 'sha256', value: 'digest-b' },
        dataRef: { kind: 'fontBlob', id: '1' },
      },
    ],
    faces: [
      { id: 'face-a', blobKey: 'blob-a', faceIndex: 0, postscriptName: 'FaceA' },
      { id: 'face-b', blobKey: 'blob-b', faceIndex: 0, postscriptName: 'FaceB' },
    ],
  };

  const initialKey = staticSubtreeKey(cache, tree);
  tree.resources.fontBlobs[1] = Uint8Array.of(40, 50, 60);
  tree.fontResources.faces[1].postscriptName = 'ChangedFaceB';
  assert.equal(staticSubtreeKey(cache, tree), initialKey);

  tree.resources.fontBlobs[0] = Uint8Array.of(10, 20, 30);
  const changedPayloadKey = staticSubtreeKey(cache, tree);
  assert.notEqual(changedPayloadKey, initialKey);

  tree.fontResources.faces[0].postscriptName = 'ChangedFaceA';
  assert.notEqual(staticSubtreeKey(cache, tree), changedPayloadKey);
});

function staticSubtreeKey(cache, tree) {
  return cache.keyForStaticSubtree(
    cache.cacheKeyForLayerTree(tree),
    tree.profile,
    'flow',
    tree.root,
    tree,
  );
}

function pageTree(ops) {
  return {
    pageWidth: 100,
    pageHeight: 100,
    profile: 'screen',
    outputOptions: {
      clipEnabled: true,
      showParagraphMarks: false,
      showControlCodes: false,
    },
    root: {
      kind: 'group',
      bounds: bounds(),
      cacheHint: 'staticSubtree',
      children: [{
        kind: 'leaf',
        bounds: bounds(),
        cacheHint: 'none',
        ops,
      }],
    },
  };
}

function textRun(id, variantId) {
  return {
    id,
    type: 'textRun',
    bbox: bounds(),
    text: 'A',
    baseline: 16,
    rotation: 0,
    isVertical: false,
    variant: {
      equivalenceGroup: 'text-group',
      variantId,
      partIndex: 0,
      partCount: 1,
      isDefaultFallback: true,
    },
    style: textStyle(),
    positions: [0],
  };
}

function bitmapGlyphOutline(anchorOpId, imageResourceId, color) {
  return {
    id: `outline-${anchorOpId}`,
    type: 'glyphOutline',
    anchorOpId,
    bbox: bounds(),
    source: {
      sourceId: 'source-1',
      utf8Range: { start: 0, end: 1 },
    },
    variant: {
      equivalenceGroup: 'text-group',
      variantId: 'glyphOutline',
      partIndex: 0,
      partCount: 1,
      anchorOpId,
    },
    paintStyle: { ...textStyle(), color },
    payloadKind: 'bitmapGlyph',
    bitmapGlyph: {
      imageResourceId,
      placement: placement(),
      alphaMode: 'premultiplied',
      scalingPolicy: 'explicitTransform',
      filtering: 'linear',
    },
    placement: placement(),
    paths: [],
    diagnostics: {
      strictVisualEligible: true,
      replayEligibility: 'portable',
    },
  };
}

function glyphRun(faceKey) {
  return {
    id: 'glyph-run',
    type: 'glyphRun',
    bbox: bounds(),
    source: {
      sourceId: 'source-1',
      utf8Range: { start: 0, end: 1 },
    },
    variant: {
      equivalenceGroup: 'text-group',
      variantId: 'glyphRun',
      partIndex: 0,
      partCount: 1,
    },
    paintStyle: textStyle(),
    shapeKey: {
      fontInstance: {
        faceKey,
        sizePx: 16,
      },
      direction: 'ltr',
      writingMode: 'horizontal-tb',
      script: 'Latn',
      language: 'en',
      features: [],
      shapingEngine: 'rustybuzz',
      fallbackPolicy: 'none',
    },
    placement: placement(),
    glyphIds: [1],
    positions: [{ x: 0, y: 0 }],
    clusters: [{
      glyphRange: { start: 0, end: 1 },
      sourceRangeUtf8: { start: 0, end: 1 },
    }],
    direction: 'ltr',
    writingMode: 'horizontal-tb',
    orientation: 'horizontal',
    diagnostics: {
      strictVisualEligible: true,
      replayEligibility: 'portable',
    },
  };
}

function textStyle() {
  return {
    fontFamily: 'Fixture',
    fontSize: 16,
    color: '#112233',
  };
}

function placement() {
  return {
    runToPage: {
      a: 1,
      b: 0,
      c: 0,
      d: 1,
      e: 0,
      f: 0,
    },
  };
}

function identityTransform() {
  return {
    translateX: 0,
    translateY: 0,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
  };
}

function bounds() {
  return {
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  };
}
