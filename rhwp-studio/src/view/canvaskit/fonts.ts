import type { CanvasKit, Font, Typeface, TypefaceFontProvider } from 'canvaskit-wasm';

import { FONT_LIST, OLD_HANGUL_FONT_FAMILY } from '@/core/font-loader';
import {
  getLocalFontRecords,
  loadLocalFontBytesFor,
  localFontFaceKey,
  type LocalFontRecord,
} from '@/core/local-fonts';
import {
  baseFamilyWithoutWeightSuffix,
  canvasFontFamilyFallbackCandidates,
  resolveFont,
  resolveRenderFontWeight,
  type RenderFontWeight,
} from '@/core/font-substitution';
import type {
  LayerFontBlobResource,
  LayerFontFaceResource,
  LayerFontResources,
  LayerResources,
  LayerGlyphRunOp,
} from '@/core/types';
import { decodeBase64 } from '@/core/base64';
import { canvasKitFontFaceData } from './sfnt-face';

const FONT_SANS_REGULAR_URL = new URL('../../../../web/fonts/NotoSansKR-Regular.woff2', import.meta.url).href;
const FONT_SANS_BOLD_URL = new URL('../../../../web/fonts/NotoSansKR-Bold.woff2', import.meta.url).href;
const FONT_SANS_EXTRALIGHT_URL = new URL('../../../../web/fonts/NotoSansKR-ExtraLight.woff2', import.meta.url).href;
const FONT_SERIF_REGULAR_URL = new URL('../../../../web/fonts/NotoSerifKR-Regular.woff2', import.meta.url).href;
const FONT_SERIF_BOLD_URL = new URL('../../../../web/fonts/NotoSerifKR-Bold.woff2', import.meta.url).href;
const FONT_MONO_REGULAR_URL = new URL('../../../../web/fonts/D2Coding-Regular.woff2', import.meta.url).href;
const FONT_MATH_REGULAR_URL = new URL('../../../../web/fonts/LatinModernMath-Regular.woff2', import.meta.url).href;
const FONT_OLD_HANGUL_URL = new URL('../../../../web/fonts/SourceHanSerifK-OldHangul-subset.woff2', import.meta.url).href;
const FONT_HAMCHOROM_DOTUM_URL = new URL('../../../../web/fonts/NotoSansKR-Regular.woff2', import.meta.url).href;
const FONT_HAMCHOROM_DOTUM_BOLD_URL = new URL('../../../../web/fonts/NotoSansKR-Bold.woff2', import.meta.url).href;
const FONT_HAMCHOROM_BATANG_URL = new URL('../../../../web/fonts/NotoSerifKR-Regular.woff2', import.meta.url).href;
const FONT_HAMCHOROM_BATANG_BOLD_URL = new URL('../../../../web/fonts/NotoSerifKR-Bold.woff2', import.meta.url).href;
const BUNDLED_FONT_URLS = new Map<string, string>([
  ['fonts/NotoSansKR-Regular.woff2', FONT_SANS_REGULAR_URL],
  ['fonts/NotoSansKR-Bold.woff2', FONT_SANS_BOLD_URL],
  ['fonts/NotoSansKR-ExtraLight.woff2', FONT_SANS_EXTRALIGHT_URL],
  ['fonts/NotoSerifKR-Regular.woff2', FONT_SERIF_REGULAR_URL],
  ['fonts/NotoSerifKR-Bold.woff2', FONT_SERIF_BOLD_URL],
  ['fonts/D2Coding-Regular.woff2', FONT_MONO_REGULAR_URL],
  ['fonts/LatinModernMath-Regular.woff2', FONT_MATH_REGULAR_URL],
  ['fonts/SourceHanSerifK-OldHangul-subset.woff2', FONT_OLD_HANGUL_URL],
]);

const HAMCHOROM_DOTUM_FAMILY = 'HCR Dotum';
export const HAMCHOROM_BATANG_FAMILY = 'HCR Batang';
const HAMCHOROM_DOTUM_ALIASES = new Set([
  '함초롬돋움',
  '함초롱돋움',
  '한컴돋움',
  '새돋움',
  HAMCHOROM_DOTUM_FAMILY,
]);
const HAMCHOROM_BATANG_ALIASES = new Set([
  '함초롬바탕',
  '함초롱바탕',
  '한컴바탕',
  '새바탕',
  HAMCHOROM_BATANG_FAMILY,
]);
const MEASURED_HFT_LAYER_FAMILIES = new Set([
  '한양신명조',
  '한양중고딕',
  '한양견명조',
  '한양견고딕',
  '휴먼명조',
]);
const MAX_STRICT_GLYPHS_PER_RUN = 4096;
const MAX_STRICT_GLYPH_FONT_SIZE_PX = 4096;
const MAX_FLOAT32 = 3.4028234663852886e38;

const SANS_ALIASES = [
  'Noto Sans KR',
  'Noto Sans KR ExtraLight',
  'Noto Sans CJK KR',
  'NanumGothic',
  '나눔고딕',
  '맑은 고딕',
  'Malgun Gothic',
  'Apple SD Gothic Neo',
  'Pretendard',
  '돋움',
  '돋움체',
  'Haansoft Dotum',
  '굴림',
  '새굴림',
  'HY중고딕',
  'HY그래픽',
  'HY그래픽M',
  'HYHeadLine M',
  'HYHeadLine Medium',
  'HY헤드라인M',
  '한양중고딕',
  '한양견고딕',
  'SpoqaHanSans',
];

