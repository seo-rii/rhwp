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

P1 dependency-boundary closure is now complete. CanvasKit strict `SvgGlyph`
and SVG-style outline replay use the DOM-free `static-svg-path-layers.ts`
parser, and the contract test fails if CanvasKit source reintroduces the broad
`layer-canvas-utils` import or browser-canvas/SVG DOM APIs. The remaining work
therefore moves to P2 feature-family parity audits and P3 strict payload gates.

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
| `ColorLayers.ColrV1` | tree-only solid color plus transform graph and native/internal deterministic reference fixture |
| `BitmapGlyph` | one producer-selected image strike, deterministic alpha/scaling/filtering, no strict `backendDefault` |
| `SvgGlyph` | `VectorResourceId` to sanitized static vector content, required `viewBox`, hard-false script/animation/external/interactivity flags |
| CanvasKit variation fonts | exact construction proof fixture with fixed axis tuple and negative axis cases |
| CanvasKit TTC/OTC faces | exact face-index proof fixture with wrong-face negative case |
| shapedModern | report-only corpus first, then opt-in width input, then opt-in line breaking |
| cross-scope variants | concrete use case plus backend scope semantics |
| `MixedPerGlyph` | cluster/grapheme orientation semantics and transform-run fixtures |

These are v2 feature additions, not v3 triggers, unless they force a change to
variant selection, paint-order semantics, fallback-free export semantics, layout
authority, or source/cluster identity.

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

Larger native-vs-CanvasKit PNG matrices remain report-first until thresholds and
flake rates are understood.
