use std::io::Cursor;

use image::{DynamicImage, ImageFormat};

use crate::model::image::ImageEffect;

const ORDERED_DITHER_8X8: [u8; 64] = [
    0, 48, 12, 60, 3, 51, 15, 63, 32, 16, 44, 28, 35, 19, 47, 31, 8, 56, 4, 52, 11, 59, 7, 55, 40,
    24, 36, 20, 43, 27, 39, 23, 2, 50, 14, 62, 1, 49, 13, 61, 34, 18, 46, 30, 33, 17, 45, 29, 10,
    58, 6, 54, 9, 57, 5, 53, 42, 26, 38, 22, 41, 25, 37, 21,
];

pub(crate) fn preprocess_binary_image_effect_bytes(
    data: &[u8],
    effect: ImageEffect,
) -> Option<Vec<u8>> {
    if !matches!(effect, ImageEffect::BlackWhite | ImageEffect::Pattern8x8) {
        return None;
    }

    let mut image = image::load_from_memory(data).ok()?.to_rgba8();
    for (x, y, pixel) in image.enumerate_pixels_mut() {
        let luma = (f32::from(pixel[0]) * 0.299
            + f32::from(pixel[1]) * 0.587
            + f32::from(pixel[2]) * 0.114)
            .round() as u8;
        let value = match effect {
            ImageEffect::BlackWhite => {
                if luma >= 128 {
                    255
                } else {
                    0
                }
            }
            ImageEffect::Pattern8x8 => {
                let matrix = u16::from(ORDERED_DITHER_8X8[((y & 7) * 8 + (x & 7)) as usize]);
                let threshold = (((matrix * 2 + 1) * 255) / 128) as u8;
                if luma > threshold {
                    255
                } else {
                    0
                }
            }
            _ => unreachable!(),
        };
        let alpha = pixel[3];
        *pixel = image::Rgba([value, value, value, alpha]);
    }

    let mut output = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image)
        .write_to(&mut output, ImageFormat::Png)
        .ok()?;
    Some(output.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode_rgba(width: u32, height: u32, pixels: Vec<u8>) -> Vec<u8> {
        let image = image::RgbaImage::from_raw(width, height, pixels).expect("valid RGBA pixels");
        let mut output = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(image)
            .write_to(&mut output, ImageFormat::Png)
            .expect("encode PNG");
        output.into_inner()
    }

    fn decode_rgba(data: &[u8]) -> image::RgbaImage {
        image::load_from_memory(data)
            .expect("decode image")
            .to_rgba8()
    }

    #[test]
    fn blackwhite_uses_canvas_threshold_and_preserves_alpha() {
        let input = encode_rgba(2, 1, vec![127, 127, 127, 37, 128, 128, 128, 191]);
        let output = preprocess_binary_image_effect_bytes(&input, ImageEffect::BlackWhite)
            .expect("preprocess image");
        let pixels = decode_rgba(&output);

        assert_eq!(pixels.get_pixel(0, 0).0, [0, 0, 0, 37]);
        assert_eq!(pixels.get_pixel(1, 0).0, [255, 255, 255, 191]);
    }

    #[test]
    fn pattern8x8_matches_canvas_reference_fixture() {
        let fixture = include_str!("../../tests/fixtures/image_effect_pattern8x8_luma126.txt");
        let expected = fixture
            .lines()
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .flat_map(|line| line.split_whitespace())
            .map(|value| value.parse::<u8>().expect("fixture channel"))
            .collect::<Vec<_>>();
        let input = encode_rgba(
            8,
            8,
            std::iter::repeat([126, 126, 126, 173])
                .take(64)
                .flatten()
                .collect(),
        );
        let output = preprocess_binary_image_effect_bytes(&input, ImageEffect::Pattern8x8)
            .expect("preprocess image");
        let pixels = decode_rgba(&output);

        for (pixel, expected) in pixels.pixels().zip(expected) {
            assert_eq!(pixel.0, [expected, expected, expected, 173]);
        }
    }

    #[test]
    fn non_binary_effects_do_not_preprocess() {
        assert!(preprocess_binary_image_effect_bytes(&[], ImageEffect::RealPic).is_none());
        assert!(preprocess_binary_image_effect_bytes(&[], ImageEffect::GrayScale).is_none());
    }
}
