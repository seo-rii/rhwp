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

CanvasKit is treated as a Skia-capable backend, but its browser adapter keeps
explicit gates for exact font instantiation before selecting a `GlyphRun`:

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

## CanvasKit Direct Replay Policy

CanvasKit is now treated as an independent Skia replay backend rather than a
Canvas2D-assisted preview path. CanvasKit and future native Skia should consume
the same `PageLayerTree` semantics, so the renderer must not use hidden browser
Canvas2D overlays to hide unsupported paint operations.

CanvasKit still has two operational modes, but both are direct-replay modes:

- `compat`: user-visible stability mode. It may keep conservative CanvasKit
  slop such as body-text clip padding, but it must not route paint operations
  through a browser Canvas2D overlay. Unsupported operations should use explicit
  IR fallback variants, deterministic diagnostics, or direct CanvasKit replay.
- `default`: native-preparation mode. It uses the same direct replay policy and
  should fail closed or report unsupported capability gaps instead of silently
  approximating them.

The direct replay surface currently covers root `TextRun`, page backgrounds,
raster images, equations, form controls, vector shapes, text decorations,
control marks, tab leaders, editor margin guides, and supported
`GlyphRun`/`GlyphOutline` variants.
All CanvasKit resource paths should use CanvasKit image/font/vector primitives
directly; DOM image caches and Canvas2D fallback passes are not part of the
CanvasKit backend contract.

Every CanvasKit feature expansion still requires a Canvas2D-vs-CanvasKit or
native-vs-CanvasKit fixture. Rasterizer output can use fuzzy PNG comparison, but
semantic decisions must be exact: selected variant id, fallback reason, resource
resolution, effect preprocessing diagnostics, and cache behavior should be
asserted without tolerance. When a direct CanvasKit path intentionally differs
from Canvas2D because it is closer to native Skia semantics, the fixture must
label that as a Skia strict replay improvement rather than a Canvas2D
compatibility match.
The current browser matrix includes direct Canvas2D-vs-CanvasKit parity probes
for clip scopes, core vector paint ops, transformed vector geometry and line
styles, gradient and pattern shape fills, page-background gradients/images,
form-object geometry, image placement and tile fill modes, transformed images,
crop-aware image effects, equation layout geometry, char overlap, text
control/footnote markers, TextRun inline style effects and projection
transforms, SVG-style arc paths, tab leader and decoration line visual ops, and
the strict GlyphOutline COLRv0 transformed-layer, COLRv1 stage-1 through
stage-5 graph subsets, BitmapGlyph, and static-sanitized SvgGlyph payloads.

This policy keeps Canvas2D as the compatibility reference while preventing new
CanvasKit work from adding browser-canvas dependencies that would block a
future native Skia renderer. Native Skia parity should therefore be considered
when choosing the canonical CanvasKit direct path, even if the first fixture is
browser-only.

## CanvasKit Implementation Plan

CanvasKit feature work should now proceed as native-ready direct replay rather
than as a preview shim. The implementation goal is not merely to make the web
canvas view look close to Canvas2D; it is to converge the browser CanvasKit
adapter and future native Skia renderer on the same replay contract. Canvas2D is
therefore the compatibility reference, while native Skia constraints are the
design guardrail.

The concrete CanvasKit implementation plan lives in
`docs/canvaskit-parity-implementation.md`. This section keeps the schema and
text-IR constraints; the dedicated implementation document is authoritative for
the current renderer work order, dependency-boundary cleanup, and verification
sequence.

Every remaining CanvasKit feature should follow the same sequence:

1. identify the Canvas2D behavior and the `PageLayerTree` data it consumes;
2. add or extend a renderer-contract test so Canvas2D and CanvasKit cannot drift
   in dispatch cases, payload branches, resource requirements, or fallback
   reasons;
3. implement direct CanvasKit replay with CanvasKit paths, paints, images,
   fonts, surfaces, and resource caches instead of DOM or Canvas2D overlay
   passes;
4. add an E2E fixture that asserts exact semantic decisions and uses fuzzy
   pixel comparison only for rasterizer output;
5. keep unsupported cases explicit with deterministic diagnostics and fallback
   selection.

CanvasKit source files must stay free of browser-canvas dependencies such as
`CanvasRenderingContext2D`, `Path2D`, DOM image elements, `DOMParser`, object
URLs, browser text measurement, or imports from the Canvas2D renderer. If a
feature needs preprocessing that is currently easier in the browser, the
preprocessing must be promoted into an explicit resource pipeline with a
diagnostic record and a native Skia equivalent, not hidden inside the CanvasKit
backend.

The implementation lanes are:

| Lane | Scope | Entry gate | Exit gate |
| --- | --- | --- | --- |
| Direct replay parity | Canvas2D paint-op coverage in CanvasKit | Canvas2D behavior and payload branches identified | CanvasKit dispatch/branch contract test plus E2E visual or semantic fixture |
| Resource replay | images, patterns, vector resources, font blobs | resource identity and cache key defined | no DOM resource dependency, deterministic cache diagnostics, native-ready resource shape |
| `GlyphOutline` payloads | `colorLayers`, `bitmapGlyph`, `svgGlyph`, stroke | family feature gate and validator exist | strict replay fixture, unsupported payload fixture, selected/rejected reason exact |
| Font capability | CanvasKit `GlyphRun` exact font/face/instance support | portable blob and expected face/instance identity available | positive proof fixture plus negative fallback fixture |
| Layout migration | shaped measurement and shapedModern | report-only telemetry corpus exists | opt-in profile only; `hwpCompat` remains default until a v3 authority decision |
| Cross-scope/vertical | cross-scope variants and `MixedPerGlyph` | concrete use case and backend semantics identified | writer emission behind required feature, with compatibility fallback or strict rejection |

The direct-replay architecture has three layers:

1. a paint-op dispatcher that mirrors Canvas2D traversal order and clipping
   policy, but dispatches only to CanvasKit primitives;
2. backend-local builders for paths, paints, shaders, text blobs, images,
   surfaces, and pictures, each fed by `PageLayerTree` resources and schema
   payloads rather than DOM objects;
3. diagnostics and cache keys that record why a CanvasKit path is selected,
   rejected, or downgraded without mutating the replay contract.

