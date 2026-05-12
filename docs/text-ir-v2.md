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
  `equivalenceGroup` but use a distinct `variantId`.
- `glyphOutline` ops: optional strict-visual outline alternatives. They are
  explicit text variants with source, variant metadata, paint style, placement,
  outline path payloads, and diagnostics. They are never serialized as generic
  `Path` ops while `TextRun` fallback is present.
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
- TextRun/GlyphRun/outline alternatives must be tied together by an
  explicit variant group or a `Text { variants }` container. In schema v1,
  `equivalenceGroup` is variant-set based, not op based: consumers choose
  exactly one `variantId` per group and then draw all ops with that `variantId`.
  This is required because a future glyph variant may split into multiple
  `GlyphRun` ops for fallback fonts, bidi runs, or outline chunks. Glyph outline
  alternatives are exported as explicit `glyphOutline` ops, not generic `Path`
  ops, while TextRun fallback is also present, because old consumers would
  double-paint generic paths.
- Schema v1 variant groups are leaf-local. All ops in one `equivalenceGroup`
  must live in the same leaf and paint-order scope, and every group must keep a
  default `TextRun` fallback. Cross-leaf or cross-clip variants require a future
  `paintOrderSlotId`/variant table design.
- Schema v2 is now the Phase 2 envelope for that future design rather than a
  late cleanup. It should introduce a canonical `PaintOp::Text { variants }`
  text paint slot, `paintOrderSlotId`, explicit fallback policy, and feature
  gates for strict/fallback-free text, cross-scope variants, richer
  `GlyphOutline` payloads, shapedModern layout authority, and public
  mixed-per-glyph orientation. The v2 reader/validator should land before broad
  writer enablement; v1 compatibility export remains available.
- In schema v2, `anchorOpId` is a v1 bridge concept. The `Text` op itself owns
  the paint slot through `paintOrderSlotId`; compatibility downgrades may
  flatten the text container back into v1 root `TextRun` plus optional
  variant-group ops.

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
- `PositionAdjusted` is gated by strict residual tolerance before replay. The
  current screen tolerance is `min(0.5px, max(0.25px, fontSizePx * 0.005))`;
  over-tolerance runs keep `TextRun` fallback.
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
- Initial CanvasKit replay supports fill, the same simple offset shadow pass
  used by its `TextRun` path, and the matching outline/stroke pass. Unsupported
  text effects such as underline/strike/emphasis mirrors, emboss/engrave, shade
  fills, ratio scaling, color glyph mode, and per-glyph transforms still
  disqualify the `GlyphRun` variant for that backend. Those runs use `TextRun`
  until effect parity fixtures explicitly enable the glyph path.
- CanvasKit fallback diagnostics use effect-specific reason strings
  (`glyphRunUnderlineUnsupported`, `glyphRunStrikethroughUnsupported`,
  `glyphRunEmphasisUnsupported`, `glyphRunRatioUnsupported`,
  `glyphRunEmbossUnsupported`, `glyphRunEngraveUnsupported`,
  `glyphRunShadeUnsupported`) so each effect can be promoted independently once
  a parity fixture covers it.
- Explicit glyph positions use `canvas.drawGlyphs`. `TextBlob.MakeFromGlyphs`
  is not used for positioned `GlyphRun` replay because it relies on font default
  advances. RSXform/TextBlob paths are future optimizations for repeated static
  text or public `MixedPerGlyph` transforms.

## GlyphRun Parity Fixture Milestone

The next milestone is limited to `GlyphRun` replay parity and fallback
fixtures. It must not change layout measurement, line breaking, fallback
metrics, vertical metrics, or HWP-compatible text placement. Existing layout
positions remain authoritative; `GlyphRun` variants are optional visual
alternatives selected only when the backend can replay them safely.

The milestone is successful when the following contracts are covered by
fixtures:

- Portable font resources refer to the same font bytes and exact face that the
  backend instantiates.
- Variant selection suppresses the `TextRun` fallback only when the selected
  `GlyphRun` variant set is complete and supported.
- CanvasKit remains more conservative than native Skia and falls back whenever
  exact font, glyph id, or paint-effect eligibility is not proven.
- Unsafe cases do not silently draw a wrong glyph stream; they keep `TextRun`
  fallback and expose deterministic diagnostics or selection state.