const SERIF_ALIASES = [
  'Noto Serif KR',
  'Noto Serif CJK KR',
  'NanumMyeongjo',
  '나눔명조',
  '바탕',
  '바탕체',
  'AppleMyungjo',
  '궁서',
  '새궁서',
  'HY신명조',
  'HY견명조',
  '한양신명조',
  '한양견명조',
  '휴먼명조',
  'Palatino Linotype',
  'Batang',
];

const MONO_ALIASES = [
  'D2Coding',
  'NanumGothicCoding',
  '나눔고딕코딩',
  '굴림체',
  'GulimChe',
  'Noto Sans Mono',
];

const MATH_ALIASES = [
  'Latin Modern Math',
  'STIX Two Math',
  'Cambria Math',
];
const OLD_HANGUL_ALIASES = [OLD_HANGUL_FONT_FAMILY];

export type CanvasKitFontResolutionSource =
  | 'requestedAlias'
  | 'substitutionAlias'
  | 'weightSuffixAlias'
  | 'fallbackCandidate'
  | 'defaultFallback';

export interface CanvasKitFontResolution {
  requestedFamily: string;
  resolvedFamily: string;
  source: CanvasKitFontResolutionSource;
}

export interface CanvasKitGlyphRunReplayReport {
  replayEligibility: LayerGlyphRunOp['diagnostics']['replayEligibility'];
  quality: LayerGlyphRunOp['diagnostics']['quality'];
  strictVisualEligible: boolean;
  digestMatched?: boolean;
  exactFaceInstantiated?: boolean;
  faceIndexSupported?: boolean;
  variationSupported?: boolean;
  effectSupported?: boolean;
  reason?: string;
}

export type CanvasKitGlyphRunReplayStatus =
  | {
    replayable: true;
    face: LayerFontFaceResource;
    blob: LayerFontBlobResource;
    report: CanvasKitGlyphRunReplayReport;
  }
  | {
    replayable: false;
    reason: string;
    report: CanvasKitGlyphRunReplayReport;
  };

type CanvasKitProviderFaces = { regular?: string; bold?: string };
type CanvasKitLocalProviderFace = {
  providerFamily: string;
  weight: RenderFontWeight;
  italic: boolean;
};

type CanvasKitPreparedLocalProviderFace = {
  face: CanvasKitLocalProviderFace;
  recordSignature: string;
  bytesDigest: string | null;
};

export interface CanvasKitLocalFontPreparationOptions {
  /** 승인된 Local Font Access snapshot으로 현재 local face index를 교체한다. */
  refresh?: boolean;
}

export interface CanvasKitLocalFontPreparationResult {
  registered: number;
  removed: number;
  changed: boolean;
}

export type CanvasKitProviderFaceResolution = {
  providerFamily: string;
  physicalWeight: RenderFontWeight;
  physicalItalic: boolean;
  synthesizeBold: boolean;
  synthesizeItalic: boolean;
};

function localFontAliasKey(value: string): string {
  return value.normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');
}

function localFontRecordSignature(record: LocalFontRecord): string {
  return [
    record.family,
    record.fullName,
    record.postscriptName,
    record.style,
    ...record.aliases,
  ].map(localFontAliasKey).join('\u0000');
}