This means CanvasKit may use Canvas2D as a behavior reference in tests, but it
must not call into the Canvas2D renderer at runtime. The expected implementation
shape for existing Canvas2D functionality is:

| Canvas2D behavior | CanvasKit implementation shape | Native-ready constraint |
| --- | --- | --- |
| Page, clip, and leaf traversal | `SkCanvas.save/restore`, rect clips, and the same leaf-local variant selection order | no DOM clip or overlay layer |
| Basic shapes and arbitrary paths | CanvasKit `Path` plus `Paint` fill/stroke configuration | all path conversion is explicit and reusable by native Skia |
| Gradients and pattern fills | CanvasKit shaders or offscreen CanvasKit picture/image resources with cache diagnostics | no CSS/Canvas2D pattern object dependency |
| Shadows and image effects | CanvasKit paints, image filters, offscreen surfaces, or explicit fallback diagnostics | no hidden browser pre-pass unless it has a native-equivalent resource pipeline |
| Images and bitmap glyphs | encoded resource bytes decoded into CanvasKit images and keyed by resource table/hash | no `HTMLImageElement`, object URL, or DOM decode dependency |
| Text fallback and special text ops | CanvasKit text/blob/path primitives with existing HWP-compatible positions | no CanvasKit text measurement authority in `hwpCompat` |
| `GlyphRun` and `GlyphOutline` variants | strict feature gates plus exact selected/rejected diagnostics | unsupported strict variants reject or fallback deterministically |
| SvgGlyph-style vector resources | sanitized static vector resources lowered to CanvasKit path/picture commands | no raw SVG-in-font or DOM/SVG overlay replay |

Surface choice is orthogonal to feature semantics. A CanvasKit render may use
WebGPU, WebGL, or software surfaces, but the selected surface must not change
which `PageLayerTree` feature is considered supported. If a surface backend
cannot execute a feature faithfully, the renderer records a backend-specific
diagnostic and follows the same compatibility fallback or strictVisual hard
reject policy as any other unsupported CanvasKit capability.

### CanvasKit Parity Roadmap

The CanvasKit parity goal is to make the existing Canvas2D renderer behavior
available through a Skia-shaped backend without adding overlay fallbacks. The
implementation should therefore move from broad parity guards to narrow direct
replay closures, not from Canvas2D delegation to partial CanvasKit patches.

The roadmap is:

1. keep a static renderer-contract test that compares Canvas2D and CanvasKit
   dispatch cases, glyph payload branches, and forbidden dependencies;
2. isolate shared preprocessing into native-ready helpers before CanvasKit uses
   it. Helpers may be shared with Canvas2D, but they must not require
   `CanvasRenderingContext2D`, DOM image elements, `DOMParser`, `Path2D`, object
   URLs, or browser text measurement;
3. close CanvasKit feature gaps by paint-op family, with one fixture per family:
   traversal/clip, vector paths and strokes, gradients and patterns, images,
   image effects, form/equation objects, text visual ops, `GlyphRun`, and
   `GlyphOutline` payloads;
4. record explicit backend diagnostics for every unsupported CanvasKit case
   before adding a fallback or strictVisual writer path;
5. keep native Skia in the design loop: if the CanvasKit implementation needs a
   browser-only pre-pass, first promote that pre-pass into a resource payload or
   pure preprocessing step that a native renderer can reproduce.

This gives CanvasKit three implementation priorities:

| Priority | Work | Done when |
| --- | --- | --- |
| P1 | Dependency boundary cleanup | CanvasKit source and direct helpers have no Canvas2D/DOM resource dependency, and the contract test guards that boundary |
| P2 | Canvas2D parity closures | Each Canvas2D paint-op branch has a CanvasKit direct replay branch or deterministic unsupported diagnostic |
| P3 | Native-ready strict replay | Strict payloads such as COLRv1, `BitmapGlyph`, `SvgGlyph`, variation fonts, TTC/OTC faces, and future native Skia fixtures use the same feature gates and diagnostics |

P1 dependency-boundary cleanup is complete. CanvasKit may still share pure
geometry, color, path, pixel, and text-cluster utilities with Canvas2D, but any
shared module used by CanvasKit must be native-ready by construction and must
remain guarded by the renderer contract test. New CanvasKit work should either
depend on `rhwp-studio/src/view/canvaskit/*` helpers or on small shared modules
whose public API has no browser canvas types.

P2 now proceeds in small coherent batches. A batch should include the
Canvas2D behavior audit, the CanvasKit direct replay change, exact diagnostics,
and a targeted lifecycle or parity fixture. The first skipped branch in a
family should be converted to an explicit unsupported reason before adding more
visual approximation. `compat` mode may select a schema fallback, but it must
not draw through an invisible Canvas2D overlay. `strictVisual` must fail closed
when a required CanvasKit capability is missing.

P3 starts only after the corresponding P2 branch is stable. COLRv1 now has
stage-1 through stage-5 guarded graph subsets; later graph primitives should be
added only when a concrete payload needs them and they remain inside the glyph
payload's local composition semantics. `BitmapGlyph` starts with a single
producer-selected image strike and deterministic alpha, scaling, and filtering.
`SvgGlyph` starts with a `VectorResourceId` pointing at sanitized static vector
content and hard-false script, animation, external resource, and interactivity
flags. CanvasKit variation and TTC/OTC replay remains fallback-only until a
browser-side exact face/instance construction proof passes. Native Skia already
has checked-in exact-font proof fixtures for direct TTF replay, selected
variable-font axis tuples, and synthetic TTC face indices; broader real-font
coverage is still corpus-gated.

The main implementation touchpoints are:

| Touchpoint | Role |
| --- | --- |
| Rust layer schema, `src/paint/text_v2.rs`, and `rhwp-studio/src/core/text-variants.ts` | payload validity, feature gates, downgrade/reject policy, and selected/rejected reason vocabulary |
| Studio JSON readers and `rhwp-studio/src/view/glyph-outline-payload-status.ts` | family-specific payload eligibility and user-facing diagnostics |
| `rhwp-studio/src/view/canvaskit-renderer.ts` and `rhwp-studio/src/view/canvaskit/*` helpers | direct CanvasKit replay, resource caches, and native-ready adapter boundaries |
| `rhwp-studio/src/view/canvas2d-layer-renderer.ts` | compatibility reference only; CanvasKit may compare behavior but must not import or delegate to it |
| `rhwp-studio/e2e/renderer-contract.test.mjs` | static parity and dependency guard for dispatch cases, payload branches, and forbidden backend dependencies |
| `rhwp-studio/e2e/renderer-lifecycle.test.mjs` | runtime lifecycle, resource, fallback, and fuzzy visual fixtures |

