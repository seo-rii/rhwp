use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;

use base64::Engine;

use crate::document_core::helpers::{color_ref_to_css, json_escape as raw_json_escape};
use crate::model::control::FormType;
use crate::model::image::ImageEffect;
use crate::model::shape::TextWrap;
use crate::model::style::{ImageFillMode, UnderlineType};
use crate::paint::{
    has_supported_strict_glyph_outline_bitmap, has_supported_strict_glyph_outline_colrv0,
    has_supported_strict_glyph_outline_colrv1, has_supported_strict_glyph_outline_stroke,
    has_supported_strict_glyph_outline_svg, CacheHint, ClipKind, GlyphCluster,
    GlyphOutlineStrokeStyle, GlyphRunDiagnostics, GlyphTransform, LayerAffineTransform, LayerNode,
    LayerNodeKind, LayerPoint, LayerSemantic, LayerTextPaintOpV2, LayerTextRunPaint,
    LayerTextVariantPart, LayerTextVariantPayload, LayerTextVariantSet, LayerVector, PageLayerTree,
    PaintOp, PaintTextStyle, PaintVariantMeta, ResourceArena, ShapeKey, TextClusterPlacement,
    TextRunPlacement, TextSourceAnnotation, TextSourceEntry, TextSourceRange, TextSourceSpan,
    TextSourceTable, TextV2ValidationIssue, TextV2ValidationIssueCode, TextV2ValidationOptions,
    LAYER_TREE_SCHEMA,
};
use crate::renderer::composer::expand_pua_display_text;
use crate::renderer::equation::ast::MatrixStyle;
use crate::renderer::equation::layout::{LayoutBox, LayoutKind};
use crate::renderer::equation::symbols::{DecoKind, FontStyleKind};
use crate::renderer::layout::compute_char_positions;
use crate::renderer::render_tree::{BoundingBox, FieldMarkerType, ShapeTransform};
use crate::renderer::{
    ArrowStyle, GradientFillInfo, LineRenderType, LineStyle, PathCommand, PatternFillInfo,
    ShadowStyle, ShapeStyle, StrokeDash, TabLeaderInfo, TextStyle,
};

impl PageLayerTree {
    pub fn to_json(&self) -> String {
        let mut buf = String::with_capacity(32_768);
        buf.push('{');
        let _ = write!(
            buf,
            "\"schemaVersion\":{},\"schemaMinorVersion\":{},\"schema\":{{\"major\":{},\"minor\":{}}},\"resourceTableVersion\":{},\"resourceTableMinorVersion\":{},\"resourceTable\":{{\"major\":{},\"minor\":{}}},\"unit\":{},\"coordinateSystem\":{},\"pageWidth\":{:.6},\"pageHeight\":{:.6},\"profile\":{},\"layout\":{{\"profile\":\"hwpCompat\",\"measurementAuthority\":\"legacyHwpPositions\",\"shapedMeasurement\":\"diagnosticsOnly\"}},\"outputOptions\":{{\"showParagraphMarks\":{},\"showControlCodes\":{},\"showTransparentBorders\":{},\"clipEnabled\":{},\"debugOverlay\":{}}},\"buildOptions\":{{\"showTransparentBorders\":{}}},\"debugOptions\":{{\"debugOverlay\":{}}},\"debugCapabilities\":{{\"overlayPaint\":false,\"semanticBounds\":true,\"genericLayerExport\":{{\"overlayPaint\":false,\"semanticBounds\":true}},\"backends\":{{\"svgLayer\":{{\"overlayPaint\":true,\"semanticBounds\":true}},\"canvas2d\":{{\"overlayPaint\":false,\"semanticBounds\":true}},\"canvaskit\":{{\"overlayPaint\":false,\"semanticBounds\":true}},\"nativeSkia\":{{\"overlayPaint\":false,\"semanticBounds\":true}}}}}},\"root\":",
            LAYER_TREE_SCHEMA.schema_version,
            LAYER_TREE_SCHEMA.schema_minor_version,
            LAYER_TREE_SCHEMA.schema_version,
            LAYER_TREE_SCHEMA.schema_minor_version,
            LAYER_TREE_SCHEMA.resource_table_version,
            LAYER_TREE_SCHEMA.resource_table_minor_version,
            LAYER_TREE_SCHEMA.resource_table_version,
            LAYER_TREE_SCHEMA.resource_table_minor_version,
            json_escape(LAYER_TREE_SCHEMA.unit),
            json_escape(LAYER_TREE_SCHEMA.coordinate_system),
            self.page_width,
            self.page_height,
            json_escape(self.profile.as_str()),
            self.output_options.show_paragraph_marks,
            self.output_options.show_control_codes,
            self.output_options.show_transparent_borders,
            self.output_options.clip_enabled,
            self.output_options.debug_overlay,
            self.output_options.show_transparent_borders,
            self.output_options.debug_overlay,
        );
        let mut text_source_state = TextSourceExportState::default();
        self.root
            .write_json(&mut buf, &self.resources, &mut text_source_state);
        if !self.variant_ops.is_empty() {
            buf.push_str(",\"variantOps\":[");
            for (idx, op) in self.variant_ops.iter().enumerate() {
                if idx > 0 {
                    buf.push(',');
                }
                op.write_json(&mut buf, &self.resources, &mut text_source_state);
            }
            buf.push(']');
        }
        buf.push_str(",\"textSources\":");
        write_text_source_entries(&mut buf, &self.text_sources);
        buf.push_str(",\"fontResources\":");
        write_font_resources(&mut buf, self.resources.font_resources());
        write_text_export_metadata(&mut buf, &self.root, &self.variant_ops);
        buf.push('}');
        buf
    }

    pub fn to_json_v2_compat(&self) -> Result<String, Vec<TextV2ValidationIssue>> {
        let slots = self.text_v2_slots();
        let issues =
            crate::paint::validate_text_v2_ops(&slots, &TextV2ValidationOptions::default());
        if !issues.is_empty() {
            return Err(issues);
        }

        let mut buf = String::with_capacity(32_768);
        buf.push('{');
        let _ = write!(
            buf,
            "\"schemaVersion\":2,\"schemaMinorVersion\":0,\"schema\":{{\"major\":2,\"minor\":0}},\"resourceTableVersion\":{},\"resourceTableMinorVersion\":{},\"resourceTable\":{{\"major\":{},\"minor\":{}}},\"unit\":{},\"coordinateSystem\":{},\"pageWidth\":{:.6},\"pageHeight\":{:.6},\"profile\":{},\"layout\":{{\"profile\":\"hwpCompat\",\"measurementAuthority\":\"legacyHwpPositions\",\"shapedMeasurement\":\"diagnosticsOnly\"}},\"outputOptions\":{{\"showParagraphMarks\":{},\"showControlCodes\":{},\"showTransparentBorders\":{},\"clipEnabled\":{},\"debugOverlay\":{}}},\"buildOptions\":{{\"showTransparentBorders\":{}}},\"debugOptions\":{{\"debugOverlay\":{}}},\"debugCapabilities\":{{\"overlayPaint\":false,\"semanticBounds\":true,\"genericLayerExport\":{{\"overlayPaint\":false,\"semanticBounds\":true}},\"backends\":{{\"svgLayer\":{{\"overlayPaint\":true,\"semanticBounds\":true}},\"canvas2d\":{{\"overlayPaint\":false,\"semanticBounds\":true}},\"canvaskit\":{{\"overlayPaint\":false,\"semanticBounds\":true}},\"nativeSkia\":{{\"overlayPaint\":false,\"semanticBounds\":true}}}}}},\"root\":",
            LAYER_TREE_SCHEMA.resource_table_version,
            LAYER_TREE_SCHEMA.resource_table_minor_version,
            LAYER_TREE_SCHEMA.resource_table_version,
            LAYER_TREE_SCHEMA.resource_table_minor_version,
            json_escape(LAYER_TREE_SCHEMA.unit),
            json_escape(LAYER_TREE_SCHEMA.coordinate_system),
            self.page_width,
            self.page_height,
            json_escape(self.profile.as_str()),
            self.output_options.show_paragraph_marks,
            self.output_options.show_control_codes,
            self.output_options.show_transparent_borders,
            self.output_options.clip_enabled,
            self.output_options.debug_overlay,
            self.output_options.show_transparent_borders,
            self.output_options.debug_overlay,
        );
        let mut text_source_state = TextSourceExportState::default();
        self.root.write_json_v2_compat(
            &mut buf,
            &self.resources,
            &self.variant_ops,
            &mut text_source_state,
        );
        buf.push_str(",\"textSources\":");
        write_text_source_entries(&mut buf, &self.text_sources);
        buf.push_str(",\"fontResources\":");
        write_font_resources(&mut buf, self.resources.font_resources());
        write_text_v2_compat_export_metadata(&mut buf, &self.root, &self.variant_ops);
        buf.push('}');
        Ok(buf)
    }

    pub fn to_json_v2_strict_glyph_outline(&self) -> Result<String, Vec<TextV2ValidationIssue>> {
        let compat_slots = self.text_v2_slots();
        let strict_slots = crate::paint::strict_glyph_outline_text_v2_slots(&compat_slots)?;
        let strict_slots_by_group: HashMap<&str, &LayerTextPaintOpV2> = strict_slots
            .iter()
            .map(|slot| (slot.id.as_str(), slot))
            .collect();
        let mut issues = Vec::new();
        let mut stack = vec![&self.root];
        while let Some(node) = stack.pop() {
            match &node.kind {
                LayerNodeKind::Group { children, .. } => stack.extend(children),
                LayerNodeKind::ClipRect { child, .. } => stack.push(child),
                LayerNodeKind::Leaf { ops, .. } => {
                    for op in ops {
                        if matches!(op, PaintOp::TextRun { .. })
                            && text_v2_variant_group_id(op).is_none()
                        {
                            issues.push(TextV2ValidationIssue {
                                code: TextV2ValidationIssueCode::StrictVisualVariantMissing,
                                op_id: "textRun".to_string(),
                                paint_order_slot_id: None,
                                variant_id: None,
                                part_index: None,
                            });
                        }
                    }
                }
            }
        }
        if !issues.is_empty() {
            return Err(issues);
        }

        let mut buf = String::with_capacity(32_768);
        buf.push('{');
        let _ = write!(
            buf,
            "\"schemaVersion\":2,\"schemaMinorVersion\":0,\"schema\":{{\"major\":2,\"minor\":0}},\"resourceTableVersion\":{},\"resourceTableMinorVersion\":{},\"resourceTable\":{{\"major\":{},\"minor\":{}}},\"unit\":{},\"coordinateSystem\":{},\"pageWidth\":{:.6},\"pageHeight\":{:.6},\"profile\":{},\"layout\":{{\"profile\":\"hwpCompat\",\"measurementAuthority\":\"legacyHwpPositions\",\"shapedMeasurement\":\"diagnosticsOnly\"}},\"outputOptions\":{{\"showParagraphMarks\":{},\"showControlCodes\":{},\"showTransparentBorders\":{},\"clipEnabled\":{},\"debugOverlay\":{}}},\"buildOptions\":{{\"showTransparentBorders\":{}}},\"debugOptions\":{{\"debugOverlay\":{}}},\"debugCapabilities\":{{\"overlayPaint\":false,\"semanticBounds\":true,\"genericLayerExport\":{{\"overlayPaint\":false,\"semanticBounds\":true}},\"backends\":{{\"svgLayer\":{{\"overlayPaint\":true,\"semanticBounds\":true}},\"canvas2d\":{{\"overlayPaint\":false,\"semanticBounds\":true}},\"canvaskit\":{{\"overlayPaint\":false,\"semanticBounds\":true}},\"nativeSkia\":{{\"overlayPaint\":false,\"semanticBounds\":true}}}}}},\"root\":",
            LAYER_TREE_SCHEMA.resource_table_version,
            LAYER_TREE_SCHEMA.resource_table_minor_version,
            LAYER_TREE_SCHEMA.resource_table_version,
            LAYER_TREE_SCHEMA.resource_table_minor_version,
            json_escape(LAYER_TREE_SCHEMA.unit),
            json_escape(LAYER_TREE_SCHEMA.coordinate_system),
            self.page_width,
            self.page_height,
            json_escape(self.profile.as_str()),
            self.output_options.show_paragraph_marks,
            self.output_options.show_control_codes,
            self.output_options.show_transparent_borders,
            self.output_options.clip_enabled,
            self.output_options.debug_overlay,
            self.output_options.show_transparent_borders,
            self.output_options.debug_overlay,
        );
        let mut text_source_state = TextSourceExportState::default();
        self.root.write_json_v2_strict_text_variant(
            &mut buf,
            &self.resources,
            &strict_slots_by_group,
            &mut text_source_state,
        );
        buf.push_str(",\"textSources\":");
        write_text_source_entries(&mut buf, &self.text_sources);
        buf.push_str(",\"fontResources\":");
        write_font_resources(&mut buf, self.resources.font_resources());
        write_text_v2_strict_glyph_outline_export_metadata(&mut buf, &self.root);
        buf.push('}');
        Ok(buf)
    }

    pub fn to_json_v2_strict_glyph_run(&self) -> Result<String, Vec<TextV2ValidationIssue>> {
        let compat_slots = self.text_v2_slots();
        let strict_slots = crate::paint::strict_glyph_run_text_v2_slots(&compat_slots)?;
        let strict_slots_by_group: HashMap<&str, &LayerTextPaintOpV2> = strict_slots
            .iter()
            .map(|slot| (slot.id.as_str(), slot))
            .collect();
        let mut issues = Vec::new();
        let mut stack = vec![&self.root];
        while let Some(node) = stack.pop() {
            match &node.kind {
                LayerNodeKind::Group { children, .. } => stack.extend(children),
                LayerNodeKind::ClipRect { child, .. } => stack.push(child),
                LayerNodeKind::Leaf { ops, .. } => {
                    for op in ops {
                        if matches!(op, PaintOp::TextRun { .. })
                            && text_v2_variant_group_id(op).is_none()
                        {
                            issues.push(TextV2ValidationIssue {
                                code: TextV2ValidationIssueCode::StrictVisualVariantMissing,
                                op_id: "textRun".to_string(),
                                paint_order_slot_id: None,
                                variant_id: None,
                                part_index: None,
                            });
                        }
                    }
                }
            }
        }
        if !issues.is_empty() {
            return Err(issues);
        }

        let mut buf = String::with_capacity(32_768);
        buf.push('{');
        let _ = write!(
            buf,
            "\"schemaVersion\":2,\"schemaMinorVersion\":0,\"schema\":{{\"major\":2,\"minor\":0}},\"resourceTableVersion\":{},\"resourceTableMinorVersion\":{},\"resourceTable\":{{\"major\":{},\"minor\":{}}},\"unit\":{},\"coordinateSystem\":{},\"pageWidth\":{:.6},\"pageHeight\":{:.6},\"profile\":{},\"layout\":{{\"profile\":\"hwpCompat\",\"measurementAuthority\":\"legacyHwpPositions\",\"shapedMeasurement\":\"diagnosticsOnly\"}},\"outputOptions\":{{\"showParagraphMarks\":{},\"showControlCodes\":{},\"showTransparentBorders\":{},\"clipEnabled\":{},\"debugOverlay\":{}}},\"buildOptions\":{{\"showTransparentBorders\":{}}},\"debugOptions\":{{\"debugOverlay\":{}}},\"debugCapabilities\":{{\"overlayPaint\":false,\"semanticBounds\":true,\"genericLayerExport\":{{\"overlayPaint\":false,\"semanticBounds\":true}},\"backends\":{{\"svgLayer\":{{\"overlayPaint\":true,\"semanticBounds\":true}},\"canvas2d\":{{\"overlayPaint\":false,\"semanticBounds\":true}},\"canvaskit\":{{\"overlayPaint\":false,\"semanticBounds\":true}},\"nativeSkia\":{{\"overlayPaint\":false,\"semanticBounds\":true}}}}}},\"root\":",
            LAYER_TREE_SCHEMA.resource_table_version,
            LAYER_TREE_SCHEMA.resource_table_minor_version,
            LAYER_TREE_SCHEMA.resource_table_version,
            LAYER_TREE_SCHEMA.resource_table_minor_version,
            json_escape(LAYER_TREE_SCHEMA.unit),
            json_escape(LAYER_TREE_SCHEMA.coordinate_system),
            self.page_width,
            self.page_height,
            json_escape(self.profile.as_str()),
            self.output_options.show_paragraph_marks,
            self.output_options.show_control_codes,
            self.output_options.show_transparent_borders,
            self.output_options.clip_enabled,
            self.output_options.debug_overlay,
            self.output_options.show_transparent_borders,
            self.output_options.debug_overlay,
        );
        let mut text_source_state = TextSourceExportState::default();
        self.root.write_json_v2_strict_text_variant(
            &mut buf,
            &self.resources,
            &strict_slots_by_group,
            &mut text_source_state,
        );
        buf.push_str(",\"textSources\":");
        write_text_source_entries(&mut buf, &self.text_sources);
        buf.push_str(",\"fontResources\":");
        write_font_resources(&mut buf, self.resources.font_resources());
        write_text_v2_strict_glyph_run_export_metadata(&mut buf, &self.root);
        buf.push('}');
        Ok(buf)
    }
}

fn write_text_export_metadata(buf: &mut String, root: &LayerNode, variant_ops: &[PaintOp]) {
    let externalized_visuals = externalized_text_visuals(root);
    let has_variant_groups = has_text_variant_groups(root) || has_text_variant_ops(variant_ops);
    let has_sidecar_variants = !variant_ops.is_empty();
    let has_glyph_runs = has_glyph_runs(root) || ops_have_glyph_runs(variant_ops);
    let has_glyph_outlines = has_glyph_outlines(root) || ops_have_glyph_outlines(variant_ops);
    let has_display_text = has_display_text(root) || ops_have_display_text(variant_ops);
    buf.push_str(",\"usedFeatures\":[\"text.paintStyle\",\"text.sourceTable\",\"text.sourceSpan\",\"text.v2.placement\",\"text.v2.clusters\",\"text.projectionKind\",\"text.legacyVisuals\"");
    if has_display_text {
        buf.push_str(",\"text.displayText\"");
    }
    if has_glyph_runs {
        buf.push_str(",\"fontResources\",\"text.glyphRun\"");
    }
    if has_glyph_outlines {
        buf.push_str(",\"text.outlineGlyph\"");
    }
    if has_variant_groups {
        buf.push_str(",\"text.variantGroups\"");
    }
    if has_sidecar_variants {
        buf.push_str(",\"text.variantOps\"");
    }
    if externalized_visuals.contains(&"charOverlap") {
        buf.push_str(",\"text.charOverlapOp\"");
    }
    if externalized_visuals.contains(&"controlMarks") {
        buf.push_str(",\"text.controlMarkOp\"");
    }
    if externalized_visuals.contains(&"tabLeaders") {
        buf.push_str(",\"text.tabLeaderOp\"");
    }
    if externalized_visuals.contains(&"decorations") {
        buf.push_str(",\"text.decorationOp\"");
    }
    buf.push_str("],\"optionalFeatures\":[");
    if has_glyph_runs {
        buf.push_str("\"fontResources\",\"text.glyphRun\"");
        if has_glyph_outlines {
            buf.push(',');
        }
    }
    if has_glyph_outlines {
        buf.push_str("\"text.outlineGlyph\"");
    }
    buf.push_str("],\"knownFeatures\":[\"fontResources\",\"fontResources.blobFaceSplit\",\"text.variants\",\"text.paintOrderSlot\",\"text.strictVisualFallbackFree\",\"text.crossScopeVariants\",\"text.variantGroups\",\"text.variantOps\",\"text.shapeDiagnostics\",\"text.glyphRun\",\"text.outlineGlyph\",\"text.glyphOutline.monochromeFill\",\"text.glyphOutline.monochromeFillStroke\",\"text.glyphOutline.colorLayers\",\"text.glyphOutline.colorLayers.colrV0\",\"text.glyphOutline.colorLayers.colrV1\",\"text.glyphOutline.bitmapGlyph\",\"text.glyphOutline.svgGlyph\",\"text.specialVisualOps\",\"text.charOverlapOp\",\"text.controlMarkOp\",\"text.tabLeaderOp\",\"text.decorationOp\",\"text.displayText\",\"text.layout.shapedModern\",\"text.vertical.mixedPerGlyph\"],\"requiredFeatures\":[],\"text\":{\"defaultVariant\":\"textRun\",\"variants\":[\"textRun\"");
    if has_glyph_runs {
        buf.push_str(",\"glyphRun\"");
    }
    if has_glyph_outlines {
        buf.push_str(",\"glyphOutline\"");
    }
    buf.push_str("],\"variantSelection\":\"exclusiveVariantSet\",\"sourceTextPreserved\":true,\"clusterEncoding\":[\"utf8\",\"utf16\"],\"fallbackRequired\":true,\"placementAuthority\":\"compatibilityProjection\",\"externalizedVisuals\":[");
    for (idx, visual) in externalized_visuals.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        let _ = write!(buf, "{}", json_escape(visual));
    }
    buf.push_str("]},\"textV2\":{\"profile\":\"compatibility\",\"canonicalOp\":\"text\",\"fallbackPolicy\":\"required\",\"strictVisualFallbackFree\":false,\"paintOrderSlots\":\"reserved\"}");
}

fn write_text_v2_compat_export_metadata(
    buf: &mut String,
    root: &LayerNode,
    variant_ops: &[PaintOp],
) {
    let externalized_visuals = externalized_text_visuals(root);
    let has_variant_groups = has_text_variant_groups(root) || has_text_variant_ops(variant_ops);
    let has_glyph_runs = has_glyph_runs(root) || ops_have_glyph_runs(variant_ops);
    let has_glyph_outlines = has_glyph_outlines(root) || ops_have_glyph_outlines(variant_ops);
    let has_display_text = has_display_text(root) || ops_have_display_text(variant_ops);
    buf.push_str(",\"usedFeatures\":[\"text.paintStyle\",\"text.sourceTable\",\"text.sourceSpan\",\"text.variants\",\"text.paintOrderSlot\",\"text.v2.placement\",\"text.v2.clusters\",\"text.projectionKind\",\"text.legacyVisuals\"");
    if has_display_text {
        buf.push_str(",\"text.displayText\"");
    }
    if has_glyph_runs {
        buf.push_str(",\"fontResources\",\"text.glyphRun\"");
    }
    if has_glyph_outlines {
        buf.push_str(",\"text.outlineGlyph\"");
    }
    if has_variant_groups {
        buf.push_str(",\"text.variantGroups\"");
    }
    if externalized_visuals.contains(&"charOverlap") {
        buf.push_str(",\"text.charOverlapOp\"");
    }
    if externalized_visuals.contains(&"controlMarks") {
        buf.push_str(",\"text.controlMarkOp\"");
    }
    if externalized_visuals.contains(&"tabLeaders") {
        buf.push_str(",\"text.tabLeaderOp\"");
    }
    if externalized_visuals.contains(&"decorations") {
        buf.push_str(",\"text.decorationOp\"");
    }
    buf.push_str("],\"optionalFeatures\":[");
    if has_glyph_runs {
        buf.push_str("\"fontResources\",\"text.glyphRun\"");
        if has_glyph_outlines {
            buf.push(',');
        }
    }
    if has_glyph_outlines {
        buf.push_str("\"text.outlineGlyph\"");
    }
    buf.push_str("],\"knownFeatures\":[\"fontResources\",\"fontResources.blobFaceSplit\",\"text.variants\",\"text.paintOrderSlot\",\"text.strictVisualFallbackFree\",\"text.crossScopeVariants\",\"text.variantGroups\",\"text.variantOps\",\"text.shapeDiagnostics\",\"text.glyphRun\",\"text.outlineGlyph\",\"text.glyphOutline.monochromeFill\",\"text.glyphOutline.monochromeFillStroke\",\"text.glyphOutline.colorLayers\",\"text.glyphOutline.colorLayers.colrV0\",\"text.glyphOutline.colorLayers.colrV1\",\"text.glyphOutline.bitmapGlyph\",\"text.glyphOutline.svgGlyph\",\"text.specialVisualOps\",\"text.charOverlapOp\",\"text.controlMarkOp\",\"text.tabLeaderOp\",\"text.decorationOp\",\"text.displayText\",\"text.layout.shapedModern\",\"text.vertical.mixedPerGlyph\"],\"requiredFeatures\":[\"text.variants\",\"text.paintOrderSlot\"],\"text\":{\"defaultVariant\":\"textRun\",\"variants\":[\"textRun\"");
    if has_glyph_runs {
        buf.push_str(",\"glyphRun\"");
    }
    if has_glyph_outlines {
        buf.push_str(",\"glyphOutline\"");
    }
    buf.push_str("],\"variantSelection\":\"exclusiveVariantSet\",\"sourceTextPreserved\":true,\"clusterEncoding\":[\"utf8\",\"utf16\"],\"fallbackRequired\":true,\"placementAuthority\":\"compatibilityProjection\",\"externalizedVisuals\":[");
    for (idx, visual) in externalized_visuals.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        let _ = write!(buf, "{}", json_escape(visual));
    }
    buf.push_str("]},\"textV2\":{\"profile\":\"compatibility\",\"canonicalOp\":\"text\",\"fallbackPolicy\":\"required\",\"strictVisualFallbackFree\":false,\"paintOrderSlots\":\"required\"}");
}

