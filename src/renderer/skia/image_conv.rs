use resvg::{tiny_skia, usvg};
use skia_safe::{
    canvas::SrcRectConstraint, color_filters, image::RequiredProperties, Canvas, Data,
    EncodedImageFormat, FilterMode, IRect, Image, Matrix, MipmapMode, Paint, Rect, SamplingOptions,
    TileMode,
};

use crate::model::image::ImageEffect;
use crate::model::style::ImageFillMode;
use crate::renderer::font_paths;

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

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ImageDrawDiagnostics {
    pub tile_fallback_cap_hits: usize,
    pub image_effect_preprocess_failures: usize,
    pub image_effect_fallback_to_filter: usize,
    pub image_effect_preprocessed_bytes: usize,
}

const ORDERED_DITHER_8X8: [u8; 64] = [
    0, 48, 12, 60, 3, 51, 15, 63, 32, 16, 44, 28, 35, 19, 47, 31, 8, 56, 4, 52, 11, 59, 7, 55, 40,
    24, 36, 20, 43, 27, 39, 23, 2, 50, 14, 62, 1, 49, 13, 61, 34, 18, 46, 30, 33, 17, 45, 29, 10,
    58, 6, 54, 9, 57, 5, 53, 42, 26, 38, 22, 41, 25, 37, 21,
];

