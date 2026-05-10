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
    pub paint_style: PaintTextStyle,
    pub placement: TextRunPlacement,
    pub paths: Vec<LayerGlyphOutlinePath>,
    pub diagnostics: GlyphRunDiagnostics,
}

#[derive(Debug, Clone)]
pub struct LayerGlyphOutlinePath {
    pub commands: Vec<PathCommand>,
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
                let amount = outline
                    .paint_style
                    .font_size
                    .max(outline.paint_style.shadow_offset_x.abs())
                    .max(outline.paint_style.shadow_offset_y.abs())
                    .max(1.0)
                    * 0.2;
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
}
