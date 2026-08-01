use crate::paint::paint_op::{
    LayerAffineTransform, LayerPoint, LayerTextControlMarkKind, LayerVector, PaintOp,
    PaintVariantMeta, TextClusterBasis, TextClusterFlag, TextClusterPlacement, TextProjectionKind,
    TextRunPlacement,
};
use crate::paint::profile::RenderProfile;
use crate::paint::resources::ResourceArena;
use crate::renderer::render_tree::{BoundingBox, FieldMarkerType, NodeId};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TextSourceId(pub u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TextSourceRange {
    pub start: u32,
    pub end: u32,
}

impl TextSourceRange {
    pub fn new(start: u32, end: u32) -> Self {
        Self { start, end }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct TextSourceSpan {
    pub id: TextSourceId,
    pub utf8_range: TextSourceRange,
    pub utf16_range: TextSourceRange,
    pub stable_source_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TextSourceEntry {
    pub id: TextSourceId,
    pub stable_source_key: Option<String>,
    pub text: String,
    pub utf8_range: TextSourceRange,
    pub utf16_range: TextSourceRange,
    pub annotations: Vec<TextSourceAnnotation>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum TextSourceAnnotation {
    FieldMarker {
        marker: FieldMarkerType,
        range_utf8: TextSourceRange,
        range_utf16: TextSourceRange,
    },
    ParagraphEnd {
        offset_utf8: u32,
        offset_utf16: u32,
    },
    LineBreakEnd {
        offset_utf8: u32,
        offset_utf16: u32,
    },
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct TextSourceTable {
    pub entries: Vec<TextSourceEntry>,
}

impl TextSourceTable {
    pub fn from_layer_node(root: &mut LayerNode) -> Self {
        let mut table = Self::default();
        table.collect_from_node(root);
        table
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    fn collect_from_node(&mut self, node: &mut LayerNode) {
        match &mut node.kind {
            LayerNodeKind::Group { children, .. } => {
                for child in children {
                    self.collect_from_node(child);
                }
            }
            LayerNodeKind::ClipRect { child, .. } => {
                self.collect_from_node(child);
            }
            LayerNodeKind::Leaf { ops, .. } => {
                let mut last_text_source = None;
                for op in ops {
                    match op {
                        PaintOp::TextRun { bbox, run } => {
                            let id = TextSourceId(self.entries.len() as u32);
                            let utf8_range = TextSourceRange::new(0, run.text.len() as u32);
                            let utf16_range =
                                TextSourceRange::new(0, run.text.encode_utf16().count() as u32);
                            let annotations =
                                text_source_annotations(run, utf8_range.end, utf16_range.end);
                            let projection = text_projection_kind(run);
                            let stable_source_key = run
                                .source
                                .as_ref()
                                .and_then(|source| source.stable_source_key.clone());
                            run.source = Some(TextSourceSpan {
                                id,
                                utf8_range,
                                utf16_range,
                                stable_source_key: stable_source_key.clone(),
                            });
                            run.projection = projection;
                            run.placement = Some(text_run_compat_placement(*bbox, run));
                            run.cluster_basis = TextClusterBasis::LegacyPosition;
                            if run.clusters.is_empty() {
                                run.clusters = text_run_legacy_clusters(run, projection);
                            }
                            run.variant =
                                Some(PaintVariantMeta::text_run_default(format!("text-{}", id.0)));
                            last_text_source = run.source.clone();
                            self.entries.push(TextSourceEntry {
                                id,
                                stable_source_key,
                                text: run.text.clone(),
                                utf8_range,
                                utf16_range,
                                annotations,
                            });
                        }
                        PaintOp::CharOverlap { overlap, .. } => {
                            if overlap.source.is_none() {
                                overlap.source = last_text_source.clone();
                            }
                        }
                        PaintOp::TextControlMark { mark, .. } => {
                            if mark.source.is_none() {
                                mark.source = last_text_source.clone();
                            }
                        }
                        PaintOp::TabLeader { leader, .. } => {
                            if leader.source.is_none() {
                                leader.source = last_text_source.clone();
                            }
                        }
                        PaintOp::TextDecoration { decoration, .. } => {
                            if decoration.source.is_none() {
                                decoration.source = last_text_source.clone();
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
    }
}

fn text_projection_kind(run: &crate::paint::paint_op::LayerTextRunPaint) -> TextProjectionKind {
    if run.char_overlap.is_some() {
        TextProjectionKind::SyntheticVisual
    } else if run.display_text.is_some() {
        TextProjectionKind::Normalized
    } else if run.field_marker != FieldMarkerType::None {
        TextProjectionKind::FieldProjection
    } else if run.text.is_empty()
        && (run.is_para_end || run.is_line_break_end || !run.control_marks.is_empty())
    {
        TextProjectionKind::ControlProjection
    } else {
        TextProjectionKind::Verbatim
    }
}

fn text_run_compat_placement(
    bbox: BoundingBox,
    run: &crate::paint::paint_op::LayerTextRunPaint,
) -> TextRunPlacement {
    let radians = run.rotation.to_radians();
    let (sin, cos) = radians.sin_cos();
    let local_origin_x = -bbox.width / 2.0;
    let local_origin_y = -bbox.height / 2.0 + run.baseline;
    let center_x = bbox.x + bbox.width / 2.0;
    let center_y = bbox.y + bbox.height / 2.0;
    TextRunPlacement {
        run_to_page: LayerAffineTransform {
            a: cos,
            b: sin,
            c: -sin,
            d: cos,
            e: center_x + cos * local_origin_x - sin * local_origin_y,
            f: center_y + sin * local_origin_x + cos * local_origin_y,
        },
        baseline_y: 0.0,
    }
}

fn text_run_legacy_clusters(
    run: &crate::paint::paint_op::LayerTextRunPaint,
    projection: TextProjectionKind,
) -> Vec<TextClusterPlacement> {
    let mut clusters = Vec::new();
    let mut utf16_start = 0_u32;
    let char_starts = run
        .text
        .char_indices()
        .map(|(offset, ch)| (offset as u32, ch))
        .collect::<Vec<_>>();
    for (idx, (utf8_start, ch)) in char_starts.iter().enumerate() {
        let utf8_end = char_starts
            .get(idx + 1)
            .map_or(run.text.len() as u32, |(next, _)| *next);
        let utf16_end = utf16_start + ch.len_utf16() as u32;
        let origin_x = run.positions.get(idx).copied().unwrap_or_default();
        let advance = run.positions.get(idx + 1).map(|next| LayerVector {
            dx: *next - origin_x,
            dy: 0.0,
        });
        let flags = if run.char_overlap.is_some() {
            vec![
                TextClusterFlag::SpecialVisual,
                TextClusterFlag::NotShapingCandidate,
            ]
        } else {
            Vec::new()
        };
        clusters.push(TextClusterPlacement {
            source_range_utf8: TextSourceRange::new(*utf8_start, utf8_end),
            text_range_utf8: TextSourceRange::new(*utf8_start, utf8_end),
            text_range_utf16: Some(TextSourceRange::new(utf16_start, utf16_end)),
            projection,
            origin: LayerPoint {
                x: origin_x,
                y: 0.0,
            },
            advance,
            flags,
        });
        utf16_start = utf16_end;
    }
    clusters
}

fn text_source_annotations(
    run: &crate::paint::paint_op::LayerTextRunPaint,
    utf8_end: u32,
    utf16_end: u32,
) -> Vec<TextSourceAnnotation> {
    let mut annotations = Vec::new();
    if run.field_marker != FieldMarkerType::None {
        annotations.push(TextSourceAnnotation::FieldMarker {
            marker: run.field_marker,
            range_utf8: TextSourceRange::new(0, utf8_end),
            range_utf16: TextSourceRange::new(0, utf16_end),
        });
    }
    if run.is_para_end {
        annotations.push(TextSourceAnnotation::ParagraphEnd {
            offset_utf8: utf8_end,
            offset_utf16: utf16_end,
        });
    }
    if run.is_line_break_end {
        annotations.push(TextSourceAnnotation::LineBreakEnd {
            offset_utf8: utf8_end,
            offset_utf16: utf16_end,
        });
    }
    annotations
}

/// 한 페이지의 visual layer tree.
///
/// Semantic render tree에서 backend replay용으로 내려간 안정화된 visual IR이다.
/// backend가 다시 레이아웃을 해석하지 않도록 clip/group/leaf 순서와 paint payload를
/// 고정하고, 문서 의미는 `LayerSemantic`의 작은 디버그/히트테스트 메타데이터로만
/// 분리해 둔다.
#[derive(Debug, Clone)]
pub struct PageLayerTree {
    pub page_width: f64,
    pub page_height: f64,
    pub profile: RenderProfile,
    pub output_options: LayerOutputOptions,
    pub root: LayerNode,
    /// Schema-v1/Phase-2 sidecar variant payloads.
    ///
    /// Current writers normally keep text variants in the root leaf stream, but
    /// readers and v2 compatibility lowering accept sidecar payloads anchored by
    /// `PaintVariantMeta::anchor_op_id`.
    pub variant_ops: Vec<PaintOp>,
    pub resources: ResourceArena,
    pub text_sources: TextSourceTable,
}

impl PageLayerTree {
    pub fn builder(page_width: f64, page_height: f64, root: LayerNode) -> PageLayerTreeBuilder {
        PageLayerTreeBuilder::new(page_width, page_height, root)
    }

    pub fn new(page_width: f64, page_height: f64, root: LayerNode) -> Self {
        Self::builder(page_width, page_height, root).build()
    }

    pub fn with_resources(
        page_width: f64,
        page_height: f64,
        root: LayerNode,
        resources: ResourceArena,
    ) -> Self {
        Self::builder(page_width, page_height, root)
            .resources(resources)
            .build()
    }

    pub fn with_profile(
        page_width: f64,
        page_height: f64,
        root: LayerNode,
        profile: RenderProfile,
    ) -> Self {
        Self::builder(page_width, page_height, root)
            .profile(profile)
            .build()
    }

    pub fn with_resources_and_profile(
        page_width: f64,
        page_height: f64,
        root: LayerNode,
        resources: ResourceArena,
        profile: RenderProfile,
    ) -> Self {
        Self::builder(page_width, page_height, root)
            .resources(resources)
            .profile(profile)
            .build()
    }

    pub fn with_output_options(mut self, output_options: LayerOutputOptions) -> Self {
        self.output_options = output_options;
        self
    }

    /// Runs the post-layout text shaping/lowering pass on this tree.
    ///
    /// This is opt-in while schema v1 keeps `TextRun` as the compatibility
    /// replay contract. The lowerer may append optional `GlyphRun` variants,
    /// but the original `TextRun` fallback remains in the same paint-order
    /// slot through variant metadata.
    pub fn lower_text_shapes(
        &mut self,
        resolver: &dyn crate::paint::FontResolver,
    ) -> crate::paint::TextShapeReport {
        crate::paint::TextShapeLowerer::new(resolver).lower_root(&mut self.root)
    }
}

#[derive(Debug, Clone)]
pub struct PageLayerTreeBuilder {
    page_width: f64,
    page_height: f64,
    profile: RenderProfile,
    output_options: LayerOutputOptions,
    root: LayerNode,
    variant_ops: Vec<PaintOp>,
    resources: ResourceArena,
    text_sources: Option<TextSourceTable>,
}

impl PageLayerTreeBuilder {
    pub fn new(page_width: f64, page_height: f64, root: LayerNode) -> Self {
        Self {
            page_width,
            page_height,
            profile: RenderProfile::default(),
            output_options: LayerOutputOptions::default(),
            root,
            variant_ops: Vec::new(),
            resources: ResourceArena::default(),
            text_sources: None,
        }
    }

    pub fn resources(mut self, resources: ResourceArena) -> Self {
        self.resources = resources;
        self
    }

    pub fn profile(mut self, profile: RenderProfile) -> Self {
        self.profile = profile;
        self
    }

    pub fn output_options(mut self, output_options: LayerOutputOptions) -> Self {
        self.output_options = output_options;
        self
    }

    pub fn variant_ops(mut self, variant_ops: Vec<PaintOp>) -> Self {
        self.variant_ops = variant_ops;
        self
    }

    pub fn text_sources(mut self, text_sources: TextSourceTable) -> Self {
        self.text_sources = Some(text_sources);
        self
    }

    pub fn build(self) -> PageLayerTree {
        let mut root = self.root;
        let text_sources = self
            .text_sources
            .unwrap_or_else(|| TextSourceTable::from_layer_node(&mut root));
        PageLayerTree {
            page_width: self.page_width,
            page_height: self.page_height,
            profile: self.profile,
            output_options: self.output_options,
            root,
            variant_ops: self.variant_ops,
            resources: self.resources,
            text_sources,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct LayerOutputOptions {
    /// Lowers visible paragraph-end marks into text control mark payloads.
    pub show_paragraph_marks: bool,
    /// Lowers visible control-code marks and object labels into layer payloads.
    pub show_control_codes: bool,
    /// RenderTree/layout build option. Exported for cache keys and schema context;
    /// replayers should consume the already-lowered transparent border paint ops.
    pub show_transparent_borders: bool,
    /// Layer build/replay option. Builders omit Body/TableCell ClipRect nodes when false;
    /// replayers also skip defensive ClipRect nodes when present in older trees.
    pub clip_enabled: bool,
    /// Debug display option. Currently consumed by debug-capable replayers and exported
    /// separately as debugOptions for frontend/runtime feature gating.
    pub debug_overlay: bool,
}

impl Default for LayerOutputOptions {
    fn default() -> Self {
        Self {
            show_paragraph_marks: false,
            show_control_codes: false,
            show_transparent_borders: false,
            clip_enabled: true,
            debug_overlay: false,
        }
    }
}

impl LayerOutputOptions {
    pub fn allows_text_control_mark(self, kind: LayerTextControlMarkKind) -> bool {
        match kind {
            LayerTextControlMarkKind::ParagraphEnd => self.show_paragraph_marks,
            LayerTextControlMarkKind::Space
            | LayerTextControlMarkKind::Tab
            | LayerTextControlMarkKind::LineBreakEnd
            | LayerTextControlMarkKind::Table
            | LayerTextControlMarkKind::Picture
            | LayerTextControlMarkKind::TextBox
            | LayerTextControlMarkKind::Equation
            | LayerTextControlMarkKind::Header
            | LayerTextControlMarkKind::Footer
            | LayerTextControlMarkKind::FootnoteArea => self.show_control_codes,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CacheHint {
    #[default]
    None,
    StaticSubtree,
    PreferRaster,
    PreferVectorRecording,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClipKind {
    Body,
    TableCell,
    TextBox,
    Generic,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ClipPolicy {
    pub right_overflow_slop: f64,
    pub allow_horizontal_overflow_controls: bool,
}

impl ClipPolicy {
    pub fn for_kind(kind: ClipKind) -> Self {
        match kind {
            ClipKind::Body => Self {
                right_overflow_slop: 4.0,
                allow_horizontal_overflow_controls: true,
            },
            ClipKind::TableCell => Self {
                right_overflow_slop: 4.0,
                allow_horizontal_overflow_controls: false,
            },
            ClipKind::TextBox => Self {
                right_overflow_slop: 0.0,
                allow_horizontal_overflow_controls: false,
            },
            ClipKind::Generic => Self {
                right_overflow_slop: 0.0,
                allow_horizontal_overflow_controls: false,
            },
        }
    }
}

#[derive(Debug, Clone)]
pub struct LayerNode {
    pub bounds: BoundingBox,
    pub source_node_id: Option<NodeId>,
    pub semantic: LayerSemantic,
    pub kind: LayerNodeKind,
}

impl LayerNode {
    pub fn group(
        bounds: BoundingBox,
        source_node_id: Option<NodeId>,
        children: Vec<LayerNode>,
        cache_hint: CacheHint,
        semantic: LayerSemantic,
    ) -> Self {
        Self {
            bounds,
            source_node_id,
            semantic,
            kind: LayerNodeKind::Group {
                children,
                cache_hint,
            },
        }
    }

    pub fn clip_rect(
        bounds: BoundingBox,
        source_node_id: Option<NodeId>,
        clip: BoundingBox,
        child: LayerNode,
        clip_kind: ClipKind,
    ) -> Self {
        let clip_policy = ClipPolicy::for_kind(clip_kind);
        Self {
            bounds,
            source_node_id,
            semantic: LayerSemantic::default(),
            kind: LayerNodeKind::ClipRect {
                clip,
                child: Box::new(child),
                clip_kind,
                clip_policy,
            },
        }
    }

    pub fn leaf(bounds: BoundingBox, source_node_id: Option<NodeId>, ops: Vec<PaintOp>) -> Self {
        Self::leaf_with_hint(bounds, source_node_id, ops, CacheHint::None)
    }

    pub fn leaf_with_hint(
        bounds: BoundingBox,
        source_node_id: Option<NodeId>,
        ops: Vec<PaintOp>,
        cache_hint: CacheHint,
    ) -> Self {
        Self {
            bounds,
            source_node_id,
            semantic: LayerSemantic::default(),
            kind: LayerNodeKind::Leaf { ops, cache_hint },
        }
    }
}

#[derive(Debug, Clone)]
pub enum LayerNodeKind {
    Group {
        children: Vec<LayerNode>,
        cache_hint: CacheHint,
    },
    ClipRect {
        clip: BoundingBox,
        child: Box<LayerNode>,
        clip_kind: ClipKind,
        clip_policy: ClipPolicy,
    },
    Leaf {
        ops: Vec<PaintOp>,
        cache_hint: CacheHint,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LayerSemanticRole {
    #[default]
    Generic,
    Page,
    MasterPage,
    Header,
    Footer,
    Body,
    Column,
    FootnoteArea,
    TextLine,
    Table,
    TableCell,
    TextBox,
    Group,
}

impl LayerSemanticRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Generic => "generic",
            Self::Page => "page",
            Self::MasterPage => "masterPage",
            Self::Header => "header",
            Self::Footer => "footer",
            Self::Body => "body",
            Self::Column => "column",
            Self::FootnoteArea => "footnoteArea",
            Self::TextLine => "textLine",
            Self::Table => "table",
            Self::TableCell => "tableCell",
            Self::TextBox => "textBox",
            Self::Group => "group",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct LayerSemantic {
    pub role: LayerSemanticRole,
    pub section_index: Option<usize>,
    pub column_index: Option<u16>,
    pub para_index: Option<usize>,
    pub control_index: Option<usize>,
    pub row_count: Option<u16>,
    pub col_count: Option<u16>,
}

impl LayerSemantic {
    pub fn role(role: LayerSemanticRole) -> Self {
        Self {
            role,
            ..Self::default()
        }
    }

    pub fn column(index: u16) -> Self {
        Self {
            role: LayerSemanticRole::Column,
            column_index: Some(index),
            ..Self::default()
        }
    }

    pub fn text_line(section_index: Option<usize>, para_index: Option<usize>) -> Self {
        Self {
            role: LayerSemanticRole::TextLine,
            section_index,
            para_index,
            ..Self::default()
        }
    }

    pub fn table(
        section_index: Option<usize>,
        para_index: Option<usize>,
        control_index: Option<usize>,
        row_count: u16,
        col_count: u16,
    ) -> Self {
        Self {
            role: LayerSemanticRole::Table,
            section_index,
            column_index: None,
            para_index,
            control_index,
            row_count: Some(row_count),
            col_count: Some(col_count),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paint::{
        FontFaceKey, FontFallbackPolicyId, FontInstanceKey, FontRequest, GlyphCluster, GlyphRange,
        GlyphRunDiagnostics, GlyphRunReplayEligibility, LayerPoint, LayerVector, ResolvedFontFace,
        ResolvedGlyphRun, ScriptTag, ShapeKey, ShapingEngineId, TextDirection, TextVariantQuality,
        WritingMode,
    };
    use crate::renderer::TextStyle;

    struct TestGlyphResolver;

    impl crate::paint::FontResolver for TestGlyphResolver {
        fn resolve_font(&self, _request: &FontRequest) -> ResolvedFontFace {
            ResolvedFontFace {
                portability: crate::paint::FontPortabilityKind::PortableBlob,
            }
        }

        fn shape_glyph_run(
            &self,
            _request: &FontRequest,
            run: &crate::paint::LayerTextRunPaint,
            _resolved: &ResolvedFontFace,
        ) -> Option<ResolvedGlyphRun> {
            Some(ResolvedGlyphRun {
                shape_key: ShapeKey {
                    font_instance: FontInstanceKey {
                        face_key: FontFaceKey("test-face".to_string()),
                        size_px: run.style.font_size.max(12.0),
                        variations: Vec::new(),
                        synthetic_bold: false,
                        synthetic_italic: false,
                    },
                    direction: TextDirection::Ltr,
                    writing_mode: WritingMode::HorizontalTb,
                    script: Some(ScriptTag("DFLT".to_string())),
                    language: None,
                    features: Vec::new(),
                    shaping_engine: ShapingEngineId("test".to_string()),
                    fallback_policy: FontFallbackPolicyId("none".to_string()),
                },
                glyph_ids: vec![42],
                positions: vec![LayerPoint { x: 0.0, y: 0.0 }],
                advances: Some(vec![LayerVector { dx: 10.0, dy: 0.0 }]),
                clusters: vec![GlyphCluster {
                    source_range_utf8: TextSourceRange::new(0, run.text.len() as u32),
                    source_range_utf16: Some(TextSourceRange::new(
                        0,
                        run.text.encode_utf16().count() as u32,
                    )),
                    text_range_utf8: Some(TextSourceRange::new(0, run.text.len() as u32)),
                    glyph_range: GlyphRange::new(0, 1),
                    flags: Vec::new(),
                }],
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
            })
        }
    }

    #[test]
    fn page_layer_tree_builds_internal_text_source_table_and_spans() {
        let root = LayerNode::leaf(
            BoundingBox::new(0.0, 0.0, 80.0, 20.0),
            None,
            vec![
                PaintOp::TextRun {
                    bbox: BoundingBox::new(0.0, 0.0, 30.0, 12.0),
                    run: crate::paint::LayerTextRunPaint {
                        source: None,
                        text: "가A".to_string(),
                        display_text: None,
                        style: TextStyle::default(),
                        positions: vec![0.0, 10.0, 20.0],
                        control_marks: Vec::new(),
                        baseline: 10.0,
                        rotation: 0.0,
                        is_vertical: false,
                        orientation: crate::paint::LayerTextOrientation::Horizontal,
                        char_overlap: None,
                        legacy_visuals: crate::paint::TextLegacyVisuals::default(),
                        field_marker: FieldMarkerType::FieldBegin,
                        is_para_end: true,
                        is_line_break_end: false,
                        ..Default::default()
                    },
                },
                PaintOp::TextRun {
                    bbox: BoundingBox::new(32.0, 0.0, 20.0, 12.0),
                    run: crate::paint::LayerTextRunPaint {
                        source: Some(TextSourceSpan {
                            id: TextSourceId(99),
                            utf8_range: TextSourceRange::new(4, 8),
                            utf16_range: TextSourceRange::new(2, 4),
                            stable_source_key: Some("hwp-source-v1".to_string()),
                        }),
                        text: "B".to_string(),
                        display_text: None,
                        style: TextStyle::default(),
                        positions: vec![0.0, 9.0],
                        control_marks: Vec::new(),
                        baseline: 10.0,
                        rotation: 0.0,
                        is_vertical: false,
                        orientation: crate::paint::LayerTextOrientation::Horizontal,
                        char_overlap: None,
                        legacy_visuals: crate::paint::TextLegacyVisuals::default(),
                        field_marker: FieldMarkerType::None,
                        is_para_end: false,
                        is_line_break_end: true,
                        ..Default::default()
                    },
                },
            ],
        );

        let tree = PageLayerTree::new(100.0, 100.0, root);

        assert_eq!(tree.text_sources.entries.len(), 2);
        assert_eq!(tree.text_sources.entries[0].id, TextSourceId(0));
        assert_eq!(tree.text_sources.entries[0].text, "가A");
        assert_eq!(
            tree.text_sources.entries[0].utf8_range,
            TextSourceRange::new(0, 4)
        );
        assert_eq!(
            tree.text_sources.entries[0].utf16_range,
            TextSourceRange::new(0, 2)
        );
        assert_eq!(tree.text_sources.entries[0].annotations.len(), 2);
        assert_eq!(
            tree.text_sources.entries[1].stable_source_key.as_deref(),
            Some("hwp-source-v1")
        );

        let LayerNodeKind::Leaf { ops, .. } = &tree.root.kind else {
            panic!("expected leaf root");
        };
        let PaintOp::TextRun { run, .. } = &ops[0] else {
            panic!("expected text run");
        };
        let source = run.source.as_ref().expect("source span should be set");
        assert_eq!(source.id, TextSourceId(0));
        assert_eq!(source.utf8_range, TextSourceRange::new(0, 4));
        assert_eq!(run.projection, TextProjectionKind::FieldProjection);
        assert_eq!(run.cluster_basis, TextClusterBasis::LegacyPosition);
        let placement = run.placement.expect("placement should be set");
        assert_eq!(placement.baseline_y, 0.0);
        assert_eq!(placement.run_to_page.e, 0.0);
        assert_eq!(placement.run_to_page.f, 10.0);
        assert_eq!(run.clusters.len(), 2);
        assert_eq!(
            run.clusters[0].source_range_utf8,
            TextSourceRange::new(0, 3)
        );
        assert_eq!(
            run.clusters[0].text_range_utf16,
            Some(TextSourceRange::new(0, 1))
        );
        assert_eq!(
            run.clusters[0].projection,
            TextProjectionKind::FieldProjection
        );

        let PaintOp::TextRun { run, .. } = &ops[1] else {
            panic!("expected text run");
        };
        let source = run.source.as_ref().expect("source span should be set");
        assert_eq!(source.id, TextSourceId(1));
        assert_eq!(source.stable_source_key.as_deref(), Some("hwp-source-v1"));
        assert_eq!(run.projection, TextProjectionKind::Verbatim);
    }

    #[test]
    fn page_layer_tree_can_run_opt_in_text_shape_lowerer() {
        let root = LayerNode::leaf(
            BoundingBox::new(0.0, 0.0, 80.0, 20.0),
            None,
            vec![PaintOp::TextRun {
                bbox: BoundingBox::new(0.0, 0.0, 30.0, 12.0),
                run: crate::paint::LayerTextRunPaint {
                    text: "A".to_string(),
                    display_text: None,
                    style: TextStyle {
                        font_size: 16.0,
                        ..Default::default()
                    },
                    positions: vec![0.0, 10.0],
                    baseline: 10.0,
                    ..Default::default()
                },
            }],
        );
        let mut tree = PageLayerTree::new(100.0, 100.0, root);
        let report = tree.lower_text_shapes(&TestGlyphResolver);

        assert_eq!(report.public_glyph_run_count(), 1);
        let LayerNodeKind::Leaf { ops, .. } = &tree.root.kind else {
            panic!("expected leaf root");
        };
        assert!(matches!(ops[0], PaintOp::TextRun { .. }));
        let PaintOp::GlyphRun { run, .. } = &ops[1] else {
            panic!("expected glyph run");
        };
        assert_eq!(run.variant.equivalence_group, "text-0");
        assert_eq!(run.variant.variant_id, "glyphRun");
        assert_eq!(run.glyph_ids, vec![42]);
    }
}
