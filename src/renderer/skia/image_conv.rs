use resvg::{tiny_skia, usvg};
use skia_safe::{
    canvas::SrcRectConstraint, color_filters, image::RequiredProperties, Canvas, Data, FilterMode,
    IRect, Image, Matrix, MipmapMode, Paint, Rect, SamplingOptions, TileMode,
};

use crate::model::image::ImageEffect;
use crate::model::style::ImageFillMode;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ImageSampling {
    filter_mode: FilterMode,
    mipmap_mode: MipmapMode,
}

impl ImageSampling {
    pub fn nearest() -> Self {
        Self {
            filter_mode: FilterMode::Nearest,
            mipmap_mode: MipmapMode::None,
        }
    }

    pub fn linear() -> Self {
        Self {
            filter_mode: FilterMode::Linear,
            mipmap_mode: MipmapMode::None,
        }
    }

    pub fn linear_mipmap() -> Self {
        Self {
            filter_mode: FilterMode::Linear,
            mipmap_mode: MipmapMode::Linear,
        }
    }

    fn options(self) -> SamplingOptions {
        SamplingOptions::new(self.filter_mode, self.mipmap_mode)
    }
}

pub fn draw_image_bytes(
    canvas: &Canvas,
    bytes: &[u8],
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    fill_mode: Option<ImageFillMode>,
    original_size: Option<(f64, f64)>,
    crop: Option<(i32, i32, i32, i32)>,
    effect: ImageEffect,
    sampling: ImageSampling,
) {
    if !is_valid_destination_rect(x, y, width, height) {
        return;
    }
    let Some(image) = decode_image_bytes(bytes) else {
        draw_missing_image_placeholder(canvas, x, y, width, height);
        return;
    };
    draw_decoded_image(
        canvas,
        &image,
        x,
        y,
        width,
        height,
        fill_mode,
        original_size,
        crop,
        effect,
        sampling,
    );
}

