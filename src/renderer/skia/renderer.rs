use skia_safe::{
    surfaces, Canvas, Color, EncodedImageFormat, FontMgr, Matrix, Paint, PathBuilder,
    PictureRecorder, Rect, Shaper,
};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use crate::model::image::ImageEffect;
use crate::paint::{
    CacheHint, GlyphRunOrientation, GlyphRunReplayEligibility, LayerGlyphRunPaint, LayerNode,
    LayerNodeKind, PageLayerTree, PaintOp, ResourceArena, TextVariantQuality,
};
use crate::renderer::layer_renderer::{
    LayerRasterRenderer, LayerRenderError, LayerRenderResult, RasterOutputFormat,
    RasterRenderOptions, RasterRenderOutput,
};
use crate::renderer::render_tree::BoundingBox;
use crate::renderer::{ArrowStyle, LineRenderType};

use super::cache::StaticPictureCache;
use super::cache_key::StaticSubtreeCacheKey;
use super::equation_conv::render_equation;
use super::form_replay;
use super::image_conv::{draw_decoded_image, draw_missing_image_placeholder, ImageSampling};
use super::paint_conv::{
    colorref_to_skia, make_background_fill_paint, make_fill_paint, make_font, make_line_paint,
    make_stroke_paint,
};
use super::path_conv::to_skia_path;
use super::replay_context::SkiaReplayContext;

pub struct SkiaLayerRenderer {
    pub(super) font_mgr: FontMgr,
    pub(super) text_shaper: Shaper,
    static_picture_cache: RefCell<StaticPictureCache>,
}

const MAX_RASTER_DIMENSION: i32 = 16_384;
const MAX_STATIC_PICTURE_CACHE_ENTRIES: usize = 64;
const MAX_STATIC_PICTURE_CACHE_BYTES: usize = 32 * 1024 * 1024;

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

fn duration_ns(duration: Duration) -> u64 {
    duration.as_nanos().min(u128::from(u64::MAX)) as u64
}

