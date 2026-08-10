use super::{
    make_font, native_skia_glyph_run_font, raster_dimension, SkiaLayerRenderer,
    MAX_STATIC_PICTURE_CACHE_BYTES, MAX_STATIC_PICTURE_CACHE_ENTRIES,
};
use crate::model::image::ImageEffect;
use crate::model::style::UnderlineType;
use crate::paint::{
    decode_colrv0_color_layers_payload, decode_font_bitmap_glyph_payload,
    decode_font_svg_glyph_payload, BinaryResourceKind, BinaryResourceRef, BitmapAlphaMode,
    BitmapGlyphFiltering, BitmapGlyphPayload, BitmapGlyphScalingPolicy, BitmapStrikeSelection,
    CacheHint, ClipKind, ColorGlyphFormat, ColorGradientStop, ColorLayerNode, ColorLayersPayload,
    ColorLinearGradient, ColorPaintClipNode, ColorPaintCompositeMode, ColorPaintCompositeNode,
    ColorPaintGraphNode, ColorPaintGraphNodeKind, ColorPaintGraphPayload,
    ColorPaintLinearGradientPathNode, ColorPaintRadialGradientPathNode, ColorPaintSolidPathNode,
    ColorPaintSweepGradientPathNode, ColorPaintTransformNode, ColorRadialGradient,
    ColorSweepGradient, Colrv0ColorLayersDecodeOptions, FontBitmapGlyphDecodeOptions, FontBlobKey,
    FontBlobResource, FontColorGlyphRef, FontDigest, FontFaceKey, FontFaceResource,
    FontFallbackPolicyId, FontInstanceKey, FontPortability, FontResourceSource,
    FontSvgGlyphDecodeOptions, GlyphCluster, GlyphOutlineFillRule, GlyphOutlinePaintOrder,
    GlyphOutlinePayloadKind, GlyphOutlineStrokeCap, GlyphOutlineStrokeJoin,
    GlyphOutlineStrokeStyle, GlyphRange, GlyphRunDiagnostics, GlyphRunOrientation,
    GlyphRunReplayEligibility, GlyphTransform, ImageResourceId, LayerAffineTransform, LayerBuilder,
    LayerGlyphOutlinePaint, LayerGlyphOutlinePath, LayerGlyphRunPaint, LayerImagePaint,
    LayerLinePaint, LayerNode, LayerNodeKind, LayerOutputOptions, LayerPageBackgroundImagePaint,
    LayerPageBackgroundPaint, LayerPathPaint, LayerPoint, LayerRectanglePaint, LayerSemantic,
    LayerTabLeaderPaint, LayerTextOrientation, LayerTextRunPaint, LocalizedName, PageLayerTree,
    PaintOp, PaintReplayPlane, PaintTextStyle, PaintVariantMeta, RenderProfile, ResolvedColor,
    ResourceArena, ShapeKey, ShapingEngineId, SvgGlyphPayload, SvgGlyphSecurityMode,
    SvgGlyphViewBox, SvgResourceId, TextDirection, TextRunPlacement, TextSourceId, TextSourceRange,
    TextSourceSpan, TextVariantKind, TextVariantQuality, VariationAxisValue, WritingMode,
};
use crate::renderer::composer::CharOverlapInfo;
use crate::renderer::layer_renderer::{
    select_text_variant_sets_with_report, should_render_selected_text_variant, RasterRenderOptions,
    VariantRejectReason, VariantReplayStatus, VariantSelectedReason, VariantSelectionBackend,
    VariantSelectionContext,
};
use crate::renderer::render_tree::{
    BoundingBox, EllipseNode, LineNode, PageNode, PathNode, RectangleNode, RenderNode,
    RenderNodeType, ShapeTransform, TableNode, TextRunNode,
};
use crate::renderer::skia::cache::StaticPictureCache;
use crate::renderer::skia::cache::StaticPictureCacheKey;
use crate::renderer::skia::cache_key::StaticSubtreeCacheKey;
use crate::renderer::skia::image_conv::ImageSampling;
use crate::renderer::skia::replay_context::{
    ImageEffectResourceCacheKey, SkiaReplayContext, MAX_IMAGE_EFFECT_CACHE_BYTES,
    MAX_IMAGE_EFFECT_CACHE_ENTRIES,
};
use crate::renderer::{
    ArrowStyle, LineRenderType, LineStyle, PathCommand, ShapeStyle, StrokeDash, TabLeaderInfo,
    TabStop, TextStyle,
};
use resvg::tiny_skia;
use skia_safe::{Color, Paint, PictureRecorder, Point, Rect};

#[derive(Debug, Clone, Copy)]
struct AlphaBounds {
    min_x: u32,
    min_y: u32,
    max_x: u32,
    max_y: u32,
}

impl AlphaBounds {
    fn width(self) -> u32 {
        self.max_x - self.min_x + 1
    }

    fn height(self) -> u32 {
        self.max_y - self.min_y + 1
    }
}

fn alpha_bounds(pixmap: &tiny_skia::Pixmap) -> Option<AlphaBounds> {
    let width = pixmap.width();
    let mut bounds: Option<AlphaBounds> = None;
    for (index, pixel) in pixmap.pixels().iter().enumerate() {
        if pixel.alpha() == 0 {
            continue;
        }
        let x = index as u32 % width;
        let y = index as u32 / width;
        bounds = Some(match bounds {
            Some(current) => AlphaBounds {
                min_x: current.min_x.min(x),
                min_y: current.min_y.min(y),
                max_x: current.max_x.max(x),
                max_y: current.max_y.max(y),
            },
            None => AlphaBounds {
                min_x: x,
                min_y: y,
                max_x: x,
                max_y: y,
            },
        });
    }
    bounds
}

fn count_pixels_matching(
    pixmap: &tiny_skia::Pixmap,
    predicate: impl Fn(&tiny_skia::PremultipliedColorU8) -> bool,
) -> usize {
    pixmap
        .pixels()
        .iter()
        .filter(|pixel| predicate(pixel))
        .count()
}

fn glyph_variant_test_tree(
    glyph_ids: &[u16],
    replay_eligibility: GlyphRunReplayEligibility,
) -> PageLayerTree {
    assert!(!glyph_ids.is_empty());
    let text = "A".repeat(glyph_ids.len());
    let source = TextSourceSpan {
        id: TextSourceId(0),
        utf8_range: TextSourceRange::new(0, text.len() as u32),
        utf16_range: TextSourceRange::new(0, glyph_ids.len() as u32),
        stable_source_key: None,
    };
    let text_variant = PaintVariantMeta::text_run_default("text-0");
    let style = TextStyle {
        font_family: "sans-serif".to_string(),
        font_size: 32.0,
        color: 0x00000000,
        ..Default::default()
    };
    let bbox = BoundingBox::new(0.0, 0.0, 190.0, 82.0);
    let mut resources = ResourceArena::default();
    if replay_eligibility == GlyphRunReplayEligibility::Portable {
        let digest = FontDigest {
            algorithm: "sha256".to_string(),
            value: "test-font-digest".to_string(),
        };
        let data_ref = BinaryResourceRef {
            kind: BinaryResourceKind::FontBlob,
            id: "font-blob-0".to_string(),
        };
        resources.font_resources_mut().blobs.push(FontBlobResource {
            id: FontBlobKey("font-blob-0".to_string()),
            digest: Some(digest.clone()),
            source: FontResourceSource::Bundled,
            data_ref: Some(data_ref.clone()),
            portability: FontPortability::PortableBlob { digest, data_ref },
        });
        resources.font_resources_mut().faces.push(FontFaceResource {
            id: FontFaceKey("test-face".to_string()),
            blob_key: FontBlobKey("font-blob-0".to_string()),
            face_index: 0,
            postscript_name: Some("TestFace".to_string()),
            family_names: Vec::new(),
            style_names: Vec::new(),
            weight_class: None,
            width_class: None,
            italic: None,
        });
    }

    let mut ops = vec![PaintOp::TextRun {
        bbox,
        run: LayerTextRunPaint {
            source: Some(source.clone()),
            variant: Some(text_variant),
            text: text.clone(),
            display_text: None,
            style: style.clone(),
            positions: (0..=glyph_ids.len())
                .map(|idx| 118.0 + idx as f64 * 32.0)
                .collect(),
            baseline: 54.0,
            ..Default::default()
        },
    }];
    for (idx, glyph_id) in glyph_ids.iter().copied().enumerate() {
        let start = idx as u32;
        let end = start + 1;
        ops.push(PaintOp::GlyphRun {
            bbox,
            run: LayerGlyphRunPaint {
                source: TextSourceSpan {
                    id: source.id,
                    utf8_range: TextSourceRange::new(start, end),
                    utf16_range: TextSourceRange::new(start, end),
                    stable_source_key: None,
                },
                variant: PaintVariantMeta {
                    equivalence_group: "text-0".to_string(),
                    variant_id: "glyphRun".to_string(),
                    variant_kind: TextVariantKind::GlyphRun,
                    part_index: idx as u32,
                    part_count: glyph_ids.len() as u32,
                    is_default_fallback: false,
                    requires: vec!["fontResources".to_string(), "text.glyphRun".to_string()],
                    quality: Some(TextVariantQuality::Exact),
                    anchor_op_id: None,
                    local_paint_order: None,
                },
                paint_style: PaintTextStyle::from(&style),
                shape_key: ShapeKey {
                    font_instance: FontInstanceKey {
                        face_key: FontFaceKey("test-face".to_string()),
                        size_px: 32.0,
                        variations: Vec::new(),
                        synthetic_bold: false,
                        synthetic_italic: false,
                    },
                    direction: TextDirection::Ltr,
                    writing_mode: WritingMode::HorizontalTb,
                    script: None,
                    language: None,
                    features: Vec::new(),
                    shaping_engine: ShapingEngineId("test-shaper".to_string()),
                    fallback_policy: FontFallbackPolicyId("test-fallback".to_string()),
                },
                placement: TextRunPlacement {
                    run_to_page: LayerAffineTransform {
                        a: 1.0,
                        b: 0.0,
                        c: 0.0,
                        d: 1.0,
                        e: 28.0 + idx as f64 * 36.0,
                        f: 56.0,
                    },
                    baseline_y: 0.0,
                },
                glyph_ids: vec![u32::from(glyph_id)],
                positions: vec![LayerPoint { x: 0.0, y: 0.0 }],
                advances: None,
                clusters: vec![GlyphCluster {
                    source_range_utf8: TextSourceRange::new(start, end),
                    source_range_utf16: Some(TextSourceRange::new(start, end)),
                    text_range_utf8: Some(TextSourceRange::new(start, end)),
                    glyph_range: GlyphRange::new(0, 1),
                    flags: Vec::new(),
                }],
                direction: TextDirection::Ltr,
                bidi_level: None,
                writing_mode: WritingMode::HorizontalTb,
                orientation: GlyphRunOrientation::Horizontal,
                glyph_transforms: None,
                diagnostics: GlyphRunDiagnostics {
                    quality: TextVariantQuality::Exact,
                    replay_eligibility,
                    strict_visual_eligible: replay_eligibility
                        == GlyphRunReplayEligibility::Portable,
                    max_origin_delta_px: 0.0,
                    max_advance_delta_px: 0.0,
                    max_residual_after_adjustment_px: 0.0,
                    cluster_mismatch_count: 0,
                    missing_glyph_count: 0,
                    used_fallback_font_count: 0,
                    reason: None,
                },
            },
        });
    }

    PageLayerTree::with_resources(190.0, 82.0, LayerNode::leaf(bbox, None, ops), resources)
}

fn glyph_outline_variant_test_tree(
    outline: LayerGlyphOutlinePaint,
    fallback_visible: bool,
) -> PageLayerTree {
    glyph_outline_variant_test_tree_with_resources(
        outline,
        fallback_visible,
        ResourceArena::default(),
    )
}

fn glyph_outline_variant_test_tree_with_resources(
    outline: LayerGlyphOutlinePaint,
    fallback_visible: bool,
    resources: ResourceArena,
) -> PageLayerTree {
    glyph_outline_variant_test_tree_with_bbox_and_resources(
        outline,
        fallback_visible,
        resources,
        BoundingBox::new(0.0, 0.0, 190.0, 82.0),
        190.0,
        82.0,
    )
}

fn glyph_outline_variant_test_tree_with_bbox_and_resources(
    outline: LayerGlyphOutlinePaint,
    fallback_visible: bool,
    resources: ResourceArena,
    bbox: BoundingBox,
    page_width: f64,
    page_height: f64,
) -> PageLayerTree {
    let source = outline.source.clone();
    let fallback_style = TextStyle {
        font_family: "sans-serif".to_string(),
        font_size: 32.0,
        color: 0x000000,
        ..Default::default()
    };
    PageLayerTree::with_resources(
        page_width,
        page_height,
        LayerNode::leaf(
            bbox,
            None,
            vec![
                PaintOp::TextRun {
                    bbox,
                    run: LayerTextRunPaint {
                        source: Some(source),
                        variant: Some(PaintVariantMeta {
                            equivalence_group: "text-0".to_string(),
                            variant_id: "textRun".to_string(),
                            variant_kind: TextVariantKind::TextRun,
                            part_index: 0,
                            part_count: 1,
                            is_default_fallback: true,
                            requires: Vec::new(),
                            quality: None,
                            anchor_op_id: None,
                            local_paint_order: None,
                        }),
                        text: if fallback_visible {
                            "A".to_string()
                        } else {
                            String::new()
                        },
                        display_text: None,
                        style: fallback_style,
                        positions: if fallback_visible {
                            vec![118.0, 150.0]
                        } else {
                            Vec::new()
                        },
                        baseline: 54.0,
                        ..Default::default()
                    },
                },
                PaintOp::GlyphOutline {
                    bbox,
                    outline: Box::new(outline),
                },
            ],
        ),
        resources,
    )
}

fn glyph_outline_sidecar_variant_test_tree(
    outline: LayerGlyphOutlinePaint,
    fallback_visible: bool,
) -> PageLayerTree {
    let bbox = BoundingBox::new(0.0, 0.0, 190.0, 82.0);
    PageLayerTree::builder(
        190.0,
        82.0,
        LayerNode::leaf(
            bbox,
            None,
            vec![PaintOp::TextRun {
                bbox,
                run: LayerTextRunPaint {
                    source: Some(outline.source.clone()),
                    variant: Some(PaintVariantMeta::text_run_default("text-0")),
                    text: if fallback_visible {
                        "A".to_string()
                    } else {
                        String::new()
                    },
                    display_text: None,
                    style: TextStyle {
                        font_family: "sans-serif".to_string(),
                        font_size: 32.0,
                        color: 0x000000,
                        ..Default::default()
                    },
                    positions: if fallback_visible {
                        vec![118.0, 150.0]
                    } else {
                        Vec::new()
                    },
                    baseline: 54.0,
                    ..Default::default()
                },
            }],
        ),
    )
    .variant_ops(vec![PaintOp::GlyphOutline {
        bbox,
        outline: Box::new(outline),
    }])
    .build()
}

fn glyph_outline_test_paint(
    payload_kind: GlyphOutlinePayloadKind,
    stroke: Option<GlyphOutlineStrokeStyle>,
    color_layers: Option<ColorLayersPayload>,
) -> LayerGlyphOutlinePaint {
    let source = TextSourceSpan {
        id: TextSourceId(0),
        utf8_range: TextSourceRange::new(0, 1),
        utf16_range: TextSourceRange::new(0, 1),
        stable_source_key: None,
    };
    let color_layers_format = color_layers.as_ref().map(|payload| payload.color_format);
    let requires = match payload_kind {
        GlyphOutlinePayloadKind::MonochromeFill => {
            vec!["text.glyphOutline.monochromeFill".to_string()]
        }
        GlyphOutlinePayloadKind::MonochromeFillStroke => {
            vec!["text.glyphOutline.monochromeFillStroke".to_string()]
        }
        GlyphOutlinePayloadKind::ColorLayers => {
            let mut requires = vec!["text.glyphOutline.colorLayers".to_string()];
            requires.push(
                match color_layers_format {
                    Some(ColorGlyphFormat::ColrV1) => "text.glyphOutline.colorLayers.colrV1",
                    _ => "text.glyphOutline.colorLayers.colrV0",
                }
                .to_string(),
            );
            requires
        }
        GlyphOutlinePayloadKind::BitmapGlyph => vec!["text.glyphOutline.bitmapGlyph".to_string()],
        GlyphOutlinePayloadKind::SvgGlyph => vec!["text.glyphOutline.svgGlyph".to_string()],
    };
    LayerGlyphOutlinePaint {
        source: source.clone(),
        variant: PaintVariantMeta {
            equivalence_group: "text-0".to_string(),
            variant_id: "glyphOutline".to_string(),
            variant_kind: TextVariantKind::GlyphOutline,
            part_index: 0,
            part_count: 1,
            is_default_fallback: false,
            requires,
            quality: Some(TextVariantQuality::Exact),
            anchor_op_id: Some("op-text-0".to_string()),
            local_paint_order: Some(0),
        },
        payload_kind,
        stroke,
        color_layers,
        bitmap_glyph: None,
        svg_glyph: None,
        paint_style: PaintTextStyle::from(&TextStyle {
            color: 0x0000ff,
            ..Default::default()
        }),
        placement: TextRunPlacement {
            run_to_page: LayerAffineTransform {
                a: 1.0,
                b: 0.0,
                c: 0.0,
                d: 1.0,
                e: 24.0,
                f: 20.0,
            },
            baseline_y: 0.0,
        },
        paths: if payload_kind == GlyphOutlinePayloadKind::ColorLayers {
            Vec::new()
        } else {
            vec![LayerGlyphOutlinePath {
                glyph_id: 1,
                source_range_utf8: TextSourceRange::new(0, 1),
                glyph_range: GlyphRange::new(0, 1),
                commands: vec![
                    PathCommand::MoveTo(0.0, 0.0),
                    PathCommand::LineTo(30.0, 0.0),
                    PathCommand::LineTo(30.0, 28.0),
                    PathCommand::LineTo(0.0, 28.0),
                    PathCommand::ClosePath,
                ],
                fill_rule: GlyphOutlineFillRule::NonZero,
            }]
        },
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
            reason: None,
        },
    }
}

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
fn raster_output_reports_phase_timing_diagnostics() {
    let rect_bounds = BoundingBox::new(2.0, 2.0, 12.0, 8.0);
    let root = LayerNode::leaf(
        BoundingBox::new(0.0, 0.0, 20.0, 20.0),
        None,
        vec![PaintOp::Rectangle {
            bbox: rect_bounds,
            rect: LayerRectanglePaint {
                corner_radius: 0.0,
                style: ShapeStyle {
                    fill_color: Some(0x0000AA00),
                    ..Default::default()
                },
                gradient: None,
                transform: Default::default(),
            },
        }],
    );
    let tree = PageLayerTree::new(20.0, 20.0, root);
    let renderer = SkiaLayerRenderer::new();
    let output = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("timed raster render");
    let diagnostics = output.diagnostics;
    let phase_sum = diagnostics
        .raster_setup_time_ns
        .saturating_add(diagnostics.raster_replay_time_ns)
        .saturating_add(diagnostics.raster_encode_time_ns);

    assert!(diagnostics.raster_setup_time_ns > 0);
    assert!(diagnostics.raster_replay_time_ns > 0);
    assert!(diagnostics.raster_encode_time_ns > 0);
    assert!(diagnostics.raster_total_time_ns >= phase_sum);
}

#[test]
fn raster_output_accumulates_tile_fallback_diagnostics() {
    use crate::model::image::ImageEffect;
    use crate::model::style::ImageFillMode;
    use crate::renderer::skia::image_conv::with_manual_tile_fallback_for_test;

    let mut pixmap = tiny_skia::Pixmap::new(1, 1).expect("source pixmap");
    pixmap.pixels_mut()[0] = tiny_skia::PremultipliedColorU8::from_rgba(0, 0, 0, 255).unwrap();
    let image_bytes = pixmap.encode_png().expect("source png");
    let mut resources = ResourceArena::default();
    let resource_id = resources.intern_image_bytes(&image_bytes);
    let tree = PageLayerTree::with_resources(
        5000.0,
        1.0,
        LayerNode::leaf(
            BoundingBox::new(0.0, 0.0, 5000.0, 1.0),
            None,
            vec![PaintOp::Image {
                bbox: BoundingBox::new(0.0, 0.0, 5000.0, 1.0),
                image: LayerImagePaint {
                    resource_id: Some(resource_id),
                    external_path: None,
                    text_wrap: None,
                    fill_mode: Some(ImageFillMode::TileAll),
                    original_size: Some((1.0, 1.0)),
                    crop: None,
                    original_size_hu: None,
                    brightness: 0,
                    contrast: 0,
                    effect: ImageEffect::RealPic,
                    transform: ShapeTransform::default(),
                },
            }],
        ),
        resources,
    );
    let renderer = SkiaLayerRenderer::new();
    let output = with_manual_tile_fallback_for_test(|| {
        renderer
            .render_raster_with_options(&tree, RasterRenderOptions::default())
            .expect("render raster")
    });

    assert_eq!(output.diagnostics.tile_fallback_cap_hits, 1);
}

#[test]
fn raster_output_accumulates_binary_image_effect_cache_diagnostics() {
    use crate::model::style::ImageFillMode;

    let mut pixmap = tiny_skia::Pixmap::new(8, 8).expect("source pixmap");
    for pixel in pixmap.pixels_mut() {
        *pixel = tiny_skia::PremultipliedColorU8::from_rgba(126, 126, 126, 255).unwrap();
    }
    let image_bytes = pixmap.encode_png().expect("source png");
    let mut resources = ResourceArena::default();
    let resource_id = resources.intern_image_bytes(&image_bytes);
    let image_op = |x: f64| PaintOp::Image {
        bbox: BoundingBox::new(x, 0.0, 8.0, 8.0),
        image: LayerImagePaint {
            resource_id: Some(resource_id),
            external_path: None,
            text_wrap: None,
            fill_mode: Some(ImageFillMode::FitToSize),
            original_size: Some((8.0, 8.0)),
            crop: None,
            original_size_hu: None,
            brightness: 0,
            contrast: 0,
            effect: ImageEffect::Pattern8x8,
            transform: ShapeTransform::default(),
        },
    };
    let tree = PageLayerTree::with_resources(
        16.0,
        8.0,
        LayerNode::leaf(
            BoundingBox::new(0.0, 0.0, 16.0, 8.0),
            None,
            vec![image_op(0.0), image_op(8.0)],
        ),
        resources,
    );
    let renderer = SkiaLayerRenderer::new();
    let output = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("render raster");

    assert_eq!(output.diagnostics.image_effect_cache_misses, 1);
    assert_eq!(output.diagnostics.image_effect_cache_hits, 1);
    assert_eq!(output.diagnostics.image_effect_cache_evictions, 0);
    assert_eq!(
        output.diagnostics.image_effect_preprocessed_bytes,
        8 * 8 * 4
    );
    assert_eq!(
        output.diagnostics.image_effect_cache_approx_bytes,
        8 * 8 * 4
    );
}

#[test]
fn raster_output_applies_page_background_binary_image_effect() {
    use crate::model::style::ImageFillMode;

    let mut pixmap = tiny_skia::Pixmap::new(8, 8).expect("source pixmap");
    for pixel in pixmap.pixels_mut() {
        *pixel = tiny_skia::PremultipliedColorU8::from_rgba(126, 126, 126, 255).unwrap();
    }
    let image_bytes = pixmap.encode_png().expect("source png");
    let mut resources = ResourceArena::default();
    let resource_id = resources.intern_image_bytes(&image_bytes);
    let tree = PageLayerTree::with_resources(
        8.0,
        8.0,
        LayerNode::leaf(
            BoundingBox::new(0.0, 0.0, 8.0, 8.0),
            None,
            vec![PaintOp::PageBackground {
                bbox: BoundingBox::new(0.0, 0.0, 8.0, 8.0),
                background: LayerPageBackgroundPaint {
                    background_color: None,
                    border_color: None,
                    border_width: 0.0,
                    gradient: None,
                    image: Some(LayerPageBackgroundImagePaint {
                        resource_id,
                        fill_mode: ImageFillMode::FitToSize,
                        brightness: 0,
                        contrast: 0,
                        effect: ImageEffect::Pattern8x8,
                        opacity: 1.0,
                    }),
                },
            }],
        ),
        resources,
    );
    let renderer = SkiaLayerRenderer::new();
    let output = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("render raster");

    assert_eq!(output.diagnostics.image_effect_cache_misses, 1);
    assert_eq!(output.diagnostics.image_effect_cache_hits, 0);
    assert_eq!(
        output.diagnostics.image_effect_preprocessed_bytes,
        8 * 8 * 4
    );
}

#[test]
fn raster_output_composites_page_background_image_opacity() {
    use crate::model::style::ImageFillMode;

    let mut pixmap = tiny_skia::Pixmap::new(1, 1).expect("source pixmap");
    pixmap.pixels_mut()[0] = tiny_skia::PremultipliedColorU8::from_rgba(0, 0, 0, 255).unwrap();
    let image_bytes = pixmap.encode_png().expect("source png");
    let mut resources = ResourceArena::default();
    let resource_id = resources.intern_image_bytes(&image_bytes);
    let tree = PageLayerTree::with_resources(
        1.0,
        1.0,
        LayerNode::leaf(
            BoundingBox::new(0.0, 0.0, 1.0, 1.0),
            None,
            vec![PaintOp::PageBackground {
                bbox: BoundingBox::new(0.0, 0.0, 1.0, 1.0),
                background: LayerPageBackgroundPaint {
                    background_color: Some(0x00FF_FFFF),
                    border_color: None,
                    border_width: 0.0,
                    gradient: None,
                    image: Some(LayerPageBackgroundImagePaint {
                        resource_id,
                        fill_mode: ImageFillMode::FitToSize,
                        brightness: 0,
                        contrast: 0,
                        effect: ImageEffect::RealPic,
                        opacity: 0.25,
                    }),
                },
            }],
        ),
        resources,
    );
    let output = SkiaLayerRenderer::new()
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("render raster");
    let rendered = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");
    let pixel = rendered.pixels()[0];

    assert!(
        (188..=194).contains(&pixel.red())
            && (188..=194).contains(&pixel.green())
            && (188..=194).contains(&pixel.blue())
            && pixel.alpha() == 255,
        "25% black over white should composite to light gray, got rgba({}, {}, {}, {})",
        pixel.red(),
        pixel.green(),
        pixel.blue(),
        pixel.alpha()
    );
}

#[test]
fn raster_output_accumulates_binary_image_effect_cache_eviction_diagnostics() {
    use crate::model::style::ImageFillMode;

    let resource_count = MAX_IMAGE_EFFECT_CACHE_ENTRIES + 1;
    let mut resources = ResourceArena::default();
    let mut ops = Vec::with_capacity(resource_count);
    for index in 0..resource_count {
        let mut pixmap = tiny_skia::Pixmap::new(1, 1).expect("source pixmap");
        pixmap.pixels_mut()[0] = tiny_skia::PremultipliedColorU8::from_rgba(
            (index.wrapping_mul(3) & 0xff) as u8,
            (index.wrapping_mul(5) & 0xff) as u8,
            (index.wrapping_mul(7) & 0xff) as u8,
            255,
        )
        .unwrap();
        let image_bytes = pixmap.encode_png().expect("source png");
        let resource_id = resources.intern_image_bytes(&image_bytes);
        let x = index as f64;
        ops.push(PaintOp::Image {
            bbox: BoundingBox::new(x, 0.0, 1.0, 1.0),
            image: LayerImagePaint {
                resource_id: Some(resource_id),
                external_path: None,
                text_wrap: None,
                fill_mode: Some(ImageFillMode::FitToSize),
                original_size: Some((1.0, 1.0)),
                crop: None,
                original_size_hu: None,
                brightness: 0,
                contrast: 0,
                effect: ImageEffect::Pattern8x8,
                transform: ShapeTransform::default(),
            },
        });
    }

    let tree = PageLayerTree::with_resources(
        resource_count as f64,
        1.0,
        LayerNode::leaf(
            BoundingBox::new(0.0, 0.0, resource_count as f64, 1.0),
            None,
            ops,
        ),
        resources,
    );
    let renderer = SkiaLayerRenderer::new();
    let output = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("render raster");

    assert_eq!(output.diagnostics.image_effect_cache_misses, resource_count);
    assert_eq!(output.diagnostics.image_effect_cache_hits, 0);
    assert_eq!(output.diagnostics.image_effect_cache_evictions, 1);
    assert_eq!(
        output.diagnostics.image_effect_preprocessed_bytes,
        resource_count * 4
    );
    assert_eq!(
        output.diagnostics.image_effect_cache_approx_bytes,
        MAX_IMAGE_EFFECT_CACHE_ENTRIES * 4
    );
    assert!(output.diagnostics.image_effect_cache_approx_bytes <= MAX_IMAGE_EFFECT_CACHE_BYTES);
}

#[test]
fn raster_output_accumulates_binary_image_effect_cache_byte_budget_diagnostics() {
    use crate::model::style::ImageFillMode;

    let mut resources = ResourceArena::default();
    let mut ops = Vec::new();
    for (index, value) in [96_u8, 160_u8].into_iter().enumerate() {
        let mut pixmap = tiny_skia::Pixmap::new(4, 4).expect("source pixmap");
        for pixel in pixmap.pixels_mut() {
            *pixel = tiny_skia::PremultipliedColorU8::from_rgba(value, 126, 224, 255).unwrap();
        }
        let image_bytes = pixmap.encode_png().expect("source png");
        let resource_id = resources.intern_image_bytes(&image_bytes);
        ops.push(PaintOp::Image {
            bbox: BoundingBox::new(index as f64 * 4.0, 0.0, 4.0, 4.0),
            image: LayerImagePaint {
                resource_id: Some(resource_id),
                external_path: None,
                text_wrap: None,
                fill_mode: Some(ImageFillMode::FitToSize),
                original_size: Some((4.0, 4.0)),
                crop: None,
                original_size_hu: None,
                brightness: 0,
                contrast: 0,
                effect: ImageEffect::Pattern8x8,
                transform: ShapeTransform::default(),
            },
        });
    }
    let tree = PageLayerTree::with_resources(
        8.0,
        4.0,
        LayerNode::leaf(BoundingBox::new(0.0, 0.0, 8.0, 4.0), None, ops),
        resources,
    );
    let renderer = SkiaLayerRenderer::new();
    let output = renderer
        .render_raster_with_image_effect_cache_limits_for_test(
            &tree,
            RasterRenderOptions::default(),
            8,
            4 * 4 * 4 + 8,
        )
        .expect("render raster with constrained effect cache");

    assert_eq!(output.diagnostics.image_effect_cache_misses, 2);
    assert_eq!(output.diagnostics.image_effect_cache_hits, 0);
    assert_eq!(output.diagnostics.image_effect_cache_evictions, 1);
    assert_eq!(
        output.diagnostics.image_effect_preprocessed_bytes,
        2 * 4 * 4 * 4
    );
    assert_eq!(
        output.diagnostics.image_effect_cache_approx_bytes,
        4 * 4 * 4
    );
    assert!(output.diagnostics.image_effect_cache_approx_bytes <= 4 * 4 * 4 + 8);
}

#[test]
fn body_clip_policy_allows_right_overflow_slop() {
    let rect_bounds = BoundingBox::new(8.0, 8.0, 8.0, 4.0);
    let leaf = LayerNode::leaf(
        rect_bounds,
        None,
        vec![PaintOp::Rectangle {
            bbox: rect_bounds,
            rect: LayerRectanglePaint {
                corner_radius: 0.0,
                style: ShapeStyle {
                    fill_color: Some(0x000000),
                    ..Default::default()
                },
                gradient: None,
                transform: Default::default(),
            },
        }],
    );
    let root = LayerNode::clip_rect(
        BoundingBox::new(0.0, 0.0, 20.0, 20.0),
        None,
        BoundingBox::new(4.0, 4.0, 8.0, 12.0),
        leaf,
        ClipKind::Body,
    );
    let tree = PageLayerTree::new(20.0, 20.0, root);
    let renderer = SkiaLayerRenderer::new();
    let png = renderer.render_png(&tree).expect("skia clip render");
    let pixmap = tiny_skia::Pixmap::decode_png(&png).expect("png decode");
    let width = pixmap.width() as usize;

    assert!(
        pixmap.pixels()[10 * width + 13].alpha() > 0,
        "body clip should preserve pixels inside the right overflow slop"
    );
    assert_eq!(
        pixmap.pixels()[10 * width + 17].alpha(),
        0,
        "body clip should still reject pixels beyond the slop"
    );
}

#[test]
fn body_overflow_controls_are_composited_once() {
    let mut tree = crate::renderer::render_tree::PageRenderTree::new(0, 120.0, 60.0);
    tree.root.node_type = RenderNodeType::Page(PageNode {
        page_index: 0,
        width: 120.0,
        height: 60.0,
        section_index: 0,
    });
    let mut body = RenderNode::new(
        1,
        RenderNodeType::Body {
            clip_rect: Some(BoundingBox::new(10.0, 10.0, 70.0, 40.0)),
        },
        BoundingBox::new(10.0, 10.0, 70.0, 40.0),
    );
    let mut column = RenderNode::new(
        2,
        RenderNodeType::Column(0),
        BoundingBox::new(10.0, 10.0, 70.0, 40.0),
    );
    column.children.push(RenderNode::new(
        3,
        RenderNodeType::Rectangle(RectangleNode::new(
            0.0,
            ShapeStyle {
                fill_color: Some(0x00FF0000),
                opacity: 0.5,
                ..Default::default()
            },
            None,
        )),
        BoundingBox::new(70.0, 20.0, 30.0, 20.0),
    ));
    body.children.push(column);
    tree.root.children.push(body);

    let mut builder = LayerBuilder::new(RenderProfile::Screen);
    let layer_tree = builder.build(&tree);
    let renderer = SkiaLayerRenderer::new();
    let output = renderer
        .render_raster_with_options(
            &layer_tree,
            RasterRenderOptions {
                transparent: true,
                ..Default::default()
            },
        )
        .expect("body overflow alpha render");
    let pixmap = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");
    let width = pixmap.width() as usize;
    let inside_alpha = pixmap.pixels()[30 * width + 75].alpha();
    let outside_alpha = pixmap.pixels()[30 * width + 90].alpha();

    assert!(
        inside_alpha.abs_diff(outside_alpha) <= 2,
        "inside-body and overflow pixels must have the same single-pass alpha: \
         inside={inside_alpha}, outside={outside_alpha}"
    );
    assert!(
        (120..=136).contains(&inside_alpha),
        "50% opacity should remain a single compositing pass, got alpha {inside_alpha}"
    );
}

