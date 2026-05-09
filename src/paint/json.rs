use std::fmt::Write as _;

use base64::Engine;

use crate::document_core::helpers::{color_ref_to_css, json_escape as raw_json_escape};
use crate::model::control::FormType;
use crate::model::image::ImageEffect;
use crate::model::style::{ImageFillMode, UnderlineType};
use crate::paint::{
    CacheHint, ClipKind, LayerNode, LayerNodeKind, LayerSemantic, LayerTextRunPaint, PageLayerTree,
    PaintOp, PaintTextStyle, ResourceArena, TextSourceAnnotation, TextSourceEntry, TextSourceRange,
    TextSourceSpan, TextSourceTable, LAYER_TREE_SCHEMA,
};
use crate::renderer::equation::ast::MatrixStyle;
use crate::renderer::equation::layout::{LayoutBox, LayoutKind};
use crate::renderer::equation::symbols::{DecoKind, FontStyleKind};
use crate::renderer::render_tree::{BoundingBox, FieldMarkerType, ShapeTransform};
use crate::renderer::{
    ArrowStyle, GradientFillInfo, LineRenderType, LineStyle, PathCommand, PatternFillInfo,
    ShadowStyle, ShapeStyle, StrokeDash, TabLeaderInfo, TextStyle,
};

impl PageLayerTree {
    pub fn to_json(&self) -> String {
        let mut buf = String::with_capacity(32_768);
        buf.push('{');
        let _ = write!(
            buf,
            "\"schemaVersion\":{},\"schemaMinorVersion\":{},\"schema\":{{\"major\":{},\"minor\":{}}},\"resourceTableVersion\":{},\"resourceTableMinorVersion\":{},\"resourceTable\":{{\"major\":{},\"minor\":{}}},\"unit\":{},\"coordinateSystem\":{},\"pageWidth\":{:.6},\"pageHeight\":{:.6},\"profile\":{},\"outputOptions\":{{\"showParagraphMarks\":{},\"showControlCodes\":{},\"showTransparentBorders\":{},\"clipEnabled\":{},\"debugOverlay\":{}}},\"buildOptions\":{{\"showTransparentBorders\":{}}},\"debugOptions\":{{\"debugOverlay\":{}}},\"debugCapabilities\":{{\"overlayPaint\":false,\"semanticBounds\":true,\"genericLayerExport\":{{\"overlayPaint\":false,\"semanticBounds\":true}},\"backends\":{{\"svgLayer\":{{\"overlayPaint\":true,\"semanticBounds\":true}},\"canvas2d\":{{\"overlayPaint\":false,\"semanticBounds\":true}},\"canvaskit\":{{\"overlayPaint\":false,\"semanticBounds\":true}},\"nativeSkia\":{{\"overlayPaint\":false,\"semanticBounds\":true}}}}}},\"root\":",
            LAYER_TREE_SCHEMA.schema_version,
            LAYER_TREE_SCHEMA.schema_minor_version,
            LAYER_TREE_SCHEMA.schema_version,
            LAYER_TREE_SCHEMA.schema_minor_version,
            LAYER_TREE_SCHEMA.resource_table_version,
            LAYER_TREE_SCHEMA.resource_table_minor_version,
            LAYER_TREE_SCHEMA.resource_table_version,
            LAYER_TREE_SCHEMA.resource_table_minor_version,
            json_escape(LAYER_TREE_SCHEMA.unit),
            json_escape(LAYER_TREE_SCHEMA.coordinate_system),
            self.page_width,
            self.page_height,
            json_escape(self.profile.as_str()),
            self.output_options.show_paragraph_marks,
            self.output_options.show_control_codes,
            self.output_options.show_transparent_borders,
            self.output_options.clip_enabled,
            self.output_options.debug_overlay,
            self.output_options.show_transparent_borders,
            self.output_options.debug_overlay,
        );
        let mut text_source_state = TextSourceExportState::default();
        self.root
            .write_json(&mut buf, &self.resources, &mut text_source_state);
        buf.push_str(",\"textSources\":");
        write_text_source_entries(&mut buf, &self.text_sources);
        buf.push_str(",\"usedFeatures\":[\"text.paintStyle\",\"text.sourceTable\",\"text.sourceSpan\"],\"optionalFeatures\":[],\"knownFeatures\":[\"fontResources\",\"text.glyphRun\",\"text.outlineGlyph\",\"text.specialVisualOps\",\"text.clusterPlacement\"],\"requiredFeatures\":[],\"text\":{\"defaultVariant\":\"textRun\",\"variants\":[\"textRun\"],\"sourceTextPreserved\":true,\"clusterEncoding\":[\"utf8\",\"utf16\"],\"fallbackRequired\":true}");
        buf.push('}');
        buf
    }
}

impl LayerNode {
    fn write_json(
        &self,
        buf: &mut String,
        resources: &ResourceArena,
        text_sources: &mut TextSourceExportState,
    ) {
        buf.push('{');
        buf.push_str("\"bounds\":");
        write_bbox(buf, self.bounds);
        if let Some(source_node_id) = self.source_node_id {
            let _ = write!(buf, ",\"sourceNodeId\":{}", source_node_id);
        }
        if self.semantic != LayerSemantic::default() {
            buf.push_str(",\"semantic\":{");
            let _ = write!(buf, "\"role\":{}", json_escape(self.semantic.role.as_str()));
            if let Some(section_index) = self.semantic.section_index {
                let _ = write!(buf, ",\"sectionIndex\":{}", section_index);
            }
            if let Some(column_index) = self.semantic.column_index {
                let _ = write!(buf, ",\"columnIndex\":{}", column_index);
            }
            if let Some(para_index) = self.semantic.para_index {
                let _ = write!(buf, ",\"paraIndex\":{}", para_index);
            }
            if let Some(control_index) = self.semantic.control_index {
                let _ = write!(buf, ",\"controlIndex\":{}", control_index);
            }
            if let Some(row_count) = self.semantic.row_count {
                let _ = write!(buf, ",\"rowCount\":{}", row_count);
            }
            if let Some(col_count) = self.semantic.col_count {
                let _ = write!(buf, ",\"colCount\":{}", col_count);
            }
            buf.push('}');
        }

        match &self.kind {
            LayerNodeKind::Group {
                children,
                cache_hint,
            } => {
                let _ = write!(
                    buf,
                    ",\"kind\":\"group\",\"cacheHint\":{},\"children\":[",
                    json_escape(cache_hint_str(*cache_hint))
                );
                for (idx, child) in children.iter().enumerate() {
                    if idx > 0 {
                        buf.push(',');
                    }
                    child.write_json(buf, resources, text_sources);
                }
                buf.push(']');
            }
            LayerNodeKind::ClipRect {
                clip,
                child,
                clip_kind,
                clip_policy,
            } => {
                buf.push_str(",\"kind\":\"clipRect\",\"clip\":");
                write_bbox(buf, *clip);
                let _ = write!(
                    buf,
                    ",\"clipKind\":{},\"clipPolicy\":{{\"rightOverflowSlop\":{},\"allowHorizontalOverflowControls\":{}}}",
                    json_escape(clip_kind_str(*clip_kind)),
                    clip_policy.right_overflow_slop,
                    clip_policy.allow_horizontal_overflow_controls
                );
                buf.push_str(",\"child\":");
                child.write_json(buf, resources, text_sources);
            }
            LayerNodeKind::Leaf { ops, cache_hint } => {
                let _ = write!(
                    buf,
                    ",\"kind\":\"leaf\",\"cacheHint\":{},\"ops\":[",
                    json_escape(cache_hint_str(*cache_hint))
                );
                for (idx, op) in ops.iter().enumerate() {
                    if idx > 0 {
                        buf.push(',');
                    }
                    op.write_json(buf, resources, text_sources);
                }
                buf.push(']');
            }
        }
        buf.push('}');
    }
}

