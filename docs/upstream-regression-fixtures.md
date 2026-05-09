# Upstream Regression Fixture Notes

This note tracks regression fixtures copied from upstream development branches
into `skia`. The branch is not intended to merge upstream wholesale; the goal is
to keep selected tests available while preserving the layered renderer work.

## Imported Active Tests

- `tests/issue_595.rs`: header/footer hit testing must use the logical
  header/footer page areas, not the expanded visual bbox of child nodes.
- `tests/issue_630.rs`: inline right-tab leaders must align to the body right
  edge after accounting for HWP inline tab encoding.
- `tests/issue_643.rs`: the 2022 National Institute of Korean Language sample
  must keep paragraph `pi=80` on the expected page.
- `tests/issue_658_text_selection_rects.rs`: selection rectangles must choose
  the correct leading/trailing TextRun when a line boundary offset appears in
  adjacent runs.

## Imported Browser Fixtures

The following Studio E2E files are present as manually runnable upstream
fixtures, but they are not added to the default `rhwp-studio` E2E script:

- `rhwp-studio/e2e/body-outside-click-fallback.test.mjs`
- `rhwp-studio/e2e/footnote-delete-confirm.test.mjs`
- `rhwp-studio/e2e/grid-mode-click-coord.test.mjs`
- `rhwp-studio/e2e/issue-595.test.mjs`

They are useful when preparing a follow-up branch based on `skia`, but should be
added to CI only after the corresponding Studio interaction paths are confirmed
against the layered Canvas2D/CanvasKit renderers.

## Not Imported Yet

- `tests/issue_598_footnote_marker_nav.rs` depends on upstream native footnote
  marker APIs and document editing changes that are not yet ported to `skia`.
  Importing it as an active Rust test would break compilation. Port the
  footnote API surface first, then add the Rust fixture.

