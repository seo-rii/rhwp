use crate::paint::layer_tree::{
    CacheHint, ClipKind, LayerNode, LayerNodeKind, LayerOutputOptions, LayerSemantic,
    LayerSemanticRole, PageLayerTree, TextSourceRange,
};
use crate::paint::paint_op::{
    LayerCharOverlapPaint, LayerEllipsePaint, LayerEquationPaint, LayerFootnoteMarkerPaint,
    LayerFormObjectPaint, LayerImagePaint, LayerLinePaint, LayerPageBackgroundImagePaint,
    LayerPageBackgroundPaint, LayerPathPaint, LayerPoint, LayerRectanglePaint, LayerTabLeaderPaint,
    LayerTextControlMark, LayerTextControlMarkKind, LayerTextControlMarkPaint,
    LayerTextDecorationKind, LayerTextDecorationPaint, LayerTextOrientation, LayerTextRunPaint,
    LayerVector, PaintOp, TextClusterBasis, TextClusterFlag, TextClusterPlacement,
    TextLegacyVisualState, TextLegacyVisuals, TextProjectionKind,
};
use crate::paint::profile::RenderProfile;
use crate::paint::resources::{ImageResourceId, ResourceArena};
use crate::paint::{lower_font_native_glyph_sidecars, EmbeddedFontFace, TextFontSlot};
use crate::renderer::layout::{compute_char_positions, compute_source_aligned_display_positions};
use crate::renderer::render_tree::{
    BoundingBox, FieldMarkerType, PageRenderTree, RenderNode, RenderNodeType, TextRunNode,
};

/// semantic render tree를 visual layer tree로 내린다.
pub struct LayerBuilder {
    profile: RenderProfile,
    resources: ResourceArena,
    page_width: f64,
    output_options: LayerOutputOptions,
}

impl LayerBuilder {
    pub fn new(profile: RenderProfile) -> Self {
        Self {
            profile,
            resources: ResourceArena::default(),
            page_width: 0.0,
            output_options: LayerOutputOptions::default(),
        }
    }

    pub fn with_output_options(mut self, output_options: LayerOutputOptions) -> Self {
        self.output_options = output_options;
        self
    }

    pub fn build(&mut self, tree: &PageRenderTree) -> PageLayerTree {
        self.build_with_embedded_fonts(tree, &[])
    }

