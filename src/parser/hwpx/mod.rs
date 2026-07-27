//! HWPX 파일 파서 모듈
//!
//! HWPX(XML 기반 HWP) 파일을 파싱하여 Document 모델로 변환한다.
//! HWPX는 ZIP 패키지 내 XML 파일로 구성된 KS X 6101:2024 표준 포맷이다.
//!
//! ## 파싱 순서
//! 1. ZIP 컨테이너 열기 (reader)
//! 2. content.hpf → 섹션 파일 목록 추출 (content)
//! 3. header.xml → DocInfo 변환 (header)
//! 4. section*.xml → Section 변환 (section)
//! 5. BinData → 이미지 로딩

pub mod content;
pub mod header;
pub mod reader;
pub mod section;
pub mod utils;

use crate::model::bin_data::{BinData, BinDataContent, BinDataType};
use crate::model::document::{Document, FileHeader, HwpVersion, Section};

/// HWPX ZIP 원본을 보유하고 요청 시점에 BinData 엔트리를 압축 해제한다.
struct HwpxBinResolver {
    reader: std::sync::Mutex<reader::HwpxReader>,
}

impl std::fmt::Debug for HwpxBinResolver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HwpxBinResolver").finish_non_exhaustive()
    }
}

impl crate::model::bin_data::BinDataResolver for HwpxBinResolver {
    fn resolve(&self, key: &str) -> Vec<u8> {
        let mut reader = match self.reader.lock() {
            Ok(reader) => reader,
            Err(poisoned) => poisoned.into_inner(),
        };
        match reader.read_file_bytes(key) {
            Ok(data) => data,
            Err(error) => {
                eprintln!("경고: BinData '{}' 로드 실패: {}", key, error);
                Vec::new()
            }
        }
    }

    fn resolve_limited(&self, key: &str, max_bytes: usize) -> Option<Vec<u8>> {
        let mut reader = match self.reader.lock() {
            Ok(reader) => reader,
            Err(poisoned) => poisoned.into_inner(),
        };
        match reader.read_file_bytes_limited(key, max_bytes) {
            Ok(data) => Some(data),
            Err(error) => {
                eprintln!("경고: BinData '{}' bounded 로드 실패: {}", key, error);
                None
            }
        }
    }
}

/// HWPX 파싱 에러
#[derive(Debug)]
pub enum HwpxError {
    /// ZIP 컨테이너 오류
    ZipError(String),
    /// XML 파싱 오류
    XmlError(String),
    /// 필수 파일 누락
    MissingFile(String),
    /// 데이터 변환 오류
    ConversionError(String),
}

impl std::fmt::Display for HwpxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HwpxError::ZipError(e) => write!(f, "ZIP 오류: {}", e),
            HwpxError::XmlError(e) => write!(f, "XML 파싱 오류: {}", e),
            HwpxError::MissingFile(e) => write!(f, "필수 파일 누락: {}", e),
            HwpxError::ConversionError(e) => write!(f, "변환 오류: {}", e),
        }
    }
}

impl std::error::Error for HwpxError {}

impl From<zip::result::ZipError> for HwpxError {
    fn from(e: zip::result::ZipError) -> Self {
        HwpxError::ZipError(e.to_string())
    }
}

impl From<quick_xml::Error> for HwpxError {
    fn from(e: quick_xml::Error) -> Self {
        HwpxError::XmlError(e.to_string())
    }
}

