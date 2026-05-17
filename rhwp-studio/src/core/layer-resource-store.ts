import type { LayerResources } from './types';

export function resolveLayerResourceIndex(
  resourceId: string | number | undefined,
  resourceKeys: readonly string[] | undefined,
  resourceCount: number,
): number | undefined {
  if (typeof resourceId === 'number') {
    return Number.isInteger(resourceId) && resourceId >= 0 && resourceId < resourceCount
      ? resourceId
      : undefined;
  }
  if (typeof resourceId !== 'string' || resourceId.length === 0 || !resourceKeys) {
    return undefined;
  }
  const index = resourceKeys.indexOf(resourceId);
  return index >= 0 && index < resourceCount ? index : undefined;
}

export class LayerResourceStore {
  resources: LayerResources;

  private tableId = 0;
  private imageLookup = new Map<string, number[]>();
  private svgLookup = new Map<string, number[]>();
  private cachedKnownImageKeys: string[] | null = null;
  private cachedKnownSvgKeys: string[] | null = null;
  private importedImagePayloads = 0;
  private importedImagePayloadBytes = 0;
  private omittedImagePayloads = 0;
  private importedSvgPayloads = 0;
  private importedSvgPayloadBytes = 0;
  private omittedSvgPayloads = 0;

  constructor() {
    this.resources = this.createResources();
  }

  clear(): void {
    this.tableId += 1;
    this.resources = this.createResources();
    this.imageLookup.clear();
    this.svgLookup.clear();
    this.cachedKnownImageKeys = null;
    this.cachedKnownSvgKeys = null;
    this.importedImagePayloads = 0;
    this.importedImagePayloadBytes = 0;
    this.omittedImagePayloads = 0;
    this.importedSvgPayloads = 0;
    this.importedSvgPayloadBytes = 0;
    this.omittedSvgPayloads = 0;
  }

  internImage(bytes: Uint8Array, contentHash?: string, resourceKey?: string): number {
    this.importedImagePayloads += 1;
    this.importedImagePayloadBytes += bytes.byteLength;
    const resourceHash = contentHash ?? this.hashBytes(bytes);
    const key = resourceKey
      ?? this.makeResourceKey('img', contentHash ? 'blake3' : 'fnv1a32', bytes.byteLength, resourceHash);
    const candidates = this.imageLookup.get(key);
    if (candidates) {
      for (const candidate of candidates) {
        const candidateBytes = this.resources.images[candidate];
        if (candidateBytes && this.bytesEqual(candidateBytes, bytes)) {
          return candidate;
        }
      }
    }

    const id = this.resources.images.length;
    this.resources.images.push(bytes);
    this.resources.imageHashes?.push(resourceHash);
    this.resources.imageKeys?.push(key);
    if (candidates) {
      candidates.push(id);
    } else {
      this.imageLookup.set(key, [id]);
    }
    this.cachedKnownImageKeys = null;
    return id;
  }

  internSvg(fragment: string, contentHash?: string, resourceKey?: string): number {
    const encoded = new TextEncoder().encode(fragment);
    const byteLength = encoded.byteLength;
    this.importedSvgPayloads += 1;
    this.importedSvgPayloadBytes += byteLength;
    const resourceHash = contentHash ?? this.hashBytes(encoded);
    const key = resourceKey
      ?? this.makeResourceKey('svg', contentHash ? 'blake3' : 'fnv1a32', byteLength, resourceHash);
    const candidates = this.svgLookup.get(key);
    if (candidates) {
      for (const candidate of candidates) {
        if (this.resources.svgFragments[candidate] === fragment) {
          return candidate;
        }
      }
    }

    const id = this.resources.svgFragments.length;
    this.resources.svgFragments.push(fragment);
    this.resources.svgHashes?.push(resourceHash);
    this.resources.svgKeys?.push(key);
    if (candidates) {
      candidates.push(id);
    } else {
      this.svgLookup.set(key, [id]);
    }
    this.cachedKnownSvgKeys = null;
    return id;
  }

  findImageByKey(resourceKey: string | undefined): number | undefined {
    if (!resourceKey) return undefined;
    const candidates = this.imageLookup.get(resourceKey);
    if (!candidates || candidates.length !== 1) return undefined;
    this.omittedImagePayloads += 1;
    return candidates[0];
  }

  findSvgByKey(resourceKey: string | undefined): number | undefined {
    if (!resourceKey) return undefined;
    const candidates = this.svgLookup.get(resourceKey);
    if (!candidates || candidates.length !== 1) return undefined;
    this.omittedSvgPayloads += 1;
    return candidates[0];
  }

  knownImageKeys(): string[] {
    this.cachedKnownImageKeys ??= this.uniqueKeys(this.imageLookup);
    return this.cachedKnownImageKeys;
  }

  knownSvgKeys(): string[] {
    this.cachedKnownSvgKeys ??= this.uniqueKeys(this.svgLookup);
    return this.cachedKnownSvgKeys;
  }

  stats() {
    return {
      tableId: this.resources.tableId,
      imageCount: this.resources.images.length,
      imagePayloadsImported: this.importedImagePayloads,
      imagePayloadBytesImported: this.importedImagePayloadBytes,
      imagePayloadsOmitted: this.omittedImagePayloads,
      svgCount: this.resources.svgFragments.length,
      svgPayloadsImported: this.importedSvgPayloads,
      svgPayloadBytesImported: this.importedSvgPayloadBytes,
      svgPayloadsOmitted: this.omittedSvgPayloads,
      knownImageKeyCount: this.knownImageKeys().length,
      knownSvgKeyCount: this.knownSvgKeys().length,
    };
  }

  private createResources(): LayerResources {
    return {
      tableId: this.tableId,
      images: [],
      imageHashes: [],
      imageKeys: [],
      svgFragments: [],
      svgHashes: [],
      svgKeys: [],
    };
  }

  private hashBytes(bytes: Uint8Array): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < bytes.length; index += 1) {
      hash ^= bytes[index];
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16);
  }

  private makeResourceKey(
    kind: 'img' | 'svg',
    algorithm: 'blake3' | 'fnv1a32',
    byteLength: number,
    hash: string,
  ): string {
    return `${kind}:${algorithm}:${byteLength}:${hash}`;
  }

  private bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
    if (left.byteLength !== right.byteLength) return false;
    for (let index = 0; index < left.byteLength; index += 1) {
      if (left[index] !== right[index]) return false;
    }
    return true;
  }

  private uniqueKeys(lookup: Map<string, number[]>): string[] {
    return Array.from(lookup.entries())
      .filter(([, candidates]) => candidates.length === 1)
      .map(([key]) => key);
  }
}
