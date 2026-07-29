//! Page rendering and layer export bindings for `HwpDocument`.

use wasm_bindgen::prelude::*;
#[cfg(target_arch = "wasm32")]
use web_sys::HtmlCanvasElement;

#[cfg(target_arch = "wasm32")]
use crate::paint::js_value::{
    page_layer_tree_to_js_value, page_layer_tree_to_js_value_v2_compat,
    page_layer_tree_to_js_value_v2_compat_with_resource_hints,
    page_layer_tree_to_js_value_v2_strict_glyph_outline,
    page_layer_tree_to_js_value_v2_strict_glyph_outline_with_resource_hints,
    page_layer_tree_to_js_value_v2_strict_glyph_run,
    page_layer_tree_to_js_value_v2_strict_glyph_run_with_resource_hints,
    page_layer_tree_to_js_value_with_resource_hints, text_v2_validation_issues_to_js_value,
    LayerResourceExportHints,
};
use crate::paint::{text_v2_validation_issues_to_json, RenderProfile};

use super::HwpDocument;

const MAX_CANVAS_DIMENSION: f64 = 16384.0;

fn normalize_canvas_scale(
    page_width: f64,
    page_height: f64,
    requested_scale: f64,
) -> Result<f64, &'static str> {
    if !page_width.is_finite()
        || !page_height.is_finite()
        || page_width <= 0.0
        || page_height <= 0.0
    {
        return Err("invalid page dimensions");
    }

    let scale = if requested_scale <= 0.0 || !requested_scale.is_finite() {
        1.0
    } else {
        requested_scale.clamp(0.25, 12.0)
    };

    let scaled_width = page_width * scale;
    let scaled_height = page_height * scale;
    if !scaled_width.is_finite() || !scaled_height.is_finite() {
        return Ok((MAX_CANVAS_DIMENSION / page_width)
            .min(MAX_CANVAS_DIMENSION / page_height)
            .min(scale));
    }

    if scaled_width > MAX_CANVAS_DIMENSION || scaled_height > MAX_CANVAS_DIMENSION {
        Ok((MAX_CANVAS_DIMENSION / page_width)
            .min(MAX_CANVAS_DIMENSION / page_height)
            .min(scale))
    } else {
        Ok(scale)
    }
}

#[cfg(any(target_arch = "wasm32", test))]
fn scaled_canvas_extent(page_extent: f64, scale: f64) -> u32 {
    (page_extent * scale)
        .ceil()
        .clamp(1.0, MAX_CANVAS_DIMENSION) as u32
}

#[wasm_bindgen]
impl HwpDocument {
    /// 특정 페이지를 SVG 문자열로 렌더링한다.
    #[wasm_bindgen(js_name = renderPageSvg)]
    pub fn render_page_svg(&self, page_num: u32) -> Result<String, JsValue> {
        self.render_page_svg_native(page_num).map_err(|e| e.into())
    }

    /// 특정 페이지를 legacy SVG 렌더러로 렌더링한다.
    #[wasm_bindgen(js_name = renderPageSvgLegacy)]
    pub fn render_page_svg_legacy(&self, page_num: u32) -> Result<String, JsValue> {
        self.render_page_svg_legacy_native(page_num)
            .map_err(|e| e.into())
    }

    /// 특정 페이지를 PageLayerTree 기반 SVG replay 경로로 렌더링한다.
    #[wasm_bindgen(js_name = renderPageSvgLayer)]
    pub fn render_page_svg_layer(&self, page_num: u32) -> Result<String, JsValue> {
        self.render_page_svg_layer_native(page_num)
            .map_err(|e| e.into())
    }

    /// 특정 페이지를 HTML 문자열로 렌더링한다.
    #[wasm_bindgen(js_name = renderPageHtml)]
    pub fn render_page_html(&self, page_num: u32) -> Result<String, JsValue> {
        self.render_page_html_native(page_num).map_err(|e| e.into())
    }

    /// 특정 페이지를 Canvas 명령 수로 반환한다.
    #[wasm_bindgen(js_name = renderPageCanvas)]
    pub fn render_page_canvas(&self, page_num: u32) -> Result<u32, JsValue> {
        self.render_page_canvas_native(page_num)
            .map_err(|e| e.into())
    }