- Variant grouping is tested as a set-level rule: one `variantId` is selected
  per `equivalenceGroup`, and every op part with that selected `variantId` is
  replayed.

### P0 Fixtures

P0 fixtures are required before treating the `GlyphRun` replay path as stable:

- `glyphrun_native_fill_exact_font`: native Skia replays an exact-quality,
  portable, fill-only `GlyphRun`.
- `glyphrun_canvaskit_fill_exact_font`: CanvasKit verifies the same single-face
  font blob and reaches the `drawGlyphs` path.
- `glyphrun_explicit_positions`: glyph ids and run-local positions are asserted
  exactly, with v1 `TextRun` placement still authoritative for layout.
- `glyphrun_variant_set_multipart`: a selected variant set can contain multiple
  parts, and all parts are painted together.
- `glyphrun_unsupported_effect_falls_back`: unsupported CanvasKit effects keep
  `TextRun` fallback.
- `glyphrun_digest_mismatch_falls_back`: font blob digest mismatch keeps
  `TextRun` fallback.
- `glyphrun_non_portable_font_falls_back`: `ResolvedButNotEmbedded`,
  `SystemNameOnly`, and `UnresolvedFallback` resources never become default
  glyph replay.
- `glyphrun_canvaskit_glyph_id_out_of_range_falls_back`: public `u32`
  glyph ids outside the current CanvasKit `u16` path are rejected before replay.
- `glyphrun_native_canvaskit_fill_png_fuzzy`: native Skia and CanvasKit render
  the same eligible fill-only glyph fixture within a small image tolerance.

P0 uses `Exact` quality only. `PositionAdjusted` positive replay,
bidi/vertical matrices, color glyphs, and glyph outline strict visual output are
P1.5/P2 work.

### P1a Fixtures

P1a keeps the scope on replay-contract hardening rather than typography
expansion:

- synthetic fallback-font split: one selected `glyphRun` variant may contain
  multiple parts that point at different exact font faces.
- duplicate variant part rejection: a `variantId` with repeated `partIndex`
  values is incomplete/invalid even when `partCount` would otherwise look
  satisfied.
- CanvasKit unsupported capability fallback: variation instances and non-zero
  `faceIndex` font faces keep `TextRun` fallback until the adapter proves exact
  variation/collection-face construction.
- `PositionAdjusted` negative fixture: residuals above the strict page-space
  tolerance keep `TextRun` fallback.

### P1b / P1.5 Follow-Up

P1b extends the exact-quality fixture set with small independent cases for bidi
split, vertical-upright, and vertical-sideways `GlyphRun` replay. These tests
keep the same schema v1 contract: source/logical order comes from
`TextSourceSpan`/cluster ranges, visual paint order comes from the leaf op
stream, and each exported glyph run remains homogeneous in direction, bidi
level, writing mode, and orientation. `MixedPerGlyph` remains internal-only.

P1.5 adds positive `PositionAdjusted` replay for native Skia and CanvasKit when
the residual stays within the strict page-space tolerance. Expanded native Skia
vs CanvasKit fuzzy PNG matrices remain a renderer-sweep follow-up. Shaped
measurement and line breaking remain outside this milestone.

### Fixture Font Policy

Portable glyph replay fixtures must use a checked-in, small, single-face TTF or
OTF fixture with a clear license, fixed digest, and expected face metadata.
System fonts installed by CI are not portable fixture inputs. They may be used
only for negative or diagnostic cases where the expected result is `TextRun`
fallback.

P0 must not use TTC/OTC collections or variable fonts for CanvasKit strict
replay. Even `faceIndex == 0` TTC/OTC data remains ineligible until the
CanvasKit adapter proves explicit face selection. Variable font instances are
also ineligible until the adapter proves exact variation construction.

### Parity And Tolerance Policy

Schema-level and selection-level assertions should be exact:

- selected `variantId`
- glyph ids
- glyph position arrays, allowing only small floating point epsilon where the
  export format requires it
- fallback reason or replay eligibility
- variant part completeness

Native Skia vs CanvasKit PNG comparison should be fuzzy, not exact. Even
fill-only glyphs may differ slightly because the rasterizers, antialiasing, and
font rendering settings are not guaranteed to produce byte-identical pixels.
Initial P0 PNG comparison should crop to the glyph visual region and allow a
small per-channel and differing-pixel threshold. Same-backend deterministic
rerender tests may still use exact image comparison.

