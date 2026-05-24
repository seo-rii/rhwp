# CanvasKit Parity Implementation Design

This document is the implementation guide for making the CanvasKit renderer
match the existing Canvas2D renderer without using hidden Canvas2D overlays.
The target backend is browser CanvasKit first, but every design choice must
also be reproducible by a future native Skia renderer.

## Goal

CanvasKit should support the same user-visible `PageLayerTree` behavior that
the Canvas2D renderer already supports in the web canvas view. Canvas2D remains
the compatibility reference for behavior, ordering, and HWP-compatible layout,
but it is not a runtime fallback backend for CanvasKit.

CanvasKit work therefore follows three rules:

1. Direct replay is preferred over approximation.
2. Unsupported capabilities are explicit diagnostics plus schema fallback, or
   strictVisual hard rejection when no fallback is allowed.
3. Browser-only preprocessing must become a native-ready payload, resource, or
   pure helper before CanvasKit depends on it.

## Non-Goals

- Do not change HWP-compatible text measurement, line breaking, pagination, or
  shapedModern layout authority while closing CanvasKit parity gaps.
- Do not use a hidden Canvas2D pass to draw unsupported CanvasKit operations.
- Do not make WebGPU, WebGL, or software surface choice change feature
  eligibility. Surface selection is an execution detail.
- Do not open cross-scope variants, public `MixedPerGlyph`, or shapedModern
  writer emission before their gates are met.

## Current Baseline

The CanvasKit renderer already has direct replay paths for the core layer
traversal, clipping, page backgrounds, raster images, equations, form controls,
vector paths, text decorations, control marks, tab leaders, root `TextRun`, and
supported `GlyphRun` / `GlyphOutline` variants.

The recent dependency-boundary work moved shared CanvasKit dependencies out of
the broad Canvas2D utility module:

| Shared concern | Native-ready module | CanvasKit use |
| --- | --- | --- |
| image effect pixels, crop preprocessing, base64 decode | `rhwp-studio/src/view/image-effect-pixels.ts` | resource cache, font blob registration, cropped effect replay |
| HWP text replay helpers and PUA projection helpers | `rhwp-studio/src/view/text-replay-utils.ts` | root `TextRun`, special text ops, control marks, overlap text |
| geometry helpers and conservative bounds | `rhwp-studio/src/view/layer-geometry-utils.ts` | paths, arrows, transformed bounds |
| static SVG path parsing | `rhwp-studio/src/view/static-svg-path-layers.ts` | strict `SvgGlyph` and SVG-style outline replay |
| static SVG glyph fragment validation | `src/renderer/static_svg.rs` | CanvasKit replay-plan eligibility plus strict SVG/native Skia fallback |

P1 dependency-boundary closure is now complete. CanvasKit strict `SvgGlyph`
and SVG-style outline replay use the DOM-free `static-svg-path-layers.ts`
parser. The Rust `static_svg.rs` validator mirrors the same static path-layer
contract for replay-plan eligibility, the SVG exporter, and native Skia, so
unsafe `SvgGlyph` resources fall back instead of being embedded or rasterized
as raw strict output.
The contract test fails if CanvasKit source reintroduces the broad
`layer-canvas-utils` import or browser-canvas/SVG DOM APIs. The remaining work
therefore moves to P2 feature-family parity audits and P3 strict payload gates.

Schema-v1 `variantOps` sidecar payloads are now part of the native-ready replay
baseline. Studio Canvas2D/CanvasKit, Rust SVG, native Skia, and the Rust
CanvasKit replay plan all merge sidecars into the same leaf-local text variant
selection set as their anchored `TextRun` fallback. Native Skia static subtree
cache keys include those sidecar payloads as well, so cached pictures cannot be
reused across different strict text alternatives.

The first strict `GlyphOutline` payload subsets are also implemented as
feature-gated direct replay contracts. The current baseline covers
`MonochromeFill`, `MonochromeFillStroke`, `ColorLayers.ColrV0`,
`ColorLayers.ColrV1` stage 1 (`solidPath` plus local `transform`),
`BitmapGlyph` with a single producer-selected image strike, and `SvgGlyph`
with a sanitized static vector resource. Studio Canvas2D/CanvasKit, Rust SVG,
and native Skia now replay the first COLRv1 stage-2 subset:
`linearGradientPath` and `radialGradientPath` leaf nodes with resolved color
stops. Studio Canvas2D/CanvasKit, Rust JSON/JS bridges, Rust SVG eligibility
and output, native Skia, and the Rust CanvasKit replay plan share the same
payload eligibility vocabulary and deterministic fallback/reject reasons for
those subsets.

