import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  resolveCanvasKitRenderMode,
  resolveCanvasKitSurfaceRequest,
  resolveRenderBackend,
  resolveRenderProfile,
} from '../src/view/render-backend.ts';
import {
  CANVASKIT_REPLAY_PLANES,
  LAYER_REPLAY_PLANES,
  layerPaintOpReplayPlane,
} from '../src/view/canvaskit/replay-plane.ts';
import type { LayerPaintOp } from '../src/core/types.ts';

test('render backend resolver keeps Canvas2D as default and accepts Skia aliases', () => {
  assert.equal(resolveRenderBackend(''), 'canvas2d');
  assert.equal(resolveRenderBackend('?renderer=canvas'), 'canvas2d');
  assert.equal(resolveRenderBackend('?renderer=canvas2d'), 'canvas2d');
  assert.equal(resolveRenderBackend('?renderer=canvaskit'), 'canvaskit');
  assert.equal(resolveRenderBackend('?renderer=skia'), 'canvaskit');
});

test('CanvasKit mode resolver exposes default and conservative compat direct modes', () => {
  assert.equal(resolveCanvasKitRenderMode(''), 'default');
  assert.equal(resolveCanvasKitRenderMode('?canvaskitMode=default'), 'default');
  assert.equal(resolveCanvasKitRenderMode('?canvaskitMode=compat'), 'compat');
  assert.equal(resolveCanvasKitRenderMode('?canvaskitMode=overlay'), 'default');
});

test('CanvasKit surface resolver records unsupported requests without throwing', () => {
  assert.deepEqual(resolveCanvasKitSurfaceRequest('?canvaskitSurface=webgpu'), {
    preference: 'webgpu',
    requested: 'webgpu',
    unsupportedValue: null,
    unsupportedReason: null,
  });
  assert.deepEqual(resolveCanvasKitSurfaceRequest('?canvaskitSurface=cpu'), {
    preference: 'software',
    requested: 'cpu',
    unsupportedValue: null,
    unsupportedReason: null,
  });
  assert.deepEqual(resolveCanvasKitSurfaceRequest('?canvaskitSurface=metal'), {
    preference: 'auto',
    requested: 'metal',
    unsupportedValue: 'metal',
    unsupportedReason: 'unsupportedSurfaceBackend',
  });
});

test('render profile resolver keeps screen as the stable browser default', () => {
  assert.equal(resolveRenderProfile(''), 'screen');
  assert.equal(resolveRenderProfile('?renderProfile=fast-preview'), 'fast-preview');
  assert.equal(resolveRenderProfile('?profile=print'), 'screen');
  assert.equal(resolveRenderProfile('?renderProfile=highQuality'), 'high-quality');
});

test('browser replay planes match the native HWP z-order contract', () => {
  assert.deepEqual(
    [...LAYER_REPLAY_PLANES],
    ['background', 'behindText', 'flow', 'inFrontOfText'],
  );
  assert.equal(CANVASKIT_REPLAY_PLANES, LAYER_REPLAY_PLANES);
});

test('CanvasKit replay plane helper classifies PageLayerTree ops by wrap', () => {
  const bbox = { x: 0, y: 0, width: 10, height: 10 };
  const cases: Array<[LayerPaintOp, string]> = [
    [{ type: 'pageBackground', bbox }, 'background'],
    [{ type: 'image', bbox, wrap: 'behindText' }, 'behindText'],
    [{ type: 'image', bbox, wrap: 'inFrontOfText' }, 'inFrontOfText'],
    [{ type: 'image', bbox, wrap: 'topAndBottom' }, 'flow'],
    [{ type: 'image', bbox }, 'flow'],
    [{
      type: 'textControlMark',
      bbox,
      wrap: 'behindText',
      mark: { kind: 'picture', text: '[그림]', x: 0, y: 10, fontSize: 10 },
    }, 'behindText'],
    [{
      type: 'textControlMark',
      bbox,
      wrap: 'inFrontOfText',
      mark: { kind: 'picture', text: '[그림]', x: 0, y: 10, fontSize: 10 },
    }, 'inFrontOfText'],
    [{
      type: 'textControlMark',
      bbox,
      mark: { kind: 'table', text: '[표]', x: 0, y: 10, fontSize: 10 },
    }, 'flow'],
    [{ type: 'textRun', bbox, text: 'flow' }, 'flow'],
    [{ type: 'rectangle', bbox, style: { fillColor: '#ff0000' } }, 'flow'],
  ];

  for (const [op, expected] of cases) {
    assert.equal(layerPaintOpReplayPlane(op), expected, op.type);
  }
});

test('CanvasKit renderer source does not introduce Canvas2D overlay replay', () => {
  const source = readFileSync(new URL('../src/view/canvaskit-renderer.ts', import.meta.url), 'utf8');

  assert.equal(source.includes("getContext('2d')"), false);
  assert.equal(source.includes('renderPageToCanvas'), false);
  assert.equal(source.includes('rhwpOverlay'), false);
  assert.match(source, /for \(const replayPlane of CANVASKIT_REPLAY_PLANES\)/);
});

test('CanvasKit and Canvas2D preserve fractional page bitmap edges', () => {
  const source = readFileSync(new URL('../src/view/page-renderer.ts', import.meta.url), 'utf8');

  assert.match(
    source,
    /canvasWidth\s*=\s*Math\.max\(1,\s*Math\.ceil\(pageInfo\.width \* appliedScale\)\)/,
  );
  assert.match(
    source,
    /canvasHeight\s*=\s*Math\.max\(1,\s*Math\.ceil\(pageInfo\.height \* appliedScale\)\)/,
  );
});