fn write_text_v2_strict_glyph_outline_export_metadata(buf: &mut String, root: &LayerNode) {
    let externalized_visuals = externalized_text_visuals(root);
    let has_outline_stroke = has_supported_strict_glyph_outline_stroke(root);
    let has_colrv0_color_layers = has_supported_strict_glyph_outline_colrv0(root);
    let has_colrv1_color_layers = has_supported_strict_glyph_outline_colrv1(root);
    let has_bitmap_glyph = has_supported_strict_glyph_outline_bitmap(root);
    let has_svg_glyph = has_supported_strict_glyph_outline_svg(root);
    buf.push_str(",\"usedFeatures\":[\"text.paintStyle\",\"text.sourceTable\",\"text.sourceSpan\",\"text.variants\",\"text.paintOrderSlot\",\"text.strictVisualFallbackFree\",\"text.v2.placement\",\"text.v2.clusters\",\"text.projectionKind\",\"text.legacyVisuals\",\"text.outlineGlyph\",\"text.glyphOutline.monochromeFill\"");
    if has_outline_stroke {
        buf.push_str(",\"text.glyphOutline.monochromeFillStroke\"");
    }
    if has_colrv0_color_layers || has_colrv1_color_layers {
        buf.push_str(",\"text.glyphOutline.colorLayers\"");
    }
    if has_colrv0_color_layers {
        buf.push_str(",\"text.glyphOutline.colorLayers.colrV0\"");
    }
    if has_colrv1_color_layers {
        buf.push_str(",\"text.glyphOutline.colorLayers.colrV1\"");
    }
    if has_bitmap_glyph {
        buf.push_str(",\"text.glyphOutline.bitmapGlyph\"");
    }
    if has_svg_glyph {
        buf.push_str(",\"text.glyphOutline.svgGlyph\"");
    }
    if externalized_visuals.contains(&"charOverlap") {
        buf.push_str(",\"text.charOverlapOp\"");
    }
    if externalized_visuals.contains(&"controlMarks") {
        buf.push_str(",\"text.controlMarkOp\"");
    }
    if externalized_visuals.contains(&"tabLeaders") {
        buf.push_str(",\"text.tabLeaderOp\"");
    }
    if externalized_visuals.contains(&"decorations") {
        buf.push_str(",\"text.decorationOp\"");
    }
    buf.push_str("],\"optionalFeatures\":[],\"knownFeatures\":[\"fontResources\",\"fontResources.blobFaceSplit\",\"text.variants\",\"text.paintOrderSlot\",\"text.strictVisualFallbackFree\",\"text.crossScopeVariants\",\"text.variantGroups\",\"text.variantOps\",\"text.shapeDiagnostics\",\"text.glyphRun\",\"text.outlineGlyph\",\"text.glyphOutline.monochromeFill\",\"text.glyphOutline.monochromeFillStroke\",\"text.glyphOutline.colorLayers\",\"text.glyphOutline.colorLayers.colrV0\",\"text.glyphOutline.colorLayers.colrV1\",\"text.glyphOutline.bitmapGlyph\",\"text.glyphOutline.svgGlyph\",\"text.specialVisualOps\",\"text.charOverlapOp\",\"text.controlMarkOp\",\"text.tabLeaderOp\",\"text.decorationOp\",\"text.displayText\",\"text.layout.shapedModern\",\"text.vertical.mixedPerGlyph\"],\"requiredFeatures\":[\"text.variants\",\"text.paintOrderSlot\",\"text.strictVisualFallbackFree\",\"text.outlineGlyph\",\"text.glyphOutline.monochromeFill\"");
    if has_outline_stroke {
        buf.push_str(",\"text.glyphOutline.monochromeFillStroke\"");
    }
    if has_colrv0_color_layers || has_colrv1_color_layers {
        buf.push_str(",\"text.glyphOutline.colorLayers\"");
    }
    if has_colrv0_color_layers {
        buf.push_str(",\"text.glyphOutline.colorLayers.colrV0\"");
    }
    if has_colrv1_color_layers {
        buf.push_str(",\"text.glyphOutline.colorLayers.colrV1\"");
    }
    if has_bitmap_glyph {
        buf.push_str(",\"text.glyphOutline.bitmapGlyph\"");
    }
    if has_svg_glyph {
        buf.push_str(",\"text.glyphOutline.svgGlyph\"");
    }
    buf.push_str("],\"text\":{\"defaultVariant\":\"glyphOutline\",\"variants\":[\"glyphOutline\"],\"variantSelection\":\"exclusiveVariantSet\",\"sourceTextPreserved\":true,\"clusterEncoding\":[\"utf8\",\"utf16\"],\"fallbackRequired\":false,\"placementAuthority\":\"strictVisual\",\"externalizedVisuals\":[");
    for (idx, visual) in externalized_visuals.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        let _ = write!(buf, "{}", json_escape(visual));
    }
    buf.push_str("]},\"textV2\":{\"profile\":\"strictVisual\",\"canonicalOp\":\"text\",\"fallbackPolicy\":\"none\",\"strictVisualFallbackFree\":true,\"paintOrderSlots\":\"required\"}");
}

fn write_text_v2_strict_glyph_run_export_metadata(buf: &mut String, root: &LayerNode) {
    let externalized_visuals = externalized_text_visuals(root);
    buf.push_str(",\"usedFeatures\":[\"text.paintStyle\",\"text.sourceTable\",\"text.sourceSpan\",\"text.variants\",\"text.paintOrderSlot\",\"text.strictVisualFallbackFree\",\"text.v2.placement\",\"text.v2.clusters\",\"text.projectionKind\",\"text.legacyVisuals\",\"fontResources\",\"text.glyphRun\"");
    if externalized_visuals.contains(&"charOverlap") {
        buf.push_str(",\"text.charOverlapOp\"");
    }
    if externalized_visuals.contains(&"controlMarks") {
        buf.push_str(",\"text.controlMarkOp\"");
    }
    if externalized_visuals.contains(&"tabLeaders") {
        buf.push_str(",\"text.tabLeaderOp\"");
    }
    if externalized_visuals.contains(&"decorations") {
        buf.push_str(",\"text.decorationOp\"");
    }
    buf.push_str("],\"optionalFeatures\":[],\"knownFeatures\":[\"fontResources\",\"fontResources.blobFaceSplit\",\"text.variants\",\"text.paintOrderSlot\",\"text.strictVisualFallbackFree\",\"text.crossScopeVariants\",\"text.variantGroups\",\"text.variantOps\",\"text.shapeDiagnostics\",\"text.glyphRun\",\"text.outlineGlyph\",\"text.glyphOutline.monochromeFill\",\"text.glyphOutline.monochromeFillStroke\",\"text.glyphOutline.colorLayers\",\"text.glyphOutline.colorLayers.colrV0\",\"text.glyphOutline.colorLayers.colrV1\",\"text.glyphOutline.bitmapGlyph\",\"text.glyphOutline.svgGlyph\",\"text.specialVisualOps\",\"text.charOverlapOp\",\"text.controlMarkOp\",\"text.tabLeaderOp\",\"text.decorationOp\",\"text.displayText\",\"text.layout.shapedModern\",\"text.vertical.mixedPerGlyph\"],\"requiredFeatures\":[\"text.variants\",\"text.paintOrderSlot\",\"text.strictVisualFallbackFree\",\"fontResources\",\"text.glyphRun\"],\"text\":{\"defaultVariant\":\"glyphRun\",\"variants\":[\"glyphRun\"],\"variantSelection\":\"exclusiveVariantSet\",\"sourceTextPreserved\":true,\"clusterEncoding\":[\"utf8\",\"utf16\"],\"fallbackRequired\":false,\"placementAuthority\":\"strictVisual\",\"externalizedVisuals\":[");
    for (idx, visual) in externalized_visuals.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        let _ = write!(buf, "{}", json_escape(visual));
    }
    buf.push_str("]},\"textV2\":{\"profile\":\"strictVisual\",\"canonicalOp\":\"text\",\"fallbackPolicy\":\"none\",\"strictVisualFallbackFree\":true,\"paintOrderSlots\":\"required\"}");
}

fn has_text_variant_groups(root: &LayerNode) -> bool {
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        match &node.kind {
            LayerNodeKind::Group { children, .. } => {
                for child in children {
                    stack.push(child);
                }
            }
            LayerNodeKind::ClipRect { child, .. } => stack.push(child),
            LayerNodeKind::Leaf { ops, .. } => {
                if ops.iter().any(|op| {
                    matches!(
                        op,
                        PaintOp::TextRun {
                            run: LayerTextRunPaint {
                                variant: Some(_),
                                ..
                            },
                            ..
                        } | PaintOp::GlyphRun { .. }
                            | PaintOp::GlyphOutline { .. }
                            | PaintOp::CharOverlap {
                                overlap: crate::paint::LayerCharOverlapPaint {
                                    variant: Some(_),
                                    ..
                                },
                                ..
                            }
                    )
                }) {
                    return true;
                }
            }
        }
    }
    false
}

fn has_glyph_runs(root: &LayerNode) -> bool {
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        match &node.kind {
            LayerNodeKind::Group { children, .. } => {
                for child in children {
                    stack.push(child);
                }
            }
            LayerNodeKind::ClipRect { child, .. } => stack.push(child),
            LayerNodeKind::Leaf { ops, .. } => {
                if ops.iter().any(|op| matches!(op, PaintOp::GlyphRun { .. })) {
                    return true;
                }
            }
        }
    }
    false
}

fn has_display_text(root: &LayerNode) -> bool {
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        match &node.kind {
            LayerNodeKind::Group { children, .. } => {
                for child in children {
                    stack.push(child);
                }
            }
            LayerNodeKind::ClipRect { child, .. } => stack.push(child),
            LayerNodeKind::Leaf { ops, .. } => {
                if ops_have_display_text(ops) {
                    return true;
                }
            }
        }
    }
    false
}

fn has_text_variant_ops(ops: &[PaintOp]) -> bool {
    ops.iter().any(|op| text_v2_variant_group_id(op).is_some())
}

fn ops_have_display_text(ops: &[PaintOp]) -> bool {
    ops.iter().any(|op| match op {
        PaintOp::TextRun { run, .. } => display_text_for_text_run(run).is_some(),
        _ => false,
    })
}

fn ops_have_glyph_runs(ops: &[PaintOp]) -> bool {
    ops.iter().any(|op| matches!(op, PaintOp::GlyphRun { .. }))
}

fn ops_have_glyph_outlines(ops: &[PaintOp]) -> bool {
    ops.iter()
        .any(|op| matches!(op, PaintOp::GlyphOutline { .. }))
}

fn has_glyph_outlines(root: &LayerNode) -> bool {
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        match &node.kind {
            LayerNodeKind::Group { children, .. } => {
                for child in children {
                    stack.push(child);
                }
            }
            LayerNodeKind::ClipRect { child, .. } => stack.push(child),
            LayerNodeKind::Leaf { ops, .. } => {
                if ops
                    .iter()
                    .any(|op| matches!(op, PaintOp::GlyphOutline { .. }))
                {
                    return true;
                }
            }
        }
    }
    false
}

fn externalized_text_visuals(root: &LayerNode) -> Vec<&'static str> {
    let mut has_char_overlap = false;
    let mut has_control_marks = false;
    let mut has_tab_leaders = false;
    let mut has_decorations = false;
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        match &node.kind {
            LayerNodeKind::Group { children, .. } => {
                for child in children {
                    stack.push(child);
                }
            }
            LayerNodeKind::ClipRect { child, .. } => stack.push(child),
            LayerNodeKind::Leaf { ops, .. } => {
                has_char_overlap |= ops
                    .iter()
                    .any(|op| matches!(op, PaintOp::CharOverlap { .. }));
                has_control_marks |= ops
                    .iter()
                    .any(|op| matches!(op, PaintOp::TextControlMark { .. }));
                has_tab_leaders |= ops.iter().any(|op| matches!(op, PaintOp::TabLeader { .. }));
                has_decorations |= ops
                    .iter()
                    .any(|op| matches!(op, PaintOp::TextDecoration { .. }));
            }
        }
    }
    let mut visuals = Vec::new();
    if has_char_overlap {
        visuals.push("charOverlap");
    }
    if has_control_marks {
        visuals.push("controlMarks");
    }
    if has_tab_leaders {
        visuals.push("tabLeaders");
    }
    if has_decorations {
        visuals.push("decorations");
    }
    visuals
}

impl LayerNode {
    fn write_json(
        &self,
        buf: &mut String,
        resources: &ResourceArena,
        text_sources: &mut TextSourceExportState,
    ) {
        buf.push('{');
        buf.push_str("\"bounds\":");
        write_bbox(buf, self.bounds);
        if let Some(source_node_id) = self.source_node_id {
            let _ = write!(buf, ",\"sourceNodeId\":{}", source_node_id);
        }
        if self.semantic != LayerSemantic::default() {
            buf.push_str(",\"semantic\":{");
            let _ = write!(buf, "\"role\":{}", json_escape(self.semantic.role.as_str()));
            if let Some(section_index) = self.semantic.section_index {
                let _ = write!(buf, ",\"sectionIndex\":{}", section_index);
            }
            if let Some(column_index) = self.semantic.column_index {
                let _ = write!(buf, ",\"columnIndex\":{}", column_index);
            }
            if let Some(para_index) = self.semantic.para_index {
                let _ = write!(buf, ",\"paraIndex\":{}", para_index);
            }
            if let Some(control_index) = self.semantic.control_index {
                let _ = write!(buf, ",\"controlIndex\":{}", control_index);
            }
            if let Some(row_count) = self.semantic.row_count {
                let _ = write!(buf, ",\"rowCount\":{}", row_count);
            }
            if let Some(col_count) = self.semantic.col_count {
                let _ = write!(buf, ",\"colCount\":{}", col_count);
            }
            buf.push('}');
        }

        match &self.kind {
            LayerNodeKind::Group {
                children,
                cache_hint,
            } => {
                let _ = write!(
                    buf,
                    ",\"kind\":\"group\",\"cacheHint\":{},\"children\":[",
                    json_escape(cache_hint_str(*cache_hint))
                );
                for (idx, child) in children.iter().enumerate() {
                    if idx > 0 {
                        buf.push(',');
                    }
                    child.write_json(buf, resources, text_sources);
                }
                buf.push(']');
            }
            LayerNodeKind::ClipRect {
                clip,
                child,
                clip_kind,
                clip_policy,
            } => {
                buf.push_str(",\"kind\":\"clipRect\",\"clip\":");
                write_bbox(buf, *clip);
                let _ = write!(
                    buf,
                    ",\"clipKind\":{},\"clipPolicy\":{{\"rightOverflowSlop\":{},\"allowHorizontalOverflowControls\":{}}}",
                    json_escape(clip_kind_str(*clip_kind)),
                    clip_policy.right_overflow_slop,
                    clip_policy.allow_horizontal_overflow_controls
                );
                buf.push_str(",\"child\":");
                child.write_json(buf, resources, text_sources);
            }
            LayerNodeKind::Leaf { ops, cache_hint } => {
                let _ = write!(
                    buf,
                    ",\"kind\":\"leaf\",\"cacheHint\":{},\"ops\":[",
                    json_escape(cache_hint_str(*cache_hint))
                );
                for (idx, op) in ops.iter().enumerate() {
                    if idx > 0 {
                        buf.push(',');
                    }
                    op.write_json(buf, resources, text_sources);
                }
                buf.push(']');
            }
        }
        buf.push('}');
    }

    fn write_json_v2_compat(
        &self,
        buf: &mut String,
        resources: &ResourceArena,
        variant_ops: &[PaintOp],
        text_sources: &mut TextSourceExportState,
    ) {
        buf.push('{');
        buf.push_str("\"bounds\":");
        write_bbox(buf, self.bounds);
        if let Some(source_node_id) = self.source_node_id {
            let _ = write!(buf, ",\"sourceNodeId\":{}", source_node_id);
        }
        if self.semantic != LayerSemantic::default() {
            buf.push_str(",\"semantic\":{");
            let _ = write!(buf, "\"role\":{}", json_escape(self.semantic.role.as_str()));
            if let Some(section_index) = self.semantic.section_index {
                let _ = write!(buf, ",\"sectionIndex\":{}", section_index);
            }
            if let Some(column_index) = self.semantic.column_index {
                let _ = write!(buf, ",\"columnIndex\":{}", column_index);
            }
            if let Some(para_index) = self.semantic.para_index {
                let _ = write!(buf, ",\"paraIndex\":{}", para_index);
            }
            if let Some(control_index) = self.semantic.control_index {
                let _ = write!(buf, ",\"controlIndex\":{}", control_index);
            }
            if let Some(row_count) = self.semantic.row_count {
                let _ = write!(buf, ",\"rowCount\":{}", row_count);
            }
            if let Some(col_count) = self.semantic.col_count {
                let _ = write!(buf, ",\"colCount\":{}", col_count);
            }
            buf.push('}');
        }

        match &self.kind {
            LayerNodeKind::Group {
                children,
                cache_hint,
            } => {
                let _ = write!(
                    buf,
                    ",\"kind\":\"group\",\"cacheHint\":{},\"children\":[",
                    json_escape(cache_hint_str(*cache_hint))
                );
                for (idx, child) in children.iter().enumerate() {
                    if idx > 0 {
                        buf.push(',');
                    }
                    child.write_json_v2_compat(buf, resources, variant_ops, text_sources);
                }
                buf.push(']');
            }
            LayerNodeKind::ClipRect {
                clip,
                child,
                clip_kind,
                clip_policy,
            } => {
                buf.push_str(",\"kind\":\"clipRect\",\"clip\":");
                write_bbox(buf, *clip);
                let _ = write!(
                    buf,
                    ",\"clipKind\":{},\"clipPolicy\":{{\"rightOverflowSlop\":{},\"allowHorizontalOverflowControls\":{}}}",
                    json_escape(clip_kind_str(*clip_kind)),
                    clip_policy.right_overflow_slop,
                    clip_policy.allow_horizontal_overflow_controls
                );
                buf.push_str(",\"child\":");
                child.write_json_v2_compat(buf, resources, variant_ops, text_sources);
            }
            LayerNodeKind::Leaf { ops, cache_hint } => {
                let _ = write!(
                    buf,
                    ",\"kind\":\"leaf\",\"cacheHint\":{},\"ops\":[",
                    json_escape(cache_hint_str(*cache_hint))
                );
                let sidecars = crate::paint::sidecars_for_leaf_ops(ops, variant_ops);
                write_leaf_ops_v2_compat(buf, ops, &sidecars, resources, text_sources);
                buf.push(']');
            }
        }
        buf.push('}');
    }

    fn write_json_v2_strict_text_variant(
        &self,
        buf: &mut String,
        resources: &ResourceArena,
        strict_slots_by_group: &HashMap<&str, &LayerTextPaintOpV2>,
        text_sources: &mut TextSourceExportState,
    ) {
        buf.push('{');
        buf.push_str("\"bounds\":");
        write_bbox(buf, self.bounds);
        if let Some(source_node_id) = self.source_node_id {
            let _ = write!(buf, ",\"sourceNodeId\":{}", source_node_id);
        }
        if self.semantic != LayerSemantic::default() {
            buf.push_str(",\"semantic\":{");
            let _ = write!(buf, "\"role\":{}", json_escape(self.semantic.role.as_str()));
            if let Some(section_index) = self.semantic.section_index {
                let _ = write!(buf, ",\"sectionIndex\":{}", section_index);
            }
            if let Some(column_index) = self.semantic.column_index {
                let _ = write!(buf, ",\"columnIndex\":{}", column_index);
            }
            if let Some(para_index) = self.semantic.para_index {
                let _ = write!(buf, ",\"paraIndex\":{}", para_index);
            }
            if let Some(control_index) = self.semantic.control_index {
                let _ = write!(buf, ",\"controlIndex\":{}", control_index);
            }
            if let Some(row_count) = self.semantic.row_count {
                let _ = write!(buf, ",\"rowCount\":{}", row_count);
            }
            if let Some(col_count) = self.semantic.col_count {
                let _ = write!(buf, ",\"colCount\":{}", col_count);
            }
            buf.push('}');
        }

        match &self.kind {
            LayerNodeKind::Group {
                children,
                cache_hint,
            } => {
                let _ = write!(
                    buf,
                    ",\"kind\":\"group\",\"cacheHint\":{},\"children\":[",
                    json_escape(cache_hint_str(*cache_hint))
                );
                for (idx, child) in children.iter().enumerate() {
                    if idx > 0 {
                        buf.push(',');
                    }
                    child.write_json_v2_strict_text_variant(
                        buf,
                        resources,
                        strict_slots_by_group,
                        text_sources,
                    );
                }
                buf.push(']');
            }
            LayerNodeKind::ClipRect {
                clip,
                child,
                clip_kind,
                clip_policy,
            } => {
                buf.push_str(",\"kind\":\"clipRect\",\"clip\":");
                write_bbox(buf, *clip);
                let _ = write!(
                    buf,
                    ",\"clipKind\":{},\"clipPolicy\":{{\"rightOverflowSlop\":{},\"allowHorizontalOverflowControls\":{}}}",
                    json_escape(clip_kind_str(*clip_kind)),
                    clip_policy.right_overflow_slop,
                    clip_policy.allow_horizontal_overflow_controls
                );
                buf.push_str(",\"child\":");
                child.write_json_v2_strict_text_variant(
                    buf,
                    resources,
                    strict_slots_by_group,
                    text_sources,
                );
            }
            LayerNodeKind::Leaf { ops, cache_hint } => {
                let _ = write!(
                    buf,
                    ",\"kind\":\"leaf\",\"cacheHint\":{},\"ops\":[",
                    json_escape(cache_hint_str(*cache_hint))
                );
                write_leaf_ops_v2_strict_text_variant(
                    buf,
                    ops,
                    strict_slots_by_group,
                    resources,
                    text_sources,
                );
                buf.push(']');
            }
        }
        buf.push('}');
    }
}

fn write_leaf_ops_v2_compat(
    buf: &mut String,
    ops: &[PaintOp],
    sidecar_ops: &[PaintOp],
    resources: &ResourceArena,
    text_sources: &mut TextSourceExportState,
) {
    let text_slots =
        crate::paint::lower_v1_leaf_text_variants_with_sidecars_to_v2(ops, sidecar_ops);
    let text_slots_by_group: HashMap<&str, &LayerTextPaintOpV2> = text_slots
        .iter()
        .map(|slot| (slot.id.as_str(), slot))
        .collect();
    let mut written_groups = HashSet::<String>::new();
    let mut wrote_op = false;

    for op in ops {
        if let Some(group_id) = text_v2_variant_group_id(op) {
            if let Some(text_slot) = text_slots_by_group.get(group_id) {
                if written_groups.insert(group_id.to_string()) {
                    if wrote_op {
                        buf.push(',');
                    }
                    write_text_op_v2_compat(buf, text_slot, resources, text_sources);
                    wrote_op = true;
                }
                continue;
            }
        }

        if wrote_op {
            buf.push(',');
        }
        op.write_json(buf, resources, text_sources);
        wrote_op = true;
    }
}

fn write_leaf_ops_v2_strict_text_variant(
    buf: &mut String,
    ops: &[PaintOp],
    strict_slots_by_group: &HashMap<&str, &LayerTextPaintOpV2>,
    resources: &ResourceArena,
    text_sources: &mut TextSourceExportState,
) {
    let mut written_groups = HashSet::<String>::new();
    let mut wrote_op = false;

    for op in ops {
        if let Some(group_id) = text_v2_variant_group_id(op) {
            if let Some(text_slot) = strict_slots_by_group.get(group_id) {
                if written_groups.insert(group_id.to_string()) {
                    if wrote_op {
                        buf.push(',');
                    }
                    write_text_op_v2_compat(buf, text_slot, resources, text_sources);
                    wrote_op = true;
                }
            }
            continue;
        }

        if matches!(
            op,
            PaintOp::TextRun { .. } | PaintOp::GlyphRun { .. } | PaintOp::GlyphOutline { .. }
        ) {
            continue;
        }

        if wrote_op {
            buf.push(',');
        }
        op.write_json(buf, resources, text_sources);
        wrote_op = true;
    }
}

fn text_v2_variant_group_id(op: &PaintOp) -> Option<&str> {
    match op {
        PaintOp::TextRun { run, .. } => run
            .variant
            .as_ref()
            .map(|variant| variant.equivalence_group.as_str()),
        PaintOp::GlyphRun { run, .. } => Some(run.variant.equivalence_group.as_str()),
        PaintOp::GlyphOutline { outline, .. } => Some(outline.variant.equivalence_group.as_str()),
        _ => None,
    }
}

fn write_text_op_v2_compat(
    buf: &mut String,
    text_op: &LayerTextPaintOpV2,
    resources: &ResourceArena,
    text_sources: &mut TextSourceExportState,
) {
    buf.push('{');
    let _ = write!(
        buf,
        "\"id\":{},\"type\":\"text\",\"bbox\":",
        json_escape(&text_op.id)
    );
    write_bbox(buf, text_op.bbox);
    let _ = write!(
        buf,
        ",\"paintOrderSlotId\":{},\"selectionPolicy\":\"exclusiveVariantSet\",\"defaultVariantId\":{},\"fallbackPolicy\":{},\"variants\":[",
        json_escape(&text_op.paint_order_slot_id),
        json_escape(text_op.default_variant_id.as_deref().unwrap_or("textRun")),
        json_escape(text_op.fallback_policy.as_str()),
    );
    for (idx, variant) in text_op.variants.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        write_text_variant_set_v2_compat(buf, variant, resources, text_sources);
    }
    buf.push_str("]}");
}

fn write_text_variant_set_v2_compat(
    buf: &mut String,
    variant: &LayerTextVariantSet,
    resources: &ResourceArena,
    text_sources: &mut TextSourceExportState,
) {
    let _ = write!(
        buf,
        "{{\"variantId\":{},\"kind\":{}",
        json_escape(&variant.variant_id),
        json_escape(variant.kind.as_str()),
    );
    if !variant.required_features.is_empty() {
        buf.push_str(",\"requiredFeatures\":[");
        for (idx, feature) in variant.required_features.iter().enumerate() {
            if idx > 0 {
                buf.push(',');
            }
            let _ = write!(buf, "{}", json_escape(feature));
        }
        buf.push(']');
    }
    if let Some(quality) = variant.quality {
        let _ = write!(buf, ",\"quality\":{}", json_escape(quality.as_str()));
    }
    buf.push_str(",\"parts\":[");
    for (idx, part) in variant.parts.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        write_text_variant_part_v2_compat(buf, part, resources, text_sources);
    }
    buf.push_str("]}");
}

