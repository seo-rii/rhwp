import type { SkPicture } from 'canvaskit-wasm';

import { resolveLayerResourceIndex } from '@/core/layer-resource-store';
import { layerTextVariantOpsForLeaf } from '@/core/text-variants';
import type {
  LayerFontBlobResource,
  LayerFontResources,
  LayerGlyphRunOp,
  LayerGroupNode,
  LayerNode,
  LayerPaintOp,
  LayerRenderProfile,
  LayerResources,
  PageLayerTree,
} from '@/core/types';
import {
  type CanvasKitReplayPlane,
  layerPaintOpReplayPlane,
} from './replay-plane';

export class CanvasKitStaticPictureCache<Metadata = never> {
  private readonly pictures = new Map<string, SkPicture>();
  private readonly metadata = new Map<string, Metadata>();
  private readonly layerTreeIds = new WeakMap<PageLayerTree, number>();
  private readonly nodeIds = new WeakMap<LayerGroupNode, number>();
  private readonly resourcePayloadFingerprints = new WeakMap<object, string>();
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
      stableValueFingerprint(tree.outputOptions ?? null),
    ].join(':');
  }

  keyForStaticSubtree(
    layerTreeCacheKey: string,
    profile: LayerRenderProfile,
    replayPlane: CanvasKitReplayPlane,
    node: LayerGroupNode,
    tree: PageLayerTree,
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
      replayPlane,
      `node:${nodeId}`,
      node.sourceNodeId ?? 'anon',
      node.bounds.x.toFixed(3),
      node.bounds.y.toFixed(3),
      node.bounds.width.toFixed(3),
      node.bounds.height.toFixed(3),
      node.children.length,
      stableValueFingerprint(node),
      staticSubtreeReplayDependencies(
        tree,
        node,
        replayPlane,
        this.resourcePayloadFingerprints,
      ),
    ].join(':');
  }

  get(cacheKey: string): SkPicture | null {
    return this.pictures.get(cacheKey) ?? null;
  }

  getMetadata(cacheKey: string): Metadata | null {
    return this.metadata.get(cacheKey) ?? null;
  }

  set(cacheKey: string, picture: SkPicture, metadata?: Metadata): void {
    this.pictures.set(cacheKey, picture);
    if (metadata !== undefined) {
      this.metadata.set(cacheKey, metadata);
    } else {
      this.metadata.delete(cacheKey);
    }
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
      this.metadata.delete(key);
    }
    this.layerTreeIds.delete(tree);
    return true;
  }

  clear(): void {
    for (const picture of this.pictures.values()) {
      picture.delete();
    }
    this.pictures.clear();
    this.metadata.clear();
  }
}

function staticSubtreeReplayDependencies(
  tree: PageLayerTree,
  node: LayerGroupNode,
  replayPlane: CanvasKitReplayPlane,
  payloadFingerprints: WeakMap<object, string>,
): string {
  const dependencies: unknown[] = [];

  const visitNode = (candidate: LayerNode): void => {
    switch (candidate.kind) {
      case 'group':
        for (const child of candidate.children) {
          visitNode(child);
        }
        return;
      case 'clipRect':
        visitNode(candidate.child);
        return;
      case 'leaf':
        for (const op of layerTextVariantOpsForLeaf(candidate.ops, tree.variantOps)) {
          if (layerPaintOpReplayPlane(op) !== replayPlane) {
            continue;
          }
          dependencies.push({
            op: stableValueFingerprint(op),
            resources: paintOpResourceReferences(
              op,
              tree.resources,
              tree.fontResources,
              payloadFingerprints,
            ),
          });
        }
        return;
    }
  };

  visitNode(node);
  return stableValueFingerprint(dependencies);
}

function paintOpResourceReferences(
  op: LayerPaintOp,
  resources: LayerResources | undefined,
  fontResources: LayerFontResources | undefined,
  payloadFingerprints: WeakMap<object, string>,
): unknown[] {
  const references: unknown[] = [];
  switch (op.type) {
    case 'pageBackground':
      if (op.image?.resourceId !== undefined) {
        references.push(imageResourceReference(op.image.resourceId, resources, payloadFingerprints));
      }
      break;
    case 'image':
      if (op.resourceId !== undefined) {
        references.push(imageResourceReference(op.resourceId, resources, payloadFingerprints));
      }
      break;
    case 'equation':
      if (op.svgResourceId !== undefined) {
        references.push(svgResourceReference(op.svgResourceId, resources, payloadFingerprints));
      }
      break;
    case 'glyphOutline':
      if (op.payloadKind === 'bitmapGlyph' && op.bitmapGlyph) {
        references.push(
          imageResourceReference(
            op.bitmapGlyph.imageResourceId,
            resources,
            payloadFingerprints,
          ),
        );
      }
      if (op.payloadKind === 'svgGlyph' && op.svgGlyph) {
        references.push(
          svgResourceReference(
            op.svgGlyph.vectorResourceId,
            resources,
            payloadFingerprints,
          ),
        );
      }
      break;
    case 'glyphRun':
      references.push(fontResourceReference(op, fontResources, resources, payloadFingerprints));
      break;
  }
  return references;
}

