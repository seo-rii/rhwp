use skia_safe::{paint::Cap, Canvas, Color, Paint, PathBuilder, Point, Rect};
use std::borrow::Cow;

use crate::paint::{LayerTextDecorationKind, LayerTextDecorationPaint, LayerTextRunPaint};
use crate::renderer::composer::{
    char_overlap_inner_size_ratio, decode_pua_overlap_number, expand_pua_display_text,
    pua_to_display_text,
};
use crate::renderer::layout::split_into_clusters;
use crate::renderer::render_tree::BoundingBox;
use crate::renderer::UnderlineType;

use super::image_conv::{draw_decoded_image, ImageSampling};
use super::paint_conv::colorref_to_skia;
use super::renderer::SkiaLayerRenderer;
use super::replay_context::SkiaReplayContext;

impl SkiaLayerRenderer {
    pub(super) fn render_text_run(
        &self,
        canvas: &Canvas,
        bbox: &BoundingBox,
        run: &LayerTextRunPaint,
        replay: &mut SkiaReplayContext,
    ) {
        let base_font_size = if run.style.font_size > 0.0 {
            run.style.font_size
        } else {
            12.0
        };
        let mut render_style = run.style.clone();
        let mut y = (bbox.y + run.baseline) as f32;
        if run.style.superscript {
            render_style.font_size = base_font_size * 0.7;
            y -= (base_font_size * 0.3) as f32;
        } else if run.style.subscript {
            render_style.font_size = base_font_size * 0.7;
            y += (base_font_size * 0.15) as f32;
        }

        if let Some(overlap) = &run.char_overlap {
            let chars: Vec<char> = run.text.chars().collect();
            if chars.is_empty() {
                return;
            }

            let box_size = render_style.font_size.max(1.0) as f32;
            let size_ratio = char_overlap_inner_size_ratio(overlap.inner_char_size);
            let mut overlap_style = render_style.clone();
            overlap_style.font_size = (render_style.font_size * size_ratio).max(1.0);
            let inner_font_size = overlap_style.font_size as f32;

            let draw_overlap_cell = |display: &str,
                                     cx: f32,
                                     cy: f32,
                                     target_text_width: Option<f32>,
                                     draw_shape: bool| {
                let effective_border = if target_text_width.is_some() && overlap.border_type == 0 {
                    1
                } else {
                    overlap.border_type
                };
                let is_reversed = effective_border == 2 || effective_border == 4;
                let is_circle = effective_border == 1 || effective_border == 2;
                let is_rect = effective_border == 3 || effective_border == 4;

                let mut fill = Paint::default();
                fill.set_anti_alias(true);
                fill.set_style(skia_safe::paint::Style::Fill);
                fill.set_color(Color::BLACK);

                let mut stroke = Paint::default();
                stroke.set_anti_alias(true);
                stroke.set_style(skia_safe::paint::Style::Stroke);
                stroke.set_stroke_width(0.8);
                let glyph_color = colorref_to_skia(run.style.color, 1.0);
                stroke.set_color(if is_reversed {
                    Color::BLACK
                } else {
                    glyph_color
                });

                if draw_shape && is_circle {
                    let ry = box_size / 2.0;
                    let rx = ry * 0.85;
                    let oval = Rect::from_xywh(cx - rx, cy - ry, rx * 2.0, ry * 2.0);
                    if is_reversed {
                        canvas.draw_oval(oval, &fill);
                    }
                    canvas.draw_oval(oval, &stroke);
                } else if draw_shape && is_rect {
                    let rect = Rect::from_xywh(
                        cx - box_size / 2.0,
                        cy - box_size / 2.0,
                        box_size,
                        box_size,
                    );
                    if is_reversed {
                        canvas.draw_rect(rect, &fill);
                    }
                    canvas.draw_rect(rect, &stroke);
                }

                let mut text_paint = Paint::default();
                text_paint.set_anti_alias(true);
                text_paint.set_style(skia_safe::paint::Style::Fill);
                text_paint.set_color(if is_reversed {
                    Color::WHITE
                } else {
                    colorref_to_skia(run.style.color, 1.0)
                });
                let font = self.font_resolver.make_font(&overlap_style, display);
                let (measured_width, _) = font.measure_str(display, Some(&text_paint));
                let measured_width = measured_width.max(1.0);
                let baseline_y = inner_font_size * 0.35;

                if let Some(target_width) = target_text_width {
                    let scale_x = (target_width / measured_width).min(1.0);
                    canvas.save();
                    canvas.translate((cx, cy));
                    canvas.scale((scale_x, 1.0));
                    canvas.draw_str(
                        display,
                        (-measured_width / 2.0, baseline_y),
                        &font,
                        &text_paint,
                    );
                    canvas.restore();
                } else {
                    canvas.draw_str(
                        display,
                        (cx - measured_width / 2.0, cy + baseline_y),
                        &font,
                        &text_paint,
                    );
                }
            };

            if let Some(number_str) = decode_pua_overlap_number(&chars) {
                let cx = bbox.x as f32 + box_size / 2.0;
                let cy = bbox.y as f32 + bbox.height as f32 / 2.0;
                draw_overlap_cell(&number_str, cx, cy, Some(box_size * 0.7), true);
                return;
            }

            let cx = if chars.len() > 1 {
                bbox.x as f32 + bbox.width as f32 / 2.0
            } else {
                bbox.x as f32 + box_size / 2.0
            };
            for (index, ch) in chars.iter().enumerate() {
                let display = {
                    let codepoint = u32::from(*ch);
                    if (0x2460..=0x2473).contains(&codepoint) {
                        format!("{}", codepoint - 0x2460 + 1)
                    } else if let Some(text) = pua_to_display_text(*ch) {
                        text
                    } else {
                        ch.to_string()
                    }
                };
                let cy = bbox.y as f32 + bbox.height as f32 / 2.0;
                draw_overlap_cell(&display, cx, cy, None, index == 0);
            }
            return;
        }

        let shaping_profile = |text: &str| {
            let mut has_rtl = false;
            let needs_shaping = text.chars().any(|ch| {
                let codepoint = u32::from(ch);
                if matches!(
                    codepoint,
                    0x0590..=0x08FF
                        | 0xFB1D..=0xFDFF
                        | 0xFE70..=0xFEFF
                        | 0x10800..=0x10FFF
                        | 0x1E800..=0x1EFFF
                ) {
                    has_rtl = true;
                    return true;
                }
                matches!(
                    codepoint,
                    0x0300..=0x036F
                        | 0x0900..=0x0DFF
                        | 0x0E00..=0x0E7F
                        | 0x1780..=0x17FF
                        | 0x1AB0..=0x1AFF
                        | 0x1DC0..=0x1DFF
                        | 0x200C..=0x200D
                        | 0x20D0..=0x20FF
                        | 0xFE00..=0xFE0F
                        | 0xFE20..=0xFE2F
                        | 0x1F1E6..=0x1FAFF
                        | 0xE0100..=0xE01EF
                )
            });
            (needs_shaping, has_rtl)
        };
        let shape_text_blob = |text: &str, font: &skia_safe::Font| {
            if text.is_empty() {
                return None;
            }
            let (needs_shaping, has_rtl) = shaping_profile(text);
            if !needs_shaping {
                return None;
            }
            self.text_shaper
                .shape_text_blob(text, font, !has_rtl, 1_000_000.0, Point::default())
                .map(|(blob, _)| blob)
        };
        let display_text = match run.display_text.as_deref() {
            Some(display_text) => Cow::Borrowed(display_text),
            None => Cow::Owned(expand_pua_display_text(&run.text)),
        };
        let text = display_text.as_ref();
        let clusters = split_into_clusters(text);
        let metrics_font = self.font_resolver.make_font(&render_style, text);
        let display_positions;
        let char_positions = if run.display_text.is_some() {
            display_positions = crate::renderer::layout::compute_char_positions(text, &run.style);
            &display_positions
        } else if text == run.text {
            &run.positions
        } else if text.is_empty() {
            display_positions = Vec::new();
            &display_positions
        } else {
            display_positions = crate::renderer::layout::compute_char_positions(text, &run.style);
            &display_positions
        };
        let text_width = char_positions.last().copied().unwrap_or(0.0) as f32;
        let prefer_direct_text = replay.prefer_direct_text();
        let shade_rgb = run.style.shade_color & 0x00FF_FFFF;
        if text_width > 0.0 && shade_rgb != 0x00FF_FFFF && shade_rgb != 0 {
            let mut shade_paint = Paint::default();
            shade_paint.set_anti_alias(true);
            shade_paint.set_style(skia_safe::paint::Style::Fill);
            shade_paint.set_color(colorref_to_skia(run.style.shade_color, 1.0));
            canvas.draw_rect(
                Rect::from_xywh(
                    bbox.x as f32,
                    y - render_style.font_size as f32,
                    text_width,
                    render_style.font_size as f32 * 1.2,
                ),
                &shade_paint,
            );
        }

        let mut draw_pass = |canvas: &Canvas,
                             x_offset: f32,
                             y_offset: f32,
                             fill_color: u32,
                             stroke_color: Option<u32>,
                             stroke_width: f32,
                             prefer_direct_text: bool| {
            let font_family = if render_style.font_family.is_empty() {
                "sans-serif".to_string()
            } else {
                format!(
                    "'{}',{}",
                    render_style
                        .font_family
                        .replace('\\', "\\\\")
                        .replace('\'', "\\'"),
                    crate::renderer::generic_fallback(&render_style.font_family)
                )
            };
            let mut fill_paint = Paint::default();
            fill_paint.set_anti_alias(true);
            fill_paint.set_style(skia_safe::paint::Style::Fill);
            fill_paint.set_color(colorref_to_skia(fill_color, 1.0));

            let mut stroke_paint = Paint::default();
            if let Some(stroke_color) = stroke_color {
                stroke_paint.set_anti_alias(true);
                stroke_paint.set_style(skia_safe::paint::Style::Stroke);
                stroke_paint.set_stroke_width(stroke_width.max(0.5));
                stroke_paint.set_color(colorref_to_skia(stroke_color, 1.0));
            }

            let is_space_cluster =
                |cluster: &str| cluster == " " || cluster == "\t" || cluster == "\u{2007}";
            let is_symbol_cluster = |cluster: &str| {
                cluster.chars().count() == 1
                    && cluster.chars().all(|ch| {
                        matches!(
                            ch,
                            '\u{00AD}'
                                | '\u{203B}'
                                | '\u{2460}'..='\u{24FF}'
                                | '\u{2500}'..='\u{27BF}'
                        )
                    })
            };
            let next_needs_shaping = |index: usize| {
                clusters.get(index + 1).is_some_and(|(_, next_cluster)| {
                    !is_space_cluster(next_cluster)
                        && !is_symbol_cluster(next_cluster)
                        && shaping_profile(next_cluster).0
                })
            };
            let draw_glyph_paths = |canvas: &Canvas,
                                    text: &str,
                                    font: &skia_safe::Font,
                                    x: f32,
                                    pass_y: f32,
                                    fill_paint: &Paint,
                                    stroke_paint: &Paint| {
                let glyphs = font.text_to_glyphs_vec(text);
                let mut glyph_positions = vec![Point::default(); glyphs.len()];
                font.get_pos(&glyphs, &mut glyph_positions, Some(Point::new(x, pass_y)));
                for (glyph_id, glyph_position) in glyphs.into_iter().zip(glyph_positions) {
                    if let Some(path) = font.get_path(glyph_id) {
                        let path = path.with_offset((glyph_position.x, glyph_position.y));
                        canvas.draw_path(&path, fill_paint);
                        if stroke_color.is_some() {
                            canvas.draw_path(&path, stroke_paint);
                        }
                    }
                }
            };

            let mut cluster_index = 0;
            while cluster_index < clusters.len() {
                let (char_idx, cluster) = &clusters[cluster_index];
                if cluster == " " || cluster == "\t" || cluster == "\u{2007}" {
                    cluster_index += 1;
                    continue;
                }
                let x = bbox.x as f32 + char_positions[*char_idx] as f32 + x_offset;
                let pass_y = y + y_offset;
                if is_symbol_cluster(cluster) {
                    let next_x = char_positions
                        .get(*char_idx + 1)
                        .copied()
                        .unwrap_or(text_width as f64);
                    let cluster_width = (next_x - char_positions[*char_idx])
                        .max(render_style.font_size * 0.6)
                        as f32;
                    let color = format!(
                        "#{:02x}{:02x}{:02x}",
                        fill_color & 0xFF,
                        (fill_color >> 8) & 0xFF,
                        (fill_color >> 16) & 0xFF,
                    );
                    let svg_fragment = format!(
                    "<text x=\"0\" y=\"{:.3}\" font-family=\"{}\" font-size=\"{:.3}\" fill=\"{}\">{}</text>",
                    render_style.font_size,
                    font_family,
                    render_style.font_size,
                    color,
                    cluster,
                );
                    if let Some(image) = replay.svg_image_for_fragment(
                        &svg_fragment,
                        cluster_width,
                        render_style.font_size as f32 * 1.4,
                    ) {
                        let diagnostics = draw_decoded_image(
                            canvas,
                            &image,
                            x,
                            pass_y - render_style.font_size as f32,
                            cluster_width,
                            render_style.font_size as f32 * 1.4,
                            Some(crate::model::style::ImageFillMode::FitToSize),
                            None,
                            None,
                            crate::model::image::ImageEffect::RealPic,
                            0,
                            0,
                            ImageSampling::linear(),
                        );
                        replay.record_image_draw(diagnostics);
                    }
                    cluster_index += 1;
                    continue;
                }

                let (cluster_needs_shaping, _) = shaping_profile(cluster);
                if cluster_needs_shaping || next_needs_shaping(cluster_index) {
                    let mut shaped_text = String::new();
                    let mut end_index = cluster_index;
                    while end_index < clusters.len() {
                        let segment = &clusters[end_index].1;
                        if is_space_cluster(segment) || is_symbol_cluster(segment) {
                            break;
                        }
                        let segment_needs_shaping = shaping_profile(segment).0;
                        if end_index != cluster_index
                            && !segment_needs_shaping
                            && !next_needs_shaping(end_index)
                        {
                            break;
                        }
                        shaped_text.push_str(segment);
                        end_index += 1;
                    }

                    let font = self.font_resolver.make_font(&render_style, &shaped_text);
                    if let Some(blob) = shape_text_blob(&shaped_text, &font) {
                        canvas.draw_text_blob(&blob, (x, pass_y), &fill_paint);
                        if stroke_color.is_some() {
                            canvas.draw_text_blob(&blob, (x, pass_y), &stroke_paint);
                        }
                    } else if prefer_direct_text && stroke_color.is_none() {
                        canvas.draw_str(&shaped_text, (x, pass_y), &font, &fill_paint);
                    } else {
                        draw_glyph_paths(
                            canvas,
                            &shaped_text,
                            &font,
                            x,
                            pass_y,
                            &fill_paint,
                            &stroke_paint,
                        );
                    }
                    cluster_index = end_index.max(cluster_index + 1);
                    continue;
                }

                let font = self.font_resolver.make_font(&render_style, cluster);
                if let Some(blob) = shape_text_blob(cluster, &font) {
                    canvas.draw_text_blob(&blob, (x, pass_y), &fill_paint);
                    if stroke_color.is_some() {
                        canvas.draw_text_blob(&blob, (x, pass_y), &stroke_paint);
                    }
                } else if prefer_direct_text && stroke_color.is_none() {
                    canvas.draw_str(cluster, (x, pass_y), &font, &fill_paint);
                } else {
                    draw_glyph_paths(
                        canvas,
                        cluster,
                        &font,
                        x,
                        pass_y,
                        &fill_paint,
                        &stroke_paint,
                    );
                }
                cluster_index += 1;
            }
        };

        if run.style.emboss || run.style.engrave {
            let offset = (render_style.font_size as f32 / 20.0).max(1.0);
            let (first_color, second_color) = if run.style.emboss {
                (0x00FF_FFFF, 0x0080_8080)
            } else {
                (0x0080_8080, 0x00FF_FFFF)
            };
            draw_pass(canvas, -offset, -offset, first_color, None, 0.0, false);
            draw_pass(canvas, offset, offset, second_color, None, 0.0, false);
            draw_pass(canvas, 0.0, 0.0, run.style.color, None, 0.0, false);
        } else {
            if run.style.shadow_type > 0 {
                draw_pass(
                    canvas,
                    run.style.shadow_offset_x as f32,
                    run.style.shadow_offset_y as f32,
                    run.style.shadow_color,
                    None,
                    0.0,
                    false,
                );
            }
            if run.style.outline_type > 0 {
                draw_pass(
                    canvas,
                    0.0,
                    0.0,
                    0x00FF_FFFF,
                    Some(run.style.color),
                    (render_style.font_size as f32 / 25.0).max(0.5),
                    false,
                );
            } else {
                draw_pass(
                    canvas,
                    0.0,
                    0.0,
                    run.style.color,
                    None,
                    0.0,
                    prefer_direct_text,
                );
            }
        }

        if !matches!(run.style.underline, UnderlineType::None) {
            let ul_y = match run.style.underline {
                UnderlineType::Top => y - metrics_font.size() + 1.0,
                _ => y + 2.0,
            };
            self.draw_text_line_shape(
                canvas,
                bbox.x as f32,
                ul_y,
                bbox.x as f32 + text_width,
                ul_y,
                if run.style.underline_color != 0 {
                    run.style.underline_color
                } else {
                    run.style.color
                },
                run.style.underline_shape,
            );
        }
        if run.style.strikethrough {
            let strike_y = y - metrics_font.size() * 0.3;
            self.draw_text_line_shape(
                canvas,
                bbox.x as f32,
                strike_y,
                bbox.x as f32 + text_width,
                strike_y,
                if run.style.strike_color != 0 {
                    run.style.strike_color
                } else {
                    run.style.color
                },
                run.style.strike_shape,
            );
        }

        for leader in &run.style.tab_leaders {
            if leader.fill_type == 0 {
                continue;
            }
            let lx1 = bbox.x as f32 + leader.start_x as f32;
            let lx2 = bbox.x as f32 + leader.end_x as f32;
            let ly = y - render_style.font_size as f32 * 0.35;
            let draw_line = |line_y: f32, stroke_width: f32, dash: &[f32], round_cap: bool| {
                let mut leader_paint = Paint::default();
                leader_paint.set_anti_alias(true);
                leader_paint.set_style(skia_safe::paint::Style::Stroke);
                leader_paint.set_stroke_width(stroke_width);
                leader_paint.set_color(colorref_to_skia(run.style.color, 1.0));
                if round_cap {
                    leader_paint.set_stroke_cap(Cap::Round);
                }
                if !dash.is_empty() {
                    if let Some(effect) = skia_safe::PathEffect::dash(dash, 0.0) {
                        leader_paint.set_path_effect(effect);
                    }
                }
                canvas.draw_line((lx1, line_y), (lx2, line_y), &leader_paint);
            };

            match leader.fill_type {
                1 => draw_line(ly, 0.5, &[], false),
                2 => draw_line(ly, 0.5, &[3.0, 3.0], false),
                3 => draw_line(ly, 0.5, &[1.0, 2.0], false),
                4 => draw_line(ly, 0.5, &[6.0, 2.0, 1.0, 2.0], false),
                5 => draw_line(ly, 0.5, &[6.0, 2.0, 1.0, 2.0, 1.0, 2.0], false),
                6 => draw_line(ly, 0.5, &[8.0, 4.0], false),
                7 => draw_line(ly, 0.7, &[0.1, 2.5], true),
                8 => {
                    draw_line(ly - 1.0, 0.3, &[], false);
                    draw_line(ly + 1.0, 0.3, &[], false);
                }
                9 => {
                    draw_line(ly - 1.2, 0.3, &[], false);
                    draw_line(ly + 0.8, 0.8, &[], false);
                }
                10 => {
                    draw_line(ly - 0.8, 0.8, &[], false);
                    draw_line(ly + 1.2, 0.3, &[], false);
                }
                11 => {
                    draw_line(ly - 2.0, 0.3, &[], false);
                    draw_line(ly, 0.8, &[], false);
                    draw_line(ly + 2.0, 0.3, &[], false);
                }
                _ => draw_line(ly, 0.5, &[1.0, 2.0], false),
            }
        }

        if run.style.emphasis_dot > 0 {
            let dot_char = match run.style.emphasis_dot {
                1 => "●",
                2 => "○",
                3 => "ˇ",
                4 => "˜",
                5 => "･",
                6 => "˸",
                _ => "",
            };
            if !dot_char.is_empty() {
                let mut dot_style = render_style.clone();
                dot_style.font_family = "sans-serif".to_string();
                dot_style.font_size = render_style.font_size * 0.3;
                let dot_font = self.font_resolver.make_font(&dot_style, dot_char);
                let mut dot_paint = Paint::default();
                dot_paint.set_anti_alias(true);
                dot_paint.set_color(colorref_to_skia(run.style.color, 1.0));
                let dot_y = y - render_style.font_size as f32 * 1.05;
                for &char_x in &char_positions[..char_positions.len().saturating_sub(1)] {
                    let dot_x = bbox.x as f32
                        + char_x as f32
                        + (base_font_size * run.style.ratio * 0.5) as f32;
                    canvas.draw_str(dot_char, (dot_x, dot_y), &dot_font, &dot_paint);
                }
            }
        }

        for mark in &run.control_marks {
            self.render_text_control_mark(canvas, bbox, mark, f64::from(y) - bbox.y, replay);
        }
    }