The next implementation order is intentionally narrow:

1. keep broad CanvasKit-vs-Canvas2D parity tests as the first guard for any
   newly touched paint-op family;
2. preserve the implemented COLRv1 stage-1 through stage-5 graph guardrails and
   add only targeted malformed-payload or concrete follow-up primitive fixtures;
3. strengthen `BitmapGlyph` and `SvgGlyph` validators and negative fixtures
   before widening writer emission;
4. keep CanvasKit variation and TTC/OTC strict replay fallback-only until
   exact construction proof fixtures pass, while native Skia variation/TTC
   support grows only through checked-in exact-font proof and corpus fixtures;
5. keep shapedModern, cross-scope variants, and `MixedPerGlyph` writer emission
   blocked until their corpus, scope, and vertical semantics gates are met.

Each commit should keep one lane coherent: either a renderer implementation with
its fixture, a validator/diagnostic tightening with negative fixtures, or a
contract-test guard. Mixing unrelated payload families in one patch makes it
harder to tell whether a later CanvasKit/native Skia regression is a schema
problem, a resource problem, or a rasterization problem.

The first implementation batch after this design update should therefore be
documentation-neutral and test-first:

1. add a contract or lifecycle fixture that describes the next missing
   COLRv1/BitmapGlyph/SvgGlyph or CanvasKit capability case;
2. tighten the validator or renderer branch until that fixture passes;
3. run the targeted E2E file and the Studio build;
4. push only that coherent unit before moving to the next payload family.

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
- Backends fall back whenever exact font, face-instance, glyph id, or
  paint-effect eligibility is not proven. CanvasKit still keeps the
  adapter-specific variation/TTC gates and its current glyph-id range guard;
  native Skia may select strict replay only for its checked-in exact-font proof
  cases and must fall back for unproven face/instance combinations.
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
- `glyphrun_canvaskit_simple_effects_exact_font`: the same exact single-face
  path selects finite offset-shadow and binary outline passes without a
  Canvas2D overlay. Producer eligibility, replay-plan eligibility, and runtime
  font verification must agree.
- `glyphrun_explicit_positions`: glyph ids and run-local positions are asserted
  exactly, with v1 `TextRun` placement still authoritative for layout.
- `glyphrun_variant_set_multipart`: a selected variant set can contain multiple
  parts, and all parts are painted together.
- `glyphrun_unsupported_effect_falls_back`: underline, strike, emphasis,
  emboss/engrave, shade, ratio, script, tab-leader, and non-finite shadow
  payloads keep `TextRun` fallback.
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
- Unsupported capability fallback: CanvasKit variation instances and non-zero
  `faceIndex` font faces keep `TextRun` fallback until the browser adapter
  proves exact variation/collection-face construction. Native Skia keeps the
  same fallback policy for unproven combinations, while its checked-in exact
  variation and synthetic TTC proof cases may select strict replay.
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

P0 must not use TTC/OTC collections or variable fonts for backend strict
replay. Even `faceIndex == 0` TTC/OTC data remains ineligible until the
backend proves explicit face selection. Variable font instances are also
ineligible until the backend proves exact variation construction.

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
- Native Skia tests: fill/shadow/outline `GlyphRun`, explicit positions, and
  unsupported effect fallback, plus small `PositionAdjusted` positive/negative
  coverage.
- Studio/CanvasKit E2E: eligible fill, finite offset-shadow, and binary outline
  glyph replay, one digest mismatch fallback, one unsupported-effect fallback,
  and small negative capability probes for unsupported variations, font
  collection face index, and over-tolerance `PositionAdjusted`. P1.5 adds one
  in-tolerance `PositionAdjusted` replay probe.

Native Skia vs CanvasKit PNG fuzzy parity and larger matrices should start in a
renderer sweep or nightly-style job, then move into the fast path only after
flakiness and runtime are understood.
The full renderer baseline now writes a report-only
`native-canvaskit-parity-report.json`, embeds browser Canvas2D-vs-CanvasKit
compat/default fuzzy metrics in `browser-baseline-report.json`, and mirrors both
summaries into `baseline-report.md`; these artifacts are observational data for
threshold tuning, not pass/fail gates for the fast path. They record
per-profile/per-sample summaries, per-comparison threshold overrides, and the
highest-delta comparisons so larger nightly matrices can be triaged without
promoting them to PR gates. Text-heavy samples can disable the tolerant pixel
budget with `maxDiffRatio: null` and use ink-mask / solid-ink budgets so report
rows distinguish geometry drift from backend glyph rasterization differences.

CanvasKit color glyph coverage follows the same report-first rule. The checked
in `tests/fixtures/fonts/RHWPColorSmokeCOLRv0.ttf` fixture is a tiny synthetic
single-face COLRv0 font with fixed digest and metadata. The Studio lifecycle
probe renders it only through the `GlyphRun` path and records selected/rejected
variant diagnostics plus pre-render verification, post-render digest/exact-face
and effect gates, selected part replay counts, replay eligibility, and
red/blue/fallback pixel counts as a report-only smoke. Setting
`RHWP_CANVASKIT_COLOR_GLYPH_SMOKE=1` promotes that local probe to hard
assertions for those diagnostics. This does not make color glyphs
`GlyphOutline`-eligible; `ColorLayers`, bitmap glyphs, and SVG-in-font payloads
remain reserved richer-outline work.
The smoke may start CanvasKit-only, but strictVisual color glyph eligibility
requires a stable native reference or equivalent baseline, deterministic
diagnostics, and a stable fuzzy threshold. Successful smoke output is therefore
backend capability evidence, not an automatic strictVisual gate.

