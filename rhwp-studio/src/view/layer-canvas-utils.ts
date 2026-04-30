import type {
  LayerBounds,
  LayerEquationLayoutBox,
  LayerImageOp,
  LayerPathCommand,
  LayerPatternFill,
  LayerTextControlMark,
  LayerTextRunOp,
} from '@/core/types';

const EQUATION_SCRIPT_SCALE = 0.7;
const EQUATION_BIG_OP_SCALE = 1.5;

export type LayerCanvasImageSource = HTMLImageElement | HTMLCanvasElement;
export type LayerImageEffectCache = WeakMap<LayerCanvasImageSource, Map<string, HTMLCanvasElement>>;
export type LayerImageEffectSourceRect = { x: number; y: number; width: number; height: number };
export type LayerImageEffectDiagnostics = {
  cacheHits: number;
  cacheMisses: number;
  preprocessFailures: number;
  fallbackToOriginal: number;
  preprocessedPixels: number;
};

const ORDERED_DITHER_8X8 = [
  0, 48, 12, 60, 3, 51, 15, 63,
  32, 16, 44, 28, 35, 19, 47, 31,
  8, 56, 4, 52, 11, 59, 7, 55,
  40, 24, 36, 20, 43, 27, 39, 23,
  2, 50, 14, 62, 1, 49, 13, 61,
  34, 18, 46, 30, 33, 17, 45, 29,
  10, 58, 6, 54, 9, 57, 5, 53,
  42, 26, 38, 22, 41, 25, 37, 21,
] as const;

export function decodeBase64(base64: string): Uint8Array {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let idx = 0; idx < binary.length; idx += 1) {
    bytes[idx] = binary.charCodeAt(idx);
  }
  return bytes;
}

export function encodeBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return window.btoa(binary);
}

export function inferImageMime(bytes: Uint8Array): string {
  if (bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4E
    && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3
    && bytes[0] === 0xFF
    && bytes[1] === 0xD8
    && bytes[2] === 0xFF) {
    return 'image/jpeg';
  }
  if (bytes.length >= 6
    && bytes[0] === 0x47
    && bytes[1] === 0x49
    && bytes[2] === 0x46) {
    return 'image/gif';
  }
  if (bytes.length >= 2
    && bytes[0] === 0x42
    && bytes[1] === 0x4D) {
    return 'image/bmp';
  }
  if (bytes.length >= 12
    && bytes[0] === 0x52
    && bytes[1] === 0x49
    && bytes[2] === 0x46
    && bytes[8] === 0x57
    && bytes[9] === 0x45
    && bytes[10] === 0x42
    && bytes[11] === 0x50) {
    return 'image/webp';
  }
  return 'image/png';
}

export function layerCanvasImageSourceSize(image: LayerCanvasImageSource): { width: number; height: number } {
  if ('naturalWidth' in image) {
    return {
      width: image.naturalWidth || image.width,
      height: image.naturalHeight || image.height,
    };
  }
  return {
    width: image.width,
    height: image.height,
  };
}

export function resolveLayerImageCropSource(
  imageWidth: number,
  imageHeight: number,
  crop?: LayerImageOp['crop'],
): LayerImageEffectSourceRect | null {
  if (!crop) {
    return null;
  }
  if (
    !Number.isFinite(imageWidth)
    || !Number.isFinite(imageHeight)
    || imageWidth <= 0
    || imageHeight <= 0
    || !Number.isFinite(crop.left)
    || !Number.isFinite(crop.top)
    || !Number.isFinite(crop.right)
    || !Number.isFinite(crop.bottom)
  ) {
    return null;
  }

  const scaleX = crop.right / imageWidth;
  const scaleY = crop.bottom / imageHeight;
  if (scaleX <= 0 || scaleY <= 0) {
    return null;
  }

  const srcX = crop.left / scaleX;
  const srcY = crop.top / scaleY;
  const srcW = (crop.right - crop.left) / scaleX;
  const srcH = (crop.bottom - crop.top) / scaleY;
  const isCropped = srcX > 0.5
    || srcY > 0.5
    || Math.abs(srcW - imageWidth) > 1
    || Math.abs(srcH - imageHeight) > 1;

  return isCropped && srcW > 0 && srcH > 0
    ? { x: srcX, y: srcY, width: srcW, height: srcH }
    : null;
}

