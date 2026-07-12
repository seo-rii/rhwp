use std::collections::HashMap;
use std::fmt::Write;

use crate::model::image::ImageEffect;
use crate::model::shape::TextWrap;
use crate::model::style::{ImageFillMode, UnderlineType};
use crate::paint::{
    paint_op_replay_plane, sidecars_for_leaf_ops, CacheHint, ClipKind, GlyphOutlinePayloadKind,
    GlyphRunOrientation, GlyphRunReplayEligibility, LayerGlyphOutlinePaint, LayerGlyphRunPaint,
    LayerNode, LayerNodeKind, PageLayerTree, PaintOp, PaintReplayPlane, ResourceArena,
    TextVariantKind, TextVariantQuality,
};
use crate::renderer::layer_renderer::{
    select_text_variant_sets_with_report, VariantFontVerificationReport,
    VariantOutlineEligibilityReport, VariantRejectReason, VariantReplayStatus,
    VariantSelectedReason, VariantSelectionBackend, VariantSelectionContext,
    VariantSelectionReport,
};
use crate::renderer::static_svg::static_svg_fragment_has_path_layer;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CanvasKitReplayMode {
    Default,
    Compat,
}

impl CanvasKitReplayMode {
    pub fn from_str(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "" | "default" => Some(Self::Default),
            "compat" | "compatibility" => Some(Self::Compat),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Compat => "compat",
        }
    }

    fn policy(self) -> CanvasKitReplayPolicy {
        match self {
            // `compat` remains a public mode for URL/API compatibility and
            // future conservative direct-replay tuning, but it must not mean a
            // hidden Canvas2D paint overlay.
            Self::Default | Self::Compat => CanvasKitReplayPolicy::DIRECT_ONLY,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CanvasKitReplayPolicy {
    hidden_canvas2d_overlay_allowed: bool,
    direct_replay_required: bool,
}

impl CanvasKitReplayPolicy {
    const DIRECT_ONLY: Self = Self {
        hidden_canvas2d_overlay_allowed: false,
        direct_replay_required: true,
    };
}

#[derive(Debug, Clone, PartialEq)]
pub struct CanvasKitReplayPlan {
    pub mode: CanvasKitReplayMode,
    pub hidden_canvas2d_overlay_allowed: bool,
    pub direct_replay_required: bool,
    pub summary: CanvasKitReplaySummary,
    pub items: Vec<CanvasKitReplayItem>,
    pub text_variants: Vec<CanvasKitTextVariantReport>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CanvasKitReplaySummary {
    pub total_items: u32,
    pub direct_items: u32,
    pub direct_required_items: u32,
    pub compat_overlay_items: u32,
    pub text_fallback_items: u32,
    pub unsupported_items: u32,
    pub hidden_overlay_violations: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CanvasKitReplayItem {
    pub path: String,
    pub op_type: &'static str,
    pub replay_plane: Option<PaintReplayPlane>,
    pub feature: CanvasKitReplayFeature,
    pub status: CanvasKitReplayStatus,
    pub reason: CanvasKitReplayReason,
    pub compat_overlay_allowed: bool,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CanvasKitReplayFeature {
    PageBackground,
    VectorShape,
    RasterImage,
    Equation,
    FormObject,
    TextRun,
    TextSpecialVisual,
    TextVariant,
    Clip,
    CacheHint,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CanvasKitReplayStatus {
    Direct,
    DirectRequired,
    CompatOverlay,
    TextFallback,
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CanvasKitReplayReason {
    DirectReplaySupported,
    DirectReplayRequired,
    CompatOverlayAllowed,
    HiddenOverlayForbidden,
    ExplicitTextRunFallback,
    UnsupportedFeature,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CanvasKitTextVariantReport {
    pub backend: &'static str,
    pub render_profile: String,
    pub equivalence_group: String,
    pub selected_variant_id: String,
    pub selected_variant_kind: &'static str,
    pub selected_reason: &'static str,
    pub anchor_op_id: Option<String>,
    pub parts_expected: u32,
    pub parts_replayed: u32,
    pub font_verification: Option<VariantFontVerificationReport>,
    pub outline_eligibility: Option<VariantOutlineEligibilityReport>,
    pub parts: Vec<CanvasKitTextVariantPartReport>,
    pub rejected_variants: Vec<CanvasKitRejectedTextVariant>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanvasKitTextVariantPartReport {
    pub equivalence_group: String,
    pub variant_id: String,
    pub variant_kind: &'static str,
    pub part_index: u32,
    pub part_count: u32,
    pub replayable: bool,
    pub reason: Option<&'static str>,
    pub details: Option<String>,
    pub font_verification: Option<VariantFontVerificationReport>,
    pub outline_eligibility: Option<VariantOutlineEligibilityReport>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanvasKitRejectedTextVariant {
    pub variant_id: String,
    pub variant_kind: &'static str,
    pub reasons: Vec<&'static str>,
    pub details: Vec<String>,
}

impl CanvasKitReplayPlan {
    pub fn to_json(&self) -> String {
        let mut out = String::new();
        out.push('{');
        out.push_str("\"mode\":");
        push_json_str(&mut out, self.mode.as_str());
        out.push_str(",\"hiddenCanvas2dOverlayAllowed\":");
        out.push_str(bool_json(self.hidden_canvas2d_overlay_allowed));
        out.push_str(",\"directReplayRequired\":");
        out.push_str(bool_json(self.direct_replay_required));
        out.push_str(",\"summary\":");
        self.summary.write_json(&mut out);
        out.push_str(",\"items\":[");
        for (index, item) in self.items.iter().enumerate() {
            if index != 0 {
                out.push(',');
            }
            item.write_json(&mut out);
        }
        out.push_str("],\"textVariants\":[");
        for (index, report) in self.text_variants.iter().enumerate() {
            if index != 0 {
                out.push(',');
            }
            report.write_json(&mut out);
        }
        out.push_str("]}");
        out
    }
}

impl CanvasKitReplaySummary {
    fn write_json(&self, out: &mut String) {
        let _ = write!(
            out,
            "{{\"totalItems\":{},\"directItems\":{},\"directRequiredItems\":{},\"compatOverlayItems\":{},\"textFallbackItems\":{},\"unsupportedItems\":{},\"hiddenOverlayViolations\":{}}}",
            self.total_items,
            self.direct_items,
            self.direct_required_items,
            self.compat_overlay_items,
            self.text_fallback_items,
            self.unsupported_items,
            self.hidden_overlay_violations
        );
    }
}

impl CanvasKitReplayItem {
    fn write_json(&self, out: &mut String) {
        out.push('{');
        out.push_str("\"path\":");
        push_json_str(out, &self.path);
        out.push_str(",\"opType\":");
        push_json_str(out, self.op_type);
        if let Some(replay_plane) = self.replay_plane {
            out.push_str(",\"replayPlane\":");
            push_json_str(out, replay_plane.as_str());
        }
        out.push_str(",\"feature\":");
        push_json_str(out, self.feature.as_str());
        out.push_str(",\"status\":");
        push_json_str(out, self.status.as_str());
        out.push_str(",\"reason\":");
        push_json_str(out, self.reason.as_str());
        out.push_str(",\"compatOverlayAllowed\":");
        out.push_str(bool_json(self.compat_overlay_allowed));
        if let Some(detail) = &self.detail {
            out.push_str(",\"detail\":");
            push_json_str(out, detail);
        }
        out.push('}');
    }
}

impl CanvasKitReplayFeature {
    fn as_str(self) -> &'static str {
        match self {
            Self::PageBackground => "pageBackground",
            Self::VectorShape => "vectorShape",
            Self::RasterImage => "rasterImage",
            Self::Equation => "equation",
            Self::FormObject => "formObject",
            Self::TextRun => "textRun",
            Self::TextSpecialVisual => "textSpecialVisual",
            Self::TextVariant => "textVariant",
            Self::Clip => "clip",
            Self::CacheHint => "cacheHint",
        }
    }
}

impl CanvasKitReplayStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Direct => "direct",
            Self::DirectRequired => "directRequired",
            Self::CompatOverlay => "compatOverlay",
            Self::TextFallback => "textFallback",
            Self::Unsupported => "unsupported",
        }
    }
}

impl CanvasKitReplayReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::DirectReplaySupported => "directReplaySupported",
            Self::DirectReplayRequired => "directReplayRequired",
            Self::CompatOverlayAllowed => "compatOverlayAllowed",
            Self::HiddenOverlayForbidden => "hiddenOverlayForbidden",
            Self::ExplicitTextRunFallback => "explicitTextRunFallback",
            Self::UnsupportedFeature => "unsupportedFeature",
        }
    }
}

impl CanvasKitTextVariantReport {
    fn write_json(&self, out: &mut String) {
        out.push('{');
        out.push_str("\"backend\":");
        push_json_str(out, self.backend);
        out.push_str(",\"renderProfile\":");
        push_json_str(out, &self.render_profile);
        out.push_str(",\"equivalenceGroup\":");
        push_json_str(out, &self.equivalence_group);
        out.push_str(",\"selectedVariantId\":");
        push_json_str(out, &self.selected_variant_id);
        out.push_str(",\"selectedVariantKind\":");
        push_json_str(out, self.selected_variant_kind);
        out.push_str(",\"selectedReason\":");
        push_json_str(out, self.selected_reason);
        if let Some(anchor_op_id) = &self.anchor_op_id {
            out.push_str(",\"anchorOpId\":");
            push_json_str(out, anchor_op_id);
        }
        let _ = write!(
            out,
            ",\"partsExpected\":{},\"partsReplayed\":{}",
            self.parts_expected, self.parts_replayed
        );
        if let Some(font_verification) = &self.font_verification {
            out.push_str(",\"fontVerification\":");
            write_font_verification_json(out, font_verification);
        }
        if let Some(outline_eligibility) = &self.outline_eligibility {
            out.push_str(",\"outlineEligibility\":");
            write_outline_eligibility_json(out, outline_eligibility);
        }
        out.push_str(",\"parts\":[");
        for (index, part) in self.parts.iter().enumerate() {
            if index != 0 {
                out.push(',');
            }
            part.write_json(out);
        }
        out.push(']');
        out.push_str(",\"rejectedVariants\":[");
        for (index, rejected) in self.rejected_variants.iter().enumerate() {
            if index != 0 {
                out.push(',');
            }
            rejected.write_json(out);
        }
        out.push_str("]}");
    }
}

impl CanvasKitTextVariantPartReport {
    fn write_json(&self, out: &mut String) {
        out.push('{');
        out.push_str("\"equivalenceGroup\":");
        push_json_str(out, &self.equivalence_group);
        out.push_str(",\"variantId\":");
        push_json_str(out, &self.variant_id);
        out.push_str(",\"variantKind\":");
        push_json_str(out, self.variant_kind);
        let _ = write!(
            out,
            ",\"partIndex\":{},\"partCount\":{},\"replayable\":{}",
            self.part_index,
            self.part_count,
            bool_json(self.replayable)
        );
        if let Some(reason) = self.reason {
            out.push_str(",\"reason\":");
            push_json_str(out, reason);
        }
        if let Some(details) = &self.details {
            out.push_str(",\"details\":");
            push_json_str(out, details);
        }
        if let Some(font_verification) = &self.font_verification {
            out.push_str(",\"fontVerification\":");
            write_font_verification_json(out, font_verification);
        }
        if let Some(outline_eligibility) = &self.outline_eligibility {
            out.push_str(",\"outlineEligibility\":");
            write_outline_eligibility_json(out, outline_eligibility);
        }
        out.push('}');
    }
}

impl CanvasKitRejectedTextVariant {
    fn write_json(&self, out: &mut String) {
        out.push('{');
        out.push_str("\"variantId\":");
        push_json_str(out, &self.variant_id);
        out.push_str(",\"variantKind\":");
        push_json_str(out, self.variant_kind);
        out.push_str(",\"reasons\":[");
        for (index, reason) in self.reasons.iter().enumerate() {
            if index != 0 {
                out.push(',');
            }
            push_json_str(out, reason);
        }
        out.push_str("],\"details\":[");
        for (index, detail) in self.details.iter().enumerate() {
            if index != 0 {
                out.push(',');
            }
            push_json_str(out, detail);
        }
        out.push_str("]}");
    }
}

fn push_json_str(out: &mut String, value: &str) {
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if ch <= '\u{1f}' => {
                let _ = write!(out, "\\u{:04x}", ch as u32);
            }
            ch => out.push(ch),
        }
    }
    out.push('"');
}

fn write_font_verification_json(out: &mut String, report: &VariantFontVerificationReport) {
    out.push('{');
    let mut needs_comma = false;
    push_optional_string_field(out, &mut needs_comma, "faceKey", report.face_key.as_deref());
    push_optional_string_field(out, &mut needs_comma, "blobKey", report.blob_key.as_deref());
    push_optional_string_field(
        out,
        &mut needs_comma,
        "portability",
        report.portability.as_deref(),
    );
    push_optional_string_field(
        out,
        &mut needs_comma,
        "expectedDigest",
        report.expected_digest.as_deref(),
    );
    push_optional_bool_field(out, &mut needs_comma, "blobResolved", report.blob_resolved);
    push_optional_bool_field(
        out,
        &mut needs_comma,
        "digestMatched",
        report.digest_matched,
    );
    push_optional_bool_field(
        out,
        &mut needs_comma,
        "exactFaceInstantiated",
        report.exact_face_instantiated,
    );
    push_optional_bool_field(
        out,
        &mut needs_comma,
        "faceIndexSupported",
        report.face_index_supported,
    );
    push_optional_bool_field(
        out,
        &mut needs_comma,
        "variationSupported",
        report.variation_supported,
    );
    push_optional_bool_field(
        out,
        &mut needs_comma,
        "effectSupported",
        report.effect_supported,
    );
    push_bool_field(
        out,
        &mut needs_comma,
        "replayEligible",
        report.replay_eligible,
    );
    push_optional_string_field(
        out,
        &mut needs_comma,
        "reason",
        report.reason.map(VariantRejectReason::as_str),
    );
    out.push('}');
}

fn write_outline_eligibility_json(out: &mut String, report: &VariantOutlineEligibilityReport) {
    out.push('{');
    let mut needs_comma = false;
    push_bool_field(
        out,
        &mut needs_comma,
        "strictVisualEligible",
        report.strict_visual_eligible,
    );
    push_bool_field(
        out,
        &mut needs_comma,
        "payloadSupported",
        report.payload_supported,
    );
    push_bool_field(
        out,
        &mut needs_comma,
        "paintStyleSupported",
        report.paint_style_supported,
    );
    push_bool_field(
        out,
        &mut needs_comma,
        "replayEligible",
        report.replay_eligible,
    );
    push_optional_string_field(
        out,
        &mut needs_comma,
        "reason",
        report.reason.map(VariantRejectReason::as_str),
    );
    out.push('}');
}

fn push_optional_string_field(
    out: &mut String,
    needs_comma: &mut bool,
    name: &str,
    value: Option<&str>,
) {
    let Some(value) = value else {
        return;
    };
    push_field_prefix(out, needs_comma, name);
    push_json_str(out, value);
}

fn push_optional_bool_field(
    out: &mut String,
    needs_comma: &mut bool,
    name: &str,
    value: Option<bool>,
) {
    let Some(value) = value else {
        return;
    };
    push_bool_field(out, needs_comma, name, value);
}

fn push_bool_field(out: &mut String, needs_comma: &mut bool, name: &str, value: bool) {
    push_field_prefix(out, needs_comma, name);
    out.push_str(bool_json(value));
}

fn push_field_prefix(out: &mut String, needs_comma: &mut bool, name: &str) {
    if *needs_comma {
        out.push(',');
    }
    *needs_comma = true;
    out.push('"');
    out.push_str(name);
    out.push_str("\":");
}

fn bool_json(value: bool) -> &'static str {
    if value {
        "true"
    } else {
        "false"
    }
}