/// HWPX 파일 바이트 데이터를 파싱하여 Document IR로 변환
pub fn parse_hwpx(data: &[u8]) -> Result<Document, HwpxError> {
    // 1. ZIP 컨테이너 열기
    let mut reader = reader::HwpxReader::open(data)?;

    // 2. content.hpf → 섹션 파일 목록 + BinData 목록
    let content_xml = reader.read_file("Contents/content.hpf")?;
    let package_info = content::parse_content_hpf(&content_xml)?;

    // 3. header.xml → DocInfo, DocProperties
    let header_xml = reader.read_file("Contents/header.xml")?;
    let (mut doc_info, doc_properties) = header::parse_hwpx_header(&header_xml)?;
    resolve_embedded_font_references(&mut doc_info, &package_info.bin_data_items);

    // BinData 목록을 DocInfo에 등록
    for (i, item) in package_info.bin_data_items.iter().enumerate() {
        let ext = item.href.rsplit('.').next().unwrap_or("dat").to_string();
        let (data_type, abs_path) = if item.is_embedded {
            (BinDataType::Embedding, None)
        } else {
            (BinDataType::Link, Some(item.href.clone()))
        };
        doc_info.bin_data_list.push(BinData {
            data_type,
            storage_id: (i + 1) as u16,
            extension: Some(ext),
            abs_path,
            ..Default::default()
        });
    }

    // 4. section*.xml → Section 변환
    let mut sections = Vec::new();
    for section_href in &package_info.section_files {
        let section_xml = reader.read_file(section_href)?;
        match section::parse_hwpx_section(&section_xml) {
            Ok(section) => sections.push(section),
            Err(e) => {
                eprintln!("경고: {} 파싱 실패: {}", section_href, e);
                sections.push(Section::default());
            }
        }
    }

    // 5. BinData 이미지 등록 (지연 로딩)
    let bin_data_entries: std::collections::HashSet<String> =
        reader.file_names().into_iter().collect();
    let mut lazy_bin_data = Vec::new();
    for (i, item) in package_info.bin_data_items.iter().enumerate() {
        if !item.is_embedded {
            continue;
        }
        if !bin_data_entries.contains(&item.href) {
            eprintln!("경고: BinData '{}' 엔트리 없음", item.href);
            continue;
        }
        let ext = item.href.rsplit('.').next().unwrap_or("dat").to_string();
        lazy_bin_data.push(((i + 1) as u16, item.href.clone(), ext));
    }

    // 5-1. Chart/*.xml (OOXML 차트) 로딩 — bin_data_id = 60000+N, extension="ooxml_chart"
    // section 파서에서 <hp:chart chartIDRef="Chart/chartN.xml">를 만나면 동일 ID의 OleShape 생성
    let mut chart_bin_data = Vec::new();
    for n in 1..=64u16 {
        let path = format!("Chart/chart{}.xml", n);
        match reader.read_file_bytes(&path) {
            Ok(data) => {
                chart_bin_data.push(BinDataContent {
                    id: 60000 + n,
                    data: data.into(),
                    extension: "ooxml_chart".to_string(),
                });
            }
            Err(_) => break,
        }
    }

    // 파싱에 사용한 ZIP reader를 그대로 lazy resolver로 넘겨 원본 ZIP 복사를 피한다.
    let bin_resolver: std::sync::Arc<dyn crate::model::bin_data::BinDataResolver> =
        std::sync::Arc::new(HwpxBinResolver {
            reader: std::sync::Mutex::new(reader),
        });
    let mut bin_data_content = lazy_bin_data
        .into_iter()
        .map(|(id, key, extension)| BinDataContent {
            id,
            data: crate::model::bin_data::BinDataBytes::Lazy {
                resolver: bin_resolver.clone(),
                key,
            },
            extension,
        })
        .collect::<Vec<_>>();
    bin_data_content.extend(chart_bin_data);

    // Document 조립
    let model_header = FileHeader {
        version: HwpVersion {
            major: 5,
            minor: 1,
            build: 0,
            revision: 0,
        },
        flags: 0,
        compressed: false,
        encrypted: false,
        distribution: false,
        raw_data: None,
    };

    let mut doc = Document {
        header: model_header,
        doc_properties,
        doc_info,
        sections,
        preview: None,
        bin_data_content,
        extra_streams: Vec::new(),
    };
    super::populate_link_image_paths(&mut doc);

    Ok(doc)
}