### PositionAdjusted Policy

`PositionAdjusted` is a strict candidate only after the normal `Exact` replay and
fallback contracts are stable. P1 keeps both sides of the gate small: residuals
above tolerance fall back to `TextRun`, while P1.5 accepts in-tolerance
`PositionAdjusted` runs for native Skia and CanvasKit. Positive replay must pass
the existing hard gates: portable or verified font, complete source coverage, no
missing glyphs, no cluster mismatch, explicit final glyph positions, no unsplit
fallback font, no unsupported paint effects, and residuals within the configured
page-space tolerance. The canonical fast-path gate is page-space residual;
device-space residual remains a raster/parity diagnostic until the PNG matrix is
stable.

### CI Placement

The fast CI path should keep these checks small:

- Rust unit tests: variant set selection, font digest mismatch,
  non-portable fallback, unsupported-effect fallback, and CanvasKit glyph-id
  range guard. P1a adds duplicate-part rejection, synthetic fallback-font split,
  and over-tolerance `PositionAdjusted` fallback. P1.5 adds in-tolerance
  `PositionAdjusted` selection.
- Native Skia tests: fill-only `GlyphRun`, explicit positions, and unsupported
  effect fallback, plus small `PositionAdjusted` positive/negative coverage.
- Studio/CanvasKit E2E: one eligible fill-only glyph replay, one digest
  mismatch fallback, one unsupported-effect fallback, and small negative
  capability probes for unsupported variations, font collection face index, and
  over-tolerance `PositionAdjusted`. P1.5 adds one in-tolerance
  `PositionAdjusted` replay probe.

Native Skia vs CanvasKit PNG fuzzy parity and larger matrices should start in a
renderer sweep or nightly-style job, then move into the fast path only after
flakiness and runtime are understood.
The full renderer baseline now writes a report-only
`native-canvaskit-parity-report.json` and mirrors its summary into
`baseline-report.md`; this artifact is observational data for threshold tuning,
not a pass/fail gate for the fast path. It records per-profile/per-sample
summaries and the highest-delta comparisons so larger nightly matrices can be
triaged without promoting them to PR gates.

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
9. Add the `glyphOutline` variant contract as an explicit strict-visual text
   alternative. The schema/export surface exists, but default renderers still
   choose `TextRun`/`GlyphRun`; outline replay/export profiles remain future
   work. `glyphOutline` variants carry `anchorOpId` metadata so a sidecar
   outline can reuse the anchored `TextRun` paint-order slot without being
   exported as an ordinary `Path`.
10. Expand `GlyphRun` parity fixtures for exact-quality, portable, fill-only
    replay. This phase covers native Skia, CanvasKit, fallback gates,
    multi-part variant sets, glyph-id range guards, and fuzzy cross-backend PNG
    comparison. It does not change layout measurement.
11. Move shaping into layout only after line breaking, fallback metrics, vertical
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
  requested face, and the run passes the fill/shadow/outline eligibility matrix
  above. Otherwise it replays the `TextRun` fallback.
- Canvas2D: replay `TextRun` by default. It never selects `GlyphRun` in schema
  v1. An explicit strict outline profile may select `glyphOutline` variants and
  replay their run-local paths through Canvas 2D path fill; otherwise
  `TextRun` remains selected.
- SVG: replay `TextRun` by default for search/accessibility. Strict visual mode
  may select explicit `glyphOutline` variants plus source metadata and emit
  `<path data-rhwp-*>` elements at the anchored text paint slot. Strict SVG
  output includes a `<metadata id="rhwp-text-sources" type="application/json">`
  text-source sidecar and keeps per-path source/glyph provenance attributes.
  It must not reinterpret those outlines as ordinary `Path` fallback while
  `TextRun` is present.

## GlyphOutline Sidecar Contract

`GlyphOutline` is a strict-visual text alternative, not a generic vector shape.
Schema v1 keeps the `TextRun` fallback in the root paint stream and allows
outline payloads to live as sidecar variants. A sidecar outline uses
`variant.anchorOpId` to point at the root text op whose paint-order slot it
replaces. Within that slot, `localPaintOrder` is an optional stable order for
multi-part outline payloads.