pub fn analyze_canvaskit_replay_plan(
    tree: &PageLayerTree,
    mode: CanvasKitReplayMode,
) -> CanvasKitReplayPlan {
    let mut builder = CanvasKitReplayPlanBuilder::new(mode, tree);
    builder.visit_node(&tree.root, "root");
    builder.finish()
}

struct CanvasKitReplayPlanBuilder<'a> {
    mode: CanvasKitReplayMode,
    policy: CanvasKitReplayPolicy,
    tree: &'a PageLayerTree,
    summary: CanvasKitReplaySummary,
    items: Vec<CanvasKitReplayItem>,
    text_variants: Vec<CanvasKitTextVariantReport>,
}

impl<'a> CanvasKitReplayPlanBuilder<'a> {
    fn new(mode: CanvasKitReplayMode, tree: &'a PageLayerTree) -> Self {
        Self {
            mode,
            policy: mode.policy(),
            tree,
            summary: CanvasKitReplaySummary::default(),
            items: Vec::new(),
            text_variants: Vec::new(),
        }
    }

    fn finish(self) -> CanvasKitReplayPlan {
        CanvasKitReplayPlan {
            mode: self.mode,
            hidden_canvas2d_overlay_allowed: self.policy.hidden_canvas2d_overlay_allowed,
            direct_replay_required: self.policy.direct_replay_required,
            summary: self.summary,
            items: self.items,
            text_variants: self.text_variants,
        }
    }

    fn visit_node(&mut self, node: &LayerNode, path: &str) {
        match &node.kind {
            LayerNodeKind::Group {
                children,
                cache_hint,
                ..
            } => {
                if !matches!(cache_hint, CacheHint::None) {
                    self.push_cache_hint_item(path, *cache_hint);
                }
                for (index, child) in children.iter().enumerate() {
                    self.visit_node(child, &format!("{path}/group/{index}"));
                }
            }
            LayerNodeKind::ClipRect {
                child, clip_kind, ..
            } => {
                self.push(CanvasKitReplayItem {
                    path: format!("{path}/clip"),
                    op_type: "clipRect",
                    replay_plane: None,
                    feature: CanvasKitReplayFeature::Clip,
                    status: CanvasKitReplayStatus::Direct,
                    reason: CanvasKitReplayReason::DirectReplaySupported,
                    compat_overlay_allowed: false,
                    detail: Some(clip_kind_detail(*clip_kind).to_string()),
                });
                self.visit_node(child, &format!("{path}/clip/child"));
            }
            LayerNodeKind::Leaf { ops, .. } => {
                let sidecars = sidecars_for_leaf_ops(ops, &self.tree.variant_ops);
                let mut selection_ops = Vec::with_capacity(ops.len() + sidecars.len());
                selection_ops.extend(ops.iter().cloned());
                selection_ops.extend(sidecars.iter().cloned());
                let selection = select_text_variant_sets_with_report(
                    &selection_ops,
                    |op| match op {
                        PaintOp::GlyphRun { run, .. } => {
                            canvaskit_glyph_run_replay_status(run, &self.tree.resources)
                        }
                        _ => VariantReplayStatus::rejected(VariantRejectReason::VariantUnsupported),
                    },
                    |op| match op {
                        PaintOp::GlyphOutline { outline, bbox } => {
                            canvaskit_glyph_outline_replay_status(
                                outline,
                                Some(*bbox),
                                &self.tree.resources,
                            )
                        }
                        _ => VariantReplayStatus::rejected(VariantRejectReason::VariantUnsupported),
                    },
                    VariantSelectionContext {
                        backend: VariantSelectionBackend::CanvasKit,
                        render_profile: self.tree.profile.as_str().to_string(),
                    },
                );
                let selected = selection.selected;
                self.text_variants
                    .extend(selection.reports.into_iter().map(text_variant_report));
                for (index, op) in ops.iter().enumerate() {
                    self.push(self.item_for_op(op, &selected, format!("{path}/leaf/{index}")));
                }
                for (index, op) in sidecars.iter().enumerate() {
                    self.push(self.item_for_op(
                        op,
                        &selected,
                        format!("{path}/leaf/variantOps/{index}"),
                    ));
                }
            }
        }
    }

    fn item_for_op(
        &self,
        op: &PaintOp,
        selected_variants: &HashMap<String, String>,
        path: String,
    ) -> CanvasKitReplayItem {
        let mut item = match op {
            PaintOp::PageBackground { background, .. } => {
                page_background_item(path, background, &self.tree.resources)
            }
            PaintOp::TextRun { run, .. } => {
                if let Some(variant) = &run.variant {
                    self.text_variant_item(path, "textRun", variant, selected_variants)
                } else {
                    direct_item(path, "textRun", CanvasKitReplayFeature::TextRun)
                }
            }
            PaintOp::GlyphRun { run, .. } => {
                self.text_variant_item(path, "glyphRun", &run.variant, selected_variants)
            }
            PaintOp::GlyphOutline { outline, .. } => {
                self.text_variant_item(path, "glyphOutline", &outline.variant, selected_variants)
            }
            PaintOp::CharOverlap { .. }
            | PaintOp::TextControlMark { .. }
            | PaintOp::TabLeader { .. }
            | PaintOp::TextDecoration { .. }
            | PaintOp::FootnoteMarker { .. } => direct_item(
                path,
                paint_op_type(op),
                CanvasKitReplayFeature::TextSpecialVisual,
            ),
            PaintOp::Line { .. }
            | PaintOp::Rectangle { .. }
            | PaintOp::Ellipse { .. }
            | PaintOp::Path { .. } => {
                direct_item(path, paint_op_type(op), CanvasKitReplayFeature::VectorShape)
            }
            PaintOp::Image { image, .. } => image_item(path, image, &self.tree.resources),
            PaintOp::Equation { .. } => {
                direct_item(path, "equation", CanvasKitReplayFeature::Equation)
            }
            PaintOp::FormObject { .. } => {
                direct_item(path, "formObject", CanvasKitReplayFeature::FormObject)
            }
        };
        item.replay_plane = Some(paint_op_replay_plane(op));
        item
    }

    fn text_variant_item(
        &self,
        path: String,
        op_type: &'static str,
        variant: &crate::paint::PaintVariantMeta,
        selected_variants: &HashMap<String, String>,
    ) -> CanvasKitReplayItem {
        if selected_variants
            .get(&variant.equivalence_group)
            .is_some_and(|selected| selected == &variant.variant_id)
        {
            direct_item(path, op_type, CanvasKitReplayFeature::TextVariant)
        } else {
            CanvasKitReplayItem {
                path,
                op_type,
                replay_plane: None,
                feature: CanvasKitReplayFeature::TextVariant,
                status: CanvasKitReplayStatus::TextFallback,
                reason: CanvasKitReplayReason::ExplicitTextRunFallback,
                compat_overlay_allowed: false,
                detail: Some("TextRun fallback selected for this equivalence group".to_string()),
            }
        }
    }

    fn push_cache_hint_item(&mut self, path: &str, cache_hint: CacheHint) {
        self.push(CanvasKitReplayItem {
            path: format!("{path}/cacheHint"),
            op_type: "cacheHint",
            replay_plane: None,
            feature: CanvasKitReplayFeature::CacheHint,
            status: CanvasKitReplayStatus::Direct,
            reason: CanvasKitReplayReason::DirectReplaySupported,
            compat_overlay_allowed: false,
            detail: Some(cache_hint_detail(cache_hint).to_string()),
        });
    }

    fn push(&mut self, item: CanvasKitReplayItem) {
        self.summary.total_items += 1;
        match item.status {
            CanvasKitReplayStatus::Direct => self.summary.direct_items += 1,
            CanvasKitReplayStatus::DirectRequired => self.summary.direct_required_items += 1,
            CanvasKitReplayStatus::CompatOverlay => self.summary.compat_overlay_items += 1,
            CanvasKitReplayStatus::TextFallback => self.summary.text_fallback_items += 1,
            CanvasKitReplayStatus::Unsupported => self.summary.unsupported_items += 1,
        }
        if matches!(item.reason, CanvasKitReplayReason::HiddenOverlayForbidden) {
            self.summary.hidden_overlay_violations += 1;
        }
        self.items.push(item);
    }
}

fn text_variant_report(report: VariantSelectionReport) -> CanvasKitTextVariantReport {
    CanvasKitTextVariantReport {
        backend: report.backend.as_str(),
        render_profile: report.render_profile,
        equivalence_group: report.equivalence_group,
        selected_variant_id: report.selected_variant_id,
        selected_variant_kind: report.selected_variant_kind.as_str(),
        selected_reason: selected_reason_as_str(report.selected_reason),
        anchor_op_id: report.anchor_op_id,
        parts_expected: report.parts_expected,
        parts_replayed: report.parts_replayed,
        font_verification: report.font_verification,
        outline_eligibility: report.outline_eligibility,
        parts: report
            .parts
            .into_iter()
            .map(|part| CanvasKitTextVariantPartReport {
                equivalence_group: part.equivalence_group,
                variant_id: part.variant_id,
                variant_kind: part.variant_kind.as_str(),
                part_index: part.part_index,
                part_count: part.part_count,
                replayable: part.replayable,
                reason: part.reason.map(|reason| reason.as_str()),
                details: part.details,
                font_verification: part.font_verification,
                outline_eligibility: part.outline_eligibility,
            })
            .collect(),
        rejected_variants: report
            .rejected_variants
            .into_iter()
            .map(|rejected| CanvasKitRejectedTextVariant {
                variant_id: rejected.variant_id,
                variant_kind: rejected.variant_kind.as_str(),
                reasons: rejected
                    .reasons
                    .into_iter()
                    .map(|reason| reason.as_str())
                    .collect(),
                details: rejected.details,
            })
            .collect(),
    }
}

