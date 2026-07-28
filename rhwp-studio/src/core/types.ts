/** WASM getDocumentInfo() 반환 타입 */
export interface DocumentInfo {
  version: string;
  sectionCount: number;
  pageCount: number;
  encrypted: boolean;
  fallbackFont: string;
  fontsUsed: string[];  // 문서에서 사용하는 폰트 이름 목록
}

/** WASM getPageInfo() 반환 타입 */
export interface PageInfo {
  pageIndex: number;
  width: number;
  height: number;
  sectionIndex: number;
  /** 왼쪽 여백 (px) */
  marginLeft: number;
  /** 오른쪽 여백 (px) */
  marginRight: number;
  /** 위 여백 (px) */
  marginTop: number;
  /** 아래 여백 (px) */
  marginBottom: number;
  /** 머리말 여백 (px) */
  marginHeader: number;
  /** 꼬리말 여백 (px) */
  marginFooter: number;
  /** 단별 영역 (px, 페이지 좌표) */
  columns?: { x: number; width: number }[];
}

export interface LayerBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type LayerLayoutProfile = 'hwpCompat' | 'shapedModern';
export type LayerLayoutMeasurementAuthority =
  | 'legacyHwpPositions'
  | 'shapedAdvances'
  | 'shapedClusterAdvances';
export type LayerShapedMeasurementMode =
  | 'none'
  | 'diagnosticsOnly'
  | 'shadowReport'
  | 'widthInput'
  | 'lineBreakingInput'
  | 'authoritative';

export interface PageLayerTree {
  schemaVersion?: number;
  schemaMinorVersion?: number;
  schema?: {
    major: number;
    minor: number;
  };
  resourceTableVersion?: number;
  resourceTableMinorVersion?: number;
  resourceTable?: {
    major: number;
    minor: number;
  };
  unit?: 'px';
  coordinateSystem?: 'page-top-left-y-down';
  pageWidth: number;
  pageHeight: number;
  profile: LayerRenderProfile;
  /**
   * Layout migration policy. Schema v1 defaults to HWP-compatible layout
   * positions; shaped measurement is diagnostic until an opt-in profile owns
   * line-breaking changes.
   */
  layout?: {
    profile?: LayerLayoutProfile;
    measurementAuthority?: LayerLayoutMeasurementAuthority;
    shapedMeasurement?: LayerShapedMeasurementMode;
  };
  outputOptions?: {
    showParagraphMarks?: boolean;
    showControlCodes?: boolean;
    showTransparentBorders?: boolean;
    clipEnabled?: boolean;
    debugOverlay?: boolean;
  };
  buildOptions?: {
    showTransparentBorders?: boolean;
  };
  debugOptions?: {
    debugOverlay?: boolean;
  };
  debugCapabilities?: {
    overlayPaint?: boolean;
    semanticBounds?: boolean;
    genericLayerExport?: {
      overlayPaint?: boolean;
      semanticBounds?: boolean;
    };
    backends?: {
      svgLayer?: {
        overlayPaint?: boolean;
        semanticBounds?: boolean;
      };
      canvas2d?: {
        overlayPaint?: boolean;
        semanticBounds?: boolean;
      };
      canvaskit?: {
        overlayPaint?: boolean;
        semanticBounds?: boolean;
      };
      nativeSkia?: {
        overlayPaint?: boolean;
        semanticBounds?: boolean;
      };
    };
  };
  /**
   * Source-backed text identity table for schema migration toward TextRun v2.
   * Text paint ops reference this table through `source`; `text` on the op is
   * still kept as the v1 replay projection for Canvas2D/SVG compatibility.
   */
  textSources?: LayerTextSourceEntry[];
  usedFeatures?: LayerTreeFeature[];
  optionalFeatures?: LayerTreeFeature[];
  knownFeatures?: LayerTreeFeature[];
  requiredFeatures?: LayerTreeFeature[];
  text?: {
    defaultVariant?: LayerTextVariantKind;
    variants?: LayerTextVariantKind[];
    variantSelection?: 'exclusiveVariantSet';
    sourceTextPreserved?: boolean;
    clusterEncoding?: Array<'utf8' | 'utf16'>;
    fallbackRequired?: boolean;
    placementAuthority?: 'compatibilityProjection' | 'clusterPlacement';
    externalizedVisuals?: LayerTextLegacyVisualKind[];
  };
  /**
   * Schema v2 text variant envelope contract. v2 writers may use
   * `PaintOp::Text { variants }` as the canonical text paint slot while v1
   * compatibility exports keep the flattened TextRun/GlyphRun/GlyphOutline ops.
   */
  textV2?: {
    profile?: 'compatibility' | 'strictVisual';
    canonicalOp?: 'text';
    fallbackPolicy?: LayerTextFallbackPolicy;
    strictVisualFallbackFree?: boolean;
    paintOrderSlots?: 'required' | 'reserved';
  };
  resources?: LayerResources;
  fontResources?: LayerFontResources;
  root: LayerNode;
  /**
   * Phase 2 sidecar variant payloads. Schema v1 writers may still keep
   * glyphOutline in the root stream, but readers accept sidecar variants and
   * attach them to the root op referenced by anchorOpId.
   */
  variantOps?: LayerPaintOpLike[];
}

export type LayerTreeFeature =
  | 'text.paintStyle'
  | 'text.sourceTable'
  | 'text.sourceSpan'
  | 'text.variants'
  | 'text.paintOrderSlot'
  | 'text.strictVisualFallbackFree'
  | 'text.crossScopeVariants'
  | 'text.v2.placement'
  | 'text.v2.clusters'
  | 'text.projectionKind'
  | 'text.legacyVisuals'
  | 'fontResources'
  | 'fontResources.blobFaceSplit'
  | 'text.variantGroups'
  | 'text.variantOps'
  | 'text.shapeDiagnostics'
  | 'text.glyphRun'
  | 'text.outlineGlyph'
  | 'text.glyphOutline.monochromeFill'
  | 'text.glyphOutline.monochromeFillStroke'
  | 'text.glyphOutline.colorLayers'
  | 'text.glyphOutline.colorLayers.colrV0'
  | 'text.glyphOutline.colorLayers.colrV1'
  | 'text.glyphOutline.bitmapGlyph'
  | 'text.glyphOutline.svgGlyph'
  | 'text.specialVisualOps'
  | 'text.charOverlapOp'
  | 'text.controlMarkOp'
  | 'text.tabLeaderOp'
  | 'text.decorationOp'
  | 'text.layout.shapedModern'
  | 'text.vertical.mixedPerGlyph';

export interface LayerResources {
  tableId: number;
  images: Array<Uint8Array | undefined>;
  imageHashes?: string[];
  imageKeys?: string[];
  svgFragments: Array<string | undefined>;
  svgHashes?: string[];
  svgKeys?: string[];
  /**
   * Self-contained font blob payloads for portable GlyphRun replay. Entries are
   * referenced by `fontResources.blobs[].dataRef` when `kind === 'fontBlob'`.
   */
  fontBlobs?: Array<Uint8Array | number[] | string | undefined>;
  fontBlobHashes?: string[];
  fontBlobKeys?: string[];
}

export interface LayerFontResources {
  blobs: LayerFontBlobResource[];
  faces: LayerFontFaceResource[];
}

export type LayerFontResourceSource =
  | 'embedded'
  | 'bundled'
  | 'systemResolved'
  | 'externalUrl'
  | 'unresolvedFallback';

export type LayerFontPortability =
  | 'portableBlob'
  | 'externalVerified'
  | 'resolvedButNotEmbedded'
  | 'systemNameOnly'
  | 'unresolvedFallback';

export interface LayerFontDigest {
  algorithm: string;
  value: string;
}

export interface LayerBinaryResourceRef {
  kind: 'fontBlob' | 'externalFont';
  id: string;
}

export interface LayerLocalizedName {
  value: string;
  locale?: string;
}

