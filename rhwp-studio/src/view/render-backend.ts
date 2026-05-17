import type { LayerRenderProfile, PageInfo } from '@/core/types';

export type RenderBackend = 'canvas2d' | 'canvaskit';
export type CanvasKitRenderMode = 'default' | 'compat';
export type CanvasKitSurfacePreference = 'auto' | 'webgl' | 'software';

const STORAGE_KEY = 'rhwp-render-backend';
const CANVASKIT_MODE_STORAGE_KEY = 'rhwp-canvaskit-render-mode';
const RENDER_PROFILE_STORAGE_KEY = 'rhwp-render-profile';

export function resolveRenderBackend(search: string): RenderBackend {
  const params = new URLSearchParams(search);
  const requested = params.get('renderer');

  if (requested === 'canvaskit') return 'canvaskit';
  if (requested === 'canvas' || requested === 'canvas2d') return 'canvas2d';

  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'canvaskit' ? 'canvaskit' : 'canvas2d';
  } catch {
    return 'canvas2d';
  }
}

export function persistRenderBackend(backend: RenderBackend): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, backend);
  } catch {
    // private mode / disabled storage: 무시하고 query-param 선택만 사용한다.
  }
}

export function resolveCanvasKitRenderMode(search: string): CanvasKitRenderMode {
  const params = new URLSearchParams(search);
  const requested = params.get('canvaskitMode');

  if (requested === 'default') return 'default';
  if (requested === 'compat') return 'compat';

  try {
    return window.localStorage.getItem(CANVASKIT_MODE_STORAGE_KEY) === 'compat'
      ? 'compat'
      : 'default';
  } catch {
    return 'default';
  }
}

export function persistCanvasKitRenderMode(mode: CanvasKitRenderMode): void {
  try {
    window.localStorage.setItem(CANVASKIT_MODE_STORAGE_KEY, mode);
  } catch {
    // private mode / disabled storage: 무시하고 query-param 선택만 사용한다.
  }
}

export function resolveCanvasKitSurfacePreference(search: string): CanvasKitSurfacePreference {
  const params = new URLSearchParams(search);
  const requested = params.get('canvaskitSurface') ?? params.get('canvaskitSurfaceBackend');

  if (requested === 'webgl') return 'webgl';
  if (requested === 'software' || requested === 'sw') return 'software';
  // CanvasKit in rhwp currently exposes WebGL and software surfaces only.
  // Unsupported values such as "webgpu" intentionally fall back to auto.
  return 'auto';
}

export function resolveRenderProfile(search: string): LayerRenderProfile {
  const params = new URLSearchParams(search);
  const requested = params.get('renderProfile')?.trim().toLowerCase();

  switch (requested) {
    case 'fast':
    case 'preview':
    case 'fastpreview':
    case 'fast-preview':
      return 'fast-preview';
    case 'screen':
      return 'screen';
    case 'print':
      return 'print';
    case 'high':
    case 'quality':
    case 'highquality':
    case 'high-quality':
      return 'high-quality';
    default:
      break;
  }

  try {
    const stored = window.localStorage.getItem(RENDER_PROFILE_STORAGE_KEY);
    return stored === 'fast-preview'
      || stored === 'print'
      || stored === 'high-quality'
      ? stored
      : 'screen';
  } catch {
    return 'screen';
  }
}

export function persistRenderProfile(profile: LayerRenderProfile): void {
  try {
    window.localStorage.setItem(RENDER_PROFILE_STORAGE_KEY, profile);
  } catch {
    // private mode / disabled storage: 무시하고 query-param 선택만 사용한다.
  }
}

export function clampRenderScale(pageInfo: Pick<PageInfo, 'width' | 'height'>, requestedScale: number): number {
  let scale = requestedScale <= 0 || Number.isNaN(requestedScale) ? 1.0 : Math.min(Math.max(requestedScale, 0.25), 12.0);
  const maxDim = 16384;

  if (pageInfo.width * scale > maxDim || pageInfo.height * scale > maxDim) {
    scale = Math.min(maxDim / pageInfo.width, maxDim / pageInfo.height, scale);
  }

  return scale;
}