    pub fn build_with_embedded_fonts(
        &mut self,
        tree: &PageRenderTree,
        fonts: &[EmbeddedFontFace<'_>],
    ) -> PageLayerTree {
        self.resources = ResourceArena::default();
        let (page_width, page_height) = match &tree.root.node_type {
            RenderNodeType::Page(page) => (page.width, page.height),
            _ => (tree.root.bbox.width, tree.root.bbox.height),
        };
        self.page_width = page_width;

        let root = LayerNode::group(
            tree.root.bbox,
            Some(tree.root.id),
            self.build_children(&tree.root),
            self.cache_hint_for(&tree.root.node_type),
            LayerSemantic::role(LayerSemanticRole::Page),
        );

        let mut layer_tree = PageLayerTree::builder(page_width, page_height, root)
            .resources(std::mem::take(&mut self.resources))
            .profile(self.profile)
            .output_options(self.output_options)
            .build();
        lower_font_native_glyph_sidecars(&mut layer_tree, fonts);
        layer_tree
    }

    fn build_children(&mut self, node: &RenderNode) -> Vec<LayerNode> {
        node.children
            .iter()
            .filter_map(|child| self.build_node(child))
            .collect()
    }

    fn visible_layer_bounds(node: &LayerNode) -> Option<BoundingBox> {
        fn union(left: BoundingBox, right: BoundingBox) -> BoundingBox {
            let x = left.x.min(right.x);
            let y = left.y.min(right.y);
            let right_edge = (left.x + left.width).max(right.x + right.width);
            let bottom = (left.y + left.height).max(right.y + right.height);
            BoundingBox::new(x, y, right_edge - x, bottom - y)
        }

        match &node.kind {
            LayerNodeKind::Leaf { .. } => Some(node.bounds),
            LayerNodeKind::Group { children, .. } => children
                .iter()
                .filter_map(Self::visible_layer_bounds)
                .reduce(union),
            LayerNodeKind::ClipRect {
                clip,
                clip_policy,
                child,
                ..
            } => {
                let child_bounds = Self::visible_layer_bounds(child)?;
                let clip_right = clip.x + clip.width + clip_policy.right_overflow_slop;
                let clip_bottom = clip.y + clip.height;
                let left = child_bounds.x.max(clip.x);
                let top = child_bounds.y.max(clip.y);
                let right = (child_bounds.x + child_bounds.width).min(clip_right);
                let bottom = (child_bounds.y + child_bounds.height).min(clip_bottom);
                (right > left && bottom > top)
                    .then(|| BoundingBox::new(left, top, right - left, bottom - top))
            }
        }
    }

    fn is_body_horizontal_overflow_control(node: &RenderNode) -> bool {
        !matches!(
            node.node_type,
            RenderNodeType::TextLine(_)
                | RenderNodeType::TextRun(_)
                | RenderNodeType::FootnoteMarker(_)
                | RenderNodeType::FootnoteArea
                | RenderNodeType::Header
                | RenderNodeType::Footer
                | RenderNodeType::MasterPage
                | RenderNodeType::Page(_)
                | RenderNodeType::Body { .. }
        )
    }

    fn is_body_floating_subtree(node: &RenderNode) -> bool {
        matches!(
            node.node_type,
            RenderNodeType::Image(_)
                | RenderNodeType::Group(_)
                | RenderNodeType::Path(_)
                | RenderNodeType::Ellipse(_)
                | RenderNodeType::Rectangle(_)
                | RenderNodeType::Line(_)
                | RenderNodeType::TextBox
                | RenderNodeType::Placeholder(_)
                | RenderNodeType::RawSvg(_)
        )
    }

    fn build_body_children(
        &mut self,
        node: &RenderNode,
        authored_body: BoundingBox,
        resolved_clip: BoundingBox,
    ) -> Vec<LayerNode> {
        let flow_clip = BoundingBox::new(
            authored_body.x,
            resolved_clip.y,
            authored_body.width,
            resolved_clip.height,
        );
        let resolved_bottom = resolved_clip.y + resolved_clip.height;
        let floating_bottom = resolved_bottom.min(authored_body.y + authored_body.height + 10.0);
        let floating_height = (floating_bottom - resolved_clip.y).max(0.0);
        let mut routed = Vec::new();
        let mut flow_segment = Vec::new();

        for child in &node.children {
            if !self.should_emit_node(child) {
                continue;
            }
            if matches!(child.node_type, RenderNodeType::Column(_)) {
                if !flow_segment.is_empty() {
                    let segment = LayerNode::group(
                        node.bbox,
                        Some(node.id),
                        std::mem::take(&mut flow_segment),
                        CacheHint::None,
                        self.semantic_for(&node.node_type),
                    );
                    routed.push(LayerNode::clip_rect(
                        node.bbox,
                        Some(node.id),
                        flow_clip,
                        segment,
                        ClipKind::Body,
                    ));
                }
                routed.push(LayerNode::group(
                    child.bbox,
                    Some(child.id),
                    self.build_body_children(child, authored_body, resolved_clip),
                    self.cache_hint_for(&child.node_type),
                    self.semantic_for(&child.node_type),
                ));
                continue;
            }

            let Some(layer) = self.build_node(child) else {
                continue;
            };
            let visible_bounds = Self::visible_layer_bounds(&layer).unwrap_or(layer.bounds);
            let is_floating = Self::is_body_floating_subtree(child);
            let horizontal_bounds = if is_floating {
                visible_bounds
            } else {
                child.bbox
            };
            let horizontal_overflow = Self::is_body_horizontal_overflow_control(child)
                && (horizontal_bounds.x < authored_body.x
                    || horizontal_bounds.x + horizontal_bounds.width
                        > authored_body.x + authored_body.width);
            let floating_overflow =
                is_floating && visible_bounds.y + visible_bounds.height > floating_bottom;

            if horizontal_overflow || floating_overflow {
                if !flow_segment.is_empty() {
                    let segment = LayerNode::group(
                        node.bbox,
                        Some(node.id),
                        std::mem::take(&mut flow_segment),
                        CacheHint::None,
                        self.semantic_for(&node.node_type),
                    );
                    routed.push(LayerNode::clip_rect(
                        node.bbox,
                        Some(node.id),
                        flow_clip,
                        segment,
                        ClipKind::Body,
                    ));
                }

                let clip = BoundingBox::new(
                    if horizontal_overflow {
                        0.0
                    } else {
                        authored_body.x
                    },
                    resolved_clip.y,
                    if horizontal_overflow {
                        self.page_width
                    } else {
                        authored_body.width
                    },
                    if is_floating {
                        floating_height
                    } else {
                        resolved_clip.height
                    },
                );
                routed.push(LayerNode::clip_rect(
                    layer.bounds,
                    Some(child.id),
                    clip,
                    layer,
                    if horizontal_overflow {
                        ClipKind::Generic
                    } else {
                        ClipKind::Body
                    },
                ));
            } else {
                flow_segment.push(layer);
            }
        }

        if !flow_segment.is_empty() {
            let segment = LayerNode::group(
                node.bbox,
                Some(node.id),
                flow_segment,
                CacheHint::None,
                self.semantic_for(&node.node_type),
            );
            routed.push(LayerNode::clip_rect(
                node.bbox,
                Some(node.id),
                flow_clip,
                segment,
                ClipKind::Body,
            ));
        }

        routed
    }

    fn build_text_control_marks(
        &self,
        run: &TextRunNode,
        bbox: crate::renderer::render_tree::BoundingBox,
        positions: &[f64],
    ) -> Vec<LayerTextControlMark> {
        if !(self.output_options.show_paragraph_marks || self.output_options.show_control_codes) {
            return Vec::new();
        }

        let font_size = if run.style.font_size > 0.0 {
            run.style.font_size
        } else {
            12.0
        };
        let mut marks = Vec::new();
        let is_field_marker = !matches!(run.field_marker, FieldMarkerType::None);
        if !run.text.is_empty() && !is_field_marker {
            let mark_font_size = (font_size * 0.5).max(1.0);
            for (index, ch) in run.text.chars().enumerate() {
                match ch {
                    ' ' => {
                        let current_x = positions
                            .get(index)
                            .copied()
                            .unwrap_or_else(|| positions.last().copied().unwrap_or(0.0));
                        let next_x = positions.get(index + 1).copied().unwrap_or(bbox.width);
                        marks.push(LayerTextControlMark {
                            kind: LayerTextControlMarkKind::Space,
                            x: (current_x + next_x) / 2.0 - mark_font_size * 0.25,
                            y: 0.0,
                            font_size: mark_font_size,
                        });
                    }
                    '\t' => {
                        let x = positions
                            .get(index)
                            .copied()
                            .unwrap_or_else(|| positions.last().copied().unwrap_or(0.0));
                        marks.push(LayerTextControlMark {
                            kind: LayerTextControlMarkKind::Tab,
                            x,
                            y: 0.0,
                            font_size: mark_font_size,
                        });
                    }
                    _ => {}
                }
            }
        }

        if run.is_para_end || run.is_line_break_end {
            marks.push(LayerTextControlMark {
                kind: if run.is_line_break_end {
                    LayerTextControlMarkKind::LineBreakEnd
                } else {
                    LayerTextControlMarkKind::ParagraphEnd
                },
                x: if run.text.is_empty() { 0.0 } else { bbox.width },
                y: 0.0,
                font_size,
            });
        }

        marks
    }

    fn build_node(&mut self, node: &RenderNode) -> Option<LayerNode> {
        if !self.should_emit_node(node) {
            return None;
        }

        let mut layer = match &node.node_type {
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
            RenderNodeType::TextRun(run) => {
                let replay_text = run.display_text.as_deref().unwrap_or(&run.text);
                let display_positions = compute_char_positions(replay_text, &run.style);
                let positions = compute_source_aligned_display_positions(
                    &run.text,
                    run.display_clusters.as_deref(),
                    &run.style,
                );
                let clusters = run
                    .display_clusters
                    .as_deref()
                    .map(|display_clusters| {
                        projected_text_clusters(&run.text, display_clusters, &display_positions)
                    })
                    .unwrap_or_default();
                let control_marks = self.build_text_control_marks(run, node.bbox, &positions);
                let orientation = LayerTextOrientation::from_run(run.is_vertical, run.rotation);
                let legacy_visuals = TextLegacyVisuals {
                    char_overlap: run
                        .char_overlap
                        .as_ref()
                        .map(|_| TextLegacyVisualState::Mirror),
                    control_marks: (!control_marks.is_empty())
                        .then_some(TextLegacyVisualState::Mirror),
                    tab_leaders: (!run.style.tab_leaders.is_empty())
                        .then_some(TextLegacyVisualState::Mirror),
                    decorations: (run.style.underline != crate::model::style::UnderlineType::None
                        || run.style.strikethrough
                        || run.style.emphasis_dot > 0)
                        .then_some(TextLegacyVisualState::Mirror),
                };
                let text_op = PaintOp::TextRun {
                    bbox: node.bbox,
                    run: LayerTextRunPaint {
                        source: None,
                        variant: None,
                        font_slot: run.char_shape_id.zip(run.style.font_language_index).map(
                            |(char_shape_id, language_index)| TextFontSlot {
                                char_shape_id,
                                language_index,
                            },
                        ),
                        text: run.text.clone(),
                        display_text: run.display_text.clone(),
                        style: run.style.clone(),
                        projection: if run.display_text.is_some() {
                            TextProjectionKind::Normalized
                        } else {
                            TextProjectionKind::Verbatim
                        },
                        placement: None,
                        cluster_basis: TextClusterBasis::LegacyPosition,
                        clusters,
                        positions: positions.clone(),
                        control_marks: control_marks.clone(),
                        baseline: run.baseline,
                        rotation: run.rotation,
                        is_vertical: run.is_vertical,
                        orientation,
                        char_overlap: run.char_overlap.clone(),
                        legacy_visuals,
                        field_marker: run.field_marker,
                        is_para_end: run.is_para_end,
                        is_line_break_end: run.is_line_break_end,
                    },
                };
                let mut ops = vec![text_op];
                if let Some(overlap) = &run.char_overlap {
                    ops.push(PaintOp::CharOverlap {
                        bbox: node.bbox,
                        overlap: LayerCharOverlapPaint {
                            source: None,
                            variant: None,
                            text: run.text.clone(),
                            style: run.style.clone(),
                            positions: positions.clone(),
                            baseline: run.baseline,
                            rotation: run.rotation,
                            is_vertical: run.is_vertical,
                            orientation,
                            overlap: overlap.clone(),
                        },
                    });
                }
                for mut mark in control_marks {
                    mark.y += run.baseline;
                    ops.push(PaintOp::TextControlMark {
                        bbox: node.bbox,
                        mark: LayerTextControlMarkPaint {
                            source: None,
                            text_wrap: None,
                            rotation: run.rotation,
                            mark,
                        },
                    });
                }
                for leader in &run.style.tab_leaders {
                    ops.push(PaintOp::TabLeader {
                        bbox: node.bbox,
                        leader: LayerTabLeaderPaint {
                            source: None,
                            leader: leader.clone(),
                            color: run.style.color,
                            font_size: run.style.font_size,
                            baseline: run.baseline,
                            rotation: run.rotation,
                        },
                    });
                }
                if run.style.underline != crate::model::style::UnderlineType::None {
                    ops.push(PaintOp::TextDecoration {
                        bbox: node.bbox,
                        decoration: LayerTextDecorationPaint {
                            source: None,
                            kind: LayerTextDecorationKind::Underline,
                            positions: positions.clone(),
                            baseline: run.baseline,
                            rotation: run.rotation,
                            font_size: run.style.font_size,
                            ratio: run.style.ratio,
                            color: if run.style.underline_color != 0 {
                                run.style.underline_color
                            } else {
                                run.style.color
                            },
                            shape: run.style.underline_shape,
                            underline: run.style.underline,
                            emphasis_dot: 0,
                        },
                    });
                }
                if run.style.strikethrough {
                    ops.push(PaintOp::TextDecoration {
                        bbox: node.bbox,
                        decoration: LayerTextDecorationPaint {
                            source: None,
                            kind: LayerTextDecorationKind::Strikethrough,
                            positions: positions.clone(),
                            baseline: run.baseline,
                            rotation: run.rotation,
                            font_size: run.style.font_size,
                            ratio: run.style.ratio,
                            color: if run.style.strike_color != 0 {
                                run.style.strike_color
                            } else {
                                run.style.color
                            },
                            shape: run.style.strike_shape,
                            underline: crate::model::style::UnderlineType::None,
                            emphasis_dot: 0,
                        },
                    });
                }
                if run.style.emphasis_dot > 0 {
                    ops.push(PaintOp::TextDecoration {
                        bbox: node.bbox,
                        decoration: LayerTextDecorationPaint {
                            source: None,
                            kind: LayerTextDecorationKind::EmphasisDot,
                            positions: positions.clone(),
                            baseline: run.baseline,
                            rotation: run.rotation,
                            font_size: run.style.font_size,
                            ratio: run.style.ratio,
                            color: run.style.color,
                            shape: 0,
                            underline: crate::model::style::UnderlineType::None,
                            emphasis_dot: run.style.emphasis_dot,
                        },
                    });
                }
                let mut visual_bounds = ops[0].visual_bounds();
                for op in &ops[1..] {
                    let bounds = op.visual_bounds();
                    let left = visual_bounds.x.min(bounds.x);
                    let top = visual_bounds.y.min(bounds.y);
                    let right =
                        (visual_bounds.x + visual_bounds.width).max(bounds.x + bounds.width);
                    let bottom =
                        (visual_bounds.y + visual_bounds.height).max(bounds.y + bounds.height);
                    visual_bounds = crate::renderer::render_tree::BoundingBox::new(
                        left,
                        top,
                        right - left,
                        bottom - top,
                    );
                }
                if node.children.is_empty() {
                    Some(LayerNode::leaf_with_hint(
                        visual_bounds,
                        Some(node.id),
                        ops,
                        self.cache_hint_for(&node.node_type),
                    ))
                } else {
                    let mut children = Vec::with_capacity(node.children.len() + 1);
                    children.push(LayerNode::leaf_with_hint(
                        visual_bounds,
                        Some(node.id),
                        ops,
                        self.cache_hint_for(&node.node_type),
                    ));
                    children.extend(self.build_children(node));
                    let mut group_bounds = visual_bounds;
                    for child in &children[1..] {
                        let left = group_bounds.x.min(child.bounds.x);
                        let top = group_bounds.y.min(child.bounds.y);
                        let right = (group_bounds.x + group_bounds.width)
                            .max(child.bounds.x + child.bounds.width);
                        let bottom = (group_bounds.y + group_bounds.height)
                            .max(child.bounds.y + child.bounds.height);
                        group_bounds = crate::renderer::render_tree::BoundingBox::new(
                            left,
                            top,
                            right - left,
                            bottom - top,
                        );
                    }
                    Some(LayerNode::group(
                        group_bounds,
                        None,
                        children,
                        self.cache_hint_for(&node.node_type),
                        LayerSemantic::default(),
                    ))
                }
            }
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
            RenderNodeType::Placeholder(placeholder) => {
                let rect_op = PaintOp::Rectangle {
                    bbox: node.bbox,
                    rect: LayerRectanglePaint {
                        corner_radius: 0.0,
                        style: crate::renderer::ShapeStyle {
                            fill_color: Some(placeholder.fill_color & 0x00FF_FFFF),
                            stroke_color: Some(placeholder.stroke_color & 0x00FF_FFFF),
                            stroke_width: 1.0,
                            ..Default::default()
                        },
                        gradient: None,
                        transform: Default::default(),
                    },
                };
                let font_size = (node.bbox.height * 0.18).clamp(8.0, 16.0);
                let text_width = (placeholder.label.chars().count() as f64 * font_size * 0.55)
                    .min((node.bbox.width - 4.0).max(1.0));
                let text_bbox = crate::renderer::render_tree::BoundingBox::new(
                    node.bbox.x + (node.bbox.width - text_width) / 2.0,
                    node.bbox.y + (node.bbox.height - font_size * 1.2) / 2.0,
                    text_width,
                    font_size * 1.2,
                );
                let text_style = crate::renderer::TextStyle {
                    font_size,
                    color: placeholder.stroke_color & 0x00FF_FFFF,
                    ..Default::default()
                };
                let text_op = PaintOp::TextRun {
                    bbox: text_bbox,
                    run: LayerTextRunPaint {
                        source: None,
                        variant: None,
                        font_slot: None,
                        text: placeholder.label.clone(),
                        display_text: None,
                        positions: compute_char_positions(&placeholder.label, &text_style),
                        control_marks: Vec::new(),
                        style: text_style,
                        projection: TextProjectionKind::Verbatim,
                        placement: None,
                        cluster_basis: TextClusterBasis::LegacyPosition,
                        clusters: Vec::new(),
                        baseline: font_size,
                        rotation: 0.0,
                        is_vertical: false,
                        orientation: LayerTextOrientation::Horizontal,
                        char_overlap: None,
                        legacy_visuals: TextLegacyVisuals::default(),
                        field_marker: Default::default(),
                        is_para_end: false,
                        is_line_break_end: false,
                    },
                };
                Some(LayerNode::leaf_with_hint(
                    node.bbox,
                    Some(node.id),
                    vec![rect_op, text_op],
                    self.cache_hint_for(&node.node_type),
                ))
            }
            RenderNodeType::RawSvg(raw_svg) => {
                if let Some(data_url) =
                    crate::renderer::svg_fragment::try_parse_single_image_data_url(&raw_svg.svg)
                {
                    if let Some((_mime, bytes)) =
                        crate::renderer::svg_fragment::decode_base64_data_url(data_url)
                    {
                        let resource_id = self.intern_replay_image_bytes(&bytes);
                        return Some(self.build_paint_node(
                            node,
                            PaintOp::Image {
                                bbox: node.bbox,
                                image: LayerImagePaint {
                                    resource_id: Some(resource_id),
                                    external_path: None,
                                    text_wrap: None,
                                    fill_mode: Some(crate::model::style::ImageFillMode::FitToSize),
                                    original_size: None,
                                    crop: None,
                                    original_size_hu: None,
                                    brightness: 0,
                                    contrast: 0,
                                    effect: crate::model::image::ImageEffect::RealPic,
                                    transform: Default::default(),
                                },
                            },
                        ));
                    }
                }
                // RawSvg producers currently emit page-absolute coordinates, while the
                // SVG-backed layer replay path draws fragments in bbox-local space.
                let normalized_svg = format!(
                    "<g transform=\"translate({:.6},{:.6})\">{}</g>",
                    -node.bbox.x, -node.bbox.y, raw_svg.svg,
                );
                let svg_resource_id = self.resources.intern_svg_fragment(&normalized_svg);
                Some(self.build_paint_node(
                    node,
                    PaintOp::Equation {
                        bbox: node.bbox,
                        equation: LayerEquationPaint {
                            svg_resource_id,
                            layout_box: crate::renderer::equation::layout::LayoutBox {
                                x: 0.0,
                                y: 0.0,
                                width: node.bbox.width,
                                height: node.bbox.height,
                                baseline: 0.0,
                                kind: crate::renderer::equation::layout::LayoutKind::Empty,
                            },
                            color_str: "#000000".to_string(),
                            color: 0,
                            font_size: node.bbox.height,
                        },
                    },
                ))
            }
            RenderNodeType::Body {
                clip_rect: Some(clip),
            } if self.output_options.clip_enabled => {
                let children = self.build_body_children(node, node.bbox, *clip);
                if children.is_empty() {
                    let empty_body = LayerNode::group(
                        node.bbox,
                        Some(node.id),
                        Vec::new(),
                        self.cache_hint_for(&node.node_type),
                        LayerSemantic::role(LayerSemanticRole::Body),
                    );
                    return Some(LayerNode::clip_rect(
                        node.bbox,
                        Some(node.id),
                        BoundingBox::new(node.bbox.x, clip.y, node.bbox.width, clip.height),
                        empty_body,
                        ClipKind::Body,
                    ));
                }
                Some(LayerNode::group(
                    node.bbox,
                    Some(node.id),
                    children,
                    self.cache_hint_for(&node.node_type),
                    LayerSemantic::role(LayerSemanticRole::Body),
                ))
            }
            RenderNodeType::TableCell(cell) if cell.clip && self.output_options.clip_enabled => {
                let child = LayerNode::group(
                    node.bbox,
                    Some(node.id),
                    self.build_children(node),
                    self.cache_hint_for(&node.node_type),
                    LayerSemantic::role(LayerSemanticRole::TableCell),
                );
                Some(LayerNode::clip_rect(
                    node.bbox,
                    Some(node.id),
                    node.bbox,
                    child,
                    ClipKind::TableCell,
                ))
            }
            RenderNodeType::TextBox if self.output_options.clip_enabled => {
                let child = LayerNode::group(
                    node.bbox,
                    Some(node.id),
                    self.build_children(node),
                    self.cache_hint_for(&node.node_type),
                    LayerSemantic::role(LayerSemanticRole::TextBox),
                );
                Some(LayerNode::clip_rect(
                    node.bbox,
                    Some(node.id),
                    node.bbox,
                    child,
                    ClipKind::TextBox,
                ))
            }
            _ => Some(LayerNode::group(
                node.bbox,
                Some(node.id),
                self.build_children(node),
                self.cache_hint_for(&node.node_type),
                self.semantic_for(&node.node_type),
            )),
        }?;

        if !self.output_options.show_control_codes {
            return Some(layer);
        }

        let (kind, text_wrap) = match &node.node_type {
            RenderNodeType::Table(_) => (LayerTextControlMarkKind::Table, None),
            RenderNodeType::Image(image) => (LayerTextControlMarkKind::Picture, image.text_wrap),
            RenderNodeType::TextBox => (LayerTextControlMarkKind::TextBox, None),
            RenderNodeType::Equation(_) => (LayerTextControlMarkKind::Equation, None),
            RenderNodeType::Header => (LayerTextControlMarkKind::Header, None),
            RenderNodeType::Footer => (LayerTextControlMarkKind::Footer, None),
            RenderNodeType::FootnoteArea => (LayerTextControlMarkKind::FootnoteArea, None),
            _ => return Some(layer),
        };
        let marker_op = PaintOp::TextControlMark {
            bbox: node.bbox,
            mark: LayerTextControlMarkPaint {
                source: None,
                text_wrap,
                rotation: 0.0,
                mark: LayerTextControlMark {
                    kind,
                    x: 0.0,
                    y: 10.0,
                    font_size: 10.0,
                },
            },
        };
        let marker_bounds = marker_op.visual_bounds();
        let left = layer.bounds.x.min(marker_bounds.x);
        let top = layer.bounds.y.min(marker_bounds.y);
        let right =
            (layer.bounds.x + layer.bounds.width).max(marker_bounds.x + marker_bounds.width);
        let bottom =
            (layer.bounds.y + layer.bounds.height).max(marker_bounds.y + marker_bounds.height);
        layer.bounds = BoundingBox::new(left, top, right - left, bottom - top);
        let marker_leaf = LayerNode::leaf(marker_bounds, Some(node.id), vec![marker_op]);
        match &mut layer.kind {
            LayerNodeKind::Group { children, .. } => children.push(marker_leaf),
            LayerNodeKind::ClipRect { child, .. } => {
                let child_left = child.bounds.x.min(marker_bounds.x);
                let child_top = child.bounds.y.min(marker_bounds.y);
                let child_right = (child.bounds.x + child.bounds.width)
                    .max(marker_bounds.x + marker_bounds.width);
                let child_bottom = (child.bounds.y + child.bounds.height)
                    .max(marker_bounds.y + marker_bounds.height);
                child.bounds = BoundingBox::new(
                    child_left,
                    child_top,
                    child_right - child_left,
                    child_bottom - child_top,
                );
                match &mut child.kind {
                    LayerNodeKind::Group { children, .. } => children.push(marker_leaf),
                    LayerNodeKind::Leaf { ops, .. } => {
                        let LayerNodeKind::Leaf {
                            ops: marker_ops, ..
                        } = marker_leaf.kind
                        else {
                            unreachable!()
                        };
                        ops.extend(marker_ops);
                    }
                    LayerNodeKind::ClipRect { .. } => {
                        let child_bounds = child.bounds;
                        let previous_child = std::mem::replace(
                            child,
                            Box::new(LayerNode::group(
                                marker_bounds,
                                None,
                                Vec::new(),
                                CacheHint::None,
                                LayerSemantic::default(),
                            )),
                        );
                        **child = LayerNode::group(
                            child_bounds,
                            None,
                            vec![*previous_child, marker_leaf],
                            CacheHint::None,
                            LayerSemantic::default(),
                        );
                    }
                }
            }
            LayerNodeKind::Leaf { ops, .. } => {
                let LayerNodeKind::Leaf {
                    ops: marker_ops, ..
                } = marker_leaf.kind
                else {
                    unreachable!()
                };
                ops.extend(marker_ops);
            }
        }
        Some(layer)
    }

    fn should_emit_node(&self, node: &RenderNode) -> bool {
        node.visible && (!node.editor_only || self.profile.shows_editor_visuals())
    }

    fn build_paint_node(&mut self, node: &RenderNode, op: PaintOp) -> LayerNode {
        let visual_bounds = op.visual_bounds();
        if node.children.is_empty() {
            return LayerNode::leaf_with_hint(
                visual_bounds,
                Some(node.id),
                vec![op],
                self.cache_hint_for(&node.node_type),
            );
        }

        let mut children = Vec::with_capacity(node.children.len() + 1);
        children.push(LayerNode::leaf_with_hint(
            visual_bounds,
            Some(node.id),
            vec![op],
            self.cache_hint_for(&node.node_type),
        ));
        children.extend(self.build_children(node));

        let mut group_bounds = visual_bounds;
        for child in &children[1..] {
            let left = group_bounds.x.min(child.bounds.x);
            let top = group_bounds.y.min(child.bounds.y);
            let right =
                (group_bounds.x + group_bounds.width).max(child.bounds.x + child.bounds.width);
            let bottom =
                (group_bounds.y + group_bounds.height).max(child.bounds.y + child.bounds.height);
            group_bounds = crate::renderer::render_tree::BoundingBox::new(
                left,
                top,
                right - left,
                bottom - top,
            );
        }

        LayerNode::group(
            group_bounds,
            None,
            children,
            self.cache_hint_for(&node.node_type),
            LayerSemantic::default(),
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
            image: background.image.as_ref().map(|image| {
                let (brightness, contrast) = image.display_brightness_contrast();
                LayerPageBackgroundImagePaint {
                    resource_id: self.intern_replay_image_bytes(&image.data),
                    fill_mode: image.fill_mode,
                    brightness,
                    contrast,
                    effect: image.effect,
                    opacity: image.display_opacity(),
                }
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

    fn build_line_paint(&self, line: &crate::renderer::render_tree::LineNode) -> LayerLinePaint {
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

    fn build_path_paint(&self, path: &crate::renderer::render_tree::PathNode) -> LayerPathPaint {
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
                .map(|bytes| self.intern_replay_image_bytes(bytes)),
            external_path: image.external_path.clone(),
            text_wrap: image.text_wrap,
            fill_mode: image.fill_mode,
            original_size: image.original_size,
            crop: image.crop,
            original_size_hu: image.original_size_hu,
            brightness: image.brightness,
            contrast: image.contrast,
            effect: image.effect,
            transform: image.transform,
        }
    }

    fn intern_replay_image_bytes(&mut self, bytes: &[u8]) -> ImageResourceId {
        let normalized = crate::renderer::image_resource::normalize_replay_image_bytes(bytes);
        self.resources.intern_image_bytes(&normalized)
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

    fn semantic_for(&self, node_type: &RenderNodeType) -> LayerSemantic {
        match node_type {
            RenderNodeType::MasterPage => LayerSemantic::role(LayerSemanticRole::MasterPage),
            RenderNodeType::Header => LayerSemantic::role(LayerSemanticRole::Header),
            RenderNodeType::Footer => LayerSemantic::role(LayerSemanticRole::Footer),
            RenderNodeType::Body { .. } => LayerSemantic::role(LayerSemanticRole::Body),
            RenderNodeType::Column(index) => LayerSemantic::column(*index),
            RenderNodeType::FootnoteArea => LayerSemantic::role(LayerSemanticRole::FootnoteArea),
            RenderNodeType::TextLine(line) => {
                LayerSemantic::text_line(line.section_index, line.para_index)
            }
            RenderNodeType::Table(table) => LayerSemantic::table(
                table.section_index,
                table.para_index,
                table.control_index,
                table.row_count,
                table.col_count,
            ),
            RenderNodeType::TableCell(_) => LayerSemantic::role(LayerSemanticRole::TableCell),
            RenderNodeType::TextBox => LayerSemantic::role(LayerSemanticRole::TextBox),
            RenderNodeType::Group(group) => LayerSemantic {
                role: LayerSemanticRole::Group,
                section_index: group.section_index,
                para_index: group.para_index,
                control_index: group.control_index,
                ..LayerSemantic::default()
            },
            _ => LayerSemantic::default(),
        }
    }
}

fn projected_text_clusters(
    source: &str,
    display_clusters: &[String],
    positions: &[f64],
) -> Vec<TextClusterPlacement> {
    let source_chars = source.char_indices().collect::<Vec<_>>();
    if source_chars.len() != display_clusters.len() {
        return Vec::new();
    }

    let mut display_utf8 = 0_u32;
    let mut display_utf16 = 0_u32;
    let mut display_char_index = 0usize;

    source_chars
        .iter()
        .enumerate()
        .map(|(index, (source_utf8_start, _))| {
            let source_utf8_end = source_chars
                .get(index + 1)
                .map_or(source.len(), |(offset, _)| *offset);
            let fragment = &display_clusters[index];
            let fragment_char_count = fragment.chars().count();
            let display_utf8_end = display_utf8 + fragment.len() as u32;
            let display_utf16_end = display_utf16 + fragment.encode_utf16().count() as u32;
            let origin_x = positions
                .get(display_char_index)
                .copied()
                .unwrap_or_default();
            let next_display_char_index = display_char_index + fragment_char_count;
            let advance = positions
                .get(next_display_char_index)
                .map(|next| LayerVector {
                    dx: *next - origin_x,
                    dy: 0.0,
                });
            let cluster = TextClusterPlacement {
                source_range_utf8: TextSourceRange::new(
                    *source_utf8_start as u32,
                    source_utf8_end as u32,
                ),
                text_range_utf8: TextSourceRange::new(display_utf8, display_utf8_end),
                text_range_utf16: Some(TextSourceRange::new(display_utf16, display_utf16_end)),
                projection: TextProjectionKind::Normalized,
                origin: LayerPoint {
                    x: origin_x,
                    y: 0.0,
                },
                advance,
                flags: vec![
                    TextClusterFlag::SpecialVisual,
                    TextClusterFlag::NotShapingCandidate,
                ],
            };

            display_utf8 = display_utf8_end;
            display_utf16 = display_utf16_end;
            display_char_index = next_display_char_index;
            cluster
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paint::LayerNodeKind;
    use crate::renderer::composer::CharOverlapInfo;
    use crate::renderer::render_tree::{
        BoundingBox, FieldMarkerType, GroupNode, PageBackgroundNode, PageNode, RectangleNode,
        RenderNode, RenderNodeType, TableCellNode, TableNode, TextLineNode, TextRunNode,
    };
    use crate::renderer::render_tree::{EquationNode, ImageNode};
    use crate::renderer::{ShapeStyle, TabLeaderInfo, TextStyle};

    fn font_native_test_run(
        text: &str,
        char_shape_id: Option<u32>,
        font_family: &str,
    ) -> TextRunNode {
        TextRunNode {
            text: text.to_string(),
            display_text: None,
            display_clusters: None,
            style: TextStyle {
                font_family: font_family.to_string(),
                font_language_index: Some(0),
                font_size: 16.0,
                ..TextStyle::default()
            },
            char_shape_id,
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
            baseline: 12.0,
            field_marker: FieldMarkerType::None,
        }
    }

    fn count_leaf_source_nodes(node: &LayerNode, source_node_id: u32) -> usize {
        match &node.kind {
            LayerNodeKind::Group { children, .. } => children
                .iter()
                .map(|child| count_leaf_source_nodes(child, source_node_id))
                .sum(),
            LayerNodeKind::ClipRect { child, .. } => count_leaf_source_nodes(child, source_node_id),
            LayerNodeKind::Leaf { .. } => usize::from(node.source_node_id == Some(source_node_id)),
        }
    }

    #[test]
    fn preserves_source_ranges_for_collapsed_display_projection() {
        let source = "ᄒᆞᆫ글";
        let mut run = font_native_test_run(source, None, "sans-serif");
        run.display_text = Some("한글".to_string());
        run.display_clusters = Some(vec![
            "한".to_string(),
            String::new(),
            String::new(),
            "글".to_string(),
        ]);
        let mut tree = PageRenderTree::new(0, 100.0, 100.0);
        tree.root.children.push(RenderNode::new(
            1,
            RenderNodeType::TextRun(run),
            BoundingBox::new(0.0, 0.0, 32.0, 20.0),
        ));

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&tree);
        let LayerNodeKind::Group { children, .. } = &layer_tree.root.kind else {
            panic!("expected page group");
        };
        let LayerNodeKind::Leaf { ops, .. } = &children[0].kind else {
            panic!("expected text leaf");
        };
        let [PaintOp::TextRun { run, .. }] = ops.as_slice() else {
            panic!("expected one text run");
        };

        assert_eq!(run.text, source);
        assert_eq!(run.display_text.as_deref(), Some("한글"));
        assert_eq!(run.projection, TextProjectionKind::Normalized);
        assert_eq!(run.positions.len(), source.chars().count() + 1);
        assert_eq!(run.positions[1], run.positions[2]);
        assert_eq!(run.positions[2], run.positions[3]);
        assert_eq!(run.clusters.len(), 4);
        assert_eq!(run.clusters[0].text_range_utf8, TextSourceRange::new(0, 3));
        assert_eq!(run.clusters[1].text_range_utf8, TextSourceRange::new(3, 3));
        assert_eq!(run.clusters[2].text_range_utf8, TextSourceRange::new(3, 3));
        assert_eq!(run.clusters[3].text_range_utf8, TextSourceRange::new(3, 6));
        assert!(run.clusters.iter().all(|cluster| cluster
            .flags
            .contains(&TextClusterFlag::NotShapingCandidate)));
        assert_eq!(layer_tree.text_sources.entries[0].text, source);
    }

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
                        clip,
                        clip_kind,
                        clip_policy,
                        ..
                    } => {
                        assert_eq!(clip.x, 10.0);
                        assert_eq!(*clip_kind, ClipKind::Body);
                        assert_eq!(clip_policy.right_overflow_slop, 4.0);
                        assert!(clip_policy.allow_horizontal_overflow_controls);
                    }
                    other => panic!("expected clip rect, got {other:?}"),
                }
            }
            other => panic!("expected root group, got {other:?}"),
        }
    }

    #[test]
    fn embedded_font_build_uses_render_tree_char_shape_slot_sequence() {
        let bbox = BoundingBox::new(10.0, 20.0, 16.0, 16.0);
        let mut tree = PageRenderTree::new(0, 100.0, 100.0);
        tree.root.children.push(RenderNode::new(
            1,
            RenderNodeType::TextRun(font_native_test_run(
                "\u{E100}",
                Some(1),
                "RHWP Bitmap SVG Glyph Smoke",
            )),
            bbox,
        ));
        tree.root.children.push(RenderNode::new(
            2,
            RenderNodeType::TextRun(font_native_test_run(
                "\u{E100}",
                Some(2),
                "unrelated CSS fallback",
            )),
            bbox,
        ));
        let font = include_bytes!("../../tests/fixtures/fonts/RHWPBitmapSvgGlyphSmoke.ttf");
        let mut builder = LayerBuilder::new(RenderProfile::Screen);

        let layer_tree = builder.build_with_embedded_fonts(
            &tree,
            &[EmbeddedFontFace {
                char_shape_id: 2,
                language_index: 0,
                family: "RHWP Bitmap SVG Glyph Smoke",
                alternate_family: None,
                bytes: font,
                face_index: 0,
            }],
        );

        let LayerNodeKind::Group { children, .. } = &layer_tree.root.kind else {
            panic!("expected page group");
        };
        let LayerNodeKind::Leaf { ops: first_ops, .. } = &children[0].kind else {
            panic!("expected first text leaf");
        };
        let LayerNodeKind::Leaf {
            ops: second_ops, ..
        } = &children[1].kind
        else {
            panic!("expected second text leaf");
        };
        assert!(matches!(first_ops.as_slice(), [PaintOp::TextRun { .. }]));
        assert!(matches!(second_ops.as_slice(), [PaintOp::TextRun { .. }]));
        assert!(matches!(
            layer_tree.variant_ops.as_slice(),
            [PaintOp::GlyphOutline { .. }]
        ));
        assert_eq!(layer_tree.resources.image_count(), 1);
        assert_eq!(layer_tree.resources.font_blob_count(), 0);
        assert!(layer_tree.resources.font_resources().blobs.is_empty());
        assert!(layer_tree.resources.font_resources().faces.is_empty());
        let v2_ops = crate::paint::lower_v1_layer_tree_text_variants_to_v2(&layer_tree);
        let validation = crate::paint::validate_text_v2_ops(
            &v2_ops,
            &crate::paint::TextV2ValidationOptions {
                allow_richer_glyph_outline_payloads: true,
                allow_bitmap_glyph_payloads: true,
                ..crate::paint::TextV2ValidationOptions::default()
            },
        );
        assert!(
            validation.is_empty(),
            "font-native sidecar must satisfy the current v2 contract: {validation:?}"
        );
    }

    #[test]
    fn layer_output_options_default_keeps_clipping_enabled() {
        let output_options = LayerOutputOptions::default();

        assert!(!output_options.show_paragraph_marks);
        assert!(!output_options.show_control_codes);
        assert!(!output_options.show_transparent_borders);
        assert!(output_options.clip_enabled);
        assert!(!output_options.debug_overlay);
    }

    #[test]
    fn clip_disabled_lowers_body_as_unclipped_group_without_overflow_replay() {
        let mut tree = PageRenderTree::new(0, 800.0, 600.0);
        tree.root.node_type = RenderNodeType::Page(PageNode {
            page_index: 0,
            width: 800.0,
            height: 600.0,
            section_index: 0,
        });
        let mut body = RenderNode::new(
            1,
            RenderNodeType::Body {
                clip_rect: Some(BoundingBox::new(100.0, 20.0, 600.0, 400.0)),
            },
            BoundingBox::new(100.0, 20.0, 600.0, 400.0),
        );
        let mut column = RenderNode::new(
            2,
            RenderNodeType::Column(0),
            BoundingBox::new(100.0, 20.0, 600.0, 400.0),
        );
        column.children.push(RenderNode::new(
            3,
            RenderNodeType::Rectangle(RectangleNode::new(
                0.0,
                ShapeStyle {
                    fill_color: Some(0x000000),
                    ..Default::default()
                },
                None,
            )),
            BoundingBox::new(720.0, 40.0, 80.0, 40.0),
        ));
        body.children.push(column);
        tree.root.children.push(body);

        let mut builder =
            LayerBuilder::new(RenderProfile::Screen).with_output_options(LayerOutputOptions {
                clip_enabled: false,
                ..Default::default()
            });
        let layer_tree = builder.build(&tree);

        assert!(!layer_tree.output_options.clip_enabled);
        match &layer_tree.root.kind {
            LayerNodeKind::Group { children, .. } => {
                assert_eq!(children.len(), 1);
                assert_eq!(children[0].semantic.role, LayerSemanticRole::Body);
                match &children[0].kind {
                    LayerNodeKind::Group { children, .. } => {
                        assert_eq!(
                            children.len(),
                            1,
                            "clip-disabled body should not add overflow replay"
                        );
                        assert!(matches!(&children[0].kind, LayerNodeKind::Group { .. }));
                    }
                    other => panic!("expected unclipped body group, got {other:?}"),
                }
            }
            other => panic!("expected root group, got {other:?}"),
        }
    }

    #[test]
    fn clip_disabled_lowers_table_cell_as_unclipped_group() {
        let mut tree = PageRenderTree::new(0, 800.0, 600.0);
        tree.root.children.push(RenderNode::new(
            10,
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

        let mut builder =
            LayerBuilder::new(RenderProfile::Screen).with_output_options(LayerOutputOptions {
                clip_enabled: false,
                ..Default::default()
            });
        let layer_tree = builder.build(&tree);

        match &layer_tree.root.kind {
            LayerNodeKind::Group { children, .. } => {
                assert_eq!(children.len(), 1);
                assert_eq!(children[0].semantic.role, LayerSemanticRole::TableCell);
                assert!(
                    matches!(&children[0].kind, LayerNodeKind::Group { .. }),
                    "clip-disabled table cell should lower as an unclipped group"
                );
            }
            other => panic!("expected root group, got {other:?}"),
        }
    }

    #[test]
    fn lowers_body_horizontal_overflow_controls() {
        let mut tree = PageRenderTree::new(0, 800.0, 600.0);
        tree.root.node_type = RenderNodeType::Page(PageNode {
            page_index: 0,
            width: 800.0,
            height: 600.0,
            section_index: 0,
        });
        let mut body = RenderNode::new(
            1,
            RenderNodeType::Body {
                clip_rect: Some(BoundingBox::new(100.0, 20.0, 600.0, 400.0)),
            },
            BoundingBox::new(100.0, 20.0, 600.0, 400.0),
        );
        let mut column = RenderNode::new(
            2,
            RenderNodeType::Column(0),
            BoundingBox::new(100.0, 20.0, 600.0, 400.0),
        );
        column.children.push(RenderNode::new(
            4,
            RenderNodeType::Rectangle(RectangleNode::new(
                0.0,
                ShapeStyle {
                    fill_color: Some(0x000000),
                    ..Default::default()
                },
                None,
            )),
            BoundingBox::new(120.0, 40.0, 40.0, 40.0),
        ));
        column.children.push(RenderNode::new(
            3,
            RenderNodeType::Rectangle(RectangleNode::new(
                0.0,
                ShapeStyle {
                    fill_color: Some(0x000000),
                    ..Default::default()
                },
                None,
            )),
            BoundingBox::new(680.0, 40.0, 80.0, 40.0),
        ));
        column.children.push(RenderNode::new(
            5,
            RenderNodeType::Rectangle(RectangleNode::new(
                0.0,
                ShapeStyle {
                    fill_color: Some(0x000000),
                    ..Default::default()
                },
                None,
            )),
            BoundingBox::new(180.0, 40.0, 40.0, 40.0),
        ));
        body.children.push(column);
        tree.root.children.push(body);

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&tree);

        match &layer_tree.root.kind {
            LayerNodeKind::Group { children, .. } => match &children[0].kind {
                LayerNodeKind::Group {
                    children: body_children,
                    ..
                } => {
                    assert_eq!(body_children.len(), 1);
                    let LayerNodeKind::Group {
                        children: column_children,
                        ..
                    } = &body_children[0].kind
                    else {
                        panic!("expected routed column group");
                    };
                    assert_eq!(column_children.len(), 3);
                    match &column_children[0].kind {
                        LayerNodeKind::ClipRect {
                            clip_kind: ClipKind::Body,
                            child,
                            ..
                        } => match &child.kind {
                            LayerNodeKind::Group { children, .. } => {
                                assert_eq!(children.len(), 1);
                                assert_eq!(children[0].source_node_id, Some(4));
                            }
                            other => panic!("expected leading flow group, got {other:?}"),
                        },
                        other => panic!("expected leading body clip, got {other:?}"),
                    }
                    match &column_children[1].kind {
                        LayerNodeKind::ClipRect {
                            clip,
                            clip_kind,
                            child,
                            ..
                        } => {
                            assert_eq!(*clip_kind, ClipKind::Generic);
                            assert_eq!(clip.x, 0.0);
                            assert_eq!(clip.width, 800.0);
                            assert_eq!(clip.y, 20.0);
                            assert_eq!(clip.height, 400.0);
                            assert!(matches!(child.kind, LayerNodeKind::Leaf { .. }));
                        }
                        other => panic!("expected overflow clip rect, got {other:?}"),
                    }
                    match &column_children[2].kind {
                        LayerNodeKind::ClipRect {
                            clip_kind: ClipKind::Body,
                            child,
                            ..
                        } => match &child.kind {
                            LayerNodeKind::Group { children, .. } => {
                                assert_eq!(children.len(), 1);
                                assert_eq!(children[0].source_node_id, Some(5));
                            }
                            other => panic!("expected trailing flow group, got {other:?}"),
                        },
                        other => panic!("expected trailing body clip, got {other:?}"),
                    }
                    assert_eq!(
                        count_leaf_source_nodes(&children[0], 3),
                        1,
                        "overflow control must be lowered exactly once"
                    );
                    assert_eq!(count_leaf_source_nodes(&children[0], 4), 1);
                    assert_eq!(count_leaf_source_nodes(&children[0], 5), 1);
                }
                other => panic!("expected routed body group, got {other:?}"),
            },
            other => panic!("expected root group, got {other:?}"),
        }
    }

    #[test]
    fn routes_body_controls_when_only_visual_bounds_overflow() {
        let mut tree = PageRenderTree::new(0, 800.0, 600.0);
        tree.root.node_type = RenderNodeType::Page(PageNode {
            page_index: 0,
            width: 800.0,
            height: 600.0,
            section_index: 0,
        });
        let mut body = RenderNode::new(
            1,
            RenderNodeType::Body {
                clip_rect: Some(BoundingBox::new(100.0, 20.0, 600.0, 400.0)),
            },
            BoundingBox::new(100.0, 20.0, 600.0, 400.0),
        );
        let mut column = RenderNode::new(
            2,
            RenderNodeType::Column(0),
            BoundingBox::new(100.0, 20.0, 600.0, 400.0),
        );
        column.children.push(RenderNode::new(
            3,
            RenderNodeType::Rectangle(RectangleNode::new(
                0.0,
                ShapeStyle {
                    fill_color: Some(0x000000),
                    stroke_color: Some(0x000000),
                    stroke_width: 12.0,
                    ..Default::default()
                },
                None,
            )),
            BoundingBox::new(640.0, 40.0, 60.0, 40.0),
        ));
        body.children.push(column);
        tree.root.children.push(body);

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&tree);

        let LayerNodeKind::Group { children, .. } = &layer_tree.root.kind else {
            panic!("expected root group");
        };
        let LayerNodeKind::Group {
            children: body_children,
            ..
        } = &children[0].kind
        else {
            panic!("expected routed body group");
        };
        let LayerNodeKind::Group {
            children: column_children,
            ..
        } = &body_children[0].kind
        else {
            panic!("expected routed column group");
        };
        let LayerNodeKind::ClipRect {
            clip,
            clip_kind,
            child,
            ..
        } = &column_children[0].kind
        else {
            panic!("expected visual-overflow clip");
        };

        assert_eq!(*clip_kind, ClipKind::Generic);
        assert_eq!((clip.x, clip.width), (0.0, 800.0));
        assert!(
            child.bounds.x + child.bounds.width > 700.0,
            "stroke must expand the visual bounds beyond the authored body"
        );
        assert_eq!(count_leaf_source_nodes(&children[0], 3), 1);
    }

    #[test]
    fn keeps_in_bounds_flow_structures_under_the_body_clip() {
        let mut tree = PageRenderTree::new(0, 800.0, 600.0);
        tree.root.node_type = RenderNodeType::Page(PageNode {
            page_index: 0,
            width: 800.0,
            height: 600.0,
            section_index: 0,
        });
        let mut body = RenderNode::new(
            1,
            RenderNodeType::Body {
                clip_rect: Some(BoundingBox::new(100.0, 20.0, 600.0, 400.0)),
            },
            BoundingBox::new(100.0, 20.0, 600.0, 400.0),
        );
        let mut column = RenderNode::new(
            2,
            RenderNodeType::Column(0),
            BoundingBox::new(100.0, 20.0, 600.0, 400.0),
        );
        let mut table = RenderNode::new(
            3,
            RenderNodeType::Table(TableNode {
                row_count: 1,
                col_count: 1,
                border_fill_id: 0,
                section_index: None,
                para_index: None,
                control_index: None,
            }),
            BoundingBox::new(100.0, 40.0, 300.0, 80.0),
        );
        table.children.push(RenderNode::new(
            4,
            RenderNodeType::Rectangle(RectangleNode::new(
                0.0,
                ShapeStyle {
                    stroke_color: Some(0x000000),
                    stroke_width: 12.0,
                    ..Default::default()
                },
                None,
            )),
            BoundingBox::new(100.0, 40.0, 300.0, 80.0),
        ));
        column.children.push(table);
        body.children.push(column);
        tree.root.children.push(body);

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&tree);

        let LayerNodeKind::Group { children, .. } = &layer_tree.root.kind else {
            panic!("expected root group");
        };
        let LayerNodeKind::Group {
            children: body_children,
            ..
        } = &children[0].kind
        else {
            panic!("expected routed body group");
        };
        let LayerNodeKind::Group {
            children: column_children,
            ..
        } = &body_children[0].kind
        else {
            panic!("expected routed column group");
        };

        assert_eq!(column_children.len(), 1);
        assert!(matches!(
            column_children[0].kind,
            LayerNodeKind::ClipRect {
                clip_kind: ClipKind::Body,
                ..
            }
        ));
        assert_eq!(count_leaf_source_nodes(&children[0], 4), 1);
    }

    #[test]
    fn caps_floating_body_controls_when_flow_expands_the_resolved_clip() {
        let mut tree = PageRenderTree::new(0, 800.0, 600.0);
        tree.root.node_type = RenderNodeType::Page(PageNode {
            page_index: 0,
            width: 800.0,
            height: 600.0,
            section_index: 0,
        });
        let mut body = RenderNode::new(
            1,
            RenderNodeType::Body {
                clip_rect: Some(BoundingBox::new(100.0, 20.0, 600.0, 200.0)),
            },
            BoundingBox::new(100.0, 20.0, 600.0, 100.0),
        );
        let mut column = RenderNode::new(
            2,
            RenderNodeType::Column(0),
            BoundingBox::new(100.0, 20.0, 600.0, 200.0),
        );
        column.children.push(RenderNode::new(
            3,
            RenderNodeType::Rectangle(RectangleNode::new(
                0.0,
                ShapeStyle {
                    fill_color: Some(0x000000),
                    ..Default::default()
                },
                None,
            )),
            BoundingBox::new(140.0, 110.0, 80.0, 80.0),
        ));
        body.children.push(column);
        tree.root.children.push(body);

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&tree);

        let LayerNodeKind::Group { children, .. } = &layer_tree.root.kind else {
            panic!("expected root group");
        };
        let LayerNodeKind::Group {
            children: body_children,
            ..
        } = &children[0].kind
        else {
            panic!("expected routed body group");
        };
        let LayerNodeKind::Group {
            children: column_children,
            ..
        } = &body_children[0].kind
        else {
            panic!("expected routed column group");
        };
        let LayerNodeKind::ClipRect {
            clip, clip_kind, ..
        } = &column_children[0].kind
        else {
            panic!("expected capped floating control");
        };

        assert_eq!(*clip_kind, ClipKind::Body);
        assert_eq!(clip.y, 20.0);
        assert_eq!(clip.height, 110.0);
        assert_eq!(count_leaf_source_nodes(&children[0], 3), 1);
    }