fn canvaskit_glyph_run_replay_status(
    run: &LayerGlyphRunPaint,
    resources: &ResourceArena,
) -> VariantReplayStatus {
    if run.glyph_ids.is_empty()
        || run.glyph_ids.len() != run.positions.len()
        || run
            .advances
            .as_ref()
            .is_some_and(|advances| advances.len() != run.glyph_ids.len())
        || run.glyph_transforms.is_some()
        || run.orientation == GlyphRunOrientation::MixedPerGlyph
    {
        return VariantReplayStatus::rejected(VariantRejectReason::VariantUnsupported);
    }
    if run.diagnostics.replay_eligibility != GlyphRunReplayEligibility::Portable {
        return VariantReplayStatus::rejected(VariantRejectReason::FontNotPortable);
    }
    if !run.diagnostics.strict_visual_eligible {
        return VariantReplayStatus::rejected(VariantRejectReason::VariantUnsupported);
    }
    if run.diagnostics.missing_glyph_count != 0 {
        return VariantReplayStatus::rejected(VariantRejectReason::MissingGlyph);
    }
    if run.diagnostics.cluster_mismatch_count != 0 {
        return VariantReplayStatus::rejected(VariantRejectReason::ClusterMismatch);
    }
    if !matches!(
        run.diagnostics.quality,
        TextVariantQuality::Exact | TextVariantQuality::PositionAdjusted
    ) {
        return VariantReplayStatus::rejected(VariantRejectReason::VariantUnsupported);
    }
    if run.diagnostics.quality == TextVariantQuality::PositionAdjusted {
        let tolerance = 0.5_f64.min(0.25_f64.max(run.paint_style.font_size * 0.005));
        if !run.diagnostics.max_residual_after_adjustment_px.is_finite()
            || run.diagnostics.max_residual_after_adjustment_px > tolerance
        {
            return VariantReplayStatus::rejected(
                VariantRejectReason::PositionAdjustedResidualTooLarge,
            );
        }
    }
    if !run.paint_style.is_simple_glyph_run_replay() {
        return VariantReplayStatus::rejected(VariantRejectReason::UnsupportedPaintEffect);
    }
    if !run.shape_key.font_instance.variations.is_empty() {
        let mut status =
            canvaskit_glyph_run_font_rejection(run, VariantRejectReason::VariationUnsupported);
        if let Some(report) = status.font_verification.as_mut() {
            report.variation_supported = Some(false);
        }
        return status;
    }
    let font_resources = resources.font_resources();
    let Some(face) = font_resources
        .faces
        .iter()
        .find(|face| face.id == run.shape_key.font_instance.face_key)
    else {
        return VariantReplayStatus::rejected(VariantRejectReason::ExactFaceUnavailable);
    };
    let Some(blob) = font_resources
        .blobs
        .iter()
        .find(|blob| blob.id == face.blob_key)
    else {
        return VariantReplayStatus::rejected(VariantRejectReason::ExactFaceUnavailable);
    };
    if face.face_index != 0 {
        let mut status =
            canvaskit_glyph_run_font_rejection(run, VariantRejectReason::FaceIndexUnsupported);
        if let Some(report) = status.font_verification.as_mut() {
            report.blob_key = Some(face.blob_key.0.clone());
            report.portability = Some(blob.portability.kind().as_str().to_string());
            report.blob_resolved = Some(true);
            report.exact_face_instantiated = Some(false);
            report.face_index_supported = Some(false);
        }
        return status;
    }
    if !blob.portability.is_self_contained_replayable() {
        return VariantReplayStatus::rejected(VariantRejectReason::FontNotPortable);
    }
    let transform = run.placement.run_to_page;
    if ![
        transform.a,
        transform.b,
        transform.c,
        transform.d,
        transform.e,
        transform.f,
        run.placement.baseline_y,
    ]
    .into_iter()
    .all(f64::is_finite)
        || !run
            .positions
            .iter()
            .all(|position| position.x.is_finite() && position.y.is_finite())
    {
        return VariantReplayStatus::rejected(VariantRejectReason::VariantUnsupported);
    }
    if run
        .glyph_ids
        .iter()
        .any(|glyph_id| *glyph_id > u16::MAX as u32)
    {
        return VariantReplayStatus::rejected(VariantRejectReason::GlyphIdOutOfRange);
    }
    VariantReplayStatus::replayable()
}

fn canvaskit_glyph_run_font_rejection(
    run: &LayerGlyphRunPaint,
    reason: VariantRejectReason,
) -> VariantReplayStatus {
    let mut status = VariantReplayStatus::rejected(reason);
    status.font_verification = Some(VariantFontVerificationReport {
        face_key: Some(run.shape_key.font_instance.face_key.0.clone()),
        blob_key: None,
        portability: None,
        expected_digest: None,
        blob_resolved: None,
        digest_matched: None,
        exact_face_instantiated: None,
        face_index_supported: None,
        variation_supported: None,
        effect_supported: None,
        replay_eligible: false,
        reason: Some(reason),
    });
    status
}

fn canvaskit_glyph_outline_replay_status(
    outline: &LayerGlyphOutlinePaint,
    bbox: Option<crate::renderer::render_tree::BoundingBox>,
    resources: &ResourceArena,
) -> VariantReplayStatus {
    let (payload_supported, payload_reason) =
        canvaskit_glyph_outline_payload_status(outline, bbox, resources);
    let strict_visual_eligible = outline.diagnostics.strict_visual_eligible;
    let paint_style_supported = outline.paint_style.is_fill_only_glyph_replay();
    let replay_eligible = strict_visual_eligible && payload_supported && paint_style_supported;
    let reason = if !strict_visual_eligible {
        Some(VariantRejectReason::VariantUnsupported)
    } else if !payload_supported {
        payload_reason
    } else if !paint_style_supported {
        Some(VariantRejectReason::UnsupportedPaintEffect)
    } else {
        None
    };
    let mut status = if replay_eligible {
        VariantReplayStatus::replayable()
    } else {
        VariantReplayStatus::rejected(reason.unwrap_or(VariantRejectReason::VariantUnsupported))
    };
    if replay_eligible
        && outline.payload_kind == GlyphOutlinePayloadKind::BitmapGlyph
        && outline
            .bitmap_glyph
            .as_ref()
            .is_some_and(|payload| payload.color_space.is_none())
    {
        status.details = Some("colorSpaceDefaulted=srgb".to_string());
    }
    status.outline_eligibility = Some(
        crate::renderer::layer_renderer::VariantOutlineEligibilityReport {
            strict_visual_eligible,
            payload_supported,
            paint_style_supported,
            replay_eligible,
            reason: status.reason,
        },
    );
    status
}

fn canvaskit_glyph_outline_payload_status(
    outline: &LayerGlyphOutlinePaint,
    bbox: Option<crate::renderer::render_tree::BoundingBox>,
    resources: &ResourceArena,
) -> (bool, Option<VariantRejectReason>) {
    if !outline.has_exclusive_payload_family() {
        return (false, Some(VariantRejectReason::MixedGlyphOutlinePayload));
    }
    if outline.paths.iter().any(|path| {
        path.commands.is_empty()
            || path
                .commands
                .iter()
                .any(|command| !path_command_is_finite(command))
    }) {
        return (false, Some(VariantRejectReason::UnsupportedOutlinePayload));
    }
    match outline.payload_kind {
        GlyphOutlinePayloadKind::MonochromeFill => {
            if outline.paths.is_empty() {
                (false, Some(VariantRejectReason::EmptyGlyphOutlinePayload))
            } else {
                (true, None)
            }
        }
        GlyphOutlinePayloadKind::MonochromeFillStroke => {
            if outline.paths.is_empty() {
                return (false, Some(VariantRejectReason::EmptyGlyphOutlinePayload));
            }
            if !outline
                .stroke
                .as_ref()
                .is_some_and(|stroke| stroke.is_supported_monochrome_subset())
            {
                return (
                    false,
                    Some(VariantRejectReason::GlyphOutlineStrokeStyleUnsupported),
                );
            }
            (true, None)
        }
        GlyphOutlinePayloadKind::ColorLayers => {
            if outline.color_layers.as_ref().is_some_and(|payload| {
                payload.has_colrv0_resolved_layer_contract()
                    || payload.has_colrv1_supported_graph_contract()
            }) {
                (true, None)
            } else {
                (false, Some(VariantRejectReason::UnsupportedColorGlyph))
            }
        }
        GlyphOutlinePayloadKind::BitmapGlyph => {
            let Some(payload) = &outline.bitmap_glyph else {
                return (false, Some(VariantRejectReason::UnsupportedBitmapGlyph));
            };
            if bbox.is_none_or(|bbox| !glyph_payload_bbox_is_replayable(bbox))
                || !payload.has_strict_visual_contract()
                || resources.image_bytes(payload.image_resource_id).is_none()
            {
                return (false, Some(VariantRejectReason::UnsupportedBitmapGlyph));
            }
            (true, None)
        }
        GlyphOutlinePayloadKind::SvgGlyph => {
            let Some(payload) = &outline.svg_glyph else {
                return (false, Some(VariantRejectReason::UnsupportedSvgGlyph));
            };
            let Some(fragment) = resources.svg_fragment(payload.vector_resource_id) else {
                return (false, Some(VariantRejectReason::UnsupportedSvgGlyph));
            };
            if bbox.is_none_or(|bbox| !glyph_payload_bbox_is_replayable(bbox))
                || !payload.has_static_sanitized_contract()
                || !canvaskit_static_svg_fragment_has_path_layer(fragment)
            {
                return (false, Some(VariantRejectReason::UnsupportedSvgGlyph));
            }
            (true, None)
        }
    }
}

fn glyph_payload_bbox_is_replayable(bbox: crate::renderer::render_tree::BoundingBox) -> bool {
    bbox.x.is_finite()
        && bbox.y.is_finite()
        && bbox.width.is_finite()
        && bbox.height.is_finite()
        && bbox.width > 0.0
        && bbox.height > 0.0
}

fn path_command_is_finite(command: &crate::renderer::PathCommand) -> bool {
    match command {
        crate::renderer::PathCommand::MoveTo(x, y) | crate::renderer::PathCommand::LineTo(x, y) => {
            x.is_finite() && y.is_finite()
        }
        crate::renderer::PathCommand::CurveTo(x1, y1, x2, y2, x, y) => {
            x1.is_finite()
                && y1.is_finite()
                && x2.is_finite()
                && y2.is_finite()
                && x.is_finite()
                && y.is_finite()
        }
        crate::renderer::PathCommand::ClosePath => true,
        crate::renderer::PathCommand::ArcTo(rx, ry, rotation, _, _, x, y) => {
            rx.is_finite()
                && ry.is_finite()
                && rotation.is_finite()
                && x.is_finite()
                && y.is_finite()
        }
    }
}

fn canvaskit_static_svg_fragment_has_path_layer(fragment: &str) -> bool {
    static_svg_fragment_has_path_layer(fragment)
}

fn direct_item(
    path: String,
    op_type: &'static str,
    feature: CanvasKitReplayFeature,
) -> CanvasKitReplayItem {
    direct_item_with_detail(path, op_type, feature, None)
}

fn direct_item_with_detail(
    path: String,
    op_type: &'static str,
    feature: CanvasKitReplayFeature,
    detail: Option<String>,
) -> CanvasKitReplayItem {
    CanvasKitReplayItem {
        path,
        op_type,
        replay_plane: None,
        feature,
        status: CanvasKitReplayStatus::Direct,
        reason: CanvasKitReplayReason::DirectReplaySupported,
        compat_overlay_allowed: false,
        detail,
    }
}

fn direct_required_item_with_detail(
    path: String,
    op_type: &'static str,
    feature: CanvasKitReplayFeature,
    detail: Option<String>,
) -> CanvasKitReplayItem {
    CanvasKitReplayItem {
        path,
        op_type,
        replay_plane: None,
        feature,
        status: CanvasKitReplayStatus::DirectRequired,
        reason: CanvasKitReplayReason::DirectReplayRequired,
        compat_overlay_allowed: false,
        detail,
    }
}

fn image_item(
    path: String,
    image: &crate::paint::LayerImagePaint,
    resources: &ResourceArena,
) -> CanvasKitReplayItem {
    let has_payload = image
        .resource_id
        .and_then(|resource_id| resources.image_bytes(resource_id))
        .is_some();
    let detail = Some(image_replay_detail(
        image.fill_mode,
        image.original_size,
        image.crop,
        Some(image.effect),
        image.brightness,
        image.contrast,
        Some(image.transform),
        image.external_path.as_deref(),
        has_payload,
        image.text_wrap,
    ));

    if has_payload {
        direct_item_with_detail(path, "image", CanvasKitReplayFeature::RasterImage, detail)
    } else {
        direct_required_item_with_detail(path, "image", CanvasKitReplayFeature::RasterImage, detail)
    }
}

fn page_background_item(
    path: String,
    background: &crate::paint::LayerPageBackgroundPaint,
    resources: &ResourceArena,
) -> CanvasKitReplayItem {
    let Some(image) = background.image.as_ref() else {
        return direct_item_with_detail(
            path,
            "pageBackground",
            CanvasKitReplayFeature::PageBackground,
            None,
        );
    };
    let has_payload = resources.image_bytes(image.resource_id).is_some();
    let detail = Some(image_replay_detail(
        Some(image.fill_mode),
        None,
        None,
        Some(image.effect),
        image.brightness,
        image.contrast,
        None,
        None,
        has_payload,
        None,
    ));
    if has_payload {
        direct_item_with_detail(
            path,
            "pageBackground",
            CanvasKitReplayFeature::PageBackground,
            detail,
        )
    } else {
        direct_required_item_with_detail(
            path,
            "pageBackground",
            CanvasKitReplayFeature::PageBackground,
            detail,
        )
    }
}

fn image_replay_detail(
    fill_mode: Option<ImageFillMode>,
    original_size: Option<(f64, f64)>,
    crop: Option<(i32, i32, i32, i32)>,
    effect: Option<ImageEffect>,
    brightness: i8,
    contrast: i8,
    transform: Option<crate::renderer::render_tree::ShapeTransform>,
    external_path: Option<&str>,
    has_payload: bool,
    text_wrap: Option<TextWrap>,
) -> String {
    let mut detail = String::new();
    detail.push_str("fillMode=");
    detail.push_str(fill_mode.map_or("default", image_fill_mode_detail));

    if let Some((width, height)) = original_size {
        let _ = write!(detail, ";originalSize={width:.3}x{height:.3}");
    } else {
        detail.push_str(";originalSize=source");
    }

    if let Some((left, top, right, bottom)) = crop {
        let _ = write!(detail, ";crop={left},{top},{right},{bottom}");
    } else {
        detail.push_str(";crop=none");
    }

    if let Some(effect) = effect {
        detail.push_str(";effect=");
        detail.push_str(image_effect_detail(effect));
    }
    if brightness != 0 || contrast != 0 {
        let _ = write!(detail, ";tone=brightness:{brightness},contrast:{contrast}");
    }

    if let Some(transform) = transform {
        let _ = write!(
            detail,
            ";transform=rotation:{:.3},horzFlip:{},vertFlip:{}",
            transform.rotation, transform.horz_flip, transform.vert_flip
        );
    }
    if let Some(text_wrap) = text_wrap {
        detail.push_str(";wrap=");
        detail.push_str(text_wrap_detail(text_wrap));
    }
    if external_path.is_some() {
        detail.push_str(";externalImage");
    }
    if has_payload {
        detail.push_str(";injectedImageData");
    } else {
        detail.push_str(";missingImageData");
    }

    detail
}