impl PaintOp {
    fn write_json(
        &self,
        buf: &mut String,
        resources: &ResourceArena,
        text_sources: &mut TextSourceExportState,
    ) {
        match self {
            PaintOp::PageBackground { bbox, background } => {
                buf.push('{');
                buf.push_str("\"type\":\"pageBackground\",\"bbox\":");
                write_bbox(buf, *bbox);
                if let Some(color) = background.background_color {
                    let _ = write!(
                        buf,
                        ",\"backgroundColor\":{}",
                        json_escape(&color_ref_to_css(color))
                    );
                }
                if let Some(color) = background.border_color {
                    let _ = write!(
                        buf,
                        ",\"borderColor\":{}",
                        json_escape(&color_ref_to_css(color))
                    );
                }
                let _ = write!(buf, ",\"borderWidth\":{:.6}", background.border_width);
                if let Some(gradient) = &background.gradient {
                    buf.push_str(",\"gradient\":");
                    write_gradient(buf, gradient);
                }
                if let Some(image) = &background.image {
                    buf.push_str(",\"image\":{");
                    write_layer_image_fields(
                        buf,
                        resources,
                        Some(image.resource_id),
                        Some(image.fill_mode),
                        None,
                        None,
                        None,
                        false,
                    );
                    buf.push('}');
                }
                buf.push('}');
            }
            PaintOp::TextRun { bbox, run } => {
                buf.push('{');
                buf.push_str("\"type\":\"textRun\",\"bbox\":");
                write_bbox(buf, *bbox);
                let _ = write!(
                    buf,
                    ",\"text\":{},\"baseline\":{:.6},\"rotation\":{:.6},\"isVertical\":{},\"orientation\":{}",
                    json_escape(&run.text),
                    run.baseline,
                    run.rotation,
                    run.is_vertical,
                    json_escape(run.orientation.as_str()),
                );
                buf.push_str(",\"source\":");
                if let Some(source) = &run.source {
                    write_text_source_span(buf, source);
                } else {
                    write_legacy_text_source_span(buf, run, text_sources.next_id());
                }
                buf.push_str(",\"style\":");
                write_text_style(buf, &run.style);
                buf.push_str(",\"paintStyle\":");
                write_paint_text_style(buf, &PaintTextStyle::from(&run.style));
                buf.push_str(",\"positions\":");
                write_text_positions(buf, run);
                if !run.control_marks.is_empty() {
                    buf.push_str(",\"controlMarks\":");
                    write_text_control_marks(buf, run);
                }
                if let Some(overlap) = &run.char_overlap {
                    buf.push_str(",\"charOverlap\":");
                    write_char_overlap(buf, overlap);
                }
                let _ = write!(
                    buf,
                    ",\"fieldMarker\":{},\"isParaEnd\":{},\"isLineBreakEnd\":{}",
                    json_escape(field_marker_str(run.field_marker)),
                    run.is_para_end,
                    run.is_line_break_end,
                );
                if let FieldMarkerType::ShapeMarker(index) = run.field_marker {
                    let _ = write!(buf, ",\"shapeMarkerIndex\":{}", index);
                }
                if !run.style.tab_leaders.is_empty() {
                    buf.push_str(",\"tabLeaders\":");
                    write_tab_leaders(buf, &run.style.tab_leaders);
                }
                buf.push('}');
            }
            PaintOp::FootnoteMarker { bbox, marker } => {
                buf.push('{');
                buf.push_str("\"type\":\"footnoteMarker\",\"bbox\":");
                write_bbox(buf, *bbox);
                let _ = write!(
                    buf,
                    ",\"text\":{},\"fontFamily\":{},\"fontSize\":{:.6},\"color\":{}",
                    json_escape(&marker.text),
                    json_escape(&marker.font_family),
                    (marker.base_font_size * 0.55).max(7.0),
                    json_escape(&color_ref_to_css(marker.color)),
                );
                buf.push('}');
            }
            PaintOp::Line { bbox, line } => {
                buf.push('{');
                buf.push_str("\"type\":\"line\",\"bbox\":");
                write_bbox(buf, *bbox);
                let _ = write!(
                    buf,
                    ",\"x1\":{:.6},\"y1\":{:.6},\"x2\":{:.6},\"y2\":{:.6},\"style\":",
                    line.x1, line.y1, line.x2, line.y2
                );
                write_line_style(buf, &line.style);
                buf.push_str(",\"transform\":");
                write_transform(buf, line.transform);
                buf.push('}');
            }
            PaintOp::Rectangle { bbox, rect } => {
                buf.push('{');
                buf.push_str("\"type\":\"rectangle\",\"bbox\":");
                write_bbox(buf, *bbox);
                let _ = write!(
                    buf,
                    ",\"cornerRadius\":{:.6},\"style\":",
                    rect.corner_radius
                );
                write_shape_style(buf, &rect.style);
                if let Some(gradient) = &rect.gradient {
                    buf.push_str(",\"gradient\":");
                    write_gradient(buf, gradient);
                }
                buf.push_str(",\"transform\":");
                write_transform(buf, rect.transform);
                buf.push('}');
            }
            PaintOp::Ellipse { bbox, ellipse } => {
                buf.push('{');
                buf.push_str("\"type\":\"ellipse\",\"bbox\":");
                write_bbox(buf, *bbox);
                buf.push_str(",\"style\":");
                write_shape_style(buf, &ellipse.style);
                if let Some(gradient) = &ellipse.gradient {
                    buf.push_str(",\"gradient\":");
                    write_gradient(buf, gradient);
                }
                buf.push_str(",\"transform\":");
                write_transform(buf, ellipse.transform);
                buf.push('}');
            }
            PaintOp::Path { bbox, path } => {
                buf.push('{');
                buf.push_str("\"type\":\"path\",\"bbox\":");
                write_bbox(buf, *bbox);
                buf.push_str(",\"commands\":");
                write_path_commands(buf, &path.commands);
                buf.push_str(",\"style\":");
                write_shape_style(buf, &path.style);
                if let Some(gradient) = &path.gradient {
                    buf.push_str(",\"gradient\":");
                    write_gradient(buf, gradient);
                }
                if let Some((x1, y1, x2, y2)) = path.connector_endpoints {
                    let _ = write!(
                        buf,
                        ",\"connectorEndpoints\":{{\"x1\":{:.6},\"y1\":{:.6},\"x2\":{:.6},\"y2\":{:.6}}}",
                        x1, y1, x2, y2
                    );
                }
                if let Some(line_style) = &path.line_style {
                    buf.push_str(",\"lineStyle\":");
                    write_line_style(buf, line_style);
                }
                buf.push_str(",\"transform\":");
                write_transform(buf, path.transform);
                buf.push('}');
            }
            PaintOp::Image { bbox, image } => {
                buf.push('{');
                buf.push_str("\"type\":\"image\",\"bbox\":");
                write_bbox(buf, *bbox);
                write_layer_image_fields(
                    buf,
                    resources,
                    image.resource_id,
                    image.fill_mode,
                    image.original_size,
                    image.crop,
                    Some(image.effect),
                    true,
                );
                buf.push_str(",\"transform\":");
                write_transform(buf, image.transform);
                buf.push('}');
            }
            PaintOp::Equation { bbox, equation } => {
                buf.push('{');
                buf.push_str("\"type\":\"equation\",\"bbox\":");
                write_bbox(buf, *bbox);
                let _ = write!(
                    buf,
                    ",\"color\":{},\"fontSize\":{:.6},\"svgContent\":{},\"layoutBox\":",
                    json_escape(&equation.color_str),
                    equation.font_size,
                    json_escape(
                        resources
                            .svg_fragment(equation.svg_resource_id)
                            .unwrap_or("")
                    ),
                );
                write_equation_layout_box(buf, &equation.layout_box);
                buf.push('}');
            }
            PaintOp::FormObject { bbox, form } => {
                buf.push('{');
                buf.push_str("\"type\":\"formObject\",\"bbox\":");
                write_bbox(buf, *bbox);
                let _ = write!(
                    buf,
                    ",\"formType\":{},\"caption\":{},\"text\":{},\"foreColor\":{},\"backColor\":{},\"value\":{},\"enabled\":{}",
                    json_escape(form_type_str(form.form_type)),
                    json_escape(&form.caption),
                    json_escape(&form.text),
                    json_escape(&form.fore_color),
                    json_escape(&form.back_color),
                    form.value,
                    form.enabled,
                );
                buf.push('}');
            }
        }
    }
}