fn write_text_variant_part_v2_compat(
    buf: &mut String,
    part: &LayerTextVariantPart,
    resources: &ResourceArena,
    text_sources: &mut TextSourceExportState,
) {
    let _ = write!(
        buf,
        "{{\"partIndex\":{},\"partCount\":{}",
        part.part_index, part.part_count
    );
    if let Some(local_paint_order) = part.local_paint_order {
        let _ = write!(buf, ",\"localPaintOrder\":{}", local_paint_order);
    }
    if let Some(scope_ref) = &part.scope_ref {
        let _ = write!(buf, ",\"scopeRef\":{}", json_escape(scope_ref));
    }
    buf.push_str(",\"payload\":");
    write_text_variant_payload_v2_compat(buf, part, resources, text_sources);
    buf.push('}');
}

fn write_text_variant_payload_v2_compat(
    buf: &mut String,
    part: &LayerTextVariantPart,
    resources: &ResourceArena,
    text_sources: &mut TextSourceExportState,
) {
    match &part.payload {
        LayerTextVariantPayload::TextRun(run) => PaintOp::TextRun {
            bbox: part.bbox,
            run: run.clone(),
        }
        .write_json(buf, resources, text_sources),
        LayerTextVariantPayload::GlyphRun(run) => PaintOp::GlyphRun {
            bbox: part.bbox,
            run: run.clone(),
        }
        .write_json(buf, resources, text_sources),
        LayerTextVariantPayload::GlyphOutline(outline) => PaintOp::GlyphOutline {
            bbox: part.bbox,
            outline: outline.clone(),
        }
        .write_json(buf, resources, text_sources),
    }
}

impl PaintOp {
    fn write_json(
        &self,
        buf: &mut String,
        resources: &ResourceArena,
        text_sources: &mut TextSourceExportState,
    ) {
        match self {
            PaintOp::PageBackground { bbox, background } => {
                buf.push('{');
                buf.push_str("\"type\":\"pageBackground\",\"bbox\":");
                write_bbox(buf, *bbox);
                if let Some(color) = background.background_color {
                    let _ = write!(
                        buf,
                        ",\"backgroundColor\":{}",
                        json_escape(&color_ref_to_css(color))
                    );
                }
                if let Some(color) = background.border_color {
                    let _ = write!(
                        buf,
                        ",\"borderColor\":{}",
                        json_escape(&color_ref_to_css(color))
                    );
                }
                let _ = write!(buf, ",\"borderWidth\":{:.6}", background.border_width);
                if let Some(gradient) = &background.gradient {
                    buf.push_str(",\"gradient\":");
                    write_gradient(buf, gradient);
                }
                if let Some(image) = &background.image {
                    buf.push_str(",\"image\":{");
                    write_layer_image_fields(
                        buf,
                        resources,
                        Some(image.resource_id),
                        None,
                        Some(image.fill_mode),
                        None,
                        None,
                        None,
                        image.brightness,
                        image.contrast,
                        Some(image.effect),
                        false,
                    );
                    let _ = write!(buf, ",\"opacity\":{:.6}", image.opacity);
                    buf.push('}');
                }
                buf.push('}');
            }
            PaintOp::TextRun { bbox, run } => {
                buf.push('{');
                if let Some(variant) = &run.variant {
                    let _ = write!(buf, "\"id\":{},", json_escape(&variant.stable_op_id()));
                }
                buf.push_str("\"type\":\"textRun\",\"bbox\":");
                write_bbox(buf, *bbox);
                let _ = write!(
                    buf,
                    ",\"text\":{},\"baseline\":{:.6},\"rotation\":{:.6},\"isVertical\":{},\"orientation\":{},\"projectionKind\":{},\"clusterBasis\":{}",
                    json_escape(&run.text),
                    run.baseline,
                    run.rotation,
                    run.is_vertical,
                    json_escape(run.orientation.as_str()),
                    json_escape(run.projection.as_str()),
                    json_escape(run.cluster_basis.as_str()),
                );
                let display_text = display_text_for_text_run(run);
                if let Some(display_text) = &display_text {
                    let _ = write!(buf, ",\"displayText\":{}", json_escape(display_text));
                }
                if let Some(placement) = run.placement {
                    buf.push_str(",\"placement\":");
                    write_text_run_placement(buf, placement);
                }
                if !run.clusters.is_empty() {
                    buf.push_str(",\"clusters\":");
                    write_text_clusters(buf, &run.clusters);
                }
                buf.push_str(",\"source\":");
                if let Some(source) = &run.source {
                    write_text_source_span(buf, source);
                } else {
                    write_legacy_text_source_span(buf, run, text_sources.next_id());
                }
                if let Some(variant) = &run.variant {
                    buf.push_str(",\"variant\":");
                    write_paint_variant_meta(buf, variant);
                }
                buf.push_str(",\"style\":");
                write_text_style(buf, &run.style);
                buf.push_str(",\"paintStyle\":");
                write_paint_text_style(buf, &PaintTextStyle::from(&run.style));
                write_text_legacy_visuals(buf, run);
                buf.push_str(",\"positions\":");
                write_text_positions(buf, run);
                if let Some(display_text) = &display_text {
                    buf.push_str(",\"displayPositions\":");
                    if display_text.is_empty() {
                        buf.push_str("[]");
                    } else {
                        write_text_positions_for_text(buf, display_text, &run.style);
                    }
                }
                if !run.control_marks.is_empty() {
                    buf.push_str(",\"controlMarks\":");
                    write_text_control_marks(buf, run);
                }
                if let Some(overlap) = &run.char_overlap {
                    buf.push_str(",\"charOverlap\":");
                    write_char_overlap(buf, overlap);
                }
                let _ = write!(
                    buf,
                    ",\"fieldMarker\":{},\"isParaEnd\":{},\"isLineBreakEnd\":{}",
                    json_escape(field_marker_str(run.field_marker)),
                    run.is_para_end,
                    run.is_line_break_end,
                );
                if let FieldMarkerType::ShapeMarker(index) = run.field_marker {
                    let _ = write!(buf, ",\"shapeMarkerIndex\":{}", index);
                }
                if !run.style.tab_leaders.is_empty() {
                    buf.push_str(",\"tabLeaders\":");
                    write_tab_leaders(buf, &run.style.tab_leaders);
                }
                buf.push('}');
            }
            PaintOp::GlyphRun { bbox, run } => {
                buf.push('{');
                let _ = write!(buf, "\"id\":{},", json_escape(&run.variant.stable_op_id()));
                buf.push_str("\"type\":\"glyphRun\",\"bbox\":");
                write_bbox(buf, *bbox);
                buf.push_str(",\"source\":");
                write_text_source_span(buf, &run.source);
                buf.push_str(",\"variant\":");
                write_paint_variant_meta(buf, &run.variant);
                buf.push_str(",\"paintStyle\":");
                write_paint_text_style(buf, &run.paint_style);
                buf.push_str(",\"shapeKey\":");
                write_shape_key(buf, &run.shape_key);
                buf.push_str(",\"placement\":");
                write_text_run_placement(buf, run.placement);
                buf.push_str(",\"glyphIds\":[");
                for (idx, glyph_id) in run.glyph_ids.iter().enumerate() {
                    if idx > 0 {
                        buf.push(',');
                    }
                    let _ = write!(buf, "{}", glyph_id);
                }
                buf.push_str("],\"positions\":");
                write_points(buf, &run.positions);
                if let Some(advances) = &run.advances {
                    buf.push_str(",\"advances\":");
                    write_vectors(buf, advances);
                }
                buf.push_str(",\"clusters\":");
                write_glyph_clusters(buf, &run.clusters);
                let _ = write!(
                    buf,
                    ",\"direction\":{},\"writingMode\":{},\"orientation\":{}",
                    json_escape(run.direction.as_str()),
                    json_escape(run.writing_mode.as_str()),
                    json_escape(run.orientation.as_str()),
                );
                if let Some(bidi_level) = run.bidi_level {
                    let _ = write!(buf, ",\"bidiLevel\":{}", bidi_level);
                }
                if let Some(transforms) = &run.glyph_transforms {
                    buf.push_str(",\"glyphTransforms\":");
                    write_glyph_transforms(buf, transforms);
                }
                buf.push_str(",\"diagnostics\":");
                write_glyph_run_diagnostics(buf, &run.diagnostics);
                buf.push('}');
            }
            PaintOp::GlyphOutline { bbox, outline } => {
                buf.push('{');
                let _ = write!(
                    buf,
                    "\"id\":{},",
                    json_escape(&outline.variant.stable_op_id())
                );
                buf.push_str("\"type\":\"glyphOutline\",\"bbox\":");
                write_bbox(buf, *bbox);
                buf.push_str(",\"source\":");
                write_text_source_span(buf, &outline.source);
                buf.push_str(",\"variant\":");
                write_paint_variant_meta(buf, &outline.variant);
                let _ = write!(
                    buf,
                    ",\"payloadKind\":{}",
                    json_escape(outline.payload_kind.as_str())
                );
                if let Some(stroke) = &outline.stroke {
                    buf.push_str(",\"stroke\":");
                    write_glyph_outline_stroke_style(buf, stroke);
                }
                if let Some(color_layers) = &outline.color_layers {
                    buf.push_str(",\"colorLayers\":");
                    write_glyph_outline_color_layers_payload(buf, color_layers);
                }
                if let Some(bitmap_glyph) = &outline.bitmap_glyph {
                    buf.push_str(",\"bitmapGlyph\":");
                    write_glyph_outline_bitmap_glyph_payload(buf, bitmap_glyph);
                }
                if let Some(svg_glyph) = &outline.svg_glyph {
                    buf.push_str(",\"svgGlyph\":");
                    write_glyph_outline_svg_glyph_payload(buf, svg_glyph);
                }
                buf.push_str(",\"paintStyle\":");
                write_paint_text_style(buf, &outline.paint_style);
                buf.push_str(",\"placement\":");
                write_text_run_placement(buf, outline.placement);
                buf.push_str(",\"paths\":[");
                for (idx, path) in outline.paths.iter().enumerate() {
                    if idx > 0 {
                        buf.push(',');
                    }
                    let _ = write!(buf, "{{\"glyphId\":{}", path.glyph_id);
                    buf.push_str(",\"sourceRangeUtf8\":");
                    write_text_source_range(buf, path.source_range_utf8);
                    let _ = write!(
                        buf,
                        ",\"glyphRange\":{{\"start\":{},\"end\":{}}}",
                        path.glyph_range.start, path.glyph_range.end
                    );
                    buf.push_str(",\"commands\":");
                    write_path_commands(buf, &path.commands);
                    let _ = write!(
                        buf,
                        ",\"fillRule\":{}",
                        json_escape(path.fill_rule.as_str())
                    );
                    buf.push('}');
                }
                buf.push_str("],\"diagnostics\":");
                write_glyph_run_diagnostics(buf, &outline.diagnostics);
                buf.push('}');
            }
            PaintOp::CharOverlap { bbox, overlap } => {
                buf.push('{');
                buf.push_str("\"type\":\"charOverlap\",\"bbox\":");
                write_bbox(buf, *bbox);
                let _ = write!(
                    buf,
                    ",\"text\":{},\"baseline\":{:.6},\"rotation\":{:.6},\"isVertical\":{},\"orientation\":{}",
                    json_escape(&overlap.text),
                    overlap.baseline,
                    overlap.rotation,
                    overlap.is_vertical,
                    json_escape(overlap.orientation.as_str()),
                );
                if let Some(source) = &overlap.source {
                    buf.push_str(",\"source\":");
                    write_text_source_span(buf, source);
                }
                if let Some(variant) = &overlap.variant {
                    buf.push_str(",\"variant\":");
                    write_paint_variant_meta(buf, variant);
                }
                buf.push_str(",\"style\":");
                write_text_style(buf, &overlap.style);
                buf.push_str(",\"paintStyle\":");
                write_paint_text_style(buf, &PaintTextStyle::from(&overlap.style));
                buf.push_str(",\"positions\":");
                write_text_positions_slice(buf, &overlap.positions);
                buf.push_str(",\"charOverlap\":");
                write_char_overlap(buf, &overlap.overlap);
                buf.push('}');
            }
            PaintOp::TextControlMark { bbox, mark } => {
                buf.push('{');
                buf.push_str("\"type\":\"textControlMark\",\"bbox\":");
                write_bbox(buf, *bbox);
                if let Some(source) = &mark.source {
                    buf.push_str(",\"source\":");
                    write_text_source_span(buf, source);
                }
                buf.push_str(",\"mark\":");
                write_text_control_mark(buf, &mark.mark);
                buf.push('}');
            }
            PaintOp::TabLeader { bbox, leader } => {
                buf.push('{');
                buf.push_str("\"type\":\"tabLeader\",\"bbox\":");
                write_bbox(buf, *bbox);
                if let Some(source) = &leader.source {
                    buf.push_str(",\"source\":");
                    write_text_source_span(buf, source);
                }
                buf.push_str(",\"leader\":");
                write_tab_leader(buf, &leader.leader);
                let _ = write!(
                    buf,
                    ",\"color\":{},\"fontSize\":{:.6},\"baseline\":{:.6}}}",
                    json_escape(&color_ref_to_css(leader.color)),
                    leader.font_size,
                    leader.baseline,
                );
            }
            PaintOp::TextDecoration { bbox, decoration } => {
                buf.push('{');
                buf.push_str("\"type\":\"textDecoration\",\"bbox\":");
                write_bbox(buf, *bbox);
                if let Some(source) = &decoration.source {
                    buf.push_str(",\"source\":");
                    write_text_source_span(buf, source);
                }
                buf.push_str(",\"decoration\":");
                write_text_decoration(buf, decoration);
                buf.push('}');
            }
            PaintOp::FootnoteMarker { bbox, marker } => {
                buf.push('{');
                buf.push_str("\"type\":\"footnoteMarker\",\"bbox\":");
                write_bbox(buf, *bbox);
                let _ = write!(
                    buf,
                    ",\"text\":{},\"fontFamily\":{},\"fontSize\":{:.6},\"color\":{}",
                    json_escape(&marker.text),
                    json_escape(&marker.font_family),
                    (marker.base_font_size * 0.55).max(7.0),
                    json_escape(&color_ref_to_css(marker.color)),
                );
                buf.push('}');
            }
            PaintOp::Line { bbox, line } => {
                buf.push('{');
                buf.push_str("\"type\":\"line\",\"bbox\":");
                write_bbox(buf, *bbox);
                let _ = write!(
                    buf,
                    ",\"x1\":{:.6},\"y1\":{:.6},\"x2\":{:.6},\"y2\":{:.6},\"style\":",
                    line.x1, line.y1, line.x2, line.y2
                );
                write_line_style(buf, &line.style);
                buf.push_str(",\"transform\":");
                write_transform(buf, line.transform);
                buf.push('}');
            }
            PaintOp::Rectangle { bbox, rect } => {
                buf.push('{');
                buf.push_str("\"type\":\"rectangle\",\"bbox\":");
                write_bbox(buf, *bbox);
                let _ = write!(
                    buf,
                    ",\"cornerRadius\":{:.6},\"style\":",
                    rect.corner_radius
                );
                write_shape_style(buf, &rect.style);
                if let Some(gradient) = &rect.gradient {
                    buf.push_str(",\"gradient\":");
                    write_gradient(buf, gradient);
                }
                buf.push_str(",\"transform\":");
                write_transform(buf, rect.transform);
                buf.push('}');
            }
            PaintOp::Ellipse { bbox, ellipse } => {
                buf.push('{');
                buf.push_str("\"type\":\"ellipse\",\"bbox\":");
                write_bbox(buf, *bbox);
                buf.push_str(",\"style\":");
                write_shape_style(buf, &ellipse.style);
                if let Some(gradient) = &ellipse.gradient {
                    buf.push_str(",\"gradient\":");
                    write_gradient(buf, gradient);
                }
                buf.push_str(",\"transform\":");
                write_transform(buf, ellipse.transform);
                buf.push('}');
            }
            PaintOp::Path { bbox, path } => {
                buf.push('{');
                buf.push_str("\"type\":\"path\",\"bbox\":");
                write_bbox(buf, *bbox);
                buf.push_str(",\"commands\":");
                write_path_commands(buf, &path.commands);
                buf.push_str(",\"style\":");
                write_shape_style(buf, &path.style);
                if let Some(gradient) = &path.gradient {
                    buf.push_str(",\"gradient\":");
                    write_gradient(buf, gradient);
                }
                if let Some((x1, y1, x2, y2)) = path.connector_endpoints {
                    let _ = write!(
                        buf,
                        ",\"connectorEndpoints\":{{\"x1\":{:.6},\"y1\":{:.6},\"x2\":{:.6},\"y2\":{:.6}}}",
                        x1, y1, x2, y2
                    );
                }
                if let Some(line_style) = &path.line_style {
                    buf.push_str(",\"lineStyle\":");
                    write_line_style(buf, line_style);
                }
                buf.push_str(",\"transform\":");
                write_transform(buf, path.transform);
                buf.push('}');
            }
            PaintOp::Image { bbox, image } => {
                buf.push('{');
                buf.push_str("\"type\":\"image\",\"bbox\":");
                write_bbox(buf, *bbox);
                write_layer_image_fields(
                    buf,
                    resources,
                    image.resource_id,
                    image.external_path.as_deref(),
                    image.fill_mode,
                    image.original_size,
                    image.crop,
                    image.original_size_hu,
                    image.brightness,
                    image.contrast,
                    Some(image.effect),
                    true,
                );
                if let Some(text_wrap) = image.text_wrap {
                    let _ = write!(buf, ",\"wrap\":{}", json_escape(text_wrap_str(text_wrap)));
                }
                buf.push_str(",\"transform\":");
                write_transform(buf, image.transform);
                buf.push('}');
            }
            PaintOp::Equation { bbox, equation } => {
                buf.push('{');
                buf.push_str("\"type\":\"equation\",\"bbox\":");
                write_bbox(buf, *bbox);
                let _ = write!(
                    buf,
                    ",\"color\":{},\"fontSize\":{:.6},\"svgContent\":{},\"layoutBox\":",
                    json_escape(&equation.color_str),
                    equation.font_size,
                    json_escape(
                        resources
                            .svg_fragment(equation.svg_resource_id)
                            .unwrap_or("")
                    ),
                );
                write_equation_layout_box(buf, &equation.layout_box);
                buf.push('}');
            }
            PaintOp::FormObject { bbox, form } => {
                buf.push('{');
                buf.push_str("\"type\":\"formObject\",\"bbox\":");
                write_bbox(buf, *bbox);
                let _ = write!(
                    buf,
                    ",\"formType\":{},\"caption\":{},\"text\":{},\"foreColor\":{},\"backColor\":{},\"value\":{},\"enabled\":{}",
                    json_escape(form_type_str(form.form_type)),
                    json_escape(&form.caption),
                    json_escape(&form.text),
                    json_escape(&form.fore_color),
                    json_escape(&form.back_color),
                    form.value,
                    form.enabled,
                );
                buf.push('}');
            }
        }
    }
}

fn write_layer_image_fields(
    buf: &mut String,
    resources: &ResourceArena,
    resource_id: Option<crate::paint::ImageResourceId>,
    external_path: Option<&str>,
    fill_mode: Option<ImageFillMode>,
    original_size: Option<(f64, f64)>,
    crop: Option<(i32, i32, i32, i32)>,
    original_size_hu: Option<(u32, u32)>,
    brightness: i8,
    contrast: i8,
    effect: Option<ImageEffect>,
    leading_comma: bool,
) {
    let mut wrote_any = false;
    let mut push_prefix = |buf: &mut String| {
        if leading_comma || wrote_any {
            buf.push(',');
        }
        wrote_any = true;
    };

    if let Some(resource_id) = resource_id {
        if let Some(data) = resources.image_bytes(resource_id) {
            push_prefix(buf);
            let base64_data = base64::engine::general_purpose::STANDARD.encode(data);
            let _ = write!(buf, "\"base64\":{}", json_escape(&base64_data));
        }
    }
    if let Some(external_path) = external_path {
        push_prefix(buf);
        let _ = write!(buf, "\"externalPath\":{}", json_escape(external_path));
    }
    if let Some(fill_mode) = fill_mode {
        push_prefix(buf);
        let _ = write!(
            buf,
            "\"fillMode\":{}",
            json_escape(image_fill_mode_str(fill_mode))
        );
    }
    if let Some((width, height)) = original_size {
        push_prefix(buf);
        let _ = write!(
            buf,
            "\"originalSize\":{{\"width\":{:.6},\"height\":{:.6}}}",
            width, height
        );
    }
    if let Some((left, top, right, bottom)) = crop {
        push_prefix(buf);
        let _ = write!(
            buf,
            "\"crop\":{{\"left\":{},\"top\":{},\"right\":{},\"bottom\":{}}}",
            left, top, right, bottom
        );
    }
    if let Some((width, height)) = original_size_hu {
        push_prefix(buf);
        let _ = write!(buf, "\"originalSizeHu\":[{},{}]", width, height);
    }
    if let Some(effect) = effect {
        push_prefix(buf);
        let _ = write!(buf, "\"effect\":{}", json_escape(image_effect_str(effect)));
    }
    if brightness != 0 {
        push_prefix(buf);
        let _ = write!(buf, "\"brightness\":{}", brightness);
    }
    if contrast != 0 {
        push_prefix(buf);
        let _ = write!(buf, "\"contrast\":{}", contrast);
    }
}

fn write_bbox(buf: &mut String, bbox: BoundingBox) {
    let _ = write!(
        buf,
        "{{\"x\":{:.6},\"y\":{:.6},\"width\":{:.6},\"height\":{:.6}}}",
        bbox.x, bbox.y, bbox.width, bbox.height
    );
}

#[derive(Default)]
struct TextSourceExportState {
    next_id: u32,
}

impl TextSourceExportState {
    fn next_id(&mut self) -> u32 {
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        id
    }
}

fn write_text_source_entries(buf: &mut String, table: &TextSourceTable) {
    buf.push('[');
    for (idx, entry) in table.entries.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        write_text_source_entry(buf, entry);
    }
    buf.push(']');
}

fn write_font_resources(buf: &mut String, table: &crate::paint::FontResourceTable) {
    buf.push_str("{\"blobs\":[");
    for (idx, blob) in table.blobs.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        let _ = write!(
            buf,
            "{{\"id\":{},\"source\":{},\"portability\":{}",
            json_escape(&blob.id.0),
            json_escape(blob.source.as_str()),
            json_escape(blob.portability.kind().as_str())
        );
        if let Some(digest) = &blob.digest {
            let _ = write!(
                buf,
                ",\"digest\":{{\"algorithm\":{},\"value\":{}}}",
                json_escape(&digest.algorithm),
                json_escape(&digest.value)
            );
        }
        if let Some(data_ref) = &blob.data_ref {
            let _ = write!(
                buf,
                ",\"dataRef\":{{\"kind\":{},\"id\":{}}}",
                json_escape(data_ref.kind.as_str()),
                json_escape(&data_ref.id)
            );
        }
        buf.push('}');
    }
    buf.push_str("],\"faces\":[");
    for (idx, face) in table.faces.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        let _ = write!(
            buf,
            "{{\"id\":{},\"blobKey\":{},\"faceIndex\":{}",
            json_escape(&face.id.0),
            json_escape(&face.blob_key.0),
            face.face_index
        );
        if let Some(postscript_name) = &face.postscript_name {
            let _ = write!(buf, ",\"postscriptName\":{}", json_escape(postscript_name));
        }
        if !face.family_names.is_empty() {
            buf.push_str(",\"familyNames\":");
            write_localized_names(buf, &face.family_names);
        }
        if !face.style_names.is_empty() {
            buf.push_str(",\"styleNames\":");
            write_localized_names(buf, &face.style_names);
        }
        if let Some(weight_class) = face.weight_class {
            let _ = write!(buf, ",\"weightClass\":{}", weight_class);
        }
        if let Some(width_class) = face.width_class {
            let _ = write!(buf, ",\"widthClass\":{}", width_class);
        }
        if let Some(italic) = face.italic {
            let _ = write!(buf, ",\"italic\":{}", italic);
        }
        buf.push('}');
    }
    buf.push_str("]}");
}

fn write_localized_names(buf: &mut String, names: &[crate::paint::LocalizedName]) {
    buf.push('[');
    for (idx, name) in names.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        let _ = write!(buf, "{{\"value\":{}", json_escape(&name.value));
        if let Some(locale) = &name.locale {
            let _ = write!(buf, ",\"locale\":{}", json_escape(locale));
        }
        buf.push('}');
    }
    buf.push(']');
}

fn write_text_source_entry(buf: &mut String, entry: &TextSourceEntry) {
    let _ = write!(
        buf,
        "{{\"id\":{},\"text\":{},\"utf8Range\":",
        entry.id.0,
        json_escape(&entry.text)
    );
    write_text_source_range(buf, entry.utf8_range);
    buf.push_str(",\"utf16Range\":");
    write_text_source_range(buf, entry.utf16_range);
    if let Some(stable_source_key) = &entry.stable_source_key {
        let _ = write!(
            buf,
            ",\"stableSourceKey\":{{\"scheme\":{}}}",
            json_escape(stable_source_key)
        );
    }
    buf.push_str(",\"annotations\":");
    write_text_source_annotations(buf, &entry.annotations);
    buf.push('}');
}

fn write_legacy_text_source_span(buf: &mut String, run: &LayerTextRunPaint, id: u32) {
    let utf8_end = run.text.len() as u32;
    let utf16_end = run.text.encode_utf16().count() as u32;
    let _ = write!(buf, "{{\"id\":{},\"utf8Range\":", id);
    write_text_source_range(buf, TextSourceRange::new(0, utf8_end));
    buf.push_str(",\"utf16Range\":");
    write_text_source_range(buf, TextSourceRange::new(0, utf16_end));
    buf.push('}');
}

fn write_text_source_span(buf: &mut String, span: &TextSourceSpan) {
    let _ = write!(buf, "{{\"id\":{},\"utf8Range\":", span.id.0);
    write_text_source_range(buf, span.utf8_range);
    buf.push_str(",\"utf16Range\":");
    write_text_source_range(buf, span.utf16_range);
    if let Some(stable_source_key) = &span.stable_source_key {
        let _ = write!(
            buf,
            ",\"stableSourceKey\":{{\"scheme\":{}}}",
            json_escape(stable_source_key)
        );
    }
    buf.push('}');
}

