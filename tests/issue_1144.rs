use rhwp::wasm_api::HwpDocument;
use serde_json::Value;

fn document_with_filename_footer() -> HwpDocument {
    let mut doc = HwpDocument::create_empty();
    doc.create_blank_document()
        .expect("create blank document fixture");
    doc.apply_hf_template(0, false, 0, 4)
        .expect("apply footer template");
    doc
}

fn collect_rendered_text(value: &Value, text: &mut String) {
    match value {
        Value::Object(map) => {
            if map.get("type").and_then(Value::as_str) == Some("textRun") {
                if let Some(rendered) = map
                    .get("displayText")
                    .and_then(Value::as_str)
                    .or_else(|| map.get("text").and_then(Value::as_str))
                {
                    text.push_str(rendered);
                }
            }
            for child in map.values() {
                collect_rendered_text(child, text);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_rendered_text(item, text);
            }
        }
        _ => {}
    }
}

fn layer_tree_text(doc: &HwpDocument) -> String {
    let json = doc.get_page_layer_tree_native(0).expect("page layer tree");
    let value: Value = serde_json::from_str(&json).expect("layer tree JSON");
    let mut text = String::new();
    collect_rendered_text(&value, &mut text);
    text
}

#[test]
fn filename_fields_use_the_document_context() {
    let mut doc = document_with_filename_footer();
    doc.set_file_name("issue-1144-fixture.hwp");

    let text = layer_tree_text(&doc);

    assert!(text.contains("issue-1144-fixture.hwp"), "{text:?}");
    assert!(!text.contains('\u{0017}'), "{text:?}");
}

#[test]
fn changing_the_filename_invalidates_cached_layer_state() {
    let mut doc = document_with_filename_footer();
    doc.set_file_name("old-name.hwp");
    assert!(layer_tree_text(&doc).contains("old-name.hwp"));

    doc.set_file_name("new-name.hwp");
    let text = layer_tree_text(&doc);

    assert!(text.contains("new-name.hwp"), "{text:?}");
    assert!(!text.contains("old-name.hwp"), "{text:?}");
}

#[test]
fn canvaskit_plan_build_does_not_freeze_filename_context() {
    let mut doc = document_with_filename_footer();
    doc.set_file_name("canvas-kit-old.hwp");
    doc.get_canvaskit_replay_plan_native(0, "default")
        .expect("CanvasKit replay plan");

    doc.set_file_name("canvas-kit-new.hwp");
    let text = layer_tree_text(&doc);

    assert!(text.contains("canvas-kit-new.hwp"), "{text:?}");
    assert!(!text.contains("canvas-kit-old.hwp"), "{text:?}");
}