GlyphOutline `ColorLayers.ColrV0` is the first richer-outline payload family
that Phase 2 may strict-export without opening the broader color payload
families. It remains a v2 feature addition, not a v3 trigger: strict export may
only carry resolved COLRv0 solid palette layers with resolved path commands,
resolved fill color, fill rule, layer index, source glyph provenance, and
palette provenance. The top-level payload also carries source font provenance,
a valid source span, a non-empty glyph span, and no `paintGraph`; COLRv0 strict
payloads are resolved layer stacks, while COLRv1 uses the graph envelope.
Consumers replay those resolved layer records instead of reinterpreting
COLR/CPAL font tables. The native producer-side COLRv0 decoder can now turn a
portable font blob and base glyph id into those resolved layers; default exports
still keep emission behind explicit feature/profile gates. The v2 envelope,
JSON/JS payload fields, validator gate, cache-key coverage, SVG and Canvas2D
strict replay, and strict glyph-outline metadata recognize this resolved-layer
contract when `text.glyphOutline.colorLayers` and
`text.glyphOutline.colorLayers.colrV0` are declared.

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
10. Expand `GlyphRun` parity fixtures for exact-quality, portable
    fill/shadow/outline replay. This phase covers native Skia, CanvasKit,
    fallback gates, multi-part variant sets, glyph-id range guards, and fuzzy
    cross-backend PNG comparison. It does not change layout measurement.
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
  above. Otherwise it replays the `TextRun` fallback. CanvasKit `default` mode
  is the native-preparation path and `compat` mode uses the same direct-replay
  backend with conservative CanvasKit policy knobs, not Canvas2D overlays.
  The shadow/outline expansion applies to optional compatibility variants;
  fallback-free schema-v2 strict writer emission keeps its narrower fill-only
  gate until paint-effect requirements are explicit in that profile.
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
the root stream. The schema-v1 scope validator is stricter than the tolerant
reader path: sidecar anchors must resolve to a root `TextRun` fallback in the
same equivalence group, and root+sidecar duplicate emission is invalid for
writer-produced exports. Studio's tree diagnostics report the same
`missingSidecarAnchorOpId`, `missingSidecarAnchor`, `invalidSidecarAnchor`, and
`variantDuplicatePart` conditions so backend renderers can stay tolerant while
export validation remains strict. The default Rust writer still emits the
current root `glyphOutline` representation until a richer outline payload needs
the sidecar writer. Future writers that emit sidecar payloads should declare
`text.variantOps` as an additive feature. Schema-v2 compatibility export
absorbs sidecar variants into the canonical `Text` op rather than re-emitting a
top-level `variantOps` array.

The first richer payload discriminator is intentionally narrow:
`payloadKind: "monochromeFill"` remains the baseline replay-eligible outline
payload. `payloadKind: "monochromeFillStroke"` is schema vocabulary for the
first richer outline payload: it must carry an explicit `stroke` object, and the
v2 validator only accepts the initial supported subset behind the richer-outline
feature gate. That subset is finite positive stroke width, solid stroke color,
finite non-negative optional miter limit, Canvas-compatible
`join: "miter" | "round" | "bevel"`, `cap: "butt" | "round" | "square"`, and
`paintOrder: "fillThenStroke"`. Browser strict replay accepts this subset once
`strictGlyphOutlineReplay` is enabled; unsupported stroke styles are rejected
with `glyphOutlineStrokeStyleUnsupported`. Other backends may still reject the
stroke payload until their own bbox, fixture, and fuzzy parity gates land.

`payloadKind: "colorLayers"` is v2 vocabulary with a resolved COLRv0
strict-export gate; `payloadKind: "bitmapGlyph"` is now a family-specific
strict gate for one producer-selected image strike; and
`payloadKind: "svgGlyph"` is now a family-specific strict gate for a sanitized
static vector subresource in the SVG exporter. `colorLayers.colrV1` now has
the stage-1 normalized graph gate plus a stage-2 gradient leaf subset for
Canvas2D/CanvasKit and native Skia. Current validators keep each richer family behind its own gate
even when the generic richer-outline option is enabled. They report
`glyphOutlinePayloadKindFeatureMissing` until a family gets its own payload
schema, writer gate, strict replay fixture, and deterministic fallback path.
This keeps the v2 envelope from pretending that all richer outline families are
implemented just because `monochromeFillStroke`, the COLRv0 resolved-layer
contract, the BitmapGlyph image-strike contract, or the SvgGlyph static-vector
contract is available.
Rust paint types and Studio JSON types may expose reserved payload envelopes
such as `ColorLayersPayload`/`colorLayers`, `BitmapGlyphPayload`/`bitmapGlyph`,
or `SvgGlyphPayload`/`svgGlyph` so readers and diagnostics agree on the future
shape; strict replay eligibility still depends on each family-specific feature
gate and backend/exporter support.

The reserved families are intentionally separate payload families:

- `ColorLayers` should normalize COLR/COLRv1-style color glyphs into a layer or
  paint-graph payload with `colorFormat`, source font provenance, palette
  reference, glyph range, and source range. The normalized graph is the primary
  portable replay payload; native COLR table references are provenance,
  diagnostics, or cache keys only. A COLRv0 layer should carry resolved visual
  data (`layerIndex`, path `commands`, resolved `fill`, `fillRule`, and
  `transformToRun`) plus provenance (`glyphId`, `glyphRange`,
  `sourceRangeUtf8`, `paletteIndex`, and optional CPAL digest on `paletteRef`).
  The COLRv0 payload itself must also have source font provenance, a valid
  source span, a non-empty glyph span, at least one resolved layer, and no
  `paintGraph`.
  Consumers must replay the resolved color/path data rather than re-resolving
  the font palette for strict visual output. COLRv0 can start as a solid
  palette layer stack. COLRv1 uses a separate normalized paint graph envelope:
  the stage-1 skeleton admits solid path nodes and transform nodes with source
  range, glyph range, and source-font provenance. The first stage-2 subset
  admits `linearGradientPath` and `radialGradientPath` leaves with
  producer-resolved color stops, finite run-local coordinates, and the same
  source/glyph provenance requirements. Stage 3 admits full 360-degree
  `sweepGradientPath` leaves where the backend has a portable conic-gradient
  primitive, stage 4 admits `sourceOver` composite nodes that paint backdrop
  then source inside the glyph payload, and stage 5 admits run-local `clip`
  nodes plus reusable DAG child refs. Other blend modes and future graph
  primitives stay behind later feature additions. Graph validation requires the
  root to reach every node, rejects cycles, bounds the graph to 64 nodes and
  depth 64, and keeps graph-local clips inside the glyph payload rather than
  promoting them to page/layer clip scopes. The feature vocabulary is split as
  `text.glyphOutline.colorLayers`, `text.glyphOutline.colorLayers.colrV0`, and
  `text.glyphOutline.colorLayers.colrV1` so the solid-layer subset can stabilize
  before the full paint graph is writer-enabled.
