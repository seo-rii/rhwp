use crate::paint::PageLayerTree;

use super::layer_renderer::{LayerRenderResult, LayerRenderer};
use super::render_tree::{BoundingBox, PageRenderTree, RenderNode, RenderNodeType};
use super::svg::SvgRenderer;

/// PageLayerTree를 SVG로 직접 재생한다.
pub struct SvgLayerRenderer {
    renderer: SvgRenderer,
}

impl SvgLayerRenderer {
    pub fn new() -> Self {
        Self {
            renderer: SvgRenderer::new(),
        }
    }

    pub fn output(&self) -> &str {
        self.renderer.output()
    }

    pub fn configure_output(
        &mut self,
        show_paragraph_marks: bool,
        show_control_codes: bool,
        debug_overlay: bool,
    ) {
        self.renderer.show_paragraph_marks = show_paragraph_marks;
        self.renderer.show_control_codes = show_control_codes;
        self.renderer.debug_overlay = debug_overlay;
    }
}

impl LayerRenderer for SvgLayerRenderer {
    fn render_page(&mut self, tree: &PageLayerTree) -> LayerRenderResult<()> {
        self.renderer.render_layer_tree(tree);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paint::{LayerBuilder, RenderProfile};
    use crate::renderer::render_tree::{PageNode, RectangleNode, TextRunNode};
    use crate::renderer::svg::SvgRenderer;
    use crate::renderer::{ShapeStyle, TextStyle};

    #[test]
    fn replays_basic_layer_tree_to_same_svg() {
        let mut render_tree = PageRenderTree::new(0, 400.0, 300.0);
        render_tree.root.node_type = RenderNodeType::Page(PageNode {
            page_index: 0,
            width: 400.0,
            height: 300.0,
            section_index: 0,
        });
        let mut line = RenderNode::new(
            10,
            RenderNodeType::TextLine(crate::renderer::render_tree::TextLineNode::new(20.0, 15.0)),
            BoundingBox::new(20.0, 20.0, 120.0, 20.0),
        );
        line.children.push(RenderNode::new(
            11,
            RenderNodeType::TextRun(TextRunNode {
                text: "레이어".to_string(),
                display_text: None,
                display_clusters: None,
                style: TextStyle {
                    font_family: "Noto Sans CJK KR".to_string(),
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
                rotation: 0.0,
                is_vertical: false,
                char_overlap: None,
                border_fill_id: 0,
                baseline: 15.0,
                field_marker: Default::default(),
            }),
            BoundingBox::new(20.0, 20.0, 60.0, 20.0),
        ));
        render_tree.root.children.push(line);
        render_tree.root.children.push(RenderNode::new(
            12,
            RenderNodeType::Rectangle(RectangleNode::new(
                0.0,
                ShapeStyle {
                    fill_color: Some(0x00F0F0F0),
                    stroke_color: Some(0x00000000),
                    stroke_width: 1.0,
                    ..Default::default()
                },
                None,
            )),
            BoundingBox::new(18.0, 18.0, 90.0, 28.0),
        ));

        let mut legacy = SvgRenderer::new();
        legacy.render_tree(&render_tree);

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&render_tree);
        let mut layer = SvgLayerRenderer::new();
        layer.render_page(&layer_tree).expect("layer svg render");

        assert_eq!(layer.output(), legacy.output());
    }
}
