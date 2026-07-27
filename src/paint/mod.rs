//! 시각 레이어 IR 모듈
//!
//! semantic render tree를 backend-friendly layer tree로 변환한다.
//!
//! Layer IR lowering contract:
//! - Visible semantics that affect backend parity must be carried in `PaintOp`
//!   payloads, `ClipPolicy`, `LayerOutputOptions`, transforms, or resource handles.
//! - Legacy/direct renderer behavior should be lowered here first, then replayed
//!   by SVG, Canvas2D, CanvasKit, and native Skia.
//! - Backend-local interpretation is acceptable only for renderer mechanics such
//!   as antialiasing policy, caches, and platform font lookup.
//! - Fully shaped glyph runs are a future lower-level IR step; until then,
//!   `LayerTextRunPaint` is the text replay contract and must preserve every
//!   visible text flag exported to browser/native backends.
//! - JSON/JS exports provide a `textSources` table and per-TextRun `source`
//!   spans so source identity can move toward TextRun v2 without breaking the
//!   v1 string replay contract.

#![deny(unused_imports, unused_must_use, unused_variables)]

pub mod builder;
#[cfg(not(target_arch = "wasm32"))]
pub mod color_glyph;
pub mod font;
pub mod font_glyph;
#[cfg(target_arch = "wasm32")]
pub mod js_value;
mod json;
pub mod layer_tree;
pub mod paint_op;
pub mod profile;
pub mod replay_order;
pub mod resources;
pub mod schema;
pub mod text_shape;
pub mod text_v2;
pub mod text_variants;

