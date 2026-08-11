use crate::paint::paint_op::strict_glyph_run_geometry_contract_error;
use crate::paint::{
    FontPortabilityKind, GlyphCluster, GlyphRunDiagnostics, GlyphRunOrientation,
    GlyphRunReplayEligibility, LayerAffineTransform, LayerGlyphRunPaint, LayerNode, LayerNodeKind,
    LayerPoint, LayerTextRunPaint, LayerVector, PaintOp, PaintTextStyle, ShapeKey, TextClusterFlag,
    TextRunPlacement, TextVariantKind, TextVariantQuality,
};
use crate::renderer::render_tree::BoundingBox;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FontRequest {
    pub family: String,
    pub bold: bool,
    pub italic: bool,
}

impl From<&LayerTextRunPaint> for FontRequest {
    fn from(run: &LayerTextRunPaint) -> Self {
        Self {
            family: run.style.font_family.clone(),
            bold: run.style.bold,
            italic: run.style.italic,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedFontFace {
    pub portability: FontPortabilityKind,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedGlyphRun {
    pub shape_key: ShapeKey,
    pub glyph_ids: Vec<u32>,
    pub positions: Vec<LayerPoint>,
    pub advances: Option<Vec<LayerVector>>,
    pub clusters: Vec<GlyphCluster>,
    pub diagnostics: GlyphRunDiagnostics,
}

pub trait FontResolver {
    fn resolve_font(&self, request: &FontRequest) -> ResolvedFontFace;

    fn shape_glyph_run(
        &self,
        _request: &FontRequest,
        _run: &LayerTextRunPaint,
        _resolved: &ResolvedFontFace,
    ) -> Option<ResolvedGlyphRun> {
        None
    }
}

#[derive(Debug, Default)]
pub struct NoopFontResolver;

impl FontResolver for NoopFontResolver {
    fn resolve_font(&self, _request: &FontRequest) -> ResolvedFontFace {
        ResolvedFontFace {
            portability: FontPortabilityKind::UnresolvedFallback,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GlyphRunQuality {
    Exact,
    PositionAdjusted,
    Approximate,
    DiagnosticOnly,
    Omitted,
}

impl GlyphRunQuality {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Exact => "exact",
            Self::PositionAdjusted => "positionAdjusted",
            Self::Approximate => "approximate",
            Self::DiagnosticOnly => "diagnosticOnly",
            Self::Omitted => "omitted",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TextShapeDiagnostic {
    pub text: String,
    pub attempted: bool,
    pub public_glyph_run_emitted: bool,
    pub quality: GlyphRunQuality,
    pub replay_eligibility: GlyphRunReplayEligibility,
    pub strict_visual_eligible: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ShapedMeasurementRunReport {
    pub document_id: Option<String>,
    pub sample_id: Option<String>,
    pub page_index: Option<u32>,
    pub text_op_id: Option<String>,
    pub source: Option<crate::paint::TextSourceSpan>,
    pub legacy_width_px: f64,
    pub shaped_width_px: f64,
    pub delta_px: f64,
    pub delta_ratio: f64,
    pub cluster_mismatch_count: u32,
    pub fallback_font_difference: bool,
    pub vertical_metric_difference: bool,
    pub shaping_quality: Option<GlyphRunQuality>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ShapedMeasurementLineReport {
    pub document_id: Option<String>,
    pub sample_id: Option<String>,
    pub page_index: Option<u32>,
    pub paragraph_id: Option<String>,
    pub line_index: u32,
    pub legacy_line_width_px: f64,
    pub shaped_line_width_px: f64,
    pub delta_px: f64,
    pub delta_ratio: f64,
    pub contributing_run_count: u32,
    pub max_run_delta_px: f64,
    pub fallback_font_difference_count: u32,
    pub vertical_metric_difference_count: u32,
    pub cluster_mismatch_count_sum: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineBreakChangeRisk {
    InsufficientContext,
    NoChangeLikely,
    ChangePossible,
    ChangeLikely,
}

impl LineBreakChangeRisk {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InsufficientContext => "insufficientContext",
            Self::NoChangeLikely => "noChangeLikely",
            Self::ChangePossible => "changePossible",
            Self::ChangeLikely => "changeLikely",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum LineBreakContextValue<T> {
    Known(T),
    KnownAbsent,
    Unknown,
}

impl<T> LineBreakContextValue<T> {
    pub fn is_known(&self) -> bool {
        matches!(self, Self::Known(_))
    }

    pub fn is_unknown(&self) -> bool {
        matches!(self, Self::Unknown)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TableCellConstraintSummary {
    pub cell_width_px: Option<f64>,
    pub content_width_px: Option<f64>,
    pub available_width_px: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TabStopSummary {
    pub count: u32,
    pub next_tab_stop_px: Option<f64>,
    pub has_leaders: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JustificationMode {
    None,
    Left,
    Right,
    Center,
    Justify,
    Distributed,
}

impl JustificationMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Left => "left",
            Self::Right => "right",
            Self::Center => "center",
            Self::Justify => "justify",
            Self::Distributed => "distributed",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct LineBreakShadowReport {
    pub document_id: Option<String>,
    pub sample_id: Option<String>,
    pub page_index: Option<u32>,
    pub paragraph_id: Option<String>,
    pub line_index: u32,
    pub has_full_layout_context: bool,
    pub legacy_available_width_px: LineBreakContextValue<f64>,
    pub paragraph_width_px: LineBreakContextValue<f64>,
    pub container_width_px: LineBreakContextValue<f64>,
    pub table_cell_constraint: LineBreakContextValue<TableCellConstraintSummary>,
    pub tab_stop_summary: LineBreakContextValue<TabStopSummary>,
    pub justification: LineBreakContextValue<JustificationMode>,
    pub legacy_line_segmentation_available: LineBreakContextValue<bool>,
    pub legacy_line_width_px: f64,
    pub shaped_line_width_px: f64,
    pub overflow_delta_px: Option<f64>,
    pub risk: LineBreakChangeRisk,
    pub reason: Option<String>,
}

impl LineBreakShadowReport {
    pub fn has_minimum_layout_context(&self) -> bool {
        self.has_full_layout_context
            && self.legacy_available_width_px.is_known()
            && (self.paragraph_width_px.is_known() || self.container_width_px.is_known())
            && !self.table_cell_constraint.is_unknown()
            && !self.tab_stop_summary.is_unknown()
            && !self.justification.is_unknown()
            && !self.legacy_line_segmentation_available.is_unknown()
    }

    pub fn reported_risk(&self) -> LineBreakChangeRisk {
        if self.has_minimum_layout_context() {
            self.risk
        } else {
            LineBreakChangeRisk::InsufficientContext
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ShapedMeasurementParagraphSummary {
    pub document_id: Option<String>,
    pub sample_id: Option<String>,
    pub page_index: Option<u32>,
    pub paragraph_id: Option<String>,
    pub line_count: u32,
    pub run_count: u32,
    pub max_run_delta_px: f64,
    pub max_line_delta_px: f64,
    pub max_line_delta_ratio: f64,
    pub total_abs_delta_px: f64,
    pub cluster_mismatch_count_sum: u32,
    pub fallback_font_difference_count: u32,
    pub vertical_metric_difference_count: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ShapedMeasurementPageSummary {
    pub document_id: Option<String>,
    pub sample_id: Option<String>,
    pub page_index: Option<u32>,
    pub paragraph_count: u32,
    pub line_count: u32,
    pub run_count: u32,
    pub max_run_delta_px: f64,
    pub max_line_delta_px: f64,
    pub total_abs_delta_px: f64,
    pub fallback_font_difference_count: u32,
    pub vertical_metric_difference_count: u32,
    pub cluster_mismatch_count_sum: u32,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct TextShapeReport {
    pub diagnostics: Vec<TextShapeDiagnostic>,
    pub shaped_measurements: Vec<ShapedMeasurementRunReport>,
    pub shaped_measurement_lines: Vec<ShapedMeasurementLineReport>,
    pub line_break_shadows: Vec<LineBreakShadowReport>,
    pub shaped_measurement_paragraphs: Vec<ShapedMeasurementParagraphSummary>,
    pub shaped_measurement_pages: Vec<ShapedMeasurementPageSummary>,
}

impl TextShapeReport {
    pub fn public_glyph_run_count(&self) -> usize {
        self.diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.public_glyph_run_emitted)
            .count()
    }

    /// Adds a report-only line summary from already-collected run measurements.
    ///
    /// The caller owns line membership. This method deliberately does not infer
    /// line breaks or mutate layout; it only aggregates telemetry for future
    /// layout migration analysis.
    pub fn summarize_shaped_measurement_line(
        &mut self,
        document_id: Option<String>,
        sample_id: Option<String>,
        page_index: Option<u32>,
        paragraph_id: Option<String>,
        line_index: u32,
        run_indices: &[usize],
    ) -> Option<&ShapedMeasurementLineReport> {
        let mut contributing_run_count = 0u32;
        let mut legacy_line_width_px = 0.0;
        let mut shaped_line_width_px = 0.0;
        let mut max_run_delta_px = 0.0f64;
        let mut fallback_font_difference_count = 0u32;
        let mut vertical_metric_difference_count = 0u32;
        let mut cluster_mismatch_count_sum = 0u32;

        for index in run_indices {
            let Some(run) = self.shaped_measurements.get(*index) else {
                continue;
            };
            contributing_run_count = contributing_run_count.saturating_add(1);
            legacy_line_width_px += run.legacy_width_px;
            shaped_line_width_px += run.shaped_width_px;
            max_run_delta_px = max_run_delta_px.max(run.delta_px.abs());
            if run.fallback_font_difference {
                fallback_font_difference_count = fallback_font_difference_count.saturating_add(1);
            }
            if run.vertical_metric_difference {
                vertical_metric_difference_count =
                    vertical_metric_difference_count.saturating_add(1);
            }
            cluster_mismatch_count_sum =
                cluster_mismatch_count_sum.saturating_add(run.cluster_mismatch_count);
        }

        if contributing_run_count == 0 {
            return None;
        }

        let delta_px = shaped_line_width_px - legacy_line_width_px;
        let delta_ratio = if legacy_line_width_px.abs() > f64::EPSILON {
            delta_px / legacy_line_width_px
        } else {
            0.0
        };

        self.shaped_measurement_lines
            .push(ShapedMeasurementLineReport {
                document_id,
                sample_id,
                page_index,
                paragraph_id,
                line_index,
                legacy_line_width_px,
                shaped_line_width_px,
                delta_px,
                delta_ratio,
                contributing_run_count,
                max_run_delta_px,
                fallback_font_difference_count,
                vertical_metric_difference_count,
                cluster_mismatch_count_sum,
            });
        self.shaped_measurement_lines.last()
    }

    /// Adds a report-only paragraph summary from existing line summaries.
    ///
    /// The caller owns paragraph membership. This method does not infer
    /// paragraph boundaries, reflow lines, or decide whether line breaks would
    /// change under shaped measurement.
    pub fn summarize_shaped_measurement_paragraph(
        &mut self,
        document_id: Option<String>,
        sample_id: Option<String>,
        page_index: Option<u32>,
        paragraph_id: Option<String>,
        line_indices: &[usize],
    ) -> Option<&ShapedMeasurementParagraphSummary> {
        let mut line_count = 0u32;
        let mut run_count = 0u32;
        let mut max_run_delta_px = 0.0f64;
        let mut max_line_delta_px = 0.0f64;
        let mut max_line_delta_ratio = 0.0f64;
        let mut total_abs_delta_px = 0.0f64;
        let mut cluster_mismatch_count_sum = 0u32;
        let mut fallback_font_difference_count = 0u32;
        let mut vertical_metric_difference_count = 0u32;

        for index in line_indices {
            let Some(line) = self.shaped_measurement_lines.get(*index) else {
                continue;
            };
            line_count = line_count.saturating_add(1);
            run_count = run_count.saturating_add(line.contributing_run_count);
            max_run_delta_px = max_run_delta_px.max(line.max_run_delta_px.abs());
            max_line_delta_px = max_line_delta_px.max(line.delta_px.abs());
            max_line_delta_ratio = max_line_delta_ratio.max(line.delta_ratio.abs());
            total_abs_delta_px += line.delta_px.abs();
            cluster_mismatch_count_sum =
                cluster_mismatch_count_sum.saturating_add(line.cluster_mismatch_count_sum);
            fallback_font_difference_count =
                fallback_font_difference_count.saturating_add(line.fallback_font_difference_count);
            vertical_metric_difference_count = vertical_metric_difference_count
                .saturating_add(line.vertical_metric_difference_count);
        }

        if line_count == 0 {
            return None;
        }

        self.shaped_measurement_paragraphs
            .push(ShapedMeasurementParagraphSummary {
                document_id,
                sample_id,
                page_index,
                paragraph_id,
                line_count,
                run_count,
                max_run_delta_px,
                max_line_delta_px,
                max_line_delta_ratio,
                total_abs_delta_px,
                cluster_mismatch_count_sum,
                fallback_font_difference_count,
                vertical_metric_difference_count,
            });
        self.shaped_measurement_paragraphs.last()
    }

    /// Adds a report-only page summary from existing paragraph summaries.
    ///
    /// The caller owns page membership. This method is telemetry-only and does
    /// not feed layout measurement, pagination, or CI pass/fail decisions.
    pub fn summarize_shaped_measurement_page(
        &mut self,
        document_id: Option<String>,
        sample_id: Option<String>,
        page_index: Option<u32>,
        paragraph_indices: &[usize],
    ) -> Option<&ShapedMeasurementPageSummary> {
        let mut paragraph_count = 0u32;
        let mut line_count = 0u32;
        let mut run_count = 0u32;
        let mut max_run_delta_px = 0.0f64;
        let mut max_line_delta_px = 0.0f64;
        let mut total_abs_delta_px = 0.0f64;
        let mut fallback_font_difference_count = 0u32;
        let mut vertical_metric_difference_count = 0u32;
        let mut cluster_mismatch_count_sum = 0u32;

        for index in paragraph_indices {
            let Some(paragraph) = self.shaped_measurement_paragraphs.get(*index) else {
                continue;
            };
            paragraph_count = paragraph_count.saturating_add(1);
            line_count = line_count.saturating_add(paragraph.line_count);
            run_count = run_count.saturating_add(paragraph.run_count);
            max_run_delta_px = max_run_delta_px.max(paragraph.max_run_delta_px.abs());
            max_line_delta_px = max_line_delta_px.max(paragraph.max_line_delta_px.abs());
            total_abs_delta_px += paragraph.total_abs_delta_px;
            fallback_font_difference_count = fallback_font_difference_count
                .saturating_add(paragraph.fallback_font_difference_count);
            vertical_metric_difference_count = vertical_metric_difference_count
                .saturating_add(paragraph.vertical_metric_difference_count);
            cluster_mismatch_count_sum =
                cluster_mismatch_count_sum.saturating_add(paragraph.cluster_mismatch_count_sum);
        }

        if paragraph_count == 0 {
            return None;
        }

        self.shaped_measurement_pages
            .push(ShapedMeasurementPageSummary {
                document_id,
                sample_id,
                page_index,
                paragraph_count,
                line_count,
                run_count,
                max_run_delta_px,
                max_line_delta_px,
                total_abs_delta_px,
                fallback_font_difference_count,
                vertical_metric_difference_count,
                cluster_mismatch_count_sum,
            });
        self.shaped_measurement_pages.last()
    }

    /// Serializes the report-only shaped measurement observations.
    ///
    /// This artifact is intentionally separate from layer-tree schema export:
    /// it is backend/layout migration telemetry, not a replay contract.
    pub fn shaped_measurements_json(&self) -> String {
        let mut buf = String::from("{\"shapedMeasurements\":[");
        for (idx, measurement) in self.shaped_measurements.iter().enumerate() {
            if idx > 0 {
                buf.push(',');
            }
            write_shaped_measurement_json(&mut buf, measurement);
        }
        buf.push_str("],\"shapedMeasurementLines\":[");
        for (idx, line) in self.shaped_measurement_lines.iter().enumerate() {
            if idx > 0 {
                buf.push(',');
            }
            buf.push('{');
            let mut first = true;
            write_optional_string_field(
                &mut buf,
                "documentId",
                line.document_id.as_deref(),
                &mut first,
            );
            write_optional_string_field(
                &mut buf,
                "sampleId",
                line.sample_id.as_deref(),
                &mut first,
            );
            write_optional_u32_field(&mut buf, "pageIndex", line.page_index, &mut first);
            write_optional_string_field(
                &mut buf,
                "paragraphId",
                line.paragraph_id.as_deref(),
                &mut first,
            );
            write_field_prefix(&mut buf, "lineIndex", &mut first);
            buf.push_str(&line.line_index.to_string());
            write_f64_field(
                &mut buf,
                "legacyLineWidthPx",
                line.legacy_line_width_px,
                &mut first,
            );
            write_f64_field(
                &mut buf,
                "shapedLineWidthPx",
                line.shaped_line_width_px,
                &mut first,
            );
            write_f64_field(&mut buf, "deltaPx", line.delta_px, &mut first);
            write_f64_field(&mut buf, "deltaRatio", line.delta_ratio, &mut first);
            write_field_prefix(&mut buf, "contributingRunCount", &mut first);
            buf.push_str(&line.contributing_run_count.to_string());
            write_f64_field(&mut buf, "maxRunDeltaPx", line.max_run_delta_px, &mut first);
            write_field_prefix(&mut buf, "fallbackFontDifferenceCount", &mut first);
            buf.push_str(&line.fallback_font_difference_count.to_string());
            write_field_prefix(&mut buf, "verticalMetricDifferenceCount", &mut first);
            buf.push_str(&line.vertical_metric_difference_count.to_string());
            write_field_prefix(&mut buf, "clusterMismatchCountSum", &mut first);
            buf.push_str(&line.cluster_mismatch_count_sum.to_string());
            buf.push('}');
        }
        buf.push_str("],\"lineBreakShadows\":[");
        for (idx, shadow) in self.line_break_shadows.iter().enumerate() {
            if idx > 0 {
                buf.push(',');
            }
            buf.push('{');
            let mut first = true;
            write_optional_string_field(
                &mut buf,
                "documentId",
                shadow.document_id.as_deref(),
                &mut first,
            );
            write_optional_string_field(
                &mut buf,
                "sampleId",
                shadow.sample_id.as_deref(),
                &mut first,
            );
            write_optional_u32_field(&mut buf, "pageIndex", shadow.page_index, &mut first);
            write_optional_string_field(
                &mut buf,
                "paragraphId",
                shadow.paragraph_id.as_deref(),
                &mut first,
            );
            write_field_prefix(&mut buf, "lineIndex", &mut first);
            buf.push_str(&shadow.line_index.to_string());
            write_field_prefix(&mut buf, "hasFullLayoutContext", &mut first);
            buf.push_str(if shadow.has_full_layout_context {
                "true"
            } else {
                "false"
            });
            write_field_prefix(&mut buf, "legacyAvailableWidthPx", &mut first);
            write_context_value_json(&mut buf, &shadow.legacy_available_width_px, write_f64_json);
            write_field_prefix(&mut buf, "paragraphWidthPx", &mut first);
            write_context_value_json(&mut buf, &shadow.paragraph_width_px, write_f64_json);
            write_field_prefix(&mut buf, "containerWidthPx", &mut first);
            write_context_value_json(&mut buf, &shadow.container_width_px, write_f64_json);
            write_field_prefix(&mut buf, "tableCellConstraint", &mut first);
            write_context_value_json(
                &mut buf,
                &shadow.table_cell_constraint,
                write_table_cell_constraint_json,
            );
            write_field_prefix(&mut buf, "tabStopSummary", &mut first);
            write_context_value_json(
                &mut buf,
                &shadow.tab_stop_summary,
                write_tab_stop_summary_json,
            );
            write_field_prefix(&mut buf, "justification", &mut first);
            write_context_value_json(&mut buf, &shadow.justification, write_justification_json);
            write_field_prefix(&mut buf, "legacyLineSegmentationAvailable", &mut first);
            write_context_value_json(
                &mut buf,
                &shadow.legacy_line_segmentation_available,
                write_bool_json,
            );
            write_f64_field(
                &mut buf,
                "legacyLineWidthPx",
                shadow.legacy_line_width_px,
                &mut first,
            );
            write_f64_field(
                &mut buf,
                "shapedLineWidthPx",
                shadow.shaped_line_width_px,
                &mut first,
            );
            if let Some(delta) = shadow.overflow_delta_px {
                write_f64_field(&mut buf, "overflowDeltaPx", delta, &mut first);
            }
            write_field_prefix(&mut buf, "risk", &mut first);
            write_json_string(&mut buf, shadow.reported_risk().as_str());
            write_optional_string_field(&mut buf, "reason", shadow.reason.as_deref(), &mut first);
            buf.push('}');
        }
        buf.push_str("],\"shapedMeasurementParagraphs\":[");
        for (idx, paragraph) in self.shaped_measurement_paragraphs.iter().enumerate() {
            if idx > 0 {
                buf.push(',');
            }
            buf.push('{');
            let mut first = true;
            write_optional_string_field(
                &mut buf,
                "documentId",
                paragraph.document_id.as_deref(),
                &mut first,
            );
            write_optional_string_field(
                &mut buf,
                "sampleId",
                paragraph.sample_id.as_deref(),
                &mut first,
            );
            write_optional_u32_field(&mut buf, "pageIndex", paragraph.page_index, &mut first);
            write_optional_string_field(
                &mut buf,
                "paragraphId",
                paragraph.paragraph_id.as_deref(),
                &mut first,
            );
            write_field_prefix(&mut buf, "lineCount", &mut first);
            buf.push_str(&paragraph.line_count.to_string());
            write_field_prefix(&mut buf, "runCount", &mut first);
            buf.push_str(&paragraph.run_count.to_string());
            write_f64_field(
                &mut buf,
                "maxRunDeltaPx",
                paragraph.max_run_delta_px,
                &mut first,
            );
            write_f64_field(
                &mut buf,
                "maxLineDeltaPx",
                paragraph.max_line_delta_px,
                &mut first,
            );
            write_f64_field(
                &mut buf,
                "maxLineDeltaRatio",
                paragraph.max_line_delta_ratio,
                &mut first,
            );
            write_f64_field(
                &mut buf,
                "totalAbsDeltaPx",
                paragraph.total_abs_delta_px,
                &mut first,
            );
            write_field_prefix(&mut buf, "clusterMismatchCountSum", &mut first);
            buf.push_str(&paragraph.cluster_mismatch_count_sum.to_string());
            write_field_prefix(&mut buf, "fallbackFontDifferenceCount", &mut first);
            buf.push_str(&paragraph.fallback_font_difference_count.to_string());
            write_field_prefix(&mut buf, "verticalMetricDifferenceCount", &mut first);
            buf.push_str(&paragraph.vertical_metric_difference_count.to_string());
            buf.push('}');
        }
        buf.push_str("],\"shapedMeasurementPages\":[");
        for (idx, page) in self.shaped_measurement_pages.iter().enumerate() {
            if idx > 0 {
                buf.push(',');
            }
            buf.push('{');
            let mut first = true;
            write_optional_string_field(
                &mut buf,
                "documentId",
                page.document_id.as_deref(),
                &mut first,
            );
            write_optional_string_field(
                &mut buf,
                "sampleId",
                page.sample_id.as_deref(),
                &mut first,
            );
            write_optional_u32_field(&mut buf, "pageIndex", page.page_index, &mut first);
            write_field_prefix(&mut buf, "paragraphCount", &mut first);
            buf.push_str(&page.paragraph_count.to_string());
            write_field_prefix(&mut buf, "lineCount", &mut first);
            buf.push_str(&page.line_count.to_string());
            write_field_prefix(&mut buf, "runCount", &mut first);
            buf.push_str(&page.run_count.to_string());
            write_f64_field(&mut buf, "maxRunDeltaPx", page.max_run_delta_px, &mut first);
            write_f64_field(
                &mut buf,
                "maxLineDeltaPx",
                page.max_line_delta_px,
                &mut first,
            );
            write_f64_field(
                &mut buf,
                "totalAbsDeltaPx",
                page.total_abs_delta_px,
                &mut first,
            );
            write_field_prefix(&mut buf, "fallbackFontDifferenceCount", &mut first);
            buf.push_str(&page.fallback_font_difference_count.to_string());
            write_field_prefix(&mut buf, "verticalMetricDifferenceCount", &mut first);
            buf.push_str(&page.vertical_metric_difference_count.to_string());
            write_field_prefix(&mut buf, "clusterMismatchCountSum", &mut first);
            buf.push_str(&page.cluster_mismatch_count_sum.to_string());
            buf.push('}');
        }
        buf.push_str("]}");
        buf
    }
}

fn write_shaped_measurement_json(buf: &mut String, measurement: &ShapedMeasurementRunReport) {
    buf.push('{');
    let mut first = true;
    write_optional_string_field(
        buf,
        "documentId",
        measurement.document_id.as_deref(),
        &mut first,
    );
    write_optional_string_field(
        buf,
        "sampleId",
        measurement.sample_id.as_deref(),
        &mut first,
    );
    write_optional_u32_field(buf, "pageIndex", measurement.page_index, &mut first);
    write_optional_string_field(
        buf,
        "textOpId",
        measurement.text_op_id.as_deref(),
        &mut first,
    );
    if let Some(source) = &measurement.source {
        write_field_prefix(buf, "source", &mut first);
        write_text_source_span_json(buf, source);
    }
    write_f64_field(
        buf,
        "legacyWidthPx",
        measurement.legacy_width_px,
        &mut first,
    );
    write_f64_field(
        buf,
        "shapedWidthPx",
        measurement.shaped_width_px,
        &mut first,
    );
    write_f64_field(buf, "deltaPx", measurement.delta_px, &mut first);
    write_f64_field(buf, "deltaRatio", measurement.delta_ratio, &mut first);
    write_field_prefix(buf, "clusterMismatchCount", &mut first);
    buf.push_str(&measurement.cluster_mismatch_count.to_string());
    write_field_prefix(buf, "fallbackFontDifference", &mut first);
    buf.push_str(if measurement.fallback_font_difference {
        "true"
    } else {
        "false"
    });
    write_field_prefix(buf, "verticalMetricDifference", &mut first);
    buf.push_str(if measurement.vertical_metric_difference {
        "true"
    } else {
        "false"
    });
    if let Some(quality) = measurement.shaping_quality {
        write_field_prefix(buf, "shapingQuality", &mut first);
        write_json_string(buf, quality.as_str());
    }
    buf.push('}');
}

fn write_context_value_json<T>(
    buf: &mut String,
    value: &LineBreakContextValue<T>,
    write_known: fn(&mut String, &T),
) {
    match value {
        LineBreakContextValue::Known(value) => {
            buf.push_str("{\"state\":\"known\",\"value\":");
            write_known(buf, value);
            buf.push('}');
        }
        LineBreakContextValue::KnownAbsent => {
            buf.push_str("{\"state\":\"knownAbsent\"}");
        }
        LineBreakContextValue::Unknown => {
            buf.push_str("{\"state\":\"unknown\"}");
        }
    }
}

fn write_f64_json(buf: &mut String, value: &f64) {
    if value.is_finite() {
        buf.push_str(&value.to_string());
    } else {
        buf.push_str("null");
    }
}

fn write_bool_json(buf: &mut String, value: &bool) {
    buf.push_str(if *value { "true" } else { "false" });
}

fn write_justification_json(buf: &mut String, value: &JustificationMode) {
    write_json_string(buf, value.as_str());
}

fn write_table_cell_constraint_json(buf: &mut String, constraint: &TableCellConstraintSummary) {
    buf.push('{');
    let mut first = true;
    if let Some(width) = constraint.cell_width_px {
        write_f64_field(buf, "cellWidthPx", width, &mut first);
    }
    if let Some(width) = constraint.content_width_px {
        write_f64_field(buf, "contentWidthPx", width, &mut first);
    }
    if let Some(width) = constraint.available_width_px {
        write_f64_field(buf, "availableWidthPx", width, &mut first);
    }
    buf.push('}');
}

fn write_tab_stop_summary_json(buf: &mut String, summary: &TabStopSummary) {
    buf.push('{');
    let mut first = true;
    write_field_prefix(buf, "count", &mut first);
    buf.push_str(&summary.count.to_string());
    if let Some(width) = summary.next_tab_stop_px {
        write_f64_field(buf, "nextTabStopPx", width, &mut first);
    }
    write_field_prefix(buf, "hasLeaders", &mut first);
    buf.push_str(if summary.has_leaders { "true" } else { "false" });
    buf.push('}');
}

fn write_optional_string_field(
    buf: &mut String,
    name: &str,
    value: Option<&str>,
    first: &mut bool,
) {
    if let Some(value) = value {
        write_field_prefix(buf, name, first);
        write_json_string(buf, value);
    }
}

fn write_optional_u32_field(buf: &mut String, name: &str, value: Option<u32>, first: &mut bool) {
    if let Some(value) = value {
        write_field_prefix(buf, name, first);
        buf.push_str(&value.to_string());
    }
}

fn write_f64_field(buf: &mut String, name: &str, value: f64, first: &mut bool) {
    write_field_prefix(buf, name, first);
    if value.is_finite() {
        buf.push_str(&value.to_string());
    } else {
        buf.push_str("null");
    }
}

fn write_field_prefix(buf: &mut String, name: &str, first: &mut bool) {
    if *first {
        *first = false;
    } else {
        buf.push(',');
    }
    write_json_string(buf, name);
    buf.push(':');
}

fn write_text_source_span_json(buf: &mut String, source: &crate::paint::TextSourceSpan) {
    buf.push_str("{\"id\":");
    buf.push_str(&source.id.0.to_string());
    buf.push_str(",\"utf8Range\":");
    write_text_source_range_json(buf, source.utf8_range);
    buf.push_str(",\"utf16Range\":");
    write_text_source_range_json(buf, source.utf16_range);
    if let Some(stable_source_key) = &source.stable_source_key {
        buf.push_str(",\"stableSourceKey\":{\"scheme\":");
        write_json_string(buf, stable_source_key);
        buf.push('}');
    }
    buf.push('}');
}

fn write_text_source_range_json(buf: &mut String, range: crate::paint::TextSourceRange) {
    buf.push_str("{\"start\":");
    buf.push_str(&range.start.to_string());
    buf.push_str(",\"end\":");
    buf.push_str(&range.end.to_string());
    buf.push('}');
}

fn write_json_string(buf: &mut String, value: &str) {
    buf.push('"');
    for ch in value.chars() {
        match ch {
            '"' => buf.push_str("\\\""),
            '\\' => buf.push_str("\\\\"),
            '\n' => buf.push_str("\\n"),
            '\r' => buf.push_str("\\r"),
            '\t' => buf.push_str("\\t"),
            c if c < '\x20' => {
                let _ = std::fmt::Write::write_fmt(buf, format_args!("\\u{:04x}", c as u32));
            }
            c => buf.push(c),
        }
    }
    buf.push('"');
}

pub struct TextShapeLowerer<'a> {
    resolver: &'a dyn FontResolver,
}

impl<'a> TextShapeLowerer<'a> {
    pub fn new(resolver: &'a dyn FontResolver) -> Self {
        Self { resolver }
    }

    pub fn diagnostics_only(resolver: &'a dyn FontResolver) -> Self {
        Self::new(resolver)
    }

    pub fn analyze_root(&self, root: &LayerNode) -> TextShapeReport {
        let mut report = TextShapeReport::default();
        self.collect_node(root, &mut report);
        report
    }

    pub fn lower_root(&self, root: &mut LayerNode) -> TextShapeReport {
        let mut report = TextShapeReport::default();
        self.lower_node(root, &mut report);
        report
    }

    fn collect_node(&self, node: &LayerNode, report: &mut TextShapeReport) {
        match &node.kind {
            LayerNodeKind::Group { children, .. } => {
                for child in children {
                    self.collect_node(child, report);
                }
            }
            LayerNodeKind::ClipRect { child, .. } => self.collect_node(child, report),
            LayerNodeKind::Leaf { ops, .. } => {
                for op in ops {
                    if let PaintOp::TextRun { run, .. } = op {
                        report.diagnostics.push(self.analyze_text_run(run));
                    }
                }
            }
        }
    }

    fn lower_node(&self, node: &mut LayerNode, report: &mut TextShapeReport) {
        match &mut node.kind {
            LayerNodeKind::Group { children, .. } => {
                for child in children {
                    self.lower_node(child, report);
                }
            }
            LayerNodeKind::ClipRect { child, .. } => self.lower_node(child, report),
            LayerNodeKind::Leaf { ops, .. } => {
                let mut lowered = Vec::with_capacity(ops.len());
                for op in ops.drain(..) {
                    if let PaintOp::TextRun { bbox, run } = op {
                        let (diagnostic, measurement, glyph_run) = self.lower_text_run(bbox, &run);
                        report.diagnostics.push(diagnostic);
                        if let Some(measurement) = measurement {
                            report.shaped_measurements.push(measurement);
                        }
                        lowered.push(PaintOp::TextRun { bbox, run });
                        if let Some(glyph_run) = glyph_run {
                            lowered.push(PaintOp::GlyphRun {
                                bbox,
                                run: glyph_run,
                            });
                        }
                    } else {
                        lowered.push(op);
                    }
                }
                *ops = lowered;
            }
        }
    }

    fn analyze_text_run(&self, run: &LayerTextRunPaint) -> TextShapeDiagnostic {
        self.evaluate_text_run(None, run).0
    }

    fn lower_text_run(
        &self,
        bbox: BoundingBox,
        run: &LayerTextRunPaint,
    ) -> (
        TextShapeDiagnostic,
        Option<ShapedMeasurementRunReport>,
        Option<LayerGlyphRunPaint>,
    ) {
        self.evaluate_text_run(Some(bbox), run)
    }

    fn evaluate_text_run(
        &self,
        bbox: Option<BoundingBox>,
        run: &LayerTextRunPaint,
    ) -> (
        TextShapeDiagnostic,
        Option<ShapedMeasurementRunReport>,
        Option<LayerGlyphRunPaint>,
    ) {
        let has_source = run.source.is_some();
        let excluded_by_cluster = run.clusters.iter().any(|cluster| {
            cluster
                .flags
                .contains(&TextClusterFlag::NotShapingCandidate)
        });
        let excluded_by_projection = run.display_text.is_some();
        let excluded_by_legacy_visual = run.char_overlap.is_some()
            || run
                .legacy_visuals
                .char_overlap
                .is_some_and(|state| state == crate::paint::TextLegacyVisualState::Mirror);

        if !has_source {
            return (
                TextShapeDiagnostic {
                    text: run.text.clone(),
                    attempted: false,
                    public_glyph_run_emitted: false,
                    quality: GlyphRunQuality::Omitted,
                    replay_eligibility: GlyphRunReplayEligibility::NotReplayable,
                    strict_visual_eligible: false,
                    reason: Some("missingSourceSpan".to_string()),
                },
                None,
                None,
            );
        }

        if excluded_by_cluster || excluded_by_projection || excluded_by_legacy_visual {
            return (
                TextShapeDiagnostic {
                    text: run.text.clone(),
                    attempted: false,
                    public_glyph_run_emitted: false,
                    quality: GlyphRunQuality::Omitted,
                    replay_eligibility: GlyphRunReplayEligibility::NotReplayable,
                    strict_visual_eligible: false,
                    reason: Some("notShapingCandidate".to_string()),
                },
                None,
                None,
            );
        }

        let request = FontRequest::from(run);
        let resolved = self.resolver.resolve_font(&request);
        let replay_eligibility = GlyphRunReplayEligibility::from(resolved.portability);
        let attempted = matches!(
            replay_eligibility,
            GlyphRunReplayEligibility::Portable
                | GlyphRunReplayEligibility::ConditionalExternalFont
                | GlyphRunReplayEligibility::LocalDiagnosticOnly
        );
        let mut diagnostic_quality = if attempted {
            GlyphRunQuality::DiagnosticOnly
        } else {
            GlyphRunQuality::Omitted
        };
        let mut reason = match replay_eligibility {
            GlyphRunReplayEligibility::Portable => Some("diagnosticsOnlySkeleton".to_string()),
            GlyphRunReplayEligibility::ConditionalExternalFont => {
                Some("externalFontRequiresConsumerVerification".to_string())
            }
            GlyphRunReplayEligibility::LocalDiagnosticOnly => {
                Some("localDiagnosticOnly".to_string())
            }
            GlyphRunReplayEligibility::NotReplayable => Some("fontResourceUnavailable".to_string()),
        };

        let mut public_glyph_run = None;
        let mut public_glyph_run_emitted = false;
        let mut strict_visual_eligible = false;
        let paint_style = PaintTextStyle::from(&run.style);

        let shaped = if matches!(
            replay_eligibility,
            GlyphRunReplayEligibility::Portable
                | GlyphRunReplayEligibility::ConditionalExternalFont
        ) {
            self.resolver.shape_glyph_run(&request, run, &resolved)
        } else {
            None
        };
        let measurement_report = shaped
            .as_ref()
            .map(|shaped| shaped_measurement_report(run, shaped));

        if let (Some(bbox), Some(source), Some(variant), Some(shaped)) =
            (bbox, run.source.clone(), run.variant.clone(), shaped)
        {
            if !paint_style.is_simple_glyph_run_replay() {
                reason = Some("unsupportedGlyphRunPaintEffect".to_string());
            } else if glyph_run_is_exportable(&shaped) {
                let mut glyph_variant = variant;
                glyph_variant.variant_id = "glyphRun".to_string();
                glyph_variant.variant_kind = TextVariantKind::GlyphRun;
                glyph_variant.is_default_fallback = false;
                glyph_variant.requires =
                    vec!["fontResources".to_string(), "text.glyphRun".to_string()];
                glyph_variant.quality = Some(shaped.diagnostics.quality);
                diagnostic_quality = glyph_quality_from_variant(shaped.diagnostics.quality);
                strict_visual_eligible = shaped.diagnostics.strict_visual_eligible;
                reason = shaped.diagnostics.reason.clone();
                public_glyph_run_emitted = true;
                public_glyph_run = Some(LayerGlyphRunPaint {
                    source,
                    variant: glyph_variant,
                    paint_style: paint_style.clone(),
                    shape_key: shaped.shape_key.clone(),
                    placement: run
                        .placement
                        .unwrap_or_else(|| fallback_placement(bbox, run)),
                    glyph_ids: shaped.glyph_ids,
                    positions: shaped.positions,
                    advances: shaped.advances,
                    clusters: shaped.clusters,
                    direction: shaped.shape_key.direction,
                    bidi_level: None,
                    writing_mode: shaped.shape_key.writing_mode,
                    orientation: GlyphRunOrientation::from_text_orientation(run.orientation),
                    glyph_transforms: None,
                    diagnostics: shaped.diagnostics,
                });
            } else {
                reason = Some("glyphRunDiagnosticsNotExportable".to_string());
            }
        }

        (
            TextShapeDiagnostic {
                text: run.text.clone(),
                attempted,
                public_glyph_run_emitted,
                quality: diagnostic_quality,
                replay_eligibility,
                strict_visual_eligible,
                reason,
            },
            measurement_report,
            public_glyph_run,
        )
    }
}

fn shaped_measurement_report(
    run: &LayerTextRunPaint,
    shaped: &ResolvedGlyphRun,
) -> ShapedMeasurementRunReport {
    let legacy_width_px = run
        .positions
        .first()
        .zip(run.positions.last())
        .map(|(first, last)| (last - first).abs())
        .unwrap_or(0.0);
    let shaped_width_px = shaped_width(shaped);
    let delta_px = shaped_width_px - legacy_width_px;
    let delta_ratio = if legacy_width_px.abs() > f64::EPSILON {
        delta_px / legacy_width_px
    } else {
        0.0
    };
    ShapedMeasurementRunReport {
        document_id: None,
        sample_id: None,
        page_index: None,
        text_op_id: None,
        source: run.source.clone(),
        legacy_width_px,
        shaped_width_px,
        delta_px,
        delta_ratio,
        cluster_mismatch_count: shaped.diagnostics.cluster_mismatch_count,
        fallback_font_difference: shaped.diagnostics.used_fallback_font_count > 0,
        vertical_metric_difference: false,
        shaping_quality: Some(glyph_quality_from_variant(shaped.diagnostics.quality)),
    }
}

fn shaped_width(shaped: &ResolvedGlyphRun) -> f64 {
    if shaped.positions.is_empty() {
        return 0.0;
    }
    let start = shaped
        .positions
        .iter()
        .map(|point| point.x)
        .fold(f64::INFINITY, f64::min);
    let end = shaped
        .positions
        .iter()
        .enumerate()
        .map(|(idx, point)| {
            point.x
                + shaped
                    .advances
                    .as_ref()
                    .and_then(|advances| advances.get(idx))
                    .map(|advance| advance.dx)
                    .unwrap_or(0.0)
        })
        .fold(f64::NEG_INFINITY, f64::max);
    if start.is_finite() && end.is_finite() {
        (end - start).abs()
    } else {
        0.0
    }
}

fn fallback_placement(bbox: BoundingBox, run: &LayerTextRunPaint) -> TextRunPlacement {
    TextRunPlacement {
        run_to_page: LayerAffineTransform {
            a: 1.0,
            b: 0.0,
            c: 0.0,
            d: 1.0,
            e: bbox.x,
            f: bbox.y + run.baseline,
        },
        baseline_y: 0.0,
    }
}

fn glyph_run_is_exportable(shaped: &ResolvedGlyphRun) -> bool {
    strict_glyph_run_geometry_contract_error(
        &shaped.glyph_ids,
        &shaped.positions,
        shaped.advances.as_deref(),
        shaped.clusters.len(),
        shaped.shape_key.font_instance.size_px,
    )
    .is_none()
        && !shaped.clusters.is_empty()
        && matches!(
            shaped.diagnostics.replay_eligibility,
            GlyphRunReplayEligibility::Portable
                | GlyphRunReplayEligibility::ConditionalExternalFont
        )
        && matches!(
            shaped.diagnostics.quality,
            TextVariantQuality::Exact | TextVariantQuality::PositionAdjusted
        )
        && shaped.diagnostics.missing_glyph_count == 0
        && shaped.diagnostics.cluster_mismatch_count == 0
}

fn glyph_quality_from_variant(quality: TextVariantQuality) -> GlyphRunQuality {
    match quality {
        TextVariantQuality::Exact => GlyphRunQuality::Exact,
        TextVariantQuality::PositionAdjusted => GlyphRunQuality::PositionAdjusted,
        TextVariantQuality::Approximate => GlyphRunQuality::Approximate,
        TextVariantQuality::DiagnosticOnly => GlyphRunQuality::DiagnosticOnly,
        TextVariantQuality::Omitted => GlyphRunQuality::Omitted,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paint::{
        FontFaceKey, FontFallbackPolicyId, FontInstanceKey, GlyphCluster, GlyphRange, LayerNode,
        LayerTextRunPaint, ScriptTag, ShapingEngineId, TextDirection, TextSourceId,
        TextSourceRange, TextSourceSpan, WritingMode,
    };

    struct PortableResolver;

    impl FontResolver for PortableResolver {
        fn resolve_font(&self, _request: &FontRequest) -> ResolvedFontFace {
            ResolvedFontFace {
                portability: FontPortabilityKind::PortableBlob,
            }
        }
    }

    #[test]
    fn line_break_shadow_risk_distinguishes_known_absent_from_unknown_context() {
        let mut shadow = LineBreakShadowReport {
            document_id: None,
            sample_id: None,
            page_index: Some(0),
            paragraph_id: Some("paragraph-0".to_string()),
            line_index: 0,
            has_full_layout_context: true,
            legacy_available_width_px: LineBreakContextValue::Known(128.0),
            paragraph_width_px: LineBreakContextValue::Known(160.0),
            container_width_px: LineBreakContextValue::KnownAbsent,
            table_cell_constraint: LineBreakContextValue::KnownAbsent,
            tab_stop_summary: LineBreakContextValue::KnownAbsent,
            justification: LineBreakContextValue::KnownAbsent,
            legacy_line_segmentation_available: LineBreakContextValue::Known(true),
            legacy_line_width_px: 96.0,
            shaped_line_width_px: 98.0,
            overflow_delta_px: Some(-30.0),
            risk: LineBreakChangeRisk::NoChangeLikely,
            reason: Some("knownAbsentOptionalContexts".to_string()),
        };

        assert!(shadow.has_minimum_layout_context());
        assert_eq!(shadow.reported_risk(), LineBreakChangeRisk::NoChangeLikely);

        shadow.tab_stop_summary = LineBreakContextValue::Unknown;
        assert!(!shadow.has_minimum_layout_context());
        assert_eq!(
            shadow.reported_risk(),
            LineBreakChangeRisk::InsufficientContext
        );

        shadow.tab_stop_summary = LineBreakContextValue::KnownAbsent;
        shadow.legacy_available_width_px = LineBreakContextValue::Unknown;
        assert!(!shadow.has_minimum_layout_context());
        assert_eq!(
            shadow.reported_risk(),
            LineBreakChangeRisk::InsufficientContext
        );
    }

    struct EmittingResolver;

    impl FontResolver for EmittingResolver {
        fn resolve_font(&self, _request: &FontRequest) -> ResolvedFontFace {
            ResolvedFontFace {
                portability: FontPortabilityKind::PortableBlob,
            }
        }

        fn shape_glyph_run(
            &self,
            _request: &FontRequest,
            run: &LayerTextRunPaint,
            _resolved: &ResolvedFontFace,
        ) -> Option<ResolvedGlyphRun> {
            Some(ResolvedGlyphRun {
                shape_key: placeholder_shape_key(
                    FontFaceKey("font-face-0".to_string()),
                    run.style.font_size.max(12.0),
                ),
                glyph_ids: vec![42],
                positions: vec![LayerPoint { x: 0.0, y: 0.0 }],
                advances: Some(vec![LayerVector { dx: 12.0, dy: 0.0 }]),
                clusters: vec![GlyphCluster {
                    source_range_utf8: TextSourceRange::new(0, run.text.len() as u32),
                    source_range_utf16: Some(TextSourceRange::new(
                        0,
                        run.text.encode_utf16().count() as u32,
                    )),
                    text_range_utf8: Some(TextSourceRange::new(0, run.text.len() as u32)),
                    glyph_range: GlyphRange::new(0, 1),
                    flags: Vec::new(),
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
            })
        }
    }

    fn placeholder_shape_key(face_key: FontFaceKey, size_px: f64) -> ShapeKey {
        ShapeKey {
            font_instance: FontInstanceKey {
                face_key,
                size_px,
                variations: Vec::new(),
                synthetic_bold: false,
                synthetic_italic: false,
            },
            direction: TextDirection::Ltr,
            writing_mode: WritingMode::HorizontalTb,
            script: Some(ScriptTag("DFLT".to_string())),
            language: None,
            features: Vec::new(),
            shaping_engine: ShapingEngineId("test".to_string()),
            fallback_policy: FontFallbackPolicyId("none".to_string()),
        }
    }

    fn sourced_text_run(text: &str) -> LayerTextRunPaint {
        LayerTextRunPaint {
            source: Some(TextSourceSpan {
                id: TextSourceId(0),
                utf8_range: TextSourceRange::new(0, text.len() as u32),
                utf16_range: TextSourceRange::new(0, text.encode_utf16().count() as u32),
                stable_source_key: None,
            }),
            variant: Some(crate::paint::PaintVariantMeta::text_run_default("text-0")),
            text: text.to_string(),
            ..LayerTextRunPaint::default()
        }
    }

    #[test]
    fn diagnostics_only_lowerer_never_emits_public_glyph_runs() {
        let root = LayerNode::leaf(
            BoundingBox::new(0.0, 0.0, 100.0, 100.0),
            None,
            vec![PaintOp::TextRun {
                bbox: BoundingBox::new(0.0, 0.0, 20.0, 20.0),
                run: sourced_text_run("가"),
            }],
        );
        let lowerer = TextShapeLowerer::diagnostics_only(&PortableResolver);
        let report = lowerer.analyze_root(&root);

        assert_eq!(report.public_glyph_run_count(), 0);
        assert_eq!(report.diagnostics.len(), 1);
        assert!(report.diagnostics[0].attempted);
        assert_eq!(
            report.diagnostics[0].replay_eligibility,
            GlyphRunReplayEligibility::Portable
        );
        assert_eq!(
            report.diagnostics[0].quality,
            GlyphRunQuality::DiagnosticOnly
        );
    }

    #[test]
    fn lowerer_emits_public_glyph_run_only_from_exportable_shaped_data() {
        let mut text_run = sourced_text_run("A");
        text_run.positions = vec![0.0, 10.0];
        let mut root = LayerNode::leaf(
            BoundingBox::new(0.0, 0.0, 100.0, 100.0),
            None,
            vec![PaintOp::TextRun {
                bbox: BoundingBox::new(0.0, 0.0, 20.0, 20.0),
                run: text_run,
            }],
        );
        let lowerer = TextShapeLowerer::new(&EmittingResolver);
        let mut report = lowerer.lower_root(&mut root);

        assert_eq!(report.public_glyph_run_count(), 1);
        assert_eq!(report.shaped_measurements.len(), 1);
        assert_eq!(report.shaped_measurements[0].legacy_width_px, 10.0);
        assert_eq!(report.shaped_measurements[0].shaped_width_px, 12.0);
        assert_eq!(report.shaped_measurements[0].delta_px, 2.0);
        assert_eq!(
            report.shaped_measurements[0].shaping_quality,
            Some(GlyphRunQuality::Exact)
        );
        assert!(report
            .summarize_shaped_measurement_line(
                None,
                None,
                Some(0),
                Some("paragraph-0".to_string()),
                0,
                &[0],
            )
            .is_some());
        assert_eq!(report.shaped_measurement_lines.len(), 1);
        assert_eq!(
            report.shaped_measurement_lines[0].legacy_line_width_px,
            10.0
        );
        assert_eq!(
            report.shaped_measurement_lines[0].shaped_line_width_px,
            12.0
        );
        assert_eq!(report.shaped_measurement_lines[0].delta_px, 2.0);
        assert_eq!(report.shaped_measurement_lines[0].contributing_run_count, 1);
        assert_eq!(report.shaped_measurement_lines[0].max_run_delta_px, 2.0);
        assert!(report
            .summarize_shaped_measurement_paragraph(
                None,
                None,
                Some(0),
                Some("paragraph-0".to_string()),
                &[0],
            )
            .is_some());
        assert_eq!(report.shaped_measurement_paragraphs.len(), 1);
        assert_eq!(report.shaped_measurement_paragraphs[0].line_count, 1);
        assert_eq!(report.shaped_measurement_paragraphs[0].run_count, 1);
        assert_eq!(
            report.shaped_measurement_paragraphs[0].max_run_delta_px,
            2.0
        );
        assert_eq!(
            report.shaped_measurement_paragraphs[0].max_line_delta_px,
            2.0
        );
        assert_eq!(
            report.shaped_measurement_paragraphs[0].total_abs_delta_px,
            2.0
        );
        assert!(report
            .summarize_shaped_measurement_page(None, None, Some(0), &[0])
            .is_some());
        assert_eq!(report.shaped_measurement_pages.len(), 1);
        assert_eq!(report.shaped_measurement_pages[0].paragraph_count, 1);
        assert_eq!(report.shaped_measurement_pages[0].line_count, 1);
        assert_eq!(report.shaped_measurement_pages[0].run_count, 1);
        assert_eq!(report.shaped_measurement_pages[0].max_run_delta_px, 2.0);
        assert_eq!(report.shaped_measurement_pages[0].max_line_delta_px, 2.0);
        assert_eq!(report.shaped_measurement_pages[0].total_abs_delta_px, 2.0);
        report.line_break_shadows.push(LineBreakShadowReport {
            document_id: None,
            sample_id: None,
            page_index: Some(0),
            paragraph_id: Some("paragraph-0".to_string()),
            line_index: 0,
            has_full_layout_context: true,
            legacy_available_width_px: LineBreakContextValue::Known(14.0),
            paragraph_width_px: LineBreakContextValue::Known(16.0),
            container_width_px: LineBreakContextValue::Known(18.0),
            table_cell_constraint: LineBreakContextValue::Known(TableCellConstraintSummary {
                cell_width_px: Some(20.0),
                content_width_px: Some(18.0),
                available_width_px: Some(14.0),
            }),
            tab_stop_summary: LineBreakContextValue::Known(TabStopSummary {
                count: 2,
                next_tab_stop_px: Some(24.0),
                has_leaders: true,
            }),
            justification: LineBreakContextValue::Known(JustificationMode::Justify),
            legacy_line_segmentation_available: LineBreakContextValue::Known(true),
            legacy_line_width_px: 10.0,
            shaped_line_width_px: 12.0,
            overflow_delta_px: Some(-2.0),
            risk: LineBreakChangeRisk::NoChangeLikely,
            reason: Some("withinLegacyAvailableWidth".to_string()),
        });
        report.line_break_shadows.push(LineBreakShadowReport {
            document_id: None,
            sample_id: None,
            page_index: Some(0),
            paragraph_id: Some("paragraph-1".to_string()),
            line_index: 1,
            has_full_layout_context: false,
            legacy_available_width_px: LineBreakContextValue::Unknown,
            paragraph_width_px: LineBreakContextValue::Unknown,
            container_width_px: LineBreakContextValue::Unknown,
            table_cell_constraint: LineBreakContextValue::Unknown,
            tab_stop_summary: LineBreakContextValue::Unknown,
            justification: LineBreakContextValue::Unknown,
            legacy_line_segmentation_available: LineBreakContextValue::Unknown,
            legacy_line_width_px: 10.0,
            shaped_line_width_px: 12.0,
            overflow_delta_px: None,
            risk: LineBreakChangeRisk::ChangeLikely,
            reason: Some("missingFullLayoutContext".to_string()),
        });
        report.line_break_shadows.push(LineBreakShadowReport {
            document_id: None,
            sample_id: None,
            page_index: Some(0),
            paragraph_id: Some("paragraph-2".to_string()),
            line_index: 2,
            has_full_layout_context: true,
            legacy_available_width_px: LineBreakContextValue::Unknown,
            paragraph_width_px: LineBreakContextValue::Known(16.0),
            container_width_px: LineBreakContextValue::KnownAbsent,
            table_cell_constraint: LineBreakContextValue::KnownAbsent,
            tab_stop_summary: LineBreakContextValue::KnownAbsent,
            justification: LineBreakContextValue::KnownAbsent,
            legacy_line_segmentation_available: LineBreakContextValue::Known(false),
            legacy_line_width_px: 10.0,
            shaped_line_width_px: 12.0,
            overflow_delta_px: None,
            risk: LineBreakChangeRisk::ChangeLikely,
            reason: Some("missingWidthAndLineSegmentationContext".to_string()),
        });
        report.line_break_shadows.push(LineBreakShadowReport {
            document_id: None,
            sample_id: None,
            page_index: Some(0),
            paragraph_id: Some("paragraph-3".to_string()),
            line_index: 3,
            has_full_layout_context: true,
            legacy_available_width_px: LineBreakContextValue::Known(14.0),
            paragraph_width_px: LineBreakContextValue::Known(16.0),
            container_width_px: LineBreakContextValue::KnownAbsent,
            table_cell_constraint: LineBreakContextValue::KnownAbsent,
            tab_stop_summary: LineBreakContextValue::KnownAbsent,
            justification: LineBreakContextValue::KnownAbsent,
            legacy_line_segmentation_available: LineBreakContextValue::Known(false),
            legacy_line_width_px: 13.0,
            shaped_line_width_px: 14.5,
            overflow_delta_px: Some(0.5),
            risk: LineBreakChangeRisk::ChangePossible,
            reason: Some("knownAbsentContextStillUsable".to_string()),
        });
        let measurement_json = report.shaped_measurements_json();
        assert!(measurement_json.contains("\"shapedMeasurements\""));
        assert!(measurement_json.contains("\"shapedMeasurementLines\""));
        assert!(measurement_json.contains("\"lineBreakShadows\""));
        assert!(measurement_json.contains("\"shapedMeasurementParagraphs\""));
        assert!(measurement_json.contains("\"shapedMeasurementPages\""));
        assert!(measurement_json.contains("\"legacyWidthPx\":10"));
        assert!(measurement_json.contains("\"shapedWidthPx\":12"));
        assert!(measurement_json.contains("\"deltaPx\":2"));
        assert!(measurement_json.contains("\"shapingQuality\":\"exact\""));
        assert!(measurement_json.contains("\"paragraphId\":\"paragraph-0\""));
        assert!(measurement_json.contains("\"legacyLineWidthPx\":10"));
        assert!(measurement_json.contains("\"shapedLineWidthPx\":12"));
        assert!(measurement_json.contains("\"contributingRunCount\":1"));
        assert!(measurement_json.contains("\"hasFullLayoutContext\":true"));
        assert!(measurement_json
            .contains("\"legacyAvailableWidthPx\":{\"state\":\"known\",\"value\":14}"));
        assert!(
            measurement_json.contains("\"paragraphWidthPx\":{\"state\":\"known\",\"value\":16}")
        );
        assert!(
            measurement_json.contains("\"containerWidthPx\":{\"state\":\"known\",\"value\":18}")
        );
        assert!(measurement_json.contains("\"tableCellConstraint\""));
        assert!(measurement_json.contains("\"cellWidthPx\":20"));
        assert!(measurement_json.contains("\"contentWidthPx\":18"));
        assert!(measurement_json.contains("\"availableWidthPx\":14"));
        assert!(measurement_json.contains("\"tabStopSummary\""));
        assert!(measurement_json.contains("\"nextTabStopPx\":24"));
        assert!(measurement_json.contains("\"hasLeaders\":true"));
        assert!(measurement_json
            .contains("\"justification\":{\"state\":\"known\",\"value\":\"justify\"}"));
        assert!(measurement_json
            .contains("\"legacyLineSegmentationAvailable\":{\"state\":\"known\",\"value\":true}"));
        assert!(measurement_json.contains("\"state\":\"knownAbsent\""));
        assert!(measurement_json.contains("\"state\":\"unknown\""));
        assert!(measurement_json.contains("\"overflowDeltaPx\":-2"));
        assert!(measurement_json.contains("\"risk\":\"noChangeLikely\""));
        assert!(measurement_json.contains("\"reason\":\"withinLegacyAvailableWidth\""));
        assert!(measurement_json
            .contains("\"legacyLineSegmentationAvailable\":{\"state\":\"known\",\"value\":false}"));
        assert!(measurement_json.contains("\"risk\":\"insufficientContext\""));
        assert!(measurement_json.contains("\"reason\":\"missingFullLayoutContext\""));
        assert!(measurement_json.contains("\"paragraphId\":\"paragraph-2\""));
        assert!(measurement_json.contains("\"reason\":\"missingWidthAndLineSegmentationContext\""));
        assert!(measurement_json.contains("\"paragraphId\":\"paragraph-3\""));
        assert!(measurement_json.contains("\"risk\":\"changePossible\""));
        assert!(measurement_json.contains("\"reason\":\"knownAbsentContextStillUsable\""));
        assert!(measurement_json.contains("\"paragraphCount\":1"));
        assert!(measurement_json.contains("\"totalAbsDeltaPx\":2"));
        assert!(!measurement_json.contains("lineBreakWouldChange"));
        let LayerNodeKind::Leaf { ops, .. } = &root.kind else {
            panic!("expected leaf root");
        };
        assert!(matches!(ops[0], PaintOp::TextRun { .. }));
        let PaintOp::GlyphRun { run, .. } = &ops[1] else {
            panic!("expected glyph run variant");
        };
        assert_eq!(run.variant.equivalence_group, "text-0");
        assert_eq!(run.variant.variant_id, "glyphRun");
        assert_eq!(run.variant.variant_kind, TextVariantKind::GlyphRun);
        assert!(!run.variant.is_default_fallback);
        assert_eq!(run.glyph_ids, vec![42]);
        assert!(run.diagnostics.strict_visual_eligible);
    }

    #[test]
    fn lowerer_does_not_shape_source_display_projections() {
        let mut text_run = sourced_text_run("ᄒ");
        text_run.display_text = Some("한".to_string());
        text_run.positions = vec![0.0, 10.0];
        let mut root = LayerNode::leaf(
            BoundingBox::new(0.0, 0.0, 100.0, 100.0),
            None,
            vec![PaintOp::TextRun {
                bbox: BoundingBox::new(0.0, 0.0, 20.0, 20.0),
                run: text_run,
            }],
        );

        let report = TextShapeLowerer::new(&EmittingResolver).lower_root(&mut root);

        assert_eq!(report.public_glyph_run_count(), 0);
        assert_eq!(
            report.diagnostics[0].reason.as_deref(),
            Some("notShapingCandidate")
        );
        let LayerNodeKind::Leaf { ops, .. } = &root.kind else {
            panic!("expected leaf root");
        };
        assert!(matches!(ops.as_slice(), [PaintOp::TextRun { .. }]));
    }

    #[test]
    fn summarizes_multiple_paragraphs_and_pages_as_report_only_telemetry() {
        let mut report = TextShapeReport::default();
        report.shaped_measurements.push(ShapedMeasurementRunReport {
            document_id: Some("doc".to_string()),
            sample_id: Some("sample".to_string()),
            page_index: Some(0),
            text_op_id: Some("text-0".to_string()),
            source: None,
            legacy_width_px: 10.0,
            shaped_width_px: 12.0,
            delta_px: 2.0,
            delta_ratio: 0.2,
            cluster_mismatch_count: 1,
            fallback_font_difference: true,
            vertical_metric_difference: false,
            shaping_quality: Some(GlyphRunQuality::Exact),
        });
        report.shaped_measurements.push(ShapedMeasurementRunReport {
            document_id: Some("doc".to_string()),
            sample_id: Some("sample".to_string()),
            page_index: Some(0),
            text_op_id: Some("text-1".to_string()),
            source: None,
            legacy_width_px: 20.0,
            shaped_width_px: 19.0,
            delta_px: -1.0,
            delta_ratio: -0.05,
            cluster_mismatch_count: 2,
            fallback_font_difference: false,
            vertical_metric_difference: true,
            shaping_quality: Some(GlyphRunQuality::PositionAdjusted),
        });
        report.shaped_measurements.push(ShapedMeasurementRunReport {
            document_id: Some("doc".to_string()),
            sample_id: Some("sample".to_string()),
            page_index: Some(1),
            text_op_id: Some("text-2".to_string()),
            source: None,
            legacy_width_px: 30.0,
            shaped_width_px: 33.0,
            delta_px: 3.0,
            delta_ratio: 0.1,
            cluster_mismatch_count: 0,
            fallback_font_difference: false,
            vertical_metric_difference: false,
            shaping_quality: Some(GlyphRunQuality::Exact),
        });

        assert!(report
            .summarize_shaped_measurement_line(
                Some("doc".to_string()),
                Some("sample".to_string()),
                Some(0),
                Some("p0".to_string()),
                0,
                &[0, 1],
            )
            .is_some());
        assert!(report
            .summarize_shaped_measurement_line(
                Some("doc".to_string()),
                Some("sample".to_string()),
                Some(1),
                Some("p1".to_string()),
                0,
                &[2],
            )
            .is_some());
        assert!(report
            .summarize_shaped_measurement_line(None, None, Some(9), None, 99, &[99])
            .is_none());
        assert_eq!(report.shaped_measurement_lines.len(), 2);
        assert_eq!(
            report.shaped_measurement_lines[0].legacy_line_width_px,
            30.0
        );
        assert_eq!(
            report.shaped_measurement_lines[0].shaped_line_width_px,
            31.0
        );
        assert_eq!(report.shaped_measurement_lines[0].delta_px, 1.0);
        assert_eq!(report.shaped_measurement_lines[0].contributing_run_count, 2);
        assert_eq!(report.shaped_measurement_lines[0].max_run_delta_px, 2.0);
        assert_eq!(
            report.shaped_measurement_lines[0].fallback_font_difference_count,
            1
        );
        assert_eq!(
            report.shaped_measurement_lines[0].vertical_metric_difference_count,
            1
        );
        assert_eq!(
            report.shaped_measurement_lines[0].cluster_mismatch_count_sum,
            3
        );

        assert!(report
            .summarize_shaped_measurement_paragraph(
                Some("doc".to_string()),
                Some("sample".to_string()),
                Some(0),
                Some("p0".to_string()),
                &[0],
            )
            .is_some());
        assert!(report
            .summarize_shaped_measurement_paragraph(
                Some("doc".to_string()),
                Some("sample".to_string()),
                Some(1),
                Some("p1".to_string()),
                &[1],
            )
            .is_some());
        assert!(report
            .summarize_shaped_measurement_paragraph(None, None, Some(9), None, &[99])
            .is_none());
        assert_eq!(report.shaped_measurement_paragraphs.len(), 2);
        assert_eq!(report.shaped_measurement_paragraphs[0].line_count, 1);
        assert_eq!(report.shaped_measurement_paragraphs[0].run_count, 2);
        assert_eq!(
            report.shaped_measurement_paragraphs[0].total_abs_delta_px,
            1.0
        );

        assert!(report
            .summarize_shaped_measurement_page(
                Some("doc".to_string()),
                Some("sample".to_string()),
                Some(0),
                &[0],
            )
            .is_some());
        assert!(report
            .summarize_shaped_measurement_page(
                Some("doc".to_string()),
                Some("sample".to_string()),
                Some(1),
                &[1],
            )
            .is_some());
        assert!(report
            .summarize_shaped_measurement_page(None, None, Some(9), &[99])
            .is_none());
        assert_eq!(report.shaped_measurement_pages.len(), 2);
        assert_eq!(report.shaped_measurement_pages[0].paragraph_count, 1);
        assert_eq!(report.shaped_measurement_pages[0].line_count, 1);
        assert_eq!(report.shaped_measurement_pages[0].run_count, 2);
        assert_eq!(report.shaped_measurement_pages[0].max_run_delta_px, 2.0);
        assert_eq!(report.shaped_measurement_pages[0].max_line_delta_px, 1.0);
        assert_eq!(report.shaped_measurement_pages[0].total_abs_delta_px, 1.0);
        assert_eq!(
            report.shaped_measurement_pages[0].fallback_font_difference_count,
            1
        );
        assert_eq!(
            report.shaped_measurement_pages[0].vertical_metric_difference_count,
            1
        );
        assert_eq!(
            report.shaped_measurement_pages[0].cluster_mismatch_count_sum,
            3
        );
        assert_eq!(report.shaped_measurement_pages[1].page_index, Some(1));
        assert_eq!(report.shaped_measurement_pages[1].max_run_delta_px, 3.0);
        assert_eq!(report.shaped_measurement_pages[1].max_line_delta_px, 3.0);
        assert_eq!(report.shaped_measurement_pages[1].total_abs_delta_px, 3.0);

        let measurement_json = report.shaped_measurements_json();
        assert!(measurement_json.contains("\"shapedMeasurementPages\""));
        assert!(measurement_json.contains("\"pageIndex\":1"));
        assert!(measurement_json.contains("\"textOpId\":\"text-2\""));
        assert!(!measurement_json.contains("lineBreakWouldChange"));
    }

    #[test]
    fn lowerer_emits_glyph_runs_for_simple_shadow_outline_and_relief_effects() {
        let mut shadow_run = sourced_text_run("A");
        shadow_run.style.shadow_type = 1;
        shadow_run.style.shadow_offset_x = 4.0;
        shadow_run.style.shadow_offset_y = 2.0;
        let mut outline_run = sourced_text_run("A");
        outline_run.style.outline_type = 1;
        let mut emboss_run = sourced_text_run("A");
        emboss_run.style.emboss = true;
        let mut engrave_run = sourced_text_run("A");
        engrave_run.style.engrave = true;

        for (case_name, text_run) in [
            ("shadow", shadow_run),
            ("outline", outline_run),
            ("emboss", emboss_run),
            ("engrave", engrave_run),
        ] {
            let mut root = LayerNode::leaf(
                BoundingBox::new(0.0, 0.0, 100.0, 100.0),
                None,
                vec![PaintOp::TextRun {
                    bbox: BoundingBox::new(0.0, 0.0, 20.0, 20.0),
                    run: text_run,
                }],
            );
            let report = TextShapeLowerer::new(&EmittingResolver).lower_root(&mut root);

            assert_eq!(report.public_glyph_run_count(), 1, "{case_name}");
            let LayerNodeKind::Leaf { ops, .. } = &root.kind else {
                panic!("expected leaf root");
            };
            let PaintOp::GlyphRun { run, .. } = &ops[1] else {
                panic!("expected {case_name} glyph run variant");
            };
            assert!(run.paint_style.is_simple_glyph_run_replay(), "{case_name}");
            assert!(!run.paint_style.is_fill_only_glyph_replay(), "{case_name}");
        }
    }

    #[test]
    fn lowerer_excludes_glyph_runs_outside_the_bounded_geometry_contract() {
        let text_run = sourced_text_run("A");
        let request = FontRequest::from(&text_run);
        let resolved = EmittingResolver.resolve_font(&request);
        let base = EmittingResolver
            .shape_glyph_run(&request, &text_run, &resolved)
            .expect("fixture glyph run");
        let mut oversized = base.clone();
        oversized.glyph_ids = vec![42; 4097];
        oversized.positions = vec![LayerPoint { x: 0.0, y: 0.0 }; 4097];
        let mut float32_overflow = base.clone();
        float32_overflow.positions[0].x = f32::MAX as f64 * 2.0;
        let mut invalid_font_instance = base;
        invalid_font_instance.shape_key.font_instance.size_px = 0.0;

        for shaped in [oversized, float32_overflow, invalid_font_instance] {
            assert!(!glyph_run_is_exportable(&shaped));
        }
    }

    #[test]
    fn lowerer_keeps_text_fallback_when_glyph_run_effects_are_unsupported() {
        let mut text_run = sourced_text_run("A");
        text_run.style.underline = crate::model::style::UnderlineType::Bottom;
        let mut root = LayerNode::leaf(
            BoundingBox::new(0.0, 0.0, 100.0, 100.0),
            None,
            vec![PaintOp::TextRun {
                bbox: BoundingBox::new(0.0, 0.0, 20.0, 20.0),
                run: text_run,
            }],
        );
        let lowerer = TextShapeLowerer::new(&EmittingResolver);
        let report = lowerer.lower_root(&mut root);

        assert_eq!(report.public_glyph_run_count(), 0);
        assert_eq!(
            report.diagnostics[0].reason.as_deref(),
            Some("unsupportedGlyphRunPaintEffect")
        );
        let LayerNodeKind::Leaf { ops, .. } = &root.kind else {
            panic!("expected leaf root");
        };
        assert_eq!(ops.len(), 1);
        assert!(matches!(ops[0], PaintOp::TextRun { .. }));
    }

    #[test]
    fn diagnostics_only_lowerer_excludes_text_without_source() {
        let run = LayerTextRunPaint {
            text: "A".to_string(),
            ..LayerTextRunPaint::default()
        };
        let root = LayerNode::leaf(
            BoundingBox::new(0.0, 0.0, 100.0, 100.0),
            None,
            vec![PaintOp::TextRun {
                bbox: BoundingBox::new(0.0, 0.0, 20.0, 20.0),
                run,
            }],
        );
        let lowerer = TextShapeLowerer::diagnostics_only(&PortableResolver);
        let report = lowerer.analyze_root(&root);

        assert_eq!(report.diagnostics[0].quality, GlyphRunQuality::Omitted);
        assert_eq!(
            report.diagnostics[0].reason.as_deref(),
            Some("missingSourceSpan")
        );
    }
}
