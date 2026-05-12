//! Schema v2 text envelope scaffolding.
//!
//! The current writer still emits schema-v1 flattened `TextRun`, `GlyphRun`,
//! and `GlyphOutline` ops. These structures provide the compatibility lowering
//! target for Phase 2: one text paint-order slot containing explicit variant
//! sets. They are intentionally renderer-neutral and do not enable fallback-free
//! or cross-scope emission by themselves.

use std::collections::{BTreeSet, HashMap};

use crate::paint::{
    LayerGlyphOutlinePaint, LayerGlyphRunPaint, LayerTextRunPaint, PaintOp, TextVariantKind,
    TextVariantQuality,
};
use crate::renderer::render_tree::BoundingBox;

pub type PaintOrderSlotId = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextFallbackPolicy {
    Required,
    None,
}

impl TextFallbackPolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Required => "required",
            Self::None => "none",
        }
    }
}

#[derive(Debug, Clone)]
pub struct LayerTextPaintOpV2 {
    pub id: String,
    pub paint_order_slot_id: PaintOrderSlotId,
    pub bbox: BoundingBox,
    pub default_variant_id: Option<String>,
    pub fallback_policy: TextFallbackPolicy,
    pub variants: Vec<LayerTextVariantSet>,
}

#[derive(Debug, Clone)]
pub struct LayerTextVariantSet {
    pub variant_id: String,
    pub kind: TextVariantKind,
    pub required_features: Vec<String>,
    pub quality: Option<TextVariantQuality>,
    pub parts: Vec<LayerTextVariantPart>,
}

#[derive(Debug, Clone)]
pub struct LayerTextVariantPart {
    pub part_index: u32,
    pub part_count: u32,
    pub local_paint_order: Option<u32>,
    pub bbox: BoundingBox,
    pub payload: LayerTextVariantPayload,
}

#[derive(Debug, Clone)]
pub enum LayerTextVariantPayload {
    TextRun(LayerTextRunPaint),
    GlyphRun(LayerGlyphRunPaint),
    GlyphOutline(LayerGlyphOutlinePaint),
}

struct TextVariantEntry {
    order: usize,
    bbox: BoundingBox,
    equivalence_group: String,
    variant_id: String,
    kind: TextVariantKind,
    part_index: u32,
    part_count: u32,
    is_default_fallback: bool,
    requires: Vec<String>,
    quality: Option<TextVariantQuality>,
    local_paint_order: Option<u32>,
    payload: LayerTextVariantPayload,
}

/// Lowers schema-v1 flattened text variant ops from one leaf into schema-v2
/// text paint slots.
///
/// The function preserves first-seen group and variant order so a future writer
/// can round-trip the existing v1 paint order. It does not validate the v1
/// invariants; callers should run `validate_text_variant_scope` before relying
/// on the result for export.
pub fn lower_v1_leaf_text_variants_to_v2(ops: &[PaintOp]) -> Vec<LayerTextPaintOpV2> {
    let mut groups = Vec::<String>::new();
    let mut by_group = HashMap::<String, Vec<TextVariantEntry>>::new();

    for (order, op) in ops.iter().enumerate() {
        let Some(entry) = text_variant_entry(order, op) else {
            continue;
        };
        if !by_group.contains_key(&entry.equivalence_group) {
            groups.push(entry.equivalence_group.clone());
        }
        by_group
            .entry(entry.equivalence_group.clone())
            .or_default()
            .push(entry);
    }

    groups
        .into_iter()
        .filter_map(|group_id| {
            let entries = by_group.remove(&group_id)?;
            Some(build_text_op_v2(group_id, entries))
        })
        .collect()
}