#[test]
fn output_options_can_disable_clip_rect_replay() {
    let rect_bounds = BoundingBox::new(8.0, 8.0, 8.0, 4.0);
    let leaf = LayerNode::leaf(
        rect_bounds,
        None,
        vec![PaintOp::Rectangle {
            bbox: rect_bounds,
            rect: LayerRectanglePaint {
                corner_radius: 0.0,
                style: ShapeStyle {
                    fill_color: Some(0x000000),
                    ..Default::default()
                },
                gradient: None,
                transform: Default::default(),
            },
        }],
    );
    let root = LayerNode::clip_rect(
        BoundingBox::new(0.0, 0.0, 20.0, 20.0),
        None,
        BoundingBox::new(0.0, 0.0, 4.0, 20.0),
        leaf,
        ClipKind::Generic,
    );
    let tree = PageLayerTree::new(20.0, 20.0, root).with_output_options(LayerOutputOptions {
        clip_enabled: false,
        ..Default::default()
    });
    let renderer = SkiaLayerRenderer::new();
    let png = renderer
        .render_png(&tree)
        .expect("skia clip-disabled render");
    let pixmap = tiny_skia::Pixmap::decode_png(&png).expect("png decode");
    let width = pixmap.width() as usize;

    assert!(
        pixmap.pixels()[10 * width + 10].alpha() > 0,
        "clip-disabled replay should render pixels outside the ClipRect"
    );
}

#[test]
fn renders_multi_line_type_as_separated_strokes() {
    let render_line = |line_type: LineRenderType| -> usize {
        let mut tree = crate::renderer::render_tree::PageRenderTree::new(0, 120.0, 80.0);
        tree.root.children.push(RenderNode::new(
            1,
            RenderNodeType::Line(LineNode::new(
                15.0,
                40.0,
                105.0,
                40.0,
                LineStyle {
                    color: 0x000000,
                    width: 20.0,
                    dash: StrokeDash::Solid,
                    line_type,
                    start_arrow: ArrowStyle::None,
                    end_arrow: ArrowStyle::None,
                    start_arrow_size: 0,
                    end_arrow_size: 0,
                    shadow: None,
                },
            )),
            BoundingBox::new(15.0, 20.0, 90.0, 40.0),
        ));
        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&tree);
        let renderer = SkiaLayerRenderer::new();
        let png = renderer.render_png(&layer_tree).expect("skia line render");
        let pixmap = tiny_skia::Pixmap::decode_png(&png).expect("png decode");
        pixmap
            .pixels()
            .iter()
            .filter(|pixel| pixel.alpha() > 0)
            .count()
    };

    let single_ink = render_line(LineRenderType::Single);
    let triple_ink = render_line(LineRenderType::ThinThickThinTriple);

    assert!(
            triple_ink < single_ink,
            "expected separated triple line ink ({triple_ink}) to be less than solid single line ink ({single_ink})"
        );
}

#[test]
fn renders_shape_feature_fixture_to_png() {
    let mut tree = crate::renderer::render_tree::PageRenderTree::new(0, 220.0, 180.0);
    let mut next_id = 1;
    let mut push_node = |tree: &mut crate::renderer::render_tree::PageRenderTree,
                         node_type: RenderNodeType,
                         bbox: BoundingBox| {
        tree.root
            .children
            .push(RenderNode::new(next_id, node_type, bbox));
        next_id += 1;
    };
    let line_style = |dash, line_type, start_arrow, end_arrow| LineStyle {
        color: 0x00000000,
        width: 4.0,
        dash,
        line_type,
        start_arrow,
        end_arrow,
        start_arrow_size: 4,
        end_arrow_size: 4,
        shadow: None,
    };

    push_node(
        &mut tree,
        RenderNodeType::Line(LineNode::new(
            14.0,
            18.0,
            200.0,
            18.0,
            line_style(
                StrokeDash::Solid,
                LineRenderType::ThinThickThinTriple,
                ArrowStyle::Arrow,
                ArrowStyle::OpenDiamond,
            ),
        )),
        BoundingBox::new(10.0, 8.0, 196.0, 24.0),
    );
    push_node(
        &mut tree,
        RenderNodeType::Line(LineNode::new(
            18.0,
            44.0,
            206.0,
            44.0,
            line_style(
                StrokeDash::DashDot,
                LineRenderType::Double,
                ArrowStyle::None,
                ArrowStyle::ConcaveArrow,
            ),
        )),
        BoundingBox::new(12.0, 34.0, 200.0, 24.0),
    );

    let mut rect = RectangleNode::new(
        8.0,
        ShapeStyle {
            fill_color: Some(0x00D9E7FF),
            stroke_color: Some(0x00000000),
            stroke_width: 2.0,
            ..Default::default()
        },
        None,
    );
    rect.transform = ShapeTransform {
        rotation: 12.0,
        horz_flip: true,
        vert_flip: false,
    };
    push_node(
        &mut tree,
        RenderNodeType::Rectangle(rect),
        BoundingBox::new(16.0, 70.0, 56.0, 42.0),
    );

    let mut ellipse = EllipseNode::new(
        ShapeStyle {
            fill_color: Some(0x00D5E8D4),
            stroke_color: Some(0x00000000),
            stroke_width: 2.0,
            stroke_dash: StrokeDash::Dot,
            ..Default::default()
        },
        None,
    );
    ellipse.transform = ShapeTransform {
        rotation: -18.0,
        horz_flip: false,
        vert_flip: true,
    };
    push_node(
        &mut tree,
        RenderNodeType::Ellipse(ellipse),
        BoundingBox::new(92.0, 70.0, 58.0, 42.0),
    );

    let mut path = PathNode::new(
        vec![
            PathCommand::MoveTo(26.0, 148.0),
            PathCommand::CurveTo(58.0, 116.0, 88.0, 178.0, 118.0, 142.0),
            PathCommand::ArcTo(26.0, 18.0, 0.0, false, true, 172.0, 142.0),
        ],
        ShapeStyle {
            fill_color: None,
            stroke_color: Some(0x00000000),
            stroke_width: 3.0,
            stroke_dash: StrokeDash::Dash,
            ..Default::default()
        },
        None,
    );
    path.connector_endpoints = Some((26.0, 148.0, 172.0, 142.0));
    path.line_style = Some(line_style(
        StrokeDash::Dash,
        LineRenderType::Single,
        ArrowStyle::Circle,
        ArrowStyle::Arrow,
    ));
    push_node(
        &mut tree,
        RenderNodeType::Path(path),
        BoundingBox::new(20.0, 112.0, 160.0, 52.0),
    );

    let mut builder = LayerBuilder::new(RenderProfile::Screen);
    let layer_tree = builder.build(&tree);
    let renderer = SkiaLayerRenderer::new();
    let png = renderer
        .render_png(&layer_tree)
        .expect("shape feature fixture render");
    let pixmap = tiny_skia::Pixmap::decode_png(&png).expect("shape fixture png decode");
    let ink_pixels = pixmap
        .pixels()
        .iter()
        .filter(|pixel| pixel.alpha() > 0)
        .count();

    assert!(
        ink_pixels > 800,
        "expected visible shape feature fixture ink"
    );
}

#[test]
fn static_subtree_hint_records_picture_cache() {
    let rect_bounds = BoundingBox::new(5.0, 5.0, 20.0, 10.0);
    let leaf = LayerNode::leaf(
        rect_bounds,
        Some(2),
        vec![PaintOp::Rectangle {
            bbox: rect_bounds,
            rect: LayerRectanglePaint {
                corner_radius: 0.0,
                style: ShapeStyle {
                    fill_color: Some(0x00AA00),
                    ..Default::default()
                },
                gradient: None,
                transform: Default::default(),
            },
        }],
    );
    let root = LayerNode::group(
        BoundingBox::new(0.0, 0.0, 40.0, 20.0),
        Some(1),
        vec![leaf],
        CacheHint::StaticSubtree,
        LayerSemantic::default(),
    );
    let tree = PageLayerTree::new(40.0, 20.0, root);
    let renderer = SkiaLayerRenderer::new();

    assert_eq!(renderer.static_picture_cache.borrow().len(), 0);
    renderer.render_png(&tree).expect("first skia render");
    assert_eq!(renderer.static_picture_cache.borrow().len(), 1);
    renderer.render_png(&tree).expect("cached skia render");
    assert_eq!(renderer.static_picture_cache.borrow().len(), 1);
}

#[test]
fn static_subtree_picture_cache_preserves_clip_for_transformed_child() {
    let rect_bounds = BoundingBox::new(4.0, 4.0, 20.0, 10.0);
    let leaf = LayerNode::leaf(
        BoundingBox::new(0.0, 0.0, 32.0, 24.0),
        Some(3),
        vec![PaintOp::Rectangle {
            bbox: rect_bounds,
            rect: LayerRectanglePaint {
                corner_radius: 0.0,
                style: ShapeStyle {
                    fill_color: Some(0x000000),
                    ..Default::default()
                },
                gradient: None,
                transform: ShapeTransform {
                    rotation: 25.0,
                    horz_flip: false,
                    vert_flip: false,
                },
            },
        }],
    );
    let cached_group = LayerNode::group(
        BoundingBox::new(0.0, 0.0, 32.0, 24.0),
        Some(2),
        vec![leaf],
        CacheHint::StaticSubtree,
        LayerSemantic::default(),
    );
    let root = LayerNode::clip_rect(
        BoundingBox::new(0.0, 0.0, 32.0, 24.0),
        Some(1),
        BoundingBox::new(6.0, 4.0, 14.0, 14.0),
        cached_group,
        ClipKind::Generic,
    );
    let tree = PageLayerTree::new(32.0, 24.0, root);
    let renderer = SkiaLayerRenderer::new();

    let first_png = renderer.render_png(&tree).expect("first clipped render");
    assert_eq!(renderer.static_picture_cache.borrow().len(), 1);
    let second_png = renderer.render_png(&tree).expect("cached clipped render");
    assert_eq!(renderer.static_picture_cache.borrow().len(), 1);

    let first = tiny_skia::Pixmap::decode_png(&first_png).expect("first png decode");
    let second = tiny_skia::Pixmap::decode_png(&second_png).expect("second png decode");
    assert_eq!(
        first.data(),
        second.data(),
        "static picture cache hit should preserve clip output"
    );

    let width = first.width() as usize;
    assert!(
        first.pixels()[9 * width + 14].alpha() > 0,
        "transformed child should remain visible inside the clip"
    );
    assert_eq!(
        first.pixels()[9 * width + 22].alpha(),
        0,
        "static subtree replay must not leak transformed child pixels outside the clip"
    );
}

#[test]
fn static_subtree_picture_cache_respects_distinct_external_clip_scopes() {
    let rect_bounds = BoundingBox::new(2.0, 4.0, 28.0, 12.0);
    let leaf = LayerNode::leaf(
        BoundingBox::new(0.0, 0.0, 32.0, 20.0),
        Some(3),
        vec![PaintOp::Rectangle {
            bbox: rect_bounds,
            rect: LayerRectanglePaint {
                corner_radius: 0.0,
                style: ShapeStyle {
                    fill_color: Some(0x000000),
                    ..Default::default()
                },
                gradient: None,
                transform: Default::default(),
            },
        }],
    );
    let static_group = LayerNode::group(
        BoundingBox::new(0.0, 0.0, 32.0, 20.0),
        Some(2),
        vec![leaf],
        CacheHint::StaticSubtree,
        LayerSemantic::default(),
    );
    let root = LayerNode::group(
        BoundingBox::new(0.0, 0.0, 32.0, 20.0),
        None,
        vec![
            LayerNode::clip_rect(
                BoundingBox::new(0.0, 0.0, 32.0, 20.0),
                Some(10),
                BoundingBox::new(2.0, 4.0, 8.0, 12.0),
                static_group.clone(),
                ClipKind::Generic,
            ),
            LayerNode::clip_rect(
                BoundingBox::new(0.0, 0.0, 32.0, 20.0),
                Some(11),
                BoundingBox::new(22.0, 4.0, 8.0, 12.0),
                static_group,
                ClipKind::Generic,
            ),
        ],
        CacheHint::None,
        LayerSemantic::default(),
    );
    let tree = PageLayerTree::new(32.0, 20.0, root);
    let renderer = SkiaLayerRenderer::new();
    let output = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("render clipped static subtrees");
    let pixmap = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");
    let width = pixmap.width() as usize;

    assert_eq!(output.diagnostics.static_picture_cache_misses, 1);
    assert_eq!(output.diagnostics.static_picture_cache_hits, 1);
    assert!(
        output.diagnostics.static_picture_cache_approx_bytes > 0,
        "static picture cache should report retained approximate bytes"
    );
    assert!(
        pixmap.pixels()[10 * width + 5].alpha() > 0,
        "first external clip should reveal the shared static subtree"
    );
    assert!(
        pixmap.pixels()[10 * width + 25].alpha() > 0,
        "second external clip should replay the cached subtree under its own clip"
    );
    assert_eq!(
        pixmap.pixels()[10 * width + 16].alpha(),
        0,
        "cached subtree replay must not leak between external clip scopes"
    );
}

#[test]
fn raster_output_reports_static_picture_cache_hit_miss_diagnostics() {
    let rect_bounds = BoundingBox::new(5.0, 5.0, 20.0, 10.0);
    let leaf = LayerNode::leaf(
        rect_bounds,
        Some(2),
        vec![PaintOp::Rectangle {
            bbox: rect_bounds,
            rect: LayerRectanglePaint {
                corner_radius: 0.0,
                style: ShapeStyle {
                    fill_color: Some(0x00AA00),
                    ..Default::default()
                },
                gradient: None,
                transform: Default::default(),
            },
        }],
    );
    let root = LayerNode::group(
        BoundingBox::new(0.0, 0.0, 40.0, 20.0),
        Some(1),
        vec![leaf],
        CacheHint::StaticSubtree,
        LayerSemantic::default(),
    );
    let tree = PageLayerTree::new(40.0, 20.0, root);
    let renderer = SkiaLayerRenderer::new();

    let first = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("first static cache render");
    assert_eq!(first.diagnostics.layer_nodes_replayed, 2);
    assert_eq!(first.diagnostics.paint_ops_replayed, 1);
    assert_eq!(first.diagnostics.static_picture_cache_misses, 1);
    assert_eq!(first.diagnostics.static_picture_cache_hits, 0);
    assert_eq!(first.diagnostics.static_picture_cache_evictions, 0);
    assert_eq!(first.diagnostics.static_picture_cache_recordings, 1);
    assert!(first.diagnostics.static_picture_cache_approx_bytes > 0);

    let second = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("second static cache render");
    assert_eq!(second.diagnostics.layer_nodes_replayed, 1);
    assert_eq!(second.diagnostics.paint_ops_replayed, 0);
    assert_eq!(second.diagnostics.static_picture_cache_misses, 0);
    assert_eq!(second.diagnostics.static_picture_cache_hits, 1);
    assert_eq!(second.diagnostics.static_picture_cache_evictions, 0);
    assert_eq!(second.diagnostics.static_picture_cache_recordings, 0);
    assert_eq!(
        second.diagnostics.static_picture_cache_approx_bytes,
        first.diagnostics.static_picture_cache_approx_bytes
    );
}

#[test]
fn raster_output_reports_static_picture_cache_fingerprint_mismatch() {
    let rect_bounds = BoundingBox::new(5.0, 5.0, 20.0, 10.0);
    let leaf = LayerNode::leaf(
        rect_bounds,
        Some(2),
        vec![PaintOp::Rectangle {
            bbox: rect_bounds,
            rect: LayerRectanglePaint {
                corner_radius: 0.0,
                style: ShapeStyle {
                    fill_color: Some(0x00AA00),
                    ..Default::default()
                },
                gradient: None,
                transform: Default::default(),
            },
        }],
    );
    let root = LayerNode::group(
        BoundingBox::new(0.0, 0.0, 40.0, 20.0),
        Some(1),
        vec![leaf],
        CacheHint::StaticSubtree,
        LayerSemantic::default(),
    );
    let tree = PageLayerTree::new(40.0, 20.0, root);
    let renderer = SkiaLayerRenderer::new();

    let mut cache_key = StaticSubtreeCacheKey::new();
    cache_key.mix_str(RenderProfile::Screen.as_str());
    cache_key.mix_output_options(&LayerOutputOptions::default());
    cache_key.mix_f64(1.0);
    cache_key.mix_str(PaintReplayPlane::Flow.as_str());
    cache_key.mix_layer_node(&tree.root, &tree.resources);
    let cache_key = cache_key.finish();

    let mut recorder = PictureRecorder::new();
    let canvas = recorder.begin_recording(Rect::from_xywh(0.0, 0.0, 4.0, 4.0), true);
    let mut paint = Paint::default();
    paint.set_color(Color::from_argb(255, 255, 0, 0));
    canvas.draw_rect(Rect::from_xywh(0.0, 0.0, 4.0, 4.0), &paint);
    let stale_picture = recorder
        .finish_recording_as_picture(Some(&Rect::from_xywh(0.0, 0.0, 4.0, 4.0)))
        .expect("stale picture");
    renderer.static_picture_cache.borrow_mut().insert(
        StaticPictureCacheKey {
            hash: cache_key.hash,
            fingerprint: cache_key.fingerprint ^ 1,
        },
        stale_picture,
        64,
    );

    let output = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("static cache mismatch render");
    assert_eq!(output.diagnostics.static_picture_cache_hits, 0);
    assert_eq!(output.diagnostics.static_picture_cache_misses, 1);
    assert_eq!(
        output
            .diagnostics
            .static_picture_cache_fingerprint_mismatches,
        1
    );
}

#[test]
fn static_subtree_picture_cache_replays_image_path_and_text_payloads() {
    use crate::model::style::ImageFillMode;

    let mut pixmap = tiny_skia::Pixmap::new(4, 4).expect("source pixmap");
    for pixel in pixmap.pixels_mut() {
        *pixel = tiny_skia::PremultipliedColorU8::from_rgba(64, 160, 224, 255).unwrap();
    }
    let image_bytes = pixmap.encode_png().expect("source png");
    let mut resources = ResourceArena::default();
    let image_id = resources.intern_image_bytes(&image_bytes);
    let image_bbox = BoundingBox::new(2.0, 2.0, 8.0, 8.0);
    let path_bbox = BoundingBox::new(12.0, 3.0, 18.0, 10.0);
    let text_bbox = BoundingBox::new(2.0, 13.0, 30.0, 10.0);
    let leaf = LayerNode::leaf(
        BoundingBox::new(0.0, 0.0, 36.0, 26.0),
        Some(3),
        vec![
            PaintOp::Image {
                bbox: image_bbox,
                image: LayerImagePaint {
                    resource_id: Some(image_id),
                    external_path: None,
                    text_wrap: None,
                    fill_mode: Some(ImageFillMode::FitToSize),
                    original_size: Some((4.0, 4.0)),
                    crop: None,
                    original_size_hu: None,
                    brightness: 0,
                    contrast: 0,
                    effect: ImageEffect::RealPic,
                    transform: ShapeTransform::default(),
                },
            },
            PaintOp::Path {
                bbox: path_bbox,
                path: LayerPathPaint {
                    commands: vec![
                        PathCommand::MoveTo(12.0, 12.0),
                        PathCommand::LineTo(21.0, 3.0),
                        PathCommand::LineTo(30.0, 12.0),
                    ],
                    style: ShapeStyle {
                        fill_color: None,
                        stroke_color: Some(0x000000),
                        stroke_width: 1.5,
                        ..Default::default()
                    },
                    gradient: None,
                    transform: Default::default(),
                    connector_endpoints: None,
                    line_style: None,
                },
            },
            PaintOp::TextRun {
                bbox: text_bbox,
                run: LayerTextRunPaint {
                    source: None,
                    text: "Skia".to_string(),
                    display_text: None,
                    style: TextStyle {
                        font_size: 8.0,
                        color: 0x00000000,
                        ..Default::default()
                    },
                    positions: vec![0.0, 4.0, 8.0, 12.0],
                    control_marks: Vec::new(),
                    baseline: 8.0,
                    rotation: 0.0,
                    is_vertical: false,
                    orientation: LayerTextOrientation::Horizontal,
                    char_overlap: None,
                    field_marker: Default::default(),
                    is_para_end: false,
                    is_line_break_end: false,
                    ..Default::default()
                },
            },
        ],
    );
    let root = LayerNode::group(
        BoundingBox::new(0.0, 0.0, 36.0, 26.0),
        Some(2),
        vec![leaf],
        CacheHint::StaticSubtree,
        LayerSemantic::default(),
    );
    let tree = PageLayerTree::with_resources(36.0, 26.0, root, resources);
    let renderer = SkiaLayerRenderer::new();

    let first = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("first mixed static render");
    let second = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("cached mixed static render");
    let first_pixmap = tiny_skia::Pixmap::decode_png(&first.bytes).expect("first png decode");
    let second_pixmap = tiny_skia::Pixmap::decode_png(&second.bytes).expect("second png decode");

    assert_eq!(first.diagnostics.static_picture_cache_misses, 1);
    assert_eq!(second.diagnostics.static_picture_cache_hits, 1);
    assert_eq!(
        first_pixmap.data(),
        second_pixmap.data(),
        "mixed static subtree payloads should replay identically from cache"
    );
    assert!(
        first_pixmap
            .pixels()
            .iter()
            .filter(|pixel| pixel.alpha() > 0)
            .count()
            > 40,
        "image, path, and text static subtree fixture should produce visible ink"
    );
}

#[test]
fn static_subtree_cache_key_includes_image_crop_reference_size() {
    use crate::model::style::ImageFillMode;

    let make_tree = |crop_reference_size| {
        let mut resources = ResourceArena::default();
        let image_id = resources.intern_image_bytes(b"same-image");
        let bbox = BoundingBox::new(0.0, 0.0, 16.0, 16.0);
        let root = LayerNode::leaf_with_hint(
            bbox,
            Some(41),
            vec![PaintOp::Image {
                bbox,
                image: LayerImagePaint {
                    resource_id: Some(image_id),
                    external_path: None,
                    text_wrap: None,
                    fill_mode: Some(ImageFillMode::FitToSize),
                    original_size: Some((16.0, 16.0)),
                    crop: Some((100, 100, 900, 700)),
                    original_size_hu: crop_reference_size,
                    brightness: 0,
                    contrast: 0,
                    effect: ImageEffect::RealPic,
                    transform: ShapeTransform::default(),
                },
            }],
            CacheHint::StaticSubtree,
        );
        PageLayerTree::with_resources(16.0, 16.0, root, resources)
    };
    let cache_key = |tree: &PageLayerTree| {
        let mut key = StaticSubtreeCacheKey::new();
        key.mix_layer_node(&tree.root, &tree.resources);
        key.finish()
    };

    let first = make_tree(Some((1000, 800)));
    let equal = make_tree(Some((1000, 800)));
    let changed = make_tree(Some((1200, 800)));

    assert_eq!(cache_key(&first), cache_key(&equal));
    assert_ne!(cache_key(&first), cache_key(&changed));
}

#[test]
fn raster_output_reports_static_picture_cache_eviction_diagnostics() {
    let mut children = Vec::new();
    for index in 0..(MAX_STATIC_PICTURE_CACHE_ENTRIES + 1) {
        let x = index as f64;
        let rect_bounds = BoundingBox::new(x, 0.0, 1.0, 1.0);
        let leaf = LayerNode::leaf(
            rect_bounds,
            Some(index as u32 + 100),
            vec![PaintOp::Rectangle {
                bbox: rect_bounds,
                rect: LayerRectanglePaint {
                    corner_radius: 0.0,
                    style: ShapeStyle {
                        fill_color: Some(0x000001 + index as u32),
                        ..Default::default()
                    },
                    gradient: None,
                    transform: Default::default(),
                },
            }],
        );
        children.push(LayerNode::group(
            BoundingBox::new(x, 0.0, 1.0, 1.0),
            Some(index as u32 + 1),
            vec![leaf],
            CacheHint::StaticSubtree,
            LayerSemantic::default(),
        ));
    }
    let page_width = (MAX_STATIC_PICTURE_CACHE_ENTRIES + 1) as f64;
    let root = LayerNode::group(
        BoundingBox::new(0.0, 0.0, page_width, 1.0),
        None,
        children,
        CacheHint::None,
        LayerSemantic::default(),
    );
    let tree = PageLayerTree::new(page_width, 1.0, root);
    let renderer = SkiaLayerRenderer::new();
    let output = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("static cache pressure render");

    assert_eq!(
        output.diagnostics.static_picture_cache_misses,
        MAX_STATIC_PICTURE_CACHE_ENTRIES + 1
    );
    assert_eq!(output.diagnostics.static_picture_cache_hits, 0);
    assert_eq!(output.diagnostics.static_picture_cache_evictions, 1);
    assert_eq!(output.diagnostics.static_picture_cache_skipped_oversized, 0);
    assert_eq!(
        renderer.static_picture_cache.borrow().len(),
        MAX_STATIC_PICTURE_CACHE_ENTRIES
    );
    assert!(output.diagnostics.static_picture_cache_approx_bytes <= MAX_STATIC_PICTURE_CACHE_BYTES);
}

#[test]
fn raster_output_reports_static_picture_cache_oversized_skips() {
    let rect_bounds = BoundingBox::new(0.0, 0.0, 16.0, 16.0);
    let leaf = LayerNode::leaf(
        rect_bounds,
        Some(200),
        vec![PaintOp::Rectangle {
            bbox: rect_bounds,
            rect: LayerRectanglePaint {
                corner_radius: 0.0,
                style: ShapeStyle {
                    fill_color: Some(0x0000AA00),
                    ..Default::default()
                },
                gradient: None,
                transform: Default::default(),
            },
        }],
    );
    let root = LayerNode::group(
        rect_bounds,
        Some(201),
        vec![leaf],
        CacheHint::StaticSubtree,
        LayerSemantic::default(),
    );
    let tree = PageLayerTree::new(20.0, 20.0, root);
    let renderer = SkiaLayerRenderer::new();
    *renderer.static_picture_cache.borrow_mut() = StaticPictureCache::new(8, 8);

    let output = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("oversized static cache render");

    assert_eq!(output.diagnostics.static_picture_cache_misses, 1);
    assert_eq!(output.diagnostics.static_picture_cache_hits, 0);
    assert_eq!(output.diagnostics.static_picture_cache_evictions, 0);
    assert_eq!(output.diagnostics.static_picture_cache_skipped_oversized, 1);
    assert_eq!(output.diagnostics.static_picture_cache_approx_bytes, 0);
    assert_eq!(renderer.static_picture_cache.borrow().len(), 0);
}

#[test]
fn static_picture_cache_ignores_unreferenced_resources() {
    let rect_bounds = BoundingBox::new(5.0, 5.0, 20.0, 10.0);
    let leaf = LayerNode::leaf(
        rect_bounds,
        Some(2),
        vec![PaintOp::Rectangle {
            bbox: rect_bounds,
            rect: LayerRectanglePaint {
                corner_radius: 0.0,
                style: ShapeStyle {
                    fill_color: Some(0x00AA00),
                    ..Default::default()
                },
                gradient: None,
                transform: Default::default(),
            },
        }],
    );
    let root = LayerNode::group(
        BoundingBox::new(0.0, 0.0, 40.0, 20.0),
        Some(1),
        vec![leaf],
        CacheHint::StaticSubtree,
        LayerSemantic::default(),
    );
    let mut resources_a = ResourceArena::default();
    resources_a.intern_image_bytes(b"unreferenced image A");
    resources_a.intern_svg_fragment("<rect width=\"10\" height=\"10\"/>");
    let mut resources_b = ResourceArena::default();
    resources_b.intern_image_bytes(b"unreferenced image B with different bytes");
    resources_b.intern_svg_fragment("<circle r=\"5\"/>");
    let tree_a = PageLayerTree::with_resources(40.0, 20.0, root.clone(), resources_a);
    let tree_b = PageLayerTree::with_resources(40.0, 20.0, root, resources_b);
    let renderer = SkiaLayerRenderer::new();

    renderer.render_png(&tree_a).expect("first skia render");
    assert_eq!(renderer.static_picture_cache.borrow().len(), 1);
    renderer
        .render_png(&tree_b)
        .expect("unreferenced resources should not miss");
    assert_eq!(
        renderer.static_picture_cache.borrow().len(),
        1,
        "static subtree cache key should ignore resources not referenced by the subtree"
    );
}

#[test]
fn static_subtree_cache_key_includes_bitmap_glyph_resource_fingerprint() {
    let bbox = BoundingBox::new(2.0, 2.0, 24.0, 24.0);
    let make_tree = |image_bytes: &[u8]| {
        let mut resources = ResourceArena::default();
        let image_resource_id = resources.intern_image_bytes(image_bytes);
        let mut outline =
            glyph_outline_test_paint(GlyphOutlinePayloadKind::BitmapGlyph, None, None);
        outline.paths.clear();
        outline.bitmap_glyph = Some(BitmapGlyphPayload {
            image_resource_id,
            source_range_utf8: Some(TextSourceRange::new(0, 1)),
            glyph_range: Some(GlyphRange::new(0, 1)),
            placement: Some(outline.placement),
            transform_to_run: None,
            strike_ppem: Some((16, 16)),
            strike_selection: Some(BitmapStrikeSelection::ProducerResolved),
            pixel_format: Some("rgba8".to_string()),
            color_space: Some("srgb".to_string()),
            alpha_mode: Some(BitmapAlphaMode::Premultiplied),
            scaling_policy: Some(BitmapGlyphScalingPolicy::ExplicitTransform),
            filtering: Some(BitmapGlyphFiltering::Nearest),
        });
        let leaf = LayerNode::leaf_with_hint(
            bbox,
            Some(302),
            vec![PaintOp::GlyphOutline {
                bbox,
                outline: Box::new(outline),
            }],
            CacheHint::StaticSubtree,
        );
        let root = LayerNode::group(
            bbox,
            Some(303),
            vec![leaf],
            CacheHint::StaticSubtree,
            LayerSemantic::default(),
        );
        PageLayerTree::with_resources(32.0, 32.0, root, resources)
    };
    let cache_key = |tree: &PageLayerTree| {
        let mut cache_key = StaticSubtreeCacheKey::new();
        cache_key.mix_layer_node(&tree.root, &tree.resources);
        cache_key.finish()
    };

    let key_a = cache_key(&make_tree(b"bitmap-glyph-resource-a"));
    let key_a_again = cache_key(&make_tree(b"bitmap-glyph-resource-a"));
    let key_b = cache_key(&make_tree(b"bitmap-glyph-resource-b"));

    assert_eq!(
        key_a, key_a_again,
        "equal BitmapGlyph image resources should produce stable static subtree keys"
    );
    assert_ne!(
        key_a, key_b,
        "BitmapGlyph resource bytes must affect static subtree cache keys even when resource ids match"
    );
}

#[test]
fn static_subtree_cache_key_includes_svg_glyph_resource_fingerprint() {
    let bbox = BoundingBox::new(2.0, 2.0, 24.0, 24.0);
    let make_tree = |svg_fragment: &str| {
        let mut resources = ResourceArena::default();
        let vector_resource_id = resources.intern_svg_fragment(svg_fragment);
        let mut outline = glyph_outline_test_paint(GlyphOutlinePayloadKind::SvgGlyph, None, None);
        outline.paths.clear();
        outline.svg_glyph = Some(SvgGlyphPayload {
            vector_resource_id,
            source_range_utf8: Some(TextSourceRange::new(0, 1)),
            glyph_range: Some(GlyphRange::new(0, 1)),
            placement: Some(outline.placement),
            transform_to_run: None,
            view_box: Some(SvgGlyphViewBox {
                x: 0.0,
                y: 0.0,
                width: 12.0,
                height: 12.0,
            }),
            intrinsic_size: None,
            security_mode: SvgGlyphSecurityMode::StaticSanitized,
            script_allowed: false,
            animation_allowed: false,
            external_resources_allowed: false,
            interactivity_allowed: false,
        });
        let leaf = LayerNode::leaf_with_hint(
            bbox,
            Some(304),
            vec![PaintOp::GlyphOutline {
                bbox,
                outline: Box::new(outline),
            }],
            CacheHint::StaticSubtree,
        );
        let root = LayerNode::group(
            bbox,
            Some(305),
            vec![leaf],
            CacheHint::StaticSubtree,
            LayerSemantic::default(),
        );
        PageLayerTree::with_resources(32.0, 32.0, root, resources)
    };
    let cache_key = |tree: &PageLayerTree| {
        let mut cache_key = StaticSubtreeCacheKey::new();
        cache_key.mix_layer_node(&tree.root, &tree.resources);
        cache_key.finish()
    };

    let key_a = cache_key(&make_tree(
        "<rect width=\"12\" height=\"12\" fill=\"#00ffff\"/>",
    ));
    let key_a_again = cache_key(&make_tree(
        "<rect width=\"12\" height=\"12\" fill=\"#00ffff\"/>",
    ));
    let key_b = cache_key(&make_tree(
        "<circle cx=\"6\" cy=\"6\" r=\"6\" fill=\"#00ffff\"/>",
    ));

    assert_eq!(
        key_a, key_a_again,
        "equal SvgGlyph vector resources should produce stable static subtree keys"
    );
    assert_ne!(
        key_a, key_b,
        "SvgGlyph resource text must affect static subtree cache keys even when resource ids match"
    );
}

