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

use crate::paint::{LayerNode, LayerNodeKind, PageLayerTree, PaintOp, PaintVariantMeta};

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
    let mut group_leaf_paths = HashMap::new();
    validate_node(&tree.root, "root".to_string(), &mut group_leaf_paths)
}

fn validate_node(
    node: &LayerNode,
    path: String,
    group_leaf_paths: &mut HashMap<String, String>,
) -> Result<(), TextVariantScopeError> {
    match &node.kind {
        LayerNodeKind::Group { children, .. } => {
            for (index, child) in children.iter().enumerate() {
                validate_node(child, format!("{path}/group[{index}]"), group_leaf_paths)?;
            }
        }
        LayerNodeKind::ClipRect { child, .. } => {
            validate_node(child, format!("{path}/clip"), group_leaf_paths)?;
        }
        LayerNodeKind::Leaf { ops, .. } => {
            validate_leaf(ops, path, group_leaf_paths)?;
        }
    }
    Ok(())
}

fn validate_leaf(
    ops: &[PaintOp],
    leaf_path: String,
    group_leaf_paths: &mut HashMap<String, String>,
) -> Result<(), TextVariantScopeError> {
    let mut groups = HashMap::<String, LeafGroupState>::new();
    for op in ops {
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
        LayerNode, LayerOutputOptions, LayerTextRunPaint, TextSourceTable, TextVariantKind,
    };
    use crate::renderer::render_tree::BoundingBox;

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

    fn tree(root: LayerNode) -> PageLayerTree {
        PageLayerTree {
            page_width: 100.0,
            page_height: 100.0,
            profile: RenderProfile::default(),
            output_options: LayerOutputOptions::default(),
            root,
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
}
