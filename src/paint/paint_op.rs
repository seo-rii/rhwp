use crate::model::control::FormType;
use crate::model::image::ImageEffect;
use crate::model::style::{ImageFillMode, UnderlineType};
use crate::model::ColorRef;
use crate::paint::font::{GlyphRunReplayEligibility, ShapeKey, TextDirection, WritingMode};
use crate::paint::layer_tree::{TextSourceRange, TextSourceSpan};
use crate::paint::resources::{ImageResourceId, SvgResourceId};
use crate::renderer::composer::CharOverlapInfo;
use crate::renderer::equation::layout::LayoutBox;
use crate::renderer::render_tree::{BoundingBox, FieldMarkerType, ShapeTransform};
use crate::renderer::{
    ArrowStyle, GradientFillInfo, LineRenderType, LineStyle, PathCommand, ShapeStyle,
    TabLeaderInfo, TextStyle,
};

/// backend가 재생하는 leaf paint operation.
///
/// 전환기 IR에서는 leaf draw payload만 유지하고, 큰 바이너리/문자열 자원은
/// `ResourceArena` handle로 분리한다.
#[derive(Debug, Clone)]
pub enum PaintOp {
    PageBackground {
        bbox: BoundingBox,
        background: LayerPageBackgroundPaint,
    },
    TextRun {
        bbox: BoundingBox,
        run: LayerTextRunPaint,
    },
    GlyphRun {
        bbox: BoundingBox,
        run: LayerGlyphRunPaint,
    },
    GlyphOutline {
        bbox: BoundingBox,
        outline: LayerGlyphOutlinePaint,
    },
    CharOverlap {
        bbox: BoundingBox,
        overlap: LayerCharOverlapPaint,
    },
    TextControlMark {
        bbox: BoundingBox,
        mark: LayerTextControlMarkPaint,
    },
    TabLeader {
        bbox: BoundingBox,
        leader: LayerTabLeaderPaint,
    },
    TextDecoration {
        bbox: BoundingBox,
        decoration: LayerTextDecorationPaint,
    },
    FootnoteMarker {
        bbox: BoundingBox,
        marker: LayerFootnoteMarkerPaint,
    },
    Line {
        bbox: BoundingBox,
        line: LayerLinePaint,
    },
    Rectangle {
        bbox: BoundingBox,
        rect: LayerRectanglePaint,
    },
    Ellipse {
        bbox: BoundingBox,
        ellipse: LayerEllipsePaint,
    },
    Path {
        bbox: BoundingBox,
        path: LayerPathPaint,
    },
    Image {
        bbox: BoundingBox,
        image: LayerImagePaint,
    },
    Equation {
        bbox: BoundingBox,
        equation: LayerEquationPaint,
    },
    FormObject {
        bbox: BoundingBox,
        form: LayerFormObjectPaint,
    },
}

#[derive(Debug, Clone)]
pub struct LayerFootnoteMarkerPaint {
    pub text: String,
    pub font_family: String,
    pub base_font_size: f64,
    pub color: u32,
}

#[derive(Debug, Clone)]
pub struct LayerTextRunPaint {
    pub source: Option<TextSourceSpan>,
    pub variant: Option<PaintVariantMeta>,
    /// Source-backed identity is exported through the layer tree `textSources`
    /// table and per-op `source` span. The in-memory v1 payload keeps the
    /// string projection here so existing Canvas2D/SVG replay remains stable
    /// while TextRun v2 and optional GlyphRun variants are introduced.
    pub text: String,
    /// Compatibility text style carried by the transitional TextRun IR.
    ///
    /// Backend replay should treat `PaintTextStyle::from(&style)` as the
    /// paint-visible contract. Layout-only fields in `TextStyle` are consumed
    /// before layer lowering and should not affect paint cache keys or new
    /// schema consumers.
    pub style: TextStyle,
    pub projection: TextProjectionKind,
    pub placement: Option<TextRunPlacement>,
    pub cluster_basis: TextClusterBasis,
    pub clusters: Vec<TextClusterPlacement>,
    pub positions: Vec<f64>,
    pub control_marks: Vec<LayerTextControlMark>,
    pub baseline: f64,
    pub rotation: f64,
    pub is_vertical: bool,
    pub orientation: LayerTextOrientation,
    pub char_overlap: Option<CharOverlapInfo>,
    pub legacy_visuals: TextLegacyVisuals,
    pub field_marker: FieldMarkerType,
    pub is_para_end: bool,
    pub is_line_break_end: bool,
}

#[derive(Debug, Clone)]
pub struct LayerGlyphRunPaint {
    pub source: TextSourceSpan,
    pub variant: PaintVariantMeta,
    pub paint_style: PaintTextStyle,
    pub shape_key: ShapeKey,
    pub placement: GlyphRunPlacement,
    pub glyph_ids: Vec<u32>,
    pub positions: Vec<LayerPoint>,
    pub advances: Option<Vec<LayerVector>>,
    pub clusters: Vec<GlyphCluster>,
    pub direction: TextDirection,
    pub bidi_level: Option<u8>,
    pub writing_mode: WritingMode,
    pub orientation: GlyphRunOrientation,
    pub glyph_transforms: Option<Vec<GlyphTransform>>,
    pub diagnostics: GlyphRunDiagnostics,
}