pub fn draw_decoded_image(
    canvas: &Canvas,
    image: &Image,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    fill_mode: Option<ImageFillMode>,
    original_size: Option<(f64, f64)>,
    crop: Option<(i32, i32, i32, i32)>,
    effect: ImageEffect,
    sampling: ImageSampling,
) {
    if !is_valid_destination_rect(x, y, width, height) {
        return;
    }
    let dst = Rect::from_xywh(x, y, width, height);
    let mut paint = Paint::default();
    paint.set_anti_alias(true);
    if let Some(color_filter) = image_effect_filter(effect) {
        paint.set_color_filter(color_filter);
    }
    let mode = fill_mode.unwrap_or(ImageFillMode::FitToSize);
    let decoded_width = image.width() as f32;
    let decoded_height = image.height() as f32;
    let crop_src = crop.and_then(|(left, top, right, bottom)| {
        if decoded_width <= 0.0 || decoded_height <= 0.0 {
            return None;
        }
        let scale_x = right as f32 / decoded_width;
        let scale_y = bottom as f32 / decoded_height;
        if scale_x <= 0.0 || scale_y <= 0.0 {
            return None;
        }
        let src_x = left as f32 / scale_x;
        let src_y = top as f32 / scale_y;
        let src_w = (right - left) as f32 / scale_x;
        let src_h = (bottom - top) as f32 / scale_y;
        let is_cropped = src_x > 0.5
            || src_y > 0.5
            || (src_w - decoded_width).abs() > 1.0
            || (src_h - decoded_height).abs() > 1.0;
        if is_cropped && src_w > 0.0 && src_h > 0.0 {
            Some(Rect::from_xywh(src_x, src_y, src_w, src_h))
        } else {
            None
        }
    });

    let draw_image_rect = |canvas: &Canvas, src: Option<Rect>, dst: Rect| {
        if let Some(src) = src.as_ref() {
            canvas.draw_image_rect_with_sampling_options(
                image,
                Some((src, SrcRectConstraint::Strict)),
                dst,
                sampling.options(),
                &paint,
            );
        } else {
            canvas.draw_image_rect_with_sampling_options(
                image,
                None,
                dst,
                sampling.options(),
                &paint,
            );
        }
    };

    if matches!(mode, ImageFillMode::FitToSize | ImageFillMode::None) {
        if let Some(src) = crop_src {
            draw_image_rect(canvas, Some(src), dst);
            return;
        }

        draw_image_rect(canvas, None, dst);
        return;
    }

    let image_width = original_size
        .map(|(width, _)| width as f32)
        .unwrap_or_else(|| image.width() as f32);
    let image_height = original_size
        .map(|(_, height)| height as f32)
        .unwrap_or_else(|| image.height() as f32);
    if !image_width.is_finite()
        || !image_height.is_finite()
        || image_width <= 0.0
        || image_height <= 0.0
    {
        draw_missing_image_placeholder(canvas, x, y, width, height);
        return;
    }

    canvas.save();
    canvas.clip_rect(dst, None, Some(true));

    if matches!(
        mode,
        ImageFillMode::TileAll
            | ImageFillMode::TileHorzTop
            | ImageFillMode::TileHorzBottom
            | ImageFillMode::TileVertLeft
            | ImageFillMode::TileVertRight
    ) {
        let shader_image = crop_src
            .and_then(|src| {
                let left = src.left.floor().max(0.0) as i32;
                let top = src.top.floor().max(0.0) as i32;
                let right = src.right.ceil().min(decoded_width) as i32;
                let bottom = src.bottom.ceil().min(decoded_height) as i32;
                if right <= left || bottom <= top {
                    return None;
                }
                image.make_subset(
                    None,
                    IRect::from_xywh(left, top, right - left, bottom - top),
                    RequiredProperties::default(),
                )
            })
            .unwrap_or_else(|| image.clone());
        let shader_source_width = shader_image.width() as f32;
        let shader_source_height = shader_image.height() as f32;
        let draw_tiled_shader = |tile_rect: Rect, origin_x: f32, origin_y: f32| -> bool {
            if shader_source_width <= 0.0 || shader_source_height <= 0.0 {
                return false;
            }
            let scale_x = shader_source_width / image_width;
            let scale_y = shader_source_height / image_height;
            if !scale_x.is_finite() || !scale_y.is_finite() || scale_x <= 0.0 || scale_y <= 0.0 {
                return false;
            }
            let local_matrix = Matrix::scale_translate(
                (scale_x, scale_y),
                (-origin_x * scale_x, -origin_y * scale_y),
            );
            let Some(shader) = shader_image.to_shader(
                Some((TileMode::Repeat, TileMode::Repeat)),
                sampling.options(),
                Some(&local_matrix),
            ) else {
                return false;
            };
            let mut shader_paint = paint.clone();
            shader_paint.set_shader(shader);
            canvas.draw_rect(tile_rect, &shader_paint);
            true
        };

        if matches!(mode, ImageFillMode::TileAll) && draw_tiled_shader(dst, x, y) {
            canvas.restore();
            return;
        }
        if matches!(
            mode,
            ImageFillMode::TileHorzTop | ImageFillMode::TileHorzBottom
        ) {
            let tile_y = if matches!(mode, ImageFillMode::TileHorzTop) {
                y
            } else {
                y + height - image_height
            };
            if draw_tiled_shader(Rect::from_xywh(x, tile_y, width, image_height), x, tile_y) {
                canvas.restore();
                return;
            }
        }
        if matches!(
            mode,
            ImageFillMode::TileVertLeft | ImageFillMode::TileVertRight
        ) {
            let tile_x = if matches!(mode, ImageFillMode::TileVertLeft) {
                x
            } else {
                x + width - image_width
            };
            if draw_tiled_shader(Rect::from_xywh(tile_x, y, image_width, height), tile_x, y) {
                canvas.restore();
                return;
            }
        }

        const MAX_TILE_DRAWS: usize = 4096;
        let mut tile_draws = 0usize;
        if matches!(mode, ImageFillMode::TileAll) {
            let mut tile_y = y;
            while tile_y < y + height && tile_draws < MAX_TILE_DRAWS {
                let mut tile_x = x;
                while tile_x < x + width && tile_draws < MAX_TILE_DRAWS {
                    draw_image_rect(
                        canvas,
                        crop_src,
                        Rect::from_xywh(tile_x, tile_y, image_width, image_height),
                    );
                    tile_draws += 1;
                    tile_x += image_width.max(1.0);
                }
                tile_y += image_height.max(1.0);
            }
        } else if matches!(
            mode,
            ImageFillMode::TileHorzTop | ImageFillMode::TileHorzBottom
        ) {
            let tile_y = if matches!(mode, ImageFillMode::TileHorzTop) {
                y
            } else {
                y + height - image_height
            };
            let mut tile_x = x;
            while tile_x < x + width && tile_draws < MAX_TILE_DRAWS {
                draw_image_rect(
                    canvas,
                    crop_src,
                    Rect::from_xywh(tile_x, tile_y, image_width, image_height),
                );
                tile_draws += 1;
                tile_x += image_width.max(1.0);
            }
        } else {
            let tile_x = if matches!(mode, ImageFillMode::TileVertLeft) {
                x
            } else {
                x + width - image_width
            };
            let mut tile_y = y;
            while tile_y < y + height && tile_draws < MAX_TILE_DRAWS {
                draw_image_rect(
                    canvas,
                    crop_src,
                    Rect::from_xywh(tile_x, tile_y, image_width, image_height),
                );
                tile_draws += 1;
                tile_y += image_height.max(1.0);
            }
        }
    } else {
        let (image_x, image_y) =
            resolve_image_placement(mode, x, y, width, height, image_width, image_height);
        draw_image_rect(
            canvas,
            crop_src,
            Rect::from_xywh(image_x, image_y, image_width, image_height),
        );
    }

    canvas.restore();
}

