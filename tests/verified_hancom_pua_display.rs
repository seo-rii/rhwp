//! 문서/PDF 대조로 검증된 한컴 PUA 표시 투영의 공개 렌더러 계약.

use rhwp::renderer::composer::{expand_pua_render_text, pua_to_display_text};

#[test]
fn verified_basic_and_supplementary_pua_share_one_display_contract() {
    let raw = "\u{F0A0}\u{F0E8}\u{F003B}\u{F02EF}\u{F080F}\
               \u{F0811}\u{F0817}\u{F081A}\u{F0854}\u{F0855}";
    assert_eq!(expand_pua_render_text(raw), "·➔↓·━┌└─《》");

    for (code_point, display) in [
        (0xF0A0, "·"),
        (0xF0E8, "➔"),
        (0xF003B, "↓"),
        (0xF02EF, "·"),
        (0xF080F, "━"),
        (0xF0811, "┌"),
        (0xF0817, "└"),
        (0xF081A, "─"),
        (0xF0854, "《"),
        (0xF0855, "》"),
    ] {
        let ch = char::from_u32(code_point).unwrap();
        assert_eq!(pua_to_display_text(ch).as_deref(), Some(display));
    }
}

#[test]
fn tentative_and_overlap_only_pua_are_not_plain_text_guesses() {
    let raw = "\u{F00DA}\u{F0827}\u{F02B1}\u{F02C4}";
    assert_eq!(expand_pua_render_text(raw), raw);
    assert_eq!(pua_to_display_text('\u{F00DA}'), None);
    assert_eq!(pua_to_display_text('\u{F0827}'), None);
}
