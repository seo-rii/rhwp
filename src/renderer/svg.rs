//! SVG 렌더러 (2차 백엔드)
//!
//! 렌더 트리를 SVG 문자열로 변환한다.
//! 정적 출력(인쇄, PDF 변환 등)에 적합하다.

use super::composer::{
    char_overlap_inner_size_ratio, decode_pua_overlap_number, pua_to_display_text, CharOverlapInfo,
};
use super::form_caption::display_form_caption;
use super::layout::{compute_char_positions, split_into_clusters};
use super::render_tree::{
    BoundingBox, FormObjectNode, ImageNode, PageRenderTree, RenderNode, RenderNodeType,
    ShapeTransform,
};
use super::{
    GradientFillInfo, LineStyle, PathCommand, PatternFillInfo, Renderer, ShapeStyle, StrokeDash,
    TextStyle,
};
use crate::model::control::FormType;
use crate::model::shape::TextWrap;
use crate::model::style::{ImageFillMode, UnderlineType};
use crate::paint::{
    layer_node_has_replay_plane, paint_op_replay_plane, sidecars_for_leaf_ops,
    BitmapGlyphFiltering, ClipKind, GlyphOutlineFillRule, GlyphOutlinePayloadKind,
    LayerAffineTransform, LayerEquationPaint, LayerFormObjectPaint, LayerGlyphOutlinePaint,
    LayerImagePaint, LayerNode, LayerNodeKind, LayerPageBackgroundPaint, LayerSemantic,
    LayerSemanticRole, LayerTextDecorationKind, LayerTextDecorationPaint, LayerTextRunPaint,
    PageLayerTree, PaintOp, PaintReplayPlane, ResourceArena, TextSourceEntry, TextSourceTable,
};
use crate::renderer::layer_renderer::{
    select_text_variant_sets_with_report, should_render_selected_text_variant,
    VariantOutlineEligibilityReport, VariantRejectReason, VariantReplayStatus,
    VariantSelectionBackend, VariantSelectionContext, VariantSelectionReport,
};
use crate::renderer::static_svg::static_svg_fragment_has_path_layer;
use base64::Engine;

/// SVG 폰트 임베딩 모드
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub enum FontEmbedMode {
    /// 폰트 임베딩 없음 (CSS font-family 체인만)
    #[default]
    None,
    /// @font-face + local() 참조만 (데이터 미포함)
    Style,
    /// 사용 글자만 서브셋 추출 + base64 임베딩
    Subset,
    /// 전체 폰트 base64 임베딩
    Full,
}

/// SVG 렌더러
pub struct SvgRenderer {
    /// SVG 출력 버퍼
    output: String,
    /// 그라데이션 정의 버퍼 (<defs> 내부)
    defs: Vec<String>,
    /// 그라데이션 ID 카운터
    gradient_counter: u32,
    /// 클립/패턴 ID 카운터
    clip_counter: u32,
    /// <defs> 삽입 위치 (begin_page 후 기록)
    defs_insert_pos: usize,
    /// 페이지 폭
    width: f64,
    /// 페이지 높이
    height: f64,
    /// 문단부호(¶) 표시 여부
    pub show_paragraph_marks: bool,
    /// 조판부호 표시 여부 (개체 마커)
    pub show_control_codes: bool,
    /// 디버그 오버레이 표시 여부
    pub debug_overlay: bool,
    /// 레이어 ClipRect 적용 여부
    clip_enabled: bool,
    /// 디버그 오버레이용: 문단별 경계 수집 (pi → bbox)
    overlay_para_bounds: std::collections::HashMap<usize, OverlayBounds>,
    /// 디버그 오버레이용: 표 경계 수집
    overlay_table_bounds: Vec<OverlayTableInfo>,
    /// 디버그 오버레이용: 표/머리말/꼬리말 내부 깊이 (셀 내·헤더 문단 제외)
    overlay_skip_depth: u32,
    /// 디버그 오버레이용: 현재 페이지의 메인 섹션 인덱스 (-1이면 미설정)
    overlay_page_section: i32,
    /// 생성된 화살표 마커 ID 집합 (중복 방지)
    arrow_marker_ids: std::collections::HashSet<String>,
    /// 폰트 임베딩 모드
    pub font_embed_mode: FontEmbedMode,
    /// 추가 폰트 탐색 경로
    pub font_paths: Vec<std::path::PathBuf>,
    /// 사용된 폰트별 codepoint 수집 (font_family → codepoints)
    font_codepoints: std::collections::HashMap<String, std::collections::HashSet<char>>,
    /// Strict visual SVG profile: replay selected monochrome glyph outlines
    /// instead of the anchored TextRun fallback.
    strict_glyph_outline_replay: bool,
    current_render_profile: String,
    /// Backend-local text variant selection diagnostics for the last layer render.
    text_variant_selection_diagnostics: Vec<VariantSelectionReport>,
}

/// 디버그 오버레이용 문단 경계 정보
struct OverlayBounds {
    section_index: usize,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// 디버그 오버레이용 표 정보
struct OverlayTableInfo {
    section_index: usize,
    para_index: usize,
    control_index: usize,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    row_count: u16,
    col_count: u16,
}

impl SvgRenderer {
    pub fn new() -> Self {
        Self {
            output: String::new(),
            defs: Vec::new(),
            gradient_counter: 0,
            clip_counter: 0,
            defs_insert_pos: 0,
            width: 0.0,
            height: 0.0,
            show_paragraph_marks: false,
            show_control_codes: false,
            debug_overlay: false,
            clip_enabled: true,
            overlay_para_bounds: std::collections::HashMap::new(),
            overlay_table_bounds: Vec::new(),
            overlay_skip_depth: 0,
            overlay_page_section: -1,
            arrow_marker_ids: std::collections::HashSet::new(),
            font_embed_mode: FontEmbedMode::None,
            font_paths: Vec::new(),
            font_codepoints: std::collections::HashMap::new(),
            strict_glyph_outline_replay: false,
            current_render_profile: "screen".to_string(),
            text_variant_selection_diagnostics: Vec::new(),
        }
    }

    /// 생성된 SVG 문자열 반환
    pub fn output(&self) -> &str {
        &self.output
    }

    pub fn set_strict_glyph_outline_replay(&mut self, enabled: bool) {
        self.strict_glyph_outline_replay = enabled;
    }

    pub fn text_variant_selection_diagnostics(&self) -> &[VariantSelectionReport] {
        &self.text_variant_selection_diagnostics
    }

    /// 수집된 폰트별 사용 글자 목록 반환
    pub fn font_codepoints(
        &self,
    ) -> &std::collections::HashMap<String, std::collections::HashSet<char>> {
        &self.font_codepoints
    }

    /// 렌더 트리를 SVG로 렌더링
    pub fn render_tree(&mut self, tree: &PageRenderTree) {
        self.render_node(&tree.root);
    }

    fn render_node_replay_plane(node: &RenderNode) -> PaintReplayPlane {
        match &node.node_type {
            RenderNodeType::PageBackground(_) => PaintReplayPlane::Background,
            RenderNodeType::Image(image) => match image.text_wrap {
                Some(TextWrap::BehindText) => PaintReplayPlane::BehindText,
                Some(TextWrap::InFrontOfText) => PaintReplayPlane::InFrontOfText,
                _ => PaintReplayPlane::Flow,
            },
            _ => PaintReplayPlane::Flow,
        }
    }

    fn children_need_replay_plane_reorder(node: &RenderNode) -> bool {
        node.children
            .iter()
            .any(|child| Self::render_node_replay_plane(child) != PaintReplayPlane::Flow)
    }

    /// 레이어 트리를 SVG로 직접 재생한다.
    pub fn render_layer_tree(&mut self, tree: &PageLayerTree) {
        self.show_paragraph_marks = tree.output_options.show_paragraph_marks;
        self.show_control_codes = tree.output_options.show_control_codes;
        self.debug_overlay = tree.output_options.debug_overlay;
        self.clip_enabled = tree.output_options.clip_enabled;
        self.current_render_profile = tree.profile.as_str().to_string();
        self.text_variant_selection_diagnostics.clear();
        self.begin_page(tree.page_width, tree.page_height);
        if self.strict_glyph_outline_replay && !tree.text_sources.is_empty() {
            self.render_text_source_metadata(&tree.text_sources);
        }
        for replay_plane in PaintReplayPlane::ORDERED {
            self.render_layer_node(&tree.root, &tree.resources, &tree.variant_ops, replay_plane);
        }
        self.end_page();
    }

    fn render_text_source_metadata(&mut self, text_sources: &TextSourceTable) {
        self.output
            .push_str("<metadata id=\"rhwp-text-sources\" type=\"application/json\">");
        self.output
            .push_str(&escape_xml(&text_sources_metadata_json(text_sources)));
        self.output.push_str("</metadata>\n");
    }

    fn render_layer_node(
        &mut self,
        node: &LayerNode,
        resources: &ResourceArena,
        variant_ops: &[PaintOp],
        replay_plane: PaintReplayPlane,
    ) {
        if !layer_node_has_replay_plane(node, variant_ops, replay_plane) {
            return;
        }
        match &node.kind {
            LayerNodeKind::Group { children, .. } => {
                self.enter_layer_group(node.bounds, &node.semantic);
                for child in children {
                    self.render_layer_node(child, resources, variant_ops, replay_plane);
                }
                self.leave_layer_group(node.bounds, &node.semantic);
            }
            LayerNodeKind::ClipRect {
                clip,
                child,
                clip_kind,
                clip_policy,
            } => {
                if !self.clip_enabled {
                    self.render_layer_node(child, resources, variant_ops, replay_plane);
                    return;
                }
                let clip_id = match clip_kind {
                    ClipKind::Body => format!(
                        "body-clip-{}",
                        node.source_node_id.unwrap_or_else(|| self.next_clip_id())
                    ),
                    ClipKind::TableCell => format!(
                        "cell-clip-{}",
                        node.source_node_id.unwrap_or_else(|| self.next_clip_id())
                    ),
                    ClipKind::TextBox => format!(
                        "textbox-clip-{}",
                        node.source_node_id.unwrap_or_else(|| self.next_clip_id())
                    ),
                    ClipKind::Generic => format!("layer-clip-{}", self.next_clip_id()),
                };
                self.defs.push(format!(
                    "<clipPath id=\"{}\"><rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\"/></clipPath>\n",
                    clip_id,
                    clip.x,
                    clip.y,
                    clip.width + clip_policy.right_overflow_slop,
                    clip.height,
                ));
                self.output
                    .push_str(&format!("<g clip-path=\"url(#{})\">", clip_id));
                self.render_layer_node(child, resources, variant_ops, replay_plane);
                self.output.push_str("</g>\n");
            }
            LayerNodeKind::Leaf { ops, .. } => {
                let strict_outline = self.strict_glyph_outline_replay;
                let sidecars = sidecars_for_leaf_ops(ops, variant_ops);
                let mut selection_ops = Vec::with_capacity(ops.len() + sidecars.len());
                selection_ops.extend(ops.iter().cloned());
                selection_ops.extend(sidecars.iter().cloned());
                let selection = select_text_variant_sets_with_report(
                    &selection_ops,
                    |_| {
                        VariantReplayStatus::rejected(
                            VariantRejectReason::BackendDoesNotSupportVariant,
                        )
                    },
                    |op| match op {
                        PaintOp::GlyphOutline { bbox, outline } => {
                            let (replayable, reason, payload_supported, paint_style_supported) =
                                if !strict_outline {
                                    (
                                        false,
                                        Some(VariantRejectReason::BackendDoesNotSupportVariant),
                                        true,
                                        outline.paint_style.is_fill_only_glyph_replay(),
                                    )
                                } else if outline.variant.anchor_op_id.is_none() {
                                    (
                                        false,
                                        Some(VariantRejectReason::UnsupportedOutlinePayload),
                                        false,
                                        outline.paint_style.is_fill_only_glyph_replay(),
                                    )
                                } else if !outline.has_exclusive_payload_family() {
                                    (
                                        false,
                                        Some(VariantRejectReason::MixedGlyphOutlinePayload),
                                        false,
                                        outline.paint_style.is_fill_only_glyph_replay(),
                                    )
                                } else {
                                    let (payload_supported, payload_reason) = match outline
                                        .payload_kind
                                    {
                                        GlyphOutlinePayloadKind::MonochromeFill => {
                                            if outline.paths.is_empty() {
                                                (
                                                    false,
                                                    Some(
                                                        VariantRejectReason::EmptyGlyphOutlinePayload,
                                                    ),
                                                )
                                            } else if !glyph_outline_paths_are_replayable(outline) {
                                                (
                                                    false,
                                                    Some(
                                                        VariantRejectReason::UnsupportedOutlinePayload,
                                                    ),
                                                )
                                            } else if outline.stroke.is_some() {
                                                (
                                                    false,
                                                    Some(VariantRejectReason::UnsupportedOutlinePayload),
                                                )
                                            } else {
                                                (true, None)
                                            }
                                        }
                                        GlyphOutlinePayloadKind::MonochromeFillStroke => {
                                            if outline.paths.is_empty() {
                                                (
                                                    false,
                                                    Some(
                                                        VariantRejectReason::EmptyGlyphOutlinePayload,
                                                    ),
                                                )
                                            } else if !glyph_outline_paths_are_replayable(outline) {
                                                (
                                                    false,
                                                    Some(
                                                        VariantRejectReason::UnsupportedOutlinePayload,
                                                    ),
                                                )
                                            } else if outline.stroke.as_ref().is_some_and(
                                                |stroke| stroke.is_supported_monochrome_subset(),
                                            ) {
                                                (true, None)
                                            } else {
                                                (
                                                    false,
                                                    Some(
                                                        VariantRejectReason::GlyphOutlineStrokeStyleUnsupported,
                                                    ),
                                                )
                                            }
                                        }
                                        GlyphOutlinePayloadKind::ColorLayers => {
                                            let has_colrv0_features =
                                                outline.variant.requires.iter().any(|feature| {
                                                    feature == "text.glyphOutline.colorLayers"
                                                }) && outline.variant.requires.iter().any(
                                                    |feature| {
                                                        feature
                                                        == "text.glyphOutline.colorLayers.colrV0"
                                                    },
                                                );
                                            if has_colrv0_features
                                                && outline.color_layers.as_ref().is_some_and(
                                                    |payload| {
                                                        payload.has_colrv0_resolved_layer_contract()
                                                    },
                                                )
                                            {
                                                (true, None)
                                            } else if outline.variant.requires.iter().any(
                                                |feature| {
                                                    feature == "text.glyphOutline.colorLayers"
                                                },
                                            ) && outline.variant.requires.iter().any(
                                                |feature| {
                                                    feature
                                                        == "text.glyphOutline.colorLayers.colrV1"
                                                },
                                            ) && outline
                                                .color_layers
                                                .as_ref()
                                                .is_some_and(|payload| {
                                                    payload.has_colrv1_supported_graph_contract()
                                                        && payload.paint_graph.as_ref().is_some_and(
                                                            |graph| {
                                                                graph.nodes.iter().all(|node| {
                                                                    node.kind
                                                                        != crate::paint::ColorPaintGraphNodeKind::SweepGradientPath
                                                                })
                                                            },
                                                        )
                                                })
                                            {
                                                (true, None)
                                            } else {
                                                (
                                                    false,
                                                    Some(
                                                        VariantRejectReason::UnsupportedColorGlyph,
                                                    ),
                                                )
                                            }
                                        }
                                        GlyphOutlinePayloadKind::BitmapGlyph => {
                                            let has_bitmap_feature =
                                                outline.variant.requires.iter().any(|feature| {
                                                    feature == "text.glyphOutline.bitmapGlyph"
                                                });
                                            let supported = has_bitmap_feature
                                                && glyph_payload_bbox_is_replayable(*bbox)
                                                && outline.bitmap_glyph.as_ref().is_some_and(
                                                    |payload| {
                                                        payload.has_strict_visual_contract()
                                                            && resources
                                                                .image_bytes(
                                                                    payload.image_resource_id,
                                                                )
                                                                .is_some()
                                                    },
                                                );
                                            if supported {
                                                (true, None)
                                            } else {
                                                (
                                                    false,
                                                    Some(
                                                        VariantRejectReason::UnsupportedBitmapGlyph,
                                                    ),
                                                )
                                            }
                                        }
                                        GlyphOutlinePayloadKind::SvgGlyph => {
                                            let has_svg_feature =
                                                outline.variant.requires.iter().any(|feature| {
                                                    feature == "text.glyphOutline.svgGlyph"
                                                });
                                            let supported = has_svg_feature
                                                && glyph_payload_bbox_is_replayable(*bbox)
                                                && outline.svg_glyph.as_ref().is_some_and(
                                                    |payload| {
                                                        payload.has_static_sanitized_contract()
                                                            && resources
                                                                .svg_fragment(
                                                                    payload.vector_resource_id,
                                                                )
                                                                .is_some_and(
                                                                    static_svg_fragment_has_path_layer,
                                                                )
                                                    },
                                                );
                                            if supported {
                                                (true, None)
                                            } else {
                                                (
                                                    false,
                                                    Some(VariantRejectReason::UnsupportedSvgGlyph),
                                                )
                                            }
                                        }
                                    };
                                    if !payload_supported {
                                        (
                                            false,
                                            payload_reason,
                                            false,
                                            outline.paint_style.is_fill_only_glyph_replay(),
                                        )
                                    } else if !outline.paint_style.is_fill_only_glyph_replay() {
                                        (
                                            false,
                                            Some(VariantRejectReason::UnsupportedPaintEffect),
                                            true,
                                            false,
                                        )
                                    } else {
                                        (true, None, true, true)
                                    }
                                };
                            VariantReplayStatus {
                                replayable,
                                reason,
                                details: None,
                                font_verification: None,
                                outline_eligibility: Some(VariantOutlineEligibilityReport {
                                    strict_visual_eligible: true,
                                    payload_supported,
                                    paint_style_supported,
                                    replay_eligible: replayable,
                                    reason,
                                }),
                            }
                        }
                        _ => VariantReplayStatus::rejected(VariantRejectReason::VariantUnsupported),
                    },
                    VariantSelectionContext {
                        backend: VariantSelectionBackend::Svg,
                        render_profile: self.current_render_profile.clone(),
                    },
                );
                self.text_variant_selection_diagnostics
                    .extend(selection.reports);
                for op in ops {
                    if paint_op_replay_plane(op) != replay_plane {
                        continue;
                    }
                    if !should_render_selected_text_variant(op, &selection.selected) {
                        continue;
                    }
                    self.render_layer_op(op, resources);
                }
                for op in &sidecars {
                    if paint_op_replay_plane(op) != replay_plane {
                        continue;
                    }
                    if !should_render_selected_text_variant(op, &selection.selected) {
                        continue;
                    }
                    self.render_layer_op(op, resources);
                }
            }
        }
    }

