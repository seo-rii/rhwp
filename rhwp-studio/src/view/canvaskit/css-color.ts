import type { CanvasKit } from 'canvaskit-wasm';

const CANVASKIT_CSS_NAMED_COLORS: Record<string, [number, number, number, number]> = {
  black: [0, 0, 0, 1],
  blue: [0, 0, 1, 1],
  cyan: [0, 1, 1, 1],
  gray: [0.5019607843137255, 0.5019607843137255, 0.5019607843137255, 1],
  green: [0, 0.5019607843137255, 0, 1],
  grey: [0.5019607843137255, 0.5019607843137255, 0.5019607843137255, 1],
  magenta: [1, 0, 1, 1],
  red: [1, 0, 0, 1],
  transparent: [0, 0, 0, 0],
  white: [1, 1, 1, 1],
  yellow: [1, 1, 0, 1],
};

export function parseCanvasKitCssColor(canvasKit: CanvasKit, color: string, opacity = 1): Float32Array {
  const parsed = parseSupportedCssColor(color);
  const fallback = canvasKit.parseColorString(color) as ArrayLike<number> | undefined;
  const rgba = parsed ?? (fallback ? Array.from(fallback) : [0, 0, 0, 1]);
  return Float32Array.of(
    clampCanvasKitUnit(rgba[0] ?? 0),
    clampCanvasKitUnit(rgba[1] ?? 0),
    clampCanvasKitUnit(rgba[2] ?? 0),
    clampCanvasKitUnit((rgba[3] ?? 1) * opacity),
  );
}

function parseSupportedCssColor(color: string): [number, number, number, number] | null {
  const normalized = color.trim().toLowerCase();
  const named = CANVASKIT_CSS_NAMED_COLORS[normalized];
  if (named) {
    return named;
  }
  const rgbMatch = normalized.match(/^rgba?\((.*)\)$/);
  if (rgbMatch) {
    return parseRgbColorFunction(rgbMatch[1]);
  }
  const hslMatch = normalized.match(/^hsla?\((.*)\)$/);
  if (hslMatch) {
    return parseHslColorFunction(hslMatch[1]);
  }
  return null;
}

function parseRgbColorFunction(body: string): [number, number, number, number] | null {
  const [colorBody, slashAlpha] = body.split('/').map((part) => part.trim());
  const parts = colorBody.includes(',')
    ? colorBody.split(',').map((part) => part.trim()).filter((part) => part.length > 0)
    : colorBody.split(/\s+/).filter((part) => part.length > 0);
  if (parts.length < 3 || parts.length > 4) {
    return null;
  }
  const red = parseRgbChannel(parts[0]);
  const green = parseRgbChannel(parts[1]);
  const blue = parseRgbChannel(parts[2]);
  const alpha = parseCssAlpha(slashAlpha ?? parts[3] ?? '1');
  if (red === null || green === null || blue === null || alpha === null) {
    return null;
  }
  return [red, green, blue, alpha];
}

function parseHslColorFunction(body: string): [number, number, number, number] | null {
  const [colorBody, slashAlpha] = body.split('/').map((part) => part.trim());
  const parts = colorBody.includes(',')
    ? colorBody.split(',').map((part) => part.trim()).filter((part) => part.length > 0)
    : colorBody.split(/\s+/).filter((part) => part.length > 0);
  if (parts.length < 3 || parts.length > 4) {
    return null;
  }
  const hue = Number(parts[0]);
  const saturation = parseCssPercent(parts[1]);
  const lightness = parseCssPercent(parts[2]);
  const alpha = parseCssAlpha(slashAlpha ?? parts[3] ?? '1');
  if (!Number.isFinite(hue) || saturation === null || lightness === null || alpha === null) {
    return null;
  }
  const [red, green, blue] = hslToRgb(hue, saturation, lightness);
  return [red, green, blue, alpha];
}

function parseRgbChannel(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.endsWith('%')) {
    return parseCssPercent(trimmed);
  }
  const number = Number(trimmed);
  return Number.isFinite(number) ? clampCanvasKitUnit(number / 255) : null;
}

function parseCssAlpha(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.endsWith('%')) {
    return parseCssPercent(trimmed);
  }
  const number = Number(trimmed);
  return Number.isFinite(number) ? clampCanvasKitUnit(number) : null;
}

function parseCssPercent(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed.endsWith('%')) {
    return null;
  }
  const number = Number(trimmed.slice(0, -1).trim());
  return Number.isFinite(number) ? clampCanvasKitUnit(number / 100) : null;
}

function hslToRgb(hueDegrees: number, saturation: number, lightness: number): [number, number, number] {
  const hue = ((hueDegrees % 360) + 360) % 360;
  const chroma = (1 - Math.abs((2 * lightness) - 1)) * saturation;
  const second = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const match = lightness - (chroma / 2);
  let red = 0;
  let green = 0;
  let blue = 0;
  if (hue < 60) {
    red = chroma;
    green = second;
  } else if (hue < 120) {
    red = second;
    green = chroma;
  } else if (hue < 180) {
    green = chroma;
    blue = second;
  } else if (hue < 240) {
    green = second;
    blue = chroma;
  } else if (hue < 300) {
    red = second;
    blue = chroma;
  } else {
    red = chroma;
    blue = second;
  }
  return [red + match, green + match, blue + match];
}

export function clampCanvasKitUnit(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
