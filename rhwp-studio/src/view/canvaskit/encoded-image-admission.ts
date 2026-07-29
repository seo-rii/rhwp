export const CANVASKIT_MAX_ENCODED_IMAGE_BASE64_BYTES = 24 * 1024 * 1024;
export const CANVASKIT_MAX_IMAGE_DIMENSION = 8192;
export const CANVASKIT_MAX_IMAGE_PIXELS = 32 * 1024 * 1024;
export const CANVASKIT_MAX_SVG_BYTES = 4 * 1024 * 1024;

export type CanvasKitEncodedImageFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'svg';

export type CanvasKitEncodedImageHeader = {
  format: CanvasKitEncodedImageFormat;
  width: number;
  height: number;
};

export function canvasKitEncodedImageHeader(
  bytes: Uint8Array,
): CanvasKitEncodedImageHeader | null {
  return parsePngHeader(bytes)
    ?? parseGifHeader(bytes)
    ?? parseWebpHeader(bytes)
    ?? parseBmpHeader(bytes)
    ?? parseJpegHeader(bytes)
    ?? parseSvgHeader(bytes);
}

export function canvasKitEncodedImageIsReplayable(bytes: Uint8Array): boolean {
  if (
    bytes.byteLength === 0
    || Math.ceil(bytes.byteLength / 3) * 4 > CANVASKIT_MAX_ENCODED_IMAGE_BASE64_BYTES
  ) {
    return false;
  }

  const header = canvasKitEncodedImageHeader(bytes);
  return header !== null
    && (header.format !== 'svg' || bytes.byteLength <= CANVASKIT_MAX_SVG_BYTES)
    && header.width <= CANVASKIT_MAX_IMAGE_DIMENSION
    && header.height <= CANVASKIT_MAX_IMAGE_DIMENSION
    && header.width * header.height <= CANVASKIT_MAX_IMAGE_PIXELS;
}

export function canvasKitEncodedImageHasStableFrame(
  bytes: Uint8Array,
  header: CanvasKitEncodedImageHeader | null = canvasKitEncodedImageHeader(bytes),
): boolean {
  if (!header) {
    return false;
  }
  if (header.format === 'gif') {
    return gifHasSingleFrame(bytes);
  }
  if (header.format === 'webp') {
    return webpHasSingleFrame(bytes);
  }
  return true;
}

type SvgIntrinsicLength =
  | { kind: 'missing' | 'relative' }
  | { kind: 'absolute'; value: number };