    fn render_layer_op(&mut self, op: &PaintOp, resources: &ResourceArena) {
        match op {
            PaintOp::PageBackground { bbox, background } => {
                self.render_layer_page_background(*bbox, background, resources);
            }
            PaintOp::TextRun { bbox, run } => {
                self.render_layer_text_run(*bbox, run);
            }
            PaintOp::GlyphRun { .. } => {
                // Optional GlyphRun variants are paired with TextRun fallback
                // in schema v1; SVG keeps the searchable TextRun default.
            }
            PaintOp::GlyphOutline { bbox, outline } => {
                if !self.strict_glyph_outline_replay {
                    return;
                }
                if !outline.has_exclusive_payload_family() {
                    return;
                }
                if outline.payload_kind == GlyphOutlinePayloadKind::BitmapGlyph {
                    self.render_layer_glyph_outline_bitmap(*bbox, outline, resources);
                    return;
                }
                if outline.payload_kind == GlyphOutlinePayloadKind::SvgGlyph {
                    self.render_layer_glyph_outline_svg(*bbox, outline, resources);
                    return;
                }
                let transform = outline.placement.run_to_page;
                let fill = color_to_svg(outline.paint_style.color);
                let stroke_attrs = match (outline.payload_kind, outline.stroke.as_ref()) {
                    (GlyphOutlinePayloadKind::MonochromeFillStroke, Some(stroke))
                        if stroke.is_supported_monochrome_subset() =>
                    {
                        let miter_limit = stroke
                            .miter_limit
                            .map(|limit| format!(" stroke-miterlimit=\"{}\"", limit))
                            .unwrap_or_default();
                        format!(
                            " stroke=\"{}\" stroke-width=\"{}\" stroke-linejoin=\"{}\" stroke-linecap=\"{}\"{}",
                            color_to_svg(stroke.color),
                            stroke.width_px,
                            stroke.join.as_str(),
                            stroke.cap.as_str(),
                            miter_limit
                        )
                    }
                    _ => String::new(),
                };
                self.output.push_str(&format!(
                    "<g transform=\"{}\" data-rhwp-equivalence-group=\"{}\" data-rhwp-variant-id=\"{}\">",
                    svg_affine_matrix_transform(transform),
                    escape_xml(&outline.variant.equivalence_group),
                    escape_xml(&outline.variant.variant_id),
                ));
                if outline.payload_kind == GlyphOutlinePayloadKind::ColorLayers {
                    if let Some(color_layers) = outline.color_layers.as_ref() {
                        if color_layers.color_format.as_str() == "colrV1" {
                            if let Some(graph) = color_layers.paint_graph.as_ref() {
                                self.render_glyph_outline_colrv1_graph(outline, graph);
                                self.output.push_str("</g>\n");
                                return;
                            }
                        }
                        let layers = color_layers
                            .colrv1_stage1_reference_layers()
                            .unwrap_or_else(|| color_layers.layers.clone());
                        let color_format_label = match color_layers.color_format.as_str() {
                            "colrV0" => "COLRv0",
                            "colrV1" => "COLRv1",
                            _ => "color",
                        };
                        for layer in &layers {
                            let (Some(commands), Some(fill), Some(glyph_range), Some(source_range)) = (
                                layer.commands.as_ref(),
                                layer.fill.as_ref(),
                                layer.glyph_range,
                                layer.source_range_utf8,
                            ) else {
                                continue;
                            };
                            let channel = |component: f32| -> u8 {
                                (component.clamp(0.0, 1.0) * 255.0).round() as u8
                            };
                            let alpha = (fill.rgba[3] * layer.opacity.unwrap_or(1.0) as f32)
                                .clamp(0.0, 1.0);
                            let fill_opacity = if alpha < 1.0 {
                                format!(" fill-opacity=\"{}\"", alpha)
                            } else {
                                String::new()
                            };
                            let fill_color = format!(
                                "#{:02x}{:02x}{:02x}",
                                channel(fill.rgba[0]),
                                channel(fill.rgba[1]),
                                channel(fill.rgba[2])
                            );
                            let palette_attr = layer
                                .palette_index
                                .map(|index| format!(" data-rhwp-palette-index=\"{}\"", index))
                                .unwrap_or_default();
                            let source_face_attr = layer
                                .source_font_ref
                                .as_ref()
                                .and_then(|font_ref| font_ref.face_key.as_ref())
                                .map(|face_key| {
                                    format!(
                                        " data-rhwp-source-font-face-key=\"{}\"",
                                        escape_xml(face_key)
                                    )
                                })
                                .unwrap_or_default();
                            let layer_transform_attr = layer
                                .transform_to_run
                                .map(|transform| {
                                    format!(
                                        " transform=\"{}\"",
                                        svg_affine_matrix_transform(transform)
                                    )
                                })
                                .unwrap_or_default();
                            self.output.push_str(&format!(
                                "<path d=\"{}\" fill=\"{}\"{} fill-rule=\"{}\"{} data-rhwp-color-format=\"{}\" data-rhwp-color-layer-index=\"{}\" data-rhwp-glyph-id=\"{}\" data-rhwp-glyph-start=\"{}\" data-rhwp-glyph-end=\"{}\" data-rhwp-source-id=\"{}\" data-rhwp-source-utf8-start=\"{}\" data-rhwp-source-utf8-end=\"{}\"{}{} data-rhwp-equivalence-group=\"{}\" data-rhwp-variant-id=\"{}\"><desc>source-backed {} glyph color layer</desc></path>\n",
                                svg_path_data(commands).trim(),
                                fill_color,
                                fill_opacity,
                                layer
                                    .fill_rule
                                    .unwrap_or(GlyphOutlineFillRule::NonZero)
                                    .as_str(),
                                layer_transform_attr,
                                color_layers.color_format.as_str(),
                                layer.layer_index.unwrap_or(0),
                                layer.glyph_id.unwrap_or(0),
                                glyph_range.start,
                                glyph_range.end,
                                outline.source.id.0,
                                source_range.start,
                                source_range.end,
                                palette_attr,
                                source_face_attr,
                                escape_xml(&outline.variant.equivalence_group),
                                escape_xml(&outline.variant.variant_id),
                                color_format_label,
                            ));
                        }
                    }
                    self.output.push_str("</g>\n");
                    return;
                }
                for path in &outline.paths {
                    self.output.push_str(&format!(
                        "<path d=\"{}\" fill=\"{}\"{} fill-rule=\"{}\" data-rhwp-glyph-id=\"{}\" data-rhwp-glyph-start=\"{}\" data-rhwp-glyph-end=\"{}\" data-rhwp-source-id=\"{}\" data-rhwp-source-utf8-start=\"{}\" data-rhwp-source-utf8-end=\"{}\" data-rhwp-equivalence-group=\"{}\" data-rhwp-variant-id=\"{}\"><desc>source-backed glyph outline</desc></path>\n",
                        svg_path_data(&path.commands).trim(),
                        fill,
                        stroke_attrs,
                        path.fill_rule.as_str(),
                        path.glyph_id,
                        path.glyph_range.start,
                        path.glyph_range.end,
                        outline.source.id.0,
                        path.source_range_utf8.start,
                        path.source_range_utf8.end,
                        escape_xml(&outline.variant.equivalence_group),
                        escape_xml(&outline.variant.variant_id),
                    ));
                }
                self.output.push_str("</g>\n");
            }
            PaintOp::CharOverlap { bbox, overlap } => {
                self.render_layer_char_overlap(*bbox, overlap);
            }
            PaintOp::TextControlMark { bbox, mark } => {
                self.render_layer_text_control_mark(*bbox, &mark.mark, 0.0);
            }
            PaintOp::TabLeader { bbox, leader } => {
                self.render_layer_tab_leader(
                    bbox.x,
                    bbox.y + leader.baseline,
                    leader.font_size,
                    leader.color,
                    &leader.leader,
                );
            }
            PaintOp::TextDecoration { bbox, decoration } => {
                self.render_layer_text_decoration(*bbox, decoration);
            }
            PaintOp::FootnoteMarker { bbox, marker } => {
                let sup_size = (marker.base_font_size * 0.55).max(7.0);
                let color = color_to_svg(marker.color);
                let font_family = Self::font_family_with_svg_fallbacks(&marker.font_family);
                let y = bbox.y + bbox.height * 0.4;
                self.output.push_str(&format!(
                    "<text x=\"{}\" y=\"{}\" font-family=\"{}\" font-size=\"{}\" fill=\"{}\">{}</text>\n",
                    bbox.x,
                    y,
                    escape_xml(&font_family),
                    sup_size,
                    color,
                    escape_xml(&marker.text),
                ));
            }
            PaintOp::Line { bbox, line } => {
                self.open_shape_transform(&line.transform, bbox);
                self.draw_line(line.x1, line.y1, line.x2, line.y2, &line.style);
                self.close_layer_op_transform(op);
            }
            PaintOp::Rectangle { bbox, rect } => {
                self.open_shape_transform(&rect.transform, bbox);
                self.draw_rect_with_gradient(
                    bbox.x,
                    bbox.y,
                    bbox.width,
                    bbox.height,
                    rect.corner_radius,
                    &rect.style,
                    rect.gradient.as_deref(),
                );
                self.close_layer_op_transform(op);
            }
            PaintOp::Ellipse { bbox, ellipse } => {
                self.open_shape_transform(&ellipse.transform, bbox);
                let cx = bbox.x + bbox.width / 2.0;
                let cy = bbox.y + bbox.height / 2.0;
                self.draw_ellipse_with_gradient(
                    cx,
                    cy,
                    bbox.width / 2.0,
                    bbox.height / 2.0,
                    &ellipse.style,
                    ellipse.gradient.as_deref(),
                );
                self.close_layer_op_transform(op);
            }
            PaintOp::Path { bbox, path } => {
                self.open_shape_transform(&path.transform, bbox);
                self.draw_path_with_gradient(&path.commands, &path.style, path.gradient.as_deref());
                if let (Some(line_style), Some((x1, y1, x2, y2))) =
                    (&path.line_style, path.connector_endpoints)
                {
                    let color = color_to_svg(line_style.color);
                    let width = if line_style.width > 0.0 {
                        line_style.width
                    } else {
                        1.0
                    };
                    let line_len = ((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1))
                        .sqrt()
                        .max(1.0);
                    let mut marker_start_attr = String::new();
                    let mut marker_end_attr = String::new();
                    if line_style.start_arrow != super::ArrowStyle::None {
                        let marker_id = self.ensure_arrow_marker(
                            &color,
                            width,
                            line_len,
                            &line_style.start_arrow,
                            line_style.start_arrow_size,
                            true,
                        );
                        marker_start_attr = format!(" marker-start=\"url(#{})\"", marker_id);
                    }
                    if line_style.end_arrow != super::ArrowStyle::None {
                        let marker_id = self.ensure_arrow_marker(
                            &color,
                            width,
                            line_len,
                            &line_style.end_arrow,
                            line_style.end_arrow_size,
                            false,
                        );
                        marker_end_attr = format!(" marker-end=\"url(#{})\"", marker_id);
                    }
                    if !marker_start_attr.is_empty() || !marker_end_attr.is_empty() {
                        self.output.push_str(&format!(
                            "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-opacity=\"0\" stroke-width=\"{}\"{}{} pointer-events=\"none\"/>\n",
                            x1, y1, x2, y2, color, width, marker_start_attr, marker_end_attr
                        ));
                    }
                }
                self.close_layer_op_transform(op);
            }
            PaintOp::Image { bbox, image } => {
                self.render_layer_image(*bbox, image, resources);
                if self.show_control_codes {
                    self.emit_control_code_marker("[그림]", *bbox);
                }
            }
            PaintOp::Equation { bbox, equation } => {
                self.render_layer_equation(*bbox, equation, resources);
                if self.show_control_codes {
                    self.emit_control_code_marker("[수식]", *bbox);
                }
            }
            PaintOp::FormObject { bbox, form } => {
                self.render_layer_form_object(form, bbox);
            }
        }
    }

    fn enter_layer_group(&mut self, bounds: BoundingBox, semantic: &LayerSemantic) {
        if self.debug_overlay {
            match semantic.role {
                LayerSemanticRole::TextLine => {
                    if self.overlay_skip_depth == 0 {
                        if let (Some(pi), Some(si)) = (semantic.para_index, semantic.section_index)
                        {
                            if self.overlay_page_section == -1 {
                                self.overlay_page_section = si as i32;
                            }
                            if si as i32 == self.overlay_page_section {
                                let key = si * 100000 + pi;
                                let entry =
                                    self.overlay_para_bounds
                                        .entry(key)
                                        .or_insert(OverlayBounds {
                                            section_index: si,
                                            x: bounds.x,
                                            y: bounds.y,
                                            width: bounds.width,
                                            height: bounds.height,
                                        });
                                let min_x = entry.x.min(bounds.x);
                                let min_y = entry.y.min(bounds.y);
                                let max_x = (entry.x + entry.width).max(bounds.x + bounds.width);
                                let max_y = (entry.y + entry.height).max(bounds.y + bounds.height);
                                entry.x = min_x;
                                entry.y = min_y;
                                entry.width = max_x - min_x;
                                entry.height = max_y - min_y;
                            }
                        }
                    }
                }
                LayerSemanticRole::Table => {
                    if let (Some(pi), Some(ci)) = (semantic.para_index, semantic.control_index) {
                        if self.overlay_skip_depth == 0 {
                            let table_section = semantic.section_index.unwrap_or(0);
                            if self.overlay_page_section == -1 {
                                self.overlay_page_section = table_section as i32;
                            }
                            if table_section as i32 == self.overlay_page_section {
                                self.overlay_table_bounds.push(OverlayTableInfo {
                                    section_index: table_section,
                                    para_index: pi,
                                    control_index: ci,
                                    x: bounds.x,
                                    y: bounds.y,
                                    width: bounds.width,
                                    height: bounds.height,
                                    row_count: semantic.row_count.unwrap_or(0),
                                    col_count: semantic.col_count.unwrap_or(0),
                                });
                                let key = table_section * 100000 + pi;
                                let entry =
                                    self.overlay_para_bounds
                                        .entry(key)
                                        .or_insert(OverlayBounds {
                                            section_index: table_section,
                                            x: bounds.x,
                                            y: bounds.y,
                                            width: bounds.width,
                                            height: bounds.height,
                                        });
                                let min_x = entry.x.min(bounds.x);
                                let min_y = entry.y.min(bounds.y);
                                let max_x = (entry.x + entry.width).max(bounds.x + bounds.width);
                                let max_y = (entry.y + entry.height).max(bounds.y + bounds.height);
                                entry.x = min_x;
                                entry.y = min_y;
                                entry.width = max_x - min_x;
                                entry.height = max_y - min_y;
                            }
                        }
                    }
                    self.overlay_skip_depth += 1;
                }
                LayerSemanticRole::Header
                | LayerSemanticRole::Footer
                | LayerSemanticRole::MasterPage
                | LayerSemanticRole::FootnoteArea
                | LayerSemanticRole::TextBox
                | LayerSemanticRole::Group => {
                    self.overlay_skip_depth += 1;
                }
                _ => {}
            }
        }
    }

    fn leave_layer_group(&mut self, bounds: BoundingBox, semantic: &LayerSemantic) {
        if self.debug_overlay {
            match semantic.role {
                LayerSemanticRole::Table
                | LayerSemanticRole::Header
                | LayerSemanticRole::Footer
                | LayerSemanticRole::MasterPage
                | LayerSemanticRole::FootnoteArea
                | LayerSemanticRole::TextBox
                | LayerSemanticRole::Group => {
                    self.overlay_skip_depth = self.overlay_skip_depth.saturating_sub(1);
                }
                _ => {}
            }
        }

        if !self.show_control_codes {
            return;
        }

        let label = match semantic.role {
            LayerSemanticRole::Table => Some("[표]"),
            LayerSemanticRole::TextBox => Some("[글상자]"),
            LayerSemanticRole::Header => Some("[머리말]"),
            LayerSemanticRole::Footer => Some("[꼬리말]"),
            LayerSemanticRole::FootnoteArea => Some("[각주]"),
            _ => None,
        };
        if let Some(label) = label {
            self.emit_control_code_marker(label, bounds);
        }
    }

    fn draw_text_with_positions(
        &mut self,
        text: &str,
        x: f64,
        y: f64,
        style: &TextStyle,
        positions: Option<&[f64]>,
    ) {
        let mapped_text = crate::renderer::composer::expand_pua_display_text(text);
        let text_was_remapped = mapped_text != text;
        let text = if text_was_remapped {
            mapped_text.as_str()
        } else {
            text
        };
        let color = color_to_svg(style.color);
        let font_size = if style.font_size > 0.0 {
            style.font_size
        } else {
            12.0
        };
        let font_family = Self::font_family_with_svg_fallbacks(&style.font_family);

        let ratio = if style.ratio > 0.0 { style.ratio } else { 1.0 };
        let has_ratio = (ratio - 1.0).abs() > 0.01;

        let mut base_attrs = format!(
            "font-family=\"{}\" font-size=\"{}\"",
            escape_xml(&font_family),
            font_size,
        );
        if style.is_visually_bold() {
            base_attrs.push_str(" font-weight=\"bold\"");
        }
        if style.italic {
            base_attrs.push_str(" font-style=\"italic\"");
        }

        let owned_positions;
        let char_positions = if !text_was_remapped {
            if let Some(positions) = positions {
                positions
            } else {
                owned_positions = compute_char_positions(text, style);
                &owned_positions
            }
        } else if text.is_empty() {
            owned_positions = Vec::new();
            &owned_positions
        } else {
            owned_positions = compute_char_positions(text, style);
            &owned_positions
        };
        let clusters = split_into_clusters(text);

        if style.shadow_type > 0 {
            let shadow_color = color_to_svg(style.shadow_color);
            let shadow_attrs = format!("{} fill=\"{}\"", base_attrs, shadow_color);
            let dx = style.shadow_offset_x;
            let dy = style.shadow_offset_y;
            for (char_idx, cluster_str) in &clusters {
                if cluster_str == " " || cluster_str == "\t" {
                    continue;
                }
                let char_x = x + char_positions[*char_idx] + dx;
                let char_y = y + dy;
                if has_ratio {
                    self.output.push_str(&format!(
                        "<text transform=\"translate({},{}) scale({:.4},1)\" {}>{}</text>\n",
                        char_x,
                        char_y,
                        ratio,
                        shadow_attrs,
                        escape_xml(cluster_str),
                    ));
                } else {
                    self.output.push_str(&format!(
                        "<text x=\"{}\" y=\"{}\" {}>{}</text>\n",
                        char_x,
                        char_y,
                        shadow_attrs,
                        escape_xml(cluster_str),
                    ));
                }
            }
        }

        let common_attrs = format!("{} fill=\"{}\"", base_attrs, color);
        for (char_idx, cluster_str) in &clusters {
            if cluster_str == " " || cluster_str == "\t" {
                continue;
            }
            let char_x = x + char_positions[*char_idx];

            if has_ratio {
                self.output.push_str(&format!(
                    "<text transform=\"translate({},{}) scale({:.4},1)\" {}>{}</text>\n",
                    char_x,
                    y,
                    ratio,
                    common_attrs,
                    escape_xml(cluster_str),
                ));
            } else {
                self.output.push_str(&format!(
                    "<text x=\"{}\" y=\"{}\" {}>{}</text>\n",
                    char_x,
                    y,
                    common_attrs,
                    escape_xml(cluster_str),
                ));
            }
        }

        if !matches!(style.underline, UnderlineType::None) {
            let text_width = *char_positions.last().unwrap_or(&0.0);
            let underline_color = if style.underline_color != 0 {
                color_to_svg(style.underline_color)
            } else {
                color.to_string()
            };
            let underline_y = match style.underline {
                UnderlineType::Top => y - font_size + 1.0,
                _ => y + 2.0,
            };
            self.draw_line_shape(
                x,
                underline_y,
                x + text_width,
                underline_y,
                &underline_color,
                style.underline_shape,
            );
        }
        if style.strikethrough {
            let text_width = *char_positions.last().unwrap_or(&0.0);
            let strike_y = y - font_size * 0.3;
            let strike_color = if style.strike_color != 0 {
                color_to_svg(style.strike_color)
            } else {
                color.to_string()
            };
            self.draw_line_shape(
                x,
                strike_y,
                x + text_width,
                strike_y,
                &strike_color,
                style.strike_shape,
            );
        }

        if style.emphasis_dot > 0 {
            let dot_char = match style.emphasis_dot {
                1 => "●",
                2 => "○",
                3 => "ˇ",
                4 => "˜",
                5 => "･",
                6 => "˸",
                _ => "",
            };
            if !dot_char.is_empty() {
                let dot_size = font_size * 0.3;
                let dot_y = y - font_size * 1.05;
                for &cx in &char_positions[..char_positions.len().saturating_sub(1)] {
                    let dot_x = x + cx + (font_size * style.ratio * 0.5);
                    self.output.push_str(&format!(
                        "<text x=\"{}\" y=\"{}\" font-size=\"{}\" text-anchor=\"middle\" fill=\"{}\">{}</text>\n",
                        dot_x, dot_y, dot_size, color, dot_char,
                    ));
                }
            }
        }

        for leader in &style.tab_leaders {
            if leader.fill_type == 0 {
                continue;
            }
            let lx1 = x + leader.start_x;
            let lx2 = x + leader.end_x;
            let ly = y - font_size * 0.35;
            match leader.fill_type {
                1 => {
                    self.output.push_str(&format!(
                        "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.5\"/>\n",
                        lx1, ly, lx2, ly, color,
                    ));
                }
                2 => {
                    self.output.push_str(&format!(
                        "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.5\" stroke-dasharray=\"3 3\"/>\n",
                        lx1, ly, lx2, ly, color,
                    ));
                }
                3 => {
                    self.output.push_str(&format!(
                        "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.5\" stroke-dasharray=\"1 2\"/>\n",
                        lx1, ly, lx2, ly, color,
                    ));
                }
                4 => {
                    self.output.push_str(&format!(
                        "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.5\" stroke-dasharray=\"6 2 1 2\"/>\n",
                        lx1, ly, lx2, ly, color,
                    ));
                }
                5 => {
                    self.output.push_str(&format!(
                        "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.5\" stroke-dasharray=\"6 2 1 2 1 2\"/>\n",
                        lx1, ly, lx2, ly, color,
                    ));
                }
                6 => {
                    self.output.push_str(&format!(
                        "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.5\" stroke-dasharray=\"8 4\"/>\n",
                        lx1, ly, lx2, ly, color,
                    ));
                }
                7 => {
                    self.output.push_str(&format!(
                        "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.7\" stroke-dasharray=\"0.1 2.5\" stroke-linecap=\"round\"/>\n",
                        lx1, ly, lx2, ly, color,
                    ));
                }
                8 => {
                    self.output.push_str(&format!(
                        "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.3\"/>\n\
                         <line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.3\"/>\n",
                        lx1, ly - 1.0, lx2, ly - 1.0, color,
                        lx1, ly + 1.0, lx2, ly + 1.0, color,
                    ));
                }
                9 => {
                    self.output.push_str(&format!(
                        "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.3\"/>\n\
                         <line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.8\"/>\n",
                        lx1, ly - 1.2, lx2, ly - 1.2, color,
                        lx1, ly + 0.8, lx2, ly + 0.8, color,
                    ));
                }
                10 => {
                    self.output.push_str(&format!(
                        "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.8\"/>\n\
                         <line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.3\"/>\n",
                        lx1, ly - 0.8, lx2, ly - 0.8, color,
                        lx1, ly + 1.2, lx2, ly + 1.2, color,
                    ));
                }
                11 => {
                    self.output.push_str(&format!(
                        "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.3\"/>\n\
                         <line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.8\"/>\n\
                         <line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.3\"/>\n",
                        lx1, ly - 2.0, lx2, ly - 2.0, color,
                        lx1, ly, lx2, ly, color,
                        lx1, ly + 2.0, lx2, ly + 2.0, color,
                    ));
                }
                _ => {
                    self.output.push_str(&format!(
                        "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.5\" stroke-dasharray=\"1 2\"/>\n",
                        lx1, ly, lx2, ly, color,
                    ));
                }
            }
        }
    }

    fn emit_control_code_marker(&mut self, label: &str, bbox: BoundingBox) {
        let fs = 10.0;
        self.output.push_str(&format!(
            "<text x=\"{}\" y=\"{}\" font-size=\"{}\" fill=\"#CC3333\">{}</text>\n",
            bbox.x,
            bbox.y + fs,
            fs,
            label,
        ));
    }

    fn close_layer_op_transform(&mut self, op: &PaintOp) {
        match op {
            PaintOp::Rectangle { rect, .. } if rect.transform.has_transform() => {
                self.output.push_str("</g>\n");
            }
            PaintOp::Line { line, .. } if line.transform.has_transform() => {
                self.output.push_str("</g>\n");
            }
            PaintOp::Ellipse { ellipse, .. } if ellipse.transform.has_transform() => {
                self.output.push_str("</g>\n");
            }
            PaintOp::Image { image, .. } if image.transform.has_transform() => {
                self.output.push_str("</g>\n");
            }
            PaintOp::Path { path, .. } if path.transform.has_transform() => {
                self.output.push_str("</g>\n");
            }
            _ => {}
        }
    }

