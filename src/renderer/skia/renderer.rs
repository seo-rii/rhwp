use skia_safe::{
    paint::Cap, surfaces, Canvas, Color, EncodedImageFormat, FontMgr, Image, Paint, PathBuilder,
    Picture, PictureRecorder, Point, Rect, Shaper,
};
use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};

use crate::model::control::FormType;
use crate::model::image::ImageEffect;
use crate::model::style::ImageFillMode;
use crate::paint::{
    CacheHint, ClipKind, ClipPolicy, ImageResourceId, LayerFormObjectPaint, LayerNode,
    LayerNodeKind, LayerOutputOptions, LayerSemantic, LayerSemanticRole, LayerTextControlMarkKind,
    LayerTextOrientation, LayerTextRunPaint, PageLayerTree, PaintOp, RenderProfile, ResourceArena,
    SvgResourceId,
};
use crate::renderer::composer::{decode_pua_overlap_number, pua_to_display_text};
use crate::renderer::layer_renderer::{
    LayerRasterRenderer, LayerRenderDiagnostics, LayerRenderError, LayerRenderResult,
    RasterOutputFormat, RasterRenderOptions, RasterRenderOutput,
};
use crate::renderer::layout::split_into_clusters;
use crate::renderer::render_tree::{BoundingBox, FieldMarkerType, ShapeTransform};
use crate::renderer::{
    ArrowStyle, GradientFillInfo, LineRenderType, LineStyle, PathCommand, ShapeStyle, StrokeDash,
    TabLeaderInfo, TabStop, TextStyle, UnderlineType,
};

use super::equation_conv::render_equation;
use super::image_conv::{
    decode_image_bytes, draw_decoded_image, draw_missing_image_placeholder, rasterize_svg_fragment,
    ImageDrawDiagnostics, ImageSampling,
};
use super::paint_conv::{
    colorref_to_skia, make_background_fill_paint, make_fill_paint, make_font, make_line_paint,
    make_stroke_paint,
};
use super::path_conv::to_skia_path;

pub struct SkiaLayerRenderer {
    font_mgr: FontMgr,
    text_shaper: Shaper,
    static_picture_cache: RefCell<StaticPictureCache>,
}

const MAX_RASTER_DIMENSION: i32 = 16_384;
const MAX_STATIC_PICTURE_CACHE_ENTRIES: usize = 64;
const MAX_STATIC_PICTURE_CACHE_BYTES: usize = 32 * 1024 * 1024;

struct StaticPictureCache {
    entries: HashMap<u64, StaticPictureCacheEntry>,
    order: VecDeque<u64>,
    max_entries: usize,
    max_approx_bytes: usize,
    approx_bytes: usize,
}

struct StaticPictureCacheEntry {
    picture: Picture,
    fingerprint: u64,
    approx_bytes: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct StaticPictureCacheKey {
    hash: u64,
    fingerprint: u64,
}

impl StaticPictureCache {
    fn new(max_entries: usize, max_approx_bytes: usize) -> Self {
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
            max_entries,
            max_approx_bytes,
            approx_bytes: 0,
        }
    }

    fn len(&self) -> usize {
        self.entries.len()
    }

    fn approx_bytes(&self) -> usize {
        self.approx_bytes
    }

    fn get(&mut self, key: StaticPictureCacheKey) -> Option<Picture> {
        let entry = self.entries.get(&key.hash)?;
        if entry.fingerprint != key.fingerprint {
            return None;
        }
        let picture = entry.picture.clone();
        self.touch(key.hash);
        Some(picture)
    }

    fn insert(&mut self, key: StaticPictureCacheKey, picture: Picture, approx_bytes: usize) {
        if self.max_entries == 0
            || self.max_approx_bytes == 0
            || approx_bytes > self.max_approx_bytes
        {
            return;
        }

        if let Some(entry) = self.entries.remove(&key.hash) {
            self.approx_bytes = self.approx_bytes.saturating_sub(entry.approx_bytes);
        }
        self.order.retain(|cached_key| *cached_key != key.hash);

        while self.entries.len() >= self.max_entries
            || self.approx_bytes.saturating_add(approx_bytes) > self.max_approx_bytes
        {
            let Some(evicted_key) = self.order.pop_front() else {
                self.entries.clear();
                self.approx_bytes = 0;
                break;
            };
            if let Some(entry) = self.entries.remove(&evicted_key) {
                self.approx_bytes = self.approx_bytes.saturating_sub(entry.approx_bytes);
            }
        }

        self.entries.insert(
            key.hash,
            StaticPictureCacheEntry {
                picture,
                fingerprint: key.fingerprint,
                approx_bytes,
            },
        );
        self.approx_bytes = self.approx_bytes.saturating_add(approx_bytes);
        self.order.push_back(key.hash);
    }

    fn touch(&mut self, key: u64) {
        if let Some(index) = self.order.iter().position(|cached_key| *cached_key == key) {
            self.order.remove(index);
        }
        self.order.push_back(key);
    }
}

struct StaticSubtreeCacheKey {
    hash: u64,
    fingerprint: u64,
}

impl StaticSubtreeCacheKey {
    fn new() -> Self {
        Self {
            hash: 0xcbf2_9ce4_8422_2325,
            fingerprint: 0x6c62_272e_07bb_0142,
        }
    }

    fn finish(self) -> StaticPictureCacheKey {
        StaticPictureCacheKey {
            hash: self.hash,
            fingerprint: self.fingerprint,
        }
    }

    fn mix_bytes(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.hash ^= u64::from(*byte);
            self.hash = self.hash.wrapping_mul(0x0000_0100_0000_01b3);
            self.fingerprint ^= u64::from(*byte).wrapping_add(0x9e37_79b9_7f4a_7c15);
            self.fingerprint = self
                .fingerprint
                .rotate_left(7)
                .wrapping_mul(0x517c_c1b7_2722_0a95);
        }
    }

    fn mix_bool(&mut self, value: bool) {
        self.mix_bytes(&[value as u8]);
    }

    fn mix_u8(&mut self, value: u8) {
        self.mix_bytes(&[value]);
    }

    fn mix_u16(&mut self, value: u16) {
        self.mix_bytes(&value.to_le_bytes());
    }

    fn mix_i16(&mut self, value: i16) {
        self.mix_bytes(&value.to_le_bytes());
    }

    fn mix_u32(&mut self, value: u32) {
        self.mix_bytes(&value.to_le_bytes());
    }

    fn mix_i32(&mut self, value: i32) {
        self.mix_bytes(&value.to_le_bytes());
    }

    fn mix_usize(&mut self, value: usize) {
        self.mix_bytes(&value.to_le_bytes());
    }

    fn mix_u64(&mut self, value: u64) {
        self.mix_bytes(&value.to_le_bytes());
    }

    fn mix_f64(&mut self, value: f64) {
        self.mix_u64(value.to_bits());
    }

    fn mix_str(&mut self, value: &str) {
        self.mix_usize(value.len());
        self.mix_bytes(value.as_bytes());
    }

    fn mix_option_u32(&mut self, value: Option<u32>) {
        match value {
            Some(value) => {
                self.mix_bool(true);
                self.mix_u32(value);
            }
            None => self.mix_bool(false),
        }
    }

    fn mix_option_usize(&mut self, value: Option<usize>) {
        match value {
            Some(value) => {
                self.mix_bool(true);
                self.mix_usize(value);
            }
            None => self.mix_bool(false),
        }
    }

    fn mix_option_u16(&mut self, value: Option<u16>) {
        match value {
            Some(value) => {
                self.mix_bool(true);
                self.mix_u16(value);
            }
            None => self.mix_bool(false),
        }
    }

    fn mix_bbox(&mut self, bbox: &BoundingBox) {
        self.mix_f64(bbox.x);
        self.mix_f64(bbox.y);
        self.mix_f64(bbox.width);
        self.mix_f64(bbox.height);
    }

    fn mix_transform(&mut self, transform: &ShapeTransform) {
        self.mix_f64(transform.rotation);
        self.mix_bool(transform.horz_flip);
        self.mix_bool(transform.vert_flip);
    }

    fn mix_output_options(&mut self, output_options: &LayerOutputOptions) {
        self.mix_bool(output_options.show_paragraph_marks);
        self.mix_bool(output_options.show_control_codes);
        self.mix_bool(output_options.show_transparent_borders);
        self.mix_bool(output_options.clip_enabled);
        self.mix_bool(output_options.debug_overlay);
    }

    fn mix_semantic(&mut self, semantic: &LayerSemantic) {
        self.mix_u8(match semantic.role {
            LayerSemanticRole::Generic => 0,
            LayerSemanticRole::Page => 1,
            LayerSemanticRole::MasterPage => 2,
            LayerSemanticRole::Header => 3,
            LayerSemanticRole::Footer => 4,
            LayerSemanticRole::Body => 5,
            LayerSemanticRole::Column => 6,
            LayerSemanticRole::FootnoteArea => 7,
            LayerSemanticRole::TextLine => 8,
            LayerSemanticRole::Table => 9,
            LayerSemanticRole::TableCell => 10,
            LayerSemanticRole::TextBox => 11,
            LayerSemanticRole::Group => 12,
        });
        self.mix_option_usize(semantic.section_index);
        self.mix_option_u16(semantic.column_index);
        self.mix_option_usize(semantic.para_index);
        self.mix_option_usize(semantic.control_index);
        self.mix_option_u16(semantic.row_count);
        self.mix_option_u16(semantic.col_count);
    }

    fn mix_clip_kind(&mut self, clip_kind: ClipKind) {
        self.mix_u8(match clip_kind {
            ClipKind::Body => 0,
            ClipKind::TableCell => 1,
            ClipKind::Generic => 2,
        });
    }

    fn mix_clip_policy(&mut self, clip_policy: &ClipPolicy) {
        self.mix_f64(clip_policy.right_overflow_slop);
        self.mix_bool(clip_policy.allow_horizontal_overflow_controls);
    }

    fn mix_cache_hint(&mut self, cache_hint: CacheHint) {
        self.mix_u8(match cache_hint {
            CacheHint::None => 0,
            CacheHint::StaticSubtree => 1,
            CacheHint::PreferRaster => 2,
            CacheHint::PreferVectorRecording => 3,
        });
    }

    fn mix_layer_node(&mut self, node: &LayerNode, resources: &ResourceArena) {
        self.mix_bbox(&node.bounds);
        self.mix_option_u32(node.source_node_id);
        self.mix_semantic(&node.semantic);
        match &node.kind {
            LayerNodeKind::Group {
                children,
                cache_hint,
            } => {
                self.mix_u8(0);
                self.mix_cache_hint(*cache_hint);
                self.mix_usize(children.len());
                for child in children {
                    self.mix_layer_node(child, resources);
                }
            }
            LayerNodeKind::ClipRect {
                clip,
                child,
                clip_kind,
                clip_policy,
            } => {
                self.mix_u8(1);
                self.mix_bbox(clip);
                self.mix_clip_kind(*clip_kind);
                self.mix_clip_policy(clip_policy);
                self.mix_layer_node(child, resources);
            }
            LayerNodeKind::Leaf { ops, cache_hint } => {
                self.mix_u8(2);
                self.mix_cache_hint(*cache_hint);
                self.mix_usize(ops.len());
                for op in ops {
                    self.mix_paint_op(op, resources);
                }
            }
        }
    }

    fn mix_paint_op(&mut self, op: &PaintOp, resources: &ResourceArena) {
        match op {
            PaintOp::PageBackground { bbox, background } => {
                self.mix_u8(0);
                self.mix_bbox(bbox);
                self.mix_option_u32(background.background_color);
                self.mix_option_u32(background.border_color);
                self.mix_f64(background.border_width);
                self.mix_gradient(background.gradient.as_deref());
                match &background.image {
                    Some(image) => {
                        self.mix_bool(true);
                        self.mix_image_fill_mode(image.fill_mode);
                        self.mix_image_resource(resources, Some(image.resource_id));
                    }
                    None => self.mix_bool(false),
                }
            }
            PaintOp::TextRun { bbox, run } => {
                self.mix_u8(1);
                self.mix_bbox(bbox);
                self.mix_text_run(run);
            }
            PaintOp::FootnoteMarker { bbox, marker } => {
                self.mix_u8(2);
                self.mix_bbox(bbox);
                self.mix_str(&marker.text);
                self.mix_str(&marker.font_family);
                self.mix_f64(marker.base_font_size);
                self.mix_u32(marker.color);
            }
            PaintOp::Line { bbox, line } => {
                self.mix_u8(3);
                self.mix_bbox(bbox);
                self.mix_f64(line.x1);
                self.mix_f64(line.y1);
                self.mix_f64(line.x2);
                self.mix_f64(line.y2);
                self.mix_line_style(&line.style);
                self.mix_transform(&line.transform);
            }
            PaintOp::Rectangle { bbox, rect } => {
                self.mix_u8(4);
                self.mix_bbox(bbox);
                self.mix_f64(rect.corner_radius);
                self.mix_shape_style(&rect.style);
                self.mix_gradient(rect.gradient.as_deref());
                self.mix_transform(&rect.transform);
            }
            PaintOp::Ellipse { bbox, ellipse } => {
                self.mix_u8(5);
                self.mix_bbox(bbox);
                self.mix_shape_style(&ellipse.style);
                self.mix_gradient(ellipse.gradient.as_deref());
                self.mix_transform(&ellipse.transform);
            }
            PaintOp::Path { bbox, path } => {
                self.mix_u8(6);
                self.mix_bbox(bbox);
                self.mix_usize(path.commands.len());
                for command in &path.commands {
                    self.mix_path_command(command);
                }
                self.mix_shape_style(&path.style);
                self.mix_gradient(path.gradient.as_deref());
                self.mix_transform(&path.transform);
                match path.connector_endpoints {
                    Some((x1, y1, x2, y2)) => {
                        self.mix_bool(true);
                        self.mix_f64(x1);
                        self.mix_f64(y1);
                        self.mix_f64(x2);
                        self.mix_f64(y2);
                    }
                    None => self.mix_bool(false),
                }
                match &path.line_style {
                    Some(line_style) => {
                        self.mix_bool(true);
                        self.mix_line_style(line_style);
                    }
                    None => self.mix_bool(false),
                }
            }
            PaintOp::Image { bbox, image } => {
                self.mix_u8(7);
                self.mix_bbox(bbox);
                self.mix_image_resource(resources, image.resource_id);
                match image.fill_mode {
                    Some(fill_mode) => {
                        self.mix_bool(true);
                        self.mix_image_fill_mode(fill_mode);
                    }
                    None => self.mix_bool(false),
                }
                match image.original_size {
                    Some((width, height)) => {
                        self.mix_bool(true);
                        self.mix_f64(width);
                        self.mix_f64(height);
                    }
                    None => self.mix_bool(false),
                }
                match image.crop {
                    Some((left, top, right, bottom)) => {
                        self.mix_bool(true);
                        self.mix_i32(left);
                        self.mix_i32(top);
                        self.mix_i32(right);
                        self.mix_i32(bottom);
                    }
                    None => self.mix_bool(false),
                }
                self.mix_image_effect(image.effect);
                self.mix_transform(&image.transform);
            }
            PaintOp::Equation { bbox, equation } => {
                self.mix_u8(8);
                self.mix_bbox(bbox);
                self.mix_svg_resource(resources, equation.svg_resource_id);
                self.mix_f64(equation.layout_box.x);
                self.mix_f64(equation.layout_box.y);
                self.mix_f64(equation.layout_box.width);
                self.mix_f64(equation.layout_box.height);
                self.mix_f64(equation.layout_box.baseline);
                self.mix_str(&equation.color_str);
                self.mix_u32(equation.color);
                self.mix_f64(equation.font_size);
            }
            PaintOp::FormObject { bbox, form } => {
                self.mix_u8(9);
                self.mix_bbox(bbox);
                self.mix_form_type(form.form_type);
                self.mix_str(&form.caption);
                self.mix_str(&form.text);
                self.mix_str(&form.fore_color);
                self.mix_str(&form.back_color);
                self.mix_i32(form.value);
                self.mix_bool(form.enabled);
            }
        }
    }

    fn mix_text_run(&mut self, run: &LayerTextRunPaint) {
        self.mix_str(&run.text);
        self.mix_text_style(&run.style);
        self.mix_usize(run.positions.len());
        for position in &run.positions {
            self.mix_f64(*position);
        }
        self.mix_usize(run.control_marks.len());
        for mark in &run.control_marks {
            self.mix_text_control_mark_kind(mark.kind);
            self.mix_f64(mark.x);
            self.mix_f64(mark.y);
            self.mix_f64(mark.font_size);
        }
        self.mix_f64(run.baseline);
        self.mix_f64(run.rotation);
        self.mix_bool(run.is_vertical);
        self.mix_text_orientation(run.orientation);
        match &run.char_overlap {
            Some(char_overlap) => {
                self.mix_bool(true);
                self.mix_u8(char_overlap.border_type);
                self.mix_u8(char_overlap.inner_char_size as u8);
            }
            None => self.mix_bool(false),
        }
        self.mix_field_marker(run.field_marker);
        self.mix_bool(run.is_para_end);
        self.mix_bool(run.is_line_break_end);
    }

    fn mix_text_style(&mut self, style: &TextStyle) {
        self.mix_str(&style.font_family);
        self.mix_f64(style.font_size);
        self.mix_u32(style.color);
        self.mix_bool(style.bold);
        self.mix_bool(style.italic);
        self.mix_underline(style.underline);
        self.mix_bool(style.strikethrough);
        self.mix_f64(style.letter_spacing);
        self.mix_f64(style.ratio);
        self.mix_f64(style.default_tab_width);
        self.mix_usize(style.tab_stops.len());
        for tab_stop in &style.tab_stops {
            self.mix_tab_stop(tab_stop);
        }
        self.mix_bool(style.auto_tab_right);
        self.mix_f64(style.available_width);
        self.mix_f64(style.line_x_offset);
        self.mix_usize(style.tab_leaders.len());
        for tab_leader in &style.tab_leaders {
            self.mix_tab_leader(tab_leader);
        }
        self.mix_usize(style.inline_tabs.len());
        for inline_tab in &style.inline_tabs {
            for value in inline_tab {
                self.mix_u16(*value);
            }
        }
        self.mix_f64(style.extra_word_spacing);
        self.mix_f64(style.extra_char_spacing);
        self.mix_u8(style.outline_type);
        self.mix_u8(style.shadow_type);
        self.mix_u32(style.shadow_color);
        self.mix_f64(style.shadow_offset_x);
        self.mix_f64(style.shadow_offset_y);
        self.mix_bool(style.emboss);
        self.mix_bool(style.engrave);
        self.mix_bool(style.superscript);
        self.mix_bool(style.subscript);
        self.mix_u8(style.emphasis_dot);
        self.mix_u8(style.underline_shape);
        self.mix_u8(style.strike_shape);
        self.mix_u32(style.underline_color);
        self.mix_u32(style.strike_color);
        self.mix_u32(style.shade_color);
    }

    fn mix_tab_stop(&mut self, tab_stop: &TabStop) {
        self.mix_f64(tab_stop.position);
        self.mix_u8(tab_stop.tab_type);
        self.mix_u8(tab_stop.fill_type);
    }

    fn mix_tab_leader(&mut self, tab_leader: &TabLeaderInfo) {
        self.mix_f64(tab_leader.start_x);
        self.mix_f64(tab_leader.end_x);
        self.mix_u8(tab_leader.fill_type);
    }

    fn mix_shape_style(&mut self, style: &ShapeStyle) {
        self.mix_option_u32(style.fill_color);
        match &style.pattern {
            Some(pattern) => {
                self.mix_bool(true);
                self.mix_i32(pattern.pattern_type);
                self.mix_u32(pattern.pattern_color);
                self.mix_u32(pattern.background_color);
            }
            None => self.mix_bool(false),
        }
        self.mix_option_u32(style.stroke_color);
        self.mix_f64(style.stroke_width);
        self.mix_stroke_dash(style.stroke_dash);
        self.mix_f64(style.opacity);
        self.mix_shadow(style.shadow.as_ref());
    }

    fn mix_shadow(&mut self, shadow: Option<&crate::renderer::ShadowStyle>) {
        match shadow {
            Some(shadow) => {
                self.mix_bool(true);
                self.mix_u32(shadow.shadow_type);
                self.mix_u32(shadow.color);
                self.mix_f64(shadow.offset_x);
                self.mix_f64(shadow.offset_y);
                self.mix_u8(shadow.alpha);
            }
            None => self.mix_bool(false),
        }
    }

    fn mix_line_style(&mut self, style: &LineStyle) {
        self.mix_u32(style.color);
        self.mix_f64(style.width);
        self.mix_stroke_dash(style.dash);
        self.mix_line_render_type(style.line_type);
        self.mix_arrow_style(style.start_arrow);
        self.mix_arrow_style(style.end_arrow);
        self.mix_u8(style.start_arrow_size);
        self.mix_u8(style.end_arrow_size);
        self.mix_shadow(style.shadow.as_ref());
    }

    fn mix_gradient(&mut self, gradient: Option<&GradientFillInfo>) {
        match gradient {
            Some(gradient) => {
                self.mix_bool(true);
                self.mix_i16(gradient.gradient_type);
                self.mix_i16(gradient.angle);
                self.mix_i16(gradient.center_x);
                self.mix_i16(gradient.center_y);
                self.mix_usize(gradient.colors.len());
                for color in &gradient.colors {
                    self.mix_u32(*color);
                }
                self.mix_usize(gradient.positions.len());
                for position in &gradient.positions {
                    self.mix_f64(*position);
                }
            }
            None => self.mix_bool(false),
        }
    }

    fn mix_path_command(&mut self, command: &PathCommand) {
        match command {
            PathCommand::MoveTo(x, y) => {
                self.mix_u8(0);
                self.mix_f64(*x);
                self.mix_f64(*y);
            }
            PathCommand::LineTo(x, y) => {
                self.mix_u8(1);
                self.mix_f64(*x);
                self.mix_f64(*y);
            }
            PathCommand::CurveTo(x1, y1, x2, y2, x3, y3) => {
                self.mix_u8(2);
                self.mix_f64(*x1);
                self.mix_f64(*y1);
                self.mix_f64(*x2);
                self.mix_f64(*y2);
                self.mix_f64(*x3);
                self.mix_f64(*y3);
            }
            PathCommand::ArcTo(rx, ry, x_rotation, large_arc, sweep, x, y) => {
                self.mix_u8(3);
                self.mix_f64(*rx);
                self.mix_f64(*ry);
                self.mix_f64(*x_rotation);
                self.mix_bool(*large_arc);
                self.mix_bool(*sweep);
                self.mix_f64(*x);
                self.mix_f64(*y);
            }
            PathCommand::ClosePath => self.mix_u8(4),
        }
    }

    fn mix_image_resource(
        &mut self,
        resources: &ResourceArena,
        resource_id: Option<ImageResourceId>,
    ) {
        match resource_id.and_then(|id| resources.image_bytes(id).map(|bytes| (id, bytes))) {
            Some((id, bytes)) => {
                self.mix_bool(true);
                self.mix_usize(bytes.len());
                match resources.image_hash(id) {
                    Some(hash) => {
                        self.mix_bool(true);
                        self.mix_u64(hash);
                    }
                    None => self.mix_bool(false),
                }
            }
            None => self.mix_bool(false),
        }
    }

    fn mix_svg_resource(&mut self, resources: &ResourceArena, resource_id: SvgResourceId) {
        match resources.svg_fragment(resource_id) {
            Some(fragment) => {
                self.mix_bool(true);
                self.mix_usize(fragment.len());
                match resources.svg_hash(resource_id) {
                    Some(hash) => {
                        self.mix_bool(true);
                        self.mix_u64(hash);
                    }
                    None => self.mix_bool(false),
                }
            }
            None => self.mix_bool(false),
        }
    }

    fn mix_text_control_mark_kind(&mut self, kind: LayerTextControlMarkKind) {
        self.mix_u8(match kind {
            LayerTextControlMarkKind::Space => 0,
            LayerTextControlMarkKind::Tab => 1,
            LayerTextControlMarkKind::ParagraphEnd => 2,
            LayerTextControlMarkKind::LineBreakEnd => 3,
        });
    }

    fn mix_text_orientation(&mut self, orientation: LayerTextOrientation) {
        self.mix_u8(match orientation {
            LayerTextOrientation::Horizontal => 0,
            LayerTextOrientation::VerticalUpright => 1,
            LayerTextOrientation::VerticalSideways => 2,
        });
    }

    fn mix_field_marker(&mut self, field_marker: FieldMarkerType) {
        match field_marker {
            FieldMarkerType::None => self.mix_u8(0),
            FieldMarkerType::FieldBegin => self.mix_u8(1),
            FieldMarkerType::FieldEnd => self.mix_u8(2),
            FieldMarkerType::FieldBeginEnd => self.mix_u8(3),
            FieldMarkerType::ShapeMarker(index) => {
                self.mix_u8(4);
                self.mix_usize(index);
            }
        }
    }

    fn mix_underline(&mut self, underline: UnderlineType) {
        self.mix_u8(match underline {
            UnderlineType::None => 0,
            UnderlineType::Bottom => 1,
            UnderlineType::Top => 2,
        });
    }

    fn mix_stroke_dash(&mut self, dash: StrokeDash) {
        self.mix_u8(match dash {
            StrokeDash::Solid => 0,
            StrokeDash::Dash => 1,
            StrokeDash::Dot => 2,
            StrokeDash::DashDot => 3,
            StrokeDash::DashDotDot => 4,
        });
    }

    fn mix_line_render_type(&mut self, line_type: LineRenderType) {
        self.mix_u8(match line_type {
            LineRenderType::Single => 0,
            LineRenderType::Double => 1,
            LineRenderType::ThinThickDouble => 2,
            LineRenderType::ThickThinDouble => 3,
            LineRenderType::ThinThickThinTriple => 4,
        });
    }

    fn mix_arrow_style(&mut self, arrow_style: ArrowStyle) {
        self.mix_u8(match arrow_style {
            ArrowStyle::None => 0,
            ArrowStyle::Arrow => 1,
            ArrowStyle::ConcaveArrow => 2,
            ArrowStyle::OpenDiamond => 3,
            ArrowStyle::OpenCircle => 4,
            ArrowStyle::OpenSquare => 5,
            ArrowStyle::Diamond => 6,
            ArrowStyle::Circle => 7,
            ArrowStyle::Square => 8,
        });
    }

    fn mix_image_fill_mode(&mut self, fill_mode: ImageFillMode) {
        self.mix_u8(match fill_mode {
            ImageFillMode::TileAll => 0,
            ImageFillMode::TileHorzTop => 1,
            ImageFillMode::TileHorzBottom => 2,
            ImageFillMode::TileVertLeft => 3,
            ImageFillMode::TileVertRight => 4,
            ImageFillMode::FitToSize => 5,
            ImageFillMode::Center => 6,
            ImageFillMode::CenterTop => 7,
            ImageFillMode::CenterBottom => 8,
            ImageFillMode::LeftCenter => 9,
            ImageFillMode::LeftTop => 10,
            ImageFillMode::LeftBottom => 11,
            ImageFillMode::RightCenter => 12,
            ImageFillMode::RightTop => 13,
            ImageFillMode::RightBottom => 14,
            ImageFillMode::None => 15,
        });
    }

    fn mix_image_effect(&mut self, effect: ImageEffect) {
        self.mix_u8(match effect {
            ImageEffect::RealPic => 0,
            ImageEffect::GrayScale => 1,
            ImageEffect::BlackWhite => 2,
            ImageEffect::Pattern8x8 => 3,
        });
    }

    fn mix_form_type(&mut self, form_type: FormType) {
        self.mix_u8(match form_type {
            FormType::PushButton => 0,
            FormType::CheckBox => 1,
            FormType::ComboBox => 2,
            FormType::RadioButton => 3,
            FormType::Edit => 4,
        });
    }
}

