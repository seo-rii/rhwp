use std::borrow::Cow;

use image::{codecs::png::PngEncoder, ColorType, ImageEncoder};

use super::image_header::{CANVASKIT_MAX_IMAGE_DIMENSION, CANVASKIT_MAX_IMAGE_PIXELS};

const PCX_HEADER_LEN: usize = 128;
const PCX_PALETTE_MARKER: u8 = 0x0c;
const PCX_256_COLOR_PALETTE_LEN: usize = 1 + 256 * 3;

pub(crate) fn normalize_replay_image_bytes(bytes: &[u8]) -> Cow<'_, [u8]> {
    decode_pcx_to_png(bytes).map_or(Cow::Borrowed(bytes), Cow::Owned)
}

fn decode_pcx_to_png(bytes: &[u8]) -> Option<Vec<u8>> {
    let decoded = decode_pcx_rgba(bytes)?;
    let mut png = Vec::new();
    PngEncoder::new(&mut png)
        .write_image(
            &decoded.pixels,
            decoded.width,
            decoded.height,
            ColorType::Rgba8.into(),
        )
        .ok()?;
    Some(png)
}

struct DecodedPcx {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

fn decode_pcx_rgba(bytes: &[u8]) -> Option<DecodedPcx> {
    let header = bytes.get(..PCX_HEADER_LEN)?;
    if header[0] != 0x0a || !matches!(header[1], 0 | 2 | 3 | 4 | 5) || header[2] != 1 {
        return None;
    }

    let bits_per_pixel = header[3];
    let x_min = read_u16_le(header, 4)?;
    let y_min = read_u16_le(header, 6)?;
    let x_max = read_u16_le(header, 8)?;
    let y_max = read_u16_le(header, 10)?;
    if x_max < x_min || y_max < y_min {
        return None;
    }
    let width = u32::from(x_max - x_min) + 1;
    let height = u32::from(y_max - y_min) + 1;
    let pixel_count = u64::from(width).checked_mul(u64::from(height))?;
    if width > CANVASKIT_MAX_IMAGE_DIMENSION
        || height > CANVASKIT_MAX_IMAGE_DIMENSION
        || pixel_count > CANVASKIT_MAX_IMAGE_PIXELS
    {
        return None;
    }

    let plane_count = usize::from(header[65]);
    let bytes_per_line = usize::from(read_u16_le(header, 66)?);
    if plane_count == 0 || bytes_per_line == 0 {
        return None;
    }
    let supported_layout = match (bits_per_pixel, plane_count) {
        (8, 1 | 3) => true,
        (1 | 2 | 4, planes) => usize::from(bits_per_pixel) * planes <= 4,
        _ => false,
    };
    if !supported_layout {
        return None;
    }

    let packed_line_bits = usize::try_from(width)
        .ok()?
        .checked_mul(usize::from(bits_per_pixel))?;
    let minimum_bytes_per_line = packed_line_bits.div_ceil(8);
    if bytes_per_line < minimum_bytes_per_line {
        return None;
    }
    let decoded_line_len = bytes_per_line.checked_mul(plane_count)?;
    let decoded_byte_len = decoded_line_len.checked_mul(usize::try_from(height).ok()?)?;
    if decoded_byte_len
        > usize::try_from(CANVASKIT_MAX_IMAGE_PIXELS)
            .ok()?
            .saturating_mul(4)
    {
        return None;
    }

    let indexed_256_palette = if bits_per_pixel == 8 && plane_count == 1 {
        let palette_offset = bytes.len().checked_sub(PCX_256_COLOR_PALETTE_LEN)?;
        (bytes.get(palette_offset) == Some(&PCX_PALETTE_MARKER)).then_some(palette_offset)?
    } else {
        bytes.len()
    };
    let data_end = indexed_256_palette;
    let mut cursor = PCX_HEADER_LEN;
    let mut decoded_line = vec![0_u8; decoded_line_len];
    let output_len = usize::try_from(pixel_count).ok()?.checked_mul(4)?;
    let mut pixels = vec![0_u8; output_len];

    for y in 0..usize::try_from(height).ok()? {
        decode_pcx_scanline(bytes, &mut cursor, data_end, &mut decoded_line)?;
        for x in 0..usize::try_from(width).ok()? {
            let rgba = match (bits_per_pixel, plane_count) {
                (8, 1) => {
                    let index = usize::from(decoded_line[x]);
                    let palette_start = indexed_256_palette + 1 + index * 3;
                    [
                        *bytes.get(palette_start)?,
                        *bytes.get(palette_start + 1)?,
                        *bytes.get(palette_start + 2)?,
                        0xff,
                    ]
                }
                (8, 3) => [
                    decoded_line[x],
                    decoded_line[bytes_per_line + x],
                    decoded_line[bytes_per_line * 2 + x],
                    0xff,
                ],
                _ => {
                    let bit_offset = x.checked_mul(usize::from(bits_per_pixel))?;
                    let byte_offset = bit_offset / 8;
                    let bit_in_byte = bit_offset % 8;
                    let shift = 8_usize
                        .checked_sub(usize::from(bits_per_pixel))?
                        .checked_sub(bit_in_byte)?;
                    let mask = (1_u8 << bits_per_pixel) - 1;
                    let mut palette_index = 0_usize;
                    for plane in 0..plane_count {
                        let sample =
                            (decoded_line[plane * bytes_per_line + byte_offset] >> shift) & mask;
                        palette_index |=
                            usize::from(sample) << (plane * usize::from(bits_per_pixel));
                    }
                    let palette_start = 16 + palette_index * 3;
                    [
                        *header.get(palette_start)?,
                        *header.get(palette_start + 1)?,
                        *header.get(palette_start + 2)?,
                        0xff,
                    ]
                }
            };
            let output_offset = (y * usize::try_from(width).ok()? + x) * 4;
            pixels[output_offset..output_offset + 4].copy_from_slice(&rgba);
        }
    }

    Some(DecodedPcx {
        width,
        height,
        pixels,
    })
}

fn decode_pcx_scanline(
    bytes: &[u8],
    cursor: &mut usize,
    data_end: usize,
    output: &mut [u8],
) -> Option<()> {
    let mut written = 0;
    while written < output.len() {
        if *cursor >= data_end {
            return None;
        }
        let marker = *bytes.get(*cursor)?;
        *cursor += 1;
        let (run_len, value) = if marker & 0xc0 == 0xc0 {
            let run_len = usize::from(marker & 0x3f);
            if run_len == 0 || *cursor >= data_end {
                return None;
            }
            let value = *bytes.get(*cursor)?;
            *cursor += 1;
            (run_len, value)
        } else {
            (1, marker)
        };
        let run_end = written.checked_add(run_len)?;
        if run_end > output.len() {
            return None;
        }
        output[written..run_end].fill(value);
        written = run_end;
    }
    Some(())
}

fn read_u16_le(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_le_bytes([
        *bytes.get(offset)?,
        *bytes.get(offset + 1)?,
    ]))
}

