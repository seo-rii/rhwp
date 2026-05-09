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

`PageLayerTree` now carries an internal `textSources` table and each
`LayerTextRunPaint` may carry a `source` span into that table. The builder
creates export-local dense ids during layer tree construction so JSON, JS value,
and future backend diagnostics read the same source identity instead of
re-scanning the tree independently.

Layer JSON/JS exports currently provide:

- `textSources`: source text entries keyed by numeric id.
- `TextRun.source`: a span into `textSources`.
- `TextRun.text`: the v1 replay projection kept for Canvas2D/SVG compatibility.
- `TextRun.style`: v1-compatible style projection.
- `TextRun.paintStyle`: paint-visible style projection.
- `TextRun.projectionKind`: how the replay projection relates to the source
  text span.
- `TextRun.placement`: additive TextRun v2 run-local placement metadata.
- `TextRun.clusterBasis` and `TextRun.clusters`: additive layout/placement
  cluster metadata. These clusters are not shaped glyph clusters.
- `usedFeatures`: additive schema features used by this export.
- `requiredFeatures`: features a consumer must understand for faithful replay.
- `optionalFeatures`: features present in this export that have a complete
  fallback path.
- `knownFeatures`: producer-known future-compatible text features that are not
  necessarily present in this export.
- `text.defaultVariant`: currently `textRun`.
- `text.variants`: emitted visual text variants.
- `text.fallbackRequired`: true while `TextRun` remains the public fallback.
- `text.placementAuthority`: currently `compatibilityProjection`, meaning
  `positions`/`baseline`/`rotation` remain authoritative for visual replay.

The source table mirrors field marker, paragraph end, and line-break end
metadata as source annotations. Visible marks are still carried by existing
`TextRun.controlMarks` until special visual ops are introduced.

## Invariants

- `schemaVersion` and `resourceTableVersion` remain integer major versions for
  v1 compatibility. Additive changes use `schemaMinorVersion`,
  `resourceTableMinorVersion`, feature arrays, and optional structured
  `schema`/`resourceTable` mirrors.
- `usedFeatures` means the export actually contains the feature.
  `requiredFeatures` means a consumer should reject faithful replay if it does
  not support the feature. Future producer capability belongs in `knownFeatures`,
  not `optionalFeatures`.
- A `TextRun` source span must identify the source text slice used for search,
  accessibility, debugging, and future editing hooks.
- `TextSourceEntry.id` and `TextRun.source.id` are export-local dense ids. They
  are valid only inside one layer tree export. Future cache, diff, editing, or
  accessibility keys must use optional `stableSourceKey` plus source range and
  document revision when available.
- `TextRun.text` is a replay projection, not the long-term canonical identity.
- Source ranges are UTF-8 byte ranges. UTF-16 ranges are exported for JS/DOM
  consumers when available.
- Run positions remain v1 compatibility positions for now. TextRun v2 placement
  and clusters are additive metadata until `text.placementAuthority` changes
  from `compatibilityProjection`.
- TextRun v2 cluster origins are run-local. The local baseline is y=0, and
  `TextRunPlacement.run_to_page` maps the run into page coordinates. `PaintOp`
  bounding boxes remain page-space conservative boxes for culling and v1
  backend compatibility.
- TextRun v2 clusters are layout/placement clusters. They may be
  `LegacyPosition`, `Grapheme`, or `LayoutPlacement`. They must not be called
  shaping clusters unless a shared shaping pass proves the mapping and marks
  them `ShapingEquivalent`. `GlyphRun` uses shaped glyph clusters.
- `TextRun.text` is a visible replay projection. Ordinary text should use
  `projectionKind=verbatim` and must byte-match the source span. Normalized,
  control, field, and synthetic visual text must identify the source that
  produced it and explain the mismatch through `projectionKind`.
- One text run should have homogeneous orientation. Mixed vertical text should
  be split by layout/lowering until per-glyph transforms are introduced.
- `MixedPerGlyph` orientation is an internal reservation only. Public exports
  must keep homogeneous `Horizontal`, `VerticalUpright`, or
  `VerticalSideways` runs until glyph transforms and required feature semantics
  are fixed.
- Field marker metadata belongs to source annotations when visible marker text
  has already been lowered as ordinary text.
- Visible control marks, char overlap, tab leaders, and future decoration
  geometry should move into explicit paint ops before becoming required schema
  features.
- New visual root paint ops are additive only if old consumers can skip
  unknown ops without failing. If a strict enum decoder is still in use, emit
  new visual alternatives through a sidecar/variant table or nested text variant
  field before adding root ops.
- Studio Canvas2D and CanvasKit consumers intentionally filter unknown layer
  paint ops before dispatch. This makes future root ops additive for those
  consumers, while new visual alternatives still need variant grouping to avoid
  double-painting legacy mirrors.
- Future TextRun/GlyphRun/outline alternatives must be tied together by an
  explicit variant group or a `Text { variants }` container. Consumers must draw
  at most one variant per group. Glyph outline alternatives must not be exported
  as generic `Path` ops while TextRun fallback is also present, because old
  consumers would double-paint them.

## Migration Phases

1. Keep `TextRun` fallback and expose `paintStyle`.
2. Promote `textSources` into `PageLayerTree` and attach per-TextRun `source`
   spans during layer tree construction.
3. Add feature metadata so consumers can avoid double-painting future variants.
4. Define TextRun v2 cluster placement and run-local placement contracts.
5. Split special visible text semantics into paint ops:
   `CharOverlap`, `TextControlMark`, `TabLeader`, and later
   `TextDecoration`.
6. Add font resources with portability state:
   `PortableBlob`, `ResolvedButNotEmbedded`, `SystemNameOnly`, or
   `UnresolvedFallback`.
7. Introduce a post-layout `TextShapeLowerer` skeleton that respects existing
   layout positions and reports variant quality diagnostics.
8. Add optional `GlyphRun` variants only when a portable font instance and
   source cluster mapping are available.
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
- Treating a digest-only resolved system font as portable. A digest can verify a
  consumer-held font blob, but it is not itself a replayable font resource.
- Letting Canvas2D/SVG depend on glyph-id replay.
- Changing layout line breaking to shaped advances in the same step as export
  schema migration.
- Treating system-name-only `GlyphRun` data as portable visual replay.