fn write_paint_variant_meta(buf: &mut String, variant: &PaintVariantMeta) {
    let _ = write!(
        buf,
        "{{\"equivalenceGroup\":{},\"variantId\":{},\"variantKind\":{},\"partIndex\":{},\"partCount\":{},\"isDefaultFallback\":{}",
        json_escape(&variant.equivalence_group),
        json_escape(&variant.variant_id),
        json_escape(variant.variant_kind.as_str()),
        variant.part_index,
        variant.part_count,
        variant.is_default_fallback,
    );
    if !variant.requires.is_empty() {
        buf.push_str(",\"requires\":[");
        for (idx, feature) in variant.requires.iter().enumerate() {
            if idx > 0 {
                buf.push(',');
            }
            let _ = write!(buf, "{}", json_escape(feature));
        }
        buf.push(']');
    }
    if let Some(quality) = variant.quality {
        let _ = write!(buf, ",\"quality\":{}", json_escape(quality.as_str()));
    }
    if let Some(anchor_op_id) = &variant.anchor_op_id {
        let _ = write!(buf, ",\"anchorOpId\":{}", json_escape(anchor_op_id));
    }
    if let Some(local_paint_order) = variant.local_paint_order {
        let _ = write!(buf, ",\"localPaintOrder\":{}", local_paint_order);
    }
    buf.push('}');
}

fn write_text_source_range(buf: &mut String, range: TextSourceRange) {
    let _ = write!(buf, "{{\"start\":{},\"end\":{}}}", range.start, range.end);
}

fn write_text_source_annotations(buf: &mut String, annotations: &[TextSourceAnnotation]) {
    buf.push('[');
    for (idx, annotation) in annotations.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        match annotation {
            TextSourceAnnotation::FieldMarker {
                marker,
                range_utf8,
                range_utf16,
            } => {
                let _ = write!(
                    buf,
                    "{{\"kind\":\"fieldMarker\",\"marker\":{},\"rangeUtf8\":",
                    json_escape(field_marker_str(*marker))
                );
                write_text_source_range(buf, *range_utf8);
                buf.push_str(",\"rangeUtf16\":");
                write_text_source_range(buf, *range_utf16);
                if let FieldMarkerType::ShapeMarker(index) = marker {
                    let _ = write!(buf, ",\"shapeMarkerIndex\":{}", index);
                }
                buf.push('}');
            }
            TextSourceAnnotation::ParagraphEnd {
                offset_utf8,
                offset_utf16,
            } => {
                let _ = write!(
                    buf,
                    "{{\"kind\":\"paragraphEnd\",\"offsetUtf8\":{},\"offsetUtf16\":{}}}",
                    offset_utf8, offset_utf16
                );
            }
            TextSourceAnnotation::LineBreakEnd {
                offset_utf8,
                offset_utf16,
            } => {
                let _ = write!(
                    buf,
                    "{{\"kind\":\"lineBreakEnd\",\"offsetUtf8\":{},\"offsetUtf16\":{}}}",
                    offset_utf8, offset_utf16
                );
            }
        }
    }
    buf.push(']');
}

fn write_text_style(buf: &mut String, style: &TextStyle) {
    write_paint_text_style(buf, &PaintTextStyle::from(style));
}

fn write_paint_text_style(buf: &mut String, style: &PaintTextStyle) {
    buf.push('{');
    let _ = write!(
        buf,
        "\"fontFamily\":{},\"fontSize\":{:.6},\"color\":{},\"bold\":{},\"italic\":{},\"ratio\":{:.6},\"underline\":{},\"underlineShape\":{},\"strikethrough\":{},\"strikeShape\":{},\"outlineType\":{},\"shadowType\":{},\"shadowColor\":{},\"shadowOffsetX\":{:.6},\"shadowOffsetY\":{:.6},\"emboss\":{},\"engrave\":{},\"superscript\":{},\"subscript\":{},\"emphasisDot\":{},\"underlineColor\":{},\"strikeColor\":{},\"shadeColor\":{}",
        json_escape(&style.font_family),
        style.font_size,
        json_escape(&color_ref_to_css(style.color)),
        style.bold,
        style.italic,
        style.ratio,
        json_escape(underline_type_str(style.underline)),
        style.underline_shape,
        style.strikethrough,
        style.strike_shape,
        style.outline_type,
        style.shadow_type,
        json_escape(&color_ref_to_css(style.shadow_color)),
        style.shadow_offset_x,
        style.shadow_offset_y,
        style.emboss,
        style.engrave,
        style.superscript,
        style.subscript,
        style.emphasis_dot,
        json_escape(&color_ref_to_css(style.underline_color)),
        json_escape(&color_ref_to_css(style.strike_color)),
        json_escape(&color_ref_to_css(style.shade_color)),
    );
    if !style.tab_leaders.is_empty() {
        buf.push_str(",\"tabLeaders\":");
        write_tab_leaders(buf, &style.tab_leaders);
    }
    buf.push('}');
}

fn write_glyph_outline_stroke_style(buf: &mut String, stroke: &GlyphOutlineStrokeStyle) {
    buf.push('{');
    let _ = write!(
        buf,
        "\"color\":{},\"widthPx\":{:.6},\"join\":{},\"cap\":{},\"paintOrder\":{}",
        json_escape(&color_ref_to_css(stroke.color)),
        stroke.width_px,
        json_escape(stroke.join.as_str()),
        json_escape(stroke.cap.as_str()),
        json_escape(stroke.paint_order.as_str())
    );
    if let Some(miter_limit) = stroke.miter_limit {
        let _ = write!(buf, ",\"miterLimit\":{:.6}", miter_limit);
    }
    buf.push('}');
}

fn write_glyph_outline_color_layers_payload(
    buf: &mut String,
    payload: &crate::paint::ColorLayersPayload,
) {
    let _ = write!(
        buf,
        "{{\"colorFormat\":{}",
        json_escape(payload.color_format.as_str())
    );
    if let Some(source_font_ref) = &payload.source_font_ref {
        buf.push_str(",\"sourceFontRef\":");
        write_glyph_outline_font_color_glyph_ref(buf, source_font_ref);
    }
    if let Some(palette_ref) = &payload.palette_ref {
        buf.push_str(",\"paletteRef\":");
        write_glyph_outline_palette_ref(buf, palette_ref);
    }
    if let Some(range) = payload.source_range_utf8 {
        buf.push_str(",\"sourceRangeUtf8\":");
        write_text_source_range(buf, range);
    }
    if let Some(range) = payload.glyph_range {
        let _ = write!(
            buf,
            ",\"glyphRange\":{{\"start\":{},\"end\":{}}}",
            range.start, range.end
        );
    }
    buf.push_str(",\"layers\":[");
    for (idx, layer) in payload.layers.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        write_glyph_outline_color_layer_node(buf, layer);
    }
    buf.push(']');
    if let Some(graph) = &payload.paint_graph {
        buf.push_str(",\"paintGraph\":");
        write_glyph_outline_color_paint_graph(buf, graph);
    }
    let _ = write!(
        buf,
        ",\"colrv0ResolvedLayerContract\":{},\"colrv1Stage1GraphContract\":{},\"colrv1SupportedGraphContract\":{}",
        payload.has_colrv0_resolved_layer_contract(),
        payload.has_colrv1_supported_graph_contract(),
        payload.has_colrv1_supported_graph_contract(),
    );
    buf.push('}');
}

fn write_glyph_outline_color_paint_graph(
    buf: &mut String,
    graph: &crate::paint::ColorPaintGraphPayload,
) {
    let _ = write!(buf, "{{\"rootNodeId\":{},\"nodes\":[", graph.root_node_id);
    for (idx, node) in graph.nodes.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        write_glyph_outline_color_paint_graph_node(buf, node);
    }
    buf.push_str("]}");
}

fn write_glyph_outline_color_paint_graph_node(
    buf: &mut String,
    node: &crate::paint::ColorPaintGraphNode,
) {
    let _ = write!(
        buf,
        "{{\"nodeId\":{},\"kind\":{}",
        node.node_id,
        json_escape(node.kind.as_str())
    );
    if let Some(solid) = &node.solid_path {
        buf.push_str(",\"solidPath\":");
        write_glyph_outline_color_solid_path_node(buf, solid);
    }
    if let Some(gradient_path) = &node.linear_gradient_path {
        buf.push_str(",\"linearGradientPath\":");
        write_glyph_outline_color_linear_gradient_path_node(buf, gradient_path);
    }
    if let Some(gradient_path) = &node.radial_gradient_path {
        buf.push_str(",\"radialGradientPath\":");
        write_glyph_outline_color_radial_gradient_path_node(buf, gradient_path);
    }
    if let Some(gradient_path) = &node.sweep_gradient_path {
        buf.push_str(",\"sweepGradientPath\":");
        write_glyph_outline_color_sweep_gradient_path_node(buf, gradient_path);
    }
    if let Some(transform) = &node.transform {
        buf.push_str(",\"transform\":");
        write_glyph_outline_color_transform_node(buf, transform);
    }
    if let Some(composite) = &node.composite {
        buf.push_str(",\"composite\":");
        write_glyph_outline_color_composite_node(buf, composite);
    }
    if let Some(clip) = &node.clip {
        buf.push_str(",\"clip\":");
        write_glyph_outline_color_clip_node(buf, clip);
    }
    if let Some(range) = node.source_range_utf8 {
        buf.push_str(",\"sourceRangeUtf8\":");
        write_text_source_range(buf, range);
    }
    if let Some(range) = node.glyph_range {
        let _ = write!(
            buf,
            ",\"glyphRange\":{{\"start\":{},\"end\":{}}}",
            range.start, range.end
        );
    }
    if let Some(source_font_ref) = &node.source_font_ref {
        buf.push_str(",\"sourceFontRef\":");
        write_glyph_outline_font_color_glyph_ref(buf, source_font_ref);
    }
    buf.push('}');
}

fn write_glyph_outline_color_solid_path_node(
    buf: &mut String,
    solid: &crate::paint::ColorPaintSolidPathNode,
) {
    buf.push_str("{\"commands\":");
    write_path_commands(buf, &solid.commands);
    buf.push_str(",\"fill\":");
    write_resolved_color(buf, &solid.fill);
    let _ = write!(
        buf,
        ",\"fillRule\":{}",
        json_escape(solid.fill_rule.as_str())
    );
    if let Some(source_glyph_id) = solid.source_glyph_id {
        let _ = write!(buf, ",\"sourceGlyphId\":{}", source_glyph_id);
    }
    if let Some(palette_index) = solid.palette_index {
        let _ = write!(buf, ",\"paletteIndex\":{}", palette_index);
    }
    buf.push('}');
}

fn write_glyph_outline_color_gradient_stops(
    buf: &mut String,
    stops: &[crate::paint::ColorGradientStop],
) {
    buf.push('[');
    for (idx, stop) in stops.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        let _ = write!(buf, "{{\"offset\":{:.6}", stop.offset);
        buf.push_str(",\"color\":");
        write_resolved_color(buf, &stop.color);
        buf.push('}');
    }
    buf.push(']');
}

fn write_glyph_outline_color_linear_gradient_path_node(
    buf: &mut String,
    gradient_path: &crate::paint::ColorPaintLinearGradientPathNode,
) {
    buf.push_str("{\"commands\":");
    write_path_commands(buf, &gradient_path.commands);
    let _ = write!(
        buf,
        ",\"gradient\":{{\"x0\":{:.6},\"y0\":{:.6},\"x1\":{:.6},\"y1\":{:.6},\"stops\":",
        gradient_path.gradient.x0,
        gradient_path.gradient.y0,
        gradient_path.gradient.x1,
        gradient_path.gradient.y1
    );
    write_glyph_outline_color_gradient_stops(buf, &gradient_path.gradient.stops);
    let _ = write!(
        buf,
        "}},\"fillRule\":{}",
        json_escape(gradient_path.fill_rule.as_str())
    );
    if let Some(source_glyph_id) = gradient_path.source_glyph_id {
        let _ = write!(buf, ",\"sourceGlyphId\":{}", source_glyph_id);
    }
    if let Some(palette_index) = gradient_path.palette_index {
        let _ = write!(buf, ",\"paletteIndex\":{}", palette_index);
    }
    buf.push('}');
}

fn write_glyph_outline_color_radial_gradient_path_node(
    buf: &mut String,
    gradient_path: &crate::paint::ColorPaintRadialGradientPathNode,
) {
    buf.push_str("{\"commands\":");
    write_path_commands(buf, &gradient_path.commands);
    let _ = write!(
        buf,
        ",\"gradient\":{{\"cx\":{:.6},\"cy\":{:.6},\"radius\":{:.6},\"stops\":",
        gradient_path.gradient.cx, gradient_path.gradient.cy, gradient_path.gradient.radius
    );
    write_glyph_outline_color_gradient_stops(buf, &gradient_path.gradient.stops);
    let _ = write!(
        buf,
        "}},\"fillRule\":{}",
        json_escape(gradient_path.fill_rule.as_str())
    );
    if let Some(source_glyph_id) = gradient_path.source_glyph_id {
        let _ = write!(buf, ",\"sourceGlyphId\":{}", source_glyph_id);
    }
    if let Some(palette_index) = gradient_path.palette_index {
        let _ = write!(buf, ",\"paletteIndex\":{}", palette_index);
    }
    buf.push('}');
}

fn write_glyph_outline_color_sweep_gradient_path_node(
    buf: &mut String,
    gradient_path: &crate::paint::ColorPaintSweepGradientPathNode,
) {
    buf.push_str("{\"commands\":");
    write_path_commands(buf, &gradient_path.commands);
    let _ = write!(
        buf,
        ",\"gradient\":{{\"cx\":{:.6},\"cy\":{:.6},\"startAngleDegrees\":{:.6},\"endAngleDegrees\":{:.6},\"stops\":",
        gradient_path.gradient.cx,
        gradient_path.gradient.cy,
        gradient_path.gradient.start_angle_degrees,
        gradient_path.gradient.end_angle_degrees
    );
    write_glyph_outline_color_gradient_stops(buf, &gradient_path.gradient.stops);
    let _ = write!(
        buf,
        "}},\"fillRule\":{}",
        json_escape(gradient_path.fill_rule.as_str())
    );
    if let Some(source_glyph_id) = gradient_path.source_glyph_id {
        let _ = write!(buf, ",\"sourceGlyphId\":{}", source_glyph_id);
    }
    if let Some(palette_index) = gradient_path.palette_index {
        let _ = write!(buf, ",\"paletteIndex\":{}", palette_index);
    }
    buf.push('}');
}

fn write_glyph_outline_color_transform_node(
    buf: &mut String,
    transform: &crate::paint::ColorPaintTransformNode,
) {
    let _ = write!(buf, "{{\"childNodeId\":{}", transform.child_node_id);
    buf.push_str(",\"transform\":");
    write_affine_transform(buf, transform.transform);
    buf.push('}');
}

fn write_glyph_outline_color_composite_node(
    buf: &mut String,
    composite: &crate::paint::ColorPaintCompositeNode,
) {
    let _ = write!(
        buf,
        "{{\"sourceNodeId\":{},\"backdropNodeId\":{},\"mode\":{}}}",
        composite.source_node_id,
        composite.backdrop_node_id,
        json_escape(composite.mode.as_str())
    );
}

fn write_glyph_outline_color_clip_node(buf: &mut String, clip: &crate::paint::ColorPaintClipNode) {
    let _ = write!(buf, "{{\"childNodeId\":{}", clip.child_node_id);
    buf.push_str(",\"clipCommands\":");
    write_path_commands(buf, &clip.clip_commands);
    let _ = write!(
        buf,
        ",\"fillRule\":{}}}",
        json_escape(clip.fill_rule.as_str())
    );
}

fn write_glyph_outline_font_color_glyph_ref(
    buf: &mut String,
    source: &crate::paint::FontColorGlyphRef,
) {
    buf.push('{');
    let mut wrote = false;
    if let Some(face_key) = &source.face_key {
        let _ = write!(buf, "\"faceKey\":{}", json_escape(face_key));
        wrote = true;
    }
    if let Some(glyph_id) = source.glyph_id {
        if wrote {
            buf.push(',');
        }
        let _ = write!(buf, "\"glyphId\":{}", glyph_id);
        wrote = true;
    }
    if let Some(palette_index) = source.palette_index {
        if wrote {
            buf.push(',');
        }
        let _ = write!(buf, "\"paletteIndex\":{}", palette_index);
        wrote = true;
    }
    if let Some(color_format) = source.color_format {
        if wrote {
            buf.push(',');
        }
        let _ = write!(
            buf,
            "\"colorFormat\":{}",
            json_escape(color_format.as_str())
        );
    }
    buf.push('}');
}

fn write_glyph_outline_palette_ref(buf: &mut String, palette: &crate::paint::PaletteRef) {
    buf.push('{');
    let mut wrote = false;
    if let Some(id) = &palette.id {
        let _ = write!(buf, "\"id\":{}", json_escape(id));
        wrote = true;
    }
    if let Some(index) = palette.index {
        if wrote {
            buf.push(',');
        }
        let _ = write!(buf, "\"index\":{}", index);
        wrote = true;
    }
    if let Some(cpal_digest) = &palette.cpal_digest {
        if wrote {
            buf.push(',');
        }
        let _ = write!(buf, "\"cpalDigest\":{}", json_escape(cpal_digest));
    }
    buf.push('}');
}

fn write_glyph_outline_color_layer_node(buf: &mut String, layer: &crate::paint::ColorLayerNode) {
    buf.push('{');
    let mut wrote = false;
    macro_rules! comma {
        () => {
            if wrote {
                buf.push(',');
            } else {
                wrote = true;
            }
        };
    }
    if let Some(layer_index) = layer.layer_index {
        comma!();
        let _ = write!(buf, "\"layerIndex\":{}", layer_index);
    }
    if let Some(glyph_id) = layer.glyph_id {
        comma!();
        let _ = write!(buf, "\"glyphId\":{}", glyph_id);
    }
    if let Some(range) = layer.glyph_range {
        comma!();
        let _ = write!(
            buf,
            "\"glyphRange\":{{\"start\":{},\"end\":{}}}",
            range.start, range.end
        );
    }
    if let Some(range) = layer.source_range_utf8 {
        comma!();
        buf.push_str("\"sourceRangeUtf8\":");
        write_text_source_range(buf, range);
    }
    if let Some(source_font_ref) = &layer.source_font_ref {
        comma!();
        buf.push_str("\"sourceFontRef\":");
        write_glyph_outline_font_color_glyph_ref(buf, source_font_ref);
    }
    if let Some(path_index) = layer.path_index {
        comma!();
        let _ = write!(buf, "\"pathIndex\":{}", path_index);
    }
    if let Some(commands) = &layer.commands {
        comma!();
        buf.push_str("\"commands\":");
        write_path_commands(buf, commands);
    }
    if let Some(fill) = &layer.fill {
        comma!();
        buf.push_str("\"fill\":");
        write_resolved_color(buf, fill);
    }
    if let Some(fill_rule) = layer.fill_rule {
        comma!();
        let _ = write!(buf, "\"fillRule\":{}", json_escape(fill_rule.as_str()));
    }
    if let Some(palette_index) = layer.palette_index {
        comma!();
        let _ = write!(buf, "\"paletteIndex\":{}", palette_index);
    }
    if let Some(color) = layer.color {
        comma!();
        let _ = write!(buf, "\"color\":{}", json_escape(&color_ref_to_css(color)));
    }
    if let Some(opacity) = layer.opacity {
        comma!();
        let _ = write!(buf, "\"opacity\":{:.6}", opacity);
    }
    if let Some(transform) = layer.transform_to_run {
        comma!();
        buf.push_str("\"transformToRun\":");
        write_affine_transform(buf, transform);
    }
    buf.push('}');
}

fn write_resolved_color(buf: &mut String, color: &crate::paint::ResolvedColor) {
    buf.push('{');
    if let Some(color_space) = &color.color_space {
        let _ = write!(buf, "\"colorSpace\":{},", json_escape(color_space));
    }
    let [r, g, b, a] = color.rgba;
    let _ = write!(buf, "\"rgba\":[{:.6},{:.6},{:.6},{:.6}]}}", r, g, b, a);
}

fn write_glyph_outline_bitmap_glyph_payload(
    buf: &mut String,
    payload: &crate::paint::BitmapGlyphPayload,
) {
    let _ = write!(buf, "{{\"imageResourceId\":{}", payload.image_resource_id.0);
    if let Some(range) = payload.source_range_utf8 {
        buf.push_str(",\"sourceRangeUtf8\":");
        write_text_source_range(buf, range);
    }
    if let Some(range) = payload.glyph_range {
        let _ = write!(
            buf,
            ",\"glyphRange\":{{\"start\":{},\"end\":{}}}",
            range.start, range.end
        );
    }
    if let Some(placement) = payload.placement {
        buf.push_str(",\"placement\":");
        write_text_run_placement(buf, placement);
    }
    if let Some(transform) = payload.transform_to_run {
        buf.push_str(",\"transformToRun\":");
        write_affine_transform(buf, transform);
    }
    if let Some((x, y)) = payload.strike_ppem {
        let _ = write!(buf, ",\"strikePpem\":[{},{}]", x, y);
    }
    if let Some(selection) = payload.strike_selection {
        let _ = write!(
            buf,
            ",\"strikeSelection\":{}",
            json_escape(selection.as_str())
        );
    }
    if let Some(pixel_format) = &payload.pixel_format {
        let _ = write!(buf, ",\"pixelFormat\":{}", json_escape(pixel_format));
    }
    if let Some(color_space) = &payload.color_space {
        let _ = write!(buf, ",\"colorSpace\":{}", json_escape(color_space));
    }
    if let Some(alpha_mode) = payload.alpha_mode {
        let _ = write!(buf, ",\"alphaMode\":{}", json_escape(alpha_mode.as_str()));
    }
    if let Some(scaling_policy) = payload.scaling_policy {
        let _ = write!(
            buf,
            ",\"scalingPolicy\":{}",
            json_escape(scaling_policy.as_str())
        );
    }
    if let Some(filtering) = payload.filtering {
        let _ = write!(buf, ",\"filtering\":{}", json_escape(filtering.as_str()));
    }
    buf.push('}');
}

fn write_glyph_outline_svg_glyph_payload(
    buf: &mut String,
    payload: &crate::paint::SvgGlyphPayload,
) {
    let _ = write!(
        buf,
        "{{\"vectorResourceId\":{}",
        payload.vector_resource_id.0
    );
    if let Some(range) = payload.source_range_utf8 {
        buf.push_str(",\"sourceRangeUtf8\":");
        write_text_source_range(buf, range);
    }
    if let Some(range) = payload.glyph_range {
        let _ = write!(
            buf,
            ",\"glyphRange\":{{\"start\":{},\"end\":{}}}",
            range.start, range.end
        );
    }
    if let Some(placement) = payload.placement {
        buf.push_str(",\"placement\":");
        write_text_run_placement(buf, placement);
    }
    if let Some(transform) = payload.transform_to_run {
        buf.push_str(",\"transformToRun\":");
        write_affine_transform(buf, transform);
    }
    if let Some(view_box) = payload.view_box {
        let _ = write!(
            buf,
            ",\"viewBox\":{{\"x\":{:.6},\"y\":{:.6},\"width\":{:.6},\"height\":{:.6}}}",
            view_box.x, view_box.y, view_box.width, view_box.height
        );
    }
    if let Some(size) = payload.intrinsic_size {
        let _ = write!(
            buf,
            ",\"intrinsicSize\":{{\"width\":{:.6},\"height\":{:.6}}}",
            size.width, size.height
        );
    }
    let _ = write!(
        buf,
        ",\"securityMode\":{},\"scriptAllowed\":{},\"animationAllowed\":{},\"externalResourcesAllowed\":{},\"interactivityAllowed\":{}",
        json_escape(payload.security_mode.as_str()),
        payload.script_allowed,
        payload.animation_allowed,
        payload.external_resources_allowed,
        payload.interactivity_allowed
    );
    buf.push('}');
}

fn write_text_positions(buf: &mut String, run: &LayerTextRunPaint) {
    write_text_positions_slice(buf, &run.positions);
}

fn write_text_positions_for_text(buf: &mut String, text: &str, style: &TextStyle) {
    let positions = compute_char_positions(text, style);
    write_text_positions_slice(buf, &positions);
}

fn write_text_positions_slice(buf: &mut String, positions: &[f64]) {
    buf.push('[');
    for (idx, position) in positions.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        let _ = write!(buf, "{:.6}", position);
    }
    buf.push(']');
}

fn display_text_for_text_run(run: &LayerTextRunPaint) -> Option<String> {
    let display_text = expand_pua_display_text(&run.text);
    (display_text != run.text).then_some(display_text)
}

fn write_text_legacy_visuals(buf: &mut String, run: &LayerTextRunPaint) {
    let has_decorations = run.style.underline != UnderlineType::None
        || run.style.strikethrough
        || run.style.emphasis_dot > 0;
    if run.char_overlap.is_none()
        && run.control_marks.is_empty()
        && run.style.tab_leaders.is_empty()
        && !has_decorations
    {
        return;
    }
    buf.push_str(",\"legacyVisuals\":{");
    let mut wrote = false;
    if run.char_overlap.is_some() {
        let state = run
            .legacy_visuals
            .char_overlap
            .unwrap_or(crate::paint::TextLegacyVisualState::Canonical);
        let _ = write!(buf, "\"charOverlap\":{}", json_escape(state.as_str()));
        wrote = true;
    }
    if !run.control_marks.is_empty() {
        if wrote {
            buf.push(',');
        }
        let state = run
            .legacy_visuals
            .control_marks
            .unwrap_or(crate::paint::TextLegacyVisualState::Canonical);
        let _ = write!(buf, "\"controlMarks\":{}", json_escape(state.as_str()));
        wrote = true;
    }
    if !run.style.tab_leaders.is_empty() {
        if wrote {
            buf.push(',');
        }
        let state = run
            .legacy_visuals
            .tab_leaders
            .unwrap_or(crate::paint::TextLegacyVisualState::Canonical);
        let _ = write!(buf, "\"tabLeaders\":{}", json_escape(state.as_str()));
        wrote = true;
    }
    if has_decorations {
        if wrote {
            buf.push(',');
        }
        let state = run
            .legacy_visuals
            .decorations
            .unwrap_or(crate::paint::TextLegacyVisualState::Canonical);
        let _ = write!(buf, "\"decorations\":{}", json_escape(state.as_str()));
    }
    buf.push('}');
}