function parseSvgHeader(bytes: Uint8Array): CanvasKitEncodedImageHeader | null {
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  if (source.charCodeAt(0) === 0xfeff) {
    source = source.slice(1);
  }
  if (source.toLowerCase().includes('<!doctype')) {
    return null;
  }

  let cursor = 0;
  while (true) {
    cursor = skipXmlWhitespace(source, cursor);
    if (source.startsWith('<!--', cursor)) {
      const end = source.indexOf('-->', cursor + 4);
      if (end < 0) {
        return null;
      }
      cursor = end + 3;
      continue;
    }
    if (source.startsWith('<?', cursor)) {
      const end = source.indexOf('?>', cursor + 2);
      if (end < 0) {
        return null;
      }
      cursor = end + 2;
      continue;
    }
    break;
  }

  if (source[cursor] !== '<') {
    return null;
  }
  const tagEnd = findXmlStartTagEnd(source, cursor);
  if (tagEnd < 0) {
    return null;
  }
  const tag = source.slice(cursor + 1, tagEnd);
  const nameMatch = /^([A-Za-z_][A-Za-z0-9_.-]*:)?svg(?=\s|\/?$)/.exec(tag);
  if (nameMatch === null) {
    return null;
  }

  let width: SvgIntrinsicLength = { kind: 'missing' };
  let height: SvgIntrinsicLength = { kind: 'missing' };
  let viewBox: readonly [number, number] | null = null;
  const seen = new Set<string>();
  let attributeCursor = nameMatch[0].length;
  while (attributeCursor < tag.length) {
    attributeCursor = skipXmlWhitespace(tag, attributeCursor);
    if (attributeCursor >= tag.length || tag[attributeCursor] === '/') {
      break;
    }
    const attributeMatch = /^[A-Za-z_:][A-Za-z0-9_.:-]*/.exec(tag.slice(attributeCursor));
    if (attributeMatch === null) {
      return null;
    }
    const name = attributeMatch[0];
    attributeCursor += name.length;
    attributeCursor = skipXmlWhitespace(tag, attributeCursor);
    if (tag[attributeCursor] !== '=') {
      return null;
    }
    attributeCursor = skipXmlWhitespace(tag, attributeCursor + 1);
    const quote = tag[attributeCursor];
    if (quote !== '"' && quote !== "'") {
      return null;
    }
    const valueEnd = tag.indexOf(quote, attributeCursor + 1);
    if (valueEnd < 0) {
      return null;
    }
    const value = tag.slice(attributeCursor + 1, valueEnd);
    attributeCursor = valueEnd + 1;
    if (!['width', 'height', 'viewBox'].includes(name)) {
      continue;
    }
    if (seen.has(name)) {
      return null;
    }
    seen.add(name);
    if (name === 'width') {
      const parsed = parseSvgLength(value);
      if (parsed === null) {
        return null;
      }
      width = parsed;
    } else if (name === 'height') {
      const parsed = parseSvgLength(value);
      if (parsed === null) {
        return null;
      }
      height = parsed;
    } else {
      viewBox = parseSvgViewBox(value);
      if (viewBox === null) {
        return null;
      }
    }
  }

  const dimensions = resolveSvgDimensions(width, height, viewBox);
  return dimensions === null
    ? null
    : { format: 'svg', width: dimensions[0], height: dimensions[1] };
}

function skipXmlWhitespace(source: string, offset: number): number {
  while (offset < source.length && /[\t\n\r ]/.test(source[offset])) {
    offset += 1;
  }
  return offset;
}

