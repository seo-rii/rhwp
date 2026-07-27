import type {
  LayerAffineTransform,
  LayerCharOverlapOp,
  LayerEquationLayoutBox,
  LayerImageOp,
  LayerPatternFill,
  LayerTextRunOp,
} from '@/core/types';
import { buildCanvasTextFont } from '@/core/font-substitution';
import { parseSupportedCssColor } from './canvaskit/css-color';
import {
  applyLayerImageEffectPixels,
  canPreprocessCroppedLayerImageEffect,
  decodeBase64,
  resolveLayerImageCropSource,
  type LayerImageEffectDiagnostics,
  type LayerImageEffectSourceRect,
} from './image-effect-pixels';
import {
  charOverlapInnerSizeRatio,
  decodePuaOverlapNumber,
  puaToDisplayText,
} from './text-replay-utils';

export {
  applyLayerImageEffectPixels,
  canPreprocessCroppedLayerImageEffect,
  decodeBase64,
  resolveLayerImageCropSource,
  resetLayerImageEffectDiagnostics,
} from './image-effect-pixels';
export type {
  LayerImageEffectDiagnostics,
  LayerImageEffectSourceRect,
} from './image-effect-pixels';
export {
  angleToCanvasCoords,
  calculateArrowDimensions,
  computePathPaintBounds,
  effectiveLayerImageBounds,
} from './layer-geometry-utils';
export {
  allowsTextControlMark,
  charOverlapInnerSizeRatio,
  decodePuaOverlapNumber,
  estimateDisplayTextPositions,
  isHalfwidthScaledCluster,
  mapPuaBulletChar,
  mapPuaBulletText,
  mapPuaDisplayText,
  puaToDisplayText,
  splitIntoClusters,
  startsWithInvalidControl,
} from './text-replay-utils';

const EQUATION_SCRIPT_SCALE = 0.7;
const EQUATION_BIG_OP_SCALE = 1.5;
const STATIC_SVG_UNSUPPORTED_INDIRECT_PAINT_VALUES = new Set([
  'context-fill',
  'context-stroke',
  'inherit',
  'initial',
  'revert',
  'revert-layer',
  'unset',
]);

