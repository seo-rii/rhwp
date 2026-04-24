# PLAN

## Goal

Work through `RISK_REGISTER.md` in order, committing and pushing completed batches on the current `skia` branch.

## Completed Batch: ARCH-001

`renderPageToCanvas` should use the canonical `PageRenderTree -> PageLayerTree -> backend replay` path instead of sending `PageRenderTree` directly to `WebCanvasRenderer`.

## Steps

1. Done: add a `PageLayerTree` replay path to `WebCanvasRenderer`.
2. Done: keep the existing direct `PageRenderTree` renderer as a fallback/debug path.
3. Done: switch WASM `renderPageToCanvas` to build `PageLayerTree` with `RenderProfile::Screen`.
4. Done: verify native tests and wasm library compilation.
5. Done: mark the corresponding risk item completion and commit/push only files changed in this batch.

## Notes

- `cargo check --target wasm32-unknown-unknown --lib` passed.
- `cargo test --lib -- --quiet` passed: 973 passed, 1 ignored.
- `cargo fmt --check` and `git diff --check` passed.
- Full wasm target check for the binary is currently blocked by pre-existing `src/main.rs` wasm-incompatible CLI code, so this batch uses `--lib` for the WASM-specific public API check.

## Completed Batch: ARCH-002 / BUG-001

Reduce backend-local TextRun interpretation drift by making the first missing visible TextRun special case, `char_overlap`, render in Skia layer replay.

## Steps

1. Done: add Skia rendering for `LayerTextRunPaint::char_overlap`.
2. Done: keep normal TextRun rendering unchanged when `char_overlap` is absent.
3. Done: add and run a focused Skia PNG smoke test that exercises char overlap.
4. Done: update `RISK_REGISTER.md` with the completed portion and remaining TextRun risks.
5. Done: commit and push only this batch's files.

## Verification

- `cargo test --features native-skia --lib renderer::skia::renderer::tests::renders_char_overlap_to_png -- --quiet` passed.
- `cargo test --features native-skia --lib renderer::skia::renderer::tests:: -- --quiet` passed.

## Current Batch: BUG-001 Output Marks

Give layer backends the same output-option context used by legacy renderers, then use it in Skia text replay for visible whitespace and paragraph/line-break marks.

## Steps

1. Done: add `LayerOutputOptions` to `PageLayerTree`.
2. Done: populate the options from `DocumentCore` when building cached layer trees.
3. Done: export the options through JSON/JS and TypeScript types.
4. Done: render Skia text control marks when the options request them.
5. Done: verify Rust/native-Skia tests and `rhwp-studio` build.
6. Done: update risk notes, commit, and push only this batch's files.

## Verification

- `cargo test --features native-skia --lib renderer::skia::renderer::tests::output_options_enable_text_control_marks -- --quiet` passed.
- `cargo test --features native-skia --lib renderer::skia::renderer::tests:: -- --quiet` passed.
- `cargo test --lib paint::json::tests::serializes_output_options_for_backend_replay -- --quiet` passed.
- `cargo check --target wasm32-unknown-unknown --lib` passed.
- `npm run build` passed in `rhwp-studio`.
- `cargo test --lib -- --quiet` passed: 974 passed, 1 ignored.
- `rustfmt --check` passed for changed Rust files.
- `git diff --check` passed for this batch's files.

## Completed Batch: BUG-007 Image Crop Fill Modes

Apply image crop source rectangles outside `fitToSize` so Skia, Canvas2D layer, and CanvasKit aligned/tiled fill modes replay the same cropped resource area instead of silently ignoring crop.

## Steps

1. Done: compute a shared crop source rect with separate x/y scaling in Skia image replay.
2. Done: use that source rect for Skia fit, aligned placement, and tile draw calls.
3. Done: apply the same source-rect handling to Canvas2D layer and CanvasKit replay.
4. Done: add a native Skia regression for crop + aligned center fill.
5. Done: run formatting/build/diff checks.
6. Done: commit and push only this batch's files.

## Verification

- `cargo test --features native-skia --lib renderer::skia::image_conv::tests::applies_crop_source_rect_to_aligned_fill_modes -- --quiet` passed.
- `cargo test --features native-skia --lib renderer::skia:: -- --quiet` passed.
- `rustfmt --check src/renderer/skia/image_conv.rs` passed.
- `cargo check --target wasm32-unknown-unknown --lib` passed.
- `npm run build` passed in `rhwp-studio`.
- `git diff --check` passed for this batch's files.