export function canPreprocessCroppedLayerImageEffect(fillMode = 'fitToSize'): boolean {
  return fillMode === 'fitToSize' || fillMode === 'none';
}

function imageEffectCacheKey(effect: NonNullable<LayerImageOp['effect']>, sourceRect?: LayerImageEffectSourceRect | null): string {
  if (!sourceRect) {
    return effect;
  }
  return [
    effect,
    'src',
    sourceRect.x.toFixed(3),
    sourceRect.y.toFixed(3),
    sourceRect.width.toFixed(3),
    sourceRect.height.toFixed(3),
  ].join(':');
}

export function applyLayerImageEffect(
  image: LayerCanvasImageSource,
  effect: LayerImageOp['effect'] | undefined,
  cache?: LayerImageEffectCache,
  diagnostics?: LayerImageEffectDiagnostics,
  sourceRect?: LayerImageEffectSourceRect | null,
): LayerCanvasImageSource {
  if (!effect || effect === 'realPic') {
    return image;
  }

  const { width, height } = layerCanvasImageSourceSize(image);
  if (
    !Number.isFinite(width)
    || !Number.isFinite(height)
    || width <= 0
    || height <= 0
  ) {
    if (diagnostics) {
      diagnostics.preprocessFailures += 1;
      diagnostics.fallbackToOriginal += 1;
    }
    return image;
  }

  const sx = sourceRect?.x ?? 0;
  const sy = sourceRect?.y ?? 0;
  const sw = sourceRect?.width ?? width;
  const sh = sourceRect?.height ?? height;
  if (
    !Number.isFinite(sx)
    || !Number.isFinite(sy)
    || !Number.isFinite(sw)
    || !Number.isFinite(sh)
    || sw <= 0
    || sh <= 0
  ) {
    if (diagnostics) {
      diagnostics.preprocessFailures += 1;
      diagnostics.fallbackToOriginal += 1;
    }
    return image;
  }

  const canvasWidth = Math.max(1, Math.round(sw));
  const canvasHeight = Math.max(1, Math.round(sh));
  const cacheKey = imageEffectCacheKey(effect, sourceRect);
  const cachedByEffect = cache?.get(image);
  const cached = cachedByEffect?.get(cacheKey);
  if (cached && cached.width === canvasWidth && cached.height === canvasHeight) {
    if (diagnostics) {
      diagnostics.cacheHits += 1;
    }
    return cached;
  }
  if (diagnostics) {
    diagnostics.cacheMisses += 1;
  }

  const canvas = document.createElement('canvas');
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    if (diagnostics) {
      diagnostics.preprocessFailures += 1;
      diagnostics.fallbackToOriginal += 1;
    }
    return image;
  }

  let pixels: ImageData;
  try {
    ctx.drawImage(image, sx, sy, sw, sh, 0, 0, canvasWidth, canvasHeight);
    pixels = ctx.getImageData(0, 0, canvasWidth, canvasHeight);
  } catch {
    if (diagnostics) {
      diagnostics.preprocessFailures += 1;
      diagnostics.fallbackToOriginal += 1;
    }
    return image;
  }

  const data = pixels.data;
  for (let index = 0; index < data.length; index += 4) {
    const luma = Math.round(data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114);
    let value = luma;
    if (effect === 'blackWhite') {
      value = luma >= 128 ? 255 : 0;
    } else if (effect === 'pattern8x8') {
      const pixel = index / 4;
      const x = pixel % canvasWidth;
      const y = Math.floor(pixel / canvasWidth);
      const threshold = Math.round(((ORDERED_DITHER_8X8[(y & 7) * 8 + (x & 7)] + 0.5) * 255) / 64);
      value = luma > threshold ? 255 : 0;
    }
    data[index] = value;
    data[index + 1] = value;
    data[index + 2] = value;
  }
  ctx.putImageData(pixels, 0, 0);
  if (diagnostics) {
    diagnostics.preprocessedPixels += canvasWidth * canvasHeight;
  }

  if (cache) {
    const nextByEffect = cachedByEffect ?? new Map<string, HTMLCanvasElement>();
    nextByEffect.set(cacheKey, canvas);
    if (!cachedByEffect) {
      cache.set(image, nextByEffect);
    }
  }

  return canvas;
}