    /// 개별 노드를 SVG로 렌더링
    fn render_node(&mut self, node: &RenderNode) {
        if !node.visible {
            return;
        }

        match &node.node_type {
            RenderNodeType::Page(page) => {
                self.begin_page(page.width, page.height);
            }
            RenderNodeType::PageBackground(bg) => {
                // 배경색 먼저 (이미지가 투명 부분을 가질 수 있으므로)
                if let Some(color) = bg.background_color {
                    let color_str = color_to_svg(color);
                    self.output.push_str(&format!(
                        "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" fill=\"{}\"/>\n",
                        node.bbox.x, node.bbox.y, node.bbox.width, node.bbox.height, color_str,
                    ));
                }
                // 그라데이션 (배경색 위에 덮음)
                if let Some(grad) = &bg.gradient {
                    let grad_id = self.create_gradient_def(grad);
                    self.output.push_str(&format!(
                        "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" fill=\"url(#{})\"/>\n",
                        node.bbox.x, node.bbox.y, node.bbox.width, node.bbox.height, grad_id,
                    ));
                }
                // 이미지 (최상위)
                if let Some(img) = &bg.image {
                    let mut temp = ImageNode::new(0, Some(img.data.clone()));
                    temp.fill_mode = Some(img.fill_mode);
                    temp.effect = img.effect;
                    temp.brightness = img.brightness;
                    temp.contrast = img.contrast;
                    self.render_image_node(&temp, &node.bbox);
                }
            }
            RenderNodeType::TextRun(run) => {
                // 폰트 임베딩: 사용된 폰트/글자 수집
                if self.font_embed_mode != FontEmbedMode::None && !run.style.font_family.is_empty()
                {
                    let codepoints = self
                        .font_codepoints
                        .entry(run.style.font_family.clone())
                        .or_default();
                    for ch in run.text.chars() {
                        if !ch.is_control() {
                            codepoints.insert(ch);
                        }
                    }
                }
                let effective_rotation = run.rotation;
                if effective_rotation != 0.0 {
                    let cx = node.bbox.x + node.bbox.width / 2.0;
                    let cy = node.bbox.y + node.bbox.height / 2.0;
                    self.output.push_str(&format!(
                        "<g transform=\"rotate({},{},{})\">\n",
                        effective_rotation, cx, cy
                    ));
                }
                if let Some(ref overlap) = run.char_overlap {
                    // 글자겹침(CharOverlap) 렌더링: 각 문자에 테두리 도형 + 텍스트
                    self.draw_char_overlap(
                        &run.text,
                        &run.style,
                        overlap,
                        node.bbox.x,
                        node.bbox.y,
                        node.bbox.width,
                        node.bbox.height,
                    );
                } else {
                    self.draw_text(
                        &run.text,
                        node.bbox.x,
                        node.bbox.y + run.baseline,
                        &run.style,
                    );
                }
                if self.show_paragraph_marks || self.show_control_codes {
                    // 조판부호 마커 TextRun은 공백 기호 표시 건너뛰기
                    let is_marker = !matches!(
                        run.field_marker,
                        crate::renderer::render_tree::FieldMarkerType::None
                    );
                    let font_size = if run.style.font_size > 0.0 {
                        run.style.font_size
                    } else {
                        12.0
                    };
                    // 공백·탭 기호: 각 문자 위치에 오버레이
                    if !run.text.is_empty() && !is_marker {
                        let char_positions = compute_char_positions(&run.text, &run.style);
                        let mark_font_size = font_size * 0.5;
                        for (i, c) in run.text.chars().enumerate() {
                            if c == ' ' {
                                let cx = node.bbox.x + char_positions[i];
                                // ∨ 기호를 공백 영역 중앙 하단에 배치
                                let next_x = if i + 1 < char_positions.len() {
                                    node.bbox.x + char_positions[i + 1]
                                } else {
                                    node.bbox.x + node.bbox.width
                                };
                                let mid_x = (cx + next_x) / 2.0 - mark_font_size * 0.25;
                                self.output.push_str(&format!(
                                    "<text x=\"{}\" y=\"{}\" font-size=\"{}\" fill=\"#4A90D9\">\u{2228}</text>\n",
                                    mid_x, node.bbox.y + run.baseline, mark_font_size,
                                ));
                            } else if c == '\t' {
                                let cx = node.bbox.x + char_positions[i];
                                self.output.push_str(&format!(
                                    "<text x=\"{}\" y=\"{}\" font-size=\"{}\" fill=\"#4A90D9\">\u{2192}</text>\n",
                                    cx, node.bbox.y + run.baseline, mark_font_size,
                                ));
                            }
                        }
                    }
                    // 하드 리턴·강제 줄바꿈 기호
                    if run.is_para_end || run.is_line_break_end {
                        let mark_x = if run.text.is_empty() {
                            node.bbox.x
                        } else {
                            node.bbox.x + node.bbox.width
                        };
                        let mark = if run.is_line_break_end {
                            "\u{2193}"
                        } else {
                            "\u{21B5}"
                        };
                        self.output.push_str(&format!(
                            "<text x=\"{}\" y=\"{}\" font-size=\"{}\" fill=\"#4A90D9\">{}</text>\n",
                            mark_x,
                            node.bbox.y + run.baseline,
                            font_size,
                            mark,
                        ));
                    }
                }
                if effective_rotation != 0.0 {
                    self.output.push_str("</g>\n");
                }
            }
            RenderNodeType::FootnoteMarker(marker) => {
                let sup_size = (marker.base_font_size * 0.55).max(7.0);
                let color = color_to_svg(marker.color);
                let font_family = Self::font_family_with_svg_fallbacks(&marker.font_family);
                let y = node.bbox.y + node.bbox.height * 0.4;
                self.output.push_str(&format!(
                    "<text x=\"{}\" y=\"{}\" font-family=\"{}\" font-size=\"{}\" fill=\"{}\">{}</text>\n",
                    node.bbox.x, y, escape_xml(&font_family), sup_size, color, escape_xml(&marker.text),
                ));
            }
            RenderNodeType::Rectangle(rect) => {
                self.open_shape_transform(&rect.transform, &node.bbox);
                self.draw_rect_with_gradient(
                    node.bbox.x,
                    node.bbox.y,
                    node.bbox.width,
                    node.bbox.height,
                    rect.corner_radius,
                    &rect.style,
                    rect.gradient.as_deref(),
                );
            }
            RenderNodeType::Line(line) => {
                self.open_shape_transform(&line.transform, &node.bbox);
                self.draw_line(line.x1, line.y1, line.x2, line.y2, &line.style);
            }
            RenderNodeType::Ellipse(ellipse) => {
                self.open_shape_transform(&ellipse.transform, &node.bbox);
                let cx = node.bbox.x + node.bbox.width / 2.0;
                let cy = node.bbox.y + node.bbox.height / 2.0;
                self.draw_ellipse_with_gradient(
                    cx,
                    cy,
                    node.bbox.width / 2.0,
                    node.bbox.height / 2.0,
                    &ellipse.style,
                    ellipse.gradient.as_deref(),
                );
            }
            RenderNodeType::Image(img) => {
                let effective_bbox = img.transform.effective_image_bbox(&node.bbox);
                self.open_shape_transform(&img.transform, &effective_bbox);
                self.render_image_node(img, &effective_bbox);
            }
            RenderNodeType::Path(path) => {
                self.open_shape_transform(&path.transform, &node.bbox);
                self.draw_path_with_gradient(&path.commands, &path.style, path.gradient.as_deref());
            }
            RenderNodeType::Equation(eq) => {
                // 수식 SVG 조각을 bbox 위치에 배치
                self.output.push_str(&format!(
                    "<g transform=\"translate({},{})\">\n",
                    node.bbox.x, node.bbox.y,
                ));
                self.output.push_str(&eq.svg_content);
                self.output.push_str("</g>\n");
                // 폰트 임베딩: 수식에서 사용된 글자 수집
                if self.font_embed_mode != FontEmbedMode::None {
                    let codepoints = self
                        .font_codepoints
                        .entry("Latin Modern Math".to_string())
                        .or_default();
                    // SVG <text> 요소 내부의 텍스트에서 문자 추출
                    for segment in eq.svg_content.split("</text>") {
                        if let Some(start) = segment.rfind('>') {
                            for ch in segment[start + 1..].chars() {
                                codepoints.insert(ch);
                            }
                        }
                    }
                }
            }
            RenderNodeType::FormObject(form) => {
                self.render_form_object(form, &node.bbox);
            }
            RenderNodeType::Body {
                clip_rect: Some(cr),
            } => {
                let clip_id = format!("body-clip-{}", node.id);
                self.defs.push(format!(
                    "<clipPath id=\"{}\"><rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\"/></clipPath>\n",
                    clip_id, cr.x, cr.y, cr.width, cr.height,
                ));
                self.output
                    .push_str(&format!("<g clip-path=\"url(#{})\">", clip_id));
            }
            RenderNodeType::TableCell(ref tc) if tc.clip => {
                let clip_id = format!("cell-clip-{}", node.id);
                self.defs.push(format!(
                    "<clipPath id=\"{}\"><rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\"/></clipPath>\n",
                    clip_id, node.bbox.x, node.bbox.y, node.bbox.width, node.bbox.height,
                ));
                self.output
                    .push_str(&format!("<g clip-path=\"url(#{})\">", clip_id));
            }
            _ => {}
        }

        // 디버그 오버레이: 문단/표 경계 수집 (셀 내부·머리말·꼬리말 제외)
        if self.debug_overlay {
            match &node.node_type {
                RenderNodeType::TextLine(tl) => {
                    if self.overlay_skip_depth == 0 {
                        // section_index가 없는 TextLine은 Shape 내부 등 비본문 요소 — 제외
                        if let (Some(pi), Some(si)) = (tl.para_index, tl.section_index) {
                            // 페이지 메인 섹션 자동 감지 (처음 등장하는 섹션이 메인)
                            if self.overlay_page_section == -1 {
                                self.overlay_page_section = si as i32;
                            }
                            // 페이지 메인 섹션이 아닌 섹션 문단은 오버레이에서 제외
                            // (구역 정의 섹션, 다른 섹션 나누기 문단 등)
                            if si as i32 != self.overlay_page_section {
                                // skip
                            } else {
                                // (section, para) 복합키로 섹션 간 구분
                                let key = si * 100000 + pi;
                                let entry =
                                    self.overlay_para_bounds
                                        .entry(key)
                                        .or_insert(OverlayBounds {
                                            section_index: si,
                                            x: node.bbox.x,
                                            y: node.bbox.y,
                                            width: node.bbox.width,
                                            height: node.bbox.height,
                                        });
                                // 기존 bounds 확장 (여러 줄이 하나의 문단)
                                let min_x = entry.x.min(node.bbox.x);
                                let min_y = entry.y.min(node.bbox.y);
                                let max_x =
                                    (entry.x + entry.width).max(node.bbox.x + node.bbox.width);
                                let max_y =
                                    (entry.y + entry.height).max(node.bbox.y + node.bbox.height);
                                entry.x = min_x;
                                entry.y = min_y;
                                entry.width = max_x - min_x;
                                entry.height = max_y - min_y;
                            }
                        }
                    }
                }
                RenderNodeType::Table(tbl) => {
                    if let (Some(pi), Some(ci)) = (tbl.para_index, tbl.control_index) {
                        if self.overlay_skip_depth == 0 {
                            let tbl_si = tbl.section_index.unwrap_or(0);
                            // 페이지 메인 섹션 자동 감지
                            if self.overlay_page_section == -1 {
                                self.overlay_page_section = tbl_si as i32;
                            }
                            if tbl_si as i32 == self.overlay_page_section {
                                self.overlay_table_bounds.push(OverlayTableInfo {
                                    section_index: tbl_si,
                                    para_index: pi,
                                    control_index: ci,
                                    x: node.bbox.x,
                                    y: node.bbox.y,
                                    width: node.bbox.width,
                                    height: node.bbox.height,
                                    row_count: tbl.row_count,
                                    col_count: tbl.col_count,
                                });
                                // 표를 포함하는 문단 bounds도 확장 (텍스트 없는 문단 처리)
                                let key = tbl_si * 100000 + pi;
                                let entry =
                                    self.overlay_para_bounds
                                        .entry(key)
                                        .or_insert(OverlayBounds {
                                            section_index: tbl_si,
                                            x: node.bbox.x,
                                            y: node.bbox.y,
                                            width: node.bbox.width,
                                            height: node.bbox.height,
                                        });
                                let min_x = entry.x.min(node.bbox.x);
                                let min_y = entry.y.min(node.bbox.y);
                                let max_x =
                                    (entry.x + entry.width).max(node.bbox.x + node.bbox.width);
                                let max_y =
                                    (entry.y + entry.height).max(node.bbox.y + node.bbox.height);
                                entry.x = min_x;
                                entry.y = min_y;
                                entry.width = max_x - min_x;
                                entry.height = max_y - min_y;
                            }
                        }
                    }
                    self.overlay_skip_depth += 1;
                }
                // 머리말/꼬리말/바탕쪽/각주/텍스트박스/그룹: body 외 영역 제외
                RenderNodeType::Header
                | RenderNodeType::Footer
                | RenderNodeType::MasterPage
                | RenderNodeType::FootnoteArea
                | RenderNodeType::TextBox
                | RenderNodeType::Group(_) => {
                    self.overlay_skip_depth += 1;
                }
                _ => {}
            }
        }

        if Self::children_need_replay_plane_reorder(node) {
            let mut ordered: Vec<&RenderNode> = node.children.iter().collect();
            ordered.sort_by_key(|child| Self::render_node_replay_plane(child) as u8);
            for child in ordered {
                self.render_node(child);
            }
        } else {
            for child in &node.children {
                self.render_node(child);
            }
        }

        // 디버그 오버레이: skip 깊이 복원
        if self.debug_overlay {
            match &node.node_type {
                RenderNodeType::Table(_)
                | RenderNodeType::Header
                | RenderNodeType::Footer
                | RenderNodeType::MasterPage
                | RenderNodeType::FootnoteArea
                | RenderNodeType::TextBox
                | RenderNodeType::Group(_) => {
                    self.overlay_skip_depth = self.overlay_skip_depth.saturating_sub(1);
                }
                _ => {}
            }
        }

        // 도형 변환 그룹 종료
        self.close_shape_transform(&node.node_type);

        // 조판부호 개체 마커 (붉은색 대괄호) — 조판부호 ON일 때만
        if self.show_control_codes {
            let label = match &node.node_type {
                RenderNodeType::Table(_) => Some("[표]"),
                RenderNodeType::Image(_) => Some("[그림]"),
                RenderNodeType::TextBox => Some("[글상자]"),
                RenderNodeType::Equation(_) => Some("[수식]"),
                RenderNodeType::Header => Some("[머리말]"),
                RenderNodeType::Footer => Some("[꼬리말]"),
                RenderNodeType::FootnoteArea => Some("[각주]"),
                _ => None,
            };
            if let Some(label) = label {
                let fs = 10.0; // 조판부호 고정 크기
                self.output.push_str(&format!(
                    "<text x=\"{}\" y=\"{}\" font-size=\"{}\" fill=\"#CC3333\">{}</text>\n",
                    node.bbox.x,
                    node.bbox.y + fs,
                    fs,
                    label,
                ));
            }
        }

        // 셀 클리핑 그룹 종료
        if matches!(&node.node_type, RenderNodeType::TableCell(tc) if tc.clip) {
            self.output.push_str("</g>\n");
        }

        // Body 클리핑 그룹 종료
        if matches!(node.node_type, RenderNodeType::Body { clip_rect: Some(_) }) {
            self.output.push_str("</g>\n");
        }

        // 페이지 종료 태그
        if matches!(node.node_type, RenderNodeType::Page(_)) {
            self.end_page();
        }
    }

    fn render_layer_page_background(
        &mut self,
        bbox: BoundingBox,
        background: &LayerPageBackgroundPaint,
        resources: &ResourceArena,
    ) {
        if let Some(color) = background.background_color {
            let color_str = color_to_svg(color);
            self.output.push_str(&format!(
                "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" fill=\"{}\"/>\n",
                bbox.x, bbox.y, bbox.width, bbox.height, color_str,
            ));
        }
        if let Some(grad) = &background.gradient {
            let grad_id = self.create_gradient_def(grad);
            self.output.push_str(&format!(
                "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" fill=\"url(#{})\"/>\n",
                bbox.x, bbox.y, bbox.width, bbox.height, grad_id,
            ));
        }
        if let Some(image) = &background.image {
            if let Some(bytes) = resources.image_bytes(image.resource_id) {
                let data_uri = svg_image_data_uri(bytes);
                let tone_filter_id =
                    self.ensure_brightness_contrast_filter(image.brightness, image.contrast);
                let effect_filter_id = self.ensure_image_effect_filter(image.effect);
                if let Some(ref fid) = tone_filter_id {
                    self.output
                        .push_str(&format!("<g filter=\"url(#{})\">\n", fid));
                }
                if let Some(ref fid) = effect_filter_id {
                    self.output
                        .push_str(&format!("<g filter=\"url(#{})\">\n", fid));
                }
                match image.fill_mode {
                    ImageFillMode::FitToSize | ImageFillMode::None => {
                        self.output.push_str(&format!(
                            "<image x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" preserveAspectRatio=\"none\" href=\"{}\"/>\n",
                            bbox.x, bbox.y, bbox.width, bbox.height, data_uri,
                        ));
                    }
                    ImageFillMode::TileAll => {
                        self.render_tiled_image(bytes, &data_uri, &bbox, true, true, None, None);
                    }
                    ImageFillMode::TileHorzTop | ImageFillMode::TileHorzBottom => {
                        self.render_tiled_image(bytes, &data_uri, &bbox, true, false, None, None);
                    }
                    ImageFillMode::TileVertLeft | ImageFillMode::TileVertRight => {
                        self.render_tiled_image(bytes, &data_uri, &bbox, false, true, None, None);
                    }
                    _ => {
                        self.render_positioned_image(
                            bytes,
                            &data_uri,
                            &bbox,
                            image.fill_mode,
                            None,
                            None,
                        );
                    }
                }
                if effect_filter_id.is_some() {
                    self.output.push_str("</g>\n");
                }
                if tone_filter_id.is_some() {
                    self.output.push_str("</g>\n");
                }
            }
        }
        if let Some(color) = background.border_color {
            self.output.push_str(&format!(
                "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{}\"/>\n",
                bbox.x,
                bbox.y,
                bbox.width,
                bbox.height,
                color_to_svg(color),
                background.border_width.max(1.0),
            ));
        }
    }

    fn render_layer_text_run(&mut self, bbox: BoundingBox, run: &LayerTextRunPaint) {
        if self.font_embed_mode != FontEmbedMode::None && !run.style.font_family.is_empty() {
            let codepoints = self
                .font_codepoints
                .entry(run.style.font_family.clone())
                .or_default();
            for ch in run.text.chars() {
                if !ch.is_control() {
                    codepoints.insert(ch);
                }
            }
        }
        let effective_rotation = run.rotation;
        if effective_rotation != 0.0 {
            let cx = bbox.x + bbox.width / 2.0;
            let cy = bbox.y + bbox.height / 2.0;
            self.output.push_str(&format!(
                "<g transform=\"rotate({},{},{})\">\n",
                effective_rotation, cx, cy
            ));
        }
        let char_overlap = if run.legacy_visuals.char_overlap
            == Some(crate::paint::TextLegacyVisualState::Mirror)
        {
            None
        } else {
            run.char_overlap.as_ref()
        };
        if let Some(overlap) = char_overlap {
            self.draw_char_overlap(
                &run.text,
                &run.style,
                overlap,
                bbox.x,
                bbox.y,
                bbox.width,
                bbox.height,
            );
        } else {
            let mut style_without_mirror_visuals;
            let style = if run.legacy_visuals.tab_leaders
                == Some(crate::paint::TextLegacyVisualState::Mirror)
                || run.legacy_visuals.decorations
                    == Some(crate::paint::TextLegacyVisualState::Mirror)
            {
                style_without_mirror_visuals = run.style.clone();
                if run.legacy_visuals.tab_leaders
                    == Some(crate::paint::TextLegacyVisualState::Mirror)
                {
                    style_without_mirror_visuals.tab_leaders.clear();
                }
                if run.legacy_visuals.decorations
                    == Some(crate::paint::TextLegacyVisualState::Mirror)
                {
                    style_without_mirror_visuals.underline = UnderlineType::None;
                    style_without_mirror_visuals.strikethrough = false;
                    style_without_mirror_visuals.emphasis_dot = 0;
                }
                &style_without_mirror_visuals
            } else {
                &run.style
            };
            self.draw_text_with_positions(
                &run.text,
                bbox.x,
                bbox.y + run.baseline,
                style,
                Some(&run.positions),
            );
        }
        if run.legacy_visuals.control_marks != Some(crate::paint::TextLegacyVisualState::Mirror) {
            for mark in &run.control_marks {
                self.render_layer_text_control_mark(bbox, mark, run.baseline);
            }
        }
        if effective_rotation != 0.0 {
            self.output.push_str("</g>\n");
        }
    }

    fn render_layer_text_decoration(
        &mut self,
        bbox: BoundingBox,
        decoration: &LayerTextDecorationPaint,
    ) {
        if decoration.rotation != 0.0 {
            let cx = bbox.x + bbox.width / 2.0;
            let cy = bbox.y + bbox.height / 2.0;
            self.output.push_str(&format!(
                "<g transform=\"rotate({},{},{})\">\n",
                decoration.rotation, cx, cy
            ));
        }
        let text_width = decoration.positions.last().copied().unwrap_or(0.0);
        let baseline_y = bbox.y + decoration.baseline;
        let color = color_to_svg(decoration.color);
        match decoration.kind {
            LayerTextDecorationKind::Underline => {
                let y = match decoration.underline {
                    UnderlineType::Top => baseline_y - decoration.font_size + 1.0,
                    _ => baseline_y + 2.0,
                };
                self.draw_line_shape(bbox.x, y, bbox.x + text_width, y, &color, decoration.shape);
            }
            LayerTextDecorationKind::Strikethrough => {
                let y = baseline_y - decoration.font_size * 0.3;
                self.draw_line_shape(bbox.x, y, bbox.x + text_width, y, &color, decoration.shape);
            }
            LayerTextDecorationKind::EmphasisDot => {
                let dot_char = match decoration.emphasis_dot {
                    1 => "●",
                    2 => "○",
                    3 => "ˇ",
                    4 => "˜",
                    5 => "･",
                    6 => "˸",
                    _ => "",
                };
                if !dot_char.is_empty() {
                    let dot_size = decoration.font_size * 0.3;
                    let dot_y = baseline_y - decoration.font_size * 1.05;
                    for &position in decoration
                        .positions
                        .iter()
                        .take(decoration.positions.len().saturating_sub(1))
                    {
                        let dot_x =
                            bbox.x + position + decoration.font_size * decoration.ratio * 0.5;
                        self.output.push_str(&format!(
                            "<text x=\"{}\" y=\"{}\" font-size=\"{}\" text-anchor=\"middle\" fill=\"{}\">{}</text>\n",
                            dot_x, dot_y, dot_size, color, dot_char,
                        ));
                    }
                }
            }
        }
        if decoration.rotation != 0.0 {
            self.output.push_str("</g>\n");
        }
    }

    fn render_layer_text_control_mark(
        &mut self,
        bbox: BoundingBox,
        mark: &crate::paint::LayerTextControlMark,
        baseline: f64,
    ) {
        let output_options = crate::paint::LayerOutputOptions {
            show_paragraph_marks: self.show_paragraph_marks,
            show_control_codes: self.show_control_codes,
            ..Default::default()
        };
        if !output_options.allows_text_control_mark(mark.kind) {
            return;
        }
        self.output.push_str(&format!(
            "<text x=\"{}\" y=\"{}\" font-size=\"{}\" fill=\"#4A90D9\">{}</text>\n",
            bbox.x + mark.x,
            bbox.y + baseline + mark.y,
            mark.font_size,
            mark.kind.glyph(),
        ));
    }

    fn render_layer_tab_leader(
        &mut self,
        origin_x: f64,
        baseline_y: f64,
        font_size: f64,
        color: u32,
        leader: &crate::renderer::TabLeaderInfo,
    ) {
        if leader.fill_type == 0 {
            return;
        }
        let lx1 = origin_x + leader.start_x;
        let lx2 = origin_x + leader.end_x;
        let ly = baseline_y - font_size * 0.35;
        let color = color_to_svg(color);
        match leader.fill_type {
            1 => self.output.push_str(&format!(
                "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.5\"/>\n",
                lx1, ly, lx2, ly, color,
            )),
            2 => self.output.push_str(&format!(
                "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.5\" stroke-dasharray=\"3 3\"/>\n",
                lx1, ly, lx2, ly, color,
            )),
            3 => self.output.push_str(&format!(
                "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.5\" stroke-dasharray=\"1 2\"/>\n",
                lx1, ly, lx2, ly, color,
            )),
            4 => self.output.push_str(&format!(
                "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.5\" stroke-dasharray=\"6 2 1 2\"/>\n",
                lx1, ly, lx2, ly, color,
            )),
            5 => self.output.push_str(&format!(
                "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.5\" stroke-dasharray=\"6 2 1 2 1 2\"/>\n",
                lx1, ly, lx2, ly, color,
            )),
            6 => self.output.push_str(&format!(
                "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.5\" stroke-dasharray=\"8 4\"/>\n",
                lx1, ly, lx2, ly, color,
            )),
            7 => self.output.push_str(&format!(
                "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.7\" stroke-dasharray=\"0.1 2.5\" stroke-linecap=\"round\"/>\n",
                lx1, ly, lx2, ly, color,
            )),
            8 => self.output.push_str(&format!(
                "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.3\"/>\n\
                 <line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.3\"/>\n",
                lx1, ly - 1.0, lx2, ly - 1.0, color,
                lx1, ly + 1.0, lx2, ly + 1.0, color,
            )),
            9 => self.output.push_str(&format!(
                "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.3\"/>\n\
                 <line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.8\"/>\n",
                lx1, ly - 1.2, lx2, ly - 1.2, color,
                lx1, ly + 0.8, lx2, ly + 0.8, color,
            )),
            10 => self.output.push_str(&format!(
                "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.8\"/>\n\
                 <line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.3\"/>\n",
                lx1, ly - 0.8, lx2, ly - 0.8, color,
                lx1, ly + 1.2, lx2, ly + 1.2, color,
            )),
            11 => self.output.push_str(&format!(
                "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.3\"/>\n\
                 <line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.8\"/>\n\
                 <line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.3\"/>\n",
                lx1, ly - 2.0, lx2, ly - 2.0, color,
                lx1, ly, lx2, ly, color,
                lx1, ly + 2.0, lx2, ly + 2.0, color,
            )),
            _ => self.output.push_str(&format!(
                "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.5\" stroke-dasharray=\"1 2\"/>\n",
                lx1, ly, lx2, ly, color,
            )),
        }
    }

