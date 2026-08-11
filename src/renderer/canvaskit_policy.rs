use std::collections::{BTreeSet, HashMap};
use std::fmt::{self, Write};

use crate::model::image::ImageEffect;
use crate::model::shape::TextWrap;
use crate::model::style::{ImageFillMode, UnderlineType};
use crate::paint::{
    paint_op_replay_plane, sidecars_for_leaf_ops, CacheHint, ClipKind, GlyphOutlinePayloadKind,
    GlyphRunOrientation, GlyphRunReplayEligibility, LayerGlyphOutlinePaint, LayerGlyphRunPaint,
    LayerNode, LayerNodeKind, LayerTextRunPaint, PageLayerTree, PaintOp, PaintReplayPlane,
    RenderProfile, ResourceArena, TextVariantKind, TextVariantQuality,
};
use crate::renderer::composer::expand_pua_display_text;
use crate::renderer::image_header::{canvaskit_encoded_image_header, CANVASKIT_MAX_SVG_BYTES};
use crate::renderer::layer_renderer::{
    select_text_variant_sets_with_report, VariantFontVerificationReport,
    VariantOutlineEligibilityReport, VariantRejectReason, VariantReplayStatus,
    VariantSelectedReason, VariantSelectionBackend, VariantSelectionContext,
    VariantSelectionReport,
};
use crate::renderer::render_tree::{PageRenderTree, RenderNodeType};
use crate::renderer::static_svg::static_svg_fragment_has_path_layer;

const CANVASKIT_OLD_HANGUL_FONT_FAMILY: &str = "Noto Sans KR ExtraLight";

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

    pub fn as_str(self) -> &'static str {
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
    pub render_profile: RenderProfile,
    pub hidden_canvas2d_overlay_allowed: bool,
    pub direct_replay_required: bool,
    pub summary: CanvasKitReplaySummary,
    pub items: Vec<CanvasKitReplayItem>,
    pub text_variants: Vec<CanvasKitTextVariantReport>,
    pub required_font_families: Vec<String>,
    pub required_font_families_complete: bool,
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

pub const CANVASKIT_DOCUMENT_PREFLIGHT_SCHEMA_VERSION: u32 = 1;
pub const CANVASKIT_DOCUMENT_PREFLIGHT_MAX_PAGES: u32 = 128;
pub const CANVASKIT_DOCUMENT_PREFLIGHT_MAX_WORK_UNITS: u32 = 50_000;
pub const CANVASKIT_DOCUMENT_PREFLIGHT_MAX_BLOCKERS: u32 = 32;
pub const CANVASKIT_DOCUMENT_PREFLIGHT_MAX_REQUIRED_FONT_FAMILIES: u32 = 256;

const CANVASKIT_DOCUMENT_PREFLIGHT_MAX_DETAIL_BYTES: usize = 256;
const CANVASKIT_DOCUMENT_PREFLIGHT_MAX_FONT_FAMILY_BYTES: usize = 256;
const CANVASKIT_DOCUMENT_PREFLIGHT_WORK_UNIT_BYTES: usize = 4 * 1024;
const CANVASKIT_DOCUMENT_PREFLIGHT_MAX_TREE_DEPTH: usize = 256;
const CANVASKIT_DOCUMENT_PREFLIGHT_PRELOWER_UNIT_BYTES: usize = 1024;
const CANVASKIT_DOCUMENT_PREFLIGHT_MAX_RENDER_TREE_DEPTH: usize = 128;
const CANVASKIT_DOCUMENT_PREFLIGHT_MAX_TEXT_BYTES: usize = 1024 * 1024;
const CANVASKIT_MAX_ENCODED_IMAGE_BASE64_BYTES: usize = 24 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CanvasKitDocumentPreflightLimits {
    pub max_pages: u32,
    pub max_work_units: u32,
    pub max_blockers: u32,
    pub max_required_font_families: u32,
}

