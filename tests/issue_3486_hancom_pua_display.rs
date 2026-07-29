//! 한컴 전용 PUA 머리말과 Enter pictogram의 paint projection 계약.

use rhwp::renderer::composer::{expand_pua_render_text, pua_to_display_text};

#[test]
fn hancom_header_pua_projects_to_company_name() {
    let raw = "\u{F03EF}\u{F03F0}\u{F03F1}\u{F03F2}\u{F03F3}\u{F03F4}";
    assert_eq!(expand_pua_render_text(raw), "한글과컴퓨터");
    assert_eq!(pua_to_display_text('\u{F03EF}').as_deref(), Some("한"));
    assert_eq!(pua_to_display_text('\u{F03F4}').as_deref(), Some("터"));
}

#[test]
fn hancom_enter_pictogram_never_reaches_paint_as_unknown_pua() {
    assert_eq!(expand_pua_render_text("\u{F03A0}를 누르면"), "↵를 누르면");
    assert_eq!(pua_to_display_text('\u{F03A0}').as_deref(), Some("↵"));
}

#[test]
fn unverified_neighboring_pua_is_preserved() {
    assert_eq!(expand_pua_render_text("\u{F03E0}"), "\u{F03E0}");
    assert_eq!(pua_to_display_text('\u{F03E0}'), None);
}
