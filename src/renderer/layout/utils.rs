//! 유틸리티 함수 (BinData 검색, 번호 포맷, 도형 스타일 변환)

use super::super::page_layout::LayoutRect;
use super::super::render_tree::*;
use super::super::{
    format_number, ArrowStyle, LineStyle, NumberFormat as NumFmt, PathCommand, ShapeStyle,
    StrokeDash,
};
use crate::model::bin_data::BinDataContent;
use crate::model::footnote::NumberFormat;
use crate::model::image::Picture;
use crate::model::style::{HeadType, Numbering};

/// 원본 형식이 `bin_data_id`를 해석하는 방식.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BinDataReferenceMode {
    /// HWP5의 DocInfo BinData 레코드 순번을 우선하고 sparse storage ID를 보조로 사용한다.
    DocumentIndex,
    /// HWPX manifest의 정규화된 내부 ID만 정확히 일치시킨다.
    ExactManifestId,
}

/// 원본 형식의 참조 규칙으로 `BinDataContent`를 찾는다.
pub(crate) fn find_bin_data<'a>(
    bin_data_content: &'a [BinDataContent],
    bin_data_id: u16,
    mode: BinDataReferenceMode,
) -> Option<&'a BinDataContent> {
    if bin_data_id == 0 {
        return None;
    }

    if mode == BinDataReferenceMode::DocumentIndex {
        if let Some(content) = bin_data_content.get((bin_data_id - 1) as usize) {
            return Some(content);
        }
    }

    bin_data_content
        .iter()
        .find(|content| content.id == bin_data_id)
}

/// Picture의 렌더 표시 크기(HWPUNIT)를 반환한다.
///
/// 일부 HWP5 그림은 `CommonObjAttr.width/height`보다
/// `ShapeComponentAttr.current_width/current_height`가 실제 표시 크기에 가깝다.
/// 기존 도형 경로와 동일하게 current 값이 더 큰 축만 채택해 축소 회귀 위험을 줄인다.
pub(crate) fn picture_display_size_hu(picture: &Picture) -> (i32, i32) {
    let mut width = picture.common.width as i32;
    let mut height = picture.common.height as i32;

    let current_width = picture.shape_attr.current_width as i32;
    if current_width > 0 && current_width > width {
        width = current_width;
    }

    let current_height = picture.shape_attr.current_height as i32;
    if current_height > 0 && current_height > height {
        height = current_height;
    }

    (width, height)
}

/// 문단의 실효 numbering_id를 반환한다.
/// Outline 문단이고 para_style.numbering_id==0이면 구역의 outline_numbering_id로 fallback.
pub fn resolve_numbering_id(
    head_type: HeadType,
    para_numbering_id: u16,
    outline_numbering_id: u16,
) -> u16 {
    if para_numbering_id == 0 && head_type == HeadType::Outline {
        outline_numbering_id
    } else {
        para_numbering_id
    }
}

/// 번호 형식 문자열의 `^N` 제어코드를 실제 번호로 치환
pub(crate) fn expand_numbering_format(
    format_str: &str,
    counters: &[u32; 7],
    numbering: &Numbering,
    start_numbers: &[u32; 7],
) -> String {
    let mut result = String::new();
    let mut chars = format_str.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '^' {
            if let Some(&digit) = chars.peek() {
                if digit.is_ascii_digit() {
                    chars.next();
                    let level_ref = (digit as u8 - b'0') as usize;
                    if level_ref >= 1 && level_ref <= 7 {
                        let idx = level_ref - 1;
                        let counter_val = counters[idx];
                        let start = start_numbers[idx];
                        let num = if counter_val > 0 {
                            (start - 1) + counter_val
                        } else {
                            start
                        };
                        let fmt_code = numbering.heads[idx].number_format;
                        let num_fmt = numbering_format_to_number_format(fmt_code);
                        result.push_str(&format_number(num as u16, num_fmt));
                    }
                    continue;
                }
            }
        }
        result.push(ch);
    }
    result
}

