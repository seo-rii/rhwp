use skia_safe::{
    font_arguments::{variation_position, VariationPosition},
    gradient_shader::{Gradient, GradientColors, Interpolation as GradientInterpolation},
    shaders, surfaces, Canvas, Color, Color4f, EncodedImageFormat, Font, FontArguments, FontMgr,
    FourByteTag, Matrix, Paint, PathBuilder, PictureRecorder, Point, Rect, Shaper, TileMode,
    Typeface,
};
use std::cell::RefCell;
use std::time::{Duration, Instant};

use crate::model::image::ImageEffect;
use crate::paint::{
    layer_node_has_replay_plane, paint_op_replay_plane, sidecars_for_leaf_ops, CacheHint,
    GlyphOutlineFillRule, GlyphOutlinePayloadKind, GlyphRunOrientation, GlyphRunReplayEligibility,
    LayerAffineTransform, LayerGlyphOutlinePaint, LayerGlyphRunPaint, LayerNode, LayerNodeKind,
    PageLayerTree, PaintOp, PaintReplayPlane, ResourceArena, TextRunPlacement, TextVariantQuality,
};
use crate::renderer::layer_renderer::{
    select_text_variant_sets_with_report, should_render_selected_text_variant, LayerRasterRenderer,
    LayerRenderError, LayerRenderResult, RasterOutputFormat, RasterRenderOptions,
    RasterRenderOutput, VariantFontVerificationReport, VariantOutlineEligibilityReport,
    VariantRejectReason, VariantReplayStatus, VariantSelectionBackend, VariantSelectionContext,
};
use crate::renderer::render_tree::BoundingBox;
use crate::renderer::static_svg::static_svg_fragment_has_path_layer;
use crate::renderer::{ArrowStyle, LineRenderType};

use super::cache::StaticPictureCache;
use super::cache_key::StaticSubtreeCacheKey;
use super::equation_conv::render_equation_with_resolver;
use super::font_resolver::SkiaFontResolver;
use super::form_replay;
use super::image_conv::{
    decode_image_bytes, draw_decoded_image, draw_decoded_image_with_crop_reference,
    draw_missing_image_placeholder, embedded_svg_intrinsic_size,
    rasterize_svg_fragment_with_view_box, ImageSampling,
};
use super::paint_conv::{
    colorref_to_skia, make_background_fill_paint, make_fill_paint, make_font, make_line_paint,
    make_stroke_paint,
};
use super::path_conv::to_skia_path;
use super::replay_context::SkiaReplayContext;

pub struct SkiaLayerRenderer {
    pub(super) font_mgr: FontMgr,
    pub(super) font_resolver: SkiaFontResolver,
    pub(super) text_shaper: Shaper,
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

fn duration_ns(duration: Duration) -> u64 {
    duration.as_nanos().min(u128::from(u64::MAX)) as u64
}

fn native_skia_glyph_run_replay_status(
    run: &LayerGlyphRunPaint,
    resources: &ResourceArena,
    font_mgr: &FontMgr,
) -> VariantReplayStatus {
    if run.glyph_ids.is_empty()
        || run.glyph_ids.len() != run.positions.len()
        || run
            .advances
            .as_ref()
            .is_some_and(|advances| advances.len() != run.glyph_ids.len())
        || run.glyph_transforms.is_some()
        || run.orientation == GlyphRunOrientation::MixedPerGlyph
    {
        return VariantReplayStatus::rejected(VariantRejectReason::VariantUnsupported);
    }
    if run.diagnostics.replay_eligibility != GlyphRunReplayEligibility::Portable {
        return VariantReplayStatus::rejected(VariantRejectReason::FontNotPortable);
    }
    if !run.diagnostics.strict_visual_eligible {
        return VariantReplayStatus::rejected(VariantRejectReason::VariantUnsupported);
    }
    if run.diagnostics.missing_glyph_count != 0 {
        return VariantReplayStatus::rejected(VariantRejectReason::MissingGlyph);
    }
    if run.diagnostics.cluster_mismatch_count != 0 {
        return VariantReplayStatus::rejected(VariantRejectReason::ClusterMismatch);
    }
    if !matches!(
        run.diagnostics.quality,
        TextVariantQuality::Exact | TextVariantQuality::PositionAdjusted
    ) {
        return VariantReplayStatus::rejected(VariantRejectReason::VariantUnsupported);
    }
    if run.diagnostics.quality == TextVariantQuality::PositionAdjusted {
        let tolerance = 0.5_f64.min(0.25_f64.max(run.paint_style.font_size * 0.005));
        if !run.diagnostics.max_residual_after_adjustment_px.is_finite()
            || run.diagnostics.max_residual_after_adjustment_px > tolerance
        {
            return VariantReplayStatus::rejected(
                VariantRejectReason::PositionAdjustedResidualTooLarge,
            );
        }
    }
    let ratio = if run.paint_style.ratio > 0.0 {
        run.paint_style.ratio
    } else {
        1.0
    };
    if (ratio - 1.0).abs() > 0.001
        || !run.paint_style.tab_leaders.is_empty()
        || run.paint_style.underline != crate::model::style::UnderlineType::None
        || run.paint_style.strikethrough
        || run.paint_style.superscript
        || run.paint_style.subscript
        || run.paint_style.emphasis_dot != 0
        || (run.paint_style.shade_color & 0x00FF_FFFF) != 0x00FF_FFFF
    {
        return VariantReplayStatus::rejected(VariantRejectReason::UnsupportedPaintEffect);
    }
    let transform = run.placement.run_to_page;
    if ![
        transform.a,
        transform.b,
        transform.c,
        transform.d,
        transform.e,
        transform.f,
        run.placement.baseline_y,
    ]
    .into_iter()
    .all(f64::is_finite)
        || !run
            .positions
            .iter()
            .all(|position| position.x.is_finite() && position.y.is_finite())
    {
        return VariantReplayStatus::rejected(VariantRejectReason::VariantUnsupported);
    }
    if run
        .glyph_ids
        .iter()
        .any(|glyph_id| *glyph_id > u16::MAX as u32)
    {
        return VariantReplayStatus::rejected(VariantRejectReason::GlyphIdOutOfRange);
    }
    let font_resources = resources.font_resources();
    let Some(face) = font_resources
        .faces
        .iter()
        .find(|face| face.id == run.shape_key.font_instance.face_key)
    else {
        return VariantReplayStatus::rejected(VariantRejectReason::ExactFaceUnavailable);
    };
    let Some(blob) = font_resources
        .blobs
        .iter()
        .find(|blob| blob.id == face.blob_key)
    else {
        return VariantReplayStatus::rejected(VariantRejectReason::ExactFaceUnavailable);
    };
    if !blob.portability.is_self_contained_replayable() {
        return VariantReplayStatus::rejected(VariantRejectReason::FontNotPortable);
    }
    match native_skia_font_blob_bytes(resources, blob) {
        NativeSkiaFontBlobBytes::Resolved { .. } => {
            return native_skia_exact_typeface_replay_status(run, resources, font_mgr, face, blob);
        }
        NativeSkiaFontBlobBytes::DigestMismatch => {
            return native_skia_exact_font_rejection(
                run,
                face,
                blob,
                VariantRejectReason::ExactFaceUnavailable,
                None,
                None,
                true,
                Some(false),
            );
        }
        NativeSkiaFontBlobBytes::Missing => {}
    }
    if face.face_index != 0 || !run.shape_key.font_instance.variations.is_empty() {
        return native_skia_exact_typeface_replay_status(run, resources, font_mgr, face, blob);
    }
    VariantReplayStatus::replayable()
}

fn native_skia_exact_typeface_replay_status(
    run: &LayerGlyphRunPaint,
    resources: &ResourceArena,
    font_mgr: &FontMgr,
    face: &crate::paint::FontFaceResource,
    blob: &crate::paint::FontBlobResource,
) -> VariantReplayStatus {
    match native_skia_exact_typeface_for_glyph_run(run, resources, font_mgr, face, blob) {
        Ok((_, digest_matched)) => {
            let mut status = VariantReplayStatus::replayable();
            status.font_verification = Some(native_skia_font_verification_report(
                run,
                face,
                blob,
                true,
                digest_matched,
                Some(true),
                if run.shape_key.font_instance.variations.is_empty() {
                    None
                } else {
                    Some(true)
                },
                true,
                None,
            ));
            status
        }
        Err(status) => status,
    }
}

#[allow(clippy::result_large_err)]
fn native_skia_exact_typeface_for_glyph_run(
    run: &LayerGlyphRunPaint,
    resources: &ResourceArena,
    font_mgr: &FontMgr,
    face: &crate::paint::FontFaceResource,
    blob: &crate::paint::FontBlobResource,
) -> Result<(Typeface, Option<bool>), VariantReplayStatus> {
    let (bytes, digest_matched) = match native_skia_font_blob_bytes(resources, blob) {
        NativeSkiaFontBlobBytes::Resolved {
            bytes,
            digest_matched,
        } => (bytes, digest_matched),
        NativeSkiaFontBlobBytes::DigestMismatch => {
            return Err(native_skia_exact_font_rejection(
                run,
                face,
                blob,
                VariantRejectReason::ExactFaceUnavailable,
                if !run.shape_key.font_instance.variations.is_empty() {
                    Some(false)
                } else {
                    None
                },
                if face.face_index != 0 {
                    Some(false)
                } else {
                    None
                },
                true,
                Some(false),
            ));
        }
        NativeSkiaFontBlobBytes::Missing => {
            let reason = if !run.shape_key.font_instance.variations.is_empty() {
                VariantRejectReason::VariationUnsupported
            } else if face.face_index != 0 {
                VariantRejectReason::FaceIndexUnsupported
            } else {
                VariantRejectReason::ExactFaceUnavailable
            };
            return Err(native_skia_exact_font_rejection(
                run,
                face,
                blob,
                reason,
                if !run.shape_key.font_instance.variations.is_empty() {
                    Some(false)
                } else {
                    None
                },
                if face.face_index != 0 {
                    Some(false)
                } else {
                    None
                },
                blob.data_ref.is_some(),
                None,
            ));
        }
    };
    let Some(mut typeface) = font_mgr.new_from_data(bytes, Some(face.face_index as usize)) else {
        let reason = if face.face_index != 0 {
            VariantRejectReason::FaceIndexUnsupported
        } else if !run.shape_key.font_instance.variations.is_empty() {
            VariantRejectReason::VariationUnsupported
        } else {
            VariantRejectReason::ExactFaceUnavailable
        };
        return Err(native_skia_exact_font_rejection(
            run,
            face,
            blob,
            reason,
            if !run.shape_key.font_instance.variations.is_empty() {
                Some(false)
            } else {
                None
            },
            if face.face_index != 0 {
                Some(false)
            } else {
                None
            },
            true,
            digest_matched,
        ));
    };
    if run.shape_key.font_instance.variations.is_empty() {
        return Ok((typeface, digest_matched));
    }

    let Some(parameters) = typeface.variation_design_parameters() else {
        return Err(native_skia_exact_font_rejection(
            run,
            face,
            blob,
            VariantRejectReason::VariationUnsupported,
            Some(false),
            Some(true),
            true,
            digest_matched,
        ));
    };
    let mut coordinates = Vec::with_capacity(run.shape_key.font_instance.variations.len());
    for variation in &run.shape_key.font_instance.variations {
        let Some(axis) = four_byte_tag_from_str(&variation.tag) else {
            return Err(native_skia_exact_font_rejection(
                run,
                face,
                blob,
                VariantRejectReason::VariationUnsupported,
                Some(false),
                Some(true),
                true,
                digest_matched,
            ));
        };
        let Some(parameter) = parameters.iter().find(|parameter| parameter.tag == axis) else {
            return Err(native_skia_exact_font_rejection(
                run,
                face,
                blob,
                VariantRejectReason::VariationUnsupported,
                Some(false),
                Some(true),
                true,
                digest_matched,
            ));
        };
        if !variation.value.is_finite()
            || variation.value < parameter.min
            || variation.value > parameter.max
        {
            return Err(native_skia_exact_font_rejection(
                run,
                face,
                blob,
                VariantRejectReason::VariationUnsupported,
                Some(false),
                Some(true),
                true,
                digest_matched,
            ));
        }
        coordinates.push(variation_position::Coordinate {
            axis,
            value: variation.value,
        });
    }
    let arguments = FontArguments::new().set_variation_design_position(VariationPosition {
        coordinates: coordinates.as_slice(),
    });
    typeface = typeface.clone_with_arguments(&arguments).ok_or_else(|| {
        native_skia_exact_font_rejection(
            run,
            face,
            blob,
            VariantRejectReason::VariationUnsupported,
            Some(false),
            Some(true),
            true,
            digest_matched,
        )
    })?;
    Ok((typeface, digest_matched))
}

enum NativeSkiaFontBlobBytes<'a> {
    Resolved {
        bytes: &'a [u8],
        digest_matched: Option<bool>,
    },
    DigestMismatch,
    Missing,
}

