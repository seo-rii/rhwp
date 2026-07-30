use rhwp::wasm_api::HwpDocument;

fn document_with_file_name_field() -> HwpDocument {
    let mut doc = HwpDocument::create_empty();
    doc.create_blank_document_native()
        .expect("create blank document");
    doc.set_file_name("보고서초안.hwp");
    doc.create_header_footer_native(0, true, 0)
        .expect("create header");
    doc.insert_text_in_header_footer_native(0, true, 0, 0, 0, "AB")
        .expect("insert header text");
    doc.insert_field_in_hf_native(0, true, 0, 0, 0, 3)
        .expect("insert file-name field");
    doc
}

fn header_model_length(doc: &HwpDocument) -> usize {
    let info = doc
        .get_header_footer_para_info_native(0, true, 0, 0)
        .expect("header paragraph info");
    let value: serde_json::Value = serde_json::from_str(&info).expect("paragraph info JSON");
    value["charCount"].as_u64().expect("charCount") as usize
}

fn far_right_header_offset(doc: &HwpDocument) -> usize {
    let hit = doc
        .hit_test_in_header_footer_native(0, true, 5000.0, 0.0)
        .expect("header hit test");
    let value: serde_json::Value = serde_json::from_str(&hit).expect("hit-test JSON");
    assert_eq!(value["hit"], true, "{hit}");
    value["charOffset"].as_u64().expect("charOffset") as usize
}

#[test]
fn field_display_width_does_not_expand_the_source_offset_space() {
    let doc = document_with_file_name_field();

    assert_eq!(header_model_length(&doc), 3);
    assert_eq!(far_right_header_offset(&doc), 3);
}

#[test]
fn typing_at_a_field_aligned_caret_updates_the_expected_source_position() {
    let mut doc = document_with_file_name_field();
    let caret = far_right_header_offset(&doc);

    doc.insert_text_in_header_footer_native(0, true, 0, 0, caret, "X")
        .expect("insert at caret");

    let content = doc
        .get_header_footer_native(0, true, 0)
        .expect("header content");
    let value: serde_json::Value = serde_json::from_str(&content).expect("header JSON");
    assert_eq!(value["text"], "\u{0017}ABX");
}

#[test]
fn layer_json_keeps_the_source_marker_and_exposes_the_display_value() {
    let doc = document_with_file_name_field();
    let json = doc.get_page_layer_tree_native(0).expect("page layer tree");
    let value: serde_json::Value = serde_json::from_str(&json).expect("valid layer JSON");

    fn find_field_run(value: &serde_json::Value) -> Option<&serde_json::Value> {
        match value {
            serde_json::Value::Object(map) => {
                if map.get("type").and_then(serde_json::Value::as_str) == Some("textRun")
                    && map
                        .get("displayText")
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|text| text.contains("보고서초안.hwp"))
                {
                    return Some(value);
                }
                map.values().find_map(find_field_run)
            }
            serde_json::Value::Array(items) => items.iter().find_map(find_field_run),
            _ => None,
        }
    }

    let run = find_field_run(&value).expect("field text run");
    assert_eq!(run["text"], "\u{0017}AB");
    assert_eq!(run["displayText"], "보고서초안.hwpAB");
    assert_eq!(
        run["positions"].as_array().expect("source positions").len(),
        4
    );
}