fn write_layer_image_fields(
    buf: &mut String,
    resources: &ResourceArena,
    resource_id: Option<crate::paint::ImageResourceId>,
    fill_mode: Option<ImageFillMode>,
    original_size: Option<(f64, f64)>,
    crop: Option<(i32, i32, i32, i32)>,
    effect: Option<ImageEffect>,
    leading_comma: bool,
) {
    let mut wrote_any = false;
    let mut push_prefix = |buf: &mut String| {
        if leading_comma || wrote_any {
            buf.push(',');
        }
        wrote_any = true;
    };

    if let Some(resource_id) = resource_id {
        if let Some(data) = resources.image_bytes(resource_id) {
            push_prefix(buf);
            let base64_data = base64::engine::general_purpose::STANDARD.encode(data);
            let _ = write!(buf, "\"base64\":{}", json_escape(&base64_data));
        }
    }
    if let Some(fill_mode) = fill_mode {
        push_prefix(buf);
        let _ = write!(
            buf,
            "\"fillMode\":{}",
            json_escape(image_fill_mode_str(fill_mode))
        );
    }
    if let Some((width, height)) = original_size {
        push_prefix(buf);
        let _ = write!(
            buf,
            "\"originalSize\":{{\"width\":{:.6},\"height\":{:.6}}}",
            width, height
        );
    }
    if let Some((left, top, right, bottom)) = crop {
        push_prefix(buf);
        let _ = write!(
            buf,
            "\"crop\":{{\"left\":{},\"top\":{},\"right\":{},\"bottom\":{}}}",
            left, top, right, bottom
        );
    }
    if let Some(effect) = effect {
        push_prefix(buf);
        let _ = write!(buf, "\"effect\":{}", json_escape(image_effect_str(effect)));
    }
}

fn write_bbox(buf: &mut String, bbox: BoundingBox) {
    let _ = write!(
        buf,
        "{{\"x\":{:.6},\"y\":{:.6},\"width\":{:.6},\"height\":{:.6}}}",
        bbox.x, bbox.y, bbox.width, bbox.height
    );
}

#[derive(Default)]
struct TextSourceExportState {
    next_id: u32,
}

impl TextSourceExportState {
    fn next_id(&mut self) -> u32 {
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        id
    }
}

fn write_text_source_entries(buf: &mut String, table: &TextSourceTable) {
    buf.push('[');
    for (idx, entry) in table.entries.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        write_text_source_entry(buf, entry);
    }
    buf.push(']');
}

fn write_text_source_entry(buf: &mut String, entry: &TextSourceEntry) {
    let _ = write!(
        buf,
        "{{\"id\":{},\"text\":{},\"utf8Range\":",
        entry.id.0,
        json_escape(&entry.text)
    );
    write_text_source_range(buf, entry.utf8_range);
    buf.push_str(",\"utf16Range\":");
    write_text_source_range(buf, entry.utf16_range);
    if let Some(stable_source_key) = &entry.stable_source_key {
        let _ = write!(
            buf,
            ",\"stableSourceKey\":{{\"scheme\":{}}}",
            json_escape(stable_source_key)
        );
    }
    buf.push_str(",\"annotations\":");
    write_text_source_annotations(buf, &entry.annotations);
    buf.push('}');
}

fn write_legacy_text_source_span(buf: &mut String, run: &LayerTextRunPaint, id: u32) {
    let utf8_end = run.text.len() as u32;
    let utf16_end = run.text.encode_utf16().count() as u32;
    let _ = write!(buf, "{{\"id\":{},\"utf8Range\":", id);
    write_text_source_range(buf, TextSourceRange::new(0, utf8_end));
    buf.push_str(",\"utf16Range\":");
    write_text_source_range(buf, TextSourceRange::new(0, utf16_end));
    buf.push('}');
}

fn write_text_source_span(buf: &mut String, span: &TextSourceSpan) {
    let _ = write!(buf, "{{\"id\":{},\"utf8Range\":", span.id.0);
    write_text_source_range(buf, span.utf8_range);
    buf.push_str(",\"utf16Range\":");
    write_text_source_range(buf, span.utf16_range);
    if let Some(stable_source_key) = &span.stable_source_key {
        let _ = write!(
            buf,
            ",\"stableSourceKey\":{{\"scheme\":{}}}",
            json_escape(stable_source_key)
        );
    }
    buf.push('}');
}

fn write_text_source_range(buf: &mut String, range: TextSourceRange) {
    let _ = write!(buf, "{{\"start\":{},\"end\":{}}}", range.start, range.end);
}

fn write_text_source_annotations(buf: &mut String, annotations: &[TextSourceAnnotation]) {
    buf.push('[');
    for (idx, annotation) in annotations.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        match annotation {
            TextSourceAnnotation::FieldMarker {
                marker,
                range_utf8,
                range_utf16,
            } => {
                let _ = write!(
                    buf,
                    "{{\"kind\":\"fieldMarker\",\"marker\":{},\"rangeUtf8\":",
                    json_escape(field_marker_str(*marker))
                );
                write_text_source_range(buf, *range_utf8);
                buf.push_str(",\"rangeUtf16\":");
                write_text_source_range(buf, *range_utf16);
                if let FieldMarkerType::ShapeMarker(index) = marker {
                    let _ = write!(buf, ",\"shapeMarkerIndex\":{}", index);
                }
                buf.push('}');
            }
            TextSourceAnnotation::ParagraphEnd {
                offset_utf8,
                offset_utf16,
            } => {
                let _ = write!(
                    buf,
                    "{{\"kind\":\"paragraphEnd\",\"offsetUtf8\":{},\"offsetUtf16\":{}}}",
                    offset_utf8, offset_utf16
                );
            }
            TextSourceAnnotation::LineBreakEnd {
                offset_utf8,
                offset_utf16,
            } => {
                let _ = write!(
                    buf,
                    "{{\"kind\":\"lineBreakEnd\",\"offsetUtf8\":{},\"offsetUtf16\":{}}}",
                    offset_utf8, offset_utf16
                );
            }
        }
    }
    buf.push(']');
}

fn write_text_style(buf: &mut String, style: &TextStyle) {
    write_paint_text_style(buf, &PaintTextStyle::from(style));
}

