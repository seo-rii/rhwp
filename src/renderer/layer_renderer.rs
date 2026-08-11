use crate::model::ColorRef;
use crate::paint::paint_op::StrictGlyphRunPayloadError;
use crate::paint::{
    LineBreakShadowReport, PageLayerTree, PaintOp, ShapedMeasurementLineReport,
    ShapedMeasurementPageSummary, ShapedMeasurementParagraphSummary, ShapedMeasurementRunReport,
    TextVariantKind,
};
use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::fmt;

pub type LayerRenderResult<T> = Result<T, LayerRenderError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayerRenderError {
    pub kind: LayerRenderErrorKind,
    pub message: String,
}

impl LayerRenderError {
    pub fn new(kind: LayerRenderErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn invalid_options(message: impl Into<String>) -> Self {
        Self::new(LayerRenderErrorKind::InvalidOptions, message)
    }

    pub fn surface_creation(message: impl Into<String>) -> Self {
        Self::new(LayerRenderErrorKind::SurfaceCreation, message)
    }

    pub fn encoding(message: impl Into<String>) -> Self {
        Self::new(LayerRenderErrorKind::Encoding, message)
    }
}

impl fmt::Display for LayerRenderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.kind, self.message)
    }
}

impl Error for LayerRenderError {}

impl From<String> for LayerRenderError {
    fn from(message: String) -> Self {
        Self::new(LayerRenderErrorKind::Backend, message)
    }
}

impl From<&str> for LayerRenderError {
    fn from(message: &str) -> Self {
        Self::new(LayerRenderErrorKind::Backend, message)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LayerRenderErrorKind {
    InvalidOptions,
    SurfaceCreation,
    Encoding,
    ResourceDecode,
    Unsupported,
    Backend,
}

impl fmt::Display for LayerRenderErrorKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LayerRenderErrorKind::InvalidOptions => f.write_str("invalid render options"),
            LayerRenderErrorKind::SurfaceCreation => f.write_str("surface creation failed"),
            LayerRenderErrorKind::Encoding => f.write_str("encoding failed"),
            LayerRenderErrorKind::ResourceDecode => f.write_str("resource decode failed"),
            LayerRenderErrorKind::Unsupported => f.write_str("unsupported render operation"),
            LayerRenderErrorKind::Backend => f.write_str("backend render error"),
        }
    }
}

