use super::*;
use crate::paint::{
    GlyphOutlineFillRule, GlyphRunDiagnostics, GlyphRunReplayEligibility, LayerAffineTransform,
    LayerGlyphOutlinePaint, LayerGlyphOutlinePath, LayerOutputOptions, LayerRectanglePaint,
    LayerTextControlMark, LayerTextControlMarkKind, LayerTextOrientation, PaintTextStyle,
    PaintVariantMeta, TextRunPlacement, TextSourceId, TextSourceRange, TextSourceSpan,
    TextVariantKind, TextVariantQuality,
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
fn test_layer_svg_strict_glyph_outline_replaces_text_fallback() {
    let bbox = BoundingBox::new(0.0, 0.0, 20.0, 20.0);
    let text_style = TextStyle {
        font_size: 12.0,
        ..Default::default()
    };
    let text_variant = PaintVariantMeta::text_run_default("text-0");
    let outline_variant = PaintVariantMeta {
        equivalence_group: "text-0".to_string(),
        variant_id: "glyphOutline".to_string(),
        variant_kind: TextVariantKind::GlyphOutline,
        part_index: 0,
        part_count: 1,
        is_default_fallback: false,
        requires: vec!["text.outlineGlyph".to_string()],
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
                    style: text_style.clone(),
                    positions: vec![0.0, 10.0],
                    baseline: 12.0,
                    orientation: LayerTextOrientation::Horizontal,
                    ..Default::default()
                },
            },
            PaintOp::GlyphOutline {
                bbox,
                outline: LayerGlyphOutlinePaint {
                    source: TextSourceSpan {
                        id: TextSourceId(7),
                        utf8_range: TextSourceRange::new(0, 1),
                        utf16_range: TextSourceRange::new(0, 1),
                        stable_source_key: None,
                    },
                    variant: outline_variant,
                    paint_style: PaintTextStyle::from(&text_style),
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
                    paths: vec![LayerGlyphOutlinePath {
                        commands: vec![
                            PathCommand::MoveTo(0.0, 0.0),
                            PathCommand::LineTo(8.0, 0.0),
                            PathCommand::LineTo(8.0, 8.0),
                            PathCommand::ClosePath,
                        ],
                        fill_rule: GlyphOutlineFillRule::EvenOdd,
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
                },
            },
        ],
    );
    let tree = PageLayerTree::new(40.0, 30.0, root);
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

    let mut strict_renderer = SvgRenderer::new();
    strict_renderer.set_strict_glyph_outline_replay(true);
    strict_renderer.render_layer_tree(&tree);
    let strict_output = strict_renderer.output();
    assert!(!strict_output.contains(">A</text>"));
    assert!(strict_output.contains("<path d=\"M0 0 L8 0 L8 8 Z\""));
    assert!(strict_output.contains("fill-rule=\"evenodd\""));
    assert!(strict_output.contains("data-rhwp-source-id=\"7\""));
    assert!(strict_output.contains("data-rhwp-variant-id=\"glyphOutline\""));
    assert!(strict_output.contains("matrix(1 0 0 1 3 4)"));
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
