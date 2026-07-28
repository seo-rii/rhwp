import { WasmBridge } from '@/core/wasm-bridge';
import type { LayerRenderProfile, PageInfo, PageLayerTree } from '@/core/types';
import { CanvasKitLayerRenderer } from './canvaskit-renderer';
import { Canvas2DLayerRenderer } from './canvas2d-layer-renderer';
import { clampRenderScale, type RenderBackend } from './render-backend';

const DEFAULT_LAYER_TREE_CACHE_LIMIT = 12;

type ActivePageRenderState = {
  pageInfo: PageInfo;
  canvas: HTMLCanvasElement;
  scale: number;
};

export class PageRenderer {
  private activeRenderStates = new Map<number, ActivePageRenderState>();
  private pendingAsyncResourceRerender: number | null = null;
  private layerTreeCache = new Map<number, PageLayerTree>();
  private retainedLayerTreePages = new Set<number>();
  private readonly layerTreeCacheLimit = DEFAULT_LAYER_TREE_CACHE_LIMIT;
  private canvas2dRenderer = new Canvas2DLayerRenderer('compat');
  private readonly handleAsyncResourceReady = () => {
    if (this.pendingAsyncResourceRerender !== null || this.activeRenderStates.size === 0) {
      return;
    }

    this.pendingAsyncResourceRerender = requestAnimationFrame(() => {
      this.pendingAsyncResourceRerender = null;
      for (const [pageIdx, state] of this.activeRenderStates) {
        if (!state.canvas.parentElement) {
          this.activeRenderStates.delete(pageIdx);
          continue;
        }
        try {
          const appliedScale = this.renderContent(pageIdx, state.pageInfo, state.canvas, state.scale);
          this.drawMarginGuides(state.pageInfo, state.canvas, appliedScale);
        } catch (error) {
          console.error(`[PageRenderer] 비동기 리소스 재렌더링 실패 (page=${pageIdx}):`, error);
        }
      }
    });
  };

  constructor(
    private wasm: WasmBridge,
    private backend: RenderBackend,
    private renderProfile: LayerRenderProfile,
    private canvaskitRenderer: CanvasKitLayerRenderer | null,
  ) {
    this.canvas2dRenderer.setAsyncResourceReadyCallback(this.handleAsyncResourceReady);
    this.canvaskitRenderer?.setAsyncResourceReadyCallback(this.handleAsyncResourceReady);
  }

  /** 페이지를 Canvas에 렌더링한다 (scale = zoom × DPR) */
  renderPage(pageIdx: number, pageInfo: PageInfo, canvas: HTMLCanvasElement, scale: number): void {
    this.activeRenderStates.set(pageIdx, { pageInfo, canvas, scale });
    try {
      const appliedScale = this.renderContent(pageIdx, pageInfo, canvas, scale);
      this.drawMarginGuides(pageInfo, canvas, appliedScale);
    } catch (error) {
      this.activeRenderStates.delete(pageIdx);
      throw error;
    }
  }

  getBackend(): RenderBackend {
    return this.backend;
  }

  private renderContent(
    pageIdx: number,
    pageInfo: PageInfo,
    canvas: HTMLCanvasElement,
    scale: number,
  ): number {
    const appliedScale = clampRenderScale(pageInfo, scale);

    const canvasWidth = Math.max(1, Math.floor(pageInfo.width * appliedScale));
    const canvasHeight = Math.max(1, Math.floor(pageInfo.height * appliedScale));
    if (canvas.width !== canvasWidth) {
      canvas.width = canvasWidth;
    }
    if (canvas.height !== canvasHeight) {
      canvas.height = canvasHeight;
    }
    const layerTree = this.getLayerTree(pageIdx);

    if (this.backend === 'canvaskit') {
      if (!this.canvaskitRenderer) {
        throw new Error('CanvasKit renderer가 초기화되지 않았습니다');
      }
      this.canvaskitRenderer.renderPageWithMarginGuides(
        layerTree,
        canvas,
        appliedScale,
        pageInfo,
      );
      return appliedScale;
    }

    this.canvas2dRenderer.renderPage(layerTree, canvas, appliedScale);
    return appliedScale;
  }

  private getLayerTree(pageIdx: number): PageLayerTree {
    const cached = this.layerTreeCache.get(pageIdx);
    if (cached) {
      this.layerTreeCache.delete(pageIdx);
      this.layerTreeCache.set(pageIdx, cached);
      return cached;
    }

    const layerTree = this.wasm.getPageLayerTree(pageIdx, this.renderProfile);
    this.layerTreeCache.set(pageIdx, layerTree);
    this.evictLayerTreeCache(
      this.retainedLayerTreePages,
      Math.max(this.layerTreeCacheLimit, this.retainedLayerTreePages.size),
    );
    return layerTree;
  }