fn native_skia_font_blob_bytes<'a>(
    resources: &'a ResourceArena,
    blob: &crate::paint::FontBlobResource,
) -> NativeSkiaFontBlobBytes<'a> {
    let Some(data_ref) = blob.data_ref.as_ref() else {
        return NativeSkiaFontBlobBytes::Missing;
    };
    if data_ref.kind != crate::paint::BinaryResourceKind::FontBlob {
        return NativeSkiaFontBlobBytes::Missing;
    }
    let expected_digest = blob.digest.as_ref().map(|digest| digest.value.as_str());
    for (id, bytes) in resources.font_blob_resources() {
        let digest = crate::paint::resource_digest_hex(bytes);
        let ref_matches = data_ref.id == blob.id.0
            || data_ref.id == format!("font-blob-{}", id.0)
            || data_ref.id == crate::paint::font_blob_resource_key(bytes.len(), &digest)
            || expected_digest.is_some_and(|expected| expected == digest);
        if ref_matches {
            let digest_matched = expected_digest.map(|expected| expected == digest);
            if digest_matched == Some(false) {
                return NativeSkiaFontBlobBytes::DigestMismatch;
            }
            return NativeSkiaFontBlobBytes::Resolved {
                bytes,
                digest_matched,
            };
        }
    }
    NativeSkiaFontBlobBytes::Missing
}

fn four_byte_tag_from_str(tag: &str) -> Option<FourByteTag> {
    let bytes: [u8; 4] = tag.as_bytes().try_into().ok()?;
    if bytes.iter().all(|byte| byte.is_ascii()) {
        Some(FourByteTag::new(u32::from_be_bytes(bytes)))
    } else {
        None
    }
}

fn native_skia_exact_font_rejection(
    run: &LayerGlyphRunPaint,
    face: &crate::paint::FontFaceResource,
    blob: &crate::paint::FontBlobResource,
    reason: VariantRejectReason,
    variation_supported: Option<bool>,
    face_index_supported: Option<bool>,
    blob_resolved: bool,
    digest_matched: Option<bool>,
) -> VariantReplayStatus {
    let mut status = VariantReplayStatus::rejected(reason);
    status.font_verification = Some(native_skia_font_verification_report(
        run,
        face,
        blob,
        blob_resolved,
        digest_matched,
        face_index_supported,
        variation_supported,
        false,
        Some(reason),
    ));
    status
}

fn native_skia_font_verification_report(
    run: &LayerGlyphRunPaint,
    face: &crate::paint::FontFaceResource,
    blob: &crate::paint::FontBlobResource,
    blob_resolved: bool,
    digest_matched: Option<bool>,
    face_index_supported: Option<bool>,
    variation_supported: Option<bool>,
    replay_eligible: bool,
    reason: Option<VariantRejectReason>,
) -> VariantFontVerificationReport {
    VariantFontVerificationReport {
        face_key: Some(run.shape_key.font_instance.face_key.0.clone()),
        blob_key: Some(face.blob_key.0.clone()),
        portability: Some(blob.portability.kind().as_str().to_string()),
        expected_digest: blob.digest.as_ref().map(|digest| digest.value.clone()),
        blob_resolved: Some(blob_resolved),
        digest_matched,
        exact_face_instantiated: Some(replay_eligible),
        face_index_supported,
        variation_supported,
        effect_supported: None,
        replay_eligible,
        reason,
    }
}

fn native_skia_glyph_run_font_rejection(
    run: &LayerGlyphRunPaint,
    reason: VariantRejectReason,
) -> VariantReplayStatus {
    let mut status = VariantReplayStatus::rejected(reason);
    status.font_verification = Some(VariantFontVerificationReport {
        face_key: Some(run.shape_key.font_instance.face_key.0.clone()),
        blob_key: None,
        portability: None,
        expected_digest: None,
        blob_resolved: None,
        digest_matched: None,
        exact_face_instantiated: None,
        face_index_supported: None,
        variation_supported: None,
        effect_supported: None,
        replay_eligible: false,
        reason: Some(reason),
    });
    status
}

fn native_skia_can_replay_glyph_run(
    run: &LayerGlyphRunPaint,
    resources: &ResourceArena,
    font_mgr: &FontMgr,
) -> bool {
    native_skia_glyph_run_replay_status(run, resources, font_mgr).replayable
}

fn native_skia_glyph_run_font(
    run: &LayerGlyphRunPaint,
    resources: &ResourceArena,
    font_mgr: &FontMgr,
) -> Option<Font> {
    let instance = &run.shape_key.font_instance;
    let font_size = if instance.size_px.is_finite() && instance.size_px > 0.0 {
        instance.size_px as f32
    } else if run.paint_style.font_size.is_finite() && run.paint_style.font_size > 0.0 {
        run.paint_style.font_size as f32
    } else {
        12.0
    };
    let font_resources = resources.font_resources();
    let face = font_resources
        .faces
        .iter()
        .find(|face| face.id == instance.face_key)?;
    let blob = font_resources
        .blobs
        .iter()
        .find(|blob| blob.id == face.blob_key);
    let mut font = if face.face_index == 0 && instance.variations.is_empty() {
        if let Some(blob) = blob {
            if matches!(
                native_skia_font_blob_bytes(resources, blob),
                NativeSkiaFontBlobBytes::Resolved { .. }
            ) {
                let (typeface, _) =
                    native_skia_exact_typeface_for_glyph_run(run, resources, font_mgr, face, blob)
                        .ok()?;
                Font::from_typeface(typeface, Some(font_size))
            } else {
                let font_style = crate::renderer::TextStyle {
                    font_family: run.paint_style.font_family.clone(),
                    font_size: f64::from(font_size),
                    color: run.paint_style.color,
                    bold: run.paint_style.bold,
                    italic: run.paint_style.italic,
                    ..Default::default()
                };
                make_font(&font_style, font_mgr, "A")
            }
        } else {
            let font_style = crate::renderer::TextStyle {
                font_family: run.paint_style.font_family.clone(),
                font_size: f64::from(font_size),
                color: run.paint_style.color,
                bold: run.paint_style.bold,
                italic: run.paint_style.italic,
                ..Default::default()
            };
            make_font(&font_style, font_mgr, "A")
        }
    } else {
        let blob = blob?;
        let (typeface, _) =
            native_skia_exact_typeface_for_glyph_run(run, resources, font_mgr, face, blob).ok()?;
        Font::from_typeface(typeface, Some(font_size))
    };
    font.set_embolden(instance.synthetic_bold);
    font.set_skew_x(if instance.synthetic_italic {
        -0.25
    } else {
        0.0
    });
    Some(font)
}