## Architecture

CanvasKit parity is implemented through four layers:

1. Paint-op dispatch mirrors Canvas2D traversal and branch coverage. Dispatch
   tables should be guarded by `renderer-contract.test.mjs` so newly added
   Canvas2D cases cannot silently skip CanvasKit.
2. Native-ready preprocessing modules convert schema payloads into simple data:
   geometry, colors, pixels, text clusters, path fragments, and resource keys.
   These modules must not require browser canvas or DOM objects.
3. CanvasKit adapter code builds `Path`, `Paint`, `Shader`, `Image`, `Surface`,
   font, and text objects from those payloads. It may use CanvasKit caches, but
   cache keys must be based on resource identity and replay-relevant options.
4. Diagnostics explain every selection, rejection, fallback, and cache decision
   that affects faithful replay.

The implementation should keep Canvas2D as a test oracle, not a code
dependency. If CanvasKit behavior intentionally differs because Skia semantics
are stricter or more native-ready, the fixture should label that difference
instead of hiding it behind a Canvas2D overlay.

## Work Phases

### P1. Dependency Boundary Closure

P1 removes CanvasKit dependencies on broad Canvas2D/browser helpers.

Status: complete. Keep the exit criteria below as regression requirements.

Exit criteria:

- `canvaskit-renderer.ts` and `rhwp-studio/src/view/canvaskit/*` do not import
  `canvas2d-layer-renderer` or broad Canvas2D utility modules.
- CanvasKit-visible helper modules are free of `CanvasRenderingContext2D`,
  `Path2D`, `DOMParser`, DOM image elements, object URLs, browser text
  measurement, and SVG DOM nodes.
- `renderer-contract.test.mjs` scans CanvasKit source plus direct helper modules
  for forbidden APIs.
- Static SVG parsing used by CanvasKit is handled by a DOM-free parser with
  deterministic unsupported results.

Completed P1 implementation:

1. Add `static-svg-path-layers.ts` as the CanvasKit-safe parser surface.
2. Wire CanvasKit replay and glyph-outline payload eligibility to that parser.
3. Update the contract test so CanvasKit may not import `layer-canvas-utils`.
4. Keep the existing Canvas2D parser path only for Canvas2D if it is still
   useful there.

### P2. Canvas2D Parity Closures

P2 closes feature gaps by paint-op family. Each work unit should contain the
Canvas2D behavior audit, a static contract guard, direct CanvasKit replay or an
explicit unsupported diagnostic, and a targeted lifecycle/parity fixture.

| Family | CanvasKit target | Required guard |
| --- | --- | --- |
| traversal and clips | save/restore and clip semantics match Canvas2D ordering | dispatch case parity and clip lifecycle fixture |
| paths, strokes, arrows, line styles | CanvasKit `Path` / `Paint` replay covers Canvas2D path commands and line style branches | command and style case parity plus visual fixture |
| gradients and patterns | CanvasKit shaders or offscreen CanvasKit picture/image resources | no CSS or Canvas2D pattern object dependency |
| images and image fills | encoded resource bytes decoded into CanvasKit images | deterministic resource key and cache diagnostics |
| image effects and shadows | CanvasKit image filters, paints, or native-ready pixel preprocessing | no hidden browser pre-pass without a resource contract |
| form and equation objects | direct CanvasKit geometry and text/path drawing | branch parity and fixture for geometry bounds |
| text visual ops | CanvasKit text/path primitives using HWP-compatible positions | no CanvasKit text measurement authority in `hwpCompat` |
| `GlyphRun` variants | exact font/face/instance replay only | selected/rejected diagnostics exact |
| `GlyphOutline` payloads | feature-gated strict replay | payload family validator and unsupported fixture |

P2 does not require every unsupported branch to be fully replayed immediately.
It does require every branch to be visible in diagnostics, with a deterministic
fallback or rejection path.

