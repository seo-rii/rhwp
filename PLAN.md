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