export interface LayerFontBlobResource {
  id: string;
  source: LayerFontResourceSource;
  portability: LayerFontPortability;
  digest?: LayerFontDigest;
  dataRef?: LayerBinaryResourceRef;
}

export interface LayerFontFaceResource {
  id: string;
  blobKey: string;
  faceIndex: number;
  postscriptName?: string;
  familyNames?: LayerLocalizedName[];
  styleNames?: LayerLocalizedName[];
  weightClass?: number;
  widthClass?: number;
  italic?: boolean;
}

export type LayerNode = LayerGroupNode | LayerClipNode | LayerLeafNode;

export type LayerCacheHint = 'none' | 'staticSubtree' | 'preferRaster' | 'preferVectorRecording';
export type LayerRenderProfile = 'fast-preview' | 'screen' | 'print' | 'high-quality';

export type CanvasKitDocumentPreflightStatus = 'eligible' | 'ineligible' | 'incomplete';

export interface CanvasKitReplaySummary {
  totalItems: number;
  directItems: number;
  directRequiredItems: number;
  compatOverlayItems: number;
  textFallbackItems: number;
  unsupportedItems: number;
  hiddenOverlayViolations: number;
}

export interface CanvasKitDocumentPreflightBlocker {
  code:
    | 'pageLimitExceeded'
    | 'workLimitExceeded'
    | 'pageBuildFailed'
    | 'hiddenCanvas2dOverlayRequired'
    | 'unsupported'
    | 'textFallback'
    | 'compatOverlay';
  pageIndex: number;
  opType?: string;
  detail?: string;
}

export interface CanvasKitDocumentPreflight {
  schemaVersion: 1;
  mode: 'default' | 'compat';
  profile: LayerRenderProfile;
  status: CanvasKitDocumentPreflightStatus;
  eligible: boolean;
  complete: boolean;
  pageCount: number;
  scannedPages: number;
  scannedWorkUnits: number;
  limits: {
    maxPages: number;
    maxWorkUnits: number;
    maxBlockers: number;
    maxRequiredFontFamilies: number;
  };
  summary: CanvasKitReplaySummary;
  blockers: CanvasKitDocumentPreflightBlocker[];
  requiredFontFamilies: string[];
  capabilityDigest: string;
}

export type LayerSemanticRole =
  | 'generic'
  | 'page'
  | 'masterPage'
  | 'header'
  | 'footer'
  | 'body'
  | 'column'
  | 'footnoteArea'
  | 'textLine'
  | 'table'
  | 'tableCell'
  | 'textBox'
  | 'group';

export interface LayerSemantic {
  role: LayerSemanticRole;
  sectionIndex?: number;
  columnIndex?: number;
  paraIndex?: number;
  controlIndex?: number;
  rowCount?: number;
  colCount?: number;
}

export interface LayerGroupNode {
  bounds: LayerBounds;
  kind: 'group';
  sourceNodeId?: number;
  semantic?: LayerSemantic;
  cacheHint: LayerCacheHint;
  children: LayerNode[];
}

export interface LayerClipNode {
  bounds: LayerBounds;
  kind: 'clipRect';
  sourceNodeId?: number;
  semantic?: LayerSemantic;
  clip: LayerBounds;
  clipKind: 'body' | 'tableCell' | 'textBox' | 'generic';
  clipPolicy?: {
    rightOverflowSlop?: number;
    allowHorizontalOverflowControls?: boolean;
  };
  child: LayerNode;
}

export interface LayerLeafNode {
  bounds: LayerBounds;
  kind: 'leaf';
  sourceNodeId?: number;
  semantic?: LayerSemantic;
  cacheHint: LayerCacheHint;
  ops: LayerPaintOpLike[];
}

export type LayerKnownPaintOp =
  | LayerPageBackgroundOp
  | LayerTextOp
  | LayerTextRunOp
  | LayerGlyphRunOp
  | LayerGlyphOutlineOp
  | LayerCharOverlapOp
  | LayerTextControlMarkOp
  | LayerTabLeaderOp
  | LayerTextDecorationOp
  | LayerFootnoteMarkerOp
  | LayerLineOp
  | LayerRectangleOp
  | LayerEllipseOp
  | LayerPathOp
  | LayerImageOp
  | LayerEquationOp
  | LayerFormObjectOp;

export type LayerPaintOp = LayerKnownPaintOp;

export interface LayerUnknownPaintOp {
  type: string;
  bbox?: LayerBounds;
  [key: string]: unknown;
}

export type LayerPaintOpLike = LayerKnownPaintOp | LayerUnknownPaintOp;

const KNOWN_LAYER_PAINT_OP_TYPES = new Set([
  'pageBackground',
  'text',
  'textRun',
  'glyphRun',
  'glyphOutline',
  'charOverlap',
  'textControlMark',
  'tabLeader',
  'textDecoration',
  'footnoteMarker',
  'line',
  'rectangle',
  'ellipse',
  'path',
  'image',
  'equation',
  'formObject',
]);

export function isKnownLayerPaintOp(op: LayerPaintOpLike): op is LayerKnownPaintOp {
  return KNOWN_LAYER_PAINT_OP_TYPES.has(op.type);
}

export function assertNeverLayerPaintOp(op: never): never {
  const type = (op as { type?: unknown }).type;
  throw new Error(`Unhandled layer paint op type: ${String(type)}`);
}

export interface LayerTextStyle {
  fontFamily: string;
  fontSize: number;
  color: string;
  bold: boolean;
  italic: boolean;
  ratio: number;
  underline: 'none' | 'bottom' | 'top';
  underlineShape: number;
  strikethrough: boolean;
  strikeShape: number;
  outlineType: number;
  shadowType: number;
  shadowColor: string;
  shadowOffsetX: number;
  shadowOffsetY: number;
  emboss: boolean;
  engrave: boolean;
  superscript: boolean;
  subscript: boolean;
  emphasisDot: number;
  underlineColor: string;
  strikeColor: string;
  shadeColor: string;
}

export interface LayerTabLeader {
  startX: number;
  endX: number;
  fillType: number;
}

export interface LayerTextControlMark {
  kind: 'space' | 'tab' | 'paragraphEnd' | 'lineBreakEnd';
  text: string;
  x: number;
  y: number;
  fontSize: number;
}

export interface LayerCharOverlap {
  borderType: number;
  innerCharSize: number;
}

export type LayerTextLegacyVisualKind = 'charOverlap' | 'controlMarks' | 'tabLeaders' | 'decorations';
export type LayerTextLegacyVisualState = 'canonical' | 'mirror';

export type LayerTextLegacyVisuals = Partial<
  Record<LayerTextLegacyVisualKind, LayerTextLegacyVisualState>
>;

export interface LayerTextSourceRange {
  start: number;
  end: number;
}

export interface LayerTextSourceSpan {
  /**
   * Export-local dense id. Do not persist this across layer exports; use
   * stableSourceKey when present for revision-aware diff/editing/cache keys.
   */
  id: number;
  utf8Range: LayerTextSourceRange;
  utf16Range?: LayerTextSourceRange;
  stableSourceKey?: LayerStableTextSourceKey;
}

export type LayerTextSourceAnnotation =
  | {
      kind: 'fieldMarker';
      marker: 'fieldBegin' | 'fieldEnd' | 'fieldBeginEnd' | 'shapeMarker';
      rangeUtf8: LayerTextSourceRange;
      rangeUtf16?: LayerTextSourceRange;
      shapeMarkerIndex?: number;
    }
  | {
      kind: 'paragraphEnd' | 'lineBreakEnd';
      offsetUtf8: number;
      offsetUtf16?: number;
    };

export interface LayerTextSourceEntry {
  /**
   * Export-local dense id. It is only stable within this layer tree export.
   */
  id: number;
  stableSourceKey?: LayerStableTextSourceKey;
  text: string;
  utf8Range: LayerTextSourceRange;
  utf16Range?: LayerTextSourceRange;
  annotations?: LayerTextSourceAnnotation[];
}

