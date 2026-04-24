//! 시각 레이어 IR 모듈
//!
//! semantic render tree를 backend-friendly layer tree로 변환한다.
//!
//! Layer IR lowering contract:
//! - Visible semantics that affect backend parity must be carried in `PaintOp`
//!   payloads, `ClipPolicy`, `LayerOutputOptions`, transforms, or resource handles.
//! - Legacy/direct renderer behavior should be lowered here first, then replayed
//!   by SVG, Canvas2D, CanvasKit, and native Skia.
//! - Backend-local interpretation is acceptable only for renderer mechanics such
//!   as antialiasing policy, caches, and platform font lookup.
//! - Fully shaped glyph runs are a future lower-level IR step; until then,
//!   `LayerTextRunPaint` is the text replay contract and must preserve every
//!   visible text flag exported to browser/native backends.

#![deny(unused_imports, unused_must_use, unused_variables)]

pub mod builder;
#[cfg(target_arch = "wasm32")]
pub mod js_value;
mod json;
pub mod layer_tree;
pub mod paint_op;
pub mod profile;
pub mod resources;
pub mod schema;

pub use builder::LayerBuilder;
pub use layer_tree::{
    CacheHint, ClipKind, ClipPolicy, LayerNode, LayerNodeKind, LayerOutputOptions, LayerSemantic,
    LayerSemanticRole, PageLayerTree,
};
pub use paint_op::{
    LayerEllipsePaint, LayerEquationPaint, LayerFootnoteMarkerPaint, LayerFormObjectPaint,
    LayerImagePaint, LayerLinePaint, LayerPageBackgroundImagePaint, LayerPageBackgroundPaint,
    LayerPathPaint, LayerRectanglePaint, LayerTextRunPaint, PaintBounds, PaintOp,
};
pub use profile::RenderProfile;
pub use resources::{
    image_resource_key, resource_digest_hex, svg_resource_key, ImageResourceId, ResourceArena,
    SvgResourceId,
};
pub use schema::{LayerTreeSchema, LAYER_TREE_SCHEMA};
