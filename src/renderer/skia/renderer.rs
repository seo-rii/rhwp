use skia_safe::{
    surfaces, Canvas, Color, EncodedImageFormat, FontMgr, Paint, PathBuilder, Point, Rect,
};

use crate::paint::{
    CacheHint, LayerFormObjectPaint, LayerNode, LayerNodeKind, LayerTextRunPaint, PageLayerTree,
    PaintOp, RenderProfile, ResourceArena,
};
use crate::renderer::composer::{decode_pua_overlap_number, pua_to_display_text};
use crate::renderer::layer_renderer::{LayerRasterRenderer, RasterRenderOptions};
use crate::renderer::layout::split_into_clusters;
use crate::renderer::render_tree::BoundingBox;
use crate::renderer::{ArrowStyle, LineRenderType, LineStyle, UnderlineType};

use super::equation_conv::render_equation;
use super::image_conv::{
    draw_image_bytes, draw_missing_image_placeholder, draw_svg_fragment, ImageSampling,
};
use super::paint_conv::{
    colorref_to_skia, make_background_fill_paint, make_fill_paint, make_font, make_line_paint,
    make_stroke_paint, make_text_paint,
};
use super::path_conv::to_skia_path;

pub struct SkiaLayerRenderer {
    font_mgr: FontMgr,
}

const MAX_RASTER_DIMENSION: i32 = 16_384;