#[derive(Debug, Clone)]
pub struct LayerGlyphOutlinePaint {
    pub source: TextSourceSpan,
    pub variant: PaintVariantMeta,
    pub payload_kind: GlyphOutlinePayloadKind,
    pub stroke: Option<GlyphOutlineStrokeStyle>,
    pub color_layers: Option<ColorLayersPayload>,
    pub bitmap_glyph: Option<BitmapGlyphPayload>,
    pub svg_glyph: Option<SvgGlyphPayload>,
    pub paint_style: PaintTextStyle,
    pub placement: TextRunPlacement,
    pub paths: Vec<LayerGlyphOutlinePath>,
    pub diagnostics: GlyphRunDiagnostics,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GlyphOutlinePayloadKind {
    MonochromeFill,
    MonochromeFillStroke,
    ColorLayers,
    BitmapGlyph,
    SvgGlyph,
}

impl GlyphOutlinePayloadKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MonochromeFill => "monochromeFill",
            Self::MonochromeFillStroke => "monochromeFillStroke",
            Self::ColorLayers => "colorLayers",
            Self::BitmapGlyph => "bitmapGlyph",
            Self::SvgGlyph => "svgGlyph",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorGlyphFormat {
    ColrV0,
    ColrV1,
    Other,
}

impl ColorGlyphFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ColrV0 => "colrV0",
            Self::ColrV1 => "colrV1",
            Self::Other => "other",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct FontColorGlyphRef {
    pub face_key: Option<String>,
    pub glyph_id: Option<u32>,
    pub palette_index: Option<u16>,
    pub color_format: Option<ColorGlyphFormat>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PaletteRef {
    pub id: Option<String>,
    pub index: Option<u16>,
    pub cpal_digest: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedColor {
    pub color_space: Option<String>,
    pub rgba: [f32; 4],
}

#[derive(Debug, Clone, PartialEq)]
pub struct ColorLayerNode {
    pub layer_index: Option<u32>,
    pub glyph_id: Option<u32>,
    pub glyph_range: Option<GlyphRange>,
    pub source_range_utf8: Option<TextSourceRange>,
    pub source_font_ref: Option<FontColorGlyphRef>,
    pub path_index: Option<u32>,
    pub commands: Option<Vec<PathCommand>>,
    pub fill: Option<ResolvedColor>,
    pub fill_rule: Option<GlyphOutlineFillRule>,
    pub palette_index: Option<u16>,
    pub color: Option<ColorRef>,
    pub opacity: Option<f64>,
    pub transform_to_run: Option<LayerAffineTransform>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ColorLayersPayload {
    pub color_format: ColorGlyphFormat,
    pub source_font_ref: Option<FontColorGlyphRef>,
    pub palette_ref: Option<PaletteRef>,
    pub layers: Vec<ColorLayerNode>,
    pub source_range_utf8: Option<TextSourceRange>,
    pub glyph_range: Option<GlyphRange>,
}

impl ColorLayersPayload {
    pub fn has_colrv0_resolved_layer_contract(&self) -> bool {
        self.color_format == ColorGlyphFormat::ColrV0
            && !self.layers.is_empty()
            && self.layers.iter().all(|layer| {
                layer.layer_index.is_some()
                    && layer
                        .commands
                        .as_ref()
                        .is_some_and(|commands| !commands.is_empty())
                    && layer.fill.is_some()
                    && layer.fill_rule.is_some()
                    && layer.glyph_id.is_some()
                    && layer.glyph_range.is_some()
                    && layer.source_range_utf8.is_some()
                    && layer.source_font_ref.is_some()
                    && layer.palette_index.is_some()
            })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BitmapStrikeSelection {
    ProducerResolved,
    DiagnosticOnly,
}

impl BitmapStrikeSelection {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ProducerResolved => "producerResolved",
            Self::DiagnosticOnly => "diagnosticOnly",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BitmapAlphaMode {
    Premultiplied,
    Straight,
}

impl BitmapAlphaMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Premultiplied => "premultiplied",
            Self::Straight => "straight",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BitmapGlyphScalingPolicy {
    NoScale,
    ScaleToEm,
    ExplicitTransform,
    Nearest,
    Linear,
    BackendDefault,
}

impl BitmapGlyphScalingPolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NoScale => "noScale",
            Self::ScaleToEm => "scaleToEm",
            Self::ExplicitTransform => "explicitTransform",
            Self::Nearest => "nearest",
            Self::Linear => "linear",
            Self::BackendDefault => "backendDefault",
        }
    }

    pub fn is_strict_deterministic(self) -> bool {
        !matches!(self, Self::BackendDefault)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BitmapGlyphFiltering {
    Nearest,
    Linear,
    BackendDefault,
}

impl BitmapGlyphFiltering {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Nearest => "nearest",
            Self::Linear => "linear",
            Self::BackendDefault => "backendDefault",
        }
    }

    pub fn is_strict_deterministic(self) -> bool {
        !matches!(self, Self::BackendDefault)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct BitmapGlyphPayload {
    pub image_resource_id: ImageResourceId,
    pub source_range_utf8: Option<TextSourceRange>,
    pub glyph_range: Option<GlyphRange>,
    pub placement: Option<TextRunPlacement>,
    pub transform_to_run: Option<LayerAffineTransform>,
    pub strike_ppem: Option<(u16, u16)>,
    pub strike_selection: Option<BitmapStrikeSelection>,
    pub pixel_format: Option<String>,
    pub color_space: Option<String>,
    pub alpha_mode: Option<BitmapAlphaMode>,
    pub scaling_policy: Option<BitmapGlyphScalingPolicy>,
    pub filtering: Option<BitmapGlyphFiltering>,
}

impl BitmapGlyphPayload {
    pub fn has_strict_visual_contract(&self) -> bool {
        self.source_range_utf8.is_some()
            && self.glyph_range.is_some()
            && self.placement.is_some()
            && self.strike_selection == Some(BitmapStrikeSelection::ProducerResolved)
            && self.alpha_mode.is_some()
            && self
                .scaling_policy
                .is_some_and(BitmapGlyphScalingPolicy::is_strict_deterministic)
            && self
                .filtering
                .is_some_and(BitmapGlyphFiltering::is_strict_deterministic)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SvgGlyphSecurityMode {
    StaticSanitized,
}

impl SvgGlyphSecurityMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::StaticSanitized => "staticSanitized",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SvgGlyphViewBox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SvgGlyphIntrinsicSize {
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SvgGlyphPayload {
    pub vector_resource_id: SvgResourceId,
    pub source_range_utf8: Option<TextSourceRange>,
    pub glyph_range: Option<GlyphRange>,
    pub placement: Option<TextRunPlacement>,
    pub transform_to_run: Option<LayerAffineTransform>,
    pub view_box: Option<SvgGlyphViewBox>,
    pub intrinsic_size: Option<SvgGlyphIntrinsicSize>,
    pub security_mode: SvgGlyphSecurityMode,
    pub script_allowed: bool,
    pub animation_allowed: bool,
    pub external_resources_allowed: bool,
    pub interactivity_allowed: bool,
}

impl SvgGlyphPayload {
    pub fn has_static_sanitized_contract(&self) -> bool {
        self.source_range_utf8.is_some()
            && self.glyph_range.is_some()
            && self.placement.is_some()
            && self.view_box.is_some()
            && self.security_mode == SvgGlyphSecurityMode::StaticSanitized
            && !self.script_allowed
            && !self.animation_allowed
            && !self.external_resources_allowed
            && !self.interactivity_allowed
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct GlyphOutlineStrokeStyle {
    pub color: ColorRef,
    pub width_px: f64,
    pub join: GlyphOutlineStrokeJoin,
    pub cap: GlyphOutlineStrokeCap,
    pub miter_limit: Option<f64>,
    pub paint_order: GlyphOutlinePaintOrder,
}

impl GlyphOutlineStrokeStyle {
    pub fn is_supported_monochrome_subset(&self) -> bool {
        self.width_px.is_finite()
            && self.width_px > 0.0
            && self
                .miter_limit
                .map(|limit| limit.is_finite() && limit >= 0.0)
                .unwrap_or(true)
            && self.join == GlyphOutlineStrokeJoin::Miter
            && self.cap == GlyphOutlineStrokeCap::Butt
            && self.paint_order == GlyphOutlinePaintOrder::FillThenStroke
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GlyphOutlineStrokeJoin {
    Miter,
    Round,
    Bevel,
}

impl GlyphOutlineStrokeJoin {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Miter => "miter",
            Self::Round => "round",
            Self::Bevel => "bevel",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GlyphOutlineStrokeCap {
    Butt,
    Round,
    Square,
}

impl GlyphOutlineStrokeCap {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Butt => "butt",
            Self::Round => "round",
            Self::Square => "square",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GlyphOutlinePaintOrder {
    FillOnly,
    StrokeOnly,
    FillThenStroke,
    StrokeThenFill,
}

impl GlyphOutlinePaintOrder {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FillOnly => "fillOnly",
            Self::StrokeOnly => "strokeOnly",
            Self::FillThenStroke => "fillThenStroke",
            Self::StrokeThenFill => "strokeThenFill",
        }
    }
}

#[derive(Debug, Clone)]
pub struct LayerGlyphOutlinePath {
    pub glyph_id: u32,
    pub source_range_utf8: TextSourceRange,
    pub glyph_range: GlyphRange,
    pub commands: Vec<PathCommand>,
    pub fill_rule: GlyphOutlineFillRule,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GlyphOutlineFillRule {
    NonZero,
    EvenOdd,
}

impl GlyphOutlineFillRule {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NonZero => "nonzero",
            Self::EvenOdd => "evenodd",
        }
    }
}

impl Default for LayerTextRunPaint {
    fn default() -> Self {
        Self {
            source: None,
            variant: None,
            text: String::new(),
            style: TextStyle::default(),
            projection: TextProjectionKind::Verbatim,
            placement: None,
            cluster_basis: TextClusterBasis::LegacyPosition,
            clusters: Vec::new(),
            positions: Vec::new(),
            control_marks: Vec::new(),
            baseline: 0.0,
            rotation: 0.0,
            is_vertical: false,
            orientation: LayerTextOrientation::Horizontal,
            char_overlap: None,
            legacy_visuals: TextLegacyVisuals::default(),
            field_marker: FieldMarkerType::None,
            is_para_end: false,
            is_line_break_end: false,
        }
    }
}

/// Whether a transitional inline visual payload is still authoritative or is a
/// compatibility mirror of a separate PaintOp.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextLegacyVisualState {
    Canonical,
    Mirror,
}

impl TextLegacyVisualState {
    pub fn as_str(self) -> &'static str {
        match self {
            TextLegacyVisualState::Canonical => "canonical",
            TextLegacyVisualState::Mirror => "mirror",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TextLegacyVisuals {
    pub char_overlap: Option<TextLegacyVisualState>,
    pub control_marks: Option<TextLegacyVisualState>,
    pub tab_leaders: Option<TextLegacyVisualState>,
    pub decorations: Option<TextLegacyVisualState>,
}

#[derive(Debug, Clone)]
pub struct LayerCharOverlapPaint {
    pub source: Option<TextSourceSpan>,
    pub variant: Option<PaintVariantMeta>,
    pub text: String,
    pub style: TextStyle,
    pub positions: Vec<f64>,
    pub baseline: f64,
    pub rotation: f64,
    pub is_vertical: bool,
    pub orientation: LayerTextOrientation,
    pub overlap: CharOverlapInfo,
}

#[derive(Debug, Clone)]
pub struct LayerTextControlMarkPaint {
    pub source: Option<TextSourceSpan>,
    pub mark: LayerTextControlMark,
}

#[derive(Debug, Clone)]
pub struct LayerTabLeaderPaint {
    pub source: Option<TextSourceSpan>,
    pub leader: TabLeaderInfo,
    pub color: ColorRef,
    pub font_size: f64,
    pub baseline: f64,
}

#[derive(Debug, Clone)]
pub struct LayerTextDecorationPaint {
    pub source: Option<TextSourceSpan>,
    pub kind: LayerTextDecorationKind,
    pub positions: Vec<f64>,
    pub baseline: f64,
    pub rotation: f64,
    pub font_size: f64,
    pub ratio: f64,
    pub color: ColorRef,
    pub shape: u8,
    pub underline: UnderlineType,
    pub emphasis_dot: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LayerTextDecorationKind {
    Underline,
    Strikethrough,
    EmphasisDot,
}

impl LayerTextDecorationKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Underline => "underline",
            Self::Strikethrough => "strikethrough",
            Self::EmphasisDot => "emphasisDot",
        }
    }
}

/// Variant grouping metadata for future TextRun/GlyphRun/outline alternatives.
///
/// The migration contract is variant-set based: consumers choose one
/// `variant_id` per `equivalence_group` and paint every part belonging to that
/// variant. This lets a future glyph variant split by fallback font or bidi
/// boundary without treating each split run as a separate visual alternative.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaintVariantMeta {
    pub equivalence_group: String,
    pub variant_id: String,
    pub variant_kind: TextVariantKind,
    pub part_index: u32,
    pub part_count: u32,
    pub is_default_fallback: bool,
    pub requires: Vec<String>,
    pub quality: Option<TextVariantQuality>,
    /// Optional root paint-order anchor for strict visual sidecar variants.
    ///
    /// `GlyphOutline` must not be exported as a generic `Path` while a
    /// `TextRun` fallback exists. When an outline is emitted as a sidecar
    /// variant, this id points at the root text op whose paint-order slot it
    /// replaces.
    pub anchor_op_id: Option<String>,
    /// Optional order within the selected variant set at the anchored slot.
    pub local_paint_order: Option<u32>,
}

impl PaintVariantMeta {
    pub fn text_run_default(equivalence_group: impl Into<String>) -> Self {
        Self {
            equivalence_group: equivalence_group.into(),
            variant_id: "textRun".to_string(),
            variant_kind: TextVariantKind::TextRun,
            part_index: 0,
            part_count: 1,
            is_default_fallback: true,
            requires: Vec::new(),
            quality: None,
            anchor_op_id: None,
            local_paint_order: None,
        }
    }

    pub fn stable_op_id(&self) -> String {
        if self.is_default_fallback {
            format!("op-{}", self.equivalence_group)
        } else {
            format!(
                "op-{}-{}-{}",
                self.equivalence_group, self.variant_id, self.part_index
            )
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextVariantKind {
    TextRun,
    GlyphRun,
    GlyphOutline,
}

impl TextVariantKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TextRun => "textRun",
            Self::GlyphRun => "glyphRun",
            Self::GlyphOutline => "glyphOutline",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextVariantQuality {
    Exact,
    PositionAdjusted,
    Approximate,
    DiagnosticOnly,
    Omitted,
}

impl TextVariantQuality {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Exact => "exact",
            Self::PositionAdjusted => "positionAdjusted",
            Self::Approximate => "approximate",
            Self::DiagnosticOnly => "diagnosticOnly",
            Self::Omitted => "omitted",
        }
    }
}

/// Point in layer text coordinate space.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LayerPoint {
    pub x: f64,
    pub y: f64,
}

/// Vector in layer text coordinate space.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LayerVector {
    pub dx: f64,
    pub dy: f64,
}

/// 2D affine transform mapping run-local text coordinates to page space.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LayerAffineTransform {
    pub a: f64,
    pub b: f64,
    pub c: f64,
    pub d: f64,
    pub e: f64,
    pub f: f64,
}

/// TextRun v2 placement metadata.
///
/// Initial schema v1 exports treat this as non-authoritative metadata:
/// `positions`/`baseline`/`rotation` remain the compatibility replay contract.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TextRunPlacement {
    pub run_to_page: LayerAffineTransform,
    pub baseline_y: f64,
}

pub type GlyphRunPlacement = TextRunPlacement;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GlyphRunOrientation {
    Horizontal,
    VerticalUpright,
    VerticalSideways,
    MixedPerGlyph,
}

impl GlyphRunOrientation {
    pub fn from_text_orientation(orientation: LayerTextOrientation) -> Self {
        match orientation {
            LayerTextOrientation::Horizontal => Self::Horizontal,
            LayerTextOrientation::VerticalUpright => Self::VerticalUpright,
            LayerTextOrientation::VerticalSideways => Self::VerticalSideways,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Horizontal => "horizontal",
            Self::VerticalUpright => "vertical-upright",
            Self::VerticalSideways => "vertical-sideways",
            Self::MixedPerGlyph => "mixedPerGlyph",
        }
    }
}

/// Optional per-glyph transform reserved for future mixed vertical exports.
///
/// Public schema v1 must not emit `MixedPerGlyph`; this type exists so internal
/// lowerers can keep explicit transform data once that contract is designed.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GlyphTransform {
    pub xx: f32,
    pub xy: f32,
    pub yx: f32,
    pub yy: f32,
    pub tx: f32,
    pub ty: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GlyphRange {
    pub start: u32,
    pub end: u32,
}

impl GlyphRange {
    pub fn new(start: u32, end: u32) -> Self {
        Self { start, end }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GlyphClusterFlag {
    Ligature,
    FallbackBoundary,
}

impl GlyphClusterFlag {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ligature => "ligature",
            Self::FallbackBoundary => "fallbackBoundary",
        }
    }
}

/// Shaped glyph cluster mapping for future lower-level text variants.
///
/// Unlike `TextClusterPlacement`, this cluster describes shaped glyph ranges.
/// Source identity still points back to the layer tree text source table.
#[derive(Debug, Clone, PartialEq)]
pub struct GlyphCluster {
    pub source_range_utf8: TextSourceRange,
    pub source_range_utf16: Option<TextSourceRange>,
    pub text_range_utf8: Option<TextSourceRange>,
    pub glyph_range: GlyphRange,
    pub flags: Vec<GlyphClusterFlag>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GlyphRunDiagnostics {
    pub quality: TextVariantQuality,
    pub replay_eligibility: GlyphRunReplayEligibility,
    pub strict_visual_eligible: bool,
    pub max_origin_delta_px: f64,
    pub max_advance_delta_px: f64,
    pub max_residual_after_adjustment_px: f64,
    pub cluster_mismatch_count: u32,
    pub missing_glyph_count: u32,
    pub used_fallback_font_count: u32,
    pub reason: Option<String>,
}

/// Basis for TextRun v2 cluster placement.
///
/// These are layout/placement clusters, not shaped glyph clusters. A run may be
/// marked `ShapingEquivalent` only after a shaping pass proves that the text
/// clusters match shaped glyph clusters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextClusterBasis {
    LegacyPosition,
    Grapheme,
    LayoutPlacement,
    ShapingEquivalent,
}

impl TextClusterBasis {
    pub fn as_str(self) -> &'static str {
        match self {
            TextClusterBasis::LegacyPosition => "legacyPosition",
            TextClusterBasis::Grapheme => "grapheme",
            TextClusterBasis::LayoutPlacement => "layoutPlacement",
            TextClusterBasis::ShapingEquivalent => "shapingEquivalent",
        }
    }
}

/// Relation between `TextRun.text` and the canonical source table slice.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextProjectionKind {
    Verbatim,
    Normalized,
    ControlProjection,
    FieldProjection,
    SyntheticVisual,
}

impl TextProjectionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            TextProjectionKind::Verbatim => "verbatim",
            TextProjectionKind::Normalized => "normalized",
            TextProjectionKind::ControlProjection => "controlProjection",
            TextProjectionKind::FieldProjection => "fieldProjection",
            TextProjectionKind::SyntheticVisual => "syntheticVisual",
        }
    }
}

/// Extra flags for TextRun v2 layout clusters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextClusterFlag {
    SpecialVisual,
    NotShapingCandidate,
}

impl TextClusterFlag {
    pub fn as_str(self) -> &'static str {
        match self {
            TextClusterFlag::SpecialVisual => "specialVisual",
            TextClusterFlag::NotShapingCandidate => "notShapingCandidate",
        }
    }
}