    fn render_layer_char_overlap(
        &mut self,
        bbox: BoundingBox,
        overlap: &crate::paint::LayerCharOverlapPaint,
    ) {
        let effective_rotation = overlap.rotation;
        if effective_rotation != 0.0 {
            let cx = bbox.x + bbox.width / 2.0;
            let cy = bbox.y + bbox.height / 2.0;
            self.output.push_str(&format!(
                "<g transform=\"rotate({},{},{})\">\n",
                effective_rotation, cx, cy
            ));
        }
        self.draw_char_overlap(
            &overlap.text,
            &overlap.style,
            &overlap.overlap,
            bbox.x,
            bbox.y,
            bbox.width,
            bbox.height,
        );
        if effective_rotation != 0.0 {
            self.output.push_str("</g>\n");
        }
    }

    fn render_layer_image(
        &mut self,
        bbox: BoundingBox,
        image: &LayerImagePaint,
        resources: &ResourceArena,
    ) {
        let mut temp = ImageNode::new(
            0,
            image.resource_id.and_then(|resource_id| {
                resources
                    .image_bytes(resource_id)
                    .map(|bytes| bytes.to_vec())
            }),
        );
        temp.fill_mode = image.fill_mode;
        temp.original_size = image.original_size;
        temp.transform = image.transform;
        temp.crop = image.crop;
        temp.effect = image.effect;
        temp.brightness = image.brightness;
        temp.contrast = image.contrast;
        let effective_bbox = temp.transform.effective_image_bbox(&bbox);
        self.open_shape_transform(&temp.transform, &effective_bbox);
        self.render_image_node(&temp, &effective_bbox);
        if temp.transform.has_transform() {
            self.output.push_str("</g>\n");
        }
    }

    fn render_glyph_outline_colrv1_graph(
        &mut self,
        outline: &LayerGlyphOutlinePaint,
        graph: &crate::paint::ColorPaintGraphPayload,
    ) {
        self.render_glyph_outline_colrv1_graph_node(outline, graph, graph.root_node_id, None, 0);
    }

    fn render_glyph_outline_colrv1_graph_node(
        &mut self,
        outline: &LayerGlyphOutlinePaint,
        graph: &crate::paint::ColorPaintGraphPayload,
        node_id: u32,
        transform_to_run: Option<LayerAffineTransform>,
        depth: usize,
    ) {
        if depth > 64 {
            return;
        }
        let Some(node) = graph.nodes.iter().find(|node| node.node_id == node_id) else {
            return;
        };
        match node.kind {
            crate::paint::ColorPaintGraphNodeKind::SolidPath => {
                let Some(solid) = node.solid_path.as_ref() else {
                    return;
                };
                let Some(glyph_range) = node.glyph_range else {
                    return;
                };
                let Some(source_range) = node.source_range_utf8 else {
                    return;
                };
                let fill_color = resolved_color_to_svg(&solid.fill);
                let fill_opacity = resolved_color_opacity_attr(&solid.fill);
                self.output.push_str(&format!(
                    "<path d=\"{}\" fill=\"{}\"{} fill-rule=\"{}\"{} data-rhwp-color-format=\"colrV1\" data-rhwp-color-graph-node-kind=\"solidPath\" data-rhwp-color-graph-node-id=\"{}\" data-rhwp-glyph-id=\"{}\" data-rhwp-glyph-start=\"{}\" data-rhwp-glyph-end=\"{}\" data-rhwp-source-id=\"{}\" data-rhwp-source-utf8-start=\"{}\" data-rhwp-source-utf8-end=\"{}\"{} data-rhwp-equivalence-group=\"{}\" data-rhwp-variant-id=\"{}\"><desc>source-backed COLRv1 glyph color graph solid path</desc></path>\n",
                    svg_path_data(&solid.commands).trim(),
                    fill_color,
                    fill_opacity,
                    solid.fill_rule.as_str(),
                    transform_to_run
                        .map(|transform| format!(" transform=\"{}\"", svg_affine_matrix_transform(transform)))
                        .unwrap_or_default(),
                    node.node_id,
                    solid.source_glyph_id.unwrap_or(0),
                    glyph_range.start,
                    glyph_range.end,
                    outline.source.id.0,
                    source_range.start,
                    source_range.end,
                    solid
                        .palette_index
                        .map(|index| format!(" data-rhwp-palette-index=\"{}\"", index))
                        .unwrap_or_default(),
                    escape_xml(&outline.variant.equivalence_group),
                    escape_xml(&outline.variant.variant_id),
                ));
            }
            crate::paint::ColorPaintGraphNodeKind::LinearGradientPath => {
                let Some(gradient_path) = node.linear_gradient_path.as_ref() else {
                    return;
                };
                let Some(glyph_range) = node.glyph_range else {
                    return;
                };
                let Some(source_range) = node.source_range_utf8 else {
                    return;
                };
                let gradient_id = self.create_colrv1_linear_gradient_def(&gradient_path.gradient);
                self.output.push_str(&format!(
                    "<path d=\"{}\" fill=\"url(#{})\" fill-rule=\"{}\"{} data-rhwp-color-format=\"colrV1\" data-rhwp-color-graph-node-kind=\"linearGradientPath\" data-rhwp-color-graph-node-id=\"{}\" data-rhwp-glyph-id=\"{}\" data-rhwp-glyph-start=\"{}\" data-rhwp-glyph-end=\"{}\" data-rhwp-source-id=\"{}\" data-rhwp-source-utf8-start=\"{}\" data-rhwp-source-utf8-end=\"{}\"{} data-rhwp-equivalence-group=\"{}\" data-rhwp-variant-id=\"{}\"><desc>source-backed COLRv1 glyph color graph linear gradient path</desc></path>\n",
                    svg_path_data(&gradient_path.commands).trim(),
                    gradient_id,
                    gradient_path.fill_rule.as_str(),
                    transform_to_run
                        .map(|transform| format!(" transform=\"{}\"", svg_affine_matrix_transform(transform)))
                        .unwrap_or_default(),
                    node.node_id,
                    gradient_path.source_glyph_id.unwrap_or(0),
                    glyph_range.start,
                    glyph_range.end,
                    outline.source.id.0,
                    source_range.start,
                    source_range.end,
                    gradient_path
                        .palette_index
                        .map(|index| format!(" data-rhwp-palette-index=\"{}\"", index))
                        .unwrap_or_default(),
                    escape_xml(&outline.variant.equivalence_group),
                    escape_xml(&outline.variant.variant_id),
                ));
            }
            crate::paint::ColorPaintGraphNodeKind::RadialGradientPath => {
                let Some(gradient_path) = node.radial_gradient_path.as_ref() else {
                    return;
                };
                let Some(glyph_range) = node.glyph_range else {
                    return;
                };
                let Some(source_range) = node.source_range_utf8 else {
                    return;
                };
                let gradient_id = self.create_colrv1_radial_gradient_def(&gradient_path.gradient);
                self.output.push_str(&format!(
                    "<path d=\"{}\" fill=\"url(#{})\" fill-rule=\"{}\"{} data-rhwp-color-format=\"colrV1\" data-rhwp-color-graph-node-kind=\"radialGradientPath\" data-rhwp-color-graph-node-id=\"{}\" data-rhwp-glyph-id=\"{}\" data-rhwp-glyph-start=\"{}\" data-rhwp-glyph-end=\"{}\" data-rhwp-source-id=\"{}\" data-rhwp-source-utf8-start=\"{}\" data-rhwp-source-utf8-end=\"{}\"{} data-rhwp-equivalence-group=\"{}\" data-rhwp-variant-id=\"{}\"><desc>source-backed COLRv1 glyph color graph radial gradient path</desc></path>\n",
                    svg_path_data(&gradient_path.commands).trim(),
                    gradient_id,
                    gradient_path.fill_rule.as_str(),
                    transform_to_run
                        .map(|transform| format!(" transform=\"{}\"", svg_affine_matrix_transform(transform)))
                        .unwrap_or_default(),
                    node.node_id,
                    gradient_path.source_glyph_id.unwrap_or(0),
                    glyph_range.start,
                    glyph_range.end,
                    outline.source.id.0,
                    source_range.start,
                    source_range.end,
                    gradient_path
                        .palette_index
                        .map(|index| format!(" data-rhwp-palette-index=\"{}\"", index))
                        .unwrap_or_default(),
                    escape_xml(&outline.variant.equivalence_group),
                    escape_xml(&outline.variant.variant_id),
                ));
            }
            crate::paint::ColorPaintGraphNodeKind::SweepGradientPath => {}
            crate::paint::ColorPaintGraphNodeKind::Transform => {
                let Some(transform) = node.transform.as_ref() else {
                    return;
                };
                let next_transform = transform_to_run
                    .map(|existing| compose_layer_affine_transform(existing, transform.transform))
                    .unwrap_or(transform.transform);
                self.render_glyph_outline_colrv1_graph_node(
                    outline,
                    graph,
                    transform.child_node_id,
                    Some(next_transform),
                    depth + 1,
                );
            }
            crate::paint::ColorPaintGraphNodeKind::Composite => {
                let Some(composite) = node.composite.as_ref() else {
                    return;
                };
                match composite.mode {
                    crate::paint::ColorPaintCompositeMode::SourceOver => {
                        self.render_glyph_outline_colrv1_graph_node(
                            outline,
                            graph,
                            composite.backdrop_node_id,
                            transform_to_run,
                            depth + 1,
                        );
                        self.render_glyph_outline_colrv1_graph_node(
                            outline,
                            graph,
                            composite.source_node_id,
                            transform_to_run,
                            depth + 1,
                        );
                    }
                }
            }
            crate::paint::ColorPaintGraphNodeKind::Clip => {
                let Some(clip) = node.clip.as_ref() else {
                    return;
                };
                let clip_id = format!("colrv1-clip-{}", self.next_clip_id());
                self.defs.push(format!(
                    "<clipPath id=\"{}\"><path d=\"{}\" clip-rule=\"{}\"{}/></clipPath>\n",
                    clip_id,
                    svg_path_data(&clip.clip_commands).trim(),
                    clip.fill_rule.as_str(),
                    transform_to_run
                        .map(|transform| format!(
                            " transform=\"{}\"",
                            svg_affine_matrix_transform(transform)
                        ))
                        .unwrap_or_default()
                ));
                self.output
                    .push_str(&format!("<g clip-path=\"url(#{})\">", clip_id));
                self.render_glyph_outline_colrv1_graph_node(
                    outline,
                    graph,
                    clip.child_node_id,
                    transform_to_run,
                    depth + 1,
                );
                self.output.push_str("</g>\n");
            }
        }
    }

    fn create_colrv1_linear_gradient_def(
        &mut self,
        gradient: &crate::paint::ColorLinearGradient,
    ) -> String {
        self.gradient_counter += 1;
        let id = format!("grad{}", self.gradient_counter);
        let stops = colrv1_gradient_stops_to_svg(&gradient.stops);
        self.defs.push(format!(
            "<linearGradient id=\"{}\" gradientUnits=\"userSpaceOnUse\" x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\">\n{}</linearGradient>\n",
            id, gradient.x0, gradient.y0, gradient.x1, gradient.y1, stops,
        ));
        id
    }

    fn create_colrv1_radial_gradient_def(
        &mut self,
        gradient: &crate::paint::ColorRadialGradient,
    ) -> String {
        self.gradient_counter += 1;
        let id = format!("grad{}", self.gradient_counter);
        let stops = colrv1_gradient_stops_to_svg(&gradient.stops);
        self.defs.push(format!(
            "<radialGradient id=\"{}\" gradientUnits=\"userSpaceOnUse\" cx=\"{}\" cy=\"{}\" r=\"{}\">\n{}</radialGradient>\n",
            id, gradient.cx, gradient.cy, gradient.radius, stops,
        ));
        id
    }

    fn render_layer_glyph_outline_bitmap(
        &mut self,
        bbox: BoundingBox,
        outline: &LayerGlyphOutlinePaint,
        resources: &ResourceArena,
    ) {
        if !glyph_payload_bbox_is_replayable(bbox) {
            return;
        }
        let Some(payload) = outline.bitmap_glyph.as_ref() else {
            return;
        };
        if !outline.has_exclusive_payload_family() {
            return;
        }
        if !payload.has_strict_visual_contract() {
            return;
        }
        let Some(bytes) = resources.image_bytes(payload.image_resource_id) else {
            return;
        };
        let (Some(glyph_range), Some(source_range)) =
            (payload.glyph_range, payload.source_range_utf8)
        else {
            return;
        };
        let data_uri = svg_image_data_uri(bytes);
        let image_rendering = match payload.filtering {
            Some(BitmapGlyphFiltering::Nearest) => " image-rendering=\"pixelated\"",
            _ => "",
        };
        let Some(placement) = payload.placement else {
            return;
        };
        let transform =
            glyph_payload_svg_transform(placement.run_to_page, payload.transform_to_run);
        let color_space_defaulted = payload.color_space.is_none();
        let color_space_attr = payload
            .color_space
            .as_ref()
            .map(|color_space| {
                format!(
                    " data-rhwp-color-space=\"{}\"",
                    escape_xml(color_space.as_str())
                )
            })
            .unwrap_or_else(|| " data-rhwp-color-space=\"sRGB\"".to_string());
        let alpha_mode_attr = payload
            .alpha_mode
            .map(|alpha_mode| format!(" data-rhwp-alpha-mode=\"{}\"", alpha_mode.as_str()))
            .unwrap_or_default();
        let scaling_policy_attr = payload
            .scaling_policy
            .map(|policy| format!(" data-rhwp-scaling-policy=\"{}\"", policy.as_str()))
            .unwrap_or_default();
        let filtering_attr = payload
            .filtering
            .map(|filtering| format!(" data-rhwp-filtering=\"{}\"", filtering.as_str()))
            .unwrap_or_default();
        self.output.push_str(&format!(
            "<g transform=\"{}\" data-rhwp-equivalence-group=\"{}\" data-rhwp-variant-id=\"{}\"><image x=\"0\" y=\"0\" width=\"{}\" height=\"{}\" preserveAspectRatio=\"none\" href=\"{}\"{} data-rhwp-glyph-start=\"{}\" data-rhwp-glyph-end=\"{}\" data-rhwp-source-id=\"{}\" data-rhwp-source-utf8-start=\"{}\" data-rhwp-source-utf8-end=\"{}\" data-rhwp-image-resource-id=\"{}\" data-rhwp-color-space-defaulted=\"{}\"{}{}{}{} data-rhwp-equivalence-group=\"{}\" data-rhwp-variant-id=\"{}\"><desc>source-backed bitmap glyph</desc></image></g>\n",
            svg_affine_matrix_transform(transform),
            escape_xml(&outline.variant.equivalence_group),
            escape_xml(&outline.variant.variant_id),
            bbox.width,
            bbox.height,
            data_uri,
            image_rendering,
            glyph_range.start,
            glyph_range.end,
            outline.source.id.0,
            source_range.start,
            source_range.end,
            payload.image_resource_id.0,
            color_space_defaulted,
            color_space_attr,
            alpha_mode_attr,
            scaling_policy_attr,
            filtering_attr,
            escape_xml(&outline.variant.equivalence_group),
            escape_xml(&outline.variant.variant_id),
        ));
    }

    fn render_layer_glyph_outline_svg(
        &mut self,
        bbox: BoundingBox,
        outline: &LayerGlyphOutlinePaint,
        resources: &ResourceArena,
    ) {
        if !glyph_payload_bbox_is_replayable(bbox) {
            return;
        }
        let Some(payload) = outline.svg_glyph.as_ref() else {
            return;
        };
        if !outline.has_exclusive_payload_family() {
            return;
        }
        if !payload.has_static_sanitized_contract() {
            return;
        }
        let Some(fragment) = resources.svg_fragment(payload.vector_resource_id) else {
            return;
        };
        if !static_svg_fragment_has_path_layer(fragment) {
            return;
        }
        let (Some(glyph_range), Some(source_range), Some(view_box)) = (
            payload.glyph_range,
            payload.source_range_utf8,
            payload.view_box,
        ) else {
            return;
        };
        let Some(placement) = payload.placement else {
            return;
        };
        let transform =
            glyph_payload_svg_transform(placement.run_to_page, payload.transform_to_run);

        self.output.push_str(&format!(
            "<g transform=\"{}\" data-rhwp-equivalence-group=\"{}\" data-rhwp-variant-id=\"{}\"><svg x=\"0\" y=\"0\" width=\"{}\" height=\"{}\" viewBox=\"{} {} {} {}\" preserveAspectRatio=\"none\" overflow=\"visible\" data-rhwp-glyph-start=\"{}\" data-rhwp-glyph-end=\"{}\" data-rhwp-source-id=\"{}\" data-rhwp-source-utf8-start=\"{}\" data-rhwp-source-utf8-end=\"{}\" data-rhwp-vector-resource-id=\"{}\" data-rhwp-security-mode=\"{}\" data-rhwp-equivalence-group=\"{}\" data-rhwp-variant-id=\"{}\"><desc>source-backed static sanitized SVG glyph</desc>",
            svg_affine_matrix_transform(transform),
            escape_xml(&outline.variant.equivalence_group),
            escape_xml(&outline.variant.variant_id),
            bbox.width,
            bbox.height,
            view_box.x,
            view_box.y,
            view_box.width,
            view_box.height,
            glyph_range.start,
            glyph_range.end,
            outline.source.id.0,
            source_range.start,
            source_range.end,
            payload.vector_resource_id.0,
            payload.security_mode.as_str(),
            escape_xml(&outline.variant.equivalence_group),
            escape_xml(&outline.variant.variant_id),
        ));
        self.output.push_str(fragment);
        self.output.push_str("</svg></g>\n");
    }

    fn render_layer_equation(
        &mut self,
        bbox: BoundingBox,
        equation: &LayerEquationPaint,
        resources: &ResourceArena,
    ) {
        self.output.push_str(&format!(
            "<g transform=\"translate({},{})\">\n",
            bbox.x, bbox.y,
        ));
        let svg_content = resources
            .svg_fragment(equation.svg_resource_id)
            .unwrap_or("");
        self.output.push_str(svg_content);
        self.output.push_str("</g>\n");
        if self.font_embed_mode != FontEmbedMode::None {
            let codepoints = self
                .font_codepoints
                .entry("Latin Modern Math".to_string())
                .or_default();
            for segment in svg_content.split("</text>") {
                if let Some(start) = segment.rfind('>') {
                    for ch in segment[start + 1..].chars() {
                        codepoints.insert(ch);
                    }
                }
            }
        }
    }

    /// 도형 변환(회전/대칭)이 있으면 `<g transform="...">` 래퍼를 연다.
    fn open_shape_transform(&mut self, transform: &ShapeTransform, bbox: &BoundingBox) {
        if !transform.has_transform() {
            return;
        }
        let cx = bbox.x + bbox.width / 2.0;
        let cy = bbox.y + bbox.height / 2.0;
        let mut parts = Vec::new();
        // 대칭을 먼저 적용 (중심 기준 스케일 반전)
        if transform.horz_flip {
            parts.push(format!("translate({},0) scale(-1,1)", cx * 2.0));
        }
        if transform.vert_flip {
            parts.push(format!("translate(0,{}) scale(1,-1)", cy * 2.0));
        }
        // 회전 (중심 기준)
        if transform.rotation != 0.0 {
            parts.push(format!("rotate({},{},{})", transform.rotation, cx, cy));
        }
        self.output
            .push_str(&format!("<g transform=\"{}\">\n", parts.join(" ")));
    }

    /// 도형 변환 그룹을 닫는다 (open_shape_transform에 대응).
    fn close_shape_transform(&mut self, node_type: &RenderNodeType) {
        let transform = match node_type {
            RenderNodeType::Rectangle(r) => &r.transform,
            RenderNodeType::Line(l) => &l.transform,
            RenderNodeType::Ellipse(e) => &e.transform,
            RenderNodeType::Image(i) => &i.transform,
            RenderNodeType::Path(p) => &p.transform,
            _ => return,
        };
        if transform.has_transform() {
            self.output.push_str("</g>\n");
        }
    }

    /// 그라데이션 SVG 정의 생성, ID 반환
    fn create_gradient_def(&mut self, grad: &GradientFillInfo) -> String {
        self.gradient_counter += 1;
        let id = format!("grad{}", self.gradient_counter);

        let stops = Self::build_gradient_stops(grad);

        let def = match grad.gradient_type {
            2..=4 => {
                // 원형/Radial 계열. Canvas2D/Skia도 type 2, 3, 4를 radial로 재생한다.
                let cx = grad.center_x as f64;
                let cy = grad.center_y as f64;
                format!(
                    "<radialGradient id=\"{}\" cx=\"{}%\" cy=\"{}%\" r=\"50%\" fx=\"{}%\" fy=\"{}%\">\n{}</radialGradient>\n",
                    id, cx, cy, cx, cy, stops,
                )
            }
            _ => {
                // 선형 (Linear)
                let (x1, y1, x2, y2) = Self::angle_to_svg_coords(grad.angle);
                format!(
                    "<linearGradient id=\"{}\" x1=\"{}%\" y1=\"{}%\" x2=\"{}%\" y2=\"{}%\">\n{}</linearGradient>\n",
                    id, x1, y1, x2, y2, stops,
                )
            }
        };

        self.defs.push(def);
        id
    }