fn write_paint_text_style(buf: &mut String, style: &PaintTextStyle) {
    buf.push('{');
    let _ = write!(
        buf,
        "\"fontFamily\":{},\"fontSize\":{:.6},\"color\":{},\"bold\":{},\"italic\":{},\"ratio\":{:.6},\"underline\":{},\"underlineShape\":{},\"strikethrough\":{},\"strikeShape\":{},\"outlineType\":{},\"shadowType\":{},\"shadowColor\":{},\"shadowOffsetX\":{:.6},\"shadowOffsetY\":{:.6},\"emboss\":{},\"engrave\":{},\"emphasisDot\":{},\"underlineColor\":{},\"strikeColor\":{},\"shadeColor\":{}",
        json_escape(&style.font_family),
        style.font_size,
        json_escape(&color_ref_to_css(style.color)),
        style.bold,
        style.italic,
        style.ratio,
        json_escape(underline_type_str(style.underline)),
        style.underline_shape,
        style.strikethrough,
        style.strike_shape,
        style.outline_type,
        style.shadow_type,
        json_escape(&color_ref_to_css(style.shadow_color)),
        style.shadow_offset_x,
        style.shadow_offset_y,
        style.emboss,
        style.engrave,
        style.emphasis_dot,
        json_escape(&color_ref_to_css(style.underline_color)),
        json_escape(&color_ref_to_css(style.strike_color)),
        json_escape(&color_ref_to_css(style.shade_color)),
    );
    buf.push('}');
}

fn write_text_positions(buf: &mut String, run: &LayerTextRunPaint) {
    buf.push('[');
    for (idx, position) in run.positions.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        let _ = write!(buf, "{:.6}", position);
    }
    buf.push(']');
}

fn write_text_control_marks(buf: &mut String, run: &LayerTextRunPaint) {
    buf.push('[');
    for (idx, mark) in run.control_marks.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        let _ = write!(
            buf,
            "{{\"kind\":{},\"text\":{},\"x\":{:.6},\"y\":{:.6},\"fontSize\":{:.6}}}",
            json_escape(mark.kind.as_str()),
            json_escape(mark.kind.glyph()),
            mark.x,
            mark.y,
            mark.font_size,
        );
    }
    buf.push(']');
}

fn write_char_overlap(buf: &mut String, overlap: &crate::renderer::composer::CharOverlapInfo) {
    let _ = write!(
        buf,
        "{{\"borderType\":{},\"innerCharSize\":{}}}",
        overlap.border_type, overlap.inner_char_size,
    );
}

fn write_tab_leaders(buf: &mut String, leaders: &[TabLeaderInfo]) {
    buf.push('[');
    for (idx, leader) in leaders.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        let _ = write!(
            buf,
            "{{\"startX\":{:.6},\"endX\":{:.6},\"fillType\":{}}}",
            leader.start_x, leader.end_x, leader.fill_type
        );
    }
    buf.push(']');
}

fn write_shape_style(buf: &mut String, style: &ShapeStyle) {
    buf.push('{');
    if let Some(color) = style.fill_color {
        let _ = write!(
            buf,
            "\"fillColor\":{}",
            json_escape(&color_ref_to_css(color))
        );
    } else {
        buf.push_str("\"fillColor\":null");
    }
    if let Some(pattern) = &style.pattern {
        buf.push_str(",\"pattern\":");
        write_pattern_fill(buf, pattern);
    }
    if let Some(color) = style.stroke_color {
        let _ = write!(
            buf,
            ",\"strokeColor\":{}",
            json_escape(&color_ref_to_css(color))
        );
    } else {
        buf.push_str(",\"strokeColor\":null");
    }
    let _ = write!(
        buf,
        ",\"strokeWidth\":{:.6},\"strokeDash\":{},\"opacity\":{:.6}",
        style.stroke_width,
        json_escape(stroke_dash_str(style.stroke_dash)),
        style.opacity,
    );
    if let Some(shadow) = &style.shadow {
        buf.push_str(",\"shadow\":");
        write_shadow_style(buf, shadow);
    }
    buf.push('}');
}

fn write_pattern_fill(buf: &mut String, pattern: &PatternFillInfo) {
    let _ = write!(
        buf,
        "{{\"patternType\":{},\"patternColor\":{},\"backgroundColor\":{}}}",
        pattern.pattern_type,
        json_escape(&color_ref_to_css(pattern.pattern_color)),
        json_escape(&color_ref_to_css(pattern.background_color)),
    );
}

fn write_shadow_style(buf: &mut String, shadow: &ShadowStyle) {
    let _ = write!(
        buf,
        "{{\"shadowType\":{},\"color\":{},\"offsetX\":{:.6},\"offsetY\":{:.6},\"alpha\":{}}}",
        shadow.shadow_type,
        json_escape(&color_ref_to_css(shadow.color)),
        shadow.offset_x,
        shadow.offset_y,
        shadow.alpha,
    );
}

fn write_gradient(buf: &mut String, gradient: &GradientFillInfo) {
    buf.push('{');
    let _ = write!(
        buf,
        "\"gradientType\":{},\"angle\":{},\"centerX\":{},\"centerY\":{},\"colors\":[",
        gradient.gradient_type, gradient.angle, gradient.center_x, gradient.center_y,
    );
    for (idx, color) in gradient.colors.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        let css = color_ref_to_css(*color);
        buf.push_str(&json_escape(&css));
    }
    buf.push_str("],\"positions\":[");
    for (idx, position) in gradient.positions.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        let _ = write!(buf, "{:.6}", position);
    }
    buf.push_str("]}");
}

fn write_line_style(buf: &mut String, style: &LineStyle) {
    let _ = write!(
        buf,
        "{{\"color\":{},\"width\":{:.6},\"dash\":{},\"lineType\":{},\"startArrow\":{},\"endArrow\":{},\"startArrowSize\":{},\"endArrowSize\":{}",
        json_escape(&color_ref_to_css(style.color)),
        style.width,
        json_escape(stroke_dash_str(style.dash)),
        json_escape(line_render_type_str(style.line_type)),
        json_escape(arrow_style_str(style.start_arrow)),
        json_escape(arrow_style_str(style.end_arrow)),
        style.start_arrow_size,
        style.end_arrow_size,
    );
    if let Some(shadow) = &style.shadow {
        buf.push_str(",\"shadow\":");
        write_shadow_style(buf, shadow);
    }
    buf.push('}');
}

fn write_transform(buf: &mut String, transform: ShapeTransform) {
    let _ = write!(
        buf,
        "{{\"rotation\":{:.6},\"horzFlip\":{},\"vertFlip\":{}}}",
        transform.rotation, transform.horz_flip, transform.vert_flip
    );
}

fn write_path_commands(buf: &mut String, commands: &[PathCommand]) {
    buf.push('[');
    for (idx, command) in commands.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        match command {
            PathCommand::MoveTo(x, y) => {
                let _ = write!(buf, "{{\"type\":\"moveTo\",\"x\":{:.6},\"y\":{:.6}}}", x, y);
            }
            PathCommand::LineTo(x, y) => {
                let _ = write!(buf, "{{\"type\":\"lineTo\",\"x\":{:.6},\"y\":{:.6}}}", x, y);
            }
            PathCommand::CurveTo(x1, y1, x2, y2, x3, y3) => {
                let _ = write!(
                    buf,
                    "{{\"type\":\"curveTo\",\"x1\":{:.6},\"y1\":{:.6},\"x2\":{:.6},\"y2\":{:.6},\"x3\":{:.6},\"y3\":{:.6}}}",
                    x1, y1, x2, y2, x3, y3
                );
            }
            PathCommand::ArcTo(rx, ry, rotation, large_arc, sweep, x, y) => {
                let _ = write!(
                    buf,
                    "{{\"type\":\"arcTo\",\"rx\":{:.6},\"ry\":{:.6},\"rotation\":{:.6},\"largeArc\":{},\"sweep\":{},\"x\":{:.6},\"y\":{:.6}}}",
                    rx, ry, rotation, large_arc, sweep, x, y
                );
            }
            PathCommand::ClosePath => buf.push_str("{\"type\":\"closePath\"}"),
        }
    }
    buf.push(']');
}

