//! Page rendering and layer export bindings for `HwpDocument`.

use wasm_bindgen::prelude::*;
#[cfg(target_arch = "wasm32")]
use web_sys::HtmlCanvasElement;

#[cfg(target_arch = "wasm32")]
use crate::paint::js_value::{
    page_layer_tree_to_js_value, page_layer_tree_to_js_value_with_resource_hints,
    LayerResourceExportHints,
};
use crate::paint::RenderProfile;

use super::HwpDocument;

#[wasm_bindgen]
impl HwpDocument {
    /// 특정 페이지를 SVG 문자열로 렌더링한다.
    #[wasm_bindgen(js_name = renderPageSvg)]
    pub fn render_page_svg(&self, page_num: u32) -> Result<String, JsValue> {
        self.render_page_svg_native(page_num).map_err(|e| e.into())
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

        // scale 정규화: 0 이하 또는 NaN이면 1.0, 최소 0.25 최대 12.0
        // (zoom 3.0 × DPR 4.0 = 12.0 지원)
        let scale = if scale <= 0.0 || scale.is_nan() {
            1.0
        } else {
            scale.clamp(0.25, 12.0)
        };

        // 최대 캔버스 크기 가드 (16384px)
        let max_dim = 16384.0;
        let scale = if tree.page_width * scale > max_dim || tree.page_height * scale > max_dim {
            (max_dim / tree.page_width)
                .min(max_dim / tree.page_height)
                .min(scale)
        } else {
            scale
        };

        // 캔버스 크기 = 페이지 크기 × scale
        canvas.set_width((tree.page_width * scale) as u32);
        canvas.set_height((tree.page_height * scale) as u32);

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