export interface LayerStableTextSourceKey {
  scheme: 'hwp-source-v1' | string;
  section?: number;
  paragraph?: number;
  controlPath?: Array<{
    kind: string;
    index?: number;
    row?: number;
    col?: number;
  }>;
  textNode?: number;
  revision?: string;
}

export interface LayerPoint {
  x: number;
  y: number;
}

export interface LayerVector {
  dx: number;
  dy: number;
}

export interface LayerAffineTransform {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface LayerTextRunPlacement {
  /**
   * Canonical TextRun v2 placement. Cluster coordinates are run-local, with
   * the local baseline at y=0, and this transform maps them to page space.
   */
  runToPage: LayerAffineTransform;
  baselineY?: number;
}

export type LayerTextClusterBasis =
  | 'legacyPosition'
  | 'grapheme'
  | 'layoutPlacement'
  | 'shapingEquivalent';

export type LayerTextProjectionKind =
  | 'verbatim'
  | 'normalized'
  | 'controlProjection'
  | 'fieldProjection'
  | 'syntheticVisual';

export type LayerTextClusterFlag = 'specialVisual' | 'notShapingCandidate';

export interface LayerTextClusterPlacement {
  sourceRangeUtf8: LayerTextSourceRange;
  textRangeUtf8: LayerTextSourceRange;
  textRangeUtf16?: LayerTextSourceRange;
  projection: LayerTextProjectionKind;
  origin: LayerPoint;
  advance?: LayerVector;
  flags?: LayerTextClusterFlag[];
}

export type LayerTextVariantKind = 'textRun' | 'glyphRun' | 'glyphOutline';
export type LayerTextFallbackPolicy = 'required' | 'none';
export type LayerTextVariantSelectionPolicy = 'exclusiveVariantSet';
export type LayerTextPaintOrderSlotId = string;
export type LayerTextPaintScopeRef = string;
export type LayerTextVariantQuality =
  | 'exact'
  | 'positionAdjusted'
  | 'approximate'
  | 'diagnosticOnly'
  | 'omitted';

export interface LayerTextVariantMeta {
  /**
   * Variants with the same equivalenceGroup represent the same visual text.
   * Consumers choose exactly one variantId from the group and paint every part
   * belonging to that variant set.
   */
  equivalenceGroup: string;
  variantId: string;
  variantKind: LayerTextVariantKind;
  partIndex?: number;
  partCount?: number;
  isDefaultFallback?: boolean;
  requires?: LayerTreeFeature[];
  quality?: LayerTextVariantQuality;
  /**
   * Root paint-order anchor used by strict visual sidecar variants such as
   * GlyphOutline. Consumers paint the selected variant set at the anchor slot.
   */
  anchorOpId?: string;
  /** Ordering inside the selected variant set at the anchor slot. */
  localPaintOrder?: number;
}

export type LayerTextVariantPayload = LayerTextRunOp | LayerGlyphRunOp | LayerGlyphOutlineOp;

export interface LayerTextVariantPart {
  partIndex?: number;
  partCount?: number;
  localPaintOrder?: number;
  scopeRef?: LayerTextPaintScopeRef;
  payload: LayerTextVariantPayload;
}

export interface LayerTextVariantSet {
  variantId: string;
  kind: LayerTextVariantKind;
  requiredFeatures?: LayerTreeFeature[];
  optionalFeatures?: LayerTreeFeature[];
  quality?: LayerTextVariantQuality;
  parts: LayerTextVariantPart[];
}

export interface LayerTextOp {
  id?: string;
  type: 'text';
  bbox: LayerBounds;
  paintOrderSlotId: LayerTextPaintOrderSlotId;
  source?: LayerTextSourceSpan;
  selectionPolicy?: LayerTextVariantSelectionPolicy;
  defaultVariantId: string;
  fallbackPolicy?: LayerTextFallbackPolicy;
  variants: LayerTextVariantSet[];
}

export interface LayerVariationAxisValue {
  tag: string;
  value: number;
}

export interface LayerOpenTypeFeatureSetting {
  tag: string;
  enabled: boolean;
  value?: number;
}

export interface LayerFontInstanceKey {
  faceKey: string;
  sizePx: number;
  variations?: LayerVariationAxisValue[];
  syntheticBold?: boolean;
  syntheticItalic?: boolean;
}

export type LayerTextDirection = 'ltr' | 'rtl' | 'auto';
export type LayerWritingMode = 'horizontal-tb' | 'vertical-rl' | 'vertical-lr';

export interface LayerShapeKey {
  fontInstance: LayerFontInstanceKey;
  direction: LayerTextDirection;
  writingMode: LayerWritingMode;
  script?: string;
  language?: string;
  features?: LayerOpenTypeFeatureSetting[];
  shapingEngine: string;
  fallbackPolicy: string;
}

export type LayerGlyphRunOrientation =
  | 'horizontal'
  | 'vertical-upright'
  | 'vertical-sideways'
  | 'mixedPerGlyph';

export type LayerGlyphRunReplayEligibility =
  | 'portable'
  | 'conditionalExternalFont'
  | 'localDiagnosticOnly'
  | 'notReplayable';

export interface LayerGlyphRange {
  start: number;
  end: number;
}

export type LayerGlyphClusterFlag = 'ligature' | 'fallbackBoundary';

export interface LayerGlyphCluster {
  sourceRangeUtf8: LayerTextSourceRange;
  sourceRangeUtf16?: LayerTextSourceRange;
  textRangeUtf8?: LayerTextSourceRange;
  glyphRange: LayerGlyphRange;
  flags?: LayerGlyphClusterFlag[];
}

export interface LayerGlyphTransform {
  xx: number;
  xy: number;
  yx: number;
  yy: number;
  tx: number;
  ty: number;
}

export interface LayerGlyphRunDiagnostics {
  quality: LayerTextVariantQuality;
  replayEligibility: LayerGlyphRunReplayEligibility;
  strictVisualEligible: boolean;
  maxOriginDeltaPx: number;
  maxAdvanceDeltaPx: number;
  maxResidualAfterAdjustmentPx: number;
  clusterMismatchCount: number;
  missingGlyphCount: number;
  usedFallbackFontCount: number;
  reason?: string;
}

export interface LayerShapeShadow {
  shadowType: number;
  color: string;
  offsetX: number;
  offsetY: number;
  alpha: number;
}

export interface LayerPatternFill {
  patternType: number;
  patternColor: string;
  backgroundColor: string;
}

export interface LayerShapeStyle {
  fillColor: string | null;
  strokeColor: string | null;
  strokeWidth: number;
  strokeDash: 'solid' | 'dash' | 'dot' | 'dashDot' | 'dashDotDot';
  opacity: number;
  pattern?: LayerPatternFill;
  shadow?: LayerShapeShadow;
}

export interface LayerLineStyle {
  color: string;
  width: number;
  dash: 'solid' | 'dash' | 'dot' | 'dashDot' | 'dashDotDot';
  lineType: 'single' | 'double' | 'thinThickDouble' | 'thickThinDouble' | 'thinThickThinTriple';
  startArrow: string;
  endArrow: string;
  startArrowSize: number;
  endArrowSize: number;
  shadow?: LayerShapeShadow;
}

export interface LayerTransform {
  rotation: number;
  horzFlip: boolean;
  vertFlip: boolean;
}

export interface LayerGradient {
  gradientType: number;
  angle: number;
  centerX: number;
  centerY: number;
  colors: string[];
  positions: number[];
}

export type LayerPathCommand =
  | { type: 'moveTo'; x: number; y: number }
  | { type: 'lineTo'; x: number; y: number }
  | { type: 'curveTo'; x1: number; y1: number; x2: number; y2: number; x3: number; y3: number }
  | { type: 'arcTo'; rx: number; ry: number; rotation: number; largeArc: boolean; sweep: boolean; x: number; y: number }
  | { type: 'closePath' };

export interface LayerPageBackgroundOp {
  type: 'pageBackground';
  bbox: LayerBounds;
  backgroundColor?: string;
  borderColor?: string;
  borderWidth: number;
  gradient?: LayerGradient;
  image?: {
    fillMode: string;
    effect?: LayerImageOp['effect'];
    brightness?: number;
    contrast?: number;
    resourceId?: number;
    base64?: string;
  };
}

export interface LayerTextRunOp {
  /** Optional paint op identity used as a sidecar variant anchor. */
  id?: string;
  type: 'textRun';
  bbox: LayerBounds;
  text: string;
  /**
   * Paint-only text projection for HWP private-use characters. `text` remains
   * the source-preserving replay identity; renderers should prefer
   * `displayText` with `displayPositions` when present.
   */
  displayText?: string;
  /**
   * Source identity for search/accessibility/debug/editing. Rendering keeps the
   * v1 `text` projection as the browser-friendly fallback.
   */
  source?: LayerTextSourceSpan;
  baseline: number;
  rotation: number;
  isVertical: boolean;
  orientation?: 'horizontal' | 'vertical-upright' | 'vertical-sideways';
  projectionKind?: LayerTextProjectionKind;
  clusterBasis?: LayerTextClusterBasis;
  /**
   * Future TextRun v2 placement. Current renderers still consume the v1
   * baseline/rotation/positions projection when this field is absent.
   */
  placement?: LayerTextRunPlacement;
  clusters?: LayerTextClusterPlacement[];
  variant?: LayerTextVariantMeta;
  fieldMarker?: 'none' | 'fieldBegin' | 'fieldEnd' | 'fieldBeginEnd' | 'shapeMarker';
  shapeMarkerIndex?: number;
  isParaEnd?: boolean;
  isLineBreakEnd?: boolean;
  /**
   * Paint-only text style projection for the schema migration path toward
   * lower-level glyph replay. `style` remains for v1 compatibility.
   */
  paintStyle?: LayerTextStyle;
  /**
   * Indicates whether legacy inline visual payloads remain canonical or are
   * mirrors of future external PaintOps. Consumers that support externalized
   * visual ops must skip mirror payloads to avoid double paint.
   */
  legacyVisuals?: LayerTextLegacyVisuals;
  style: LayerTextStyle;
  positions: number[];
  displayPositions?: number[];
  controlMarks?: LayerTextControlMark[];
  charOverlap?: LayerCharOverlap;
  tabLeaders?: LayerTabLeader[];
}

export interface LayerGlyphRunOp {
  id?: string;
  type: 'glyphRun';
  bbox: LayerBounds;
  source: LayerTextSourceSpan;
  variant: LayerTextVariantMeta;
  paintStyle: LayerTextStyle;
  shapeKey: LayerShapeKey;
  placement: LayerTextRunPlacement;
  glyphIds: number[];
  positions: LayerPoint[];
  advances?: LayerVector[];
  clusters: LayerGlyphCluster[];
  direction: LayerTextDirection;
  bidiLevel?: number;
  writingMode: LayerWritingMode;
  orientation: LayerGlyphRunOrientation;
  glyphTransforms?: LayerGlyphTransform[];
  diagnostics: LayerGlyphRunDiagnostics;
}

export interface LayerGlyphOutlinePath {
  glyphId?: number;
  sourceRangeUtf8?: LayerTextSourceRange;
  glyphRange?: { start: number; end: number };
  commands: LayerPathCommand[];
  fillRule?: CanvasFillRule;
}

export type LayerGlyphOutlinePayloadKind =
  | 'monochromeFill'
  | 'monochromeFillStroke'
  | 'colorLayers'
  | 'bitmapGlyph'
  | 'svgGlyph';

export type LayerGlyphOutlineStrokeJoin = 'miter' | 'round' | 'bevel';
export type LayerGlyphOutlineStrokeCap = 'butt' | 'round' | 'square';
export type LayerGlyphOutlinePaintOrder =
  | 'fillOnly'
  | 'strokeOnly'
  | 'fillThenStroke'
  | 'strokeThenFill';

export interface LayerGlyphOutlineStrokeStyle {
  widthPx: number;
  color?: string;
  opacity?: number;
  join?: LayerGlyphOutlineStrokeJoin;
  cap?: LayerGlyphOutlineStrokeCap;
  miterLimit?: number;
  paintOrder?: LayerGlyphOutlinePaintOrder;
}

export type LayerGlyphOutlineColorFormat = 'colrV0' | 'colrV1' | 'other';

export interface LayerGlyphOutlineFontColorGlyphRef {
  faceKey?: string;
  glyphId?: number;
  paletteIndex?: number;
  colorFormat?: LayerGlyphOutlineColorFormat;
}

export interface LayerGlyphOutlinePaletteRef {
  id?: string;
  index?: number;
  cpalDigest?: string;
}

export interface LayerGlyphOutlineResolvedColor {
  colorSpace?: string;
  rgba: [number, number, number, number];
}

export interface LayerGlyphOutlineColorLayerNode {
  layerIndex?: number;
  glyphId?: number;
  glyphRange?: { start: number; end: number };
  sourceRangeUtf8?: LayerTextSourceRange;
  sourceFontRef?: LayerGlyphOutlineFontColorGlyphRef;
  pathIndex?: number;
  commands?: LayerPathCommand[];
  fill?: LayerGlyphOutlineResolvedColor;
  fillRule?: CanvasFillRule;
  paletteIndex?: number;
  color?: string;
  opacity?: number;
  transformToRun?: LayerAffineTransform;
}

export type LayerGlyphOutlineColorPaintGraphNodeKind =
  | 'solidPath'
  | 'linearGradientPath'
  | 'radialGradientPath'
  | 'sweepGradientPath'
  | 'transform'
  | 'composite'
  | 'clip';

export interface LayerGlyphOutlineColorSolidPathNode {
  commands: LayerPathCommand[];
  fill: LayerGlyphOutlineResolvedColor;
  fillRule: CanvasFillRule;
  sourceGlyphId?: number;
  paletteIndex?: number;
}

export interface LayerGlyphOutlineColorGradientStop {
  offset: number;
  color: LayerGlyphOutlineResolvedColor;
}

export interface LayerGlyphOutlineColorLinearGradient {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  stops: LayerGlyphOutlineColorGradientStop[];
}

export interface LayerGlyphOutlineColorRadialGradient {
  cx: number;
  cy: number;
  radius: number;
  stops: LayerGlyphOutlineColorGradientStop[];
}

export interface LayerGlyphOutlineColorSweepGradient {
  cx: number;
  cy: number;
  startAngleDegrees: number;
  endAngleDegrees: number;
  stops: LayerGlyphOutlineColorGradientStop[];
}

export interface LayerGlyphOutlineColorLinearGradientPathNode {
  commands: LayerPathCommand[];
  gradient: LayerGlyphOutlineColorLinearGradient;
  fillRule: CanvasFillRule;
  sourceGlyphId?: number;
  paletteIndex?: number;
}

export interface LayerGlyphOutlineColorRadialGradientPathNode {
  commands: LayerPathCommand[];
  gradient: LayerGlyphOutlineColorRadialGradient;
  fillRule: CanvasFillRule;
  sourceGlyphId?: number;
  paletteIndex?: number;
}

export interface LayerGlyphOutlineColorSweepGradientPathNode {
  commands: LayerPathCommand[];
  gradient: LayerGlyphOutlineColorSweepGradient;
  fillRule: CanvasFillRule;
  sourceGlyphId?: number;
  paletteIndex?: number;
}

export interface LayerGlyphOutlineColorTransformNode {
  childNodeId: number;
  transform: LayerAffineTransform;
}

export type LayerGlyphOutlineColorCompositeMode = 'sourceOver';

export interface LayerGlyphOutlineColorCompositeNode {
  sourceNodeId: number;
  backdropNodeId: number;
  mode: LayerGlyphOutlineColorCompositeMode;
}

export interface LayerGlyphOutlineColorClipNode {
  childNodeId: number;
  clipCommands: LayerPathCommand[];
  fillRule: CanvasFillRule;
}

export interface LayerGlyphOutlineColorPaintGraphNode {
  nodeId: number;
  kind: LayerGlyphOutlineColorPaintGraphNodeKind;
  solidPath?: LayerGlyphOutlineColorSolidPathNode;
  linearGradientPath?: LayerGlyphOutlineColorLinearGradientPathNode;
  radialGradientPath?: LayerGlyphOutlineColorRadialGradientPathNode;
  sweepGradientPath?: LayerGlyphOutlineColorSweepGradientPathNode;
  transform?: LayerGlyphOutlineColorTransformNode;
  composite?: LayerGlyphOutlineColorCompositeNode;
  clip?: LayerGlyphOutlineColorClipNode;
  sourceRangeUtf8?: LayerTextSourceRange;
  glyphRange?: { start: number; end: number };
  sourceFontRef?: LayerGlyphOutlineFontColorGlyphRef;
}

export interface LayerGlyphOutlineColorPaintGraphPayload {
  rootNodeId: number;
  nodes: LayerGlyphOutlineColorPaintGraphNode[];
}

export interface LayerGlyphOutlineColorLayersPayload {
  colorFormat: LayerGlyphOutlineColorFormat;
  sourceFontRef?: LayerGlyphOutlineFontColorGlyphRef;
  paletteRef?: LayerGlyphOutlinePaletteRef;
  layers: LayerGlyphOutlineColorLayerNode[];
  paintGraph?: LayerGlyphOutlineColorPaintGraphPayload;
  sourceRangeUtf8?: LayerTextSourceRange;
  glyphRange?: { start: number; end: number };
  colrv0ResolvedLayerContract?: boolean;
  colrv1Stage1GraphContract?: boolean;
  colrv1SupportedGraphContract?: boolean;
}

export type LayerBitmapStrikeSelection =
  | 'producerResolved'
  | 'diagnosticOnly';
export type LayerBitmapAlphaMode = 'premultiplied' | 'straight';
export type LayerBitmapGlyphScalingPolicy =
  | 'noScale'
  | 'scaleToEm'
  | 'explicitTransform'
  | 'backendDefault';
export type LayerBitmapGlyphFiltering =
  | 'nearest'
  | 'linear'
  | 'backendDefault';

export interface LayerGlyphOutlineBitmapGlyphPayload {
  imageResourceId: string | number;
  sourceRangeUtf8?: LayerTextSourceRange;
  glyphRange?: { start: number; end: number };
  placement?: LayerTextRunPlacement;
  transformToRun?: LayerAffineTransform;
  strikePpem?: [number, number];
  strikeSelection?: LayerBitmapStrikeSelection;
  pixelFormat?: string;
  colorSpace?: string;
  alphaMode?: LayerBitmapAlphaMode;
  scalingPolicy?: LayerBitmapGlyphScalingPolicy;
  filtering?: LayerBitmapGlyphFiltering;
}

export type LayerSvgGlyphSecurityMode = 'staticSanitized';

export interface LayerSvgGlyphViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayerSvgGlyphIntrinsicSize {
  width: number;
  height: number;
}

export interface LayerGlyphOutlineSvgGlyphPayload {
  vectorResourceId: string | number;
  sourceRangeUtf8?: LayerTextSourceRange;
  glyphRange?: { start: number; end: number };
  placement?: LayerTextRunPlacement;
  transformToRun?: LayerAffineTransform;
  viewBox: LayerSvgGlyphViewBox;
  intrinsicSize?: LayerSvgGlyphIntrinsicSize;
  securityMode: LayerSvgGlyphSecurityMode;
  scriptAllowed: false;
  animationAllowed: false;
  externalResourcesAllowed: false;
  interactivityAllowed: false;
}

export interface LayerGlyphOutlineOp {
  id?: string;
  type: 'glyphOutline';
  /**
   * Optional top-level sidecar anchor. variant.anchorOpId remains the canonical
   * schema v1 location; readers accept both so Phase 2 sidecars can mirror the
   * documented JSON shape.
   */
  anchorOpId?: string;
  bbox: LayerBounds;
  source: LayerTextSourceSpan;
  variant: LayerTextVariantMeta;
  paintStyle: LayerTextStyle;
  /**
   * Schema v2 vocabulary reserves richer payload families, but current strict
   * replay accepts the gated monotone, color layer, bitmap glyph, and static
   * sanitized SVG glyph subsets.
   */
  payloadKind?: LayerGlyphOutlinePayloadKind;
  stroke?: LayerGlyphOutlineStrokeStyle;
  /**
   * Richer payload envelopes. BitmapGlyph is feature-gated for strict replay
   * in CanvasKit and SVG/Canvas2D; other families document schema v2 payload
   * shape until their writer gates land.
   */
  colorLayers?: LayerGlyphOutlineColorLayersPayload;
  bitmapGlyph?: LayerGlyphOutlineBitmapGlyphPayload;
  svgGlyph?: LayerGlyphOutlineSvgGlyphPayload;
  placement: LayerTextRunPlacement;
  paths: LayerGlyphOutlinePath[];
  diagnostics: LayerGlyphRunDiagnostics;
}

export interface LayerCharOverlapOp {
  type: 'charOverlap';
  bbox: LayerBounds;
  text: string;
  source?: LayerTextSourceSpan;
  baseline: number;
  rotation: number;
  isVertical: boolean;
  orientation?: 'horizontal' | 'vertical-upright' | 'vertical-sideways';
  style: LayerTextStyle;
  paintStyle?: LayerTextStyle;
  positions: number[];
  charOverlap: LayerCharOverlap;
}

export interface LayerTextControlMarkOp {
  type: 'textControlMark';
  bbox: LayerBounds;
  source?: LayerTextSourceSpan;
  mark: LayerTextControlMark;
}

export interface LayerTabLeaderOp {
  type: 'tabLeader';
  bbox: LayerBounds;
  source?: LayerTextSourceSpan;
  leader: LayerTabLeader;
  color: string;
  fontSize: number;
  baseline: number;
}

export type LayerTextDecorationKind = 'underline' | 'strikethrough' | 'emphasisDot';

export interface LayerTextDecoration {
  kind: LayerTextDecorationKind;
  baseline: number;
  rotation: number;
  fontSize: number;
  ratio: number;
  color: string;
  shape: number;
  underline: 'none' | 'bottom' | 'top';
  emphasisDot: number;
  positions: number[];
}

export interface LayerTextDecorationOp {
  type: 'textDecoration';
  bbox: LayerBounds;
  source?: LayerTextSourceSpan;
  decoration: LayerTextDecoration;
}

export interface LayerFootnoteMarkerOp {
  type: 'footnoteMarker';
  bbox: LayerBounds;
  text: string;
  fontFamily: string;
  fontSize: number;
  color: string;
}

export interface LayerLineOp {
  type: 'line';
  bbox: LayerBounds;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  style: LayerLineStyle;
  transform: LayerTransform;
}

export interface LayerRectangleOp {
  type: 'rectangle';
  bbox: LayerBounds;
  cornerRadius: number;
  style: LayerShapeStyle;
  gradient?: LayerGradient;
  transform: LayerTransform;
}

export interface LayerEllipseOp {
  type: 'ellipse';
  bbox: LayerBounds;
  style: LayerShapeStyle;
  gradient?: LayerGradient;
  transform: LayerTransform;
}

export interface LayerPathOp {
  type: 'path';
  bbox: LayerBounds;
  commands: LayerPathCommand[];
  style: LayerShapeStyle;
  gradient?: LayerGradient;
  connectorEndpoints?: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  };
  lineStyle?: LayerLineStyle;
  transform: LayerTransform;
}

