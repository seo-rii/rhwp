use crate::model::control::FormType;
use crate::model::image::ImageEffect;
use crate::model::style::{ImageFillMode, UnderlineType};
use crate::model::ColorRef;
use crate::paint::resources::{ImageResourceId, SvgResourceId};
use crate::renderer::composer::CharOverlapInfo;
use crate::renderer::equation::layout::LayoutBox;
use crate::renderer::render_tree::{BoundingBox, FieldMarkerType, ShapeTransform};
use crate::renderer::{
    ArrowStyle, GradientFillInfo, LineRenderType, LineStyle, PathCommand, ShapeStyle, TextStyle,
};

/// backend가 재생하는 leaf paint operation.
///
/// 전환기 IR에서는 leaf draw payload만 유지하고, 큰 바이너리/문자열 자원은
/// `ResourceArena` handle로 분리한다.
#[derive(Debug, Clone)]
pub enum PaintOp {
    PageBackground {
        bbox: BoundingBox,
        background: LayerPageBackgroundPaint,
    },
    TextRun {
        bbox: BoundingBox,
        run: LayerTextRunPaint,
    },
    FootnoteMarker {
        bbox: BoundingBox,
        marker: LayerFootnoteMarkerPaint,
    },
    Line {
        bbox: BoundingBox,
        line: LayerLinePaint,
    },
    Rectangle {
        bbox: BoundingBox,
        rect: LayerRectanglePaint,
    },
    Ellipse {
        bbox: BoundingBox,
        ellipse: LayerEllipsePaint,
    },
    Path {
        bbox: BoundingBox,
        path: LayerPathPaint,
    },
    Image {
        bbox: BoundingBox,
        image: LayerImagePaint,
    },
    Equation {
        bbox: BoundingBox,
        equation: LayerEquationPaint,
    },
    FormObject {
        bbox: BoundingBox,
        form: LayerFormObjectPaint,
    },
}

#[derive(Debug, Clone)]
pub struct LayerFootnoteMarkerPaint {
    pub text: String,
    pub font_family: String,
    pub base_font_size: f64,
    pub color: u32,
}