fn is_valid_destination_rect(x: f32, y: f32, width: f32, height: f32) -> bool {
    x.is_finite()
        && y.is_finite()
        && width.is_finite()
        && height.is_finite()
        && width > 0.0
        && height > 0.0
}

fn image_effect_filter(effect: ImageEffect) -> Option<skia_safe::ColorFilter> {
    match effect {
        ImageEffect::RealPic => None,
        ImageEffect::GrayScale => Some(grayscale_filter(1.0, 0.0)),
        ImageEffect::BlackWhite => Some(grayscale_filter(255.0, -127.5)),
        ImageEffect::Pattern8x8 => Some(grayscale_filter(1.0, 0.0)),
    }
}

fn grayscale_filter(scale: f32, translate: f32) -> skia_safe::ColorFilter {
    let r = 0.299 * scale;
    let g = 0.587 * scale;
    let b = 0.114 * scale;
    color_filters::matrix_row_major(
        &[
            r, g, b, 0.0, translate, r, g, b, 0.0, translate, r, g, b, 0.0, translate, 0.0, 0.0,
            0.0, 1.0, 0.0,
        ],
        None,
    )
}

pub fn draw_svg_fragment(
    canvas: &Canvas,
    svg_fragment: &str,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    sampling: ImageSampling,
) -> bool {
    let Some(image) = rasterize_svg_fragment(svg_fragment, width, height) else {
        return false;
    };

    draw_decoded_image(
        canvas,
        &image,
        x,
        y,
        width,
        height,
        Some(ImageFillMode::FitToSize),
        None,
        None,
        ImageEffect::RealPic,
        sampling,
    );
    true
}

fn resolve_image_placement(
    fill_mode: ImageFillMode,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    image_width: f32,
    image_height: f32,
) -> (f32, f32) {
    match fill_mode {
        ImageFillMode::LeftTop => (x, y),
        ImageFillMode::CenterTop => (x + (width - image_width) / 2.0, y),
        ImageFillMode::RightTop => (x + width - image_width, y),
        ImageFillMode::LeftCenter => (x, y + (height - image_height) / 2.0),
        ImageFillMode::Center => (
            x + (width - image_width) / 2.0,
            y + (height - image_height) / 2.0,
        ),
        ImageFillMode::RightCenter => (x + width - image_width, y + (height - image_height) / 2.0),
        ImageFillMode::LeftBottom => (x, y + height - image_height),
        ImageFillMode::CenterBottom => (x + (width - image_width) / 2.0, y + height - image_height),
        ImageFillMode::RightBottom => (x + width - image_width, y + height - image_height),
        _ => (x, y),
    }
}