export interface LayerImageOp {
  type: 'image';
  bbox: LayerBounds;
  resourceId?: number;
  base64?: string;
  /** Original linked-image path emitted for diagnostics before injected bytes are available. */
  externalPath?: string;
  wrap?: 'square' | 'tight' | 'through' | 'topAndBottom' | 'behindText' | 'inFrontOfText';
  fillMode?: string;
  effect?: 'realPic' | 'grayScale' | 'blackWhite' | 'pattern8x8';
  brightness?: number;
  contrast?: number;
  originalSize?: {
    width: number;
    height: number;
  };
  crop?: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  };
  /** Full HWP/HWPX crop coordinate range from `imgDim`. */
  originalSizeHu?: [number, number];
  transform: LayerTransform;
}

export type LayerEquationMatrixStyle = 'plain' | 'paren' | 'bracket' | 'vert';
export type LayerEquationDecoration =
  | 'hat'
  | 'check'
  | 'tilde'
  | 'acute'
  | 'grave'
  | 'dot'
  | 'dDot'
  | 'bar'
  | 'vec'
  | 'dyad'
  | 'under'
  | 'arch'
  | 'underline'
  | 'overline'
  | 'strikeThrough';
export type LayerEquationFontStyle = 'roman' | 'italic' | 'bold';

