import type { LayerTextControlMark, LayerTextStyle } from '@/core/types';

export const TEXT_CONTROL_MARK_FONT_FAMILY = 'D2Coding';
const GRAPHEME_SEGMENTER = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

export function startsWithInvalidControl(text: string): boolean {
  if (!text) {
    return false;
  }
  const code = text.codePointAt(0) ?? 0;
  return code === 0xfffc
    || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d);
}

export function isHalfwidthScaledCluster(text: string): boolean {
  const code = text.codePointAt(0) ?? 0;
  return (code >= 0x2018 && code <= 0x2027) || code === 0x00b7;
}

export function containsOldHangulJamo(text: string): boolean {
  return Array.from(text).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (codePoint >= 0x1100 && codePoint <= 0x11ff)
      || (codePoint >= 0xa960 && codePoint <= 0xa97f)
      || (codePoint >= 0xd7b0 && codePoint <= 0xd7ff);
  });
}

export function allowsTextControlMark(
  showParagraphMarks: boolean,
  showControlCodes: boolean,
  kind: LayerTextControlMark['kind'],
): boolean {
  switch (kind) {
    case 'paragraphEnd':
      return showParagraphMarks;
    case 'space':
    case 'tab':
    case 'lineBreakEnd':
      return showControlCodes;
  }
}

export interface TabLeaderLineSegment {
  offsetY: number;
  width: number;
  dash: number[];
  cap: 'butt' | 'round';
}

export function tabLeaderLineSegments(fillType: number): TabLeaderLineSegment[] {
  const segment = (
    offsetY: number,
    width: number,
    dash: number[] = [],
    cap: TabLeaderLineSegment['cap'] = 'butt',
  ): TabLeaderLineSegment => ({ offsetY, width, dash, cap });
  switch (fillType) {
    case 0:
      return [];
    case 1:
      return [segment(0, 0.5)];
    case 2:
      return [segment(0, 0.5, [3, 3])];
    case 3:
      return [segment(0, 0.5, [1, 2])];
    case 4:
      return [segment(0, 0.5, [6, 2, 1, 2])];
    case 5:
      return [segment(0, 0.5, [6, 2, 1, 2, 1, 2])];
    case 6:
      return [segment(0, 0.5, [8, 4])];
    case 7:
      return [segment(0, 0.7, [0.1, 2.5], 'round')];
    case 8:
      return [segment(-1, 0.3), segment(1, 0.3)];
    case 9:
      return [segment(-1.2, 0.3), segment(0.8, 0.8)];
    case 10:
      return [segment(-0.8, 0.8), segment(1.2, 0.3)];
    case 11:
      return [segment(-2, 0.3), segment(0, 0.8), segment(2, 0.3)];
    default:
      return [segment(0, 0.5, [1, 2])];
  }
}

export type TextDecorationLinePrimitive =
  | {
    kind: 'line';
    offsetY: number;
    width: number;
    dash: number[];
    cap: 'butt' | 'round';
  }
  | {
    kind: 'wave';
    offsetY: number;
    width: number;
    amplitude: number;
    wavelength: number;
  };

export function textDecorationLineGeometry(shape: number): TextDecorationLinePrimitive[] {
  const line = (
    offsetY: number,
    width: number,
    dash: number[] = [],
    cap: 'butt' | 'round' = 'butt',
  ): TextDecorationLinePrimitive => ({ kind: 'line', offsetY, width, dash, cap });
  const wave = (
    offsetY: number,
    width: number,
    amplitude: number,
  ): TextDecorationLinePrimitive => ({
    kind: 'wave',
    offsetY,
    width,
    amplitude,
    wavelength: 6,
  });
  switch (shape) {
    case 1:
      return [line(0, 1, [3, 3])];
    case 2:
      return [line(0, 1, [1, 2])];
    case 3:
      return [line(0, 1, [6, 2, 1, 2])];
    case 4:
      return [line(0, 1, [6, 2, 1, 2, 1, 2])];
    case 5:
      return [line(0, 1, [8, 4])];
    case 6:
      return [line(0, 1, [0.1, 2.5], 'round')];
    case 7:
      return [line(-1, 0.7), line(1, 0.7)];
    case 8:
      return [line(-1.2, 0.5), line(0.8, 1.2)];
    case 9:
      return [line(-0.8, 1.2), line(1.2, 0.5)];
    case 10:
      return [line(-1.5, 0.5), line(0, 0.5), line(1.5, 0.5)];
    case 11:
      return [wave(0, 0.7, 1.5)];
    case 12:
      return [wave(-1, 0.5, 1.2), wave(1, 0.5, 1.2)];
    default:
      return [line(0, 1)];
  }
}

