use crate::paint::layer_tree::{
    CacheHint, ClipKind, GroupKind, LayerNode, LayerNodeKind, PageLayerTree,
};
use crate::paint::paint_op::{
    LayerEllipsePaint, LayerEquationPaint, LayerFootnoteMarkerPaint, LayerFormObjectPaint,
    LayerImagePaint, LayerLinePaint, LayerPageBackgroundImagePaint, LayerPageBackgroundPaint,
    LayerPathPaint, LayerRectanglePaint, PaintOp,
};
use crate::paint::profile::RenderProfile;
use crate::paint::resources::ResourceArena;
use crate::renderer::render_tree::{PageRenderTree, RenderNode, RenderNodeType};

/// semantic render tree를 visual layer tree로 내린다.
pub struct LayerBuilder {
    profile: RenderProfile,
    resources: ResourceArena,
}

impl LayerBuilder {
    pub fn new(profile: RenderProfile) -> Self {
        Self {
            profile,
            resources: ResourceArena::default(),
        }
    }

    pub fn build(&mut self, tree: &PageRenderTree) -> PageLayerTree {
        self.resources = ResourceArena::default();
        let (page_width, page_height) = match &tree.root.node_type {
            RenderNodeType::Page(page) => (page.width, page.height),
            _ => (tree.root.bbox.width, tree.root.bbox.height),
        };

        let root = LayerNode::group(
            tree.root.bbox,
            Some(tree.root.id),
            self.build_children(&tree.root),
            self.cache_hint_for(&tree.root.node_type),
            GroupKind::Generic,
        );

        PageLayerTree::with_resources_and_profile(
            page_width,
            page_height,
            root,
            std::mem::take(&mut self.resources),
            self.profile,
        )
    }

    fn build_children(&mut self, node: &RenderNode) -> Vec<LayerNode> {
        node.children
            .iter()
            .filter_map(|child| self.build_node(child))
            .collect()
    }

    fn build_node(&mut self, node: &RenderNode) -> Option<LayerNode> {
        if !node.visible {
            return None;
        }

        match &node.node_type {
            RenderNodeType::PageBackground(background) => {
                let background = self.build_page_background_paint(background);
                Some(self.build_paint_node(
                    node,
                    PaintOp::PageBackground {
                        bbox: node.bbox,
                        background,
                    },
                ))
            }
            RenderNodeType::TextRun(run) => Some(self.build_paint_node(
                node,
                PaintOp::TextRun {
                    bbox: node.bbox,
                    run: run.clone(),
                },
            )),
            RenderNodeType::FootnoteMarker(marker) => Some(self.build_paint_node(
                node,
                PaintOp::FootnoteMarker {
                    bbox: node.bbox,
                    marker: self.build_footnote_marker_paint(marker),
                },
            )),
            RenderNodeType::Line(line) => Some(self.build_paint_node(
                node,
                PaintOp::Line {
                    bbox: node.bbox,
                    line: self.build_line_paint(line),
                },
            )),
            RenderNodeType::Rectangle(rect) => Some(self.build_paint_node(
                node,
                PaintOp::Rectangle {
                    bbox: node.bbox,
                    rect: self.build_rectangle_paint(rect),
                },
            )),
            RenderNodeType::Ellipse(ellipse) => Some(self.build_paint_node(
                node,
                PaintOp::Ellipse {
                    bbox: node.bbox,
                    ellipse: self.build_ellipse_paint(ellipse),
                },
            )),
            RenderNodeType::Path(path) => Some(self.build_paint_node(
                node,
                PaintOp::Path {
                    bbox: node.bbox,
                    path: self.build_path_paint(path),
                },
            )),
            RenderNodeType::Image(image) => {
                let image = self.build_image_paint(image);
                Some(self.build_paint_node(
                    node,
                    PaintOp::Image {
                        bbox: node.bbox,
                        image,
                    },
                ))
            }
            RenderNodeType::Equation(equation) => {
                let equation = self.build_equation_paint(equation);
                Some(self.build_paint_node(
                    node,
                    PaintOp::Equation {
                        bbox: node.bbox,
                        equation,
                    },
                ))
            }
            RenderNodeType::FormObject(form) => Some(self.build_paint_node(
                node,
                PaintOp::FormObject {
                    bbox: node.bbox,
                    form: self.build_form_object_paint(form),
                },
            )),
            RenderNodeType::Body {
                clip_rect: Some(clip),
            } => {
                let child = LayerNode::group(
                    node.bbox,
                    Some(node.id),
                    self.build_children(node),
                    self.cache_hint_for(&node.node_type),
                    GroupKind::Body,
                );
                Some(LayerNode::clip_rect(
                    node.bbox,
                    Some(node.id),
                    *clip,
                    child,
                    ClipKind::Body,
                ))
            }
            RenderNodeType::TableCell(cell) if cell.clip => {
                let child = LayerNode::group(
                    node.bbox,
                    Some(node.id),
                    self.build_children(node),
                    self.cache_hint_for(&node.node_type),
                    GroupKind::TableCell(cell.clone()),
                );
                Some(LayerNode::clip_rect(
                    node.bbox,
                    Some(node.id),
                    node.bbox,
                    child,
                    ClipKind::TableCell,
                ))
            }
            _ => Some(LayerNode::group(
                node.bbox,
                Some(node.id),
                self.build_children(node),
                self.cache_hint_for(&node.node_type),
                self.group_kind_for(&node.node_type),
            )),
        }
    }

