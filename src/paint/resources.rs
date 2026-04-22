use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ImageResourceId(pub usize);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SvgResourceId(pub usize);

/// 레이어 replay가 공유하는 바이너리/문자열 자원 저장소.
///
/// 전환기에는 JSON wire format을 그대로 유지하되, 내부 IR에서는 큰 payload를
/// handle로 참조해 backend와 캐시 계층이 같은 자원을 재사용하도록 만든다.
#[derive(Debug, Clone, Default)]
pub struct ResourceArena {
    image_bytes: Vec<Vec<u8>>,
    image_lookup: HashMap<Vec<u8>, ImageResourceId>,
    svg_fragments: Vec<String>,
    svg_lookup: HashMap<String, SvgResourceId>,
}

impl ResourceArena {
    pub fn intern_image_bytes(&mut self, bytes: &[u8]) -> ImageResourceId {
        if let Some(id) = self.image_lookup.get(bytes) {
            return *id;
        }

        let owned = bytes.to_vec();
        let id = ImageResourceId(self.image_bytes.len());
        self.image_bytes.push(owned.clone());
        self.image_lookup.insert(owned, id);
        id
    }

    pub fn image_bytes(&self, id: ImageResourceId) -> Option<&[u8]> {
        self.image_bytes.get(id.0).map(Vec::as_slice)
    }

    pub fn image_count(&self) -> usize {
        self.image_bytes.len()
    }

    pub fn intern_svg_fragment(&mut self, svg: &str) -> SvgResourceId {
        if let Some(id) = self.svg_lookup.get(svg) {
            return *id;
        }

        let owned = svg.to_string();
        let id = SvgResourceId(self.svg_fragments.len());
        self.svg_fragments.push(owned.clone());
        self.svg_lookup.insert(owned, id);
        id
    }

    pub fn svg_fragment(&self, id: SvgResourceId) -> Option<&str> {
        self.svg_fragments.get(id.0).map(String::as_str)
    }

    pub fn svg_count(&self) -> usize {
        self.svg_fragments.len()
    }
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

        assert_eq!(svg_a, SvgResourceId(0));
        assert_eq!(svg_b, SvgResourceId(0));
        assert_eq!(arena.svg_count(), 1);
        assert_eq!(arena.svg_fragment(svg_a), Some("<svg/>"));
    }
}