- `BitmapGlyph` should reference an image subresource with placement,
  transform-to-run, producer-resolved strike/ppem, strike-selection policy,
  alpha mode, scaling/filtering policy, pixel format, and color-space metadata.
  It is not a path payload, and backends must not silently reselect a different
  bitmap strike for strict replay. Strict visual payloads should prefer
  deterministic scaling policies such as `noScale`, `scaleToEm`, or
  `explicitTransform`; `backendDefault` is only suitable for compatibility or
  diagnostic profiles because it delegates strict replay semantics to the
  renderer. The current browser strict replay gate applies `placement.runToPage`
  followed by optional `transformToRun`, then draws the producer-selected strike
  into the payload's local glyph box.
- `SvgGlyph` should reference a sanitized static vector subresource. The first
  browser strict replay subset is path-vector based: sanitized path-like
  geometry (`path`, `rect`, `circle`, `ellipse`, `polygon`, `polyline`, and `line`)
  with fill, fill opacity, fill rule, local transforms, and a narrow solid
  stroke subset are replayed as native Canvas2D/CanvasKit paths instead of as
  overlay images. The stroke subset is intentionally conservative:
  positive finite width, solid color, Canvas-compatible `miter`/`round`/`bevel`
  joins, `butt`/`round`/`square` caps, finite miter limit, optional numeric
  dash arrays with numeric dash offsets, no gradients/patterns, and no group
  compositing.
  Strict visual replay must keep external resources, script, animation, links,
  and interactivity disabled; raw SVG-in-font replay is not the strictVisual
  contract. The payload should record `viewBox` and optional `intrinsicSize`
  because mapping the vector resource into run-local glyph coordinates is part
  of strict visual replay, not a backend-local guess. As with BitmapGlyph, the
  current browser strict replay gate applies `placement.runToPage` followed by
  optional `transformToRun` before mapping the `viewBox` into the local glyph
  box.

The later writer gates are intentionally ordered so a feature addition does not
implicitly change schema authority:

- `ColorLayers.ColrV1` remains a v2 feature addition, not a v3 trigger, as long
  as it fits the existing payload-kind and feature-gate model. The stage-1
  subset has a native/internal deterministic reference fixture and SVG plus
  browser Canvas2D/CanvasKit replay coverage. Stage 1 is tree-only: a transform chain
  resolves to one `solidPath` reference layer, rejects unreachable nodes/cycles,
  rejects graphs over 64 nodes or depth 64, and carries the composed run-local
  affine transform without changing paint order or clip/effect/cache scope.
  Browser Canvas2D/CanvasKit, Rust SVG, and native Skia now also replay the
  first stage-2 subset: `linearGradientPath` and `radialGradientPath` leaves
  with ordered color stops. Browser Canvas2D/CanvasKit and native Skia replay
  the stage-3 full-360 sweep gradient subset, with Rust SVG retaining
  deterministic fallback/reject because SVG has no portable native conic-gradient
  primitive. Browser Canvas2D/CanvasKit, Rust SVG, and native Skia replay the
  first stage-4 subset: `sourceOver` composite nodes that render backdrop then
  source inside the glyph payload. Browser Canvas2D/CanvasKit, Rust SVG, and
  native Skia also replay the first stage-5 subset: run-local `clip` graph
  nodes and reusable DAG child refs with cycle detection and node/depth limits.
  Other blend modes and reusable-node memoization remain blocked.
  It becomes a v3 concern only if it forces a new text variant selection model,
  paint-order/compositing semantics, or source/cluster identity model.
- `BitmapGlyph` writer emission starts with one producer-selected image strike.
  Available strikes and missing ideal strikes are diagnostics/provenance only.
  Strict visual replay requires explicit `alphaMode`, deterministic
  `scalingPolicy`, deterministic `filtering`, and no backend strike
  reselection. Missing color space defaults to sRGB only when diagnostics or
  replay metadata record that default; an explicitly empty color-space value is
  malformed strict payload metadata. The current gated replay subset is covered
  by SVG, Canvas2D, CanvasKit, and native Skia fixtures.
- `SvgGlyph` writer emission starts with the SVG exporter over a sanitized
  static vector-resource subset. The producer is responsible for sanitizing to
  `securityMode: staticSanitized`; strict validators require
  `scriptAllowed=false`, `animationAllowed=false`,
  `externalResourcesAllowed=false`, and `interactivityAllowed=false`, and the
  exporter must resolve and serialize the referenced vector resource before
  selecting the variant. Browser Canvas2D, CanvasKit, and native Skia replay are
  later lowering milestones because they must turn the sanitized vector resource
  into backend-native path/scene commands without reintroducing raw SVG-in-font
  replay. The existing renderer fixtures still cover the safe SVG path subset
  used by Canvas2D and CanvasKit diagnostics: filled path geometry, safe
  nonvisual metadata, local transforms, CSS color parsing, and the conservative
  stroke subset; unsupported stroke styles such as invalid dash arrays or
  non-numeric dash offsets remain deterministic fallback cases.
- Variation, TTC, and OTC strict replay are backend capability additions. A
  backend must keep reporting `variationUnsupported` or `faceIndexUnsupported`
  and select the fallback variant until exact construction is proven for that
  backend and fixture class.
  CanvasKit still treats every explicit variation tuple as unsupported,
  including unsupported axis tags, out-of-range axis values, explicit
  default-axis tuples, and alternate axis tuples; omission of the variation
  tuple is the only CanvasKit strict path until browser-side exact
  construction is proven.
  Native Skia has checked-in exact-font proof coverage for selected variable
  axis tuples, explicit default-axis replay, alternate valid axis-bound replay,
  direct TTF replay, synthetic TTC non-zero `faceIndex` replay, exact-byte
  out-of-range fallback, invalid exact embedded font bytes, and digest-mismatch
  rejection. Native wrong-face, high-index, ambiguous metadata, and real
  collection corpus cases remain fallback/proof-gated until exact
  collection-face construction is demonstrated.

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
- `payloadKind: "colorLayers"` is accepted only for the resolved
  `ColorLayers.ColrV0` contract or the currently implemented
  `ColorLayers.ColrV1` normalized graph subset behind their family-specific
  gates;
