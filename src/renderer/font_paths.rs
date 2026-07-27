//! Shared native font source ordering.
//!
//! Caller-provided paths and `RHWP_FONT_PATH` are custom sources. System fonts
//! remain owned by each platform font manager, and repository fonts are a final
//! fallback for headless environments.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

pub const FONT_PATH_ENV: &str = "RHWP_FONT_PATH";
pub const BUNDLED_OPENSOURCE_DIR: &str = "ttfs/opensource";

static DEFAULT_USVG_FONTDB: OnceLock<Arc<usvg::fontdb::Database>> = OnceLock::new();

#[cfg(target_os = "windows")]
const PATH_SEPARATOR: char = ';';

#[cfg(not(target_os = "windows"))]
const PATH_SEPARATOR: char = ':';

fn split_font_path_list(raw: &str) -> Vec<PathBuf> {
    raw.split(PATH_SEPARATOR)
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(PathBuf::from)
        .collect()
}

pub fn env_font_paths() -> Vec<PathBuf> {
    std::env::var(FONT_PATH_ENV)
        .map(|raw| split_font_path_list(&raw))
        .unwrap_or_default()
}

pub fn system_font_dirs() -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        vec![
            PathBuf::from("/Library/Fonts"),
            PathBuf::from("/System/Library/Fonts"),
            PathBuf::from("/System/Library/Fonts/Supplemental"),
        ]
    }
    #[cfg(target_os = "linux")]
    {
        vec![
            PathBuf::from("/usr/share/fonts"),
            PathBuf::from("/usr/local/share/fonts"),
        ]
    }
    #[cfg(target_os = "windows")]
    {
        vec![PathBuf::from("C:\\Windows\\Fonts")]
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        Vec::new()
    }
}

pub fn custom_font_dirs(extra: &[PathBuf]) -> Vec<PathBuf> {
    let mut dirs = extra.to_vec();
    dirs.extend(env_font_paths());
    deduplicate_paths(dirs)
}

pub fn bundled_font_dirs() -> Vec<PathBuf> {
    vec![Path::new(env!("CARGO_MANIFEST_DIR")).join(BUNDLED_OPENSOURCE_DIR)]
}

pub fn search_dirs(extra: &[PathBuf]) -> Vec<PathBuf> {
    let mut dirs = custom_font_dirs(extra);
    dirs.extend(system_font_dirs());
    dirs.extend(bundled_font_dirs());
    deduplicate_paths(dirs)
}

pub fn load_custom_into_fontdb(fontdb: &mut usvg::fontdb::Database, extra: &[PathBuf]) {
    for dir in custom_font_dirs(extra) {
        if dir.exists() {
            fontdb.load_fonts_dir(&dir);
        } else {
            eprintln!(
                "WARN: font path '{}' not found; skipping native font source",
                dir.display()
            );
        }
    }
}

pub fn load_bundled_into_fontdb(fontdb: &mut usvg::fontdb::Database) {
    for dir in bundled_font_dirs() {
        if dir.exists() {
            fontdb.load_fonts_dir(dir);
        }
    }
}

pub fn load_into_fontdb(fontdb: &mut usvg::fontdb::Database, extra: &[PathBuf]) {
    load_custom_into_fontdb(fontdb, extra);
    load_bundled_into_fontdb(fontdb);
}

/// Shared font database for native SVG text conversion.
///
/// The loading order matches direct native text replay: caller/environment
/// fonts first, platform fonts second, and bundled portable fonts last.
pub fn default_usvg_fontdb() -> Arc<usvg::fontdb::Database> {
    DEFAULT_USVG_FONTDB
        .get_or_init(|| {
            let mut fontdb = usvg::fontdb::Database::new();
            load_custom_into_fontdb(&mut fontdb, &[]);
            fontdb.load_system_fonts();
            load_bundled_into_fontdb(&mut fontdb);
            configure_usvg_generic_families(&mut fontdb);
            Arc::new(fontdb)
        })
        .clone()
}

