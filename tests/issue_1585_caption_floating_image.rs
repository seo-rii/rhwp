//! Issue #1585: caption paragraphs must render TopAndBottom picture controls.
//!
//! Caption layout already handles inline TAC images. This covers floating
//! caption pictures whose wrap mode is TopAndBottom, including captions on a
//! nested table.

use std::fs;
use std::path::Path;

use rhwp::model::control::Control;
use rhwp::model::paragraph::Paragraph;
use rhwp::model::shape::{
    Caption, CaptionDirection, HorzAlign, HorzRelTo, TextWrap, VertAlign, VertRelTo,
};
use rhwp::model::table::Table;
use rhwp::wasm_api::HwpDocument;

const SAMPLE: &str = "samples/hwp-img-001.hwp";

fn load_doc() -> HwpDocument {
    let repo_root = env!("CARGO_MANIFEST_DIR");
    let path = Path::new(repo_root).join(SAMPLE);
    let bytes = fs::read(&path).unwrap_or_else(|error| panic!("read {}: {error}", SAMPLE));
    HwpDocument::from_bytes(&bytes).unwrap_or_else(|error| panic!("parse {}: {error}", SAMPLE))
}

fn page_image_control_count(doc: &HwpDocument) -> usize {
    let json = doc
        .get_page_control_layout_native(0)
        .expect("page control layout");
    json.matches("\"type\":\"image\"").count()
}

fn paragraph_has_picture(para: &Paragraph) -> bool {
    para.controls.iter().any(|ctrl| {
        matches!(
            ctrl,
            Control::Picture(pic) if pic.image_attr.bin_data_id > 0
        )
    })
}

fn first_picture_para(paragraphs: &[Paragraph]) -> Option<Paragraph> {
    for para in paragraphs {
        if paragraph_has_picture(para) {
            return Some(para.clone());
        }
        for ctrl in &para.controls {
            if let Control::Table(table) = ctrl {
                for cell in &table.cells {
                    if let Some(found) = first_picture_para(&cell.paragraphs) {
                        return Some(found);
                    }
                }
            }
        }
    }
    None
}

fn make_caption_floating_picture_para(mut para: Paragraph) -> (Paragraph, u16) {
    para.text.clear();
    para.char_offsets.clear();
    para.char_count = 0;
    let mut bin_id = None;
    for ctrl in &mut para.controls {
        if let Control::Picture(pic) = ctrl {
            pic.common.treat_as_char = false;
            pic.common.text_wrap = TextWrap::TopAndBottom;
            pic.common.vert_rel_to = VertRelTo::Para;
            pic.common.horz_rel_to = HorzRelTo::Column;
            pic.common.vert_align = VertAlign::Top;
            pic.common.horz_align = HorzAlign::Left;
            pic.common.vertical_offset = 0;
            pic.common.horizontal_offset = 0;
            bin_id = Some(pic.image_attr.bin_data_id);
            break;
        }
    }
    (
        para,
        bin_id.expect("fixture paragraph must contain a picture"),
    )
}

fn top_caption(caption_para: Paragraph) -> Caption {
    Caption {
        direction: CaptionDirection::Top,
        width: 10_000,
        spacing: 0,
        max_width: 50_000,
        paragraphs: vec![caption_para],
        ..Default::default()
    }
}

fn attach_top_caption_to_first_table(paragraphs: &mut [Paragraph], caption: Caption) -> bool {
    for para in paragraphs {
        for ctrl in &mut para.controls {
            if let Control::Table(table) = ctrl {
                table.caption = Some(caption);
                return true;
            }
        }
    }
    false
}

fn strip_picture_controls(paragraphs: &mut [Paragraph]) {
    for para in paragraphs {
        para.controls
            .retain(|ctrl| !matches!(ctrl, Control::Picture(_)));
        for ctrl in &mut para.controls {
            if let Control::Table(table) = ctrl {
                for cell in &mut table.cells {
                    strip_picture_controls(&mut cell.paragraphs);
                }
            }
        }
    }
}

