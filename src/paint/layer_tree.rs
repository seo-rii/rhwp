use crate::paint::paint_op::PaintOp;
use crate::paint::profile::RenderProfile;
use crate::paint::resources::ResourceArena;
use crate::renderer::render_tree::{
    BoundingBox, GroupNode, NodeId, TableCellNode, TableNode, TextLineNode,
};

/// 한 페이지의 visual layer tree.
///
/// 최종 lean visual IR이라기보다는 semantic render tree에서 backend replay용으로
/// 내려가는 1차 전환 표현이다. backend가 다시 레이아웃을 해석하지 않도록 clip/group/
/// leaf 순서와 paint payload를 고정하되, 일부 semantic 메타데이터는 아직 유지한다.
#[derive(Debug, Clone)]
pub struct PageLayerTree {
    pub page_width: f64,
    pub page_height: f64,
    pub profile: RenderProfile,
    pub root: LayerNode,
    pub resources: ResourceArena,
}

impl PageLayerTree {
    pub fn new(page_width: f64, page_height: f64, root: LayerNode) -> Self {
        Self::with_resources_and_profile(
            page_width,
            page_height,
            root,
            ResourceArena::default(),
            RenderProfile::default(),
        )
    }

    pub fn with_resources(
        page_width: f64,
        page_height: f64,
        root: LayerNode,
        resources: ResourceArena,
    ) -> Self {
        Self::with_resources_and_profile(
            page_width,
            page_height,
            root,
            resources,
            RenderProfile::default(),
        )
    }

    pub fn with_profile(
        page_width: f64,
        page_height: f64,
        root: LayerNode,
        profile: RenderProfile,
    ) -> Self {
        Self::with_resources_and_profile(
            page_width,
            page_height,
            root,
            ResourceArena::default(),
            profile,
        )
    }

    pub fn with_resources_and_profile(
        page_width: f64,
        page_height: f64,
        root: LayerNode,
        resources: ResourceArena,
        profile: RenderProfile,
    ) -> Self {
        Self {
            page_width,
            page_height,
            profile,
            root,
            resources,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CacheHint {
    #[default]
    None,
    StaticSubtree,
    PreferRaster,
    PreferVectorRecording,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClipKind {
    Body,
    TableCell,
    Generic,
}

#[derive(Debug, Clone)]
pub struct LayerNode {
    pub bounds: BoundingBox,
    pub source_node_id: Option<NodeId>,
    pub kind: LayerNodeKind,
}

impl LayerNode {
    pub fn group(
        bounds: BoundingBox,
        source_node_id: Option<NodeId>,
        children: Vec<LayerNode>,
        cache_hint: CacheHint,
        group_kind: GroupKind,
    ) -> Self {
        Self {
            bounds,
            source_node_id,
            kind: LayerNodeKind::Group {
                children,
                cache_hint,
                group_kind,
            },
        }
    }

    pub fn clip_rect(
        bounds: BoundingBox,
        source_node_id: Option<NodeId>,
        clip: BoundingBox,
        child: LayerNode,
        clip_kind: ClipKind,
    ) -> Self {
        Self {
            bounds,
            source_node_id,
            kind: LayerNodeKind::ClipRect {
                clip,
                child: Box::new(child),
                clip_kind,
            },
        }
    }

    pub fn leaf(bounds: BoundingBox, source_node_id: Option<NodeId>, ops: Vec<PaintOp>) -> Self {
        Self::leaf_with_hint(bounds, source_node_id, ops, CacheHint::None)
    }

    pub fn leaf_with_hint(
        bounds: BoundingBox,
        source_node_id: Option<NodeId>,
        ops: Vec<PaintOp>,
        cache_hint: CacheHint,
    ) -> Self {
        Self {
            bounds,
            source_node_id,
            kind: LayerNodeKind::Leaf { ops, cache_hint },
        }
    }
}

#[derive(Debug, Clone)]
pub enum LayerNodeKind {
    Group {
        children: Vec<LayerNode>,
        cache_hint: CacheHint,
        group_kind: GroupKind,
    },
    ClipRect {
        clip: BoundingBox,
        child: Box<LayerNode>,
        clip_kind: ClipKind,
    },
    Leaf {
        ops: Vec<PaintOp>,
        cache_hint: CacheHint,
    },
}

#[derive(Debug, Clone)]
pub enum GroupKind {
    Generic,
    MasterPage,
    Header,
    Footer,
    Body,
    Column(u16),
    FootnoteArea,
    TextLine(TextLineNode),
    Table(TableNode),
    TableCell(TableCellNode),
    TextBox,
    Group(GroupNode),
}
