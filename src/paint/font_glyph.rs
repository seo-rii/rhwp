//! Producer-side lowering for font-native bitmap and SVG glyph resources.

use std::io::Read;

use flate2::read::GzDecoder;
use quick_xml::{events::Event, Reader};

use crate::paint::{
    BitmapAlphaMode, BitmapGlyphFiltering, BitmapGlyphPayload, BitmapGlyphScalingPolicy,
    BitmapStrikeSelection, GlyphRange, ImageResourceId, LayerAffineTransform, ResourceArena,
    SvgGlyphIntrinsicSize, SvgGlyphPayload, SvgGlyphSecurityMode, SvgGlyphViewBox, SvgResourceId,
    TextRunPlacement, TextSourceRange,
};

const MAX_STATIC_SVG_GLYPH_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct FontBitmapGlyphDecodeOptions {
    pub pixels_per_em: u16,
    pub source_range_utf8: TextSourceRange,
    pub glyph_range: GlyphRange,
    pub placement: TextRunPlacement,
    pub transform_to_run: Option<LayerAffineTransform>,
    pub color_space: Option<String>,
    pub scaling_policy: BitmapGlyphScalingPolicy,
    pub filtering: BitmapGlyphFiltering,
}

impl FontBitmapGlyphDecodeOptions {
    pub fn new(
        pixels_per_em: u16,
        source_range_utf8: TextSourceRange,
        glyph_range: GlyphRange,
        placement: TextRunPlacement,
    ) -> Self {
        Self {
            pixels_per_em,
            source_range_utf8,
            glyph_range,
            placement,
            transform_to_run: None,
            color_space: Some("sRGB".to_string()),
            scaling_policy: BitmapGlyphScalingPolicy::ExplicitTransform,
            filtering: BitmapGlyphFiltering::Linear,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FontBitmapGlyphDecodeError {
    FaceParseFailed,
    GlyphIdOutOfRange,
    InvalidRequestedPpem,
    MissingRasterGlyph,
    UnsupportedRasterFormat,
    InvalidRasterGeometry,
    InvalidPngData,
    InvalidPayloadContract,
}

impl FontBitmapGlyphDecodeError {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FaceParseFailed => "faceParseFailed",
            Self::GlyphIdOutOfRange => "glyphIdOutOfRange",
            Self::InvalidRequestedPpem => "invalidRequestedPpem",
            Self::MissingRasterGlyph => "missingRasterGlyph",
            Self::UnsupportedRasterFormat => "unsupportedRasterFormat",
            Self::InvalidRasterGeometry => "invalidRasterGeometry",
            Self::InvalidPngData => "invalidPngData",
            Self::InvalidPayloadContract => "invalidPayloadContract",
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub fn decode_font_bitmap_glyph_payload(
    font_data: &[u8],
    face_index: u32,
    glyph_id: u32,
    options: &FontBitmapGlyphDecodeOptions,
    resources: &mut ResourceArena,
) -> Result<BitmapGlyphPayload, FontBitmapGlyphDecodeError> {
    if glyph_id > u32::from(u16::MAX) {
        return Err(FontBitmapGlyphDecodeError::GlyphIdOutOfRange);
    }
    if options.pixels_per_em == 0 {
        return Err(FontBitmapGlyphDecodeError::InvalidRequestedPpem);
    }
    let face = ttf_parser::Face::parse(font_data, face_index)
        .map_err(|_| FontBitmapGlyphDecodeError::FaceParseFailed)?;
    let raster = face
        .glyph_raster_image(ttf_parser::GlyphId(glyph_id as u16), options.pixels_per_em)
        .ok_or(FontBitmapGlyphDecodeError::MissingRasterGlyph)?;
    if raster.format != ttf_parser::RasterImageFormat::PNG {
        return Err(FontBitmapGlyphDecodeError::UnsupportedRasterFormat);
    }
    if raster.width == 0 || raster.height == 0 || raster.pixels_per_em == 0 {
        return Err(FontBitmapGlyphDecodeError::InvalidRasterGeometry);
    }
    let decoded = image::load_from_memory_with_format(raster.data, image::ImageFormat::Png)
        .map_err(|_| FontBitmapGlyphDecodeError::InvalidPngData)?;
    if decoded.width() != u32::from(raster.width) || decoded.height() != u32::from(raster.height) {
        return Err(FontBitmapGlyphDecodeError::InvalidRasterGeometry);
    }

    let mut payload = BitmapGlyphPayload {
        image_resource_id: ImageResourceId(usize::MAX),
        source_range_utf8: Some(options.source_range_utf8),
        glyph_range: Some(options.glyph_range),
        placement: Some(options.placement),
        transform_to_run: options.transform_to_run,
        strike_ppem: Some((raster.pixels_per_em, raster.pixels_per_em)),
        strike_selection: Some(BitmapStrikeSelection::ProducerResolved),
        pixel_format: Some("rgba8".to_string()),
        color_space: options.color_space.clone(),
        alpha_mode: Some(BitmapAlphaMode::Straight),
        scaling_policy: Some(options.scaling_policy),
        filtering: Some(options.filtering),
    };
    if !payload.has_strict_visual_contract() {
        return Err(FontBitmapGlyphDecodeError::InvalidPayloadContract);
    }
    payload.image_resource_id = resources.intern_image_bytes(raster.data);
    Ok(payload)
}

#[derive(Debug, Clone, PartialEq)]
pub struct FontSvgGlyphDecodeOptions {
    pub source_range_utf8: TextSourceRange,
    pub glyph_range: GlyphRange,
    pub placement: TextRunPlacement,
    pub transform_to_run: Option<LayerAffineTransform>,
    pub intrinsic_size: Option<SvgGlyphIntrinsicSize>,
}

impl FontSvgGlyphDecodeOptions {
    pub fn new(
        source_range_utf8: TextSourceRange,
        glyph_range: GlyphRange,
        placement: TextRunPlacement,
    ) -> Self {
        Self {
            source_range_utf8,
            glyph_range,
            placement,
            transform_to_run: None,
            intrinsic_size: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FontSvgGlyphDecodeError {
    FaceParseFailed,
    GlyphIdOutOfRange,
    MissingSvgGlyph,
    SvgPayloadTooLarge,
    SvgDecompressionFailed,
    InvalidUtf8,
    UnsafeStaticSvg,
    InvalidSvgXml,
    MissingViewBox,
    InvalidViewBox,
    InvalidPayloadContract,
}

impl FontSvgGlyphDecodeError {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FaceParseFailed => "faceParseFailed",
            Self::GlyphIdOutOfRange => "glyphIdOutOfRange",
            Self::MissingSvgGlyph => "missingSvgGlyph",
            Self::SvgPayloadTooLarge => "svgPayloadTooLarge",
            Self::SvgDecompressionFailed => "svgDecompressionFailed",
            Self::InvalidUtf8 => "invalidUtf8",
            Self::UnsafeStaticSvg => "unsafeStaticSvg",
            Self::InvalidSvgXml => "invalidSvgXml",
            Self::MissingViewBox => "missingViewBox",
            Self::InvalidViewBox => "invalidViewBox",
            Self::InvalidPayloadContract => "invalidPayloadContract",
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub fn decode_font_svg_glyph_payload(
    font_data: &[u8],
    face_index: u32,
    glyph_id: u32,
    options: &FontSvgGlyphDecodeOptions,
    resources: &mut ResourceArena,
) -> Result<SvgGlyphPayload, FontSvgGlyphDecodeError> {
    if glyph_id > u32::from(u16::MAX) {
        return Err(FontSvgGlyphDecodeError::GlyphIdOutOfRange);
    }
    let face = ttf_parser::Face::parse(font_data, face_index)
        .map_err(|_| FontSvgGlyphDecodeError::FaceParseFailed)?;
    let document = face
        .glyph_svg_image(ttf_parser::GlyphId(glyph_id as u16))
        .ok_or(FontSvgGlyphDecodeError::MissingSvgGlyph)?;
    let svg_bytes = if document.data.starts_with(&[0x1f, 0x8b]) {
        let mut decoded = Vec::new();
        GzDecoder::new(document.data)
            .take((MAX_STATIC_SVG_GLYPH_BYTES + 1) as u64)
            .read_to_end(&mut decoded)
            .map_err(|_| FontSvgGlyphDecodeError::SvgDecompressionFailed)?;
        if decoded.len() > MAX_STATIC_SVG_GLYPH_BYTES {
            return Err(FontSvgGlyphDecodeError::SvgPayloadTooLarge);
        }
        decoded
    } else {
        if document.data.len() > MAX_STATIC_SVG_GLYPH_BYTES {
            return Err(FontSvgGlyphDecodeError::SvgPayloadTooLarge);
        }
        document.data.to_vec()
    };
    let fragment = std::str::from_utf8(&svg_bytes)
        .map_err(|_| FontSvgGlyphDecodeError::InvalidUtf8)?
        .trim();
    if !crate::renderer::static_svg::static_svg_fragment_has_path_layer(fragment) {
        return Err(FontSvgGlyphDecodeError::UnsafeStaticSvg);
    }

    let mut reader = Reader::from_str(fragment);
    reader.config_mut().trim_text(true);
    let mut view_box = None;
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) | Ok(Event::Empty(element)) => {
                if view_box.is_none() && element.name().as_ref().eq_ignore_ascii_case(b"svg") {
                    for attribute in element.attributes().with_checks(true) {
                        let attribute =
                            attribute.map_err(|_| FontSvgGlyphDecodeError::InvalidSvgXml)?;
                        if !attribute.key.as_ref().eq_ignore_ascii_case(b"viewBox") {
                            continue;
                        }
                        let value = std::str::from_utf8(attribute.value.as_ref())
                            .map_err(|_| FontSvgGlyphDecodeError::InvalidViewBox)?;
                        let values = value
                            .split(|character: char| {
                                character.is_ascii_whitespace() || character == ','
                            })
                            .filter(|token| !token.is_empty())
                            .map(str::parse::<f64>)
                            .collect::<Result<Vec<_>, _>>()
                            .map_err(|_| FontSvgGlyphDecodeError::InvalidViewBox)?;
                        if values.len() != 4
                            || values.iter().any(|value| !value.is_finite())
                            || values[2] <= 0.0
                            || values[3] <= 0.0
                        {
                            return Err(FontSvgGlyphDecodeError::InvalidViewBox);
                        }
                        view_box = Some(SvgGlyphViewBox {
                            x: values[0],
                            y: values[1],
                            width: values[2],
                            height: values[3],
                        });
                        break;
                    }
                }
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(_) => return Err(FontSvgGlyphDecodeError::InvalidSvgXml),
        }
    }
    let view_box = view_box.ok_or(FontSvgGlyphDecodeError::MissingViewBox)?;
    let mut payload = SvgGlyphPayload {
        vector_resource_id: SvgResourceId(usize::MAX),
        source_range_utf8: Some(options.source_range_utf8),
        glyph_range: Some(options.glyph_range),
        placement: Some(options.placement),
        transform_to_run: options.transform_to_run,
        view_box: Some(view_box),
        intrinsic_size: options.intrinsic_size,
        security_mode: SvgGlyphSecurityMode::StaticSanitized,
        script_allowed: false,
        animation_allowed: false,
        external_resources_allowed: false,
        interactivity_allowed: false,
    };
    if !payload.has_static_sanitized_contract() {
        return Err(FontSvgGlyphDecodeError::InvalidPayloadContract);
    }
    payload.vector_resource_id = resources.intern_svg_fragment(fragment);
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_font() -> &'static [u8] {
        include_bytes!("../../tests/fixtures/fonts/RHWPBitmapSvgGlyphSmoke.ttf")
    }

    fn fixture_glyph_id(character: char) -> u32 {
        let face = ttf_parser::Face::parse(fixture_font(), 0).expect("fixture font parses");
        u32::from(face.glyph_index(character).expect("fixture glyph exists").0)
    }

    fn placement() -> TextRunPlacement {
        TextRunPlacement {
            run_to_page: LayerAffineTransform {
                a: 1.0,
                b: 0.0,
                c: 0.0,
                d: 1.0,
                e: 12.0,
                f: 18.0,
            },
            baseline_y: 0.0,
        }
    }

    #[test]
    fn lowers_font_native_png_strike_into_strict_bitmap_payload() {
        let mut resources = ResourceArena::default();
        let payload = decode_font_bitmap_glyph_payload(
            fixture_font(),
            0,
            fixture_glyph_id('\u{E100}'),
            &FontBitmapGlyphDecodeOptions::new(
                16,
                TextSourceRange::new(0, 3),
                GlyphRange { start: 0, end: 1 },
                placement(),
            ),
            &mut resources,
        )
        .expect("font-native PNG strike lowers");

        assert!(payload.has_strict_visual_contract());
        assert_eq!(payload.image_resource_id, ImageResourceId(0));
        assert_eq!(payload.strike_ppem, Some((16, 16)));
        assert_eq!(payload.pixel_format.as_deref(), Some("rgba8"));
        assert_eq!(payload.alpha_mode, Some(BitmapAlphaMode::Straight));
        assert_eq!(resources.image_count(), 1);
        assert!(resources
            .image_bytes(payload.image_resource_id)
            .is_some_and(|bytes| bytes.starts_with(b"\x89PNG\r\n\x1a\n")));
    }

    #[test]
    fn bitmap_lowering_fails_closed_without_png_strike_or_deterministic_options() {
        let mut resources = ResourceArena::default();
        let missing = decode_font_bitmap_glyph_payload(
            fixture_font(),
            0,
            fixture_glyph_id('\u{E101}'),
            &FontBitmapGlyphDecodeOptions::new(
                16,
                TextSourceRange::new(0, 1),
                GlyphRange { start: 0, end: 1 },
                placement(),
            ),
            &mut resources,
        );
        assert_eq!(missing, Err(FontBitmapGlyphDecodeError::MissingRasterGlyph));

        let mut invalid = FontBitmapGlyphDecodeOptions::new(
            16,
            TextSourceRange::new(0, 1),
            GlyphRange { start: 0, end: 1 },
            placement(),
        );
        invalid.filtering = BitmapGlyphFiltering::BackendDefault;
        let invalid = decode_font_bitmap_glyph_payload(
            fixture_font(),
            0,
            fixture_glyph_id('\u{E100}'),
            &invalid,
            &mut resources,
        );
        assert_eq!(
            invalid,
            Err(FontBitmapGlyphDecodeError::InvalidPayloadContract)
        );
        assert_eq!(resources.image_count(), 0);
    }

    #[test]
    fn lowers_font_native_static_svg_into_strict_vector_payload() {
        let mut resources = ResourceArena::default();
        let payload = decode_font_svg_glyph_payload(
            fixture_font(),
            0,
            fixture_glyph_id('\u{E101}'),
            &FontSvgGlyphDecodeOptions::new(
                TextSourceRange::new(0, 3),
                GlyphRange { start: 0, end: 1 },
                placement(),
            ),
            &mut resources,
        )
        .expect("font-native static SVG lowers");

        assert!(payload.has_static_sanitized_contract());
        assert_eq!(payload.vector_resource_id, SvgResourceId(0));
        assert_eq!(
            payload.view_box,
            Some(SvgGlyphViewBox {
                x: 0.0,
                y: 0.0,
                width: 16.0,
                height: 16.0,
            })
        );
        assert_eq!(resources.svg_count(), 1);
        assert!(resources
            .svg_fragment(payload.vector_resource_id)
            .is_some_and(|fragment| fragment.contains("M2 2H14V14H2Z")));
    }

    #[test]
    fn svg_lowering_rejects_unsafe_font_document_without_interning_it() {
        let mut resources = ResourceArena::default();
        let result = decode_font_svg_glyph_payload(
            fixture_font(),
            0,
            fixture_glyph_id('\u{E102}'),
            &FontSvgGlyphDecodeOptions::new(
                TextSourceRange::new(0, 1),
                GlyphRange { start: 0, end: 1 },
                placement(),
            ),
            &mut resources,
        );

        assert_eq!(result, Err(FontSvgGlyphDecodeError::UnsafeStaticSvg));
        assert_eq!(resources.svg_count(), 0);
    }

    #[test]
    fn svg_lowering_rejects_malformed_static_markup() {
        let mut resources = ResourceArena::default();
        let result = decode_font_svg_glyph_payload(
            fixture_font(),
            0,
            fixture_glyph_id('\u{E103}'),
            &FontSvgGlyphDecodeOptions::new(
                TextSourceRange::new(0, 1),
                GlyphRange { start: 0, end: 1 },
                placement(),
            ),
            &mut resources,
        );

        assert_eq!(result, Err(FontSvgGlyphDecodeError::InvalidSvgXml));
        assert_eq!(resources.svg_count(), 0);
    }

    #[test]
    fn producer_errors_have_stable_diagnostic_names() {
        assert_eq!(
            FontBitmapGlyphDecodeError::UnsupportedRasterFormat.as_str(),
            "unsupportedRasterFormat"
        );
        assert_eq!(
            FontSvgGlyphDecodeError::UnsafeStaticSvg.as_str(),
            "unsafeStaticSvg"
        );
    }
}