fn affine_is_finite(transform: &LayerAffineTransform) -> bool {
    [
        transform.a,
        transform.b,
        transform.c,
        transform.d,
        transform.e,
        transform.f,
    ]
    .into_iter()
    .all(f64::is_finite)
}

fn path_commands_are_finite(commands: &[crate::renderer::PathCommand]) -> bool {
    !commands.is_empty()
        && commands.iter().all(|command| match *command {
            crate::renderer::PathCommand::MoveTo(x, y)
            | crate::renderer::PathCommand::LineTo(x, y) => x.is_finite() && y.is_finite(),
            crate::renderer::PathCommand::CurveTo(x1, y1, x2, y2, x, y) => {
                [x1, y1, x2, y2, x, y].into_iter().all(f64::is_finite)
            }
            crate::renderer::PathCommand::ArcTo(rx, ry, rotation, _, _, x, y) => {
                [rx, ry, rotation, x, y].into_iter().all(f64::is_finite)
            }
            crate::renderer::PathCommand::ClosePath => true,
        })
}

fn glyph_outline_paths_are_replayable(outline: &LayerGlyphOutlinePaint) -> bool {
    !outline.paths.is_empty()
        && outline.paths.iter().all(|path| {
            path.source_range_utf8.end >= path.source_range_utf8.start
                && path.glyph_range.end >= path.glyph_range.start
                && path_commands_are_finite(&path.commands)
        })
}

fn color_layers_are_replayable(outline: &LayerGlyphOutlinePaint) -> bool {
    let Some(payload) = outline.color_layers.as_ref() else {
        return false;
    };
    if payload.has_colrv0_resolved_layer_contract() {
        return payload.layers.iter().all(|layer| {
            layer
                .commands
                .as_ref()
                .is_some_and(|commands| path_commands_are_finite(commands))
                && layer.fill.as_ref().is_some_and(|fill| {
                    fill.rgba
                        .iter()
                        .all(|component| component.is_finite() && (0.0..=1.0).contains(component))
                })
                && layer
                    .transform_to_run
                    .as_ref()
                    .map(affine_is_finite)
                    .unwrap_or(true)
        });
    }
    if payload.has_colrv1_supported_graph_contract() {
        return true;
    }
    false
}

fn native_skia_glyph_outline_payload_status(
    outline: &LayerGlyphOutlinePaint,
    bbox: Option<BoundingBox>,
    resources: &ResourceArena,
) -> (bool, Option<VariantRejectReason>) {
    if !affine_is_finite(&outline.placement.run_to_page)
        || !outline.placement.baseline_y.is_finite()
    {
        return (false, Some(VariantRejectReason::VariantUnsupported));
    }
    if !outline.has_exclusive_payload_family() {
        return (false, Some(VariantRejectReason::MixedGlyphOutlinePayload));
    }
    match outline.payload_kind {
        GlyphOutlinePayloadKind::MonochromeFill => {
            if outline.paths.is_empty() {
                return (false, Some(VariantRejectReason::EmptyGlyphOutlinePayload));
            }
            if glyph_outline_paths_are_replayable(outline) {
                (true, None)
            } else {
                (false, Some(VariantRejectReason::UnsupportedOutlinePayload))
            }
        }
        GlyphOutlinePayloadKind::MonochromeFillStroke => {
            let Some(stroke) = outline.stroke.as_ref() else {
                return (false, Some(VariantRejectReason::UnsupportedOutlinePayload));
            };
            if outline.paths.is_empty() {
                return (false, Some(VariantRejectReason::EmptyGlyphOutlinePayload));
            }
            if !stroke.is_supported_monochrome_subset() {
                return (
                    false,
                    Some(VariantRejectReason::GlyphOutlineStrokeStyleUnsupported),
                );
            }
            if glyph_outline_paths_are_replayable(outline) {
                (true, None)
            } else {
                (false, Some(VariantRejectReason::UnsupportedOutlinePayload))
            }
        }
        GlyphOutlinePayloadKind::ColorLayers => {
            if color_layers_are_replayable(outline) {
                (true, None)
            } else {
                (false, Some(VariantRejectReason::UnsupportedColorGlyph))
            }
        }
        GlyphOutlinePayloadKind::BitmapGlyph => {
            let Some(payload) = outline.bitmap_glyph.as_ref() else {
                return (false, Some(VariantRejectReason::UnsupportedBitmapGlyph));
            };
            let Some(bbox) = bbox else {
                return (false, Some(VariantRejectReason::UnsupportedBitmapGlyph));
            };
            if !glyph_payload_bbox_is_replayable(bbox) {
                return (false, Some(VariantRejectReason::UnsupportedBitmapGlyph));
            }
            if !glyph_payload_placement_is_replayable(payload.placement, payload.transform_to_run) {
                return (false, Some(VariantRejectReason::UnsupportedBitmapGlyph));
            }
            let Some(bytes) = resources.image_bytes(payload.image_resource_id) else {
                return (false, Some(VariantRejectReason::UnsupportedBitmapGlyph));
            };
            if payload.has_strict_visual_contract() && decode_image_bytes(bytes).is_some() {
                (true, None)
            } else {
                (false, Some(VariantRejectReason::UnsupportedBitmapGlyph))
            }
        }
        GlyphOutlinePayloadKind::SvgGlyph => {
            let Some(payload) = outline.svg_glyph.as_ref() else {
                return (false, Some(VariantRejectReason::UnsupportedSvgGlyph));
            };
            if !glyph_payload_placement_is_replayable(payload.placement, payload.transform_to_run) {
                return (false, Some(VariantRejectReason::UnsupportedSvgGlyph));
            }
            let Some(fragment) = resources.svg_fragment(payload.vector_resource_id) else {
                return (false, Some(VariantRejectReason::UnsupportedSvgGlyph));
            };
            if !static_svg_fragment_has_path_layer(fragment) {
                return (false, Some(VariantRejectReason::UnsupportedSvgGlyph));
            }
            let Some(bbox) = bbox else {
                return (false, Some(VariantRejectReason::UnsupportedSvgGlyph));
            };
            if !glyph_payload_bbox_is_replayable(bbox) {
                return (false, Some(VariantRejectReason::UnsupportedSvgGlyph));
            }
            let Some(view_box) = payload.view_box else {
                return (false, Some(VariantRejectReason::UnsupportedSvgGlyph));
            };
            if payload.has_static_sanitized_contract() {
                let image = rasterize_svg_fragment_with_view_box(
                    fragment,
                    bbox.width as f32,
                    bbox.height as f32,
                    view_box.x as f32,
                    view_box.y as f32,
                    view_box.width as f32,
                    view_box.height as f32,
                );
                if image.is_some() {
                    return (true, None);
                }
            }
            (false, Some(VariantRejectReason::UnsupportedSvgGlyph))
        }
    }
}

fn glyph_payload_placement_is_replayable(
    placement: Option<TextRunPlacement>,
    transform_to_run: Option<LayerAffineTransform>,
) -> bool {
    placement.is_some_and(|placement| {
        affine_is_finite(&placement.run_to_page)
            && placement.baseline_y.is_finite()
            && transform_to_run
                .map(|transform| affine_is_finite(&transform))
                .unwrap_or(true)
    })
}

fn glyph_payload_bbox_is_replayable(bbox: BoundingBox) -> bool {
    bbox.x.is_finite()
        && bbox.y.is_finite()
        && bbox.width.is_finite()
        && bbox.height.is_finite()
        && bbox.width > 0.0
        && bbox.height > 0.0
}

fn native_skia_glyph_outline_replay_status(
    outline: &LayerGlyphOutlinePaint,
    bbox: Option<BoundingBox>,
    resources: &ResourceArena,
) -> VariantReplayStatus {
    let (payload_supported, payload_reason) =
        native_skia_glyph_outline_payload_status(outline, bbox, resources);
    let strict_visual_eligible = outline.diagnostics.strict_visual_eligible;
    let paint_style_supported = outline.paint_style.is_fill_only_glyph_replay();
    let replay_eligible = strict_visual_eligible && payload_supported && paint_style_supported;
    let reason = if !strict_visual_eligible {
        Some(VariantRejectReason::VariantUnsupported)
    } else if !payload_supported {
        payload_reason
    } else if !paint_style_supported {
        Some(VariantRejectReason::UnsupportedPaintEffect)
    } else {
        None
    };
    let mut status = if replay_eligible {
        VariantReplayStatus::replayable()
    } else {
        VariantReplayStatus::rejected(reason.unwrap_or(VariantRejectReason::VariantUnsupported))
    };
    if replay_eligible
        && outline.payload_kind == GlyphOutlinePayloadKind::BitmapGlyph
        && outline
            .bitmap_glyph
            .as_ref()
            .is_some_and(|payload| payload.color_space.is_none())
    {
        status.details = Some("colorSpaceDefaulted=srgb".to_string());
    }
    status.outline_eligibility = Some(VariantOutlineEligibilityReport {
        strict_visual_eligible,
        payload_supported,
        paint_style_supported,
        replay_eligible,
        reason: status.reason,
    });
    status
}

