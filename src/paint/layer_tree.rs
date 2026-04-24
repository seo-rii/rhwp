use crate::paint::paint_op::PaintOp;
use crate::paint::profile::RenderProfile;
use crate::paint::resources::ResourceArena;
use crate::renderer::render_tree::{BoundingBox, NodeId};

/// 한 페이지의 visual layer tree.
///
/// Semantic render tree에서 backend replay용으로 내려간 안정화된 visual IR이다.
/// backend가 다시 레이아웃을 해석하지 않도록 clip/group/leaf 순서와 paint payload를
/// 고정하고, 문서 의미는 `LayerSemantic`의 작은 디버그/히트테스트 메타데이터로만
/// 분리해 둔다.
#[derive(Debug, Clone)]
pub struct PageLayerTree {
    pub page_width: f64,
    pub page_height: f64,
    pub profile: RenderProfile,
    pub output_options: LayerOutputOptions,
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
            output_options: LayerOutputOptions::default(),
            root,
            resources,
        }
    }

    pub fn with_output_options(mut self, output_options: LayerOutputOptions) -> Self {
        self.output_options = output_options;
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct LayerOutputOptions {
    pub show_paragraph_marks: bool,
    pub show_control_codes: bool,
    pub show_transparent_borders: bool,
    pub clip_enabled: bool,
    pub debug_overlay: bool,
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
    pub semantic: LayerSemantic,
    pub kind: LayerNodeKind,
}

impl LayerNode {
    pub fn group(
        bounds: BoundingBox,
        source_node_id: Option<NodeId>,
        children: Vec<LayerNode>,
        cache_hint: CacheHint,
        semantic: LayerSemantic,
    ) -> Self {
        Self {
            bounds,
            source_node_id,
            semantic,
            kind: LayerNodeKind::Group {
                children,
                cache_hint,
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
            semantic: LayerSemantic::default(),
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
            semantic: LayerSemantic::default(),
            kind: LayerNodeKind::Leaf { ops, cache_hint },
        }
    }
}

#[derive(Debug, Clone)]
pub enum LayerNodeKind {
    Group {
        children: Vec<LayerNode>,
        cache_hint: CacheHint,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LayerSemanticRole {
    #[default]
    Generic,
    Page,
    MasterPage,
    Header,
    Footer,
    Body,
    Column,
    FootnoteArea,
    TextLine,
    Table,
    TableCell,
    TextBox,
    Group,
}

impl LayerSemanticRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Generic => "generic",
            Self::Page => "page",
            Self::MasterPage => "masterPage",
            Self::Header => "header",
            Self::Footer => "footer",
            Self::Body => "body",
            Self::Column => "column",
            Self::FootnoteArea => "footnoteArea",
            Self::TextLine => "textLine",
            Self::Table => "table",
            Self::TableCell => "tableCell",
            Self::TextBox => "textBox",
            Self::Group => "group",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct LayerSemantic {
    pub role: LayerSemanticRole,
    pub section_index: Option<usize>,
    pub column_index: Option<u16>,
    pub para_index: Option<usize>,
    pub control_index: Option<usize>,
    pub row_count: Option<u16>,
    pub col_count: Option<u16>,
}

impl LayerSemantic {
    pub fn role(role: LayerSemanticRole) -> Self {
        Self {
            role,
            ..Self::default()
        }
    }

    pub fn column(index: u16) -> Self {
        Self {
            role: LayerSemanticRole::Column,
            column_index: Some(index),
            ..Self::default()
        }
    }

    pub fn text_line(section_index: Option<usize>, para_index: Option<usize>) -> Self {
        Self {
            role: LayerSemanticRole::TextLine,
            section_index,
            para_index,
            ..Self::default()
        }
    }

    pub fn table(
        section_index: Option<usize>,
        para_index: Option<usize>,
        control_index: Option<usize>,
        row_count: u16,
        col_count: u16,
    ) -> Self {
        Self {
            role: LayerSemanticRole::Table,
            section_index,
            column_index: None,
            para_index,
            control_index,
            row_count: Some(row_count),
            col_count: Some(col_count),
        }
    }
}