function findXmlStartTagEnd(source: string, offset: number): number {
  let quote: '"' | "'" | null = null;
  for (let index = offset + 1; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
}

function parseSvgLength(value: string): SvgIntrinsicLength | null {
  const normalized = value.trim();
  if (normalized.toLowerCase() === 'auto') {
    return { kind: 'relative' };
  }
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(px|pt|pc|in|cm|mm|q|%)?$/i
    .exec(normalized);
  if (match === null) {
    return null;
  }
  const number = Number(match[1]);
  if (!Number.isFinite(number) || number <= 0) {
    return null;
  }
  const unit = match[2]?.toLowerCase();
  if (unit === '%') {
    return { kind: 'relative' };
  }
  const scale = unit === 'pt'
    ? 96 / 72
    : unit === 'pc'
      ? 16
      : unit === 'in'
        ? 96
        : unit === 'cm'
          ? 96 / 2.54
          : unit === 'mm'
            ? 96 / 25.4
            : unit === 'q'
              ? 96 / 101.6
              : 1;
  return { kind: 'absolute', value: number * scale };
}

function parseSvgViewBox(value: string): readonly [number, number] | null {
  const values = value.trim().split(/[\s,]+/).map(Number);
  if (
    values.length !== 4
    || values.some((entry) => !Number.isFinite(entry))
    || values[2] <= 0
    || values[3] <= 0
  ) {
    return null;
  }
  return [values[2], values[3]];
}

function resolveSvgDimensions(
  width: SvgIntrinsicLength,
  height: SvgIntrinsicLength,
  viewBox: readonly [number, number] | null,
): readonly [number, number] | null {
  const absoluteWidth = width.kind === 'absolute' ? width.value : null;
  const absoluteHeight = height.kind === 'absolute' ? height.value : null;
  let resolvedWidth: number;
  let resolvedHeight: number;
  if (absoluteWidth !== null && absoluteHeight !== null) {
    [resolvedWidth, resolvedHeight] = [absoluteWidth, absoluteHeight];
  } else if (absoluteWidth !== null && viewBox !== null) {
    resolvedWidth = absoluteWidth;
    resolvedHeight = absoluteWidth * viewBox[1] / viewBox[0];
  } else if (absoluteHeight !== null && viewBox !== null) {
    resolvedWidth = absoluteHeight * viewBox[0] / viewBox[1];
    resolvedHeight = absoluteHeight;
  } else if (viewBox !== null) {
    [resolvedWidth, resolvedHeight] = viewBox;
  } else {
    resolvedWidth = absoluteWidth ?? 300;
    resolvedHeight = absoluteHeight ?? 150;
  }
  const finiteWidth = finiteSvgDimension(resolvedWidth);
  const finiteHeight = finiteSvgDimension(resolvedHeight);
  return finiteWidth === null || finiteHeight === null
    ? null
    : [finiteWidth, finiteHeight];
}

function finiteSvgDimension(value: number): number | null {
  return Number.isFinite(value) && value > 0 && value <= 0xffffffff ? Math.ceil(value) : null;
}

function parsePngHeader(bytes: Uint8Array): CanvasKitEncodedImageHeader | null {
  if (
    bytes.byteLength < 33
    || !bytesEqual(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    || readUint32(bytes, 8, false) !== 13
    || !bytesEqual(bytes, 12, [0x49, 0x48, 0x44, 0x52])
  ) {
    return null;
  }

  const width = readUint32(bytes, 16, false);
  const height = readUint32(bytes, 20, false);
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  const validDepth = colorType === 0
    ? [1, 2, 4, 8, 16].includes(bitDepth)
    : [2, 4, 6].includes(colorType)
      ? [8, 16].includes(bitDepth)
      : colorType === 3 && [1, 2, 4, 8].includes(bitDepth);
  if (
    width === 0
    || height === 0
    || !validDepth
    || bytes[26] !== 0
    || bytes[27] !== 0
    || bytes[28] > 1
  ) {
    return null;
  }

  return { format: 'png', width, height };
}

function parseGifHeader(bytes: Uint8Array): CanvasKitEncodedImageHeader | null {
  if (
    bytes.byteLength < 13
    || (
      !bytesEqual(bytes, 0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61])
      && !bytesEqual(bytes, 0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
    )
  ) {
    return null;
  }

  const width = readUint16(bytes, 6, true);
  const height = readUint16(bytes, 8, true);
  if (width === 0 || height === 0) {
    return null;
  }

  const packed = bytes[10];
  if ((packed & 0x80) !== 0) {
    const colorCount = 1 << ((packed & 0x07) + 1);
    if (bytes.byteLength < 13 + colorCount * 3) {
      return null;
    }
  }

  return { format: 'gif', width, height };
}

function gifHasSingleFrame(bytes: Uint8Array): boolean {
  const header = parseGifHeader(bytes);
  if (!header) {
    return false;
  }

  let offset = 13;
  const packed = bytes[10];
  const hasGlobalColorTable = (packed & 0x80) !== 0;
  if (hasGlobalColorTable) {
    offset += (1 << ((packed & 0x07) + 1)) * 3;
  }
  let frameCount = 0;
  while (offset < bytes.byteLength) {
    const introducer = bytes[offset];
    offset += 1;
    if (introducer === 0x3b) {
      return frameCount === 1 && offset === bytes.byteLength;
    }
    if (introducer === 0x21) {
      if (offset >= bytes.byteLength) {
        return false;
      }
      offset += 1;
      const extensionEnd = skipGifSubBlocks(bytes, offset);
      if (extensionEnd === null) {
        return false;
      }
      offset = extensionEnd;
      continue;
    }
    if (introducer !== 0x2c || offset + 9 > bytes.byteLength) {
      return false;
    }

    const frameWidth = readUint16(bytes, offset + 4, true);
    const frameHeight = readUint16(bytes, offset + 6, true);
    const framePacked = bytes[offset + 8];
    if (frameWidth === 0 || frameHeight === 0) {
      return false;
    }
    offset += 9;
    const hasLocalColorTable = (framePacked & 0x80) !== 0;
    if (hasLocalColorTable) {
      offset += (1 << ((framePacked & 0x07) + 1)) * 3;
    }
    if (
      (!hasGlobalColorTable && !hasLocalColorTable)
      || offset >= bytes.byteLength
      || bytes[offset] < 2
      || bytes[offset] > 8
    ) {
      return false;
    }
    offset += 1;
    const imageEnd = skipGifSubBlocks(bytes, offset);
    if (imageEnd === null) {
      return false;
    }
    offset = imageEnd;
    frameCount += 1;
    if (frameCount > 1) {
      return false;
    }
  }
  return false;
}

function skipGifSubBlocks(bytes: Uint8Array, start: number): number | null {
  let offset = start;
  while (offset < bytes.byteLength) {
    const blockLength = bytes[offset];
    offset += 1;
    if (blockLength === 0) {
      return offset;
    }
    if (offset + blockLength > bytes.byteLength) {
      return null;
    }
    offset += blockLength;
  }
  return null;
}

function parseWebpHeader(bytes: Uint8Array): CanvasKitEncodedImageHeader | null {
  if (
    bytes.byteLength < 20
    || !bytesEqual(bytes, 0, [0x52, 0x49, 0x46, 0x46])
    || !bytesEqual(bytes, 8, [0x57, 0x45, 0x42, 0x50])
  ) {
    return null;
  }

  const riffEnd = readUint32(bytes, 4, true) + 8;
  const chunkLength = readUint32(bytes, 16, true);
  const chunkEnd = 20 + chunkLength + (chunkLength & 1);
  if (
    !Number.isSafeInteger(riffEnd)
    || !Number.isSafeInteger(chunkEnd)
    || riffEnd > bytes.byteLength
    || riffEnd < 20
    || chunkEnd > riffEnd
    || chunkEnd > bytes.byteLength
  ) {
    return null;
  }

  let width: number;
  let height: number;
  if (bytesEqual(bytes, 12, [0x56, 0x50, 0x38, 0x58]) && chunkLength >= 10) {
    width = readUint24Le(bytes, 24) + 1;
    height = readUint24Le(bytes, 27) + 1;
  } else if (
    bytesEqual(bytes, 12, [0x56, 0x50, 0x38, 0x20])
    && chunkLength >= 10
    && bytesEqual(bytes, 23, [0x9d, 0x01, 0x2a])
  ) {
    width = readUint16(bytes, 26, true) & 0x3fff;
    height = readUint16(bytes, 28, true) & 0x3fff;
  } else if (
    bytesEqual(bytes, 12, [0x56, 0x50, 0x38, 0x4c])
    && chunkLength >= 5
    && bytes[20] === 0x2f
  ) {
    const bits = readUint32(bytes, 21, true);
    width = (bits & 0x3fff) + 1;
    height = ((bits >>> 14) & 0x3fff) + 1;
  } else {
    return null;
  }

  return width > 0 && height > 0 ? { format: 'webp', width, height } : null;
}

function webpHasSingleFrame(bytes: Uint8Array): boolean {
  if (!parseWebpHeader(bytes)) {
    return false;
  }
  const riffEnd = readUint32(bytes, 4, true) + 8;
  if (riffEnd !== bytes.byteLength) {
    return false;
  }

  let offset = 12;
  let imageChunkCount = 0;
  while (offset < riffEnd) {
    if (offset + 8 > riffEnd) {
      return false;
    }
    const chunkLength = readUint32(bytes, offset + 4, true);
    const payloadStart = offset + 8;
    const chunkEnd = payloadStart + chunkLength;
    const paddedEnd = chunkEnd + (chunkLength & 1);
    if (
      !Number.isSafeInteger(chunkEnd)
      || !Number.isSafeInteger(paddedEnd)
      || chunkEnd > riffEnd
      || paddedEnd > riffEnd
    ) {
      return false;
    }

    if (bytesEqual(bytes, offset, [0x56, 0x50, 0x38, 0x58])) {
      if (chunkLength < 10 || (bytes[payloadStart] & 0x02) !== 0) {
        return false;
      }
    } else if (
      bytesEqual(bytes, offset, [0x41, 0x4e, 0x49, 0x4d])
      || bytesEqual(bytes, offset, [0x41, 0x4e, 0x4d, 0x46])
    ) {
      return false;
    } else if (
      bytesEqual(bytes, offset, [0x56, 0x50, 0x38, 0x20])
      || bytesEqual(bytes, offset, [0x56, 0x50, 0x38, 0x4c])
    ) {
      imageChunkCount += 1;
      if (imageChunkCount > 1) {
        return false;
      }
    }
    offset = paddedEnd;
  }
  return offset === riffEnd && imageChunkCount === 1;
}

function parseBmpHeader(bytes: Uint8Array): CanvasKitEncodedImageHeader | null {
  if (bytes.byteLength < 54 || !bytesEqual(bytes, 0, [0x42, 0x4d])) {
    return null;
  }

  const dibLength = readUint32(bytes, 14, true);
  const dibEnd = 14 + dibLength;
  const pixelOffset = readUint32(bytes, 10, true);
  const bitsPerPixel = readUint16(bytes, 28, true);
  if (
    dibLength < 40
    || dibEnd > bytes.byteLength
    || pixelOffset < dibEnd
    || readUint16(bytes, 26, true) !== 1
    || ![1, 4, 8, 16, 24, 32].includes(bitsPerPixel)
  ) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getInt32(18, true);
  const height = view.getInt32(22, true);
  if (width <= 0 || height === 0 || height === -0x80000000) {
    return null;
  }

  return { format: 'bmp', width, height: Math.abs(height) };
}

function parseJpegHeader(bytes: Uint8Array): CanvasKitEncodedImageHeader | null {
  if (bytes.byteLength < 4 || !bytesEqual(bytes, 0, [0xff, 0xd8])) {
    return null;
  }

  let offset = 2;
  while (offset < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      return null;
    }
    while (offset < bytes.byteLength && bytes[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= bytes.byteLength) {
      return null;
    }
    const marker = bytes[offset];
    offset += 1;

    if (marker === 0 || (marker >= 0xd8 && marker <= 0xda)) {
      return null;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (offset + 2 > bytes.byteLength) {
      return null;
    }

    const segmentLength = readUint16(bytes, offset, false);
    const segmentEnd = offset + segmentLength;
    if (segmentLength < 2 || segmentEnd > bytes.byteLength) {
      return null;
    }

    const isStartOfFrame = marker >= 0xc0
      && marker <= 0xcf
      && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isStartOfFrame) {
      if (segmentLength < 11 || offset + 8 > bytes.byteLength) {
        return null;
      }
      const componentCount = bytes[offset + 7];
      if (componentCount === 0 || segmentLength !== 8 + componentCount * 3) {
        return null;
      }
      const height = readUint16(bytes, offset + 3, false);
      const width = readUint16(bytes, offset + 5, false);
      return width > 0 && height > 0 ? { format: 'jpeg', width, height } : null;
    }

    offset = segmentEnd;
  }

  return null;
}

function readUint16(bytes: Uint8Array, offset: number, littleEndian: boolean): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint16(offset, littleEndian);
}

function readUint32(bytes: Uint8Array, offset: number, littleEndian: boolean): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint32(offset, littleEndian);
}

function readUint24Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function bytesEqual(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (offset < 0 || offset + expected.length > bytes.byteLength) {
    return false;
  }
  return expected.every((byte, index) => bytes[offset + index] === byte);
}
