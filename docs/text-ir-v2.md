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
features, script, language, and fallback policy. The IR now has the foundation
types for that contract (`FontBlobResource`, `FontFaceResource`,
`FontInstanceKey`, and `ShapeKey`). A guarded `TextShapeLowerer` can now append
optional `GlyphRun` variants when a resolver supplies exportable shaped glyph
data with portable or consumer-verified font eligibility. Normal exports still
emit only `TextRun`; any `GlyphRun` must remain optional and paired with
`TextRun` fallback.

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
- `TextRun.legacyVisuals`: whether legacy inline visual payloads are currently
  canonical or mirrors of future external paint ops.
- `TextRun.variant`: a variant-set metadata record. Schema v1 uses this for the
  `TextRun` default fallback. Optional `GlyphRun` alternatives share the same
  `equivalenceGroup` but use a distinct `variantId`. Future `glyphOutline`
  alternatives must follow the same rule.
- `fontResources`: a blob/face-split font resource table. It is currently empty
  in normal exports and exists so future portable `GlyphRun` variants can
  require exact font blob + face identity.
- `resources.fontBlobs`, `resources.fontBlobHashes`, and `resources.fontBlobKeys`:
  self-contained font blob payloads and producer resource fingerprints for
  `PortableBlob` entries whose `dataRef.kind` is `fontBlob`. These fields mirror
  image/SVG resource payload export for JS/CanvasKit consumers.
- `usedFeatures`: additive schema features used by this export.
- `requiredFeatures`: features a consumer must understand for faithful replay.
- `optionalFeatures`: features present in this export that have a complete
  fallback path.
- `knownFeatures`: producer-known future-compatible text features that are not
  necessarily present in this export.
- `text.defaultVariant`: currently `textRun`.
- `text.variants`: emitted visual text variants.
- `text.variantSelection`: currently `exclusiveVariantSet`, meaning consumers
  choose exactly one `variantId` per `equivalenceGroup` and paint all parts of
  that selected variant set.
- `text.fallbackRequired`: true while `TextRun` remains the public fallback.
- `text.placementAuthority`: currently `compatibilityProjection`, meaning
  `positions`/`baseline`/`rotation` remain authoritative for visual replay.
- `text.externalizedVisuals`: contains `charOverlap`, `controlMarks`,
  `tabLeaders`, or `decorations` when those visuals are emitted as explicit
  paint ops.

The source table mirrors field marker, paragraph end, and line-break end
metadata as source annotations. Visible marks are now emitted as explicit
special visual ops, with legacy `TextRun` payloads retained only as mirrors for
old consumers.

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
- `CharOverlap` is now emitted as an explicit `charOverlap` PaintOp when the
  builder sees HWP 글자겹침. The paired `TextRun.charOverlap` payload remains
  only as a legacy mirror for old consumers.
- Visible control marks are emitted as explicit `textControlMark` PaintOps when
  paragraph/control-code output options produce visible marks. The paired
  `TextRun.controlMarks` payload is a legacy mirror for old consumers.
- Tab leaders are emitted as explicit `tabLeader` PaintOps when present in a
  lowered text style. The paired `TextRun.tabLeaders` payload is a legacy
  mirror for old consumers.
- Text decorations that need backend-stable visual geometry are emitted as
  explicit `textDecoration` PaintOps. The initial externalized set covers
  underline, strikethrough, and emphasis-dot geometry. The paired
  `TextRun` style fields remain a legacy mirror for old consumers.
- While those visuals are still inside `TextRun`, `legacyVisuals` marks them
  `canonical`. Once an external op is emitted, the legacy payload must become a
  `mirror`; consumers that support the external op must not draw the mirror.
- New visual root paint ops are additive only if old consumers can skip
  unknown ops without failing. If a strict enum decoder is still in use, emit
  new visual alternatives through a sidecar/variant table or nested text variant
  field before adding root ops.
- Studio Canvas2D and CanvasKit consumers intentionally filter unknown layer
  paint ops before dispatch. This makes future root ops additive for those
  consumers, while new visual alternatives still need variant grouping to avoid
  double-painting legacy mirrors.
- Future TextRun/GlyphRun/outline alternatives must be tied together by an
  explicit variant group or a `Text { variants }` container. In schema v1,
  `equivalenceGroup` is variant-set based, not op based: consumers choose
  exactly one `variantId` per group and then draw all ops with that `variantId`.
  This is required because a future glyph variant may split into multiple
  `GlyphRun` ops for fallback fonts, bidi runs, or outline chunks. Glyph outline
  alternatives must not be exported as generic `Path` ops while TextRun fallback
  is also present, because old consumers would double-paint them.
- Schema v1 variant groups are leaf-local. All ops in one `equivalenceGroup`
  must live in the same leaf and paint-order scope, and every group must keep a
  default `TextRun` fallback. Cross-leaf or cross-clip variants require a future
  `paintOrderSlotId`/variant table design.

## Font And Shape Contract

- `FontBlobResource` describes a font blob or collection. `FontFaceResource`
  describes a concrete face inside that blob and keeps `faceIndex` explicit for
  diagnostics and backend construction.
- `PortableBlob` requires a digest and a replayable `dataRef`. It is the only
  self-contained portable font state.
- A `PortableBlob` `dataRef` may point at `resources.fontBlobs`. The JS export
  pairs that payload with `resources.fontBlobHashes`; CanvasKit registers the
  blob only when the referenced producer hash matches the `FontBlobResource`
  digest. This is still a producer resource assertion, not a substitute for
  external font verification.
