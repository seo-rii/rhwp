//! Issue #1017: BehindText / InFrontOfText direct replay z-order contract.
//!
//! `복학원서.hwp` page 1 has a baked watermark image with BehindText HWP
//! text-wrap policy. Direct replay backends must preserve that policy and
//! replay the image on the `behindText` plane independently of raw tree order.

#[test]
fn issue_1017_baked_watermark_exports_behind_text_wrap_metadata() {
    let doc = sample_doc();
    let json = doc
        .get_page_layer_tree_native(0)
        .expect("layer tree page 1");

    let behind_text = json
        .find("\"wrap\":\"behindText\"")
        .expect("behindText image op");
    let image_before_wrap = json[..behind_text]
        .rfind("\"type\":\"image\"")
        .expect("image op before behindText wrap marker");
    assert!(image_before_wrap < behind_text);
}

#[test]
fn issue_1017_canvaskit_replay_plan_exposes_baked_watermark_plane() {
    let doc = sample_doc();
    let json = doc
        .get_canvaskit_replay_plan_native(0, "default")
        .expect("CanvasKit replay plan page 1");

    assert!(
        json.contains("\"opType\":\"pageBackground\",\"replayPlane\":\"background\""),
        "page background should replay on the background plane: {json}"
    );
    assert!(
        json.contains("\"opType\":\"textRun\",\"replayPlane\":\"flow\""),
        "textRun should replay on the flow plane: {json}"
    );

    let behind_text = json
        .find("\"opType\":\"image\",\"replayPlane\":\"behindText\"")
        .expect("behindText image replay item");
    let detail_after_image = &json[behind_text..];
    assert!(
        detail_after_image.contains("wrap=behindText"),
        "behindText image detail should keep wrap diagnostics: {detail_after_image}"
    );
}

fn sample_doc() -> rhwp::wasm_api::HwpDocument {
    let repo_root = env!("CARGO_MANIFEST_DIR");
    let hwp_path = std::path::Path::new(repo_root).join("samples/복학원서.hwp");
    let bytes = std::fs::read(&hwp_path).expect("read 복학원서.hwp");
    rhwp::wasm_api::HwpDocument::from_bytes(&bytes).expect("parse 복학원서.hwp")
}