## Completed Batch: BUG-003 Risk Status

Close the stale `BUG-003` status in `RISK_REGISTER.md`; the Skia multi-line stroke renderer and regression test were already implemented.

## Verification

- `cargo test --features native-skia --lib renderer::skia::renderer::tests::renders_multi_line_type_as_separated_strokes -- --quiet` passed.

## Completed Batch: BUG-007 Crop Tile Regression

Close the code-risk portion of `BUG-007` after adding explicit native Skia coverage for crop source rect reuse in tiled fill modes. Broader HWP sample fixtures remain tracked by `TEST-006`.

## Verification

- `cargo test --features native-skia --lib renderer::skia::image_conv::tests:: -- --quiet` passed.
- `rustfmt --check src/renderer/skia/image_conv.rs` passed.
- `git diff --check` passed for this batch's files.

## Completed Batch: BUG-009 Clip Policy

Carry structural clip policy through `PageLayerTree` so Body/TableCell right-overflow slop is explicit in Rust, JSON/JS export, native Skia, SVG layer, WASM Canvas2D, and CanvasKit replay. Overflow control re-rendering still needs a separate PaintOp/lowering pass.

## Verification

- `cargo test --features native-skia --lib renderer::skia::renderer::tests::body_clip_policy_allows_right_overflow_slop -- --quiet` passed.
- `cargo test --lib paint::builder::tests::builds_body_clip_layer -- --quiet` passed.
- `cargo test --lib paint::json::tests::serializes_clip_kind_for_browser_replay -- --quiet` passed.
- `cargo check --target wasm32-unknown-unknown --lib` passed.
- `npm run build` passed in `rhwp-studio`.

## Completed Batch: BUG-009 Body Overflow Replay

Lower Body horizontal overflow controls into a sibling layer replay under a y-only, full-page-width clip so layer backends match the legacy Canvas2D re-render path for non-text controls outside the body margins.

## Verification

- `cargo test --lib paint::builder::tests::lowers_body_horizontal_overflow_controls -- --quiet` passed.
- `cargo test --lib paint::builder::tests:: -- --quiet` passed.
- `rustfmt --check src/paint/builder.rs` passed.
- `git diff --check` passed for this batch's files.

## Completed Batch: BUG-010 FormObject Replay State

Apply exported FormObject colors and enabled state in browser Canvas2D layer, CanvasKit native replay, and CanvasKit overlay replay so the Skia/browser layer paths no longer hardcode most form control colors.

## Verification

- `npm run build` passed in `rhwp-studio`.

## Completed Batch: BUG-015 Skia Dash Scale

Scale Skia dash intervals by effective stroke width so thick dashed/dotted strokes do not reuse the same fixed dash length as thin strokes. Fill/stroke independent alpha remains a model/IR semantics question because `ShapeStyle` currently exposes one shared `opacity`.

## Verification

- `cargo test --features native-skia --lib renderer::skia::paint_conv::tests::scales_dash_intervals_by_stroke_width -- --quiet` passed.
- `rustfmt --check src/renderer/skia/paint_conv.rs` passed.

## Completed Batch: BUG-016 Skia Tab Leaders

Render Skia tab leaders for skipped tab clusters using the legacy Canvas2D fill-type mapping, so tab leader marks no longer disappear when the tab glyph itself is skipped.

## Verification

- `cargo test --features native-skia --lib renderer::skia::renderer::tests::renders_tab_leaders_for_skipped_tab_clusters -- --quiet` passed.
- `cargo test --features native-skia --lib renderer::skia::renderer::tests:: -- --quiet` passed.
- `rustfmt --check src/renderer/skia/renderer.rs` passed.
- `git diff --check` passed for this batch's files.

## Completed Batch: BUG-017 Image Tile Guard Status

Add a native Skia regression for invalid image destination rects and close the stale `BUG-017` status; tile draw loops already guard invalid dimensions and cap repeated tile draws.

## Verification

- `cargo test --features native-skia --lib renderer::skia::image_conv::tests:: -- --quiet` passed.
- `rustfmt --check src/renderer/skia/image_conv.rs` passed.

