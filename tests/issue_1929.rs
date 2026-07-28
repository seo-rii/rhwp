//! HWP5 picture `imgDim` preservation when raw picture extras are unavailable.

use rhwp::model::control::Control;
use rhwp::model::document::{Document, Section};
use rhwp::model::image::Picture;
use rhwp::model::paragraph::{LineSeg, Paragraph};
use rhwp::model::style::CharShape;
use rhwp::parser::parse_document;
use rhwp::serializer::serialize_document;

fn document_with_picture(img_dim: (u32, u32)) -> Document {
    let mut picture = Picture::default();
    picture.image_attr.bin_data_id = 0;
    picture.img_dim = img_dim;
    picture.common.width = 8000;
    picture.common.height = 6000;
    assert!(picture.raw_picture_extra.is_empty());

    let paragraph = Paragraph {
        char_count: 1,
        line_segs: vec![LineSeg {
            line_height: 1000,
            line_spacing: 600,
            ..Default::default()
        }],
        controls: vec![Control::Picture(Box::new(picture))],
        ..Default::default()
    };

    let mut document = Document::default();
    document.doc_info.char_shapes.push(CharShape::default());
    document.sections.push(Section {
        paragraphs: vec![paragraph],
        ..Default::default()
    });
    document
}

fn first_picture(document: &Document) -> &Picture {
    document.sections[0]
        .paragraphs
        .iter()
        .flat_map(|paragraph| &paragraph.controls)
        .find_map(|control| match control {
            Control::Picture(picture) => Some(picture.as_ref()),
            _ => None,
        })
        .expect("picture")
}

#[test]
fn img_dim_survives_plain_hwp5_roundtrip() {
    let document = document_with_picture((117_780, 35_760));
    let bytes = serialize_document(&document).expect("serialize");
    let reparsed = parse_document(&bytes).expect("reparse");
    assert_eq!(first_picture(&reparsed).img_dim, (117_780, 35_760));

    let bytes = serialize_document(&reparsed).expect("serialize second round");
    let reparsed = parse_document(&bytes).expect("reparse second round");
    assert_eq!(first_picture(&reparsed).img_dim, (117_780, 35_760));
}

#[test]
fn zero_img_dim_keeps_the_crop_edge_fallback() {
    let mut document = document_with_picture((0, 0));
    if let Control::Picture(picture) = &mut document.sections[0].paragraphs[0].controls[0] {
        picture.crop.right = 4321;
        picture.crop.bottom = 1234;
    }

    let bytes = serialize_document(&document).expect("serialize");
    let reparsed = parse_document(&bytes).expect("reparse");
    assert_eq!(first_picture(&reparsed).img_dim, (4321, 1234));
}
