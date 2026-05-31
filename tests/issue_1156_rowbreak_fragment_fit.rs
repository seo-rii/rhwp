//! RowBreak table fragments should use the table row budget, not an overly
//! conservative host paragraph budget.
//!
//! In `samples/kps-ai.hwp`, page 37 starts a large 32x2 RowBreak table. The
//! first fragment should keep rows 0..16 and defer row 16 entirely to the next
//! page instead of cutting into it or ending at row 15.

use std::fs;
use std::path::Path;

fn page_dump(rel_path: &str, page_idx: u32) -> String {
    let repo_root = env!("CARGO_MANIFEST_DIR");
    let path = Path::new(repo_root).join(rel_path);
    let bytes = fs::read(&path).unwrap_or_else(|e| panic!("read {rel_path}: {e}"));
    let doc = rhwp::wasm_api::HwpDocument::from_bytes(&bytes)
        .unwrap_or_else(|e| panic!("parse {rel_path}: {e:?}"));
    doc.dump_page_items(Some(page_idx))
}

#[test]
fn kps_ai_page37_defers_overflowing_split_row_slice() {
    let sample = "samples/kps-ai.hwp";

    let page37 = page_dump(sample, 36);
    assert!(
        page37.contains("PartialTable   pi=329 ci=0  rows=0..16"),
        "page 37 should end at the last fully fitting row:\n{page37}"
    );
    assert!(
        !page37.contains("end_cut="),
        "page 37 must not keep an overflowing row slice:\n{page37}"
    );

    let page38 = page_dump(sample, 37);
    assert!(
        page38.contains("PartialTable   pi=329 ci=0  rows=16..32  cont=true"),
        "page 38 should continue from row 16:\n{page38}"
    );
}