fn text_variant_entry(order: usize, op: &PaintOp) -> Option<TextVariantEntry> {
    match op {
        PaintOp::TextRun { bbox, run } => {
            let variant = run.variant.as_ref()?;
            Some(TextVariantEntry {
                order,
                bbox: *bbox,
                equivalence_group: variant.equivalence_group.clone(),
                variant_id: variant.variant_id.clone(),
                kind: variant.variant_kind,
                part_index: variant.part_index,
                part_count: variant.part_count,
                is_default_fallback: variant.is_default_fallback,
                requires: variant.requires.clone(),
                quality: variant.quality,
                local_paint_order: variant.local_paint_order,
                payload: LayerTextVariantPayload::TextRun(run.clone()),
            })
        }
        PaintOp::GlyphRun { bbox, run } => {
            let variant = &run.variant;
            Some(TextVariantEntry {
                order,
                bbox: *bbox,
                equivalence_group: variant.equivalence_group.clone(),
                variant_id: variant.variant_id.clone(),
                kind: variant.variant_kind,
                part_index: variant.part_index,
                part_count: variant.part_count,
                is_default_fallback: variant.is_default_fallback,
                requires: variant.requires.clone(),
                quality: variant.quality,
                local_paint_order: variant.local_paint_order,
                payload: LayerTextVariantPayload::GlyphRun(run.clone()),
            })
        }
        PaintOp::GlyphOutline { bbox, outline } => {
            let variant = &outline.variant;
            Some(TextVariantEntry {
                order,
                bbox: *bbox,
                equivalence_group: variant.equivalence_group.clone(),
                variant_id: variant.variant_id.clone(),
                kind: variant.variant_kind,
                part_index: variant.part_index,
                part_count: variant.part_count,
                is_default_fallback: variant.is_default_fallback,
                requires: variant.requires.clone(),
                quality: variant.quality,
                local_paint_order: variant.local_paint_order,
                payload: LayerTextVariantPayload::GlyphOutline(outline.clone()),
            })
        }
        _ => None,
    }
}

fn build_text_op_v2(group_id: String, entries: Vec<TextVariantEntry>) -> LayerTextPaintOpV2 {
    let bbox = entries
        .iter()
        .map(|entry| entry.bbox)
        .reduce(union_bbox)
        .unwrap_or_default();
    let default_variant_id = entries
        .iter()
        .find(|entry| entry.is_default_fallback)
        .map(|entry| entry.variant_id.clone());

    let mut variant_order = Vec::<String>::new();
    let mut by_variant = HashMap::<String, Vec<TextVariantEntry>>::new();
    for entry in entries {
        if !by_variant.contains_key(&entry.variant_id) {
            variant_order.push(entry.variant_id.clone());
        }
        by_variant
            .entry(entry.variant_id.clone())
            .or_default()
            .push(entry);
    }

    let variants = variant_order
        .into_iter()
        .filter_map(|variant_id| {
            let mut entries = by_variant.remove(&variant_id)?;
            entries.sort_by_key(|entry| {
                (
                    entry.local_paint_order.unwrap_or(entry.part_index),
                    entry.part_index,
                    entry.order,
                )
            });
            let first = entries.first()?;
            let mut required_features = BTreeSet::<String>::new();
            for entry in &entries {
                required_features.extend(entry.requires.iter().cloned());
            }
            let kind = first.kind;
            let quality = entries.iter().find_map(|entry| entry.quality);
            let parts = entries
                .into_iter()
                .map(|entry| LayerTextVariantPart {
                    part_index: entry.part_index,
                    part_count: entry.part_count,
                    local_paint_order: entry.local_paint_order,
                    bbox: entry.bbox,
                    payload: entry.payload,
                })
                .collect();
            Some(LayerTextVariantSet {
                variant_id,
                kind,
                required_features: required_features.into_iter().collect(),
                quality,
                parts,
            })
        })
        .collect();

    LayerTextPaintOpV2 {
        id: group_id.clone(),
        paint_order_slot_id: group_id,
        bbox,
        default_variant_id,
        fallback_policy: TextFallbackPolicy::Required,
        variants,
    }
}