    pub(super) fn render_text_decoration(
        &self,
        canvas: &Canvas,
        bbox: &BoundingBox,
        decoration: &LayerTextDecorationPaint,
    ) {
        let text_width = decoration.positions.last().copied().unwrap_or(0.0) as f32;
        if text_width <= 0.0 {
            return;
        }
        let baseline_y = (bbox.y + decoration.baseline) as f32;
        let font_size = decoration.font_size.max(1.0) as f32;
        match decoration.kind {
            LayerTextDecorationKind::Underline => {
                let y = match decoration.underline {
                    UnderlineType::Top => baseline_y - font_size + 1.0,
                    _ => baseline_y + 2.0,
                };
                self.draw_text_line_shape(
                    canvas,
                    bbox.x as f32,
                    y,
                    bbox.x as f32 + text_width,
                    y,
                    decoration.color,
                    decoration.shape,
                );
            }
            LayerTextDecorationKind::Strikethrough => {
                let y = baseline_y - font_size * 0.3;
                self.draw_text_line_shape(
                    canvas,
                    bbox.x as f32,
                    y,
                    bbox.x as f32 + text_width,
                    y,
                    decoration.color,
                    decoration.shape,
                );
            }
            LayerTextDecorationKind::EmphasisDot => {
                let dot_char = match decoration.emphasis_dot {
                    1 => "●",
                    2 => "○",
                    3 => "ˇ",
                    4 => "˜",
                    5 => "･",
                    6 => "˸",
                    _ => "",
                };
                if dot_char.is_empty() {
                    return;
                }
                let dot_style = crate::renderer::TextStyle {
                    font_family: "sans-serif".to_string(),
                    font_size: f64::from(font_size) * 0.3,
                    ..Default::default()
                };
                let dot_font = self.font_resolver.make_font(&dot_style, dot_char);
                let mut dot_paint = Paint::default();
                dot_paint.set_anti_alias(true);
                dot_paint.set_color(colorref_to_skia(decoration.color, 1.0));
                let dot_y = baseline_y - font_size * 1.05;
                for position in decoration
                    .positions
                    .iter()
                    .take(decoration.positions.len().saturating_sub(1))
                {
                    let dot_x = bbox.x as f32
                        + *position as f32
                        + (decoration.font_size * decoration.ratio * 0.5) as f32;
                    canvas.draw_str(dot_char, (dot_x, dot_y), &dot_font, &dot_paint);
                }
            }
        }
    }