export interface LayerEquationLayoutBox {
  x: number;
  y: number;
  width: number;
  height: number;
  baseline: number;
  kind: LayerEquationLayoutKind;
}

export type LayerEquationLayoutKind =
  | { type: 'row'; children: LayerEquationLayoutBox[] }
  | { type: 'text'; text: string }
  | { type: 'number'; text: string }
  | { type: 'symbol'; text: string }
  | { type: 'mathSymbol'; text: string }
  | { type: 'function'; name: string }
  | { type: 'fraction'; numer: LayerEquationLayoutBox; denom: LayerEquationLayoutBox }
  | { type: 'sqrt'; body: LayerEquationLayoutBox; index?: LayerEquationLayoutBox }
  | { type: 'superscript'; base: LayerEquationLayoutBox; sup: LayerEquationLayoutBox }
  | { type: 'subscript'; base: LayerEquationLayoutBox; sub: LayerEquationLayoutBox }
  | { type: 'subSup'; base: LayerEquationLayoutBox; sub: LayerEquationLayoutBox; sup: LayerEquationLayoutBox }
  | { type: 'bigOp'; symbol: string; sub?: LayerEquationLayoutBox; sup?: LayerEquationLayoutBox }
  | { type: 'limit'; isUpper: boolean; sub?: LayerEquationLayoutBox }
  | { type: 'matrix'; style: LayerEquationMatrixStyle; cells: LayerEquationLayoutBox[][] }
  | { type: 'rel'; arrow: LayerEquationLayoutBox; over: LayerEquationLayoutBox; under?: LayerEquationLayoutBox }
  | { type: 'eqAlign'; rows: Array<{ left: LayerEquationLayoutBox; right: LayerEquationLayoutBox }> }
  | { type: 'paren'; left: string; right: string; body: LayerEquationLayoutBox }
  | { type: 'decoration'; decoration: LayerEquationDecoration; body: LayerEquationLayoutBox }
  | { type: 'fontStyle'; fontStyle: LayerEquationFontStyle; body: LayerEquationLayoutBox }
  | { type: 'space'; width: number }
  | { type: 'newline' }
  | { type: 'empty' };