/// HWP 표 43 번호 형식 코드 → NumberFormat 변환
pub(crate) fn numbering_format_to_number_format(code: u8) -> NumFmt {
    match code {
        0 => NumFmt::Digit,         // 1, 2, 3
        1 => NumFmt::CircledDigit,  // ①, ②, ③
        2 => NumFmt::RomanUpper,    // I, II, III
        3 => NumFmt::RomanLower,    // i, ii, iii
        4 => NumFmt::LatinUpper,    // A, B, C
        5 => NumFmt::LatinLower,    // a, b, c
        8 => NumFmt::HangulGaNaDa,  // 가, 나, 다
        12 => NumFmt::HangulNumber, // 일, 이, 삼
        13 => NumFmt::HanjaNumber,  // 一, 二, 三
        _ => NumFmt::Digit,
    }
}

/// 쪽 번호를 형식에 맞게 문자열로 변환 (mod.rs의 format_number 재사용)
pub(crate) fn format_page_number(
    page_num: u32,
    format: u8,
    prefix_char: char,
    suffix_char: char,
    dash_char: char,
) -> String {
    let num_fmt = NumFmt::from_hwp_format(format);
    let formatted = format_number(page_num as u16, num_fmt);
    let prefix = if prefix_char != '\0' {
        prefix_char.to_string()
    } else {
        String::new()
    };
    let suffix = if suffix_char != '\0' {
        suffix_char.to_string()
    } else {
        String::new()
    };
    let dash = if dash_char != '\0' {
        dash_char.to_string()
    } else {
        String::new()
    };
    if prefix.is_empty() && suffix.is_empty() && dash.is_empty() {
        formatted
    } else {
        format!("{}{}{}{}{}", dash, prefix, formatted, suffix, dash)
    }
}

/// ShapeComponentAttr에서 ShapeTransform을 추출한다.
pub(crate) fn extract_shape_transform(
    sa: &crate::model::shape::ShapeComponentAttr,
) -> ShapeTransform {
    ShapeTransform {
        rotation: sa.rotation_angle as f64,
        horz_flip: sa.horz_flip,
        vert_flip: sa.vert_flip,
    }
}