#[derive(Debug, Clone)]
pub struct LayerTextRunPaint {
    pub text: String,
    pub style: TextStyle,
    pub positions: Vec<f64>,
    pub control_marks: Vec<LayerTextControlMark>,
    pub baseline: f64,
    pub rotation: f64,
    pub is_vertical: bool,
    pub char_overlap: Option<CharOverlapInfo>,
    pub field_marker: FieldMarkerType,
    pub is_para_end: bool,
    pub is_line_break_end: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LayerTextControlMarkKind {
    Space,
    Tab,
    ParagraphEnd,
    LineBreakEnd,
}

impl LayerTextControlMarkKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Space => "space",
            Self::Tab => "tab",
            Self::ParagraphEnd => "paragraphEnd",
            Self::LineBreakEnd => "lineBreakEnd",
        }
    }

    pub fn glyph(self) -> &'static str {
        match self {
            Self::Space => "\u{2228}",
            Self::Tab => "\u{2192}",
            Self::ParagraphEnd => "\u{21B5}",
            Self::LineBreakEnd => "\u{2193}",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct LayerTextControlMark {
    pub kind: LayerTextControlMarkKind,
    /// X offset relative to the rendered text origin.
    pub x: f64,
    /// Y offset relative to the rendered text baseline.
    pub y: f64,
    pub font_size: f64,
}

#[derive(Debug, Clone)]
pub struct LayerLinePaint {
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
    pub style: LineStyle,
    pub transform: ShapeTransform,
}

#[derive(Debug, Clone)]
pub struct LayerRectanglePaint {
    pub corner_radius: f64,
    pub style: ShapeStyle,
    pub gradient: Option<Box<GradientFillInfo>>,
    pub transform: ShapeTransform,
}

#[derive(Debug, Clone)]
pub struct LayerEllipsePaint {
    pub style: ShapeStyle,
    pub gradient: Option<Box<GradientFillInfo>>,
    pub transform: ShapeTransform,
}

#[derive(Debug, Clone)]
pub struct LayerPathPaint {
    pub commands: Vec<PathCommand>,
    pub style: ShapeStyle,
    pub gradient: Option<Box<GradientFillInfo>>,
    pub transform: ShapeTransform,
    pub connector_endpoints: Option<(f64, f64, f64, f64)>,
    pub line_style: Option<LineStyle>,
}

#[derive(Debug, Clone)]
pub struct LayerPageBackgroundPaint {
    pub background_color: Option<ColorRef>,
    pub border_color: Option<ColorRef>,
    pub border_width: f64,
    pub gradient: Option<Box<GradientFillInfo>>,
    pub image: Option<LayerPageBackgroundImagePaint>,
}

#[derive(Debug, Clone)]
pub struct LayerPageBackgroundImagePaint {
    pub resource_id: ImageResourceId,
    pub fill_mode: ImageFillMode,
}

#[derive(Debug, Clone)]
pub struct LayerImagePaint {
    pub resource_id: Option<ImageResourceId>,
    pub fill_mode: Option<ImageFillMode>,
    pub original_size: Option<(f64, f64)>,
    pub crop: Option<(i32, i32, i32, i32)>,
    pub effect: ImageEffect,
    pub transform: ShapeTransform,
}

#[derive(Debug, Clone)]
pub struct LayerEquationPaint {
    pub svg_resource_id: SvgResourceId,
    pub layout_box: LayoutBox,
    pub color_str: String,
    pub color: u32,
    pub font_size: f64,
}

#[derive(Debug, Clone)]
pub struct LayerFormObjectPaint {
    pub form_type: FormType,
    pub caption: String,
    pub text: String,
    pub fore_color: String,
    pub back_color: String,
    pub value: i32,
    pub enabled: bool,
}

impl PaintOp {
    pub fn paint_bounds(&self) -> PaintBounds {
        let logical = match self {
            PaintOp::PageBackground { bbox, .. }
            | PaintOp::TextRun { bbox, .. }
            | PaintOp::FootnoteMarker { bbox, .. }
            | PaintOp::Line { bbox, .. }
            | PaintOp::Rectangle { bbox, .. }
            | PaintOp::Ellipse { bbox, .. }
            | PaintOp::Path { bbox, .. }
            | PaintOp::Image { bbox, .. }
            | PaintOp::Equation { bbox, .. }
            | PaintOp::FormObject { bbox, .. } => *bbox,
        };
        let expand = |bbox: BoundingBox, amount: f64| {
            let amount = amount.max(0.0);
            BoundingBox::new(
                bbox.x - amount,
                bbox.y - amount,
                bbox.width + amount * 2.0,
                bbox.height + amount * 2.0,
            )
        };
        let union = |a: BoundingBox, b: BoundingBox| {
            let left = a.x.min(b.x);
            let top = a.y.min(b.y);
            let right = (a.x + a.width).max(b.x + b.width);
            let bottom = (a.y + a.height).max(b.y + b.height);
            BoundingBox::new(left, top, right - left, bottom - top)
        };
        let include_shadow =
            |visual: BoundingBox, base: BoundingBox, shadow: &crate::renderer::ShadowStyle| {
                let shadow_box = BoundingBox::new(
                    base.x + shadow.offset_x,
                    base.y + shadow.offset_y,
                    base.width,
                    base.height,
                );
                union(
                    visual,
                    expand(shadow_box, shadow.offset_x.abs().max(shadow.offset_y.abs())),
                )
            };

        let visual = match self {
            PaintOp::PageBackground { background, .. } => {
                expand(logical, background.border_width.max(0.0) * 0.5)
            }
            PaintOp::TextRun { bbox, run } => {
                let style = &run.style;
                let mut amount = 0.0_f64;
                if style.underline != UnderlineType::None || style.strikethrough {
                    amount = amount.max(style.font_size * 0.2);
                }
                if style.outline_type > 0 || style.emboss || style.engrave {
                    amount = amount.max(style.font_size * 0.15);
                }
                if style.emphasis_dot > 0 {
                    amount = amount.max(style.font_size * 0.35);
                }
                let mut visual = expand(logical, amount);
                if style.shadow_type > 0 {
                    let shadow_box = BoundingBox::new(
                        logical.x + style.shadow_offset_x,
                        logical.y + style.shadow_offset_y,
                        logical.width,
                        logical.height,
                    );
                    visual = union(
                        visual,
                        expand(
                            shadow_box,
                            style
                                .shadow_offset_x
                                .abs()
                                .max(style.shadow_offset_y.abs())
                                .max(style.font_size * 0.1),
                        ),
                    );
                }
                for mark in &run.control_marks {
                    let mark_box = BoundingBox::new(
                        bbox.x + mark.x,
                        bbox.y + run.baseline + mark.y - mark.font_size,
                        mark.font_size,
                        mark.font_size * 1.2,
                    );
                    visual = union(visual, mark_box);
                }
                visual
            }
            PaintOp::FootnoteMarker { marker, .. } => {
                expand(logical, marker.base_font_size.max(0.0) * 0.15)
            }
            PaintOp::Line { line, .. } => {
                let mut amount = line.style.width.max(0.0) * 0.5;
                if line.style.line_type != LineRenderType::Single {
                    amount = amount.max(line.style.width.max(1.0) * 2.0);
                }
                if line.style.start_arrow != ArrowStyle::None
                    || line.style.end_arrow != ArrowStyle::None
                {
                    amount = amount.max(line.style.width.max(1.0) * 8.0);
                }
                let mut visual = expand(logical, amount);
                if let Some(shadow) = &line.style.shadow {
                    visual = include_shadow(visual, logical, shadow);
                }
                visual
            }
            PaintOp::Rectangle { rect, .. } => {
                let mut visual = expand(logical, rect.style.stroke_width.max(0.0) * 0.5);
                if let Some(shadow) = &rect.style.shadow {
                    visual = include_shadow(visual, logical, shadow);
                }
                visual
            }
            PaintOp::Ellipse { ellipse, .. } => {
                let mut visual = expand(logical, ellipse.style.stroke_width.max(0.0) * 0.5);
                if let Some(shadow) = &ellipse.style.shadow {
                    visual = include_shadow(visual, logical, shadow);
                }
                visual
            }
            PaintOp::Path { path, .. } => {
                let mut amount = path.style.stroke_width.max(0.0) * 0.5;
                if let Some(line_style) = &path.line_style {
                    amount = amount.max(line_style.width.max(0.0) * 0.5);
                    if line_style.line_type != LineRenderType::Single {
                        amount = amount.max(line_style.width.max(1.0) * 2.0);
                    }
                    if line_style.start_arrow != ArrowStyle::None
                        || line_style.end_arrow != ArrowStyle::None
                    {
                        amount = amount.max(line_style.width.max(1.0) * 8.0);
                    }
                }
                let mut visual = expand(logical, amount);
                if let Some(shadow) = &path.style.shadow {
                    visual = include_shadow(visual, logical, shadow);
                }
                visual
            }
            PaintOp::Image { .. } | PaintOp::Equation { .. } | PaintOp::FormObject { .. } => {
                logical
            }
        };

        PaintBounds { logical, visual }
    }

    pub fn bounds(&self) -> BoundingBox {
        self.paint_bounds().logical
    }

    pub fn visual_bounds(&self) -> BoundingBox {
        self.paint_bounds().visual
    }
}

#[derive(Debug, Clone, Copy)]
pub struct PaintBounds {
    pub logical: BoundingBox,
    pub visual: BoundingBox,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::renderer::{StrokeDash, TextStyle};

    #[test]
    fn visual_bounds_expand_for_line_stroke_and_arrow() {
        let bbox = BoundingBox::new(10.0, 20.0, 30.0, 4.0);
        let op = PaintOp::Line {
            bbox,
            line: LayerLinePaint {
                x1: 10.0,
                y1: 22.0,
                x2: 40.0,
                y2: 22.0,
                style: LineStyle {
                    color: 0,
                    width: 4.0,
                    dash: StrokeDash::Solid,
                    line_type: LineRenderType::Double,
                    start_arrow: ArrowStyle::Arrow,
                    end_arrow: ArrowStyle::None,
                    start_arrow_size: 8,
                    end_arrow_size: 0,
                    shadow: None,
                },
                transform: Default::default(),
            },
        };
        let bounds = op.paint_bounds();

        assert_eq!(bounds.logical.x, bbox.x);
        assert!(bounds.visual.x < bbox.x);
        assert!(bounds.visual.width > bbox.width);
        assert!(bounds.visual.height > bbox.height);
    }

    #[test]
    fn visual_bounds_include_text_decoration_and_shadow() {
        let bbox = BoundingBox::new(10.0, 20.0, 40.0, 16.0);
        let op = PaintOp::TextRun {
            bbox,
            run: LayerTextRunPaint {
                text: "text".to_string(),
                style: TextStyle {
                    font_size: 20.0,
                    underline: UnderlineType::Bottom,
                    shadow_type: 1,
                    shadow_offset_x: 8.0,
                    shadow_offset_y: 3.0,
                    ..Default::default()
                },
                positions: vec![0.0, 10.0, 20.0, 30.0],
                control_marks: Vec::new(),
                baseline: 14.0,
                rotation: 0.0,
                is_vertical: false,
                char_overlap: None,
                field_marker: Default::default(),
                is_para_end: false,
                is_line_break_end: false,
            },
        };
        let bounds = op.paint_bounds();

        assert_eq!(bounds.logical.y, bbox.y);
        assert!(bounds.visual.x < bbox.x);
        assert!(bounds.visual.width > bbox.width + 8.0);
        assert!(bounds.visual.height > bbox.height);
    }
}
