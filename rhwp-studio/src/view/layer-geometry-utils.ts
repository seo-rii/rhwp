import type { LayerBounds, LayerPathCommand, LayerTransform } from '@/core/types';

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

export function gradientColorStops<T>(
  colors: readonly T[],
  positions: readonly number[],
): Array<{ color: T; position: number }> {
  const stopPositions = gradientStopPositions(colors.length, positions);
  return colors
    .map((color, index) => ({
      color,
      position: stopPositions[index],
      index,
    }))
    .sort((left, right) => left.position - right.position || left.index - right.index)
    .map(({ color, position }) => ({ color, position }));
}

export function effectiveLayerImageBounds(
  bbox: LayerBounds,
  transform: LayerTransform,
): LayerBounds {
  const rotation = ((transform.rotation % 360) + 360) % 360;
  const isPerpendicular = Math.abs(rotation - 90) < 1 || Math.abs(rotation - 270) < 1;
  if (!isPerpendicular) {
    return bbox;
  }
  const cx = bbox.x + bbox.width / 2;
  const cy = bbox.y + bbox.height / 2;
  return {
    x: cx - bbox.height / 2,
    y: cy - bbox.width / 2,
    width: bbox.height,
    height: bbox.width,
  };
}

export function resolveImagePlacement(
  fillMode: string,
  bbox: LayerBounds,
  imageWidth: number,
  imageHeight: number,
): { x: number; y: number } {
  switch (fillMode) {
    case 'leftTop':
      return { x: bbox.x, y: bbox.y };
    case 'centerTop':
      return { x: bbox.x + (bbox.width - imageWidth) / 2, y: bbox.y };
    case 'rightTop':
      return { x: bbox.x + bbox.width - imageWidth, y: bbox.y };
    case 'leftCenter':
      return { x: bbox.x, y: bbox.y + (bbox.height - imageHeight) / 2 };
    case 'center':
      return { x: bbox.x + (bbox.width - imageWidth) / 2, y: bbox.y + (bbox.height - imageHeight) / 2 };
    case 'rightCenter':
      return { x: bbox.x + bbox.width - imageWidth, y: bbox.y + (bbox.height - imageHeight) / 2 };
    case 'leftBottom':
      return { x: bbox.x, y: bbox.y + bbox.height - imageHeight };
    case 'centerBottom':
      return { x: bbox.x + (bbox.width - imageWidth) / 2, y: bbox.y + bbox.height - imageHeight };
    case 'rightBottom':
      return { x: bbox.x + bbox.width - imageWidth, y: bbox.y + bbox.height - imageHeight };
    default:
      return { x: bbox.x, y: bbox.y };
  }
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

export type ArrowHeadShape =
  | { kind: 'none' }
  | {
    kind: 'polygon';
    fill: 'solid' | 'open';
    points: Array<[number, number]>;
  }
  | {
    kind: 'ellipse';
    fill: 'solid' | 'open';
    centerX: number;
    centerY: number;
    radiusX: number;
    radiusY: number;
  };

export function arrowHeadShape(
  tipX: number,
  tipY: number,
  directionX: number,
  directionY: number,
  arrowWidth: number,
  arrowHeight: number,
  arrowStyle: string,
): ArrowHeadShape {
  if (arrowStyle === 'none') {
    return { kind: 'none' };
  }

  const alongX = -directionX;
  const alongY = -directionY;
  const perpX = directionY;
  const perpY = -directionX;
  const halfHeight = arrowHeight / 2;
  const toWorld = (along: number, perp: number): [number, number] => [
    tipX + along * alongX + perp * perpX,
    tipY + along * alongY + perp * perpY,
  ];

  if (arrowStyle === 'arrow' || arrowStyle === 'concaveArrow') {
    const points: Array<[number, number]> = [
      [tipX, tipY],
      toWorld(arrowWidth, -halfHeight),
    ];
    if (arrowStyle === 'concaveArrow') {
      points.push(toWorld(arrowWidth - arrowWidth * 0.3, 0));
    }
    points.push(toWorld(arrowWidth, halfHeight));
    return { kind: 'polygon', fill: 'solid', points };
  }

  if (arrowStyle === 'diamond' || arrowStyle === 'openDiamond') {
    const halfWidth = arrowWidth / 2;
    return {
      kind: 'polygon',
      fill: arrowStyle === 'diamond' ? 'solid' : 'open',
      points: [
        toWorld(0, 0),
        toWorld(halfWidth, -halfHeight),
        toWorld(arrowWidth, 0),
        toWorld(halfWidth, halfHeight),
      ],
    };
  }

  if (arrowStyle === 'circle' || arrowStyle === 'openCircle') {
    const halfWidth = arrowWidth / 2;
    const [centerX, centerY] = toWorld(halfWidth, 0);
    return {
      kind: 'ellipse',
      fill: arrowStyle === 'circle' ? 'solid' : 'open',
      centerX,
      centerY,
      radiusX: halfWidth * 0.8,
      radiusY: halfHeight * 0.8,
    };
  }

  if (arrowStyle === 'square' || arrowStyle === 'openSquare') {
    return {
      kind: 'polygon',
      fill: arrowStyle === 'square' ? 'solid' : 'open',
      points: [
        toWorld(0, -halfHeight),
        toWorld(arrowWidth, -halfHeight),
        toWorld(arrowWidth, halfHeight),
        toWorld(0, halfHeight),
      ],
    };
  }

  return { kind: 'none' };
}

export function strokeDashPattern(dash: string, width: number): number[] {
  const stroke = Math.max(width, 0.5);
  switch (dash) {
    case 'dash':
      return [stroke * 4, stroke * 2];
    case 'dot':
      return [stroke * 1.5, stroke * 2.5];
    case 'dashDot':
      return [stroke * 4, stroke * 2, stroke * 1.5, stroke * 2];
    case 'dashDotDot':
      return [stroke * 4, stroke * 2, stroke * 1.5, stroke * 2, stroke * 1.5, stroke * 2];
    default:
      return [];
  }
}
