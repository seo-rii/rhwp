import type { CanvasKit } from 'canvaskit-wasm';

const CANVASKIT_CSS_NAMED_COLORS: Record<string, string> = {
  aliceblue: '#f0f8ff',
  antiquewhite: '#faebd7',
  aqua: '#00ffff',
  aquamarine: '#7fffd4',
  azure: '#f0ffff',
  beige: '#f5f5dc',
  bisque: '#ffe4c4',
  black: '#000000',
  blanchedalmond: '#ffebcd',
  blue: '#0000ff',
  blueviolet: '#8a2be2',
  brown: '#a52a2a',
  burlywood: '#deb887',
  cadetblue: '#5f9ea0',
  chartreuse: '#7fff00',
  chocolate: '#d2691e',
  coral: '#ff7f50',
  cornflowerblue: '#6495ed',
  cornsilk: '#fff8dc',
  crimson: '#dc143c',
  cyan: '#00ffff',
  darkblue: '#00008b',
  darkcyan: '#008b8b',
  darkgoldenrod: '#b8860b',
  darkgray: '#a9a9a9',
  darkgreen: '#006400',
  darkgrey: '#a9a9a9',
  darkkhaki: '#bdb76b',
  darkmagenta: '#8b008b',
  darkolivegreen: '#556b2f',
  darkorange: '#ff8c00',
  darkorchid: '#9932cc',
  darkred: '#8b0000',
  darksalmon: '#e9967a',
  darkseagreen: '#8fbc8f',
  darkslateblue: '#483d8b',
  darkslategray: '#2f4f4f',
  darkslategrey: '#2f4f4f',
  darkturquoise: '#00ced1',
  darkviolet: '#9400d3',
  deeppink: '#ff1493',
  deepskyblue: '#00bfff',
  dimgray: '#696969',
  dimgrey: '#696969',
  dodgerblue: '#1e90ff',
  firebrick: '#b22222',
  floralwhite: '#fffaf0',
  forestgreen: '#228b22',
  fuchsia: '#ff00ff',
  gainsboro: '#dcdcdc',
  ghostwhite: '#f8f8ff',
  gold: '#ffd700',
  goldenrod: '#daa520',
  gray: '#808080',
  green: '#008000',
  greenyellow: '#adff2f',
  grey: '#808080',
  honeydew: '#f0fff0',
  hotpink: '#ff69b4',
  indianred: '#cd5c5c',
  indigo: '#4b0082',
  ivory: '#fffff0',
  khaki: '#f0e68c',
  lavender: '#e6e6fa',
  lavenderblush: '#fff0f5',
  lawngreen: '#7cfc00',
  lemonchiffon: '#fffacd',
  lightblue: '#add8e6',
  lightcoral: '#f08080',
  lightcyan: '#e0ffff',
  lightgoldenrodyellow: '#fafad2',
  lightgray: '#d3d3d3',
  lightgreen: '#90ee90',
  lightgrey: '#d3d3d3',
  lightpink: '#ffb6c1',
  lightsalmon: '#ffa07a',
  lightseagreen: '#20b2aa',
  lightskyblue: '#87cefa',
  lightslategray: '#778899',
  lightslategrey: '#778899',
  lightsteelblue: '#b0c4de',
  lightyellow: '#ffffe0',
  lime: '#00ff00',
  limegreen: '#32cd32',
  linen: '#faf0e6',
  magenta: '#ff00ff',
  maroon: '#800000',
  mediumaquamarine: '#66cdaa',
  mediumblue: '#0000cd',
  mediumorchid: '#ba55d3',
  mediumpurple: '#9370db',
  mediumseagreen: '#3cb371',
  mediumslateblue: '#7b68ee',
  mediumspringgreen: '#00fa9a',
  mediumturquoise: '#48d1cc',
  mediumvioletred: '#c71585',
  midnightblue: '#191970',
  mintcream: '#f5fffa',
  mistyrose: '#ffe4e1',
  moccasin: '#ffe4b5',
  navajowhite: '#ffdead',
  navy: '#000080',
  oldlace: '#fdf5e6',
  olive: '#808000',
  olivedrab: '#6b8e23',
  orange: '#ffa500',
  orangered: '#ff4500',
  orchid: '#da70d6',
  palegoldenrod: '#eee8aa',
  palegreen: '#98fb98',
  paleturquoise: '#afeeee',
  palevioletred: '#db7093',
  papayawhip: '#ffefd5',
  peachpuff: '#ffdab9',
  peru: '#cd853f',
  pink: '#ffc0cb',
  plum: '#dda0dd',
  powderblue: '#b0e0e6',
  purple: '#800080',
  rebeccapurple: '#663399',
  red: '#ff0000',
  rosybrown: '#bc8f8f',
  royalblue: '#4169e1',
  saddlebrown: '#8b4513',
  salmon: '#fa8072',
  sandybrown: '#f4a460',
  seagreen: '#2e8b57',
  seashell: '#fff5ee',
  sienna: '#a0522d',
  silver: '#c0c0c0',
  skyblue: '#87ceeb',
  slateblue: '#6a5acd',
  slategray: '#708090',
  slategrey: '#708090',
  snow: '#fffafa',
  springgreen: '#00ff7f',
  steelblue: '#4682b4',
  tan: '#d2b48c',
  teal: '#008080',
  thistle: '#d8bfd8',
  tomato: '#ff6347',
  transparent: '#00000000',
  turquoise: '#40e0d0',
  violet: '#ee82ee',
  wheat: '#f5deb3',
  white: '#ffffff',
  whitesmoke: '#f5f5f5',
  yellow: '#ffff00',
  yellowgreen: '#9acd32',
};