#[test]
fn static_subtree_cache_key_includes_color_layers_payload_contents() {
    let bbox = BoundingBox::new(2.0, 2.0, 24.0, 24.0);
    let source_font_ref = FontColorGlyphRef {
        face_key: Some("test-face".to_string()),
        glyph_id: Some(1),
        palette_index: Some(2),
        color_format: Some(ColorGlyphFormat::ColrV0),
    };
    let make_tree = |rgba: [f32; 4], transform_x: f64| {
        let color_layers = ColorLayersPayload {
            color_format: ColorGlyphFormat::ColrV0,
            source_font_ref: Some(source_font_ref.clone()),
            palette_ref: None,
            layers: vec![ColorLayerNode {
                layer_index: Some(0),
                glyph_id: Some(1),
                glyph_range: Some(GlyphRange::new(0, 1)),
                source_range_utf8: Some(TextSourceRange::new(0, 1)),
                source_font_ref: Some(source_font_ref.clone()),
                path_index: Some(0),
                commands: Some(vec![
                    PathCommand::MoveTo(0.0, 0.0),
                    PathCommand::LineTo(12.0, 0.0),
                    PathCommand::LineTo(12.0, 12.0),
                    PathCommand::ClosePath,
                ]),
                fill: Some(ResolvedColor {
                    color_space: Some("srgb".to_string()),
                    rgba,
                }),
                fill_rule: Some(GlyphOutlineFillRule::NonZero),
                palette_index: Some(2),
                color: None,
                opacity: Some(rgba[3] as f64),
                transform_to_run: Some(LayerAffineTransform {
                    a: 1.0,
                    b: 0.0,
                    c: 0.0,
                    d: 1.0,
                    e: transform_x,
                    f: 0.0,
                }),
            }],
            paint_graph: None,
            source_range_utf8: Some(TextSourceRange::new(0, 1)),
            glyph_range: Some(GlyphRange::new(0, 1)),
        };
        let outline = glyph_outline_test_paint(
            GlyphOutlinePayloadKind::ColorLayers,
            None,
            Some(color_layers),
        );
        let leaf = LayerNode::leaf_with_hint(
            bbox,
            Some(306),
            vec![PaintOp::GlyphOutline {
                bbox,
                outline: Box::new(outline),
            }],
            CacheHint::StaticSubtree,
        );
        let root = LayerNode::group(
            bbox,
            Some(307),
            vec![leaf],
            CacheHint::StaticSubtree,
            LayerSemantic::default(),
        );
        PageLayerTree::with_resources(32.0, 32.0, root, ResourceArena::default())
    };
    let cache_key = |tree: &PageLayerTree| {
        let mut cache_key = StaticSubtreeCacheKey::new();
        cache_key.mix_layer_node(&tree.root, &tree.resources);
        cache_key.finish()
    };

    let green_key = cache_key(&make_tree([0.0, 1.0, 0.0, 1.0], 0.0));
    let green_key_again = cache_key(&make_tree([0.0, 1.0, 0.0, 1.0], 0.0));
    let blue_key = cache_key(&make_tree([0.0, 0.0, 1.0, 1.0], 0.0));
    let translated_key = cache_key(&make_tree([0.0, 1.0, 0.0, 1.0], 4.0));

    assert_eq!(
        green_key, green_key_again,
        "equal ColorLayers payloads should produce stable static subtree keys"
    );
    assert_ne!(
        green_key, blue_key,
        "resolved ColorLayers fill colors must affect static subtree cache keys"
    );
    assert_ne!(
        green_key, translated_key,
        "ColorLayers per-layer transforms must affect static subtree cache keys"
    );
}

#[test]
fn static_subtree_cache_key_includes_colrv1_composite_graph_edges() {
    let bbox = BoundingBox::new(2.0, 2.0, 24.0, 24.0);
    let source_font_ref = FontColorGlyphRef {
        face_key: Some("test-face".to_string()),
        glyph_id: Some(1),
        palette_index: Some(2),
        color_format: Some(ColorGlyphFormat::ColrV1),
    };
    let solid_node = |node_id: u32, rgba: [f32; 4], glyph_id: u32| ColorPaintGraphNode {
        node_id,
        kind: ColorPaintGraphNodeKind::SolidPath,
        solid_path: Some(ColorPaintSolidPathNode {
            commands: vec![
                PathCommand::MoveTo(0.0, 0.0),
                PathCommand::LineTo(12.0, 0.0),
                PathCommand::LineTo(12.0, 12.0),
                PathCommand::ClosePath,
            ],
            fill: ResolvedColor {
                color_space: Some("srgb".to_string()),
                rgba,
            },
            fill_rule: GlyphOutlineFillRule::NonZero,
            source_glyph_id: Some(glyph_id),
            palette_index: Some(2),
        }),
        linear_gradient_path: None,
        radial_gradient_path: None,
        sweep_gradient_path: None,
        transform: None,
        composite: None,
        clip: None,
        source_range_utf8: Some(TextSourceRange::new(glyph_id, glyph_id + 1)),
        glyph_range: Some(GlyphRange::new(glyph_id, glyph_id + 1)),
        source_font_ref: Some(source_font_ref.clone()),
    };
    let make_tree = |backdrop_node_id: u32, source_node_id: u32| {
        let color_layers = ColorLayersPayload {
            color_format: ColorGlyphFormat::ColrV1,
            source_font_ref: Some(source_font_ref.clone()),
            palette_ref: None,
            layers: Vec::new(),
            paint_graph: Some(ColorPaintGraphPayload {
                root_node_id: 9,
                nodes: vec![
                    solid_node(1, [0.0, 0.0, 1.0, 1.0], 1),
                    solid_node(2, [1.0, 0.0, 0.0, 0.5], 2),
                    ColorPaintGraphNode {
                        node_id: 9,
                        kind: ColorPaintGraphNodeKind::Composite,
                        solid_path: None,
                        linear_gradient_path: None,
                        radial_gradient_path: None,
                        sweep_gradient_path: None,
                        transform: None,
                        composite: Some(ColorPaintCompositeNode {
                            backdrop_node_id,
                            source_node_id,
                            mode: ColorPaintCompositeMode::SourceOver,
                        }),
                        clip: None,
                        source_range_utf8: None,
                        glyph_range: None,
                        source_font_ref: None,
                    },
                ],
            }),
            source_range_utf8: Some(TextSourceRange::new(0, 2)),
            glyph_range: Some(GlyphRange::new(0, 2)),
        };
        let outline = glyph_outline_test_paint(
            GlyphOutlinePayloadKind::ColorLayers,
            None,
            Some(color_layers),
        );
        let leaf = LayerNode::leaf_with_hint(
            bbox,
            Some(316),
            vec![PaintOp::GlyphOutline {
                bbox,
                outline: Box::new(outline),
            }],
            CacheHint::StaticSubtree,
        );
        PageLayerTree::with_resources(32.0, 32.0, leaf, ResourceArena::default())
    };
    let cache_key = |tree: &PageLayerTree| {
        let mut cache_key = StaticSubtreeCacheKey::new();
        cache_key.mix_layer_node(&tree.root, &tree.resources);
        cache_key.finish()
    };

    let source_over_key = cache_key(&make_tree(1, 2));
    let source_over_key_again = cache_key(&make_tree(1, 2));
    let swapped_key = cache_key(&make_tree(2, 1));

    assert_eq!(
        source_over_key, source_over_key_again,
        "equal COLRv1 composite graphs should produce stable static subtree keys"
    );
    assert_ne!(
        source_over_key, swapped_key,
        "COLRv1 composite source/backdrop edges must affect static subtree cache keys"
    );
}

#[test]
fn static_subtree_cache_key_includes_colrv1_clip_graph_edges() {
    let bbox = BoundingBox::new(2.0, 2.0, 24.0, 24.0);
    let source_font_ref = FontColorGlyphRef {
        face_key: Some("test-face".to_string()),
        glyph_id: Some(1),
        palette_index: Some(2),
        color_format: Some(ColorGlyphFormat::ColrV1),
    };
    let make_tree = |clip_x: f64| {
        let color_layers = ColorLayersPayload {
            color_format: ColorGlyphFormat::ColrV1,
            source_font_ref: Some(source_font_ref.clone()),
            palette_ref: None,
            layers: Vec::new(),
            paint_graph: Some(ColorPaintGraphPayload {
                root_node_id: 9,
                nodes: vec![
                    ColorPaintGraphNode {
                        node_id: 1,
                        kind: ColorPaintGraphNodeKind::SolidPath,
                        solid_path: Some(ColorPaintSolidPathNode {
                            commands: vec![
                                PathCommand::MoveTo(0.0, 0.0),
                                PathCommand::LineTo(12.0, 0.0),
                                PathCommand::LineTo(12.0, 12.0),
                                PathCommand::ClosePath,
                            ],
                            fill: ResolvedColor {
                                color_space: Some("srgb".to_string()),
                                rgba: [1.0, 0.0, 0.0, 1.0],
                            },
                            fill_rule: GlyphOutlineFillRule::NonZero,
                            source_glyph_id: Some(1),
                            palette_index: Some(2),
                        }),
                        linear_gradient_path: None,
                        radial_gradient_path: None,
                        sweep_gradient_path: None,
                        transform: None,
                        composite: None,
                        clip: None,
                        source_range_utf8: Some(TextSourceRange::new(0, 1)),
                        glyph_range: Some(GlyphRange::new(0, 1)),
                        source_font_ref: Some(source_font_ref.clone()),
                    },
                    ColorPaintGraphNode {
                        node_id: 9,
                        kind: ColorPaintGraphNodeKind::Clip,
                        solid_path: None,
                        linear_gradient_path: None,
                        radial_gradient_path: None,
                        sweep_gradient_path: None,
                        transform: None,
                        composite: None,
                        clip: Some(ColorPaintClipNode {
                            child_node_id: 1,
                            clip_commands: vec![
                                PathCommand::MoveTo(clip_x, 0.0),
                                PathCommand::LineTo(12.0, 0.0),
                                PathCommand::LineTo(12.0, 12.0),
                                PathCommand::LineTo(clip_x, 12.0),
                                PathCommand::ClosePath,
                            ],
                            fill_rule: GlyphOutlineFillRule::NonZero,
                        }),
                        source_range_utf8: None,
                        glyph_range: None,
                        source_font_ref: None,
                    },
                ],
            }),
            source_range_utf8: Some(TextSourceRange::new(0, 1)),
            glyph_range: Some(GlyphRange::new(0, 1)),
        };
        let outline = glyph_outline_test_paint(
            GlyphOutlinePayloadKind::ColorLayers,
            None,
            Some(color_layers),
        );
        let leaf = LayerNode::leaf_with_hint(
            bbox,
            Some(317),
            vec![PaintOp::GlyphOutline {
                bbox,
                outline: Box::new(outline),
            }],
            CacheHint::StaticSubtree,
        );
        PageLayerTree::with_resources(32.0, 32.0, leaf, ResourceArena::default())
    };
    let cache_key = |tree: &PageLayerTree| {
        let mut cache_key = StaticSubtreeCacheKey::new();
        cache_key.mix_layer_node(&tree.root, &tree.resources);
        cache_key.finish()
    };

    let full_clip_key = cache_key(&make_tree(0.0));
    let full_clip_key_again = cache_key(&make_tree(0.0));
    let shifted_clip_key = cache_key(&make_tree(4.0));

    assert_eq!(
        full_clip_key, full_clip_key_again,
        "equal COLRv1 clip graphs should produce stable static subtree keys"
    );
    assert_ne!(
        full_clip_key, shifted_clip_key,
        "COLRv1 clip commands must affect static subtree cache keys"
    );
}

#[test]
fn static_subtree_cache_key_includes_text_variant_metadata() {
    let tree_a = glyph_variant_test_tree(&[1], GlyphRunReplayEligibility::Portable);
    let mut tree_b = glyph_variant_test_tree(&[1], GlyphRunReplayEligibility::Portable);
    let LayerNodeKind::Leaf { ops, .. } = &mut tree_b.root.kind else {
        panic!("expected leaf root");
    };
    let PaintOp::TextRun { run, .. } = &mut ops[0] else {
        panic!("expected TextRun fallback");
    };
    run.variant
        .as_mut()
        .expect("text variant metadata")
        .equivalence_group = "text-variant-other".to_string();

    let cache_key = |tree: &PageLayerTree| {
        let mut cache_key = StaticSubtreeCacheKey::new();
        cache_key.mix_layer_node(&tree.root, &tree.resources);
        cache_key.finish()
    };

    assert_eq!(
        cache_key(&tree_a),
        cache_key(&glyph_variant_test_tree(
            &[1],
            GlyphRunReplayEligibility::Portable
        )),
        "equal text variant metadata should produce stable static subtree keys"
    );
    assert_ne!(
        cache_key(&tree_a),
        cache_key(&tree_b),
        "TextRun variant grouping metadata affects text variant selection and must affect static subtree cache keys"
    );
}

#[test]
fn static_subtree_cache_key_includes_sidecar_variant_ops() {
    let outline_a = glyph_outline_test_paint(GlyphOutlinePayloadKind::MonochromeFill, None, None);
    let mut outline_b = outline_a.clone();
    outline_b.paths[0].commands[1] = PathCommand::LineTo(20.0, 0.0);
    let tree_a = glyph_outline_sidecar_variant_test_tree(outline_a, true);
    let tree_b = glyph_outline_sidecar_variant_test_tree(outline_b, true);
    let cache_key = |tree: &PageLayerTree| {
        let mut cache_key = StaticSubtreeCacheKey::new();
        cache_key.mix_layer_node_with_sidecars(&tree.root, &tree.resources, &tree.variant_ops);
        cache_key.finish()
    };

    assert_ne!(
        cache_key(&tree_a),
        cache_key(&tree_b),
        "sidecar GlyphOutline payloads affect selected replay and must affect static subtree cache keys"
    );
}

#[test]
fn static_subtree_cache_key_includes_glyph_variant_diagnostics() {
    let glyph_run_tree = glyph_variant_test_tree(&[1], GlyphRunReplayEligibility::Portable);
    let mut rejected_glyph_run_tree =
        glyph_variant_test_tree(&[1], GlyphRunReplayEligibility::Portable);
    let LayerNodeKind::Leaf { ops, .. } = &mut rejected_glyph_run_tree.root.kind else {
        panic!("expected leaf root");
    };
    let PaintOp::GlyphRun { run, .. } = &mut ops[1] else {
        panic!("expected GlyphRun variant");
    };
    run.diagnostics.strict_visual_eligible = false;
    run.diagnostics.reason = Some("strictVisualDisabled".to_string());

    let mut outline = glyph_outline_test_paint(GlyphOutlinePayloadKind::MonochromeFill, None, None);
    let outline_tree = glyph_outline_variant_test_tree(outline.clone(), true);
    outline.diagnostics.strict_visual_eligible = false;
    outline.diagnostics.reason = Some("strictVisualDisabled".to_string());
    let rejected_outline_tree = glyph_outline_variant_test_tree(outline, true);

    let cache_key = |tree: &PageLayerTree| {
        let mut cache_key = StaticSubtreeCacheKey::new();
        cache_key.mix_layer_node(&tree.root, &tree.resources);
        cache_key.finish()
    };

    assert_ne!(
        cache_key(&glyph_run_tree),
        cache_key(&rejected_glyph_run_tree),
        "GlyphRun diagnostics affect variant selection and must affect static subtree cache keys"
    );
    assert_ne!(
        cache_key(&outline_tree),
        cache_key(&rejected_outline_tree),
        "GlyphOutline diagnostics affect variant selection and must affect static subtree cache keys"
    );
}

#[test]
fn static_subtree_cache_key_includes_referenced_glyph_run_font_resource() {
    let tree_a = glyph_variant_test_tree(&[1], GlyphRunReplayEligibility::Portable);
    let mut tree_b = glyph_variant_test_tree(&[1], GlyphRunReplayEligibility::Portable);
    let blob = tree_b
        .resources
        .font_resources_mut()
        .blobs
        .first_mut()
        .expect("portable font blob");
    blob.digest.as_mut().expect("font digest").value = "other-font-digest".to_string();
    if let FontPortability::PortableBlob { digest, .. } = &mut blob.portability {
        digest.value = "other-font-digest".to_string();
    }

    let cache_key = |tree: &PageLayerTree| {
        let mut cache_key = StaticSubtreeCacheKey::new();
        cache_key.mix_layer_node(&tree.root, &tree.resources);
        cache_key.finish()
    };

    assert_eq!(
        cache_key(&tree_a),
        cache_key(&glyph_variant_test_tree(
            &[1],
            GlyphRunReplayEligibility::Portable
        )),
        "equal referenced font resources should produce stable static subtree keys"
    );
    assert_ne!(
        cache_key(&tree_a),
        cache_key(&tree_b),
        "referenced GlyphRun font blob identity must affect static subtree cache keys"
    );
}

#[test]
fn static_subtree_picture_cache_evicts_old_entries() {
    let renderer = SkiaLayerRenderer::new();

    for index in 0..(MAX_STATIC_PICTURE_CACHE_ENTRIES + 2) {
        let rect_bounds = BoundingBox::new(5.0, 5.0, 20.0, 10.0);
        let leaf = LayerNode::leaf(
            rect_bounds,
            Some(index as u32 + 10),
            vec![PaintOp::Rectangle {
                bbox: rect_bounds,
                rect: LayerRectanglePaint {
                    corner_radius: 0.0,
                    style: ShapeStyle {
                        fill_color: Some(0x00AA00 + index as u32),
                        ..Default::default()
                    },
                    gradient: None,
                    transform: Default::default(),
                },
            }],
        );
        let root = LayerNode::group(
            BoundingBox::new(0.0, 0.0, 40.0, 20.0),
            Some(index as u32 + 1),
            vec![leaf],
            CacheHint::StaticSubtree,
            LayerSemantic::default(),
        );
        let tree = PageLayerTree::new(40.0, 20.0, root);
        renderer.render_png(&tree).expect("skia render");
    }

    assert_eq!(
        renderer.static_picture_cache.borrow().len(),
        MAX_STATIC_PICTURE_CACHE_ENTRIES,
        "static subtree picture cache should stay bounded"
    );
}

#[test]
fn static_subtree_cache_key_uses_paint_text_style_projection() {
    let bbox = BoundingBox::new(2.0, 2.0, 44.0, 16.0);
    let make_node = |style: TextStyle| {
        LayerNode::leaf_with_hint(
            bbox,
            Some(300),
            vec![PaintOp::TextRun {
                bbox,
                run: LayerTextRunPaint {
                    source: None,
                    text: "Paint".to_string(),
                    style,
                    positions: vec![0.0, 8.0, 16.0, 24.0, 32.0, 40.0],
                    control_marks: Vec::new(),
                    baseline: 12.0,
                    rotation: 0.0,
                    is_vertical: false,
                    orientation: LayerTextOrientation::Horizontal,
                    char_overlap: None,
                    field_marker: Default::default(),
                    is_para_end: false,
                    is_line_break_end: false,
                    ..Default::default()
                },
            }],
            CacheHint::StaticSubtree,
        )
    };
    let mut base_style = TextStyle {
        font_family: "sans-serif".to_string(),
        font_size: 12.0,
        color: 0x00000000,
        ..Default::default()
    };
    let mut layout_only_style = base_style.clone();
    layout_only_style.letter_spacing = 3.0;
    layout_only_style.default_tab_width = 42.0;
    layout_only_style.tab_stops = vec![TabStop {
        position: 24.0,
        tab_type: 1,
        fill_type: 2,
    }];
    layout_only_style.auto_tab_right = true;
    layout_only_style.available_width = 180.0;
    layout_only_style.line_x_offset = 9.0;
    layout_only_style.inline_tabs = vec![[1, 2, 3, 4, 5, 6, 7]];
    layout_only_style.extra_word_spacing = 2.0;
    layout_only_style.extra_char_spacing = 1.0;

    let resources = ResourceArena::default();
    let mut base_key = StaticSubtreeCacheKey::new();
    base_key.mix_layer_node(&make_node(base_style.clone()), &resources);
    let mut layout_only_key = StaticSubtreeCacheKey::new();
    layout_only_key.mix_layer_node(&make_node(layout_only_style), &resources);
    let base_key = base_key.finish();
    let layout_only_key = layout_only_key.finish();

    assert_eq!(
        base_key, layout_only_key,
        "explicit layer text positions make layout-only TextStyle fields irrelevant to paint cache keys"
    );

    base_style.color = 0x000000ff;
    let mut paint_key = StaticSubtreeCacheKey::new();
    paint_key.mix_layer_node(&make_node(base_style), &resources);
    assert_ne!(base_key, paint_key.finish());
}

#[test]
fn static_subtree_cache_key_includes_explicit_display_projection() {
    let bbox = BoundingBox::new(2.0, 2.0, 44.0, 16.0);
    let make_node = |display_text: Option<&str>| {
        LayerNode::leaf_with_hint(
            bbox,
            Some(301),
            vec![PaintOp::TextRun {
                bbox,
                run: LayerTextRunPaint {
                    text: "ᄒ".to_string(),
                    display_text: display_text.map(str::to_string),
                    style: TextStyle {
                        font_size: 12.0,
                        ..Default::default()
                    },
                    positions: vec![0.0, 12.0],
                    baseline: 12.0,
                    ..Default::default()
                },
            }],
            CacheHint::StaticSubtree,
        )
    };
    let cache_key = |display_text| {
        let mut key = StaticSubtreeCacheKey::new();
        key.mix_layer_node(&make_node(display_text), &ResourceArena::default());
        key.finish()
    };

    assert_eq!(cache_key(Some("한")), cache_key(Some("한")));
    assert_ne!(cache_key(None), cache_key(Some("ᄒ")));
    assert_ne!(cache_key(Some("한")), cache_key(Some("")));
}

#[test]
fn static_subtree_cache_key_includes_glyph_outline_stroke_payload() {
    let bbox = BoundingBox::new(2.0, 2.0, 24.0, 24.0);
    let make_node = |stroke: Option<GlyphOutlineStrokeStyle>| {
        LayerNode::leaf_with_hint(
            bbox,
            Some(301),
            vec![PaintOp::GlyphOutline {
                bbox,
                outline: Box::new(LayerGlyphOutlinePaint {
                    source: TextSourceSpan {
                        id: TextSourceId(0),
                        utf8_range: TextSourceRange::new(0, 1),
                        utf16_range: TextSourceRange::new(0, 1),
                        stable_source_key: None,
                    },
                    variant: PaintVariantMeta {
                        equivalence_group: "text-0".to_string(),
                        variant_id: "glyphOutline".to_string(),
                        variant_kind: TextVariantKind::GlyphOutline,
                        part_index: 0,
                        part_count: 1,
                        is_default_fallback: false,
                        requires: vec!["text.glyphOutline.monochromeFillStroke".to_string()],
                        quality: Some(TextVariantQuality::Exact),
                        anchor_op_id: Some("op-text-0".to_string()),
                        local_paint_order: Some(0),
                    },
                    payload_kind: if stroke.is_some() {
                        GlyphOutlinePayloadKind::MonochromeFillStroke
                    } else {
                        GlyphOutlinePayloadKind::MonochromeFill
                    },
                    stroke,
                    color_layers: None,
                    bitmap_glyph: None,
                    svg_glyph: None,
                    paint_style: PaintTextStyle::from(&TextStyle::default()),
                    placement: TextRunPlacement {
                        run_to_page: LayerAffineTransform {
                            a: 1.0,
                            b: 0.0,
                            c: 0.0,
                            d: 1.0,
                            e: 0.0,
                            f: 0.0,
                        },
                        baseline_y: 0.0,
                    },
                    paths: vec![LayerGlyphOutlinePath {
                        glyph_id: 1,
                        source_range_utf8: TextSourceRange::new(0, 1),
                        glyph_range: GlyphRange { start: 0, end: 1 },
                        commands: vec![
                            PathCommand::MoveTo(0.0, 0.0),
                            PathCommand::LineTo(8.0, 0.0),
                            PathCommand::ClosePath,
                        ],
                        fill_rule: GlyphOutlineFillRule::NonZero,
                    }],
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
                        reason: None,
                    },
                }),
            }],
            CacheHint::StaticSubtree,
        )
    };
    let resources = ResourceArena::default();
    let mut fill_key = StaticSubtreeCacheKey::new();
    fill_key.mix_layer_node(&make_node(None), &resources);
    let mut stroke_key = StaticSubtreeCacheKey::new();
    stroke_key.mix_layer_node(
        &make_node(Some(GlyphOutlineStrokeStyle {
            color: 0x000000,
            width_px: 2.0,
            join: GlyphOutlineStrokeJoin::Miter,
            cap: GlyphOutlineStrokeCap::Butt,
            miter_limit: Some(4.0),
            paint_order: GlyphOutlinePaintOrder::FillThenStroke,
        })),
        &resources,
    );

    assert_ne!(fill_key.finish(), stroke_key.finish());
}

#[test]
fn static_picture_cache_uses_byte_budget_and_fingerprint() {
    let mut recorder = PictureRecorder::new();
    let canvas = recorder.begin_recording(Rect::from_xywh(0.0, 0.0, 4.0, 4.0), true);
    let mut paint = Paint::default();
    paint.set_color(Color::from_argb(255, 0, 255, 0));
    canvas.draw_rect(Rect::from_xywh(0.0, 0.0, 4.0, 4.0), &paint);
    let picture = recorder
        .finish_recording_as_picture(Some(&Rect::from_xywh(0.0, 0.0, 4.0, 4.0)))
        .expect("picture");

    let key_a = StaticPictureCacheKey {
        hash: 7,
        fingerprint: 11,
    };
    let key_b = StaticPictureCacheKey {
        hash: 7,
        fingerprint: 12,
    };
    let key_c = StaticPictureCacheKey {
        hash: 8,
        fingerprint: 13,
    };
    let mut cache = StaticPictureCache::new(4, 1_000);

    let outcome = cache.insert(key_a, picture.clone(), 600);
    assert_eq!(outcome.evictions, 0);
    assert!(!outcome.skipped_oversized);
    assert!(cache.get(key_a).is_some());
    assert!(
        cache.get(key_b).is_none(),
        "same hash with a different fingerprint must not reuse a cached picture"
    );
    assert!(
        cache.contains_hash(key_b.hash),
        "fingerprint mismatch should remain observable before replacement"
    );

    let outcome = cache.insert(key_c, picture.clone(), 600);
    assert_eq!(outcome.evictions, 1);
    assert!(!outcome.skipped_oversized);
    assert_eq!(cache.len(), 1);
    assert!(cache.approx_bytes() <= 1_000);
    assert!(cache.get(key_a).is_none());
    assert!(cache.get(key_c).is_some());

    let outcome = cache.insert(
        StaticPictureCacheKey {
            hash: 9,
            fingerprint: 14,
        },
        picture,
        1_001,
    );
    assert_eq!(outcome.evictions, 0);
    assert!(outcome.skipped_oversized);
    assert_eq!(
        cache.len(),
        1,
        "entries larger than the byte budget should be skipped"
    );
}

#[test]
fn replay_context_caches_decoded_image_resources() {
    let mut source = tiny_skia::Pixmap::new(2, 2).expect("source pixmap");
    for pixel in source.pixels_mut() {
        *pixel = tiny_skia::PremultipliedColorU8::from_rgba(0, 255, 0, 255).unwrap();
    }
    let png = source.encode_png().expect("source png");
    let mut replay =
        SkiaReplayContext::new(RenderProfile::Screen, LayerOutputOptions::default(), 1.0);
    let resource_id = ImageResourceId(7);

    let first = replay
        .image_for_resource(resource_id, &png)
        .expect("first image decode");
    let second = replay
        .image_for_resource(resource_id, b"not an image")
        .expect("cached image decode");

    assert_eq!((first.width(), first.height()), (2, 2));
    assert_eq!((second.width(), second.height()), (2, 2));
    assert_eq!(replay.image_cache.len(), 1);
}

#[test]
fn replay_context_caches_preprocessed_binary_image_effects() {
    let mut source = tiny_skia::Pixmap::new(8, 8).expect("source pixmap");
    for pixel in source.pixels_mut() {
        *pixel = tiny_skia::PremultipliedColorU8::from_rgba(126, 126, 126, 255).unwrap();
    }
    let png = source.encode_png().expect("source png");
    let mut replay =
        SkiaReplayContext::new(RenderProfile::Screen, LayerOutputOptions::default(), 1.0);
    let resource_id = ImageResourceId(17);
    let decoded = replay
        .image_for_resource(resource_id, &png)
        .expect("image decode");

    let first = replay
        .binary_effect_image_for_resource(resource_id, &decoded, ImageEffect::Pattern8x8)
        .expect("first effect preprocess");
    let second = replay
        .binary_effect_image_for_resource(resource_id, &decoded, ImageEffect::Pattern8x8)
        .expect("cached effect preprocess");
    let passthrough =
        replay.binary_effect_image_for_resource(resource_id, &decoded, ImageEffect::GrayScale);

    assert_eq!((first.width(), first.height()), (8, 8));
    assert_eq!((second.width(), second.height()), (8, 8));
    assert!(passthrough.is_none());
    assert_eq!(replay.image_effect_cache.len(), 1);
    assert_eq!(replay.diagnostics.image_effect_cache_hits, 1);
    assert_eq!(replay.diagnostics.image_effect_cache_misses, 1);
    assert_eq!(replay.diagnostics.image_effect_cache_evictions, 0);
    assert_eq!(
        replay.diagnostics.image_effect_preprocessed_bytes,
        8 * 8 * 4
    );
    assert_eq!(
        replay.diagnostics.image_effect_cache_approx_bytes,
        8 * 8 * 4
    );
    assert_eq!(replay.diagnostics.image_effect_preprocess_failures, 0);
    assert_eq!(replay.diagnostics.image_effect_fallback_to_filter, 0);
}

#[test]
fn replay_context_skips_binary_image_effect_cache_when_over_budget() {
    let mut source = tiny_skia::Pixmap::new(8, 8).expect("source pixmap");
    for pixel in source.pixels_mut() {
        *pixel = tiny_skia::PremultipliedColorU8::from_rgba(126, 126, 126, 255).unwrap();
    }
    let png = source.encode_png().expect("source png");
    let mut replay =
        SkiaReplayContext::new(RenderProfile::Screen, LayerOutputOptions::default(), 1.0);
    replay.set_image_effect_cache_limits(MAX_IMAGE_EFFECT_CACHE_ENTRIES, 8);
    let resource_id = ImageResourceId(18);
    let decoded = replay
        .image_for_resource(resource_id, &png)
        .expect("image decode");

    replay
        .binary_effect_image_for_resource(resource_id, &decoded, ImageEffect::Pattern8x8)
        .expect("first effect preprocess");
    replay
        .binary_effect_image_for_resource(resource_id, &decoded, ImageEffect::Pattern8x8)
        .expect("second effect preprocess");

    assert!(replay.image_effect_cache.is_empty());
    assert_eq!(replay.diagnostics.image_effect_cache_hits, 0);
    assert_eq!(replay.diagnostics.image_effect_cache_misses, 2);
    assert_eq!(replay.diagnostics.image_effect_cache_skipped_oversized, 2);
    assert_eq!(
        replay.diagnostics.image_effect_preprocessed_bytes,
        2 * 8 * 8 * 4
    );
    assert_eq!(replay.diagnostics.image_effect_cache_approx_bytes, 0);
}

#[test]
fn replay_context_evicts_binary_image_effect_cache_by_entry_limit() {
    let mut source = tiny_skia::Pixmap::new(4, 4).expect("source pixmap");
    for pixel in source.pixels_mut() {
        *pixel = tiny_skia::PremultipliedColorU8::from_rgba(126, 126, 126, 255).unwrap();
    }
    let png = source.encode_png().expect("source png");
    let mut replay =
        SkiaReplayContext::new(RenderProfile::Screen, LayerOutputOptions::default(), 1.0);
    replay.set_image_effect_cache_limits(1, MAX_IMAGE_EFFECT_CACHE_BYTES);
    let first_resource_id = ImageResourceId(19);
    let second_resource_id = ImageResourceId(20);
    let first_decoded = replay
        .image_for_resource(first_resource_id, &png)
        .expect("first image decode");
    let second_decoded = replay
        .image_for_resource(second_resource_id, &png)
        .expect("second image decode");

    replay
        .binary_effect_image_for_resource(
            first_resource_id,
            &first_decoded,
            ImageEffect::Pattern8x8,
        )
        .expect("first effect preprocess");
    replay
        .binary_effect_image_for_resource(
            second_resource_id,
            &second_decoded,
            ImageEffect::Pattern8x8,
        )
        .expect("second effect preprocess");

    assert_eq!(replay.image_effect_cache.len(), 1);
    assert!(replay
        .image_effect_cache
        .contains_key(&ImageEffectResourceCacheKey {
            resource_id: second_resource_id,
            effect_code: 2,
        }));
    assert_eq!(replay.diagnostics.image_effect_cache_misses, 2);
    assert_eq!(replay.diagnostics.image_effect_cache_evictions, 1);
    assert_eq!(
        replay.diagnostics.image_effect_cache_approx_bytes,
        4 * 4 * 4
    );
}

#[test]
fn replay_context_evicts_binary_image_effect_cache_by_byte_budget() {
    let mut source = tiny_skia::Pixmap::new(4, 4).expect("source pixmap");
    for pixel in source.pixels_mut() {
        *pixel = tiny_skia::PremultipliedColorU8::from_rgba(126, 126, 126, 255).unwrap();
    }
    let png = source.encode_png().expect("source png");
    let mut replay =
        SkiaReplayContext::new(RenderProfile::Screen, LayerOutputOptions::default(), 1.0);
    replay.set_image_effect_cache_limits(8, 4 * 4 * 4 + 8);
    let first_resource_id = ImageResourceId(21);
    let second_resource_id = ImageResourceId(22);
    let first_decoded = replay
        .image_for_resource(first_resource_id, &png)
        .expect("first image decode");
    let second_decoded = replay
        .image_for_resource(second_resource_id, &png)
        .expect("second image decode");

    replay
        .binary_effect_image_for_resource(
            first_resource_id,
            &first_decoded,
            ImageEffect::Pattern8x8,
        )
        .expect("first effect preprocess");
    replay
        .binary_effect_image_for_resource(
            second_resource_id,
            &second_decoded,
            ImageEffect::Pattern8x8,
        )
        .expect("second effect preprocess");

    assert_eq!(replay.image_effect_cache.len(), 1);
    assert!(replay
        .image_effect_cache
        .contains_key(&ImageEffectResourceCacheKey {
            resource_id: second_resource_id,
            effect_code: 2,
        }));
    assert_eq!(replay.diagnostics.image_effect_cache_misses, 2);
    assert_eq!(replay.diagnostics.image_effect_cache_evictions, 1);
    assert_eq!(
        replay.diagnostics.image_effect_preprocessed_bytes,
        2 * 4 * 4 * 4
    );
    assert_eq!(
        replay.diagnostics.image_effect_cache_approx_bytes,
        4 * 4 * 4
    );
    assert!(replay.diagnostics.image_effect_cache_approx_bytes <= 4 * 4 * 4 + 8);
}