export function buildCanvasTextFont(
  fontFamily: string,
  fontSize: number,
  bold: boolean,
  italic: boolean,
): string {
  const baseFamily = fontFamily?.trim() ?? '';
  const lower = baseFamily.toLowerCase();
  const fallback = !baseFamily
    ? `'Malgun Gothic','맑은 고딕','Apple SD Gothic Neo','Noto Sans CJK KR','NanumGothic','나눔고딕','Noto Sans KR','Pretendard',sans-serif`
    : /굴림체|바탕체|gulimche|batangche|coding|courier/i.test(baseFamily)
      ? `'GulimChe','굴림체','D2Coding','NanumGothicCoding','나눔고딕코딩','Noto Sans Mono',monospace`
      : /바탕|명조|궁서/.test(baseFamily) || /times|hymjre|palatino|georgia|batang|gungsuh/i.test(lower)
        ? `'Batang','바탕','AppleMyungjo','Noto Serif CJK KR','NanumMyeongjo','나눔명조','Noto Serif KR',serif`
        : `'Malgun Gothic','맑은 고딕','Apple SD Gothic Neo','Noto Sans CJK KR','NanumGothic','나눔고딕','Noto Sans KR','Pretendard',sans-serif`;
  const family = baseFamily ? `"${baseFamily}", ${fallback}` : fallback;
  return `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${(fontSize || 12).toFixed(3)}px ${family}`;
}

export function startsWithInvalidControl(text: string): boolean {
  if (!text) {
    return false;
  }
  const code = text.codePointAt(0) ?? 0;
  return code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
}

export function isHalfwidthScaledCluster(text: string): boolean {
  const code = text.codePointAt(0) ?? 0;
  return (code >= 0x2018 && code <= 0x2027) || code === 0x00b7;
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

export function puaToDisplayText(ch: string): string | null {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp >= 0xF02B1 && cp <= 0xF02C4) {
    return String(cp - 0xF02B0);
  }
  if (cp >= 0xF02CE && cp <= 0xF02E1) {
    return String(cp - 0xF02CD);
  }
  return null;
}

export function drawCanvas2DCharOverlap(
  ctx: CanvasRenderingContext2D,
  op: LayerTextRunOp,
  originX: number,
  originY: number,
): void {
  if (!op.charOverlap) {
    return;
  }
  const chars = Array.from(op.text);
  if (!chars.length) {
    return;
  }

  const fontSize = op.style.fontSize || 12;
  const decodedNumber = decodePuaOverlapNumber(chars);
  const sizeRatio = op.charOverlap.innerCharSize > 0
    ? op.charOverlap.innerCharSize / 100
    : 1;
  const innerFontSize = fontSize * sizeRatio;
  const font = buildCanvasTextFont(
    op.style.fontFamily,
    innerFontSize,
    op.style.bold,
    op.style.italic,
  );
  const boxSize = fontSize;
  const bboxY = originY - op.baseline;
  const cy = bboxY + op.bbox.height - boxSize / 2;

  const drawOverlapCell = (display: string, cx: number, targetTextWidth?: number) => {
    const borderType = targetTextWidth !== undefined && op.charOverlap?.borderType === 0
      ? 1
      : op.charOverlap?.borderType ?? 0;
    const isReversed = borderType === 2 || borderType === 4;
    const isCircle = borderType === 1 || borderType === 2;
    const isRect = borderType === 3 || borderType === 4;

    if (isCircle) {
      ctx.beginPath();
      ctx.arc(cx, cy, boxSize / 2, 0, Math.PI * 2);
      if (isReversed) {
        ctx.fillStyle = '#000000';
        ctx.fill();
      }
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    } else if (isRect) {
      const rx = cx - boxSize / 2;
      const ry = cy - boxSize / 2;
      if (isReversed) {
        ctx.fillStyle = '#000000';
        ctx.fillRect(rx, ry, boxSize, boxSize);
      }
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 0.8;
      ctx.strokeRect(rx, ry, boxSize, boxSize);
    }

    ctx.font = font;
    ctx.fillStyle = isReversed ? '#FFFFFF' : op.style.color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const scaleX = targetTextWidth !== undefined && targetTextWidth > 1
      ? Math.min(1, targetTextWidth / Math.max(ctx.measureText(display).width, 1))
      : 1;
    const textY = targetTextWidth !== undefined ? cy - fontSize * 0.08 : cy;
    if (scaleX < 1) {
      ctx.save();
      ctx.translate(cx, textY);
      ctx.scale(scaleX, 1);
      ctx.fillText(display, 0, 0);
      ctx.restore();
    } else {
      ctx.fillText(display, cx, textY);
    }
  };

  ctx.save();
  if (decodedNumber !== null) {
    drawOverlapCell(decodedNumber, originX + boxSize / 2, boxSize * 0.9);
  } else {
    const charAdvance = chars.length > 1 ? op.bbox.width / chars.length : boxSize;
    chars.forEach((ch, index) => {
      const cp = ch.codePointAt(0) ?? 0;
      const display = cp >= 0x2460 && cp <= 0x2473
        ? String(cp - 0x2460 + 1)
        : puaToDisplayText(ch) ?? ch;
      drawOverlapCell(display, originX + index * charAdvance + boxSize / 2);
    });
  }
  ctx.restore();
}