- `payloadKind: "bitmapGlyph"` is accepted only behind
  `text.glyphOutline.bitmapGlyph` when it carries the strict deterministic
  image-strike contract and the target backend can resolve the referenced image
  resource;
- `payloadKind: "svgGlyph"` is accepted only behind
  `text.glyphOutline.svgGlyph` when it carries the static sanitized vector
  contract and the target backend can resolve and parse the referenced vector
  path resource;
- each outline path carries `glyphId`, `glyphRange`, and a UTF-8 source range
  so SVG/Canvas2D strict replay can keep path-level provenance for debugging,
  search sidecars, and accessibility sidecars;
- `glyphOutline` rejects text effects and non-outline glyph formats until each
  has a strict profile. Strict replay currently accepts the
  `monochromeFill` profile, the initial `monochromeFillStroke` stroke subset,
  the gated resolved `ColorLayers.ColrV0` layer subset, the gated
  `ColorLayers.ColrV1` stage-1 through stage-5 graph subsets, and the gated
  BitmapGlyph image-strike subset plus static-sanitized SvgGlyph vector path
  subset for CanvasKit and SVG/Canvas2D.
  Shadow, emboss/engrave, underline/strike/emphasis, tab leaders, ratio/shade
  adjustments, unsupported color glyph graphs, unresolved bitmap glyphs, and raw
  SVG-in-font glyphs are not outline-eligible in the first profiles;
- `glyphOutline` must never be exported as an already-known generic `Path`
  while a `TextRun` fallback exists.

Flattened schema v1 variant ops do not carry `paintOrderSlotId`. The v2
envelope introduces a text-owned paint-order slot, but v1 compatibility exports
continue to rely on `anchorOpId` plus the same-leaf invariant; cross-leaf, clip,
transform, or cache-boundary variants remain feature-gated v2 work.

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
  `glyphOutlinePayloadContractInvalid`,
  `positionAdjustedResidualTooLarge`, or `backendDoesNotSupportVariant`;
- per-part replay status for multi-part variant sets;
- optional font verification and outline eligibility details when a backend
  evaluated `GlyphRun` or `GlyphOutline` candidates.

Backends that evaluate `GlyphRun` also report the eligibility gates that matter
for portable glyph replay: digest match, exact face instantiation, face-index
support, variation support, and effect support. These are render diagnostics,
not schema fields, because `ExternalVerified` fonts and backend capabilities
are resolved at render time. Unsupported runs must select the `TextRun`
fallback instead of painting an approximate glyph stream.

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
The v2 vocabulary reserves `measurementAuthority: "shapedClusterAdvances"` plus
`shapedMeasurement: "widthInput"` and `"lineBreakingInput"` for that opt-in
rollout; current compatibility writers still emit
`measurementAuthority: "legacyHwpPositions"` and
`shapedMeasurement: "diagnosticsOnly"`.
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
paragraph/container context. Line-break shadow telemetry may record available
width, paragraph/container width, table-cell constraints, tab-stop summaries,
justification mode, and whether legacy line segmentation was available. If the
full layout context is missing, the serialized `risk` is forced to
`insufficientContext` rather than pretending the report can answer a
`lineBreakWouldChange` boolean. Context fields distinguish `known`,
`knownAbsent`, and `unknown`: a confirmed absence of table constraints, tab
stops, or justification can still satisfy the report, while unknown required
context cannot. `TextShapeReport` can serialize these observations as a
standalone shaped-measurement JSON artifact; that artifact is telemetry for
local/nightly migration analysis and is not part of the layer replay schema.

The shapedModern rollout is therefore staged, even inside schema v2:

1. report-only shaped measurement and `lineBreakRisk`;
2. width-measurement shadow reports;
3. opt-in shaped width input;
4. opt-in shaped line breaking;
5. a separate default-authority decision.

The opt-in width-input stage needs representative HWP corpus reports, an
understood width-delta distribution, stable fallback-font splits, stable
cluster mapping, stable vertical-metric diagnostics, and reviewed table/cell
constrained documents while keeping `hwpCompat` as the default. Switching the
default measurement authority from `legacyHwpPositions` to
`shapedClusterAdvances` is a v3-level authority change.

Cross-scope variants and public `MixedPerGlyph` also remain vocabulary-only in
the default writer. `text.crossScopeVariants` is one coarse feature gate for now
while diagnostics can name the boundary type (`crossLeaf`, `crossClip`,
`crossTransform`, `crossEffect`, or `crossCacheBoundary`). `paintOrderSlotId`
plus `scopeRef` is enough until a real use case requires a variant scope table.
For `MixedPerGlyph`, source orientation semantics are cluster/grapheme-based;
glyph transforms are a materialized replay detail that can later use
`sourceRangeUtf8`, `glyphRange`, and an affine `transformToRun`. Compatibility
writers keep homogeneous run splitting; fallback-free strict writers must reject
unsupported mixed-per-glyph replay rather than silently skipping it. CanvasKit
and native Skia currently keep public `MixedPerGlyph` and explicit
glyph-transform runs writer-gated, rejecting the strict `GlyphRun` as
`variantUnsupported` and selecting the `TextRun` fallback when available.

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

Schema v2 should close once the envelope and gates are stable, not when every
reserved writer is enabled. The v2 closure bar is:

- canonical `PaintOp::Text { variants }` text slots with unique
  `paintOrderSlotId` values;
- explicit `textV2.profile` and `fallbackPolicy` gates for compatibility versus
  strictVisual exports;
- fallback-free strict text only when `textV2.profile="strictVisual"`,
  `textV2.strictVisualFallbackFree=true`, `text.strictVisualFallbackFree`, and
  the required variant features are declared; fallback-free text slots that
  contain only `TextRun` variants are invalid and report
  `strictVisualVariantMissing`;
- `GlyphRun` and `glyphOutline` strict writers available as opt-in paths, with
  backend diagnostics explaining any rejected variant;
- `GlyphOutline.payloadKind` vocabulary covering `monochromeFill`,
  `monochromeFillStroke`, `colorLayers`, `bitmapGlyph`, and `svgGlyph`, while
  reserved richer payloads remain feature-gated until implemented;