export interface LayerEquationOp {
  type: 'equation';
  bbox: LayerBounds;
  color: string;
  fontSize: number;
  svgResourceId?: number;
  svgContent?: string;
  layoutBox: LayerEquationLayoutBox;
}

export interface LayerFormObjectOp {
  type: 'formObject';
  bbox: LayerBounds;
  formType: string;
  caption: string;
  text: string;
  foreColor: string;
  backColor: string;
  value: number;
  enabled: boolean;
}

/** WASM getPageDef() 반환 타입 — HWPUNIT 원본값 */
export interface PageDef {
  width: number;
  height: number;
  marginLeft: number;
  marginRight: number;
  marginTop: number;
  marginBottom: number;
  marginHeader: number;
  marginFooter: number;
  marginGutter: number;
  landscape: boolean;
  /** 0=한쪽, 1=맞쪽, 2=위로 */
  binding: number;
}

/** 구역 정의 (SectionDef) */
export interface SectionDef {
  pageNum: number;
  /** 쪽 번호 종류: 0=이어서, 1=홀수, 2=짝수 (사용자 지정은 pageNum > 0) */
  pageNumType: number;
  pictureNum: number;
  tableNum: number;
  equationNum: number;
  columnSpacing: number;
  defaultTabSpacing: number;
  hideHeader: boolean;
  hideFooter: boolean;
  hideMasterPage: boolean;
  hideBorder: boolean;
  hideFill: boolean;
  hideEmptyLine: boolean;
}

/** 중첩 표 경로 엔트리 (1레벨 = 단일 표, 2레벨 이상 = 중첩 표) */
export interface CellPathEntry {
  controlIndex: number;
  cellIndex: number;
  cellParaIndex: number;
}

/** 문서 트리 DFS 순회 컨텍스트 엔트리 */
export interface NavContextEntry {
  parentPara: number;
  ctrlIdx: number;
  ctrlTextPos: number;
  cellIdx: number;
  isTextBox: boolean;
}

/** WASM getCursorRect() 반환 타입 */
export interface CursorRect {
  pageIndex: number;
  x: number;
  y: number;
  height: number;
}

/** WASM hitTestBodyFootnoteMarker() 반환 타입 */
export interface BodyFootnoteMarkerHit {
  hit: boolean;
  sectionIndex?: number;
  paragraphIndex?: number;
  controlIndex?: number;
  footnoteNumber?: number;
  footnoteIndex?: number;
  bbox?: { x: number; y: number; w: number; h: number };
  cursorRect?: CursorRect;
}

/** WASM hitTest() 반환 타입 */
export interface HitTestResult {
  sectionIndex: number;
  paragraphIndex: number;
  charOffset: number;
  /** 셀/글상자 컨텍스트 (셀 또는 글상자 내부 클릭 시에만 존재) */
  parentParaIndex?: number;
  controlIndex?: number;
  cellIndex?: number;
  cellParaIndex?: number;
  /** 중첩 표 전체 경로 (depth 1=단일 표, depth 2+=중첩 표) */
  cellPath?: CellPathEntry[];
  /** 글상자 내부 여부 */
  isTextBox?: boolean;
  /** 필드 내부 여부 (ClickHere 등) */
  isField?: boolean;
  /** 필드 ID (isField=true일 때) */
  fieldId?: number;
  /** 필드 타입 ("clickhere" 등) */
  fieldType?: string;
}

/** WASM getFootnoteAtCursor() 반환 타입 */
export interface FootnoteAtCursorResult {
  hit: boolean;
  sectionIndex?: number;
  paragraphIndex?: number;
  controlIndex?: number;
  charOffset?: number;
  footnoteNumber?: number;
}

/** WASM deleteFootnote() 반환 타입 */
export interface DeleteFootnoteResult {
  ok: boolean;
  sectionIndex: number;
  paragraphIndex: number;
  controlIndex: number;
  charOffset: number;
  deletedNumber: number;
}

/** 커서 위치의 필드 범위 정보 */
export interface FieldInfoResult {
  inField: boolean;
  fieldId?: number;
  fieldType?: string;
  startCharIdx?: number;
  endCharIdx?: number;
  isGuide?: boolean;
  guideName?: string;
}

/** WASM getLineInfo() 반환 타입 */
export interface LineInfo {
  lineIndex: number;
  lineCount: number;
  charStart: number;
  charEnd: number;
}