export type LayerCanvasImageEffectSource = HTMLCanvasElement | OffscreenCanvas;
export type LayerCanvasImageSource = HTMLImageElement | LayerCanvasImageEffectSource;
export type LayerImageEffectCache = WeakMap<LayerCanvasImageSource, Map<string, LayerCanvasImageEffectSource>>;
export type StaticSvgPathLayer = {
  pathData: string;
  fill: string | null;
  fillRule?: CanvasFillRule;
  opacity: number;
  stroke?: StaticSvgStrokeLayer;
  transform?: LayerAffineTransform;
};
export type StaticSvgStrokeLayer = {
  color: string;
  opacity: number;
  width: number;
  lineJoin: CanvasLineJoin;
  lineCap: CanvasLineCap;
  miterLimit: number;
  dashArray?: number[];
  dashOffset: number;
};
type StaticSvgPaintState = {
  color: string;
  fill: string | null;
  fillRuleValue: string | null;
  fillOpacity: number;
  stroke: string | null;
  strokeOpacity: number;
  strokeWidth: number;
  strokeLineJoin: CanvasLineJoin;
  strokeLineCap: CanvasLineCap;
  strokeMiterLimit: number;
  strokeDashArray: number[] | null;
  strokeDashOffset: number;
  transform?: LayerAffineTransform;
};
export function parseStaticSvgPathLayers(
  fragment: string,
  options: { allowDomParser?: boolean } = {},
): StaticSvgPathLayer[] {
  const parserFragment = staticSvgMarkupWithoutComments(fragment);
  if (parserFragment === null || hasStaticSvgUnsupportedMarkup(parserFragment)) {
    return [];
  }
  if (options.allowDomParser === false || typeof DOMParser === 'undefined') {
    const layers: StaticSvgPathLayer[] = [];
    const paintStateStack: StaticSvgPaintState[] = [{
      color: '#000000',
      fill: null,
      fillRuleValue: null,
      fillOpacity: 1,
      stroke: null,
      strokeOpacity: 1,
      strokeWidth: 1,
      strokeLineJoin: 'miter',
      strokeLineCap: 'butt',
      strokeMiterLimit: 4,
      strokeDashArray: null,
      strokeDashOffset: 0,
    }];
    const tagPattern = /<\s*(\/?)\s*([A-Za-z][A-Za-z0-9:-]*)\b([^>]*)>/g;
    let ignoredElementDepth = 0;
    for (const match of parserFragment.matchAll(tagPattern)) {
      const isClosingTag = match[1] === '/';
      const elementName = match[2].toLowerCase();
      const rawAttributes = match[3] ?? '';
      if (isClosingTag) {
        if (ignoredElementDepth > 0) {
          ignoredElementDepth -= 1;
          continue;
        }
        if ((elementName === 'svg' || elementName === 'g') && paintStateStack.length > 1) {
          paintStateStack.pop();
        }
        continue;
      }
      const supportedAttributes = staticSvgSupportedAttributes(elementName);
      if (!supportedAttributes) {
        return [];
      }
      const isSelfClosing = /\/\s*$/.test(rawAttributes);

      const attributes = new Map<string, string>();
      const attributePattern = /([A-Za-z_][A-Za-z0-9:._-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
      let remainingAttributes = rawAttributes;
      for (const attributeMatch of rawAttributes.matchAll(attributePattern)) {
        const rawName = attributeMatch[1].trim().toLowerCase();
        if (attributes.has(rawName)) {
          return [];
        }
        const value = attributeMatch[2] ?? attributeMatch[3] ?? attributeMatch[4] ?? '';
        const decodedValue = decodeStaticSvgXmlEntities(value);
        if (decodedValue === null) {
          return [];
        }
        attributes.set(rawName, decodedValue.trim());
        remainingAttributes = remainingAttributes.replace(attributeMatch[0], '');
      }
      if (remainingAttributes.replace(/\/\s*$/, '').trim().length > 0) {
        return [];
      }

      for (const [name, value] of attributes) {
        if (!isStaticSvgAttributeSupported(elementName, supportedAttributes, name, value)) {
          return [];
        }
      }
      if (
        ignoredElementDepth > 0
        || elementName === 'defs'
        || elementName === 'title'
        || elementName === 'desc'
        || elementName === 'metadata'
      ) {
        if (!isSelfClosing) {
          ignoredElementDepth += 1;
        }
        continue;
      }
      if (elementName === 'svg' || elementName === 'g') {
        if ((elementName === 'svg' || elementName === 'g') && !isSelfClosing) {
          paintStateStack.push(staticSvgPaintStateFromMap(
            paintStateStack[paintStateStack.length - 1],
            attributes,
            elementName === 'svg' || elementName === 'g',
          ));
        }
        continue;
      }

      let pathData: string | null = null;
      if (elementName === 'path') {
        pathData = attributes.get('d')?.trim() || null;
      } else if (elementName === 'circle') {
        const cx = svgNumber(attributes.get('cx') ?? '0') ?? 0;
        const cy = svgNumber(attributes.get('cy') ?? '0') ?? 0;
        const r = attributes.has('r') ? svgNumber(attributes.get('r') ?? '') : null;
        if (r !== null && r > 0) {
          pathData = `M${cx - r} ${cy}A${r} ${r} 0 1 0 ${cx + r} ${cy}A${r} ${r} 0 1 0 ${cx - r} ${cy}Z`;
        }
      } else if (elementName === 'ellipse') {
        const cx = svgNumber(attributes.get('cx') ?? '0') ?? 0;
        const cy = svgNumber(attributes.get('cy') ?? '0') ?? 0;
        const rx = attributes.has('rx') ? svgNumber(attributes.get('rx') ?? '') : null;
        const ry = attributes.has('ry') ? svgNumber(attributes.get('ry') ?? '') : null;
        if (rx !== null && ry !== null && rx > 0 && ry > 0) {
          pathData = `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
        }
      } else if (elementName === 'polygon' || elementName === 'polyline') {
        const points = svgPointList(attributes.get('points') ?? '');
        if (points.length >= 3) {
          const [first, ...rest] = points;
          const closePath = elementName === 'polygon' ? 'Z' : '';
          pathData = `M${first[0]} ${first[1]}${rest.map(([x, y]) => `L${x} ${y}`).join('')}${closePath}`;
        }
      } else if (elementName === 'line') {
        const x1 = svgNumber(attributes.get('x1') ?? '0') ?? 0;
        const y1 = svgNumber(attributes.get('y1') ?? '0') ?? 0;
        const x2 = svgNumber(attributes.get('x2') ?? '0') ?? 0;
        const y2 = svgNumber(attributes.get('y2') ?? '0') ?? 0;
        pathData = `M${x1} ${y1}L${x2} ${y2}`;
      } else if (elementName === 'rect') {
        const x = svgNumber(attributes.get('x') ?? '0') ?? 0;
        const y = svgNumber(attributes.get('y') ?? '0') ?? 0;
        const width = attributes.has('width') ? svgNumber(attributes.get('width') ?? '') : null;
        const height = attributes.has('height') ? svgNumber(attributes.get('height') ?? '') : null;
        const rx = attributes.has('rx') ? svgNumber(attributes.get('rx') ?? '') : null;
        const ry = attributes.has('ry') ? svgNumber(attributes.get('ry') ?? '') : null;
        pathData = staticSvgRectPathData(x, y, width, height, rx, ry);
      }
      if (!pathData) {
        continue;
      }

      const currentState = paintStateStack[paintStateStack.length - 1];
      const fill = staticSvgMapPresentationAttribute(attributes, 'fill');
      const strokeValue = staticSvgMapPresentationAttribute(attributes, 'stroke');
      const opacityValue = staticSvgMapPresentationAttribute(attributes, 'opacity');
      const fillOpacityValue = staticSvgMapPresentationAttribute(attributes, 'fill-opacity');
      const strokeOpacityValue = staticSvgMapPresentationAttribute(attributes, 'stroke-opacity');
      const shapeColor = staticSvgMapPresentationAttribute(attributes, 'color') ?? currentState.color;
      const strokeWidthValue = staticSvgMapPresentationAttribute(attributes, 'stroke-width');
      const strokeLineJoinValue = staticSvgMapPresentationAttribute(attributes, 'stroke-linejoin');
      const strokeLineCapValue = staticSvgMapPresentationAttribute(attributes, 'stroke-linecap');
      const strokeMiterLimitValue = staticSvgMapPresentationAttribute(attributes, 'stroke-miterlimit');
      const strokeDashArrayValue = staticSvgMapPresentationAttribute(attributes, 'stroke-dasharray');
      const strokeDashOffsetValue = staticSvgMapPresentationAttribute(attributes, 'stroke-dashoffset');
      const fillRuleValue = staticSvgMapPresentationAttribute(attributes, 'fill-rule') ?? currentState.fillRuleValue;
      const resolvedFill = resolveStaticSvgPaintValue(fill ?? currentState.fill ?? '#000000', shapeColor);
      const resolvedStroke = strokeValue ?? currentState.stroke;
      const shapeOpacity = svgOpacity(opacityValue);
      const stroke = staticSvgStrokeLayer(
        resolvedStroke,
        strokeWidthValue,
        strokeOpacityValue,
        strokeLineJoinValue,
        strokeLineCapValue,
        strokeMiterLimitValue,
        strokeDashArrayValue,
        strokeDashOffsetValue,
        currentState,
        shapeOpacity,
        shapeColor,
      );
      const shouldFill = elementName !== 'line' && resolvedFill.trim().toLowerCase() !== 'none';
      const transform = staticSvgComposeTransforms(
        currentState.transform,
        parseStaticSvgTransform(attributes.get('transform')),
      );
      layers.push({
        pathData,
        fill: shouldFill ? resolvedFill : null,
        fillRule: svgFillRule(fillRuleValue),
        opacity: shapeOpacity * (fillOpacityValue === null ? currentState.fillOpacity : svgOpacity(fillOpacityValue)),
        stroke,
        transform,
      });
    }
    return layers;
  }
  const parser = new DOMParser();
  const document = parser.parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${fragment}</svg>`, 'image/svg+xml');
  if (document.querySelector('parsererror')) {
    return [];
  }

  for (const element of document.documentElement.querySelectorAll('*')) {
    if (!isStaticSvgPaintElementSupported(element)) {
      return [];
    }
  }

  const layers: StaticSvgPathLayer[] = [];
  const appendStaticSvgLayers = (element: Element, state: StaticSvgPaintState): void => {
    const elementName = element.localName.toLowerCase();
    if (
      elementName === 'defs'
      || elementName === 'title'
      || elementName === 'desc'
      || elementName === 'metadata'
    ) {
      return;
    }
    const currentState = elementName === 'svg' || elementName === 'g'
      ? staticSvgPaintStateFromElement(state, element, elementName === 'svg' || elementName === 'g')
      : state;
    if (elementName === 'path'
      || elementName === 'rect'
      || elementName === 'circle'
      || elementName === 'ellipse'
      || elementName === 'polygon'
      || elementName === 'polyline'
      || elementName === 'line') {
      const pathData = staticSvgElementPathData(element);
      if (!pathData) {
        return;
      }
      const shapeColor = svgPresentationAttribute(element, 'color') ?? currentState.color;
      const fill = resolveStaticSvgPaintValue(svgPresentationAttribute(element, 'fill') ?? currentState.fill ?? '#000000', shapeColor);
      const stroke = staticSvgStrokeLayer(
        svgPresentationAttribute(element, 'stroke') ?? currentState.stroke,
        svgPresentationAttribute(element, 'stroke-width'),
        svgPresentationAttribute(element, 'stroke-opacity'),
        svgPresentationAttribute(element, 'stroke-linejoin'),
        svgPresentationAttribute(element, 'stroke-linecap'),
        svgPresentationAttribute(element, 'stroke-miterlimit'),
        svgPresentationAttribute(element, 'stroke-dasharray'),
        svgPresentationAttribute(element, 'stroke-dashoffset'),
        currentState,
        svgOpacity(svgPresentationAttribute(element, 'opacity')),
        shapeColor,
      );
      const shouldFill = elementName !== 'line' && fill.trim().toLowerCase() !== 'none';
      const fillOpacityValue = svgPresentationAttribute(element, 'fill-opacity');
      const opacity = svgOpacity(svgPresentationAttribute(element, 'opacity'))
        * (fillOpacityValue === null ? currentState.fillOpacity : svgOpacity(fillOpacityValue));
      const transform = staticSvgComposeTransforms(
        currentState.transform,
        parseStaticSvgTransform(element.getAttribute('transform')),
      );
      layers.push({
        pathData,
        fill: shouldFill ? fill : null,
        fillRule: svgFillRule(svgPresentationAttribute(element, 'fill-rule') ?? currentState.fillRuleValue),
        opacity,
        stroke,
        transform,
      });
      return;
    }
    for (const child of Array.from(element.children)) {
      appendStaticSvgLayers(child, currentState);
    }
  };
  appendStaticSvgLayers(document.documentElement, {
    color: '#000000',
    fill: null,
    fillRuleValue: null,
    fillOpacity: 1,
    stroke: null,
    strokeOpacity: 1,
    strokeWidth: 1,
    strokeLineJoin: 'miter',
    strokeLineCap: 'butt',
    strokeMiterLimit: 4,
    strokeDashArray: null,
    strokeDashOffset: 0,
  });
  return layers;
}

function staticSvgMarkupWithoutComments(fragment: string): string | null {
  let stripped = '';
  let cursor = 0;
  while (cursor < fragment.length) {
    const commentStart = fragment.indexOf('<!--', cursor);
    const strayCommentEnd = fragment.indexOf('-->', cursor);
    if (strayCommentEnd !== -1 && (commentStart === -1 || strayCommentEnd < commentStart)) {
      return null;
    }
    if (commentStart === -1) {
      return stripped + fragment.slice(cursor);
    }
    stripped += fragment.slice(cursor, commentStart);
    const commentEnd = fragment.indexOf('-->', commentStart + 4);
    if (commentEnd === -1) {
      return null;
    }
    if (fragment.slice(commentStart + 4, commentEnd).includes('--')) {
      return null;
    }
    cursor = commentEnd + 3;
  }
  return stripped;
}

function staticSvgStyleWithoutComments(style: string): string | null {
  let stripped = '';
  let cursor = 0;
  while (cursor < style.length) {
    const commentStart = style.indexOf('/*', cursor);
    const strayCommentEnd = style.indexOf('*/', cursor);
    if (strayCommentEnd !== -1 && (commentStart === -1 || strayCommentEnd < commentStart)) {
      return null;
    }
    if (commentStart === -1) {
      return stripped + style.slice(cursor);
    }
    stripped += `${style.slice(cursor, commentStart)} `;
    const commentEnd = style.indexOf('*/', commentStart + 2);
    if (commentEnd === -1) {
      return null;
    }
    cursor = commentEnd + 2;
  }
  return stripped;
}

function decodeStaticSvgXmlEntities(value: string): string | null {
  let decodedValue = '';
  let cursor = 0;
  while (cursor < value.length) {
    const entityStart = value.indexOf('&', cursor);
    if (entityStart < 0) {
      return decodedValue + value.slice(cursor);
    }
    decodedValue += value.slice(cursor, entityStart);
    const entityEnd = value.indexOf(';', entityStart + 1);
    if (entityEnd < 0) {
      return null;
    }
    const entity = value.slice(entityStart + 1, entityEnd);
    let decodedEntity: string | null = null;
    if (entity === 'amp') {
      decodedEntity = '&';
    } else if (entity === 'lt') {
      decodedEntity = '<';
    } else if (entity === 'gt') {
      decodedEntity = '>';
    } else if (entity === 'quot') {
      decodedEntity = '"';
    } else if (entity === 'apos') {
      decodedEntity = "'";
    } else {
      const decimalEntity = /^#([0-9]+)$/.exec(entity);
      const hexEntity = /^#x([0-9a-fA-F]+)$/.exec(entity);
      const codePoint = decimalEntity
        ? Number(decimalEntity[1])
        : hexEntity
          ? Number.parseInt(hexEntity[1], 16)
          : Number.NaN;
      const isXmlCharacter = codePoint === 0x09
        || codePoint === 0x0a
        || codePoint === 0x0d
        || (codePoint >= 0x20 && codePoint <= 0xd7ff)
        || (codePoint >= 0xe000 && codePoint <= 0xfffd)
        || (codePoint >= 0x10000 && codePoint <= 0x10ffff);
      if (Number.isInteger(codePoint) && isXmlCharacter) {
        decodedEntity = String.fromCodePoint(codePoint);
      }
    }
    if (decodedEntity === null) {
      return null;
    }
    decodedValue += decodedEntity;
    cursor = entityEnd + 1;
  }
  return decodedValue;
}

function isStaticSvgTextContentSupported(text: string): boolean {
  return !text.includes('<') && decodeStaticSvgXmlEntities(text) !== null;
}

function hasStaticSvgUnsupportedMarkup(fragment: string): boolean {
  if (/<\s*\?/.test(fragment) || /<\s*!(?!\s*--)/.test(fragment) || fragment.includes(']]>')) {
    return true;
  }
  const openElementStack: string[] = [];
  const tagPattern = /<\s*(\/?)\s*([A-Za-z][A-Za-z0-9:-]*)\b([^>]*)>/g;
  let cursor = 0;
  for (const match of fragment.matchAll(tagPattern)) {
    if (!isStaticSvgTextContentSupported(fragment.slice(cursor, match.index))) {
      return true;
    }
    cursor = (match.index ?? 0) + match[0].length;
    const isClosingTag = match[1] === '/';
    const elementName = match[2].toLowerCase();
    const trailingContent = match[3] ?? '';
    if (!staticSvgSupportedAttributes(elementName)) {
      return true;
    }
    if (isClosingTag) {
      if (trailingContent.trim().length > 0 || openElementStack.pop() !== elementName) {
        return true;
      }
      continue;
    }
    if (!/\/\s*$/.test(trailingContent)) {
      openElementStack.push(elementName);
    }
  }
  return openElementStack.length > 0 || !isStaticSvgTextContentSupported(fragment.slice(cursor));
}

function staticSvgMapPresentationAttribute(attributes: Map<string, string>, name: string): string | null {
  const style = attributes.get('style');
  if (style) {
    const normalizedStyle = staticSvgStyleWithoutComments(style);
    let styleValue: string | null = null;
    for (const declaration of (normalizedStyle ?? '').split(';')) {
      const separator = declaration.indexOf(':');
      if (separator < 0) {
        continue;
      }
      if (declaration.slice(0, separator).trim().toLowerCase() === name.toLowerCase()) {
        styleValue = declaration.slice(separator + 1).trim();
      }
    }
    if (styleValue !== null) {
      return styleValue;
    }
  }
  return attributes.get(name) ?? null;
}

function staticSvgPaintStateFromMap(
  parent: StaticSvgPaintState,
  attributes: Map<string, string>,
  allowTransform: boolean,
): StaticSvgPaintState {
  const fillOpacityValue = staticSvgMapPresentationAttribute(attributes, 'fill-opacity');
  const strokeDashArray = svgStrokeDashArray(staticSvgMapPresentationAttribute(attributes, 'stroke-dasharray'));
  const strokeDashOffset = svgStrokeDashOffset(staticSvgMapPresentationAttribute(attributes, 'stroke-dashoffset'));
  return {
    color: staticSvgMapPresentationAttribute(attributes, 'color') ?? parent.color,
    fill: staticSvgMapPresentationAttribute(attributes, 'fill') ?? parent.fill,
    fillRuleValue: staticSvgMapPresentationAttribute(attributes, 'fill-rule') ?? parent.fillRuleValue,
    fillOpacity: fillOpacityValue === null ? parent.fillOpacity : svgOpacity(fillOpacityValue),
    stroke: staticSvgMapPresentationAttribute(attributes, 'stroke') ?? parent.stroke,
    strokeOpacity: staticSvgMapPresentationAttribute(attributes, 'stroke-opacity') === null
      ? parent.strokeOpacity
      : svgOpacity(staticSvgMapPresentationAttribute(attributes, 'stroke-opacity')),
    strokeWidth: svgNonNegativeNumber(staticSvgMapPresentationAttribute(attributes, 'stroke-width')) ?? parent.strokeWidth,
    strokeLineJoin: svgStrokeLineJoin(staticSvgMapPresentationAttribute(attributes, 'stroke-linejoin'))
      ?? parent.strokeLineJoin,
    strokeLineCap: svgStrokeLineCap(staticSvgMapPresentationAttribute(attributes, 'stroke-linecap'))
      ?? parent.strokeLineCap,
    strokeMiterLimit: svgPositiveNumber(staticSvgMapPresentationAttribute(attributes, 'stroke-miterlimit'))
      ?? parent.strokeMiterLimit,
    strokeDashArray: strokeDashArray === undefined ? parent.strokeDashArray : strokeDashArray,
    strokeDashOffset: strokeDashOffset === undefined ? parent.strokeDashOffset : strokeDashOffset,
    transform: allowTransform
      ? staticSvgComposeTransforms(parent.transform, parseStaticSvgTransform(attributes.get('transform')))
      : parent.transform,
  };
}

function staticSvgPaintStateFromElement(
  parent: StaticSvgPaintState,
  element: Element,
  allowTransform: boolean,
): StaticSvgPaintState {
  const fillOpacityValue = svgPresentationAttribute(element, 'fill-opacity');
  const strokeDashArray = svgStrokeDashArray(svgPresentationAttribute(element, 'stroke-dasharray'));
  const strokeDashOffset = svgStrokeDashOffset(svgPresentationAttribute(element, 'stroke-dashoffset'));
  return {
    color: svgPresentationAttribute(element, 'color') ?? parent.color,
    fill: svgPresentationAttribute(element, 'fill') ?? parent.fill,
    fillRuleValue: svgPresentationAttribute(element, 'fill-rule') ?? parent.fillRuleValue,
    fillOpacity: fillOpacityValue === null ? parent.fillOpacity : svgOpacity(fillOpacityValue),
    stroke: svgPresentationAttribute(element, 'stroke') ?? parent.stroke,
    strokeOpacity: svgPresentationAttribute(element, 'stroke-opacity') === null
      ? parent.strokeOpacity
      : svgOpacity(svgPresentationAttribute(element, 'stroke-opacity')),
    strokeWidth: svgNonNegativeNumber(svgPresentationAttribute(element, 'stroke-width')) ?? parent.strokeWidth,
    strokeLineJoin: svgStrokeLineJoin(svgPresentationAttribute(element, 'stroke-linejoin')) ?? parent.strokeLineJoin,
    strokeLineCap: svgStrokeLineCap(svgPresentationAttribute(element, 'stroke-linecap')) ?? parent.strokeLineCap,
    strokeMiterLimit: svgPositiveNumber(svgPresentationAttribute(element, 'stroke-miterlimit'))
      ?? parent.strokeMiterLimit,
    strokeDashArray: strokeDashArray === undefined ? parent.strokeDashArray : strokeDashArray,
    strokeDashOffset: strokeDashOffset === undefined ? parent.strokeDashOffset : strokeDashOffset,
    transform: allowTransform
      ? staticSvgComposeTransforms(parent.transform, parseStaticSvgTransform(element.getAttribute('transform')))
      : parent.transform,
  };
}

function staticSvgStrokeLayer(
  strokeValue: string | null,
  widthValue: string | null,
  opacityValue: string | null,
  lineJoinValue: string | null,
  lineCapValue: string | null,
  miterLimitValue: string | null,
  dashArrayValue: string | null,
  dashOffsetValue: string | null,
  currentState: StaticSvgPaintState,
  shapeOpacity: number,
  currentColor: string,
): StaticSvgStrokeLayer | undefined {
  const stroke = strokeValue ?? currentState.stroke;
  if (!stroke || stroke.trim().toLowerCase() === 'none') {
    return undefined;
  }
  const width = svgNonNegativeNumber(widthValue) ?? currentState.strokeWidth;
  if (!(width > 0)) {
    return undefined;
  }
  const opacity = shapeOpacity * (opacityValue === null ? currentState.strokeOpacity : svgOpacity(opacityValue));
  if (!(opacity > 0)) {
    return undefined;
  }
  const dashArray = svgStrokeDashArray(dashArrayValue);
  const dashOffset = svgStrokeDashOffset(dashOffsetValue);
  return {
    color: resolveStaticSvgPaintValue(stroke, currentColor),
    opacity,
    width,
    lineJoin: svgStrokeLineJoin(lineJoinValue) ?? currentState.strokeLineJoin,
    lineCap: svgStrokeLineCap(lineCapValue) ?? currentState.strokeLineCap,
    miterLimit: svgPositiveNumber(miterLimitValue) ?? currentState.strokeMiterLimit,
    dashArray: dashArray === undefined
      ? currentState.strokeDashArray ?? undefined
      : dashArray ?? undefined,
    dashOffset: dashOffset === undefined ? currentState.strokeDashOffset : dashOffset,
  };
}

function staticSvgComposeTransforms(
  parent: LayerAffineTransform | undefined,
  child: LayerAffineTransform | undefined,
): LayerAffineTransform | undefined {
  if (!parent) {
    return child;
  }
  if (!child) {
    return parent;
  }
  return {
    a: parent.a * child.a + parent.c * child.b,
    b: parent.b * child.a + parent.d * child.b,
    c: parent.a * child.c + parent.c * child.d,
    d: parent.b * child.c + parent.d * child.d,
    e: parent.a * child.e + parent.c * child.f + parent.e,
    f: parent.b * child.e + parent.d * child.f + parent.f,
  };
}

function staticSvgElementPathData(element: Element): string | null {
  const elementName = element.localName.toLowerCase();
  if (elementName === 'path') {
    return element.getAttribute('d')?.trim() || null;
  }
  if (elementName === 'circle') {
    const cx = svgNumericAttribute(element, 'cx') ?? 0;
    const cy = svgNumericAttribute(element, 'cy') ?? 0;
    const r = svgNumericAttribute(element, 'r');
    if (r === null || r <= 0) {
      return null;
    }
    return `M${cx - r} ${cy}A${r} ${r} 0 1 0 ${cx + r} ${cy}A${r} ${r} 0 1 0 ${cx - r} ${cy}Z`;
  }
  if (elementName === 'ellipse') {
    const cx = svgNumericAttribute(element, 'cx') ?? 0;
    const cy = svgNumericAttribute(element, 'cy') ?? 0;
    const rx = svgNumericAttribute(element, 'rx');
    const ry = svgNumericAttribute(element, 'ry');
    if (rx === null || ry === null || rx <= 0 || ry <= 0) {
      return null;
    }
    return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
  }
  if (elementName === 'polygon' || elementName === 'polyline') {
    const points = svgPointListAttribute(element, 'points');
    if (points.length < 3) {
      return null;
    }
    const [first, ...rest] = points;
    const closePath = elementName === 'polygon' ? 'Z' : '';
    return `M${first[0]} ${first[1]}${rest.map(([x, y]) => `L${x} ${y}`).join('')}${closePath}`;
  }
  if (elementName === 'line') {
    const x1 = svgNumericAttribute(element, 'x1') ?? 0;
    const y1 = svgNumericAttribute(element, 'y1') ?? 0;
    const x2 = svgNumericAttribute(element, 'x2') ?? 0;
    const y2 = svgNumericAttribute(element, 'y2') ?? 0;
    return `M${x1} ${y1}L${x2} ${y2}`;
  }
  if (elementName !== 'rect') {
    return null;
  }
  return staticSvgRectPathData(
    svgNumericAttribute(element, 'x') ?? 0,
    svgNumericAttribute(element, 'y') ?? 0,
    svgNumericAttribute(element, 'width'),
    svgNumericAttribute(element, 'height'),
    svgNumericAttribute(element, 'rx'),
    svgNumericAttribute(element, 'ry'),
  );
}

function staticSvgRectPathData(
  x: number,
  y: number,
  width: number | null,
  height: number | null,
  rxValue: number | null,
  ryValue: number | null,
): string | null {
  if (width === null || height === null || width <= 0 || height <= 0) {
    return null;
  }
  const rx = Math.min(Math.max(rxValue ?? ryValue ?? 0, 0), width / 2);
  const ry = Math.min(Math.max(ryValue ?? rxValue ?? 0, 0), height / 2);
  if (rx > 0 && ry > 0) {
    return `M${x + rx} ${y}H${x + width - rx}A${rx} ${ry} 0 0 1 ${x + width} ${y + ry}V${y + height - ry}A${rx} ${ry} 0 0 1 ${x + width - rx} ${y + height}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + height - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`;
  }
  return `M${x} ${y}H${x + width}V${y + height}H${x}Z`;
}

function svgPresentationAttribute(element: Element, name: string): string | null {
  const style = element.getAttribute('style');
  if (style) {
    const normalizedStyle = staticSvgStyleWithoutComments(style);
    let styleValue: string | null = null;
    for (const declaration of (normalizedStyle ?? '').split(';')) {
      const separator = declaration.indexOf(':');
      if (separator < 0) {
        continue;
      }
      const property = declaration.slice(0, separator).trim().toLowerCase();
      if (property === name.toLowerCase()) {
        styleValue = declaration.slice(separator + 1).trim();
      }
    }
    if (styleValue !== null) {
      return styleValue;
    }
  }
  const direct = element.getAttribute(name);
  if (direct !== null) {
    return direct.trim();
  }
  return null;
}

function isStaticSvgPaintElementSupported(element: Element): boolean {
  const elementName = element.localName.toLowerCase();
  const supportedAttributes = staticSvgSupportedAttributes(elementName);
  if (!supportedAttributes) {
    return false;
  }
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.trim().toLowerCase();
    if (!isStaticSvgAttributeSupported(elementName, supportedAttributes, name, attribute.value)) {
      return false;
    }
  }
  return true;
}

function staticSvgSupportedAttributes(elementName: string): Set<string> | null {
  const paintAttributes = [
    'fill',
    'color',
    'fill-rule',
    'opacity',
    'fill-opacity',
    'stroke',
    'stroke-opacity',
    'stroke-width',
    'stroke-linejoin',
    'stroke-linecap',
    'stroke-miterlimit',
    'stroke-dasharray',
    'stroke-dashoffset',
    'style',
    'transform',
  ];
  if (elementName === 'path') {
    return new Set(['id', 'class', 'd', ...paintAttributes]);
  }
  if (elementName === 'rect') {
    return new Set(['id', 'class', 'x', 'y', 'width', 'height', 'rx', 'ry', ...paintAttributes]);
  }
  if (elementName === 'circle') {
    return new Set(['id', 'class', 'cx', 'cy', 'r', ...paintAttributes]);
  }
  if (elementName === 'ellipse') {
    return new Set(['id', 'class', 'cx', 'cy', 'rx', 'ry', ...paintAttributes]);
  }
  if (elementName === 'polygon' || elementName === 'polyline') {
    return new Set(['id', 'class', 'points', ...paintAttributes]);
  }
  if (elementName === 'line') {
    return new Set(['id', 'class', 'x1', 'y1', 'x2', 'y2', ...paintAttributes]);
  }
  if (elementName === 'svg') {
    return new Set([
      'id',
      'class',
      'xmlns',
      'xmlns:xlink',
      'xml:space',
      'viewbox',
      'width',
      'height',
      'x',
      'y',
      'version',
      ...paintAttributes,
    ]);
  }
  if (elementName === 'g') {
    return new Set(['id', 'class', 'xml:space', ...paintAttributes]);
  }
  if (elementName === 'title' || elementName === 'desc' || elementName === 'metadata') {
    return new Set(['id', 'class', 'xml:space']);
  }
  if (elementName === 'defs') {
    return new Set(['id', 'class', 'xml:space']);
  }
  return null;
}

function isStaticSvgAttributeSupported(
  elementName: string,
  supportedAttributes: Set<string>,
  name: string,
  value: string,
): boolean {
  if (!supportedAttributes.has(name)) {
    return isStaticSvgNonVisualAttributeSupported(name, value);
  }
  if (name === 'xmlns') {
    return value.trim() === 'http://www.w3.org/2000/svg';
  }
  if (name === 'xmlns:xlink') {
    return value.trim() === 'http://www.w3.org/1999/xlink';
  }
  if (name === 'xml:space') {
    const trimmedValue = value.trim();
    return trimmedValue === 'default' || trimmedValue === 'preserve';
  }
  if (name === 'id' || name === 'class') {
    return !/[<>`]/.test(value);
  }
  if (name === 'viewbox') {
    return isStaticSvgViewBoxValueSupported(value);
  }
  if (name === 'version') {
    const version = Number(value.trim());
    return Number.isFinite(version);
  }
  if (name === 'd') {
    return value.trim().length > 0;
  }
  if (name === 'fill') {
    return isStaticSvgPaintValueSupported(value);
  }
  if (name === 'stroke') {
    return isStaticSvgPaintValueSupported(value);
  }
  if (name === 'color') {
    return isStaticSvgColorValueSupported(value);
  }
  if (name === 'stroke-opacity') {
    return isStaticSvgOpacityValueSupported(value);
  }
  if (name === 'stroke-width') {
    return isStaticSvgNonNegativeNumericValueSupported(value);
  }
  if (name === 'stroke-miterlimit') {
    return isStaticSvgPositiveNumericValueSupported(value);
  }
  if (name === 'stroke-dasharray') {
    return svgStrokeDashArray(value) !== undefined;
  }
  if (name === 'stroke-dashoffset') {
    return svgStrokeDashOffset(value) !== undefined;
  }
  if (name === 'stroke-linejoin') {
    return svgStrokeLineJoin(value) !== null;
  }
  if (name === 'stroke-linecap') {
    return svgStrokeLineCap(value) !== null;
  }
  if (name === 'opacity') {
    return elementName === 'svg' || elementName === 'g'
      ? isStaticSvgIdentityOpacityValueSupported(value)
      : isStaticSvgOpacityValueSupported(value);
  }
  if (name === 'fill-opacity') {
    return isStaticSvgOpacityValueSupported(value);
  }
  if (name === 'fill-rule') {
    return isStaticSvgFillRuleValueSupported(value);
  }
  if (name === 'style') {
    return isStaticSvgStyleSupported(
      value,
      elementName !== 'svg' && elementName !== 'g',
      elementName === 'svg' || elementName === 'g',
    );
  }
  if (name === 'transform') {
    return parseStaticSvgTransform(value) !== undefined;
  }
  if (
    name === 'x'
    || name === 'y'
    || name === 'width'
    || name === 'height'
    || name === 'x1'
    || name === 'y1'
    || name === 'x2'
    || name === 'y2'
  ) {
    return isStaticSvgNumericValueSupported(value);
  }
  if (elementName === 'rect' && (name === 'rx' || name === 'ry')) {
    return isStaticSvgNonNegativeNumericValueSupported(value);
  }
  if (name === 'cx' || name === 'cy' || name === 'r' || name === 'rx' || name === 'ry') {
    return isStaticSvgNumericValueSupported(value);
  }
  if (name === 'points') {
    return svgPointList(value).length >= 3;
  }
  return elementName === 'g';
}

function isStaticSvgNonVisualAttributeSupported(name: string, value: string): boolean {
  const normalizedName = name.trim().toLowerCase();
  if (/[<>`]/.test(value)) {
    return false;
  }
  if (/^aria-[a-z0-9_-]+$/.test(normalizedName)) {
    return true;
  }
  if (/^data-[a-z0-9_.:-]+$/.test(normalizedName)) {
    return true;
  }
  if (normalizedName === 'role') {
    const trimmedValue = value.trim();
    return /^[a-z][a-z0-9_-]*(?:\s+[a-z][a-z0-9_-]*)*$/i.test(trimmedValue);
  }
  if (normalizedName === 'focusable') {
    return ['true', 'false', 'auto'].includes(value.trim().toLowerCase());
  }
  return false;
}

function svgNumericAttribute(element: Element, name: string): number | null {
  const value = element.getAttribute(name);
  if (value === null) {
    return null;
  }
  return svgNumber(value);
}

function isStaticSvgNumericValueSupported(value: string): boolean {
  return svgNumber(value) !== null;
}

function isStaticSvgNonNegativeNumericValueSupported(value: string): boolean {
  const number = svgNumber(value);
  return number !== null && number >= 0;
}

function isStaticSvgPositiveNumericValueSupported(value: string): boolean {
  const number = svgNumber(value);
  return number !== null && number > 0;
}

function isStaticSvgViewBoxValueSupported(value: string): boolean {
  const numbers = value
    .trim()
    .split(/[\s,]+/)
    .filter((part) => part.length > 0)
    .map((part) => Number(part));
  return numbers.length === 4
    && numbers.every((number) => Number.isFinite(number))
    && numbers[2] > 0
    && numbers[3] > 0;
}

function svgPointListAttribute(element: Element, name: string): Array<[number, number]> {
  return svgPointList(element.getAttribute(name) ?? '');
}

function svgPointList(value: string): Array<[number, number]> {
  const numbers = value
    .trim()
    .split(/[\s,]+/)
    .filter((part) => part.length > 0)
    .map((part) => Number(part));
  if (numbers.length < 6 || numbers.length % 2 !== 0 || numbers.some((number) => !Number.isFinite(number))) {
    return [];
  }
  const points: Array<[number, number]> = [];
  for (let index = 0; index < numbers.length; index += 2) {
    points.push([numbers[index], numbers[index + 1]]);
  }
  return points;
}

function parseStaticSvgTransform(value: string | null | undefined): LayerAffineTransform | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const source = value.trim();
  if (source.length === 0) {
    return undefined;
  }

  let transform: LayerAffineTransform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  let cursor = 0;
  const transformPattern = /([A-Za-z][A-Za-z0-9]*)\s*\(([^)]*)\)/g;
  for (const match of source.matchAll(transformPattern)) {
    const prefix = source.slice(cursor, match.index);
    if (!/^[\s,]*$/.test(prefix)) {
      return undefined;
    }
    cursor = (match.index ?? 0) + match[0].length;

    const rawArguments = match[2].trim();
    const numbers = rawArguments.length === 0
      ? []
      : rawArguments
        .split(/[\s,]+/)
        .filter((part) => part.length > 0)
        .map((part) => Number(part));
    if (numbers.some((number) => !Number.isFinite(number))) {
      return undefined;
    }

    const operation = match[1].toLowerCase();
    let next: LayerAffineTransform | undefined;
    if (operation === 'matrix' && numbers.length === 6) {
      next = { a: numbers[0], b: numbers[1], c: numbers[2], d: numbers[3], e: numbers[4], f: numbers[5] };
    } else if (operation === 'translate' && (numbers.length === 1 || numbers.length === 2)) {
      next = { a: 1, b: 0, c: 0, d: 1, e: numbers[0], f: numbers[1] ?? 0 };
    } else if (operation === 'scale' && (numbers.length === 1 || numbers.length === 2)) {
      next = { a: numbers[0], b: 0, c: 0, d: numbers[1] ?? numbers[0], e: 0, f: 0 };
    } else if (operation === 'rotate' && (numbers.length === 1 || numbers.length === 3)) {
      const radians = numbers[0] * Math.PI / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      if (numbers.length === 3) {
        const cx = numbers[1];
        const cy = numbers[2];
        next = {
          a: cos,
          b: sin,
          c: -sin,
          d: cos,
          e: cx - cos * cx + sin * cy,
          f: cy - sin * cx - cos * cy,
        };
      } else {
        next = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
      }
    } else if (operation === 'skewx' && numbers.length === 1) {
      next = { a: 1, b: 0, c: Math.tan(numbers[0] * Math.PI / 180), d: 1, e: 0, f: 0 };
    } else if (operation === 'skewy' && numbers.length === 1) {
      next = { a: 1, b: Math.tan(numbers[0] * Math.PI / 180), c: 0, d: 1, e: 0, f: 0 };
    } else {
      return undefined;
    }
    if (!Object.values(next).every((number) => Number.isFinite(number))) {
      return undefined;
    }
    transform = staticSvgComposeTransforms(transform, next) ?? transform;
  }
  if (!/^[\s,]*$/.test(source.slice(cursor)) || cursor === 0) {
    return undefined;
  }
  return transform;
}

function isStaticSvgStyleSupported(style: string, allowOpacity: boolean, allowIdentityOpacity = false): boolean {
  const normalizedStyle = staticSvgStyleWithoutComments(style);
  if (normalizedStyle === null) {
    return false;
  }
  const supportedProperties = new Set([
    'fill',
    'color',
    'fill-rule',
    'fill-opacity',
    'stroke',
    'stroke-opacity',
    'stroke-width',
    'stroke-linejoin',
    'stroke-linecap',
    'stroke-miterlimit',
    'stroke-dasharray',
    'stroke-dashoffset',
  ]);
  if (allowOpacity || allowIdentityOpacity) {
    supportedProperties.add('opacity');
  }
  for (const declaration of normalizedStyle.split(';')) {
    const separator = declaration.indexOf(':');
    if (separator < 0) {
      if (declaration.trim().length > 0) {
        return false;
      }
      continue;
    }
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim();
    if (!supportedProperties.has(property)) {
      return false;
    }
    if (property === 'fill' && !isStaticSvgPaintValueSupported(value)) {
      return false;
    }
    if (property === 'stroke' && !isStaticSvgPaintValueSupported(value)) {
      return false;
    }
    if (property === 'color' && !isStaticSvgColorValueSupported(value)) {
      return false;
    }
    if (property === 'opacity' && allowIdentityOpacity && !allowOpacity) {
      if (!isStaticSvgIdentityOpacityValueSupported(value)) {
        return false;
      }
      continue;
    }
    if (
      (property === 'opacity' || property === 'fill-opacity' || property === 'stroke-opacity')
      && !isStaticSvgOpacityValueSupported(value)
    ) {
      return false;
    }
    if (property === 'stroke-width' && !isStaticSvgNonNegativeNumericValueSupported(value)) {
      return false;
    }
    if (property === 'stroke-miterlimit' && !isStaticSvgPositiveNumericValueSupported(value)) {
      return false;
    }
    if (property === 'stroke-dasharray' && svgStrokeDashArray(value) === undefined) {
      return false;
    }
    if (property === 'stroke-dashoffset' && svgStrokeDashOffset(value) === undefined) {
      return false;
    }
    if (property === 'stroke-linejoin' && svgStrokeLineJoin(value) === null) {
      return false;
    }
    if (property === 'stroke-linecap' && svgStrokeLineCap(value) === null) {
      return false;
    }
    if (property === 'fill-rule' && !isStaticSvgFillRuleValueSupported(value)) {
      return false;
    }
  }
  return true;
}

function isStaticSvgPaintValueSupported(value: string): boolean {
  const trimmed = value.trim();
  const normalized = trimmed.toLowerCase();
  if (
    normalized.length === 0
    || STATIC_SVG_UNSUPPORTED_INDIRECT_PAINT_VALUES.has(normalized)
    || /\burl\s*\(/.test(normalized)
    || /\bvar\s*\(/.test(normalized)
  ) {
    return false;
  }
  if (normalized === 'none') {
    return true;
  }
  if (normalized === 'currentcolor') {
    return true;
  }
  if (parseSupportedCssColor(trimmed) !== null) {
    return true;
  }
  if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function') {
    return CSS.supports('color', trimmed);
  }
  return false;
}

function isStaticSvgColorValueSupported(value: string): boolean {
  const trimmed = value.trim();
  const normalized = trimmed.toLowerCase();
  return normalized !== 'none'
    && normalized !== 'currentcolor'
    && isStaticSvgPaintValueSupported(trimmed);
}

function resolveStaticSvgPaintValue(value: string, currentColor: string): string {
  return value.trim().toLowerCase() === 'currentcolor' ? currentColor : value;
}

function isStaticSvgOpacityValueSupported(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }
  const numeric = trimmed.endsWith('%') ? trimmed.slice(0, -1).trim() : trimmed;
  return numeric.length > 0 && Number.isFinite(Number(numeric));
}

function isStaticSvgIdentityOpacityValueSupported(value: string): boolean {
  const trimmed = value.trim();
  if (!isStaticSvgOpacityValueSupported(trimmed)) {
    return false;
  }
  const numeric = trimmed.endsWith('%') ? Number(trimmed.slice(0, -1).trim()) / 100 : Number(trimmed);
  return numeric === 1;
}

function isStaticSvgFillRuleValueSupported(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === 'nonzero' || normalized === 'evenodd';
}

function svgOpacity(value: string | null): number {
  if (!value) {
    return 1;
  }
  const trimmed = value.trim();
  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed)) {
    return 1;
  }
  const unitValue = trimmed.endsWith('%') ? parsed / 100 : parsed;
  return Math.max(0, Math.min(1, unitValue));
}

function svgNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const normalized = trimmed.toLowerCase();
  const numeric = normalized.endsWith('px') ? trimmed.slice(0, -2).trim() : trimmed;
  if (numeric.length === 0) {
    return null;
  }
  const number = Number(numeric);
  return Number.isFinite(number) ? number : null;
}

function svgPositiveNumber(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const number = svgNumber(value);
  return number !== null && number > 0 ? number : null;
}

function svgNonNegativeNumber(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const number = svgNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function svgStrokeLineJoin(value: string | null): CanvasLineJoin | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'miter' || normalized === 'round' || normalized === 'bevel') {
    return normalized;
  }
  return null;
}

function svgStrokeLineCap(value: string | null): CanvasLineCap | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'butt' || normalized === 'round' || normalized === 'square') {
    return normalized;
  }
  return null;
}

function svgStrokeDashArray(value: string | null): number[] | null | undefined {
  if (value === null) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.toLowerCase() === 'none') {
    return null;
  }
  const values = trimmed.split(/[\s,]+/).filter((part) => part.length > 0);
  if (values.length === 0) {
    return undefined;
  }
  const parsed = values.map((part) => svgNumber(part));
  if (parsed.some((part) => part === null || part < 0) || !parsed.some((part) => part !== null && part > 0)) {
    return undefined;
  }
  const dashValues = parsed as number[];
  return dashValues.length % 2 === 0 ? dashValues : [...dashValues, ...dashValues];
}