fn write_equation_layout_box(buf: &mut String, layout: &LayoutBox) {
    let _ = write!(
        buf,
        "{{\"x\":{:.6},\"y\":{:.6},\"width\":{:.6},\"height\":{:.6},\"baseline\":{:.6},\"kind\":",
        layout.x, layout.y, layout.width, layout.height, layout.baseline,
    );
    write_equation_layout_kind(buf, &layout.kind);
    buf.push('}');
}

fn write_equation_layout_kind(buf: &mut String, kind: &LayoutKind) {
    match kind {
        LayoutKind::Row(children) => {
            buf.push_str("{\"type\":\"row\",\"children\":[");
            for (idx, child) in children.iter().enumerate() {
                if idx > 0 {
                    buf.push(',');
                }
                write_equation_layout_box(buf, child);
            }
            buf.push_str("]}");
        }
        LayoutKind::Text(text) => {
            let _ = write!(buf, "{{\"type\":\"text\",\"text\":{}}}", json_escape(text));
        }
        LayoutKind::Number(text) => {
            let _ = write!(
                buf,
                "{{\"type\":\"number\",\"text\":{}}}",
                json_escape(text)
            );
        }
        LayoutKind::Symbol(text) => {
            let _ = write!(
                buf,
                "{{\"type\":\"symbol\",\"text\":{}}}",
                json_escape(text)
            );
        }
        LayoutKind::MathSymbol(text) => {
            let _ = write!(
                buf,
                "{{\"type\":\"mathSymbol\",\"text\":{}}}",
                json_escape(text)
            );
        }
        LayoutKind::Function(name) => {
            let _ = write!(
                buf,
                "{{\"type\":\"function\",\"name\":{}}}",
                json_escape(name)
            );
        }
        LayoutKind::Fraction { numer, denom } => {
            buf.push_str("{\"type\":\"fraction\",\"numer\":");
            write_equation_layout_box(buf, numer);
            buf.push_str(",\"denom\":");
            write_equation_layout_box(buf, denom);
            buf.push('}');
        }
        LayoutKind::Sqrt { index, body } => {
            buf.push_str("{\"type\":\"sqrt\"");
            if let Some(index) = index {
                buf.push_str(",\"index\":");
                write_equation_layout_box(buf, index);
            }
            buf.push_str(",\"body\":");
            write_equation_layout_box(buf, body);
            buf.push('}');
        }
        LayoutKind::Superscript { base, sup } => {
            buf.push_str("{\"type\":\"superscript\",\"base\":");
            write_equation_layout_box(buf, base);
            buf.push_str(",\"sup\":");
            write_equation_layout_box(buf, sup);
            buf.push('}');
        }
        LayoutKind::Subscript { base, sub } => {
            buf.push_str("{\"type\":\"subscript\",\"base\":");
            write_equation_layout_box(buf, base);
            buf.push_str(",\"sub\":");
            write_equation_layout_box(buf, sub);
            buf.push('}');
        }
        LayoutKind::SubSup { base, sub, sup } => {
            buf.push_str("{\"type\":\"subSup\",\"base\":");
            write_equation_layout_box(buf, base);
            buf.push_str(",\"sub\":");
            write_equation_layout_box(buf, sub);
            buf.push_str(",\"sup\":");
            write_equation_layout_box(buf, sup);
            buf.push('}');
        }
        LayoutKind::BigOp { symbol, sub, sup } => {
            let _ = write!(
                buf,
                "{{\"type\":\"bigOp\",\"symbol\":{}",
                json_escape(symbol)
            );
            if let Some(sub) = sub {
                buf.push_str(",\"sub\":");
                write_equation_layout_box(buf, sub);
            }
            if let Some(sup) = sup {
                buf.push_str(",\"sup\":");
                write_equation_layout_box(buf, sup);
            }
            buf.push('}');
        }
        LayoutKind::Limit { is_upper, sub } => {
            let _ = write!(buf, "{{\"type\":\"limit\",\"isUpper\":{}", is_upper);
            if let Some(sub) = sub {
                buf.push_str(",\"sub\":");
                write_equation_layout_box(buf, sub);
            }
            buf.push('}');
        }
        LayoutKind::Matrix { cells, style } => {
            let _ = write!(
                buf,
                "{{\"type\":\"matrix\",\"style\":{},\"cells\":[",
                json_escape(matrix_style_str(*style))
            );
            for (row_idx, row) in cells.iter().enumerate() {
                if row_idx > 0 {
                    buf.push(',');
                }
                buf.push('[');
                for (cell_idx, cell) in row.iter().enumerate() {
                    if cell_idx > 0 {
                        buf.push(',');
                    }
                    write_equation_layout_box(buf, cell);
                }
                buf.push(']');
            }
            buf.push_str("]}");
        }
        LayoutKind::Rel { arrow, over, under } => {
            buf.push_str("{\"type\":\"rel\",\"arrow\":");
            write_equation_layout_box(buf, arrow);
            buf.push_str(",\"over\":");
            write_equation_layout_box(buf, over);
            if let Some(under) = under {
                buf.push_str(",\"under\":");
                write_equation_layout_box(buf, under);
            }
            buf.push('}');
        }
        LayoutKind::EqAlign { rows } => {
            buf.push_str("{\"type\":\"eqAlign\",\"rows\":[");
            for (idx, (left, right)) in rows.iter().enumerate() {
                if idx > 0 {
                    buf.push(',');
                }
                buf.push_str("{\"left\":");
                write_equation_layout_box(buf, left);
                buf.push_str(",\"right\":");
                write_equation_layout_box(buf, right);
                buf.push('}');
            }
            buf.push_str("]}");
        }
        LayoutKind::Paren { left, right, body } => {
            let _ = write!(
                buf,
                "{{\"type\":\"paren\",\"left\":{},\"right\":{},\"body\":",
                json_escape(left),
                json_escape(right),
            );
            write_equation_layout_box(buf, body);
            buf.push('}');
        }
        LayoutKind::Decoration { kind, body } => {
            let _ = write!(
                buf,
                "{{\"type\":\"decoration\",\"decoration\":{},\"body\":",
                json_escape(deco_kind_str(*kind))
            );
            write_equation_layout_box(buf, body);
            buf.push('}');
        }
        LayoutKind::FontStyle { style, body } => {
            let _ = write!(
                buf,
                "{{\"type\":\"fontStyle\",\"fontStyle\":{},\"body\":",
                json_escape(font_style_kind_str(*style))
            );
            write_equation_layout_box(buf, body);
            buf.push('}');
        }
        LayoutKind::Space(width) => {
            let _ = write!(buf, "{{\"type\":\"space\",\"width\":{:.6}}}", width);
        }
        LayoutKind::Newline => buf.push_str("{\"type\":\"newline\"}"),
        LayoutKind::Empty => buf.push_str("{\"type\":\"empty\"}"),
    }
}

fn underline_type_str(value: UnderlineType) -> &'static str {
    match value {
        UnderlineType::None => "none",
        UnderlineType::Bottom => "bottom",
        UnderlineType::Top => "top",
    }
}

fn stroke_dash_str(value: StrokeDash) -> &'static str {
    match value {
        StrokeDash::Solid => "solid",
        StrokeDash::Dash => "dash",
        StrokeDash::Dot => "dot",
        StrokeDash::DashDot => "dashDot",
        StrokeDash::DashDotDot => "dashDotDot",
    }
}

fn line_render_type_str(value: LineRenderType) -> &'static str {
    match value {
        LineRenderType::Single => "single",
        LineRenderType::Double => "double",
        LineRenderType::ThinThickDouble => "thinThickDouble",
        LineRenderType::ThickThinDouble => "thickThinDouble",
        LineRenderType::ThinThickThinTriple => "thinThickThinTriple",
    }
}

