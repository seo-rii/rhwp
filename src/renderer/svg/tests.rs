use super::*;
use crate::paint::{
    BitmapAlphaMode, BitmapGlyphFiltering, BitmapGlyphPayload, BitmapGlyphScalingPolicy,
    BitmapStrikeSelection, ColorGlyphFormat, ColorGradientStop, ColorLayerNode, ColorLayersPayload,
    ColorLinearGradient, ColorPaintClipNode, ColorPaintCompositeMode, ColorPaintCompositeNode,
    ColorPaintGraphNode, ColorPaintGraphNodeKind, ColorPaintGraphPayload,
    ColorPaintLinearGradientPathNode, ColorPaintRadialGradientPathNode, ColorPaintSolidPathNode,
    ColorPaintTransformNode, ColorRadialGradient, FontColorGlyphRef, GlyphOutlineFillRule,
    GlyphOutlinePaintOrder, GlyphOutlinePayloadKind, GlyphOutlineStrokeCap, GlyphOutlineStrokeJoin,
    GlyphOutlineStrokeStyle, GlyphRange, GlyphRunDiagnostics, GlyphRunReplayEligibility,
    LayerAffineTransform, LayerGlyphOutlinePaint, LayerGlyphOutlinePath, LayerOutputOptions,
    LayerPageBackgroundImagePaint, LayerPageBackgroundPaint, LayerRectanglePaint,
    LayerTextControlMark, LayerTextControlMarkKind, LayerTextOrientation, PaintTextStyle,
    PaintVariantMeta, PaletteRef, ResolvedColor, ResourceArena, SvgGlyphIntrinsicSize,
    SvgGlyphPayload, SvgGlyphSecurityMode, SvgGlyphViewBox, TextRunPlacement, TextSourceEntry,
    TextSourceId, TextSourceRange, TextSourceSpan, TextSourceTable, TextVariantKind,
    TextVariantQuality,
};
use crate::renderer::layer_renderer::{
    VariantRejectReason, VariantSelectedReason, VariantSelectionBackend,
};
use crate::renderer::render_tree::TextRunNode;
use crate::renderer::{ArrowStyle, LineRenderType};

#[test]
fn test_svg_begin_end_page() {
    let mut renderer = SvgRenderer::new();
    renderer.begin_page(800.0, 600.0);
    renderer.end_page();
    let output = renderer.output();
    assert!(output.starts_with("<svg"));
    assert!(output.contains("width=\"800\""));
    assert!(output.ends_with("</svg>\n"));
}

#[test]
fn test_svg_draw_text() {
    let mut renderer = SvgRenderer::new();
    renderer.begin_page(800.0, 600.0);
    renderer.draw_text(
        "안녕하세요",
        10.0,
        20.0,
        &TextStyle {
            font_size: 16.0,
            bold: true,
            ..Default::default()
        },
    );
    let output = renderer.output();
    assert!(output.contains("<text"));
    assert!(output.contains("font-weight=\"bold\""));
}

#[test]
fn test_svg_draw_rect() {
    let mut renderer = SvgRenderer::new();
    renderer.begin_page(800.0, 600.0);
    renderer.draw_rect(
        10.0,
        20.0,
        100.0,
        50.0,
        0.0,
        &ShapeStyle {
            fill_color: Some(0x00FF0000),
            stroke_color: Some(0x00000000),
            stroke_width: 2.0,
            ..Default::default()
        },
    );
    let output = renderer.output();
    assert!(output.contains("<rect"));
    assert!(output.contains("fill=\"#0000ff\"")); // BGR → RGB
}

#[test]
fn test_svg_draw_path() {
    let mut renderer = SvgRenderer::new();
    renderer.begin_page(800.0, 600.0);
    let commands = vec![
        PathCommand::MoveTo(0.0, 0.0),
        PathCommand::LineTo(100.0, 0.0),
        PathCommand::ClosePath,
    ];
    renderer.draw_path(&commands, &ShapeStyle::default());
    let output = renderer.output();
    assert!(output.contains("<path"));
    assert!(output.contains("M0 0"));
    assert!(output.contains("L100 0"));
    assert!(output.contains("Z"));
}

#[test]
fn test_svg_draw_path_applies_shape_opacity_once() {
    let mut renderer = SvgRenderer::new();
    renderer.begin_page(32.0, 24.0);
    renderer.draw_path(
        &[
            PathCommand::MoveTo(2.0, 2.0),
            PathCommand::LineTo(30.0, 2.0),
            PathCommand::LineTo(30.0, 22.0),
            PathCommand::ClosePath,
        ],
        &ShapeStyle {
            fill_color: Some(0x00FF0000),
            stroke_color: Some(0x00000000),
            stroke_width: 2.0,
            opacity: 0.5,
            ..Default::default()
        },
    );
    let output = renderer.output();
    assert!(output.contains(" opacity=\"0.500\""));
    assert_eq!(output.matches("opacity=\"0.500\"").count(), 1);
}

#[test]
fn test_svg_text_decoration() {
    let mut renderer = SvgRenderer::new();
    renderer.begin_page(800.0, 600.0);
    renderer.draw_text(
        "밑줄",
        10.0,
        20.0,
        &TextStyle {
            font_size: 16.0,
            underline: UnderlineType::Bottom,
            ..Default::default()
        },
    );
    renderer.draw_text(
        "취소",
        10.0,
        40.0,
        &TextStyle {
            font_size: 16.0,
            strikethrough: true,
            ..Default::default()
        },
    );
    let output = renderer.output();
    // 밑줄: <line> 요소로 출력
    let underline_count = output.matches("y1=\"22\"").count(); // y + 2.0
    assert!(underline_count > 0, "밑줄 <line> 요소가 있어야 함");
    // 취소선: <line> 요소로 출력
    let strike_count = output
        .matches("stroke=\"#000000\" stroke-width=\"1\"")
        .count();
    assert!(strike_count >= 2, "취소선과 밑줄 <line> 요소가 있어야 함");
}

#[test]
fn test_svg_text_ratio() {
    let mut renderer = SvgRenderer::new();
    renderer.begin_page(800.0, 600.0);
    // ratio 80%: 문자별 transform 적용
    renderer.draw_text(
        "장평",
        50.0,
        100.0,
        &TextStyle {
            font_size: 16.0,
            ratio: 0.8,
            ..Default::default()
        },
    );
    let output = renderer.output();
    // 첫 문자 '장': translate(50,100) scale(0.8000,1)
    assert!(output.contains("transform=\"translate(50,100) scale(0.8000,1)\""));
    // 문자별 렌더링이므로 각 문자가 개별 <text> 요소
    let text_count = output.matches("<text ").count();
    assert_eq!(text_count, 2, "2개 문자 = 2개 <text> 요소");
}

#[test]
fn test_svg_text_ratio_default() {
    let mut renderer = SvgRenderer::new();
    renderer.begin_page(800.0, 600.0);
    // ratio 100%: transform 미적용, 문자별 x좌표
    renderer.draw_text(
        "기본",
        50.0,
        100.0,
        &TextStyle {
            font_size: 16.0,
            ratio: 1.0,
            ..Default::default()
        },
    );
    let output = renderer.output();
    assert!(!output.contains("transform="));
    // 첫 문자는 x=50
    assert!(output.contains("x=\"50\""));
    // 두 번째 문자는 x > 50 (font_size=16 기준)
    let text_count = output.matches("<text ").count();
    assert_eq!(text_count, 2, "2개 문자 = 2개 <text> 요소");
}

#[test]
fn test_svg_text_char_positions() {
    let mut renderer = SvgRenderer::new();
    renderer.begin_page(800.0, 600.0);
    // 자간이 있는 경우 문자별 위치가 정확한지 확인
    let style = TextStyle {
        font_size: 16.0,
        letter_spacing: 2.0,
        ..Default::default()
    };
    renderer.draw_text("AB", 10.0, 20.0, &style);
    let output = renderer.output();
    // letter-spacing SVG 속성은 없어야 함 (좌표에 반영됨)
    assert!(!output.contains("letter-spacing="));
    // 2개 문자 = 2개 <text> 요소
    let text_count = output.matches("<text ").count();
    assert_eq!(text_count, 2);
}

#[test]
fn test_xml_escape() {
    assert_eq!(escape_xml("<test>&\"'"), "&lt;test&gt;&amp;&quot;&apos;");
}

#[test]
fn test_color_to_svg() {
    assert_eq!(color_to_svg(0x000000FF), "#ff0000");
    assert_eq!(color_to_svg(0x00FFFFFF), "#ffffff");
}

fn make_minimal_bmp_2x2() -> Vec<u8> {
    let pixels: [u8; 16] = [
        0xFF, 0x00, 0x00, 0xFF, 0x00, 0xFF, 0x00, 0xFF, 0x00, 0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
        0xFF,
    ];
    let file_size: u32 = 14 + 40 + 16;
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"BM");
    bytes.extend_from_slice(&file_size.to_le_bytes());
    bytes.extend_from_slice(&[0, 0, 0, 0]);
    bytes.extend_from_slice(&54u32.to_le_bytes());
    bytes.extend_from_slice(&40u32.to_le_bytes());
    bytes.extend_from_slice(&2i32.to_le_bytes());
    bytes.extend_from_slice(&2i32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&32u16.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&[0, 0, 0, 0]);
    bytes.extend_from_slice(&[0, 0, 0, 0]);
    bytes.extend_from_slice(&[0, 0, 0, 0]);
    bytes.extend_from_slice(&[0, 0, 0, 0]);
    bytes.extend_from_slice(&pixels);
    bytes
}