function svgStrokeDashOffset(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  return svgNumber(value) ?? undefined;
}

function svgFillRule(value: string | null): CanvasFillRule | undefined {
  return value?.trim().toLowerCase() === 'evenodd' ? 'evenodd' : undefined;
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function encodeBase64(bytes: Uint8Array): string {
  const runtimeBtoa = globalThis.btoa;
  if (typeof runtimeBtoa === 'function') {
    const chunkSize = 0x8000;
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.subarray(offset, offset + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return runtimeBtoa(binary);
  }

  let encoded = '';
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const first = bytes[offset];
    const second = offset + 1 < bytes.length ? bytes[offset + 1] : 0;
    const third = offset + 2 < bytes.length ? bytes[offset + 2] : 0;
    const triplet = (first << 16) | (second << 8) | third;
    encoded += BASE64_ALPHABET[(triplet >> 18) & 0x3f];
    encoded += BASE64_ALPHABET[(triplet >> 12) & 0x3f];
    encoded += offset + 1 < bytes.length ? BASE64_ALPHABET[(triplet >> 6) & 0x3f] : '=';
    encoded += offset + 2 < bytes.length ? BASE64_ALPHABET[triplet & 0x3f] : '=';
  }
  return encoded;
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

function imageEffectCacheKey(
  effect: NonNullable<LayerImageOp['effect']>,
  sourceRect?: LayerImageEffectSourceRect | null,
  brightness = 0,
  contrast = 0,
): string {
  const toneKey = brightness !== 0 || contrast !== 0
    ? `:tone:${brightness}:${contrast}`
    : '';
  if (!sourceRect) {
    return `${effect}${toneKey}`;
  }
  return [
    effect,
    toneKey,
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
  brightness = 0,
  contrast = 0,
): LayerCanvasImageSource {
  const hasEffect = !!effect && effect !== 'realPic';
  const hasTone = brightness !== 0 || contrast !== 0;
  if (!hasEffect && !hasTone) {
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
  const patternPhaseX = Math.floor(sx);
  const patternPhaseY = Math.floor(sy);
  const cacheKey = imageEffectCacheKey(effect ?? 'realPic', sourceRect, brightness, contrast);
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
  const preprocessStartMs = typeof performance !== 'undefined' ? performance.now() : 0;
  const performanceWithMemory = typeof performance !== 'undefined'
    ? performance as Performance & { memory?: { usedJSHeapSize?: number } }
    : null;
  const heapBeforeBytes = performanceWithMemory?.memory?.usedJSHeapSize;

  const usesOffscreenCanvas = typeof OffscreenCanvas !== 'undefined';
  const canvas = usesOffscreenCanvas
    ? new OffscreenCanvas(canvasWidth, canvasHeight)
    : document.createElement('canvas');
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

  applyLayerImageEffectPixels(
    pixels.data,
    canvasWidth,
    effect,
    patternPhaseX,
    patternPhaseY,
    brightness,
    contrast,
  );
  ctx.putImageData(pixels, 0, 0);
  if (diagnostics) {
    const elapsedMs = typeof performance !== 'undefined'
      ? Math.max(0, performance.now() - preprocessStartMs)
      : 0;
    const processedBytes = canvasWidth * canvasHeight * 4;
    diagnostics.preprocessedPixels += canvasWidth * canvasHeight;
    diagnostics.preprocessedBytes += processedBytes;
    diagnostics.maxPreprocessedBytes = Math.max(diagnostics.maxPreprocessedBytes, processedBytes);
    diagnostics.preprocessTimeMs += elapsedMs;
    diagnostics.maxPreprocessTimeMs = Math.max(diagnostics.maxPreprocessTimeMs, elapsedMs);
    if (usesOffscreenCanvas) {
      diagnostics.offscreenCanvasPreprocesses += 1;
    } else {
      diagnostics.htmlCanvasPreprocesses += 1;
    }
    const heapAfterBytes = performanceWithMemory?.memory?.usedJSHeapSize;
    if (Number.isFinite(heapBeforeBytes) && Number.isFinite(heapAfterBytes)) {
      const heapDeltaBytes = Math.max(0, (heapAfterBytes ?? 0) - (heapBeforeBytes ?? 0));
      diagnostics.heapDeltaBytes += heapDeltaBytes;
      diagnostics.maxHeapDeltaBytes = Math.max(diagnostics.maxHeapDeltaBytes, heapDeltaBytes);
    }
  }

  if (cache) {
    const nextByEffect = cachedByEffect ?? new Map<string, LayerCanvasImageEffectSource>();
    nextByEffect.set(cacheKey, canvas);
    if (!cachedByEffect) {
      cache.set(image, nextByEffect);
    }
  }

  return canvas;
}

export function drawCanvas2DCharOverlap(
  ctx: CanvasRenderingContext2D,
  op: LayerTextRunOp | LayerCharOverlapOp,
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
  const sizeRatio = charOverlapInnerSizeRatio(op.charOverlap.innerCharSize);
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

  const drawOverlapCell = (
    display: string,
    cx: number,
    targetTextWidth?: number,
    drawShape = true,
  ) => {
    const borderType = targetTextWidth !== undefined && op.charOverlap?.borderType === 0
      ? 1
      : op.charOverlap?.borderType ?? 0;
    const isReversed = borderType === 2 || borderType === 4;
    const isCircle = borderType === 1 || borderType === 2;
    const isRect = borderType === 3 || borderType === 4;
    const strokeColor = isReversed ? '#000000' : op.style.color;

    if (drawShape && isCircle) {
      ctx.beginPath();
      const ry = boxSize / 2;
      const rx = ry * 0.85;
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      if (isReversed) {
        ctx.fillStyle = '#000000';
        ctx.fill();
      }
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 0.8;
      ctx.stroke();
    } else if (drawShape && isRect) {
      const rx = cx - boxSize / 2;
      const ry = cy - boxSize / 2;
      if (isReversed) {
        ctx.fillStyle = '#000000';
        ctx.fillRect(rx, ry, boxSize, boxSize);
      }
      ctx.strokeStyle = strokeColor;
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
    const cx = chars.length > 1 ? originX + op.bbox.width / 2 : originX + boxSize / 2;
    chars.forEach((ch, index) => {
      const cp = ch.codePointAt(0) ?? 0;
      const display = cp >= 0x2460 && cp <= 0x2473
        ? String(cp - 0x2460 + 1)
        : puaToDisplayText(ch) ?? ch;
      drawOverlapCell(display, cx, undefined, index === 0);
    });
  }
  ctx.restore();
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