fn arrow_style_str(value: ArrowStyle) -> &'static str {
    match value {
        ArrowStyle::None => "none",
        ArrowStyle::Arrow => "arrow",
        ArrowStyle::ConcaveArrow => "concaveArrow",
        ArrowStyle::OpenDiamond => "openDiamond",
        ArrowStyle::OpenCircle => "openCircle",
        ArrowStyle::OpenSquare => "openSquare",
        ArrowStyle::Diamond => "diamond",
        ArrowStyle::Circle => "circle",
        ArrowStyle::Square => "square",
    }
}

fn matrix_style_str(value: MatrixStyle) -> &'static str {
    match value {
        MatrixStyle::Plain => "plain",
        MatrixStyle::Paren => "paren",
        MatrixStyle::Bracket => "bracket",
        MatrixStyle::Vert => "vert",
    }
}

fn deco_kind_str(value: DecoKind) -> &'static str {
    match value {
        DecoKind::Hat => "hat",
        DecoKind::Check => "check",
        DecoKind::Tilde => "tilde",
        DecoKind::Acute => "acute",
        DecoKind::Grave => "grave",
        DecoKind::Dot => "dot",
        DecoKind::DDot => "dDot",
        DecoKind::Bar => "bar",
        DecoKind::Vec => "vec",
        DecoKind::Dyad => "dyad",
        DecoKind::Under => "under",
        DecoKind::Arch => "arch",
        DecoKind::Underline => "underline",
        DecoKind::Overline => "overline",
        DecoKind::StrikeThrough => "strikeThrough",
    }
}

fn font_style_kind_str(value: FontStyleKind) -> &'static str {
    match value {
        FontStyleKind::Roman => "roman",
        FontStyleKind::Italic => "italic",
        FontStyleKind::Bold => "bold",
    }
}

fn image_fill_mode_str(value: ImageFillMode) -> &'static str {
    match value {
        ImageFillMode::TileAll => "tileAll",
        ImageFillMode::TileHorzTop => "tileHorzTop",
        ImageFillMode::TileHorzBottom => "tileHorzBottom",
        ImageFillMode::TileVertLeft => "tileVertLeft",
        ImageFillMode::TileVertRight => "tileVertRight",
        ImageFillMode::FitToSize => "fitToSize",
        ImageFillMode::Center => "center",
        ImageFillMode::CenterTop => "centerTop",
        ImageFillMode::CenterBottom => "centerBottom",
        ImageFillMode::LeftCenter => "leftCenter",
        ImageFillMode::LeftTop => "leftTop",
        ImageFillMode::LeftBottom => "leftBottom",
        ImageFillMode::RightCenter => "rightCenter",
        ImageFillMode::RightTop => "rightTop",
        ImageFillMode::RightBottom => "rightBottom",
        ImageFillMode::None => "none",
    }
}

fn image_effect_str(value: ImageEffect) -> &'static str {
    match value {
        ImageEffect::RealPic => "realPic",
        ImageEffect::GrayScale => "grayScale",
        ImageEffect::BlackWhite => "blackWhite",
        ImageEffect::Pattern8x8 => "pattern8x8",
    }
}

fn form_type_str(value: FormType) -> &'static str {
    match value {
        FormType::PushButton => "pushButton",
        FormType::CheckBox => "checkBox",
        FormType::RadioButton => "radioButton",
        FormType::ComboBox => "comboBox",
        FormType::Edit => "edit",
    }
}

fn clip_kind_str(value: ClipKind) -> &'static str {
    match value {
        ClipKind::Body => "body",
        ClipKind::TableCell => "tableCell",
        ClipKind::Generic => "generic",
    }
}

fn cache_hint_str(value: CacheHint) -> &'static str {
    match value {
        CacheHint::None => "none",
        CacheHint::StaticSubtree => "staticSubtree",
        CacheHint::PreferRaster => "preferRaster",
        CacheHint::PreferVectorRecording => "preferVectorRecording",
    }
}