fn write_text_run_placement(buf: &mut String, placement: TextRunPlacement) {
    buf.push_str("{\"runToPage\":");
    write_affine_transform(buf, placement.run_to_page);
    let _ = write!(buf, ",\"baselineY\":{:.6}}}", placement.baseline_y);
}

fn write_affine_transform(buf: &mut String, transform: LayerAffineTransform) {
    let _ = write!(
        buf,
        "{{\"a\":{:.6},\"b\":{:.6},\"c\":{:.6},\"d\":{:.6},\"e\":{:.6},\"f\":{:.6}}}",
        transform.a, transform.b, transform.c, transform.d, transform.e, transform.f,
    );
}

fn write_text_clusters(buf: &mut String, clusters: &[TextClusterPlacement]) {
    buf.push('[');
    for (idx, cluster) in clusters.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        buf.push('{');
        buf.push_str("\"sourceRangeUtf8\":");
        write_text_source_range(buf, cluster.source_range_utf8);
        buf.push_str(",\"textRangeUtf8\":");
        write_text_source_range(buf, cluster.text_range_utf8);
        if let Some(range) = cluster.text_range_utf16 {
            buf.push_str(",\"textRangeUtf16\":");
            write_text_source_range(buf, range);
        }
        let _ = write!(
            buf,
            ",\"projection\":{},\"origin\":",
            json_escape(cluster.projection.as_str())
        );
        write_layer_point(buf, cluster.origin);
        if let Some(advance) = cluster.advance {
            buf.push_str(",\"advance\":");
            write_layer_vector(buf, advance);
        }
        if !cluster.flags.is_empty() {
            buf.push_str(",\"flags\":[");
            for (flag_idx, flag) in cluster.flags.iter().enumerate() {
                if flag_idx > 0 {
                    buf.push(',');
                }
                buf.push_str(&json_escape(flag.as_str()));
            }
            buf.push(']');
        }
        buf.push('}');
    }
    buf.push(']');
}

fn write_layer_point(buf: &mut String, point: LayerPoint) {
    let _ = write!(buf, "{{\"x\":{:.6},\"y\":{:.6}}}", point.x, point.y);
}

fn write_layer_vector(buf: &mut String, vector: LayerVector) {
    let _ = write!(buf, "{{\"dx\":{:.6},\"dy\":{:.6}}}", vector.dx, vector.dy);
}

fn write_text_control_marks(buf: &mut String, run: &LayerTextRunPaint) {
    buf.push('[');
    for (idx, mark) in run.control_marks.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        write_text_control_mark(buf, mark);
    }
    buf.push(']');
}

fn write_text_control_mark(buf: &mut String, mark: &crate::paint::LayerTextControlMark) {
    let _ = write!(
        buf,
        "{{\"kind\":{},\"text\":{},\"x\":{:.6},\"y\":{:.6},\"fontSize\":{:.6}}}",
        json_escape(mark.kind.as_str()),
        json_escape(mark.kind.glyph()),
        mark.x,
        mark.y,
        mark.font_size,
    );
}

fn write_char_overlap(buf: &mut String, overlap: &crate::renderer::composer::CharOverlapInfo) {
    let _ = write!(
        buf,
        "{{\"borderType\":{},\"innerCharSize\":{}}}",
        overlap.border_type, overlap.inner_char_size,
    );
}

fn write_tab_leaders(buf: &mut String, leaders: &[TabLeaderInfo]) {
    buf.push('[');
    for (idx, leader) in leaders.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        write_tab_leader(buf, leader);
    }
    buf.push(']');
}

fn write_tab_leader(buf: &mut String, leader: &TabLeaderInfo) {
    let _ = write!(
        buf,
        "{{\"startX\":{:.6},\"endX\":{:.6},\"fillType\":{}}}",
        leader.start_x, leader.end_x, leader.fill_type
    );
}

fn write_text_decoration(buf: &mut String, decoration: &crate::paint::LayerTextDecorationPaint) {
    let _ = write!(
        buf,
        "{{\"kind\":{},\"baseline\":{:.6},\"rotation\":{:.6},\"fontSize\":{:.6},\"ratio\":{:.6},\"color\":{},\"shape\":{},\"underline\":{},\"emphasisDot\":{},\"positions\":",
        json_escape(decoration.kind.as_str()),
        decoration.baseline,
        decoration.rotation,
        decoration.font_size,
        decoration.ratio,
        json_escape(&color_ref_to_css(decoration.color)),
        decoration.shape,
        json_escape(underline_type_str(decoration.underline)),
        decoration.emphasis_dot,
    );
    write_text_positions_slice(buf, &decoration.positions);
    buf.push('}');
}

fn write_shape_key(buf: &mut String, shape_key: &ShapeKey) {
    buf.push_str("{\"fontInstance\":{");
    let instance = &shape_key.font_instance;
    let _ = write!(
        buf,
        "\"faceKey\":{},\"sizePx\":{:.6},\"syntheticBold\":{},\"syntheticItalic\":{}",
        json_escape(&instance.face_key.0),
        instance.size_px,
        instance.synthetic_bold,
        instance.synthetic_italic,
    );
    buf.push_str(",\"variations\":[");
    for (idx, axis) in instance.variations.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        let _ = write!(
            buf,
            "{{\"tag\":{},\"value\":{:.6}}}",
            json_escape(&axis.tag),
            axis.value
        );
    }
    buf.push_str("]}");
    let _ = write!(
        buf,
        ",\"direction\":{},\"writingMode\":{},\"shapingEngine\":{},\"fallbackPolicy\":{}",
        json_escape(shape_key.direction.as_str()),
        json_escape(shape_key.writing_mode.as_str()),
        json_escape(&shape_key.shaping_engine.0),
        json_escape(&shape_key.fallback_policy.0),
    );
    if let Some(script) = &shape_key.script {
        let _ = write!(buf, ",\"script\":{}", json_escape(&script.0));
    }
    if let Some(language) = &shape_key.language {
        let _ = write!(buf, ",\"language\":{}", json_escape(&language.0));
    }
    buf.push_str(",\"features\":[");
    for (idx, feature) in shape_key.features.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        let _ = write!(
            buf,
            "{{\"tag\":{},\"enabled\":{}",
            json_escape(&feature.tag),
            feature.enabled
        );
        if let Some(value) = feature.value {
            let _ = write!(buf, ",\"value\":{}", value);
        }
        buf.push('}');
    }
    buf.push_str("]}");
}

fn write_points(buf: &mut String, points: &[LayerPoint]) {
    buf.push('[');
    for (idx, point) in points.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        let _ = write!(buf, "{{\"x\":{:.6},\"y\":{:.6}}}", point.x, point.y);
    }
    buf.push(']');
}

fn write_vectors(buf: &mut String, vectors: &[LayerVector]) {
    buf.push('[');
    for (idx, vector) in vectors.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        let _ = write!(buf, "{{\"dx\":{:.6},\"dy\":{:.6}}}", vector.dx, vector.dy);
    }
    buf.push(']');
}

fn write_glyph_clusters(buf: &mut String, clusters: &[GlyphCluster]) {
    buf.push('[');
    for (idx, cluster) in clusters.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        buf.push('{');
        buf.push_str("\"sourceRangeUtf8\":");
        write_text_source_range(buf, cluster.source_range_utf8);
        if let Some(range) = cluster.source_range_utf16 {
            buf.push_str(",\"sourceRangeUtf16\":");
            write_text_source_range(buf, range);
        }
        if let Some(range) = cluster.text_range_utf8 {
            buf.push_str(",\"textRangeUtf8\":");
            write_text_source_range(buf, range);
        }
        let _ = write!(
            buf,
            ",\"glyphRange\":{{\"start\":{},\"end\":{}}}",
            cluster.glyph_range.start, cluster.glyph_range.end
        );
        if !cluster.flags.is_empty() {
            buf.push_str(",\"flags\":[");
            for (flag_idx, flag) in cluster.flags.iter().enumerate() {
                if flag_idx > 0 {
                    buf.push(',');
                }
                let _ = write!(buf, "{}", json_escape(flag.as_str()));
            }
            buf.push(']');
        }
        buf.push('}');
    }
    buf.push(']');
}

fn write_glyph_transforms(buf: &mut String, transforms: &[GlyphTransform]) {
    buf.push('[');
    for (idx, transform) in transforms.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        let _ = write!(
            buf,
            "{{\"xx\":{:.6},\"xy\":{:.6},\"yx\":{:.6},\"yy\":{:.6},\"tx\":{:.6},\"ty\":{:.6}}}",
            transform.xx, transform.xy, transform.yx, transform.yy, transform.tx, transform.ty
        );
    }
    buf.push(']');
}

fn write_glyph_run_diagnostics(buf: &mut String, diagnostics: &GlyphRunDiagnostics) {
    let _ = write!(
        buf,
        "{{\"quality\":{},\"replayEligibility\":{},\"strictVisualEligible\":{},\"maxOriginDeltaPx\":{:.6},\"maxAdvanceDeltaPx\":{:.6},\"maxResidualAfterAdjustmentPx\":{:.6},\"clusterMismatchCount\":{},\"missingGlyphCount\":{},\"usedFallbackFontCount\":{}",
        json_escape(diagnostics.quality.as_str()),
        json_escape(diagnostics.replay_eligibility.as_str()),
        diagnostics.strict_visual_eligible,
        diagnostics.max_origin_delta_px,
        diagnostics.max_advance_delta_px,
        diagnostics.max_residual_after_adjustment_px,
        diagnostics.cluster_mismatch_count,
        diagnostics.missing_glyph_count,
        diagnostics.used_fallback_font_count,
    );
    if let Some(reason) = &diagnostics.reason {
        let _ = write!(buf, ",\"reason\":{}", json_escape(reason));
    }
    buf.push('}');
}

fn write_shape_style(buf: &mut String, style: &ShapeStyle) {
    buf.push('{');
    if let Some(color) = style.fill_color {
        let _ = write!(
            buf,
            "\"fillColor\":{}",
            json_escape(&color_ref_to_css(color))
        );
    } else {
        buf.push_str("\"fillColor\":null");
    }
    if let Some(pattern) = &style.pattern {
        buf.push_str(",\"pattern\":");
        write_pattern_fill(buf, pattern);
    }
    if let Some(color) = style.stroke_color {
        let _ = write!(
            buf,
            ",\"strokeColor\":{}",
            json_escape(&color_ref_to_css(color))
        );
    } else {
        buf.push_str(",\"strokeColor\":null");
    }
    let _ = write!(
        buf,
        ",\"strokeWidth\":{:.6},\"strokeDash\":{},\"opacity\":{:.6}",
        style.stroke_width,
        json_escape(stroke_dash_str(style.stroke_dash)),
        style.opacity,
    );
    if let Some(shadow) = &style.shadow {
        buf.push_str(",\"shadow\":");
        write_shadow_style(buf, shadow);
    }
    buf.push('}');
}

fn write_pattern_fill(buf: &mut String, pattern: &PatternFillInfo) {
    let _ = write!(
        buf,
        "{{\"patternType\":{},\"patternColor\":{},\"backgroundColor\":{}}}",
        pattern.pattern_type,
        json_escape(&color_ref_to_css(pattern.pattern_color)),
        json_escape(&color_ref_to_css(pattern.background_color)),
    );
}

fn write_shadow_style(buf: &mut String, shadow: &ShadowStyle) {
    let _ = write!(
        buf,
        "{{\"shadowType\":{},\"color\":{},\"offsetX\":{:.6},\"offsetY\":{:.6},\"alpha\":{}}}",
        shadow.shadow_type,
        json_escape(&color_ref_to_css(shadow.color)),
        shadow.offset_x,
        shadow.offset_y,
        shadow.alpha,
    );
}

fn write_gradient(buf: &mut String, gradient: &GradientFillInfo) {
    buf.push('{');
    let _ = write!(
        buf,
        "\"gradientType\":{},\"angle\":{},\"centerX\":{},\"centerY\":{},\"colors\":[",
        gradient.gradient_type, gradient.angle, gradient.center_x, gradient.center_y,
    );
    for (idx, color) in gradient.colors.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        let css = color_ref_to_css(*color);
        buf.push_str(&json_escape(&css));
    }
    buf.push_str("],\"positions\":[");
    for (idx, position) in gradient.positions.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        let _ = write!(buf, "{:.6}", position);
    }
    buf.push_str("]}");
}

fn write_line_style(buf: &mut String, style: &LineStyle) {
    let _ = write!(
        buf,
        "{{\"color\":{},\"width\":{:.6},\"dash\":{},\"lineType\":{},\"startArrow\":{},\"endArrow\":{},\"startArrowSize\":{},\"endArrowSize\":{}",
        json_escape(&color_ref_to_css(style.color)),
        style.width,
        json_escape(stroke_dash_str(style.dash)),
        json_escape(line_render_type_str(style.line_type)),
        json_escape(arrow_style_str(style.start_arrow)),
        json_escape(arrow_style_str(style.end_arrow)),
        style.start_arrow_size,
        style.end_arrow_size,
    );
    if let Some(shadow) = &style.shadow {
        buf.push_str(",\"shadow\":");
        write_shadow_style(buf, shadow);
    }
    buf.push('}');
}

fn write_transform(buf: &mut String, transform: ShapeTransform) {
    let _ = write!(
        buf,
        "{{\"rotation\":{:.6},\"horzFlip\":{},\"vertFlip\":{}}}",
        transform.rotation, transform.horz_flip, transform.vert_flip
    );
}

fn write_path_commands(buf: &mut String, commands: &[PathCommand]) {
    buf.push('[');
    for (idx, command) in commands.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        match command {
            PathCommand::MoveTo(x, y) => {
                let _ = write!(buf, "{{\"type\":\"moveTo\",\"x\":{:.6},\"y\":{:.6}}}", x, y);
            }
            PathCommand::LineTo(x, y) => {
                let _ = write!(buf, "{{\"type\":\"lineTo\",\"x\":{:.6},\"y\":{:.6}}}", x, y);
            }
            PathCommand::CurveTo(x1, y1, x2, y2, x3, y3) => {
                let _ = write!(
                    buf,
                    "{{\"type\":\"curveTo\",\"x1\":{:.6},\"y1\":{:.6},\"x2\":{:.6},\"y2\":{:.6},\"x3\":{:.6},\"y3\":{:.6}}}",
                    x1, y1, x2, y2, x3, y3
                );
            }
            PathCommand::ArcTo(rx, ry, rotation, large_arc, sweep, x, y) => {
                let _ = write!(
                    buf,
                    "{{\"type\":\"arcTo\",\"rx\":{:.6},\"ry\":{:.6},\"rotation\":{:.6},\"largeArc\":{},\"sweep\":{},\"x\":{:.6},\"y\":{:.6}}}",
                    rx, ry, rotation, large_arc, sweep, x, y
                );
            }
            PathCommand::ClosePath => buf.push_str("{\"type\":\"closePath\"}"),
        }
    }
    buf.push(']');
}

fn write_equation_layout_box(buf: &mut String, layout: &LayoutBox) {
    let _ = write!(
        buf,
        "{{\"x\":{:.6},\"y\":{:.6},\"width\":{:.6},\"height\":{:.6},\"baseline\":{:.6},\"kind\":",
        layout.x, layout.y, layout.width, layout.height, layout.baseline,
    );
    write_equation_layout_kind(buf, &layout.kind);
    buf.push('}');
}

fn write_equation_layout_kind(buf: &mut String, kind: &LayoutKind) {
    match kind {
        LayoutKind::Row(children) => {
            buf.push_str("{\"type\":\"row\",\"children\":[");
            for (idx, child) in children.iter().enumerate() {
                if idx > 0 {
                    buf.push(',');
                }
                write_equation_layout_box(buf, child);
            }
            buf.push_str("]}");
        }
        LayoutKind::Text(text) => {
            let _ = write!(buf, "{{\"type\":\"text\",\"text\":{}}}", json_escape(text));
        }
        LayoutKind::Number(text) => {
            let _ = write!(
                buf,
                "{{\"type\":\"number\",\"text\":{}}}",
                json_escape(text)
            );
        }
        LayoutKind::Symbol(text) => {
            let _ = write!(
                buf,
                "{{\"type\":\"symbol\",\"text\":{}}}",
                json_escape(text)
            );
        }
        LayoutKind::MathSymbol(text) => {
            let _ = write!(
                buf,
                "{{\"type\":\"mathSymbol\",\"text\":{}}}",
                json_escape(text)
            );
        }
        LayoutKind::Function(name) => {
            let _ = write!(
                buf,
                "{{\"type\":\"function\",\"name\":{}}}",
                json_escape(name)
            );
        }
        LayoutKind::Fraction { numer, denom } => {
            buf.push_str("{\"type\":\"fraction\",\"numer\":");
            write_equation_layout_box(buf, numer);
            buf.push_str(",\"denom\":");
            write_equation_layout_box(buf, denom);
            buf.push('}');
        }
        LayoutKind::Sqrt { index, body } => {
            buf.push_str("{\"type\":\"sqrt\"");
            if let Some(index) = index {
                buf.push_str(",\"index\":");
                write_equation_layout_box(buf, index);
            }
            buf.push_str(",\"body\":");
            write_equation_layout_box(buf, body);
            buf.push('}');
        }
        LayoutKind::Superscript { base, sup } => {
            buf.push_str("{\"type\":\"superscript\",\"base\":");
            write_equation_layout_box(buf, base);
            buf.push_str(",\"sup\":");
            write_equation_layout_box(buf, sup);
            buf.push('}');
        }
        LayoutKind::Subscript { base, sub } => {
            buf.push_str("{\"type\":\"subscript\",\"base\":");
            write_equation_layout_box(buf, base);
            buf.push_str(",\"sub\":");
            write_equation_layout_box(buf, sub);
            buf.push('}');
        }
        LayoutKind::SubSup { base, sub, sup } => {
            buf.push_str("{\"type\":\"subSup\",\"base\":");
            write_equation_layout_box(buf, base);
            buf.push_str(",\"sub\":");
            write_equation_layout_box(buf, sub);
            buf.push_str(",\"sup\":");
            write_equation_layout_box(buf, sup);
            buf.push('}');
        }
        LayoutKind::BigOp { symbol, sub, sup } => {
            let _ = write!(
                buf,
                "{{\"type\":\"bigOp\",\"symbol\":{}",
                json_escape(symbol)
            );
            if let Some(sub) = sub {
                buf.push_str(",\"sub\":");
                write_equation_layout_box(buf, sub);
            }
            if let Some(sup) = sup {
                buf.push_str(",\"sup\":");
                write_equation_layout_box(buf, sup);
            }
            buf.push('}');
        }
        LayoutKind::Limit { is_upper, sub } => {
            let _ = write!(buf, "{{\"type\":\"limit\",\"isUpper\":{}", is_upper);
            if let Some(sub) = sub {
                buf.push_str(",\"sub\":");
                write_equation_layout_box(buf, sub);
            }
            buf.push('}');
        }
        LayoutKind::Matrix { cells, style } => {
            let _ = write!(
                buf,
                "{{\"type\":\"matrix\",\"style\":{},\"cells\":[",
                json_escape(matrix_style_str(*style))
            );
            for (row_idx, row) in cells.iter().enumerate() {
                if row_idx > 0 {
                    buf.push(',');
                }
                buf.push('[');
                for (cell_idx, cell) in row.iter().enumerate() {
                    if cell_idx > 0 {
                        buf.push(',');
                    }
                    write_equation_layout_box(buf, cell);
                }
                buf.push(']');
            }
            buf.push_str("]}");
        }
        LayoutKind::Rel { arrow, over, under } => {
            buf.push_str("{\"type\":\"rel\",\"arrow\":");
            write_equation_layout_box(buf, arrow);
            buf.push_str(",\"over\":");
            write_equation_layout_box(buf, over);
            if let Some(under) = under {
                buf.push_str(",\"under\":");
                write_equation_layout_box(buf, under);
            }
            buf.push('}');
        }
        LayoutKind::EqAlign { rows } => {
            buf.push_str("{\"type\":\"eqAlign\",\"rows\":[");
            for (idx, (left, right)) in rows.iter().enumerate() {
                if idx > 0 {
                    buf.push(',');
                }
                buf.push_str("{\"left\":");
                write_equation_layout_box(buf, left);
                buf.push_str(",\"right\":");
                write_equation_layout_box(buf, right);
                buf.push('}');
            }
            buf.push_str("]}");
        }
        LayoutKind::Paren { left, right, body } => {
            let _ = write!(
                buf,
                "{{\"type\":\"paren\",\"left\":{},\"right\":{},\"body\":",
                json_escape(left),
                json_escape(right),
            );
            write_equation_layout_box(buf, body);
            buf.push('}');
        }
        LayoutKind::Decoration { kind, body } => {
            let _ = write!(
                buf,
                "{{\"type\":\"decoration\",\"decoration\":{},\"body\":",
                json_escape(deco_kind_str(*kind))
            );
            write_equation_layout_box(buf, body);
            buf.push('}');
        }
        LayoutKind::FontStyle { style, body } => {
            let _ = write!(
                buf,
                "{{\"type\":\"fontStyle\",\"fontStyle\":{},\"body\":",
                json_escape(font_style_kind_str(*style))
            );
            write_equation_layout_box(buf, body);
            buf.push('}');
        }
        LayoutKind::Space(width) => {
            let _ = write!(buf, "{{\"type\":\"space\",\"width\":{:.6}}}", width);
        }
        LayoutKind::Newline => buf.push_str("{\"type\":\"newline\"}"),
        LayoutKind::Empty => buf.push_str("{\"type\":\"empty\"}"),
    }
}

fn underline_type_str(value: UnderlineType) -> &'static str {
    match value {
        UnderlineType::None => "none",
        UnderlineType::Bottom => "bottom",
        UnderlineType::Top => "top",
    }
}

fn stroke_dash_str(value: StrokeDash) -> &'static str {
    match value {
        StrokeDash::Solid => "solid",
        StrokeDash::Dash => "dash",
        StrokeDash::Dot => "dot",
        StrokeDash::DashDot => "dashDot",
        StrokeDash::DashDotDot => "dashDotDot",
    }
}

fn line_render_type_str(value: LineRenderType) -> &'static str {
    match value {
        LineRenderType::Single => "single",
        LineRenderType::Double => "double",
        LineRenderType::ThinThickDouble => "thinThickDouble",
        LineRenderType::ThickThinDouble => "thickThinDouble",
        LineRenderType::ThinThickThinTriple => "thinThickThinTriple",
    }
}

fn arrow_style_str(value: ArrowStyle) -> &'static str {
    match value {
        ArrowStyle::None => "none",
        ArrowStyle::Arrow => "arrow",
        ArrowStyle::ConcaveArrow => "concaveArrow",
        ArrowStyle::OpenDiamond => "openDiamond",
        ArrowStyle::OpenCircle => "openCircle",
        ArrowStyle::OpenSquare => "openSquare",
        ArrowStyle::Diamond => "diamond",
        ArrowStyle::Circle => "circle",
        ArrowStyle::Square => "square",
    }
}

fn matrix_style_str(value: MatrixStyle) -> &'static str {
    match value {
        MatrixStyle::Plain => "plain",
        MatrixStyle::Paren => "paren",
        MatrixStyle::Bracket => "bracket",
        MatrixStyle::Vert => "vert",
    }
}

fn deco_kind_str(value: DecoKind) -> &'static str {
    match value {
        DecoKind::Hat => "hat",
        DecoKind::Check => "check",
        DecoKind::Tilde => "tilde",
        DecoKind::Acute => "acute",
        DecoKind::Grave => "grave",
        DecoKind::Dot => "dot",
        DecoKind::DDot => "dDot",
        DecoKind::Bar => "bar",
        DecoKind::Vec => "vec",
        DecoKind::Dyad => "dyad",
        DecoKind::Under => "under",
        DecoKind::Arch => "arch",
        DecoKind::Underline => "underline",
        DecoKind::Overline => "overline",
        DecoKind::StrikeThrough => "strikeThrough",
    }
}

fn font_style_kind_str(value: FontStyleKind) -> &'static str {
    match value {
        FontStyleKind::Roman => "roman",
        FontStyleKind::Italic => "italic",
        FontStyleKind::Bold => "bold",
    }
}

fn image_fill_mode_str(value: ImageFillMode) -> &'static str {
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

fn text_wrap_str(value: TextWrap) -> &'static str {
    match value {
        TextWrap::Square => "square",
        TextWrap::Tight => "tight",
        TextWrap::Through => "through",
        TextWrap::TopAndBottom => "topAndBottom",
        TextWrap::BehindText => "behindText",
        TextWrap::InFrontOfText => "inFrontOfText",
    }
}

fn image_effect_str(value: ImageEffect) -> &'static str {
    match value {
        ImageEffect::RealPic => "realPic",
        ImageEffect::GrayScale => "grayScale",
        ImageEffect::BlackWhite => "blackWhite",
        ImageEffect::Pattern8x8 => "pattern8x8",
    }
}

fn form_type_str(value: FormType) -> &'static str {
    match value {
        FormType::PushButton => "pushButton",
        FormType::CheckBox => "checkBox",
        FormType::RadioButton => "radioButton",
        FormType::ComboBox => "comboBox",
        FormType::Edit => "edit",
    }
}

fn clip_kind_str(value: ClipKind) -> &'static str {
    match value {
        ClipKind::Body => "body",
        ClipKind::TableCell => "tableCell",
        ClipKind::TextBox => "textBox",
        ClipKind::Generic => "generic",
    }
}

fn cache_hint_str(value: CacheHint) -> &'static str {
    match value {
        CacheHint::None => "none",
        CacheHint::StaticSubtree => "staticSubtree",
        CacheHint::PreferRaster => "preferRaster",
        CacheHint::PreferVectorRecording => "preferVectorRecording",
    }
}

