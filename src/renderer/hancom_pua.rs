//! 한컴 전용 PUA 기호의 검증된 표시 대체 표.
//!
//! 이 표는 공개된 Hanyang PUA 옛한글 표와 분리한다. 전용 HFT 글꼴에만
//! 존재하는 glyph 중 실제 문서와 Hancom PDF 대조로 의미가 확인된 항목만
//! 공개 글꼴용 문자열로 투영한다.
//!
//! PUA는 글꼴별 사적 영역이므로 코드 포인트 범위만으로 의미를 추정하지 않는다.

/// 코드 포인트 오름차순으로 유지하는 검증된 표시 대체 표.
///
/// 원문 IR은 바꾸지 않고 paint 및 폭 측정 경로에서만 사용한다.
static VERIFIED_HANCOM_PUA_DISPLAY: &[(u32, &str)] = &[
    // `복학원서.hwp` 서명란.
    (0xF012B, "(인)"),
    // 2025 행정업무운영 편람 callout 및 TOC bullet.
    (0xF02FC, "►"),
    (0xF031C, "■"),
    // 암호 문서 안내문의 Enter-key pictogram.
    (0xF03A0, "↵"),
    // HWP3 -> HWP5 변환본의 빈 체크박스 bullet.
    (0xF03C5, "□"),
    // HWP3/HWP5/HWPX 암호 문서의 공통 `한글과컴퓨터` 머리말.
    (0xF03EF, "한"),
    (0xF03F0, "글"),
    (0xF03F1, "과"),
    (0xF03F2, "컴"),
    (0xF03F3, "퓨"),
    (0xF03F4, "터"),
];

/// 검증된 한컴 PUA 기호의 공개 글꼴용 표시 대체값.
pub(crate) fn verified_hancom_pua_display(ch: char) -> Option<&'static str> {
    let code_point = ch as u32;
    VERIFIED_HANCOM_PUA_DISPLAY
        .binary_search_by_key(&code_point, |(code, _)| *code)
        .ok()
        .map(|index| VERIFIED_HANCOM_PUA_DISPLAY[index].1)
}

#[cfg(test)]
mod tests {
    use super::{verified_hancom_pua_display, VERIFIED_HANCOM_PUA_DISPLAY};

    #[test]
    fn verified_table_is_sorted_and_does_not_guess_unknown_pua() {
        for pair in VERIFIED_HANCOM_PUA_DISPLAY.windows(2) {
            assert!(pair[0].0 < pair[1].0, "PUA 표시표는 오름차순이어야 함");
        }
        for code_point in [
            0xF012B, 0xF02FC, 0xF031C, 0xF03A0, 0xF03C5, 0xF03EF, 0xF03F4,
        ] {
            assert!(
                verified_hancom_pua_display(char::from_u32(code_point).unwrap()).is_some(),
                "검증된 U+{code_point:05X}가 표에서 누락됨"
            );
        }
        assert_eq!(verified_hancom_pua_display('\u{F03E0}'), None);
    }
}