impl CanvasKitDocumentPreflightLimits {
    pub const FIXED: Self = Self {
        max_pages: CANVASKIT_DOCUMENT_PREFLIGHT_MAX_PAGES,
        max_work_units: CANVASKIT_DOCUMENT_PREFLIGHT_MAX_WORK_UNITS,
        max_blockers: CANVASKIT_DOCUMENT_PREFLIGHT_MAX_BLOCKERS,
        max_required_font_families: CANVASKIT_DOCUMENT_PREFLIGHT_MAX_REQUIRED_FONT_FAMILIES,
    };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CanvasKitDocumentPreflightStatus {
    Eligible,
    Ineligible,
    Incomplete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CanvasKitDocumentPreflightBlockerCode {
    PageLimitExceeded,
    WorkLimitExceeded,
    PageBuildFailed,
    HiddenCanvas2dOverlayRequired,
    Unsupported,
    TextFallback,
    CompatOverlay,
}

impl CanvasKitDocumentPreflightBlockerCode {
    fn as_str(self) -> &'static str {
        match self {
            Self::PageLimitExceeded => "pageLimitExceeded",
            Self::WorkLimitExceeded => "workLimitExceeded",
            Self::PageBuildFailed => "pageBuildFailed",
            Self::HiddenCanvas2dOverlayRequired => "hiddenCanvas2dOverlayRequired",
            Self::Unsupported => "unsupported",
            Self::TextFallback => "textFallback",
            Self::CompatOverlay => "compatOverlay",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanvasKitDocumentPreflightBlocker {
    pub page_index: u32,
    pub code: CanvasKitDocumentPreflightBlockerCode,
    pub op_type: Option<&'static str>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanvasKitDocumentPreflight {
    pub schema_version: u32,
    pub mode: CanvasKitReplayMode,
    pub profile: &'static str,
    pub status: CanvasKitDocumentPreflightStatus,
    pub eligible: bool,
    pub complete: bool,
    pub page_count: u32,
    pub scanned_pages: u32,
    pub scanned_work_units: u32,
    pub limits: CanvasKitDocumentPreflightLimits,
    pub summary: CanvasKitReplaySummary,
    pub blockers: Vec<CanvasKitDocumentPreflightBlocker>,
    pub required_font_families: Vec<String>,
    pub capability_digest: String,
}

impl CanvasKitDocumentPreflight {
    pub fn to_json(&self) -> String {
        let mut out = String::new();
        let status = match self.status {
            CanvasKitDocumentPreflightStatus::Eligible => "eligible",
            CanvasKitDocumentPreflightStatus::Ineligible => "ineligible",
            CanvasKitDocumentPreflightStatus::Incomplete => "incomplete",
        };
        let _ = write!(out, "{{\"schemaVersion\":{},\"mode\":", self.schema_version);
        push_json_str(&mut out, self.mode.as_str());
        out.push_str(",\"profile\":");
        push_json_str(&mut out, self.profile);
        out.push_str(",\"status\":");
        push_json_str(&mut out, status);
        let _ = write!(
            out,
            ",\"eligible\":{},\"complete\":{},\"pageCount\":{},\"scannedPages\":{},\"scannedWorkUnits\":{},\"limits\":{{\"maxPages\":{},\"maxWorkUnits\":{},\"maxBlockers\":{},\"maxRequiredFontFamilies\":{}}},\"summary\":",
            bool_json(self.eligible),
            bool_json(self.complete),
            self.page_count,
            self.scanned_pages,
            self.scanned_work_units,
            self.limits.max_pages,
            self.limits.max_work_units,
            self.limits.max_blockers,
            self.limits.max_required_font_families,
        );
        self.summary.write_json(&mut out);
        out.push_str(",\"blockers\":[");
        for (index, blocker) in self.blockers.iter().enumerate() {
            if index != 0 {
                out.push(',');
            }
            let _ = write!(out, "{{\"pageIndex\":{},\"code\":", blocker.page_index);
            push_json_str(&mut out, blocker.code.as_str());
            if let Some(op_type) = blocker.op_type {
                out.push_str(",\"opType\":");
                push_json_str(&mut out, op_type);
            }
            if let Some(detail) = blocker.detail.as_deref() {
                out.push_str(",\"detail\":");
                push_json_str(&mut out, detail);
            }
            out.push('}');
        }
        out.push_str("],\"requiredFontFamilies\":[");
        for (index, font_family) in self.required_font_families.iter().enumerate() {
            if index != 0 {
                out.push(',');
            }
            push_json_str(&mut out, font_family);
        }
        out.push_str("],\"capabilityDigest\":");
        push_json_str(&mut out, &self.capability_digest);
        out.push('}');
        out
    }
}

#[derive(Debug, Clone)]
pub enum CanvasKitPreflightPageBuild {
    Complete {
        tree: Box<PageLayerTree>,
        prelower_work_units: u32,
    },
    WorkLimitExceeded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CanvasKitBoundedWorkCount {
    Complete(u32),
    Exceeded,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CanvasKitReplayItem {
    pub path: String,
    pub op_type: &'static str,
    pub replay_plane: Option<PaintReplayPlane>,
    pub feature: CanvasKitReplayFeature,
    pub status: CanvasKitReplayStatus,
    pub reason: CanvasKitReplayReason,
    pub runtime_conditions: Vec<CanvasKitReplayRuntimeCondition>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CanvasKitReplayStatus {
    Direct,
    DirectRequired,
    CompatOverlay,
    TextFallback,
    Unsupported,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CanvasKitReplayRuntimeCondition {
    CanvasKitEncodedImageDecode,
    CanvasKitImageEffectPreprocess,
    CanvasKitPatternImageConstruction,
    CanvasKitSvgPathConstruction,
    CanvasKitTypefaceConstruction,
    BrowserSvgImageDecode,
}

impl CanvasKitReplayRuntimeCondition {
    fn as_str(self) -> &'static str {
        match self {
            Self::CanvasKitEncodedImageDecode => "canvasKitEncodedImageDecode",
            Self::CanvasKitImageEffectPreprocess => "canvasKitImageEffectPreprocess",
            Self::CanvasKitPatternImageConstruction => "canvasKitPatternImageConstruction",
            Self::CanvasKitSvgPathConstruction => "canvasKitSvgPathConstruction",
            Self::CanvasKitTypefaceConstruction => "canvasKitTypefaceConstruction",
            Self::BrowserSvgImageDecode => "browserSvgImageDecode",
        }
    }
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

#[derive(Debug, Clone, PartialEq)]
pub struct CanvasKitTextVariantReport {
    pub backend: &'static str,
    pub render_profile: String,
    pub equivalence_group: String,
    pub selected_variant_id: String,
    pub selected_variant_kind: &'static str,
    pub selected_reason: &'static str,
    pub selected_runtime_conditions: Vec<CanvasKitReplayRuntimeCondition>,
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
    pub runtime_condition: Option<CanvasKitReplayRuntimeCondition>,
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
        out.push_str(",\"renderProfile\":");
        push_json_str(&mut out, self.render_profile.as_str());
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
        out.push_str("],\"requiredFontFamilies\":[");
        for (index, font_family) in self.required_font_families.iter().enumerate() {
            if index != 0 {
                out.push(',');
            }
            push_json_str(&mut out, font_family);
        }
        out.push_str("],\"requiredFontFamiliesComplete\":");
        out.push_str(bool_json(self.required_font_families_complete));
        out.push('}');
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
    fn add_runtime_condition(&mut self, condition: CanvasKitReplayRuntimeCondition) {
        if !self.runtime_conditions.contains(&condition) {
            self.runtime_conditions.push(condition);
        }
    }

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
        if let Some(runtime_condition) = self.runtime_conditions.first() {
            out.push_str(",\"runtimeCondition\":");
            push_json_str(out, runtime_condition.as_str());
        }
        if !self.runtime_conditions.is_empty() {
            out.push_str(",\"runtimeConditions\":[");
            for (index, runtime_condition) in self.runtime_conditions.iter().enumerate() {
                if index != 0 {
                    out.push(',');
                }
                push_json_str(out, runtime_condition.as_str());
            }
            out.push(']');
        }
        out.push_str(",\"compatOverlayAllowed\":");
        out.push_str(bool_json(self.compat_overlay_allowed));
        if let Some(detail) = &self.detail {
            out.push_str(",\"detail\":");
            push_json_str(out, detail);
        }
        out.push('}');
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
        out.push_str(",\"selectedRuntimeConditions\":[");
        for (index, runtime_condition) in self.selected_runtime_conditions.iter().enumerate() {
            if index != 0 {
                out.push(',');
            }
            push_json_str(out, runtime_condition.as_str());
        }
        out.push(']');
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
        if let Some(runtime_condition) = self.runtime_condition {
            out.push_str(",\"runtimeCondition\":");
            push_json_str(out, runtime_condition.as_str());
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

pub fn analyze_canvaskit_document_preflight<F, E>(
    page_count: u32,
    mode: CanvasKitReplayMode,
    profile: RenderProfile,
    build_page: F,
) -> CanvasKitDocumentPreflight
where
    F: FnMut(u32, u32) -> Result<CanvasKitPreflightPageBuild, E>,
    E: fmt::Display,
{
    analyze_canvaskit_document_preflight_with_limits(
        page_count,
        mode,
        profile,
        CanvasKitDocumentPreflightLimits::FIXED,
        build_page,
    )
}

fn analyze_canvaskit_document_preflight_with_limits<F, E>(
    page_count: u32,
    mode: CanvasKitReplayMode,
    profile: RenderProfile,
    limits: CanvasKitDocumentPreflightLimits,
    mut build_page: F,
) -> CanvasKitDocumentPreflight
where
    F: FnMut(u32, u32) -> Result<CanvasKitPreflightPageBuild, E>,
    E: fmt::Display,
{
    let mut preflight =
        CanvasKitDocumentPreflightAccumulator::new(page_count, mode, profile.as_str(), limits);

    if page_count > limits.max_pages {
        preflight.mark_incomplete(
            limits.max_pages,
            CanvasKitDocumentPreflightBlockerCode::PageLimitExceeded,
            Some(format!(
                "pageCount={page_count};maxPages={}",
                limits.max_pages
            )),
        );
        return preflight.finish();
    }

    for page_index in 0..page_count {
        let remaining_work_units = limits
            .max_work_units
            .saturating_sub(preflight.scanned_work_units);
        if remaining_work_units == 0 {
            preflight.mark_incomplete(
                page_index,
                CanvasKitDocumentPreflightBlockerCode::WorkLimitExceeded,
                Some(format!("maxWorkUnits={}", limits.max_work_units)),
            );
            break;
        }

        let (tree, prelower_work_units) = match build_page(page_index, remaining_work_units) {
            Ok(CanvasKitPreflightPageBuild::Complete {
                tree,
                prelower_work_units,
            }) => (tree, prelower_work_units),
            Ok(CanvasKitPreflightPageBuild::WorkLimitExceeded) => {
                preflight.scanned_work_units = limits.max_work_units;
                preflight.mark_incomplete(
                    page_index,
                    CanvasKitDocumentPreflightBlockerCode::WorkLimitExceeded,
                    Some(format!(
                        "stage=preLowering;maxWorkUnits={};remainingWorkUnits={remaining_work_units}",
                        limits.max_work_units
                    )),
                );
                break;
            }
            Err(error) => {
                preflight.mark_incomplete(
                    page_index,
                    CanvasKitDocumentPreflightBlockerCode::PageBuildFailed,
                    Some(error.to_string()),
                );
                break;
            }
        };

        let layer_work_units = match count_layer_tree_work_units(&tree, remaining_work_units) {
            CanvasKitBoundedWorkCount::Complete(work_units) => work_units,
            CanvasKitBoundedWorkCount::Exceeded => {
                preflight.scanned_work_units = limits.max_work_units;
                preflight.mark_incomplete(
                    page_index,
                    CanvasKitDocumentPreflightBlockerCode::WorkLimitExceeded,
                    Some(format!(
                        "stage=layerTree;maxWorkUnits={};remainingWorkUnits={remaining_work_units}",
                        limits.max_work_units
                    )),
                );
                break;
            }
        };
        let page_work_units = prelower_work_units.max(layer_work_units);
        if page_work_units > remaining_work_units {
            preflight.scanned_work_units = limits.max_work_units;
            preflight.mark_incomplete(
                page_index,
                CanvasKitDocumentPreflightBlockerCode::WorkLimitExceeded,
                Some(format!(
                    "stage=combined;maxWorkUnits={};remainingWorkUnits={remaining_work_units}",
                    limits.max_work_units
                )),
            );
            break;
        }

        let plan = analyze_canvaskit_replay_plan(&tree, mode);
        if !preflight.record_page(page_index, page_work_units, plan) {
            break;
        }
    }

    preflight.finish()
}

/// Estimates lowering cost before PageLayerTree allocation expands text into
/// fallback and strict-visual sidecars.
pub fn estimate_canvaskit_page_lowering_work(
    tree: &PageRenderTree,
    max_work_units: u32,
) -> CanvasKitBoundedWorkCount {
    let max_work_units = max_work_units as usize;
    let mut work_units = 0usize;
    let mut pending = vec![(&tree.root, 0usize)];

    while let Some((node, depth)) = pending.pop() {
        if !node.visible {
            continue;
        }
        if depth > CANVASKIT_DOCUMENT_PREFLIGHT_MAX_RENDER_TREE_DEPTH {
            return CanvasKitBoundedWorkCount::Exceeded;
        }
        let Some(node_work_units) = render_node_prelower_work_units(&node.node_type) else {
            return CanvasKitBoundedWorkCount::Exceeded;
        };
        let Some(next_work_units) = work_units.checked_add(node_work_units) else {
            return CanvasKitBoundedWorkCount::Exceeded;
        };
        work_units = next_work_units;
        if minimum_work_exceeds_limit(
            work_units,
            pending.len(),
            node.children.len(),
            max_work_units,
        ) {
            return CanvasKitBoundedWorkCount::Exceeded;
        }
        pending.extend(node.children.iter().rev().map(|child| (child, depth + 1)));
    }

    CanvasKitBoundedWorkCount::Complete(work_units as u32)
}

fn render_node_prelower_work_units(node_type: &RenderNodeType) -> Option<usize> {
    let (base_units, payload_bytes, text_like) = match node_type {
        RenderNodeType::TextRun(run) => {
            let display_text = run.effective_display_text();
            (
                10usize,
                text_projection_payload_bytes(&run.text, display_text.as_ref())?
                    .checked_add(run.style.font_family.len())?
                    .checked_add(
                        run.style
                            .tab_stops
                            .len()
                            .checked_mul(std::mem::size_of::<crate::renderer::TabStop>())?,
                    )?,
                true,
            )
        }
        RenderNodeType::Path(path) => (2usize.checked_add(path.commands.len())?, 0, false),
        RenderNodeType::Image(image) => (2, image.data.as_ref().map_or(0, Vec::len), false),
        RenderNodeType::PageBackground(background) => (
            2,
            background
                .image
                .as_ref()
                .map_or(0, |image| image.data.len()),
            false,
        ),
        RenderNodeType::Equation(equation) => (2, equation.svg_content.len(), true),
        RenderNodeType::RawSvg(raw) => (2, raw.svg.len(), true),
        RenderNodeType::FormObject(form) => (
            2,
            form.caption
                .len()
                .checked_add(form.text.len())?
                .checked_add(form.name.len())?,
            true,
        ),
        RenderNodeType::Placeholder(placeholder) => (2, placeholder.label.len(), true),
        RenderNodeType::FootnoteMarker(marker) => (
            2,
            marker.text.len().checked_add(marker.font_family.len())?,
            true,
        ),
        RenderNodeType::Line(_) | RenderNodeType::Rectangle(_) | RenderNodeType::Ellipse(_) => {
            (2, 0, false)
        }
        RenderNodeType::Page(_)
        | RenderNodeType::MasterPage
        | RenderNodeType::Header
        | RenderNodeType::Footer
        | RenderNodeType::Body { .. }
        | RenderNodeType::Column(_)
        | RenderNodeType::FootnoteArea
        | RenderNodeType::TextLine(_)
        | RenderNodeType::Table(_)
        | RenderNodeType::TableCell(_)
        | RenderNodeType::Group(_)
        | RenderNodeType::TextBox => (1, 0, false),
    };
    if text_like && payload_bytes > CANVASKIT_DOCUMENT_PREFLIGHT_MAX_TEXT_BYTES {
        return None;
    }
    base_units.checked_add(payload_bytes.div_ceil(CANVASKIT_DOCUMENT_PREFLIGHT_PRELOWER_UNIT_BYTES))
}

fn count_layer_tree_work_units(
    tree: &PageLayerTree,
    max_work_units: u32,
) -> CanvasKitBoundedWorkCount {
    let max_work_units = max_work_units as usize;
    let resource_bytes = tree
        .resources
        .image_resources()
        .map(|(_, bytes)| bytes.len())
        .chain(
            tree.resources
                .svg_resources()
                .map(|(_, fragment)| fragment.len()),
        )
        .chain(
            tree.resources
                .font_blob_resources()
                .map(|(_, bytes)| bytes.len()),
        )
        .try_fold(0usize, |total, bytes| total.checked_add(bytes));
    let Some(resource_bytes) = resource_bytes else {
        return CanvasKitBoundedWorkCount::Exceeded;
    };
    let mut work_units = payload_work_units(resource_bytes);
    if work_units > max_work_units {
        return CanvasKitBoundedWorkCount::Exceeded;
    }
    let mut pending = vec![(&tree.root, 0usize)];

    while let Some((node, depth)) = pending.pop() {
        if depth > CANVASKIT_DOCUMENT_PREFLIGHT_MAX_TREE_DEPTH {
            return CanvasKitBoundedWorkCount::Exceeded;
        }
        let Some(next_work_units) = work_units.checked_add(1) else {
            return CanvasKitBoundedWorkCount::Exceeded;
        };
        work_units = next_work_units;
        if work_units > max_work_units {
            return CanvasKitBoundedWorkCount::Exceeded;
        }

        match &node.kind {
            LayerNodeKind::Group { children, .. } => {
                if minimum_work_exceeds_limit(
                    work_units,
                    pending.len(),
                    children.len(),
                    max_work_units,
                ) {
                    return CanvasKitBoundedWorkCount::Exceeded;
                }
                pending.extend(children.iter().rev().map(|child| (child, depth + 1)));
            }
            LayerNodeKind::ClipRect { child, .. } => {
                if minimum_work_exceeds_limit(work_units, pending.len(), 1, max_work_units) {
                    return CanvasKitBoundedWorkCount::Exceeded;
                }
                pending.push((child, depth + 1));
            }
            LayerNodeKind::Leaf { ops, .. } => {
                for op in ops {
                    let Some(next_work_units) = work_units.checked_add(paint_op_work_units(op))
                    else {
                        return CanvasKitBoundedWorkCount::Exceeded;
                    };
                    work_units = next_work_units;
                    if work_units > max_work_units {
                        return CanvasKitBoundedWorkCount::Exceeded;
                    }
                }
                if minimum_work_exceeds_limit(work_units, pending.len(), 0, max_work_units) {
                    return CanvasKitBoundedWorkCount::Exceeded;
                }
            }
        }
    }

    for op in &tree.variant_ops {
        let Some(next_work_units) = work_units.checked_add(paint_op_work_units(op)) else {
            return CanvasKitBoundedWorkCount::Exceeded;
        };
        work_units = next_work_units;
        if work_units > max_work_units {
            return CanvasKitBoundedWorkCount::Exceeded;
        }
    }

    CanvasKitBoundedWorkCount::Complete(work_units as u32)
}

fn payload_work_units(bytes: usize) -> usize {
    bytes.div_ceil(CANVASKIT_DOCUMENT_PREFLIGHT_WORK_UNIT_BYTES)
}

fn additional_payload_work_units(bytes: usize) -> usize {
    bytes
        .saturating_sub(1)
        .checked_div(CANVASKIT_DOCUMENT_PREFLIGHT_WORK_UNIT_BYTES)
        .unwrap_or_default()
}

fn text_projection_payload_bytes(source_text: &str, display_text: &str) -> Option<usize> {
    let display_bytes = if display_text != source_text {
        display_text.len()
    } else {
        0
    };
    source_text.len().checked_add(display_bytes)
}

fn layer_text_display_text(run: &LayerTextRunPaint) -> String {
    run.display_text
        .clone()
        .unwrap_or_else(|| expand_pua_display_text(&run.text))
}

fn paint_op_work_units(op: &PaintOp) -> usize {
    let payload_bytes = match op {
        PaintOp::PageBackground { .. } => 0,
        PaintOp::TextRun { run, .. } => {
            let display_text = layer_text_display_text(run);
            text_projection_payload_bytes(&run.text, &display_text)
                .unwrap_or(usize::MAX)
                .saturating_add(run.style.font_family.len())
                .saturating_add(
                    run.positions
                        .len()
                        .saturating_mul(std::mem::size_of::<f64>()),
                )
                .saturating_add(
                    run.clusters
                        .len()
                        .saturating_mul(std::mem::size_of::<crate::paint::TextClusterPlacement>()),
                )
        }
        PaintOp::CharOverlap { overlap, .. } => overlap
            .text
            .len()
            .saturating_add(overlap.style.font_family.len())
            .saturating_add(
                overlap
                    .positions
                    .len()
                    .saturating_mul(std::mem::size_of::<f64>()),
            ),
        PaintOp::TextControlMark { mark, .. } => mark.mark.kind.glyph().len(),
        PaintOp::TabLeader { .. } => 0,
        PaintOp::TextDecoration { decoration, .. } => decoration
            .positions
            .len()
            .saturating_mul(std::mem::size_of::<f64>()),
        PaintOp::FootnoteMarker { marker, .. } => {
            marker.text.len().saturating_add(marker.font_family.len())
        }
        PaintOp::GlyphRun { run, .. } => run
            .glyph_ids
            .len()
            .saturating_mul(std::mem::size_of::<u32>())
            .saturating_add(
                run.positions
                    .len()
                    .saturating_mul(std::mem::size_of::<crate::paint::LayerPoint>()),
            )
            .saturating_add(
                run.clusters
                    .len()
                    .saturating_mul(std::mem::size_of::<crate::paint::GlyphCluster>()),
            ),
        PaintOp::GlyphOutline { outline, .. } => outline
            .paths
            .iter()
            .map(|path| {
                path.commands
                    .len()
                    .saturating_mul(std::mem::size_of::<crate::renderer::PathCommand>())
            })
            .chain(
                outline
                    .color_layers
                    .iter()
                    .flat_map(|payload| payload.layers.iter())
                    .map(|layer| {
                        layer.commands.as_ref().map_or(0, |commands| {
                            commands
                                .len()
                                .saturating_mul(std::mem::size_of::<crate::renderer::PathCommand>())
                        })
                    }),
            )
            .fold(0usize, usize::saturating_add),
        PaintOp::Path { path, .. } => path
            .commands
            .len()
            .saturating_mul(std::mem::size_of::<crate::renderer::PathCommand>()),
        PaintOp::Image { image, .. } => image.external_path.as_ref().map_or(0, String::len),
        PaintOp::Equation { equation, .. } => equation.color_str.len(),
        PaintOp::FormObject { form, .. } => form
            .caption
            .len()
            .saturating_add(form.text.len())
            .saturating_add(form.fore_color.len())
            .saturating_add(form.back_color.len()),
        PaintOp::Line { .. } | PaintOp::Rectangle { .. } | PaintOp::Ellipse { .. } => 0,
    };
    1usize.saturating_add(additional_payload_work_units(payload_bytes))
}

fn minimum_work_exceeds_limit(
    work_units: usize,
    pending_nodes: usize,
    added_nodes: usize,
    max_work_units: usize,
) -> bool {
    work_units
        .checked_add(pending_nodes)
        .and_then(|value| value.checked_add(added_nodes))
        .is_none_or(|minimum| minimum > max_work_units)
}

struct CanvasKitDocumentPreflightAccumulator {
    mode: CanvasKitReplayMode,
    profile: &'static str,
    page_count: u32,
    limits: CanvasKitDocumentPreflightLimits,
    complete: bool,
    scanned_pages: u32,
    scanned_work_units: u32,
    summary: CanvasKitReplaySummary,
    blockers: Vec<CanvasKitDocumentPreflightBlocker>,
    has_capability_blocker: bool,
    required_font_families: BTreeSet<String>,
    digest: CanvasKitCapabilityDigest,
}

impl CanvasKitDocumentPreflightAccumulator {
    fn new(
        page_count: u32,
        mode: CanvasKitReplayMode,
        profile: &'static str,
        limits: CanvasKitDocumentPreflightLimits,
    ) -> Self {
        Self {
            mode,
            profile,
            page_count,
            limits,
            complete: true,
            scanned_pages: 0,
            scanned_work_units: 0,
            summary: CanvasKitReplaySummary::default(),
            blockers: Vec::new(),
            has_capability_blocker: false,
            required_font_families: BTreeSet::new(),
            digest: CanvasKitCapabilityDigest::new(mode, profile, page_count, limits),
        }
    }

    fn record_page(&mut self, page_index: u32, work_units: u32, plan: CanvasKitReplayPlan) -> bool {
        self.scanned_pages = self.scanned_pages.saturating_add(1);
        self.scanned_work_units = self.scanned_work_units.saturating_add(work_units);
        self.summary.merge(&plan.summary);
        self.digest.record_page(page_index, work_units);

        let mut required_font_families_complete = plan.required_font_families_complete;
        for font_family in plan.required_font_families {
            self.digest
                .record_required_font_family(page_index, &font_family);
            if self.required_font_families.contains(&font_family) {
                continue;
            }
            if self.required_font_families.len() >= self.limits.max_required_font_families as usize
            {
                required_font_families_complete = false;
                continue;
            }
            self.required_font_families.insert(font_family);
        }

        for report in &plan.text_variants {
            if report.selected_reason
                != selected_reason_as_str(VariantSelectedReason::NoSupportedVariant)
            {
                continue;
            }
            self.push_capability_blocker(CanvasKitDocumentPreflightBlocker {
                page_index,
                code: CanvasKitDocumentPreflightBlockerCode::Unsupported,
                op_type: Some("textVariant"),
                detail: Some(bounded_blocker_detail(format!(
                    "equivalenceGroup={};reason=noSupportedVariant",
                    report.equivalence_group
                ))),
            });
        }

        for item in plan.items {
            self.digest.record_item(page_index, &item);
            let Some(code) = blocker_code_for_item(&item) else {
                continue;
            };
            self.push_capability_blocker(CanvasKitDocumentPreflightBlocker {
                page_index,
                code,
                op_type: Some(item.op_type),
                detail: item.detail.map(bounded_blocker_detail),
            });
        }
        if !required_font_families_complete {
            self.mark_incomplete(
                page_index,
                CanvasKitDocumentPreflightBlockerCode::WorkLimitExceeded,
                Some(format!(
                    "stage=requiredFontFamilies;maxRequiredFontFamilies={}",
                    self.limits.max_required_font_families
                )),
            );
            return false;
        }
        true
    }

    fn push_capability_blocker(&mut self, blocker: CanvasKitDocumentPreflightBlocker) {
        self.has_capability_blocker = true;
        if self.blockers.len() < self.limits.max_blockers as usize {
            self.blockers.push(blocker);
        }
    }

    fn mark_incomplete(
        &mut self,
        page_index: u32,
        code: CanvasKitDocumentPreflightBlockerCode,
        detail: Option<String>,
    ) {
        self.complete = false;
        let detail = detail.map(bounded_blocker_detail);
        self.digest
            .record_incomplete(page_index, code, detail.as_deref());
        let blocker = CanvasKitDocumentPreflightBlocker {
            page_index,
            code,
            op_type: None,
            detail,
        };
        let max_blockers = self.limits.max_blockers as usize;
        if self.blockers.len() < max_blockers {
            self.blockers.push(blocker);
        } else if max_blockers > 0 {
            self.blockers[max_blockers - 1] = blocker;
        }
    }

    fn finish(self) -> CanvasKitDocumentPreflight {
        let eligible = self.complete
            && self.summary.hidden_overlay_violations == 0
            && self.summary.direct_required_items == 0
            && self.summary.unsupported_items == 0
            && self.summary.compat_overlay_items == 0
            && !self.has_capability_blocker;
        let status = if !self.complete {
            CanvasKitDocumentPreflightStatus::Incomplete
        } else if eligible {
            CanvasKitDocumentPreflightStatus::Eligible
        } else {
            CanvasKitDocumentPreflightStatus::Ineligible
        };
        let capability_digest = self.digest.finish(
            status,
            self.complete,
            self.scanned_pages,
            self.scanned_work_units,
            &self.summary,
        );

        CanvasKitDocumentPreflight {
            schema_version: CANVASKIT_DOCUMENT_PREFLIGHT_SCHEMA_VERSION,
            mode: self.mode,
            profile: self.profile,
            status,
            eligible,
            complete: self.complete,
            page_count: self.page_count,
            scanned_pages: self.scanned_pages,
            scanned_work_units: self.scanned_work_units,
            limits: self.limits,
            summary: self.summary,
            blockers: self.blockers,
            required_font_families: self.required_font_families.into_iter().collect(),
            capability_digest,
        }
    }
}

impl CanvasKitReplaySummary {
    fn merge(&mut self, other: &Self) {
        self.total_items = self.total_items.saturating_add(other.total_items);
        self.direct_items = self.direct_items.saturating_add(other.direct_items);
        self.direct_required_items = self
            .direct_required_items
            .saturating_add(other.direct_required_items);
        self.compat_overlay_items = self
            .compat_overlay_items
            .saturating_add(other.compat_overlay_items);
        self.text_fallback_items = self
            .text_fallback_items
            .saturating_add(other.text_fallback_items);
        self.unsupported_items = self
            .unsupported_items
            .saturating_add(other.unsupported_items);
        self.hidden_overlay_violations = self
            .hidden_overlay_violations
            .saturating_add(other.hidden_overlay_violations);
    }
}

fn blocker_code_for_item(
    item: &CanvasKitReplayItem,
) -> Option<CanvasKitDocumentPreflightBlockerCode> {
    if matches!(item.reason, CanvasKitReplayReason::HiddenOverlayForbidden) {
        return Some(CanvasKitDocumentPreflightBlockerCode::HiddenCanvas2dOverlayRequired);
    }
    match item.status {
        CanvasKitReplayStatus::CompatOverlay => {
            Some(CanvasKitDocumentPreflightBlockerCode::CompatOverlay)
        }
        CanvasKitReplayStatus::TextFallback => None,
        CanvasKitReplayStatus::Unsupported => {
            Some(CanvasKitDocumentPreflightBlockerCode::Unsupported)
        }
        // Keep the v1 blocker vocabulary stable while preserving the more
        // specific replay-plan status and summary count.
        CanvasKitReplayStatus::DirectRequired => {
            Some(CanvasKitDocumentPreflightBlockerCode::Unsupported)
        }
        CanvasKitReplayStatus::Direct => None,
    }
}

fn bounded_blocker_detail(mut detail: String) -> String {
    if detail.len() <= CANVASKIT_DOCUMENT_PREFLIGHT_MAX_DETAIL_BYTES {
        return detail;
    }
    let mut truncate_at = CANVASKIT_DOCUMENT_PREFLIGHT_MAX_DETAIL_BYTES.saturating_sub(3);
    while !detail.is_char_boundary(truncate_at) {
        truncate_at = truncate_at.saturating_sub(1);
    }
    detail.truncate(truncate_at);
    detail.push_str("...");
    detail
}

struct CanvasKitCapabilityDigest(blake3::Hasher);

impl CanvasKitCapabilityDigest {
    fn new(
        mode: CanvasKitReplayMode,
        profile: &str,
        page_count: u32,
        limits: CanvasKitDocumentPreflightLimits,
    ) -> Self {
        let mut digest = Self(blake3::Hasher::new());
        digest.0.update(b"rhwp.canvaskit.document-preflight.v1\0");
        digest.record_str(mode.as_str());
        digest.record_str(profile);
        digest.record_u32(page_count);
        digest.record_u32(limits.max_pages);
        digest.record_u32(limits.max_work_units);
        digest.record_u32(limits.max_blockers);
        digest.record_u32(limits.max_required_font_families);
        digest
    }

    fn record_page(&mut self, page_index: u32, work_units: u32) {
        self.0.update(b"page\0");
        self.record_u32(page_index);
        self.record_u32(work_units);
    }

    fn record_item(&mut self, page_index: u32, item: &CanvasKitReplayItem) {
        self.0.update(b"item\0");
        self.record_u32(page_index);
        self.record_str(item.op_type);
        self.record_str(item.feature.as_str());
        self.record_str(item.status.as_str());
        self.record_str(item.reason.as_str());
        for runtime_condition in &item.runtime_conditions {
            self.0.update(b"runtime-condition\0");
            self.record_str(runtime_condition.as_str());
        }
        self.record_optional_str(item.detail.as_deref());
    }

    fn record_required_font_family(&mut self, page_index: u32, font_family: &str) {
        self.0.update(b"required-font-family\0");
        self.record_u32(page_index);
        self.record_str(font_family);
    }

    fn record_incomplete(
        &mut self,
        page_index: u32,
        code: CanvasKitDocumentPreflightBlockerCode,
        detail: Option<&str>,
    ) {
        self.0.update(b"incomplete\0");
        self.record_u32(page_index);
        self.record_str(code.as_str());
        self.record_optional_str(detail);
    }

    fn finish(
        mut self,
        status: CanvasKitDocumentPreflightStatus,
        complete: bool,
        scanned_pages: u32,
        scanned_work_units: u32,
        summary: &CanvasKitReplaySummary,
    ) -> String {
        self.0.update(b"result\0");
        self.record_str(match status {
            CanvasKitDocumentPreflightStatus::Eligible => "eligible",
            CanvasKitDocumentPreflightStatus::Ineligible => "ineligible",
            CanvasKitDocumentPreflightStatus::Incomplete => "incomplete",
        });
        self.0.update(&[u8::from(complete)]);
        self.record_u32(scanned_pages);
        self.record_u32(scanned_work_units);
        self.record_u32(summary.total_items);
        self.record_u32(summary.direct_items);
        self.record_u32(summary.direct_required_items);
        self.record_u32(summary.compat_overlay_items);
        self.record_u32(summary.text_fallback_items);
        self.record_u32(summary.unsupported_items);
        self.record_u32(summary.hidden_overlay_violations);
        format!("blake3:{}", self.0.finalize().to_hex())
    }

    fn record_u32(&mut self, value: u32) {
        self.0.update(&value.to_le_bytes());
    }

    fn record_str(&mut self, value: &str) {
        self.0.update(&(value.len() as u64).to_le_bytes());
        self.0.update(value.as_bytes());
    }

    fn record_optional_str(&mut self, value: Option<&str>) {
        self.0.update(&[u8::from(value.is_some())]);
        if let Some(value) = value {
            self.record_str(value);
        }
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
    required_font_families: BTreeSet<String>,
    required_font_families_complete: bool,
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
            required_font_families: BTreeSet::new(),
            required_font_families_complete: true,
        }
    }

    fn finish(self) -> CanvasKitReplayPlan {
        CanvasKitReplayPlan {
            mode: self.mode,
            render_profile: self.tree.profile,
            hidden_canvas2d_overlay_allowed: self.policy.hidden_canvas2d_overlay_allowed,
            direct_replay_required: self.policy.direct_replay_required,
            summary: self.summary,
            items: self.items,
            text_variants: self.text_variants,
            required_font_families: self.required_font_families.into_iter().collect(),
            required_font_families_complete: self.required_font_families_complete,
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
                    runtime_conditions: Vec::new(),
                    compat_overlay_allowed: false,
                    detail: Some(clip_kind_detail(*clip_kind).to_string()),
                });
                self.visit_node(child, &format!("{path}/clip/child"));
            }
            LayerNodeKind::Leaf { ops, .. } => {
                self.collect_leaf_required_font_families(ops);
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
                    .extend(selection.reports.into_iter().map(|report| {
                        text_variant_report(report, &selection_ops, &self.tree.resources)
                    }));
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

    fn collect_leaf_required_font_families(&mut self, ops: &[PaintOp]) {
        for op in ops {
            match op {
                PaintOp::TextRun { run, .. } => {
                    self.record_required_font_family(&run.style.font_family);
                    let display_text = layer_text_display_text(run);
                    if display_text.chars().any(|character| {
                        matches!(
                            character as u32,
                            0x1100..=0x11ff | 0xa960..=0xa97f | 0xd7b0..=0xd7ff
                        )
                    }) {
                        self.record_required_font_family(CANVASKIT_OLD_HANGUL_FONT_FAMILY);
                    }
                }
                PaintOp::CharOverlap { overlap, .. } => {
                    self.record_required_font_family(&overlap.style.font_family)
                }
                PaintOp::FootnoteMarker { marker, .. } => {
                    self.record_required_font_family(&marker.font_family)
                }
                PaintOp::PageBackground { .. }
                | PaintOp::GlyphRun { .. }
                | PaintOp::GlyphOutline { .. }
                | PaintOp::TextControlMark { .. }
                | PaintOp::TabLeader { .. }
                | PaintOp::TextDecoration { .. }
                | PaintOp::Line { .. }
                | PaintOp::Rectangle { .. }
                | PaintOp::Ellipse { .. }
                | PaintOp::Path { .. }
                | PaintOp::Image { .. }
                | PaintOp::Equation { .. }
                | PaintOp::FormObject { .. } => {}
            }
        }
    }

    fn record_required_font_family(&mut self, font_family: &str) {
        let font_family = font_family.trim();
        if font_family.is_empty() {
            return;
        }
        if self.required_font_families.contains(font_family) {
            return;
        }
        if font_family.len() > CANVASKIT_DOCUMENT_PREFLIGHT_MAX_FONT_FAMILY_BYTES
            || self.required_font_families.len()
                >= CANVASKIT_DOCUMENT_PREFLIGHT_MAX_REQUIRED_FONT_FAMILIES as usize
        {
            self.required_font_families_complete = false;
            return;
        }
        self.required_font_families.insert(font_family.to_string());
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
                let mut item =
                    self.text_variant_item(path, "glyphRun", &run.variant, selected_variants);
                if item.status == CanvasKitReplayStatus::Direct {
                    if let Some(runtime_condition) =
                        canvaskit_text_variant_runtime_condition(op, &self.tree.resources)
                    {
                        item.add_runtime_condition(runtime_condition);
                    }
                }
                item
            }
            PaintOp::GlyphOutline { outline, .. } => {
                let mut item = self.text_variant_item(
                    path,
                    "glyphOutline",
                    &outline.variant,
                    selected_variants,
                );
                if item.status == CanvasKitReplayStatus::Direct {
                    if let Some(runtime_condition) =
                        canvaskit_text_variant_runtime_condition(op, &self.tree.resources)
                    {
                        item.add_runtime_condition(runtime_condition);
                    }
                }
                item
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
            PaintOp::Line { .. } => {
                direct_item(path, paint_op_type(op), CanvasKitReplayFeature::VectorShape)
            }
            PaintOp::Rectangle { rect, .. } => vector_shape_item(
                path,
                "rectangle",
                pattern_image_required(&rect.style, rect.gradient.as_deref()),
            ),
            PaintOp::Ellipse { ellipse, .. } => vector_shape_item(
                path,
                "ellipse",
                pattern_image_required(&ellipse.style, ellipse.gradient.as_deref()),
            ),
            PaintOp::Path {
                path: shape_path, ..
            } => vector_shape_item(
                path,
                "path",
                pattern_image_required(&shape_path.style, shape_path.gradient.as_deref()),
            ),
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
                runtime_conditions: Vec::new(),
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
            runtime_conditions: Vec::new(),
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

fn text_variant_report(
    report: VariantSelectionReport,
    selection_ops: &[PaintOp],
    resources: &ResourceArena,
) -> CanvasKitTextVariantReport {
    let selected_variant_id = report.selected_variant_id.clone();
    let parts = report
        .parts
        .into_iter()
        .map(|part| {
            let runtime_condition = selection_ops
                .iter()
                .find(|op| text_variant_part_matches_op(&part, op))
                .and_then(|op| canvaskit_text_variant_runtime_condition(op, resources));
            CanvasKitTextVariantPartReport {
                equivalence_group: part.equivalence_group,
                variant_id: part.variant_id,
                variant_kind: part.variant_kind.as_str(),
                part_index: part.part_index,
                part_count: part.part_count,
                replayable: part.replayable,
                reason: part.reason.map(|reason| reason.as_str()),
                runtime_condition,
                details: part.details,
                font_verification: part.font_verification,
                outline_eligibility: part.outline_eligibility,
            }
        })
        .collect::<Vec<_>>();
    let mut selected_runtime_conditions = Vec::new();
    for runtime_condition in parts
        .iter()
        .filter(|part| part.variant_id == selected_variant_id)
        .filter_map(|part| part.runtime_condition)
    {
        if !selected_runtime_conditions.contains(&runtime_condition) {
            selected_runtime_conditions.push(runtime_condition);
        }
    }
    CanvasKitTextVariantReport {
        backend: report.backend.as_str(),
        render_profile: report.render_profile,
        equivalence_group: report.equivalence_group,
        selected_variant_id,
        selected_variant_kind: report.selected_variant_kind.as_str(),
        selected_reason: selected_reason_as_str(report.selected_reason),
        selected_runtime_conditions,
        anchor_op_id: report.anchor_op_id,
        parts_expected: report.parts_expected,
        parts_replayed: report.parts_replayed,
        font_verification: report.font_verification,
        outline_eligibility: report.outline_eligibility,
        parts,
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

fn text_variant_part_matches_op(
    part: &crate::renderer::layer_renderer::VariantPartReplayReport,
    op: &PaintOp,
) -> bool {
    let variant = match op {
        PaintOp::TextRun { run, .. } => run.variant.as_ref(),
        PaintOp::GlyphRun { run, .. } => Some(&run.variant),
        PaintOp::GlyphOutline { outline, .. } => Some(&outline.variant),
        _ => None,
    };
    variant.is_some_and(|variant| {
        variant.equivalence_group == part.equivalence_group
            && variant.variant_id == part.variant_id
            && variant.part_index == part.part_index
            && variant.part_count == part.part_count
    })
}

fn canvaskit_text_variant_runtime_condition(
    op: &PaintOp,
    resources: &ResourceArena,
) -> Option<CanvasKitReplayRuntimeCondition> {
    match op {
        PaintOp::GlyphRun { run, .. }
            if canvaskit_glyph_run_replay_status(run, resources).replayable =>
        {
            Some(CanvasKitReplayRuntimeCondition::CanvasKitTypefaceConstruction)
        }
        PaintOp::GlyphOutline { outline, .. }
            if outline.payload_kind == GlyphOutlinePayloadKind::BitmapGlyph =>
        {
            let bytes = outline
                .bitmap_glyph
                .as_ref()
                .and_then(|payload| resources.image_bytes(payload.image_resource_id))?;
            match image_admission(bytes) {
                CanvasKitImageAdmission::HeaderAdmitted(runtime_condition)
                    if runtime_condition
                        == CanvasKitReplayRuntimeCondition::CanvasKitEncodedImageDecode =>
                {
                    Some(runtime_condition)
                }
                _ => None,
            }
        }
        PaintOp::GlyphOutline { bbox, outline }
            if outline.payload_kind == GlyphOutlinePayloadKind::SvgGlyph
                && canvaskit_glyph_outline_replay_status(outline, Some(*bbox), resources)
                    .replayable =>
        {
            Some(CanvasKitReplayRuntimeCondition::CanvasKitSvgPathConstruction)
        }
        _ => None,
    }
}

fn canvaskit_glyph_run_replay_status(
    run: &LayerGlyphRunPaint,
    resources: &ResourceArena,
) -> VariantReplayStatus {
    if let Some(error) = run.strict_payload_contract_error() {
        return VariantReplayStatus::rejected(error.into());
    }
    if run.glyph_transforms.is_some() || run.orientation == GlyphRunOrientation::MixedPerGlyph {
        return VariantReplayStatus::rejected(VariantRejectReason::VariantUnsupported);
    }
    match run.diagnostics.replay_eligibility {
        GlyphRunReplayEligibility::Portable => {}
        GlyphRunReplayEligibility::ConditionalExternalFont => {
            return canvaskit_glyph_run_font_rejection(
                run,
                VariantRejectReason::ExternalFontNotVerified,
            );
        }
        GlyphRunReplayEligibility::LocalDiagnosticOnly
        | GlyphRunReplayEligibility::NotReplayable => {
            return VariantReplayStatus::rejected(VariantRejectReason::FontNotPortable);
        }
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
    if run.diagnostics.used_fallback_font_count != 0 {
        return VariantReplayStatus::rejected(VariantRejectReason::DiagnosticsNotClean);
    }
    if !matches!(
        run.diagnostics.quality,
        TextVariantQuality::Exact | TextVariantQuality::PositionAdjusted
    ) {
        return VariantReplayStatus::rejected(VariantRejectReason::VariantUnsupported);
    }
    if run.diagnostics.quality == TextVariantQuality::PositionAdjusted {
        let tolerance = 0.5_f64.min(0.25_f64.max(run.shape_key.font_instance.size_px * 0.005));
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
    if !blob.portability.is_self_contained_replayable() {
        return VariantReplayStatus::rejected(VariantRejectReason::FontNotPortable);
    }
    if run
        .glyph_ids
        .iter()
        .any(|glyph_id| *glyph_id == 0 || *glyph_id > u16::MAX as u32)
    {
        return VariantReplayStatus::rejected(VariantRejectReason::GlyphIdOutOfRange);
    }
    let expected_digest = blob.digest.as_ref().map(|digest| digest.value.clone());
    let font_resource_rejection =
        |reason: VariantRejectReason, blob_resolved: bool, digest_matched: bool| {
            let mut status = canvaskit_glyph_run_font_rejection(run, reason);
            if let Some(report) = status.font_verification.as_mut() {
                report.blob_key = Some(blob.id.0.clone());
                report.portability = Some(blob.portability.kind().as_str().to_string());
                report.expected_digest = expected_digest.clone();
                report.blob_resolved = Some(blob_resolved);
                report.digest_matched = Some(digest_matched);
            }
            status
        };
    let Some(data_ref) = blob.data_ref.as_ref() else {
        return font_resource_rejection(VariantRejectReason::FontBlobNotVerified, false, false);
    };
    if data_ref.kind != crate::paint::BinaryResourceKind::FontBlob {
        return font_resource_rejection(VariantRejectReason::FontBlobNotVerified, false, false);
    }
    let mut resource = None;
    for (id, bytes) in resources.font_blob_resources() {
        let digest = crate::paint::resource_digest_hex(bytes);
        let ref_matches = data_ref.id == blob.id.0
            || data_ref.id == format!("font-blob-{}", id.0)
            || data_ref.id == crate::paint::font_blob_resource_key(bytes.len(), &digest)
            || expected_digest
                .as_deref()
                .is_some_and(|expected| expected == digest);
        if ref_matches {
            resource = Some((digest, bytes));
            break;
        }
    }
    let Some((resource_digest, resource_bytes)) = resource else {
        return font_resource_rejection(VariantRejectReason::FontBlobNotVerified, false, false);
    };
    let digest_matched = expected_digest
        .as_deref()
        .is_some_and(|expected| expected == resource_digest);
    if !digest_matched {
        return font_resource_rejection(VariantRejectReason::FontDigestMismatch, true, false);
    }
    if face.face_index != 0 && ttf_parser::Face::parse(resource_bytes, face.face_index).is_err() {
        let mut status =
            canvaskit_glyph_run_font_rejection(run, VariantRejectReason::FaceIndexUnsupported);
        if let Some(report) = status.font_verification.as_mut() {
            report.blob_key = Some(face.blob_key.0.clone());
            report.portability = Some(blob.portability.kind().as_str().to_string());
            report.expected_digest = expected_digest;
            report.blob_resolved = Some(true);
            report.digest_matched = Some(true);
            report.exact_face_instantiated = Some(false);
            report.face_index_supported = Some(false);
        }
        return status;
    }
    let mut status = VariantReplayStatus::replayable();
    status.font_verification = Some(VariantFontVerificationReport {
        face_key: Some(face.id.0.clone()),
        blob_key: Some(blob.id.0.clone()),
        portability: Some(blob.portability.kind().as_str().to_string()),
        expected_digest,
        blob_resolved: Some(true),
        digest_matched: Some(true),
        exact_face_instantiated: None,
        face_index_supported: Some(true),
        variation_supported: Some(true),
        effect_supported: Some(true),
        replay_eligible: true,
        reason: None,
    });
    status
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
    let monochrome_paths_are_replayable = || {
        outline.paths.iter().all(|path| {
            path.source_range_utf8.end >= path.source_range_utf8.start
                && path.glyph_range.end >= path.glyph_range.start
                && !path.commands.is_empty()
                && path.commands.iter().all(path_command_is_finite)
        })
    };
    match outline.payload_kind {
        GlyphOutlinePayloadKind::MonochromeFill => {
            if outline.paths.is_empty() {
                return (false, Some(VariantRejectReason::EmptyGlyphOutlinePayload));
            }
            if !monochrome_paths_are_replayable() {
                return (false, Some(VariantRejectReason::UnsupportedOutlinePayload));
            }
            (true, None)
        }
        GlyphOutlinePayloadKind::MonochromeFillStroke => {
            if outline.paths.is_empty() {
                return (false, Some(VariantRejectReason::EmptyGlyphOutlinePayload));
            }
            if !monochrome_paths_are_replayable() {
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
            let requires_color_layers = outline
                .variant
                .requires
                .iter()
                .any(|feature| feature == "text.glyphOutline.colorLayers");
            let requires_format = outline.color_layers.as_ref().is_some_and(|payload| {
                let feature = match payload.color_format {
                    crate::paint::ColorGlyphFormat::ColrV0 => {
                        "text.glyphOutline.colorLayers.colrV0"
                    }
                    crate::paint::ColorGlyphFormat::ColrV1 => {
                        "text.glyphOutline.colorLayers.colrV1"
                    }
                    crate::paint::ColorGlyphFormat::Other => return false,
                };
                outline
                    .variant
                    .requires
                    .iter()
                    .any(|required| required == feature)
            });
            if requires_color_layers
                && requires_format
                && outline.color_layers.as_ref().is_some_and(|payload| {
                    payload.has_colrv0_resolved_layer_contract()
                        || payload.has_colrv1_supported_graph_contract()
                })
            {
                (true, None)
            } else {
                (false, Some(VariantRejectReason::UnsupportedColorGlyph))
            }
        }
        GlyphOutlinePayloadKind::BitmapGlyph => {
            if !outline
                .variant
                .requires
                .iter()
                .any(|feature| feature == "text.glyphOutline.bitmapGlyph")
            {
                return (false, Some(VariantRejectReason::UnsupportedBitmapGlyph));
            }
            let Some(payload) = &outline.bitmap_glyph else {
                return (false, Some(VariantRejectReason::UnsupportedBitmapGlyph));
            };
            let Some(bytes) = resources.image_bytes(payload.image_resource_id) else {
                return (false, Some(VariantRejectReason::UnsupportedBitmapGlyph));
            };
            if bbox.is_none_or(|bbox| !glyph_payload_bbox_is_replayable(bbox))
                || !payload.has_strict_visual_contract()
                || image_admission(bytes)
                    != CanvasKitImageAdmission::HeaderAdmitted(
                        CanvasKitReplayRuntimeCondition::CanvasKitEncodedImageDecode,
                    )
            {
                return (false, Some(VariantRejectReason::UnsupportedBitmapGlyph));
            }
            (true, None)
        }
        GlyphOutlinePayloadKind::SvgGlyph => {
            if !outline
                .variant
                .requires
                .iter()
                .any(|feature| feature == "text.glyphOutline.svgGlyph")
            {
                return (false, Some(VariantRejectReason::UnsupportedSvgGlyph));
            }
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
        runtime_conditions: Vec::new(),
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
        runtime_conditions: Vec::new(),
        compat_overlay_allowed: false,
        detail,
    }
}

fn vector_shape_item(
    path: String,
    op_type: &'static str,
    has_pattern: bool,
) -> CanvasKitReplayItem {
    let mut item = direct_item(path, op_type, CanvasKitReplayFeature::VectorShape);
    if has_pattern {
        item.add_runtime_condition(
            CanvasKitReplayRuntimeCondition::CanvasKitPatternImageConstruction,
        );
    }
    item
}

fn pattern_image_required(
    style: &crate::renderer::ShapeStyle,
    gradient: Option<&crate::renderer::GradientFillInfo>,
) -> bool {
    style.pattern.is_some() && gradient.is_none_or(|gradient| gradient.colors.len() < 2)
}

fn image_effect_requires_preprocess(effect: ImageEffect, brightness: i8, contrast: i8) -> bool {
    effect != ImageEffect::RealPic || brightness != 0 || contrast != 0
}

fn image_item(
    path: String,
    image: &crate::paint::LayerImagePaint,
    resources: &ResourceArena,
) -> CanvasKitReplayItem {
    let admission = image
        .resource_id
        .and_then(|resource_id| resources.image_bytes(resource_id))
        .map_or(CanvasKitImageAdmission::Missing, image_admission);
    let detail = Some(image_replay_detail(
        image.fill_mode,
        image.original_size,
        image.crop,
        image.original_size_hu,
        Some(image.effect),
        image.brightness,
        image.contrast,
        Some(image.transform),
        image.external_path.as_deref(),
        admission,
        image.text_wrap,
    ));

    match admission {
        CanvasKitImageAdmission::HeaderAdmitted(runtime_condition) => {
            let mut item =
                direct_item_with_detail(path, "image", CanvasKitReplayFeature::RasterImage, detail);
            item.add_runtime_condition(runtime_condition);
            if image_effect_requires_preprocess(image.effect, image.brightness, image.contrast) {
                item.add_runtime_condition(
                    CanvasKitReplayRuntimeCondition::CanvasKitImageEffectPreprocess,
                );
            }
            item
        }
        CanvasKitImageAdmission::Missing | CanvasKitImageAdmission::StaticRejected => {
            direct_required_item_with_detail(
                path,
                "image",
                CanvasKitReplayFeature::RasterImage,
                detail,
            )
        }
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
    let admission = resources
        .image_bytes(image.resource_id)
        .map_or(CanvasKitImageAdmission::Missing, image_admission);
    let detail = Some(image_replay_detail(
        Some(image.fill_mode),
        None,
        None,
        None,
        Some(image.effect),
        image.brightness,
        image.contrast,
        None,
        None,
        admission,
        None,
    ));
    match admission {
        CanvasKitImageAdmission::HeaderAdmitted(runtime_condition) => {
            let mut item = direct_item_with_detail(
                path,
                "pageBackground",
                CanvasKitReplayFeature::PageBackground,
                detail,
            );
            item.add_runtime_condition(runtime_condition);
            if image_effect_requires_preprocess(image.effect, image.brightness, image.contrast) {
                item.add_runtime_condition(
                    CanvasKitReplayRuntimeCondition::CanvasKitImageEffectPreprocess,
                );
            }
            item
        }
        CanvasKitImageAdmission::Missing | CanvasKitImageAdmission::StaticRejected => {
            direct_required_item_with_detail(
                path,
                "pageBackground",
                CanvasKitReplayFeature::PageBackground,
                detail,
            )
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CanvasKitImageAdmission {
    Missing,
    StaticRejected,
    HeaderAdmitted(CanvasKitReplayRuntimeCondition),
}

fn image_admission(bytes: &[u8]) -> CanvasKitImageAdmission {
    if !canvaskit_encoded_image_is_replayable(bytes) {
        return CanvasKitImageAdmission::StaticRejected;
    }
    let runtime_condition =
        if canvaskit_encoded_image_header(bytes).is_some_and(|header| header.is_svg()) {
            CanvasKitReplayRuntimeCondition::BrowserSvgImageDecode
        } else {
            CanvasKitReplayRuntimeCondition::CanvasKitEncodedImageDecode
        };
    CanvasKitImageAdmission::HeaderAdmitted(runtime_condition)
}

fn canvaskit_encoded_image_is_replayable(bytes: &[u8]) -> bool {
    if bytes.is_empty()
        || bytes.len().div_ceil(3).saturating_mul(4) > CANVASKIT_MAX_ENCODED_IMAGE_BASE64_BYTES
    {
        return false;
    }
    canvaskit_encoded_image_header(bytes).is_some_and(|header| {
        (!header.is_svg() || bytes.len() <= CANVASKIT_MAX_SVG_BYTES)
            && header.is_within_decode_limits()
    })
}

fn image_replay_detail(
    fill_mode: Option<ImageFillMode>,
    original_size: Option<(f64, f64)>,
    crop: Option<(i32, i32, i32, i32)>,
    crop_reference_size: Option<(u32, u32)>,
    effect: Option<ImageEffect>,
    brightness: i8,
    contrast: i8,
    transform: Option<crate::renderer::render_tree::ShapeTransform>,
    external_path: Option<&str>,
    admission: CanvasKitImageAdmission,
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
    if let Some((width, height)) = crop_reference_size {
        let _ = write!(detail, ";originalSizeHu={width}x{height}");
    } else {
        detail.push_str(";originalSizeHu=none");
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
    match admission {
        CanvasKitImageAdmission::Missing => detail.push_str(";missingImageData"),
        CanvasKitImageAdmission::StaticRejected => detail.push_str(";encodedImageRejected"),
        CanvasKitImageAdmission::HeaderAdmitted(_) => {
            detail.push_str(";imageHeaderAdmitted;runtimeDecodeRequired");
        }
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
        ImageFillMode::Total => "total",
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
        analyze_canvaskit_document_preflight_with_limits, analyze_canvaskit_replay_plan,
        canvaskit_encoded_image_is_replayable, canvaskit_glyph_outline_payload_status,
        canvaskit_glyph_run_replay_status, canvaskit_static_svg_fragment_has_path_layer,
        estimate_canvaskit_page_lowering_work, CanvasKitBoundedWorkCount,
        CanvasKitDocumentPreflightBlockerCode, CanvasKitDocumentPreflightLimits,
        CanvasKitDocumentPreflightStatus, CanvasKitPreflightPageBuild, CanvasKitReplayMode,
        CanvasKitReplayRuntimeCondition, CanvasKitReplayStatus, CanvasKitTextVariantPartReport,
        CanvasKitTextVariantReport, GlyphOutlinePayloadKind, VariantRejectReason,
        CANVASKIT_DOCUMENT_PREFLIGHT_MAX_TEXT_BYTES, CANVASKIT_MAX_SVG_BYTES,
        CANVASKIT_OLD_HANGUL_FONT_FAMILY,
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
        ImageResourceId, LayerAffineTransform, LayerEllipsePaint, LayerGlyphOutlinePaint,
        LayerGlyphOutlinePath, LayerGlyphRunPaint, LayerImagePaint, LayerNode,
        LayerPageBackgroundImagePaint, LayerPageBackgroundPaint, LayerPathPaint, LayerPoint,
        LayerRectanglePaint, LayerTextRunPaint, LayerVector, LocalizedName, PageLayerTree, PaintOp,
        PaintTextStyle, PaintVariantMeta, ResolvedColor, ResourceArena, ShapeKey, ShapingEngineId,
        SvgGlyphPayload, SvgGlyphSecurityMode, SvgGlyphViewBox, TextDirection, TextRunPlacement,
        TextSourceId, TextSourceRange, TextSourceSpan, TextVariantKind, TextVariantQuality,
        VariationAxisValue, WritingMode,
    };
    use crate::paint::{LayerBuilder, RenderProfile};
    use crate::renderer::layer_renderer::VariantOutlineEligibilityReport;
    use crate::renderer::render_tree::{
        BoundingBox, FieldMarkerType, PageRenderTree, RawSvgNode, RenderNode, RenderNodeType,
        ShapeTransform, TextRunNode,
    };
    use crate::renderer::{GradientFillInfo, PathCommand, PatternFillInfo, ShapeStyle, TextStyle};

    const FIXTURE_PNG: &[u8] = include_bytes!("../../assets/logo/logo-32.png");
    const FIXTURE_FONT: &[u8] =
        include_bytes!("../../tests/fixtures/fonts/RHWPColorSmokeCOLRv0.ttf");
    const FIXTURE_TTC: &[u8] = include_bytes!("../../tests/fixtures/fonts/RHWPExactFaceSmoke.ttc");

    fn compact_bmp(width: i32, height: i32) -> Vec<u8> {
        let mut bytes = vec![0; 54];
        bytes[..2].copy_from_slice(b"BM");
        bytes[2..6].copy_from_slice(&54u32.to_le_bytes());
        bytes[10..14].copy_from_slice(&54u32.to_le_bytes());
        bytes[14..18].copy_from_slice(&40u32.to_le_bytes());
        bytes[18..22].copy_from_slice(&width.to_le_bytes());
        bytes[22..26].copy_from_slice(&height.to_le_bytes());
        bytes[26..28].copy_from_slice(&1u16.to_le_bytes());
        bytes[28..30].copy_from_slice(&24u16.to_le_bytes());
        bytes
    }

    #[test]
    fn canvaskit_image_admission_accepts_only_bounded_svg_resources() {
        assert!(canvaskit_encoded_image_is_replayable(
            b"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 320 240\"/>"
        ));
        assert!(!canvaskit_encoded_image_is_replayable(
            b"<!DOCTYPE svg><svg viewBox=\"0 0 1 1\"/>"
        ));
        assert!(!canvaskit_encoded_image_is_replayable(
            b"<svg width=\"8193\" height=\"1\"/>"
        ));

        let mut oversized = vec![b' '; CANVASKIT_MAX_SVG_BYTES + 1];
        let root = b"<svg width=\"1\" height=\"1\">";
        oversized[..root.len()].copy_from_slice(root);
        assert!(!canvaskit_encoded_image_is_replayable(&oversized));
    }

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
        add_portable_font_bytes(resources, FIXTURE_FONT, face_index)
    }

    fn add_portable_font_bytes(
        resources: &mut ResourceArena,
        bytes: &[u8],
        face_index: u32,
    ) -> FontFaceKey {
        let blob_key = FontBlobKey("test-blob".to_string());
        let face_key = FontFaceKey("test-face".to_string());
        let digest_value = crate::paint::resource_digest_hex(bytes);
        let digest = FontDigest {
            algorithm: "blake3".to_string(),
            value: digest_value.clone(),
        };
        let data_ref = BinaryResourceRef {
            kind: BinaryResourceKind::FontBlob,
            id: crate::paint::font_blob_resource_key(bytes.len(), &digest_value),
        };
        resources.intern_font_blob_bytes(bytes);
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
        let mut variant = variant();
        variant.requires = match payload_kind {
            GlyphOutlinePayloadKind::ColorLayers => vec![
                "text.glyphOutline.colorLayers".to_string(),
                "text.glyphOutline.colorLayers.colrV0".to_string(),
                "text.glyphOutline.colorLayers.colrV1".to_string(),
            ],
            GlyphOutlinePayloadKind::BitmapGlyph => {
                vec!["text.glyphOutline.bitmapGlyph".to_string()]
            }
            GlyphOutlinePayloadKind::SvgGlyph => {
                vec!["text.glyphOutline.svgGlyph".to_string()]
            }
            GlyphOutlinePayloadKind::MonochromeFill
            | GlyphOutlinePayloadKind::MonochromeFillStroke => Vec::new(),
        };
        LayerGlyphOutlinePaint {
            source: source_span(),
            variant,
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
            selected_runtime_conditions: vec![
                CanvasKitReplayRuntimeCondition::CanvasKitEncodedImageDecode,
            ],
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
                runtime_condition: Some(
                    CanvasKitReplayRuntimeCondition::CanvasKitEncodedImageDecode,
                ),
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
        assert!(json.contains("\"selectedRuntimeConditions\":[\"canvasKitEncodedImageDecode\"]"));
        assert!(json.contains("\"runtimeCondition\":\"canvasKitEncodedImageDecode\""));
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
            anchor_op_id: Some(anchor_op_id.clone()),
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
        assert_eq!(report.anchor_op_id.as_deref(), Some(anchor_op_id.as_str()));
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
        let image_id = resources.intern_image_bytes(FIXTURE_PNG);
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
        assert_eq!(
            report.selected_runtime_conditions,
            vec![CanvasKitReplayRuntimeCondition::CanvasKitEncodedImageDecode]
        );
        assert!(report.parts.iter().any(|part| {
            part.variant_id == "glyphOutline"
                && part.replayable
                && part.runtime_condition
                    == Some(CanvasKitReplayRuntimeCondition::CanvasKitEncodedImageDecode)
                && part.details.as_deref() == Some("colorSpaceDefaulted=srgb")
        }));
        assert!(plan.items.iter().any(|item| {
            item.path == "root/leaf/variantOps/0"
                && item.op_type == "glyphOutline"
                && item.status == CanvasKitReplayStatus::Direct
                && item.runtime_conditions
                    == vec![CanvasKitReplayRuntimeCondition::CanvasKitEncodedImageDecode]
        }));
        assert!(plan
            .to_json()
            .contains("\"selectedRuntimeConditions\":[\"canvasKitEncodedImageDecode\"]"));
    }

    #[test]
    fn canvaskit_replay_plan_marks_truncated_bitmap_glyph_as_runtime_conditional() {
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
        let image_id = resources.intern_image_bytes(&FIXTURE_PNG[..33]);
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
        assert_eq!(
            report.selected_runtime_conditions,
            vec![CanvasKitReplayRuntimeCondition::CanvasKitEncodedImageDecode]
        );
        assert!(report.parts.iter().any(|part| {
            part.variant_id == "glyphOutline"
                && part.replayable
                && part.runtime_condition
                    == Some(CanvasKitReplayRuntimeCondition::CanvasKitEncodedImageDecode)
        }));
        assert!(plan.items.iter().any(|item| {
            item.op_type == "glyphOutline"
                && item.status == CanvasKitReplayStatus::Direct
                && item.runtime_conditions
                    == vec![CanvasKitReplayRuntimeCondition::CanvasKitEncodedImageDecode]
        }));
    }

    #[test]
    fn canvaskit_replay_plan_keeps_text_fallback_for_undecodable_bitmap_glyph() {
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
        let image_id = resources.intern_image_bytes(b"RHWP");
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

        assert_eq!(report.selected_variant_id, "textRun");
        assert!(report.parts.iter().any(|part| {
            part.variant_id == "glyphOutline"
                && !part.replayable
                && part.reason == Some("unsupportedBitmapGlyph")
        }));
        assert!(plan.items.iter().any(|item| {
            item.path == "root/leaf/0"
                && item.op_type == "textRun"
                && item.status == CanvasKitReplayStatus::TextFallback
        }));
        assert!(plan.items.iter().any(|item| {
            item.path == "root/leaf/variantOps/0"
                && item.op_type == "glyphOutline"
                && item.status == CanvasKitReplayStatus::TextFallback
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
        assert_eq!(
            report.selected_runtime_conditions,
            vec![CanvasKitReplayRuntimeCondition::CanvasKitSvgPathConstruction]
        );
        assert!(report.parts.iter().any(|part| {
            part.variant_id == "glyphOutline"
                && part.replayable
                && part.reason.is_none()
                && part.runtime_condition
                    == Some(CanvasKitReplayRuntimeCondition::CanvasKitSvgPathConstruction)
        }));
        assert!(plan.items.iter().any(|item| {
            item.path == "root/leaf/variantOps/0"
                && item.op_type == "glyphOutline"
                && item.status == CanvasKitReplayStatus::Direct
                && item.runtime_conditions
                    == vec![CanvasKitReplayRuntimeCondition::CanvasKitSvgPathConstruction]
        }));
        assert!(plan
            .to_json()
            .contains("\"selectedRuntimeConditions\":[\"canvasKitSvgPathConstruction\"]"));
    }

    #[test]
    fn canvaskit_replay_plan_reports_image_payload_details() {
        let mut resources = ResourceArena::default();
        let background_image_id = resources.intern_image_bytes(FIXTURE_PNG);
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
                                opacity: 1.0,
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
                            original_size_hu: Some((300, 400)),
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

        let page_background_item = plan
            .items
            .iter()
            .find(|item| item.op_type == "pageBackground")
            .expect("page background image replay item");
        assert_eq!(page_background_item.status, CanvasKitReplayStatus::Direct);
        assert_eq!(
            page_background_item.runtime_conditions,
            vec![
                CanvasKitReplayRuntimeCondition::CanvasKitEncodedImageDecode,
                CanvasKitReplayRuntimeCondition::CanvasKitImageEffectPreprocess,
            ]
        );
        let page_background_detail = page_background_item
            .detail
            .as_deref()
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
        assert!(image_detail.contains("originalSizeHu=300x400"));
        assert!(image_detail.contains("effect=pattern8x8"));
        assert!(image_detail.contains("tone=brightness:15,contrast:-5"));
        assert!(image_detail.contains("transform=rotation:12.500,horzFlip:true,vertFlip:false"));
        assert!(image_detail.contains("missingImageData"));

        let json = plan.to_json();
        assert!(json.contains("\"detail\":\"fillMode=tileHorzBottom"));
        assert!(json.contains("effect=pattern8x8"));
        assert!(json.contains("\"runtimeCondition\":\"canvasKitEncodedImageDecode\""));
        assert!(json.contains(
            "\"runtimeConditions\":[\"canvasKitEncodedImageDecode\",\"canvasKitImageEffectPreprocess\"]"
        ));
    }

    #[test]
    fn canvaskit_replay_plan_marks_pattern_shapes_as_runtime_conditional() {
        let pattern_style = ShapeStyle {
            pattern: Some(PatternFillInfo {
                pattern_type: 6,
                pattern_color: 0x000000,
                background_color: 0xffffff,
            }),
            ..ShapeStyle::default()
        };
        let tree = PageLayerTree::new(
            100.0,
            100.0,
            LayerNode::leaf(
                valid_bbox(),
                None,
                vec![
                    PaintOp::Rectangle {
                        bbox: valid_bbox(),
                        rect: LayerRectanglePaint {
                            corner_radius: 0.0,
                            style: pattern_style.clone(),
                            gradient: None,
                            transform: ShapeTransform::default(),
                        },
                    },
                    PaintOp::Ellipse {
                        bbox: valid_bbox(),
                        ellipse: LayerEllipsePaint {
                            style: pattern_style.clone(),
                            gradient: None,
                            transform: ShapeTransform::default(),
                        },
                    },
                    PaintOp::Path {
                        bbox: valid_bbox(),
                        path: LayerPathPaint {
                            commands: vec![
                                PathCommand::MoveTo(0.0, 0.0),
                                PathCommand::LineTo(16.0, 16.0),
                            ],
                            style: pattern_style,
                            gradient: None,
                            transform: ShapeTransform::default(),
                            connector_endpoints: None,
                            line_style: None,
                        },
                    },
                    PaintOp::Rectangle {
                        bbox: valid_bbox(),
                        rect: LayerRectanglePaint {
                            corner_radius: 0.0,
                            style: ShapeStyle::default(),
                            gradient: None,
                            transform: ShapeTransform::default(),
                        },
                    },
                ],
            ),
        );

        let plan = analyze_canvaskit_replay_plan(&tree, CanvasKitReplayMode::Default);
        assert_eq!(plan.summary.direct_items, 4);
        for op_type in ["rectangle", "ellipse", "path"] {
            let item = plan
                .items
                .iter()
                .find(|item| item.op_type == op_type)
                .expect("pattern shape replay item");
            assert_eq!(
                item.runtime_conditions,
                vec![CanvasKitReplayRuntimeCondition::CanvasKitPatternImageConstruction],
                "{op_type} must declare runtime shader/image construction",
            );
        }
        let plain_rectangle = plan
            .items
            .iter()
            .filter(|item| item.op_type == "rectangle")
            .nth(1)
            .expect("plain rectangle replay item");
        assert!(plain_rectangle.runtime_conditions.is_empty());
        assert!(plan
            .to_json()
            .contains("\"runtimeConditions\":[\"canvasKitPatternImageConstruction\"]"));
    }

    #[test]
    fn canvaskit_pattern_runtime_condition_follows_gradient_precedence() {
        let pattern_style = ShapeStyle {
            pattern: Some(PatternFillInfo {
                pattern_type: 6,
                pattern_color: 0x000000,
                background_color: 0xffffff,
            }),
            ..ShapeStyle::default()
        };
        let gradient = |colors| GradientFillInfo {
            gradient_type: 1,
            angle: 0,
            center_x: 50,
            center_y: 50,
            colors,
            positions: vec![0.0, 1.0],
        };
        let tree = PageLayerTree::new(
            100.0,
            100.0,
            LayerNode::leaf(
                valid_bbox(),
                None,
                vec![
                    PaintOp::Rectangle {
                        bbox: valid_bbox(),
                        rect: LayerRectanglePaint {
                            corner_radius: 0.0,
                            style: pattern_style.clone(),
                            gradient: Some(Box::new(gradient(vec![0x000000, 0xffffff]))),
                            transform: ShapeTransform::default(),
                        },
                    },
                    PaintOp::Rectangle {
                        bbox: valid_bbox(),
                        rect: LayerRectanglePaint {
                            corner_radius: 0.0,
                            style: pattern_style,
                            gradient: Some(Box::new(gradient(vec![0x000000]))),
                            transform: ShapeTransform::default(),
                        },
                    },
                ],
            ),
        );

        let plan = analyze_canvaskit_replay_plan(&tree, CanvasKitReplayMode::Default);
        let rectangles = plan
            .items
            .iter()
            .filter(|item| item.op_type == "rectangle")
            .collect::<Vec<_>>();
        assert_eq!(rectangles.len(), 2);
        assert!(
            rectangles[0].runtime_conditions.is_empty(),
            "a valid gradient wins before the pattern path at runtime",
        );
        assert_eq!(
            rectangles[1].runtime_conditions,
            vec![CanvasKitReplayRuntimeCondition::CanvasKitPatternImageConstruction],
            "an unusable gradient falls through to pattern construction",
        );
    }

    #[test]
    fn canvaskit_replay_plan_reports_external_image_missing_and_header_admission() {
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
                        original_size_hu: None,
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
        assert!(missing_item.runtime_conditions.is_empty());
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
                        original_size_hu: None,
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
        assert!(dangling_item.runtime_conditions.is_empty());
        let detail = dangling_item.detail.as_deref().expect("image detail");
        assert!(detail.contains("externalImage"));
        assert!(detail.contains("missingImageData"));

        let mut resources = ResourceArena::default();
        let image_id = resources.intern_image_bytes(FIXTURE_PNG);
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
                        original_size_hu: None,
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
        assert_eq!(
            injected_item.runtime_conditions,
            vec![CanvasKitReplayRuntimeCondition::CanvasKitEncodedImageDecode]
        );
        let detail = injected_item.detail.as_deref().expect("image detail");
        assert!(detail.contains("externalImage"));
        assert!(detail.contains("imageHeaderAdmitted"));
        assert!(detail.contains("runtimeDecodeRequired"));
        assert!(injected_plan
            .to_json()
            .contains("\"runtimeCondition\":\"canvasKitEncodedImageDecode\""));
    }

    #[test]
    fn canvaskit_replay_plan_and_preflight_reject_statically_invalid_image_resources() {
        let mut resources = ResourceArena::default();
        let image_id = resources.intern_image_bytes(&[0x89, b'P', b'N', b'G']);
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
                                resource_id: image_id,
                                fill_mode: ImageFillMode::FitToSize,
                                brightness: 0,
                                contrast: 0,
                                effect: ImageEffect::RealPic,
                                opacity: 1.0,
                            }),
                        },
                    },
                    PaintOp::Image {
                        bbox: valid_bbox(),
                        image: LayerImagePaint {
                            resource_id: Some(image_id),
                            external_path: None,
                            text_wrap: None,
                            fill_mode: None,
                            original_size: None,
                            crop: None,
                            original_size_hu: None,
                            brightness: 0,
                            contrast: 0,
                            effect: ImageEffect::RealPic,
                            transform: ShapeTransform::default(),
                        },
                    },
                ],
            ),
        )
        .resources(resources)
        .build();

        let plan = analyze_canvaskit_replay_plan(&tree, CanvasKitReplayMode::Default);

        assert_eq!(plan.summary.direct_required_items, 2);
        assert!(plan.items.iter().all(|item| {
            item.status == CanvasKitReplayStatus::DirectRequired
                && item
                    .detail
                    .as_deref()
                    .is_some_and(|detail| detail.contains("encodedImageRejected"))
        }));

        let preflight = analyze_canvaskit_document_preflight_with_limits(
            1,
            CanvasKitReplayMode::Default,
            RenderProfile::Screen,
            CanvasKitDocumentPreflightLimits {
                max_pages: 1,
                max_work_units: 16,
                max_blockers: 4,
                max_required_font_families: 1,
            },
            move |_, _| {
                Ok::<_, &'static str>(CanvasKitPreflightPageBuild::Complete {
                    tree: Box::new(tree.clone()),
                    prelower_work_units: 0,
                })
            },
        );

        assert_eq!(
            preflight.status,
            CanvasKitDocumentPreflightStatus::Ineligible
        );
        assert!(!preflight.eligible);
        assert!(preflight.complete);
        assert_eq!(preflight.summary.direct_required_items, 2);
        assert_eq!(preflight.summary.unsupported_items, 0);
        assert_eq!(preflight.blockers.len(), 2);
        assert_eq!(
            preflight.blockers[0].code,
            CanvasKitDocumentPreflightBlockerCode::Unsupported
        );
        assert_eq!(preflight.blockers[0].op_type, Some("pageBackground"));
        assert_eq!(
            preflight.blockers[1].code,
            CanvasKitDocumentPreflightBlockerCode::Unsupported
        );
        assert_eq!(preflight.blockers[1].op_type, Some("image"));
        assert!(preflight.blockers.iter().all(|blocker| blocker
            .detail
            .as_deref()
            .is_some_and(|detail| detail.contains("encodedImageRejected"))));

        let json = preflight.to_json();
        assert!(json.contains("\"directRequiredItems\":2"));
        assert!(json.contains("\"code\":\"unsupported\",\"opType\":\"pageBackground\""));
        assert!(json.contains("\"code\":\"unsupported\",\"opType\":\"image\""));
    }

    #[test]
    fn canvaskit_marks_header_admitted_images_as_runtime_conditional() {
        let truncated_png = &FIXTURE_PNG[..33];
        assert!(canvaskit_encoded_image_is_replayable(truncated_png));

        let mut resources = ResourceArena::default();
        let image_id = resources.intern_image_bytes(truncated_png);
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
                                resource_id: image_id,
                                fill_mode: ImageFillMode::FitToSize,
                                brightness: 0,
                                contrast: 0,
                                effect: ImageEffect::RealPic,
                                opacity: 1.0,
                            }),
                        },
                    },
                    PaintOp::Image {
                        bbox: valid_bbox(),
                        image: LayerImagePaint {
                            resource_id: Some(image_id),
                            external_path: None,
                            text_wrap: None,
                            fill_mode: None,
                            original_size: None,
                            crop: None,
                            original_size_hu: None,
                            brightness: 0,
                            contrast: 0,
                            effect: ImageEffect::RealPic,
                            transform: ShapeTransform::default(),
                        },
                    },
                ],
            ),
        )
        .resources(resources)
        .build();

        let plan = analyze_canvaskit_replay_plan(&tree, CanvasKitReplayMode::Default);
        assert_eq!(plan.summary.direct_items, 2);
        assert_eq!(plan.summary.direct_required_items, 0);
        assert!(plan.items.iter().all(|item| {
            item.status == CanvasKitReplayStatus::Direct
                && item.runtime_conditions
                    == vec![CanvasKitReplayRuntimeCondition::CanvasKitEncodedImageDecode]
                && item.detail.as_deref().is_some_and(|detail| {
                    detail.contains("imageHeaderAdmitted")
                        && detail.contains("runtimeDecodeRequired")
                })
        }));
        let json = plan.to_json();
        assert_eq!(
            json.matches("\"runtimeCondition\":\"canvasKitEncodedImageDecode\"")
                .count(),
            2
        );
    }

    #[test]
    fn canvaskit_marks_svg_images_as_browser_decode_conditional() {
        let mut resources = ResourceArena::default();
        let image_id = resources.intern_image_bytes(
            br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M0 0 L16 16"/></svg>"#,
        );
        let tree = PageLayerTree::builder(
            100.0,
            100.0,
            LayerNode::leaf(
                valid_bbox(),
                None,
                vec![PaintOp::Image {
                    bbox: valid_bbox(),
                    image: LayerImagePaint {
                        resource_id: Some(image_id),
                        external_path: None,
                        text_wrap: None,
                        fill_mode: None,
                        original_size: None,
                        crop: None,
                        original_size_hu: None,
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

        let plan = analyze_canvaskit_replay_plan(&tree, CanvasKitReplayMode::Default);
        let item = plan.items.first().expect("SVG image replay item");
        assert_eq!(item.status, CanvasKitReplayStatus::Direct);
        assert_eq!(
            item.runtime_conditions,
            vec![CanvasKitReplayRuntimeCondition::BrowserSvgImageDecode]
        );
        assert!(plan
            .to_json()
            .contains("\"runtimeCondition\":\"browserSvgImageDecode\""));
    }

    #[test]
    fn canvaskit_rejects_oversized_compact_images_before_decode() {
        let mut resources = ResourceArena::default();
        let image_id = resources.intern_image_bytes(&compact_bmp(8193, 1));
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
                                resource_id: image_id,
                                fill_mode: ImageFillMode::FitToSize,
                                brightness: 0,
                                contrast: 0,
                                effect: ImageEffect::RealPic,
                                opacity: 1.0,
                            }),
                        },
                    },
                    PaintOp::Image {
                        bbox: valid_bbox(),
                        image: LayerImagePaint {
                            resource_id: Some(image_id),
                            external_path: None,
                            text_wrap: None,
                            fill_mode: None,
                            original_size: None,
                            crop: None,
                            original_size_hu: None,
                            brightness: 0,
                            contrast: 0,
                            effect: ImageEffect::RealPic,
                            transform: ShapeTransform::default(),
                        },
                    },
                ],
            ),
        )
        .resources(resources.clone())
        .build();

        let plan = analyze_canvaskit_replay_plan(&tree, CanvasKitReplayMode::Default);
        assert_eq!(plan.summary.direct_required_items, 2);
        assert!(plan.items.iter().all(|item| {
            item.status == CanvasKitReplayStatus::DirectRequired
                && item
                    .detail
                    .as_deref()
                    .is_some_and(|detail| detail.contains("encodedImageRejected"))
        }));

        let mut outline = outline(GlyphOutlinePayloadKind::BitmapGlyph);
        outline.bitmap_glyph = Some(bitmap_payload(image_id));
        assert_eq!(
            canvaskit_glyph_outline_payload_status(&outline, Some(valid_bbox()), &tree.resources,),
            (false, Some(VariantRejectReason::UnsupportedBitmapGlyph))
        );
    }

    #[test]
    fn canvaskit_replay_plan_sees_raw_svg_data_image_as_resource_image() {
        let bbox = BoundingBox::new(10.0, 20.0, 120.0, 40.0);
        let mut render_tree = PageRenderTree::new(0, 200.0, 120.0);
        render_tree.root.children.push(RenderNode::new(
            1,
            RenderNodeType::RawSvg(RawSvgNode {
                svg: r#"<image x="10" y="20" width="120" height="40" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="/>"#.to_string(),
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
        assert_eq!(
            image_item.runtime_conditions,
            vec![CanvasKitReplayRuntimeCondition::CanvasKitEncodedImageDecode]
        );
        assert!(
            image_item
                .detail
                .as_deref()
                .is_some_and(|detail| detail.contains("imageHeaderAdmitted")
                    && detail.contains("runtimeDecodeRequired")
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
    fn canvaskit_rejects_invalid_monochrome_outline_paths() {
        let resources = ResourceArena::default();
        let empty = outline(GlyphOutlinePayloadKind::MonochromeFill);
        assert_eq!(
            canvaskit_glyph_outline_payload_status(&empty, Some(valid_bbox()), &resources),
            (false, Some(VariantRejectReason::EmptyGlyphOutlinePayload))
        );

        let mut reversed_source = outline_path();
        reversed_source.source_range_utf8 = TextSourceRange::new(2, 1);
        let mut reversed_glyphs = outline_path();
        reversed_glyphs.glyph_range = GlyphRange::new(2, 1);
        let mut empty_commands = outline_path();
        empty_commands.commands.clear();
        let mut non_finite_command = outline_path();
        non_finite_command.commands[0] = PathCommand::MoveTo(f64::NAN, 0.0);

        for (case_name, path) in [
            ("reversed-source-range", reversed_source),
            ("reversed-glyph-range", reversed_glyphs),
            ("empty-commands", empty_commands),
            ("non-finite-command", non_finite_command),
        ] {
            let mut outline = outline(GlyphOutlinePayloadKind::MonochromeFill);
            outline.paths.push(path);
            assert_eq!(
                canvaskit_glyph_outline_payload_status(&outline, Some(valid_bbox()), &resources,),
                (false, Some(VariantRejectReason::UnsupportedOutlinePayload)),
                "{case_name}"
            );
        }
    }

    #[test]
    fn canvaskit_ignores_legacy_paths_for_richer_outline_payloads() {
        let mut resources = ResourceArena::default();
        let image_id = resources.intern_image_bytes(FIXTURE_PNG);
        let svg_id = resources
            .intern_svg_fragment("<path d=\"M0 0 L16 0 L16 16 L0 16 Z\" fill=\"#00ffff\"/>");
        let mut stale_path = outline_path();
        stale_path.source_range_utf8 = TextSourceRange::new(2, 1);
        stale_path.glyph_range = GlyphRange::new(2, 1);
        stale_path.commands.clear();

        let mut color = outline(GlyphOutlinePayloadKind::ColorLayers);
        color.color_layers = Some(colrv0_payload());
        color.paths.push(stale_path.clone());

        let mut bitmap = outline(GlyphOutlinePayloadKind::BitmapGlyph);
        bitmap.bitmap_glyph = Some(bitmap_payload(image_id));
        bitmap.paths.push(stale_path.clone());

        let mut svg = outline(GlyphOutlinePayloadKind::SvgGlyph);
        svg.svg_glyph = Some(svg_payload(svg_id));
        svg.paths.push(stale_path);

        for (case_name, outline) in [
            ("color-layers", color),
            ("bitmap-glyph", bitmap),
            ("svg-glyph", svg),
        ] {
            assert_eq!(
                canvaskit_glyph_outline_payload_status(&outline, Some(valid_bbox()), &resources,),
                (true, None),
                "{case_name}"
            );
        }
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
        let report = status
            .font_verification
            .expect("the positive control should prove portable resource admission");
        assert_eq!(report.blob_resolved, Some(true));
        assert_eq!(report.digest_matched, Some(true));
        assert_eq!(report.exact_face_instantiated, None);
        assert!(report.replay_eligible);
    }

    #[test]
    fn canvaskit_marks_selected_glyph_run_as_typeface_construction_conditional() {
        let mut resources = ResourceArena::default();
        let face_key = add_portable_test_font(&mut resources, 0);
        let text = text_run_op("text-0");
        let glyph = PaintOp::GlyphRun {
            bbox: valid_bbox(),
            run: glyph_run(face_key, Vec::new()),
        };
        let tree = PageLayerTree::builder(
            100.0,
            100.0,
            LayerNode::leaf(valid_bbox(), None, vec![text, glyph]),
        )
        .resources(resources)
        .build();

        let plan = analyze_canvaskit_replay_plan(&tree, CanvasKitReplayMode::Default);
        let report = plan
            .text_variants
            .iter()
            .find(|report| report.equivalence_group == "text-0")
            .expect("GlyphRun variant report");

        assert_eq!(report.selected_variant_id, "glyphRun");
        assert_eq!(
            report.selected_runtime_conditions,
            vec![CanvasKitReplayRuntimeCondition::CanvasKitTypefaceConstruction]
        );
        assert!(report.parts.iter().any(|part| {
            part.variant_id == "glyphRun"
                && part.runtime_condition
                    == Some(CanvasKitReplayRuntimeCondition::CanvasKitTypefaceConstruction)
        }));
        assert!(plan.items.iter().any(|item| {
            item.op_type == "glyphRun"
                && item.status == CanvasKitReplayStatus::Direct
                && item.runtime_conditions
                    == vec![CanvasKitReplayRuntimeCondition::CanvasKitTypefaceConstruction]
        }));
        assert!(plan
            .to_json()
            .contains("\"selectedRuntimeConditions\":[\"canvasKitTypefaceConstruction\"]"));
    }

    #[test]
    fn canvaskit_rejects_portable_font_metadata_without_matching_resource_bytes() {
        let mut populated = ResourceArena::default();
        let face_key = add_portable_test_font(&mut populated, 0);
        let font_resources = populated.font_resources().clone();
        let mut resources = ResourceArena::default();
        *resources.font_resources_mut() = font_resources;
        let run = glyph_run(face_key, Vec::new());

        let status = canvaskit_glyph_run_replay_status(&run, &resources);

        assert!(!status.replayable);
        assert_eq!(
            status.reason,
            Some(VariantRejectReason::FontBlobNotVerified)
        );
        let report = status
            .font_verification
            .expect("missing font bytes should carry resource diagnostics");
        assert_eq!(report.blob_resolved, Some(false));
        assert_eq!(report.digest_matched, Some(false));
    }

    #[test]
    fn canvaskit_rejects_portable_font_resource_digest_mismatch() {
        let mut resources = ResourceArena::default();
        let face_key = add_portable_test_font(&mut resources, 0);
        let wrong_digest = FontDigest {
            algorithm: "blake3".to_string(),
            value: "wrong-digest".to_string(),
        };
        let blob = &mut resources.font_resources_mut().blobs[0];
        blob.digest = Some(wrong_digest.clone());
        let data_ref = blob.data_ref.clone().expect("portable font data ref");
        blob.portability = FontPortability::PortableBlob {
            digest: wrong_digest,
            data_ref,
        };
        let run = glyph_run(face_key, Vec::new());

        let status = canvaskit_glyph_run_replay_status(&run, &resources);

        assert!(!status.replayable);
        assert_eq!(status.reason, Some(VariantRejectReason::FontDigestMismatch));
        let report = status
            .font_verification
            .expect("digest mismatch should carry resource diagnostics");
        assert_eq!(report.blob_resolved, Some(true));
        assert_eq!(report.digest_matched, Some(false));
    }

    #[test]
    fn canvaskit_accepts_simple_glyph_run_shadow_outline_and_relief_effects() {
        let mut resources = ResourceArena::default();
        let face_key = add_portable_test_font(&mut resources, 0);
        let mut shadow = glyph_run(face_key.clone(), Vec::new());
        shadow.paint_style.shadow_type = 1;
        shadow.paint_style.shadow_offset_x = 4.0;
        shadow.paint_style.shadow_offset_y = 2.0;
        let mut outline = glyph_run(face_key.clone(), Vec::new());
        outline.paint_style.outline_type = 1;
        let mut emboss = glyph_run(face_key.clone(), Vec::new());
        emboss.paint_style.emboss = true;
        let mut engrave = glyph_run(face_key, Vec::new());
        engrave.paint_style.engrave = true;

        for (case_name, run) in [
            ("shadow", shadow),
            ("outline", outline),
            ("emboss", emboss),
            ("engrave", engrave),
        ] {
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
        assert_eq!(
            status
                .font_verification
                .as_ref()
                .and_then(|report| report.digest_matched),
            Some(true)
        );
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
    fn canvaskit_rejects_nonzero_face_index_without_a_matching_collection_face() {
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
    fn canvaskit_accepts_exact_nonzero_collection_face_for_runtime_normalization() {
        let mut resources = ResourceArena::default();
        let face_key = add_portable_font_bytes(&mut resources, FIXTURE_TTC, 1);
        let run = glyph_run(face_key, Vec::new());

        let status = canvaskit_glyph_run_replay_status(&run, &resources);

        assert!(status.replayable, "{status:?}");
        assert_eq!(status.reason, None);
        let font_report = status
            .font_verification
            .expect("exact collection face should carry verification");
        assert_eq!(font_report.blob_resolved, Some(true));
        assert_eq!(font_report.digest_matched, Some(true));
        assert_eq!(font_report.face_index_supported, Some(true));
        assert!(font_report.replay_eligible);
    }

    #[test]
    fn canvaskit_rejects_out_of_range_collection_face_before_runtime() {
        let mut resources = ResourceArena::default();
        let face_key = add_portable_font_bytes(&mut resources, FIXTURE_TTC, 2);
        let run = glyph_run(face_key, Vec::new());

        let status = canvaskit_glyph_run_replay_status(&run, &resources);

        assert!(!status.replayable);
        assert_eq!(
            status.reason,
            Some(VariantRejectReason::FaceIndexUnsupported)
        );
        let font_report = status
            .font_verification
            .expect("out-of-range collection face should carry verification");
        assert_eq!(font_report.blob_resolved, Some(true));
        assert_eq!(font_report.digest_matched, Some(true));
        assert_eq!(font_report.face_index_supported, Some(false));
        assert!(!font_report.replay_eligible);
    }

    #[test]
    fn canvaskit_rejects_out_of_range_glyph_ids_before_replay() {
        let mut resources = ResourceArena::default();
        let face_key = add_portable_test_font(&mut resources, 0);
        for (case_name, glyph_id) in [
            ("missing-glyph-zero", 0),
            ("above-u16", u32::from(u16::MAX) + 1),
        ] {
            let mut run = glyph_run(face_key.clone(), Vec::new());
            run.glyph_ids[0] = glyph_id;

            let status = canvaskit_glyph_run_replay_status(&run, &resources);

            assert!(!status.replayable, "{case_name}");
            assert_eq!(
                status.reason,
                Some(VariantRejectReason::GlyphIdOutOfRange),
                "{case_name}"
            );
            assert!(
                status.font_verification.is_none(),
                "the glyph id range guard should reject before backend font construction for {case_name}"
            );
        }
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
        let mut float32_overflow_position = nonfinite_position.clone();
        float32_overflow_position.positions[0].x = f32::MAX as f64 * 2.0;
        let mut nonfinite_advance = nonfinite_position.clone();
        nonfinite_advance.positions[0].x = 0.0;
        nonfinite_advance.advances = Some(vec![LayerVector {
            dx: f64::NAN,
            dy: 0.0,
        }]);
        let mut invalid_font_instance = nonfinite_advance.clone();
        invalid_font_instance.advances = None;
        invalid_font_instance.shape_key.font_instance.size_px = 0.0;
        let mut direction_mismatch = invalid_font_instance.clone();
        direction_mismatch.shape_key.font_instance.size_px = 12.0;
        direction_mismatch.direction = TextDirection::Rtl;
        let mut writing_mode_mismatch = direction_mismatch.clone();
        writing_mode_mismatch.direction = TextDirection::Ltr;
        writing_mode_mismatch.writing_mode = WritingMode::VerticalRl;
        let mut oversized = writing_mode_mismatch.clone();
        oversized.writing_mode = WritingMode::HorizontalTb;
        oversized.glyph_ids = vec![1; 4097];
        oversized.positions = vec![LayerPoint { x: 0.0, y: 0.0 }; 4097];

        for (case_name, run, expected_reason) in [
            (
                "empty-glyphs",
                empty_glyphs,
                VariantRejectReason::EmptyGlyphRun,
            ),
            (
                "mismatched-positions",
                mismatched_positions,
                VariantRejectReason::GlyphPositionCountMismatch,
            ),
            (
                "mismatched-advances",
                mismatched_advances,
                VariantRejectReason::GlyphAdvanceCountMismatch,
            ),
            (
                "nonfinite-transform",
                nonfinite_transform,
                VariantRejectReason::PlacementNotFinite,
            ),
            (
                "nonfinite-baseline",
                nonfinite_baseline,
                VariantRejectReason::PlacementNotFinite,
            ),
            (
                "nonfinite-position",
                nonfinite_position,
                VariantRejectReason::PositionNotFinite,
            ),
            (
                "float32-overflow-position",
                float32_overflow_position,
                VariantRejectReason::PositionNotFinite,
            ),
            (
                "nonfinite-advance",
                nonfinite_advance,
                VariantRejectReason::AdvanceNotFinite,
            ),
            (
                "invalid-font-instance",
                invalid_font_instance,
                VariantRejectReason::FontInstanceInvalid,
            ),
            (
                "direction-mismatch",
                direction_mismatch,
                VariantRejectReason::GlyphRunMetadataMismatch,
            ),
            (
                "writing-mode-mismatch",
                writing_mode_mismatch,
                VariantRejectReason::GlyphRunMetadataMismatch,
            ),
            (
                "oversized",
                oversized,
                VariantRejectReason::GlyphRunTooLarge,
            ),
        ] {
            let status = canvaskit_glyph_run_replay_status(&run, &resources);

            assert!(!status.replayable, "{case_name}");
            assert_eq!(status.reason, Some(expected_reason), "{case_name}");
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
        let mut fallback_font_used = glyph_run(face_key.clone(), Vec::new());
        fallback_font_used.diagnostics.used_fallback_font_count = 1;
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
                "fallback-font-used",
                fallback_font_used,
                VariantRejectReason::DiagnosticsNotClean,
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
    fn canvaskit_reports_conditional_external_font_verification_gate() {
        let mut resources = ResourceArena::default();
        let face_key = add_portable_test_font(&mut resources, 0);
        let mut run = glyph_run(face_key, Vec::new());
        run.diagnostics.replay_eligibility = GlyphRunReplayEligibility::ConditionalExternalFont;

        let status = canvaskit_glyph_run_replay_status(&run, &resources);

        assert!(!status.replayable);
        assert_eq!(
            status.reason,
            Some(VariantRejectReason::ExternalFontNotVerified)
        );
        let verification = status
            .font_verification
            .expect("conditional external font verification report");
        assert_eq!(
            verification.reason,
            Some(VariantRejectReason::ExternalFontNotVerified)
        );
        assert!(!verification.replay_eligible);
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
        let image_id = resources.intern_image_bytes(FIXTURE_PNG);
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
    fn canvaskit_requires_richer_outline_payload_features() {
        let mut resources = ResourceArena::default();
        let image_id = resources.intern_image_bytes(FIXTURE_PNG);
        let svg_id = resources
            .intern_svg_fragment("<path d=\"M0 0 L16 0 L16 16 L0 16 Z\" fill=\"#00ffff\"/>");

        let mut color = outline(GlyphOutlinePayloadKind::ColorLayers);
        color.color_layers = Some(colrv0_payload());
        color
            .variant
            .requires
            .retain(|feature| feature != "text.glyphOutline.colorLayers.colrV0");

        let mut bitmap = outline(GlyphOutlinePayloadKind::BitmapGlyph);
        bitmap.bitmap_glyph = Some(bitmap_payload(image_id));
        bitmap.variant.requires.clear();

        let mut svg = outline(GlyphOutlinePayloadKind::SvgGlyph);
        svg.svg_glyph = Some(svg_payload(svg_id));
        svg.variant.requires.clear();

        for (case_name, outline, reason) in [
            ("colrv0", color, VariantRejectReason::UnsupportedColorGlyph),
            (
                "bitmap",
                bitmap,
                VariantRejectReason::UnsupportedBitmapGlyph,
            ),
            ("svg", svg, VariantRejectReason::UnsupportedSvgGlyph),
        ] {
            assert_eq!(
                canvaskit_glyph_outline_payload_status(&outline, Some(valid_bbox()), &resources,),
                (false, Some(reason)),
                "{case_name}"
            );
        }
    }

    #[test]
    fn canvaskit_requires_bitmap_strict_visual_contract() {
        let mut resources = ResourceArena::default();
        let image_id = resources.intern_image_bytes(FIXTURE_PNG);
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

        let svg_image_id = resources.intern_image_bytes(
            br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M0 0 L16 16"/></svg>"#,
        );
        outline.bitmap_glyph = Some(bitmap_payload(svg_image_id));
        assert_eq!(
            canvaskit_glyph_outline_payload_status(&outline, Some(valid_bbox()), &resources),
            (false, Some(VariantRejectReason::UnsupportedBitmapGlyph))
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
        let malformed_svg_id = resources.intern_svg_fragment("<path d=\"not-a-path\"/>");
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

        outline.svg_glyph = Some(svg_payload(malformed_svg_id));
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
        assert!(!canvaskit_static_svg_fragment_has_path_layer(
            "<path d=\"not-a-path\"/>"
        ));
        assert!(!canvaskit_static_svg_fragment_has_path_layer(
            "<path d=\"M0 0 L16 16\"/><path d=\"not-a-path\"/>"
        ));
        assert!(!canvaskit_static_svg_fragment_has_path_layer(
            "<path d=\"M0 0 L16 16\" transform=\"scale(1e308) scale(1e308)\"/>"
        ));
        assert!(!canvaskit_static_svg_fragment_has_path_layer(
            "<svg><g><path d=\"M0 0 L16 16\"/></svg></g>"
        ));
    }

    #[test]
    fn replay_plan_reports_required_font_families() {
        let mut text = text_run_op("text-0");
        let PaintOp::TextRun { run, .. } = &mut text else {
            unreachable!("helper returns textRun");
        };
        run.style.font_family = "Test Family".to_string();
        run.variant = None;
        let tree = PageLayerTree::new(
            100.0,
            100.0,
            LayerNode::leaf(valid_bbox(), None, vec![text]),
        );

        let plan = analyze_canvaskit_replay_plan(&tree, CanvasKitReplayMode::Default);

        assert_eq!(plan.required_font_families, ["Test Family"]);
        assert!(plan.required_font_families_complete);
        assert!(plan
            .to_json()
            .contains("\"requiredFontFamilies\":[\"Test Family\"]"));
    }

    #[test]
    fn replay_plan_uses_display_projection_for_old_hangul_font_requirements() {
        let mut text = text_run_op("text-0");
        let PaintOp::TextRun { run, .. } = &mut text else {
            unreachable!("helper returns textRun");
        };
        run.text = "\u{E1A7}".to_string();
        run.style.font_family = "Test Family".to_string();
        run.variant = None;
        let tree = PageLayerTree::new(
            100.0,
            100.0,
            LayerNode::leaf(valid_bbox(), None, vec![text]),
        );

        let plan = analyze_canvaskit_replay_plan(&tree, CanvasKitReplayMode::Default);

        assert_eq!(
            plan.required_font_families,
            [CANVASKIT_OLD_HANGUL_FONT_FAMILY, "Test Family"]
        );
        assert!(plan.required_font_families_complete);
    }

    #[test]
    fn document_preflight_keeps_text_fallback_inventory_eligible() {
        let mut text = text_run_op("text-0");
        let PaintOp::TextRun { run, .. } = &mut text else {
            unreachable!("helper returns textRun");
        };
        run.style.font_family = "Test Family".to_string();
        run.variant = None;
        let tree = PageLayerTree::new(
            100.0,
            100.0,
            LayerNode::leaf(valid_bbox(), None, vec![text]),
        );
        let preflight = analyze_canvaskit_document_preflight_with_limits(
            1,
            CanvasKitReplayMode::Default,
            RenderProfile::FastPreview,
            CanvasKitDocumentPreflightLimits {
                max_pages: 4,
                max_work_units: 16,
                max_blockers: 4,
                max_required_font_families: 8,
            },
            move |_, _| {
                Ok::<_, &'static str>(CanvasKitPreflightPageBuild::Complete {
                    tree: Box::new(tree.clone()),
                    prelower_work_units: 0,
                })
            },
        );

        assert_eq!(
            preflight.status,
            CanvasKitDocumentPreflightStatus::Eligible,
            "{preflight:?}"
        );
        assert!(preflight.eligible);
        assert!(preflight.complete);
        assert_eq!(preflight.scanned_pages, 1);
        assert_eq!(preflight.scanned_work_units, 2);
        assert_eq!(preflight.summary.text_fallback_items, 1);
        assert!(preflight.blockers.is_empty(), "{preflight:?}");
        assert_eq!(preflight.required_font_families, ["Test Family"]);
        assert!(preflight.capability_digest.starts_with("blake3:"));
        let json = preflight.to_json();
        assert!(json.contains("\"profile\":\"fast-preview\""));
        assert!(json.contains("\"status\":\"eligible\""));
    }

    #[test]
    fn document_preflight_allows_rejected_glyph_run_with_text_fallback() {
        let text = text_run_op("text-0");
        let glyph = PaintOp::GlyphRun {
            bbox: valid_bbox(),
            run: glyph_run(FontFaceKey("missing-face".to_string()), Vec::new()),
        };
        let tree = PageLayerTree::new(
            100.0,
            100.0,
            LayerNode::leaf(valid_bbox(), None, vec![text, glyph]),
        );
        let preflight = analyze_canvaskit_document_preflight_with_limits(
            1,
            CanvasKitReplayMode::Default,
            RenderProfile::Screen,
            CanvasKitDocumentPreflightLimits {
                max_pages: 4,
                max_work_units: 16,
                max_blockers: 4,
                max_required_font_families: 8,
            },
            move |_, _| {
                Ok::<_, &'static str>(CanvasKitPreflightPageBuild::Complete {
                    tree: Box::new(tree.clone()),
                    prelower_work_units: 0,
                })
            },
        );

        assert_eq!(
            preflight.status,
            CanvasKitDocumentPreflightStatus::Eligible,
            "{preflight:?}"
        );
        assert!(preflight.eligible);
        assert!(preflight.complete);
        assert_eq!(preflight.summary.text_fallback_items, 2);
        assert_eq!(preflight.summary.unsupported_items, 0);
        assert!(preflight.blockers.is_empty(), "{preflight:?}");
    }

    #[test]
    fn document_preflight_rejects_text_group_without_supported_variant() {
        let glyph = PaintOp::GlyphRun {
            bbox: valid_bbox(),
            run: glyph_run(FontFaceKey("missing-face".to_string()), Vec::new()),
        };
        let tree = PageLayerTree::new(
            100.0,
            100.0,
            LayerNode::leaf(valid_bbox(), None, vec![glyph]),
        );
        let preflight = analyze_canvaskit_document_preflight_with_limits(
            1,
            CanvasKitReplayMode::Default,
            RenderProfile::Screen,
            CanvasKitDocumentPreflightLimits {
                max_pages: 4,
                max_work_units: 16,
                max_blockers: 4,
                max_required_font_families: 8,
            },
            move |_, _| {
                Ok::<_, &'static str>(CanvasKitPreflightPageBuild::Complete {
                    tree: Box::new(tree.clone()),
                    prelower_work_units: 0,
                })
            },
        );

        assert_eq!(
            preflight.status,
            CanvasKitDocumentPreflightStatus::Ineligible,
            "{preflight:?}"
        );
        assert!(!preflight.eligible);
        assert!(preflight.complete);
        assert_eq!(preflight.summary.text_fallback_items, 1);
        assert_eq!(preflight.summary.unsupported_items, 0);
        assert_eq!(preflight.blockers.len(), 1, "{preflight:?}");
        assert_eq!(
            preflight.blockers[0].code,
            CanvasKitDocumentPreflightBlockerCode::Unsupported
        );
        assert_eq!(preflight.blockers[0].op_type, Some("textVariant"));
        assert_eq!(
            preflight.blockers[0].detail.as_deref(),
            Some("equivalenceGroup=text-0;reason=noSupportedVariant")
        );
    }

    #[test]
    fn document_preflight_stops_at_bounded_work_limit() {
        let tree = PageLayerTree::new(
            100.0,
            100.0,
            LayerNode::leaf(valid_bbox(), None, vec![text_run_op("text-0")]),
        );
        let preflight = analyze_canvaskit_document_preflight_with_limits(
            1,
            CanvasKitReplayMode::Default,
            RenderProfile::Screen,
            CanvasKitDocumentPreflightLimits {
                max_pages: 4,
                max_work_units: 1,
                max_blockers: 4,
                max_required_font_families: 8,
            },
            move |_, _| {
                Ok::<_, &'static str>(CanvasKitPreflightPageBuild::Complete {
                    tree: Box::new(tree.clone()),
                    prelower_work_units: 0,
                })
            },
        );

        assert_eq!(
            preflight.status,
            CanvasKitDocumentPreflightStatus::Incomplete
        );
        assert!(!preflight.complete);
        assert_eq!(preflight.scanned_pages, 0);
    }

    #[test]
    fn document_preflight_counts_source_and_expanded_display_text() {
        let mut text = text_run_op("text-0");
        let PaintOp::TextRun { run, .. } = &mut text else {
            unreachable!("helper returns textRun");
        };
        run.text = "\u{E1A7}".repeat(128);
        run.variant = None;
        let tree = PageLayerTree::new(
            100.0,
            100.0,
            LayerNode::leaf(valid_bbox(), None, vec![text]),
        );
        let preflight = analyze_canvaskit_document_preflight_with_limits(
            1,
            CanvasKitReplayMode::Default,
            RenderProfile::Screen,
            CanvasKitDocumentPreflightLimits {
                max_pages: 1,
                max_work_units: 2,
                max_blockers: 4,
                max_required_font_families: 8,
            },
            move |_, _| {
                Ok::<_, &'static str>(CanvasKitPreflightPageBuild::Complete {
                    tree: Box::new(tree.clone()),
                    prelower_work_units: 0,
                })
            },
        );

        assert_eq!(
            preflight.status,
            CanvasKitDocumentPreflightStatus::Incomplete
        );
        assert!(!preflight.complete);
        assert_eq!(preflight.scanned_pages, 0);
    }

    #[test]
    fn prelower_estimate_counts_expanded_display_text() {
        let mut tree = PageRenderTree::new(0, 100.0, 100.0);
        tree.root.children.push(RenderNode::new(
            1,
            RenderNodeType::TextRun(TextRunNode {
                text: "\u{E1A7}".repeat(128),
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
                field_marker: FieldMarkerType::None,
            }),
            valid_bbox(),
        ));

        assert_eq!(
            estimate_canvaskit_page_lowering_work(&tree, 12),
            CanvasKitBoundedWorkCount::Exceeded
        );
    }

    #[test]
    fn prelower_estimate_rejects_oversized_text_like_payloads() {
        let mut tree = PageRenderTree::new(0, 100.0, 100.0);
        tree.root.children.push(RenderNode::new(
            1,
            RenderNodeType::RawSvg(RawSvgNode {
                svg: "x".repeat(CANVASKIT_DOCUMENT_PREFLIGHT_MAX_TEXT_BYTES + 1),
            }),
            valid_bbox(),
        ));

        assert_eq!(
            estimate_canvaskit_page_lowering_work(&tree, 50_000),
            CanvasKitBoundedWorkCount::Exceeded
        );
    }
}
