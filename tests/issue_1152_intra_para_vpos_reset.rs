//! Regression for an intra-paragraph TAC table vpos reset.
//!
//! `samples/2022년 국립국어원 업무계획.hwp` has an empty host paragraph with two
//! controls and two line segments. The second control (`pi=586 ci=1`) maps to a
//! line segment whose `vertical_pos` is zero, which marks a new page placement.

use std::fs;
use std::path::Path;

#[test]
fn issue_1152_attachment_box_starts_page_33_not_32() {
    let repo_root = env!("CARGO_MANIFEST_DIR");
    let hwp_path = Path::new(repo_root).join("samples/2022년 국립국어원 업무계획.hwp");
    let bytes =
        fs::read(&hwp_path).unwrap_or_else(|e| panic!("read {}: {}", hwp_path.display(), e));

    let doc = rhwp::wasm_api::HwpDocument::from_bytes(&bytes)
        .expect("parse 2022년 국립국어원 업무계획.hwp");
    let dump = doc.dump_page_items(None);

    let page32 = extract_page(&dump, "global_idx=31").unwrap_or_else(|| {
        panic!(
            "missing page 32/global_idx=31 in page item dump\n--- dump ---\n{}",
            dump
        )
    });
    let page33 = extract_page(&dump, "global_idx=32").unwrap_or_else(|| {
        panic!(
            "missing page 33/global_idx=32 in page item dump\n--- dump ---\n{}",
            dump
        )
    });

    assert!(
        !page32.contains("pi=586 ci=1"),
        "page 32 incorrectly contains attachment box pi=586 ci=1\n--- page 32 ---\n{}",
        page32
    );
    assert!(
        page33.contains("pi=586 ci=1"),
        "page 33 does not contain attachment box pi=586 ci=1\n--- page 33 ---\n{}",
        page33
    );
}

fn extract_page<'a>(dump: &'a str, marker: &str) -> Option<&'a str> {
    let header_pos = dump
        .lines()
        .scan(0usize, |offset, line| {
            let current = *offset;
            *offset += line.len() + 1;
            Some((current, line))
        })
        .find(|(_, line)| line.starts_with("=== 페이지") && line.contains(marker))
        .map(|(offset, _)| offset)?;

    let after_header = &dump[header_pos..];
    let end = after_header
        .lines()
        .scan(0usize, |offset, line| {
            let current = *offset;
            *offset += line.len() + 1;
            Some((current, line))
        })
        .skip(1)
        .find(|(_, line)| line.starts_with("=== 페이지"))
        .map(|(offset, _)| offset)
        .unwrap_or(after_header.len());

    Some(&after_header[..end])
}