## Current Batch: ARCH-003 Layer Renderer Error/Options

Replace stringly layer render errors with a structured error type and make raster rendering expose an extensible output API without removing the existing PNG convenience path.

## Steps

1. Done: add `LayerRenderError` and `LayerRenderResult` to the layer renderer contract.
2. Done: add scale, DPI, color space, format, and output metadata to raster options/output.
3. Done: route Skia PNG rendering through the generic raster output path.
4. Done: map typed layer render errors back into `HwpError::RenderError` at document API boundaries.
5. Done: verify focused native-Skia tests, lib tests, formatting, and diff checks.
6. Done: update `RISK_REGISTER.md`, commit, and push only this batch's files.

## Verification

- `cargo test --features native-skia --lib renderer::skia::renderer::tests:: -- --quiet` passed.
- `cargo test --lib -- --quiet` passed: 974 passed, 1 ignored.
- `cargo check --target wasm32-unknown-unknown --lib` passed.
- `rustfmt --check` passed for changed Rust files.
- `git diff --check` passed for this batch's files.

## Current Batch: BUG-003 Skia LineRenderType Regression

Lock the existing Skia multi-line `LineRenderType` implementation with a native regression test and mark the risk item complete.

## Steps

1. Done: add a native Skia regression that distinguishes `ThinThickThinTriple` from `Single`.
2. Done: verify the focused regression and Skia renderer test group.
3. Done: run formatting/diff checks.
4. Done: update `RISK_REGISTER.md`, commit, and push only this batch's files.

## Verification

- `cargo test --features native-skia --lib renderer::skia::renderer::tests::renders_multi_line_type_as_separated_strokes -- --quiet` passed.
- `cargo test --features native-skia --lib renderer::skia::renderer::tests:: -- --quiet` passed.
- `rustfmt --check` passed for changed Rust files.
- `git diff --check` passed for this batch's files.

## Current Batch: BUG-001 Text Marker Export

Preserve TextRun marker semantics in layer JSON/JS export and replay paragraph/control marks in the browser Canvas2D layer path from exported fields.

## Steps

1. Done: export `fieldMarker`, `shapeMarkerIndex`, `isParaEnd`, and `isLineBreakEnd` for TextRun ops.
2. Done: add matching `LayerTextRunOp` TypeScript fields.
3. Done: render Canvas2D layer whitespace and paragraph/line-break marks from exported marker fields and `outputOptions`.
4. Done: verify JSON, wasm lib, studio build, full lib tests, formatting, and diff checks.
5. Done: update `RISK_REGISTER.md`, commit, and push only this batch's files.

## Verification

- `cargo test --lib paint::json::tests::serializes_text_and_shape_ops_for_browser_replay -- --quiet` passed.

- `cargo check --target wasm32-unknown-unknown --lib` passed.
- `npm run build` passed in `rhwp-studio`.
- `cargo test --lib -- --quiet` passed: 977 passed, 1 ignored.
- `rustfmt --check` passed for changed Rust files.
- `git diff --check` passed for this batch's files.

## Current Batch: ARCH-006 Paint Visual Bounds

Separate logical paint bounds from visual paint bounds and make layer leaf/group nodes use visual bounds so future culling/cache invalidation does not clip stroke, arrow, shadow, or text decoration pixels.

## Steps

1. Done: add `PaintBounds { logical, visual }`, `paint_bounds()`, and `visual_bounds()`.
2. Done: expand visual bounds for stroke width, double/triple line spacing, arrowheads, shadows, and text decoration marks.
3. Done: keep `PaintOp::bounds()` as the logical bbox for existing replay compatibility.
4. Done: use visual bounds when lowering paint ops into layer leaf/group nodes.
5. Done: verify focused paint/builder tests, lib/wasm checks, formatting, and diff checks.
6. Done: update `RISK_REGISTER.md`, commit, and push only this batch's files.

## Verification

- `cargo test --lib paint::paint_op::tests:: -- --quiet` passed.
- `cargo test --lib paint::builder::tests::lowers_leaf_nodes_with_visual_bounds -- --quiet` passed.
- `cargo test --lib -- --quiet` passed: 977 passed, 1 ignored.
- `cargo check --target wasm32-unknown-unknown --lib` passed.
- `rustfmt --check` passed for changed Rust files.
- `git diff --check` passed for this batch's files.

