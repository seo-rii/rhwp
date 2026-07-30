//! Producer-side lowering for font-native bitmap and SVG glyph resources.

use std::io::Read;

use flate2::read::GzDecoder;
use quick_xml::{events::Event, Reader};

use crate::paint::{
    BitmapAlphaMode, BitmapGlyphFiltering, BitmapGlyphPayload, BitmapGlyphScalingPolicy,
    BitmapStrikeSelection, GlyphOutlinePayloadKind, GlyphRange, GlyphRunDiagnostics,
    GlyphRunReplayEligibility, ImageResourceId, LayerAffineTransform, LayerGlyphOutlinePaint,
    LayerNode, LayerNodeKind, PageLayerTree, PaintOp, PaintTextStyle, PaintVariantMeta,
    ResourceArena, SvgGlyphIntrinsicSize, SvgGlyphPayload, SvgGlyphSecurityMode, SvgGlyphViewBox,
    SvgResourceId, TextProjectionKind, TextRunPlacement, TextSourceRange, TextVariantKind,
    TextVariantQuality,
};

const MAX_STATIC_SVG_GLYPH_BYTES: usize = 1024 * 1024;
const MAX_BITMAP_GLYPH_BYTES: usize = 4 * 1024 * 1024;
const MAX_BITMAP_GLYPH_PIXELS: u64 = 4096 * 4096;
const MAX_FONT_NATIVE_SOURCE_BYTES: usize = 32 * 1024 * 1024;
const MAX_FONT_NATIVE_SIDECARS_PER_PAGE: usize = 128;
const MAX_FONT_NATIVE_ENCODED_BYTES_PER_PAGE: usize = 8 * 1024 * 1024;
const MAX_FONT_NATIVE_DECODED_PIXELS_PER_PAGE: u64 = 32 * 1024 * 1024;

fn png_dimensions(data: &[u8]) -> Option<(u32, u32)> {
    const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    if data.len() < 24
        || &data[..8] != PNG_SIGNATURE
        || &data[12..16] != b"IHDR"
        || u32::from_be_bytes(data[8..12].try_into().ok()?) != 13
    {
        return None;
    }
    Some((
        u32::from_be_bytes(data[16..20].try_into().ok()?),
        u32::from_be_bytes(data[20..24].try_into().ok()?),
    ))
}

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
    SourceFontTooLarge,
    FaceParseFailed,
    GlyphIdOutOfRange,
    InvalidRequestedPpem,
    MissingRasterGlyph,
    UnsupportedRasterFormat,
    InvalidRasterGeometry,
    PayloadTooLarge,
    InvalidPngData,
    InvalidPayloadContract,
}

impl FontBitmapGlyphDecodeError {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SourceFontTooLarge => "sourceFontTooLarge",
            Self::FaceParseFailed => "faceParseFailed",
            Self::GlyphIdOutOfRange => "glyphIdOutOfRange",
            Self::InvalidRequestedPpem => "invalidRequestedPpem",
            Self::MissingRasterGlyph => "missingRasterGlyph",
            Self::UnsupportedRasterFormat => "unsupportedRasterFormat",
            Self::InvalidRasterGeometry => "invalidRasterGeometry",
            Self::PayloadTooLarge => "payloadTooLarge",
            Self::InvalidPngData => "invalidPngData",
            Self::InvalidPayloadContract => "invalidPayloadContract",
        }
    }
}