### P3. Native-Ready Strict Payloads

P3 starts only after the relevant P2 family is stable enough that strict payload
fixtures can isolate schema behavior from renderer gaps.

| Payload or feature | First implementation gate |
| --- | --- |
| `ColorLayers.ColrV1` | tree-only solid color plus transform graph baseline; linear/radial gradient leaves replay in browser Canvas2D/CanvasKit and native Skia after that baseline |
| `BitmapGlyph` | one producer-selected image strike, deterministic alpha/scaling/filtering, no strict `backendDefault` |
| `SvgGlyph` | `VectorResourceId` to sanitized static vector content, required `viewBox`, hard-false script/animation/external/interactivity flags |
| CanvasKit/native Skia variation fonts | exact construction proof fixture with fixed axis tuple and negative axis cases |
| CanvasKit/native Skia TTC/OTC faces | exact face-index proof fixture with wrong-face negative case |
| shapedModern | report-only corpus first, then opt-in width input, then opt-in line breaking |
| cross-scope variants | concrete use case plus backend scope semantics |
| `MixedPerGlyph` | cluster/grapheme orientation semantics and transform-run fixtures |

These are v2 feature additions, not v3 triggers, unless they force a change to
variant selection, paint-order semantics, fallback-free export semantics, layout
authority, or source/cluster identity.

## Hardening And Widening Blueprint

The remaining CanvasKit work should harden the implemented strict subsets first,
then widen one payload or backend capability at a time. The order is chosen to
keep one backend contract in flight while preserving the existing Canvas2D
compatibility export.

### 1. COLRv1 Graph Widening

Purpose: extend the current COLRv1 stage-1 graph without changing text variant
selection or paint-order semantics.

Implementation shape:

- keep `ColorLayers` canonical as producer-normalized paint data, not a
  font-native COLR table reference;
- keep COLR/CPAL table references, source glyph ids, palette indices, font
  digest, and face identity as provenance/debug/cache data;
- keep the tree-only stage-1 graph containing `solidPath` and local `transform`
  nodes as the cross-backend compatibility baseline;
- treat `linearGradientPath` and `radialGradientPath` as the first stage-2
  graph leaves; their gradients carry producer-resolved color stops and
  remain inside the glyph payload's run-local coordinate space;
- keep COLRv1 graph payloads exclusive from legacy `layers`; a payload that
  carries both the normalized graph and resolved layer list is invalid because
  it gives renderers two canonical paint descriptions;
- allow only run-local affine transforms inside the glyph payload;
- reject graph nodes that alter `PaintOp` order, clip scope, effect scope,
  cache scope, or cross-scope variant behavior;
- reject unreachable nodes, cycles, node counts over the stage limit, and depth
  over the stage limit.

The next implementation batches should add negative and parity fixtures around
the existing stage-1 graph, then widen to later COLRv1 graph nodes only after
their reference semantics are fixed.

Later COLRv1 additions should be staged as independent v2 feature additions:

| Stage | New graph capability | Writer status |
| --- | --- | --- |
| 1 | solid color plus transform | implemented baseline; continue fixture hardening |
| 2 | linear and radial gradients | browser Canvas2D/CanvasKit, Rust SVG, and native Skia implemented for resolved gradient path leaves; wider pixel parity fixture hardening remains follow-up work |
| 3 | sweep gradients | after gradient coordinate semantics are fixed |
| 4 | composite and blend | after reference compositing semantics are fixed |
| 5 | clip and reusable graph nodes | after DAG, cycle, depth, and reuse rules are fixed |

### 2. BitmapGlyph Strict Replay Hardening

Purpose: harden the strict image-strike contract before enabling broader writer
emission.

Implementation shape:

- canonical payload contains one producer-selected image strike;
- available strikes, missing ideal strikes, and chosen-strike reasons are
  diagnostics/provenance only;
- strict replay must not let the backend select a different strike;
- strict replay requires explicit `alphaMode`, `scalingPolicy`, `filtering`,
  placement, `sourceRangeUtf8`, and `glyphRange`;
- strict replay rejects `backendDefault` scaling or filtering;
- missing color space defaults to sRGB only when the diagnostic records
  `colorSpaceDefaulted`.