    fn build_paint_node(&mut self, node: &RenderNode, op: PaintOp) -> LayerNode {
        if node.children.is_empty() {
            return LayerNode::leaf_with_hint(
                node.bbox,
                Some(node.id),
                vec![op],
                self.cache_hint_for(&node.node_type),
            );
        }

        let mut children = Vec::with_capacity(node.children.len() + 1);
        children.push(LayerNode::leaf_with_hint(
            node.bbox,
            Some(node.id),
            vec![op],
            self.cache_hint_for(&node.node_type),
        ));
        children.extend(self.build_children(node));

        LayerNode::group(
            node.bbox,
            None,
            children,
            self.cache_hint_for(&node.node_type),
            GroupKind::Generic,
        )
    }

    fn build_page_background_paint(
        &mut self,
        background: &crate::renderer::render_tree::PageBackgroundNode,
    ) -> LayerPageBackgroundPaint {
        LayerPageBackgroundPaint {
            background_color: background.background_color,
            border_color: background.border_color,
            border_width: background.border_width,
            gradient: background.gradient.clone(),
            image: background
                .image
                .as_ref()
                .map(|image| LayerPageBackgroundImagePaint {
                    resource_id: self.resources.intern_image_bytes(&image.data),
                    fill_mode: image.fill_mode,
                }),
        }
    }

    fn build_footnote_marker_paint(
        &self,
        marker: &crate::renderer::render_tree::FootnoteMarkerNode,
    ) -> LayerFootnoteMarkerPaint {
        LayerFootnoteMarkerPaint {
            text: marker.text.clone(),
            font_family: marker.font_family.clone(),
            base_font_size: marker.base_font_size,
            color: marker.color,
        }
    }

    fn build_line_paint(
        &self,
        line: &crate::renderer::render_tree::LineNode,
    ) -> LayerLinePaint {
        LayerLinePaint {
            x1: line.x1,
            y1: line.y1,
            x2: line.x2,
            y2: line.y2,
            style: line.style.clone(),
            transform: line.transform,
        }
    }

    fn build_rectangle_paint(
        &self,
        rect: &crate::renderer::render_tree::RectangleNode,
    ) -> LayerRectanglePaint {
        LayerRectanglePaint {
            corner_radius: rect.corner_radius,
            style: rect.style.clone(),
            gradient: rect.gradient.clone(),
            transform: rect.transform,
        }
    }

    fn build_ellipse_paint(
        &self,
        ellipse: &crate::renderer::render_tree::EllipseNode,
    ) -> LayerEllipsePaint {
        LayerEllipsePaint {
            style: ellipse.style.clone(),
            gradient: ellipse.gradient.clone(),
            transform: ellipse.transform,
        }
    }