/// visual layer tree를 stateful backend 출력으로 재생하는 전환기 trait.
///
/// 현재는 내부 출력 버퍼나 장면 상태를 누적하는 backend, 예를 들어 layered SVG bridge가
/// 이 trait를 직접 구현한다. native Skia처럼 최종 결과를 바이트로 반환하는 raster
/// backend는 아래 `LayerRasterRenderer` contract를 쓴다.
pub trait LayerRenderer {
    fn render_page(&mut self, tree: &PageLayerTree) -> LayerRenderResult<()>;
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RasterRenderOptions {
    pub max_dimension: i32,
    pub scale: f64,
    pub dpi: Option<f64>,
    pub transparent: bool,
    pub background_color: Option<ColorRef>,
    pub color_space: RasterColorSpace,
    pub format: RasterOutputFormat,
}

impl Default for RasterRenderOptions {
    fn default() -> Self {
        Self {
            max_dimension: 16_384,
            scale: 1.0,
            dpi: None,
            transparent: true,
            background_color: None,
            color_space: RasterColorSpace::Srgb,
            format: RasterOutputFormat::Png,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RasterColorSpace {
    Srgb,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RasterOutputFormat {
    Png,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RasterRenderOutput {
    pub bytes: Vec<u8>,
    pub format: RasterOutputFormat,
    pub width: i32,
    pub height: i32,
    pub dpi: Option<f64>,
    pub color_space: RasterColorSpace,
    pub diagnostics: LayerRenderDiagnostics,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VariantSelectionBackend {
    NativeSkia,
    CanvasKit,
    Canvas2D,
    Svg,
}

impl VariantSelectionBackend {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NativeSkia => "nativeSkia",
            Self::CanvasKit => "canvaskit",
            Self::Canvas2D => "canvas2d",
            Self::Svg => "svg",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VariantSelectedReason {
    GlyphRunStrictEligible,
    GlyphOutlineStrictProfile,
    DefaultTextRunFallback,
    NoSupportedVariant,
}

impl VariantSelectedReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::GlyphRunStrictEligible => "glyphRunStrictEligible",
            Self::GlyphOutlineStrictProfile => "glyphOutlineStrictProfile",
            Self::DefaultTextRunFallback => "defaultTextRunFallback",
            Self::NoSupportedVariant => "noSupportedVariant",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum VariantRejectReason {
    FontDigestMismatch,
    FontNotPortable,
    FontBlobNotVerified,
    ExternalFontNotVerified,
    ExactFaceUnavailable,
    FaceIndexUnsupported,
    VariationUnsupported,
    GlyphIdOutOfRange,
    EmptyGlyphRun,
    GlyphRunTooLarge,
    GlyphPositionCountMismatch,
    GlyphAdvanceCountMismatch,
    PositionNotFinite,
    AdvanceNotFinite,
    PlacementNotFinite,
    FontInstanceInvalid,
    GlyphRunMetadataMismatch,
    MissingGlyph,
    ClusterMismatch,
    DiagnosticsNotClean,
    IncompleteVariantSet,
    UnsupportedPaintEffect,
    UnsupportedOutlinePayload,
    MixedGlyphOutlinePayload,
    EmptyGlyphOutlinePayload,
    GlyphOutlineStrokeStyleUnsupported,
    UnsupportedColorGlyph,
    UnsupportedBitmapGlyph,
    UnsupportedSvgGlyph,
    PositionAdjustedResidualTooLarge,
    BackendDoesNotSupportVariant,
    VariantUnsupported,
    VariantPartCountMismatch,
    VariantDuplicatePart,
    VariantPartsIncomplete,
    DefaultFallbackNotSelected,
    GlyphOutlineUnsupported,
}

impl VariantRejectReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FontDigestMismatch => "fontDigestMismatch",
            Self::FontNotPortable => "fontNotPortable",
            Self::FontBlobNotVerified => "fontBlobNotVerified",
            Self::ExternalFontNotVerified => "externalFontNotVerified",
            Self::ExactFaceUnavailable => "exactFaceUnavailable",
            Self::FaceIndexUnsupported => "faceIndexUnsupported",
            Self::VariationUnsupported => "variationUnsupported",
            Self::GlyphIdOutOfRange => "glyphIdOutOfRange",
            Self::EmptyGlyphRun => "emptyGlyphRun",
            Self::GlyphRunTooLarge => "glyphRunTooLarge",
            Self::GlyphPositionCountMismatch => "glyphPositionCountMismatch",
            Self::GlyphAdvanceCountMismatch => "glyphAdvanceCountMismatch",
            Self::PositionNotFinite => "positionNotFinite",
            Self::AdvanceNotFinite => "advanceNotFinite",
            Self::PlacementNotFinite => "placementNotFinite",
            Self::FontInstanceInvalid => "fontInstanceInvalid",
            Self::GlyphRunMetadataMismatch => "glyphRunMetadataMismatch",
            Self::MissingGlyph => "missingGlyph",
            Self::ClusterMismatch => "clusterMismatch",
            Self::DiagnosticsNotClean => "diagnosticsNotClean",
            Self::IncompleteVariantSet => "incompleteVariantSet",
            Self::UnsupportedPaintEffect => "unsupportedPaintEffect",
            Self::UnsupportedOutlinePayload => "unsupportedOutlinePayload",
            Self::MixedGlyphOutlinePayload => "mixedGlyphOutlinePayload",
            Self::EmptyGlyphOutlinePayload => "emptyGlyphOutlinePayload",
            Self::GlyphOutlineStrokeStyleUnsupported => "glyphOutlineStrokeStyleUnsupported",
            Self::UnsupportedColorGlyph => "unsupportedColorGlyph",
            Self::UnsupportedBitmapGlyph => "unsupportedBitmapGlyph",
            Self::UnsupportedSvgGlyph => "unsupportedSvgGlyph",
            Self::PositionAdjustedResidualTooLarge => "positionAdjustedResidualTooLarge",
            Self::BackendDoesNotSupportVariant => "backendDoesNotSupportVariant",
            Self::VariantUnsupported => "variantUnsupported",
            Self::VariantPartCountMismatch => "variantPartCountMismatch",
            Self::VariantDuplicatePart => "variantDuplicatePart",
            Self::VariantPartsIncomplete => "variantPartsIncomplete",
            Self::DefaultFallbackNotSelected => "defaultFallbackNotSelected",
            Self::GlyphOutlineUnsupported => "glyphOutlineUnsupported",
        }
    }
}

impl From<StrictGlyphRunPayloadError> for VariantRejectReason {
    fn from(error: StrictGlyphRunPayloadError) -> Self {
        match error {
            StrictGlyphRunPayloadError::EmptyGlyphRun => Self::EmptyGlyphRun,
            StrictGlyphRunPayloadError::GlyphRunTooLarge => Self::GlyphRunTooLarge,
            StrictGlyphRunPayloadError::GlyphPositionCountMismatch => {
                Self::GlyphPositionCountMismatch
            }
            StrictGlyphRunPayloadError::GlyphAdvanceCountMismatch => {
                Self::GlyphAdvanceCountMismatch
            }
            StrictGlyphRunPayloadError::PositionNotFinite => Self::PositionNotFinite,
            StrictGlyphRunPayloadError::AdvanceNotFinite => Self::AdvanceNotFinite,
            StrictGlyphRunPayloadError::PlacementNotFinite => Self::PlacementNotFinite,
            StrictGlyphRunPayloadError::FontInstanceInvalid => Self::FontInstanceInvalid,
            StrictGlyphRunPayloadError::GlyphRunMetadataMismatch => Self::GlyphRunMetadataMismatch,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VariantFontVerificationReport {
    pub face_key: Option<String>,
    pub blob_key: Option<String>,
    pub portability: Option<String>,
    pub expected_digest: Option<String>,
    pub blob_resolved: Option<bool>,
    pub digest_matched: Option<bool>,
    pub exact_face_instantiated: Option<bool>,
    pub face_index_supported: Option<bool>,
    pub variation_supported: Option<bool>,
    pub effect_supported: Option<bool>,
    pub replay_eligible: bool,
    pub reason: Option<VariantRejectReason>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VariantOutlineEligibilityReport {
    pub strict_visual_eligible: bool,
    pub payload_supported: bool,
    pub paint_style_supported: bool,
    pub replay_eligible: bool,
    pub reason: Option<VariantRejectReason>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VariantReplayStatus {
    pub replayable: bool,
    pub reason: Option<VariantRejectReason>,
    pub details: Option<String>,
    pub font_verification: Option<VariantFontVerificationReport>,
    pub outline_eligibility: Option<VariantOutlineEligibilityReport>,
}

impl VariantReplayStatus {
    pub fn replayable() -> Self {
        Self {
            replayable: true,
            reason: None,
            details: None,
            font_verification: None,
            outline_eligibility: None,
        }
    }

    pub fn rejected(reason: VariantRejectReason) -> Self {
        Self {
            replayable: false,
            reason: Some(reason),
            details: None,
            font_verification: None,
            outline_eligibility: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VariantPartReplayReport {
    pub equivalence_group: String,
    pub variant_id: String,
    pub variant_kind: TextVariantKind,
    pub part_index: u32,
    pub part_count: u32,
    pub replayable: bool,
    pub reason: Option<VariantRejectReason>,
    pub details: Option<String>,
    pub font_verification: Option<VariantFontVerificationReport>,
    pub outline_eligibility: Option<VariantOutlineEligibilityReport>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RejectedVariantReport {
    pub variant_id: String,
    pub variant_kind: TextVariantKind,
    pub reasons: Vec<VariantRejectReason>,
    pub details: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VariantSelectionReport {
    pub backend: VariantSelectionBackend,
    pub render_profile: String,
    pub equivalence_group: String,
    pub selected_variant_id: String,
    pub selected_variant_kind: TextVariantKind,
    pub selected_reason: VariantSelectedReason,
    pub anchor_op_id: Option<String>,
    pub parts_expected: u32,
    pub parts_replayed: u32,
    pub rejected_variants: Vec<RejectedVariantReport>,
    pub parts: Vec<VariantPartReplayReport>,
    pub font_verification: Option<VariantFontVerificationReport>,
    pub outline_eligibility: Option<VariantOutlineEligibilityReport>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VariantSelectionContext {
    pub backend: VariantSelectionBackend,
    pub render_profile: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VariantSelectionResult {
    pub selected: HashMap<String, String>,
    pub reports: Vec<VariantSelectionReport>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct VariantPartState {
    order: usize,
    variant_kind: TextVariantKind,
    expected_part_count: u32,
    parts: HashSet<u32>,
    supported: bool,
    is_default_fallback: bool,
    reasons: HashSet<VariantRejectReason>,
    details: HashSet<String>,
    anchor_op_id: Option<String>,
    font_verification: Option<VariantFontVerificationReport>,
    outline_eligibility: Option<VariantOutlineEligibilityReport>,
}

pub fn select_text_variant_sets_with_report<F, G>(
    ops: &[PaintOp],
    mut glyph_run_replay_status: F,
    mut glyph_outline_replay_status: G,
    context: VariantSelectionContext,
) -> VariantSelectionResult
where
    F: FnMut(&PaintOp) -> VariantReplayStatus,
    G: FnMut(&PaintOp) -> VariantReplayStatus,
{
    let mut selected = HashMap::new();
    let mut group_variants = HashMap::<String, HashMap<String, VariantPartState>>::new();
    let mut default_fallbacks = HashMap::<String, String>::new();
    let mut part_reports = Vec::new();
    let mut order = 0usize;

    for op in ops {
        let Some(variant) = op_variant(op) else {
            continue;
        };
        if variant.is_default_fallback {
            default_fallbacks.insert(
                variant.equivalence_group.clone(),
                variant.variant_id.clone(),
            );
        }
        let variants = group_variants
            .entry(variant.equivalence_group.clone())
            .or_default();
        let state = variants
            .entry(variant.variant_id.clone())
            .or_insert_with(|| {
                let current_order = order;
                order = order.saturating_add(1);
                VariantPartState {
                    order: current_order,
                    variant_kind: variant.variant_kind,
                    expected_part_count: variant.part_count,
                    parts: HashSet::new(),
                    supported: true,
                    is_default_fallback: variant.is_default_fallback,
                    reasons: HashSet::new(),
                    details: HashSet::new(),
                    anchor_op_id: variant
                        .anchor_op_id
                        .clone()
                        .or_else(|| variant.is_default_fallback.then(|| variant.stable_op_id())),
                    font_verification: None,
                    outline_eligibility: None,
                }
            });
        if state.anchor_op_id.is_none() {
            state.anchor_op_id = variant.anchor_op_id.clone();
        }
        if state.expected_part_count != variant.part_count || variant.part_count == 0 {
            state.supported = false;
            state
                .reasons
                .insert(VariantRejectReason::VariantPartCountMismatch);
        }
        if !state.parts.insert(variant.part_index) {
            state.supported = false;
            state
                .reasons
                .insert(VariantRejectReason::VariantDuplicatePart);
        }
        let replay_status = match op {
            PaintOp::TextRun { .. } => VariantReplayStatus::replayable(),
            PaintOp::GlyphRun { .. } => glyph_run_replay_status(op),
            PaintOp::GlyphOutline { .. } => glyph_outline_replay_status(op),
            _ => VariantReplayStatus::replayable(),
        };
        if !replay_status.replayable {
            state.supported = false;
            state.reasons.insert(
                replay_status
                    .reason
                    .unwrap_or(VariantRejectReason::VariantUnsupported),
            );
        }
        if let Some(details) = &replay_status.details {
            state.details.insert(details.clone());
        }
        if replay_status.font_verification.is_some() {
            state.font_verification = replay_status.font_verification.clone();
        }
        if replay_status.outline_eligibility.is_some() {
            state.outline_eligibility = replay_status.outline_eligibility.clone();
        }
        part_reports.push(VariantPartReplayReport {
            equivalence_group: variant.equivalence_group.clone(),
            variant_id: variant.variant_id.clone(),
            variant_kind: variant.variant_kind,
            part_index: variant.part_index,
            part_count: variant.part_count,
            replayable: replay_status.replayable,
            reason: replay_status.reason,
            details: replay_status.details,
            font_verification: replay_status.font_verification,
            outline_eligibility: replay_status.outline_eligibility,
        });
    }

    let mut reports = Vec::new();
    for (group, variants) in group_variants {
        let mut candidates = variants.into_iter().collect::<Vec<_>>();
        candidates.sort_by_key(|(_, state)| state.order);
        for (variant_id, state) in &candidates {
            if state.is_default_fallback {
                continue;
            }
            if state.supported && parts_complete(state) {
                selected.insert(group.clone(), variant_id.clone());
                break;
            }
        }
        let selected_variant_id = selected.get(&group);
        let selected_state = selected_variant_id
            .and_then(|id| candidates.iter().find(|(variant_id, _)| variant_id == id))
            .map(|(_, state)| state);
        let fallback_variant_id = default_fallbacks
            .get(&group)
            .cloned()
            .unwrap_or_else(|| "textRun".to_string());
        let fallback_state = default_fallbacks
            .get(&group)
            .and_then(|id| candidates.iter().find(|(variant_id, _)| variant_id == id))
            .map(|(_, state)| state);
        let reported_variant_id = selected_variant_id
            .cloned()
            .unwrap_or_else(|| fallback_variant_id.clone());
        let reported_state = selected_state.or(fallback_state);
        let reported_kind = reported_state
            .map(|state| state.variant_kind)
            .unwrap_or(TextVariantKind::TextRun);
        let group_parts = part_reports
            .iter()
            .filter(|part| part.equivalence_group == group)
            .cloned()
            .collect::<Vec<_>>();
        let selected_parts = group_parts
            .iter()
            .filter(|part| part.variant_id == reported_variant_id)
            .collect::<Vec<_>>();
        let selected_reason = match selected_state.map(|state| state.variant_kind) {
            Some(TextVariantKind::GlyphOutline) => VariantSelectedReason::GlyphOutlineStrictProfile,
            Some(TextVariantKind::GlyphRun) => VariantSelectedReason::GlyphRunStrictEligible,
            Some(TextVariantKind::TextRun) => VariantSelectedReason::DefaultTextRunFallback,
            None if default_fallbacks.contains_key(&group) => {
                VariantSelectedReason::DefaultTextRunFallback
            }
            None => VariantSelectedReason::NoSupportedVariant,
        };
        let rejected_variants = candidates
            .iter()
            .filter(|(variant_id, state)| {
                selected_variant_id
                    .map(|selected| selected != variant_id)
                    .unwrap_or(true)
                    && !state.is_default_fallback
            })
            .map(|(variant_id, state)| {
                let mut reasons = state.reasons.clone();
                if !parts_complete(state) {
                    reasons.insert(VariantRejectReason::VariantPartsIncomplete);
                }
                if state.variant_kind == TextVariantKind::TextRun {
                    reasons.insert(VariantRejectReason::DefaultFallbackNotSelected);
                }
                let mut reasons = reasons.into_iter().collect::<Vec<_>>();
                reasons.sort_by_key(|reason| reason.as_str());
                let mut details = state.details.iter().cloned().collect::<Vec<_>>();
                details.sort();
                RejectedVariantReport {
                    variant_id: variant_id.clone(),
                    variant_kind: state.variant_kind,
                    reasons,
                    details,
                }
            })
            .collect();
        reports.push(VariantSelectionReport {
            backend: context.backend,
            render_profile: context.render_profile.clone(),
            equivalence_group: group,
            selected_variant_id: reported_variant_id,
            selected_variant_kind: reported_kind,
            selected_reason,
            anchor_op_id: reported_state.and_then(|state| state.anchor_op_id.clone()),
            parts_expected: reported_state
                .map(|state| state.expected_part_count)
                .unwrap_or(selected_parts.len() as u32),
            parts_replayed: selected_parts.iter().filter(|part| part.replayable).count() as u32,
            rejected_variants,
            font_verification: first_font_verification(reported_state, &group_parts),
            outline_eligibility: first_outline_eligibility(reported_state, &group_parts),
            parts: group_parts,
        });
    }

    VariantSelectionResult { selected, reports }
}

pub fn should_render_selected_text_variant(
    op: &PaintOp,
    selected: &HashMap<String, String>,
) -> bool {
    let Some(variant) = op_variant(op) else {
        return true;
    };
    match selected.get(&variant.equivalence_group) {
        Some(selected_variant) => selected_variant == &variant.variant_id,
        None => !matches!(op, PaintOp::GlyphRun { .. } | PaintOp::GlyphOutline { .. }),
    }
}

fn op_variant(op: &PaintOp) -> Option<&crate::paint::PaintVariantMeta> {
    match op {
        PaintOp::TextRun { run, .. } => run.variant.as_ref(),
        PaintOp::GlyphRun { run, .. } => Some(&run.variant),
        PaintOp::GlyphOutline { outline, .. } => Some(&outline.variant),
        PaintOp::CharOverlap { overlap, .. } => overlap.variant.as_ref(),
        _ => None,
    }
}

fn parts_complete(state: &VariantPartState) -> bool {
    state.parts.len() as u32 == state.expected_part_count
        && (0..state.expected_part_count).all(|part| state.parts.contains(&part))
}

fn first_font_verification(
    state: Option<&VariantPartState>,
    parts: &[VariantPartReplayReport],
) -> Option<VariantFontVerificationReport> {
    state
        .and_then(|state| state.font_verification.clone())
        .or_else(|| parts.iter().find_map(|part| part.font_verification.clone()))
}

fn first_outline_eligibility(
    state: Option<&VariantPartState>,
    parts: &[VariantPartReplayReport],
) -> Option<VariantOutlineEligibilityReport> {
    state
        .and_then(|state| state.outline_eligibility.clone())
        .or_else(|| {
            parts
                .iter()
                .find_map(|part| part.outline_eligibility.clone())
        })
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct LayerRenderDiagnostics {
    pub backend: Option<VariantSelectionBackend>,
    pub render_profile: Option<String>,
    pub variant_selections: Vec<VariantSelectionReport>,
    pub shaped_measurements: Vec<ShapedMeasurementRunReport>,
    pub shaped_measurement_lines: Vec<ShapedMeasurementLineReport>,
    pub line_break_shadows: Vec<LineBreakShadowReport>,
    pub shaped_measurement_paragraphs: Vec<ShapedMeasurementParagraphSummary>,
    pub shaped_measurement_pages: Vec<ShapedMeasurementPageSummary>,
    pub layer_nodes_replayed: usize,
    pub paint_ops_replayed: usize,
    pub tile_fallback_cap_hits: usize,
    pub image_effect_preprocess_failures: usize,
    pub image_effect_fallback_to_filter: usize,
    pub image_effect_cache_hits: usize,
    pub image_effect_cache_misses: usize,
    pub image_effect_cache_evictions: usize,
    pub image_effect_cache_skipped_oversized: usize,
    pub static_picture_cache_hits: usize,
    pub static_picture_cache_misses: usize,
    pub static_picture_cache_evictions: usize,
    pub static_picture_cache_skipped_oversized: usize,
    pub static_picture_cache_fingerprint_mismatches: usize,
    pub static_picture_cache_recordings: usize,
    /// Native raster setup time: dimension validation, surface creation,
    /// clear/scale setup, and replay context initialization.
    pub raster_setup_time_ns: u64,
    /// Native layer replay time, excluding surface setup and output encoding.
    pub raster_replay_time_ns: u64,
    /// Native raster output encoding time, including image snapshot and byte copy.
    pub raster_encode_time_ns: u64,
    /// Native raster total wall-clock time for the render call.
    pub raster_total_time_ns: u64,
    /// Approximate RGBA bytes processed while producing image-effect intermediates.
    /// This is diagnostic accounting, not allocator-reported memory.
    pub image_effect_preprocessed_bytes: usize,
    /// Approximate RGBA bytes retained by image-effect caches after rendering.
    /// Skia/browser backends may allocate additional backing-store overhead.
    pub image_effect_cache_approx_bytes: usize,
    /// Approximate RGBA bytes retained by static picture caches after rendering.
    /// This is derived from cached subtree bounds, not Skia allocator telemetry.
    pub static_picture_cache_approx_bytes: usize,
}

/// visual layer tree를 raster 결과로 직접 내보내는 backend 계약.
///
/// 현재는 native Skia가 이 계약을 구현한다. Layer tree를 공통 입력으로 공유하되,
/// stateful scene renderer와 raster exporter를 같은 trait에 억지로 넣지 않기 위해
/// 별도 contract로 분리한다. `render_png`는 기존 호출부를 위한 편의 API이고,
/// 확장 가능한 entrypoint는 metadata와 format을 함께 반환하는 `render_raster`다.
pub trait LayerRasterRenderer {
    fn render_png(&self, tree: &PageLayerTree) -> LayerRenderResult<Vec<u8>> {
        self.render_png_with_options(tree, RasterRenderOptions::default())
    }

    fn render_png_with_options(
        &self,
        tree: &PageLayerTree,
        options: RasterRenderOptions,
    ) -> LayerRenderResult<Vec<u8>> {
        let mut png_options = options;
        png_options.format = RasterOutputFormat::Png;
        self.render_raster(tree, png_options)
            .map(|output| output.bytes)
    }

    fn render_raster(
        &self,
        tree: &PageLayerTree,
        options: RasterRenderOptions,
    ) -> LayerRenderResult<RasterRenderOutput>;
}
