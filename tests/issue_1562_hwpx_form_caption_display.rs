//! Regression test for HWPX form-control caption `&&` display semantics.
//!
//! The stored caption value keeps `R&&D`, but rendered form captions should
//! display one literal ampersand, matching Hancom output.

use std::path::Path;

use rhwp::wasm_api::HwpDocument;

const SAMPLE: &str = "samples/hwpx/form-002.hwpx";

fn render_form_002_page_0_svg() -> String {
    let repo_root = env!("CARGO_MANIFEST_DIR");
    let path = Path::new(repo_root).join(SAMPLE);
    let bytes = std::fs::read(&path)
        .unwrap_or_else(|error| panic!("form-002 fixture read failed {}: {error}", path.display()));
    let doc = HwpDocument::from_bytes(&bytes).expect("form-002 parse failed");
    doc.render_page_svg_native(0)
        .expect("form-002 page 0 SVG render failed")
}

#[test]
fn form_caption_double_ampersand_displays_as_single_ampersand_in_svg() {
    let svg = render_form_002_page_0_svg();

    for expected in [
        "IP R&amp;D연계",
        "R&amp;D 자율성트랙(일반)",
        "R&amp;D 자율성트랙(지정)",
    ] {
        assert!(
            svg.contains(expected),
            "form caption should render with display ampersand semantics: expected={expected}"
        );
    }

    assert!(
        !svg.contains("R&amp;&amp;D"),
        "rendered form caption should not keep escaped `R&&D` display text"
    );
}