fn native_skia_can_replay_glyph_run(run: &LayerGlyphRunPaint, resources: &ResourceArena) -> bool {
    if run.glyph_ids.is_empty()
        || run.glyph_ids.len() != run.positions.len()
        || run
            .advances
            .as_ref()
            .is_some_and(|advances| advances.len() != run.glyph_ids.len())
        || run.glyph_transforms.is_some()
        || run.orientation == GlyphRunOrientation::MixedPerGlyph
        || !run.diagnostics.strict_visual_eligible
        || run.diagnostics.missing_glyph_count != 0
        || run.diagnostics.cluster_mismatch_count != 0
        || !matches!(
            run.diagnostics.quality,
            TextVariantQuality::Exact | TextVariantQuality::PositionAdjusted
        )
        || run.diagnostics.replay_eligibility != GlyphRunReplayEligibility::Portable
    {
        return false;
    }
    let ratio = if run.paint_style.ratio > 0.0 {
        run.paint_style.ratio
    } else {
        1.0
    };
    if (ratio - 1.0).abs() > 0.001
        || !run.paint_style.tab_leaders.is_empty()
        || run.paint_style.underline != crate::model::style::UnderlineType::None
        || run.paint_style.strikethrough
        || run.paint_style.superscript
        || run.paint_style.subscript
        || run.paint_style.emphasis_dot != 0
        || (run.paint_style.shade_color & 0x00FF_FFFF) != 0x00FF_FFFF
    {
        return false;
    }
    let font_resources = resources.font_resources();
    let Some(face) = font_resources
        .faces
        .iter()
        .find(|face| face.id == run.shape_key.font_instance.face_key)
    else {
        return false;
    };
    let Some(blob) = font_resources
        .blobs
        .iter()
        .find(|blob| blob.id == face.blob_key)
    else {
        return false;
    };
    if !blob.portability.is_self_contained_replayable() {
        return false;
    }
    let transform = run.placement.run_to_page;
    [
        transform.a,
        transform.b,
        transform.c,
        transform.d,
        transform.e,
        transform.f,
        run.placement.baseline_y,
    ]
    .into_iter()
    .all(f64::is_finite)
        && run
            .glyph_ids
            .iter()
            .all(|glyph_id| *glyph_id <= u16::MAX as u32)
        && run
            .positions
            .iter()
            .all(|position| position.x.is_finite() && position.y.is_finite())
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
    antialias: bool,
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
    fill.set_anti_alias(antialias);
    fill.set_style(skia_safe::paint::Style::Fill);
    fill.set_color(colorref_to_skia(color, 1.0));

    let mut stroke = Paint::default();
    stroke.set_anti_alias(antialias);
    stroke.set_style(skia_safe::paint::Style::Stroke);
    stroke.set_stroke_width((stroke_width * 0.3).max(0.5) as f32);
    stroke.set_color(colorref_to_skia(color, 1.0));

    let mut open_fill = Paint::default();
    open_fill.set_anti_alias(antialias);
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
        self.render_raster_with_replay_config(tree, options, |_| {})
    }

    fn render_raster_with_replay_config(
        &self,
        tree: &PageLayerTree,
        options: RasterRenderOptions,
        configure_replay: impl FnOnce(&mut SkiaReplayContext),
    ) -> LayerRenderResult<RasterRenderOutput> {
        let total_start = Instant::now();
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

        let setup_start = Instant::now();
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
        configure_replay(&mut replay);
        let setup_time = setup_start.elapsed();

        let replay_start = Instant::now();
        self.render_node(canvas, &tree.root, &tree.resources, &mut replay);
        let replay_time = replay_start.elapsed();

        let encode_start = Instant::now();
        let image = surface.image_snapshot();
        let data = image
            .encode(None, EncodedImageFormat::PNG, None)
            .ok_or_else(|| LayerRenderError::encoding("Skia PNG 인코딩 실패"))?;
        let bytes = data.as_bytes().to_vec();
        let encode_time = encode_start.elapsed();
        let mut diagnostics = replay.diagnostics;
        diagnostics.raster_setup_time_ns = duration_ns(setup_time);
        diagnostics.raster_replay_time_ns = duration_ns(replay_time);
        diagnostics.raster_encode_time_ns = duration_ns(encode_time);
        diagnostics.raster_total_time_ns = duration_ns(total_start.elapsed());
        Ok(RasterRenderOutput {
            bytes,
            format: RasterOutputFormat::Png,
            width,
            height,
            dpi: options.dpi,
            color_space: options.color_space,
            diagnostics,
        })
    }

    #[cfg(test)]
    fn render_raster_with_image_effect_cache_limits_for_test(
        &self,
        tree: &PageLayerTree,
        options: RasterRenderOptions,
        max_entries: usize,
        max_bytes: usize,
    ) -> LayerRenderResult<RasterRenderOutput> {
        self.render_raster_with_replay_config(tree, options, |replay| {
            replay.set_image_effect_cache_limits(max_entries, max_bytes);
        })
    }

    fn render_node(
        &self,
        canvas: &Canvas,
        node: &LayerNode,
        resources: &ResourceArena,
        replay: &mut SkiaReplayContext,
    ) {
        replay.record_layer_node_replay();
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
                    let lookup = {
                        let mut cache = self.static_picture_cache.borrow_mut();
                        let had_hash = cache.contains_hash(cache_key.hash);
                        let picture = cache.get(cache_key);
                        (had_hash, picture, cache.approx_bytes())
                    };
                    let (had_hash, picture, approx_bytes) = lookup;
                    if let Some(picture) = picture {
                        replay.diagnostics.static_picture_cache_hits = replay
                            .diagnostics
                            .static_picture_cache_hits
                            .saturating_add(1);
                        replay.diagnostics.static_picture_cache_approx_bytes = approx_bytes;
                        canvas.draw_picture(&picture, None, None);
                        return;
                    }
                    if had_hash {
                        replay
                            .diagnostics
                            .static_picture_cache_fingerprint_mismatches = replay
                            .diagnostics
                            .static_picture_cache_fingerprint_mismatches
                            .saturating_add(1);
                    }
                    replay.diagnostics.static_picture_cache_misses = replay
                        .diagnostics
                        .static_picture_cache_misses
                        .saturating_add(1);
                    replay.record_static_picture_recording();

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
                        let (outcome, cache_bytes) = {
                            let mut cache = self.static_picture_cache.borrow_mut();
                            let outcome = cache.insert(cache_key, picture, approx_bytes);
                            (outcome, cache.approx_bytes())
                        };
                        replay.diagnostics.static_picture_cache_evictions = replay
                            .diagnostics
                            .static_picture_cache_evictions
                            .saturating_add(outcome.evictions);
                        if outcome.skipped_oversized {
                            replay.diagnostics.static_picture_cache_skipped_oversized = replay
                                .diagnostics
                                .static_picture_cache_skipped_oversized
                                .saturating_add(1);
                        }
                        replay.diagnostics.static_picture_cache_approx_bytes = cache_bytes;
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
                let mut variant_order = 0usize;
                let mut glyph_variants =
                    HashMap::<String, HashMap<String, (usize, u32, HashSet<u32>, bool)>>::new();
                for op in ops {
                    if let PaintOp::GlyphRun { run, .. } = op {
                        let group = glyph_variants
                            .entry(run.variant.equivalence_group.clone())
                            .or_default();
                        let state =
                            group
                                .entry(run.variant.variant_id.clone())
                                .or_insert_with(|| {
                                    let order = variant_order;
                                    variant_order = variant_order.saturating_add(1);
                                    (order, run.variant.part_count, HashSet::new(), true)
                                });
                        if state.1 != run.variant.part_count || run.variant.part_count == 0 {
                            state.3 = false;
                        }
                        state.2.insert(run.variant.part_index);
                        state.3 &= native_skia_can_replay_glyph_run(run, resources);
                    }
                }
                let mut selected_text_variants = HashMap::new();
                for (group, variants) in glyph_variants {
                    let mut candidates = variants.into_iter().collect::<Vec<_>>();
                    candidates.sort_by_key(|(_, (order, _, _, _))| *order);
                    for (variant_id, (_, expected_part_count, parts, supported)) in candidates {
                        let parts_complete = parts.len() as u32 == expected_part_count
                            && (0..expected_part_count).all(|index| parts.contains(&index));
                        if supported && parts_complete {
                            selected_text_variants.insert(group, variant_id);
                            break;
                        }
                    }
                }
                for op in ops {
                    let skip_unselected_text_variant =
                        match op {
                            PaintOp::TextRun { run, .. } => {
                                run.variant.as_ref().is_some_and(|variant| {
                                    match selected_text_variants.get(&variant.equivalence_group) {
                                        Some(selected) => selected != &variant.variant_id,
                                        None => false,
                                    }
                                })
                            }
                            PaintOp::GlyphRun { run, .. } => {
                                match selected_text_variants.get(&run.variant.equivalence_group) {
                                    Some(selected) => selected != &run.variant.variant_id,
                                    None => true,
                                }
                            }
                            _ => false,
                        };
                    if skip_unselected_text_variant {
                        continue;
                    }
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
        replay.record_paint_op_replay();
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
                    paint.set_anti_alias(replay.vector_antialias());
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
                // Vertical layout is already lowered into positioned text runs:
                // upright glyphs use their own bboxes and sideways glyphs carry
                // explicit run.rotation. Keep Skia aligned with SVG by not adding
                // another orientation-derived rotation here.
                let mut replay_run;
                let run = if run.legacy_visuals.char_overlap
                    == Some(crate::paint::TextLegacyVisualState::Mirror)
                    || run.legacy_visuals.control_marks
                        == Some(crate::paint::TextLegacyVisualState::Mirror)
                    || run.legacy_visuals.tab_leaders
                        == Some(crate::paint::TextLegacyVisualState::Mirror)
                    || run.legacy_visuals.decorations
                        == Some(crate::paint::TextLegacyVisualState::Mirror)
                {
                    replay_run = run.clone();
                    if replay_run.legacy_visuals.char_overlap
                        == Some(crate::paint::TextLegacyVisualState::Mirror)
                    {
                        replay_run.char_overlap = None;
                    }
                    if replay_run.legacy_visuals.control_marks
                        == Some(crate::paint::TextLegacyVisualState::Mirror)
                    {
                        replay_run.control_marks.clear();
                    }
                    if replay_run.legacy_visuals.tab_leaders
                        == Some(crate::paint::TextLegacyVisualState::Mirror)
                    {
                        replay_run.style.tab_leaders.clear();
                    }
                    if replay_run.legacy_visuals.decorations
                        == Some(crate::paint::TextLegacyVisualState::Mirror)
                    {
                        replay_run.style.underline = crate::model::style::UnderlineType::None;
                        replay_run.style.strikethrough = false;
                        replay_run.style.emphasis_dot = 0;
                    }
                    &replay_run
                } else {
                    run
                };
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
            PaintOp::GlyphRun { run, .. } => {
                if !native_skia_can_replay_glyph_run(run, resources) {
                    return;
                }
                let font_style = crate::renderer::TextStyle {
                    font_family: run.paint_style.font_family.clone(),
                    font_size: run.paint_style.font_size,
                    color: run.paint_style.color,
                    bold: run.paint_style.bold,
                    italic: run.paint_style.italic,
                    ..Default::default()
                };
                let font = make_font(&font_style, &self.font_mgr, "A");
                let transform = run.placement.run_to_page;
                let matrix = Matrix::from_affine(&[
                    transform.a as f32,
                    transform.b as f32,
                    transform.c as f32,
                    transform.d as f32,
                    transform.e as f32,
                    transform.f as f32,
                ]);
                let mut fill_paint = Paint::default();
                fill_paint.set_anti_alias(true);
                fill_paint.set_style(skia_safe::paint::Style::Fill);
                fill_paint.set_color(colorref_to_skia(run.paint_style.color, 1.0));

                let mut shadow_paint = Paint::default();
                shadow_paint.set_anti_alias(true);
                shadow_paint.set_style(skia_safe::paint::Style::Fill);
                shadow_paint.set_color(colorref_to_skia(run.paint_style.shadow_color, 1.0));

                let mut stroke_paint = Paint::default();
                stroke_paint.set_anti_alias(true);
                stroke_paint.set_style(skia_safe::paint::Style::Stroke);
                stroke_paint.set_stroke_width((run.paint_style.font_size as f32 / 25.0).max(0.5));
                stroke_paint.set_color(colorref_to_skia(run.paint_style.color, 1.0));

                let mut highlight_paint = Paint::default();
                highlight_paint.set_anti_alias(true);
                highlight_paint.set_style(skia_safe::paint::Style::Fill);
                highlight_paint.set_color(Color::WHITE);

                let draw_glyph_paths = |paint: &Paint, x_offset: f32, y_offset: f32| {
                    for (glyph_id, position) in run.glyph_ids.iter().zip(run.positions.iter()) {
                        let glyph_id = *glyph_id as u16;
                        if let Some(path) = font.get_path(glyph_id) {
                            let path = path.with_offset((
                                position.x as f32 + x_offset,
                                position.y as f32 + y_offset,
                            ));
                            canvas.draw_path(&path, paint);
                        }
                    }
                };

                canvas.save();
                canvas.concat(&matrix);
                if run.paint_style.emboss || run.paint_style.engrave {
                    let offset = (run.paint_style.font_size as f32 / 20.0).max(1.0);
                    if run.paint_style.emboss {
                        draw_glyph_paths(&highlight_paint, -offset, -offset);
                        draw_glyph_paths(&shadow_paint, offset, offset);
                    } else {
                        draw_glyph_paths(&shadow_paint, -offset, -offset);
                        draw_glyph_paths(&highlight_paint, offset, offset);
                    }
                    draw_glyph_paths(&fill_paint, 0.0, 0.0);
                } else {
                    if run.paint_style.shadow_type > 0 {
                        draw_glyph_paths(
                            &shadow_paint,
                            run.paint_style.shadow_offset_x as f32,
                            run.paint_style.shadow_offset_y as f32,
                        );
                    }
                    if run.paint_style.outline_type > 0 {
                        draw_glyph_paths(&highlight_paint, 0.0, 0.0);
                        draw_glyph_paths(&stroke_paint, 0.0, 0.0);
                    } else {
                        draw_glyph_paths(&fill_paint, 0.0, 0.0);
                    }
                }
                canvas.restore();
            }
            PaintOp::CharOverlap { bbox, overlap } => {
                let mut run = crate::paint::LayerTextRunPaint {
                    source: overlap.source.clone(),
                    text: overlap.text.clone(),
                    style: overlap.style.clone(),
                    positions: overlap.positions.clone(),
                    baseline: overlap.baseline,
                    rotation: overlap.rotation,
                    is_vertical: overlap.is_vertical,
                    orientation: overlap.orientation,
                    char_overlap: Some(overlap.overlap.clone()),
                    ..Default::default()
                };
                run.projection = crate::paint::TextProjectionKind::SyntheticVisual;
                let rotation = run.rotation;
                if rotation != 0.0 {
                    let cx = (bbox.x + bbox.width / 2.0) as f32;
                    let cy = (bbox.y + bbox.height / 2.0) as f32;
                    canvas.save();
                    canvas.rotate(rotation as f32, Some((cx, cy).into()));
                    self.render_text_run(canvas, bbox, &run, replay);
                    canvas.restore();
                } else {
                    self.render_text_run(canvas, bbox, &run, replay);
                }
            }
            PaintOp::TextControlMark { bbox, mark } => {
                self.render_text_control_mark(canvas, bbox, &mark.mark, 0.0, replay);
            }
            PaintOp::TabLeader { bbox, leader } => {
                let run = crate::paint::LayerTextRunPaint {
                    text: String::new(),
                    style: crate::renderer::TextStyle {
                        color: leader.color,
                        font_size: leader.font_size,
                        tab_leaders: vec![leader.leader.clone()],
                        ..Default::default()
                    },
                    baseline: leader.baseline,
                    ..Default::default()
                };
                self.render_text_run(canvas, bbox, &run, replay);
            }
            PaintOp::TextDecoration { bbox, decoration } => {
                let rotation = decoration.rotation;
                if rotation != 0.0 {
                    let cx = (bbox.x + bbox.width / 2.0) as f32;
                    let cy = (bbox.y + bbox.height / 2.0) as f32;
                    canvas.save();
                    canvas.rotate(rotation as f32, Some((cx, cy).into()));
                    self.render_text_decoration(canvas, bbox, decoration);
                    canvas.restore();
                } else {
                    self.render_text_decoration(canvas, bbox, decoration);
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
                                replay.vector_antialias(),
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
                                replay.vector_antialias(),
                            );
                            x2 -= ux * arrow_w;
                            y2 -= uy * arrow_w;
                        }
                    }

                    let mut paint = make_line_paint(&line.style);
                    paint.set_anti_alias(replay.vector_antialias());
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
                    if let Some(mut fill) =
                        make_fill_paint(sk_rect, &rect.style, rect.gradient.as_deref())
                    {
                        fill.set_anti_alias(replay.vector_antialias());
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
                    if let Some(mut stroke) = make_stroke_paint(&rect.style) {
                        stroke.set_anti_alias(replay.vector_antialias());
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
                    if let Some(mut fill) =
                        make_fill_paint(oval, &ellipse.style, ellipse.gradient.as_deref())
                    {
                        fill.set_anti_alias(replay.vector_antialias());
                        canvas.draw_oval(oval, &fill);
                    }
                    if let Some(mut stroke) = make_stroke_paint(&ellipse.style) {
                        stroke.set_anti_alias(replay.vector_antialias());
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
                    if let Some(mut fill) =
                        make_fill_paint(path_bounds, &path.style, path.gradient.as_deref())
                    {
                        fill.set_anti_alias(replay.vector_antialias());
                        canvas.draw_path(&sk_path, &fill);
                    }
                    if let Some(mut stroke) = make_stroke_paint(&path.style) {
                        stroke.set_anti_alias(replay.vector_antialias());
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
                                replay.vector_antialias(),
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
                                replay.vector_antialias(),
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
                                let binary_effect_image = replay.binary_effect_image_for_resource(
                                    resource_id,
                                    &decoded,
                                    image.effect,
                                );
                                let (draw_image, effect, sampling) = if let Some(effect_image) =
                                    binary_effect_image.as_ref()
                                {
                                    (effect_image, ImageEffect::RealPic, ImageSampling::nearest())
                                } else {
                                    (&decoded, image.effect, replay.image_sampling())
                                };
                                let diagnostics = draw_decoded_image(
                                    canvas,
                                    draw_image,
                                    bbox.x as f32,
                                    bbox.y as f32,
                                    bbox.width as f32,
                                    bbox.height as f32,
                                    image.fill_mode,
                                    image.original_size,
                                    image.crop,
                                    effect,
                                    sampling,
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
            PaintOp::FormObject { bbox, form } => {
                form_replay::render_form_object(canvas, &self.font_mgr, bbox, form)
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
#[path = "renderer_tests.rs"]
mod tests;