Schema-v1 text variant ops carry stable additive `id` fields so sidecars can
anchor without relying on array position. The fallback `TextRun` id is
`op-<equivalenceGroup>`, and non-default text variant parts use
`op-<equivalenceGroup>-<variantId>-<partIndex>`.

The current writer may still emit `glyphOutline` in the root op stream because
it is an explicit text variant, not a generic `Path`. The future `variantOps`
migration should be dual-reader / single-writer: readers accept both root
`glyphOutline` ops and sidecar `variantOps` outlines, while a writer emits a
given outline in exactly one location in a single export. Richer outline
payloads should move to `variantOps` before color, bitmap, SVG-in-font, or
other strict-only payloads are introduced. This does not introduce
`paintOrderSlotId`; in schema v1, `anchorOpId` remains the paint-order slot
until cross-leaf, cross-scope, or anchorless strict exports are required.
Phase 2 starts this migration as a reader/scaffold only: Studio consumers and
Rust `PageLayerTree` exports accept a top-level `variantOps` array, attach
sidecar text variants to the leaf that contains the referenced anchor op id,
and ignore duplicate sidecar parts when the same variant part already exists in
the root stream. The default Rust writer still emits the current root
`glyphOutline` representation until a richer outline payload needs the sidecar
writer. Future writers that emit sidecar payloads should declare
`text.variantOps` as an additive feature. Schema-v2 compatibility export
absorbs sidecar variants into the canonical `Text` op rather than re-emitting a
top-level `variantOps` array.

The first richer payload discriminator is reserved but not replay-enabled:
`payloadKind: "monochromeFill"` is the only schema-v1 replay-eligible outline
payload. `payloadKind: "monochromeFillStroke"` is schema vocabulary for the
first richer outline payload: it must carry an explicit `stroke` object, and the
v2 validator only accepts the initial supported subset behind the richer-outline
feature gate. That subset is finite positive stroke width, solid stroke color,
finite non-negative optional miter limit, `join: "miter"`, `cap: "butt"`, and
`paintOrder: "fillThenStroke"`. Renderers may still reject it with
`unsupportedOutlinePayload` until stroke bbox inflation, SVG/Canvas2D/native
fixtures, and fuzzy parity thresholds are fixed.

The current validator keeps this conservative:

- every variant in an `equivalenceGroup` remains in one leaf / paint-order
  scope;
- consumers choose exactly one `variantId` per group and paint every selected
  part;
- `glyphOutline` variants must carry `anchorOpId`;
- schema v1 `glyphOutline` replay is monochrome fill-only:
  `payloadKind: "monochromeFill"` may use fill color, path `fillRule`,
  run-local outline paths, and source mapping;
- `payloadKind: "monochromeFillStroke"` is reserved for the v2 richer-outline
  gate and must include a supported `stroke` object before a validator may treat
  it as well-formed;
- each outline path carries `glyphId`, `glyphRange`, and a UTF-8 source range
  so SVG/Canvas2D strict replay can keep path-level provenance for debugging,
  search sidecars, and accessibility sidecars;
- `glyphOutline` rejects text effects and non-outline glyph formats until each
  has a strict profile. Shadow, stroke/outline, emboss/engrave,
  underline/strike/emphasis, tab leaders, ratio/shade adjustments, color glyphs,
  bitmap glyphs, and SVG-in-font glyphs are not outline-eligible in the first
  profile;
- `glyphOutline` must never be exported as an already-known generic `Path`
  while a `TextRun` fallback exists.

`paintOrderSlotId` is reserved for a later schema step if variants need to cross
leaf, clip, transform, or cache boundaries. Until then, `anchorOpId` plus the
same-leaf invariant is the compatibility contract.

Current SVG/Canvas2D fixtures assert the conservative profile directly:
default profile selects `TextRun`, strict profile selects `glyphOutline`,
unsupported payload/style falls back to `TextRun` with deterministic reject
reasons, and part-level replay reports preserve the selected variant set.

## Backend Variant Selection Reports

Variant selection is backend-local. The same layer export may select `GlyphRun`
in native Skia, fall back to `TextRun` in CanvasKit, and keep `TextRun` as the
default in Canvas2D/SVG. Renderers that evaluate optional visual variants should
therefore expose a report separate from the immutable layer export:

- `backend` and `renderProfile`;
- `equivalenceGroup`;
- selected `variantId`, selected variant kind, and selected reason
  (`glyphRunStrictEligible`, `glyphOutlineStrictProfile`,
  `defaultTextRunFallback`, or `noSupportedVariant`);
- `anchorOpId`, `partsExpected`, and `partsReplayed` so sidecar variants and
  multi-part variant sets can be audited;
- rejected variant ids with stable reasons such as `fontDigestMismatch`,
  `fontNotPortable`, `externalFontNotVerified`, `exactFaceUnavailable`,
  `faceIndexUnsupported`, `variationUnsupported`, `glyphIdOutOfRange`,
  `missingGlyph`, `clusterMismatch`, `incompleteVariantSet`,
  `unsupportedPaintEffect`, `unsupportedOutlinePayload`,
  `unsupportedColorGlyph`, `unsupportedBitmapGlyph`, `unsupportedSvgGlyph`,
  `positionAdjustedResidualTooLarge`, or `backendDoesNotSupportVariant`;
- per-part replay status for multi-part variant sets;
- optional font verification and outline eligibility details when a backend
  evaluated `GlyphRun` or `GlyphOutline` candidates.

CanvasKit also reports the eligibility gates that matter for portable glyph
replay: digest match, exact face instantiation, face-index support, variation
support, and effect support. These are render diagnostics, not schema fields,
because `ExternalVerified` fonts and backend capabilities are resolved at render
time. Unsupported CanvasKit runs must select the `TextRun` fallback instead of
painting an approximate glyph stream.

The Studio selector uses the same report shape for CanvasKit and Canvas2D strict
outline replay. Canvas2D reports `GlyphRun` rejection as
`backendDoesNotSupportVariant`, and reports `GlyphOutline` rejections as
`unsupportedOutlinePayload`, `unsupportedPaintEffect`, or
`backendDoesNotSupportVariant` depending on the strict replay gate. Native Skia
and SVG expose the same selected/rejected reason vocabulary through backend-local
render diagnostics, so the same export can explain why native Skia selected
`GlyphRun`, SVG default selected `TextRun`, or SVG strict selected
`GlyphOutline`.

## Layout Profile Contract

Text IR v2 separates renderer migration from layout migration. The default
schema v1 layout policy is:

```json
{
  "layout": {
    "profile": "hwpCompat",
    "measurementAuthority": "legacyHwpPositions",
    "shapedMeasurement": "diagnosticsOnly"
  }
}
```

`hwpCompat` means existing HWP-compatible layout positions, line segmentation,
and pagination remain authoritative. `TextShapeLowerer` may append optional
visual variants and diagnostics, but it must not change measurement or line
breaking.

`shapedModern` is reserved for a future opt-in profile where shaped advances may
drive measurement and line breaking. That profile must ship with separate corpus
reports and reference expectations; it must not become the default as part of
GlyphRun/GlyphOutline renderer work. Until then, shaped measurement deltas are
diagnostics or shadow reports, not CI gates for the compatibility renderer.
The current report-only hook records run-level shaped measurement observations
when `TextShapeLowerer` obtains shaped data: legacy width from existing TextRun
positions, shaped width from explicit glyph positions/advances, delta, cluster
mismatch count, fallback-font difference, and quality. Line-level
aggregation is also report-only: callers may group already-collected run
measurements into line summaries with legacy/shaped width totals, max run delta,
and mismatch/fallback counters. Callers may also group line summaries into
paragraph and page summaries with counts, maximum deltas, total absolute deltas,
and mismatch/fallback counters. These summaries do not infer line membership,
paragraph membership, page membership, or decide `lineBreakWouldChange`; those
remain out of scope until the layout migration milestone because they need
paragraph/container context. `TextShapeReport` can serialize these observations
as a standalone shaped-measurement JSON artifact; that artifact is telemetry for
local/nightly migration analysis and is not part of the layer replay schema.

## Schema v1 Closure Criteria

Schema v1 should close as a compatibility-safe text replay schema:

- `TextRun` remains the root fallback and public compatibility contract.
- `TextSourceTable`, `TextSourceSpan`, `TextRun` placement, and layout-cluster
  metadata stay additive and source-backed.