    /// 패턴 채우기 SVG 정의 생성, ID 반환
    fn create_pattern_def(&mut self, info: &PatternFillInfo) -> String {
        self.clip_counter += 1;
        let id = format!("pat{}", self.clip_counter);
        let bg = color_to_svg(info.background_color);
        let fg = color_to_svg(info.pattern_color);
        let sz = 6; // 패턴 타일 크기 (px)

        // HWP 패턴 종류 (0-based, 표 31 참조): 0=가로줄, 1=세로줄, 2=역대각선, 3=대각선, 4=십자, 5=격자
        let lines = match info.pattern_type {
            0 => // 가로줄 (- - - -)
                format!("<rect width=\"{sz}\" height=\"{sz}\" fill=\"{bg}\"/>\
                         <line x1=\"0\" y1=\"3\" x2=\"{sz}\" y2=\"3\" stroke=\"{fg}\" stroke-width=\"1\"/>"),
            1 => // 세로줄 (|||||)
                format!("<rect width=\"{sz}\" height=\"{sz}\" fill=\"{bg}\"/>\
                         <line x1=\"3\" y1=\"0\" x2=\"3\" y2=\"{sz}\" stroke=\"{fg}\" stroke-width=\"1\"/>"),
            2 => // 대각선 (/////)
                format!("<rect width=\"{sz}\" height=\"{sz}\" fill=\"{bg}\"/>\
                         <line x1=\"{sz}\" y1=\"0\" x2=\"0\" y2=\"{sz}\" stroke=\"{fg}\" stroke-width=\"1\"/>"),
            3 => // 역대각선 (\\\\\)
                format!("<rect width=\"{sz}\" height=\"{sz}\" fill=\"{bg}\"/>\
                         <line x1=\"0\" y1=\"0\" x2=\"{sz}\" y2=\"{sz}\" stroke=\"{fg}\" stroke-width=\"1\"/>"),
            4 => // 십자 (+++++)
                format!("<rect width=\"{sz}\" height=\"{sz}\" fill=\"{bg}\"/>\
                         <line x1=\"3\" y1=\"0\" x2=\"3\" y2=\"{sz}\" stroke=\"{fg}\" stroke-width=\"1\"/>\
                         <line x1=\"0\" y1=\"3\" x2=\"{sz}\" y2=\"3\" stroke=\"{fg}\" stroke-width=\"1\"/>"),
            5 => // 격자 (xxxxx)
                format!("<rect width=\"{sz}\" height=\"{sz}\" fill=\"{bg}\"/>\
                         <line x1=\"0\" y1=\"0\" x2=\"{sz}\" y2=\"{sz}\" stroke=\"{fg}\" stroke-width=\"1\"/>\
                         <line x1=\"{sz}\" y1=\"0\" x2=\"0\" y2=\"{sz}\" stroke=\"{fg}\" stroke-width=\"1\"/>"),
            _ => // 알 수 없는 패턴: 단색
                format!("<rect width=\"{sz}\" height=\"{sz}\" fill=\"{bg}\"/>"),
        };

        let def = format!(
            "<pattern id=\"{}\" patternUnits=\"userSpaceOnUse\" width=\"{}\" height=\"{}\">{}</pattern>\n",
            id, sz, sz, lines
        );
        self.defs.push(def);
        id
    }

    /// ShapeStyle에서 SVG fill 속성 문자열 생성
    fn build_fill_attr(
        &mut self,
        style: &ShapeStyle,
        gradient: Option<&GradientFillInfo>,
    ) -> String {
        if let Some(grad) = gradient {
            let grad_id = self.create_gradient_def(grad);
            format!(" fill=\"url(#{})\"", grad_id)
        } else if let Some(ref pat) = style.pattern {
            let pat_id = self.create_pattern_def(pat);
            format!(" fill=\"url(#{})\"", pat_id)
        } else if let Some(fill) = style.fill_color {
            format!(" fill=\"{}\"", color_to_svg(fill))
        } else {
            " fill=\"none\"".to_string()
        }
    }

    /// 화살표 마커 SVG 정의 생성 (중복 시 기존 ID 반환)
    ///
    /// HWP 화살표 크기(0-8): {작은,중간,큰} × {작은,중간,큰} (너비 × 길이)
    /// 선 두께와 길이를 고려하여 마커 크기 결정
    fn ensure_arrow_marker(
        &mut self,
        color: &str,
        stroke_width: f64,
        line_len: f64,
        arrow: &super::ArrowStyle,
        arrow_size: u8,
        is_start: bool,
    ) -> String {
        let type_name = match arrow {
            super::ArrowStyle::Arrow => "arrow",
            super::ArrowStyle::ConcaveArrow => "concave",
            super::ArrowStyle::OpenDiamond => "odiamond",
            super::ArrowStyle::OpenCircle => "ocircle",
            super::ArrowStyle::OpenSquare => "osquare",
            super::ArrowStyle::Diamond => "diamond",
            super::ArrowStyle::Circle => "circle",
            super::ArrowStyle::Square => "square",
            super::ArrowStyle::None => "none",
        };
        let dir = if is_start { "s" } else { "e" };
        let color_id = color.replace('#', "");
        let id = format!("mk-{}-{}-{}-{}", type_name, dir, color_id, arrow_size);

        if self.arrow_marker_ids.contains(&id) {
            return id;
        }
        self.arrow_marker_ids.insert(id.clone());

        // HWP 화살표 크기 → 너비/길이 배율
        // arrow_size: 0=작은-작은, 1=작은-중간, 2=작은-큰,
        //             3=중간-작은, 4=중간-중간, 5=중간-큰,
        //             6=큰-작은, 7=큰-중간, 8=큰-큰
        let width_level = arrow_size / 3; // 0=작은, 1=중간, 2=큰
        let length_level = arrow_size % 3; // 0=작은, 1=중간, 2=큰

        // 너비 배율 (선 두께 대비 화살표 높이)
        let width_mult = match width_level {
            0 => 1.5, // 작은: 선 두께의 1.5배
            1 => 2.5, // 중간: 선 두께의 2.5배
            _ => 3.5, // 큰: 선 두께의 3.5배
        };
        // 길이 배율 (화살표 높이 대비 길이)
        let length_mult = match length_level {
            0 => 1.0, // 작은
            1 => 1.5, // 중간
            _ => 2.0, // 큰
        };

        let arrow_h = (stroke_width * width_mult).max(3.0);
        let arrow_w = (arrow_h * length_mult).min(line_len * 0.3); // 선 길이의 30% 이하
        let half_h = arrow_h / 2.0;

        let def = match arrow {
            super::ArrowStyle::Arrow => {
                // 선이 화살표 길이만큼 줄어드므로 refX는 화살표 밑변(base) 위치
                // start: refX=arrow_w (밑변이 줄어든 시작점에 정렬, 팁은 원래 시작점 방향)
                // end:   refX=0 (밑변이 줄어든 끝점에 정렬, 팁은 원래 끝점 방향)
                if is_start {
                    format!(
                        "<marker id=\"{}\" viewBox=\"0 0 {} {}\" refX=\"{}\" refY=\"{}\" markerWidth=\"{}\" markerHeight=\"{}\" orient=\"auto\" markerUnits=\"userSpaceOnUse\">\
                        <path d=\"M {} 0 L 0 {} L {} {}\" fill=\"{}\" stroke=\"none\"/></marker>\n",
                        id, arrow_w, arrow_h, arrow_w, half_h, arrow_w, arrow_h,
                        arrow_w, half_h, arrow_w, arrow_h, color,
                    )
                } else {
                    format!(
                        "<marker id=\"{}\" viewBox=\"0 0 {} {}\" refX=\"0\" refY=\"{}\" markerWidth=\"{}\" markerHeight=\"{}\" orient=\"auto\" markerUnits=\"userSpaceOnUse\">\
                        <path d=\"M 0 0 L {} {} L 0 {}\" fill=\"{}\" stroke=\"none\"/></marker>\n",
                        id, arrow_w, arrow_h, half_h, arrow_w, arrow_h,
                        arrow_w, half_h, arrow_h, color,
                    )
                }
            }
            super::ArrowStyle::ConcaveArrow => {
                let concave = arrow_w * 0.3;
                if is_start {
                    format!(
                        "<marker id=\"{}\" viewBox=\"0 0 {} {}\" refX=\"{}\" refY=\"{}\" markerWidth=\"{}\" markerHeight=\"{}\" orient=\"auto\" markerUnits=\"userSpaceOnUse\">\
                        <path d=\"M {} 0 L 0 {} L {} {} L {} {} Z\" fill=\"{}\" stroke=\"none\"/></marker>\n",
                        id, arrow_w, arrow_h, arrow_w, half_h, arrow_w, arrow_h,
                        arrow_w, half_h, arrow_w, arrow_h, concave, half_h, color,
                    )
                } else {
                    format!(
                        "<marker id=\"{}\" viewBox=\"0 0 {} {}\" refX=\"0\" refY=\"{}\" markerWidth=\"{}\" markerHeight=\"{}\" orient=\"auto\" markerUnits=\"userSpaceOnUse\">\
                        <path d=\"M 0 0 L {} {} L 0 {} L {} {} Z\" fill=\"{}\" stroke=\"none\"/></marker>\n",
                        id, arrow_w, arrow_h, half_h, arrow_w, arrow_h,
                        arrow_w, half_h, arrow_h, arrow_w - concave, half_h, color,
                    )
                }
            }
            super::ArrowStyle::OpenDiamond => {
                let half_w = arrow_w / 2.0;
                let sw = (stroke_width * 0.3).max(0.5);
                let ref_x = if is_start { arrow_w } else { 0.0 };
                format!(
                    "<marker id=\"{}\" viewBox=\"0 0 {} {}\" refX=\"{}\" refY=\"{}\" markerWidth=\"{}\" markerHeight=\"{}\" orient=\"auto\" markerUnits=\"userSpaceOnUse\">\
                    <path d=\"M {} 0 L {} {} L {} {} L 0 {} Z\" fill=\"white\" stroke=\"{}\" stroke-width=\"{}\"/></marker>\n",
                    id, arrow_w, arrow_h, ref_x, half_h, arrow_w, arrow_h,
                    half_w, arrow_w, half_h, half_w, arrow_h, half_h, color, sw,
                )
            }
            super::ArrowStyle::OpenCircle => {
                let half_w = arrow_w / 2.0;
                let rx = half_w * 0.8;
                let ry = half_h * 0.8;
                let sw = (stroke_width * 0.3).max(0.5);
                let ref_x = if is_start { arrow_w } else { 0.0 };
                format!(
                    "<marker id=\"{}\" viewBox=\"0 0 {} {}\" refX=\"{}\" refY=\"{}\" markerWidth=\"{}\" markerHeight=\"{}\" orient=\"auto\" markerUnits=\"userSpaceOnUse\">\
                    <ellipse cx=\"{}\" cy=\"{}\" rx=\"{}\" ry=\"{}\" fill=\"white\" stroke=\"{}\" stroke-width=\"{}\"/></marker>\n",
                    id, arrow_w, arrow_h, ref_x, half_h, arrow_w, arrow_h,
                    half_w, half_h, rx, ry, color, sw,
                )
            }
            super::ArrowStyle::OpenSquare => {
                let sw = (stroke_width * 0.3).max(0.5);
                let ref_x = if is_start { arrow_w } else { 0.0 };
                format!(
                    "<marker id=\"{}\" viewBox=\"0 0 {} {}\" refX=\"{}\" refY=\"{}\" markerWidth=\"{}\" markerHeight=\"{}\" orient=\"auto\" markerUnits=\"userSpaceOnUse\">\
                    <rect x=\"0\" y=\"0\" width=\"{}\" height=\"{}\" fill=\"white\" stroke=\"{}\" stroke-width=\"{}\"/></marker>\n",
                    id, arrow_w, arrow_h, ref_x, half_h, arrow_w, arrow_h,
                    arrow_w, arrow_h, color, sw,
                )
            }
            super::ArrowStyle::Diamond => {
                let half_w = arrow_w / 2.0;
                let ref_x = if is_start { arrow_w } else { 0.0 };
                format!(
                    "<marker id=\"{}\" viewBox=\"0 0 {} {}\" refX=\"{}\" refY=\"{}\" markerWidth=\"{}\" markerHeight=\"{}\" orient=\"auto\" markerUnits=\"userSpaceOnUse\">\
                    <path d=\"M {} 0 L {} {} L {} {} L 0 {} Z\" fill=\"{}\" stroke=\"none\"/></marker>\n",
                    id, arrow_w, arrow_h, ref_x, half_h, arrow_w, arrow_h,
                    half_w, arrow_w, half_h, half_w, arrow_h, half_h, color,
                )
            }
            super::ArrowStyle::Circle => {
                let half_w = arrow_w / 2.0;
                let rx = half_w * 0.8;
                let ry = half_h * 0.8;
                let ref_x = if is_start { arrow_w } else { 0.0 };
                format!(
                    "<marker id=\"{}\" viewBox=\"0 0 {} {}\" refX=\"{}\" refY=\"{}\" markerWidth=\"{}\" markerHeight=\"{}\" orient=\"auto\" markerUnits=\"userSpaceOnUse\">\
                    <ellipse cx=\"{}\" cy=\"{}\" rx=\"{}\" ry=\"{}\" fill=\"{}\" stroke=\"none\"/></marker>\n",
                    id, arrow_w, arrow_h, ref_x, half_h, arrow_w, arrow_h,
                    half_w, half_h, rx, ry, color,
                )
            }
            super::ArrowStyle::Square => {
                let ref_x = if is_start { arrow_w } else { 0.0 };
                format!(
                    "<marker id=\"{}\" viewBox=\"0 0 {} {}\" refX=\"{}\" refY=\"{}\" markerWidth=\"{}\" markerHeight=\"{}\" orient=\"auto\" markerUnits=\"userSpaceOnUse\">\
                    <rect x=\"0\" y=\"0\" width=\"{}\" height=\"{}\" fill=\"{}\" stroke=\"none\"/></marker>\n",
                    id, arrow_w, arrow_h, ref_x, half_h, arrow_w, arrow_h,
                    arrow_w, arrow_h, color,
                )
            }
            super::ArrowStyle::None => return id,
        };

        self.defs.push(def);
        id
    }

    /// 화살표 크기(arrow_w, arrow_h) 계산
    /// ensure_arrow_marker와 동일한 로직으로 화살표 길이를 반환
    fn calc_arrow_dims(stroke_width: f64, line_len: f64, arrow_size: u8) -> (f64, f64) {
        let width_level = arrow_size / 3;
        let length_level = arrow_size % 3;
        let width_mult = match width_level {
            0 => 1.5,
            1 => 2.5,
            _ => 3.5,
        };
        let length_mult = match length_level {
            0 => 1.0,
            1 => 1.5,
            _ => 2.0,
        };
        let arrow_h = (stroke_width * width_mult).max(3.0);
        let arrow_w = (arrow_h * length_mult).min(line_len * 0.3);
        (arrow_w, arrow_h)
    }

    /// 그라데이션 색상 stop 목록 생성
    fn build_gradient_stops(grad: &GradientFillInfo) -> String {
        let mut stops = String::new();
        for (i, &color) in grad.colors.iter().enumerate() {
            let offset = if i < grad.positions.len() {
                grad.positions[i] * 100.0
            } else {
                let n = grad.colors.len();
                if n <= 1 {
                    0.0
                } else {
                    i as f64 / (n - 1) as f64 * 100.0
                }
            };
            stops.push_str(&format!(
                "<stop offset=\"{:.1}%\" stop-color=\"{}\"/>\n",
                offset,
                color_to_svg(color),
            ));
        }
        stops
    }

    /// 그라데이션을 포함한 사각형 그리기 (렌더 트리 전용)
    fn draw_rect_with_gradient(
        &mut self,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        corner_radius: f64,
        style: &ShapeStyle,
        gradient: Option<&GradientFillInfo>,
    ) {
        let mut attrs = format!("x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\"", x, y, w, h);

        if corner_radius > 0.0 {
            attrs.push_str(&format!(
                " rx=\"{}\" ry=\"{}\"",
                corner_radius, corner_radius
            ));
        }

        attrs.push_str(&self.build_fill_attr(style, gradient));

        if let Some(stroke) = style.stroke_color {
            attrs.push_str(&format!(
                " stroke=\"{}\" stroke-width=\"{}\"",
                color_to_svg(stroke),
                style.stroke_width
            ));
        }

        if style.opacity < 1.0 {
            attrs.push_str(&format!(" opacity=\"{:.3}\"", style.opacity));
        }

        self.output.push_str(&format!("<rect {}/>\n", attrs));
    }

    /// 그라데이션을 포함한 타원 그리기 (렌더 트리 전용)
    fn draw_ellipse_with_gradient(
        &mut self,
        cx: f64,
        cy: f64,
        rx: f64,
        ry: f64,
        style: &ShapeStyle,
        gradient: Option<&GradientFillInfo>,
    ) {
        let mut attrs = format!("cx=\"{}\" cy=\"{}\" rx=\"{}\" ry=\"{}\"", cx, cy, rx, ry);

        attrs.push_str(&self.build_fill_attr(style, gradient));

        if let Some(stroke) = style.stroke_color {
            attrs.push_str(&format!(
                " stroke=\"{}\" stroke-width=\"{}\"",
                color_to_svg(stroke),
                style.stroke_width
            ));
        }

        if style.opacity < 1.0 {
            attrs.push_str(&format!(" opacity=\"{:.3}\"", style.opacity));
        }

        self.output.push_str(&format!("<ellipse {}/>\n", attrs));
    }

    /// 그라데이션을 포함한 패스 그리기 (렌더 트리 전용)
    fn draw_path_with_gradient(
        &mut self,
        commands: &[PathCommand],
        style: &ShapeStyle,
        gradient: Option<&GradientFillInfo>,
    ) {
        let mut d = String::new();
        for cmd in commands {
            match cmd {
                PathCommand::MoveTo(x, y) => d.push_str(&format!("M{} {} ", x, y)),
                PathCommand::LineTo(x, y) => d.push_str(&format!("L{} {} ", x, y)),
                PathCommand::CurveTo(x1, y1, x2, y2, x, y) => {
                    d.push_str(&format!("C{} {} {} {} {} {} ", x1, y1, x2, y2, x, y))
                }
                PathCommand::ArcTo(rx, ry, x_rot, large_arc, sweep, x, y) => {
                    d.push_str(&format!(
                        "A{} {} {} {} {} {} {} ",
                        rx,
                        ry,
                        x_rot,
                        if *large_arc { 1 } else { 0 },
                        if *sweep { 1 } else { 0 },
                        x,
                        y
                    ));
                }
                PathCommand::ClosePath => d.push_str("Z "),
            }
        }

        let mut attrs = format!("d=\"{}\"", d.trim());

        attrs.push_str(&self.build_fill_attr(style, gradient));

        if let Some(stroke) = style.stroke_color {
            attrs.push_str(&format!(
                " stroke=\"{}\" stroke-width=\"{}\"",
                color_to_svg(stroke),
                style.stroke_width
            ));
            match style.stroke_dash {
                StrokeDash::Dash => attrs.push_str(" stroke-dasharray=\"6 3\""),
                StrokeDash::Dot => attrs.push_str(" stroke-dasharray=\"2 2\""),
                StrokeDash::DashDot => attrs.push_str(" stroke-dasharray=\"6 3 2 3\""),
                StrokeDash::DashDotDot => attrs.push_str(" stroke-dasharray=\"6 3 2 3 2 3\""),
                _ => {}
            }
        }
        if style.opacity < 1.0 {
            attrs.push_str(&format!(" opacity=\"{:.3}\"", style.opacity));
        }

        self.output.push_str(&format!("<path {}/>\n", attrs));
    }

    /// HWP 각도(도) → SVG linearGradient 좌표 (x1%, y1%, x2%, y2%) 변환
    fn angle_to_svg_coords(angle: i16) -> (f64, f64, f64, f64) {
        let a = ((angle % 360 + 360) % 360) as f64;
        match a as i32 {
            0 => (0.0, 0.0, 0.0, 100.0),
            45 => (0.0, 0.0, 100.0, 100.0),
            90 => (0.0, 0.0, 100.0, 0.0),
            135 => (0.0, 100.0, 100.0, 0.0),
            180 => (0.0, 100.0, 0.0, 0.0),
            225 => (100.0, 100.0, 0.0, 0.0),
            270 => (100.0, 0.0, 0.0, 0.0),
            315 => (100.0, 0.0, 0.0, 100.0),
            _ => {
                let rad = a.to_radians();
                let sin = rad.sin();
                let cos = rad.cos();
                let x1 = 50.0 - sin * 50.0;
                let y1 = 50.0 - cos * 50.0;
                let x2 = 50.0 + sin * 50.0;
                let y2 = 50.0 + cos * 50.0;
                (x1, y1, x2, y2)
            }
        }
    }

    /// 이중선/삼중선 렌더링: 원래 선에 수직 방향으로 평행선들을 그림
    fn draw_multi_line(
        &mut self,
        x1: f64,
        y1: f64,
        x2: f64,
        y2: f64,
        total_width: f64,
        color: &str,
        dash: super::StrokeDash,
        line_type: &super::LineRenderType,
    ) {
        let dx = x2 - x1;
        let dy = y2 - y1;
        let len = (dx * dx + dy * dy).sqrt();
        if len < 0.001 {
            return;
        }

        // 수직 방향 단위벡터 (선의 법선)
        let nx = -dy / len;
        let ny = dx / len;

        // (width_ratio, offset_ratio) — offset은 선 중심으로부터의 거리 비율
        let lines: Vec<(f64, f64)> = match line_type {
            super::LineRenderType::Double => {
                // 같은 굵기 이중선: 각 선 30%, 간격 40%
                vec![(0.30, -0.35), (0.30, 0.35)]
            }
            super::LineRenderType::ThickThinDouble => {
                // 굵은선(위)-얇은선(아래): 굵은선 40%, 얇은선 20%, 간격 40%
                vec![(0.4, -0.30), (0.2, 0.40)]
            }
            super::LineRenderType::ThinThickDouble => {
                // 얇은선(위)-굵은선(아래): 얇은선 20%, 굵은선 40%, 간격 40%
                vec![(0.2, -0.40), (0.4, 0.30)]
            }
            super::LineRenderType::ThinThickThinTriple => {
                // 얇은-굵은-얇은 삼중선: 15%, 30%, 15%, 간격 20%×2
                vec![(0.15, -0.425), (0.30, 0.0), (0.15, 0.425)]
            }
            _ => return,
        };

        for (width_ratio, offset_ratio) in &lines {
            let w = total_width * width_ratio;
            let off = total_width * offset_ratio;
            let ox = nx * off;
            let oy = ny * off;
            let dash_attr = Self::stroke_dasharray(dash, w)
                .map(|dasharray| format!(" stroke-dasharray=\"{}\"", dasharray))
                .unwrap_or_default();
            self.output.push_str(&format!(
                "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"{}\"{}/>\n",
                x1 + ox, y1 + oy, x2 + ox, y2 + oy, color, w, dash_attr,
            ));
        }
    }

    fn stroke_dasharray(dash: super::StrokeDash, stroke_width: f64) -> Option<String> {
        let values: &[f64] = match dash {
            super::StrokeDash::Solid => return None,
            super::StrokeDash::Dash => &[6.0, 3.0],
            super::StrokeDash::Dot => &[2.0, 2.0],
            super::StrokeDash::DashDot => &[6.0, 3.0, 2.0, 3.0],
            super::StrokeDash::DashDotDot => &[6.0, 3.0, 2.0, 3.0, 2.0, 3.0],
        };
        let scale = stroke_width.max(1.0);
        Some(
            values
                .iter()
                .map(|value| {
                    let scaled = value * scale;
                    if (scaled.fract()).abs() < 0.000_001 {
                        format!("{scaled:.0}")
                    } else {
                        format!("{scaled:.3}")
                    }
                })
                .collect::<Vec<_>>()
                .join(" "),
        )
    }

