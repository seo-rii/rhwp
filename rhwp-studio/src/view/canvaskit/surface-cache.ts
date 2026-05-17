import type { CanvasKit, Surface, WebGPUCanvasContext, WebGPUDeviceContext } from 'canvaskit-wasm';
import { DEFAULT_CANVASKIT_SURFACE_REQUEST } from '@/view/render-backend';
import type { CanvasKitSurfaceRequest } from '@/view/render-backend';

export type CachedCanvasKitSurface = {
  surface: Surface;
  usedGpuSurface: boolean;
  backend: CanvasKitSurfaceBackend;
};

export type CanvasKitSurfaceBackend = 'webgpu' | 'webgl' | 'software';

export type CanvasKitSurfaceDiagnostics = {
  preference: CanvasKitSurfaceRequest['preference'];
  requested: string | null;
  unsupportedValue: string | null;
  unsupportedReason: CanvasKitSurfaceRequest['unsupportedReason'];
  backend: CanvasKitSurfaceBackend | 'none';
  usedGpuSurface: boolean;
  createdSurfaces: number;
  reusedSurfaces: number;
  webgpuAttempts: number;
  webgpuFailures: number;
  webglAttempts: number;
  webglFailures: number;
  softwareAttempts: number;
  softwareFailures: number;
  softwareFallbacks: number;
  lastFailure: string | null;
};

export class CanvasKitSurfaceCache {
  private surface: Surface | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private webgpuCanvasContext: WebGPUCanvasContext | null = null;
  private width = 0;
  private height = 0;
  private usedGpuSurface = false;
  private backend: CanvasKitSurfaceBackend | 'none' = 'none';
  private createdSurfaces = 0;
  private reusedSurfaces = 0;
  private webgpuAttempts = 0;
  private webgpuFailures = 0;
  private webglAttempts = 0;
  private webglFailures = 0;
  private softwareAttempts = 0;
  private softwareFailures = 0;
  private softwareFallbacks = 0;
  private lastFailure: string | null = null;

  constructor(
    private readonly canvasKit: CanvasKit,
    private readonly surfaceRequest: CanvasKitSurfaceRequest = DEFAULT_CANVASKIT_SURFACE_REQUEST,
    private readonly webgpuDeviceContext: WebGPUDeviceContext | null = null,
    private readonly webgpuInitFailure: string | null = null,
  ) {}

