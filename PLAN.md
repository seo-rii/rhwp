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
