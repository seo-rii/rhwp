//! Producer-side helpers for strict color glyph payloads.
//!
//! These helpers decode font-native color glyph tables into the schema-v2
//! normalized payload shape. The output is a portable visual payload: consumers
//! replay resolved paths and colors and do not need to re-interpret COLR/CPAL.

use crate::paint::resources::RESOURCE_KEY_ALGORITHM;
use crate::paint::{
    ColorGlyphFormat, ColorLayerNode, ColorLayersPayload, FontColorGlyphRef, GlyphOutlineFillRule,
    GlyphRange, LayerAffineTransform, PaletteRef, ResolvedColor, TextSourceRange,
};
use crate::renderer::PathCommand;

#[derive(Debug, Clone, PartialEq)]
pub struct Colrv0ColorLayersDecodeOptions {
    pub face_key: Option<String>,
    pub palette_index: u16,
    pub source_range_utf8: TextSourceRange,
    pub glyph_range: GlyphRange,
    pub color_space: Option<String>,
    pub foreground_color: ResolvedColor,
    pub transform_to_run: Option<LayerAffineTransform>,
}

impl Colrv0ColorLayersDecodeOptions {
    pub fn new(source_range_utf8: TextSourceRange, glyph_range: GlyphRange) -> Self {
        Self {
            face_key: None,
            palette_index: 0,
            source_range_utf8,
            glyph_range,
            color_space: Some("sRGB".to_string()),
            foreground_color: ResolvedColor {
                color_space: Some("sRGB".to_string()),
                rgba: [0.0, 0.0, 0.0, 1.0],
            },
            transform_to_run: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Colrv0ColorLayersDecodeError {
    FaceParseFailed,
    GlyphIdOutOfRange,
    MissingColrTable,
    MissingCpalTable,
    UnsupportedColrVersion,
    MissingBaseGlyph,
    InvalidLayerRange,
    MissingPalette,
    MissingLayerOutline,
    EmptyLayerOutline,
}

impl Colrv0ColorLayersDecodeError {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FaceParseFailed => "faceParseFailed",
            Self::GlyphIdOutOfRange => "glyphIdOutOfRange",
            Self::MissingColrTable => "missingColrTable",
            Self::MissingCpalTable => "missingCpalTable",
            Self::UnsupportedColrVersion => "unsupportedColrVersion",
            Self::MissingBaseGlyph => "missingBaseGlyph",
            Self::InvalidLayerRange => "invalidLayerRange",
            Self::MissingPalette => "missingPalette",
            Self::MissingLayerOutline => "missingLayerOutline",
            Self::EmptyLayerOutline => "emptyLayerOutline",
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub fn decode_colrv0_color_layers_payload(
    font_data: &[u8],
    face_index: u32,
    base_glyph_id: u32,
    options: &Colrv0ColorLayersDecodeOptions,
) -> Result<ColorLayersPayload, Colrv0ColorLayersDecodeError> {
    if base_glyph_id > u32::from(u16::MAX) {
        return Err(Colrv0ColorLayersDecodeError::GlyphIdOutOfRange);
    }

    let face = ttf_parser::Face::parse(font_data, face_index)
        .map_err(|_| Colrv0ColorLayersDecodeError::FaceParseFailed)?;
    let colr = face
        .raw_face()
        .table(ttf_parser::Tag::from_bytes(b"COLR"))
        .ok_or(Colrv0ColorLayersDecodeError::MissingColrTable)?;
    let cpal_data = face
        .raw_face()
        .table(ttf_parser::Tag::from_bytes(b"CPAL"))
        .ok_or(Colrv0ColorLayersDecodeError::MissingCpalTable)?;

    let colr = ParsedColrV0::parse(colr)?;
    let cpal = ParsedCpal::parse(cpal_data)?;
    let base = colr
        .base_glyph(base_glyph_id as u16)
        .ok_or(Colrv0ColorLayersDecodeError::MissingBaseGlyph)?;
    let layer_records = colr.layers(base)?;

    let mut layers = Vec::with_capacity(layer_records.len());
    for (index, layer) in layer_records.iter().enumerate() {
        let mut builder = TtfOutlineBuilder::default();
        if face
            .outline_glyph(ttf_parser::GlyphId(layer.glyph_id), &mut builder)
            .is_none()
        {
            return Err(Colrv0ColorLayersDecodeError::MissingLayerOutline);
        }
        if builder.commands.is_empty() {
            return Err(Colrv0ColorLayersDecodeError::EmptyLayerOutline);
        }

        let fill = if layer.palette_index == u16::MAX {
            options.foreground_color.clone()
        } else {
            cpal.color(options.palette_index, layer.palette_index)
                .map(|color| resolved_color(color, options.color_space.as_deref()))
                .ok_or(Colrv0ColorLayersDecodeError::MissingPalette)?
        };

        layers.push(ColorLayerNode {
            layer_index: Some(index as u32),
            glyph_id: Some(u32::from(layer.glyph_id)),
            glyph_range: Some(options.glyph_range),
            source_range_utf8: Some(options.source_range_utf8),
            source_font_ref: Some(FontColorGlyphRef {
                face_key: options.face_key.clone(),
                glyph_id: Some(u32::from(layer.glyph_id)),
                palette_index: Some(layer.palette_index),
                color_format: Some(ColorGlyphFormat::ColrV0),
            }),
            path_index: Some(index as u32),
            commands: Some(builder.commands),
            fill: Some(fill),
            fill_rule: Some(GlyphOutlineFillRule::NonZero),
            palette_index: Some(layer.palette_index),
            color: cpal
                .color(options.palette_index, layer.palette_index)
                .map(color_ref_from_bgra),
            opacity: Some(1.0),
            transform_to_run: options.transform_to_run,
        });
    }

    Ok(ColorLayersPayload {
        color_format: ColorGlyphFormat::ColrV0,
        source_font_ref: Some(FontColorGlyphRef {
            face_key: options.face_key.clone(),
            glyph_id: Some(base_glyph_id),
            palette_index: Some(options.palette_index),
            color_format: Some(ColorGlyphFormat::ColrV0),
        }),
        palette_ref: Some(PaletteRef {
            id: None,
            index: Some(options.palette_index),
            cpal_digest: Some(format!(
                "{}:{}",
                RESOURCE_KEY_ALGORITHM,
                crate::paint::resource_digest_hex(cpal_data)
            )),
        }),
        layers,
        paint_graph: None,
        source_range_utf8: Some(options.source_range_utf8),
        glyph_range: Some(options.glyph_range),
    })
}

#[derive(Clone, Copy)]
struct ColrBaseGlyph {
    first_layer_index: u16,
    num_layers: u16,
}

#[derive(Clone, Copy)]
struct ColrLayerRecord {
    glyph_id: u16,
    palette_index: u16,
}

struct ParsedColrV0<'a> {
    data: &'a [u8],
    base_glyphs_offset: usize,
    num_base_glyphs: u16,
    layers_offset: usize,
    num_layers: u16,
}

impl<'a> ParsedColrV0<'a> {
    fn parse(data: &'a [u8]) -> Result<Self, Colrv0ColorLayersDecodeError> {
        let version = read_u16(data, 0).ok_or(Colrv0ColorLayersDecodeError::MissingColrTable)?;
        if version != 0 {
            return Err(Colrv0ColorLayersDecodeError::UnsupportedColrVersion);
        }
        let num_base_glyphs =
            read_u16(data, 2).ok_or(Colrv0ColorLayersDecodeError::MissingColrTable)?;
        let base_glyphs_offset =
            read_u32(data, 4).ok_or(Colrv0ColorLayersDecodeError::MissingColrTable)? as usize;
        let layers_offset =
            read_u32(data, 8).ok_or(Colrv0ColorLayersDecodeError::MissingColrTable)? as usize;
        let num_layers =
            read_u16(data, 12).ok_or(Colrv0ColorLayersDecodeError::MissingColrTable)?;
        Ok(Self {
            data,
            base_glyphs_offset,
            num_base_glyphs,
            layers_offset,
            num_layers,
        })
    }

    fn base_glyph(&self, glyph_id: u16) -> Option<ColrBaseGlyph> {
        for index in 0..self.num_base_glyphs {
            let offset = self
                .base_glyphs_offset
                .checked_add(usize::from(index) * 6)?;
            if read_u16(self.data, offset)? != glyph_id {
                continue;
            }
            return Some(ColrBaseGlyph {
                first_layer_index: read_u16(self.data, offset + 2)?,
                num_layers: read_u16(self.data, offset + 4)?,
            });
        }
        None
    }

    fn layers(
        &self,
        base: ColrBaseGlyph,
    ) -> Result<Vec<ColrLayerRecord>, Colrv0ColorLayersDecodeError> {
        let end = base
            .first_layer_index
            .checked_add(base.num_layers)
            .ok_or(Colrv0ColorLayersDecodeError::InvalidLayerRange)?;
        if end > self.num_layers {
            return Err(Colrv0ColorLayersDecodeError::InvalidLayerRange);
        }
        let mut layers = Vec::with_capacity(usize::from(base.num_layers));
        for index in base.first_layer_index..end {
            let offset = self
                .layers_offset
                .checked_add(usize::from(index) * 4)
                .ok_or(Colrv0ColorLayersDecodeError::InvalidLayerRange)?;
            layers.push(ColrLayerRecord {
                glyph_id: read_u16(self.data, offset)
                    .ok_or(Colrv0ColorLayersDecodeError::InvalidLayerRange)?,
                palette_index: read_u16(self.data, offset + 2)
                    .ok_or(Colrv0ColorLayersDecodeError::InvalidLayerRange)?,
            });
        }
        Ok(layers)
    }
}

struct ParsedCpal<'a> {
    data: &'a [u8],
    num_palette_entries: u16,
    num_palettes: u16,
    num_color_records: u16,
    offset_first_color_record: usize,
    color_record_indices_offset: usize,
}

impl<'a> ParsedCpal<'a> {
    fn parse(data: &'a [u8]) -> Result<Self, Colrv0ColorLayersDecodeError> {
        let num_palette_entries =
            read_u16(data, 2).ok_or(Colrv0ColorLayersDecodeError::MissingCpalTable)?;
        let num_palettes =
            read_u16(data, 4).ok_or(Colrv0ColorLayersDecodeError::MissingCpalTable)?;
        let num_color_records =
            read_u16(data, 6).ok_or(Colrv0ColorLayersDecodeError::MissingCpalTable)?;
        let offset_first_color_record =
            read_u32(data, 8).ok_or(Colrv0ColorLayersDecodeError::MissingCpalTable)? as usize;
        Ok(Self {
            data,
            num_palette_entries,
            num_palettes,
            num_color_records,
            offset_first_color_record,
            color_record_indices_offset: 12,
        })
    }

    fn color(&self, palette_index: u16, palette_entry: u16) -> Option<BgraColor> {
        if palette_index >= self.num_palettes || palette_entry >= self.num_palette_entries {
            return None;
        }
        let palette_record_offset = self
            .color_record_indices_offset
            .checked_add(usize::from(palette_index) * 2)?;
        let first_color_index = read_u16(self.data, palette_record_offset)?;
        let color_index = first_color_index.checked_add(palette_entry)?;
        if color_index >= self.num_color_records {
            return None;
        }
        let color_offset = self
            .offset_first_color_record
            .checked_add(usize::from(color_index) * 4)?;
        Some(BgraColor {
            blue: *self.data.get(color_offset)?,
            green: *self.data.get(color_offset + 1)?,
            red: *self.data.get(color_offset + 2)?,
            alpha: *self.data.get(color_offset + 3)?,
        })
    }
}

#[derive(Clone, Copy)]
struct BgraColor {
    blue: u8,
    green: u8,
    red: u8,
    alpha: u8,
}

fn resolved_color(color: BgraColor, color_space: Option<&str>) -> ResolvedColor {
    ResolvedColor {
        color_space: Some(color_space.unwrap_or("sRGB").to_string()),
        rgba: [
            f32::from(color.red) / 255.0,
            f32::from(color.green) / 255.0,
            f32::from(color.blue) / 255.0,
            f32::from(color.alpha) / 255.0,
        ],
    }
}

fn color_ref_from_bgra(color: BgraColor) -> u32 {
    (u32::from(color.blue) << 16) | (u32::from(color.green) << 8) | u32::from(color.red)
}

#[derive(Default)]
struct TtfOutlineBuilder {
    commands: Vec<PathCommand>,
    current: Option<(f64, f64)>,
}

impl TtfOutlineBuilder {
    fn current_or(&self, x: f64, y: f64) -> (f64, f64) {
        self.current.unwrap_or((x, y))
    }
}

impl ttf_parser::OutlineBuilder for TtfOutlineBuilder {
    fn move_to(&mut self, x: f32, y: f32) {
        let point = (f64::from(x), f64::from(y));
        self.commands.push(PathCommand::MoveTo(point.0, point.1));
        self.current = Some(point);
    }

    fn line_to(&mut self, x: f32, y: f32) {
        let point = (f64::from(x), f64::from(y));
        self.commands.push(PathCommand::LineTo(point.0, point.1));
        self.current = Some(point);
    }

    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        let control = (f64::from(x1), f64::from(y1));
        let end = (f64::from(x), f64::from(y));
        let start = self.current_or(end.0, end.1);
        let c1 = (
            start.0 + (2.0 / 3.0) * (control.0 - start.0),
            start.1 + (2.0 / 3.0) * (control.1 - start.1),
        );
        let c2 = (
            end.0 + (2.0 / 3.0) * (control.0 - end.0),
            end.1 + (2.0 / 3.0) * (control.1 - end.1),
        );
        self.commands
            .push(PathCommand::CurveTo(c1.0, c1.1, c2.0, c2.1, end.0, end.1));
        self.current = Some(end);
    }

    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        let end = (f64::from(x), f64::from(y));
        self.commands.push(PathCommand::CurveTo(
            f64::from(x1),
            f64::from(y1),
            f64::from(x2),
            f64::from(y2),
            end.0,
            end.1,
        ));
        self.current = Some(end);
    }