fn text_wrap_detail(value: TextWrap) -> &'static str {
    match value {
        TextWrap::Square => "square",
        TextWrap::Tight => "tight",
        TextWrap::Through => "through",
        TextWrap::TopAndBottom => "topAndBottom",
        TextWrap::BehindText => "behindText",
        TextWrap::InFrontOfText => "inFrontOfText",
    }
}

fn image_fill_mode_detail(value: ImageFillMode) -> &'static str {
    match value {
        ImageFillMode::TileAll => "tileAll",
        ImageFillMode::TileHorzTop => "tileHorzTop",
        ImageFillMode::TileHorzBottom => "tileHorzBottom",
        ImageFillMode::TileVertLeft => "tileVertLeft",
        ImageFillMode::TileVertRight => "tileVertRight",
        ImageFillMode::FitToSize => "fitToSize",
        ImageFillMode::Center => "center",
        ImageFillMode::CenterTop => "centerTop",
        ImageFillMode::CenterBottom => "centerBottom",
        ImageFillMode::LeftCenter => "leftCenter",
        ImageFillMode::LeftTop => "leftTop",
        ImageFillMode::LeftBottom => "leftBottom",
        ImageFillMode::RightCenter => "rightCenter",
        ImageFillMode::RightTop => "rightTop",
        ImageFillMode::RightBottom => "rightBottom",
        ImageFillMode::None => "none",
    }
}

fn image_effect_detail(value: ImageEffect) -> &'static str {
    match value {
        ImageEffect::RealPic => "realPic",
        ImageEffect::GrayScale => "grayScale",
        ImageEffect::BlackWhite => "blackWhite",
        ImageEffect::Pattern8x8 => "pattern8x8",
    }
}

fn selected_reason_as_str(reason: VariantSelectedReason) -> &'static str {
    reason.as_str()
}

fn paint_op_type(op: &PaintOp) -> &'static str {
    match op {
        PaintOp::PageBackground { .. } => "pageBackground",
        PaintOp::TextRun { .. } => "textRun",
        PaintOp::GlyphRun { .. } => "glyphRun",
        PaintOp::GlyphOutline { .. } => "glyphOutline",
        PaintOp::CharOverlap { .. } => "charOverlap",
        PaintOp::TextControlMark { .. } => "textControlMark",
        PaintOp::TabLeader { .. } => "tabLeader",
        PaintOp::TextDecoration { .. } => "textDecoration",
        PaintOp::FootnoteMarker { .. } => "footnoteMarker",
        PaintOp::Line { .. } => "line",
        PaintOp::Rectangle { .. } => "rectangle",
        PaintOp::Ellipse { .. } => "ellipse",
        PaintOp::Path { .. } => "path",
        PaintOp::Image { .. } => "image",
        PaintOp::Equation { .. } => "equation",
        PaintOp::FormObject { .. } => "formObject",
    }
}

fn clip_kind_detail(clip_kind: ClipKind) -> &'static str {
    match clip_kind {
        ClipKind::Body => "body",
        ClipKind::TableCell => "tableCell",
        ClipKind::TextBox => "textBox",
        ClipKind::Generic => "generic",
    }
}

fn cache_hint_detail(cache_hint: CacheHint) -> &'static str {
    match cache_hint {
        CacheHint::None => "none",
        CacheHint::StaticSubtree => "staticSubtree",
        CacheHint::PreferRaster => "preferRaster",
        CacheHint::PreferVectorRecording => "preferVectorRecording",
    }
}

#[cfg(test)]
mod tests {
    use super::{
        analyze_canvaskit_replay_plan, canvaskit_glyph_outline_payload_status,
        canvaskit_glyph_run_replay_status, canvaskit_static_svg_fragment_has_path_layer,
        CanvasKitReplayMode, CanvasKitReplayStatus, CanvasKitTextVariantPartReport,
        CanvasKitTextVariantReport, GlyphOutlinePayloadKind, VariantRejectReason,
    };
    use crate::model::image::ImageEffect;
    use crate::model::style::ImageFillMode;
    use crate::paint::{
        BinaryResourceKind, BinaryResourceRef, BitmapAlphaMode, BitmapGlyphFiltering,
        BitmapGlyphPayload, BitmapGlyphScalingPolicy, BitmapStrikeSelection, ColorGlyphFormat,
        ColorGradientStop, ColorLayersPayload, ColorLinearGradient, ColorPaintGraphNode,
        ColorPaintGraphNodeKind, ColorPaintGraphPayload, ColorPaintLinearGradientPathNode,
        ColorPaintSolidPathNode, ColorPaintTransformNode, FontBlobKey, FontBlobResource,
        FontColorGlyphRef, FontDigest, FontFaceKey, FontFaceResource, FontFallbackPolicyId,
        FontInstanceKey, FontPortability, FontResourceSource, GlyphOutlineFillRule, GlyphRange,
        GlyphRunDiagnostics, GlyphRunOrientation, GlyphRunReplayEligibility, GlyphTransform,
        ImageResourceId, LayerAffineTransform, LayerGlyphOutlinePaint, LayerGlyphOutlinePath,
        LayerGlyphRunPaint, LayerImagePaint, LayerNode, LayerPageBackgroundImagePaint,
        LayerPageBackgroundPaint, LayerPoint, LayerTextRunPaint, LayerVector, LocalizedName,
        PageLayerTree, PaintOp, PaintTextStyle, PaintVariantMeta, ResolvedColor, ResourceArena,
        ShapeKey, ShapingEngineId, SvgGlyphPayload, SvgGlyphSecurityMode, SvgGlyphViewBox,
        TextDirection, TextRunPlacement, TextSourceId, TextSourceRange, TextSourceSpan,
        TextVariantKind, TextVariantQuality, VariationAxisValue, WritingMode,
    };
    use crate::paint::{LayerBuilder, RenderProfile};
    use crate::renderer::layer_renderer::VariantOutlineEligibilityReport;
    use crate::renderer::render_tree::{
        BoundingBox, PageRenderTree, RawSvgNode, RenderNode, RenderNodeType, ShapeTransform,
    };
    use crate::renderer::{PathCommand, TextStyle};

    fn identity() -> LayerAffineTransform {
        LayerAffineTransform {
            a: 1.0,
            b: 0.0,
            c: 0.0,
            d: 1.0,
            e: 0.0,
            f: 0.0,
        }
    }

    fn placement() -> TextRunPlacement {
        TextRunPlacement {
            run_to_page: identity(),
            baseline_y: 0.0,
        }
    }

    fn source_span() -> TextSourceSpan {
        TextSourceSpan {
            id: TextSourceId(0),
            utf8_range: TextSourceRange::new(0, 1),
            utf16_range: TextSourceRange::new(0, 1),
            stable_source_key: None,
        }
    }

    fn variant() -> PaintVariantMeta {
        PaintVariantMeta {
            equivalence_group: "text-0".to_string(),
            variant_id: "glyphOutline".to_string(),
            variant_kind: TextVariantKind::GlyphOutline,
            part_index: 0,
            part_count: 1,
            is_default_fallback: false,
            requires: Vec::new(),
            quality: Some(TextVariantQuality::Exact),
            anchor_op_id: Some("op-text-0".to_string()),
            local_paint_order: Some(0),
        }
    }

    fn diagnostics() -> GlyphRunDiagnostics {
        GlyphRunDiagnostics {
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
        }
    }

    fn add_portable_test_font(resources: &mut ResourceArena, face_index: u32) -> FontFaceKey {
        let blob_key = FontBlobKey("test-blob".to_string());
        let face_key = FontFaceKey("test-face".to_string());
        let digest = FontDigest {
            algorithm: "sha256".to_string(),
            value: "test-digest".to_string(),
        };
        let data_ref = BinaryResourceRef {
            kind: BinaryResourceKind::FontBlob,
            id: "test-font-binary".to_string(),
        };
        resources.font_resources_mut().blobs.push(FontBlobResource {
            id: blob_key.clone(),
            digest: Some(digest.clone()),
            source: FontResourceSource::Embedded,
            data_ref: Some(data_ref.clone()),
            portability: FontPortability::PortableBlob { digest, data_ref },
        });
        resources.font_resources_mut().faces.push(FontFaceResource {
            id: face_key.clone(),
            blob_key,
            face_index,
            postscript_name: Some("TestFace".to_string()),
            family_names: Vec::new(),
            style_names: Vec::new(),
            weight_class: None,
            width_class: None,
            italic: None,
        });
        face_key
    }

    fn glyph_run(face_key: FontFaceKey, variations: Vec<VariationAxisValue>) -> LayerGlyphRunPaint {
        LayerGlyphRunPaint {
            source: source_span(),
            variant: PaintVariantMeta {
                equivalence_group: "text-0".to_string(),
                variant_id: "glyphRun".to_string(),
                variant_kind: TextVariantKind::GlyphRun,
                part_index: 0,
                part_count: 1,
                is_default_fallback: false,
                requires: vec!["text.glyphRun".to_string()],
                quality: Some(TextVariantQuality::Exact),
                anchor_op_id: Some("op-text-0".to_string()),
                local_paint_order: Some(0),
            },
            paint_style: PaintTextStyle::from(&TextStyle::default()),
            shape_key: ShapeKey {
                font_instance: FontInstanceKey {
                    face_key,
                    size_px: 12.0,
                    variations,
                    synthetic_bold: false,
                    synthetic_italic: false,
                },
                direction: TextDirection::Ltr,
                writing_mode: WritingMode::HorizontalTb,
                script: None,
                language: None,
                features: Vec::new(),
                shaping_engine: ShapingEngineId("test-shaper".to_string()),
                fallback_policy: FontFallbackPolicyId("none".to_string()),
            },
            placement: placement(),
            glyph_ids: vec![1],
            positions: vec![LayerPoint { x: 0.0, y: 0.0 }],
            advances: None,
            clusters: Vec::new(),
            direction: TextDirection::Ltr,
            bidi_level: None,
            writing_mode: WritingMode::HorizontalTb,
            orientation: GlyphRunOrientation::Horizontal,
            glyph_transforms: None,
            diagnostics: diagnostics(),
        }
    }

    fn outline(payload_kind: GlyphOutlinePayloadKind) -> LayerGlyphOutlinePaint {
        LayerGlyphOutlinePaint {
            source: source_span(),
            variant: variant(),
            payload_kind,
            stroke: None,
            color_layers: None,
            bitmap_glyph: None,
            svg_glyph: None,
            paint_style: PaintTextStyle::from(&TextStyle::default()),
            placement: placement(),
            paths: Vec::new(),
            diagnostics: diagnostics(),
        }
    }

    fn outline_path() -> LayerGlyphOutlinePath {
        LayerGlyphOutlinePath {
            glyph_id: 1,
            source_range_utf8: TextSourceRange::new(0, 1),
            glyph_range: GlyphRange::new(0, 1),
            commands: vec![
                PathCommand::MoveTo(0.0, 0.0),
                PathCommand::LineTo(12.0, 0.0),
                PathCommand::LineTo(12.0, 12.0),
                PathCommand::ClosePath,
            ],
            fill_rule: GlyphOutlineFillRule::NonZero,
        }
    }

    fn valid_bbox() -> BoundingBox {
        BoundingBox::new(0.0, 0.0, 16.0, 16.0)
    }

    fn text_run_op(equivalence_group: &str) -> PaintOp {
        PaintOp::TextRun {
            bbox: valid_bbox(),
            run: LayerTextRunPaint {
                variant: Some(PaintVariantMeta::text_run_default(equivalence_group)),
                text: "A".to_string(),
                ..LayerTextRunPaint::default()
            },
        }
    }

    fn source_font_ref(format: ColorGlyphFormat) -> FontColorGlyphRef {
        FontColorGlyphRef {
            face_key: Some("fixture-face".to_string()),
            glyph_id: Some(42),
            palette_index: Some(0),
            color_format: Some(format),
        }
    }

    fn colrv0_payload() -> ColorLayersPayload {
        let source_range = TextSourceRange::new(0, 1);
        let glyph_range = GlyphRange::new(0, 1);
        let source_font_ref = source_font_ref(ColorGlyphFormat::ColrV0);
        ColorLayersPayload {
            color_format: ColorGlyphFormat::ColrV0,
            source_font_ref: Some(source_font_ref.clone()),
            palette_ref: None,
            layers: vec![crate::paint::ColorLayerNode {
                layer_index: Some(0),
                glyph_id: Some(42),
                glyph_range: Some(glyph_range),
                source_range_utf8: Some(source_range),
                source_font_ref: Some(source_font_ref),
                path_index: Some(0),
                commands: Some(vec![
                    PathCommand::MoveTo(0.0, 0.0),
                    PathCommand::LineTo(12.0, 0.0),
                    PathCommand::LineTo(12.0, 12.0),
                    PathCommand::ClosePath,
                ]),
                fill: Some(ResolvedColor {
                    color_space: Some("srgb".to_string()),
                    rgba: [0.0, 0.0, 1.0, 1.0],
                }),
                fill_rule: Some(GlyphOutlineFillRule::NonZero),
                palette_index: Some(0),
                color: Some(0x0000ff),
                opacity: Some(1.0),
                transform_to_run: Some(identity()),
            }],
            paint_graph: None,
            source_range_utf8: Some(source_range),
            glyph_range: Some(glyph_range),
        }
    }

