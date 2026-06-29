//! Issue #1270: caption paragraphs must render inline TAC pictures.
//!
//! The renderer already composes caption paragraphs, but the caption path used
//! to call `layout_composed_paragraph` without the source `Paragraph` and
//! `BinDataContent`. That made inline `treat_as_char` pictures inside captions
//! disappear because paragraph layout could not resolve the source control or
//! image payload.

use std::fs;
use std::path::Path;

use rhwp::model::control::Control;
use rhwp::model::paragraph::Paragraph;
use rhwp::model::shape::{Caption, CaptionDirection};
use rhwp::wasm_api::HwpDocument;

const SAMPLE: &str = "samples/hwp-img-001.hwp";

fn load_sample_doc() -> HwpDocument {
    let repo_root = env!("CARGO_MANIFEST_DIR");
    let path = Path::new(repo_root).join(SAMPLE);
    let bytes = fs::read(&path).unwrap_or_else(|e| panic!("read {}: {}", SAMPLE, e));
    HwpDocument::from_bytes(&bytes).unwrap_or_else(|e| panic!("parse {}: {}", SAMPLE, e))
}

fn has_tac_picture(para: &Paragraph) -> bool {
    para.controls.iter().any(|ctrl| {
        matches!(
            ctrl,
            Control::Picture(pic) if pic.common.treat_as_char && pic.image_attr.bin_data_id > 0
        )
    })
}

fn first_tac_picture_para(paragraphs: &[Paragraph]) -> Option<Paragraph> {
    for para in paragraphs {
        if has_tac_picture(para) {
            return Some(para.clone());
        }
        for ctrl in &para.controls {
            if let Control::Table(table) = ctrl {
                for cell in &table.cells {
                    if let Some(found) = first_tac_picture_para(&cell.paragraphs) {
                        return Some(found);
                    }
                }
            }
        }
    }
    None
}

fn tac_picture_bin_id(para: &Paragraph) -> Option<u16> {
    para.controls.iter().find_map(|ctrl| match ctrl {
        Control::Picture(pic) if pic.common.treat_as_char => Some(pic.image_attr.bin_data_id),
        _ => None,
    })
}

fn picture_only_caption_para(mut para: Paragraph) -> Paragraph {
    para.text.clear();
    para.char_offsets.clear();
    para.char_count = 0;
    para
}

fn attach_top_caption_to_first_table(
    paragraphs: &mut [Paragraph],
    caption_para: Paragraph,
) -> bool {
    for para in paragraphs {
        for ctrl in &mut para.controls {
            if let Control::Table(table) = ctrl {
                table.caption = Some(Caption {
                    direction: CaptionDirection::Top,
                    width: 10_000,
                    spacing: 0,
                    max_width: 50_000,
                    paragraphs: vec![caption_para],
                    ..Default::default()
                });
                return true;
            }
        }
    }
    false
}

fn page_image_control_count(doc: &HwpDocument) -> usize {
    let json = doc
        .get_page_control_layout_native(0)
        .expect("page control layout");
    json.matches("\"type\":\"image\"").count()
}

#[test]
fn table_caption_inline_tac_picture_emits_image_node() {
    let baseline_doc = load_sample_doc();
    let baseline_image_count = page_image_control_count(&baseline_doc);

    let mut doc = load_sample_doc();

    let caption_para = first_tac_picture_para(&doc.document().sections[0].paragraphs)
        .expect("fixture must contain a TAC picture paragraph");
    let caption_bin_id =
        tac_picture_bin_id(&caption_para).expect("caption paragraph must have a TAC picture");
    assert!(
        doc.document()
            .bin_data_content
            .iter()
            .any(|content| content.id == caption_bin_id),
        "fixture must contain BinData payload for caption bin_id={caption_bin_id}"
    );

    assert!(
        attach_top_caption_to_first_table(
            &mut doc.document_mut().sections[0].paragraphs,
            caption_para
        ),
        "fixture must contain a top-level table"
    );

    let image_count = page_image_control_count(&doc);

    assert_eq!(
        image_count,
        baseline_image_count + 1,
        "caption inline TAC picture must emit one additional image node"
    );
}

#[test]
fn table_caption_picture_only_tac_paragraph_emits_image_node() {
    let baseline_doc = load_sample_doc();
    let baseline_image_count = page_image_control_count(&baseline_doc);

    let mut doc = load_sample_doc();

    let source_para = first_tac_picture_para(&doc.document().sections[0].paragraphs)
        .expect("fixture must contain a TAC picture paragraph");
    let caption_bin_id =
        tac_picture_bin_id(&source_para).expect("caption paragraph must have a TAC picture");
    assert!(
        doc.document()
            .bin_data_content
            .iter()
            .any(|content| content.id == caption_bin_id),
        "fixture must contain BinData payload for caption bin_id={caption_bin_id}"
    );
    let caption_para = picture_only_caption_para(source_para);

    assert!(
        attach_top_caption_to_first_table(
            &mut doc.document_mut().sections[0].paragraphs,
            caption_para
        ),
        "fixture must contain a top-level table"
    );

    let image_count = page_image_control_count(&doc);

    assert_eq!(
        image_count,
        baseline_image_count + 1,
        "picture-only caption TAC paragraph must emit one additional image node"
    );
}
