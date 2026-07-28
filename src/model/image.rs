//! 그림 개체 (Picture, ImageData, CropInfo)

use super::shape::{CommonObjAttr, ShapeComponentAttr};
use super::style::ShapeBorderLine;
use super::*;

/// 그림 개체 (HWPTAG_SHAPE_COMPONENT_PICTURE)
#[derive(Debug, Default, Clone)]
pub struct Picture {
    /// 개체 공통 속성
    pub common: CommonObjAttr,
    /// 개체 요소 속성
    pub shape_attr: ShapeComponentAttr,
    /// 테두리 색
    pub border_color: ColorRef,
    /// 테두리 두께
    pub border_width: i32,
    /// 테두리 속성
    pub border_attr: ShapeBorderLine,
    /// 이미지 테두리 좌표 X (4개)
    pub border_x: [i32; 4],
    /// 이미지 테두리 좌표 Y (4개)
    pub border_y: [i32; 4],
    /// 자르기 정보
    pub crop: CropInfo,
    /// HWPX `<hp:imgDim>` crop coordinate reference size.
    ///
    /// This is distinct from `shape_attr.original_width/height`, which describe
    /// the placed object rather than the full coordinate range of `crop`.
    pub img_dim: (u32, u32),
    /// 안쪽 여백
    pub padding: Padding,
    /// 그림 속성
    pub image_attr: ImageAttr,
    /// 테두리 투명도
    pub border_opacity: u8,
    /// 인스턴스 ID
    pub instance_id: u32,
    /// SHAPE_PICTURE 레코드의 파싱된 필드 이후 추가 바이트 (라운드트립 보존용)
    pub raw_picture_extra: Vec<u8>,
    /// HWPX `<hp:effects>` picture effect metadata.
    pub effects: PictureEffects,
    /// 캡션
    pub caption: Option<super::shape::Caption>,
}

impl Picture {
    pub fn crop_reference_size(&self) -> Option<(u32, u32)> {
        (self.img_dim.0 > 0 && self.img_dim.1 > 0).then_some(self.img_dim)
    }
}

/// 자르기 정보
#[derive(Debug, Clone, Copy, Default)]
pub struct CropInfo {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

/// 이미지 속성
#[derive(Debug, Clone, Default)]
pub struct ImageAttr {
    /// 밝기
    pub brightness: i8,
    /// 명암
    pub contrast: i8,
    /// 그림 효과
    pub effect: ImageEffect,
    /// BinData ID 참조
    pub bin_data_id: u16,
    /// 외부 파일 참조 경로.
    ///
    /// `None`이면 문서 내부 BinData payload를 사용한다. `Some`이고 대응하는
    /// `BinDataContent`가 비어 있으면 렌더러는 주입 가능한 외부 이미지로 진단한다.
    pub external_path: Option<String>,
}

/// HWPX picture effects (`<hp:effects>`).
#[derive(Debug, Clone, Default)]
pub struct PictureEffects {
    pub shadow: Option<PictureShadow>,
}

/// HWPX picture shadow effect (`<hp:shadow>`).
#[derive(Debug, Clone, Default)]
pub struct PictureShadow {
    pub style: Option<String>,
    pub alpha: Option<String>,
    pub radius: Option<String>,
    pub direction: Option<String>,
    pub distance: Option<String>,
    pub align_style: Option<String>,
    pub rotation_style: Option<String>,
    pub skew: Option<EffectPoint>,
    pub scale: Option<EffectPoint>,
    pub color: Option<EffectColor>,
}

#[derive(Debug, Clone, Default)]
pub struct EffectPoint {
    pub x: Option<String>,
    pub y: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct EffectColor {
    pub color_type: Option<String>,
    pub scheme_idx: Option<String>,
    pub system_idx: Option<String>,
    pub preset_idx: Option<String>,
    pub rgb: Option<EffectRgb>,
}

#[derive(Debug, Clone, Default)]
pub struct EffectRgb {
    pub r: Option<String>,
    pub g: Option<String>,
    pub b: Option<String>,
}

/// 이미지 효과
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub enum ImageEffect {
    #[default]
    RealPic,
    GrayScale,
    BlackWhite,
    Pattern8x8,
}

/// 이미지 데이터 (실제 바이너리 데이터 보관)
#[derive(Debug, Clone)]
pub struct ImageData {
    /// 이미지 형식
    pub format: ImageFormat,
    /// 바이너리 데이터
    pub data: Vec<u8>,
}

/// 이미지 형식
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ImageFormat {
    Bmp,
    Jpg,
    Png,
    Gif,
    Tiff,
    Wmf,
    Emf,
    Unknown,
}

impl Default for ImageFormat {
    fn default() -> Self {
        ImageFormat::Unknown
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_picture_default() {
        let pic = Picture::default();
        assert_eq!(pic.image_attr.effect, ImageEffect::RealPic);
        assert_eq!(pic.border_width, 0);
        assert_eq!(pic.crop_reference_size(), None);
    }

    #[test]
    fn test_picture_crop_reference_requires_both_img_dim_axes() {
        let mut pic = Picture {
            img_dim: (1000, 800),
            ..Picture::default()
        };
        assert_eq!(pic.crop_reference_size(), Some((1000, 800)));

        pic.img_dim.1 = 0;
        assert_eq!(pic.crop_reference_size(), None);
    }

    #[test]
    fn test_crop_info() {
        let crop = CropInfo {
            left: 100,
            top: 200,
            right: 300,
            bottom: 400,
        };
        assert_eq!(crop.left, 100);
    }

    #[test]
    fn test_image_format_default() {
        assert_eq!(ImageFormat::default(), ImageFormat::Unknown);
    }
}