pub fn decode_image_bytes(bytes: &[u8]) -> Option<Image> {
    match detect_image_mime_type(bytes) {
        "image/x-wmf" => {
            let svg = crate::renderer::svg::convert_wmf_to_svg(bytes)?;
            let mut options = usvg::Options::default();
            options.fontdb_mut().load_system_fonts();
            let tree = usvg::Tree::from_data(&svg, &options).ok()?;
            let size = tree.size().to_int_size();
            let mut pixmap = tiny_skia::Pixmap::new(size.width(), size.height())?;
            resvg::render(&tree, tiny_skia::Transform::default(), &mut pixmap.as_mut());
            let png = pixmap.encode_png().ok()?;
            Image::from_encoded(Data::new_copy(&png))
        }
        _ => Image::from_encoded(Data::new_copy(bytes)),
    }
}

pub fn rasterize_svg_fragment(svg_fragment: &str, width: f32, height: f32) -> Option<Image> {
    if width <= 0.0 || height <= 0.0 {
        return None;
    }

    let svg = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{width:.2}\" height=\"{height:.2}\" viewBox=\"0 0 {width:.2} {height:.2}\">{svg_fragment}</svg>"
    );
    let mut options = usvg::Options::default();
    let fontdb = options.fontdb_mut();
    fontdb.load_system_fonts();
    fontdb.set_sans_serif_family("Noto Sans CJK KR");
    fontdb.set_serif_family("Noto Serif CJK KR");
    fontdb.set_monospace_family("D2Coding");

    let tree = usvg::Tree::from_str(&svg, &options).ok()?;
    let size = tree.size().to_int_size();
    let mut pixmap = tiny_skia::Pixmap::new(size.width(), size.height())?;
    resvg::render(&tree, tiny_skia::Transform::default(), &mut pixmap.as_mut());
    let png = pixmap.encode_png().ok()?;
    Image::from_encoded(Data::new_copy(&png))
}

pub(crate) fn draw_missing_image_placeholder(
    canvas: &Canvas,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
) {
    let rect = Rect::from_xywh(x, y, width, height);

    let mut fill = Paint::default();
    fill.set_anti_alias(true);
    fill.set_style(skia_safe::paint::Style::Fill);
    fill.set_color(skia_safe::Color::from_argb(0xFF, 0xCC, 0xCC, 0xCC));
    canvas.draw_rect(rect, &fill);

    let mut stroke = Paint::default();
    stroke.set_anti_alias(true);
    stroke.set_style(skia_safe::paint::Style::Stroke);
    stroke.set_stroke_width(1.0);
    stroke.set_color(skia_safe::Color::from_argb(0xFF, 0x99, 0x99, 0x99));
    if let Some(effect) = skia_safe::PathEffect::dash(&[4.0, 4.0], 0.0) {
        stroke.set_path_effect(effect);
    }
    canvas.draw_rect(rect, &stroke);
}

fn detect_image_mime_type(data: &[u8]) -> &'static str {
    if data.len() >= 8 {
        if data.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
            return "image/png";
        }
        if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
            return "image/jpeg";
        }
        if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
            return "image/gif";
        }
        if data.starts_with(&[0x42, 0x4D]) {
            return "image/bmp";
        }
        if data.starts_with(&[0xD7, 0xCD, 0xC6, 0x9A])
            || data.starts_with(&[0x01, 0x00, 0x09, 0x00])
        {
            return "image/x-wmf";
        }
        if data.starts_with(&[0x49, 0x49, 0x2A, 0x00])
            || data.starts_with(&[0x4D, 0x4D, 0x00, 0x2A])
        {
            return "image/tiff";
        }
    }

    "application/octet-stream"
}

#[cfg(test)]
mod tests {
    use super::*;
    use skia_safe::{surfaces, Color, EncodedImageFormat};

