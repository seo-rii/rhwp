use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ImageResourceId(pub usize);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SvgResourceId(pub usize);

pub const RESOURCE_KEY_ALGORITHM: &str = "blake3";

/// 레이어 replay가 공유하는 바이너리/문자열 자원 저장소.
///
/// 내부 IR과 WASM object export에서 큰 payload를 handle로 참조해 backend와
/// 캐시 계층이 같은 자원을 재사용하도록 만든다.
#[derive(Debug, Clone, Default)]
pub struct ResourceArena {
    image_bytes: Vec<Vec<u8>>,
    image_hashes: Vec<u64>,
    image_fingerprints: Vec<[u8; 16]>,
    image_lookup: HashMap<u64, Vec<ImageResourceId>>,
    svg_fragments: Vec<String>,
    svg_hashes: Vec<u64>,
    svg_fingerprints: Vec<[u8; 16]>,
    svg_lookup: HashMap<u64, Vec<SvgResourceId>>,
}

impl ResourceArena {
    pub fn intern_image_bytes(&mut self, bytes: &[u8]) -> ImageResourceId {
        let hash = resource_hash(bytes);
        if let Some(candidates) = self.image_lookup.get(&hash) {
            for id in candidates {
                if self.image_bytes[id.0].as_slice() == bytes {
                    return *id;
                }
            }
        }

        let id = ImageResourceId(self.image_bytes.len());
        self.image_bytes.push(bytes.to_vec());
        self.image_hashes.push(hash);
        self.image_fingerprints.push(resource_fingerprint(bytes));
        self.image_lookup.entry(hash).or_default().push(id);
        id
    }

    pub fn image_bytes(&self, id: ImageResourceId) -> Option<&[u8]> {
        self.image_bytes.get(id.0).map(Vec::as_slice)
    }

    pub fn image_count(&self) -> usize {
        self.image_bytes.len()
    }

    pub fn image_hash(&self, id: ImageResourceId) -> Option<u64> {
        self.image_hashes.get(id.0).copied()
    }

    pub fn image_fingerprint(&self, id: ImageResourceId) -> Option<[u8; 16]> {
        self.image_fingerprints.get(id.0).copied()
    }

    pub fn image_resources(&self) -> impl Iterator<Item = (ImageResourceId, &[u8])> + '_ {
        self.image_bytes
            .iter()
            .enumerate()
            .map(|(index, bytes)| (ImageResourceId(index), bytes.as_slice()))
    }

    pub fn intern_svg_fragment(&mut self, svg: &str) -> SvgResourceId {
        let hash = resource_hash(svg);
        if let Some(candidates) = self.svg_lookup.get(&hash) {
            for id in candidates {
                if self.svg_fragments[id.0].as_str() == svg {
                    return *id;
                }
            }
        }

        let id = SvgResourceId(self.svg_fragments.len());
        self.svg_fragments.push(svg.to_string());
        self.svg_hashes.push(hash);
        self.svg_fingerprints.push(resource_fingerprint(svg));
        self.svg_lookup.entry(hash).or_default().push(id);
        id
    }

    pub fn svg_fragment(&self, id: SvgResourceId) -> Option<&str> {
        self.svg_fragments.get(id.0).map(String::as_str)
    }

    pub fn svg_count(&self) -> usize {
        self.svg_fragments.len()
    }

    pub fn svg_hash(&self, id: SvgResourceId) -> Option<u64> {
        self.svg_hashes.get(id.0).copied()
    }

    pub fn svg_fingerprint(&self, id: SvgResourceId) -> Option<[u8; 16]> {
        self.svg_fingerprints.get(id.0).copied()
    }

    pub fn svg_resources(&self) -> impl Iterator<Item = (SvgResourceId, &str)> + '_ {
        self.svg_fragments
            .iter()
            .enumerate()
            .map(|(index, svg)| (SvgResourceId(index), svg.as_str()))
    }
}