- exact font blob/face/instance keys represented in schema, with backend replay
  eligibility still evaluated by the renderer;
- shapedModern layout metadata present, but layout mutation still opt-in and
  outside compatibility replay. Detailed shaped measurement and line-break risk
  reports remain telemetry artifacts outside the replay schema, and a default
  authority switch from `hwpCompat` to `shapedModern` is a v3-level decision;
- `text.crossScopeVariants` and `text.vertical.mixedPerGlyph` vocabulary
  present, with default writers still same-scope and homogeneous-run based.
- explicit v1/v2 compatibility policy: v1-to-v2 lowering may wrap flattened
  text variants into `PaintOp::Text`, while v2-to-v1 downgrade is allowed only
  when a faithful `TextRun` fallback and same-scope v1 payloads are present;
  fallback-free strict exports or unsupported richer payloads must fail closed
  instead of silently degrading.

Schema v3 should be reserved for a change in authority or core semantics:
changing the fallback-free export model, redefining paint order or cross-scope
composition, replacing the text variant selection model, making shapedModern
the default layout authority, changing source/cluster identity, or discovering
that COLR/bitmap/SVG glyph payloads cannot fit the v2 payload-kind/feature-gate
model. Adding a gated stroke subset, a CanvasKit color-glyph smoke, line-break
risk telemetry, mixed-per-glyph opt-in emission, or shapedModern opt-in width
input is not by itself a v3 trigger.

Schema-v2 closeout should be tracked as a status checklist, not as a promise
that every reserved writer is enabled:

| Area | Closeout status |
| --- | --- |
| `PaintOp::Text { variants }` reader/compat writer | Required before v2 closeout |
| unique `paintOrderSlotId` validation | Required before v2 closeout |
| compatibility profile with `TextRun` fallback | Required before v2 closeout |
| strictVisual fallback-free GlyphRun/GlyphOutline opt-in writers | Required before v2 closeout |
| backend `VariantSelectionReport` selected/rejected vocabulary | Required before v2 closeout |
| `GlyphOutline` `monochromeFill` and gated `monochromeFillStroke` | Required before v2 closeout |
| `GlyphOutline` `colorLayers.colrV0` | V2 feature addition; strict export supports resolved-layer payloads, and native producer-side COLR/CPAL decoding can generate the resolved layers |
| `GlyphOutline` `bitmapGlyph` | V2 feature addition; SVG, Canvas2D, CanvasKit, and native Skia strict replay support one producer-selected image strike |
| `GlyphOutline` `colorLayers.colrV1` | V2 feature addition; SVG, Canvas2D, CanvasKit, and native Skia strict replay support the stage-1 solid-path + transform graph subset, stage-2 linear/radial gradient path leaves, stage-4 `sourceOver` composite subset, and stage-5 run-local clip/reusable DAG subset; Canvas2D/CanvasKit and native Skia additionally support stage-3 full-360 sweep gradient leaves |
| `GlyphOutline` `svgGlyph` | V2 feature addition; SVG, Canvas2D, CanvasKit, and native Skia strict replay support sanitized static path-vector resources |
| CanvasKit color glyph smoke | Report-only backend capability smoke |
| Native Skia variation/TTC strict replay | V2 backend feature addition; checked-in exact-font proof fixtures cover selected variation tuples, explicit default-axis replay, alternate valid axis-bound replay, direct TTF replay, synthetic TTC non-zero `faceIndex` replay, exact-byte out-of-range fallback, invalid exact embedded font bytes, and digest mismatch rejection. Broader real-font coverage remains corpus-gated. |
| CanvasKit variation/TTC strict replay | Blocked until CanvasKit-specific exact variation tuple or collection `faceIndex` construction fixtures pass while preserving the `u32` glyph-id range guard. |
| shaped measurement and `lineBreakRisk` telemetry | Report-only artifact outside replay schema |
| shapedModern layout authority | Metadata reserved; opt-in layout migration only |
| cross-scope variants and public `MixedPerGlyph` | Vocabulary and validator gate only |

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
  source/glyph provenance, and either monochrome fill-only style eligibility or
  the explicitly gated initial `monochromeFillStroke` subset;
- backend `VariantSelectionReport` remains the source of truth for why a
  backend selected or rejected `TextRun`, `GlyphRun`, or `glyphOutline`;
- native-vs-CanvasKit parity matrices stay report-only until thresholds and
  flakiness are understood;
- shaped measurement stays telemetry outside the replay schema and does not
  infer `lineBreakWouldChange`. When line-level context is incomplete,
  diagnostics may record `lineBreakRisk`/`lineBreakShadows` values such as
  `insufficientContext`, but those reports remain telemetry rather than layout
  authority. A line-break risk report records context as `known`,
  `knownAbsent`, or `unknown`; `knownAbsent` is different from missing data and
  can satisfy context for things like table constraints or tab stops. A report
  needs at least full-context intent, known legacy available width, known
  paragraph or container width, non-unknown table/tab/justification context, and
  known legacy line-segmentation availability before it may report anything
  other than `insufficientContext`.

Phase 2 now opens schema v2 early, but still chooses one explicit emission axis
at a time. The preferred order is:

- schema v2 root/profile metadata, `PaintOp::Text { variants }`, and
  `paintOrderSlotId` reader/validator;
- v1-to-v2 lowering and v2-to-v1 downgrade only when a `TextRun` fallback and
  same-scope variants make the downgrade faithful;
- v2 compatibility writer as an opt-in path with `TextRun` fallback required;
- strictVisual writer only when required features are complete and
  `fallbackPolicy=none` is explicitly requested;
- richer `GlyphOutline` payload design, starting with the already gated stroke,
  COLRv0 `ColorLayers`, and implemented COLRv1 stage-1 through stage-5 subsets;
- `BitmapGlyph` strict replay for one producer-selected image strike across
  SVG, Canvas2D, CanvasKit, and native Skia;
- `SvgGlyph` strict replay for sanitized static path-vector resources across
  SVG, Canvas2D, CanvasKit, and native Skia;
- small CanvasKit color-glyph smoke tests that do not change `GlyphOutline`;
- CanvasKit variation/TTC support remains fallback-only until exact browser
  construction proof fixtures pass, while native Skia variation/TTC support
  expands only through exact-font proof and real-corpus fixtures;