    #[test]
    fn lowers_nested_body_horizontal_overflow_controls() {
        let mut tree = PageRenderTree::new(0, 800.0, 600.0);
        tree.root.node_type = RenderNodeType::Page(PageNode {
            page_index: 0,
            width: 800.0,
            height: 600.0,
            section_index: 0,
        });
        let mut body = RenderNode::new(
            1,
            RenderNodeType::Body {
                clip_rect: Some(BoundingBox::new(100.0, 20.0, 600.0, 400.0)),
            },
            BoundingBox::new(100.0, 20.0, 600.0, 400.0),
        );
        let mut column = RenderNode::new(
            2,
            RenderNodeType::Column(0),
            BoundingBox::new(100.0, 20.0, 600.0, 400.0),
        );
        let mut group = RenderNode::new(
            3,
            RenderNodeType::Group(GroupNode {
                section_index: None,
                para_index: None,
                control_index: None,
            }),
            BoundingBox::new(120.0, 40.0, 640.0, 80.0),
        );
        group.children.push(RenderNode::new(
            4,
            RenderNodeType::Rectangle(RectangleNode::new(
                0.0,
                ShapeStyle {
                    fill_color: Some(0x000000),
                    ..Default::default()
                },
                None,
            )),
            BoundingBox::new(180.0, 48.0, 40.0, 32.0),
        ));
        group.children.push(RenderNode::new(
            5,
            RenderNodeType::Rectangle(RectangleNode::new(
                0.0,
                ShapeStyle {
                    fill_color: Some(0x000000),
                    ..Default::default()
                },
                None,
            )),
            BoundingBox::new(720.0, 48.0, 40.0, 32.0),
        ));
        column.children.push(group);
        body.children.push(column);
        tree.root.children.push(body);

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&tree);

