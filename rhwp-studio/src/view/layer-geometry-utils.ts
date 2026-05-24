import type { LayerBounds, LayerPathCommand } from '@/core/types';

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

export function gradientStopPositions(
  colorCount: number,
  positions: readonly number[],
): number[] {
  if (colorCount <= 0) {
    return [];
  }

  if (positions.length > 0) {
    return Array.from({ length: colorCount }, (_, index) => positions[index] ?? 0);
  }

  if (colorCount === 1) {
    return [0];
  }

  return Array.from({ length: colorCount }, (_, index) => index / (colorCount - 1));
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