export type TextDecorationEmphasisPathCommand =
  | { kind: 'moveTo'; x: number; y: number }
  | { kind: 'lineTo'; x: number; y: number }
  | { kind: 'quadraticCurveTo'; controlX: number; controlY: number; x: number; y: number };

export type TextDecorationEmphasisPrimitive =
  | {
    kind: 'circle';
    x: number;
    y: number;
    radius: number;
    paint: 'fill' | 'stroke';
    strokeWidth?: number;
  }
  | {
    kind: 'path';
    commands: TextDecorationEmphasisPathCommand[];
    strokeWidth: number;
  };

export function textDecorationEmphasisGeometry(
  emphasisDot: number,
  size: number,
): TextDecorationEmphasisPrimitive[] {
  if (!Number.isFinite(size) || size <= 0) {
    return [];
  }
  const centerY = -size * 0.45;
  const pathStrokeWidth = Math.max(size * 0.14, 0.75);
  switch (emphasisDot) {
    case 1:
    case 2:
      return [{
        kind: 'circle',
        x: 0,
        y: centerY,
        radius: Math.max(size * 0.48, 1),
        paint: emphasisDot === 1 ? 'fill' : 'stroke',
        strokeWidth: Math.max(size * 0.12, 0.75),
      }];
    case 3:
      return [{
        kind: 'path',
        commands: [
          { kind: 'moveTo', x: -size * 0.48, y: -size * 0.72 },
          { kind: 'lineTo', x: 0, y: -size * 0.18 },
          { kind: 'lineTo', x: size * 0.48, y: -size * 0.72 },
        ],
        strokeWidth: pathStrokeWidth,
      }];
    case 4:
      return [{
        kind: 'path',
        commands: [
          { kind: 'moveTo', x: -size * 0.6, y: -size * 0.48 },
          {
            kind: 'quadraticCurveTo',
            controlX: -size * 0.3,
            controlY: -size * 0.8,
            x: 0,
            y: -size * 0.48,
          },
          {
            kind: 'quadraticCurveTo',
            controlX: size * 0.3,
            controlY: -size * 0.16,
            x: size * 0.6,
            y: -size * 0.48,
          },
        ],
        strokeWidth: pathStrokeWidth,
      }];
    case 5:
      return [{
        kind: 'circle',
        x: 0,
        y: centerY,
        radius: Math.max(size * 0.16, 0.65),
        paint: 'fill',
      }];
    case 6: {
      const radius = Math.max(size * 0.13, 0.6);
      return [
        { kind: 'circle', x: 0, y: -size * 0.7, radius, paint: 'fill' },
        { kind: 'circle', x: 0, y: -size * 0.2, radius, paint: 'fill' },
      ];
    }
    default:
      return [];
  }
}

export function textDecorationLineY(
  kind: 'underline' | 'strikethrough',
  underline: string | undefined,
  baselineY: number,
  fontSize: number,
): number {
  if (kind === 'underline') {
    return underline === 'top' ? baselineY - fontSize + 1 : baselineY + 2;
  }
  return baselineY - fontSize * 0.3;
}

export function textDecorationEmphasisSize(fontSize: number): number {
  return fontSize * 0.3;
}

export function textDecorationEmphasisPosition(
  originX: number,
  baselineY: number,
  position: number,
  fontSize: number,
  ratio: number,
): { x: number; y: number } {
  return {
    x: originX + position + fontSize * ratio * 0.5,
    y: baselineY - fontSize * 1.05,
  };
}

export function textScriptMetrics(
  baseFontSize: number,
  superscript: boolean,
  subscript: boolean,
): { fontSize: number; baselineShift: number } {
  if (superscript) {
    return {
      fontSize: baseFontSize * 0.7,
      baselineShift: -baseFontSize * 0.3,
    };
  }
  if (subscript) {
    return {
      fontSize: baseFontSize * 0.7,
      baselineShift: baseFontSize * 0.15,
    };
  }
  return { fontSize: baseFontSize, baselineShift: 0 };
}

function puaOverlapDigit(ch: string): [number, number] | null {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp >= 0xF0289 && cp <= 0xF0291) {
    return [0, cp - 0xF0288];
  }
  if (cp >= 0xF0292 && cp <= 0xF029B) {
    return [1, cp - 0xF0292];
  }
  if (cp >= 0xF0491 && cp <= 0xF0499) {
    return [0, cp - 0xF0490];
  }
  if (cp >= 0xF049A && cp <= 0xF04A3) {
    return [1, cp - 0xF049A];
  }
  if (cp >= 0xF04A4 && cp <= 0xF04AD) {
    return [2, cp - 0xF04A4];
  }
  return null;
}