export function angleToCanvasCoords(
  angle: number,
  x: number,
  y: number,
  width: number,
  height: number,
): [number, number, number, number] {
  const normalized = ((angle % 360) + 360) % 360;
  switch (normalized) {
    case 0:
      return [x, y, x, y + height];
    case 45:
      return [x, y, x + width, y + height];
    case 90:
      return [x, y, x + width, y];
    case 135:
      return [x, y + height, x + width, y];
    case 180:
      return [x, y + height, x, y];
    case 225:
      return [x + width, y + height, x, y];
    case 270:
      return [x + width, y, x, y];
    case 315:
      return [x + width, y, x, y + height];
    default: {
      const radians = normalized * (Math.PI / 180);
      const sin = Math.sin(radians);
      const cos = Math.cos(radians);
      const centerX = x + width / 2;
      const centerY = y + height / 2;
      return [
        centerX - sin * width / 2,
        centerY - cos * height / 2,
        centerX + sin * width / 2,
        centerY + cos * height / 2,
      ];
    }
  }
}

export function createPatternTileCanvas(pattern: LayerPatternFill): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 6;
  canvas.height = 6;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return canvas;
  }

  ctx.fillStyle = pattern.backgroundColor;
  ctx.fillRect(0, 0, 6, 6);
  ctx.strokeStyle = pattern.patternColor;
  ctx.lineWidth = 1;

  switch (pattern.patternType) {
    case 0:
      ctx.beginPath();
      ctx.moveTo(0, 3);
      ctx.lineTo(6, 3);
      ctx.stroke();
      break;
    case 1:
      ctx.beginPath();
      ctx.moveTo(3, 0);
      ctx.lineTo(3, 6);
      ctx.stroke();
      break;
    case 2:
      ctx.beginPath();
      ctx.moveTo(6, 0);
      ctx.lineTo(0, 6);
      ctx.stroke();
      break;
    case 3:
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(6, 6);
      ctx.stroke();
      break;
    case 4:
      ctx.beginPath();
      ctx.moveTo(3, 0);
      ctx.lineTo(3, 6);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, 3);
      ctx.lineTo(6, 3);
      ctx.stroke();
      break;
    case 5:
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(6, 6);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(6, 0);
      ctx.lineTo(0, 6);
      ctx.stroke();
      break;
    default:
      break;
  }

  return canvas;
}

export function rasterizePatternTileToPngBytes(pattern: LayerPatternFill): Uint8Array | null {
  const canvas = createPatternTileCanvas(pattern);
  const dataUrl = canvas.toDataURL('image/png');
  const [, encoded = ''] = dataUrl.split(',');
  return decodeBase64(encoded);
}

export function computePathPaintBounds(
  commands: LayerPathCommand[],
  fallback: LayerBounds,
): LayerBounds {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  const record = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };

  for (const command of commands) {
    switch (command.type) {
      case 'moveTo':
      case 'lineTo':
        record(command.x, command.y);
        break;
      case 'curveTo':
        record(command.x1, command.y1);
        record(command.x2, command.y2);
        record(command.x3, command.y3);
        break;
      case 'arcTo':
        record(command.x, command.y);
        break;
      case 'closePath':
        break;
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return fallback;
  }

  return {
    x: minX,
    y: minY,
    width: Math.max(maxX - minX, 1),
    height: Math.max(maxY - minY, 1),
  };
}