#[cfg(test)]
thread_local! {
    static FORCE_MANUAL_TILE_FALLBACK: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
pub(crate) fn with_manual_tile_fallback_for_test<T>(draw: impl FnOnce() -> T) -> T {
    FORCE_MANUAL_TILE_FALLBACK.with(|flag| {
        let previous = flag.replace(true);
        let result = draw();
        flag.set(previous);
        result
    })
}

#[cfg(test)]
fn manual_tile_fallback_forced_for_test() -> bool {
    FORCE_MANUAL_TILE_FALLBACK.with(std::cell::Cell::get)
}

#[cfg(not(test))]
fn manual_tile_fallback_forced_for_test() -> bool {
    false
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
    brightness: i8,
    contrast: i8,
    sampling: ImageSampling,
) -> ImageDrawDiagnostics {
    if !is_valid_destination_rect(x, y, width, height) {
        return ImageDrawDiagnostics::default();
    }
    let Some(image) = decode_image_bytes(bytes) else {
        draw_missing_image_placeholder(canvas, x, y, width, height);
        return ImageDrawDiagnostics::default();
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
        brightness,
        contrast,
        sampling,
    )
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
    brightness: i8,
    contrast: i8,
    sampling: ImageSampling,
) -> ImageDrawDiagnostics {
    draw_decoded_image_impl(
        canvas,
        image,
        x,
        y,
        width,
        height,
        fill_mode,
        original_size,
        crop,
        effect,
        brightness,
        contrast,
        sampling,
        true,
    )
}

pub(crate) fn image_approx_rgba_bytes(image: &Image) -> usize {
    let width = usize::try_from(image.width().max(0)).unwrap_or(0);
    let height = usize::try_from(image.height().max(0)).unwrap_or(0);
    width.saturating_mul(height).saturating_mul(4)
}

fn draw_decoded_image_impl(
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
    brightness: i8,
    contrast: i8,
    sampling: ImageSampling,
    allow_shader_tiling: bool,
) -> ImageDrawDiagnostics {
    let mut diagnostics = ImageDrawDiagnostics::default();
    if !is_valid_destination_rect(x, y, width, height) {
        return diagnostics;
    }
    let effect_needs_preprocessing =
        matches!(effect, ImageEffect::BlackWhite | ImageEffect::Pattern8x8);
    let preprocessed_image = preprocess_binary_image_effect(image, effect);
    if effect_needs_preprocessing && preprocessed_image.is_none() {
        diagnostics.image_effect_preprocess_failures = diagnostics
            .image_effect_preprocess_failures
            .saturating_add(1);
        diagnostics.image_effect_fallback_to_filter = diagnostics
            .image_effect_fallback_to_filter
            .saturating_add(1);
    }
    if let Some(preprocessed_image) = preprocessed_image.as_ref() {
        diagnostics.image_effect_preprocessed_bytes = diagnostics
            .image_effect_preprocessed_bytes
            .saturating_add(image_approx_rgba_bytes(preprocessed_image));
    }
    let image = preprocessed_image.as_ref().unwrap_or(image);
    let filter_effect = if preprocessed_image.is_some() {
        ImageEffect::RealPic
    } else {
        effect
    };
    let sampling = if preprocessed_image.is_some()
        && matches!(effect, ImageEffect::BlackWhite | ImageEffect::Pattern8x8)
    {
        ImageSampling::nearest()
    } else {
        sampling
    };
    let dst = Rect::from_xywh(x, y, width, height);
    let mut paint = Paint::default();
    paint.set_anti_alias(true);
    if let Some(color_filter) = image_effect_filter(filter_effect, brightness, contrast) {
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

    if matches!(
        mode,
        ImageFillMode::FitToSize | ImageFillMode::Total | ImageFillMode::None
    ) {
        if let Some(src) = crop_src {
            draw_image_rect(canvas, Some(src), dst);
            return diagnostics;
        }

        draw_image_rect(canvas, None, dst);
        return diagnostics;
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
        return diagnostics;
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

        if allow_shader_tiling
            && !manual_tile_fallback_forced_for_test()
            && matches!(mode, ImageFillMode::TileAll)
            && draw_tiled_shader(dst, x, y)
        {
            canvas.restore();
            return diagnostics;
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
            if allow_shader_tiling
                && !manual_tile_fallback_forced_for_test()
                && draw_tiled_shader(Rect::from_xywh(x, tile_y, width, image_height), x, tile_y)
            {
                canvas.restore();
                return diagnostics;
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
            if allow_shader_tiling
                && !manual_tile_fallback_forced_for_test()
                && draw_tiled_shader(Rect::from_xywh(tile_x, y, image_width, height), tile_x, y)
            {
                canvas.restore();
                return diagnostics;
            }
        }

        const MAX_TILE_DRAWS: usize = 4096;
        let mut tile_draws = 0usize;
        let mut cap_hit = false;
        if matches!(mode, ImageFillMode::TileAll) {
            let mut tile_y = y;
            while tile_y < y + height {
                if tile_draws >= MAX_TILE_DRAWS {
                    cap_hit = true;
                    break;
                }
                let mut tile_x = x;
                while tile_x < x + width {
                    if tile_draws >= MAX_TILE_DRAWS {
                        cap_hit = true;
                        break;
                    }
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
            while tile_x < x + width {
                if tile_draws >= MAX_TILE_DRAWS {
                    cap_hit = true;
                    break;
                }
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
            while tile_y < y + height {
                if tile_draws >= MAX_TILE_DRAWS {
                    cap_hit = true;
                    break;
                }
                draw_image_rect(
                    canvas,
                    crop_src,
                    Rect::from_xywh(tile_x, tile_y, image_width, image_height),
                );
                tile_draws += 1;
                tile_y += image_height.max(1.0);
            }
        }
        if cap_hit {
            diagnostics.tile_fallback_cap_hits =
                diagnostics.tile_fallback_cap_hits.saturating_add(1);
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
    diagnostics
}

#[cfg(test)]
fn draw_decoded_image_without_shader_for_test(
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
) -> ImageDrawDiagnostics {
    draw_decoded_image_impl(
        canvas,
        image,
        x,
        y,
        width,
        height,
        fill_mode,
        original_size,
        crop,
        effect,
        0,
        0,
        sampling,
        false,
    )
}

fn is_valid_destination_rect(x: f32, y: f32, width: f32, height: f32) -> bool {
    x.is_finite()
        && y.is_finite()
        && width.is_finite()
        && height.is_finite()
        && width > 0.0
        && height > 0.0
}

fn image_effect_filter(
    effect: ImageEffect,
    brightness: i8,
    contrast: i8,
) -> Option<skia_safe::ColorFilter> {
    if matches!(effect, ImageEffect::RealPic) && brightness == 0 && contrast == 0 {
        return None;
    }
    let brightness_scale = (100.0 + brightness as f32) / 100.0;
    let contrast_scale = (100.0 + contrast as f32) / 100.0;
    match effect {
        ImageEffect::RealPic => Some(grayscale_filter_with_tone(
            1.0,
            0.0,
            brightness_scale,
            contrast_scale,
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        )),
        ImageEffect::GrayScale => Some(grayscale_filter_with_tone(
            1.0,
            0.0,
            brightness_scale,
            contrast_scale,
            [0.299, 0.587, 0.114],
            [0.299, 0.587, 0.114],
            [0.299, 0.587, 0.114],
        )),
        ImageEffect::BlackWhite => Some(grayscale_filter_with_tone(
            255.0,
            -127.5,
            brightness_scale,
            contrast_scale,
            [0.299, 0.587, 0.114],
            [0.299, 0.587, 0.114],
            [0.299, 0.587, 0.114],
        )),
        ImageEffect::Pattern8x8 => Some(grayscale_filter_with_tone(
            1.0,
            0.0,
            brightness_scale,
            contrast_scale,
            [0.299, 0.587, 0.114],
            [0.299, 0.587, 0.114],
            [0.299, 0.587, 0.114],
        )),
    }
}

pub(crate) fn preprocess_binary_image_effect(image: &Image, effect: ImageEffect) -> Option<Image> {
    match effect {
        ImageEffect::BlackWhite => blackwhite_threshold_image(image),
        ImageEffect::Pattern8x8 => pattern8x8_dither_image(image),
        _ => None,
    }
}

fn ordered_dither_8x8_threshold(x: usize, y: usize) -> u8 {
    let matrix = ORDERED_DITHER_8X8[(y & 7) * 8 + (x & 7)] as u16;
    (((matrix * 2 + 1) * 255) / 128) as u8
}

fn luma_u8(red: u8, green: u8, blue: u8) -> u8 {
    (red as f32 * 0.299 + green as f32 * 0.587 + blue as f32 * 0.114).round() as u8
}

fn premultiply_binary_channel(value: u8, alpha: u8) -> u8 {
    ((u16::from(value) * u16::from(alpha) + 127) / 255) as u8
}

fn pattern8x8_dither_image(image: &Image) -> Option<Image> {
    luma_preprocessed_image(image, |x, y, luma| {
        if luma > ordered_dither_8x8_threshold(x, y) {
            255
        } else {
            0
        }
    })
}

fn blackwhite_threshold_image(image: &Image) -> Option<Image> {
    luma_preprocessed_image(image, |_, _, luma| if luma >= 128 { 255 } else { 0 })
}

fn luma_preprocessed_image(
    image: &Image,
    mut map_luma: impl FnMut(usize, usize, u8) -> u8,
) -> Option<Image> {
    let encoded = image.encode(None, EncodedImageFormat::PNG, None)?;
    let mut pixmap = tiny_skia::Pixmap::decode_png(encoded.as_bytes()).ok()?;
    let width = pixmap.width() as usize;
    for y in 0..pixmap.height() as usize {
        for x in 0..width {
            let index = y * width + x;
            let pixel = pixmap.pixels()[index];
            let luma = luma_u8(pixel.red(), pixel.green(), pixel.blue());
            let value = map_luma(x, y, luma);
            let premultiplied = premultiply_binary_channel(value, pixel.alpha());
            pixmap.pixels_mut()[index] = tiny_skia::PremultipliedColorU8::from_rgba(
                premultiplied,
                premultiplied,
                premultiplied,
                pixel.alpha(),
            )?;
        }
    }
    let png = pixmap.encode_png().ok()?;
    Image::from_encoded(Data::new_copy(&png))
}

fn grayscale_filter_with_tone(
    scale: f32,
    translate: f32,
    brightness_scale: f32,
    contrast_scale: f32,
    red_row: [f32; 3],
    green_row: [f32; 3],
    blue_row: [f32; 3],
) -> skia_safe::ColorFilter {
    let channel_scale = scale * brightness_scale * contrast_scale;
    let channel_translate =
        translate * brightness_scale * contrast_scale + 0.5 * (1.0 - contrast_scale);
    color_filters::matrix_row_major(
        &[
            red_row[0] * channel_scale,
            red_row[1] * channel_scale,
            red_row[2] * channel_scale,
            0.0,
            channel_translate,
            green_row[0] * channel_scale,
            green_row[1] * channel_scale,
            green_row[2] * channel_scale,
            0.0,
            channel_translate,
            blue_row[0] * channel_scale,
            blue_row[1] * channel_scale,
            blue_row[2] * channel_scale,
            0.0,
            channel_translate,
            0.0,
            0.0,
            0.0,
            1.0,
            0.0,
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
        0,
        0,
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
            let options = svg_options();
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
    rasterize_svg_fragment_with_view_box(svg_fragment, width, height, 0.0, 0.0, width, height)
}

pub fn rasterize_svg_fragment_with_view_box(
    svg_fragment: &str,
    width: f32,
    height: f32,
    view_box_x: f32,
    view_box_y: f32,
    view_box_width: f32,
    view_box_height: f32,
) -> Option<Image> {
    if width <= 0.0
        || height <= 0.0
        || view_box_width <= 0.0
        || view_box_height <= 0.0
        || !width.is_finite()
        || !height.is_finite()
        || !view_box_x.is_finite()
        || !view_box_y.is_finite()
        || !view_box_width.is_finite()
        || !view_box_height.is_finite()
    {
        return None;
    }

    let svg = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{width:.2}\" height=\"{height:.2}\" viewBox=\"{view_box_x:.2} {view_box_y:.2} {view_box_width:.2} {view_box_height:.2}\" preserveAspectRatio=\"none\">{svg_fragment}</svg>"
    );
    let options = svg_options();

    let tree = usvg::Tree::from_str(&svg, &options).ok()?;
    let size = tree.size().to_int_size();
    let mut pixmap = tiny_skia::Pixmap::new(size.width(), size.height())?;
    resvg::render(&tree, tiny_skia::Transform::default(), &mut pixmap.as_mut());
    let png = pixmap.encode_png().ok()?;
    Image::from_encoded(Data::new_copy(&png))
}

fn svg_options() -> usvg::Options<'static> {
    let fontdb = font_paths::default_usvg_fontdb();
    let mut options = usvg::Options::default();
    options.font_family = fontdb
        .family_name(&usvg::fontdb::Family::SansSerif)
        .to_string();
    options.fontdb = fontdb;
    options
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

    fn pattern8x8_reference_fixture() -> (u8, [[u8; 8]; 8]) {
        let raw = include_str!("../../../tests/fixtures/image_effect_pattern8x8_luma126.txt");
        let mut luma = None;
        let mut rows = [[0u8; 8]; 8];
        let mut row_count = 0usize;
        for line in raw.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Some(comment) = trimmed.strip_prefix('#') {
                if let Some(value) = comment.trim().strip_prefix("luma=") {
                    luma = value.parse::<u8>().ok();
                }
                continue;
            }
            assert!(row_count < 8, "too many Pattern8x8 reference rows");
            let values: Vec<u8> = trimmed
                .split_whitespace()
                .map(|value| value.parse::<u8>().expect("Pattern8x8 reference value"))
                .collect();
            assert_eq!(values.len(), 8, "Pattern8x8 reference row width");
            rows[row_count].copy_from_slice(&values);
            row_count += 1;
        }
        assert_eq!(row_count, 8, "Pattern8x8 reference row count");
        (luma.expect("Pattern8x8 reference luma"), rows)
    }

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

    #[test]
    fn svg_text_uses_portable_korean_fallback() {
        let image = rasterize_svg_fragment(
            r##"<text x="2" y="28" font-family="Definitely Missing RHWP Font, sans-serif" font-size="24" fill="#000000">한글</text>"##,
            64.0,
            36.0,
        )
        .expect("rasterize Korean SVG text");
        let encoded = image
            .encode(None, EncodedImageFormat::PNG, None)
            .expect("encode Korean SVG text");
        let pixmap =
            tiny_skia::Pixmap::decode_png(encoded.as_bytes()).expect("decode Korean SVG text");

        assert!(
            pixmap.pixels().iter().any(|pixel| pixel.alpha() > 0),
            "bundled Korean fallback should produce visible SVG text"
        );
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
            0,
            0,
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
            0,
            0,
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
    fn manual_tile_fallback_reports_cap_hits() {
        let mut source_surface = surfaces::raster_n32_premul((1, 1)).expect("source image surface");
        source_surface.canvas().clear(Color::BLACK);
        let image = source_surface.image_snapshot();
        let mut target_surface = surfaces::raster_n32_premul((16, 16)).expect("target surface");
        target_surface.canvas().clear(Color::TRANSPARENT);

        let diagnostics = draw_decoded_image_without_shader_for_test(
            target_surface.canvas(),
            &image,
            0.0,
            0.0,
            5000.0,
            1.0,
            Some(ImageFillMode::TileAll),
            Some((1.0, 1.0)),
            None,
            ImageEffect::RealPic,
            ImageSampling::nearest(),
        );

        assert_eq!(diagnostics.tile_fallback_cap_hits, 1);
    }

    #[test]
    fn pattern8x8_effect_uses_ordered_dither() {
        let (fixture_luma, expected) = pattern8x8_reference_fixture();
        let mut source = tiny_skia::Pixmap::new(8, 8).expect("source pixmap");
        for pixel in source.pixels_mut() {
            *pixel = tiny_skia::PremultipliedColorU8::from_rgba(
                fixture_luma,
                fixture_luma,
                fixture_luma,
                255,
            )
            .unwrap();
        }
        let png = source.encode_png().expect("source png");

        let mut surface = surfaces::raster_n32_premul((8, 8)).expect("surface");
        surface.canvas().clear(Color::TRANSPARENT);
        draw_image_bytes(
            surface.canvas(),
            &png,
            0.0,
            0.0,
            8.0,
            8.0,
            Some(ImageFillMode::FitToSize),
            Some((8.0, 8.0)),
            None,
            ImageEffect::Pattern8x8,
            0,
            0,
            ImageSampling::nearest(),
        );

        let rendered = surface
            .image_snapshot()
            .encode(None, EncodedImageFormat::PNG, None)
            .expect("render png");
        let pixmap = tiny_skia::Pixmap::decode_png(rendered.as_bytes()).expect("decode render");
        for (y, row) in expected.iter().enumerate() {
            for (x, expected_value) in row.iter().enumerate() {
                let pixel = pixmap.pixels()[y * 8 + x];
                if *expected_value == 0 {
                    assert!(
                        pixel.red() < 32 && pixel.green() < 32 && pixel.blue() < 32,
                        "expected dark Bayer pixel at ({x},{y}), got #{:02x}{:02x}{:02x}",
                        pixel.red(),
                        pixel.green(),
                        pixel.blue()
                    );
                } else {
                    assert!(
                        pixel.red() > 223 && pixel.green() > 223 && pixel.blue() > 223,
                        "expected light Bayer pixel at ({x},{y}), got #{:02x}{:02x}{:02x}",
                        pixel.red(),
                        pixel.green(),
                        pixel.blue()
                    );
                }
            }
        }
    }

    #[test]
    fn pattern8x8_effect_preserves_full_image_phase_for_crop_offsets() {
        let (fixture_luma, _) = pattern8x8_reference_fixture();
        let mut source = tiny_skia::Pixmap::new(16, 16).expect("source pixmap");
        for pixel in source.pixels_mut() {
            *pixel = tiny_skia::PremultipliedColorU8::from_rgba(
                fixture_luma,
                fixture_luma,
                fixture_luma,
                255,
            )
            .unwrap();
        }
        let png = source.encode_png().expect("source png");
        let image = decode_image_bytes(&png).expect("decode image");
        let dithered = pattern8x8_dither_image(&image).expect("dithered image");
        let encoded = dithered
            .encode(None, EncodedImageFormat::PNG, None)
            .expect("render png");
        let pixmap = tiny_skia::Pixmap::decode_png(encoded.as_bytes()).expect("decode render");

        for (phase_x, phase_y) in [(3usize, 5usize), (7, 7), (8, 8)] {
            for y in 0..8usize {
                for x in 0..8usize {
                    let source_x = x + phase_x;
                    let source_y = y + phase_y;
                    let expected =
                        if fixture_luma > ordered_dither_8x8_threshold(source_x, source_y) {
                            255
                        } else {
                            0
                        };
                    let pixel = pixmap.pixels()[source_y * 16 + source_x];
                    if expected == 0 {
                        assert!(
                            pixel.red() < 32 && pixel.green() < 32 && pixel.blue() < 32,
                            "expected dark Bayer crop-phase pixel at ({source_x},{source_y}), got #{:02x}{:02x}{:02x}",
                            pixel.red(),
                            pixel.green(),
                            pixel.blue()
                        );
                    } else {
                        assert!(
                            pixel.red() > 223 && pixel.green() > 223 && pixel.blue() > 223,
                            "expected light Bayer crop-phase pixel at ({source_x},{source_y}), got #{:02x}{:02x}{:02x}",
                            pixel.red(),
                            pixel.green(),
                            pixel.blue()
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn binary_image_effect_uses_nearest_sampling_when_scaled() {
        let (fixture_luma, _) = pattern8x8_reference_fixture();
        let mut source = tiny_skia::Pixmap::new(8, 8).expect("source pixmap");
        for pixel in source.pixels_mut() {
            *pixel = tiny_skia::PremultipliedColorU8::from_rgba(
                fixture_luma,
                fixture_luma,
                fixture_luma,
                255,
            )
            .unwrap();
        }
        let png = source.encode_png().expect("source png");

        let mut surface = surfaces::raster_n32_premul((16, 16)).expect("surface");
        surface.canvas().clear(Color::TRANSPARENT);
        draw_image_bytes(
            surface.canvas(),
            &png,
            0.0,
            0.0,
            16.0,
            16.0,
            Some(ImageFillMode::FitToSize),
            Some((8.0, 8.0)),
            None,
            ImageEffect::Pattern8x8,
            0,
            0,
            ImageSampling::linear(),
        );

        let rendered = surface
            .image_snapshot()
            .encode(None, EncodedImageFormat::PNG, None)
            .expect("render png");
        let pixmap = tiny_skia::Pixmap::decode_png(rendered.as_bytes()).expect("decode render");

        for (index, pixel) in pixmap.pixels().iter().enumerate() {
            assert!(
                (pixel.red() < 32 || pixel.red() > 223)
                    && (pixel.green() < 32 || pixel.green() > 223)
                    && (pixel.blue() < 32 || pixel.blue() > 223),
                "binary Pattern8x8 scaled pixel should remain binary at index {index}, got #{:02x}{:02x}{:02x}",
                pixel.red(),
                pixel.green(),
                pixel.blue()
            );
        }
    }

    #[test]
    fn pattern8x8_effect_preserves_alpha_when_scaled() {
        let (fixture_luma, _) = pattern8x8_reference_fixture();
        let alpha_for = |x: usize, y: usize| -> u8 { [0, 64, 128, 255][(x + y) & 3] };
        let mut source = tiny_skia::Pixmap::new(4, 4).expect("source pixmap");
        for y in 0..4usize {
            for x in 0..4usize {
                let alpha = alpha_for(x, y);
                let channel = fixture_luma.min(alpha);
                source.pixels_mut()[y * 4 + x] =
                    tiny_skia::PremultipliedColorU8::from_rgba(channel, channel, channel, alpha)
                        .unwrap();
            }
        }
        let png = source.encode_png().expect("source png");

        let mut surface = surfaces::raster_n32_premul((8, 8)).expect("surface");
        surface.canvas().clear(Color::TRANSPARENT);
        draw_image_bytes(
            surface.canvas(),
            &png,
            0.0,
            0.0,
            8.0,
            8.0,
            Some(ImageFillMode::FitToSize),
            Some((4.0, 4.0)),
            None,
            ImageEffect::Pattern8x8,
            0,
            0,
            ImageSampling::linear(),
        );

        let rendered = surface
            .image_snapshot()
            .encode(None, EncodedImageFormat::PNG, None)
            .expect("render png");
        let pixmap = tiny_skia::Pixmap::decode_png(rendered.as_bytes()).expect("decode render");
        for y in 0..8usize {
            for x in 0..8usize {
                let expected_alpha = alpha_for(x / 2, y / 2);
                let pixel = pixmap.pixels()[y * 8 + x];
                assert_eq!(
                    pixel.alpha(),
                    expected_alpha,
                    "scaled Pattern8x8 should preserve source alpha at ({x},{y})"
                );
                if expected_alpha == 255 {
                    assert!(
                        pixel.red() < 32 || pixel.red() > 223,
                        "opaque scaled Pattern8x8 pixel should remain binary at ({x},{y}), got {}",
                        pixel.red()
                    );
                }
            }
        }
    }

    #[test]
    fn blackwhite_effect_uses_midpoint_threshold() {
        let mut source = tiny_skia::Pixmap::new(2, 1).expect("source pixmap");
        source.pixels_mut()[0] =
            tiny_skia::PremultipliedColorU8::from_rgba(127, 127, 127, 255).unwrap();
        source.pixels_mut()[1] =
            tiny_skia::PremultipliedColorU8::from_rgba(128, 128, 128, 255).unwrap();
        let png = source.encode_png().expect("source png");

        let mut surface = surfaces::raster_n32_premul((2, 1)).expect("surface");
        surface.canvas().clear(Color::TRANSPARENT);
        draw_image_bytes(
            surface.canvas(),
            &png,
            0.0,
            0.0,
            2.0,
            1.0,
            Some(ImageFillMode::FitToSize),
            Some((2.0, 1.0)),
            None,
            ImageEffect::BlackWhite,
            0,
            0,
            ImageSampling::nearest(),
        );

        let rendered = surface
            .image_snapshot()
            .encode(None, EncodedImageFormat::PNG, None)
            .expect("render png");
        let pixmap = tiny_skia::Pixmap::decode_png(rendered.as_bytes()).expect("decode render");

        assert!(
            pixmap.pixels()[0].red() < 32,
            "luma below 128 should become black"
        );
        assert!(
            pixmap.pixels()[1].red() > 223,
            "luma at 128 should become white"
        );
    }

    #[test]
    fn realpic_effect_applies_brightness_contrast_tone() {
        let mut source = tiny_skia::Pixmap::new(1, 1).expect("source pixmap");
        source.pixels_mut()[0] =
            tiny_skia::PremultipliedColorU8::from_rgba(100, 120, 140, 255).unwrap();
        let png = source.encode_png().expect("source png");

        let mut surface = surfaces::raster_n32_premul((1, 1)).expect("surface");
        surface.canvas().clear(Color::TRANSPARENT);
        draw_image_bytes(
            surface.canvas(),
            &png,
            0.0,
            0.0,
            1.0,
            1.0,
            Some(ImageFillMode::FitToSize),
            Some((1.0, 1.0)),
            None,
            ImageEffect::RealPic,
            20,
            50,
            ImageSampling::nearest(),
        );

        let rendered = surface
            .image_snapshot()
            .encode(None, EncodedImageFormat::PNG, None)
            .expect("render png");
        let pixmap = tiny_skia::Pixmap::decode_png(rendered.as_bytes()).expect("decode render");
        let pixel = pixmap.pixels()[0];
        assert!(
            pixel.red().abs_diff(116) <= 2,
            "red tone channel, got {}",
            pixel.red()
        );
        assert!(
            pixel.green().abs_diff(152) <= 2,
            "green tone channel, got {}",
            pixel.green()
        );
        assert!(
            pixel.blue().abs_diff(188) <= 2,
            "blue tone channel, got {}",
            pixel.blue()
        );
        assert_eq!(pixel.alpha(), 255);
    }

    #[test]
    fn blackwhite_preprocess_keeps_brightness_tone() {
        let mut source = tiny_skia::Pixmap::new(1, 1).expect("source pixmap");
        source.pixels_mut()[0] =
            tiny_skia::PremultipliedColorU8::from_rgba(128, 128, 128, 255).unwrap();
        let png = source.encode_png().expect("source png");

        let mut surface = surfaces::raster_n32_premul((1, 1)).expect("surface");
        surface.canvas().clear(Color::TRANSPARENT);
        draw_image_bytes(
            surface.canvas(),
            &png,
            0.0,
            0.0,
            1.0,
            1.0,
            Some(ImageFillMode::FitToSize),
            Some((1.0, 1.0)),
            None,
            ImageEffect::BlackWhite,
            -20,
            0,
            ImageSampling::nearest(),
        );

        let rendered = surface
            .image_snapshot()
            .encode(None, EncodedImageFormat::PNG, None)
            .expect("render png");
        let pixmap = tiny_skia::Pixmap::decode_png(rendered.as_bytes()).expect("decode render");
        let pixel = pixmap.pixels()[0];
        assert!(pixel.red().abs_diff(204) <= 2, "blackWhite red tone");
        assert!(pixel.green().abs_diff(204) <= 2, "blackWhite green tone");
        assert!(pixel.blue().abs_diff(204) <= 2, "blackWhite blue tone");
        assert_eq!(pixel.alpha(), 255);
    }

    #[test]
    fn blackwhite_effect_preserves_transparent_edge_alpha() {
        let mut source = tiny_skia::Pixmap::new(2, 1).expect("source pixmap");
        source.pixels_mut()[0] =
            tiny_skia::PremultipliedColorU8::from_rgba(32, 32, 32, 64).unwrap();
        source.pixels_mut()[1] =
            tiny_skia::PremultipliedColorU8::from_rgba(192, 192, 192, 192).unwrap();
        let png = source.encode_png().expect("source png");

        let mut surface = surfaces::raster_n32_premul((2, 1)).expect("surface");
        surface.canvas().clear(Color::TRANSPARENT);
        draw_image_bytes(
            surface.canvas(),
            &png,
            0.0,
            0.0,
            2.0,
            1.0,
            Some(ImageFillMode::FitToSize),
            Some((2.0, 1.0)),
            None,
            ImageEffect::BlackWhite,
            0,
            0,
            ImageSampling::linear(),
        );

        let rendered = surface
            .image_snapshot()
            .encode(None, EncodedImageFormat::PNG, None)
            .expect("render png");
        let pixmap = tiny_skia::Pixmap::decode_png(rendered.as_bytes()).expect("decode render");
        let dark_edge = pixmap.pixels()[0];
        let light_edge = pixmap.pixels()[1];

        assert_eq!(dark_edge.alpha(), 64);
        assert_eq!(light_edge.alpha(), 192);
        assert!(
            dark_edge.red() < 8 && dark_edge.green() < 8 && dark_edge.blue() < 8,
            "transparent blackWhite dark edge should stay black"
        );
        assert!(
            u16::from(light_edge.red()) + 1 >= u16::from(light_edge.alpha())
                && u16::from(light_edge.green()) + 1 >= u16::from(light_edge.alpha())
                && u16::from(light_edge.blue()) + 1 >= u16::from(light_edge.alpha()),
            "transparent blackWhite light edge should stay white in premultiplied form"
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
            0,
            0,
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