fn resource_hash(bytes: impl AsRef<[u8]>) -> u64 {
    const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
    const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

    let mut hash = FNV_OFFSET_BASIS;
    for byte in bytes.as_ref() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

fn resource_fingerprint(bytes: impl AsRef<[u8]>) -> [u8; 16] {
    let digest = blake3::hash(bytes.as_ref());
    let mut fingerprint = [0; 16];
    fingerprint.copy_from_slice(&digest.as_bytes()[..16]);
    fingerprint
}

pub fn resource_digest_hex(bytes: impl AsRef<[u8]>) -> String {
    blake3::hash(bytes.as_ref()).to_hex().to_string()
}

pub fn image_resource_key(byte_len: usize, digest: &str) -> String {
    resource_key("img", byte_len, digest)
}

pub fn svg_resource_key(byte_len: usize, digest: &str) -> String {
    resource_key("svg", byte_len, digest)
}

fn resource_key(kind: &str, byte_len: usize, digest: &str) -> String {
    format!("{kind}:{RESOURCE_KEY_ALGORITHM}:{byte_len}:{digest}")
}

#[cfg(test)]
mod tests {
    use super::{
        image_resource_key, resource_digest_hex, resource_fingerprint, svg_resource_key,
        ImageResourceId, ResourceArena, SvgResourceId,
    };

    #[test]
    fn interns_duplicate_resources_once() {
        let mut arena = ResourceArena::default();
        let image_a = arena.intern_image_bytes(&[1, 2, 3, 4]);
        let image_b = arena.intern_image_bytes(&[1, 2, 3, 4]);
        let svg_a = arena.intern_svg_fragment("<svg/>");
        let svg_b = arena.intern_svg_fragment("<svg/>");

        assert_eq!(image_a, ImageResourceId(0));
        assert_eq!(image_b, ImageResourceId(0));
        assert_eq!(arena.image_count(), 1);
        assert_eq!(arena.image_bytes(image_a), Some(&[1, 2, 3, 4][..]));
        assert_eq!(arena.image_hash(image_a), arena.image_hash(image_b));
        assert_eq!(arena.image_hash(image_a), Some(0xbe7a_5e77_5165_785d));
        assert_eq!(
            arena.image_fingerprint(image_a),
            Some(resource_fingerprint([1, 2, 3, 4]))
        );
        assert_eq!(
            arena.image_resources().collect::<Vec<_>>(),
            vec![(ImageResourceId(0), &[1, 2, 3, 4][..])]
        );

        assert_eq!(svg_a, SvgResourceId(0));
        assert_eq!(svg_b, SvgResourceId(0));
        assert_eq!(arena.svg_count(), 1);
        assert_eq!(arena.svg_fragment(svg_a), Some("<svg/>"));
        assert_eq!(arena.svg_hash(svg_a), arena.svg_hash(svg_b));
        assert!(arena.svg_hash(svg_a).is_some());
        assert_eq!(
            arena.svg_fingerprint(svg_a),
            Some(resource_fingerprint("<svg/>"))
        );
        assert_eq!(
            arena.svg_resources().collect::<Vec<_>>(),
            vec![(SvgResourceId(0), "<svg/>")]
        );
    }

    #[test]
    fn resource_digest_is_stable_and_content_dependent() {
        let digest = resource_digest_hex([1, 2, 3, 4]);
        assert_eq!(digest.len(), 64);
        assert_eq!(digest, resource_digest_hex([1, 2, 3, 4]));
        assert_ne!(digest, resource_digest_hex([1, 2, 3, 5]));
    }

    #[test]
    fn resource_keys_include_kind_algorithm_length_and_digest() {
        assert_eq!(image_resource_key(4, "abcd"), "img:blake3:4:abcd");
        assert_eq!(
            svg_resource_key(6, "0123456789abcdef"),
            "svg:blake3:6:0123456789abcdef"
        );
    }
}