export function calculateArrowDimensions(
  strokeWidth: number,
  lineLength: number,
  arrowSize: number,
): [number, number] {
  const widthLevel = Math.floor(arrowSize / 3);
  const lengthLevel = arrowSize % 3;
  const widthMultiplier = widthLevel === 0 ? 1.5 : widthLevel === 1 ? 2.5 : 3.5;
  const lengthMultiplier = lengthLevel === 0 ? 1 : lengthLevel === 1 ? 1.5 : 2;
  const arrowHeight = Math.max(strokeWidth * widthMultiplier, 3);
  const arrowWidth = Math.min(arrowHeight * lengthMultiplier, lineLength * 0.3);
  return [arrowWidth, arrowHeight];
}

export function renderEquationLayoutBox(
  ctx: CanvasRenderingContext2D,
  layout: LayerEquationLayoutBox,
  parentX: number,
  parentY: number,
  color: string,
  fontSize: number,
  italic: boolean,
  bold: boolean,
): void {
  const x = parentX + layout.x;
  const y = parentY + layout.y;

  switch (layout.kind.type) {
    case 'row':
      for (const child of layout.kind.children) {
        renderEquationLayoutBox(ctx, child, x, y, color, fontSize, italic, bold);
      }
      return;
    case 'text': {
      const size = equationFontSizeFromBox(layout, fontSize);
      setEquationFont(ctx, size, true, bold);
      ctx.fillStyle = color;
      ctx.fillText(layout.kind.text, x, y + layout.baseline);
      return;
    }
    case 'number': {
      const size = equationFontSizeFromBox(layout, fontSize);
      setEquationFont(ctx, size, false, bold);
      ctx.fillStyle = color;
      ctx.fillText(layout.kind.text, x, y + layout.baseline);
      return;
    }
    case 'symbol': {
      const size = equationFontSizeFromBox(layout, fontSize);
      setEquationFont(ctx, size, false, false);
      ctx.fillStyle = color;
      ctx.save();
      ctx.textAlign = 'center';
      ctx.fillText(layout.kind.text, x + layout.width / 2, y + layout.baseline);
      ctx.restore();
      return;
    }
    case 'mathSymbol': {
      const size = equationFontSizeFromBox(layout, fontSize);
      setEquationFont(ctx, size, false, false);
      ctx.fillStyle = color;
      ctx.fillText(layout.kind.text, x, y + layout.baseline);
      return;
    }
    case 'function': {
      const size = equationFontSizeFromBox(layout, fontSize);
      setEquationFont(ctx, size, false, false);
      ctx.fillStyle = color;
      ctx.fillText(layout.kind.name, x, y + layout.baseline);
      return;
    }
    case 'fraction':
      renderEquationLayoutBox(ctx, layout.kind.numer, x, y, color, fontSize, italic, bold);
      ctx.strokeStyle = color;
      ctx.lineWidth = fontSize * 0.04;
      ctx.beginPath();
      ctx.moveTo(x + fontSize * 0.05, y + layout.baseline);
      ctx.lineTo(x + layout.width - fontSize * 0.05, y + layout.baseline);
      ctx.stroke();
      renderEquationLayoutBox(ctx, layout.kind.denom, x, y, color, fontSize, italic, bold);
      return;
    case 'sqrt': {
      const bodyLeft = x + layout.kind.body.x - fontSize * 0.1;
      const signHeight = layout.height;
      const midX = bodyLeft - fontSize * 0.15;
      const midY = y + signHeight;
      const startX = midX - fontSize * 0.3;
      const startY = y + signHeight * 0.6;
      const tickX = startX - fontSize * 0.1;
      const tickY = startY - fontSize * 0.05;

      ctx.strokeStyle = color;
      ctx.lineWidth = fontSize * 0.04;
      ctx.beginPath();
      ctx.moveTo(tickX, tickY);
      ctx.lineTo(startX, startY);
      ctx.lineTo(midX, midY);
      ctx.lineTo(bodyLeft, y);
      ctx.lineTo(x + layout.width, y);
      ctx.stroke();

      if (layout.kind.index) {
        renderEquationLayoutBox(
          ctx,
          layout.kind.index,
          x,
          y,
          color,
          fontSize * EQUATION_SCRIPT_SCALE,
          false,
          false,
        );
      }
      renderEquationLayoutBox(ctx, layout.kind.body, x, y, color, fontSize, italic, bold);
      return;
    }
    case 'superscript':
      renderEquationLayoutBox(ctx, layout.kind.base, x, y, color, fontSize, italic, bold);
      renderEquationLayoutBox(
        ctx,
        layout.kind.sup,
        x,
        y,
        color,
        fontSize * EQUATION_SCRIPT_SCALE,
        italic,
        bold,
      );
      return;
    case 'subscript':
      renderEquationLayoutBox(ctx, layout.kind.base, x, y, color, fontSize, italic, bold);
      renderEquationLayoutBox(
        ctx,
        layout.kind.sub,
        x,
        y,
        color,
        fontSize * EQUATION_SCRIPT_SCALE,
        italic,
        bold,
      );
      return;
    case 'subSup':
      renderEquationLayoutBox(ctx, layout.kind.base, x, y, color, fontSize, italic, bold);
      renderEquationLayoutBox(
        ctx,
        layout.kind.sub,
        x,
        y,
        color,
        fontSize * EQUATION_SCRIPT_SCALE,
        italic,
        bold,
      );
      renderEquationLayoutBox(
        ctx,
        layout.kind.sup,
        x,
        y,
        color,
        fontSize * EQUATION_SCRIPT_SCALE,
        italic,
        bold,
      );
      return;
    case 'bigOp': {
      const opFontSize = fontSize * EQUATION_BIG_OP_SCALE;
      const supHeight = layout.kind.sup ? layout.kind.sup.height + fontSize * 0.05 : 0;
      const opX = x + (layout.width - estimateEquationOperatorWidth(layout.kind.symbol, opFontSize)) / 2;
      const opY = y + supHeight + opFontSize * 0.8;
      setEquationFont(ctx, opFontSize, false, false);
      ctx.fillStyle = color;
      ctx.fillText(layout.kind.symbol, opX, opY);
      if (layout.kind.sup) {
        renderEquationLayoutBox(
          ctx,
          layout.kind.sup,
          x,
          y,
          color,
          fontSize * EQUATION_SCRIPT_SCALE,
          false,
          false,
        );
      }
      if (layout.kind.sub) {
        renderEquationLayoutBox(
          ctx,
          layout.kind.sub,
          x,
          y,
          color,
          fontSize * EQUATION_SCRIPT_SCALE,
          false,
          false,
        );
      }
      return;
    }
    case 'limit': {
      const name = layout.kind.isUpper ? 'Lim' : 'lim';
      const size = equationFontSizeFromBox(layout, fontSize);
      setEquationFont(ctx, size, false, false);
      ctx.fillStyle = color;
      ctx.fillText(name, x, y + size * 0.8);
      if (layout.kind.sub) {
        renderEquationLayoutBox(
          ctx,
          layout.kind.sub,
          x,
          y,
          color,
          fontSize * EQUATION_SCRIPT_SCALE,
          false,
          false,
        );
      }
      return;
    }
    case 'matrix': {
      const brackets = layout.kind.style === 'paren' ? ['(', ')']
        : layout.kind.style === 'bracket' ? ['[', ']']
          : layout.kind.style === 'vert' ? ['|', '|']
            : ['', ''];
      if (brackets[0]) {
        drawEquationStretchBracket(ctx, brackets[0], x, y, fontSize * 0.3, layout.height, color, fontSize);
        drawEquationStretchBracket(ctx, brackets[1], x + layout.width - fontSize * 0.3, y, fontSize * 0.3, layout.height, color, fontSize);
      }
      for (const row of layout.kind.cells) {
        for (const cell of row) {
          renderEquationLayoutBox(ctx, cell, x, y, color, fontSize, italic, bold);
        }
      }
      return;
    }
    case 'rel':
      renderEquationLayoutBox(ctx, layout.kind.over, x, y, color, fontSize, italic, bold);
      renderEquationLayoutBox(ctx, layout.kind.arrow, x, y, color, fontSize, italic, bold);
      if (layout.kind.under) {
        renderEquationLayoutBox(ctx, layout.kind.under, x, y, color, fontSize, italic, bold);
      }
      return;
    case 'eqAlign':
      for (const row of layout.kind.rows) {
        renderEquationLayoutBox(ctx, row.left, x, y, color, fontSize, italic, bold);
        renderEquationLayoutBox(ctx, row.right, x, y, color, fontSize, italic, bold);
      }
      return;
    case 'paren':
      if (layout.kind.left) {
        drawEquationStretchBracket(ctx, layout.kind.left, x, y, fontSize * 0.3, layout.height, color, fontSize);
      }
      renderEquationLayoutBox(ctx, layout.kind.body, x, y, color, fontSize, italic, bold);
      if (layout.kind.right) {
        drawEquationStretchBracket(
          ctx,
          layout.kind.right,
          x + layout.width - fontSize * 0.3,
          y,
          fontSize * 0.3,
          layout.height,
          color,
          fontSize,
        );
      }
      return;
    case 'decoration':
      renderEquationLayoutBox(ctx, layout.kind.body, x, y, color, fontSize, italic, bold);
      drawEquationDecoration(
        ctx,
        layout.kind.decoration,
        x + layout.kind.body.x + layout.kind.body.width / 2,
        y + fontSize * 0.05,
        layout.kind.body.width,
        color,
        fontSize,
      );
      return;
    case 'fontStyle': {
      const nextItalic = layout.kind.fontStyle === 'roman' ? false : layout.kind.fontStyle === 'italic' ? true : italic;
      const nextBold = layout.kind.fontStyle === 'roman' ? false : layout.kind.fontStyle === 'bold' ? true : bold;
      renderEquationLayoutBox(ctx, layout.kind.body, x, y, color, fontSize, nextItalic, nextBold);
      return;
    }
    case 'space':
    case 'newline':
    case 'empty':
      return;
  }
}