    /// 이미지 노드를 fill_mode에 따라 렌더링한다.
    fn render_image_node(&mut self, img: &ImageNode, bbox: &super::render_tree::BoundingBox) {
        let data = match img.data {
            Some(ref d) => d,
            None => {
                // 이미지 데이터가 없으면 플레이스홀더 표시
                self.output.push_str(&format!(
                    "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" fill=\"#cccccc\" stroke=\"#999999\" stroke-dasharray=\"4\"/>\n",
                    bbox.x, bbox.y, bbox.width, bbox.height,
                ));
                return;
            }
        };

        let tone_filter_id = self.ensure_brightness_contrast_filter(img.brightness, img.contrast);
        let effect_filter_id = self.ensure_image_effect_filter(img.effect);
        if let Some(ref fid) = tone_filter_id {
            self.output
                .push_str(&format!("<g filter=\"url(#{})\">\n", fid));
        }
        if let Some(ref fid) = effect_filter_id {
            self.output
                .push_str(&format!("<g filter=\"url(#{})\">\n", fid));
        }

        let (render_data, render_mime) = prepare_svg_image_data(data);

        let base64_data = base64::engine::general_purpose::STANDARD.encode(&*render_data);
        let data_uri = format!("data:{};base64,{}", render_mime, base64_data);

        let fill_mode = img.fill_mode.unwrap_or(ImageFillMode::FitToSize);
        let crop_viewbox = img.crop.and_then(|(cl, ct, cr, cb)| {
            let (img_w, img_h) = parse_image_dimensions(&render_data)?;
            let img_w = img_w as f64;
            let img_h = img_h as f64;
            let scale_x = cr as f64 / img_w;
            let scale_y = cb as f64 / img_h;
            if scale_x <= 0.0 || scale_y <= 0.0 {
                return None;
            }
            let src_x = cl as f64 / scale_x;
            let src_y = ct as f64 / scale_y;
            let src_w = (cr - cl) as f64 / scale_x;
            let src_h = (cb - ct) as f64 / scale_y;
            let is_cropped = src_x > 0.5
                || src_y > 0.5
                || (src_w - img_w).abs() > 1.0
                || (src_h - img_h).abs() > 1.0;
            if is_cropped && src_w > 0.0 && src_h > 0.0 {
                Some((src_x, src_y, src_w, src_h, img_w, img_h))
            } else {
                None
            }
        });

        match fill_mode {
            ImageFillMode::FitToSize => {
                // 그림 자르기: crop이 있으면 원본 이미지의 일부만 표시
                if let Some((src_x, src_y, src_w, src_h, img_w, img_h)) = crop_viewbox {
                    // SVG: 중첩 svg + viewBox로 crop 영역만 표시
                    self.output.push_str(&format!(
                        "<svg x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" viewBox=\"{} {} {} {}\" preserveAspectRatio=\"none\">\
                        <image width=\"{}\" height=\"{}\" preserveAspectRatio=\"none\" href=\"{}\"/></svg>\n",
                        bbox.x, bbox.y, bbox.width, bbox.height,
                        src_x, src_y, src_w, src_h,
                        img_w, img_h, data_uri,
                    ));
                } else {
                    self.output.push_str(&format!(
                        "<image x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" preserveAspectRatio=\"none\" href=\"{}\"/>\n",
                        bbox.x, bbox.y, bbox.width, bbox.height, data_uri,
                    ));
                }
            }
            ImageFillMode::TileAll => {
                // 바둑판식으로-모두: 원래 크기로 전체 타일링
                self.render_tiled_image(
                    &render_data,
                    &data_uri,
                    bbox,
                    true,
                    true,
                    img.original_size,
                    crop_viewbox,
                );
            }
            ImageFillMode::TileHorzTop | ImageFillMode::TileHorzBottom => {
                // 바둑판식으로-가로: 가로 방향만 타일링 (위 또는 아래 기준)
                self.render_tiled_image(
                    &render_data,
                    &data_uri,
                    bbox,
                    true,
                    false,
                    img.original_size,
                    crop_viewbox,
                );
            }
            ImageFillMode::TileVertLeft | ImageFillMode::TileVertRight => {
                // 바둑판식으로-세로: 세로 방향만 타일링 (왼쪽 또는 오른쪽 기준)
                self.render_tiled_image(
                    &render_data,
                    &data_uri,
                    bbox,
                    false,
                    true,
                    img.original_size,
                    crop_viewbox,
                );
            }
            _ => {
                // 배치 모드: 원래 크기대로 지정 위치에 배치
                self.render_positioned_image(
                    &render_data,
                    &data_uri,
                    bbox,
                    fill_mode,
                    img.original_size,
                    crop_viewbox,
                );
            }
        }

        if effect_filter_id.is_some() {
            self.output.push_str("</g>\n");
        }
        if tone_filter_id.is_some() {
            self.output.push_str("</g>\n");
        }
    }

    fn ensure_brightness_contrast_filter(
        &mut self,
        brightness: i8,
        contrast: i8,
    ) -> Option<String> {
        if brightness == 0 && contrast == 0 {
            return None;
        }
        let brightness_scale = (100.0 + brightness as f64) / 100.0;
        let contrast_scale = (100.0 + contrast as f64) / 100.0;
        let slope = brightness_scale * contrast_scale;
        let intercept = 128.0 * (1.0 - contrast_scale) / 255.0;
        let id = format!("rhwp-img-tone-b{brightness}-c{contrast}").replace('-', "m");
        let def = format!(
            "<filter id=\"{id}\"><feComponentTransfer>\
                <feFuncR type=\"linear\" slope=\"{slope:.6}\" intercept=\"{intercept:.6}\"/>\
                <feFuncG type=\"linear\" slope=\"{slope:.6}\" intercept=\"{intercept:.6}\"/>\
                <feFuncB type=\"linear\" slope=\"{slope:.6}\" intercept=\"{intercept:.6}\"/>\
            </feComponentTransfer></filter>\n"
        );
        if !self.defs.iter().any(|d| d == &def) {
            self.defs.push(def);
        }
        Some(id)
    }

    /// 그림 효과(ImageEffect)에 해당하는 SVG 필터를 defs에 보장하고 ID를 반환한다.
    /// RealPic(기본)은 필터가 필요 없으므로 None 반환.
    fn ensure_image_effect_filter(
        &mut self,
        effect: crate::model::image::ImageEffect,
    ) -> Option<String> {
        use crate::model::image::ImageEffect;
        let (id, def) = match effect {
            ImageEffect::RealPic => return None,
            ImageEffect::GrayScale => (
                "rhwp-img-grayscale",
                "<filter id=\"rhwp-img-grayscale\"><feColorMatrix type=\"matrix\" values=\"\
                    0.299 0.587 0.114 0 0 \
                    0.299 0.587 0.114 0 0 \
                    0.299 0.587 0.114 0 0 \
                    0 0 0 1 0\"/></filter>\n",
            ),
            ImageEffect::BlackWhite => (
                "rhwp-img-blackwhite",
                "<filter id=\"rhwp-img-blackwhite\">\
                    <feColorMatrix type=\"matrix\" values=\"\
                        0.299 0.587 0.114 0 0 \
                        0.299 0.587 0.114 0 0 \
                        0.299 0.587 0.114 0 0 \
                        0 0 0 1 0\"/>\
                    <feComponentTransfer>\
                        <feFuncR type=\"discrete\" tableValues=\"0 1\"/>\
                        <feFuncG type=\"discrete\" tableValues=\"0 1\"/>\
                        <feFuncB type=\"discrete\" tableValues=\"0 1\"/>\
                    </feComponentTransfer>\
                </filter>\n",
            ),
            // Pattern8x8은 SVG 필터로 표현하기 어려워 그레이스케일로 폴백
            ImageEffect::Pattern8x8 => (
                "rhwp-img-grayscale",
                "<filter id=\"rhwp-img-grayscale\"><feColorMatrix type=\"matrix\" values=\"\
                    0.299 0.587 0.114 0 0 \
                    0.299 0.587 0.114 0 0 \
                    0.299 0.587 0.114 0 0 \
                    0 0 0 1 0\"/></filter>\n",
            ),
        };
        let def_str = def.to_string();
        if !self.defs.iter().any(|d| d == &def_str) {
            self.defs.push(def_str);
        }
        Some(id.to_string())
    }

    /// 이미지를 원래 크기로 지정 위치에 배치 (배치 모드)
    fn render_positioned_image(
        &mut self,
        data: &[u8],
        data_uri: &str,
        bbox: &super::render_tree::BoundingBox,
        fill_mode: ImageFillMode,
        original_size: Option<(f64, f64)>,
        crop_viewbox: Option<(f64, f64, f64, f64, f64, f64)>,
    ) {
        // 원본 크기: HWP shape_attr 기반(우선) 또는 이미지 픽셀 크기(폴백)
        let (img_width, img_height) = if let Some((ow, oh)) = original_size {
            (ow, oh)
        } else {
            match parse_image_dimensions(data) {
                Some((w, h)) => (w as f64, h as f64),
                None => {
                    // 크기 파싱 실패 시 meet으로 폴백
                    let par = match fill_mode {
                        ImageFillMode::Center => "xMidYMid meet",
                        ImageFillMode::CenterTop => "xMidYMin meet",
                        ImageFillMode::CenterBottom => "xMidYMax meet",
                        ImageFillMode::LeftCenter => "xMinYMid meet",
                        ImageFillMode::LeftTop => "xMinYMin meet",
                        ImageFillMode::LeftBottom => "xMinYMax meet",
                        ImageFillMode::RightCenter => "xMaxYMid meet",
                        ImageFillMode::RightTop => "xMaxYMin meet",
                        ImageFillMode::RightBottom => "xMaxYMax meet",
                        _ => "xMidYMid meet",
                    };
                    self.output.push_str(&format!(
                        "<image x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" preserveAspectRatio=\"{}\" href=\"{}\"/>\n",
                        bbox.x, bbox.y, bbox.width, bbox.height, par, data_uri,
                    ));
                    return;
                }
            }
        };

        // 배치 위치 계산
        let (ix, iy) = match fill_mode {
            ImageFillMode::LeftTop => (bbox.x, bbox.y),
            ImageFillMode::CenterTop => (bbox.x + (bbox.width - img_width) / 2.0, bbox.y),
            ImageFillMode::RightTop => (bbox.x + bbox.width - img_width, bbox.y),
            ImageFillMode::LeftCenter => (bbox.x, bbox.y + (bbox.height - img_height) / 2.0),
            ImageFillMode::Center => (
                bbox.x + (bbox.width - img_width) / 2.0,
                bbox.y + (bbox.height - img_height) / 2.0,
            ),
            ImageFillMode::RightCenter => (
                bbox.x + bbox.width - img_width,
                bbox.y + (bbox.height - img_height) / 2.0,
            ),
            ImageFillMode::LeftBottom => (bbox.x, bbox.y + bbox.height - img_height),
            ImageFillMode::CenterBottom => (
                bbox.x + (bbox.width - img_width) / 2.0,
                bbox.y + bbox.height - img_height,
            ),
            ImageFillMode::RightBottom => (
                bbox.x + bbox.width - img_width,
                bbox.y + bbox.height - img_height,
            ),
            _ => (bbox.x, bbox.y),
        };

        // 도형 영역으로 클리핑
        let clip_id = format!("fill-clip-{}", self.next_clip_id());
        self.defs.push(format!(
            "<clipPath id=\"{}\"><rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\"/></clipPath>\n",
            clip_id, bbox.x, bbox.y, bbox.width, bbox.height,
        ));
        if let Some((src_x, src_y, src_w, src_h, natural_w, natural_h)) = crop_viewbox {
            self.output.push_str(&format!(
                "<g clip-path=\"url(#{})\"><svg x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" viewBox=\"{} {} {} {}\" preserveAspectRatio=\"none\">\
                 <image width=\"{}\" height=\"{}\" preserveAspectRatio=\"none\" href=\"{}\"/></svg></g>\n",
                clip_id, ix, iy, img_width, img_height, src_x, src_y, src_w, src_h, natural_w, natural_h, data_uri,
            ));
        } else {
            self.output.push_str(&format!(
                "<g clip-path=\"url(#{})\"><image x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" preserveAspectRatio=\"none\" href=\"{}\"/></g>\n",
                clip_id, ix, iy, img_width, img_height, data_uri,
            ));
        }
    }

    /// 이미지를 타일링 모드로 렌더링
    fn render_tiled_image(
        &mut self,
        data: &[u8],
        data_uri: &str,
        bbox: &super::render_tree::BoundingBox,
        tile_h: bool,
        tile_v: bool,
        original_size: Option<(f64, f64)>,
        crop_viewbox: Option<(f64, f64, f64, f64, f64, f64)>,
    ) {
        // 원본 크기: HWP shape_attr 기반(우선) 또는 이미지 픽셀 크기(폴백)
        let (img_width, img_height) = if let Some((ow, oh)) = original_size {
            (ow, oh)
        } else {
            match parse_image_dimensions(data) {
                Some((w, h)) => (w as f64, h as f64),
                None => {
                    // 크기 파싱 실패 시 전체 채우기로 폴백
                    self.output.push_str(&format!(
                        "<image x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" preserveAspectRatio=\"none\" href=\"{}\"/>\n",
                        bbox.x, bbox.y, bbox.width, bbox.height, data_uri,
                    ));
                    return;
                }
            }
        };

        let pat_id = format!("tile-pat-{}", self.next_clip_id());
        let pat_w = if tile_h { img_width } else { bbox.width };
        let pat_h = if tile_v { img_height } else { bbox.height };

        let pattern_image = if let Some((src_x, src_y, src_w, src_h, natural_w, natural_h)) =
            crop_viewbox
        {
            format!(
                "<svg width=\"{}\" height=\"{}\" viewBox=\"{} {} {} {}\" preserveAspectRatio=\"none\">\
                 <image width=\"{}\" height=\"{}\" preserveAspectRatio=\"none\" href=\"{}\"/></svg>",
                img_width, img_height, src_x, src_y, src_w, src_h, natural_w, natural_h, data_uri,
            )
        } else {
            format!(
                "<image width=\"{}\" height=\"{}\" preserveAspectRatio=\"none\" href=\"{}\"/>",
                img_width, img_height, data_uri,
            )
        };
        self.defs.push(format!(
            "<pattern id=\"{}\" x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" patternUnits=\"userSpaceOnUse\">{}\
             </pattern>\n",
            pat_id, bbox.x, bbox.y, pat_w, pat_h, pattern_image,
        ));
        self.output.push_str(&format!(
            "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" fill=\"url(#{})\"/>\n",
            bbox.x, bbox.y, bbox.width, bbox.height, pat_id,
        ));
    }

    /// 고유 클립/패턴 ID 생성
    fn next_clip_id(&mut self) -> u32 {
        self.clip_counter += 1;
        self.clip_counter
    }

    /// 글자겹침(CharOverlap) 렌더링
    ///
    /// 각 문자를 테두리 도형(원/사각형) 안에 중앙 배치하여 렌더링한다.
    /// border_type: 0=없음, 1=원, 2=반전원, 3=사각형, 4=반전사각형
    /// 반전: 도형 채움(검정) + 흰 글자, 일반: 도형 테두리(검정) + 검정 글자
    ///
    /// 다자리 PUA 숫자 (2~3자리): 모든 문자를 하나의 원/사각형 안에 합쳐서 렌더링.
    /// border_type=0이고 PUA 겹침 숫자이면 원형(circle)으로 자동 렌더링.
    /// 한컴 방식: 장평 조절로 좁은 숫자를 하나의 도형 안에 배치.
    fn draw_char_overlap(
        &mut self,
        text: &str,
        style: &TextStyle,
        overlap: &CharOverlapInfo,
        bbox_x: f64,
        bbox_y: f64,
        bbox_w: f64,
        bbox_h: f64,
    ) {
        let font_size = if style.font_size > 0.0 {
            style.font_size
        } else {
            12.0
        };
        let chars: Vec<char> = text.chars().collect();
        if chars.is_empty() {
            return;
        }

        // PUA 다자리 숫자 디코딩 시도
        if let Some(number_str) = decode_pua_overlap_number(&chars) {
            self.draw_char_overlap_combined(
                style,
                overlap,
                &number_str,
                bbox_x,
                bbox_y,
                bbox_w,
                bbox_h,
            );
            return;
        }

        let box_size = font_size;

        let is_reversed = overlap.border_type == 2 || overlap.border_type == 4;
        let is_circle = overlap.border_type == 1 || overlap.border_type == 2;
        let is_rect = overlap.border_type == 3 || overlap.border_type == 4;

        let size_ratio = char_overlap_inner_size_ratio(overlap.inner_char_size);
        let inner_font_size = font_size * size_ratio;

        let glyph_color = color_to_svg(style.color);
        let fill_color = if is_reversed { "#000000" } else { "none" };
        let stroke_color = if is_reversed {
            "#000000"
        } else {
            glyph_color.as_str()
        };
        let text_color = if is_reversed {
            "#FFFFFF"
        } else {
            glyph_color.as_str()
        };

        let font_family_str = Self::font_family_with_svg_fallbacks(&style.font_family);
        let mut font_attrs = format!(
            "font-family=\"{}\" font-size=\"{:.2}\"",
            escape_xml(&font_family_str),
            inner_font_size
        );
        if style.is_visually_bold() {
            font_attrs.push_str(" font-weight=\"bold\"");
        }
        if style.italic {
            font_attrs.push_str(" font-style=\"italic\"");
        }

        if chars.len() > 1 {
            let cx = bbox_x + bbox_w / 2.0;
            let cy = bbox_y + bbox_h / 2.0;

            if is_circle {
                let ry = box_size / 2.0;
                let rx = ry * 0.85;
                self.output.push_str(&format!(
                    "<ellipse cx=\"{:.2}\" cy=\"{:.2}\" rx=\"{:.2}\" ry=\"{:.2}\" fill=\"{}\" stroke=\"{}\" stroke-width=\"0.8\"/>\n",
                    cx, cy, rx, ry, fill_color, stroke_color,
                ));
            } else if is_rect {
                let rx = cx - box_size / 2.0;
                let ry = cy - box_size / 2.0;
                self.output.push_str(&format!(
                    "<rect x=\"{:.2}\" y=\"{:.2}\" width=\"{:.2}\" height=\"{:.2}\" fill=\"{}\" stroke=\"{}\" stroke-width=\"0.8\"/>\n",
                    rx, ry, box_size, box_size, fill_color, stroke_color,
                ));
            }

            for ch in chars.iter() {
                let display_str = {
                    let cp = *ch as u32;
                    if (0x2460..=0x2473).contains(&cp) {
                        format!("{}", cp - 0x2460 + 1)
                    } else if let Some(s) = pua_to_display_text(*ch) {
                        s
                    } else {
                        ch.to_string()
                    }
                };
                self.output.push_str(&format!(
                    "<text x=\"{:.2}\" y=\"{:.2}\" fill=\"{}\" {} text-anchor=\"middle\" dominant-baseline=\"central\">{}</text>\n",
                    cx, cy, text_color, font_attrs, escape_xml(&display_str),
                ));
            }
            return;
        }

        for (i, ch) in chars.iter().enumerate() {
            let display_str = {
                let cp = *ch as u32;
                if (0x2460..=0x2473).contains(&cp) {
                    format!("{}", cp - 0x2460 + 1)
                } else if let Some(s) = pua_to_display_text(*ch) {
                    s
                } else {
                    ch.to_string()
                }
            };

            let cx = bbox_x + i as f64 * box_size + box_size / 2.0;
            let cy = bbox_y + bbox_h / 2.0;

            if is_circle {
                let ry = box_size / 2.0;
                let rx = ry * 0.85;
                self.output.push_str(&format!(
                    "<ellipse cx=\"{:.2}\" cy=\"{:.2}\" rx=\"{:.2}\" ry=\"{:.2}\" fill=\"{}\" stroke=\"{}\" stroke-width=\"0.8\"/>\n",
                    cx, cy, rx, ry, fill_color, stroke_color,
                ));
            } else if is_rect {
                let rx = cx - box_size / 2.0;
                let ry = cy - box_size / 2.0;
                self.output.push_str(&format!(
                    "<rect x=\"{:.2}\" y=\"{:.2}\" width=\"{:.2}\" height=\"{:.2}\" fill=\"{}\" stroke=\"{}\" stroke-width=\"0.8\"/>\n",
                    rx, ry, box_size, box_size, fill_color, stroke_color,
                ));
            }

            self.output.push_str(&format!(
                "<text x=\"{:.2}\" y=\"{:.2}\" fill=\"{}\" {} text-anchor=\"middle\" dominant-baseline=\"central\">{}</text>\n",
                cx, cy, text_color, font_attrs, escape_xml(&display_str),
            ));
        }
    }

    /// PUA 다자리 숫자를 하나의 도형 안에 합쳐서 렌더링
    ///
    /// border_type=0이면 원형으로 자동 렌더링 (PUA 겹침 숫자는 원래 원문자)
    /// 장평 조절: textLength 속성으로 숫자 문자열을 도형 내부 폭에 맞춤
    fn draw_char_overlap_combined(
        &mut self,
        style: &TextStyle,
        overlap: &CharOverlapInfo,
        number_str: &str,
        bbox_x: f64,
        bbox_y: f64,
        bbox_w: f64,
        bbox_h: f64,
    ) {
        let font_size = if style.font_size > 0.0 {
            style.font_size
        } else {
            12.0
        };
        let box_size = font_size;

        // border_type=0이고 PUA 숫자이면 원형으로 자동 렌더링
        let effective_border = if overlap.border_type == 0 {
            1u8
        } else {
            overlap.border_type
        };
        let is_reversed = effective_border == 2 || effective_border == 4;
        let is_circle = effective_border == 1 || effective_border == 2;
        let is_rect = effective_border == 3 || effective_border == 4;

        let size_ratio = char_overlap_inner_size_ratio(overlap.inner_char_size);
        let inner_font_size = font_size * size_ratio;

        let glyph_color = color_to_svg(style.color);
        let fill_color = if is_reversed { "#000000" } else { "none" };
        let stroke_color = if is_reversed {
            "#000000"
        } else {
            glyph_color.as_str()
        };
        let text_color = if is_reversed {
            "#FFFFFF"
        } else {
            glyph_color.as_str()
        };

        let font_family_str = Self::font_family_with_svg_fallbacks(&style.font_family);
        let mut font_attrs = format!(
            "font-family=\"{}\" font-size=\"{:.2}\"",
            escape_xml(&font_family_str),
            inner_font_size
        );
        if style.is_visually_bold() {
            font_attrs.push_str(" font-weight=\"bold\"");
        }
        if style.italic {
            font_attrs.push_str(" font-style=\"italic\"");
        }

        let cx = bbox_x + box_size / 2.0;
        let cy = bbox_y + bbox_h / 2.0;

        if is_circle {
            let ry = box_size / 2.0;
            let rx = ry * 0.85;
            self.output.push_str(&format!(
                "<ellipse cx=\"{:.2}\" cy=\"{:.2}\" rx=\"{:.2}\" ry=\"{:.2}\" fill=\"{}\" stroke=\"{}\" stroke-width=\"0.8\"/>\n",
                cx, cy, rx, ry, fill_color, stroke_color,
            ));
        } else if is_rect {
            let rx = cx - box_size / 2.0;
            let ry = cy - box_size / 2.0;
            self.output.push_str(&format!(
                "<rect x=\"{:.2}\" y=\"{:.2}\" width=\"{:.2}\" height=\"{:.2}\" fill=\"{}\" stroke=\"{}\" stroke-width=\"0.8\"/>\n",
                rx, ry, box_size, box_size, fill_color, stroke_color,
            ));
        }

        // 장평 조절: 숫자 자릿수에 따라 textLength로 폭 압축
        let text_width = box_size * 0.7; // 도형 내부 여백 고려
                                         // 다자리 숫자는 baseline을 살짝 올려 시각적 중앙 맞춤
        let text_y = cy - font_size * 0.08;
        self.output.push_str(&format!(
            "<text x=\"{:.2}\" y=\"{:.2}\" fill=\"{}\" {} text-anchor=\"middle\" dominant-baseline=\"central\" textLength=\"{:.2}\" lengthAdjust=\"spacingAndGlyphs\">{}</text>\n",
            cx, text_y, text_color, font_attrs, text_width, escape_xml(number_str),
        ));
    }