fn native_skia_can_replay_glyph_outline(
    outline: &LayerGlyphOutlinePaint,
    bbox: BoundingBox,
    resources: &ResourceArena,
) -> bool {
    native_skia_glyph_outline_replay_status(outline, Some(bbox), resources).replayable
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
    antialias: bool,
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
    fill.set_anti_alias(antialias);
    fill.set_style(skia_safe::paint::Style::Fill);
    fill.set_color(colorref_to_skia(color, 1.0));

    let mut stroke = Paint::default();
    stroke.set_anti_alias(antialias);
    stroke.set_style(skia_safe::paint::Style::Stroke);
    stroke.set_stroke_width((stroke_width * 0.3).max(0.5) as f32);
    stroke.set_color(colorref_to_skia(color, 1.0));

    let mut open_fill = Paint::default();
    open_fill.set_anti_alias(antialias);
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
        let font_resolver = SkiaFontResolver::new(font_mgr.clone(), &[]);
        let text_shaper = Shaper::new(Some(font_mgr.clone()));
        Self {
            font_mgr,
            font_resolver,
            text_shaper,
            static_picture_cache: RefCell::new(StaticPictureCache::new(
                MAX_STATIC_PICTURE_CACHE_ENTRIES,
                MAX_STATIC_PICTURE_CACHE_BYTES,
            )),
        }
    }

    pub fn with_font_paths(mut self, font_paths: &[std::path::PathBuf]) -> Self {
        self.font_resolver = SkiaFontResolver::new(self.font_mgr.clone(), font_paths);
        self
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
        let total_start = Instant::now();
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

        let setup_start = Instant::now();
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
        let setup_time = setup_start.elapsed();

        let replay_start = Instant::now();
        for replay_plane in PaintReplayPlane::ORDERED {
            self.render_node(
                canvas,
                &tree.root,
                &tree.resources,
                &tree.variant_ops,
                &mut replay,
                replay_plane,
            );
        }
        let replay_time = replay_start.elapsed();

        let encode_start = Instant::now();
        let image = surface.image_snapshot();
        let data = image
            .encode(None, EncodedImageFormat::PNG, None)
            .ok_or_else(|| LayerRenderError::encoding("Skia PNG 인코딩 실패"))?;
        let bytes = data.as_bytes().to_vec();
        let encode_time = encode_start.elapsed();
        let mut diagnostics = replay.diagnostics;
        diagnostics.raster_setup_time_ns = duration_ns(setup_time);
        diagnostics.raster_replay_time_ns = duration_ns(replay_time);
        diagnostics.raster_encode_time_ns = duration_ns(encode_time);
        diagnostics.raster_total_time_ns = duration_ns(total_start.elapsed());
        Ok(RasterRenderOutput {
            bytes,
            format: RasterOutputFormat::Png,
            width,
            height,
            dpi: options.dpi,
            color_space: options.color_space,
            diagnostics,
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
        variant_ops: &[PaintOp],
        replay: &mut SkiaReplayContext,
        replay_plane: PaintReplayPlane,
    ) {
        if !layer_node_has_replay_plane(node, variant_ops, replay_plane) {
            return;
        }
        replay.record_layer_node_replay();
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
                    cache_key.mix_str(replay_plane.as_str());
                    cache_key.mix_layer_node_with_sidecars(node, resources, variant_ops);
                    let cache_key = cache_key.finish();
                    let lookup = {
                        let mut cache = self.static_picture_cache.borrow_mut();
                        let had_hash = cache.contains_hash(cache_key.hash);
                        let picture = cache.get(cache_key);
                        (had_hash, picture, cache.approx_bytes())
                    };
                    let (had_hash, picture, approx_bytes) = lookup;
                    if let Some(picture) = picture {
                        replay.diagnostics.static_picture_cache_hits = replay
                            .diagnostics
                            .static_picture_cache_hits
                            .saturating_add(1);
                        replay.diagnostics.static_picture_cache_approx_bytes = approx_bytes;
                        canvas.draw_picture(&picture, None, None);
                        return;
                    }
                    if had_hash {
                        replay
                            .diagnostics
                            .static_picture_cache_fingerprint_mismatches = replay
                            .diagnostics
                            .static_picture_cache_fingerprint_mismatches
                            .saturating_add(1);
                    }
                    replay.diagnostics.static_picture_cache_misses = replay
                        .diagnostics
                        .static_picture_cache_misses
                        .saturating_add(1);
                    replay.record_static_picture_recording();

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
                        self.render_node(
                            recording_canvas,
                            child,
                            resources,
                            variant_ops,
                            replay,
                            replay_plane,
                        );
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
                        let (outcome, cache_bytes) = {
                            let mut cache = self.static_picture_cache.borrow_mut();
                            let outcome = cache.insert(cache_key, picture, approx_bytes);
                            (outcome, cache.approx_bytes())
                        };
                        replay.diagnostics.static_picture_cache_evictions = replay
                            .diagnostics
                            .static_picture_cache_evictions
                            .saturating_add(outcome.evictions);
                        if outcome.skipped_oversized {
                            replay.diagnostics.static_picture_cache_skipped_oversized = replay
                                .diagnostics
                                .static_picture_cache_skipped_oversized
                                .saturating_add(1);
                        }
                        replay.diagnostics.static_picture_cache_approx_bytes = cache_bytes;
                        return;
                    }
                }

                replay.push_cache_hint(*cache_hint);
                for child in children {
                    self.render_node(canvas, child, resources, variant_ops, replay, replay_plane);
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
                    self.render_node(canvas, child, resources, variant_ops, replay, replay_plane);
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
                self.render_node(canvas, child, resources, variant_ops, replay, replay_plane);
                canvas.restore();
            }
            LayerNodeKind::Leaf { ops, cache_hint } => {
                replay.push_cache_hint(*cache_hint);
                let sidecars = sidecars_for_leaf_ops(ops, variant_ops);
                let mut selection_ops = Vec::with_capacity(ops.len() + sidecars.len());
                selection_ops.extend(ops.iter().cloned());
                selection_ops.extend(sidecars.iter().cloned());
                let selection = select_text_variant_sets_with_report(
                    &selection_ops,
                    |op| match op {
                        PaintOp::GlyphRun { run, .. } => {
                            native_skia_glyph_run_replay_status(run, resources, &self.font_mgr)
                        }
                        _ => VariantReplayStatus::rejected(VariantRejectReason::VariantUnsupported),
                    },
                    |op| match op {
                        PaintOp::GlyphOutline { bbox, outline } => {
                            native_skia_glyph_outline_replay_status(outline, Some(*bbox), resources)
                        }
                        _ => VariantReplayStatus::rejected(
                            VariantRejectReason::BackendDoesNotSupportVariant,
                        ),
                    },
                    VariantSelectionContext {
                        backend: VariantSelectionBackend::NativeSkia,
                        render_profile: replay.profile.as_str().to_string(),
                    },
                );
                replay
                    .diagnostics
                    .variant_selections
                    .extend(selection.reports);
                for op in ops {
                    if paint_op_replay_plane(op) != replay_plane {
                        continue;
                    }
                    if !should_render_selected_text_variant(op, &selection.selected) {
                        continue;
                    }
                    self.render_op(canvas, op, resources, replay);
                }
                for op in &sidecars {
                    if paint_op_replay_plane(op) != replay_plane {
                        continue;
                    }
                    if !should_render_selected_text_variant(op, &selection.selected) {
                        continue;
                    }
                    self.render_op(canvas, op, resources, replay);
                }
                replay.pop_cache_hint();
            }
        }
    }

    fn glyph_outline_matrix(transform: LayerAffineTransform) -> Matrix {
        Matrix::from_affine(&[
            transform.a as f32,
            transform.b as f32,
            transform.c as f32,
            transform.d as f32,
            transform.e as f32,
            transform.f as f32,
        ])
    }

    fn glyph_outline_fill_type(fill_rule: GlyphOutlineFillRule) -> skia_safe::PathFillType {
        match fill_rule {
            GlyphOutlineFillRule::NonZero => skia_safe::PathFillType::Winding,
            GlyphOutlineFillRule::EvenOdd => skia_safe::PathFillType::EvenOdd,
        }
    }

    fn glyph_outline_path(
        commands: &[crate::renderer::PathCommand],
        fill_rule: GlyphOutlineFillRule,
    ) -> skia_safe::Path {
        let mut path = to_skia_path(commands);
        path.set_fill_type(Self::glyph_outline_fill_type(fill_rule));
        path
    }

    fn glyph_outline_resolved_color(
        color: &crate::paint::ResolvedColor,
        opacity: Option<f64>,
    ) -> Color {
        let channel = |component: f32| -> u8 { (component.clamp(0.0, 1.0) * 255.0).round() as u8 };
        let alpha = (color.rgba[3] * opacity.unwrap_or(1.0) as f32).clamp(0.0, 1.0);
        Color::from_argb(
            channel(alpha),
            channel(color.rgba[0]),
            channel(color.rgba[1]),
            channel(color.rgba[2]),
        )
    }

    fn render_glyph_outline_path(
        canvas: &Canvas,
        commands: &[crate::renderer::PathCommand],
        fill_rule: GlyphOutlineFillRule,
        fill_paint: &Paint,
        stroke_paint: Option<&Paint>,
    ) {
        let path = Self::glyph_outline_path(commands, fill_rule);
        canvas.draw_path(&path, fill_paint);
        if let Some(stroke_paint) = stroke_paint {
            canvas.draw_path(&path, stroke_paint);
        }
    }

    fn render_glyph_outline_color_layers(
        &self,
        canvas: &Canvas,
        outline: &LayerGlyphOutlinePaint,
        replay: &SkiaReplayContext,
    ) {
        let Some(payload) = outline.color_layers.as_ref() else {
            return;
        };
        if payload.color_format == crate::paint::ColorGlyphFormat::ColrV1 {
            if let Some(graph) = &payload.paint_graph {
                self.render_glyph_outline_color_graph(canvas, graph, replay);
            }
            return;
        }
        let reference_layers;
        let layers = if payload.has_colrv0_resolved_layer_contract() {
            &payload.layers
        } else {
            reference_layers = payload.colrv1_stage1_reference_layers().unwrap_or_default();
            &reference_layers
        };
        for layer in layers {
            let (Some(commands), Some(fill)) = (layer.commands.as_ref(), layer.fill.as_ref())
            else {
                continue;
            };
            let mut fill_paint = Paint::default();
            fill_paint.set_anti_alias(replay.vector_antialias());
            fill_paint.set_style(skia_safe::paint::Style::Fill);
            fill_paint.set_color(Self::glyph_outline_resolved_color(fill, layer.opacity));

            if let Some(transform) = layer.transform_to_run {
                canvas.save();
                canvas.concat(&Self::glyph_outline_matrix(transform));
                Self::render_glyph_outline_path(
                    canvas,
                    commands,
                    layer.fill_rule.unwrap_or(GlyphOutlineFillRule::NonZero),
                    &fill_paint,
                    None,
                );
                canvas.restore();
            } else {
                Self::render_glyph_outline_path(
                    canvas,
                    commands,
                    layer.fill_rule.unwrap_or(GlyphOutlineFillRule::NonZero),
                    &fill_paint,
                    None,
                );
            }
        }
    }

    fn render_glyph_outline_color_graph(
        &self,
        canvas: &Canvas,
        graph: &crate::paint::ColorPaintGraphPayload,
        replay: &SkiaReplayContext,
    ) {
        self.render_glyph_outline_color_graph_node(canvas, graph, graph.root_node_id, replay, 0);
    }

    fn render_glyph_outline_color_graph_node(
        &self,
        canvas: &Canvas,
        graph: &crate::paint::ColorPaintGraphPayload,
        node_id: u32,
        replay: &SkiaReplayContext,
        depth: usize,
    ) {
        if depth > 64 {
            return;
        }
        let Some(node) = graph.nodes.iter().find(|node| node.node_id == node_id) else {
            return;
        };
        match node.kind {
            crate::paint::ColorPaintGraphNodeKind::SolidPath => {
                let Some(solid) = node.solid_path.as_ref() else {
                    return;
                };
                let mut fill_paint = Paint::default();
                fill_paint.set_anti_alias(replay.vector_antialias());
                fill_paint.set_style(skia_safe::paint::Style::Fill);
                fill_paint.set_color(Self::glyph_outline_resolved_color(&solid.fill, None));
                Self::render_glyph_outline_path(
                    canvas,
                    &solid.commands,
                    solid.fill_rule,
                    &fill_paint,
                    None,
                );
            }
            crate::paint::ColorPaintGraphNodeKind::LinearGradientPath => {
                let Some(gradient_path) = node.linear_gradient_path.as_ref() else {
                    return;
                };
                if gradient_path.gradient.stops.len() < 2 {
                    return;
                }
                let shader_colors: Vec<Color4f> = gradient_path
                    .gradient
                    .stops
                    .iter()
                    .map(|stop| {
                        Color4f::new(
                            stop.color.rgba[0],
                            stop.color.rgba[1],
                            stop.color.rgba[2],
                            stop.color.rgba[3],
                        )
                    })
                    .collect();
                let shader_positions: Vec<f32> = gradient_path
                    .gradient
                    .stops
                    .iter()
                    .map(|stop| stop.offset as f32)
                    .collect();
                let shader_gradient_colors = GradientColors::new(
                    &shader_colors,
                    Some(&shader_positions),
                    TileMode::Clamp,
                    None,
                );
                let shader_gradient =
                    Gradient::new(shader_gradient_colors, GradientInterpolation::default());
                let Some(shader) = shaders::linear_gradient(
                    (
                        Point::new(
                            gradient_path.gradient.x0 as f32,
                            gradient_path.gradient.y0 as f32,
                        ),
                        Point::new(
                            gradient_path.gradient.x1 as f32,
                            gradient_path.gradient.y1 as f32,
                        ),
                    ),
                    &shader_gradient,
                    None,
                ) else {
                    return;
                };
                let mut fill_paint = Paint::default();
                fill_paint.set_anti_alias(replay.vector_antialias());
                fill_paint.set_style(skia_safe::paint::Style::Fill);
                fill_paint.set_shader(shader);
                Self::render_glyph_outline_path(
                    canvas,
                    &gradient_path.commands,
                    gradient_path.fill_rule,
                    &fill_paint,
                    None,
                );
            }
            crate::paint::ColorPaintGraphNodeKind::RadialGradientPath => {
                let Some(gradient_path) = node.radial_gradient_path.as_ref() else {
                    return;
                };
                if gradient_path.gradient.stops.len() < 2 {
                    return;
                }
                let shader_colors: Vec<Color4f> = gradient_path
                    .gradient
                    .stops
                    .iter()
                    .map(|stop| {
                        Color4f::new(
                            stop.color.rgba[0],
                            stop.color.rgba[1],
                            stop.color.rgba[2],
                            stop.color.rgba[3],
                        )
                    })
                    .collect();
                let shader_positions: Vec<f32> = gradient_path
                    .gradient
                    .stops
                    .iter()
                    .map(|stop| stop.offset as f32)
                    .collect();
                let shader_gradient_colors = GradientColors::new(
                    &shader_colors,
                    Some(&shader_positions),
                    TileMode::Clamp,
                    None,
                );
                let shader_gradient =
                    Gradient::new(shader_gradient_colors, GradientInterpolation::default());
                let Some(shader) = shaders::radial_gradient(
                    (
                        Point::new(
                            gradient_path.gradient.cx as f32,
                            gradient_path.gradient.cy as f32,
                        ),
                        gradient_path.gradient.radius as f32,
                    ),
                    &shader_gradient,
                    None,
                ) else {
                    return;
                };
                let mut fill_paint = Paint::default();
                fill_paint.set_anti_alias(replay.vector_antialias());
                fill_paint.set_style(skia_safe::paint::Style::Fill);
                fill_paint.set_shader(shader);
                Self::render_glyph_outline_path(
                    canvas,
                    &gradient_path.commands,
                    gradient_path.fill_rule,
                    &fill_paint,
                    None,
                );
            }
            crate::paint::ColorPaintGraphNodeKind::SweepGradientPath => {
                let Some(gradient_path) = node.sweep_gradient_path.as_ref() else {
                    return;
                };
                if gradient_path.gradient.stops.len() < 2 {
                    return;
                }
                let shader_colors: Vec<Color4f> = gradient_path
                    .gradient
                    .stops
                    .iter()
                    .map(|stop| {
                        Color4f::new(
                            stop.color.rgba[0],
                            stop.color.rgba[1],
                            stop.color.rgba[2],
                            stop.color.rgba[3],
                        )
                    })
                    .collect();
                let shader_positions: Vec<f32> = gradient_path
                    .gradient
                    .stops
                    .iter()
                    .map(|stop| stop.offset as f32)
                    .collect();
                let shader_gradient_colors = GradientColors::new(
                    &shader_colors,
                    Some(&shader_positions),
                    TileMode::Clamp,
                    None,
                );
                let shader_gradient =
                    Gradient::new(shader_gradient_colors, GradientInterpolation::default());
                let Some(shader) = shaders::sweep_gradient(
                    Point::new(
                        gradient_path.gradient.cx as f32,
                        gradient_path.gradient.cy as f32,
                    ),
                    (
                        gradient_path.gradient.start_angle_degrees as f32,
                        gradient_path.gradient.end_angle_degrees as f32,
                    ),
                    &shader_gradient,
                    None,
                ) else {
                    return;
                };
                let mut fill_paint = Paint::default();
                fill_paint.set_anti_alias(replay.vector_antialias());
                fill_paint.set_style(skia_safe::paint::Style::Fill);
                fill_paint.set_shader(shader);
                Self::render_glyph_outline_path(
                    canvas,
                    &gradient_path.commands,
                    gradient_path.fill_rule,
                    &fill_paint,
                    None,
                );
            }
            crate::paint::ColorPaintGraphNodeKind::Transform => {
                let Some(transform) = node.transform.as_ref() else {
                    return;
                };
                canvas.save();
                canvas.concat(&Self::glyph_outline_matrix(transform.transform));
                self.render_glyph_outline_color_graph_node(
                    canvas,
                    graph,
                    transform.child_node_id,
                    replay,
                    depth + 1,
                );
                canvas.restore();
            }
            crate::paint::ColorPaintGraphNodeKind::Composite => {
                let Some(composite) = node.composite.as_ref() else {
                    return;
                };
                match composite.mode {
                    crate::paint::ColorPaintCompositeMode::SourceOver => {
                        self.render_glyph_outline_color_graph_node(
                            canvas,
                            graph,
                            composite.backdrop_node_id,
                            replay,
                            depth + 1,
                        );
                        self.render_glyph_outline_color_graph_node(
                            canvas,
                            graph,
                            composite.source_node_id,
                            replay,
                            depth + 1,
                        );
                    }
                }
            }
            crate::paint::ColorPaintGraphNodeKind::Clip => {
                let Some(clip) = node.clip.as_ref() else {
                    return;
                };
                let clip_path = Self::glyph_outline_path(&clip.clip_commands, clip.fill_rule);
                canvas.save();
                canvas.clip_path(&clip_path, None, Some(replay.clip_antialias()));
                self.render_glyph_outline_color_graph_node(
                    canvas,
                    graph,
                    clip.child_node_id,
                    replay,
                    depth + 1,
                );
                canvas.restore();
            }
        }
    }

    fn render_glyph_outline(
        &self,
        canvas: &Canvas,
        bbox: BoundingBox,
        outline: &LayerGlyphOutlinePaint,
        resources: &ResourceArena,
        replay: &SkiaReplayContext,
    ) {
        if !native_skia_can_replay_glyph_outline(outline, bbox, resources) {
            return;
        }
        if outline.payload_kind == GlyphOutlinePayloadKind::BitmapGlyph {
            self.render_glyph_outline_bitmap(canvas, bbox, outline, resources, replay);
            return;
        }
        if outline.payload_kind == GlyphOutlinePayloadKind::SvgGlyph {
            self.render_glyph_outline_svg(canvas, bbox, outline, resources, replay);
            return;
        }
        let mut fill_paint = Paint::default();
        fill_paint.set_anti_alias(replay.vector_antialias());
        fill_paint.set_style(skia_safe::paint::Style::Fill);
        fill_paint.set_color(colorref_to_skia(outline.paint_style.color, 1.0));

        let mut stroke_paint = Paint::default();
        let stroke_paint = if outline.payload_kind == GlyphOutlinePayloadKind::MonochromeFillStroke
        {
            if let Some(stroke) = outline.stroke.as_ref() {
                stroke_paint.set_anti_alias(replay.vector_antialias());
                stroke_paint.set_style(skia_safe::paint::Style::Stroke);
                stroke_paint.set_color(colorref_to_skia(stroke.color, 1.0));
                stroke_paint.set_stroke_width(stroke.width_px as f32);
                stroke_paint.set_stroke_join(skia_safe::paint::Join::Miter);
                stroke_paint.set_stroke_cap(skia_safe::paint::Cap::Butt);
                if let Some(miter_limit) = stroke.miter_limit {
                    stroke_paint.set_stroke_miter(miter_limit as f32);
                }
                Some(&stroke_paint)
            } else {
                None
            }
        } else {
            None
        };

        canvas.save();
        canvas.concat(&Self::glyph_outline_matrix(outline.placement.run_to_page));
        match outline.payload_kind {
            GlyphOutlinePayloadKind::MonochromeFill
            | GlyphOutlinePayloadKind::MonochromeFillStroke => {
                for path in &outline.paths {
                    Self::render_glyph_outline_path(
                        canvas,
                        &path.commands,
                        path.fill_rule,
                        &fill_paint,
                        stroke_paint,
                    );
                }
            }
            GlyphOutlinePayloadKind::ColorLayers => {
                self.render_glyph_outline_color_layers(canvas, outline, replay);
            }
            GlyphOutlinePayloadKind::BitmapGlyph | GlyphOutlinePayloadKind::SvgGlyph => {}
        }
        canvas.restore();
    }

    fn glyph_outline_image_sampling(
        filtering: Option<crate::paint::BitmapGlyphFiltering>,
        fallback: ImageSampling,
    ) -> ImageSampling {
        match filtering {
            Some(crate::paint::BitmapGlyphFiltering::Nearest) => ImageSampling::nearest(),
            Some(crate::paint::BitmapGlyphFiltering::Linear) => ImageSampling::linear(),
            _ => fallback,
        }
    }

    fn render_glyph_outline_bitmap(
        &self,
        canvas: &Canvas,
        bbox: BoundingBox,
        outline: &LayerGlyphOutlinePaint,
        resources: &ResourceArena,
        replay: &SkiaReplayContext,
    ) {
        if !glyph_payload_bbox_is_replayable(bbox) {
            return;
        }
        let Some(payload) = outline.bitmap_glyph.as_ref() else {
            return;
        };
        let Some(bytes) = resources.image_bytes(payload.image_resource_id) else {
            return;
        };
        let Some(image) = decode_image_bytes(bytes) else {
            return;
        };
        let Some(placement) = payload.placement else {
            return;
        };
        canvas.save();
        canvas.concat(&Self::glyph_outline_matrix(placement.run_to_page));
        if let Some(transform) = payload.transform_to_run {
            canvas.concat(&Self::glyph_outline_matrix(transform));
        }
        draw_decoded_image(
            canvas,
            &image,
            0.0,
            0.0,
            bbox.width as f32,
            bbox.height as f32,
            None,
            None,
            None,
            ImageEffect::RealPic,
            0,
            0,
            Self::glyph_outline_image_sampling(payload.filtering, replay.image_sampling()),
        );
        canvas.restore();
    }

    fn render_glyph_outline_svg(
        &self,
        canvas: &Canvas,
        bbox: BoundingBox,
        outline: &LayerGlyphOutlinePaint,
        resources: &ResourceArena,
        replay: &SkiaReplayContext,
    ) {
        if !glyph_payload_bbox_is_replayable(bbox) {
            return;
        }
        let Some(payload) = outline.svg_glyph.as_ref() else {
            return;
        };
        let Some(fragment) = resources.svg_fragment(payload.vector_resource_id) else {
            return;
        };
        if !static_svg_fragment_has_path_layer(fragment) {
            return;
        }
        let Some(view_box) = payload.view_box else {
            return;
        };
        let Some(image) = rasterize_svg_fragment_with_view_box(
            fragment,
            bbox.width as f32,
            bbox.height as f32,
            view_box.x as f32,
            view_box.y as f32,
            view_box.width as f32,
            view_box.height as f32,
        ) else {
            return;
        };
        let Some(placement) = payload.placement else {
            return;
        };
        canvas.save();
        canvas.concat(&Self::glyph_outline_matrix(placement.run_to_page));
        if let Some(transform) = payload.transform_to_run {
            canvas.concat(&Self::glyph_outline_matrix(transform));
        }
        draw_decoded_image(
            canvas,
            &image,
            0.0,
            0.0,
            bbox.width as f32,
            bbox.height as f32,
            None,
            None,
            None,
            ImageEffect::RealPic,
            0,
            0,
            replay.image_sampling(),
        );
        canvas.restore();
    }

    fn render_op(
        &self,
        canvas: &Canvas,
        op: &PaintOp,
        resources: &ResourceArena,
        replay: &mut SkiaReplayContext,
    ) {
        replay.record_paint_op_replay();
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
                        if let Some(decoded) = replay.image_for_resource_at_size(
                            image.resource_id,
                            bytes,
                            bbox.width as f32,
                            bbox.height as f32,
                        ) {
                            let binary_effect_image = replay.binary_effect_image_for_replay(
                                image.resource_id,
                                bytes,
                                &decoded,
                                image.effect,
                            );
                            let (draw_image, effect, sampling) =
                                if let Some(effect_image) = binary_effect_image.as_ref() {
                                    (effect_image, ImageEffect::RealPic, ImageSampling::nearest())
                                } else {
                                    (&decoded, image.effect, replay.image_sampling())
                                };
                            let image_opacity = if image.opacity.is_finite() {
                                image.opacity.clamp(0.0, 1.0) as f32
                            } else {
                                1.0
                            };
                            if image_opacity < 1.0 {
                                canvas.save_layer_alpha_f(Some(background_rect), image_opacity);
                            }
                            let diagnostics = draw_decoded_image(
                                canvas,
                                draw_image,
                                bbox.x as f32,
                                bbox.y as f32,
                                bbox.width as f32,
                                bbox.height as f32,
                                Some(image.fill_mode),
                                embedded_svg_intrinsic_size(bytes),
                                None,
                                effect,
                                image.brightness,
                                image.contrast,
                                sampling,
                            );
                            if image_opacity < 1.0 {
                                canvas.restore();
                            }
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
                    paint.set_anti_alias(replay.vector_antialias());
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
                // Vertical layout is already lowered into positioned text runs:
                // upright glyphs use their own bboxes and sideways glyphs carry
                // explicit run.rotation. Keep Skia aligned with SVG by not adding
                // another orientation-derived rotation here.
                let mut replay_run;
                let run = if run.legacy_visuals.char_overlap
                    == Some(crate::paint::TextLegacyVisualState::Mirror)
                    || run.legacy_visuals.control_marks
                        == Some(crate::paint::TextLegacyVisualState::Mirror)
                    || run.legacy_visuals.tab_leaders
                        == Some(crate::paint::TextLegacyVisualState::Mirror)
                    || run.legacy_visuals.decorations
                        == Some(crate::paint::TextLegacyVisualState::Mirror)
                {
                    replay_run = run.clone();
                    if replay_run.legacy_visuals.char_overlap
                        == Some(crate::paint::TextLegacyVisualState::Mirror)
                    {
                        replay_run.char_overlap = None;
                    }
                    if replay_run.legacy_visuals.control_marks
                        == Some(crate::paint::TextLegacyVisualState::Mirror)
                    {
                        replay_run.control_marks.clear();
                    }
                    if replay_run.legacy_visuals.tab_leaders
                        == Some(crate::paint::TextLegacyVisualState::Mirror)
                    {
                        replay_run.style.tab_leaders.clear();
                    }
                    if replay_run.legacy_visuals.decorations
                        == Some(crate::paint::TextLegacyVisualState::Mirror)
                    {
                        replay_run.style.underline = crate::model::style::UnderlineType::None;
                        replay_run.style.strikethrough = false;
                        replay_run.style.emphasis_dot = 0;
                    }
                    &replay_run
                } else {
                    run
                };
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
            PaintOp::GlyphRun { run, .. } => {
                if !native_skia_can_replay_glyph_run(run, resources, &self.font_mgr) {
                    return;
                }
                let Some(font) = native_skia_glyph_run_font(run, resources, &self.font_mgr) else {
                    return;
                };
                let transform = run.placement.run_to_page;
                let matrix = Matrix::from_affine(&[
                    transform.a as f32,
                    transform.b as f32,
                    transform.c as f32,
                    transform.d as f32,
                    transform.e as f32,
                    transform.f as f32,
                ]);
                let mut fill_paint = Paint::default();
                fill_paint.set_anti_alias(true);
                fill_paint.set_style(skia_safe::paint::Style::Fill);
                fill_paint.set_color(colorref_to_skia(run.paint_style.color, 1.0));

                let mut shadow_paint = Paint::default();
                shadow_paint.set_anti_alias(true);
                shadow_paint.set_style(skia_safe::paint::Style::Fill);
                shadow_paint.set_color(colorref_to_skia(run.paint_style.shadow_color, 1.0));

                let mut stroke_paint = Paint::default();
                stroke_paint.set_anti_alias(true);
                stroke_paint.set_style(skia_safe::paint::Style::Stroke);
                stroke_paint.set_stroke_width((run.paint_style.font_size as f32 / 25.0).max(0.5));
                stroke_paint.set_color(colorref_to_skia(run.paint_style.color, 1.0));

                let mut highlight_paint = Paint::default();
                highlight_paint.set_anti_alias(true);
                highlight_paint.set_style(skia_safe::paint::Style::Fill);
                highlight_paint.set_color(Color::WHITE);

                let mut relief_shadow_paint = Paint::default();
                relief_shadow_paint.set_anti_alias(true);
                relief_shadow_paint.set_style(skia_safe::paint::Style::Fill);
                relief_shadow_paint.set_color(Color::from_rgb(0x80, 0x80, 0x80));

                let draw_glyph_paths = |paint: &Paint, x_offset: f32, y_offset: f32| {
                    for (glyph_id, position) in run.glyph_ids.iter().zip(run.positions.iter()) {
                        let glyph_id = *glyph_id as u16;
                        if let Some(path) = font.get_path(glyph_id) {
                            let path = path.with_offset((
                                position.x as f32 + x_offset,
                                position.y as f32 + y_offset,
                            ));
                            canvas.draw_path(&path, paint);
                        }
                    }
                };

                canvas.save();
                canvas.concat(&matrix);
                if run.paint_style.emboss || run.paint_style.engrave {
                    let offset = (run.paint_style.font_size as f32 / 20.0).max(1.0);
                    if run.paint_style.emboss {
                        draw_glyph_paths(&highlight_paint, -offset, -offset);
                        draw_glyph_paths(&relief_shadow_paint, offset, offset);
                    } else {
                        draw_glyph_paths(&relief_shadow_paint, -offset, -offset);
                        draw_glyph_paths(&highlight_paint, offset, offset);
                    }
                    draw_glyph_paths(&fill_paint, 0.0, 0.0);
                } else {
                    if run.paint_style.shadow_type > 0 {
                        draw_glyph_paths(
                            &shadow_paint,
                            run.paint_style.shadow_offset_x as f32,
                            run.paint_style.shadow_offset_y as f32,
                        );
                    }
                    if run.paint_style.outline_type > 0 {
                        draw_glyph_paths(&highlight_paint, 0.0, 0.0);
                        draw_glyph_paths(&stroke_paint, 0.0, 0.0);
                    } else {
                        draw_glyph_paths(&fill_paint, 0.0, 0.0);
                    }
                }
                canvas.restore();
            }
            PaintOp::GlyphOutline { bbox, outline } => {
                self.render_glyph_outline(canvas, *bbox, outline, resources, replay);
            }
            PaintOp::CharOverlap { bbox, overlap } => {
                let mut run = crate::paint::LayerTextRunPaint {
                    source: overlap.source.clone(),
                    text: overlap.text.clone(),
                    display_text: None,
                    style: overlap.style.clone(),
                    positions: overlap.positions.clone(),
                    baseline: overlap.baseline,
                    rotation: overlap.rotation,
                    is_vertical: overlap.is_vertical,
                    orientation: overlap.orientation,
                    char_overlap: Some(overlap.overlap.clone()),
                    ..Default::default()
                };
                run.projection = crate::paint::TextProjectionKind::SyntheticVisual;
                let rotation = run.rotation;
                if rotation != 0.0 {
                    let cx = (bbox.x + bbox.width / 2.0) as f32;
                    let cy = (bbox.y + bbox.height / 2.0) as f32;
                    canvas.save();
                    canvas.rotate(rotation as f32, Some((cx, cy).into()));
                    self.render_text_run(canvas, bbox, &run, replay);
                    canvas.restore();
                } else {
                    self.render_text_run(canvas, bbox, &run, replay);
                }
            }
            PaintOp::TextControlMark { bbox, mark } => {
                if mark.rotation != 0.0 {
                    let cx = (bbox.x + bbox.width / 2.0) as f32;
                    let cy = (bbox.y + bbox.height / 2.0) as f32;
                    canvas.save();
                    canvas.rotate(mark.rotation as f32, Some((cx, cy).into()));
                    self.render_text_control_mark(canvas, bbox, &mark.mark, 0.0, replay);
                    canvas.restore();
                } else {
                    self.render_text_control_mark(canvas, bbox, &mark.mark, 0.0, replay);
                }
            }
            PaintOp::TabLeader { bbox, leader } => {
                let run = crate::paint::LayerTextRunPaint {
                    text: String::new(),
                    display_text: None,
                    style: crate::renderer::TextStyle {
                        color: leader.color,
                        font_size: leader.font_size,
                        tab_leaders: vec![leader.leader.clone()],
                        ..Default::default()
                    },
                    baseline: leader.baseline,
                    ..Default::default()
                };
                if leader.rotation != 0.0 {
                    let cx = (bbox.x + bbox.width / 2.0) as f32;
                    let cy = (bbox.y + bbox.height / 2.0) as f32;
                    canvas.save();
                    canvas.rotate(leader.rotation as f32, Some((cx, cy).into()));
                    self.render_text_run(canvas, bbox, &run, replay);
                    canvas.restore();
                } else {
                    self.render_text_run(canvas, bbox, &run, replay);
                }
            }
            PaintOp::TextDecoration { bbox, decoration } => {
                let rotation = decoration.rotation;
                if rotation != 0.0 {
                    let cx = (bbox.x + bbox.width / 2.0) as f32;
                    let cy = (bbox.y + bbox.height / 2.0) as f32;
                    canvas.save();
                    canvas.rotate(rotation as f32, Some((cx, cy).into()));
                    self.render_text_decoration(canvas, bbox, decoration);
                    canvas.restore();
                } else {
                    self.render_text_decoration(canvas, bbox, decoration);
                }
            }
            PaintOp::FootnoteMarker { bbox, marker } => {
                let mut font = self.font_resolver.make_font(
                    &crate::renderer::TextStyle {
                        font_family: marker.font_family.clone(),
                        font_size: (marker.base_font_size * 0.55).max(7.0),
                        color: marker.color,
                        ..Default::default()
                    },
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
                                replay.vector_antialias(),
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
                                replay.vector_antialias(),
                            );
                            x2 -= ux * arrow_w;
                            y2 -= uy * arrow_w;
                        }
                    }

                    let mut paint = make_line_paint(&line.style);
                    paint.set_anti_alias(replay.vector_antialias());
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
                    if let Some(mut fill) =
                        make_fill_paint(sk_rect, &rect.style, rect.gradient.as_deref())
                    {
                        fill.set_anti_alias(replay.vector_antialias());
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
                    if let Some(mut stroke) = make_stroke_paint(&rect.style) {
                        stroke.set_anti_alias(replay.vector_antialias());
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
                    if let Some(mut fill) =
                        make_fill_paint(oval, &ellipse.style, ellipse.gradient.as_deref())
                    {
                        fill.set_anti_alias(replay.vector_antialias());
                        canvas.draw_oval(oval, &fill);
                    }
                    if let Some(mut stroke) = make_stroke_paint(&ellipse.style) {
                        stroke.set_anti_alias(replay.vector_antialias());
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
                    if let Some(mut fill) =
                        make_fill_paint(path_bounds, &path.style, path.gradient.as_deref())
                    {
                        fill.set_anti_alias(replay.vector_antialias());
                        canvas.draw_path(&sk_path, &fill);
                    }
                    if let Some(mut stroke) = make_stroke_paint(&path.style) {
                        stroke.set_anti_alias(replay.vector_antialias());
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
                                replay.vector_antialias(),
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
                                replay.vector_antialias(),
                            );
                        }
                    }
                });
            }
            PaintOp::Image { bbox, image } => {
                let effective_bbox = image.transform.effective_image_bbox(bbox);
                self.with_shape_transform(
                    canvas,
                    image.transform,
                    Some(effective_bbox),
                    |canvas| {
                        if let Some(resource_id) = image.resource_id {
                            if let Some(data) = resources.image_bytes(resource_id) {
                                if let Some(decoded) = replay.image_for_resource_at_size(
                                    resource_id,
                                    data,
                                    effective_bbox.width as f32,
                                    effective_bbox.height as f32,
                                ) {
                                    let binary_effect_image = replay
                                        .binary_effect_image_for_replay(
                                            resource_id,
                                            data,
                                            &decoded,
                                            image.effect,
                                        );
                                    let (draw_image, effect, sampling) =
                                        if let Some(effect_image) = binary_effect_image.as_ref() {
                                            (
                                                effect_image,
                                                ImageEffect::RealPic,
                                                ImageSampling::nearest(),
                                            )
                                        } else {
                                            (&decoded, image.effect, replay.image_sampling())
                                        };
                                    let diagnostics = draw_decoded_image_with_crop_reference(
                                        canvas,
                                        draw_image,
                                        effective_bbox.x as f32,
                                        effective_bbox.y as f32,
                                        effective_bbox.width as f32,
                                        effective_bbox.height as f32,
                                        image.fill_mode,
                                        image
                                            .original_size
                                            .or_else(|| embedded_svg_intrinsic_size(data)),
                                        image.crop,
                                        image.original_size_hu,
                                        effect,
                                        image.brightness,
                                        image.contrast,
                                        sampling,
                                    );
                                    replay.record_image_draw(diagnostics);
                                } else {
                                    draw_missing_image_placeholder(
                                        canvas,
                                        effective_bbox.x as f32,
                                        effective_bbox.y as f32,
                                        effective_bbox.width as f32,
                                        effective_bbox.height as f32,
                                    );
                                }
                            } else {
                                draw_missing_image_placeholder(
                                    canvas,
                                    effective_bbox.x as f32,
                                    effective_bbox.y as f32,
                                    effective_bbox.width as f32,
                                    effective_bbox.height as f32,
                                );
                            }
                        } else {
                            draw_missing_image_placeholder(
                                canvas,
                                effective_bbox.x as f32,
                                effective_bbox.y as f32,
                                effective_bbox.width as f32,
                                effective_bbox.height as f32,
                            );
                        }
                    },
                );
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
                            0,
                            0,
                            replay.image_sampling(),
                        );
                        replay.record_image_draw(diagnostics);
                        rendered = true;
                    }
                }
                if !rendered {
                    render_equation_with_resolver(
                        canvas,
                        &self.font_resolver,
                        &equation.layout_box,
                        bbox.x,
                        bbox.y,
                        equation.color,
                        equation.font_size,
                    );
                }
            }
            PaintOp::FormObject { bbox, form } => {
                form_replay::render_form_object(canvas, &self.font_resolver, bbox, form)
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

#[cfg(test)]
mod embedded_svg_image_tests {
    use super::*;
    use crate::model::style::ImageFillMode;
    use crate::paint::{
        LayerImagePaint, LayerNode, LayerPageBackgroundImagePaint, LayerPageBackgroundPaint,
    };
    use crate::renderer::render_tree::ShapeTransform;
    use resvg::tiny_skia;

    fn render_svg_ops(
        svg: &[u8],
        page_width: f64,
        page_height: f64,
        ops: Vec<PaintOp>,
        scale: f64,
    ) -> tiny_skia::Pixmap {
        let mut resources = ResourceArena::default();
        let resource_id = resources.intern_image_bytes(svg);
        let ops = ops
            .into_iter()
            .map(|op| match op {
                PaintOp::Image { bbox, mut image } => {
                    image.resource_id = Some(resource_id);
                    PaintOp::Image { bbox, image }
                }
                PaintOp::PageBackground {
                    bbox,
                    mut background,
                } => {
                    if let Some(image) = background.image.as_mut() {
                        image.resource_id = resource_id;
                    }
                    PaintOp::PageBackground { bbox, background }
                }
                other => other,
            })
            .collect();
        let tree = PageLayerTree::with_resources(
            page_width,
            page_height,
            LayerNode::leaf(
                BoundingBox::new(0.0, 0.0, page_width, page_height),
                None,
                ops,
            ),
            resources,
        );
        let output = SkiaLayerRenderer::new()
            .render_raster_with_options(
                &tree,
                RasterRenderOptions {
                    scale,
                    ..RasterRenderOptions::default()
                },
            )
            .expect("render embedded SVG");
        tiny_skia::Pixmap::decode_png(&output.bytes).expect("decode rendered PNG")
    }

    #[test]
    fn paint_image_replays_embedded_svg_at_output_scale() {
        let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 6"><rect width="8" height="6" fill="#00ff00"/></svg>"##;
        let pixmap = render_svg_ops(
            svg,
            8.0,
            6.0,
            vec![PaintOp::Image {
                bbox: BoundingBox::new(0.0, 0.0, 8.0, 6.0),
                image: LayerImagePaint {
                    resource_id: None,
                    external_path: None,
                    text_wrap: None,
                    fill_mode: Some(ImageFillMode::FitToSize),
                    original_size: Some((8.0, 6.0)),
                    crop: None,
                    original_size_hu: None,
                    brightness: 0,
                    contrast: 0,
                    effect: ImageEffect::RealPic,
                    transform: ShapeTransform::default(),
                },
            }],
            2.0,
        );

        assert_eq!((pixmap.width(), pixmap.height()), (16, 12));
        let center = pixmap.pixels()[6 * 16 + 8];
        assert!(center.green() > 240);
        assert!(center.red() < 16);
    }

    #[test]
    fn page_background_replays_embedded_svg() {
        let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 6 4"><rect width="6" height="4" fill="#ff0000"/></svg>"##;
        let pixmap = render_svg_ops(
            svg,
            6.0,
            4.0,
            vec![PaintOp::PageBackground {
                bbox: BoundingBox::new(0.0, 0.0, 6.0, 4.0),
                background: LayerPageBackgroundPaint {
                    background_color: None,
                    border_color: None,
                    border_width: 0.0,
                    gradient: None,
                    image: Some(LayerPageBackgroundImagePaint {
                        resource_id: crate::paint::ImageResourceId(0),
                        fill_mode: ImageFillMode::FitToSize,
                        brightness: 0,
                        contrast: 0,
                        effect: ImageEffect::RealPic,
                        opacity: 1.0,
                    }),
                },
            }],
            1.0,
        );

        let center = pixmap.pixels()[2 * 6 + 3];
        assert!(center.red() > 240);
        assert!(center.green() < 16);
    }

    #[test]
    fn page_background_svg_tiling_uses_intrinsic_dimensions() {
        let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" width="2" height="1" viewBox="0 0 2 1"><rect width="1" height="1" fill="#ff0000"/><rect x="1" width="1" height="1" fill="#0000ff"/></svg>"##;
        let pixmap = render_svg_ops(
            svg,
            6.0,
            1.0,
            vec![PaintOp::PageBackground {
                bbox: BoundingBox::new(0.0, 0.0, 6.0, 1.0),
                background: LayerPageBackgroundPaint {
                    background_color: None,
                    border_color: None,
                    border_width: 0.0,
                    gradient: None,
                    image: Some(LayerPageBackgroundImagePaint {
                        resource_id: crate::paint::ImageResourceId(0),
                        fill_mode: ImageFillMode::TileAll,
                        brightness: 0,
                        contrast: 0,
                        effect: ImageEffect::RealPic,
                        opacity: 1.0,
                    }),
                },
            }],
            1.0,
        );

        let pixels = pixmap.pixels();
        assert!(
            pixels[0].red() > pixels[0].blue(),
            "unexpected tile samples: {pixels:?}"
        );
        assert!(
            pixels[1].blue() > pixels[1].red(),
            "unexpected tile samples: {pixels:?}"
        );
        assert_eq!(pixels[0], pixels[2]);
        assert_eq!(pixels[0], pixels[4]);
        assert_eq!(pixels[1], pixels[3]);
        assert_eq!(pixels[1], pixels[5]);
    }
}