    fn build_path_paint(
        &self,
        path: &crate::renderer::render_tree::PathNode,
    ) -> LayerPathPaint {
        LayerPathPaint {
            commands: path.commands.clone(),
            style: path.style.clone(),
            gradient: path.gradient.clone(),
            transform: path.transform,
            connector_endpoints: path.connector_endpoints,
            line_style: path.line_style.clone(),
        }
    }

    fn build_image_paint(
        &mut self,
        image: &crate::renderer::render_tree::ImageNode,
    ) -> LayerImagePaint {
        LayerImagePaint {
            resource_id: image
                .data
                .as_deref()
                .map(|bytes| self.resources.intern_image_bytes(bytes)),
            fill_mode: image.fill_mode,
            original_size: image.original_size,
            crop: image.crop,
            effect: image.effect,
            transform: image.transform,
        }
    }

    fn build_form_object_paint(
        &self,
        form: &crate::renderer::render_tree::FormObjectNode,
    ) -> LayerFormObjectPaint {
        LayerFormObjectPaint {
            form_type: form.form_type,
            caption: form.caption.clone(),
            text: form.text.clone(),
            fore_color: form.fore_color.clone(),
            back_color: form.back_color.clone(),
            value: form.value,
            enabled: form.enabled,
        }
    }

    fn build_equation_paint(
        &mut self,
        equation: &crate::renderer::render_tree::EquationNode,
    ) -> LayerEquationPaint {
        LayerEquationPaint {
            svg_resource_id: self.resources.intern_svg_fragment(&equation.svg_content),
            layout_box: equation.layout_box.clone(),
            color_str: equation.color_str.clone(),
            color: equation.color,
            font_size: equation.font_size,
        }
    }

    fn cache_hint_for(&self, node_type: &RenderNodeType) -> CacheHint {
        match node_type {
            RenderNodeType::Header | RenderNodeType::Footer | RenderNodeType::MasterPage => {
                CacheHint::StaticSubtree
            }
            RenderNodeType::PageBackground(_)
                if matches!(self.profile, RenderProfile::FastPreview) =>
            {
                CacheHint::PreferRaster
            }
            RenderNodeType::Line(_)
            | RenderNodeType::Rectangle(_)
            | RenderNodeType::Ellipse(_)
            | RenderNodeType::Path(_)
            | RenderNodeType::Equation(_)
                if matches!(
                    self.profile,
                    RenderProfile::Print | RenderProfile::HighQuality
                ) =>
            {
                CacheHint::PreferVectorRecording
            }
            _ => CacheHint::None,
        }
    }