fn resolve_embedded_font_references(
    doc_info: &mut crate::model::document::DocInfo,
    items: &[content::PackageItem],
) {
    let mut item_ids = std::collections::HashMap::<&str, Option<u16>>::new();
    for (index, item) in items.iter().enumerate() {
        let storage_id = item
            .is_embedded
            .then(|| u16::try_from(index + 1).ok())
            .flatten();
        item_ids
            .entry(item.id.as_str())
            .and_modify(|resolved| *resolved = None)
            .or_insert(storage_id);
    }

    for font in doc_info.font_faces.iter_mut().flatten() {
        font.resolved_bin_data_id = font
            .is_embedded
            .then(|| {
                item_ids
                    .get(font.bin_item_id_ref.as_str())
                    .copied()
                    .flatten()
            })
            .flatten();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_hwpx_invalid_data() {
        let result = parse_hwpx(&[0u8; 10]);
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_hwpx_not_zip() {
        // CFB/HWP 데이터로 시도
        let result = parse_hwpx(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
        assert!(result.is_err());
    }

    #[test]
    fn embedded_font_reference_uses_exact_manifest_item_id() {
        let mut doc_info = crate::model::document::DocInfo {
            font_faces: vec![vec![crate::model::style::Font {
                name: "Embedded Face".to_string(),
                is_embedded: true,
                bin_item_id_ref: "font-resource-alpha".to_string(),
                ..Default::default()
            }]],
            ..Default::default()
        };
        let items = vec![
            content::PackageItem {
                id: "font-resource-beta".to_string(),
                href: "BinData/beta.ttf".to_string(),
                media_type: "application/x-font-ttf".to_string(),
                is_embedded: true,
            },
            content::PackageItem {
                id: "font-resource-alpha".to_string(),
                href: "BinData/alpha.ttf".to_string(),
                media_type: "application/x-font-ttf".to_string(),
                is_embedded: true,
            },
        ];

        resolve_embedded_font_references(&mut doc_info, &items);

        let font = &doc_info.font_faces[0][0];
        assert_eq!(font.resolved_bin_data_id, Some(2));
        assert_eq!(font.bin_item_id_ref, "font-resource-alpha");
    }

    #[test]
    fn non_embedded_font_does_not_resolve_manifest_reference() {
        let mut doc_info = crate::model::document::DocInfo {
            font_faces: vec![vec![crate::model::style::Font {
                name: "External Face".to_string(),
                bin_item_id_ref: "font-resource-alpha".to_string(),
                ..Default::default()
            }]],
            ..Default::default()
        };
        let items = vec![content::PackageItem {
            id: "font-resource-alpha".to_string(),
            href: "BinData/alpha.ttf".to_string(),
            media_type: "application/x-font-ttf".to_string(),
            is_embedded: true,
        }];

        resolve_embedded_font_references(&mut doc_info, &items);

        assert_eq!(doc_info.font_faces[0][0].resolved_bin_data_id, None);
    }

    #[test]
    fn embedded_font_reference_rejects_external_or_ambiguous_manifest_items() {
        let make_font = || crate::model::style::Font {
            name: "Embedded Face".to_string(),
            is_embedded: true,
            bin_item_id_ref: "font-resource".to_string(),
            ..Default::default()
        };
        let package_item = |href: &str, is_embedded| content::PackageItem {
            id: "font-resource".to_string(),
            href: href.to_string(),
            media_type: "application/x-font-ttf".to_string(),
            is_embedded,
        };

        let mut external = crate::model::document::DocInfo {
            font_faces: vec![vec![make_font()]],
            ..Default::default()
        };
        resolve_embedded_font_references(&mut external, &[package_item("external.ttf", false)]);
        assert_eq!(external.font_faces[0][0].resolved_bin_data_id, None);

        let mut ambiguous = crate::model::document::DocInfo {
            font_faces: vec![vec![make_font()]],
            ..Default::default()
        };
        resolve_embedded_font_references(
            &mut ambiguous,
            &[
                package_item("external.ttf", false),
                package_item("BinData/embedded.ttf", true),
            ],
        );
        assert_eq!(ambiguous.font_faces[0][0].resolved_bin_data_id, None);
    }
}