pub(crate) fn drawing_to_shape_style(
    drawing: &crate::model::shape::DrawingObjAttr,
) -> (ShapeStyle, Option<Box<super::super::GradientFillInfo>>) {
    use super::super::GradientFillInfo;
    use crate::model::style::FillType;

    // 배경색: solid 필드가 있으면 fill_type과 무관하게 배경색 적용
    // (Image/Gradient와 단색 채우기가 동시에 적용되는 케이스 지원)
    let fill_color = drawing.fill.solid.and_then(|s| {
        // HWP pattern_type: >0이면 패턴 채우기(패턴이 배경색 처리), 0 이하=단색
        // ColorRef 상위 바이트가 0이 아니면(0xFF 등) 투명
        if s.pattern_type > 0 || (s.background_color >> 24) != 0 {
            None
        } else {
            Some(s.background_color)
        }
    });

    let gradient = match drawing.fill.fill_type {
        FillType::Gradient => drawing.fill.gradient.as_ref().map(|g| {
            let positions: Vec<f64> = if g.positions.is_empty() {
                let n = g.colors.len();
                (0..n)
                    .map(|i| i as f64 / (n.max(2) - 1).max(1) as f64)
                    .collect()
            } else {
                g.positions.iter().map(|&p| p as f64 / 100.0).collect()
            };
            Box::new(GradientFillInfo {
                gradient_type: g.gradient_type,
                angle: g.angle,
                center_x: g.center_x,
                center_y: g.center_y,
                colors: g.colors.clone(),
                positions,
            })
        }),
        _ => None,
    };

    let border = &drawing.border_line;
    // 테두리 선 속성 비트 레이아웃 (hwplib LineInfoProperty 참조):
    //   bit 0-5:   선 종류 (LineType)
    //   bit 6-9:   선 끝 모양 (LineEndShape/cap)
    //   bit 10-15: 화살표 시작 모양
    //   bit 16-21: 화살표 끝 모양
    //   bit 22-25: 화살표 시작 크기
    //   bit 26-29: 화살표 끝 크기
    //   bit 30:    시작 화살표 채움
    //   bit 31:    끝 화살표 채움
    let shape_line_type = border.attr & 0x3F;
    let (mut stroke_width, mut stroke_color) = if shape_line_type == 0 {
        // 선 종류 "없음" → 테두리 그리지 않음
        (0.0, None)
    } else {
        let sw = shape_border_width_to_px(border.width);
        let sc = if sw > 0.0 { Some(border.color) } else { None };
        (sw, sc)
    };

    // 선 종류가 지정되었으나 width가 0인 경우 기본 최소 선 굵기 적용
    // (한컴: line_type>0이면 width=0이어도 기본 얇은 선(0.12mm≈0.5px) 렌더링)
    if shape_line_type > 0 && stroke_width == 0.0 {
        stroke_width = 0.5; // 최소 0.5px (0.12mm 한컴 기본값)
        stroke_color = Some(border.color);
    }

    // stroke dash 매핑 (hwplib LineType 참조)
    // 0=None, 1=Solid, 2=Dash, 3=Dot, 4=DashDot, 5=DashDotDot,
    // 6=LongDash, 7=CircleDot, 8=Double, 9=ThinBold, 10=BoldThin, 11=ThinBoldThin
    let stroke_dash = match shape_line_type {
        2 | 6 => StrokeDash::Dash,
        3 | 7 => StrokeDash::Dot,
        4 => StrokeDash::DashDot,
        5 => StrokeDash::DashDotDot,
        _ => StrokeDash::Solid,
    };

    // 채우기 투명도: 한컴 호환 — alpha=0은 불투명, alpha=255은 완전 투명
    let opacity = if drawing.fill.alpha > 0 {
        1.0 - (drawing.fill.alpha as f64 / 255.0)
    } else {
        1.0
    };
    // 패턴 채우기: pattern_type > 0일 때만 패턴 정보 생성 (1=가로줄, 2=세로줄, ..., 6=격자)
    let pattern = drawing.fill.solid.and_then(|s| {
        if s.pattern_type > 0 {
            Some(super::super::PatternFillInfo {
                pattern_type: s.pattern_type,
                pattern_color: s.pattern_color,
                background_color: s.background_color,
            })
        } else {
            None
        }
    });

    // 그림자
    let shadow = if drawing.shadow_type > 0 {
        Some(super::super::ShadowStyle {
            shadow_type: drawing.shadow_type,
            color: drawing.shadow_color,
            offset_x: super::super::hwpunit_to_px(drawing.shadow_offset_x, 96.0),
            offset_y: super::super::hwpunit_to_px(drawing.shadow_offset_y, 96.0),
            alpha: drawing.shadow_alpha,
        })
    } else {
        None
    };

    let style = ShapeStyle {
        fill_color,
        pattern,
        stroke_color,
        stroke_width,
        stroke_dash,
        opacity,
        shadow,
    };
    (style, gradient)
}