## Current Batch: ARCH-005 Skia Static Picture Cache

Connect `CacheHint::StaticSubtree` to a native Skia `PictureRecorder` cache so the hint has an actual cache-backed behavior outside the browser CanvasKit path.

## Steps

1. Done: add a static picture cache to `SkiaLayerRenderer`.
2. Done: include profile, output options, scale, node fingerprint, and resource hashes in the picture cache key.
3. Done: record and reuse `StaticSubtree` groups as Skia pictures, with direct rendering fallback if recording fails.
4. Done: add and run focused Skia cache tests plus lib/wasm checks.
5. Done: update `RISK_REGISTER.md`, commit, and push only this batch's files.

## Verification

- `cargo test --features native-skia --lib renderer::skia::renderer::tests::static_subtree_hint_records_picture_cache -- --quiet` passed.
- `cargo test --features native-skia --lib renderer::skia::renderer::tests:: -- --quiet` passed.
- `cargo test --lib -- --quiet` passed: 974 passed, 1 ignored.
- `cargo check --target wasm32-unknown-unknown --lib` passed.
- `rustfmt --check` passed for changed Rust files.
- `git diff --check` passed for this batch's files.

## Current Batch: PERF-001 Skia Resource Decode Cache

Avoid repeated native Skia image/SVG raster decode work inside a single layer replay.

## Steps

1. Done: split image decode from image drawing so replay can draw already-decoded Skia images.
2. Done: cache decoded image resources in `SkiaReplayContext`, including WMF resources after conversion.
3. Done: cache rasterized equation SVG resources by `svg_resource_id` and target size.
4. Done: cache generated text symbol SVG fragments by fragment content and target size.
5. Done: add native Skia cache unit coverage.
6. Done: run final formatting, wasm, and diff checks before committing this batch.

## Verification

- `cargo test --features native-skia --lib renderer::skia::renderer::tests::replay_context_caches_decoded_image_resources -- --quiet` passed.
- `cargo test --features native-skia --lib renderer::skia::renderer::tests::replay_context_caches_rasterized_svg_resources -- --quiet` passed.
- `cargo test --features native-skia --lib renderer::skia::renderer::tests:: -- --quiet` passed.
- `cargo test --features native-skia --lib renderer::skia::image_conv::tests:: -- --quiet` passed.
- `cargo fmt --check` passed.
- `cargo check --target wasm32-unknown-unknown --lib` passed.
- `git diff --check` passed for this batch's files.

## Current Batch: TEST-005 Skia Shape Feature Fixture

Broaden native Skia shape/line regression coverage for high-risk stroke, arrow, path, and transform combinations.

## Steps

1. Done: add a synthetic fixture with triple/double lines, dash-dot strokes, and start/end arrowheads.
2. Done: include rounded rectangle, ellipse, Bezier path, SVG arc path, and connector arrow rendering.
3. Done: include rectangle and ellipse rotation/flip transforms.
4. Done: verify the focused fixture and full native Skia renderer test group.

## Verification

- `cargo test --features native-skia --lib renderer::skia::renderer::tests::renders_shape_feature_fixture_to_png -- --quiet` passed.
- `cargo test --features native-skia --lib renderer::skia::renderer::tests:: -- --quiet` passed.
- `cargo fmt --check` passed.
- `cargo check --target wasm32-unknown-unknown --lib` passed.
- `git diff --check` passed for this batch's files.

## Current Batch: TEST-003 Skia Golden Ladder Status

Close the stale Skia golden ladder risk after verifying the existing native screenshot ladder covers synthetic layer trees, layer SVG raster comparison, and actual HWP samples.

## Steps

1. Done: verify synthetic `PageLayerTree` -> native Skia PNG -> layer SVG raster comparison tests.
2. Done: verify actual HWP sample screenshot regression for basic text and table samples.
3. Done: document that broader Skia fixture specialization continues in TEST-004 through TEST-009.

## Verification

- `cargo test --features native-skia --lib renderer::layout::integration_tests::tests::test_skia_screenshot_matches_layer_svg_for_synthetic -- --quiet` passed.
- `cargo test --features native-skia --lib renderer::layout::integration_tests::tests::test_skia_screenshot_matches_layer_svg_for_basic_text_sample -- --quiet` passed.
- `cargo test --features native-skia --lib renderer::layout::integration_tests::tests::test_skia_screenshot_matches_layer_svg_for_table_sample -- --quiet` passed.