fn field_marker_str(value: FieldMarkerType) -> &'static str {
    match value {
        FieldMarkerType::None => "none",
        FieldMarkerType::FieldBegin => "fieldBegin",
        FieldMarkerType::FieldEnd => "fieldEnd",
        FieldMarkerType::FieldBeginEnd => "fieldBeginEnd",
        FieldMarkerType::ShapeMarker(_) => "shapeMarker",
    }
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use super::*;
    use crate::model::image::ImageEffect;
    use crate::paint::{
        CacheHint, ClipKind, ColorGlyphFormat, ColorGradientStop, ColorLayerNode,
        ColorLayersPayload, ColorLinearGradient, ColorPaintGraphNode, ColorPaintGraphNodeKind,
        ColorPaintGraphPayload, ColorPaintLinearGradientPathNode, ColorPaintTransformNode,
        FontColorGlyphRef, FontFaceKey, FontFallbackPolicyId, FontInstanceKey, GlyphCluster,
        GlyphOutlineFillRule, GlyphOutlinePaintOrder, GlyphOutlinePayloadKind,
        GlyphOutlineStrokeCap, GlyphOutlineStrokeJoin, GlyphOutlineStrokeStyle, GlyphRange,
        GlyphRunDiagnostics, GlyphRunOrientation, GlyphRunReplayEligibility, LayerAffineTransform,
        LayerCharOverlapPaint, LayerEquationPaint, LayerGlyphOutlinePaint, LayerGlyphOutlinePath,
        LayerGlyphRunPaint, LayerImagePaint, LayerLinePaint, LayerNode, LayerOutputOptions,
        LayerPathPaint, LayerPoint, LayerRectanglePaint, LayerTextControlMark,
        LayerTextControlMarkKind, LayerTextDecorationKind, LayerTextDecorationPaint,
        LayerTextOrientation, LayerTextRunPaint, PageLayerTree, PaintTextStyle, PaintVariantMeta,
        ResolvedColor, ResourceArena, ScriptTag, ShapeKey, ShapingEngineId, TextDirection,
        TextLegacyVisualState, TextLegacyVisuals, TextSourceId, TextSourceRange, TextSourceSpan,
        TextVariantKind, TextVariantQuality, WritingMode, LAYER_TREE_SCHEMA,
    };
    use crate::renderer::composer::CharOverlapInfo;

    #[test]
    fn serializes_schema_metadata_from_shared_contract() {
        let tree = PageLayerTree::new(
            40.0,
            40.0,
            LayerNode::leaf(BoundingBox::new(0.0, 0.0, 40.0, 40.0), None, vec![]),
        );

        let json = tree.to_json();
        assert!(json.contains(&format!(
            "\"schemaVersion\":{}",
            LAYER_TREE_SCHEMA.schema_version
        )));
        assert!(json.contains(&format!(
            "\"schemaMinorVersion\":{}",
            LAYER_TREE_SCHEMA.schema_minor_version
        )));
        assert!(json.contains(&format!(
            "\"schema\":{{\"major\":{},\"minor\":{}}}",
            LAYER_TREE_SCHEMA.schema_version, LAYER_TREE_SCHEMA.schema_minor_version
        )));
        assert!(json.contains(&format!(
            "\"resourceTableVersion\":{}",
            LAYER_TREE_SCHEMA.resource_table_version
        )));
        assert!(json.contains(&format!(
            "\"resourceTableMinorVersion\":{}",
            LAYER_TREE_SCHEMA.resource_table_minor_version
        )));
        assert!(json.contains(&format!(
            "\"resourceTable\":{{\"major\":{},\"minor\":{}}}",
            LAYER_TREE_SCHEMA.resource_table_version,
            LAYER_TREE_SCHEMA.resource_table_minor_version
        )));
        assert!(json.contains(&format!("\"unit\":\"{}\"", LAYER_TREE_SCHEMA.unit)));
        assert!(json.contains(&format!(
            "\"coordinateSystem\":\"{}\"",
            LAYER_TREE_SCHEMA.coordinate_system
        )));
        assert!(json.contains("\"layout\":{\"profile\":\"hwpCompat\",\"measurementAuthority\":\"legacyHwpPositions\",\"shapedMeasurement\":\"diagnosticsOnly\"}"));
        assert!(json.contains(
            "\"usedFeatures\":[\"text.paintStyle\",\"text.sourceTable\",\"text.sourceSpan\",\"text.v2.placement\",\"text.v2.clusters\",\"text.projectionKind\",\"text.legacyVisuals\"]"
        ));
        assert!(json.contains("\"optionalFeatures\":[]"));
        assert!(json.contains("\"knownFeatures\":[\"fontResources\",\"fontResources.blobFaceSplit\",\"text.variants\",\"text.paintOrderSlot\",\"text.strictVisualFallbackFree\",\"text.crossScopeVariants\",\"text.variantGroups\",\"text.variantOps\",\"text.shapeDiagnostics\",\"text.glyphRun\",\"text.outlineGlyph\",\"text.glyphOutline.monochromeFill\",\"text.glyphOutline.monochromeFillStroke\",\"text.glyphOutline.colorLayers\",\"text.glyphOutline.colorLayers.colrV0\",\"text.glyphOutline.colorLayers.colrV1\",\"text.glyphOutline.bitmapGlyph\",\"text.glyphOutline.svgGlyph\",\"text.specialVisualOps\",\"text.charOverlapOp\",\"text.controlMarkOp\",\"text.tabLeaderOp\",\"text.decorationOp\",\"text.displayText\",\"text.layout.shapedModern\",\"text.vertical.mixedPerGlyph\"]"));
        assert!(json.contains("\"requiredFeatures\":[]"));
        assert!(json.contains("\"text\":{\"defaultVariant\":\"textRun\",\"variants\":[\"textRun\"],\"variantSelection\":\"exclusiveVariantSet\",\"sourceTextPreserved\":true,\"clusterEncoding\":[\"utf8\",\"utf16\"],\"fallbackRequired\":true,\"placementAuthority\":\"compatibilityProjection\",\"externalizedVisuals\":[]}"));
        assert!(json.contains("\"textV2\":{\"profile\":\"compatibility\",\"canonicalOp\":\"text\",\"fallbackPolicy\":\"required\",\"strictVisualFallbackFree\":false,\"paintOrderSlots\":\"reserved\"}"));
        assert!(json.contains("\"fontResources\":{\"blobs\":[],\"faces\":[]}"));
    }

    #[test]
    fn serializes_display_text_for_pua_text_run() {
        let style = TextStyle {
            font_family: "Noto Sans KR".to_string(),
            font_size: 16.0,
            ..Default::default()
        };
        let text = "\u{F012B}\u{F03C5}(Signature)";
        let display_text = "(인)□(Signature)";
        let source_positions = vec![
            0.0, 16.0, 24.0, 32.0, 40.0, 48.0, 56.0, 64.0, 72.0, 80.0, 88.0, 96.0, 104.0,
        ];
        let display_positions = compute_char_positions(display_text, &style);
        let text_run = PaintOp::TextRun {
            bbox: BoundingBox::new(10.0, 20.0, 80.0, 18.0),
            run: LayerTextRunPaint {
                text: text.to_string(),
                style,
                positions: source_positions.clone(),
                baseline: 13.0,
                ..Default::default()
            },
        };
        let tree = PageLayerTree::new(
            120.0,
            80.0,
            LayerNode::leaf(
                BoundingBox::new(0.0, 0.0, 120.0, 80.0),
                None,
                vec![text_run],
            ),
        );

        let json = tree.to_json();
        let source_positions_json = format!(
            "\"positions\":[{}]",
            source_positions
                .iter()
                .map(|position| format!("{:.6}", position))
                .collect::<Vec<_>>()
                .join(",")
        );
        let display_positions_json = format!(
            "\"displayPositions\":[{}]",
            display_positions
                .iter()
                .map(|position| format!("{:.6}", position))
                .collect::<Vec<_>>()
                .join(",")
        );

        assert!(json.contains(&format!("\"text\":\"{}\"", text)));
        assert!(json.contains(&format!("\"displayText\":\"{}\"", display_text)));
        assert!(json.contains(&source_positions_json));
        assert!(json.contains(&display_positions_json));
        assert!(json.contains("\"text.displayText\""));
    }

    #[test]
    fn serializes_display_text_for_hanyang_old_hangul_pua_text_run() {
        let style = TextStyle {
            font_family: "Noto Sans KR".to_string(),
            font_size: 16.0,
            ..Default::default()
        };
        let text = "\u{E1A7}";
        let display_text = "\u{1100}\u{119E}";
        let display_positions = compute_char_positions(display_text, &style);
        let text_run = PaintOp::TextRun {
            bbox: BoundingBox::new(10.0, 20.0, 80.0, 18.0),
            run: LayerTextRunPaint {
                text: text.to_string(),
                style,
                positions: vec![0.0, 16.0],
                baseline: 13.0,
                ..Default::default()
            },
        };
        let tree = PageLayerTree::new(
            120.0,
            80.0,
            LayerNode::leaf(
                BoundingBox::new(0.0, 0.0, 120.0, 80.0),
                None,
                vec![text_run],
            ),
        );

        let json = tree.to_json();
        let display_positions_json = format!(
            "\"displayPositions\":[{}]",
            display_positions
                .iter()
                .map(|position| format!("{:.6}", position))
                .collect::<Vec<_>>()
                .join(",")
        );

        assert!(json.contains(&format!("\"text\":\"{}\"", text)));
        assert!(json.contains(&format!("\"displayText\":\"{}\"", display_text)));
        assert!(json.contains(&display_positions_json));
        assert!(json.contains("\"text.displayText\""));
    }

    #[test]
    fn serializes_empty_display_positions_for_hidden_pua_filler() {
        let text_run = PaintOp::TextRun {
            bbox: BoundingBox::new(10.0, 20.0, 80.0, 18.0),
            run: LayerTextRunPaint {
                text: "\u{F081C}".to_string(),
                style: TextStyle {
                    font_family: "Noto Sans KR".to_string(),
                    font_size: 16.0,
                    ..Default::default()
                },
                positions: vec![0.0, 0.0],
                baseline: 13.0,
                ..Default::default()
            },
        };
        let tree = PageLayerTree::new(
            120.0,
            80.0,
            LayerNode::leaf(
                BoundingBox::new(0.0, 0.0, 120.0, 80.0),
                None,
                vec![text_run],
            ),
        );

        let json = tree.to_json();

        assert!(json.contains("\"displayText\":\"\""));
        assert!(json.contains("\"displayPositions\":[]"));
    }

    #[test]
    fn serializes_text_and_shape_ops_for_browser_replay() {
        let mut resources = ResourceArena::default();
        let text = PaintOp::TextRun {
            bbox: BoundingBox::new(10.0, 20.0, 80.0, 18.0),
            run: LayerTextRunPaint {
                source: None,
                text: "가A".to_string(),
                style: TextStyle {
                    font_family: "Noto Sans KR".to_string(),
                    font_size: 16.0,
                    color: 0x00010203,
                    bold: true,
                    superscript: true,
                    underline: UnderlineType::Bottom,
                    ..Default::default()
                },
                positions: vec![0.0, 16.0, 24.0],
                control_marks: vec![LayerTextControlMark {
                    kind: LayerTextControlMarkKind::ParagraphEnd,
                    x: 80.0,
                    y: 0.0,
                    font_size: 16.0,
                }],
                is_para_end: false,
                is_line_break_end: false,
                rotation: 0.0,
                is_vertical: false,
                orientation: LayerTextOrientation::Horizontal,
                char_overlap: Some(CharOverlapInfo {
                    border_type: 1,
                    inner_char_size: 90,
                }),
                baseline: 13.0,
                field_marker: Default::default(),
                ..Default::default()
            },
        };
        let rect = PaintOp::Rectangle {
            bbox: BoundingBox::new(8.0, 18.0, 84.0, 22.0),
            rect: LayerRectanglePaint {
                corner_radius: 4.0,
                style: ShapeStyle {
                    fill_color: Some(0x00F0F1F2),
                    stroke_color: Some(0x00030405),
                    stroke_width: 1.5,
                    ..Default::default()
                },
                gradient: None,
                transform: ShapeTransform::default(),
            },
        };
        let equation = PaintOp::Equation {
            bbox: BoundingBox::new(12.0, 44.0, 40.0, 16.0),
            equation: LayerEquationPaint {
                svg_resource_id: resources.intern_svg_fragment("<text x=\"0\" y=\"12\">x</text>"),
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
            },
        };

        let tree = PageLayerTree::with_resources(
            120.0,
            80.0,
            LayerNode::leaf(
                BoundingBox::new(0.0, 0.0, 120.0, 80.0),
                None,
                vec![text, rect, equation],
            ),
            resources,
        );

        let json = tree.to_json();
        let positions_json = format!("\"positions\":[{:.6},{:.6},{:.6}]", 0.0, 16.0, 24.0);

        assert!(json.contains("\"kind\":\"leaf\""));
        assert!(json.contains("\"cacheHint\":\"none\""));
        assert!(json.contains("\"schemaVersion\":1"));
        assert!(json.contains("\"resourceTableVersion\":1"));
        assert!(json.contains("\"unit\":\"px\""));
        assert!(json.contains("\"coordinateSystem\":\"page-top-left-y-down\""));
        assert!(json.contains("\"profile\":\"screen\""));
        assert!(json.contains("\"outputOptions\":{"));
        assert!(json.contains("\"showParagraphMarks\":false"));
        assert!(json.contains("\"type\":\"textRun\""));
        assert!(json.contains("\"projectionKind\":\"syntheticVisual\""));
        assert!(json.contains("\"clusterBasis\":\"legacyPosition\""));
        assert!(json.contains("\"placement\":{\"runToPage\":{\"a\":1.000000,\"b\":0.000000,\"c\":-0.000000,\"d\":1.000000,\"e\":10.000000,\"f\":33.000000},\"baselineY\":0.000000}"));
        assert!(json.contains("\"clusters\":[{\"sourceRangeUtf8\":{\"start\":0,\"end\":3},\"textRangeUtf8\":{\"start\":0,\"end\":3},\"textRangeUtf16\":{\"start\":0,\"end\":1},\"projection\":\"syntheticVisual\",\"origin\":{\"x\":0.000000,\"y\":0.000000},\"advance\":{\"dx\":16.000000,\"dy\":0.000000},\"flags\":[\"specialVisual\",\"notShapingCandidate\"]}"));
        assert!(json.contains("\"source\":{\"id\":0,\"utf8Range\":{\"start\":0,\"end\":4},\"utf16Range\":{\"start\":0,\"end\":2}}"));
        assert!(json.contains("\"variant\":{\"equivalenceGroup\":\"text-0\",\"variantId\":\"textRun\",\"variantKind\":\"textRun\",\"partIndex\":0,\"partCount\":1,\"isDefaultFallback\":true}"));
        assert!(json.contains("\"textSources\":[{\"id\":0,\"text\":\"가A\",\"utf8Range\":{\"start\":0,\"end\":4},\"utf16Range\":{\"start\":0,\"end\":2},\"annotations\":[]}]"));
        assert!(json.contains(&positions_json));
        assert!(json.contains("\"style\":{\"fontFamily\":\"Noto Sans KR\""));
        assert!(json.contains("\"paintStyle\":{\"fontFamily\":\"Noto Sans KR\""));
        assert!(json.contains("\"superscript\":true,\"subscript\":false"));
        assert!(json.contains(
            "\"legacyVisuals\":{\"charOverlap\":\"canonical\",\"controlMarks\":\"canonical\",\"decorations\":\"canonical\"}"
        ));
        assert!(!json.contains("\"availableWidth\""));
        assert!(!json.contains("\"tabStops\""));
        assert!(json.contains("\"controlMarks\":[{\"kind\":\"paragraphEnd\",\"text\":\"↵\",\"x\":80.000000,\"y\":0.000000,\"fontSize\":16.000000}]"));
        assert!(json.contains("\"charOverlap\":{\"borderType\":1,\"innerCharSize\":90}"));
        assert!(json.contains("\"orientation\":\"horizontal\""));
        assert!(json.contains("\"fieldMarker\":\"none\""));
        assert!(json.contains("\"isParaEnd\":false"));
        assert!(json.contains("\"isLineBreakEnd\":false"));
        assert!(json.contains("\"type\":\"rectangle\""));
        assert!(json.contains("\"type\":\"equation\""));
        assert!(json.contains("\"svgContent\":\"<text x=\\\"0\\\" y=\\\"12\\\">x</text>\""));
        assert!(json.contains("\"layoutBox\":{\"x\":0.000000,\"y\":0.000000,\"width\":10.000000,\"height\":12.000000,\"baseline\":9.000000,\"kind\":{\"type\":\"text\",\"text\":\"x\"}}"));
        assert!(json.contains("\"cornerRadius\":4.000000"));
    }

    #[test]
    fn serializes_external_char_overlap_with_legacy_mirror_contract() {
        let char_overlap = CharOverlapInfo {
            border_type: 3,
            inner_char_size: 85,
        };
        let text_run = LayerTextRunPaint {
            text: "12".to_string(),
            style: TextStyle {
                font_size: 16.0,
                ..TextStyle::default()
            },
            positions: vec![0.0, 16.0],
            baseline: 12.0,
            char_overlap: Some(char_overlap.clone()),
            legacy_visuals: TextLegacyVisuals {
                char_overlap: Some(TextLegacyVisualState::Mirror),
                ..TextLegacyVisuals::default()
            },
            ..LayerTextRunPaint::default()
        };
        let tree = PageLayerTree::new(
            80.0,
            60.0,
            LayerNode::leaf(
                BoundingBox::new(0.0, 0.0, 80.0, 60.0),
                None,
                vec![
                    PaintOp::TextRun {
                        bbox: BoundingBox::new(10.0, 20.0, 32.0, 18.0),
                        run: text_run,
                    },
                    PaintOp::CharOverlap {
                        bbox: BoundingBox::new(10.0, 20.0, 32.0, 18.0),
                        overlap: LayerCharOverlapPaint {
                            source: None,
                            variant: None,
                            text: "12".to_string(),
                            style: TextStyle {
                                font_size: 16.0,
                                ..TextStyle::default()
                            },
                            positions: vec![0.0, 16.0],
                            baseline: 12.0,
                            rotation: 0.0,
                            is_vertical: false,
                            orientation: LayerTextOrientation::Horizontal,
                            overlap: char_overlap,
                        },
                    },
                ],
            ),
        );

        let json = tree.to_json();
        assert!(json.contains("\"type\":\"charOverlap\""));
        assert!(json.contains("\"legacyVisuals\":{\"charOverlap\":\"mirror\"}"));
        assert!(json.contains("\"usedFeatures\":[\"text.paintStyle\",\"text.sourceTable\",\"text.sourceSpan\",\"text.v2.placement\",\"text.v2.clusters\",\"text.projectionKind\",\"text.legacyVisuals\",\"text.variantGroups\",\"text.charOverlapOp\"]"));
        assert!(json.contains("\"externalizedVisuals\":[\"charOverlap\"]"));
    }

    #[test]
    fn serializes_external_text_decorations_with_legacy_mirror_contract() {
        let style = TextStyle {
            font_size: 16.0,
            underline: UnderlineType::Bottom,
            underline_shape: 2,
            underline_color: 0x0000_00FF,
            ..TextStyle::default()
        };
        let text_run = LayerTextRunPaint {
            text: "decorated".to_string(),
            style: style.clone(),
            positions: vec![0.0, 16.0, 32.0, 48.0],
            baseline: 12.0,
            legacy_visuals: TextLegacyVisuals {
                decorations: Some(TextLegacyVisualState::Mirror),
                ..TextLegacyVisuals::default()
            },
            ..LayerTextRunPaint::default()
        };
        let tree = PageLayerTree::new(
            90.0,
            50.0,
            LayerNode::leaf(
                BoundingBox::new(0.0, 0.0, 90.0, 50.0),
                None,
                vec![
                    PaintOp::TextRun {
                        bbox: BoundingBox::new(10.0, 20.0, 48.0, 18.0),
                        run: text_run,
                    },
                    PaintOp::TextDecoration {
                        bbox: BoundingBox::new(10.0, 20.0, 48.0, 18.0),
                        decoration: LayerTextDecorationPaint {
                            source: None,
                            kind: LayerTextDecorationKind::Underline,
                            positions: vec![0.0, 16.0, 32.0, 48.0],
                            baseline: 12.0,
                            rotation: 0.0,
                            font_size: 16.0,
                            ratio: 1.0,
                            color: 0x0000_00FF,
                            shape: 2,
                            underline: UnderlineType::Bottom,
                            emphasis_dot: 0,
                        },
                    },
                ],
            ),
        );

        let json = tree.to_json();
        assert!(json.contains("\"type\":\"textDecoration\""));
        assert!(json.contains("\"decoration\":{\"kind\":\"underline\""));
        assert!(json.contains("\"legacyVisuals\":{\"decorations\":\"mirror\"}"));
        assert!(json.contains("\"text.decorationOp\""));
        assert!(json.contains("\"externalizedVisuals\":[\"decorations\"]"));
    }

    #[test]
    fn serializes_image_effect_for_backend_parity() {
        let mut resources = ResourceArena::default();
        let image_id = resources.intern_image_bytes(&[0x89, b'P', b'N', b'G']);
        let tree = PageLayerTree::with_resources(
            40.0,
            40.0,
            LayerNode::leaf(
                BoundingBox::new(0.0, 0.0, 40.0, 40.0),
                None,
                vec![PaintOp::Image {
                    bbox: BoundingBox::new(4.0, 4.0, 20.0, 20.0),
                    image: LayerImagePaint {
                        resource_id: Some(image_id),
                        external_path: None,
                        text_wrap: None,
                        fill_mode: Some(ImageFillMode::FitToSize),
                        original_size: Some((10.0, 10.0)),
                        crop: Some((0, 0, 10, 10)),
                        original_size_hu: Some((10, 10)),
                        brightness: -10,
                        contrast: 20,
                        effect: ImageEffect::GrayScale,
                        transform: ShapeTransform::default(),
                    },
                }],
            ),
            resources,
        );

        let json = tree.to_json();
        assert!(json.contains("\"type\":\"image\""));
        assert!(json.contains("\"effect\":\"grayScale\""));
        assert!(json.contains("\"brightness\":-10"));
        assert!(json.contains("\"contrast\":20"));
        assert!(json.contains("\"originalSizeHu\":[10,10]"));
    }

    #[test]
    fn serializes_line_shadow_and_connector_arrow_metadata() {
        let line = PaintOp::Line {
            bbox: BoundingBox::new(0.0, 0.0, 24.0, 24.0),
            line: LayerLinePaint {
                x1: 2.0,
                y1: 4.0,
                x2: 22.0,
                y2: 20.0,
                style: LineStyle {
                    color: 0x000000ff,
                    width: 3.0,
                    dash: StrokeDash::Dash,
                    line_type: LineRenderType::ThinThickDouble,
                    start_arrow: ArrowStyle::Arrow,
                    end_arrow: ArrowStyle::OpenDiamond,
                    start_arrow_size: 2,
                    end_arrow_size: 5,
                    shadow: Some(ShadowStyle {
                        shadow_type: 1,
                        color: 0x00303030,
                        offset_x: 1.5,
                        offset_y: 2.5,
                        alpha: 64,
                    }),
                },
                transform: ShapeTransform::default(),
            },
        };

        let path_node = LayerPathPaint {
            commands: vec![
                PathCommand::MoveTo(4.0, 4.0),
                PathCommand::CurveTo(8.0, 4.0, 16.0, 20.0, 20.0, 20.0),
            ],
            style: ShapeStyle {
                stroke_color: Some(0x00010203),
                stroke_width: 2.0,
                ..Default::default()
            },
            gradient: None,
            transform: ShapeTransform::default(),
            connector_endpoints: Some((4.0, 4.0, 20.0, 20.0)),
            line_style: Some(LineStyle {
                color: 0x00010203,
                width: 2.0,
                dash: StrokeDash::Solid,
                line_type: LineRenderType::Single,
                start_arrow: ArrowStyle::Circle,
                end_arrow: ArrowStyle::Square,
                start_arrow_size: 1,
                end_arrow_size: 8,
                shadow: None,
            }),
        };

        let tree = PageLayerTree::new(
            40.0,
            40.0,
            LayerNode::leaf(
                BoundingBox::new(0.0, 0.0, 40.0, 40.0),
                None,
                vec![
                    line,
                    PaintOp::Path {
                        bbox: BoundingBox::new(0.0, 0.0, 24.0, 24.0),
                        path: path_node,
                    },
                ],
            ),
        );

        let json = tree.to_json();
        assert!(json.contains("\"shadow\":{\"shadowType\":1,\"color\":\"#303030\",\"offsetX\":1.500000,\"offsetY\":2.500000,\"alpha\":64}"));
        assert!(json.contains(
            "\"connectorEndpoints\":{\"x1\":4.000000,\"y1\":4.000000,\"x2\":20.000000,\"y2\":20.000000}"
        ));
        assert!(json.contains("\"lineStyle\":{\"color\":\"#030201\",\"width\":2.000000,\"dash\":\"solid\",\"lineType\":\"single\",\"startArrow\":\"circle\",\"endArrow\":\"square\",\"startArrowSize\":1,\"endArrowSize\":8}"));
    }

    #[test]
    fn serializes_flattened_form_and_footnote_ops() {
        let tree = PageLayerTree::new(
            40.0,
            40.0,
            LayerNode::leaf(
                BoundingBox::new(0.0, 0.0, 40.0, 40.0),
                None,
                vec![
                    PaintOp::FootnoteMarker {
                        bbox: BoundingBox::new(2.0, 2.0, 10.0, 10.0),
                        marker: crate::paint::LayerFootnoteMarkerPaint {
                            text: "1)".to_string(),
                            font_family: "함초롬돋움".to_string(),
                            base_font_size: 10.0,
                            color: 0x00112233,
                        },
                    },
                    PaintOp::FormObject {
                        bbox: BoundingBox::new(4.0, 12.0, 30.0, 12.0),
                        form: crate::paint::LayerFormObjectPaint {
                            form_type: crate::model::control::FormType::CheckBox,
                            caption: "동의".to_string(),
                            text: String::new(),
                            fore_color: "#123456".to_string(),
                            back_color: "#ffffff".to_string(),
                            value: 1,
                            enabled: true,
                        },
                    },
                ],
            ),
        );

        let json = tree.to_json();
        assert!(json.contains("\"type\":\"footnoteMarker\""));
        assert!(json.contains("\"fontFamily\":\"함초롬돋움\""));
        assert!(json.contains("\"type\":\"formObject\""));
        assert!(json.contains("\"formType\":\"checkBox\""));
        assert!(json.contains("\"caption\":\"동의\""));
        assert!(json.contains("\"foreColor\":\"#123456\""));
    }

    #[test]
    fn serializes_clip_kind_for_browser_replay() {
        let tree = PageLayerTree::new(
            40.0,
            40.0,
            LayerNode::clip_rect(
                BoundingBox::new(0.0, 0.0, 40.0, 40.0),
                None,
                BoundingBox::new(1.0, 2.0, 30.0, 20.0),
                LayerNode::leaf(BoundingBox::new(1.0, 2.0, 30.0, 20.0), None, vec![]),
                ClipKind::Body,
            ),
        );

        let json = tree.to_json();
        assert!(json.contains("\"kind\":\"clipRect\""));
        assert!(json.contains("\"clipKind\":\"body\""));
        assert!(json.contains("\"rightOverflowSlop\":4"));
        assert!(json.contains("\"allowHorizontalOverflowControls\":true"));
    }

    #[test]
    fn serializes_textbox_clip_kind_for_browser_replay() {
        let tree = PageLayerTree::new(
            40.0,
            40.0,
            LayerNode::clip_rect(
                BoundingBox::new(0.0, 0.0, 40.0, 40.0),
                None,
                BoundingBox::new(1.0, 2.0, 30.0, 20.0),
                LayerNode::leaf(BoundingBox::new(1.0, 2.0, 30.0, 20.0), None, vec![]),
                ClipKind::TextBox,
            ),
        );

        let json = tree.to_json();
        assert!(json.contains("\"clipKind\":\"textBox\""));
        assert!(json.contains("\"rightOverflowSlop\":0"));
        assert!(json.contains("\"allowHorizontalOverflowControls\":false"));
    }

    #[test]
    fn serializes_group_cache_hint_for_browser_replay() {
        let tree = PageLayerTree::new(
            40.0,
            40.0,
            LayerNode::group(
                BoundingBox::new(0.0, 0.0, 40.0, 40.0),
                None,
                vec![LayerNode::leaf(
                    BoundingBox::new(0.0, 0.0, 40.0, 40.0),
                    None,
                    vec![],
                )],
                CacheHint::PreferVectorRecording,
                crate::paint::LayerSemantic::default(),
            ),
        );

        let json = tree.to_json();
        assert!(json.contains("\"kind\":\"group\""));
        assert!(json.contains("\"cacheHint\":\"preferVectorRecording\""));
    }

    #[test]
    fn serializes_lightweight_semantic_metadata_separately_from_visual_kind() {
        let tree = PageLayerTree::new(
            40.0,
            40.0,
            LayerNode::group(
                BoundingBox::new(0.0, 0.0, 40.0, 40.0),
                Some(7),
                vec![],
                CacheHint::None,
                crate::paint::LayerSemantic::table(Some(1), Some(2), Some(3), 4, 5),
            ),
        );

        let json = tree.to_json();
        assert!(json.contains("\"kind\":\"group\""));
        assert!(json.contains("\"semantic\":{\"role\":\"table\""));
        assert!(json.contains("\"sectionIndex\":1"));
        assert!(json.contains("\"paraIndex\":2"));
        assert!(json.contains("\"controlIndex\":3"));
        assert!(json.contains("\"rowCount\":4"));
        assert!(json.contains("\"colCount\":5"));
    }

    #[test]
    fn serializes_column_semantic_index() {
        let tree = PageLayerTree::new(
            40.0,
            40.0,
            LayerNode::group(
                BoundingBox::new(0.0, 0.0, 40.0, 40.0),
                Some(8),
                vec![],
                CacheHint::None,
                crate::paint::LayerSemantic::column(2),
            ),
        );

        let json = tree.to_json();
        assert!(json.contains("\"semantic\":{\"role\":\"column\""));
        assert!(json.contains("\"columnIndex\":2"));
    }

    #[test]
    fn serializes_non_default_profile_for_browser_replay() {
        let tree = PageLayerTree::with_profile(
            40.0,
            40.0,
            LayerNode::leaf(BoundingBox::new(0.0, 0.0, 40.0, 40.0), None, vec![]),
            crate::paint::RenderProfile::HighQuality,
        );

        let json = tree.to_json();
        assert!(json.contains("\"profile\":\"high-quality\""));
    }

    #[test]
    fn serializes_optional_glyph_run_variant_with_text_run_fallback() {
        let source = TextSourceSpan {
            id: TextSourceId(0),
            utf8_range: TextSourceRange::new(0, 1),
            utf16_range: TextSourceRange::new(0, 1),
            stable_source_key: None,
        };
        let shape_key = ShapeKey {
            font_instance: FontInstanceKey {
                face_key: FontFaceKey("face-0".to_string()),
                size_px: 12.0,
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
        };
        let text_run = PaintOp::TextRun {
            bbox: BoundingBox::new(0.0, 0.0, 20.0, 20.0),
            run: LayerTextRunPaint {
                source: Some(source.clone()),
                variant: Some(PaintVariantMeta::text_run_default("text-0")),
                text: "A".to_string(),
                style: TextStyle {
                    font_family: "Test".to_string(),
                    font_size: 12.0,
                    ..Default::default()
                },
                positions: vec![0.0, 12.0],
                ..Default::default()
            },
        };
        let glyph_run = PaintOp::GlyphRun {
            bbox: BoundingBox::new(0.0, 0.0, 20.0, 20.0),
            run: LayerGlyphRunPaint {
                source,
                variant: PaintVariantMeta {
                    equivalence_group: "text-0".to_string(),
                    variant_id: "glyphRun".to_string(),
                    variant_kind: crate::paint::TextVariantKind::GlyphRun,
                    part_index: 0,
                    part_count: 1,
                    is_default_fallback: false,
                    requires: vec!["fontResources".to_string(), "text.glyphRun".to_string()],
                    quality: Some(TextVariantQuality::Exact),
                    anchor_op_id: None,
                    local_paint_order: None,
                },
                paint_style: {
                    let mut style = PaintTextStyle::from(&TextStyle {
                        font_family: "Test".to_string(),
                        font_size: 12.0,
                        ..Default::default()
                    });
                    style.tab_leaders.push(TabLeaderInfo {
                        start_x: 2.0,
                        end_x: 10.0,
                        fill_type: 3,
                    });
                    style
                },
                shape_key,
                placement: TextRunPlacement {
                    run_to_page: LayerAffineTransform {
                        a: 1.0,
                        b: 0.0,
                        c: 0.0,
                        d: 1.0,
                        e: 0.0,
                        f: 12.0,
                    },
                    baseline_y: 0.0,
                },
                glyph_ids: vec![42],
                positions: vec![LayerPoint { x: 0.0, y: 0.0 }],
                advances: None,
                clusters: vec![GlyphCluster {
                    source_range_utf8: TextSourceRange::new(0, 1),
                    source_range_utf16: Some(TextSourceRange::new(0, 1)),
                    text_range_utf8: Some(TextSourceRange::new(0, 1)),
                    glyph_range: GlyphRange::new(0, 1),
                    flags: Vec::new(),
                }],
                direction: TextDirection::Ltr,
                bidi_level: None,
                writing_mode: WritingMode::HorizontalTb,
                orientation: GlyphRunOrientation::Horizontal,
                glyph_transforms: None,
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
        };
        let tree = PageLayerTree::new(
            40.0,
            40.0,
            LayerNode::leaf(
                BoundingBox::new(0.0, 0.0, 40.0, 40.0),
                None,
                vec![text_run, glyph_run],
            ),
        );

        let json = tree.to_json();
        assert!(json.contains("\"type\":\"glyphRun\""));
        assert!(json.contains("\"usedFeatures\":[\"text.paintStyle\",\"text.sourceTable\",\"text.sourceSpan\",\"text.v2.placement\",\"text.v2.clusters\",\"text.projectionKind\",\"text.legacyVisuals\",\"fontResources\",\"text.glyphRun\",\"text.variantGroups\"]"));
        assert!(json.contains("\"optionalFeatures\":[\"fontResources\",\"text.glyphRun\"]"));
        assert!(json.contains("\"variants\":[\"textRun\",\"glyphRun\"]"));
        assert!(json.contains("\"variantId\":\"glyphRun\""));
        assert!(json.contains("\"glyphIds\":[42]"));
        assert!(json
            .contains("\"tabLeaders\":[{\"startX\":2.000000,\"endX\":10.000000,\"fillType\":3}]"));
        assert!(json.contains("\"replayEligibility\":\"portable\""));
        assert!(json.contains("\"strictVisualEligible\":true"));
    }

    #[test]
    fn serializes_v2_compat_text_envelope_with_text_run_fallback() {
        let source = TextSourceSpan {
            id: TextSourceId(0),
            utf8_range: TextSourceRange::new(0, 1),
            utf16_range: TextSourceRange::new(0, 1),
            stable_source_key: None,
        };
        let text_run = PaintOp::TextRun {
            bbox: BoundingBox::new(0.0, 0.0, 20.0, 20.0),
            run: LayerTextRunPaint {
                source: Some(source),
                variant: Some(PaintVariantMeta::text_run_default("text-0")),
                text: "A".to_string(),
                style: TextStyle {
                    font_family: "Test".to_string(),
                    font_size: 12.0,
                    ..Default::default()
                },
                positions: vec![0.0, 12.0],
                ..Default::default()
            },
        };
        let tree = PageLayerTree::new(
            40.0,
            40.0,
            LayerNode::leaf(BoundingBox::new(0.0, 0.0, 40.0, 40.0), None, vec![text_run]),
        );

        let json = tree.to_json_v2_compat().expect("valid v2 compat export");

        assert!(json.contains("\"schemaVersion\":2"));
        assert!(json.contains("\"requiredFeatures\":[\"text.variants\",\"text.paintOrderSlot\"]"));
        assert!(json.contains("\"textV2\":{\"profile\":\"compatibility\",\"canonicalOp\":\"text\",\"fallbackPolicy\":\"required\",\"strictVisualFallbackFree\":false,\"paintOrderSlots\":\"required\"}"));
        assert!(json.contains("\"ops\":[{\"id\":\"text-0\",\"type\":\"text\""));
        assert!(json.contains("\"paintOrderSlotId\":\"text-0\""));
        assert!(json.contains("\"selectionPolicy\":\"exclusiveVariantSet\""));
        assert!(json.contains("\"defaultVariantId\":\"textRun\""));
        assert!(json.contains("\"fallbackPolicy\":\"required\""));
        assert!(json.contains("\"variants\":[{\"variantId\":\"textRun\",\"kind\":\"textRun\",\"parts\":[{\"partIndex\":0,\"partCount\":1,\"payload\":{\"id\":\"op-text-0\",\"type\":\"textRun\""));
        assert!(!json.contains("\"ops\":[{\"type\":\"textRun\""));
    }

    #[test]
    fn serializes_optional_glyph_outline_variant_without_generic_path_fallback() {
        let source = TextSourceSpan {
            id: TextSourceId(0),
            utf8_range: TextSourceRange::new(0, 1),
            utf16_range: TextSourceRange::new(0, 1),
            stable_source_key: None,
        };
        let text_run = PaintOp::TextRun {
            bbox: BoundingBox::new(0.0, 0.0, 20.0, 20.0),
            run: LayerTextRunPaint {
                source: Some(source.clone()),
                variant: Some(PaintVariantMeta::text_run_default("text-0")),
                text: "A".to_string(),
                style: TextStyle {
                    font_family: "Test".to_string(),
                    font_size: 12.0,
                    ..Default::default()
                },
                positions: vec![0.0, 12.0],
                ..Default::default()
            },
        };
        let glyph_outline = PaintOp::GlyphOutline {
            bbox: BoundingBox::new(0.0, 0.0, 20.0, 20.0),
            outline: Box::new(LayerGlyphOutlinePaint {
                source,
                variant: PaintVariantMeta {
                    equivalence_group: "text-0".to_string(),
                    variant_id: "glyphOutline".to_string(),
                    variant_kind: crate::paint::TextVariantKind::GlyphOutline,
                    part_index: 0,
                    part_count: 1,
                    is_default_fallback: false,
                    requires: vec!["text.outlineGlyph".to_string()],
                    quality: Some(TextVariantQuality::Exact),
                    anchor_op_id: Some("op-text-0".to_string()),
                    local_paint_order: Some(0),
                },
                payload_kind: GlyphOutlinePayloadKind::MonochromeFill,
                stroke: None,
                color_layers: None,
                bitmap_glyph: None,
                svg_glyph: None,
                paint_style: PaintTextStyle::from(&TextStyle {
                    font_family: "Test".to_string(),
                    font_size: 12.0,
                    ..Default::default()
                }),
                placement: TextRunPlacement {
                    run_to_page: LayerAffineTransform {
                        a: 1.0,
                        b: 0.0,
                        c: 0.0,
                        d: 1.0,
                        e: 0.0,
                        f: 12.0,
                    },
                    baseline_y: 0.0,
                },
                paths: vec![LayerGlyphOutlinePath {
                    glyph_id: 42,
                    source_range_utf8: TextSourceRange::new(0, 1),
                    glyph_range: GlyphRange { start: 0, end: 1 },
                    commands: vec![
                        PathCommand::MoveTo(0.0, 0.0),
                        PathCommand::LineTo(10.0, 0.0),
                        PathCommand::LineTo(10.0, 10.0),
                        PathCommand::ClosePath,
                    ],
                    fill_rule: GlyphOutlineFillRule::EvenOdd,
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
        };
        let tree = PageLayerTree::new(
            40.0,
            40.0,
            LayerNode::leaf(
                BoundingBox::new(0.0, 0.0, 40.0, 40.0),
                None,
                vec![text_run.clone(), glyph_outline],
            ),
        );

        let json = tree.to_json();
        assert!(json.contains("\"id\":\"op-text-0\",\"type\":\"textRun\""));
        assert!(json.contains("\"type\":\"glyphOutline\""));
        assert!(json.contains("\"id\":\"op-text-0-glyphOutline-0\",\"type\":\"glyphOutline\""));
        assert!(json.contains("\"text.outlineGlyph\""));
        assert!(json.contains("\"optionalFeatures\":[\"text.outlineGlyph\"]"));
        assert!(json.contains("\"requiredFeatures\":[]"));
        assert!(json.contains("\"variants\":[\"textRun\",\"glyphOutline\"]"));
        assert!(json.contains("\"fallbackRequired\":true"));
        assert!(json.contains("\"variantId\":\"glyphOutline\""));
        assert!(json.contains("\"anchorOpId\":\"op-text-0\""));
        assert!(json.contains("\"localPaintOrder\":0"));
        assert!(json.contains("\"payloadKind\":\"monochromeFill\""));
        assert!(json.contains("\"paths\":[{\"glyphId\":42"));
        assert!(json.contains("\"sourceRangeUtf8\":{\"start\":0,\"end\":1}"));
        assert!(json.contains("\"glyphRange\":{\"start\":0,\"end\":1}"));
        assert!(json.contains("\"fillRule\":\"evenodd\""));
        assert!(!json.contains("\"type\":\"path\",\"commands\""));
        assert!(!json.contains("\"variantOps\""));
        assert!(!json.contains("\"paintOrderSlotId\""));

        let v2_json = tree.to_json_v2_compat().expect("valid v2 compat export");
        assert!(v2_json.contains("\"schemaVersion\":2"));
        assert!(v2_json.contains("\"ops\":[{\"id\":\"text-0\",\"type\":\"text\""));
        assert!(v2_json.contains("\"paintOrderSlotId\":\"text-0\""));
        assert!(v2_json.contains("\"variantId\":\"glyphOutline\",\"kind\":\"glyphOutline\",\"requiredFeatures\":[\"text.outlineGlyph\"],\"quality\":\"exact\""));
        assert!(v2_json.contains(
            "\"payload\":{\"id\":\"op-text-0-glyphOutline-0\",\"type\":\"glyphOutline\""
        ));
        assert!(!v2_json.contains("\"ops\":[{\"type\":\"textRun\""));
    }

    #[test]
    fn serializes_v2_strict_glyph_outline_export_without_text_run_fallback() {
        let source = TextSourceSpan {
            id: TextSourceId(0),
            utf8_range: TextSourceRange::new(0, 1),
            utf16_range: TextSourceRange::new(0, 1),
            stable_source_key: None,
        };
        let text_run = PaintOp::TextRun {
            bbox: BoundingBox::new(0.0, 0.0, 20.0, 20.0),
            run: LayerTextRunPaint {
                source: Some(source.clone()),
                variant: Some(PaintVariantMeta::text_run_default("text-0")),
                text: "A".to_string(),
                style: TextStyle {
                    font_family: "Test".to_string(),
                    font_size: 12.0,
                    ..Default::default()
                },
                positions: vec![0.0, 12.0],
                ..Default::default()
            },
        };
        let glyph_outline = PaintOp::GlyphOutline {
            bbox: BoundingBox::new(0.0, 0.0, 20.0, 20.0),
            outline: Box::new(LayerGlyphOutlinePaint {
                source,
                variant: PaintVariantMeta {
                    equivalence_group: "text-0".to_string(),
                    variant_id: "glyphOutline".to_string(),
                    variant_kind: TextVariantKind::GlyphOutline,
                    part_index: 0,
                    part_count: 1,
                    is_default_fallback: false,
                    requires: vec!["text.outlineGlyph".to_string()],
                    quality: Some(TextVariantQuality::Exact),
                    anchor_op_id: Some("op-text-0".to_string()),
                    local_paint_order: Some(0),
                },
                payload_kind: GlyphOutlinePayloadKind::MonochromeFill,
                stroke: None,
                color_layers: None,
                bitmap_glyph: None,
                svg_glyph: None,
                paint_style: PaintTextStyle::from(&TextStyle {
                    font_family: "Test".to_string(),
                    font_size: 12.0,
                    ..Default::default()
                }),
                placement: TextRunPlacement {
                    run_to_page: LayerAffineTransform {
                        a: 1.0,
                        b: 0.0,
                        c: 0.0,
                        d: 1.0,
                        e: 0.0,
                        f: 12.0,
                    },
                    baseline_y: 0.0,
                },
                paths: vec![LayerGlyphOutlinePath {
                    glyph_id: 42,
                    source_range_utf8: TextSourceRange::new(0, 1),
                    glyph_range: GlyphRange { start: 0, end: 1 },
                    commands: vec![
                        PathCommand::MoveTo(0.0, 0.0),
                        PathCommand::LineTo(10.0, 0.0),
                        PathCommand::LineTo(10.0, 10.0),
                        PathCommand::ClosePath,
                    ],
                    fill_rule: GlyphOutlineFillRule::EvenOdd,
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
        };
        let mut stroke_glyph_outline = glyph_outline.clone();
        let PaintOp::GlyphOutline { outline, .. } = &mut stroke_glyph_outline else {
            panic!("expected glyph outline");
        };
        outline.payload_kind = GlyphOutlinePayloadKind::MonochromeFillStroke;
        outline.stroke = Some(GlyphOutlineStrokeStyle {
            color: 0x000000,
            width_px: 1.0,
            join: GlyphOutlineStrokeJoin::Miter,
            cap: GlyphOutlineStrokeCap::Butt,
            miter_limit: Some(4.0),
            paint_order: GlyphOutlinePaintOrder::FillThenStroke,
        });
        let stroke_tree = PageLayerTree::new(
            40.0,
            40.0,
            LayerNode::leaf(
                BoundingBox::new(0.0, 0.0, 40.0, 40.0),
                None,
                vec![text_run.clone(), stroke_glyph_outline],
            ),
        );
        let tree = PageLayerTree::new(
            40.0,
            40.0,
            LayerNode::leaf(
                BoundingBox::new(0.0, 0.0, 40.0, 40.0),
                None,
                vec![text_run.clone(), glyph_outline.clone()],
            ),
        );

        let json = tree
            .to_json_v2_strict_glyph_outline()
            .expect("valid strict glyph outline export");

        assert!(json.contains("\"schemaVersion\":2"));
        assert!(json.contains("\"requiredFeatures\":[\"text.variants\",\"text.paintOrderSlot\",\"text.strictVisualFallbackFree\",\"text.outlineGlyph\",\"text.glyphOutline.monochromeFill\"]"));
        assert!(json.contains("\"textV2\":{\"profile\":\"strictVisual\",\"canonicalOp\":\"text\",\"fallbackPolicy\":\"none\",\"strictVisualFallbackFree\":true,\"paintOrderSlots\":\"required\"}"));
        assert!(json.contains("\"ops\":[{\"id\":\"text-0\",\"type\":\"text\""));
        assert!(json.contains("\"defaultVariantId\":\"glyphOutline\""));
        assert!(json.contains("\"fallbackPolicy\":\"none\""));
        assert!(json
            .contains("\"variants\":[{\"variantId\":\"glyphOutline\",\"kind\":\"glyphOutline\""));
        assert!(json.contains(
            "\"payload\":{\"id\":\"op-text-0-glyphOutline-0\",\"type\":\"glyphOutline\""
        ));
        assert!(json.contains("\"fallbackRequired\":false"));
        assert!(!json.contains("\"variantId\":\"textRun\""));
        assert!(!json.contains("\"type\":\"textRun\""));

        let stroke_json = stroke_tree
            .to_json_v2_strict_glyph_outline()
            .expect("valid strict stroke glyph outline export");
        assert!(stroke_json.contains("\"requiredFeatures\":[\"text.variants\",\"text.paintOrderSlot\",\"text.strictVisualFallbackFree\",\"text.outlineGlyph\",\"text.glyphOutline.monochromeFill\",\"text.glyphOutline.monochromeFillStroke\"]"));
        assert!(stroke_json.contains("\"payloadKind\":\"monochromeFillStroke\""));
        assert!(stroke_json.contains("\"stroke\":{\"color\":\"#000000\",\"widthPx\":1.000000,\"join\":\"miter\",\"cap\":\"butt\",\"paintOrder\":\"fillThenStroke\",\"miterLimit\":4.000000}"));

        let mut color_glyph_outline = glyph_outline.clone();
        let PaintOp::GlyphOutline { outline, .. } = &mut color_glyph_outline else {
            panic!("expected glyph outline");
        };
        outline.payload_kind = GlyphOutlinePayloadKind::ColorLayers;
        outline.variant.requires = vec![
            "text.glyphOutline.colorLayers".to_string(),
            "text.glyphOutline.colorLayers.colrV0".to_string(),
        ];
        outline.color_layers = Some(ColorLayersPayload {
            color_format: ColorGlyphFormat::ColrV0,
            source_font_ref: Some(FontColorGlyphRef {
                face_key: Some("fixture-face".to_string()),
                glyph_id: Some(42),
                palette_index: Some(0),
                color_format: Some(ColorGlyphFormat::ColrV0),
            }),
            palette_ref: None,
            source_range_utf8: Some(TextSourceRange::new(0, 1)),
            glyph_range: Some(GlyphRange::new(0, 1)),
            layers: vec![ColorLayerNode {
                layer_index: Some(0),
                glyph_id: Some(42),
                glyph_range: Some(GlyphRange::new(0, 1)),
                source_range_utf8: Some(TextSourceRange::new(0, 1)),
                source_font_ref: Some(FontColorGlyphRef {
                    face_key: Some("fixture-face".to_string()),
                    glyph_id: Some(42),
                    palette_index: Some(0),
                    color_format: Some(ColorGlyphFormat::ColrV0),
                }),
                path_index: Some(0),
                commands: Some(vec![PathCommand::MoveTo(0.0, 0.0), PathCommand::ClosePath]),
                fill: Some(ResolvedColor {
                    color_space: Some("srgb".to_string()),
                    rgba: [0.0, 0.0, 1.0, 1.0],
                }),
                fill_rule: Some(GlyphOutlineFillRule::NonZero),
                palette_index: Some(0),
                color: Some(0x0000ff),
                opacity: Some(1.0),
                transform_to_run: None,
            }],
            paint_graph: None,
        });
        let color_tree = PageLayerTree::new(
            40.0,
            40.0,
            LayerNode::leaf(
                BoundingBox::new(0.0, 0.0, 40.0, 40.0),
                None,
                vec![text_run.clone(), color_glyph_outline],
            ),
        );
        let color_json = color_tree
            .to_json_v2_strict_glyph_outline()
            .expect("valid strict COLRv0 glyph outline export");
        assert!(color_json.contains(
            "\"text.glyphOutline.colorLayers\",\"text.glyphOutline.colorLayers.colrV0\""
        ));
        assert!(color_json.contains("\"payloadKind\":\"colorLayers\""));
        assert!(color_json.contains("\"colorLayers\":{\"colorFormat\":\"colrV0\""));
        assert!(color_json.contains("\"colrv0ResolvedLayerContract\":true"));
        assert!(color_json.contains("\"colrv1SupportedGraphContract\":false"));
        assert!(color_json.contains(
            "\"fill\":{\"colorSpace\":\"srgb\",\"rgba\":[0.000000,0.000000,1.000000,1.000000]}"
        ));

        let mut colrv1_glyph_outline = glyph_outline.clone();
        let PaintOp::GlyphOutline { outline, .. } = &mut colrv1_glyph_outline else {
            panic!("expected glyph outline");
        };
        let source_font_ref = FontColorGlyphRef {
            face_key: Some("fixture-face".to_string()),
            glyph_id: Some(42),
            palette_index: Some(1),
            color_format: Some(ColorGlyphFormat::ColrV1),
        };
        outline.payload_kind = GlyphOutlinePayloadKind::ColorLayers;
        outline.variant.requires = vec![
            "text.glyphOutline.colorLayers".to_string(),
            "text.glyphOutline.colorLayers.colrV1".to_string(),
        ];
        outline.color_layers = Some(ColorLayersPayload {
            color_format: ColorGlyphFormat::ColrV1,
            source_font_ref: Some(source_font_ref.clone()),
            palette_ref: None,
            source_range_utf8: Some(TextSourceRange::new(0, 1)),
            glyph_range: Some(GlyphRange::new(0, 1)),
            layers: Vec::new(),
            paint_graph: Some(ColorPaintGraphPayload {
                root_node_id: 1,
                nodes: vec![
                    ColorPaintGraphNode {
                        node_id: 1,
                        kind: ColorPaintGraphNodeKind::Transform,
                        solid_path: None,
                        linear_gradient_path: None,
                        radial_gradient_path: None,
                        sweep_gradient_path: None,
                        transform: Some(ColorPaintTransformNode {
                            child_node_id: 2,
                            transform: LayerAffineTransform {
                                a: 1.0,
                                b: 0.0,
                                c: 0.0,
                                d: 1.0,
                                e: 2.0,
                                f: 0.0,
                            },
                        }),
                        composite: None,
                        clip: None,
                        source_range_utf8: None,
                        glyph_range: None,
                        source_font_ref: None,
                    },
                    ColorPaintGraphNode {
                        node_id: 2,
                        kind: ColorPaintGraphNodeKind::LinearGradientPath,
                        solid_path: None,
                        linear_gradient_path: Some(ColorPaintLinearGradientPathNode {
                            commands: vec![
                                PathCommand::MoveTo(0.0, 0.0),
                                PathCommand::LineTo(8.0, 0.0),
                                PathCommand::LineTo(8.0, 8.0),
                                PathCommand::ClosePath,
                            ],
                            gradient: ColorLinearGradient {
                                x0: 0.0,
                                y0: 0.0,
                                x1: 8.0,
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
                            palette_index: Some(1),
                        }),
                        radial_gradient_path: None,
                        sweep_gradient_path: None,
                        composite: None,
                        clip: None,
                        source_range_utf8: Some(TextSourceRange::new(0, 1)),
                        glyph_range: Some(GlyphRange::new(0, 1)),
                        source_font_ref: Some(source_font_ref),
                        transform: None,
                    },
                ],
            }),
        });
        let colrv1_tree = PageLayerTree::new(
            40.0,
            40.0,
            LayerNode::leaf(
                BoundingBox::new(0.0, 0.0, 40.0, 40.0),
                None,
                vec![text_run.clone(), colrv1_glyph_outline],
            ),
        );
        let colrv1_json = colrv1_tree
            .to_json_v2_strict_glyph_outline()
            .expect("valid strict COLRv1 stage-1 glyph outline export");
        assert!(colrv1_json.contains(
            "\"text.glyphOutline.colorLayers\",\"text.glyphOutline.colorLayers.colrV1\""
        ));
        assert!(colrv1_json.contains("\"payloadKind\":\"colorLayers\""));
        assert!(colrv1_json.contains("\"colorLayers\":{\"colorFormat\":\"colrV1\""));
        assert!(colrv1_json.contains("\"colrv0ResolvedLayerContract\":false"));
        assert!(colrv1_json.contains("\"colrv1Stage1GraphContract\":true"));
        assert!(colrv1_json.contains("\"colrv1SupportedGraphContract\":true"));
        assert!(colrv1_json.contains("\"paintGraph\":{\"rootNodeId\":1"));
        assert!(colrv1_json.contains("\"kind\":\"linearGradientPath\""));
        assert!(colrv1_json.contains("\"linearGradientPath\":{\"commands\""));
        assert!(colrv1_json.contains(
            "\"gradient\":{\"x0\":0.000000,\"y0\":0.000000,\"x1\":8.000000,\"y1\":0.000000"
        ));
        assert!(colrv1_json.contains("\"stops\":[{\"offset\":0.000000,\"color\":{\"colorSpace\":\"srgb\",\"rgba\":[1.000000,0.000000,0.000000,1.000000]}}"));

        let mut bitmap_glyph_outline = glyph_outline.clone();
        let PaintOp::GlyphOutline { outline, .. } = &mut bitmap_glyph_outline else {
            panic!("expected glyph outline");
        };
        outline.payload_kind = GlyphOutlinePayloadKind::BitmapGlyph;
        outline.variant.requires = vec!["text.glyphOutline.bitmapGlyph".to_string()];
        outline.bitmap_glyph = Some(crate::paint::BitmapGlyphPayload {
            image_resource_id: crate::paint::ImageResourceId(7),
            source_range_utf8: Some(TextSourceRange::new(0, 1)),
            glyph_range: Some(GlyphRange::new(0, 1)),
            placement: Some(TextRunPlacement {
                run_to_page: LayerAffineTransform {
                    a: 1.0,
                    b: 0.0,
                    c: 0.0,
                    d: 1.0,
                    e: 0.0,
                    f: 12.0,
                },
                baseline_y: 0.0,
            }),
            transform_to_run: None,
            strike_ppem: Some((16, 16)),
            strike_selection: Some(crate::paint::BitmapStrikeSelection::ProducerResolved),
            pixel_format: Some("rgba8".to_string()),
            color_space: Some("srgb".to_string()),
            alpha_mode: Some(crate::paint::BitmapAlphaMode::Premultiplied),
            scaling_policy: Some(crate::paint::BitmapGlyphScalingPolicy::ExplicitTransform),
            filtering: Some(crate::paint::BitmapGlyphFiltering::Linear),
        });
        let bitmap_tree = PageLayerTree::new(
            40.0,
            40.0,
            LayerNode::leaf(
                BoundingBox::new(0.0, 0.0, 40.0, 40.0),
                None,
                vec![text_run.clone(), bitmap_glyph_outline],
            ),
        );
        let bitmap_json = bitmap_tree
            .to_json_v2_strict_glyph_outline()
            .expect("valid strict BitmapGlyph outline export");
        assert!(bitmap_json.contains("\"requiredFeatures\":[\"text.variants\",\"text.paintOrderSlot\",\"text.strictVisualFallbackFree\",\"text.outlineGlyph\",\"text.glyphOutline.monochromeFill\",\"text.glyphOutline.bitmapGlyph\"]"));
        assert!(bitmap_json.contains("\"payloadKind\":\"bitmapGlyph\""));
        assert!(bitmap_json.contains("\"bitmapGlyph\":{\"imageResourceId\":7"));
        let bitmap_payload_fixture = include_str!(
            "../../tests/fixtures/glyph_outline_payloads/strict_bitmap_glyph_payload.json"
        )
        .trim()
        .strip_prefix('{')
        .and_then(|value| value.strip_suffix('}'))
        .expect("strict BitmapGlyph fixture is a JSON object");
        assert!(
            bitmap_json.contains(bitmap_payload_fixture),
            "strict BitmapGlyph export must keep the checked-in payload fixture"
        );

        let mut srgb_default_bitmap_glyph_outline = glyph_outline.clone();
        let PaintOp::GlyphOutline { outline, .. } = &mut srgb_default_bitmap_glyph_outline else {
            panic!("expected glyph outline");
        };
        outline.payload_kind = GlyphOutlinePayloadKind::BitmapGlyph;
        outline.variant.requires = vec!["text.glyphOutline.bitmapGlyph".to_string()];
        outline.bitmap_glyph = Some(crate::paint::BitmapGlyphPayload {
            image_resource_id: crate::paint::ImageResourceId(7),
            source_range_utf8: Some(TextSourceRange::new(0, 1)),
            glyph_range: Some(GlyphRange::new(0, 1)),
            placement: Some(TextRunPlacement {
                run_to_page: LayerAffineTransform {
                    a: 1.0,
                    b: 0.0,
                    c: 0.0,
                    d: 1.0,
                    e: 0.0,
                    f: 12.0,
                },
                baseline_y: 0.0,
            }),
            transform_to_run: None,
            strike_ppem: Some((16, 16)),
            strike_selection: Some(crate::paint::BitmapStrikeSelection::ProducerResolved),
            pixel_format: Some("rgba8".to_string()),
            color_space: None,
            alpha_mode: Some(crate::paint::BitmapAlphaMode::Premultiplied),
            scaling_policy: Some(crate::paint::BitmapGlyphScalingPolicy::ExplicitTransform),
            filtering: Some(crate::paint::BitmapGlyphFiltering::Linear),
        });
        let srgb_default_bitmap_tree = PageLayerTree::new(
            40.0,
            40.0,
            LayerNode::leaf(
                BoundingBox::new(0.0, 0.0, 40.0, 40.0),
                None,
                vec![text_run.clone(), srgb_default_bitmap_glyph_outline],
            ),
        );
        let srgb_default_bitmap_json = srgb_default_bitmap_tree
            .to_json_v2_strict_glyph_outline()
            .expect("valid strict BitmapGlyph outline export with default sRGB");
        assert!(srgb_default_bitmap_json.contains("\"payloadKind\":\"bitmapGlyph\""));
        assert!(
            !srgb_default_bitmap_json.contains("\"colorSpace\""),
            "strict BitmapGlyph payload must omit colorSpace when producer leaves it defaulted"
        );
        let srgb_default_bitmap_payload_fixture = include_str!(
            "../../tests/fixtures/glyph_outline_payloads/strict_bitmap_glyph_payload_srgb_default.json"
        )
        .trim()
        .strip_prefix('{')
        .and_then(|value| value.strip_suffix('}'))
        .expect("strict BitmapGlyph sRGB-default fixture is a JSON object");
        assert!(
            srgb_default_bitmap_json.contains(srgb_default_bitmap_payload_fixture),
            "strict BitmapGlyph export must keep the checked-in sRGB-default payload fixture"
        );

        let mut svg_glyph_outline = glyph_outline.clone();
        let PaintOp::GlyphOutline { outline, .. } = &mut svg_glyph_outline else {
            panic!("expected glyph outline");
        };
        outline.payload_kind = GlyphOutlinePayloadKind::SvgGlyph;
        outline.variant.requires = vec!["text.glyphOutline.svgGlyph".to_string()];
        outline.svg_glyph = Some(crate::paint::SvgGlyphPayload {
            vector_resource_id: crate::paint::SvgResourceId(3),
            source_range_utf8: Some(TextSourceRange::new(0, 1)),
            glyph_range: Some(GlyphRange::new(0, 1)),
            placement: Some(TextRunPlacement {
                run_to_page: LayerAffineTransform {
                    a: 1.0,
                    b: 0.0,
                    c: 0.0,
                    d: 1.0,
                    e: 0.0,
                    f: 12.0,
                },
                baseline_y: 0.0,
            }),
            transform_to_run: None,
            view_box: Some(crate::paint::SvgGlyphViewBox {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            }),
            intrinsic_size: None,
            security_mode: crate::paint::SvgGlyphSecurityMode::StaticSanitized,
            script_allowed: false,
            animation_allowed: false,
            external_resources_allowed: false,
            interactivity_allowed: false,
        });
        let svg_tree = PageLayerTree::new(
            40.0,
            40.0,
            LayerNode::leaf(
                BoundingBox::new(0.0, 0.0, 40.0, 40.0),
                None,
                vec![text_run.clone(), svg_glyph_outline],
            ),
        );
        let svg_json = svg_tree
            .to_json_v2_strict_glyph_outline()
            .expect("valid strict SvgGlyph outline export");
        assert!(svg_json.contains("\"requiredFeatures\":[\"text.variants\",\"text.paintOrderSlot\",\"text.strictVisualFallbackFree\",\"text.outlineGlyph\",\"text.glyphOutline.monochromeFill\",\"text.glyphOutline.svgGlyph\"]"));
        assert!(svg_json.contains("\"payloadKind\":\"svgGlyph\""));
        assert!(svg_json.contains("\"svgGlyph\":{\"vectorResourceId\":3"));
        let svg_payload_fixture = include_str!(
            "../../tests/fixtures/glyph_outline_payloads/strict_svg_glyph_payload.json"
        )
        .trim()
        .strip_prefix('{')
        .and_then(|value| value.strip_suffix('}'))
        .expect("strict SvgGlyph fixture is a JSON object");
        assert!(
            svg_json.contains(svg_payload_fixture),
            "strict SvgGlyph export must keep the checked-in payload fixture"
        );

        let mut intrinsic_svg_glyph_outline = glyph_outline;
        let PaintOp::GlyphOutline { outline, .. } = &mut intrinsic_svg_glyph_outline else {
            panic!("expected glyph outline");
        };
        outline.payload_kind = GlyphOutlinePayloadKind::SvgGlyph;
        outline.variant.requires = vec!["text.glyphOutline.svgGlyph".to_string()];
        outline.svg_glyph = Some(crate::paint::SvgGlyphPayload {
            vector_resource_id: crate::paint::SvgResourceId(3),
            source_range_utf8: Some(TextSourceRange::new(0, 1)),
            glyph_range: Some(GlyphRange::new(0, 1)),
            placement: Some(TextRunPlacement {
                run_to_page: LayerAffineTransform {
                    a: 1.0,
                    b: 0.0,
                    c: 0.0,
                    d: 1.0,
                    e: 0.0,
                    f: 12.0,
                },
                baseline_y: 0.0,
            }),
            transform_to_run: None,
            view_box: Some(crate::paint::SvgGlyphViewBox {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            }),
            intrinsic_size: Some(crate::paint::SvgGlyphIntrinsicSize {
                width: 10.0,
                height: 12.0,
            }),
            security_mode: crate::paint::SvgGlyphSecurityMode::StaticSanitized,
            script_allowed: false,
            animation_allowed: false,
            external_resources_allowed: false,
            interactivity_allowed: false,
        });
        let intrinsic_svg_tree = PageLayerTree::new(
            40.0,
            40.0,
            LayerNode::leaf(
                BoundingBox::new(0.0, 0.0, 40.0, 40.0),
                None,
                vec![text_run, intrinsic_svg_glyph_outline],
            ),
        );
        let intrinsic_svg_json = intrinsic_svg_tree
            .to_json_v2_strict_glyph_outline()
            .expect("valid strict SvgGlyph outline export with intrinsic size");
        assert!(intrinsic_svg_json.contains("\"payloadKind\":\"svgGlyph\""));
        assert!(intrinsic_svg_json
            .contains("\"intrinsicSize\":{\"width\":10.000000,\"height\":12.000000}"));
        let intrinsic_svg_payload_fixture = include_str!(
            "../../tests/fixtures/glyph_outline_payloads/strict_svg_glyph_payload_intrinsic_size.json"
        )
        .trim()
        .strip_prefix('{')
        .and_then(|value| value.strip_suffix('}'))
        .expect("strict SvgGlyph intrinsic-size fixture is a JSON object");
        assert!(
            intrinsic_svg_json.contains(intrinsic_svg_payload_fixture),
            "strict SvgGlyph export must keep the checked-in intrinsic-size payload fixture"
        );
    }

    #[test]
    fn serializes_v2_strict_glyph_run_export_without_text_run_fallback() {
        let source = TextSourceSpan {
            id: TextSourceId(0),
            utf8_range: TextSourceRange::new(0, 1),
            utf16_range: TextSourceRange::new(0, 1),
            stable_source_key: None,
        };
        let shape_key = ShapeKey {
            font_instance: FontInstanceKey {
                face_key: FontFaceKey("face-0".to_string()),
                size_px: 12.0,
                variations: Vec::new(),
                synthetic_bold: false,
                synthetic_italic: false,
            },
            direction: TextDirection::Ltr,
            writing_mode: WritingMode::HorizontalTb,
            script: None,
            language: None,
            features: Vec::new(),
            shaping_engine: ShapingEngineId("test".to_string()),
            fallback_policy: FontFallbackPolicyId("none".to_string()),
        };
        let text_run = PaintOp::TextRun {
            bbox: BoundingBox::new(0.0, 0.0, 20.0, 20.0),
            run: LayerTextRunPaint {
                source: Some(source.clone()),
                variant: Some(PaintVariantMeta::text_run_default("text-0")),
                text: "A".to_string(),
                style: TextStyle {
                    font_family: "Test".to_string(),
                    font_size: 12.0,
                    ..Default::default()
                },
                positions: vec![0.0, 12.0],
                ..Default::default()
            },
        };
        let glyph_run = PaintOp::GlyphRun {
            bbox: BoundingBox::new(0.0, 0.0, 20.0, 20.0),
            run: LayerGlyphRunPaint {
                source,
                variant: PaintVariantMeta {
                    equivalence_group: "text-0".to_string(),
                    variant_id: "glyphRun".to_string(),
                    variant_kind: TextVariantKind::GlyphRun,
                    part_index: 0,
                    part_count: 1,
                    is_default_fallback: false,
                    requires: vec!["fontResources".to_string(), "text.glyphRun".to_string()],
                    quality: Some(TextVariantQuality::Exact),
                    anchor_op_id: None,
                    local_paint_order: Some(0),
                },
                paint_style: PaintTextStyle::from(&TextStyle {
                    font_family: "Test".to_string(),
                    font_size: 12.0,
                    ..Default::default()
                }),
                shape_key,
                placement: TextRunPlacement {
                    run_to_page: LayerAffineTransform {
                        a: 1.0,
                        b: 0.0,
                        c: 0.0,
                        d: 1.0,
                        e: 0.0,
                        f: 12.0,
                    },
                    baseline_y: 0.0,
                },
                glyph_ids: vec![42],
                positions: vec![LayerPoint { x: 0.0, y: 0.0 }],
                advances: None,
                clusters: vec![GlyphCluster {
                    source_range_utf8: TextSourceRange::new(0, 1),
                    source_range_utf16: Some(TextSourceRange::new(0, 1)),
                    text_range_utf8: Some(TextSourceRange::new(0, 1)),
                    glyph_range: GlyphRange::new(0, 1),
                    flags: Vec::new(),
                }],
                direction: TextDirection::Ltr,
                bidi_level: None,
                writing_mode: WritingMode::HorizontalTb,
                orientation: GlyphRunOrientation::Horizontal,
                glyph_transforms: None,
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
        };
        let tree = PageLayerTree::new(
            40.0,
            40.0,
            LayerNode::leaf(
                BoundingBox::new(0.0, 0.0, 40.0, 40.0),
                None,
                vec![text_run, glyph_run],
            ),
        );

        let json = tree
            .to_json_v2_strict_glyph_run()
            .expect("valid strict glyph run export");

        assert!(json.contains("\"schemaVersion\":2"));
        assert!(json.contains("\"requiredFeatures\":[\"text.variants\",\"text.paintOrderSlot\",\"text.strictVisualFallbackFree\",\"fontResources\",\"text.glyphRun\"]"));
        assert!(json.contains("\"textV2\":{\"profile\":\"strictVisual\",\"canonicalOp\":\"text\",\"fallbackPolicy\":\"none\",\"strictVisualFallbackFree\":true,\"paintOrderSlots\":\"required\"}"));
        assert!(json.contains("\"ops\":[{\"id\":\"text-0\",\"type\":\"text\""));
        assert!(json.contains("\"defaultVariantId\":\"glyphRun\""));
        assert!(json.contains("\"fallbackPolicy\":\"none\""));
        assert!(json.contains("\"variants\":[{\"variantId\":\"glyphRun\",\"kind\":\"glyphRun\""));
        assert!(json.contains("\"payload\":{\"id\":\"op-text-0-glyphRun-0\",\"type\":\"glyphRun\""));
        assert!(json.contains("\"fallbackRequired\":false"));
        assert!(!json.contains("\"variantId\":\"textRun\""));
        assert!(!json.contains("\"type\":\"textRun\""));
    }

    #[test]
    fn rejects_v2_strict_glyph_outline_export_without_strict_outline() {
        let text_run = PaintOp::TextRun {
            bbox: BoundingBox::new(0.0, 0.0, 20.0, 20.0),
            run: LayerTextRunPaint {
                text: "A".to_string(),
                style: TextStyle {
                    font_family: "Test".to_string(),
                    font_size: 12.0,
                    ..Default::default()
                },
                positions: vec![0.0, 12.0],
                ..Default::default()
            },
        };
        let tree = PageLayerTree::new(
            40.0,
            40.0,
            LayerNode::leaf(BoundingBox::new(0.0, 0.0, 40.0, 40.0), None, vec![text_run]),
        );

        let issues = tree
            .to_json_v2_strict_glyph_outline()
            .expect_err("strict glyph outline export must fail closed");

        assert!(issues
            .iter()
            .any(|issue| issue.code == TextV2ValidationIssueCode::StrictVisualVariantMissing));
    }

    #[test]
    fn rejects_v2_strict_glyph_run_export_without_strict_glyph_run() {
        let text_run = PaintOp::TextRun {
            bbox: BoundingBox::new(0.0, 0.0, 20.0, 20.0),
            run: LayerTextRunPaint {
                text: "A".to_string(),
                style: TextStyle {
                    font_family: "Test".to_string(),
                    font_size: 12.0,
                    ..Default::default()
                },
                positions: vec![0.0, 12.0],
                ..Default::default()
            },
        };
        let tree = PageLayerTree::new(
            40.0,
            40.0,
            LayerNode::leaf(BoundingBox::new(0.0, 0.0, 40.0, 40.0), None, vec![text_run]),
        );

        let issues = tree
            .to_json_v2_strict_glyph_run()
            .expect_err("strict glyph run export must fail closed");

        assert!(issues
            .iter()
            .any(|issue| issue.code == TextV2ValidationIssueCode::StrictVisualVariantMissing));
    }

    #[test]
    fn serializes_sidecar_variant_ops_and_absorbs_them_into_v2_text_envelope() {
        let source = TextSourceSpan {
            id: TextSourceId(0),
            utf8_range: TextSourceRange::new(0, 1),
            utf16_range: TextSourceRange::new(0, 1),
            stable_source_key: None,
        };
        let text_run = PaintOp::TextRun {
            bbox: BoundingBox::new(0.0, 0.0, 20.0, 20.0),
            run: LayerTextRunPaint {
                source: Some(source.clone()),
                variant: Some(PaintVariantMeta::text_run_default("text-0")),
                text: "A".to_string(),
                style: TextStyle {
                    font_family: "Test".to_string(),
                    font_size: 12.0,
                    ..Default::default()
                },
                positions: vec![0.0, 12.0],
                ..Default::default()
            },
        };
        let glyph_outline = PaintOp::GlyphOutline {
            bbox: BoundingBox::new(0.0, 0.0, 20.0, 20.0),
            outline: Box::new(LayerGlyphOutlinePaint {
                source,
                variant: PaintVariantMeta {
                    equivalence_group: "text-0".to_string(),
                    variant_id: "glyphOutline".to_string(),
                    variant_kind: TextVariantKind::GlyphOutline,
                    part_index: 0,
                    part_count: 1,
                    is_default_fallback: false,
                    requires: vec!["text.outlineGlyph".to_string()],
                    quality: Some(TextVariantQuality::Exact),
                    anchor_op_id: Some("op-text-0".to_string()),
                    local_paint_order: Some(0),
                },
                payload_kind: GlyphOutlinePayloadKind::MonochromeFill,
                stroke: None,
                color_layers: None,
                bitmap_glyph: None,
                svg_glyph: None,
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
                    glyph_id: 42,
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
            }),
        };
        let tree = PageLayerTree::builder(
            40.0,
            40.0,
            LayerNode::leaf(BoundingBox::new(0.0, 0.0, 40.0, 40.0), None, vec![text_run]),
        )
        .variant_ops(vec![glyph_outline])
        .build();

        let json = tree.to_json();
        assert!(json.contains(
            "\"variantOps\":[{\"id\":\"op-text-0-glyphOutline-0\",\"type\":\"glyphOutline\""
        ));
        assert!(json.contains("\"text.variantOps\""));
        assert!(json.contains("\"anchorOpId\":\"op-text-0\""));

        let v2_json = tree.to_json_v2_compat().expect("valid v2 compat export");
        assert!(!v2_json.contains("\"variantOps\""));
        assert!(v2_json.contains("\"variantId\":\"glyphOutline\",\"kind\":\"glyphOutline\""));
        assert!(v2_json.contains(
            "\"payload\":{\"id\":\"op-text-0-glyphOutline-0\",\"type\":\"glyphOutline\""
        ));
    }

    #[test]
    fn serializes_glyph_outline_stroke_style_payload() {
        let mut json = String::new();
        write_glyph_outline_stroke_style(
            &mut json,
            &GlyphOutlineStrokeStyle {
                color: 0x112233,
                width_px: 1.5,
                join: GlyphOutlineStrokeJoin::Round,
                cap: GlyphOutlineStrokeCap::Square,
                miter_limit: Some(3.0),
                paint_order: GlyphOutlinePaintOrder::FillThenStroke,
            },
        );

        assert_eq!(
            json,
            concat!(
                "{\"color\":\"#332211\",\"widthPx\":1.500000,",
                "\"join\":\"round\",\"cap\":\"square\",",
                "\"paintOrder\":\"fillThenStroke\",\"miterLimit\":3.000000}"
            )
        );
    }

    #[test]
    fn serializes_output_options_for_backend_replay() {
        let tree = PageLayerTree::new(
            40.0,
            40.0,
            LayerNode::leaf(BoundingBox::new(0.0, 0.0, 40.0, 40.0), None, vec![]),
        )
        .with_output_options(LayerOutputOptions {
            show_paragraph_marks: true,
            show_control_codes: true,
            show_transparent_borders: true,
            clip_enabled: false,
            debug_overlay: true,
        });

        let json = tree.to_json();
        assert!(json.contains("\"showParagraphMarks\":true"));
        assert!(json.contains("\"showControlCodes\":true"));
        assert!(json.contains("\"showTransparentBorders\":true"));
        assert!(json.contains("\"clipEnabled\":false"));
        assert!(json.contains("\"debugOverlay\":true"));
        assert!(json.contains("\"buildOptions\":{\"showTransparentBorders\":true}"));
        assert!(json.contains("\"debugOptions\":{\"debugOverlay\":true}"));
        assert!(
            json.contains("\"debugCapabilities\":{\"overlayPaint\":false,\"semanticBounds\":true")
        );
        assert!(json
            .contains("\"genericLayerExport\":{\"overlayPaint\":false,\"semanticBounds\":true}"));
        assert!(json.contains("\"svgLayer\":{\"overlayPaint\":true,\"semanticBounds\":true}"));
        assert!(json.contains("\"nativeSkia\":{\"overlayPaint\":false,\"semanticBounds\":true}"));
    }
}

fn json_escape(value: &str) -> String {
    format!("\"{}\"", raw_json_escape(value))
}