/// DrawingObjAttr → LineStyle 변환 (직선용)
pub(crate) fn drawing_to_line_style(drawing: &crate::model::shape::DrawingObjAttr) -> LineStyle {
    let border = &drawing.border_line;
    let width = shape_border_width_to_px(border.width);
    let attr = border.attr;

    // 테두리 선 속성 비트 레이아웃 (hwplib LineInfoProperty 참조):
    //   bit 0-5:   선 종류 (LineType)
    //   bit 6-9:   선 끝 모양 (LineEndShape/cap)
    //   bit 10-15: 화살표 시작 모양 (LineArrowShape)
    //   bit 16-21: 화살표 끝 모양 (LineArrowShape)
    //   bit 22-25: 화살표 시작 크기 (LineArrowSize)
    //   bit 26-29: 화살표 끝 크기 (LineArrowSize)
    //   bit 30:    시작 화살표 채움
    //   bit 31:    끝 화살표 채움
    let shape_line_type = attr & 0x3F;

    let (dash, line_render_type) = match shape_line_type {
        0 | 1 => (StrokeDash::Solid, super::super::LineRenderType::Single),
        2 => (StrokeDash::Dash, super::super::LineRenderType::Single),
        3 => (StrokeDash::Dot, super::super::LineRenderType::Single),
        4 => (StrokeDash::DashDot, super::super::LineRenderType::Single),
        5 => (StrokeDash::DashDotDot, super::super::LineRenderType::Single),
        6 => (StrokeDash::Dash, super::super::LineRenderType::Single), // LongDash
        7 => (StrokeDash::Dot, super::super::LineRenderType::Single),  // CircleDot
        8 => (StrokeDash::Solid, super::super::LineRenderType::Double),
        9 => (
            StrokeDash::Solid,
            super::super::LineRenderType::ThinThickDouble,
        ),
        10 => (
            StrokeDash::Solid,
            super::super::LineRenderType::ThickThinDouble,
        ),
        11 => (
            StrokeDash::Solid,
            super::super::LineRenderType::ThinThickThinTriple,
        ),
        _ => (StrokeDash::Solid, super::super::LineRenderType::Single),
    };

    // 화살표 시작 모양: bit 10-15
    let start_arrow_val = (attr >> 10) & 0x3F;
    let start_fill = (attr >> 30) & 1 != 0;
    let start_arrow = arrow_type_from_hwp(start_arrow_val, start_fill);

    // 화살표 끝 모양: bit 16-21
    let end_arrow_val = (attr >> 16) & 0x3F;
    let end_fill = (attr >> 31) & 1 != 0;
    let end_arrow = arrow_type_from_hwp(end_arrow_val, end_fill);

    // 화살표 크기: bit 22-25 (시작), bit 26-29 (끝)
    let start_arrow_size = ((attr >> 22) & 0x0F) as u8;
    let end_arrow_size = ((attr >> 26) & 0x0F) as u8;

    let shadow = if drawing.shadow_type > 0 {
        Some(super::super::ShadowStyle {
            shadow_type: drawing.shadow_type,
            color: drawing.shadow_color,
            offset_x: super::super::hwpunit_to_px(drawing.shadow_offset_x, 96.0),
            offset_y: super::super::hwpunit_to_px(drawing.shadow_offset_y, 96.0),
            alpha: drawing.shadow_alpha,
        })
    } else {
        None
    };

    LineStyle {
        color: border.color,
        width: width.max(0.5),
        dash,
        line_type: line_render_type,
        start_arrow,
        end_arrow,
        start_arrow_size,
        end_arrow_size,
        shadow,
    }
}

/// HWP 화살표 모양 값 → ArrowStyle 변환
/// hwplib LineArrowShape 참조:
///   0=None, 1=Arrow, 2=LinedArrow, 3=ConcaveArrow,
///   4=Diamond, 5=Circle, 6=Rectangle
/// 채움 여부는 bit 30/31 (fill 파라미터)로 제어
fn arrow_type_from_hwp(hwp_type: u32, fill: bool) -> ArrowStyle {
    match hwp_type {
        0 => ArrowStyle::None,
        1 => ArrowStyle::Arrow,
        2 => ArrowStyle::Arrow, // LinedArrow (선형 화살표) → Arrow로 근사
        3 => ArrowStyle::ConcaveArrow,
        4 => {
            if fill {
                ArrowStyle::Diamond
            } else {
                ArrowStyle::OpenDiamond
            }
        }
        5 => {
            if fill {
                ArrowStyle::Circle
            } else {
                ArrowStyle::OpenCircle
            }
        }
        6 => {
            if fill {
                ArrowStyle::Square
            } else {
                ArrowStyle::OpenSquare
            }
        }
        _ => ArrowStyle::None,
    }
}

/// ShapeBorderLine의 width(HWPUNIT 단위, INT32) → 픽셀 변환
/// HWP 스펙: 1인치 = 7200 HWPUNIT = 25.4mm
fn shape_border_width_to_px(width: i32) -> f64 {
    if width <= 0 {
        return 0.0;
    }
    // HWPUNIT → px: width * 96 / 7200
    let px = width as f64 * 96.0 / 7200.0;
    // 최소 0.5px 보장 (너무 얇으면 안 보임)
    px.max(0.5).min(38.0)
}

/// LayoutRect → BoundingBox 변환
pub(crate) fn layout_rect_to_bbox(rect: &LayoutRect) -> BoundingBox {
    BoundingBox::new(rect.x, rect.y, rect.width, rect.height)
}

