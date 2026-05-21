use std::fs;
use std::path::Path;

#[test]
fn master_page_table_includes_outer_margin_top() {
    let repo_root = env!("CARGO_MANIFEST_DIR");
    let hwp_path = Path::new(repo_root).join("samples/exam_math.hwp");
    let bytes =
        fs::read(&hwp_path).unwrap_or_else(|e| panic!("read {}: {}", hwp_path.display(), e));

    let doc = rhwp::wasm_api::HwpDocument::from_bytes(&bytes).expect("parse exam_math.hwp");
    let svg = doc
        .render_page_svg_native(0)
        .expect("render exam_math.hwp page 1");

    let has_outer_margin_y = svg.contains("y=\"1378.") || svg.contains("y=\"1378\"");
    assert!(
        has_outer_margin_y,
        "master-page table cell y must include outer_margin_top; relevant regression lines:\n{}",
        svg.lines()
            .filter(|line| line.contains("cell-clip") && line.contains("1359"))
            .take(3)
            .collect::<Vec<_>>()
            .join("\n")
    );

    let regression = svg
        .lines()
        .any(|line| line.contains("cell-clip") && line.contains("y=\"1359."));
    assert!(
        !regression,
        "master-page table cell regressed to y=1359 without outer_margin_top"
    );
}
