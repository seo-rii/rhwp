import type { SkPicture } from 'canvaskit-wasm';

import type { LayerGroupNode, LayerRenderProfile, PageLayerTree } from '@/core/types';

export class CanvasKitStaticPictureCache {
  private readonly pictures = new Map<string, SkPicture>();
  private readonly layerTreeIds = new WeakMap<PageLayerTree, number>();
  private readonly nodeIds = new WeakMap<LayerGroupNode, number>();
  private nextLayerTreeId = 1;
  private nextNodeId = 1;

  get size(): number {
    return this.pictures.size;
  }

  keys(): IterableIterator<string> {
    return this.pictures.keys();
  }

  cacheKeyForLayerTree(tree: PageLayerTree): string {
    let treeId = this.layerTreeIds.get(tree);
    if (treeId === undefined) {
      treeId = this.nextLayerTreeId;
      this.nextLayerTreeId += 1;
      this.layerTreeIds.set(tree, treeId);
    }
    return String(treeId);
  }

  keyForStaticSubtree(
    layerTreeCacheKey: string,
    profile: LayerRenderProfile,
    node: LayerGroupNode,
  ): string {
    let nodeId = this.nodeIds.get(node);
    if (nodeId === undefined) {
      nodeId = this.nextNodeId;
      this.nextNodeId += 1;
      this.nodeIds.set(node, nodeId);
    }
    return [
      layerTreeCacheKey,
      profile,
      `node:${nodeId}`,
      node.sourceNodeId ?? 'anon',
      node.bounds.x.toFixed(3),
      node.bounds.y.toFixed(3),
      node.bounds.width.toFixed(3),
      node.bounds.height.toFixed(3),
      node.children.length,
    ].join(':');
  }

  get(cacheKey: string): SkPicture | null {
    return this.pictures.get(cacheKey) ?? null;
  }

  set(cacheKey: string, picture: SkPicture): void {
    this.pictures.set(cacheKey, picture);
  }

  releaseLayerTree(tree: PageLayerTree): boolean {
    const treeId = this.layerTreeIds.get(tree);
    if (treeId === undefined) {
      return false;
    }

    const cachePrefix = `${treeId}:`;
    for (const [key, picture] of this.pictures) {
      if (!key.startsWith(cachePrefix)) {
        continue;
      }
      picture.delete();
      this.pictures.delete(key);
    }
    this.layerTreeIds.delete(tree);
    return true;
  }

  clear(): void {
    for (const picture of this.pictures.values()) {
      picture.delete();
    }
    this.pictures.clear();
  }
}