  get(targetCanvas: HTMLCanvasElement): CachedCanvasKitSurface {
    if (
      this.surface
      && this.canvas === targetCanvas
      && this.width === targetCanvas.width
      && this.height === targetCanvas.height
    ) {
      this.reusedSurfaces += 1;
      return {
        surface: this.surface,
        usedGpuSurface: this.usedGpuSurface,
        backend: this.backend === 'none' ? 'software' : this.backend,
      };
    }

    this.clear();
    let surface: Surface | null = null;
    let backend: CanvasKitSurfaceBackend | 'none' = 'none';
    if (this.surfaceRequest.preference === 'webgpu') {
      this.webgpuAttempts += 1;
      if (!this.webgpuDeviceContext) {
        this.webgpuFailures += 1;
        this.lastFailure = this.webgpuInitFailure ?? 'CanvasKit WebGPU device context unavailable';
      } else {
        let threw = false;
        try {
          this.webgpuCanvasContext = this.canvasKit.MakeGPUCanvasContext(
            this.webgpuDeviceContext,
            targetCanvas,
          );
          if (this.webgpuCanvasContext) {
            surface = this.canvasKit.MakeGPUCanvasSurface(
              this.webgpuCanvasContext,
              this.canvasKit.ColorSpace.SRGB,
              targetCanvas.width,
              targetCanvas.height,
            );
            if (surface) {
              backend = 'webgpu';
            }
          }
        } catch (error) {
          threw = true;
          this.webgpuFailures += 1;
          this.lastFailure = error instanceof Error ? error.message : String(error);
        }
        if (!surface && !threw) {
          this.webgpuFailures += 1;
          this.lastFailure = 'CanvasKit MakeGPUCanvasSurface returned null';
        }
      }
    }

    if (!surface && this.surfaceRequest.preference !== 'software') {
      this.webglAttempts += 1;
      let threw = false;
      try {
        surface = this.canvasKit.MakeWebGLCanvasSurface(targetCanvas);
        if (surface) {
          backend = 'webgl';
        }
      } catch (error) {
        threw = true;
        this.webglFailures += 1;
        this.lastFailure = error instanceof Error ? error.message : String(error);
      }
      if (!surface && !threw) {
        this.webglFailures += 1;
        this.lastFailure = 'CanvasKit MakeWebGLCanvasSurface returned null';
      }
    }

    if (!surface) {
      if (this.surfaceRequest.preference !== 'software') {
        this.softwareFallbacks += 1;
      }
      this.softwareAttempts += 1;
      let threw = false;
      try {
        surface = this.canvasKit.MakeSWCanvasSurface(targetCanvas);
        if (surface) {
          backend = 'software';
        }
      } catch (error) {
        threw = true;
        this.softwareFailures += 1;
        this.lastFailure = error instanceof Error ? error.message : String(error);
      }
      if (!surface && !threw) {
        this.softwareFailures += 1;
        this.lastFailure = 'CanvasKit MakeSWCanvasSurface returned null';
      }
    }

    if (!surface) {
      throw new Error('CanvasKit surface 생성 실패');
    }

    this.surface = surface;
    this.canvas = targetCanvas;
    this.width = targetCanvas.width;
    this.height = targetCanvas.height;
    this.backend = backend === 'none' ? 'software' : backend;
    this.usedGpuSurface = this.backend === 'webgpu' || this.backend === 'webgl';
    this.createdSurfaces += 1;
    return { surface, usedGpuSurface: this.usedGpuSurface, backend: this.backend };
  }

  replaceWithSoftware(targetCanvas: HTMLCanvasElement): Surface | null {
    this.clear();
    this.softwareAttempts += 1;
    this.softwareFallbacks += 1;
    let surface: Surface | null = null;
    let threw = false;
    try {
      surface = this.canvasKit.MakeSWCanvasSurface(targetCanvas);
    } catch (error) {
      threw = true;
      this.softwareFailures += 1;
      this.lastFailure = error instanceof Error ? error.message : String(error);
    }
    if (!surface) {
      if (!threw) {
        this.softwareFailures += 1;
        this.lastFailure = 'CanvasKit MakeSWCanvasSurface returned null';
      }
      return null;
    }

    this.surface = surface;
    this.canvas = targetCanvas;
    this.width = targetCanvas.width;
    this.height = targetCanvas.height;
    this.usedGpuSurface = false;
    this.backend = 'software';
    this.createdSurfaces += 1;
    return surface;
  }

  getDiagnostics(): CanvasKitSurfaceDiagnostics {
    return {
      preference: this.surfaceRequest.preference,
      requested: this.surfaceRequest.requested,
      unsupportedValue: this.surfaceRequest.unsupportedValue,
      unsupportedReason: this.surfaceRequest.unsupportedReason,
      backend: this.backend,
      usedGpuSurface: this.usedGpuSurface,
      createdSurfaces: this.createdSurfaces,
      reusedSurfaces: this.reusedSurfaces,
      webgpuAttempts: this.webgpuAttempts,
      webgpuFailures: this.webgpuFailures,
      webglAttempts: this.webglAttempts,
      webglFailures: this.webglFailures,
      softwareAttempts: this.softwareAttempts,
      softwareFailures: this.softwareFailures,
      softwareFallbacks: this.softwareFallbacks,
      lastFailure: this.lastFailure,
    };
  }

  clear(): void {
    this.surface?.delete();
    this.surface = null;
    this.canvas = null;
    this.webgpuCanvasContext = null;
    this.width = 0;
    this.height = 0;
    this.usedGpuSurface = false;
    this.backend = 'none';
  }
}
