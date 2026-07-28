const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

pub(crate) const CANVASKIT_MAX_IMAGE_DIMENSION: u32 = 8192;
pub(crate) const CANVASKIT_MAX_IMAGE_PIXELS: u64 = 32 * 1024 * 1024;
pub(crate) const CANVASKIT_MAX_SVG_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CanvasKitEncodedImageFormat {
    Png,
    Jpeg,
    Gif,
    WebP,
    Bmp,
    Svg,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CanvasKitEncodedImageHeader {
    pub format: CanvasKitEncodedImageFormat,
    pub width: u32,
    pub height: u32,
}

impl CanvasKitEncodedImageHeader {
    pub(crate) fn is_within_decode_limits(self) -> bool {
        self.width <= CANVASKIT_MAX_IMAGE_DIMENSION
            && self.height <= CANVASKIT_MAX_IMAGE_DIMENSION
            && u64::from(self.width).saturating_mul(u64::from(self.height))
                <= CANVASKIT_MAX_IMAGE_PIXELS
    }

    pub(crate) fn is_svg(self) -> bool {
        self.format == CanvasKitEncodedImageFormat::Svg
    }
}

pub(crate) fn canvaskit_encoded_image_header(bytes: &[u8]) -> Option<CanvasKitEncodedImageHeader> {
    parse_png_header(bytes)
        .or_else(|| parse_gif_header(bytes))
        .or_else(|| parse_webp_header(bytes))
        .or_else(|| parse_bmp_header(bytes))
        .or_else(|| parse_jpeg_header(bytes))
        .or_else(|| parse_svg_header(bytes))
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum SvgIntrinsicLength {
    Missing,
    Relative,
    Absolute(f64),
}

fn parse_svg_header(bytes: &[u8]) -> Option<CanvasKitEncodedImageHeader> {
    if bytes
        .windows(b"<!doctype".len())
        .any(|window| window.eq_ignore_ascii_case(b"<!doctype"))
    {
        return None;
    }
    let text = std::str::from_utf8(bytes).ok()?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut reader = quick_xml::Reader::from_str(text);

    loop {
        match reader.read_event().ok()? {
            quick_xml::events::Event::Decl(_)
            | quick_xml::events::Event::PI(_)
            | quick_xml::events::Event::Comment(_) => {}
            quick_xml::events::Event::Text(text) if is_xml_whitespace(text.as_ref()) => {}
            quick_xml::events::Event::Start(root) | quick_xml::events::Event::Empty(root) => {
                if root.local_name().as_ref() != b"svg" {
                    return None;
                }

                let mut width = SvgIntrinsicLength::Missing;
                let mut height = SvgIntrinsicLength::Missing;
                let mut view_box = None;
                for attribute in root.attributes() {
                    let attribute = attribute.ok()?;
                    let value = attribute.decode_and_unescape_value(root.decoder()).ok()?;
                    match attribute.key.as_ref() {
                        b"width" => width = parse_svg_length(&value)?,
                        b"height" => height = parse_svg_length(&value)?,
                        b"viewBox" => view_box = Some(parse_svg_view_box(&value)?),
                        _ => {}
                    }
                }

                let (width, height) = resolve_svg_dimensions(width, height, view_box)?;
                return Some(CanvasKitEncodedImageHeader {
                    format: CanvasKitEncodedImageFormat::Svg,
                    width,
                    height,
                });
            }
            quick_xml::events::Event::DocType(_)
            | quick_xml::events::Event::CData(_)
            | quick_xml::events::Event::End(_)
            | quick_xml::events::Event::GeneralRef(_) => return None,
            quick_xml::events::Event::Eof => return None,
            _ => return None,
        }
    }
}

fn is_xml_whitespace(bytes: &[u8]) -> bool {
    bytes.iter().all(u8::is_ascii_whitespace)
}

fn parse_svg_length(value: &str) -> Option<SvgIntrinsicLength> {
    let value = value.trim();
    let normalized = value.to_ascii_lowercase();
    if normalized == "auto" {
        return Some(SvgIntrinsicLength::Relative);
    }
    if let Some(number) = normalized.strip_suffix('%') {
        let number = number.trim().parse::<f64>().ok()?;
        return (number.is_finite() && number > 0.0).then_some(SvgIntrinsicLength::Relative);
    }

    let (number, scale) = [
        ("px", 1.0),
        ("pt", 96.0 / 72.0),
        ("pc", 16.0),
        ("in", 96.0),
        ("cm", 96.0 / 2.54),
        ("mm", 96.0 / 25.4),
        ("q", 96.0 / 101.6),
    ]
    .into_iter()
    .find_map(|(suffix, scale)| {
        normalized
            .strip_suffix(suffix)
            .map(|number| (number.trim(), scale))
    })
    .unwrap_or((normalized.as_str(), 1.0));
    let number = number.parse::<f64>().ok()? * scale;
    (number.is_finite() && number > 0.0).then_some(SvgIntrinsicLength::Absolute(number))
}

fn parse_svg_view_box(value: &str) -> Option<(f64, f64)> {
    let values = value
        .split(|character: char| character == ',' || character.is_ascii_whitespace())
        .filter(|value| !value.is_empty())
        .map(str::parse::<f64>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    if values.len() != 4 || values.iter().any(|value| !value.is_finite()) {
        return None;
    }
    let width = values[2];
    let height = values[3];
    (width > 0.0 && height > 0.0).then_some((width, height))
}

fn resolve_svg_dimensions(
    width: SvgIntrinsicLength,
    height: SvgIntrinsicLength,
    view_box: Option<(f64, f64)>,
) -> Option<(u32, u32)> {
    let absolute_width = match width {
        SvgIntrinsicLength::Absolute(value) => Some(value),
        SvgIntrinsicLength::Missing | SvgIntrinsicLength::Relative => None,
    };
    let absolute_height = match height {
        SvgIntrinsicLength::Absolute(value) => Some(value),
        SvgIntrinsicLength::Missing | SvgIntrinsicLength::Relative => None,
    };
    let (width, height) = match (absolute_width, absolute_height, view_box) {
        (Some(width), Some(height), _) => (width, height),
        (Some(width), None, Some((view_width, view_height))) => {
            (width, width * view_height / view_width)
        }
        (None, Some(height), Some((view_width, view_height))) => {
            (height * view_width / view_height, height)
        }
        (None, None, Some(dimensions)) => dimensions,
        (Some(width), None, None) => (width, 150.0),
        (None, Some(height), None) => (300.0, height),
        (None, None, None) => (300.0, 150.0),
    };
    let width = finite_svg_dimension(width)?;
    let height = finite_svg_dimension(height)?;
    Some((width, height))
}

fn finite_svg_dimension(value: f64) -> Option<u32> {
    if !value.is_finite() || value <= 0.0 || value > f64::from(u32::MAX) {
        return None;
    }
    Some(value.ceil() as u32)
}

fn parse_png_header(bytes: &[u8]) -> Option<CanvasKitEncodedImageHeader> {
    if bytes.len() < 33
        || &bytes[..8] != PNG_SIGNATURE
        || read_be_u32(bytes, 8)? != 13
        || &bytes[12..16] != b"IHDR"
    {
        return None;
    }

    let width = read_be_u32(bytes, 16)?;
    let height = read_be_u32(bytes, 20)?;
    let bit_depth = bytes[24];
    let color_type = bytes[25];
    let valid_depth = match color_type {
        0 => matches!(bit_depth, 1 | 2 | 4 | 8 | 16),
        2 | 4 | 6 => matches!(bit_depth, 8 | 16),
        3 => matches!(bit_depth, 1 | 2 | 4 | 8),
        _ => false,
    };
    if width == 0
        || height == 0
        || !valid_depth
        || bytes[26] != 0
        || bytes[27] != 0
        || bytes[28] > 1
    {
        return None;
    }

    Some(CanvasKitEncodedImageHeader {
        format: CanvasKitEncodedImageFormat::Png,
        width,
        height,
    })
}

fn parse_gif_header(bytes: &[u8]) -> Option<CanvasKitEncodedImageHeader> {
    if bytes.len() < 13 || !matches!(&bytes[..6], b"GIF87a" | b"GIF89a") {
        return None;
    }

    let width = u32::from(read_le_u16(bytes, 6)?);
    let height = u32::from(read_le_u16(bytes, 8)?);
    if width == 0 || height == 0 {
        return None;
    }

    let packed = bytes[10];
    if packed & 0x80 != 0 {
        let color_count = 1usize.checked_shl(u32::from((packed & 0x07) + 1))?;
        let header_len = 13usize.checked_add(color_count.checked_mul(3)?)?;
        if bytes.len() < header_len {
            return None;
        }
    }

    Some(CanvasKitEncodedImageHeader {
        format: CanvasKitEncodedImageFormat::Gif,
        width,
        height,
    })
}

fn parse_webp_header(bytes: &[u8]) -> Option<CanvasKitEncodedImageHeader> {
    if bytes.len() < 20 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return None;
    }

    let riff_end = usize::try_from(read_le_u32(bytes, 4)?)
        .ok()?
        .checked_add(8)?;
    if riff_end > bytes.len() || riff_end < 20 {
        return None;
    }
    let chunk_len = usize::try_from(read_le_u32(bytes, 16)?).ok()?;
    let chunk_end = 20usize.checked_add(chunk_len)?.checked_add(chunk_len & 1)?;
    if chunk_end > riff_end || chunk_end > bytes.len() {
        return None;
    }

    let (width, height) = match &bytes[12..16] {
        b"VP8X" if chunk_len >= 10 => (
            read_le_u24(bytes, 24)?.checked_add(1)?,
            read_le_u24(bytes, 27)?.checked_add(1)?,
        ),
        b"VP8 " if chunk_len >= 10 && &bytes[23..26] == b"\x9d\x01\x2a" => (
            u32::from(read_le_u16(bytes, 26)? & 0x3fff),
            u32::from(read_le_u16(bytes, 28)? & 0x3fff),
        ),
        b"VP8L" if chunk_len >= 5 && bytes[20] == 0x2f => {
            let bits = read_le_u32(bytes, 21)?;
            (
                (bits & 0x3fff).checked_add(1)?,
                ((bits >> 14) & 0x3fff).checked_add(1)?,
            )
        }
        _ => return None,
    };
    if width == 0 || height == 0 {
        return None;
    }

    Some(CanvasKitEncodedImageHeader {
        format: CanvasKitEncodedImageFormat::WebP,
        width,
        height,
    })
}

fn parse_bmp_header(bytes: &[u8]) -> Option<CanvasKitEncodedImageHeader> {
    if bytes.len() < 54 || &bytes[..2] != b"BM" {
        return None;
    }

    let dib_len = usize::try_from(read_le_u32(bytes, 14)?).ok()?;
    let dib_end = 14usize.checked_add(dib_len)?;
    if dib_len < 40 || dib_end > bytes.len() {
        return None;
    }
    let pixel_offset = usize::try_from(read_le_u32(bytes, 10)?).ok()?;
    if pixel_offset < dib_end || read_le_u16(bytes, 26)? != 1 {
        return None;
    }
    if !matches!(read_le_u16(bytes, 28)?, 1 | 4 | 8 | 16 | 24 | 32) {
        return None;
    }

    let width = read_le_i32(bytes, 18)?;
    let height = read_le_i32(bytes, 22)?;
    if width <= 0 || height == 0 || height == i32::MIN {
        return None;
    }

    Some(CanvasKitEncodedImageHeader {
        format: CanvasKitEncodedImageFormat::Bmp,
        width: width as u32,
        height: height.unsigned_abs(),
    })
}

fn parse_jpeg_header(bytes: &[u8]) -> Option<CanvasKitEncodedImageHeader> {
    if bytes.len() < 4 || !bytes.starts_with(b"\xff\xd8") {
        return None;
    }

    let mut offset = 2usize;
    while offset < bytes.len() {
        if bytes[offset] != 0xff {
            return None;
        }
        while offset < bytes.len() && bytes[offset] == 0xff {
            offset += 1;
        }
        let marker = *bytes.get(offset)?;
        offset += 1;

        if marker == 0x00 || matches!(marker, 0xd8..=0xda) {
            return None;
        }
        if marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }

        let segment_len = usize::from(read_be_u16(bytes, offset)?);
        if segment_len < 2 {
            return None;
        }
        let segment_end = offset.checked_add(segment_len)?;
        if segment_end > bytes.len() {
            return None;
        }

        let is_start_of_frame =
            (0xc0..=0xcf).contains(&marker) && !matches!(marker, 0xc4 | 0xc8 | 0xcc);
        if is_start_of_frame {
            if segment_len < 11 {
                return None;
            }
            let component_count = usize::from(*bytes.get(offset + 7)?);
            if component_count == 0
                || segment_len != 8usize.checked_add(component_count.checked_mul(3)?)?
            {
                return None;
            }
            let height = u32::from(read_be_u16(bytes, offset + 3)?);
            let width = u32::from(read_be_u16(bytes, offset + 5)?);
            if width == 0 || height == 0 {
                return None;
            }
            return Some(CanvasKitEncodedImageHeader {
                format: CanvasKitEncodedImageFormat::Jpeg,
                width,
                height,
            });
        }

        offset = segment_end;
    }
    None
}

fn read_be_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_be_bytes(
        bytes.get(offset..offset + 2)?.try_into().ok()?,
    ))
}

