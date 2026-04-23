import type { TypefaceFontProvider } from 'canvaskit-wasm';

import { resolveFont } from '@/core/font-substitution';

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

  constructor(private readonly fontProvider: TypefaceFontProvider) {}

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

  clear(): void {
    this.aliases.clear();
  }
}