#[cfg(test)]
mod tests {
    use super::{find_bin_data, picture_display_size_hu, BinDataReferenceMode};
    use crate::model::bin_data::{BinDataBytes, BinDataContent};
    use crate::model::image::Picture;

    fn bin_data(id: u16, extension: &str) -> BinDataContent {
        BinDataContent {
            id,
            data: BinDataBytes::Loaded(Vec::new()),
            extension: extension.to_string(),
        }
    }

    #[test]
    fn find_bin_data_rejects_zero_id() {
        for mode in [
            BinDataReferenceMode::DocumentIndex,
            BinDataReferenceMode::ExactManifestId,
        ] {
            assert!(find_bin_data(&[bin_data(1, "png")], 0, mode).is_none());
        }
    }

    #[test]
    fn find_bin_data_uses_document_index_before_storage_id() {
        let content = [bin_data(12, "png"), bin_data(1, "bmp"), bin_data(2, "bmp")];

        let selected = find_bin_data(&content, 1, BinDataReferenceMode::DocumentIndex)
            .expect("document index should resolve");

        assert_eq!(selected.id, 12);
        assert_eq!(selected.extension, "png");
    }

    #[test]
    fn find_bin_data_resolves_matching_document_index() {
        let content = [bin_data(1, "jpg"), bin_data(2, "png"), bin_data(3, "bmp")];

        for bin_data_id in 1..=3 {
            assert_eq!(
                find_bin_data(&content, bin_data_id, BinDataReferenceMode::DocumentIndex,)
                    .map(|item| item.id),
                Some(bin_data_id)
            );
        }
    }

    #[test]
    fn find_bin_data_falls_back_to_sparse_storage_id() {
        let content = [
            bin_data(1, "png"),
            bin_data(2, "png"),
            bin_data(60_001, "ooxml_chart"),
            bin_data(60_002, "ooxml_chart"),
        ];

        assert_eq!(
            find_bin_data(&content, 60_001, BinDataReferenceMode::DocumentIndex)
                .map(|item| item.id),
            Some(60_001)
        );
        assert_eq!(
            find_bin_data(&content, 60_002, BinDataReferenceMode::DocumentIndex)
                .map(|item| item.id),
            Some(60_002)
        );
    }

    #[test]
    fn find_bin_data_uses_exact_ids_for_sparse_hwpx_content() {
        let content = [bin_data(2, "png"), bin_data(4, "jpg")];

        assert!(
            find_bin_data(&content, 1, BinDataReferenceMode::ExactManifestId).is_none(),
            "external manifest item must not alias the first embedded item"
        );
        assert_eq!(
            find_bin_data(&content, 2, BinDataReferenceMode::ExactManifestId).map(|item| item.id),
            Some(2)
        );
        assert!(
            find_bin_data(&content, 3, BinDataReferenceMode::ExactManifestId).is_none(),
            "a missing manifest item must remain unresolved"
        );
        assert_eq!(
            find_bin_data(&content, 4, BinDataReferenceMode::ExactManifestId).map(|item| item.id),
            Some(4)
        );
    }

    #[test]
    fn find_bin_data_rejects_unknown_out_of_range_id() {
        let content = [bin_data(1, "png"), bin_data(2, "png")];

        assert!(find_bin_data(&content, 99, BinDataReferenceMode::DocumentIndex).is_none());
    }

    #[test]
    fn picture_display_size_uses_larger_current_axis() {
        let mut picture = Picture::default();
        picture.common.width = 3365;
        picture.common.height = 9446;
        picture.shape_attr.current_width = 9014;
        picture.shape_attr.current_height = 9446;

        assert_eq!(picture_display_size_hu(&picture), (9014, 9446));
    }

    #[test]
    fn picture_display_size_keeps_common_when_current_is_smaller() {
        let mut picture = Picture::default();
        picture.common.width = 9000;
        picture.common.height = 8000;
        picture.shape_attr.current_width = 3000;
        picture.shape_attr.current_height = 4000;

        assert_eq!(picture_display_size_hu(&picture), (9000, 8000));
    }
}