- visible special text semantics stay explicit paint ops or legacy mirrors:
  `CharOverlap`, `TextControlMark`, `TabLeader`, and `TextDecoration`.
- font blob, face, instance, and shape identity stay explicit before portable
  `GlyphRun` replay is selected.
- `GlyphRun` and `glyphOutline` remain optional text variants with `TextRun`
  fallback in schema v1 exports.
- variant selection stays set-based: one `variantId` per `equivalenceGroup`,
  then all parts of that variant are replayed.
- backend-local `VariantSelectionReport` remains the way to explain selected and
  rejected variants; the export itself is producer-side and immutable.
- CanvasKit remains conservatively gated by exact face/font support, glyph id
  range, explicit positions, and effect-specific eligibility.
- shaped measurement remains report-only telemetry outside the replay schema.

Schema v1 minor 10 exports advertise the v2 direction without changing replay
semantics. They keep `schemaVersion=1`, add only producer-known v2 feature names
to `knownFeatures`, and include `textV2` metadata with
`profile="compatibility"`, `canonicalOp="text"`, `fallbackPolicy="required"`,
`strictVisualFallbackFree=false`, and `paintOrderSlots="reserved"`. This tells
readers that the producer understands the Phase 2 text envelope while current
v1 writers still emit flattened `TextRun`/`GlyphRun`/`glyphOutline` ops.

Schema v2 is the Phase 2 envelope for larger changes: `PaintOp::Text {
variants }`, fallback-free text exports, cross-scope variants,
`paintOrderSlotId`, richer `GlyphOutline` payload kinds, public
mixed-per-glyph orientation, and shapedModern layout metadata. Those features
remain profile/feature gated even after the schema shape exists.

## Phase 2 Entry Gate

Phase 2 should not start by adding new payload expressiveness. It starts only
after schema v1 is closed and the compatibility contracts above are stable in
tests and renderer reports.

The v1 closeout gate is:

- exports keep `text.fallbackRequired=true`, `requiredFeatures=[]`, and
  `TextRun` as the default text variant;
- optional `GlyphRun` and `glyphOutline` variants never remove the root
  `TextRun` fallback in schema v1;
- `glyphOutline` remains an explicit text variant, not a generic `Path`, and
  schema-v1 writers only emit `variantOps` for explicit sidecar payloads and
  still do not emit `paintOrderSlotId`;
- `glyphOutline` requires `anchorOpId`, a same-leaf text fallback, path-level
  source/glyph provenance, and monochrome fill-only style eligibility;
- backend `VariantSelectionReport` remains the source of truth for why a
  backend selected or rejected `TextRun`, `GlyphRun`, or `glyphOutline`;
- native-vs-CanvasKit parity matrices stay report-only until thresholds and
  flakiness are understood;
- shaped measurement stays telemetry outside the replay schema and does not
  infer `lineBreakWouldChange`. When line-level context is incomplete,
  diagnostics may record `lineBreakRisk`/`lineBreakShadows` values such as
  `insufficientContext`, but those reports remain telemetry rather than layout
  authority.

Phase 2 now opens schema v2 early, but still chooses one explicit emission axis
at a time. The preferred order is:

- schema v2 root/profile metadata, `PaintOp::Text { variants }`, and
  `paintOrderSlotId` reader/validator;
- v1-to-v2 lowering and v2-to-v1 downgrade only when a `TextRun` fallback and
  same-scope variants make the downgrade faithful;
- v2 compatibility writer as an opt-in path with `TextRun` fallback required;
- strictVisual writer only when required features are complete and
  `fallbackPolicy=none` is explicitly requested;
- richer `GlyphOutline` payload design, starting with a stroke subset only if
  bbox inflation, fill/stroke order, SVG/Canvas2D/native fixtures, and reject
  reasons are fixed;
- small CanvasKit color-glyph smoke tests that do not change `GlyphOutline`;
- shapedModern layout work as a separate opt-in layout migration milestone.