fn clone_first_table_without_pictures(paragraphs: &[Paragraph]) -> Option<Table> {
    for para in paragraphs {
        for ctrl in &para.controls {
            if let Control::Table(table) = ctrl {
                let mut cloned = (**table).clone();
                cloned.caption = None;
                for cell in &mut cloned.cells {
                    strip_picture_controls(&mut cell.paragraphs);
                }
                return Some(cloned);
            }
        }
    }
    None
}

fn attach_nested_caption_table_to_first_table(
    paragraphs: &mut [Paragraph],
    mut nested_table: Table,
    caption: Caption,
) -> bool {
    nested_table.caption = Some(caption);
    nested_table.common.treat_as_char = true;
    nested_table.common.text_wrap = TextWrap::TopAndBottom;
    nested_table.common.vert_rel_to = VertRelTo::Para;
    nested_table.common.horz_rel_to = HorzRelTo::Para;
    nested_table.common.vert_align = VertAlign::Top;
    nested_table.common.horz_align = HorzAlign::Left;
    nested_table.common.vertical_offset = 0;
    nested_table.common.horizontal_offset = 0;

    for para in paragraphs {
        for ctrl in &mut para.controls {
            if let Control::Table(table) = ctrl {
                let Some(cell) = table.cells.first_mut() else {
                    return false;
                };
                let Some(cell_para) = cell.paragraphs.first_mut() else {
                    return false;
                };
                cell_para.text.clear();
                cell_para.char_offsets.clear();
                cell_para.char_count = 0;
                cell_para.controls.clear();
                cell_para
                    .controls
                    .push(Control::Table(Box::new(nested_table)));
                return true;
            }
        }
    }
    false
}

fn assert_bin_payload_exists(doc: &HwpDocument, bin_id: u16) {
    assert!(
        doc.document()
            .bin_data_content
            .iter()
            .any(|content| content.id == bin_id),
        "fixture must contain BinData payload for bin_id={bin_id}"
    );
}

#[test]
fn table_caption_topbottom_picture_emits_image_node() {
    let baseline_doc = load_doc();
    let baseline_image_count = page_image_control_count(&baseline_doc);

    let mut doc = load_doc();
    let source_para = first_picture_para(&doc.document().sections[0].paragraphs)
        .expect("fixture must contain a picture paragraph");
    let (caption_para, bin_id) = make_caption_floating_picture_para(source_para);
    assert_bin_payload_exists(&doc, bin_id);

    assert!(
        attach_top_caption_to_first_table(
            &mut doc.document_mut().sections[0].paragraphs,
            top_caption(caption_para),
        ),
        "fixture must contain a top-level table"
    );

    assert_eq!(
        page_image_control_count(&doc),
        baseline_image_count + 1,
        "caption TopAndBottom picture must emit one additional image node"
    );
}

#[test]
fn nested_table_caption_topbottom_picture_emits_image_node() {
    let baseline_doc = load_doc();
    let baseline_image_count = page_image_control_count(&baseline_doc);

    let mut doc = load_doc();
    let source_para = first_picture_para(&doc.document().sections[0].paragraphs)
        .expect("fixture must contain a picture paragraph");
    let (caption_para, bin_id) = make_caption_floating_picture_para(source_para);
    assert_bin_payload_exists(&doc, bin_id);
    let nested_table = clone_first_table_without_pictures(&doc.document().sections[0].paragraphs)
        .expect("fixture must contain a cloneable table");

    assert!(
        attach_nested_caption_table_to_first_table(
            &mut doc.document_mut().sections[0].paragraphs,
            nested_table,
            top_caption(caption_para),
        ),
        "fixture must allow inserting a nested caption table"
    );

    assert_eq!(
        page_image_control_count(&doc),
        baseline_image_count + 1,
        "nested table caption TopAndBottom picture must emit one additional image node"
    );
}