#[cfg(test)]
mod tests {
    use std::borrow::Cow;

    use super::normalize_replay_image_bytes;

    fn pcx_header(
        width: u16,
        height: u16,
        bits_per_pixel: u8,
        plane_count: u8,
        bytes_per_line: u16,
    ) -> Vec<u8> {
        let mut header = vec![0_u8; 128];
        header[0] = 0x0a;
        header[1] = 5;
        header[2] = 1;
        header[3] = bits_per_pixel;
        header[8..10].copy_from_slice(&(width - 1).to_le_bytes());
        header[10..12].copy_from_slice(&(height - 1).to_le_bytes());
        header[12..14].copy_from_slice(&96_u16.to_le_bytes());
        header[14..16].copy_from_slice(&96_u16.to_le_bytes());
        header[16..19].copy_from_slice(&[0, 0, 0]);
        header[19..22].copy_from_slice(&[255, 255, 255]);
        header[65] = plane_count;
        header[66..68].copy_from_slice(&bytes_per_line.to_le_bytes());
        header
    }

    fn push_rle(bytes: &mut Vec<u8>, value: u8) {
        if value & 0xc0 == 0xc0 {
            bytes.extend_from_slice(&[0xc1, value]);
        } else {
            bytes.push(value);
        }
    }

    #[test]
    fn normalizes_monochrome_pcx_to_rgba_png() {
        let mut pcx = pcx_header(8, 1, 1, 1, 2);
        pcx.extend_from_slice(&[0xaa, 0]);

        let normalized = normalize_replay_image_bytes(&pcx);
        assert!(matches!(normalized, Cow::Owned(_)));
        assert_eq!(&normalized[..8], b"\x89PNG\r\n\x1a\n");

        let decoded = image::load_from_memory_with_format(&normalized, image::ImageFormat::Png)
            .expect("normalized PNG")
            .to_rgba8();
        assert_eq!(decoded.dimensions(), (8, 1));
        for x in 0..8 {
            let expected = if x % 2 == 0 { 255 } else { 0 };
            assert_eq!(
                decoded.get_pixel(x, 0).0,
                [expected, expected, expected, 255]
            );
        }
    }

    #[test]
    fn normalizes_three_plane_true_color_pcx() {
        let mut pcx = pcx_header(2, 1, 8, 3, 2);
        for value in [255, 0, 0, 255, 0, 0] {
            push_rle(&mut pcx, value);
        }

        let normalized = normalize_replay_image_bytes(&pcx);
        let decoded = image::load_from_memory_with_format(&normalized, image::ImageFormat::Png)
            .expect("normalized PNG")
            .to_rgba8();
        assert_eq!(decoded.get_pixel(0, 0).0, [255, 0, 0, 255]);
        assert_eq!(decoded.get_pixel(1, 0).0, [0, 255, 0, 255]);
    }

    #[test]
    fn keeps_non_pcx_and_malformed_pcx_bytes_unchanged() {
        let png = b"\x89PNG\r\n\x1a\n";
        assert!(matches!(
            normalize_replay_image_bytes(png),
            Cow::Borrowed(bytes) if bytes == png
        ));

        let mut malformed = pcx_header(8, 1, 1, 1, 1);
        malformed.extend_from_slice(&[0xc2, 0]);
        assert!(matches!(
            normalize_replay_image_bytes(&malformed),
            Cow::Borrowed(bytes) if bytes == malformed
        ));
    }
}