## Current Batch: TEST-004 Skia Text Feature Fixture

Broaden native Skia text regression coverage with one synthetic text fixture that exercises the high-risk text features together.

## Steps

1. Done: add a synthetic TextRun fixture covering mixed Korean/Latin/CJK/numeric text.
2. Done: include rotated text, vertical text, char overlap, superscript/subscript, underline, strike, and emphasis marks.
3. Done: verify the focused fixture and full native Skia renderer test group.

## Verification

- `cargo test --features native-skia --lib renderer::skia::renderer::tests::renders_text_feature_fixture_to_png -- --quiet` passed.
- `cargo test --features native-skia --lib renderer::skia::renderer::tests:: -- --quiet` passed.
- `cargo fmt --check` passed.
- `cargo check --target wasm32-unknown-unknown --lib` passed.
- `git diff --check` passed for this batch's files.

## Current Batch: TEST-001 LayerBuilder Totality

Make RenderNodeType lowering explicit so visual render nodes cannot silently pass through as empty groups.

## Steps

1. Done: lower `Placeholder` nodes to existing `Rectangle + TextRun` paint ops.
2. Done: lower `RawSvg` nodes through the SVG-backed replay path with bbox-local coordinate normalization.
3. Done: add a no-wildcard totality test that classifies every `RenderNodeType` as structural group, clip, or paint ops.
4. Done: run final formatting, wasm, and diff checks before committing this batch.

## Verification

- `cargo test --lib paint::builder::tests::render_node_type_lowering_is_explicit_for_all_variants -- --quiet` passed.
- `cargo test --lib paint::builder::tests:: -- --quiet` passed.
- `cargo fmt --check` passed.
- `cargo check --target wasm32-unknown-unknown --lib` passed.
- `git diff --check` passed for this batch's files.
- Full `cargo test --lib -- --quiet` was attempted and currently fails in 3 layer SVG parity tests: `test_layer_svg_matches_legacy_for_basic_text_sample`, `test_layer_svg_matches_legacy_for_table_sample`, and `test_layer_svg_screenshot_matches_legacy_for_table_sample`.

## Current Batch: TEST-002 Layer SVG Fixture Matrix

Expand legacy SVG vs layer SVG comparison beyond the original basic text/table smoke pair and make the comparison raster-based where string equality is too brittle.

## Steps

1. Done: convert the strict basic/table layer SVG comparisons to raster parity checks.
2. Done: keep exact raster parity for basic text and explicitly bound the known table clip slop diff.
3. Done: add a fixture matrix covering text style, spacing, equation, image crop, form object, and drawing group samples.
4. Done: restore full library test pass for the layer SVG parity group.

## Verification

- `cargo test --lib renderer::layout::integration_tests::tests::test_layer_svg -- --quiet` passed.
- `cargo test --lib -- --quiet` passed: 980 passed, 1 ignored.
- `cargo fmt --check` passed.
- `cargo check --target wasm32-unknown-unknown --lib` passed.
- `git diff --check` passed for this batch's files.

## Current Batch: PERF-002 Skia Plain Text Draw

Use Skia's normal text draw path for plain TextRun replay instead of turning every glyph into a path.

## Steps

1. Done: keep path rendering for outline, shadow, emboss, and engrave text effects.
2. Done: switch effect-free TextRun clusters from glyph path drawing to `canvas.draw_str`.
3. Done: add a native Skia smoke test for plain TextRun PNG output.
4. Done: run final formatting, wasm, and diff checks before committing this batch.

## Verification

- `cargo test --features native-skia --lib renderer::skia::renderer::tests::renders_plain_text_run_to_png -- --quiet` passed.
- `cargo test --features native-skia --lib renderer::skia::renderer::tests:: -- --quiet` passed.
- `cargo fmt --check` passed.
- `cargo check --target wasm32-unknown-unknown --lib` passed.
- `git diff --check` passed for this batch's files.

## Current Batch: TEST-006 Image Fixture Coverage

Expand native Skia-vs-layer-SVG image regression coverage for crop, effects, fill modes, and transforms.

## Steps