    /// 특정 페이지를 Canvas 2D에 직접 렌더링한다.
    ///
    /// WASM 환경에서만 사용 가능하다. Canvas 크기는 페이지 크기 × scale로 설정된다.
    /// scale이 0 이하이면 1.0으로 처리한다 (하위호환).
    #[cfg(target_arch = "wasm32")]
    #[wasm_bindgen(js_name = renderPageToCanvas)]
    pub fn render_page_to_canvas(
        &self,
        page_num: u32,
        canvas: &HtmlCanvasElement,
        scale: f64,
    ) -> Result<(), JsValue> {
        use crate::renderer::web_canvas::WebCanvasRenderer;

        let tree = self
            .build_page_layer_tree_for_output(page_num, RenderProfile::Screen)
            .map_err(|e| JsValue::from(e))?;

        let scale = normalize_canvas_scale(tree.page_width, tree.page_height, scale)
            .map_err(JsValue::from_str)?;

        // Preserve the final fractional page pixel instead of truncating the
        // right and bottom edges of the bitmap.
        canvas.set_width(scaled_canvas_extent(tree.page_width, scale));
        canvas.set_height(scaled_canvas_extent(tree.page_height, scale));

        let mut renderer = WebCanvasRenderer::new(canvas)?;
        renderer.show_paragraph_marks = self.show_paragraph_marks;
        renderer.show_control_codes = self.show_control_codes;
        renderer.set_scale(scale);
        renderer.render_layer_tree(&tree);
        Ok(())
    }

    /// 페이지 렌더 트리를 JSON 문자열로 반환한다.
    #[wasm_bindgen(js_name = getPageRenderTree)]
    pub fn get_page_render_tree(&self, page_num: u32) -> Result<String, JsValue> {
        let tree = self
            .build_page_tree_cached(page_num)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(tree.root.to_json())
    }

    /// 페이지 레이어 트리를 JSON 문자열로 반환한다.
    #[wasm_bindgen(js_name = getPageLayerTree)]
    pub fn get_page_layer_tree(&self, page_num: u32) -> Result<String, JsValue> {
        self.get_page_layer_tree_native(page_num)
            .map_err(|e| e.into())
    }

    /// CanvasKit direct replay 정책 진단을 JSON 문자열로 반환한다.
    ///
    /// `mode` 는 `"default"` 또는 `"compat"` 를 받는다. 빈 문자열은 `"default"` 로 처리한다.
    /// 현재 두 mode 모두 hidden Canvas2D overlay 없이 direct replay required 정책을 따른다.
    /// `compat` 는 API/URL 호환성과 이후 보수적인 direct replay 튜닝을 위해 남겨 둔 선택지다.
    #[wasm_bindgen(js_name = getCanvasKitReplayPlan)]
    pub fn get_canvaskit_replay_plan(&self, page_num: u32, mode: &str) -> Result<String, JsValue> {
        self.get_canvaskit_replay_plan_native(page_num, mode)
            .map_err(|e| e.into())
    }

    /// 명시한 render profile로 CanvasKit direct replay 정책 진단을 생성한다.
    #[wasm_bindgen(js_name = getCanvasKitReplayPlanWithProfile)]
    pub fn get_canvaskit_replay_plan_with_profile(
        &self,
        page_num: u32,
        mode: &str,
        profile_name: &str,
    ) -> Result<String, JsValue> {
        let profile = Self::parse_layer_render_profile(profile_name, RenderProfile::Screen)?;
        self.get_canvaskit_replay_plan_with_profile_native(page_num, mode, profile)
            .map_err(|e| e.into())
    }

    /// 문서 전체의 bounded CanvasKit direct replay capability를 반환한다.
    #[wasm_bindgen(js_name = getCanvasKitDocumentPreflight)]
    pub fn get_canvaskit_document_preflight(
        &self,
        mode: &str,
        profile_name: &str,
    ) -> Result<String, JsValue> {
        let profile = Self::parse_layer_render_profile(profile_name, RenderProfile::Screen)?;
        self.get_canvaskit_document_preflight_native(mode, profile)
            .map_err(|e| e.into())
    }

    /// 페이지 레이어 트리를 JSON 문자열로 반환한다. profile을 명시적으로 덮어쓸 수 있다.
    #[wasm_bindgen(js_name = getPageLayerTreeWithProfile)]
    pub fn get_page_layer_tree_with_profile(
        &self,
        page_num: u32,
        profile_name: &str,
    ) -> Result<String, JsValue> {
        let profile = Self::parse_layer_render_profile(profile_name, RenderProfile::Screen)?;
        self.get_page_layer_tree_with_profile_native(page_num, profile)
            .map_err(|e| e.into())
    }

