use std::collections::{HashMap, HashSet};

use js_sys::{Array, Object, Reflect, Uint8Array};
use wasm_bindgen::JsValue;

use crate::document_core::helpers::color_ref_to_css;
use crate::model::control::FormType;
use crate::model::image::ImageEffect;
use crate::model::shape::TextWrap;
use crate::model::style::{ImageFillMode, UnderlineType};
use crate::paint::{
    font_blob_resource_key, has_supported_strict_glyph_outline_bitmap,
    has_supported_strict_glyph_outline_colrv0, has_supported_strict_glyph_outline_colrv1,
    has_supported_strict_glyph_outline_stroke, has_supported_strict_glyph_outline_svg,
    image_resource_key, resource_digest_hex, svg_resource_key, CacheHint, ClipKind, GlyphCluster,
    GlyphOutlineStrokeStyle, GlyphRunDiagnostics, GlyphTransform, LayerAffineTransform, LayerNode,
    LayerNodeKind, LayerPoint, LayerSemantic, LayerTextPaintOpV2, LayerTextVariantPart,
    LayerTextVariantPayload, LayerTextVariantSet, LayerVector, PageLayerTree, PaintOp,
    PaintTextStyle, PaintVariantMeta, ShapeKey, TextClusterPlacement, TextRunPlacement,
    TextSourceAnnotation, TextSourceEntry, TextSourceRange, TextSourceSpan, TextSourceTable,
    TextV2ValidationIssue, TextV2ValidationIssueCode, TextV2ValidationOptions, LAYER_TREE_SCHEMA,
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

#[derive(Debug, Default)]
pub struct LayerResourceExportHints {
    known_image_keys: HashSet<String>,
    known_svg_keys: HashSet<String>,
}

impl LayerResourceExportHints {
    pub fn from_js_values(known_image_keys: &JsValue, known_svg_keys: &JsValue) -> Self {
        Self {
            known_image_keys: string_set_from_js_value(known_image_keys),
            known_svg_keys: string_set_from_js_value(known_svg_keys),
        }
    }
}

pub fn page_layer_tree_to_js_value(tree: &PageLayerTree) -> JsValue {
    page_layer_tree_to_js_value_with_resource_hints(tree, &LayerResourceExportHints::default())
}

pub fn page_layer_tree_to_js_value_with_resource_hints(
    tree: &PageLayerTree,
    hints: &LayerResourceExportHints,
) -> JsValue {
    let value = Object::new();
    set_number(
        &value,
        "schemaVersion",
        LAYER_TREE_SCHEMA.schema_version as f64,
    );
    set_number(
        &value,
        "schemaMinorVersion",
        LAYER_TREE_SCHEMA.schema_minor_version as f64,
    );
    let schema = Object::new();
    set_number(&schema, "major", LAYER_TREE_SCHEMA.schema_version as f64);
    set_number(
        &schema,
        "minor",
        LAYER_TREE_SCHEMA.schema_minor_version as f64,
    );
    set_value(&value, "schema", schema.into());
    set_number(
        &value,
        "resourceTableVersion",
        LAYER_TREE_SCHEMA.resource_table_version as f64,
    );
    set_number(
        &value,
        "resourceTableMinorVersion",
        LAYER_TREE_SCHEMA.resource_table_minor_version as f64,
    );
    let resource_table = Object::new();
    set_number(
        &resource_table,
        "major",
        LAYER_TREE_SCHEMA.resource_table_version as f64,
    );
    set_number(
        &resource_table,
        "minor",
        LAYER_TREE_SCHEMA.resource_table_minor_version as f64,
    );
    set_value(&value, "resourceTable", resource_table.into());
    set_string(&value, "unit", LAYER_TREE_SCHEMA.unit);
    set_string(
        &value,
        "coordinateSystem",
        LAYER_TREE_SCHEMA.coordinate_system,
    );
    set_number(&value, "pageWidth", tree.page_width);
    set_number(&value, "pageHeight", tree.page_height);
    set_string(&value, "profile", tree.profile.as_str());
    let layout = Object::new();
    set_string(&layout, "profile", "hwpCompat");
    set_string(&layout, "measurementAuthority", "legacyHwpPositions");
    set_string(&layout, "shapedMeasurement", "diagnosticsOnly");
    set_value(&value, "layout", layout.into());
    let output_options = Object::new();
    set_bool(
        &output_options,
        "showParagraphMarks",
        tree.output_options.show_paragraph_marks,
    );
    set_bool(
        &output_options,
        "showControlCodes",
        tree.output_options.show_control_codes,
    );
    set_bool(
        &output_options,
        "showTransparentBorders",
        tree.output_options.show_transparent_borders,
    );
    set_bool(
        &output_options,
        "clipEnabled",
        tree.output_options.clip_enabled,
    );
    set_bool(
        &output_options,
        "debugOverlay",
        tree.output_options.debug_overlay,
    );
    set_value(&value, "outputOptions", output_options.into());
    let build_options = Object::new();
    set_bool(
        &build_options,
        "showTransparentBorders",
        tree.output_options.show_transparent_borders,
    );
    set_value(&value, "buildOptions", build_options.into());
    let debug_options = Object::new();
    set_bool(
        &debug_options,
        "debugOverlay",
        tree.output_options.debug_overlay,
    );
    set_value(&value, "debugOptions", debug_options.into());
    let debug_capabilities = Object::new();
    set_bool(&debug_capabilities, "overlayPaint", false);
    set_bool(&debug_capabilities, "semanticBounds", true);
    let generic_layer_export = Object::new();
    set_bool(&generic_layer_export, "overlayPaint", false);
    set_bool(&generic_layer_export, "semanticBounds", true);
    set_value(
        &debug_capabilities,
        "genericLayerExport",
        generic_layer_export.into(),
    );
    let backends = Object::new();
    set_debug_backend_capability(&backends, "svgLayer", true);
    set_debug_backend_capability(&backends, "canvas2d", false);
    set_debug_backend_capability(&backends, "canvaskit", false);
    set_debug_backend_capability(&backends, "nativeSkia", false);
    set_value(&debug_capabilities, "backends", backends.into());
    set_value(&value, "debugCapabilities", debug_capabilities.into());
    let mut text_source_state = TextSourceExportState::default();
    set_value(
        &value,
        "root",
        layer_node_to_value(&tree.root, &mut text_source_state),
    );
    if !tree.variant_ops.is_empty() {
        set_value(
            &value,
            "variantOps",
            paint_ops_to_value(&tree.variant_ops, &mut text_source_state),
        );
    }
    set_value(
        &value,
        "textSources",
        text_sources_to_value(&tree.text_sources),
    );
    set_value(
        &value,
        "fontResources",
        font_resources_to_value(tree.resources.font_resources()),
    );
    let externalized_visuals = externalized_text_visuals(&tree.root);
    let has_variant_groups =
        has_text_variant_groups(&tree.root) || has_text_variant_ops(&tree.variant_ops);
    let has_sidecar_variants = !tree.variant_ops.is_empty();
    let has_glyph_runs = has_glyph_runs(&tree.root) || ops_have_glyph_runs(&tree.variant_ops);
    let has_glyph_outlines =
        has_glyph_outlines(&tree.root) || ops_have_glyph_outlines(&tree.variant_ops);
    let has_display_text = has_display_text(&tree.root) || ops_have_display_text(&tree.variant_ops);
    let mut used_features = vec![
        "text.paintStyle",
        "text.sourceTable",
        "text.sourceSpan",
        "text.v2.placement",
        "text.v2.clusters",
        "text.projectionKind",
        "text.legacyVisuals",
    ];
    if has_display_text {
        used_features.push("text.displayText");
    }
    if has_glyph_runs {
        used_features.push("fontResources");
        used_features.push("text.glyphRun");
    }
    if has_glyph_outlines {
        used_features.push("text.outlineGlyph");
    }
    if has_variant_groups {
        used_features.push("text.variantGroups");
    }
    if has_sidecar_variants {
        used_features.push("text.variantOps");
    }
    if externalized_visuals
        .iter()
        .any(|visual| *visual == "charOverlap")
    {
        used_features.push("text.charOverlapOp");
    }
    if externalized_visuals
        .iter()
        .any(|visual| *visual == "controlMarks")
    {
        used_features.push("text.controlMarkOp");
    }
    if externalized_visuals
        .iter()
        .any(|visual| *visual == "tabLeaders")
    {
        used_features.push("text.tabLeaderOp");
    }
    if externalized_visuals
        .iter()
        .any(|visual| *visual == "decorations")
    {
        used_features.push("text.decorationOp");
    }
    set_value(
        &value,
        "usedFeatures",
        string_array_to_value(&used_features),
    );
    let mut optional_features = Vec::new();
    if has_glyph_runs {
        optional_features.push("fontResources");
        optional_features.push("text.glyphRun");
    }
    if has_glyph_outlines {
        optional_features.push("text.outlineGlyph");
    }
    set_value(
        &value,
        "optionalFeatures",
        string_array_to_value(&optional_features),
    );
    set_value(
        &value,
        "knownFeatures",
        string_array_to_value(&[
            "fontResources",
            "fontResources.blobFaceSplit",
            "text.variants",
            "text.paintOrderSlot",
            "text.strictVisualFallbackFree",
            "text.crossScopeVariants",
            "text.variantGroups",
            "text.variantOps",
            "text.shapeDiagnostics",
            "text.glyphRun",
            "text.outlineGlyph",
            "text.glyphOutline.monochromeFill",
            "text.glyphOutline.monochromeFillStroke",
            "text.glyphOutline.colorLayers",
            "text.glyphOutline.colorLayers.colrV0",
            "text.glyphOutline.colorLayers.colrV1",
            "text.glyphOutline.bitmapGlyph",
            "text.glyphOutline.svgGlyph",
            "text.specialVisualOps",
            "text.charOverlapOp",
            "text.controlMarkOp",
            "text.tabLeaderOp",
            "text.decorationOp",
            "text.displayText",
            "text.layout.shapedModern",
            "text.vertical.mixedPerGlyph",
        ]),
    );
    set_value(&value, "requiredFeatures", string_array_to_value(&[]));
    let text_contract = Object::new();
    set_string(&text_contract, "defaultVariant", "textRun");
    let mut variants = vec!["textRun"];
    if has_glyph_runs {
        variants.push("glyphRun");
    }
    if has_glyph_outlines {
        variants.push("glyphOutline");
    }
    set_value(&text_contract, "variants", string_array_to_value(&variants));
    set_string(&text_contract, "variantSelection", "exclusiveVariantSet");
    set_bool(&text_contract, "sourceTextPreserved", true);
    set_value(
        &text_contract,
        "clusterEncoding",
        string_array_to_value(&["utf8", "utf16"]),
    );
    set_bool(&text_contract, "fallbackRequired", true);
    set_string(
        &text_contract,
        "placementAuthority",
        "compatibilityProjection",
    );
    set_value(
        &text_contract,
        "externalizedVisuals",
        string_array_to_value(&externalized_visuals),
    );
    set_value(&value, "text", text_contract.into());
    let text_v2_contract = Object::new();
    set_string(&text_v2_contract, "profile", "compatibility");
    set_string(&text_v2_contract, "canonicalOp", "text");
    set_string(&text_v2_contract, "fallbackPolicy", "required");
    set_bool(&text_v2_contract, "strictVisualFallbackFree", false);
    set_string(&text_v2_contract, "paintOrderSlots", "reserved");
    set_value(&value, "textV2", text_v2_contract.into());

    let resources = Object::new();
    let images = Array::new();
    let image_hashes = Array::new();
    let image_keys = Array::new();
    for (id, bytes) in tree.resources.image_resources() {
        let digest = resource_digest_hex(bytes);
        let key = image_resource_key(bytes.len(), &digest);
        image_hashes.set(id.0 as u32, JsValue::from_str(&digest));
        image_keys.set(id.0 as u32, JsValue::from_str(&key));
        if !hints.known_image_keys.contains(&key) {
            images.set(id.0 as u32, Uint8Array::from(bytes).into());
        }
    }
    set_value(&resources, "images", images.into());
    set_value(&resources, "imageHashes", image_hashes.into());
    set_value(&resources, "imageKeys", image_keys.into());

    let svg_fragments = Array::new();
    let svg_hashes = Array::new();
    let svg_keys = Array::new();
    for (id, svg) in tree.resources.svg_resources() {
        let digest = resource_digest_hex(svg);
        let key = svg_resource_key(svg.len(), &digest);
        svg_hashes.set(id.0 as u32, JsValue::from_str(&digest));
        svg_keys.set(id.0 as u32, JsValue::from_str(&key));
        if !hints.known_svg_keys.contains(&key) {
            svg_fragments.set(id.0 as u32, JsValue::from_str(svg));
        }
    }
    set_value(&resources, "svgFragments", svg_fragments.into());
    set_value(&resources, "svgHashes", svg_hashes.into());
    set_value(&resources, "svgKeys", svg_keys.into());

    let font_blobs = Array::new();
    let font_blob_hashes = Array::new();
    let font_blob_keys = Array::new();
    for (id, bytes) in tree.resources.font_blob_resources() {
        let digest = resource_digest_hex(bytes);
        let key = font_blob_resource_key(bytes.len(), &digest);
        font_blob_hashes.set(id.0 as u32, JsValue::from_str(&digest));
        font_blob_keys.set(id.0 as u32, JsValue::from_str(&key));
        font_blobs.set(id.0 as u32, Uint8Array::from(bytes).into());
    }
    set_value(&resources, "fontBlobs", font_blobs.into());
    set_value(&resources, "fontBlobHashes", font_blob_hashes.into());
    set_value(&resources, "fontBlobKeys", font_blob_keys.into());
    set_value(&value, "resources", resources.into());
    value.into()
}

pub fn page_layer_tree_to_js_value_v2_compat(
    tree: &PageLayerTree,
) -> Result<JsValue, Vec<TextV2ValidationIssue>> {
    page_layer_tree_to_js_value_v2_compat_with_resource_hints(
        tree,
        &LayerResourceExportHints::default(),
    )
}

pub fn page_layer_tree_to_js_value_v2_compat_with_resource_hints(
    tree: &PageLayerTree,
    hints: &LayerResourceExportHints,
) -> Result<JsValue, Vec<TextV2ValidationIssue>> {
    let slots = tree.text_v2_slots();
    let issues = crate::paint::validate_text_v2_ops(&slots, &TextV2ValidationOptions::default());
    if !issues.is_empty() {
        return Err(issues);
    }

    let value = Object::from(page_layer_tree_to_js_value_with_resource_hints(tree, hints));
    set_number(&value, "schemaVersion", 2.0);
    set_number(&value, "schemaMinorVersion", 0.0);
    let schema = Object::new();
    set_number(&schema, "major", 2.0);
    set_number(&schema, "minor", 0.0);
    set_value(&value, "schema", schema.into());
    let mut text_source_state = TextSourceExportState::default();
    set_value(
        &value,
        "root",
        layer_node_to_value_v2_compat(&tree.root, &tree.variant_ops, &mut text_source_state),
    );
    let _ = Reflect::delete_property(&value, &JsValue::from_str("variantOps"));
    set_text_v2_compat_metadata(&value, &tree.root, &tree.variant_ops);
    Ok(value.into())
}

pub fn page_layer_tree_to_js_value_v2_strict_glyph_outline(
    tree: &PageLayerTree,
) -> Result<JsValue, Vec<TextV2ValidationIssue>> {
    page_layer_tree_to_js_value_v2_strict_glyph_outline_with_resource_hints(
        tree,
        &LayerResourceExportHints::default(),
    )
}

pub fn page_layer_tree_to_js_value_v2_strict_glyph_outline_with_resource_hints(
    tree: &PageLayerTree,
    hints: &LayerResourceExportHints,
) -> Result<JsValue, Vec<TextV2ValidationIssue>> {
    let compat_slots = tree.text_v2_slots();
    let strict_slots = crate::paint::strict_glyph_outline_text_v2_slots(&compat_slots)?;
    let strict_slots_by_group: HashMap<&str, &LayerTextPaintOpV2> = strict_slots
        .iter()
        .map(|slot| (slot.id.as_str(), slot))
        .collect();
    let mut issues = Vec::new();
    let mut stack = vec![&tree.root];
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

    let value = Object::from(page_layer_tree_to_js_value_with_resource_hints(tree, hints));
    set_number(&value, "schemaVersion", 2.0);
    set_number(&value, "schemaMinorVersion", 0.0);
    let schema = Object::new();
    set_number(&schema, "major", 2.0);
    set_number(&schema, "minor", 0.0);
    set_value(&value, "schema", schema.into());
    let mut text_source_state = TextSourceExportState::default();
    set_value(
        &value,
        "root",
        layer_node_to_value_v2_strict_text_variant(
            &tree.root,
            &strict_slots_by_group,
            &mut text_source_state,
        ),
    );
    let _ = Reflect::delete_property(&value, &JsValue::from_str("variantOps"));
    set_text_v2_strict_glyph_outline_metadata(&value, &tree.root);
    Ok(value.into())
}

pub fn page_layer_tree_to_js_value_v2_strict_glyph_run(
    tree: &PageLayerTree,
) -> Result<JsValue, Vec<TextV2ValidationIssue>> {
    page_layer_tree_to_js_value_v2_strict_glyph_run_with_resource_hints(
        tree,
        &LayerResourceExportHints::default(),
    )
}

pub fn page_layer_tree_to_js_value_v2_strict_glyph_run_with_resource_hints(
    tree: &PageLayerTree,
    hints: &LayerResourceExportHints,
) -> Result<JsValue, Vec<TextV2ValidationIssue>> {
    let compat_slots = tree.text_v2_slots();
    let strict_slots = crate::paint::strict_glyph_run_text_v2_slots(&compat_slots)?;
    let strict_slots_by_group: HashMap<&str, &LayerTextPaintOpV2> = strict_slots
        .iter()
        .map(|slot| (slot.id.as_str(), slot))
        .collect();
    let mut issues = Vec::new();
    let mut stack = vec![&tree.root];
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

    let value = Object::from(page_layer_tree_to_js_value_with_resource_hints(tree, hints));
    set_number(&value, "schemaVersion", 2.0);
    set_number(&value, "schemaMinorVersion", 0.0);
    let schema = Object::new();
    set_number(&schema, "major", 2.0);
    set_number(&schema, "minor", 0.0);
    set_value(&value, "schema", schema.into());
    let mut text_source_state = TextSourceExportState::default();
    set_value(
        &value,
        "root",
        layer_node_to_value_v2_strict_text_variant(
            &tree.root,
            &strict_slots_by_group,
            &mut text_source_state,
        ),
    );
    let _ = Reflect::delete_property(&value, &JsValue::from_str("variantOps"));
    set_text_v2_strict_glyph_run_metadata(&value, &tree.root);
    Ok(value.into())
}

pub fn text_v2_validation_issues_to_js_value(issues: &[TextV2ValidationIssue]) -> JsValue {
    array_to_value(issues.iter().map(text_v2_validation_issue_to_value))
}

fn text_v2_validation_issue_to_value(issue: &TextV2ValidationIssue) -> JsValue {
    let value = Object::new();
    set_string(&value, "code", issue.code.as_str());
    set_string(&value, "opId", &issue.op_id);
    if let Some(paint_order_slot_id) = &issue.paint_order_slot_id {
        set_string(&value, "paintOrderSlotId", paint_order_slot_id);
    }
    if let Some(variant_id) = &issue.variant_id {
        set_string(&value, "variantId", variant_id);
    }
    if let Some(part_index) = issue.part_index {
        set_number(&value, "partIndex", part_index as f64);
    }
    value.into()
}

fn string_set_from_js_value(value: &JsValue) -> HashSet<String> {
    if value.is_null() || value.is_undefined() {
        return HashSet::new();
    }

    Array::from(value)
        .iter()
        .filter_map(|item| item.as_string())
        .collect()
}

fn set_text_v2_compat_metadata(value: &Object, root: &LayerNode, variant_ops: &[PaintOp]) {
    let externalized_visuals = externalized_text_visuals(root);
    let has_variant_groups = has_text_variant_groups(root) || has_text_variant_ops(variant_ops);
    let has_glyph_runs = has_glyph_runs(root) || ops_have_glyph_runs(variant_ops);
    let has_glyph_outlines = has_glyph_outlines(root) || ops_have_glyph_outlines(variant_ops);
    let has_display_text = has_display_text(root) || ops_have_display_text(variant_ops);
    let mut used_features = vec![
        "text.paintStyle",
        "text.sourceTable",
        "text.sourceSpan",
        "text.variants",
        "text.paintOrderSlot",
        "text.v2.placement",
        "text.v2.clusters",
        "text.projectionKind",
        "text.legacyVisuals",
    ];
    if has_display_text {
        used_features.push("text.displayText");
    }
    if has_glyph_runs {
        used_features.push("fontResources");
        used_features.push("text.glyphRun");
    }
    if has_glyph_outlines {
        used_features.push("text.outlineGlyph");
    }
    if has_variant_groups {
        used_features.push("text.variantGroups");
    }
    if externalized_visuals
        .iter()
        .any(|visual| *visual == "charOverlap")
    {
        used_features.push("text.charOverlapOp");
    }
    if externalized_visuals
        .iter()
        .any(|visual| *visual == "controlMarks")
    {
        used_features.push("text.controlMarkOp");
    }
    if externalized_visuals
        .iter()
        .any(|visual| *visual == "tabLeaders")
    {
        used_features.push("text.tabLeaderOp");
    }
    if externalized_visuals
        .iter()
        .any(|visual| *visual == "decorations")
    {
        used_features.push("text.decorationOp");
    }
    set_value(value, "usedFeatures", string_array_to_value(&used_features));
    set_value(
        value,
        "requiredFeatures",
        string_array_to_value(&["text.variants", "text.paintOrderSlot"]),
    );

    let text_v2_contract = Object::new();
    set_string(&text_v2_contract, "profile", "compatibility");
    set_string(&text_v2_contract, "canonicalOp", "text");
    set_string(&text_v2_contract, "fallbackPolicy", "required");
    set_bool(&text_v2_contract, "strictVisualFallbackFree", false);
    set_string(&text_v2_contract, "paintOrderSlots", "required");
    set_value(value, "textV2", text_v2_contract.into());
}

fn set_text_v2_strict_glyph_outline_metadata(value: &Object, root: &LayerNode) {
    let externalized_visuals = externalized_text_visuals(root);
    let has_outline_stroke = has_supported_strict_glyph_outline_stroke(root);
    let has_colrv0_color_layers = has_supported_strict_glyph_outline_colrv0(root);
    let has_colrv1_color_layers = has_supported_strict_glyph_outline_colrv1(root);
    let has_bitmap_glyph = has_supported_strict_glyph_outline_bitmap(root);
    let has_svg_glyph = has_supported_strict_glyph_outline_svg(root);
    let mut used_features = vec![
        "text.paintStyle",
        "text.sourceTable",
        "text.sourceSpan",
        "text.variants",
        "text.paintOrderSlot",
        "text.strictVisualFallbackFree",
        "text.v2.placement",
        "text.v2.clusters",
        "text.projectionKind",
        "text.legacyVisuals",
        "text.outlineGlyph",
        "text.glyphOutline.monochromeFill",
    ];
    if has_outline_stroke {
        used_features.push("text.glyphOutline.monochromeFillStroke");
    }
    if has_colrv0_color_layers || has_colrv1_color_layers {
        used_features.push("text.glyphOutline.colorLayers");
    }
    if has_colrv0_color_layers {
        used_features.push("text.glyphOutline.colorLayers.colrV0");
    }
    if has_colrv1_color_layers {
        used_features.push("text.glyphOutline.colorLayers.colrV1");
    }
    if has_bitmap_glyph {
        used_features.push("text.glyphOutline.bitmapGlyph");
    }
    if has_svg_glyph {
        used_features.push("text.glyphOutline.svgGlyph");
    }
    if externalized_visuals
        .iter()
        .any(|visual| *visual == "charOverlap")
    {
        used_features.push("text.charOverlapOp");
    }
    if externalized_visuals
        .iter()
        .any(|visual| *visual == "controlMarks")
    {
        used_features.push("text.controlMarkOp");
    }
    if externalized_visuals
        .iter()
        .any(|visual| *visual == "tabLeaders")
    {
        used_features.push("text.tabLeaderOp");
    }
    if externalized_visuals
        .iter()
        .any(|visual| *visual == "decorations")
    {
        used_features.push("text.decorationOp");
    }
    set_value(value, "usedFeatures", string_array_to_value(&used_features));
    let mut required_features = vec![
        "text.variants",
        "text.paintOrderSlot",
        "text.strictVisualFallbackFree",
        "text.outlineGlyph",
        "text.glyphOutline.monochromeFill",
    ];
    if has_outline_stroke {
        required_features.push("text.glyphOutline.monochromeFillStroke");
    }
    if has_colrv0_color_layers || has_colrv1_color_layers {
        required_features.push("text.glyphOutline.colorLayers");
    }
    if has_colrv0_color_layers {
        required_features.push("text.glyphOutline.colorLayers.colrV0");
    }
    if has_colrv1_color_layers {
        required_features.push("text.glyphOutline.colorLayers.colrV1");
    }
    if has_bitmap_glyph {
        required_features.push("text.glyphOutline.bitmapGlyph");
    }
    if has_svg_glyph {
        required_features.push("text.glyphOutline.svgGlyph");
    }
    set_value(
        value,
        "requiredFeatures",
        string_array_to_value(&required_features),
    );
    let text_contract = Object::new();
    set_string(&text_contract, "defaultVariant", "glyphOutline");
    set_value(
        &text_contract,
        "variants",
        string_array_to_value(&["glyphOutline"]),
    );
    set_string(&text_contract, "variantSelection", "exclusiveVariantSet");
    set_bool(&text_contract, "sourceTextPreserved", true);
    set_value(
        &text_contract,
        "clusterEncoding",
        string_array_to_value(&["utf8", "utf16"]),
    );
    set_bool(&text_contract, "fallbackRequired", false);
    set_string(&text_contract, "placementAuthority", "strictVisual");
    set_value(
        &text_contract,
        "externalizedVisuals",
        string_array_to_value(&externalized_visuals),
    );
    set_value(value, "text", text_contract.into());

    let text_v2_contract = Object::new();
    set_string(&text_v2_contract, "profile", "strictVisual");
    set_string(&text_v2_contract, "canonicalOp", "text");
    set_string(&text_v2_contract, "fallbackPolicy", "none");
    set_bool(&text_v2_contract, "strictVisualFallbackFree", true);
    set_string(&text_v2_contract, "paintOrderSlots", "required");
    set_value(value, "textV2", text_v2_contract.into());
}

fn set_text_v2_strict_glyph_run_metadata(value: &Object, root: &LayerNode) {
    let externalized_visuals = externalized_text_visuals(root);
    let mut used_features = vec![
        "text.paintStyle",
        "text.sourceTable",
        "text.sourceSpan",
        "text.variants",
        "text.paintOrderSlot",
        "text.strictVisualFallbackFree",
        "text.v2.placement",
        "text.v2.clusters",
        "text.projectionKind",
        "text.legacyVisuals",
        "fontResources",
        "text.glyphRun",
    ];
    if externalized_visuals
        .iter()
        .any(|visual| *visual == "charOverlap")
    {
        used_features.push("text.charOverlapOp");
    }
    if externalized_visuals
        .iter()
        .any(|visual| *visual == "controlMarks")
    {
        used_features.push("text.controlMarkOp");
    }
    if externalized_visuals
        .iter()
        .any(|visual| *visual == "tabLeaders")
    {
        used_features.push("text.tabLeaderOp");
    }
    if externalized_visuals
        .iter()
        .any(|visual| *visual == "decorations")
    {
        used_features.push("text.decorationOp");
    }
    set_value(value, "usedFeatures", string_array_to_value(&used_features));
    set_value(
        value,
        "requiredFeatures",
        string_array_to_value(&[
            "text.variants",
            "text.paintOrderSlot",
            "text.strictVisualFallbackFree",
            "fontResources",
            "text.glyphRun",
        ]),
    );
    let text_contract = Object::new();
    set_string(&text_contract, "defaultVariant", "glyphRun");
    set_value(
        &text_contract,
        "variants",
        string_array_to_value(&["glyphRun"]),
    );
    set_string(&text_contract, "variantSelection", "exclusiveVariantSet");
    set_bool(&text_contract, "sourceTextPreserved", true);
    set_value(
        &text_contract,
        "clusterEncoding",
        string_array_to_value(&["utf8", "utf16"]),
    );
    set_bool(&text_contract, "fallbackRequired", false);
    set_string(&text_contract, "placementAuthority", "strictVisual");
    set_value(
        &text_contract,
        "externalizedVisuals",
        string_array_to_value(&externalized_visuals),
    );
    set_value(value, "text", text_contract.into());

    let text_v2_contract = Object::new();
    set_string(&text_v2_contract, "profile", "strictVisual");
    set_string(&text_v2_contract, "canonicalOp", "text");
    set_string(&text_v2_contract, "fallbackPolicy", "none");
    set_bool(&text_v2_contract, "strictVisualFallbackFree", true);
    set_string(&text_v2_contract, "paintOrderSlots", "required");
    set_value(value, "textV2", text_v2_contract.into());
}

fn set_debug_backend_capability(backends: &Object, name: &str, overlay_paint: bool) {
    let capability = Object::new();
    set_bool(&capability, "overlayPaint", overlay_paint);
    set_bool(&capability, "semanticBounds", true);
    set_value(backends, name, capability.into());
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

fn text_sources_to_value(table: &TextSourceTable) -> JsValue {
    let array = Array::new();
    for entry in &table.entries {
        array.push(&text_source_entry_to_value(entry));
    }
    array.into()
}

fn text_source_entry_to_value(entry: &TextSourceEntry) -> JsValue {
    let value = Object::new();
    set_number(&value, "id", entry.id.0 as f64);
    set_string(&value, "text", &entry.text);
    set_value(
        &value,
        "utf8Range",
        text_source_range_to_value(entry.utf8_range),
    );
    set_value(
        &value,
        "utf16Range",
        text_source_range_to_value(entry.utf16_range),
    );
    if let Some(stable_source_key) = &entry.stable_source_key {
        set_value(
            &value,
            "stableSourceKey",
            stable_source_key_to_value(stable_source_key),
        );
    }
    set_value(
        &value,
        "annotations",
        text_source_annotations_to_value(&entry.annotations),
    );
    value.into()
}

fn font_resources_to_value(table: &crate::paint::FontResourceTable) -> JsValue {
    let value = Object::new();
    let blobs = Array::new();
    for blob in &table.blobs {
        let blob_value = Object::new();
        set_string(&blob_value, "id", &blob.id.0);
        set_string(&blob_value, "source", blob.source.as_str());
        set_string(&blob_value, "portability", blob.portability.kind().as_str());
        if let Some(digest) = &blob.digest {
            let digest_value = Object::new();
            set_string(&digest_value, "algorithm", &digest.algorithm);
            set_string(&digest_value, "value", &digest.value);
            set_value(&blob_value, "digest", digest_value.into());
        }
        if let Some(data_ref) = &blob.data_ref {
            let data_ref_value = Object::new();
            set_string(&data_ref_value, "kind", data_ref.kind.as_str());
            set_string(&data_ref_value, "id", &data_ref.id);
            set_value(&blob_value, "dataRef", data_ref_value.into());
        }
        blobs.push(&blob_value);
    }
    set_value(&value, "blobs", blobs.into());

    let faces = Array::new();
    for face in &table.faces {
        let face_value = Object::new();
        set_string(&face_value, "id", &face.id.0);
        set_string(&face_value, "blobKey", &face.blob_key.0);
        set_number(&face_value, "faceIndex", face.face_index as f64);
        if let Some(postscript_name) = &face.postscript_name {
            set_string(&face_value, "postscriptName", postscript_name);
        }
        if !face.family_names.is_empty() {
            set_value(
                &face_value,
                "familyNames",
                localized_names_to_value(&face.family_names),
            );
        }
        if !face.style_names.is_empty() {
            set_value(
                &face_value,
                "styleNames",
                localized_names_to_value(&face.style_names),
            );
        }
        if let Some(weight_class) = face.weight_class {
            set_number(&face_value, "weightClass", weight_class as f64);
        }
        if let Some(width_class) = face.width_class {
            set_number(&face_value, "widthClass", width_class as f64);
        }
        if let Some(italic) = face.italic {
            set_bool(&face_value, "italic", italic);
        }
        faces.push(&face_value);
    }
    set_value(&value, "faces", faces.into());
    value.into()
}

fn localized_names_to_value(names: &[crate::paint::LocalizedName]) -> JsValue {
    let values = Array::new();
    for name in names {
        let value = Object::new();
        set_string(&value, "value", &name.value);
        if let Some(locale) = &name.locale {
            set_string(&value, "locale", locale);
        }
        values.push(&value);
    }
    values.into()
}

fn legacy_text_source_span_to_value(run: &crate::paint::LayerTextRunPaint, id: u32) -> JsValue {
    let value = Object::new();
    set_number(&value, "id", id as f64);
    set_value(
        &value,
        "utf8Range",
        text_source_range_to_value(TextSourceRange::new(0, run.text.len() as u32)),
    );
    set_value(
        &value,
        "utf16Range",
        text_source_range_to_value(TextSourceRange::new(
            0,
            run.text.encode_utf16().count() as u32,
        )),
    );
    value.into()
}

fn text_source_span_to_value(span: &TextSourceSpan) -> JsValue {
    let value = Object::new();
    set_number(&value, "id", span.id.0 as f64);
    set_value(
        &value,
        "utf8Range",
        text_source_range_to_value(span.utf8_range),
    );
    set_value(
        &value,
        "utf16Range",
        text_source_range_to_value(span.utf16_range),
    );
    if let Some(stable_source_key) = &span.stable_source_key {
        set_value(
            &value,
            "stableSourceKey",
            stable_source_key_to_value(stable_source_key),
        );
    }
    value.into()
}

fn text_source_range_to_value(range: TextSourceRange) -> JsValue {
    let value = Object::new();
    set_number(&value, "start", range.start as f64);
    set_number(&value, "end", range.end as f64);
    value.into()
}

fn stable_source_key_to_value(stable_source_key: &str) -> JsValue {
    let value = Object::new();
    set_string(&value, "scheme", stable_source_key);
    value.into()
}

fn text_source_annotations_to_value(source_annotations: &[TextSourceAnnotation]) -> JsValue {
    let annotations = Array::new();
    for source_annotation in source_annotations {
        let annotation = Object::new();
        match source_annotation {
            TextSourceAnnotation::FieldMarker {
                marker,
                range_utf8,
                range_utf16,
            } => {
                set_string(&annotation, "kind", "fieldMarker");
                set_string(&annotation, "marker", field_marker_str(*marker));
                set_value(
                    &annotation,
                    "rangeUtf8",
                    text_source_range_to_value(*range_utf8),
                );
                set_value(
                    &annotation,
                    "rangeUtf16",
                    text_source_range_to_value(*range_utf16),
                );
                if let FieldMarkerType::ShapeMarker(index) = marker {
                    set_number(&annotation, "shapeMarkerIndex", *index as f64);
                }
            }
            TextSourceAnnotation::ParagraphEnd {
                offset_utf8,
                offset_utf16,
            } => {
                set_string(&annotation, "kind", "paragraphEnd");
                set_number(&annotation, "offsetUtf8", *offset_utf8 as f64);
                set_number(&annotation, "offsetUtf16", *offset_utf16 as f64);
            }
            TextSourceAnnotation::LineBreakEnd {
                offset_utf8,
                offset_utf16,
            } => {
                set_string(&annotation, "kind", "lineBreakEnd");
                set_number(&annotation, "offsetUtf8", *offset_utf8 as f64);
                set_number(&annotation, "offsetUtf16", *offset_utf16 as f64);
            }
        }
        annotations.push(&annotation);
    }
    annotations.into()
}

fn layer_node_to_value(node: &LayerNode, text_sources: &mut TextSourceExportState) -> JsValue {
    let value = Object::new();
    set_value(&value, "bounds", bbox_to_value(node.bounds));
    if let Some(source_node_id) = node.source_node_id {
        set_number(&value, "sourceNodeId", source_node_id as f64);
    }
    if node.semantic != LayerSemantic::default() {
        let semantic = Object::new();
        set_string(&semantic, "role", node.semantic.role.as_str());
        if let Some(section_index) = node.semantic.section_index {
            set_number(&semantic, "sectionIndex", section_index as f64);
        }
        if let Some(column_index) = node.semantic.column_index {
            set_number(&semantic, "columnIndex", column_index as f64);
        }
        if let Some(para_index) = node.semantic.para_index {
            set_number(&semantic, "paraIndex", para_index as f64);
        }
        if let Some(control_index) = node.semantic.control_index {
            set_number(&semantic, "controlIndex", control_index as f64);
        }
        if let Some(row_count) = node.semantic.row_count {
            set_number(&semantic, "rowCount", row_count as f64);
        }
        if let Some(col_count) = node.semantic.col_count {
            set_number(&semantic, "colCount", col_count as f64);
        }
        set_value(&value, "semantic", semantic.into());
    }

    match &node.kind {
        LayerNodeKind::Group {
            children,
            cache_hint,
        } => {
            set_string(&value, "kind", "group");
            set_string(&value, "cacheHint", cache_hint_str(*cache_hint));
            set_value(
                &value,
                "children",
                layer_nodes_to_value(children, text_sources),
            );
        }
        LayerNodeKind::ClipRect {
            clip,
            child,
            clip_kind,
            clip_policy,
        } => {
            set_string(&value, "kind", "clipRect");
            set_value(&value, "clip", bbox_to_value(*clip));
            set_string(&value, "clipKind", clip_kind_str(*clip_kind));
            let policy = Object::new();
            set_number(
                &policy,
                "rightOverflowSlop",
                clip_policy.right_overflow_slop,
            );
            set_bool(
                &policy,
                "allowHorizontalOverflowControls",
                clip_policy.allow_horizontal_overflow_controls,
            );
            set_value(&value, "clipPolicy", policy.into());
            set_value(&value, "child", layer_node_to_value(child, text_sources));
        }
        LayerNodeKind::Leaf { ops, cache_hint } => {
            set_string(&value, "kind", "leaf");
            set_string(&value, "cacheHint", cache_hint_str(*cache_hint));
            set_value(&value, "ops", paint_ops_to_value(ops, text_sources));
        }
    }

    value.into()
}

fn layer_nodes_to_value(
    children: &[LayerNode],
    text_sources: &mut TextSourceExportState,
) -> JsValue {
    let array = Array::new();
    for child in children {
        array.push(&layer_node_to_value(child, text_sources));
    }
    array.into()
}

fn layer_node_to_value_v2_compat(
    node: &LayerNode,
    variant_ops: &[PaintOp],
    text_sources: &mut TextSourceExportState,
) -> JsValue {
    let value = Object::new();
    set_value(&value, "bounds", bbox_to_value(node.bounds));
    if let Some(source_node_id) = node.source_node_id {
        set_number(&value, "sourceNodeId", source_node_id as f64);
    }
    if node.semantic != LayerSemantic::default() {
        let semantic = Object::new();
        set_string(&semantic, "role", node.semantic.role.as_str());
        if let Some(section_index) = node.semantic.section_index {
            set_number(&semantic, "sectionIndex", section_index as f64);
        }
        if let Some(column_index) = node.semantic.column_index {
            set_number(&semantic, "columnIndex", column_index as f64);
        }
        if let Some(para_index) = node.semantic.para_index {
            set_number(&semantic, "paraIndex", para_index as f64);
        }
        if let Some(control_index) = node.semantic.control_index {
            set_number(&semantic, "controlIndex", control_index as f64);
        }
        if let Some(row_count) = node.semantic.row_count {
            set_number(&semantic, "rowCount", row_count as f64);
        }
        if let Some(col_count) = node.semantic.col_count {
            set_number(&semantic, "colCount", col_count as f64);
        }
        set_value(&value, "semantic", semantic.into());
    }

    match &node.kind {
        LayerNodeKind::Group {
            children,
            cache_hint,
        } => {
            set_string(&value, "kind", "group");
            set_string(&value, "cacheHint", cache_hint_str(*cache_hint));
            set_value(
                &value,
                "children",
                layer_nodes_to_value_v2_compat(children, variant_ops, text_sources),
            );
        }
        LayerNodeKind::ClipRect {
            clip,
            child,
            clip_kind,
            clip_policy,
        } => {
            set_string(&value, "kind", "clipRect");
            set_value(&value, "clip", bbox_to_value(*clip));
            set_string(&value, "clipKind", clip_kind_str(*clip_kind));
            let policy = Object::new();
            set_number(
                &policy,
                "rightOverflowSlop",
                clip_policy.right_overflow_slop,
            );
            set_bool(
                &policy,
                "allowHorizontalOverflowControls",
                clip_policy.allow_horizontal_overflow_controls,
            );
            set_value(&value, "clipPolicy", policy.into());
            set_value(
                &value,
                "child",
                layer_node_to_value_v2_compat(child, variant_ops, text_sources),
            );
        }
        LayerNodeKind::Leaf { ops, cache_hint } => {
            set_string(&value, "kind", "leaf");
            set_string(&value, "cacheHint", cache_hint_str(*cache_hint));
            let sidecars = crate::paint::sidecars_for_leaf_ops(ops, variant_ops);
            set_value(
                &value,
                "ops",
                paint_ops_to_value_v2_compat(ops, &sidecars, text_sources),
            );
        }
    }

    value.into()
}

fn layer_nodes_to_value_v2_compat(
    children: &[LayerNode],
    variant_ops: &[PaintOp],
    text_sources: &mut TextSourceExportState,
) -> JsValue {
    let array = Array::new();
    for child in children {
        array.push(&layer_node_to_value_v2_compat(
            child,
            variant_ops,
            text_sources,
        ));
    }
    array.into()
}

fn layer_node_to_value_v2_strict_text_variant(
    node: &LayerNode,
    strict_slots_by_group: &HashMap<&str, &LayerTextPaintOpV2>,
    text_sources: &mut TextSourceExportState,
) -> JsValue {
    let value = Object::new();
    set_value(&value, "bounds", bbox_to_value(node.bounds));
    if let Some(source_node_id) = node.source_node_id {
        set_number(&value, "sourceNodeId", source_node_id as f64);
    }
    if node.semantic != LayerSemantic::default() {
        let semantic = Object::new();
        set_string(&semantic, "role", node.semantic.role.as_str());
        if let Some(section_index) = node.semantic.section_index {
            set_number(&semantic, "sectionIndex", section_index as f64);
        }
        if let Some(column_index) = node.semantic.column_index {
            set_number(&semantic, "columnIndex", column_index as f64);
        }
        if let Some(para_index) = node.semantic.para_index {
            set_number(&semantic, "paraIndex", para_index as f64);
        }
        if let Some(control_index) = node.semantic.control_index {
            set_number(&semantic, "controlIndex", control_index as f64);
        }
        if let Some(row_count) = node.semantic.row_count {
            set_number(&semantic, "rowCount", row_count as f64);
        }
        if let Some(col_count) = node.semantic.col_count {
            set_number(&semantic, "colCount", col_count as f64);
        }
        set_value(&value, "semantic", semantic.into());
    }
    match &node.kind {
        LayerNodeKind::Group {
            children,
            cache_hint,
        } => {
            set_string(&value, "kind", "group");
            set_string(&value, "cacheHint", cache_hint_str(*cache_hint));
            set_value(
                &value,
                "children",
                array_to_value(children.iter().map(|child| {
                    layer_node_to_value_v2_strict_text_variant(
                        child,
                        strict_slots_by_group,
                        text_sources,
                    )
                })),
            );
        }
        LayerNodeKind::ClipRect {
            clip,
            child,
            clip_kind,
            clip_policy,
        } => {
            set_string(&value, "kind", "clipRect");
            set_value(&value, "clip", bbox_to_value(*clip));
            set_string(&value, "clipKind", clip_kind_str(*clip_kind));
            let policy = Object::new();
            set_number(
                &policy,
                "rightOverflowSlop",
                clip_policy.right_overflow_slop,
            );
            set_bool(
                &policy,
                "allowHorizontalOverflowControls",
                clip_policy.allow_horizontal_overflow_controls,
            );
            set_value(&value, "clipPolicy", policy.into());
            set_value(
                &value,
                "child",
                layer_node_to_value_v2_strict_text_variant(
                    child,
                    strict_slots_by_group,
                    text_sources,
                ),
            );
        }
        LayerNodeKind::Leaf { ops, cache_hint } => {
            set_string(&value, "kind", "leaf");
            set_string(&value, "cacheHint", cache_hint_str(*cache_hint));
            set_value(
                &value,
                "ops",
                paint_ops_to_value_v2_strict_text_variant(ops, strict_slots_by_group, text_sources),
            );
        }
    }
    value.into()
}

fn paint_ops_to_value(ops: &[PaintOp], text_sources: &mut TextSourceExportState) -> JsValue {
    let array = Array::new();
    for op in ops {
        array.push(&paint_op_to_value(op, text_sources));
    }
    array.into()
}

fn paint_ops_to_value_v2_compat(
    ops: &[PaintOp],
    sidecar_ops: &[PaintOp],
    text_sources: &mut TextSourceExportState,
) -> JsValue {
    let text_slots =
        crate::paint::lower_v1_leaf_text_variants_with_sidecars_to_v2(ops, sidecar_ops);
    let text_slots_by_group: HashMap<&str, &LayerTextPaintOpV2> = text_slots
        .iter()
        .map(|slot| (slot.id.as_str(), slot))
        .collect();
    let mut written_groups = HashSet::<String>::new();
    let array = Array::new();

    for op in ops {
        if let Some(group_id) = text_v2_variant_group_id(op) {
            if let Some(text_slot) = text_slots_by_group.get(group_id) {
                if written_groups.insert(group_id.to_string()) {
                    array.push(&text_op_v2_to_value(text_slot, text_sources));
                }
                continue;
            }
        }

        array.push(&paint_op_to_value(op, text_sources));
    }

    array.into()
}

fn paint_ops_to_value_v2_strict_text_variant(
    ops: &[PaintOp],
    strict_slots_by_group: &HashMap<&str, &LayerTextPaintOpV2>,
    text_sources: &mut TextSourceExportState,
) -> JsValue {
    let mut written_groups = HashSet::<String>::new();
    let array = Array::new();

    for op in ops {
        if let Some(group_id) = text_v2_variant_group_id(op) {
            if let Some(text_slot) = strict_slots_by_group.get(group_id) {
                if written_groups.insert(group_id.to_string()) {
                    array.push(&text_op_v2_to_value(text_slot, text_sources));
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

        array.push(&paint_op_to_value(op, text_sources));
    }

    array.into()
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

fn text_op_v2_to_value(
    text_op: &LayerTextPaintOpV2,
    text_sources: &mut TextSourceExportState,
) -> JsValue {
    let value = Object::new();
    set_string(&value, "id", &text_op.id);
    set_string(&value, "type", "text");
    set_value(&value, "bbox", bbox_to_value(text_op.bbox));
    set_string(&value, "paintOrderSlotId", &text_op.paint_order_slot_id);
    set_string(&value, "selectionPolicy", "exclusiveVariantSet");
    set_string(
        &value,
        "defaultVariantId",
        text_op.default_variant_id.as_deref().unwrap_or("textRun"),
    );
    set_string(&value, "fallbackPolicy", text_op.fallback_policy.as_str());
    set_value(
        &value,
        "variants",
        array_to_value(
            text_op
                .variants
                .iter()
                .map(|variant| text_variant_set_v2_to_value(variant, text_sources)),
        ),
    );
    value.into()
}

fn text_variant_set_v2_to_value(
    variant: &LayerTextVariantSet,
    text_sources: &mut TextSourceExportState,
) -> JsValue {
    let value = Object::new();
    set_string(&value, "variantId", &variant.variant_id);
    set_string(&value, "kind", variant.kind.as_str());
    if !variant.required_features.is_empty() {
        set_value(
            &value,
            "requiredFeatures",
            array_to_value(
                variant
                    .required_features
                    .iter()
                    .map(|feature| JsValue::from_str(feature)),
            ),
        );
    }
    if let Some(quality) = variant.quality {
        set_string(&value, "quality", quality.as_str());
    }
    set_value(
        &value,
        "parts",
        array_to_value(
            variant
                .parts
                .iter()
                .map(|part| text_variant_part_v2_to_value(part, text_sources)),
        ),
    );
    value.into()
}

fn text_variant_part_v2_to_value(
    part: &LayerTextVariantPart,
    text_sources: &mut TextSourceExportState,
) -> JsValue {
    let value = Object::new();
    set_number(&value, "partIndex", part.part_index as f64);
    set_number(&value, "partCount", part.part_count as f64);
    if let Some(local_paint_order) = part.local_paint_order {
        set_number(&value, "localPaintOrder", local_paint_order as f64);
    }
    if let Some(scope_ref) = &part.scope_ref {
        set_string(&value, "scopeRef", scope_ref);
    }
    set_value(
        &value,
        "payload",
        text_variant_payload_v2_to_value(part, text_sources),
    );
    value.into()
}

fn text_variant_payload_v2_to_value(
    part: &LayerTextVariantPart,
    text_sources: &mut TextSourceExportState,
) -> JsValue {
    match &part.payload {
        LayerTextVariantPayload::TextRun(run) => paint_op_to_value(
            &PaintOp::TextRun {
                bbox: part.bbox,
                run: run.clone(),
            },
            text_sources,
        ),
        LayerTextVariantPayload::GlyphRun(run) => paint_op_to_value(
            &PaintOp::GlyphRun {
                bbox: part.bbox,
                run: run.clone(),
            },
            text_sources,
        ),
        LayerTextVariantPayload::GlyphOutline(outline) => paint_op_to_value(
            &PaintOp::GlyphOutline {
                bbox: part.bbox,
                outline: outline.clone(),
            },
            text_sources,
        ),
    }
}

fn paint_op_to_value(op: &PaintOp, text_sources: &mut TextSourceExportState) -> JsValue {
    let value = Object::new();
    match op {
        PaintOp::PageBackground { bbox, background } => {
            set_string(&value, "type", "pageBackground");
            set_value(&value, "bbox", bbox_to_value(*bbox));
            if let Some(color) = background.background_color {
                set_string(&value, "backgroundColor", &color_ref_to_css(color));
            }
            if let Some(color) = background.border_color {
                set_string(&value, "borderColor", &color_ref_to_css(color));
            }
            set_number(&value, "borderWidth", background.border_width);
            if let Some(gradient) = &background.gradient {
                set_value(&value, "gradient", gradient_to_value(gradient));
            }
            if let Some(image) = &background.image {
                let image_value = Object::new();
                set_number(&image_value, "resourceId", image.resource_id.0 as f64);
                set_string(
                    &image_value,
                    "fillMode",
                    image_fill_mode_str(image.fill_mode),
                );
                if image.brightness != 0 {
                    set_number(&image_value, "brightness", image.brightness as f64);
                }
                if image.contrast != 0 {
                    set_number(&image_value, "contrast", image.contrast as f64);
                }
                set_string(&image_value, "effect", image_effect_str(image.effect));
                set_value(&value, "image", image_value.into());
            }
        }
        PaintOp::TextRun { bbox, run } => {
            if let Some(variant) = &run.variant {
                set_string(&value, "id", &variant.stable_op_id());
            }
            set_string(&value, "type", "textRun");
            set_value(&value, "bbox", bbox_to_value(*bbox));
            set_string(&value, "text", &run.text);
            let display_text = display_text_for_text_run(run);
            if let Some(display_text) = &display_text {
                set_string(&value, "displayText", display_text);
            }
            set_number(&value, "baseline", run.baseline);
            set_number(&value, "rotation", run.rotation);
            set_bool(&value, "isVertical", run.is_vertical);
            set_string(&value, "orientation", run.orientation.as_str());
            set_string(&value, "projectionKind", run.projection.as_str());
            set_string(&value, "clusterBasis", run.cluster_basis.as_str());
            if let Some(placement) = run.placement {
                set_value(&value, "placement", text_run_placement_to_value(placement));
            }
            if !run.clusters.is_empty() {
                set_value(&value, "clusters", text_clusters_to_value(&run.clusters));
            }
            set_value(
                &value,
                "source",
                run.source.as_ref().map_or_else(
                    || legacy_text_source_span_to_value(run, text_sources.next_id()),
                    text_source_span_to_value,
                ),
            );
            if let Some(variant) = &run.variant {
                set_value(&value, "variant", paint_variant_meta_to_value(variant));
            }
            set_value(&value, "style", text_style_to_value(&run.style));
            set_value(
                &value,
                "paintStyle",
                paint_text_style_to_value(&PaintTextStyle::from(&run.style)),
            );
            if let Some(legacy_visuals) = text_legacy_visuals_to_value(run) {
                set_value(&value, "legacyVisuals", legacy_visuals);
            }
            set_value(
                &value,
                "positions",
                array_to_value(run.positions.iter().copied().map(JsValue::from_f64)),
            );
            if let Some(display_text) = &display_text {
                let positions = if display_text.is_empty() {
                    Vec::new()
                } else {
                    compute_char_positions(display_text, &run.style)
                };
                set_value(
                    &value,
                    "displayPositions",
                    array_to_value(positions.into_iter().map(JsValue::from_f64)),
                );
            }
            if !run.control_marks.is_empty() {
                set_value(&value, "controlMarks", text_control_marks_to_value(run));
            }
            if let Some(overlap) = &run.char_overlap {
                set_value(&value, "charOverlap", char_overlap_to_value(overlap));
            }
            set_string(&value, "fieldMarker", field_marker_str(run.field_marker));
            set_bool(&value, "isParaEnd", run.is_para_end);
            set_bool(&value, "isLineBreakEnd", run.is_line_break_end);
            if let FieldMarkerType::ShapeMarker(index) = run.field_marker {
                set_number(&value, "shapeMarkerIndex", index as f64);
            }
            if !run.style.tab_leaders.is_empty() {
                set_value(
                    &value,
                    "tabLeaders",
                    tab_leaders_to_value(&run.style.tab_leaders),
                );
            }
        }
        PaintOp::GlyphRun { bbox, run } => {
            set_string(&value, "id", &run.variant.stable_op_id());
            set_string(&value, "type", "glyphRun");
            set_value(&value, "bbox", bbox_to_value(*bbox));
            set_value(&value, "source", text_source_span_to_value(&run.source));
            set_value(&value, "variant", paint_variant_meta_to_value(&run.variant));
            set_value(
                &value,
                "paintStyle",
                paint_text_style_to_value(&run.paint_style),
            );
            set_value(&value, "shapeKey", shape_key_to_value(&run.shape_key));
            set_value(
                &value,
                "placement",
                text_run_placement_to_value(run.placement),
            );
            set_value(
                &value,
                "glyphIds",
                array_to_value(run.glyph_ids.iter().map(|id| JsValue::from_f64(*id as f64))),
            );
            set_value(&value, "positions", points_to_value(&run.positions));
            if let Some(advances) = &run.advances {
                set_value(&value, "advances", vectors_to_value(advances));
            }
            set_value(&value, "clusters", glyph_clusters_to_value(&run.clusters));
            set_string(&value, "direction", run.direction.as_str());
            if let Some(bidi_level) = run.bidi_level {
                set_number(&value, "bidiLevel", bidi_level as f64);
            }
            set_string(&value, "writingMode", run.writing_mode.as_str());
            set_string(&value, "orientation", run.orientation.as_str());
            if let Some(transforms) = &run.glyph_transforms {
                set_value(
                    &value,
                    "glyphTransforms",
                    glyph_transforms_to_value(transforms),
                );
            }
            set_value(
                &value,
                "diagnostics",
                glyph_run_diagnostics_to_value(&run.diagnostics),
            );
        }
        PaintOp::GlyphOutline { bbox, outline } => {
            set_string(&value, "id", &outline.variant.stable_op_id());
            set_string(&value, "type", "glyphOutline");
            set_value(&value, "bbox", bbox_to_value(*bbox));
            set_value(&value, "source", text_source_span_to_value(&outline.source));
            set_value(
                &value,
                "variant",
                paint_variant_meta_to_value(&outline.variant),
            );
            set_string(&value, "payloadKind", outline.payload_kind.as_str());
            if let Some(stroke) = &outline.stroke {
                set_value(
                    &value,
                    "stroke",
                    glyph_outline_stroke_style_to_value(stroke),
                );
            }
            if let Some(color_layers) = &outline.color_layers {
                set_value(
                    &value,
                    "colorLayers",
                    glyph_outline_color_layers_payload_to_value(color_layers),
                );
            }
            if let Some(bitmap_glyph) = &outline.bitmap_glyph {
                set_value(
                    &value,
                    "bitmapGlyph",
                    glyph_outline_bitmap_glyph_payload_to_value(bitmap_glyph),
                );
            }
            if let Some(svg_glyph) = &outline.svg_glyph {
                set_value(
                    &value,
                    "svgGlyph",
                    glyph_outline_svg_glyph_payload_to_value(svg_glyph),
                );
            }
            set_value(
                &value,
                "paintStyle",
                paint_text_style_to_value(&outline.paint_style),
            );
            set_value(
                &value,
                "placement",
                text_run_placement_to_value(outline.placement),
            );
            set_value(
                &value,
                "paths",
                array_to_value(outline.paths.iter().map(|path| {
                    let path_value = Object::new();
                    set_number(&path_value, "glyphId", path.glyph_id as f64);
                    set_value(
                        &path_value,
                        "sourceRangeUtf8",
                        text_source_range_to_value(path.source_range_utf8),
                    );
                    let glyph_range = Object::new();
                    set_number(&glyph_range, "start", path.glyph_range.start as f64);
                    set_number(&glyph_range, "end", path.glyph_range.end as f64);
                    set_value(&path_value, "glyphRange", glyph_range.into());
                    set_value(
                        &path_value,
                        "commands",
                        path_commands_to_value(&path.commands),
                    );
                    set_string(&path_value, "fillRule", path.fill_rule.as_str());
                    path_value.into()
                })),
            );
            set_value(
                &value,
                "diagnostics",
                glyph_run_diagnostics_to_value(&outline.diagnostics),
            );
        }
        PaintOp::CharOverlap { bbox, overlap } => {
            set_string(&value, "type", "charOverlap");
            set_value(&value, "bbox", bbox_to_value(*bbox));
            set_string(&value, "text", &overlap.text);
            set_number(&value, "baseline", overlap.baseline);
            set_number(&value, "rotation", overlap.rotation);
            set_bool(&value, "isVertical", overlap.is_vertical);
            set_string(&value, "orientation", overlap.orientation.as_str());
            if let Some(source) = &overlap.source {
                set_value(&value, "source", text_source_span_to_value(source));
            }
            if let Some(variant) = &overlap.variant {
                set_value(&value, "variant", paint_variant_meta_to_value(variant));
            }
            set_value(&value, "style", text_style_to_value(&overlap.style));
            set_value(
                &value,
                "paintStyle",
                paint_text_style_to_value(&PaintTextStyle::from(&overlap.style)),
            );
            set_value(
                &value,
                "positions",
                array_to_value(overlap.positions.iter().copied().map(JsValue::from_f64)),
            );
            set_value(
                &value,
                "charOverlap",
                char_overlap_to_value(&overlap.overlap),
            );
        }
        PaintOp::TextControlMark { bbox, mark } => {
            set_string(&value, "type", "textControlMark");
            set_value(&value, "bbox", bbox_to_value(*bbox));
            if let Some(source) = &mark.source {
                set_value(&value, "source", text_source_span_to_value(source));
            }
            set_value(&value, "mark", text_control_mark_to_value(&mark.mark));
        }
        PaintOp::TabLeader { bbox, leader } => {
            set_string(&value, "type", "tabLeader");
            set_value(&value, "bbox", bbox_to_value(*bbox));
            if let Some(source) = &leader.source {
                set_value(&value, "source", text_source_span_to_value(source));
            }
            set_value(&value, "leader", tab_leader_to_value(&leader.leader));
            set_string(&value, "color", &color_ref_to_css(leader.color));
            set_number(&value, "fontSize", leader.font_size);
            set_number(&value, "baseline", leader.baseline);
        }
        PaintOp::TextDecoration { bbox, decoration } => {
            set_string(&value, "type", "textDecoration");
            set_value(&value, "bbox", bbox_to_value(*bbox));
            if let Some(source) = &decoration.source {
                set_value(&value, "source", text_source_span_to_value(source));
            }
            set_value(&value, "decoration", text_decoration_to_value(decoration));
        }
        PaintOp::FootnoteMarker { bbox, marker } => {
            set_string(&value, "type", "footnoteMarker");
            set_value(&value, "bbox", bbox_to_value(*bbox));
            set_string(&value, "text", &marker.text);
            set_string(&value, "fontFamily", &marker.font_family);
            set_number(&value, "fontSize", (marker.base_font_size * 0.55).max(7.0));
            set_string(&value, "color", &color_ref_to_css(marker.color));
        }
        PaintOp::Line { bbox, line } => {
            set_string(&value, "type", "line");
            set_value(&value, "bbox", bbox_to_value(*bbox));
            set_number(&value, "x1", line.x1);
            set_number(&value, "y1", line.y1);
            set_number(&value, "x2", line.x2);
            set_number(&value, "y2", line.y2);
            set_value(&value, "style", line_style_to_value(&line.style));
            set_value(&value, "transform", transform_to_value(line.transform));
        }
        PaintOp::Rectangle { bbox, rect } => {
            set_string(&value, "type", "rectangle");
            set_value(&value, "bbox", bbox_to_value(*bbox));
            set_number(&value, "cornerRadius", rect.corner_radius);
            set_value(&value, "style", shape_style_to_value(&rect.style));
            if let Some(gradient) = &rect.gradient {
                set_value(&value, "gradient", gradient_to_value(gradient));
            }
            set_value(&value, "transform", transform_to_value(rect.transform));
        }
        PaintOp::Ellipse { bbox, ellipse } => {
            set_string(&value, "type", "ellipse");
            set_value(&value, "bbox", bbox_to_value(*bbox));
            set_value(&value, "style", shape_style_to_value(&ellipse.style));
            if let Some(gradient) = &ellipse.gradient {
                set_value(&value, "gradient", gradient_to_value(gradient));
            }
            set_value(&value, "transform", transform_to_value(ellipse.transform));
        }
        PaintOp::Path { bbox, path } => {
            set_string(&value, "type", "path");
            set_value(&value, "bbox", bbox_to_value(*bbox));
            set_value(&value, "commands", path_commands_to_value(&path.commands));
            set_value(&value, "style", shape_style_to_value(&path.style));
            if let Some(gradient) = &path.gradient {
                set_value(&value, "gradient", gradient_to_value(gradient));
            }
            if let Some((x1, y1, x2, y2)) = path.connector_endpoints {
                let connector = Object::new();
                set_number(&connector, "x1", x1);
                set_number(&connector, "y1", y1);
                set_number(&connector, "x2", x2);
                set_number(&connector, "y2", y2);
                set_value(&value, "connectorEndpoints", connector.into());
            }
            if let Some(line_style) = &path.line_style {
                set_value(&value, "lineStyle", line_style_to_value(line_style));
            }
            set_value(&value, "transform", transform_to_value(path.transform));
        }
        PaintOp::Image { bbox, image } => {
            set_string(&value, "type", "image");
            set_value(&value, "bbox", bbox_to_value(*bbox));
            if let Some(resource_id) = image.resource_id {
                set_number(&value, "resourceId", resource_id.0 as f64);
            }
            if let Some(external_path) = &image.external_path {
                set_string(&value, "externalPath", external_path);
            }
            if let Some(fill_mode) = image.fill_mode {
                set_string(&value, "fillMode", image_fill_mode_str(fill_mode));
            }
            if let Some(text_wrap) = image.text_wrap {
                set_string(&value, "wrap", text_wrap_str(text_wrap));
            }
            if let Some((width, height)) = image.original_size {
                let original_size = Object::new();
                set_number(&original_size, "width", width);
                set_number(&original_size, "height", height);
                set_value(&value, "originalSize", original_size.into());
            }
            if let Some((left, top, right, bottom)) = image.crop {
                let crop = Object::new();
                set_number(&crop, "left", left as f64);
                set_number(&crop, "top", top as f64);
                set_number(&crop, "right", right as f64);
                set_number(&crop, "bottom", bottom as f64);
                set_value(&value, "crop", crop.into());
            }
            if let Some((width, height)) = image.original_size_hu {
                let original_size_hu = Array::new();
                original_size_hu.push(&JsValue::from_f64(width as f64));
                original_size_hu.push(&JsValue::from_f64(height as f64));
                set_value(&value, "originalSizeHu", original_size_hu.into());
            }
            if image.brightness != 0 {
                set_number(&value, "brightness", image.brightness as f64);
            }
            if image.contrast != 0 {
                set_number(&value, "contrast", image.contrast as f64);
            }
            set_string(&value, "effect", image_effect_str(image.effect));
            set_value(&value, "transform", transform_to_value(image.transform));
        }
        PaintOp::Equation { bbox, equation } => {
            set_string(&value, "type", "equation");
            set_value(&value, "bbox", bbox_to_value(*bbox));
            set_string(&value, "color", &equation.color_str);
            set_number(&value, "fontSize", equation.font_size);
            set_number(&value, "svgResourceId", equation.svg_resource_id.0 as f64);
            set_value(
                &value,
                "layoutBox",
                equation_layout_box_to_value(&equation.layout_box),
            );
        }
        PaintOp::FormObject { bbox, form } => {
            set_string(&value, "type", "formObject");
            set_value(&value, "bbox", bbox_to_value(*bbox));
            set_string(&value, "formType", form_type_str(form.form_type));
            set_string(&value, "caption", &form.caption);
            set_string(&value, "text", &form.text);
            set_string(&value, "foreColor", &form.fore_color);
            set_string(&value, "backColor", &form.back_color);
            set_number(&value, "value", form.value as f64);
            set_bool(&value, "enabled", form.enabled);
        }
    }
    value.into()
}

fn bbox_to_value(bbox: BoundingBox) -> JsValue {
    let value = Object::new();
    set_number(&value, "x", bbox.x);
    set_number(&value, "y", bbox.y);
    set_number(&value, "width", bbox.width);
    set_number(&value, "height", bbox.height);
    value.into()
}

fn text_style_to_value(style: &TextStyle) -> JsValue {
    paint_text_style_to_value(&PaintTextStyle::from(style))
}

fn paint_text_style_to_value(style: &PaintTextStyle) -> JsValue {
    let value = Object::new();
    set_string(&value, "fontFamily", &style.font_family);
    set_number(&value, "fontSize", style.font_size);
    set_string(&value, "color", &color_ref_to_css(style.color));
    set_bool(&value, "bold", style.bold);
    set_bool(&value, "italic", style.italic);
    set_number(&value, "ratio", style.ratio);
    if !style.tab_leaders.is_empty() {
        set_value(
            &value,
            "tabLeaders",
            tab_leaders_to_value(&style.tab_leaders),
        );
    }
    set_string(&value, "underline", underline_type_str(style.underline));
    set_number(&value, "underlineShape", style.underline_shape as f64);
    set_bool(&value, "strikethrough", style.strikethrough);
    set_number(&value, "strikeShape", style.strike_shape as f64);
    set_number(&value, "outlineType", style.outline_type as f64);
    set_number(&value, "shadowType", style.shadow_type as f64);
    set_string(&value, "shadowColor", &color_ref_to_css(style.shadow_color));
    set_number(&value, "shadowOffsetX", style.shadow_offset_x);
    set_number(&value, "shadowOffsetY", style.shadow_offset_y);
    set_bool(&value, "emboss", style.emboss);
    set_bool(&value, "engrave", style.engrave);
    set_bool(&value, "superscript", style.superscript);
    set_bool(&value, "subscript", style.subscript);
    set_number(&value, "emphasisDot", style.emphasis_dot as f64);
    set_string(
        &value,
        "underlineColor",
        &color_ref_to_css(style.underline_color),
    );
    set_string(&value, "strikeColor", &color_ref_to_css(style.strike_color));
    set_string(&value, "shadeColor", &color_ref_to_css(style.shade_color));
    value.into()
}

fn glyph_outline_stroke_style_to_value(stroke: &GlyphOutlineStrokeStyle) -> JsValue {
    let value = Object::new();
    set_string(&value, "color", &color_ref_to_css(stroke.color));
    set_number(&value, "widthPx", stroke.width_px);
    set_string(&value, "join", stroke.join.as_str());
    set_string(&value, "cap", stroke.cap.as_str());
    if let Some(miter_limit) = stroke.miter_limit {
        set_number(&value, "miterLimit", miter_limit);
    }
    set_string(&value, "paintOrder", stroke.paint_order.as_str());
    value.into()
}

fn glyph_outline_color_layers_payload_to_value(
    payload: &crate::paint::ColorLayersPayload,
) -> JsValue {
    let value = Object::new();
    set_string(&value, "colorFormat", payload.color_format.as_str());
    if let Some(source_font_ref) = &payload.source_font_ref {
        set_value(
            &value,
            "sourceFontRef",
            glyph_outline_font_color_glyph_ref_to_value(source_font_ref),
        );
    }
    if let Some(palette_ref) = &payload.palette_ref {
        set_value(
            &value,
            "paletteRef",
            glyph_outline_palette_ref_to_value(palette_ref),
        );
    }
    if let Some(range) = payload.source_range_utf8 {
        set_value(&value, "sourceRangeUtf8", text_source_range_to_value(range));
    }
    if let Some(range) = payload.glyph_range {
        let range_value = Object::new();
        set_number(&range_value, "start", range.start as f64);
        set_number(&range_value, "end", range.end as f64);
        set_value(&value, "glyphRange", range_value.into());
    }
    set_value(
        &value,
        "layers",
        array_to_value(
            payload
                .layers
                .iter()
                .map(glyph_outline_color_layer_node_to_value),
        ),
    );
    if let Some(graph) = &payload.paint_graph {
        set_value(
            &value,
            "paintGraph",
            glyph_outline_color_paint_graph_to_value(graph),
        );
    }
    value.into()
}

fn glyph_outline_color_paint_graph_to_value(
    graph: &crate::paint::ColorPaintGraphPayload,
) -> JsValue {
    let value = Object::new();
    set_number(&value, "rootNodeId", graph.root_node_id as f64);
    set_value(
        &value,
        "nodes",
        array_to_value(
            graph
                .nodes
                .iter()
                .map(glyph_outline_color_paint_graph_node_to_value),
        ),
    );
    value.into()
}

fn glyph_outline_color_paint_graph_node_to_value(
    node: &crate::paint::ColorPaintGraphNode,
) -> JsValue {
    let value = Object::new();
    set_number(&value, "nodeId", node.node_id as f64);
    set_string(&value, "kind", node.kind.as_str());
    if let Some(solid) = &node.solid_path {
        set_value(
            &value,
            "solidPath",
            glyph_outline_color_solid_path_node_to_value(solid),
        );
    }
    if let Some(gradient_path) = &node.linear_gradient_path {
        set_value(
            &value,
            "linearGradientPath",
            glyph_outline_color_linear_gradient_path_node_to_value(gradient_path),
        );
    }
    if let Some(gradient_path) = &node.radial_gradient_path {
        set_value(
            &value,
            "radialGradientPath",
            glyph_outline_color_radial_gradient_path_node_to_value(gradient_path),
        );
    }
    if let Some(gradient_path) = &node.sweep_gradient_path {
        set_value(
            &value,
            "sweepGradientPath",
            glyph_outline_color_sweep_gradient_path_node_to_value(gradient_path),
        );
    }
    if let Some(transform) = &node.transform {
        set_value(
            &value,
            "transform",
            glyph_outline_color_transform_node_to_value(transform),
        );
    }
    if let Some(composite) = &node.composite {
        set_value(
            &value,
            "composite",
            glyph_outline_color_composite_node_to_value(composite),
        );
    }
    if let Some(clip) = &node.clip {
        set_value(&value, "clip", glyph_outline_color_clip_node_to_value(clip));
    }
    if let Some(range) = node.source_range_utf8 {
        set_value(&value, "sourceRangeUtf8", text_source_range_to_value(range));
    }
    if let Some(range) = node.glyph_range {
        let range_value = Object::new();
        set_number(&range_value, "start", range.start as f64);
        set_number(&range_value, "end", range.end as f64);
        set_value(&value, "glyphRange", range_value.into());
    }
    if let Some(source_font_ref) = &node.source_font_ref {
        set_value(
            &value,
            "sourceFontRef",
            glyph_outline_font_color_glyph_ref_to_value(source_font_ref),
        );
    }
    value.into()
}

fn glyph_outline_color_solid_path_node_to_value(
    solid: &crate::paint::ColorPaintSolidPathNode,
) -> JsValue {
    let value = Object::new();
    set_value(&value, "commands", path_commands_to_value(&solid.commands));
    set_value(&value, "fill", resolved_color_to_value(&solid.fill));
    set_string(&value, "fillRule", solid.fill_rule.as_str());
    if let Some(source_glyph_id) = solid.source_glyph_id {
        set_number(&value, "sourceGlyphId", source_glyph_id as f64);
    }
    if let Some(palette_index) = solid.palette_index {
        set_number(&value, "paletteIndex", palette_index as f64);
    }
    value.into()
}

fn glyph_outline_color_gradient_stops_to_value(
    stops: &[crate::paint::ColorGradientStop],
) -> JsValue {
    array_to_value(stops.iter().map(|stop| {
        let value = Object::new();
        set_number(&value, "offset", stop.offset);
        set_value(&value, "color", resolved_color_to_value(&stop.color));
        value.into()
    }))
}

fn glyph_outline_color_linear_gradient_path_node_to_value(
    gradient_path: &crate::paint::ColorPaintLinearGradientPathNode,
) -> JsValue {
    let value = Object::new();
    set_value(
        &value,
        "commands",
        path_commands_to_value(&gradient_path.commands),
    );
    let gradient = Object::new();
    set_number(&gradient, "x0", gradient_path.gradient.x0);
    set_number(&gradient, "y0", gradient_path.gradient.y0);
    set_number(&gradient, "x1", gradient_path.gradient.x1);
    set_number(&gradient, "y1", gradient_path.gradient.y1);
    set_value(
        &gradient,
        "stops",
        glyph_outline_color_gradient_stops_to_value(&gradient_path.gradient.stops),
    );
    set_value(&value, "gradient", gradient.into());
    set_string(&value, "fillRule", gradient_path.fill_rule.as_str());
    if let Some(source_glyph_id) = gradient_path.source_glyph_id {
        set_number(&value, "sourceGlyphId", source_glyph_id as f64);
    }
    if let Some(palette_index) = gradient_path.palette_index {
        set_number(&value, "paletteIndex", palette_index as f64);
    }
    value.into()
}

fn glyph_outline_color_radial_gradient_path_node_to_value(
    gradient_path: &crate::paint::ColorPaintRadialGradientPathNode,
) -> JsValue {
    let value = Object::new();
    set_value(
        &value,
        "commands",
        path_commands_to_value(&gradient_path.commands),
    );
    let gradient = Object::new();
    set_number(&gradient, "cx", gradient_path.gradient.cx);
    set_number(&gradient, "cy", gradient_path.gradient.cy);
    set_number(&gradient, "radius", gradient_path.gradient.radius);
    set_value(
        &gradient,
        "stops",
        glyph_outline_color_gradient_stops_to_value(&gradient_path.gradient.stops),
    );
    set_value(&value, "gradient", gradient.into());
    set_string(&value, "fillRule", gradient_path.fill_rule.as_str());
    if let Some(source_glyph_id) = gradient_path.source_glyph_id {
        set_number(&value, "sourceGlyphId", source_glyph_id as f64);
    }
    if let Some(palette_index) = gradient_path.palette_index {
        set_number(&value, "paletteIndex", palette_index as f64);
    }
    value.into()
}

fn glyph_outline_color_sweep_gradient_path_node_to_value(
    gradient_path: &crate::paint::ColorPaintSweepGradientPathNode,
) -> JsValue {
    let value = Object::new();
    set_value(
        &value,
        "commands",
        path_commands_to_value(&gradient_path.commands),
    );
    let gradient = Object::new();
    set_number(&gradient, "cx", gradient_path.gradient.cx);
    set_number(&gradient, "cy", gradient_path.gradient.cy);
    set_number(
        &gradient,
        "startAngleDegrees",
        gradient_path.gradient.start_angle_degrees,
    );
    set_number(
        &gradient,
        "endAngleDegrees",
        gradient_path.gradient.end_angle_degrees,
    );
    set_value(
        &gradient,
        "stops",
        glyph_outline_color_gradient_stops_to_value(&gradient_path.gradient.stops),
    );
    set_value(&value, "gradient", gradient.into());
    set_string(&value, "fillRule", gradient_path.fill_rule.as_str());
    if let Some(source_glyph_id) = gradient_path.source_glyph_id {
        set_number(&value, "sourceGlyphId", source_glyph_id as f64);
    }
    if let Some(palette_index) = gradient_path.palette_index {
        set_number(&value, "paletteIndex", palette_index as f64);
    }
    value.into()
}

fn glyph_outline_color_transform_node_to_value(
    transform: &crate::paint::ColorPaintTransformNode,
) -> JsValue {
    let value = Object::new();
    set_number(&value, "childNodeId", transform.child_node_id as f64);
    set_value(
        &value,
        "transform",
        affine_transform_to_value(transform.transform),
    );
    value.into()
}

fn glyph_outline_color_composite_node_to_value(
    composite: &crate::paint::ColorPaintCompositeNode,
) -> JsValue {
    let value = Object::new();
    set_number(&value, "sourceNodeId", composite.source_node_id as f64);
    set_number(&value, "backdropNodeId", composite.backdrop_node_id as f64);
    set_string(&value, "mode", composite.mode.as_str());
    value.into()
}

fn glyph_outline_color_clip_node_to_value(clip: &crate::paint::ColorPaintClipNode) -> JsValue {
    let value = Object::new();
    set_number(&value, "childNodeId", clip.child_node_id as f64);
    set_value(
        &value,
        "clipCommands",
        path_commands_to_value(&clip.clip_commands),
    );
    set_string(&value, "fillRule", clip.fill_rule.as_str());
    value.into()
}

fn glyph_outline_font_color_glyph_ref_to_value(
    source: &crate::paint::FontColorGlyphRef,
) -> JsValue {
    let value = Object::new();
    if let Some(face_key) = &source.face_key {
        set_string(&value, "faceKey", face_key);
    }
    if let Some(glyph_id) = source.glyph_id {
        set_number(&value, "glyphId", glyph_id as f64);
    }
    if let Some(palette_index) = source.palette_index {
        set_number(&value, "paletteIndex", palette_index as f64);
    }
    if let Some(color_format) = source.color_format {
        set_string(&value, "colorFormat", color_format.as_str());
    }
    value.into()
}

fn glyph_outline_palette_ref_to_value(palette: &crate::paint::PaletteRef) -> JsValue {
    let value = Object::new();
    if let Some(id) = &palette.id {
        set_string(&value, "id", id);
    }
    if let Some(index) = palette.index {
        set_number(&value, "index", index as f64);
    }
    if let Some(cpal_digest) = &palette.cpal_digest {
        set_string(&value, "cpalDigest", cpal_digest);
    }
    value.into()
}

fn glyph_outline_color_layer_node_to_value(layer: &crate::paint::ColorLayerNode) -> JsValue {
    let value = Object::new();
    if let Some(layer_index) = layer.layer_index {
        set_number(&value, "layerIndex", layer_index as f64);
    }
    if let Some(glyph_id) = layer.glyph_id {
        set_number(&value, "glyphId", glyph_id as f64);
    }
    if let Some(range) = layer.glyph_range {
        let range_value = Object::new();
        set_number(&range_value, "start", range.start as f64);
        set_number(&range_value, "end", range.end as f64);
        set_value(&value, "glyphRange", range_value.into());
    }
    if let Some(range) = layer.source_range_utf8 {
        set_value(&value, "sourceRangeUtf8", text_source_range_to_value(range));
    }
    if let Some(source_font_ref) = &layer.source_font_ref {
        set_value(
            &value,
            "sourceFontRef",
            glyph_outline_font_color_glyph_ref_to_value(source_font_ref),
        );
    }
    if let Some(path_index) = layer.path_index {
        set_number(&value, "pathIndex", path_index as f64);
    }
    if let Some(commands) = &layer.commands {
        set_value(&value, "commands", path_commands_to_value(commands));
    }
    if let Some(fill) = &layer.fill {
        set_value(&value, "fill", resolved_color_to_value(fill));
    }
    if let Some(fill_rule) = layer.fill_rule {
        set_string(&value, "fillRule", fill_rule.as_str());
    }
    if let Some(palette_index) = layer.palette_index {
        set_number(&value, "paletteIndex", palette_index as f64);
    }
    if let Some(color) = layer.color {
        set_string(&value, "color", &color_ref_to_css(color));
    }
    if let Some(opacity) = layer.opacity {
        set_number(&value, "opacity", opacity);
    }
    if let Some(transform) = layer.transform_to_run {
        set_value(
            &value,
            "transformToRun",
            affine_transform_to_value(transform),
        );
    }
    value.into()
}

fn resolved_color_to_value(color: &crate::paint::ResolvedColor) -> JsValue {
    let value = Object::new();
    if let Some(color_space) = &color.color_space {
        set_string(&value, "colorSpace", color_space);
    }
    let rgba = Array::new();
    for channel in color.rgba {
        rgba.push(&JsValue::from_f64(channel as f64));
    }
    set_value(&value, "rgba", rgba.into());
    value.into()
}

fn glyph_outline_bitmap_glyph_payload_to_value(
    payload: &crate::paint::BitmapGlyphPayload,
) -> JsValue {
    let value = Object::new();
    set_number(
        &value,
        "imageResourceId",
        payload.image_resource_id.0 as f64,
    );
    if let Some(range) = payload.source_range_utf8 {
        set_value(&value, "sourceRangeUtf8", text_source_range_to_value(range));
    }
    if let Some(range) = payload.glyph_range {
        let range_value = Object::new();
        set_number(&range_value, "start", range.start as f64);
        set_number(&range_value, "end", range.end as f64);
        set_value(&value, "glyphRange", range_value.into());
    }
    if let Some(placement) = payload.placement {
        set_value(&value, "placement", text_run_placement_to_value(placement));
    }
    if let Some(transform) = payload.transform_to_run {
        set_value(
            &value,
            "transformToRun",
            affine_transform_to_value(transform),
        );
    }
    if let Some((x, y)) = payload.strike_ppem {
        let strike = Array::new();
        strike.push(&JsValue::from_f64(x as f64));
        strike.push(&JsValue::from_f64(y as f64));
        set_value(&value, "strikePpem", strike.into());
    }
    if let Some(selection) = payload.strike_selection {
        set_string(&value, "strikeSelection", selection.as_str());
    }
    if let Some(pixel_format) = &payload.pixel_format {
        set_string(&value, "pixelFormat", pixel_format);
    }
    if let Some(color_space) = &payload.color_space {
        set_string(&value, "colorSpace", color_space);
    }
    if let Some(alpha_mode) = payload.alpha_mode {
        set_string(&value, "alphaMode", alpha_mode.as_str());
    }
    if let Some(scaling_policy) = payload.scaling_policy {
        set_string(&value, "scalingPolicy", scaling_policy.as_str());
    }
    if let Some(filtering) = payload.filtering {
        set_string(&value, "filtering", filtering.as_str());
    }
    value.into()
}

fn glyph_outline_svg_glyph_payload_to_value(payload: &crate::paint::SvgGlyphPayload) -> JsValue {
    let value = Object::new();
    set_number(
        &value,
        "vectorResourceId",
        payload.vector_resource_id.0 as f64,
    );
    if let Some(range) = payload.source_range_utf8 {
        set_value(&value, "sourceRangeUtf8", text_source_range_to_value(range));
    }
    if let Some(range) = payload.glyph_range {
        let range_value = Object::new();
        set_number(&range_value, "start", range.start as f64);
        set_number(&range_value, "end", range.end as f64);
        set_value(&value, "glyphRange", range_value.into());
    }
    if let Some(placement) = payload.placement {
        set_value(&value, "placement", text_run_placement_to_value(placement));
    }
    if let Some(transform) = payload.transform_to_run {
        set_value(
            &value,
            "transformToRun",
            affine_transform_to_value(transform),
        );
    }
    if let Some(view_box) = payload.view_box {
        let view_box_value = Object::new();
        set_number(&view_box_value, "x", view_box.x);
        set_number(&view_box_value, "y", view_box.y);
        set_number(&view_box_value, "width", view_box.width);
        set_number(&view_box_value, "height", view_box.height);
        set_value(&value, "viewBox", view_box_value.into());
    }
    if let Some(size) = payload.intrinsic_size {
        let size_value = Object::new();
        set_number(&size_value, "width", size.width);
        set_number(&size_value, "height", size.height);
        set_value(&value, "intrinsicSize", size_value.into());
    }
    set_string(&value, "securityMode", payload.security_mode.as_str());
    set_bool(&value, "scriptAllowed", payload.script_allowed);
    set_bool(&value, "animationAllowed", payload.animation_allowed);
    set_bool(
        &value,
        "externalResourcesAllowed",
        payload.external_resources_allowed,
    );
    set_bool(
        &value,
        "interactivityAllowed",
        payload.interactivity_allowed,
    );
    value.into()
}

fn tab_leaders_to_value(leaders: &[TabLeaderInfo]) -> JsValue {
    array_to_value(leaders.iter().map(tab_leader_to_value))
}

fn tab_leader_to_value(leader: &TabLeaderInfo) -> JsValue {
    let value = Object::new();
    set_number(&value, "startX", leader.start_x);
    set_number(&value, "endX", leader.end_x);
    set_number(&value, "fillType", leader.fill_type as f64);
    value.into()
}

fn text_decoration_to_value(decoration: &crate::paint::LayerTextDecorationPaint) -> JsValue {
    let value = Object::new();
    set_string(&value, "kind", decoration.kind.as_str());
    set_number(&value, "baseline", decoration.baseline);
    set_number(&value, "rotation", decoration.rotation);
    set_number(&value, "fontSize", decoration.font_size);
    set_number(&value, "ratio", decoration.ratio);
    set_string(&value, "color", &color_ref_to_css(decoration.color));
    set_number(&value, "shape", decoration.shape as f64);
    set_string(
        &value,
        "underline",
        underline_type_str(decoration.underline),
    );
    set_number(&value, "emphasisDot", decoration.emphasis_dot as f64);
    set_value(
        &value,
        "positions",
        array_to_value(decoration.positions.iter().copied().map(JsValue::from_f64)),
    );
    value.into()
}

fn shape_style_to_value(style: &ShapeStyle) -> JsValue {
    let value = Object::new();
    match style.fill_color {
        Some(fill_color) => set_string(&value, "fillColor", &color_ref_to_css(fill_color)),
        None => set_value(&value, "fillColor", JsValue::NULL),
    }
    match style.stroke_color {
        Some(stroke_color) => set_string(&value, "strokeColor", &color_ref_to_css(stroke_color)),
        None => set_value(&value, "strokeColor", JsValue::NULL),
    }
    set_number(&value, "strokeWidth", style.stroke_width);
    set_string(&value, "strokeDash", stroke_dash_str(style.stroke_dash));
    set_number(&value, "opacity", style.opacity);
    if let Some(pattern) = &style.pattern {
        set_value(&value, "pattern", pattern_fill_to_value(pattern));
    }
    if let Some(shadow) = &style.shadow {
        set_value(&value, "shadow", shadow_style_to_value(shadow));
    }
    value.into()
}

fn pattern_fill_to_value(pattern: &PatternFillInfo) -> JsValue {
    let value = Object::new();
    set_number(&value, "patternType", pattern.pattern_type as f64);
    set_string(
        &value,
        "patternColor",
        &color_ref_to_css(pattern.pattern_color),
    );
    set_string(
        &value,
        "backgroundColor",
        &color_ref_to_css(pattern.background_color),
    );
    value.into()
}

fn shadow_style_to_value(shadow: &ShadowStyle) -> JsValue {
    let value = Object::new();
    set_number(&value, "shadowType", shadow.shadow_type as f64);
    set_string(&value, "color", &color_ref_to_css(shadow.color));
    set_number(&value, "offsetX", shadow.offset_x);
    set_number(&value, "offsetY", shadow.offset_y);
    set_number(&value, "alpha", shadow.alpha as f64);
    value.into()
}

fn gradient_to_value(gradient: &GradientFillInfo) -> JsValue {
    let value = Object::new();
    set_number(&value, "gradientType", gradient.gradient_type as f64);
    set_number(&value, "angle", gradient.angle as f64);
    set_number(&value, "centerX", gradient.center_x as f64);
    set_number(&value, "centerY", gradient.center_y as f64);
    set_value(
        &value,
        "colors",
        array_to_value(
            gradient
                .colors
                .iter()
                .map(|color| JsValue::from_str(&color_ref_to_css(*color))),
        ),
    );
    set_value(
        &value,
        "positions",
        array_to_value(gradient.positions.iter().copied().map(JsValue::from_f64)),
    );
    value.into()
}

fn line_style_to_value(style: &LineStyle) -> JsValue {
    let value = Object::new();
    set_string(&value, "color", &color_ref_to_css(style.color));
    set_number(&value, "width", style.width);
    set_string(&value, "dash", stroke_dash_str(style.dash));
    set_string(&value, "lineType", line_render_type_str(style.line_type));
    set_string(&value, "startArrow", arrow_style_str(style.start_arrow));
    set_string(&value, "endArrow", arrow_style_str(style.end_arrow));
    set_number(&value, "startArrowSize", style.start_arrow_size as f64);
    set_number(&value, "endArrowSize", style.end_arrow_size as f64);
    if let Some(shadow) = &style.shadow {
        set_value(&value, "shadow", shadow_style_to_value(shadow));
    }
    value.into()
}

fn transform_to_value(transform: ShapeTransform) -> JsValue {
    let value = Object::new();
    set_number(&value, "rotation", transform.rotation);
    set_bool(&value, "horzFlip", transform.horz_flip);
    set_bool(&value, "vertFlip", transform.vert_flip);
    value.into()
}

fn path_commands_to_value(commands: &[PathCommand]) -> JsValue {
    array_to_value(commands.iter().map(|command| {
        let value = Object::new();
        match command {
            PathCommand::MoveTo(x, y) => {
                set_string(&value, "type", "moveTo");
                set_number(&value, "x", *x);
                set_number(&value, "y", *y);
            }
            PathCommand::LineTo(x, y) => {
                set_string(&value, "type", "lineTo");
                set_number(&value, "x", *x);
                set_number(&value, "y", *y);
            }
            PathCommand::CurveTo(x1, y1, x2, y2, x3, y3) => {
                set_string(&value, "type", "curveTo");
                set_number(&value, "x1", *x1);
                set_number(&value, "y1", *y1);
                set_number(&value, "x2", *x2);
                set_number(&value, "y2", *y2);
                set_number(&value, "x3", *x3);
                set_number(&value, "y3", *y3);
            }
            PathCommand::ArcTo(rx, ry, rotation, large_arc, sweep, x, y) => {
                set_string(&value, "type", "arcTo");
                set_number(&value, "rx", *rx);
                set_number(&value, "ry", *ry);
                set_number(&value, "rotation", *rotation);
                set_bool(&value, "largeArc", *large_arc);
                set_bool(&value, "sweep", *sweep);
                set_number(&value, "x", *x);
                set_number(&value, "y", *y);
            }
            PathCommand::ClosePath => set_string(&value, "type", "closePath"),
        }
        value.into()
    }))
}

fn equation_layout_box_to_value(layout: &LayoutBox) -> JsValue {
    let value = Object::new();
    set_number(&value, "x", layout.x);
    set_number(&value, "y", layout.y);
    set_number(&value, "width", layout.width);
    set_number(&value, "height", layout.height);
    set_number(&value, "baseline", layout.baseline);
    set_value(&value, "kind", equation_layout_kind_to_value(&layout.kind));
    value.into()
}

fn equation_layout_kind_to_value(kind: &LayoutKind) -> JsValue {
    let value = Object::new();
    match kind {
        LayoutKind::Row(children) => {
            set_string(&value, "type", "row");
            set_value(
                &value,
                "children",
                array_to_value(children.iter().map(equation_layout_box_to_value)),
            );
        }
        LayoutKind::Text(text) => {
            set_string(&value, "type", "text");
            set_string(&value, "text", text);
        }
        LayoutKind::Number(text) => {
            set_string(&value, "type", "number");
            set_string(&value, "text", text);
        }
        LayoutKind::Symbol(text) => {
            set_string(&value, "type", "symbol");
            set_string(&value, "text", text);
        }
        LayoutKind::MathSymbol(text) => {
            set_string(&value, "type", "mathSymbol");
            set_string(&value, "text", text);
        }
        LayoutKind::Function(name) => {
            set_string(&value, "type", "function");
            set_string(&value, "name", name);
        }
        LayoutKind::Fraction { numer, denom } => {
            set_string(&value, "type", "fraction");
            set_value(&value, "numer", equation_layout_box_to_value(numer));
            set_value(&value, "denom", equation_layout_box_to_value(denom));
        }
        LayoutKind::Sqrt { index, body } => {
            set_string(&value, "type", "sqrt");
            if let Some(index) = index {
                set_value(&value, "index", equation_layout_box_to_value(index));
            }
            set_value(&value, "body", equation_layout_box_to_value(body));
        }
        LayoutKind::Superscript { base, sup } => {
            set_string(&value, "type", "superscript");
            set_value(&value, "base", equation_layout_box_to_value(base));
            set_value(&value, "sup", equation_layout_box_to_value(sup));
        }
        LayoutKind::Subscript { base, sub } => {
            set_string(&value, "type", "subscript");
            set_value(&value, "base", equation_layout_box_to_value(base));
            set_value(&value, "sub", equation_layout_box_to_value(sub));
        }
        LayoutKind::SubSup { base, sub, sup } => {
            set_string(&value, "type", "subSup");
            set_value(&value, "base", equation_layout_box_to_value(base));
            set_value(&value, "sub", equation_layout_box_to_value(sub));
            set_value(&value, "sup", equation_layout_box_to_value(sup));
        }
        LayoutKind::BigOp { symbol, sub, sup } => {
            set_string(&value, "type", "bigOp");
            set_string(&value, "symbol", symbol);
            if let Some(sub) = sub {
                set_value(&value, "sub", equation_layout_box_to_value(sub));
            }
            if let Some(sup) = sup {
                set_value(&value, "sup", equation_layout_box_to_value(sup));
            }
        }
        LayoutKind::Limit { is_upper, sub } => {
            set_string(&value, "type", "limit");
            set_bool(&value, "isUpper", *is_upper);
            if let Some(sub) = sub {
                set_value(&value, "sub", equation_layout_box_to_value(sub));
            }
        }
        LayoutKind::Matrix { cells, style } => {
            set_string(&value, "type", "matrix");
            set_string(&value, "style", matrix_style_str(*style));
            set_value(
                &value,
                "cells",
                array_to_value(
                    cells
                        .iter()
                        .map(|row| array_to_value(row.iter().map(equation_layout_box_to_value))),
                ),
            );
        }
        LayoutKind::Rel { arrow, over, under } => {
            set_string(&value, "type", "rel");
            set_value(&value, "arrow", equation_layout_box_to_value(arrow));
            set_value(&value, "over", equation_layout_box_to_value(over));
            if let Some(under) = under {
                set_value(&value, "under", equation_layout_box_to_value(under));
            }
        }
        LayoutKind::EqAlign { rows } => {
            set_string(&value, "type", "eqAlign");
            set_value(
                &value,
                "rows",
                array_to_value(rows.iter().map(|(left, right)| {
                    let row = Object::new();
                    set_value(&row, "left", equation_layout_box_to_value(left));
                    set_value(&row, "right", equation_layout_box_to_value(right));
                    row.into()
                })),
            );
        }
        LayoutKind::Paren { left, right, body } => {
            set_string(&value, "type", "paren");
            set_string(&value, "left", left);
            set_string(&value, "right", right);
            set_value(&value, "body", equation_layout_box_to_value(body));
        }
        LayoutKind::Decoration { kind, body } => {
            set_string(&value, "type", "decoration");
            set_string(&value, "decoration", deco_kind_str(*kind));
            set_value(&value, "body", equation_layout_box_to_value(body));
        }
        LayoutKind::FontStyle { style, body } => {
            set_string(&value, "type", "fontStyle");
            set_string(&value, "fontStyle", font_style_kind_str(*style));
            set_value(&value, "body", equation_layout_box_to_value(body));
        }
        LayoutKind::Space(width) => {
            set_string(&value, "type", "space");
            set_number(&value, "width", *width);
        }
        LayoutKind::Newline => set_string(&value, "type", "newline"),
        LayoutKind::Empty => set_string(&value, "type", "empty"),
    }
    value.into()
}

fn array_to_value(values: impl IntoIterator<Item = JsValue>) -> JsValue {
    let array = Array::new();
    for value in values {
        array.push(&value);
    }
    array.into()
}

fn string_array_to_value(values: &[&str]) -> JsValue {
    array_to_value(values.iter().map(|value| JsValue::from_str(value)))
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
                if ops.iter().any(|op| match op {
                    PaintOp::TextRun { run, .. } => run.variant.is_some(),
                    PaintOp::GlyphRun { .. } => true,
                    PaintOp::GlyphOutline { .. } => true,
                    PaintOp::CharOverlap { overlap, .. } => overlap.variant.is_some(),
                    _ => false,
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

fn paint_variant_meta_to_value(variant: &PaintVariantMeta) -> JsValue {
    let value = Object::new();
    set_string(&value, "equivalenceGroup", &variant.equivalence_group);
    set_string(&value, "variantId", &variant.variant_id);
    set_string(&value, "variantKind", variant.variant_kind.as_str());
    set_number(&value, "partIndex", variant.part_index as f64);
    set_number(&value, "partCount", variant.part_count as f64);
    set_bool(&value, "isDefaultFallback", variant.is_default_fallback);
    if !variant.requires.is_empty() {
        set_value(
            &value,
            "requires",
            array_to_value(
                variant
                    .requires
                    .iter()
                    .map(|feature| JsValue::from_str(feature)),
            ),
        );
    }
    if let Some(quality) = variant.quality {
        set_string(&value, "quality", quality.as_str());
    }
    if let Some(anchor_op_id) = &variant.anchor_op_id {
        set_string(&value, "anchorOpId", anchor_op_id);
    }
    if let Some(local_paint_order) = variant.local_paint_order {
        set_number(&value, "localPaintOrder", local_paint_order as f64);
    }
    value.into()
}

fn text_legacy_visuals_to_value(run: &crate::paint::LayerTextRunPaint) -> Option<JsValue> {
    let has_decorations = run.style.underline != UnderlineType::None
        || run.style.strikethrough
        || run.style.emphasis_dot > 0;
    if run.char_overlap.is_none()
        && run.control_marks.is_empty()
        && run.style.tab_leaders.is_empty()
        && !has_decorations
    {
        return None;
    }
    let value = Object::new();
    if run.char_overlap.is_some() {
        set_string(
            &value,
            "charOverlap",
            run.legacy_visuals
                .char_overlap
                .unwrap_or(crate::paint::TextLegacyVisualState::Canonical)
                .as_str(),
        );
    }
    if !run.control_marks.is_empty() {
        set_string(
            &value,
            "controlMarks",
            run.legacy_visuals
                .control_marks
                .unwrap_or(crate::paint::TextLegacyVisualState::Canonical)
                .as_str(),
        );
    }
    if !run.style.tab_leaders.is_empty() {
        set_string(
            &value,
            "tabLeaders",
            run.legacy_visuals
                .tab_leaders
                .unwrap_or(crate::paint::TextLegacyVisualState::Canonical)
                .as_str(),
        );
    }
    if has_decorations {
        set_string(
            &value,
            "decorations",
            run.legacy_visuals
                .decorations
                .unwrap_or(crate::paint::TextLegacyVisualState::Canonical)
                .as_str(),
        );
    }
    Some(value.into())
}

fn text_run_placement_to_value(placement: TextRunPlacement) -> JsValue {
    let value = Object::new();
    set_value(
        &value,
        "runToPage",
        affine_transform_to_value(placement.run_to_page),
    );
    set_number(&value, "baselineY", placement.baseline_y);
    value.into()
}

fn affine_transform_to_value(transform: LayerAffineTransform) -> JsValue {
    let value = Object::new();
    set_number(&value, "a", transform.a);
    set_number(&value, "b", transform.b);
    set_number(&value, "c", transform.c);
    set_number(&value, "d", transform.d);
    set_number(&value, "e", transform.e);
    set_number(&value, "f", transform.f);
    value.into()
}

fn display_text_for_text_run(run: &crate::paint::LayerTextRunPaint) -> Option<String> {
    let display_text = expand_pua_display_text(&run.text);
    (display_text != run.text).then_some(display_text)
}

fn text_clusters_to_value(clusters: &[TextClusterPlacement]) -> JsValue {
    array_to_value(clusters.iter().map(|cluster| {
        let value = Object::new();
        set_value(
            &value,
            "sourceRangeUtf8",
            text_source_range_to_value(cluster.source_range_utf8),
        );
        set_value(
            &value,
            "textRangeUtf8",
            text_source_range_to_value(cluster.text_range_utf8),
        );
        if let Some(range) = cluster.text_range_utf16 {
            set_value(&value, "textRangeUtf16", text_source_range_to_value(range));
        }
        set_string(&value, "projection", cluster.projection.as_str());
        set_value(&value, "origin", layer_point_to_value(cluster.origin));
        if let Some(advance) = cluster.advance {
            set_value(&value, "advance", layer_vector_to_value(advance));
        }
        if !cluster.flags.is_empty() {
            let flags = cluster
                .flags
                .iter()
                .map(|flag| JsValue::from_str(flag.as_str()));
            set_value(&value, "flags", array_to_value(flags));
        }
        value.into()
    }))
}

fn shape_key_to_value(shape_key: &ShapeKey) -> JsValue {
    let value = Object::new();
    let font_instance = Object::new();
    set_string(
        &font_instance,
        "faceKey",
        &shape_key.font_instance.face_key.0,
    );
    set_number(&font_instance, "sizePx", shape_key.font_instance.size_px);
    set_bool(
        &font_instance,
        "syntheticBold",
        shape_key.font_instance.synthetic_bold,
    );
    set_bool(
        &font_instance,
        "syntheticItalic",
        shape_key.font_instance.synthetic_italic,
    );
    set_value(
        &font_instance,
        "variations",
        array_to_value(shape_key.font_instance.variations.iter().map(|axis| {
            let axis_value = Object::new();
            set_string(&axis_value, "tag", &axis.tag);
            set_number(&axis_value, "value", axis.value as f64);
            axis_value.into()
        })),
    );
    set_value(&value, "fontInstance", font_instance.into());
    set_string(&value, "direction", shape_key.direction.as_str());
    set_string(&value, "writingMode", shape_key.writing_mode.as_str());
    if let Some(script) = &shape_key.script {
        set_string(&value, "script", &script.0);
    }
    if let Some(language) = &shape_key.language {
        set_string(&value, "language", &language.0);
    }
    set_value(
        &value,
        "features",
        array_to_value(shape_key.features.iter().map(|feature| {
            let feature_value = Object::new();
            set_string(&feature_value, "tag", &feature.tag);
            set_bool(&feature_value, "enabled", feature.enabled);
            if let Some(feature_setting) = feature.value {
                set_number(&feature_value, "value", feature_setting as f64);
            }
            feature_value.into()
        })),
    );
    set_string(&value, "shapingEngine", &shape_key.shaping_engine.0);
    set_string(&value, "fallbackPolicy", &shape_key.fallback_policy.0);
    value.into()
}

fn points_to_value(points: &[LayerPoint]) -> JsValue {
    array_to_value(points.iter().copied().map(layer_point_to_value))
}

fn vectors_to_value(vectors: &[LayerVector]) -> JsValue {
    array_to_value(vectors.iter().copied().map(layer_vector_to_value))
}

fn glyph_clusters_to_value(clusters: &[GlyphCluster]) -> JsValue {
    array_to_value(clusters.iter().map(|cluster| {
        let value = Object::new();
        set_value(
            &value,
            "sourceRangeUtf8",
            text_source_range_to_value(cluster.source_range_utf8),
        );
        if let Some(range) = cluster.source_range_utf16 {
            set_value(
                &value,
                "sourceRangeUtf16",
                text_source_range_to_value(range),
            );
        }
        if let Some(range) = cluster.text_range_utf8 {
            set_value(&value, "textRangeUtf8", text_source_range_to_value(range));
        }
        let glyph_range = Object::new();
        set_number(&glyph_range, "start", cluster.glyph_range.start as f64);
        set_number(&glyph_range, "end", cluster.glyph_range.end as f64);
        set_value(&value, "glyphRange", glyph_range.into());
        if !cluster.flags.is_empty() {
            set_value(
                &value,
                "flags",
                array_to_value(
                    cluster
                        .flags
                        .iter()
                        .map(|flag| JsValue::from_str(flag.as_str())),
                ),
            );
        }
        value.into()
    }))
}

fn glyph_transforms_to_value(transforms: &[GlyphTransform]) -> JsValue {
    array_to_value(transforms.iter().map(|transform| {
        let value = Object::new();
        set_number(&value, "xx", transform.xx as f64);
        set_number(&value, "xy", transform.xy as f64);
        set_number(&value, "yx", transform.yx as f64);
        set_number(&value, "yy", transform.yy as f64);
        set_number(&value, "tx", transform.tx as f64);
        set_number(&value, "ty", transform.ty as f64);
        value.into()
    }))
}

fn glyph_run_diagnostics_to_value(diagnostics: &GlyphRunDiagnostics) -> JsValue {
    let value = Object::new();
    set_string(&value, "quality", diagnostics.quality.as_str());
    set_string(
        &value,
        "replayEligibility",
        diagnostics.replay_eligibility.as_str(),
    );
    set_bool(
        &value,
        "strictVisualEligible",
        diagnostics.strict_visual_eligible,
    );
    set_number(&value, "maxOriginDeltaPx", diagnostics.max_origin_delta_px);
    set_number(
        &value,
        "maxAdvanceDeltaPx",
        diagnostics.max_advance_delta_px,
    );
    set_number(
        &value,
        "maxResidualAfterAdjustmentPx",
        diagnostics.max_residual_after_adjustment_px,
    );
    set_number(
        &value,
        "clusterMismatchCount",
        diagnostics.cluster_mismatch_count as f64,
    );
    set_number(
        &value,
        "missingGlyphCount",
        diagnostics.missing_glyph_count as f64,
    );
    set_number(
        &value,
        "usedFallbackFontCount",
        diagnostics.used_fallback_font_count as f64,
    );
    if let Some(reason) = &diagnostics.reason {
        set_string(&value, "reason", reason);
    }
    value.into()
}

fn layer_point_to_value(point: LayerPoint) -> JsValue {
    let value = Object::new();
    set_number(&value, "x", point.x);
    set_number(&value, "y", point.y);
    value.into()
}

fn layer_vector_to_value(vector: LayerVector) -> JsValue {
    let value = Object::new();
    set_number(&value, "dx", vector.dx);
    set_number(&value, "dy", vector.dy);
    value.into()
}

fn text_control_marks_to_value(run: &crate::paint::LayerTextRunPaint) -> JsValue {
    array_to_value(run.control_marks.iter().map(text_control_mark_to_value))
}

fn text_control_mark_to_value(mark: &crate::paint::LayerTextControlMark) -> JsValue {
    let value = Object::new();
    set_string(&value, "kind", mark.kind.as_str());
    set_string(&value, "text", mark.kind.glyph());
    set_number(&value, "x", mark.x);
    set_number(&value, "y", mark.y);
    set_number(&value, "fontSize", mark.font_size);
    value.into()
}

fn char_overlap_to_value(overlap: &crate::renderer::composer::CharOverlapInfo) -> JsValue {
    let value = Object::new();
    set_number(&value, "borderType", overlap.border_type as f64);
    set_number(&value, "innerCharSize", overlap.inner_char_size as f64);
    value.into()
}

fn set_value(object: &Object, key: &str, value: JsValue) {
    Reflect::set(object, &JsValue::from_str(key), &value).expect("js object property set failed");
}

fn set_string(object: &Object, key: &str, value: &str) {
    set_value(object, key, JsValue::from_str(value));
}

fn set_bool(object: &Object, key: &str, value: bool) {
    set_value(object, key, JsValue::from_bool(value));
}

fn set_number(object: &Object, key: &str, value: f64) {
    set_value(object, key, JsValue::from_f64(value));
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
mod tests {
    use super::*;
    use wasm_bindgen_test::wasm_bindgen_test;

    use crate::paint::{
        LayerEquationPaint, LayerImagePaint, LayerOutputOptions, LayerTextControlMark,
        LayerTextControlMarkKind, LayerTextOrientation, LayerTextRunPaint, ResourceArena,
    };
    use crate::renderer::composer::CharOverlapInfo;
    use crate::renderer::render_tree::BoundingBox;

    #[wasm_bindgen_test]
    fn exports_json_and_js_value_schema_parity() {
        let image_bytes = vec![1, 2, 3, 4, 5, 6];
        let svg_fragment = "<text x=\"0\" y=\"12\">x</text>".to_string();
        let tree = layer_tree_fixture(&image_bytes, &svg_fragment);

        let json_value = js_sys::JSON::parse(&tree.to_json())
            .unwrap_or_else(|_| panic!("failed to parse layer JSON export"));
        let js_value = page_layer_tree_to_js_value(&tree);

        assert_same_number(&json_value, &js_value, "schemaVersion");
        assert_same_number(&json_value, &js_value, "schemaMinorVersion");
        assert_same_number(
            &prop(&json_value, "schema"),
            &prop(&js_value, "schema"),
            "major",
        );
        assert_same_number(
            &prop(&json_value, "schema"),
            &prop(&js_value, "schema"),
            "minor",
        );
        assert_same_number(&json_value, &js_value, "resourceTableVersion");
        assert_same_number(&json_value, &js_value, "resourceTableMinorVersion");
        assert_same_number(
            &prop(&json_value, "resourceTable"),
            &prop(&js_value, "resourceTable"),
            "major",
        );
        assert_same_number(
            &prop(&json_value, "resourceTable"),
            &prop(&js_value, "resourceTable"),
            "minor",
        );
        assert_same_string(&json_value, &js_value, "unit");
        assert_same_string(&json_value, &js_value, "coordinateSystem");
        assert_same_number(&json_value, &js_value, "pageWidth");
        assert_same_number(&json_value, &js_value, "pageHeight");
        assert_same_string(&json_value, &js_value, "profile");
        let json_layout = prop(&json_value, "layout");
        let js_layout = prop(&js_value, "layout");
        assert_same_string(&json_layout, &js_layout, "profile");
        assert_same_string(&json_layout, &js_layout, "measurementAuthority");
        assert_same_string(&json_layout, &js_layout, "shapedMeasurement");

        let json_options = prop(&json_value, "outputOptions");
        let js_options = prop(&js_value, "outputOptions");
        for property in [
            "showParagraphMarks",
            "showControlCodes",
            "showTransparentBorders",
            "clipEnabled",
            "debugOverlay",
        ] {
            assert_same_bool(&json_options, &js_options, property);
        }
        let json_build_options = prop(&json_value, "buildOptions");
        let js_build_options = prop(&js_value, "buildOptions");
        assert_same_bool(
            &json_build_options,
            &js_build_options,
            "showTransparentBorders",
        );
        let json_debug_options = prop(&json_value, "debugOptions");
        let js_debug_options = prop(&js_value, "debugOptions");
        assert_same_bool(&json_debug_options, &js_debug_options, "debugOverlay");
        let json_debug_capabilities = prop(&json_value, "debugCapabilities");
        let js_debug_capabilities = prop(&js_value, "debugCapabilities");
        assert_same_bool(
            &json_debug_capabilities,
            &js_debug_capabilities,
            "overlayPaint",
        );
        assert_same_bool(
            &json_debug_capabilities,
            &js_debug_capabilities,
            "semanticBounds",
        );
        let json_generic_debug = prop(&json_debug_capabilities, "genericLayerExport");
        let js_generic_debug = prop(&js_debug_capabilities, "genericLayerExport");
        assert_same_bool(&json_generic_debug, &js_generic_debug, "overlayPaint");
        assert_same_bool(&json_generic_debug, &js_generic_debug, "semanticBounds");
        let json_debug_backends = prop(&json_debug_capabilities, "backends");
        let js_debug_backends = prop(&js_debug_capabilities, "backends");
        for backend in ["svgLayer", "canvas2d", "canvaskit", "nativeSkia"] {
            let json_backend = prop(&json_debug_backends, backend);
            let js_backend = prop(&js_debug_backends, backend);
            assert_same_bool(&json_backend, &js_backend, "overlayPaint");
            assert_same_bool(&json_backend, &js_backend, "semanticBounds");
        }
        let json_used_features = Array::from(&prop(&json_value, "usedFeatures"));
        let js_used_features = Array::from(&prop(&js_value, "usedFeatures"));
        assert_eq!(json_used_features.length(), 8);
        assert_eq!(json_used_features.length(), js_used_features.length());
        assert_eq!(
            string_value(&json_used_features.get(0)),
            string_value(&js_used_features.get(0))
        );
        let json_optional_features = Array::from(&prop(&json_value, "optionalFeatures"));
        let js_optional_features = Array::from(&prop(&js_value, "optionalFeatures"));
        assert_eq!(json_optional_features.length(), 0);
        assert_eq!(
            json_optional_features.length(),
            js_optional_features.length()
        );
        let json_known_features = Array::from(&prop(&json_value, "knownFeatures"));
        let js_known_features = Array::from(&prop(&js_value, "knownFeatures"));
        assert_eq!(json_known_features.length(), 26);
        assert_eq!(json_known_features.length(), js_known_features.length());
        let json_required_features = Array::from(&prop(&json_value, "requiredFeatures"));
        let js_required_features = Array::from(&prop(&js_value, "requiredFeatures"));
        assert_eq!(json_required_features.length(), 0);
        assert_eq!(
            json_required_features.length(),
            js_required_features.length()
        );
        let json_text_contract = prop(&json_value, "text");
        let js_text_contract = prop(&js_value, "text");
        assert_same_string(&json_text_contract, &js_text_contract, "defaultVariant");
        assert_same_string(&json_text_contract, &js_text_contract, "variantSelection");
        assert_same_bool(
            &json_text_contract,
            &js_text_contract,
            "sourceTextPreserved",
        );
        assert_same_bool(&json_text_contract, &js_text_contract, "fallbackRequired");
        assert_same_string(&json_text_contract, &js_text_contract, "placementAuthority");
        let json_externalized = Array::from(&prop(&json_text_contract, "externalizedVisuals"));
        let js_externalized = Array::from(&prop(&js_text_contract, "externalizedVisuals"));
        assert_eq!(json_externalized.length(), 0);
        assert_eq!(json_externalized.length(), js_externalized.length());
        let json_text_v2_contract = prop(&json_value, "textV2");
        let js_text_v2_contract = prop(&js_value, "textV2");
        assert_same_string(&json_text_v2_contract, &js_text_v2_contract, "profile");
        assert_same_string(&json_text_v2_contract, &js_text_v2_contract, "canonicalOp");
        assert_same_string(
            &json_text_v2_contract,
            &js_text_v2_contract,
            "fallbackPolicy",
        );
        assert_same_bool(
            &json_text_v2_contract,
            &js_text_v2_contract,
            "strictVisualFallbackFree",
        );
        assert_same_string(
            &json_text_v2_contract,
            &js_text_v2_contract,
            "paintOrderSlots",
        );
        let json_font_resources = prop(&json_value, "fontResources");
        let js_font_resources = prop(&js_value, "fontResources");
        assert_eq!(
            Array::from(&prop(&json_font_resources, "blobs")).length(),
            0
        );
        assert_eq!(Array::from(&prop(&js_font_resources, "blobs")).length(), 0);
        assert_eq!(
            Array::from(&prop(&json_font_resources, "faces")).length(),
            0
        );
        assert_eq!(Array::from(&prop(&js_font_resources, "faces")).length(), 0);

        let json_root = prop(&json_value, "root");
        let js_root = prop(&js_value, "root");
        assert_same_string(&json_root, &js_root, "kind");
        assert_same_string(&json_root, &js_root, "cacheHint");
        let json_text_sources = Array::from(&prop(&json_value, "textSources"));
        let js_text_sources = Array::from(&prop(&js_value, "textSources"));
        assert_eq!(json_text_sources.length(), 1);
        assert_eq!(json_text_sources.length(), js_text_sources.length());
        let json_source = json_text_sources.get(0);
        let js_source = js_text_sources.get(0);
        assert_same_number(&json_source, &js_source, "id");
        assert_same_string(&json_source, &js_source, "text");
        assert_same_number(
            &prop(&json_source, "utf8Range"),
            &prop(&js_source, "utf8Range"),
            "end",
        );
        assert_same_number(
            &prop(&json_source, "utf16Range"),
            &prop(&js_source, "utf16Range"),
            "end",
        );
        let json_annotations = Array::from(&prop(&json_source, "annotations"));
        let js_annotations = Array::from(&prop(&js_source, "annotations"));
        assert_eq!(json_annotations.length(), 3);
        assert_eq!(json_annotations.length(), js_annotations.length());
        assert_same_string(&json_annotations.get(0), &js_annotations.get(0), "kind");
        assert_same_string(&json_annotations.get(0), &js_annotations.get(0), "marker");
        assert_same_number(
            &json_annotations.get(0),
            &js_annotations.get(0),
            "shapeMarkerIndex",
        );
        assert_same_string(&json_annotations.get(1), &js_annotations.get(1), "kind");
        assert_same_string(&json_annotations.get(2), &js_annotations.get(2), "kind");

        let json_ops = Array::from(&prop(&json_root, "ops"));
        let js_ops = Array::from(&prop(&js_root, "ops"));
        assert_eq!(json_ops.length(), 3);
        assert_eq!(json_ops.length(), js_ops.length());

        let json_text = json_ops.get(0);
        let js_text = js_ops.get(0);
        assert_same_string(&json_text, &js_text, "type");
        assert_same_string(&json_text, &js_text, "text");
        assert_same_string(&json_text, &js_text, "fieldMarker");
        assert_same_string(&json_text, &js_text, "orientation");
        assert_same_string(&json_text, &js_text, "projectionKind");
        assert_same_string(&json_text, &js_text, "clusterBasis");
        assert_same_number(&json_text, &js_text, "shapeMarkerIndex");
        let json_placement = prop(&json_text, "placement");
        let js_placement = prop(&js_text, "placement");
        assert_close_number(
            &prop(&json_placement, "runToPage"),
            &prop(&js_placement, "runToPage"),
            "e",
            0.000001,
        );
        assert_same_number(&json_placement, &js_placement, "baselineY");
        let json_clusters = Array::from(&prop(&json_text, "clusters"));
        let js_clusters = Array::from(&prop(&js_text, "clusters"));
        assert_eq!(json_clusters.length(), 6);
        assert_eq!(json_clusters.length(), js_clusters.length());
        assert_same_string(&json_clusters.get(0), &js_clusters.get(0), "projection");
        assert_same_number(
            &prop(&json_clusters.get(0), "sourceRangeUtf8"),
            &prop(&js_clusters.get(0), "sourceRangeUtf8"),
            "end",
        );
        assert_same_number(&prop(&json_text, "source"), &prop(&js_text, "source"), "id");
        assert_same_number(
            &prop(&prop(&json_text, "source"), "utf8Range"),
            &prop(&prop(&js_text, "source"), "utf8Range"),
            "end",
        );
        assert_same_bool(&json_text, &js_text, "isParaEnd");
        assert_same_bool(&json_text, &js_text, "isLineBreakEnd");
        let json_paint_style = prop(&json_text, "paintStyle");
        let js_paint_style = prop(&js_text, "paintStyle");
        assert_same_string(&json_paint_style, &js_paint_style, "fontFamily");
        assert_same_number(&json_paint_style, &js_paint_style, "fontSize");
        assert_same_string(&json_paint_style, &js_paint_style, "color");
        assert_same_bool(&json_paint_style, &js_paint_style, "bold");
        assert_same_bool(&json_paint_style, &js_paint_style, "superscript");
        assert_same_bool(&json_paint_style, &js_paint_style, "subscript");
        assert_same_number(&json_paint_style, &js_paint_style, "ratio");
        assert_same_number(
            &prop(&json_text, "charOverlap"),
            &prop(&js_text, "charOverlap"),
            "borderType",
        );
        assert_same_number(
            &prop(&json_text, "charOverlap"),
            &prop(&js_text, "charOverlap"),
            "innerCharSize",
        );
        let json_legacy_visuals = prop(&json_text, "legacyVisuals");
        let js_legacy_visuals = prop(&js_text, "legacyVisuals");
        assert_same_string(&json_legacy_visuals, &js_legacy_visuals, "charOverlap");
        assert_same_string(&json_legacy_visuals, &js_legacy_visuals, "controlMarks");
        let json_marks = Array::from(&prop(&json_text, "controlMarks"));
        let js_marks = Array::from(&prop(&js_text, "controlMarks"));
        assert_eq!(json_marks.length(), 1);
        assert_eq!(json_marks.length(), js_marks.length());
        assert_same_string(&json_marks.get(0), &js_marks.get(0), "kind");
        assert_same_string(&json_marks.get(0), &js_marks.get(0), "text");
        assert_same_number(&json_marks.get(0), &js_marks.get(0), "x");
        assert_same_number(&json_marks.get(0), &js_marks.get(0), "fontSize");

        let json_image = json_ops.get(1);
        let js_image = js_ops.get(1);
        assert_same_string(&json_image, &js_image, "type");
        assert_same_string(&json_image, &js_image, "fillMode");
        assert_same_string(&json_image, &js_image, "effect");
        assert_eq!(number_prop(&js_image, "resourceId"), 0.0);
        assert_same_number(&prop(&json_image, "crop"), &prop(&js_image, "crop"), "top");
        assert_same_number(
            &prop(&json_image, "crop"),
            &prop(&js_image, "crop"),
            "bottom",
        );
        let json_crop_reference = Array::from(&prop(&json_image, "originalSizeHu"));
        let js_crop_reference = Array::from(&prop(&js_image, "originalSizeHu"));
        assert_eq!(json_crop_reference.length(), 2);
        assert_eq!(js_crop_reference.length(), 2);
        assert_eq!(json_crop_reference.get(0), js_crop_reference.get(0));
        assert_eq!(json_crop_reference.get(1), js_crop_reference.get(1));

        let json_equation = json_ops.get(2);
        let js_equation = js_ops.get(2);
        assert_same_string(&json_equation, &js_equation, "type");
        assert_eq!(string_prop(&json_equation, "svgContent"), svg_fragment);
        assert_eq!(number_prop(&js_equation, "svgResourceId"), 0.0);

        let resources = prop(&js_value, "resources");
        let images = Array::from(&prop(&resources, "images"));
        let image_hashes = Array::from(&prop(&resources, "imageHashes"));
        let image_keys = Array::from(&prop(&resources, "imageKeys"));
        let svg_fragments = Array::from(&prop(&resources, "svgFragments"));
        let svg_hashes = Array::from(&prop(&resources, "svgHashes"));
        let svg_keys = Array::from(&prop(&resources, "svgKeys"));
        let font_blobs = Array::from(&prop(&resources, "fontBlobs"));
        let font_blob_hashes = Array::from(&prop(&resources, "fontBlobHashes"));
        let font_blob_keys = Array::from(&prop(&resources, "fontBlobKeys"));

        let image_digest = resource_digest_hex(&image_bytes);
        let image_key = image_resource_key(image_bytes.len(), &image_digest);
        let svg_digest = resource_digest_hex(&svg_fragment);
        let svg_key = svg_resource_key(svg_fragment.len(), &svg_digest);
        let font_bytes = [5_u8, 4, 3, 2];
        let font_digest = resource_digest_hex(font_bytes);
        let font_key = font_blob_resource_key(font_bytes.len(), &font_digest);

        assert_eq!(
            Uint8Array::new(&images.get(0)).length(),
            image_bytes.len() as u32
        );
        assert_eq!(string_value(&image_hashes.get(0)), image_digest);
        assert_eq!(string_value(&image_keys.get(0)), image_key);
        assert_eq!(string_value(&svg_fragments.get(0)), svg_fragment);
        assert_eq!(string_value(&svg_hashes.get(0)), svg_digest);
        assert_eq!(string_value(&svg_keys.get(0)), svg_key);
        assert_eq!(
            Uint8Array::new(&font_blobs.get(0)).length(),
            font_bytes.len() as u32
        );
        assert_eq!(string_value(&font_blob_hashes.get(0)), font_digest);
        assert_eq!(string_value(&font_blob_keys.get(0)), font_key);
    }

    #[wasm_bindgen_test]
    fn exports_json_and_js_value_v2_compat_schema_parity() {
        let source = TextSourceSpan {
            id: crate::paint::TextSourceId(0),
            utf8_range: TextSourceRange::new(0, 1),
            utf16_range: TextSourceRange::new(0, 1),
            stable_source_key: None,
        };
        let tree = PageLayerTree::new(
            40.0,
            40.0,
            LayerNode::leaf(
                BoundingBox::new(0.0, 0.0, 40.0, 40.0),
                None,
                vec![PaintOp::TextRun {
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
                }],
            ),
        );

        let json_value = js_sys::JSON::parse(
            &tree
                .to_json_v2_compat()
                .unwrap_or_else(|issues| panic!("unexpected v2 validation issues: {issues:?}")),
        )
        .unwrap_or_else(|_| panic!("failed to parse v2 compat layer JSON export"));
        let js_value = page_layer_tree_to_js_value_v2_compat(&tree)
            .unwrap_or_else(|issues| panic!("unexpected v2 validation issues: {issues:?}"));

        assert_same_number(&json_value, &js_value, "schemaVersion");
        assert_same_number(&json_value, &js_value, "schemaMinorVersion");
        assert_eq!(number_prop(&js_value, "schemaVersion"), 2.0);
        let json_required_features = Array::from(&prop(&json_value, "requiredFeatures"));
        let js_required_features = Array::from(&prop(&js_value, "requiredFeatures"));
        assert_eq!(json_required_features.length(), 2);
        assert_eq!(
            json_required_features.length(),
            js_required_features.length()
        );
        let json_text_v2_contract = prop(&json_value, "textV2");
        let js_text_v2_contract = prop(&js_value, "textV2");
        assert_same_string(&json_text_v2_contract, &js_text_v2_contract, "profile");
        assert_same_string(&json_text_v2_contract, &js_text_v2_contract, "canonicalOp");
        assert_same_string(
            &json_text_v2_contract,
            &js_text_v2_contract,
            "paintOrderSlots",
        );

        let json_ops = Array::from(&prop(&prop(&json_value, "root"), "ops"));
        let js_ops = Array::from(&prop(&prop(&js_value, "root"), "ops"));
        assert_eq!(json_ops.length(), 1);
        assert_eq!(json_ops.length(), js_ops.length());
        let json_text = json_ops.get(0);
        let js_text = js_ops.get(0);
        assert_same_string(&json_text, &js_text, "type");
        assert_eq!(string_prop(&js_text, "type"), "text");
        assert_same_string(&json_text, &js_text, "id");
        assert_same_string(&json_text, &js_text, "paintOrderSlotId");
        assert_same_string(&json_text, &js_text, "selectionPolicy");
        assert_same_string(&json_text, &js_text, "defaultVariantId");
        assert_same_string(&json_text, &js_text, "fallbackPolicy");

        let json_variants = Array::from(&prop(&json_text, "variants"));
        let js_variants = Array::from(&prop(&js_text, "variants"));
        assert_eq!(json_variants.length(), 1);
        assert_eq!(json_variants.length(), js_variants.length());
        let json_variant = json_variants.get(0);
        let js_variant = js_variants.get(0);
        assert_same_string(&json_variant, &js_variant, "variantId");
        assert_same_string(&json_variant, &js_variant, "kind");
        let json_parts = Array::from(&prop(&json_variant, "parts"));
        let js_parts = Array::from(&prop(&js_variant, "parts"));
        assert_eq!(json_parts.length(), 1);
        assert_eq!(json_parts.length(), js_parts.length());
        let json_part = json_parts.get(0);
        let js_part = js_parts.get(0);
        assert_same_number(&json_part, &js_part, "partIndex");
        assert_same_number(&json_part, &js_part, "partCount");
        assert_same_string(
            &prop(&json_part, "payload"),
            &prop(&js_part, "payload"),
            "type",
        );
        assert_eq!(string_prop(&prop(&js_part, "payload"), "type"), "textRun");
        assert_same_string(
            &prop(&json_part, "payload"),
            &prop(&js_part, "payload"),
            "id",
        );
        assert_eq!(string_prop(&prop(&js_part, "payload"), "id"), "op-text-0");
    }

    #[wasm_bindgen_test]
    fn exports_json_and_js_value_v2_strict_glyph_outline_schema_parity() {
        let source = TextSourceSpan {
            id: crate::paint::TextSourceId(0),
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
            outline: Box::new(crate::paint::LayerGlyphOutlinePaint {
                source,
                variant: PaintVariantMeta {
                    equivalence_group: "text-0".to_string(),
                    variant_id: "glyphOutline".to_string(),
                    variant_kind: crate::paint::TextVariantKind::GlyphOutline,
                    part_index: 0,
                    part_count: 1,
                    is_default_fallback: false,
                    requires: vec!["text.outlineGlyph".to_string()],
                    quality: Some(crate::paint::TextVariantQuality::Exact),
                    anchor_op_id: Some("op-text-0".to_string()),
                    local_paint_order: Some(0),
                },
                payload_kind: crate::paint::GlyphOutlinePayloadKind::MonochromeFill,
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
                paths: vec![crate::paint::LayerGlyphOutlinePath {
                    glyph_id: 42,
                    source_range_utf8: TextSourceRange::new(0, 1),
                    glyph_range: crate::paint::GlyphRange { start: 0, end: 1 },
                    commands: vec![
                        PathCommand::MoveTo(0.0, 0.0),
                        PathCommand::LineTo(10.0, 0.0),
                        PathCommand::LineTo(10.0, 10.0),
                        PathCommand::ClosePath,
                    ],
                    fill_rule: crate::paint::GlyphOutlineFillRule::EvenOdd,
                }],
                diagnostics: GlyphRunDiagnostics {
                    quality: crate::paint::TextVariantQuality::Exact,
                    replay_eligibility: crate::paint::GlyphRunReplayEligibility::Portable,
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
        outline.payload_kind = crate::paint::GlyphOutlinePayloadKind::MonochromeFillStroke;
        outline.stroke = Some(crate::paint::GlyphOutlineStrokeStyle {
            color: 0x000000,
            width_px: 1.0,
            join: crate::paint::GlyphOutlineStrokeJoin::Miter,
            cap: crate::paint::GlyphOutlineStrokeCap::Butt,
            miter_limit: Some(4.0),
            paint_order: crate::paint::GlyphOutlinePaintOrder::FillThenStroke,
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

        let json_value = js_sys::JSON::parse(
            &tree
                .to_json_v2_strict_glyph_outline()
                .unwrap_or_else(|issues| panic!("unexpected v2 validation issues: {issues:?}")),
        )
        .unwrap_or_else(|_| panic!("failed to parse v2 strict layer JSON export"));
        let js_value = page_layer_tree_to_js_value_v2_strict_glyph_outline(&tree)
            .unwrap_or_else(|issues| panic!("unexpected v2 validation issues: {issues:?}"));

        assert_same_number(&json_value, &js_value, "schemaVersion");
        assert_eq!(number_prop(&js_value, "schemaVersion"), 2.0);
        let json_required_features = Array::from(&prop(&json_value, "requiredFeatures"));
        let js_required_features = Array::from(&prop(&js_value, "requiredFeatures"));
        assert_eq!(json_required_features.length(), 5);
        assert_eq!(
            json_required_features.length(),
            js_required_features.length()
        );
        let json_text_contract = prop(&json_value, "text");
        let js_text_contract = prop(&js_value, "text");
        assert_same_string(&json_text_contract, &js_text_contract, "defaultVariant");
        assert_eq!(
            string_prop(&js_text_contract, "defaultVariant"),
            "glyphOutline"
        );
        assert_same_bool(&json_text_contract, &js_text_contract, "fallbackRequired");
        assert_eq!(bool_prop(&js_text_contract, "fallbackRequired"), false);
        let json_text_v2_contract = prop(&json_value, "textV2");
        let js_text_v2_contract = prop(&js_value, "textV2");
        assert_same_string(
            &json_text_v2_contract,
            &js_text_v2_contract,
            "fallbackPolicy",
        );
        assert_eq!(string_prop(&js_text_v2_contract, "fallbackPolicy"), "none");
        assert_same_bool(
            &json_text_v2_contract,
            &js_text_v2_contract,
            "strictVisualFallbackFree",
        );
        assert_eq!(
            bool_prop(&js_text_v2_contract, "strictVisualFallbackFree"),
            true
        );

        let json_ops = Array::from(&prop(&prop(&json_value, "root"), "ops"));
        let js_ops = Array::from(&prop(&prop(&js_value, "root"), "ops"));
        assert_eq!(json_ops.length(), 1);
        assert_eq!(json_ops.length(), js_ops.length());
        let json_text = json_ops.get(0);
        let js_text = js_ops.get(0);
        assert_same_string(&json_text, &js_text, "type");
        assert_eq!(string_prop(&js_text, "type"), "text");
        assert_same_string(&json_text, &js_text, "defaultVariantId");
        assert_eq!(string_prop(&js_text, "defaultVariantId"), "glyphOutline");
        assert_same_string(&json_text, &js_text, "fallbackPolicy");
        assert_eq!(string_prop(&js_text, "fallbackPolicy"), "none");

        let json_variants = Array::from(&prop(&json_text, "variants"));
        let js_variants = Array::from(&prop(&js_text, "variants"));
        assert_eq!(json_variants.length(), 1);
        assert_eq!(json_variants.length(), js_variants.length());
        let json_variant = json_variants.get(0);
        let js_variant = js_variants.get(0);
        assert_same_string(&json_variant, &js_variant, "variantId");
        assert_eq!(string_prop(&js_variant, "variantId"), "glyphOutline");
        assert_same_string(&json_variant, &js_variant, "kind");
        assert_eq!(string_prop(&js_variant, "kind"), "glyphOutline");

        let js_part = Array::from(&prop(&js_variant, "parts")).get(0);
        let payload = prop(&js_part, "payload");
        assert_eq!(string_prop(&payload, "type"), "glyphOutline");
        assert_eq!(string_prop(&payload, "payloadKind"), "monochromeFill");
        let path = Array::from(&prop(&payload, "paths")).get(0);
        assert_eq!(number_prop(&path, "glyphId"), 42.0);
        assert_eq!(number_prop(&prop(&path, "sourceRangeUtf8"), "end"), 1.0);
        assert_eq!(number_prop(&prop(&path, "glyphRange"), "end"), 1.0);

        let stroke_json_value = js_sys::JSON::parse(
            &stroke_tree
                .to_json_v2_strict_glyph_outline()
                .unwrap_or_else(|issues| panic!("unexpected v2 validation issues: {issues:?}")),
        )
        .unwrap_or_else(|_| panic!("failed to parse v2 strict stroke layer JSON export"));
        let stroke_js_value = page_layer_tree_to_js_value_v2_strict_glyph_outline(&stroke_tree)
            .unwrap_or_else(|issues| panic!("unexpected v2 validation issues: {issues:?}"));
        let stroke_json_required_features =
            Array::from(&prop(&stroke_json_value, "requiredFeatures"));
        let stroke_js_required_features = Array::from(&prop(&stroke_js_value, "requiredFeatures"));
        assert_eq!(stroke_json_required_features.length(), 6);
        assert_eq!(
            stroke_json_required_features.length(),
            stroke_js_required_features.length()
        );
        assert_eq!(
            stroke_js_required_features.get(5).as_string().as_deref(),
            Some("text.glyphOutline.monochromeFillStroke")
        );
        let stroke_text = Array::from(&prop(&prop(&stroke_js_value, "root"), "ops")).get(0);
        let stroke_variant = Array::from(&prop(&stroke_text, "variants")).get(0);
        let stroke_part = Array::from(&prop(&stroke_variant, "parts")).get(0);
        let stroke_payload = prop(&stroke_part, "payload");
        assert_eq!(
            string_prop(&stroke_payload, "payloadKind"),
            "monochromeFillStroke"
        );
        let stroke = prop(&stroke_payload, "stroke");
        assert_eq!(number_prop(&stroke, "widthPx"), 1.0);
        assert_eq!(string_prop(&stroke, "join"), "miter");

        let payload_pair_for = |outline_op: PaintOp,
                                expected_features: &[&str]|
         -> (JsValue, JsValue) {
            let payload_tree = PageLayerTree::new(
                40.0,
                40.0,
                LayerNode::leaf(
                    BoundingBox::new(0.0, 0.0, 40.0, 40.0),
                    None,
                    vec![text_run.clone(), outline_op],
                ),
            );
            let json_value = js_sys::JSON::parse(
                &payload_tree
                    .to_json_v2_strict_glyph_outline()
                    .unwrap_or_else(|issues| panic!("unexpected v2 validation issues: {issues:?}")),
            )
            .unwrap_or_else(|_| panic!("failed to parse v2 strict payload JSON export"));
            let js_value = page_layer_tree_to_js_value_v2_strict_glyph_outline(&payload_tree)
                .unwrap_or_else(|issues| panic!("unexpected v2 validation issues: {issues:?}"));

            let json_required_features = Array::from(&prop(&json_value, "requiredFeatures"));
            let js_required_features = Array::from(&prop(&js_value, "requiredFeatures"));
            assert_eq!(
                json_required_features.length(),
                js_required_features.length()
            );
            for index in 0..json_required_features.length() {
                assert_eq!(
                    json_required_features.get(index).as_string(),
                    js_required_features.get(index).as_string()
                );
            }

            let json_text = Array::from(&prop(&prop(&json_value, "root"), "ops")).get(0);
            let js_text = Array::from(&prop(&prop(&js_value, "root"), "ops")).get(0);
            let json_variant = Array::from(&prop(&json_text, "variants")).get(0);
            let js_variant = Array::from(&prop(&js_text, "variants")).get(0);
            let json_variant_features = Array::from(&prop(&json_variant, "requiredFeatures"));
            let js_variant_features = Array::from(&prop(&js_variant, "requiredFeatures"));
            assert_eq!(json_variant_features.length(), js_variant_features.length());
            for index in 0..json_variant_features.length() {
                assert_eq!(
                    json_variant_features.get(index).as_string(),
                    js_variant_features.get(index).as_string()
                );
            }
            for expected_feature in expected_features {
                let top_level_has_feature = (0..js_required_features.length()).any(|index| {
                    js_required_features.get(index).as_string().as_deref()
                        == Some(*expected_feature)
                });
                let variant_has_feature = (0..js_variant_features.length()).any(|index| {
                    js_variant_features.get(index).as_string().as_deref() == Some(*expected_feature)
                });
                assert!(
                    top_level_has_feature,
                    "missing top-level required feature {expected_feature}"
                );
                assert!(
                    variant_has_feature,
                    "missing variant required feature {expected_feature}"
                );
            }
            let json_part = Array::from(&prop(&json_variant, "parts")).get(0);
            let js_part = Array::from(&prop(&js_variant, "parts")).get(0);
            (prop(&json_part, "payload"), prop(&js_part, "payload"))
        };

        let mut color_glyph_outline = glyph_outline.clone();
        let PaintOp::GlyphOutline { outline, .. } = &mut color_glyph_outline else {
            panic!("expected glyph outline");
        };
        let colrv0_source_font_ref = crate::paint::FontColorGlyphRef {
            face_key: Some("fixture-face".to_string()),
            glyph_id: Some(42),
            palette_index: Some(0),
            color_format: Some(crate::paint::ColorGlyphFormat::ColrV0),
        };
        outline.payload_kind = crate::paint::GlyphOutlinePayloadKind::ColorLayers;
        outline.variant.requires = vec![
            "text.glyphOutline.colorLayers".to_string(),
            "text.glyphOutline.colorLayers.colrV0".to_string(),
        ];
        outline.stroke = None;
        outline.color_layers = Some(crate::paint::ColorLayersPayload {
            color_format: crate::paint::ColorGlyphFormat::ColrV0,
            source_font_ref: Some(colrv0_source_font_ref.clone()),
            palette_ref: Some(crate::paint::PaletteRef {
                id: Some("palette-0".to_string()),
                index: Some(0),
                cpal_digest: Some("cpal-digest".to_string()),
            }),
            layers: vec![crate::paint::ColorLayerNode {
                layer_index: Some(0),
                glyph_id: Some(42),
                glyph_range: Some(crate::paint::GlyphRange { start: 0, end: 1 }),
                source_range_utf8: Some(TextSourceRange::new(0, 1)),
                source_font_ref: Some(colrv0_source_font_ref),
                path_index: Some(0),
                commands: Some(vec![PathCommand::MoveTo(0.0, 0.0), PathCommand::ClosePath]),
                fill: Some(crate::paint::ResolvedColor {
                    color_space: Some("srgb".to_string()),
                    rgba: [0.0, 0.0, 1.0, 1.0],
                }),
                fill_rule: Some(crate::paint::GlyphOutlineFillRule::NonZero),
                palette_index: Some(0),
                color: Some(0x0000ff),
                opacity: Some(1.0),
                transform_to_run: Some(LayerAffineTransform {
                    a: 1.0,
                    b: 0.0,
                    c: 0.0,
                    d: 1.0,
                    e: 2.0,
                    f: 3.0,
                }),
            }],
            paint_graph: None,
            source_range_utf8: Some(TextSourceRange::new(0, 1)),
            glyph_range: Some(crate::paint::GlyphRange { start: 0, end: 1 }),
        });
        let (json_color_payload, js_color_payload) = payload_pair_for(
            color_glyph_outline,
            &[
                "text.glyphOutline.colorLayers",
                "text.glyphOutline.colorLayers.colrV0",
            ],
        );
        assert_same_string(&json_color_payload, &js_color_payload, "payloadKind");
        assert_eq!(string_prop(&js_color_payload, "payloadKind"), "colorLayers");
        let json_color_layers = prop(&json_color_payload, "colorLayers");
        let js_color_layers = prop(&js_color_payload, "colorLayers");
        assert_same_string(&json_color_layers, &js_color_layers, "colorFormat");
        assert_eq!(string_prop(&js_color_layers, "colorFormat"), "colrV0");
        assert_same_string(
            &prop(&json_color_layers, "sourceFontRef"),
            &prop(&js_color_layers, "sourceFontRef"),
            "colorFormat",
        );
        let json_color_layer = Array::from(&prop(&json_color_layers, "layers")).get(0);
        let js_color_layer = Array::from(&prop(&js_color_layers, "layers")).get(0);
        assert_eq!(number_prop(&js_color_layer, "glyphId"), 42.0);
        assert_same_string(&json_color_layer, &js_color_layer, "color");
        assert_eq!(
            Array::from(&prop(&prop(&js_color_layer, "fill"), "rgba"))
                .get(2)
                .as_f64()
                .expect("COLRv0 blue channel should be numeric"),
            1.0
        );
        assert_eq!(
            number_prop(&prop(&js_color_layer, "transformToRun"), "e"),
            2.0
        );

        let mut colrv1_glyph_outline = glyph_outline.clone();
        let PaintOp::GlyphOutline { outline, .. } = &mut colrv1_glyph_outline else {
            panic!("expected glyph outline");
        };
        let colrv1_source_font_ref = crate::paint::FontColorGlyphRef {
            face_key: Some("fixture-face".to_string()),
            glyph_id: Some(42),
            palette_index: Some(1),
            color_format: Some(crate::paint::ColorGlyphFormat::ColrV1),
        };
        outline.payload_kind = crate::paint::GlyphOutlinePayloadKind::ColorLayers;
        outline.variant.requires = vec![
            "text.glyphOutline.colorLayers".to_string(),
            "text.glyphOutline.colorLayers.colrV1".to_string(),
        ];
        outline.stroke = None;
        outline.color_layers = Some(crate::paint::ColorLayersPayload {
            color_format: crate::paint::ColorGlyphFormat::ColrV1,
            source_font_ref: Some(colrv1_source_font_ref.clone()),
            palette_ref: None,
            layers: Vec::new(),
            paint_graph: Some(crate::paint::ColorPaintGraphPayload {
                root_node_id: 1,
                nodes: vec![
                    crate::paint::ColorPaintGraphNode {
                        node_id: 1,
                        kind: crate::paint::ColorPaintGraphNodeKind::Transform,
                        solid_path: None,
                        linear_gradient_path: None,
                        radial_gradient_path: None,
                        sweep_gradient_path: None,
                        transform: Some(crate::paint::ColorPaintTransformNode {
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
                    crate::paint::ColorPaintGraphNode {
                        node_id: 2,
                        kind: crate::paint::ColorPaintGraphNodeKind::SolidPath,
                        solid_path: Some(crate::paint::ColorPaintSolidPathNode {
                            commands: vec![
                                PathCommand::MoveTo(0.0, 0.0),
                                PathCommand::LineTo(8.0, 0.0),
                                PathCommand::LineTo(8.0, 8.0),
                                PathCommand::ClosePath,
                            ],
                            fill: crate::paint::ResolvedColor {
                                color_space: Some("srgb".to_string()),
                                rgba: [1.0, 0.0, 0.0, 1.0],
                            },
                            fill_rule: crate::paint::GlyphOutlineFillRule::NonZero,
                            source_glyph_id: Some(42),
                            palette_index: Some(1),
                        }),
                        linear_gradient_path: None,
                        radial_gradient_path: None,
                        sweep_gradient_path: None,
                        transform: None,
                        composite: None,
                        clip: None,
                        source_range_utf8: Some(TextSourceRange::new(0, 1)),
                        glyph_range: Some(crate::paint::GlyphRange { start: 0, end: 1 }),
                        source_font_ref: Some(colrv1_source_font_ref),
                    },
                ],
            }),
            source_range_utf8: Some(TextSourceRange::new(0, 1)),
            glyph_range: Some(crate::paint::GlyphRange { start: 0, end: 1 }),
        });
        let (json_colrv1_payload, js_colrv1_payload) = payload_pair_for(
            colrv1_glyph_outline,
            &[
                "text.glyphOutline.colorLayers",
                "text.glyphOutline.colorLayers.colrV1",
            ],
        );
        assert_same_string(&json_colrv1_payload, &js_colrv1_payload, "payloadKind");
        let js_colrv1_layers = prop(&js_colrv1_payload, "colorLayers");
        assert_eq!(string_prop(&js_colrv1_layers, "colorFormat"), "colrV1");
        let graph = prop(&js_colrv1_layers, "paintGraph");
        assert_eq!(number_prop(&graph, "rootNodeId"), 1.0);
        let nodes = Array::from(&prop(&graph, "nodes"));
        assert_eq!(nodes.length(), 2);
        assert_eq!(string_prop(&nodes.get(0), "kind"), "transform");
        assert_eq!(
            number_prop(&prop(&nodes.get(0), "transform"), "childNodeId"),
            2.0
        );
        assert_eq!(string_prop(&nodes.get(1), "kind"), "solidPath");
        assert_eq!(
            Array::from(&prop(
                &prop(&prop(&nodes.get(1), "solidPath"), "fill"),
                "rgba",
            ))
            .get(0)
            .as_f64()
            .expect("COLRv1 red channel should be numeric"),
            1.0
        );

        let mut bitmap_glyph_outline = glyph_outline.clone();
        let PaintOp::GlyphOutline { outline, .. } = &mut bitmap_glyph_outline else {
            panic!("expected glyph outline");
        };
        outline.payload_kind = crate::paint::GlyphOutlinePayloadKind::BitmapGlyph;
        outline.variant.requires = vec!["text.glyphOutline.bitmapGlyph".to_string()];
        outline.stroke = None;
        outline.bitmap_glyph = Some(crate::paint::BitmapGlyphPayload {
            image_resource_id: crate::paint::ImageResourceId(7),
            source_range_utf8: Some(TextSourceRange::new(0, 1)),
            glyph_range: Some(crate::paint::GlyphRange { start: 0, end: 1 }),
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
            transform_to_run: Some(LayerAffineTransform {
                a: 1.0,
                b: 0.0,
                c: 0.0,
                d: 1.0,
                e: 1.0,
                f: 2.0,
            }),
            strike_ppem: Some((16, 16)),
            strike_selection: Some(crate::paint::BitmapStrikeSelection::ProducerResolved),
            pixel_format: Some("rgba8".to_string()),
            color_space: Some("srgb".to_string()),
            alpha_mode: Some(crate::paint::BitmapAlphaMode::Premultiplied),
            scaling_policy: Some(crate::paint::BitmapGlyphScalingPolicy::ExplicitTransform),
            filtering: Some(crate::paint::BitmapGlyphFiltering::Linear),
        });
        let (json_bitmap_payload, js_bitmap_payload) =
            payload_pair_for(bitmap_glyph_outline, &["text.glyphOutline.bitmapGlyph"]);
        assert_same_string(&json_bitmap_payload, &js_bitmap_payload, "payloadKind");
        assert_eq!(
            string_prop(&js_bitmap_payload, "payloadKind"),
            "bitmapGlyph"
        );
        let json_bitmap = prop(&json_bitmap_payload, "bitmapGlyph");
        let bitmap = prop(&js_bitmap_payload, "bitmapGlyph");
        assert_same_number(&json_bitmap, &bitmap, "imageResourceId");
        assert_eq!(number_prop(&bitmap, "imageResourceId"), 7.0);
        assert_same_number(
            &prop(&json_bitmap, "sourceRangeUtf8"),
            &prop(&bitmap, "sourceRangeUtf8"),
            "start",
        );
        assert_same_number(
            &prop(&json_bitmap, "sourceRangeUtf8"),
            &prop(&bitmap, "sourceRangeUtf8"),
            "end",
        );
        assert_eq!(number_prop(&prop(&bitmap, "sourceRangeUtf8"), "start"), 0.0);
        assert_eq!(number_prop(&prop(&bitmap, "sourceRangeUtf8"), "end"), 1.0);
        assert_same_number(
            &prop(&json_bitmap, "glyphRange"),
            &prop(&bitmap, "glyphRange"),
            "start",
        );
        assert_same_number(
            &prop(&json_bitmap, "glyphRange"),
            &prop(&bitmap, "glyphRange"),
            "end",
        );
        assert_eq!(number_prop(&prop(&bitmap, "glyphRange"), "start"), 0.0);
        assert_eq!(number_prop(&prop(&bitmap, "glyphRange"), "end"), 1.0);
        assert_same_number(
            &prop(&prop(&json_bitmap, "placement"), "runToPage"),
            &prop(&prop(&bitmap, "placement"), "runToPage"),
            "f",
        );
        assert_eq!(
            number_prop(&prop(&prop(&bitmap, "placement"), "runToPage"), "f"),
            12.0
        );
        assert_eq!(number_prop(&prop(&bitmap, "placement"), "baselineY"), 0.0);
        assert_eq!(string_prop(&bitmap, "pixelFormat"), "rgba8");
        assert_eq!(string_prop(&bitmap, "colorSpace"), "srgb");
        assert_eq!(string_prop(&bitmap, "strikeSelection"), "producerResolved");
        let strike_ppem = Array::from(&prop(&bitmap, "strikePpem"));
        assert_eq!(strike_ppem.get(0).as_f64(), Some(16.0));
        assert_eq!(strike_ppem.get(1).as_f64(), Some(16.0));
        assert_eq!(string_prop(&bitmap, "alphaMode"), "premultiplied");
        assert_eq!(string_prop(&bitmap, "scalingPolicy"), "explicitTransform");
        assert_eq!(string_prop(&bitmap, "filtering"), "linear");
        assert_eq!(number_prop(&prop(&bitmap, "transformToRun"), "e"), 1.0);

        let mut srgb_default_bitmap_glyph_outline = glyph_outline.clone();
        let PaintOp::GlyphOutline { outline, .. } = &mut srgb_default_bitmap_glyph_outline else {
            panic!("expected glyph outline");
        };
        outline.payload_kind = crate::paint::GlyphOutlinePayloadKind::BitmapGlyph;
        outline.variant.requires = vec!["text.glyphOutline.bitmapGlyph".to_string()];
        outline.stroke = None;
        outline.bitmap_glyph = Some(crate::paint::BitmapGlyphPayload {
            image_resource_id: crate::paint::ImageResourceId(7),
            source_range_utf8: Some(TextSourceRange::new(0, 1)),
            glyph_range: Some(crate::paint::GlyphRange { start: 0, end: 1 }),
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
        let (json_srgb_default_bitmap_payload, js_srgb_default_bitmap_payload) = payload_pair_for(
            srgb_default_bitmap_glyph_outline,
            &["text.glyphOutline.bitmapGlyph"],
        );
        let json_srgb_default_bitmap = prop(&json_srgb_default_bitmap_payload, "bitmapGlyph");
        let srgb_default_bitmap = prop(&js_srgb_default_bitmap_payload, "bitmapGlyph");
        assert!(
            !Reflect::has(&json_srgb_default_bitmap, &JsValue::from_str("colorSpace"))
                .expect("JSON BitmapGlyph colorSpace presence check should not throw"),
            "JSON BitmapGlyph payload should omit colorSpace when producer leaves it defaulted"
        );
        assert!(
            !Reflect::has(&srgb_default_bitmap, &JsValue::from_str("colorSpace"))
                .expect("JS BitmapGlyph colorSpace presence check should not throw"),
            "JS BitmapGlyph payload should omit colorSpace when producer leaves it defaulted"
        );
        assert_eq!(
            string_prop(&srgb_default_bitmap, "scalingPolicy"),
            "explicitTransform"
        );
        assert_eq!(string_prop(&srgb_default_bitmap, "filtering"), "linear");

        let mut svg_glyph_outline = glyph_outline.clone();
        let PaintOp::GlyphOutline { outline, .. } = &mut svg_glyph_outline else {
            panic!("expected glyph outline");
        };
        outline.payload_kind = crate::paint::GlyphOutlinePayloadKind::SvgGlyph;
        outline.variant.requires = vec!["text.glyphOutline.svgGlyph".to_string()];
        outline.stroke = None;
        outline.svg_glyph = Some(crate::paint::SvgGlyphPayload {
            vector_resource_id: crate::paint::SvgResourceId(3),
            source_range_utf8: Some(TextSourceRange::new(0, 1)),
            glyph_range: Some(crate::paint::GlyphRange { start: 0, end: 1 }),
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
            transform_to_run: Some(LayerAffineTransform {
                a: 1.0,
                b: 0.0,
                c: 0.0,
                d: 1.0,
                e: 4.0,
                f: 5.0,
            }),
            view_box: Some(crate::paint::SvgGlyphViewBox {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            }),
            intrinsic_size: Some(crate::paint::SvgGlyphIntrinsicSize {
                width: 10.0,
                height: 10.0,
            }),
            security_mode: crate::paint::SvgGlyphSecurityMode::StaticSanitized,
            script_allowed: false,
            animation_allowed: false,
            external_resources_allowed: false,
            interactivity_allowed: false,
        });
        let (json_svg_payload, js_svg_payload) =
            payload_pair_for(svg_glyph_outline, &["text.glyphOutline.svgGlyph"]);
        assert_same_string(&json_svg_payload, &js_svg_payload, "payloadKind");
        assert_eq!(string_prop(&js_svg_payload, "payloadKind"), "svgGlyph");
        let json_svg = prop(&json_svg_payload, "svgGlyph");
        let svg = prop(&js_svg_payload, "svgGlyph");
        assert_same_number(&json_svg, &svg, "vectorResourceId");
        assert_eq!(number_prop(&svg, "vectorResourceId"), 3.0);
        assert_same_number(
            &prop(&json_svg, "sourceRangeUtf8"),
            &prop(&svg, "sourceRangeUtf8"),
            "start",
        );
        assert_same_number(
            &prop(&json_svg, "sourceRangeUtf8"),
            &prop(&svg, "sourceRangeUtf8"),
            "end",
        );
        assert_eq!(number_prop(&prop(&svg, "sourceRangeUtf8"), "start"), 0.0);
        assert_eq!(number_prop(&prop(&svg, "sourceRangeUtf8"), "end"), 1.0);
        assert_same_number(
            &prop(&json_svg, "glyphRange"),
            &prop(&svg, "glyphRange"),
            "start",
        );
        assert_same_number(
            &prop(&json_svg, "glyphRange"),
            &prop(&svg, "glyphRange"),
            "end",
        );
        assert_eq!(number_prop(&prop(&svg, "glyphRange"), "start"), 0.0);
        assert_eq!(number_prop(&prop(&svg, "glyphRange"), "end"), 1.0);
        assert_same_number(
            &prop(&prop(&json_svg, "placement"), "runToPage"),
            &prop(&prop(&svg, "placement"), "runToPage"),
            "f",
        );
        assert_eq!(
            number_prop(&prop(&prop(&svg, "placement"), "runToPage"), "f"),
            12.0
        );
        assert_eq!(number_prop(&prop(&svg, "placement"), "baselineY"), 0.0);
        assert_eq!(string_prop(&svg, "securityMode"), "staticSanitized");
        assert_eq!(bool_prop(&svg, "scriptAllowed"), false);
        assert_eq!(bool_prop(&svg, "animationAllowed"), false);
        assert_eq!(bool_prop(&svg, "externalResourcesAllowed"), false);
        assert_eq!(bool_prop(&svg, "interactivityAllowed"), false);
        assert_eq!(number_prop(&prop(&svg, "viewBox"), "width"), 10.0);
        assert_eq!(number_prop(&prop(&svg, "intrinsicSize"), "height"), 10.0);
        assert_eq!(number_prop(&prop(&svg, "transformToRun"), "e"), 4.0);

        let mut minimal_svg_glyph_outline = glyph_outline;
        let PaintOp::GlyphOutline { outline, .. } = &mut minimal_svg_glyph_outline else {
            panic!("expected glyph outline");
        };
        outline.payload_kind = crate::paint::GlyphOutlinePayloadKind::SvgGlyph;
        outline.variant.requires = vec!["text.glyphOutline.svgGlyph".to_string()];
        outline.stroke = None;
        outline.svg_glyph = Some(crate::paint::SvgGlyphPayload {
            vector_resource_id: crate::paint::SvgResourceId(3),
            source_range_utf8: Some(TextSourceRange::new(0, 1)),
            glyph_range: Some(crate::paint::GlyphRange { start: 0, end: 1 }),
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
        let (json_minimal_svg_payload, js_minimal_svg_payload) =
            payload_pair_for(minimal_svg_glyph_outline, &["text.glyphOutline.svgGlyph"]);
        let json_minimal_svg = prop(&json_minimal_svg_payload, "svgGlyph");
        let minimal_svg = prop(&js_minimal_svg_payload, "svgGlyph");
        assert!(
            !Reflect::has(&json_minimal_svg, &JsValue::from_str("intrinsicSize"))
                .expect("JSON SvgGlyph intrinsicSize presence check should not throw"),
            "JSON SvgGlyph payload should omit absent optional intrinsicSize"
        );
        assert!(
            !Reflect::has(&minimal_svg, &JsValue::from_str("intrinsicSize"))
                .expect("JS SvgGlyph intrinsicSize presence check should not throw"),
            "JS SvgGlyph payload should omit absent optional intrinsicSize"
        );
        assert_eq!(string_prop(&minimal_svg, "securityMode"), "staticSanitized");
    }

    #[wasm_bindgen_test]
    fn exports_json_and_js_value_v2_strict_glyph_run_schema_parity() {
        let source = TextSourceSpan {
            id: crate::paint::TextSourceId(0),
            utf8_range: TextSourceRange::new(0, 1),
            utf16_range: TextSourceRange::new(0, 1),
            stable_source_key: None,
        };
        let shape_key = ShapeKey {
            font_instance: crate::paint::FontInstanceKey {
                face_key: crate::paint::FontFaceKey("face-0".to_string()),
                size_px: 12.0,
                variations: Vec::new(),
                synthetic_bold: false,
                synthetic_italic: false,
            },
            direction: crate::paint::TextDirection::Ltr,
            writing_mode: crate::paint::WritingMode::HorizontalTb,
            script: None,
            language: None,
            features: Vec::new(),
            shaping_engine: crate::paint::ShapingEngineId("test".to_string()),
            fallback_policy: crate::paint::FontFallbackPolicyId("none".to_string()),
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
            run: crate::paint::LayerGlyphRunPaint {
                source,
                variant: PaintVariantMeta {
                    equivalence_group: "text-0".to_string(),
                    variant_id: "glyphRun".to_string(),
                    variant_kind: crate::paint::TextVariantKind::GlyphRun,
                    part_index: 0,
                    part_count: 1,
                    is_default_fallback: false,
                    requires: vec!["fontResources".to_string(), "text.glyphRun".to_string()],
                    quality: Some(crate::paint::TextVariantQuality::Exact),
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
                    glyph_range: crate::paint::GlyphRange::new(0, 1),
                    flags: Vec::new(),
                }],
                direction: crate::paint::TextDirection::Ltr,
                bidi_level: None,
                writing_mode: crate::paint::WritingMode::HorizontalTb,
                orientation: crate::paint::GlyphRunOrientation::Horizontal,
                glyph_transforms: None,
                diagnostics: GlyphRunDiagnostics {
                    quality: crate::paint::TextVariantQuality::Exact,
                    replay_eligibility: crate::paint::GlyphRunReplayEligibility::Portable,
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

        let json_value = js_sys::JSON::parse(
            &tree
                .to_json_v2_strict_glyph_run()
                .unwrap_or_else(|issues| panic!("unexpected v2 validation issues: {issues:?}")),
        )
        .unwrap_or_else(|_| panic!("failed to parse v2 strict glyph run JSON export"));
        let js_value = page_layer_tree_to_js_value_v2_strict_glyph_run(&tree)
            .unwrap_or_else(|issues| panic!("unexpected v2 validation issues: {issues:?}"));

        assert_same_number(&json_value, &js_value, "schemaVersion");
        assert_eq!(number_prop(&js_value, "schemaVersion"), 2.0);
        let json_required_features = Array::from(&prop(&json_value, "requiredFeatures"));
        let js_required_features = Array::from(&prop(&js_value, "requiredFeatures"));
        assert_eq!(json_required_features.length(), 5);
        assert_eq!(
            json_required_features.length(),
            js_required_features.length()
        );
        assert_eq!(
            js_required_features.get(3).as_string().as_deref(),
            Some("fontResources")
        );
        assert_eq!(
            js_required_features.get(4).as_string().as_deref(),
            Some("text.glyphRun")
        );
        let js_text_contract = prop(&js_value, "text");
        assert_eq!(string_prop(&js_text_contract, "defaultVariant"), "glyphRun");
        assert_eq!(bool_prop(&js_text_contract, "fallbackRequired"), false);
        let js_text_v2_contract = prop(&js_value, "textV2");
        assert_eq!(string_prop(&js_text_v2_contract, "fallbackPolicy"), "none");
        assert_eq!(
            bool_prop(&js_text_v2_contract, "strictVisualFallbackFree"),
            true
        );

        let json_ops = Array::from(&prop(&prop(&json_value, "root"), "ops"));
        let js_ops = Array::from(&prop(&prop(&js_value, "root"), "ops"));
        assert_eq!(json_ops.length(), 1);
        assert_eq!(json_ops.length(), js_ops.length());
        let js_text = js_ops.get(0);
        assert_eq!(string_prop(&js_text, "type"), "text");
        assert_eq!(string_prop(&js_text, "defaultVariantId"), "glyphRun");
        assert_eq!(string_prop(&js_text, "fallbackPolicy"), "none");

        let js_variants = Array::from(&prop(&js_text, "variants"));
        assert_eq!(js_variants.length(), 1);
        let js_variant = js_variants.get(0);
        assert_eq!(string_prop(&js_variant, "variantId"), "glyphRun");
        assert_eq!(string_prop(&js_variant, "kind"), "glyphRun");
        let js_part = Array::from(&prop(&js_variant, "parts")).get(0);
        let payload = prop(&js_part, "payload");
        assert_eq!(string_prop(&payload, "type"), "glyphRun");
        assert_eq!(
            Array::from(&prop(&payload, "glyphIds"))
                .get(0)
                .as_f64()
                .unwrap_or_else(|| panic!("glyph id must be numeric")),
            42.0
        );
    }

    #[wasm_bindgen_test]
    fn rejects_js_value_v2_strict_glyph_outline_without_strict_outline() {
        let tree = PageLayerTree::new(
            40.0,
            40.0,
            LayerNode::leaf(
                BoundingBox::new(0.0, 0.0, 40.0, 40.0),
                None,
                vec![PaintOp::TextRun {
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
                }],
            ),
        );

        let issues = match page_layer_tree_to_js_value_v2_strict_glyph_outline(&tree) {
            Ok(_) => panic!("strict GlyphOutline JS value export should reject TextRun fallback"),
            Err(issues) => issues,
        };
        assert_eq!(issues.len(), 1);
        assert_eq!(
            issues[0].code,
            TextV2ValidationIssueCode::StrictVisualVariantMissing
        );
    }

    #[wasm_bindgen_test]
    fn exports_text_v2_validation_issues_to_js_value() {
        let issues =
            vec![TextV2ValidationIssue {
            code: crate::paint::TextV2ValidationIssueCode::DefaultVariantMissing,
            op_id: "text-0".to_string(),
            paint_order_slot_id: Some("slot-0".to_string()),
            variant_id: Some("glyphRun".to_string()),
            part_index: Some(2),
        }, TextV2ValidationIssue {
            code: crate::paint::TextV2ValidationIssueCode::GlyphOutlinePayloadKindFeatureMissing,
            op_id: "text-1".to_string(),
            paint_order_slot_id: Some("slot-1".to_string()),
            variant_id: Some("glyphOutline".to_string()),
            part_index: Some(0),
        }];

        let value = text_v2_validation_issues_to_js_value(&issues);
        let array = Array::from(&value);
        assert_eq!(array.length(), 2);
        let issue = array.get(0);
        assert_eq!(string_prop(&issue, "code"), "defaultVariantMissing");
        assert_eq!(string_prop(&issue, "opId"), "text-0");
        assert_eq!(string_prop(&issue, "paintOrderSlotId"), "slot-0");
        assert_eq!(string_prop(&issue, "variantId"), "glyphRun");
        assert_eq!(number_prop(&issue, "partIndex"), 2.0);
        let reserved_payload_issue = array.get(1);
        assert_eq!(
            string_prop(&reserved_payload_issue, "code"),
            "glyphOutlinePayloadKindFeatureMissing"
        );
    }

    #[wasm_bindgen_test]
    fn exports_glyph_outline_stroke_style_to_js_value() {
        let value = glyph_outline_stroke_style_to_value(&GlyphOutlineStrokeStyle {
            color: 0x112233,
            width_px: 1.5,
            join: crate::paint::GlyphOutlineStrokeJoin::Round,
            cap: crate::paint::GlyphOutlineStrokeCap::Square,
            miter_limit: Some(3.0),
            paint_order: crate::paint::GlyphOutlinePaintOrder::FillThenStroke,
        });

        assert_eq!(string_prop(&value, "color"), "#332211");
        assert_eq!(number_prop(&value, "widthPx"), 1.5);
        assert_eq!(string_prop(&value, "join"), "round");
        assert_eq!(string_prop(&value, "cap"), "square");
        assert_eq!(number_prop(&value, "miterLimit"), 3.0);
        assert_eq!(string_prop(&value, "paintOrder"), "fillThenStroke");
    }

    #[wasm_bindgen_test]
    fn resource_hints_keep_stable_keys_while_omitting_known_payloads() {
        let image_bytes = vec![9, 8, 7, 6];
        let svg_fragment = "<path d=\"M0 0L4 4\"/>".to_string();
        let tree = layer_tree_fixture(&image_bytes, &svg_fragment);

        let image_digest = resource_digest_hex(&image_bytes);
        let image_key = image_resource_key(image_bytes.len(), &image_digest);
        let svg_digest = resource_digest_hex(&svg_fragment);
        let svg_key = svg_resource_key(svg_fragment.len(), &svg_digest);

        let known_image_keys = Array::new();
        known_image_keys.push(&JsValue::from_str(&image_key));
        let known_svg_keys = Array::new();
        known_svg_keys.push(&JsValue::from_str(&svg_key));
        let hints = LayerResourceExportHints::from_js_values(
            &known_image_keys.into(),
            &known_svg_keys.into(),
        );

        let hinted_value = page_layer_tree_to_js_value_with_resource_hints(&tree, &hints);
        let resources = prop(&hinted_value, "resources");
        let images = Array::from(&prop(&resources, "images"));
        let image_hashes = Array::from(&prop(&resources, "imageHashes"));
        let image_keys = Array::from(&prop(&resources, "imageKeys"));
        let svg_fragments = Array::from(&prop(&resources, "svgFragments"));
        let svg_hashes = Array::from(&prop(&resources, "svgHashes"));
        let svg_keys = Array::from(&prop(&resources, "svgKeys"));

        assert_eq!(images.length(), 0);
        assert_eq!(svg_fragments.length(), 0);
        assert_eq!(string_value(&image_hashes.get(0)), image_digest);
        assert_eq!(string_value(&image_keys.get(0)), image_key);
        assert_eq!(string_value(&svg_hashes.get(0)), svg_digest);
        assert_eq!(string_value(&svg_keys.get(0)), svg_key);
    }

    fn layer_tree_fixture(image_bytes: &[u8], svg_fragment: &str) -> PageLayerTree {
        let mut resources = ResourceArena::default();
        let image_id = resources.intern_image_bytes(image_bytes);
        let svg_id = resources.intern_svg_fragment(svg_fragment);
        resources.intern_font_blob_bytes(&[5, 4, 3, 2]);

        PageLayerTree::with_resources(
            120.0,
            80.0,
            LayerNode::leaf(
                BoundingBox::new(0.0, 0.0, 120.0, 80.0),
                None,
                vec![
                    PaintOp::TextRun {
                        bbox: BoundingBox::new(8.0, 10.0, 80.0, 16.0),
                        run: LayerTextRunPaint {
                            source: None,
                            text: "marker".to_string(),
                            style: TextStyle {
                                font_family: "Noto Sans KR".to_string(),
                                font_size: 12.0,
                                color: 0x00112233,
                                ..Default::default()
                            },
                            positions: vec![0.0, 7.0, 14.0, 21.0, 28.0, 35.0, 42.0],
                            control_marks: vec![LayerTextControlMark {
                                kind: LayerTextControlMarkKind::LineBreakEnd,
                                x: 80.0,
                                y: 0.0,
                                font_size: 12.0,
                            }],
                            is_para_end: true,
                            is_line_break_end: true,
                            rotation: 15.0,
                            is_vertical: true,
                            orientation: LayerTextOrientation::VerticalSideways,
                            char_overlap: Some(CharOverlapInfo {
                                border_type: 3,
                                inner_char_size: 85,
                            }),
                            baseline: 11.0,
                            field_marker: FieldMarkerType::ShapeMarker(4),
                            ..Default::default()
                        },
                    },
                    PaintOp::Image {
                        bbox: BoundingBox::new(12.0, 28.0, 24.0, 20.0),
                        image: LayerImagePaint {
                            resource_id: Some(image_id),
                            external_path: None,
                            text_wrap: None,
                            fill_mode: Some(ImageFillMode::Center),
                            original_size: Some((32.0, 24.0)),
                            crop: Some((1, 2, 31, 22)),
                            original_size_hu: Some((32, 24)),
                            brightness: 0,
                            contrast: 0,
                            effect: ImageEffect::BlackWhite,
                            transform: ShapeTransform::default(),
                        },
                    },
                    PaintOp::Equation {
                        bbox: BoundingBox::new(40.0, 52.0, 24.0, 16.0),
                        equation: LayerEquationPaint {
                            svg_resource_id: svg_id,
                            layout_box: LayoutBox {
                                x: 0.0,
                                y: 0.0,
                                width: 24.0,
                                height: 16.0,
                                baseline: 12.0,
                                kind: LayoutKind::Text("x".to_string()),
                            },
                            color_str: "#112233".to_string(),
                            color: 0x00332211,
                            font_size: 14.0,
                        },
                    },
                ],
            ),
            resources,
        )
        .with_output_options(LayerOutputOptions {
            show_paragraph_marks: true,
            show_control_codes: true,
            show_transparent_borders: true,
            clip_enabled: false,
            debug_overlay: true,
        })
    }

    fn prop(value: &JsValue, name: &str) -> JsValue {
        Reflect::get(value, &JsValue::from_str(name))
            .unwrap_or_else(|_| panic!("failed to read JS property {name}"))
    }

    fn number_prop(value: &JsValue, name: &str) -> f64 {
        prop(value, name)
            .as_f64()
            .unwrap_or_else(|| panic!("JS property {name} is not a number"))
    }

    fn string_prop(value: &JsValue, name: &str) -> String {
        string_value(&prop(value, name))
    }

    fn string_value(value: &JsValue) -> String {
        value
            .as_string()
            .unwrap_or_else(|| panic!("JS value is not a string"))
    }

    fn bool_prop(value: &JsValue, name: &str) -> bool {
        prop(value, name)
            .as_bool()
            .unwrap_or_else(|| panic!("JS property {name} is not a bool"))
    }

    fn assert_same_number(left: &JsValue, right: &JsValue, name: &str) {
        assert_eq!(number_prop(left, name), number_prop(right, name), "{name}");
    }

    fn assert_close_number(left: &JsValue, right: &JsValue, name: &str, tolerance: f64) {
        let left = number_prop(left, name);
        let right = number_prop(right, name);
        assert!(
            (left - right).abs() <= tolerance,
            "{name}: left={left} right={right}"
        );
    }

    fn assert_same_string(left: &JsValue, right: &JsValue, name: &str) {
        assert_eq!(string_prop(left, name), string_prop(right, name), "{name}");
    }

    fn assert_same_bool(left: &JsValue, right: &JsValue, name: &str) {
        assert_eq!(bool_prop(left, name), bool_prop(right, name), "{name}");
    }
}