Canvas2D/CanvasKit, Rust SVG, and native Skia now share the single-strike strict
payload subset. Static picture cache keys already include image and
`ArrayBuffer` resource payload fingerprints; the same cache contract is now
covered for strict `SvgGlyph` vector resources so stale static pictures cannot
survive a same-key vector payload change. Before writer emission is widened,
add more negative fixtures for missing required strict fields, backend strike
reselection, backend-default filtering, malformed resource refs, and remaining
resource identity cache reuse cases.

### 3. SvgGlyph Static Vector Hardening

Purpose: harden the sanitized vector-resource contract without reintroducing raw
SVG-in-font replay or DOM/SVG overlay dependencies.

Implementation shape:

- canonical payload references a `VectorResourceId`, not inline raw SVG;
- the producer sanitizes the SVG glyph into static vector content;
- consumers and validators require `securityMode=staticSanitized`;
- strict replay requires `scriptAllowed=false`, `animationAllowed=false`,
  `externalResourcesAllowed=false`, and `interactivityAllowed=false`;
- `viewBox` is required because mapping into glyph/run coordinates is part of
  strict replay;
- `intrinsicSize` is optional and diagnostic/layout-aid only.

The current baseline replays static path-layer fragments without DOM parsing in
Canvas2D/CanvasKit, Rust SVG, and native Skia. CanvasKit lifecycle coverage now
mutates a same-key `VectorResourceId` payload inside a static subtree and
requires a distinct static picture cache entry and changed pixels. It also
rejects external/reference primitives such as `<image href>` and `<use href>`,
plus unsupported vector primitives such as `foreignObject`, `filter`, `mask`,
and `clipPath`, as `unsupportedSvgGlyph` in both DOMParser and no-DOMParser
paths. Before writer emission is widened, add more negative fixtures for unsafe
flags, missing `viewBox`, raw SVG replay attempts, and remaining resource
identity cache reuse cases.

### 4. CanvasKit And Native Skia Variation/TTC Proof Fixtures

Purpose: keep exact-font replay conservative until backend-specific face and
instance construction is proven.

Current policy stays unchanged:

- variation-required `GlyphRun` rejected by CanvasKit and native Skia reports
  `variationUnsupported`;
- TTC/OTC non-zero `faceIndex` rejected by CanvasKit and native Skia reports
  `faceIndexUnsupported`;
- neither backend may select the strict `GlyphRun` variant for these font
  instances until proof fixtures demonstrate exact construction. Backend
  divergence remains possible later, and must be explained by
  `VariantSelectionReport`.

The proof fixtures required before enabling backend strict replay are:

| Capability | Positive proof | Negative proof |
| --- | --- | --- |
| variation font | same variable font blob, canonical axis tuple, expected glyph ids, expected advances/bounds, stable native-vs-CanvasKit fuzzy output | unsupported axis, out-of-range axis, same font with different axis tuple, default-axis omission policy |
| TTC/OTC face index | same collection blob, explicit non-zero `faceIndex`, expected face metadata, expected glyph id mapping | wrong-face index and ambiguous metadata diagnostics |

CanvasKit glyph id replay must also keep the adapter range guard for public
`u32` glyph ids because the browser binding currently uses a 16-bit glyph id
path.

### 5. Layout, Scope, And Vertical Writer Gates

These features remain vocabulary/validator work until their authority gates are
met.

| Feature | Current implementation action | Writer gate |
| --- | --- | --- |
| shapedModern width input | keep `lineBreakRisk` report-only and keep `lineBreakWouldChange` absent | representative HWP corpus, understood width-delta distribution, stable fallback split, stable cluster mapping, stable vertical metrics, table/cell review, `hwpCompat` still default |
| shapedModern line breaking | document pass criteria only | opt-in width input stable, calibrated line-break risk threshold, expected pagination differences documented |
| cross-scope variants | keep `text.crossScopeVariants` vocabulary and boundary diagnostics | concrete use case requiring scopeRef across leaf/clip/transform/effect/cache boundary |
| `MixedPerGlyph` | keep cluster/grapheme orientation semantics and `GlyphTransformRun` vocabulary | stable per-cluster mapping, transform semantics, GlyphRun/GlyphOutline transform replay, vertical policy fixtures |