/// Layout/placement cluster metadata for source-backed TextRun v2 exports.
#[derive(Debug, Clone, PartialEq)]
pub struct TextClusterPlacement {
    pub source_range_utf8: TextSourceRange,
    pub text_range_utf8: TextSourceRange,
    pub text_range_utf16: Option<TextSourceRange>,
    pub projection: TextProjectionKind,
    pub origin: LayerPoint,
    pub advance: Option<LayerVector>,
    pub flags: Vec<TextClusterFlag>,
}

/// Paint-only projection of `TextStyle`.
///
/// Layout-only fields such as tab stops, available width, and spacing expansion
/// are consumed before layer lowering and should not affect backend replay cache
/// keys or schema v2 consumers once text positions/control marks are explicit.
#[derive(Debug, Clone)]
pub struct PaintTextStyle {
    pub font_family: String,
    pub font_size: f64,
    pub color: ColorRef,
    pub bold: bool,
    pub italic: bool,
    pub underline: UnderlineType,
    pub strikethrough: bool,
    pub ratio: f64,
    pub tab_leaders: Vec<TabLeaderInfo>,
    pub outline_type: u8,
    pub shadow_type: u8,
    pub shadow_color: ColorRef,
    pub shadow_offset_x: f64,
    pub shadow_offset_y: f64,
    pub emboss: bool,
    pub engrave: bool,
    pub superscript: bool,
    pub subscript: bool,
    pub emphasis_dot: u8,
    pub underline_shape: u8,
    pub strike_shape: u8,
    pub underline_color: ColorRef,
    pub strike_color: ColorRef,
    pub shade_color: ColorRef,
}

