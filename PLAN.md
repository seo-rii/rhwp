# PLAN

## Goal

Work through `RISK_REGISTER.md` in order, committing and pushing completed batches on the current `skia` branch.

## Current Batch: ARCH-001

`renderPageToCanvas` should use the canonical `PageRenderTree -> PageLayerTree -> backend replay` path instead of sending `PageRenderTree` directly to `WebCanvasRenderer`.

## Steps

1. Done: add a `PageLayerTree` replay path to `WebCanvasRenderer`.
2. Done: keep the existing direct `PageRenderTree` renderer as a fallback/debug path.
3. Done: switch WASM `renderPageToCanvas` to build `PageLayerTree` with `RenderProfile::Screen`.
4. Done: verify native tests and wasm library compilation.
5. In progress: mark the corresponding risk item completion and commit/push only files changed in this batch.

## Notes

- `cargo check --target wasm32-unknown-unknown --lib` passed.
- `cargo test --lib -- --quiet` passed: 973 passed, 1 ignored.
- `cargo fmt --check` and `git diff --check` passed.
- Full wasm target check for the binary is currently blocked by pre-existing `src/main.rs` wasm-incompatible CLI code, so this batch uses `--lib` for the WASM-specific public API check.

## Current Batch: ARCH-002 / BUG-001

Reduce backend-local TextRun interpretation drift by making the first missing visible TextRun special case, `char_overlap`, render in Skia layer replay.

## Steps

1. Done: add Skia rendering for `LayerTextRunPaint::char_overlap`.
2. Done: keep normal TextRun rendering unchanged when `char_overlap` is absent.
3. Done: add and run a focused Skia PNG smoke test that exercises char overlap.
4. Done: update `RISK_REGISTER.md` with the completed portion and remaining TextRun risks.
5. Pending: commit and push only this batch's files.

## Verification

- `cargo test --features native-skia --lib renderer::skia::renderer::tests::renders_char_overlap_to_png -- --quiet` passed.
- `cargo test --features native-skia --lib renderer::skia::renderer::tests:: -- --quiet` passed.
