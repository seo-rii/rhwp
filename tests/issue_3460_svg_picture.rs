//! Regression coverage for embedded SVG pictures in HWPX documents.

use std::fs;
use std::path::Path;

const SAMPLE: &str = "samples/issue3460/svg_picture_repro.hwpx";

fn document() -> rhwp::wasm_api::HwpDocument {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(SAMPLE);
    let bytes = fs::read(&path).unwrap_or_else(|error| panic!("read {SAMPLE}: {error}"));
    rhwp::wasm_api::HwpDocument::from_bytes(&bytes).expect("parse embedded SVG fixture")
}

fn svg_image_data_mimes(svg: &str) -> Vec<&str> {
    let mut mimes = Vec::new();
    let mut remaining = svg;
    while let Some(offset) = remaining.find("href=\"data:") {
        let data_uri = &remaining[offset + "href=\"".len()..];
        let end = data_uri.find(';').unwrap_or(data_uri.len());
        mimes.push(&data_uri[..end]);
        remaining = data_uri;
    }
    mimes
}

#[test]
fn embedded_svg_resources_survive_body_and_non_numeric_header_references() {
    let document = document();
    for page_index in 0..3 {
        let svg = document
            .render_page_svg_native(page_index)
            .expect("render layer SVG");
        let mimes = svg_image_data_mimes(&svg);
        assert!(
            mimes.contains(&"data:image/svg+xml"),
            "page {} must preserve an embedded SVG image, got {mimes:?}",
            page_index + 1
        );
    }
}

#[test]
fn canvaskit_plan_admits_embedded_svg_images_for_direct_replay() {
    let document = document();
    for page_index in 0..3 {
        let plan = document
            .get_canvaskit_replay_plan_native(page_index, "default")
            .expect("build CanvasKit replay plan");
        let image_items = plan
            .match_indices("\"opType\":\"image\"")
            .map(|(offset, _)| {
                let item = &plan[offset..];
                &item[..item.find('}').expect("complete image replay item")]
            })
            .collect::<Vec<_>>();
        assert!(
            !image_items.is_empty(),
            "page {} must contain an image replay item",
            page_index + 1
        );
        assert!(
            image_items
                .iter()
                .all(|item| item.contains("\"status\":\"direct\"")),
            "page {} embedded SVG images must be direct CanvasKit replay items: {image_items:?}",
            page_index + 1
        );
    }
}

#[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
#[test]
fn native_skia_rasterizes_embedded_svg_images() {
    let document = document();
    for page_index in 0..3 {
        let png = document
            .render_page_png_native(page_index)
            .expect("render native Skia PNG");
        assert!(
            png.starts_with(b"\x89PNG\r\n\x1a\n"),
            "page {} must produce a PNG",
            page_index + 1
        );
    }
}
