//! 레이아웃 통합 테스트
//!
//! 실제 HWP 파일을 로딩하여 페이지네이션 + 레이아웃 결과를 검증한다.
//! samples/ 디렉토리에 테스트 파일이 없으면 건너뜀.

#[cfg(test)]
mod tests {
    use base64::Engine;
    use resvg::{tiny_skia, usvg};
    use std::path::{Path, PathBuf};
    use std::sync::{Mutex, MutexGuard, OnceLock};

    use crate::paint::RenderProfile;

    const SKIA_TOLERANT_CHANNEL_DELTA: u8 = 8;
    const SKIA_TOLERANT_MAX_DIFF_PIXELS: usize = 64;
    const SKIA_RASTER_TOLERANT_NEIGHBOR_RADIUS: usize = 1;
    const SKIA_RASTER_TOLERANT_MAX_DIFF_RATIO: f64 = 0.013;
    const SKIA_INK_MASK_WHITE_DELTA: u8 = 25;
    const SKIA_INK_MASK_ALPHA_THRESHOLD: u8 = 8;
    const SKIA_INK_MASK_NEIGHBOR_RADIUS: usize = 1;
    const SKIA_INK_MASK_MAX_DIFF_RATIO: f64 = 0.003;

    fn render_path_env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn lock_render_path_env() -> MutexGuard<'static, ()> {
        render_path_env_lock()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 테스트용 DocumentCore 생성 헬퍼
    fn load_document(path: &str) -> Option<crate::document_core::DocumentCore> {
        let p = Path::new(path);
        if !p.exists() {
            eprintln!("테스트 파일 없음: {} — 건너뜀", path);
            return None;
        }
        let data = std::fs::read(p).ok()?;
        crate::document_core::DocumentCore::from_bytes(&data).ok()
    }

    #[test]
    fn test_real_hwp_externalizes_positioned_text_visuals() {
        use crate::paint::{LayerNodeKind, PaintOp};

        let Some(core) = load_document("samples/aift.hwp") else {
            return;
        };
        let cases = [
            (0, "textDecoration", 6usize),
            (1, "charOverlap", 1usize),
            (3, "tabLeader", 24usize),
        ];

        for (page_num, op_type, expected_count) in cases {
            let tree = core
                .build_page_layer_tree_for_output(page_num, RenderProfile::Screen)
                .unwrap_or_else(|err| panic!("aift.hwp page {page_num} layer build failed: {err}"));
            let mut count = 0usize;
            let mut stack = vec![&tree.root];

            while let Some(node) = stack.pop() {
                match &node.kind {
                    LayerNodeKind::Group { children, .. } => {
                        stack.extend(children.iter());
                    }
                    LayerNodeKind::ClipRect { child, .. } => stack.push(child),
                    LayerNodeKind::Leaf { ops, .. } => {
                        count += ops
                            .iter()
                            .filter(|op| match op_type {
                                "charOverlap" => matches!(op, PaintOp::CharOverlap { .. }),
                                "tabLeader" => matches!(op, PaintOp::TabLeader { .. }),
                                "textDecoration" => {
                                    matches!(op, PaintOp::TextDecoration { .. })
                                }
                                _ => unreachable!("unsupported positioned text op"),
                            })
                            .count();
                    }
                }
            }

            assert_eq!(
                count, expected_count,
                "aift.hwp page {page_num} must preserve explicit {op_type} PaintOps",
            );
        }
    }

    fn rasterize_svg(svg: &str) -> Option<tiny_skia::Pixmap> {
        let svg = normalize_svg_embedded_bitmaps(svg);
        let mut options = usvg::Options::default();
        let fontdb = options.fontdb_mut();
        fontdb.load_system_fonts();
        fontdb.set_sans_serif_family("Noto Sans CJK KR");
        fontdb.set_serif_family("Noto Serif CJK KR");
        fontdb.set_monospace_family("D2Coding");
        let tree = usvg::Tree::from_str(&svg, &options).ok()?;
        let pixmap_size = tree.size().to_int_size();
        let mut pixmap = tiny_skia::Pixmap::new(pixmap_size.width(), pixmap_size.height())?;
        resvg::render(&tree, tiny_skia::Transform::default(), &mut pixmap.as_mut());
        Some(pixmap)
    }

    fn normalize_svg_embedded_bitmaps(svg: &str) -> String {
        const PREFIX: &str = "href=\"data:image/bmp;base64,";

        let mut normalized = String::with_capacity(svg.len());
        let mut rest = svg;

        while let Some(start) = rest.find(PREFIX) {
            let (before, after_prefix) = rest.split_at(start);
            normalized.push_str(before);

            let after_prefix = &after_prefix[PREFIX.len()..];
            let Some(end) = after_prefix.find('"') else {
                normalized.push_str(rest);
                return normalized;
            };

            let encoded = &after_prefix[..end];
            let replacement = decode_bmp_data_uri_to_png(encoded)
                .unwrap_or_else(|| format!("data:image/bmp;base64,{encoded}"));
            normalized.push_str("href=\"");
            normalized.push_str(&replacement);
            normalized.push('"');
            rest = &after_prefix[end + 1..];
        }

        normalized.push_str(rest);
        normalized
    }

    fn decode_bmp_data_uri_to_png(encoded: &str) -> Option<String> {
        let bmp_bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .ok()?;
        let image =
            image::load_from_memory_with_format(&bmp_bytes, image::ImageFormat::Bmp).ok()?;
        let mut png_bytes = Vec::new();
        let mut cursor = std::io::Cursor::new(&mut png_bytes);
        image.write_to(&mut cursor, image::ImageFormat::Png).ok()?;
        let png_base64 = base64::engine::general_purpose::STANDARD.encode(png_bytes);
        Some(format!("data:image/png;base64,{png_base64}"))
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
    fn decode_png(bytes: &[u8]) -> Option<tiny_skia::Pixmap> {
        tiny_skia::Pixmap::decode_png(bytes).ok()
    }

    struct PixmapDiff {
        diff_pixels: usize,
        total_pixels: usize,
        max_channel_delta: u8,
        mean_abs_channel_delta: f64,
        diff_pixmap: tiny_skia::Pixmap,
    }

    fn pixel_max_delta(expected_px: &[u8], actual_px: &[u8]) -> u8 {
        let mut pixel_max_delta = 0u8;
        for channel in 0..4 {
            pixel_max_delta =
                pixel_max_delta.max(expected_px[channel].abs_diff(actual_px[channel]));
        }
        pixel_max_delta
    }

    fn pixel_matches_within_delta(
        expected_px: &[u8],
        actual_px: &[u8],
        ignored_channel_delta: u8,
    ) -> bool {
        pixel_max_delta(expected_px, actual_px) <= ignored_channel_delta
    }

    fn pixel_is_ink(pixel: &[u8], white_delta: u8, alpha_threshold: u8) -> bool {
        pixel[3] > alpha_threshold
            && [
                255u8.saturating_sub(pixel[0]),
                255u8.saturating_sub(pixel[1]),
                255u8.saturating_sub(pixel[2]),
            ]
            .into_iter()
            .max()
            .unwrap_or(0)
                > white_delta
    }

    fn diff_pixmaps(
        expected: &tiny_skia::Pixmap,
        actual: &tiny_skia::Pixmap,
        ignored_channel_delta: u8,
    ) -> PixmapDiff {
        let total_pixels = (expected.width() as usize) * (expected.height() as usize);
        let mut diff_pixmap = tiny_skia::Pixmap::new(expected.width(), expected.height())
            .expect("diff pixmap 생성 실패");
        let mut diff_pixels = 0usize;
        let mut total_channel_delta = 0u64;
        let mut max_channel_delta = 0u8;

        for (idx, (expected_px, actual_px)) in expected
            .data()
            .chunks_exact(4)
            .zip(actual.data().chunks_exact(4))
            .enumerate()
        {
            for channel in 0..4 {
                let delta = expected_px[channel].abs_diff(actual_px[channel]);
                total_channel_delta += u64::from(delta);
                max_channel_delta = max_channel_delta.max(delta);
            }

            let pixel_max_delta = pixel_max_delta(expected_px, actual_px);
            if pixel_max_delta > ignored_channel_delta {
                diff_pixels += 1;
                let base = idx * 4;
                diff_pixmap.data_mut()[base..base + 4].copy_from_slice(&[
                    pixel_max_delta.max(32),
                    0,
                    0,
                    255,
                ]);
            }
        }

        let mean_abs_channel_delta = if total_pixels == 0 {
            0.0
        } else {
            total_channel_delta as f64 / (total_pixels as f64 * 4.0)
        };

        PixmapDiff {
            diff_pixels,
            total_pixels,
            max_channel_delta,
            mean_abs_channel_delta,
            diff_pixmap,
        }
    }

    fn diff_pixmaps_with_neighborhood(
        expected: &tiny_skia::Pixmap,
        actual: &tiny_skia::Pixmap,
        ignored_channel_delta: u8,
        radius: usize,
    ) -> PixmapDiff {
        let total_pixels = (expected.width() as usize) * (expected.height() as usize);
        let mut diff_pixmap = tiny_skia::Pixmap::new(expected.width(), expected.height())
            .expect("diff pixmap 생성 실패");
        let mut diff_pixels = 0usize;
        let mut total_channel_delta = 0u64;
        let mut max_channel_delta = 0u8;
        let width = expected.width() as usize;
        let height = expected.height() as usize;
        let expected_data = expected.data();
        let actual_data = actual.data();

        for y in 0..height {
            for x in 0..width {
                let idx = y * width + x;
                let base = idx * 4;
                let expected_px = &expected_data[base..base + 4];
                let actual_px = &actual_data[base..base + 4];

                for channel in 0..4 {
                    let delta = expected_px[channel].abs_diff(actual_px[channel]);
                    total_channel_delta += u64::from(delta);
                    max_channel_delta = max_channel_delta.max(delta);
                }

                let pixel_max_delta = pixel_max_delta(expected_px, actual_px);
                if pixel_max_delta <= ignored_channel_delta {
                    continue;
                }

                let mut matched = false;
                let min_y = y.saturating_sub(radius);
                let max_y = (y + radius).min(height - 1);
                let min_x = x.saturating_sub(radius);
                let max_x = (x + radius).min(width - 1);

                'search_actual: for ny in min_y..=max_y {
                    for nx in min_x..=max_x {
                        let neighbor_base = (ny * width + nx) * 4;
                        let candidate = &actual_data[neighbor_base..neighbor_base + 4];
                        if pixel_matches_within_delta(expected_px, candidate, ignored_channel_delta)
                        {
                            matched = true;
                            break 'search_actual;
                        }
                    }
                }

                if !matched {
                    'search_expected: for ny in min_y..=max_y {
                        for nx in min_x..=max_x {
                            let neighbor_base = (ny * width + nx) * 4;
                            let candidate = &expected_data[neighbor_base..neighbor_base + 4];
                            if pixel_matches_within_delta(
                                candidate,
                                actual_px,
                                ignored_channel_delta,
                            ) {
                                matched = true;
                                break 'search_expected;
                            }
                        }
                    }
                }

                if matched {
                    continue;
                }

                diff_pixels += 1;
                diff_pixmap.data_mut()[base..base + 4].copy_from_slice(&[
                    pixel_max_delta.max(32),
                    0,
                    0,
                    255,
                ]);
            }
        }

        let mean_abs_channel_delta = if total_pixels == 0 {
            0.0
        } else {
            total_channel_delta as f64 / (total_pixels as f64 * 4.0)
        };

