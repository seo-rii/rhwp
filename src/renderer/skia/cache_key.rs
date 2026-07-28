use crate::model::control::FormType;
use crate::model::image::ImageEffect;
use crate::model::style::ImageFillMode;
use crate::paint::{
    sidecars_for_leaf_ops, CacheHint, ClipKind, ClipPolicy, ImageResourceId, LayerGlyphRunPaint,
    LayerNode, LayerNodeKind, LayerOutputOptions, LayerSemantic, LayerSemanticRole,
    LayerTextControlMarkKind, LayerTextOrientation, LayerTextRunPaint, PaintOp, PaintTextStyle,
    ResourceArena, SvgResourceId,
};
use crate::renderer::render_tree::{BoundingBox, FieldMarkerType, ShapeTransform};
use crate::renderer::{
    ArrowStyle, GradientFillInfo, LineRenderType, LineStyle, PathCommand, ShapeStyle, StrokeDash,
    TabLeaderInfo, TextStyle, UnderlineType,
};

use super::cache::StaticPictureCacheKey;

pub(super) struct StaticSubtreeCacheKey {
    hash: u64,
    fingerprint: u64,
}

impl StaticSubtreeCacheKey {
    pub(super) fn new() -> Self {
        Self {
            hash: 0xcbf2_9ce4_8422_2325,
            fingerprint: 0x6c62_272e_07bb_0142,
        }
    }