export function decodePuaOverlapNumber(chars: string[]): string | null {
  if (!chars.length) {
    return null;
  }
  const groups: Array<[number, number]> = [];
  for (const ch of chars) {
    const digit = puaOverlapDigit(ch);
    if (!digit) {
      return null;
    }
    groups.push(digit);
  }
  groups.sort(([left], [right]) => left - right);
  return groups.map(([, digit]) => String.fromCharCode(0x30 + digit)).join('');
}

export function charOverlapInnerSizeRatio(innerCharSize: number): number {
  if (innerCharSize > 0) {
    return innerCharSize / 100;
  }
  if (innerCharSize < 0) {
    return 1 + innerCharSize * 0.10;
  }
  return 1;
}

const VERIFIED_HANCOM_PUA_DISPLAY = new Map<number, string>([
  [0xF0A0, '\u00B7'],
  [0xF0E8, '\u2794'],
  [0xF003B, '\u2193'],
  [0xF012B, '(\uC778)'],
  [0xF02EF, '\u00B7'],
  [0xF02FC, '\u25BA'],
  [0xF031C, '\u25A0'],
  [0xF03A0, '\u21B5'],
  [0xF03C5, '\u25A1'],
  [0xF03EF, '\uD55C'],
  [0xF03F0, '\uAE00'],
  [0xF03F1, '\uACFC'],
  [0xF03F2, '\uCEF4'],
  [0xF03F3, '\uD4E8'],
  [0xF03F4, '\uD130'],
  [0xF080F, '\u2501'],
  [0xF0811, '\u250C'],
  [0xF0817, '\u2514'],
  [0xF081A, '\u2500'],
  [0xF0854, '\u300A'],
  [0xF0855, '\u300B'],
]);

export function puaToDisplayText(ch: string): string | null {
  const cp = ch.codePointAt(0) ?? 0;
  const verified = VERIFIED_HANCOM_PUA_DISPLAY.get(cp);
  if (verified !== undefined) {
    return verified;
  }
  if (cp >= 0xF02B1 && cp <= 0xF02C4) {
    return String(cp - 0xF02B0);
  }
  if (cp >= 0xF02CE && cp <= 0xF02E1) {
    return String(cp - 0xF02CD);
  }
  return null;
}

export function mapPuaBulletChar(ch: string): string {
  const cp = ch.codePointAt(0) ?? 0;
  const verified = VERIFIED_HANCOM_PUA_DISPLAY.get(cp);
  if (verified !== undefined && Array.from(verified).length === 1) {
    return verified;
  }
  if (cp < 0xF020 || cp > 0xF0FF) {
    return ch;
  }
  switch (cp - 0xF000) {
    case 0x6c:
    case 0x6d:
      return '\u25CF';
    case 0x6e:
      return '\u25A0';
    case 0x6f:
    case 0x70:
    case 0x71:
    case 0x72:
      return '\u25A1';
    case 0x73:
      return '\u2B27';
    case 0x74:
      return '\u29EB';
    case 0x75:
      return '\u25C6';
    case 0x76:
      return '\u2756';
    case 0x77:
      return '\u2B25';
    case 0x9e:
      return '\u00B7';
    case 0x9f:
      return '\u2022';
    case 0xa0:
      return '\u00B7';
    case 0xa7:
      return '\u25AA';
    case 0xa1:
      return '\u26AA';
    case 0xa2:
    case 0xa3:
      return '\u25CB';
    case 0xa4:
      return '\u25C9';
    case 0xa5:
      return '\u25CE';
    case 0xa8:
      return '\u25FB';
    case 0xaa:
      return '\u2726';
    case 0xab:
      return '\u2605';
    case 0xac:
      return '\u2736';
    case 0xad:
      return '\u2734';
    case 0xae:
      return '\u2739';
    case 0x45:
      return '\u261C';
    case 0x46:
      return '\u261E';
    case 0x47:
      return '\u261D';
    case 0x48:
      return '\u261F';
    case 0xfb:
      return '\u2717';
    case 0xfc:
      return '\u2714';
    case 0xfd:
      return '\u2612';
    case 0xfe:
      return '\u2611';
    case 0xef:
      return '\u21E6';
    case 0xf0:
      return '\u21E8';
    case 0xf1:
      return '\u21E7';
    case 0xf2:
      return '\u21E9';
    case 0x22:
      return '\u2702';
    case 0x36:
      return '\u231B';
    case 0x4a:
      return '\u263A';
    case 0x4e:
      return '\u2620';
    case 0x52:
      return '\u263C';
    case 0x54:
      return '\u2744';
    case 0x58:
      return '\u2720';
    case 0x59:
      return '\u2721';
    default:
      return ch;
  }
}

