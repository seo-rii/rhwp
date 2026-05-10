import type { CanvasKit, Font, Typeface, TypefaceFontProvider } from 'canvaskit-wasm';

import { resolveFont } from '@/core/font-substitution';
import type {
  LayerFontBlobResource,
  LayerFontFaceResource,
  LayerFontResources,
  LayerResources,
  LayerGlyphRunOp,
} from '@/core/types';

const FONT_SANS_REGULAR_URL = new URL('../../../../web/fonts/NotoSansKR-Regular.woff2', import.meta.url).href;
const FONT_SANS_BOLD_URL = new URL('../../../../web/fonts/NotoSansKR-Bold.woff2', import.meta.url).href;
const FONT_SERIF_REGULAR_URL = new URL('../../../../web/fonts/NotoSerifKR-Regular.woff2', import.meta.url).href;
const FONT_SERIF_BOLD_URL = new URL('../../../../web/fonts/NotoSerifKR-Bold.woff2', import.meta.url).href;
const FONT_MONO_REGULAR_URL = new URL('../../../../web/fonts/D2Coding-Regular.woff2', import.meta.url).href;
const FONT_MATH_REGULAR_URL = new URL('../../../../web/fonts/LatinModernMath-Regular.woff2', import.meta.url).href;
const FONT_HAMCHOROM_DOTUM_URL = new URL('../../../../web/fonts/NotoSansKR-Regular.woff2', import.meta.url).href;
const FONT_HAMCHOROM_DOTUM_BOLD_URL = new URL('../../../../web/fonts/NotoSansKR-Bold.woff2', import.meta.url).href;
const FONT_HAMCHOROM_BATANG_URL = new URL('../../../../web/fonts/NotoSerifKR-Regular.woff2', import.meta.url).href;
const FONT_HAMCHOROM_BATANG_BOLD_URL = new URL('../../../../web/fonts/NotoSerifKR-Bold.woff2', import.meta.url).href;

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

