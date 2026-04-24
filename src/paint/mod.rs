//! 시각 레이어 IR 모듈
//!
//! semantic render tree를 backend-friendly layer tree로 변환한다.

pub mod builder;
#[cfg(target_arch = "wasm32")]
pub mod js_value;
mod json;
pub mod layer_tree;
pub mod paint_op;
pub mod profile;
pub mod resources;

pub use builder::LayerBuilder;
pub use layer_tree::{
    CacheHint, ClipKind, LayerNode, LayerNodeKind, LayerOutputOptions, LayerSemantic,
    LayerSemanticRole, PageLayerTree,
};
pub use paint_op::{
    LayerEllipsePaint, LayerEquationPaint, LayerFootnoteMarkerPaint, LayerFormObjectPaint,
    LayerImagePaint, LayerLinePaint, LayerPageBackgroundImagePaint, LayerPageBackgroundPaint,
    LayerPathPaint, LayerRectanglePaint, LayerTextRunPaint, PaintOp,
};
pub use profile::RenderProfile;
pub use resources::{ImageResourceId, ResourceArena, SvgResourceId};