Compatibility writers must continue to fall back to same-scope `TextRun` or
homogeneous run splitting when those fallbacks are available. Fallback-free
strict writers must reject unsupported scope or mixed-orientation replay rather
than silently skipping it.

## Implementation-Ready Backlog

This backlog turns the design choices above into code-sized batches. Each batch
must leave CanvasKit and future native Skia on the same replay contract. If a
batch discovers that it needs browser-only parsing, hidden Canvas2D drawing, or
backend-dependent semantics, stop the writer work and add a validator,
diagnostic, or resource contract instead.

### Batch 1. COLRv1 Stage-1 Graph Hardening

Goal: harden the current COLRv1 stage-1 graph vocabulary and validation without
enabling a broad writer path.

Expected code shape:

- schema/type vocabulary keeps `ColorLayers.ColrV1` stage-1 nodes as the
  cross-backend baseline and admits stage-2 gradient path leaves;
- stage-1 nodes are tree-only `solidPath` and local affine `transform`;
- stage-2 nodes are tree-only `linearGradientPath` and
  `radialGradientPath` leaves with finite coordinates, ordered stop offsets, and
  resolved RGBA colors;
- each `solidPath` contains producer-resolved path commands, resolved RGBA,
  `fillRule`, layer/source glyph provenance, palette provenance, and source
  range metadata;
- graph validation rejects cycles, unreachable nodes, unknown nodes,
  malformed gradients, unsupported blends/clips, scope-changing transforms,
  excessive depth, and excessive node count;
- fixtures continue to use deterministic internal/native reference behavior
  before any SVG/Canvas2D exporter widening beyond stage 1.

Likely touchpoints:

- Rust schema and text payload definitions;
- Studio text variant and glyph-outline payload status helpers;
- renderer contract tests for new payload vocabulary and unsupported reasons;
- native/internal fixture code that can assert the normalized graph result.

Definition of done:

- COLRv1 stage-1 payloads continue to validate when they contain only solid
  color and local transform nodes, and stage-2 gradient path leaves validate
  only with finite coordinates and ordered resolved-color stops;
- unsupported COLRv1 nodes and malformed stage-2 gradients produce deterministic
  payload-contract diagnostics;
- no CanvasKit writer starts relying on font-native COLR table interpretation;
- no paint-order, clip, effect, cache, or cross-scope semantics change.

### Batch 2. BitmapGlyph Strict Validator

Goal: close the strict image-strike contract before enabling broader writer
emission.

Expected code shape:

- `BitmapGlyph` strict payload validation requires one producer-selected image
  strike;
- `BitmapGlyph` payloads are exclusive to the bitmap family: sibling
  `colorLayers`, `svgGlyph`, or stroke payload fields make the strict contract
  invalid;
- available strikes, chosen-strike reason, and missing ideal strike remain
  diagnostics/provenance only;
- strict replay requires `alphaMode`, `scalingPolicy`, `filtering`,
  placement, `sourceRangeUtf8`, and `glyphRange`;
- strict replay rejects backend strike reselection and `backendDefault`
  scaling/filtering;
- missing color space maps to explicit sRGB default plus a
  `colorSpaceDefaulted` diagnostic.

Likely touchpoints:

- glyph-outline payload status helpers;
- renderer diagnostics vocabulary;
- negative fixtures for missing required fields, backend-default filtering,
  malformed resource refs, and strike reselection attempts.

Definition of done:

- compatibility export can still fall back to `TextRun` or `GlyphRun`;
- strictVisual without a valid image-strike payload hard rejects;
- Canvas2D/SVG writer work remains blocked until the validator and negative
  fixtures are stable.

### Batch 3. SvgGlyph Static Vector Contract

Goal: make the sanitized vector resource contract explicit before widening
writer emission.

Expected code shape:

- canonical payload references `VectorResourceId` instead of inline raw SVG;
- `SvgGlyph` payloads are exclusive to the static vector family: sibling
  `colorLayers`, `bitmapGlyph`, or stroke payload fields make the strict
  contract invalid;
- producer is responsible for sanitizing into static vector content;
- validator requires `securityMode=staticSanitized`;
- strict replay requires `scriptAllowed=false`,
  `animationAllowed=false`, `externalResourcesAllowed=false`, and
  `interactivityAllowed=false`;