function imageResourceReference(
  resourceId: string | number,
  resources: LayerResources | undefined,
  payloadFingerprints: WeakMap<object, string>,
): unknown {
  return resourceReference(
    'image',
    resourceId,
    resources?.images ?? [],
    resources?.imageHashes,
    resources?.imageKeys,
    resources?.tableId,
    payloadFingerprints,
  );
}

function svgResourceReference(
  resourceId: string | number,
  resources: LayerResources | undefined,
  payloadFingerprints: WeakMap<object, string>,
): unknown {
  return resourceReference(
    'svg',
    resourceId,
    resources?.svgFragments ?? [],
    resources?.svgHashes,
    resources?.svgKeys,
    resources?.tableId,
    payloadFingerprints,
  );
}

function resourceReference(
  kind: 'image' | 'svg',
  resourceId: string | number,
  payloads: readonly unknown[],
  hashes: readonly string[] | undefined,
  keys: readonly string[] | undefined,
  tableId: number | undefined,
  payloadFingerprints: WeakMap<object, string>,
): unknown {
  const index = resolveLayerResourceIndex(resourceId, keys, payloads.length);
  return {
    kind,
    resourceId,
    tableId: tableId ?? null,
    resolvedIndex: index ?? null,
    payload: index === undefined
      ? null
      : resourcePayloadReferenceAt(payloads, hashes, keys, index, payloadFingerprints),
  };
}

function fontResourceReference(
  op: LayerGlyphRunOp,
  fontResources: LayerFontResources | undefined,
  resources: LayerResources | undefined,
  payloadFingerprints: WeakMap<object, string>,
): unknown {
  const faceKey = op.shapeKey.fontInstance.faceKey;
  const face = fontResources?.faces.find((candidate) => candidate.id === faceKey);
  const blob = face
    ? fontResources?.blobs.find((candidate) => candidate.id === face.blobKey)
    : undefined;
  const dataIndex = blob
    ? resolveFontBlobDataIndex(blob, resources)
    : undefined;

  return {
    kind: 'font',
    faceKey,
    face: face ?? null,
    blob: blob ?? null,
    tableId: resources?.tableId ?? null,
    dataIndex: dataIndex ?? null,
    payload: dataIndex === undefined
      ? null
      : resourcePayloadReferenceAt(
          resources?.fontBlobs ?? [],
          resources?.fontBlobHashes,
          resources?.fontBlobKeys,
          dataIndex,
          payloadFingerprints,
        ),
  };
}

function resolveFontBlobDataIndex(
  blob: LayerFontBlobResource,
  resources: LayerResources | undefined,
): number | undefined {
  if (blob.dataRef?.kind !== 'fontBlob' || !resources?.fontBlobs) {
    return undefined;
  }
  const numericRef = /^(0|[1-9]\d*)$/.test(blob.dataRef.id)
    ? Number.parseInt(blob.dataRef.id, 10)
    : undefined;
  if (numericRef !== undefined && numericRef < resources.fontBlobs.length) {
    return numericRef;
  }
  const keyIndex = resources.fontBlobKeys?.indexOf(blob.dataRef.id) ?? -1;
  if (keyIndex >= 0 && keyIndex < resources.fontBlobs.length) {
    return keyIndex;
  }
  const digestIndex = blob.digest
    ? resources.fontBlobHashes?.indexOf(blob.digest.value) ?? -1
    : -1;
  return digestIndex >= 0 && digestIndex < resources.fontBlobs.length
    ? digestIndex
    : undefined;
}

function resourcePayloadReferenceAt(
  payloads: readonly unknown[],
  hashes: readonly string[] | undefined,
  keys: readonly string[] | undefined,
  index: number,
  payloadFingerprints: WeakMap<object, string>,
): unknown {
  const payload = payloads[index];
  let payloadFingerprint: string;
  if (typeof payload === 'object' && payload !== null) {
    payloadFingerprint = payloadFingerprints.get(payload) ?? stableValueFingerprint(payload);
    payloadFingerprints.set(payload, payloadFingerprint);
  } else {
    payloadFingerprint = stableValueFingerprint(payload ?? null);
  }
  return {
    key: keys?.[index] ?? null,
    producerHash: hashes?.[index] ?? null,
    payloadFingerprint,
  };
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