fn configure_usvg_generic_families(fontdb: &mut usvg::fontdb::Database) {
    const SANS_CANDIDATES: &[&str] = &[
        "Noto Sans CJK KR",
        "Noto Sans KR",
        "함초롬돋움",
        "HCR Dotum",
        "맑은 고딕",
        "Malgun Gothic",
        "NanumGothic",
        "나눔고딕",
        "DejaVu Sans",
    ];
    const SERIF_CANDIDATES: &[&str] = &[
        "Noto Serif CJK KR",
        "Noto Serif KR",
        "함초롬바탕",
        "HCR Batang",
        "바탕",
        "Batang",
        "NanumMyeongjo",
        "나눔명조",
        "Noto Sans KR",
        "DejaVu Serif",
    ];
    const MONOSPACE_CANDIDATES: &[&str] = &[
        "D2Coding",
        "D2Coding ligature",
        "Noto Sans KR",
        "DejaVu Sans Mono",
    ];

    if let Some(family) = first_existing_family(fontdb, SANS_CANDIDATES) {
        fontdb.set_sans_serif_family(family);
    }
    if let Some(family) = first_existing_family(fontdb, SERIF_CANDIDATES) {
        fontdb.set_serif_family(family);
    }
    if let Some(family) = first_existing_family(fontdb, MONOSPACE_CANDIDATES) {
        fontdb.set_monospace_family(family);
    }
}

fn first_existing_family(fontdb: &usvg::fontdb::Database, candidates: &[&str]) -> Option<String> {
    candidates.iter().find_map(|candidate| {
        fontdb
            .faces()
            .flat_map(|face| face.families.iter())
            .find(|(family, _)| family.eq_ignore_ascii_case(candidate))
            .map(|(family, _)| family.clone())
    })
}

fn deduplicate_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut unique = Vec::with_capacity(paths.len());
    for path in paths {
        if !unique.iter().any(|existing| existing == &path) {
            unique.push(path);
        }
    }
    unique
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_native_path_list_and_filters_empty_entries() {
        let raw = format!(
            "{separator}/tmp/fonts-a{separator}{separator}/tmp/fonts-b{separator}",
            separator = PATH_SEPARATOR
        );
        assert_eq!(
            split_font_path_list(&raw),
            vec![PathBuf::from("/tmp/fonts-a"), PathBuf::from("/tmp/fonts-b")]
        );
    }

    #[test]
    fn search_order_keeps_caller_first_and_bundled_last() {
        let caller = PathBuf::from("/tmp/rhwp-caller-fonts");
        let dirs = search_dirs(std::slice::from_ref(&caller));
        assert_eq!(dirs.first(), Some(&caller));
        assert_eq!(
            dirs.last(),
            Some(&Path::new(env!("CARGO_MANIFEST_DIR")).join(BUNDLED_OPENSOURCE_DIR))
        );
    }

    #[test]
    fn bundled_source_is_a_tracked_repository_asset() {
        let dirs = bundled_font_dirs();
        assert_eq!(dirs.len(), 1);
        assert!(dirs[0].join("NotoSansKR-Regular.ttf").is_file());
    }

    #[test]
    fn default_search_excludes_environment_specific_legacy_paths() {
        let paths: Vec<String> = search_dirs(&[])
            .into_iter()
            .map(|path| path.display().to_string())
            .collect();
        for banned in ["/mnt/c/Windows/Fonts", "ttfs/hwp", "ttfs/windows"] {
            assert!(
                !paths.iter().any(|path| path.ends_with(banned)),
                "environment-specific font path leaked into defaults: {banned}"
            );
        }
    }

    #[test]
    fn bundled_korean_face_backs_all_svg_generic_families() {
        let mut fontdb = usvg::fontdb::Database::new();
        load_bundled_into_fontdb(&mut fontdb);
        configure_usvg_generic_families(&mut fontdb);

        for family in [
            usvg::fontdb::Family::SansSerif,
            usvg::fontdb::Family::Serif,
            usvg::fontdb::Family::Monospace,
        ] {
            assert_eq!(fontdb.family_name(&family), "Noto Sans KR");
        }
    }

    #[test]
    fn missing_svg_generic_candidate_is_not_selected() {
        let mut fontdb = usvg::fontdb::Database::new();
        load_bundled_into_fontdb(&mut fontdb);

        assert_eq!(
            first_existing_family(&fontdb, &["Definitely Missing RHWP Font", "Noto Sans KR"])
                .as_deref(),
            Some("Noto Sans KR")
        );
    }
}