    /// 페이지 레이어 트리를 schema v2 compatibility JSON 문자열로 반환한다.
    #[wasm_bindgen(js_name = getPageLayerTreeV2Compat)]
    pub fn get_page_layer_tree_v2_compat(&self, page_num: u32) -> Result<String, JsValue> {
        self.get_page_layer_tree_v2_compat_with_profile(page_num, RenderProfile::Screen.as_str())
    }

    /// 페이지 레이어 트리를 schema v2 compatibility JSON 문자열로 반환한다.
    /// profile을 명시적으로 덮어쓸 수 있다.
    #[wasm_bindgen(js_name = getPageLayerTreeV2CompatWithProfile)]
    pub fn get_page_layer_tree_v2_compat_with_profile(
        &self,
        page_num: u32,
        profile_name: &str,
    ) -> Result<String, JsValue> {
        let profile = Self::parse_layer_render_profile(profile_name, RenderProfile::Screen)?;
        let tree = self
            .build_page_layer_tree_for_output(page_num, profile)
            .map_err(JsValue::from)?;
        tree.to_json_v2_compat()
            .map_err(|issues| JsValue::from_str(&text_v2_validation_issues_to_json(&issues)))
    }

    /// 페이지 레이어 트리를 schema v2 strictVisual GlyphOutline JSON 문자열로 반환한다.
    #[wasm_bindgen(js_name = getPageLayerTreeV2StrictGlyphOutline)]
    pub fn get_page_layer_tree_v2_strict_glyph_outline(
        &self,
        page_num: u32,
    ) -> Result<String, JsValue> {
        self.get_page_layer_tree_v2_strict_glyph_outline_with_profile(
            page_num,
            RenderProfile::Screen.as_str(),
        )
    }

    /// 페이지 레이어 트리를 schema v2 strictVisual GlyphOutline JSON 문자열로 반환한다.
    /// profile을 명시적으로 덮어쓸 수 있다.
    #[wasm_bindgen(js_name = getPageLayerTreeV2StrictGlyphOutlineWithProfile)]
    pub fn get_page_layer_tree_v2_strict_glyph_outline_with_profile(
        &self,
        page_num: u32,
        profile_name: &str,
    ) -> Result<String, JsValue> {
        let profile = Self::parse_layer_render_profile(profile_name, RenderProfile::Screen)?;
        let tree = self
            .build_page_layer_tree_for_output(page_num, profile)
            .map_err(JsValue::from)?;
        tree.to_json_v2_strict_glyph_outline()
            .map_err(|issues| JsValue::from_str(&text_v2_validation_issues_to_json(&issues)))
    }

    /// 페이지 레이어 트리를 schema v2 strictVisual GlyphRun JSON 문자열로 반환한다.
    #[wasm_bindgen(js_name = getPageLayerTreeV2StrictGlyphRun)]
    pub fn get_page_layer_tree_v2_strict_glyph_run(
        &self,
        page_num: u32,
    ) -> Result<String, JsValue> {
        self.get_page_layer_tree_v2_strict_glyph_run_with_profile(
            page_num,
            RenderProfile::Screen.as_str(),
        )
    }

    /// 페이지 레이어 트리를 schema v2 strictVisual GlyphRun JSON 문자열로 반환한다.
    /// profile을 명시적으로 덮어쓸 수 있다.
    #[wasm_bindgen(js_name = getPageLayerTreeV2StrictGlyphRunWithProfile)]
    pub fn get_page_layer_tree_v2_strict_glyph_run_with_profile(
        &self,
        page_num: u32,
        profile_name: &str,
    ) -> Result<String, JsValue> {
        let profile = Self::parse_layer_render_profile(profile_name, RenderProfile::Screen)?;
        let tree = self
            .build_page_layer_tree_for_output(page_num, profile)
            .map_err(JsValue::from)?;
        tree.to_json_v2_strict_glyph_run()
            .map_err(|issues| JsValue::from_str(&text_v2_validation_issues_to_json(&issues)))
    }