pub fn decode_font_bitmap_glyph_payload(
    font_data: &[u8],
    face_index: u32,
    glyph_id: u32,
    options: &FontBitmapGlyphDecodeOptions,
    resources: &mut ResourceArena,
) -> Result<BitmapGlyphPayload, FontBitmapGlyphDecodeError> {
    if font_data.len() > MAX_FONT_NATIVE_SOURCE_BYTES {
        return Err(FontBitmapGlyphDecodeError::SourceFontTooLarge);
    }
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
    if raster.data.len() > MAX_BITMAP_GLYPH_BYTES {
        return Err(FontBitmapGlyphDecodeError::PayloadTooLarge);
    }
    let (encoded_width, encoded_height) =
        png_dimensions(raster.data).ok_or(FontBitmapGlyphDecodeError::InvalidPngData)?;
    if encoded_width == 0
        || encoded_height == 0
        || u64::from(encoded_width) * u64::from(encoded_height) > MAX_BITMAP_GLYPH_PIXELS
    {
        return Err(FontBitmapGlyphDecodeError::PayloadTooLarge);
    }
    if encoded_width != u32::from(raster.width) || encoded_height != u32::from(raster.height) {
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
    SourceFontTooLarge,
    FaceParseFailed,
    GlyphIdOutOfRange,
    MissingSvgGlyph,
    SharedSvgDocument,
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
            Self::SourceFontTooLarge => "sourceFontTooLarge",
            Self::FaceParseFailed => "faceParseFailed",
            Self::GlyphIdOutOfRange => "glyphIdOutOfRange",
            Self::MissingSvgGlyph => "missingSvgGlyph",
            Self::SharedSvgDocument => "sharedSvgDocument",
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

pub fn decode_font_svg_glyph_payload(
    font_data: &[u8],
    face_index: u32,
    glyph_id: u32,
    options: &FontSvgGlyphDecodeOptions,
    resources: &mut ResourceArena,
) -> Result<SvgGlyphPayload, FontSvgGlyphDecodeError> {
    if font_data.len() > MAX_FONT_NATIVE_SOURCE_BYTES {
        return Err(FontSvgGlyphDecodeError::SourceFontTooLarge);
    }
    if glyph_id > u32::from(u16::MAX) {
        return Err(FontSvgGlyphDecodeError::GlyphIdOutOfRange);
    }
    let face = ttf_parser::Face::parse(font_data, face_index)
        .map_err(|_| FontSvgGlyphDecodeError::FaceParseFailed)?;
    let document = face
        .glyph_svg_image(ttf_parser::GlyphId(glyph_id as u16))
        .ok_or(FontSvgGlyphDecodeError::MissingSvgGlyph)?;
    if document.start_glyph_id != document.end_glyph_id {
        return Err(FontSvgGlyphDecodeError::SharedSvgDocument);
    }
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
    if !crate::renderer::static_svg::static_svg_fragment_has_path_layer(fragment) {
        return Err(FontSvgGlyphDecodeError::UnsafeStaticSvg);
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

#[derive(Debug, Clone, Copy)]
pub struct EmbeddedFontFace<'a> {
    pub char_shape_id: u32,
    pub language_index: usize,
    pub family: &'a str,
    pub alternate_family: Option<&'a str>,
    pub bytes: &'a [u8],
    pub face_index: u32,
}

pub fn resolve_embedded_font_face_index(
    bytes: &[u8],
    family: &str,
    alternate_family: Option<&str>,
) -> Option<u32> {
    const MAX_COLLECTION_FACES: u32 = 256;
    if bytes.len() > MAX_FONT_NATIVE_SOURCE_BYTES {
        return None;
    }
    let face_count = ttf_parser::fonts_in_collection(bytes).unwrap_or(1);
    if face_count == 0 || face_count > MAX_COLLECTION_FACES {
        return None;
    }
    if face_count == 1 {
        ttf_parser::Face::parse(bytes, 0).ok()?;
        return Some(0);
    }

    let matches = (0..face_count)
        .filter(|face_index| {
            ttf_parser::Face::parse(bytes, *face_index)
                .ok()
                .is_some_and(|face| {
                    face.names().into_iter().any(|name| {
                        matches!(
                            name.name_id,
                            ttf_parser::name_id::FAMILY
                                | ttf_parser::name_id::TYPOGRAPHIC_FAMILY
                                | ttf_parser::name_id::WWS_FAMILY
                        ) && name.to_string().is_some_and(|value| {
                            value.eq_ignore_ascii_case(family)
                                || alternate_family
                                    .is_some_and(|family| value.eq_ignore_ascii_case(family))
                        })
                    })
                })
        })
        .collect::<Vec<_>>();
    (matches.len() == 1).then(|| matches[0])
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FontGlyphLoweringReport {
    pub attempted_runs: usize,
    pub emitted_bitmap_glyphs: usize,
    pub emitted_svg_glyphs: usize,
    pub rejected_runs: usize,
}

pub fn lower_font_native_glyph_sidecars(
    tree: &mut PageLayerTree,
    fonts: &[EmbeddedFontFace<'_>],
) -> FontGlyphLoweringReport {
    let mut lowerer = FontGlyphLowerer {
        resources: &mut tree.resources,
        variant_ops: &mut tree.variant_ops,
        fonts,
        emitted_sidecars: 0,
        encoded_resource_bytes: 0,
        decoded_resource_pixels: 0,
        report: FontGlyphLoweringReport::default(),
    };
    lowerer.lower_node(&tree.root);
    lowerer.report
}

struct FontGlyphLowerer<'a, 'font> {
    resources: &'a mut ResourceArena,
    variant_ops: &'a mut Vec<PaintOp>,
    fonts: &'a [EmbeddedFontFace<'font>],
    emitted_sidecars: usize,
    encoded_resource_bytes: usize,
    decoded_resource_pixels: u64,
    report: FontGlyphLoweringReport,
}

impl FontGlyphLowerer<'_, '_> {
    fn lower_node(&mut self, node: &LayerNode) {
        match &node.kind {
            LayerNodeKind::Group { children, .. } => {
                for child in children {
                    self.lower_node(child);
                }
            }
            LayerNodeKind::ClipRect { child, .. } => self.lower_node(child),
            LayerNodeKind::Leaf { ops, .. } => self.lower_leaf(ops),
        }
    }

    fn lower_leaf(&mut self, ops: &[PaintOp]) {
        for op in ops {
            if let PaintOp::TextRun { bbox, run } = op {
                if let Some(sidecar) = self.lower_text_run(run) {
                    self.variant_ops.push(PaintOp::GlyphOutline {
                        bbox: *bbox,
                        outline: Box::new(sidecar),
                    });
                }
            }
        }
    }

    fn lower_text_run(
        &mut self,
        run: &crate::paint::LayerTextRunPaint,
    ) -> Option<LayerGlyphOutlinePaint> {
        let mut characters = run.text.chars();
        let character = characters.next()?;
        if characters.next().is_some()
            || run.display_text.is_some()
            || run.projection != TextProjectionKind::Verbatim
            || run.char_overlap.is_some()
            || !run.style.font_size.is_finite()
            || run.style.font_size <= 0.0
            || !run.rotation.is_finite()
            || run.rotation.abs() > f64::EPSILON
            || run.is_vertical
            || run.style.bold
            || run.style.italic
            || !run.style.ratio.is_finite()
            || (run.style.ratio - 1.0).abs() > f64::EPSILON
            || self.emitted_sidecars >= MAX_FONT_NATIVE_SIDECARS_PER_PAGE
        {
            return None;
        }
        let paint_style = PaintTextStyle::from(&run.style);
        if !paint_style.is_fill_only_glyph_replay() {
            return None;
        }
        let source = run.source.clone()?;
        let fallback_variant = run.variant.as_ref()?;
        let placement = run.placement?;
        if fallback_variant.variant_kind != TextVariantKind::TextRun
            || !fallback_variant.is_default_fallback
        {
            return None;
        }

        let font_slot = run.font_slot?;
        let font = self.fonts.iter().find(|font| {
            font.char_shape_id == font_slot.char_shape_id
                && font.language_index == usize::from(font_slot.language_index)
        })?;
        self.report.attempted_runs += 1;
        if font.bytes.len() > MAX_FONT_NATIVE_SOURCE_BYTES {
            self.report.rejected_runs += 1;
            return None;
        }
        let face = match ttf_parser::Face::parse(font.bytes, font.face_index) {
            Ok(face) => face,
            Err(_) => {
                self.report.rejected_runs += 1;
                return None;
            }
        };
        let glyph_id = match face.glyph_index(character) {
            Some(glyph_id) => u32::from(glyph_id.0),
            None => {
                self.report.rejected_runs += 1;
                return None;
            }
        };
        let glyph_range = GlyphRange::new(0, 1);
        let pixels_per_em = run.style.font_size.round().clamp(1.0, f64::from(u16::MAX)) as u16;

        let bitmap_options = FontBitmapGlyphDecodeOptions::new(
            pixels_per_em,
            source.utf8_range,
            glyph_range,
            placement,
        );
        let bitmap = self.try_bitmap(font, glyph_id, &bitmap_options);
        let svg = if bitmap.is_none() {
            let svg_options =
                FontSvgGlyphDecodeOptions::new(source.utf8_range, glyph_range, placement);
            self.try_svg(font, glyph_id, &svg_options)
        } else {
            None
        };
        let payload_kind = if bitmap.is_some() {
            self.report.emitted_bitmap_glyphs += 1;
            GlyphOutlinePayloadKind::BitmapGlyph
        } else if svg.is_some() {
            self.report.emitted_svg_glyphs += 1;
            GlyphOutlinePayloadKind::SvgGlyph
        } else {
            self.report.rejected_runs += 1;
            return None;
        };
        self.emitted_sidecars += 1;

        let mut variant =
            PaintVariantMeta::text_run_default(fallback_variant.equivalence_group.clone());
        variant.variant_id = "glyphOutline".to_string();
        variant.variant_kind = TextVariantKind::GlyphOutline;
        variant.is_default_fallback = false;
        variant.requires = vec![format!("text.glyphOutline.{}", payload_kind.as_str())];
        variant.quality = Some(TextVariantQuality::Exact);
        variant.anchor_op_id = Some(fallback_variant.stable_op_id());
        variant.local_paint_order = Some(0);

        Some(LayerGlyphOutlinePaint {
            source,
            variant,
            payload_kind,
            stroke: None,
            color_layers: None,
            bitmap_glyph: bitmap,
            svg_glyph: svg,
            paint_style,
            placement,
            paths: Vec::new(),
            diagnostics: GlyphRunDiagnostics {
                quality: TextVariantQuality::Exact,
                replay_eligibility: GlyphRunReplayEligibility::Portable,
                strict_visual_eligible: true,
                max_origin_delta_px: 0.0,
                max_advance_delta_px: 0.0,
                max_residual_after_adjustment_px: 0.0,
                cluster_mismatch_count: 0,
                missing_glyph_count: 0,
                used_fallback_font_count: 0,
                reason: Some("fontNativeGlyphPayload".to_string()),
            },
        })
    }

    fn try_bitmap(
        &mut self,
        font: &EmbeddedFontFace<'_>,
        glyph_id: u32,
        options: &FontBitmapGlyphDecodeOptions,
    ) -> Option<BitmapGlyphPayload> {
        let mut scratch = ResourceArena::default();
        let mut payload = decode_font_bitmap_glyph_payload(
            font.bytes,
            font.face_index,
            glyph_id,
            options,
            &mut scratch,
        )
        .ok()?;
        let bytes = scratch.image_bytes(payload.image_resource_id)?;
        let (width, height) = png_dimensions(bytes)?;
        let decoded_pixels = u64::from(width) * u64::from(height);
        if !self.page_budget_allows(bytes.len(), decoded_pixels) {
            return None;
        }
        payload.image_resource_id = self.resources.intern_image_bytes(bytes);
        self.encoded_resource_bytes += bytes.len();
        self.decoded_resource_pixels += decoded_pixels;
        Some(payload)
    }

    fn try_svg(
        &mut self,
        font: &EmbeddedFontFace<'_>,
        glyph_id: u32,
        options: &FontSvgGlyphDecodeOptions,
    ) -> Option<SvgGlyphPayload> {
        let mut scratch = ResourceArena::default();
        let mut payload = decode_font_svg_glyph_payload(
            font.bytes,
            font.face_index,
            glyph_id,
            options,
            &mut scratch,
        )
        .ok()?;
        let fragment = scratch.svg_fragment(payload.vector_resource_id)?;
        if !self.page_budget_allows(fragment.len(), 0) {
            return None;
        }
        payload.vector_resource_id = self.resources.intern_svg_fragment(fragment);
        self.encoded_resource_bytes += fragment.len();
        Some(payload)
    }

    fn page_budget_allows(&self, encoded_bytes: usize, decoded_pixels: u64) -> bool {
        self.encoded_resource_bytes
            .checked_add(encoded_bytes)
            .is_some_and(|total| total <= MAX_FONT_NATIVE_ENCODED_BYTES_PER_PAGE)
            && self
                .decoded_resource_pixels
                .checked_add(decoded_pixels)
                .is_some_and(|total| total <= MAX_FONT_NATIVE_DECODED_PIXELS_PER_PAGE)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paint::{LayerTextRunPaint, PageLayerTree};
    use crate::renderer::render_tree::BoundingBox;
    use crate::renderer::TextStyle;

    fn fixture_font() -> &'static [u8] {
        include_bytes!("../../tests/fixtures/fonts/RHWPBitmapSvgGlyphSmoke.ttf")
    }

    fn fixture_glyph_id(character: char) -> u32 {
        let face = ttf_parser::Face::parse(fixture_font(), 0).expect("fixture font parses");
        u32::from(face.glyph_index(character).expect("fixture glyph exists").0)
    }

    fn fixture_ttc() -> &'static [u8] {
        include_bytes!("../../tests/fixtures/fonts/RHWPExactFaceSmoke.ttc")
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

    fn assigned_text_tree(text: &str, style: TextStyle) -> PageLayerTree {
        let bbox = BoundingBox::new(10.0, 20.0, 16.0, 16.0);
        let root = LayerNode::leaf(
            bbox,
            Some(1),
            vec![PaintOp::TextRun {
                bbox,
                run: LayerTextRunPaint {
                    font_slot: Some(crate::paint::TextFontSlot {
                        char_shape_id: 7,
                        language_index: 0,
                    }),
                    text: text.to_string(),
                    style,
                    positions: vec![0.0, 16.0],
                    baseline: 12.0,
                    ..LayerTextRunPaint::default()
                },
            }],
        );
        PageLayerTree::new(100.0, 100.0, root)
    }

    fn fixture_embedded_font(char_shape_id: u32) -> EmbeddedFontFace<'static> {
        EmbeddedFontFace {
            char_shape_id,
            language_index: 0,
            family: "RHWP Bitmap SVG Glyph Smoke",
            alternate_family: None,
            bytes: fixture_font(),
            face_index: 0,
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
    fn bitmap_lowering_rejects_oversized_png_header_before_decode() {
        let mut font = fixture_font().to_vec();
        let png_offset = font
            .windows(8)
            .position(|window| window == b"\x89PNG\r\n\x1a\n")
            .expect("fixture embeds PNG data");
        font[png_offset + 16..png_offset + 20].copy_from_slice(&5_000u32.to_be_bytes());
        font[png_offset + 20..png_offset + 24].copy_from_slice(&5_000u32.to_be_bytes());
        let mut resources = ResourceArena::default();

        let result = decode_font_bitmap_glyph_payload(
            &font,
            0,
            fixture_glyph_id('\u{E100}'),
            &FontBitmapGlyphDecodeOptions::new(
                16,
                TextSourceRange::new(0, 1),
                GlyphRange::new(0, 1),
                placement(),
            ),
            &mut resources,
        );

        assert_eq!(result, Err(FontBitmapGlyphDecodeError::PayloadTooLarge));
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
    fn collection_face_resolution_requires_one_exact_family_match() {
        assert_eq!(
            resolve_embedded_font_face_index(fixture_ttc(), "RHWP Exact Face One", None),
            Some(1)
        );
        assert_eq!(
            resolve_embedded_font_face_index(fixture_ttc(), "Missing Family", None),
            None
        );
    }

    #[test]
    fn lowering_uses_char_shape_slot_and_preserves_text_fallback() {
        let mut tree = assigned_text_tree(
            "\u{E100}",
            TextStyle {
                font_family: "unrelated CSS fallback".to_string(),
                font_size: 16.0,
                ..TextStyle::default()
            },
        );
        let report = lower_font_native_glyph_sidecars(&mut tree, &[fixture_embedded_font(7)]);

        assert_eq!(report.emitted_bitmap_glyphs, 1);
        let LayerNodeKind::Leaf { ops, .. } = &tree.root.kind else {
            panic!("expected leaf");
        };
        let [PaintOp::TextRun { run, .. }] = ops.as_slice() else {
            panic!("expected only the root TextRun fallback");
        };
        let [PaintOp::GlyphOutline { outline, .. }] = tree.variant_ops.as_slice() else {
            panic!("expected GlyphOutline in variantOps");
        };
        assert_eq!(
            outline.source,
            run.source.clone().expect("source assignment remains")
        );
        assert_eq!(outline.variant.anchor_op_id.as_deref(), Some("op-text-0"));
        assert_eq!(outline.payload_kind, GlyphOutlinePayloadKind::BitmapGlyph);
        assert_eq!(tree.resources.image_count(), 1);
        assert_eq!(tree.resources.font_blob_count(), 0);
        assert!(tree.resources.font_resources().blobs.is_empty());
        assert!(tree.resources.font_resources().faces.is_empty());
    }

    #[test]
    fn lowering_keeps_projected_text_as_text_run_only() {
        let mut tree = assigned_text_tree(
            "\u{E100}",
            TextStyle {
                font_size: 16.0,
                ..TextStyle::default()
            },
        );
        let LayerNodeKind::Leaf { ops, .. } = &mut tree.root.kind else {
            panic!("expected leaf");
        };
        let PaintOp::TextRun { run, .. } = &mut ops[0] else {
            panic!("expected text run");
        };
        run.display_text = Some("한".to_string());

        let report = lower_font_native_glyph_sidecars(&mut tree, &[fixture_embedded_font(7)]);

        assert_eq!(report.emitted_bitmap_glyphs, 0);
        assert_eq!(report.emitted_svg_glyphs, 0);
        assert!(tree.variant_ops.is_empty());
    }

    #[test]
    fn lowering_uses_svg_when_the_font_has_no_bitmap_strike() {
        let mut tree = assigned_text_tree(
            "\u{E101}",
            TextStyle {
                font_size: 16.0,
                ..TextStyle::default()
            },
        );
        let report = lower_font_native_glyph_sidecars(&mut tree, &[fixture_embedded_font(7)]);

        assert_eq!(report.emitted_svg_glyphs, 1);
        let LayerNodeKind::Leaf { ops, .. } = &tree.root.kind else {
            panic!("expected leaf");
        };
        assert!(matches!(ops.as_slice(), [PaintOp::TextRun { .. }]));
        let PaintOp::GlyphOutline { outline, .. } = &tree.variant_ops[0] else {
            panic!("expected SVG glyph sidecar");
        };
        assert_eq!(outline.payload_kind, GlyphOutlinePayloadKind::SvgGlyph);
        assert!(outline.svg_glyph.is_some());
        assert_eq!(tree.resources.svg_count(), 1);
        assert_eq!(tree.resources.font_blob_count(), 0);
    }

    #[test]
    fn lowering_uses_the_resolved_language_slot_for_neutral_private_use_text() {
        let mut tree = assigned_text_tree(
            "\u{E100}",
            TextStyle {
                font_size: 16.0,
                ..TextStyle::default()
            },
        );
        let LayerNodeKind::Leaf { ops, .. } = &mut tree.root.kind else {
            panic!("expected leaf");
        };
        let PaintOp::TextRun { run, .. } = &mut ops[0] else {
            panic!("expected text run");
        };
        run.font_slot = Some(crate::paint::TextFontSlot {
            char_shape_id: 7,
            language_index: 6,
        });
        let mut font = fixture_embedded_font(7);
        font.language_index = 6;

        let report = lower_font_native_glyph_sidecars(&mut tree, &[font]);

        assert_eq!(report.emitted_bitmap_glyphs, 1);
        assert!(matches!(
            tree.variant_ops.as_slice(),
            [PaintOp::GlyphOutline { .. }]
        ));
    }

    #[test]
    fn lowering_does_not_match_css_family_without_a_char_shape_slot() {
        let mut tree = assigned_text_tree(
            "\u{E100}",
            TextStyle {
                font_family: "RHWP Bitmap SVG Glyph Smoke".to_string(),
                font_size: 16.0,
                ..TextStyle::default()
            },
        );
        let LayerNodeKind::Leaf { ops, .. } = &mut tree.root.kind else {
            panic!("expected leaf");
        };
        let PaintOp::TextRun { run, .. } = &mut ops[0] else {
            panic!("expected text run");
        };
        run.font_slot = None;
        let report = lower_font_native_glyph_sidecars(&mut tree, &[fixture_embedded_font(7)]);

        assert_eq!(report, FontGlyphLoweringReport::default());
        let LayerNodeKind::Leaf { ops, .. } = &tree.root.kind else {
            panic!("expected leaf");
        };
        assert!(matches!(ops.as_slice(), [PaintOp::TextRun { .. }]));
        assert!(tree.variant_ops.is_empty());
    }

    #[test]
    fn unsupported_run_styles_keep_only_the_text_fallback() {
        for case in [
            "bold", "italic", "vertical", "rotation", "ratio", "outline", "shadow", "shade",
        ] {
            let mut style = TextStyle {
                font_size: 16.0,
                ..TextStyle::default()
            };
            let mut tree = assigned_text_tree("\u{E100}", style.clone());
            let LayerNodeKind::Leaf { ops, .. } = &mut tree.root.kind else {
                panic!("expected leaf");
            };
            let PaintOp::TextRun { run, .. } = &mut ops[0] else {
                panic!("expected text run");
            };
            match case {
                "bold" => run.style.bold = true,
                "italic" => run.style.italic = true,
                "vertical" => run.is_vertical = true,
                "rotation" => run.rotation = 90.0,
                "ratio" => run.style.ratio = 0.8,
                "outline" => run.style.outline_type = 1,
                "shadow" => run.style.shadow_type = 1,
                "shade" => run.style.shade_color = 0,
                _ => unreachable!(),
            }
            style = run.style.clone();
            let report = lower_font_native_glyph_sidecars(&mut tree, &[fixture_embedded_font(7)]);

            assert_eq!(
                report.emitted_bitmap_glyphs, 0,
                "case={case}, style={:?}",
                style
            );
            let LayerNodeKind::Leaf { ops, .. } = &tree.root.kind else {
                panic!("expected leaf");
            };
            assert!(
                matches!(ops.as_slice(), [PaintOp::TextRun { .. }]),
                "case={case}"
            );
            assert!(tree.variant_ops.is_empty(), "case={case}");
        }
    }

    #[test]
    fn oversized_source_font_is_rejected_before_parsing_or_interning() {
        let mut oversized = fixture_font().to_vec();
        oversized.resize(MAX_FONT_NATIVE_SOURCE_BYTES + 1, 0);
        assert_eq!(
            resolve_embedded_font_face_index(&oversized, "fixture family", None),
            None
        );

        let mut resources = ResourceArena::default();
        let result = decode_font_bitmap_glyph_payload(
            &oversized,
            0,
            fixture_glyph_id('\u{E100}'),
            &FontBitmapGlyphDecodeOptions::new(
                16,
                TextSourceRange::new(0, 1),
                GlyphRange::new(0, 1),
                placement(),
            ),
            &mut resources,
        );
        assert_eq!(result, Err(FontBitmapGlyphDecodeError::SourceFontTooLarge));
        assert_eq!(resources.image_count(), 0);
        assert_eq!(resources.font_blob_count(), 0);
    }

    #[test]
    fn lowering_enforces_the_page_sidecar_budget() {
        let bbox = BoundingBox::new(0.0, 0.0, 16.0, 16.0);
        let ops = (0..MAX_FONT_NATIVE_SIDECARS_PER_PAGE + 1)
            .map(|_| PaintOp::TextRun {
                bbox,
                run: LayerTextRunPaint {
                    font_slot: Some(crate::paint::TextFontSlot {
                        char_shape_id: 7,
                        language_index: 0,
                    }),
                    text: "\u{E100}".to_string(),
                    display_text: None,
                    style: TextStyle {
                        font_size: 16.0,
                        ..TextStyle::default()
                    },
                    positions: vec![0.0, 16.0],
                    baseline: 12.0,
                    ..LayerTextRunPaint::default()
                },
            })
            .collect();
        let mut tree = PageLayerTree::new(100.0, 100.0, LayerNode::leaf(bbox, Some(1), ops));
        let report = lower_font_native_glyph_sidecars(&mut tree, &[fixture_embedded_font(7)]);

        assert_eq!(
            report.emitted_bitmap_glyphs,
            MAX_FONT_NATIVE_SIDECARS_PER_PAGE
        );
        assert_eq!(
            tree.variant_ops
                .iter()
                .filter(|op| matches!(op, PaintOp::GlyphOutline { .. }))
                .count(),
            MAX_FONT_NATIVE_SIDECARS_PER_PAGE
        );
        assert_eq!(tree.resources.image_count(), 1);
        assert_eq!(tree.resources.font_blob_count(), 0);
    }

    #[test]
    fn page_payload_budget_checks_encoded_bytes_and_decoded_pixels() {
        let mut resources = ResourceArena::default();
        let mut variant_ops = Vec::new();
        let fonts = [];
        let lowerer = FontGlyphLowerer {
            resources: &mut resources,
            variant_ops: &mut variant_ops,
            fonts: &fonts,
            emitted_sidecars: 0,
            encoded_resource_bytes: MAX_FONT_NATIVE_ENCODED_BYTES_PER_PAGE,
            decoded_resource_pixels: MAX_FONT_NATIVE_DECODED_PIXELS_PER_PAGE,
            report: FontGlyphLoweringReport::default(),
        };

        assert!(lowerer.page_budget_allows(0, 0));
        assert!(!lowerer.page_budget_allows(1, 0));
        assert!(!lowerer.page_budget_allows(0, 1));
    }

    #[test]
    fn producer_errors_have_stable_diagnostic_names() {
        assert_eq!(
            FontBitmapGlyphDecodeError::SourceFontTooLarge.as_str(),
            "sourceFontTooLarge"
        );
        assert_eq!(
            FontBitmapGlyphDecodeError::UnsupportedRasterFormat.as_str(),
            "unsupportedRasterFormat"
        );
        assert_eq!(
            FontSvgGlyphDecodeError::UnsafeStaticSvg.as_str(),
            "unsafeStaticSvg"
        );
        assert_eq!(
            FontSvgGlyphDecodeError::SharedSvgDocument.as_str(),
            "sharedSvgDocument"
        );
    }
}