    pub(super) fn render_text_control_mark(
        &self,
        canvas: &Canvas,
        bbox: &BoundingBox,
        mark: &crate::paint::LayerTextControlMark,
        baseline: f64,
        replay: &SkiaReplayContext,
    ) {
        if !replay.output_options.allows_text_control_mark(mark.kind) {
            return;
        }
        let mut marker_paint = Paint::default();
        marker_paint.set_anti_alias(true);
        marker_paint.set_color(Color::from_argb(255, 0x4A, 0x90, 0xD9));
        let marker_style = crate::renderer::TextStyle {
            font_family: "sans-serif".to_string(),
            font_size: mark.font_size,
            ..Default::default()
        };
        let glyph = mark.kind.glyph();
        let marker_font = self.font_resolver.make_font(&marker_style, glyph);
        canvas.draw_str(
            glyph,
            (
                (bbox.x + mark.x) as f32,
                (bbox.y + baseline + mark.y) as f32,
            ),
            &marker_font,
            &marker_paint,
        );
    }

    fn draw_text_line_shape(
        &self,
        canvas: &Canvas,
        x1: f32,
        y1: f32,
        x2: f32,
        y2: f32,
        color: u32,
        shape: u8,
    ) {
        let mut draw_single_line =
            |x1: f32, y1: f32, x2: f32, y2: f32, width: f32, dash: &[f32], round_cap: bool| {
                let mut paint = Paint::default();
                paint.set_anti_alias(true);
                paint.set_style(skia_safe::paint::Style::Stroke);
                paint.set_stroke_width(width);
                paint.set_color(colorref_to_skia(color, 1.0));
                if round_cap {
                    paint.set_stroke_cap(skia_safe::paint::Cap::Round);
                }
                if !dash.is_empty() {
                    if let Some(effect) = skia_safe::PathEffect::dash(dash, 0.0) {
                        paint.set_path_effect(effect);
                    }
                }
                canvas.draw_line((x1, y1), (x2, y2), &paint);
            };

        match shape {
            7 => {
                draw_single_line(x1, y1 - 1.0, x2, y2 - 1.0, 0.7, &[], false);
                draw_single_line(x1, y1 + 1.0, x2, y2 + 1.0, 0.7, &[], false);
            }
            8 => {
                draw_single_line(x1, y1 - 1.2, x2, y2 - 1.2, 0.5, &[], false);
                draw_single_line(x1, y1 + 0.8, x2, y2 + 0.8, 1.2, &[], false);
            }
            9 => {
                draw_single_line(x1, y1 - 0.8, x2, y2 - 0.8, 1.2, &[], false);
                draw_single_line(x1, y1 + 1.2, x2, y2 + 1.2, 0.5, &[], false);
            }
            10 => {
                draw_single_line(x1, y1 - 1.5, x2, y2 - 1.5, 0.5, &[], false);
                draw_single_line(x1, y1, x2, y2, 0.5, &[], false);
                draw_single_line(x1, y1 + 1.5, x2, y2 + 1.5, 0.5, &[], false);
            }
            11 | 12 => {
                let wave_offsets: &[f32] = if shape == 12 { &[-1.0, 1.0] } else { &[0.0] };
                for offset in wave_offsets {
                    let mut path = PathBuilder::new();
                    path.move_to((x1, y1 + offset));
                    let mut current_x = x1;
                    let mut upward = true;
                    while current_x < x2 {
                        let next_x = (current_x + 6.0).min(x2);
                        let control_y = if upward {
                            y1 + offset - 1.5
                        } else {
                            y1 + offset + 1.5
                        };
                        path.quad_to(
                            ((current_x + next_x) / 2.0, control_y),
                            (next_x, y1 + offset),
                        );
                        current_x = next_x;
                        upward = !upward;
                    }
                    let path = path.detach();
                    let mut paint = Paint::default();
                    paint.set_anti_alias(true);
                    paint.set_style(skia_safe::paint::Style::Stroke);
                    paint.set_stroke_width(if shape == 12 { 0.5 } else { 0.7 });
                    paint.set_color(colorref_to_skia(color, 1.0));
                    canvas.draw_path(&path, &paint);
                }
            }
            _ => {
                let dash: &[f32] = match shape {
                    1 => &[3.0, 3.0],
                    2 => &[1.0, 2.0],
                    3 => &[6.0, 2.0, 1.0, 2.0],
                    4 => &[6.0, 2.0, 1.0, 2.0, 1.0, 2.0],
                    5 => &[8.0, 4.0],
                    6 => &[0.1, 2.5],
                    _ => &[],
                };
                draw_single_line(x1, y1, x2, y2, 1.0, dash, shape == 6);
            }
        }
    }
}