fn field_marker_str(value: FieldMarkerType) -> &'static str {
    match value {
        FieldMarkerType::None => "none",
        FieldMarkerType::FieldBegin => "fieldBegin",
        FieldMarkerType::FieldEnd => "fieldEnd",
        FieldMarkerType::FieldBeginEnd => "fieldBeginEnd",
        FieldMarkerType::ShapeMarker(_) => "shapeMarker",
    }
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use super::*;
    use crate::model::image::ImageEffect;
    use crate::paint::{
        CacheHint, ClipKind, LayerEquationPaint, LayerImagePaint, LayerLinePaint, LayerNode,
        LayerOutputOptions, LayerPathPaint, LayerRectanglePaint, LayerTextControlMark,
        LayerTextControlMarkKind, LayerTextOrientation, LayerTextRunPaint, PageLayerTree,
        ResourceArena, LAYER_TREE_SCHEMA,
    };
    use crate::renderer::composer::CharOverlapInfo;

    #[test]
    fn serializes_schema_metadata_from_shared_contract() {
        let tree = PageLayerTree::new(
            40.0,
            40.0,
            LayerNode::leaf(BoundingBox::new(0.0, 0.0, 40.0, 40.0), None, vec![]),
        );

        let json = tree.to_json();
        assert!(json.contains(&format!(
            "\"schemaVersion\":{}",
            LAYER_TREE_SCHEMA.schema_version
        )));
        assert!(json.contains(&format!(
            "\"schemaMinorVersion\":{}",
            LAYER_TREE_SCHEMA.schema_minor_version
        )));
        assert!(json.contains(&format!(
            "\"schema\":{{\"major\":{},\"minor\":{}}}",
            LAYER_TREE_SCHEMA.schema_version, LAYER_TREE_SCHEMA.schema_minor_version
        )));
        assert!(json.contains(&format!(
            "\"resourceTableVersion\":{}",
            LAYER_TREE_SCHEMA.resource_table_version
        )));
        assert!(json.contains(&format!(
            "\"resourceTableMinorVersion\":{}",
            LAYER_TREE_SCHEMA.resource_table_minor_version
        )));
        assert!(json.contains(&format!(
            "\"resourceTable\":{{\"major\":{},\"minor\":{}}}",
            LAYER_TREE_SCHEMA.resource_table_version,
            LAYER_TREE_SCHEMA.resource_table_minor_version
        )));
        assert!(json.contains(&format!("\"unit\":\"{}\"", LAYER_TREE_SCHEMA.unit)));
        assert!(json.contains(&format!(
            "\"coordinateSystem\":\"{}\"",
            LAYER_TREE_SCHEMA.coordinate_system
        )));
        assert!(json.contains(
            "\"usedFeatures\":[\"text.paintStyle\",\"text.sourceTable\",\"text.sourceSpan\"]"
        ));
        assert!(json.contains("\"optionalFeatures\":[]"));
        assert!(json.contains("\"knownFeatures\":[\"fontResources\",\"text.glyphRun\",\"text.outlineGlyph\",\"text.specialVisualOps\",\"text.clusterPlacement\"]"));
        assert!(json.contains("\"requiredFeatures\":[]"));
        assert!(json.contains("\"text\":{\"defaultVariant\":\"textRun\",\"variants\":[\"textRun\"],\"sourceTextPreserved\":true,\"clusterEncoding\":[\"utf8\",\"utf16\"],\"fallbackRequired\":true}"));
    }

    #[test]
    fn serializes_text_and_shape_ops_for_browser_replay() {
        let mut resources = ResourceArena::default();
        let text = PaintOp::TextRun {
            bbox: BoundingBox::new(10.0, 20.0, 80.0, 18.0),
            run: LayerTextRunPaint {
                source: None,
                text: "가A".to_string(),
                style: TextStyle {
                    font_family: "Noto Sans KR".to_string(),
                    font_size: 16.0,
                    color: 0x00010203,
                    bold: true,
                    underline: UnderlineType::Bottom,
                    ..Default::default()
                },
                positions: vec![0.0, 16.0, 24.0],
                control_marks: vec![LayerTextControlMark {
                    kind: LayerTextControlMarkKind::ParagraphEnd,
                    x: 80.0,
                    y: 0.0,
                    font_size: 16.0,
                }],
                is_para_end: false,
                is_line_break_end: false,
                rotation: 0.0,
                is_vertical: false,
                orientation: LayerTextOrientation::Horizontal,
                char_overlap: Some(CharOverlapInfo {
                    border_type: 1,
                    inner_char_size: 90,
                }),
                baseline: 13.0,
                field_marker: Default::default(),
            },
        };
        let rect = PaintOp::Rectangle {
            bbox: BoundingBox::new(8.0, 18.0, 84.0, 22.0),
            rect: LayerRectanglePaint {
                corner_radius: 4.0,
                style: ShapeStyle {
                    fill_color: Some(0x00F0F1F2),
                    stroke_color: Some(0x00030405),
                    stroke_width: 1.5,
                    ..Default::default()
                },
                gradient: None,
                transform: ShapeTransform::default(),
            },
        };
        let equation = PaintOp::Equation {
            bbox: BoundingBox::new(12.0, 44.0, 40.0, 16.0),
            equation: LayerEquationPaint {
                svg_resource_id: resources.intern_svg_fragment("<text x=\"0\" y=\"12\">x</text>"),
                layout_box: crate::renderer::equation::layout::LayoutBox {
                    x: 0.0,
                    y: 0.0,
                    width: 10.0,
                    height: 12.0,
                    baseline: 9.0,
                    kind: crate::renderer::equation::layout::LayoutKind::Text("x".to_string()),
                },
                color_str: "#112233".to_string(),
                color: 0x00332211,
                font_size: 14.0,
            },
        };

        let tree = PageLayerTree::with_resources(
            120.0,
            80.0,
            LayerNode::leaf(
                BoundingBox::new(0.0, 0.0, 120.0, 80.0),
                None,
                vec![text, rect, equation],
            ),
            resources,
        );

        let json = tree.to_json();
        let positions_json = format!("\"positions\":[{:.6},{:.6},{:.6}]", 0.0, 16.0, 24.0);

        assert!(json.contains("\"kind\":\"leaf\""));
        assert!(json.contains("\"cacheHint\":\"none\""));
        assert!(json.contains("\"schemaVersion\":1"));
        assert!(json.contains("\"resourceTableVersion\":1"));
        assert!(json.contains("\"unit\":\"px\""));
        assert!(json.contains("\"coordinateSystem\":\"page-top-left-y-down\""));
        assert!(json.contains("\"profile\":\"screen\""));
        assert!(json.contains("\"outputOptions\":{"));
        assert!(json.contains("\"showParagraphMarks\":false"));
        assert!(json.contains("\"type\":\"textRun\""));
        assert!(json.contains("\"source\":{\"id\":0,\"utf8Range\":{\"start\":0,\"end\":4},\"utf16Range\":{\"start\":0,\"end\":2}}"));
        assert!(json.contains("\"textSources\":[{\"id\":0,\"text\":\"가A\",\"utf8Range\":{\"start\":0,\"end\":4},\"utf16Range\":{\"start\":0,\"end\":2},\"annotations\":[]}]"));
        assert!(json.contains(&positions_json));
        assert!(json.contains("\"style\":{\"fontFamily\":\"Noto Sans KR\""));
        assert!(json.contains("\"paintStyle\":{\"fontFamily\":\"Noto Sans KR\""));
        assert!(!json.contains("\"availableWidth\""));
        assert!(!json.contains("\"tabStops\""));
        assert!(json.contains("\"controlMarks\":[{\"kind\":\"paragraphEnd\",\"text\":\"↵\",\"x\":80.000000,\"y\":0.000000,\"fontSize\":16.000000}]"));
        assert!(json.contains("\"charOverlap\":{\"borderType\":1,\"innerCharSize\":90}"));
        assert!(json.contains("\"orientation\":\"horizontal\""));
        assert!(json.contains("\"fieldMarker\":\"none\""));
        assert!(json.contains("\"isParaEnd\":false"));
        assert!(json.contains("\"isLineBreakEnd\":false"));
        assert!(json.contains("\"type\":\"rectangle\""));
        assert!(json.contains("\"type\":\"equation\""));
        assert!(json.contains("\"svgContent\":\"<text x=\\\"0\\\" y=\\\"12\\\">x</text>\""));
        assert!(json.contains("\"layoutBox\":{\"x\":0.000000,\"y\":0.000000,\"width\":10.000000,\"height\":12.000000,\"baseline\":9.000000,\"kind\":{\"type\":\"text\",\"text\":\"x\"}}"));
        assert!(json.contains("\"cornerRadius\":4.000000"));
    }

    #[test]
    fn serializes_image_effect_for_backend_parity() {
        let mut resources = ResourceArena::default();
        let image_id = resources.intern_image_bytes(&[0x89, b'P', b'N', b'G']);
        let tree = PageLayerTree::with_resources(
            40.0,
            40.0,
            LayerNode::leaf(
                BoundingBox::new(0.0, 0.0, 40.0, 40.0),
                None,
                vec![PaintOp::Image {
                    bbox: BoundingBox::new(4.0, 4.0, 20.0, 20.0),
                    image: LayerImagePaint {
                        resource_id: Some(image_id),
                        fill_mode: Some(ImageFillMode::FitToSize),
                        original_size: Some((10.0, 10.0)),
                        crop: Some((0, 0, 10, 10)),
                        effect: ImageEffect::GrayScale,
                        transform: ShapeTransform::default(),
                    },
                }],
            ),
            resources,
        );

        let json = tree.to_json();
        assert!(json.contains("\"type\":\"image\""));
        assert!(json.contains("\"effect\":\"grayScale\""));
    }

    #[test]
    fn serializes_line_shadow_and_connector_arrow_metadata() {
        let line = PaintOp::Line {
            bbox: BoundingBox::new(0.0, 0.0, 24.0, 24.0),
            line: LayerLinePaint {
                x1: 2.0,
                y1: 4.0,
                x2: 22.0,
                y2: 20.0,
                style: LineStyle {
                    color: 0x000000ff,
                    width: 3.0,
                    dash: StrokeDash::Dash,
                    line_type: LineRenderType::ThinThickDouble,
                    start_arrow: ArrowStyle::Arrow,
                    end_arrow: ArrowStyle::OpenDiamond,
                    start_arrow_size: 2,
                    end_arrow_size: 5,
                    shadow: Some(ShadowStyle {
                        shadow_type: 1,
                        color: 0x00303030,
                        offset_x: 1.5,
                        offset_y: 2.5,
                        alpha: 64,
                    }),
                },
                transform: ShapeTransform::default(),
            },
        };

        let path_node = LayerPathPaint {
            commands: vec![
                PathCommand::MoveTo(4.0, 4.0),
                PathCommand::CurveTo(8.0, 4.0, 16.0, 20.0, 20.0, 20.0),
            ],
            style: ShapeStyle {
                stroke_color: Some(0x00010203),
                stroke_width: 2.0,
                ..Default::default()
            },
            gradient: None,
            transform: ShapeTransform::default(),
            connector_endpoints: Some((4.0, 4.0, 20.0, 20.0)),
            line_style: Some(LineStyle {
                color: 0x00010203,
                width: 2.0,
                dash: StrokeDash::Solid,
                line_type: LineRenderType::Single,
                start_arrow: ArrowStyle::Circle,
                end_arrow: ArrowStyle::Square,
                start_arrow_size: 1,
                end_arrow_size: 8,
                shadow: None,
            }),
        };

        let tree = PageLayerTree::new(
            40.0,
            40.0,
            LayerNode::leaf(
                BoundingBox::new(0.0, 0.0, 40.0, 40.0),
                None,
                vec![
                    line,
                    PaintOp::Path {
                        bbox: BoundingBox::new(0.0, 0.0, 24.0, 24.0),
                        path: path_node,
                    },
                ],
            ),
        );

        let json = tree.to_json();
        assert!(json.contains("\"shadow\":{\"shadowType\":1,\"color\":\"#303030\",\"offsetX\":1.500000,\"offsetY\":2.500000,\"alpha\":64}"));
        assert!(json.contains(
            "\"connectorEndpoints\":{\"x1\":4.000000,\"y1\":4.000000,\"x2\":20.000000,\"y2\":20.000000}"
        ));
        assert!(json.contains("\"lineStyle\":{\"color\":\"#030201\",\"width\":2.000000,\"dash\":\"solid\",\"lineType\":\"single\",\"startArrow\":\"circle\",\"endArrow\":\"square\",\"startArrowSize\":1,\"endArrowSize\":8}"));
    }

    #[test]
    fn serializes_flattened_form_and_footnote_ops() {
        let tree = PageLayerTree::new(
            40.0,
            40.0,
            LayerNode::leaf(
                BoundingBox::new(0.0, 0.0, 40.0, 40.0),
                None,
                vec![
                    PaintOp::FootnoteMarker {
                        bbox: BoundingBox::new(2.0, 2.0, 10.0, 10.0),
                        marker: crate::paint::LayerFootnoteMarkerPaint {
                            text: "1)".to_string(),
                            font_family: "함초롬돋움".to_string(),
                            base_font_size: 10.0,
                            color: 0x00112233,
                        },
                    },
                    PaintOp::FormObject {
                        bbox: BoundingBox::new(4.0, 12.0, 30.0, 12.0),
                        form: crate::paint::LayerFormObjectPaint {
                            form_type: crate::model::control::FormType::CheckBox,
                            caption: "동의".to_string(),
                            text: String::new(),
                            fore_color: "#123456".to_string(),
                            back_color: "#ffffff".to_string(),
                            value: 1,
                            enabled: true,
                        },
                    },
                ],
            ),
        );

        let json = tree.to_json();
        assert!(json.contains("\"type\":\"footnoteMarker\""));
        assert!(json.contains("\"fontFamily\":\"함초롬돋움\""));
        assert!(json.contains("\"type\":\"formObject\""));
        assert!(json.contains("\"formType\":\"checkBox\""));
        assert!(json.contains("\"caption\":\"동의\""));
        assert!(json.contains("\"foreColor\":\"#123456\""));
    }

    #[test]
    fn serializes_clip_kind_for_browser_replay() {
        let tree = PageLayerTree::new(
            40.0,
            40.0,
            LayerNode::clip_rect(
                BoundingBox::new(0.0, 0.0, 40.0, 40.0),
                None,
                BoundingBox::new(1.0, 2.0, 30.0, 20.0),
                LayerNode::leaf(BoundingBox::new(1.0, 2.0, 30.0, 20.0), None, vec![]),
                ClipKind::Body,
            ),
        );

        let json = tree.to_json();
        assert!(json.contains("\"kind\":\"clipRect\""));
        assert!(json.contains("\"clipKind\":\"body\""));
        assert!(json.contains("\"rightOverflowSlop\":4"));
        assert!(json.contains("\"allowHorizontalOverflowControls\":true"));
    }

    #[test]
    fn serializes_group_cache_hint_for_browser_replay() {
        let tree = PageLayerTree::new(
            40.0,
            40.0,
            LayerNode::group(
                BoundingBox::new(0.0, 0.0, 40.0, 40.0),
                None,
                vec![LayerNode::leaf(
                    BoundingBox::new(0.0, 0.0, 40.0, 40.0),
                    None,
                    vec![],
                )],
                CacheHint::PreferVectorRecording,
                crate::paint::LayerSemantic::default(),
            ),
        );

        let json = tree.to_json();
        assert!(json.contains("\"kind\":\"group\""));
        assert!(json.contains("\"cacheHint\":\"preferVectorRecording\""));
    }

    #[test]
    fn serializes_lightweight_semantic_metadata_separately_from_visual_kind() {
        let tree = PageLayerTree::new(
            40.0,
            40.0,
            LayerNode::group(
                BoundingBox::new(0.0, 0.0, 40.0, 40.0),
                Some(7),
                vec![],
                CacheHint::None,
                crate::paint::LayerSemantic::table(Some(1), Some(2), Some(3), 4, 5),
            ),
        );

        let json = tree.to_json();
        assert!(json.contains("\"kind\":\"group\""));
        assert!(json.contains("\"semantic\":{\"role\":\"table\""));
        assert!(json.contains("\"sectionIndex\":1"));
        assert!(json.contains("\"paraIndex\":2"));
        assert!(json.contains("\"controlIndex\":3"));
        assert!(json.contains("\"rowCount\":4"));
        assert!(json.contains("\"colCount\":5"));
    }

    #[test]
    fn serializes_column_semantic_index() {
        let tree = PageLayerTree::new(
            40.0,
            40.0,
            LayerNode::group(
                BoundingBox::new(0.0, 0.0, 40.0, 40.0),
                Some(8),
                vec![],
                CacheHint::None,
                crate::paint::LayerSemantic::column(2),
            ),
        );

        let json = tree.to_json();
        assert!(json.contains("\"semantic\":{\"role\":\"column\""));
        assert!(json.contains("\"columnIndex\":2"));
    }

    #[test]
    fn serializes_non_default_profile_for_browser_replay() {
        let tree = PageLayerTree::with_profile(
            40.0,
            40.0,
            LayerNode::leaf(BoundingBox::new(0.0, 0.0, 40.0, 40.0), None, vec![]),
            crate::paint::RenderProfile::HighQuality,
        );

        let json = tree.to_json();
        assert!(json.contains("\"profile\":\"high-quality\""));
    }

    #[test]
    fn serializes_output_options_for_backend_replay() {
        let tree = PageLayerTree::new(
            40.0,
            40.0,
            LayerNode::leaf(BoundingBox::new(0.0, 0.0, 40.0, 40.0), None, vec![]),
        )
        .with_output_options(LayerOutputOptions {
            show_paragraph_marks: true,
            show_control_codes: true,
            show_transparent_borders: true,
            clip_enabled: false,
            debug_overlay: true,
        });

        let json = tree.to_json();
        assert!(json.contains("\"showParagraphMarks\":true"));
        assert!(json.contains("\"showControlCodes\":true"));
        assert!(json.contains("\"showTransparentBorders\":true"));
        assert!(json.contains("\"clipEnabled\":false"));
        assert!(json.contains("\"debugOverlay\":true"));
        assert!(json.contains("\"buildOptions\":{\"showTransparentBorders\":true}"));
        assert!(json.contains("\"debugOptions\":{\"debugOverlay\":true}"));
        assert!(
            json.contains("\"debugCapabilities\":{\"overlayPaint\":false,\"semanticBounds\":true")
        );
        assert!(json
            .contains("\"genericLayerExport\":{\"overlayPaint\":false,\"semanticBounds\":true}"));
        assert!(json.contains("\"svgLayer\":{\"overlayPaint\":true,\"semanticBounds\":true}"));
        assert!(json.contains("\"nativeSkia\":{\"overlayPaint\":false,\"semanticBounds\":true}"));
    }
}

fn json_escape(value: &str) -> String {
    format!("\"{}\"", raw_json_escape(value))
}
