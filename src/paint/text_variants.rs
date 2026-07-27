//! Text variant grouping validation.
//!
//! Schema v1 keeps `TextRun` as the root fallback op and attaches optional
//! visual alternatives such as `GlyphRun` through variant metadata. A variant is
//! selected as a set, not as a single op: consumers choose one `variant_id` per
//! `equivalence_group` and paint every part in that set. The v1 invariant keeps
//! all parts of one equivalence group inside the same leaf/paint-order scope so
//! existing replay order remains unambiguous.

use std::collections::{HashMap, HashSet};
use std::fmt;

use crate::paint::{
    LayerNode, LayerNodeKind, PageLayerTree, PaintOp, PaintVariantMeta, TextVariantKind,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TextVariantScopeError {
    CrossLeafGroup {
        equivalence_group: String,
        first_leaf: String,
        second_leaf: String,
    },
    MissingDefaultFallback {
        equivalence_group: String,
        leaf: String,
    },
    EmptyVariantSet {
        equivalence_group: String,
        variant_id: String,
        leaf: String,
    },
    DuplicatePart {
        equivalence_group: String,
        variant_id: String,
        part_index: u32,
        leaf: String,
    },
    PartCountMismatch {
        equivalence_group: String,
        variant_id: String,
        expected: u32,
        actual: u32,
        leaf: String,
    },
    MissingAnchorOpId {
        equivalence_group: String,
        variant_id: String,
        leaf: String,
    },
    MissingSidecarAnchor {
        equivalence_group: String,
        variant_id: String,
        anchor_op_id: String,
    },
    InvalidSidecarAnchor {
        equivalence_group: String,
        variant_id: String,
        anchor_op_id: String,
        leaf: String,
    },
    UnsupportedGlyphOutlineStyle {
        equivalence_group: String,
        variant_id: String,
        leaf: String,
    },
}

impl fmt::Display for TextVariantScopeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CrossLeafGroup {
                equivalence_group,
                first_leaf,
                second_leaf,
            } => write!(
                f,
                "text variant group `{equivalence_group}` crosses leaf scope `{first_leaf}` and `{second_leaf}`"
            ),
            Self::MissingDefaultFallback {
                equivalence_group,
                leaf,
            } => write!(
                f,
                "text variant group `{equivalence_group}` in leaf `{leaf}` has no default fallback"
            ),
            Self::EmptyVariantSet {
                equivalence_group,
                variant_id,
                leaf,
            } => write!(
                f,
                "text variant `{variant_id}` in group `{equivalence_group}` at leaf `{leaf}` has zero parts"
            ),
            Self::DuplicatePart {
                equivalence_group,
                variant_id,
                part_index,
                leaf,
            } => write!(
                f,
                "text variant `{variant_id}` in group `{equivalence_group}` at leaf `{leaf}` repeats part {part_index}"
            ),
            Self::PartCountMismatch {
                equivalence_group,
                variant_id,
                expected,
                actual,
                leaf,
            } => write!(
                f,
                "text variant `{variant_id}` in group `{equivalence_group}` at leaf `{leaf}` has {actual} parts, expected {expected}"
            ),
            Self::MissingAnchorOpId {
                equivalence_group,
                variant_id,
                leaf,
            } => write!(
                f,
                "glyph outline variant `{variant_id}` in group `{equivalence_group}` at leaf `{leaf}` has no anchorOpId"
            ),
            Self::MissingSidecarAnchor {
                equivalence_group,
                variant_id,
                anchor_op_id,
            } => write!(
                f,
                "sidecar text variant `{variant_id}` in group `{equivalence_group}` references missing anchor `{anchor_op_id}`"
            ),
            Self::InvalidSidecarAnchor {
                equivalence_group,
                variant_id,
                anchor_op_id,
                leaf,
            } => write!(
                f,
                "sidecar text variant `{variant_id}` in group `{equivalence_group}` references non-fallback anchor `{anchor_op_id}` at leaf `{leaf}`"
            ),
            Self::UnsupportedGlyphOutlineStyle {
                equivalence_group,
                variant_id,
                leaf,
            } => write!(
                f,
                "glyph outline variant `{variant_id}` in group `{equivalence_group}` at leaf `{leaf}` does not use a fill-only glyph replay style"
            ),
        }
    }
}

