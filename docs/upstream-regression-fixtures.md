# Upstream Regression Fixture Notes

This note tracks regression fixtures copied from upstream development branches
into `skia`. The branch is not intended to merge upstream wholesale; the goal is
to keep selected tests available while preserving the layered renderer work.

## Imported Active Tests

- `tests/issue_595.rs`: header/footer hit testing must use the logical
  header/footer page areas, not the expanded visual bbox of child nodes.
- `tests/issue_598_footnote_marker_nav.rs`: body footnote markers must behave
  as cursor units, support marker hit testing, and delete the footnote control
  without corrupting the surrounding text anchor.
- `tests/issue_630.rs`: inline right-tab leaders must align to the body right
  edge after accounting for HWP inline tab encoding.
- `tests/issue_643.rs`: the 2022 National Institute of Korean Language sample
  must keep paragraph `pi=80` on the expected page.
- `tests/issue_658_text_selection_rects.rs`: selection rectangles must choose
  the correct leading/trailing TextRun when a line boundary offset appears in
  adjacent runs.
- `tests/issue_3460_svg_picture.rs` with
  `samples/issue3460/svg_picture_repro.hwpx`: body and repeated-header SVG
  pictures must preserve `image/svg+xml`, exact nonnumeric HWPX BinData
  references, direct CanvasKit admission, and native Skia raster replay.
  The sample and behavioral intent came from upstream `e1cc64bbf`; this branch
  uses its stricter source-aware BinData resolver and shared bounded SVG image
  admission instead of copying the superseded parser implementation.

## Ported Renderer Behaviors

- Upstream `a24a6b43` table-cell paragraph numbering: the `skia` branch ports
  the renderer behavior directly into the current layout pipeline instead of
  copying the sample-dependent upstream test. Cell paragraphs with
  `head_type=Number` now pass through the same numbering marker path as body
  paragraphs, including numbering-head character style and `text_distance`
  spacing. The local synthetic guard is
  `renderer::layout::tests::test_table_cell_paragraph_numbering_marker_is_rendered`.

## Imported Browser Fixtures

The following Studio E2E files are present as manually runnable upstream
fixtures, but they are not added to the default `rhwp-studio` E2E script:

- `rhwp-studio/e2e/body-outside-click-fallback.test.mjs`
- `rhwp-studio/e2e/footnote-delete-confirm.test.mjs` (issue 598 interaction
  path confirmed manually after rebuilding `pkg/`)
- `rhwp-studio/e2e/grid-mode-click-coord.test.mjs`
- `rhwp-studio/e2e/issue-595.test.mjs`

They are useful when preparing a follow-up branch based on `skia`, but should be
added to CI only after the corresponding Studio interaction paths are confirmed
against the layered Canvas2D/CanvasKit renderers.