        PixmapDiff {
            diff_pixels,
            total_pixels,
            max_channel_delta,
            mean_abs_channel_delta,
            diff_pixmap,
        }
    }

    fn diff_ink_masks_with_neighborhood(
        expected: &tiny_skia::Pixmap,
        actual: &tiny_skia::Pixmap,
        white_delta: u8,
        alpha_threshold: u8,
        radius: usize,
    ) -> PixmapDiff {
        let total_pixels = (expected.width() as usize) * (expected.height() as usize);
        let mut diff_pixmap = tiny_skia::Pixmap::new(expected.width(), expected.height())
            .expect("ink mask diff pixmap 생성 실패");
        let mut diff_pixels = 0usize;
        let width = expected.width() as usize;
        let height = expected.height() as usize;
        let expected_data = expected.data();
        let actual_data = actual.data();

        for y in 0..height {
            for x in 0..width {
                let idx = y * width + x;
                let base = idx * 4;
                let expected_px = &expected_data[base..base + 4];
                let actual_px = &actual_data[base..base + 4];
                let expected_ink = pixel_is_ink(expected_px, white_delta, alpha_threshold);
                let actual_ink = pixel_is_ink(actual_px, white_delta, alpha_threshold);

                if expected_ink == actual_ink {
                    continue;
                }

                let min_y = y.saturating_sub(radius);
                let max_y = (y + radius).min(height - 1);
                let min_x = x.saturating_sub(radius);
                let max_x = (x + radius).min(width - 1);
                let mut matched = false;

                if expected_ink && !actual_ink {
                    'search_actual: for ny in min_y..=max_y {
                        for nx in min_x..=max_x {
                            let neighbor_base = (ny * width + nx) * 4;
                            let candidate = &actual_data[neighbor_base..neighbor_base + 4];
                            if pixel_is_ink(candidate, white_delta, alpha_threshold) {
                                matched = true;
                                break 'search_actual;
                            }
                        }
                    }
                } else if actual_ink && !expected_ink {
                    'search_expected: for ny in min_y..=max_y {
                        for nx in min_x..=max_x {
                            let neighbor_base = (ny * width + nx) * 4;
                            let candidate = &expected_data[neighbor_base..neighbor_base + 4];
                            if pixel_is_ink(candidate, white_delta, alpha_threshold) {
                                matched = true;
                                break 'search_expected;
                            }
                        }
                    }
                }

                if matched {
                    continue;
                }

                diff_pixels += 1;
                diff_pixmap.data_mut()[base..base + 4].copy_from_slice(&[
                    if expected_ink { 255 } else { 0 },
                    0,
                    if actual_ink { 255 } else { 0 },
                    255,
                ]);
            }
        }

        PixmapDiff {
            diff_pixels,
            total_pixels,
            max_channel_delta: 0,
            mean_abs_channel_delta: 0.0,
            diff_pixmap,
        }
    }

    fn save_diff_artifacts(
        output_dir: &str,
        sample: &str,
        page_num: u32,
        expected_name: &str,
        actual_name: &str,
        diff_name: &str,
        expected: &tiny_skia::Pixmap,
        actual: &tiny_skia::Pixmap,
        diff: &tiny_skia::Pixmap,
    ) -> (PathBuf, PathBuf, PathBuf) {
        let output_dir = Path::new(output_dir);
        let _ = std::fs::create_dir_all(output_dir);
        let stem = Path::new(sample)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("sample");
        let expected_path = output_dir.join(format!("{stem}-{expected_name}-p{page_num}.png"));
        let actual_path = output_dir.join(format!("{stem}-{actual_name}-p{page_num}.png"));
        let diff_path = output_dir.join(format!("{stem}-{diff_name}-p{page_num}.png"));
        let _ = expected.save_png(&expected_path);
        let _ = actual.save_png(&actual_path);
        let _ = diff.save_png(&diff_path);
        (expected_path, actual_path, diff_path)
    }

    fn assert_layer_svg_pixels_match(sample: &str, page_num: u32) {
        assert_layer_svg_pixels_match_with_tolerance(sample, page_num, 0);
    }

    fn assert_layer_svg_pixels_match_with_tolerance(
        sample: &str,
        page_num: u32,
        max_diff_pixels: usize,
    ) {
        let Some(core) = load_document(sample) else {
            return;
        };
        let legacy = core
            .render_page_svg_legacy_native(page_num)
            .unwrap_or_default();
        let layered = core
            .render_page_svg_layer_native(page_num)
            .unwrap_or_default();
        let legacy_pixmap = rasterize_svg(&legacy).expect("legacy SVG rasterize 실패");
        let layered_pixmap = rasterize_svg(&layered).expect("layer SVG rasterize 실패");

        assert_eq!(
            (layered_pixmap.width(), layered_pixmap.height()),
            (legacy_pixmap.width(), legacy_pixmap.height()),
            "legacy/layer raster 크기가 달라서는 안 됨",
        );

        let diff = diff_pixmaps(&legacy_pixmap, &layered_pixmap, 0);
        if diff.diff_pixels > max_diff_pixels {
            let (legacy_path, layered_path, diff_path) = save_diff_artifacts(
                "output/layer-svg-diff",
                sample,
                page_num,
                "legacy",
                "layer",
                "diff",
                &legacy_pixmap,
                &layered_pixmap,
                &diff.diff_pixmap,
            );
            panic!(
                "legacy/layer raster diff 발생: {} pixels, allowed {} (legacy: {}, layer: {}, diff: {})",
                diff.diff_pixels,
                max_diff_pixels,
                legacy_path.display(),
                layered_path.display(),
                diff_path.display(),
            );
        }
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
    fn compare_skia_png_matches_layer_svg(sample: &str, page_num: u32) -> Result<(), String> {
        let total_start = std::time::Instant::now();
        let path = Path::new(sample);
        if !path.exists() {
            return Ok(());
        }

        let read_start = std::time::Instant::now();
        let data = std::fs::read(path).map_err(|err| format!("샘플 읽기 실패: {sample}: {err}"))?;
        let read_ms = read_start.elapsed().as_secs_f64() * 1000.0;
        let parse_start = std::time::Instant::now();
        let core = crate::document_core::DocumentCore::from_bytes(&data)
            .map_err(|err| format!("문서 파싱 실패: {sample}: {err}"))?;
        let parse_ms = parse_start.elapsed().as_secs_f64() * 1000.0;
        if page_num >= core.page_count() {
            return Err(format!(
                "페이지 범위 초과: {sample} requested={} page_count={}",
                page_num,
                core.page_count()
            ));
        }

        let layer_svg_start = std::time::Instant::now();
        let layered_svg = core
            .render_page_svg_layer_native(page_num)
            .map_err(|err| format!("layer SVG 렌더 실패: {sample} p{page_num}: {err}"))?;
        let layer_svg_ms = layer_svg_start.elapsed().as_secs_f64() * 1000.0;
        let rasterize_start = std::time::Instant::now();
        let expected = rasterize_svg(&layered_svg)
            .ok_or_else(|| format!("layer SVG rasterize 실패: {sample} p{page_num}"))?;
        let rasterize_ms = rasterize_start.elapsed().as_secs_f64() * 1000.0;
        let skia_start = std::time::Instant::now();
        let actual_png = core
            .render_page_png_native(page_num)
            .map_err(|err| format!("Skia PNG 렌더 실패: {sample} p{page_num}: {err}"))?;
        let skia_ms = skia_start.elapsed().as_secs_f64() * 1000.0;
        let decode_start = std::time::Instant::now();
        let actual = decode_png(&actual_png)
            .ok_or_else(|| format!("Skia PNG decode 실패: {sample} p{page_num}"))?;
        let decode_ms = decode_start.elapsed().as_secs_f64() * 1000.0;

        if (actual.width(), actual.height()) != (expected.width(), expected.height()) {
            return Err(format!(
                "Skia/layer raster 크기 불일치: {sample} p{page_num} expected=({},{}) actual=({},{})",
                expected.width(),
                expected.height(),
                actual.width(),
                actual.height(),
            ));
        }

        let diff_start = std::time::Instant::now();
        let exact_diff = diff_pixmaps(&expected, &actual, 0);
        let raw_tolerant_diff = diff_pixmaps(&expected, &actual, SKIA_TOLERANT_CHANNEL_DELTA);
        let raster_tolerant_diff = diff_pixmaps_with_neighborhood(
            &expected,
            &actual,
            SKIA_TOLERANT_CHANNEL_DELTA,
            SKIA_RASTER_TOLERANT_NEIGHBOR_RADIUS,
        );
        let ink_mask_diff = diff_ink_masks_with_neighborhood(
            &expected,
            &actual,
            SKIA_INK_MASK_WHITE_DELTA,
            SKIA_INK_MASK_ALPHA_THRESHOLD,
            SKIA_INK_MASK_NEIGHBOR_RADIUS,
        );
        let raster_tolerant_ratio =
            raster_tolerant_diff.diff_pixels as f64 / raster_tolerant_diff.total_pixels as f64;
        let ink_mask_ratio = ink_mask_diff.diff_pixels as f64 / ink_mask_diff.total_pixels as f64;
        let diff_ms = diff_start.elapsed().as_secs_f64() * 1000.0;

        if std::env::var_os("RHWP_SKIA_LOG_PERF").is_some() {
            eprintln!(
                "[skia-perf] {sample} p{page_num} read={read_ms:.2}ms parse={parse_ms:.2}ms layer_svg={layer_svg_ms:.2}ms rasterize_svg={rasterize_ms:.2}ms skia_png={skia_ms:.2}ms decode_png={decode_ms:.2}ms diff={diff_ms:.2}ms total={total:.2}ms surface={}x{} png_bytes={}",
                expected.width(),
                expected.height(),
                actual_png.len(),
                total = total_start.elapsed().as_secs_f64() * 1000.0,
            );
        }

        let exact_paths = if exact_diff.diff_pixels > 0 {
            Some(save_diff_artifacts(
                "output/skia-diff",
                sample,
                page_num,
                "layer",
                "skia",
                "diff",
                &expected,
                &actual,
                &exact_diff.diff_pixmap,
            ))
        } else {
            None
        };

        let tolerant_paths = if raw_tolerant_diff.diff_pixels > SKIA_TOLERANT_MAX_DIFF_PIXELS {
            Some(save_diff_artifacts(
                "output/skia-diff",
                sample,
                page_num,
                "layer",
                "skia",
                "tolerant-diff",
                &expected,
                &actual,
                &raw_tolerant_diff.diff_pixmap,
            ))
        } else {
            None
        };

        if ink_mask_ratio > SKIA_INK_MASK_MAX_DIFF_RATIO {
            let (expected_path, actual_path, diff_path) =
                exact_paths.expect("tolerant diff가 있으면 exact diff도 있어야 함");
            let tolerant_diff_path = tolerant_paths
                .as_ref()
                .map(|(_, _, path)| path.display().to_string())
                .unwrap_or_else(|| "-".to_string());
            let (_, _, raster_tolerant_diff_path) = save_diff_artifacts(
                "output/skia-diff",
                sample,
                page_num,
                "layer",
                "skia",
                "raster-tolerant-diff",
                &expected,
                &actual,
                &raster_tolerant_diff.diff_pixmap,
            );
            let (_, _, ink_mask_diff_path) = save_diff_artifacts(
                "output/skia-diff",
                sample,
                page_num,
                "layer",
                "skia",
                "ink-mask-diff",
                &expected,
                &actual,
                &ink_mask_diff.diff_pixmap,
            );
            return Err(format!(
                "Skia raster diff 발생: exact={} pixels, tolerant={} pixels (budget={}, ignored_channel_delta<={}), raster_tolerant={} pixels (radius={}, ratio={:.3}%, budget={:.3}%), ink_mask={} pixels (white_delta={}, alpha_threshold={}, radius={}, ratio={:.3}%, budget={:.3}%) (layer: {}, skia: {}, exact diff: {}, tolerant diff: {}, raster tolerant diff: {}, ink mask diff: {})",
                exact_diff.diff_pixels,
                raw_tolerant_diff.diff_pixels,
                SKIA_TOLERANT_MAX_DIFF_PIXELS,
                SKIA_TOLERANT_CHANNEL_DELTA,
                raster_tolerant_diff.diff_pixels,
                SKIA_RASTER_TOLERANT_NEIGHBOR_RADIUS,
                raster_tolerant_ratio * 100.0,
                SKIA_RASTER_TOLERANT_MAX_DIFF_RATIO * 100.0,
                ink_mask_diff.diff_pixels,
                SKIA_INK_MASK_WHITE_DELTA,
                SKIA_INK_MASK_ALPHA_THRESHOLD,
                SKIA_INK_MASK_NEIGHBOR_RADIUS,
                ink_mask_ratio * 100.0,
                SKIA_INK_MASK_MAX_DIFF_RATIO * 100.0,
                expected_path.display(),
                actual_path.display(),
                diff_path.display(),
                tolerant_diff_path,
                raster_tolerant_diff_path.display(),
                ink_mask_diff_path.display(),
            ));
        }

        Ok(())
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
    fn assert_skia_png_matches_layer_svg_for_corpus(label: &str, samples: &[(String, Vec<u32>)]) {
        let mut failures = Vec::new();
        let total_pages: usize = samples.iter().map(|(_, pages)| pages.len()).sum();
        let mut completed_pages = 0usize;

        for (sample, pages) in samples {
            for &page_num in pages {
                completed_pages += 1;
                eprintln!(
                    "[skia-corpus:{label}] {completed_pages}/{total_pages} {sample} p{page_num}"
                );
                if let Err(err) = compare_skia_png_matches_layer_svg(sample, page_num) {
                    failures.push(err);
                }
            }
        }

        if !failures.is_empty() {
            panic!(
                "Skia corpus screenshot regression 실패 {}건:\n{}",
                failures.len(),
                failures.join("\n"),
            );
        }
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
    fn assert_skia_png_matches_layer_svg(sample: &str, page_num: u32) {
        if let Err(err) = compare_skia_png_matches_layer_svg(sample, page_num) {
            panic!("{err}");
        }
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
    fn assert_skia_layer_tree_matches_svg(
        case_name: &str,
        layer_tree: &crate::paint::PageLayerTree,
    ) {
        use crate::renderer::layer_renderer::{LayerRasterRenderer, LayerRenderer};
        use crate::renderer::skia::SkiaLayerRenderer;
        use crate::renderer::svg_layer::SvgLayerRenderer;

        let mut svg_renderer = SvgLayerRenderer::new();
        svg_renderer
            .render_page(layer_tree)
            .expect("synthetic SVG layer render");
        let expected = rasterize_svg(svg_renderer.output()).expect("synthetic SVG rasterize 실패");
        let renderer = SkiaLayerRenderer::new();
        let actual_png = LayerRasterRenderer::render_png(&renderer, layer_tree)
            .expect("synthetic Skia PNG 렌더 실패");
        let actual = decode_png(&actual_png).expect("synthetic Skia PNG decode 실패");
        let tolerant_diff = diff_pixmaps(&expected, &actual, SKIA_TOLERANT_CHANNEL_DELTA);
        let raster_tolerant_diff = diff_pixmaps_with_neighborhood(
            &expected,
            &actual,
            SKIA_TOLERANT_CHANNEL_DELTA,
            SKIA_RASTER_TOLERANT_NEIGHBOR_RADIUS,
        );
        let ink_mask_diff = diff_ink_masks_with_neighborhood(
            &expected,
            &actual,
            SKIA_INK_MASK_WHITE_DELTA,
            SKIA_INK_MASK_ALPHA_THRESHOLD,
            SKIA_INK_MASK_NEIGHBOR_RADIUS,
        );
        let raster_tolerant_ratio =
            raster_tolerant_diff.diff_pixels as f64 / raster_tolerant_diff.total_pixels as f64;
        let ink_mask_ratio = ink_mask_diff.diff_pixels as f64 / ink_mask_diff.total_pixels as f64;

        if ink_mask_ratio > SKIA_INK_MASK_MAX_DIFF_RATIO {
            let exact_diff = diff_pixmaps(&expected, &actual, 0);
            let (expected_path, actual_path, diff_path) = save_diff_artifacts(
                "output/skia-diff",
                case_name,
                0,
                "layer",
                "skia",
                "diff",
                &expected,
                &actual,
                &exact_diff.diff_pixmap,
            );
            let (_, _, tolerant_path) = save_diff_artifacts(
                "output/skia-diff",
                case_name,
                0,
                "layer",
                "skia",
                "tolerant-diff",
                &expected,
                &actual,
                &tolerant_diff.diff_pixmap,
            );
            let (_, _, raster_tolerant_path) = save_diff_artifacts(
                "output/skia-diff",
                case_name,
                0,
                "layer",
                "skia",
                "raster-tolerant-diff",
                &expected,
                &actual,
                &raster_tolerant_diff.diff_pixmap,
            );
            let (_, _, ink_mask_path) = save_diff_artifacts(
                "output/skia-diff",
                case_name,
                0,
                "layer",
                "skia",
                "ink-mask-diff",
                &expected,
                &actual,
                &ink_mask_diff.diff_pixmap,
            );
            panic!(
                "synthetic Skia raster diff 발생: exact={} tolerant={} (budget={}), raster_tolerant={} (radius={}, ratio={:.3}%, budget={:.3}%), ink_mask={} (white_delta={}, alpha_threshold={}, radius={}, ratio={:.3}%, budget={:.3}%) (layer: {}, skia: {}, exact diff: {}, tolerant diff: {}, raster tolerant diff: {}, ink mask diff: {})",
                exact_diff.diff_pixels,
                tolerant_diff.diff_pixels,
                SKIA_TOLERANT_MAX_DIFF_PIXELS,
                raster_tolerant_diff.diff_pixels,
                SKIA_RASTER_TOLERANT_NEIGHBOR_RADIUS,
                raster_tolerant_ratio * 100.0,
                SKIA_RASTER_TOLERANT_MAX_DIFF_RATIO * 100.0,
                ink_mask_diff.diff_pixels,
                SKIA_INK_MASK_WHITE_DELTA,
                SKIA_INK_MASK_ALPHA_THRESHOLD,
                SKIA_INK_MASK_NEIGHBOR_RADIUS,
                ink_mask_ratio * 100.0,
                SKIA_INK_MASK_MAX_DIFF_RATIO * 100.0,
                expected_path.display(),
                actual_path.display(),
                diff_path.display(),
                tolerant_path.display(),
                raster_tolerant_path.display(),
                ink_mask_path.display(),
            );
        }
    }

    fn synthetic_png_bytes() -> Vec<u8> {
        let mut pixmap = tiny_skia::Pixmap::new(40, 30).expect("synthetic pixmap 생성 실패");
        for y in 0..30usize {
            for x in 0..40usize {
                let (r, g, b) = match (x < 20, y < 15) {
                    (true, true) => (255, 32, 32),
                    (false, true) => (32, 200, 64),
                    (true, false) => (48, 96, 255),
                    (false, false) => (255, 200, 32),
                };
                let base = (y * 40 + x) * 4;
                pixmap.data_mut()[base..base + 4].copy_from_slice(&[r, g, b, 255]);
            }
        }
        pixmap.encode_png().expect("synthetic png 인코딩 실패")
    }

    #[test]
    fn test_diff_pixmaps_ignores_small_channel_deltas_when_configured() {
        let mut expected = tiny_skia::Pixmap::new(2, 1).expect("expected pixmap 생성 실패");
        let mut actual = tiny_skia::Pixmap::new(2, 1).expect("actual pixmap 생성 실패");

        expected
            .data_mut()
            .copy_from_slice(&[10, 20, 30, 255, 80, 90, 100, 255]);
        actual
            .data_mut()
            .copy_from_slice(&[12, 20, 30, 255, 80, 90, 106, 255]);

        let exact = diff_pixmaps(&expected, &actual, 0);
        let tolerant = diff_pixmaps(&expected, &actual, 4);

        assert_eq!(exact.total_pixels, 2);
        assert_eq!(exact.diff_pixels, 2);
        assert_eq!(tolerant.diff_pixels, 1);
        assert_eq!(exact.max_channel_delta, 6);
        assert_eq!(tolerant.max_channel_delta, 6);
    }

    #[test]
    fn test_skia_tolerant_budget_zeroes_passing_diff() {
        let mut expected = tiny_skia::Pixmap::new(4, 1).expect("expected pixmap 생성 실패");
        let mut actual = tiny_skia::Pixmap::new(4, 1).expect("actual pixmap 생성 실패");

        expected.data_mut().copy_from_slice(&[
            10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 1, 2, 3, 255,
        ]);
        actual.data_mut().copy_from_slice(&[
            10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 91, 255, 1, 2, 4, 255,
        ]);

        let raw_tolerant = diff_pixmaps(&expected, &actual, 0);
        let budgeted_tolerant = if raw_tolerant.diff_pixels <= 2 {
            0
        } else {
            raw_tolerant.diff_pixels
        };

        assert_eq!(raw_tolerant.diff_pixels, 2);
        assert_eq!(budgeted_tolerant, 0);
    }

    #[test]
    fn test_diff_pixmaps_with_neighborhood_ignores_one_pixel_shift() {
        let mut expected = tiny_skia::Pixmap::new(5, 1).expect("expected pixmap 생성 실패");
        let mut actual = tiny_skia::Pixmap::new(5, 1).expect("actual pixmap 생성 실패");

        expected
            .data_mut()
            .copy_from_slice(&[0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        actual
            .data_mut()
            .copy_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0]);

        let diff = diff_pixmaps_with_neighborhood(&expected, &actual, 8, 1);
        assert_eq!(diff.diff_pixels, 0);
    }

    #[test]
    fn test_diff_pixmaps_with_neighborhood_preserves_large_shift() {
        let mut expected = tiny_skia::Pixmap::new(10, 1).expect("expected pixmap 생성 실패");
        let mut actual = tiny_skia::Pixmap::new(10, 1).expect("actual pixmap 생성 실패");

        expected.data_mut().copy_from_slice(&[
            0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ]);
        actual.data_mut().copy_from_slice(&[
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0,
            255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ]);

        let diff = diff_pixmaps_with_neighborhood(&expected, &actual, 8, 1);
        assert!(diff.diff_pixels > 0);
    }

    #[test]
    fn test_diff_ink_masks_ignores_antialias_coverage_difference() {
        let mut expected = tiny_skia::Pixmap::new(3, 1).expect("expected pixmap 생성 실패");
        let mut actual = tiny_skia::Pixmap::new(3, 1).expect("actual pixmap 생성 실패");

        expected
            .data_mut()
            .copy_from_slice(&[255, 255, 255, 255, 235, 235, 235, 255, 0, 0, 0, 255]);
        actual
            .data_mut()
            .copy_from_slice(&[255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255]);

        let diff = diff_ink_masks_with_neighborhood(&expected, &actual, 25, 8, 1);
        assert_eq!(diff.diff_pixels, 0);
    }

    #[test]
    fn test_diff_ink_masks_ignores_one_pixel_shift() {
        let mut expected = tiny_skia::Pixmap::new(5, 1).expect("expected pixmap 생성 실패");
        let mut actual = tiny_skia::Pixmap::new(5, 1).expect("actual pixmap 생성 실패");

        expected.data_mut().copy_from_slice(&[
            255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
            255, 255,
        ]);
        actual.data_mut().copy_from_slice(&[
            255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255,
            255, 255,
        ]);

        let diff = diff_ink_masks_with_neighborhood(&expected, &actual, 25, 8, 1);
        assert_eq!(diff.diff_pixels, 0);
    }

    #[test]
    fn test_diff_ink_masks_preserves_missing_shape() {
        let mut expected = tiny_skia::Pixmap::new(3, 1).expect("expected pixmap 생성 실패");
        let actual = tiny_skia::Pixmap::new(3, 1).expect("actual pixmap 생성 실패");

        expected
            .data_mut()
            .copy_from_slice(&[255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255]);

        let diff = diff_ink_masks_with_neighborhood(&expected, &actual, 25, 8, 1);
        assert!(diff.diff_pixels > 0);
    }

    // ─── 페이지 수 검증 ───

    #[test]
    fn test_hwpspec_w_page_count() {
        let Some(core) = load_document("samples/hwpspec-w.hwp") else {
            return;
        };
        let page_count = core.page_count();
        assert!(
            page_count >= 170,
            "hwpspec-w.hwp 페이지 수 170 이상 (실제: {})",
            page_count
        );
    }

    #[test]
    fn test_exam_math_page_count() {
        let Some(core) = load_document("samples/exam_math.hwp") else {
            return;
        };
        let page_count = core.page_count();
        assert!(
            page_count >= 18,
            "exam_math.hwp 페이지 수 18 이상 (실제: {})",
            page_count
        );
    }

    // ─── 2단 레이아웃 검증 ───

    #[test]
    fn test_exam_math_two_column_layout() {
        let Some(core) = load_document("samples/exam_math.hwp") else {
            return;
        };
        // 1페이지: 2단 레이아웃이어야 함
        let pages = &core.pagination;
        if let Some(result) = pages.first() {
            if let Some(page) = result.pages.first() {
                assert!(
                    page.column_contents.len() >= 2,
                    "exam_math.hwp 1페이지는 2단 이상 (실제: {}단)",
                    page.column_contents.len()
                );
            }
        }
    }

    // ─── 머리말 검증 ───

    #[test]
    fn test_exam_math_no_header_on_first_page() {
        let Some(core) = load_document("samples/exam_math_no.hwp") else {
            return;
        };
        let pages = &core.pagination;
        if let Some(result) = pages.first() {
            if let Some(page) = result.pages.first() {
                assert!(
                    page.active_header.is_none(),
                    "exam_math_no.hwp 1페이지에는 머리말이 없어야 함"
                );
            }
        }
    }

    #[test]
    fn test_exam_math_header_from_second_page() {
        let Some(core) = load_document("samples/exam_math_no.hwp") else {
            return;
        };
        let pages = &core.pagination;
        if let Some(result) = pages.first() {
            if result.pages.len() > 1 {
                let page2 = &result.pages[1];
                assert!(
                    page2.active_header.is_some(),
                    "exam_math_no.hwp 2페이지부터 머리말이 있어야 함"
                );
            }
        }
    }

    // ─── 표 분할(PartialTable) 검증 ───

    #[test]
    fn test_hwpspec_w_table_split() {
        let Some(core) = load_document("samples/hwpspec-w.hwp") else {
            return;
        };
        use crate::renderer::pagination::PageItem;
        let has_partial_table = core.pagination.iter().any(|result| {
            result.pages.iter().any(|p| {
                p.column_contents.iter().any(|cc| {
                    cc.items
                        .iter()
                        .any(|item| matches!(item, PageItem::PartialTable { .. }))
                })
            })
        });
        assert!(
            has_partial_table,
            "hwpspec-w.hwp에는 페이지 분할된 표(PartialTable)가 있어야 함"
        );
    }

    // ─── SVG 내보내기 검증 ───

    #[test]
    fn test_export_svg_produces_output() {
        let Some(core) = load_document("samples/hwpspec-w.hwp") else {
            return;
        };
        let svg = core.render_page_svg_native(0).unwrap_or_default();
        assert!(!svg.is_empty(), "SVG 출력이 비어있으면 안 됨");
        assert!(svg.contains("<svg"), "SVG 출력에 <svg 태그가 있어야 함");
        assert!(svg.contains("</svg>"), "SVG 출력에 </svg> 태그가 있어야 함");
    }

    #[test]
    fn test_export_svg_contains_text() {
        let Some(core) = load_document("samples/hwpspec-w.hwp") else {
            return;
        };
        let svg = core.render_page_svg_native(0).unwrap_or_default();
        assert!(svg.contains("<text"), "SVG에 텍스트 요소가 있어야 함");
    }

    // ─── 수식 렌더링 검증 ───

    #[test]
    fn test_equation_svg_content() {
        let Some(core) = load_document("samples/exam_math.hwp") else {
            return;
        };
        let svg = core.render_page_svg_native(0).unwrap_or_default();
        let has_content = svg.contains("<path") || svg.contains("<text");
        assert!(has_content, "수식 페이지 SVG에 렌더링 요소가 있어야 함");
    }

    // ─── 다중 페이지 렌더링 회귀 테스트 ───

    #[test]
    fn test_hwpspec_w_multi_page_render() {
        let Some(core) = load_document("samples/hwpspec-w.hwp") else {
            return;
        };
        for page_idx in 0..16u32 {
            let svg = core.render_page_svg_native(page_idx).unwrap_or_default();
            assert!(!svg.is_empty(), "페이지 {} SVG가 비어있음", page_idx + 1);
        }
    }

    // ─── 문단 테두리 검증 ───

    #[test]
    fn test_1_3_paragraph_border() {
        let Some(core) = load_document("samples/1-3.hwp") else {
            return;
        };
        let svg = core.render_page_svg_native(0).unwrap_or_default();
        assert!(
            svg.contains("<rect") || svg.contains("<path"),
            "1-3.hwp에 문단 테두리/배경 렌더링 요소가 있어야 함"
        );
    }

    #[test]
    fn test_layer_svg_matches_legacy_for_basic_text_sample() {
        assert_layer_svg_pixels_match("samples/lseg-01-basic.hwp", 0);
    }

    #[test]
    fn test_layer_svg_matches_legacy_for_table_sample() {
        assert_layer_svg_pixels_match_with_tolerance("samples/hwp_table_test.hwp", 0, 64);
    }

    #[test]
    fn test_layer_svg_fixture_matrix_rasterizes_against_legacy() {
        let fixtures = [
            ("text style", "samples/lseg-02-mixed.hwp", 0, 256),
            ("spacing", "samples/lseg-03-spacing.hwp", 0, 256),
            ("equation", "samples/eq-01.hwp", 0, 512),
            ("image crop", "samples/pic-crop-01.hwp", 0, 1_024),
            ("form object", "samples/form-01.hwp", 0, 1_024),
            ("drawing group", "samples/draw-group.hwp", 0, 2_048),
        ];

        for (feature, sample, page_num, max_diff_pixels) in fixtures {
            assert!(
                Path::new(sample).exists(),
                "layer SVG fixture sample is missing for {feature}: {sample}",
            );
            assert_layer_svg_pixels_match_with_tolerance(sample, page_num, max_diff_pixels);
        }
    }

    #[test]
    fn test_layer_svg_screenshot_matches_legacy_for_basic_text_sample() {
        assert_layer_svg_pixels_match("samples/lseg-01-basic.hwp", 0);
    }

    #[test]
    fn test_layer_svg_screenshot_matches_legacy_for_table_sample() {
        assert_layer_svg_pixels_match_with_tolerance("samples/hwp_table_test.hwp", 0, 64);
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
    #[test]
    fn test_skia_screenshot_matches_layer_svg_for_synthetic_shapes() {
        use crate::paint::{LayerBuilder, RenderProfile};
        use crate::renderer::render_tree::{
            BoundingBox, PageNode, PageRenderTree, RectangleNode, RenderNode, RenderNodeType,
        };
        use crate::renderer::ShapeStyle;
        use crate::renderer::{GradientFillInfo, PatternFillInfo};

        let mut tree = PageRenderTree::new(0, 180.0, 120.0);
        tree.root.node_type = RenderNodeType::Page(PageNode {
            page_index: 0,
            width: 180.0,
            height: 120.0,
            section_index: 0,
        });
        tree.root.children.push(RenderNode::new(
            1,
            RenderNodeType::Rectangle(RectangleNode::new(
                0.0,
                ShapeStyle {
                    fill_color: Some(0x00F6F0E6),
                    ..Default::default()
                },
                None,
            )),
            BoundingBox::new(12.0, 12.0, 60.0, 40.0),
        ));
        tree.root.children.push(RenderNode::new(
            2,
            RenderNodeType::Rectangle(RectangleNode::new(
                0.0,
                ShapeStyle {
                    fill_color: Some(0x00D9E7FF),
                    pattern: Some(PatternFillInfo {
                        pattern_type: 4,
                        pattern_color: 0x003D6FB6,
                        background_color: 0x00D9E7FF,
                    }),
                    ..Default::default()
                },
                None,
            )),
            BoundingBox::new(90.0, 28.0, 66.0, 52.0),
        ));
        tree.root.children.push(RenderNode::new(
            3,
            RenderNodeType::Rectangle(RectangleNode::new(
                0.0,
                ShapeStyle {
                    fill_color: Some(0x00C3D7AF),
                    ..Default::default()
                },
                Some(Box::new(GradientFillInfo {
                    gradient_type: 1,
                    angle: 0,
                    center_x: 50,
                    center_y: 50,
                    colors: vec![0x00EEF4E8, 0x00A9C47F, 0x00839A6B],
                    positions: vec![0.0, 0.65, 1.0],
                })),
            )),
            BoundingBox::new(24.0, 68.0, 64.0, 40.0),
        ));

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&tree);
        assert_skia_layer_tree_matches_svg("synthetic-shapes", &layer_tree);
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
    #[test]
    fn test_skia_screenshot_matches_layer_svg_for_synthetic_pattern_gradient_matrix() {
        use crate::paint::{LayerBuilder, RenderProfile};
        use crate::renderer::layer_renderer::{LayerRasterRenderer, LayerRenderer};
        use crate::renderer::render_tree::{
            BoundingBox, PageNode, PageRenderTree, RectangleNode, RenderNode, RenderNodeType,
        };
        use crate::renderer::skia::SkiaLayerRenderer;
        use crate::renderer::svg_layer::SvgLayerRenderer;
        use crate::renderer::ShapeStyle;
        use crate::renderer::{GradientFillInfo, PatternFillInfo};

        let mut tree = PageRenderTree::new(0, 288.0, 160.0);
        tree.root.node_type = RenderNodeType::Page(PageNode {
            page_index: 0,
            width: 288.0,
            height: 160.0,
            section_index: 0,
        });

        let make_rect = |id, bbox, style, gradient| {
            RenderNode::new(
                id,
                RenderNodeType::Rectangle(RectangleNode::new(0.0, style, gradient)),
                bbox,
            )
        };

        for pattern_type in 0..=5 {
            let x = 12.0 + pattern_type as f64 * 44.0;
            tree.root.children.push(make_rect(
                10 + pattern_type as u32,
                BoundingBox::new(x, 12.0, 32.0, 26.0),
                ShapeStyle {
                    fill_color: Some(0x00E8EEF8),
                    pattern: Some(PatternFillInfo {
                        pattern_type,
                        pattern_color: 0x002B5BA7,
                        background_color: 0x00E8EEF8,
                    }),
                    ..Default::default()
                },
                None,
            ));
        }

        let gradient_cases = [
            (1, 0, 50, 50),
            (1, 45, 50, 50),
            (1, 90, 50, 50),
            (1, 135, 50, 50),
            (1, 33, 50, 50),
            (2, 0, 35, 35),
            (3, 0, 70, 30),
            (4, 0, 50, 70),
        ];
        for (idx, (gradient_type, angle, center_x, center_y)) in
            gradient_cases.into_iter().enumerate()
        {
            let x = 12.0 + (idx % 4) as f64 * 68.0;
            let y = 54.0 + (idx / 4) as f64 * 44.0;
            tree.root.children.push(make_rect(
                30 + idx as u32,
                BoundingBox::new(x, y, 54.0, 34.0),
                ShapeStyle {
                    fill_color: Some(0x00F4F4F4),
                    ..Default::default()
                },
                Some(Box::new(GradientFillInfo {
                    gradient_type,
                    angle,
                    center_x,
                    center_y,
                    colors: vec![0x003A66B7, 0x00F4D35E, 0x00E94F37],
                    positions: vec![0.0, 0.48, 1.0],
                })),
            ));
        }

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&tree);
        assert_skia_layer_tree_matches_svg("synthetic-pattern-gradient-matrix", &layer_tree);

        let mut svg_renderer = SvgLayerRenderer::new();
        svg_renderer
            .render_page(&layer_tree)
            .expect("synthetic pattern/gradient SVG layer render");
        let expected =
            rasterize_svg(svg_renderer.output()).expect("synthetic pattern/gradient SVG rasterize");
        let renderer = SkiaLayerRenderer::new();
        let actual_png = LayerRasterRenderer::render_png(&renderer, &layer_tree)
            .expect("synthetic pattern/gradient Skia render");
        let actual = decode_png(&actual_png).expect("synthetic pattern/gradient Skia decode");
        let color_diff = diff_pixmaps_with_neighborhood(&expected, &actual, 32, 1);
        let color_diff_ratio = color_diff.diff_pixels as f64 / color_diff.total_pixels as f64;

        assert!(
            color_diff_ratio < 0.18,
            "pattern/gradient color diff ratio too high: {:.3}%",
            color_diff_ratio * 100.0,
        );
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
    #[test]
    fn test_skia_screenshot_matches_layer_svg_for_shape_group_sample() {
        assert_skia_png_matches_layer_svg("samples/shape-group-02.hwp", 0);
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
    #[test]
    fn test_skia_screenshot_matches_layer_svg_for_table_vpos_sample() {
        assert_skia_png_matches_layer_svg("samples/table-vpos-01.hwp", 0);
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
    #[test]
    fn test_skia_screenshot_matches_layer_svg_for_img_start_sample() {
        assert_skia_png_matches_layer_svg("samples/img-start-001.hwp", 0);
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
    #[test]
    fn test_skia_screenshot_matches_layer_svg_for_pic_in_head_sample() {
        assert_skia_png_matches_layer_svg("samples/pic-in-head-02.hwp", 0);
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
    #[test]
    fn test_skia_screenshot_matches_layer_svg_for_footnote_sample() {
        assert_skia_png_matches_layer_svg("samples/footnote-01.hwp", 0);
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
    #[test]
    fn test_skia_screenshot_matches_layer_svg_for_endnote_sample() {
        assert_skia_png_matches_layer_svg("samples/endnote-01.hwp", 0);
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
    #[test]
    fn test_skia_screenshot_matches_layer_svg_for_synthetic_equation_layout() {
        use crate::paint::{LayerBuilder, RenderProfile};
        use crate::renderer::equation::layout::EqLayout;
        use crate::renderer::equation::parser::EqParser;
        use crate::renderer::equation::svg_render::render_equation_svg;
        use crate::renderer::equation::tokenizer::tokenize;
        use crate::renderer::render_tree::{
            BoundingBox, EquationNode, PageNode, PageRenderTree, RenderNode, RenderNodeType,
        };

        let font_size = 22.0;
        let ast = EqParser::new(tokenize(
            "SUM _{i=1} ^{n} LEFT ( x_i ^2 + y_i ^2 RIGHT ) over SQRT {n}",
        ))
        .parse();
        let layout_box = EqLayout::new(font_size).layout(&ast);
        let svg_content = render_equation_svg(&layout_box, "#000000", font_size);

        let mut tree = PageRenderTree::new(0, 320.0, 140.0);
        tree.root.node_type = RenderNodeType::Page(PageNode {
            page_index: 0,
            width: 320.0,
            height: 140.0,
            section_index: 0,
        });
        tree.root.children.push(RenderNode::new(
            1,
            RenderNodeType::Equation(EquationNode {
                svg_content,
                layout_box: layout_box.clone(),
                color_str: "#000000".to_string(),
                color: 0x00000000,
                font_size,
                section_index: Some(0),
                para_index: Some(0),
                control_index: Some(0),
                cell_index: None,
                cell_para_index: None,
            }),
            BoundingBox::new(18.0, 24.0, layout_box.width, layout_box.height),
        ));

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&tree);
        assert_skia_layer_tree_matches_svg("synthetic-equation-layout", &layer_tree);
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
    #[test]
    fn test_skia_equation_prefers_interned_svg_resource_over_layout_fallback() {
        use crate::paint::{LayerBuilder, LayerNodeKind, PaintOp, RenderProfile};
        use crate::renderer::equation::layout::{EqLayout, LayoutKind};
        use crate::renderer::equation::parser::EqParser;
        use crate::renderer::equation::svg_render::render_equation_svg;
        use crate::renderer::equation::tokenizer::tokenize;
        use crate::renderer::render_tree::{
            BoundingBox, EquationNode, PageNode, PageRenderTree, RenderNode, RenderNodeType,
        };

        let font_size = 22.0;
        let ast = EqParser::new(tokenize(
            "SUM _{i=1} ^{n} LEFT ( x_i ^2 + y_i ^2 RIGHT ) over SQRT {n}",
        ))
        .parse();
        let layout_box = EqLayout::new(font_size).layout(&ast);
        let svg_content = render_equation_svg(&layout_box, "#000000", font_size);

        let mut tree = PageRenderTree::new(0, 320.0, 140.0);
        tree.root.node_type = RenderNodeType::Page(PageNode {
            page_index: 0,
            width: 320.0,
            height: 140.0,
            section_index: 0,
        });
        tree.root.children.push(RenderNode::new(
            1,
            RenderNodeType::Equation(EquationNode {
                svg_content,
                layout_box: layout_box.clone(),
                color_str: "#000000".to_string(),
                color: 0x00000000,
                font_size,
                section_index: Some(0),
                para_index: Some(0),
                control_index: Some(0),
                cell_index: None,
                cell_para_index: None,
            }),
            BoundingBox::new(18.0, 24.0, layout_box.width, layout_box.height),
        ));

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let mut layer_tree = builder.build(&tree);

        let LayerNodeKind::Group { children, .. } = &mut layer_tree.root.kind else {
            panic!("expected root layer group");
        };
        let equation_leaf = children
            .iter_mut()
            .find_map(|child| match &mut child.kind {
                LayerNodeKind::Leaf { ops, .. } => ops.iter_mut().find_map(|op| match op {
                    PaintOp::Equation { equation, .. } => Some(equation),
                    _ => None,
                }),
                _ => None,
            })
            .expect("synthetic equation leaf not found");

        equation_leaf.layout_box.width = 1.0;
        equation_leaf.layout_box.height = 1.0;
        equation_leaf.layout_box.baseline = 0.0;
        equation_leaf.layout_box.kind = LayoutKind::Empty;

        assert_skia_layer_tree_matches_svg("synthetic-equation-svg-resource", &layer_tree);
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
    #[test]
    fn test_skia_screenshot_matches_layer_svg_for_basic_text_sample() {
        assert_skia_png_matches_layer_svg("samples/lseg-01-basic.hwp", 0);
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
    #[test]
    fn test_skia_screenshot_matches_layer_svg_for_table_sample() {
        assert_skia_png_matches_layer_svg("samples/hwp_table_test.hwp", 0);
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
    #[test]
    fn test_skia_screenshot_matches_layer_svg_for_equation_sample() {
        assert_skia_png_matches_layer_svg("samples/eq-01.hwp", 0);
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
    #[test]
    fn test_skia_screenshot_matches_layer_svg_for_picture_crop_sample() {
        assert_skia_png_matches_layer_svg("samples/pic-crop-01.hwp", 0);
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
    #[test]
    fn test_skia_screenshot_matches_layer_svg_for_draw_group_sample() {
        assert_skia_png_matches_layer_svg("samples/draw-group.hwp", 0);
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
    #[test]
    fn test_skia_screenshot_matches_layer_svg_for_hwp_3_0_hwpml_sample() {
        assert_skia_png_matches_layer_svg("samples/hwp-3.0-HWPML.hwp", 0);
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
    #[test]
    fn test_skia_screenshot_matches_layer_svg_for_hwpspec_sample() {
        assert_skia_png_matches_layer_svg("samples/hwpspec.hwp", 0);
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
    #[test]
    fn test_skia_screenshot_matches_layer_svg_for_real_positioned_text_visuals() {
        let samples = vec![("samples/aift.hwp".to_string(), vec![0, 1, 3])];
        assert_skia_png_matches_layer_svg_for_corpus("positioned-text", &samples);
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
    #[test]
    fn test_skia_screenshot_matches_layer_svg_for_representative_sample_corpus() {
        let samples = vec![
            ("samples/lseg-02-mixed.hwp".to_string(), vec![0]),
            ("samples/lseg-03-spacing.hwp".to_string(), vec![0]),
            ("samples/field-01.hwp".to_string(), vec![0]),
            ("samples/form-01.hwp".to_string(), vec![0]),
            ("samples/eq-01.hwp".to_string(), vec![0]),
            ("samples/pic-crop-01.hwp".to_string(), vec![0]),
            ("samples/pic-in-table-01.hwp".to_string(), vec![0]),
            ("samples/lseg-05-tab.hwp".to_string(), vec![0]),
            ("samples/shift-return.hwp".to_string(), vec![0]),
            ("samples/field-01-memo.hwp".to_string(), vec![0]),
            ("samples/table-001.hwp".to_string(), vec![0]),
            ("samples/table-complex.hwp".to_string(), vec![0]),
            ("samples/group-drawing-02.hwp".to_string(), vec![0]),
            ("samples/hwp-img-001.hwp".to_string(), vec![0]),
            ("samples/biz_plan.hwp".to_string(), vec![0]),
        ];

        assert_skia_png_matches_layer_svg_for_corpus("representative", &samples);
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
    #[test]
    #[ignore = "expensive full sample sweep"]
    fn test_skia_screenshot_matches_layer_svg_for_full_sample_corpus() {
        let mut samples = Vec::new();
        for entry in std::fs::read_dir("samples").expect("samples 디렉터리 읽기 실패") {
            let entry = entry.expect("samples 디렉터리 항목 읽기 실패");
            let path = entry.path();
            if !path.is_file() {
                continue;
            }

            let extension = path
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.to_ascii_lowercase())
                .unwrap_or_default();
            if !matches!(extension.as_str(), "hwp" | "hwpx") {
                continue;
            }

            let file_name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default();
            if matches!(file_name, "loading-fail-01.hwp") {
                continue;
            }

            samples.push((path.to_string_lossy().to_string(), vec![0]));
        }
        samples.sort_by(|left, right| left.0.cmp(&right.0));

        assert_skia_png_matches_layer_svg_for_corpus("full", &samples);
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
    #[test]
    fn test_skia_screenshot_matches_layer_svg_for_synthetic_form_controls() {
        use crate::model::control::FormType;
        use crate::paint::{LayerBuilder, RenderProfile};
        use crate::renderer::render_tree::{
            BoundingBox, FormObjectNode, PageNode, PageRenderTree, RenderNode, RenderNodeType,
        };

        let mut tree = PageRenderTree::new(0, 320.0, 180.0);
        tree.root.node_type = RenderNodeType::Page(PageNode {
            page_index: 0,
            width: 320.0,
            height: 180.0,
            section_index: 0,
        });

        let forms = [
            (
                1,
                FormObjectNode {
                    form_type: FormType::PushButton,
                    caption: String::new(),
                    text: String::new(),
                    fore_color: "#000000".to_string(),
                    back_color: "#ffffff".to_string(),
                    value: 0,
                    enabled: true,
                    section_index: 0,
                    para_index: 0,
                    control_index: 0,
                    name: "button".to_string(),
                    cell_location: None,
                },
                BoundingBox::new(20.0, 20.0, 72.0, 24.0),
            ),
            (
                2,
                FormObjectNode {
                    form_type: FormType::CheckBox,
                    caption: String::new(),
                    text: String::new(),
                    fore_color: "#202020".to_string(),
                    back_color: "#ffffff".to_string(),
                    value: 1,
                    enabled: true,
                    section_index: 0,
                    para_index: 0,
                    control_index: 1,
                    name: "check".to_string(),
                    cell_location: None,
                },
                BoundingBox::new(20.0, 60.0, 110.0, 20.0),
            ),
            (
                3,
                FormObjectNode {
                    form_type: FormType::RadioButton,
                    caption: String::new(),
                    text: String::new(),
                    fore_color: "#202020".to_string(),
                    back_color: "#ffffff".to_string(),
                    value: 1,
                    enabled: true,
                    section_index: 0,
                    para_index: 0,
                    control_index: 2,
                    name: "radio".to_string(),
                    cell_location: None,
                },
                BoundingBox::new(20.0, 92.0, 110.0, 20.0),
            ),
            (
                4,
                FormObjectNode {
                    form_type: FormType::ComboBox,
                    caption: String::new(),
                    text: String::new(),
                    fore_color: "#303030".to_string(),
                    back_color: "#ffffff".to_string(),
                    value: 0,
                    enabled: true,
                    section_index: 0,
                    para_index: 0,
                    control_index: 3,
                    name: "combo".to_string(),
                    cell_location: None,
                },
                BoundingBox::new(160.0, 20.0, 110.0, 24.0),
            ),
            (
                5,
                FormObjectNode {
                    form_type: FormType::Edit,
                    caption: String::new(),
                    text: String::new(),
                    fore_color: "#303030".to_string(),
                    back_color: "#ffffff".to_string(),
                    value: 0,
                    enabled: true,
                    section_index: 0,
                    para_index: 0,
                    control_index: 4,
                    name: "edit".to_string(),
                    cell_location: None,
                },
                BoundingBox::new(160.0, 60.0, 110.0, 24.0),
            ),
        ];

        for (node_id, form, bbox) in forms {
            tree.root.children.push(RenderNode::new(
                node_id,
                RenderNodeType::FormObject(form),
                bbox,
            ));
        }

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&tree);
        assert_skia_layer_tree_matches_svg("synthetic-form-controls", &layer_tree);
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
    #[test]
    fn test_skia_screenshot_matches_layer_svg_for_synthetic_page_background_image() {
        use crate::model::image::ImageEffect;
        use crate::model::style::ImageFillMode;
        use crate::paint::{LayerBuilder, RenderProfile};
        use crate::renderer::render_tree::{
            BoundingBox, PageBackgroundImage, PageBackgroundNode, PageNode, PageRenderTree,
            RenderNode, RenderNodeType,
        };

        let mut tree = PageRenderTree::new(0, 160.0, 120.0);
        tree.root.node_type = RenderNodeType::Page(PageNode {
            page_index: 0,
            width: 160.0,
            height: 120.0,
            section_index: 0,
        });
        tree.root.children.push(RenderNode::new(
            1,
            RenderNodeType::PageBackground(PageBackgroundNode {
                background_color: Some(0x00FFFFFF),
                border_color: None,
                border_width: 0.0,
                gradient: None,
                image: Some(PageBackgroundImage {
                    data: synthetic_png_bytes(),
                    fill_mode: ImageFillMode::FitToSize,
                    brightness: 0,
                    contrast: 0,
                    effect: ImageEffect::RealPic,
                }),
            }),
            BoundingBox::new(0.0, 0.0, 160.0, 120.0),
        ));

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&tree);
        assert_skia_layer_tree_matches_svg("synthetic-page-background-image", &layer_tree);
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
    #[test]
    fn test_skia_screenshot_matches_layer_svg_for_synthetic_image_fill_modes() {
        use crate::model::image::ImageEffect;
        use crate::model::style::ImageFillMode;
        use crate::paint::{LayerBuilder, RenderProfile};
        use crate::renderer::render_tree::{
            BoundingBox, ImageNode, PageBackgroundNode, PageNode, PageRenderTree, RenderNode,
            RenderNodeType, ShapeTransform,
        };

        let png_bytes = synthetic_png_bytes();
        let mut transparent_pixmap =
            tiny_skia::Pixmap::new(32, 32).expect("transparent synthetic pixmap 생성 실패");
        for y in 0..32usize {
            for x in 0..32usize {
                let alpha = if (x / 8 + y / 8) % 2 == 0 { 255 } else { 0 };
                let (r, g, b) = if y < 16 {
                    (40, 120, 255)
                } else {
                    (255, 80, 120)
                };
                let base = (y * 32 + x) * 4;
                transparent_pixmap.data_mut()[base..base + 4].copy_from_slice(&[r, g, b, alpha]);
            }
        }
        let transparent_png = transparent_pixmap
            .encode_png()
            .expect("transparent synthetic png 인코딩 실패");
        let mut blackwhite_pixmap =
            tiny_skia::Pixmap::new(24, 16).expect("blackwhite synthetic pixmap 생성 실패");
        for y in 0..16usize {
            for x in 0..24usize {
                let value = if x < 12 { 36 } else { 224 };
                let base = (y * 24 + x) * 4;
                blackwhite_pixmap.data_mut()[base..base + 4]
                    .copy_from_slice(&[value, value, value, 255]);
            }
        }
        let blackwhite_png = blackwhite_pixmap
            .encode_png()
            .expect("blackwhite synthetic png 인코딩 실패");
        let mut alpha_gradient_pixmap =
            tiny_skia::Pixmap::new(16, 16).expect("alpha gradient synthetic pixmap 생성 실패");
        for y in 0..16usize {
            for x in 0..16usize {
                let alpha = 128 + (((x + y) * 5) % 96) as u8;
                let red = (24 + x * 4) as u8;
                let green = (32 + y * 4) as u8;
                let blue = (96usize.saturating_sub((x + y) * 2)) as u8;
                alpha_gradient_pixmap.pixels_mut()[y * 16 + x] =
                    tiny_skia::PremultipliedColorU8::from_rgba(red, green, blue, alpha)
                        .expect("alpha gradient pixel");
            }
        }
        let alpha_gradient_png = alpha_gradient_pixmap
            .encode_png()
            .expect("alpha gradient synthetic png 인코딩 실패");

        let mut tree = PageRenderTree::new(0, 280.0, 260.0);
        tree.root.node_type = RenderNodeType::Page(PageNode {
            page_index: 0,
            width: 280.0,
            height: 260.0,
            section_index: 0,
        });
        tree.root.children.push(RenderNode::new(
            1,
            RenderNodeType::PageBackground(PageBackgroundNode {
                background_color: Some(0x00F5F0E3),
                border_color: None,
                border_width: 0.0,
                gradient: None,
                image: None,
            }),
            BoundingBox::new(0.0, 0.0, 280.0, 260.0),
        ));

        let mut crop_x = ImageNode::new(0, Some(png_bytes.clone()));
        crop_x.fill_mode = Some(ImageFillMode::FitToSize);
        crop_x.crop = Some((10 * 75, 0, 32 * 75, 30 * 75));
        crop_x.transform = ShapeTransform::default();
        crop_x.effect = ImageEffect::RealPic;
        tree.root.children.push(RenderNode::new(
            2,
            RenderNodeType::Image(crop_x),
            BoundingBox::new(16.0, 16.0, 72.0, 52.0),
        ));

        let mut crop_y = ImageNode::new(0, Some(png_bytes.clone()));
        crop_y.fill_mode = Some(ImageFillMode::FitToSize);
        crop_y.crop = Some((0, 6 * 75, 40 * 75, 24 * 75));
        crop_y.transform = ShapeTransform::default();
        crop_y.effect = ImageEffect::GrayScale;
        tree.root.children.push(RenderNode::new(
            3,
            RenderNodeType::Image(crop_y),
            BoundingBox::new(104.0, 16.0, 72.0, 52.0),
        ));

        let mut crop_both_centered = ImageNode::new(0, Some(png_bytes.clone()));
        crop_both_centered.fill_mode = Some(ImageFillMode::Center);
        crop_both_centered.original_size = Some((42.0, 30.0));
        crop_both_centered.crop = Some((8 * 75, 5 * 75, 34 * 75, 24 * 75));
        crop_both_centered.transform = ShapeTransform::default();
        crop_both_centered.effect = ImageEffect::RealPic;
        tree.root.children.push(RenderNode::new(
            4,
            RenderNodeType::Image(crop_both_centered),
            BoundingBox::new(192.0, 16.0, 72.0, 52.0),
        ));

        let mut patterned_center_bottom = ImageNode::new(0, Some(png_bytes.clone()));
        patterned_center_bottom.fill_mode = Some(ImageFillMode::CenterBottom);
        patterned_center_bottom.original_size = Some((40.0, 30.0));
        patterned_center_bottom.transform = ShapeTransform::default();
        patterned_center_bottom.effect = ImageEffect::Pattern8x8;
        tree.root.children.push(RenderNode::new(
            5,
            RenderNodeType::Image(patterned_center_bottom),
            BoundingBox::new(16.0, 86.0, 72.0, 58.0),
        ));

        let mut tiled = ImageNode::new(0, Some(png_bytes.clone()));
        tiled.fill_mode = Some(ImageFillMode::TileAll);
        tiled.crop = Some((5 * 75, 4 * 75, 30 * 75, 26 * 75));
        tiled.original_size = Some((20.0, 15.0));
        tiled.transform = ShapeTransform::default();
        tiled.effect = ImageEffect::Pattern8x8;
        tree.root.children.push(RenderNode::new(
            6,
            RenderNodeType::Image(tiled),
            BoundingBox::new(104.0, 86.0, 160.0, 58.0),
        ));

        let mut transparent_over_background = ImageNode::new(0, Some(transparent_png.clone()));
        transparent_over_background.fill_mode = Some(ImageFillMode::FitToSize);
        transparent_over_background.transform = ShapeTransform::default();
        transparent_over_background.effect = ImageEffect::RealPic;
        tree.root.children.push(RenderNode::new(
            7,
            RenderNodeType::Image(transparent_over_background),
            BoundingBox::new(16.0, 164.0, 56.0, 40.0),
        ));

        let mut transparent_pattern = ImageNode::new(0, Some(transparent_png));
        transparent_pattern.fill_mode = Some(ImageFillMode::FitToSize);
        transparent_pattern.crop = Some((8 * 75, 8 * 75, 32 * 75, 32 * 75));
        transparent_pattern.transform = ShapeTransform::default();
        transparent_pattern.effect = ImageEffect::Pattern8x8;
        tree.root.children.push(RenderNode::new(
            10,
            RenderNodeType::Image(transparent_pattern),
            BoundingBox::new(76.0, 164.0, 26.0, 40.0),
        ));

        let mut transformed = ImageNode::new(0, Some(png_bytes.clone()));
        transformed.fill_mode = Some(ImageFillMode::FitToSize);
        transformed.crop = Some((0, 0, 36 * 75, 26 * 75));
        transformed.transform = ShapeTransform {
            rotation: 14.0,
            horz_flip: true,
            vert_flip: true,
        };
        transformed.effect = ImageEffect::RealPic;
        tree.root.children.push(RenderNode::new(
            8,
            RenderNodeType::Image(transformed),
            BoundingBox::new(108.0, 162.0, 86.0, 42.0),
        ));

        let mut blackwhite = ImageNode::new(0, Some(blackwhite_png));
        blackwhite.fill_mode = Some(ImageFillMode::FitToSize);
        blackwhite.transform = ShapeTransform::default();
        blackwhite.effect = ImageEffect::BlackWhite;
        tree.root.children.push(RenderNode::new(
            9,
            RenderNodeType::Image(blackwhite),
            BoundingBox::new(216.0, 164.0, 48.0, 34.0),
        ));

        let mut tiled_realpic = ImageNode::new(0, Some(png_bytes.clone()));
        tiled_realpic.fill_mode = Some(ImageFillMode::TileAll);
        tiled_realpic.crop = Some((4 * 75, 3 * 75, 28 * 75, 24 * 75));
        tiled_realpic.original_size = Some((18.0, 14.0));
        tiled_realpic.transform = ShapeTransform::default();
        tiled_realpic.effect = ImageEffect::RealPic;
        tree.root.children.push(RenderNode::new(
            11,
            RenderNodeType::Image(tiled_realpic),
            BoundingBox::new(16.0, 214.0, 112.0, 34.0),
        ));

        let mut alpha_scaled_pattern = ImageNode::new(0, Some(alpha_gradient_png));
        alpha_scaled_pattern.fill_mode = Some(ImageFillMode::FitToSize);
        alpha_scaled_pattern.transform = ShapeTransform::default();
        alpha_scaled_pattern.effect = ImageEffect::Pattern8x8;
        tree.root.children.push(RenderNode::new(
            12,
            RenderNodeType::Image(alpha_scaled_pattern),
            BoundingBox::new(148.0, 214.0, 64.0, 34.0),
        ));

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&tree);
        assert_skia_layer_tree_matches_svg("synthetic-image-fill-modes", &layer_tree);
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
    #[test]
    fn test_skia_screenshot_matches_layer_svg_for_synthetic_clip_overflow() {
        use crate::paint::{LayerBuilder, RenderProfile};
        use crate::renderer::render_tree::{
            BoundingBox, PageBackgroundNode, PageNode, PageRenderTree, RectangleNode, RenderNode,
            RenderNodeType, TableCellNode, TextLineNode,
        };
        use crate::renderer::ShapeStyle;

        let mut tree = PageRenderTree::new(0, 220.0, 150.0);
        tree.root.node_type = RenderNodeType::Page(PageNode {
            page_index: 0,
            width: 220.0,
            height: 150.0,
            section_index: 0,
        });
        tree.root.children.push(RenderNode::new(
            1,
            RenderNodeType::PageBackground(PageBackgroundNode {
                background_color: Some(0x00FFFFFF),
                border_color: None,
                border_width: 0.0,
                gradient: None,
                image: None,
            }),
            BoundingBox::new(0.0, 0.0, 220.0, 150.0),
        ));

        let make_rect = |id, bbox, fill_color| {
            RenderNode::new(
                id,
                RenderNodeType::Rectangle(RectangleNode::new(
                    0.0,
                    ShapeStyle {
                        fill_color: Some(fill_color),
                        ..Default::default()
                    },
                    None,
                )),
                bbox,
            )
        };

        let mut body = RenderNode::new(
            10,
            RenderNodeType::Body {
                clip_rect: Some(BoundingBox::new(30.0, 20.0, 120.0, 80.0)),
            },
            BoundingBox::new(30.0, 20.0, 120.0, 80.0),
        );
        let mut column = RenderNode::new(
            11,
            RenderNodeType::Column(0),
            BoundingBox::new(30.0, 20.0, 120.0, 80.0),
        );
        let mut text_line = RenderNode::new(
            12,
            RenderNodeType::TextLine(TextLineNode::new(28.0, 20.0)),
            BoundingBox::new(30.0, 28.0, 120.0, 28.0),
        );
        text_line.children.push(make_rect(
            13,
            BoundingBox::new(138.0, 34.0, 18.0, 16.0),
            0x0000AA00,
        ));
        column.children.push(make_rect(
            14,
            BoundingBox::new(48.0, 62.0, 52.0, 22.0),
            0x000066CC,
        ));
        column.children.push(text_line);
        column.children.push(make_rect(
            15,
            BoundingBox::new(166.0, 42.0, 32.0, 24.0),
            0x00CC3333,
        ));
        body.children.push(column);
        tree.root.children.push(body);

        let mut cell = RenderNode::new(
            20,
            RenderNodeType::TableCell(TableCellNode {
                col: 0,
                row: 0,
                col_span: 1,
                row_span: 1,
                border_fill_id: 0,
                text_direction: 0,
                clip: true,
                model_cell_index: None,
            }),
            BoundingBox::new(30.0, 112.0, 74.0, 24.0),
        );
        cell.children.push(make_rect(
            21,
            BoundingBox::new(98.0, 116.0, 14.0, 14.0),
            0x00FF9900,
        ));
        tree.root.children.push(cell);

        let mut builder = LayerBuilder::new(RenderProfile::Screen);
        let layer_tree = builder.build(&tree);
        assert_skia_layer_tree_matches_svg("synthetic-clip-overflow", &layer_tree);
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
    #[test]
    fn test_skia_screenshot_matches_layer_svg_for_synthetic_text_marks() {
        use crate::paint::{LayerBuilder, LayerOutputOptions, RenderProfile};
        use crate::renderer::composer::CharOverlapInfo;
        use crate::renderer::render_tree::{
            BoundingBox, FieldMarkerType, PageBackgroundNode, PageNode, PageRenderTree, RenderNode,
            RenderNodeType, TextRunNode,
        };
        use crate::renderer::TextStyle;

        let mut tree = PageRenderTree::new(0, 240.0, 210.0);
        tree.root.node_type = RenderNodeType::Page(PageNode {
            page_index: 0,
            width: 240.0,
            height: 210.0,
            section_index: 0,
        });
        tree.root.children.push(RenderNode::new(
            1,
            RenderNodeType::PageBackground(PageBackgroundNode {
                background_color: Some(0x00FFFFFF),
                border_color: None,
                border_width: 0.0,
                gradient: None,
                image: None,
            }),
            BoundingBox::new(0.0, 0.0, 240.0, 210.0),
        ));

        let mut next_id = 2;
        let mut push_text = |tree: &mut PageRenderTree,
                             text: &str,
                             bbox: BoundingBox,
                             style: TextStyle,
                             baseline: f64,
                             is_para_end: bool,
                             is_line_break_end: bool,
                             rotation: f64,
                             is_vertical: bool,
                             char_overlap: Option<CharOverlapInfo>,
                             field_marker: FieldMarkerType| {
            tree.root.children.push(RenderNode::new(
                next_id,
                RenderNodeType::TextRun(TextRunNode {
                    text: text.to_string(),
                    style,
                    char_shape_id: None,
                    para_shape_id: None,
                    section_index: None,
                    para_index: None,
                    char_start: None,
                    cell_context: None,
                    is_para_end,
                    is_line_break_end,
                    rotation,
                    is_vertical,
                    char_overlap,
                    border_fill_id: 0,
                    baseline,
                    field_marker,
                }),
                bbox,
            ));
            next_id += 1;
        };

        push_text(
            &mut tree,
            "a b\tc",
            BoundingBox::new(12.0, 16.0, 90.0, 28.0),
            TextStyle {
                font_size: 18.0,
                color: 0x00000000,
                ..Default::default()
            },
            22.0,
            true,
            false,
            0.0,
            false,
            None,
            FieldMarkerType::None,
        );
        push_text(
            &mut tree,
            "12",
            BoundingBox::new(126.0, 12.0, 32.0, 32.0),
            TextStyle {
                font_size: 24.0,
                color: 0x00000000,
                ..Default::default()
            },
            24.0,
            false,
            false,
            0.0,
            false,
            Some(CharOverlapInfo {
                border_type: 1,
                inner_char_size: 80,
            }),
            FieldMarkerType::None,
        );
        push_text(
            &mut tree,
            "[누름틀 시작]",
            BoundingBox::new(16.0, 66.0, 86.0, 24.0),
            TextStyle {
                font_size: 11.0,
                color: 0x0066CC,
                ..Default::default()
            },
            17.0,
            false,
            false,
            0.0,
            false,
            None,
            FieldMarkerType::FieldBegin,
        );
        push_text(
            &mut tree,
            "[누름틀 끝]\t",
            BoundingBox::new(16.0, 88.0, 92.0, 24.0),
            TextStyle {
                font_size: 11.0,
                color: 0x0066CC,
                underline: crate::model::style::UnderlineType::Bottom,
                ..Default::default()
            },
            17.0,
            true,
            false,
            0.0,
            false,
            None,
            FieldMarkerType::FieldEnd,
        );
        push_text(
            &mut tree,
            "line",
            BoundingBox::new(124.0, 62.0, 56.0, 28.0),
            TextStyle {
                font_size: 18.0,
                color: 0x00000000,
                ..Default::default()
            },
            22.0,
            false,
            true,
            0.0,
            false,
            None,
            FieldMarkerType::None,
        );
        push_text(
            &mut tree,
            "[빈 누름틀]",
            BoundingBox::new(16.0, 144.0, 92.0, 24.0),
            TextStyle {
                font_size: 11.0,
                color: 0x0066CC,
                ..Default::default()
            },
            17.0,
            false,
            false,
            15.0,
            false,
            None,
            FieldMarkerType::FieldBeginEnd,
        );
        push_text(
            &mut tree,
            "[개체]",
            BoundingBox::new(132.0, 144.0, 58.0, 24.0),
            TextStyle {
                font_size: 11.0,
                color: 0x0066CC,
                ..Default::default()
            },
            17.0,
            false,
            false,
            0.0,
            false,
            None,
            FieldMarkerType::ShapeMarker(7),
        );
        push_text(
            &mut tree,
            "rot",
            BoundingBox::new(18.0, 108.0, 58.0, 26.0),
            TextStyle {
                font_size: 16.0,
                color: 0x00000000,
                ..Default::default()
            },
            20.0,
            true,
            false,
            25.0,
            false,
            None,
            FieldMarkerType::None,
        );
        push_text(
            &mut tree,
            "vert",
            BoundingBox::new(128.0, 104.0, 58.0, 28.0),
            TextStyle {
                font_size: 16.0,
                color: 0x00000000,
                ..Default::default()
            },
            20.0,
            false,
            true,
            90.0,
            true,
            None,
            FieldMarkerType::None,
        );

        let mut builder =
            LayerBuilder::new(RenderProfile::Screen).with_output_options(LayerOutputOptions {
                show_paragraph_marks: true,
                show_control_codes: true,
                ..Default::default()
            });
        let layer_tree = builder.build(&tree);
        assert_skia_layer_tree_matches_svg("synthetic-text-marks", &layer_tree);
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
    #[test]
    fn test_skia_clip_enabled_toggle_changes_table_cell_visibility() {
        use crate::paint::{LayerBuilder, LayerOutputOptions, RenderProfile};
        use crate::renderer::render_tree::{
            BoundingBox, PageNode, PageRenderTree, RectangleNode, RenderNode, RenderNodeType,
            TableCellNode,
        };
        use crate::renderer::skia::SkiaLayerRenderer;
        use crate::renderer::ShapeStyle;

        let build_tree = |clip_enabled| {
            let mut tree = PageRenderTree::new(0, 80.0, 50.0);
            tree.root.node_type = RenderNodeType::Page(PageNode {
                page_index: 0,
                width: 80.0,
                height: 50.0,
                section_index: 0,
            });
            let mut cell = RenderNode::new(
                10,
                RenderNodeType::TableCell(TableCellNode {
                    col: 0,
                    row: 0,
                    col_span: 1,
                    row_span: 1,
                    border_fill_id: 0,
                    text_direction: 0,
                    clip: true,
                    model_cell_index: None,
                }),
                BoundingBox::new(10.0, 10.0, 30.0, 28.0),
            );
            cell.children.push(RenderNode::new(
                11,
                RenderNodeType::Rectangle(RectangleNode::new(
                    0.0,
                    ShapeStyle {
                        fill_color: Some(0x00000000),
                        ..Default::default()
                    },
                    None,
                )),
                BoundingBox::new(45.0, 18.0, 18.0, 12.0),
            ));
            tree.root.children.push(cell);

            LayerBuilder::new(RenderProfile::Screen)
                .with_output_options(LayerOutputOptions {
                    clip_enabled,
                    ..Default::default()
                })
                .build(&tree)
        };

        let renderer = SkiaLayerRenderer::new();
        let clipped_png = renderer
            .render_png(&build_tree(true))
            .expect("clip-enabled skia render");
        let unclipped_png = renderer
            .render_png(&build_tree(false))
            .expect("clip-disabled skia render");
        let clipped = tiny_skia::Pixmap::decode_png(&clipped_png).expect("clip enabled png decode");
        let unclipped =
            tiny_skia::Pixmap::decode_png(&unclipped_png).expect("clip disabled png decode");
        let width = clipped.width() as usize;
        let probe = 24 * width + 54;

        assert_eq!(
            clipped.pixels()[probe].alpha(),
            0,
            "clip-enabled table cell should hide pixels beyond the cell clip"
        );
        assert!(
            unclipped.pixels()[probe].alpha() > 0,
            "clip-disabled table cell should render pixels beyond the cell clip"
        );
    }

    #[test]
    fn test_get_page_layer_tree_native_populates_page_tree_cache() {
        let Some(core) = load_document("samples/lseg-01-basic.hwp") else {
            return;
        };
        let _guard = lock_render_path_env();
        std::env::remove_var("RHWP_RENDER_PROFILE");

        assert!(
            core.page_tree_cache.borrow().is_empty(),
            "테스트 시작 시 페이지 트리 캐시는 비어 있어야 함"
        );

        core.get_page_layer_tree_native(0)
            .expect("레이어 트리 직렬화 실패");

        let cache = core.page_tree_cache.borrow();
        assert!(
            !cache.is_empty() && cache[0].is_some(),
            "레이어 트리 조회는 페이지 트리 캐시를 채워야 함"
        );
        drop(cache);

        let layer_cache = core.page_layer_tree_cache.borrow();
        assert!(
            layer_cache.contains_key(&crate::document_core::PageLayerTreeCacheKey {
                page_num: 0,
                profile: RenderProfile::Screen,
                show_paragraph_marks: false,
                show_control_codes: false,
                show_transparent_borders: false,
                clip_enabled: true,
                debug_overlay: false,
            }),
            "기본 레이어 트리 조회는 screen profile 캐시를 채워야 함"
        );
        std::env::remove_var("RHWP_RENDER_PROFILE");
    }

    #[test]
    fn test_get_page_layer_tree_native_respects_render_profile_override() {
        let Some(core) = load_document("samples/lseg-01-basic.hwp") else {
            return;
        };

        let _guard = lock_render_path_env();
        std::env::remove_var("RHWP_RENDER_PROFILE");
        let screen = core
            .get_page_layer_tree_native(0)
            .expect("기본 profile 레이어 트리 직렬화 실패");
        std::env::set_var("RHWP_RENDER_PROFILE", "fast-preview");
        let fast_preview = core
            .get_page_layer_tree_native(0)
            .expect("fast-preview 레이어 트리 직렬화 실패");
        std::env::remove_var("RHWP_RENDER_PROFILE");

        assert!(
            screen.contains("\"profile\":\"screen\""),
            "screen 기본 profile은 JSON 경계에 profile 이름을 실어야 함"
        );
        assert!(
            !screen.contains("\"cacheHint\":\"preferRaster\""),
            "screen 기본 profile은 page background를 raster 선호로 내리지 않아야 함"
        );
        assert!(
            fast_preview.contains("\"profile\":\"fast-preview\""),
            "fast-preview override는 JSON 경계에 profile 이름을 실어야 함"
        );
        assert!(
            fast_preview.contains("\"cacheHint\":\"preferRaster\""),
            "fast-preview override는 cache hint를 JSON 경계까지 노출해야 함"
        );
    }

    #[test]
    fn test_get_page_layer_tree_with_profile_native_uses_requested_profile() {
        let Some(core) = load_document("samples/lseg-01-basic.hwp") else {
            return;
        };

        let _guard = lock_render_path_env();
        std::env::set_var("RHWP_RENDER_PROFILE", "fast-preview");
        let print = core
            .get_page_layer_tree_with_profile_native(0, RenderProfile::Print)
            .expect("print profile 레이어 트리 직렬화 실패");
        let high_quality = core
            .get_page_layer_tree_with_profile_native(0, RenderProfile::HighQuality)
            .expect("high-quality profile 레이어 트리 직렬화 실패");
        std::env::remove_var("RHWP_RENDER_PROFILE");

        assert!(
            print.contains("\"profile\":\"print\""),
            "print profile 요청은 JSON에 print profile을 기록해야 함"
        );
        assert!(
            high_quality.contains("\"profile\":\"high-quality\""),
            "high-quality profile 요청은 JSON에 high-quality profile을 기록해야 함"
        );

        let layer_cache = core.page_layer_tree_cache.borrow();
        assert!(
            layer_cache.contains_key(&crate::document_core::PageLayerTreeCacheKey {
                page_num: 0,
                profile: RenderProfile::Print,
                show_paragraph_marks: false,
                show_control_codes: false,
                show_transparent_borders: false,
                clip_enabled: true,
                debug_overlay: false,
            }),
            "print profile 요청은 print 레이어 캐시를 채워야 함"
        );
        assert!(
            layer_cache.contains_key(&crate::document_core::PageLayerTreeCacheKey {
                page_num: 0,
                profile: RenderProfile::HighQuality,
                show_paragraph_marks: false,
                show_control_codes: false,
                show_transparent_borders: false,
                clip_enabled: true,
                debug_overlay: false,
            }),
            "high-quality profile 요청은 high-quality 레이어 캐시를 채워야 함"
        );
        assert_eq!(
            layer_cache.len(),
            2,
            "서로 다른 profile은 페이지별로 별도 레이어 캐시 엔트리를 가져야 함"
        );
    }

    #[test]
    fn test_empty_field_guide_is_editor_only_across_layer_profiles() {
        fn svg_text(svg: &str) -> String {
            let mut text = String::new();
            let mut rest = svg;
            while let Some(open) = rest.find("<text") {
                let after_open = &rest[open..];
                let Some(tag_end) = after_open.find('>') else {
                    break;
                };
                let body = &after_open[tag_end + 1..];
                let Some(close) = body.find("</text>") else {
                    break;
                };
                text.push_str(&body[..close]);
                rest = &body[close + "</text>".len()..];
            }
            text.chars()
                .filter(|character| !character.is_whitespace())
                .collect()
        }

        let Some(core) = load_document("samples/field-01.hwp") else {
            return;
        };

        let _guard = lock_render_path_env();
        std::env::remove_var("RHWP_RENDER_PROFILE");
        let screen = core
            .get_page_layer_tree_with_profile_native(0, RenderProfile::Screen)
            .expect("screen profile 레이어 트리 직렬화 실패");
        let fast_preview = core
            .get_page_layer_tree_with_profile_native(0, RenderProfile::FastPreview)
            .expect("fast-preview profile 레이어 트리 직렬화 실패");
        let print = core
            .get_page_layer_tree_with_profile_native(0, RenderProfile::Print)
            .expect("print profile 레이어 트리 직렬화 실패");
        let high_quality = core
            .get_page_layer_tree_with_profile_native(0, RenderProfile::HighQuality)
            .expect("high-quality profile 레이어 트리 직렬화 실패");
        let legacy_screen = core
            .render_page_svg_legacy_with_profile_native(0, RenderProfile::Screen)
            .expect("screen profile legacy SVG 렌더링 실패");
        let legacy_print = core
            .render_page_svg_legacy_with_profile_native(0, RenderProfile::Print)
            .expect("print profile legacy SVG 렌더링 실패");

        const GUIDE: &str = "여기에 입력";
        let guide_needle = GUIDE
            .chars()
            .filter(|character| !character.is_whitespace())
            .collect::<String>();
        let legacy_screen_text = svg_text(&legacy_screen);
        let legacy_print_text = svg_text(&legacy_print);
        assert!(
            screen.contains(GUIDE),
            "screen profile은 빈 누름틀 안내문을 유지해야 함"
        );
        assert!(
            fast_preview.contains(GUIDE),
            "fast-preview profile은 빈 누름틀 안내문을 유지해야 함"
        );
        assert!(
            !print.contains(GUIDE),
            "print profile은 빈 누름틀 안내문을 제거해야 함"
        );
        assert!(
            !high_quality.contains(GUIDE),
            "high-quality profile은 빈 누름틀 안내문을 제거해야 함"
        );
        assert!(
            legacy_screen_text.contains(&guide_needle),
            "profile-unaware legacy SVG의 screen 기본 동작은 안내문을 유지해야 함"
        );
        assert!(
            !legacy_print_text.contains(&guide_needle),
            "PDF와 같은 print-profile legacy SVG는 안내문을 제거해야 함"
        );
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn test_render_page_svg_with_fonts_respects_layer_svg_path() {
        let Some(core) = load_document("samples/lseg-01-basic.hwp") else {
            return;
        };
        let _guard = lock_render_path_env();
        std::env::set_var("RHWP_RENDER_PATH", "layer-svg");

        let layered = core
            .render_page_svg_layer_native(0)
            .expect("layer SVG 렌더 실패");
        let embedded = core
            .render_page_svg_with_fonts(0, crate::renderer::svg::FontEmbedMode::Style, &[])
            .expect("폰트 포함 SVG 렌더 실패");

        std::env::remove_var("RHWP_RENDER_PATH");

        let embedded_without_style = if let Some(style_start) = embedded.find("<style>") {
            if let Some(style_end) = embedded.find("</style>") {
                let mut normalized = embedded.clone();
                normalized.replace_range(style_start..style_end + "</style>".len(), "");
                normalized
            } else {
                embedded.clone()
            }
        } else {
            embedded.clone()
        };
        let normalize_svg = |svg: String| {
            svg.lines()
                .map(str::trim_end)
                .filter(|line| !line.trim().is_empty())
                .collect::<Vec<_>>()
                .join("\n")
        };

        assert_eq!(
            normalize_svg(embedded_without_style),
            normalize_svg(layered),
            "font-embed 경로도 layer-svg 선택을 존중해야 함"
        );
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn test_explicit_svg_render_paths_are_env_independent() {
        let Some(core) = load_document("samples/lseg-01-basic.hwp") else {
            return;
        };
        let _guard = lock_render_path_env();
        std::env::remove_var("RHWP_RENDER_PATH");

        let legacy = core
            .render_page_svg_legacy_native(0)
            .expect("legacy SVG 렌더 실패");
        let default = core.render_page_svg_native(0).expect("기본 SVG 렌더 실패");

        std::env::set_var("RHWP_RENDER_PATH", "layer-svg");
        let layer = core
            .render_page_svg_layer_native(0)
            .expect("layer SVG 렌더 실패");
        let env_layer = core
            .render_page_svg_native(0)
            .expect("환경 선택 SVG 렌더 실패");
        let explicit_legacy = core
            .render_page_svg_legacy_native(0)
            .expect("명시 legacy SVG 렌더 실패");

        std::env::remove_var("RHWP_RENDER_PATH");

        let normalize_svg = |svg: String| {
            svg.lines()
                .map(str::trim_end)
                .filter(|line| !line.trim().is_empty())
                .collect::<Vec<_>>()
                .join("\n")
        };

        assert_eq!(
            normalize_svg(default),
            normalize_svg(legacy.clone()),
            "기본 render_page_svg_native는 호환성을 위해 legacy SVG를 유지해야 함"
        );
        assert_eq!(
            normalize_svg(env_layer),
            normalize_svg(layer),
            "RHWP_RENDER_PATH=layer-svg는 layer SVG 경로를 선택해야 함"
        );
        assert_eq!(
            normalize_svg(explicit_legacy),
            normalize_svg(legacy),
            "명시 legacy API는 환경 변수와 무관하게 legacy 경로를 유지해야 함"
        );
    }
}