export function mapPuaBulletText(text: string): string {
  let mapped = '';
  let changed = false;
  for (const ch of text) {
    const next = mapPuaBulletChar(ch);
    mapped += next;
    changed ||= next !== ch;
  }
  return changed ? mapped : text;
}

export function mapPuaDisplayText(text: string): string {
  let mapped = '';
  let changed = false;
  for (const ch of text) {
    if (ch === '\uF081C') {
      changed = true;
      continue;
    }
    const plain = puaToDisplayText(ch);
    if (plain !== null && !isPuaOverlapDisplayChar(ch)) {
      mapped += plain;
      changed = true;
      continue;
    }
    const next = mapPuaBulletChar(ch);
    mapped += next;
    changed ||= next !== ch;
  }
  return changed ? mapped : text;
}

const VERTICAL_PRESENTATION_BASE_TEXT = new Map<string, string>([
  ['\uFE19', '\u2026'],
  ['\uFE31', '\u2014'],
  ['\uFE32', '\u2013'],
  ['\uFE33', '_'],
  ['\uFE34', '~'],
  ['\uFE35', '('],
  ['\uFE36', ')'],
  ['\uFE37', '{'],
  ['\uFE38', '}'],
  ['\uFE39', '['],
  ['\uFE3A', ']'],
  ['\uFE3B', '\u3010'],
  ['\uFE3C', '\u3011'],
  ['\uFE3D', '\u300A'],
  ['\uFE3E', '\u300B'],
  ['\uFE3F', '\u3008'],
  ['\uFE40', '\u3009'],
  ['\uFE41', '\u300C'],
  ['\uFE42', '\u300D'],
  ['\uFE43', '\u300E'],
  ['\uFE44', '\u300F'],
]);

export function verticalPresentationBaseText(text: string): string | null {
  return VERTICAL_PRESENTATION_BASE_TEXT.get(text) ?? null;
}

function isPuaOverlapDisplayChar(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return (cp >= 0xF02B1 && cp <= 0xF02C4) || (cp >= 0xF02CE && cp <= 0xF02E1);
}

export function estimateDisplayTextPositions(text: string, style: LayerTextStyle): number[] {
  const fontSize = style.fontSize || 12;
  const ratio = typeof style.ratio === 'number' && style.ratio > 0 ? style.ratio : 1;
  const positions = [0];
  let cursor = 0;
  for (const ch of Array.from(text)) {
    const width = ch === '\t'
      ? fontSize * 4
      : isHalfwidthScaledCluster(ch)
        ? fontSize * 0.5
        : fontSize;
    cursor += width * ratio;
    positions.push(cursor);
  }
  return positions;
}

export function splitIntoClusters(
  text: string,
): Array<{ start: number; startUtf16: number; text: string }> {
  const chars = Array.from(text);
  const utf16Starts: number[] = [];
  let utf16Offset = 0;
  for (const char of chars) {
    utf16Starts.push(utf16Offset);
    utf16Offset += char.length;
  }
  if (GRAPHEME_SEGMENTER) {
    const characterIndexByUtf16Start = new Map(
      utf16Starts.map((startUtf16, start) => [startUtf16, start]),
    );
    return Array.from(GRAPHEME_SEGMENTER.segment(text), ({ segment, index }) => ({
      start: characterIndexByUtf16Start.get(index) ?? 0,
      startUtf16: index,
      text: segment,
    }));
  }
  const clusters: Array<{ start: number; startUtf16: number; text: string }> = [];

  let idx = 0;
  while (idx < chars.length) {
    if (isHangulChoseong(chars[idx])) {
      const start = idx;
      const startUtf16 = utf16Starts[start];
      let cluster = chars[idx];
      idx += 1;
      if (idx < chars.length && isHangulJungseong(chars[idx])) {
        cluster += chars[idx];
        idx += 1;
        if (idx < chars.length && isHangulJongseong(chars[idx])) {
          cluster += chars[idx];
          idx += 1;
        }
      }
      clusters.push({ start, startUtf16, text: cluster });
      continue;
    }

    clusters.push({ start: idx, startUtf16: utf16Starts[idx], text: chars[idx] });
    idx += 1;
  }

  return clusters;
}

function isHangulChoseong(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (code >= 0x1100 && code <= 0x115F) || (code >= 0xA960 && code <= 0xA97F);
}

function isHangulJungseong(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (code >= 0x1160 && code <= 0x11A7) || (code >= 0xD7B0 && code <= 0xD7C6);
}

function isHangulJongseong(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (code >= 0x11A8 && code <= 0x11FF) || (code >= 0xD7CB && code <= 0xD7FB);
}
