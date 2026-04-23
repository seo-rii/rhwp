import type { CanvasKit, Surface } from 'canvaskit-wasm';

export type CachedCanvasKitSurface = {
  surface: Surface;
  usedGpuSurface: boolean;
};

export class CanvasKitSurfaceCache {
  private surface: Surface | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private width = 0;
  private height = 0;
  private usedGpuSurface = false;

  constructor(private readonly canvasKit: CanvasKit) {}

  get(targetCanvas: HTMLCanvasElement): CachedCanvasKitSurface {
    if (
      this.surface
      && this.canvas === targetCanvas
      && this.width === targetCanvas.width
      && this.height === targetCanvas.height
    ) {
      return {
        surface: this.surface,
        usedGpuSurface: this.usedGpuSurface,
      };
    }

    this.clear();
    let surface: Surface | null = null;
    let usedGpuSurface = false;
    try {
      surface = this.canvasKit.MakeCanvasSurface(targetCanvas);
      usedGpuSurface = surface !== null;
    } catch {
      surface = null;
    }
    surface ??= this.canvasKit.MakeSWCanvasSurface(targetCanvas);
    if (!surface) {
      throw new Error('CanvasKit surface 생성 실패');
    }

    this.surface = surface;
    this.canvas = targetCanvas;
    this.width = targetCanvas.width;
    this.height = targetCanvas.height;
    this.usedGpuSurface = usedGpuSurface;
    return { surface, usedGpuSurface };
  }

  replaceWithSoftware(targetCanvas: HTMLCanvasElement): Surface | null {
    this.clear();
    const surface = this.canvasKit.MakeSWCanvasSurface(targetCanvas);
    if (!surface) {
      return null;
    }

    this.surface = surface;
    this.canvas = targetCanvas;
    this.width = targetCanvas.width;
    this.height = targetCanvas.height;
    this.usedGpuSurface = false;
    return surface;
  }

  clear(): void {
    this.surface?.delete();
    this.surface = null;
    this.canvas = null;
    this.width = 0;
    this.height = 0;
    this.usedGpuSurface = false;
  }
}