The Studio reader accepts the first v2 text envelope shape by expanding a
`text` paint op into its concrete `TextRun`, `GlyphRun`, and `GlyphOutline`
variant payloads before running the existing variant-set selection logic. This
keeps the reader ahead of the writer while preserving v1 replay behavior.
Rust lowering mirrors that direction with a compatibility scaffold that groups
schema-v1 flattened text variants into `LayerTextPaintOpV2` slots at leaf or
tree scope. The scaffold preserves first-seen group order, collects variant-set
parts under one paint slot, and keeps writer enablement separate from the v1
replay path.
`lower_v1_leaf_text_variants_with_sidecars_to_v2()` is the reader-side
`variantOps` scaffold: it combines root leaf text variants with sidecar text
variants and ignores duplicate sidecar parts when the root stream already
contains the same `(equivalenceGroup, variantId, partIndex)`.
`PageLayerTree::text_v2_slots()` and `validate_text_v2_slots()` expose that
scaffold as the future writer/diagnostics entrypoint.
`PageLayerTree::to_json_v2_compat()` is the first opt-in writer path: it keeps
the HWP-compatible layout and `TextRun` fallback policy, emits schemaVersion 2,
requires `text.variants` and `text.paintOrderSlot`, and wraps flattened v1 text
variant groups into canonical `type: "text"` envelopes.
`page_layer_tree_to_js_value_v2_compat()` mirrors that opt-in envelope for
direct WASM object exports, so Studio-side consumers can validate v2 text slots
without going through stringified JSON.
The public wasm/native API exposes this opt-in path as
`getPageLayerTreeV2Compat*` and `getPageLayerTreeValueV2Compat*`; existing v1
`getPageLayerTree*` calls remain unchanged.
`text_v2_validation_issues_to_js_value()` exposes the same validator issue
vocabulary to JS callers when an opt-in v2 export is rejected.
`text_v2_validation_issues_to_json()` exposes that same issue shape for string
JSON APIs, so validation failures use the same machine-readable codes instead
of debug-formatted Rust structs.
`downgrade_text_v2_op_to_v1_compat()` is the first downgrade scaffold: it
flattens a validated v2 text slot back into v1 text variant ops only when the
slot still has the required `TextRun` fallback and current v1 payload kinds.
`GlyphOutline.payloadKind` is currently `monochromeFill`; it exists so later
stroke, color-layer, bitmap, or SVG glyph payloads can be feature-gated without
overloading the first fill-only path representation. Reserved payload kinds are
defined as schema vocabulary but are rejected by the compatibility validator
until their strict profile and feature gates land. The v2 validator reports
`glyphOutlinePayloadKindFeatureMissing` for those richer payloads unless the
caller explicitly enables that future feature gate. For
`monochromeFillStroke`, the validator also reports
`glyphOutlineStrokeStyleUnsupported` unless the payload carries the supported
initial stroke subset.
The Rust validator mirrors the first Studio diagnostics pass for those
scaffolded slots: it checks paint-order slot presence, default/fallback policy,
duplicate variant ids, complete part sets, and fallback-free gating before any
v2 writer can treat the slot as exportable. The collection validator also
rejects duplicate `paintOrderSlotId` values across text slots, matching the v2
paint-order invariant that each text envelope owns one unique paint slot.
The first validator pass is backend-local diagnostics rather than writer
enforcement: renderers report missing default variants, missing required
TextRun fallback, duplicate paint-order slots, duplicate or incomplete parts,
payload-kind mismatches, ungated cross-scope parts, reserved stroke payloads,
and public `MixedPerGlyph` orientation without their required feature.
Compatibility profile writers should treat those issues as hard errors before
emitting schema v2 by default.
`TextVariantPart.scopeRef` is reserved for schema-v2 cross-scope variants. It is
serialized by JSON/JS v2 writers when present, but the default compatibility
validator rejects it unless `text.crossScopeVariants`-style validation is
explicitly enabled.

## Non-Goals For The Current Branch

- Removing `TextRun`.
- Making glyph ids portable without exact font resources.
- Treating a digest-only resolved system font as portable. A digest can verify a
  consumer-held font blob, but it is not itself a replayable font resource.
- Letting Canvas2D/SVG depend on glyph-id replay.
- Changing layout line breaking to shaped advances in the same step as export
  schema migration.
- Adding shaped measurement shadow diagnostics as a CI gate in the same
  milestone as `GlyphRun` replay parity. Measurement diagnostics may have
  local/reporting hooks, but layout-delta and line-break decisions are a
  separate layout migration.
- Treating system-name-only `GlyphRun` data as portable visual replay.