        match &layer_tree.root.kind {
            LayerNodeKind::Group { children, .. } => match &children[0].kind {
                LayerNodeKind::Group {
                    children: body_children,
                    ..
                } => {
                    assert_eq!(body_children.len(), 1);
                    let LayerNodeKind::Group {
                        children: column_children,
                        ..
                    } = &body_children[0].kind
                    else {
                        panic!("expected routed column group");
                    };
                    assert_eq!(column_children.len(), 1);
                    match &column_children[0].kind {
                        LayerNodeKind::ClipRect { child, .. } => match &child.kind {
                            LayerNodeKind::Group { children, .. } => {
                                assert_eq!(
                                    children.len(),
                                    2,
                                    "the complete nested control should stay in one paint subtree"
                                );
                                assert!(children
                                    .iter()
                                    .all(|child| matches!(child.kind, LayerNodeKind::Leaf { .. })));
                            }
                            other => panic!("expected overflow group, got {other:?}"),
                        },
                        other => panic!("expected overflow clip rect, got {other:?}"),
                    }
                    assert_eq!(count_leaf_source_nodes(&children[0], 4), 1);
                    assert_eq!(count_leaf_source_nodes(&children[0], 5), 1);
                }
                other => panic!("expected routed body group, got {other:?}"),
            },
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
                    LayerNodeKind::ClipRect {
                        clip_kind,
                        clip_policy,
                        ..
                    } => {
                        assert_eq!(*clip_kind, ClipKind::TableCell);
                        assert_eq!(clip_policy.right_overflow_slop, 4.0);
                        assert!(!clip_policy.allow_horizontal_overflow_controls);
                    }
                    other => panic!("expected clip rect, got {other:?}"),
                }
            }
            other => panic!("expected root group, got {other:?}"),
        }
    }

    #[test]
    fn normalizes_page_background_image_display_semantics() {
        let mut tree = PageRenderTree::new(0, 80.0, 60.0);
        tree.root.children.push(RenderNode::new(
            1,
            RenderNodeType::PageBackground(PageBackgroundNode {
                background_color: Some(0x00FF_FFFF),
                border_color: None,
                border_width: 0.0,
                gradient: None,
                image: Some(crate::renderer::render_tree::PageBackgroundImage {
                    data: vec![0x89, b'P', b'N', b'G'],
                    fill_mode: crate::model::style::ImageFillMode::FitToSize,
                    brightness: -50,
                    contrast: 70,
                    effect: crate::model::image::ImageEffect::RealPic,
                }),
            }),
            BoundingBox::new(0.0, 0.0, 80.0, 60.0),
        ));

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&tree);
        let LayerNodeKind::Group { children, .. } = &layer_tree.root.kind else {
            panic!("expected root group");
        };
        let LayerNodeKind::Leaf { ops, .. } = &children[0].kind else {
            panic!("expected page background leaf");
        };
        let PaintOp::PageBackground { background, .. } = &ops[0] else {
            panic!("expected page background op");
        };
        let image = background.image.as_ref().expect("page background image");
        assert_eq!((image.brightness, image.contrast), (70, -50));
        assert_eq!(
            image.opacity,
            crate::renderer::render_tree::REAL_PICTURE_WATERMARK_PAGE_OPACITY
        );

        let json = layer_tree.to_json();
        assert!(json.contains("\"brightness\":70"));
        assert!(json.contains("\"contrast\":-50"));
        assert!(json.contains("\"opacity\":0.260000"));
    }

    #[test]
    fn lowers_text_control_marks_from_output_options() {
        let mut tree = PageRenderTree::new(0, 200.0, 80.0);
        tree.root.children.push(RenderNode::new(
            1,
            RenderNodeType::TextRun(TextRunNode {
                text: "a b\t".to_string(),
                display_text: None,
                display_clusters: None,
                style: crate::renderer::TextStyle {
                    font_size: 20.0,
                    ..Default::default()
                },
                char_shape_id: None,
                para_shape_id: None,
                section_index: None,
                para_index: None,
                char_start: None,
                cell_context: None,
                is_para_end: true,
                is_line_break_end: false,
                rotation: 33.0,
                is_vertical: false,
                char_overlap: None,
                border_fill_id: 0,
                baseline: 18.0,
                field_marker: FieldMarkerType::None,
            }),
            BoundingBox::new(10.0, 12.0, 90.0, 24.0),
        ));

        let mut builder =
            LayerBuilder::new(RenderProfile::Screen).with_output_options(LayerOutputOptions {
                show_paragraph_marks: true,
                show_control_codes: true,
                ..Default::default()
            });
        let layer_tree = builder.build(&tree);

        match &layer_tree.root.kind {
            LayerNodeKind::Group { children, .. } => match &children[0].kind {
                LayerNodeKind::Leaf { ops, .. } => {
                    assert_eq!(ops.len(), 4);
                    match &ops[0] {
                        PaintOp::TextRun { run, .. } => {
                            assert_eq!(
                                run.legacy_visuals.control_marks,
                                Some(TextLegacyVisualState::Mirror)
                            );
                            let kinds: Vec<_> =
                                run.control_marks.iter().map(|mark| mark.kind).collect();
                            assert_eq!(
                                kinds,
                                vec![
                                    LayerTextControlMarkKind::Space,
                                    LayerTextControlMarkKind::Tab,
                                    LayerTextControlMarkKind::ParagraphEnd,
                                ]
                            );
                        }
                        other => panic!("expected text run op, got {other:?}"),
                    }
                    assert!(ops[1..].iter().all(|op| matches!(
                        op,
                        PaintOp::TextControlMark { mark, .. }
                            if (mark.rotation - 33.0).abs() < f64::EPSILON
                    )));
                }
                other => panic!("expected text leaf, got {other:?}"),
            },
            other => panic!("expected root group, got {other:?}"),
        }
    }

    #[test]
    fn lowers_structure_control_marks_once_with_owner_scope_and_replay_plane() {
        let mut tree = PageRenderTree::new(0, 500.0, 300.0);
        tree.root.children.push(RenderNode::new(
            1,
            RenderNodeType::Table(TableNode {
                row_count: 1,
                col_count: 1,
                border_fill_id: 0,
                section_index: None,
                para_index: None,
                control_index: None,
            }),
            BoundingBox::new(10.0, 10.0, 80.0, 40.0),
        ));
        let mut image = ImageNode::new(1, None);
        image.text_wrap = Some(crate::model::shape::TextWrap::InFrontOfText);
        tree.root.children.push(RenderNode::new(
            2,
            RenderNodeType::Image(image),
            BoundingBox::new(100.0, 10.0, 80.0, 40.0),
        ));
        tree.root.children.push(RenderNode::new(
            3,
            RenderNodeType::TextBox,
            BoundingBox::new(190.0, 10.0, 80.0, 40.0),
        ));
        tree.root.children.push(RenderNode::new(
            4,
            RenderNodeType::Equation(EquationNode {
                svg_content: String::new(),
                layout_box: crate::renderer::equation::layout::LayoutBox {
                    x: 0.0,
                    y: 0.0,
                    width: 1.0,
                    height: 1.0,
                    baseline: 0.0,
                    kind: crate::renderer::equation::layout::LayoutKind::Empty,
                },
                color_str: "#000000".to_string(),
                color: 0,
                font_size: 12.0,
                section_index: None,
                para_index: None,
                control_index: None,
                cell_index: None,
                cell_para_index: None,
            }),
            BoundingBox::new(280.0, 10.0, 80.0, 40.0),
        ));
        for (id, node_type, y) in [
            (5, RenderNodeType::Header, 60.0),
            (6, RenderNodeType::Footer, 110.0),
            (7, RenderNodeType::FootnoteArea, 160.0),
        ] {
            tree.root.children.push(RenderNode::new(
                id,
                node_type,
                BoundingBox::new(10.0, y, 120.0, 40.0),
            ));
        }

        let mut builder =
            LayerBuilder::new(RenderProfile::Screen).with_output_options(LayerOutputOptions {
                show_control_codes: true,
                ..Default::default()
            });
        let layer_tree = builder.build(&tree);
        let mut marks = Vec::new();
        let mut stack = vec![&layer_tree.root];
        while let Some(node) = stack.pop() {
            match &node.kind {
                LayerNodeKind::Group { children, .. } => stack.extend(children.iter()),
                LayerNodeKind::ClipRect { child, .. } => stack.push(child),
                LayerNodeKind::Leaf { ops, .. } => {
                    marks.extend(ops.iter().filter_map(|op| match op {
                        PaintOp::TextControlMark { mark, .. } if mark.mark.kind.is_structure() => {
                            Some((mark.mark.kind, mark.text_wrap))
                        }
                        _ => None,
                    }));
                }
            }
        }
        let expected = [
            LayerTextControlMarkKind::Table,
            LayerTextControlMarkKind::Picture,
            LayerTextControlMarkKind::TextBox,
            LayerTextControlMarkKind::Equation,
            LayerTextControlMarkKind::Header,
            LayerTextControlMarkKind::Footer,
            LayerTextControlMarkKind::FootnoteArea,
        ];
        for kind in expected {
            assert_eq!(
                marks
                    .iter()
                    .filter(|(candidate, _)| *candidate == kind)
                    .count(),
                1,
                "{kind:?} must be emitted exactly once"
            );
        }
        assert_eq!(marks.len(), expected.len());
        assert!(marks.contains(&(
            LayerTextControlMarkKind::Picture,
            Some(crate::model::shape::TextWrap::InFrontOfText),
        )));

        let LayerNodeKind::Group { children, .. } = &layer_tree.root.kind else {
            panic!("expected root group");
        };
        let LayerNodeKind::ClipRect { child, .. } = &children[2].kind else {
            panic!("text box structure mark must remain inside its clip");
        };
        let LayerNodeKind::Group { children, .. } = &child.kind else {
            panic!("expected clipped text box group");
        };
        assert!(children.iter().any(|child| match &child.kind {
            LayerNodeKind::Leaf { ops, .. } => ops.iter().any(|op| matches!(
                op,
                PaintOp::TextControlMark { mark, .. }
                    if mark.mark.kind == LayerTextControlMarkKind::TextBox
            )),
            _ => false,
        }));

        let json = layer_tree.to_json();
        assert!(json.contains("\"schemaMinorVersion\":22"));
        assert!(json.contains("\"text.structureControlMarkOp\""));
        assert!(json.contains("\"wrap\":\"inFrontOfText\""));

        let mut default_builder = LayerBuilder::new(RenderProfile::Screen);
        let default_tree = default_builder.build(&tree);
        let mut stack = vec![&default_tree.root];
        while let Some(node) = stack.pop() {
            match &node.kind {
                LayerNodeKind::Group { children, .. } => stack.extend(children.iter()),
                LayerNodeKind::ClipRect { child, .. } => stack.push(child),
                LayerNodeKind::Leaf { ops, .. } => assert!(!ops.iter().any(|op| matches!(
                    op,
                    PaintOp::TextControlMark { mark, .. } if mark.mark.kind.is_structure()
                ))),
            }
        }
    }

    #[test]
    fn externalizes_char_overlap_with_legacy_mirror() {
        let mut tree = PageRenderTree::new(0, 300.0, 200.0);
        tree.root.children.push(RenderNode::new(
            1,
            RenderNodeType::TextRun(TextRunNode {
                text: "12".to_string(),
                display_text: None,
                display_clusters: None,
                style: TextStyle {
                    font_size: 18.0,
                    ..TextStyle::default()
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
                char_overlap: Some(CharOverlapInfo {
                    border_type: 1,
                    inner_char_size: 90,
                }),
                border_fill_id: 0,
                baseline: 14.0,
                field_marker: FieldMarkerType::None,
            }),
            BoundingBox::new(20.0, 30.0, 30.0, 20.0),
        ));

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&tree);

        let LayerNodeKind::Group { children, .. } = &layer_tree.root.kind else {
            panic!("expected root group");
        };
        let LayerNodeKind::Leaf { ops, .. } = &children[0].kind else {
            panic!("expected text leaf");
        };
        assert_eq!(ops.len(), 2);
        match &ops[0] {
            PaintOp::TextRun { run, .. } => {
                assert_eq!(
                    run.legacy_visuals.char_overlap,
                    Some(TextLegacyVisualState::Mirror)
                );
                assert!(run.char_overlap.is_some());
            }
            other => panic!("expected text run mirror, got {other:?}"),
        }
        match &ops[1] {
            PaintOp::CharOverlap { overlap, .. } => {
                assert_eq!(overlap.text, "12");
                assert_eq!(overlap.overlap.border_type, 1);
            }
            other => panic!("expected char overlap op, got {other:?}"),
        }
    }

    #[test]
    fn externalizes_tab_leaders_with_legacy_mirror() {
        let mut tree = PageRenderTree::new(0, 300.0, 200.0);
        tree.root.children.push(RenderNode::new(
            1,
            RenderNodeType::TextRun(TextRunNode {
                text: "a\tb".to_string(),
                display_text: None,
                display_clusters: None,
                style: TextStyle {
                    tab_leaders: vec![TabLeaderInfo {
                        start_x: 12.0,
                        end_x: 42.0,
                        fill_type: 3,
                    }],
                    font_size: 18.0,
                    ..TextStyle::default()
                },
                char_shape_id: None,
                para_shape_id: None,
                section_index: None,
                para_index: None,
                char_start: None,
                cell_context: None,
                is_para_end: false,
                is_line_break_end: false,
                rotation: 27.0,
                is_vertical: false,
                char_overlap: None,
                border_fill_id: 0,
                baseline: 14.0,
                field_marker: FieldMarkerType::None,
            }),
            BoundingBox::new(20.0, 30.0, 80.0, 20.0),
        ));

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&tree);

        let LayerNodeKind::Group { children, .. } = &layer_tree.root.kind else {
            panic!("expected root group");
        };
        let LayerNodeKind::Leaf { ops, .. } = &children[0].kind else {
            panic!("expected text leaf");
        };
        assert_eq!(ops.len(), 2);
        match &ops[0] {
            PaintOp::TextRun { run, .. } => {
                assert_eq!(
                    run.legacy_visuals.tab_leaders,
                    Some(TextLegacyVisualState::Mirror)
                );
                assert_eq!(run.style.tab_leaders.len(), 1);
            }
            other => panic!("expected text run mirror, got {other:?}"),
        }
        match &ops[1] {
            PaintOp::TabLeader { leader, .. } => {
                assert_eq!(leader.leader.fill_type, 3);
                assert_eq!(leader.baseline, 14.0);
                assert_eq!(leader.rotation, 27.0);
            }
            other => panic!("expected tab leader op, got {other:?}"),
        }
        let json = layer_tree.to_json();
        assert!(json.contains("\"rotation\":27.000000"));
    }

    #[test]
    fn externalizes_text_decorations_with_legacy_mirror() {
        let mut tree = PageRenderTree::new(0, 300.0, 200.0);
        tree.root.children.push(RenderNode::new(
            1,
            RenderNodeType::TextRun(TextRunNode {
                text: "abc".to_string(),
                display_text: None,
                display_clusters: None,
                style: TextStyle {
                    underline: crate::model::style::UnderlineType::Bottom,
                    strikethrough: true,
                    emphasis_dot: 1,
                    font_size: 18.0,
                    ..TextStyle::default()
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
                baseline: 14.0,
                field_marker: FieldMarkerType::None,
            }),
            BoundingBox::new(20.0, 30.0, 80.0, 20.0),
        ));

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&tree);

        let LayerNodeKind::Group { children, .. } = &layer_tree.root.kind else {
            panic!("expected root group");
        };
        let LayerNodeKind::Leaf { ops, .. } = &children[0].kind else {
            panic!("expected text leaf");
        };
        assert_eq!(ops.len(), 4);
        match &ops[0] {
            PaintOp::TextRun { run, .. } => {
                assert_eq!(
                    run.legacy_visuals.decorations,
                    Some(TextLegacyVisualState::Mirror)
                );
            }
            other => panic!("expected text run mirror, got {other:?}"),
        }
        let kinds: Vec<_> = ops[1..]
            .iter()
            .map(|op| match op {
                PaintOp::TextDecoration { decoration, .. } => decoration.kind,
                other => panic!("expected text decoration op, got {other:?}"),
            })
            .collect();
        assert_eq!(
            kinds,
            vec![
                LayerTextDecorationKind::Underline,
                LayerTextDecorationKind::Strikethrough,
                LayerTextDecorationKind::EmphasisDot,
            ]
        );
    }

    #[test]
    fn lowers_group_semantics_as_lightweight_metadata() {
        let mut tree = PageRenderTree::new(0, 800.0, 600.0);
        tree.root.children.push(RenderNode::new(
            10,
            RenderNodeType::TextLine(TextLineNode::with_para(18.0, 14.0, 2, 9)),
            BoundingBox::new(20.0, 30.0, 400.0, 18.0),
        ));
        tree.root.children.push(RenderNode::new(
            11,
            RenderNodeType::Table(TableNode {
                row_count: 3,
                col_count: 4,
                border_fill_id: 0,
                section_index: Some(2),
                para_index: Some(9),
                control_index: Some(1),
            }),
            BoundingBox::new(20.0, 60.0, 360.0, 120.0),
        ));
        tree.root.children.push(RenderNode::new(
            12,
            RenderNodeType::Column(5),
            BoundingBox::new(420.0, 30.0, 300.0, 500.0),
        ));

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&tree);

        assert_eq!(layer_tree.root.semantic.role, LayerSemanticRole::Page);
        match &layer_tree.root.kind {
            LayerNodeKind::Group { children, .. } => {
                assert_eq!(children[0].semantic.role, LayerSemanticRole::TextLine);
                assert_eq!(children[0].semantic.section_index, Some(2));
                assert_eq!(children[0].semantic.para_index, Some(9));

                assert_eq!(children[1].semantic.role, LayerSemanticRole::Table);
                assert_eq!(children[1].semantic.section_index, Some(2));
                assert_eq!(children[1].semantic.para_index, Some(9));
                assert_eq!(children[1].semantic.control_index, Some(1));
                assert_eq!(children[1].semantic.row_count, Some(3));
                assert_eq!(children[1].semantic.col_count, Some(4));

                assert_eq!(children[2].semantic.role, LayerSemanticRole::Column);
                assert_eq!(children[2].semantic.column_index, Some(5));
            }
            other => panic!("expected root group, got {other:?}"),
        }
    }

    #[test]
    fn builds_textbox_clip_layer() {
        let mut tree = PageRenderTree::new(0, 800.0, 600.0);
        let mut textbox = RenderNode::new(
            7,
            RenderNodeType::TextBox,
            BoundingBox::new(50.0, 80.0, 240.0, 120.0),
        );
        textbox.children.push(RenderNode::new(
            8,
            RenderNodeType::TextRun(TextRunNode {
                text: "글상자".to_string(),
                display_text: None,
                display_clusters: None,
                style: crate::renderer::TextStyle {
                    font_size: 12.0,
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
                baseline: 12.0,
                field_marker: FieldMarkerType::None,
            }),
            BoundingBox::new(60.0, 90.0, 60.0, 20.0),
        ));
        tree.root.children.push(textbox);

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&tree);

        let LayerNodeKind::Group { children, .. } = &layer_tree.root.kind else {
            panic!("expected root group");
        };
        assert_eq!(children.len(), 1);

        let LayerNodeKind::ClipRect {
            clip,
            clip_kind,
            clip_policy,
            child,
        } = &children[0].kind
        else {
            panic!("expected textbox clip");
        };
        assert_eq!(*clip_kind, ClipKind::TextBox);
        assert_eq!(clip.x, 50.0);
        assert_eq!(clip.y, 80.0);
        assert_eq!(clip.width, 240.0);
        assert_eq!(clip.height, 120.0);
        assert_eq!(clip_policy.right_overflow_slop, 0.0);
        assert!(!clip_policy.allow_horizontal_overflow_controls);

        let LayerNodeKind::Group {
            children: textbox_children,
            ..
        } = &child.kind
        else {
            panic!("expected clipped textbox group");
        };
        assert_eq!(child.semantic.role, LayerSemanticRole::TextBox);
        assert!(matches!(
            &textbox_children[0].kind,
            LayerNodeKind::Leaf { .. }
        ));
    }

    #[test]
    fn render_node_type_lowering_is_explicit_for_all_variants() {
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        enum ExpectedLowering {
            StructuralGroup,
            Clip(ClipKind),
            Ops(&'static [&'static str]),
        }

        fn expected_for(node_type: &RenderNodeType) -> ExpectedLowering {
            match node_type {
                RenderNodeType::Page(_) => ExpectedLowering::StructuralGroup,
                RenderNodeType::PageBackground(_) => ExpectedLowering::Ops(&["PageBackground"]),
                RenderNodeType::MasterPage => ExpectedLowering::StructuralGroup,
                RenderNodeType::Header => ExpectedLowering::StructuralGroup,
                RenderNodeType::Footer => ExpectedLowering::StructuralGroup,
                RenderNodeType::Body { clip_rect: Some(_) } => {
                    ExpectedLowering::Clip(ClipKind::Body)
                }
                RenderNodeType::Body { clip_rect: None } => ExpectedLowering::StructuralGroup,
                RenderNodeType::Column(_) => ExpectedLowering::StructuralGroup,
                RenderNodeType::FootnoteArea => ExpectedLowering::StructuralGroup,
                RenderNodeType::TextLine(_) => ExpectedLowering::StructuralGroup,
                RenderNodeType::TextRun(_) => ExpectedLowering::Ops(&["TextRun"]),
                RenderNodeType::Table(_) => ExpectedLowering::StructuralGroup,
                RenderNodeType::TableCell(cell) if cell.clip => {
                    ExpectedLowering::Clip(ClipKind::TableCell)
                }
                RenderNodeType::TableCell(_) => ExpectedLowering::StructuralGroup,
                RenderNodeType::Line(_) => ExpectedLowering::Ops(&["Line"]),
                RenderNodeType::Rectangle(_) => ExpectedLowering::Ops(&["Rectangle"]),
                RenderNodeType::Ellipse(_) => ExpectedLowering::Ops(&["Ellipse"]),
                RenderNodeType::Path(_) => ExpectedLowering::Ops(&["Path"]),
                RenderNodeType::Image(_) => ExpectedLowering::Ops(&["Image"]),
                RenderNodeType::Group(_) => ExpectedLowering::StructuralGroup,
                RenderNodeType::TextBox => ExpectedLowering::Clip(ClipKind::TextBox),
                RenderNodeType::Equation(_) => ExpectedLowering::Ops(&["Equation"]),
                RenderNodeType::FormObject(_) => ExpectedLowering::Ops(&["FormObject"]),
                RenderNodeType::FootnoteMarker(_) => ExpectedLowering::Ops(&["FootnoteMarker"]),
                RenderNodeType::Placeholder(_) => ExpectedLowering::Ops(&["Rectangle", "TextRun"]),
                RenderNodeType::RawSvg(_) => ExpectedLowering::Ops(&["Equation"]),
            }
        }

        let bbox = BoundingBox::new(10.0, 20.0, 120.0, 40.0);
        let line_style = || crate::renderer::LineStyle {
            color: 0,
            width: 1.0,
            dash: crate::renderer::StrokeDash::Solid,
            line_type: crate::renderer::LineRenderType::Single,
            start_arrow: crate::renderer::ArrowStyle::None,
            end_arrow: crate::renderer::ArrowStyle::None,
            start_arrow_size: 0,
            end_arrow_size: 0,
            shadow: None,
        };
        let empty_layout = || crate::renderer::equation::layout::LayoutBox {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
            baseline: 0.0,
            kind: crate::renderer::equation::layout::LayoutKind::Empty,
        };
        let text_run = || crate::renderer::render_tree::TextRunNode {
            text: "x".to_string(),
            display_text: None,
            display_clusters: None,
            style: crate::renderer::TextStyle {
                font_size: 12.0,
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
            baseline: 12.0,
            field_marker: Default::default(),
        };
        let table_cell = |clip| TableCellNode {
            col: 0,
            row: 0,
            col_span: 1,
            row_span: 1,
            border_fill_id: 0,
            text_direction: 0,
            clip,
            model_cell_index: None,
        };
        let cases = vec![
            (
                "page",
                RenderNodeType::Page(PageNode {
                    page_index: 0,
                    width: 120.0,
                    height: 40.0,
                    section_index: 0,
                }),
            ),
            (
                "page background",
                RenderNodeType::PageBackground(PageBackgroundNode {
                    background_color: Some(0x00FF_FFFF),
                    border_color: None,
                    border_width: 0.0,
                    gradient: None,
                    image: None,
                }),
            ),
            ("master page", RenderNodeType::MasterPage),
            ("header", RenderNodeType::Header),
            ("footer", RenderNodeType::Footer),
            (
                "body clipped",
                RenderNodeType::Body {
                    clip_rect: Some(bbox),
                },
            ),
            ("body unclipped", RenderNodeType::Body { clip_rect: None }),
            ("column", RenderNodeType::Column(0)),
            ("footnote area", RenderNodeType::FootnoteArea),
            (
                "text line",
                RenderNodeType::TextLine(TextLineNode::new(14.0, 11.0)),
            ),
            ("text run", RenderNodeType::TextRun(text_run())),
            (
                "table",
                RenderNodeType::Table(TableNode {
                    row_count: 1,
                    col_count: 1,
                    border_fill_id: 0,
                    section_index: None,
                    para_index: None,
                    control_index: None,
                }),
            ),
            (
                "table cell clipped",
                RenderNodeType::TableCell(table_cell(true)),
            ),
            (
                "table cell unclipped",
                RenderNodeType::TableCell(table_cell(false)),
            ),
            (
                "line",
                RenderNodeType::Line(crate::renderer::render_tree::LineNode::new(
                    10.0,
                    20.0,
                    80.0,
                    20.0,
                    line_style(),
                )),
            ),
            (
                "rectangle",
                RenderNodeType::Rectangle(RectangleNode::new(0.0, ShapeStyle::default(), None)),
            ),
            (
                "ellipse",
                RenderNodeType::Ellipse(crate::renderer::render_tree::EllipseNode::new(
                    ShapeStyle::default(),
                    None,
                )),
            ),
            (
                "path",
                RenderNodeType::Path(crate::renderer::render_tree::PathNode::new(
                    vec![
                        crate::renderer::PathCommand::MoveTo(10.0, 20.0),
                        crate::renderer::PathCommand::LineTo(80.0, 20.0),
                    ],
                    ShapeStyle::default(),
                    None,
                )),
            ),
            (
                "image",
                RenderNodeType::Image(ImageNode::new(1, Some(vec![1, 2, 3]))),
            ),
            (
                "group",
                RenderNodeType::Group(crate::renderer::render_tree::GroupNode {
                    section_index: None,
                    para_index: None,
                    control_index: None,
                }),
            ),
            ("text box", RenderNodeType::TextBox),
            (
                "equation",
                RenderNodeType::Equation(EquationNode {
                    svg_content: "<text>x</text>".to_string(),
                    layout_box: empty_layout(),
                    color_str: "#000000".to_string(),
                    color: 0,
                    font_size: 12.0,
                    section_index: None,
                    para_index: None,
                    control_index: None,
                    cell_index: None,
                    cell_para_index: None,
                }),
            ),
            (
                "form object",
                RenderNodeType::FormObject(crate::renderer::render_tree::FormObjectNode {
                    form_type: crate::model::control::FormType::PushButton,
                    caption: "button".to_string(),
                    text: String::new(),
                    fore_color: "#000000".to_string(),
                    back_color: "#ffffff".to_string(),
                    value: 0,
                    enabled: true,
                    section_index: 0,
                    para_index: 0,
                    control_index: 0,
                    name: String::new(),
                    cell_location: None,
                }),
            ),
            (
                "footnote marker",
                RenderNodeType::FootnoteMarker(crate::renderer::render_tree::FootnoteMarkerNode {
                    number: 1,
                    text: "1)".to_string(),
                    base_font_size: 12.0,
                    font_family: String::new(),
                    color: 0,
                    section_index: 0,
                    para_index: 0,
                    control_index: 0,
                }),
            ),
            (
                "placeholder",
                RenderNodeType::Placeholder(crate::renderer::render_tree::PlaceholderNode {
                    fill_color: 0xFFE8_F0FE,
                    stroke_color: 0xFF4A_90E2,
                    label: "Chart".to_string(),
                }),
            ),
            (
                "raw svg",
                RenderNodeType::RawSvg(crate::renderer::render_tree::RawSvgNode {
                    svg: "<rect x=\"10\" y=\"20\" width=\"10\" height=\"10\"/>".to_string(),
                }),
            ),
        ];

        for (name, node_type) in cases {
            let expected = expected_for(&node_type);
            let mut tree = PageRenderTree::new(0, 200.0, 120.0);
            tree.root.children.push(RenderNode::new(1, node_type, bbox));

            let mut builder = LayerBuilder::new(RenderProfile::Screen);
            let layer_tree = builder.build(&tree);
            let child = match &layer_tree.root.kind {
                LayerNodeKind::Group { children, .. } => children
                    .first()
                    .unwrap_or_else(|| panic!("missing child for {name}")),
                other => panic!("expected root group for {name}, got {other:?}"),
            };

            match expected {
                ExpectedLowering::StructuralGroup => {
                    assert!(
                        matches!(child.kind, LayerNodeKind::Group { .. }),
                        "expected structural group for {name}, got {:?}",
                        child.kind,
                    );
                }
                ExpectedLowering::Clip(clip_kind) => match &child.kind {
                    LayerNodeKind::ClipRect {
                        clip_kind: actual, ..
                    } => assert_eq!(*actual, clip_kind, "wrong clip kind for {name}"),
                    other => panic!("expected clip lowering for {name}, got {other:?}"),
                },
                ExpectedLowering::Ops(expected_ops) => {
                    let mut actual_ops = Vec::new();
                    let mut stack = vec![child];
                    while let Some(node) = stack.pop() {
                        match &node.kind {
                            LayerNodeKind::Group { children, .. } => {
                                for child in children.iter().rev() {
                                    stack.push(child);
                                }
                            }
                            LayerNodeKind::ClipRect { child, .. } => stack.push(child),
                            LayerNodeKind::Leaf { ops, .. } => {
                                for op in ops {
                                    actual_ops.push(match op {
                                        PaintOp::PageBackground { .. } => "PageBackground",
                                        PaintOp::TextRun { .. } => "TextRun",
                                        PaintOp::GlyphRun { .. } => "GlyphRun",
                                        PaintOp::GlyphOutline { .. } => "GlyphOutline",
                                        PaintOp::CharOverlap { .. } => "CharOverlap",
                                        PaintOp::TextControlMark { .. } => "TextControlMark",
                                        PaintOp::TabLeader { .. } => "TabLeader",
                                        PaintOp::TextDecoration { .. } => "TextDecoration",
                                        PaintOp::FootnoteMarker { .. } => "FootnoteMarker",
                                        PaintOp::Line { .. } => "Line",
                                        PaintOp::Rectangle { .. } => "Rectangle",
                                        PaintOp::Ellipse { .. } => "Ellipse",
                                        PaintOp::Path { .. } => "Path",
                                        PaintOp::Image { .. } => "Image",
                                        PaintOp::Equation { .. } => "Equation",
                                        PaintOp::FormObject { .. } => "FormObject",
                                    });
                                }
                            }
                        }
                    }
                    assert_eq!(actual_ops, expected_ops, "wrong paint ops for {name}");
                }
            }
        }
    }

    #[test]
    fn lowers_raw_svg_single_data_image_to_shared_image_op() {
        let bbox = BoundingBox::new(10.0, 20.0, 120.0, 40.0);
        let mut tree = PageRenderTree::new(0, 200.0, 120.0);
        tree.root.children.push(RenderNode::new(
            1,
            RenderNodeType::RawSvg(crate::renderer::render_tree::RawSvgNode {
                svg: r#"<image x="10" y="20" width="120" height="40" preserveAspectRatio="xMidYMid meet" xlink:href="data:image/png;base64,iVBORw0KGgo=" href="data:image/png;base64,iVBORw0KGgo="/>"#.to_string(),
            }),
            bbox,
        ));

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&tree);

        assert_eq!(layer_tree.resources.image_count(), 1);
        assert_eq!(layer_tree.resources.svg_count(), 0);
        match &layer_tree.root.kind {
            LayerNodeKind::Group { children, .. } => match &children[0].kind {
                LayerNodeKind::Leaf { ops, .. } => match &ops[0] {
                    PaintOp::Image {
                        bbox: image_bbox,
                        image,
                    } => {
                        assert_eq!(image_bbox.x, bbox.x);
                        assert_eq!(image_bbox.y, bbox.y);
                        assert_eq!(image_bbox.width, bbox.width);
                        assert_eq!(image_bbox.height, bbox.height);
                        assert!(image.resource_id.is_some());
                        assert_eq!(
                            image.fill_mode,
                            Some(crate::model::style::ImageFillMode::FitToSize),
                        );
                        assert_eq!(image.effect, crate::model::image::ImageEffect::RealPic);
                    }
                    other => panic!("expected image op for single-image RawSvg, got {other:?}"),
                },
                other => panic!("expected raw svg image leaf, got {other:?}"),
            },
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
                display_text: None,
                display_clusters: None,
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
    fn drops_editor_only_nodes_from_print_equivalent_profiles() {
        fn child_ids(profile: RenderProfile) -> Vec<Option<u32>> {
            let mut tree = PageRenderTree::new(0, 800.0, 600.0);
            tree.root.children.push(
                RenderNode::new(
                    10,
                    RenderNodeType::Header,
                    BoundingBox::new(0.0, 0.0, 800.0, 48.0),
                )
                .with_editor_only(),
            );
            tree.root.children.push(RenderNode::new(
                11,
                RenderNodeType::Footer,
                BoundingBox::new(0.0, 552.0, 800.0, 48.0),
            ));

            let mut builder = LayerBuilder::new(profile);
            let layer_tree = builder.build(&tree);
            match &layer_tree.root.kind {
                LayerNodeKind::Group { children, .. } => {
                    children.iter().map(|child| child.source_node_id).collect()
                }
                other => panic!("expected root group, got {other:?}"),
            }
        }

        assert_eq!(
            child_ids(RenderProfile::FastPreview),
            vec![Some(10), Some(11)]
        );
        assert_eq!(child_ids(RenderProfile::Screen), vec![Some(10), Some(11)]);
        assert_eq!(child_ids(RenderProfile::Print), vec![Some(11)]);
        assert_eq!(child_ids(RenderProfile::HighQuality), vec![Some(11)]);
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
    fn lowers_leaf_nodes_with_visual_bounds() {
        let mut tree = PageRenderTree::new(0, 200.0, 100.0);
        tree.root.children.push(RenderNode::new(
            30,
            RenderNodeType::Rectangle(RectangleNode::new(
                0.0,
                ShapeStyle {
                    stroke_color: Some(0x000000),
                    stroke_width: 12.0,
                    ..Default::default()
                },
                None,
            )),
            BoundingBox::new(40.0, 20.0, 60.0, 30.0),
        ));

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&tree);

        match &layer_tree.root.kind {
            LayerNodeKind::Group { children, .. } => {
                assert!(children[0].bounds.x < 40.0);
                assert!(children[0].bounds.y < 20.0);
                assert!(children[0].bounds.width > 60.0);
                assert!(children[0].bounds.height > 30.0);
            }
            other => panic!("expected root group, got {other:?}"),
        }
    }

    #[test]
    fn lowers_vertical_text_orientation_from_layout_rotation() {
        let mut tree = PageRenderTree::new(0, 200.0, 100.0);
        tree.root.children.push(RenderNode::new(
            30,
            RenderNodeType::TextRun(TextRunNode {
                text: "A".to_string(),
                display_text: None,
                display_clusters: None,
                style: TextStyle {
                    font_size: 16.0,
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
                rotation: 90.0,
                is_vertical: true,
                char_overlap: None,
                border_fill_id: 0,
                baseline: 16.0,
                field_marker: FieldMarkerType::None,
            }),
            BoundingBox::new(20.0, 10.0, 20.0, 24.0),
        ));

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&tree);

        match &layer_tree.root.kind {
            LayerNodeKind::Group { children, .. } => match &children[0].kind {
                LayerNodeKind::Leaf { ops, .. } => match &ops[0] {
                    PaintOp::TextRun { run, .. } => {
                        assert_eq!(run.orientation, LayerTextOrientation::VerticalSideways);
                    }
                    other => panic!("expected text op, got {other:?}"),
                },
                other => panic!("expected text leaf, got {other:?}"),
            },
            other => panic!("expected root group, got {other:?}"),
        }
    }

    #[test]
    fn normalizes_pcx_picture_resources_before_interning() {
        let mut pcx = vec![0_u8; 128];
        pcx[0] = 0x0a;
        pcx[1] = 5;
        pcx[2] = 1;
        pcx[3] = 1;
        pcx[8..10].copy_from_slice(&7_u16.to_le_bytes());
        pcx[16..19].copy_from_slice(&[0, 0, 0]);
        pcx[19..22].copy_from_slice(&[255, 255, 255]);
        pcx[65] = 1;
        pcx[66..68].copy_from_slice(&2_u16.to_le_bytes());
        pcx.extend_from_slice(&[0xaa, 0]);

        let mut image = ImageNode::new(1, None);
        image.data = Some(pcx);
        let mut tree = PageRenderTree::new(0, 100.0, 100.0);
        tree.root.children.push(RenderNode::new(
            30,
            RenderNodeType::Image(image),
            BoundingBox::new(0.0, 0.0, 8.0, 1.0),
        ));

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&tree);
        let (_, bytes) = layer_tree
            .resources
            .image_resources()
            .next()
            .expect("normalized image resource");
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
        let decoded = image::load_from_memory_with_format(bytes, image::ImageFormat::Png)
            .expect("normalized PNG");
        assert_eq!((decoded.width(), decoded.height()), (8, 1));
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
                    brightness: 0,
                    contrast: 0,
                    effect: crate::model::image::ImageEffect::RealPic,
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