    /// 선 모양(shape)에 따라 SVG line/group을 출력한다.
    /// shape: 0=실선, 1=긴점선, 2=점선, 3=일점쇄선, 4=이점쇄선, 5=긴파선,
    ///        6=원형점, 7=이중선, 8=가는+굵은, 9=굵은+가는, 10=삼중선
    fn draw_line_shape(&mut self, x1: f64, y1: f64, x2: f64, y2: f64, color: &str, shape: u8) {
        match shape {
            7 => {
                // 이중선
                self.output.push_str(&format!(
                    "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.7\"/>\n",
                    x1, y1 - 1.0, x2, y2 - 1.0, color));
                self.output.push_str(&format!(
                    "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.7\"/>\n",
                    x1, y1 + 1.0, x2, y2 + 1.0, color));
            }
            8 => {
                // 가는+굵은 이중선
                self.output.push_str(&format!(
                    "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.5\"/>\n",
                    x1, y1 - 1.2, x2, y2 - 1.2, color));
                self.output.push_str(&format!(
                    "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"1.2\"/>\n",
                    x1, y1 + 0.8, x2, y2 + 0.8, color));
            }
            9 => {
                // 굵은+가는 이중선
                self.output.push_str(&format!(
                    "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"1.2\"/>\n",
                    x1, y1 - 0.8, x2, y2 - 0.8, color));
                self.output.push_str(&format!(
                    "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.5\"/>\n",
                    x1, y1 + 1.2, x2, y2 + 1.2, color));
            }
            10 => {
                // 삼중선
                self.output.push_str(&format!(
                    "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.5\"/>\n",
                    x1, y1 - 1.5, x2, y2 - 1.5, color));
                self.output.push_str(&format!(
                    "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.5\"/>\n",
                    x1, y1, x2, y2, color));
                self.output.push_str(&format!(
                    "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"0.5\"/>\n",
                    x1, y1 + 1.5, x2, y2 + 1.5, color));
            }
            11 => {
                // 물결선
                let wave_h = 1.5;
                let wave_w = 6.0;
                let mut d = format!("M{:.2},{:.2}", x1, y1);
                let mut cx = x1;
                let mut up = true;
                while cx < x2 {
                    let next = (cx + wave_w).min(x2);
                    let cy = if up { y1 - wave_h } else { y1 + wave_h };
                    d.push_str(&format!(
                        " Q{:.2},{:.2} {:.2},{:.2}",
                        (cx + next) / 2.0,
                        cy,
                        next,
                        y1
                    ));
                    cx = next;
                    up = !up;
                }
                self.output.push_str(&format!(
                    "<path d=\"{}\" fill=\"none\" stroke=\"{}\" stroke-width=\"0.7\"/>\n",
                    d, color
                ));
            }
            12 => {
                // 이중물결선
                for offset in [-1.0f64, 1.0] {
                    let wy = y1 + offset;
                    let wave_h = 1.2;
                    let wave_w = 6.0;
                    let mut d = format!("M{:.2},{:.2}", x1, wy);
                    let mut cx = x1;
                    let mut up = true;
                    while cx < x2 {
                        let next = (cx + wave_w).min(x2);
                        let cy = if up { wy - wave_h } else { wy + wave_h };
                        d.push_str(&format!(
                            " Q{:.2},{:.2} {:.2},{:.2}",
                            (cx + next) / 2.0,
                            cy,
                            next,
                            wy
                        ));
                        cx = next;
                        up = !up;
                    }
                    self.output.push_str(&format!(
                        "<path d=\"{}\" fill=\"none\" stroke=\"{}\" stroke-width=\"0.5\"/>\n",
                        d, color
                    ));
                }
            }
            _ => {
                // 단선 (dasharray로 모양 표현)
                // 0=실선, 1=파선, 2=점선, 3=일점쇄선, 4=이점쇄선, 5=긴파선, 6=원형점선
                let dasharray = match shape {
                    1 => " stroke-dasharray=\"3 3\"",
                    2 => " stroke-dasharray=\"1 2\"",
                    3 => " stroke-dasharray=\"6 2 1 2\"",
                    4 => " stroke-dasharray=\"6 2 1 2 1 2\"",
                    5 => " stroke-dasharray=\"8 4\"",
                    6 => " stroke-dasharray=\"0.1 2.5\" stroke-linecap=\"round\"",
                    _ => "", // 0=실선
                };
                self.output.push_str(&format!(
                    "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"1\"{}/>\n",
                    x1, y1, x2, y2, color, dasharray));
            }
        }
    }

    /// 양식 개체 SVG 렌더링
    fn render_layer_form_object(&mut self, form: &LayerFormObjectPaint, bbox: &BoundingBox) {
        let x = bbox.x;
        let y = bbox.y;
        let w = bbox.width;
        let h = bbox.height;
        let fore_color = if form.fore_color.is_empty() {
            "#000000"
        } else {
            form.fore_color.as_str()
        };
        let back_color = if form.back_color.is_empty() {
            "white"
        } else {
            form.back_color.as_str()
        };
        let control_text = if form.enabled { fore_color } else { "#808080" };
        let border_color = if form.enabled { "#a0a0a0" } else { "#bebebe" };
        let choice_border_color = if form.enabled { "#606060" } else { "#bebebe" };

        match form.form_type {
            FormType::PushButton => {
                // 3D 버튼 (웹 환경 비활성 — 회색 스타일)
                let button_fill = if form.back_color.is_empty() {
                    "#d0d0d0"
                } else {
                    back_color
                };
                self.output.push_str(&format!(
                    "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" fill=\"{}\" stroke=\"{}\" stroke-width=\"0.5\"/>\n",
                    x, y, w, h, button_fill, border_color));
                // 캡션 텍스트 (회색, 중앙)
                if !form.caption.is_empty() {
                    let caption = display_form_caption(&form.caption);
                    let font_size = (h * 0.55).min(12.0).max(7.0);
                    self.output.push_str(&format!(
                        "<text x=\"{}\" y=\"{}\" font-size=\"{:.1}\" fill=\"{}\" text-anchor=\"middle\" dominant-baseline=\"central\" font-family=\"'맑은 고딕',sans-serif\">{}</text>\n",
                        x + w / 2.0, y + h / 2.0, font_size, control_text, escape_xml(caption.as_ref())));
                }
            }
            FormType::CheckBox => {
                // 체크박스: □/☑ + 캡션
                let box_size = (h * 0.7).min(13.0);
                let box_y = y + (h - box_size) / 2.0;
                let box_x = x + 2.0;
                self.output.push_str(&format!(
                    "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" fill=\"{}\" stroke=\"{}\" stroke-width=\"0.8\"/>\n",
                    box_x, box_y, box_size, box_size, back_color, choice_border_color));
                if form.value != 0 {
                    // 체크 마크 (✓)
                    let cx = box_x + box_size * 0.2;
                    let cy = box_y + box_size * 0.55;
                    let mx = box_x + box_size * 0.45;
                    let my = box_y + box_size * 0.8;
                    let ex = box_x + box_size * 0.85;
                    let ey = box_y + box_size * 0.2;
                    self.output.push_str(&format!(
                        "<polyline points=\"{},{} {},{} {},{}\" fill=\"none\" stroke=\"{}\" stroke-width=\"1.5\"/>\n",
                        cx, cy, mx, my, ex, ey, control_text));
                }
                // 캡션
                if !form.caption.is_empty() {
                    let caption = display_form_caption(&form.caption);
                    let text_x = box_x + box_size + 3.0;
                    let font_size = (h * 0.55).min(12.0).max(7.0);
                    self.output.push_str(&format!(
                        "<text x=\"{}\" y=\"{}\" font-size=\"{:.1}\" fill=\"{}\" dominant-baseline=\"central\" font-family=\"'맑은 고딕',sans-serif\">{}</text>\n",
                        text_x, y + h / 2.0, font_size, control_text, escape_xml(caption.as_ref())));
                }
            }
            FormType::RadioButton => {
                // 라디오: ○/◉ + 캡션
                let r = (h * 0.3).min(6.5);
                let cx = x + 2.0 + r;
                let cy = y + h / 2.0;
                self.output.push_str(&format!(
                    "<circle cx=\"{}\" cy=\"{}\" r=\"{}\" fill=\"{}\" stroke=\"{}\" stroke-width=\"0.8\"/>\n",
                    cx, cy, r, back_color, choice_border_color));
                if form.value != 0 {
                    self.output.push_str(&format!(
                        "<circle cx=\"{}\" cy=\"{}\" r=\"{}\" fill=\"{}\"/>\n",
                        cx,
                        cy,
                        r * 0.5,
                        control_text
                    ));
                }
                // 캡션
                if !form.caption.is_empty() {
                    let caption = display_form_caption(&form.caption);
                    let text_x = cx + r + 3.0;
                    let font_size = (h * 0.55).min(12.0).max(7.0);
                    self.output.push_str(&format!(
                        "<text x=\"{}\" y=\"{}\" font-size=\"{:.1}\" fill=\"{}\" dominant-baseline=\"central\" font-family=\"'맑은 고딕',sans-serif\">{}</text>\n",
                        text_x, y + h / 2.0, font_size, control_text, escape_xml(caption.as_ref())));
                }
            }
            FormType::ComboBox => {
                // 콤보박스: 입력 영역 + 드롭다운 버튼(▼)
                let btn_w = (h * 0.8).min(16.0);
                self.output.push_str(&format!(
                    "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" fill=\"{}\" stroke=\"{}\" stroke-width=\"0.8\"/>\n",
                    x, y, w, h, back_color, border_color));
                // 드롭다운 버튼
                self.output.push_str(&format!(
                    "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" fill=\"#e0e0e0\" stroke=\"{}\" stroke-width=\"0.5\"/>\n",
                    x + w - btn_w, y, btn_w, h, border_color));
                // ▼ 화살표
                let arrow_cx = x + w - btn_w / 2.0;
                let arrow_cy = y + h / 2.0;
                let arrow_size = (h * 0.2).min(4.0);
                self.output.push_str(&format!(
                    "<polygon points=\"{},{} {},{} {},{}\" fill=\"{}\"/>\n",
                    arrow_cx - arrow_size,
                    arrow_cy - arrow_size * 0.5,
                    arrow_cx + arrow_size,
                    arrow_cy - arrow_size * 0.5,
                    arrow_cx,
                    arrow_cy + arrow_size * 0.5,
                    control_text
                ));
                // 텍스트
                if !form.text.is_empty() {
                    let font_size = (h * 0.55).min(12.0).max(7.0);
                    self.output.push_str(&format!(
                        "<text x=\"{}\" y=\"{}\" font-size=\"{:.1}\" fill=\"{}\" dominant-baseline=\"central\" font-family=\"'맑은 고딕',sans-serif\">{}</text>\n",
                        x + 3.0, y + h / 2.0, font_size, control_text, escape_xml(&form.text)));
                }
            }
            FormType::Edit => {
                // 입력 상자: 테두리 사각형 + 내부 텍스트
                self.output.push_str(&format!(
                    "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" fill=\"{}\" stroke=\"{}\" stroke-width=\"0.8\"/>\n",
                    x, y, w, h, back_color, border_color));
                if !form.text.is_empty() {
                    let font_size = (h * 0.55).min(12.0).max(7.0);
                    self.output.push_str(&format!(
                        "<text x=\"{}\" y=\"{}\" font-size=\"{:.1}\" fill=\"{}\" dominant-baseline=\"central\" font-family=\"'맑은 고딕',sans-serif\">{}</text>\n",
                        x + 3.0, y + h / 2.0, font_size, control_text, escape_xml(&form.text)));
                }
            }
        }
    }

    fn render_form_object(&mut self, form: &FormObjectNode, bbox: &BoundingBox) {
        let paint = LayerFormObjectPaint {
            form_type: form.form_type,
            caption: form.caption.clone(),
            text: form.text.clone(),
            fore_color: form.fore_color.clone(),
            back_color: form.back_color.clone(),
            value: form.value,
            enabled: form.enabled,
        };
        self.render_layer_form_object(&paint, bbox);
    }
    /// 디버그 오버레이: 문단/표 경계와 인덱스 라벨을 렌더링
    fn render_debug_overlay(&mut self) {
        self.output
            .push_str("<g id=\"debug-overlay\" opacity=\"0.7\">\n");

        // 색상 팔레트: 문단별 교대 색상
        let colors = [
            "#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4", "#FFEAA7", "#DDA0DD", "#98D8C8", "#F7DC6F",
        ];

        // 문단 경계 렌더링
        let mut sorted_paras: Vec<_> = self.overlay_para_bounds.iter().collect();
        sorted_paras.sort_by_key(|&(pi, _)| *pi);

        for (key, bounds) in &sorted_paras {
            let pi = **key % 100000;
            let si = bounds.section_index;
            let color = colors[pi % colors.len()];
            let label = format!("s{}:pi={} y={:.1}", si, pi, bounds.y);
            // 경계 사각형 (점선)
            self.output.push_str(&format!(
                "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" fill=\"none\" stroke=\"{}\" stroke-width=\"0.5\" stroke-dasharray=\"3,2\"/>\n",
                bounds.x, bounds.y, bounds.width, bounds.height, color,
            ));
            // 라벨 (좌측 상단)
            let label_w = label.len() as f64 * 5.0 + 4.0;
            self.output.push_str(&format!(
                "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"10\" fill=\"{}\" rx=\"2\"/>\n",
                bounds.x,
                bounds.y - 10.0,
                label_w,
                color,
            ));
            self.output.push_str(&format!(
                "<text x=\"{}\" y=\"{}\" font-family=\"monospace\" font-size=\"8\" fill=\"#fff\" font-weight=\"bold\">{}</text>\n",
                bounds.x + 2.0, bounds.y - 2.0, label,
            ));
        }

        // 표 경계 렌더링
        let table_bounds = std::mem::take(&mut self.overlay_table_bounds);
        for tbl in &table_bounds {
            // 표 경계 (빨간 점선)
            self.output.push_str(&format!(
                "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" fill=\"none\" stroke=\"#E74C3C\" stroke-width=\"1.0\" stroke-dasharray=\"5,3\"/>\n",
                tbl.x, tbl.y, tbl.width, tbl.height,
            ));
            // 표 라벨 (우측 상단)
            let label = format!(
                "s{}:pi={} ci={} {}x{} y={:.1}",
                tbl.section_index,
                tbl.para_index,
                tbl.control_index,
                tbl.row_count,
                tbl.col_count,
                tbl.y
            );
            let label_w = label.len() as f64 * 5.0 + 4.0;
            let label_x = (tbl.x + tbl.width - label_w).max(tbl.x);
            self.output.push_str(&format!(
                "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"11\" fill=\"#E74C3C\" rx=\"2\"/>\n",
                label_x,
                tbl.y - 11.0,
                label_w,
            ));
            self.output.push_str(&format!(
                "<text x=\"{}\" y=\"{}\" font-family=\"monospace\" font-size=\"8\" fill=\"#fff\" font-weight=\"bold\">{}</text>\n",
                label_x + 2.0, tbl.y - 2.0, label,
            ));
        }
        self.overlay_table_bounds = table_bounds;

        self.output.push_str("</g>\n");
    }
    fn font_family_with_svg_fallbacks(font_family: &str) -> String {
        if font_family.is_empty() {
            return "sans-serif".to_string();
        }
        let primary = Self::quote_svg_font_family(font_family);
        let fallback = super::generic_fallback(font_family);
        format!("{},{}", primary, fallback)
    }

    fn quote_svg_font_family(font_family: &str) -> String {
        match font_family {
            "serif" | "sans-serif" | "monospace" | "cursive" | "fantasy" | "system-ui" => {
                font_family.to_string()
            }
            _ => format!(
                "'{}'",
                font_family.replace('\\', "\\\\").replace('\'', "\\'")
            ),
        }
    }
}

fn text_sources_metadata_json(text_sources: &TextSourceTable) -> String {
    let mut buf = String::from("{\"textSources\":[");
    for (idx, entry) in text_sources.entries.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        write_text_source_entry_metadata_json(&mut buf, entry);
    }
    buf.push_str("]}");
    buf
}

fn write_text_source_entry_metadata_json(buf: &mut String, entry: &TextSourceEntry) {
    buf.push_str("{\"id\":");
    buf.push_str(&entry.id.0.to_string());
    buf.push_str(",\"text\":");
    write_json_string(buf, &entry.text);
    buf.push_str(",\"utf8Range\":");
    write_text_source_range_metadata_json(buf, entry.utf8_range);
    buf.push_str(",\"utf16Range\":");
    write_text_source_range_metadata_json(buf, entry.utf16_range);
    if let Some(stable_source_key) = &entry.stable_source_key {
        buf.push_str(",\"stableSourceKey\":{\"scheme\":");
        write_json_string(buf, stable_source_key);
        buf.push('}');
    }
    buf.push_str(",\"annotations\":[");
    for (idx, annotation) in entry.annotations.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        match annotation {
            crate::paint::TextSourceAnnotation::FieldMarker {
                marker,
                range_utf8,
                range_utf16,
            } => {
                buf.push_str("{\"type\":\"fieldMarker\",\"marker\":");
                write_json_string(buf, field_marker_metadata_str(*marker));
                buf.push_str(",\"rangeUtf8\":");
                write_text_source_range_metadata_json(buf, *range_utf8);
                buf.push_str(",\"rangeUtf16\":");
                write_text_source_range_metadata_json(buf, *range_utf16);
                buf.push('}');
            }
            crate::paint::TextSourceAnnotation::ParagraphEnd {
                offset_utf8,
                offset_utf16,
            } => {
                buf.push_str("{\"type\":\"paragraphEnd\",\"offsetUtf8\":");
                buf.push_str(&offset_utf8.to_string());
                buf.push_str(",\"offsetUtf16\":");
                buf.push_str(&offset_utf16.to_string());
                buf.push('}');
            }
            crate::paint::TextSourceAnnotation::LineBreakEnd {
                offset_utf8,
                offset_utf16,
            } => {
                buf.push_str("{\"type\":\"lineBreakEnd\",\"offsetUtf8\":");
                buf.push_str(&offset_utf8.to_string());
                buf.push_str(",\"offsetUtf16\":");
                buf.push_str(&offset_utf16.to_string());
                buf.push('}');
            }
        }
    }
    buf.push_str("]}");
}

fn write_text_source_range_metadata_json(buf: &mut String, range: crate::paint::TextSourceRange) {
    buf.push_str("{\"start\":");
    buf.push_str(&range.start.to_string());
    buf.push_str(",\"end\":");
    buf.push_str(&range.end.to_string());
    buf.push('}');
}

fn field_marker_metadata_str(
    marker: crate::renderer::render_tree::FieldMarkerType,
) -> &'static str {
    match marker {
        crate::renderer::render_tree::FieldMarkerType::None => "none",
        crate::renderer::render_tree::FieldMarkerType::FieldBegin => "fieldBegin",
        crate::renderer::render_tree::FieldMarkerType::FieldEnd => "fieldEnd",
        crate::renderer::render_tree::FieldMarkerType::FieldBeginEnd => "fieldBeginEnd",
        crate::renderer::render_tree::FieldMarkerType::ShapeMarker(_) => "shapeMarker",
    }
}

fn write_json_string(buf: &mut String, value: &str) {
    buf.push('"');
    for ch in value.chars() {
        match ch {
            '"' => buf.push_str("\\\""),
            '\\' => buf.push_str("\\\\"),
            '\n' => buf.push_str("\\n"),
            '\r' => buf.push_str("\\r"),
            '\t' => buf.push_str("\\t"),
            c if c < '\x20' => {
                let _ = std::fmt::Write::write_fmt(buf, format_args!("\\u{:04x}", c as u32));
            }
            c => buf.push(c),
        }
    }
    buf.push('"');
}

impl Renderer for SvgRenderer {
    fn begin_page(&mut self, width: f64, height: f64) {
        self.width = width;
        self.height = height;
        self.output.clear();
        self.defs.clear();
        self.gradient_counter = 0;
        self.arrow_marker_ids.clear();
        self.overlay_para_bounds.clear();
        self.overlay_table_bounds.clear();
        self.overlay_skip_depth = 0;
        self.overlay_page_section = -1;
        self.output.push_str(&format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" width=\"{}\" height=\"{}\" viewBox=\"0 0 {} {}\">\n",
            width, height, width, height,
        ));
        self.defs_insert_pos = self.output.len();
    }

    fn end_page(&mut self) {
        // 디버그 오버레이 출력
        if self.debug_overlay {
            self.render_debug_overlay();
        }

        if !self.defs.is_empty() {
            let mut defs_block = String::from("<defs>\n");
            for def in &self.defs {
                defs_block.push_str(def);
            }
            defs_block.push_str("</defs>\n");
            self.output.insert_str(self.defs_insert_pos, &defs_block);
        }
        self.output.push_str("</svg>\n");
    }

    fn draw_text(&mut self, text: &str, x: f64, y: f64, style: &TextStyle) {
        self.draw_text_with_positions(text, x, y, style, None);
    }

    fn draw_rect(
        &mut self,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        corner_radius: f64,
        style: &ShapeStyle,
    ) {
        self.draw_rect_with_gradient(x, y, w, h, corner_radius, style, None);
    }

    fn draw_line(&mut self, x1: f64, y1: f64, x2: f64, y2: f64, style: &LineStyle) {
        let color = color_to_svg(style.color);
        let width = if style.width > 0.0 { style.width } else { 1.0 };

        let dx = x2 - x1;
        let dy = y2 - y1;
        let line_len = (dx * dx + dy * dy).sqrt();

        // 화살표 머리 크기만큼 선 끝점 조정
        // 선이 화살표 머리 안으로 침범하지 않도록 줄임
        let mut lx1 = x1;
        let mut ly1 = y1;
        let mut lx2 = x2;
        let mut ly2 = y2;
        let mut marker_start_attr = String::new();
        let mut marker_end_attr = String::new();

        if line_len > 0.0 {
            let ux = dx / line_len; // 단위 벡터
            let uy = dy / line_len;

            if style.start_arrow != super::ArrowStyle::None {
                let (arrow_w, _) = Self::calc_arrow_dims(width, line_len, style.start_arrow_size);
                let marker_id = self.ensure_arrow_marker(
                    &color,
                    width,
                    line_len,
                    &style.start_arrow,
                    style.start_arrow_size,
                    true,
                );
                marker_start_attr = format!(" marker-start=\"url(#{})\"", marker_id);
                // 시작점을 화살표 길이만큼 전진
                lx1 += ux * arrow_w;
                ly1 += uy * arrow_w;
            }
            if style.end_arrow != super::ArrowStyle::None {
                let (arrow_w, _) = Self::calc_arrow_dims(width, line_len, style.end_arrow_size);
                let marker_id = self.ensure_arrow_marker(
                    &color,
                    width,
                    line_len,
                    &style.end_arrow,
                    style.end_arrow_size,
                    false,
                );
                marker_end_attr = format!(" marker-end=\"url(#{})\"", marker_id);
                // 끝점을 화살표 길이만큼 후퇴
                lx2 -= ux * arrow_w;
                ly2 -= uy * arrow_w;
            }
        }

        // 이중선/삼중선 처리: 여러 평행선으로 렌더링하되 화살표는 중앙선에 한 번만 붙인다.
        match style.line_type {
            super::LineRenderType::Double
            | super::LineRenderType::ThinThickDouble
            | super::LineRenderType::ThickThinDouble
            | super::LineRenderType::ThinThickThinTriple => {
                self.draw_multi_line(
                    lx1,
                    ly1,
                    lx2,
                    ly2,
                    width,
                    &color,
                    style.dash,
                    &style.line_type,
                );
                if !marker_start_attr.is_empty() || !marker_end_attr.is_empty() {
                    self.output.push_str(&format!(
                        "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"{}\" stroke-opacity=\"0\"{}{} />\n",
                        lx1, ly1, lx2, ly2, color, width, marker_start_attr, marker_end_attr,
                    ));
                }
                return;
            }
            _ => {}
        }

        let mut attrs = format!(
            "x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"{}\"",
            lx1, ly1, lx2, ly2, color, width,
        );
        if let Some(dasharray) = Self::stroke_dasharray(style.dash, width) {
            attrs.push_str(&format!(" stroke-dasharray=\"{}\"", dasharray));
        }
        attrs.push_str(&marker_start_attr);
        attrs.push_str(&marker_end_attr);
        self.output.push_str(&format!("<line {}/>\n", attrs));
    }

    fn draw_ellipse(&mut self, cx: f64, cy: f64, rx: f64, ry: f64, style: &ShapeStyle) {
        self.draw_ellipse_with_gradient(cx, cy, rx, ry, style, None);
    }

    fn draw_image(&mut self, _data: &[u8], x: f64, y: f64, w: f64, h: f64) {
        // TODO: Base64 인코딩 후 data URI 삽입
        self.output.push_str(&format!(
            "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" fill=\"#eeeeee\" stroke=\"#cccccc\"/>\n",
            x, y, w, h,
        ));
    }

    fn draw_path(&mut self, commands: &[PathCommand], style: &ShapeStyle) {
        self.draw_path_with_gradient(commands, style, None);
    }
}

