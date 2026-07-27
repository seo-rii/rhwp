//! Shared native font source ordering.
//!
//! Caller-provided paths and `RHWP_FONT_PATH` are custom sources. System fonts
//! remain owned by each platform font manager, and repository fonts are a final
//! fallback for headless environments.

use std::path::{Path, PathBuf};

pub const FONT_PATH_ENV: &str = "RHWP_FONT_PATH";
pub const BUNDLED_OPENSOURCE_DIR: &str = "ttfs/opensource";

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

pub fn load_into_fontdb(fontdb: &mut usvg::fontdb::Database, extra: &[PathBuf]) {
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
    for dir in bundled_font_dirs() {
        if dir.exists() {
            fontdb.load_fonts_dir(dir);
        }
    }
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
}
