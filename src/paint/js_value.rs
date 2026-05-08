use std::collections::HashSet;

use js_sys::{Array, Object, Reflect, Uint8Array};
use wasm_bindgen::JsValue;

use crate::document_core::helpers::color_ref_to_css;
use crate::model::control::FormType;
use crate::model::image::ImageEffect;
use crate::model::style::{ImageFillMode, UnderlineType};
use crate::paint::{
    image_resource_key, resource_digest_hex, svg_resource_key, CacheHint, ClipKind, LayerNode,
    LayerNodeKind, LayerSemantic, PageLayerTree, PaintOp, PaintTextStyle, LAYER_TREE_SCHEMA,
};
use crate::renderer::equation::ast::MatrixStyle;
use crate::renderer::equation::layout::{LayoutBox, LayoutKind};
use crate::renderer::equation::symbols::{DecoKind, FontStyleKind};
use crate::renderer::render_tree::{BoundingBox, FieldMarkerType, ShapeTransform};
use crate::renderer::{
    ArrowStyle, GradientFillInfo, LineRenderType, LineStyle, PathCommand, PatternFillInfo,
    ShadowStyle, ShapeStyle, StrokeDash, TabLeaderInfo, TextStyle,
};

#[derive(Debug, Default)]
pub struct LayerResourceExportHints {
    known_image_keys: HashSet<String>,
    known_svg_keys: HashSet<String>,
}

impl LayerResourceExportHints {
    pub fn from_js_values(known_image_keys: &JsValue, known_svg_keys: &JsValue) -> Self {
        Self {
            known_image_keys: string_set_from_js_value(known_image_keys),
            known_svg_keys: string_set_from_js_value(known_svg_keys),
        }
    }
}

pub fn page_layer_tree_to_js_value(tree: &PageLayerTree) -> JsValue {
    page_layer_tree_to_js_value_with_resource_hints(tree, &LayerResourceExportHints::default())
}

pub fn page_layer_tree_to_js_value_with_resource_hints(
    tree: &PageLayerTree,
    hints: &LayerResourceExportHints,
) -> JsValue {
    let value = Object::new();
    set_number(
        &value,
        "schemaVersion",
        LAYER_TREE_SCHEMA.schema_version as f64,
    );
    set_number(
        &value,
        "resourceTableVersion",
        LAYER_TREE_SCHEMA.resource_table_version as f64,
    );
    set_string(&value, "unit", LAYER_TREE_SCHEMA.unit);
    set_string(
        &value,
        "coordinateSystem",
        LAYER_TREE_SCHEMA.coordinate_system,
    );
    set_number(&value, "pageWidth", tree.page_width);
    set_number(&value, "pageHeight", tree.page_height);
    set_string(&value, "profile", tree.profile.as_str());
    let output_options = Object::new();
    set_bool(
        &output_options,
        "showParagraphMarks",
        tree.output_options.show_paragraph_marks,
    );
    set_bool(
        &output_options,
        "showControlCodes",
        tree.output_options.show_control_codes,
    );
    set_bool(
        &output_options,
        "showTransparentBorders",
        tree.output_options.show_transparent_borders,
    );
    set_bool(
        &output_options,
        "clipEnabled",
        tree.output_options.clip_enabled,
    );
    set_bool(
        &output_options,
        "debugOverlay",
        tree.output_options.debug_overlay,
    );
    set_value(&value, "outputOptions", output_options.into());
    let build_options = Object::new();
    set_bool(
        &build_options,
        "showTransparentBorders",
        tree.output_options.show_transparent_borders,
    );
    set_value(&value, "buildOptions", build_options.into());
    let debug_options = Object::new();
    set_bool(
        &debug_options,
        "debugOverlay",
        tree.output_options.debug_overlay,
    );
    set_value(&value, "debugOptions", debug_options.into());
    let debug_capabilities = Object::new();
    set_bool(&debug_capabilities, "overlayPaint", false);
    set_bool(&debug_capabilities, "semanticBounds", true);
    let generic_layer_export = Object::new();
    set_bool(&generic_layer_export, "overlayPaint", false);
    set_bool(&generic_layer_export, "semanticBounds", true);
    set_value(
        &debug_capabilities,
        "genericLayerExport",
        generic_layer_export.into(),
    );
    let backends = Object::new();
    set_debug_backend_capability(&backends, "svgLayer", true);
    set_debug_backend_capability(&backends, "canvas2d", false);
    set_debug_backend_capability(&backends, "canvaskit", false);
    set_debug_backend_capability(&backends, "nativeSkia", false);
    set_value(&debug_capabilities, "backends", backends.into());
    set_value(&value, "debugCapabilities", debug_capabilities.into());
    let mut text_source_state = TextSourceExportState::default();
    set_value(
        &value,
        "root",
        layer_node_to_value(&tree.root, &mut text_source_state),
    );
    set_value(&value, "textSources", text_sources_to_value(&tree.root));

    let resources = Object::new();
    let images = Array::new();
    let image_hashes = Array::new();
    let image_keys = Array::new();
    for (id, bytes) in tree.resources.image_resources() {
        let digest = resource_digest_hex(bytes);
        let key = image_resource_key(bytes.len(), &digest);
        image_hashes.set(id.0 as u32, JsValue::from_str(&digest));
        image_keys.set(id.0 as u32, JsValue::from_str(&key));
        if !hints.known_image_keys.contains(&key) {
            images.set(id.0 as u32, Uint8Array::from(bytes).into());
        }
    }
    set_value(&resources, "images", images.into());
    set_value(&resources, "imageHashes", image_hashes.into());
    set_value(&resources, "imageKeys", image_keys.into());

    let svg_fragments = Array::new();
    let svg_hashes = Array::new();
    let svg_keys = Array::new();
    for (id, svg) in tree.resources.svg_resources() {
        let digest = resource_digest_hex(svg);
        let key = svg_resource_key(svg.len(), &digest);
        svg_hashes.set(id.0 as u32, JsValue::from_str(&digest));
        svg_keys.set(id.0 as u32, JsValue::from_str(&key));
        if !hints.known_svg_keys.contains(&key) {
            svg_fragments.set(id.0 as u32, JsValue::from_str(svg));
        }
    }
    set_value(&resources, "svgFragments", svg_fragments.into());
    set_value(&resources, "svgHashes", svg_hashes.into());
    set_value(&resources, "svgKeys", svg_keys.into());
    set_value(&value, "resources", resources.into());
    value.into()
}

