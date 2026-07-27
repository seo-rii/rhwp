use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use skia_safe::{Font, FontMgr, FontStyle, Typeface};

use crate::renderer::font_paths;
use crate::renderer::TextStyle;

use super::paint_conv::{
    font_family_candidates, font_from_typeface, font_style_for_text, system_typeface_for_text,
    text_font_size, typeface_covers_text,
};

const MAX_FONT_FILES: usize = 256;
const MAX_FONT_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_FONT_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
const MAX_COLLECTION_FACES: u32 = 64;

static BUNDLED_TYPEFACES: OnceLock<TypefaceCatalog> = OnceLock::new();

#[derive(Clone, Default)]
struct TypefaceCatalog {
    by_family: HashMap<String, Vec<Typeface>>,
}

impl TypefaceCatalog {
    fn load(font_mgr: &FontMgr, sources: &[PathBuf]) -> Self {
        let mut catalog = Self::default();
        let mut total_bytes = 0_u64;
        for path in font_files(sources).into_iter().take(MAX_FONT_FILES) {
            let Ok(metadata) = path.metadata() else {
                continue;
            };
            if metadata.len() == 0
                || metadata.len() > MAX_FONT_FILE_BYTES
                || total_bytes.saturating_add(metadata.len()) > MAX_FONT_TOTAL_BYTES
            {
                continue;
            }
            let Ok(bytes) = std::fs::read(&path) else {
                continue;
            };
            total_bytes = total_bytes.saturating_add(bytes.len() as u64);
            let face_count = ttf_parser::fonts_in_collection(&bytes)
                .unwrap_or(1)
                .clamp(1, MAX_COLLECTION_FACES);
            for face_index in 0..face_count {
                if let Some(typeface) = font_mgr.new_from_data(&bytes, Some(face_index as usize)) {
                    catalog.insert(typeface);
                }
            }
        }
        catalog
    }

    fn insert(&mut self, typeface: Typeface) {
        let family = canonical_family_key(&typeface.family_name());
        let faces = self.by_family.entry(family).or_default();
        if !faces
            .iter()
            .any(|existing| existing.unique_id() == typeface.unique_id())
        {
            faces.push(typeface);
            faces.sort_by_key(|face| {
                let style = face.font_style();
                (*style.weight(), *style.width(), style.slant() as i32)
            });
        }
    }

    fn typeface_for_text(
        &self,
        candidates: &[String],
        requested_style: FontStyle,
        font_size: f32,
        sample_text: &str,
    ) -> Option<Typeface> {
        for candidate in candidates {
            let Some(faces) = self.by_family.get(&canonical_family_key(candidate)) else {
                continue;
            };
            if let Some(typeface) = faces
                .iter()
                .filter(|face| typeface_covers_text(face, font_size, sample_text))
                .min_by_key(|face| font_style_distance(face.font_style(), requested_style))
            {
                return Some(typeface.clone());
            }
        }
        None
    }

    #[cfg(test)]
    fn contains_family(&self, family: &str) -> bool {
        self.by_family.contains_key(&canonical_family_key(family))
    }
}

pub(super) struct SkiaFontResolver {
    font_mgr: FontMgr,
    custom: TypefaceCatalog,
    bundled: TypefaceCatalog,
}

impl SkiaFontResolver {
    pub(super) fn new(font_mgr: FontMgr, custom_paths: &[PathBuf]) -> Self {
        let custom = TypefaceCatalog::load(&font_mgr, &font_paths::custom_font_dirs(custom_paths));
        let bundled = BUNDLED_TYPEFACES
            .get_or_init(|| TypefaceCatalog::load(&font_mgr, &font_paths::bundled_font_dirs()))
            .clone();
        Self {
            font_mgr,
            custom,
            bundled,
        }
    }

    pub(super) fn make_font(&self, style: &TextStyle, sample_text: &str) -> Font {
        let candidates = font_family_candidates(style, sample_text);
        let font_style = font_style_for_text(style);
        let font_size = text_font_size(style);
        let typeface = self
            .custom
            .typeface_for_text(&candidates, font_style, font_size, sample_text)
            .or_else(|| system_typeface_for_text(style, &self.font_mgr, sample_text))
            .or_else(|| {
                self.bundled
                    .typeface_for_text(&candidates, font_style, font_size, sample_text)
            })
            .or_else(|| self.font_mgr.legacy_make_typeface(None::<&str>, font_style));
        font_from_typeface(style, typeface)
    }
}

fn canonical_family_key(family: &str) -> String {
    family.trim().to_lowercase()
}

fn font_style_distance(actual: FontStyle, requested: FontStyle) -> (i32, i32, i32) {
    (
        if actual.slant() == requested.slant() {
            0
        } else {
            1
        },
        (*actual.weight() - *requested.weight()).abs(),
        (*actual.width() - *requested.width()).abs(),
    )
}

fn font_files(sources: &[PathBuf]) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for source in sources {
        if source.is_file() {
            if is_font_path(source) {
                files.push(source.clone());
            }
            continue;
        }
        let Ok(entries) = std::fs::read_dir(source) else {
            continue;
        };
        let mut source_files: Vec<PathBuf> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_file() && is_font_path(path))
            .collect();
        source_files.sort();
        files.extend(source_files);
    }
    files.sort();
    files.dedup();
    files
}

fn is_font_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "ttf" | "otf" | "ttc" | "otc"
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use skia_safe::font_style::{Weight, Width};

    #[test]
    fn style_distance_prefers_matching_slant_then_weight() {
        let normal = FontStyle::normal();
        let medium = FontStyle::new(Weight::MEDIUM, Width::NORMAL, normal.slant());
        let bold = FontStyle::bold();
        let italic = FontStyle::italic();

        assert!(font_style_distance(medium, medium) < font_style_distance(bold, medium));
        assert!(font_style_distance(bold, medium) < font_style_distance(italic, medium));
    }

    #[test]
    fn bundled_catalog_contains_portable_korean_fallback() {
        let font_mgr = FontMgr::default();
        let catalog = TypefaceCatalog::load(&font_mgr, &font_paths::bundled_font_dirs());
        assert!(catalog.contains_family("Noto Sans KR"));

        let style = TextStyle {
            font_family: "Noto Sans KR".to_string(),
            ..Default::default()
        };
        let typeface = catalog.typeface_for_text(
            &["Noto Sans KR".to_string()],
            font_style_for_text(&style),
            12.0,
            "한글",
        );
        assert!(typeface.is_some());
    }

    #[test]
    fn bundled_file_discovery_is_deterministic() {
        let first = font_files(&font_paths::bundled_font_dirs());
        let second = font_files(&font_paths::bundled_font_dirs());
        assert_eq!(first, second);
        assert!(first
            .iter()
            .any(|path| path.ends_with("NotoSansKR-Regular.ttf")));
    }

    #[test]
    fn caller_font_catalog_precedes_system_and_bundled_fallbacks() {
        let font_mgr = FontMgr::default();
        let resolver = SkiaFontResolver::new(font_mgr, &font_paths::bundled_font_dirs());
        let font = resolver.make_font(
            &TextStyle {
                font_family: "Definitely Missing RHWP Test Font".to_string(),
                ..Default::default()
            },
            "한글",
        );
        assert_eq!(font.typeface().family_name(), "Noto Sans KR");
    }
}