impl std::error::Error for TextVariantScopeError {}

#[derive(Debug, Default)]
struct LeafGroupState {
    has_default_fallback: bool,
    variants: HashMap<String, VariantPartState>,
}

#[derive(Debug, Default)]
struct VariantPartState {
    expected_part_count: Option<u32>,
    parts: HashSet<u32>,
}

/// Validates schema-v1 text variant grouping invariants.
///
/// The validator is intentionally conservative: one `equivalence_group` may not
/// cross leaf boundaries, and each group must contain a default fallback so old
/// and fallback-first consumers keep a faithful string replay path.
pub fn validate_text_variant_scope(tree: &PageLayerTree) -> Result<(), TextVariantScopeError> {
    let mut sidecars_by_anchor = HashMap::<String, Vec<&PaintOp>>::new();
    for op in &tree.variant_ops {
        let Some(variant) = op_variant(op) else {
            continue;
        };
        let Some(anchor_op_id) = variant.anchor_op_id.as_deref() else {
            return Err(TextVariantScopeError::MissingAnchorOpId {
                equivalence_group: variant.equivalence_group.clone(),
                variant_id: variant.variant_id.clone(),
                leaf: "variantOps".to_string(),
            });
        };
        sidecars_by_anchor
            .entry(anchor_op_id.to_string())
            .or_default()
            .push(op);
    }

    let mut group_leaf_paths = HashMap::new();
    validate_node(
        &tree.root,
        "root".to_string(),
        &mut group_leaf_paths,
        &mut sidecars_by_anchor,
    )?;

    if let Some((anchor_op_id, sidecars)) = sidecars_by_anchor.into_iter().next() {
        let variant = op_variant(sidecars[0]).expect("sidecar variants were indexed above");
        return Err(TextVariantScopeError::MissingSidecarAnchor {
            equivalence_group: variant.equivalence_group.clone(),
            variant_id: variant.variant_id.clone(),
            anchor_op_id,
        });
    }

    Ok(())
}

fn validate_node(
    node: &LayerNode,
    path: String,
    group_leaf_paths: &mut HashMap<String, String>,
    sidecars_by_anchor: &mut HashMap<String, Vec<&PaintOp>>,
) -> Result<(), TextVariantScopeError> {
    match &node.kind {
        LayerNodeKind::Group { children, .. } => {
            for (index, child) in children.iter().enumerate() {
                validate_node(
                    child,
                    format!("{path}/group[{index}]"),
                    group_leaf_paths,
                    sidecars_by_anchor,
                )?;
            }
        }
        LayerNodeKind::ClipRect { child, .. } => {
            validate_node(
                child,
                format!("{path}/clip"),
                group_leaf_paths,
                sidecars_by_anchor,
            )?;
        }
        LayerNodeKind::Leaf { ops, .. } => {
            let mut anchored_sidecars = Vec::new();
            for op in ops {
                let Some(anchor_variant) = op_variant(op) else {
                    continue;
                };
                let stable_op_id = anchor_variant.stable_op_id();
                let Some(sidecars) = sidecars_by_anchor.remove(&stable_op_id) else {
                    continue;
                };
                for sidecar in sidecars {
                    let sidecar_variant =
                        op_variant(sidecar).expect("sidecar variants were indexed above");
                    if anchor_variant.variant_kind != TextVariantKind::TextRun
                        || !anchor_variant.is_default_fallback
                        || sidecar_variant.equivalence_group != anchor_variant.equivalence_group
                    {
                        return Err(TextVariantScopeError::InvalidSidecarAnchor {
                            equivalence_group: sidecar_variant.equivalence_group.clone(),
                            variant_id: sidecar_variant.variant_id.clone(),
                            anchor_op_id: stable_op_id.clone(),
                            leaf: path,
                        });
                    }
                    anchored_sidecars.push(sidecar);
                }
            }
            validate_leaf(ops, &anchored_sidecars, path, group_leaf_paths)?;
        }
    }
    Ok(())
}