    fn group_kind_for(&self, node_type: &RenderNodeType) -> GroupKind {
        match node_type {
            RenderNodeType::MasterPage => GroupKind::MasterPage,
            RenderNodeType::Header => GroupKind::Header,
            RenderNodeType::Footer => GroupKind::Footer,
            RenderNodeType::Body { .. } => GroupKind::Body,
            RenderNodeType::Column(index) => GroupKind::Column(*index),
            RenderNodeType::FootnoteArea => GroupKind::FootnoteArea,
            RenderNodeType::TextLine(line) => GroupKind::TextLine(line.clone()),
            RenderNodeType::Table(table) => GroupKind::Table(table.clone()),
            RenderNodeType::TableCell(cell) => GroupKind::TableCell(cell.clone()),
            RenderNodeType::TextBox => GroupKind::TextBox,
            RenderNodeType::Group(group) => GroupKind::Group(group.clone()),
            _ => GroupKind::Generic,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::renderer::render_tree::{
        BoundingBox, PageBackgroundNode, PageNode, RenderNode, RenderNodeType, TableCellNode,
    };
    use crate::renderer::render_tree::{EquationNode, ImageNode};

    #[test]
    fn builds_body_clip_layer() {
        let mut tree = PageRenderTree::new(0, 800.0, 600.0);
        tree.root.node_type = RenderNodeType::Page(PageNode {
            page_index: 0,
            width: 800.0,
            height: 600.0,
            section_index: 0,
        });
        let body = RenderNode::new(
            1,
            RenderNodeType::Body {
                clip_rect: Some(BoundingBox::new(10.0, 20.0, 300.0, 400.0)),
            },
            BoundingBox::new(10.0, 20.0, 300.0, 400.0),
        );
        tree.root.children.push(body);

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&tree);

        assert_eq!(layer_tree.page_width, 800.0);
        match &layer_tree.root.kind {
            LayerNodeKind::Group { children, .. } => {
                assert_eq!(children.len(), 1);
                match &children[0].kind {
                    LayerNodeKind::ClipRect {
                        clip, clip_kind, ..
                    } => {
                        assert_eq!(clip.x, 10.0);
                        assert_eq!(*clip_kind, ClipKind::Body);
                    }
                    other => panic!("expected clip rect, got {other:?}"),
                }
            }
            other => panic!("expected root group, got {other:?}"),
        }
    }

    #[test]
    fn preserves_leaf_payloads() {
        let mut tree = PageRenderTree::new(0, 800.0, 600.0);
        tree.root.children.push(RenderNode::new(
            1,
            RenderNodeType::PageBackground(PageBackgroundNode {
                background_color: Some(0x00FFFFFF),
                border_color: None,
                border_width: 0.0,
                gradient: None,
                image: None,
            }),
            BoundingBox::new(0.0, 0.0, 800.0, 600.0),
        ));
        tree.root.children.push(RenderNode::new(
            2,
            RenderNodeType::TableCell(TableCellNode {
                col: 0,
                row: 0,
                col_span: 1,
                row_span: 1,
                border_fill_id: 0,
                text_direction: 0,
                clip: true,
                model_cell_index: None,
            }),
            BoundingBox::new(100.0, 200.0, 150.0, 80.0),
        ));

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&tree);

        match &layer_tree.root.kind {
            LayerNodeKind::Group { children, .. } => {
                assert_eq!(children.len(), 2);
                match &children[0].kind {
                    LayerNodeKind::Leaf { ops, .. } => {
                        assert!(matches!(ops[0], PaintOp::PageBackground { .. }));
                    }
                    other => panic!("expected leaf, got {other:?}"),
                }
                match &children[1].kind {
                    LayerNodeKind::ClipRect { clip_kind, .. } => {
                        assert_eq!(*clip_kind, ClipKind::TableCell);
                    }
                    other => panic!("expected clip rect, got {other:?}"),
                }
            }
            other => panic!("expected root group, got {other:?}"),
        }
    }

    #[test]
    fn applies_cache_hints_for_static_subtrees_and_fast_preview() {
        let mut tree = PageRenderTree::new(0, 800.0, 600.0);
        tree.root.children.push(RenderNode::new(
            1,
            RenderNodeType::Header,
            BoundingBox::new(0.0, 0.0, 800.0, 48.0),
        ));
        tree.root.children.push(RenderNode::new(
            2,
            RenderNodeType::PageBackground(PageBackgroundNode {
                background_color: Some(0x00FFFFFF),
                border_color: None,
                border_width: 0.0,
                gradient: None,
                image: None,
            }),
            BoundingBox::new(0.0, 0.0, 800.0, 600.0),
        ));

        let mut builder = LayerBuilder::new(RenderProfile::FastPreview);
        let layer_tree = builder.build(&tree);

        match &layer_tree.root.kind {
            LayerNodeKind::Group { children, .. } => {
                assert_eq!(children.len(), 2);
                match &children[0].kind {
                    LayerNodeKind::Group { cache_hint, .. } => {
                        assert_eq!(*cache_hint, CacheHint::StaticSubtree);
                    }
                    other => panic!("expected header group, got {other:?}"),
                }
                match &children[1].kind {
                    LayerNodeKind::Leaf { cache_hint, .. } => {
                        assert_eq!(*cache_hint, CacheHint::PreferRaster);
                    }
                    other => panic!("expected page background leaf, got {other:?}"),
                }
            }
            other => panic!("expected root group, got {other:?}"),
        }
    }