    fn colrv1_stage1_payload() -> ColorLayersPayload {
        let source_range = TextSourceRange::new(0, 1);
        let glyph_range = GlyphRange::new(0, 1);
        let source_font_ref = source_font_ref(ColorGlyphFormat::ColrV1);
        ColorLayersPayload {
            color_format: ColorGlyphFormat::ColrV1,
            source_font_ref: Some(source_font_ref.clone()),
            palette_ref: None,
            layers: Vec::new(),
            paint_graph: Some(ColorPaintGraphPayload {
                root_node_id: 1,
                nodes: vec![
                    ColorPaintGraphNode {
                        node_id: 0,
                        kind: ColorPaintGraphNodeKind::SolidPath,
                        solid_path: Some(ColorPaintSolidPathNode {
                            commands: vec![
                                PathCommand::MoveTo(0.0, 0.0),
                                PathCommand::LineTo(12.0, 0.0),
                                PathCommand::LineTo(12.0, 12.0),
                                PathCommand::ClosePath,
                            ],
                            fill: ResolvedColor {
                                color_space: Some("srgb".to_string()),
                                rgba: [0.0, 1.0, 0.0, 1.0],
                            },
                            fill_rule: GlyphOutlineFillRule::NonZero,
                            source_glyph_id: Some(42),
                            palette_index: Some(0),
                        }),
                        linear_gradient_path: None,
                        radial_gradient_path: None,
                        sweep_gradient_path: None,
                        transform: None,
                        composite: None,
                        clip: None,
                        source_range_utf8: Some(source_range),
                        glyph_range: Some(glyph_range),
                        source_font_ref: Some(source_font_ref),
                    },
                    ColorPaintGraphNode {
                        node_id: 1,
                        kind: ColorPaintGraphNodeKind::Transform,
                        solid_path: None,
                        linear_gradient_path: None,
                        radial_gradient_path: None,
                        sweep_gradient_path: None,
                        transform: Some(ColorPaintTransformNode {
                            child_node_id: 0,
                            transform: identity(),
                        }),
                        composite: None,
                        clip: None,
                        source_range_utf8: None,
                        glyph_range: None,
                        source_font_ref: None,
                    },
                ],
            }),
            source_range_utf8: Some(source_range),
            glyph_range: Some(glyph_range),
        }
    }

    fn colrv1_linear_gradient_payload() -> ColorLayersPayload {
        let source_range = TextSourceRange::new(0, 1);
        let glyph_range = GlyphRange::new(0, 1);
        let source_font_ref = source_font_ref(ColorGlyphFormat::ColrV1);
        ColorLayersPayload {
            color_format: ColorGlyphFormat::ColrV1,
            source_font_ref: Some(source_font_ref.clone()),
            palette_ref: None,
            layers: Vec::new(),
            paint_graph: Some(ColorPaintGraphPayload {
                root_node_id: 0,
                nodes: vec![ColorPaintGraphNode {
                    node_id: 0,
                    kind: ColorPaintGraphNodeKind::LinearGradientPath,
                    solid_path: None,
                    linear_gradient_path: Some(ColorPaintLinearGradientPathNode {
                        commands: vec![
                            PathCommand::MoveTo(0.0, 0.0),
                            PathCommand::LineTo(12.0, 0.0),
                            PathCommand::LineTo(12.0, 12.0),
                            PathCommand::ClosePath,
                        ],
                        gradient: ColorLinearGradient {
                            x0: 0.0,
                            y0: 0.0,
                            x1: 12.0,
                            y1: 0.0,
                            stops: vec![
                                ColorGradientStop {
                                    offset: 0.0,
                                    color: ResolvedColor {
                                        color_space: Some("srgb".to_string()),
                                        rgba: [1.0, 0.0, 0.0, 1.0],
                                    },
                                },
                                ColorGradientStop {
                                    offset: 1.0,
                                    color: ResolvedColor {
                                        color_space: Some("srgb".to_string()),
                                        rgba: [0.0, 0.0, 1.0, 1.0],
                                    },
                                },
                            ],
                        },
                        fill_rule: GlyphOutlineFillRule::NonZero,
                        source_glyph_id: Some(42),
                        palette_index: Some(0),
                    }),
                    radial_gradient_path: None,
                    sweep_gradient_path: None,
                    transform: None,
                    composite: None,
                    clip: None,
                    source_range_utf8: Some(source_range),
                    glyph_range: Some(glyph_range),
                    source_font_ref: Some(source_font_ref),
                }],
            }),
            source_range_utf8: Some(source_range),
            glyph_range: Some(glyph_range),
        }
    }

    fn bitmap_payload(image_resource_id: crate::paint::ImageResourceId) -> BitmapGlyphPayload {
        BitmapGlyphPayload {
            image_resource_id,
            source_range_utf8: Some(TextSourceRange::new(0, 1)),
            glyph_range: Some(GlyphRange::new(0, 1)),
            placement: Some(placement()),
            transform_to_run: Some(identity()),
            strike_ppem: Some((16, 16)),
            strike_selection: Some(BitmapStrikeSelection::ProducerResolved),
            pixel_format: Some("rgba8".to_string()),
            color_space: None,
            alpha_mode: Some(BitmapAlphaMode::Premultiplied),
            scaling_policy: Some(BitmapGlyphScalingPolicy::ExplicitTransform),
            filtering: Some(BitmapGlyphFiltering::Linear),
        }
    }

    fn svg_payload(vector_resource_id: crate::paint::SvgResourceId) -> SvgGlyphPayload {
        SvgGlyphPayload {
            vector_resource_id,
            source_range_utf8: Some(TextSourceRange::new(0, 1)),
            glyph_range: Some(GlyphRange::new(0, 1)),
            placement: Some(placement()),
            transform_to_run: Some(identity()),
            view_box: Some(SvgGlyphViewBox {
                x: 0.0,
                y: 0.0,
                width: 16.0,
                height: 16.0,
            }),
            intrinsic_size: None,
            security_mode: SvgGlyphSecurityMode::StaticSanitized,
            script_allowed: false,
            animation_allowed: false,
            external_resources_allowed: false,
            interactivity_allowed: false,
        }
    }

    #[test]
    fn canvaskit_text_variant_json_serializes_selected_part_details() {
        let report = CanvasKitTextVariantReport {
            backend: "canvaskit",
            render_profile: "screen".to_string(),
            equivalence_group: "outline-parity-bitmap".to_string(),
            selected_variant_id: "glyphOutline".to_string(),
            selected_variant_kind: "glyphOutline",
            selected_reason: "glyphOutlineStrictProfile",
            anchor_op_id: Some("op-text-0".to_string()),
            parts_expected: 1,
            parts_replayed: 1,
            font_verification: None,
            outline_eligibility: Some(VariantOutlineEligibilityReport {
                strict_visual_eligible: true,
                payload_supported: true,
                paint_style_supported: true,
                replay_eligible: true,
                reason: None,
            }),
            parts: vec![CanvasKitTextVariantPartReport {
                equivalence_group: "outline-parity-bitmap".to_string(),
                variant_id: "glyphOutline".to_string(),
                variant_kind: "glyphOutline",
                part_index: 0,
                part_count: 1,
                replayable: true,
                reason: None,
                details: Some("colorSpaceDefaulted=srgb".to_string()),
                font_verification: None,
                outline_eligibility: Some(VariantOutlineEligibilityReport {
                    strict_visual_eligible: true,
                    payload_supported: true,
                    paint_style_supported: true,
                    replay_eligible: true,
                    reason: None,
                }),
            }],
            rejected_variants: Vec::new(),
        };
        let mut json = String::new();
        report.write_json(&mut json);

        assert!(json.contains("\"parts\":[{"));
        assert!(json.contains("\"variantId\":\"glyphOutline\""));
        assert!(json.contains("\"details\":\"colorSpaceDefaulted=srgb\""));
        assert!(json.contains("\"outlineEligibility\":{\"strictVisualEligible\":true"));
        assert!(json.contains("\"partsReplayed\":1"));
    }

    #[test]
    fn canvaskit_replay_plan_selects_sidecar_variant_ops() {
        let text = text_run_op("text-0");
        let anchor_op_id = match &text {
            PaintOp::TextRun { run, .. } => run
                .variant
                .as_ref()
                .expect("text fallback variant")
                .stable_op_id(),
            _ => unreachable!("helper returns textRun"),
        };
        let mut outline = outline(GlyphOutlinePayloadKind::MonochromeFill);
        outline.variant = PaintVariantMeta {
            equivalence_group: "text-0".to_string(),
            variant_id: "glyphOutline".to_string(),
            variant_kind: TextVariantKind::GlyphOutline,
            part_index: 0,
            part_count: 1,
            is_default_fallback: false,
            requires: vec!["text.glyphOutline.monochromeFill".to_string()],
            quality: Some(TextVariantQuality::Exact),
            anchor_op_id: Some(anchor_op_id),
            local_paint_order: Some(0),
        };
        outline.paths = vec![outline_path()];
        let tree = PageLayerTree::builder(
            100.0,
            100.0,
            LayerNode::leaf(valid_bbox(), None, vec![text]),
        )
        .variant_ops(vec![PaintOp::GlyphOutline {
            bbox: valid_bbox(),
            outline: Box::new(outline),
        }])
        .build();

        let plan = analyze_canvaskit_replay_plan(&tree, CanvasKitReplayMode::Default);
        let report = plan
            .text_variants
            .iter()
            .find(|report| report.equivalence_group == "text-0")
            .expect("sidecar variant report");

        assert_eq!(report.selected_variant_id, "glyphOutline");
        assert_eq!(report.parts_expected, 1);
        assert_eq!(report.parts_replayed, 1);
        assert_eq!(report.parts.len(), 2);
        assert!(report
            .parts
            .iter()
            .any(|part| part.variant_id == "glyphOutline" && part.replayable));
        assert!(plan.items.iter().any(|item| {
            item.path == "root/leaf/0"
                && item.op_type == "textRun"
                && item.status == CanvasKitReplayStatus::TextFallback
        }));
        assert!(plan.items.iter().any(|item| {
            item.path == "root/leaf/variantOps/0"
                && item.op_type == "glyphOutline"
                && item.status == CanvasKitReplayStatus::Direct
        }));
    }

    #[test]
    fn canvaskit_replay_plan_selects_bitmap_glyph_sidecar_with_srgb_default_detail() {
        let text = text_run_op("text-0");
        let anchor_op_id = match &text {
            PaintOp::TextRun { run, .. } => run
                .variant
                .as_ref()
                .expect("text fallback variant")
                .stable_op_id(),
            _ => unreachable!("helper returns textRun"),
        };
        let mut resources = ResourceArena::default();
        let image_id = resources.intern_image_bytes(&[0, 1, 2, 3]);
        let mut outline = outline(GlyphOutlinePayloadKind::BitmapGlyph);
        outline.variant.anchor_op_id = Some(anchor_op_id);
        outline.variant.requires = vec![
            "text.glyphOutline.bitmapGlyph".to_string(),
            "text.strictVisualFallbackFree".to_string(),
        ];
        outline.bitmap_glyph = Some(bitmap_payload(image_id));
        let tree = PageLayerTree::builder(
            100.0,
            100.0,
            LayerNode::leaf(valid_bbox(), None, vec![text]),
        )
        .resources(resources)
        .variant_ops(vec![PaintOp::GlyphOutline {
            bbox: valid_bbox(),
            outline: Box::new(outline),
        }])
        .build();

        let plan = analyze_canvaskit_replay_plan(&tree, CanvasKitReplayMode::Default);
        let report = plan
            .text_variants
            .iter()
            .find(|report| report.equivalence_group == "text-0")
            .expect("bitmap sidecar variant report");

        assert_eq!(report.selected_variant_id, "glyphOutline");
        assert!(report.parts.iter().any(|part| {
            part.variant_id == "glyphOutline"
                && part.replayable
                && part.details.as_deref() == Some("colorSpaceDefaulted=srgb")
        }));
        assert!(plan.items.iter().any(|item| {
            item.path == "root/leaf/variantOps/0"
                && item.op_type == "glyphOutline"
                && item.status == CanvasKitReplayStatus::Direct
        }));
    }

    #[test]
    fn canvaskit_replay_plan_selects_static_svg_glyph_sidecar_resource() {
        let text = text_run_op("text-0");
        let anchor_op_id = match &text {
            PaintOp::TextRun { run, .. } => run
                .variant
                .as_ref()
                .expect("text fallback variant")
                .stable_op_id(),
            _ => unreachable!("helper returns textRun"),
        };
        let mut resources = ResourceArena::default();
        let svg_id = resources
            .intern_svg_fragment("<path d=\"M0 0 L16 0 L16 16 L0 16 Z\" fill=\"#00ffff\"/>");
        let mut outline = outline(GlyphOutlinePayloadKind::SvgGlyph);
        outline.variant.anchor_op_id = Some(anchor_op_id);
        outline.variant.requires = vec![
            "text.glyphOutline.svgGlyph".to_string(),
            "text.strictVisualFallbackFree".to_string(),
        ];
        outline.svg_glyph = Some(svg_payload(svg_id));
        let tree = PageLayerTree::builder(
            100.0,
            100.0,
            LayerNode::leaf(valid_bbox(), None, vec![text]),
        )
        .resources(resources)
        .variant_ops(vec![PaintOp::GlyphOutline {
            bbox: valid_bbox(),
            outline: Box::new(outline),
        }])
        .build();

        let plan = analyze_canvaskit_replay_plan(&tree, CanvasKitReplayMode::Default);
        let report = plan
            .text_variants
            .iter()
            .find(|report| report.equivalence_group == "text-0")
            .expect("SvgGlyph sidecar variant report");

        assert_eq!(report.selected_variant_id, "glyphOutline");
        assert!(report.parts.iter().any(|part| {
            part.variant_id == "glyphOutline" && part.replayable && part.reason.is_none()
        }));
        assert!(plan.items.iter().any(|item| {
            item.path == "root/leaf/variantOps/0"
                && item.op_type == "glyphOutline"
                && item.status == CanvasKitReplayStatus::Direct
        }));
    }