export function splitIntoClusters(text: string): Array<{ start: number; text: string }> {
  const chars = Array.from(text);
  const clusters: Array<{ start: number; text: string }> = [];

  let idx = 0;
  while (idx < chars.length) {
    if (isHangulChoseong(chars[idx])) {
      const start = idx;
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
      clusters.push({ start, text: cluster });
      continue;
    }

    clusters.push({ start: idx, text: chars[idx] });
    idx += 1;
  }

  return clusters;
}

function equationFontSizeFromBox(
  layout: LayerEquationLayoutBox,
  baseFontSize: number,
): number {
  return layout.height > 0 ? layout.height : baseFontSize;
}

function estimateEquationOperatorWidth(text: string, fontSize: number): number {
  return Array.from(text).length * fontSize * 0.6;
}

function setEquationFont(
  ctx: CanvasRenderingContext2D,
  size: number,
  italic: boolean,
  bold: boolean,
): void {
  const style = italic ? 'italic ' : '';
  const weight = bold ? 'bold ' : '';
  ctx.font = `${style}${weight}${size.toFixed(1)}px 'Latin Modern Math', 'STIX Two Math', 'Cambria Math', 'Pretendard', serif`;
}

function drawEquationStretchBracket(
  ctx: CanvasRenderingContext2D,
  bracket: string,
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
  fontSize: number,
): void {
  const midX = x + width / 2;
  ctx.strokeStyle = color;
  ctx.lineWidth = fontSize * 0.04;

  switch (bracket) {
    case '(':
      ctx.beginPath();
      ctx.moveTo(midX + width * 0.2, y);
      ctx.quadraticCurveTo(x, y + height / 2, midX + width * 0.2, y + height);
      ctx.stroke();
      return;
    case ')':
      ctx.beginPath();
      ctx.moveTo(midX - width * 0.2, y);
      ctx.quadraticCurveTo(x + width, y + height / 2, midX - width * 0.2, y + height);
      ctx.stroke();
      return;
    case '[':
      ctx.beginPath();
      ctx.moveTo(midX + width * 0.2, y);
      ctx.lineTo(midX - width * 0.2, y);
      ctx.lineTo(midX - width * 0.2, y + height);
      ctx.lineTo(midX + width * 0.2, y + height);
      ctx.stroke();
      return;
    case ']':
      ctx.beginPath();
      ctx.moveTo(midX - width * 0.2, y);
      ctx.lineTo(midX + width * 0.2, y);
      ctx.lineTo(midX + width * 0.2, y + height);
      ctx.lineTo(midX - width * 0.2, y + height);
      ctx.stroke();
      return;
    case '{': {
      const quarterHeight = height / 4;
      ctx.beginPath();
      ctx.moveTo(midX + width * 0.2, y);
      ctx.quadraticCurveTo(midX - width * 0.1, y, midX - width * 0.1, y + quarterHeight);
      ctx.quadraticCurveTo(midX - width * 0.1, y + quarterHeight * 2, midX - width * 0.3, y + quarterHeight * 2);
      ctx.quadraticCurveTo(midX - width * 0.1, y + quarterHeight * 2, midX - width * 0.1, y + quarterHeight * 3);
      ctx.quadraticCurveTo(midX - width * 0.1, y + height, midX + width * 0.2, y + height);
      ctx.stroke();
      return;
    }
    case '}': {
      const quarterHeight = height / 4;
      ctx.beginPath();
      ctx.moveTo(midX - width * 0.2, y);
      ctx.quadraticCurveTo(midX + width * 0.1, y, midX + width * 0.1, y + quarterHeight);
      ctx.quadraticCurveTo(midX + width * 0.1, y + quarterHeight * 2, midX + width * 0.3, y + quarterHeight * 2);
      ctx.quadraticCurveTo(midX + width * 0.1, y + quarterHeight * 2, midX + width * 0.1, y + quarterHeight * 3);
      ctx.quadraticCurveTo(midX + width * 0.1, y + height, midX - width * 0.2, y + height);
      ctx.stroke();
      return;
    }
    case '|':
      ctx.beginPath();
      ctx.moveTo(midX, y);
      ctx.lineTo(midX, y + height);
      ctx.stroke();
      return;
    default:
      setEquationFont(ctx, height, false, false);
      ctx.fillStyle = color;
      ctx.save();
      ctx.textAlign = 'center';
      ctx.fillText(bracket, midX, y + height * 0.7);
      ctx.restore();
  }
}