fn validate_leaf(
    ops: &[PaintOp],
    sidecar_ops: &[&PaintOp],
    leaf_path: String,
    group_leaf_paths: &mut HashMap<String, String>,
) -> Result<(), TextVariantScopeError> {
    let mut groups = HashMap::<String, LeafGroupState>::new();
    for op in ops.iter().chain(sidecar_ops.iter().copied()) {
        let Some(variant) = op_variant(op) else {
            continue;
        };
        if let Some(first_leaf) = group_leaf_paths.get(&variant.equivalence_group) {
            if first_leaf != &leaf_path {
                return Err(TextVariantScopeError::CrossLeafGroup {
                    equivalence_group: variant.equivalence_group.clone(),
                    first_leaf: first_leaf.clone(),
                    second_leaf: leaf_path,
                });
            }
        } else {
            group_leaf_paths.insert(variant.equivalence_group.clone(), leaf_path.clone());
        }

        let group = groups.entry(variant.equivalence_group.clone()).or_default();
        group.has_default_fallback |= variant.is_default_fallback;
        if variant.variant_kind == TextVariantKind::GlyphOutline && variant.anchor_op_id.is_none() {
            return Err(TextVariantScopeError::MissingAnchorOpId {
                equivalence_group: variant.equivalence_group.clone(),
                variant_id: variant.variant_id.clone(),
                leaf: leaf_path,
            });
        }
        if let PaintOp::GlyphOutline { outline, .. } = op {
            // Payload-family contracts are validated after v1-to-v2 lowering.
            // This validator owns only v1 grouping and paint-scope invariants.
            if !outline.paint_style.is_fill_only_glyph_replay() {
                return Err(TextVariantScopeError::UnsupportedGlyphOutlineStyle {
                    equivalence_group: outline.variant.equivalence_group.clone(),
                    variant_id: outline.variant.variant_id.clone(),
                    leaf: leaf_path,
                });
            }
        }
        let state = group
            .variants
            .entry(variant.variant_id.clone())
            .or_default();
        match state.expected_part_count {
            Some(expected) if expected != variant.part_count => {
                return Err(TextVariantScopeError::PartCountMismatch {
                    equivalence_group: variant.equivalence_group.clone(),
                    variant_id: variant.variant_id.clone(),
                    expected,
                    actual: variant.part_count,
                    leaf: leaf_path,
                });
            }
            Some(_) => {}
            None => {
                state.expected_part_count = Some(variant.part_count);
            }
        }
        if variant.part_count == 0 {
            return Err(TextVariantScopeError::EmptyVariantSet {
                equivalence_group: variant.equivalence_group.clone(),
                variant_id: variant.variant_id.clone(),
                leaf: leaf_path,
            });
        }
        if !state.parts.insert(variant.part_index) {
            return Err(TextVariantScopeError::DuplicatePart {
                equivalence_group: variant.equivalence_group.clone(),
                variant_id: variant.variant_id.clone(),
                part_index: variant.part_index,
                leaf: leaf_path,
            });
        }
    }

    for (equivalence_group, group) in groups {
        if !group.has_default_fallback {
            return Err(TextVariantScopeError::MissingDefaultFallback {
                equivalence_group,
                leaf: leaf_path,
            });
        }
        for (variant_id, state) in group.variants {
            let expected = state.expected_part_count.unwrap_or_default();
            let actual = state.parts.len() as u32;
            if expected != actual || !(0..expected).all(|index| state.parts.contains(&index)) {
                return Err(TextVariantScopeError::PartCountMismatch {
                    equivalence_group: equivalence_group.clone(),
                    variant_id,
                    expected,
                    actual,
                    leaf: leaf_path,
                });
            }
        }
    }
    Ok(())
}