    fn red_top_blue_bottom_png() -> Vec<u8> {
        let mut source = tiny_skia::Pixmap::new(2, 2).expect("source pixmap");
        source.pixels_mut()[0] =
            tiny_skia::PremultipliedColorU8::from_rgba(255, 0, 0, 255).unwrap();
        source.pixels_mut()[1] =
            tiny_skia::PremultipliedColorU8::from_rgba(255, 0, 0, 255).unwrap();
        source.pixels_mut()[2] =
            tiny_skia::PremultipliedColorU8::from_rgba(0, 0, 255, 255).unwrap();
        source.pixels_mut()[3] =
            tiny_skia::PremultipliedColorU8::from_rgba(0, 0, 255, 255).unwrap();
        source.encode_png().expect("source png")
    }

    fn render_cropped_bottom_row(fill_mode: ImageFillMode) -> tiny_skia::Pixmap {
        let mut surface = surfaces::raster_n32_premul((4, 4)).expect("surface");
        surface.canvas().clear(Color::TRANSPARENT);
        draw_image_bytes(
            surface.canvas(),
            &red_top_blue_bottom_png(),
            0.0,
            0.0,
            4.0,
            4.0,
            Some(fill_mode),
            Some((4.0, 4.0)),
            Some((0, 1, 2, 2)),
            ImageEffect::RealPic,
            ImageSampling::nearest(),
        );
        let rendered = surface
            .image_snapshot()
            .encode(None, EncodedImageFormat::PNG, None)
            .expect("render png");
        tiny_skia::Pixmap::decode_png(rendered.as_bytes()).expect("decode render")
    }

    #[test]
    fn applies_crop_source_rect_to_aligned_fill_modes() {
        let pixmap = render_cropped_bottom_row(ImageFillMode::Center);

        for pixel in pixmap.pixels() {
            assert!(pixel.blue() > pixel.red());
        }
    }

    #[test]
    fn applies_crop_source_rect_to_tiled_fill_modes() {
        let pixmap = render_cropped_bottom_row(ImageFillMode::TileAll);

        for pixel in pixmap.pixels() {
            assert!(pixel.blue() > pixel.red());
        }
    }

    #[test]
    fn tiled_fill_covers_large_area_beyond_draw_cap() {
        let mut source = tiny_skia::Pixmap::new(1, 1).expect("source pixmap");
        source.pixels_mut()[0] =
            tiny_skia::PremultipliedColorU8::from_rgba(0, 255, 0, 255).unwrap();
        let png = source.encode_png().expect("source png");

        let mut surface = surfaces::raster_n32_premul((128, 128)).expect("surface");
        surface.canvas().clear(Color::TRANSPARENT);
        draw_image_bytes(
            surface.canvas(),
            &png,
            0.0,
            0.0,
            128.0,
            128.0,
            Some(ImageFillMode::TileAll),
            Some((1.0, 1.0)),
            None,
            ImageEffect::RealPic,
            ImageSampling::nearest(),
        );
        let rendered = surface
            .image_snapshot()
            .encode(None, EncodedImageFormat::PNG, None)
            .expect("render png");
        let pixmap = tiny_skia::Pixmap::decode_png(rendered.as_bytes()).expect("decode render");
        let bottom_right = pixmap.pixels()[127 * 128 + 127];

        assert!(
            bottom_right.green() > 200 && bottom_right.alpha() == 255,
            "shader tile replay should cover pixels beyond the old capped loop area"
        );
    }

    #[test]
    fn ignores_invalid_destination_rects() {
        let mut surface = surfaces::raster_n32_premul((4, 4)).expect("surface");
        surface.canvas().clear(Color::TRANSPARENT);
        draw_image_bytes(
            surface.canvas(),
            &red_top_blue_bottom_png(),
            f32::NAN,
            0.0,
            4.0,
            4.0,
            Some(ImageFillMode::TileAll),
            Some((4.0, 4.0)),
            None,
            ImageEffect::RealPic,
            ImageSampling::nearest(),
        );
        let rendered = surface
            .image_snapshot()
            .encode(None, EncodedImageFormat::PNG, None)
            .expect("render png");
        let pixmap = tiny_skia::Pixmap::decode_png(rendered.as_bytes()).expect("decode render");

        for pixel in pixmap.pixels() {
            assert_eq!(pixel.alpha(), 0);
        }
    }
}
