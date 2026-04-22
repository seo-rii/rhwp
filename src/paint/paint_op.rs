use crate::model::control::FormType;
use crate::model::image::ImageEffect;
use crate::model::style::ImageFillMode;
use crate::model::ColorRef;
use crate::paint::resources::{ImageResourceId, SvgResourceId};
use crate::renderer::equation::layout::LayoutBox;
use crate::renderer::render_tree::{BoundingBox, ShapeTransform, TextRunNode};
use crate::renderer::{
    GradientFillInfo, LineStyle, PathCommand, ShapeStyle,
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
        run: TextRunNode,
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
    pub fn bounds(&self) -> BoundingBox {
        match self {
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
        }
    }
}
