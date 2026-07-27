use skia_safe::{Canvas, Color, Paint, PathBuilder, Rect};

use crate::model::control::FormType;
use crate::paint::LayerFormObjectPaint;
use crate::renderer::form_caption::display_form_caption;
use crate::renderer::render_tree::BoundingBox;
use crate::renderer::TextStyle;

use super::font_resolver::SkiaFontResolver;

pub(super) fn render_form_object(
    canvas: &Canvas,
    font_resolver: &SkiaFontResolver,
    bbox: &BoundingBox,
    form: &LayerFormObjectPaint,
) {
    let parse_css = |value: &str, fallback: Color| {
        if let Some(hex) = value.strip_prefix('#') {
            if hex.len() == 6 {
                let parsed = (
                    u8::from_str_radix(&hex[0..2], 16),
                    u8::from_str_radix(&hex[2..4], 16),
                    u8::from_str_radix(&hex[4..6], 16),
                );
                if let (Ok(r), Ok(g), Ok(b)) = parsed {
                    return Color::from_argb(255, r, g, b);
                }
            }
        }
        fallback
    };
    let rect = Rect::from_xywh(
        bbox.x as f32,
        bbox.y as f32,
        bbox.width as f32,
        bbox.height as f32,
    );
    let mut text_style = TextStyle {
        font_family: "Noto Sans CJK KR".to_string(),
        ..Default::default()
    };
    let control_back = parse_css(&form.back_color, Color::WHITE);
    let control_text = if form.enabled {
        parse_css(&form.fore_color, Color::BLACK)
    } else {
        Color::from_argb(255, 128, 128, 128)
    };
    let border_color = if form.enabled {
        Color::from_argb(255, 160, 160, 160)
    } else {
        Color::from_argb(255, 190, 190, 190)
    };

    match form.form_type {
        FormType::PushButton => {
            let mut fill = Paint::default();
            fill.set_anti_alias(true);
            fill.set_color(if form.back_color.is_empty() {
                Color::from_argb(255, 208, 208, 208)
            } else {
                control_back
            });
            canvas.draw_rect(rect, &fill);

            let mut stroke = Paint::default();
            stroke.set_anti_alias(true);
            stroke.set_style(skia_safe::paint::Style::Stroke);
            stroke.set_stroke_width(0.5);
            stroke.set_color(border_color);
            canvas.draw_rect(rect, &stroke);

            if !form.caption.is_empty() {
                let caption = display_form_caption(&form.caption);
                let font_size = (bbox.height * 0.55).clamp(7.0, 12.0);
                text_style.font_size = font_size;
                let font = font_resolver.make_font(&text_style, caption.as_ref());
                let mut paint = Paint::default();
                paint.set_anti_alias(true);
                paint.set_color(control_text);
                let text_width = caption.chars().count() as f32 * font_size as f32 * 0.55;
                canvas.draw_str(
                    caption.as_ref(),
                    (
                        bbox.x as f32 + bbox.width as f32 / 2.0 - text_width / 2.0,
                        bbox.y as f32 + bbox.height as f32 / 2.0 + font_size as f32 * 0.35,
                    ),
                    &font,
                    &paint,
                );
            }
        }
        FormType::CheckBox => {
            let box_size = (bbox.height * 0.7).min(13.0) as f32;
            let box_x = bbox.x as f32 + 2.0;
            let box_y = bbox.y as f32 + (bbox.height as f32 - box_size) / 2.0;

            let mut fill = Paint::default();
            fill.set_anti_alias(true);
            fill.set_color(control_back);
            canvas.draw_rect(Rect::from_xywh(box_x, box_y, box_size, box_size), &fill);

            let mut stroke = Paint::default();
            stroke.set_anti_alias(true);
            stroke.set_style(skia_safe::paint::Style::Stroke);
            stroke.set_stroke_width(0.8);
            stroke.set_color(border_color);
            canvas.draw_rect(Rect::from_xywh(box_x, box_y, box_size, box_size), &stroke);

            if form.value != 0 {
                let mut check = PathBuilder::new();
                check.move_to((box_x + box_size * 0.2, box_y + box_size * 0.55));
                check.line_to((box_x + box_size * 0.45, box_y + box_size * 0.8));
                check.line_to((box_x + box_size * 0.85, box_y + box_size * 0.2));
                let mut mark = Paint::default();
                mark.set_anti_alias(true);
                mark.set_style(skia_safe::paint::Style::Stroke);
                mark.set_stroke_width(1.5);
                mark.set_color(control_text);
                canvas.draw_path(&check.detach(), &mark);
            }

            if !form.caption.is_empty() {
                let caption = display_form_caption(&form.caption);
                let font_size = (bbox.height * 0.55).clamp(7.0, 12.0);
                text_style.font_size = font_size;
                let font = font_resolver.make_font(&text_style, caption.as_ref());
                let mut paint = Paint::default();
                paint.set_anti_alias(true);
                paint.set_color(control_text);
                canvas.draw_str(
                    caption.as_ref(),
                    (
                        box_x + box_size + 3.0,
                        bbox.y as f32 + bbox.height as f32 / 2.0 + font_size as f32 * 0.35,
                    ),
                    &font,
                    &paint,
                );
            }
        }
        FormType::RadioButton => {
            let radius = (bbox.height * 0.3).min(6.5) as f32;
            let cx = bbox.x as f32 + 2.0 + radius;
            let cy = bbox.y as f32 + bbox.height as f32 / 2.0;

            let mut fill = Paint::default();
            fill.set_anti_alias(true);
            fill.set_color(control_back);
            canvas.draw_circle((cx, cy), radius, &fill);

            let mut stroke = Paint::default();
            stroke.set_anti_alias(true);
            stroke.set_style(skia_safe::paint::Style::Stroke);
            stroke.set_stroke_width(0.8);
            stroke.set_color(border_color);
            canvas.draw_circle((cx, cy), radius, &stroke);

            if form.value != 0 {
                let mut dot = Paint::default();
                dot.set_anti_alias(true);
                dot.set_color(control_text);
                canvas.draw_circle((cx, cy), radius * 0.5, &dot);
            }

            if !form.caption.is_empty() {
                let caption = display_form_caption(&form.caption);
                let font_size = (bbox.height * 0.55).clamp(7.0, 12.0);
                text_style.font_size = font_size;
                let font = font_resolver.make_font(&text_style, caption.as_ref());
                let mut paint = Paint::default();
                paint.set_anti_alias(true);
                paint.set_color(control_text);
                canvas.draw_str(
                    caption.as_ref(),
                    (
                        cx + radius + 3.0,
                        bbox.y as f32 + bbox.height as f32 / 2.0 + font_size as f32 * 0.35,
                    ),
                    &font,
                    &paint,
                );
            }
        }
        FormType::ComboBox => {
            let btn_w = (bbox.height * 0.8).min(16.0) as f32;
            let mut fill = Paint::default();
            fill.set_anti_alias(true);
            fill.set_color(control_back);
            canvas.draw_rect(rect, &fill);

            let mut stroke = Paint::default();
            stroke.set_anti_alias(true);
            stroke.set_style(skia_safe::paint::Style::Stroke);
            stroke.set_stroke_width(0.8);
            stroke.set_color(border_color);
            canvas.draw_rect(rect, &stroke);

            let button_rect = Rect::from_xywh(
                bbox.x as f32 + bbox.width as f32 - btn_w,
                bbox.y as f32,
                btn_w,
                bbox.height as f32,
            );
            let mut button_fill = Paint::default();
            button_fill.set_anti_alias(true);
            button_fill.set_color(Color::from_argb(255, 224, 224, 224));
            canvas.draw_rect(button_rect, &button_fill);

            let mut button_stroke = Paint::default();
            button_stroke.set_anti_alias(true);
            button_stroke.set_style(skia_safe::paint::Style::Stroke);
            button_stroke.set_stroke_width(0.5);
            button_stroke.set_color(border_color);
            canvas.draw_rect(button_rect, &button_stroke);

            let arrow_cx = bbox.x as f32 + bbox.width as f32 - btn_w / 2.0;
            let arrow_cy = bbox.y as f32 + bbox.height as f32 / 2.0;
            let arrow_size = (bbox.height * 0.2).min(4.0) as f32;
            let mut arrow = PathBuilder::new();
            arrow.move_to((arrow_cx - arrow_size, arrow_cy - arrow_size * 0.5));
            arrow.line_to((arrow_cx + arrow_size, arrow_cy - arrow_size * 0.5));
            arrow.line_to((arrow_cx, arrow_cy + arrow_size * 0.5));
            arrow.close();
            let mut arrow_paint = Paint::default();
            arrow_paint.set_anti_alias(true);
            arrow_paint.set_color(control_text);
            canvas.draw_path(&arrow.detach(), &arrow_paint);

            if !form.text.is_empty() {
                let font_size = (bbox.height * 0.55).clamp(7.0, 12.0);
                text_style.font_size = font_size;
                let font = font_resolver.make_font(&text_style, &form.text);
                let mut paint = Paint::default();
                paint.set_anti_alias(true);
                paint.set_color(control_text);
                canvas.draw_str(
                    &form.text,
                    (
                        bbox.x as f32 + 3.0,
                        bbox.y as f32 + bbox.height as f32 / 2.0 + font_size as f32 * 0.35,
                    ),
                    &font,
                    &paint,
                );
            }
        }
        FormType::Edit => {
            let mut fill = Paint::default();
            fill.set_anti_alias(true);
            fill.set_color(control_back);
            canvas.draw_rect(rect, &fill);

            let mut stroke = Paint::default();
            stroke.set_anti_alias(true);
            stroke.set_style(skia_safe::paint::Style::Stroke);
            stroke.set_stroke_width(0.8);
            stroke.set_color(border_color);
            canvas.draw_rect(rect, &stroke);

            if !form.text.is_empty() {
                let font_size = (bbox.height * 0.55).clamp(7.0, 12.0);
                text_style.font_size = font_size;
                let font = font_resolver.make_font(&text_style, &form.text);
                let mut paint = Paint::default();
                paint.set_anti_alias(true);
                paint.set_color(control_text);
                canvas.draw_str(
                    &form.text,
                    (
                        bbox.x as f32 + 3.0,
                        bbox.y as f32 + bbox.height as f32 / 2.0 + font_size as f32 * 0.35,
                    ),
                    &font,
                    &paint,
                );
            }
        }
    }
}