fn union_bbox(left: BoundingBox, right: BoundingBox) -> BoundingBox {
    let min_x = left.x.min(right.x);
    let min_y = left.y.min(right.y);
    let max_x = (left.x + left.width).max(right.x + right.width);
    let max_y = (left.y + left.height).max(right.y + right.height);
    BoundingBox::new(min_x, min_y, max_x - min_x, max_y - min_y)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paint::{
        GlyphOutlineFillRule, GlyphRange, GlyphRunDiagnostics, GlyphRunReplayEligibility,
        LayerAffineTransform, LayerGlyphOutlinePath, PaintTextStyle, PaintVariantMeta,
        TextRunPlacement, TextSourceId, TextSourceRange, TextSourceSpan,
    };
    use crate::renderer::{PathCommand, TextStyle};

    fn bbox(x: f64, y: f64, width: f64, height: f64) -> BoundingBox {
        BoundingBox::new(x, y, width, height)
    }

    fn text_op(variant: PaintVariantMeta) -> PaintOp {
        PaintOp::TextRun {
            bbox: bbox(0.0, 0.0, 10.0, 10.0),
            run: LayerTextRunPaint {
                variant: Some(variant),
                text: "A".to_string(),
                ..LayerTextRunPaint::default()
            },
        }
    }

    fn outline_op(variant: PaintVariantMeta, x: f64) -> PaintOp {
        PaintOp::GlyphOutline {
            bbox: bbox(x, 0.0, 10.0, 10.0),
            outline: LayerGlyphOutlinePaint {
                source: TextSourceSpan {
                    id: TextSourceId(0),
                    utf8_range: TextSourceRange::new(0, 1),
                    utf16_range: TextSourceRange::new(0, 1),
                    stable_source_key: None,
                },
                variant,
                paint_style: PaintTextStyle::from(&TextStyle::default()),
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
                    glyph_id: 1,
                    source_range_utf8: TextSourceRange::new(0, 1),
                    glyph_range: GlyphRange { start: 0, end: 1 },
                    commands: vec![
                        PathCommand::MoveTo(0.0, 0.0),
                        PathCommand::LineTo(1.0, 0.0),
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
            },
        }
    }

    #[test]
    fn lowers_flattened_v1_variant_group_to_text_v2_slot() {
        let text = text_op(PaintVariantMeta::text_run_default("text-1"));
        let outline = outline_op(
            PaintVariantMeta {
                equivalence_group: "text-1".to_string(),
                variant_id: "glyphOutline".to_string(),
                variant_kind: TextVariantKind::GlyphOutline,
                part_index: 0,
                part_count: 1,
                is_default_fallback: false,
                requires: vec!["text.glyphOutline.monochromeFill".to_string()],
                quality: Some(TextVariantQuality::Exact),
                anchor_op_id: Some("text-anchor-1".to_string()),
                local_paint_order: Some(0),
            },
            12.0,
        );

        let text_ops = lower_v1_leaf_text_variants_to_v2(&[text, outline]);

        assert_eq!(text_ops.len(), 1);
        let text_op = &text_ops[0];
        assert_eq!(text_op.id, "text-1");
        assert_eq!(text_op.paint_order_slot_id, "text-1");
        assert_eq!(text_op.default_variant_id.as_deref(), Some("textRun"));
        assert_eq!(text_op.fallback_policy, TextFallbackPolicy::Required);
        assert_eq!(text_op.bbox.x, 0.0);
        assert_eq!(text_op.bbox.width, 22.0);
        assert_eq!(text_op.variants.len(), 2);
        assert_eq!(text_op.variants[0].variant_id, "textRun");
        assert_eq!(text_op.variants[0].kind, TextVariantKind::TextRun);
        assert_eq!(text_op.variants[1].variant_id, "glyphOutline");
        assert_eq!(
            text_op.variants[1].required_features,
            vec!["text.glyphOutline.monochromeFill"]
        );
        assert!(matches!(
            text_op.variants[1].parts[0].payload,
            LayerTextVariantPayload::GlyphOutline(_)
        ));
    }

    #[test]
    fn lowers_multipart_variant_parts_in_local_paint_order() {
        let text = text_op(PaintVariantMeta::text_run_default("text-2"));
        let first_outline = outline_op(
            PaintVariantMeta {
                equivalence_group: "text-2".to_string(),
                variant_id: "glyphOutline".to_string(),
                variant_kind: TextVariantKind::GlyphOutline,
                part_index: 1,
                part_count: 2,
                is_default_fallback: false,
                requires: vec!["text.glyphOutline.monochromeFill".to_string()],
                quality: Some(TextVariantQuality::Exact),
                anchor_op_id: Some("text-anchor-2".to_string()),
                local_paint_order: Some(1),
            },
            20.0,
        );
        let second_outline = outline_op(
            PaintVariantMeta {
                equivalence_group: "text-2".to_string(),
                variant_id: "glyphOutline".to_string(),
                variant_kind: TextVariantKind::GlyphOutline,
                part_index: 0,
                part_count: 2,
                is_default_fallback: false,
                requires: vec!["text.glyphOutline.monochromeFill".to_string()],
                quality: Some(TextVariantQuality::Exact),
                anchor_op_id: Some("text-anchor-2".to_string()),
                local_paint_order: Some(0),
            },
            10.0,
        );

        let text_ops = lower_v1_leaf_text_variants_to_v2(&[text, first_outline, second_outline]);
        let outline_variant = text_ops[0]
            .variants
            .iter()
            .find(|variant| variant.variant_id == "glyphOutline")
            .expect("glyphOutline variant");

        assert_eq!(outline_variant.parts.len(), 2);
        assert_eq!(outline_variant.parts[0].part_index, 0);
        assert_eq!(outline_variant.parts[1].part_index, 1);
        assert_eq!(outline_variant.parts[0].part_count, 2);
        assert_eq!(outline_variant.parts[1].part_count, 2);
    }
}