    /// 페이지 레이어 트리를 JS object로 반환한다.
    #[cfg(target_arch = "wasm32")]
    #[wasm_bindgen(js_name = getPageLayerTreeValue)]
    pub fn get_page_layer_tree_value(&self, page_num: u32) -> Result<JsValue, JsValue> {
        let tree = self
            .build_page_layer_tree_for_output(page_num, RenderProfile::Screen)
            .map_err(JsValue::from)?;
        Ok(page_layer_tree_to_js_value(&tree))
    }

    /// 페이지 레이어 트리를 JS object로 반환한다. profile을 명시적으로 덮어쓸 수 있다.
    #[cfg(target_arch = "wasm32")]
    #[wasm_bindgen(js_name = getPageLayerTreeValueWithProfile)]
    pub fn get_page_layer_tree_value_with_profile(
        &self,
        page_num: u32,
        profile_name: &str,
    ) -> Result<JsValue, JsValue> {
        let profile = Self::parse_layer_render_profile(profile_name, RenderProfile::Screen)?;
        let tree = self
            .build_page_layer_tree_for_output(page_num, profile)
            .map_err(JsValue::from)?;
        Ok(page_layer_tree_to_js_value(&tree))
    }

    /// 페이지 레이어 트리를 schema v2 compatibility JS object로 반환한다.
    #[cfg(target_arch = "wasm32")]
    #[wasm_bindgen(js_name = getPageLayerTreeValueV2Compat)]
    pub fn get_page_layer_tree_value_v2_compat(&self, page_num: u32) -> Result<JsValue, JsValue> {
        self.get_page_layer_tree_value_v2_compat_with_profile(
            page_num,
            RenderProfile::Screen.as_str(),
        )
    }

    /// 페이지 레이어 트리를 schema v2 compatibility JS object로 반환한다.
    /// profile을 명시적으로 덮어쓸 수 있다.
    #[cfg(target_arch = "wasm32")]
    #[wasm_bindgen(js_name = getPageLayerTreeValueV2CompatWithProfile)]
    pub fn get_page_layer_tree_value_v2_compat_with_profile(
        &self,
        page_num: u32,
        profile_name: &str,
    ) -> Result<JsValue, JsValue> {
        let profile = Self::parse_layer_render_profile(profile_name, RenderProfile::Screen)?;
        let tree = self
            .build_page_layer_tree_for_output(page_num, profile)
            .map_err(JsValue::from)?;
        page_layer_tree_to_js_value_v2_compat(&tree)
            .map_err(|issues| text_v2_validation_issues_to_js_value(&issues))
    }

    /// 페이지 레이어 트리를 schema v2 strictVisual GlyphOutline JS object로 반환한다.
    #[cfg(target_arch = "wasm32")]
    #[wasm_bindgen(js_name = getPageLayerTreeValueV2StrictGlyphOutline)]
    pub fn get_page_layer_tree_value_v2_strict_glyph_outline(
        &self,
        page_num: u32,
    ) -> Result<JsValue, JsValue> {
        self.get_page_layer_tree_value_v2_strict_glyph_outline_with_profile(
            page_num,
            RenderProfile::Screen.as_str(),
        )
    }

    /// 페이지 레이어 트리를 schema v2 strictVisual GlyphOutline JS object로 반환한다.
    /// profile을 명시적으로 덮어쓸 수 있다.
    #[cfg(target_arch = "wasm32")]
    #[wasm_bindgen(js_name = getPageLayerTreeValueV2StrictGlyphOutlineWithProfile)]
    pub fn get_page_layer_tree_value_v2_strict_glyph_outline_with_profile(
        &self,
        page_num: u32,
        profile_name: &str,
    ) -> Result<JsValue, JsValue> {
        let profile = Self::parse_layer_render_profile(profile_name, RenderProfile::Screen)?;
        let tree = self
            .build_page_layer_tree_for_output(page_num, profile)
            .map_err(JsValue::from)?;
        page_layer_tree_to_js_value_v2_strict_glyph_outline(&tree)
            .map_err(|issues| text_v2_validation_issues_to_js_value(&issues))
    }

    /// 페이지 레이어 트리를 schema v2 strictVisual GlyphRun JS object로 반환한다.
    #[cfg(target_arch = "wasm32")]
    #[wasm_bindgen(js_name = getPageLayerTreeValueV2StrictGlyphRun)]
    pub fn get_page_layer_tree_value_v2_strict_glyph_run(
        &self,
        page_num: u32,
    ) -> Result<JsValue, JsValue> {
        self.get_page_layer_tree_value_v2_strict_glyph_run_with_profile(
            page_num,
            RenderProfile::Screen.as_str(),
        )
    }

