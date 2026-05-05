use skia_safe::{
    paint::Cap, surfaces, Canvas, Color, EncodedImageFormat, FontMgr, Paint, PathBuilder,
    PictureRecorder, Point, Rect, Shaper,
};
use std::cell::RefCell;

use crate::model::image::ImageEffect;
use crate::paint::{
    CacheHint, LayerFormObjectPaint, LayerNode, LayerNodeKind, LayerTextRunPaint, PageLayerTree,
    PaintOp, ResourceArena,
};
use crate::renderer::composer::{decode_pua_overlap_number, pua_to_display_text};
use crate::renderer::layer_renderer::{
    LayerRasterRenderer, LayerRenderError, LayerRenderResult, RasterOutputFormat,
    RasterRenderOptions, RasterRenderOutput,
};
use crate::renderer::layout::split_into_clusters;
use crate::renderer::render_tree::BoundingBox;
use crate::renderer::{ArrowStyle, LineRenderType, UnderlineType};

use super::cache::StaticPictureCache;
use super::cache_key::StaticSubtreeCacheKey;
use super::equation_conv::render_equation;
use super::image_conv::{draw_decoded_image, draw_missing_image_placeholder, ImageSampling};
use super::paint_conv::{
    colorref_to_skia, make_background_fill_paint, make_fill_paint, make_font, make_line_paint,
    make_stroke_paint,
};
use super::path_conv::to_skia_path;
use super::replay_context::SkiaReplayContext;

pub struct SkiaLayerRenderer {
    font_mgr: FontMgr,
    text_shaper: Shaper,
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
        configure_replay(&mut replay);
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
                    if let Some((picture, approx_bytes)) = {
                        let mut cache = self.static_picture_cache.borrow_mut();
                        cache
                            .get(cache_key)
                            .map(|picture| (picture, cache.approx_bytes()))
                    } {
                        replay.diagnostics.static_picture_cache_hits = replay
                            .diagnostics
                            .static_picture_cache_hits
                            .saturating_add(1);
                        replay.diagnostics.static_picture_cache_approx_bytes = approx_bytes;
                        canvas.draw_picture(&picture, None, None);
                        return;
                    }
                    replay.diagnostics.static_picture_cache_misses = replay
                        .diagnostics
                        .static_picture_cache_misses
                        .saturating_add(1);

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
                        let (evictions, cache_bytes) = {
                            let mut cache = self.static_picture_cache.borrow_mut();
                            let evictions = cache.insert(cache_key, picture, approx_bytes);
                            (evictions, cache.approx_bytes())
                        };
                        replay.diagnostics.static_picture_cache_evictions = replay
                            .diagnostics
                            .static_picture_cache_evictions
                            .saturating_add(evictions);
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
#[path = "renderer_tests.rs"]
mod tests;