    fn close(&mut self) {
        self.commands.push(PathCommand::ClosePath);
        self.current = None;
    }
}

fn read_u16(data: &[u8], offset: usize) -> Option<u16> {
    let bytes = data.get(offset..offset.checked_add(2)?)?;
    Some(u16::from_be_bytes([bytes[0], bytes[1]]))
}

fn read_u32(data: &[u8], offset: usize) -> Option<u32> {
    let bytes = data.get(offset..offset.checked_add(4)?)?;
    Some(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_font() -> &'static [u8] {
        include_bytes!("../../tests/fixtures/fonts/RHWPColorSmokeCOLRv0.ttf")
    }

    fn fixture_color_glyph_id(font: &[u8]) -> u32 {
        let face = ttf_parser::Face::parse(font, 0).expect("fixture font parses");
        u32::from(face.glyph_index('\u{E000}').expect("fixture color glyph").0)
    }

    fn sfnt_table_record_offset(font: &[u8], tag: &[u8; 4]) -> usize {
        let num_tables = read_u16(font, 4).expect("sfnt table count") as usize;
        for index in 0..num_tables {
            let offset = 12 + index * 16;
            if font.get(offset..offset + 4) == Some(tag) {
                return offset;
            }
        }
        panic!("fixture contains table record");
    }

    fn sfnt_table_range(font: &[u8], tag: &[u8; 4]) -> (usize, usize) {
        let record_offset = sfnt_table_record_offset(font, tag);
        let offset = read_u32(font, record_offset + 8).expect("table offset") as usize;
        let length = read_u32(font, record_offset + 12).expect("table length") as usize;
        (offset, length)
    }

    fn replace_table_tag(font: &[u8], tag: &[u8; 4], replacement: &[u8; 4]) -> Vec<u8> {
        let offset = sfnt_table_record_offset(font, tag);
        let mut patched = font.to_vec();
        patched[offset..offset + tag.len()].copy_from_slice(replacement);
        patched
    }

    fn write_u16_be(bytes: &mut [u8], offset: usize, value: u16) {
        bytes[offset..offset + 2].copy_from_slice(&value.to_be_bytes());
    }

    fn colrv0_base_record_offset(font: &[u8], glyph_id: u32) -> usize {
        let (colr_offset, colr_len) = sfnt_table_range(font, b"COLR");
        let colr_data = &font[colr_offset..colr_offset + colr_len];
        let num_base_glyphs = read_u16(colr_data, 2).expect("COLR base glyph count");
        let base_glyphs_offset =
            read_u32(colr_data, 4).expect("COLR base glyph records offset") as usize;
        for index in 0..num_base_glyphs {
            let record = colr_offset + base_glyphs_offset + usize::from(index) * 6;
            if read_u16(font, record).map(u32::from) == Some(glyph_id) {
                return record;
            }
        }
        panic!("fixture contains base glyph record");
    }

    fn first_layer_record_offset(font: &[u8], glyph_id: u32) -> usize {
        let (colr_offset, colr_len) = sfnt_table_range(font, b"COLR");
        let colr_data = &font[colr_offset..colr_offset + colr_len];
        let colr = ParsedColrV0::parse(colr_data).expect("fixture COLRv0 table parses");
        let base = colr
            .base_glyph(glyph_id as u16)
            .expect("fixture contains COLRv0 base glyph");
        colr_offset + colr.layers_offset + usize::from(base.first_layer_index) * 4
    }

    #[test]
    fn decodes_colrv0_fixture_to_resolved_color_layers() {
        let font = fixture_font();
        let glyph_id = fixture_color_glyph_id(font);
        let transform = LayerAffineTransform {
            a: 1.0,
            b: 0.0,
            c: 0.0,
            d: 1.0,
            e: 2.0,
            f: 3.0,
        };
        let mut options =
            Colrv0ColorLayersDecodeOptions::new(TextSourceRange::new(0, 3), GlyphRange::new(0, 1));
        options.face_key = Some("color-smoke-face".to_string());
        options.color_space = Some("display-p3".to_string());
        options.transform_to_run = Some(transform);

        let payload = decode_colrv0_color_layers_payload(font, 0, glyph_id, &options)
            .expect("fixture COLRv0 payload decodes");

        assert_eq!(payload.color_format, ColorGlyphFormat::ColrV0);
        assert!(payload.has_colrv0_resolved_layer_contract());
        assert!(payload.layers.len() >= 2);
        assert_eq!(
            payload
                .source_font_ref
                .as_ref()
                .and_then(|source| source.glyph_id),
            Some(glyph_id)
        );
        assert_eq!(
            payload
                .palette_ref
                .as_ref()
                .and_then(|palette| palette.index),
            Some(0)
        );
        assert!(payload
            .palette_ref
            .as_ref()
            .and_then(|palette| palette.cpal_digest.as_deref())
            .is_some_and(|digest| digest.starts_with("blake3:")));
        assert!(payload.layers.iter().all(|layer| {
            layer
                .source_font_ref
                .as_ref()
                .and_then(|source| source.color_format)
                == Some(ColorGlyphFormat::ColrV0)
        }));
        assert!(payload.layers.iter().all(|layer| {
            layer.transform_to_run == Some(transform)
                && layer
                    .fill
                    .as_ref()
                    .and_then(|fill| fill.color_space.as_deref())
                    == Some("display-p3")
        }));
        assert!(payload.layers.iter().any(|layer| {
            layer
                .fill
                .as_ref()
                .is_some_and(|fill| fill.rgba[0] > fill.rgba[2])
        }));
    }

    #[test]
    fn rejects_non_colr_base_glyph() {
        let font = fixture_font();
        let options =
            Colrv0ColorLayersDecodeOptions::new(TextSourceRange::new(0, 1), GlyphRange::new(0, 1));

        let error = decode_colrv0_color_layers_payload(font, 0, 1, &options)
            .expect_err("glyph 1 is not a COLRv0 base glyph");

        assert_eq!(error, Colrv0ColorLayersDecodeError::MissingBaseGlyph);
        assert_eq!(error.as_str(), "missingBaseGlyph");
    }

    #[test]
    fn rejects_unparseable_font_before_table_lookup() {
        let options =
            Colrv0ColorLayersDecodeOptions::new(TextSourceRange::new(0, 1), GlyphRange::new(0, 1));

        let error = decode_colrv0_color_layers_payload(b"not-a-font", 0, 0, &options)
            .expect_err("invalid font should not be treated as a color glyph");

        assert_eq!(error, Colrv0ColorLayersDecodeError::FaceParseFailed);
        assert_eq!(error.as_str(), "faceParseFailed");
    }

    #[test]
    fn rejects_glyph_ids_outside_colrv0_backend_range() {
        let options =
            Colrv0ColorLayersDecodeOptions::new(TextSourceRange::new(0, 1), GlyphRange::new(0, 1));

        let error = decode_colrv0_color_layers_payload(
            b"not-needed-for-range-guard",
            0,
            u32::from(u16::MAX) + 1,
            &options,
        )
        .expect_err("COLRv0 glyph ids are table u16 values");

        assert_eq!(error, Colrv0ColorLayersDecodeError::GlyphIdOutOfRange);
        assert_eq!(error.as_str(), "glyphIdOutOfRange");
    }

    #[test]
    fn rejects_missing_colr_and_cpal_tables() {
        let font = fixture_font();
        let glyph_id = fixture_color_glyph_id(font);
        let options =
            Colrv0ColorLayersDecodeOptions::new(TextSourceRange::new(0, 1), GlyphRange::new(0, 1));

        let missing_colr = replace_table_tag(font, b"COLR", b"XXXX");
        let missing_cpal = replace_table_tag(font, b"CPAL", b"YYYY");

        let colr_error = decode_colrv0_color_layers_payload(&missing_colr, 0, glyph_id, &options)
            .expect_err("COLR table is required for COLRv0 decoding");
        let cpal_error = decode_colrv0_color_layers_payload(&missing_cpal, 0, glyph_id, &options)
            .expect_err("CPAL table is required for COLRv0 decoding");

        assert_eq!(colr_error, Colrv0ColorLayersDecodeError::MissingColrTable);
        assert_eq!(cpal_error, Colrv0ColorLayersDecodeError::MissingCpalTable);
    }

    #[test]
    fn rejects_unsupported_colr_versions() {
        let font = fixture_font();
        let glyph_id = fixture_color_glyph_id(font);
        let options =
            Colrv0ColorLayersDecodeOptions::new(TextSourceRange::new(0, 1), GlyphRange::new(0, 1));
        let (colr_offset, _) = sfnt_table_range(font, b"COLR");
        let mut patched = font.to_vec();
        write_u16_be(&mut patched, colr_offset, 1);

        let error = decode_colrv0_color_layers_payload(&patched, 0, glyph_id, &options)
            .expect_err("COLRv1 tables are not decoded by the COLRv0 helper");

        assert_eq!(error, Colrv0ColorLayersDecodeError::UnsupportedColrVersion);
        assert_eq!(error.as_str(), "unsupportedColrVersion");
    }

    #[test]
    fn rejects_invalid_colrv0_layer_ranges() {
        let font = fixture_font();
        let glyph_id = fixture_color_glyph_id(font);
        let options =
            Colrv0ColorLayersDecodeOptions::new(TextSourceRange::new(0, 1), GlyphRange::new(0, 1));
        let base_record = colrv0_base_record_offset(font, glyph_id);
        let mut patched = font.to_vec();
        write_u16_be(&mut patched, base_record + 4, u16::MAX);

        let error = decode_colrv0_color_layers_payload(&patched, 0, glyph_id, &options)
            .expect_err("base glyph layer range must stay inside layer records");

        assert_eq!(error, Colrv0ColorLayersDecodeError::InvalidLayerRange);
        assert_eq!(error.as_str(), "invalidLayerRange");
    }

    #[test]
    fn rejects_layers_without_decodable_outlines() {
        let font = fixture_font();
        let glyph_id = fixture_color_glyph_id(font);
        let options =
            Colrv0ColorLayersDecodeOptions::new(TextSourceRange::new(0, 1), GlyphRange::new(0, 1));
        let first_layer_record = first_layer_record_offset(font, glyph_id);
        let mut patched = font.to_vec();
        write_u16_be(&mut patched, first_layer_record, u16::MAX);

        let error = decode_colrv0_color_layers_payload(&patched, 0, glyph_id, &options)
            .expect_err("layer glyph must have a decodable outline");

        assert_eq!(error, Colrv0ColorLayersDecodeError::MissingLayerOutline);
        assert_eq!(error.as_str(), "missingLayerOutline");
    }

    #[test]
    fn resolves_colrv0_foreground_palette_layers_from_options() {
        let font = fixture_font();
        let glyph_id = fixture_color_glyph_id(font);
        let first_layer_record = first_layer_record_offset(font, glyph_id);
        let mut patched = font.to_vec();
        write_u16_be(&mut patched, first_layer_record + 2, u16::MAX);
        let mut options =
            Colrv0ColorLayersDecodeOptions::new(TextSourceRange::new(0, 1), GlyphRange::new(0, 1));
        options.foreground_color = ResolvedColor {
            color_space: Some("display-p3".to_string()),
            rgba: [0.25, 0.5, 0.75, 0.8],
        };

        let payload = decode_colrv0_color_layers_payload(&patched, 0, glyph_id, &options)
            .expect("foreground COLRv0 layer resolves from options");
        let foreground_layer = payload
            .layers
            .iter()
            .find(|layer| layer.palette_index == Some(u16::MAX))
            .expect("patched layer uses foreground palette sentinel");

        assert_eq!(foreground_layer.fill, Some(options.foreground_color));
        assert_eq!(foreground_layer.color, None);
        assert!(payload.has_colrv0_resolved_layer_contract());
    }

    #[test]
    fn rejects_missing_palette_for_resolved_strict_layers() {
        let font = fixture_font();
        let glyph_id = fixture_color_glyph_id(font);
        let mut options =
            Colrv0ColorLayersDecodeOptions::new(TextSourceRange::new(0, 1), GlyphRange::new(0, 1));
        options.palette_index = u16::MAX;

        let error = decode_colrv0_color_layers_payload(font, 0, glyph_id, &options)
            .expect_err("producer must resolve all CPAL palette colors");

        assert_eq!(error, Colrv0ColorLayersDecodeError::MissingPalette);
        assert_eq!(error.as_str(), "missingPalette");
    }
}