    #[test]
    fn applies_vector_recording_hints_for_vector_leafs_in_print_profiles() {
        use crate::renderer::render_tree::RectangleNode;
        use crate::renderer::ShapeStyle;

        let mut tree = PageRenderTree::new(0, 800.0, 600.0);
        tree.root.children.push(RenderNode::new(
            10,
            RenderNodeType::Rectangle(RectangleNode::new(0.0, ShapeStyle::default(), None)),
            BoundingBox::new(40.0, 50.0, 120.0, 80.0),
        ));

        let mut print_builder = LayerBuilder::new(RenderProfile::Print);
        let print_tree = print_builder.build(&tree);
        let mut screen_builder = LayerBuilder::new(RenderProfile::Screen);
        let screen_tree = screen_builder.build(&tree);

        let print_hint = match &print_tree.root.kind {
            LayerNodeKind::Group { children, .. } => match &children[0].kind {
                LayerNodeKind::Leaf { cache_hint, .. } => *cache_hint,
                other => panic!("expected print rectangle leaf, got {other:?}"),
            },
            other => panic!("expected print root group, got {other:?}"),
        };
        let screen_hint = match &screen_tree.root.kind {
            LayerNodeKind::Group { children, .. } => match &children[0].kind {
                LayerNodeKind::Leaf { cache_hint, .. } => *cache_hint,
                other => panic!("expected screen rectangle leaf, got {other:?}"),
            },
            other => panic!("expected screen root group, got {other:?}"),
        };

        assert_eq!(print_hint, CacheHint::PreferVectorRecording);
        assert_eq!(screen_hint, CacheHint::None);
    }

    #[test]
    fn preserves_shape_children_by_wrapping_leaf_in_group() {
        use crate::renderer::render_tree::{RectangleNode, TextRunNode};
        use crate::renderer::{ShapeStyle, TextStyle};

        let mut tree = PageRenderTree::new(0, 800.0, 600.0);
        let mut rect = RenderNode::new(
            10,
            RenderNodeType::Rectangle(RectangleNode::new(0.0, ShapeStyle::default(), None)),
            BoundingBox::new(100.0, 120.0, 160.0, 48.0),
        );
        rect.children.push(RenderNode::new(
            11,
            RenderNodeType::TextRun(TextRunNode {
                text: "group label".to_string(),
                style: TextStyle::default(),
                char_shape_id: None,
                para_shape_id: None,
                section_index: None,
                para_index: None,
                char_start: None,
                cell_context: None,
                is_para_end: false,
                is_line_break_end: false,
                rotation: 0.0,
                is_vertical: false,
                char_overlap: None,
                border_fill_id: 0,
                baseline: 0.0,
                field_marker: Default::default(),
            }),
            BoundingBox::new(112.0, 132.0, 92.0, 18.0),
        ));
        tree.root.children.push(rect);

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&tree);