    /// 페이지 레이어 트리를 schema v2 strictVisual GlyphRun JS object로 반환한다.
    /// profile을 명시적으로 덮어쓸 수 있다.
    #[cfg(target_arch = "wasm32")]
    #[wasm_bindgen(js_name = getPageLayerTreeValueV2StrictGlyphRunWithProfile)]
    pub fn get_page_layer_tree_value_v2_strict_glyph_run_with_profile(
        &self,
        page_num: u32,
        profile_name: &str,
    ) -> Result<JsValue, JsValue> {
        let profile = Self::parse_layer_render_profile(profile_name, RenderProfile::Screen)?;
        let tree = self
            .build_page_layer_tree_for_output(page_num, profile)
            .map_err(JsValue::from)?;
        page_layer_tree_to_js_value_v2_strict_glyph_run(&tree)
            .map_err(|issues| text_v2_validation_issues_to_js_value(&issues))
    }

    /// 페이지 레이어 트리를 JS object로 반환하되, 이미 JS가 가진 resource payload는 생략한다.
    #[cfg(target_arch = "wasm32")]
    #[wasm_bindgen(js_name = getPageLayerTreeValueWithProfileAndResourceKeys)]
    pub fn get_page_layer_tree_value_with_profile_and_resource_keys(
        &self,
        page_num: u32,
        profile_name: &str,
        known_image_keys: JsValue,
        known_svg_keys: JsValue,
    ) -> Result<JsValue, JsValue> {
        let profile = Self::parse_layer_render_profile(profile_name, RenderProfile::Screen)?;
        let tree = self
            .build_page_layer_tree_for_output(page_num, profile)
            .map_err(JsValue::from)?;
        let hints = LayerResourceExportHints::from_js_values(&known_image_keys, &known_svg_keys);
        Ok(page_layer_tree_to_js_value_with_resource_hints(
            &tree, &hints,
        ))
    }

    /// 페이지 레이어 트리를 schema v2 compatibility JS object로 반환하되,
    /// 이미 JS가 가진 resource payload는 생략한다.
    #[cfg(target_arch = "wasm32")]
    #[wasm_bindgen(js_name = getPageLayerTreeValueV2CompatWithProfileAndResourceKeys)]
    pub fn get_page_layer_tree_value_v2_compat_with_profile_and_resource_keys(
        &self,
        page_num: u32,
        profile_name: &str,
        known_image_keys: JsValue,
        known_svg_keys: JsValue,
    ) -> Result<JsValue, JsValue> {
        let profile = Self::parse_layer_render_profile(profile_name, RenderProfile::Screen)?;
        let tree = self
            .build_page_layer_tree_for_output(page_num, profile)
            .map_err(JsValue::from)?;
        let hints = LayerResourceExportHints::from_js_values(&known_image_keys, &known_svg_keys);
        page_layer_tree_to_js_value_v2_compat_with_resource_hints(&tree, &hints)
            .map_err(|issues| text_v2_validation_issues_to_js_value(&issues))
    }

    /// 페이지 레이어 트리를 schema v2 strictVisual GlyphOutline JS object로 반환하되,
    /// 이미 JS가 가진 resource payload는 생략한다.
    #[cfg(target_arch = "wasm32")]
    #[wasm_bindgen(js_name = getPageLayerTreeValueV2StrictGlyphOutlineWithProfileAndResourceKeys)]
    pub fn get_page_layer_tree_value_v2_strict_glyph_outline_with_profile_and_resource_keys(
        &self,
        page_num: u32,
        profile_name: &str,
        known_image_keys: JsValue,
        known_svg_keys: JsValue,
    ) -> Result<JsValue, JsValue> {
        let profile = Self::parse_layer_render_profile(profile_name, RenderProfile::Screen)?;
        let tree = self
            .build_page_layer_tree_for_output(page_num, profile)
            .map_err(JsValue::from)?;
        let hints = LayerResourceExportHints::from_js_values(&known_image_keys, &known_svg_keys);
        page_layer_tree_to_js_value_v2_strict_glyph_outline_with_resource_hints(&tree, &hints)
            .map_err(|issues| text_v2_validation_issues_to_js_value(&issues))
    }

