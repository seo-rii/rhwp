use std::collections::{hash_map::DefaultHasher, HashMap};
use std::hash::{Hash, Hasher};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ImageResourceId(pub usize);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SvgResourceId(pub usize);

/// 레이어 replay가 공유하는 바이너리/문자열 자원 저장소.
///
/// 내부 IR과 WASM object export에서 큰 payload를 handle로 참조해 backend와
/// 캐시 계층이 같은 자원을 재사용하도록 만든다.
#[derive(Debug, Clone, Default)]
pub struct ResourceArena {
    image_bytes: Vec<Vec<u8>>,
    image_hashes: Vec<u64>,
    image_lookup: HashMap<u64, Vec<ImageResourceId>>,
    svg_fragments: Vec<String>,
    svg_hashes: Vec<u64>,
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

    pub fn svg_resources(&self) -> impl Iterator<Item = (SvgResourceId, &str)> + '_ {
        self.svg_fragments
            .iter()
            .enumerate()
            .map(|(index, svg)| (SvgResourceId(index), svg.as_str()))
    }
}

fn resource_hash<T: Hash + ?Sized>(value: &T) -> u64 {
    let mut hasher = DefaultHasher::new();
    value.hash(&mut hasher);
    hasher.finish()
}

#[cfg(test)]
mod tests {
    use super::{ImageResourceId, ResourceArena, SvgResourceId};

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
        assert!(arena.image_hash(image_a).is_some());
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
            arena.svg_resources().collect::<Vec<_>>(),
            vec![(SvgResourceId(0), "<svg/>")]
        );
    }
}