impl From<&TextStyle> for PaintTextStyle {
    fn from(style: &TextStyle) -> Self {
        Self {
            font_family: style.font_family.clone(),
            font_size: style.font_size,
            color: style.color,
            bold: style.bold,
            italic: style.italic,
            underline: style.underline,
            strikethrough: style.strikethrough,
            ratio: style.ratio,
            tab_leaders: style.tab_leaders.clone(),
            outline_type: style.outline_type,
            shadow_type: style.shadow_type,
            shadow_color: style.shadow_color,
            shadow_offset_x: style.shadow_offset_x,
            shadow_offset_y: style.shadow_offset_y,
            emboss: style.emboss,
            engrave: style.engrave,
            superscript: style.superscript,
            subscript: style.subscript,
            emphasis_dot: style.emphasis_dot,
            underline_shape: style.underline_shape,
            strike_shape: style.strike_shape,
            underline_color: style.underline_color,
            strike_color: style.strike_color,
            shade_color: style.shade_color,
        }
    }
}

impl PaintTextStyle {
    /// Returns whether a backend may replay this text as a simple fill-only
    /// positioned glyph run without losing HWP text effects.
    pub fn is_fill_only_glyph_replay(&self) -> bool {
        let ratio = if self.ratio > 0.0 { self.ratio } else { 1.0 };
        (ratio - 1.0).abs() <= 0.001
            && self.tab_leaders.is_empty()
            && self.underline == UnderlineType::None
            && !self.strikethrough
            && self.outline_type == 0
            && self.shadow_type == 0
            && !self.emboss
            && !self.engrave
            && !self.superscript
            && !self.subscript
            && self.emphasis_dot == 0
            && (self.shade_color & 0x00FF_FFFF) == 0x00FF_FFFF
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LayerTextOrientation {
    Horizontal,
    VerticalUpright,
    VerticalSideways,
}

impl LayerTextOrientation {
    pub fn from_run(is_vertical: bool, rotation: f64) -> Self {
        if !is_vertical {
            Self::Horizontal
        } else if rotation.abs() > f64::EPSILON {
            Self::VerticalSideways
        } else {
            Self::VerticalUpright
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Horizontal => "horizontal",
            Self::VerticalUpright => "vertical-upright",
            Self::VerticalSideways => "vertical-sideways",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LayerTextControlMarkKind {
    Space,
    Tab,
    ParagraphEnd,
    LineBreakEnd,
}

impl LayerTextControlMarkKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Space => "space",
            Self::Tab => "tab",
            Self::ParagraphEnd => "paragraphEnd",
            Self::LineBreakEnd => "lineBreakEnd",
        }
    }

    pub fn glyph(self) -> &'static str {
        match self {
            Self::Space => "\u{2228}",
            Self::Tab => "\u{2192}",
            Self::ParagraphEnd => "\u{21B5}",
            Self::LineBreakEnd => "\u{2193}",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct LayerTextControlMark {
    pub kind: LayerTextControlMarkKind,
    /// X offset relative to the rendered text origin.
    pub x: f64,
    /// Y offset relative to the rendered text baseline.
    pub y: f64,
    pub font_size: f64,
}

#[derive(Debug, Clone)]
pub struct LayerLinePaint {
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
    pub style: LineStyle,
    pub transform: ShapeTransform,
}

#[derive(Debug, Clone)]
pub struct LayerRectanglePaint {
    pub corner_radius: f64,
    pub style: ShapeStyle,
    pub gradient: Option<Box<GradientFillInfo>>,
    pub transform: ShapeTransform,
}

#[derive(Debug, Clone)]
pub struct LayerEllipsePaint {
    pub style: ShapeStyle,
    pub gradient: Option<Box<GradientFillInfo>>,
    pub transform: ShapeTransform,
}

#[derive(Debug, Clone)]
pub struct LayerPathPaint {
    pub commands: Vec<PathCommand>,
    pub style: ShapeStyle,
    pub gradient: Option<Box<GradientFillInfo>>,
    pub transform: ShapeTransform,
    pub connector_endpoints: Option<(f64, f64, f64, f64)>,
    pub line_style: Option<LineStyle>,
}

#[derive(Debug, Clone)]
pub struct LayerPageBackgroundPaint {
    pub background_color: Option<ColorRef>,
    pub border_color: Option<ColorRef>,
    pub border_width: f64,
    pub gradient: Option<Box<GradientFillInfo>>,
    pub image: Option<LayerPageBackgroundImagePaint>,
}

#[derive(Debug, Clone)]
pub struct LayerPageBackgroundImagePaint {
    pub resource_id: ImageResourceId,
    pub fill_mode: ImageFillMode,
}

#[derive(Debug, Clone)]
pub struct LayerImagePaint {
    pub resource_id: Option<ImageResourceId>,
    pub fill_mode: Option<ImageFillMode>,
    pub original_size: Option<(f64, f64)>,
    pub crop: Option<(i32, i32, i32, i32)>,
    pub effect: ImageEffect,
    pub transform: ShapeTransform,
}

#[derive(Debug, Clone)]
pub struct LayerEquationPaint {
    pub svg_resource_id: SvgResourceId,
    pub layout_box: LayoutBox,
    pub color_str: String,
    pub color: u32,
    pub font_size: f64,
}

#[derive(Debug, Clone)]
pub struct LayerFormObjectPaint {
    pub form_type: FormType,
    pub caption: String,
    pub text: String,
    pub fore_color: String,
    pub back_color: String,
    pub value: i32,
    pub enabled: bool,
}

impl PaintOp {
    pub fn paint_bounds(&self) -> PaintBounds {
        let logical = match self {
            PaintOp::PageBackground { bbox, .. }
            | PaintOp::TextRun { bbox, .. }
            | PaintOp::GlyphRun { bbox, .. }
            | PaintOp::GlyphOutline { bbox, .. }
            | PaintOp::CharOverlap { bbox, .. }
            | PaintOp::TextControlMark { bbox, .. }
            | PaintOp::TabLeader { bbox, .. }
            | PaintOp::TextDecoration { bbox, .. }
            | PaintOp::FootnoteMarker { bbox, .. }
            | PaintOp::Line { bbox, .. }
            | PaintOp::Rectangle { bbox, .. }
            | PaintOp::Ellipse { bbox, .. }
            | PaintOp::Path { bbox, .. }
            | PaintOp::Image { bbox, .. }
            | PaintOp::Equation { bbox, .. }
            | PaintOp::FormObject { bbox, .. } => *bbox,
        };
        let expand = |bbox: BoundingBox, amount: f64| {
            let amount = amount.max(0.0);
            BoundingBox::new(
                bbox.x - amount,
                bbox.y - amount,
                bbox.width + amount * 2.0,
                bbox.height + amount * 2.0,
            )
        };
        let union = |a: BoundingBox, b: BoundingBox| {
            let left = a.x.min(b.x);
            let top = a.y.min(b.y);
            let right = (a.x + a.width).max(b.x + b.width);
            let bottom = (a.y + a.height).max(b.y + b.height);
            BoundingBox::new(left, top, right - left, bottom - top)
        };
        let include_shadow =
            |visual: BoundingBox, base: BoundingBox, shadow: &crate::renderer::ShadowStyle| {
                let shadow_box = BoundingBox::new(
                    base.x + shadow.offset_x,
                    base.y + shadow.offset_y,
                    base.width,
                    base.height,
                );
                union(
                    visual,
                    expand(shadow_box, shadow.offset_x.abs().max(shadow.offset_y.abs())),
                )
            };

        let visual = match self {
            PaintOp::PageBackground { background, .. } => {
                expand(logical, background.border_width.max(0.0) * 0.5)
            }
            PaintOp::TextRun { bbox, run } => {
                let style = &run.style;
                let mut amount = 0.0_f64;
                if style.underline != UnderlineType::None || style.strikethrough {
                    amount = amount.max(style.font_size * 0.2);
                }
                if style.outline_type > 0 || style.emboss || style.engrave {
                    amount = amount.max(style.font_size * 0.15);
                }
                if style.emphasis_dot > 0 {
                    amount = amount.max(style.font_size * 0.35);
                }
                let mut visual = expand(logical, amount);
                if style.shadow_type > 0 {
                    let shadow_box = BoundingBox::new(
                        logical.x + style.shadow_offset_x,
                        logical.y + style.shadow_offset_y,
                        logical.width,
                        logical.height,
                    );
                    visual = union(
                        visual,
                        expand(
                            shadow_box,
                            style
                                .shadow_offset_x
                                .abs()
                                .max(style.shadow_offset_y.abs())
                                .max(style.font_size * 0.1),
                        ),
                    );
                }
                for mark in &run.control_marks {
                    let mark_box = BoundingBox::new(
                        bbox.x + mark.x,
                        bbox.y + run.baseline + mark.y - mark.font_size,
                        mark.font_size,
                        mark.font_size * 1.2,
                    );
                    visual = union(visual, mark_box);
                }
                visual
            }
            PaintOp::GlyphRun { bbox, run } => {
                let amount = run
                    .paint_style
                    .font_size
                    .max(run.paint_style.shadow_offset_x.abs())
                    .max(run.paint_style.shadow_offset_y.abs())
                    .max(1.0)
                    * 0.2;
                expand(*bbox, amount)
            }
            PaintOp::GlyphOutline { bbox, outline } => {
                let stroke_amount = outline
                    .stroke
                    .as_ref()
                    .map(|stroke| stroke.width_px.max(0.0) * 0.5)
                    .unwrap_or(0.0);
                let amount = outline
                    .paint_style
                    .font_size
                    .max(outline.paint_style.shadow_offset_x.abs())
                    .max(outline.paint_style.shadow_offset_y.abs())
                    .max(1.0)
                    * 0.2
                    + stroke_amount;
                expand(*bbox, amount)
            }
            PaintOp::CharOverlap { bbox, overlap } => {
                let style = &overlap.style;
                let amount = style
                    .font_size
                    .max(1.0)
                    .max(style.shadow_offset_x.abs())
                    .max(style.shadow_offset_y.abs());
                expand(*bbox, amount * 0.15)
            }
            PaintOp::TextControlMark { bbox, mark } => union(
                logical,
                BoundingBox::new(
                    bbox.x + mark.mark.x,
                    bbox.y + mark.mark.y - mark.mark.font_size,
                    mark.mark.font_size,
                    mark.mark.font_size * 1.2,
                ),
            ),
            PaintOp::TabLeader { bbox, leader } => union(
                logical,
                BoundingBox::new(
                    bbox.x + leader.leader.start_x.min(leader.leader.end_x),
                    bbox.y + leader.baseline - leader.font_size * 0.4,
                    (leader.leader.end_x - leader.leader.start_x).abs(),
                    leader.font_size * 0.5,
                ),
            ),
            PaintOp::TextDecoration { bbox, decoration } => {
                let text_width = decoration.positions.last().copied().unwrap_or(0.0);
                match decoration.kind {
                    LayerTextDecorationKind::Underline => {
                        let y = match decoration.underline {
                            UnderlineType::Top => {
                                bbox.y + decoration.baseline - decoration.font_size + 1.0
                            }
                            _ => bbox.y + decoration.baseline + 2.0,
                        };
                        union(
                            logical,
                            expand(BoundingBox::new(bbox.x, y, text_width, 1.0), 2.0),
                        )
                    }
                    LayerTextDecorationKind::Strikethrough => {
                        let y = bbox.y + decoration.baseline - decoration.font_size * 0.3;
                        union(
                            logical,
                            expand(BoundingBox::new(bbox.x, y, text_width, 1.0), 2.0),
                        )
                    }
                    LayerTextDecorationKind::EmphasisDot => {
                        let dot_y = bbox.y + decoration.baseline - decoration.font_size * 1.05;
                        union(
                            logical,
                            expand(
                                BoundingBox::new(
                                    bbox.x,
                                    dot_y - decoration.font_size * 0.15,
                                    text_width,
                                    decoration.font_size * 0.3,
                                ),
                                2.0,
                            ),
                        )
                    }
                }
            }
            PaintOp::FootnoteMarker { marker, .. } => {
                expand(logical, marker.base_font_size.max(0.0) * 0.15)
            }
            PaintOp::Line { line, .. } => {
                let mut amount = line.style.width.max(0.0) * 0.5;
                if line.style.line_type != LineRenderType::Single {
                    amount = amount.max(line.style.width.max(1.0) * 2.0);
                }
                if line.style.start_arrow != ArrowStyle::None
                    || line.style.end_arrow != ArrowStyle::None
                {
                    amount = amount.max(line.style.width.max(1.0) * 8.0);
                }
                let mut visual = expand(logical, amount);
                if let Some(shadow) = &line.style.shadow {
                    visual = include_shadow(visual, logical, shadow);
                }
                visual
            }
            PaintOp::Rectangle { rect, .. } => {
                let mut visual = expand(logical, rect.style.stroke_width.max(0.0) * 0.5);
                if let Some(shadow) = &rect.style.shadow {
                    visual = include_shadow(visual, logical, shadow);
                }
                visual
            }
            PaintOp::Ellipse { ellipse, .. } => {
                let mut visual = expand(logical, ellipse.style.stroke_width.max(0.0) * 0.5);
                if let Some(shadow) = &ellipse.style.shadow {
                    visual = include_shadow(visual, logical, shadow);
                }
                visual
            }
            PaintOp::Path { path, .. } => {
                let mut amount = path.style.stroke_width.max(0.0) * 0.5;
                if let Some(line_style) = &path.line_style {
                    amount = amount.max(line_style.width.max(0.0) * 0.5);
                    if line_style.line_type != LineRenderType::Single {
                        amount = amount.max(line_style.width.max(1.0) * 2.0);
                    }
                    if line_style.start_arrow != ArrowStyle::None
                        || line_style.end_arrow != ArrowStyle::None
                    {
                        amount = amount.max(line_style.width.max(1.0) * 8.0);
                    }
                }
                let mut visual = expand(logical, amount);
                if let Some(shadow) = &path.style.shadow {
                    visual = include_shadow(visual, logical, shadow);
                }
                visual
            }
            PaintOp::Image { .. } | PaintOp::Equation { .. } | PaintOp::FormObject { .. } => {
                logical
            }
        };

        PaintBounds { logical, visual }
    }

    pub fn bounds(&self) -> BoundingBox {
        self.paint_bounds().logical
    }

    pub fn visual_bounds(&self) -> BoundingBox {
        self.paint_bounds().visual
    }
}

#[derive(Debug, Clone, Copy)]
pub struct PaintBounds {
    pub logical: BoundingBox,
    pub visual: BoundingBox,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::renderer::{StrokeDash, TextStyle};

    #[test]
    fn visual_bounds_expand_for_line_stroke_and_arrow() {
        let bbox = BoundingBox::new(10.0, 20.0, 30.0, 4.0);
        let op = PaintOp::Line {
            bbox,
            line: LayerLinePaint {
                x1: 10.0,
                y1: 22.0,
                x2: 40.0,
                y2: 22.0,
                style: LineStyle {
                    color: 0,
                    width: 4.0,
                    dash: StrokeDash::Solid,
                    line_type: LineRenderType::Double,
                    start_arrow: ArrowStyle::Arrow,
                    end_arrow: ArrowStyle::None,
                    start_arrow_size: 8,
                    end_arrow_size: 0,
                    shadow: None,
                },
                transform: Default::default(),
            },
        };
        let bounds = op.paint_bounds();

        assert_eq!(bounds.logical.x, bbox.x);
        assert!(bounds.visual.x < bbox.x);
        assert!(bounds.visual.width > bbox.width);
        assert!(bounds.visual.height > bbox.height);
    }

    #[test]
    fn visual_bounds_include_text_decoration_and_shadow() {
        let bbox = BoundingBox::new(10.0, 20.0, 40.0, 16.0);
        let op = PaintOp::TextRun {
            bbox,
            run: LayerTextRunPaint {
                source: None,
                text: "text".to_string(),
                style: TextStyle {
                    font_size: 20.0,
                    underline: UnderlineType::Bottom,
                    shadow_type: 1,
                    shadow_offset_x: 8.0,
                    shadow_offset_y: 3.0,
                    ..Default::default()
                },
                positions: vec![0.0, 10.0, 20.0, 30.0],
                control_marks: Vec::new(),
                baseline: 14.0,
                rotation: 0.0,
                is_vertical: false,
                orientation: LayerTextOrientation::Horizontal,
                char_overlap: None,
                field_marker: Default::default(),
                is_para_end: false,
                is_line_break_end: false,
                ..Default::default()
            },
        };
        let bounds = op.paint_bounds();

        assert_eq!(bounds.logical.y, bbox.y);
        assert!(bounds.visual.x < bbox.x);
        assert!(bounds.visual.width > bbox.width + 8.0);
        assert!(bounds.visual.height > bbox.height);
    }

    #[test]
    fn visual_bounds_include_glyph_outline_stroke_payload() {
        let bbox = BoundingBox::new(10.0, 20.0, 20.0, 10.0);
        let op = PaintOp::GlyphOutline {
            bbox,
            outline: LayerGlyphOutlinePaint {
                source: TextSourceSpan {
                    id: crate::paint::layer_tree::TextSourceId(0),
                    utf8_range: TextSourceRange::new(0, 1),
                    utf16_range: TextSourceRange::new(0, 1),
                    stable_source_key: None,
                },
                variant: PaintVariantMeta {
                    equivalence_group: "text-0".to_string(),
                    variant_id: "glyphOutline".to_string(),
                    variant_kind: TextVariantKind::GlyphOutline,
                    part_index: 0,
                    part_count: 1,
                    is_default_fallback: false,
                    requires: vec!["text.glyphOutline.monochromeFillStroke".to_string()],
                    quality: Some(TextVariantQuality::Exact),
                    anchor_op_id: Some("op-text-0".to_string()),
                    local_paint_order: Some(0),
                },
                payload_kind: GlyphOutlinePayloadKind::MonochromeFillStroke,
                stroke: Some(GlyphOutlineStrokeStyle {
                    color: 0,
                    width_px: 12.0,
                    join: GlyphOutlineStrokeJoin::Miter,
                    cap: GlyphOutlineStrokeCap::Butt,
                    miter_limit: Some(4.0),
                    paint_order: GlyphOutlinePaintOrder::FillThenStroke,
                }),
                color_layers: None,
                bitmap_glyph: None,
                svg_glyph: None,
                paint_style: PaintTextStyle::from(&TextStyle {
                    font_size: 0.0,
                    ..Default::default()
                }),
                placement: TextRunPlacement {
                    run_to_page: LayerAffineTransform {
                        a: 1.0,
                        b: 0.0,
                        c: 0.0,
                        d: 1.0,
                        e: 0.0,
                        f: 0.0,
                    },
                    baseline_y: 0.0,
                },
                paths: Vec::new(),
                diagnostics: GlyphRunDiagnostics {
                    quality: TextVariantQuality::Exact,
                    replay_eligibility: GlyphRunReplayEligibility::Portable,
                    strict_visual_eligible: true,
                    max_origin_delta_px: 0.0,
                    max_advance_delta_px: 0.0,
                    max_residual_after_adjustment_px: 0.0,
                    cluster_mismatch_count: 0,
                    missing_glyph_count: 0,
                    used_fallback_font_count: 0,
                    reason: None,
                },
            },
        };
        let bounds = op.paint_bounds();

        assert!(bounds.visual.x <= bbox.x - 6.0);
        assert!(bounds.visual.width >= bbox.width + 12.0);
    }

    #[test]
    fn reserved_glyph_payload_helper_enums_have_stable_strings() {
        assert_eq!(ColorGlyphFormat::ColrV0.as_str(), "colrV0");
        assert_eq!(ColorGlyphFormat::ColrV1.as_str(), "colrV1");
        assert_eq!(ColorGlyphFormat::Other.as_str(), "other");
        assert_eq!(
            BitmapStrikeSelection::ProducerResolved.as_str(),
            "producerResolved"
        );
        assert_eq!(
            BitmapStrikeSelection::DiagnosticOnly.as_str(),
            "diagnosticOnly"
        );
        assert_eq!(BitmapAlphaMode::Premultiplied.as_str(), "premultiplied");
        assert_eq!(BitmapAlphaMode::Straight.as_str(), "straight");
        assert_eq!(BitmapGlyphScalingPolicy::NoScale.as_str(), "noScale");
        assert_eq!(BitmapGlyphScalingPolicy::ScaleToEm.as_str(), "scaleToEm");
        assert_eq!(
            BitmapGlyphScalingPolicy::ExplicitTransform.as_str(),
            "explicitTransform"
        );
        assert_eq!(BitmapGlyphScalingPolicy::Nearest.as_str(), "nearest");
        assert_eq!(BitmapGlyphScalingPolicy::Linear.as_str(), "linear");
        assert_eq!(
            BitmapGlyphScalingPolicy::BackendDefault.as_str(),
            "backendDefault"
        );
        assert_eq!(BitmapGlyphFiltering::Nearest.as_str(), "nearest");
        assert_eq!(BitmapGlyphFiltering::Linear.as_str(), "linear");
        assert_eq!(
            BitmapGlyphFiltering::BackendDefault.as_str(),
            "backendDefault"
        );
        assert_eq!(
            SvgGlyphSecurityMode::StaticSanitized.as_str(),
            "staticSanitized"
        );
        assert!(BitmapGlyphScalingPolicy::ExplicitTransform.is_strict_deterministic());
        assert!(BitmapGlyphFiltering::Linear.is_strict_deterministic());
        assert!(!BitmapGlyphScalingPolicy::BackendDefault.is_strict_deterministic());
        assert!(!BitmapGlyphFiltering::BackendDefault.is_strict_deterministic());
    }

    #[test]
    fn reserved_glyph_payload_envelopes_carry_canonical_fields() {
        let source_range = TextSourceRange::new(0, 1);
        let glyph_range = GlyphRange::new(0, 1);
        let identity = LayerAffineTransform {
            a: 1.0,
            b: 0.0,
            c: 0.0,
            d: 1.0,
            e: 0.0,
            f: 0.0,
        };
        let placement = TextRunPlacement {
            run_to_page: identity,
            baseline_y: 12.0,
        };
        let color_layers = ColorLayersPayload {
            color_format: ColorGlyphFormat::ColrV0,
            source_font_ref: Some(FontColorGlyphRef {
                face_key: Some("fixture-face".to_string()),
                glyph_id: Some(42),
                palette_index: Some(0),
                color_format: Some(ColorGlyphFormat::ColrV0),
            }),
            palette_ref: Some(PaletteRef {
                id: Some("fixture-palette".to_string()),
                index: Some(0),
                cpal_digest: Some("sha256:fixture-cpal".to_string()),
            }),
            layers: vec![ColorLayerNode {
                layer_index: Some(0),
                glyph_id: Some(42),
                glyph_range: Some(glyph_range),
                source_range_utf8: Some(source_range),
                source_font_ref: Some(FontColorGlyphRef {
                    face_key: Some("fixture-face".to_string()),
                    glyph_id: Some(42),
                    palette_index: Some(0),
                    color_format: Some(ColorGlyphFormat::ColrV0),
                }),
                path_index: Some(0),
                commands: Some(vec![
                    PathCommand::MoveTo(0.0, 0.0),
                    PathCommand::LineTo(10.0, 0.0),
                    PathCommand::ClosePath,
                ]),
                fill: Some(ResolvedColor {
                    color_space: Some("srgb".to_string()),
                    rgba: [0.0, 0.0, 1.0, 1.0],
                }),
                fill_rule: Some(GlyphOutlineFillRule::NonZero),
                palette_index: Some(0),
                color: Some(0x00ff0000),
                opacity: Some(1.0),
                transform_to_run: Some(identity),
            }],
            source_range_utf8: Some(source_range),
            glyph_range: Some(glyph_range),
        };
        let bitmap_glyph = BitmapGlyphPayload {
            image_resource_id: ImageResourceId(7),
            source_range_utf8: Some(source_range),
            glyph_range: Some(glyph_range),
            placement: Some(placement),
            transform_to_run: Some(identity),
            strike_ppem: Some((16, 16)),
            strike_selection: Some(BitmapStrikeSelection::ProducerResolved),
            pixel_format: Some("rgba8".to_string()),
            color_space: Some("srgb".to_string()),
            alpha_mode: Some(BitmapAlphaMode::Premultiplied),
            scaling_policy: Some(BitmapGlyphScalingPolicy::ExplicitTransform),
            filtering: Some(BitmapGlyphFiltering::Linear),
        };
        let svg_glyph = SvgGlyphPayload {
            vector_resource_id: SvgResourceId(3),
            source_range_utf8: Some(source_range),
            glyph_range: Some(glyph_range),
            placement: Some(placement),
            transform_to_run: Some(identity),
            view_box: Some(SvgGlyphViewBox {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            }),
            intrinsic_size: Some(SvgGlyphIntrinsicSize {
                width: 10.0,
                height: 10.0,
            }),
            security_mode: SvgGlyphSecurityMode::StaticSanitized,
            script_allowed: false,
            animation_allowed: false,
            external_resources_allowed: false,
            interactivity_allowed: false,
        };

        assert_eq!(color_layers.layers[0].fill.as_ref().unwrap().rgba[2], 1.0);
        assert_eq!(
            color_layers
                .palette_ref
                .as_ref()
                .and_then(|palette| palette.cpal_digest.as_deref()),
            Some("sha256:fixture-cpal")
        );
        assert_eq!(
            bitmap_glyph.scaling_policy,
            Some(BitmapGlyphScalingPolicy::ExplicitTransform)
        );
        assert_eq!(bitmap_glyph.filtering, Some(BitmapGlyphFiltering::Linear));
        assert_eq!(svg_glyph.view_box.unwrap().width, 10.0);
        assert!(!svg_glyph.script_allowed);
        assert!(!svg_glyph.animation_allowed);
        assert!(!svg_glyph.external_resources_allowed);
        assert!(!svg_glyph.interactivity_allowed);
        assert!(color_layers.has_colrv0_resolved_layer_contract());
        assert!(bitmap_glyph.has_strict_visual_contract());
        assert!(svg_glyph.has_static_sanitized_contract());

        let mut incomplete_color_layers = color_layers.clone();
        incomplete_color_layers.layers[0].fill = None;
        assert!(!incomplete_color_layers.has_colrv0_resolved_layer_contract());

        let mut backend_default_bitmap = bitmap_glyph.clone();
        backend_default_bitmap.filtering = Some(BitmapGlyphFiltering::BackendDefault);
        assert!(!backend_default_bitmap.has_strict_visual_contract());

        let mut unsafe_svg = svg_glyph;
        unsafe_svg.animation_allowed = true;
        assert!(!unsafe_svg.has_static_sanitized_contract());
    }
}