- `viewBox` is required and `intrinsicSize` remains optional;
- raw SVG-in-font direct replay remains unsupported.

Likely touchpoints:

- shared static vector resource validation;
- SVG exporter eligibility checks;
- CanvasKit/native Skia fallback diagnostics;
- negative fixtures for unsafe flags, missing `viewBox`, raw replay attempts,
  unsupported vector primitives, and external/reference primitives such as
  `<image href>`, `<use href>`, `foreignObject`, `filter`, `mask`, and
  `clipPath`.

Definition of done:

- strict SVG/native Skia/CanvasKit eligibility all agree on the same sanitized
  static-vector contract;
- unsafe vector resources choose compatibility fallback or strict rejection;
- no DOM parser, object URL, browser SVG element, or Canvas2D overlay is added.

### Batch 4. CanvasKit And Native Skia Variation/TTC Proof Fixtures

Goal: keep exact-font replay conservative while adding proof fixtures that can
eventually unlock backend support.

Expected code shape:

- CanvasKit and native Skia continue to reject required variation instances
  with `variationUnsupported`;
- CanvasKit and native Skia continue to reject unsupported TTC/OTC face indices
  with `faceIndexUnsupported`;
- either backend may diverge only after its own proof fixtures pass; until then
  both keep `TextRun` fallback and record the rejected `GlyphRun` reason in
  `VariantSelectionReport`;
- proof fixtures record the exact blob, face, axis tuple, glyph ids, advances,
  bounds, and negative mismatch cases.

Definition of done:

- no CanvasKit strict replay enablement happens without the positive and
  negative proof fixtures;
- public `u32` glyph ids keep the CanvasKit adapter range guard;
- backend divergence is deterministic and visible in diagnostics.

### Batch 5. Layout, Scope, And Vertical Gates

Goal: keep large-authority changes out of CanvasKit parity closure while their
vocabulary and diagnostics remain ready.

Expected code shape:

- `lineBreakRisk` stays report-only and `lineBreakWouldChange` remains absent;
- shapedModern width input waits for a representative HWP corpus, width-delta
  distribution, stable fallback font split, stable cluster mapping, vertical
  metric diagnostics, and table/cell review;
- `text.crossScopeVariants` remains a required feature for any `scopeRef` that
  differs from the text op scope;
- cross-scope diagnostics name the boundary type: `crossLeaf`, `crossClip`,
  `crossTransform`, `crossEffect`, or `crossCacheBoundary`;
- public `MixedPerGlyph` writer emission remains blocked until cluster-level
  orientation semantics, transform runs, and fallback/reject policy are stable.

Definition of done:

- compatibility writers use same-scope `TextRun` fallback or homogeneous run
  splitting when available;
- fallback-free strict writers reject unsupported layout, scope, or mixed
  orientation paths;
- no hwpCompat measurement, line breaking, pagination, or layout authority
  changes occur in CanvasKit parity batches.

## Commit Shape

Keep commits small and coherent:

- one boundary cleanup with its contract guard;
- one renderer family implementation with its lifecycle/parity fixture;
- one validator or diagnostics tightening with negative fixtures;
- one strict payload fixture set.

Do not mix unrelated payload families in one commit. That makes regressions hard
to assign to schema, resource, adapter, or rasterization behavior.

## Verification

Every CanvasKit parity commit should run:

```bash
node e2e/renderer-contract.test.mjs
npm run build
git diff --check
```

When runtime behavior changes, also run the relevant lifecycle/parity fixture,
usually:

```bash
node e2e/renderer-lifecycle.test.mjs
```

When a change touches strict payload semantics or native-ready Skia behavior,
also run the targeted native Skia replay suite:

```bash
cargo test --features native-skia native_skia
```

Larger native-vs-CanvasKit PNG matrices remain report-first until thresholds and
flake rates are understood.

The fast headless E2E suite keeps one-sample WebGPU-preferred and software
CanvasKit smoke runs for the `eq-01` fixture. The manual `Full Renderer Sweep`
workflow captures the representative multi-profile baseline, then captures
separate WebGPU-preferred and software CanvasKit baselines. Those wider
surface-axis outputs are artifacts for diagnosis and threshold tuning, not
default CI gates.