export function parseCanvasKitCssColor(canvasKit: CanvasKit, color: string, opacity = 1): Float32Array {
  const parsed = parseSupportedCssColor(color);
  let rgba: ArrayLike<number> = parsed ?? [0, 0, 0, 1];
  if (!parsed) {
    try {
      rgba = canvasKit.parseColorString(color) as ArrayLike<number> | undefined ?? rgba;
    } catch {
      rgba = [0, 0, 0, 1];
    }
  }
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
    return parseHexColor(named);
  }
  const hex = parseHexColor(normalized);
  if (hex) {
    return hex;
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

function parseHexColor(color: string): [number, number, number, number] | null {
  const match = color.match(/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/);
  if (!match) {
    return null;
  }
  const hex = match[1];
  const components = hex.length <= 4
    ? [...hex].map((component) => Number.parseInt(`${component}${component}`, 16))
    : hex.match(/../g)?.map((component) => Number.parseInt(component, 16));
  if (!components || components.some((component) => !Number.isFinite(component))) {
    return null;
  }
  return [
    components[0] / 255,
    components[1] / 255,
    components[2] / 255,
    (components[3] ?? 255) / 255,
  ];
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
  const hue = parseCssHue(parts[0]);
  const saturation = parseCssPercent(parts[1]);
  const lightness = parseCssPercent(parts[2]);
  const alpha = parseCssAlpha(slashAlpha ?? parts[3] ?? '1');
  if (hue === null || saturation === null || lightness === null || alpha === null) {
    return null;
  }
  const [red, green, blue] = hslToRgb(hue, saturation, lightness);
  return [red, green, blue, alpha];
}

function parseCssHue(value: string): number | null {
  const trimmed = value.trim();
  const match = trimmed.match(/^([-+]?(?:\d+|\d*\.\d+))(deg|grad|rad|turn)?$/);
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) {
    return null;
  }
  switch (match[2]) {
    case undefined:
    case 'deg':
      return amount;
    case 'grad':
      return amount * 0.9;
    case 'rad':
      return amount * (180 / Math.PI);
    case 'turn':
      return amount * 360;
    default:
      return null;
  }
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