fn string_set_from_js_value(value: &JsValue) -> HashSet<String> {
    if value.is_null() || value.is_undefined() {
        return HashSet::new();
    }

    Array::from(value)
        .iter()
        .filter_map(|item| item.as_string())
        .collect()
}

fn set_debug_backend_capability(backends: &Object, name: &str, overlay_paint: bool) {
    let capability = Object::new();
    set_bool(&capability, "overlayPaint", overlay_paint);
    set_bool(&capability, "semanticBounds", true);
    set_value(backends, name, capability.into());
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

fn text_sources_to_value(root: &LayerNode) -> JsValue {
    let array = Array::new();
    let mut state = TextSourceExportState::default();
    push_text_sources_for_node(&array, root, &mut state);
    array.into()
}

fn push_text_sources_for_node(array: &Array, node: &LayerNode, state: &mut TextSourceExportState) {
    match &node.kind {
        LayerNodeKind::Group { children, .. } => {
            for child in children {
                push_text_sources_for_node(array, child, state);
            }
        }
        LayerNodeKind::ClipRect { child, .. } => {
            push_text_sources_for_node(array, child, state);
        }
        LayerNodeKind::Leaf { ops, .. } => {
            for op in ops {
                if let PaintOp::TextRun { run, .. } = op {
                    array.push(&text_source_entry_to_value(run, state.next_id()));
                }
            }
        }
    }
}

fn text_source_entry_to_value(run: &crate::paint::LayerTextRunPaint, id: u32) -> JsValue {
    let value = Object::new();
    let utf8_end = run.text.len() as u32;
    let utf16_end = run.text.encode_utf16().count() as u32;
    set_number(&value, "id", id as f64);
    set_string(&value, "text", &run.text);
    set_value(&value, "utf8Range", text_source_range_to_value(0, utf8_end));
    set_value(
        &value,
        "utf16Range",
        text_source_range_to_value(0, utf16_end),
    );
    set_value(
        &value,
        "annotations",
        text_source_annotations_to_value(run, utf8_end, utf16_end),
    );
    value.into()
}

fn text_source_span_to_value(run: &crate::paint::LayerTextRunPaint, id: u32) -> JsValue {
    let value = Object::new();
    set_number(&value, "id", id as f64);
    set_value(
        &value,
        "utf8Range",
        text_source_range_to_value(0, run.text.len() as u32),
    );
    set_value(
        &value,
        "utf16Range",
        text_source_range_to_value(0, run.text.encode_utf16().count() as u32),
    );
    value.into()
}

fn text_source_range_to_value(start: u32, end: u32) -> JsValue {
    let value = Object::new();
    set_number(&value, "start", start as f64);
    set_number(&value, "end", end as f64);
    value.into()
}

fn text_source_annotations_to_value(
    run: &crate::paint::LayerTextRunPaint,
    utf8_end: u32,
    utf16_end: u32,
) -> JsValue {
    let annotations = Array::new();
    if run.field_marker != FieldMarkerType::None {
        let annotation = Object::new();
        set_string(&annotation, "kind", "fieldMarker");
        set_string(&annotation, "marker", field_marker_str(run.field_marker));
        set_value(
            &annotation,
            "rangeUtf8",
            text_source_range_to_value(0, utf8_end),
        );
        set_value(
            &annotation,
            "rangeUtf16",
            text_source_range_to_value(0, utf16_end),
        );
        if let FieldMarkerType::ShapeMarker(index) = run.field_marker {
            set_number(&annotation, "shapeMarkerIndex", index as f64);
        }
        annotations.push(&annotation);
    }
    if run.is_para_end {
        let annotation = Object::new();
        set_string(&annotation, "kind", "paragraphEnd");
        set_number(&annotation, "offsetUtf8", utf8_end as f64);
        set_number(&annotation, "offsetUtf16", utf16_end as f64);
        annotations.push(&annotation);
    }
    if run.is_line_break_end {
        let annotation = Object::new();
        set_string(&annotation, "kind", "lineBreakEnd");
        set_number(&annotation, "offsetUtf8", utf8_end as f64);
        set_number(&annotation, "offsetUtf16", utf16_end as f64);
        annotations.push(&annotation);
    }
    annotations.into()
}

fn layer_node_to_value(node: &LayerNode, text_sources: &mut TextSourceExportState) -> JsValue {
    let value = Object::new();
    set_value(&value, "bounds", bbox_to_value(node.bounds));
    if let Some(source_node_id) = node.source_node_id {
        set_number(&value, "sourceNodeId", source_node_id as f64);
    }
    if node.semantic != LayerSemantic::default() {
        let semantic = Object::new();
        set_string(&semantic, "role", node.semantic.role.as_str());
        if let Some(section_index) = node.semantic.section_index {
            set_number(&semantic, "sectionIndex", section_index as f64);
        }
        if let Some(column_index) = node.semantic.column_index {
            set_number(&semantic, "columnIndex", column_index as f64);
        }
        if let Some(para_index) = node.semantic.para_index {
            set_number(&semantic, "paraIndex", para_index as f64);
        }
        if let Some(control_index) = node.semantic.control_index {
            set_number(&semantic, "controlIndex", control_index as f64);
        }
        if let Some(row_count) = node.semantic.row_count {
            set_number(&semantic, "rowCount", row_count as f64);
        }
        if let Some(col_count) = node.semantic.col_count {
            set_number(&semantic, "colCount", col_count as f64);
        }
        set_value(&value, "semantic", semantic.into());
    }

    match &node.kind {
        LayerNodeKind::Group {
            children,
            cache_hint,
        } => {
            set_string(&value, "kind", "group");
            set_string(&value, "cacheHint", cache_hint_str(*cache_hint));
            set_value(
                &value,
                "children",
                layer_nodes_to_value(children, text_sources),
            );
        }
        LayerNodeKind::ClipRect {
            clip,
            child,
            clip_kind,
            clip_policy,
        } => {
            set_string(&value, "kind", "clipRect");
            set_value(&value, "clip", bbox_to_value(*clip));
            set_string(&value, "clipKind", clip_kind_str(*clip_kind));
            let policy = Object::new();
            set_number(
                &policy,
                "rightOverflowSlop",
                clip_policy.right_overflow_slop,
            );
            set_bool(
                &policy,
                "allowHorizontalOverflowControls",
                clip_policy.allow_horizontal_overflow_controls,
            );
            set_value(&value, "clipPolicy", policy.into());
            set_value(&value, "child", layer_node_to_value(child, text_sources));
        }
        LayerNodeKind::Leaf { ops, cache_hint } => {
            set_string(&value, "kind", "leaf");
            set_string(&value, "cacheHint", cache_hint_str(*cache_hint));
            set_value(&value, "ops", paint_ops_to_value(ops, text_sources));
        }
    }

    value.into()
}

fn layer_nodes_to_value(
    children: &[LayerNode],
    text_sources: &mut TextSourceExportState,
) -> JsValue {
    let array = Array::new();
    for child in children {
        array.push(&layer_node_to_value(child, text_sources));
    }
    array.into()
}

fn paint_ops_to_value(ops: &[PaintOp], text_sources: &mut TextSourceExportState) -> JsValue {
    let array = Array::new();
    for op in ops {
        array.push(&paint_op_to_value(op, text_sources));
    }
    array.into()
}

fn paint_op_to_value(op: &PaintOp, text_sources: &mut TextSourceExportState) -> JsValue {
    let value = Object::new();
    match op {
        PaintOp::PageBackground { bbox, background } => {
            set_string(&value, "type", "pageBackground");
            set_value(&value, "bbox", bbox_to_value(*bbox));
            if let Some(color) = background.background_color {
                set_string(&value, "backgroundColor", &color_ref_to_css(color));
            }
            if let Some(color) = background.border_color {
                set_string(&value, "borderColor", &color_ref_to_css(color));
            }
            set_number(&value, "borderWidth", background.border_width);
            if let Some(gradient) = &background.gradient {
                set_value(&value, "gradient", gradient_to_value(gradient));
            }
            if let Some(image) = &background.image {
                let image_value = Object::new();
                set_number(&image_value, "resourceId", image.resource_id.0 as f64);
                set_string(
                    &image_value,
                    "fillMode",
                    image_fill_mode_str(image.fill_mode),
                );
                set_value(&value, "image", image_value.into());
            }
        }
        PaintOp::TextRun { bbox, run } => {
            set_string(&value, "type", "textRun");
            set_value(&value, "bbox", bbox_to_value(*bbox));
            set_string(&value, "text", &run.text);
            set_number(&value, "baseline", run.baseline);
            set_number(&value, "rotation", run.rotation);
            set_bool(&value, "isVertical", run.is_vertical);
            set_string(&value, "orientation", run.orientation.as_str());
            set_value(
                &value,
                "source",
                text_source_span_to_value(run, text_sources.next_id()),
            );
            set_value(&value, "style", text_style_to_value(&run.style));
            set_value(
                &value,
                "paintStyle",
                paint_text_style_to_value(&PaintTextStyle::from(&run.style)),
            );
            set_value(
                &value,
                "positions",
                array_to_value(run.positions.iter().copied().map(JsValue::from_f64)),
            );
            if !run.control_marks.is_empty() {
                set_value(&value, "controlMarks", text_control_marks_to_value(run));
            }
            if let Some(overlap) = &run.char_overlap {
                set_value(&value, "charOverlap", char_overlap_to_value(overlap));
            }
            set_string(&value, "fieldMarker", field_marker_str(run.field_marker));
            set_bool(&value, "isParaEnd", run.is_para_end);
            set_bool(&value, "isLineBreakEnd", run.is_line_break_end);
            if let FieldMarkerType::ShapeMarker(index) = run.field_marker {
                set_number(&value, "shapeMarkerIndex", index as f64);
            }
            if !run.style.tab_leaders.is_empty() {
                set_value(
                    &value,
                    "tabLeaders",
                    tab_leaders_to_value(&run.style.tab_leaders),
                );
            }
        }
        PaintOp::FootnoteMarker { bbox, marker } => {
            set_string(&value, "type", "footnoteMarker");
            set_value(&value, "bbox", bbox_to_value(*bbox));
            set_string(&value, "text", &marker.text);
            set_string(&value, "fontFamily", &marker.font_family);
            set_number(&value, "fontSize", (marker.base_font_size * 0.55).max(7.0));
            set_string(&value, "color", &color_ref_to_css(marker.color));
        }
        PaintOp::Line { bbox, line } => {
            set_string(&value, "type", "line");
            set_value(&value, "bbox", bbox_to_value(*bbox));
            set_number(&value, "x1", line.x1);
            set_number(&value, "y1", line.y1);
            set_number(&value, "x2", line.x2);
            set_number(&value, "y2", line.y2);
            set_value(&value, "style", line_style_to_value(&line.style));
            set_value(&value, "transform", transform_to_value(line.transform));
        }
        PaintOp::Rectangle { bbox, rect } => {
            set_string(&value, "type", "rectangle");
            set_value(&value, "bbox", bbox_to_value(*bbox));
            set_number(&value, "cornerRadius", rect.corner_radius);
            set_value(&value, "style", shape_style_to_value(&rect.style));
            if let Some(gradient) = &rect.gradient {
                set_value(&value, "gradient", gradient_to_value(gradient));
            }
            set_value(&value, "transform", transform_to_value(rect.transform));
        }
        PaintOp::Ellipse { bbox, ellipse } => {
            set_string(&value, "type", "ellipse");
            set_value(&value, "bbox", bbox_to_value(*bbox));
            set_value(&value, "style", shape_style_to_value(&ellipse.style));
            if let Some(gradient) = &ellipse.gradient {
                set_value(&value, "gradient", gradient_to_value(gradient));
            }
            set_value(&value, "transform", transform_to_value(ellipse.transform));
        }
        PaintOp::Path { bbox, path } => {
            set_string(&value, "type", "path");
            set_value(&value, "bbox", bbox_to_value(*bbox));
            set_value(&value, "commands", path_commands_to_value(&path.commands));
            set_value(&value, "style", shape_style_to_value(&path.style));
            if let Some(gradient) = &path.gradient {
                set_value(&value, "gradient", gradient_to_value(gradient));
            }
            if let Some((x1, y1, x2, y2)) = path.connector_endpoints {
                let connector = Object::new();
                set_number(&connector, "x1", x1);
                set_number(&connector, "y1", y1);
                set_number(&connector, "x2", x2);
                set_number(&connector, "y2", y2);
                set_value(&value, "connectorEndpoints", connector.into());
            }
            if let Some(line_style) = &path.line_style {
                set_value(&value, "lineStyle", line_style_to_value(line_style));
            }
            set_value(&value, "transform", transform_to_value(path.transform));
        }
        PaintOp::Image { bbox, image } => {
            set_string(&value, "type", "image");
            set_value(&value, "bbox", bbox_to_value(*bbox));
            if let Some(resource_id) = image.resource_id {
                set_number(&value, "resourceId", resource_id.0 as f64);
            }
            if let Some(fill_mode) = image.fill_mode {
                set_string(&value, "fillMode", image_fill_mode_str(fill_mode));
            }
            if let Some((width, height)) = image.original_size {
                let original_size = Object::new();
                set_number(&original_size, "width", width);
                set_number(&original_size, "height", height);
                set_value(&value, "originalSize", original_size.into());
            }
            if let Some((left, top, right, bottom)) = image.crop {
                let crop = Object::new();
                set_number(&crop, "left", left as f64);
                set_number(&crop, "top", top as f64);
                set_number(&crop, "right", right as f64);
                set_number(&crop, "bottom", bottom as f64);
                set_value(&value, "crop", crop.into());
            }
            set_string(&value, "effect", image_effect_str(image.effect));
            set_value(&value, "transform", transform_to_value(image.transform));
        }
        PaintOp::Equation { bbox, equation } => {
            set_string(&value, "type", "equation");
            set_value(&value, "bbox", bbox_to_value(*bbox));
            set_string(&value, "color", &equation.color_str);
            set_number(&value, "fontSize", equation.font_size);
            set_number(&value, "svgResourceId", equation.svg_resource_id.0 as f64);
            set_value(
                &value,
                "layoutBox",
                equation_layout_box_to_value(&equation.layout_box),
            );
        }
        PaintOp::FormObject { bbox, form } => {
            set_string(&value, "type", "formObject");
            set_value(&value, "bbox", bbox_to_value(*bbox));
            set_string(&value, "formType", form_type_str(form.form_type));
            set_string(&value, "caption", &form.caption);
            set_string(&value, "text", &form.text);
            set_string(&value, "foreColor", &form.fore_color);
            set_string(&value, "backColor", &form.back_color);
            set_number(&value, "value", form.value as f64);
            set_bool(&value, "enabled", form.enabled);
        }
    }
    value.into()
}

fn bbox_to_value(bbox: BoundingBox) -> JsValue {
    let value = Object::new();
    set_number(&value, "x", bbox.x);
    set_number(&value, "y", bbox.y);
    set_number(&value, "width", bbox.width);
    set_number(&value, "height", bbox.height);
    value.into()
}

fn text_style_to_value(style: &TextStyle) -> JsValue {
    paint_text_style_to_value(&PaintTextStyle::from(style))
}

fn paint_text_style_to_value(style: &PaintTextStyle) -> JsValue {
    let value = Object::new();
    set_string(&value, "fontFamily", &style.font_family);
    set_number(&value, "fontSize", style.font_size);
    set_string(&value, "color", &color_ref_to_css(style.color));
    set_bool(&value, "bold", style.bold);
    set_bool(&value, "italic", style.italic);
    set_number(&value, "ratio", style.ratio);
    set_string(&value, "underline", underline_type_str(style.underline));
    set_number(&value, "underlineShape", style.underline_shape as f64);
    set_bool(&value, "strikethrough", style.strikethrough);
    set_number(&value, "strikeShape", style.strike_shape as f64);
    set_number(&value, "outlineType", style.outline_type as f64);
    set_number(&value, "shadowType", style.shadow_type as f64);
    set_string(&value, "shadowColor", &color_ref_to_css(style.shadow_color));
    set_number(&value, "shadowOffsetX", style.shadow_offset_x);
    set_number(&value, "shadowOffsetY", style.shadow_offset_y);
    set_bool(&value, "emboss", style.emboss);
    set_bool(&value, "engrave", style.engrave);
    set_number(&value, "emphasisDot", style.emphasis_dot as f64);
    set_string(
        &value,
        "underlineColor",
        &color_ref_to_css(style.underline_color),
    );
    set_string(&value, "strikeColor", &color_ref_to_css(style.strike_color));
    set_string(&value, "shadeColor", &color_ref_to_css(style.shade_color));
    value.into()
}

fn tab_leaders_to_value(leaders: &[TabLeaderInfo]) -> JsValue {
    array_to_value(leaders.iter().map(|leader| {
        let value = Object::new();
        set_number(&value, "startX", leader.start_x);
        set_number(&value, "endX", leader.end_x);
        set_number(&value, "fillType", leader.fill_type as f64);
        value.into()
    }))
}

fn shape_style_to_value(style: &ShapeStyle) -> JsValue {
    let value = Object::new();
    match style.fill_color {
        Some(fill_color) => set_string(&value, "fillColor", &color_ref_to_css(fill_color)),
        None => set_value(&value, "fillColor", JsValue::NULL),
    }
    match style.stroke_color {
        Some(stroke_color) => set_string(&value, "strokeColor", &color_ref_to_css(stroke_color)),
        None => set_value(&value, "strokeColor", JsValue::NULL),
    }
    set_number(&value, "strokeWidth", style.stroke_width);
    set_string(&value, "strokeDash", stroke_dash_str(style.stroke_dash));
    set_number(&value, "opacity", style.opacity);
    if let Some(pattern) = &style.pattern {
        set_value(&value, "pattern", pattern_fill_to_value(pattern));
    }
    if let Some(shadow) = &style.shadow {
        set_value(&value, "shadow", shadow_style_to_value(shadow));
    }
    value.into()
}

fn pattern_fill_to_value(pattern: &PatternFillInfo) -> JsValue {
    let value = Object::new();
    set_number(&value, "patternType", pattern.pattern_type as f64);
    set_string(
        &value,
        "patternColor",
        &color_ref_to_css(pattern.pattern_color),
    );
    set_string(
        &value,
        "backgroundColor",
        &color_ref_to_css(pattern.background_color),
    );
    value.into()
}

fn shadow_style_to_value(shadow: &ShadowStyle) -> JsValue {
    let value = Object::new();
    set_number(&value, "shadowType", shadow.shadow_type as f64);
    set_string(&value, "color", &color_ref_to_css(shadow.color));
    set_number(&value, "offsetX", shadow.offset_x);
    set_number(&value, "offsetY", shadow.offset_y);
    set_number(&value, "alpha", shadow.alpha as f64);
    value.into()
}

fn gradient_to_value(gradient: &GradientFillInfo) -> JsValue {
    let value = Object::new();
    set_number(&value, "gradientType", gradient.gradient_type as f64);
    set_number(&value, "angle", gradient.angle as f64);
    set_number(&value, "centerX", gradient.center_x as f64);
    set_number(&value, "centerY", gradient.center_y as f64);
    set_value(
        &value,
        "colors",
        array_to_value(
            gradient
                .colors
                .iter()
                .map(|color| JsValue::from_str(&color_ref_to_css(*color))),
        ),
    );
    set_value(
        &value,
        "positions",
        array_to_value(gradient.positions.iter().copied().map(JsValue::from_f64)),
    );
    value.into()
}

fn line_style_to_value(style: &LineStyle) -> JsValue {
    let value = Object::new();
    set_string(&value, "color", &color_ref_to_css(style.color));
    set_number(&value, "width", style.width);
    set_string(&value, "dash", stroke_dash_str(style.dash));
    set_string(&value, "lineType", line_render_type_str(style.line_type));
    set_string(&value, "startArrow", arrow_style_str(style.start_arrow));
    set_string(&value, "endArrow", arrow_style_str(style.end_arrow));
    set_number(&value, "startArrowSize", style.start_arrow_size as f64);
    set_number(&value, "endArrowSize", style.end_arrow_size as f64);
    if let Some(shadow) = &style.shadow {
        set_value(&value, "shadow", shadow_style_to_value(shadow));
    }
    value.into()
}

fn transform_to_value(transform: ShapeTransform) -> JsValue {
    let value = Object::new();
    set_number(&value, "rotation", transform.rotation);
    set_bool(&value, "horzFlip", transform.horz_flip);
    set_bool(&value, "vertFlip", transform.vert_flip);
    value.into()
}

fn path_commands_to_value(commands: &[PathCommand]) -> JsValue {
    array_to_value(commands.iter().map(|command| {
        let value = Object::new();
        match command {
            PathCommand::MoveTo(x, y) => {
                set_string(&value, "type", "moveTo");
                set_number(&value, "x", *x);
                set_number(&value, "y", *y);
            }
            PathCommand::LineTo(x, y) => {
                set_string(&value, "type", "lineTo");
                set_number(&value, "x", *x);
                set_number(&value, "y", *y);
            }
            PathCommand::CurveTo(x1, y1, x2, y2, x3, y3) => {
                set_string(&value, "type", "curveTo");
                set_number(&value, "x1", *x1);
                set_number(&value, "y1", *y1);
                set_number(&value, "x2", *x2);
                set_number(&value, "y2", *y2);
                set_number(&value, "x3", *x3);
                set_number(&value, "y3", *y3);
            }
            PathCommand::ArcTo(rx, ry, rotation, large_arc, sweep, x, y) => {
                set_string(&value, "type", "arcTo");
                set_number(&value, "rx", *rx);
                set_number(&value, "ry", *ry);
                set_number(&value, "rotation", *rotation);
                set_bool(&value, "largeArc", *large_arc);
                set_bool(&value, "sweep", *sweep);
                set_number(&value, "x", *x);
                set_number(&value, "y", *y);
            }
            PathCommand::ClosePath => set_string(&value, "type", "closePath"),
        }
        value.into()
    }))
}

fn equation_layout_box_to_value(layout: &LayoutBox) -> JsValue {
    let value = Object::new();
    set_number(&value, "x", layout.x);
    set_number(&value, "y", layout.y);
    set_number(&value, "width", layout.width);
    set_number(&value, "height", layout.height);
    set_number(&value, "baseline", layout.baseline);
    set_value(&value, "kind", equation_layout_kind_to_value(&layout.kind));
    value.into()
}

fn equation_layout_kind_to_value(kind: &LayoutKind) -> JsValue {
    let value = Object::new();
    match kind {
        LayoutKind::Row(children) => {
            set_string(&value, "type", "row");
            set_value(
                &value,
                "children",
                array_to_value(children.iter().map(equation_layout_box_to_value)),
            );
        }
        LayoutKind::Text(text) => {
            set_string(&value, "type", "text");
            set_string(&value, "text", text);
        }
        LayoutKind::Number(text) => {
            set_string(&value, "type", "number");
            set_string(&value, "text", text);
        }
        LayoutKind::Symbol(text) => {
            set_string(&value, "type", "symbol");
            set_string(&value, "text", text);
        }
        LayoutKind::MathSymbol(text) => {
            set_string(&value, "type", "mathSymbol");
            set_string(&value, "text", text);
        }
        LayoutKind::Function(name) => {
            set_string(&value, "type", "function");
            set_string(&value, "name", name);
        }
        LayoutKind::Fraction { numer, denom } => {
            set_string(&value, "type", "fraction");
            set_value(&value, "numer", equation_layout_box_to_value(numer));
            set_value(&value, "denom", equation_layout_box_to_value(denom));
        }
        LayoutKind::Sqrt { index, body } => {
            set_string(&value, "type", "sqrt");
            if let Some(index) = index {
                set_value(&value, "index", equation_layout_box_to_value(index));
            }
            set_value(&value, "body", equation_layout_box_to_value(body));
        }
        LayoutKind::Superscript { base, sup } => {
            set_string(&value, "type", "superscript");
            set_value(&value, "base", equation_layout_box_to_value(base));
            set_value(&value, "sup", equation_layout_box_to_value(sup));
        }
        LayoutKind::Subscript { base, sub } => {
            set_string(&value, "type", "subscript");
            set_value(&value, "base", equation_layout_box_to_value(base));
            set_value(&value, "sub", equation_layout_box_to_value(sub));
        }
        LayoutKind::SubSup { base, sub, sup } => {
            set_string(&value, "type", "subSup");
            set_value(&value, "base", equation_layout_box_to_value(base));
            set_value(&value, "sub", equation_layout_box_to_value(sub));
            set_value(&value, "sup", equation_layout_box_to_value(sup));
        }
        LayoutKind::BigOp { symbol, sub, sup } => {
            set_string(&value, "type", "bigOp");
            set_string(&value, "symbol", symbol);
            if let Some(sub) = sub {
                set_value(&value, "sub", equation_layout_box_to_value(sub));
            }
            if let Some(sup) = sup {
                set_value(&value, "sup", equation_layout_box_to_value(sup));
            }
        }
        LayoutKind::Limit { is_upper, sub } => {
            set_string(&value, "type", "limit");
            set_bool(&value, "isUpper", *is_upper);
            if let Some(sub) = sub {
                set_value(&value, "sub", equation_layout_box_to_value(sub));
            }
        }
        LayoutKind::Matrix { cells, style } => {
            set_string(&value, "type", "matrix");
            set_string(&value, "style", matrix_style_str(*style));
            set_value(
                &value,
                "cells",
                array_to_value(
                    cells
                        .iter()
                        .map(|row| array_to_value(row.iter().map(equation_layout_box_to_value))),
                ),
            );
        }
        LayoutKind::Rel { arrow, over, under } => {
            set_string(&value, "type", "rel");
            set_value(&value, "arrow", equation_layout_box_to_value(arrow));
            set_value(&value, "over", equation_layout_box_to_value(over));
            if let Some(under) = under {
                set_value(&value, "under", equation_layout_box_to_value(under));
            }
        }
        LayoutKind::EqAlign { rows } => {
            set_string(&value, "type", "eqAlign");
            set_value(
                &value,
                "rows",
                array_to_value(rows.iter().map(|(left, right)| {
                    let row = Object::new();
                    set_value(&row, "left", equation_layout_box_to_value(left));
                    set_value(&row, "right", equation_layout_box_to_value(right));
                    row.into()
                })),
            );
        }
        LayoutKind::Paren { left, right, body } => {
            set_string(&value, "type", "paren");
            set_string(&value, "left", left);
            set_string(&value, "right", right);
            set_value(&value, "body", equation_layout_box_to_value(body));
        }
        LayoutKind::Decoration { kind, body } => {
            set_string(&value, "type", "decoration");
            set_string(&value, "decoration", deco_kind_str(*kind));
            set_value(&value, "body", equation_layout_box_to_value(body));
        }
        LayoutKind::FontStyle { style, body } => {
            set_string(&value, "type", "fontStyle");
            set_string(&value, "fontStyle", font_style_kind_str(*style));
            set_value(&value, "body", equation_layout_box_to_value(body));
        }
        LayoutKind::Space(width) => {
            set_string(&value, "type", "space");
            set_number(&value, "width", *width);
        }
        LayoutKind::Newline => set_string(&value, "type", "newline"),
        LayoutKind::Empty => set_string(&value, "type", "empty"),
    }
    value.into()
}

fn array_to_value(values: impl IntoIterator<Item = JsValue>) -> JsValue {
    let array = Array::new();
    for value in values {
        array.push(&value);
    }
    array.into()
}

fn text_control_marks_to_value(run: &crate::paint::LayerTextRunPaint) -> JsValue {
    array_to_value(run.control_marks.iter().map(|mark| {
        let value = Object::new();
        set_string(&value, "kind", mark.kind.as_str());
        set_string(&value, "text", mark.kind.glyph());
        set_number(&value, "x", mark.x);
        set_number(&value, "y", mark.y);
        set_number(&value, "fontSize", mark.font_size);
        value.into()
    }))
}

fn char_overlap_to_value(overlap: &crate::renderer::composer::CharOverlapInfo) -> JsValue {
    let value = Object::new();
    set_number(&value, "borderType", overlap.border_type as f64);
    set_number(&value, "innerCharSize", overlap.inner_char_size as f64);
    value.into()
}

fn set_value(object: &Object, key: &str, value: JsValue) {
    Reflect::set(object, &JsValue::from_str(key), &value).expect("js object property set failed");
}

fn set_string(object: &Object, key: &str, value: &str) {
    set_value(object, key, JsValue::from_str(value));
}

fn set_bool(object: &Object, key: &str, value: bool) {
    set_value(object, key, JsValue::from_bool(value));
}

fn set_number(object: &Object, key: &str, value: f64) {
    set_value(object, key, JsValue::from_f64(value));
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
mod tests {
    use super::*;
    use wasm_bindgen_test::wasm_bindgen_test;

    use crate::paint::{
        LayerEquationPaint, LayerImagePaint, LayerOutputOptions, LayerTextControlMark,
        LayerTextControlMarkKind, LayerTextOrientation, LayerTextRunPaint, ResourceArena,
    };
    use crate::renderer::composer::CharOverlapInfo;
    use crate::renderer::render_tree::BoundingBox;

    #[wasm_bindgen_test]
    fn exports_json_and_js_value_schema_parity() {
        let image_bytes = vec![1, 2, 3, 4, 5, 6];
        let svg_fragment = "<text x=\"0\" y=\"12\">x</text>".to_string();
        let tree = layer_tree_fixture(&image_bytes, &svg_fragment);

        let json_value = js_sys::JSON::parse(&tree.to_json())
            .unwrap_or_else(|_| panic!("failed to parse layer JSON export"));
        let js_value = page_layer_tree_to_js_value(&tree);

        assert_same_number(&json_value, &js_value, "schemaVersion");
        assert_same_number(&json_value, &js_value, "resourceTableVersion");
        assert_same_string(&json_value, &js_value, "unit");
        assert_same_string(&json_value, &js_value, "coordinateSystem");
        assert_same_number(&json_value, &js_value, "pageWidth");
        assert_same_number(&json_value, &js_value, "pageHeight");
        assert_same_string(&json_value, &js_value, "profile");

        let json_options = prop(&json_value, "outputOptions");
        let js_options = prop(&js_value, "outputOptions");
        for property in [
            "showParagraphMarks",
            "showControlCodes",
            "showTransparentBorders",
            "clipEnabled",
            "debugOverlay",
        ] {
            assert_same_bool(&json_options, &js_options, property);
        }
        let json_build_options = prop(&json_value, "buildOptions");
        let js_build_options = prop(&js_value, "buildOptions");
        assert_same_bool(
            &json_build_options,
            &js_build_options,
            "showTransparentBorders",
        );
        let json_debug_options = prop(&json_value, "debugOptions");
        let js_debug_options = prop(&js_value, "debugOptions");
        assert_same_bool(&json_debug_options, &js_debug_options, "debugOverlay");
        let json_debug_capabilities = prop(&json_value, "debugCapabilities");
        let js_debug_capabilities = prop(&js_value, "debugCapabilities");
        assert_same_bool(
            &json_debug_capabilities,
            &js_debug_capabilities,
            "overlayPaint",
        );
        assert_same_bool(
            &json_debug_capabilities,
            &js_debug_capabilities,
            "semanticBounds",
        );
        let json_generic_debug = prop(&json_debug_capabilities, "genericLayerExport");
        let js_generic_debug = prop(&js_debug_capabilities, "genericLayerExport");
        assert_same_bool(&json_generic_debug, &js_generic_debug, "overlayPaint");
        assert_same_bool(&json_generic_debug, &js_generic_debug, "semanticBounds");
        let json_debug_backends = prop(&json_debug_capabilities, "backends");
        let js_debug_backends = prop(&js_debug_capabilities, "backends");
        for backend in ["svgLayer", "canvas2d", "canvaskit", "nativeSkia"] {
            let json_backend = prop(&json_debug_backends, backend);
            let js_backend = prop(&js_debug_backends, backend);
            assert_same_bool(&json_backend, &js_backend, "overlayPaint");
            assert_same_bool(&json_backend, &js_backend, "semanticBounds");
        }

        let json_root = prop(&json_value, "root");
        let js_root = prop(&js_value, "root");
        assert_same_string(&json_root, &js_root, "kind");
        assert_same_string(&json_root, &js_root, "cacheHint");
        let json_text_sources = Array::from(&prop(&json_value, "textSources"));
        let js_text_sources = Array::from(&prop(&js_value, "textSources"));
        assert_eq!(json_text_sources.length(), 1);
        assert_eq!(json_text_sources.length(), js_text_sources.length());
        let json_source = json_text_sources.get(0);
        let js_source = js_text_sources.get(0);
        assert_same_number(&json_source, &js_source, "id");
        assert_same_string(&json_source, &js_source, "text");
        assert_same_number(
            &prop(&json_source, "utf8Range"),
            &prop(&js_source, "utf8Range"),
            "end",
        );
        assert_same_number(
            &prop(&json_source, "utf16Range"),
            &prop(&js_source, "utf16Range"),
            "end",
        );
        let json_annotations = Array::from(&prop(&json_source, "annotations"));
        let js_annotations = Array::from(&prop(&js_source, "annotations"));
        assert_eq!(json_annotations.length(), 3);
        assert_eq!(json_annotations.length(), js_annotations.length());
        assert_same_string(&json_annotations.get(0), &js_annotations.get(0), "kind");
        assert_same_string(&json_annotations.get(0), &js_annotations.get(0), "marker");
        assert_same_number(
            &json_annotations.get(0),
            &js_annotations.get(0),
            "shapeMarkerIndex",
        );
        assert_same_string(&json_annotations.get(1), &js_annotations.get(1), "kind");
        assert_same_string(&json_annotations.get(2), &js_annotations.get(2), "kind");

        let json_ops = Array::from(&prop(&json_root, "ops"));
        let js_ops = Array::from(&prop(&js_root, "ops"));
        assert_eq!(json_ops.length(), 3);
        assert_eq!(json_ops.length(), js_ops.length());

        let json_text = json_ops.get(0);
        let js_text = js_ops.get(0);
        assert_same_string(&json_text, &js_text, "type");
        assert_same_string(&json_text, &js_text, "text");
        assert_same_string(&json_text, &js_text, "fieldMarker");
        assert_same_string(&json_text, &js_text, "orientation");
        assert_same_number(&json_text, &js_text, "shapeMarkerIndex");
        assert_same_number(&prop(&json_text, "source"), &prop(&js_text, "source"), "id");
        assert_same_number(
            &prop(&prop(&json_text, "source"), "utf8Range"),
            &prop(&prop(&js_text, "source"), "utf8Range"),
            "end",
        );
        assert_same_bool(&json_text, &js_text, "isParaEnd");
        assert_same_bool(&json_text, &js_text, "isLineBreakEnd");
        let json_paint_style = prop(&json_text, "paintStyle");
        let js_paint_style = prop(&js_text, "paintStyle");
        assert_same_string(&json_paint_style, &js_paint_style, "fontFamily");
        assert_same_number(&json_paint_style, &js_paint_style, "fontSize");
        assert_same_string(&json_paint_style, &js_paint_style, "color");
        assert_same_bool(&json_paint_style, &js_paint_style, "bold");
        assert_same_number(&json_paint_style, &js_paint_style, "ratio");
        assert_same_number(
            &prop(&json_text, "charOverlap"),
            &prop(&js_text, "charOverlap"),
            "borderType",
        );
        assert_same_number(
            &prop(&json_text, "charOverlap"),
            &prop(&js_text, "charOverlap"),
            "innerCharSize",
        );
        let json_marks = Array::from(&prop(&json_text, "controlMarks"));
        let js_marks = Array::from(&prop(&js_text, "controlMarks"));
        assert_eq!(json_marks.length(), 1);
        assert_eq!(json_marks.length(), js_marks.length());
        assert_same_string(&json_marks.get(0), &js_marks.get(0), "kind");
        assert_same_string(&json_marks.get(0), &js_marks.get(0), "text");
        assert_same_number(&json_marks.get(0), &js_marks.get(0), "x");
        assert_same_number(&json_marks.get(0), &js_marks.get(0), "fontSize");

        let json_image = json_ops.get(1);
        let js_image = js_ops.get(1);
        assert_same_string(&json_image, &js_image, "type");
        assert_same_string(&json_image, &js_image, "fillMode");
        assert_same_string(&json_image, &js_image, "effect");
        assert_eq!(number_prop(&js_image, "resourceId"), 0.0);
        assert_same_number(&prop(&json_image, "crop"), &prop(&js_image, "crop"), "top");
        assert_same_number(
            &prop(&json_image, "crop"),
            &prop(&js_image, "crop"),
            "bottom",
        );

        let json_equation = json_ops.get(2);
        let js_equation = js_ops.get(2);
        assert_same_string(&json_equation, &js_equation, "type");
        assert_eq!(string_prop(&json_equation, "svgContent"), svg_fragment);
        assert_eq!(number_prop(&js_equation, "svgResourceId"), 0.0);

        let resources = prop(&js_value, "resources");
        let images = Array::from(&prop(&resources, "images"));
        let image_hashes = Array::from(&prop(&resources, "imageHashes"));
        let image_keys = Array::from(&prop(&resources, "imageKeys"));
        let svg_fragments = Array::from(&prop(&resources, "svgFragments"));
        let svg_hashes = Array::from(&prop(&resources, "svgHashes"));
        let svg_keys = Array::from(&prop(&resources, "svgKeys"));

        let image_digest = resource_digest_hex(&image_bytes);
        let image_key = image_resource_key(image_bytes.len(), &image_digest);
        let svg_digest = resource_digest_hex(&svg_fragment);
        let svg_key = svg_resource_key(svg_fragment.len(), &svg_digest);

        assert_eq!(
            Uint8Array::new(&images.get(0)).length(),
            image_bytes.len() as u32
        );
        assert_eq!(string_value(&image_hashes.get(0)), image_digest);
        assert_eq!(string_value(&image_keys.get(0)), image_key);
        assert_eq!(string_value(&svg_fragments.get(0)), svg_fragment);
        assert_eq!(string_value(&svg_hashes.get(0)), svg_digest);
        assert_eq!(string_value(&svg_keys.get(0)), svg_key);
    }

    #[wasm_bindgen_test]
    fn resource_hints_keep_stable_keys_while_omitting_known_payloads() {
        let image_bytes = vec![9, 8, 7, 6];
        let svg_fragment = "<path d=\"M0 0L4 4\"/>".to_string();
        let tree = layer_tree_fixture(&image_bytes, &svg_fragment);

        let image_digest = resource_digest_hex(&image_bytes);
        let image_key = image_resource_key(image_bytes.len(), &image_digest);
        let svg_digest = resource_digest_hex(&svg_fragment);
        let svg_key = svg_resource_key(svg_fragment.len(), &svg_digest);

        let known_image_keys = Array::new();
        known_image_keys.push(&JsValue::from_str(&image_key));
        let known_svg_keys = Array::new();
        known_svg_keys.push(&JsValue::from_str(&svg_key));
        let hints = LayerResourceExportHints::from_js_values(
            &known_image_keys.into(),
            &known_svg_keys.into(),
        );

        let hinted_value = page_layer_tree_to_js_value_with_resource_hints(&tree, &hints);
        let resources = prop(&hinted_value, "resources");
        let images = Array::from(&prop(&resources, "images"));
        let image_hashes = Array::from(&prop(&resources, "imageHashes"));
        let image_keys = Array::from(&prop(&resources, "imageKeys"));
        let svg_fragments = Array::from(&prop(&resources, "svgFragments"));
        let svg_hashes = Array::from(&prop(&resources, "svgHashes"));
        let svg_keys = Array::from(&prop(&resources, "svgKeys"));

        assert_eq!(images.length(), 0);
        assert_eq!(svg_fragments.length(), 0);
        assert_eq!(string_value(&image_hashes.get(0)), image_digest);
        assert_eq!(string_value(&image_keys.get(0)), image_key);
        assert_eq!(string_value(&svg_hashes.get(0)), svg_digest);
        assert_eq!(string_value(&svg_keys.get(0)), svg_key);
    }

    fn layer_tree_fixture(image_bytes: &[u8], svg_fragment: &str) -> PageLayerTree {
        let mut resources = ResourceArena::default();
        let image_id = resources.intern_image_bytes(image_bytes);
        let svg_id = resources.intern_svg_fragment(svg_fragment);

        PageLayerTree::with_resources(
            120.0,
            80.0,
            LayerNode::leaf(
                BoundingBox::new(0.0, 0.0, 120.0, 80.0),
                None,
                vec![
                    PaintOp::TextRun {
                        bbox: BoundingBox::new(8.0, 10.0, 80.0, 16.0),
                        run: LayerTextRunPaint {
                            text: "marker".to_string(),
                            style: TextStyle {
                                font_family: "Noto Sans KR".to_string(),
                                font_size: 12.0,
                                color: 0x00112233,
                                ..Default::default()
                            },
                            positions: vec![0.0, 7.0, 14.0, 21.0, 28.0, 35.0, 42.0],
                            control_marks: vec![LayerTextControlMark {
                                kind: LayerTextControlMarkKind::LineBreakEnd,
                                x: 80.0,
                                y: 0.0,
                                font_size: 12.0,
                            }],
                            is_para_end: true,
                            is_line_break_end: true,
                            rotation: 15.0,
                            is_vertical: true,
                            orientation: LayerTextOrientation::VerticalSideways,
                            char_overlap: Some(CharOverlapInfo {
                                border_type: 3,
                                inner_char_size: 85,
                            }),
                            baseline: 11.0,
                            field_marker: FieldMarkerType::ShapeMarker(4),
                        },
                    },
                    PaintOp::Image {
                        bbox: BoundingBox::new(12.0, 28.0, 24.0, 20.0),
                        image: LayerImagePaint {
                            resource_id: Some(image_id),
                            fill_mode: Some(ImageFillMode::Center),
                            original_size: Some((32.0, 24.0)),
                            crop: Some((1, 2, 31, 22)),
                            effect: ImageEffect::BlackWhite,
                            transform: ShapeTransform::default(),
                        },
                    },
                    PaintOp::Equation {
                        bbox: BoundingBox::new(40.0, 52.0, 24.0, 16.0),
                        equation: LayerEquationPaint {
                            svg_resource_id: svg_id,
                            layout_box: LayoutBox {
                                x: 0.0,
                                y: 0.0,
                                width: 24.0,
                                height: 16.0,
                                baseline: 12.0,
                                kind: LayoutKind::Text("x".to_string()),
                            },
                            color_str: "#112233".to_string(),
                            color: 0x00332211,
                            font_size: 14.0,
                        },
                    },
                ],
            ),
            resources,
        )
        .with_output_options(LayerOutputOptions {
            show_paragraph_marks: true,
            show_control_codes: true,
            show_transparent_borders: true,
            clip_enabled: false,
            debug_overlay: true,
        })
    }

    fn prop(value: &JsValue, name: &str) -> JsValue {
        Reflect::get(value, &JsValue::from_str(name))
            .unwrap_or_else(|_| panic!("failed to read JS property {name}"))
    }

    fn number_prop(value: &JsValue, name: &str) -> f64 {
        prop(value, name)
            .as_f64()
            .unwrap_or_else(|| panic!("JS property {name} is not a number"))
    }

    fn string_prop(value: &JsValue, name: &str) -> String {
        string_value(&prop(value, name))
    }

    fn string_value(value: &JsValue) -> String {
        value
            .as_string()
            .unwrap_or_else(|| panic!("JS value is not a string"))
    }

    fn bool_prop(value: &JsValue, name: &str) -> bool {
        prop(value, name)
            .as_bool()
            .unwrap_or_else(|| panic!("JS property {name} is not a bool"))
    }

    fn assert_same_number(left: &JsValue, right: &JsValue, name: &str) {
        assert_eq!(number_prop(left, name), number_prop(right, name), "{name}");
    }

    fn assert_same_string(left: &JsValue, right: &JsValue, name: &str) {
        assert_eq!(string_prop(left, name), string_prop(right, name), "{name}");
    }

    fn assert_same_bool(left: &JsValue, right: &JsValue, name: &str) {
        assert_eq!(bool_prop(left, name), bool_prop(right, name), "{name}");
    }
}
