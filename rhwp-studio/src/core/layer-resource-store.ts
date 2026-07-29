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
  if (index < 0 || index >= resourceCount) {
    return undefined;
  }
  return resourceKeys.indexOf(resourceId, index + 1) < 0 ? index : undefined;
}

export class LayerResourceStore {
  resources: LayerResources;

  private tableId = 0;
  private imageLookup = new Map<string, number[]>();
  private svgLookup = new Map<string, number[]>();
  private fontBlobLookup = new Map<string, number[]>();
  private cachedKnownImageKeys: string[] | null = null;
  private cachedKnownSvgKeys: string[] | null = null;
  private importedImagePayloads = 0;
  private importedImagePayloadBytes = 0;
  private retainedImagePayloadBytes = 0;
  private omittedImagePayloads = 0;
  private importedSvgPayloads = 0;
  private importedSvgPayloadBytes = 0;
  private retainedSvgPayloadBytes = 0;
  private omittedSvgPayloads = 0;
  private importedFontBlobPayloads = 0;
  private importedFontBlobPayloadBytes = 0;
  private retainedFontBlobPayloadBytes = 0;
  private omittedFontBlobPayloads = 0;

  constructor() {
    this.resources = this.createResources();
  }

  clear(): void {
    this.tableId += 1;
    this.resources = this.createResources();
    this.imageLookup.clear();
    this.svgLookup.clear();
    this.fontBlobLookup.clear();
    this.cachedKnownImageKeys = null;
    this.cachedKnownSvgKeys = null;
    this.importedImagePayloads = 0;
    this.importedImagePayloadBytes = 0;
    this.retainedImagePayloadBytes = 0;
    this.omittedImagePayloads = 0;
    this.importedSvgPayloads = 0;
    this.importedSvgPayloadBytes = 0;
    this.retainedSvgPayloadBytes = 0;
    this.omittedSvgPayloads = 0;
    this.importedFontBlobPayloads = 0;
    this.importedFontBlobPayloadBytes = 0;
    this.retainedFontBlobPayloadBytes = 0;
    this.omittedFontBlobPayloads = 0;
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
    this.retainedImagePayloadBytes += bytes.byteLength;
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
    this.retainedSvgPayloadBytes += byteLength;
    if (candidates) {
      candidates.push(id);
    } else {
      this.svgLookup.set(key, [id]);
    }
    this.cachedKnownSvgKeys = null;
    return id;
  }

  internFontBlob(bytes: Uint8Array, contentHash?: string, resourceKey?: string): number {
    this.importedFontBlobPayloads += 1;
    this.importedFontBlobPayloadBytes += bytes.byteLength;
    const resourceHash = contentHash ?? this.hashBytes(bytes);
    const key = resourceKey
      ?? this.makeResourceKey('font', contentHash ? 'blake3' : 'fnv1a32', bytes.byteLength, resourceHash);
    const candidates = this.fontBlobLookup.get(key);
    if (candidates) {
      for (const candidate of candidates) {
        const candidateBytes = this.resources.fontBlobs?.[candidate];
        if (candidateBytes instanceof Uint8Array && this.bytesEqual(candidateBytes, bytes)) {
          return candidate;
        }
      }
    }

    const id = this.resources.fontBlobs?.length ?? 0;
    this.resources.fontBlobs?.push(bytes);
    this.resources.fontBlobHashes?.push(resourceHash);
    this.resources.fontBlobKeys?.push(key);
    this.retainedFontBlobPayloadBytes += bytes.byteLength;
    if (candidates) {
      candidates.push(id);
    } else {
      this.fontBlobLookup.set(key, [id]);
    }
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

  findFontBlobByKey(resourceKey: string | undefined): number | undefined {
    if (!resourceKey) return undefined;
    const candidates = this.fontBlobLookup.get(resourceKey);
    if (!candidates || candidates.length !== 1) return undefined;
    this.omittedFontBlobPayloads += 1;
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

  exceedsRetentionLimits(maxPayloadCount: number, maxPayloadBytes: number): boolean {
    return this.retainedPayloadCount() > maxPayloadCount
      || this.retainedPayloadBytes() > maxPayloadBytes;
  }

  stats() {
    return {
      tableId: this.resources.tableId,
      imageCount: this.resources.images.length,
      imagePayloadsImported: this.importedImagePayloads,
      imagePayloadBytesImported: this.importedImagePayloadBytes,
      imagePayloadBytesRetained: this.retainedImagePayloadBytes,
      imagePayloadsOmitted: this.omittedImagePayloads,
      svgCount: this.resources.svgFragments.length,
      svgPayloadsImported: this.importedSvgPayloads,
      svgPayloadBytesImported: this.importedSvgPayloadBytes,
      svgPayloadBytesRetained: this.retainedSvgPayloadBytes,
      svgPayloadsOmitted: this.omittedSvgPayloads,
      fontBlobCount: this.resources.fontBlobs?.length ?? 0,
      fontBlobPayloadsImported: this.importedFontBlobPayloads,
      fontBlobPayloadBytesImported: this.importedFontBlobPayloadBytes,
      fontBlobPayloadBytesRetained: this.retainedFontBlobPayloadBytes,
      fontBlobPayloadsOmitted: this.omittedFontBlobPayloads,
      retainedPayloadCount: this.retainedPayloadCount(),
      retainedPayloadBytes: this.retainedPayloadBytes(),
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
      fontBlobs: [],
      fontBlobHashes: [],
      fontBlobKeys: [],
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
    kind: 'img' | 'svg' | 'font',
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

  private retainedPayloadCount(): number {
    return this.resources.images.length
      + this.resources.svgFragments.length
      + (this.resources.fontBlobs?.length ?? 0);
  }

  private retainedPayloadBytes(): number {
    return this.retainedImagePayloadBytes
      + this.retainedSvgPayloadBytes
      + this.retainedFontBlobPayloadBytes;
  }

  private uniqueKeys(lookup: Map<string, number[]>): string[] {
    return Array.from(lookup.entries())
      .filter(([, candidates]) => candidates.length === 1)
      .map(([key]) => key);
  }
}