fn read_le_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_le_bytes(
        bytes.get(offset..offset + 2)?.try_into().ok()?,
    ))
}

fn read_be_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_be_bytes(
        bytes.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

fn read_le_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        bytes.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

fn read_le_i32(bytes: &[u8], offset: usize) -> Option<i32> {
    Some(i32::from_le_bytes(
        bytes.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

fn read_le_u24(bytes: &[u8], offset: usize) -> Option<u32> {
    let value = bytes.get(offset..offset + 3)?;
    Some(u32::from(value[0]) | (u32::from(value[1]) << 8) | (u32::from(value[2]) << 16))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = vec![0; 33];
        bytes[..8].copy_from_slice(PNG_SIGNATURE);
        bytes[8..12].copy_from_slice(&13u32.to_be_bytes());
        bytes[12..16].copy_from_slice(b"IHDR");
        bytes[16..20].copy_from_slice(&width.to_be_bytes());
        bytes[20..24].copy_from_slice(&height.to_be_bytes());
        bytes[24..29].copy_from_slice(&[8, 6, 0, 0, 0]);
        bytes
    }

    fn gif(width: u16, height: u16) -> Vec<u8> {
        let mut bytes = b"GIF89a".to_vec();
        bytes.extend_from_slice(&width.to_le_bytes());
        bytes.extend_from_slice(&height.to_le_bytes());
        bytes.extend_from_slice(&[0, 0, 0]);
        bytes
    }

    fn webp(chunk: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let padded_len = payload.len() + (payload.len() & 1);
        let mut bytes = Vec::with_capacity(20 + padded_len);
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&u32::try_from(12 + padded_len).unwrap().to_le_bytes());
        bytes.extend_from_slice(b"WEBP");
        bytes.extend_from_slice(chunk);
        bytes.extend_from_slice(&u32::try_from(payload.len()).unwrap().to_le_bytes());
        bytes.extend_from_slice(payload);
        if payload.len() & 1 != 0 {
            bytes.push(0);
        }
        bytes
    }

    fn bmp(width: i32, height: i32) -> Vec<u8> {
        let mut bytes = vec![0; 54];
        bytes[..2].copy_from_slice(b"BM");
        bytes[2..6].copy_from_slice(&54u32.to_le_bytes());
        bytes[10..14].copy_from_slice(&54u32.to_le_bytes());
        bytes[14..18].copy_from_slice(&40u32.to_le_bytes());
        bytes[18..22].copy_from_slice(&width.to_le_bytes());
        bytes[22..26].copy_from_slice(&height.to_le_bytes());
        bytes[26..28].copy_from_slice(&1u16.to_le_bytes());
        bytes[28..30].copy_from_slice(&24u16.to_le_bytes());
        bytes
    }

    fn jpeg(width: u16, height: u16) -> Vec<u8> {
        let mut bytes = b"\xff\xd8\xff\xe0\x00\x04\x00\x00\xff\xc0\x00\x0b\x08".to_vec();
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&[1, 1, 0x11, 0]);
        bytes
    }

    fn svg(root_attributes: &str) -> Vec<u8> {
        format!(
            "<?xml version=\"1.0\"?><!-- fixture --><svg xmlns=\"http://www.w3.org/2000/svg\" {root_attributes}><path d=\"M0 0h1v1z\"/></svg>"
        )
        .into_bytes()
    }

    #[test]
    fn parses_all_browser_admitted_encoded_image_headers() {
        let mut vp8x = [0u8; 10];
        vp8x[4..7].copy_from_slice(&319u32.to_le_bytes()[..3]);
        vp8x[7..10].copy_from_slice(&239u32.to_le_bytes()[..3]);
        let headers = [
            (png(320, 240), CanvasKitEncodedImageFormat::Png, (320, 240)),
            (gif(320, 240), CanvasKitEncodedImageFormat::Gif, (320, 240)),
            (
                webp(b"VP8X", &vp8x),
                CanvasKitEncodedImageFormat::WebP,
                (320, 240),
            ),
            (bmp(640, -480), CanvasKitEncodedImageFormat::Bmp, (640, 480)),
            (
                jpeg(300, 200),
                CanvasKitEncodedImageFormat::Jpeg,
                (300, 200),
            ),
            (
                svg("width=\"320\" height=\"240\""),
                CanvasKitEncodedImageFormat::Svg,
                (320, 240),
            ),
        ];

        for (bytes, format, dimensions) in headers {
            let header = canvaskit_encoded_image_header(&bytes).expect("valid encoded header");
            assert_eq!(header.format, format);
            assert_eq!((header.width, header.height), dimensions);
            assert!(header.is_within_decode_limits());
        }
    }

    #[test]
    fn parses_lossy_and_lossless_webp_headers() {
        let mut vp8 = [0u8; 10];
        vp8[3..6].copy_from_slice(b"\x9d\x01\x2a");
        vp8[6..8].copy_from_slice(&320u16.to_le_bytes());
        vp8[8..10].copy_from_slice(&240u16.to_le_bytes());
        let lossy = canvaskit_encoded_image_header(&webp(b"VP8 ", &vp8)).unwrap();
        assert_eq!((lossy.width, lossy.height), (320, 240));

        let width = 320u32;
        let height = 240u32;
        let bits = (width - 1) | ((height - 1) << 14);
        let mut vp8l = [0u8; 5];
        vp8l[0] = 0x2f;
        vp8l[1..5].copy_from_slice(&bits.to_le_bytes());
        let lossless = canvaskit_encoded_image_header(&webp(b"VP8L", &vp8l)).unwrap();
        assert_eq!((lossless.width, lossless.height), (width, height));
    }

    #[test]
    fn rejects_malformed_or_truncated_headers() {
        let valid = [
            png(1, 1),
            gif(1, 1),
            webp(b"VP8X", &[0; 10]),
            bmp(1, 1),
            jpeg(1, 1),
        ];
        for bytes in valid {
            assert!(canvaskit_encoded_image_header(&bytes).is_some());
            assert!(canvaskit_encoded_image_header(&bytes[..bytes.len() - 1]).is_none());
        }

        let mut malformed_png = png(1, 1);
        malformed_png[8..12].copy_from_slice(&12u32.to_be_bytes());
        assert!(canvaskit_encoded_image_header(&malformed_png).is_none());

        let mut malformed_gif = gif(1, 1);
        malformed_gif[10] = 0x80;
        assert!(canvaskit_encoded_image_header(&malformed_gif).is_none());

        let mut malformed_jpeg = jpeg(1, 1);
        malformed_jpeg[10..12].copy_from_slice(&u16::MAX.to_be_bytes());
        assert!(canvaskit_encoded_image_header(&malformed_jpeg).is_none());
    }

    #[test]
    fn reports_oversized_compact_headers_without_decoding() {
        let over_dimension = canvaskit_encoded_image_header(&png(8193, 1)).unwrap();
        assert!(!over_dimension.is_within_decode_limits());

        let over_pixels = canvaskit_encoded_image_header(&jpeg(8192, 8192)).unwrap();
        assert!(!over_pixels.is_within_decode_limits());
    }

    #[test]
    fn resolves_svg_intrinsic_dimensions_without_browser_layout() {
        let view_box = canvaskit_encoded_image_header(&svg("viewBox=\"0 0 640 360\"")).unwrap();
        assert_eq!(view_box.format, CanvasKitEncodedImageFormat::Svg);
        assert_eq!((view_box.width, view_box.height), (640, 360));

        let inferred_height =
            canvaskit_encoded_image_header(&svg("width=\"320px\" viewBox=\"0 0 16 9\"")).unwrap();
        assert_eq!((inferred_height.width, inferred_height.height), (320, 180));

        let relative =
            canvaskit_encoded_image_header(&svg("width=\"100%\" height=\"100%\"")).unwrap();
        assert_eq!((relative.width, relative.height), (300, 150));

        let physical_units =
            canvaskit_encoded_image_header(&svg("width=\"1in\" height=\"72pt\"")).unwrap();
        assert_eq!((physical_units.width, physical_units.height), (96, 96));
    }

    #[test]
    fn rejects_unsafe_or_invalid_svg_headers() {
        assert!(canvaskit_encoded_image_header(b"<!DOCTYPE svg><svg/>").is_none());
        assert!(canvaskit_encoded_image_header(b"<html/>").is_none());
        assert!(canvaskit_encoded_image_header(b"<svg width=\"0\" height=\"1\"/>").is_none());
        assert!(canvaskit_encoded_image_header(b"<svg viewBox=\"0 0 -1 1\"/>").is_none());
        assert!(canvaskit_encoded_image_header(b"<svg width=\"1em\" height=\"1\"/>").is_none());
        assert!(canvaskit_encoded_image_header(b"\xff<svg/>").is_none());

        let oversized =
            canvaskit_encoded_image_header(b"<svg width=\"8193\" height=\"1\"/>").unwrap();
        assert!(!oversized.is_within_decode_limits());
    }
}