fn raster_dimension(length: f64, max_dimension: i32) -> Result<i32, String> {
    if !length.is_finite() {
        return Err(format!("non-finite raster dimension: {length}"));
    }
    if length <= 0.0 {
        return Err(format!("non-positive raster dimension: {length}"));
    }
    let rounded = length.round();
    if max_dimension <= 0 {
        return Err(format!(
            "non-positive max raster dimension: {max_dimension}"
        ));
    }
    if rounded > f64::from(max_dimension) {
        return Err(format!(
            "raster dimension {rounded} exceeds max {max_dimension}"
        ));
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

struct SkiaReplayContext {
    profile: RenderProfile,
    cache_hints: Vec<CacheHint>,
}

impl SkiaReplayContext {
    fn new(profile: RenderProfile) -> Self {
        Self {
            profile,
            cache_hints: Vec::new(),
        }
    }

    fn push_cache_hint(&mut self, cache_hint: CacheHint) {
        self.cache_hints.push(cache_hint);
    }

    fn pop_cache_hint(&mut self) {
        self.cache_hints.pop();
    }

    fn has_cache_hint(&self, cache_hint: CacheHint) -> bool {
        self.cache_hints.contains(&cache_hint)
    }

    fn image_sampling(&self) -> ImageSampling {
        if self.profile == RenderProfile::FastPreview
            || self.has_cache_hint(CacheHint::PreferRaster)
        {
            return ImageSampling::nearest();
        }
        if matches!(
            self.profile,
            RenderProfile::Print | RenderProfile::HighQuality
        ) || self.has_cache_hint(CacheHint::PreferVectorRecording)
        {
            return ImageSampling::linear_mipmap();
        }
        ImageSampling::linear()
    }

    fn clip_antialias(&self) -> bool {
        self.profile != RenderProfile::FastPreview || !self.has_cache_hint(CacheHint::PreferRaster)
    }
}

impl SkiaLayerRenderer {
    pub fn new() -> Self {
        Self {
            font_mgr: FontMgr::default(),
        }
    }

    pub fn render_png(&self, tree: &PageLayerTree) -> Result<Vec<u8>, String> {
        self.render_png_with_options(tree, RasterRenderOptions::default())
    }

    pub fn render_png_with_options(
        &self,
        tree: &PageLayerTree,
        options: RasterRenderOptions,
    ) -> Result<Vec<u8>, String> {
        let width = raster_dimension(tree.page_width, options.max_dimension)?;
        let height = raster_dimension(tree.page_height, options.max_dimension)?;
        let mut surface = surfaces::raster_n32_premul((width, height))
            .ok_or_else(|| "Skia raster surface 생성 실패".to_string())?;
        let canvas = surface.canvas();
        let clear_color = if let Some(color) = options.background_color {
            colorref_to_skia(color, 1.0)
        } else if options.transparent {
            Color::from_argb(0, 0, 0, 0)
        } else {
            Color::WHITE
        };
        canvas.clear(clear_color);
        let mut replay = SkiaReplayContext::new(tree.profile);
        self.render_node(canvas, &tree.root, &tree.resources, &mut replay);
        let image = surface.image_snapshot();
        let data = image
            .encode(None, EncodedImageFormat::PNG, None)
            .ok_or_else(|| "Skia PNG 인코딩 실패".to_string())?;
        Ok(data.as_bytes().to_vec())
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
                replay.push_cache_hint(*cache_hint);
                for child in children {
                    self.render_node(canvas, child, resources, replay);
                }
                replay.pop_cache_hint();
            }
            LayerNodeKind::ClipRect { clip, child, .. } => {
                canvas.save();
                canvas.clip_rect(
                    Rect::from_xywh(
                        clip.x as f32,
                        clip.y as f32,
                        clip.width as f32,
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
        replay: &SkiaReplayContext,
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
                        draw_image_bytes(
                            canvas,
                            bytes,
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
                let rotation = if run.is_vertical {
                    run.rotation + 90.0
                } else {
                    run.rotation
                };
                if rotation != 0.0 {
                    let cx = (bbox.x + bbox.width / 2.0) as f32;
                    let cy = (bbox.y + bbox.height / 2.0) as f32;
                    canvas.save();
                    canvas.rotate(rotation as f32, Some((cx, cy).into()));
                    self.render_text_run(canvas, bbox, run);
                    canvas.restore();
                } else {
                    self.render_text_run(canvas, bbox, run);
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
                            draw_image_bytes(
                                canvas,
                                data,
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
                    rendered = draw_svg_fragment(
                        canvas,
                        svg_fragment,
                        bbox.x as f32,
                        bbox.y as f32,
                        bbox.width as f32,
                        bbox.height as f32,
                        replay.image_sampling(),
                    );
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

    fn render_text_run(&self, canvas: &Canvas, bbox: &BoundingBox, run: &LayerTextRunPaint) {
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

        let paint = make_text_paint(&render_style);
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

        let draw_pass = |canvas: &Canvas,
                         x_offset: f32,
                         y_offset: f32,
                         fill_color: u32,
                         stroke_color: Option<u32>,
                         stroke_width: f32| {
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

            for (char_idx, cluster) in &clusters {
                if cluster == " " || cluster == "\t" || cluster == "\u{2007}" {
                    continue;
                }
                let x = bbox.x as f32 + char_positions[*char_idx] as f32 + x_offset;
                let pass_y = y + y_offset;
                let is_symbol_cluster = cluster.chars().count() == 1
                    && cluster.chars().all(|ch| {
                        matches!(
                            ch,
                            '\u{00AD}'
                                | '\u{203B}'
                                | '\u{2460}'..='\u{24FF}'
                                | '\u{2500}'..='\u{27BF}'
                        )
                    });
                if is_symbol_cluster {
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
                    draw_svg_fragment(
                        canvas,
                        &svg_fragment,
                        x,
                        pass_y - render_style.font_size as f32,
                        cluster_width,
                        render_style.font_size as f32 * 1.4,
                        ImageSampling::linear(),
                    );
                    continue;
                }
                let font = make_font(&render_style, &self.font_mgr, cluster);
                let glyphs = font.text_to_glyphs_vec(cluster);
                let mut glyph_positions = vec![Point::default(); glyphs.len()];
                font.get_pos(&glyphs, &mut glyph_positions, Some(Point::new(x, pass_y)));
                for (glyph_id, glyph_position) in glyphs.into_iter().zip(glyph_positions) {
                    if let Some(path) = font.get_path(glyph_id) {
                        let path = path.with_offset((glyph_position.x, glyph_position.y));
                        canvas.draw_path(&path, &fill_paint);
                        if stroke_color.is_some() {
                            canvas.draw_path(&path, &stroke_paint);
                        }
                    }
                }
            }
        };

        if run.style.emboss || run.style.engrave {
            let offset = (render_style.font_size as f32 / 20.0).max(1.0);
            let (first_color, second_color) = if run.style.emboss {
                (0x00FF_FFFF, 0x0080_8080)
            } else {
                (0x0080_8080, 0x00FF_FFFF)
            };
            draw_pass(canvas, -offset, -offset, first_color, None, 0.0);
            draw_pass(canvas, offset, offset, second_color, None, 0.0);
            draw_pass(canvas, 0.0, 0.0, run.style.color, None, 0.0);
        } else {
            if run.style.shadow_type > 0 {
                draw_pass(
                    canvas,
                    run.style.shadow_offset_x as f32,
                    run.style.shadow_offset_y as f32,
                    run.style.shadow_color,
                    None,
                    0.0,
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
                );
            } else {
                for (char_idx, cluster) in &clusters {
                    if cluster == " " || cluster == "\t" {
                        continue;
                    }
                    let font = make_font(&render_style, &self.font_mgr, cluster);
                    let x = bbox.x + char_positions[*char_idx];
                    let glyphs = font.text_to_glyphs_vec(cluster);
                    let mut glyph_positions = vec![Point::default(); glyphs.len()];
                    font.get_pos(&glyphs, &mut glyph_positions, Some(Point::new(x as f32, y)));
                    for (glyph_id, glyph_position) in glyphs.into_iter().zip(glyph_positions) {
                        if let Some(path) = font.get_path(glyph_id) {
                            let path = path.with_offset((glyph_position.x, glyph_position.y));
                            canvas.draw_path(&path, &paint);
                        }
                    }
                }
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
    fn render_png_with_options(
        &self,
        tree: &PageLayerTree,
        options: RasterRenderOptions,
    ) -> Result<Vec<u8>, String> {
        SkiaLayerRenderer::render_png_with_options(self, tree, options)
    }
}

#[cfg(test)]
mod tests {
    use super::{raster_dimension, ImageSampling, SkiaLayerRenderer, SkiaReplayContext};
    use crate::paint::{CacheHint, LayerBuilder, RenderProfile};
    use crate::renderer::composer::CharOverlapInfo;
    use crate::renderer::render_tree::{
        BoundingBox, PageNode, RectangleNode, RenderNode, RenderNodeType, TextRunNode,
    };
    use crate::renderer::{ShapeStyle, TextStyle};
    use resvg::tiny_skia;

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
        assert!(raster_dimension(f64::NAN, 16_384).is_err());
        assert!(raster_dimension(0.0, 16_384).is_err());
        assert!(raster_dimension(16_385.0, 16_384).is_err());
        assert_eq!(raster_dimension(12.4, 16_384), Ok(12));
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
    fn consumes_profile_and_cache_hints_for_sampling_policy() {
        let screen = SkiaReplayContext::new(RenderProfile::Screen);
        assert_eq!(screen.image_sampling(), ImageSampling::linear());
        assert!(screen.clip_antialias());

        let fast_preview = SkiaReplayContext::new(RenderProfile::FastPreview);
        assert_eq!(fast_preview.image_sampling(), ImageSampling::nearest());
        assert!(fast_preview.clip_antialias());

        let print = SkiaReplayContext::new(RenderProfile::Print);
        assert_eq!(print.image_sampling(), ImageSampling::linear_mipmap());

        let mut raster = SkiaReplayContext::new(RenderProfile::HighQuality);
        raster.push_cache_hint(CacheHint::PreferRaster);
        assert_eq!(raster.image_sampling(), ImageSampling::nearest());
        assert!(raster.clip_antialias());

        let mut vector = SkiaReplayContext::new(RenderProfile::Screen);
        vector.push_cache_hint(CacheHint::PreferVectorRecording);
        assert_eq!(vector.image_sampling(), ImageSampling::linear_mipmap());
    }
}
