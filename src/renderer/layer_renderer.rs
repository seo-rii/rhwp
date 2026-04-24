use crate::model::ColorRef;
use crate::paint::PageLayerTree;

/// visual layer tree를 stateful backend 출력으로 재생하는 전환기 trait.
///
/// 현재는 내부 출력 버퍼나 장면 상태를 누적하는 backend, 예를 들어 layered SVG bridge가
/// 이 trait를 직접 구현한다. native Skia처럼 최종 결과를 바이트로 반환하는 raster
/// backend는 아래 `LayerRasterRenderer` contract를 쓴다.
pub trait LayerRenderer {
    fn render_page(&mut self, tree: &PageLayerTree) -> Result<(), String>;
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RasterRenderOptions {
    pub max_dimension: i32,
    pub transparent: bool,
    pub background_color: Option<ColorRef>,
}

impl Default for RasterRenderOptions {
    fn default() -> Self {
        Self {
            max_dimension: 16_384,
            transparent: true,
            background_color: None,
        }
    }
}

/// visual layer tree를 raster 결과로 직접 내보내는 backend 계약.
///
/// 현재는 native Skia가 이 계약을 구현한다. Layer tree를 공통 입력으로 공유하되,
/// stateful scene renderer와 raster exporter를 같은 trait에 억지로 넣지 않기 위해
/// 별도 contract로 분리한다.
pub trait LayerRasterRenderer {
    fn render_png(&self, tree: &PageLayerTree) -> Result<Vec<u8>, String> {
        self.render_png_with_options(tree, RasterRenderOptions::default())
    }

    fn render_png_with_options(
        &self,
        tree: &PageLayerTree,
        options: RasterRenderOptions,
    ) -> Result<Vec<u8>, String>;
}