fn raster_dimension(length: f64, scale: f64, max_dimension: i32) -> LayerRenderResult<i32> {
    if !length.is_finite() {
        return Err(LayerRenderError::invalid_options(format!(
            "non-finite raster dimension: {length}"
        )));
    }
    if length <= 0.0 {
        return Err(LayerRenderError::invalid_options(format!(
            "non-positive raster dimension: {length}"
        )));
    }
    if !scale.is_finite() {
        return Err(LayerRenderError::invalid_options(format!(
            "non-finite raster scale: {scale}"
        )));
    }
    if scale <= 0.0 {
        return Err(LayerRenderError::invalid_options(format!(
            "non-positive raster scale: {scale}"
        )));
    }
    let scaled = length * scale;
    if !scaled.is_finite() {
        return Err(LayerRenderError::invalid_options(format!(
            "non-finite scaled raster dimension: {scaled}"
        )));
    }
    let rounded = scaled.round();
    if max_dimension <= 0 {
        return Err(LayerRenderError::invalid_options(format!(
            "non-positive max raster dimension: {max_dimension}",
        )));
    }
    if rounded > f64::from(max_dimension) {
        return Err(LayerRenderError::invalid_options(format!(
            "raster dimension {rounded} exceeds max {max_dimension}"
        )));
    }
    Ok(rounded.max(1.0) as i32)
}

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