#[test]
fn replay_context_uses_lru_order_for_binary_image_effect_cache() {
    let mut source = tiny_skia::Pixmap::new(2, 2).expect("source pixmap");
    for pixel in source.pixels_mut() {
        *pixel = tiny_skia::PremultipliedColorU8::from_rgba(126, 126, 126, 255).unwrap();
    }
    let png = source.encode_png().expect("source png");
    let mut replay =
        SkiaReplayContext::new(RenderProfile::Screen, LayerOutputOptions::default(), 1.0);
    replay.set_image_effect_cache_limits(2, 2 * 2 * 2 * 4);
    let first_resource_id = ImageResourceId(31);
    let second_resource_id = ImageResourceId(32);
    let third_resource_id = ImageResourceId(33);
    let first_decoded = replay
        .image_for_resource(first_resource_id, &png)
        .expect("first image decode");
    let second_decoded = replay
        .image_for_resource(second_resource_id, &png)
        .expect("second image decode");
    let third_decoded = replay
        .image_for_resource(third_resource_id, &png)
        .expect("third image decode");

    replay
        .binary_effect_image_for_resource(
            first_resource_id,
            &first_decoded,
            ImageEffect::Pattern8x8,
        )
        .expect("first effect preprocess");
    replay
        .binary_effect_image_for_resource(
            second_resource_id,
            &second_decoded,
            ImageEffect::Pattern8x8,
        )
        .expect("second effect preprocess");
    replay
        .binary_effect_image_for_resource(
            first_resource_id,
            &first_decoded,
            ImageEffect::Pattern8x8,
        )
        .expect("first effect cache hit");
    replay
        .binary_effect_image_for_resource(
            third_resource_id,
            &third_decoded,
            ImageEffect::Pattern8x8,
        )
        .expect("third effect preprocess");

    assert!(replay
        .image_effect_cache
        .contains_key(&ImageEffectResourceCacheKey {
            resource_id: first_resource_id,
            effect_code: 2,
        }));
    assert!(!replay
        .image_effect_cache
        .contains_key(&ImageEffectResourceCacheKey {
            resource_id: second_resource_id,
            effect_code: 2,
        }));
    assert!(replay
        .image_effect_cache
        .contains_key(&ImageEffectResourceCacheKey {
            resource_id: third_resource_id,
            effect_code: 2,
        }));
    assert_eq!(replay.diagnostics.image_effect_cache_hits, 1);
    assert_eq!(replay.diagnostics.image_effect_cache_misses, 3);
    assert_eq!(replay.diagnostics.image_effect_cache_evictions, 1);
}

#[test]
fn replay_context_caches_rasterized_svg_resources() {
    let mut replay =
        SkiaReplayContext::new(RenderProfile::Screen, LayerOutputOptions::default(), 1.0);
    let resource_id = SvgResourceId(3);
    let fragment = "<rect x=\"0\" y=\"0\" width=\"4\" height=\"4\" fill=\"#00ff00\"/>";

    let first = replay
        .svg_image_for_resource(resource_id, fragment, 4.0, 4.0)
        .expect("first svg raster");
    let second = replay
        .svg_image_for_resource(resource_id, "<invalid", 4.0, 4.0)
        .expect("cached svg raster");

    assert_eq!((first.width(), first.height()), (4, 4));
    assert_eq!((second.width(), second.height()), (4, 4));
    assert_eq!(replay.svg_resource_cache.len(), 1);

    replay
        .svg_image_for_fragment(fragment, 4.0, 4.0)
        .expect("fragment svg raster");
    replay
        .svg_image_for_fragment(fragment, 4.0, 4.0)
        .expect("cached fragment svg raster");
    assert_eq!(replay.svg_fragment_cache.len(), 1);
}

#[test]
fn replay_context_keeps_repeated_resource_caches_bounded() {
    let mut source = tiny_skia::Pixmap::new(2, 2).expect("source pixmap");
    for pixel in source.pixels_mut() {
        *pixel = tiny_skia::PremultipliedColorU8::from_rgba(32, 96, 255, 255).unwrap();
    }
    let png = source.encode_png().expect("source png");
    let mut replay =
        SkiaReplayContext::new(RenderProfile::Screen, LayerOutputOptions::default(), 1.0);
    let image_resource_id = ImageResourceId(11);
    let svg_resource_id = SvgResourceId(13);
    let fragment = "<rect x=\"0\" y=\"0\" width=\"6\" height=\"6\" fill=\"#2040ff\"/>";

    for index in 0..100 {
        let bytes: &[u8] = if index == 0 { &png } else { b"not an image" };
        let image = replay
            .image_for_resource(image_resource_id, bytes)
            .expect("repeated image resource should use cached decode");
        assert_eq!((image.width(), image.height()), (2, 2));

        let svg = if index == 0 { fragment } else { "<invalid" };
        let svg_image = replay
            .svg_image_for_resource(svg_resource_id, svg, 6.0, 6.0)
            .expect("repeated svg resource should use cached raster");
        assert_eq!((svg_image.width(), svg_image.height()), (6, 6));

        let fragment_image = replay
            .svg_image_for_fragment(fragment, 6.0, 6.0)
            .expect("repeated svg fragment should use cached raster");
        assert_eq!((fragment_image.width(), fragment_image.height()), (6, 6));
    }

    assert_eq!(replay.image_cache.len(), 1);
    assert_eq!(replay.svg_resource_cache.len(), 1);
    assert_eq!(replay.svg_fragment_cache.len(), 1);
}

#[test]
fn render_raster_options_scale_surface_and_metadata() {
    let mut tree = crate::renderer::render_tree::PageRenderTree::new(0, 40.0, 20.0);
    tree.root.node_type = RenderNodeType::Page(PageNode {
        page_index: 0,
        width: 40.0,
        height: 20.0,
        section_index: 0,
    });
    let mut builder = LayerBuilder::new(RenderProfile::Screen);
    let layer_tree = builder.build(&tree);
    let renderer = SkiaLayerRenderer::new();
    let output = renderer
        .render_raster_with_options(
            &layer_tree,
            RasterRenderOptions {
                scale: 2.0,
                dpi: Some(144.0),
                ..Default::default()
            },
        )
        .expect("scaled skia raster render");
    let pixmap = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");

    assert_eq!((output.width, output.height), (80, 40));
    assert_eq!((pixmap.width(), pixmap.height()), (80, 40));
    assert_eq!(output.dpi, Some(144.0));
}

#[test]
fn rounds_surface_size_like_svg_rasterization() {
    let mut tree = crate::renderer::render_tree::PageRenderTree::new(0, 793.7066666666667, 1122.48);
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
    assert!(raster_dimension(f64::NAN, 1.0, 16_384).is_err());
    assert!(raster_dimension(0.0, 1.0, 16_384).is_err());
    assert!(raster_dimension(10.0, f64::NAN, 16_384).is_err());
    assert!(raster_dimension(10.0, 0.0, 16_384).is_err());
    assert!(raster_dimension(8_193.0, 2.0, 16_384).is_err());
    assert_eq!(raster_dimension(12.4, 2.0, 16_384), Ok(25));
}