- `ExternalVerified` is conditionally replayable only after the consumer
  resolves the external blob and verifies that its digest matches.
- `ResolvedButNotEmbedded`, `SystemNameOnly`, and `UnresolvedFallback` are not
  portable visual replay contracts. They may produce diagnostics-only shaping
  attempts but must keep `TextRun` fallback.
- `FontInstanceKey` contains exact face, size, variation, and synthetic style
  identity. `ShapeKey` contains shaping input such as direction, writing mode,
  script, language, OpenType features, shaping engine, and fallback policy.
- One future `GlyphRun` must refer to one actual font instance and one shape
  key. Fallback font use means split glyph runs inside the same selected
  variant set.

## CanvasKit GlyphRun Gate

CanvasKit is treated as a Skia-capable backend, but its `GlyphRun` path is more
conservative than native Skia until the browser adapter proves exact font
instantiation for the exported face:

- A `GlyphRun` is selectable only when diagnostics mark it `Exact` or gated
  `PositionAdjusted`, `strictVisualEligible=true`, and it has no missing glyphs,
  cluster mismatches, or unsplit fallback-font use.
- `PortableBlob` requires a digest, `dataRef`, and a consumer-verified font blob
  registered in the renderer cache. `ExternalVerified` is conditional: it is
  selectable only after the renderer resolves the external blob and verifies the
  digest. `ResolvedButNotEmbedded`, `SystemNameOnly`, and
  `UnresolvedFallback` always keep `TextRun` fallback.
- When a `PortableBlob` points at an exported `fontBlob` resource, CanvasKit
  registers it at `renderPage` setup time after the resource digest metadata
  matches the font resource digest. Typeface/font caches are keyed by face id,
  blob id, digest, and face index so tree-local ids cannot accidentally reuse a
  stale typeface from another export.
- The current CanvasKit adapter rejects TTC/OTC faces with `faceIndex != 0`
  because the public browser binding used here does not expose an explicit face
  selection parameter for glyph replay. It also rejects variation instances
  until variable-font instance construction is proven.
- Public glyph ids remain `u32`, but CanvasKit replay validates that every id
  fits the current `HEAPU16`/SkGlyphID path before calling `drawGlyphs`.
- Initial CanvasKit replay is fill-only: unsupported text effects such as
  underline/strike/emphasis mirrors, shadow, outline, emboss/engrave, shade
  fills, ratio scaling, color glyph mode, and per-glyph transforms disqualify
  the `GlyphRun` variant for that backend. Those runs use `TextRun` until effect
  parity fixtures explicitly enable the glyph path.
- Explicit glyph positions use `canvas.drawGlyphs`. `TextBlob.MakeFromGlyphs`
  is not used for positioned `GlyphRun` replay because it relies on font default
  advances. RSXform/TextBlob paths are future optimizations for repeated static
  text or public `MixedPerGlyph` transforms.

## Migration Phases

1. Keep `TextRun` fallback and expose `paintStyle`.
2. Promote `textSources` into `PageLayerTree` and attach per-TextRun `source`
   spans during layer tree construction.
3. Add feature metadata so consumers can avoid double-painting future variants.
4. Define TextRun v2 cluster placement and run-local placement contracts.
5. Split special visible text semantics into paint ops:
   `CharOverlap`, `TextControlMark`, `TabLeader`, and `TextDecoration` are
   implemented.
6. Add font resources with blob/face split portability state:
   `PortableBlob`, `ExternalVerified`, `ResolvedButNotEmbedded`,
   `SystemNameOnly`, or `UnresolvedFallback`.
7. Introduce a post-layout `TextShapeLowerer` skeleton that respects existing
   layout positions and reports variant quality diagnostics. `PageLayerTree`
   exposes this as an opt-in lowering pass so callers can append `GlyphRun`
   variants after layer construction without changing the default TextRun-only
   export path.
8. Add optional `GlyphRun` variants only when a portable or verified font
   instance and source cluster mapping are available. The lowerer now supports
   this gated append path, but default exports do not run a real shaping/font
   resolver yet.
9. Move shaping into layout only after line breaking, fallback metrics, vertical
   metrics, and regression fixtures are stable.

## Backend Policy

- Native Skia: preselects text variant sets before replay. It now draws
  `GlyphRun` variants when the run is strict-eligible, its `ShapeKey` resolves
  to a `PortableBlob` entry in `fontResources`, and every effect used by that
  run is covered by native glyph replay. Fill, shadow, outline, emboss, and
  engrave use native glyph/path replay; underline, strike, emphasis-dot, tab
  leader, ratio, shade, superscript, and subscript still keep the `TextRun`
  fallback. A `ConditionalExternalFont` run is not selected until a
  consumer-side font verification path exists. The selector treats `GlyphRun`
  alternatives as complete variant sets: if any part is missing or unsupported,
  the `TextRun` fallback remains selected.
- CanvasKit: pre-scans variant sets and selects `GlyphRun` only when the
  renderer has verified the exact font blob/external font, can instantiate the
  requested face, and the run passes the fill-only eligibility matrix above.
  Otherwise it replays the `TextRun` fallback.
- Canvas2D: replay `TextRun` by default. It uses the same variant-set guard but
  never selects `GlyphRun` in schema v1; glyph data is diagnostics, hit-test
  metadata, or future strict outline fallback.
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