function drawEquationDecoration(
  ctx: CanvasRenderingContext2D,
  decoration: string,
  midX: number,
  y: number,
  width: number,
  color: string,
  fontSize: number,
): void {
  const strokeWidth = fontSize * 0.03;
  const halfWidth = width / 2;
  ctx.strokeStyle = color;
  ctx.lineWidth = strokeWidth;

  switch (decoration) {
    case 'hat':
      ctx.beginPath();
      ctx.moveTo(midX - halfWidth * 0.6, y + fontSize * 0.15);
      ctx.lineTo(midX, y);
      ctx.lineTo(midX + halfWidth * 0.6, y + fontSize * 0.15);
      ctx.stroke();
      return;
    case 'bar':
    case 'overline':
      ctx.beginPath();
      ctx.moveTo(midX - halfWidth, y + fontSize * 0.05);
      ctx.lineTo(midX + halfWidth, y + fontSize * 0.05);
      ctx.stroke();
      return;
    case 'vec': {
      const arrowY = y + fontSize * 0.05;
      ctx.beginPath();
      ctx.moveTo(midX - halfWidth, arrowY);
      ctx.lineTo(midX + halfWidth, arrowY);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(midX + halfWidth - fontSize * 0.1, arrowY - fontSize * 0.06);
      ctx.lineTo(midX + halfWidth, arrowY);
      ctx.lineTo(midX + halfWidth - fontSize * 0.1, arrowY + fontSize * 0.06);
      ctx.stroke();
      return;
    }
    case 'tilde': {
      const tildeY = y + fontSize * 0.08;
      ctx.beginPath();
      ctx.moveTo(midX - halfWidth * 0.6, tildeY);
      ctx.quadraticCurveTo(midX - halfWidth * 0.2, tildeY - fontSize * 0.08, midX, tildeY);
      ctx.quadraticCurveTo(midX + halfWidth * 0.2, tildeY + fontSize * 0.08, midX + halfWidth * 0.6, tildeY);
      ctx.stroke();
      return;
    }
    case 'dot':
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(midX, y + fontSize * 0.06, fontSize * 0.03, 0, Math.PI * 2);
      ctx.fill();
      return;
    case 'dDot': {
      const gap = fontSize * 0.1;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(midX - gap, y + fontSize * 0.06, fontSize * 0.03, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(midX + gap, y + fontSize * 0.06, fontSize * 0.03, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    case 'underline':
    case 'under': {
      const underlineY = y + fontSize * 1.1;
      ctx.beginPath();
      ctx.moveTo(midX - halfWidth, underlineY);
      ctx.lineTo(midX + halfWidth, underlineY);
      ctx.stroke();
      return;
    }
    default:
      ctx.beginPath();
      ctx.moveTo(midX - halfWidth * 0.5, y + fontSize * 0.1);
      ctx.lineTo(midX + halfWidth * 0.5, y + fontSize * 0.1);
      ctx.stroke();
  }
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