/// COLORREF (BGR) → SVG 색상 문자열 변환
fn color_to_svg(color: u32) -> String {
    let b = (color >> 16) & 0xFF;
    let g = (color >> 8) & 0xFF;
    let r = color & 0xFF;
    format!("#{:02x}{:02x}{:02x}", r, g, b)
}

fn svg_path_data(commands: &[PathCommand]) -> String {
    let mut d = String::new();
    for command in commands {
        match command {
            PathCommand::MoveTo(x, y) => d.push_str(&format!("M{} {} ", x, y)),
            PathCommand::LineTo(x, y) => d.push_str(&format!("L{} {} ", x, y)),
            PathCommand::CurveTo(x1, y1, x2, y2, x, y) => {
                d.push_str(&format!("C{} {} {} {} {} {} ", x1, y1, x2, y2, x, y));
            }
            PathCommand::ArcTo(rx, ry, x_rot, large_arc, sweep, x, y) => {
                d.push_str(&format!(
                    "A{} {} {} {} {} {} {} ",
                    rx,
                    ry,
                    x_rot,
                    if *large_arc { 1 } else { 0 },
                    if *sweep { 1 } else { 0 },
                    x,
                    y
                ));
            }
            PathCommand::ClosePath => d.push_str("Z "),
        }
    }
    d
}

fn resolved_color_to_svg(color: &crate::paint::ResolvedColor) -> String {
    let channel = |component: f32| -> u8 { (component.clamp(0.0, 1.0) * 255.0).round() as u8 };
    format!(
        "#{:02x}{:02x}{:02x}",
        channel(color.rgba[0]),
        channel(color.rgba[1]),
        channel(color.rgba[2])
    )
}

fn resolved_color_opacity_attr(color: &crate::paint::ResolvedColor) -> String {
    let alpha = color.rgba[3].clamp(0.0, 1.0);
    if alpha < 1.0 {
        format!(" fill-opacity=\"{}\"", alpha)
    } else {
        String::new()
    }
}

fn colrv1_gradient_stops_to_svg(stops: &[crate::paint::ColorGradientStop]) -> String {
    let mut output = String::new();
    for stop in stops {
        let stop_opacity = stop.color.rgba[3].clamp(0.0, 1.0);
        let stop_opacity_attr = if stop_opacity < 1.0 {
            format!(" stop-opacity=\"{}\"", stop_opacity)
        } else {
            String::new()
        };
        output.push_str(&format!(
            "<stop offset=\"{}\" stop-color=\"{}\"{} />\n",
            stop.offset,
            resolved_color_to_svg(&stop.color),
            stop_opacity_attr,
        ));
    }
    output
}

fn compose_layer_affine_transform(
    parent: LayerAffineTransform,
    child: LayerAffineTransform,
) -> LayerAffineTransform {
    LayerAffineTransform {
        a: parent.a * child.a + parent.c * child.b,
        b: parent.b * child.a + parent.d * child.b,
        c: parent.a * child.c + parent.c * child.d,
        d: parent.b * child.c + parent.d * child.d,
        e: parent.a * child.e + parent.c * child.f + parent.e,
        f: parent.b * child.e + parent.d * child.f + parent.f,
    }
}

fn glyph_payload_svg_transform(
    run_to_page: LayerAffineTransform,
    transform_to_run: Option<LayerAffineTransform>,
) -> LayerAffineTransform {
    transform_to_run
        .map(|transform| compose_layer_affine_transform(run_to_page, transform))
        .unwrap_or(run_to_page)
}

fn glyph_payload_bbox_is_replayable(bbox: BoundingBox) -> bool {
    bbox.x.is_finite()
        && bbox.y.is_finite()
        && bbox.width.is_finite()
        && bbox.height.is_finite()
        && bbox.width > 0.0
        && bbox.height > 0.0
}

fn glyph_outline_paths_are_replayable(outline: &LayerGlyphOutlinePaint) -> bool {
    !outline.paths.is_empty()
        && outline.paths.iter().all(|path| {
            path.source_range_utf8.end >= path.source_range_utf8.start
                && path.glyph_range.end >= path.glyph_range.start
                && path_commands_are_finite(&path.commands)
        })
}

fn path_commands_are_finite(commands: &[PathCommand]) -> bool {
    !commands.is_empty()
        && commands.iter().all(|command| match *command {
            PathCommand::MoveTo(x, y) | PathCommand::LineTo(x, y) => x.is_finite() && y.is_finite(),
            PathCommand::CurveTo(x1, y1, x2, y2, x, y) => {
                [x1, y1, x2, y2, x, y].into_iter().all(f64::is_finite)
            }
            PathCommand::ArcTo(rx, ry, rotation, _, _, x, y) => {
                [rx, ry, rotation, x, y].into_iter().all(f64::is_finite)
            }
            PathCommand::ClosePath => true,
        })
}

fn svg_affine_matrix_transform(transform: LayerAffineTransform) -> String {
    format!(
        "matrix({} {} {} {} {} {})",
        transform.a, transform.b, transform.c, transform.d, transform.e, transform.f,
    )
}

/// XML 특수문자 이스케이프
fn escape_xml(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => result.push_str("&amp;"),
            '<' => result.push_str("&lt;"),
            '>' => result.push_str("&gt;"),
            '"' => result.push_str("&quot;"),
            '\'' => result.push_str("&apos;"),
            // XML 1.0 허용 문자: #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]
            // 그 외(제어문자, U+FFFE, U+FFFF 등)는 제거
            '\u{09}' | '\u{0A}' | '\u{0D}' => result.push(c),
            '\u{20}'..='\u{D7FF}' | '\u{E000}'..='\u{FFFD}' | '\u{10000}'..='\u{10FFFF}' => {
                result.push(c)
            }
            _ => {} // XML 무효 문자 제거
        }
    }
    result
}

/// WMF 바이트를 SVG로 변환한다. 실패 시 None 반환.
pub(crate) fn convert_wmf_to_svg(data: &[u8]) -> Option<Vec<u8>> {
    use crate::wmf::converter::{SVGPlayer, WMFConverter};
    let player = SVGPlayer::new();
    let converter = WMFConverter::new(data, player);
    converter.run().ok()
}

/// BMP bytes are re-encoded to PNG before embedding in SVG `<image>`.
///
/// Browser support for `data:image/bmp` inside SVG is inconsistent, while PNG
/// data URIs are broadly supported by SVG renderers.
pub(crate) fn bmp_bytes_to_png_bytes(data: &[u8]) -> Option<Vec<u8>> {
    use image::{load_from_memory_with_format, ImageFormat};
    use std::io::Cursor;

    let img = load_from_memory_with_format(data, ImageFormat::Bmp).ok()?;
    let mut out = Vec::new();
    img.write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
        .ok()?;
    Some(out)
}

fn prepare_svg_image_data(data: &[u8]) -> (std::borrow::Cow<'_, [u8]>, &'static str) {
    let mime_type = detect_image_mime_type(data);
    if mime_type == "image/x-wmf" {
        return match convert_wmf_to_svg(data) {
            Some(svg_bytes) => (std::borrow::Cow::Owned(svg_bytes), "image/svg+xml"),
            None => (std::borrow::Cow::Borrowed(data), mime_type),
        };
    }
    if mime_type == "image/bmp" {
        return match bmp_bytes_to_png_bytes(data) {
            Some(png_bytes) => (std::borrow::Cow::Owned(png_bytes), "image/png"),
            None => (std::borrow::Cow::Borrowed(data), mime_type),
        };
    }
    (std::borrow::Cow::Borrowed(data), mime_type)
}

fn svg_image_data_uri(data: &[u8]) -> String {
    let (render_data, render_mime) = prepare_svg_image_data(data);
    let base64_data = base64::engine::general_purpose::STANDARD.encode(&*render_data);
    format!("data:{};base64,{}", render_mime, base64_data)
}

/// 이미지 데이터에서 MIME 타입 감지
fn detect_image_mime_type(data: &[u8]) -> &'static str {
    if data.len() >= 8 {
        // PNG: 89 50 4E 47 0D 0A 1A 0A
        if data.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
            return "image/png";
        }
        // JPEG: FF D8 FF
        if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
            return "image/jpeg";
        }
        // GIF: GIF87a or GIF89a
        if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
            return "image/gif";
        }
        // BMP: BM
        if data.starts_with(&[0x42, 0x4D]) {
            return "image/bmp";
        }
        // WMF: Placeable (D7 CD C6 9A) 또는 Standard (01 00 09 00)
        if data.starts_with(&[0xD7, 0xCD, 0xC6, 0x9A])
            || data.starts_with(&[0x01, 0x00, 0x09, 0x00])
        {
            return "image/x-wmf";
        }
        // TIFF: II or MM
        if data.starts_with(&[0x49, 0x49, 0x2A, 0x00])
            || data.starts_with(&[0x4D, 0x4D, 0x00, 0x2A])
        {
            return "image/tiff";
        }
    }
    if super::svg_fragment::is_svg_prefix(data) {
        return "image/svg+xml";
    }
    // 알 수 없는 형식 → 기본값
    "application/octet-stream"
}

/// 이미지 데이터에서 픽셀 크기(width, height)를 파싱한다.
fn parse_image_dimensions(data: &[u8]) -> Option<(u32, u32)> {
    if data.len() < 24 {
        return None;
    }

    // PNG: IHDR 청크에서 크기 읽기 (바이트 16-23)
    if data.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
        let w = u32::from_be_bytes([data[16], data[17], data[18], data[19]]);
        let h = u32::from_be_bytes([data[20], data[21], data[22], data[23]]);
        return Some((w, h));
    }

    // JPEG: SOF 마커에서 크기 읽기
    if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        let mut i = 2;
        while i + 9 < data.len() {
            if data[i] != 0xFF {
                i += 1;
                continue;
            }
            let marker = data[i + 1];
            // SOF0-SOF3 (0xC0-0xC3), SOF5-SOF7 (0xC5-0xC7),
            // SOF9-SOF11 (0xC9-0xCB), SOF13-SOF15 (0xCD-0xCF)
            if (marker >= 0xC0 && marker <= 0xCF)
                && marker != 0xC4
                && marker != 0xC8
                && marker != 0xCC
            {
                let h = u16::from_be_bytes([data[i + 5], data[i + 6]]) as u32;
                let w = u16::from_be_bytes([data[i + 7], data[i + 8]]) as u32;
                if w > 0 && h > 0 {
                    return Some((w, h));
                }
            }
            let seg_len = u16::from_be_bytes([data[i + 2], data[i + 3]]) as usize;
            i += 2 + seg_len;
        }
        return None;
    }

    // GIF: 바이트 6-9
    if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        let w = u16::from_le_bytes([data[6], data[7]]) as u32;
        let h = u16::from_le_bytes([data[8], data[9]]) as u32;
        return Some((w, h));
    }

    // BMP: 바이트 18-25
    if data.starts_with(&[0x42, 0x4D]) && data.len() >= 26 {
        let w = u32::from_le_bytes([data[18], data[19], data[20], data[21]]);
        let h = i32::from_le_bytes([data[22], data[23], data[24], data[25]]);
        return Some((w, h.unsigned_abs()));
    }

    None
}

/// 폰트명 → local() 별칭 매핑 (한글명 + 영문명)
fn font_local_aliases(font_family: &str) -> Vec<&'static str> {
    match font_family {
        "함초롬바탕" => vec!["함초롬바탕", "HCR Batang"],
        "함초롬돋움" => vec!["함초롬돋움", "HCR Dotum"],
        "함초롱바탕" => vec!["함초롱바탕", "HCR Batang"],
        "함초롱돋움" => vec!["함초롱돋움", "HCR Dotum"],
        "한컴바탕" => vec!["한컴바탕", "함초롬바탕", "HCR Batang"],
        "한컴돋움" => vec!["한컴돋움", "함초롬돋움", "HCR Dotum"],
        "맑은 고딕" => vec!["맑은 고딕", "Malgun Gothic"],
        "바탕" => vec!["바탕", "Batang"],
        "돋움" => vec!["돋움", "Dotum"],
        "굴림" => vec!["굴림", "Gulim"],
        "굴림체" => vec!["굴림체", "GulimChe"],
        "바탕체" => vec!["바탕체", "BatangChe"],
        "궁서" => vec!["궁서", "Gungsuh"],
        "궁서체" => vec!["궁서체", "GungsuhChe"],
        _ => vec![],
    }
}

/// 폰트명 → 알려진 파일명 매핑 (HWP/한컴/MS 폰트)
fn known_font_filenames(font_name: &str) -> Vec<&'static str> {
    match font_name {
        "함초롬바탕" | "함초롱바탕" | "한컴바탕" => {
            vec!["hamchob-r.ttf", "HBATANG.TTF"]
        }
        "함초롬돋움" | "함초롱돋움" | "한컴돋움" => {
            vec!["hamchod-r.ttf", "HDOTUM.TTF"]
        }
        "HY헤드라인M" | "HYHeadLine M" => vec!["H2HDRM.TTF"],
        "HY견고딕" | "HYGothic-Extra" => vec!["HYGTRE.TTF"],
        "HY그래픽" | "HYGraphic-Medium" => vec!["HYGPRM.TTF"],
        "HY견명조" | "HYMyeongJo-Extra" => vec!["HYMJRE.TTF"],
        "HY신명조" => vec!["HYSNMJ.TTF", "hamchob-r.ttf"],
        "Latin Modern Math" => vec![
            "latinmodern-math.otf",
            "LatinModernMath-Regular.otf",
            "lmmath-regular.otf",
        ],
        "맑은 고딕" | "Malgun Gothic" => vec!["malgun.ttf", "MalgunGothic.ttf"],
        "바탕" | "Batang" => vec!["batang.ttc", "BATANG.TTC", "hamchob-r.ttf"],
        "돋움" | "Dotum" => vec!["dotum.ttc", "DOTUM.TTC", "hamchod-r.ttf"],
        "굴림" | "Gulim" => vec!["gulim.ttc", "GULIM.TTC", "hamchod-r.ttf"],
        "궁서" | "Gungsuh" => vec!["gungsuh.ttc", "GUNGSUH.TTC", "hamchob-r.ttf"],
        "굴림체" | "GulimChe" => vec!["gulim.ttc", "hamchod-r.ttf"],
        "바탕체" | "BatangChe" => vec!["batang.ttc", "hamchob-r.ttf"],
        "휴먼명조" => vec!["HYMJRE.TTF", "hamchob-r.ttf"],
        "새바탕" | "새돋움" | "새굴림" | "새궁서" => {
            vec!["hamchob-r.ttf", "hamchod-r.ttf"]
        }
        _ => vec![],
    }
}

/// 폰트명으로 TTF/OTF 파일을 탐색한다.
#[cfg(not(target_arch = "wasm32"))]
fn find_font_file(
    font_name: &str,
    extra_paths: &[std::path::PathBuf],
) -> Option<std::path::PathBuf> {
    use std::path::Path;

    // 폰트명 → 파일명 후보 생성
    let candidates: Vec<String> = {
        let mut files: Vec<String> = known_font_filenames(font_name)
            .iter()
            .map(|s| s.to_string())
            .collect();
        let aliases = font_local_aliases(font_name);
        let mut names = vec![font_name.to_string()];
        for a in &aliases {
            names.push(a.to_string());
        }
        for name in &names {
            let clean = name.replace(' ', "");
            files.push(format!("{}.ttf", name));
            files.push(format!("{}.otf", name));
            files.push(format!("{}.ttc", name));
            files.push(format!("{}.TTF", name));
            if clean != *name {
                files.push(format!("{}.ttf", clean));
                files.push(format!("{}.otf", clean));
                files.push(format!("{}.ttc", clean));
            }
        }
        files
    };

    // 탐색 경로 (우선순위 순)
    let mut search_dirs: Vec<std::path::PathBuf> = extra_paths.to_vec();
    for dir in &["ttfs/hwp", "ttfs/windows", "ttfs"] {
        search_dirs.push(Path::new(dir).to_path_buf());
    }
    // 시스템 폰트 경로
    #[cfg(target_os = "macos")]
    {
        search_dirs.push(Path::new("/Library/Fonts").to_path_buf());
        search_dirs.push(Path::new("/System/Library/Fonts").to_path_buf());
        search_dirs.push(Path::new("/System/Library/Fonts/Supplemental").to_path_buf());
    }
    #[cfg(target_os = "linux")]
    {
        search_dirs.push(Path::new("/usr/share/fonts").to_path_buf());
        search_dirs.push(Path::new("/usr/local/share/fonts").to_path_buf());
    }
    #[cfg(target_os = "windows")]
    {
        search_dirs.push(Path::new("C:\\Windows\\Fonts").to_path_buf());
    }
    // WSL Windows 폰트
    if Path::new("/mnt/c/Windows/Fonts").exists() {
        search_dirs.push(Path::new("/mnt/c/Windows/Fonts").to_path_buf());
    }

    for dir in &search_dirs {
        if !dir.exists() {
            continue;
        }
        for candidate in &candidates {
            let path = dir.join(candidate);
            if path.exists() {
                return Some(path);
            }
        }
    }
    None
}

/// SvgRenderer의 수집된 폰트 정보를 기반으로 @font-face CSS를 생성한다.
#[cfg(not(target_arch = "wasm32"))]
pub fn generate_font_style(renderer: &SvgRenderer, font_paths: &[std::path::PathBuf]) -> String {
    let codepoints = renderer.font_codepoints();
    if codepoints.is_empty() {
        return String::new();
    }

    let mut css = String::new();

    match renderer.font_embed_mode {
        FontEmbedMode::Style => {
            for font_name in codepoints.keys() {
                let aliases = font_local_aliases(font_name);
                let src = if aliases.is_empty() {
                    format!("local(\"{}\")", font_name)
                } else {
                    aliases
                        .iter()
                        .map(|a| format!("local(\"{}\")", a))
                        .collect::<Vec<_>>()
                        .join(", ")
                };
                css.push_str(&format!(
                    "@font-face {{ font-family: \"{}\"; src: {}; }}\n",
                    font_name, src,
                ));
            }
        }
        FontEmbedMode::Subset => {
            for (font_name, chars) in codepoints.iter() {
                if let Some(font_path) = find_font_file(font_name, font_paths) {
                    if let Ok(font_data) = std::fs::read(&font_path) {
                        // codepoint → glyph ID 변환 (ttf-parser cmap 사용)
                        let mut remapper = subsetter::GlyphRemapper::new();
                        if let Ok(face) = ttf_parser::Face::parse(&font_data, 0) {
                            // glyph 0 (.notdef) 항상 포함
                            remapper.remap(0);
                            for ch in chars {
                                if let Some(gid) = face.glyph_index(*ch) {
                                    remapper.remap(gid.0);
                                }
                            }
                        }
                        // 서브셋 추출
                        match subsetter::subset(&font_data, 0, &remapper) {
                            Ok(subset_data) => {
                                let b64 =
                                    base64::engine::general_purpose::STANDARD.encode(&subset_data);
                                css.push_str(&format!(
                                    "@font-face {{ font-family: \"{}\"; src: url(\"data:font/opentype;base64,{}\") format(\"opentype\"); }}\n",
                                    font_name, b64,
                                ));
                                eprintln!(
                                    "  [font-embed] {} → 서브셋 {:.1}KB ({}글자, 원본 {:.1}KB)",
                                    font_name,
                                    subset_data.len() as f64 / 1024.0,
                                    chars.len(),
                                    font_data.len() as f64 / 1024.0
                                );
                                continue;
                            }
                            Err(e) => {
                                eprintln!(
                                    "  [font-embed] {} 서브셋 실패: {} → local() 폴백",
                                    font_name, e
                                );
                            }
                        }
                    }
                }
                // 폰트 파일 없거나 서브셋 실패 → local() 폴백
                let aliases = font_local_aliases(font_name);
                let src = if aliases.is_empty() {
                    format!("local(\"{}\")", font_name)
                } else {
                    aliases
                        .iter()
                        .map(|a| format!("local(\"{}\")", a))
                        .collect::<Vec<_>>()
                        .join(", ")
                };
                css.push_str(&format!(
                    "@font-face {{ font-family: \"{}\"; src: {}; }}\n",
                    font_name, src,
                ));
            }
        }
        FontEmbedMode::Full => {
            for font_name in codepoints.keys() {
                if let Some(font_path) = find_font_file(font_name, font_paths) {
                    if let Ok(font_data) = std::fs::read(&font_path) {
                        let b64 = base64::engine::general_purpose::STANDARD.encode(&font_data);
                        css.push_str(&format!(
                            "@font-face {{ font-family: \"{}\"; src: url(\"data:font/opentype;base64,{}\") format(\"opentype\"); }}\n",
                            font_name, b64,
                        ));
                        eprintln!(
                            "  [font-embed] {} → 전체 {:.1}KB",
                            font_name,
                            font_data.len() as f64 / 1024.0
                        );
                        continue;
                    }
                }
                // 폰트 파일 없음 → local() 폴백
                let aliases = font_local_aliases(font_name);
                let src = if aliases.is_empty() {
                    format!("local(\"{}\")", font_name)
                } else {
                    aliases
                        .iter()
                        .map(|a| format!("local(\"{}\")", a))
                        .collect::<Vec<_>>()
                        .join(", ")
                };
                css.push_str(&format!(
                    "@font-face {{ font-family: \"{}\"; src: {}; }}\n",
                    font_name, src,
                ));
            }
        }
        FontEmbedMode::None => {}
    }

    css
}

#[cfg(test)]
mod tests;