  retainLayerTreeCache(pageIndexes: Iterable<number>): void {
    this.retainedLayerTreePages = new Set(pageIndexes);
    this.evictLayerTreeCache(
      this.retainedLayerTreePages,
      Math.max(this.layerTreeCacheLimit, this.retainedLayerTreePages.size),
    );
  }

  private evictLayerTreeCache(retainedPages: Set<number>, maxEntries: number): void {
    if (this.layerTreeCache.size <= maxEntries) {
      return;
    }

    for (const [pageIdx, layerTree] of this.layerTreeCache) {
      if (this.layerTreeCache.size <= maxEntries) {
        return;
      }
      if (retainedPages.has(pageIdx)) {
        continue;
      }
      this.layerTreeCache.delete(pageIdx);
      this.canvaskitRenderer?.releaseLayerTree(layerTree);
    }
  }

  /** 편집 용지 여백 가이드라인을 캔버스에 그린다 (4모서리 L자 표시) */
  private drawMarginGuides(pageInfo: PageInfo, canvas: HTMLCanvasElement, scale: number): void {
    if (this.backend === 'canvaskit') {
      return;
    }

    this.drawCanvas2DMarginGuides(pageInfo, canvas, scale);
  }

  private drawCanvas2DMarginGuides(pageInfo: PageInfo, canvas: HTMLCanvasElement, scale: number): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { width, height, marginLeft, marginRight, marginTop, marginBottom, marginHeader, marginFooter } = pageInfo;
    const left = marginLeft;
    // 한컴 HWP 기준: 본문 시작 = marginHeader + marginTop
    const top = marginHeader + marginTop;
    const right = width - marginRight;
    // 한컴 HWP 기준: 본문 끝 = height - marginFooter - marginBottom
    const bottom = height - marginFooter - marginBottom;
    const L = 15;

    ctx.save();
    // WASM 렌더링 후 ctx transform 상태가 불확실하므로 명시적으로 설정
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.strokeStyle = '#C0C0C0';
    ctx.lineWidth = 0.3;
    ctx.beginPath();

    // 좌상 코너
    ctx.moveTo(left, top - L);
    ctx.lineTo(left, top);
    ctx.lineTo(left - L, top);

    // 우상 코너
    ctx.moveTo(right + L, top);
    ctx.lineTo(right, top);
    ctx.lineTo(right, top - L);

    // 좌하 코너
    ctx.moveTo(left - L, bottom);
    ctx.lineTo(left, bottom);
    ctx.lineTo(left, bottom + L);

    // 우하 코너
    ctx.moveTo(right, bottom + L);
    ctx.lineTo(right, bottom);
    ctx.lineTo(right + L, bottom);

    ctx.stroke();
    ctx.restore();
  }

  /** 특정 페이지의 비동기 재렌더링 상태를 취소한다 */
  cancelReRender(pageIdx: number): void {
    this.activeRenderStates.delete(pageIdx);
    if (this.activeRenderStates.size === 0 && this.pendingAsyncResourceRerender !== null) {
      cancelAnimationFrame(this.pendingAsyncResourceRerender);
      this.pendingAsyncResourceRerender = null;
    }
  }

  /** 모든 비동기 재렌더링 상태를 취소한다 */
  cancelAll(): void {
    this.activeRenderStates.clear();
    if (this.pendingAsyncResourceRerender !== null) {
      cancelAnimationFrame(this.pendingAsyncResourceRerender);
      this.pendingAsyncResourceRerender = null;
    }
  }

  clearLayerTreeCache(): void {
    for (const layerTree of this.layerTreeCache.values()) {
      this.canvaskitRenderer?.releaseLayerTree(layerTree);
    }
    this.layerTreeCache.clear();
    this.retainedLayerTreePages.clear();
  }

  resetDocumentResources(): void {
    this.canvas2dRenderer.resetDocumentResources();
    this.canvaskitRenderer?.resetDocumentResources();
  }

  dispose(): void {
    this.cancelAll();
    this.clearLayerTreeCache();
    this.canvas2dRenderer.setAsyncResourceReadyCallback(null);
    this.canvaskitRenderer?.setAsyncResourceReadyCallback(null);
    this.canvas2dRenderer.dispose();
    this.canvaskitRenderer?.dispose();
    this.canvaskitRenderer = null;
  }
}