/** WASM getTableDimensions() 반환 타입 */
export interface TableDimensions {
  rowCount: number;
  colCount: number;
  cellCount: number;
}

/** WASM getCellInfo() 반환 타입 */
export interface CellInfo {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
}

/** WASM getTableCellBboxes() 반환 타입 */
export interface CellBbox {
  cellIdx: number;
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  pageIndex: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** WASM moveVertical() 반환 타입 */
export interface MoveVerticalResult {
  sectionIndex: number;
  paragraphIndex: number;
  charOffset: number;
  parentParaIndex?: number;
  controlIndex?: number;
  cellIndex?: number;
  cellParaIndex?: number;
  /** 중첩 표 전체 경로 */
  cellPath?: CellPathEntry[];
  /** 글상자 내부 여부 */
  isTextBox?: boolean;
  pageIndex: number;
  x: number;
  y: number;
  height: number;
  preferredX: number;
  /** 커서 좌표 조회 실패 시 false */
  rectValid?: boolean;
}

/** 선택 영역의 줄별 사각형 (렌더링용) */
export interface SelectionRect {
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 글자 서식 속성 (CharShape) */
export interface CharProperties {
  fontFamily?: string;
  fontSize?: number;       // HWPUNIT (1pt = 100, base_size)
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  textColor?: string;      // '#RRGGBB'
  shadeColor?: string;     // '#RRGGBB'
  emboss?: boolean;
  engrave?: boolean;
  charShapeId?: number;
  fontId?: number;
  fontIds?: number[];       // 언어별 개별 글꼴 ID (7개)
  // 확장 속성
  underlineType?: string;  // 'None' | 'Bottom' | 'Top'
  underlineColor?: string;
  outlineType?: number;    // 0-6
  shadowType?: number;     // 0=없음, 1=비연속, 2=연속
  shadowColor?: string;
  shadowOffsetX?: number;  // -100~100
  shadowOffsetY?: number;
  strikeColor?: string;
  subscript?: boolean;
  superscript?: boolean;
  // 언어별 배열 (7개: 한글/영문/한자/일어/외국어/기호/사용자)
  fontFamilies?: string[];
  ratios?: number[];       // 장평
  spacings?: number[];     // 자간
  relativeSizes?: number[];// 상대크기
  charOffsets?: number[];  // 글자 위치
  fontName?: string;       // 글꼴 변경 시 (mods 전용)
  // 강조점/밑줄모양/취소선모양/커닝
  emphasisDot?: number;    // 0=없음, 1=● 2=○ 3=ˇ 4=˜ 5=･ 6=:
  underlineShape?: number; // 0=실선, 1=긴점선, 2=점선, ...(표 27 선 종류)
  strikeShape?: number;    // 0=실선, 1=긴점선, 2=점선, ...(표 27 선 종류)
  kerning?: boolean;
  // 테두리/배경
  borderFillId?: number;
  borderLeft?: { type: number; width: number; color: string };
  borderRight?: { type: number; width: number; color: string };
  borderTop?: { type: number; width: number; color: string };
  borderBottom?: { type: number; width: number; color: string };
  fillType?: string;       // 'none' | 'solid'
  fillColor?: string;      // '#RRGGBB'
  patternColor?: string;   // '#RRGGBB'
  patternType?: number;    // 0=없음, 1=가로줄, 2=세로줄, 3=역슬래시, 4=슬래시, 5=십자, 6=X자
}

/** 문단 서식 속성 (ParaShape) — WASM getParaPropertiesAt 반환 타입 */
export interface ParaProperties {
  alignment?: string;        // 'justify'|'left'|'right'|'center'|'distribute'|'split'
  lineSpacing?: number;      // Percent일 때 %, 그 외 HWPUNIT
  lineSpacingType?: string;  // 'Percent'|'Fixed'|'SpaceOnly'|'Minimum'
  marginLeft?: number;       // px (96dpi, zoom=1 기준, ResolvedParaStyle)
  marginRight?: number;      // px (96dpi, zoom=1 기준, ResolvedParaStyle)
  indent?: number;           // px (96dpi, zoom=1 기준, ResolvedParaStyle)
  spacingBefore?: number;    // px (96dpi, zoom=1 기준)
  spacingAfter?: number;     // px (96dpi, zoom=1 기준)
  paraShapeId?: number;
  // 확장 탭 속성
  headType?: string;         // 'None'|'Outline'|'Number'|'Bullet'
  paraLevel?: number;        // 0-6 (=1-7수준)
  numberingId?: number;      // 번호/글머리표 정의 ID (1-based, 0=없음)
  widowOrphan?: boolean;
  keepWithNext?: boolean;
  keepLines?: boolean;
  pageBreakBefore?: boolean;
  fontLineHeight?: boolean;
  singleLine?: boolean;
  autoSpaceKrEn?: boolean;
  autoSpaceKrNum?: boolean;
  verticalAlign?: number;    // 0=글꼴기준, 1=위, 2=가운데, 3=아래
  englishBreakUnit?: number; // 0=단어, 1=하이픈, 2=글자
  koreanBreakUnit?: number;  // 0=어절, 1=글자
  // 탭 설정 탭 속성
  tabAutoLeft?: boolean;
  tabAutoRight?: boolean;
  tabStops?: { position: number; type: number; fill: number }[];
  defaultTabSpacing?: number;    // HWPUNIT (읽기 전용, 구역 기본 탭 간격)
  // 테두리/배경 탭 속성
  borderFillId?: number;
  borderLeft?: { type: number; width: number; color: string };
  borderRight?: { type: number; width: number; color: string };
  borderTop?: { type: number; width: number; color: string };
  borderBottom?: { type: number; width: number; color: string };
  fillType?: string;       // 'none' | 'solid'
  fillColor?: string;      // '#RRGGBB'
  patternColor?: string;   // '#RRGGBB'
  patternType?: number;    // 0=없음, 1~6=무늬
  borderSpacing?: number[];  // [좌, 우, 상, 하] HWPUNIT
}

/** 테두리 선 정보 */
export interface BorderLineInfo {
  /** 선 종류 (0=없음, 1=실선, 2=파선, 3=점선, ...) */
  type: number;
  /** 선 굵기 (0-6) */
  width: number;
  /** 선 색상 (#rrggbb) */
  color: string;
}

/** WASM getCellProperties() 반환 타입 — HWPUNIT 원본값 */
export interface CellProperties {
  width: number;
  height: number;
  paddingLeft: number;
  paddingRight: number;
  paddingTop: number;
  paddingBottom: number;
  /** 0=top, 1=center, 2=bottom */
  verticalAlign: number;
  /** 0=horizontal, 1=vertical */
  textDirection: number;
  isHeader: boolean;
  /** 셀 보호 */
  cellProtect?: boolean;
  /** 테두리/배경 */
  borderFillId?: number;
  borderLeft?: BorderLineInfo;
  borderRight?: BorderLineInfo;
  borderTop?: BorderLineInfo;
  borderBottom?: BorderLineInfo;
  fillType?: string;
  fillColor?: string;
  patternColor?: string;
  patternType?: number;
}

/** WASM getTableProperties() 반환 타입 — HWPUNIT 원본값 */
export interface TableProperties {
  cellSpacing: number;
  paddingLeft: number;
  paddingRight: number;
  paddingTop: number;
  paddingBottom: number;
  /** 0=none(나누지 않음), 1=cellBreak(셀 단위로 나눔) */
  pageBreak: number;
  repeatHeader: boolean;
  /** 표 전체 크기 (HWPUNIT) */
  tableWidth?: number;
  tableHeight?: number;
  /** 바깥 여백 (HWP16) */
  outerLeft?: number;
  outerRight?: number;
  outerTop?: number;
  outerBottom?: number;
  /** 캡션 */
  hasCaption?: boolean;
  captionDirection?: number;  // 0=왼쪽, 1=오른쪽, 2=위쪽, 3=아래쪽
  captionVertAlign?: number;  // 0=위, 1=가운데, 2=아래 (Left/Right 캡션)
  captionWidth?: number;      // HWPUNIT
  captionSpacing?: number;    // HWP16
  /** 글자처럼 취급 (본문배치) */
  treatAsChar?: boolean;
  /** 본문과의 배치 */
  textWrap?: string;
  /** 세로 위치 기준 */
  vertRelTo?: string;
  /** 세로 정렬 */
  vertAlign?: string;
  /** 가로 위치 기준 */
  horzRelTo?: string;
  /** 가로 정렬 */
  horzAlign?: string;
  /** 세로 오프셋 (HWPUNIT) */
  vertOffset?: number;
  /** 가로 오프셋 (HWPUNIT) */
  horzOffset?: number;
  /** 쪽 영역 안으로 제한 */
  restrictInPage?: boolean;
  /** 서로 겹침 허용 */
  allowOverlap?: boolean;
  /** 개체와 조판부호를 항상 같은 쪽에 놓기 */
  keepWithAnchor?: boolean;
  /** 테두리/배경 */
  borderFillId?: number;
  borderLeft?: BorderLineInfo;
  borderRight?: BorderLineInfo;
  borderTop?: BorderLineInfo;
  borderBottom?: BorderLineInfo;
  fillType?: string;
  fillColor?: string;
  patternColor?: string;
  patternType?: number;
}

/** WASM getPageControlLayout() 반환 요소 */
export interface ControlLayoutItem {
  type: 'table' | 'image' | 'shape' | 'equation' | 'group';
  x: number;
  y: number;
  w: number;
  h: number;
  secIdx?: number;
  paraIdx?: number;
  controlIdx?: number;
  /** 표 셀 내 수식인 경우: 셀 인덱스 */
  cellIdx?: number;
  /** 표 셀 내 수식인 경우: 셀 내 문단 인덱스 */
  cellParaIdx?: number;
}

/** 개체 참조 (그림/글상자 공용) */
export interface ObjectRef {
  sec: number;
  ppi: number;
  ci: number;
  type: 'image' | 'shape' | 'equation' | 'group';
  /** 표 셀 내 수식인 경우: 셀 인덱스 */
  cellIdx?: number;
  /** 표 셀 내 수식인 경우: 셀 내 문단 인덱스 */
  cellParaIdx?: number;
}

/** WASM getShapeProperties() 반환 타입 */
export interface ShapeProperties {
  width: number;
  height: number;
  treatAsChar: boolean;
  vertRelTo: string;
  vertAlign: string;
  horzRelTo: string;
  horzAlign: string;
  vertOffset: number;
  horzOffset: number;
  textWrap: string;
  tbMarginLeft?: number;
  tbMarginRight?: number;
  tbMarginTop?: number;
  tbMarginBottom?: number;
  tbVerticalAlign?: string;
  borderColor?: number;
  borderWidth?: number;
  borderAttr?: number;
  borderOutlineStyle?: number;
  lineType?: number;         // 0=없음, 1=실선, 2=파선, 3=점선, 4=일점쇄선, 5=이점쇄선, ...
  lineEndShape?: number;     // 0=둥근, 1=평면
  arrowStart?: number;       // 0=없음, 1~6=화살표 모양
  arrowEnd?: number;
  arrowStartSize?: number;   // 0~8
  arrowEndSize?: number;
  rotationAngle?: number;
  horzFlip?: boolean;
  vertFlip?: boolean;
  fillType?: string;
  fillBgColor?: number;
  fillPatColor?: number;
  fillPatType?: number;
  fillAlpha?: number;
  gradientType?: number;
  gradientAngle?: number;
  gradientCenterX?: number;
  gradientCenterY?: number;
  gradientBlur?: number;
  roundRate?: number;
  description: string;
}

/** WASM getEquationProperties() 반환 타입 */
export interface EquationProperties {
  script: string;
  fontSize: number;
  color: number;
  baseline: number;
  fontName: string;
}

/** WASM getPictureProperties() 반환 타입 */
export interface PictureProperties {
  width: number;
  height: number;
  treatAsChar: boolean;
  vertRelTo: string;
  vertAlign: string;
  horzRelTo: string;
  horzAlign: string;
  vertOffset: number;
  horzOffset: number;
  textWrap: string;
  brightness: number;
  contrast: number;
  effect: string;
  description: string;
  rotationAngle: number;
  horzFlip: boolean;
  vertFlip: boolean;
  originalWidth: number;
  originalHeight: number;
  cropLeft: number;
  cropTop: number;
  cropRight: number;
  cropBottom: number;
  paddingLeft: number;
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  outerMarginLeft: number;
  outerMarginTop: number;
  outerMarginRight: number;
  outerMarginBottom: number;
  borderColor: number;
  borderWidth: number;
  hasCaption: boolean;
  captionDirection: string;
  captionVertAlign: string;
  captionWidth: number;
  captionSpacing: number;
  captionMaxWidth: number;
  captionIncludeMargin: boolean;
}

/** 양식 개체 히트 결과 */
export interface FormObjectHitResult {
  found: boolean;
  sec?: number;
  para?: number;
  ci?: number;
  formType?: 'PushButton' | 'CheckBox' | 'ComboBox' | 'RadioButton' | 'Edit';
  name?: string;
  value?: number;
  caption?: string;
  text?: string;
  bbox?: { x: number; y: number; w: number; h: number };
  // 셀 내부 위치 (표 셀 안에 있는 경우)
  inCell?: boolean;
  tablePara?: number;
  tableCi?: number;
  cellIdx?: number;
  cellPara?: number;
}

/** 양식 개체 값 정보 */
export interface FormValueResult {
  ok: boolean;
  formType?: string;
  name?: string;
  value?: number;
  text?: string;
  caption?: string;
  enabled?: boolean;
}

/** 양식 개체 상세 정보 */
export interface FormObjectInfoResult {
  ok: boolean;
  formType?: string;
  name?: string;
  value?: number;
  text?: string;
  caption?: string;
  enabled?: boolean;
  width?: number;
  height?: number;
  foreColor?: number;
  backColor?: number;
  properties?: Record<string, string>;
  /** ComboBox 항목 목록 (스크립트 InsertString 추출) */
  items?: string[];
}

/** 텍스트 검색 결과 */
export interface SearchResult {
  found: boolean;
  wrapped?: boolean;
  sec?: number;
  para?: number;
  charOffset?: number;
  length?: number;
  cellContext?: {
    parentPara: number;
    ctrlIdx: number;
    cellIdx: number;
    cellPara: number;
  };
}

/** 치환 결과 */
export interface ReplaceResult {
  ok: boolean;
  charOffset?: number;
  newLength?: number;
}

/** 전체 치환 결과 */
export interface ReplaceAllResult {
  ok: boolean;
  count?: number;
}

/** 쪽 번호 조회 결과 */
export interface PageOfPositionResult {
  ok: boolean;
  page?: number;
}

/** 문서 내 커서 위치 */
export interface DocumentPosition {
  sectionIndex: number;
  paragraphIndex: number;
  charOffset: number;
  /** 셀 컨텍스트 — 레거시 flat 필드 (외부 표 기준) */
  parentParaIndex?: number;
  controlIndex?: number;
  cellIndex?: number;
  cellParaIndex?: number;
  /** 중첩 표 전체 경로 (depth 1=단일 표, depth 2+=중첩 표) */
  cellPath?: CellPathEntry[];
  /** 글상자 내부 여부 */
  isTextBox?: boolean;
  /** hitTest에서 계산된 커서 좌표 (중첩 표 등 getCursorRect 폴백용) */
  cursorRect?: CursorRect;
}

/** 책갈피 정보 */
export interface BookmarkInfo {
  name: string;
  sec: number;
  para: number;
  ctrlIdx: number;
  charPos: number;
}