fn draw_arrow_head(
    canvas: &Canvas,
    tip_x: f64,
    tip_y: f64,
    dir_x: f64,
    dir_y: f64,
    arrow_w: f64,
    arrow_h: f64,
    arrow_style: ArrowStyle,
    color: u32,
    stroke_width: f64,
) {
    let along_x = -dir_x;
    let along_y = -dir_y;
    let perp_x = dir_y;
    let perp_y = -dir_x;
    let half_h = arrow_h / 2.0;
    let to_world = |along: f64, perp: f64| -> (f32, f32) {
        (
            (tip_x + along * along_x + perp * perp_x) as f32,
            (tip_y + along * along_y + perp * perp_y) as f32,
        )
    };

    let mut fill = Paint::default();
    fill.set_anti_alias(true);
    fill.set_style(skia_safe::paint::Style::Fill);
    fill.set_color(colorref_to_skia(color, 1.0));

    let mut stroke = Paint::default();
    stroke.set_anti_alias(true);
    stroke.set_style(skia_safe::paint::Style::Stroke);
    stroke.set_stroke_width((stroke_width * 0.3).max(0.5) as f32);
    stroke.set_color(colorref_to_skia(color, 1.0));

    let mut open_fill = Paint::default();
    open_fill.set_anti_alias(true);
    open_fill.set_style(skia_safe::paint::Style::Fill);
    open_fill.set_color(Color::WHITE);

    match arrow_style {
        ArrowStyle::Arrow => {
            let (bx1, by1) = to_world(arrow_w, -half_h);
            let (bx2, by2) = to_world(arrow_w, half_h);
            let mut path = PathBuilder::new();
            path.move_to((tip_x as f32, tip_y as f32));
            path.line_to((bx1, by1));
            path.line_to((bx2, by2));
            path.close();
            canvas.draw_path(&path.detach(), &fill);
        }
        ArrowStyle::ConcaveArrow => {
            let concave = arrow_w * 0.3;
            let (bx1, by1) = to_world(arrow_w, -half_h);
            let (bx2, by2) = to_world(arrow_w, half_h);
            let (cx, cy) = to_world(arrow_w - concave, 0.0);
            let mut path = PathBuilder::new();
            path.move_to((tip_x as f32, tip_y as f32));
            path.line_to((bx1, by1));
            path.line_to((cx, cy));
            path.line_to((bx2, by2));
            path.close();
            canvas.draw_path(&path.detach(), &fill);
        }
        ArrowStyle::Diamond | ArrowStyle::OpenDiamond => {
            let half_w = arrow_w / 2.0;
            let (px1, py1) = to_world(0.0, 0.0);
            let (px2, py2) = to_world(half_w, -half_h);
            let (px3, py3) = to_world(arrow_w, 0.0);
            let (px4, py4) = to_world(half_w, half_h);
            let mut path = PathBuilder::new();
            path.move_to((px1, py1));
            path.line_to((px2, py2));
            path.line_to((px3, py3));
            path.line_to((px4, py4));
            path.close();
            let path = path.detach();
            if arrow_style == ArrowStyle::Diamond {
                canvas.draw_path(&path, &fill);
            } else {
                canvas.draw_path(&path, &open_fill);
                canvas.draw_path(&path, &stroke);
            }
        }
        ArrowStyle::Circle | ArrowStyle::OpenCircle => {
            let (cx, cy) = to_world(arrow_w / 2.0, 0.0);
            let rect = Rect::from_xywh(
                cx - (arrow_w as f32 * 0.4),
                cy - (half_h as f32 * 0.8),
                arrow_w as f32 * 0.8,
                arrow_h as f32 * 0.8,
            );
            if arrow_style == ArrowStyle::Circle {
                canvas.draw_oval(rect, &fill);
            } else {
                canvas.draw_oval(rect, &open_fill);
                canvas.draw_oval(rect, &stroke);
            }
        }
        ArrowStyle::Square | ArrowStyle::OpenSquare => {
            let (px1, py1) = to_world(0.0, -half_h);
            let (px2, py2) = to_world(arrow_w, -half_h);
            let (px3, py3) = to_world(arrow_w, half_h);
            let (px4, py4) = to_world(0.0, half_h);
            let mut path = PathBuilder::new();
            path.move_to((px1, py1));
            path.line_to((px2, py2));
            path.line_to((px3, py3));
            path.line_to((px4, py4));
            path.close();
            let path = path.detach();
            if arrow_style == ArrowStyle::Square {
                canvas.draw_path(&path, &fill);
            } else {
                canvas.draw_path(&path, &open_fill);
                canvas.draw_path(&path, &stroke);
            }
        }
        ArrowStyle::None => {}
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct SvgResourceCacheKey {
    resource_id: SvgResourceId,
    width_bits: u32,
    height_bits: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct SvgFragmentCacheKey {
    fragment: String,
    width_bits: u32,
    height_bits: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct SkiaReplayPolicy {
    image_sampling: ImageSampling,
    vector_antialias: bool,
    clip_antialias: bool,
    prefer_direct_text: bool,
}

struct SkiaReplayContext {
    profile: RenderProfile,
    output_options: LayerOutputOptions,
    scale: f64,
    diagnostics: LayerRenderDiagnostics,
    cache_hints: Vec<CacheHint>,
    image_cache: HashMap<ImageResourceId, Option<Image>>,
    svg_resource_cache: HashMap<SvgResourceCacheKey, Option<Image>>,
    svg_fragment_cache: HashMap<SvgFragmentCacheKey, Option<Image>>,
}

impl SkiaReplayContext {
    fn new(profile: RenderProfile, output_options: LayerOutputOptions, scale: f64) -> Self {
        Self {
            profile,
            output_options,
            scale,
            diagnostics: LayerRenderDiagnostics::default(),
            cache_hints: Vec::new(),
            image_cache: HashMap::new(),
            svg_resource_cache: HashMap::new(),
            svg_fragment_cache: HashMap::new(),
        }
    }

    fn push_cache_hint(&mut self, cache_hint: CacheHint) {
        self.cache_hints.push(cache_hint);
    }

    fn pop_cache_hint(&mut self) {
        self.cache_hints.pop();
    }

    fn record_image_draw(&mut self, diagnostics: ImageDrawDiagnostics) {
        self.diagnostics.tile_fallback_cap_hits = self
            .diagnostics
            .tile_fallback_cap_hits
            .saturating_add(diagnostics.tile_fallback_cap_hits);
    }

    fn has_cache_hint(&self, cache_hint: CacheHint) -> bool {
        self.cache_hints.contains(&cache_hint)
    }

    fn replay_policy(&self) -> SkiaReplayPolicy {
        let prefer_raster = self.has_cache_hint(CacheHint::PreferRaster);
        let prefer_vector = self.has_cache_hint(CacheHint::PreferVectorRecording);
        let image_sampling = if self.profile == RenderProfile::FastPreview || prefer_raster {
            ImageSampling::nearest()
        } else if matches!(
            self.profile,
            RenderProfile::Print | RenderProfile::HighQuality
        ) || prefer_vector
        {
            ImageSampling::linear_mipmap()
        } else {
            ImageSampling::linear()
        };

        SkiaReplayPolicy {
            image_sampling,
            vector_antialias: self.profile != RenderProfile::FastPreview || !prefer_raster,
            clip_antialias: self.profile != RenderProfile::FastPreview || !prefer_raster,
            prefer_direct_text: true,
        }
    }

    fn image_sampling(&self) -> ImageSampling {
        self.replay_policy().image_sampling
    }

    fn clip_antialias(&self) -> bool {
        self.replay_policy().clip_antialias
    }

    fn image_for_resource(&mut self, resource_id: ImageResourceId, bytes: &[u8]) -> Option<Image> {
        if let Some(image) = self.image_cache.get(&resource_id) {
            return image.clone();
        }
        let image = decode_image_bytes(bytes);
        self.image_cache.insert(resource_id, image.clone());
        image
    }

    fn svg_image_for_resource(
        &mut self,
        resource_id: SvgResourceId,
        fragment: &str,
        width: f32,
        height: f32,
    ) -> Option<Image> {
        let key = SvgResourceCacheKey {
            resource_id,
            width_bits: width.to_bits(),
            height_bits: height.to_bits(),
        };
        if let Some(image) = self.svg_resource_cache.get(&key) {
            return image.clone();
        }
        let image = rasterize_svg_fragment(fragment, width, height);
        self.svg_resource_cache.insert(key, image.clone());
        image
    }

    fn svg_image_for_fragment(&mut self, fragment: &str, width: f32, height: f32) -> Option<Image> {
        let key = SvgFragmentCacheKey {
            fragment: fragment.to_string(),
            width_bits: width.to_bits(),
            height_bits: height.to_bits(),
        };
        if let Some(image) = self.svg_fragment_cache.get(&key) {
            return image.clone();
        }
        let image = rasterize_svg_fragment(fragment, width, height);
        self.svg_fragment_cache.insert(key, image.clone());
        image
    }
}

impl SkiaLayerRenderer {
    pub fn new() -> Self {
        let font_mgr = FontMgr::default();
        let text_shaper = Shaper::new(Some(font_mgr.clone()));
        Self {
            font_mgr,
            text_shaper,
            static_picture_cache: RefCell::new(StaticPictureCache::new(
                MAX_STATIC_PICTURE_CACHE_ENTRIES,
                MAX_STATIC_PICTURE_CACHE_BYTES,
            )),
        }
    }

    pub fn render_png(&self, tree: &PageLayerTree) -> LayerRenderResult<Vec<u8>> {
        self.render_png_with_options(tree, RasterRenderOptions::default())
    }

    pub fn render_png_with_options(
        &self,
        tree: &PageLayerTree,
        options: RasterRenderOptions,
    ) -> LayerRenderResult<Vec<u8>> {
        self.render_raster_with_options(tree, options)
            .map(|output| output.bytes)
    }

    pub fn render_raster_with_options(
        &self,
        tree: &PageLayerTree,
        options: RasterRenderOptions,
    ) -> LayerRenderResult<RasterRenderOutput> {
        if let Some(dpi) = options.dpi {
            if !dpi.is_finite() || dpi <= 0.0 {
                return Err(LayerRenderError::invalid_options(format!(
                    "invalid raster dpi: {dpi}"
                )));
            }
        }
        if options.format != RasterOutputFormat::Png {
            return Err(LayerRenderError::invalid_options(
                "Skia raster renderer currently supports PNG output",
            ));
        }
        let width = raster_dimension(tree.page_width, options.scale, options.max_dimension)?;
        let height = raster_dimension(tree.page_height, options.scale, options.max_dimension)?;
        let mut surface = surfaces::raster_n32_premul((width, height))
            .ok_or_else(|| LayerRenderError::surface_creation("Skia raster surface 생성 실패"))?;
        let canvas = surface.canvas();
        let clear_color = if let Some(color) = options.background_color {
            colorref_to_skia(color, 1.0)
        } else if options.transparent {
            Color::from_argb(0, 0, 0, 0)
        } else {
            Color::WHITE
        };
        canvas.clear(clear_color);
        if options.scale != 1.0 {
            canvas.scale((options.scale as f32, options.scale as f32));
        }
        let mut replay = SkiaReplayContext::new(tree.profile, tree.output_options, options.scale);
        self.render_node(canvas, &tree.root, &tree.resources, &mut replay);
        let image = surface.image_snapshot();
        let data = image
            .encode(None, EncodedImageFormat::PNG, None)
            .ok_or_else(|| LayerRenderError::encoding("Skia PNG 인코딩 실패"))?;
        Ok(RasterRenderOutput {
            bytes: data.as_bytes().to_vec(),
            format: RasterOutputFormat::Png,
            width,
            height,
            dpi: options.dpi,
            color_space: options.color_space,
            diagnostics: replay.diagnostics,
        })
    }

    fn render_node(
        &self,
        canvas: &Canvas,
        node: &LayerNode,
        resources: &ResourceArena,
        replay: &mut SkiaReplayContext,
    ) {
        match &node.kind {
            LayerNodeKind::Group {
                children,
                cache_hint,
            } => {
                if *cache_hint == CacheHint::StaticSubtree
                    && node.bounds.width > 0.0
                    && node.bounds.height > 0.0
                    && node.bounds.x.is_finite()
                    && node.bounds.y.is_finite()
                    && node.bounds.width.is_finite()
                    && node.bounds.height.is_finite()
                {
                    let mut cache_key = StaticSubtreeCacheKey::new();
                    cache_key.mix_str(replay.profile.as_str());
                    cache_key.mix_output_options(&replay.output_options);
                    cache_key.mix_f64(replay.scale);
                    cache_key.mix_layer_node(node, resources);
                    let cache_key = cache_key.finish();
                    if let Some(picture) = self.static_picture_cache.borrow_mut().get(cache_key) {
                        canvas.draw_picture(&picture, None, None);
                        return;
                    }

                    let cull_rect = Rect::from_xywh(
                        node.bounds.x as f32,
                        node.bounds.y as f32,
                        node.bounds.width as f32,
                        node.bounds.height as f32,
                    );
                    let mut recorder = PictureRecorder::new();
                    let recording_canvas = recorder.begin_recording(cull_rect, true);
                    replay.push_cache_hint(*cache_hint);
                    for child in children {
                        self.render_node(recording_canvas, child, resources, replay);
                    }
                    replay.pop_cache_hint();
                    if let Some(picture) = recorder.finish_recording_as_picture(Some(&cull_rect)) {
                        canvas.draw_picture(&picture, None, None);
                        let scaled_width = (node.bounds.width * replay.scale).abs().ceil();
                        let scaled_height = (node.bounds.height * replay.scale).abs().ceil();
                        let approx_bytes = if scaled_width.is_finite() && scaled_height.is_finite()
                        {
                            (scaled_width.max(1.0) * scaled_height.max(1.0) * 4.0)
                                .min(usize::MAX as f64) as usize
                        } else {
                            MAX_STATIC_PICTURE_CACHE_BYTES.saturating_add(1)
                        };
                        self.static_picture_cache.borrow_mut().insert(
                            cache_key,
                            picture,
                            approx_bytes,
                        );
                        return;
                    }
                }

                replay.push_cache_hint(*cache_hint);
                for child in children {
                    self.render_node(canvas, child, resources, replay);
                }
                replay.pop_cache_hint();
            }
            LayerNodeKind::ClipRect {
                clip,
                child,
                clip_policy,
                ..
            } => {
                if !replay.output_options.clip_enabled {
                    self.render_node(canvas, child, resources, replay);
                    return;
                }
                canvas.save();
                canvas.clip_rect(
                    Rect::from_xywh(
                        clip.x as f32,
                        clip.y as f32,
                        (clip.width + clip_policy.right_overflow_slop) as f32,
                        clip.height as f32,
                    ),
                    None,
                    Some(replay.clip_antialias()),
                );
                self.render_node(canvas, child, resources, replay);
                canvas.restore();
            }
            LayerNodeKind::Leaf { ops, cache_hint } => {
                replay.push_cache_hint(*cache_hint);
                for op in ops {
                    self.render_op(canvas, op, resources, replay);
                }
                replay.pop_cache_hint();
            }
        }
    }

    fn render_op(
        &self,
        canvas: &Canvas,
        op: &PaintOp,
        resources: &ResourceArena,
        replay: &mut SkiaReplayContext,
    ) {
        match op {
            PaintOp::PageBackground { bbox, background } => {
                let background_rect = Rect::from_xywh(
                    bbox.x as f32,
                    bbox.y as f32,
                    bbox.width as f32,
                    bbox.height as f32,
                );
                if let Some(fill) = make_background_fill_paint(
                    background_rect,
                    background.background_color,
                    background.gradient.as_deref(),
                ) {
                    canvas.draw_rect(background_rect, &fill);
                }
                if let Some(image) = &background.image {
                    if let Some(bytes) = resources.image_bytes(image.resource_id) {
                        if let Some(decoded) = replay.image_for_resource(image.resource_id, bytes) {
                            let diagnostics = draw_decoded_image(
                                canvas,
                                &decoded,
                                bbox.x as f32,
                                bbox.y as f32,
                                bbox.width as f32,
                                bbox.height as f32,
                                Some(image.fill_mode),
                                None,
                                None,
                                crate::model::image::ImageEffect::RealPic,
                                replay.image_sampling(),
                            );
                            replay.record_image_draw(diagnostics);
                        } else {
                            draw_missing_image_placeholder(
                                canvas,
                                bbox.x as f32,
                                bbox.y as f32,
                                bbox.width as f32,
                                bbox.height as f32,
                            );
                        }
                    }
                }
                if let Some(border) = background.border_color {
                    let mut paint = Paint::default();
                    paint.set_anti_alias(true);
                    paint.set_style(skia_safe::paint::Style::Stroke);
                    paint.set_stroke_width(if background.border_width > 0.0 {
                        background.border_width as f32
                    } else {
                        1.0
                    });
                    paint.set_color(colorref_to_skia(border, 1.0));
                    canvas.draw_rect(
                        Rect::from_xywh(
                            bbox.x as f32,
                            bbox.y as f32,
                            bbox.width as f32,
                            bbox.height as f32,
                        ),
                        &paint,
                    );
                }
            }
            PaintOp::TextRun { bbox, run } => {
                let rotation = run.rotation;
                if rotation != 0.0 {
                    let cx = (bbox.x + bbox.width / 2.0) as f32;
                    let cy = (bbox.y + bbox.height / 2.0) as f32;
                    canvas.save();
                    canvas.rotate(rotation as f32, Some((cx, cy).into()));
                    self.render_text_run(canvas, bbox, run, replay);
                    canvas.restore();
                } else {
                    self.render_text_run(canvas, bbox, run, replay);
                }
            }
            PaintOp::FootnoteMarker { bbox, marker } => {
                let mut font = make_font(
                    &crate::renderer::TextStyle {
                        font_family: marker.font_family.clone(),
                        font_size: (marker.base_font_size * 0.55).max(7.0),
                        color: marker.color,
                        ..Default::default()
                    },
                    &self.font_mgr,
                    &marker.text,
                );
                font.set_size((marker.base_font_size * 0.55).max(7.0) as f32);
                let mut paint = Paint::default();
                paint.set_anti_alias(true);
                paint.set_color(colorref_to_skia(marker.color, 1.0));
                canvas.draw_str(
                    &marker.text,
                    (bbox.x as f32, (bbox.y + bbox.height * 0.4) as f32),
                    &font,
                    &paint,
                );
            }
            PaintOp::Line { bbox, line } => {
                self.with_shape_transform(canvas, line.transform, Some(*bbox), |canvas| {
                    let mut x1 = line.x1;
                    let mut y1 = line.y1;
                    let mut x2 = line.x2;
                    let mut y2 = line.y2;
                    let dx = x2 - x1;
                    let dy = y2 - y1;
                    let line_len = (dx * dx + dy * dy).sqrt();
                    let width = line.style.width.max(0.5);

                    if line_len > 0.0 {
                        let ux = dx / line_len;
                        let uy = dy / line_len;
                        if line.style.start_arrow != ArrowStyle::None {
                            let (arrow_w, arrow_h) =
                                calc_arrow_dims(width, line_len, line.style.start_arrow_size);
                            draw_arrow_head(
                                canvas,
                                x1,
                                y1,
                                -ux,
                                -uy,
                                arrow_w,
                                arrow_h,
                                line.style.start_arrow,
                                line.style.color,
                                width,
                            );
                            x1 += ux * arrow_w;
                            y1 += uy * arrow_w;
                        }
                        if line.style.end_arrow != ArrowStyle::None {
                            let (arrow_w, arrow_h) =
                                calc_arrow_dims(width, line_len, line.style.end_arrow_size);
                            draw_arrow_head(
                                canvas,
                                x2,
                                y2,
                                ux,
                                uy,
                                arrow_w,
                                arrow_h,
                                line.style.end_arrow,
                                line.style.color,
                                width,
                            );
                            x2 -= ux * arrow_w;
                            y2 -= uy * arrow_w;
                        }
                    }

                    let paint = make_line_paint(&line.style);
                    match line.style.line_type {
                        LineRenderType::Double
                        | LineRenderType::ThickThinDouble
                        | LineRenderType::ThinThickDouble
                        | LineRenderType::ThinThickThinTriple => {
                            let line_dx = x2 - x1;
                            let line_dy = y2 - y1;
                            let line_len = (line_dx * line_dx + line_dy * line_dy).sqrt();
                            if line_len > 0.001 {
                                let nx = -line_dy / line_len;
                                let ny = line_dx / line_len;
                                let lines: &[(f64, f64)] = match line.style.line_type {
                                    LineRenderType::Double => &[(0.30, -0.35), (0.30, 0.35)],
                                    LineRenderType::ThickThinDouble => &[(0.4, -0.30), (0.2, 0.40)],
                                    LineRenderType::ThinThickDouble => &[(0.2, -0.40), (0.4, 0.30)],
                                    LineRenderType::ThinThickThinTriple => {
                                        &[(0.15, -0.425), (0.30, 0.0), (0.15, 0.425)]
                                    }
                                    LineRenderType::Single => &[],
                                };
                                for (width_ratio, offset_ratio) in lines {
                                    let mut segment_paint = paint.clone();
                                    segment_paint
                                        .set_stroke_width((width * width_ratio).max(0.3) as f32);
                                    let offset = width * offset_ratio;
                                    let ox = nx * offset;
                                    let oy = ny * offset;
                                    canvas.draw_line(
                                        ((x1 + ox) as f32, (y1 + oy) as f32),
                                        ((x2 + ox) as f32, (y2 + oy) as f32),
                                        &segment_paint,
                                    );
                                }
                            }
                        }
                        LineRenderType::Single => {
                            canvas.draw_line(
                                (x1 as f32, y1 as f32),
                                (x2 as f32, y2 as f32),
                                &paint,
                            );
                        }
                    }
                });
            }
            PaintOp::Rectangle { bbox, rect } => {
                self.with_shape_transform(canvas, rect.transform, Some(*bbox), |canvas| {
                    let sk_rect = Rect::from_xywh(
                        bbox.x as f32,
                        bbox.y as f32,
                        bbox.width as f32,
                        bbox.height as f32,
                    );
                    if let Some(fill) =
                        make_fill_paint(sk_rect, &rect.style, rect.gradient.as_deref())
                    {
                        if rect.corner_radius > 0.0 {
                            canvas.draw_round_rect(
                                sk_rect,
                                rect.corner_radius as f32,
                                rect.corner_radius as f32,
                                &fill,
                            );
                        } else {
                            canvas.draw_rect(sk_rect, &fill);
                        }
                    }
                    if let Some(stroke) = make_stroke_paint(&rect.style) {
                        if rect.corner_radius > 0.0 {
                            canvas.draw_round_rect(
                                sk_rect,
                                rect.corner_radius as f32,
                                rect.corner_radius as f32,
                                &stroke,
                            );
                        } else {
                            canvas.draw_rect(sk_rect, &stroke);
                        }
                    }
                });
            }
            PaintOp::Ellipse { bbox, ellipse } => {
                self.with_shape_transform(canvas, ellipse.transform, Some(*bbox), |canvas| {
                    let oval = Rect::from_xywh(
                        bbox.x as f32,
                        bbox.y as f32,
                        bbox.width as f32,
                        bbox.height as f32,
                    );
                    if let Some(fill) =
                        make_fill_paint(oval, &ellipse.style, ellipse.gradient.as_deref())
                    {
                        canvas.draw_oval(oval, &fill);
                    }
                    if let Some(stroke) = make_stroke_paint(&ellipse.style) {
                        canvas.draw_oval(oval, &stroke);
                    }
                });
            }
            PaintOp::Path { bbox, path } => {
                self.with_shape_transform(canvas, path.transform, Some(*bbox), |canvas| {
                    let sk_path = to_skia_path(&path.commands);
                    let path_bounds = Rect::from_xywh(
                        bbox.x as f32,
                        bbox.y as f32,
                        bbox.width as f32,
                        bbox.height as f32,
                    );
                    if let Some(fill) =
                        make_fill_paint(path_bounds, &path.style, path.gradient.as_deref())
                    {
                        canvas.draw_path(&sk_path, &fill);
                    }
                    if let Some(stroke) = make_stroke_paint(&path.style) {
                        canvas.draw_path(&sk_path, &stroke);
                    }
                    if let (Some(line_style), Some((x1, y1, x2, y2))) =
                        (&path.line_style, path.connector_endpoints)
                    {
                        let len = ((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1))
                            .sqrt()
                            .max(1.0);
                        if line_style.start_arrow != ArrowStyle::None {
                            let mut found = (x1 - x2, y1 - y2);
                            for command in path.commands.iter().skip(1) {
                                let point = match command {
                                    crate::renderer::PathCommand::LineTo(px, py) => {
                                        Some((*px, *py))
                                    }
                                    crate::renderer::PathCommand::CurveTo(cx, cy, _, _, _, _) => {
                                        Some((*cx, *cy))
                                    }
                                    _ => None,
                                };
                                if let Some((px, py)) = point {
                                    if (x1 - px).abs() > 0.5 || (y1 - py).abs() > 0.5 {
                                        found = (x1 - px, y1 - py);
                                        break;
                                    }
                                }
                            }
                            let distance =
                                (found.0 * found.0 + found.1 * found.1).sqrt().max(0.001);
                            let (arrow_w, arrow_h) = calc_arrow_dims(
                                line_style.width.max(0.5),
                                len,
                                line_style.start_arrow_size,
                            );
                            draw_arrow_head(
                                canvas,
                                x1,
                                y1,
                                found.0 / distance,
                                found.1 / distance,
                                arrow_w,
                                arrow_h,
                                line_style.start_arrow,
                                line_style.color,
                                line_style.width.max(0.5),
                            );
                        }
                        if line_style.end_arrow != ArrowStyle::None {
                            let mut points = Vec::new();
                            for command in &path.commands {
                                match command {
                                    crate::renderer::PathCommand::MoveTo(px, py)
                                    | crate::renderer::PathCommand::LineTo(px, py) => {
                                        points.push((*px, *py));
                                    }
                                    crate::renderer::PathCommand::CurveTo(_, _, cx, cy, ex, ey) => {
                                        points.push((*cx, *cy));
                                        points.push((*ex, *ey));
                                    }
                                    _ => {}
                                }
                            }
                            let mut found = (x2 - x1, y2 - y1);
                            for point in points.iter().rev() {
                                let dx = x2 - point.0;
                                let dy = y2 - point.1;
                                if dx.abs() > 0.5 || dy.abs() > 0.5 {
                                    found = (dx, dy);
                                    break;
                                }
                            }
                            let distance =
                                (found.0 * found.0 + found.1 * found.1).sqrt().max(0.001);
                            let (arrow_w, arrow_h) = calc_arrow_dims(
                                line_style.width.max(0.5),
                                len,
                                line_style.end_arrow_size,
                            );
                            draw_arrow_head(
                                canvas,
                                x2,
                                y2,
                                found.0 / distance,
                                found.1 / distance,
                                arrow_w,
                                arrow_h,
                                line_style.end_arrow,
                                line_style.color,
                                line_style.width.max(0.5),
                            );
                        }
                    }
                });
            }
            PaintOp::Image { bbox, image } => {
                self.with_shape_transform(canvas, image.transform, Some(*bbox), |canvas| {
                    if let Some(resource_id) = image.resource_id {
                        if let Some(data) = resources.image_bytes(resource_id) {
                            if let Some(decoded) = replay.image_for_resource(resource_id, data) {
                                let diagnostics = draw_decoded_image(
                                    canvas,
                                    &decoded,
                                    bbox.x as f32,
                                    bbox.y as f32,
                                    bbox.width as f32,
                                    bbox.height as f32,
                                    image.fill_mode,
                                    image.original_size,
                                    image.crop,
                                    image.effect,
                                    replay.image_sampling(),
                                );
                                replay.record_image_draw(diagnostics);
                            } else {
                                draw_missing_image_placeholder(
                                    canvas,
                                    bbox.x as f32,
                                    bbox.y as f32,
                                    bbox.width as f32,
                                    bbox.height as f32,
                                );
                            }
                        } else {
                            draw_missing_image_placeholder(
                                canvas,
                                bbox.x as f32,
                                bbox.y as f32,
                                bbox.width as f32,
                                bbox.height as f32,
                            );
                        }
                    } else {
                        draw_missing_image_placeholder(
                            canvas,
                            bbox.x as f32,
                            bbox.y as f32,
                            bbox.width as f32,
                            bbox.height as f32,
                        );
                    }
                });
            }
            PaintOp::Equation { bbox, equation } => {
                let mut rendered = false;
                if let Some(svg_fragment) = resources.svg_fragment(equation.svg_resource_id) {
                    if let Some(image) = replay.svg_image_for_resource(
                        equation.svg_resource_id,
                        svg_fragment,
                        bbox.width as f32,
                        bbox.height as f32,
                    ) {
                        let diagnostics = draw_decoded_image(
                            canvas,
                            &image,
                            bbox.x as f32,
                            bbox.y as f32,
                            bbox.width as f32,
                            bbox.height as f32,
                            Some(crate::model::style::ImageFillMode::FitToSize),
                            None,
                            None,
                            crate::model::image::ImageEffect::RealPic,
                            replay.image_sampling(),
                        );
                        replay.record_image_draw(diagnostics);
                        rendered = true;
                    }
                }
                if !rendered {
                    render_equation(
                        canvas,
                        &self.font_mgr,
                        &equation.layout_box,
                        bbox.x,
                        bbox.y,
                        equation.color,
                        equation.font_size,
                    );
                }
            }
            PaintOp::FormObject { bbox, form } => self.render_form_object(canvas, bbox, form),
        }
    }

    fn render_form_object(&self, canvas: &Canvas, bbox: &BoundingBox, form: &LayerFormObjectPaint) {
        let parse_css = |value: &str, fallback: Color| {
            if let Some(hex) = value.strip_prefix('#') {
                if hex.len() == 6 {
                    let parsed = (
                        u8::from_str_radix(&hex[0..2], 16),
                        u8::from_str_radix(&hex[2..4], 16),
                        u8::from_str_radix(&hex[4..6], 16),
                    );
                    if let (Ok(r), Ok(g), Ok(b)) = parsed {
                        return Color::from_argb(255, r, g, b);
                    }
                }
            }
            fallback
        };
        let rect = Rect::from_xywh(
            bbox.x as f32,
            bbox.y as f32,
            bbox.width as f32,
            bbox.height as f32,
        );
        let mut text_style = crate::renderer::TextStyle {
            font_family: "Noto Sans CJK KR".to_string(),
            ..Default::default()
        };
        let control_back = parse_css(&form.back_color, Color::WHITE);
        let control_text = if form.enabled {
            parse_css(&form.fore_color, Color::BLACK)
        } else {
            Color::from_argb(255, 128, 128, 128)
        };
        let border_color = if form.enabled {
            Color::from_argb(255, 160, 160, 160)
        } else {
            Color::from_argb(255, 190, 190, 190)
        };

        match form.form_type {
            crate::model::control::FormType::PushButton => {
                let mut fill = Paint::default();
                fill.set_anti_alias(true);
                fill.set_color(if form.back_color.is_empty() {
                    Color::from_argb(255, 208, 208, 208)
                } else {
                    control_back
                });
                canvas.draw_rect(rect, &fill);

                let mut stroke = Paint::default();
                stroke.set_anti_alias(true);
                stroke.set_style(skia_safe::paint::Style::Stroke);
                stroke.set_stroke_width(0.5);
                stroke.set_color(border_color);
                canvas.draw_rect(rect, &stroke);

                if !form.caption.is_empty() {
                    let font_size = (bbox.height * 0.55).clamp(7.0, 12.0);
                    text_style.font_size = font_size;
                    let font =
                        super::paint_conv::make_font(&text_style, &self.font_mgr, &form.caption);
                    let mut paint = Paint::default();
                    paint.set_anti_alias(true);
                    paint.set_color(control_text);
                    let text_width = form.caption.chars().count() as f32 * font_size as f32 * 0.55;
                    canvas.draw_str(
                        &form.caption,
                        (
                            bbox.x as f32 + bbox.width as f32 / 2.0 - text_width / 2.0,
                            bbox.y as f32 + bbox.height as f32 / 2.0 + font_size as f32 * 0.35,
                        ),
                        &font,
                        &paint,
                    );
                }
            }
            crate::model::control::FormType::CheckBox => {
                let box_size = (bbox.height * 0.7).min(13.0) as f32;
                let box_x = bbox.x as f32 + 2.0;
                let box_y = bbox.y as f32 + (bbox.height as f32 - box_size) / 2.0;

                let mut fill = Paint::default();
                fill.set_anti_alias(true);
                fill.set_color(control_back);
                canvas.draw_rect(Rect::from_xywh(box_x, box_y, box_size, box_size), &fill);

                let mut stroke = Paint::default();
                stroke.set_anti_alias(true);
                stroke.set_style(skia_safe::paint::Style::Stroke);
                stroke.set_stroke_width(0.8);
                stroke.set_color(border_color);
                canvas.draw_rect(Rect::from_xywh(box_x, box_y, box_size, box_size), &stroke);

                if form.value != 0 {
                    let mut check = PathBuilder::new();
                    check.move_to((box_x + box_size * 0.2, box_y + box_size * 0.55));
                    check.line_to((box_x + box_size * 0.45, box_y + box_size * 0.8));
                    check.line_to((box_x + box_size * 0.85, box_y + box_size * 0.2));
                    let mut mark = Paint::default();
                    mark.set_anti_alias(true);
                    mark.set_style(skia_safe::paint::Style::Stroke);
                    mark.set_stroke_width(1.5);
                    mark.set_color(control_text);
                    canvas.draw_path(&check.detach(), &mark);
                }

                if !form.caption.is_empty() {
                    let font_size = (bbox.height * 0.55).clamp(7.0, 12.0);
                    text_style.font_size = font_size;
                    let font =
                        super::paint_conv::make_font(&text_style, &self.font_mgr, &form.caption);
                    let mut paint = Paint::default();
                    paint.set_anti_alias(true);
                    paint.set_color(control_text);
                    canvas.draw_str(
                        &form.caption,
                        (
                            box_x + box_size + 3.0,
                            bbox.y as f32 + bbox.height as f32 / 2.0 + font_size as f32 * 0.35,
                        ),
                        &font,
                        &paint,
                    );
                }
            }
            crate::model::control::FormType::RadioButton => {
                let radius = (bbox.height * 0.3).min(6.5) as f32;
                let cx = bbox.x as f32 + 2.0 + radius;
                let cy = bbox.y as f32 + bbox.height as f32 / 2.0;

                let mut fill = Paint::default();
                fill.set_anti_alias(true);
                fill.set_color(control_back);
                canvas.draw_circle((cx, cy), radius, &fill);

                let mut stroke = Paint::default();
                stroke.set_anti_alias(true);
                stroke.set_style(skia_safe::paint::Style::Stroke);
                stroke.set_stroke_width(0.8);
                stroke.set_color(border_color);
                canvas.draw_circle((cx, cy), radius, &stroke);

                if form.value != 0 {
                    let mut dot = Paint::default();
                    dot.set_anti_alias(true);
                    dot.set_color(control_text);
                    canvas.draw_circle((cx, cy), radius * 0.5, &dot);
                }

                if !form.caption.is_empty() {
                    let font_size = (bbox.height * 0.55).clamp(7.0, 12.0);
                    text_style.font_size = font_size;
                    let font =
                        super::paint_conv::make_font(&text_style, &self.font_mgr, &form.caption);
                    let mut paint = Paint::default();
                    paint.set_anti_alias(true);
                    paint.set_color(control_text);
                    canvas.draw_str(
                        &form.caption,
                        (
                            cx + radius + 3.0,
                            bbox.y as f32 + bbox.height as f32 / 2.0 + font_size as f32 * 0.35,
                        ),
                        &font,
                        &paint,
                    );
                }
            }
            crate::model::control::FormType::ComboBox => {
                let btn_w = (bbox.height * 0.8).min(16.0) as f32;
                let mut fill = Paint::default();
                fill.set_anti_alias(true);
                fill.set_color(control_back);
                canvas.draw_rect(rect, &fill);

                let mut stroke = Paint::default();
                stroke.set_anti_alias(true);
                stroke.set_style(skia_safe::paint::Style::Stroke);
                stroke.set_stroke_width(0.8);
                stroke.set_color(border_color);
                canvas.draw_rect(rect, &stroke);

                let button_rect = Rect::from_xywh(
                    bbox.x as f32 + bbox.width as f32 - btn_w,
                    bbox.y as f32,
                    btn_w,
                    bbox.height as f32,
                );
                let mut button_fill = Paint::default();
                button_fill.set_anti_alias(true);
                button_fill.set_color(Color::from_argb(255, 224, 224, 224));
                canvas.draw_rect(button_rect, &button_fill);

                let mut button_stroke = Paint::default();
                button_stroke.set_anti_alias(true);
                button_stroke.set_style(skia_safe::paint::Style::Stroke);
                button_stroke.set_stroke_width(0.5);
                button_stroke.set_color(border_color);
                canvas.draw_rect(button_rect, &button_stroke);

                let arrow_cx = bbox.x as f32 + bbox.width as f32 - btn_w / 2.0;
                let arrow_cy = bbox.y as f32 + bbox.height as f32 / 2.0;
                let arrow_size = (bbox.height * 0.2).min(4.0) as f32;
                let mut arrow = PathBuilder::new();
                arrow.move_to((arrow_cx - arrow_size, arrow_cy - arrow_size * 0.5));
                arrow.line_to((arrow_cx + arrow_size, arrow_cy - arrow_size * 0.5));
                arrow.line_to((arrow_cx, arrow_cy + arrow_size * 0.5));
                arrow.close();
                let mut arrow_paint = Paint::default();
                arrow_paint.set_anti_alias(true);
                arrow_paint.set_color(control_text);
                canvas.draw_path(&arrow.detach(), &arrow_paint);

                if !form.text.is_empty() {
                    let font_size = (bbox.height * 0.55).clamp(7.0, 12.0);
                    text_style.font_size = font_size;
                    let font =
                        super::paint_conv::make_font(&text_style, &self.font_mgr, &form.text);
                    let mut paint = Paint::default();
                    paint.set_anti_alias(true);
                    paint.set_color(control_text);
                    canvas.draw_str(
                        &form.text,
                        (
                            bbox.x as f32 + 3.0,
                            bbox.y as f32 + bbox.height as f32 / 2.0 + font_size as f32 * 0.35,
                        ),
                        &font,
                        &paint,
                    );
                }
            }
            crate::model::control::FormType::Edit => {
                let mut fill = Paint::default();
                fill.set_anti_alias(true);
                fill.set_color(control_back);
                canvas.draw_rect(rect, &fill);

                let mut stroke = Paint::default();
                stroke.set_anti_alias(true);
                stroke.set_style(skia_safe::paint::Style::Stroke);
                stroke.set_stroke_width(0.8);
                stroke.set_color(border_color);
                canvas.draw_rect(rect, &stroke);

                if !form.text.is_empty() {
                    let font_size = (bbox.height * 0.55).clamp(7.0, 12.0);
                    text_style.font_size = font_size;
                    let font =
                        super::paint_conv::make_font(&text_style, &self.font_mgr, &form.text);
                    let mut paint = Paint::default();
                    paint.set_anti_alias(true);
                    paint.set_color(control_text);
                    canvas.draw_str(
                        &form.text,
                        (
                            bbox.x as f32 + 3.0,
                            bbox.y as f32 + bbox.height as f32 / 2.0 + font_size as f32 * 0.35,
                        ),
                        &font,
                        &paint,
                    );
                }
            }
        }
    }

    fn render_text_run(
        &self,
        canvas: &Canvas,
        bbox: &BoundingBox,
        run: &LayerTextRunPaint,
        replay: &mut SkiaReplayContext,
    ) {
        let base_font_size = if run.style.font_size > 0.0 {
            run.style.font_size
        } else {
            12.0
        };
        let mut render_style = run.style.clone();
        let mut y = (bbox.y + run.baseline) as f32;
        if run.style.superscript {
            render_style.font_size = base_font_size * 0.7;
            y -= (base_font_size * 0.3) as f32;
        } else if run.style.subscript {
            render_style.font_size = base_font_size * 0.7;
            y += (base_font_size * 0.15) as f32;
        }

        if let Some(overlap) = &run.char_overlap {
            let chars: Vec<char> = run.text.chars().collect();
            if chars.is_empty() {
                return;
            }

            let box_size = render_style.font_size.max(1.0) as f32;
            let size_ratio = if overlap.inner_char_size > 0 {
                f64::from(overlap.inner_char_size) / 100.0
            } else {
                1.0
            };
            let mut overlap_style = render_style.clone();
            overlap_style.font_size = (render_style.font_size * size_ratio).max(1.0);
            let inner_font_size = overlap_style.font_size as f32;

            let draw_overlap_cell =
                |display: &str, cx: f32, cy: f32, target_text_width: Option<f32>| {
                    let effective_border =
                        if target_text_width.is_some() && overlap.border_type == 0 {
                            1
                        } else {
                            overlap.border_type
                        };
                    let is_reversed = effective_border == 2 || effective_border == 4;
                    let is_circle = effective_border == 1 || effective_border == 2;
                    let is_rect = effective_border == 3 || effective_border == 4;

                    let mut fill = Paint::default();
                    fill.set_anti_alias(true);
                    fill.set_style(skia_safe::paint::Style::Fill);
                    fill.set_color(Color::BLACK);

                    let mut stroke = Paint::default();
                    stroke.set_anti_alias(true);
                    stroke.set_style(skia_safe::paint::Style::Stroke);
                    stroke.set_stroke_width(0.8);
                    stroke.set_color(Color::BLACK);

                    if is_circle {
                        let radius = box_size / 2.0;
                        if is_reversed {
                            canvas.draw_circle((cx, cy), radius, &fill);
                        }
                        canvas.draw_circle((cx, cy), radius, &stroke);
                    } else if is_rect {
                        let rect = Rect::from_xywh(
                            cx - box_size / 2.0,
                            cy - box_size / 2.0,
                            box_size,
                            box_size,
                        );
                        if is_reversed {
                            canvas.draw_rect(rect, &fill);
                        }
                        canvas.draw_rect(rect, &stroke);
                    }

                    let mut text_paint = Paint::default();
                    text_paint.set_anti_alias(true);
                    text_paint.set_style(skia_safe::paint::Style::Fill);
                    text_paint.set_color(if is_reversed {
                        Color::WHITE
                    } else {
                        colorref_to_skia(run.style.color, 1.0)
                    });
                    let font = make_font(&overlap_style, &self.font_mgr, display);
                    let (measured_width, _) = font.measure_str(display, Some(&text_paint));
                    let measured_width = measured_width.max(1.0);
                    let baseline_y = inner_font_size * 0.35;

                    if let Some(target_width) = target_text_width {
                        let scale_x = (target_width / measured_width).min(1.0);
                        canvas.save();
                        canvas.translate((cx, cy));
                        canvas.scale((scale_x, 1.0));
                        canvas.draw_str(
                            display,
                            (-measured_width / 2.0, baseline_y),
                            &font,
                            &text_paint,
                        );
                        canvas.restore();
                    } else {
                        canvas.draw_str(
                            display,
                            (cx - measured_width / 2.0, cy + baseline_y),
                            &font,
                            &text_paint,
                        );
                    }
                };

            if let Some(number_str) = decode_pua_overlap_number(&chars) {
                let cx = bbox.x as f32 + box_size / 2.0;
                let cy = bbox.y as f32 + bbox.height as f32 / 2.0;
                draw_overlap_cell(&number_str, cx, cy, Some(box_size * 0.7));
                return;
            }

            let char_advance = if chars.len() > 1 {
                bbox.width as f32 / chars.len() as f32
            } else {
                box_size
            };
            for (index, ch) in chars.iter().enumerate() {
                let display = {
                    let codepoint = u32::from(*ch);
                    if (0x2460..=0x2473).contains(&codepoint) {
                        format!("{}", codepoint - 0x2460 + 1)
                    } else if let Some(text) = pua_to_display_text(*ch) {
                        text
                    } else {
                        ch.to_string()
                    }
                };
                let cx = bbox.x as f32 + index as f32 * char_advance + box_size / 2.0;
                let cy = bbox.y as f32 + bbox.height as f32 / 2.0;
                draw_overlap_cell(&display, cx, cy, None);
            }
            return;
        }

        let shaping_profile = |text: &str| {
            let mut has_rtl = false;
            let needs_shaping = text.chars().any(|ch| {
                let codepoint = u32::from(ch);
                if matches!(
                    codepoint,
                    0x0590..=0x08FF
                        | 0xFB1D..=0xFDFF
                        | 0xFE70..=0xFEFF
                        | 0x10800..=0x10FFF
                        | 0x1E800..=0x1EFFF
                ) {
                    has_rtl = true;
                    return true;
                }
                matches!(
                    codepoint,
                    0x0300..=0x036F
                        | 0x0900..=0x0DFF
                        | 0x0E00..=0x0E7F
                        | 0x1780..=0x17FF
                        | 0x1AB0..=0x1AFF
                        | 0x1DC0..=0x1DFF
                        | 0x200C..=0x200D
                        | 0x20D0..=0x20FF
                        | 0xFE00..=0xFE0F
                        | 0xFE20..=0xFE2F
                        | 0x1F1E6..=0x1FAFF
                        | 0xE0100..=0xE01EF
                )
            });
            (needs_shaping, has_rtl)
        };
        let shape_text_blob = |text: &str, font: &skia_safe::Font| {
            if text.is_empty() {
                return None;
            }
            let (needs_shaping, has_rtl) = shaping_profile(text);
            if !needs_shaping {
                return None;
            }
            self.text_shaper
                .shape_text_blob(text, font, !has_rtl, 1_000_000.0, Point::default())
                .map(|(blob, _)| blob)
        };
        let clusters = split_into_clusters(&run.text);
        let metrics_font = make_font(&render_style, &self.font_mgr, &run.text);
        let char_positions = &run.positions;
        let text_width = char_positions.last().copied().unwrap_or(0.0) as f32;
        let shade_rgb = run.style.shade_color & 0x00FF_FFFF;
        if text_width > 0.0 && shade_rgb != 0x00FF_FFFF && shade_rgb != 0 {
            let mut shade_paint = Paint::default();
            shade_paint.set_anti_alias(true);
            shade_paint.set_style(skia_safe::paint::Style::Fill);
            shade_paint.set_color(colorref_to_skia(run.style.shade_color, 1.0));
            canvas.draw_rect(
                Rect::from_xywh(
                    bbox.x as f32,
                    y - render_style.font_size as f32,
                    text_width,
                    render_style.font_size as f32 * 1.2,
                ),
                &shade_paint,
            );
        }

        let mut draw_pass = |canvas: &Canvas,
                             x_offset: f32,
                             y_offset: f32,
                             fill_color: u32,
                             stroke_color: Option<u32>,
                             stroke_width: f32,
                             prefer_direct_text: bool| {
            let font_family = if render_style.font_family.is_empty() {
                "sans-serif".to_string()
            } else {
                format!(
                    "'{}',{}",
                    render_style
                        .font_family
                        .replace('\\', "\\\\")
                        .replace('\'', "\\'"),
                    crate::renderer::generic_fallback(&render_style.font_family)
                )
            };
            let mut fill_paint = Paint::default();
            fill_paint.set_anti_alias(true);
            fill_paint.set_style(skia_safe::paint::Style::Fill);
            fill_paint.set_color(colorref_to_skia(fill_color, 1.0));

            let mut stroke_paint = Paint::default();
            if let Some(stroke_color) = stroke_color {
                stroke_paint.set_anti_alias(true);
                stroke_paint.set_style(skia_safe::paint::Style::Stroke);
                stroke_paint.set_stroke_width(stroke_width.max(0.5));
                stroke_paint.set_color(colorref_to_skia(stroke_color, 1.0));
            }

            let is_space_cluster =
                |cluster: &str| cluster == " " || cluster == "\t" || cluster == "\u{2007}";
            let is_symbol_cluster = |cluster: &str| {
                cluster.chars().count() == 1
                    && cluster.chars().all(|ch| {
                        matches!(
                            ch,
                            '\u{00AD}'
                                | '\u{203B}'
                                | '\u{2460}'..='\u{24FF}'
                                | '\u{2500}'..='\u{27BF}'
                        )
                    })
            };
            let next_needs_shaping = |index: usize| {
                clusters.get(index + 1).is_some_and(|(_, next_cluster)| {
                    !is_space_cluster(next_cluster)
                        && !is_symbol_cluster(next_cluster)
                        && shaping_profile(next_cluster).0
                })
            };
            let draw_glyph_paths = |canvas: &Canvas,
                                    text: &str,
                                    font: &skia_safe::Font,
                                    x: f32,
                                    pass_y: f32,
                                    fill_paint: &Paint,
                                    stroke_paint: &Paint| {
                let glyphs = font.text_to_glyphs_vec(text);
                let mut glyph_positions = vec![Point::default(); glyphs.len()];
                font.get_pos(&glyphs, &mut glyph_positions, Some(Point::new(x, pass_y)));
                for (glyph_id, glyph_position) in glyphs.into_iter().zip(glyph_positions) {
                    if let Some(path) = font.get_path(glyph_id) {
                        let path = path.with_offset((glyph_position.x, glyph_position.y));
                        canvas.draw_path(&path, fill_paint);
                        if stroke_color.is_some() {
                            canvas.draw_path(&path, stroke_paint);
                        }
                    }
                }
            };

            let mut cluster_index = 0;
            while cluster_index < clusters.len() {
                let (char_idx, cluster) = &clusters[cluster_index];
                if cluster == " " || cluster == "\t" || cluster == "\u{2007}" {
                    cluster_index += 1;
                    continue;
                }
                let x = bbox.x as f32 + char_positions[*char_idx] as f32 + x_offset;
                let pass_y = y + y_offset;
                if is_symbol_cluster(cluster) {
                    let next_x = char_positions
                        .get(*char_idx + 1)
                        .copied()
                        .unwrap_or(text_width as f64);
                    let cluster_width = (next_x - char_positions[*char_idx])
                        .max(render_style.font_size * 0.6)
                        as f32;
                    let color = format!(
                        "#{:02x}{:02x}{:02x}",
                        fill_color & 0xFF,
                        (fill_color >> 8) & 0xFF,
                        (fill_color >> 16) & 0xFF,
                    );
                    let svg_fragment = format!(
                        "<text x=\"0\" y=\"{:.3}\" font-family=\"{}\" font-size=\"{:.3}\" fill=\"{}\">{}</text>",
                        render_style.font_size,
                        font_family,
                        render_style.font_size,
                        color,
                        cluster,
                    );
                    if let Some(image) = replay.svg_image_for_fragment(
                        &svg_fragment,
                        cluster_width,
                        render_style.font_size as f32 * 1.4,
                    ) {
                        let diagnostics = draw_decoded_image(
                            canvas,
                            &image,
                            x,
                            pass_y - render_style.font_size as f32,
                            cluster_width,
                            render_style.font_size as f32 * 1.4,
                            Some(crate::model::style::ImageFillMode::FitToSize),
                            None,
                            None,
                            crate::model::image::ImageEffect::RealPic,
                            ImageSampling::linear(),
                        );
                        replay.record_image_draw(diagnostics);
                    }
                    cluster_index += 1;
                    continue;
                }

                let (cluster_needs_shaping, _) = shaping_profile(cluster);
                if cluster_needs_shaping || next_needs_shaping(cluster_index) {
                    let mut shaped_text = String::new();
                    let mut end_index = cluster_index;
                    while end_index < clusters.len() {
                        let segment = &clusters[end_index].1;
                        if is_space_cluster(segment) || is_symbol_cluster(segment) {
                            break;
                        }
                        let segment_needs_shaping = shaping_profile(segment).0;
                        if end_index != cluster_index
                            && !segment_needs_shaping
                            && !next_needs_shaping(end_index)
                        {
                            break;
                        }
                        shaped_text.push_str(segment);
                        end_index += 1;
                    }

                    let font = make_font(&render_style, &self.font_mgr, &shaped_text);
                    if let Some(blob) = shape_text_blob(&shaped_text, &font) {
                        canvas.draw_text_blob(&blob, (x, pass_y), &fill_paint);
                        if stroke_color.is_some() {
                            canvas.draw_text_blob(&blob, (x, pass_y), &stroke_paint);
                        }
                    } else if prefer_direct_text && stroke_color.is_none() {
                        canvas.draw_str(&shaped_text, (x, pass_y), &font, &fill_paint);
                    } else {
                        draw_glyph_paths(
                            canvas,
                            &shaped_text,
                            &font,
                            x,
                            pass_y,
                            &fill_paint,
                            &stroke_paint,
                        );
                    }
                    cluster_index = end_index.max(cluster_index + 1);
                    continue;
                }

                let font = make_font(&render_style, &self.font_mgr, cluster);
                if let Some(blob) = shape_text_blob(cluster, &font) {
                    canvas.draw_text_blob(&blob, (x, pass_y), &fill_paint);
                    if stroke_color.is_some() {
                        canvas.draw_text_blob(&blob, (x, pass_y), &stroke_paint);
                    }
                } else if prefer_direct_text && stroke_color.is_none() {
                    canvas.draw_str(cluster, (x, pass_y), &font, &fill_paint);
                } else {
                    draw_glyph_paths(
                        canvas,
                        cluster,
                        &font,
                        x,
                        pass_y,
                        &fill_paint,
                        &stroke_paint,
                    );
                }
                cluster_index += 1;
            }
        };

        if run.style.emboss || run.style.engrave {
            let offset = (render_style.font_size as f32 / 20.0).max(1.0);
            let (first_color, second_color) = if run.style.emboss {
                (0x00FF_FFFF, 0x0080_8080)
            } else {
                (0x0080_8080, 0x00FF_FFFF)
            };
            draw_pass(canvas, -offset, -offset, first_color, None, 0.0, false);
            draw_pass(canvas, offset, offset, second_color, None, 0.0, false);
            draw_pass(canvas, 0.0, 0.0, run.style.color, None, 0.0, false);
        } else {
            if run.style.shadow_type > 0 {
                draw_pass(
                    canvas,
                    run.style.shadow_offset_x as f32,
                    run.style.shadow_offset_y as f32,
                    run.style.shadow_color,
                    None,
                    0.0,
                    false,
                );
            }
            if run.style.outline_type > 0 {
                draw_pass(
                    canvas,
                    0.0,
                    0.0,
                    0x00FF_FFFF,
                    Some(run.style.color),
                    (render_style.font_size as f32 / 25.0).max(0.5),
                    false,
                );
            } else {
                draw_pass(canvas, 0.0, 0.0, run.style.color, None, 0.0, true);
            }
        }

        if !matches!(run.style.underline, UnderlineType::None) {
            let ul_y = match run.style.underline {
                UnderlineType::Top => y - metrics_font.size() + 1.0,
                _ => y + 2.0,
            };
            self.draw_text_line_shape(
                canvas,
                bbox.x as f32,
                ul_y,
                bbox.x as f32 + text_width,
                ul_y,
                if run.style.underline_color != 0 {
                    run.style.underline_color
                } else {
                    run.style.color
                },
                run.style.underline_shape,
            );
        }
        if run.style.strikethrough {
            let strike_y = y - metrics_font.size() * 0.3;
            self.draw_text_line_shape(
                canvas,
                bbox.x as f32,
                strike_y,
                bbox.x as f32 + text_width,
                strike_y,
                if run.style.strike_color != 0 {
                    run.style.strike_color
                } else {
                    run.style.color
                },
                run.style.strike_shape,
            );
        }

        for leader in &run.style.tab_leaders {
            if leader.fill_type == 0 {
                continue;
            }
            let lx1 = bbox.x as f32 + leader.start_x as f32;
            let lx2 = bbox.x as f32 + leader.end_x as f32;
            let ly = y - render_style.font_size as f32 * 0.35;
            let draw_line = |line_y: f32, stroke_width: f32, dash: &[f32], round_cap: bool| {
                let mut leader_paint = Paint::default();
                leader_paint.set_anti_alias(true);
                leader_paint.set_style(skia_safe::paint::Style::Stroke);
                leader_paint.set_stroke_width(stroke_width);
                leader_paint.set_color(colorref_to_skia(run.style.color, 1.0));
                if round_cap {
                    leader_paint.set_stroke_cap(Cap::Round);
                }
                if !dash.is_empty() {
                    if let Some(effect) = skia_safe::PathEffect::dash(dash, 0.0) {
                        leader_paint.set_path_effect(effect);
                    }
                }
                canvas.draw_line((lx1, line_y), (lx2, line_y), &leader_paint);
            };

            match leader.fill_type {
                1 => draw_line(ly, 0.5, &[], false),
                2 => draw_line(ly, 0.5, &[3.0, 3.0], false),
                3 => draw_line(ly, 0.5, &[1.0, 2.0], false),
                4 => draw_line(ly, 0.5, &[6.0, 2.0, 1.0, 2.0], false),
                5 => draw_line(ly, 0.5, &[6.0, 2.0, 1.0, 2.0, 1.0, 2.0], false),
                6 => draw_line(ly, 0.5, &[8.0, 4.0], false),
                7 => draw_line(ly, 0.7, &[0.1, 2.5], true),
                8 => {
                    draw_line(ly - 1.0, 0.3, &[], false);
                    draw_line(ly + 1.0, 0.3, &[], false);
                }
                9 => {
                    draw_line(ly - 1.2, 0.3, &[], false);
                    draw_line(ly + 0.8, 0.8, &[], false);
                }
                10 => {
                    draw_line(ly - 0.8, 0.8, &[], false);
                    draw_line(ly + 1.2, 0.3, &[], false);
                }
                11 => {
                    draw_line(ly - 2.0, 0.3, &[], false);
                    draw_line(ly, 0.8, &[], false);
                    draw_line(ly + 2.0, 0.3, &[], false);
                }
                _ => draw_line(ly, 0.5, &[1.0, 2.0], false),
            }
        }

        if run.style.emphasis_dot > 0 {
            let dot_char = match run.style.emphasis_dot {
                1 => "●",
                2 => "○",
                3 => "ˇ",
                4 => "˜",
                5 => "･",
                6 => "˸",
                _ => "",
            };
            if !dot_char.is_empty() {
                let mut dot_style = render_style.clone();
                dot_style.font_family = "sans-serif".to_string();
                dot_style.font_size = render_style.font_size * 0.3;
                let dot_font = make_font(&dot_style, &self.font_mgr, dot_char);
                let mut dot_paint = Paint::default();
                dot_paint.set_anti_alias(true);
                dot_paint.set_color(colorref_to_skia(run.style.color, 1.0));
                let dot_y = y - render_style.font_size as f32 * 1.05;
                for &char_x in &char_positions[..char_positions.len().saturating_sub(1)] {
                    let dot_x = bbox.x as f32
                        + char_x as f32
                        + (base_font_size * run.style.ratio * 0.5) as f32;
                    canvas.draw_str(dot_char, (dot_x, dot_y), &dot_font, &dot_paint);
                }
            }
        }

        if !run.control_marks.is_empty() {
            let mut marker_paint = Paint::default();
            marker_paint.set_anti_alias(true);
            marker_paint.set_color(Color::from_argb(255, 0x4A, 0x90, 0xD9));

            for mark in &run.control_marks {
                if !replay.output_options.allows_text_control_mark(mark.kind) {
                    continue;
                }
                let marker_style = crate::renderer::TextStyle {
                    font_family: "sans-serif".to_string(),
                    font_size: mark.font_size,
                    ..Default::default()
                };
                let glyph = mark.kind.glyph();
                let marker_font = make_font(&marker_style, &self.font_mgr, glyph);
                canvas.draw_str(
                    glyph,
                    ((bbox.x + mark.x) as f32, y + mark.y as f32),
                    &marker_font,
                    &marker_paint,
                );
            }
        }
    }

    fn draw_text_line_shape(
        &self,
        canvas: &Canvas,
        x1: f32,
        y1: f32,
        x2: f32,
        y2: f32,
        color: u32,
        shape: u8,
    ) {
        let mut draw_single_line =
            |x1: f32, y1: f32, x2: f32, y2: f32, width: f32, dash: &[f32], round_cap: bool| {
                let mut paint = Paint::default();
                paint.set_anti_alias(true);
                paint.set_style(skia_safe::paint::Style::Stroke);
                paint.set_stroke_width(width);
                paint.set_color(colorref_to_skia(color, 1.0));
                if round_cap {
                    paint.set_stroke_cap(skia_safe::paint::Cap::Round);
                }
                if !dash.is_empty() {
                    if let Some(effect) = skia_safe::PathEffect::dash(dash, 0.0) {
                        paint.set_path_effect(effect);
                    }
                }
                canvas.draw_line((x1, y1), (x2, y2), &paint);
            };

        match shape {
            7 => {
                draw_single_line(x1, y1 - 1.0, x2, y2 - 1.0, 0.7, &[], false);
                draw_single_line(x1, y1 + 1.0, x2, y2 + 1.0, 0.7, &[], false);
            }
            8 => {
                draw_single_line(x1, y1 - 1.2, x2, y2 - 1.2, 0.5, &[], false);
                draw_single_line(x1, y1 + 0.8, x2, y2 + 0.8, 1.2, &[], false);
            }
            9 => {
                draw_single_line(x1, y1 - 0.8, x2, y2 - 0.8, 1.2, &[], false);
                draw_single_line(x1, y1 + 1.2, x2, y2 + 1.2, 0.5, &[], false);
            }
            10 => {
                draw_single_line(x1, y1 - 1.5, x2, y2 - 1.5, 0.5, &[], false);
                draw_single_line(x1, y1, x2, y2, 0.5, &[], false);
                draw_single_line(x1, y1 + 1.5, x2, y2 + 1.5, 0.5, &[], false);
            }
            11 | 12 => {
                let wave_offsets: &[f32] = if shape == 12 { &[-1.0, 1.0] } else { &[0.0] };
                for offset in wave_offsets {
                    let mut path = PathBuilder::new();
                    path.move_to((x1, y1 + offset));
                    let mut current_x = x1;
                    let mut upward = true;
                    while current_x < x2 {
                        let next_x = (current_x + 6.0).min(x2);
                        let control_y = if upward {
                            y1 + offset - 1.5
                        } else {
                            y1 + offset + 1.5
                        };
                        path.quad_to(
                            ((current_x + next_x) / 2.0, control_y),
                            (next_x, y1 + offset),
                        );
                        current_x = next_x;
                        upward = !upward;
                    }
                    let path = path.detach();
                    let mut paint = Paint::default();
                    paint.set_anti_alias(true);
                    paint.set_style(skia_safe::paint::Style::Stroke);
                    paint.set_stroke_width(if shape == 12 { 0.5 } else { 0.7 });
                    paint.set_color(colorref_to_skia(color, 1.0));
                    canvas.draw_path(&path, &paint);
                }
            }
            _ => {
                let dash: &[f32] = match shape {
                    1 => &[3.0, 3.0],
                    2 => &[1.0, 2.0],
                    3 => &[6.0, 2.0, 1.0, 2.0],
                    4 => &[6.0, 2.0, 1.0, 2.0, 1.0, 2.0],
                    5 => &[8.0, 4.0],
                    6 => &[0.1, 2.5],
                    _ => &[],
                };
                draw_single_line(x1, y1, x2, y2, 1.0, dash, shape == 6);
            }
        }
    }

    fn with_shape_transform<F>(
        &self,
        canvas: &Canvas,
        transform: crate::renderer::render_tree::ShapeTransform,
        bbox: Option<BoundingBox>,
        draw: F,
    ) where
        F: FnOnce(&Canvas),
    {
        if !transform.has_transform() {
            draw(canvas);
            return;
        }
        let bbox = bbox.unwrap_or(BoundingBox::new(0.0, 0.0, 0.0, 0.0));
        let cx = (bbox.x + bbox.width / 2.0) as f32;
        let cy = (bbox.y + bbox.height / 2.0) as f32;
        canvas.save();
        if transform.horz_flip {
            canvas.translate((cx * 2.0, 0.0));
            canvas.scale((-1.0, 1.0));
        }
        if transform.vert_flip {
            canvas.translate((0.0, cy * 2.0));
            canvas.scale((1.0, -1.0));
        }
        if transform.rotation != 0.0 {
            canvas.rotate(transform.rotation as f32, Some((cx, cy).into()));
        }
        draw(canvas);
        canvas.restore();
    }
}

impl LayerRasterRenderer for SkiaLayerRenderer {
    fn render_raster(
        &self,
        tree: &PageLayerTree,
        options: RasterRenderOptions,
    ) -> LayerRenderResult<RasterRenderOutput> {
        SkiaLayerRenderer::render_raster_with_options(self, tree, options)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        make_font, raster_dimension, ImageSampling, SkiaLayerRenderer, SkiaReplayContext,
        StaticPictureCache, StaticPictureCacheKey, MAX_STATIC_PICTURE_CACHE_ENTRIES,
    };
    use crate::model::style::UnderlineType;
    use crate::paint::{
        CacheHint, ClipKind, ImageResourceId, LayerBuilder, LayerImagePaint, LayerNode,
        LayerOutputOptions, LayerRectanglePaint, LayerSemantic, PageLayerTree, PaintOp,
        RenderProfile, ResourceArena, SvgResourceId,
    };
    use crate::renderer::composer::CharOverlapInfo;
    use crate::renderer::layer_renderer::RasterRenderOptions;
    use crate::renderer::render_tree::{
        BoundingBox, EllipseNode, LineNode, PageNode, PathNode, RectangleNode, RenderNode,
        RenderNodeType, ShapeTransform, TextRunNode,
    };
    use crate::renderer::{
        ArrowStyle, LineRenderType, LineStyle, PathCommand, ShapeStyle, StrokeDash, TabLeaderInfo,
        TextStyle,
    };
    use resvg::tiny_skia;
    use skia_safe::{Color, Paint, PictureRecorder, Point, Rect};

    #[test]
    fn renders_basic_rect_to_png() {
        let mut tree = crate::renderer::render_tree::PageRenderTree::new(0, 120.0, 80.0);
        tree.root.node_type = RenderNodeType::Page(PageNode {
            page_index: 0,
            width: 120.0,
            height: 80.0,
            section_index: 0,
        });
        tree.root.children.push(RenderNode::new(
            1,
            RenderNodeType::Rectangle(RectangleNode::new(
                0.0,
                ShapeStyle {
                    fill_color: Some(0x0000FF00),
                    stroke_color: Some(0x00000000),
                    stroke_width: 1.0,
                    ..Default::default()
                },
                None,
            )),
            BoundingBox::new(10.0, 10.0, 50.0, 30.0),
        ));
        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&tree);
        let renderer = SkiaLayerRenderer::new();
        let png = renderer.render_png(&layer_tree).expect("skia png render");
        assert!(!png.is_empty());
        assert_eq!(&png[0..8], b"\x89PNG\r\n\x1a\n");
    }

    #[test]
    fn raster_output_accumulates_tile_fallback_diagnostics() {
        use crate::model::image::ImageEffect;
        use crate::model::style::ImageFillMode;
        use crate::renderer::skia::image_conv::with_manual_tile_fallback_for_test;

        let mut pixmap = tiny_skia::Pixmap::new(1, 1).expect("source pixmap");
        pixmap.pixels_mut()[0] = tiny_skia::PremultipliedColorU8::from_rgba(0, 0, 0, 255).unwrap();
        let image_bytes = pixmap.encode_png().expect("source png");
        let mut resources = ResourceArena::default();
        let resource_id = resources.intern_image_bytes(&image_bytes);
        let tree = PageLayerTree::with_resources(
            5000.0,
            1.0,
            LayerNode::leaf(
                BoundingBox::new(0.0, 0.0, 5000.0, 1.0),
                None,
                vec![PaintOp::Image {
                    bbox: BoundingBox::new(0.0, 0.0, 5000.0, 1.0),
                    image: LayerImagePaint {
                        resource_id: Some(resource_id),
                        fill_mode: Some(ImageFillMode::TileAll),
                        original_size: Some((1.0, 1.0)),
                        crop: None,
                        effect: ImageEffect::RealPic,
                        transform: ShapeTransform::default(),
                    },
                }],
            ),
            resources,
        );
        let renderer = SkiaLayerRenderer::new();
        let output = with_manual_tile_fallback_for_test(|| {
            renderer
                .render_raster_with_options(&tree, RasterRenderOptions::default())
                .expect("render raster")
        });

        assert_eq!(output.diagnostics.tile_fallback_cap_hits, 1);
    }

    #[test]
    fn body_clip_policy_allows_right_overflow_slop() {
        let rect_bounds = BoundingBox::new(8.0, 8.0, 8.0, 4.0);
        let leaf = LayerNode::leaf(
            rect_bounds,
            None,
            vec![PaintOp::Rectangle {
                bbox: rect_bounds,
                rect: LayerRectanglePaint {
                    corner_radius: 0.0,
                    style: ShapeStyle {
                        fill_color: Some(0x000000),
                        ..Default::default()
                    },
                    gradient: None,
                    transform: Default::default(),
                },
            }],
        );
        let root = LayerNode::clip_rect(
            BoundingBox::new(0.0, 0.0, 20.0, 20.0),
            None,
            BoundingBox::new(4.0, 4.0, 8.0, 12.0),
            leaf,
            ClipKind::Body,
        );
        let tree = PageLayerTree::new(20.0, 20.0, root);
        let renderer = SkiaLayerRenderer::new();
        let png = renderer.render_png(&tree).expect("skia clip render");
        let pixmap = tiny_skia::Pixmap::decode_png(&png).expect("png decode");
        let width = pixmap.width() as usize;

        assert!(
            pixmap.pixels()[10 * width + 13].alpha() > 0,
            "body clip should preserve pixels inside the right overflow slop"
        );
        assert_eq!(
            pixmap.pixels()[10 * width + 17].alpha(),
            0,
            "body clip should still reject pixels beyond the slop"
        );
    }

    #[test]
    fn output_options_can_disable_clip_rect_replay() {
        let rect_bounds = BoundingBox::new(8.0, 8.0, 8.0, 4.0);
        let leaf = LayerNode::leaf(
            rect_bounds,
            None,
            vec![PaintOp::Rectangle {
                bbox: rect_bounds,
                rect: LayerRectanglePaint {
                    corner_radius: 0.0,
                    style: ShapeStyle {
                        fill_color: Some(0x000000),
                        ..Default::default()
                    },
                    gradient: None,
                    transform: Default::default(),
                },
            }],
        );
        let root = LayerNode::clip_rect(
            BoundingBox::new(0.0, 0.0, 20.0, 20.0),
            None,
            BoundingBox::new(0.0, 0.0, 4.0, 20.0),
            leaf,
            ClipKind::Generic,
        );
        let tree = PageLayerTree::new(20.0, 20.0, root).with_output_options(LayerOutputOptions {
            clip_enabled: false,
            ..Default::default()
        });
        let renderer = SkiaLayerRenderer::new();
        let png = renderer
            .render_png(&tree)
            .expect("skia clip-disabled render");
        let pixmap = tiny_skia::Pixmap::decode_png(&png).expect("png decode");
        let width = pixmap.width() as usize;

        assert!(
            pixmap.pixels()[10 * width + 10].alpha() > 0,
            "clip-disabled replay should render pixels outside the ClipRect"
        );
    }

    #[test]
    fn renders_multi_line_type_as_separated_strokes() {
        let render_line = |line_type: LineRenderType| -> usize {
            let mut tree = crate::renderer::render_tree::PageRenderTree::new(0, 120.0, 80.0);
            tree.root.children.push(RenderNode::new(
                1,
                RenderNodeType::Line(LineNode::new(
                    15.0,
                    40.0,
                    105.0,
                    40.0,
                    LineStyle {
                        color: 0x000000,
                        width: 20.0,
                        dash: StrokeDash::Solid,
                        line_type,
                        start_arrow: ArrowStyle::None,
                        end_arrow: ArrowStyle::None,
                        start_arrow_size: 0,
                        end_arrow_size: 0,
                        shadow: None,
                    },
                )),
                BoundingBox::new(15.0, 20.0, 90.0, 40.0),
            ));
            let mut builder = LayerBuilder::new(RenderProfile::Screen);
            let layer_tree = builder.build(&tree);
            let renderer = SkiaLayerRenderer::new();
            let png = renderer.render_png(&layer_tree).expect("skia line render");
            let pixmap = tiny_skia::Pixmap::decode_png(&png).expect("png decode");
            pixmap
                .pixels()
                .iter()
                .filter(|pixel| pixel.alpha() > 0)
                .count()
        };

        let single_ink = render_line(LineRenderType::Single);
        let triple_ink = render_line(LineRenderType::ThinThickThinTriple);

        assert!(
            triple_ink < single_ink,
            "expected separated triple line ink ({triple_ink}) to be less than solid single line ink ({single_ink})"
        );
    }

    #[test]
    fn renders_shape_feature_fixture_to_png() {
        let mut tree = crate::renderer::render_tree::PageRenderTree::new(0, 220.0, 180.0);
        let mut next_id = 1;
        let mut push_node = |tree: &mut crate::renderer::render_tree::PageRenderTree,
                             node_type: RenderNodeType,
                             bbox: BoundingBox| {
            tree.root
                .children
                .push(RenderNode::new(next_id, node_type, bbox));
            next_id += 1;
        };
        let line_style = |dash, line_type, start_arrow, end_arrow| LineStyle {
            color: 0x00000000,
            width: 4.0,
            dash,
            line_type,
            start_arrow,
            end_arrow,
            start_arrow_size: 4,
            end_arrow_size: 4,
            shadow: None,
        };

        push_node(
            &mut tree,
            RenderNodeType::Line(LineNode::new(
                14.0,
                18.0,
                200.0,
                18.0,
                line_style(
                    StrokeDash::Solid,
                    LineRenderType::ThinThickThinTriple,
                    ArrowStyle::Arrow,
                    ArrowStyle::OpenDiamond,
                ),
            )),
            BoundingBox::new(10.0, 8.0, 196.0, 24.0),
        );
        push_node(
            &mut tree,
            RenderNodeType::Line(LineNode::new(
                18.0,
                44.0,
                206.0,
                44.0,
                line_style(
                    StrokeDash::DashDot,
                    LineRenderType::Double,
                    ArrowStyle::None,
                    ArrowStyle::ConcaveArrow,
                ),
            )),
            BoundingBox::new(12.0, 34.0, 200.0, 24.0),
        );

        let mut rect = RectangleNode::new(
            8.0,
            ShapeStyle {
                fill_color: Some(0x00D9E7FF),
                stroke_color: Some(0x00000000),
                stroke_width: 2.0,
                ..Default::default()
            },
            None,
        );
        rect.transform = ShapeTransform {
            rotation: 12.0,
            horz_flip: true,
            vert_flip: false,
        };
        push_node(
            &mut tree,
            RenderNodeType::Rectangle(rect),
            BoundingBox::new(16.0, 70.0, 56.0, 42.0),
        );

        let mut ellipse = EllipseNode::new(
            ShapeStyle {
                fill_color: Some(0x00D5E8D4),
                stroke_color: Some(0x00000000),
                stroke_width: 2.0,
                stroke_dash: StrokeDash::Dot,
                ..Default::default()
            },
            None,
        );
        ellipse.transform = ShapeTransform {
            rotation: -18.0,
            horz_flip: false,
            vert_flip: true,
        };
        push_node(
            &mut tree,
            RenderNodeType::Ellipse(ellipse),
            BoundingBox::new(92.0, 70.0, 58.0, 42.0),
        );

        let mut path = PathNode::new(
            vec![
                PathCommand::MoveTo(26.0, 148.0),
                PathCommand::CurveTo(58.0, 116.0, 88.0, 178.0, 118.0, 142.0),
                PathCommand::ArcTo(26.0, 18.0, 0.0, false, true, 172.0, 142.0),
            ],
            ShapeStyle {
                fill_color: None,
                stroke_color: Some(0x00000000),
                stroke_width: 3.0,
                stroke_dash: StrokeDash::Dash,
                ..Default::default()
            },
            None,
        );
        path.connector_endpoints = Some((26.0, 148.0, 172.0, 142.0));
        path.line_style = Some(line_style(
            StrokeDash::Dash,
            LineRenderType::Single,
            ArrowStyle::Circle,
            ArrowStyle::Arrow,
        ));
        push_node(
            &mut tree,
            RenderNodeType::Path(path),
            BoundingBox::new(20.0, 112.0, 160.0, 52.0),
        );

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&tree);
        let renderer = SkiaLayerRenderer::new();
        let png = renderer
            .render_png(&layer_tree)
            .expect("shape feature fixture render");
        let pixmap = tiny_skia::Pixmap::decode_png(&png).expect("shape fixture png decode");
        let ink_pixels = pixmap
            .pixels()
            .iter()
            .filter(|pixel| pixel.alpha() > 0)
            .count();

        assert!(
            ink_pixels > 800,
            "expected visible shape feature fixture ink"
        );
    }

    #[test]
    fn static_subtree_hint_records_picture_cache() {
        let rect_bounds = BoundingBox::new(5.0, 5.0, 20.0, 10.0);
        let leaf = LayerNode::leaf(
            rect_bounds,
            Some(2),
            vec![PaintOp::Rectangle {
                bbox: rect_bounds,
                rect: LayerRectanglePaint {
                    corner_radius: 0.0,
                    style: ShapeStyle {
                        fill_color: Some(0x00AA00),
                        ..Default::default()
                    },
                    gradient: None,
                    transform: Default::default(),
                },
            }],
        );
        let root = LayerNode::group(
            BoundingBox::new(0.0, 0.0, 40.0, 20.0),
            Some(1),
            vec![leaf],
            CacheHint::StaticSubtree,
            LayerSemantic::default(),
        );
        let tree = PageLayerTree::new(40.0, 20.0, root);
        let renderer = SkiaLayerRenderer::new();

        assert_eq!(renderer.static_picture_cache.borrow().len(), 0);
        renderer.render_png(&tree).expect("first skia render");
        assert_eq!(renderer.static_picture_cache.borrow().len(), 1);
        renderer.render_png(&tree).expect("cached skia render");
        assert_eq!(renderer.static_picture_cache.borrow().len(), 1);
    }

    #[test]
    fn static_picture_cache_ignores_unreferenced_resources() {
        let rect_bounds = BoundingBox::new(5.0, 5.0, 20.0, 10.0);
        let leaf = LayerNode::leaf(
            rect_bounds,
            Some(2),
            vec![PaintOp::Rectangle {
                bbox: rect_bounds,
                rect: LayerRectanglePaint {
                    corner_radius: 0.0,
                    style: ShapeStyle {
                        fill_color: Some(0x00AA00),
                        ..Default::default()
                    },
                    gradient: None,
                    transform: Default::default(),
                },
            }],
        );
        let root = LayerNode::group(
            BoundingBox::new(0.0, 0.0, 40.0, 20.0),
            Some(1),
            vec![leaf],
            CacheHint::StaticSubtree,
            LayerSemantic::default(),
        );
        let mut resources_a = ResourceArena::default();
        resources_a.intern_image_bytes(b"unreferenced image A");
        resources_a.intern_svg_fragment("<rect width=\"10\" height=\"10\"/>");
        let mut resources_b = ResourceArena::default();
        resources_b.intern_image_bytes(b"unreferenced image B with different bytes");
        resources_b.intern_svg_fragment("<circle r=\"5\"/>");
        let tree_a = PageLayerTree::with_resources(40.0, 20.0, root.clone(), resources_a);
        let tree_b = PageLayerTree::with_resources(40.0, 20.0, root, resources_b);
        let renderer = SkiaLayerRenderer::new();

        renderer.render_png(&tree_a).expect("first skia render");
        assert_eq!(renderer.static_picture_cache.borrow().len(), 1);
        renderer
            .render_png(&tree_b)
            .expect("unreferenced resources should not miss");
        assert_eq!(
            renderer.static_picture_cache.borrow().len(),
            1,
            "static subtree cache key should ignore resources not referenced by the subtree"
        );
    }

    #[test]
    fn static_subtree_picture_cache_evicts_old_entries() {
        let renderer = SkiaLayerRenderer::new();

        for index in 0..(MAX_STATIC_PICTURE_CACHE_ENTRIES + 2) {
            let rect_bounds = BoundingBox::new(5.0, 5.0, 20.0, 10.0);
            let leaf = LayerNode::leaf(
                rect_bounds,
                Some(index as u32 + 10),
                vec![PaintOp::Rectangle {
                    bbox: rect_bounds,
                    rect: LayerRectanglePaint {
                        corner_radius: 0.0,
                        style: ShapeStyle {
                            fill_color: Some(0x00AA00 + index as u32),
                            ..Default::default()
                        },
                        gradient: None,
                        transform: Default::default(),
                    },
                }],
            );
            let root = LayerNode::group(
                BoundingBox::new(0.0, 0.0, 40.0, 20.0),
                Some(index as u32 + 1),
                vec![leaf],
                CacheHint::StaticSubtree,
                LayerSemantic::default(),
            );
            let tree = PageLayerTree::new(40.0, 20.0, root);
            renderer.render_png(&tree).expect("skia render");
        }

        assert_eq!(
            renderer.static_picture_cache.borrow().len(),
            MAX_STATIC_PICTURE_CACHE_ENTRIES,
            "static subtree picture cache should stay bounded"
        );
    }

    #[test]
    fn static_picture_cache_uses_byte_budget_and_fingerprint() {
        let mut recorder = PictureRecorder::new();
        let canvas = recorder.begin_recording(Rect::from_xywh(0.0, 0.0, 4.0, 4.0), true);
        let mut paint = Paint::default();
        paint.set_color(Color::from_argb(255, 0, 255, 0));
        canvas.draw_rect(Rect::from_xywh(0.0, 0.0, 4.0, 4.0), &paint);
        let picture = recorder
            .finish_recording_as_picture(Some(&Rect::from_xywh(0.0, 0.0, 4.0, 4.0)))
            .expect("picture");

        let key_a = StaticPictureCacheKey {
            hash: 7,
            fingerprint: 11,
        };
        let key_b = StaticPictureCacheKey {
            hash: 7,
            fingerprint: 12,
        };
        let key_c = StaticPictureCacheKey {
            hash: 8,
            fingerprint: 13,
        };
        let mut cache = StaticPictureCache::new(4, 1_000);

        cache.insert(key_a, picture.clone(), 600);
        assert!(cache.get(key_a).is_some());
        assert!(
            cache.get(key_b).is_none(),
            "same hash with a different fingerprint must not reuse a cached picture"
        );

        cache.insert(key_c, picture.clone(), 600);
        assert_eq!(cache.len(), 1);
        assert!(cache.approx_bytes() <= 1_000);
        assert!(cache.get(key_a).is_none());
        assert!(cache.get(key_c).is_some());

        cache.insert(
            StaticPictureCacheKey {
                hash: 9,
                fingerprint: 14,
            },
            picture,
            1_001,
        );
        assert_eq!(
            cache.len(),
            1,
            "entries larger than the byte budget should be skipped"
        );
    }

    #[test]
    fn replay_context_caches_decoded_image_resources() {
        let mut source = tiny_skia::Pixmap::new(2, 2).expect("source pixmap");
        for pixel in source.pixels_mut() {
            *pixel = tiny_skia::PremultipliedColorU8::from_rgba(0, 255, 0, 255).unwrap();
        }
        let png = source.encode_png().expect("source png");
        let mut replay =
            SkiaReplayContext::new(RenderProfile::Screen, LayerOutputOptions::default(), 1.0);
        let resource_id = ImageResourceId(7);

        let first = replay
            .image_for_resource(resource_id, &png)
            .expect("first image decode");
        let second = replay
            .image_for_resource(resource_id, b"not an image")
            .expect("cached image decode");

        assert_eq!((first.width(), first.height()), (2, 2));
        assert_eq!((second.width(), second.height()), (2, 2));
        assert_eq!(replay.image_cache.len(), 1);
    }

    #[test]
    fn replay_context_caches_rasterized_svg_resources() {
        let mut replay =
            SkiaReplayContext::new(RenderProfile::Screen, LayerOutputOptions::default(), 1.0);
        let resource_id = SvgResourceId(3);
        let fragment = "<rect x=\"0\" y=\"0\" width=\"4\" height=\"4\" fill=\"#00ff00\"/>";

        let first = replay
            .svg_image_for_resource(resource_id, fragment, 4.0, 4.0)
            .expect("first svg raster");
        let second = replay
            .svg_image_for_resource(resource_id, "<invalid", 4.0, 4.0)
            .expect("cached svg raster");

        assert_eq!((first.width(), first.height()), (4, 4));
        assert_eq!((second.width(), second.height()), (4, 4));
        assert_eq!(replay.svg_resource_cache.len(), 1);

        replay
            .svg_image_for_fragment(fragment, 4.0, 4.0)
            .expect("fragment svg raster");
        replay
            .svg_image_for_fragment(fragment, 4.0, 4.0)
            .expect("cached fragment svg raster");
        assert_eq!(replay.svg_fragment_cache.len(), 1);
    }

    #[test]
    fn replay_context_keeps_repeated_resource_caches_bounded() {
        let mut source = tiny_skia::Pixmap::new(2, 2).expect("source pixmap");
        for pixel in source.pixels_mut() {
            *pixel = tiny_skia::PremultipliedColorU8::from_rgba(32, 96, 255, 255).unwrap();
        }
        let png = source.encode_png().expect("source png");
        let mut replay =
            SkiaReplayContext::new(RenderProfile::Screen, LayerOutputOptions::default(), 1.0);
        let image_resource_id = ImageResourceId(11);
        let svg_resource_id = SvgResourceId(13);
        let fragment = "<rect x=\"0\" y=\"0\" width=\"6\" height=\"6\" fill=\"#2040ff\"/>";

        for index in 0..100 {
            let bytes: &[u8] = if index == 0 { &png } else { b"not an image" };
            let image = replay
                .image_for_resource(image_resource_id, bytes)
                .expect("repeated image resource should use cached decode");
            assert_eq!((image.width(), image.height()), (2, 2));

            let svg = if index == 0 { fragment } else { "<invalid" };
            let svg_image = replay
                .svg_image_for_resource(svg_resource_id, svg, 6.0, 6.0)
                .expect("repeated svg resource should use cached raster");
            assert_eq!((svg_image.width(), svg_image.height()), (6, 6));

            let fragment_image = replay
                .svg_image_for_fragment(fragment, 6.0, 6.0)
                .expect("repeated svg fragment should use cached raster");
            assert_eq!((fragment_image.width(), fragment_image.height()), (6, 6));
        }

        assert_eq!(replay.image_cache.len(), 1);
        assert_eq!(replay.svg_resource_cache.len(), 1);
        assert_eq!(replay.svg_fragment_cache.len(), 1);
    }

    #[test]
    fn render_raster_options_scale_surface_and_metadata() {
        let mut tree = crate::renderer::render_tree::PageRenderTree::new(0, 40.0, 20.0);
        tree.root.node_type = RenderNodeType::Page(PageNode {
            page_index: 0,
            width: 40.0,
            height: 20.0,
            section_index: 0,
        });
        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&tree);
        let renderer = SkiaLayerRenderer::new();
        let output = renderer
            .render_raster_with_options(
                &layer_tree,
                RasterRenderOptions {
                    scale: 2.0,
                    dpi: Some(144.0),
                    ..Default::default()
                },
            )
            .expect("scaled skia raster render");
        let pixmap = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");

        assert_eq!((output.width, output.height), (80, 40));
        assert_eq!((pixmap.width(), pixmap.height()), (80, 40));
        assert_eq!(output.dpi, Some(144.0));
    }

    #[test]
    fn rounds_surface_size_like_svg_rasterization() {
        let mut tree =
            crate::renderer::render_tree::PageRenderTree::new(0, 793.7066666666667, 1122.48);
        tree.root.node_type = RenderNodeType::Page(PageNode {
            page_index: 0,
            width: 793.7066666666667,
            height: 1122.48,
            section_index: 0,
        });
        tree.root.children.push(RenderNode::new(
            1,
            RenderNodeType::Rectangle(RectangleNode::new(
                0.0,
                ShapeStyle {
                    fill_color: Some(0x00FFFFFF),
                    ..Default::default()
                },
                None,
            )),
            BoundingBox::new(0.0, 0.0, 793.7066666666667, 1122.48),
        ));

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&tree);
        let renderer = SkiaLayerRenderer::new();
        let png = renderer.render_png(&layer_tree).expect("skia png render");
        let pixmap = tiny_skia::Pixmap::decode_png(&png).expect("png decode");

        assert_eq!((pixmap.width(), pixmap.height()), (794, 1122));
    }

    #[test]
    fn rejects_invalid_raster_dimensions() {
        assert!(raster_dimension(f64::NAN, 1.0, 16_384).is_err());
        assert!(raster_dimension(0.0, 1.0, 16_384).is_err());
        assert!(raster_dimension(10.0, f64::NAN, 16_384).is_err());
        assert!(raster_dimension(10.0, 0.0, 16_384).is_err());
        assert!(raster_dimension(8_193.0, 2.0, 16_384).is_err());
        assert_eq!(raster_dimension(12.4, 2.0, 16_384), Ok(25));
    }

    #[test]
    fn renders_char_overlap_to_png() {
        let mut tree = crate::renderer::render_tree::PageRenderTree::new(0, 90.0, 60.0);
        tree.root.children.push(RenderNode::new(
            1,
            RenderNodeType::TextRun(TextRunNode {
                text: "12".to_string(),
                style: TextStyle {
                    font_size: 24.0,
                    color: 0x00000000,
                    ..Default::default()
                },
                char_shape_id: None,
                para_shape_id: None,
                section_index: None,
                para_index: None,
                char_start: None,
                cell_context: None,
                is_para_end: false,
                is_line_break_end: false,
                rotation: 0.0,
                is_vertical: false,
                char_overlap: Some(CharOverlapInfo {
                    border_type: 1,
                    inner_char_size: 85,
                }),
                border_fill_id: 0,
                baseline: 24.0,
                field_marker: Default::default(),
            }),
            BoundingBox::new(20.0, 16.0, 48.0, 28.0),
        ));

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&tree);
        let renderer = SkiaLayerRenderer::new();
        let png = renderer.render_png(&layer_tree).expect("skia png render");
        let pixmap = tiny_skia::Pixmap::decode_png(&png).expect("png decode");
        let ink_pixels = pixmap
            .pixels()
            .iter()
            .filter(|pixel| pixel.alpha() > 0)
            .count();

        assert!(ink_pixels > 20, "expected visible char overlap ink");
    }

    #[test]
    fn renders_plain_text_run_to_png() {
        let mut tree = crate::renderer::render_tree::PageRenderTree::new(0, 120.0, 60.0);
        tree.root.children.push(RenderNode::new(
            1,
            RenderNodeType::TextRun(TextRunNode {
                text: "Plain text".to_string(),
                style: TextStyle {
                    font_size: 22.0,
                    color: 0x00000000,
                    ..Default::default()
                },
                char_shape_id: None,
                para_shape_id: None,
                section_index: None,
                para_index: None,
                char_start: None,
                cell_context: None,
                is_para_end: false,
                is_line_break_end: false,
                rotation: 0.0,
                is_vertical: false,
                char_overlap: None,
                border_fill_id: 0,
                baseline: 26.0,
                field_marker: Default::default(),
            }),
            BoundingBox::new(10.0, 12.0, 90.0, 32.0),
        ));

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&tree);
        let renderer = SkiaLayerRenderer::new();
        let png = renderer.render_png(&layer_tree).expect("plain text render");
        let pixmap = tiny_skia::Pixmap::decode_png(&png).expect("png decode");
        let ink_pixels = pixmap
            .pixels()
            .iter()
            .filter(|pixel| pixel.alpha() > 0)
            .count();

        assert!(ink_pixels > 20, "expected visible plain text ink");
    }

    #[test]
    fn skia_shaper_builds_blob_for_complex_text() {
        let renderer = SkiaLayerRenderer::new();
        let text = "office 👩\u{200d}💻 العربية 한글";
        let style = TextStyle {
            font_family: "sans-serif".to_string(),
            font_size: 20.0,
            ..Default::default()
        };
        let font = make_font(&style, &renderer.font_mgr, text);

        assert!(
            renderer
                .text_shaper
                .shape_text_blob(text, &font, false, 1_000_000.0, Point::default())
                .is_some(),
            "native Skia textlayout shaper should produce a TextBlob for complex text"
        );
    }

    #[test]
    fn renders_complex_shaped_text_run_to_png() {
        let text = "office 👩\u{200d}💻 العربية 한글";
        let mut tree = crate::renderer::render_tree::PageRenderTree::new(0, 260.0, 70.0);
        tree.root.children.push(RenderNode::new(
            1,
            RenderNodeType::TextRun(TextRunNode {
                text: text.to_string(),
                style: TextStyle {
                    font_family: "sans-serif".to_string(),
                    font_size: 20.0,
                    color: 0x00000000,
                    ..Default::default()
                },
                char_shape_id: None,
                para_shape_id: None,
                section_index: None,
                para_index: None,
                char_start: None,
                cell_context: None,
                is_para_end: false,
                is_line_break_end: false,
                rotation: 0.0,
                is_vertical: false,
                char_overlap: None,
                border_fill_id: 0,
                baseline: 30.0,
                field_marker: Default::default(),
            }),
            BoundingBox::new(10.0, 14.0, 240.0, 36.0),
        ));

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&tree);
        let renderer = SkiaLayerRenderer::new();
        let png = renderer
            .render_png(&layer_tree)
            .expect("complex shaped text render");
        let pixmap = tiny_skia::Pixmap::decode_png(&png).expect("png decode");
        let ink_pixels = pixmap
            .pixels()
            .iter()
            .filter(|pixel| pixel.alpha() > 0)
            .count();

        assert!(ink_pixels > 20, "expected visible complex text ink");
    }

    #[test]
    fn renders_text_feature_fixture_to_png() {
        let mut tree = crate::renderer::render_tree::PageRenderTree::new(0, 240.0, 170.0);
        let mut next_id = 1;
        let mut push_text = |tree: &mut crate::renderer::render_tree::PageRenderTree,
                             text: &str,
                             bbox: BoundingBox,
                             style: TextStyle,
                             baseline: f64,
                             rotation: f64,
                             is_vertical: bool,
                             char_overlap: Option<CharOverlapInfo>| {
            tree.root.children.push(RenderNode::new(
                next_id,
                RenderNodeType::TextRun(TextRunNode {
                    text: text.to_string(),
                    style,
                    char_shape_id: None,
                    para_shape_id: None,
                    section_index: None,
                    para_index: None,
                    char_start: None,
                    cell_context: None,
                    is_para_end: false,
                    is_line_break_end: false,
                    rotation,
                    is_vertical,
                    char_overlap,
                    border_fill_id: 0,
                    baseline,
                    field_marker: Default::default(),
                }),
                bbox,
            ));
            next_id += 1;
        };

        push_text(
            &mut tree,
            "한글 ABC 日本 123",
            BoundingBox::new(12.0, 14.0, 190.0, 28.0),
            TextStyle {
                font_size: 18.0,
                color: 0x00000000,
                ..Default::default()
            },
            22.0,
            0.0,
            false,
            None,
        );
        push_text(
            &mut tree,
            "회전",
            BoundingBox::new(198.0, 22.0, 28.0, 42.0),
            TextStyle {
                font_size: 16.0,
                color: 0x00000000,
                ..Default::default()
            },
            20.0,
            90.0,
            false,
            None,
        );
        push_text(
            &mut tree,
            "세로",
            BoundingBox::new(170.0, 58.0, 28.0, 48.0),
            TextStyle {
                font_size: 16.0,
                color: 0x00000000,
                ..Default::default()
            },
            20.0,
            0.0,
            true,
            None,
        );
        push_text(
            &mut tree,
            "12",
            BoundingBox::new(18.0, 56.0, 28.0, 28.0),
            TextStyle {
                font_size: 22.0,
                color: 0x00000000,
                ..Default::default()
            },
            22.0,
            0.0,
            false,
            Some(CharOverlapInfo {
                border_type: 1,
                inner_char_size: 80,
            }),
        );
        push_text(
            &mut tree,
            "위첨자",
            BoundingBox::new(58.0, 58.0, 58.0, 24.0),
            TextStyle {
                font_size: 18.0,
                color: 0x00000000,
                superscript: true,
                ..Default::default()
            },
            20.0,
            0.0,
            false,
            None,
        );
        push_text(
            &mut tree,
            "아래첨자",
            BoundingBox::new(58.0, 90.0, 72.0, 26.0),
            TextStyle {
                font_size: 18.0,
                color: 0x00000000,
                subscript: true,
                ..Default::default()
            },
            18.0,
            0.0,
            false,
            None,
        );
        push_text(
            &mut tree,
            "밑줄 취소 강조",
            BoundingBox::new(14.0, 126.0, 160.0, 30.0),
            TextStyle {
                font_size: 18.0,
                color: 0x00000000,
                underline: UnderlineType::Bottom,
                strikethrough: true,
                emphasis_dot: 1,
                ..Default::default()
            },
            22.0,
            0.0,
            false,
            None,
        );

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&tree);
        let renderer = SkiaLayerRenderer::new();
        let png = renderer
            .render_png(&layer_tree)
            .expect("text feature fixture render");
        let pixmap = tiny_skia::Pixmap::decode_png(&png).expect("png decode");
        let ink_pixels = pixmap
            .pixels()
            .iter()
            .filter(|pixel| pixel.alpha() > 0)
            .count();

        assert!(
            ink_pixels > 500,
            "expected visible text feature fixture ink"
        );
    }

    #[test]
    fn output_options_enable_text_control_marks() {
        let mut tree = crate::renderer::render_tree::PageRenderTree::new(0, 120.0, 60.0);
        tree.root.children.push(RenderNode::new(
            1,
            RenderNodeType::TextRun(TextRunNode {
                text: "a b".to_string(),
                style: TextStyle {
                    font_size: 22.0,
                    color: 0x00000000,
                    ..Default::default()
                },
                char_shape_id: None,
                para_shape_id: None,
                section_index: None,
                para_index: None,
                char_start: None,
                cell_context: None,
                is_para_end: true,
                is_line_break_end: false,
                rotation: 0.0,
                is_vertical: false,
                char_overlap: None,
                border_fill_id: 0,
                baseline: 26.0,
                field_marker: Default::default(),
            }),
            BoundingBox::new(10.0, 12.0, 70.0, 32.0),
        ));

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let base_tree = builder.build(&tree);
        let mut marked_builder =
            LayerBuilder::new(RenderProfile::Screen).with_output_options(LayerOutputOptions {
                show_paragraph_marks: true,
                show_control_codes: true,
                ..Default::default()
            });
        let marked_tree = marked_builder.build(&tree);
        let renderer = SkiaLayerRenderer::new();
        let base_png = renderer.render_png(&base_tree).expect("base skia render");
        let marked_png = renderer
            .render_png(&marked_tree)
            .expect("marked skia render");
        let base = tiny_skia::Pixmap::decode_png(&base_png).expect("base decode");
        let marked = tiny_skia::Pixmap::decode_png(&marked_png).expect("marked decode");
        let count_ink = |pixmap: &tiny_skia::Pixmap| {
            pixmap
                .pixels()
                .iter()
                .filter(|pixel| pixel.alpha() > 0)
                .count()
        };

        assert!(count_ink(&marked) > count_ink(&base));
    }

    #[test]
    fn output_options_enable_line_break_mark() {
        let mut tree = crate::renderer::render_tree::PageRenderTree::new(0, 120.0, 60.0);
        tree.root.children.push(RenderNode::new(
            1,
            RenderNodeType::TextRun(TextRunNode {
                text: "line".to_string(),
                style: TextStyle {
                    font_size: 22.0,
                    color: 0x00000000,
                    ..Default::default()
                },
                char_shape_id: None,
                para_shape_id: None,
                section_index: None,
                para_index: None,
                char_start: None,
                cell_context: None,
                is_para_end: false,
                is_line_break_end: true,
                rotation: 0.0,
                is_vertical: false,
                char_overlap: None,
                border_fill_id: 0,
                baseline: 26.0,
                field_marker: Default::default(),
            }),
            BoundingBox::new(10.0, 12.0, 70.0, 32.0),
        ));

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let base_tree = builder.build(&tree);
        let mut marked_builder =
            LayerBuilder::new(RenderProfile::Screen).with_output_options(LayerOutputOptions {
                show_paragraph_marks: true,
                show_control_codes: true,
                ..Default::default()
            });
        let marked_tree = marked_builder.build(&tree);
        let renderer = SkiaLayerRenderer::new();
        let base_png = renderer.render_png(&base_tree).expect("base skia render");
        let marked_png = renderer
            .render_png(&marked_tree)
            .expect("marked skia render");
        let base = tiny_skia::Pixmap::decode_png(&base_png).expect("base decode");
        let marked = tiny_skia::Pixmap::decode_png(&marked_png).expect("marked decode");
        let count_ink = |pixmap: &tiny_skia::Pixmap| {
            pixmap
                .pixels()
                .iter()
                .filter(|pixel| pixel.alpha() > 0)
                .count()
        };

        assert!(count_ink(&marked) > count_ink(&base));
    }

    #[test]
    fn field_marker_runs_do_not_gain_space_marks() {
        let mut tree = crate::renderer::render_tree::PageRenderTree::new(0, 120.0, 60.0);
        tree.root.children.push(RenderNode::new(
            1,
            RenderNodeType::TextRun(TextRunNode {
                text: "a b".to_string(),
                style: TextStyle {
                    font_size: 22.0,
                    color: 0x00000000,
                    ..Default::default()
                },
                char_shape_id: None,
                para_shape_id: None,
                section_index: None,
                para_index: None,
                char_start: None,
                cell_context: None,
                is_para_end: false,
                is_line_break_end: false,
                rotation: 0.0,
                is_vertical: false,
                char_overlap: None,
                border_fill_id: 0,
                baseline: 26.0,
                field_marker: crate::renderer::render_tree::FieldMarkerType::FieldBegin,
            }),
            BoundingBox::new(10.0, 12.0, 70.0, 32.0),
        ));

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let base_tree = builder.build(&tree);
        let mut marked_builder =
            LayerBuilder::new(RenderProfile::Screen).with_output_options(LayerOutputOptions {
                show_paragraph_marks: true,
                show_control_codes: true,
                ..Default::default()
            });
        let marked_tree = marked_builder.build(&tree);
        let renderer = SkiaLayerRenderer::new();
        let base_png = renderer.render_png(&base_tree).expect("base skia render");
        let marked_png = renderer
            .render_png(&marked_tree)
            .expect("marked skia render");
        let base = tiny_skia::Pixmap::decode_png(&base_png).expect("base decode");
        let marked = tiny_skia::Pixmap::decode_png(&marked_png).expect("marked decode");
        let count_ink = |pixmap: &tiny_skia::Pixmap| {
            pixmap
                .pixels()
                .iter()
                .filter(|pixel| pixel.alpha() > 0)
                .count()
        };

        assert_eq!(
            count_ink(&marked),
            count_ink(&base),
            "field marker TextRuns should not receive extra visible space marks"
        );
    }

    #[test]
    fn renders_tab_leaders_for_skipped_tab_clusters() {
        let render_with_leaders = |tab_leaders| {
            let mut tree = crate::renderer::render_tree::PageRenderTree::new(0, 120.0, 60.0);
            tree.root.children.push(RenderNode::new(
                1,
                RenderNodeType::TextRun(TextRunNode {
                    text: "\t".to_string(),
                    style: TextStyle {
                        font_size: 18.0,
                        color: 0x00000000,
                        tab_leaders,
                        ..Default::default()
                    },
                    char_shape_id: None,
                    para_shape_id: None,
                    section_index: None,
                    para_index: None,
                    char_start: None,
                    cell_context: None,
                    is_para_end: false,
                    is_line_break_end: false,
                    rotation: 0.0,
                    is_vertical: false,
                    char_overlap: None,
                    border_fill_id: 0,
                    baseline: 30.0,
                    field_marker: Default::default(),
                }),
                BoundingBox::new(10.0, 16.0, 90.0, 30.0),
            ));
            let mut builder = LayerBuilder::new(RenderProfile::Screen);
            let layer_tree = builder.build(&tree);
            let renderer = SkiaLayerRenderer::new();
            let png = renderer
                .render_png(&layer_tree)
                .expect("skia tab leader render");
            let pixmap = tiny_skia::Pixmap::decode_png(&png).expect("tab leader decode");
            pixmap
                .pixels()
                .iter()
                .filter(|pixel| pixel.alpha() > 0)
                .count()
        };

        let without_leaders = render_with_leaders(Vec::new());
        let with_leaders = render_with_leaders(vec![TabLeaderInfo {
            start_x: 0.0,
            end_x: 80.0,
            fill_type: 1,
        }]);

        assert!(with_leaders > without_leaders);
    }

    #[test]
    fn consumes_profile_and_cache_hints_for_sampling_policy() {
        let screen =
            SkiaReplayContext::new(RenderProfile::Screen, LayerOutputOptions::default(), 1.0);
        let screen_policy = screen.replay_policy();
        assert_eq!(screen_policy.image_sampling, ImageSampling::linear());
        assert!(screen_policy.vector_antialias);
        assert!(screen_policy.clip_antialias);
        assert!(screen_policy.prefer_direct_text);

        let fast_preview = SkiaReplayContext::new(
            RenderProfile::FastPreview,
            LayerOutputOptions::default(),
            1.0,
        );
        let fast_preview_policy = fast_preview.replay_policy();
        assert_eq!(fast_preview_policy.image_sampling, ImageSampling::nearest());
        assert!(fast_preview_policy.vector_antialias);
        assert!(fast_preview_policy.clip_antialias);

        let print =
            SkiaReplayContext::new(RenderProfile::Print, LayerOutputOptions::default(), 1.0);
        assert_eq!(
            print.replay_policy().image_sampling,
            ImageSampling::linear_mipmap()
        );

        let mut raster = SkiaReplayContext::new(
            RenderProfile::HighQuality,
            LayerOutputOptions::default(),
            1.0,
        );
        raster.push_cache_hint(CacheHint::PreferRaster);
        let raster_policy = raster.replay_policy();
        assert_eq!(raster_policy.image_sampling, ImageSampling::nearest());
        assert!(raster_policy.vector_antialias);
        assert!(raster_policy.clip_antialias);

        let mut fast_raster = SkiaReplayContext::new(
            RenderProfile::FastPreview,
            LayerOutputOptions::default(),
            1.0,
        );
        fast_raster.push_cache_hint(CacheHint::PreferRaster);
        let fast_raster_policy = fast_raster.replay_policy();
        assert_eq!(fast_raster_policy.image_sampling, ImageSampling::nearest());
        assert!(!fast_raster_policy.vector_antialias);
        assert!(!fast_raster_policy.clip_antialias);

        let mut vector =
            SkiaReplayContext::new(RenderProfile::Screen, LayerOutputOptions::default(), 1.0);
        vector.push_cache_hint(CacheHint::PreferVectorRecording);
        let vector_policy = vector.replay_policy();
        assert_eq!(vector_policy.image_sampling, ImageSampling::linear_mipmap());
        assert!(vector_policy.vector_antialias);
    }
}
