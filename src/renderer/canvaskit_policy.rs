use std::collections::HashMap;
use std::fmt::Write;

use crate::model::style::UnderlineType;
use crate::paint::{
    CacheHint, ClipKind, GlyphOutlinePayloadKind, GlyphRunOrientation, GlyphRunReplayEligibility,
    LayerGlyphOutlinePaint, LayerGlyphRunPaint, LayerNode, LayerNodeKind, PageLayerTree, PaintOp,
    ResourceArena, TextVariantKind, TextVariantQuality,
};
use crate::renderer::layer_renderer::{
    select_text_variant_sets_with_report, VariantRejectReason, VariantReplayStatus,
    VariantSelectedReason, VariantSelectionBackend, VariantSelectionContext,
    VariantSelectionReport,
};

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

    pub fn allows_canvas2d_overlay(self) -> bool {
        matches!(self, Self::Compat)
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Compat => "compat",
        }
    }
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
    pub rejected_variants: Vec<CanvasKitRejectedTextVariant>,
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
    tree: &'a PageLayerTree,
    summary: CanvasKitReplaySummary,
    items: Vec<CanvasKitReplayItem>,
    text_variants: Vec<CanvasKitTextVariantReport>,
}

impl<'a> CanvasKitReplayPlanBuilder<'a> {
    fn new(mode: CanvasKitReplayMode, tree: &'a PageLayerTree) -> Self {
        Self {
            mode,
            tree,
            summary: CanvasKitReplaySummary::default(),
            items: Vec::new(),
            text_variants: Vec::new(),
        }
    }

    fn finish(self) -> CanvasKitReplayPlan {
        CanvasKitReplayPlan {
            mode: self.mode,
            hidden_canvas2d_overlay_allowed: self.mode.allows_canvas2d_overlay(),
            direct_replay_required: matches!(self.mode, CanvasKitReplayMode::Default),
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
                    feature: CanvasKitReplayFeature::Clip,
                    status: CanvasKitReplayStatus::Direct,
                    reason: CanvasKitReplayReason::DirectReplaySupported,
                    compat_overlay_allowed: false,
                    detail: Some(clip_kind_detail(*clip_kind).to_string()),
                });
                self.visit_node(child, &format!("{path}/clip/child"));
            }
            LayerNodeKind::Leaf { ops, .. } => {
                let selection = select_text_variant_sets_with_report(
                    ops,
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
            }
        }
    }

    fn item_for_op(
        &self,
        op: &PaintOp,
        selected_variants: &HashMap<String, String>,
        path: String,
    ) -> CanvasKitReplayItem {
        match op {
            PaintOp::PageBackground { .. } => direct_item(
                path,
                "pageBackground",
                CanvasKitReplayFeature::PageBackground,
            ),
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
            PaintOp::Image { .. } => {
                direct_item(path, "image", CanvasKitReplayFeature::RasterImage)
            }
            PaintOp::Equation { .. } => {
                direct_item(path, "equation", CanvasKitReplayFeature::Equation)
            }
            PaintOp::FormObject { .. } => {
                direct_item(path, "formObject", CanvasKitReplayFeature::FormObject)
            }
        }
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
    if !run.paint_style.is_fill_only_glyph_replay() {
        return VariantReplayStatus::rejected(VariantRejectReason::UnsupportedPaintEffect);
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
            if outline.paths.is_empty() || outline.stroke.is_some() {
                (false, Some(VariantRejectReason::UnsupportedOutlinePayload))
            } else {
                (true, None)
            }
        }
        GlyphOutlinePayloadKind::MonochromeFillStroke => {
            if outline.paths.is_empty() || outline.stroke.is_none() {
                return (false, Some(VariantRejectReason::UnsupportedOutlinePayload));
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
                matches!(
                    payload.color_format,
                    crate::paint::ColorGlyphFormat::ColrV0 | crate::paint::ColorGlyphFormat::ColrV1
                )
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
                || payload.alpha_mode.is_none()
                || payload.scaling_policy.is_none()
                || payload.filtering.is_none()
                || payload
                    .filtering
                    .is_some_and(|filtering| filtering.as_str() == "backendDefault")
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
            if bbox.is_none_or(|bbox| !glyph_payload_bbox_is_replayable(bbox))
                || payload.view_box.is_none()
                || payload.script_allowed
                || payload.animation_allowed
                || payload.external_resources_allowed
                || payload.interactivity_allowed
                || resources.svg_fragment(payload.vector_resource_id).is_none()
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

fn direct_item(
    path: String,
    op_type: &'static str,
    feature: CanvasKitReplayFeature,
) -> CanvasKitReplayItem {
    CanvasKitReplayItem {
        path,
        op_type,
        feature,
        status: CanvasKitReplayStatus::Direct,
        reason: CanvasKitReplayReason::DirectReplaySupported,
        compat_overlay_allowed: false,
        detail: None,
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