#[test]
fn renders_char_overlap_to_png() {
    let mut tree = crate::renderer::render_tree::PageRenderTree::new(0, 90.0, 60.0);
    tree.root.children.push(RenderNode::new(
        1,
        RenderNodeType::TextRun(TextRunNode {
            text: "12".to_string(),
            display_text: None,
            display_clusters: None,
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
fn renders_plain_text_run_to_png() {
    let mut tree = crate::renderer::render_tree::PageRenderTree::new(0, 120.0, 60.0);
    tree.root.children.push(RenderNode::new(
        1,
        RenderNodeType::TextRun(TextRunNode {
            text: "Plain text".to_string(),
            display_text: None,
            display_clusters: None,
            style: TextStyle {
                font_size: 22.0,
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
            char_overlap: None,
            border_fill_id: 0,
            baseline: 26.0,
            field_marker: Default::default(),
        }),
        BoundingBox::new(10.0, 12.0, 90.0, 32.0),
    ));

    let mut builder = LayerBuilder::new(RenderProfile::Screen);
    let layer_tree = builder.build(&tree);
    let renderer = SkiaLayerRenderer::new();
    let png = renderer.render_png(&layer_tree).expect("plain text render");
    let pixmap = tiny_skia::Pixmap::decode_png(&png).expect("png decode");
    let ink_pixels = pixmap
        .pixels()
        .iter()
        .filter(|pixel| pixel.alpha() > 0)
        .count();

    assert!(ink_pixels > 20, "expected visible plain text ink");
}

#[test]
fn skia_shaper_builds_blob_for_complex_text() {
    let renderer = SkiaLayerRenderer::new();
    let text = "office 👩\u{200d}💻 العربية 한글";
    let style = TextStyle {
        font_family: "sans-serif".to_string(),
        font_size: 20.0,
        ..Default::default()
    };
    let font = make_font(&style, &renderer.font_mgr, text);

    assert!(
        renderer
            .text_shaper
            .shape_text_blob(text, &font, false, 1_000_000.0, Point::default())
            .is_some(),
        "native Skia textlayout shaper should produce a TextBlob for complex text"
    );
}

#[test]
fn renders_complex_shaped_text_run_to_png() {
    let text = "office 👩\u{200d}💻 العربية 한글";
    let mut tree = crate::renderer::render_tree::PageRenderTree::new(0, 260.0, 70.0);
    tree.root.children.push(RenderNode::new(
        1,
        RenderNodeType::TextRun(TextRunNode {
            text: text.to_string(),
            display_text: None,
            display_clusters: None,
            style: TextStyle {
                font_family: "sans-serif".to_string(),
                font_size: 20.0,
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
            char_overlap: None,
            border_fill_id: 0,
            baseline: 30.0,
            field_marker: Default::default(),
        }),
        BoundingBox::new(10.0, 14.0, 240.0, 36.0),
    ));

    let mut builder = LayerBuilder::new(RenderProfile::Screen);
    let layer_tree = builder.build(&tree);
    let renderer = SkiaLayerRenderer::new();
    let png = renderer
        .render_png(&layer_tree)
        .expect("complex shaped text render");
    let pixmap = tiny_skia::Pixmap::decode_png(&png).expect("png decode");
    let ink_pixels = pixmap
        .pixels()
        .iter()
        .filter(|pixel| pixel.alpha() > 0)
        .count();

    assert!(ink_pixels > 20, "expected visible complex text ink");
}

#[test]
fn renders_text_feature_fixture_to_png() {
    let mut tree = crate::renderer::render_tree::PageRenderTree::new(0, 240.0, 170.0);
    let mut next_id = 1;
    let mut push_text = |tree: &mut crate::renderer::render_tree::PageRenderTree,
                         text: &str,
                         bbox: BoundingBox,
                         style: TextStyle,
                         baseline: f64,
                         rotation: f64,
                         is_vertical: bool,
                         char_overlap: Option<CharOverlapInfo>| {
        tree.root.children.push(RenderNode::new(
            next_id,
            RenderNodeType::TextRun(TextRunNode {
                text: text.to_string(),
                display_text: None,
                display_clusters: None,
                style,
                char_shape_id: None,
                para_shape_id: None,
                section_index: None,
                para_index: None,
                char_start: None,
                cell_context: None,
                is_para_end: false,
                is_line_break_end: false,
                rotation,
                is_vertical,
                char_overlap,
                border_fill_id: 0,
                baseline,
                field_marker: Default::default(),
            }),
            bbox,
        ));
        next_id += 1;
    };

    push_text(
        &mut tree,
        "한글 ABC 日本 123",
        BoundingBox::new(12.0, 14.0, 190.0, 28.0),
        TextStyle {
            font_size: 18.0,
            color: 0x00000000,
            ..Default::default()
        },
        22.0,
        0.0,
        false,
        None,
    );
    push_text(
        &mut tree,
        "회전",
        BoundingBox::new(198.0, 22.0, 28.0, 42.0),
        TextStyle {
            font_size: 16.0,
            color: 0x00000000,
            ..Default::default()
        },
        20.0,
        90.0,
        false,
        None,
    );
    push_text(
        &mut tree,
        "세로",
        BoundingBox::new(170.0, 58.0, 28.0, 48.0),
        TextStyle {
            font_size: 16.0,
            color: 0x00000000,
            ..Default::default()
        },
        20.0,
        0.0,
        true,
        None,
    );
    push_text(
        &mut tree,
        "12",
        BoundingBox::new(18.0, 56.0, 28.0, 28.0),
        TextStyle {
            font_size: 22.0,
            color: 0x00000000,
            ..Default::default()
        },
        22.0,
        0.0,
        false,
        Some(CharOverlapInfo {
            border_type: 1,
            inner_char_size: 80,
        }),
    );
    push_text(
        &mut tree,
        "위첨자",
        BoundingBox::new(58.0, 58.0, 58.0, 24.0),
        TextStyle {
            font_size: 18.0,
            color: 0x00000000,
            superscript: true,
            ..Default::default()
        },
        20.0,
        0.0,
        false,
        None,
    );
    push_text(
        &mut tree,
        "아래첨자",
        BoundingBox::new(58.0, 90.0, 72.0, 26.0),
        TextStyle {
            font_size: 18.0,
            color: 0x00000000,
            subscript: true,
            ..Default::default()
        },
        18.0,
        0.0,
        false,
        None,
    );
    push_text(
        &mut tree,
        "밑줄 취소 강조",
        BoundingBox::new(14.0, 126.0, 160.0, 30.0),
        TextStyle {
            font_size: 18.0,
            color: 0x00000000,
            underline: UnderlineType::Bottom,
            strikethrough: true,
            emphasis_dot: 1,
            ..Default::default()
        },
        22.0,
        0.0,
        false,
        None,
    );

    let mut builder = LayerBuilder::new(RenderProfile::Screen);
    let layer_tree = builder.build(&tree);
    let renderer = SkiaLayerRenderer::new();
    let png = renderer
        .render_png(&layer_tree)
        .expect("text feature fixture render");
    let pixmap = tiny_skia::Pixmap::decode_png(&png).expect("png decode");
    let ink_pixels = pixmap
        .pixels()
        .iter()
        .filter(|pixel| pixel.alpha() > 0)
        .count();

    assert!(
        ink_pixels > 500,
        "expected visible text feature fixture ink"
    );
}

#[test]
fn skia_vertical_sideways_uses_explicit_rotation_only() {
    let bbox = BoundingBox::new(38.0, 34.0, 58.0, 24.0);
    let tree = PageLayerTree::new(
        140.0,
        110.0,
        LayerNode::leaf(
            bbox,
            None,
            vec![PaintOp::TextRun {
                bbox,
                run: LayerTextRunPaint {
                    source: None,
                    text: "ABC".to_string(),
                    display_text: None,
                    style: TextStyle {
                        font_family: "sans-serif".to_string(),
                        font_size: 20.0,
                        color: 0x00000000,
                        ..Default::default()
                    },
                    positions: vec![0.0, 18.0, 36.0, 54.0],
                    control_marks: Vec::new(),
                    baseline: 20.0,
                    rotation: 90.0,
                    is_vertical: true,
                    orientation: LayerTextOrientation::VerticalSideways,
                    char_overlap: None,
                    field_marker: Default::default(),
                    is_para_end: false,
                    is_line_break_end: false,
                    ..Default::default()
                },
            }],
        ),
    );

    let renderer = SkiaLayerRenderer::new();
    let png = renderer
        .render_png(&tree)
        .expect("vertical sideways text render");
    let pixmap = tiny_skia::Pixmap::decode_png(&png).expect("png decode");
    let bounds = alpha_bounds(&pixmap).expect("vertical sideways ink");

    assert!(
        bounds.height() > bounds.width(),
        "sideways vertical text must use the explicit 90 degree run rotation, got {bounds:?}"
    );
}

#[test]
fn skia_vertical_upright_uses_layout_glyph_positions() {
    let first = BoundingBox::new(50.0, 18.0, 26.0, 26.0);
    let second = BoundingBox::new(50.0, 52.0, 26.0, 26.0);
    let make_run = |text: &str| LayerTextRunPaint {
        source: None,
        text: text.to_string(),
        display_text: None,
        style: TextStyle {
            font_family: "sans-serif".to_string(),
            font_size: 22.0,
            color: 0x00000000,
            ..Default::default()
        },
        positions: vec![0.0, 22.0],
        control_marks: Vec::new(),
        baseline: 22.0,
        rotation: 0.0,
        is_vertical: true,
        orientation: LayerTextOrientation::VerticalUpright,
        char_overlap: None,
        field_marker: Default::default(),
        is_para_end: false,
        is_line_break_end: false,
        ..Default::default()
    };
    let tree = PageLayerTree::new(
        130.0,
        110.0,
        LayerNode::leaf(
            BoundingBox::new(0.0, 0.0, 130.0, 110.0),
            None,
            vec![
                PaintOp::TextRun {
                    bbox: first,
                    run: make_run("가"),
                },
                PaintOp::TextRun {
                    bbox: second,
                    run: make_run("나"),
                },
            ],
        ),
    );

    let renderer = SkiaLayerRenderer::new();
    let png = renderer
        .render_png(&tree)
        .expect("vertical upright text render");
    let pixmap = tiny_skia::Pixmap::decode_png(&png).expect("png decode");
    let bounds = alpha_bounds(&pixmap).expect("vertical upright ink");

    assert!(
        bounds.height() > bounds.width() * 2,
        "upright vertical glyphs must follow layout-provided stacked bboxes, got {bounds:?}"
    );
}

#[test]
fn native_skia_replays_portable_glyph_run_variant() {
    let renderer = SkiaLayerRenderer::new();
    let style = TextStyle {
        font_family: "sans-serif".to_string(),
        font_size: 32.0,
        ..Default::default()
    };
    let glyph_id = make_font(&style, &renderer.font_mgr, "A")
        .text_to_glyphs_vec("A")
        .into_iter()
        .next()
        .expect("test font should map A to a glyph");
    assert_ne!(glyph_id, 0, "test font should not return missing glyph");

    let tree = glyph_variant_test_tree(&[glyph_id], GlyphRunReplayEligibility::Portable);
    let output = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("portable glyph variant render");
    let pixmap = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");
    let bounds = alpha_bounds(&pixmap).expect("glyph variant ink");

    assert!(
        bounds.max_x < 100,
        "native Skia should select the left-side GlyphRun variant instead of the right-side TextRun fallback, got {bounds:?}"
    );
    let report = output
        .diagnostics
        .variant_selections
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("native Skia variant selection report");
    assert_eq!(report.backend, VariantSelectionBackend::NativeSkia);
    assert_eq!(report.render_profile, "screen");
    assert_eq!(report.selected_variant_id, "glyphRun");
    assert_eq!(
        report.selected_reason,
        VariantSelectedReason::GlyphRunStrictEligible
    );
    assert_eq!(report.parts_expected, 1);
    assert_eq!(report.parts_replayed, 1);
}

#[test]
fn native_skia_replays_monochrome_glyph_outline_variant() {
    let renderer = SkiaLayerRenderer::new();
    let outline = glyph_outline_test_paint(GlyphOutlinePayloadKind::MonochromeFill, None, None);
    let tree = glyph_outline_variant_test_tree(outline, true);
    if let LayerNodeKind::Leaf { ops, .. } = &tree.root.kind {
        assert!(matches!(
            &ops[0],
            PaintOp::TextRun { run, .. }
                if run
                    .variant
                    .as_ref()
                    .is_some_and(|variant| variant.equivalence_group == "text-0")
        ));
        let selection = select_text_variant_sets_with_report(
            ops,
            |_| VariantReplayStatus::rejected(VariantRejectReason::VariantUnsupported),
            |_| VariantReplayStatus::replayable(),
            VariantSelectionContext {
                backend: VariantSelectionBackend::NativeSkia,
                render_profile: "screen".to_string(),
            },
        );
        assert!(
            !should_render_selected_text_variant(&ops[0], &selection.selected),
            "selected GlyphOutline should suppress the TextRun fallback"
        );
    }
    let output = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("monochrome glyph outline variant render");
    let pixmap = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");
    let bounds = alpha_bounds(&pixmap).expect("glyph outline ink");
    let red_pixels = count_pixels_matching(&pixmap, |pixel| {
        pixel.alpha() > 160 && pixel.red() > 180 && pixel.green() < 80 && pixel.blue() < 80
    });
    let report = output
        .diagnostics
        .variant_selections
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("native Skia glyph outline selection report");

    assert!(
        bounds.max_x < 70,
        "native Skia should replay the left-side GlyphOutline variant, got {bounds:?}"
    );
    assert!(
        red_pixels > 300,
        "monochrome GlyphOutline should paint the resolved red path, red={red_pixels}"
    );
    assert_eq!(report.backend, VariantSelectionBackend::NativeSkia);
    assert_eq!(report.selected_variant_id, "glyphOutline");
    assert_eq!(
        report.selected_reason,
        VariantSelectedReason::GlyphOutlineStrictProfile
    );
    assert_eq!(output.diagnostics.paint_ops_replayed, 1);
    assert_eq!(report.parts_expected, 1);
    assert_eq!(report.parts_replayed, 1);
}

#[test]
fn native_skia_replays_sidecar_glyph_outline_variant() {
    let renderer = SkiaLayerRenderer::new();
    let outline = glyph_outline_test_paint(GlyphOutlinePayloadKind::MonochromeFill, None, None);
    let tree = glyph_outline_sidecar_variant_test_tree(outline, true);

    let output = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("sidecar glyph outline variant render");
    let pixmap = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");
    let bounds = alpha_bounds(&pixmap).expect("sidecar glyph outline ink");
    let red_pixels = count_pixels_matching(&pixmap, |pixel| {
        pixel.alpha() > 160 && pixel.red() > 180 && pixel.green() < 80 && pixel.blue() < 80
    });
    let report = output
        .diagnostics
        .variant_selections
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("native Skia sidecar glyph outline selection report");

    assert!(
        bounds.max_x < 70,
        "native Skia should replay the sidecar GlyphOutline instead of the fallback TextRun, got {bounds:?}"
    );
    assert!(
        red_pixels > 300,
        "sidecar GlyphOutline should paint the resolved red path, red={red_pixels}"
    );
    assert_eq!(report.backend, VariantSelectionBackend::NativeSkia);
    assert_eq!(report.selected_variant_id, "glyphOutline");
    assert_eq!(
        report.selected_reason,
        VariantSelectedReason::GlyphOutlineStrictProfile
    );
    assert_eq!(report.anchor_op_id.as_deref(), Some("op-text-0"));
    assert_eq!(output.diagnostics.paint_ops_replayed, 1);
    assert_eq!(report.parts_expected, 1);
    assert_eq!(report.parts_replayed, 1);
    assert!(report.rejected_variants.is_empty());
}

#[test]
fn native_skia_replays_monochrome_glyph_outline_stroke_subset() {
    let renderer = SkiaLayerRenderer::new();
    let outline = glyph_outline_test_paint(
        GlyphOutlinePayloadKind::MonochromeFillStroke,
        Some(GlyphOutlineStrokeStyle {
            color: 0xff0000,
            width_px: 4.0,
            join: GlyphOutlineStrokeJoin::Miter,
            cap: GlyphOutlineStrokeCap::Butt,
            miter_limit: Some(4.0),
            paint_order: GlyphOutlinePaintOrder::FillThenStroke,
        }),
        None,
    );
    let tree = glyph_outline_variant_test_tree(outline, true);
    let output = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("stroked glyph outline variant render");
    let pixmap = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");
    let red_pixels = count_pixels_matching(&pixmap, |pixel| {
        pixel.alpha() > 160 && pixel.red() > 180 && pixel.green() < 80 && pixel.blue() < 80
    });
    let blue_pixels = count_pixels_matching(&pixmap, |pixel| {
        pixel.alpha() > 160 && pixel.blue() > 180 && pixel.red() < 80 && pixel.green() < 80
    });

    assert!(
        red_pixels > 200 && blue_pixels > 100,
        "stroked GlyphOutline should paint both fill and stroke, red={red_pixels}, blue={blue_pixels}"
    );
}

#[test]
fn native_skia_keeps_text_fallback_for_invalid_glyph_outline_path_payload() {
    let assert_invalid_path_payload_rejected = |outline: LayerGlyphOutlinePaint, label: &str| {
        let renderer = SkiaLayerRenderer::new();
        let tree = glyph_outline_variant_test_tree(outline, true);
        let output = renderer
            .render_raster_with_options(&tree, RasterRenderOptions::default())
            .unwrap_or_else(|err| panic!("invalid path payload fallback render: {label}: {err}"));
        let pixmap = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");
        let bounds = alpha_bounds(&pixmap).expect("text fallback ink");
        let report = output
            .diagnostics
            .variant_selections
            .iter()
            .find(|report| report.equivalence_group == "text-0")
            .unwrap_or_else(|| panic!("native Skia invalid path payload report: {label}"));

        assert!(
            bounds.min_x > 95,
            "native Skia must keep TextRun fallback for invalid path payload {label}, got {bounds:?}"
        );
        assert_eq!(report.selected_variant_id, "textRun", "{label}");
        assert!(report.rejected_variants.iter().any(|variant| {
            variant.variant_id == "glyphOutline"
                && variant
                    .reasons
                    .contains(&VariantRejectReason::UnsupportedOutlinePayload)
        }));
    };

    let mut reversed_source_range =
        glyph_outline_test_paint(GlyphOutlinePayloadKind::MonochromeFill, None, None);
    reversed_source_range.paths[0].source_range_utf8 = TextSourceRange::new(2, 1);
    assert_invalid_path_payload_rejected(reversed_source_range, "reversed source range");

    let mut reversed_glyph_range =
        glyph_outline_test_paint(GlyphOutlinePayloadKind::MonochromeFill, None, None);
    reversed_glyph_range.paths[0].glyph_range = GlyphRange::new(2, 1);
    assert_invalid_path_payload_rejected(reversed_glyph_range, "reversed glyph range");

    let mut non_finite_command =
        glyph_outline_test_paint(GlyphOutlinePayloadKind::MonochromeFill, None, None);
    non_finite_command.paths[0].commands[1] = PathCommand::LineTo(f64::INFINITY, 0.0);
    assert_invalid_path_payload_rejected(non_finite_command, "non-finite path command");
}

#[test]
fn native_skia_replays_colrv0_color_layers_variant() {
    let renderer = SkiaLayerRenderer::new();
    let color_layers = ColorLayersPayload {
        color_format: ColorGlyphFormat::ColrV0,
        source_font_ref: Some(FontColorGlyphRef {
            face_key: Some("test-face".to_string()),
            glyph_id: Some(1),
            palette_index: Some(2),
            color_format: Some(ColorGlyphFormat::ColrV0),
        }),
        palette_ref: None,
        layers: vec![ColorLayerNode {
            layer_index: Some(0),
            glyph_id: Some(1),
            glyph_range: Some(GlyphRange::new(0, 1)),
            source_range_utf8: Some(TextSourceRange::new(0, 1)),
            source_font_ref: Some(FontColorGlyphRef {
                face_key: Some("test-face".to_string()),
                glyph_id: Some(1),
                palette_index: Some(2),
                color_format: Some(ColorGlyphFormat::ColrV0),
            }),
            path_index: Some(0),
            commands: Some(vec![
                PathCommand::MoveTo(0.0, 0.0),
                PathCommand::LineTo(30.0, 0.0),
                PathCommand::LineTo(30.0, 28.0),
                PathCommand::LineTo(0.0, 28.0),
                PathCommand::ClosePath,
            ]),
            fill: Some(ResolvedColor {
                color_space: Some("srgb".to_string()),
                rgba: [0.0, 1.0, 0.0, 1.0],
            }),
            fill_rule: Some(GlyphOutlineFillRule::NonZero),
            palette_index: Some(2),
            color: None,
            opacity: Some(1.0),
            transform_to_run: None,
        }],
        paint_graph: None,
        source_range_utf8: Some(TextSourceRange::new(0, 1)),
        glyph_range: Some(GlyphRange::new(0, 1)),
    };
    let outline = glyph_outline_test_paint(
        GlyphOutlinePayloadKind::ColorLayers,
        None,
        Some(color_layers),
    );
    let tree = glyph_outline_variant_test_tree(outline, true);
    let output = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("COLRv0 glyph outline variant render");
    let pixmap = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");
    let green_pixels = count_pixels_matching(&pixmap, |pixel| {
        pixel.alpha() > 160 && pixel.green() > 180 && pixel.red() < 80 && pixel.blue() < 80
    });
    let report = output
        .diagnostics
        .variant_selections
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("native Skia COLRv0 glyph outline selection report");

    assert!(
        green_pixels > 300,
        "COLRv0 GlyphOutline should paint resolved color layers, green={green_pixels}"
    );
    assert_eq!(report.selected_variant_id, "glyphOutline");
    assert_eq!(
        report.selected_reason,
        VariantSelectedReason::GlyphOutlineStrictProfile
    );
}

#[test]
fn native_skia_replays_colrv1_stage1_solid_transform_graph() {
    let renderer = SkiaLayerRenderer::new();
    let source_font_ref = FontColorGlyphRef {
        face_key: Some("test-face".to_string()),
        glyph_id: Some(1),
        palette_index: Some(3),
        color_format: Some(ColorGlyphFormat::ColrV1),
    };
    let color_layers = ColorLayersPayload {
        color_format: ColorGlyphFormat::ColrV1,
        source_font_ref: Some(source_font_ref.clone()),
        palette_ref: None,
        layers: Vec::new(),
        paint_graph: Some(ColorPaintGraphPayload {
            root_node_id: 10,
            nodes: vec![
                ColorPaintGraphNode {
                    node_id: 10,
                    kind: ColorPaintGraphNodeKind::Transform,
                    solid_path: None,
                    linear_gradient_path: None,
                    radial_gradient_path: None,
                    sweep_gradient_path: None,
                    transform: Some(ColorPaintTransformNode {
                        child_node_id: 20,
                        transform: LayerAffineTransform {
                            a: 1.0,
                            b: 0.0,
                            c: 0.0,
                            d: 1.0,
                            e: 8.0,
                            f: 0.0,
                        },
                    }),
                    composite: None,
                    clip: None,
                    source_range_utf8: None,
                    glyph_range: None,
                    source_font_ref: None,
                },
                ColorPaintGraphNode {
                    node_id: 20,
                    kind: ColorPaintGraphNodeKind::SolidPath,
                    solid_path: Some(ColorPaintSolidPathNode {
                        commands: vec![
                            PathCommand::MoveTo(0.0, 0.0),
                            PathCommand::LineTo(22.0, 0.0),
                            PathCommand::LineTo(22.0, 28.0),
                            PathCommand::LineTo(0.0, 28.0),
                            PathCommand::ClosePath,
                        ],
                        fill: ResolvedColor {
                            color_space: Some("srgb".to_string()),
                            rgba: [0.0, 0.0, 1.0, 1.0],
                        },
                        fill_rule: GlyphOutlineFillRule::NonZero,
                        source_glyph_id: Some(1),
                        palette_index: Some(3),
                    }),
                    linear_gradient_path: None,
                    radial_gradient_path: None,
                    sweep_gradient_path: None,
                    composite: None,
                    clip: None,
                    source_range_utf8: Some(TextSourceRange::new(0, 1)),
                    glyph_range: Some(GlyphRange::new(0, 1)),
                    source_font_ref: Some(source_font_ref),
                    transform: None,
                },
            ],
        }),
        source_range_utf8: Some(TextSourceRange::new(0, 1)),
        glyph_range: Some(GlyphRange::new(0, 1)),
    };
    let outline = glyph_outline_test_paint(
        GlyphOutlinePayloadKind::ColorLayers,
        None,
        Some(color_layers),
    );
    let tree = glyph_outline_variant_test_tree(outline, true);
    let output = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("COLRv1 stage-1 glyph outline variant render");
    let pixmap = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");
    let bounds = alpha_bounds(&pixmap).expect("COLRv1 stage-1 glyph outline ink");
    let blue_pixels = count_pixels_matching(&pixmap, |pixel| {
        pixel.alpha() > 160 && pixel.blue() > 180 && pixel.red() < 80 && pixel.green() < 80
    });
    let report = output
        .diagnostics
        .variant_selections
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("native Skia COLRv1 stage-1 glyph outline selection report");

    assert!(
        bounds.min_x >= 30,
        "COLRv1 transform node should shift the solid path in run-local space, got {bounds:?}"
    );
    assert!(
        blue_pixels > 250,
        "COLRv1 stage-1 GlyphOutline should paint the normalized solid graph, blue={blue_pixels}"
    );
    assert_eq!(report.selected_variant_id, "glyphOutline");
    assert_eq!(
        report.selected_reason,
        VariantSelectedReason::GlyphOutlineStrictProfile
    );
}

#[test]
fn native_skia_replays_colrv1_stage2_gradient_graph_leaves() {
    let renderer = SkiaLayerRenderer::new();
    let source_font_ref = FontColorGlyphRef {
        face_key: Some("test-face".to_string()),
        glyph_id: Some(7),
        palette_index: Some(2),
        color_format: Some(ColorGlyphFormat::ColrV1),
    };
    let color_stops = vec![
        ColorGradientStop {
            offset: 0.0,
            color: ResolvedColor {
                color_space: Some("srgb".to_string()),
                rgba: [1.0, 0.0, 0.0, 1.0],
            },
        },
        ColorGradientStop {
            offset: 1.0,
            color: ResolvedColor {
                color_space: Some("srgb".to_string()),
                rgba: [0.0, 0.0, 1.0, 1.0],
            },
        },
    ];
    let linear_color_layers = ColorLayersPayload {
        color_format: ColorGlyphFormat::ColrV1,
        source_font_ref: Some(source_font_ref.clone()),
        palette_ref: None,
        layers: Vec::new(),
        paint_graph: Some(ColorPaintGraphPayload {
            root_node_id: 1,
            nodes: vec![ColorPaintGraphNode {
                node_id: 1,
                kind: ColorPaintGraphNodeKind::LinearGradientPath,
                solid_path: None,
                linear_gradient_path: Some(ColorPaintLinearGradientPathNode {
                    commands: vec![
                        PathCommand::MoveTo(0.0, 0.0),
                        PathCommand::LineTo(32.0, 0.0),
                        PathCommand::LineTo(32.0, 28.0),
                        PathCommand::LineTo(0.0, 28.0),
                        PathCommand::ClosePath,
                    ],
                    gradient: ColorLinearGradient {
                        x0: 0.0,
                        y0: 0.0,
                        x1: 32.0,
                        y1: 0.0,
                        stops: color_stops.clone(),
                    },
                    fill_rule: GlyphOutlineFillRule::NonZero,
                    source_glyph_id: Some(7),
                    palette_index: Some(2),
                }),
                radial_gradient_path: None,
                sweep_gradient_path: None,
                transform: None,
                composite: None,
                clip: None,
                source_range_utf8: Some(TextSourceRange::new(0, 1)),
                glyph_range: Some(GlyphRange::new(0, 1)),
                source_font_ref: Some(source_font_ref.clone()),
            }],
        }),
        source_range_utf8: Some(TextSourceRange::new(0, 1)),
        glyph_range: Some(GlyphRange::new(0, 1)),
    };
    let linear_outline = glyph_outline_test_paint(
        GlyphOutlinePayloadKind::ColorLayers,
        None,
        Some(linear_color_layers),
    );
    let linear_tree = glyph_outline_variant_test_tree(linear_outline, true);
    let linear_output = renderer
        .render_raster_with_options(&linear_tree, RasterRenderOptions::default())
        .expect("COLRv1 linear gradient glyph outline variant render");
    let linear_pixmap = tiny_skia::Pixmap::decode_png(&linear_output.bytes).expect("png decode");
    let linear_red_pixels = count_pixels_matching(&linear_pixmap, |pixel| {
        pixel.alpha() > 160 && pixel.red() > 180 && pixel.blue() < 90
    });
    let linear_blue_pixels = count_pixels_matching(&linear_pixmap, |pixel| {
        pixel.alpha() > 160 && pixel.blue() > 180 && pixel.red() < 90
    });
    let linear_report = linear_output
        .diagnostics
        .variant_selections
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("native Skia COLRv1 linear gradient selection report");

    assert!(
        linear_red_pixels > 80 && linear_blue_pixels > 80,
        "COLRv1 linear gradient should paint red and blue ends, red={linear_red_pixels}, blue={linear_blue_pixels}"
    );
    assert_eq!(linear_report.selected_variant_id, "glyphOutline");
    assert_eq!(
        linear_report.selected_reason,
        VariantSelectedReason::GlyphOutlineStrictProfile
    );

    let radial_color_layers = ColorLayersPayload {
        color_format: ColorGlyphFormat::ColrV1,
        source_font_ref: Some(source_font_ref.clone()),
        palette_ref: None,
        layers: Vec::new(),
        paint_graph: Some(ColorPaintGraphPayload {
            root_node_id: 2,
            nodes: vec![ColorPaintGraphNode {
                node_id: 2,
                kind: ColorPaintGraphNodeKind::RadialGradientPath,
                solid_path: None,
                linear_gradient_path: None,
                radial_gradient_path: Some(ColorPaintRadialGradientPathNode {
                    commands: vec![
                        PathCommand::MoveTo(0.0, 0.0),
                        PathCommand::LineTo(32.0, 0.0),
                        PathCommand::LineTo(32.0, 28.0),
                        PathCommand::LineTo(0.0, 28.0),
                        PathCommand::ClosePath,
                    ],
                    gradient: ColorRadialGradient {
                        cx: 16.0,
                        cy: 14.0,
                        radius: 16.0,
                        stops: color_stops.clone(),
                    },
                    fill_rule: GlyphOutlineFillRule::NonZero,
                    source_glyph_id: Some(7),
                    palette_index: Some(2),
                }),
                sweep_gradient_path: None,
                transform: None,
                composite: None,
                clip: None,
                source_range_utf8: Some(TextSourceRange::new(0, 1)),
                glyph_range: Some(GlyphRange::new(0, 1)),
                source_font_ref: Some(source_font_ref.clone()),
            }],
        }),
        source_range_utf8: Some(TextSourceRange::new(0, 1)),
        glyph_range: Some(GlyphRange::new(0, 1)),
    };
    let radial_outline = glyph_outline_test_paint(
        GlyphOutlinePayloadKind::ColorLayers,
        None,
        Some(radial_color_layers),
    );
    let radial_tree = glyph_outline_variant_test_tree(radial_outline, true);
    let radial_output = renderer
        .render_raster_with_options(&radial_tree, RasterRenderOptions::default())
        .expect("COLRv1 radial gradient glyph outline variant render");
    let radial_pixmap = tiny_skia::Pixmap::decode_png(&radial_output.bytes).expect("png decode");
    let radial_red_pixels = count_pixels_matching(&radial_pixmap, |pixel| {
        pixel.alpha() > 160 && pixel.red() > 180 && pixel.blue() < 90
    });
    let radial_blue_pixels = count_pixels_matching(&radial_pixmap, |pixel| {
        pixel.alpha() > 160 && pixel.blue() > 180 && pixel.red() < 90
    });
    let radial_report = radial_output
        .diagnostics
        .variant_selections
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("native Skia COLRv1 radial gradient selection report");

    assert!(
        radial_red_pixels > 40 && radial_blue_pixels > 40,
        "COLRv1 radial gradient should paint red center and blue rim, red={radial_red_pixels}, blue={radial_blue_pixels}"
    );
    assert_eq!(radial_report.selected_variant_id, "glyphOutline");
    assert_eq!(
        radial_report.selected_reason,
        VariantSelectedReason::GlyphOutlineStrictProfile
    );

    let sweep_color_layers = ColorLayersPayload {
        color_format: ColorGlyphFormat::ColrV1,
        source_font_ref: Some(source_font_ref.clone()),
        palette_ref: None,
        layers: Vec::new(),
        paint_graph: Some(ColorPaintGraphPayload {
            root_node_id: 3,
            nodes: vec![ColorPaintGraphNode {
                node_id: 3,
                kind: ColorPaintGraphNodeKind::SweepGradientPath,
                solid_path: None,
                linear_gradient_path: None,
                radial_gradient_path: None,
                sweep_gradient_path: Some(ColorPaintSweepGradientPathNode {
                    commands: vec![
                        PathCommand::MoveTo(0.0, 0.0),
                        PathCommand::LineTo(32.0, 0.0),
                        PathCommand::LineTo(32.0, 28.0),
                        PathCommand::LineTo(0.0, 28.0),
                        PathCommand::ClosePath,
                    ],
                    gradient: ColorSweepGradient {
                        cx: 16.0,
                        cy: 14.0,
                        start_angle_degrees: 0.0,
                        end_angle_degrees: 360.0,
                        stops: color_stops,
                    },
                    fill_rule: GlyphOutlineFillRule::NonZero,
                    source_glyph_id: Some(7),
                    palette_index: Some(2),
                }),
                transform: None,
                composite: None,
                clip: None,
                source_range_utf8: Some(TextSourceRange::new(0, 1)),
                glyph_range: Some(GlyphRange::new(0, 1)),
                source_font_ref: Some(source_font_ref),
            }],
        }),
        source_range_utf8: Some(TextSourceRange::new(0, 1)),
        glyph_range: Some(GlyphRange::new(0, 1)),
    };
    let sweep_outline = glyph_outline_test_paint(
        GlyphOutlinePayloadKind::ColorLayers,
        None,
        Some(sweep_color_layers),
    );
    let sweep_tree = glyph_outline_variant_test_tree(sweep_outline, true);
    let sweep_output = renderer
        .render_raster_with_options(&sweep_tree, RasterRenderOptions::default())
        .expect("COLRv1 sweep gradient glyph outline variant render");
    let sweep_pixmap = tiny_skia::Pixmap::decode_png(&sweep_output.bytes).expect("png decode");
    let sweep_red_pixels = count_pixels_matching(&sweep_pixmap, |pixel| {
        pixel.alpha() > 160 && pixel.red() > 160 && pixel.green() < 140 && pixel.blue() < 140
    });
    let sweep_blue_pixels = count_pixels_matching(&sweep_pixmap, |pixel| {
        pixel.alpha() > 160 && pixel.blue() > 160 && pixel.green() < 140 && pixel.red() < 140
    });
    let sweep_report = sweep_output
        .diagnostics
        .variant_selections
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("native Skia COLRv1 sweep gradient selection report");

    assert!(
        sweep_red_pixels > 20 && sweep_blue_pixels > 20,
        "COLRv1 sweep gradient should paint red and blue angular sectors, red={sweep_red_pixels}, blue={sweep_blue_pixels}"
    );
    assert_eq!(sweep_report.selected_variant_id, "glyphOutline");
    assert_eq!(
        sweep_report.selected_reason,
        VariantSelectedReason::GlyphOutlineStrictProfile
    );
}

#[test]
fn native_skia_replays_colrv1_stage4_source_over_composite_graph() {
    let renderer = SkiaLayerRenderer::new();
    let source_font_ref = FontColorGlyphRef {
        face_key: Some("test-face".to_string()),
        glyph_id: Some(9),
        palette_index: Some(4),
        color_format: Some(ColorGlyphFormat::ColrV1),
    };
    let solid_node = |node_id: u32,
                      rgba: [f32; 4],
                      x0: f64,
                      x1: f64,
                      source_start: u32|
     -> ColorPaintGraphNode {
        ColorPaintGraphNode {
            node_id,
            kind: ColorPaintGraphNodeKind::SolidPath,
            solid_path: Some(ColorPaintSolidPathNode {
                commands: vec![
                    PathCommand::MoveTo(x0, 0.0),
                    PathCommand::LineTo(x1, 0.0),
                    PathCommand::LineTo(x1, 28.0),
                    PathCommand::LineTo(x0, 28.0),
                    PathCommand::ClosePath,
                ],
                fill: ResolvedColor {
                    color_space: Some("srgb".to_string()),
                    rgba,
                },
                fill_rule: GlyphOutlineFillRule::NonZero,
                source_glyph_id: Some(node_id),
                palette_index: Some(4),
            }),
            linear_gradient_path: None,
            radial_gradient_path: None,
            sweep_gradient_path: None,
            transform: None,
            composite: None,
            clip: None,
            source_range_utf8: Some(TextSourceRange::new(source_start, source_start + 1)),
            glyph_range: Some(GlyphRange::new(source_start, source_start + 1)),
            source_font_ref: Some(source_font_ref.clone()),
        }
    };
    let color_layers = ColorLayersPayload {
        color_format: ColorGlyphFormat::ColrV1,
        source_font_ref: Some(source_font_ref.clone()),
        palette_ref: None,
        layers: Vec::new(),
        paint_graph: Some(ColorPaintGraphPayload {
            root_node_id: 3,
            nodes: vec![
                solid_node(1, [0.0, 0.0, 1.0, 1.0], 0.0, 32.0, 0),
                solid_node(2, [1.0, 0.0, 0.0, 1.0], 8.0, 24.0, 1),
                ColorPaintGraphNode {
                    node_id: 3,
                    kind: ColorPaintGraphNodeKind::Composite,
                    solid_path: None,
                    linear_gradient_path: None,
                    radial_gradient_path: None,
                    sweep_gradient_path: None,
                    transform: None,
                    composite: Some(ColorPaintCompositeNode {
                        backdrop_node_id: 1,
                        source_node_id: 2,
                        mode: ColorPaintCompositeMode::SourceOver,
                    }),
                    clip: None,
                    source_range_utf8: None,
                    glyph_range: None,
                    source_font_ref: None,
                },
            ],
        }),
        source_range_utf8: Some(TextSourceRange::new(0, 2)),
        glyph_range: Some(GlyphRange::new(0, 2)),
    };
    let outline = glyph_outline_test_paint(
        GlyphOutlinePayloadKind::ColorLayers,
        None,
        Some(color_layers),
    );
    let tree = glyph_outline_variant_test_tree(outline, true);
    let output = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("COLRv1 source-over composite glyph outline variant render");
    let pixmap = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");
    let red_pixels = count_pixels_matching(&pixmap, |pixel| {
        pixel.alpha() > 160 && pixel.red() > 180 && pixel.blue() < 80 && pixel.green() < 80
    });
    let blue_pixels = count_pixels_matching(&pixmap, |pixel| {
        pixel.alpha() > 160 && pixel.blue() > 180 && pixel.red() < 80 && pixel.green() < 80
    });
    let report = output
        .diagnostics
        .variant_selections
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("native Skia COLRv1 source-over composite selection report");

    assert!(
        red_pixels > 150 && blue_pixels > 150,
        "COLRv1 source-over composite should paint backdrop and source, red={red_pixels}, blue={blue_pixels}"
    );
    assert_eq!(report.selected_variant_id, "glyphOutline");
    assert_eq!(
        report.selected_reason,
        VariantSelectedReason::GlyphOutlineStrictProfile
    );
}

#[test]
fn native_skia_replays_colrv1_stage5_clip_graph() {
    let renderer = SkiaLayerRenderer::new();
    let source_font_ref = FontColorGlyphRef {
        face_key: Some("test-face".to_string()),
        glyph_id: Some(9),
        palette_index: Some(4),
        color_format: Some(ColorGlyphFormat::ColrV1),
    };
    let color_layers = ColorLayersPayload {
        color_format: ColorGlyphFormat::ColrV1,
        source_font_ref: Some(source_font_ref.clone()),
        palette_ref: None,
        layers: Vec::new(),
        paint_graph: Some(ColorPaintGraphPayload {
            root_node_id: 2,
            nodes: vec![
                ColorPaintGraphNode {
                    node_id: 1,
                    kind: ColorPaintGraphNodeKind::SolidPath,
                    solid_path: Some(ColorPaintSolidPathNode {
                        commands: vec![
                            PathCommand::MoveTo(0.0, 0.0),
                            PathCommand::LineTo(32.0, 0.0),
                            PathCommand::LineTo(32.0, 28.0),
                            PathCommand::LineTo(0.0, 28.0),
                            PathCommand::ClosePath,
                        ],
                        fill: ResolvedColor {
                            color_space: Some("srgb".to_string()),
                            rgba: [1.0, 0.0, 0.0, 1.0],
                        },
                        fill_rule: GlyphOutlineFillRule::NonZero,
                        source_glyph_id: Some(1),
                        palette_index: Some(4),
                    }),
                    linear_gradient_path: None,
                    radial_gradient_path: None,
                    sweep_gradient_path: None,
                    transform: None,
                    composite: None,
                    clip: None,
                    source_range_utf8: Some(TextSourceRange::new(0, 1)),
                    glyph_range: Some(GlyphRange::new(0, 1)),
                    source_font_ref: Some(source_font_ref.clone()),
                },
                ColorPaintGraphNode {
                    node_id: 2,
                    kind: ColorPaintGraphNodeKind::Clip,
                    solid_path: None,
                    linear_gradient_path: None,
                    radial_gradient_path: None,
                    sweep_gradient_path: None,
                    transform: None,
                    composite: None,
                    clip: Some(ColorPaintClipNode {
                        child_node_id: 1,
                        clip_commands: vec![
                            PathCommand::MoveTo(0.0, 0.0),
                            PathCommand::LineTo(14.0, 0.0),
                            PathCommand::LineTo(14.0, 28.0),
                            PathCommand::LineTo(0.0, 28.0),
                            PathCommand::ClosePath,
                        ],
                        fill_rule: GlyphOutlineFillRule::NonZero,
                    }),
                    source_range_utf8: None,
                    glyph_range: None,
                    source_font_ref: None,
                },
            ],
        }),
        source_range_utf8: Some(TextSourceRange::new(0, 1)),
        glyph_range: Some(GlyphRange::new(0, 1)),
    };
    let outline = glyph_outline_test_paint(
        GlyphOutlinePayloadKind::ColorLayers,
        None,
        Some(color_layers),
    );
    let tree = glyph_outline_variant_test_tree(outline, true);
    let output = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("COLRv1 clip glyph outline variant render");
    let pixmap = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");
    let bounds = alpha_bounds(&pixmap).expect("COLRv1 clipped glyph outline ink");
    let report = output
        .diagnostics
        .variant_selections
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("native Skia COLRv1 clipped selection report");

    assert!(
        bounds.min_x >= 23 && bounds.max_x <= 40,
        "COLRv1 clip graph should constrain ink to the left clip box, got {bounds:?}"
    );
    assert_eq!(report.selected_variant_id, "glyphOutline");
    assert_eq!(
        report.selected_reason,
        VariantSelectedReason::GlyphOutlineStrictProfile
    );
}

#[test]
fn native_skia_keeps_text_fallback_for_invalid_colrv1_gradient_graph() {
    let renderer = SkiaLayerRenderer::new();
    let source_font_ref = FontColorGlyphRef {
        face_key: Some("test-face".to_string()),
        glyph_id: Some(8),
        palette_index: Some(1),
        color_format: Some(ColorGlyphFormat::ColrV1),
    };
    let invalid_color_layers = ColorLayersPayload {
        color_format: ColorGlyphFormat::ColrV1,
        source_font_ref: Some(source_font_ref.clone()),
        palette_ref: None,
        layers: Vec::new(),
        paint_graph: Some(ColorPaintGraphPayload {
            root_node_id: 1,
            nodes: vec![ColorPaintGraphNode {
                node_id: 1,
                kind: ColorPaintGraphNodeKind::LinearGradientPath,
                solid_path: None,
                linear_gradient_path: Some(ColorPaintLinearGradientPathNode {
                    commands: vec![
                        PathCommand::MoveTo(0.0, 0.0),
                        PathCommand::LineTo(32.0, 0.0),
                        PathCommand::LineTo(32.0, 28.0),
                        PathCommand::LineTo(0.0, 28.0),
                        PathCommand::ClosePath,
                    ],
                    gradient: ColorLinearGradient {
                        x0: 0.0,
                        y0: 0.0,
                        x1: 32.0,
                        y1: 0.0,
                        stops: vec![ColorGradientStop {
                            offset: 0.0,
                            color: ResolvedColor {
                                color_space: Some("srgb".to_string()),
                                rgba: [1.0, 0.0, 0.0, 1.0],
                            },
                        }],
                    },
                    fill_rule: GlyphOutlineFillRule::NonZero,
                    source_glyph_id: Some(8),
                    palette_index: Some(1),
                }),
                radial_gradient_path: None,
                sweep_gradient_path: None,
                transform: None,
                composite: None,
                clip: None,
                source_range_utf8: Some(TextSourceRange::new(0, 1)),
                glyph_range: Some(GlyphRange::new(0, 1)),
                source_font_ref: Some(source_font_ref),
            }],
        }),
        source_range_utf8: Some(TextSourceRange::new(0, 1)),
        glyph_range: Some(GlyphRange::new(0, 1)),
    };
    let outline = glyph_outline_test_paint(
        GlyphOutlinePayloadKind::ColorLayers,
        None,
        Some(invalid_color_layers),
    );
    let tree = glyph_outline_variant_test_tree(outline, true);
    let output = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("invalid COLRv1 gradient fallback render");
    let pixmap = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");
    let bounds = alpha_bounds(&pixmap).expect("text fallback ink");
    let report = output
        .diagnostics
        .variant_selections
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("native Skia invalid COLRv1 gradient fallback selection report");

    assert!(
        bounds.min_x > 95,
        "native Skia must keep TextRun fallback when COLRv1 gradient graph is invalid, got {bounds:?}"
    );
    assert_eq!(report.selected_variant_id, "textRun");
    assert!(report.rejected_variants.iter().any(|variant| {
        variant.variant_id == "glyphOutline"
            && variant
                .reasons
                .contains(&VariantRejectReason::UnsupportedColorGlyph)
    }));
}

#[test]
fn native_skia_replays_bitmap_glyph_resource_variant() {
    let renderer = SkiaLayerRenderer::new();
    let mut pixmap = tiny_skia::Pixmap::new(4, 4).expect("bitmap glyph pixmap");
    for pixel in pixmap.pixels_mut() {
        *pixel = tiny_skia::PremultipliedColorU8::from_rgba(255, 0, 255, 255).unwrap();
    }
    let image_bytes = pixmap.encode_png().expect("bitmap glyph png");
    let mut resources = ResourceArena::default();
    let image_resource_id = resources.intern_image_bytes(&image_bytes);
    let mut outline = glyph_outline_test_paint(GlyphOutlinePayloadKind::BitmapGlyph, None, None);
    outline.bitmap_glyph = Some(BitmapGlyphPayload {
        image_resource_id,
        source_range_utf8: Some(TextSourceRange::new(0, 1)),
        glyph_range: Some(GlyphRange::new(0, 1)),
        placement: Some(outline.placement),
        transform_to_run: None,
        strike_ppem: Some((4, 4)),
        strike_selection: Some(BitmapStrikeSelection::ProducerResolved),
        pixel_format: Some("rgba8".to_string()),
        color_space: None,
        alpha_mode: Some(BitmapAlphaMode::Straight),
        scaling_policy: Some(BitmapGlyphScalingPolicy::ExplicitTransform),
        filtering: Some(BitmapGlyphFiltering::Nearest),
    });
    let tree = glyph_outline_variant_test_tree_with_resources(outline, true, resources);
    let output = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("BitmapGlyph outline variant render");
    let pixmap = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");
    let magenta_pixels = count_pixels_matching(&pixmap, |pixel| {
        pixel.alpha() > 160 && pixel.red() > 180 && pixel.blue() > 180 && pixel.green() < 80
    });
    let report = output
        .diagnostics
        .variant_selections
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("native Skia BitmapGlyph outline selection report");

    assert!(
        magenta_pixels > 1_000,
        "BitmapGlyph should replay the referenced image resource, magenta={magenta_pixels}"
    );
    assert_eq!(report.selected_variant_id, "glyphOutline");
    assert_eq!(
        report.selected_reason,
        VariantSelectedReason::GlyphOutlineStrictProfile
    );
    let outline_part = report
        .parts
        .iter()
        .find(|part| part.variant_id == "glyphOutline")
        .expect("BitmapGlyph outline part report");
    assert_eq!(
        outline_part.details.as_deref(),
        Some("colorSpaceDefaulted=srgb")
    );
}

#[test]
fn native_skia_replays_static_svg_glyph_resource_variant() {
    let renderer = SkiaLayerRenderer::new();
    let mut resources = ResourceArena::default();
    let svg_resource_id = resources.intern_svg_fragment(
        "<rect x=\"100\" y=\"50\" width=\"40\" height=\"30\" fill=\"#00ffff\"/>",
    );
    let mut outline = glyph_outline_test_paint(GlyphOutlinePayloadKind::SvgGlyph, None, None);
    outline.svg_glyph = Some(SvgGlyphPayload {
        vector_resource_id: svg_resource_id,
        source_range_utf8: Some(TextSourceRange::new(0, 1)),
        glyph_range: Some(GlyphRange::new(0, 1)),
        placement: Some(outline.placement),
        transform_to_run: None,
        view_box: Some(SvgGlyphViewBox {
            x: 100.0,
            y: 50.0,
            width: 40.0,
            height: 30.0,
        }),
        intrinsic_size: None,
        security_mode: SvgGlyphSecurityMode::StaticSanitized,
        script_allowed: false,
        animation_allowed: false,
        external_resources_allowed: false,
        interactivity_allowed: false,
    });
    let tree = glyph_outline_variant_test_tree_with_resources(outline, true, resources);
    let output = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("SvgGlyph outline variant render");
    let pixmap = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");
    let cyan_pixels = count_pixels_matching(&pixmap, |pixel| {
        pixel.alpha() > 160 && pixel.green() > 180 && pixel.blue() > 180 && pixel.red() < 80
    });
    let report = output
        .diagnostics
        .variant_selections
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("native Skia SvgGlyph outline selection report");

    assert!(
        cyan_pixels > 10_000,
        "SvgGlyph should replay the sanitized vector resource, cyan={cyan_pixels}"
    );
    assert_eq!(report.selected_variant_id, "glyphOutline");
    assert_eq!(
        report.selected_reason,
        VariantSelectedReason::GlyphOutlineStrictProfile
    );
}

#[test]
fn native_skia_replays_checked_in_bitmap_glyph_resource_corpus() {
    let renderer = SkiaLayerRenderer::new();
    let mut resources = ResourceArena::default();
    let image_resource_id =
        resources.intern_image_bytes(include_bytes!("../../../assets/logo/logo-32.png"));
    assert_eq!(resources.image_count(), 1);

    let mut outline = glyph_outline_test_paint(GlyphOutlinePayloadKind::BitmapGlyph, None, None);
    outline.bitmap_glyph = Some(BitmapGlyphPayload {
        image_resource_id,
        source_range_utf8: Some(TextSourceRange::new(0, 1)),
        glyph_range: Some(GlyphRange::new(0, 1)),
        placement: Some(TextRunPlacement {
            run_to_page: LayerAffineTransform {
                a: 1.0,
                b: 0.0,
                c: 0.0,
                d: 1.0,
                e: 10.0,
                f: 9.0,
            },
            baseline_y: 0.0,
        }),
        transform_to_run: None,
        strike_ppem: Some((32, 32)),
        strike_selection: Some(BitmapStrikeSelection::ProducerResolved),
        pixel_format: Some("rgba8".to_string()),
        color_space: Some("srgb".to_string()),
        alpha_mode: Some(BitmapAlphaMode::Straight),
        scaling_policy: Some(BitmapGlyphScalingPolicy::ExplicitTransform),
        filtering: Some(BitmapGlyphFiltering::Linear),
    });
    let tree = glyph_outline_variant_test_tree_with_bbox_and_resources(
        outline,
        false,
        resources,
        BoundingBox::new(0.0, 0.0, 32.0, 32.0),
        64.0,
        56.0,
    );
    let output = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("checked-in BitmapGlyph resource corpus render");
    let pixmap = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");
    let bounds = alpha_bounds(&pixmap).expect("checked-in BitmapGlyph resource ink");
    let report = output
        .diagnostics
        .variant_selections
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("checked-in BitmapGlyph resource corpus selection report");

    assert_eq!(report.selected_variant_id, "glyphOutline");
    assert_eq!(
        report.selected_reason,
        VariantSelectedReason::GlyphOutlineStrictProfile
    );
    assert!(
        bounds.min_x >= 10
            && bounds.min_y >= 9
            && bounds.width() >= 12
            && bounds.height() >= 12
            && bounds.max_x <= 42
            && bounds.max_y <= 41,
        "checked-in BitmapGlyph resource should replay inside placement and bbox, got {bounds:?}"
    );
}

#[test]
fn native_skia_replays_checked_in_static_svg_glyph_resource_corpus() {
    let renderer = SkiaLayerRenderer::new();
    let mut resources = ResourceArena::default();
    let svg_resource_id = resources.intern_svg_fragment(include_str!(
        "../../../tests/fixtures/glyph_outline_payloads/static_vector_glyph.svg"
    ));
    assert_eq!(resources.svg_count(), 1);

    let mut outline = glyph_outline_test_paint(GlyphOutlinePayloadKind::SvgGlyph, None, None);
    outline.svg_glyph = Some(SvgGlyphPayload {
        vector_resource_id: svg_resource_id,
        source_range_utf8: Some(TextSourceRange::new(0, 1)),
        glyph_range: Some(GlyphRange::new(0, 1)),
        placement: Some(TextRunPlacement {
            run_to_page: LayerAffineTransform {
                a: 1.0,
                b: 0.0,
                c: 0.0,
                d: 1.0,
                e: 12.0,
                f: 7.0,
            },
            baseline_y: 0.0,
        }),
        transform_to_run: None,
        view_box: Some(SvgGlyphViewBox {
            x: 0.0,
            y: 0.0,
            width: 24.0,
            height: 20.0,
        }),
        intrinsic_size: None,
        security_mode: SvgGlyphSecurityMode::StaticSanitized,
        script_allowed: false,
        animation_allowed: false,
        external_resources_allowed: false,
        interactivity_allowed: false,
    });
    let tree = glyph_outline_variant_test_tree_with_bbox_and_resources(
        outline,
        false,
        resources,
        BoundingBox::new(0.0, 0.0, 36.0, 30.0),
        72.0,
        54.0,
    );
    let output = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("checked-in SvgGlyph resource corpus render");
    let pixmap = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");
    let cyan_pixels = count_pixels_matching(&pixmap, |pixel| {
        pixel.alpha() > 160 && pixel.green() > 180 && pixel.blue() > 180 && pixel.red() < 80
    });
    let report = output
        .diagnostics
        .variant_selections
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("checked-in SvgGlyph resource corpus selection report");

    assert_eq!(report.selected_variant_id, "glyphOutline");
    assert_eq!(
        report.selected_reason,
        VariantSelectedReason::GlyphOutlineStrictProfile
    );
    assert!(
        cyan_pixels > 80,
        "checked-in SvgGlyph resource should replay static sanitized cyan geometry, cyan={cyan_pixels}"
    );
}

#[test]
fn native_skia_replays_font_native_bitmap_glyph_producer_output() {
    let renderer = SkiaLayerRenderer::new();
    let font_data = include_bytes!("../../../tests/fixtures/fonts/RHWPBitmapSvgGlyphSmoke.ttf");
    let face = ttf_parser::Face::parse(font_data, 0).expect("bitmap/SVG fixture font parses");
    let glyph_id = u32::from(
        face.glyph_index('\u{E100}')
            .expect("font-native bitmap fixture glyph")
            .0,
    );
    let placement = TextRunPlacement {
        run_to_page: LayerAffineTransform {
            a: 1.0,
            b: 0.0,
            c: 0.0,
            d: 1.0,
            e: 10.0,
            f: 8.0,
        },
        baseline_y: 0.0,
    };
    let mut resources = ResourceArena::default();
    let payload = decode_font_bitmap_glyph_payload(
        font_data,
        0,
        glyph_id,
        &FontBitmapGlyphDecodeOptions::new(
            16,
            TextSourceRange::new(0, 3),
            GlyphRange::new(0, 1),
            placement,
        ),
        &mut resources,
    )
    .expect("font-native bitmap glyph producer lowering");
    let mut outline = glyph_outline_test_paint(GlyphOutlinePayloadKind::BitmapGlyph, None, None);
    outline.bitmap_glyph = Some(payload);
    let tree = glyph_outline_variant_test_tree_with_bbox_and_resources(
        outline,
        false,
        resources,
        BoundingBox::new(0.0, 0.0, 16.0, 16.0),
        48.0,
        40.0,
    );
    let output = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("font-native BitmapGlyph producer output render");
    let pixmap = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");
    let colored_pixels = count_pixels_matching(&pixmap, |pixel| {
        pixel.alpha() > 160 && pixel.green() > 90 && pixel.blue() > 100
    });
    let report = output
        .diagnostics
        .variant_selections
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("font-native BitmapGlyph selection report");

    assert!(
        colored_pixels > 80,
        "producer-lowered BitmapGlyph should replay the embedded PNG, colored={colored_pixels}"
    );
    assert_eq!(report.selected_variant_id, "glyphOutline");
    assert_eq!(
        report.selected_reason,
        VariantSelectedReason::GlyphOutlineStrictProfile
    );
}

#[test]
fn native_skia_replays_font_native_static_svg_glyph_producer_output() {
    let renderer = SkiaLayerRenderer::new();
    let font_data = include_bytes!("../../../tests/fixtures/fonts/RHWPBitmapSvgGlyphSmoke.ttf");
    let face = ttf_parser::Face::parse(font_data, 0).expect("bitmap/SVG fixture font parses");
    let glyph_id = u32::from(
        face.glyph_index('\u{E101}')
            .expect("font-native SVG fixture glyph")
            .0,
    );
    let placement = TextRunPlacement {
        run_to_page: LayerAffineTransform {
            a: 1.0,
            b: 0.0,
            c: 0.0,
            d: 1.0,
            e: 12.0,
            f: 9.0,
        },
        baseline_y: 0.0,
    };
    let mut resources = ResourceArena::default();
    let payload = decode_font_svg_glyph_payload(
        font_data,
        0,
        glyph_id,
        &FontSvgGlyphDecodeOptions::new(
            TextSourceRange::new(0, 3),
            GlyphRange::new(0, 1),
            placement,
        ),
        &mut resources,
    )
    .expect("font-native static SVG glyph producer lowering");
    let mut outline = glyph_outline_test_paint(GlyphOutlinePayloadKind::SvgGlyph, None, None);
    outline.svg_glyph = Some(payload);
    let tree = glyph_outline_variant_test_tree_with_bbox_and_resources(
        outline,
        false,
        resources,
        BoundingBox::new(0.0, 0.0, 16.0, 16.0),
        48.0,
        40.0,
    );
    let output = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("font-native SvgGlyph producer output render");
    let pixmap = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");
    let cyan_pixels = count_pixels_matching(&pixmap, |pixel| {
        pixel.alpha() > 160 && pixel.green() > 120 && pixel.blue() > 150 && pixel.red() < 80
    });
    let report = output
        .diagnostics
        .variant_selections
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("font-native SvgGlyph selection report");

    assert!(
        cyan_pixels > 80,
        "producer-lowered SvgGlyph should replay the embedded static vector, cyan={cyan_pixels}"
    );
    assert_eq!(report.selected_variant_id, "glyphOutline");
    assert_eq!(
        report.selected_reason,
        VariantSelectedReason::GlyphOutlineStrictProfile
    );
}

#[test]
fn native_skia_applies_bitmap_glyph_payload_transform() {
    let renderer = SkiaLayerRenderer::new();
    let mut pixmap = tiny_skia::Pixmap::new(4, 4).expect("bitmap glyph pixmap");
    for pixel in pixmap.pixels_mut() {
        *pixel = tiny_skia::PremultipliedColorU8::from_rgba(255, 0, 255, 255).unwrap();
    }
    let image_bytes = pixmap.encode_png().expect("bitmap glyph png");
    let mut resources = ResourceArena::default();
    let image_resource_id = resources.intern_image_bytes(&image_bytes);
    let mut outline = glyph_outline_test_paint(GlyphOutlinePayloadKind::BitmapGlyph, None, None);
    outline.bitmap_glyph = Some(BitmapGlyphPayload {
        image_resource_id,
        source_range_utf8: Some(TextSourceRange::new(0, 1)),
        glyph_range: Some(GlyphRange::new(0, 1)),
        placement: Some(TextRunPlacement {
            run_to_page: LayerAffineTransform {
                a: 1.0,
                b: 0.0,
                c: 0.0,
                d: 1.0,
                e: 30.0,
                f: 12.0,
            },
            baseline_y: 0.0,
        }),
        transform_to_run: Some(LayerAffineTransform {
            a: 1.0,
            b: 0.0,
            c: 0.0,
            d: 1.0,
            e: 7.0,
            f: 5.0,
        }),
        strike_ppem: Some((4, 4)),
        strike_selection: Some(BitmapStrikeSelection::ProducerResolved),
        pixel_format: Some("rgba8".to_string()),
        color_space: None,
        alpha_mode: Some(BitmapAlphaMode::Straight),
        scaling_policy: Some(BitmapGlyphScalingPolicy::ExplicitTransform),
        filtering: Some(BitmapGlyphFiltering::Nearest),
    });
    let tree = glyph_outline_variant_test_tree_with_bbox_and_resources(
        outline,
        false,
        resources,
        BoundingBox::new(0.0, 0.0, 12.0, 8.0),
        80.0,
        48.0,
    );
    let output = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("BitmapGlyph transform variant render");
    let pixmap = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");
    let bounds = alpha_bounds(&pixmap).expect("BitmapGlyph transformed ink");
    let report = output
        .diagnostics
        .variant_selections
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("native Skia BitmapGlyph transform selection report");

    assert!(
        bounds.min_x >= 37 && bounds.min_y >= 17,
        "BitmapGlyph payload transform should place ink in run/page space, got {bounds:?}"
    );
    assert!(
        bounds.max_x <= 49 && bounds.max_y <= 25,
        "BitmapGlyph payload transform should keep ink inside transformed bbox, got {bounds:?}"
    );
    assert_eq!(report.selected_variant_id, "glyphOutline");
}

#[test]
fn native_skia_applies_static_svg_glyph_payload_transform() {
    let renderer = SkiaLayerRenderer::new();
    let mut resources = ResourceArena::default();
    let svg_resource_id = resources
        .intern_svg_fragment("<rect x=\"0\" y=\"0\" width=\"12\" height=\"8\" fill=\"#00ffff\"/>");
    let mut outline = glyph_outline_test_paint(GlyphOutlinePayloadKind::SvgGlyph, None, None);
    outline.svg_glyph = Some(SvgGlyphPayload {
        vector_resource_id: svg_resource_id,
        source_range_utf8: Some(TextSourceRange::new(0, 1)),
        glyph_range: Some(GlyphRange::new(0, 1)),
        placement: Some(TextRunPlacement {
            run_to_page: LayerAffineTransform {
                a: 1.0,
                b: 0.0,
                c: 0.0,
                d: 1.0,
                e: 18.0,
                f: 14.0,
            },
            baseline_y: 0.0,
        }),
        transform_to_run: Some(LayerAffineTransform {
            a: 1.0,
            b: 0.0,
            c: 0.0,
            d: 1.0,
            e: 9.0,
            f: 6.0,
        }),
        view_box: Some(SvgGlyphViewBox {
            x: 0.0,
            y: 0.0,
            width: 12.0,
            height: 8.0,
        }),
        intrinsic_size: None,
        security_mode: SvgGlyphSecurityMode::StaticSanitized,
        script_allowed: false,
        animation_allowed: false,
        external_resources_allowed: false,
        interactivity_allowed: false,
    });
    let tree = glyph_outline_variant_test_tree_with_bbox_and_resources(
        outline,
        false,
        resources,
        BoundingBox::new(0.0, 0.0, 12.0, 8.0),
        80.0,
        48.0,
    );
    let output = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("SvgGlyph transform variant render");
    let pixmap = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");
    let bounds = alpha_bounds(&pixmap).expect("SvgGlyph transformed ink");
    let report = output
        .diagnostics
        .variant_selections
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("native Skia SvgGlyph transform selection report");

    assert!(
        bounds.min_x >= 27 && bounds.min_y >= 20,
        "SvgGlyph payload transform should place ink in run/page space, got {bounds:?}"
    );
    assert!(
        bounds.max_x <= 39 && bounds.max_y <= 28,
        "SvgGlyph payload transform should keep ink inside transformed bbox, got {bounds:?}"
    );
    assert_eq!(report.selected_variant_id, "glyphOutline");
}

#[test]
fn native_skia_keeps_text_fallback_for_nondeterministic_bitmap_glyph_contract() {
    let renderer = SkiaLayerRenderer::new();
    let mut pixmap = tiny_skia::Pixmap::new(4, 4).expect("bitmap glyph pixmap");
    for pixel in pixmap.pixels_mut() {
        *pixel = tiny_skia::PremultipliedColorU8::from_rgba(255, 0, 255, 255).unwrap();
    }
    let image_bytes = pixmap.encode_png().expect("bitmap glyph png");
    for case_name in [
        "backend-default-filtering",
        "backend-default-scaling",
        "missing-alpha-mode",
        "empty-color-space",
    ] {
        let mut resources = ResourceArena::default();
        let image_resource_id = resources.intern_image_bytes(&image_bytes);
        let mut outline =
            glyph_outline_test_paint(GlyphOutlinePayloadKind::BitmapGlyph, None, None);
        let mut payload = BitmapGlyphPayload {
            image_resource_id,
            source_range_utf8: Some(TextSourceRange::new(0, 1)),
            glyph_range: Some(GlyphRange::new(0, 1)),
            placement: Some(outline.placement),
            transform_to_run: None,
            strike_ppem: Some((4, 4)),
            strike_selection: Some(BitmapStrikeSelection::ProducerResolved),
            pixel_format: Some("rgba8".to_string()),
            color_space: None,
            alpha_mode: Some(BitmapAlphaMode::Straight),
            scaling_policy: Some(BitmapGlyphScalingPolicy::ExplicitTransform),
            filtering: Some(BitmapGlyphFiltering::Nearest),
        };
        match case_name {
            "backend-default-filtering" => {
                payload.filtering = Some(BitmapGlyphFiltering::BackendDefault);
            }
            "backend-default-scaling" => {
                payload.scaling_policy = Some(BitmapGlyphScalingPolicy::BackendDefault);
            }
            "missing-alpha-mode" => {
                payload.alpha_mode = None;
            }
            "empty-color-space" => {
                payload.color_space = Some(String::new());
            }
            _ => unreachable!("covered deterministic BitmapGlyph negative case"),
        }
        outline.bitmap_glyph = Some(payload);
        let tree = glyph_outline_variant_test_tree_with_resources(outline, true, resources);
        let output = renderer
            .render_raster_with_options(&tree, RasterRenderOptions::default())
            .expect("nondeterministic bitmap glyph fallback render");
        let pixmap = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");
        let bounds = alpha_bounds(&pixmap).expect("text fallback ink");
        let report = output
            .diagnostics
            .variant_selections
            .iter()
            .find(|report| report.equivalence_group == "text-0")
            .expect("native Skia BitmapGlyph fallback selection report");

        assert!(
            bounds.min_x > 95,
            "native Skia must keep TextRun fallback when BitmapGlyph has nondeterministic strict contract {case_name}, got {bounds:?}"
        );
        assert_eq!(report.selected_variant_id, "textRun", "{case_name}");
        assert!(
            report.rejected_variants.iter().any(|variant| {
                variant.variant_id == "glyphOutline"
                    && variant
                        .reasons
                        .contains(&VariantRejectReason::UnsupportedBitmapGlyph)
            }),
            "{case_name}"
        );
    }
}

#[test]
fn native_skia_keeps_text_fallback_for_nonpositive_bitmap_glyph_bbox() {
    let renderer = SkiaLayerRenderer::new();
    let mut pixmap = tiny_skia::Pixmap::new(4, 4).expect("bitmap glyph pixmap");
    for pixel in pixmap.pixels_mut() {
        *pixel = tiny_skia::PremultipliedColorU8::from_rgba(255, 0, 255, 255).unwrap();
    }
    let image_bytes = pixmap.encode_png().expect("bitmap glyph png");
    let mut resources = ResourceArena::default();
    let image_resource_id = resources.intern_image_bytes(&image_bytes);
    let mut outline = glyph_outline_test_paint(GlyphOutlinePayloadKind::BitmapGlyph, None, None);
    outline.bitmap_glyph = Some(BitmapGlyphPayload {
        image_resource_id,
        source_range_utf8: Some(TextSourceRange::new(0, 1)),
        glyph_range: Some(GlyphRange::new(0, 1)),
        placement: Some(outline.placement),
        transform_to_run: None,
        strike_ppem: Some((4, 4)),
        strike_selection: Some(BitmapStrikeSelection::ProducerResolved),
        pixel_format: Some("rgba8".to_string()),
        color_space: None,
        alpha_mode: Some(BitmapAlphaMode::Straight),
        scaling_policy: Some(BitmapGlyphScalingPolicy::ExplicitTransform),
        filtering: Some(BitmapGlyphFiltering::Nearest),
    });
    let tree = glyph_outline_variant_test_tree_with_bbox_and_resources(
        outline,
        true,
        resources,
        BoundingBox::new(0.0, 0.0, 0.0, 82.0),
        190.0,
        82.0,
    );
    let output = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("nonpositive BitmapGlyph bbox fallback render");
    let report = output
        .diagnostics
        .variant_selections
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("native Skia BitmapGlyph bbox fallback selection report");

    assert_eq!(report.selected_variant_id, "textRun");
    assert!(report.rejected_variants.iter().any(|variant| {
        variant.variant_id == "glyphOutline"
            && variant
                .reasons
                .contains(&VariantRejectReason::UnsupportedBitmapGlyph)
    }));
}

#[test]
fn native_skia_keeps_text_fallback_for_unsafe_svg_glyph_contract() {
    let renderer = SkiaLayerRenderer::new();
    for case_name in [
        "missing-viewbox",
        "script-allowed",
        "animation-allowed",
        "external-resources-allowed",
        "interactivity-allowed",
    ] {
        let mut resources = ResourceArena::default();
        let svg_resource_id = resources.intern_svg_fragment(
            "<rect x=\"100\" y=\"50\" width=\"40\" height=\"30\" fill=\"#00ffff\"/>",
        );
        let mut outline = glyph_outline_test_paint(GlyphOutlinePayloadKind::SvgGlyph, None, None);
        let mut payload = SvgGlyphPayload {
            vector_resource_id: svg_resource_id,
            source_range_utf8: Some(TextSourceRange::new(0, 1)),
            glyph_range: Some(GlyphRange::new(0, 1)),
            placement: Some(outline.placement),
            transform_to_run: None,
            view_box: Some(SvgGlyphViewBox {
                x: 100.0,
                y: 50.0,
                width: 40.0,
                height: 30.0,
            }),
            intrinsic_size: None,
            security_mode: SvgGlyphSecurityMode::StaticSanitized,
            script_allowed: false,
            animation_allowed: false,
            external_resources_allowed: false,
            interactivity_allowed: false,
        };
        match case_name {
            "missing-viewbox" => {
                payload.view_box = None;
            }
            "script-allowed" => {
                payload.script_allowed = true;
            }
            "animation-allowed" => {
                payload.animation_allowed = true;
            }
            "external-resources-allowed" => {
                payload.external_resources_allowed = true;
            }
            "interactivity-allowed" => {
                payload.interactivity_allowed = true;
            }
            _ => unreachable!("covered static sanitized SvgGlyph negative case"),
        }
        outline.svg_glyph = Some(payload);
        let tree = glyph_outline_variant_test_tree_with_resources(outline, true, resources);
        let output = renderer
            .render_raster_with_options(&tree, RasterRenderOptions::default())
            .expect("unsafe SvgGlyph fallback render");
        let pixmap = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");
        let bounds = alpha_bounds(&pixmap).expect("text fallback ink");
        let report = output
            .diagnostics
            .variant_selections
            .iter()
            .find(|report| report.equivalence_group == "text-0")
            .expect("native Skia SvgGlyph fallback selection report");

        assert!(
            bounds.min_x > 95,
            "native Skia must keep TextRun fallback when SvgGlyph violates the static sanitized contract {case_name}, got {bounds:?}"
        );
        assert_eq!(report.selected_variant_id, "textRun", "{case_name}");
        assert!(
            report.rejected_variants.iter().any(|variant| {
                variant.variant_id == "glyphOutline"
                    && variant
                        .reasons
                        .contains(&VariantRejectReason::UnsupportedSvgGlyph)
            }),
            "{case_name}"
        );
    }
}

#[test]
fn native_skia_keeps_text_fallback_for_unsafe_svg_glyph_fragment() {
    let renderer = SkiaLayerRenderer::new();
    let mut resources = ResourceArena::default();
    let svg_resource_id = resources.intern_svg_fragment(
        "<rect x=\"100\" y=\"50\" width=\"40\" height=\"30\" fill=\"#00ffff\" onclick=\"alert(1)\"/>",
    );
    let mut outline = glyph_outline_test_paint(GlyphOutlinePayloadKind::SvgGlyph, None, None);
    outline.svg_glyph = Some(SvgGlyphPayload {
        vector_resource_id: svg_resource_id,
        source_range_utf8: Some(TextSourceRange::new(0, 1)),
        glyph_range: Some(GlyphRange::new(0, 1)),
        placement: Some(outline.placement),
        transform_to_run: None,
        view_box: Some(SvgGlyphViewBox {
            x: 100.0,
            y: 50.0,
            width: 40.0,
            height: 30.0,
        }),
        intrinsic_size: None,
        security_mode: SvgGlyphSecurityMode::StaticSanitized,
        script_allowed: false,
        animation_allowed: false,
        external_resources_allowed: false,
        interactivity_allowed: false,
    });
    let tree = glyph_outline_variant_test_tree_with_resources(outline, true, resources);
    let output = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("unsafe SvgGlyph fragment fallback render");
    let pixmap = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");
    let bounds = alpha_bounds(&pixmap).expect("text fallback ink");
    let report = output
        .diagnostics
        .variant_selections
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("native Skia unsafe SvgGlyph fragment fallback selection report");

    assert!(
        bounds.min_x > 95,
        "native Skia must keep TextRun fallback when SvgGlyph resource is not static-sanitized, got {bounds:?}"
    );
    assert_eq!(report.selected_variant_id, "textRun");
    assert!(report.rejected_variants.iter().any(|variant| {
        variant.variant_id == "glyphOutline"
            && variant
                .reasons
                .contains(&VariantRejectReason::UnsupportedSvgGlyph)
    }));
}

#[test]
fn native_skia_keeps_text_fallback_for_nonpositive_svg_glyph_bbox() {
    let renderer = SkiaLayerRenderer::new();
    let mut resources = ResourceArena::default();
    let svg_resource_id = resources.intern_svg_fragment(
        "<rect x=\"100\" y=\"50\" width=\"40\" height=\"30\" fill=\"#00ffff\"/>",
    );
    let mut outline = glyph_outline_test_paint(GlyphOutlinePayloadKind::SvgGlyph, None, None);
    outline.svg_glyph = Some(SvgGlyphPayload {
        vector_resource_id: svg_resource_id,
        source_range_utf8: Some(TextSourceRange::new(0, 1)),
        glyph_range: Some(GlyphRange::new(0, 1)),
        placement: Some(outline.placement),
        transform_to_run: None,
        view_box: Some(SvgGlyphViewBox {
            x: 100.0,
            y: 50.0,
            width: 40.0,
            height: 30.0,
        }),
        intrinsic_size: None,
        security_mode: SvgGlyphSecurityMode::StaticSanitized,
        script_allowed: false,
        animation_allowed: false,
        external_resources_allowed: false,
        interactivity_allowed: false,
    });
    let tree = glyph_outline_variant_test_tree_with_bbox_and_resources(
        outline,
        true,
        resources,
        BoundingBox::new(0.0, 0.0, 190.0, -1.0),
        190.0,
        82.0,
    );
    let output = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("nonpositive SvgGlyph bbox fallback render");
    let report = output
        .diagnostics
        .variant_selections
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("native Skia SvgGlyph bbox fallback selection report");

    assert_eq!(report.selected_variant_id, "textRun");
    assert!(report.rejected_variants.iter().any(|variant| {
        variant.variant_id == "glyphOutline"
            && variant
                .reasons
                .contains(&VariantRejectReason::UnsupportedSvgGlyph)
    }));
}

#[test]
fn native_skia_keeps_text_fallback_for_unsupported_glyph_outline_stroke() {
    let renderer = SkiaLayerRenderer::new();
    let outline = glyph_outline_test_paint(
        GlyphOutlinePayloadKind::MonochromeFillStroke,
        Some(GlyphOutlineStrokeStyle {
            color: 0xff0000,
            width_px: 4.0,
            join: GlyphOutlineStrokeJoin::Round,
            cap: GlyphOutlineStrokeCap::Butt,
            miter_limit: Some(4.0),
            paint_order: GlyphOutlinePaintOrder::FillThenStroke,
        }),
        None,
    );
    let tree = glyph_outline_variant_test_tree(outline, true);
    let output = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("unsupported glyph outline stroke fallback render");
    let pixmap = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");
    let bounds = alpha_bounds(&pixmap).expect("text fallback ink");
    let report = output
        .diagnostics
        .variant_selections
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("native Skia glyph outline fallback selection report");

    assert!(
        bounds.min_x > 95,
        "native Skia must keep TextRun fallback when GlyphOutline stroke style is unsupported, got {bounds:?}"
    );
    assert_eq!(report.selected_variant_id, "textRun");
    assert!(report.rejected_variants.iter().any(|variant| {
        variant.variant_id == "glyphOutline"
            && variant
                .reasons
                .contains(&VariantRejectReason::GlyphOutlineStrokeStyleUnsupported)
    }));
}

#[test]
fn native_skia_keeps_text_fallback_for_nonportable_glyph_run() {
    let renderer = SkiaLayerRenderer::new();
    let style = TextStyle {
        font_family: "sans-serif".to_string(),
        font_size: 32.0,
        ..Default::default()
    };
    let glyph_id = make_font(&style, &renderer.font_mgr, "A")
        .text_to_glyphs_vec("A")
        .into_iter()
        .next()
        .expect("test font should map A to a glyph");

    let tree = glyph_variant_test_tree(&[glyph_id], GlyphRunReplayEligibility::LocalDiagnosticOnly);
    let output = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("non-portable glyph variant render");
    let pixmap = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");
    let bounds = alpha_bounds(&pixmap).expect("text fallback ink");

    assert!(
        bounds.min_x > 95,
        "native Skia must keep TextRun fallback when GlyphRun is diagnostic-only, got {bounds:?}"
    );
    let report = output
        .diagnostics
        .variant_selections
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("native Skia fallback variant selection report");
    assert_eq!(report.selected_variant_id, "textRun");
    assert_eq!(
        report.selected_reason,
        VariantSelectedReason::DefaultTextRunFallback
    );
    assert!(report.rejected_variants.iter().any(|variant| {
        variant.variant_id == "glyphRun"
            && variant
                .reasons
                .contains(&VariantRejectReason::FontNotPortable)
    }));
}

#[test]
fn native_skia_keeps_text_fallback_for_out_of_range_glyph_id() {
    let renderer = SkiaLayerRenderer::new();
    let style = TextStyle {
        font_family: "sans-serif".to_string(),
        font_size: 32.0,
        ..Default::default()
    };
    let glyph_id = make_font(&style, &renderer.font_mgr, "A")
        .text_to_glyphs_vec("A")
        .into_iter()
        .next()
        .expect("test font should map A to a glyph");

    let mut tree = glyph_variant_test_tree(&[glyph_id], GlyphRunReplayEligibility::Portable);
    if let LayerNodeKind::Leaf { ops, .. } = &mut tree.root.kind {
        for op in ops {
            if let PaintOp::GlyphRun { run, .. } = op {
                run.glyph_ids[0] = u32::from(u16::MAX) + 1;
            }
        }
    }
    let png = renderer
        .render_png(&tree)
        .expect("out-of-range glyph id fallback render");
    let pixmap = tiny_skia::Pixmap::decode_png(&png).expect("png decode");
    let bounds = alpha_bounds(&pixmap).expect("text fallback ink");

    assert!(
        bounds.min_x > 95,
        "native Skia must keep TextRun fallback when GlyphRun has a backend-incompatible glyph id, got {bounds:?}"
    );
}

fn adjust_sfnt_table_offsets_for_ttc(font_data: &[u8], base_offset: usize) -> Vec<u8> {
    assert!(font_data.len() >= 12, "sfnt header must exist");
    let table_count = u16::from_be_bytes([font_data[4], font_data[5]]) as usize;
    let records_end = 12 + table_count * 16;
    assert!(
        records_end <= font_data.len(),
        "sfnt table records must fit in font data"
    );
    assert!(base_offset <= u32::MAX as usize, "TTC offset must fit u32");

    let mut adjusted = font_data.to_vec();
    for index in 0..table_count {
        let offset_pos = 12 + index * 16 + 8;
        let original_offset = u32::from_be_bytes([
            adjusted[offset_pos],
            adjusted[offset_pos + 1],
            adjusted[offset_pos + 2],
            adjusted[offset_pos + 3],
        ]);
        let shifted_offset = original_offset
            .checked_add(base_offset as u32)
            .expect("shifted table offset must fit u32");
        adjusted[offset_pos..offset_pos + 4].copy_from_slice(&shifted_offset.to_be_bytes());
    }
    adjusted
}

fn synthetic_two_face_ttc_from_ttf(font_data: &[u8]) -> Vec<u8> {
    let header_len = 20usize;
    let first_offset = header_len;
    let second_offset = (first_offset + font_data.len() + 3) & !3;
    assert!(
        second_offset <= u32::MAX as usize,
        "TTC offset must fit u32"
    );

    let first_face = adjust_sfnt_table_offsets_for_ttc(font_data, first_offset);
    let second_face = adjust_sfnt_table_offsets_for_ttc(font_data, second_offset);
    let mut collection = Vec::with_capacity(second_offset + second_face.len());
    collection.extend_from_slice(b"ttcf");
    collection.extend_from_slice(&1u16.to_be_bytes());
    collection.extend_from_slice(&0u16.to_be_bytes());
    collection.extend_from_slice(&2u32.to_be_bytes());
    collection.extend_from_slice(&(first_offset as u32).to_be_bytes());
    collection.extend_from_slice(&(second_offset as u32).to_be_bytes());
    collection.extend_from_slice(&first_face);
    while collection.len() < second_offset {
        collection.push(0);
    }
    collection.extend_from_slice(&second_face);
    collection
}

fn checked_in_exact_face_ttc_tree(face_index: u32) -> PageLayerTree {
    let ttc_data = include_bytes!("../../../tests/fixtures/fonts/RHWPExactFaceSmoke.ttc");
    let first_face = ttf_parser::Face::parse(ttc_data, 0).expect("checked-in TTC face 0 parses");
    let second_face = ttf_parser::Face::parse(ttc_data, 1).expect("checked-in TTC face 1 parses");
    assert!(
        first_face.glyph_index('\u{E104}').is_none(),
        "face 0 must not contain the face-1 proof glyph"
    );
    let glyph_id = second_face
        .glyph_index('\u{E104}')
        .expect("face 1 contains the exact-face proof glyph")
        .0;
    assert!(
        second_face
            .glyph_bounding_box(ttf_parser::GlyphId(glyph_id))
            .is_some(),
        "face-1 proof glyph must have an outline"
    );

    let mut tree = glyph_variant_test_tree(&[glyph_id], GlyphRunReplayEligibility::Portable);
    let digest_value = crate::paint::resource_digest_hex(ttc_data);
    let data_ref = BinaryResourceRef {
        kind: BinaryResourceKind::FontBlob,
        id: crate::paint::font_blob_resource_key(ttc_data.len(), &digest_value),
    };
    let digest = FontDigest {
        algorithm: "blake3".to_string(),
        value: digest_value,
    };
    tree.resources.intern_font_blob_bytes(ttc_data);
    let blob = &mut tree.resources.font_resources_mut().blobs[0];
    blob.digest = Some(digest.clone());
    blob.data_ref = Some(data_ref.clone());
    blob.portability = FontPortability::PortableBlob { digest, data_ref };
    let face = &mut tree.resources.font_resources_mut().faces[0];
    face.face_index = face_index;
    face.postscript_name = Some("RHWPExactFaceOne-Regular".to_string());
    tree
}

#[test]
fn native_skia_exact_font_construction_fixture_instantiates_checked_in_ttf_and_ttc_faces() {
    let renderer = SkiaLayerRenderer::new();
    let font_data = include_bytes!("../../../tests/fixtures/fonts/RHWPColorSmokeCOLRv0.ttf");
    let ttf_face = renderer
        .font_mgr
        .new_from_data(font_data.as_slice(), Some(0))
        .expect("checked-in TTF face should instantiate");
    assert!(ttf_face.count_glyphs() > 0);

    let ttc_data = synthetic_two_face_ttc_from_ttf(font_data);
    assert!(
        ttf_parser::Face::parse(&ttc_data, 0).is_ok(),
        "synthetic TTC face 0 should be parseable"
    );
    assert!(
        ttf_parser::Face::parse(&ttc_data, 1).is_ok(),
        "synthetic TTC face 1 should be parseable"
    );
    assert!(
        ttf_parser::Face::parse(&ttc_data, 2).is_err(),
        "synthetic TTC face 2 should be out of range"
    );

    let ttc_face_0 = renderer
        .font_mgr
        .new_from_data(ttc_data.as_slice(), Some(0))
        .expect("synthetic TTC face 0 should instantiate");
    let ttc_face_1 = renderer
        .font_mgr
        .new_from_data(ttc_data.as_slice(), Some(1))
        .expect("synthetic TTC face 1 should instantiate");
    assert_eq!(ttc_face_0.count_glyphs(), ttc_face_1.count_glyphs());
    assert!(
        renderer
            .font_mgr
            .new_from_data(ttc_data.as_slice(), Some(2))
            .is_none(),
        "out-of-range TTC face index should not instantiate"
    );
}

#[test]
fn native_skia_replays_digest_pinned_checked_in_ttc_face() {
    let renderer = SkiaLayerRenderer::new();
    let ttc_data = include_bytes!("../../../tests/fixtures/fonts/RHWPExactFaceSmoke.ttc");
    let face = ttf_parser::Face::parse(ttc_data, 1).expect("checked-in TTC face 1 parses");
    let glyph_id = face
        .glyph_index('\u{E104}')
        .expect("checked-in TTC face 1 proof glyph")
        .0;
    let typeface = renderer
        .font_mgr
        .new_from_data(ttc_data.as_slice(), Some(1))
        .expect("checked-in TTC face 1 should instantiate");
    let font = skia_safe::Font::from_typeface(typeface.clone(), Some(32.0));
    let mapped_glyphs = font.text_to_glyphs_vec("\u{E104}");
    assert_eq!(
        mapped_glyphs,
        vec![glyph_id],
        "checked-in TTC face 1 must map its proof code point to the requested glyph"
    );
    assert!(
        font.get_path(glyph_id).is_some(),
        "checked-in TTC face 1 should expose its unique outline: count={}, mapped={mapped_glyphs:?}, expected={glyph_id}",
        typeface.count_glyphs()
    );
    let tree = checked_in_exact_face_ttc_tree(1);
    let output = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("checked-in exact TTC face glyph run render");
    let pixmap = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");
    let report = output
        .diagnostics
        .variant_selections
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("checked-in exact TTC face report");
    let bounds = alpha_bounds(&pixmap)
        .unwrap_or_else(|| panic!("checked-in TTC glyph run ink, report={report:?}"));

    assert!(
        bounds.max_x < 100,
        "native Skia should draw face 1's unique outline and suppress TextRun fallback, got {bounds:?}"
    );
    assert_eq!(report.selected_variant_id, "glyphRun");
    assert_eq!(
        report.selected_reason,
        VariantSelectedReason::GlyphRunStrictEligible
    );
    let font_report = report
        .font_verification
        .as_ref()
        .expect("checked-in TTC selection should carry font verification");
    assert_eq!(font_report.blob_resolved, Some(true));
    assert_eq!(font_report.digest_matched, Some(true));
    assert_eq!(font_report.exact_face_instantiated, Some(true));
    assert_eq!(font_report.face_index_supported, Some(true));
}

#[test]
fn native_skia_rejects_out_of_range_digest_pinned_ttc_face() {
    let renderer = SkiaLayerRenderer::new();
    let tree = checked_in_exact_face_ttc_tree(2);
    let output = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("checked-in out-of-range TTC face fallback render");
    let pixmap = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");
    let bounds = alpha_bounds(&pixmap).expect("checked-in TTC fallback ink");
    let report = output
        .diagnostics
        .variant_selections
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("checked-in out-of-range TTC report");

    assert!(
        bounds.min_x > 95,
        "native Skia must keep TextRun fallback for an out-of-range checked-in TTC face, got {bounds:?}"
    );
    assert_eq!(report.selected_variant_id, "textRun");
    assert_eq!(
        report.selected_reason,
        VariantSelectedReason::DefaultTextRunFallback
    );
    assert!(report.rejected_variants.iter().any(|variant| {
        variant.variant_id == "glyphRun"
            && variant
                .reasons
                .contains(&VariantRejectReason::FaceIndexUnsupported)
    }));
    let font_report = report
        .font_verification
        .as_ref()
        .expect("checked-in TTC rejection should carry font verification");
    assert_eq!(font_report.blob_resolved, Some(true));
    assert_eq!(font_report.digest_matched, Some(true));
    assert_eq!(font_report.exact_face_instantiated, Some(false));
    assert_eq!(font_report.face_index_supported, Some(false));
}

#[test]
fn native_skia_replays_direct_ttf_when_exact_font_bytes_are_available() {
    let renderer = SkiaLayerRenderer::new();
    let font_data = include_bytes!("../../../tests/fixtures/fonts/RHWPColorSmokeCOLRv0.ttf");
    let color_glyph_id = u32::from(
        ttf_parser::Face::parse(font_data, 0)
            .expect("fixture font parses")
            .glyph_index('\u{E000}')
            .expect("fixture color glyph")
            .0,
    );
    let payload = decode_colrv0_color_layers_payload(
        font_data,
        0,
        color_glyph_id,
        &Colrv0ColorLayersDecodeOptions::new(TextSourceRange::new(0, 1), GlyphRange::new(0, 1)),
    )
    .expect("fixture COLRv0 payload decodes");
    let glyph_id = payload
        .layers
        .iter()
        .find_map(|layer| layer.glyph_id)
        .and_then(|glyph_id| u16::try_from(glyph_id).ok())
        .expect("fixture color glyph should expose a path layer glyph id");
    let face = renderer
        .font_mgr
        .new_from_data(font_data.as_slice(), Some(0))
        .expect("checked-in TTF face should instantiate");
    assert!(
        skia_safe::Font::from_typeface(face, Some(32.0))
            .get_path(glyph_id)
            .is_some(),
        "checked-in TTF face should expose the path layer glyph"
    );

    let mut tree = glyph_variant_test_tree(&[glyph_id], GlyphRunReplayEligibility::Portable);
    let digest = crate::paint::resource_digest_hex(font_data);
    let data_ref = BinaryResourceRef {
        kind: BinaryResourceKind::FontBlob,
        id: crate::paint::font_blob_resource_key(font_data.len(), &digest),
    };
    let digest = FontDigest {
        algorithm: "blake3".to_string(),
        value: digest,
    };
    tree.resources.intern_font_blob_bytes(font_data);
    let blob = &mut tree.resources.font_resources_mut().blobs[0];
    blob.digest = Some(digest.clone());
    blob.data_ref = Some(data_ref.clone());
    blob.portability = FontPortability::PortableBlob {
        digest: digest.clone(),
        data_ref: data_ref.clone(),
    };
    let face = &mut tree.resources.font_resources_mut().faces[0];
    face.face_index = 0;
    face.postscript_name = Some("RHWPColorSmokeCOLRv0".to_string());

    let output = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("exact direct TTF glyph run render");
    let pixmap = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");
    let bounds = alpha_bounds(&pixmap).expect("glyph run ink");
    let report = output
        .diagnostics
        .variant_selections
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("native Skia exact direct TTF report");

    assert!(
        bounds.max_x < 100,
        "native Skia should draw the exact direct TTF GlyphRun and suppress the right-side TextRun fallback, got {bounds:?}"
    );
    assert_eq!(report.selected_variant_id, "glyphRun");
    assert_eq!(
        report.selected_reason,
        VariantSelectedReason::GlyphRunStrictEligible
    );
    let font_report = report
        .font_verification
        .as_ref()
        .expect("exact direct TTF selection should carry font verification");
    assert_eq!(font_report.blob_resolved, Some(true));
    assert_eq!(font_report.digest_matched, Some(true));
    assert_eq!(font_report.exact_face_instantiated, Some(true));
    assert_eq!(font_report.face_index_supported, Some(true));
    assert_eq!(font_report.variation_supported, None);
}

#[test]
fn native_skia_rejects_invalid_direct_ttf_bytes_without_system_fallback() {
    let renderer = SkiaLayerRenderer::new();
    let invalid_font_data = b"not-a-font";
    let mut tree = glyph_variant_test_tree(&[1], GlyphRunReplayEligibility::Portable);
    let digest = crate::paint::resource_digest_hex(invalid_font_data);
    let data_ref = BinaryResourceRef {
        kind: BinaryResourceKind::FontBlob,
        id: crate::paint::font_blob_resource_key(invalid_font_data.len(), &digest),
    };
    let digest = FontDigest {
        algorithm: "blake3".to_string(),
        value: digest,
    };
    tree.resources.intern_font_blob_bytes(invalid_font_data);
    let blob = &mut tree.resources.font_resources_mut().blobs[0];
    blob.digest = Some(digest.clone());
    blob.data_ref = Some(data_ref.clone());
    blob.portability = FontPortability::PortableBlob { digest, data_ref };
    let face = &mut tree.resources.font_resources_mut().faces[0];
    face.face_index = 0;
    face.postscript_name = Some("InvalidDirectTtf".to_string());

    let output = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("invalid exact direct TTF bytes should still render fallback");
    let pixmap = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");
    let bounds = alpha_bounds(&pixmap).expect("text fallback ink");
    let report = output
        .diagnostics
        .variant_selections
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("native Skia invalid exact direct TTF report");

    assert!(
        bounds.min_x > 95,
        "native Skia must keep TextRun fallback when embedded exact TTF bytes do not instantiate, got {bounds:?}"
    );
    assert_eq!(report.selected_variant_id, "textRun");
    assert_eq!(
        report.selected_reason,
        VariantSelectedReason::DefaultTextRunFallback
    );
    assert!(report.rejected_variants.iter().any(|variant| {
        variant.variant_id == "glyphRun"
            && variant
                .reasons
                .contains(&VariantRejectReason::ExactFaceUnavailable)
    }));
    let font_report = report
        .font_verification
        .as_ref()
        .expect("invalid exact TTF rejection should carry font verification");
    assert_eq!(font_report.blob_resolved, Some(true));
    assert_eq!(font_report.digest_matched, Some(true));
    assert_eq!(font_report.exact_face_instantiated, Some(false));
    assert_eq!(font_report.face_index_supported, None);
    assert_eq!(font_report.variation_supported, None);
}

#[test]
fn native_skia_rejects_direct_ttf_digest_mismatch_without_system_fallback() {
    let renderer = SkiaLayerRenderer::new();
    let font_data = include_bytes!("../../../tests/fixtures/fonts/RHWPColorSmokeCOLRv0.ttf");
    let actual_digest = crate::paint::resource_digest_hex(font_data);
    let mut tree = glyph_variant_test_tree(&[1], GlyphRunReplayEligibility::Portable);
    let data_ref = BinaryResourceRef {
        kind: BinaryResourceKind::FontBlob,
        id: crate::paint::font_blob_resource_key(font_data.len(), &actual_digest),
    };
    let digest = FontDigest {
        algorithm: "blake3".to_string(),
        value: "not-the-embedded-font-digest".to_string(),
    };
    tree.resources.intern_font_blob_bytes(font_data);
    let blob = &mut tree.resources.font_resources_mut().blobs[0];
    blob.digest = Some(digest.clone());
    blob.data_ref = Some(data_ref.clone());
    blob.portability = FontPortability::PortableBlob { digest, data_ref };
    let face = &mut tree.resources.font_resources_mut().faces[0];
    face.face_index = 0;
    face.postscript_name = Some("RHWPColorSmokeCOLRv0".to_string());

    let output = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("mismatched exact direct TTF digest should still render fallback");
    let pixmap = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");
    let bounds = alpha_bounds(&pixmap).expect("text fallback ink");
    let report = output
        .diagnostics
        .variant_selections
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("native Skia mismatched direct TTF digest report");

    assert!(
        bounds.min_x > 95,
        "native Skia must keep TextRun fallback when embedded exact TTF bytes do not match the declared digest, got {bounds:?}"
    );
    assert_eq!(report.selected_variant_id, "textRun");
    assert_eq!(
        report.selected_reason,
        VariantSelectedReason::DefaultTextRunFallback
    );
    assert!(report.rejected_variants.iter().any(|variant| {
        variant.variant_id == "glyphRun"
            && variant
                .reasons
                .contains(&VariantRejectReason::ExactFaceUnavailable)
    }));
    let font_report = report
        .font_verification
        .as_ref()
        .expect("mismatched digest rejection should carry font verification");
    assert_eq!(font_report.blob_resolved, Some(true));
    assert_eq!(font_report.digest_matched, Some(false));
    assert_eq!(font_report.exact_face_instantiated, Some(false));
    assert_eq!(font_report.face_index_supported, None);
    assert_eq!(font_report.variation_supported, None);
}

#[test]
fn native_skia_rejects_out_of_range_glyph_id_before_exact_ttf_replay() {
    let renderer = SkiaLayerRenderer::new();
    let font_data = include_bytes!("../../../tests/fixtures/fonts/RHWPColorSmokeCOLRv0.ttf");
    let mut tree = glyph_variant_test_tree(&[1], GlyphRunReplayEligibility::Portable);
    if let LayerNodeKind::Leaf { ops, .. } = &mut tree.root.kind {
        for op in ops {
            if let PaintOp::GlyphRun { run, .. } = op {
                run.glyph_ids[0] = u32::from(u16::MAX) + 1;
            }
        }
    }
    let digest = crate::paint::resource_digest_hex(font_data);
    let data_ref = BinaryResourceRef {
        kind: BinaryResourceKind::FontBlob,
        id: crate::paint::font_blob_resource_key(font_data.len(), &digest),
    };
    let digest = FontDigest {
        algorithm: "blake3".to_string(),
        value: digest,
    };
    tree.resources.intern_font_blob_bytes(font_data);
    let blob = &mut tree.resources.font_resources_mut().blobs[0];
    blob.digest = Some(digest.clone());
    blob.data_ref = Some(data_ref.clone());
    blob.portability = FontPortability::PortableBlob { digest, data_ref };
    let face = &mut tree.resources.font_resources_mut().faces[0];
    face.face_index = 0;
    face.postscript_name = Some("RHWPColorSmokeCOLRv0".to_string());

    let output = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("out-of-range exact direct TTF glyph id fallback render");
    let pixmap = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");
    let bounds = alpha_bounds(&pixmap).expect("text fallback ink");
    let report = output
        .diagnostics
        .variant_selections
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("native Skia exact direct TTF glyph-id guard report");

    assert!(
        bounds.min_x > 95,
        "native Skia must keep TextRun fallback before exact TTF replay when glyph id exceeds the backend range, got {bounds:?}"
    );
    assert_eq!(report.selected_variant_id, "textRun");
    assert_eq!(
        report.selected_reason,
        VariantSelectedReason::DefaultTextRunFallback
    );
    assert!(report.rejected_variants.iter().any(|variant| {
        variant.variant_id == "glyphRun"
            && variant
                .reasons
                .contains(&VariantRejectReason::GlyphIdOutOfRange)
    }));
}

#[test]
fn native_skia_replays_nonzero_face_index_when_exact_ttc_face_instantiates() {
    let renderer = SkiaLayerRenderer::new();
    let font_data = include_bytes!("../../../tests/fixtures/fonts/RHWPColorSmokeCOLRv0.ttf");
    let ttc_data = synthetic_two_face_ttc_from_ttf(font_data);
    let color_glyph_id = u32::from(
        ttf_parser::Face::parse(font_data, 0)
            .expect("fixture font parses")
            .glyph_index('\u{E000}')
            .expect("fixture color glyph")
            .0,
    );
    let payload = decode_colrv0_color_layers_payload(
        font_data,
        0,
        color_glyph_id,
        &Colrv0ColorLayersDecodeOptions::new(TextSourceRange::new(0, 1), GlyphRange::new(0, 1)),
    )
    .expect("fixture COLRv0 payload decodes");
    let glyph_id = payload
        .layers
        .iter()
        .find_map(|layer| layer.glyph_id)
        .and_then(|glyph_id| u16::try_from(glyph_id).ok())
        .expect("fixture color glyph should expose a path layer glyph id");
    let face = renderer
        .font_mgr
        .new_from_data(ttc_data.as_slice(), Some(1))
        .expect("synthetic TTC face 1 should instantiate");
    assert!(
        skia_safe::Font::from_typeface(face, Some(32.0))
            .get_path(glyph_id)
            .is_some(),
        "synthetic TTC face should expose the path layer glyph"
    );

    let mut tree = glyph_variant_test_tree(&[glyph_id], GlyphRunReplayEligibility::Portable);
    let digest = crate::paint::resource_digest_hex(&ttc_data);
    let data_ref = BinaryResourceRef {
        kind: BinaryResourceKind::FontBlob,
        id: crate::paint::font_blob_resource_key(ttc_data.len(), &digest),
    };
    let digest = FontDigest {
        algorithm: "blake3".to_string(),
        value: digest,
    };
    tree.resources.intern_font_blob_bytes(&ttc_data);
    let blob = &mut tree.resources.font_resources_mut().blobs[0];
    blob.digest = Some(digest.clone());
    blob.data_ref = Some(data_ref.clone());
    blob.portability = FontPortability::PortableBlob {
        digest: digest.clone(),
        data_ref: data_ref.clone(),
    };
    let face = &mut tree.resources.font_resources_mut().faces[0];
    face.face_index = 1;
    face.postscript_name = Some("SyntheticTtcFace1".to_string());

    let output = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("exact TTC face-index glyph run render");
    let pixmap = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");
    let bounds = alpha_bounds(&pixmap).expect("glyph run ink");
    let report = output
        .diagnostics
        .variant_selections
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("native Skia exact TTC face-index report");

    assert!(
        bounds.max_x < 100,
        "native Skia should draw the exact non-zero TTC face GlyphRun and suppress the right-side TextRun fallback, got {bounds:?}"
    );
    assert_eq!(report.selected_variant_id, "glyphRun");
    assert_eq!(
        report.selected_reason,
        VariantSelectedReason::GlyphRunStrictEligible
    );
    let font_report = report
        .font_verification
        .as_ref()
        .expect("exact TTC face selection should carry font verification");
    assert_eq!(font_report.blob_resolved, Some(true));
    assert_eq!(font_report.exact_face_instantiated, Some(true));
    assert_eq!(font_report.face_index_supported, Some(true));
    assert!(report.rejected_variants.iter().all(|variant| {
        variant.variant_id != "glyphRun"
            || !variant
                .reasons
                .contains(&VariantRejectReason::FaceIndexUnsupported)
    }));
}

#[test]
fn native_skia_rejects_out_of_range_face_index_with_exact_ttc_blob() {
    let renderer = SkiaLayerRenderer::new();
    let font_data = include_bytes!("../../../tests/fixtures/fonts/RHWPColorSmokeCOLRv0.ttf");
    let ttc_data = synthetic_two_face_ttc_from_ttf(font_data);
    let color_glyph_id = u32::from(
        ttf_parser::Face::parse(font_data, 0)
            .expect("fixture font parses")
            .glyph_index('\u{E000}')
            .expect("fixture color glyph")
            .0,
    );
    let payload = decode_colrv0_color_layers_payload(
        font_data,
        0,
        color_glyph_id,
        &Colrv0ColorLayersDecodeOptions::new(TextSourceRange::new(0, 1), GlyphRange::new(0, 1)),
    )
    .expect("fixture COLRv0 payload decodes");
    let glyph_id = payload
        .layers
        .iter()
        .find_map(|layer| layer.glyph_id)
        .and_then(|glyph_id| u16::try_from(glyph_id).ok())
        .expect("fixture color glyph should expose a path layer glyph id");

    let mut tree = glyph_variant_test_tree(&[glyph_id], GlyphRunReplayEligibility::Portable);
    let digest = crate::paint::resource_digest_hex(&ttc_data);
    let data_ref = BinaryResourceRef {
        kind: BinaryResourceKind::FontBlob,
        id: crate::paint::font_blob_resource_key(ttc_data.len(), &digest),
    };
    let digest = FontDigest {
        algorithm: "blake3".to_string(),
        value: digest,
    };
    tree.resources.intern_font_blob_bytes(&ttc_data);
    let blob = &mut tree.resources.font_resources_mut().blobs[0];
    blob.digest = Some(digest.clone());
    blob.data_ref = Some(data_ref.clone());
    blob.portability = FontPortability::PortableBlob {
        digest: digest.clone(),
        data_ref,
    };
    let face = &mut tree.resources.font_resources_mut().faces[0];
    face.face_index = 2;
    face.postscript_name = Some("SyntheticTtcOutOfRangeFace".to_string());

    let output = renderer
        .render_raster_with_options(&tree, RasterRenderOptions::default())
        .expect("out-of-range TTC face-index fallback render");
    let pixmap = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");
    let bounds = alpha_bounds(&pixmap).expect("text fallback ink");
    let report = output
        .diagnostics
        .variant_selections
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("native Skia exact TTC high-index report");

    assert!(
        bounds.min_x > 95,
        "native Skia must keep TextRun fallback for out-of-range exact TTC faceIndex, got {bounds:?}"
    );
    assert_eq!(report.selected_variant_id, "textRun");
    assert_eq!(
        report.selected_reason,
        VariantSelectedReason::DefaultTextRunFallback
    );
    assert!(report.rejected_variants.iter().any(|variant| {
        variant.variant_id == "glyphRun"
            && variant
                .reasons
                .contains(&VariantRejectReason::FaceIndexUnsupported)
    }));
    let font_report = report
        .font_verification
        .as_ref()
        .expect("out-of-range TTC face rejection should carry font verification");
    assert_eq!(font_report.blob_resolved, Some(true));
    assert_eq!(font_report.exact_face_instantiated, Some(false));
    assert_eq!(font_report.face_index_supported, Some(false));
}

#[test]
fn native_skia_replays_variation_glyph_run_when_exact_instance_instantiates() {
    let renderer = SkiaLayerRenderer::new();
    let font_data = include_bytes!("../../../web/fonts/HappinessSansVF.woff2");
    let typeface = renderer
        .font_mgr
        .new_from_data(font_data.as_slice(), Some(0))
        .expect("checked-in variable font should instantiate");
    let parameters = typeface
        .variation_design_parameters()
        .expect("checked-in variable font should expose variation axes");
    let parameter = parameters
        .iter()
        .find(|parameter| {
            let tag = [
                parameter.tag.a(),
                parameter.tag.b(),
                parameter.tag.c(),
                parameter.tag.d(),
            ];
            tag == *b"wght"
        })
        .or_else(|| parameters.first())
        .expect("checked-in variable font should have at least one variation axis");
    let axis_tag = String::from_utf8(vec![
        parameter.tag.a(),
        parameter.tag.b(),
        parameter.tag.c(),
        parameter.tag.d(),
    ])
    .expect("variation axis tag should be ASCII");
    let axis_value = if parameter.max > parameter.def {
        parameter.max
    } else if parameter.min < parameter.def {
        parameter.min
    } else {
        parameter.def
    };
    let coordinates = [skia_safe::font_arguments::variation_position::Coordinate {
        axis: parameter.tag,
        value: axis_value,
    }];
    let arguments = skia_safe::FontArguments::new().set_variation_design_position(
        skia_safe::font_arguments::VariationPosition {
            coordinates: &coordinates,
        },
    );
    let instance = typeface
        .clone_with_arguments(&arguments)
        .expect("checked-in variable font should instantiate exact axis tuple");
    let instance_font = skia_safe::Font::from_typeface(instance, Some(32.0));
    let glyph_id = instance_font
        .text_to_glyphs_vec("H")
        .into_iter()
        .next()
        .expect("checked-in variable font should map H to a glyph");
    assert_ne!(glyph_id, 0);
    let (advance, bounds) = instance_font.measure_str("H", None);
    assert!(advance.is_finite() && advance > 0.0);
    assert!(bounds.width().is_finite() && bounds.height().is_finite());

    let alternate_axis_value = if (axis_value - parameter.max).abs() < f32::EPSILON
        && parameter.min < parameter.def
    {
        Some(parameter.min)
    } else if (axis_value - parameter.min).abs() < f32::EPSILON && parameter.max > parameter.def {
        Some(parameter.max)
    } else {
        None
    };
    let mut variation_cases = vec![
        ("non-default-axis", axis_value),
        ("explicit-default-axis", parameter.def),
    ];
    if let Some(alternate_axis_value) = alternate_axis_value {
        variation_cases.push(("alternate-axis-bound", alternate_axis_value));
    }

    for (case_name, selected_axis_value) in variation_cases {
        let mut tree = glyph_variant_test_tree(&[glyph_id], GlyphRunReplayEligibility::Portable);
        let digest = crate::paint::resource_digest_hex(font_data);
        let data_ref = BinaryResourceRef {
            kind: BinaryResourceKind::FontBlob,
            id: crate::paint::font_blob_resource_key(font_data.len(), &digest),
        };
        let digest = FontDigest {
            algorithm: "blake3".to_string(),
            value: digest,
        };
        tree.resources.intern_font_blob_bytes(font_data);
        let blob = &mut tree.resources.font_resources_mut().blobs[0];
        blob.digest = Some(digest.clone());
        blob.data_ref = Some(data_ref.clone());
        blob.portability = FontPortability::PortableBlob {
            digest: digest.clone(),
            data_ref,
        };
        let face = &mut tree.resources.font_resources_mut().faces[0];
        face.postscript_name = Some("HappinessSansVF".to_string());
        if let LayerNodeKind::Leaf { ops, .. } = &mut tree.root.kind {
            for op in ops {
                if let PaintOp::GlyphRun { run, .. } = op {
                    run.shape_key.font_instance.variations = vec![VariationAxisValue {
                        tag: axis_tag.clone(),
                        value: selected_axis_value,
                    }];
                }
            }
        }

        let output = renderer
            .render_raster_with_options(&tree, RasterRenderOptions::default())
            .expect("exact variable font glyph run render");
        let pixmap = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");
        let bounds = alpha_bounds(&pixmap).expect("glyph run ink");
        let report = output
            .diagnostics
            .variant_selections
            .iter()
            .find(|report| report.equivalence_group == "text-0")
            .expect("native Skia exact variation report");

        assert!(
            bounds.max_x < 100,
            "native Skia should draw the exact variable-font GlyphRun and suppress the right-side TextRun fallback for {case_name}, got {bounds:?}"
        );
        assert_eq!(report.selected_variant_id, "glyphRun", "{case_name}");
        assert_eq!(
            report.selected_reason,
            VariantSelectedReason::GlyphRunStrictEligible,
            "{case_name}"
        );
        let font_report = report
            .font_verification
            .as_ref()
            .expect("exact variation selection should carry font verification");
        assert_eq!(font_report.blob_resolved, Some(true), "{case_name}");
        assert_eq!(
            font_report.exact_face_instantiated,
            Some(true),
            "{case_name}"
        );
        assert_eq!(font_report.variation_supported, Some(true), "{case_name}");
        assert!(report.rejected_variants.iter().all(|variant| {
            variant.variant_id != "glyphRun"
                || !variant
                    .reasons
                    .contains(&VariantRejectReason::VariationUnsupported)
        }));
    }
}

#[test]
fn native_skia_rejects_invalid_variation_axes_with_exact_variable_font() {
    let renderer = SkiaLayerRenderer::new();
    let font_data = include_bytes!("../../../web/fonts/HappinessSansVF.woff2");
    let typeface = renderer
        .font_mgr
        .new_from_data(font_data.as_slice(), Some(0))
        .expect("checked-in variable font should instantiate");
    let parameters = typeface
        .variation_design_parameters()
        .expect("checked-in variable font should expose variation axes");
    let parameter = parameters
        .iter()
        .find(|parameter| {
            let tag = [
                parameter.tag.a(),
                parameter.tag.b(),
                parameter.tag.c(),
                parameter.tag.d(),
            ];
            tag == *b"wght"
        })
        .or_else(|| parameters.first())
        .expect("checked-in variable font should have at least one variation axis");
    let axis_tag = String::from_utf8(vec![
        parameter.tag.a(),
        parameter.tag.b(),
        parameter.tag.c(),
        parameter.tag.d(),
    ])
    .expect("variation axis tag should be ASCII");
    let glyph_id = skia_safe::Font::from_typeface(typeface, Some(32.0))
        .text_to_glyphs_vec("H")
        .into_iter()
        .next()
        .expect("checked-in variable font should map H to a glyph");
    assert_ne!(glyph_id, 0);

    let cases = [
        (
            "unsupported-axis",
            vec![VariationAxisValue {
                tag: "XXXX".to_string(),
                value: parameter.def,
            }],
        ),
        (
            "out-of-range-axis",
            vec![VariationAxisValue {
                tag: axis_tag,
                value: parameter.max.max(parameter.def) + 10_000.0,
            }],
        ),
    ];

    for (case_name, variations) in cases {
        let mut tree = glyph_variant_test_tree(&[glyph_id], GlyphRunReplayEligibility::Portable);
        let digest = crate::paint::resource_digest_hex(font_data);
        let data_ref = BinaryResourceRef {
            kind: BinaryResourceKind::FontBlob,
            id: crate::paint::font_blob_resource_key(font_data.len(), &digest),
        };
        let digest = FontDigest {
            algorithm: "blake3".to_string(),
            value: digest,
        };
        tree.resources.intern_font_blob_bytes(font_data);
        let blob = &mut tree.resources.font_resources_mut().blobs[0];
        blob.digest = Some(digest.clone());
        blob.data_ref = Some(data_ref.clone());
        blob.portability = FontPortability::PortableBlob {
            digest: digest.clone(),
            data_ref,
        };
        tree.resources.font_resources_mut().faces[0].postscript_name =
            Some("HappinessSansVF".to_string());
        if let LayerNodeKind::Leaf { ops, .. } = &mut tree.root.kind {
            for op in ops {
                if let PaintOp::GlyphRun { run, .. } = op {
                    run.shape_key.font_instance.variations = variations.clone();
                }
            }
        }

        let output = renderer
            .render_raster_with_options(&tree, RasterRenderOptions::default())
            .expect("invalid variable axis glyph run fallback render");
        let pixmap = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");
        let bounds = alpha_bounds(&pixmap).expect("text fallback ink");
        let report = output
            .diagnostics
            .variant_selections
            .iter()
            .find(|report| report.equivalence_group == "text-0")
            .expect("native Skia invalid variation report");

        assert!(
            bounds.min_x > 95,
            "native Skia must keep TextRun fallback for invalid exact variation case {case_name}, got {bounds:?}"
        );
        assert_eq!(report.selected_variant_id, "textRun", "{case_name}");
        assert_eq!(
            report.selected_reason,
            VariantSelectedReason::DefaultTextRunFallback,
            "{case_name}"
        );
        assert!(
            report.rejected_variants.iter().any(|variant| {
                variant.variant_id == "glyphRun"
                    && variant
                        .reasons
                        .contains(&VariantRejectReason::VariationUnsupported)
            }),
            "{case_name}"
        );
        assert_eq!(
            report
                .font_verification
                .as_ref()
                .and_then(|verification| verification.variation_supported),
            Some(false),
            "{case_name}"
        );
    }
}

#[test]
fn native_skia_keeps_text_fallback_for_variation_glyph_run_until_exact_construction() {
    let renderer = SkiaLayerRenderer::new();
    let style = TextStyle {
        font_family: "sans-serif".to_string(),
        font_size: 32.0,
        ..Default::default()
    };
    let glyph_id = make_font(&style, &renderer.font_mgr, "A")
        .text_to_glyphs_vec("A")
        .into_iter()
        .next()
        .expect("test font should map A to a glyph");
    let cases = [
        (
            "supported-axis-instance",
            vec![VariationAxisValue {
                tag: "wght".to_string(),
                value: 700.0,
            }],
        ),
        (
            "unsupported-axis",
            vec![VariationAxisValue {
                tag: "XXXX".to_string(),
                value: 1.0,
            }],
        ),
        (
            "out-of-range-axis",
            vec![VariationAxisValue {
                tag: "wght".to_string(),
                value: 10_000.0,
            }],
        ),
        (
            "different-axis-tuple",
            vec![
                VariationAxisValue {
                    tag: "wdth".to_string(),
                    value: 75.0,
                },
                VariationAxisValue {
                    tag: "wght".to_string(),
                    value: 700.0,
                },
            ],
        ),
        (
            "explicit-default-axis",
            vec![VariationAxisValue {
                tag: "wght".to_string(),
                value: 400.0,
            }],
        ),
    ];

    for (case_name, variations) in cases {
        let mut tree = glyph_variant_test_tree(&[glyph_id], GlyphRunReplayEligibility::Portable);
        if let LayerNodeKind::Leaf { ops, .. } = &mut tree.root.kind {
            for op in ops {
                if let PaintOp::GlyphRun { run, .. } = op {
                    run.shape_key.font_instance.variations = variations.clone();
                }
            }
        }

        let output = renderer
            .render_raster_with_options(&tree, RasterRenderOptions::default())
            .expect("variation glyph run fallback render");
        let pixmap = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");
        let bounds = alpha_bounds(&pixmap).expect("text fallback ink");
        let report = output
            .diagnostics
            .variant_selections
            .iter()
            .find(|report| report.equivalence_group == "text-0")
            .expect("native Skia variation fallback report");

        assert!(
            bounds.min_x > 95,
            "native Skia must keep TextRun fallback when GlyphRun has unresolved variation axes for {case_name}, got {bounds:?}"
        );
        assert_eq!(report.selected_variant_id, "textRun", "{case_name}");
        assert_eq!(
            report.selected_reason,
            VariantSelectedReason::DefaultTextRunFallback,
            "{case_name}"
        );
        assert!(
            report.rejected_variants.iter().any(|variant| {
                variant.variant_id == "glyphRun"
                    && variant
                        .reasons
                        .contains(&VariantRejectReason::VariationUnsupported)
            }),
            "{case_name}"
        );
        assert_eq!(
            report
                .font_verification
                .as_ref()
                .and_then(|verification| verification.variation_supported),
            Some(false),
            "{case_name}"
        );
    }
}

#[test]
fn native_skia_keeps_text_fallback_for_nonzero_face_index_until_exact_construction() {
    let renderer = SkiaLayerRenderer::new();
    let style = TextStyle {
        font_family: "sans-serif".to_string(),
        font_size: 32.0,
        ..Default::default()
    };
    let glyph_id = make_font(&style, &renderer.font_mgr, "A")
        .text_to_glyphs_vec("A")
        .into_iter()
        .next()
        .expect("test font should map A to a glyph");
    let cases = [
        ("wrong-face-index", 1, false),
        ("high-face-index", 7, false),
        ("ambiguous-metadata-face-index", 2, true),
    ];

    for (case_name, face_index, ambiguous_metadata) in cases {
        let mut tree = glyph_variant_test_tree(&[glyph_id], GlyphRunReplayEligibility::Portable);
        let face = &mut tree.resources.font_resources_mut().faces[0];
        face.face_index = face_index;
        if ambiguous_metadata {
            face.postscript_name = None;
            face.family_names = vec![
                LocalizedName {
                    locale: None,
                    value: "TestFace".to_string(),
                },
                LocalizedName {
                    locale: Some("ko-KR".to_string()),
                    value: "TestFace".to_string(),
                },
            ];
        }

        let output = renderer
            .render_raster_with_options(&tree, RasterRenderOptions::default())
            .expect("face-index glyph run fallback render");
        let pixmap = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");
        let bounds = alpha_bounds(&pixmap).expect("text fallback ink");
        let report = output
            .diagnostics
            .variant_selections
            .iter()
            .find(|report| report.equivalence_group == "text-0")
            .expect("native Skia face-index fallback report");

        assert!(
            bounds.min_x > 95,
            "native Skia must keep TextRun fallback when GlyphRun has unresolved face index for {case_name}, got {bounds:?}"
        );
        assert_eq!(report.selected_variant_id, "textRun", "{case_name}");
        assert_eq!(
            report.selected_reason,
            VariantSelectedReason::DefaultTextRunFallback,
            "{case_name}"
        );
        assert!(
            report.rejected_variants.iter().any(|variant| {
                variant.variant_id == "glyphRun"
                    && variant
                        .reasons
                        .contains(&VariantRejectReason::FaceIndexUnsupported)
            }),
            "{case_name}"
        );
        let font_report = report
            .font_verification
            .as_ref()
            .expect("face-index rejection should carry font verification");
        assert_eq!(
            font_report.blob_key.as_deref(),
            Some("font-blob-0"),
            "{case_name}"
        );
        assert_eq!(font_report.blob_resolved, Some(true), "{case_name}");
        assert_eq!(
            font_report.exact_face_instantiated,
            Some(false),
            "{case_name}"
        );
        assert_eq!(font_report.face_index_supported, Some(false), "{case_name}");
    }
}

#[test]
fn native_skia_keeps_text_fallback_for_mixed_per_glyph_and_glyph_transforms_until_writer_gate() {
    let renderer = SkiaLayerRenderer::new();
    let style = TextStyle {
        font_family: "sans-serif".to_string(),
        font_size: 32.0,
        ..Default::default()
    };
    let glyph_id = make_font(&style, &renderer.font_mgr, "A")
        .text_to_glyphs_vec("A")
        .into_iter()
        .next()
        .expect("test font should map A to a glyph");

    let mut mixed_orientation_tree =
        glyph_variant_test_tree(&[glyph_id], GlyphRunReplayEligibility::Portable);
    if let LayerNodeKind::Leaf { ops, .. } = &mut mixed_orientation_tree.root.kind {
        for op in ops {
            if let PaintOp::GlyphRun { run, .. } = op {
                run.orientation = GlyphRunOrientation::MixedPerGlyph;
            }
        }
    }
    let mut transformed_glyph_tree =
        glyph_variant_test_tree(&[glyph_id], GlyphRunReplayEligibility::Portable);
    if let LayerNodeKind::Leaf { ops, .. } = &mut transformed_glyph_tree.root.kind {
        for op in ops {
            if let PaintOp::GlyphRun { run, .. } = op {
                run.glyph_transforms = Some(vec![GlyphTransform {
                    xx: 1.0,
                    xy: 0.0,
                    yx: 0.0,
                    yy: 1.0,
                    tx: 3.0,
                    ty: 4.0,
                }]);
            }
        }
    }

    for (case_name, tree) in [
        ("mixed-per-glyph-orientation", mixed_orientation_tree),
        ("glyph-transform-run", transformed_glyph_tree),
    ] {
        let output = renderer
            .render_raster_with_options(&tree, RasterRenderOptions::default())
            .expect("mixed glyph transform fallback render");
        let pixmap = tiny_skia::Pixmap::decode_png(&output.bytes).expect("png decode");
        let bounds = alpha_bounds(&pixmap).expect("text fallback ink");
        let report = output
            .diagnostics
            .variant_selections
            .iter()
            .find(|report| report.equivalence_group == "text-0")
            .expect("native Skia mixed glyph fallback report");

        assert!(
            bounds.min_x > 95,
            "native Skia must keep TextRun fallback for writer-gated {case_name}, got {bounds:?}"
        );
        assert_eq!(report.selected_variant_id, "textRun", "{case_name}");
        assert_eq!(
            report.selected_reason,
            VariantSelectedReason::DefaultTextRunFallback,
            "{case_name}"
        );
        assert!(
            report.rejected_variants.iter().any(|variant| {
                variant.variant_id == "glyphRun"
                    && variant
                        .reasons
                        .contains(&VariantRejectReason::VariantUnsupported)
            }),
            "{case_name}"
        );
    }
}

#[test]
fn native_skia_keeps_text_fallback_for_unsupported_glyph_run_effects() {
    let renderer = SkiaLayerRenderer::new();
    let style = TextStyle {
        font_family: "sans-serif".to_string(),
        font_size: 32.0,
        ..Default::default()
    };
    let glyph_id = make_font(&style, &renderer.font_mgr, "A")
        .text_to_glyphs_vec("A")
        .into_iter()
        .next()
        .expect("test font should map A to a glyph");

    let mut tree = glyph_variant_test_tree(&[glyph_id], GlyphRunReplayEligibility::Portable);
    if let LayerNodeKind::Leaf { ops, .. } = &mut tree.root.kind {
        for op in ops {
            if let PaintOp::GlyphRun { run, .. } = op {
                run.paint_style.underline = UnderlineType::Bottom;
            }
        }
    }
    let png = renderer
        .render_png(&tree)
        .expect("unsupported glyph effect fallback render");
    let pixmap = tiny_skia::Pixmap::decode_png(&png).expect("png decode");
    let bounds = alpha_bounds(&pixmap).expect("text fallback ink");

    assert!(
        bounds.min_x > 95,
        "native Skia must keep TextRun fallback when GlyphRun has unsupported text effects, got {bounds:?}"
    );
}

#[test]
fn native_skia_replays_glyph_run_shadow_effect() {
    let renderer = SkiaLayerRenderer::new();
    let style = TextStyle {
        font_family: "sans-serif".to_string(),
        font_size: 32.0,
        ..Default::default()
    };
    let glyph_id = make_font(&style, &renderer.font_mgr, "A")
        .text_to_glyphs_vec("A")
        .into_iter()
        .next()
        .expect("test font should map A to a glyph");

    let mut tree = glyph_variant_test_tree(&[glyph_id], GlyphRunReplayEligibility::Portable);
    if let LayerNodeKind::Leaf { ops, .. } = &mut tree.root.kind {
        for op in ops {
            if let PaintOp::GlyphRun { run, .. } = op {
                run.paint_style.shadow_type = 1;
                run.paint_style.shadow_color = 0x0000_0000;
                run.paint_style.shadow_offset_x = 4.0;
                run.paint_style.shadow_offset_y = 2.0;
            }
        }
    }
    let png = renderer
        .render_png(&tree)
        .expect("shadow glyph variant render");
    let pixmap = tiny_skia::Pixmap::decode_png(&png).expect("png decode");
    let bounds = alpha_bounds(&pixmap).expect("shadow glyph variant ink");

    assert!(
        bounds.max_x < 100,
        "native Skia should select a shadow-capable GlyphRun variant instead of TextRun fallback, got {bounds:?}"
    );
}

#[test]
fn native_skia_replays_glyph_run_outline_effect() {
    let renderer = SkiaLayerRenderer::new();
    let style = TextStyle {
        font_family: "sans-serif".to_string(),
        font_size: 32.0,
        ..Default::default()
    };
    let glyph_id = make_font(&style, &renderer.font_mgr, "A")
        .text_to_glyphs_vec("A")
        .into_iter()
        .next()
        .expect("test font should map A to a glyph");

    let mut tree = glyph_variant_test_tree(&[glyph_id], GlyphRunReplayEligibility::Portable);
    if let LayerNodeKind::Leaf { ops, .. } = &mut tree.root.kind {
        for op in ops {
            if let PaintOp::GlyphRun { run, .. } = op {
                run.paint_style.outline_type = 1;
            }
        }
    }
    let png = renderer
        .render_png(&tree)
        .expect("outline glyph variant render");
    let pixmap = tiny_skia::Pixmap::decode_png(&png).expect("png decode");
    let bounds = alpha_bounds(&pixmap).expect("outline glyph variant ink");
    let white_pixels = count_pixels_matching(&pixmap, |pixel| {
        pixel.alpha() > 160 && pixel.red() > 220 && pixel.green() > 220 && pixel.blue() > 220
    });
    let dark_pixels = count_pixels_matching(&pixmap, |pixel| {
        pixel.alpha() > 32 && pixel.red() < 80 && pixel.green() < 80 && pixel.blue() < 80
    });

    assert!(
        bounds.max_x < 100,
        "native Skia should select an outline-capable GlyphRun variant instead of TextRun fallback, got {bounds:?}"
    );
    assert!(
        white_pixels > 20 && dark_pixels > 20,
        "outline GlyphRun should paint both white fill and dark stroke, white={white_pixels}, dark={dark_pixels}"
    );
}

#[test]
fn native_skia_replays_glyph_run_emboss_and_engrave_effects() {
    let renderer = SkiaLayerRenderer::new();
    let style = TextStyle {
        font_family: "sans-serif".to_string(),
        font_size: 32.0,
        ..Default::default()
    };
    let glyph_id = make_font(&style, &renderer.font_mgr, "A")
        .text_to_glyphs_vec("A")
        .into_iter()
        .next()
        .expect("test font should map A to a glyph");

    for (emboss, engrave, label) in [(true, false, "emboss"), (false, true, "engrave")] {
        let mut tree = glyph_variant_test_tree(&[glyph_id], GlyphRunReplayEligibility::Portable);
        if let LayerNodeKind::Leaf { ops, .. } = &mut tree.root.kind {
            for op in ops {
                if let PaintOp::GlyphRun { run, .. } = op {
                    run.paint_style.emboss = emboss;
                    run.paint_style.engrave = engrave;
                }
            }
        }
        let png = renderer
            .render_png(&tree)
            .unwrap_or_else(|err| panic!("{label} glyph variant render failed: {err:?}"));
        let pixmap = tiny_skia::Pixmap::decode_png(&png).expect("png decode");
        let bounds = alpha_bounds(&pixmap).expect("emboss/engrave glyph variant ink");
        let light_pixels = count_pixels_matching(&pixmap, |pixel| {
            pixel.alpha() > 32 && pixel.red() > 180 && pixel.green() > 180 && pixel.blue() > 180
        });
        let gray_pixels = count_pixels_matching(&pixmap, |pixel| {
            pixel.alpha() > 32
                && pixel.red() >= 80
                && pixel.red() <= 190
                && pixel.green() >= 80
                && pixel.green() <= 190
                && pixel.blue() >= 80
                && pixel.blue() <= 190
        });

        assert!(
            bounds.max_x < 100,
            "native Skia should select a {label}-capable GlyphRun variant instead of TextRun fallback, got {bounds:?}"
        );
        assert!(
            light_pixels > 10 && gray_pixels > 10,
            "{label} GlyphRun should paint highlight and shadow passes, light={light_pixels}, gray={gray_pixels}"
        );
    }
}

#[test]
fn native_skia_replays_all_parts_of_selected_glyph_variant_set() {
    let renderer = SkiaLayerRenderer::new();
    let style = TextStyle {
        font_family: "sans-serif".to_string(),
        font_size: 32.0,
        ..Default::default()
    };
    let glyph_id = make_font(&style, &renderer.font_mgr, "A")
        .text_to_glyphs_vec("A")
        .into_iter()
        .next()
        .expect("test font should map A to a glyph");

    let tree = glyph_variant_test_tree(&[glyph_id, glyph_id], GlyphRunReplayEligibility::Portable);
    let png = renderer
        .render_png(&tree)
        .expect("multi-part glyph variant render");
    let pixmap = tiny_skia::Pixmap::decode_png(&png).expect("png decode");
    let bounds = alpha_bounds(&pixmap).expect("multi-part glyph variant ink");

    assert!(
        bounds.max_x > 70 && bounds.max_x < 110,
        "native Skia should draw all selected GlyphRun parts and suppress the right-side TextRun fallback, got {bounds:?}"
    );
}

#[test]
fn native_skia_applies_strict_glyph_run_font_instance() {
    let renderer = SkiaLayerRenderer::new();
    let style = TextStyle {
        font_family: "sans-serif".to_string(),
        font_size: 32.0,
        ..Default::default()
    };
    let glyph_id = make_font(&style, &renderer.font_mgr, "A")
        .text_to_glyphs_vec("A")
        .into_iter()
        .next()
        .expect("test font should map A to a glyph");
    let mut tree = glyph_variant_test_tree(&[glyph_id], GlyphRunReplayEligibility::Portable);
    let run = if let LayerNodeKind::Leaf { ops, .. } = &mut tree.root.kind {
        ops.iter_mut()
            .find_map(|op| match op {
                PaintOp::GlyphRun { run, .. } => {
                    run.shape_key.font_instance.size_px = 27.0;
                    run.shape_key.font_instance.synthetic_bold = true;
                    run.shape_key.font_instance.synthetic_italic = true;
                    Some(run.clone())
                }
                _ => None,
            })
            .expect("glyph variant test tree should contain a GlyphRun")
    } else {
        panic!("glyph variant test tree should use a leaf root")
    };

    let font = native_skia_glyph_run_font(&run, &tree.resources, &renderer.font_mgr)
        .expect("strict GlyphRun font instance should resolve");
    assert_eq!(font.size(), 27.0);
    assert!(font.is_embolden());
    assert!((font.skew_x() + 0.25).abs() < f32::EPSILON);

    let png = renderer
        .render_png(&tree)
        .expect("synthetic strict GlyphRun render");
    let pixmap = tiny_skia::Pixmap::decode_png(&png).expect("png decode");
    let bounds = alpha_bounds(&pixmap).expect("synthetic strict GlyphRun ink");
    assert!(
        bounds.max_x < 100,
        "native Skia should select the synthetic strict GlyphRun and suppress its TextRun fallback, got {bounds:?}"
    );
}

#[test]
fn native_skia_replays_synthetic_fallback_font_variant_parts() {
    let renderer = SkiaLayerRenderer::new();
    let style = TextStyle {
        font_family: "sans-serif".to_string(),
        font_size: 32.0,
        ..Default::default()
    };
    let glyph_id = make_font(&style, &renderer.font_mgr, "A")
        .text_to_glyphs_vec("A")
        .into_iter()
        .next()
        .expect("test font should map A to a glyph");

    let mut tree =
        glyph_variant_test_tree(&[glyph_id, glyph_id], GlyphRunReplayEligibility::Portable);
    let digest = FontDigest {
        algorithm: "sha256".to_string(),
        value: "test-font-digest-alt".to_string(),
    };
    let data_ref = BinaryResourceRef {
        kind: BinaryResourceKind::FontBlob,
        id: "font-blob-alt".to_string(),
    };
    tree.resources
        .font_resources_mut()
        .blobs
        .push(FontBlobResource {
            id: FontBlobKey("font-blob-alt".to_string()),
            digest: Some(digest.clone()),
            source: FontResourceSource::Bundled,
            data_ref: Some(data_ref.clone()),
            portability: FontPortability::PortableBlob { digest, data_ref },
        });
    tree.resources
        .font_resources_mut()
        .faces
        .push(FontFaceResource {
            id: FontFaceKey("test-face-alt".to_string()),
            blob_key: FontBlobKey("font-blob-alt".to_string()),
            face_index: 0,
            postscript_name: Some("TestFaceAlt".to_string()),
            family_names: Vec::new(),
            style_names: Vec::new(),
            weight_class: None,
            width_class: None,
            italic: None,
        });
    if let LayerNodeKind::Leaf { ops, .. } = &mut tree.root.kind {
        for op in ops {
            if let PaintOp::GlyphRun { run, .. } = op {
                if run.variant.part_index == 1 {
                    run.shape_key.font_instance.face_key = FontFaceKey("test-face-alt".to_string());
                    run.clusters[0]
                        .flags
                        .push(crate::paint::GlyphClusterFlag::FallbackBoundary);
                }
            }
        }
    }

    let png = renderer
        .render_png(&tree)
        .expect("synthetic fallback font split glyph variant render");
    let pixmap = tiny_skia::Pixmap::decode_png(&png).expect("png decode");
    let bounds = alpha_bounds(&pixmap).expect("synthetic fallback split glyph variant ink");

    assert!(
        bounds.max_x > 70 && bounds.max_x < 110,
        "native Skia should draw every GlyphRun part in a synthetic fallback-font variant set, got {bounds:?}"
    );
}

#[test]
fn native_skia_replays_bidi_split_glyph_variant_parts_in_paint_order() {
    let renderer = SkiaLayerRenderer::new();
    let style = TextStyle {
        font_family: "sans-serif".to_string(),
        font_size: 32.0,
        ..Default::default()
    };
    let glyph_id = make_font(&style, &renderer.font_mgr, "A")
        .text_to_glyphs_vec("A")
        .into_iter()
        .next()
        .expect("test font should map A to a glyph");

    let mut tree =
        glyph_variant_test_tree(&[glyph_id, glyph_id], GlyphRunReplayEligibility::Portable);
    if let LayerNodeKind::Leaf { ops, .. } = &mut tree.root.kind {
        for op in ops {
            if let PaintOp::GlyphRun { run, .. } = op {
                if run.variant.part_index == 0 {
                    run.source.utf8_range = TextSourceRange::new(1, 2);
                    run.source.utf16_range = TextSourceRange::new(1, 2);
                    run.clusters[0].source_range_utf8 = TextSourceRange::new(1, 2);
                    run.clusters[0].source_range_utf16 = Some(TextSourceRange::new(1, 2));
                    run.direction = TextDirection::Rtl;
                    run.bidi_level = Some(1);
                    run.shape_key.direction = TextDirection::Rtl;
                } else {
                    run.source.utf8_range = TextSourceRange::new(0, 1);
                    run.source.utf16_range = TextSourceRange::new(0, 1);
                    run.clusters[0].source_range_utf8 = TextSourceRange::new(0, 1);
                    run.clusters[0].source_range_utf16 = Some(TextSourceRange::new(0, 1));
                    run.direction = TextDirection::Ltr;
                    run.bidi_level = Some(0);
                    run.shape_key.direction = TextDirection::Ltr;
                }
            }
        }
    }

    let png = renderer
        .render_png(&tree)
        .expect("bidi split glyph variant render");
    let pixmap = tiny_skia::Pixmap::decode_png(&png).expect("png decode");
    let bounds = alpha_bounds(&pixmap).expect("bidi split glyph variant ink");

    assert!(
        bounds.max_x > 70 && bounds.max_x < 110,
        "native Skia should paint every bidi GlyphRun part in op-stream order and suppress TextRun fallback, got {bounds:?}"
    );
}

#[test]
fn native_skia_replays_vertical_upright_glyph_variant_parts() {
    let renderer = SkiaLayerRenderer::new();
    let style = TextStyle {
        font_family: "sans-serif".to_string(),
        font_size: 26.0,
        ..Default::default()
    };
    let glyph_id = make_font(&style, &renderer.font_mgr, "A")
        .text_to_glyphs_vec("A")
        .into_iter()
        .next()
        .expect("test font should map A to a glyph");

    let mut tree =
        glyph_variant_test_tree(&[glyph_id, glyph_id], GlyphRunReplayEligibility::Portable);
    if let LayerNodeKind::Leaf { ops, .. } = &mut tree.root.kind {
        for op in ops {
            if let PaintOp::GlyphRun { run, .. } = op {
                run.paint_style.font_size = 26.0;
                run.shape_key.font_instance.size_px = 26.0;
                run.shape_key.writing_mode = WritingMode::VerticalRl;
                run.writing_mode = WritingMode::VerticalRl;
                run.orientation = GlyphRunOrientation::VerticalUpright;
                run.placement.run_to_page.e = 46.0;
                run.placement.run_to_page.f = 32.0 + f64::from(run.variant.part_index) * 30.0;
            }
        }
    }

    let png = renderer
        .render_png(&tree)
        .expect("vertical upright glyph variant render");
    let pixmap = tiny_skia::Pixmap::decode_png(&png).expect("png decode");
    let bounds = alpha_bounds(&pixmap).expect("vertical upright glyph variant ink");

    assert!(
        bounds.height() > bounds.width() && bounds.max_x < 100,
        "native Skia should replay vertical-upright GlyphRun parts from explicit placement and suppress fallback, got {bounds:?}"
    );
}

#[test]
fn native_skia_replays_vertical_sideways_glyph_variant_transform() {
    let renderer = SkiaLayerRenderer::new();
    let style = TextStyle {
        font_family: "sans-serif".to_string(),
        font_size: 32.0,
        ..Default::default()
    };
    let glyph_id = make_font(&style, &renderer.font_mgr, "A")
        .text_to_glyphs_vec("A")
        .into_iter()
        .next()
        .expect("test font should map A to a glyph");

    let mut tree = glyph_variant_test_tree(&[glyph_id], GlyphRunReplayEligibility::Portable);
    if let LayerNodeKind::Leaf { ops, .. } = &mut tree.root.kind {
        for op in ops {
            if let PaintOp::GlyphRun { run, .. } = op {
                run.shape_key.writing_mode = WritingMode::VerticalRl;
                run.writing_mode = WritingMode::VerticalRl;
                run.orientation = GlyphRunOrientation::VerticalSideways;
                run.placement.run_to_page = LayerAffineTransform {
                    a: 0.0,
                    b: 1.0,
                    c: -1.0,
                    d: 0.0,
                    e: 62.0,
                    f: 24.0,
                };
            }
        }
    }

    let png = renderer
        .render_png(&tree)
        .expect("vertical sideways glyph variant render");
    let pixmap = tiny_skia::Pixmap::decode_png(&png).expect("png decode");
    let bounds = alpha_bounds(&pixmap).expect("vertical sideways glyph variant ink");

    assert!(
        bounds.min_x >= 55 && bounds.max_x < 100 && bounds.min_y >= 18 && bounds.max_y < 60,
        "native Skia should replay vertical-sideways GlyphRun transform in its explicit placement and suppress fallback, got {bounds:?}"
    );
}

#[test]
fn native_skia_keeps_text_fallback_for_duplicate_glyph_variant_part() {
    let renderer = SkiaLayerRenderer::new();
    let style = TextStyle {
        font_family: "sans-serif".to_string(),
        font_size: 32.0,
        ..Default::default()
    };
    let glyph_id = make_font(&style, &renderer.font_mgr, "A")
        .text_to_glyphs_vec("A")
        .into_iter()
        .next()
        .expect("test font should map A to a glyph");

    let mut tree =
        glyph_variant_test_tree(&[glyph_id, glyph_id], GlyphRunReplayEligibility::Portable);
    if let LayerNodeKind::Leaf { ops, .. } = &mut tree.root.kind {
        for op in ops {
            if let PaintOp::GlyphRun { run, .. } = op {
                run.variant.part_index = 0;
                run.variant.part_count = 1;
            }
        }
    }
    let png = renderer
        .render_png(&tree)
        .expect("duplicate glyph variant part fallback render");
    let pixmap = tiny_skia::Pixmap::decode_png(&png).expect("png decode");
    let bounds = alpha_bounds(&pixmap).expect("text fallback ink");

    assert!(
        bounds.min_x > 95,
        "native Skia must keep TextRun fallback when a GlyphRun variant repeats a part index, got {bounds:?}"
    );
}

#[test]
fn native_skia_keeps_text_fallback_for_position_adjusted_residual_over_tolerance() {
    let renderer = SkiaLayerRenderer::new();
    let style = TextStyle {
        font_family: "sans-serif".to_string(),
        font_size: 32.0,
        ..Default::default()
    };
    let glyph_id = make_font(&style, &renderer.font_mgr, "A")
        .text_to_glyphs_vec("A")
        .into_iter()
        .next()
        .expect("test font should map A to a glyph");

    let mut tree = glyph_variant_test_tree(&[glyph_id], GlyphRunReplayEligibility::Portable);
    if let LayerNodeKind::Leaf { ops, .. } = &mut tree.root.kind {
        for op in ops {
            if let PaintOp::GlyphRun { run, .. } = op {
                run.diagnostics.quality = TextVariantQuality::PositionAdjusted;
                run.variant.quality = Some(TextVariantQuality::PositionAdjusted);
                run.diagnostics.max_residual_after_adjustment_px = 0.75;
            }
        }
    }
    let png = renderer
        .render_png(&tree)
        .expect("position-adjusted residual fallback render");
    let pixmap = tiny_skia::Pixmap::decode_png(&png).expect("png decode");
    let bounds = alpha_bounds(&pixmap).expect("text fallback ink");

    assert!(
        bounds.min_x > 95,
        "native Skia must keep TextRun fallback when PositionAdjusted residual exceeds strict tolerance, got {bounds:?}"
    );
}

#[test]
fn native_skia_replays_position_adjusted_glyph_run_within_tolerance() {
    let renderer = SkiaLayerRenderer::new();
    let style = TextStyle {
        font_family: "sans-serif".to_string(),
        font_size: 32.0,
        ..Default::default()
    };
    let glyph_id = make_font(&style, &renderer.font_mgr, "A")
        .text_to_glyphs_vec("A")
        .into_iter()
        .next()
        .expect("test font should map A to a glyph");

    let mut tree = glyph_variant_test_tree(&[glyph_id], GlyphRunReplayEligibility::Portable);
    if let LayerNodeKind::Leaf { ops, .. } = &mut tree.root.kind {
        for op in ops {
            if let PaintOp::GlyphRun { run, .. } = op {
                run.diagnostics.quality = TextVariantQuality::PositionAdjusted;
                run.variant.quality = Some(TextVariantQuality::PositionAdjusted);
                run.diagnostics.max_origin_delta_px = 0.1;
                run.diagnostics.max_advance_delta_px = 0.1;
                run.diagnostics.max_residual_after_adjustment_px = 0.1;
            }
        }
    }
    let png = renderer
        .render_png(&tree)
        .expect("position-adjusted glyph variant render");
    let pixmap = tiny_skia::Pixmap::decode_png(&png).expect("png decode");
    let bounds = alpha_bounds(&pixmap).expect("position-adjusted glyph variant ink");

    assert!(
        bounds.max_x < 100,
        "native Skia should select PositionAdjusted GlyphRun when residual is within strict tolerance, got {bounds:?}"
    );
}

#[test]
fn native_skia_keeps_text_fallback_for_incomplete_glyph_variant_set() {
    let renderer = SkiaLayerRenderer::new();
    let style = TextStyle {
        font_family: "sans-serif".to_string(),
        font_size: 32.0,
        ..Default::default()
    };
    let glyph_id = make_font(&style, &renderer.font_mgr, "A")
        .text_to_glyphs_vec("A")
        .into_iter()
        .next()
        .expect("test font should map A to a glyph");

    let mut tree =
        glyph_variant_test_tree(&[glyph_id, glyph_id], GlyphRunReplayEligibility::Portable);
    if let LayerNodeKind::Leaf { ops, .. } = &mut tree.root.kind {
        ops.retain(|op| {
            !matches!(
                op,
                PaintOp::GlyphRun { run, .. } if run.variant.part_index == 1
            )
        });
    }
    let png = renderer
        .render_png(&tree)
        .expect("incomplete glyph variant set fallback render");
    let pixmap = tiny_skia::Pixmap::decode_png(&png).expect("png decode");
    let bounds = alpha_bounds(&pixmap).expect("text fallback ink");

    assert!(
        bounds.min_x > 95,
        "native Skia must keep TextRun fallback when GlyphRun variant parts are incomplete, got {bounds:?}"
    );
}

#[test]
fn output_options_enable_text_control_marks() {
    let mut tree = crate::renderer::render_tree::PageRenderTree::new(0, 120.0, 60.0);
    tree.root.children.push(RenderNode::new(
        1,
        RenderNodeType::TextRun(TextRunNode {
            text: "a b".to_string(),
            display_text: None,
            display_clusters: None,
            style: TextStyle {
                font_size: 22.0,
                color: 0x00000000,
                ..Default::default()
            },
            char_shape_id: None,
            para_shape_id: None,
            section_index: None,
            para_index: None,
            char_start: None,
            cell_context: None,
            is_para_end: true,
            is_line_break_end: false,
            rotation: 0.0,
            is_vertical: false,
            char_overlap: None,
            border_fill_id: 0,
            baseline: 26.0,
            field_marker: Default::default(),
        }),
        BoundingBox::new(10.0, 12.0, 70.0, 32.0),
    ));

    let mut builder = LayerBuilder::new(RenderProfile::Screen);
    let base_tree = builder.build(&tree);
    let mut marked_builder =
        LayerBuilder::new(RenderProfile::Screen).with_output_options(LayerOutputOptions {
            show_paragraph_marks: true,
            show_control_codes: true,
            ..Default::default()
        });
    let marked_tree = marked_builder.build(&tree);
    let renderer = SkiaLayerRenderer::new();
    let base_png = renderer.render_png(&base_tree).expect("base skia render");
    let marked_png = renderer
        .render_png(&marked_tree)
        .expect("marked skia render");
    let base = tiny_skia::Pixmap::decode_png(&base_png).expect("base decode");
    let marked = tiny_skia::Pixmap::decode_png(&marked_png).expect("marked decode");
    let count_ink = |pixmap: &tiny_skia::Pixmap| {
        pixmap
            .pixels()
            .iter()
            .filter(|pixel| pixel.alpha() > 0)
            .count()
    };

    assert!(count_ink(&marked) > count_ink(&base));
}

#[test]
fn output_options_replay_structure_control_marks_through_native_skia() {
    let mut tree = crate::renderer::render_tree::PageRenderTree::new(0, 120.0, 60.0);
    tree.root.children.push(RenderNode::new(
        1,
        RenderNodeType::Table(TableNode {
            row_count: 1,
            col_count: 1,
            border_fill_id: 0,
            section_index: None,
            para_index: None,
            control_index: None,
        }),
        BoundingBox::new(10.0, 12.0, 70.0, 32.0),
    ));

    let mut base_builder = LayerBuilder::new(RenderProfile::Screen);
    let base_tree = base_builder.build(&tree);
    let mut marked_builder =
        LayerBuilder::new(RenderProfile::Screen).with_output_options(LayerOutputOptions {
            show_control_codes: true,
            ..Default::default()
        });
    let marked_tree = marked_builder.build(&tree);
    let renderer = SkiaLayerRenderer::new();
    let base =
        tiny_skia::Pixmap::decode_png(&renderer.render_png(&base_tree).expect("base skia render"))
            .expect("base decode");
    let marked = tiny_skia::Pixmap::decode_png(
        &renderer
            .render_png(&marked_tree)
            .expect("marked skia render"),
    )
    .expect("marked decode");
    let structure_red_pixels = count_pixels_matching(&marked, |pixel| {
        pixel.alpha() > 32
            && pixel.red() > 120
            && pixel.red() > pixel.green().saturating_mul(2)
            && pixel.red() > pixel.blue().saturating_mul(2)
    });

    assert_eq!(count_pixels_matching(&base, |pixel| pixel.alpha() > 0), 0);
    assert!(
        structure_red_pixels > 0,
        "native Skia must replay the explicit structure control mark"
    );
}

#[test]
fn externalized_tab_leader_rotation_replays_through_native_skia() {
    let render = |rotation| {
        let bbox = BoundingBox::new(10.0, 10.0, 80.0, 80.0);
        let root = LayerNode::leaf(
            bbox,
            None,
            vec![PaintOp::TabLeader {
                bbox,
                leader: LayerTabLeaderPaint {
                    source: None,
                    leader: TabLeaderInfo {
                        start_x: 10.0,
                        end_x: 60.0,
                        fill_type: 1,
                    },
                    color: 0,
                    font_size: 10.0,
                    baseline: 40.0,
                    rotation,
                },
            }],
        );
        let tree = PageLayerTree::new(100.0, 100.0, root);
        let png = SkiaLayerRenderer::new()
            .render_png(&tree)
            .expect("rotated tab leader render");
        let pixmap = tiny_skia::Pixmap::decode_png(&png).expect("rotated tab leader decode");
        alpha_bounds(&pixmap).expect("tab leader ink")
    };

    let horizontal = render(0.0);
    let vertical = render(90.0);
    assert!(horizontal.width() > horizontal.height() * 5);
    assert!(vertical.height() > vertical.width() * 5);
}

#[test]
fn output_options_enable_line_break_mark() {
    let mut tree = crate::renderer::render_tree::PageRenderTree::new(0, 120.0, 60.0);
    tree.root.children.push(RenderNode::new(
        1,
        RenderNodeType::TextRun(TextRunNode {
            text: "line".to_string(),
            display_text: None,
            display_clusters: None,
            style: TextStyle {
                font_size: 22.0,
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
            is_line_break_end: true,
            rotation: 0.0,
            is_vertical: false,
            char_overlap: None,
            border_fill_id: 0,
            baseline: 26.0,
            field_marker: Default::default(),
        }),
        BoundingBox::new(10.0, 12.0, 70.0, 32.0),
    ));

    let mut builder = LayerBuilder::new(RenderProfile::Screen);
    let base_tree = builder.build(&tree);
    let mut marked_builder =
        LayerBuilder::new(RenderProfile::Screen).with_output_options(LayerOutputOptions {
            show_paragraph_marks: true,
            show_control_codes: true,
            ..Default::default()
        });
    let marked_tree = marked_builder.build(&tree);
    let renderer = SkiaLayerRenderer::new();
    let base_png = renderer.render_png(&base_tree).expect("base skia render");
    let marked_png = renderer
        .render_png(&marked_tree)
        .expect("marked skia render");
    let base = tiny_skia::Pixmap::decode_png(&base_png).expect("base decode");
    let marked = tiny_skia::Pixmap::decode_png(&marked_png).expect("marked decode");
    let count_ink = |pixmap: &tiny_skia::Pixmap| {
        pixmap
            .pixels()
            .iter()
            .filter(|pixel| pixel.alpha() > 0)
            .count()
    };

    assert!(count_ink(&marked) > count_ink(&base));
}

#[test]
fn field_marker_runs_do_not_gain_space_marks() {
    let mut tree = crate::renderer::render_tree::PageRenderTree::new(0, 120.0, 60.0);
    tree.root.children.push(RenderNode::new(
        1,
        RenderNodeType::TextRun(TextRunNode {
            text: "a b".to_string(),
            display_text: None,
            display_clusters: None,
            style: TextStyle {
                font_size: 22.0,
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
            char_overlap: None,
            border_fill_id: 0,
            baseline: 26.0,
            field_marker: crate::renderer::render_tree::FieldMarkerType::FieldBegin,
        }),
        BoundingBox::new(10.0, 12.0, 70.0, 32.0),
    ));

    let mut builder = LayerBuilder::new(RenderProfile::Screen);
    let base_tree = builder.build(&tree);
    let mut marked_builder =
        LayerBuilder::new(RenderProfile::Screen).with_output_options(LayerOutputOptions {
            show_paragraph_marks: true,
            show_control_codes: true,
            ..Default::default()
        });
    let marked_tree = marked_builder.build(&tree);
    let renderer = SkiaLayerRenderer::new();
    let base_png = renderer.render_png(&base_tree).expect("base skia render");
    let marked_png = renderer
        .render_png(&marked_tree)
        .expect("marked skia render");
    let base = tiny_skia::Pixmap::decode_png(&base_png).expect("base decode");
    let marked = tiny_skia::Pixmap::decode_png(&marked_png).expect("marked decode");
    let count_ink = |pixmap: &tiny_skia::Pixmap| {
        pixmap
            .pixels()
            .iter()
            .filter(|pixel| pixel.alpha() > 0)
            .count()
    };

    assert_eq!(
        count_ink(&marked),
        count_ink(&base),
        "field marker TextRuns should not receive extra visible space marks"
    );
}

#[test]
fn renders_tab_leaders_for_skipped_tab_clusters() {
    let render_with_leaders = |tab_leaders| {
        let mut tree = crate::renderer::render_tree::PageRenderTree::new(0, 120.0, 60.0);
        tree.root.children.push(RenderNode::new(
            1,
            RenderNodeType::TextRun(TextRunNode {
                text: "\t".to_string(),
                display_text: None,
                display_clusters: None,
                style: TextStyle {
                    font_size: 18.0,
                    color: 0x00000000,
                    tab_leaders,
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
                char_overlap: None,
                border_fill_id: 0,
                baseline: 30.0,
                field_marker: Default::default(),
            }),
            BoundingBox::new(10.0, 16.0, 90.0, 30.0),
        ));
        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&tree);
        let renderer = SkiaLayerRenderer::new();
        let png = renderer
            .render_png(&layer_tree)
            .expect("skia tab leader render");
        let pixmap = tiny_skia::Pixmap::decode_png(&png).expect("tab leader decode");
        pixmap
            .pixels()
            .iter()
            .filter(|pixel| pixel.alpha() > 0)
            .count()
    };

    let without_leaders = render_with_leaders(Vec::new());
    let with_leaders = render_with_leaders(vec![TabLeaderInfo {
        start_x: 0.0,
        end_x: 80.0,
        fill_type: 1,
    }]);

    assert!(with_leaders > without_leaders);
}

#[test]
fn consumes_profile_and_cache_hints_for_sampling_policy() {
    let screen = SkiaReplayContext::new(RenderProfile::Screen, LayerOutputOptions::default(), 1.0);
    let screen_policy = screen.replay_policy();
    assert_eq!(screen_policy.image_sampling, ImageSampling::linear());
    assert!(screen_policy.vector_antialias);
    assert!(screen_policy.clip_antialias);
    assert!(screen_policy.prefer_direct_text);

    let fast_preview = SkiaReplayContext::new(
        RenderProfile::FastPreview,
        LayerOutputOptions::default(),
        1.0,
    );
    let fast_preview_policy = fast_preview.replay_policy();
    assert_eq!(fast_preview_policy.image_sampling, ImageSampling::nearest());
    assert!(fast_preview_policy.vector_antialias);
    assert!(fast_preview_policy.clip_antialias);

    let print = SkiaReplayContext::new(RenderProfile::Print, LayerOutputOptions::default(), 1.0);
    assert_eq!(
        print.replay_policy().image_sampling,
        ImageSampling::linear_mipmap()
    );

    let mut raster = SkiaReplayContext::new(
        RenderProfile::HighQuality,
        LayerOutputOptions::default(),
        1.0,
    );
    raster.push_cache_hint(CacheHint::PreferRaster);
    let raster_policy = raster.replay_policy();
    assert_eq!(raster_policy.image_sampling, ImageSampling::nearest());
    assert!(raster_policy.vector_antialias);
    assert!(raster_policy.clip_antialias);

    let mut fast_raster = SkiaReplayContext::new(
        RenderProfile::FastPreview,
        LayerOutputOptions::default(),
        1.0,
    );
    fast_raster.push_cache_hint(CacheHint::PreferRaster);
    let fast_raster_policy = fast_raster.replay_policy();
    assert_eq!(fast_raster_policy.image_sampling, ImageSampling::nearest());
    assert!(!fast_raster_policy.vector_antialias);
    assert!(!fast_raster_policy.clip_antialias);

    let mut vector =
        SkiaReplayContext::new(RenderProfile::Screen, LayerOutputOptions::default(), 1.0);
    vector.push_cache_hint(CacheHint::PreferVectorRecording);
    let vector_policy = vector.replay_policy();
    assert_eq!(vector_policy.image_sampling, ImageSampling::linear_mipmap());
    assert!(vector_policy.vector_antialias);
}

#[test]
fn prefer_raster_fast_preview_disables_vector_antialias_for_lines() {
    let bbox = BoundingBox::new(4.0, 4.0, 40.0, 28.0);
    let line = PaintOp::Line {
        bbox,
        line: LayerLinePaint {
            x1: 5.0,
            y1: 7.0,
            x2: 39.0,
            y2: 25.0,
            style: LineStyle {
                color: 0x00000000,
                width: 1.0,
                ..Default::default()
            },
            transform: Default::default(),
        },
    };
    let root = LayerNode::leaf_with_hint(bbox, None, vec![line], CacheHint::PreferRaster);
    let tree = PageLayerTree::with_profile(48.0, 36.0, root, RenderProfile::FastPreview);
    let renderer = SkiaLayerRenderer::new();
    let png = renderer
        .render_png(&tree)
        .expect("fast preview line render");
    let pixmap = tiny_skia::Pixmap::decode_png(&png).expect("png decode");
    let partial_alpha_pixels = pixmap
        .pixels()
        .iter()
        .filter(|pixel| pixel.alpha() > 0 && pixel.alpha() < 255)
        .count();

    assert_eq!(
        partial_alpha_pixels, 0,
        "PreferRaster + FastPreview should use hard-edged vector replay"
    );
}

#[test]
fn screen_profile_keeps_vector_antialias_for_lines() {
    let bbox = BoundingBox::new(4.0, 4.0, 40.0, 28.0);
    let line = PaintOp::Line {
        bbox,
        line: LayerLinePaint {
            x1: 5.0,
            y1: 7.0,
            x2: 39.0,
            y2: 25.0,
            style: LineStyle {
                color: 0x00000000,
                width: 1.0,
                ..Default::default()
            },
            transform: Default::default(),
        },
    };
    let tree = PageLayerTree::new(48.0, 36.0, LayerNode::leaf(bbox, None, vec![line]));
    let renderer = SkiaLayerRenderer::new();
    let png = renderer.render_png(&tree).expect("screen line render");
    let pixmap = tiny_skia::Pixmap::decode_png(&png).expect("png decode");
    let partial_alpha_pixels = pixmap
        .pixels()
        .iter()
        .filter(|pixel| pixel.alpha() > 0 && pixel.alpha() < 255)
        .count();

    assert!(
        partial_alpha_pixels > 0,
        "screen vector replay should keep antialiased line edges"
    );
}