    #[test]
    fn canvaskit_replay_plan_reports_image_payload_details() {
        let mut resources = ResourceArena::default();
        let background_image_id = resources.intern_image_bytes(&[137, 80, 78, 71]);
        let tree = PageLayerTree::builder(
            100.0,
            100.0,
            LayerNode::leaf(
                valid_bbox(),
                None,
                vec![
                    PaintOp::PageBackground {
                        bbox: valid_bbox(),
                        background: LayerPageBackgroundPaint {
                            background_color: None,
                            border_color: None,
                            border_width: 0.0,
                            gradient: None,
                            image: Some(LayerPageBackgroundImagePaint {
                                resource_id: background_image_id,
                                fill_mode: ImageFillMode::TileHorzBottom,
                                brightness: -10,
                                contrast: 20,
                                effect: ImageEffect::Pattern8x8,
                            }),
                        },
                    },
                    PaintOp::Image {
                        bbox: valid_bbox(),
                        image: LayerImagePaint {
                            resource_id: None,
                            external_path: None,
                            text_wrap: None,
                            fill_mode: Some(ImageFillMode::CenterBottom),
                            original_size: Some((40.0, 30.0)),
                            crop: Some((75, 150, 225, 300)),
                            brightness: 15,
                            contrast: -5,
                            effect: ImageEffect::Pattern8x8,
                            transform: ShapeTransform {
                                rotation: 12.5,
                                horz_flip: true,
                                vert_flip: false,
                            },
                        },
                    },
                ],
            ),
        )
        .resources(resources)
        .build();

        let plan = analyze_canvaskit_replay_plan(&tree, CanvasKitReplayMode::Default);

        assert_eq!(plan.items.len(), 2);
        assert_eq!(plan.summary.total_items, plan.items.len() as u32);
        assert_eq!(plan.summary.direct_items, 1);
        assert_eq!(plan.summary.direct_required_items, 1);

        let page_background_detail = plan
            .items
            .iter()
            .find(|item| item.op_type == "pageBackground")
            .and_then(|item| item.detail.as_deref())
            .expect("page background image replay detail");
        assert!(page_background_detail.contains("fillMode=tileHorzBottom"));
        assert!(page_background_detail.contains("originalSize=source"));
        assert!(page_background_detail.contains("crop=none"));
        assert!(page_background_detail.contains("effect=pattern8x8"));
        assert!(page_background_detail.contains("tone=brightness:-10,contrast:20"));

        let image_detail = plan
            .items
            .iter()
            .find(|item| item.op_type == "image")
            .and_then(|item| item.detail.as_deref())
            .expect("image replay detail");
        assert!(image_detail.contains("fillMode=centerBottom"));
        assert!(image_detail.contains("originalSize=40.000x30.000"));
        assert!(image_detail.contains("crop=75,150,225,300"));
        assert!(image_detail.contains("effect=pattern8x8"));
        assert!(image_detail.contains("tone=brightness:15,contrast:-5"));
        assert!(image_detail.contains("transform=rotation:12.500,horzFlip:true,vertFlip:false"));
        assert!(image_detail.contains("missingImageData"));

        let json = plan.to_json();
        assert!(json.contains("\"detail\":\"fillMode=tileHorzBottom"));
        assert!(json.contains("effect=pattern8x8"));
    }

    #[test]
    fn canvaskit_replay_plan_reports_external_image_missing_and_injected_data() {
        let missing_tree = PageLayerTree::builder(
            100.0,
            100.0,
            LayerNode::leaf(
                valid_bbox(),
                None,
                vec![PaintOp::Image {
                    bbox: valid_bbox(),
                    image: LayerImagePaint {
                        resource_id: None,
                        external_path: Some("C:\\samples\\linked.gif".to_string()),
                        text_wrap: None,
                        fill_mode: None,
                        original_size: None,
                        crop: None,
                        brightness: 0,
                        contrast: 0,
                        effect: ImageEffect::RealPic,
                        transform: ShapeTransform::default(),
                    },
                }],
            ),
        )
        .build();
        let missing_plan =
            analyze_canvaskit_replay_plan(&missing_tree, CanvasKitReplayMode::Default);
        let missing_item = missing_plan
            .items
            .iter()
            .find(|item| item.op_type == "image")
            .expect("missing external image item");
        assert_eq!(missing_item.status, CanvasKitReplayStatus::DirectRequired);
        let detail = missing_item.detail.as_deref().expect("image detail");
        assert!(detail.contains("externalImage"));
        assert!(detail.contains("missingImageData"));

        let dangling_id_tree = PageLayerTree::builder(
            100.0,
            100.0,
            LayerNode::leaf(
                valid_bbox(),
                None,
                vec![PaintOp::Image {
                    bbox: valid_bbox(),
                    image: LayerImagePaint {
                        resource_id: Some(ImageResourceId(3)),
                        external_path: Some("/tmp/linked.gif".to_string()),
                        text_wrap: None,
                        fill_mode: None,
                        original_size: None,
                        crop: None,
                        brightness: 0,
                        contrast: 0,
                        effect: ImageEffect::RealPic,
                        transform: ShapeTransform::default(),
                    },
                }],
            ),
        )
        .build();
        let dangling_plan =
            analyze_canvaskit_replay_plan(&dangling_id_tree, CanvasKitReplayMode::Default);
        let dangling_item = dangling_plan
            .items
            .iter()
            .find(|item| item.op_type == "image")
            .expect("dangling image resource item");
        assert_eq!(dangling_item.status, CanvasKitReplayStatus::DirectRequired);
        let detail = dangling_item.detail.as_deref().expect("image detail");
        assert!(detail.contains("externalImage"));
        assert!(detail.contains("missingImageData"));

        let mut resources = ResourceArena::default();
        let image_id = resources.intern_image_bytes(&[137, 80, 78, 71]);
        let injected_tree = PageLayerTree::builder(
            100.0,
            100.0,
            LayerNode::leaf(
                valid_bbox(),
                None,
                vec![PaintOp::Image {
                    bbox: valid_bbox(),
                    image: LayerImagePaint {
                        resource_id: Some(image_id),
                        external_path: Some("/tmp/linked.gif".to_string()),
                        text_wrap: None,
                        fill_mode: None,
                        original_size: None,
                        crop: None,
                        brightness: 0,
                        contrast: 0,
                        effect: ImageEffect::RealPic,
                        transform: ShapeTransform::default(),
                    },
                }],
            ),
        )
        .resources(resources)
        .build();
        let injected_plan =
            analyze_canvaskit_replay_plan(&injected_tree, CanvasKitReplayMode::Default);
        let injected_item = injected_plan
            .items
            .iter()
            .find(|item| item.op_type == "image")
            .expect("injected external image item");
        assert_eq!(injected_item.status, CanvasKitReplayStatus::Direct);
        let detail = injected_item.detail.as_deref().expect("image detail");
        assert!(detail.contains("externalImage"));
        assert!(detail.contains("injectedImageData"));
    }

    #[test]
    fn canvaskit_replay_plan_sees_raw_svg_data_image_as_resource_image() {
        let bbox = BoundingBox::new(10.0, 20.0, 120.0, 40.0);
        let mut render_tree = PageRenderTree::new(0, 200.0, 120.0);
        render_tree.root.children.push(RenderNode::new(
            1,
            RenderNodeType::RawSvg(RawSvgNode {
                svg: r#"<image x="10" y="20" width="120" height="40" href="data:image/png;base64,iVBORw0KGgo="/>"#.to_string(),
            }),
            bbox,
        ));

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&render_tree);
        assert_eq!(layer_tree.resources.image_count(), 1);
        assert_eq!(layer_tree.resources.svg_count(), 0);