    /// 페이지 레이어 트리를 schema v2 strictVisual GlyphRun JS object로 반환하되,
    /// 이미 JS가 가진 resource payload는 생략한다.
    #[cfg(target_arch = "wasm32")]
    #[wasm_bindgen(js_name = getPageLayerTreeValueV2StrictGlyphRunWithProfileAndResourceKeys)]
    pub fn get_page_layer_tree_value_v2_strict_glyph_run_with_profile_and_resource_keys(
        &self,
        page_num: u32,
        profile_name: &str,
        known_image_keys: JsValue,
        known_svg_keys: JsValue,
    ) -> Result<JsValue, JsValue> {
        let profile = Self::parse_layer_render_profile(profile_name, RenderProfile::Screen)?;
        let tree = self
            .build_page_layer_tree_for_output(page_num, profile)
            .map_err(JsValue::from)?;
        let hints = LayerResourceExportHints::from_js_values(&known_image_keys, &known_svg_keys);
        page_layer_tree_to_js_value_v2_strict_glyph_run_with_resource_hints(&tree, &hints)
            .map_err(|issues| text_v2_validation_issues_to_js_value(&issues))
    }

    /// 페이지 정보를 JSON 문자열로 반환한다.
    #[wasm_bindgen(js_name = getPageInfo)]
    pub fn get_page_info(&self, page_num: u32) -> Result<String, JsValue> {
        self.get_page_info_native(page_num).map_err(|e| e.into())
    }

    /// 특정 페이지의 텍스트 레이아웃 정보를 JSON 문자열로 반환한다.
    ///
    /// 각 TextRun의 위치, 텍스트, 글자별 X 좌표 경계값을 포함한다.
    #[wasm_bindgen(js_name = getPageTextLayout)]
    pub fn get_page_text_layout(&self, page_num: u32) -> Result<String, JsValue> {
        self.get_page_text_layout_native(page_num)
            .map_err(|e| e.into())
    }

    /// 컨트롤(표, 이미지 등) 레이아웃 정보를 반환한다.
    #[wasm_bindgen(js_name = getPageControlLayout)]
    pub fn get_page_control_layout(&self, page_num: u32) -> Result<String, JsValue> {
        self.get_page_control_layout_native(page_num)
            .map_err(|e| e.into())
    }
}

#[cfg(test)]
mod tests {
    use super::{normalize_canvas_scale, scaled_canvas_extent};

    #[test]
    fn normalize_canvas_scale_rejects_invalid_page_dimensions() {
        for (width, height) in [
            (0.0, 100.0),
            (100.0, 0.0),
            (-1.0, 100.0),
            (100.0, -1.0),
            (f64::NAN, 100.0),
            (100.0, f64::NAN),
            (f64::INFINITY, 100.0),
            (100.0, f64::INFINITY),
        ] {
            assert!(
                normalize_canvas_scale(width, height, 1.0).is_err(),
                "invalid page dimensions must fail: {width} x {height}"
            );
        }
    }

    #[test]
    fn normalize_canvas_scale_clamps_request_and_canvas_extent() {
        assert_eq!(normalize_canvas_scale(100.0, 100.0, 0.0), Ok(1.0));
        assert_eq!(normalize_canvas_scale(100.0, 100.0, f64::NAN), Ok(1.0));
        assert_eq!(normalize_canvas_scale(100.0, 100.0, f64::INFINITY), Ok(1.0));
        assert_eq!(normalize_canvas_scale(100.0, 100.0, 0.1), Ok(0.25));
        assert_eq!(normalize_canvas_scale(100.0, 100.0, 20.0), Ok(12.0));

        let scale = normalize_canvas_scale(20_000.0, 10_000.0, 1.0)
            .expect("large finite page should be scaled down");
        assert!((scale - (16_384.0 / 20_000.0)).abs() < f64::EPSILON);
    }

    #[test]
    fn scaled_canvas_extent_preserves_fractional_page_edges() {
        assert_eq!(scaled_canvas_extent(793.700_787, 1.5), 1191);
        assert_eq!(scaled_canvas_extent(1_122.519_685, 1.5), 1684);
        assert_eq!(scaled_canvas_extent(16_384.25, 1.0), 16_384);
    }
}
