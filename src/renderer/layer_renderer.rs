use crate::model::ColorRef;
use crate::paint::PageLayerTree;
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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LayerRenderDiagnostics {
    pub tile_fallback_cap_hits: usize,
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