1. Done: extend the synthetic image fill-mode fixture with crop only-x, crop only-y, crop both, grayscale/blackwhite/pattern effect, tile/center/fit modes, transparent image over background, and rotation/flip.
2. Done: fix the Skia blackwhite image effect threshold exposed by the expanded fixture.
3. Done: make SVG image replay apply crop viewBox for positioned and tiled fill modes.
4. Done: run focused native-Skia parity and image conversion tests.

## Verification

- `cargo test --features native-skia --lib renderer::layout::integration_tests::tests::test_skia_screenshot_matches_layer_svg_for_synthetic_image_fill_modes -- --quiet` passed.
- `cargo test --features native-skia --lib renderer::skia::image_conv::tests:: -- --quiet` passed.
- `cargo test --features native-skia --lib renderer::layout::integration_tests::tests::test_skia_screenshot_matches_layer_svg_for_synthetic_page_background_image -- --quiet` passed.

## Current Batch: TEST-007 Clip Overflow Fixture

Add a native Skia-vs-layer-SVG synthetic fixture for Body/TableCell clip policy and horizontal overflow replay.

## Steps

1. Done: build a synthetic page with Body right-overflow slop, a body-level overflow control, and TableCell clip slop.
2. Done: verify the focused native-Skia parity fixture and existing clip unit tests.
3. Pending: run formatting, wasm, and diff checks.
4. Pending: update `RISK_REGISTER.md`, commit, and push only this batch's files.

## Verification

- `cargo test --features native-skia --lib renderer::layout::integration_tests::tests::test_skia_screenshot_matches_layer_svg_for_synthetic_clip_overflow -- --quiet` passed.
- `cargo test --features native-skia --lib renderer::skia::renderer::tests::body_clip_policy_allows_right_overflow_slop -- --quiet` passed.
- `cargo test --lib paint::builder::tests::lowers_body_horizontal_overflow_controls -- --quiet` passed.
- `cargo test --lib paint::builder::tests::preserves_leaf_payloads -- --quiet` passed.

## Current Batch: TEST-008 Pattern Gradient Fixture

Add native Skia-vs-layer-SVG regression coverage for pattern and gradient mapping.

## Steps

1. Done: add a synthetic fixture covering pattern types 0..5 and gradient types 1..4.
2. Done: align SVG gradient type 3/4 replay with Skia/Canvas radial handling.
3. Done: verify focused native-Skia parity and existing layer SVG fixture coverage.
4. Pending: run final formatting/wasm/diff checks and push this batch.

## Verification

- `cargo test --features native-skia --lib renderer::layout::integration_tests::tests::test_skia_screenshot_matches_layer_svg_for_synthetic_pattern_gradient_matrix -- --quiet` passed.
- `cargo test --features native-skia --lib renderer::layout::integration_tests::tests::test_skia_screenshot_matches_layer_svg_for_synthetic_shapes -- --quiet` passed.
- `cargo test --lib renderer::layout::integration_tests::tests::test_layer_svg_fixture_matrix_rasterizes_against_legacy -- --quiet` passed.

## Current Batch: TEST-009 Resource Cache Regression

Add repeated-resource regression coverage for native Skia decode/raster cache behavior.

## Steps

1. Done: add a repeated image/SVG resource cache test that simulates 100 repeated uses.
2. Done: verify the focused native-Skia cache tests.
3. Pending: run formatting, wasm, and diff checks.
4. Pending: update `RISK_REGISTER.md`, commit, and push only this batch's files.

## Verification

- `cargo test --features native-skia --lib renderer::skia::renderer::tests::replay_context_keeps_repeated_resource_caches_bounded -- --quiet` passed.
- `cargo test --features native-skia --lib renderer::skia::renderer::tests::replay_context_caches -- --quiet` passed.

## Current Batch: TEST-010 Feature Matrix CI

Add lightweight Cargo feature matrix checks to regular CI.

## Steps

1. Done: inspect existing CI coverage for default, native-skia, WASM build, and screenshot sweep.
2. Done: add a `feature-matrix` job for default lib, no-default-features lib, and wasm32 lib checks.
3. Done: verify the same Cargo commands locally.
4. Pending: run final formatting/diff checks, update `RISK_REGISTER.md`, commit, and push.

## Verification

- `cargo check --lib` passed.
- `cargo check --no-default-features --lib` passed.
- `cargo check --target wasm32-unknown-unknown --lib` passed.