        match &layer_tree.root.kind {
            LayerNodeKind::Group { children, .. } => {
                assert_eq!(children.len(), 1);
                match &children[0].kind {
                    LayerNodeKind::Group { children, .. } => {
                        assert_eq!(children.len(), 2);
                        match &children[0].kind {
                            LayerNodeKind::Leaf { ops, .. } => {
                                assert!(matches!(ops[0], PaintOp::Rectangle { .. }));
                            }
                            other => panic!("expected rectangle leaf, got {other:?}"),
                        }
                        match &children[1].kind {
                            LayerNodeKind::Leaf { ops, .. } => {
                                assert!(matches!(ops[0], PaintOp::TextRun { .. }));
                            }
                            other => panic!("expected text leaf, got {other:?}"),
                        }
                    }
                    other => panic!("expected synthetic group, got {other:?}"),
                }
            }
            other => panic!("expected root group, got {other:?}"),
        }
    }

    #[test]
    fn drops_invisible_nodes_from_layer_tree() {
        let mut tree = PageRenderTree::new(0, 800.0, 600.0);
        let mut hidden = RenderNode::new(
            10,
            RenderNodeType::Header,
            BoundingBox::new(0.0, 0.0, 800.0, 48.0),
        );
        hidden.visible = false;
        tree.root.children.push(hidden);

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&tree);

        match &layer_tree.root.kind {
            LayerNodeKind::Group { children, .. } => {
                assert!(
                    children.is_empty(),
                    "invisible nodes should not survive lowering"
                );
            }
            other => panic!("expected root group, got {other:?}"),
        }
    }

    #[test]
    fn preserves_source_node_id_for_clip_and_leaf_nodes() {
        let mut tree = PageRenderTree::new(0, 800.0, 600.0);
        let body_id = 21;
        let background_id = 22;
        tree.root.children.push(RenderNode::new(
            background_id,
            RenderNodeType::PageBackground(PageBackgroundNode {
                background_color: Some(0x00FFFFFF),
                border_color: None,
                border_width: 0.0,
                gradient: None,
                image: None,
            }),
            BoundingBox::new(0.0, 0.0, 800.0, 600.0),
        ));
        tree.root.children.push(RenderNode::new(
            body_id,
            RenderNodeType::Body {
                clip_rect: Some(BoundingBox::new(10.0, 20.0, 300.0, 400.0)),
            },
            BoundingBox::new(10.0, 20.0, 300.0, 400.0),
        ));

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&tree);

        match &layer_tree.root.kind {
            LayerNodeKind::Group { children, .. } => {
                assert_eq!(children[0].source_node_id, Some(background_id));
                assert_eq!(children[1].source_node_id, Some(body_id));
                match &children[1].kind {
                    LayerNodeKind::ClipRect { child, .. } => {
                        assert_eq!(child.source_node_id, Some(body_id));
                    }
                    other => panic!("expected clip rect, got {other:?}"),
                }
            }
            other => panic!("expected root group, got {other:?}"),
        }
    }

    #[test]
    fn interns_duplicate_image_and_equation_payloads_once_per_page() {
        let image_bytes = vec![0x89, b'P', b'N', b'G'];
        let equation_svg = "<text x=\"0\" y=\"10\">x</text>".to_string();
        let mut tree = PageRenderTree::new(0, 800.0, 600.0);
        tree.root.children.push(RenderNode::new(
            30,
            RenderNodeType::PageBackground(PageBackgroundNode {
                background_color: None,
                border_color: None,
                border_width: 0.0,
                gradient: None,
                image: Some(crate::renderer::render_tree::PageBackgroundImage {
                    data: image_bytes.clone(),
                    fill_mode: crate::model::style::ImageFillMode::FitToSize,
                }),
            }),
            BoundingBox::new(0.0, 0.0, 800.0, 600.0),
        ));
        for node_id in [31, 32] {
            let mut image = ImageNode::new(0, None);
            image.data = Some(image_bytes.clone());
            tree.root.children.push(RenderNode::new(
                node_id,
                RenderNodeType::Image(image),
                BoundingBox::new(10.0 * node_id as f64, 10.0, 40.0, 20.0),
            ));
        }
        for node_id in [33, 34] {
            tree.root.children.push(RenderNode::new(
                node_id,
                RenderNodeType::Equation(EquationNode {
                    svg_content: equation_svg.clone(),
                    layout_box: crate::renderer::equation::layout::LayoutBox {
                        x: 0.0,
                        y: 0.0,
                        width: 10.0,
                        height: 12.0,
                        baseline: 9.0,
                        kind: crate::renderer::equation::layout::LayoutKind::Text("x".to_string()),
                    },
                    color_str: "#112233".to_string(),
                    color: 0x00332211,
                    font_size: 14.0,
                    section_index: None,
                    para_index: None,
                    control_index: None,
                    cell_index: None,
                    cell_para_index: None,
                }),
                BoundingBox::new(20.0 * node_id as f64, 40.0, 20.0, 16.0),
            ));
        }

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&tree);

        assert_eq!(layer_tree.resources.image_count(), 1);
        assert_eq!(layer_tree.resources.svg_count(), 1);
    }
}