pub use builder::LayerBuilder;
#[cfg(not(target_arch = "wasm32"))]
pub use color_glyph::{
    decode_colrv0_color_layers_payload, Colrv0ColorLayersDecodeError,
    Colrv0ColorLayersDecodeOptions,
};
pub use font::{
    BinaryResourceKind, BinaryResourceRef, FontBlobKey, FontBlobResource, FontDigest,
    FontExternalRef, FontFaceKey, FontFaceResource, FontFallbackPolicyId, FontInstanceKey,
    FontPortability, FontPortabilityKind, FontResourceSource, FontResourceTable,
    GlyphRunReplayEligibility, LanguageTag, LocalizedName, OpenTypeFeatureSetting, ScriptTag,
    ShapeKey, ShapingEngineId, TextDirection, VariationAxisValue, WritingMode,
};
pub use font_glyph::{
    decode_font_bitmap_glyph_payload, decode_font_svg_glyph_payload,
    lower_font_native_glyph_sidecars, resolve_embedded_font_face_index, EmbeddedFontFace,
    FontBitmapGlyphDecodeError, FontBitmapGlyphDecodeOptions, FontGlyphLoweringReport,
    FontSvgGlyphDecodeError, FontSvgGlyphDecodeOptions,
};
pub use layer_tree::{
    CacheHint, ClipKind, ClipPolicy, LayerNode, LayerNodeKind, LayerOutputOptions, LayerSemantic,
    LayerSemanticRole, PageLayerTree, TextSourceAnnotation, TextSourceEntry, TextSourceId,
    TextSourceRange, TextSourceSpan, TextSourceTable,
};
pub use paint_op::{
    BitmapAlphaMode, BitmapGlyphFiltering, BitmapGlyphPayload, BitmapGlyphScalingPolicy,
    BitmapStrikeSelection, ColorGlyphFormat, ColorGradientStop, ColorLayerNode, ColorLayersPayload,
    ColorLinearGradient, ColorPaintClipNode, ColorPaintCompositeMode, ColorPaintCompositeNode,
    ColorPaintGraphNode, ColorPaintGraphNodeKind, ColorPaintGraphPayload,
    ColorPaintLinearGradientPathNode, ColorPaintRadialGradientPathNode, ColorPaintSolidPathNode,
    ColorPaintSweepGradientPathNode, ColorPaintTransformNode, ColorRadialGradient,
    ColorSweepGradient, FontColorGlyphRef, GlyphCluster, GlyphClusterFlag, GlyphOutlineFillRule,
    GlyphOutlinePaintOrder, GlyphOutlinePayloadKind, GlyphOutlineStrokeCap, GlyphOutlineStrokeJoin,
    GlyphOutlineStrokeStyle, GlyphRange, GlyphRunDiagnostics, GlyphRunOrientation,
    GlyphRunPlacement, GlyphTransform, LayerAffineTransform, LayerCharOverlapPaint,
    LayerEllipsePaint, LayerEquationPaint, LayerFootnoteMarkerPaint, LayerFormObjectPaint,
    LayerGlyphOutlinePaint, LayerGlyphOutlinePath, LayerGlyphRunPaint, LayerImagePaint,
    LayerLinePaint, LayerPageBackgroundImagePaint, LayerPageBackgroundPaint, LayerPathPaint,
    LayerPoint, LayerRectanglePaint, LayerTabLeaderPaint, LayerTextControlMark,
    LayerTextControlMarkKind, LayerTextControlMarkPaint, LayerTextDecorationKind,
    LayerTextDecorationPaint, LayerTextOrientation, LayerTextRunPaint, LayerVector, PaintBounds,
    PaintOp, PaintTextStyle, PaintVariantMeta, PaletteRef, ResolvedColor, SvgGlyphIntrinsicSize,
    SvgGlyphPayload, SvgGlyphSecurityMode, SvgGlyphViewBox, TextClusterBasis, TextClusterFlag,
    TextClusterPlacement, TextFontSlot, TextLegacyVisualState, TextLegacyVisuals,
    TextProjectionKind, TextRunPlacement, TextVariantKind, TextVariantQuality,
};
pub use profile::RenderProfile;
pub use replay_order::{layer_node_has_replay_plane, paint_op_replay_plane, PaintReplayPlane};
pub use resources::{
    font_blob_resource_key, image_resource_key, resource_digest_hex, svg_resource_key,
    FontBlobResourceId, ImageResourceId, ResourceArena, SvgResourceId,
};
pub use schema::{LayerTreeSchema, LAYER_TREE_SCHEMA};
pub use text_shape::{
    FontRequest, FontResolver, GlyphRunQuality, JustificationMode, LineBreakChangeRisk,
    LineBreakContextValue, LineBreakShadowReport, NoopFontResolver, ResolvedFontFace,
    ResolvedGlyphRun, ShapedMeasurementLineReport, ShapedMeasurementPageSummary,
    ShapedMeasurementParagraphSummary, ShapedMeasurementRunReport, TabStopSummary,
    TableCellConstraintSummary, TextShapeDiagnostic, TextShapeLowerer, TextShapeReport,
};
pub use text_v2::{
    downgrade_text_v2_op_to_v1_compat, has_supported_strict_glyph_outline_bitmap,
    has_supported_strict_glyph_outline_colrv0, has_supported_strict_glyph_outline_colrv1,
    has_supported_strict_glyph_outline_stroke, has_supported_strict_glyph_outline_svg,
    lower_v1_layer_node_text_variants_to_v2, lower_v1_layer_tree_text_variants_to_v2,
    lower_v1_leaf_text_variants_to_v2, lower_v1_leaf_text_variants_with_sidecars_to_v2,
    sidecars_for_leaf_ops, strict_glyph_outline_text_v2_slots, strict_glyph_run_text_v2_slots,
    text_v2_validation_issues_to_json, validate_text_v2_op, validate_text_v2_ops,
    LayerTextPaintOpV2, LayerTextVariantPart, LayerTextVariantPayload, LayerTextVariantSet,
    PaintOrderSlotId, PaintScopeId, TextFallbackPolicy, TextV2Profile, TextV2ValidationIssue,
    TextV2ValidationIssueCode, TextV2ValidationOptions,
};
pub use text_variants::{validate_text_variant_scope, TextVariantScopeError};
