const GENERIC_FONT_FAMILIES = new Set(['serif', 'sans-serif', 'monospace']);
const WEIGHT_SUFFIX_TOKENS = new Set([
  'black',
  'heavy',
  'extrabold',
  'ultrabold',
  'semibold',
  'demibold',
  'bold',
  'medium',
  'regular',
  'normal',
  'extralight',
  'ultralight',
  'demilight',
  'light',
  'thin',
  'extra',
  'ultra',
  'semi',
  'demi',
]);
const HEAVY_DISPLAY_FAMILIES = new Set([
  'HY헤드라인M',
  'HYHeadLine M',
  'HYHeadLine Medium',
  'HY견고딕',
  'HY견명조',
  'HY견명조B',
  '한양견고딕',
  '한양견명조',
  'HY그래픽',
  'HY그래픽M',
]);

export type RenderFontWeight = 300 | 400 | 500 | 700;

function primaryFontFamily(fontFamily: string): string {
  return fontFamily
    .split(',')[0]
    ?.trim()
    .replace(/^(['"])(.*)\1$/, '$2') ?? '';
}

/**
 * 요청 face 이름 끝의 굵기 접미사를 제거한 base family를 반환한다.
 *
 * 렌더링 폴백에만 사용하며 텍스트 측정용 family는 변경하지 않는다.
 */
export function baseFamilyWithoutWeightSuffix(fontFamily: string): string | null {
  const tokens = primaryFontFamily(fontFamily).split(/\s+/).filter(Boolean);
  const originalLength = tokens.length;
  while (tokens.length > 1 && WEIGHT_SUFFIX_TOKENS.has(tokens.at(-1)?.toLowerCase() ?? '')) {
    tokens.pop();
  }
  return tokens.length < originalLength ? tokens.join(' ') : null;
}

/**
 * Rust renderer의 fallback weight 힌트와 같은 우선순위로 Studio weight를 정한다.
 */
export function resolveRenderFontWeight(fontFamily: string, bold: boolean): RenderFontWeight {
  const primary = primaryFontFamily(fontFamily);
  const lower = primary.toLowerCase();
  if (bold || HEAVY_DISPLAY_FAMILIES.has(primary) || lower.includes('bold') || lower.includes('볼드')) {
    return 700;
  }
  if (
    lower.includes('light')
    || lower.includes('extralight')
    || lower.includes('thin')
    || lower.includes('ultralight')
  ) {
    return 300;
  }
  if (
    lower.includes('중고딕')
    || lower.includes('태고딕')
    || lower.includes('mediumgothic')
    || lower.includes('hymedium')
  ) {
    return 500;
  }
  return 400;
}

function pushUniqueFamily(families: string[], fontFamily: string): void {
  const family = fontFamily.trim();
  if (!family) return;
  const key = family.toLocaleLowerCase('en-US');
  if (families.some((candidate) => candidate.toLocaleLowerCase('en-US') === key)) return;
  families.push(family);
}

function systemFallbackFamilies(fontName: string): string[] {
  const lower = fontName.toLowerCase();
  if (fontName.includes('KoPub바탕체') || lower.includes('kopub batang')) {
    return [
      'Batang',
      'AppleMyungjo',
      'Noto Serif KR',
      'Noto Serif CJK KR',
      'NanumMyeongjo',
      '나눔명조',
      'Latin Modern Math',
      'serif',
    ];
  }
  if (/굴림체|바탕체|gulimche|batangche|coding|courier/i.test(fontName)) {
    return [
      'GulimChe',
      'D2Coding',
      'NanumGothicCoding',
      '나눔고딕코딩',
      'Noto Sans Mono',
      'Latin Modern Math',
      'monospace',
    ];
  }
  if (/[바탕명조궁서]|hymjre|serif|times|palatino|georgia|batang|gungsuh/i.test(fontName)) {
    return [
      'Batang',
      'AppleMyungjo',
      'Noto Serif KR',
      'Noto Serif CJK KR',
      'NanumMyeongjo',
      '나눔명조',
      'Latin Modern Math',
      'serif',
    ];
  }
  return [
    'Malgun Gothic',
    'Apple SD Gothic Neo',
    'Noto Sans KR ExtraLight',
    'Noto Sans KR',
    'Noto Sans CJK KR',
    'NanumGothic',
    '나눔고딕',
    'Pretendard',
    'Latin Modern Math',
    'sans-serif',
  ];
}

function canvasRenderFallbackFamilies(fontName: string): string[] {
  const lower = fontName.toLowerCase();
  if (fontName.includes('KoPub바탕체') || lower.includes('kopub batang')) {
    return [
      'Batang',
      '바탕',
      'AppleMyungjo',
      'Noto Serif CJK KR',
      'NanumMyeongjo',
      '나눔명조',
      'Noto Serif KR',
      'Latin Modern Math',
      'serif',
    ];
  }
  if (/굴림체|바탕체|gulimche|batangche|coding|courier/i.test(fontName)) {
    return [
      'GulimChe',
      '굴림체',
      'D2Coding',
      'NanumGothicCoding',
      '나눔고딕코딩',
      'Noto Sans Mono',
      'Latin Modern Math',
      'monospace',
    ];
  }
  if (/[바탕명조궁서]|hymjre|serif|times|palatino|georgia|batang|gungsuh/i.test(fontName)) {
    return [
      'Batang',
      '바탕',
      'AppleMyungjo',
      'Noto Serif CJK KR',
      'NanumMyeongjo',
      '나눔명조',
      'Noto Serif KR',
      'Latin Modern Math',
      'serif',
    ];
  }
  return [
    'Malgun Gothic',
    '맑은 고딕',
    'Apple SD Gothic Neo',
    'Noto Sans KR ExtraLight',
    'Noto Sans CJK KR',
    'NanumGothic',
    '나눔고딕',
    'Noto Sans KR',
    'Pretendard',
    'Latin Modern Math',
    'sans-serif',
  ];
}

function fallbackCandidates(
  fontName: string,
  fallbackFamilies: (family: string) => string[],
): string[] {
  const family = fontName.trim();
  if (!family) return fallbackFamilies('');
  if (GENERIC_FONT_FAMILIES.has(family)) return [family];

  const families: string[] = [];
  pushUniqueFamily(families, family);
  const baseFamily = baseFamilyWithoutWeightSuffix(family);
  if (baseFamily) pushUniqueFamily(families, baseFamily);
  for (const fallback of fallbackFamilies(family)) {
    pushUniqueFamily(families, fallback);
  }
  return families;
}

/**
 * 요청 face → base family → platform/generic fallback 순서의 family 목록.
 */
export function fontFamilyFallbackCandidates(fontName: string): string[] {
  return fallbackCandidates(fontName, systemFallbackFamilies);
}

/**
 * 기존 Canvas2D 후보 순서를 보존하는 Studio direct-renderer family 목록.
 */
export function canvasFontFamilyFallbackCandidates(fontName: string): string[] {
  return fallbackCandidates(fontName, canvasRenderFallbackFamilies);
}

function quoteCssFontFamily(fontFamily: string): string {
  if (GENERIC_FONT_FAMILIES.has(fontFamily)) return fontFamily;
  return `"${fontFamily.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function fontFamilyWithFallback(fontName: string): string {
  return fontFamilyFallbackCandidates(fontName).map(quoteCssFontFamily).join(', ');
}

export function buildCanvasTextFont(
  fontFamily: string,
  fontSize: number,
  bold: boolean,
  italic: boolean,
  weightOverride?: RenderFontWeight,
): string {
  const family = canvasFontFamilyFallbackCandidates(fontFamily).map(quoteCssFontFamily).join(', ');
  const weight = weightOverride ?? resolveRenderFontWeight(fontFamily, bold);
  const weightPrefix = weight === 400 ? '' : `${weight} `;
  return `${italic ? 'italic ' : ''}${weightPrefix}${(fontSize || 12).toFixed(3)}px ${family}`;
}