- cross-scope variants and public `MixedPerGlyph` remain writer-blocked until
  actual use cases and vertical/transform semantics are stable;
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
`PageLayerTree::to_json_v2_strict_glyph_outline()` is the first opt-in
strictVisual string writer. It emits only strict-eligible `glyphOutline`
variants, uses `textV2.profile="strictVisual"` and `fallbackPolicy="none"`,
sets `textV2.strictVisualFallbackFree=true`, requires
`text.strictVisualFallbackFree` and `text.glyphOutline.monochromeFill`, and
returns `strictVisualVariantMissing` instead of leaking an unvariant `TextRun`
fallback into a fallback-free export.
When a strict outline variant uses the supported `monochromeFillStroke` subset,
the writer keeps that payload and adds
`text.glyphOutline.monochromeFillStroke` to `requiredFeatures`.
`PageLayerTree::to_json_v2_strict_glyph_run()` is the matching opt-in
strictVisual string writer for backend profiles that want a fallback-free
`glyphRun` export. It emits only strict-eligible `GlyphRun` variants, uses
`textV2.profile="strictVisual"` and `fallbackPolicy="none"`, sets
`textV2.strictVisualFallbackFree=true`, requires `fontResources`,
`text.glyphRun`, and `text.strictVisualFallbackFree`, and fails closed with
`strictVisualVariantMissing` when a text slot has no strict-eligible glyph
variant.
`page_layer_tree_to_js_value_v2_compat()` mirrors that opt-in envelope for
direct WASM object exports, so Studio-side consumers can validate v2 text slots
without going through stringified JSON.
The public wasm/native API exposes this opt-in path as
`getPageLayerTreeV2Compat*` and `getPageLayerTreeValueV2Compat*`; existing v1
`getPageLayerTree*` calls remain unchanged.
The strictVisual GlyphOutline path is exposed separately as
`getPageLayerTreeV2StrictGlyphOutline*` for string JSON and
`getPageLayerTreeValueV2StrictGlyphOutline*` for JS object transport. Both paths
are opt-in, follow the same fail-closed selector gate, and the JS object mirror
preserves the resource-key transport optimization used by compatibility exports.
The strictVisual GlyphRun path is exposed separately as
`getPageLayerTreeV2StrictGlyphRun*` for string JSON and
`getPageLayerTreeValueV2StrictGlyphRun*` for JS object transport. It is also
opt-in and uses the same validation issue vocabulary as the outline strict path.
`text_v2_validation_issues_to_js_value()` exposes the same validator issue
vocabulary to JS callers when an opt-in v2 export is rejected.
`text_v2_validation_issues_to_json()` exposes that same issue shape for string
JSON APIs, so validation failures use the same machine-readable codes instead
of debug-formatted Rust structs.
The validator also fails closed when a `fallbackPolicy="none"` text slot has no
strict visual `GlyphRun` or `glyphOutline` variant, reporting
`strictVisualVariantMissing` instead of allowing an unvariant `TextRun`-only
fallback-free slot.
`strict_glyph_outline_text_v2_slots()` is the first strictVisual selection gate:
it derives fallback-free v2 text slots only from `glyphOutline` variants whose
payload is `monochromeFill`, the supported `monochromeFillStroke` subset, or a
resolved `ColorLayers.ColrV0` layer stack, whose paint style is fill-only, and
whose diagnostics are already strict-visual eligible. Slots without such a
variant return `strictVisualVariantMissing`, so strict writer APIs can fail
closed before emitting `fallbackPolicy="none"`.
`strict_glyph_run_text_v2_slots()` is the corresponding GlyphRun-only gate: it
derives fallback-free v2 text slots only from `GlyphRun` variants whose paint
style is still supported by the fill-only strict replay contract, whose
orientation is not public `MixedPerGlyph`, and whose diagnostics are already
strict-visual eligible. Backend-specific checks such as CanvasKit glyph-id range
and exact external font verification remain renderer-side selection gates.
`downgrade_text_v2_op_to_v1_compat()` is the first downgrade scaffold: it
flattens a validated v2 text slot back into v1 text variant ops only when the
slot still has the required `TextRun` fallback and current v1 payload kinds.
`GlyphOutline.payloadKind` currently implements `monochromeFill`, the
feature-gated `monochromeFillStroke` subset, the feature-gated
`ColorLayers.ColrV0` resolved-layer subset, and the implemented
`ColorLayers.ColrV1` stage-1 through stage-5 normalized graph subsets. The
field also implements the feature-gated `BitmapGlyph` image-strike subset and
static-sanitized `SvgGlyph` vector subset across the browser and native-ready
strict replay paths.
The field exists so later COLRv1 graph primitives or stricter resource-backed
glyph payloads can be feature-gated without overloading the first fill-only path
representation. Reserved payload kinds are defined as schema vocabulary but are
rejected by the compatibility validator until their strict profile and feature
gates land. The v2 validator reports
`glyphOutlinePayloadKindFeatureMissing` for `colorLayers` unless both
`text.glyphOutline.colorLayers` and
`text.glyphOutline.colorLayers.colrV0` are declared and the resolved-layer
contract is complete, or `text.glyphOutline.colorLayers.colrV1` is declared
and the currently implemented normalized graph subset is complete.
For `bitmapGlyph`, it accepts `text.glyphOutline.bitmapGlyph` only when the
producer-resolved strike fields, deterministic strict visual
`alphaMode`/`scalingPolicy`/`filtering`, required placement, and source/glyph
ranges are complete. For `svgGlyph`, it accepts
`text.glyphOutline.svgGlyph` only when the static sanitized vector contract,
viewBox, placement, source/glyph ranges, and parseable path subset are complete.
For malformed bitmap or SVG glyph payloads, the validator reports
`glyphOutlinePayloadContractInvalid` when the
payload lacks the producer-resolved bitmap strike fields, deterministic strict
visual scaling/filtering, required placement and ranges, or static-sanitized
SVG contract flags. For `monochromeFillStroke`, the
validator reports
`glyphOutlinePayloadKindFeatureMissing` until the stroke feature gate is
enabled, and it also reports `glyphOutlineStrokeStyleUnsupported` unless the
payload carries the supported initial stroke subset.
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
