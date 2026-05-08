# Text IR v2 Migration Plan

This document records the current migration contract for text paint in the
layered renderer. The immediate goal is to make source identity explicit without
breaking the browser/SVG-friendly `TextRun` replay path.

## Current Position

`TextRun` remains the canonical compatibility paint contract. It carries source
text, paint-visible style, explicit positions, HWP text flags, and visible
annotation payloads that Canvas2D and SVG can replay with string APIs.

`GlyphRun` is not canonical yet. Glyph ids are meaningful only inside an exact
font instance, so portable glyph replay requires a font resource table with
exact font bytes, face index, variations, synthetic style flags, shaping
features, script, language, and fallback policy. Until that exists, `GlyphRun`
must be optional and paired with `TextRun` fallback.

## Export Contract

Layer JSON/JS exports currently provide:

- `textSources`: source text entries keyed by numeric id.
- `TextRun.source`: a span into `textSources`.
- `TextRun.text`: the v1 replay projection kept for Canvas2D/SVG compatibility.
- `TextRun.style`: v1-compatible style projection.
- `TextRun.paintStyle`: paint-visible style projection.
- `usedFeatures`: additive schema features used by this export.
- `optionalFeatures`: known future-compatible text features.
- `text.defaultVariant`: currently `textRun`.
- `text.variants`: emitted visual text variants.
- `text.fallbackRequired`: true while `TextRun` remains the public fallback.

The source table mirrors field marker, paragraph end, and line-break end
metadata as source annotations. Visible marks are still carried by existing
`TextRun.controlMarks` until special visual ops are introduced.

## Invariants

- A `TextRun` source span must identify the source text slice used for search,
  accessibility, debugging, and future editing hooks.
- `TextRun.text` is a replay projection, not the long-term canonical identity.
- Source ranges are UTF-8 byte ranges. UTF-16 ranges are exported for JS/DOM
  consumers when available.
- Run positions remain v1 compatibility positions for now. TextRun v2 should
  replace them with typed cluster placements in run-local coordinates.
- One text run should have homogeneous orientation. Mixed vertical text should
  be split by layout/lowering until per-glyph transforms are introduced.
- Field marker metadata belongs to source annotations when visible marker text
  has already been lowered as ordinary text.
- Visible control marks, char overlap, tab leaders, and future decoration
  geometry should move into explicit paint ops before becoming required schema
  features.

## Migration Phases

1. Keep `TextRun` fallback and expose `paintStyle`.
2. Add `textSources` and per-TextRun `source` spans.
3. Add feature metadata so consumers can avoid double-painting future variants.
4. Define TextRun v2 cluster placement and run-local placement contracts.
5. Split special visible text semantics into paint ops:
   `CharOverlap`, `TextControlMark`, `TabLeader`, and later
   `TextDecoration`.
6. Add font resources with portability state:
   `PortableBlob`, `ResolvedButNotEmbedded`, `SystemNameOnly`, or
   `UnresolvedFallback`.
7. Add optional `GlyphRun` variants only when a portable font instance and
   source cluster mapping are available.
8. Introduce a post-layout `TextShapeLowerer` that respects existing layout
   positions and emits diagnostic or portable `GlyphRun` variants.
9. Move shaping into layout only after line breaking, fallback metrics, vertical
   metrics, and regression fixtures are stable.

## Backend Policy

- Native Skia: prefer portable `GlyphRun` when available, otherwise replay
  `TextRun`.
- CanvasKit: prefer portable `GlyphRun` only after the same font blob is
  registered, otherwise replay `TextRun`.
- Canvas2D: replay `TextRun` by default. Use glyph data only for diagnostics,
  hit testing, or strict outline fallback.
- SVG: replay `TextRun` by default for search/accessibility. Strict visual mode
  may use glyph outline paths plus source metadata.

## Non-Goals For The Current Branch

- Removing `TextRun`.
- Making glyph ids portable without exact font resources.
- Letting Canvas2D/SVG depend on glyph-id replay.
- Changing layout line breaking to shaped advances in the same step as export
  schema migration.