#[test]
fn test_bmp_to_png_success() {
    let bmp = make_minimal_bmp_2x2();
    let png = bmp_bytes_to_png_bytes(&bmp).expect("BMP should convert to PNG");
    assert!(png.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
}

#[test]
fn test_bmp_to_png_invalid_returns_none() {
    assert!(bmp_bytes_to_png_bytes(&[0; 32]).is_none());
}

#[test]
fn test_svg_double_line_preserves_dash_and_arrows() {
    let mut renderer = SvgRenderer::new();
    renderer.begin_page(800.0, 600.0);
    renderer.draw_line(
        10.0,
        20.0,
        210.0,
        20.0,
        &LineStyle {
            color: 0x00000000,
            width: 4.0,
            dash: StrokeDash::Dash,
            line_type: LineRenderType::Double,
            start_arrow: ArrowStyle::Arrow,
            end_arrow: ArrowStyle::OpenDiamond,
            start_arrow_size: 0,
            end_arrow_size: 0,
            shadow: None,
        },
    );
    renderer.end_page();

    let output = renderer.output();
    assert!(
        output.matches("stroke-dasharray=").count() >= 2,
        "parallel double-line strokes should keep dash arrays:\n{output}"
    );
    assert!(
        output.contains("marker-start=\"url(#"),
        "start arrow marker should be attached to the central marker line:\n{output}"
    );
    assert!(
        output.contains("marker-end=\"url(#"),
        "end arrow marker should be attached to the central marker line:\n{output}"
    );
    assert!(
        output.contains("stroke-opacity=\"0\""),
        "central marker carrier should not add an extra visible stroke:\n{output}"
    );
}

#[test]
fn test_layer_svg_vertical_text_uses_explicit_rotation_only() {
    let bbox = BoundingBox::new(10.0, 15.0, 40.0, 20.0);
    let root = LayerNode::leaf(
        bbox,
        Some(1),
        vec![PaintOp::TextRun {
            bbox,
            run: LayerTextRunPaint {
                source: None,
                text: "세로".to_string(),
                style: TextStyle {
                    font_size: 14.0,
                    ..Default::default()
                },
                positions: vec![0.0, 14.0, 28.0],
                control_marks: Vec::new(),
                baseline: 16.0,
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
    );
    let tree = PageLayerTree::new(80.0, 60.0, root);
    let mut renderer = SvgRenderer::new();
    renderer.render_layer_tree(&tree);

    let output = renderer.output();
    assert!(
        output.contains("<g transform=\"rotate(90,30,25)\">"),
        "vertical layer text should use the layout-provided rotation around its bbox center:\n{output}"
    );
    assert!(
        !output.contains("rotate(180"),
        "vertical layer text should not add another 90 degrees on top of run.rotation:\n{output}"
    );
    assert!(output.contains(">세</text>"));
    assert!(output.contains(">로</text>"));
}

#[test]
fn test_svg_layer_page_background_image_uses_fill_mode_and_effect() {
    let mut resources = ResourceArena::default();
    let resource_id = resources.intern_image_bytes(FIXTURE_PNG_1X1);
    let root = LayerNode::leaf(
        BoundingBox::new(0.0, 0.0, 80.0, 60.0),
        None,
        vec![PaintOp::PageBackground {
            bbox: BoundingBox::new(0.0, 0.0, 80.0, 60.0),
            background: LayerPageBackgroundPaint {
                background_color: None,
                border_color: None,
                border_width: 0.0,
                gradient: None,
                image: Some(LayerPageBackgroundImagePaint {
                    resource_id,
                    fill_mode: ImageFillMode::TileAll,
                    brightness: 0,
                    contrast: 0,
                    effect: crate::model::image::ImageEffect::GrayScale,
                }),
            },
        }],
    );
    let tree = PageLayerTree::with_resources(80.0, 60.0, root, resources);
    let mut renderer = SvgRenderer::new();
    renderer.render_layer_tree(&tree);

    let output = renderer.output();
    assert!(
        output.contains("filter=\"url(#rhwp-img-grayscale)\""),
        "page background image effect should wrap the rendered image:\n{output}"
    );
    assert!(
        output.contains("<pattern id=\"tile-pat-"),
        "page background fillMode should use the layer image tiling path:\n{output}"
    );
}

#[test]
fn test_layer_svg_strict_glyph_outline_replaces_text_fallback() {
    let text_style = TextStyle {
        font_size: 12.0,
        ..Default::default()
    };
    let tree = glyph_outline_fixture_tree(
        PaintTextStyle::from(&text_style),
        vec![glyph_outline_fixture_path()],
    );
    if let crate::paint::LayerNodeKind::Leaf { ops, .. } = &tree.root.kind {
        let PaintOp::TextRun { run, .. } = &ops[0] else {
            panic!("expected text run");
        };
        assert_eq!(run.variant.as_ref().unwrap().variant_id, "textRun");
        assert_eq!(run.variant.as_ref().unwrap().equivalence_group, "text-0");
    }

    let mut default_renderer = SvgRenderer::new();
    default_renderer.render_layer_tree(&tree);
    let default_output = default_renderer.output();
    assert!(default_output.contains(">A</text>"));
    assert!(!default_output.contains("data-rhwp-variant-id=\"glyphOutline\""));
    let default_report = default_renderer
        .text_variant_selection_diagnostics()
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("svg default variant report");
    assert_eq!(default_report.backend, VariantSelectionBackend::Svg);
    assert_eq!(default_report.selected_variant_id, "textRun");
    assert_eq!(
        default_report.selected_reason,
        VariantSelectedReason::DefaultTextRunFallback
    );
    assert_eq!(default_report.parts_expected, 1);
    assert_eq!(default_report.parts_replayed, 1);
    assert_eq!(default_report.parts.len(), 2);
    assert!(default_report
        .parts
        .iter()
        .any(|part| { part.variant_id == "textRun" && part.replayable && part.reason.is_none() }));
    assert!(default_report.parts.iter().any(|part| {
        part.variant_id == "glyphOutline"
            && !part.replayable
            && part.reason == Some(VariantRejectReason::BackendDoesNotSupportVariant)
    }));
    assert!(default_report.rejected_variants.iter().any(|variant| {
        variant.variant_id == "glyphOutline"
            && variant
                .reasons
                .contains(&VariantRejectReason::BackendDoesNotSupportVariant)
    }));

    let mut strict_renderer = SvgRenderer::new();
    strict_renderer.set_strict_glyph_outline_replay(true);
    strict_renderer.render_layer_tree(&tree);
    let strict_output = strict_renderer.output();
    assert!(!strict_output.contains(">A</text>"));
    assert!(strict_output.contains("id=\"rhwp-text-sources\""));
    assert!(strict_output.contains("&quot;textSources&quot;"));
    assert!(strict_output.contains("&quot;stableSourceKey&quot;"));
    assert!(strict_output.contains("&quot;fixture-source&quot;"));
    assert!(strict_output.contains("<path d=\"M0 0 L8 0 L8 8 Z\""));
    assert!(strict_output.contains("fill-rule=\"evenodd\""));
    assert!(strict_output.contains("data-rhwp-glyph-id=\"42\""));
    assert!(strict_output.contains("data-rhwp-glyph-start=\"0\""));
    assert!(strict_output.contains("data-rhwp-glyph-end=\"1\""));
    assert!(strict_output.contains("data-rhwp-source-id=\"7\""));
    assert!(strict_output.contains("data-rhwp-source-utf8-start=\"0\""));
    assert!(strict_output.contains("data-rhwp-source-utf8-end=\"1\""));
    assert!(strict_output.contains("data-rhwp-variant-id=\"glyphOutline\""));
    assert!(strict_output.contains("matrix(1 0 0 1 3 4)"));
    let strict_report = strict_renderer
        .text_variant_selection_diagnostics()
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("svg strict variant report");
    assert_eq!(strict_report.selected_variant_id, "glyphOutline");
    assert_eq!(
        strict_report.selected_reason,
        VariantSelectedReason::GlyphOutlineStrictProfile
    );
    assert_eq!(
        strict_report.selected_variant_kind,
        TextVariantKind::GlyphOutline
    );
    assert_eq!(strict_report.anchor_op_id.as_deref(), Some("op-text-0"));
    assert_eq!(strict_report.parts_expected, 1);
    assert_eq!(strict_report.parts_replayed, 1);
    assert!(strict_report.rejected_variants.is_empty());
    assert_eq!(strict_report.parts.len(), 2);
    assert!(strict_report.parts.iter().any(|part| {
        part.variant_id == "glyphOutline"
            && part.variant_kind == TextVariantKind::GlyphOutline
            && part.part_index == 0
            && part.part_count == 1
            && part.replayable
            && part.reason.is_none()
            && part
                .outline_eligibility
                .as_ref()
                .is_some_and(|eligibility| eligibility.replay_eligible)
    }));
    assert!(strict_report
        .outline_eligibility
        .as_ref()
        .is_some_and(|eligibility| eligibility.replay_eligible));
}

#[test]
fn test_layer_svg_strict_glyph_outline_replays_sidecar_variant_ops() {
    let text_style = TextStyle {
        font_size: 12.0,
        ..Default::default()
    };
    let mut tree = glyph_outline_fixture_tree(
        PaintTextStyle::from(&text_style),
        vec![glyph_outline_fixture_path()],
    );
    let sidecar_outline = if let crate::paint::LayerNodeKind::Leaf { ops, .. } = &mut tree.root.kind
    {
        assert_eq!(ops.len(), 2);
        ops.remove(1)
    } else {
        panic!("expected leaf root");
    };
    tree.variant_ops = vec![sidecar_outline];

    let mut default_renderer = SvgRenderer::new();
    default_renderer.render_layer_tree(&tree);
    let default_output = default_renderer.output();
    assert!(default_output.contains(">A</text>"));
    assert!(!default_output.contains("data-rhwp-variant-id=\"glyphOutline\""));
    let default_report = default_renderer
        .text_variant_selection_diagnostics()
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("svg default sidecar variant report");
    assert_eq!(default_report.selected_variant_id, "textRun");
    assert_eq!(default_report.parts.len(), 2);
    assert!(default_report.parts.iter().any(|part| {
        part.variant_id == "glyphOutline"
            && !part.replayable
            && part.reason == Some(VariantRejectReason::BackendDoesNotSupportVariant)
    }));

    let mut strict_renderer = SvgRenderer::new();
    strict_renderer.set_strict_glyph_outline_replay(true);
    strict_renderer.render_layer_tree(&tree);
    let strict_output = strict_renderer.output();
    assert!(!strict_output.contains(">A</text>"));
    assert!(strict_output.contains("<path d=\"M0 0 L8 0 L8 8 Z\""));
    assert!(strict_output.contains("data-rhwp-variant-id=\"glyphOutline\""));
    assert!(strict_output.contains("data-rhwp-glyph-id=\"42\""));
    assert!(strict_output.contains("matrix(1 0 0 1 3 4)"));

    let strict_report = strict_renderer
        .text_variant_selection_diagnostics()
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("svg strict sidecar variant report");
    assert_eq!(strict_report.selected_variant_id, "glyphOutline");
    assert_eq!(
        strict_report.selected_reason,
        VariantSelectedReason::GlyphOutlineStrictProfile
    );
    assert_eq!(strict_report.anchor_op_id.as_deref(), Some("op-text-0"));
    assert_eq!(strict_report.parts_expected, 1);
    assert_eq!(strict_report.parts_replayed, 1);
    assert!(strict_report.rejected_variants.is_empty());
    assert!(strict_report.parts.iter().any(|part| {
        part.variant_id == "glyphOutline"
            && part.variant_kind == TextVariantKind::GlyphOutline
            && part.replayable
            && part.reason.is_none()
            && part
                .outline_eligibility
                .as_ref()
                .is_some_and(|eligibility| eligibility.replay_eligible)
    }));
}

#[test]
fn test_layer_svg_strict_glyph_outline_rejects_unsupported_payload_and_style() {
    let text_style = TextStyle {
        font_size: 12.0,
        ..Default::default()
    };
    let empty_payload_tree = glyph_outline_fixture_tree(PaintTextStyle::from(&text_style), vec![]);
    let mut empty_payload_renderer = SvgRenderer::new();
    empty_payload_renderer.set_strict_glyph_outline_replay(true);
    empty_payload_renderer.render_layer_tree(&empty_payload_tree);
    let empty_payload_output = empty_payload_renderer.output();
    assert!(empty_payload_output.contains(">A</text>"));
    assert!(!empty_payload_output.contains("data-rhwp-variant-id=\"glyphOutline\""));
    let empty_payload_report = empty_payload_renderer
        .text_variant_selection_diagnostics()
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("svg strict empty outline report");
    assert_eq!(empty_payload_report.selected_variant_id, "textRun");
    assert_eq!(
        empty_payload_report.selected_reason,
        VariantSelectedReason::DefaultTextRunFallback
    );
    assert!(empty_payload_report
        .rejected_variants
        .iter()
        .any(|variant| {
            variant.variant_id == "glyphOutline"
                && variant
                    .reasons
                    .contains(&VariantRejectReason::EmptyGlyphOutlinePayload)
        }));
    assert!(empty_payload_report
        .outline_eligibility
        .as_ref()
        .is_some_and(|eligibility| {
            !eligibility.payload_supported
                && !eligibility.replay_eligible
                && eligibility.reason == Some(VariantRejectReason::EmptyGlyphOutlinePayload)
        }));

    let mut unsupported_style = PaintTextStyle::from(&text_style);
    unsupported_style.underline = crate::model::style::UnderlineType::Bottom;
    let unsupported_style_tree =
        glyph_outline_fixture_tree(unsupported_style, vec![glyph_outline_fixture_path()]);
    let mut unsupported_style_renderer = SvgRenderer::new();
    unsupported_style_renderer.set_strict_glyph_outline_replay(true);
    unsupported_style_renderer.render_layer_tree(&unsupported_style_tree);
    let unsupported_style_output = unsupported_style_renderer.output();
    assert!(unsupported_style_output.contains(">A</text>"));
    assert!(!unsupported_style_output.contains("data-rhwp-variant-id=\"glyphOutline\""));
    let unsupported_style_report = unsupported_style_renderer
        .text_variant_selection_diagnostics()
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("svg strict unsupported style report");
    assert_eq!(unsupported_style_report.selected_variant_id, "textRun");
    assert!(unsupported_style_report
        .rejected_variants
        .iter()
        .any(|variant| {
            variant.variant_id == "glyphOutline"
                && variant
                    .reasons
                    .contains(&VariantRejectReason::UnsupportedPaintEffect)
        }));
    assert!(unsupported_style_report
        .outline_eligibility
        .as_ref()
        .is_some_and(|eligibility| {
            eligibility.payload_supported
                && !eligibility.paint_style_supported
                && !eligibility.replay_eligible
                && eligibility.reason == Some(VariantRejectReason::UnsupportedPaintEffect)
        }));

    let mut unsupported_outline_effect = PaintTextStyle::from(&text_style);
    unsupported_outline_effect.outline_type = 1;
    let unsupported_outline_effect_tree = glyph_outline_fixture_tree(
        unsupported_outline_effect,
        vec![glyph_outline_fixture_path()],
    );
    let mut unsupported_outline_effect_renderer = SvgRenderer::new();
    unsupported_outline_effect_renderer.set_strict_glyph_outline_replay(true);
    unsupported_outline_effect_renderer.render_layer_tree(&unsupported_outline_effect_tree);
    let unsupported_outline_effect_output = unsupported_outline_effect_renderer.output();
    assert!(unsupported_outline_effect_output.contains(">A</text>"));
    assert!(!unsupported_outline_effect_output.contains("data-rhwp-variant-id=\"glyphOutline\""));
    let unsupported_outline_effect_report = unsupported_outline_effect_renderer
        .text_variant_selection_diagnostics()
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("svg strict unsupported outline effect report");
    assert_eq!(
        unsupported_outline_effect_report.selected_variant_id,
        "textRun"
    );
    assert!(unsupported_outline_effect_report
        .rejected_variants
        .iter()
        .any(|variant| {
            variant.variant_id == "glyphOutline"
                && variant
                    .reasons
                    .contains(&VariantRejectReason::UnsupportedPaintEffect)
        }));
    assert!(unsupported_outline_effect_report
        .outline_eligibility
        .as_ref()
        .is_some_and(|eligibility| {
            eligibility.payload_supported
                && !eligibility.paint_style_supported
                && !eligibility.replay_eligible
                && eligibility.reason == Some(VariantRejectReason::UnsupportedPaintEffect)
        }));

    let stroke_payload_tree = glyph_outline_fixture_tree_with_payload(
        PaintTextStyle::from(&text_style),
        GlyphOutlinePayloadKind::MonochromeFillStroke,
        Some(GlyphOutlineStrokeStyle {
            color: 0x000000,
            width_px: 1.0,
            join: GlyphOutlineStrokeJoin::Miter,
            cap: GlyphOutlineStrokeCap::Butt,
            miter_limit: Some(4.0),
            paint_order: GlyphOutlinePaintOrder::FillThenStroke,
        }),
        vec![glyph_outline_fixture_path()],
    );
    let mut stroke_payload_renderer = SvgRenderer::new();
    stroke_payload_renderer.set_strict_glyph_outline_replay(true);
    stroke_payload_renderer.render_layer_tree(&stroke_payload_tree);
    let stroke_payload_output = stroke_payload_renderer.output();
    assert!(!stroke_payload_output.contains(">A</text>"));
    assert!(stroke_payload_output.contains("data-rhwp-variant-id=\"glyphOutline\""));
    assert!(stroke_payload_output.contains("stroke=\"#000000\""));
    assert!(stroke_payload_output.contains("stroke-width=\"1\""));
    assert!(stroke_payload_output.contains("stroke-linejoin=\"miter\""));
    assert!(stroke_payload_output.contains("stroke-linecap=\"butt\""));
    assert!(stroke_payload_output.contains("stroke-miterlimit=\"4\""));
    let stroke_payload_report = stroke_payload_renderer
        .text_variant_selection_diagnostics()
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("svg strict stroke payload report");
    assert_eq!(stroke_payload_report.selected_variant_id, "glyphOutline");
    assert!(stroke_payload_report.rejected_variants.is_empty());
    assert!(stroke_payload_report
        .outline_eligibility
        .as_ref()
        .is_some_and(|eligibility| {
            eligibility.payload_supported
                && eligibility.replay_eligible
                && eligibility.reason.is_none()
        }));

    let unsupported_stroke_tree = glyph_outline_fixture_tree_with_payload(
        PaintTextStyle::from(&text_style),
        GlyphOutlinePayloadKind::MonochromeFillStroke,
        Some(GlyphOutlineStrokeStyle {
            color: 0x000000,
            width_px: 0.0,
            join: GlyphOutlineStrokeJoin::Miter,
            cap: GlyphOutlineStrokeCap::Butt,
            miter_limit: Some(4.0),
            paint_order: GlyphOutlinePaintOrder::FillThenStroke,
        }),
        vec![glyph_outline_fixture_path()],
    );
    let mut unsupported_stroke_renderer = SvgRenderer::new();
    unsupported_stroke_renderer.set_strict_glyph_outline_replay(true);
    unsupported_stroke_renderer.render_layer_tree(&unsupported_stroke_tree);
    let unsupported_stroke_output = unsupported_stroke_renderer.output();
    assert!(unsupported_stroke_output.contains(">A</text>"));
    assert!(!unsupported_stroke_output.contains("data-rhwp-variant-id=\"glyphOutline\""));
    let unsupported_stroke_report = unsupported_stroke_renderer
        .text_variant_selection_diagnostics()
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("svg strict unsupported stroke report");
    assert_eq!(unsupported_stroke_report.selected_variant_id, "textRun");
    assert!(unsupported_stroke_report
        .rejected_variants
        .iter()
        .any(|variant| {
            variant.variant_id == "glyphOutline"
                && variant
                    .reasons
                    .contains(&VariantRejectReason::GlyphOutlineStrokeStyleUnsupported)
        }));
    assert!(unsupported_stroke_report
        .outline_eligibility
        .as_ref()
        .is_some_and(|eligibility| {
            !eligibility.payload_supported
                && !eligibility.replay_eligible
                && eligibility.reason
                    == Some(VariantRejectReason::GlyphOutlineStrokeStyleUnsupported)
        }));
}

#[test]
fn test_layer_svg_strict_glyph_outline_rejects_invalid_path_payload() {
    let text_style = TextStyle {
        font_size: 12.0,
        ..Default::default()
    };

    let assert_rejected_path_payload = |paths: Vec<LayerGlyphOutlinePath>, label: &str| {
        let tree = glyph_outline_fixture_tree(PaintTextStyle::from(&text_style), paths);
        let mut renderer = SvgRenderer::new();
        renderer.set_strict_glyph_outline_replay(true);
        renderer.render_layer_tree(&tree);

        let output = renderer.output();
        assert!(output.contains(">A</text>"), "{label}");
        assert!(
            !output.contains("data-rhwp-variant-id=\"glyphOutline\""),
            "{label}"
        );
        let report = renderer
            .text_variant_selection_diagnostics()
            .iter()
            .find(|report| report.equivalence_group == "text-0")
            .unwrap_or_else(|| panic!("svg strict invalid path payload report: {label}"));
        assert_eq!(report.selected_variant_id, "textRun", "{label}");
        assert!(report.rejected_variants.iter().any(|variant| {
            variant.variant_id == "glyphOutline"
                && variant
                    .reasons
                    .contains(&VariantRejectReason::UnsupportedOutlinePayload)
        }));
        assert!(report
            .outline_eligibility
            .as_ref()
            .is_some_and(|eligibility| {
                !eligibility.payload_supported
                    && !eligibility.replay_eligible
                    && eligibility.reason == Some(VariantRejectReason::UnsupportedOutlinePayload)
            }));
    };

    let mut reversed_source_range = glyph_outline_fixture_path();
    reversed_source_range.source_range_utf8 = TextSourceRange::new(2, 1);
    assert_rejected_path_payload(vec![reversed_source_range], "reversed source range");

    let mut reversed_glyph_range = glyph_outline_fixture_path();
    reversed_glyph_range.glyph_range = crate::paint::GlyphRange { start: 2, end: 1 };
    assert_rejected_path_payload(vec![reversed_glyph_range], "reversed glyph range");

    let mut non_finite_command = glyph_outline_fixture_path();
    non_finite_command.commands[1] = PathCommand::LineTo(f64::INFINITY, 0.0);
    assert_rejected_path_payload(vec![non_finite_command], "non-finite path command");
}

#[test]
fn test_layer_svg_strict_glyph_outline_replays_colrv0_color_layers() {
    let text_style = TextStyle {
        font_size: 12.0,
        ..Default::default()
    };
    let tree = glyph_outline_fixture_tree_with_color_layers(
        PaintTextStyle::from(&text_style),
        color_layers_fixture_payload(true, ColorGlyphFormat::ColrV0),
    );
    let mut renderer = SvgRenderer::new();
    renderer.set_strict_glyph_outline_replay(true);
    renderer.render_layer_tree(&tree);
    let output = renderer.output();
    assert!(!output.contains(">A</text>"));
    assert!(output.contains("<path d=\"M0 0 L8 0 L8 8 Z\""));
    assert!(output.contains("fill=\"#0000ff\""));
    assert!(output.contains("fill-rule=\"nonzero\""));
    assert!(output.contains("data-rhwp-color-layer-index=\"0\""));
    assert!(output.contains("data-rhwp-palette-index=\"3\""));
    assert!(output.contains("data-rhwp-source-font-face-key=\"fixture-face\""));
    assert!(output.contains("source-backed COLRv0 glyph color layer"));
    let report = renderer
        .text_variant_selection_diagnostics()
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("svg strict color layer report");
    assert_eq!(report.selected_variant_id, "glyphOutline");
    assert!(report.rejected_variants.is_empty());
    assert!(report
        .outline_eligibility
        .as_ref()
        .is_some_and(|eligibility| {
            eligibility.payload_supported
                && eligibility.replay_eligible
                && eligibility.reason.is_none()
        }));
}

#[test]
fn test_layer_svg_strict_glyph_outline_replays_colrv1_stage1_graph() {
    let text_style = TextStyle {
        font_size: 12.0,
        ..Default::default()
    };
    let source_font_ref = FontColorGlyphRef {
        face_key: Some("fixture-face".to_string()),
        glyph_id: Some(42),
        palette_index: Some(3),
        color_format: Some(ColorGlyphFormat::ColrV1),
    };
    let tree = glyph_outline_fixture_tree_with_color_layers(
        PaintTextStyle::from(&text_style),
        ColorLayersPayload {
            color_format: ColorGlyphFormat::ColrV1,
            source_font_ref: Some(source_font_ref.clone()),
            palette_ref: Some(PaletteRef {
                id: Some("fixture-palette".to_string()),
                index: Some(0),
                cpal_digest: Some("blake3:fixture-cpal".to_string()),
            }),
            source_range_utf8: Some(TextSourceRange::new(0, 1)),
            glyph_range: Some(GlyphRange { start: 0, end: 1 }),
            layers: Vec::new(),
            paint_graph: Some(ColorPaintGraphPayload {
                root_node_id: 1,
                nodes: vec![
                    ColorPaintGraphNode {
                        node_id: 0,
                        kind: ColorPaintGraphNodeKind::SolidPath,
                        solid_path: Some(ColorPaintSolidPathNode {
                            commands: vec![
                                PathCommand::MoveTo(0.0, 0.0),
                                PathCommand::LineTo(8.0, 0.0),
                                PathCommand::LineTo(8.0, 8.0),
                                PathCommand::ClosePath,
                            ],
                            fill: ResolvedColor {
                                color_space: Some("srgb".to_string()),
                                rgba: [0.0, 1.0, 0.0, 1.0],
                            },
                            fill_rule: GlyphOutlineFillRule::NonZero,
                            source_glyph_id: Some(42),
                            palette_index: Some(3),
                        }),
                        linear_gradient_path: None,
                        radial_gradient_path: None,
                        sweep_gradient_path: None,
                        transform: None,
                        composite: None,
                        clip: None,
                        source_range_utf8: Some(TextSourceRange::new(0, 1)),
                        glyph_range: Some(GlyphRange { start: 0, end: 1 }),
                        source_font_ref: Some(source_font_ref),
                    },
                    ColorPaintGraphNode {
                        node_id: 1,
                        kind: ColorPaintGraphNodeKind::Transform,
                        solid_path: None,
                        linear_gradient_path: None,
                        radial_gradient_path: None,
                        sweep_gradient_path: None,
                        transform: Some(ColorPaintTransformNode {
                            child_node_id: 0,
                            transform: LayerAffineTransform {
                                a: 1.0,
                                b: 0.0,
                                c: 0.0,
                                d: 1.0,
                                e: 5.0,
                                f: 0.0,
                            },
                        }),
                        composite: None,
                        clip: None,
                        source_range_utf8: None,
                        glyph_range: None,
                        source_font_ref: None,
                    },
                ],
            }),
        },
    );
    let mut renderer = SvgRenderer::new();
    renderer.set_strict_glyph_outline_replay(true);
    renderer.render_layer_tree(&tree);
    let output = renderer.output();
    assert!(!output.contains(">A</text>"));
    assert!(output.contains("<path d=\"M0 0 L8 0 L8 8 Z\""));
    assert!(output.contains("fill=\"#00ff00\""));
    assert!(output.contains("transform=\"matrix(1 0 0 1 5 0)\""));
    assert!(output.contains("data-rhwp-color-format=\"colrV1\""));
    assert!(output.contains("data-rhwp-color-graph-node-kind=\"solidPath\""));
    assert!(output.contains("source-backed COLRv1 glyph color graph solid path"));
    let report = renderer
        .text_variant_selection_diagnostics()
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("svg strict COLRv1 stage-1 color graph report");
    assert_eq!(report.selected_variant_id, "glyphOutline");
    assert!(report.rejected_variants.is_empty());
    assert!(report
        .outline_eligibility
        .as_ref()
        .is_some_and(|eligibility| {
            eligibility.payload_supported
                && eligibility.replay_eligible
                && eligibility.reason.is_none()
        }));
}

#[test]
fn test_layer_svg_strict_glyph_outline_replays_colrv1_gradient_graph_leaves() {
    let text_style = TextStyle {
        font_size: 12.0,
        ..Default::default()
    };
    let source_font_ref = FontColorGlyphRef {
        face_key: Some("fixture-face".to_string()),
        glyph_id: Some(42),
        palette_index: Some(3),
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
                rgba: [0.0, 0.0, 1.0, 0.5],
            },
        },
    ];
    let make_tree = |node: ColorPaintGraphNode| {
        glyph_outline_fixture_tree_with_color_layers(
            PaintTextStyle::from(&text_style),
            ColorLayersPayload {
                color_format: ColorGlyphFormat::ColrV1,
                source_font_ref: Some(source_font_ref.clone()),
                palette_ref: Some(PaletteRef {
                    id: Some("fixture-palette".to_string()),
                    index: Some(0),
                    cpal_digest: Some("blake3:fixture-cpal".to_string()),
                }),
                source_range_utf8: Some(TextSourceRange::new(0, 1)),
                glyph_range: Some(GlyphRange { start: 0, end: 1 }),
                layers: Vec::new(),
                paint_graph: Some(ColorPaintGraphPayload {
                    root_node_id: 0,
                    nodes: vec![node],
                }),
            },
        )
    };
    let linear_tree = make_tree(ColorPaintGraphNode {
        node_id: 0,
        kind: ColorPaintGraphNodeKind::LinearGradientPath,
        solid_path: None,
        linear_gradient_path: Some(ColorPaintLinearGradientPathNode {
            commands: vec![
                PathCommand::MoveTo(0.0, 0.0),
                PathCommand::LineTo(8.0, 0.0),
                PathCommand::LineTo(8.0, 8.0),
                PathCommand::ClosePath,
            ],
            gradient: ColorLinearGradient {
                x0: 0.0,
                y0: 0.0,
                x1: 8.0,
                y1: 0.0,
                stops: color_stops.clone(),
            },
            fill_rule: GlyphOutlineFillRule::NonZero,
            source_glyph_id: Some(42),
            palette_index: Some(3),
        }),
        radial_gradient_path: None,
        sweep_gradient_path: None,
        transform: None,
        composite: None,
        clip: None,
        source_range_utf8: Some(TextSourceRange::new(0, 1)),
        glyph_range: Some(GlyphRange { start: 0, end: 1 }),
        source_font_ref: Some(source_font_ref.clone()),
    });
    let radial_tree = make_tree(ColorPaintGraphNode {
        node_id: 0,
        kind: ColorPaintGraphNodeKind::RadialGradientPath,
        solid_path: None,
        linear_gradient_path: None,
        radial_gradient_path: Some(ColorPaintRadialGradientPathNode {
            commands: vec![
                PathCommand::MoveTo(0.0, 0.0),
                PathCommand::LineTo(8.0, 0.0),
                PathCommand::LineTo(8.0, 8.0),
                PathCommand::ClosePath,
            ],
            gradient: ColorRadialGradient {
                cx: 4.0,
                cy: 4.0,
                radius: 4.0,
                stops: color_stops,
            },
            fill_rule: GlyphOutlineFillRule::EvenOdd,
            source_glyph_id: Some(42),
            palette_index: Some(3),
        }),
        sweep_gradient_path: None,
        transform: None,
        composite: None,
        clip: None,
        source_range_utf8: Some(TextSourceRange::new(0, 1)),
        glyph_range: Some(GlyphRange { start: 0, end: 1 }),
        source_font_ref: Some(source_font_ref.clone()),
    });

    let mut linear_renderer = SvgRenderer::new();
    linear_renderer.set_strict_glyph_outline_replay(true);
    linear_renderer.render_layer_tree(&linear_tree);
    let linear_output = linear_renderer.output();
    assert!(!linear_output.contains(">A</text>"));
    assert!(linear_output.contains("<linearGradient id=\"grad1\" gradientUnits=\"userSpaceOnUse\" x1=\"0\" y1=\"0\" x2=\"8\" y2=\"0\""));
    assert!(linear_output.contains("<stop offset=\"0\" stop-color=\"#ff0000\""));
    assert!(
        linear_output.contains("<stop offset=\"1\" stop-color=\"#0000ff\" stop-opacity=\"0.5\"")
    );
    assert!(linear_output.contains("fill=\"url(#grad1)\""));
    assert!(linear_output.contains("data-rhwp-color-graph-node-kind=\"linearGradientPath\""));
    assert!(linear_output.contains("source-backed COLRv1 glyph color graph linear gradient path"));

    let mut radial_renderer = SvgRenderer::new();
    radial_renderer.set_strict_glyph_outline_replay(true);
    radial_renderer.render_layer_tree(&radial_tree);
    let radial_output = radial_renderer.output();
    assert!(!radial_output.contains(">A</text>"));
    assert!(radial_output.contains(
        "<radialGradient id=\"grad1\" gradientUnits=\"userSpaceOnUse\" cx=\"4\" cy=\"4\" r=\"4\""
    ));
    assert!(radial_output.contains("fill=\"url(#grad1)\""));
    assert!(radial_output.contains("fill-rule=\"evenodd\""));
    assert!(radial_output.contains("data-rhwp-color-graph-node-kind=\"radialGradientPath\""));
    assert!(radial_output.contains("source-backed COLRv1 glyph color graph radial gradient path"));
}

#[test]
fn test_layer_svg_strict_glyph_outline_replays_colrv1_source_over_composite_graph() {
    let text_style = TextStyle {
        font_size: 12.0,
        ..Default::default()
    };
    let source_font_ref = FontColorGlyphRef {
        face_key: Some("fixture-face".to_string()),
        glyph_id: Some(42),
        palette_index: Some(3),
        color_format: Some(ColorGlyphFormat::ColrV1),
    };
    let solid_node = |node_id: u32, color: [f32; 4], x0: f64, x1: f64| ColorPaintGraphNode {
        node_id,
        kind: ColorPaintGraphNodeKind::SolidPath,
        solid_path: Some(ColorPaintSolidPathNode {
            commands: vec![
                PathCommand::MoveTo(x0, 0.0),
                PathCommand::LineTo(x1, 0.0),
                PathCommand::LineTo(x1, 8.0),
                PathCommand::LineTo(x0, 8.0),
                PathCommand::ClosePath,
            ],
            fill: ResolvedColor {
                color_space: Some("srgb".to_string()),
                rgba: color,
            },
            fill_rule: GlyphOutlineFillRule::NonZero,
            source_glyph_id: Some(42 + node_id),
            palette_index: Some(3),
        }),
        linear_gradient_path: None,
        radial_gradient_path: None,
        sweep_gradient_path: None,
        transform: None,
        composite: None,
        clip: None,
        source_range_utf8: Some(TextSourceRange::new(node_id, node_id + 1)),
        glyph_range: Some(GlyphRange {
            start: node_id,
            end: node_id + 1,
        }),
        source_font_ref: Some(source_font_ref.clone()),
    };
    let tree = glyph_outline_fixture_tree_with_color_layers(
        PaintTextStyle::from(&text_style),
        ColorLayersPayload {
            color_format: ColorGlyphFormat::ColrV1,
            source_font_ref: Some(source_font_ref.clone()),
            palette_ref: None,
            source_range_utf8: Some(TextSourceRange::new(0, 2)),
            glyph_range: Some(GlyphRange { start: 0, end: 2 }),
            layers: Vec::new(),
            paint_graph: Some(ColorPaintGraphPayload {
                root_node_id: 9,
                nodes: vec![
                    solid_node(1, [0.0, 0.0, 1.0, 1.0], 0.0, 8.0),
                    solid_node(2, [1.0, 0.0, 0.0, 1.0], 4.0, 12.0),
                    ColorPaintGraphNode {
                        node_id: 9,
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
        },
    );
    let mut renderer = SvgRenderer::new();
    renderer.set_strict_glyph_outline_replay(true);
    renderer.render_layer_tree(&tree);
    let output = renderer.output();
    assert!(!output.contains(">A</text>"));
    let blue_index = output
        .find("fill=\"#0000ff\"")
        .expect("source-over backdrop path");
    let red_index = output
        .find("fill=\"#ff0000\"")
        .expect("source-over source path");
    assert!(
        blue_index < red_index,
        "source-over SVG lowering must emit backdrop before source"
    );
    assert!(output.contains("data-rhwp-color-graph-node-kind=\"solidPath\""));
}

#[test]
fn test_layer_svg_strict_glyph_outline_replays_colrv1_clip_graph() {
    let text_style = TextStyle {
        font_size: 12.0,
        ..Default::default()
    };
    let source_font_ref = FontColorGlyphRef {
        face_key: Some("fixture-face".to_string()),
        glyph_id: Some(42),
        palette_index: Some(3),
        color_format: Some(ColorGlyphFormat::ColrV1),
    };
    let tree = glyph_outline_fixture_tree_with_color_layers(
        PaintTextStyle::from(&text_style),
        ColorLayersPayload {
            color_format: ColorGlyphFormat::ColrV1,
            source_font_ref: Some(source_font_ref.clone()),
            palette_ref: None,
            source_range_utf8: Some(TextSourceRange::new(0, 1)),
            glyph_range: Some(GlyphRange { start: 0, end: 1 }),
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
                                PathCommand::LineTo(12.0, 8.0),
                                PathCommand::LineTo(0.0, 8.0),
                                PathCommand::ClosePath,
                            ],
                            fill: ResolvedColor {
                                color_space: Some("srgb".to_string()),
                                rgba: [1.0, 0.0, 0.0, 1.0],
                            },
                            fill_rule: GlyphOutlineFillRule::NonZero,
                            source_glyph_id: Some(42),
                            palette_index: Some(3),
                        }),
                        linear_gradient_path: None,
                        radial_gradient_path: None,
                        sweep_gradient_path: None,
                        transform: None,
                        composite: None,
                        clip: None,
                        source_range_utf8: Some(TextSourceRange::new(0, 1)),
                        glyph_range: Some(GlyphRange { start: 0, end: 1 }),
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
                                PathCommand::MoveTo(0.0, 0.0),
                                PathCommand::LineTo(6.0, 0.0),
                                PathCommand::LineTo(6.0, 8.0),
                                PathCommand::LineTo(0.0, 8.0),
                                PathCommand::ClosePath,
                            ],
                            fill_rule: GlyphOutlineFillRule::EvenOdd,
                        }),
                        source_range_utf8: None,
                        glyph_range: None,
                        source_font_ref: None,
                    },
                ],
            }),
        },
    );
    let mut renderer = SvgRenderer::new();
    renderer.set_strict_glyph_outline_replay(true);
    renderer.render_layer_tree(&tree);
    let output = renderer.output();

    assert!(!output.contains(">A</text>"));
    assert!(output.contains("<clipPath id=\"colrv1-clip-"));
    assert!(output.contains("clip-rule=\"evenodd\""));
    assert!(output.contains("<g clip-path=\"url(#colrv1-clip-"));
    assert!(output.contains("source-backed COLRv1 glyph color graph solid path"));
}