    pub(super) fn finish(self) -> StaticPictureCacheKey {
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

    fn mix_i8(&mut self, value: i8) {
        self.mix_bytes(&value.to_le_bytes());
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

    pub(super) fn mix_f64(&mut self, value: f64) {
        self.mix_u64(value.to_bits());
    }

    pub(super) fn mix_str(&mut self, value: &str) {
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

    fn mix_option_str(&mut self, value: Option<&str>) {
        match value {
            Some(value) => {
                self.mix_bool(true);
                self.mix_str(value);
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

    pub(super) fn mix_output_options(&mut self, output_options: &LayerOutputOptions) {
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
            ClipKind::TextBox => 2,
            ClipKind::Generic => 3,
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

    pub(super) fn mix_layer_node(&mut self, node: &LayerNode, resources: &ResourceArena) {
        self.mix_layer_node_with_sidecars(node, resources, &[]);
    }

    pub(super) fn mix_layer_node_with_sidecars(
        &mut self,
        node: &LayerNode,
        resources: &ResourceArena,
        variant_ops: &[PaintOp],
    ) {
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
                    self.mix_layer_node_with_sidecars(child, resources, variant_ops);
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
                self.mix_layer_node_with_sidecars(child, resources, variant_ops);
            }
            LayerNodeKind::Leaf { ops, cache_hint } => {
                let sidecars = sidecars_for_leaf_ops(ops, variant_ops);
                self.mix_u8(2);
                self.mix_cache_hint(*cache_hint);
                self.mix_usize(ops.len() + sidecars.len());
                for op in ops {
                    self.mix_paint_op(op, resources);
                }
                for op in &sidecars {
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
                        self.mix_i8(image.brightness);
                        self.mix_i8(image.contrast);
                        self.mix_image_effect(image.effect);
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
            PaintOp::GlyphRun { bbox, run } => {
                self.mix_u8(14);
                self.mix_bbox(bbox);
                self.mix_glyph_run(run, resources);
            }
            PaintOp::GlyphOutline { bbox, outline } => {
                self.mix_u8(15);
                self.mix_bbox(bbox);
                self.mix_variant_meta(Some(&outline.variant));
                self.mix_glyph_run_diagnostics(&outline.diagnostics);
                self.mix_u8(match outline.payload_kind {
                    crate::paint::GlyphOutlinePayloadKind::MonochromeFill => 0,
                    crate::paint::GlyphOutlinePayloadKind::MonochromeFillStroke => 1,
                    crate::paint::GlyphOutlinePayloadKind::ColorLayers => 2,
                    crate::paint::GlyphOutlinePayloadKind::BitmapGlyph => 3,
                    crate::paint::GlyphOutlinePayloadKind::SvgGlyph => 4,
                });
                self.mix_glyph_outline_stroke(outline.stroke.as_ref());
                self.mix_glyph_outline_color_layers(outline.color_layers.as_ref());
                self.mix_glyph_outline_bitmap_glyph(outline.bitmap_glyph.as_ref(), resources);
                self.mix_glyph_outline_svg_glyph(outline.svg_glyph.as_ref(), resources);
                self.mix_paint_text_style(&outline.paint_style);
                self.mix_text_run_placement(outline.placement);
                self.mix_usize(outline.paths.len());
                for path in &outline.paths {
                    self.mix_u32(path.glyph_id);
                    self.mix_u32(path.source_range_utf8.start);
                    self.mix_u32(path.source_range_utf8.end);
                    self.mix_u32(path.glyph_range.start);
                    self.mix_u32(path.glyph_range.end);
                    self.mix_u8(match path.fill_rule {
                        crate::paint::GlyphOutlineFillRule::NonZero => 0,
                        crate::paint::GlyphOutlineFillRule::EvenOdd => 1,
                    });
                    self.mix_usize(path.commands.len());
                    for command in &path.commands {
                        self.mix_path_command(command);
                    }
                }
            }
            PaintOp::CharOverlap { bbox, overlap } => {
                self.mix_u8(10);
                self.mix_bbox(bbox);
                self.mix_str(&overlap.text);
                self.mix_text_style(&overlap.style);
                self.mix_f64(overlap.baseline);
                self.mix_f64(overlap.rotation);
                self.mix_bool(overlap.is_vertical);
                self.mix_u8(match overlap.orientation {
                    crate::paint::LayerTextOrientation::Horizontal => 0,
                    crate::paint::LayerTextOrientation::VerticalUpright => 1,
                    crate::paint::LayerTextOrientation::VerticalSideways => 2,
                });
                for position in &overlap.positions {
                    self.mix_f64(*position);
                }
                self.mix_u8(overlap.overlap.border_type);
                self.mix_u8(overlap.overlap.inner_char_size as u8);
            }
            PaintOp::TextControlMark { bbox, mark } => {
                self.mix_u8(11);
                self.mix_bbox(bbox);
                self.mix_u8(match mark.mark.kind {
                    crate::paint::LayerTextControlMarkKind::Space => 0,
                    crate::paint::LayerTextControlMarkKind::Tab => 1,
                    crate::paint::LayerTextControlMarkKind::ParagraphEnd => 2,
                    crate::paint::LayerTextControlMarkKind::LineBreakEnd => 3,
                });
                self.mix_f64(mark.mark.x);
                self.mix_f64(mark.mark.y);
                self.mix_f64(mark.mark.font_size);
            }
            PaintOp::TabLeader { bbox, leader } => {
                self.mix_u8(12);
                self.mix_bbox(bbox);
                self.mix_f64(leader.leader.start_x);
                self.mix_f64(leader.leader.end_x);
                self.mix_u8(leader.leader.fill_type);
                self.mix_u32(leader.color);
                self.mix_f64(leader.font_size);
                self.mix_f64(leader.baseline);
            }
            PaintOp::TextDecoration { bbox, decoration } => {
                self.mix_u8(13);
                self.mix_bbox(bbox);
                self.mix_u8(match decoration.kind {
                    crate::paint::LayerTextDecorationKind::Underline => 0,
                    crate::paint::LayerTextDecorationKind::Strikethrough => 1,
                    crate::paint::LayerTextDecorationKind::EmphasisDot => 2,
                });
                self.mix_usize(decoration.positions.len());
                for position in &decoration.positions {
                    self.mix_f64(*position);
                }
                self.mix_f64(decoration.baseline);
                self.mix_f64(decoration.rotation);
                self.mix_f64(decoration.font_size);
                self.mix_f64(decoration.ratio);
                self.mix_u32(decoration.color);
                self.mix_u8(decoration.shape);
                self.mix_underline(decoration.underline);
                self.mix_u8(decoration.emphasis_dot);
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
                self.mix_i8(image.brightness);
                self.mix_i8(image.contrast);
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
        self.mix_variant_meta(run.variant.as_ref());
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

    fn mix_glyph_run(&mut self, run: &LayerGlyphRunPaint, resources: &ResourceArena) {
        self.mix_variant_meta(Some(&run.variant));
        self.mix_glyph_run_diagnostics(&run.diagnostics);
        self.mix_paint_text_style(&run.paint_style);
        self.mix_str(&run.shape_key.font_instance.face_key.0);
        self.mix_font_face_resource(resources, &run.shape_key.font_instance.face_key);
        self.mix_f64(run.shape_key.font_instance.size_px);
        self.mix_usize(run.shape_key.font_instance.variations.len());
        for variation in &run.shape_key.font_instance.variations {
            self.mix_str(&variation.tag);
            self.mix_f64(f64::from(variation.value));
        }
        self.mix_bool(run.shape_key.font_instance.synthetic_bold);
        self.mix_bool(run.shape_key.font_instance.synthetic_italic);
        self.mix_u8(match run.shape_key.direction {
            crate::paint::TextDirection::Ltr => 0,
            crate::paint::TextDirection::Rtl => 1,
            crate::paint::TextDirection::Auto => 2,
        });
        self.mix_u8(match run.shape_key.writing_mode {
            crate::paint::WritingMode::HorizontalTb => 0,
            crate::paint::WritingMode::VerticalRl => 1,
            crate::paint::WritingMode::VerticalLr => 2,
        });
        self.mix_str(
            run.shape_key
                .script
                .as_ref()
                .map_or("", |script| script.0.as_str()),
        );
        self.mix_str(
            run.shape_key
                .language
                .as_ref()
                .map_or("", |language| language.0.as_str()),
        );
        self.mix_usize(run.shape_key.features.len());
        for feature in &run.shape_key.features {
            self.mix_str(&feature.tag);
            self.mix_bool(feature.enabled);
            self.mix_u32(feature.value.unwrap_or(0));
        }
        self.mix_str(&run.shape_key.shaping_engine.0);
        self.mix_str(&run.shape_key.fallback_policy.0);
        self.mix_text_run_placement(run.placement);
        self.mix_usize(run.glyph_ids.len());
        for glyph_id in &run.glyph_ids {
            self.mix_u32(*glyph_id);
        }
        self.mix_usize(run.positions.len());
        for position in &run.positions {
            self.mix_f64(position.x);
            self.mix_f64(position.y);
        }
        if let Some(advances) = &run.advances {
            self.mix_bool(true);
            self.mix_usize(advances.len());
            for advance in advances {
                self.mix_f64(advance.dx);
                self.mix_f64(advance.dy);
            }
        } else {
            self.mix_bool(false);
        }
        self.mix_usize(run.clusters.len());
        for cluster in &run.clusters {
            self.mix_u32(cluster.source_range_utf8.start);
            self.mix_u32(cluster.source_range_utf8.end);
            if let Some(range) = cluster.source_range_utf16 {
                self.mix_bool(true);
                self.mix_u32(range.start);
                self.mix_u32(range.end);
            } else {
                self.mix_bool(false);
            }
            if let Some(range) = cluster.text_range_utf8 {
                self.mix_bool(true);
                self.mix_u32(range.start);
                self.mix_u32(range.end);
            } else {
                self.mix_bool(false);
            }
            self.mix_u32(cluster.glyph_range.start);
            self.mix_u32(cluster.glyph_range.end);
        }
        self.mix_u8(match run.orientation {
            crate::paint::GlyphRunOrientation::Horizontal => 0,
            crate::paint::GlyphRunOrientation::VerticalUpright => 1,
            crate::paint::GlyphRunOrientation::VerticalSideways => 2,
            crate::paint::GlyphRunOrientation::MixedPerGlyph => 3,
        });
    }

    fn mix_variant_meta(&mut self, variant: Option<&crate::paint::PaintVariantMeta>) {
        let Some(variant) = variant else {
            self.mix_bool(false);
            return;
        };
        self.mix_bool(true);
        self.mix_str(&variant.equivalence_group);
        self.mix_str(&variant.variant_id);
        self.mix_u8(match variant.variant_kind {
            crate::paint::TextVariantKind::TextRun => 0,
            crate::paint::TextVariantKind::GlyphRun => 1,
            crate::paint::TextVariantKind::GlyphOutline => 2,
        });
        self.mix_u32(variant.part_index);
        self.mix_u32(variant.part_count);
        self.mix_bool(variant.is_default_fallback);
        self.mix_usize(variant.requires.len());
        for feature in &variant.requires {
            self.mix_str(feature);
        }
        self.mix_text_variant_quality_option(variant.quality);
        self.mix_option_str(variant.anchor_op_id.as_deref());
        self.mix_option_u32(variant.local_paint_order);
    }

    fn mix_text_variant_quality_option(
        &mut self,
        quality: Option<crate::paint::TextVariantQuality>,
    ) {
        match quality {
            Some(quality) => {
                self.mix_bool(true);
                self.mix_text_variant_quality(quality);
            }
            None => self.mix_bool(false),
        }
    }

    fn mix_text_variant_quality(&mut self, quality: crate::paint::TextVariantQuality) {
        self.mix_u8(match quality {
            crate::paint::TextVariantQuality::Exact => 0,
            crate::paint::TextVariantQuality::PositionAdjusted => 1,
            crate::paint::TextVariantQuality::Approximate => 2,
            crate::paint::TextVariantQuality::DiagnosticOnly => 3,
            crate::paint::TextVariantQuality::Omitted => 4,
        });
    }

    fn mix_glyph_run_diagnostics(&mut self, diagnostics: &crate::paint::GlyphRunDiagnostics) {
        self.mix_text_variant_quality(diagnostics.quality);
        self.mix_u8(match diagnostics.replay_eligibility {
            crate::paint::GlyphRunReplayEligibility::Portable => 0,
            crate::paint::GlyphRunReplayEligibility::ConditionalExternalFont => 1,
            crate::paint::GlyphRunReplayEligibility::LocalDiagnosticOnly => 2,
            crate::paint::GlyphRunReplayEligibility::NotReplayable => 3,
        });
        self.mix_bool(diagnostics.strict_visual_eligible);
        self.mix_f64(diagnostics.max_origin_delta_px);
        self.mix_f64(diagnostics.max_advance_delta_px);
        self.mix_f64(diagnostics.max_residual_after_adjustment_px);
        self.mix_u32(diagnostics.cluster_mismatch_count);
        self.mix_u32(diagnostics.missing_glyph_count);
        self.mix_u32(diagnostics.used_fallback_font_count);
        self.mix_option_str(diagnostics.reason.as_deref());
    }

    fn mix_font_face_resource(
        &mut self,
        resources: &ResourceArena,
        face_key: &crate::paint::FontFaceKey,
    ) {
        let font_resources = resources.font_resources();
        let Some(face) = font_resources
            .faces
            .iter()
            .find(|face| face.id == *face_key)
        else {
            self.mix_bool(false);
            return;
        };
        self.mix_bool(true);
        self.mix_str(&face.id.0);
        self.mix_str(&face.blob_key.0);
        self.mix_u32(face.face_index);
        self.mix_option_str(face.postscript_name.as_deref());
        self.mix_usize(face.family_names.len());
        for name in &face.family_names {
            self.mix_option_str(name.locale.as_deref());
            self.mix_str(&name.value);
        }
        self.mix_usize(face.style_names.len());
        for name in &face.style_names {
            self.mix_option_str(name.locale.as_deref());
            self.mix_str(&name.value);
        }
        self.mix_option_u16(face.weight_class);
        self.mix_option_u16(face.width_class);
        match face.italic {
            Some(value) => {
                self.mix_bool(true);
                self.mix_bool(value);
            }
            None => self.mix_bool(false),
        }

        let Some(blob) = font_resources
            .blobs
            .iter()
            .find(|blob| blob.id == face.blob_key)
        else {
            self.mix_bool(false);
            return;
        };
        self.mix_bool(true);
        self.mix_str(&blob.id.0);
        self.mix_font_digest(blob.digest.as_ref());
        self.mix_u8(match blob.source {
            crate::paint::FontResourceSource::Embedded => 0,
            crate::paint::FontResourceSource::Bundled => 1,
            crate::paint::FontResourceSource::SystemResolved => 2,
            crate::paint::FontResourceSource::ExternalUrl => 3,
            crate::paint::FontResourceSource::UnresolvedFallback => 4,
        });
        self.mix_binary_resource_ref(blob.data_ref.as_ref());
        self.mix_font_portability(&blob.portability);
    }

    fn mix_font_digest(&mut self, digest: Option<&crate::paint::FontDigest>) {
        match digest {
            Some(digest) => {
                self.mix_bool(true);
                self.mix_str(&digest.algorithm);
                self.mix_str(&digest.value);
            }
            None => self.mix_bool(false),
        }
    }

    fn mix_binary_resource_ref(&mut self, data_ref: Option<&crate::paint::BinaryResourceRef>) {
        match data_ref {
            Some(data_ref) => {
                self.mix_bool(true);
                self.mix_u8(match data_ref.kind {
                    crate::paint::BinaryResourceKind::FontBlob => 0,
                    crate::paint::BinaryResourceKind::ExternalFont => 1,
                });
                self.mix_str(&data_ref.id);
            }
            None => self.mix_bool(false),
        }
    }

    fn mix_font_portability(&mut self, portability: &crate::paint::FontPortability) {
        match portability {
            crate::paint::FontPortability::PortableBlob { digest, data_ref } => {
                self.mix_u8(0);
                self.mix_font_digest(Some(digest));
                self.mix_binary_resource_ref(Some(data_ref));
            }
            crate::paint::FontPortability::ExternalVerified {
                digest,
                external_ref,
            } => {
                self.mix_u8(1);
                self.mix_font_digest(Some(digest));
                self.mix_str(&external_ref.url);
            }
            crate::paint::FontPortability::ResolvedButNotEmbedded { digest } => {
                self.mix_u8(2);
                self.mix_font_digest(digest.as_ref());
            }
            crate::paint::FontPortability::SystemNameOnly => self.mix_u8(3),
            crate::paint::FontPortability::UnresolvedFallback => self.mix_u8(4),
        }
    }

    fn mix_text_run_placement(&mut self, placement: crate::paint::TextRunPlacement) {
        let transform = placement.run_to_page;
        self.mix_f64(transform.a);
        self.mix_f64(transform.b);
        self.mix_f64(transform.c);
        self.mix_f64(transform.d);
        self.mix_f64(transform.e);
        self.mix_f64(transform.f);
        self.mix_f64(placement.baseline_y);
    }

    fn mix_text_style(&mut self, style: &TextStyle) {
        let style = PaintTextStyle::from(style);
        self.mix_paint_text_style(&style);
    }

    fn mix_paint_text_style(&mut self, style: &PaintTextStyle) {
        self.mix_str(&style.font_family);
        self.mix_f64(style.font_size);
        self.mix_u32(style.color);
        self.mix_bool(style.bold);
        self.mix_bool(style.italic);
        self.mix_underline(style.underline);
        self.mix_bool(style.strikethrough);
        self.mix_f64(style.ratio);
        self.mix_usize(style.tab_leaders.len());
        for tab_leader in &style.tab_leaders {
            self.mix_tab_leader(tab_leader);
        }
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

    fn mix_glyph_outline_stroke(&mut self, stroke: Option<&crate::paint::GlyphOutlineStrokeStyle>) {
        let Some(stroke) = stroke else {
            self.mix_bool(false);
            return;
        };
        self.mix_bool(true);
        self.mix_u32(stroke.color);
        self.mix_f64(stroke.width_px);
        self.mix_u8(match stroke.join {
            crate::paint::GlyphOutlineStrokeJoin::Miter => 0,
            crate::paint::GlyphOutlineStrokeJoin::Round => 1,
            crate::paint::GlyphOutlineStrokeJoin::Bevel => 2,
        });
        self.mix_u8(match stroke.cap {
            crate::paint::GlyphOutlineStrokeCap::Butt => 0,
            crate::paint::GlyphOutlineStrokeCap::Round => 1,
            crate::paint::GlyphOutlineStrokeCap::Square => 2,
        });
        match stroke.miter_limit {
            Some(limit) => {
                self.mix_bool(true);
                self.mix_f64(limit);
            }
            None => self.mix_bool(false),
        }
        self.mix_u8(match stroke.paint_order {
            crate::paint::GlyphOutlinePaintOrder::FillOnly => 0,
            crate::paint::GlyphOutlinePaintOrder::StrokeOnly => 1,
            crate::paint::GlyphOutlinePaintOrder::FillThenStroke => 2,
            crate::paint::GlyphOutlinePaintOrder::StrokeThenFill => 3,
        });
    }

    fn mix_glyph_outline_color_layers(
        &mut self,
        payload: Option<&crate::paint::ColorLayersPayload>,
    ) {
        let Some(payload) = payload else {
            self.mix_bool(false);
            return;
        };
        self.mix_bool(true);
        self.mix_u8(match payload.color_format {
            crate::paint::ColorGlyphFormat::ColrV0 => 0,
            crate::paint::ColorGlyphFormat::ColrV1 => 1,
            crate::paint::ColorGlyphFormat::Other => 2,
        });
        if let Some(source) = &payload.source_font_ref {
            self.mix_bool(true);
            self.mix_option_str(source.face_key.as_deref());
            self.mix_option_u32(source.glyph_id);
            self.mix_option_u16(source.palette_index);
            match source.color_format {
                Some(format) => {
                    self.mix_bool(true);
                    self.mix_u8(match format {
                        crate::paint::ColorGlyphFormat::ColrV0 => 0,
                        crate::paint::ColorGlyphFormat::ColrV1 => 1,
                        crate::paint::ColorGlyphFormat::Other => 2,
                    });
                }
                None => self.mix_bool(false),
            }
        } else {
            self.mix_bool(false);
        }
        if let Some(palette) = &payload.palette_ref {
            self.mix_bool(true);
            self.mix_option_str(palette.id.as_deref());
            self.mix_option_u16(palette.index);
            self.mix_option_str(palette.cpal_digest.as_deref());
        } else {
            self.mix_bool(false);
        }
        self.mix_text_source_range_option(payload.source_range_utf8);
        self.mix_glyph_range_option(payload.glyph_range);
        self.mix_usize(payload.layers.len());
        for layer in &payload.layers {
            self.mix_option_u32(layer.layer_index);
            self.mix_option_u32(layer.glyph_id);
            self.mix_glyph_range_option(layer.glyph_range);
            self.mix_text_source_range_option(layer.source_range_utf8);
            if let Some(source) = &layer.source_font_ref {
                self.mix_bool(true);
                self.mix_option_str(source.face_key.as_deref());
                self.mix_option_u32(source.glyph_id);
                self.mix_option_u16(source.palette_index);
                match source.color_format {
                    Some(format) => {
                        self.mix_bool(true);
                        self.mix_u8(match format {
                            crate::paint::ColorGlyphFormat::ColrV0 => 0,
                            crate::paint::ColorGlyphFormat::ColrV1 => 1,
                            crate::paint::ColorGlyphFormat::Other => 2,
                        });
                    }
                    None => self.mix_bool(false),
                }
            } else {
                self.mix_bool(false);
            }
            self.mix_option_u32(layer.path_index);
            if let Some(commands) = &layer.commands {
                self.mix_bool(true);
                self.mix_usize(commands.len());
                for command in commands {
                    self.mix_path_command(command);
                }
            } else {
                self.mix_bool(false);
            }
            if let Some(fill) = &layer.fill {
                self.mix_bool(true);
                self.mix_option_str(fill.color_space.as_deref());
                for channel in fill.rgba {
                    self.mix_u32(channel.to_bits());
                }
            } else {
                self.mix_bool(false);
            }
            match layer.fill_rule {
                Some(crate::paint::GlyphOutlineFillRule::NonZero) => {
                    self.mix_bool(true);
                    self.mix_u8(0);
                }
                Some(crate::paint::GlyphOutlineFillRule::EvenOdd) => {
                    self.mix_bool(true);
                    self.mix_u8(1);
                }
                None => self.mix_bool(false),
            }
            self.mix_option_u16(layer.palette_index);
            self.mix_option_u32(layer.color);
            match layer.opacity {
                Some(opacity) => {
                    self.mix_bool(true);
                    self.mix_f64(opacity);
                }
                None => self.mix_bool(false),
            }
            self.mix_layer_affine_transform_option(layer.transform_to_run);
        }
        if let Some(graph) = &payload.paint_graph {
            self.mix_bool(true);
            self.mix_u32(graph.root_node_id);
            self.mix_usize(graph.nodes.len());
            for node in &graph.nodes {
                self.mix_u32(node.node_id);
                self.mix_u8(match node.kind {
                    crate::paint::ColorPaintGraphNodeKind::SolidPath => 0,
                    crate::paint::ColorPaintGraphNodeKind::LinearGradientPath => 1,
                    crate::paint::ColorPaintGraphNodeKind::RadialGradientPath => 2,
                    crate::paint::ColorPaintGraphNodeKind::SweepGradientPath => 3,
                    crate::paint::ColorPaintGraphNodeKind::Transform => 4,
                    crate::paint::ColorPaintGraphNodeKind::Composite => 5,
                    crate::paint::ColorPaintGraphNodeKind::Clip => 6,
                });
                if let Some(solid) = &node.solid_path {
                    self.mix_bool(true);
                    self.mix_usize(solid.commands.len());
                    for command in &solid.commands {
                        self.mix_path_command(command);
                    }
                    self.mix_option_str(solid.fill.color_space.as_deref());
                    for channel in solid.fill.rgba {
                        self.mix_u32(channel.to_bits());
                    }
                    self.mix_u8(match solid.fill_rule {
                        crate::paint::GlyphOutlineFillRule::NonZero => 0,
                        crate::paint::GlyphOutlineFillRule::EvenOdd => 1,
                    });
                    self.mix_option_u32(solid.source_glyph_id);
                    self.mix_option_u16(solid.palette_index);
                } else {
                    self.mix_bool(false);
                }
                if let Some(gradient_path) = &node.linear_gradient_path {
                    self.mix_bool(true);
                    self.mix_usize(gradient_path.commands.len());
                    for command in &gradient_path.commands {
                        self.mix_path_command(command);
                    }
                    self.mix_f64(gradient_path.gradient.x0);
                    self.mix_f64(gradient_path.gradient.y0);
                    self.mix_f64(gradient_path.gradient.x1);
                    self.mix_f64(gradient_path.gradient.y1);
                    self.mix_color_gradient_stops(&gradient_path.gradient.stops);
                    self.mix_u8(match gradient_path.fill_rule {
                        crate::paint::GlyphOutlineFillRule::NonZero => 0,
                        crate::paint::GlyphOutlineFillRule::EvenOdd => 1,
                    });
                    self.mix_option_u32(gradient_path.source_glyph_id);
                    self.mix_option_u16(gradient_path.palette_index);
                } else {
                    self.mix_bool(false);
                }
                if let Some(gradient_path) = &node.radial_gradient_path {
                    self.mix_bool(true);
                    self.mix_usize(gradient_path.commands.len());
                    for command in &gradient_path.commands {
                        self.mix_path_command(command);
                    }
                    self.mix_f64(gradient_path.gradient.cx);
                    self.mix_f64(gradient_path.gradient.cy);
                    self.mix_f64(gradient_path.gradient.radius);
                    self.mix_color_gradient_stops(&gradient_path.gradient.stops);
                    self.mix_u8(match gradient_path.fill_rule {
                        crate::paint::GlyphOutlineFillRule::NonZero => 0,
                        crate::paint::GlyphOutlineFillRule::EvenOdd => 1,
                    });
                    self.mix_option_u32(gradient_path.source_glyph_id);
                    self.mix_option_u16(gradient_path.palette_index);
                } else {
                    self.mix_bool(false);
                }
                if let Some(gradient_path) = &node.sweep_gradient_path {
                    self.mix_bool(true);
                    self.mix_usize(gradient_path.commands.len());
                    for command in &gradient_path.commands {
                        self.mix_path_command(command);
                    }
                    self.mix_f64(gradient_path.gradient.cx);
                    self.mix_f64(gradient_path.gradient.cy);
                    self.mix_f64(gradient_path.gradient.start_angle_degrees);
                    self.mix_f64(gradient_path.gradient.end_angle_degrees);
                    self.mix_color_gradient_stops(&gradient_path.gradient.stops);
                    self.mix_u8(match gradient_path.fill_rule {
                        crate::paint::GlyphOutlineFillRule::NonZero => 0,
                        crate::paint::GlyphOutlineFillRule::EvenOdd => 1,
                    });
                    self.mix_option_u32(gradient_path.source_glyph_id);
                    self.mix_option_u16(gradient_path.palette_index);
                } else {
                    self.mix_bool(false);
                }
                if let Some(transform) = &node.transform {
                    self.mix_bool(true);
                    self.mix_u32(transform.child_node_id);
                    self.mix_layer_affine_transform_option(Some(transform.transform));
                } else {
                    self.mix_bool(false);
                }
                if let Some(composite) = &node.composite {
                    self.mix_bool(true);
                    self.mix_u32(composite.backdrop_node_id);
                    self.mix_u32(composite.source_node_id);
                    self.mix_u8(match composite.mode {
                        crate::paint::ColorPaintCompositeMode::SourceOver => 0,
                    });
                } else {
                    self.mix_bool(false);
                }
                if let Some(clip) = &node.clip {
                    self.mix_bool(true);
                    self.mix_u32(clip.child_node_id);
                    self.mix_usize(clip.clip_commands.len());
                    for command in &clip.clip_commands {
                        self.mix_path_command(command);
                    }
                    self.mix_u8(match clip.fill_rule {
                        crate::paint::GlyphOutlineFillRule::NonZero => 0,
                        crate::paint::GlyphOutlineFillRule::EvenOdd => 1,
                    });
                } else {
                    self.mix_bool(false);
                }
                self.mix_text_source_range_option(node.source_range_utf8);
                self.mix_glyph_range_option(node.glyph_range);
                if let Some(source) = &node.source_font_ref {
                    self.mix_bool(true);
                    self.mix_option_str(source.face_key.as_deref());
                    self.mix_option_u32(source.glyph_id);
                    self.mix_option_u16(source.palette_index);
                    match source.color_format {
                        Some(format) => {
                            self.mix_bool(true);
                            self.mix_u8(match format {
                                crate::paint::ColorGlyphFormat::ColrV0 => 0,
                                crate::paint::ColorGlyphFormat::ColrV1 => 1,
                                crate::paint::ColorGlyphFormat::Other => 2,
                            });
                        }
                        None => self.mix_bool(false),
                    }
                } else {
                    self.mix_bool(false);
                }
            }
        } else {
            self.mix_bool(false);
        }
    }

    fn mix_color_gradient_stops(&mut self, stops: &[crate::paint::ColorGradientStop]) {
        self.mix_usize(stops.len());
        for stop in stops {
            self.mix_f64(stop.offset);
            self.mix_option_str(stop.color.color_space.as_deref());
            for channel in stop.color.rgba {
                self.mix_u32(channel.to_bits());
            }
        }
    }

    fn mix_glyph_outline_bitmap_glyph(
        &mut self,
        payload: Option<&crate::paint::BitmapGlyphPayload>,
        resources: &ResourceArena,
    ) {
        let Some(payload) = payload else {
            self.mix_bool(false);
            return;
        };
        self.mix_bool(true);
        self.mix_usize(payload.image_resource_id.0);
        self.mix_image_resource(resources, Some(payload.image_resource_id));
        self.mix_text_source_range_option(payload.source_range_utf8);
        self.mix_glyph_range_option(payload.glyph_range);
        match payload.placement {
            Some(placement) => {
                self.mix_bool(true);
                self.mix_text_run_placement(placement);
            }
            None => self.mix_bool(false),
        }
        self.mix_layer_affine_transform_option(payload.transform_to_run);
        match payload.strike_ppem {
            Some((x, y)) => {
                self.mix_bool(true);
                self.mix_u16(x);
                self.mix_u16(y);
            }
            None => self.mix_bool(false),
        }
        match payload.strike_selection {
            Some(crate::paint::BitmapStrikeSelection::ProducerResolved) => {
                self.mix_bool(true);
                self.mix_u8(0);
            }
            Some(crate::paint::BitmapStrikeSelection::DiagnosticOnly) => {
                self.mix_bool(true);
                self.mix_u8(1);
            }
            None => self.mix_bool(false),
        }
        self.mix_option_str(payload.pixel_format.as_deref());
        self.mix_option_str(payload.color_space.as_deref());
        match payload.alpha_mode {
            Some(crate::paint::BitmapAlphaMode::Premultiplied) => {
                self.mix_bool(true);
                self.mix_u8(0);
            }
            Some(crate::paint::BitmapAlphaMode::Straight) => {
                self.mix_bool(true);
                self.mix_u8(1);
            }
            None => self.mix_bool(false),
        }
        match payload.scaling_policy {
            Some(policy) => {
                self.mix_bool(true);
                self.mix_u8(match policy {
                    crate::paint::BitmapGlyphScalingPolicy::NoScale => 0,
                    crate::paint::BitmapGlyphScalingPolicy::ScaleToEm => 1,
                    crate::paint::BitmapGlyphScalingPolicy::ExplicitTransform => 2,
                    crate::paint::BitmapGlyphScalingPolicy::BackendDefault => 3,
                });
            }
            None => self.mix_bool(false),
        }
        match payload.filtering {
            Some(filtering) => {
                self.mix_bool(true);
                self.mix_u8(match filtering {
                    crate::paint::BitmapGlyphFiltering::Nearest => 0,
                    crate::paint::BitmapGlyphFiltering::Linear => 1,
                    crate::paint::BitmapGlyphFiltering::BackendDefault => 2,
                });
            }
            None => self.mix_bool(false),
        }
    }

    fn mix_glyph_outline_svg_glyph(
        &mut self,
        payload: Option<&crate::paint::SvgGlyphPayload>,
        resources: &ResourceArena,
    ) {
        let Some(payload) = payload else {
            self.mix_bool(false);
            return;
        };
        self.mix_bool(true);
        self.mix_usize(payload.vector_resource_id.0);
        self.mix_svg_resource(resources, payload.vector_resource_id);
        self.mix_text_source_range_option(payload.source_range_utf8);
        self.mix_glyph_range_option(payload.glyph_range);
        match payload.placement {
            Some(placement) => {
                self.mix_bool(true);
                self.mix_text_run_placement(placement);
            }
            None => self.mix_bool(false),
        }
        self.mix_layer_affine_transform_option(payload.transform_to_run);
        match payload.view_box {
            Some(view_box) => {
                self.mix_bool(true);
                self.mix_f64(view_box.x);
                self.mix_f64(view_box.y);
                self.mix_f64(view_box.width);
                self.mix_f64(view_box.height);
            }
            None => self.mix_bool(false),
        }
        match payload.intrinsic_size {
            Some(size) => {
                self.mix_bool(true);
                self.mix_f64(size.width);
                self.mix_f64(size.height);
            }
            None => self.mix_bool(false),
        }
        self.mix_u8(match payload.security_mode {
            crate::paint::SvgGlyphSecurityMode::StaticSanitized => 0,
        });
        self.mix_bool(payload.script_allowed);
        self.mix_bool(payload.animation_allowed);
        self.mix_bool(payload.external_resources_allowed);
        self.mix_bool(payload.interactivity_allowed);
    }

    fn mix_text_source_range_option(&mut self, range: Option<crate::paint::TextSourceRange>) {
        match range {
            Some(range) => {
                self.mix_bool(true);
                self.mix_u32(range.start);
                self.mix_u32(range.end);
            }
            None => self.mix_bool(false),
        }
    }

    fn mix_glyph_range_option(&mut self, range: Option<crate::paint::GlyphRange>) {
        match range {
            Some(range) => {
                self.mix_bool(true);
                self.mix_u32(range.start);
                self.mix_u32(range.end);
            }
            None => self.mix_bool(false),
        }
    }

    fn mix_layer_affine_transform_option(
        &mut self,
        transform: Option<crate::paint::LayerAffineTransform>,
    ) {
        match transform {
            Some(transform) => {
                self.mix_bool(true);
                self.mix_f64(transform.a);
                self.mix_f64(transform.b);
                self.mix_f64(transform.c);
                self.mix_f64(transform.d);
                self.mix_f64(transform.e);
                self.mix_f64(transform.f);
            }
            None => self.mix_bool(false),
        }
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
                match resources.image_fingerprint(id) {
                    Some(fingerprint) => {
                        self.mix_bool(true);
                        self.mix_bytes(&fingerprint);
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
                match resources.svg_fingerprint(resource_id) {
                    Some(fingerprint) => {
                        self.mix_bool(true);
                        self.mix_bytes(&fingerprint);
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
            ImageFillMode::Total => 16,
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
