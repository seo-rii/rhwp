use std::collections::HashSet;

use js_sys::{Array, Object, Reflect, Uint8Array};
use wasm_bindgen::JsValue;

use crate::document_core::helpers::color_ref_to_css;
use crate::model::control::FormType;
use crate::model::image::ImageEffect;
use crate::model::style::{ImageFillMode, UnderlineType};
use crate::paint::{
    CacheHint, ClipKind, LayerNode, LayerNodeKind, LayerSemantic, PageLayerTree, PaintOp,
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
    set_number(&value, "schemaVersion", 1.0);
    set_string(&value, "unit", "px");
    set_string(&value, "coordinateSystem", "page-top-left-y-down");
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
    set_value(&value, "root", layer_node_to_value(&tree.root));

    let resources = Object::new();
    let images = Array::new();
    let image_hashes = Array::new();
    let image_keys = Array::new();
    for (id, bytes) in tree.resources.image_resources() {
        if let Some(hash) = tree.resources.image_hash(id) {
            let hash = format!("{hash:016x}");
            let key = resource_key(bytes.len(), &hash);
            image_hashes.set(id.0 as u32, JsValue::from_str(&hash));
            image_keys.set(id.0 as u32, JsValue::from_str(&key));
            if !hints.known_image_keys.contains(&key) {
                images.set(id.0 as u32, Uint8Array::from(bytes).into());
            }
        } else {
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
        if let Some(hash) = tree.resources.svg_hash(id) {
            let hash = format!("{hash:016x}");
            let key = resource_key(svg.len(), &hash);
            svg_hashes.set(id.0 as u32, JsValue::from_str(&hash));
            svg_keys.set(id.0 as u32, JsValue::from_str(&key));
            if !hints.known_svg_keys.contains(&key) {
                svg_fragments.set(id.0 as u32, JsValue::from_str(svg));
            }
        } else {
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

fn resource_key(byte_len: usize, hash: &str) -> String {
    format!("r1:{byte_len}:{hash}")
}

fn layer_node_to_value(node: &LayerNode) -> JsValue {
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
                array_to_value(children.iter().map(layer_node_to_value)),
            );
        }
        LayerNodeKind::ClipRect {
            clip,
            child,
            clip_kind,
        } => {
            set_string(&value, "kind", "clipRect");
            set_value(&value, "clip", bbox_to_value(*clip));
            set_string(&value, "clipKind", clip_kind_str(*clip_kind));
            set_value(&value, "child", layer_node_to_value(child));
        }
        LayerNodeKind::Leaf { ops, cache_hint } => {
            set_string(&value, "kind", "leaf");
            set_string(&value, "cacheHint", cache_hint_str(*cache_hint));
            set_value(
                &value,
                "ops",
                array_to_value(ops.iter().map(paint_op_to_value)),
            );
        }
    }

    value.into()
}

fn paint_op_to_value(op: &PaintOp) -> JsValue {
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
            set_value(&value, "style", text_style_to_value(&run.style));
            set_value(
                &value,
                "positions",
                array_to_value(run.positions.iter().copied().map(JsValue::from_f64)),
            );
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
