//! HWPX ZIP 컨테이너 읽기
//!
//! HWPX 파일은 ZIP 아카이브이다. 내부 파일을 읽는 래퍼를 제공한다.
//!
//! ## 압축 해제 폭탄 방어
//!
//! ZIP은 높은 압축률을 허용하므로 작은 HWPX 파일이 매우 큰 XML/BinData
//! 엔트리로 팽창할 수 있다. 엔트리별 압축 해제 상한을 적용해 무제한
//! 할당을 차단한다.

use std::io::{self, Cursor, Read};
use zip::ZipArchive;

use super::HwpxError;

/// XML 엔트리(section, header, content.hpf 등)당 압축 해제 상한.
pub const MAX_XML_SIZE: usize = 32 * 1024 * 1024;

/// BinData(이미지, 폰트 등) 엔트리당 압축 해제 상한.
pub const MAX_BINDATA_SIZE: usize = 64 * 1024 * 1024;

fn read_limited<R: Read>(reader: &mut R, max: usize) -> io::Result<Vec<u8>> {
    let mut buf = Vec::new();
    let cap = (max as u64).saturating_add(1);
    reader.take(cap).read_to_end(&mut buf)?;
    if buf.len() > max {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "HWPX entry exceeds {} byte limit (possible decompression bomb)",
                max
            ),
        ));
    }
    Ok(buf)
}

/// HWPX ZIP 컨테이너 리더
pub struct HwpxReader {
    archive: ZipArchive<Cursor<Vec<u8>>>,
}

impl HwpxReader {
    /// ZIP 아카이브를 연다.
    pub fn open(data: &[u8]) -> Result<Self, HwpxError> {
        let cursor = Cursor::new(data.to_vec());
        let archive = ZipArchive::new(cursor)?;
        Ok(HwpxReader { archive })
    }

    /// 지정한 경로의 파일을 UTF-8 문자열로 읽는다.
    pub fn read_file(&mut self, path: &str) -> Result<String, HwpxError> {
        let mut file = self
            .archive
            .by_name(path)
            .map_err(|e| HwpxError::MissingFile(format!("{}: {}", path, e)))?;
        let bytes = read_limited(&mut file, MAX_XML_SIZE)
            .map_err(|e| HwpxError::ZipError(format!("{} 읽기 실패: {}", path, e)))?;
        String::from_utf8(bytes)
            .map_err(|e| HwpxError::ZipError(format!("{} UTF-8 변환 실패: {}", path, e)))
    }

    /// 지정한 경로의 파일을 바이트 배열로 읽는다.
    pub fn read_file_bytes(&mut self, path: &str) -> Result<Vec<u8>, HwpxError> {
        self.read_file_bytes_limited(path, MAX_BINDATA_SIZE)
    }

    /// 지정한 경로의 파일을 `max_bytes` 바이트까지만 압축 해제한다.
    pub fn read_file_bytes_limited(
        &mut self,
        path: &str,
        max_bytes: usize,
    ) -> Result<Vec<u8>, HwpxError> {
        let mut file = self
            .archive
            .by_name(path)
            .map_err(|e| HwpxError::MissingFile(format!("{}: {}", path, e)))?;
        let max_bytes = max_bytes.min(MAX_BINDATA_SIZE);
        if file.size() > max_bytes as u64 {
            return Err(HwpxError::ZipError(format!(
                "{} 읽기 실패: HWPX entry exceeds {} byte limit (possible decompression bomb)",
                path, max_bytes
            )));
        }
        read_limited(&mut file, max_bytes)
            .map_err(|e| HwpxError::ZipError(format!("{} 읽기 실패: {}", path, e)))
    }

    /// 아카이브 내 파일 목록을 반환한다.
    pub fn file_names(&self) -> Vec<String> {
        self.archive.file_names().map(|s| s.to_string()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_open_invalid_zip() {
        let result = HwpxReader::open(&[0u8; 100]);
        assert!(result.is_err());
    }

    #[test]
    fn test_read_limited_under_cap() {
        let data = vec![0u8; 1000];
        let mut cursor = Cursor::new(data);
        let result = read_limited(&mut cursor, 2000).unwrap();
        assert_eq!(result.len(), 1000);
    }

    #[test]
    fn test_read_limited_at_cap() {
        let data = vec![0u8; 1000];
        let mut cursor = Cursor::new(data);
        let result = read_limited(&mut cursor, 1000).unwrap();
        assert_eq!(result.len(), 1000);
    }

    #[test]
    fn test_read_limited_over_cap() {
        let data = vec![0u8; 1001];
        let mut cursor = Cursor::new(data);
        let result = read_limited(&mut cursor, 1000);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn test_compressed_entry_limited_read_rejects_before_materialization() {
        use std::io::Write;
        use zip::write::SimpleFileOptions;
        use zip::ZipWriter;

        let mut out = Cursor::new(Vec::<u8>::new());
        {
            let mut zip = ZipWriter::new(&mut out);
            let options =
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            zip.start_file("BinData/font.ttf", options).unwrap();
            zip.write_all(&vec![b'A'; 4096]).unwrap();
            zip.finish().unwrap();
        }

        let mut reader = HwpxReader::open(&out.into_inner()).unwrap();
        let error = reader
            .read_file_bytes_limited("BinData/font.ttf", 1024)
            .expect_err("oversized deflated entry must be rejected");
        assert!(error.to_string().contains("1024 byte limit"));
    }

    #[test]
    fn test_zip_bomb_xml_entry_rejected() {
        use std::io::Write;
        use zip::write::SimpleFileOptions;
        use zip::ZipWriter;

        let mut out = Cursor::new(Vec::<u8>::new());
        {
            let mut zip = ZipWriter::new(&mut out);
            let opts =
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            zip.start_file("Contents/bomb.xml", opts).unwrap();
            zip.write_all(&vec![b'A'; MAX_XML_SIZE + 1]).unwrap();
            zip.finish().unwrap();
        }

        let bytes = out.into_inner();
        assert!(bytes.len() < 1024 * 1024);

        let mut reader = HwpxReader::open(&bytes).unwrap();
        let result = reader.read_file("Contents/bomb.xml");
        assert!(result.is_err());
        match result.unwrap_err() {
            HwpxError::ZipError(msg) => {
                assert!(msg.contains("decompression bomb") || msg.contains("limit"));
            }
            other => panic!("expected ZipError, got {:?}", other),
        }
    }
}
