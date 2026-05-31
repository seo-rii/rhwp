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
    return [
      treeId,
      stableValueFingerprint(tree.resources ?? null),
      stableValueFingerprint(tree.fontResources ?? null),
      stableValueFingerprint(tree.variantOps ?? null),
    ].join(':');
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
      stableValueFingerprint(node),
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

function stableValueFingerprint(value: unknown): string {
  let hash = 0x811c9dc5;

  const appendByte = (byte: number): void => {
    hash ^= byte & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  };
  const appendString = (text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      appendByte(code & 0xff);
      appendByte((code >>> 8) & 0xff);
    }
  };
  const appendValue = (item: unknown): void => {
    if (item === null || item === undefined) {
      appendString(String(item));
      return;
    }
    if (typeof item === 'string') {
      appendString(`s:${item.length}:`);
      appendString(item);
      return;
    }
    if (typeof item === 'number' || typeof item === 'boolean') {
      appendString(`${typeof item}:${String(item)}`);
      return;
    }
    if (item instanceof ArrayBuffer) {
      const bytes = new Uint8Array(item);
      appendString(`buffer:${bytes.length}:`);
      for (const byte of bytes) {
        appendByte(byte);
      }
      return;
    }
    if (ArrayBuffer.isView(item)) {
      const view = item as ArrayBufferView;
      const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      appendString(`bytes:${bytes.length}:`);
      for (const byte of bytes) {
        appendByte(byte);
      }
      return;
    }
    if (Array.isArray(item)) {
      appendString(`array:${item.length}:`);
      for (const entry of item) {
        appendValue(entry);
        appendByte(0);
      }
      return;
    }
    if (typeof item === 'object') {
      const record = item as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      appendString(`object:${keys.length}:`);
      for (const key of keys) {
        appendString(key);
        appendByte(0);
        appendValue(record[key]);
        appendByte(0);
      }
      return;
    }
    appendString(typeof item);
  };

  appendValue(value);
  return hash.toString(16).padStart(8, '0');
}