#[test]
fn test_layer_svg_strict_glyph_outline_rejects_invalid_colrv1_gradient_graph() {
    let text_style = TextStyle {
        font_size: 12.0,
        ..Default::default()
    };
    let source_font_ref = FontColorGlyphRef {
        face_key: Some("fixture-face".to_string()),
        glyph_id: Some(42),
        palette_index: Some(3),
        color_format: Some(ColorGlyphFormat::ColrV1),
    };
    let tree = glyph_outline_fixture_tree_with_color_layers(
        PaintTextStyle::from(&text_style),
        ColorLayersPayload {
            color_format: ColorGlyphFormat::ColrV1,
            source_font_ref: Some(source_font_ref.clone()),
            palette_ref: Some(PaletteRef {
                id: Some("fixture-palette".to_string()),
                index: Some(0),
                cpal_digest: Some("blake3:fixture-cpal".to_string()),
            }),
            source_range_utf8: Some(TextSourceRange::new(0, 1)),
            glyph_range: Some(GlyphRange { start: 0, end: 1 }),
            layers: Vec::new(),
            paint_graph: Some(ColorPaintGraphPayload {
                root_node_id: 0,
                nodes: vec![ColorPaintGraphNode {
                    node_id: 0,
                    kind: ColorPaintGraphNodeKind::LinearGradientPath,
                    solid_path: None,
                    linear_gradient_path: Some(ColorPaintLinearGradientPathNode {
                        commands: vec![
                            PathCommand::MoveTo(0.0, 0.0),
                            PathCommand::LineTo(8.0, 0.0),
                            PathCommand::LineTo(8.0, 8.0),
                            PathCommand::ClosePath,
                        ],
                        gradient: ColorLinearGradient {
                            x0: 0.0,
                            y0: 0.0,
                            x1: 8.0,
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
                        source_glyph_id: Some(42),
                        palette_index: Some(3),
                    }),
                    radial_gradient_path: None,
                    sweep_gradient_path: None,
                    transform: None,
                    composite: None,
                    clip: None,
                    source_range_utf8: Some(TextSourceRange::new(0, 1)),
                    glyph_range: Some(GlyphRange { start: 0, end: 1 }),
                    source_font_ref: Some(source_font_ref),
                }],
            }),
        },
    );
    let mut renderer = SvgRenderer::new();
    renderer.set_strict_glyph_outline_replay(true);
    renderer.render_layer_tree(&tree);
    let output = renderer.output();
    assert!(output.contains(">A</text>"));
    assert!(!output.contains("data-rhwp-color-graph-node-kind=\"linearGradientPath\""));
    let report = renderer
        .text_variant_selection_diagnostics()
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("svg strict invalid COLRv1 gradient graph report");
    assert_eq!(report.selected_variant_id, "textRun");
    assert!(report.rejected_variants.iter().any(|variant| {
        variant.variant_id == "glyphOutline"
            && variant
                .reasons
                .contains(&VariantRejectReason::UnsupportedColorGlyph)
    }));
    assert!(report
        .outline_eligibility
        .as_ref()
        .is_some_and(|eligibility| {
            !eligibility.payload_supported
                && !eligibility.replay_eligible
                && eligibility.reason == Some(VariantRejectReason::UnsupportedColorGlyph)
        }));
}

#[test]
fn test_layer_svg_strict_glyph_outline_rejects_invalid_colrv0_color_layers() {
    let text_style = TextStyle {
        font_size: 12.0,
        ..Default::default()
    };
    let missing_provenance_tree = glyph_outline_fixture_tree_with_color_layers(
        PaintTextStyle::from(&text_style),
        color_layers_fixture_payload(false, ColorGlyphFormat::ColrV0),
    );
    let mut missing_provenance_renderer = SvgRenderer::new();
    missing_provenance_renderer.set_strict_glyph_outline_replay(true);
    missing_provenance_renderer.render_layer_tree(&missing_provenance_tree);
    let missing_provenance_output = missing_provenance_renderer.output();
    assert!(missing_provenance_output.contains(">A</text>"));
    let missing_provenance_report = missing_provenance_renderer
        .text_variant_selection_diagnostics()
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("svg strict missing color provenance report");
    assert_eq!(missing_provenance_report.selected_variant_id, "textRun");
    assert!(missing_provenance_report
        .rejected_variants
        .iter()
        .any(|variant| {
            variant.variant_id == "glyphOutline"
                && variant
                    .reasons
                    .contains(&VariantRejectReason::UnsupportedColorGlyph)
        }));
    assert!(missing_provenance_report
        .outline_eligibility
        .as_ref()
        .is_some_and(|eligibility| {
            !eligibility.payload_supported
                && !eligibility.replay_eligible
                && eligibility.reason == Some(VariantRejectReason::UnsupportedColorGlyph)
        }));

    let colrv1_tree = glyph_outline_fixture_tree_with_color_layers(
        PaintTextStyle::from(&text_style),
        color_layers_fixture_payload(true, ColorGlyphFormat::ColrV1),
    );
    let mut colrv1_renderer = SvgRenderer::new();
    colrv1_renderer.set_strict_glyph_outline_replay(true);
    colrv1_renderer.render_layer_tree(&colrv1_tree);
    let colrv1_report = colrv1_renderer
        .text_variant_selection_diagnostics()
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("svg strict colrv1 color layer report");
    assert_eq!(colrv1_report.selected_variant_id, "textRun");
    assert!(colrv1_report.rejected_variants.iter().any(|variant| {
        variant.variant_id == "glyphOutline"
            && variant
                .reasons
                .contains(&VariantRejectReason::UnsupportedColorGlyph)
    }));
}

#[test]
fn test_layer_svg_strict_glyph_outline_replays_bitmap_glyph() {
    let text_style = TextStyle {
        font_size: 12.0,
        ..Default::default()
    };
    let tree =
        glyph_outline_fixture_tree_with_bitmap_glyph(PaintTextStyle::from(&text_style), true);
    let mut renderer = SvgRenderer::new();
    renderer.set_strict_glyph_outline_replay(true);
    renderer.render_layer_tree(&tree);
    let output = renderer.output();
    assert!(!output.contains(">A</text>"));
    assert!(output.contains("<image "));
    assert!(output.contains("<g transform=\"matrix(1 0 0 1 3 4)\""));
    assert!(output.contains("href=\"data:image/png;base64,"));
    assert!(output.contains("image-rendering=\"pixelated\""));
    assert!(output.contains("data-rhwp-image-resource-id=\"0\""));
    assert!(output.contains("data-rhwp-color-space=\"sRGB\""));
    assert!(output.contains("data-rhwp-color-space-defaulted=\"true\""));
    assert!(output.contains("source-backed bitmap glyph"));
    let report = renderer
        .text_variant_selection_diagnostics()
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("svg strict bitmap glyph report");
    assert_eq!(report.selected_variant_id, "glyphOutline");
    assert!(report.rejected_variants.is_empty());
    assert!(report
        .outline_eligibility
        .as_ref()
        .is_some_and(|eligibility| {
            eligibility.payload_supported
                && eligibility.replay_eligible
                && eligibility.reason.is_none()
        }));
}

#[test]
fn test_layer_svg_strict_glyph_outline_rejects_bitmap_glyph_without_resource() {
    let text_style = TextStyle {
        font_size: 12.0,
        ..Default::default()
    };
    let tree =
        glyph_outline_fixture_tree_with_bitmap_glyph(PaintTextStyle::from(&text_style), false);
    let mut renderer = SvgRenderer::new();
    renderer.set_strict_glyph_outline_replay(true);
    renderer.render_layer_tree(&tree);
    let output = renderer.output();
    assert!(output.contains(">A</text>"));
    assert!(!output.contains("source-backed bitmap glyph"));
    let report = renderer
        .text_variant_selection_diagnostics()
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("svg strict bitmap glyph missing resource report");
    assert_eq!(report.selected_variant_id, "textRun");
    assert!(report.rejected_variants.iter().any(|variant| {
        variant.variant_id == "glyphOutline"
            && variant
                .reasons
                .contains(&VariantRejectReason::UnsupportedBitmapGlyph)
    }));
}

#[test]
fn test_layer_svg_strict_glyph_outline_rejects_bitmap_glyph_nonpositive_bbox() {
    let text_style = TextStyle {
        font_size: 12.0,
        ..Default::default()
    };
    let mut tree =
        glyph_outline_fixture_tree_with_bitmap_glyph(PaintTextStyle::from(&text_style), true);
    if let crate::paint::LayerNodeKind::Leaf { ops, .. } = &mut tree.root.kind {
        let PaintOp::GlyphOutline { bbox, .. } = &mut ops[1] else {
            panic!("expected glyph outline");
        };
        *bbox = BoundingBox::new(0.0, 0.0, 0.0, 20.0);
    }
    let mut renderer = SvgRenderer::new();
    renderer.set_strict_glyph_outline_replay(true);
    renderer.render_layer_tree(&tree);
    let output = renderer.output();
    assert!(output.contains(">A</text>"));
    assert!(!output.contains("source-backed bitmap glyph"));
    let report = renderer
        .text_variant_selection_diagnostics()
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("svg strict bitmap glyph nonpositive bbox report");
    assert_eq!(report.selected_variant_id, "textRun");
    assert!(report.rejected_variants.iter().any(|variant| {
        variant.variant_id == "glyphOutline"
            && variant
                .reasons
                .contains(&VariantRejectReason::UnsupportedBitmapGlyph)
    }));
}

#[test]
fn test_layer_svg_strict_glyph_outline_rejects_bitmap_glyph_without_deterministic_contract() {
    let text_style = TextStyle {
        font_size: 12.0,
        ..Default::default()
    };
    for case_name in [
        "backend-default-filtering",
        "backend-default-scaling",
        "missing-alpha-mode",
        "missing-strike-selection",
        "diagnostic-only-strike-selection",
        "nonpositive-strike-ppem",
        "empty-color-space",
    ] {
        let mut tree =
            glyph_outline_fixture_tree_with_bitmap_glyph(PaintTextStyle::from(&text_style), true);
        if let crate::paint::LayerNodeKind::Leaf { ops, .. } = &mut tree.root.kind {
            let PaintOp::GlyphOutline { outline, .. } = &mut ops[1] else {
                panic!("expected glyph outline");
            };
            let bitmap = outline.bitmap_glyph.as_mut().expect("bitmap glyph payload");
            match case_name {
                "backend-default-filtering" => {
                    bitmap.filtering = Some(BitmapGlyphFiltering::BackendDefault);
                }
                "backend-default-scaling" => {
                    bitmap.scaling_policy = Some(BitmapGlyphScalingPolicy::BackendDefault);
                }
                "missing-alpha-mode" => {
                    bitmap.alpha_mode = None;
                }
                "missing-strike-selection" => {
                    bitmap.strike_selection = None;
                }
                "diagnostic-only-strike-selection" => {
                    bitmap.strike_selection = Some(BitmapStrikeSelection::DiagnosticOnly);
                }
                "nonpositive-strike-ppem" => {
                    bitmap.strike_ppem = Some((0, 12));
                }
                "empty-color-space" => {
                    bitmap.color_space = Some(String::new());
                }
                _ => unreachable!("covered deterministic BitmapGlyph negative case"),
            }
        }

        let mut renderer = SvgRenderer::new();
        renderer.set_strict_glyph_outline_replay(true);
        renderer.render_layer_tree(&tree);
        let output = renderer.output();
        assert!(
            output.contains(">A</text>"),
            "{case_name}: fallback TextRun should remain visible"
        );
        assert!(
            !output.contains("source-backed bitmap glyph"),
            "{case_name}: strict BitmapGlyph should not be emitted"
        );
        let report = renderer
            .text_variant_selection_diagnostics()
            .iter()
            .find(|report| report.equivalence_group == "text-0")
            .expect("svg strict bitmap glyph deterministic-contract report");
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
fn test_layer_svg_strict_glyph_outline_rejects_mixed_payload_family() {
    let text_style = TextStyle {
        font_size: 12.0,
        ..Default::default()
    };
    let mut tree =
        glyph_outline_fixture_tree_with_bitmap_glyph(PaintTextStyle::from(&text_style), true);
    let vector_resource_id = tree
        .resources
        .intern_svg_fragment("<path d=\"M0 0 L10 0 L10 10 Z\" fill=\"#00ff00\"/>");
    if let crate::paint::LayerNodeKind::Leaf { ops, .. } = &mut tree.root.kind {
        let PaintOp::GlyphOutline { outline, .. } = &mut ops[1] else {
            panic!("expected glyph outline");
        };
        outline.svg_glyph = Some(SvgGlyphPayload {
            vector_resource_id,
            source_range_utf8: Some(TextSourceRange::new(0, 1)),
            glyph_range: Some(GlyphRange { start: 0, end: 1 }),
            placement: Some(outline.placement),
            transform_to_run: None,
            view_box: Some(SvgGlyphViewBox {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            }),
            intrinsic_size: None,
            security_mode: SvgGlyphSecurityMode::StaticSanitized,
            script_allowed: false,
            animation_allowed: false,
            external_resources_allowed: false,
            interactivity_allowed: false,
        });
    }
    let mut renderer = SvgRenderer::new();
    renderer.set_strict_glyph_outline_replay(true);
    renderer.render_layer_tree(&tree);
    let output = renderer.output();
    assert!(output.contains(">A</text>"));
    assert!(!output.contains("source-backed bitmap glyph"));
    assert!(!output.contains("source-backed static sanitized SVG glyph"));
    let report = renderer
        .text_variant_selection_diagnostics()
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("svg strict mixed payload family report");
    assert_eq!(report.selected_variant_id, "textRun");
    assert!(report.rejected_variants.iter().any(|variant| {
        variant.variant_id == "glyphOutline"
            && variant
                .reasons
                .contains(&VariantRejectReason::MixedGlyphOutlinePayload)
    }));
}

#[test]
fn test_layer_svg_strict_glyph_outline_replays_svg_glyph() {
    let text_style = TextStyle {
        font_size: 12.0,
        ..Default::default()
    };
    let tree = glyph_outline_fixture_tree_with_svg_glyph(PaintTextStyle::from(&text_style), true);
    let mut renderer = SvgRenderer::new();
    renderer.set_strict_glyph_outline_replay(true);
    renderer.render_layer_tree(&tree);
    let output = renderer.output();
    assert!(!output.contains(">A</text>"));
    assert!(output.contains("source-backed static sanitized SVG glyph"));
    assert!(output.contains("<g transform=\"matrix(1 0 0 1 3 4)\""));
    assert!(output.contains("data-rhwp-vector-resource-id=\"0\""));
    assert!(output.contains("data-rhwp-security-mode=\"staticSanitized\""));
    assert!(output.contains("viewBox=\"0 0 10 10\""));
    assert!(output.contains("<path d=\"M0 0 L10 0 L10 10 Z\" fill=\"#00ff00\"/>"));
    let report = renderer
        .text_variant_selection_diagnostics()
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("svg strict svg glyph report");
    assert_eq!(report.selected_variant_id, "glyphOutline");
    assert!(report.rejected_variants.is_empty());
    assert!(report
        .outline_eligibility
        .as_ref()
        .is_some_and(|eligibility| {
            eligibility.payload_supported
                && eligibility.replay_eligible
                && eligibility.reason.is_none()
        }));
}

#[test]
fn test_layer_svg_strict_glyph_outline_rejects_svg_glyph_nonpositive_bbox() {
    let text_style = TextStyle {
        font_size: 12.0,
        ..Default::default()
    };
    let mut tree =
        glyph_outline_fixture_tree_with_svg_glyph(PaintTextStyle::from(&text_style), true);
    if let crate::paint::LayerNodeKind::Leaf { ops, .. } = &mut tree.root.kind {
        let PaintOp::GlyphOutline { bbox, .. } = &mut ops[1] else {
            panic!("expected glyph outline");
        };
        *bbox = BoundingBox::new(0.0, 0.0, 20.0, 0.0);
    }
    let mut renderer = SvgRenderer::new();
    renderer.set_strict_glyph_outline_replay(true);
    renderer.render_layer_tree(&tree);
    let output = renderer.output();
    assert!(output.contains(">A</text>"));
    assert!(!output.contains("source-backed static sanitized SVG glyph"));
    let report = renderer
        .text_variant_selection_diagnostics()
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("svg strict svg glyph nonpositive bbox report");
    assert_eq!(report.selected_variant_id, "textRun");
    assert!(report.rejected_variants.iter().any(|variant| {
        variant.variant_id == "glyphOutline"
            && variant
                .reasons
                .contains(&VariantRejectReason::UnsupportedSvgGlyph)
    }));
}

#[test]
fn test_layer_svg_strict_glyph_outline_rejects_svg_glyph_without_static_sanitized_contract() {
    let text_style = TextStyle {
        font_size: 12.0,
        ..Default::default()
    };
    for case_name in [
        "missing-viewbox",
        "nonpositive-viewbox-width",
        "nonpositive-viewbox-height",
        "nonpositive-intrinsic-size",
        "script-allowed",
        "animation-allowed",
        "external-resources-allowed",
        "interactivity-allowed",
    ] {
        let mut tree =
            glyph_outline_fixture_tree_with_svg_glyph(PaintTextStyle::from(&text_style), true);
        if let crate::paint::LayerNodeKind::Leaf { ops, .. } = &mut tree.root.kind {
            let PaintOp::GlyphOutline { outline, .. } = &mut ops[1] else {
                panic!("expected glyph outline");
            };
            let svg = outline.svg_glyph.as_mut().expect("svg glyph payload");
            match case_name {
                "missing-viewbox" => {
                    svg.view_box = None;
                }
                "nonpositive-viewbox-width" => {
                    svg.view_box.as_mut().expect("svg viewBox").width = 0.0;
                }
                "nonpositive-viewbox-height" => {
                    svg.view_box.as_mut().expect("svg viewBox").height = 0.0;
                }
                "nonpositive-intrinsic-size" => {
                    svg.intrinsic_size = Some(SvgGlyphIntrinsicSize {
                        width: 10.0,
                        height: 0.0,
                    });
                }
                "script-allowed" => {
                    svg.script_allowed = true;
                }
                "animation-allowed" => {
                    svg.animation_allowed = true;
                }
                "external-resources-allowed" => {
                    svg.external_resources_allowed = true;
                }
                "interactivity-allowed" => {
                    svg.interactivity_allowed = true;
                }
                _ => unreachable!("covered static sanitized SvgGlyph negative case"),
            }
        }

        let mut renderer = SvgRenderer::new();
        renderer.set_strict_glyph_outline_replay(true);
        renderer.render_layer_tree(&tree);
        let output = renderer.output();
        assert!(
            output.contains(">A</text>"),
            "{case_name}: fallback TextRun should remain visible"
        );
        assert!(
            !output.contains("source-backed static sanitized SVG glyph"),
            "{case_name}: strict SvgGlyph should not be emitted"
        );
        let report = renderer
            .text_variant_selection_diagnostics()
            .iter()
            .find(|report| report.equivalence_group == "text-0")
            .expect("svg strict svg glyph static-contract report");
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
fn test_layer_svg_strict_glyph_outline_applies_bitmap_glyph_payload_transform() {
    let text_style = TextStyle {
        font_size: 12.0,
        ..Default::default()
    };
    let mut tree =
        glyph_outline_fixture_tree_with_bitmap_glyph(PaintTextStyle::from(&text_style), true);
    if let crate::paint::LayerNodeKind::Leaf { ops, .. } = &mut tree.root.kind {
        let PaintOp::GlyphOutline { outline, .. } = &mut ops[1] else {
            panic!("expected glyph outline");
        };
        outline.bitmap_glyph.as_mut().unwrap().transform_to_run = Some(LayerAffineTransform {
            a: 1.0,
            b: 0.0,
            c: 0.0,
            d: 1.0,
            e: 5.0,
            f: 6.0,
        });
    }
    let mut renderer = SvgRenderer::new();
    renderer.set_strict_glyph_outline_replay(true);
    renderer.render_layer_tree(&tree);
    let output = renderer.output();

    assert!(!output.contains(">A</text>"));
    assert!(output.contains("<g transform=\"matrix(1 0 0 1 8 10)\""));
    assert!(output.contains("<image x=\"0\" y=\"0\" width=\"20\" height=\"20\""));
    assert!(output.contains("data-rhwp-variant-id=\"glyphOutline\""));
}

#[test]
fn test_layer_svg_strict_glyph_outline_applies_svg_glyph_payload_transform() {
    let text_style = TextStyle {
        font_size: 12.0,
        ..Default::default()
    };
    let mut tree =
        glyph_outline_fixture_tree_with_svg_glyph(PaintTextStyle::from(&text_style), true);
    if let crate::paint::LayerNodeKind::Leaf { ops, .. } = &mut tree.root.kind {
        let PaintOp::GlyphOutline { outline, .. } = &mut ops[1] else {
            panic!("expected glyph outline");
        };
        outline.svg_glyph.as_mut().unwrap().transform_to_run = Some(LayerAffineTransform {
            a: 1.0,
            b: 0.0,
            c: 0.0,
            d: 1.0,
            e: 7.0,
            f: 8.0,
        });
    }
    let mut renderer = SvgRenderer::new();
    renderer.set_strict_glyph_outline_replay(true);
    renderer.render_layer_tree(&tree);
    let output = renderer.output();

    assert!(!output.contains(">A</text>"));
    assert!(output.contains("<g transform=\"matrix(1 0 0 1 10 12)\""));
    assert!(output.contains("<svg x=\"0\" y=\"0\" width=\"20\" height=\"20\""));
    assert!(output.contains("source-backed static sanitized SVG glyph"));
}

#[test]
fn test_layer_svg_strict_glyph_outline_rejects_svg_glyph_without_resource() {
    let text_style = TextStyle {
        font_size: 12.0,
        ..Default::default()
    };
    let tree = glyph_outline_fixture_tree_with_svg_glyph(PaintTextStyle::from(&text_style), false);
    let mut renderer = SvgRenderer::new();
    renderer.set_strict_glyph_outline_replay(true);
    renderer.render_layer_tree(&tree);
    let output = renderer.output();
    assert!(output.contains(">A</text>"));
    assert!(!output.contains("source-backed static sanitized SVG glyph"));
    let report = renderer
        .text_variant_selection_diagnostics()
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("svg strict svg glyph missing resource report");
    assert_eq!(report.selected_variant_id, "textRun");
    assert!(report.rejected_variants.iter().any(|variant| {
        variant.variant_id == "glyphOutline"
            && variant
                .reasons
                .contains(&VariantRejectReason::UnsupportedSvgGlyph)
    }));
}

#[test]
fn test_layer_svg_strict_glyph_outline_rejects_unsafe_svg_glyph_resource() {
    let text_style = TextStyle {
        font_size: 12.0,
        ..Default::default()
    };
    let mut tree =
        glyph_outline_fixture_tree_with_svg_glyph(PaintTextStyle::from(&text_style), true);
    let mut resources = ResourceArena::default();
    resources.intern_svg_fragment("<path d=\"M0 0 L10 0 L10 10 Z\" onclick=\"alert(1)\"/>");
    tree.resources = resources;

    let mut renderer = SvgRenderer::new();
    renderer.set_strict_glyph_outline_replay(true);
    renderer.render_layer_tree(&tree);
    let output = renderer.output();
    assert!(output.contains(">A</text>"));
    assert!(!output.contains("source-backed static sanitized SVG glyph"));
    assert!(!output.contains("onclick"));

    let report = renderer
        .text_variant_selection_diagnostics()
        .iter()
        .find(|report| report.equivalence_group == "text-0")
        .expect("svg strict unsafe svg glyph resource report");
    assert_eq!(report.selected_variant_id, "textRun");
    assert!(report.rejected_variants.iter().any(|variant| {
        variant.variant_id == "glyphOutline"
            && variant
                .reasons
                .contains(&VariantRejectReason::UnsupportedSvgGlyph)
    }));
}

fn glyph_outline_fixture_tree(
    outline_paint_style: PaintTextStyle,
    paths: Vec<LayerGlyphOutlinePath>,
) -> PageLayerTree {
    glyph_outline_fixture_tree_with_payload(
        outline_paint_style,
        GlyphOutlinePayloadKind::MonochromeFill,
        None,
        paths,
    )
}

fn glyph_outline_fixture_tree_with_payload(
    outline_paint_style: PaintTextStyle,
    payload_kind: GlyphOutlinePayloadKind,
    stroke: Option<GlyphOutlineStrokeStyle>,
    paths: Vec<LayerGlyphOutlinePath>,
) -> PageLayerTree {
    let bbox = BoundingBox::new(0.0, 0.0, 20.0, 20.0);
    let text_style = TextStyle {
        font_size: 12.0,
        ..Default::default()
    };
    let text_variant = PaintVariantMeta::text_run_default("text-0");
    let mut outline_requires = vec!["text.outlineGlyph".to_string()];
    if payload_kind == GlyphOutlinePayloadKind::ColorLayers {
        outline_requires.push("text.glyphOutline.colorLayers".to_string());
        outline_requires.push("text.glyphOutline.colorLayers.colrV0".to_string());
    } else if payload_kind == GlyphOutlinePayloadKind::BitmapGlyph {
        outline_requires.push("text.glyphOutline.bitmapGlyph".to_string());
    } else if payload_kind == GlyphOutlinePayloadKind::SvgGlyph {
        outline_requires.push("text.glyphOutline.svgGlyph".to_string());
    }
    let outline_variant = PaintVariantMeta {
        equivalence_group: "text-0".to_string(),
        variant_id: "glyphOutline".to_string(),
        variant_kind: TextVariantKind::GlyphOutline,
        part_index: 0,
        part_count: 1,
        is_default_fallback: false,
        requires: outline_requires,
        quality: Some(TextVariantQuality::Exact),
        anchor_op_id: Some("op-text-0".to_string()),
        local_paint_order: Some(0),
    };
    let root = LayerNode::leaf(
        bbox,
        Some(1),
        vec![
            PaintOp::TextRun {
                bbox,
                run: LayerTextRunPaint {
                    source: Some(TextSourceSpan {
                        id: TextSourceId(7),
                        utf8_range: TextSourceRange::new(0, 1),
                        utf16_range: TextSourceRange::new(0, 1),
                        stable_source_key: None,
                    }),
                    variant: Some(text_variant),
                    text: "A".to_string(),
                    style: text_style,
                    positions: vec![0.0, 10.0],
                    baseline: 12.0,
                    orientation: LayerTextOrientation::Horizontal,
                    ..Default::default()
                },
            },
            PaintOp::GlyphOutline {
                bbox,
                outline: Box::new(LayerGlyphOutlinePaint {
                    source: TextSourceSpan {
                        id: TextSourceId(7),
                        utf8_range: TextSourceRange::new(0, 1),
                        utf16_range: TextSourceRange::new(0, 1),
                        stable_source_key: None,
                    },
                    variant: outline_variant,
                    payload_kind,
                    stroke,
                    color_layers: None,
                    bitmap_glyph: None,
                    svg_glyph: None,
                    paint_style: outline_paint_style,
                    placement: TextRunPlacement {
                        run_to_page: LayerAffineTransform {
                            a: 1.0,
                            b: 0.0,
                            c: 0.0,
                            d: 1.0,
                            e: 3.0,
                            f: 4.0,
                        },
                        baseline_y: 0.0,
                    },
                    paths,
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
            },
        ],
    );
    PageLayerTree::builder(40.0, 30.0, root)
        .text_sources(TextSourceTable {
            entries: vec![TextSourceEntry {
                id: TextSourceId(7),
                stable_source_key: Some("fixture-source".to_string()),
                text: "A".to_string(),
                utf8_range: TextSourceRange::new(0, 1),
                utf16_range: TextSourceRange::new(0, 1),
                annotations: Vec::new(),
            }],
        })
        .build()
}

fn glyph_outline_fixture_tree_with_bitmap_glyph(
    outline_paint_style: PaintTextStyle,
    include_resource: bool,
) -> PageLayerTree {
    let mut tree = glyph_outline_fixture_tree_with_payload(
        outline_paint_style,
        GlyphOutlinePayloadKind::BitmapGlyph,
        None,
        Vec::new(),
    );
    if include_resource {
        let mut resources = ResourceArena::default();
        resources.intern_image_bytes(FIXTURE_PNG_1X1);
        tree.resources = resources;
    }
    if let crate::paint::LayerNodeKind::Leaf { ops, .. } = &mut tree.root.kind {
        let PaintOp::GlyphOutline { outline, .. } = &mut ops[1] else {
            panic!("expected glyph outline");
        };
        outline.bitmap_glyph = Some(BitmapGlyphPayload {
            image_resource_id: crate::paint::ImageResourceId(0),
            source_range_utf8: Some(TextSourceRange::new(0, 1)),
            glyph_range: Some(GlyphRange { start: 0, end: 1 }),
            placement: Some(outline.placement),
            transform_to_run: None,
            strike_ppem: Some((12, 12)),
            strike_selection: Some(BitmapStrikeSelection::ProducerResolved),
            pixel_format: Some("rgba8".to_string()),
            color_space: None,
            alpha_mode: Some(BitmapAlphaMode::Straight),
            scaling_policy: Some(BitmapGlyphScalingPolicy::ExplicitTransform),
            filtering: Some(BitmapGlyphFiltering::Nearest),
        });
    }
    tree
}

fn glyph_outline_fixture_tree_with_svg_glyph(
    outline_paint_style: PaintTextStyle,
    include_resource: bool,
) -> PageLayerTree {
    let mut tree = glyph_outline_fixture_tree_with_payload(
        outline_paint_style,
        GlyphOutlinePayloadKind::SvgGlyph,
        None,
        Vec::new(),
    );
    if include_resource {
        let mut resources = ResourceArena::default();
        resources.intern_svg_fragment("<path d=\"M0 0 L10 0 L10 10 Z\" fill=\"#00ff00\"/>");
        tree.resources = resources;
    }
    if let crate::paint::LayerNodeKind::Leaf { ops, .. } = &mut tree.root.kind {
        let PaintOp::GlyphOutline { outline, .. } = &mut ops[1] else {
            panic!("expected glyph outline");
        };
        outline.svg_glyph = Some(SvgGlyphPayload {
            vector_resource_id: crate::paint::SvgResourceId(0),
            source_range_utf8: Some(TextSourceRange::new(0, 1)),
            glyph_range: Some(GlyphRange { start: 0, end: 1 }),
            placement: Some(outline.placement),
            transform_to_run: None,
            view_box: Some(SvgGlyphViewBox {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            }),
            intrinsic_size: None,
            security_mode: SvgGlyphSecurityMode::StaticSanitized,
            script_allowed: false,
            animation_allowed: false,
            external_resources_allowed: false,
            interactivity_allowed: false,
        });
    }
    tree
}

const FIXTURE_PNG_1X1: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0xf0,
    0x1f, 0x00, 0x05, 0x00, 0x01, 0xff, 0x89, 0x99, 0x3d, 0x1d, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
    0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];

fn glyph_outline_fixture_tree_with_color_layers(
    outline_paint_style: PaintTextStyle,
    color_layers: ColorLayersPayload,
) -> PageLayerTree {
    let color_format = color_layers.color_format;
    let mut tree = glyph_outline_fixture_tree_with_payload(
        outline_paint_style,
        GlyphOutlinePayloadKind::ColorLayers,
        None,
        Vec::new(),
    );
    if let crate::paint::LayerNodeKind::Leaf { ops, .. } = &mut tree.root.kind {
        let PaintOp::GlyphOutline { outline, .. } = &mut ops[1] else {
            panic!("expected glyph outline");
        };
        outline.variant.requires.retain(|feature| {
            feature != "text.glyphOutline.colorLayers.colrV0"
                && feature != "text.glyphOutline.colorLayers.colrV1"
        });
        outline.variant.requires.push(
            match color_format {
                ColorGlyphFormat::ColrV1 => "text.glyphOutline.colorLayers.colrV1",
                _ => "text.glyphOutline.colorLayers.colrV0",
            }
            .to_string(),
        );
        outline.color_layers = Some(color_layers);
    }
    tree
}

fn color_layers_fixture_payload(
    include_layer_source_font_ref: bool,
    color_format: ColorGlyphFormat,
) -> ColorLayersPayload {
    ColorLayersPayload {
        color_format,
        source_font_ref: Some(FontColorGlyphRef {
            face_key: Some("fixture-face".to_string()),
            glyph_id: Some(42),
            palette_index: Some(3),
            color_format: Some(color_format),
        }),
        palette_ref: Some(PaletteRef {
            id: Some("fixture-palette".to_string()),
            index: Some(0),
            cpal_digest: Some("blake3:fixture-cpal".to_string()),
        }),
        source_range_utf8: Some(TextSourceRange::new(0, 1)),
        glyph_range: Some(GlyphRange { start: 0, end: 1 }),
        layers: vec![ColorLayerNode {
            layer_index: Some(0),
            glyph_id: Some(42),
            glyph_range: Some(GlyphRange { start: 0, end: 1 }),
            source_range_utf8: Some(TextSourceRange::new(0, 1)),
            source_font_ref: include_layer_source_font_ref.then(|| FontColorGlyphRef {
                face_key: Some("fixture-face".to_string()),
                glyph_id: Some(42),
                palette_index: Some(3),
                color_format: Some(color_format),
            }),
            path_index: Some(0),
            commands: Some(vec![
                PathCommand::MoveTo(0.0, 0.0),
                PathCommand::LineTo(8.0, 0.0),
                PathCommand::LineTo(8.0, 8.0),
                PathCommand::ClosePath,
            ]),
            fill: Some(ResolvedColor {
                color_space: Some("srgb".to_string()),
                rgba: [0.0, 0.0, 1.0, 1.0],
            }),
            fill_rule: Some(GlyphOutlineFillRule::NonZero),
            palette_index: Some(3),
            color: Some(0x00ff0000),
            opacity: Some(1.0),
            transform_to_run: Some(LayerAffineTransform {
                a: 1.0,
                b: 0.0,
                c: 0.0,
                d: 1.0,
                e: 0.0,
                f: 0.0,
            }),
        }],
        paint_graph: None,
    }
}

fn glyph_outline_fixture_path() -> LayerGlyphOutlinePath {
    LayerGlyphOutlinePath {
        glyph_id: 42,
        source_range_utf8: TextSourceRange::new(0, 1),
        glyph_range: crate::paint::GlyphRange { start: 0, end: 1 },
        commands: vec![
            PathCommand::MoveTo(0.0, 0.0),
            PathCommand::LineTo(8.0, 0.0),
            PathCommand::LineTo(8.0, 8.0),
            PathCommand::ClosePath,
        ],
        fill_rule: GlyphOutlineFillRule::EvenOdd,
    }
}

#[test]
fn test_legacy_svg_vertical_text_uses_explicit_rotation_only() {
    let mut tree = PageRenderTree::new(0, 80.0, 60.0);
    tree.root.children.push(RenderNode::new(
        1,
        RenderNodeType::TextRun(TextRunNode {
            text: "세로".to_string(),
            style: TextStyle {
                font_size: 14.0,
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
            rotation: 15.0,
            is_vertical: true,
            char_overlap: None,
            border_fill_id: 0,
            baseline: 16.0,
            field_marker: Default::default(),
        }),
        BoundingBox::new(10.0, 15.0, 40.0, 20.0),
    ));
    let mut renderer = SvgRenderer::new();
    renderer.render_tree(&tree);

    let output = renderer.output();
    assert!(
        output.contains("<g transform=\"rotate(15,30,25)\">"),
        "vertical legacy text should use TextRunNode::rotation without implicit vertical rotation:\n{output}"
    );
    assert!(
        !output.contains("rotate(105"),
        "vertical legacy text should not add another 90 degrees on top of run.rotation:\n{output}"
    );
}

#[test]
fn test_layer_svg_output_options_enable_marks_without_renderer_config() {
    let bbox = BoundingBox::new(10.0, 15.0, 40.0, 20.0);
    let root = LayerNode::leaf(
        bbox,
        Some(1),
        vec![PaintOp::TextRun {
            bbox,
            run: LayerTextRunPaint {
                source: None,
                text: "a b".to_string(),
                style: TextStyle {
                    font_size: 14.0,
                    ..Default::default()
                },
                positions: vec![0.0, 8.0, 16.0, 24.0],
                control_marks: vec![
                    LayerTextControlMark {
                        kind: LayerTextControlMarkKind::Space,
                        x: 10.0,
                        y: 0.0,
                        font_size: 7.0,
                    },
                    LayerTextControlMark {
                        kind: LayerTextControlMarkKind::ParagraphEnd,
                        x: 40.0,
                        y: 0.0,
                        font_size: 14.0,
                    },
                ],
                baseline: 16.0,
                rotation: 0.0,
                is_vertical: false,
                orientation: LayerTextOrientation::Horizontal,
                char_overlap: None,
                field_marker: Default::default(),
                is_para_end: true,
                is_line_break_end: false,
                ..Default::default()
            },
        }],
    );
    let tree = PageLayerTree::new(80.0, 60.0, root).with_output_options(LayerOutputOptions {
        show_paragraph_marks: true,
        show_control_codes: true,
        ..Default::default()
    });
    let mut renderer = SvgRenderer::new();
    renderer.render_layer_tree(&tree);

    let output = renderer.output();
    assert!(
        output.contains("\u{2228}"),
        "layer outputOptions should enable visible space marks:\n{output}"
    );
    assert!(
        output.contains("\u{21B5}"),
        "layer outputOptions should enable paragraph end marks:\n{output}"
    );
}

#[test]
fn test_layer_svg_clip_disabled_replays_child_without_clip_path() {
    let child = LayerNode::leaf(
        BoundingBox::new(30.0, 10.0, 10.0, 10.0),
        Some(2),
        vec![PaintOp::Rectangle {
            bbox: BoundingBox::new(30.0, 10.0, 10.0, 10.0),
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
        BoundingBox::new(0.0, 0.0, 40.0, 30.0),
        Some(1),
        BoundingBox::new(0.0, 0.0, 20.0, 30.0),
        child,
        ClipKind::Body,
    );
    let tree = PageLayerTree::new(40.0, 30.0, root).with_output_options(LayerOutputOptions {
        clip_enabled: false,
        ..Default::default()
    });
    let mut renderer = SvgRenderer::new();
    renderer.render_layer_tree(&tree);

    let output = renderer.output();
    assert!(
        !output.contains("<clipPath"),
        "clip must be skipped:\n{output}"
    );
    assert!(
        output.contains("<rect"),
        "clip-disabled replay should still render the child:\n{output}"
    );
}