        let plan = analyze_canvaskit_replay_plan(&layer_tree, CanvasKitReplayMode::Default);
        let image_item = plan
            .items
            .iter()
            .find(|item| item.op_type == "image")
            .expect("RawSvg data image should lower to an image replay item");
        assert_eq!(image_item.status, CanvasKitReplayStatus::Direct);
        assert_eq!(
            image_item.reason,
            super::CanvasKitReplayReason::DirectReplaySupported
        );
        assert!(
            image_item
                .detail
                .as_deref()
                .is_some_and(|detail| detail.contains("injectedImageData")
                    && !detail.contains("missingImageData")),
            "CanvasKit plan should report replayable image data detail: {image_item:?}"
        );
    }

    #[test]
    fn canvaskit_rejects_incomplete_color_layers_payload() {
        let mut outline = outline(GlyphOutlinePayloadKind::ColorLayers);
        outline.color_layers = Some(ColorLayersPayload {
            color_format: ColorGlyphFormat::ColrV1,
            source_font_ref: Some(source_font_ref(ColorGlyphFormat::ColrV1)),
            palette_ref: None,
            layers: Vec::new(),
            paint_graph: None,
            source_range_utf8: Some(TextSourceRange::new(0, 1)),
            glyph_range: Some(GlyphRange::new(0, 1)),
        });

        assert_eq!(
            canvaskit_glyph_outline_payload_status(
                &outline,
                Some(valid_bbox()),
                &ResourceArena::default(),
            ),
            (false, Some(VariantRejectReason::UnsupportedColorGlyph))
        );
    }

    #[test]
    fn canvaskit_accepts_colrv0_resolved_layer_contract() {
        let mut outline = outline(GlyphOutlinePayloadKind::ColorLayers);
        outline.color_layers = Some(colrv0_payload());

        assert_eq!(
            canvaskit_glyph_outline_payload_status(
                &outline,
                Some(valid_bbox()),
                &ResourceArena::default(),
            ),
            (true, None)
        );
    }

    #[test]
    fn canvaskit_rejects_malformed_colrv0_resolved_layer_contract() {
        let assert_rejected = |payload: ColorLayersPayload| {
            let mut outline = outline(GlyphOutlinePayloadKind::ColorLayers);
            outline.color_layers = Some(payload);

            assert_eq!(
                canvaskit_glyph_outline_payload_status(
                    &outline,
                    Some(valid_bbox()),
                    &ResourceArena::default(),
                ),
                (false, Some(VariantRejectReason::UnsupportedColorGlyph))
            );
        };

        let mut missing_source_font_ref = colrv0_payload();
        missing_source_font_ref.source_font_ref = None;
        assert_rejected(missing_source_font_ref);

        let mut missing_source_range = colrv0_payload();
        missing_source_range.source_range_utf8 = None;
        assert_rejected(missing_source_range);

        let mut empty_glyph_range = colrv0_payload();
        empty_glyph_range.glyph_range = Some(GlyphRange::new(2, 2));
        assert_rejected(empty_glyph_range);

        let mut graph_payload = colrv0_payload();
        graph_payload.paint_graph = Some(ColorPaintGraphPayload {
            root_node_id: 0,
            nodes: Vec::new(),
        });
        assert_rejected(graph_payload);

        let mut empty_layer_glyph_range = colrv0_payload();
        empty_layer_glyph_range.layers[0].glyph_range = Some(GlyphRange::new(2, 2));
        assert_rejected(empty_layer_glyph_range);
    }

    #[test]
    fn canvaskit_accepts_default_face_without_variation_as_proof_control() {
        let mut resources = ResourceArena::default();
        let face_key = add_portable_test_font(&mut resources, 0);
        let run = glyph_run(face_key, Vec::new());
        let status = canvaskit_glyph_run_replay_status(&run, &resources);

        assert!(status.replayable);
        assert_eq!(status.reason, None);
        assert!(
            status.font_verification.is_none(),
            "the current positive control proves the default face/no-variation gate only; exact variation/TTC diagnostics remain on rejection paths"
        );
    }

    #[test]
    fn canvaskit_accepts_simple_glyph_run_shadow_and_outline_effects() {
        let mut resources = ResourceArena::default();
        let face_key = add_portable_test_font(&mut resources, 0);
        let mut shadow = glyph_run(face_key.clone(), Vec::new());
        shadow.paint_style.shadow_type = 1;
        shadow.paint_style.shadow_offset_x = 4.0;
        shadow.paint_style.shadow_offset_y = 2.0;
        let mut outline = glyph_run(face_key, Vec::new());
        outline.paint_style.outline_type = 1;

        for (case_name, run) in [("shadow", shadow), ("outline", outline)] {
            let status = canvaskit_glyph_run_replay_status(&run, &resources);
            assert!(status.replayable, "{case_name}: {status:?}");
            assert_eq!(status.reason, None, "{case_name}");
        }
    }

    #[test]
    fn canvaskit_accepts_position_adjusted_glyph_run_within_residual_tolerance() {
        let mut resources = ResourceArena::default();
        let face_key = add_portable_test_font(&mut resources, 0);
        let mut run = glyph_run(face_key, Vec::new());
        run.diagnostics.quality = TextVariantQuality::PositionAdjusted;
        run.diagnostics.max_residual_after_adjustment_px = 0.001;

        let status = canvaskit_glyph_run_replay_status(&run, &resources);

        assert!(status.replayable);
        assert_eq!(status.reason, None);
        assert!(status.font_verification.is_none());
    }

    #[test]
    fn canvaskit_rejects_variation_instances_until_exact_construction_is_proven() {
        let mut resources = ResourceArena::default();
        let face_key = add_portable_test_font(&mut resources, 0);
        let cases = [
            (
                "supported-axis-instance",
                vec![VariationAxisValue {
                    tag: "wght".to_string(),
                    value: 700.0,
                }],
            ),
            (
                "unsupported-axis",
                vec![VariationAxisValue {
                    tag: "XXXX".to_string(),
                    value: 1.0,
                }],
            ),
            (
                "out-of-range-axis",
                vec![VariationAxisValue {
                    tag: "wght".to_string(),
                    value: 10_000.0,
                }],
            ),
            (
                "different-axis-tuple",
                vec![
                    VariationAxisValue {
                        tag: "wdth".to_string(),
                        value: 75.0,
                    },
                    VariationAxisValue {
                        tag: "wght".to_string(),
                        value: 700.0,
                    },
                ],
            ),
            (
                "explicit-default-axis",
                vec![VariationAxisValue {
                    tag: "wght".to_string(),
                    value: 400.0,
                }],
            ),
        ];

        for (case_name, variations) in cases {
            let run = glyph_run(face_key.clone(), variations);
            let status = canvaskit_glyph_run_replay_status(&run, &resources);

            assert!(!status.replayable, "{case_name}");
            assert_eq!(
                status.reason,
                Some(VariantRejectReason::VariationUnsupported),
                "{case_name}"
            );
            let font_report = status
                .font_verification
                .expect("variation rejection should carry font verification");
            assert_eq!(
                font_report.reason,
                Some(VariantRejectReason::VariationUnsupported),
                "{case_name}"
            );
            assert_eq!(font_report.variation_supported, Some(false), "{case_name}");
            assert!(!font_report.replay_eligible, "{case_name}");
        }
    }

    #[test]
    fn canvaskit_rejects_nonzero_face_index_until_exact_construction_is_proven() {
        let cases = [
            ("wrong-face-index", 1, false),
            ("high-face-index", 7, false),
            ("ambiguous-metadata-face-index", 2, true),
        ];

        for (case_name, face_index, ambiguous_metadata) in cases {
            let mut resources = ResourceArena::default();
            let face_key = add_portable_test_font(&mut resources, face_index);
            if ambiguous_metadata {
                resources.font_resources_mut().faces[0].postscript_name = None;
                resources.font_resources_mut().faces[0].family_names = vec![
                    LocalizedName {
                        locale: None,
                        value: "TestFace".to_string(),
                    },
                    LocalizedName {
                        locale: Some("ko-KR".to_string()),
                        value: "TestFace".to_string(),
                    },
                ];
            }
            let run = glyph_run(face_key, Vec::new());
            let status = canvaskit_glyph_run_replay_status(&run, &resources);

            assert!(!status.replayable, "{case_name}");
            assert_eq!(
                status.reason,
                Some(VariantRejectReason::FaceIndexUnsupported),
                "{case_name}"
            );
            let font_report = status
                .font_verification
                .expect("face-index rejection should carry font verification");
            assert_eq!(
                font_report.reason,
                Some(VariantRejectReason::FaceIndexUnsupported),
                "{case_name}"
            );
            assert_eq!(
                font_report.blob_key.as_deref(),
                Some("test-blob"),
                "{case_name}"
            );
            assert_eq!(font_report.blob_resolved, Some(true), "{case_name}");
            assert_eq!(
                font_report.exact_face_instantiated,
                Some(false),
                "{case_name}"
            );
            assert_eq!(font_report.face_index_supported, Some(false), "{case_name}");
            assert!(!font_report.replay_eligible, "{case_name}");
        }
    }

    #[test]
    fn canvaskit_rejects_out_of_range_glyph_ids_before_replay() {
        let mut resources = ResourceArena::default();
        let face_key = add_portable_test_font(&mut resources, 0);
        let mut run = glyph_run(face_key, Vec::new());
        run.glyph_ids[0] = u32::from(u16::MAX) + 1;

        let status = canvaskit_glyph_run_replay_status(&run, &resources);

        assert!(!status.replayable);
        assert_eq!(status.reason, Some(VariantRejectReason::GlyphIdOutOfRange));
        assert!(
            status.font_verification.is_none(),
            "the glyph id range guard should reject before backend font construction"
        );
    }

    #[test]
    fn canvaskit_rejects_malformed_glyph_run_geometry_before_replay() {
        let mut resources = ResourceArena::default();
        let face_key = add_portable_test_font(&mut resources, 0);
        let mut empty_glyphs = glyph_run(face_key.clone(), Vec::new());
        empty_glyphs.glyph_ids.clear();
        let mut mismatched_positions = glyph_run(face_key.clone(), Vec::new());
        mismatched_positions.positions.clear();
        let mut mismatched_advances = glyph_run(face_key.clone(), Vec::new());
        mismatched_advances.advances = Some(vec![
            LayerVector { dx: 1.0, dy: 0.0 },
            LayerVector { dx: 2.0, dy: 0.0 },
        ]);
        let mut nonfinite_transform = glyph_run(face_key.clone(), Vec::new());
        nonfinite_transform.placement.run_to_page.a = f64::NAN;
        let mut nonfinite_baseline = glyph_run(face_key.clone(), Vec::new());
        nonfinite_baseline.placement.baseline_y = f64::INFINITY;
        let mut nonfinite_position = glyph_run(face_key, Vec::new());
        nonfinite_position.positions[0].x = f64::NEG_INFINITY;

        for (case_name, run) in [
            ("empty-glyphs", empty_glyphs),
            ("mismatched-positions", mismatched_positions),
            ("mismatched-advances", mismatched_advances),
            ("nonfinite-transform", nonfinite_transform),
            ("nonfinite-baseline", nonfinite_baseline),
            ("nonfinite-position", nonfinite_position),
        ] {
            let status = canvaskit_glyph_run_replay_status(&run, &resources);

            assert!(!status.replayable, "{case_name}");
            assert_eq!(
                status.reason,
                Some(VariantRejectReason::VariantUnsupported),
                "{case_name}"
            );
            assert!(
                status.font_verification.is_none(),
                "malformed geometry should not look like a font verification failure for {case_name}"
            );
        }
    }

    #[test]
    fn canvaskit_rejects_glyph_run_diagnostic_gate_failures() {
        let mut resources = ResourceArena::default();
        let face_key = add_portable_test_font(&mut resources, 0);
        let mut nonportable = glyph_run(face_key.clone(), Vec::new());
        nonportable.diagnostics.replay_eligibility = GlyphRunReplayEligibility::NotReplayable;
        let mut not_strict_visual = glyph_run(face_key.clone(), Vec::new());
        not_strict_visual.diagnostics.strict_visual_eligible = false;
        let mut missing_glyph = glyph_run(face_key.clone(), Vec::new());
        missing_glyph.diagnostics.missing_glyph_count = 1;
        let mut cluster_mismatch = glyph_run(face_key.clone(), Vec::new());
        cluster_mismatch.diagnostics.cluster_mismatch_count = 1;
        let mut approximate_quality = glyph_run(face_key.clone(), Vec::new());
        approximate_quality.diagnostics.quality = TextVariantQuality::Approximate;
        let mut residual_too_large = glyph_run(face_key.clone(), Vec::new());
        residual_too_large.diagnostics.quality = TextVariantQuality::PositionAdjusted;
        residual_too_large
            .diagnostics
            .max_residual_after_adjustment_px = 10.0;
        let mut unsupported_paint = glyph_run(face_key, Vec::new());
        unsupported_paint.paint_style.shadow_type = 1;
        unsupported_paint.paint_style.shadow_offset_x = f64::INFINITY;

        for (case_name, run, reason) in [
            (
                "nonportable",
                nonportable,
                VariantRejectReason::FontNotPortable,
            ),
            (
                "not-strict-visual",
                not_strict_visual,
                VariantRejectReason::VariantUnsupported,
            ),
            (
                "missing-glyph",
                missing_glyph,
                VariantRejectReason::MissingGlyph,
            ),
            (
                "cluster-mismatch",
                cluster_mismatch,
                VariantRejectReason::ClusterMismatch,
            ),
            (
                "approximate-quality",
                approximate_quality,
                VariantRejectReason::VariantUnsupported,
            ),
            (
                "residual-too-large",
                residual_too_large,
                VariantRejectReason::PositionAdjustedResidualTooLarge,
            ),
            (
                "unsupported-paint",
                unsupported_paint,
                VariantRejectReason::UnsupportedPaintEffect,
            ),
        ] {
            let status = canvaskit_glyph_run_replay_status(&run, &resources);

            assert!(!status.replayable, "{case_name}");
            assert_eq!(status.reason, Some(reason), "{case_name}");
            assert!(
                status.font_verification.is_none(),
                "diagnostic gate failure should not look like a font verification failure for {case_name}"
            );
        }
    }

    #[test]
    fn canvaskit_rejects_mixed_per_glyph_and_glyph_transforms_until_writer_gate() {
        let mut resources = ResourceArena::default();
        let face_key = add_portable_test_font(&mut resources, 0);
        let mut mixed_orientation = glyph_run(face_key.clone(), Vec::new());
        mixed_orientation.orientation = GlyphRunOrientation::MixedPerGlyph;
        let mut transformed_glyphs = glyph_run(face_key, Vec::new());
        transformed_glyphs.glyph_transforms = Some(vec![GlyphTransform {
            xx: 1.0,
            xy: 0.0,
            yx: 0.0,
            yy: 1.0,
            tx: 3.0,
            ty: 4.0,
        }]);

        for (case_name, run) in [
            ("mixed-per-glyph-orientation", mixed_orientation),
            ("glyph-transform-run", transformed_glyphs),
        ] {
            let status = canvaskit_glyph_run_replay_status(&run, &resources);

            assert!(!status.replayable, "{case_name}");
            assert_eq!(
                status.reason,
                Some(VariantRejectReason::VariantUnsupported),
                "{case_name}"
            );
            assert!(
                status.font_verification.is_none(),
                "pre-font writer-gated transform policy should not look like a font verification failure for {case_name}"
            );
        }
    }

    #[test]
    fn canvaskit_accepts_colrv1_stage1_color_graph_contract() {
        let mut outline = outline(GlyphOutlinePayloadKind::ColorLayers);
        outline.color_layers = Some(colrv1_stage1_payload());

        assert_eq!(
            canvaskit_glyph_outline_payload_status(
                &outline,
                Some(valid_bbox()),
                &ResourceArena::default(),
            ),
            (true, None)
        );
    }

    #[test]
    fn canvaskit_accepts_colrv1_supported_gradient_graph_contract() {
        let mut outline = outline(GlyphOutlinePayloadKind::ColorLayers);
        outline.color_layers = Some(colrv1_linear_gradient_payload());

        assert_eq!(
            canvaskit_glyph_outline_payload_status(
                &outline,
                Some(valid_bbox()),
                &ResourceArena::default(),
            ),
            (true, None)
        );
    }

    #[test]
    fn canvaskit_rejects_colrv1_unordered_gradient_stops() {
        let source_range = TextSourceRange::new(0, 1);
        let glyph_range = GlyphRange::new(0, 1);
        let source_font_ref = source_font_ref(ColorGlyphFormat::ColrV1);
        let mut outline = outline(GlyphOutlinePayloadKind::ColorLayers);
        outline.color_layers = Some(ColorLayersPayload {
            color_format: ColorGlyphFormat::ColrV1,
            source_font_ref: Some(source_font_ref.clone()),
            palette_ref: None,
            layers: Vec::new(),
            paint_graph: Some(ColorPaintGraphPayload {
                root_node_id: 0,
                nodes: vec![ColorPaintGraphNode {
                    node_id: 0,
                    kind: ColorPaintGraphNodeKind::LinearGradientPath,
                    solid_path: None,
                    linear_gradient_path: Some(ColorPaintLinearGradientPathNode {
                        commands: vec![
                            PathCommand::MoveTo(0.0, 0.0),
                            PathCommand::LineTo(12.0, 0.0),
                            PathCommand::LineTo(12.0, 12.0),
                            PathCommand::ClosePath,
                        ],
                        gradient: ColorLinearGradient {
                            x0: 0.0,
                            y0: 0.0,
                            x1: 12.0,
                            y1: 0.0,
                            stops: vec![
                                ColorGradientStop {
                                    offset: 0.75,
                                    color: ResolvedColor {
                                        color_space: Some("srgb".to_string()),
                                        rgba: [1.0, 0.0, 0.0, 1.0],
                                    },
                                },
                                ColorGradientStop {
                                    offset: 0.5,
                                    color: ResolvedColor {
                                        color_space: Some("srgb".to_string()),
                                        rgba: [0.0, 0.0, 1.0, 1.0],
                                    },
                                },
                            ],
                        },
                        fill_rule: GlyphOutlineFillRule::NonZero,
                        source_glyph_id: Some(42),
                        palette_index: Some(0),
                    }),
                    radial_gradient_path: None,
                    sweep_gradient_path: None,
                    transform: None,
                    composite: None,
                    clip: None,
                    source_range_utf8: Some(source_range),
                    glyph_range: Some(glyph_range),
                    source_font_ref: Some(source_font_ref),
                }],
            }),
            source_range_utf8: Some(source_range),
            glyph_range: Some(glyph_range),
        });

        assert_eq!(
            canvaskit_glyph_outline_payload_status(
                &outline,
                Some(valid_bbox()),
                &ResourceArena::default(),
            ),
            (false, Some(VariantRejectReason::UnsupportedColorGlyph))
        );
    }

    #[test]
    fn canvaskit_rejects_colrv1_malformed_stage1_graphs() {
        let assert_rejected = |payload: ColorLayersPayload| {
            let mut outline = outline(GlyphOutlinePayloadKind::ColorLayers);
            outline.color_layers = Some(payload);

            assert_eq!(
                canvaskit_glyph_outline_payload_status(
                    &outline,
                    Some(valid_bbox()),
                    &ResourceArena::default(),
                ),
                (false, Some(VariantRejectReason::UnsupportedColorGlyph))
            );
        };

        let mut missing_leaf_metadata = colrv1_stage1_payload();
        missing_leaf_metadata.paint_graph.as_mut().unwrap().nodes[0].source_range_utf8 = None;
        assert_rejected(missing_leaf_metadata);

        let mut invalid_transform = colrv1_stage1_payload();
        invalid_transform.paint_graph.as_mut().unwrap().nodes[1]
            .transform
            .as_mut()
            .unwrap()
            .transform
            .a = f64::NAN;
        assert_rejected(invalid_transform);

        let mut graph_with_unreachable_node = colrv1_stage1_payload();
        graph_with_unreachable_node
            .paint_graph
            .as_mut()
            .unwrap()
            .nodes
            .push(ColorPaintGraphNode {
                node_id: 2,
                kind: ColorPaintGraphNodeKind::SolidPath,
                solid_path: Some(ColorPaintSolidPathNode {
                    commands: vec![PathCommand::MoveTo(20.0, 20.0)],
                    fill: ResolvedColor {
                        color_space: Some("srgb".to_string()),
                        rgba: [1.0, 0.0, 0.0, 1.0],
                    },
                    fill_rule: GlyphOutlineFillRule::NonZero,
                    source_glyph_id: Some(43),
                    palette_index: Some(1),
                }),
                linear_gradient_path: None,
                radial_gradient_path: None,
                sweep_gradient_path: None,
                transform: None,
                composite: None,
                clip: None,
                source_range_utf8: Some(TextSourceRange::new(0, 1)),
                glyph_range: Some(GlyphRange::new(0, 1)),
                source_font_ref: Some(source_font_ref(ColorGlyphFormat::ColrV1)),
            });
        assert_rejected(graph_with_unreachable_node);

        let mut cyclic_graph = colrv1_stage1_payload();
        cyclic_graph.paint_graph.as_mut().unwrap().nodes[0].kind =
            ColorPaintGraphNodeKind::Transform;
        cyclic_graph.paint_graph.as_mut().unwrap().nodes[0].solid_path = None;
        cyclic_graph.paint_graph.as_mut().unwrap().nodes[0].transform =
            Some(ColorPaintTransformNode {
                child_node_id: 1,
                transform: identity(),
            });
        assert_rejected(cyclic_graph);
    }

    #[test]
    fn canvaskit_rejects_mixed_glyph_outline_payload_families() {
        let mut resources = ResourceArena::default();
        let image_id = resources.intern_image_bytes(&[0, 1, 2, 3]);
        let svg_id = resources
            .intern_svg_fragment("<path d=\"M0 0 L16 0 L16 16 L0 16 Z\" fill=\"#00ffff\"/>");

        let mut monochrome = outline(GlyphOutlinePayloadKind::MonochromeFill);
        monochrome.paths.push(outline_path());
        monochrome.color_layers = Some(colrv1_stage1_payload());
        assert_eq!(
            canvaskit_glyph_outline_payload_status(
                &monochrome,
                Some(valid_bbox()),
                &ResourceArena::default(),
            ),
            (false, Some(VariantRejectReason::MixedGlyphOutlinePayload))
        );

        let mut color = outline(GlyphOutlinePayloadKind::ColorLayers);
        color.color_layers = Some(colrv1_stage1_payload());
        color.bitmap_glyph = Some(bitmap_payload(image_id));
        assert_eq!(
            canvaskit_glyph_outline_payload_status(&color, Some(valid_bbox()), &resources),
            (false, Some(VariantRejectReason::MixedGlyphOutlinePayload))
        );

        let mut bitmap = outline(GlyphOutlinePayloadKind::BitmapGlyph);
        bitmap.bitmap_glyph = Some(bitmap_payload(image_id));
        bitmap.svg_glyph = Some(svg_payload(svg_id));
        assert_eq!(
            canvaskit_glyph_outline_payload_status(&bitmap, Some(valid_bbox()), &resources),
            (false, Some(VariantRejectReason::MixedGlyphOutlinePayload))
        );

        let mut svg = outline(GlyphOutlinePayloadKind::SvgGlyph);
        svg.svg_glyph = Some(svg_payload(svg_id));
        svg.bitmap_glyph = Some(bitmap_payload(image_id));
        assert_eq!(
            canvaskit_glyph_outline_payload_status(&svg, Some(valid_bbox()), &resources),
            (false, Some(VariantRejectReason::MixedGlyphOutlinePayload))
        );
    }

    #[test]
    fn canvaskit_requires_bitmap_strict_visual_contract() {
        let mut resources = ResourceArena::default();
        let image_id = resources.intern_image_bytes(&[0, 1, 2, 3]);
        let mut outline = outline(GlyphOutlinePayloadKind::BitmapGlyph);
        let mut payload = bitmap_payload(image_id);
        payload.filtering = Some(BitmapGlyphFiltering::BackendDefault);
        outline.bitmap_glyph = Some(payload);

        assert_eq!(
            canvaskit_glyph_outline_payload_status(&outline, Some(valid_bbox()), &resources),
            (false, Some(VariantRejectReason::UnsupportedBitmapGlyph))
        );

        let mut payload = bitmap_payload(image_id);
        payload.scaling_policy = Some(BitmapGlyphScalingPolicy::BackendDefault);
        outline.bitmap_glyph = Some(payload);
        assert_eq!(
            canvaskit_glyph_outline_payload_status(&outline, Some(valid_bbox()), &resources),
            (false, Some(VariantRejectReason::UnsupportedBitmapGlyph))
        );

        let mut payload = bitmap_payload(image_id);
        payload.strike_selection = Some(BitmapStrikeSelection::DiagnosticOnly);
        outline.bitmap_glyph = Some(payload);
        assert_eq!(
            canvaskit_glyph_outline_payload_status(&outline, Some(valid_bbox()), &resources),
            (false, Some(VariantRejectReason::UnsupportedBitmapGlyph))
        );

        let mut payload = bitmap_payload(image_id);
        payload.alpha_mode = None;
        outline.bitmap_glyph = Some(payload);
        assert_eq!(
            canvaskit_glyph_outline_payload_status(&outline, Some(valid_bbox()), &resources),
            (false, Some(VariantRejectReason::UnsupportedBitmapGlyph))
        );

        let mut payload = bitmap_payload(image_id);
        payload.color_space = Some(String::new());
        outline.bitmap_glyph = Some(payload);
        assert_eq!(
            canvaskit_glyph_outline_payload_status(&outline, Some(valid_bbox()), &resources),
            (false, Some(VariantRejectReason::UnsupportedBitmapGlyph))
        );

        outline.bitmap_glyph = Some(bitmap_payload(image_id));
        assert_eq!(
            canvaskit_glyph_outline_payload_status(&outline, Some(valid_bbox()), &resources),
            (true, None)
        );
    }

    #[test]
    fn canvaskit_rejects_bitmap_payload_without_resource_or_replayable_bbox() {
        let mut outline = outline(GlyphOutlinePayloadKind::BitmapGlyph);
        outline.bitmap_glyph = Some(bitmap_payload(crate::paint::ImageResourceId(999)));

        assert_eq!(
            canvaskit_glyph_outline_payload_status(
                &outline,
                Some(valid_bbox()),
                &ResourceArena::default(),
            ),
            (false, Some(VariantRejectReason::UnsupportedBitmapGlyph))
        );

        let mut resources = ResourceArena::default();
        let image_id = resources.intern_image_bytes(&[0, 1, 2, 3]);
        outline.bitmap_glyph = Some(bitmap_payload(image_id));
        assert_eq!(
            canvaskit_glyph_outline_payload_status(
                &outline,
                Some(BoundingBox::new(0.0, 0.0, 0.0, 16.0)),
                &resources,
            ),
            (false, Some(VariantRejectReason::UnsupportedBitmapGlyph))
        );
        assert_eq!(
            canvaskit_glyph_outline_payload_status(&outline, None, &resources),
            (false, Some(VariantRejectReason::UnsupportedBitmapGlyph))
        );
    }

    #[test]
    fn canvaskit_requires_svg_static_sanitized_contract() {
        let mut resources = ResourceArena::default();
        let empty_svg_id = resources.intern_svg_fragment("<svg viewBox=\"0 0 16 16\"></svg>");
        let path_svg_id = resources
            .intern_svg_fragment("<path d=\"M0 0 L16 0 L16 16 L0 16 Z\" fill=\"#00ffff\"/>");
        let mut outline = outline(GlyphOutlinePayloadKind::SvgGlyph);
        let mut payload = svg_payload(path_svg_id);
        payload.script_allowed = true;
        outline.svg_glyph = Some(payload);

        assert_eq!(
            canvaskit_glyph_outline_payload_status(&outline, Some(valid_bbox()), &resources),
            (false, Some(VariantRejectReason::UnsupportedSvgGlyph))
        );

        let mut payload = svg_payload(path_svg_id);
        payload.animation_allowed = true;
        outline.svg_glyph = Some(payload);
        assert_eq!(
            canvaskit_glyph_outline_payload_status(&outline, Some(valid_bbox()), &resources),
            (false, Some(VariantRejectReason::UnsupportedSvgGlyph))
        );

        let mut payload = svg_payload(path_svg_id);
        payload.external_resources_allowed = true;
        outline.svg_glyph = Some(payload);
        assert_eq!(
            canvaskit_glyph_outline_payload_status(&outline, Some(valid_bbox()), &resources),
            (false, Some(VariantRejectReason::UnsupportedSvgGlyph))
        );

        let mut payload = svg_payload(path_svg_id);
        payload.interactivity_allowed = true;
        outline.svg_glyph = Some(payload);
        assert_eq!(
            canvaskit_glyph_outline_payload_status(&outline, Some(valid_bbox()), &resources),
            (false, Some(VariantRejectReason::UnsupportedSvgGlyph))
        );

        let mut payload = svg_payload(path_svg_id);
        payload.view_box = None;
        outline.svg_glyph = Some(payload);
        assert_eq!(
            canvaskit_glyph_outline_payload_status(&outline, Some(valid_bbox()), &resources),
            (false, Some(VariantRejectReason::UnsupportedSvgGlyph))
        );

        outline.svg_glyph = Some(svg_payload(empty_svg_id));
        assert_eq!(
            canvaskit_glyph_outline_payload_status(&outline, Some(valid_bbox()), &resources),
            (false, Some(VariantRejectReason::UnsupportedSvgGlyph))
        );

        outline.svg_glyph = Some(svg_payload(path_svg_id));
        assert_eq!(
            canvaskit_glyph_outline_payload_status(&outline, Some(valid_bbox()), &resources),
            (true, None)
        );
    }

    #[test]
    fn canvaskit_rejects_svg_payload_without_resource_or_replayable_bbox() {
        let mut outline = outline(GlyphOutlinePayloadKind::SvgGlyph);
        outline.svg_glyph = Some(svg_payload(crate::paint::SvgResourceId(999)));

        assert_eq!(
            canvaskit_glyph_outline_payload_status(
                &outline,
                Some(valid_bbox()),
                &ResourceArena::default(),
            ),
            (false, Some(VariantRejectReason::UnsupportedSvgGlyph))
        );

        let mut resources = ResourceArena::default();
        let path_svg_id = resources
            .intern_svg_fragment("<path d=\"M0 0 L16 0 L16 16 L0 16 Z\" fill=\"#00ffff\"/>");
        outline.svg_glyph = Some(svg_payload(path_svg_id));
        assert_eq!(
            canvaskit_glyph_outline_payload_status(
                &outline,
                Some(BoundingBox::new(0.0, 0.0, 16.0, 0.0)),
                &resources,
            ),
            (false, Some(VariantRejectReason::UnsupportedSvgGlyph))
        );
        assert_eq!(
            canvaskit_glyph_outline_payload_status(&outline, None, &resources),
            (false, Some(VariantRejectReason::UnsupportedSvgGlyph))
        );
    }

    #[test]
    fn canvaskit_rejects_svg_fragments_without_static_path_layers() {
        assert!(canvaskit_static_svg_fragment_has_path_layer(
            "<!-- ok --><rect x=\"0\" y=\"0\" width=\"16\" height=\"16\"/>"
        ));
        assert!(canvaskit_static_svg_fragment_has_path_layer(
            "<g><circle cx=\"8\" cy=\"8\" r=\"4\"/></g>"
        ));
        assert!(!canvaskit_static_svg_fragment_has_path_layer(
            "<svg viewBox=\"0 0 16 16\"><defs><path d=\"M0 0 L1 1\"/></defs></svg>"
        ));
        assert!(!canvaskit_static_svg_fragment_has_path_layer(
            "<script>alert(1)</script><path d=\"M0 0 L1 1\"/>"
        ));
        assert!(!canvaskit_static_svg_fragment_has_path_layer(
            "<rect x=\"0\" y=\"0\" width=\"0\" height=\"16\"/>"
        ));
    }
}