const SANS_ALIASES = [
  'Noto Sans KR',
  'Noto Sans CJK KR',
  'NanumGothic',
  '나눔고딕',
  '맑은 고딕',
  'Malgun Gothic',
  'Apple SD Gothic Neo',
  'Pretendard',
  '돋움',
  '돋움체',
  '굴림',
  '새굴림',
  'HY중고딕',
  'HY그래픽',
  'HY그래픽M',
  'HYHeadLine M',
  'HYHeadLine Medium',
  'HY헤드라인M',
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

export class CanvasKitFontRegistry {
  readonly aliases = new Set<string>();
  private readonly verifiedFontBlobs = new Map<string, ArrayBuffer>();
  private readonly glyphRunTypefaces = new Map<string, Typeface>();
  private readonly glyphRunFonts = new Map<string, Font>();

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
      const regularBytes = await loadFontFile(regularUrl);
      const boldBytes = boldUrl ? await loadFontFile(boldUrl) : null;

      for (const alias of aliases) {
        this.fontProvider.registerFont(regularBytes, alias);
        this.aliases.add(alias);
        if (boldBytes) {
          this.fontProvider.registerFont(boldBytes, alias);
        }
      }
    };

    await registerAliases([HAMCHOROM_DOTUM_FAMILY], FONT_HAMCHOROM_DOTUM_URL, FONT_HAMCHOROM_DOTUM_BOLD_URL);
    await registerAliases([HAMCHOROM_BATANG_FAMILY], FONT_HAMCHOROM_BATANG_URL, FONT_HAMCHOROM_BATANG_BOLD_URL);
    await registerAliases(SANS_ALIASES, FONT_SANS_REGULAR_URL, FONT_SANS_BOLD_URL);
    await registerAliases(SERIF_ALIASES, FONT_SERIF_REGULAR_URL, FONT_SERIF_BOLD_URL);
    await registerAliases(MONO_ALIASES, FONT_MONO_REGULAR_URL);
    await registerAliases(MATH_ALIASES, FONT_MATH_REGULAR_URL);
  }

  resolveFamily(fontFamily: string): string {
    const resolved = resolveFont(fontFamily, 0, 0);
    if (HAMCHOROM_DOTUM_ALIASES.has(resolved) || HAMCHOROM_DOTUM_ALIASES.has(fontFamily)) {
      return HAMCHOROM_DOTUM_FAMILY;
    }
    if (HAMCHOROM_BATANG_ALIASES.has(resolved) || HAMCHOROM_BATANG_ALIASES.has(fontFamily)) {
      return HAMCHOROM_BATANG_FAMILY;
    }
    if (this.aliases.has(resolved)) return resolved;
    if (this.aliases.has(fontFamily)) return fontFamily;

    const lower = resolved.toLowerCase();
    if (/gulimche|coding|courier/.test(lower) || /굴림체/.test(resolved)) {
      return 'D2Coding';
    }
    if (/batang|batangche|gungsuh|serif|times/.test(lower) || /바탕|바탕체|명조|궁서/.test(resolved)) {
      return 'Noto Serif KR';
    }
    return 'Noto Sans KR';
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
      const digest = this.fontBlobDigestForRef(resources.fontBlobHashes, blob.dataRef.id);
      if (digest !== blob.digest.value) {
        continue;
      }
      const bytes = this.fontBlobBytesForRef(resources.fontBlobs, blob.dataRef.id);
      if (!bytes) {
        continue;
      }
      this.registerVerifiedFontBlob(blob.id, blob.digest.value, bytes);
    }
  }

  glyphRunReplayStatus(
    run: LayerGlyphRunOp,
    fontResources: LayerFontResources | undefined,
  ): { replayable: true; face: LayerFontFaceResource; blob: LayerFontBlobResource } | { replayable: false; reason: string } {
    if (run.diagnostics.replayEligibility !== 'portable'
      && run.diagnostics.replayEligibility !== 'conditionalExternalFont') {
      return { replayable: false, reason: 'nonPortableGlyphRun' };
    }
    if (!run.diagnostics.strictVisualEligible
      || (run.diagnostics.quality !== 'exact' && run.diagnostics.quality !== 'positionAdjusted')) {
      return { replayable: false, reason: 'qualityNotStrictEligible' };
    }
    if (
      run.diagnostics.missingGlyphCount !== 0
      || run.diagnostics.clusterMismatchCount !== 0
      || run.diagnostics.usedFallbackFontCount !== 0
    ) {
      return { replayable: false, reason: 'diagnosticsNotClean' };
    }
    if (run.orientation === 'mixedPerGlyph' || run.glyphTransforms?.length) {
      return { replayable: false, reason: 'mixedGlyphTransformsUnsupported' };
    }
    if (!run.glyphIds.length || run.glyphIds.length !== run.positions.length) {
      return { replayable: false, reason: 'glyphPositionLengthMismatch' };
    }
    if (run.advances && run.advances.length !== run.glyphIds.length) {
      return { replayable: false, reason: 'glyphAdvanceLengthMismatch' };
    }
    for (const glyphId of run.glyphIds) {
      if (!Number.isInteger(glyphId) || glyphId <= 0 || glyphId > 0xffff) {
        return { replayable: false, reason: 'glyphIdOutOfRange' };
      }
    }
    for (const point of run.positions) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        return { replayable: false, reason: 'nonFiniteGlyphPosition' };
      }
    }
    const transform = run.placement.runToPage;
    if (
      !Number.isFinite(transform.a)
      || !Number.isFinite(transform.b)
      || !Number.isFinite(transform.c)
      || !Number.isFinite(transform.d)
      || !Number.isFinite(transform.e)
      || !Number.isFinite(transform.f)
    ) {
      return { replayable: false, reason: 'nonFiniteGlyphTransform' };
    }
    if (!this.isFillOnlyPaint(run)) {
      return { replayable: false, reason: 'unsupportedGlyphRunPaintEffect' };
    }
    if (run.shapeKey.fontInstance.variations?.length) {
      return { replayable: false, reason: 'fontVariationUnsupported' };
    }

    const faceKey = run.shapeKey.fontInstance.faceKey;
    const face = fontResources?.faces.find((candidate) => candidate.id === faceKey);
    if (!face) {
      return { replayable: false, reason: 'fontFaceMissing' };
    }
    const blob = fontResources?.blobs.find((candidate) => candidate.id === face.blobKey);
    if (!blob) {
      return { replayable: false, reason: 'fontBlobMissing' };
    }
    if (face.faceIndex !== 0) {
      return { replayable: false, reason: 'fontFaceIndexUnsupported' };
    }
    if (run.diagnostics.replayEligibility === 'portable') {
      if (blob.portability !== 'portableBlob' || !blob.digest || !blob.dataRef) {
        return { replayable: false, reason: 'fontBlobNotPortable' };
      }
      if (!this.verifiedFontBlobs.has(this.fontBlobCacheKey(blob.id, blob.digest.value))) {
        return { replayable: false, reason: 'fontBlobNotVerified' };
      }
      return { replayable: true, face, blob };
    }
    if (blob.portability !== 'externalVerified' || !blob.digest) {
      return { replayable: false, reason: 'externalFontNotVerified' };
    }
    if (!this.verifiedFontBlobs.has(this.fontBlobCacheKey(blob.id, blob.digest.value))
      && !this.glyphRunTypefaces.has(this.typefaceCacheKey(face, blob))) {
      return { replayable: false, reason: 'externalFontNotInstantiated' };
    }
    return { replayable: true, face, blob };
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

  clear(): void {
    this.aliases.clear();
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

  private typefaceForGlyphRun(face: LayerFontFaceResource, blob: LayerFontBlobResource): Typeface | null {
    const cacheKey = this.typefaceCacheKey(face, blob);
    const cached = this.glyphRunTypefaces.get(cacheKey);
    if (cached) {
      return cached;
    }
    if (!blob.digest) {
      return null;
    }
    const bytes = this.verifiedFontBlobs.get(this.fontBlobCacheKey(blob.id, blob.digest.value));
    if (!bytes) {
      return null;
    }
    const typeface = this.canvasKit.Typeface.MakeTypefaceFromData(bytes.slice(0))
      ?? this.canvasKit.Typeface.MakeFreeTypeFaceFromData(bytes.slice(0));
    if (!typeface) {
      return null;
    }
    this.glyphRunTypefaces.set(cacheKey, typeface);
    return typeface;
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
    const binary = globalThis.atob?.(base64);
    if (!binary) {
      return null;
    }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  private isFillOnlyPaint(run: LayerGlyphRunOp): boolean {
    const style = run.paintStyle;
    const ratio = typeof style.ratio === 'number' ? style.ratio : 1;
    const shadeColor = (style.shadeColor || '#ffffff').toLowerCase();
    return Math.abs(ratio - 1) <= 0.001
      && style.underline === 'none'
      && !style.strikethrough
      && (style.emphasisDot ?? 0) === 0
      && (style.outlineType ?? 0) === 0
      && (style.shadowType ?? 0) === 0
      && !style.emboss
      && !style.engrave
      && shadeColor === '#ffffff';
  }
}