async function localFontBytesDigest(bytes: Uint8Array): Promise<string | null> {
  try {
    const digest = await globalThis.crypto?.subtle.digest('SHA-256', bytes.slice().buffer);
    if (!digest) return null;
    return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

export class CanvasKitFontRegistry {
  readonly aliases = new Set<string>();
  private readonly verifiedFontBlobs = new Map<string, ArrayBuffer>();
  private readonly glyphRunTypefaces = new Map<string, Typeface>();
  private readonly glyphRunFonts = new Map<string, Font>();
  private readonly familiesWithBoldFace = new Set<string>();
  private readonly providerFamilies = new Map<string, CanvasKitProviderFaces>();
  private readonly localProviderFamilies = new Map<string, CanvasKitLocalProviderFace[]>();
  private readonly localAliasFamilies = new Map<string, string>();
  private readonly localAliasProviderFaces = new Map<string, CanvasKitLocalProviderFace[]>();
  private readonly localAliases = new Set<string>();
  private readonly preparedLocalFaces = new Map<string, CanvasKitPreparedLocalProviderFace>();
  private localFontPreparationEpoch = 0;
  private nextProviderFamilyId = 0;

  constructor(
    private readonly canvasKit: CanvasKit,
    private readonly fontProvider: TypefaceFontProvider,
  ) {}

  async registerFonts(): Promise<void> {
    const fontFiles = new Map<string, Uint8Array>();

    const loadFontFile = async (url: string): Promise<Uint8Array> => {
      const cached = fontFiles.get(url);
      if (cached) return cached;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`CanvasKit font fetch failed: ${response.status} ${url}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      fontFiles.set(url, bytes);
      return bytes;
    };

    const registerAliases = async (aliases: string[], regularUrl: string, boldUrl?: string): Promise<void> => {
      if (aliases.length === 0) {
        return;
      }
      const regularBytes = await loadFontFile(regularUrl);
      const boldBytes = boldUrl ? await loadFontFile(boldUrl) : null;

      for (const alias of aliases) {
        this.registerProviderFace(alias, regularBytes, false);
        if (boldBytes) {
          this.registerProviderFace(alias, boldBytes, true);
        }
      }
    };

    const registerCatalogAliases = async (aliases: string[]): Promise<string[]> => {
      const requestedAliases = new Set(aliases);
      const registeredAliases = new Set<string>();
      for (const entry of FONT_LIST) {
        if (!requestedAliases.has(entry.name)) {
          continue;
        }
        const fontUrl = resolveCatalogFontUrl(entry.file);
        const bytes = await loadFontFile(fontUrl);
        const isBold = entry.weight === '700' || /(?:^|[-_])bold(?:[-_.]|$)/i.test(entry.file);
        this.registerProviderFace(entry.name, bytes, isBold);
        registeredAliases.add(entry.name);
      }
      return aliases.filter((alias) => !registeredAliases.has(alias));
    };

    const catalogAliases = new Set([
      ...SANS_ALIASES,
      ...SERIF_ALIASES,
      ...MONO_ALIASES,
      ...MATH_ALIASES,
      ...OLD_HANGUL_ALIASES,
    ]);
    const resolveCatalogFontUrl = (file: string): string => (
      BUNDLED_FONT_URLS.get(file) ?? new URL(file, document.baseURI).href
    );
    const catalogFontUrls = new Set(
      FONT_LIST
        .filter((entry) => catalogAliases.has(entry.name))
        .map((entry) => resolveCatalogFontUrl(entry.file)),
    );
    await Promise.all([...catalogFontUrls].map((url) => loadFontFile(url)));

    await registerAliases([HAMCHOROM_DOTUM_FAMILY], FONT_HAMCHOROM_DOTUM_URL, FONT_HAMCHOROM_DOTUM_BOLD_URL);
    await registerAliases([HAMCHOROM_BATANG_FAMILY], FONT_HAMCHOROM_BATANG_URL, FONT_HAMCHOROM_BATANG_BOLD_URL);
    const missingOldHangulAliases = await registerCatalogAliases(OLD_HANGUL_ALIASES);
    if (missingOldHangulAliases.length > 0) {
      throw new Error(`CanvasKit old-Hangul font aliases missing from catalog: ${missingOldHangulAliases.join(', ')}`);
    }
    await registerAliases(
      await registerCatalogAliases(SANS_ALIASES),
      FONT_SANS_REGULAR_URL,
      FONT_SANS_BOLD_URL,
    );
    await registerAliases(
      await registerCatalogAliases(SERIF_ALIASES),
      FONT_SERIF_REGULAR_URL,
      FONT_SERIF_BOLD_URL,
    );
    await registerAliases(
      await registerCatalogAliases(MONO_ALIASES),
      FONT_MONO_REGULAR_URL,
    );
    await registerAliases(
      await registerCatalogAliases(MATH_ALIASES),
      FONT_MATH_REGULAR_URL,
    );
  }

  /** 현재 문서가 요구하는 exact local face만 원본 SFNT bytes로 등록한다. */
  async prepareLocalFonts(
    fontNames: readonly string[],
    options: CanvasKitLocalFontPreparationOptions = {},
  ): Promise<CanvasKitLocalFontPreparationResult> {
    const epoch = ++this.localFontPreparationEpoch;
    const requestedAliases = new Set(fontNames.map(localFontAliasKey).filter(Boolean));
    if (requestedAliases.size === 0 && !options.refresh) {
      return { registered: 0, removed: 0, changed: false };
    }

    const records = getLocalFontRecords({ includeRegistered: true }).filter(record =>
      record.aliases.some(alias => requestedAliases.has(localFontAliasKey(alias))),
    );
    const pendingRecords = options.refresh
      ? records
      : records.filter(record => !this.preparedLocalFaces.has(localFontFaceKey(record)));
    if (pendingRecords.length === 0 && !options.refresh) {
      return { registered: 0, removed: 0, changed: false };
    }

    const bytesByFace = await loadLocalFontBytesFor(
      pendingRecords.map(record => record.postscriptName || record.fullName),
    );
    const preparedRecords = await Promise.all(pendingRecords.map(async record => {
      const buffer = bytesByFace.get(localFontFaceKey(record));
      const bytes = buffer ? new Uint8Array(buffer) : null;
      return {
        record,
        bytes,
        bytesDigest: bytes ? await localFontBytesDigest(bytes) : null,
      };
    }));
    if (epoch !== this.localFontPreparationEpoch) {
      return { registered: 0, removed: 0, changed: false };
    }

    if (options.refresh) {
      const previousFaces = new Map(this.preparedLocalFaces);
      const nextFaces = new Map<string, CanvasKitPreparedLocalProviderFace>();
      let registered = 0;
      let metadataChanged = false;
      for (const prepared of preparedRecords) {
        const faceKey = localFontFaceKey(prepared.record);
        const previous = previousFaces.get(faceKey);
        const recordSignature = localFontRecordSignature(prepared.record);
        let face: CanvasKitLocalProviderFace | null = null;
        if (previous && (!prepared.bytes || (
          prepared.bytesDigest !== null
          && prepared.bytesDigest === previous.bytesDigest
        ))) {
          face = this.localProviderFace(prepared.record, previous.face.providerFamily);
        } else if (prepared.bytes) {
          try {
            face = this.registerLocalProviderFace(prepared.record, prepared.bytes);
            registered += 1;
          } catch (error) {
            console.warn(`[CanvasKitFontRegistry] ${prepared.record.displayName} local face 갱신 실패:`, error);
          }
        }
        if (!face) continue;
        if (previous?.recordSignature !== recordSignature) metadataChanged = true;
        nextFaces.set(faceKey, {
          face,
          recordSignature,
          bytesDigest: prepared.bytesDigest ?? previous?.bytesDigest ?? null,
        });
      }

      const removed = Array.from(previousFaces.keys())
        .filter(faceKey => !nextFaces.has(faceKey)).length;
      this.clearLocalProviderIndexes();
      this.preparedLocalFaces.clear();
      for (const prepared of preparedRecords) {
        const faceKey = localFontFaceKey(prepared.record);
        const entry = nextFaces.get(faceKey);
        if (!entry) continue;
        this.preparedLocalFaces.set(faceKey, entry);
        this.indexLocalProviderFace(prepared.record, entry.face);
      }
      return {
        registered,
        removed,
        changed: registered > 0 || removed > 0 || metadataChanged,
      };
    }

    let registered = 0;
    for (const prepared of preparedRecords) {
      const faceKey = localFontFaceKey(prepared.record);
      if (!prepared.bytes) continue;
      try {
        const face = this.registerLocalProviderFace(prepared.record, prepared.bytes);
        this.preparedLocalFaces.set(faceKey, {
          face,
          recordSignature: localFontRecordSignature(prepared.record),
          bytesDigest: prepared.bytesDigest,
        });
        this.indexLocalProviderFace(prepared.record, face);
        registered += 1;
      } catch (error) {
        console.warn(`[CanvasKitFontRegistry] ${prepared.record.displayName} local face 등록 실패:`, error);
      }
    }
    return { registered, removed: 0, changed: registered > 0 };
  }

  resolveFamilyWithStatus(fontFamily: string): CanvasKitFontResolution {
    const localFamily = this.localAliasFamilies.get(localFontAliasKey(fontFamily));
    if (localFamily) {
      return {
        requestedFamily: fontFamily,
        resolvedFamily: localFamily,
        source: 'requestedAlias',
      };
    }
    // PageLayerTree families have already passed through the Rust style
    // resolver. Preserve measured HFT identities instead of feeding them
    // through the raw-document substitution table a second time.
    const resolved = MEASURED_HFT_LAYER_FAMILIES.has(fontFamily)
      ? fontFamily
      : resolveFont(fontFamily, 0, 0);
    if (HAMCHOROM_DOTUM_ALIASES.has(resolved) || HAMCHOROM_DOTUM_ALIASES.has(fontFamily)) {
      return {
        requestedFamily: fontFamily,
        resolvedFamily: HAMCHOROM_DOTUM_FAMILY,
        source: fontFamily === HAMCHOROM_DOTUM_FAMILY ? 'requestedAlias' : 'substitutionAlias',
      };
    }
    if (HAMCHOROM_BATANG_ALIASES.has(resolved) || HAMCHOROM_BATANG_ALIASES.has(fontFamily)) {
      return {
        requestedFamily: fontFamily,
        resolvedFamily: HAMCHOROM_BATANG_FAMILY,
        source: fontFamily === HAMCHOROM_BATANG_FAMILY ? 'requestedAlias' : 'substitutionAlias',
      };
    }
    if (this.aliases.has(resolved)) {
      return {
        requestedFamily: fontFamily,
        resolvedFamily: resolved,
        source: resolved === fontFamily ? 'requestedAlias' : 'substitutionAlias',
      };
    }
    if (this.aliases.has(fontFamily)) {
      return {
        requestedFamily: fontFamily,
        resolvedFamily: fontFamily,
        source: 'requestedAlias',
      };
    }

    for (const candidate of [resolved, fontFamily]) {
      const baseFamily = baseFamilyWithoutWeightSuffix(candidate);
      if (baseFamily && this.aliases.has(baseFamily)) {
        return {
          requestedFamily: fontFamily,
          resolvedFamily: baseFamily,
          source: 'weightSuffixAlias',
        };
      }
    }
    for (const candidate of canvasFontFamilyFallbackCandidates(resolved)) {
      if (this.aliases.has(candidate)) {
        return {
          requestedFamily: fontFamily,
          resolvedFamily: candidate,
          source: 'fallbackCandidate',
        };
      }
    }
    return {
      requestedFamily: fontFamily,
      resolvedFamily: 'Noto Sans KR',
      source: 'defaultFallback',
    };
  }

  resolveFamily(fontFamily: string): string {
    return this.resolveFamilyWithStatus(fontFamily).resolvedFamily;
  }

  resolveProviderFace(
    fontFamily: string,
    weight: RenderFontWeight,
    italic: boolean,
  ): CanvasKitProviderFaceResolution {
    const requestedAlias = localFontAliasKey(fontFamily);
    const family = this.resolveFamily(fontFamily);
    const aliasFaces = this.localAliasProviderFaces.get(requestedAlias);
    const localFaces = aliasFaces?.length
      ? aliasFaces
      : this.localProviderFamilies.get(family);
    if (localFaces?.length) {
      const matchingSlant = localFaces.filter(face => face.italic === italic);
      const candidates = matchingSlant.length > 0 ? matchingSlant : localFaces;
      const weightOrder: RenderFontWeight[] = weight === 300
        ? [300, 400, 500, 700]
        : weight === 400
          ? [400, 500, 300, 700]
          : weight === 500
            ? [500, 400, 300, 700]
            : [700, 500, 400, 300];
      const face = weightOrder
        .map(candidateWeight => candidates.find(candidate => candidate.weight === candidateWeight))
        .find((candidate): candidate is CanvasKitLocalProviderFace => candidate !== undefined)
        ?? candidates[0];
      return {
        providerFamily: face.providerFamily,
        physicalWeight: face.weight,
        physicalItalic: face.italic,
        synthesizeBold: weight === 700 && face.weight !== 700,
        synthesizeItalic: italic && !face.italic,
      };
    }

    const providerFaces = this.providerFamilies.get(family);
    const providerFamily = weight === 700 && providerFaces?.bold
      ? providerFaces.bold
      : providerFaces?.regular ?? providerFaces?.bold ?? family;
    const physicalWeight: RenderFontWeight = providerFamily === providerFaces?.bold ? 700 : 400;
    return {
      providerFamily,
      physicalWeight,
      physicalItalic: false,
      synthesizeBold: weight === 700
        && physicalWeight !== 700
        && !this.familiesWithBoldFace.has(family),
      synthesizeItalic: italic,
    };
  }

  resolveProviderFamily(
    fontFamily: string,
    weight: RenderFontWeight,
    italic = false,
  ): string {
    return this.resolveProviderFace(fontFamily, weight, italic).providerFamily;
  }

  registerVerifiedFontBlob(blobId: string, digestValue: string, bytes: ArrayBuffer | Uint8Array): void {
    const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const copy = new Uint8Array(source.byteLength);
    copy.set(source);
    const arrayBuffer = copy.buffer;
    this.verifiedFontBlobs.set(this.fontBlobCacheKey(blobId, digestValue), arrayBuffer);
  }

  registerFontBlobsFromResources(
    fontResources: LayerFontResources | undefined,
    resources: LayerResources | undefined,
  ): void {
    if (!fontResources?.blobs.length || !resources?.fontBlobs) {
      return;
    }
    for (const blob of fontResources.blobs) {
      if (blob.portability !== 'portableBlob' || !blob.digest || blob.dataRef?.kind !== 'fontBlob') {
        continue;
      }
      let resolvedRefId = blob.dataRef.id;
      const numericRef = /^(0|[1-9]\d*)$/.test(resolvedRefId)
        ? Number.parseInt(resolvedRefId, 10)
        : -1;
      if (numericRef < 0 || numericRef >= resources.fontBlobs.length) {
        const keyIndex = resources.fontBlobKeys?.indexOf(resolvedRefId) ?? -1;
        const digestIndex = resources.fontBlobHashes?.indexOf(blob.digest.value) ?? -1;
        const resolvedIndex = keyIndex >= 0 ? keyIndex : digestIndex;
        if (resolvedIndex < 0) {
          continue;
        }
        resolvedRefId = String(resolvedIndex);
      }
      const digest = this.fontBlobDigestForRef(resources.fontBlobHashes, resolvedRefId);
      if (digest !== blob.digest.value) {
        continue;
      }
      const bytes = this.fontBlobBytesForRef(resources.fontBlobs, resolvedRefId);
      if (!bytes) {
        continue;
      }
      this.registerVerifiedFontBlob(blob.id, blob.digest.value, bytes);
    }
  }

  glyphRunReplayStatus(
    run: LayerGlyphRunOp,
    fontResources: LayerFontResources | undefined,
  ): CanvasKitGlyphRunReplayStatus {
    if (!run.glyphIds.length) {
      return this.glyphRunReplayFailure(run, 'emptyGlyphRun');
    }
    if (run.glyphIds.length > MAX_STRICT_GLYPHS_PER_RUN
      || run.positions.length > MAX_STRICT_GLYPHS_PER_RUN
      || (run.advances?.length ?? 0) > MAX_STRICT_GLYPHS_PER_RUN
      || run.clusters.length > MAX_STRICT_GLYPHS_PER_RUN) {
      return this.glyphRunReplayFailure(run, 'glyphRunTooLarge');
    }
    if (run.glyphIds.length !== run.positions.length) {
      return this.glyphRunReplayFailure(run, 'glyphPositionCountMismatch');
    }
    if (run.advances && run.advances.length !== run.glyphIds.length) {
      return this.glyphRunReplayFailure(run, 'glyphAdvanceCountMismatch');
    }
    for (const point of run.positions) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)
        || Math.abs(point.x) > MAX_FLOAT32 || Math.abs(point.y) > MAX_FLOAT32) {
        return this.glyphRunReplayFailure(run, 'positionNotFinite');
      }
    }
    for (const advance of run.advances ?? []) {
      if (!Number.isFinite(advance.dx) || !Number.isFinite(advance.dy)
        || Math.abs(advance.dx) > MAX_FLOAT32 || Math.abs(advance.dy) > MAX_FLOAT32) {
        return this.glyphRunReplayFailure(run, 'advanceNotFinite');
      }
    }
    const transform = run.placement.runToPage;
    if (![
      transform.a,
      transform.b,
      transform.c,
      transform.d,
      transform.e,
      transform.f,
      run.placement.baselineY,
    ].every((value) => typeof value === 'number'
      && Number.isFinite(value)
      && Math.abs(value) <= MAX_FLOAT32)) {
      return this.glyphRunReplayFailure(run, 'placementNotFinite');
    }
    const instance = run.shapeKey.fontInstance;
    if (!Number.isFinite(instance.sizePx)
      || instance.sizePx <= 0
      || instance.sizePx > MAX_STRICT_GLYPH_FONT_SIZE_PX) {
      return this.glyphRunReplayFailure(run, 'fontInstanceInvalid');
    }
    if (run.direction !== run.shapeKey.direction
      || run.writingMode !== run.shapeKey.writingMode) {
      return this.glyphRunReplayFailure(run, 'glyphRunMetadataMismatch');
    }
    if (run.diagnostics.replayEligibility !== 'portable'
      && run.diagnostics.replayEligibility !== 'conditionalExternalFont') {
      return this.glyphRunReplayFailure(run, 'nonPortableGlyphRun');
    }
    if (!run.diagnostics.strictVisualEligible
      || (run.diagnostics.quality !== 'exact' && run.diagnostics.quality !== 'positionAdjusted')) {
      return this.glyphRunReplayFailure(run, 'qualityNotStrictEligible');
    }
    if (run.diagnostics.quality === 'positionAdjusted') {
      const tolerance = Math.min(0.5, Math.max(0.25, instance.sizePx * 0.005));
      if (!Number.isFinite(run.diagnostics.maxResidualAfterAdjustmentPx)
        || run.diagnostics.maxResidualAfterAdjustmentPx > tolerance) {
        return this.glyphRunReplayFailure(run, 'positionAdjustedResidualTooHigh');
      }
    }
    if (run.diagnostics.missingGlyphCount !== 0) {
      return this.glyphRunReplayFailure(run, 'missingGlyph');
    }
    if (run.diagnostics.clusterMismatchCount !== 0) {
      return this.glyphRunReplayFailure(run, 'clusterMismatch');
    }
    if (run.diagnostics.usedFallbackFontCount !== 0) {
      return this.glyphRunReplayFailure(run, 'diagnosticsNotClean');
    }
    if (run.orientation === 'mixedPerGlyph' || run.glyphTransforms?.length) {
      return this.glyphRunReplayFailure(run, 'mixedGlyphTransformsUnsupported');
    }
    for (const glyphId of run.glyphIds) {
      if (!Number.isInteger(glyphId) || glyphId <= 0 || glyphId > 0xffff) {
        return this.glyphRunReplayFailure(run, 'glyphIdOutOfRange');
      }
    }
    const unsupportedPaintReason = this.unsupportedGlyphRunPaintReason(run);
    if (unsupportedPaintReason) {
      return this.glyphRunReplayFailure(run, unsupportedPaintReason, {
        effectSupported: false,
      });
    }
    if (run.shapeKey.fontInstance.variations?.length) {
      return this.glyphRunReplayFailure(run, 'variationUnsupported', {
        variationSupported: false,
      });
    }

    const faceKey = run.shapeKey.fontInstance.faceKey;
    const face = fontResources?.faces.find((candidate) => candidate.id === faceKey);
    if (!face) {
      return this.glyphRunReplayFailure(run, 'fontFaceMissing', {
        exactFaceInstantiated: false,
      });
    }
    const blob = fontResources?.blobs.find((candidate) => candidate.id === face.blobKey);
    if (!blob) {
      return this.glyphRunReplayFailure(run, 'fontBlobMissing', {
        exactFaceInstantiated: false,
      });
    }
    if (run.diagnostics.replayEligibility === 'portable') {
      if (blob.portability !== 'portableBlob' || !blob.digest || !blob.dataRef) {
        return this.glyphRunReplayFailure(run, 'fontBlobNotPortable', {
          digestMatched: false,
          exactFaceInstantiated: false,
        });
      }
      if (!this.verifiedFontBlobs.has(this.fontBlobCacheKey(blob.id, blob.digest.value))) {
        return this.glyphRunReplayFailure(run, 'fontBlobNotVerified', {
          digestMatched: false,
          exactFaceInstantiated: false,
        });
      }
      if (
        face.faceIndex !== 0
        && !this.glyphRunTypefaces.has(this.typefaceCacheKey(face, blob))
        && !this.fontFaceDataForGlyphRun(face, blob)
      ) {
        return this.glyphRunReplayFailure(run, 'faceIndexUnsupported', {
          digestMatched: true,
          exactFaceInstantiated: false,
          faceIndexSupported: false,
        });
      }
      if (!this.typefaceForGlyphRun(face, blob)) {
        return this.glyphRunReplayFailure(run, 'fontFaceInstantiationFailed', {
          digestMatched: true,
          exactFaceInstantiated: false,
        });
      }
      return {
        replayable: true,
        face,
        blob,
        report: {
          ...this.glyphRunReplayBaseReport(run),
          digestMatched: true,
          exactFaceInstantiated: true,
          faceIndexSupported: true,
          variationSupported: true,
          effectSupported: true,
        },
      };
    }
    if (blob.portability !== 'externalVerified' || !blob.digest) {
      return this.glyphRunReplayFailure(run, 'externalFontNotVerified', {
        digestMatched: false,
        exactFaceInstantiated: false,
      });
    }
    if (!this.verifiedFontBlobs.has(this.fontBlobCacheKey(blob.id, blob.digest.value))
      && !this.glyphRunTypefaces.has(this.typefaceCacheKey(face, blob))) {
      return this.glyphRunReplayFailure(run, 'externalFontNotInstantiated', {
        digestMatched: false,
        exactFaceInstantiated: false,
      });
    }
    if (
      face.faceIndex !== 0
      && !this.glyphRunTypefaces.has(this.typefaceCacheKey(face, blob))
      && !this.fontFaceDataForGlyphRun(face, blob)
    ) {
      return this.glyphRunReplayFailure(run, 'faceIndexUnsupported', {
        digestMatched: true,
        exactFaceInstantiated: false,
        faceIndexSupported: false,
      });
    }
    if (!this.typefaceForGlyphRun(face, blob)) {
      return this.glyphRunReplayFailure(run, 'fontFaceInstantiationFailed', {
        digestMatched: true,
        exactFaceInstantiated: false,
      });
    }
    return {
      replayable: true,
      face,
      blob,
      report: {
        ...this.glyphRunReplayBaseReport(run),
        digestMatched: true,
        exactFaceInstantiated: true,
        faceIndexSupported: true,
        variationSupported: true,
        effectSupported: true,
      },
    };
  }

  glyphRunFont(
    run: LayerGlyphRunOp,
    fontResources: LayerFontResources | undefined,
  ): Font | null {
    const status = this.glyphRunReplayStatus(run, fontResources);
    if (!status.replayable) {
      return null;
    }
    const typeface = this.typefaceForGlyphRun(status.face, status.blob);
    if (!typeface) {
      return null;
    }
    const instance = run.shapeKey.fontInstance;
    const typefaceKey = this.typefaceCacheKey(status.face, status.blob);
    const key = [
      typefaceKey,
      instance.sizePx.toFixed(4),
      instance.syntheticBold ? 'bold' : 'regular',
      instance.syntheticItalic ? 'italic' : 'upright',
    ].join('|');
    const cached = this.glyphRunFonts.get(key);
    if (cached) {
      return cached;
    }
    const font = new this.canvasKit.Font(typeface, instance.sizePx || 12);
    font.setSubpixel(true);
    font.setEmbolden(!!instance.syntheticBold);
    font.setSkewX(instance.syntheticItalic ? -0.25 : 0);
    this.glyphRunFonts.set(key, font);
    return font;
  }

  clearDocumentResources(): void {
    for (const font of this.glyphRunFonts.values()) {
      font.delete();
    }
    this.glyphRunFonts.clear();
    for (const typeface of this.glyphRunTypefaces.values()) {
      typeface.delete();
    }
    this.glyphRunTypefaces.clear();
    this.verifiedFontBlobs.clear();
  }

  clear(): void {
    this.aliases.clear();
    this.providerFamilies.clear();
    this.clearLocalProviderIndexes();
    this.preparedLocalFaces.clear();
    this.localFontPreparationEpoch += 1;
    this.familiesWithBoldFace.clear();
    this.nextProviderFamilyId = 0;
    this.clearDocumentResources();
  }

  private registerProviderFace(alias: string, bytes: Uint8Array, bold: boolean): void {
    const faceKind = bold ? 'bold' : 'regular';
    const providerFaces = this.providerFamilies.get(alias) ?? {};
    if (providerFaces[faceKind]) {
      return;
    }
    const providerFamily = this.registerProviderFont(bytes, 'font', faceKind);
    providerFaces[faceKind] = providerFamily;
    this.providerFamilies.set(alias, providerFaces);
    this.aliases.add(alias);
    if (bold) {
      this.familiesWithBoldFace.add(alias);
    }
  }

  private registerLocalProviderFace(
    record: LocalFontRecord,
    bytes: Uint8Array,
  ): CanvasKitLocalProviderFace {
    const style = this.localProviderFaceStyle(record);
    const providerFamily = this.registerProviderFont(
      bytes,
      'local_font',
      `${style.weight}_${style.italic ? 'italic' : 'upright'}`,
    );
    return { providerFamily, ...style };
  }

  private localProviderFaceStyle(record: LocalFontRecord): {
    weight: RenderFontWeight;
    italic: boolean;
  } {
    const descriptor = `${record.fullName} ${record.postscriptName} ${record.style}`;
    const lowerDescriptor = descriptor.toLocaleLowerCase('en-US');
    const weight: RenderFontWeight = /(?:extra|ultra|semi|demi)?(?:bold)|black|heavy|볼드/.test(lowerDescriptor)
      ? 700
      : /(?:extra|ultra)?light|thin/.test(lowerDescriptor)
        ? 300
        : /medium|메디움/.test(lowerDescriptor)
          ? 500
          : resolveRenderFontWeight(descriptor, false);
    const italic = /italic|oblique|slanted|kursiv|이탤릭/.test(lowerDescriptor);
    return { weight, italic };
  }

  private localProviderFace(
    record: LocalFontRecord,
    providerFamily: string,
  ): CanvasKitLocalProviderFace {
    return { providerFamily, ...this.localProviderFaceStyle(record) };
  }

  private indexLocalProviderFace(record: LocalFontRecord, face: CanvasKitLocalProviderFace): void {
    const family = record.family || record.fullName || record.postscriptName;
    const familyFaces = this.localProviderFamilies.get(family) ?? [];
    familyFaces.push(face);
    this.localProviderFamilies.set(family, familyFaces);
    for (const alias of new Set([
      family,
      record.family,
      record.fullName,
      record.postscriptName,
      ...record.aliases,
    ])) {
      const key = localFontAliasKey(alias);
      if (!key) continue;
      this.localAliasFamilies.set(key, family);
      const aliasFaces = this.localAliasProviderFaces.get(key) ?? [];
      aliasFaces.push(face);
      this.localAliasProviderFaces.set(key, aliasFaces);
      this.localAliases.add(alias);
      this.aliases.add(alias);
    }
  }

  private clearLocalProviderIndexes(): void {
    for (const alias of this.localAliases) {
      if (!this.providerFamilies.has(alias)) this.aliases.delete(alias);
    }
    this.localAliases.clear();
    this.localProviderFamilies.clear();
    this.localAliasFamilies.clear();
    this.localAliasProviderFaces.clear();
  }

  private registerProviderFont(
    bytes: Uint8Array,
    source: 'font' | 'local_font',
    faceKind: string,
  ): string {
    const providerFamily = `__rhwp_canvas_${source}_${this.nextProviderFamilyId}_${faceKind}`;
    this.nextProviderFamilyId += 1;
    this.fontProvider.registerFont(bytes, providerFamily);
    return providerFamily;
  }

  private typefaceForGlyphRun(face: LayerFontFaceResource, blob: LayerFontBlobResource): Typeface | null {
    const cacheKey = this.typefaceCacheKey(face, blob);
    const cached = this.glyphRunTypefaces.get(cacheKey);
    if (cached) {
      return cached;
    }
    const bytes = this.fontFaceDataForGlyphRun(face, blob);
    if (!bytes) {
      return null;
    }
    let typeface: Typeface | null = null;
    try {
      typeface = this.canvasKit.Typeface.MakeTypefaceFromData(bytes.slice(0));
    } catch {
      typeface = null;
    }
    if (!typeface) {
      try {
        typeface = this.canvasKit.Typeface.MakeFreeTypeFaceFromData(bytes.slice(0));
      } catch {
        typeface = null;
      }
    }
    if (!typeface) {
      return null;
    }
    this.glyphRunTypefaces.set(cacheKey, typeface);
    return typeface;
  }

  private fontFaceDataForGlyphRun(
    face: LayerFontFaceResource,
    blob: LayerFontBlobResource,
  ): ArrayBuffer | null {
    if (!blob.digest) {
      return null;
    }
    const bytes = this.verifiedFontBlobs.get(this.fontBlobCacheKey(blob.id, blob.digest.value));
    return bytes ? canvasKitFontFaceData(bytes, face.faceIndex) : null;
  }

  private fontBlobCacheKey(blobId: string, digestValue: string): string {
    return `${blobId}:${digestValue}`;
  }

  private typefaceCacheKey(face: LayerFontFaceResource, blob: LayerFontBlobResource): string {
    return `${face.id}:${blob.id}:${blob.digest?.value ?? 'no-digest'}:face=${face.faceIndex}`;
  }

  private fontBlobDigestForRef(
    hashes: string[] | Record<string, string> | undefined,
    refId: string,
  ): string | undefined {
    if (!hashes) {
      return undefined;
    }
    if (Array.isArray(hashes)) {
      const index = Number.parseInt(refId, 10);
      return Number.isInteger(index) ? hashes[index] : undefined;
    }
    return hashes[refId];
  }

  private fontBlobBytesForRef(
    blobs: NonNullable<LayerResources['fontBlobs']> | Record<string, Uint8Array | number[] | string | undefined>,
    refId: string,
  ): Uint8Array | null {
    const payload = Array.isArray(blobs)
      ? blobs[Number.parseInt(refId, 10)]
      : blobs[refId];
    if (!payload) {
      return null;
    }
    if (payload instanceof Uint8Array) {
      return payload;
    }
    if (Array.isArray(payload)) {
      return new Uint8Array(payload);
    }
    if (typeof payload !== 'string') {
      return null;
    }
    const base64 = payload.includes(',') ? payload.split(',').pop() ?? '' : payload;
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(base64);
    } catch {
      return null;
    }
    if (bytes.length === 0) {
      return null;
    }
    return bytes;
  }

  private unsupportedGlyphRunPaintReason(run: LayerGlyphRunOp): string | null {
    const style = run.paintStyle;
    const ratio = typeof style.ratio === 'number' && style.ratio > 0 ? style.ratio : 1;
    const shadeColor = (style.shadeColor || '#ffffff').toLowerCase();
    const shadowType = style.shadowType ?? 0;
    const shadowOffsetX = style.shadowOffsetX ?? 0;
    const shadowOffsetY = style.shadowOffsetY ?? 0;
    const outlineType = style.outlineType ?? 0;
    const hasSupportedShadow = shadowType === 0
      || (shadowType > 0 && Number.isFinite(shadowOffsetX) && Number.isFinite(shadowOffsetY));
    const hasSupportedOutline = Number.isFinite(outlineType) && outlineType >= 0;
    if (Math.abs(ratio - 1) > 0.001) {
      return 'glyphRunRatioUnsupported';
    }
    if (style.tabLeaders?.length) {
      return 'glyphRunTabLeadersUnsupported';
    }
    if (style.underline !== 'none') {
      return 'glyphRunUnderlineUnsupported';
    }
    if (style.strikethrough) {
      return 'glyphRunStrikethroughUnsupported';
    }
    if ((style.emphasisDot ?? 0) !== 0) {
      return 'glyphRunEmphasisUnsupported';
    }
    if (!hasSupportedOutline) {
      return 'glyphRunOutlineUnsupported';
    }
    if (!hasSupportedShadow) {
      return 'glyphRunShadowUnsupported';
    }
    if (style.superscript) {
      return 'glyphRunSuperscriptUnsupported';
    }
    if (style.subscript) {
      return 'glyphRunSubscriptUnsupported';
    }
    if (shadeColor !== '#ffffff') {
      return 'glyphRunShadeUnsupported';
    }
    return null;
  }

  private glyphRunReplayFailure(
    run: LayerGlyphRunOp,
    reason: string,
    report: Partial<CanvasKitGlyphRunReplayReport> = {},
  ): CanvasKitGlyphRunReplayStatus {
    return {
      replayable: false,
      reason,
      report: {
        ...this.glyphRunReplayBaseReport(run),
        ...report,
        reason,
      },
    };
  }

  private glyphRunReplayBaseReport(run: LayerGlyphRunOp): CanvasKitGlyphRunReplayReport {
    return {
      replayEligibility: run.diagnostics.replayEligibility,
      quality: run.diagnostics.quality,
      strictVisualEligible: run.diagnostics.strictVisualEligible,
      faceIndexSupported: true,
      variationSupported: !(run.shapeKey.fontInstance.variations?.length),
      effectSupported: this.unsupportedGlyphRunPaintReason(run) === null,
    };
  }
}