fn op_variant(op: &PaintOp) -> Option<&PaintVariantMeta> {
    match op {
        PaintOp::TextRun { run, .. } => run.variant.as_ref(),
        PaintOp::GlyphRun { run, .. } => Some(&run.variant),
        PaintOp::GlyphOutline { outline, .. } => Some(&outline.variant),
        PaintOp::CharOverlap { overlap, .. } => overlap.variant.as_ref(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paint::resources::ResourceArena;
    use crate::paint::RenderProfile;
    use crate::paint::{
        GlyphOutlineFillRule, GlyphOutlinePayloadKind, GlyphRange, GlyphRunDiagnostics,
        GlyphRunReplayEligibility, LayerAffineTransform, LayerGlyphOutlinePaint,
        LayerGlyphOutlinePath, LayerNode, LayerOutputOptions, LayerTextRunPaint, PaintTextStyle,
        TextRunPlacement, TextSourceId, TextSourceRange, TextSourceSpan, TextSourceTable,
        TextVariantKind, TextVariantQuality,
    };
    use crate::renderer::render_tree::BoundingBox;
    use crate::renderer::{PathCommand, TextStyle};

    fn bbox() -> BoundingBox {
        BoundingBox::new(0.0, 0.0, 10.0, 10.0)
    }

    fn text_op(variant: PaintVariantMeta) -> PaintOp {
        let run = LayerTextRunPaint {
            variant: Some(variant),
            ..LayerTextRunPaint::default()
        };
        PaintOp::TextRun { bbox: bbox(), run }
    }

    fn outline_op(variant: PaintVariantMeta, style: TextStyle) -> PaintOp {
        PaintOp::GlyphOutline {
            bbox: bbox(),
            outline: Box::new(LayerGlyphOutlinePaint {
                source: TextSourceSpan {
                    id: TextSourceId(0),
                    utf8_range: TextSourceRange::new(0, 1),
                    utf16_range: TextSourceRange::new(0, 1),
                    stable_source_key: None,
                },
                variant,
                payload_kind: GlyphOutlinePayloadKind::MonochromeFill,
                stroke: None,
                color_layers: None,
                bitmap_glyph: None,
                svg_glyph: None,
                paint_style: PaintTextStyle::from(&style),
                placement: TextRunPlacement {
                    run_to_page: LayerAffineTransform {
                        a: 1.0,
                        b: 0.0,
                        c: 0.0,
                        d: 1.0,
                        e: 0.0,
                        f: 0.0,
                    },
                    baseline_y: 0.0,
                },
                paths: vec![LayerGlyphOutlinePath {
                    glyph_id: 42,
                    source_range_utf8: TextSourceRange::new(0, 1),
                    glyph_range: GlyphRange { start: 0, end: 1 },
                    commands: vec![
                        PathCommand::MoveTo(0.0, 0.0),
                        PathCommand::LineTo(1.0, 0.0),
                        PathCommand::LineTo(1.0, 1.0),
                        PathCommand::ClosePath,
                    ],
                    fill_rule: GlyphOutlineFillRule::NonZero,
                }],
                diagnostics: GlyphRunDiagnostics {
                    quality: TextVariantQuality::Exact,
                    replay_eligibility: GlyphRunReplayEligibility::Portable,
                    strict_visual_eligible: true,
                    max_origin_delta_px: 0.0,
                    max_advance_delta_px: 0.0,
                    max_residual_after_adjustment_px: 0.0,
                    cluster_mismatch_count: 0,
                    missing_glyph_count: 0,
                    used_fallback_font_count: 0,
                    reason: None,
                },
            }),
        }
    }

    fn tree(root: LayerNode) -> PageLayerTree {
        tree_with_variant_ops(root, Vec::new())
    }

    fn tree_with_variant_ops(root: LayerNode, variant_ops: Vec<PaintOp>) -> PageLayerTree {
        PageLayerTree {
            page_width: 100.0,
            page_height: 100.0,
            profile: RenderProfile::default(),
            output_options: LayerOutputOptions::default(),
            root,
            variant_ops,
            resources: ResourceArena::default(),
            text_sources: TextSourceTable::default(),
        }
    }

    #[test]
    fn accepts_variant_set_inside_one_leaf() {
        let glyph_part_0 = PaintVariantMeta {
            equivalence_group: "text-1".to_string(),
            variant_id: "glyphRun".to_string(),
            variant_kind: TextVariantKind::GlyphRun,
            part_index: 0,
            part_count: 2,
            is_default_fallback: false,
            requires: vec!["fontResources".to_string(), "text.glyphRun".to_string()],
            quality: None,
            anchor_op_id: None,
            local_paint_order: None,
        };
        let mut glyph_part_1 = glyph_part_0.clone();
        glyph_part_1.part_index = 1;
        let tree = tree(LayerNode::leaf(
            bbox(),
            None,
            vec![
                text_op(PaintVariantMeta::text_run_default("text-1")),
                text_op(glyph_part_0),
                text_op(glyph_part_1),
            ],
        ));
        validate_text_variant_scope(&tree).unwrap();
    }

    #[test]
    fn rejects_cross_leaf_variant_group() {
        let tree = tree(LayerNode::group(
            bbox(),
            None,
            vec![
                LayerNode::leaf(
                    bbox(),
                    None,
                    vec![text_op(PaintVariantMeta::text_run_default("text-1"))],
                ),
                LayerNode::leaf(
                    bbox(),
                    None,
                    vec![text_op(PaintVariantMeta::text_run_default("text-1"))],
                ),
            ],
            crate::paint::CacheHint::None,
            crate::paint::LayerSemantic::default(),
        ));
        assert!(matches!(
            validate_text_variant_scope(&tree),
            Err(TextVariantScopeError::CrossLeafGroup { .. })
        ));
    }

    #[test]
    fn rejects_incomplete_variant_parts() {
        let glyph_part = PaintVariantMeta {
            equivalence_group: "text-1".to_string(),
            variant_id: "glyphRun".to_string(),
            variant_kind: TextVariantKind::GlyphRun,
            part_index: 0,
            part_count: 2,
            is_default_fallback: false,
            requires: Vec::new(),
            quality: None,
            anchor_op_id: None,
            local_paint_order: None,
        };
        let tree = tree(LayerNode::leaf(
            bbox(),
            None,
            vec![
                text_op(PaintVariantMeta::text_run_default("text-1")),
                text_op(glyph_part),
            ],
        ));
        assert!(matches!(
            validate_text_variant_scope(&tree),
            Err(TextVariantScopeError::PartCountMismatch { .. })
        ));
    }

    #[test]
    fn rejects_glyph_outline_without_anchor() {
        let outline_part = PaintVariantMeta {
            equivalence_group: "text-1".to_string(),
            variant_id: "glyphOutline".to_string(),
            variant_kind: TextVariantKind::GlyphOutline,
            part_index: 0,
            part_count: 1,
            is_default_fallback: false,
            requires: vec!["text.outlineGlyph".to_string()],
            quality: None,
            anchor_op_id: None,
            local_paint_order: None,
        };
        let tree = tree(LayerNode::leaf(
            bbox(),
            None,
            vec![
                text_op(PaintVariantMeta::text_run_default("text-1")),
                outline_op(outline_part, TextStyle::default()),
            ],
        ));
        assert!(matches!(
            validate_text_variant_scope(&tree),
            Err(TextVariantScopeError::MissingAnchorOpId { .. })
        ));
    }

    #[test]
    fn rejects_glyph_outline_without_text_run_fallback() {
        let outline_part = PaintVariantMeta {
            equivalence_group: "text-1".to_string(),
            variant_id: "glyphOutline".to_string(),
            variant_kind: TextVariantKind::GlyphOutline,
            part_index: 0,
            part_count: 1,
            is_default_fallback: false,
            requires: vec!["text.outlineGlyph".to_string()],
            quality: None,
            anchor_op_id: Some("op-text-1".to_string()),
            local_paint_order: Some(0),
        };
        let tree = tree(LayerNode::leaf(
            bbox(),
            None,
            vec![outline_op(outline_part, TextStyle::default())],
        ));
        assert!(matches!(
            validate_text_variant_scope(&tree),
            Err(TextVariantScopeError::MissingDefaultFallback { .. })
        ));
    }

    #[test]
    fn accepts_glyph_outline_with_anchor() {
        let outline_part = PaintVariantMeta {
            equivalence_group: "text-1".to_string(),
            variant_id: "glyphOutline".to_string(),
            variant_kind: TextVariantKind::GlyphOutline,
            part_index: 0,
            part_count: 1,
            is_default_fallback: false,
            requires: vec!["text.outlineGlyph".to_string()],
            quality: None,
            anchor_op_id: Some("op-text-1".to_string()),
            local_paint_order: Some(0),
        };
        let tree = tree(LayerNode::leaf(
            bbox(),
            None,
            vec![
                text_op(PaintVariantMeta::text_run_default("text-1")),
                outline_op(outline_part, TextStyle::default()),
            ],
        ));
        validate_text_variant_scope(&tree).unwrap();
    }

    #[test]
    fn accepts_sidecar_glyph_outline_with_root_anchor() {
        let outline_part = PaintVariantMeta {
            equivalence_group: "text-1".to_string(),
            variant_id: "glyphOutline".to_string(),
            variant_kind: TextVariantKind::GlyphOutline,
            part_index: 0,
            part_count: 1,
            is_default_fallback: false,
            requires: vec!["text.outlineGlyph".to_string()],
            quality: None,
            anchor_op_id: Some("op-text-1".to_string()),
            local_paint_order: Some(0),
        };
        let tree = tree_with_variant_ops(
            LayerNode::leaf(
                bbox(),
                None,
                vec![text_op(PaintVariantMeta::text_run_default("text-1"))],
            ),
            vec![outline_op(outline_part, TextStyle::default())],
        );
        validate_text_variant_scope(&tree).unwrap();
    }

    #[test]
    fn rejects_sidecar_glyph_outline_with_missing_anchor() {
        let outline_part = PaintVariantMeta {
            equivalence_group: "text-1".to_string(),
            variant_id: "glyphOutline".to_string(),
            variant_kind: TextVariantKind::GlyphOutline,
            part_index: 0,
            part_count: 1,
            is_default_fallback: false,
            requires: vec!["text.outlineGlyph".to_string()],
            quality: None,
            anchor_op_id: Some("op-missing".to_string()),
            local_paint_order: Some(0),
        };
        let tree = tree_with_variant_ops(
            LayerNode::leaf(
                bbox(),
                None,
                vec![text_op(PaintVariantMeta::text_run_default("text-1"))],
            ),
            vec![outline_op(outline_part, TextStyle::default())],
        );
        assert!(matches!(
            validate_text_variant_scope(&tree),
            Err(TextVariantScopeError::MissingSidecarAnchor { .. })
        ));
    }

    #[test]
    fn rejects_sidecar_glyph_outline_anchored_to_non_default_part() {
        let glyph_part = PaintVariantMeta {
            equivalence_group: "text-1".to_string(),
            variant_id: "glyphRun".to_string(),
            variant_kind: TextVariantKind::GlyphRun,
            part_index: 0,
            part_count: 1,
            is_default_fallback: false,
            requires: vec!["fontResources".to_string(), "text.glyphRun".to_string()],
            quality: None,
            anchor_op_id: None,
            local_paint_order: Some(0),
        };
        let outline_part = PaintVariantMeta {
            equivalence_group: "text-1".to_string(),
            variant_id: "glyphOutline".to_string(),
            variant_kind: TextVariantKind::GlyphOutline,
            part_index: 0,
            part_count: 1,
            is_default_fallback: false,
            requires: vec!["text.outlineGlyph".to_string()],
            quality: None,
            anchor_op_id: Some("op-text-1-glyphRun-0".to_string()),
            local_paint_order: Some(0),
        };
        let tree = tree_with_variant_ops(
            LayerNode::leaf(
                bbox(),
                None,
                vec![
                    text_op(PaintVariantMeta::text_run_default("text-1")),
                    text_op(glyph_part),
                ],
            ),
            vec![outline_op(outline_part, TextStyle::default())],
        );
        assert!(matches!(
            validate_text_variant_scope(&tree),
            Err(TextVariantScopeError::InvalidSidecarAnchor { .. })
        ));
    }

    #[test]
    fn rejects_duplicate_root_and_sidecar_variant_part() {
        let outline_part = PaintVariantMeta {
            equivalence_group: "text-1".to_string(),
            variant_id: "glyphOutline".to_string(),
            variant_kind: TextVariantKind::GlyphOutline,
            part_index: 0,
            part_count: 1,
            is_default_fallback: false,
            requires: vec!["text.outlineGlyph".to_string()],
            quality: None,
            anchor_op_id: Some("op-text-1".to_string()),
            local_paint_order: Some(0),
        };
        let tree = tree_with_variant_ops(
            LayerNode::leaf(
                bbox(),
                None,
                vec![
                    text_op(PaintVariantMeta::text_run_default("text-1")),
                    outline_op(outline_part.clone(), TextStyle::default()),
                ],
            ),
            vec![outline_op(outline_part, TextStyle::default())],
        );
        assert!(matches!(
            validate_text_variant_scope(&tree),
            Err(TextVariantScopeError::DuplicatePart { .. })
        ));
    }

    #[test]
    fn rejects_glyph_outline_with_non_monochrome_style() {
        let outline_part = PaintVariantMeta {
            equivalence_group: "text-1".to_string(),
            variant_id: "glyphOutline".to_string(),
            variant_kind: TextVariantKind::GlyphOutline,
            part_index: 0,
            part_count: 1,
            is_default_fallback: false,
            requires: vec!["text.outlineGlyph".to_string()],
            quality: None,
            anchor_op_id: Some("op-text-1".to_string()),
            local_paint_order: Some(0),
        };
        let mut style = TextStyle::default();
        style.shadow_type = 1;
        let tree = tree(LayerNode::leaf(
            bbox(),
            None,
            vec![
                text_op(PaintVariantMeta::text_run_default("text-1")),
                outline_op(outline_part, style),
            ],
        ));
        assert!(matches!(
            validate_text_variant_scope(&tree),
            Err(TextVariantScopeError::UnsupportedGlyphOutlineStyle { .. })
        ));
    }

    #[test]
    fn rejects_glyph_outline_with_stroke_outline_style() {
        let outline_part = PaintVariantMeta {
            equivalence_group: "text-1".to_string(),
            variant_id: "glyphOutline".to_string(),
            variant_kind: TextVariantKind::GlyphOutline,
            part_index: 0,
            part_count: 1,
            is_default_fallback: false,
            requires: vec!["text.outlineGlyph".to_string()],
            quality: None,
            anchor_op_id: Some("op-text-1".to_string()),
            local_paint_order: Some(0),
        };
        let mut style = TextStyle::default();
        style.outline_type = 1;
        let tree = tree(LayerNode::leaf(
            bbox(),
            None,
            vec![
                text_op(PaintVariantMeta::text_run_default("text-1")),
                outline_op(outline_part, style),
            ],
        ));
        assert!(matches!(
            validate_text_variant_scope(&tree),
            Err(TextVariantScopeError::UnsupportedGlyphOutlineStyle { .. })
        ));
    }

    #[test]
    fn accepts_richer_glyph_outline_payload_kind_with_valid_scope() {
        let outline_part = PaintVariantMeta {
            equivalence_group: "text-1".to_string(),
            variant_id: "glyphOutline".to_string(),
            variant_kind: TextVariantKind::GlyphOutline,
            part_index: 0,
            part_count: 1,
            is_default_fallback: false,
            requires: vec!["text.glyphOutline.monochromeFillStroke".to_string()],
            quality: Some(TextVariantQuality::Exact),
            anchor_op_id: Some("op-text-1".to_string()),
            local_paint_order: Some(0),
        };
        let mut outline = outline_op(outline_part, TextStyle::default());
        let PaintOp::GlyphOutline {
            outline: outline_paint,
            ..
        } = &mut outline
        else {
            panic!("expected glyph outline");
        };
        outline_paint.payload_kind = GlyphOutlinePayloadKind::MonochromeFillStroke;
        let tree = tree(LayerNode::leaf(
            bbox(),
            None,
            vec![
                text_op(PaintVariantMeta::text_run_default("text-1")),
                outline,
            ],
        ));

        validate_text_variant_scope(&tree).unwrap();
    }
}
